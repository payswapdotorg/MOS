/**
 * /domain-packs persistence + the frozen input guards (MKT-036, PACK-001).
 *
 * DB backstops (migration 030 + implementation-contract §21/§25):
 *   - the (publisher, pack_key, version) UNIQUE fence: a published pack
 *     version is IMMUTABLE — re-publication converges to a constraint
 *     violation (ConflictError upstream, never a silent rewrite) and a
 *     new version is a new row;
 *   - the registry row itself rejects UPDATE and DELETE (triggers);
 *   - the (workspace_id, pack_id) UNIQUE fence: one install per pack
 *     version per workspace — a duplicate logical install command
 *     converges;
 *   - install scope-chain fences (client ∈ agency, workspace ∈ client),
 *     install identity/scope immutability and the frozen install
 *     lifecycle (born 'installed'; 'uninstalled' terminal);
 *   - the artifact scope records are APPEND-ONLY (UPDATE/DELETE
 *     rejected) with the structural §5 scope CHECK (client-scoped →
 *     client_id NOT NULL; agency-reusable → client_id NULL) and the
 *     artifact/install consistency fence.
 *
 * The §21 material-key backstop runs at the module boundary (guards) AND
 * in the database (CHECK functions): no manifest artifact payload or
 * declaration can carry material-shaped keys, and there is NO column
 * capable of holding secret material or a secret handle.
 *
 * WORKFLOW-TEMPLATE CONFORMANCE (PACK-AC-02, implementation-contract §4):
 * every 'workflow-template' artifact payload is validated through the
 * /workflows authority's own validateWorkflowDefinitionContent — imported
 * from the /workflows PUBLIC contract (the frozen matrix allows
 * /domain-packs ──→ /workflows). The framework has no workflow engine;
 * pack workflow templates are DATA that only ever materializes and
 * executes through /workflows + /executions.
 */

import { createHash } from 'node:crypto';
import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import { validateWorkflowDefinitionContent } from '../../workflows/public.ts';
import type {
  DomainPackArtifactDeclaration,
  DomainPackArtifactKind,
  DomainPackArtifactRecord,
  DomainPackArtifactScope,
  DomainPackInstallRecord,
  DomainPackInstallStatus,
  DomainPackManifest,
  DomainPackRegistryRecord,
} from '../public.ts';
import { DOMAIN_PACK_ARTIFACT_KINDS, DOMAIN_PACK_ARTIFACT_SCOPES } from '../public.ts';

// ---------------------------------------------------------------------------
// Bounds (single source of truth for every guard below)
// ---------------------------------------------------------------------------

const KEY_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;
const PUBLISHER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]{1,32})?$/;
const NAME_PATTERN = /^.{1,64}$/;

const MAX_REQUIRED_PACKS = 16;
const MAX_ARTIFACTS = 128;
const MAX_PAYLOAD_JSON_BYTES = 64 * 1024;
const MAX_MANIFEST_JSON_BYTES = 512 * 1024;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

/** Material-shaped keys that can never appear in ANY pack payload (§21). */
export const DOMAIN_PACK_MATERIAL_SHAPED_KEYS = [
  'secret',
  'secretMaterial',
  'material',
  'password',
  'token',
  'apiKey',
  'api_key',
  'accessKey',
  'secretHandle',
] as const;

// ---------------------------------------------------------------------------
// Generic payload walking (the module-side §21 backstop)
// ---------------------------------------------------------------------------

/**
 * Rejects material-shaped keys at EVERY nesting level of an arbitrary
 * JSON value. Pure; used by every guard below (the database CHECK
 * functions of migration 030 enforce the identical set).
 */
export function payloadHasNoDomainPackMaterialKeys(value: unknown, path = 'payload'): string[] {
  const problems: string[] = [];
  if (value === null || value === undefined) return problems;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      problems.push(...payloadHasNoDomainPackMaterialKeys(item, `${path}[${index}]`));
    });
    return problems;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if ((DOMAIN_PACK_MATERIAL_SHAPED_KEYS as readonly string[]).includes(key)) {
        problems.push(`${path}.${key}: material-shaped keys are rejected (secrets never appear in pack declarations — §21)`);
      }
      problems.push(...payloadHasNoDomainPackMaterialKeys(child, `${path}.${key}`));
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The manifest guard (PACK-001: the §2/§5 shape + §4 conformance contract)
// ---------------------------------------------------------------------------

