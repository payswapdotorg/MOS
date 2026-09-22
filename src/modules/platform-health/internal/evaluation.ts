/**
 * /platform-health pure evaluation core (MKT-066 — the §11 composition
 * rules as DETERMINISTIC pure functions).
 *
 * No clock, no randomness, no network, no I/O: the same observable input
 * snapshot ALWAYS produces the same verdict, reason codes, confidence
 * tier, uncertainty statement, baseline summaries and recommendations
 * (asserted by the unit battery). Every rule consumes ONLY the
 * record-derived observation fields of PlatformHealthEvaluationInput —
 * the input shape has no signal/claim/state channel, so a provider
 * notice with no observable record is structurally inexpressible as a
 * verdict input (§11; lock rules 25/26).
 *
 * The frozen constants (a change to any of them is a new
 * PLATFORM_HEALTH_BASELINE_VERSION):
 *   - MIN_BASELINE_POINTS = 3   — the minimum account-history size before
 *                                 a series may flag (the cold-start gate);
 *   - RECENT_POINTS = 2         — the sustained-deviation window: BOTH of
 *                                 the two most recent quality-passing
 *                                 observations must fall below the ratio;
 *   - ANOMALY_DROP_RATIO = 0.5  — the flag ratio: a recent value flags
 *                                 when it is under HALF the account's own
 *                                 baseline median (never an absolute
 *                                 threshold — the account's OWN history is
 *                                 the reference);
 *   - the cadence rule           — the most recent 24h attempt count at
 *                                 ≥3× the median daily count of the prior
 *                                 6 days (median ≥ 1) flags the automation
 *                                 cadence signal (a WEAK first-party
 *                                 signal — always low confidence);
 *   - the control comparison     — a flagged account series with an
 *                                 unflagged same-name control series on
 *                                 another platform is platform-specific
 *                                 (divergence); flagged controls too mean
 *                                 a client-wide deviation cannot be
 *                                 excluded (the honest uncertainty).
 */

import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import type {
  PlatformHealthBaselineSeriesSummary,
  PlatformHealthConfidence,
  PlatformHealthEvidenceBasisEntry,
  PlatformHealthEvaluationInput,
  PlatformHealthEvaluationResult,
  PlatformHealthManeuver,
  PlatformHealthMetricSeriesObservation,
  PlatformHealthProvenance,
  PlatformHealthPublishAttemptObservation,
  PlatformHealthReasonCode,
  PlatformHealthRecommendation,
  PlatformHealthState,
} from '../public.ts';
import {
  PLATFORM_HEALTH_BASELINE_VERSION,
  PLATFORM_HEALTH_MANEUVER_DESCRIPTIONS,
  PLATFORM_HEALTH_METRIC_NAMESPACE,
  isKnownPlatformHealthReasonCode,
} from '../public.ts';

// ---------------------------------------------------------------------------
// The frozen calculation constants (ph-baseline-v1)
// ---------------------------------------------------------------------------

/** The minimum prior-observation count before a series may flag (the cold-start gate). */
export const PLATFORM_HEALTH_MIN_BASELINE_POINTS = 3 as const;

/** The sustained-deviation window: the most recent points that must ALL be below the ratio. */
export const PLATFORM_HEALTH_RECENT_POINTS = 2 as const;

/** The flag ratio: a recent value flags when < this ratio × the account's own baseline median. */
export const PLATFORM_HEALTH_ANOMALY_DROP_RATIO = 0.5 as const;

/** The bounded reason-code set size (the migration-058 jsonb array CHECK mirror). */
export const PLATFORM_HEALTH_MAX_REASON_CODES = 24 as const;

/** The publish-outcome analysis window: the newest resolved attempts the failure rules consume. */
const PUBLISH_WINDOW = 10 as const;

/** The minimum resolved attempts before the all-failed rule may fire. */
const MIN_RESOLVED_ATTEMPTS = 2 as const;

/** The failure fraction at/below which the partial-failure rule fires (degraded). */
const ELEVATED_FAILURE_FRACTION = 0.5 as const;

/** The cadence rule constants (the automation/inauthenticity first-party signal). */
const CADENCE_RECENT_WINDOW_HOURS = 24 as const;
const CADENCE_BASELINE_WINDOW_DAYS = 6 as const;
const CADENCE_BURST_MULTIPLIER = 3 as const;
const CADENCE_MIN_RECENT_ATTEMPTS = 3 as const;

/** The quality posture excluded from baseline computation (the /metrics 'suspect' taxonomy). */
const SUSPECT_QUALITY = 'suspect' as const;

/**
 * The signal-kind matchers over the provider's OWN verbatim labels (never
 * a provider branch — the patterns read the observable record content):
 *   - automation/inauthenticity platform feedback;
 *   - review/appeal/pending platform process states (the provider itself
 *     says a review is pending — the honest human_review_required basis).
 */
const AUTOMATION_SIGNAL_PATTERN = /automation|spam|bot|inauthentic/i;
const REVIEW_SIGNAL_PATTERN = /review|appeal|pending/i;

