/**
 * /agents persistence + input guards (MKT-020, AGENT-001).
 *
 * Tables (migration 022): logical_agents, logical_agent_lifecycle_events.
 *
 * DB backstops behind this store (implementation-contract §3, §25):
 *   - logical Agent declared CONTENT is immutable (trigger): identity,
 *     the agent key, the version label, the contract text, the capability
 *     descriptors, the ownership scope, the idempotency identity and the
 *     provenance can never be reassigned — corrections retire + register
 *     a NEW declaration; `retired` is terminal (no second retirement, no
 *     resurrection);
 *   - the §8-style LOGICAL COMMAND fences (per scope): one idempotency
 *     key identifies one logical register command in its scope — a
 *     duplicate of the same command (same create fingerprint) replays to
 *     the existing row; a key reused for a different command is a
 *     conflict, never a silent overwrite;
 *   - the ACTIVE DECLARATION fences (per scope): one ACTIVE declaration
 *     per (scope, agent_key) — race-free under concurrent registration;
 *     retirement frees the key for a NEW identity;
 *   - the capability descriptor SHAPE CHECK: every stored descriptor is
 *     exactly { capabilityKind: string, parameters: object } — a
 *     provider-shaped descriptor can never be persisted, even by direct
 *     SQL;
 *   - the lifecycle events are APPEND-ONLY history (trigger rejects
 *     UPDATE and DELETE), one event per transition per declaration
 *     (UNIQUE (agent_id, transition)) and consistency-checked against the
 *     registry row's current status;
 *   - every mutable row carries a version CAS token (row-locked
 *     transitions).
 *
 * The input guards (exported through the module public entry) are the
 * module-side DTO authority: they validate the provider-neutral
 * declaration shapes AND REJECT provider/model/SDK/credential-shaped keys
 * and infrastructure-coupling keys — at the top level AND at every
 * nesting level of the capability descriptor parameters (the
 * provider-neutrality + no-infrastructure-coupling enforcement for
 * AGENT-001).
 */

import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  AgentCapabilityDescriptor,
  LogicalAgentLifecycleEventRecord,
  LogicalAgentRecord,
  LogicalAgentRegistrationInput,
  LogicalAgentScopeKind,
  LogicalAgentStatus,
} from '../public.ts';
import {
  AGENT_CAPABILITY_DESCRIPTOR_FORBIDDEN_INPUT_KEYS,
  LOGICAL_AGENT_REGISTRATION_FORBIDDEN_INPUT_KEYS,
} from '../public.ts';

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface LogicalAgentRow extends DbRow {
  agent_id: string;
  agent_key: string;
  display_name: string;
  version_label: string;
  description: string;
  capabilities: unknown[];
  agency_id: string | null;
  status: string;
  idempotency_key: string;
  create_fingerprint: string;
  created_by: string | null;
  version: number | string;
  created_at: Date;
  updated_at: Date;
}

interface LifecycleEventRow extends DbRow {
  event_id: string;
  agent_id: string;
  transition: string;
  from_status: string | null;
  to_status: string;
  reason: string;
  created_by: string | null;
  created_at: Date;
}

const LOGICAL_AGENT_SELECT = `
  SELECT agent_id, agent_key, display_name, version_label, description, capabilities,
         agency_id, status, idempotency_key, create_fingerprint, created_by, version,
         created_at, updated_at
  FROM logical_agents
`;

const LIFECYCLE_EVENT_SELECT = `
  SELECT event_id, agent_id, transition, from_status, to_status, reason, created_by, created_at
  FROM logical_agent_lifecycle_events
`;

// ---------------------------------------------------------------------------
// Input guards (pure; exported through the module public entry)
// ---------------------------------------------------------------------------

/** The reusable logical agent name (identity label). */
const AGENT_KEY_PATTERN = /^[a-z][a-z0-9_.-]{1,99}$/;
/** The declared contract version label (e.g. '1.0.0', 'v2-beta'). */
const VERSION_LABEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
/** Normalized capability-kind labels. */
const CAPABILITY_KIND_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
/** Server-generated opaque identifier (UUID). */
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const IDEMPOTENCY_KEY_MAX = 200;
const DISPLAY_NAME_MAX = 200;
const DESCRIPTION_MAX = 2000;
const RETIRE_REASON_MAX = 512;
const CAPABILITIES_MAX_ITEMS = 64;
const CAPABILITY_PARAMETERS_MAX_BYTES = 32_768;
const CAPABILITY_PARAMETERS_MAX_KEYS = 64;
/** Bounded JSON depth for descriptor parameters (defense in depth). */
const CAPABILITY_PARAMETERS_MAX_DEPTH = 8;