function artifactProblems(artifact: unknown, index: number): string[] {
  const problems: string[] = [];
  const label = `artifacts[${index}]`;
  if (artifact === null || typeof artifact !== 'object') {
    problems.push(`${label}: must be an object { kind, name, description, scope, payload }`);
    return problems;
  }
  const declaration = artifact as Partial<DomainPackArtifactDeclaration>;
  if (
    typeof declaration.kind !== 'string' ||
    !(DOMAIN_PACK_ARTIFACT_KINDS as readonly string[]).includes(declaration.kind)
  ) {
    problems.push(
      `${label}.kind: '${String(declaration.kind)}' is not one of the fourteen frozen artifact kinds (domain-pack-v1.3.md §2)`,
    );
  }
  if (typeof declaration.name !== 'string' || !NAME_PATTERN.test(declaration.name)) {
    problems.push(`${label}.name: must be 1-64 characters`);
  }
  if (
    typeof declaration.description !== 'string' ||
    declaration.description.length < 1 ||
    declaration.description.length > 512
  ) {
    problems.push(`${label}.description: must be 1-512 characters`);
  }
  if (
    typeof declaration.scope !== 'string' ||
    !(DOMAIN_PACK_ARTIFACT_SCOPES as readonly string[]).includes(declaration.scope)
  ) {
    problems.push(
      `${label}.scope: '${String(declaration.scope)}' is not in the closed artifact-scope vocabulary (client | agency-reusable — domain-pack-v1.3.md §5)`,
    );
  }
  if (
    declaration.payload === null ||
    typeof declaration.payload !== 'object' ||
    Array.isArray(declaration.payload)
  ) {
    problems.push(`${label}.payload: must be a JSON object (the kind-specific artifact content)`);
  } else {
    const bytes = Buffer.byteLength(JSON.stringify(declaration.payload), 'utf8');
    if (bytes > MAX_PAYLOAD_JSON_BYTES) {
      problems.push(`${label}.payload: must serialize to at most ${MAX_PAYLOAD_JSON_BYTES} bytes`);
    }
    problems.push(...payloadHasNoDomainPackMaterialKeys(declaration.payload, `${label}.payload`));
    // §4 WORKFLOW-TEMPLATE CONFORMANCE (PACK-AC-02): the payload must
    // satisfy the frozen /workflows definition-content contract —
    // validated through the Workflow authority's OWN validator (the
    // framework has no workflow engine; templates only ever materialize
    // through /workflows).
    if (declaration.kind === 'workflow-template') {
      const conformance = validateWorkflowDefinitionContent(declaration.payload);
      if (conformance.length > 0) {
        problems.push(
          `${label}.payload: workflow template does not conform to the /workflows §4 definition contract (${conformance.slice(0, 5).join('; ')}${conformance.length > 5 ? '; …' : ''}) — pack workflows execute ONLY through the existing Workflow authority`,
        );
      }
    }
  }
  return problems;
}

/**
 * THE manifest shape guard (spec/domain-pack-v1.3.md §2 + §4 + §5 +
 * implementation-contract §4 + §21). A manifest that fails shape —
 * unknown artifact kind, undeclared scope vocabulary, duplicate (kind,
 * name) artifact identities, a workflow template that fails the §4
 * definition contract, a self-dependency, material-shaped keys — is
 * REJECTED (PACK-001: the pack framework's declared-capabilities shape).
 * Pure.
 */