// ---------------------------------------------------------------------------
// Provenance validation (the growth-missions guard shape)
// ---------------------------------------------------------------------------

/** Validates the SERVER-DERIVED provenance of one evaluation command. */
export function assertValidPlatformHealthProvenance(provenance: PlatformHealthProvenance): void {
  const problems: string[] = [];
  if (
    typeof provenance.actor !== 'string' ||
    provenance.actor.length === 0 ||
    provenance.actor.length > 100
  ) {
    problems.push('provenance.actor: required, 1..100 characters');
  }
  if (
    typeof provenance.recordedVia !== 'string' ||
    provenance.recordedVia.length === 0 ||
    provenance.recordedVia.length > 100
  ) {
    problems.push('provenance.recordedVia: required, 1..100 characters');
  }
  if (typeof provenance.correlationId !== 'string' || provenance.correlationId.length === 0) {
    problems.push('provenance.correlationId: required');
  }
  if (provenance.causationId !== null && typeof provenance.causationId !== 'string') {
    problems.push('provenance.causationId: null or a string');
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('invalid platform-health provenance', problems);
  }
}

// ---------------------------------------------------------------------------
// The compliant maneuver mapping (§11 as data)
// ---------------------------------------------------------------------------

/**
 * THE DETERMINISTIC STATE → MANEUVER MAP (§11 verbatim — every state's
 * compliant adaptation set; the healthy state recommends nothing). The
 * mapping is pure data: no context, no caller influence. The FORBIDDEN
 * actions (anti-abuse evasion, fake engagement, restriction bypass,
 * impersonation) are structurally absent from the maneuver vocabulary —
 * they can never appear in any recommendation (lock rule 27; asserted by
 * the unit battery).
 */
const STATE_MANEUVERS: Readonly<Record<PlatformHealthState, readonly PlatformHealthManeuver[]>> = {
  healthy: [],
  degraded: ['change_content_mix', 'change_publishing_frequency'],
  restricted: [
    'pause_risky_strategy',
    'platform_appeal_or_review',
    'request_human_interaction',
    'preserve_goal_change_route',
  ],
  suspected_distribution_anomaly: [
    'change_content_mix',
    'adjust_transformations',
    'shift_to_another_connected_platform',
    'preserve_goal_change_route',
  ],
  suspected_automation_risk: [
    'reduce_automation',
    'request_human_interaction',
    'preserve_goal_change_route',
  ],
  authorization_blocked: ['request_human_interaction', 'preserve_goal_change_route'],
  publishing_blocked: [
    'pause_risky_strategy',
    'change_publishing_frequency',
    'platform_appeal_or_review',
    'preserve_goal_change_route',
  ],
  quota_limited: ['change_publishing_frequency', 'preserve_goal_change_route'],
  human_review_required: ['request_human_interaction', 'preserve_goal_change_route'],
};

const STATE_RATIONALES: Readonly<Record<PlatformHealthState, string>> = {
  healthy: 'no compliant maneuver is recommended — the observable signals are clean',
  degraded: 'the observable publish outcomes are mixed — adjust the mix and cadence, then re-evaluate',
  restricted: 'the platform confirmed a restriction — pause, use the platform-provided appeal/review path and keep the goal while changing the route',
  suspected_distribution_anomaly:
    'observable reach deviates from this account\u2019s own baseline without a platform-confirmed restriction — adapt the distribution strategy compliantly',
  suspected_automation_risk:
    'automation-risk signals are observable — reduce automation and let a human decide the posture',
  authorization_blocked: 'the account authorization is not usable — a human must re-authorize before anything else',
  publishing_blocked: 'publishing is observably failing — pause the flow, re-check the request shape and use the platform-provided review path',
  quota_limited: 'the platform quota is observably exhausted — change the publishing frequency and wait out the window',
  human_review_required: 'the observable records cannot be resolved deterministically — a human must interpret them',
};

/** The compliant recommendations of one state (pure; §11 maneuver list as data). */
export function recommendationsForPlatformHealthState(
  state: PlatformHealthState,
): readonly PlatformHealthRecommendation[] {
  return STATE_MANEUVERS[state].map((maneuver) => ({
    maneuver,
    description: PLATFORM_HEALTH_MANEUVER_DESCRIPTIONS[maneuver],
    rationale: STATE_RATIONALES[state],
  }));
}

// ---------------------------------------------------------------------------
// Baseline computation (ph-baseline-v1)
// ---------------------------------------------------------------------------

interface SeriesAnalysis {
  readonly summary: PlatformHealthBaselineSeriesSummary;
  /** The observation ids the flag consumed (recent + baseline points). */
  readonly consumedObservationIds: readonly string[];
  /** The /evidence anchors of the consumed observations. */
  readonly consumedEvidenceRefs: readonly string[];
}