/**
 * The deep forbidden-key matcher (lazily composed from the public
 * forbidden-key contracts — the module-registry constants live in the
 * public entry, which re-exports this module's guards, so the set is
 * built on first use, after the circular re-export has settled):
 * provider/model/SDK/credential-shaped and infrastructure-coupling/
 * tenant-data keys can NEVER appear at ANY nesting level of a capability
 * descriptor's parameters — the logical Agent owns no provider
 * selection, no credentials, no infrastructure and no tenant data
 * (architecture.md §12; AGENT-001 provider neutrality). Exact-match
 * (case-insensitive) so legitimate compound keys like 'maxTokens' or
 * 'providerPolicy' are not collaterally rejected.
 */
let nestedForbiddenKeySet: ReadonlySet<string> | null = null;
function nestedForbiddenKeys(): ReadonlySet<string> {
  if (nestedForbiddenKeySet === null) {
    nestedForbiddenKeySet = new Set<string>(
      [
        ...LOGICAL_AGENT_REGISTRATION_FORBIDDEN_INPUT_KEYS,
        ...AGENT_CAPABILITY_DESCRIPTOR_FORBIDDEN_INPUT_KEYS,
        'capabilityKind',
      ].map((key) => key.toLowerCase()),
    );
  }
  return nestedForbiddenKeySet;
}

/** True when `key` is an authority-shaped name forbidden inside parameters. */
export function containsForbiddenCapabilityKey(value: unknown, depth = 0): boolean {
  if (depth > CAPABILITY_PARAMETERS_MAX_DEPTH) return true;
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some((element) => containsForbiddenCapabilityKey(element, depth + 1));
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (nestedForbiddenKeys().has(key.toLowerCase())) return true;
    if (containsForbiddenCapabilityKey(nested, depth + 1)) return true;
  }
  return false;
}

function problem(message: string, details: ReadonlyArray<string>): never {
  throw new InvalidRequestError(message, details);
}

function requireString(value: unknown, field: string, minLength: number, maxLength: number): string {
  if (typeof value !== 'string') problem(`${field} must be a string`, [`${field}: must be a string`]);
  if (value.length < minLength || value.length > maxLength) {
    problem(`${field} length is out of bounds`, [`${field}: must be ${minLength}..${maxLength} characters`]);
  }
  return value;
}

/** Rejects every forbidden authority/neutrality key present on the input object. */
function rejectForbiddenKeys(
  input: object,
  forbidden: ReadonlyArray<string>,
  context: string,
): void {
  for (const key of forbidden) {
    if (key in input) {
      problem(`${context} carries the forbidden key '${key}'`, [
        `${key}: forbidden field; this value is derived server-side or is provider/infrastructure-shaped and must not be supplied`,
      ]);
    }
  }
}

/** Validates the §8-style logical command key (1..200 chars). */
export function assertValidIdempotencyKey(key: string): void {
  requireString(key, 'idempotencyKey', 1, IDEMPOTENCY_KEY_MAX);
}

/** Validates the bounded retire reason (0..512 chars). */
export function assertValidLogicalAgentRetireReason(reason: string): void {
  requireString(reason, 'reason', 0, RETIRE_REASON_MAX);
}