export function assertValidDomainPackManifest(manifest: DomainPackManifest): void {
  const problems: string[] = [];

  if (manifest === null || typeof manifest !== 'object') {
    throw new InvalidRequestError('domain pack manifest must be an object');
  }
  if (typeof manifest.packKey !== 'string' || !KEY_PATTERN.test(manifest.packKey)) {
    problems.push('packKey: must be 2-63 chars, lowercase letters/digits/dashes, starting with a letter');
  }
  if (typeof manifest.publisher !== 'string' || !PUBLISHER_PATTERN.test(manifest.publisher)) {
    problems.push('publisher: must be 1-64 chars, lowercase letters/digits/dots/dashes/underscores');
  }
  if (typeof manifest.version !== 'string' || !VERSION_PATTERN.test(manifest.version)) {
    problems.push('version: must be a semver-style label X.Y.Z(-prerelease)');
  }
  if (typeof manifest.displayName !== 'string' || manifest.displayName.length < 1 || manifest.displayName.length > 128) {
    problems.push('displayName: must be 1-128 characters');
  }
  if (typeof manifest.description !== 'string' || manifest.description.length < 1 || manifest.description.length > 512) {
    problems.push('description: must be 1-512 characters');
  }

  if (
    manifest.compatibility === null ||
    typeof manifest.compatibility !== 'object' ||
    typeof manifest.compatibility.minPlatform !== 'string' ||
    manifest.compatibility.minPlatform.length < 1 ||
    manifest.compatibility.minPlatform.length > 32 ||
    typeof manifest.compatibility.maxPlatform !== 'string' ||
    manifest.compatibility.maxPlatform.length < 1 ||
    manifest.compatibility.maxPlatform.length > 32
  ) {
    problems.push('compatibility: { minPlatform, maxPlatform } are required bounded platform version labels');
  }

  if (!Array.isArray(manifest.requiredPacks)) {
    problems.push('requiredPacks: must be an array of { publisher, packKey, version } declarations');
  } else if (manifest.requiredPacks.length > MAX_REQUIRED_PACKS) {
    problems.push(`requiredPacks: at most ${MAX_REQUIRED_PACKS} pack dependencies`);
  } else {
    const seen = new Set<string>();
    for (const [index, required] of manifest.requiredPacks.entries()) {
      const label = `requiredPacks[${index}]`;
      if (required === null || typeof required !== 'object') {
        problems.push(`${label}: must be an object { publisher, packKey, version }`);
        continue;
      }
      if (typeof required.publisher !== 'string' || !PUBLISHER_PATTERN.test(required.publisher)) {
        problems.push(`${label}.publisher: must be 1-64 chars, lowercase letters/digits/dots/dashes/underscores`);
      }
      if (typeof required.packKey !== 'string' || !KEY_PATTERN.test(required.packKey)) {
        problems.push(`${label}.packKey: must be 2-63 chars, lowercase letters/digits/dashes`);
      }
      if (typeof required.version !== 'string' || !VERSION_PATTERN.test(required.version)) {
        problems.push(`${label}.version: must be a semver-style label X.Y.Z(-prerelease)`);
      }
      const ref = `${required.publisher}/${required.packKey}@${required.version}`;
      if (seen.has(ref)) {
        problems.push(`${label}: duplicate pack dependency '${ref}'`);
      } else {
        seen.add(ref);
      }
      // Self-dependency: a pack version can never require itself (the
      // dependency DAG is built from ALREADY-published versions only).
      if (
        typeof manifest.packKey === 'string' &&
        typeof manifest.publisher === 'string' &&
        typeof manifest.version === 'string' &&
        required.packKey === manifest.packKey &&
        required.publisher === manifest.publisher &&
        required.version === manifest.version
      ) {
        problems.push(
          `${label}: a pack version cannot declare itself as a dependency (${ref}) — publish the dependency first`,
        );
      }
    }
  }

  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    problems.push('artifacts: a manifest must declare at least one artifact (domain-pack-v1.3.md §2)');
  } else if (manifest.artifacts.length > MAX_ARTIFACTS) {
    problems.push(`artifacts: at most ${MAX_ARTIFACTS} artifacts per manifest`);
  } else {
    const identities = new Set<string>();
    for (const [index, artifact] of manifest.artifacts.entries()) {
      problems.push(...artifactProblems(artifact, index));
      const declaration = artifact as Partial<DomainPackArtifactDeclaration>;
      const identity = `${String(declaration.kind)}:${String(declaration.name)}`;
      if (identities.has(identity)) {
        problems.push(`artifacts[${index}]: duplicate artifact identity '${identity}' (one artifact identity per kind)`);
      } else if (typeof declaration.kind === 'string' && typeof declaration.name === 'string') {
        identities.add(identity);
      }
    }
  }

  if (problems.length > 0) {
    throw new InvalidRequestError('domain pack manifest failed the frozen shape/artifact-declaration contract', problems);
  }
}

