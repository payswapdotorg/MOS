/**
 * /content-rights module implementation (MKT-063 — Content Rights and
 * Provenance).
 *
 * Thin orchestration over the store + the two frozen-matrix consumers
 * (/evidence canonical resolution, /policies destination gate):
 *
 *   validated input (the pure guards — vocabulary + shape + transition
 *   legality, fail-closed by rejection BEFORE any write) → canonical
 *   /evidence resolution of every evidence link (uniform NotFoundError
 *   for unknown/foreign — no cross-tenant oracle; the DB same-Client
 *   triggers are the backstop) → the durable append-oriented writes
 *   (records born 'unknown'; transitions as event row + state move in
 *   ONE transaction; permissions/lineage/clearances as immutable rows).
 *
 * THE PUBLICATION GATE (fail-closed by construction — the MKT-063
 * heart):
 *   1. resolve the asset's rights record (absent → BLOCKED
 *      no_rights_record: an absent evaluation is never an allow);
 *   2. evaluate the record's own state (pure
 *      evaluateContentRightsState: expired licence → blocked; blocked →
 *      blocked; unknown/review → review_required — NEVER an
 *      auto-approve, this is the one honest surface rights become a
 *      blocked_pending_human_action source; owned/cleared → allow;
 *      license/platform_permitted → the effective destination
 *      permission row decides, unspecified → review_required);
 *   3. traverse the ingredient lineage of composites (cycle-guarded,
 *      depth-bounded) and CONJOIN: any blocked/absent ingredient blocks
 *      the composite, any unclear ingredient makes it review_required;
 *      a composite-kind record with NO lineage links is blocked
 *      outright (sourceLineageRequired — an unauditable composite is
 *      not publishable);
 *   4. run the destination-policy compatibility through /policies
 *      (network dimension, content.rights.publication.<platform>) on
 *      EVERY evaluation — the decision is recorded in the policy
 *      engine's own append-only ledger and a non-allow BLOCKS
 *      (destinationPolicyGateRequired).
 *
 * The gate performs NO writes to the module's own tables and holds NO
 * publication authority (boundary rule 4): it blocks or refers to
 * review; publishing is MKT-065's execution surface. The agency/client
 * scope of every command is SERVER-DERIVED input (resolved by the route
 * layer from canonical ownership — never a request field, never
 * re-derived here through an off-matrix authority).
 */

import { ConflictError, NotFoundError } from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type { EvidenceModuleApi } from '../../evidence/public.ts';
import type { PoliciesModuleApi } from '../../policies/public.ts';
import { enforcementOutcome } from '../../policies/public.ts';
import type {
  ContentRightsGateIngredientEvaluation,
  ContentRightsGateOutcome,
  ContentRightsGateReason,
  ContentRightsGateResult,
  ContentRightsLineageRecord,
  ContentRightsModuleApi,
  ContentRightsRecord,
} from '../public.ts';
import {
  conjunctionOfGateOutcomes,
  CONTENT_RIGHTS_VOCABULARY_VERSION,
  evaluateContentRightsState,
  publicationPolicyKey,
} from '../public.ts';
import {
  assertValidContentRightsProvenance,
  assertValidGateInput,
  assertValidLineageInput,
  assertValidPermissionInput,
  assertValidRegisterContentRightsInput,
  assertValidTransitionInput,
  MAX_LINEAGE_DEPTH,
  transitionProblems,
} from './validation.ts';
import { ContentRightsStore } from './store.ts';

export interface ContentRightsModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly evidence: EvidenceModuleApi;
  readonly policies: PoliciesModuleApi;
}

/** The UUID guard shape (an opaque uuid — malformed ids are uniform 404s). */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Classifies a PostgreSQL error as a migration-051 CHECK/trigger
 * rejection (the race backstop firing) — surfaced as the honest
 * ConflictError, never a raw driver error.
 */
function isTransitionBackstopViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('content_rights_transition_table_check') ||
    message.includes('content_rights_state_move') ||
    message.includes('content_rights_event_shape') ||
    message.includes('content_rights_record_disciplined')
  );
}