/** Validates ONE capability descriptor (shape + neutrality + bounds). */
function assertValidCapabilityDescriptor(
  descriptor: AgentCapabilityDescriptor,
  index: number,
): void {
  if (
    descriptor === null ||
    typeof descriptor !== 'object' ||
    Array.isArray(descriptor)
  ) {
    problem(`capabilities[${index}] must be an object`, [
      `capabilities[${index}]: must be a capability descriptor object`,
    ]);
  }
  // EXACTLY the two declared keys — a provider/credential/infrastructure
  // or any other extra key is rejected outright.
  const keys = Object.keys(descriptor);
  if (keys.length !== 2 || !('capabilityKind' in descriptor) || !('parameters' in descriptor)) {
    problem(`capabilities[${index}] must carry exactly capabilityKind and parameters`, [
      `capabilities[${index}]: a capability descriptor is exactly { capabilityKind, parameters } — no other keys`,
    ]);
  }
  const kind = (descriptor as AgentCapabilityDescriptor).capabilityKind;
  if (typeof kind !== 'string' || !CAPABILITY_KIND_PATTERN.test(kind)) {
    problem(`capabilities[${index}].capabilityKind is not a normalized label`, [
      `capabilities[${index}].capabilityKind: must be 2..64 chars, lowercase letters/digits/dashes, starting with a letter`,
    ]);
  }
  const parameters = (descriptor as AgentCapabilityDescriptor).parameters;
  if (
    parameters === null ||
    typeof parameters !== 'object' ||
    Array.isArray(parameters)
  ) {
    problem(`capabilities[${index}].parameters must be an object`, [
      `capabilities[${index}].parameters: must be a JSON object`,
    ]);
  }
  const entries = Object.entries(parameters as Record<string, unknown>);
  if (entries.length > CAPABILITY_PARAMETERS_MAX_KEYS) {
    problem(`capabilities[${index}].parameters has too many keys`, [
      `capabilities[${index}].parameters: must carry at most ${CAPABILITY_PARAMETERS_MAX_KEYS} keys`,
    ]);
  }
  const serialized = JSON.stringify(parameters);
  if (serialized.length > CAPABILITY_PARAMETERS_MAX_BYTES) {
    problem(`capabilities[${index}].parameters is too large`, [
      `capabilities[${index}].parameters: serialized size must be at most ${CAPABILITY_PARAMETERS_MAX_BYTES} bytes`,
    ]);
  }
  // THE provider-neutrality + no-infrastructure-coupling guard: no
  // authority-shaped key at ANY nesting level of the parameter contract.
  if (containsForbiddenCapabilityKey(parameters)) {
    problem(`capabilities[${index}].parameters carries a forbidden authority-shaped key`, [
      `capabilities[${index}].parameters: provider/model/SDK/credential, infrastructure-coupling or tenant-data keys can never appear at any nesting level (AGENT-001 provider neutrality)`,
    ]);
  }
}

/**
 * The logical-agent registration input guard (the AGENT-001 module-side
 * authority): validates the declaration contract fields and REJECTS
 * provider/model/SDK/credential-shaped keys, infrastructure-coupling keys
 * and tenant/workflow/execution references — at the top level AND inside
 * every capability descriptor (including every nesting level of the
 * descriptor parameters). The logical Agent is a provider-neutral
 * reusable capability declaration with no infrastructure coupling.
 */
