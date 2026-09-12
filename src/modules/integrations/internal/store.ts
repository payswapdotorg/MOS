/**
 * /integrations persistence (integration_connections + integration_events
 * tables, migration 029) — with database backstops:
 *
 *   - CONNECTIONS: operational lifecycle state with CAS transitions. The
 *     identity/content columns (client ownership, adapter key, provider
 *     label, credential reference, provider config, provenance) are
 *     IMMUTABLE (trigger); only the lifecycle columns (status, health,
 *     rate-limit state, last error, last check, version, updated_at) ever
 *     change, and the transition trigger enforces the frozen
 *     INTEGRATION_CONNECTION_TRANSITIONS table at the storage layer. The
 *     (client, adapter_key, credential_reference) fence makes duplicate
 *     registration converge to a constraint violation (ConflictError),
 *     never a silent second pipe;
 *   - EVENTS: append-only — UPDATE and DELETE are rejected by triggers
 *     (the migration 015/018/025 pattern), so this store can only INSERT
 *     and SELECT them. Provenance columns are written exclusively from
 *     the server-built IntegrationProvenance argument; received_at is
 *     stamped by the module clock — there is no other write path.
 *
 * The §21 secret-leak guard runs on every payload BEFORE insert: provider
 * config and event payloads are checked against material-shaped keys —
 * connections reference credentials by LOGICAL NAME only, and nothing
 * secret can enter any integration record.
 */

import {
  ConflictError,
  InvalidRequestError,
  NotFoundError,
} from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  IntegrationAdapter,
  IntegrationCapability,
  IntegrationConnectionHealth,
  IntegrationConnectionRecord,
  IntegrationConnectionStatus,
  IntegrationIngestedEventRecord,
  IntegrationProvenance,
  NormalizedRateLimit,
  RegisteredAdapterInfo,
} from '../public.ts';
import { INTEGRATION_CAPABILITY_KINDS } from '../public.ts';

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface ConnectionRow extends DbRow {
  connection_id: string;
  client_id: string;
  agency_id: string;
  adapter_key: string;
  provider_label: string;
  status: string;
  health: string;
  credential_reference_id: string;
  provider_config: unknown;
  rate_limit: unknown;
  last_error: string | null;
  last_checked_at: Date | null;
  created_by: string | null;
  version: string | number;
  created_at: Date;
  updated_at: Date;
}

interface EventRow extends DbRow {
  event_id: string;
  connection_id: string;
  client_id: string;
  adapter_key: string;
  event_type: string;
  payload: unknown;
  evidence_ref: string | null;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  received_at: Date;
}

const CONNECTION_SELECT = `
  SELECT c.connection_id, c.client_id, c.agency_id, c.adapter_key, c.provider_label,
         c.status, c.health, c.credential_reference_id, c.provider_config, c.rate_limit,
         c.last_error, c.last_checked_at, c.created_by, c.version, c.created_at, c.updated_at
  FROM integration_connections c
`;

const EVENT_SELECT = `
  SELECT e.event_id, e.connection_id, e.client_id, e.adapter_key, e.event_type,
         e.payload, e.evidence_ref, e.recorded_actor, e.recorded_via,
         e.correlation_id, e.causation_id, e.received_at
  FROM integration_events e
`;

// ---------------------------------------------------------------------------
// Bounded shape constants (mirrored by the migration CHECKs)
// ---------------------------------------------------------------------------

const MAX_ADAPTER_KEY_LENGTH = 64;
const MAX_PROVIDER_LABEL_LENGTH = 100;
const MAX_DESCRIPTOR_TEXT_LENGTH = 2000;
const MAX_CAPABILITY_KEY_LENGTH = 64;
const MAX_OPERATIONS_PER_CAPABILITY = 32;
const MAX_OPERATION_LENGTH = 64;
const MAX_PROVIDER_CONFIG_KEYS = 32;
const MAX_CONFIG_VALUE_LENGTH = 512;
const MAX_EVENT_TYPE_LENGTH = 128;
const MAX_EVENT_PAYLOAD_KEYS = 64;
const MAX_EVENT_HEADERS_KEYS = 32;
const MAX_REASON_LENGTH = 2000;
const MAX_LAST_ERROR_LENGTH = 2000;

/**
 * Material-shaped key denylist (implementation-contract §21 — the §21
 * storage-side half of the credential-by-logical-name contract). Mirrors
 * POLICY_MATERIAL_SHAPED_KEYS from /policies.
 */