/**
 * The install input guard: canonical scope shape, bounded idempotency
 * key. Pure.
 */
export function assertValidDomainPackInstallInput(input: {
  readonly scope: {
    readonly agencyId: string | null;
    readonly clientId: string | null;
    readonly workspaceId: string | null;
  };
  readonly packId: string;
  readonly idempotencyKey: string;
}): void {
  const problems: string[] = [];
  if (input.scope === null || typeof input.scope !== 'object') {
    problems.push('scope: the canonical install scope is required');
  } else {
    if (typeof input.scope.agencyId !== 'string' || input.scope.agencyId.length === 0) {
      problems.push('scope.agencyId: the owning agency is required');
    }
    if (typeof input.scope.clientId !== 'string' || input.scope.clientId.length === 0) {
      problems.push('scope.clientId: the owning client is required');
    }
    if (typeof input.scope.workspaceId !== 'string' || input.scope.workspaceId.length === 0) {
      problems.push('scope.workspaceId: the owning workspace is required');
    }
  }
  if (typeof input.packId !== 'string' || input.packId.length === 0) {
    problems.push('packId: the published domain pack version is required');
  }
  if (
    typeof input.idempotencyKey !== 'string' ||
    input.idempotencyKey.length < 1 ||
    input.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH
  ) {
    problems.push(`idempotencyKey: must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters`);
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('domain pack install input failed the frozen contract', problems);
  }
}

/**
 * The §8-style fingerprint of one logical publish command: a
 * deterministic digest of the CANONICAL manifest (sorted keys at every
 * level) — one idempotency key identifies one manifest; a key reused for
 * different content is a conflict. Pure.
 */
export function domainPackCreateFingerprint(manifest: DomainPackManifest): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(manifest as unknown as JSONValue)))
    .update('|mkt-036-domain-pack-manifest')
    .digest('hex');
}

type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };

/** Canonical JSON: object keys sorted at EVERY level (deterministic digest). */
function canonicalize(value: JSONValue): JSONValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, JSONValue> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalize(value[key]!);
    }
    return sorted;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Row shapes + mapping
// ---------------------------------------------------------------------------

