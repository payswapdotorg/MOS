/**
 * /social-commerce-attribution persistence (MKT-073 — the
 * migration-069 tables).
 *
 * Owns EXACTLY the six own tables:
 *
 *   social_attribution_references,
 *   social_attribution_link_constructions,
 *   social_attribution_attachments,
 *   social_attribution_provider_crossings,
 *   social_attribution_conversion_events,
 *   social_attribution_outcomes.
 *
 * NO AUTHORITY TRANSFER / NO SHADOWING: no mission, experiment,
 * evidence, metric, catalog, order, listing, price or inventory table
 * is written or joined here; no /growth-missions,
 * /cross-platform-distribution, /commerce-discovery, /integrations,
 * /metrics or /evidence table is written either — the mission,
 * carrier, experiment-arm, commerce-event and store-connection
 * citations are OPAQUE recorded data (the family by-reference
 * discipline; FK anchors point ONLY at the tenant tables + same-module
 * rows).
 *
 * The link constructions, attachments, conversion events and outcomes
 * are APPEND-ONLY OUTRIGHT (the DB triggers reject UPDATE/DELETE);
 * the references carry the SINGLE guarded active → retired advance
 * and the crossings the SINGLE guarded dispatched → echoed/dropped
 * advance (the DB guard triggers are the backstops). Every read is
 * CLIENT-scoped (the uniform tenant fence; the module resolves
 * foreign/unknown scope to the uniform NotFound — no existence
 * oracle).
 */

import type { DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  SocialAttributionAttachmentRecord,
  SocialAttributionConversionEventRecord,
  SocialAttributionConversionKind,
  SocialAttributionConversionSource,
  SocialAttributionCrossingRecord,
  SocialAttributionCrossingStatus,
  SocialAttributionLinkConstructionRecord,
  SocialAttributionOutcomeRecord,
  SocialAttributionOutcomeReadModelRow,
  SocialAttributionReferenceRecord,
  SocialAttributionReferenceStatus,
  SocialCommerceAttributionRecordedProvenance,
} from '../public.ts';
import {
  SOCIAL_COMMERCE_ATTRIBUTION_CONTRACT_VERSION,
  SOCIAL_COMMERCE_ATTRIBUTION_VOCABULARY_VERSION,
  SOCIAL_ATTRIBUTION_CO_OCCURRENCE_NOTE,
} from '../public.ts';
import { asConstructibleMechanism } from './link-core.ts';

// ---------------------------------------------------------------------------
// Row shapes (snake_case as returned by PostgreSQL)
// ---------------------------------------------------------------------------