export function assertValidLogicalAgentRegistrationInput(
  agent: LogicalAgentRegistrationInput,
): void {
  rejectForbiddenKeys(agent, LOGICAL_AGENT_REGISTRATION_FORBIDDEN_INPUT_KEYS, 'logical agent registration');

  requireString(agent.agentKey, 'agentKey', 2, 100);
  if (!AGENT_KEY_PATTERN.test(agent.agentKey)) {
    problem('agentKey is not a valid normalized label', [
      'agentKey: must be 2..100 chars, lowercase letters/digits/dots/dashes/underscores, starting with a letter',
    ]);
  }
  requireString(agent.displayName, 'displayName', 1, DISPLAY_NAME_MAX);
  requireString(agent.versionLabel, 'versionLabel', 1, 64);
  if (!VERSION_LABEL_PATTERN.test(agent.versionLabel)) {
    problem('versionLabel is not a valid version label', [
      'versionLabel: must be 1..64 chars of letters, digits, dots, dashes or underscores, starting with an alphanumeric',
    ]);
  }
  requireString(agent.description, 'description', 1, DESCRIPTION_MAX);

  if (!Array.isArray(agent.capabilities)) {
    problem('capabilities must be an array of capability descriptors', [
      'capabilities: must be an array',
    ]);
  }
  if (agent.capabilities.length === 0) {
    problem('capabilities must declare at least one capability', [
      'capabilities: a logical agent declaration carries at least one capability descriptor',
    ]);
  }
  if (agent.capabilities.length > CAPABILITIES_MAX_ITEMS) {
    problem('capabilities has too many items', [
      `capabilities: must contain at most ${CAPABILITIES_MAX_ITEMS} item(s)`,
    ]);
  }
  for (let index = 0; index < agent.capabilities.length; index++) {
    assertValidCapabilityDescriptor(agent.capabilities[index] as AgentCapabilityDescriptor, index);
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class LogicalAgentStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  // ----- Registration ------------------------------------------------------

  /**
   * Insert fenced by the migration-022 unique indexes (the §8-style
   * command fences per scope + the ACTIVE declaration fences per scope).
   * `ON CONFLICT DO NOTHING` without an explicit arbiter skips on ANY of
   * them — the CALLER disambiguates by reading: same command key →
   * replay/conflict; same active (scope, agent_key) → duplicate
   * registration ConflictError.
   */
  async insertAgent(
    tx: DbTransaction,
    input: {
      readonly agent: LogicalAgentRegistrationInput;
      readonly agencyId: string | null;
      readonly idempotencyKey: string;
      readonly createFingerprint: string;
      readonly actorId: string | null;
    },
  ): Promise<LogicalAgentRecord | 'fence'> {
    const agentId = this.ids.newId();
    const now = this.clock.nowIso();
    const result = await tx.query(
      `INSERT INTO logical_agents
         (agent_id, agent_key, display_name, version_label, description, capabilities,
          agency_id, status, idempotency_key, create_fingerprint, created_by, version,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'active', $8, $9, $10, 1, $11, $11)
       ON CONFLICT DO NOTHING`,
      [
        agentId,
        input.agent.agentKey,
        input.agent.displayName,
        input.agent.versionLabel,
        input.agent.description,
        JSON.stringify(input.agent.capabilities),
        input.agencyId,
        input.idempotencyKey,
        input.createFingerprint,
        input.actorId,
        now,
      ],
    );
    if (result.rowCount !== 1) return 'fence';
    // Read back THROUGH the caller's transaction — the insert is not yet
    // committed, so the read-back must share the transaction connection.
    const created = await tx.query<LogicalAgentRow>(
      `${LOGICAL_AGENT_SELECT} WHERE agent_id = $1`,
      [agentId],
    );
    const row = created.rows[0];
    if (row === undefined) {
      throw new Error(`inserted logical agent ${agentId} could not be read back`);
    }
    return toLogicalAgentRecord(row);
  }

  /**
   * The declaration recorded for one logical register command in this
   * scope, or null (the §8-style fence disambiguation lookup).
   */
  async findAgentByCommandKey(
    tx: DbTransaction,
    agencyId: string | null,
    idempotencyKey: string,
  ): Promise<LogicalAgentRecord | null> {
    const result = await tx.query<LogicalAgentRow>(
      `${LOGICAL_AGENT_SELECT}
       WHERE idempotency_key = $1 AND agency_id IS NOT DISTINCT FROM $2
       ORDER BY created_at, agent_id`,
      [idempotencyKey, agencyId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toLogicalAgentRecord(row);
  }

  /**
   * The ACTIVE declaration for one (scope, agent_key), or null (the
   * duplicate-registration fence disambiguation lookup).
   */
  async findActiveAgentByKey(
    tx: DbTransaction,
    agencyId: string | null,
    agentKey: string,
  ): Promise<LogicalAgentRecord | null> {
    const result = await tx.query<LogicalAgentRow>(
      `${LOGICAL_AGENT_SELECT}
       WHERE agent_key = $1 AND agency_id IS NOT DISTINCT FROM $2 AND status = 'active'
       ORDER BY created_at, agent_id`,
      [agentKey, agencyId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toLogicalAgentRecord(row);
  }

  // ----- Reads --------------------------------------------------------------

  async getAgent(agentId: string): Promise<LogicalAgentRecord | null> {
    const result = await this.db.query<LogicalAgentRow>(
      `${LOGICAL_AGENT_SELECT} WHERE agent_id = $1`,
      [agentId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toLogicalAgentRecord(row);
  }

  /**
   * The declarations of one scope, oldest first (retired tombstones
   * included when requested — history stays visible).
   */
  async listAgents(
    agencyId: string | null,
    includeRetired: boolean,
  ): Promise<readonly LogicalAgentRecord[]> {
    const result = await this.db.query<LogicalAgentRow>(
      `${LOGICAL_AGENT_SELECT}
       WHERE agency_id IS NOT DISTINCT FROM $1
         ${includeRetired ? '' : `AND status = 'active'`}
       ORDER BY created_at, agent_id`,
      [agencyId],
    );
    return result.rows.map(toLogicalAgentRecord);
  }

  // ----- Lifecycle ----------------------------------------------------------

  /** Locks the declaration row (FOR UPDATE) and returns it — CAS serialized. */
  async lockAgent(tx: DbTransaction, agentId: string): Promise<LogicalAgentRecord | null> {
    const result = await tx.query<LogicalAgentRow>(
      `${LOGICAL_AGENT_SELECT} WHERE agent_id = $1 FOR UPDATE`,
      [agentId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toLogicalAgentRecord(row);
  }

  /**
   * CAS lifecycle transition on the CALLER'S transaction (row locked
   * there). The content-immutability and retired-terminal triggers are
   * the final backstops.
   */
  async updateAgentStatus(
    tx: DbTransaction,
    input: {
      readonly agentId: string;
      readonly expectedVersion: number;
    },
  ): Promise<'ok' | 'not-found' | 'version-conflict'> {
    const now = this.clock.nowIso();
    const result = await tx.query(
      `UPDATE logical_agents
       SET status = 'retired', version = version + 1, updated_at = $1
       WHERE agent_id = $2 AND version = $3`,
      [now, input.agentId, input.expectedVersion],
    );
    if (result.rowCount === 1) return 'ok';
    const existing = await tx.query<{ version: number }>(
      'SELECT version FROM logical_agents WHERE agent_id = $1',
      [input.agentId],
    );
    if (existing.rows.length === 0) return 'not-found';
    return 'version-conflict';
  }

  // ----- Lifecycle history (append-only) -------------------------------------

  /**
   * Appends one lifecycle history row on the CALLER'S transaction. The
   * legality/consistency trigger backstops the pair; the append-only
   * trigger makes the row immutable history; the (agent_id, transition)
   * unique fence makes a second retirement impossible.
   */
  async insertLifecycleEvent(
    tx: DbTransaction,
    input: {
      readonly agentId: string;
      readonly transition: 'registered' | 'retired';
      readonly fromStatus: LogicalAgentStatus | null;
      readonly toStatus: LogicalAgentStatus;
      readonly reason: string;
      readonly actorId: string | null;
    },
  ): Promise<void> {
    const eventId = this.ids.newId();
    const result = await tx.query(
      `INSERT INTO logical_agent_lifecycle_events
         (event_id, agent_id, transition, from_status, to_status, reason, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (agent_id, transition) DO NOTHING`,
      [
        eventId,
        input.agentId,
        input.transition,
        input.fromStatus,
        input.toStatus,
        input.reason,
        input.actorId,
        this.clock.nowIso(),
      ],
    );
    if (result.rowCount !== 1) {
      // The once-per-transition fence fired: a replayed registration or a
      // second retirement. Registration replays never reach this path
      // (the command fence converges earlier); a retirement replay is the
      // terminal-state ConflictError the module already raised. This is
      // the belt-and-suspenders backstop for direct module misuse.
      throw new Error(
        `lifecycle event ${input.transition} for logical agent ${input.agentId} was already recorded`,
      );
    }
  }

  /** The append-only lifecycle history of one declaration, oldest first. */
  async listLifecycleEvents(agentId: string): Promise<readonly LogicalAgentLifecycleEventRecord[]> {
    const result = await this.db.query<LifecycleEventRow>(
      `${LIFECYCLE_EVENT_SELECT} WHERE agent_id = $1 ORDER BY created_at, event_id`,
      [agentId],
    );
    return result.rows.map(toLifecycleEventRecord);
  }
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function toLogicalAgentRecord(row: LogicalAgentRow): LogicalAgentRecord {
  const agencyId = row.agency_id;
  const scopeKind: LogicalAgentScopeKind = agencyId === null ? 'platform' : 'agency';
  return {
    agentId: row.agent_id,
    agentKey: row.agent_key,
    displayName: row.display_name,
    versionLabel: row.version_label,
    description: row.description,
    capabilities: (row.capabilities ?? []) as readonly AgentCapabilityDescriptor[],
    scopeKind,
    agencyId,
    status: row.status as LogicalAgentStatus,
    idempotencyKey: row.idempotency_key,
    createFingerprint: row.create_fingerprint,
    createdBy: row.created_by,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toLifecycleEventRecord(row: LifecycleEventRow): LogicalAgentLifecycleEventRecord {
  return {
    eventId: row.event_id,
    agentId: row.agent_id,
    transition: row.transition as 'registered' | 'retired',
    fromStatus: row.from_status === null ? null : (row.from_status as LogicalAgentStatus),
    toStatus: row.to_status as LogicalAgentStatus,
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}

/** Exposed for the module's scope sanity checks (server-derived ids only). */
export const AGENT_SCOPE_ID_PATTERN = ID_PATTERN;