const INTEGRATION_MATERIAL_SHAPED_KEYS: readonly string[] = [
  'secret',
  'secretMaterial',
  'material',
  'password',
  'token',
  'apiKey',
  'api_key',
  'accessKey',
  'secretHandle',
];

/** Deep material-key walk (the §21 backstop — pure). */
export function containsMaterialShapedKey(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some((entry) => containsMaterialShapedKey(entry));
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (INTEGRATION_MATERIAL_SHAPED_KEYS.includes(key)) return true;
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
 * Pure adapter-registration guard at the first-party registration surface:
 * the module never registers an adapter whose descriptor or capabilities
 * violate the frozen shapes — bounded provider-neutral identifiers, the
 * closed capability-kind set, non-empty bounded operation lists, unique
 * capability keys, and unique operations within each capability.
 */
export function assertValidAdapterRegistration(adapter: IntegrationAdapter): string[] {
  const problems: string[] = [];
  const label = `adapter '${String(adapter?.descriptor?.adapterKey)}'`;

  if (adapter === null || typeof adapter !== 'object') {
    return [`${label}: must be an object implementing IntegrationAdapter`];
  }
  if (typeof adapter.descriptor?.adapterKey !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(adapter.descriptor.adapterKey)) {
    problems.push(`${label}.descriptor.adapterKey: must be 1..64 chars, lowercase alphanumerics/dashes`);
  }
  if (typeof adapter.descriptor?.providerLabel !== 'string' || adapter.descriptor.providerLabel.trim() === '' || adapter.descriptor.providerLabel.length > MAX_PROVIDER_LABEL_LENGTH) {
    problems.push(`${label}.descriptor.providerLabel: must be 1..${MAX_PROVIDER_LABEL_LENGTH} characters`);
  }
  if (typeof adapter.descriptor?.description !== 'string' || adapter.descriptor.description.length > MAX_DESCRIPTOR_TEXT_LENGTH) {
    problems.push(`${label}.descriptor.description: must be at most ${MAX_DESCRIPTOR_TEXT_LENGTH} characters`);
  }
  if (typeof adapter.capabilities !== 'object' || !Array.isArray(adapter.capabilities) || adapter.capabilities.length === 0) {
    problems.push(`${label}.capabilities: a non-empty capability list is required`);
    return problems;
  }
  if (adapter.capabilities.length > 32) {
    problems.push(`${label}.capabilities: at most 32 capabilities per adapter`);
  }

  const seenCapabilityKeys = new Set<string>();
  for (const [index, capability] of adapter.capabilities.entries()) {
    const capabilityLabel = `${label}.capabilities[${index}]`;
    const problem = validateCapability(capability, capabilityLabel);
    if (problem !== null) {
      problems.push(problem);
      continue;
    }
    if (seenCapabilityKeys.has(capability.capabilityKey)) {
      problems.push(`${capabilityLabel}: duplicate capabilityKey '${capability.capabilityKey}'`);
    }
    seenCapabilityKeys.add(capability.capabilityKey);
  }
  return problems;
}

function validateCapability(
  capability: IntegrationCapability,
  label: string,
): string | null {
  if (capability === null || typeof capability !== 'object') {
    return `${label}: must be an object`;
  }
  if (typeof capability.capabilityKey !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(capability.capabilityKey)) {
    return `${label}.capabilityKey: must be 1..${MAX_CAPABILITY_KEY_LENGTH} chars, lowercase alphanumerics/dashes`;
  }
  if (!(INTEGRATION_CAPABILITY_KINDS as readonly string[]).includes(capability.kind)) {
    return `${label}.kind: must be one of read/mutation/webhook`;
  }
  if (typeof capability.description !== 'string' || capability.description.length > MAX_DESCRIPTOR_TEXT_LENGTH) {
    return `${label}.description: must be at most ${MAX_DESCRIPTOR_TEXT_LENGTH} characters`;
  }
  if (!Array.isArray(capability.operations) || capability.operations.length === 0) {
    return `${label}.operations: a non-empty operation list is required`;
  }
  if (capability.operations.length > MAX_OPERATIONS_PER_CAPABILITY) {
    return `${label}.operations: at most ${MAX_OPERATIONS_PER_CAPABILITY} operations per capability`;
  }
  const seen = new Set<string>();
  for (const operation of capability.operations) {
    if (typeof operation !== 'string' || operation.trim() === '' || operation.length > MAX_OPERATION_LENGTH) {
      return `${label}.operations: operation labels must be 1..${MAX_OPERATION_LENGTH} characters`;
    }
    if (seen.has(operation)) {
      return `${label}.operations: duplicate operation label '${operation}'`;
    }
    seen.add(operation);
  }
  return null;
}

/**
 * The pure registry builder: validates every injected adapter and maps
 * them by adapterKey. Duplicate keys or malformed registrations throw
 * InvalidRequestError — the first-party registration surface fails
 * construction loudly (never silently drops an adapter). The registry is
 * DATA: a map keyed by the adapter key, with no provider branches.
 */
export function buildAdapterRegistry(
  adapters: readonly IntegrationAdapter[],
): ReadonlyMap<string, IntegrationAdapter> {
  const registry = new Map<string, IntegrationAdapter>();
  const problems: string[] = [];
  for (const adapter of adapters) {
    problems.push(...assertValidAdapterRegistration(adapter));
    const key = adapter?.descriptor?.adapterKey;
    if (typeof key === 'string') {
      if (registry.has(key)) {
        problems.push(`adapter '${key}': duplicate adapterKey registration`);
      } else {
        registry.set(key, adapter);
      }
    }
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('Invalid first-party adapter registration', problems);
  }
  return registry;
}

/**
 * Pure connection-registration guard: bounded identifiers, string→string
 * provider config with NO material-shaped key anywhere (§21 — the
 * connection references its credential by logical name; nothing secret
 * can ride in through the config).
 */
export function assertValidConnectionRegistration(input: {
  readonly clientId: string;
  readonly adapterKey: string;
  readonly credentialReferenceId: string;
  readonly providerConfig: Readonly<Record<string, string>>;
}): void {
  const problems: string[] = [];
  if (typeof input.clientId !== 'string' || input.clientId.trim() === '') {
    problems.push('clientId: a non-empty Client identifier is required');
  }
  if (typeof input.adapterKey !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.adapterKey)) {
    problems.push(`adapterKey: must be 1..${MAX_ADAPTER_KEY_LENGTH} chars, lowercase alphanumerics/dashes`);
  }
  if (typeof input.credentialReferenceId !== 'string' || input.credentialReferenceId.trim() === '') {
    problems.push('credentialReferenceId: a non-empty credential reference (the logical name) is required');
  }
  if (!isStringRecord(input.providerConfig)) {
    problems.push('providerConfig: must be an object of string key → string value');
  } else {
    const entries = Object.entries(input.providerConfig);
    if (entries.length > MAX_PROVIDER_CONFIG_KEYS) {
      problems.push(`providerConfig: at most ${MAX_PROVIDER_CONFIG_KEYS} configuration keys`);
    }
    for (const [key, value] of entries) {
      if (INTEGRATION_MATERIAL_SHAPED_KEYS.includes(key)) {
        problems.push(`providerConfig.${key}: material-shaped configuration key is forbidden (§21)`);
      }
      if (value.length > MAX_CONFIG_VALUE_LENGTH) {
        problems.push(`providerConfig.${key}: values must be at most ${MAX_CONFIG_VALUE_LENGTH} characters`);
      }
    }
    if (containsMaterialShapedKey(input.providerConfig)) {
      problems.push('providerConfig: material-shaped keys are forbidden at every level (§21)');
    }
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('Invalid connection registration', problems);
  }
}

