/**
 * /social-commerce-attribution module implementation (MKT-073).
 *
 * THE ORCHESTRATION ONLY: this module composes the
 * SocialCommerceAttributionStore (the migration-069 tables) with the
 * PURE guards of validation.ts, the DETERMINISTIC pure core of
 * link-core.ts (the sca-link-v1 formulas + the co-occurrence matcher —
 * both exported through the public entry) and the THREE declared
 * structural ports (the /growth-missions mission port, the pursuit-
 * scope workspace port and the /integrations commerce-event port — the
 * LAB-013 Arena-port precedent, wired at the composition root over the
 * REAL public-contract instances).
 *
 * THE RECORD FAMILIES, staged exactly:
 *
 *   references        createAttributionReference        (born 'active'; the deterministic identity digest as the idempotence fence)
 *                     retireAttributionReference         (the single guarded active → retired advance)
 *   constructions     constructAttributionLink           (the deterministic pure formula; idempotent per input digest)
 *   attachments       recordAttributionAttachment        (the transformation-survival chain, append-extended)
 *   crossings         recordProviderBoundaryCrossing     (born 'dispatched'; the exact payload field recorded)
 *                     advanceProviderBoundaryCrossing    (the single guarded dispatched → echoed/dropped advance)
 *   conversions       recordOrderConversionEvent         (the REAL MKT-071 commerce events ONLY — the order truth)
 *                     recordFirstPartyConversionEvent    (store visits + product interactions)
 *   outcomes          recordAttributionOutcome           (THE JOIN — verified by the exported co-occurrence matcher, never a caller-asserted match)
 *
 * THE CAUSAL-SEPARATION DISCIPLINE (the core acceptance): no causal
 * computation exists anywhere here; the outcome record carries the
 * mechanism + the match provenance + the CHECK-fenced co-occurrence
 * note, and the causal vocabulary (lift, contribution,
 * incrementality) is structurally absent from the module.
 *
 * THE SCOPE DISCIPLINE (§18): every row client-scoped with the
 * optional workspace anchor; every read resolves foreign/unknown
 * scope to the uniform NotFound (no existence oracle) — the house
 * pattern.
 */

import { ConflictError, InvalidRequestError, NotFoundError } from '../../../platform/errors/errors.ts';
import type {
  SocialAttributionLinkConstructionInput,
  SocialAttributionObservableLink,
  SocialAttributionOutcomeReadModelRow,
  SocialCommerceAttributionModuleApi,
  SocialCommerceAttributionModuleDeps,
} from '../public.ts';
import {
  SOCIAL_COMMERCE_ATTRIBUTION_MATCH_VERSION,
  isConstructibleSocialAttributionMechanism,
} from '../public.ts';
import {
  SocialCommerceAttributionStore,
  mapAttachmentRow,
  mapConversionEventRow,
  mapCrossingRow,
  mapLinkConstructionRow,
  mapOutcomeRow,
  mapReferenceRow,
  type ReferenceScopeColumns,
} from './attribution-store.ts';
import { buildAttributionLink, deriveAttributionIdentity, deriveConstructionInputDigest, matchAttributionLinks as matchLinks } from './link-core.ts';
import {
  assertValidAttachment,
  assertValidCrossingAdvance,
  assertValidCrossingRecording,
  assertValidFirstPartyConversion,
  assertValidLinkConstruction,
  assertValidReferenceCreation,
  assertUuid,
} from './validation.ts';

/** The closed commerce order-event kinds (the migration-049 vocabulary, mirrored for the port check). */
const ORDER_EVENT_KINDS = ['order.created', 'order.updated', 'order.fulfilled', 'order.cancelled'];