interface ReferenceRow extends DbRow {
  attribution_reference_id: string;
  mission_id: string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  attribution_ref: string;
  identity_digest: string;
  mechanism: string;
  purpose: string;
  creation_context: unknown;
  status: string;
  retired_reason: string | null;
  contract_version: string;
  vocabulary_version: string;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface LinkConstructionRow extends DbRow {
  link_construction_id: string;
  attribution_reference_id: string;
  construction_version: string;
  mechanism: string;
  construction_input: unknown;
  input_digest: string;
  constructed_link: string;
  match_field: string;
  match_value: string;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
}

interface AttachmentRow extends DbRow {
  attachment_id: string;
  attribution_reference_id: string;
  carrier_kind: string;
  carrier_ref: string;
  original_content_ref: string;
  carried_content_refs: unknown;
  reason: string;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
}

interface CrossingRow extends DbRow {
  crossing_id: string;
  attribution_reference_id: string;
  link_construction_id: string;
  provider_key: string;
  payload_field: string;
  dispatched_value: string;
  crossing_state: string;
  echo_value: string | null;
  echo_observed_at: Date | null;
  advance_reason: string | null;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ConversionEventRow extends DbRow {
  conversion_event_id: string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  conversion_kind: string;
  event_source: string;
  commerce_event_id: string | null;
  store_connection_id: string | null;
  provider_event_id: string | null;
  subject_ref: string | null;
  occurred_at: Date | null;
  observed_at: Date;
  observed_fields: unknown;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
}

interface OutcomeRow extends DbRow {
  attribution_outcome_id: string;
  conversion_event_id: string;
  attribution_reference_id: string;
  link_construction_id: string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  mechanism: string;
  matched_field: string;
  matched_value: string;
  match_provenance: unknown;
  co_occurrence_note: string;
  flowback_citation: unknown;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// The row mappers
// ---------------------------------------------------------------------------

function jsonbObject(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function jsonbStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function provenanceOf(row: DbRow): SocialCommerceAttributionRecordedProvenance {
  return {
    actor: String(row['recorded_actor']),
    recordedVia: String(row['recorded_via']),
    correlationId: String(row['correlation_id']),
    causationId: row['causation_id'] === null ? null : String(row['causation_id']),
    recordedAt: (row['created_at'] as Date).toISOString(),
  };
}

function provenancePayload(
  provenance: { actor: string; recordedVia: string; correlationId: string; causationId: string | null },
): [string, string, string, string | null] {
  return [provenance.actor, provenance.recordedVia, provenance.correlationId, provenance.causationId];
}

export function mapReferenceRow(r: ReferenceRow): SocialAttributionReferenceRecord {
  return {
    attributionReferenceId: r.attribution_reference_id,
    missionId: r.mission_id,
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    attributionRef: r.attribution_ref,
    identityDigest: r.identity_digest,
    mechanism: r.mechanism as SocialAttributionReferenceRecord['mechanism'],
    purpose: r.purpose,
    creationContext: jsonbObject(r.creation_context),
    status: r.status as SocialAttributionReferenceStatus,
    retiredReason: r.retired_reason,
    contractVersion: r.contract_version,
    vocabularyVersion: r.vocabulary_version,
    provenance: provenanceOf(r),
  };
}

export function mapLinkConstructionRow(r: LinkConstructionRow): SocialAttributionLinkConstructionRecord {
  return {
    linkConstructionId: r.link_construction_id,
    attributionReferenceId: r.attribution_reference_id,
    constructionVersion: r.construction_version,
    mechanism: asConstructibleMechanism(r.mechanism)!,
    constructionInput: jsonbObject(r.construction_input),
    inputDigest: r.input_digest,
    constructedLink: r.constructed_link,
    matchField: r.match_field as SocialAttributionLinkConstructionRecord['matchField'],
    matchValue: r.match_value,
    provenance: provenanceOf(r),
  };
}

export function mapAttachmentRow(r: AttachmentRow): SocialAttributionAttachmentRecord {
  return {
    attachmentId: r.attachment_id,
    attributionReferenceId: r.attribution_reference_id,
    carrierKind: r.carrier_kind as SocialAttributionAttachmentRecord['carrierKind'],
    carrierRef: r.carrier_ref,
    originalContentRef: r.original_content_ref,
    carriedContentRefs: jsonbStringArray(r.carried_content_refs),
    reason: r.reason,
    provenance: provenanceOf(r),
  };
}

export function mapCrossingRow(r: CrossingRow): SocialAttributionCrossingRecord {
  return {
    crossingId: r.crossing_id,
    attributionReferenceId: r.attribution_reference_id,
    linkConstructionId: r.link_construction_id,
    providerKey: r.provider_key,
    payloadField: r.payload_field,
    dispatchedValue: r.dispatched_value,
    crossingState: r.crossing_state as SocialAttributionCrossingStatus,
    echoValue: r.echo_value,
    echoObservedAt: r.echo_observed_at === null ? null : r.echo_observed_at.toISOString(),
    advanceReason: r.advance_reason,
    provenance: provenanceOf(r),
  };
}

export function mapConversionEventRow(r: ConversionEventRow): SocialAttributionConversionEventRecord {
  return {
    conversionEventId: r.conversion_event_id,
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    conversionKind: r.conversion_kind as SocialAttributionConversionKind,
    eventSource: r.event_source as SocialAttributionConversionSource,
    commerceEventId: r.commerce_event_id,
    storeConnectionId: r.store_connection_id,
    providerEventId: r.provider_event_id,
    subjectRef: r.subject_ref,
    occurredAt: r.occurred_at === null ? null : r.occurred_at.toISOString(),
    observedAt: r.observed_at.toISOString(),
    observedFields: jsonbObject(r.observed_fields),
    provenance: provenanceOf(r),
  };
}

export function mapOutcomeRow(r: OutcomeRow): SocialAttributionOutcomeRecord {
  return {
    attributionOutcomeId: r.attribution_outcome_id,
    conversionEventId: r.conversion_event_id,
    attributionReferenceId: r.attribution_reference_id,
    linkConstructionId: r.link_construction_id,
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    mechanism: asConstructibleMechanism(r.mechanism)!,
    matchedField: r.matched_field as SocialAttributionOutcomeRecord['matchedField'],
    matchedValue: r.matched_value,
    matchProvenance: jsonbObject(r.match_provenance),
    coOccurrenceNote: r.co_occurrence_note,
    flowbackCitation: jsonbObject(r.flowback_citation),
    provenance: provenanceOf(r),
  };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface ReferenceScopeColumns {
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
}

export class SocialCommerceAttributionStore {
  private readonly db: DbTransaction;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: DbTransaction, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  nowIso(): string {
    return this.clock.nowIso();
  }

  newId(): string {
    return this.ids.newId();
  }

  // --- The references ---

  async insertReference(input: {
    readonly referenceId: string;
    readonly scope: ReferenceScopeColumns;
    readonly missionId: string;
    readonly attributionRef: string;
    readonly identityDigest: string;
    readonly mechanism: string;
    readonly purpose: string;
    readonly creationContext: Readonly<Record<string, unknown>>;
    readonly provenance: { actor: string; recordedVia: string; correlationId: string; causationId: string | null };
  }): Promise<ReferenceRow> {
    const now = this.nowIso();
    const [actor, via, correlation, causation] = provenancePayload(input.provenance);
    const inserted = await this.db.query<ReferenceRow>(
      `INSERT INTO social_attribution_references
         (attribution_reference_id, mission_id, agency_id, client_id, workspace_id,
          attribution_ref, identity_digest, mechanism, purpose, creation_context,
          status, retired_reason, contract_version, vocabulary_version,
          recorded_actor, recorded_via, correlation_id, causation_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb,
               'active', NULL, $11, $12, $13, $14, $15, $16, $17::timestamptz, $17::timestamptz)
       ON CONFLICT (identity_digest) DO NOTHING
       RETURNING *`,
      [
        input.referenceId,
        input.missionId,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId,
        input.attributionRef,
        input.identityDigest,
        input.mechanism,
        input.purpose,
        JSON.stringify(input.creationContext),
        SOCIAL_COMMERCE_ATTRIBUTION_CONTRACT_VERSION,
        SOCIAL_COMMERCE_ATTRIBUTION_VOCABULARY_VERSION,
        actor,
        via,
        correlation,
        causation,
        now,
      ],
    );
    if (inserted.rows[0] !== undefined) return inserted.rows[0];
    // The idempotence convergence: the same canonical inputs derive the
    // same identity digest — the existing reference row is the honest
    // replay result.
    const converged = await this.db.query<ReferenceRow>(
      `SELECT * FROM social_attribution_references WHERE identity_digest = $1`,
      [input.identityDigest],
    );
    return converged.rows[0]!;
  }

  async findReference(attributionReferenceId: string): Promise<ReferenceRow | null> {
    const r = await this.db.query<ReferenceRow>(
      `SELECT * FROM social_attribution_references WHERE attribution_reference_id = $1`,
      [attributionReferenceId],
    );
    return r.rows[0] ?? null;
  }

  async listReferencesForMission(missionId: string): Promise<ReadonlyArray<ReferenceRow>> {
    const r = await this.db.query<ReferenceRow>(
      `SELECT * FROM social_attribution_references WHERE mission_id = $1
        ORDER BY created_at, attribution_reference_id`,
      [missionId],
    );
    return r.rows;
  }

  async listReferencesForClient(clientId: string): Promise<ReadonlyArray<ReferenceRow>> {
    const r = await this.db.query<ReferenceRow>(
      `SELECT * FROM social_attribution_references WHERE client_id = $1
        ORDER BY created_at DESC, attribution_reference_id`,
      [clientId],
    );
    return r.rows;
  }

  async retireReference(
    attributionReferenceId: string,
    reason: string,
    provenance: { actor: string; recordedVia: string; correlationId: string; causationId: string | null },
  ): Promise<ReferenceRow | null> {
    void provenance;
    const now = this.nowIso();
    const r = await this.db.query<ReferenceRow>(
      `UPDATE social_attribution_references
          SET status = 'retired', retired_reason = $2, updated_at = $3::timestamptz
        WHERE attribution_reference_id = $1 AND status = 'active'
        RETURNING *`,
      [attributionReferenceId, reason, now],
    );
    return r.rows[0] ?? null;
  }

  // --- The link constructions ---

  async insertLinkConstruction(input: {
    readonly linkConstructionId: string;
    readonly attributionReferenceId: string;
    readonly scope: ReferenceScopeColumns;
    readonly mechanism: string;
    readonly constructionInput: Readonly<Record<string, unknown>>;
    readonly inputDigest: string;
    readonly constructedLink: string;
    readonly matchField: string;
    readonly matchValue: string;
    readonly provenance: { actor: string; recordedVia: string; correlationId: string; causationId: string | null };
  }): Promise<LinkConstructionRow> {
    const now = this.nowIso();
    const [actor, via, correlation, causation] = provenancePayload(input.provenance);
    const inserted = await this.db.query<LinkConstructionRow>(
      `INSERT INTO social_attribution_link_constructions
         (link_construction_id, attribution_reference_id, agency_id, client_id, workspace_id,
          construction_version, mechanism, construction_input, input_digest,
          constructed_link, match_field, match_value,
          recorded_actor, recorded_via, correlation_id, causation_id, created_at)
       VALUES ($1, $2, $3, $4, $5, 'sca-link-v1', $6, $7::jsonb, $8, $9, $10, $11,
               $12, $13, $14, $15, $16::timestamptz)
       ON CONFLICT (attribution_reference_id, input_digest) DO NOTHING
       RETURNING *`,
      [
        input.linkConstructionId,
        input.attributionReferenceId,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId,
        input.mechanism,
        JSON.stringify(input.constructionInput),
        input.inputDigest,
        input.constructedLink,
        input.matchField,
        input.matchValue,
        actor,
        via,
        correlation,
        causation,
        now,
      ],
    );
    if (inserted.rows[0] !== undefined) return inserted.rows[0];
    const converged = await this.db.query<LinkConstructionRow>(
      `SELECT * FROM social_attribution_link_constructions
        WHERE attribution_reference_id = $1 AND input_digest = $2`,
      [input.attributionReferenceId, input.inputDigest],
    );
    return converged.rows[0]!;
  }

  async listLinkConstructionsForReference(
    attributionReferenceId: string,
  ): Promise<ReadonlyArray<LinkConstructionRow>> {
    const r = await this.db.query<LinkConstructionRow>(
      `SELECT * FROM social_attribution_link_constructions
        WHERE attribution_reference_id = $1
        ORDER BY created_at, link_construction_id`,
      [attributionReferenceId],
    );
    return r.rows;
  }

  async findLinkConstruction(linkConstructionId: string): Promise<LinkConstructionRow | null> {
    const r = await this.db.query<LinkConstructionRow>(
      `SELECT * FROM social_attribution_link_constructions WHERE link_construction_id = $1`,
      [linkConstructionId],
    );
    return r.rows[0] ?? null;
  }

  // --- The attachments ---

  async insertAttachment(input: {
    readonly attachmentId: string;
    readonly attributionReferenceId: string;
    readonly scope: ReferenceScopeColumns;
    readonly carrierKind: string;
    readonly carrierRef: string;
    readonly originalContentRef: string;
    readonly carriedContentRefs: readonly string[];
    readonly reason: string;
    readonly provenance: { actor: string; recordedVia: string; correlationId: string; causationId: string | null };
  }): Promise<AttachmentRow> {
    const now = this.nowIso();
    const [actor, via, correlation, causation] = provenancePayload(input.provenance);
    const r = await this.db.query<AttachmentRow>(
      `INSERT INTO social_attribution_attachments
         (attachment_id, attribution_reference_id, agency_id, client_id, workspace_id,
          carrier_kind, carrier_ref, original_content_ref, carried_content_refs, reason,
          recorded_actor, recorded_via, correlation_id, causation_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10,
               $11, $12, $13, $14, $15::timestamptz)
       RETURNING *`,
      [
        input.attachmentId,
        input.attributionReferenceId,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId,
        input.carrierKind,
        input.carrierRef,
        input.originalContentRef,
        JSON.stringify(input.carriedContentRefs),
        input.reason,
        actor,
        via,
        correlation,
        causation,
        now,
      ],
    );
    return r.rows[0]!;
  }

  async listAttachmentsForReference(
    attributionReferenceId: string,
  ): Promise<ReadonlyArray<AttachmentRow>> {
    const r = await this.db.query<AttachmentRow>(
      `SELECT * FROM social_attribution_attachments
        WHERE attribution_reference_id = $1
        ORDER BY created_at, attachment_id`,
      [attributionReferenceId],
    );
    return r.rows;
  }

  // --- The provider-boundary crossings ---

  async insertCrossing(input: {
    readonly crossingId: string;
    readonly attributionReferenceId: string;
    readonly linkConstructionId: string;
    readonly scope: ReferenceScopeColumns;
    readonly providerKey: string;
    readonly payloadField: string;
    readonly dispatchedValue: string;
    readonly provenance: { actor: string; recordedVia: string; correlationId: string; causationId: string | null };
  }): Promise<CrossingRow> {
    const now = this.nowIso();
    const [actor, via, correlation, causation] = provenancePayload(input.provenance);
    const r = await this.db.query<CrossingRow>(
      `INSERT INTO social_attribution_provider_crossings
         (crossing_id, attribution_reference_id, link_construction_id,
          agency_id, client_id, workspace_id,
          provider_key, payload_field, dispatched_value, crossing_state,
          echo_value, echo_observed_at, advance_reason,
          recorded_actor, recorded_via, correlation_id, causation_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'dispatched',
               NULL, NULL, NULL, $10, $11, $12, $13, $14::timestamptz, $14::timestamptz)
       RETURNING *`,
      [
        input.crossingId,
        input.attributionReferenceId,
        input.linkConstructionId,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId,
        input.providerKey,
        input.payloadField,
        input.dispatchedValue,
        actor,
        via,
        correlation,
        causation,
        now,
      ],
    );
    return r.rows[0]!;
  }

  async findCrossing(crossingId: string): Promise<CrossingRow | null> {
    const r = await this.db.query<CrossingRow>(
      `SELECT * FROM social_attribution_provider_crossings WHERE crossing_id = $1`,
      [crossingId],
    );
    return r.rows[0] ?? null;
  }

  async advanceCrossing(input: {
    readonly crossingId: string;
    readonly toState: 'echoed' | 'dropped';
    readonly echoValue: string | null;
    readonly reason: string;
  }): Promise<CrossingRow | null> {
    const now = this.nowIso();
    const echoedAt = input.toState === 'echoed' ? now : null;
    const r = await this.db.query<CrossingRow>(
      `UPDATE social_attribution_provider_crossings
          SET crossing_state = $2,
              echo_value = $3,
              echo_observed_at = $4::timestamptz,
              advance_reason = $5,
              updated_at = $6::timestamptz
        WHERE crossing_id = $1 AND crossing_state = 'dispatched'
        RETURNING *`,
      [input.crossingId, input.toState, input.echoValue, echoedAt, input.reason, now],
    );
    return r.rows[0] ?? null;
  }

  async listCrossingsForReference(
    attributionReferenceId: string,
  ): Promise<ReadonlyArray<CrossingRow>> {
    const r = await this.db.query<CrossingRow>(
      `SELECT * FROM social_attribution_provider_crossings
        WHERE attribution_reference_id = $1
        ORDER BY created_at, crossing_id`,
      [attributionReferenceId],
    );
    return r.rows;
  }

  // --- The conversion events ---

  async insertConversionEvent(input: {
    readonly conversionEventId: string;
    readonly scope: ReferenceScopeColumns;
    readonly conversionKind: string;
    readonly eventSource: string;
    readonly commerceEventId: string | null;
    readonly storeConnectionId: string | null;
    readonly providerEventId: string | null;
    readonly subjectRef: string | null;
    readonly occurredAt: string | null;
    readonly observedAt: string;
    readonly observedFields: Readonly<Record<string, unknown>>;
    readonly provenance: { actor: string; recordedVia: string; correlationId: string; causationId: string | null };
  }): Promise<ConversionEventRow> {
    const now = this.nowIso();
    const [actor, via, correlation, causation] = provenancePayload(input.provenance);
    const r = await this.db.query<ConversionEventRow>(
      `INSERT INTO social_attribution_conversion_events
         (conversion_event_id, agency_id, client_id, workspace_id,
          conversion_kind, event_source, commerce_event_id, store_connection_id,
          provider_event_id, subject_ref, occurred_at, observed_at, observed_fields,
          recorded_actor, recorded_via, correlation_id, causation_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               $11::timestamptz, $12::timestamptz, $13::jsonb,
               $14, $15, $16, $17, $18::timestamptz)
       RETURNING *`,
      [
        input.conversionEventId,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId,
        input.conversionKind,
        input.eventSource,
        input.commerceEventId,
        input.storeConnectionId,
        input.providerEventId,
        input.subjectRef,
        input.occurredAt,
        input.observedAt,
        JSON.stringify(input.observedFields),
        actor,
        via,
        correlation,
        causation,
        now,
      ],
    );
    return r.rows[0]!;
  }

  async findConversionEvent(conversionEventId: string): Promise<ConversionEventRow | null> {
    const r = await this.db.query<ConversionEventRow>(
      `SELECT * FROM social_attribution_conversion_events WHERE conversion_event_id = $1`,
      [conversionEventId],
    );
    return r.rows[0] ?? null;
  }

  async listConversionEventsForClient(clientId: string): Promise<ReadonlyArray<ConversionEventRow>> {
    const r = await this.db.query<ConversionEventRow>(
      `SELECT * FROM social_attribution_conversion_events
        WHERE client_id = $1
        ORDER BY created_at DESC, conversion_event_id`,
      [clientId],
    );
    return r.rows;
  }

  // --- The outcomes ---

  async insertOutcome(input: {
    readonly outcomeId: string;
    readonly conversionEventId: string;
    readonly attributionReferenceId: string;
    readonly linkConstructionId: string;
    readonly scope: ReferenceScopeColumns;
    readonly mechanism: string;
    readonly matchedField: string;
    readonly matchedValue: string;
    readonly matchProvenance: Readonly<Record<string, unknown>>;
    readonly flowbackCitation: Readonly<Record<string, unknown>>;
    readonly provenance: { actor: string; recordedVia: string; correlationId: string; causationId: string | null };
  }): Promise<OutcomeRow> {
    const now = this.nowIso();
    const [actor, via, correlation, causation] = provenancePayload(input.provenance);
    const r = await this.db.query<OutcomeRow>(
      `INSERT INTO social_attribution_outcomes
         (attribution_outcome_id, conversion_event_id, attribution_reference_id,
          link_construction_id, agency_id, client_id, workspace_id,
          mechanism, matched_field, matched_value, match_provenance,
          co_occurrence_note, flowback_citation,
          recorded_actor, recorded_via, correlation_id, causation_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb,
               $12, $13::jsonb, $14, $15, $16, $17, $18::timestamptz)
       RETURNING *`,
      [
        input.outcomeId,
        input.conversionEventId,
        input.attributionReferenceId,
        input.linkConstructionId,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId,
        input.mechanism,
        input.matchedField,
        input.matchedValue,
        JSON.stringify(input.matchProvenance),
        SOCIAL_ATTRIBUTION_CO_OCCURRENCE_NOTE,
        JSON.stringify(input.flowbackCitation),
        actor,
        via,
        correlation,
        causation,
        now,
      ],
    );
    return r.rows[0]!;
  }

  async listOutcomesForReference(
    attributionReferenceId: string,
  ): Promise<ReadonlyArray<OutcomeRow>> {
    const r = await this.db.query<OutcomeRow>(
      `SELECT * FROM social_attribution_outcomes
        WHERE attribution_reference_id = $1
        ORDER BY created_at, attribution_outcome_id`,
      [attributionReferenceId],
    );
    return r.rows;
  }

  async listOutcomesForMission(missionId: string): Promise<ReadonlyArray<OutcomeRow>> {
    const r = await this.db.query<OutcomeRow>(
      `SELECT o.* FROM social_attribution_outcomes o
        JOIN social_attribution_references r
          ON r.attribution_reference_id = o.attribution_reference_id
       WHERE r.mission_id = $1
       ORDER BY o.created_at, o.attribution_outcome_id`,
      [missionId],
    );
    return r.rows;
  }

  // --- THE FLOWBACK READ MODEL (the cited projection) ---

  async listOutcomeReadModel(clientId: string): Promise<readonly SocialAttributionOutcomeReadModelRow[]> {
    const r = await this.db.query<DbRow>(
      `SELECT o.attribution_outcome_id, o.match_provenance, o.co_occurrence_note, o.created_at,
              c.conversion_event_id, c.conversion_kind, c.event_source,
              c.commerce_event_id, c.observed_at,
              r.attribution_reference_id, r.attribution_ref, r.mechanism, r.mission_id, r.status
         FROM social_attribution_outcomes o
         JOIN social_attribution_conversion_events c
           ON c.conversion_event_id = o.conversion_event_id
         JOIN social_attribution_references r
           ON r.attribution_reference_id = o.attribution_reference_id
        WHERE o.client_id = $1
        ORDER BY o.created_at DESC, o.attribution_outcome_id`,
      [clientId],
    );
    return r.rows.map((row) => ({
      outcomeId: String(row['attribution_outcome_id']),
      conversionEvent: {
        conversionEventId: String(row['conversion_event_id']),
        conversionKind: String(row['conversion_kind']) as SocialAttributionConversionKind,
        eventSource: String(row['event_source']) as SocialAttributionConversionSource,
        commerceEventId: row['commerce_event_id'] === null ? null : String(row['commerce_event_id']),
        observedAt: (row['observed_at'] as Date).toISOString(),
      },
      attributionReference: {
        attributionReferenceId: String(row['attribution_reference_id']),
        attributionRef: String(row['attribution_ref']),
        mechanism: String(row['mechanism']) as SocialAttributionReferenceRecord['mechanism'],
        missionId: String(row['mission_id']),
        status: String(row['status']) as SocialAttributionReferenceStatus,
      },
      matchProvenance: jsonbObject(row['match_provenance']),
      coOccurrenceNote: String(row['co_occurrence_note']),
      recordedAt: (row['created_at'] as Date).toISOString(),
    }));
  }
}
