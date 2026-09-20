/**
 * /notification-delivery input guards + the pure adapter-registration and
 * idempotency-fence helpers (MKT-068 — the growth-missions-store guard
 * precedent: pure functions, exported through the module public entry so
 * the guard semantics are part of the module contract and unit-testable
 * without a database).
 *
 * Everything in here is PURE: no DB, no clock, no ids — the module core
 * composes these guards around its persistence steps.
 */

import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import {
  isKnownNotificationEventType,
  isKnownNotificationSourceKind,
  isKnownNotificationUrgency,
  NOTIFICATION_DELIVERY_CHANNELS,
  PLUGGABLE_NOTIFICATION_CHANNEL_KEYS,
  type NotificationProvenance,
  type NotificationDeliveryAdapter,
  type NotificationDeliveryChannel,
  type NotificationEventType,
  type NotificationSourceKind,
  type NotificationUrgency,
} from '../public.ts';

// ---------------------------------------------------------------------------
// Bounded shape constants (mirrored by the migration-047 CHECK fences)
// ---------------------------------------------------------------------------

export const MAX_EXPLANATION_LENGTH = 2000;
export const MAX_SOURCE_ID_LENGTH = 256;
export const MAX_REQUIRED_ACTION_LENGTH = 1000;
export const MAX_DEEP_LINK_LENGTH = 500;
export const MAX_OCCURRENCE_KEY_LENGTH = 128;
export const MAX_PROVENANCE_ACTOR_LENGTH = 100;
export const MAX_PROVENANCE_VIA_LENGTH = 100;

/** The occurrence-key grammar (the migration-047 CHECK, mirrored). */
export const OCCURRENCE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * The deep-link grammar: a RELATIVE console route (starts with '/'),
 * bounded, no scheme/host (no '://'), no whitespace — the §14 deep link
 * never carries an absolute URL.
 */
export const DEEP_LINK_PATTERN = /^\/[^\s:]*$/;

// ---------------------------------------------------------------------------
// The idempotency fence key (MKT-068 AC-5 — the pure math)
// ---------------------------------------------------------------------------

/**
 * The DEDUP FENCE KEY of an event occurrence: (source kind, source id,
 * event type, occurrence key) — the exact tuple the migration-047 unique
 * fence backstops. PURE: the same occurrence always composes the same
 * key; ANY differing component is a DIFFERENT occurrence (the
 * idempotency math the unit suite pins: replays collide, distinct
 * occurrences never do).
 */
export function composeNotificationFenceKey(input: {
  readonly sourceKind: NotificationSourceKind;
  readonly sourceId: string;
  readonly eventType: NotificationEventType;
  readonly occurrenceKey: string;
}): string {
  return `${input.sourceKind}\n${input.sourceId}\n${input.eventType}\n${input.occurrenceKey}`;
}

// ---------------------------------------------------------------------------
// The adapter-registration contract (MKT-068 AC-2)
// ---------------------------------------------------------------------------

export interface AdapterRegistrationProblem {
  readonly adapter: string;
  readonly problems: readonly string[];
}

/**
 * PURE validation of one adapter registration against the frozen channel
 * vocabulary: the channel must be an IMPLEMENTED key (in_app | email —
 * the declared-pluggable keys whatsapp/telegram/sms/signal are refused
 * fail-closed until their Work Items move them into the implemented
 * vocabulary), the urgency subset must be non-empty and within the frozen
 * urgency vocabulary, and the event-type subset (when present) must be
 * non-empty and within the frozen event-type vocabulary. Returns every
 * problem found (empty = valid).
 */
export function isValidNotificationAdapterRegistration(
  adapter: NotificationDeliveryAdapter,
): readonly string[] {
  const problems: string[] = [];
  const channel = String((adapter as { channel?: unknown }).channel);

  if (
    !(NOTIFICATION_DELIVERY_CHANNELS as readonly string[]).includes(channel)
  ) {
    if ((PLUGGABLE_NOTIFICATION_CHANNEL_KEYS as readonly string[]).includes(channel)) {
      problems.push(
        `channel '${channel}' is a declared-but-UNIMPLEMENTED pluggable capability key (architecture-v1.6.md §14) — its adapter arrives with a future Work Item, fail-closed until then`,
      );
    } else {
      problems.push(`channel '${channel}' is not a declared delivery channel at all`);
    }
  }

  const urgencies = (adapter as { acceptedUrgencies?: unknown }).acceptedUrgencies;
  if (
    !Array.isArray(urgencies) ||
    urgencies.length === 0 ||
    !urgencies.every((value) => isKnownNotificationUrgency(String(value)))
  ) {
    problems.push(
      'acceptedUrgencies must be a non-empty subset of the frozen urgency vocabulary (routine, important, urgent, critical)',
    );
  }

  const eventTypes = (adapter as { acceptedEventTypes?: unknown }).acceptedEventTypes;
  if (eventTypes !== null && eventTypes !== undefined) {
    if (
      !Array.isArray(eventTypes) ||
      eventTypes.length === 0 ||
      !eventTypes.every((value) => isKnownNotificationEventType(String(value)))
    ) {
      problems.push(
        'acceptedEventTypes must be null (every type) or a non-empty subset of the frozen event-type vocabulary',
      );
    }
  }

  if (typeof adapter.accepts !== 'function' || typeof adapter.deliver !== 'function') {
    problems.push('the adapter must implement accepts() and deliver()');
  }

  return problems;
}

