/**
 * /app-installs store (MKT-048) — the append-oriented install ledger and
 * its append-only event tail over PostgreSQL, plus the pure input guards,
 * the §8-style create fingerprint and the policy-action shape builders.
 *
 * Storage discipline (migration 038 — every invariant DB-fenced):
 *   - the current-selection partial unique fence serializes concurrent
 *     writers of one (workspace, app key) lineage;
 *   - the §8 (workspace, idempotency_key) fences converge logical commands;
 *   - the identity+grants trigger re-verifies the EXACT (app key, version,
 *     app_version_id) identity against the immutable migration-037 registry
 *     and the granted scopes as a SUBSET of the pinned manifest's requested
 *     scopes (server-derived least privilege, even against direct SQL);
 *   - the history trigger permits ONLY the single sanctioned supersession
 *     transition (ACTIVE → SUPERSEDED with superseded_at set);
 *   - the event tail rejects UPDATE and DELETE outright.
 *
 * The store class performs every selection append as ONE transaction:
 * lock + supersede the current row, insert the successor, insert the event.
 */

import { createHash } from 'node:crypto';
import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import type { Db, DbRow } from '../../../platform/db/contract.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type { PolicyActionDescriptor } from '../../policies/public.ts';
import type {
  AppDataScope,
  AppMutationScope,
  AppVersionRecord,
} from '../../apps/public.ts';
import type {
  AppInstallEventRecord,
  AppInstallOperation,
  AppInstallProvenance,
  AppInstallRecord,
} from '../public.ts';

// ---------------------------------------------------------------------------
// Bounds (single source of truth for every guard below)
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;
const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]{1,32})?$/;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_PROVENANCE_LABEL_LENGTH = 100;

/**
 * Material-shaped keys that can never appear in ANY selection payload (§21
 * — the migration 025/028/030/037 set; there is deliberately NO column
 * anywhere in migration 038 capable of holding secret material).
 */
export const APP_INSTALLS_MATERIAL_SHAPED_KEYS = [
  'secret',
  'secretMaterial',
  'material',
  'password',
  'token',
  'apiKey',
  'api_key',
  'accessKey',
  'secretHandle',
  'credentialValue',
  'secretValue',
] as const;

/**
 * AUTHORITY-SHAPED keys (server-derived grant/lifecycle/provenance fields
 * and registry identity): rejected 422 — granted scopes, lifecycle,
 * provenance and the pinned registry identity are NEVER caller-suppliable
 * (AC-7). The module input types have no such fields structurally; this
 * guard is the semantic enforcement point behind the DTO for any
 * dynamically-shaped caller. (The workspace/install/target SELECTORS are
 * deliberately NOT in this list: they arrive as server-resolved path
 * identifiers — the route DTO rejects them from request BODIES, and the
 * /extensions scope-as-data precedent governs the module boundary.)
 */
const SELECTION_AUTHORITY_SHAPED_KEYS = [
  'grantedScopes',
  'grantedDataScopes',
  'grantedMutationScopes',
  'policyDecisionId',
  'policyDecision',
  'status',
  'selectionSeq',
  'supersededAt',
  'supersededByInstallId',
  'installedBy',
  'installedAt',
  'appVersionId',
  'createFingerprint',
  'provenance',
  'actor',
  'recordedActor',
  'recordedVia',
  'correlationId',
  'causationId',
  'recordedAt',
  'replayed',
  'prior',
] as const;

// ---------------------------------------------------------------------------
// Input guards (pure — the single semantic enforcement point behind the DTO)
// ---------------------------------------------------------------------------

/**
 * Validates one selection input (install/upgrade/rollback). Shape-bounded
 * (uuid workspace/install ids, app key pattern, semver version, bounded
 * idempotency key); rejects AUTHORITY-shaped keys (granted scopes,
 * identity, provenance, lifecycle — AC-7) and MATERIAL-shaped keys (§21).
 * Pure.
 */
