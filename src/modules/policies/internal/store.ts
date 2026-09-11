/**
 * /policies persistence (policies + policy_decisions tables, migration
 * 025) — append-oriented history with database backstops:
 *
 *   - policy VERSIONS: content is immutable after declaration (the DB
 *     rejects every content mutation); the only mutable lifecycle edge is
 *     active → superseded (terminal) applied by the next version's
 *     declaration inside ONE row-locked transaction. The
 *     (scope, dimension, version_seq) expression fence makes sequence
 *     allocation race-free, and the per-scope ACTIVE fence guarantees
 *     exactly one active version per (scope, dimension) — a concurrent
 *     duplicate declaration converges to a ConflictError, never a silent
 *     overwrite;
 *   - DECISIONS: append-only — UPDATE and DELETE are rejected by triggers
 *     (the migration 015/018 pattern), so this store can only INSERT and
 *     SELECT them. Provenance columns are written exclusively from the
 *     server-built PolicyDecisionProvenance argument; outcomes/reason
 *     codes are server-computed — there is no other write path.
 *
 * The §21 secret-leak guard runs on every payload BEFORE insert: the
 * policy engine evaluates ACCESS PROPOSALS — material-shaped keys can
 * never enter policy rules, actions or decision records.
 */

import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  PolicyActionDescriptor,
  PolicyDecisionProvenance,
  PolicyDecisionRecord,
  PolicyDimension,
  PolicyOutcome,
  PolicyReasonCode,
  PolicyRule,
  PolicyScopeKind,
  PolicyVersionRecord,
} from '../public.ts';
import { POLICY_MATERIAL_SHAPED_KEYS, RESERVED_CREDENTIAL_ATTRIBUTE_KEYS } from '../public.ts';

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface PolicyVersionRow extends DbRow {
  policy_id: string;
  dimension: string;
  agency_id: string | null;
  client_id: string | null;
  status: string;
  version_seq: string | number;
  rules: unknown;
  description: string;
  created_by: string | null;
  superseded_at: Date | null;
  superseded_by_policy_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface PolicyDecisionRow extends DbRow {
  decision_id: string;
  dimension: string;
  agency_id: string;
  client_id: string | null;
  outcome: string;
  reason_code: string;
  reasons: unknown;
  action: unknown;
  matched_policy_versions: unknown;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
  evaluated_at: Date;
}

const POLICY_SELECT = `
  SELECT p.policy_id, p.dimension, p.agency_id, p.client_id, p.status, p.version_seq,
         p.rules, p.description, p.created_by, p.superseded_at, p.superseded_by_policy_id,
         p.created_at, p.updated_at
  FROM policies p
`;

const DECISION_SELECT = `
  SELECT d.decision_id, d.dimension, d.agency_id, d.client_id, d.outcome, d.reason_code,
         d.reasons, d.action, d.matched_policy_versions, d.recorded_actor, d.recorded_via,
         d.correlation_id, d.causation_id, d.recorded_at, d.evaluated_at
  FROM policy_decisions d
`;

// ---------------------------------------------------------------------------
// Bounded shape constants (mirrored by the migration CHECKs)
// ---------------------------------------------------------------------------

const MAX_RULES_PER_VERSION = 64;
const MAX_OPERATIONS_PER_RULE = 32;
const MAX_OPERATION_LENGTH = 64;
const MAX_RESOURCE_LENGTH = 256;
const MAX_RULE_ATTRIBUTES = 16;
const MAX_ATTRIBUTE_KEY_LENGTH = 64;
const MAX_ATTRIBUTE_VALUE_LENGTH = 256;
const MAX_RULE_REASON_LENGTH = 512;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_ACTION_ATTRIBUTES = 16;

/** Deep material-key walk (the §21 backstop — pure). */
export function containsMaterialShapedKey(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some((entry) => containsMaterialShapedKey(entry));
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if ((POLICY_MATERIAL_SHAPED_KEYS as readonly string[]).includes(key)) return true;
    if (containsMaterialShapedKey(entry)) return true;
  }
  return false;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === 'string');
}

// ---------------------------------------------------------------------------
// Input guards (pure; exported through public.ts for unit tests)
// ---------------------------------------------------------------------------

/**
 * Pure declaration guard at the authority boundary: the module never
 * persists a policy version that violates the frozen POL-001 shapes —
 * known dimension, legal scope shape, bounded rules with the exact rule
 * contract, and NO material-shaped key anywhere (§21).
 */