/** The implemented-channel guard (the registration fast path). */
export function isImplementedNotificationChannel(
  channel: string,
): channel is NotificationDeliveryChannel {
  return (NOTIFICATION_DELIVERY_CHANNELS as readonly string[]).includes(channel);
}

// ---------------------------------------------------------------------------
// The delivery-input guard (fail-closed by rejection — before any write)
// ---------------------------------------------------------------------------

/**
 * Validates one delivery input against the frozen vocabularies and the
 * bounded §14 shapes (the migration-047 CHECKs mirrored in pure form so
 * a malformed input NEVER reaches the database). Throws
 * InvalidRequestError with every problem listed — fail-closed by
 * rejection.
 */
export function assertValidNotificationDeliveryInput(input: {
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly eventType: NotificationEventType;
  readonly urgency: NotificationUrgency;
  readonly explanation: string;
  readonly sourceKind: NotificationSourceKind;
  readonly sourceId: string;
  readonly requiredAction: string | null;
  readonly deepLink: string;
  readonly occurrenceKey: string;
}): void {
  const problems: string[] = [];

  if (typeof input.agencyId !== 'string' || input.agencyId.trim() === '') {
    problems.push('agencyId: required (server-derived tenant scope)');
  }
  if (typeof input.clientId !== 'string' || input.clientId.trim() === '') {
    problems.push('clientId: required (server-derived tenant scope)');
  }
  if (input.workspaceId !== null && (typeof input.workspaceId !== 'string' || input.workspaceId.trim() === '')) {
    problems.push('workspaceId: null or a valid workspace id');
  }

  if (!isKnownNotificationEventType(String(input.eventType))) {
    problems.push(
      `eventType '${String(input.eventType)}' is not part of the frozen notification event-type vocabulary (nd-vocab-v1)`,
    );
  }
  if (!isKnownNotificationUrgency(String(input.urgency))) {
    problems.push(
      `urgency '${String(input.urgency)}' is not part of the frozen notification urgency vocabulary (nd-vocab-v1)`,
    );
  }
  if (!isKnownNotificationSourceKind(String(input.sourceKind))) {
    problems.push(
      `sourceKind '${String(input.sourceKind)}' is not part of the frozen notification source-kind vocabulary (nd-vocab-v1)`,
    );
  }

  if (
    typeof input.explanation !== 'string' ||
    input.explanation.trim() === '' ||
    input.explanation.length > MAX_EXPLANATION_LENGTH
  ) {
    problems.push(`explanation: a human-readable explanation of 1..${MAX_EXPLANATION_LENGTH} characters is required`);
  }
  if (
    typeof input.sourceId !== 'string' ||
    input.sourceId.trim() === '' ||
    input.sourceId.length > MAX_SOURCE_ID_LENGTH
  ) {
    problems.push(`sourceId: the producing authority's opaque record id of 1..${MAX_SOURCE_ID_LENGTH} characters`);
  }
  if (input.requiredAction !== null) {
    if (
      typeof input.requiredAction !== 'string' ||
      input.requiredAction.trim() === '' ||
      input.requiredAction.length > MAX_REQUIRED_ACTION_LENGTH
    ) {
      problems.push(`requiredAction: null or a bounded required action of 1..${MAX_REQUIRED_ACTION_LENGTH} characters`);
    }
  }
  if (
    typeof input.deepLink !== 'string' ||
    !DEEP_LINK_PATTERN.test(input.deepLink) ||
    input.deepLink.length > MAX_DEEP_LINK_LENGTH
  ) {
    problems.push(
      `deepLink: a RELATIVE console route (starting with '/', no scheme, no whitespace) of at most ${MAX_DEEP_LINK_LENGTH} characters`,
    );
  }
  if (
    typeof input.occurrenceKey !== 'string' ||
    !OCCURRENCE_KEY_PATTERN.test(input.occurrenceKey)
  ) {
    problems.push(
      `occurrenceKey: the producing authority's occurrence discriminator matching ^[A-Za-z0-9][A-Za-z0-9._:-]{0,${MAX_OCCURRENCE_KEY_LENGTH - 1}}$`,
    );
  }

  if (problems.length > 0) {
    throw new InvalidRequestError('malformed notification delivery input (fail-closed)', problems);
  }
}

/**
 * Validates the SERVER-DERIVED provenance shape (never a request field —
 * the routes build it from the authenticated principal + the ambient
 * correlation context).
 */
export function assertValidNotificationProvenance(
  provenance: NotificationProvenance,
): void {
  const problems: string[] = [];
  if (
    typeof provenance.actor !== 'string' ||
    provenance.actor.trim() === '' ||
    provenance.actor.length > MAX_PROVENANCE_ACTOR_LENGTH
  ) {
    problems.push(`actor: a server-derived actor label of 1..${MAX_PROVENANCE_ACTOR_LENGTH} characters`);
  }
  if (
    typeof provenance.recordedVia !== 'string' ||
    provenance.recordedVia.trim() === '' ||
    provenance.recordedVia.length > MAX_PROVENANCE_VIA_LENGTH
  ) {
    problems.push(`recordedVia: a server-derived surface label of 1..${MAX_PROVENANCE_VIA_LENGTH} characters`);
  }
  if (typeof provenance.correlationId !== 'string' || provenance.correlationId.trim() === '') {
    problems.push('correlationId: required');
  }
  if (
    provenance.causationId !== null &&
    (typeof provenance.causationId !== 'string' || provenance.causationId.trim() === '')
  ) {
    problems.push('causationId: null or a non-empty correlation reference');
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('malformed notification provenance (fail-closed)', problems);
  }
}