/**
 * Pure provenance guard (fail-closed by rejection): incomplete server-
 * derived provenance never reaches the durable records.
 */
export function assertValidProvenance(provenance: IntegrationProvenance): void {
  const problems: string[] = [];
  if (typeof provenance.actor !== 'string' || provenance.actor.trim() === '') {
    problems.push('provenance.actor: a non-empty server-derived actor label is required');
  }
  if (typeof provenance.recordedVia !== 'string' || provenance.recordedVia.trim() === '' || provenance.recordedVia.length > 100) {
    problems.push('provenance.recordedVia: a recording surface label of 1..100 characters is required');
  }
  if (typeof provenance.correlationId !== 'string' || provenance.correlationId.trim() === '') {
    problems.push('provenance.correlationId: a correlation identity is required');
  }
  if (provenance.causationId !== null && (typeof provenance.causationId !== 'string' || provenance.causationId.trim() === '')) {
    problems.push('provenance.causationId: must be a non-empty identifier or null');
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('Invalid server-derived provenance', problems);
  }
}

/**
 * Pure webhook-ingestion guard: bounded event type, a non-empty JSON
 * object payload with NO material-shaped key (§21 — provider payloads
 * ride in as data, never as a secret channel), bounded string→string
 * headers.
 */
export function assertValidWebhookIngestion(input: {
  readonly connectionId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly headers: Readonly<Record<string, string>>;
}): void {
  const problems: string[] = [];
  if (typeof input.connectionId !== 'string' || input.connectionId.trim() === '') {
    problems.push('connectionId: a non-empty connection identifier is required');
  }
  if (typeof input.eventType !== 'string' || input.eventType.trim() === '' || input.eventType.length > MAX_EVENT_TYPE_LENGTH) {
    problems.push(`eventType: must be 1..${MAX_EVENT_TYPE_LENGTH} characters`);
  }
  if (input.payload === null || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
    problems.push('payload: must be a JSON object');
  } else {
    const keys = Object.keys(input.payload);
    if (keys.length === 0) {
      problems.push('payload: a non-empty JSON object is required');
    }
    if (keys.length > MAX_EVENT_PAYLOAD_KEYS) {
      problems.push(`payload: at most ${MAX_EVENT_PAYLOAD_KEYS} top-level keys`);
    }
    if (containsMaterialShapedKey(input.payload)) {
      problems.push('payload: material-shaped keys are forbidden at every level (§21)');
    }
  }
  if (input.headers === null || typeof input.headers !== 'object' || Array.isArray(input.headers)) {
    problems.push('headers: must be an object of header name → value');
  } else {
    const entries = Object.entries(input.headers);
    if (entries.length > MAX_EVENT_HEADERS_KEYS) {
      problems.push(`headers: at most ${MAX_EVENT_HEADERS_KEYS} delivery headers`);
    }
    for (const [key, value] of entries) {
      if (key.trim() === '' || key.length > 128) {
        problems.push('headers: header names must be 1..128 characters');
      }
      if (typeof value !== 'string' || value.length > 2048) {
        problems.push('headers: header values must be strings of at most 2048 characters');
      }
    }
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('Invalid webhook delivery', problems);
  }
}