export function assertValidSelectionInput(input: {
  readonly workspaceId?: unknown;
  readonly appKey?: unknown;
  readonly version?: unknown;
  readonly installId?: unknown;
  readonly targetInstallId?: unknown;
  readonly idempotencyKey?: unknown;
  readonly [key: string]: unknown;
}): void {
  for (const key of Object.keys(input)) {
    if (
      (APP_INSTALLS_MATERIAL_SHAPED_KEYS as readonly string[]).includes(key) ||
      SELECTION_AUTHORITY_SHAPED_KEYS.includes(key as (typeof SELECTION_AUTHORITY_SHAPED_KEYS)[number])
    ) {
      throw new InvalidRequestError(
        `selection input key '${key}' is authority- or material-shaped and never caller-suppliable (granted scopes, installer identity, provenance and lifecycle are server-derived)`,
      );
    }
  }
  const requireUuid = (field: string, value: unknown): void => {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new InvalidRequestError(`${field}: must be a canonical uuid`);
    }
  };
  if (input.workspaceId !== undefined) requireUuid('workspaceId', input.workspaceId);
  if (input.installId !== undefined) requireUuid('installId', input.installId);
  if (input.targetInstallId !== undefined) requireUuid('targetInstallId', input.targetInstallId);
  if (input.appKey !== undefined) {
    if (typeof input.appKey !== 'string' || !KEY_PATTERN.test(input.appKey)) {
      throw new InvalidRequestError(
        'appKey: must be 2-63 lowercase letters/digits/hyphens starting with a letter',
      );
    }
  }
  if (input.version !== undefined) {
    if (typeof input.version !== 'string' || !SEMVER_PATTERN.test(input.version)) {
      throw new InvalidRequestError('version: must be a semantic version X.Y.Z(-prerelease)');
    }
  }
  if (
    typeof input.idempotencyKey !== 'string' ||
    input.idempotencyKey.length < 1 ||
    input.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH
  ) {
    throw new InvalidRequestError(
      `idempotencyKey: must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
    );
  }
}

/**
 * Validates the SERVER-DERIVED provenance block (the /deployments
 * assertValidProvenance precedent — the block arrives as a separate
 * module-API argument so no DTO can feed it structurally). Pure.
 */
export function assertValidAppInstallProvenance(provenance: {
  readonly actor?: unknown;
  readonly recordedVia?: unknown;
  readonly correlationId?: unknown;
  readonly causationId?: unknown;
}): void {
  const label = (field: string, value: unknown): void => {
    if (
      typeof value !== 'string' ||
      value.length < 1 ||
      value.length > MAX_PROVENANCE_LABEL_LENGTH
    ) {
      throw new InvalidRequestError(
        `${field}: must be 1-${MAX_PROVENANCE_LABEL_LENGTH} characters`,
      );
    }
  };
  label('provenance.actor', provenance.actor);
  label('provenance.recordedVia', provenance.recordedVia);
  label('provenance.correlationId', provenance.correlationId);
  if (
    provenance.causationId !== null &&
    provenance.causationId !== undefined &&
    (typeof provenance.causationId !== 'string' ||
      provenance.causationId.length < 1 ||
      provenance.causationId.length > MAX_PROVENANCE_LABEL_LENGTH)
  ) {
    throw new InvalidRequestError(
      `provenance.causationId: must be null or 1-${MAX_PROVENANCE_LABEL_LENGTH} characters`,
    );
  }
}

// ---------------------------------------------------------------------------
// The policy-action shape builders (pure — the gate/grant evaluation inputs)
// ---------------------------------------------------------------------------

/**
 * The OPERATION-LEVEL gate action of one selection: the extension-dimension
 * boundary of the app lifecycle (Apps are versioned composition packages
 * over Extensions). The action carries the app identity + the requested
 * surface summary + the CERTIFICATION STATE (trust level is metadata and a
 * POLICY INPUT — mos-app-ecosystem-v1.5.md "Trust levels"), so a policy can
 * deny UNVERIFIED app installs per client/agency/platform scope. Pure.
 */
export function buildInstallGateAction(
  record: AppVersionRecord,
  operation: AppInstallOperation,
): PolicyActionDescriptor {
  return {
    dimension: 'extension',
    operation,
    resource: record.manifest.appKey,
    attributes: {
      appVersionId: record.appVersionId,
      version: record.manifest.version,
      runtimeClass: record.manifest.runtimeClass,
      certificationState: record.certificationState,
      dataScopeCount: String(record.manifest.dataScopes.length),
      mutationScopeCount: String(record.manifest.mutationScopes.length),
      networkDestinationCount: String(record.manifest.networkDestinations.length),
    },
  };
}

/**
 * The PER-SCOPE grant action: one requested scope evaluated under the SAME
 * extension-dimension operation, addressed by the scope-kind attribute key
 * (dataScope / mutationScope). A policy may deny one scope while allowing
 * the selection itself — the derived grants are the honest intersection.
 * Pure.
 */
export function buildScopeGrantAction(
  appKey: string,
  operation: AppInstallOperation,
  scopeKind: 'data' | 'mutation',
  scope: string,
): PolicyActionDescriptor {
  return {
    dimension: 'extension',
    operation,
    resource: appKey,
    attributes: { [scopeKind === 'data' ? 'dataScope' : 'mutationScope']: scope },
  };
}

// ---------------------------------------------------------------------------
// The §8-style create fingerprint (deterministic canonical JSON digest)
// ---------------------------------------------------------------------------

/**
 * The §8-style fingerprint of one logical selection command: a
 * deterministic digest of the CANONICAL command content (app key, EXACT
 * version, operation) — one idempotency key identifies one selection
 * intent; a key reused for different content is a conflict. The
 * SERVER-DERIVED granted scopes are deliberately NOT part of the digest:
 * they are the command's RESULT (replays converge to the recorded row, so
 * policy drift between replays never forks the ledger). Pure.
 */
export function appInstallCreateFingerprint(content: {
  readonly appKey: string;
  readonly version: string;
  readonly operation: AppInstallOperation;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        appKey: content.appKey,
        version: content.version,
        operation: content.operation,
      }),
    )
    .update('|mkt-048-app-install')
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Row shapes + mapping
// ---------------------------------------------------------------------------

interface AppInstallRow extends DbRow {
  install_id: string;
  agency_id: string;
  client_id: string;
  workspace_id: string;
  app_key: string;
  app_version_id: string;
  version: string;
  operation: string;
  granted_data_scopes: string[];
  granted_mutation_scopes: string[];
  policy_decision_id: string | null;
  selection_seq: number | string;
  status: string;
  superseded_at: Date | null;
  installed_by: string | null;
  installed_at: Date;
  idempotency_key: string;
  create_fingerprint: string;
}

interface AppInstallEventRow extends DbRow {
  event_id: string;
  install_id: string;
  agency_id: string;
  client_id: string;
  workspace_id: string;
  app_key: string;
  event_type: string;
  prior_install_id: string | null;
  from_version: string | null;
  to_version: string;
  policy_decision_id: string | null;
  idempotency_key: string;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
}

const APP_INSTALL_SELECT = `
  SELECT install_id, agency_id, client_id, workspace_id, app_key, app_version_id,
         version, operation, granted_data_scopes, granted_mutation_scopes,
         policy_decision_id, selection_seq, status, superseded_at,
         installed_by, installed_at, idempotency_key, create_fingerprint
  FROM app_installs
`;

function toAppInstallRecord(row: AppInstallRow): AppInstallRecord {
  return {
    installId: row.install_id,
    agencyId: row.agency_id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    appKey: row.app_key,
    appVersionId: row.app_version_id,
    version: row.version,
    operation: row.operation as AppInstallRecord['operation'],
    grantedDataScopes: row.granted_data_scopes as AppDataScope[],
    grantedMutationScopes: row.granted_mutation_scopes as AppMutationScope[],
    policyDecisionId: row.policy_decision_id,
    selectionSeq: Number(row.selection_seq),
    status: row.status as AppInstallRecord['status'],
    supersededAt: row.superseded_at === null ? null : row.superseded_at.toISOString(),
    installedBy: row.installed_by,
    installedAt: row.installed_at.toISOString(),
    idempotencyKey: row.idempotency_key,
    createFingerprint: row.create_fingerprint,
  };
}

function toAppInstallEventRecord(row: AppInstallEventRow): AppInstallEventRecord {
  return {
    eventId: row.event_id,
    installId: row.install_id,
    agencyId: row.agency_id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    appKey: row.app_key,
    eventType: row.event_type as AppInstallEventRecord['eventType'],
    priorInstallId: row.prior_install_id,
    fromVersion: row.from_version,
    toVersion: row.to_version,
    policyDecisionId: row.policy_decision_id,
    idempotencyKey: row.idempotency_key,
    recordedActor: row.recorded_actor,
    recordedVia: row.recorded_via,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    recordedAt: row.recorded_at.toISOString(),
  };
}

/**
 * Classifies a postgres error on /app-installs writes into the domain
 * conflict it represents. Anything else propagates untouched.
 */
export function classifyAppInstallsWriteConflict(
  error: unknown,
):
  | 'idempotency-taken'
  | 'current-fence'
  | 'seq-race'
  | 'validation-backstop'
  | null {
  const candidate = error as { code?: string; constraint?: string };
  if (candidate?.code === '23505') {
    if (candidate.constraint === 'app_installs_idempotency_key_unique') return 'idempotency-taken';
    if (candidate.constraint === 'app_installs_current_fence') return 'current-fence';
    if (candidate.constraint === 'app_installs_seq_unique') return 'seq-race';
    if (candidate.constraint === 'app_install_events_idempotency_key_unique') {
      return 'idempotency-taken';
    }
    return 'current-fence';
  }
  if (candidate?.code === '23514' || candidate?.code === 'P0001') return 'validation-backstop';
  return null;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** One selection append (the single transactional write path). */
export interface SelectionAppend {
  readonly scope: {
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceId: string;
  };
  readonly appKey: string;
  readonly appVersionId: string;
  readonly version: string;
  readonly operation: AppInstallOperation;
  readonly grantedDataScopes: readonly AppDataScope[];
  readonly grantedMutationScopes: readonly AppMutationScope[];
  readonly policyDecisionId: string | null;
  readonly installedBy: string | null;
  readonly idempotencyKey: string;
  readonly createFingerprint: string;
  /** The prior CURRENT selection to supersede (null on install). */
  readonly prior: AppInstallRecord | null;
  readonly provenance: AppInstallProvenance;
}

export type SelectionAppendOutcome =
  | { readonly kind: 'appended'; readonly install: AppInstallRecord; readonly prior: AppInstallRecord | null }
  | { readonly kind: 'idempotency-taken' }
  | { readonly kind: 'current-fence' }
  | { readonly kind: 'stale' };

export class AppInstallsStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  async getAppInstall(installId: string): Promise<AppInstallRecord | null> {
    const result = await this.db.query<AppInstallRow>(`${APP_INSTALL_SELECT} WHERE install_id = $1`, [
      installId,
    ]);
    return result.rows.length === 0 ? null : toAppInstallRecord(result.rows[0]!);
  }

  async findInstallByIdempotencyKey(
    workspaceId: string,
    idempotencyKey: string,
  ): Promise<AppInstallRecord | null> {
    const result = await this.db.query<AppInstallRow>(
      `${APP_INSTALL_SELECT} WHERE workspace_id = $1 AND idempotency_key = $2`,
      [workspaceId, idempotencyKey],
    );
    return result.rows.length === 0 ? null : toAppInstallRecord(result.rows[0]!);
  }

  async findCurrentSelection(workspaceId: string, appKey: string): Promise<AppInstallRecord | null> {
    const result = await this.db.query<AppInstallRow>(
      `${APP_INSTALL_SELECT} WHERE workspace_id = $1 AND app_key = $2 AND status = 'ACTIVE'`,
      [workspaceId, appKey],
    );
    return result.rows.length === 0 ? null : toAppInstallRecord(result.rows[0]!);
  }

  async listLineageSelections(workspaceId: string, appKey: string): Promise<AppInstallRecord[]> {
    const result = await this.db.query<AppInstallRow>(
      `${APP_INSTALL_SELECT} WHERE workspace_id = $1 AND app_key = $2 ORDER BY selection_seq ASC`,
      [workspaceId, appKey],
    );
    return result.rows.map(toAppInstallRecord);
  }

  async listWorkspaceAppInstalls(workspaceId: string): Promise<AppInstallRecord[]> {
    const result = await this.db.query<AppInstallRow>(
      `${APP_INSTALL_SELECT} WHERE workspace_id = $1 ORDER BY app_key ASC, selection_seq ASC`,
      [workspaceId],
    );
    return result.rows.map(toAppInstallRecord);
  }

  async listAgencyAppInstalls(agencyId: string): Promise<AppInstallRecord[]> {
    const result = await this.db.query<AppInstallRow>(
      `${APP_INSTALL_SELECT} WHERE agency_id = $1 AND status = 'ACTIVE' ORDER BY installed_at DESC, install_id`,
      [agencyId],
    );
    return result.rows.map(toAppInstallRecord);
  }

  async listWorkspaceAppInstallEvents(workspaceId: string): Promise<AppInstallEventRecord[]> {
    const result = await this.db.query<AppInstallEventRow>(
      `SELECT event_id, install_id, agency_id, client_id, workspace_id, app_key,
              event_type, prior_install_id, from_version, to_version,
              policy_decision_id, idempotency_key, recorded_actor, recorded_via,
              correlation_id, causation_id, recorded_at
         FROM app_install_events
        WHERE workspace_id = $1
        ORDER BY recorded_at ASC, event_id`,
      [workspaceId],
    );
    return result.rows.map(toAppInstallEventRecord);
  }

  /**
   * ONE selection append — the single transactional write path:
   *   1. (upgrade/rollback) lock + supersede the prior CURRENT row (the
   *      single sanctioned UPDATE; a moved selection yields 'stale');
   *   2. insert the successor ledger row (selection_seq = prior + 1; the
   *      §8 + current fences converge races);
   *   3. insert the append-only lifecycle event row.
   */
  async applySelection(append: SelectionAppend): Promise<SelectionAppendOutcome> {
    const installId = this.ids.newId();
    const eventId = this.ids.newId();
    const now = this.clock.nowIso();
    const selectionSeq = append.prior === null ? 1 : append.prior.selectionSeq + 1;

    try {
      const install = await this.db.transaction(async (tx) => {
        // 1. Supersede the prior current selection (the SINGLE sanctioned
        //    UPDATE of migration 038). The guarded WHERE serializes
        //    concurrent selection changes of the same lineage: a moved
        //    selection updates zero rows → 'stale'.
        if (append.prior !== null) {
          const superseded = await tx.query(
            `UPDATE app_installs
                SET status = 'SUPERSEDED', superseded_at = $2
              WHERE install_id = $1 AND status = 'ACTIVE'`,
            [append.prior.installId, now],
          );
          if (superseded.rowCount !== 1) {
            throw new StaleSelectionError();
          }
        }

        // 2. The successor ledger row.
        await tx.query(
          `INSERT INTO app_installs (
             install_id, agency_id, client_id, workspace_id,
             app_key, app_version_id, version, operation,
             granted_data_scopes, granted_mutation_scopes, policy_decision_id,
             selection_seq, status, superseded_at,
             installed_by, installed_at, idempotency_key, create_fingerprint
           ) VALUES (
             $1, $2, $3, $4,
             $5, $6, $7, $8,
             $9::jsonb, $10::jsonb, $11,
             $12, 'ACTIVE', NULL,
             $13, $14, $15, $16
           )`,
          [
            installId,
            append.scope.agencyId,
            append.scope.clientId,
            append.scope.workspaceId,
            append.appKey,
            append.appVersionId,
            append.version,
            append.operation,
            JSON.stringify(append.grantedDataScopes),
            JSON.stringify(append.grantedMutationScopes),
            append.policyDecisionId,
            selectionSeq,
            append.installedBy,
            now,
            append.idempotencyKey,
            append.createFingerprint,
          ],
        );

        // 3. The append-only lifecycle event row.
        await tx.query(
          `INSERT INTO app_install_events (
             event_id, install_id, agency_id, client_id, workspace_id, app_key,
             event_type, prior_install_id, from_version, to_version,
             policy_decision_id, idempotency_key,
             recorded_actor, recorded_via, correlation_id, causation_id, recorded_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6,
             $7, $8, $9, $10,
             $11, $12,
             $13, $14, $15, $16, $17
           )`,
          [
            eventId,
            installId,
            append.scope.agencyId,
            append.scope.clientId,
            append.scope.workspaceId,
            append.appKey,
            append.operation === 'install' ? 'installed' : append.operation === 'upgrade' ? 'upgraded' : 'rolled_back',
            append.prior === null ? null : append.prior.installId,
            append.prior === null ? null : append.prior.version,
            append.version,
            append.policyDecisionId,
            append.idempotencyKey,
            append.provenance.actor,
            append.provenance.recordedVia,
            append.provenance.correlationId,
            append.provenance.causationId,
            now,
          ],
        );

        const inserted = await tx.query<AppInstallRow>(
          `${APP_INSTALL_SELECT} WHERE install_id = $1`,
          [installId],
        );
        return toAppInstallRecord(inserted.rows[0]!);
      });

      return { kind: 'appended', install, prior: append.prior };
    } catch (error) {
      if (error instanceof StaleSelectionError) return { kind: 'stale' };
      const conflict = classifyAppInstallsWriteConflict(error);
      if (conflict === 'idempotency-taken') return { kind: 'idempotency-taken' };
      if (conflict === 'current-fence' || conflict === 'seq-race') return { kind: 'current-fence' };
      if (conflict === 'validation-backstop') {
        // A CHECK/trigger fence rejected the write (the exact-version
        // identity + least-privilege grants trigger is the material case).
        // Surface the database's own reason.
        throw new InvalidRequestError(
          `the app install selection was rejected by the storage validation backstop: ${(error as { message?: string }).message ?? 'constraint violation'}`,
        );
      }
      throw error;
    }
  }
}

/** Internal control-flow signal: the current selection moved mid-flight. */
class StaleSelectionError extends Error {
  constructor() {
    super('the current selection moved before the append could be applied');
  }
}
