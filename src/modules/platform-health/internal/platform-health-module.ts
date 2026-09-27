/**
 * /platform-health module implementation (MKT-066).
 *
 * Owns the migration-058 tables (through the store): the append-only
 * per-account health evaluation records + the FK-anchored evidence links.
 *
 * THE COMPOSITION (§11): this module FETCHES the observable records
 * through the five frozen-row public contracts (/social-accounts,
 * /integrations, /metrics, /evidence, /experiments — all READ-ONLY), maps
 * them onto the record-derived PlatformHealthEvaluationInput, and hands
 * them to the PURE deterministic core (evaluation.ts). The verdict is
 * then persisted as ONE append-only evaluation record.
 *
 * THE OBSERVABLE-SIGNALS-ONLY DISCIPLINE IS STRUCTURAL: the module API's
 * input is exactly { clientId, socialAccountId } — there is NO signal,
 * state, claim or verdict parameter anywhere, so a provider notice with
 * no observable record cannot enter an evaluation (§11; lock rule 25).
 *
 * THE 065 DISTRIBUTION PUBLICATIONS arrive as the per-account 056
 * publish-attempt records: the 056 idempotency ledger is the ONLY
 * physical publish path (the 065 module routes every destination
 * publication through submitPublish), so the account's attempt tail IS
 * the complete observable publication-outcome surface — no
 * /cross-platform-distribution dependency exists (not an allowance of
 * this module's frozen row).
 */

import { NotFoundError } from '../../../platform/errors/errors.ts';
import type {
  PlatformHealthEvaluationInput,
  PlatformHealthMetricPointObservation,
  PlatformHealthMetricSeriesObservation,
  PlatformHealthModuleApi,
  PlatformHealthModuleDeps,
  PlatformHealthStatusPollObservation,
} from '../public.ts';
import { PLATFORM_HEALTH_METRIC_NAMESPACE, PLATFORM_HEALTH_VOCABULARY_VERSION } from '../public.ts';
import { evaluatePlatformHealth, assertValidPlatformHealthProvenance } from './evaluation.ts';
import {
  MAX_EVIDENCE_LINKS,
  MAX_METRIC_LINKS,
  MAX_PUBLICATION_LINKS,
  PlatformHealthStore,
} from './platform-health-store.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The account dimension key of the frozen metric-series convention (ph-vocab-v1). */
const SOCIAL_ACCOUNT_DIMENSION_KEY = 'social_account_id' as const;
/** The platform dimension key of the frozen metric-series convention (ph-vocab-v1). */
const PLATFORM_DIMENSION_KEY = 'platform' as const;

/** The status-poll composition bound: the newest referenced attempts whose polls are composed. */
const STATUS_POLL_ATTEMPT_BOUND = 5;