/** The deterministic median of a non-empty numeric list. */
function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function parseEpochMs(stamp: string): number {
  const parsed = Date.parse(stamp);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Analyzes ONE series against the account's OWN history: the
 * quality-passing observations are split into the ≥3 PRIOR points (the
 * baseline) and the ≤2 most RECENT points; the series flags when EVERY
 * recent point is under ANOMALY_DROP_RATIO × the baseline median. A
 * series with fewer than MIN_BASELINE_POINTS prior observations (or
 * fewer recent points than the sustained window) is INSUFFICIENT — the
 * honest cold-start disclosure, never a flag.
 */
function analyzeSeries(series: PlatformHealthMetricSeriesObservation): SeriesAnalysis {
  const qualityPassing = series.observations.filter((point) => point.quality !== SUSPECT_QUALITY);
  const suspectExcluded = series.observations.length - qualityPassing.length;

  const prior = qualityPassing.slice(0, Math.max(qualityPassing.length - PLATFORM_HEALTH_RECENT_POINTS, 0));
  const recent = qualityPassing.slice(Math.max(qualityPassing.length - PLATFORM_HEALTH_RECENT_POINTS, 0));

  const participates = series.metricName.startsWith(PLATFORM_HEALTH_METRIC_NAMESPACE);
  const hasBaseline = prior.length >= PLATFORM_HEALTH_MIN_BASELINE_POINTS;
  const hasSustainedRecent = recent.length >= PLATFORM_HEALTH_RECENT_POINTS;

  let baselineMedian: number | null = null;
  let flagged = false;
  if (participates && hasBaseline && hasSustainedRecent) {
    baselineMedian = medianOf(prior.map((point) => point.value));
    if (baselineMedian > 0) {
      flagged = recent.every((point) => point.value < baselineMedian! * PLATFORM_HEALTH_ANOMALY_DROP_RATIO);
    }
  }

  const consumed = flagged
    ? [...prior, ...recent].map((point) => point.observationId)
    : recent.map((point) => point.observationId);
  const consumedEvidence = (flagged ? [...prior, ...recent] : recent)
    .map((point) => point.evidenceRef)
    .filter((ref): ref is string => ref !== null);

  return {
    summary: {
      metricName: series.metricName,
      scope: series.scope,
      priorPoints: prior.length,
      baselineMedian,
      recentValues: recent.map((point) => point.value),
      suspectExcluded,
      flaggedBelowBaseline: flagged,
      insufficientBaseline: participates && !hasBaseline,
    },
    consumedObservationIds: consumed,
    consumedEvidenceRefs: consumedEvidence,
  };
}

// ---------------------------------------------------------------------------
// The cadence rule (the first-party automation signal)
// ---------------------------------------------------------------------------

interface CadenceAnalysis {
  readonly flagged: boolean;
  readonly recentCount: number;
  readonly baselineMedianDaily: number;
}

/**
 * The observable posting-cadence rule: the account's own publish-attempt
 * timestamps are the first-party metric. The cadence flags when the most
 * recent 24h window holds ≥ CADENCE_BURST_MULTIPLIER × the median daily
 * count of the prior 6 days AND at least CADENCE_MIN_RECENT_ATTEMPTS
 * attempts. A WEAK signal by construction (a campaign launch looks the
 * same) — it only ever feeds suspected_automation_risk at LOW confidence
 * with the honest uncertainty statement.
 */
function analyzeCadence(
  attempts: readonly PlatformHealthPublishAttemptObservation[],
  evaluatedAtMs: number,
): CadenceAnalysis {
  const stamps = attempts.map((attempt) => parseEpochMs(attempt.recordedAt)).filter((ms) => ms > 0);
  const dayMs = 24 * 60 * 60 * 1000;
  const recentFloor = evaluatedAtMs - CADENCE_RECENT_WINDOW_HOURS * 60 * 60 * 1000;
  const baselineFloor = evaluatedAtMs - dayMs - CADENCE_BASELINE_WINDOW_DAYS * dayMs;

  const recentCount = stamps.filter((ms) => ms > recentFloor && ms <= evaluatedAtMs).length;
  const dailyCounts: number[] = [];
  for (let day = 1; day <= CADENCE_BASELINE_WINDOW_DAYS; day += 1) {
    const from = evaluatedAtMs - (day + 1) * dayMs;
    const to = evaluatedAtMs - day * dayMs;
    dailyCounts.push(stamps.filter((ms) => ms > from && ms <= to).length);
  }
  const baselineMedianDaily = dailyCounts.length > 0 ? medianOf(dailyCounts) : 0;
  void baselineFloor;

  const flagged =
    recentCount >= CADENCE_MIN_RECENT_ATTEMPTS &&
    baselineMedianDaily >= 1 &&
    recentCount >= baselineMedianDaily * CADENCE_BURST_MULTIPLIER;

  return { flagged, recentCount, baselineMedianDaily };
}

// ---------------------------------------------------------------------------
// The state rules (the fail-closed precedence)
// ---------------------------------------------------------------------------

interface RuleOutcome {
  readonly state: PlatformHealthState;
  readonly reasonCodes: PlatformHealthReasonCode[];
  readonly confidence: PlatformHealthConfidence;
  readonly evidenceBasis: PlatformHealthEvidenceBasisEntry[];
}

/**
 * Rule 1 — AUTHORIZATION BLOCKED: the terminal 055 account states, the
 * dead grant states, the lazy-expiry unusable read and the dead
 * integration pipe. Direct durable records — high confidence (medium
 * when only the lazy unusable read is observable).
 */
function evaluateAuthorization(input: PlatformHealthEvaluationInput): RuleOutcome | null {
  const reasons: PlatformHealthReasonCode[] = [];
  const basis: PlatformHealthEvidenceBasisEntry[] = [];
  const account = input.account;

  if (account.status === 'disconnected' || account.status === 'revoked') {
    reasons.push(account.status === 'disconnected' ? 'account_disconnected' : 'account_revoked');
    basis.push({
      kind: 'account_record',
      socialAccountId: account.socialAccountId,
      observedFact: `account.status=${account.status}`,
    });
  }
  if (account.grantState === 'expired' || account.grantState === 'revoked') {
    reasons.push(account.grantState === 'expired' ? 'grant_state_expired' : 'grant_state_revoked');
    if (account.grantId !== null) {
      basis.push({
        kind: 'grant_record',
        grantId: account.grantId,
        observedFact: `grant.state=${account.grantState}`,
      });
    }
  }
  if (account.connectionStatus !== 'connected') {
    reasons.push('integration_connection_not_connected');
    basis.push({
      kind: 'connection_record',
      connectionId: account.connectionId,
      observedFact: `connection.status=${account.connectionStatus}`,
    });
  }
  if (!account.authorizationUsable && reasons.length === 0) {
    // The lazy fail-closed read is the only observable (e.g. token expiry
    // passed): an inference, not a terminal record — medium confidence.
    reasons.push('authorization_unusable');
    basis.push({
      kind: 'account_record',
      socialAccountId: account.socialAccountId,
      observedFact: 'usableAuthorization=null',
    });
  }

  if (reasons.length === 0) return null;
  const terminalRecordObserved =
    account.status !== 'connected' || account.grantState === 'expired' || account.grantState === 'revoked' || account.connectionStatus !== 'connected';
  return {
    state: 'authorization_blocked',
    reasonCodes: reasons,
    confidence: terminalRecordObserved ? 'high' : 'medium',
    evidenceBasis: basis,
  };
}

/**
 * Rule 2 — RESTRICTED: platform-CONFIRMED restriction records ONLY — the
 * provider-exposed restriction signals retained on the 056 attempt/status
 * records, and the 056 'restricted' terminal outcome (the provider's own
 * refusal). Lock rule 26: an explicit restriction is REQUIRED for this
 * state; observable-only anomaly evidence never reaches here.
 */
function evaluateRestricted(input: PlatformHealthEvaluationInput): RuleOutcome | null {
  const reasons: PlatformHealthReasonCode[] = [];
  const basis: PlatformHealthEvidenceBasisEntry[] = [];

  for (const attempt of input.publishAttempts) {
    for (const signal of attempt.restrictionSignals) {
      if (AUTOMATION_SIGNAL_PATTERN.test(signal.signalKind)) continue;
      if (REVIEW_SIGNAL_PATTERN.test(signal.signalKind)) continue;
      reasons.push('platform_confirmed_restriction_signal');
      basis.push({
        kind: 'restriction_signal',
        signalKind: signal.signalKind,
        source: `publish_attempt:${attempt.attemptId}`,
        observedFact: 'provider-exposed restriction signal on the publish record',
      });
    }
    if (attempt.publishState === 'restricted') {
      reasons.push('restricted_publish_outcome_observed');
      basis.push({
        kind: 'publish_attempt',
        attemptId: attempt.attemptId,
        observedFact: 'publishState=restricted',
      });
    }
  }
  for (const poll of input.statusPolls) {
    for (const signal of poll.restrictionSignals) {
      if (AUTOMATION_SIGNAL_PATTERN.test(signal.signalKind)) continue;
      if (REVIEW_SIGNAL_PATTERN.test(signal.signalKind)) continue;
      reasons.push('platform_confirmed_restriction_signal');
      basis.push({
        kind: 'restriction_signal',
        signalKind: signal.signalKind,
        source: `status_poll:${poll.observationId}`,
        observedFact: 'provider-exposed restriction signal on the status poll',
      });
    }
    if (poll.publishState === 'restricted') {
      reasons.push('restricted_publish_outcome_observed');
      basis.push({
        kind: 'status_poll',
        observationId: poll.observationId,
        observedFact: 'polled publishState=restricted',
      });
    }
  }

  if (reasons.length === 0) return null;
  return {
    state: 'restricted',
    reasonCodes: reasons,
    confidence: 'high',
    evidenceBasis: basis,
  };
}

/**
 * Rule 3 — HUMAN REVIEW REQUIRED: the observable records the
 * deterministic rules cannot resolve — (a) provider signals whose own
 * labels say a review/appeal/pending process is underway (the platform
 * itself requires review), (b) CONFLICTING authorization observations
 * (the grant chain reads usable while the attempts record auth-expired
 * failures). Both are honest "a human must interpret this" states.
 */
function evaluateHumanReview(input: PlatformHealthEvaluationInput): RuleOutcome | null {
  const reasons: PlatformHealthReasonCode[] = [];
  const basis: PlatformHealthEvidenceBasisEntry[] = [];

  for (const attempt of input.publishAttempts) {
    for (const signal of attempt.restrictionSignals) {
      if (AUTOMATION_SIGNAL_PATTERN.test(signal.signalKind)) continue;
      if (REVIEW_SIGNAL_PATTERN.test(signal.signalKind)) {
        reasons.push('platform_review_pending_signal');
        basis.push({
          kind: 'restriction_signal',
          signalKind: signal.signalKind,
          source: `publish_attempt:${attempt.attemptId}`,
          observedFact: 'provider-exposed review/pending process signal',
        });
      }
    }
  }
  for (const poll of input.statusPolls) {
    for (const signal of poll.restrictionSignals) {
      if (AUTOMATION_SIGNAL_PATTERN.test(signal.signalKind)) continue;
      if (REVIEW_SIGNAL_PATTERN.test(signal.signalKind)) {
        reasons.push('platform_review_pending_signal');
        basis.push({
          kind: 'restriction_signal',
          signalKind: signal.signalKind,
          source: `status_poll:${poll.observationId}`,
          observedFact: 'provider-exposed review/pending process signal',
        });
      }
    }
  }

  // The authorization conflict: the account/grant chain reads usable, but
  // the attempt records say the provider refused with auth-expired.
  const authExpiredFailures = input.publishAttempts.filter(
    (attempt) => attempt.publishState === 'failed' && attempt.failureCode === 'auth-expired',
  );
  if (
    authExpiredFailures.length > 0 &&
    input.account.status === 'connected' &&
    input.account.authorizationUsable
  ) {
    reasons.push('conflicting_authorization_observations');
    for (const attempt of authExpiredFailures.slice(0, 3)) {
      basis.push({
        kind: 'publish_attempt',
        attemptId: attempt.attemptId,
        observedFact: 'failureCode=auth-expired while the grant chain reads usable',
      });
    }
  }

  if (reasons.length === 0) return null;
  const platformSignalled = reasons.includes('platform_review_pending_signal');
  return {
    state: 'human_review_required',
    reasonCodes: reasons,
    confidence: platformSignalled ? 'high' : 'low',
    evidenceBasis: basis,
  };
}

/**
 * Rule 4 — SUSPECTED AUTOMATION RISK: the automation/inauthenticity
 * platform feedback (the provider's own signal labels — high confidence)
 * or the first-party cadence burst above the account's own posting
 * baseline (a WEAK signal — low confidence, honest uncertainty).
 */
function evaluateAutomationRisk(
  input: PlatformHealthEvaluationInput,
  cadence: CadenceAnalysis,
): RuleOutcome | null {
  const reasons: PlatformHealthReasonCode[] = [];
  const basis: PlatformHealthEvidenceBasisEntry[] = [];
  let confidence: PlatformHealthConfidence = 'low';

  for (const attempt of input.publishAttempts) {
    for (const signal of attempt.restrictionSignals) {
      if (!AUTOMATION_SIGNAL_PATTERN.test(signal.signalKind)) continue;
      reasons.push('platform_automation_risk_signal');
      confidence = 'high';
      basis.push({
        kind: 'restriction_signal',
        signalKind: signal.signalKind,
        source: `publish_attempt:${attempt.attemptId}`,
        observedFact: 'provider-exposed automation/inauthenticity feedback signal',
      });
    }
  }
  for (const poll of input.statusPolls) {
    for (const signal of poll.restrictionSignals) {
      if (!AUTOMATION_SIGNAL_PATTERN.test(signal.signalKind)) continue;
      reasons.push('platform_automation_risk_signal');
      confidence = 'high';
      basis.push({
        kind: 'restriction_signal',
        signalKind: signal.signalKind,
        source: `status_poll:${poll.observationId}`,
        observedFact: 'provider-exposed automation/inauthenticity feedback signal',
      });
    }
  }
  if (cadence.flagged) {
    reasons.push('observed_cadence_above_baseline');
    basis.push({
      kind: 'account_record',
      socialAccountId: input.account.socialAccountId,
      observedFact: `cadence=${cadence.recentCount} attempts/24h vs baseline median ${cadence.baselineMedianDaily}/day`,
    });
  }

  if (reasons.length === 0) return null;
  return { state: 'suspected_automation_risk', reasonCodes: reasons, confidence, evidenceBasis: basis };
}

/**
 * Rule 5 — PUBLISHING BLOCKED: every RESOLVED attempt in the observable
 * window failed (publishing errors — §11), with no restricted outcome
 * (rule 2 owns that) and no unresolved 'submitted' attempts counted as
 * failure (UNKNOWN is never failure).
 */
function evaluatePublishingBlocked(input: PlatformHealthEvaluationInput): RuleOutcome | null {
  const resolved = input.publishAttempts
    .filter((attempt) => attempt.publishState !== 'submitted' && attempt.publishState !== 'restricted')
    .slice(0, PUBLISH_WINDOW);
  const failed = resolved.filter((attempt) => attempt.publishState === 'failed');
  if (resolved.length < MIN_RESOLVED_ATTEMPTS || failed.length !== resolved.length) return null;

  return {
    state: 'publishing_blocked',
    reasonCodes: ['recent_publish_attempts_all_failed'],
    confidence: 'medium',
    evidenceBasis: failed.slice(0, PUBLISH_WINDOW).map((attempt) => ({
      kind: 'publish_attempt' as const,
      attemptId: attempt.attemptId,
      observedFact: `publishState=failed (failureCode=${attempt.failureCode ?? 'unrecorded'})`,
    })),
  };
}

/**
 * Rule 6 — QUOTA LIMITED: the observed rate-limit/backoff records in
 * force (the 056 rate-limit observations: a future backoffUntil, a
 * positive retryAfter, an exhausted limitRemaining) or the provider's
 * own 'rate-limited' failure code on the newest resolved attempt.
 */
function evaluateQuotaLimited(input: PlatformHealthEvaluationInput, evaluatedAtMs: number): RuleOutcome | null {
  const reasons: PlatformHealthReasonCode[] = [];
  const basis: PlatformHealthEvidenceBasisEntry[] = [];

  const newest = input.publishAttempts[0];
  if (newest !== undefined && newest.rateLimit !== null) {
    const { limitRemaining, backoffUntil, retryAfterSeconds } = newest.rateLimit;
    const backoffInForce = backoffUntil !== null && parseEpochMs(backoffUntil) > evaluatedAtMs;
    const retryInForce = retryAfterSeconds !== null && retryAfterSeconds > 0;
    const exhausted = limitRemaining === 0;
    if (backoffInForce) {
      reasons.push('backoff_in_force');
      basis.push({
        kind: 'publish_attempt',
        attemptId: newest.attemptId,
        observedFact: `backoffUntil=${backoffUntil}`,
      });
    } else if (retryInForce) {
      reasons.push('backoff_in_force');
      basis.push({
        kind: 'publish_attempt',
        attemptId: newest.attemptId,
        observedFact: `retryAfterSeconds=${retryAfterSeconds}`,
      });
    } else if (exhausted) {
      reasons.push('rate_limit_observed');
      basis.push({
        kind: 'publish_attempt',
        attemptId: newest.attemptId,
        observedFact: 'rateLimit.limitRemaining=0',
      });
    }
  }
  const rateLimitedFailure = input.publishAttempts.find(
    (attempt) => attempt.publishState === 'failed' && attempt.failureCode === 'rate-limited',
  );
  if (rateLimitedFailure !== undefined && !reasons.includes('rate_limit_observed')) {
    reasons.push('rate_limit_observed');
    basis.push({
      kind: 'publish_attempt',
      attemptId: rateLimitedFailure.attemptId,
      observedFact: 'failureCode=rate-limited',
    });
  }

  if (reasons.length === 0) return null;
  return { state: 'quota_limited', reasonCodes: reasons, confidence: 'high', evidenceBasis: basis };
}

/**
 * Rule 7 — SUSPECTED DISTRIBUTION ANOMALY: the observable-only anomaly
 * evidence — the account's own series flagged below baseline WITHOUT any
 * platform-confirmed restriction (rules 2/3 already declined). NEVER a
 * shadow-ban claim (lock rule 26): the state name says exactly what the
 * evidence is. Cross-platform controls sharpen the honesty: an unflagged
 * same-name control on another platform makes the deviation
 * platform-specific (medium confidence); flagged or absent controls keep
 * it low with the honest uncertainty note.
 */
function evaluateDistributionAnomaly(
  input: PlatformHealthEvaluationInput,
  analyses: readonly SeriesAnalysis[],
): RuleOutcome | null {
  const flagged = analyses.filter(
    (analysis) => analysis.summary.scope === 'account' && analysis.summary.flaggedBelowBaseline,
  );
  if (flagged.length === 0) return null;

  const reasons: PlatformHealthReasonCode[] = ['observed_metric_deviation_below_baseline'];
  const basis: PlatformHealthEvidenceBasisEntry[] = [];
  for (const analysis of flagged) {
    for (const observationId of analysis.consumedObservationIds) {
      basis.push({
        kind: 'metric_observation',
        observationId,
        metricName: analysis.summary.metricName,
        observedFact: `sustained deviation below the account\u2019s own baseline median ${analysis.summary.baselineMedian}`,
      });
    }
  }

  const sameNameControls = analyses.filter(
    (analysis) =>
      analysis.summary.scope === 'control' &&
      flagged.some((account) => account.summary.metricName === analysis.summary.metricName),
  );
  const unflaggedControls = sameNameControls.filter((control) => !control.summary.flaggedBelowBaseline);
  const flaggedControls = sameNameControls.filter((control) => control.summary.flaggedBelowBaseline);
  if (sameNameControls.length > 0 && unflaggedControls.length > 0 && flaggedControls.length === 0) {
    reasons.push('cross_platform_control_divergence');
  }

  return {
    state: 'suspected_distribution_anomaly',
    reasonCodes: reasons,
    confidence:
      sameNameControls.length > 0 && unflaggedControls.length > 0 && flaggedControls.length === 0
        ? 'medium'
        : 'low',
    evidenceBasis: basis,
  };
}

/**
 * Rule 8 — DEGRADED: the elevated publish-failure fraction — some
 * resolved attempts failed (≥ ELEVATED_FAILURE_FRACTION) but not all
 * (rule 5 owns all-failed).
 */
function evaluateDegraded(input: PlatformHealthEvaluationInput): RuleOutcome | null {
  const resolved = input.publishAttempts
    .filter((attempt) => attempt.publishState !== 'submitted' && attempt.publishState !== 'restricted')
    .slice(0, PUBLISH_WINDOW);
  if (resolved.length < MIN_RESOLVED_ATTEMPTS) return null;
  const failed = resolved.filter((attempt) => attempt.publishState === 'failed');
  if (failed.length === resolved.length) return null;
  if (failed.length / resolved.length < ELEVATED_FAILURE_FRACTION) return null;

  return {
    state: 'degraded',
    reasonCodes: ['elevated_publish_failure_rate'],
    confidence: 'medium',
    evidenceBasis: failed.slice(0, PUBLISH_WINDOW).map((attempt) => ({
      kind: 'publish_attempt' as const,
      attemptId: attempt.attemptId,
      observedFact: `publishState=failed (failureCode=${attempt.failureCode ?? 'unrecorded'})`,
    })),
  };
}

// ---------------------------------------------------------------------------
// THE EVALUATION (the deterministic composition)
// ---------------------------------------------------------------------------

/**
 * Evaluates one account's platform health from the observable input
 * snapshot — the §11 composition as a PURE function. Same inputs, same
 * verdict, same basis, same uncertainty (unit-asserted). The
 * fail-closed precedence: authorization → restricted (platform-confirmed)
 * → human review (platform review signals / auth conflicts) → automation
 * risk → publishing blocked → quota → distribution anomaly (observable
 * only) → degraded → healthy.
 */
export function evaluatePlatformHealth(
  input: PlatformHealthEvaluationInput,
): PlatformHealthEvaluationResult {
  const evaluatedAtMs = parseEpochMs(input.evaluatedAt);
  const analyses = input.metricSeries.map((series) => analyzeSeries(series));
  const cadence = analyzeCadence(input.publishAttempts, evaluatedAtMs);

  const outcome =
    evaluateAuthorization(input) ??
    evaluateRestricted(input) ??
    evaluateHumanReview(input) ??
    evaluateAutomationRisk(input, cadence) ??
    evaluatePublishingBlocked(input) ??
    evaluateQuotaLimited(input, evaluatedAtMs) ??
    evaluateDistributionAnomaly(input, analyses) ??
    evaluateDegraded(input) ??
    null;

  const accountSeries = analyses.filter((analysis) => analysis.summary.scope === 'account');
  const anyAccountSeriesInsufficient = accountSeries.some(
    (analysis) => analysis.summary.insufficientBaseline,
  );
  const anyObservableRecords =
    input.publishAttempts.length > 0 ||
    accountSeries.some((analysis) => analysis.summary.priorPoints + analysis.summary.recentValues.length > 0);

  // --- the healthy / fall-through posture with its HONEST basis ---
  const state: PlatformHealthState = outcome?.state ?? 'healthy';
  const reasonCodes: PlatformHealthReasonCode[] = outcome?.reasonCodes ?? [
    anyObservableRecords ? 'no_negative_observable_signals' : 'no_observable_records',
  ];
  if (outcome === null && anyAccountSeriesInsufficient) {
    reasonCodes.push('insufficient_baseline');
  }
  const confidence: PlatformHealthConfidence =
    outcome?.confidence ??
    (anyObservableRecords && !anyAccountSeriesInsufficient ? 'high' : 'low');
  const evidenceBasis: PlatformHealthEvidenceBasisEntry[] = outcome?.evidenceBasis ?? [
    {
      kind: 'account_record',
      socialAccountId: input.account.socialAccountId,
      observedFact: anyObservableRecords
        ? 'no negative observable signals in the composed window'
        : 'no observable records in the composed window',
    },
  ];

  // --- the uncertainty statement (deterministic, evidence-derived) ---
  const uncertaintyParts: string[] = [];
  if (state === 'suspected_distribution_anomaly') {
    const flagged = analyses.filter(
      (analysis) => analysis.summary.scope === 'account' && analysis.summary.flaggedBelowBaseline,
    );
    for (const analysis of flagged) {
      uncertaintyParts.push(
        `series ${analysis.summary.metricName}: recent [${analysis.summary.recentValues.join(', ')}] vs the account's own baseline median ${analysis.summary.baselineMedian} over ${analysis.summary.priorPoints} prior observations`,
      );
    }
    const sameNameControls = analyses.filter(
      (analysis) =>
        analysis.summary.scope === 'control' &&
        flagged.some((account) => account.summary.metricName === analysis.summary.metricName),
    );
    if (sameNameControls.length === 0) {
      uncertaintyParts.push('no cross-platform control series was available — a client-wide cause cannot be excluded');
    } else if (sameNameControls.some((control) => control.summary.flaggedBelowBaseline)) {
      uncertaintyParts.push('cross-platform controls show similar deviation — a client-wide cause cannot be excluded');
    } else {
      uncertaintyParts.push('cross-platform controls show no similar deviation — the deviation is platform-specific');
    }
    uncertaintyParts.push('observable anomaly evidence without a platform-confirmed restriction — never a shadow-ban claim');
  } else if (outcome === null && anyAccountSeriesInsufficient) {
    uncertaintyParts.push(
      `insufficient baseline for anomaly detection (fewer than ${PLATFORM_HEALTH_MIN_BASELINE_POINTS} prior observations per series) — no anomaly verdict is produced`,
    );
  } else if (outcome === null && !anyObservableRecords) {
    uncertaintyParts.push(
      'no observable records in the composed window — the state reflects the absence of negative signals only',
    );
  }
  if (cadence.flagged && state !== 'suspected_automation_risk') {
    uncertaintyParts.push(
      `posting cadence ${cadence.recentCount}/24h vs baseline median ${cadence.baselineMedianDaily}/day is elevated`,
    );
  }
  if (!input.account.socialAdapterRegistered) {
    uncertaintyParts.push(
      'no social platform adapter is registered for this platform — publish-capability signals are unobservable through MOS',
    );
  }
  // The experiment confounders: active experiments measuring a flagged
  // series may explain its deviation (attribution ≠ causal inference).
  const flaggedNames = new Set(
    analyses
      .filter((analysis) => analysis.summary.flaggedBelowBaseline)
      .map((analysis) => analysis.summary.metricName),
  );
  const confounderExperiments = input.experiments.filter(
    (experiment) => experiment.status === 'running' && flaggedNames.has(experiment.primaryMetricName),
  );
  for (const experiment of confounderExperiments) {
    uncertaintyParts.push(
      `active experiment ${experiment.experimentId} measures ${experiment.primaryMetricName} — the deviation may be treatment-caused (attribution is distinct from causal inference)`,
    );
  }
  const uncertainty =
    uncertaintyParts.length > 0 ? uncertaintyParts.join('; ') : 'the observable evidence supports the state directly';

  // --- the recommendations (the §11 maneuver list as data) ---
  const recommendations = recommendationsForPlatformHealthState(state);

  // --- the composition disclosure ---
  const signalsConsidered: Record<string, unknown> = {
    evaluatedAt: input.evaluatedAt,
    accountStatus: input.account.status,
    grantState: input.account.grantState,
    authorizationUsable: input.account.authorizationUsable,
    connectionStatus: input.account.connectionStatus,
    socialAdapterRegistered: input.account.socialAdapterRegistered,
    publishAttemptsConsidered: input.publishAttempts.length,
    statusPollsConsidered: input.statusPolls.length,
    metricSeriesConsidered: input.metricSeries.length,
    accountSeriesWithBaseline: accountSeries.filter((analysis) => analysis.summary.priorPoints >= PLATFORM_HEALTH_MIN_BASELINE_POINTS).length,
    controlSeriesConsidered: analyses.filter((analysis) => analysis.summary.scope === 'control').length,
    activeExperimentsConsidered: input.experiments.filter((experiment) => experiment.status === 'running').length,
    cadenceRecentCount: cadence.recentCount,
    cadenceBaselineMedianDaily: cadence.baselineMedianDaily,
  };

  // --- the invariants (the closed vocabularies are never violated) ---
  const uniqueReasonCodes = [...new Set(reasonCodes)];
  if (uniqueReasonCodes.length > PLATFORM_HEALTH_MAX_REASON_CODES) {
    throw new InvalidRequestError('platform-health evaluation produced an unbounded reason-code set', [
      `reason codes: ${uniqueReasonCodes.length} > ${PLATFORM_HEALTH_MAX_REASON_CODES}`,
    ]);
  }
  for (const code of uniqueReasonCodes) {
    if (!isKnownPlatformHealthReasonCode(code)) {
      throw new InvalidRequestError('platform-health evaluation produced an unknown reason code', [
        `reason code '${code}' is not in ph-vocab-v1`,
      ]);
    }
  }

  return {
    state,
    reasonCodes: uniqueReasonCodes,
    confidence,
    uncertainty,
    baselineVersion: PLATFORM_HEALTH_BASELINE_VERSION,
    baseline: analyses.map((analysis) => analysis.summary),
    recommendations,
    evidenceBasis,
    signalsConsidered,
  };
}