export function assertValidPolicyDeclarationInput(input: {
  readonly scope: { readonly agencyId: string | null; readonly clientId: string | null };
  readonly dimension: PolicyDimension;
  readonly rules: readonly PolicyRule[];
  readonly description: string;
}): void {
  const problems: string[] = [];

  // Scope shape (the module re-resolves agency/client ownership THROUGH
  // the canonical authorities; this guard pins the structural legality).
  if (input.scope.clientId !== null && input.scope.agencyId === null) {
    problems.push('scope: a client-scoped declaration requires the owning agency');
  }
  if (input.scope.agencyId !== null && input.scope.agencyId.trim() === '') {
    problems.push('scope.agencyId: must be a non-empty identifier when present');
  }
  if (input.scope.clientId !== null && input.scope.clientId.trim() === '') {
    problems.push('scope.clientId: must be a non-empty identifier when present');
  }

  if (typeof input.dimension !== 'string' || !['ai', 'tools', 'network', 'secrets', 'deployment', 'field', 'extension'].includes(input.dimension)) {
    problems.push(`dimension '${String(input.dimension)}' is not one of the seven frozen policy dimensions`);
  }

  if (input.rules.length === 0) {
    problems.push('rules: a policy version must declare at least one rule');
  } else if (input.rules.length > MAX_RULES_PER_VERSION) {
    problems.push(`rules: a policy version carries at most ${MAX_RULES_PER_VERSION} rules`);
  }

  for (const [index, rule] of input.rules.entries()) {
    const label = `rules[${index}]`;
    if (rule === null || typeof rule !== 'object') {
      problems.push(`${label}: must be an object`);
      continue;
    }
    if (rule.effect !== 'allow' && rule.effect !== 'deny') {
      problems.push(`${label}.effect: must be 'allow' or 'deny'`);
    }
    if (!Array.isArray(rule.operations) || rule.operations.length === 0) {
      problems.push(`${label}.operations: a non-empty list of operation labels is required`);
    } else if (rule.operations.length > MAX_OPERATIONS_PER_RULE) {
      problems.push(`${label}.operations: at most ${MAX_OPERATIONS_PER_RULE} operation labels per rule`);
    } else {
      for (const operation of rule.operations) {
        if (typeof operation !== 'string' || operation.trim() === '' || operation.length > MAX_OPERATION_LENGTH) {
          problems.push(
            `${label}.operations: operation labels must be between 1 and ${MAX_OPERATION_LENGTH} characters`,
          );
          break;
        }
      }
    }
    if (
      rule.resource !== null &&
      rule.resource !== undefined &&
      (typeof rule.resource !== 'string' || rule.resource.trim() === '' || rule.resource.length > MAX_RESOURCE_LENGTH)
    ) {
      problems.push(`${label}.resource: must be between 1 and ${MAX_RESOURCE_LENGTH} characters when present`);
    }
    if (rule.attributes !== null && rule.attributes !== undefined) {
      if (!isStringRecord(rule.attributes)) {
        problems.push(`${label}.attributes: must be an object of string key → string value`);
      } else {
        const entries = Object.entries(rule.attributes as Record<string, string>);
        if (entries.length > MAX_RULE_ATTRIBUTES) {
          problems.push(`${label}.attributes: at most ${MAX_RULE_ATTRIBUTES} selector keys per rule`);
        }
        for (const [key, value] of entries) {
          if (key.trim() === '' || key.length > MAX_ATTRIBUTE_KEY_LENGTH) {
            problems.push(
              `${label}.attributes: keys must be between 1 and ${MAX_ATTRIBUTE_KEY_LENGTH} characters`,
            );
            break;
          }
          if (value.length > MAX_ATTRIBUTE_VALUE_LENGTH) {
            problems.push(
              `${label}.attributes.${key}: values must be at most ${MAX_ATTRIBUTE_VALUE_LENGTH} characters`,
            );
            break;
          }
        }
      }
    }
    if (typeof rule.reason !== 'string' || rule.reason.trim() === '' || rule.reason.length > MAX_RULE_REASON_LENGTH) {
      problems.push(`${label}.reason: a bounded human explanation (1..${MAX_RULE_REASON_LENGTH} chars) is required`);
    }
  }

  if (typeof input.description !== 'string' || input.description.trim() === '' || input.description.length > MAX_DESCRIPTION_LENGTH) {
    problems.push(`description: a bounded declaration description (1..${MAX_DESCRIPTION_LENGTH} chars) is required`);
  }

  if (containsMaterialShapedKey(input.rules)) {
    problems.push('rules: material-shaped keys can never appear in policy payloads (implementation-contract §21)');
  }

  if (problems.length > 0) {
    throw new InvalidRequestError('policy declaration rejected by the input guard', problems);
  }
}

