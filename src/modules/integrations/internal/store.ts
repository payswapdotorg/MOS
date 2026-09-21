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
import { createHash } from 'node:crypto';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  CommerceEventKind,
  CommerceEventOutcome,
  CommerceEventRecord,
  CommerceMutationCapabilityKey,
  CommerceMutationRecord,
  IntegrationAdapter,
  IntegrationCapability,
  IntegrationConnectionHealth,
  IntegrationConnectionRecord,
  IntegrationConnectionStatus,
  IntegrationIngestedEventRecord,
  IntegrationProvenance,
  NormalizedProviderEvent,
  NormalizedRateLimit,
  RegisteredAdapterInfo,
} from '../public.ts';
import {
  COMMERCE_CAPABILITY_KEYS,
  COMMERCE_EVENT_KINDS,
  INTEGRATION_CAPABILITY_KINDS,
} from '../public.ts';

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
  // MKT-071: the 'commerce-' capability namespace is a CLOSED vocabulary —
  // a commerce capability key outside COMMERCE_CAPABILITY_KEYS is rejected
  // (a misspelled commerce capability can never silently register and
  // drift from the commerce contract/migration-049 fences).
  if (
    capability.capabilityKey.startsWith('commerce-') &&
    !(COMMERCE_CAPABILITY_KEYS as readonly string[]).includes(capability.capabilityKey)
  ) {
    return `${label}.capabilityKey: '${capability.capabilityKey}' is not in the frozen commerce capability-key vocabulary`;
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
// MKT-071: the normalized provider event guard + the raw-event hash (pure)
// ---------------------------------------------------------------------------

/** Bounded shape constants (mirrored by the migration-049 CHECKs). */
const MAX_PROVIDER_EVENT_ID_LENGTH = 256;
const MAX_EVENT_SHAPE_VERSION_LENGTH = 64;
const MAX_NORMALIZED_EVENT_KEYS = 64;

/**
 * Pure guard (MKT-071): the normalized provider event a verified delivery
 * carries must be a well-formed commerce event — a bounded provider event
 * identity, an event kind in the frozen COMMERCE_EVENT_KINDS vocabulary, a
 * bounded optional provider record id, a bounded shape version and a
 * non-empty bounded normalized field object with NO material-shaped key
 * (§21 — nothing secret can ride into the commerce event projection
 * through the adapter's normalized shape). Throws InvalidRequestError on
 * any violation (fail-closed by rejection).
 */
export function assertValidNormalizedProviderEvent(event: NormalizedProviderEvent): void {
  const problems: string[] = [];
  if (typeof event.providerEventId !== 'string' || event.providerEventId.trim() === '' || event.providerEventId.length > MAX_PROVIDER_EVENT_ID_LENGTH) {
    problems.push(`providerEvent.providerEventId: must be 1..${MAX_PROVIDER_EVENT_ID_LENGTH} characters`);
  }
  if (!(COMMERCE_EVENT_KINDS as readonly string[]).includes(event.eventKind)) {
    problems.push(`providerEvent.eventKind: must be one of ${COMMERCE_EVENT_KINDS.join('/')}`);
  }
  if (
    event.providerRecordId !== null &&
    (typeof event.providerRecordId !== 'string' || event.providerRecordId.trim() === '' || event.providerRecordId.length > MAX_PROVIDER_EVENT_ID_LENGTH)
  ) {
    problems.push(`providerEvent.providerRecordId: must be null or 1..${MAX_PROVIDER_EVENT_ID_LENGTH} characters`);
  }
  if (typeof event.shapeVersion !== 'string' || event.shapeVersion.trim() === '' || event.shapeVersion.length > MAX_EVENT_SHAPE_VERSION_LENGTH) {
    problems.push(`providerEvent.shapeVersion: must be 1..${MAX_EVENT_SHAPE_VERSION_LENGTH} characters`);
  }
  if (event.normalized === null || typeof event.normalized !== 'object' || Array.isArray(event.normalized)) {
    problems.push('providerEvent.normalized: must be a JSON object');
  } else {
    const keys = Object.keys(event.normalized);
    if (keys.length === 0) {
      problems.push('providerEvent.normalized: a non-empty JSON object is required');
    }
    if (keys.length > MAX_NORMALIZED_EVENT_KEYS) {
      problems.push(`providerEvent.normalized: at most ${MAX_NORMALIZED_EVENT_KEYS} top-level keys`);
    }
    if (containsMaterialShapedKey(event.normalized)) {
      problems.push('providerEvent.normalized: material-shaped keys are forbidden at every level (§21)');
    }
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('Invalid normalized provider event', problems);
  }
}

/**
 * Pure raw-event hash (MKT-071 AC-3 provenance): sha256 hex of the
 * delivered payload's canonical JSON serialization. Deterministic for a
 * given payload object (Node object key insertion order — the same
 * delivery object always hashes identically; distinct payloads hash
 * distinctly).
 */
export function hashWebhookPayload(payload: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

// ---------------------------------------------------------------------------
// Write-conflict classification (the policies pattern)
// ---------------------------------------------------------------------------

const CONNECTION_FENCE_PATTERNS: ReadonlyArray<{ readonly pattern: RegExp; readonly label: string }> = [
  { pattern: /integration_connections_client_adapter_credential_fence/, label: 'duplicate-connection' },
  { pattern: /uq_integration_connections/, label: 'duplicate-connection' },
];

const COMMERCE_EVENT_FENCE_PATTERNS: ReadonlyArray<{ readonly pattern: RegExp; readonly label: string }> = [
  { pattern: /commerce_webhook_event_fences_provider_event_fence/, label: 'duplicate-provider-event' },
];

/**
 * Classifies a commerce webhook ingestion write failure into a
 * deterministic conflict label (null when the error is not a known fence
 * violation) — a concurrent duplicate first-delivery race converges on
 * the 'duplicate-provider-event' label, never a silent second ingest.
 */
export function classifyCommerceEventWriteConflict(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  for (const fence of COMMERCE_EVENT_FENCE_PATTERNS) {
    if (fence.pattern.test(error.message)) return fence.label;
  }
  return null;
}

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

// ---------------------------------------------------------------------------
// MKT-071: commerce rows (migration 049)
// ---------------------------------------------------------------------------

interface CommerceFenceRow extends DbRow {
  fence_id: string;
  adapter_key: string;
  provider_event_id: string;
  connection_id: string;
  client_id: string;
  agency_id: string;
  event_kind: string;
  event_type: string;
  raw_event_hash: string;
  shape_version: string;
  integration_event_id: string;
  evidence_ref: string | null;
  claimed_by_actor: string;
  claimed_via: string;
  correlation_id: string;
  causation_id: string | null;
  claimed_at: Date;
}

interface CommerceEventRow extends DbRow {
  commerce_event_id: string;
  connection_id: string;
  client_id: string;
  agency_id: string;
  adapter_key: string;
  provider_event_id: string;
  event_kind: string;
  event_type: string;
  outcome: string;
  provider_record_id: string | null;
  raw_event_hash: string;
  shape_version: string;
  payload: unknown;
  normalized: unknown;
  integration_event_ref: string | null;
  evidence_ref: string | null;
  duplicate_of: string | null;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  received_at: Date;
}

interface CommerceMutationRow extends DbRow {
  commerce_mutation_id: string;
  connection_id: string;
  client_id: string;
  agency_id: string;
  adapter_key: string;
  capability_key: string;
  operation: string;
  ok: boolean;
  provider_record_id: string | null;
  error: string | null;
  policy_decision_id: string;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  received_at: Date;
}

const COMMERCE_EVENT_SELECT = `
  SELECT ce.commerce_event_id, ce.connection_id, ce.client_id, ce.agency_id,
         ce.adapter_key, ce.provider_event_id, ce.event_kind, ce.event_type,
         ce.outcome, ce.provider_record_id, ce.raw_event_hash, ce.shape_version,
         ce.payload, ce.normalized, ce.integration_event_ref, ce.evidence_ref,
         ce.duplicate_of, ce.recorded_actor, ce.recorded_via,
         ce.correlation_id, ce.causation_id, ce.received_at
  FROM commerce_events ce
`;

const COMMERCE_MUTATION_SELECT = `
  SELECT cm.commerce_mutation_id, cm.connection_id, cm.client_id, cm.agency_id,
         cm.adapter_key, cm.capability_key, cm.operation, cm.ok,
         cm.provider_record_id, cm.error, cm.policy_decision_id,
         cm.recorded_actor, cm.recorded_via, cm.correlation_id,
         cm.causation_id, cm.received_at
  FROM commerce_mutation_records cm
`;

/** The dedup-fence lookup view of one claimed provider event. */
export interface CommerceWebhookFenceView {
  readonly fenceId: string;
  readonly adapterKey: string;
  readonly providerEventId: string;
  readonly clientId: string;
  readonly agencyId: string;
  readonly eventKind: string;
  readonly eventType: string;
  readonly integrationEventId: string;
  readonly claimedAt: string;
}

/** The one-transaction first-delivery ingestion input (fence + ledger row + projection row). */
export interface CommerceIdentifiedIngestRow {
  readonly fenceId: string;
  readonly commerceEventId: string;
  readonly eventId: string;
  readonly connectionId: string;
  readonly clientId: string;
  readonly agencyId: string;
  readonly adapterKey: string;
  readonly providerEvent: NormalizedProviderEvent;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly rawEventHash: string;
  readonly evidenceRef: string | null;
}

/** The duplicate-received history row input (the honest replay record). */
export interface CommerceDuplicateEventRow {
  readonly commerceEventId: string;
  readonly connectionId: string;
  readonly clientId: string;
  readonly agencyId: string;
  readonly adapterKey: string;
  readonly providerEvent: NormalizedProviderEvent;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly rawEventHash: string;
  readonly duplicateOf: string;
}

/** The commerce mutation ledger row input. */
export interface CommerceMutationInsertRow {
  readonly connectionId: string;
  readonly clientId: string;
  readonly agencyId: string;
  readonly adapterKey: string;
  readonly capabilityKey: CommerceMutationCapabilityKey;
  readonly operation: string;
  readonly ok: boolean;
  readonly providerRecordId: string | null;
  readonly error: string | null;
  readonly policyDecisionId: string;
}

/**
 * Serializes one normalized rate-limit state for the durable row: the
 * DB CHECK (integration_connections_rate_limit_valid →
 * integration_rate_limit_valid) accepts null, or an object whose PRESENT
 * keys are exactly the closed contract with correctly typed values —
 * a JSON null VALUE for a present key fails the type test. The module
 * contract (NormalizedRateLimit) models "not observed" as null FIELDS;
 * the durable shape models it as ABSENT keys (only the observed values
 * are stored). The read-back casts the row jsonb back — an absent key
 * and a null field are the same "not observed" answer for every
 * consumer (§20: the state is advisory operational metadata).
 */
function serializeRateLimitForStorage(rateLimit: NormalizedRateLimit): string {
  const durable: Record<string, number | string> = {};
  if (rateLimit.limitRemaining !== null) durable['limitRemaining'] = rateLimit.limitRemaining;
  if (rateLimit.limitResetAt !== null) durable['limitResetAt'] = rateLimit.limitResetAt;
  if (rateLimit.backoffUntil !== null) durable['backoffUntil'] = rateLimit.backoffUntil;
  if (rateLimit.retryAfterSeconds !== null) durable['retryAfterSeconds'] = rateLimit.retryAfterSeconds;
  return JSON.stringify(durable);
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
          patch.rateLimit === null ? null : serializeRateLimitForStorage(patch.rateLimit),
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
          patch.rateLimit === null ? null : serializeRateLimitForStorage(patch.rateLimit),
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

  // -------------------------------------------------------------------------
  // MKT-071: the commerce webhook dedup fence + event projection + ledger
  // -------------------------------------------------------------------------

  /** The dedup-fence lookup: the claim of one (provider, provider event id), or null. */
  async findCommerceWebhookFence(
    adapterKey: string,
    providerEventId: string,
  ): Promise<CommerceWebhookFenceView | null> {
    const result = await this.db.query<CommerceFenceRow>(
      `SELECT f.fence_id, f.adapter_key, f.provider_event_id, f.connection_id,
              f.client_id, f.agency_id, f.event_kind, f.event_type,
              f.integration_event_id, f.claimed_at
       FROM commerce_webhook_event_fences f
       WHERE f.adapter_key = $1 AND f.provider_event_id = $2`,
      [adapterKey, providerEventId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      fenceId: row.fence_id,
      adapterKey: row.adapter_key,
      providerEventId: row.provider_event_id,
      clientId: row.client_id,
      agencyId: row.agency_id,
      eventKind: row.event_kind,
      eventType: row.event_type,
      integrationEventId: row.integration_event_id,
      claimedAt: row.claimed_at.toISOString(),
    };
  }

  /**
   * The ingested commerce event row a fence claim owns (the duplicate's
   * duplicate_of target), or null.
   */
  async findIngestedCommerceEventByProviderEvent(
    adapterKey: string,
    providerEventId: string,
  ): Promise<CommerceEventRecord | null> {
    const result = await this.db.query<CommerceEventRow>(
      `${COMMERCE_EVENT_SELECT}
       WHERE ce.adapter_key = $1 AND ce.provider_event_id = $2 AND ce.outcome = 'ingested'`,
      [adapterKey, providerEventId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toCommerceEventRecord(row);
  }

  /**
   * The FIRST-DELIVERY ingestion: the fence claim + the raw-ledger append
   * + the 'ingested' projection row in ONE transaction (all three are
   * module-owned rows — the claim is atomic with the append it fences).
   * A concurrent duplicate first delivery loses the fence (unique
   * violation → the whole transaction rolls back → 'duplicate' is
   * returned with the WINNING fence view; the caller then records the
   * honest duplicate-received history row).
   */
  async ingestIdentifiedCommerceEvent(
    row: CommerceIdentifiedIngestRow,
    provenance: IntegrationProvenance,
  ): Promise<
    | { readonly kind: 'first'; readonly event: IntegrationIngestedEventRecord; readonly commerceEvent: CommerceEventRecord }
    | { readonly kind: 'duplicate'; readonly existing: CommerceWebhookFenceView }
  > {
    const receivedAt = this.clock.nowIso();
    try {
      return await this.db.transaction(async (tx) => {
        // Insert order (the FK wiring): the raw-ledger row FIRST, then the
        // fence that claims it, then the projection row that references
        // both — all inside ONE transaction (the claim is atomic with the
        // append it fences).
        await tx.query(
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
        await tx.query(
          `INSERT INTO commerce_webhook_event_fences (fence_id, adapter_key, provider_event_id,
                                                  connection_id, client_id, agency_id,
                                                  event_kind, event_type, raw_event_hash,
                                                  shape_version, integration_event_id, evidence_ref,
                                                  claimed_by_actor, claimed_via, correlation_id,
                                                  causation_id, claimed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
          [
            row.fenceId,
            row.adapterKey,
            row.providerEvent.providerEventId,
            row.connectionId,
            row.clientId,
            row.agencyId,
            row.providerEvent.eventKind,
            row.eventType,
            row.rawEventHash,
            row.providerEvent.shapeVersion,
            row.eventId,
            row.evidenceRef,
            provenance.actor,
            provenance.recordedVia,
            provenance.correlationId,
            provenance.causationId,
            receivedAt,
          ],
        );
        await tx.query(
          `INSERT INTO commerce_events (commerce_event_id, connection_id, client_id, agency_id,
                                    adapter_key, provider_event_id, event_kind, event_type,
                                    outcome, provider_record_id, raw_event_hash, shape_version,
                                    payload, normalized, integration_event_ref, evidence_ref,
                                    duplicate_of, recorded_actor, recorded_via, correlation_id,
                                    causation_id, received_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ingested', $9, $10, $11, $12::jsonb, $13::jsonb,
                   $14, $15, NULL, $16, $17, $18, $19, $20)`,
          [
            row.commerceEventId,
            row.connectionId,
            row.clientId,
            row.agencyId,
            row.adapterKey,
            row.providerEvent.providerEventId,
            row.providerEvent.eventKind,
            row.eventType,
            row.providerEvent.providerRecordId,
            row.rawEventHash,
            row.providerEvent.shapeVersion,
            JSON.stringify(row.payload),
            JSON.stringify(row.providerEvent.normalized),
            row.eventId,
            row.evidenceRef,
            provenance.actor,
            provenance.recordedVia,
            provenance.correlationId,
            provenance.causationId,
            receivedAt,
          ],
        );
        return {
          kind: 'first' as const,
          event: {
            eventId: row.eventId,
            connectionId: row.connectionId,
            clientId: row.clientId,
            adapterKey: row.adapterKey,
            eventType: row.eventType,
            payload: row.payload,
            evidenceRef: row.evidenceRef,
            provenance: {
              actor: provenance.actor,
              recordedVia: provenance.recordedVia,
              correlationId: provenance.correlationId,
              causationId: provenance.causationId,
              receivedAt,
            },
          },
          commerceEvent: {
            commerceEventId: row.commerceEventId,
            connectionId: row.connectionId,
            clientId: row.clientId,
            agencyId: row.agencyId,
            adapterKey: row.adapterKey,
            providerEventId: row.providerEvent.providerEventId,
            eventKind: row.providerEvent.eventKind,
            eventType: row.eventType,
            outcome: 'ingested' as const,
            providerRecordId: row.providerEvent.providerRecordId,
            rawEventHash: row.rawEventHash,
            shapeVersion: row.providerEvent.shapeVersion,
            payload: row.payload,
            normalized: row.providerEvent.normalized,
            integrationEventRef: row.eventId,
            evidenceRef: row.evidenceRef,
            duplicateOf: null,
            provenance: {
              actor: provenance.actor,
              recordedVia: provenance.recordedVia,
              correlationId: provenance.correlationId,
              causationId: provenance.causationId,
              receivedAt,
            },
          },
        };
      });
    } catch (error) {
      if (classifyCommerceEventWriteConflict(error) !== null) {
        // The concurrent duplicate race: the fence was already claimed —
        // surface the winner so the caller records the honest
        // duplicate-received history row.
        const existing = await this.findCommerceWebhookFence(row.adapterKey, row.providerEvent.providerEventId);
        if (existing !== null) {
          return { kind: 'duplicate', existing };
        }
      }
      throw error;
    }
  }

  /**
   * The REPLAY record: the honest 'duplicate-received' history row —
   * a no-op for state (nothing in the raw ledger, nothing in evidence,
   * no second fence claim) that surfaces in the event history instead of
   * silently dropping the delivery.
   */
  async insertDuplicateCommerceEvent(
    row: CommerceDuplicateEventRow,
    provenance: IntegrationProvenance,
  ): Promise<CommerceEventRecord> {
    const receivedAt = this.clock.nowIso();
    await this.db.query(
      `INSERT INTO commerce_events (commerce_event_id, connection_id, client_id, agency_id,
                                  adapter_key, provider_event_id, event_kind, event_type,
                                  outcome, provider_record_id, raw_event_hash, shape_version,
                                  payload, normalized, integration_event_ref, evidence_ref,
                                  duplicate_of, recorded_actor, recorded_via, correlation_id,
                                  causation_id, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'duplicate-received', $9, $10, $11, $12::jsonb,
               $13::jsonb, NULL, NULL, $14, $15, $16, $17, $18, $19)`,
      [
        row.commerceEventId,
        row.connectionId,
        row.clientId,
        row.agencyId,
        row.adapterKey,
        row.providerEvent.providerEventId,
        row.providerEvent.eventKind,
        row.eventType,
        row.providerEvent.providerRecordId,
        row.rawEventHash,
        row.providerEvent.shapeVersion,
        JSON.stringify(row.payload),
        JSON.stringify(row.providerEvent.normalized),
        row.duplicateOf,
        provenance.actor,
        provenance.recordedVia,
        provenance.correlationId,
        provenance.causationId,
        receivedAt,
      ],
    );
    const created = await this.getCommerceEvent(row.commerceEventId);
    if (created === null) {
      throw new Error(`duplicate commerce event ${row.commerceEventId} could not be read back`);
    }
    return created;
  }

  /** One commerce event history row by id (null = unknown). */
  async getCommerceEvent(commerceEventId: string): Promise<CommerceEventRecord | null> {
    const result = await this.db.query<CommerceEventRow>(
      `${COMMERCE_EVENT_SELECT} WHERE ce.commerce_event_id = $1`,
      [commerceEventId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toCommerceEventRecord(row);
  }

  /** The Client's commerce event history, newest first (bounded). */
  async listCommerceEventsForClient(clientId: string): Promise<readonly CommerceEventRecord[]> {
    const result = await this.db.query<CommerceEventRow>(
      `${COMMERCE_EVENT_SELECT} WHERE ce.client_id = $1
       ORDER BY ce.received_at DESC, ce.commerce_event_id LIMIT 500`,
      [clientId],
    );
    return result.rows.map(toCommerceEventRecord);
  }

  /**
   * The append-only commerce mutation ledger row (the audit surface of
   * store mutations that flowed through this boundary — matrix boundary
   * rule 8).
   */
  async insertCommerceMutationRecord(
    row: CommerceMutationInsertRow,
    provenance: IntegrationProvenance,
  ): Promise<CommerceMutationRecord> {
    const commerceMutationId = this.ids.newId();
    const receivedAt = this.clock.nowIso();
    await this.db.query(
      `INSERT INTO commerce_mutation_records (commerce_mutation_id, connection_id, client_id,
                                           agency_id, adapter_key, capability_key, operation,
                                           ok, provider_record_id, error, policy_decision_id,
                                           recorded_actor, recorded_via, correlation_id,
                                           causation_id, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        commerceMutationId,
        row.connectionId,
        row.clientId,
        row.agencyId,
        row.adapterKey,
        row.capabilityKey,
        row.operation,
        row.ok,
        row.providerRecordId,
        row.error === null ? null : row.error.slice(0, MAX_LAST_ERROR_LENGTH),
        row.policyDecisionId,
        provenance.actor,
        provenance.recordedVia,
        provenance.correlationId,
        provenance.causationId,
        receivedAt,
      ],
    );
    const readBack = await this.db.query<CommerceMutationRow>(
      `${COMMERCE_MUTATION_SELECT} WHERE cm.commerce_mutation_id = $1`,
      [commerceMutationId],
    );
    const created = readBack.rows[0];
    if (created === undefined) {
      throw new Error(`commerce mutation record ${commerceMutationId} could not be read back`);
    }
    return toCommerceMutationRecord(created);
  }

  /** The Client's commerce mutation ledger, newest first (bounded). */
  async listCommerceMutationsForClient(clientId: string): Promise<readonly CommerceMutationRecord[]> {
    const result = await this.db.query<CommerceMutationRow>(
      `${COMMERCE_MUTATION_SELECT} WHERE cm.client_id = $1
       ORDER BY cm.received_at DESC, cm.commerce_mutation_id LIMIT 500`,
      [clientId],
    );
    return result.rows.map(toCommerceMutationRecord);
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

function toCommerceEventRecord(row: CommerceEventRow): CommerceEventRecord {
  return {
    commerceEventId: row.commerce_event_id,
    connectionId: row.connection_id,
    clientId: row.client_id,
    agencyId: row.agency_id,
    adapterKey: row.adapter_key,
    providerEventId: row.provider_event_id,
    eventKind: row.event_kind as CommerceEventKind,
    eventType: row.event_type,
    outcome: row.outcome as CommerceEventOutcome,
    providerRecordId: row.provider_record_id,
    rawEventHash: row.raw_event_hash,
    shapeVersion: row.shape_version,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    normalized: (row.normalized ?? {}) as Record<string, unknown>,
    integrationEventRef: row.integration_event_ref,
    evidenceRef: row.evidence_ref,
    duplicateOf: row.duplicate_of,
    provenance: {
      actor: row.recorded_actor,
      recordedVia: row.recorded_via,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      receivedAt: row.received_at.toISOString(),
    },
  };
}

function toCommerceMutationRecord(row: CommerceMutationRow): CommerceMutationRecord {
  return {
    commerceMutationId: row.commerce_mutation_id,
    connectionId: row.connection_id,
    clientId: row.client_id,
    agencyId: row.agency_id,
    adapterKey: row.adapter_key,
    capabilityKey: row.capability_key as CommerceMutationCapabilityKey,
    operation: row.operation,
    ok: row.ok,
    providerRecordId: row.provider_record_id,
    error: row.error,
    policyDecisionId: row.policy_decision_id,
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