// ---------------------------------------------------------------------------
// Write-conflict classification (the policies pattern)
// ---------------------------------------------------------------------------

const CONNECTION_FENCE_PATTERNS: ReadonlyArray<{ readonly pattern: RegExp; readonly label: string }> = [
  { pattern: /integration_connections_client_adapter_credential_fence/, label: 'duplicate-connection' },
  { pattern: /uq_integration_connections/, label: 'duplicate-connection' },
];

/**
 * Classifies a connection write failure into a deterministic conflict
 * label (null when the error is not a known fence violation) — concurrent
 * duplicate registrations converge to a ConflictError, never a silent
 * overwrite.
 */
export function classifyIntegrationWriteConflict(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  for (const fence of CONNECTION_FENCE_PATTERNS) {
    if (fence.pattern.test(error.message)) return fence.label;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface ConnectionInsertRow {
  readonly clientId: string;
  readonly agencyId: string;
  readonly adapterKey: string;
  readonly providerLabel: string;
  readonly credentialReferenceId: string;
  readonly providerConfig: Readonly<Record<string, string>>;
  readonly createdBy: string | null;
}

export interface ConnectionLifecyclePatch {
  readonly status: IntegrationConnectionStatus;
  readonly health: IntegrationConnectionHealth;
  readonly rateLimit: NormalizedRateLimit | null;
  readonly lastError: string | null;
}

export interface EventInsertRow {
  readonly eventId: string;
  readonly connectionId: string;
  readonly clientId: string;
  readonly adapterKey: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly evidenceRef: string | null;
}

export class IntegrationsStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  /**
   * The provider-call bookkeeping update: row-locked, NO expected-version
   * gate (the health/rate-limit state of the pipe is last-writer-wins
   * among concurrent calls — the version still CAS-bumps so callers see
   * the row changed). Only lifecycle columns change; the DB trigger still
   * enforces transition legality (same-status updates are legal — they
   * are bookkeeping, not transitions).
   */
  async applyCallBookkeeping(
    connectionId: string,
    patch: ConnectionLifecyclePatch,
  ): Promise<IntegrationConnectionRecord> {
    const now = this.clock.nowIso();
    return this.db.transaction(async (tx) => {
      const locked = await tx.query<ConnectionRow>(
        `${CONNECTION_SELECT} WHERE c.connection_id = $1 FOR UPDATE`,
        [connectionId],
      );
      const current = locked.rows[0];
      if (current === undefined) {
        throw new NotFoundError('integration connection', connectionId);
      }
      await tx.query(
        `UPDATE integration_connections
         SET status = $1, health = $2, rate_limit = $3::jsonb, last_error = $4,
             last_checked_at = $5, version = version + 1, updated_at = $5
         WHERE connection_id = $6`,
        [
          patch.status,
          patch.health,
          patch.rateLimit === null ? null : JSON.stringify(patch.rateLimit),
          patch.lastError === null ? null : patch.lastError.slice(0, MAX_LAST_ERROR_LENGTH),
          now,
          connectionId,
        ],
      );
      const readBack = await tx.query<ConnectionRow>(
        `${CONNECTION_SELECT} WHERE c.connection_id = $1`,
        [connectionId],
      );
      const updated = readBack.rows[0];
      if (updated === undefined) {
        throw new Error(`bookkept connection ${connectionId} could not be read back`);
      }
      return toConnectionRecord(updated);
    });
  }

  /** Appends one connection row (born 'registered', health 'unknown'). */
  async insertConnection(row: ConnectionInsertRow): Promise<IntegrationConnectionRecord> {
    const connectionId = this.ids.newId();
    const now = this.clock.nowIso();
    await this.db.query(
      `INSERT INTO integration_connections (connection_id, client_id, agency_id, adapter_key,
                                    provider_label, status, health, credential_reference_id,
                                    provider_config, rate_limit, last_error, last_checked_at,
                                    created_by, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'registered', 'unknown', $6, $7::jsonb, NULL, NULL, NULL,
               $8, 1, $9, $9)`,
      [
        connectionId,
        row.clientId,
        row.agencyId,
        row.adapterKey,
        row.providerLabel,
        row.credentialReferenceId,
        JSON.stringify(row.providerConfig),
        row.createdBy,
        now,
      ],
    );
    const created = await this.getConnection(connectionId);
    if (created === null) {
      throw new Error(`registered connection ${connectionId} could not be read back`);
    }
    return created;
  }

  async getConnection(connectionId: string): Promise<IntegrationConnectionRecord | null> {
    const result = await this.db.query<ConnectionRow>(
      `${CONNECTION_SELECT} WHERE c.connection_id = $1`,
      [connectionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toConnectionRecord(row);
  }

  /** The Client's connections, newest first (bounded). */
  async listConnectionsForClient(clientId: string): Promise<readonly IntegrationConnectionRecord[]> {
    const result = await this.db.query<ConnectionRow>(
      `${CONNECTION_SELECT} WHERE c.client_id = $1
       ORDER BY c.created_at DESC, c.connection_id LIMIT 200`,
      [clientId],
    );
    return result.rows.map(toConnectionRecord);
  }

  /**
   * The CAS lifecycle transition: row-locked, version-checked, guarded by
   * the frozen transition table (the DB trigger is the race backstop).
   * Returns the updated record or throws ConflictError (stale version or
   * illegal transition).
   */
  async transitionConnection(
    connectionId: string,
    expectedVersion: number,
    patch: ConnectionLifecyclePatch,
  ): Promise<IntegrationConnectionRecord> {
    const now = this.clock.nowIso();
    return this.db.transaction(async (tx) => {
      const locked = await tx.query<ConnectionRow>(
        `${CONNECTION_SELECT} WHERE c.connection_id = $1 FOR UPDATE`,
        [connectionId],
      );
      const current = locked.rows[0];
      if (current === undefined) {
        throw new NotFoundError('integration connection', connectionId);
      }
      if (Number(current.version) !== expectedVersion) {
        throw new ConflictError(
          `connection ${connectionId} was modified concurrently (expected version ${expectedVersion}, found ${current.version})`,
        );
      }
      await tx.query(
        `UPDATE integration_connections
         SET status = $1, health = $2, rate_limit = $3::jsonb, last_error = $4,
             last_checked_at = $5, version = version + 1, updated_at = $5
         WHERE connection_id = $6`,
        [
          patch.status,
          patch.health,
          patch.rateLimit === null ? null : JSON.stringify(patch.rateLimit),
          patch.lastError === null ? null : patch.lastError.slice(0, MAX_LAST_ERROR_LENGTH),
          now,
          connectionId,
        ],
      );
      const readBack = await tx.query<ConnectionRow>(
        `${CONNECTION_SELECT} WHERE c.connection_id = $1`,
        [connectionId],
      );
      const updated = readBack.rows[0];
      if (updated === undefined) {
        throw new Error(`transitioned connection ${connectionId} could not be read back`);
      }
      return toConnectionRecord(updated);
    });
  }

  /**
   * The append-only ingestion ledger row (the only write path). The
   * module pre-allocates the event identity (the derived /evidence
   * source reference carries it) BEFORE the evidence append, so a
   * read-back is always complete.
   */
  async insertEvent(
    row: EventInsertRow,
    provenance: IntegrationProvenance,
  ): Promise<IntegrationIngestedEventRecord> {
    const receivedAt = this.clock.nowIso();
    await this.db.query(
      `INSERT INTO integration_events (event_id, connection_id, client_id, adapter_key,
                                  event_type, payload, evidence_ref,
                                  recorded_actor, recorded_via, correlation_id, causation_id,
                                  received_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12)`,
      [
        row.eventId,
        row.connectionId,
        row.clientId,
        row.adapterKey,
        row.eventType,
        JSON.stringify(row.payload),
        row.evidenceRef,
        provenance.actor,
        provenance.recordedVia,
        provenance.correlationId,
        provenance.causationId,
        receivedAt,
      ],
    );
    const created = await this.getEvent(row.eventId);
    if (created === null) {
      throw new Error(`ingested event ${row.eventId} could not be read back`);
    }
    return created;
  }

  async getEvent(eventId: string): Promise<IntegrationIngestedEventRecord | null> {
    const result = await this.db.query<EventRow>(
      `${EVENT_SELECT} WHERE e.event_id = $1`,
      [eventId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toEventRecord(row);
  }

  /** The Client's ingested events, newest first (bounded). */
  async listEventsForClient(clientId: string): Promise<readonly IntegrationIngestedEventRecord[]> {
    const result = await this.db.query<EventRow>(
      `${EVENT_SELECT} WHERE e.client_id = $1
       ORDER BY e.received_at DESC, e.event_id LIMIT 500`,
      [clientId],
    );
    return result.rows.map(toEventRecord);
  }
}

// ---------------------------------------------------------------------------
// Registry view
// ---------------------------------------------------------------------------

/** The data view of one registered adapter (descriptor + capabilities). */
export function toRegisteredAdapterInfo(adapter: IntegrationAdapter): RegisteredAdapterInfo {
  return {
    descriptor: adapter.descriptor,
    capabilities: adapter.capabilities,
  };
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function toConnectionRecord(row: ConnectionRow): IntegrationConnectionRecord {
  return {
    connectionId: row.connection_id,
    clientId: row.client_id,
    agencyId: row.agency_id,
    adapterKey: row.adapter_key,
    providerLabel: row.provider_label,
    status: row.status as IntegrationConnectionStatus,
    health: row.health as IntegrationConnectionHealth,
    credentialReferenceId: row.credential_reference_id,
    providerConfig: (row.provider_config ?? {}) as Record<string, string>,
    rateLimit: row.rate_limit === null || row.rate_limit === undefined
      ? null
      : (row.rate_limit as NormalizedRateLimit),
    lastError: row.last_error,
    lastCheckedAt: row.last_checked_at === null ? null : row.last_checked_at.toISOString(),
    createdBy: row.created_by,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toEventRecord(row: EventRow): IntegrationIngestedEventRecord {
  return {
    eventId: row.event_id,
    connectionId: row.connection_id,
    clientId: row.client_id,
    adapterKey: row.adapter_key,
    eventType: row.event_type,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    evidenceRef: row.evidence_ref,
    provenance: {
      actor: row.recorded_actor,
      recordedVia: row.recorded_via,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      receivedAt: row.received_at.toISOString(),
    },
  };
}

/** Bounded length for administrative suspend reasons (module guard). */
export const MAX_SUSPEND_REASON_LENGTH = MAX_REASON_LENGTH;