/**
 * Pure action guard: the evaluated action must carry a KNOWN dimension
 * (fail-closed on unknown dimension — rejection, never a decision), a
 * bounded operation, bounded resource/attribute selectors and no
 * material-shaped keys. For the secrets dimension the resource is the
 * CREDENTIAL REFERENCE id.
 */
export function assertValidPolicyAction(action: PolicyActionDescriptor): void {
  const problems: string[] = [];

  if (typeof action.dimension !== 'string' || !['ai', 'tools', 'network', 'secrets', 'deployment', 'field', 'extension'].includes(action.dimension)) {
    problems.push(`dimension '${String(action.dimension)}' is not one of the seven frozen policy dimensions (fail-closed)`);
  }

  if (typeof action.operation !== 'string' || action.operation.trim() === '' || action.operation.length > MAX_OPERATION_LENGTH) {
    problems.push(`operation: a bounded operation label (1..${MAX_OPERATION_LENGTH} chars) is required`);
  }

  if (
    action.resource !== null &&
    action.resource !== undefined &&
    (typeof action.resource !== 'string' || action.resource.trim() === '' || action.resource.length > MAX_RESOURCE_LENGTH)
  ) {
    problems.push(`resource: must be between 1 and ${MAX_RESOURCE_LENGTH} characters when present`);
  }

  if (action.attributes === null || typeof action.attributes !== 'object' || Array.isArray(action.attributes)) {
    problems.push('attributes: must be an object of string key → string value');
  } else {
    const entries = Object.entries(action.attributes as Record<string, unknown>);
    if (entries.length > MAX_ACTION_ATTRIBUTES) {
      problems.push(`attributes: at most ${MAX_ACTION_ATTRIBUTES} selector keys per action`);
    }
    for (const [key, value] of entries) {
      if (key.trim() === '' || key.length > MAX_ATTRIBUTE_KEY_LENGTH) {
        problems.push(`attributes: keys must be between 1 and ${MAX_ATTRIBUTE_KEY_LENGTH} characters`);
        break;
      }
      if (typeof value !== 'string' || value.length > MAX_ATTRIBUTE_VALUE_LENGTH) {
        problems.push(
          `attributes.${key}: values must be strings of at most ${MAX_ATTRIBUTE_VALUE_LENGTH} characters`,
        );
        break;
      }
    }
    // Caller-supplied credential-shaped authority values are ignored for
    // the secrets dimension (server-derived), but they are still REJECTED
    // here outright: the request surface never even carries them.
    if (action.dimension === 'secrets') {
      for (const reserved of RESERVED_CREDENTIAL_ATTRIBUTE_KEYS) {
        if ((action.attributes as Record<string, unknown>)[reserved] !== undefined) {
          problems.push(
            `attributes.${reserved}: credential-shaped authority attributes are server-derived and cannot be supplied`,
          );
        }
      }
    }
  }

  if (containsMaterialShapedKey(action)) {
    problems.push('action: material-shaped keys can never appear in policy payloads (implementation-contract §21)');
  }

  if (problems.length > 0) {
    throw new InvalidRequestError('policy action rejected by the input guard (fail-closed)', problems);
  }
}

/**
 * Provenance is server-derived and must be COMPLETE before anything runs:
 * an incomplete provenance fails closed (the decision record's authority
 * columns are never defaulted from caller input).
 */
export function assertValidPolicyDecisionProvenance(provenance: PolicyDecisionProvenance): void {
  const problems: string[] = [];
  if (provenance.actor.trim() === '') {
    problems.push('provenance.actor: a non-empty server-derived principal label is required');
  }
  if (provenance.recordedVia.trim() === '' || provenance.recordedVia.length > 100) {
    problems.push('provenance.recordedVia: a non-empty server-derived surface label is required');
  }
  if (provenance.correlationId.trim() === '') {
    problems.push('provenance.correlationId: policy decisions are correlation-linked');
  }
  if (provenance.causationId !== null && provenance.causationId.trim() === '') {
    problems.push('provenance.causationId: must be a non-empty identifier when present');
  }
  if (problems.length > 0) {
    throw new InvalidRequestError(
      'policy evaluation rejected: provenance is server-derived and must be complete',
      problems,
    );
  }
}