export function createPlatformHealthModule(
  deps: PlatformHealthModuleDeps,
): PlatformHealthModuleApi {
  const store = new PlatformHealthStore(deps.db, deps.clock, deps.ids);
  const { clock, socialAccounts, integrations, metrics, evidence, experiments } = deps;

  return {
    async evaluateAccountHealth(input, provenance) {
      assertValidPlatformHealthProvenance(provenance);
      if (!UUID_PATTERN.test(input.socialAccountId)) {
        throw new NotFoundError('social account', input.socialAccountId);
      }

      // --- The canonical account ownership (the uniform 404 for
      // foreign/unknown accounts — no existence oracle). ---
      const ownership = await socialAccounts.resolveAccountOwnership(input.socialAccountId);
      if (ownership === null || ownership.scope.clientId !== input.clientId) {
        throw new NotFoundError('social account', input.socialAccountId);
      }
      const account = ownership.account;

      // --- The capability-matrix view (registered adapter, usable
      // authorization — the 056/055 fail-closed reads). ---
      const capability = await socialAccounts.resolveAccountCapabilityMatrix(input.socialAccountId);
      const authorizationUsable = capability?.authorizationUsable ?? false;
      const socialAdapterRegistered = capability?.registered ?? false;

      // --- The current grant state (dead accounts refuse the grant read —
      // the account status itself is the observable reason then). ---
      let grantState: string | null = null;
      let grantId: string | null = null;
      if (account.status === 'connected') {
        const grants = await socialAccounts.listAuthorizationGrantsForAccount(input.socialAccountId);
        const newest = grants[0];
        if (newest !== undefined) {
          grantState = newest.grantState;
          grantId = newest.grantId;
        }
      }

      // --- The integration connection operational state. ---
      const connection = await integrations.getConnection(account.integrationConnectionId);

      // --- The 056 publish-attempt invocation records (the observable
      // publication outcomes incl. everything the 065 dispatch drove
      // through this account — the 056 ledger is the only publish path). ---
      const attempts = await socialAccounts.listPublishAttemptsForAccount(input.socialAccountId);

      // --- The status-poll history of the newest referenced attempts
      // (bounded — the freshest provider state). ---
      const statusPolls: PlatformHealthStatusPollObservation[] = [];
      const referencedAttempts = attempts
        .filter((attempt) => attempt.providerPublishId !== null)
        .slice(0, STATUS_POLL_ATTEMPT_BOUND);
      for (const attempt of referencedAttempts) {
        const polls = await socialAccounts.listPublishStatusObservations(
          input.socialAccountId,
          attempt.attemptId,
        );
        for (const poll of polls.slice(-3)) {
          statusPolls.push({
            observationId: poll.observationId,
            attemptId: poll.attemptId,
            publishState: poll.publishState,
            restrictionSignals: poll.restrictionSignals.map((signal) => ({
              signalKind: signal.signalKind,
              description: signal.description,
            })),
          });
        }
      }

      // --- The client's metric observations: partition the frozen
      // 'social.*' namespace into the account's OWN series and the
      // cross-platform CONTROL series (the §11 control comparison). ---
      const clientAccounts = await socialAccounts.listSocialAccountsForClient(input.clientId);
      const otherAccountIds = new Set(
        clientAccounts
          .filter((entry) => entry.socialAccountId !== input.socialAccountId)
          .map((entry) => entry.socialAccountId),
      );
      const observations = await metrics.listMetricObservationsForClient(input.clientId);

      const accountSeries = new Map<string, PlatformHealthMetricPointObservation[]>();
      const controlSeries = new Map<string, PlatformHealthMetricSeriesObservation>();
      for (const observation of observations) {
        if (!observation.metricName.startsWith(PLATFORM_HEALTH_METRIC_NAMESPACE)) continue;
        const accountDimension = observation.dimensions[SOCIAL_ACCOUNT_DIMENSION_KEY];
        const platformDimension = observation.dimensions[PLATFORM_DIMENSION_KEY];
        if (typeof accountDimension !== 'string' || typeof platformDimension !== 'string') {
          continue;
        }
        const point: PlatformHealthMetricPointObservation = {
          observationId: observation.observationId,
          observedAt: observation.observedAt,
          value: observation.value,
          quality: observation.quality,
          evidenceRef: observation.evidenceRef,
        };
        if (accountDimension === input.socialAccountId) {
          const bucket = accountSeries.get(observation.metricName) ?? [];
          bucket.push(point);
          accountSeries.set(observation.metricName, bucket);
        } else if (otherAccountIds.has(accountDimension) && platformDimension !== account.platformId) {
          const key = `${platformDimension}:${accountDimension}:${observation.metricName}`;
          const existing = controlSeries.get(key);
          if (existing === undefined) {
            controlSeries.set(key, {
              scope: 'control',
              platformId: platformDimension,
              metricName: observation.metricName,
              observations: [point],
            });
          } else {
            controlSeries.set(key, {
              ...existing,
              observations: [...existing.observations, point],
            });
          }
        }
      }

      // Oldest first BY OBSERVATION TIME (the ordered history the pure
      // core consumes; deterministic tiebreak by observation id — the
      // /metrics list surface is newest-first by recorded time, which is
      // NOT the observation order).
      const metricSeries: PlatformHealthMetricSeriesObservation[] = [];
      const byObservedAt = (a: PlatformHealthMetricPointObservation, b: PlatformHealthMetricPointObservation): number =>
        a.observedAt === b.observedAt
          ? (a.observationId < b.observationId ? -1 : 1)
          : (a.observedAt < b.observedAt ? -1 : 1);
      for (const [metricName, points] of accountSeries) {
        metricSeries.push({
          scope: 'account',
          platformId: account.platformId,
          metricName,
          observations: [...points].sort(byObservedAt),
        });
      }
      for (const series of controlSeries.values()) {
        metricSeries.push({
          ...series,
          observations: [...series.observations].sort(byObservedAt),
        });
      }

      // --- The active-experiment confounder context (READ-ONLY; never a
      // verdict source — attribution is distinct from causal inference). ---
      const experimentRecords = await experiments.listExperimentsForClient(input.clientId);
      const experimentContexts = experimentRecords.map((experiment) => ({
        experimentId: experiment.experimentId,
        status: experiment.status,
        primaryMetricName: experiment.primaryMetric.name,
      }));

      // --- The pure deterministic evaluation. ---
      const evaluationInput: PlatformHealthEvaluationInput = {
        evaluatedAt: clock.nowIso(),
        account: {
          socialAccountId: account.socialAccountId,
          platformId: account.platformId,
          status: account.status,
          workspaceId: account.workspaceId,
          grantState,
          grantId,
          authorizationUsable,
          connectionId: account.integrationConnectionId,
          connectionStatus: connection?.status ?? 'unknown',
          socialAdapterRegistered,
        },
        publishAttempts: attempts.map((attempt) => ({
          attemptId: attempt.attemptId,
          recordedAt: attempt.provenance.recordedAt,
          publishState: attempt.publishState,
          failureCode: attempt.failureCode,
          restrictionSignals: attempt.restrictionSignals.map((signal) => ({
            signalKind: signal.signalKind,
            description: signal.description,
          })),
          rateLimit:
            attempt.rateLimit === null
              ? null
              : {
                  limitRemaining: attempt.rateLimit.limitRemaining,
                  backoffUntil: attempt.rateLimit.backoffUntil,
                  retryAfterSeconds: attempt.rateLimit.retryAfterSeconds,
                },
        })),
        statusPolls,
        metricSeries,
        experiments: experimentContexts,
      };
      const result = evaluatePlatformHealth(evaluationInput);

      // --- The FK-anchored citation windows (bounded, deterministic
      // order: the evidence-basis entries are the citation order). ---
      const publishAttemptIds = [
        ...new Set(
          result.evidenceBasis
            .filter((entry): entry is Extract<typeof entry, { kind: 'publish_attempt' }> => entry.kind === 'publish_attempt')
            .map((entry) => entry.attemptId),
        ),
      ].slice(0, MAX_PUBLICATION_LINKS);
      const metricObservationIds = [
        ...new Set(
          result.evidenceBasis
            .filter((entry): entry is Extract<typeof entry, { kind: 'metric_observation' }> => entry.kind === 'metric_observation')
            .map((entry) => entry.observationId),
        ),
      ].slice(0, MAX_METRIC_LINKS);
      const candidateEvidenceRefs = [
        ...new Set(
          evaluationInput.metricSeries
            .flatMap((series) => series.observations.map((point) => point.evidenceRef))
            .filter((ref): ref is string => ref !== null),
        ),
      ];
      const evidenceIds: string[] = [];
      for (const evidenceRef of candidateEvidenceRefs) {
        // Canonical /evidence resolution, same-Client only (the DB
        // same-Client trigger is the backstop; the /metrics module already
        // fences the reference at append time).
        const record = await evidence.getEvidence(evidenceRef);
        if (record !== null && record.clientId === input.clientId) {
          evidenceIds.push(evidenceRef);
        }
        if (evidenceIds.length >= MAX_EVIDENCE_LINKS) break;
      }

      // --- Persist ONE append-only evaluation record + its links. ---
      const evaluationId = store.newId();
      await store.insertEvaluation({
        evaluationId,
        agencyId: ownership.scope.agencyId,
        clientId: input.clientId,
        workspaceId: account.workspaceId,
        socialAccountId: account.socialAccountId,
        platformId: account.platformId,
        record: {
          evaluatedState: result.state,
          confidence: result.confidence,
          uncertainty: result.uncertainty,
          reasonCodes: [...result.reasonCodes],
          baseline: [...result.baseline],
          recommendations: [...result.recommendations],
          evidenceBasis: [...result.evidenceBasis],
          signalsConsidered: result.signalsConsidered,
          vocabularyVersion: PLATFORM_HEALTH_VOCABULARY_VERSION,
          baselineVersion: result.baselineVersion,
        },
        evidenceIds,
        metricObservationIds,
        publishAttemptIds,
        provenance,
      });

      const detail = await this.getEvaluationDetail(evaluationId);
      if (detail === null) {
        throw new Error(`platform-health evaluation ${evaluationId} could not be read back`);
      }
      return detail;
    },

    async getEvaluation(evaluationId) {
      return store.getEvaluation(evaluationId);
    },

    async resolveEvaluationOwnership(evaluationId) {
      const evaluation = await store.getEvaluation(evaluationId);
      if (evaluation === null) return null;
      // The owning chain resolves through the account's canonical
      // /social-accounts ownership (the /cross-platform-distribution
      // precedent — /clients is not an allowance of this module's row).
      const accountOwnership = await socialAccounts.resolveAccountOwnership(
        evaluation.socialAccountId,
      );
      if (accountOwnership === null) return null;
      return {
        scope: {
          kind: 'platform_health_evaluation' as const,
          agencyId: accountOwnership.scope.agencyId,
          clientId: accountOwnership.scope.clientId,
          evaluationId,
        },
        evaluation,
        resolvedAt: clock.nowIso(),
      };
    },

    async getEvaluationDetail(evaluationId) {
      const evaluation = await store.getEvaluation(evaluationId);
      if (evaluation === null) return null;
      const [evidenceIds, metricObservationIds, publishAttemptIds] = await Promise.all([
        store.listEvidenceIds(evaluationId),
        store.listMetricObservationIds(evaluationId),
        store.listPublishAttemptIds(evaluationId),
      ]);
      return { evaluation, evidenceIds, metricObservationIds, publishAttemptIds };
    },

    async listEvaluationsForAccount(clientId, socialAccountId) {
      if (!UUID_PATTERN.test(socialAccountId)) {
        throw new NotFoundError('social account', socialAccountId);
      }
      // Unknown client → the uniform 404 (resolve through the account
      // ownership chain — a foreign account is not an oracle).
      const ownership = await socialAccounts.resolveAccountOwnership(socialAccountId);
      if (ownership === null || ownership.scope.clientId !== clientId) {
        throw new NotFoundError('social account', socialAccountId);
      }
      return store.listEvaluationsForAccount(clientId, socialAccountId);
    },

    async listEvaluationsForClient(clientId) {
      return store.listEvaluationsForClient(clientId);
    },
  };
}