interface DomainPackRegistryRow extends DbRow {
  pack_id: string;
  pack_key: string;
  publisher: string;
  version: string;
  display_name: string;
  description: string;
  compat_min: string;
  compat_max: string;
  required_packs: { publisher: string; packKey: string; version: string }[];
  artifacts: DomainPackArtifactDeclaration[];
  idempotency_key: string;
  create_fingerprint: string;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

interface DomainPackInstallRow extends DbRow {
  install_id: string;
  pack_id: string;
  agency_id: string;
  client_id: string;
  workspace_id: string;
  status: string;
  idempotency_key: string;
  version: number | string;
  created_by: string | null;
  uninstalled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface DomainPackArtifactRow extends DbRow {
  artifact_id: string;
  install_id: string;
  pack_id: string;
  artifact_kind: string;
  artifact_name: string;
  scope: string;
  agency_id: string;
  client_id: string | null;
  workspace_id: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

const PACK_SELECT = `
  SELECT pack_id, pack_key, publisher, version, display_name, description,
         compat_min, compat_max, required_packs, artifacts, idempotency_key,
         create_fingerprint, created_by, created_at, updated_at
  FROM domain_packs
`;

const INSTALL_SELECT = `
  SELECT install_id, pack_id, agency_id, client_id, workspace_id, status,
         idempotency_key, version, created_by, uninstalled_at, created_at, updated_at
  FROM domain_pack_installs
`;

const ARTIFACT_SELECT = `
  SELECT a.artifact_id, a.install_id, a.pack_id, a.artifact_kind, a.artifact_name,
         a.scope, a.agency_id, a.client_id, a.workspace_id,
         (SELECT (e.value->>'payload')::jsonb
            FROM jsonb_array_elements(p.artifacts) e
           WHERE e.value->>'kind' = a.artifact_kind
             AND e.value->>'name' = a.artifact_name) AS payload,
         a.created_at
  FROM domain_pack_artifacts a
  JOIN domain_packs p ON p.pack_id = a.pack_id
`;

function toRegistryRecord(row: DomainPackRegistryRow): DomainPackRegistryRecord {
  return {
    packId: row.pack_id,
    manifest: {
      packKey: row.pack_key,
      publisher: row.publisher,
      version: row.version,
      displayName: row.display_name,
      description: row.description,
      compatibility: { minPlatform: row.compat_min, maxPlatform: row.compat_max },
      requiredPacks: row.required_packs,
      artifacts: row.artifacts,
    },
    idempotencyKey: row.idempotency_key,
    createFingerprint: row.create_fingerprint,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toInstallRecord(row: DomainPackInstallRow): DomainPackInstallRecord {
  return {
    installId: row.install_id,
    packId: row.pack_id,
    agencyId: row.agency_id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    status: row.status as DomainPackInstallStatus,
    idempotencyKey: row.idempotency_key,
    version: Number(row.version),
    createdBy: row.created_by,
    uninstalledAt: row.uninstalled_at === null ? null : row.uninstalled_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toArtifactRecord(row: DomainPackArtifactRow): DomainPackArtifactRecord {
  return {
    artifactId: row.artifact_id,
    installId: row.install_id,
    packId: row.pack_id,
    artifactKind: row.artifact_kind as DomainPackArtifactKind,
    artifactName: row.artifact_name,
    scope: row.scope as DomainPackArtifactScope,
    agencyId: row.agency_id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    payload: row.payload ?? {},
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Classifies a postgres error on /domain-packs writes into the domain
 * conflict it represents (unique-violation fence vs lifecycle backstop).
 * Anything else propagates untouched.
 */
export function classifyDomainPacksWriteConflict(error: unknown): 'version-fence' | 'install-fence' | 'artifact-fence' | 'lifecycle-backstop' | null {
  const candidate = error as { code?: string; constraint?: string };
  if (candidate?.code === '23505') {
    if (candidate.constraint === 'domain_pack_installs_workspace_pack_unique') return 'install-fence';
    if (candidate.constraint === 'domain_pack_artifacts_install_kind_name_unique') return 'artifact-fence';
    return 'version-fence';
  }
  if (candidate?.code === '23514' || candidate?.code === 'P0001') return 'lifecycle-backstop';
  return null;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export class DomainPacksStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  /**
   * Inserts one published version. 'taken' means the (publisher, key,
   * version) fence rejected the insert — the immutable version already
   * exists (ConflictError upstream; never a silent rewrite).
   */
  async insertDomainPackVersion(row: {
    readonly manifest: DomainPackManifest;
    readonly idempotencyKey: string;
    readonly createFingerprint: string;
    readonly createdBy: string | null;
  }): Promise<DomainPackRegistryRecord | 'taken'> {
    const packId = this.ids.newId();
    const now = this.clock.nowIso();
    const manifest = row.manifest;
    if (Buffer.byteLength(JSON.stringify(manifest), 'utf8') > MAX_MANIFEST_JSON_BYTES) {
      throw new InvalidRequestError(
        `domain pack manifest must serialize to at most ${MAX_MANIFEST_JSON_BYTES} bytes`,
      );
    }
    const result = await this.db.query(
      `INSERT INTO domain_packs
         (pack_id, pack_key, publisher, version, display_name, description,
          compat_min, compat_max, required_packs, artifacts, idempotency_key,
          create_fingerprint, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13, $14, $14)
       ON CONFLICT (publisher, pack_key, version) DO NOTHING`,
      [
        packId,
        manifest.packKey,
        manifest.publisher,
        manifest.version,
        manifest.displayName,
        manifest.description,
        manifest.compatibility.minPlatform,
        manifest.compatibility.maxPlatform,
        JSON.stringify(manifest.requiredPacks),
        JSON.stringify(manifest.artifacts),
        row.idempotencyKey,
        row.createFingerprint,
        row.createdBy,
        now,
      ],
    );
    if (result.rowCount !== 1) return 'taken';
    const created = await this.getDomainPackVersion(packId);
    if (created === null) {
      throw new Error(`published domain pack version ${packId} could not be read back`);
    }
    return created;
  }

  async getDomainPackVersion(packId: string): Promise<DomainPackRegistryRecord | null> {
    const result = await this.db.query<DomainPackRegistryRow>(
      `${PACK_SELECT} WHERE pack_id = $1`,
      [packId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRegistryRecord(row);
  }

  /**
   * The registry row for an EXACT (publisher, pack_key, version) triple —
   * the dependency-resolution lookup (null when that version is not
   * published).
   */
  async findDomainPackVersion(
    publisher: string,
    packKey: string,
    version: string,
  ): Promise<DomainPackRegistryRecord | null> {
    const result = await this.db.query<DomainPackRegistryRow>(
      `${PACK_SELECT} WHERE publisher = $1 AND pack_key = $2 AND version = $3`,
      [publisher, packKey, version],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRegistryRecord(row);
  }

  async listDomainPackVersions(packKey: string | null): Promise<readonly DomainPackRegistryRecord[]> {
    const clauses: string[] = [];
    const params: (string | null)[] = [];
    if (packKey !== null) {
      params.push(packKey);
      clauses.push(`pack_key = $${params.length}`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.db.query<DomainPackRegistryRow>(
      `${PACK_SELECT} ${where} ORDER BY created_at DESC, pack_id LIMIT 500`,
      params,
    );
    return result.rows.map(toRegistryRecord);
  }

  /**
   * Inserts one install AND materializes the artifact scope records —
   * ONE ATOMIC TRANSACTION (the install and its artifacts are a single
   * durable fact; a failed materialization rolls the install back).
   * 'taken' means the (workspace, pack version) fence rejected the
   * insert — the version is already installed here.
   */
  async insertDomainPackInstall(row: {
    readonly pack: DomainPackRegistryRecord;
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceId: string;
    readonly idempotencyKey: string;
    readonly createdBy: string | null;
  }): Promise<DomainPackInstallRecord | 'taken'> {
    const installId = this.ids.newId();
    const now = this.clock.nowIso();
    const taken = await this.db.transaction(async (tx) => {
      const result = await tx.query(
        `INSERT INTO domain_pack_installs
           (install_id, pack_id, agency_id, client_id, workspace_id, status,
            idempotency_key, version, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'installed', $6, 1, $7, $8, $8)
         ON CONFLICT (workspace_id, pack_id) DO NOTHING`,
        [
          installId,
          row.pack.packId,
          row.agencyId,
          row.clientId,
          row.workspaceId,
          row.idempotencyKey,
          row.createdBy,
          now,
        ],
      );
      if (result.rowCount !== 1) return true;
      // Materialize one artifact scope record per declared artifact with
      // the §5 explicit distinction resolved against the installing
      // context (domain-pack-v1.3.md §5 / PACK-AC-03).
      for (const artifact of row.pack.manifest.artifacts) {
        const boundary =
          artifact.scope === 'agency-reusable'
            ? { agencyId: row.agencyId, clientId: null, workspaceId: row.workspaceId }
            : { agencyId: row.agencyId, clientId: row.clientId, workspaceId: row.workspaceId };
        await tx.query(
          `INSERT INTO domain_pack_artifacts
             (artifact_id, install_id, pack_id, artifact_kind, artifact_name, scope,
              agency_id, client_id, workspace_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            this.ids.newId(),
            installId,
            row.pack.packId,
            artifact.kind,
            artifact.name,
            artifact.scope,
            boundary.agencyId,
            boundary.clientId,
            boundary.workspaceId,
            now,
          ],
        );
      }
      return false;
    });
    if (taken) return 'taken';
    const created = await this.getDomainPackInstall(installId);
    if (created === null) {
      throw new Error(`inserted domain pack install ${installId} could not be read back`);
    }
    return created;
  }

  async getDomainPackInstall(installId: string): Promise<DomainPackInstallRecord | null> {
    const result = await this.db.query<DomainPackInstallRow>(
      `${INSTALL_SELECT} WHERE install_id = $1`,
      [installId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toInstallRecord(row);
  }

  /**
   * The install of one pack VERSION in one Workspace (null when the
   * version is not installed there) — resolved from durable state.
   */
  async findDomainPackInstall(
    workspaceId: string,
    packId: string,
  ): Promise<DomainPackInstallRecord | null> {
    const result = await this.db.query<DomainPackInstallRow>(
      `${INSTALL_SELECT} WHERE workspace_id = $1 AND pack_id = $2`,
      [workspaceId, packId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toInstallRecord(row);
  }

  async listDomainPackInstalls(workspaceId: string): Promise<readonly DomainPackInstallRecord[]> {
    const result = await this.db.query<DomainPackInstallRow>(
      `${INSTALL_SELECT} WHERE workspace_id = $1
       ORDER BY created_at DESC, install_id LIMIT 500`,
      [workspaceId],
    );
    return result.rows.map(toInstallRecord);
  }

  /** Locks the install row (FOR UPDATE) and returns it — CAS serialized. */
  async lockDomainPackInstall(
    tx: DbTransaction,
    installId: string,
  ): Promise<DomainPackInstallRecord | null> {
    const result = await tx.query<DomainPackInstallRow>(
      `${INSTALL_SELECT} WHERE install_id = $1 FOR UPDATE`,
      [installId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toInstallRecord(row);
  }

  /**
   * CAS lifecycle transition on the CALLER'S transaction (the row was
   * locked there). The immutability + lifecycle triggers are the final
   * backstops.
   */
  async updateDomainPackInstall(
    tx: DbTransaction,
    input: {
      readonly installId: string;
      readonly status: DomainPackInstallStatus;
      readonly expectedVersion: number;
    },
  ): Promise<{ readonly updated: DomainPackInstallRecord } | 'not-found' | 'version-conflict'> {
    const now = this.clock.nowIso();
    const uninstalledAt = input.status === 'uninstalled' ? now : null;
    // RETURNING reads the updated row INSIDE the same transaction (an
    // out-of-band read-back on another pooled connection could not see
    // the uncommitted change under READ COMMITTED).
    const result = await tx.query<DomainPackInstallRow>(
      `UPDATE domain_pack_installs
         SET status = $1, uninstalled_at = $2, version = version + 1, updated_at = $3
       WHERE install_id = $4 AND version = $5
       RETURNING install_id, pack_id, agency_id, client_id, workspace_id, status,
                 idempotency_key, version, created_by, uninstalled_at, created_at, updated_at`,
      [input.status, uninstalledAt, now, input.installId, input.expectedVersion],
    );
    if (result.rowCount === 1) return { updated: toInstallRecord(result.rows[0]!) };
    const existing = await tx.query<{ version: number | string }>(
      'SELECT version FROM domain_pack_installs WHERE install_id = $1',
      [input.installId],
    );
    if (existing.rows.length === 0) return 'not-found';
    return 'version-conflict';
  }

  async getDomainPackArtifact(artifactId: string): Promise<DomainPackArtifactRecord | null> {
    const result = await this.db.query<DomainPackArtifactRow>(
      `${ARTIFACT_SELECT} WHERE a.artifact_id = $1`,
      [artifactId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toArtifactRecord(row);
  }

  /**
   * The artifact scope records materialized by the installs of ONE
   * workspace (both scopes — the workspace's own install artifacts).
   */
  async listDomainPackArtifactsForWorkspace(
    workspaceId: string,
  ): Promise<readonly DomainPackArtifactRecord[]> {
    const result = await this.db.query<DomainPackArtifactRow>(
      `${ARTIFACT_SELECT} WHERE a.workspace_id = $1
       ORDER BY a.created_at, a.artifact_id LIMIT 500`,
      [workspaceId],
    );
    return result.rows.map(toArtifactRecord);
  }

  /**
   * The AGENCY-SCOPED REUSABLE surface of one agency — ONLY
   * scope='agency-reusable' records (the §5 explicit distinction as a
   * query: Client-scoped pack-owned data is never aggregated at agency
   * scope).
   */
  async listDomainPackArtifactsForAgency(
    agencyId: string,
  ): Promise<readonly DomainPackArtifactRecord[]> {
    const result = await this.db.query<DomainPackArtifactRow>(
      `${ARTIFACT_SELECT} WHERE a.agency_id = $1 AND a.scope = 'agency-reusable'
       ORDER BY a.created_at, a.artifact_id LIMIT 500`,
      [agencyId],
    );
    return result.rows.map(toArtifactRecord);
  }
}

export { toInstallRecord, toRegistryRecord, toArtifactRecord, type DomainPackInstallRow, type DomainPackRegistryRow, type DomainPackArtifactRow };