export function createSocialCommerceAttributionModule(
  deps: SocialCommerceAttributionModuleDeps,
): SocialCommerceAttributionModuleApi {
  const { db, clock, ids, missions, workspaces, commerceEvents } = deps;

  /**
   * The pursuit-scope resolution (the commerce-discovery precedent):
   * the workspace → client → agency chain. An unknown workspace is the
   * uniform 404; a disabled workspace is the honest 409.
   */
  async function resolvePursuitScope(workspaceId: string): Promise<ReferenceScopeColumns> {
    const workspace = await workspaces.resolveWorkspace(workspaceId);
    if (workspace === null) {
      throw new NotFoundError('workspace', workspaceId);
    }
    if (workspace.status === 'disabled') {
      throw new ConflictError('the pursuit workspace is disabled — the pursuit scope is frozen for new records');
    }
    return {
      agencyId: workspace.agencyId,
      clientId: workspace.clientId,
      workspaceId: workspace.workspaceId,
    };
  }

  /** Loads a reference row or throws the uniform 404. */
  async function loadReference(referenceId: string) {
    const store = new SocialCommerceAttributionStore(db, clock, ids);
    const row = await store.findReference(referenceId);
    if (row === null) {
      throw new NotFoundError('attribution reference', referenceId);
    }
    return row;
  }

  /** The reference-state gate: new linkage requires an ACTIVE, CONSTRUCTIBLE reference. */
  function assertReferenceLinkable(
    row: { mechanism: string; status: string; attribution_reference_id: string },
  ): void {
    if (row.status !== 'active') {
      throw new ConflictError(
        `attribution reference ${row.attribution_reference_id} is retired — it accepts no new linkage (history stays readable)`,
      );
    }
    if (!isConstructibleSocialAttributionMechanism(row.mechanism)) {
      throw new ConflictError(
        `attribution reference ${row.attribution_reference_id} is honestly UNAVAILABLE on its platform — no link may be constructed, carried or dispatched on it (never fabricated)`,
      );
    }
  }

  return {
    async createAttributionReference(input, provenance) {
      assertValidReferenceCreation({
        missionId: input.missionId,
        pursuitWorkspaceId: input.pursuitWorkspaceId,
        mechanism: input.mechanism,
        purpose: input.purpose,
        creationContext: input.creationContext ?? {},
      });
      // The mission spine, cited OPAQUELY (READ-ONLY — the frozen-row
      // /growth-missions direction through the structural port).
      const mission = await missions.getGrowthMission(input.missionId);
      if (mission === null) {
        throw new NotFoundError('growth mission', input.missionId);
      }
      if (mission.status === 'archived' || mission.status === 'completed') {
        throw new ConflictError(
          `growth mission ${input.missionId} is terminal — its attribution references are frozen`,
        );
      }
      // The pursuit scope (the workspace → client → agency chain).
      const scope = await resolvePursuitScope(input.pursuitWorkspaceId);
      if (scope.agencyId !== mission.agencyId) {
        // A workspace of another agency than the mission is the uniform
        // 404 (a foreign pursuit scope is not a traversal oracle).
        throw new NotFoundError('growth mission', input.missionId);
      }
      // THE ID CONSTRUCTION (deterministic, pure): the identity digest
      // over the canonical creation inputs; the stable attribution id
      // is its first 16 hex.
      const { identityDigest, attributionRef } = deriveAttributionIdentity({
        missionId: input.missionId,
        mechanism: input.mechanism,
        purpose: input.purpose,
        creationContext: input.creationContext ?? {},
      });
      return db.transaction(async (tx) => {
        const store = new SocialCommerceAttributionStore(tx, clock, ids);
        const row = await store.insertReference({
          referenceId: ids.newId(),
          scope,
          missionId: input.missionId,
          attributionRef,
          identityDigest,
          mechanism: input.mechanism,
          purpose: input.purpose,
          creationContext: input.creationContext ?? {},
          provenance,
        });
        return mapReferenceRow(row);
      });
    },

    async getAttributionReference(attributionReferenceId) {
      assertUuid(attributionReferenceId, 'attributionReferenceId');
      const store = new SocialCommerceAttributionStore(db, clock, ids);
      const row = await store.findReference(attributionReferenceId);
      return row === null ? null : mapReferenceRow(row);
    },

    async listAttributionReferencesForMission(missionId) {
      assertUuid(missionId, 'missionId');
      const store = new SocialCommerceAttributionStore(db, clock, ids);
      return (await store.listReferencesForMission(missionId)).map(mapReferenceRow);
    },

    async listAttributionReferencesForClient(clientId) {
      assertUuid(clientId, 'clientId');
      const store = new SocialCommerceAttributionStore(db, clock, ids);
      return (await store.listReferencesForClient(clientId)).map(mapReferenceRow);
    },

    async retireAttributionReference(input, provenance) {
      void provenance;
      assertUuid(input.attributionReferenceId, 'attributionReferenceId');
      if (typeof input.reason !== 'string' || input.reason.length < 1 || input.reason.length > 4000) {
        throw new InvalidRequestError('reason must be a string of 1..4000 characters');
      }
      return db.transaction(async (tx) => {
        const store = new SocialCommerceAttributionStore(tx, clock, ids);
        const existing = await store.findReference(input.attributionReferenceId);
        if (existing === null) {
          throw new NotFoundError('attribution reference', input.attributionReferenceId);
        }
        const advanced = await store.retireReference(input.attributionReferenceId, input.reason, provenance);
        if (advanced === null) {
          throw new ConflictError(
            `attribution reference ${input.attributionReferenceId} is already retired — the advance is single-shot (no reopen)`,
          );
        }
        return mapReferenceRow(advanced);
      });
    },

    async constructAttributionLink(input, provenance) {
      assertUuid(input.attributionReferenceId, 'attributionReferenceId');
      const construction: SocialAttributionLinkConstructionInput = {
        ...input.construction,
        mechanism: input.construction.mechanism,
      };
      const row = await loadReference(input.attributionReferenceId);
      assertReferenceLinkable(row);
      if (construction.mechanism !== row.mechanism) {
        throw new ConflictError(
          `the construction mechanism '${construction.mechanism}' must be the reference's OWN mechanism '${row.mechanism}'`,
        );
      }
      assertValidLinkConstruction(row.attribution_ref, construction);
      // THE DETERMINISTIC PURE FORMULA (sca-link-v1 — no clock, no
      // randomness, no I/O): the same inputs always produce the same
      // link; the input digest is the idempotence fence.
      const built = buildAttributionLink({
        ...construction,
        attributionRef: row.attribution_ref,
        missionId: row.mission_id,
      });
      if (!built.ok) {
        throw new InvalidRequestError(built.error);
      }
      const inputDigest = deriveConstructionInputDigest({
        ...construction,
        attributionRef: row.attribution_ref,
        missionId: row.mission_id,
      });
      const scope: ReferenceScopeColumns = {
        agencyId: row.agency_id,
        clientId: row.client_id,
        workspaceId: row.workspace_id,
      };
      return db.transaction(async (tx) => {
        const txStore = new SocialCommerceAttributionStore(tx, clock, ids);
        const inserted = await txStore.insertLinkConstruction({
          linkConstructionId: ids.newId(),
          attributionReferenceId: row.attribution_reference_id,
          scope,
          mechanism: construction.mechanism,
          constructionInput: construction as unknown as Readonly<Record<string, unknown>>,
          inputDigest,
          constructedLink: built.built.link,
          matchField: built.built.matchField,
          matchValue: built.built.matchValue,
          provenance,
        });
        return mapLinkConstructionRow(inserted);
      });
    },

    async listLinkConstructionsForReference(attributionReferenceId) {
      assertUuid(attributionReferenceId, 'attributionReferenceId');
      const store = new SocialCommerceAttributionStore(db, clock, ids);
      const reference = await store.findReference(attributionReferenceId);
      if (reference === null) return null;
      return (await store.listLinkConstructionsForReference(attributionReferenceId)).map(mapLinkConstructionRow);
    },

    async recordAttributionAttachment(input, provenance) {
      assertUuid(input.attributionReferenceId, 'attributionReferenceId');
      assertValidAttachment(input);
      const row = await loadReference(input.attributionReferenceId);
      assertReferenceLinkable(row);
      const scope: ReferenceScopeColumns = {
        agencyId: row.agency_id,
        clientId: row.client_id,
        workspaceId: row.workspace_id,
      };
      return db.transaction(async (tx) => {
        const store = new SocialCommerceAttributionStore(tx, clock, ids);
        const inserted = await store.insertAttachment({
          attachmentId: ids.newId(),
          attributionReferenceId: row.attribution_reference_id,
          scope,
          carrierKind: input.carrierKind,
          carrierRef: input.carrierRef,
          originalContentRef: input.originalContentRef,
          carriedContentRefs: input.carriedContentRefs,
          reason: input.reason,
          provenance,
        });
        return mapAttachmentRow(inserted);
      });
    },

    async listAttachmentsForReference(attributionReferenceId) {
      assertUuid(attributionReferenceId, 'attributionReferenceId');
      const store = new SocialCommerceAttributionStore(db, clock, ids);
      const reference = await store.findReference(attributionReferenceId);
      if (reference === null) return null;
      return (await store.listAttachmentsForReference(attributionReferenceId)).map(mapAttachmentRow);
    },

    async recordProviderBoundaryCrossing(input, provenance) {
      assertUuid(input.attributionReferenceId, 'attributionReferenceId');
      assertUuid(input.linkConstructionId, 'linkConstructionId');
      assertValidCrossingRecording(input);
      const row = await loadReference(input.attributionReferenceId);
      assertReferenceLinkable(row);
      const store = new SocialCommerceAttributionStore(db, clock, ids);
      const construction = await store.findLinkConstruction(input.linkConstructionId);
      if (construction === null || construction.attribution_reference_id !== row.attribution_reference_id) {
        // A foreign or unknown construction is the uniform 404 (no
        // existence oracle).
        throw new NotFoundError('link construction', input.linkConstructionId);
      }
      const scope: ReferenceScopeColumns = {
        agencyId: row.agency_id,
        clientId: row.client_id,
        workspaceId: row.workspace_id,
      };
      return db.transaction(async (tx) => {
        const txStore = new SocialCommerceAttributionStore(tx, clock, ids);
        const inserted = await txStore.insertCrossing({
          crossingId: ids.newId(),
          attributionReferenceId: row.attribution_reference_id,
          linkConstructionId: input.linkConstructionId,
          scope,
          providerKey: input.providerKey,
          payloadField: input.payloadField,
          dispatchedValue: input.dispatchedValue,
          provenance,
        });
        return mapCrossingRow(inserted);
      });
    },

    async advanceProviderBoundaryCrossing(input, provenance) {
      void provenance;
      assertUuid(input.crossingId, 'crossingId');
      assertValidCrossingAdvance(input);
      return db.transaction(async (tx) => {
        const store = new SocialCommerceAttributionStore(tx, clock, ids);
        const existing = await store.findCrossing(input.crossingId);
        if (existing === null) {
          throw new NotFoundError('provider-boundary crossing', input.crossingId);
        }
        const advanced = await store.advanceCrossing({
          crossingId: input.crossingId,
          toState: input.toState,
          echoValue: input.echoValue,
          reason: input.reason,
        });
        if (advanced === null) {
          throw new ConflictError(
            `provider-boundary crossing ${input.crossingId} is already advanced — the advance is single-shot (no reopen)`,
          );
        }
        return mapCrossingRow(advanced);
      });
    },

    async listProviderCrossingsForReference(attributionReferenceId) {
      assertUuid(attributionReferenceId, 'attributionReferenceId');
      const store = new SocialCommerceAttributionStore(db, clock, ids);
      const reference = await store.findReference(attributionReferenceId);
      if (reference === null) return null;
      return (await store.listCrossingsForReference(attributionReferenceId)).map(mapCrossingRow);
    },

    async recordOrderConversionEvent(input, provenance) {
      assertUuid(input.pursuitWorkspaceId, 'pursuitWorkspaceId');
      assertUuid(input.commerceEventId, 'commerceEventId');
      // The pursuit scope (the workspace → client → agency chain).
      const scope = await resolvePursuitScope(input.pursuitWorkspaceId);
      // THE ORDER TRUTH: the cited commerce event must be one of the
      // client's INGESTED projections through the REAL commerce
      // boundary (the structural port); an order-kind event only.
      const events = await commerceEvents.listCommerceEventsForClient(scope.clientId);
      const cited = events.find((event) => event.commerceEventId === input.commerceEventId);
      if (cited === undefined) {
        throw new NotFoundError('commerce event', input.commerceEventId);
      }
      if (!ORDER_EVENT_KINDS.includes(cited.eventKind)) {
        throw new ConflictError(
          `commerce event ${input.commerceEventId} is a '${cited.eventKind}' event — an ORDER conversion cites an order-kind commerce event only (the order-truth fence)`,
        );
      }
      return db.transaction(async (tx) => {
        const store = new SocialCommerceAttributionStore(tx, clock, ids);
        const inserted = await store.insertConversionEvent({
          conversionEventId: ids.newId(),
          scope,
          conversionKind: 'order',
          eventSource: 'order_webhook',
          commerceEventId: cited.commerceEventId,
          storeConnectionId: cited.connectionId,
          providerEventId: cited.providerEventId,
          subjectRef: cited.providerSubjectId,
          occurredAt: cited.receivedAt,
          observedAt: cited.receivedAt,
          // The attribution passthrough VERBATIM (recorded, never
          // interpreted — the co-occurrence matcher runs over it).
          observedFields: { ...cited.attribution },
          provenance,
        });
        return mapConversionEventRow(inserted);
      });
    },

    async recordFirstPartyConversionEvent(input, provenance) {
      assertValidFirstPartyConversion(input);
      const scope = await resolvePursuitScope(input.pursuitWorkspaceId);
      return db.transaction(async (tx) => {
        const store = new SocialCommerceAttributionStore(tx, clock, ids);
        const inserted = await store.insertConversionEvent({
          conversionEventId: ids.newId(),
          scope,
          conversionKind: input.conversionKind,
          eventSource: 'first_party_event',
          commerceEventId: null,
          storeConnectionId: null,
          providerEventId: null,
          subjectRef: input.subjectRef ?? null,
          occurredAt: input.occurredAt ?? null,
          observedAt: store.nowIso(),
          observedFields: input.observedFields,
          provenance,
        });
        return mapConversionEventRow(inserted);
      });
    },

    async getConversionEvent(conversionEventId) {
      assertUuid(conversionEventId, 'conversionEventId');
      const store = new SocialCommerceAttributionStore(db, clock, ids);
      const row = await store.findConversionEvent(conversionEventId);
      return row === null ? null : mapConversionEventRow(row);
    },

    async listConversionEventsForClient(clientId) {
      assertUuid(clientId, 'clientId');
      const store = new SocialCommerceAttributionStore(db, clock, ids);
      return (await store.listConversionEventsForClient(clientId)).map(mapConversionEventRow);
    },

    async recordAttributionOutcome(input, provenance) {
      assertUuid(input.conversionEventId, 'conversionEventId');
      assertUuid(input.attributionReferenceId, 'attributionReferenceId');
      const store = new SocialCommerceAttributionStore(db, clock, ids);
      const conversionRow = await store.findConversionEvent(input.conversionEventId);
      if (conversionRow === null) {
        throw new NotFoundError('conversion event', input.conversionEventId);
      }
      const referenceRow = await store.findReference(input.attributionReferenceId);
      if (referenceRow === null) {
        throw new NotFoundError('attribution reference', input.attributionReferenceId);
      }
      // The same-client scope fence (the uniform posture on foreign
      // scope — no existence oracle).
      if (conversionRow.client_id !== referenceRow.client_id) {
        throw new NotFoundError('conversion event', input.conversionEventId);
      }
      // THE CO-OCCURRENCE MATCHER (sca-match-v1 — pure, exported): the
      // reference's constructed links against the conversion event's
      // observed reference fields. NO verified match → the honest 409
      // (the outcome row is inexpressible; never a caller-asserted
      // match).
      const constructions = await store.listLinkConstructionsForReference(input.attributionReferenceId);
      const observableLinks: SocialAttributionObservableLink[] = constructions.map((row) => ({
        linkConstructionId: row.link_construction_id,
        mechanism: mapLinkConstructionRow(row).mechanism,
        matchField: row.match_field as SocialAttributionObservableLink['matchField'],
        matchValue: row.match_value,
        attributionRef: referenceRow.attribution_ref,
      }));
      const observedFields =
        conversionRow.observed_fields !== null && typeof conversionRow.observed_fields === 'object'
          ? (conversionRow.observed_fields as Record<string, unknown>)
          : {};
      const match = matchLinks(observableLinks, observedFields);
      if (match === null) {
        throw new ConflictError(
          `no constructed link of attribution reference ${input.attributionReferenceId} matches the observed reference fields of conversion event ${input.conversionEventId} — the co-occurrence is NOT evidenced (never a caller-asserted match)`,
        );
      }
      const scope: ReferenceScopeColumns = {
        agencyId: referenceRow.agency_id,
        clientId: referenceRow.client_id,
        workspaceId: referenceRow.workspace_id,
      };
      const matchProvenance = {
        matcherVersion: SOCIAL_COMMERCE_ATTRIBUTION_MATCH_VERSION,
        matchedId: referenceRow.attribution_ref,
        matchedField: match.matchedField,
        matchedValue: match.matchedValue,
        mechanism: match.mechanism,
        linkConstructionId: match.linkConstructionId,
        observedAt: conversionRow.observed_at.toISOString(),
        observedBy: conversionRow.event_source,
        conversionEventId: input.conversionEventId,
      };
      // THE EVIDENCE/METRICS FLOWBACK CITATION (the cited projection
      // shape — a READ-ONLY projection; no /metrics or /evidence table
      // is written).
      const flowbackCitation = {
        kind: 'social_attribution_outcome',
        attributionOutcomeId: null as string | null,
        conversionEvent: {
          conversionEventId: conversionRow.conversion_event_id,
          conversionKind: conversionRow.conversion_kind,
          eventSource: conversionRow.event_source,
          commerceEventId: conversionRow.commerce_event_id,
        },
        attributionReference: {
          attributionReferenceId: referenceRow.attribution_reference_id,
          attributionRef: referenceRow.attribution_ref,
          mechanism: referenceRow.mechanism,
          missionId: referenceRow.mission_id,
        },
        matchProvenance,
        coOccurrenceNote: 'co-occurrence evidence only — never causal proof',
      };
      return db.transaction(async (tx) => {
        const txStore = new SocialCommerceAttributionStore(tx, clock, ids);
        const outcomeId = ids.newId();
        flowbackCitation.attributionOutcomeId = outcomeId;
        const inserted = await txStore.insertOutcome({
          outcomeId,
          conversionEventId: input.conversionEventId,
          attributionReferenceId: input.attributionReferenceId,
          linkConstructionId: match.linkConstructionId,
          scope,
          mechanism: referenceRow.mechanism,
          matchedField: match.matchedField,
          matchedValue: match.matchedValue,
          matchProvenance,
          flowbackCitation,
          provenance,
        });
        return mapOutcomeRow(inserted);
      });
    },

    async listAttributionOutcomesForReference(attributionReferenceId) {
      assertUuid(attributionReferenceId, 'attributionReferenceId');
      const store = new SocialCommerceAttributionStore(db, clock, ids);
      const reference = await store.findReference(attributionReferenceId);
      if (reference === null) return null;
      return (await store.listOutcomesForReference(attributionReferenceId)).map(mapOutcomeRow);
    },

    async listAttributionOutcomesForMission(missionId) {
      assertUuid(missionId, 'missionId');
      const store = new SocialCommerceAttributionStore(db, clock, ids);
      return (await store.listOutcomesForMission(missionId)).map(mapOutcomeRow);
    },

    async listAttributionOutcomeReadModel(
      clientId: string,
    ): Promise<readonly SocialAttributionOutcomeReadModelRow[]> {
      assertUuid(clientId, 'clientId');
      const store = new SocialCommerceAttributionStore(db, clock, ids);
      return store.listOutcomeReadModel(clientId);
    },
  };
}