export function createContentRightsModule(
  deps: ContentRightsModuleDeps,
): ContentRightsModuleApi {
  const store = new ContentRightsStore(deps.db, deps.clock, deps.ids);
  const { evidence, policies, clock } = deps;

  /**
   * Canonical /evidence resolution of ONE evidence link: the record
   * must exist AND belong to the SAME Client as the rights record —
   * unknown and foreign are the SAME uniform NotFoundError (no
   * cross-tenant oracle; the DB same-Client trigger is the backstop).
   */
  async function requireEvidenceInClient(
    clientId: string,
    evidenceRef: string,
  ): Promise<void> {
    if (!UUID_PATTERN.test(evidenceRef)) {
      throw new NotFoundError('evidence', evidenceRef);
    }
    const record = await evidence.getEvidence(evidenceRef);
    if (record === null || record.clientId !== clientId) {
      throw new NotFoundError('evidence', evidenceRef);
    }
  }

  /** The record by id — uniform 404 on unknown/malformed (the route layer adds the client narrowing). */
  async function requireRightsRecord(
    rightsRecordId: string,
  ): Promise<ContentRightsRecord> {
    if (!UUID_PATTERN.test(rightsRecordId)) {
      throw new NotFoundError('content_rights_record', rightsRecordId);
    }
    const record = await store.getRightsRecord(rightsRecordId);
    if (record === null) {
      throw new NotFoundError('content_rights_record', rightsRecordId);
    }
    return record;
  }

  /**
   * The honest reasons of one record's own state evaluation (pure
   * composition of the frozen reason codes — negative codes on
   * blocked/review_required outcomes, positive basis codes on allow).
   */
  function stateReasons(
    record: ContentRightsRecord,
    outcome: ContentRightsGateOutcome,
    destinationPlatform: string,
    nowIso: string,
  ): readonly ContentRightsGateReason[] {
    if (outcome === 'allow') {
      switch (record.state) {
        case 'owned':
          return [
            {
              code: 'allowed_owned',
              detail: `the asset '${record.contentAssetRef}' is OWNED content of this client — publication permitted`,
            },
          ];
        case 'cleared':
          return [
            {
              code: 'allowed_human_clearance',
              detail: `the asset '${record.contentAssetRef}' carries a recorded explicit human clearance (review -> cleared) — publication permitted`,
            },
          ];
        case 'license':
          return [
            {
              code: 'allowed_license_scope',
              detail: `the licence basis of '${record.contentAssetRef}' explicitly permits the destination '${destinationPlatform}'`,
            },
          ];
        case 'platform_permitted':
          return [
            {
              code: 'allowed_platform_permission',
              detail: `the platform permission scope of '${record.contentAssetRef}' explicitly permits the destination '${destinationPlatform}'`,
            },
          ];
        default:
          return [];
      }
    }
    if (record.validUntil !== null && record.validUntil <= nowIso) {
      return [
        {
          code: 'licence_expired',
          detail: `the licence basis of '${record.contentAssetRef}' expired at ${record.validUntil} — an expired licence is BLOCKED at evaluation time, fail-closed`,
        },
      ];
    }
    switch (record.state) {
      case 'blocked':
        return [
          {
            code: 'rights_state_blocked',
            detail: `the rights state of '${record.contentAssetRef}' is BLOCKED`,
          },
        ];
      case 'unknown':
        return [
          {
            code: 'rights_state_unknown',
            detail: `the rights state of '${record.contentAssetRef}' is UNKNOWN (undetermined) — autonomous publication fails closed; a human determination or review is required`,
          },
        ];
      case 'review':
        return [
          {
            code: 'rights_state_review',
            detail: `the rights state of '${record.contentAssetRef}' is REVIEW — autonomous publication fails closed pending the recorded human review outcome`,
          },
        ];
      default: {
        // license / platform_permitted: the destination permission row
        // decided (expiry already handled above).
        const notPermitted = outcome === 'blocked';
        return [
          {
            code: notPermitted
              ? 'destination_not_permitted'
              : 'destination_permission_unspecified',
            detail: notPermitted
              ? `the licence/platform permission scope of '${record.contentAssetRef}' does NOT permit the destination '${destinationPlatform}'`
              : `the licence/platform permission scope of '${record.contentAssetRef}' carries NO row for the destination '${destinationPlatform}' — the scope is unspecified, which fails closed to human review`,
          },
        ];
      }
    }
  }

  /**
   * THE recursive rights evaluation of one asset against the
   * destination. `path` carries the traversal ancestry (cycle guard);
   * `depth` is bounded (MAX_LINEAGE_DEPTH — deeper graphs BLOCK, they
   * never loop); `breakdown` accumulates the per-ingredient audit rows
   * of the composite being evaluated.
   */
  async function evaluateAsset(
    clientId: string,
    assetRef: string,
    destinationPlatform: string,
    nowIso: string,
    depth: number,
    path: ReadonlySet<string>,
    breakdown: ContentRightsGateIngredientEvaluation[],
  ): Promise<{
    readonly outcome: ContentRightsGateOutcome;
    readonly reasons: readonly ContentRightsGateReason[];
  }> {
    // The record (absent → BLOCKED: an absent evaluation is never an
    // allow — the MKT-063 fail-closed contract).
    const record = await store.getRightsRecordForAsset(clientId, assetRef);
    if (record === null) {
      return {
        outcome: 'blocked',
        reasons: [
          {
            code: 'no_rights_record',
            detail: `no rights record exists for content asset '${assetRef}' in this client — an absent rights evaluation is BLOCKED, never allowed`,
          },
        ],
      };
    }

    // The lineage of this asset.
    const links: readonly ContentRightsLineageRecord[] = await store.listLineageLinks(
      clientId,
      assetRef,
    );

    // A composite-kind record with NO lineage links is blocked
    // outright (sourceLineageRequired — an unauditable composite is
    // not publishable; padding/compilation material must carry its own
    // rights, which requires the links to exist).
    if (record.assetKind === 'composite' && links.length === 0) {
      return {
        outcome: 'blocked',
        reasons: [
          {
            code: 'lineage_missing',
            detail: `content asset '${assetRef}' is declared a composite but carries NO ingredient lineage links — the conjunction cannot be evaluated, fail-closed`,
          },
        ],
      };
    }

    // The asset's OWN state evaluation (pure).
    const effectivePermission =
      record.state === 'license' || record.state === 'platform_permitted'
        ? ((await store.getEffectivePermission(record.rightsRecordId, destinationPlatform)) ??
          'unspecified')
        : 'unspecified';
    const ownOutcome = evaluateContentRightsState({
      state: record.state,
      validUntil: record.validUntil,
      nowIso,
      effectivePermission,
    });
    const ownReasons = stateReasons(record, ownOutcome, destinationPlatform, nowIso);

    if (links.length === 0) {
      return { outcome: ownOutcome, reasons: ownReasons };
    }

    // THE CONJUNCTION: evaluate every unique ingredient, then conjoin
    // with the asset's own evaluation.
    const ingredientOutcomes: ContentRightsGateOutcome[] = [];
    const blockedReasons: ContentRightsGateReason[] = [];
    const unclearReasons: ContentRightsGateReason[] = [];
    const seen = new Set<string>();
    for (const link of links) {
      if (seen.has(link.ingredientAssetRef)) continue;
      seen.add(link.ingredientAssetRef);

      // Cycle guard: an ingredient already on the traversal ancestry
      // BLOCKS (a lineage graph that loops is not evaluable —
      // fail-closed, never an infinite walk).
      if (path.has(link.ingredientAssetRef)) {
        blockedReasons.push({
          code: 'lineage_cycle',
          detail: `the ingredient lineage of '${assetRef}' cycles back through '${link.ingredientAssetRef}' — a cyclic composition graph is BLOCKED, fail-closed`,
        });
        ingredientOutcomes.push('blocked');
        breakdown.push({
          assetRef: link.ingredientAssetRef,
          outcome: 'blocked',
          reasonCodes: ['lineage_cycle'],
        });
        continue;
      }
      // Depth guard: deeper graphs BLOCK (bounded traversal — never an
      // unbounded walk).
      if (depth >= MAX_LINEAGE_DEPTH) {
        blockedReasons.push({
          code: 'lineage_depth_exceeded',
          detail: `the ingredient lineage of '${assetRef}' exceeds the maximum traversal depth of ${MAX_LINEAGE_DEPTH} — an unresolvably deep composition is BLOCKED, fail-closed`,
        });
        ingredientOutcomes.push('blocked');
        breakdown.push({
          assetRef: link.ingredientAssetRef,
          outcome: 'blocked',
          reasonCodes: ['lineage_depth_exceeded'],
        });
        continue;
      }

      const nestedPath = new Set(path);
      nestedPath.add(link.ingredientAssetRef);
      const nestedBreakdown: ContentRightsGateIngredientEvaluation[] = [];
      const nested = await evaluateAsset(
        clientId,
        link.ingredientAssetRef,
        destinationPlatform,
        nowIso,
        depth + 1,
        nestedPath,
        nestedBreakdown,
      );
      ingredientOutcomes.push(nested.outcome);
      breakdown.push({
        assetRef: link.ingredientAssetRef,
        outcome: nested.outcome,
        reasonCodes: nested.reasons.map((reason) => reason.code),
      });
      for (const nestedRow of nestedBreakdown) {
        breakdown.push(nestedRow);
      }
      if (nested.outcome === 'blocked') {
        for (const reason of nested.reasons) {
          blockedReasons.push({
            code:
              reason.code === 'no_rights_record'
                ? 'ingredient_no_rights_record'
                : 'ingredient_blocked',
            detail: `ingredient '${link.ingredientAssetRef}' of '${assetRef}': ${reason.detail}`,
          });
        }
      } else if (nested.outcome === 'review_required') {
        for (const reason of nested.reasons) {
          unclearReasons.push({
            code: 'ingredient_rights_unclear',
            detail: `ingredient '${link.ingredientAssetRef}' of '${assetRef}': ${reason.detail}`,
          });
        }
      }
    }

    const conjunction = conjunctionOfGateOutcomes([ownOutcome, ...ingredientOutcomes]);
    if (conjunction === 'blocked') {
      return {
        outcome: 'blocked',
        reasons: [...blockedReasons, ...(ownOutcome === 'blocked' ? ownReasons : [])],
      };
    }
    if (conjunction === 'review_required') {
      // Any unclear ingredient blocks the composite from autonomous
      // publication (review_required — the honest human-action
      // surface: this is the ONLY place rights become a
      // blocked_pending_human_action source for consumers).
      return {
        outcome: 'review_required',
        reasons: [...unclearReasons, ...(ownOutcome === 'review_required' ? ownReasons : [])],
      };
    }
    return { outcome: 'allow', reasons: ownReasons };
  }

  return {
    async registerContentRights(input, provenance) {
      assertValidContentRightsProvenance(provenance);
      assertValidRegisterContentRightsInput(input);
      // Canonical evidence resolution BEFORE any write: source
      // provenance is REQUIRED (a record without provenance is never
      // born), and a licence evidence link (when supplied) must be
      // resolvable in the same Client.
      await requireEvidenceInClient(input.clientId, input.sourceEvidenceRef);
      if (input.licenceEvidenceRef !== null) {
        await requireEvidenceInClient(input.clientId, input.licenceEvidenceRef);
      }
      return store.insertRightsRecord(input, provenance);
    },

    async getRightsRecord(rightsRecordId) {
      return store.getRightsRecord(rightsRecordId);
    },

    async getRightsRecordForAsset(clientId, contentAssetRef) {
      return store.getRightsRecordForAsset(clientId, contentAssetRef);
    },

    async resolveRightsOwnership(rightsRecordId) {
      if (!UUID_PATTERN.test(rightsRecordId)) return null;
      const record = await store.getRightsRecord(rightsRecordId);
      if (record === null) return null;
      return {
        scope: {
          kind: 'content_rights',
          agencyId: record.agencyId,
          clientId: record.clientId,
          workspaceId: record.workspaceId,
          rightsRecordId: record.rightsRecordId,
        },
        record,
        resolvedAt: new Date(clock.nowIso()).toISOString(),
      };
    },

    async listRightsRecordsForClient(clientId) {
      return store.listRightsRecordsForClient(clientId);
    },

    async recordRightsTransition(input, provenance) {
      assertValidContentRightsProvenance(provenance);
      assertValidTransitionInput(input);
      // The fast-path legality check against the CURRENT live state
      // (the migration-051 CHECKs are the race backstop: a concurrent
      // transition that changed the live state makes the DB reject the
      // stale triple — surfaced below as the honest ConflictError).
      const current = await requireRightsRecord(input.rightsRecordId);
      const problems = transitionProblems(current.state, input);
      if (problems.length > 0) {
        throw new ConflictError(problems.join('; '));
      }
      // A human_clearance's supporting evidence (fair-use reasoning
      // etc.) resolves canonically BEFORE any write — it rides as
      // review evidence on the clearance record, never as an
      // auto-clear.
      if (input.clearance !== null && input.clearance.evidenceRef !== null) {
        await requireEvidenceInClient(current.clientId, input.clearance.evidenceRef);
      }
      try {
        const outcome = await store.recordTransition(input, provenance);
        if (outcome.kind === 'missing') {
          // A concurrent DELETE is impossible (the no-DELETE trigger),
          // but the uniform posture still applies.
          throw new NotFoundError('content_rights_record', input.rightsRecordId);
        }
        return {
          record: outcome.record,
          event: outcome.event,
          clearance: outcome.clearance,
        };
      } catch (error) {
        if (isTransitionBackstopViolation(error)) {
          throw new ConflictError(
            `the transition was rejected by the frozen content-rights transition table (the record's live state changed concurrently, or the ${input.eventKind} event is illegal from the current state) — fail-closed, no history was written`,
          );
        }
        throw error;
      }
    },

    async recordPlatformPermission(input, provenance) {
      assertValidContentRightsProvenance(provenance);
      assertValidPermissionInput(input);
      const record = await requireRightsRecord(input.rightsRecordId);
      await requireEvidenceInClient(record.clientId, input.evidenceRef);
      return store.insertPermission(input, provenance);
    },

    async recordLineageLink(input, provenance) {
      assertValidContentRightsProvenance(provenance);
      assertValidLineageInput(input);
      return store.insertLineageLink(input, provenance);
    },

    async listLineageLinks(clientId, compositeAssetRef) {
      return store.listLineageLinks(clientId, compositeAssetRef);
    },

    async listRightsEvents(rightsRecordId) {
      return store.listRightsEvents(rightsRecordId);
    },

    async listPlatformPermissions(rightsRecordId) {
      return store.listPlatformPermissions(rightsRecordId);
    },

    async listClearances(rightsRecordId) {
      return store.listClearances(rightsRecordId);
    },

    async evaluatePublicationGate(input, provenance) {
      assertValidContentRightsProvenance(provenance);
      assertValidGateInput(input);
      const nowIso = new Date(clock.nowIso()).toISOString();

      // --- The destination-policy gate (runs on EVERY evaluation; the
      // decision is recorded in the policy engine's own append-only
      // ledger — destinationPolicyGateRequired). Only an explicit
      // allow permits; deny AND unknown both BLOCK, fail-closed. ---
      const decision = await policies.evaluateAction(
        {
          action: {
            dimension: 'network',
            operation: publicationPolicyKey(input.destinationPlatform),
            resource: null,
            attributes: {
              assetRef: input.assetRef,
              destinationPlatform: input.destinationPlatform,
            },
          },
          scope: {
            agencyId: input.agencyId,
            clientId: input.clientId,
          },
        },
        {
          actor: provenance.actor,
          recordedVia: provenance.recordedVia,
          correlationId: provenance.correlationId,
          causationId: provenance.causationId,
        },
      );
      const policyAllowed = enforcementOutcome(decision) === 'allow';

      // --- The rights evaluation (recursive, cycle-guarded,
      // depth-bounded; the conjunction resolves composites). ---
      const ingredientEvaluations: ContentRightsGateIngredientEvaluation[] = [];
      const evaluation = await evaluateAsset(
        input.clientId,
        input.assetRef,
        input.destinationPlatform,
        nowIso,
        0,
        new Set<string>([input.assetRef]),
        ingredientEvaluations,
      );

      // --- Compose the final outcome: a denied destination policy
      // BLOCKS regardless of the rights evaluation (fail-closed both
      // ways — the gate never permits on policy uncertainty). ---
      const reasons: ContentRightsGateReason[] = [...evaluation.reasons];
      let outcome: ContentRightsGateOutcome = evaluation.outcome;
      if (!policyAllowed) {
        outcome = 'blocked';
        reasons.push({
          code: 'policy_denied',
          detail: `the destination policy key ${publicationPolicyKey(input.destinationPlatform)} did not explicitly allow this publication (decision ${decision.decisionId}) — fail-closed`,
        });
      }

      const result: ContentRightsGateResult = {
        outcome,
        reasons,
        assetRef: input.assetRef,
        destinationPlatform: input.destinationPlatform,
        composite: ingredientEvaluations.length > 0,
        ingredientEvaluations,
        policyDecisionId: decision.decisionId,
        evaluatedAt: nowIso,
        vocabularyVersion: CONTENT_RIGHTS_VOCABULARY_VERSION,
      };
      return result;
    },
  };
}