/**
 * Composes the EFFECTIVE attributes for a secrets-dimension access
 * proposal: the caller's bounded attributes with the SERVER-DERIVED
 * credential reference metadata composed on top (reserved keys are always
 * overwritten — caller-supplied values never survive). Pure.
 */
export function composeSecretsEffectiveAttributes(
  callerAttributes: Readonly<Record<string, string>>,
  reference: {
    readonly kind: string;
    readonly clientId: string | null;
    readonly status: string;
  },
): Readonly<Record<string, string>> {
  const effective: Record<string, string> = {};
  for (const [key, value] of Object.entries(callerAttributes)) {
    if ((RESERVED_CREDENTIAL_ATTRIBUTE_KEYS as readonly string[]).includes(key)) continue;
    effective[key] = value;
  }
  effective['credentialKind'] = reference.kind;
  effective['credentialStatus'] = reference.status;
  if (reference.clientId !== null) {
    effective['credentialClientId'] = reference.clientId;
  }
  return effective;
}

/** Classifies a postgres error on policy INSERT/UPDATE into the concurrency fences. */
export function classifyPolicyWriteConflict(error: unknown): 'active-fence' | 'version-seq-fence' | null {
  const candidate = error as { code?: string; message?: string };
  if (candidate?.code === '23505' || (candidate?.message ?? '').includes('duplicate key value violates unique constraint')) {
    if ((candidate?.message ?? '').includes('policies_active_fence')) return 'active-fence';
    if ((candidate?.message ?? '').includes('policies_scope_version_fence')) return 'version-seq-fence';
    return 'active-fence';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Insert row shapes
// ---------------------------------------------------------------------------

export interface PolicyVersionInsertRow {
  readonly dimension: PolicyDimension;
  readonly agencyId: string | null;
  readonly clientId: string | null;
  readonly rules: readonly PolicyRule[];
  readonly description: string;
  readonly createdBy: string | null;
}

export interface PolicyDecisionInsertRow {
  readonly dimension: PolicyDimension;
  readonly agencyId: string;
  readonly clientId: string | null;
  readonly outcome: PolicyOutcome;
  readonly reasonCode: PolicyReasonCode;
  readonly reasons: readonly string[];
  readonly action: PolicyActionDescriptor;
  readonly matchedPolicyVersions: readonly string[];
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export class PoliciesStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  /**
   * Declares one policy version with append-oriented supersession, inside
   * ONE row-locked transaction:
   *   1. lock the (scope, dimension) ACTIVE row (if any) — serializes the
   *      supersession edge;
   *   2. compute versionSeq = MAX(existing) + 1 (the unique expression
   *      fence backstops concurrent allocation);
   *   3. mark the prior active row 'superseded' (terminal; the history
   *      row stays queryable with supersededAt/supersededByPolicyId);
   *   4. insert the NEW active row.
   * A concurrent duplicate converges to a ConflictError (the fences);
   * never a silent overwrite.
   */
  async insertPolicyVersion(row: PolicyVersionInsertRow): Promise<PolicyVersionRecord> {
    const policyId = this.ids.newId();
    const now = this.clock.nowIso();
    return this.db.transaction(async (tx) => {
      // Serialize on the active version of this (scope, dimension).
      const active = await tx.query<PolicyVersionRow>(
        `${POLICY_SELECT}
         WHERE p.dimension = $1 AND p.agency_id IS NOT DISTINCT FROM $2 AND p.client_id IS NOT DISTINCT FROM $3
           AND p.status = 'active'
         FOR UPDATE`,
        [row.dimension, row.agencyId, row.clientId],
      );
      const seqResult = await tx.query<{ max_seq: string | number | null }>(
        `SELECT MAX(p.version_seq) AS max_seq FROM policies p
         WHERE p.dimension = $1 AND p.agency_id IS NOT DISTINCT FROM $2 AND p.client_id IS NOT DISTINCT FROM $3`,
        [row.dimension, row.agencyId, row.clientId],
      );
      const nextSeq = Number(seqResult.rows[0]?.max_seq ?? 0) + 1;

      if (active.rows.length > 0) {
        const prior = active.rows[0]!;
        await tx.query(
          `UPDATE policies SET status = 'superseded', superseded_at = $1, superseded_by_policy_id = $2,
                  version = version + 1, updated_at = $1
           WHERE policy_id = $3`,
          [now, policyId, prior.policy_id],
        );
      }

      await tx.query(
        `INSERT INTO policies (policy_id, dimension, agency_id, client_id, status, version_seq,
                               rules, description, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'active', $5, $6::jsonb, $7, $8, $9, $9)`,
        [
          policyId,
          row.dimension,
          row.agencyId,
          row.clientId,
          nextSeq,
          JSON.stringify(row.rules),
          row.description,
          row.createdBy,
          now,
        ],
      );
      // Read back INSIDE the transaction (same connection): the new row is
      // not yet visible to other pooled connections.
      const readBack = await tx.query<PolicyVersionRow>(
        `${POLICY_SELECT} WHERE p.policy_id = $1`,
        [policyId],
      );
      const created = readBack.rows[0];
      if (created === undefined) {
        throw new Error(`declared policy version ${policyId} could not be read back`);
      }
      return toPolicyVersionRecord(created);
    });
  }

  async getPolicyVersion(policyId: string): Promise<PolicyVersionRecord | null> {
    const result = await this.db.query<PolicyVersionRow>(
      `${POLICY_SELECT} WHERE p.policy_id = $1`,
      [policyId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toPolicyVersionRecord(row);
  }

  async listPolicyVersions(input: {
    readonly agencyId: string | null;
    readonly clientId: string | null;
    readonly dimension: PolicyDimension | null;
    readonly includeSuperseded: boolean;
  }): Promise<readonly PolicyVersionRecord[]> {
    const clauses: string[] = [
      'p.agency_id IS NOT DISTINCT FROM $1',
      'p.client_id IS NOT DISTINCT FROM $2',
    ];
    const params: (string | number | boolean | null)[] = [input.agencyId, input.clientId];
    if (input.dimension !== null) {
      params.push(input.dimension);
      clauses.push(`p.dimension = $${params.length}`);
    }
    if (!input.includeSuperseded) {
      clauses.push(`p.status = 'active'`);
    }
    const result = await this.db.query<PolicyVersionRow>(
      `${POLICY_SELECT} WHERE ${clauses.join(' AND ')}
       ORDER BY p.version_seq DESC, p.policy_id LIMIT 500`,
      params,
    );
    return result.rows.map(toPolicyVersionRecord);
  }

  async getActivePolicyVersion(input: {
    readonly agencyId: string | null;
    readonly clientId: string | null;
    readonly dimension: PolicyDimension;
  }): Promise<PolicyVersionRecord | null> {
    const result = await this.db.query<PolicyVersionRow>(
      `${POLICY_SELECT}
       WHERE p.agency_id IS NOT DISTINCT FROM $1 AND p.client_id IS NOT DISTINCT FROM $2
         AND p.dimension = $3 AND p.status = 'active'`,
      [input.agencyId, input.clientId, input.dimension],
    );
    const row = result.rows[0];
    return row === undefined ? null : toPolicyVersionRecord(row);
  }

  /**
   * Loads the ACTIVE versions of the dimension for the evaluation scope
   * chain (client > agency > platform), in consultation order. One query;
   * empty array when nothing is declared at any level.
   */
  async loadScopeChainVersions(
    dimension: PolicyDimension,
    scope: { readonly agencyId: string; readonly clientId: string | null },
  ): Promise<readonly PolicyVersionRecord[]> {
    const result = await this.db.query<PolicyVersionRow>(
      `${POLICY_SELECT}
       WHERE p.dimension = $1 AND p.status = 'active'
         AND (
           (p.agency_id IS NULL AND p.client_id IS NULL)
           OR (p.agency_id = $2 AND p.client_id IS NULL)
           OR (p.agency_id = $2 AND p.client_id = $3)
         )`,
      [dimension, scope.agencyId, scope.clientId],
    );
    const byScope = new Map<string, PolicyVersionRecord>();
    for (const row of result.rows) {
      const record = toPolicyVersionRecord(row);
      const key = record.scopeKind;
      // The unique ACTIVE fence guarantees one row per scope level; the
      // map keeps the consultation deterministic.
      byScope.set(key, record);
    }
    const ordered: PolicyVersionRecord[] = [];
    const clientVersion = byScope.get('client');
    if (clientVersion !== undefined) ordered.push(clientVersion);
    const agencyVersion = byScope.get('agency');
    if (agencyVersion !== undefined) ordered.push(agencyVersion);
    const platformVersion = byScope.get('platform');
    if (platformVersion !== undefined) ordered.push(platformVersion);
    return ordered;
  }

  /** Appends one immutable decision record (the only write path). */
  async insertDecision(
    row: PolicyDecisionInsertRow,
    provenance: PolicyDecisionProvenance,
  ): Promise<PolicyDecisionRecord> {
    const decisionId = this.ids.newId();
    const recordedAt = this.clock.nowIso();
    const evaluatedAt = this.clock.nowIso();
    await this.db.query(
      `INSERT INTO policy_decisions (decision_id, dimension, agency_id, client_id, outcome,
                             reason_code, reasons, action, matched_policy_versions,
                             recorded_actor, recorded_via, correlation_id, causation_id,
                             recorded_at, evaluated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14, $15)`,
      [
        decisionId,
        row.dimension,
        row.agencyId,
        row.clientId,
        row.outcome,
        row.reasonCode,
        JSON.stringify(row.reasons),
        JSON.stringify(row.action),
        JSON.stringify(row.matchedPolicyVersions),
        provenance.actor,
        provenance.recordedVia,
        provenance.correlationId,
        provenance.causationId,
        recordedAt,
        evaluatedAt,
      ],
    );
    const created = await this.getDecision(decisionId);
    if (created === null) {
      throw new Error(`recorded policy decision ${decisionId} could not be read back`);
    }
    return created;
  }

  async getDecision(decisionId: string): Promise<PolicyDecisionRecord | null> {
    const result = await this.db.query<PolicyDecisionRow>(
      `${DECISION_SELECT} WHERE d.decision_id = $1`,
      [decisionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toPolicyDecisionRecord(row);
  }

  /** The agency's decisions, newest first (bounded — the ledger grows without end). */
  async listDecisions(
    agencyId: string,
    clientId: string | null,
    limit = 500,
  ): Promise<readonly PolicyDecisionRecord[]> {
    const bounded = Math.min(Math.max(limit, 1), 1000);
    const result = await this.db.query<PolicyDecisionRow>(
      `${DECISION_SELECT} WHERE d.agency_id = $1 AND d.client_id IS NOT DISTINCT FROM $2
       ORDER BY d.recorded_at DESC, d.decision_id LIMIT $3`,
      [agencyId, clientId, bounded],
    );
    return result.rows.map(toPolicyDecisionRecord);
  }
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function scopeKindOf(agencyId: string | null, clientId: string | null): PolicyScopeKind {
  if (agencyId === null) return 'platform';
  return clientId === null ? 'agency' : 'client';
}

function toPolicyVersionRecord(row: PolicyVersionRow): PolicyVersionRecord {
  return {
    policyId: row.policy_id,
    dimension: row.dimension as PolicyDimension,
    scopeKind: scopeKindOf(row.agency_id, row.client_id),
    agencyId: row.agency_id,
    clientId: row.client_id,
    status: row.status as 'active' | 'superseded',
    versionSeq: Number(row.version_seq),
    rules: (row.rules ?? []) as readonly PolicyRule[],
    description: row.description,
    createdBy: row.created_by,
    supersededAt: row.superseded_at === null ? null : row.superseded_at.toISOString(),
    supersededByPolicyId: row.superseded_by_policy_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toPolicyDecisionRecord(row: PolicyDecisionRow): PolicyDecisionRecord {
  return {
    decisionId: row.decision_id,
    dimension: row.dimension as PolicyDimension,
    agencyId: row.agency_id,
    clientId: row.client_id,
    outcome: row.outcome as PolicyOutcome,
    reasonCode: row.reason_code as PolicyReasonCode,
    reasons: (row.reasons ?? []) as readonly string[],
    action: (row.action ?? {}) as PolicyActionDescriptor,
    matchedPolicyVersions: (row.matched_policy_versions ?? []) as readonly string[],
    provenance: {
      actor: row.recorded_actor,
      recordedVia: row.recorded_via,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      recordedAt: row.recorded_at.toISOString(),
      evaluatedAt: row.evaluated_at.toISOString(),
    },
  };
}
