/**
 * MarketingOS module: /platform-health
 * Authority: Platform Health and Distribution Anomaly Detection (MKT-066 —
 * spec/effective-backlog-v1.6.md: "detect observable reach collapse,
 * restrictions, publishing failures, quota blocks and
 * automation/inauthenticity-risk signals without inventing hidden
 * moderation state"; spec/architecture-v1.6.md §11 — the primary contract:
 * "MOS does not claim access to hidden platform moderation state unless a
 * platform explicitly exposes it. Platform Health is composed from
 * platform-reported restrictions, publishing errors, policy/eligibility
 * signals, copyright/claim signals, recommendation/distribution metrics
 * where available, non-follower reach, search/recommendation impressions
 * where available, engagement and retention, deviations from the account's
 * historical baseline, cross-platform control comparisons, and
 * automation/inauthenticity risk signals observable from first-party
 * metrics or connected platform feedback"; spec/architecture-lock-v1.6.md
 * rules 25 ("Platform Health describes observable signals and must not
 * fabricate hidden moderation state"), 26 ("Shadow-ban claims are
 * represented as suspected distribution anomalies unless the platform
 * itself exposes an explicit restriction") and 27 ("Maneuvering around
 * platform blockers means compliant strategy adaptation only; evasion,
 * fake engagement, anti-abuse bypass and human impersonation are
 * forbidden"); spec/module-dependency-matrix-v1.6.md boundary rule 6
 * ("Platform Health describes observable signals and cannot fabricate
 * provider-side moderation decisions")).
 *
 * This module owns the DESCRIPTIVE HEALTH EVALUATION layer:
 *
 *   - HEALTH IS COMPOSED, NEVER INVENTED. Every evaluation input is an
 *     OBSERVABLE RECORD fetched through the five frozen-row public
 *     contracts (/social-accounts: the account/grant/authorization facts,
 *     the 056 publish-attempt invocation records with their
 *     provider-exposed restriction signals and rate-limit observations,
 *     the per-attempt status-poll history; /integrations: the connection
 *     operational state; /metrics: the account's own metric-observation
 *     history; /evidence: the evidence anchors behind the consumed
 *     observations; /experiments: the active-experiment confounder
 *     context). The evaluation input contract has NO signal, state, claim
 *     or verdict field — a provider notice with no observable record is
 *     STRUCTURALLY INEXPRESSIBLE as a verdict input (§11; lock rules
 *     25/26; proven by the unit observable-signals-only battery).
 *   - THE FROZEN NINE DESCRIPTIVE STATES (§11 verbatim, a closed
 *     vocabulary CHECK-fenced in migration 058): healthy, degraded,
 *     restricted, suspected_distribution_anomaly,
 *     suspected_automation_risk, authorization_blocked,
 *     publishing_blocked, quota_limited, human_review_required. There is
 *     deliberately NO "shadow-banned" state or synonym anywhere in this
 *     module (lock rule 26 — asserted by the boundary tests): where only
 *     observable anomaly evidence exists the honest state is
 *     suspected_distribution_anomaly; "restricted" is reserved for
 *     platform-CONFIRMED restriction records.
 *   - BASELINE-RELATIVE ANOMALY DETECTION ('ph-baseline-v1'): an anomaly
 *     is a deviation from the ACCOUNT'S OWN historical baseline — the
 *     retained /metrics observations of that account's series — never an
 *     absolute threshold invented without a baseline. A series flags
 *     below-baseline only when the two most recent quality-passing
 *     observations BOTH fall under half the median of the account's own
 *     ≥3 prior observations (a sustained deviation, not a single dip).
 *     Cold-start (no established baseline) produces the HONEST
 *     insufficient-baseline disclosure — never a fabricated verdict.
 *   - DESCRIPTIVE REASON CODES + CONFIDENCE/UNCERTAINTY: every state
 *     carries its evidence basis (which observable records produced it),
 *     a closed-vocabulary reason-code set and a coarse
 *     high/medium/low confidence tier derived deterministically from the
 *     evidence counts — never a probability invented from nothing — plus
 *     an explicit uncertainty statement (baseline sizes, control
 *     availability, confounders, observability gaps).
 *   - COMPLIANT RESPONSE RECOMMENDATIONS AS DATA: the §11 maneuver list
 *     (change content mix/frequency, pause a risky strategy, shift
 *     activity to another connected platform, adjust transformations,
 *     reduce automation, request human interaction, appeal/review where
 *     the platform provides it, preserve the goal while changing the
 *     route) as a frozen maneuver vocabulary mapped deterministically per
 *     state. The FORBIDDEN list — anti-abuse evasion, fake engagement,
 *     restriction bypass, impersonation — is structurally absent from the
 *     recommendation vocabulary (never emitted; asserted by the unit
 *     battery and the boundary tests).
 *   - DURABLE STATE in the module's OWN migration-058 tables: the
 *     append-only evaluation records with full provenance + the FK-anchored
 *     same-Client evidence/metric/publish-attempt link tables (the
 *     063/064 table discipline: CHECK-fenced vocabularies, append-only
 *     UPDATE/DELETE rejection triggers, CHECK-ONLY reads of the anchored
 *     authority tables).
 *
 * What it is NOT (the bounded scope):
 *
 *   - NO hidden-moderation invention: the module interprets ONLY records
 *     the platform exposed through the composed surfaces; it never
 *     guesses provider-side moderation state (lock rule 25).
 *   - NO enforcement: the evaluation describes; it never pauses,
 *     blocks or mutates an account, plan, mission or experiment. The
 *     consumers (MKT-070+ planners, the Growth Operator, UX-007) decide.
 *   - NO second authority: no account registry (055 stays sole), no
 *     publish ledger (056 stays sole), no metrics authority (/metrics
 *     stays sole), no evidence authority (/evidence stays sole), no
 *     experiment authority (/experiments stays sole).
 *   - NO provider knowledge: platform identity is the account record's
 *     platform id carried as data; the evaluation rules are
 *     provider-independent (the frozen-row discipline — the module never
 *     branches on a specific platform).
 *
 * DEPENDENCY POSTURE (the frozen v1.6 matrix row registered by this Work
 * Item: /platform-health ──→ /social-accounts, /integrations, /metrics,
 * /evidence, /experiments — verbatim, all five consumed through their
 * public contracts READ-ONLY). The 065 distribution publications reach
 * this module as the per-account 056 publish-attempt records (the 056
 * idempotency ledger IS the only physical publish path — the 065 module
 * routes every destination publication through submitPublish and its
 * publication records anchor those attempt ids), so the observable
 * publication-outcome surface is complete without a
 * /cross-platform-distribution dependency (that direction is NOT an
 * allowance of this module's frozen row).
 *
 * Cross-module access may only target this public entry (public.ts) —
 * internal/ is unimportable from other modules (enforced by the static
 * architecture checker, tools/arch-check).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import type { EvidenceModuleApi } from '../evidence/public.ts';
import type { ExperimentsModuleApi } from '../experiments/public.ts';
import type { IntegrationsModuleApi } from '../integrations/public.ts';
import type { MetricsModuleApi } from '../metrics/public.ts';
import type { SocialAccountsModuleApi } from '../social-accounts/public.ts';

// ---------------------------------------------------------------------------
// The frozen vocabularies (architecture-v1.6.md §11 — CHECK-fenced in
// migration 058; pinned by unit + boundary tests)
// ---------------------------------------------------------------------------

/**
 * THE FROZEN NINE DESCRIPTIVE STATES (§11 verbatim — the closed
 * vocabulary; lock rules 25/26). `restricted` requires a
 * platform-CONFIRMED restriction record; observable-only anomaly evidence
 * is `suspected_distribution_anomaly` — there is no "shadow-banned" state
 * or synonym anywhere in this vocabulary.
 */
export const PLATFORM_HEALTH_STATES = [
  'healthy',
  'degraded',
  'restricted',
  'suspected_distribution_anomaly',
  'suspected_automation_risk',
  'authorization_blocked',
  'publishing_blocked',
  'quota_limited',
  'human_review_required',
] as const;

export type PlatformHealthState = (typeof PLATFORM_HEALTH_STATES)[number];

export function isKnownPlatformHealthState(value: string): value is PlatformHealthState {
  return (PLATFORM_HEALTH_STATES as readonly string[]).includes(value);
}

/**
 * The frozen confidence tiers — a coarse, evidence-count-derived ranking.
 * NEVER a probability: the tier records how strong the observable
 * evidence behind the verdict is (platform-confirmed records = high;
 * sustained multi-record inference = medium; thin/inferred-only or
 * observability-gap verdicts = low), and the uncertainty statement
 * carries the honest caveats.
 */
export const PLATFORM_HEALTH_CONFIDENCE_TIERS = ['high', 'medium', 'low'] as const;

export type PlatformHealthConfidence = (typeof PLATFORM_HEALTH_CONFIDENCE_TIERS)[number];

export function isKnownPlatformHealthConfidence(value: string): value is PlatformHealthConfidence {
  return (PLATFORM_HEALTH_CONFIDENCE_TIERS as readonly string[]).includes(value);
}

/**
 * THE CLOSED REASON-CODE VOCABULARY (ph-vocab-v1). Every code names the
 * OBSERVABLE basis of a verdict constituent — never an interpretation
 * beyond the record.
 */
export const PLATFORM_HEALTH_REASON_CODES = [
  'no_negative_observable_signals',
  'no_observable_records',
  'insufficient_baseline',
  'observed_metric_deviation_below_baseline',
  'cross_platform_control_divergence',
  'platform_confirmed_restriction_signal',
  'restricted_publish_outcome_observed',
  'platform_review_pending_signal',
  'conflicting_authorization_observations',
  'platform_automation_risk_signal',
  'observed_cadence_above_baseline',
  'account_disconnected',
  'account_revoked',
  'grant_state_expired',
  'grant_state_revoked',
  'authorization_unusable',
  'integration_connection_not_connected',
  'recent_publish_attempts_all_failed',
  'elevated_publish_failure_rate',
  'rate_limit_observed',
  'backoff_in_force',
] as const;

export type PlatformHealthReasonCode = (typeof PLATFORM_HEALTH_REASON_CODES)[number];

export function isKnownPlatformHealthReasonCode(value: string): value is PlatformHealthReasonCode {
  return (PLATFORM_HEALTH_REASON_CODES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// The compliant maneuver vocabulary (§11 verbatim, as data)
// ---------------------------------------------------------------------------

/**
 * THE FROZEN MANEUVER VOCABULARY — §11's maneuver list VERBATIM as data:
 * "Maneuver means compliant adaptation: change content mix/frequency,
 * pause a risky strategy, shift activity to another connected platform,
 * adjust transformations, reduce automation, request human interaction,
 * appeal/review where the platform provides that mechanism, preserve the
 * goal while changing the route." Maneuvering NEVER means defeating
 * anti-abuse controls, faking engagement, bypassing account restrictions
 * or impersonating human activity (lock rule 27).
 */
export const PLATFORM_HEALTH_MANEUVERS = [
  'change_content_mix',
  'change_publishing_frequency',
  'pause_risky_strategy',
  'shift_to_another_connected_platform',
  'adjust_transformations',
  'reduce_automation',
  'request_human_interaction',
  'platform_appeal_or_review',
  'preserve_goal_change_route',
] as const;

export type PlatformHealthManeuver = (typeof PLATFORM_HEALTH_MANEUVERS)[number];

/** The human-readable meaning of every maneuver (traceability requirement). */
export const PLATFORM_HEALTH_MANEUVER_DESCRIPTIONS: Readonly<
  Record<PlatformHealthManeuver, string>
> = {
  change_content_mix:
    'Change the content mix toward formats and topics the account already reached its audience with.',
  change_publishing_frequency:
    'Change the publishing frequency (spacing out or concentrating posts) and re-observe.',
  pause_risky_strategy:
    'Pause the strategy that coincided with the negative signals until the picture clarifies.',
  shift_to_another_connected_platform:
    'Shift activity to another already-connected platform account while this one recovers.',
  adjust_transformations:
    'Adjust the transformations (format, framing, length) used for this destination.',
  reduce_automation:
    'Reduce automation (scheduling density, bulk actions) and let activity look human-paced.',
  request_human_interaction:
    'Ask a human to review the evidence basis and decide the next step.',
  platform_appeal_or_review:
    'Use the platform-provided appeal or review mechanism, where the platform provides one.',
  preserve_goal_change_route:
    'Preserve the mission goal while changing the route that pursues it.',
};

/**
 * THE FORBIDDEN RESPONSE ACTIONS (lock rule 27 — the negative
 * vocabulary): anti-abuse evasion, fake engagement, restriction bypass
 * and human impersonation are NEVER recommendations. This constant is
 * the machine-checkable disclosure the unit battery and the boundary
 * tests pin: no recommendation emitted by this module may be, contain or
 * suggest a forbidden action.
 */
export const PLATFORM_HEALTH_FORBIDDEN_ACTIONS = [
  'anti_abuse_evasion',
  'fake_engagement',
  'restriction_bypass',
  'impersonation',
] as const;

export type PlatformHealthForbiddenAction = (typeof PLATFORM_HEALTH_FORBIDDEN_ACTIONS)[number];

/** True exactly when the value is a frozen maneuver kind (the closed recommendation surface). */
export function isCompliantPlatformHealthManeuver(value: string): value is PlatformHealthManeuver {
  return (PLATFORM_HEALTH_MANEUVERS as readonly string[]).includes(value);
}

/** One compliant response recommendation (§11 maneuver data + the state rationale). */
export interface PlatformHealthRecommendation {
  readonly maneuver: PlatformHealthManeuver;
  readonly description: string;
  readonly rationale: string;
}

/**
 * The module vocabulary version (the gm-vocab-v1 discipline): the nine
 * states, the confidence tiers, the reason codes, the maneuver vocabulary
 * and the baseline calculation constants. A change to ANY of them is a
 * NEW version string — never silently re-stated.
 */
export const PLATFORM_HEALTH_VOCABULARY_VERSION = 'ph-vocab-v1' as const;

/**
 * The frozen baseline-calculation version: the sustained-deviation rule
 * (the two most recent quality-passing observations both under half the
 * median of the account's own ≥3 prior observations of the same series),
 * the cross-platform control comparison and the cadence rule.
 */
export const PLATFORM_HEALTH_BASELINE_VERSION = 'ph-baseline-v1' as const;

/**
 * The frozen metric namespace participating in distribution-anomaly
 * detection: series whose metric name starts with 'social.' and whose
 * dimensions carry the account's id under the 'social_account_id'
 * dimension key (the convention the social analytics normalizers write;
 * series outside the namespace are carried as data but do not flag).
 */
export const PLATFORM_HEALTH_METRIC_NAMESPACE = 'social.' as const;

/**
 * THE OBSERVABILITY DISCLOSURE (§11's non-claim, on every evaluation
 * view): this evaluation describes OBSERVABLE provider/account signals
 * only; hidden platform moderation state is never invented, and
 * `suspected_distribution_anomaly` means exactly "observable anomaly
 * evidence without a platform-confirmed restriction" — never a
 * shadow-ban claim.
 */
export const PLATFORM_HEALTH_OBSERVABILITY_DISCLOSURE =
  'platform health describes observable provider/account signals only — hidden platform moderation state is never invented; a suspected_distribution_anomaly is observable anomaly evidence without a platform-confirmed restriction, never a shadow-ban claim' as const;

// ---------------------------------------------------------------------------
// Provenance (server-derived — implementation-contract §3)
// ---------------------------------------------------------------------------

/**
 * SERVER-DERIVED provenance for every evaluation command (the
 * growth-missions precedent): built exclusively from the authenticated
 * principal, the ambient correlation context and the recording surface —
 * never from a request body.
 */
export interface PlatformHealthProvenance {
  /** Server-derived actor label: 'user:<uuid>' | 'service:<label>' | 'worker:<label>'. */
  readonly actor: string;
  /** Server-derived recording surface label ('api' | 'module'). */
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

/** Provenance block as persisted on the append-only evaluation records. */
export interface PlatformHealthRecordedProvenance extends PlatformHealthProvenance {
  /** Server-stamped recording time (module clock, never caller input). */
  readonly recordedAt: string;
}

// ---------------------------------------------------------------------------
// The observable evaluation inputs (RECORD-derived facts ONLY — there is
// no signal/state/claim channel anywhere in this shape)
// ---------------------------------------------------------------------------

/** The observable account/authorization facts (055 + /integrations records). */
export interface PlatformHealthAccountObservation {
  readonly socialAccountId: string;
  readonly platformId: string;
  readonly status: 'connected' | 'disconnected' | 'revoked';
  readonly workspaceId: string | null;
  /** The CURRENT grant's lifecycle state (null when none resolves — dead accounts have no live grant). */
  readonly grantState: string | null;
  readonly grantId: string | null;
  /** The 055 fail-closed usable-authorization read (capability-matrix view). */
  readonly authorizationUsable: boolean;
  readonly connectionId: string;
  /** The /integrations connection operational status ('connected' | 'registered' | ...). */
  readonly connectionStatus: string;
  /** Whether a 056 social platform adapter is registered for the platform (the capability-parity fact). */
  readonly socialAdapterRegistered: boolean;
}

/** One provider-exposed restriction/eligibility signal as RETAINED on a 056 record. */
export interface PlatformHealthRestrictionSignalObservation {
  /** The provider's own signal label, verbatim (e.g. 'video.uploadStatus.rejected'). */
  readonly signalKind: string;
  readonly description: string | null;
}

/** The observed rate-limit/quota facts of one publish attempt (the 056 record). */
export interface PlatformHealthRateLimitObservation {
  readonly limitRemaining: number | null;
  readonly backoffUntil: string | null;
  readonly retryAfterSeconds: number | null;
}

/** One observable 056 publish-attempt invocation record (the submit-time outcome). */
export interface PlatformHealthPublishAttemptObservation {
  readonly attemptId: string;
  readonly recordedAt: string;
  readonly publishState: 'submitted' | 'accepted' | 'published' | 'failed' | 'restricted';
  readonly failureCode: string | null;
  readonly restrictionSignals: readonly PlatformHealthRestrictionSignalObservation[];
  readonly rateLimit: PlatformHealthRateLimitObservation | null;
}

/** One observable 056 status-poll observation (the provider-state history of an attempt). */
export interface PlatformHealthStatusPollObservation {
  readonly observationId: string;
  readonly attemptId: string;
  readonly publishState: 'accepted' | 'published' | 'failed' | 'restricted';
  readonly restrictionSignals: readonly PlatformHealthRestrictionSignalObservation[];
}

/** One /metrics observation point of an account (or control) series. */
export interface PlatformHealthMetricPointObservation {
  readonly observationId: string;
  readonly observedAt: string;
  readonly value: number;
  /** The /metrics data-quality posture ('ok' | 'partial' | 'estimated' | 'restated' | 'suspect'). */
  readonly quality: string;
  /** The /evidence record anchoring the observation (null when the observation is not evidence-derived). */
  readonly evidenceRef: string | null;
}

/** One metric series of the account, or one cross-platform CONTROL series. */
export interface PlatformHealthMetricSeriesObservation {
  /** 'account' — the evaluated account's own series; 'control' — another account's series on ANOTHER platform. */
  readonly scope: 'account' | 'control';
  readonly platformId: string;
  readonly metricName: string;
  /** Oldest first (the evaluation consumes the ordered history). */
  readonly observations: readonly PlatformHealthMetricPointObservation[];
}

/** The active-experiment confounder context (/experiments, READ-ONLY). */
export interface PlatformHealthExperimentContext {
  readonly experimentId: string;
  readonly status: string;
  readonly primaryMetricName: string;
}

/**
 * THE OBSERVABLE EVALUATION INPUT — the complete record-derived snapshot
 * the pure core consumes. Every field arrives from a durable observable
 * record of the five frozen-row surfaces; there is NO channel for a
 * claimed-but-unrecorded provider notice, moderation guess or caller
 * verdict (the observable-signals-only discipline is STRUCTURAL).
 */
export interface PlatformHealthEvaluationInput {
  readonly evaluatedAt: string;
  readonly account: PlatformHealthAccountObservation;
  /** The account's publish-attempt tail, NEWEST first (bounded by the 056 list surface). */
  readonly publishAttempts: readonly PlatformHealthPublishAttemptObservation[];
  /** The status-poll history of the most recent attempts with a provider reference (bounded). */
  readonly statusPolls: readonly PlatformHealthStatusPollObservation[];
  /** The account's own metric series + the cross-platform control series (the §11 control comparison). */
  readonly metricSeries: readonly PlatformHealthMetricSeriesObservation[];
  /** The client's active experiments (the anomaly-confounder context — never a verdict source). */
  readonly experiments: readonly PlatformHealthExperimentContext[];
}

// ---------------------------------------------------------------------------
// The evaluation result (the verdict WITH its complete honest basis)
// ---------------------------------------------------------------------------

/** One entry of the evidence basis — WHICH observable record produced the verdict constituent. */
export type PlatformHealthEvidenceBasisEntry =
  | {
      readonly kind: 'account_record';
      readonly socialAccountId: string;
      readonly observedFact: string;
    }
  | {
      readonly kind: 'grant_record';
      readonly grantId: string;
      readonly observedFact: string;
    }
  | {
      readonly kind: 'connection_record';
      readonly connectionId: string;
      readonly observedFact: string;
    }
  | {
      readonly kind: 'publish_attempt';
      readonly attemptId: string;
      readonly observedFact: string;
    }
  | {
      readonly kind: 'status_poll';
      readonly observationId: string;
      readonly observedFact: string;
    }
  | {
      readonly kind: 'restriction_signal';
      readonly signalKind: string;
      readonly source: string;
      readonly observedFact: string;
    }
  | {
      readonly kind: 'metric_observation';
      readonly observationId: string;
      readonly metricName: string;
      readonly observedFact: string;
    };

/** The per-series baseline summary (the 'ph-baseline-v1' calculation disclosure). */
export interface PlatformHealthBaselineSeriesSummary {
  readonly metricName: string;
  readonly scope: 'account' | 'control';
  readonly priorPoints: number;
  readonly baselineMedian: number | null;
  readonly recentValues: readonly number[];
  readonly suspectExcluded: number;
  /** True when the sustained-deviation rule flagged the series below its own baseline. */
  readonly flaggedBelowBaseline: boolean;
  /** True when the series has insufficient history for a baseline (the honest cold start). */
  readonly insufficientBaseline: boolean;
}

/**
 * THE EVALUATION RESULT: the descriptive state, the closed-vocabulary
 * reason codes, the coarse confidence tier, the explicit uncertainty
 * statement, the baseline summaries, the compliant recommendations and
 * the evidence basis. Deterministic: the same input snapshot always
 * produces the same result (the pure core is asserted by unit tests).
 */
export interface PlatformHealthEvaluationResult {
  readonly state: PlatformHealthState;
  readonly reasonCodes: readonly PlatformHealthReasonCode[];
  readonly confidence: PlatformHealthConfidence;
  readonly uncertainty: string;
  readonly baselineVersion: typeof PLATFORM_HEALTH_BASELINE_VERSION;
  readonly baseline: readonly PlatformHealthBaselineSeriesSummary[];
  readonly recommendations: readonly PlatformHealthRecommendation[];
  readonly evidenceBasis: readonly PlatformHealthEvidenceBasisEntry[];
  /** The composition disclosure: which observable surfaces were consulted and what they contributed. */
  readonly signalsConsidered: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Records (the migration 058 storage shapes)
// ---------------------------------------------------------------------------

/** One persisted append-only platform-health evaluation record. */
export interface PlatformHealthEvaluationRecord {
  readonly evaluationId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly socialAccountId: string;
  readonly platformId: string;
  readonly evaluatedState: PlatformHealthState;
  readonly confidence: PlatformHealthConfidence;
  readonly uncertainty: string;
  readonly reasonCodes: readonly PlatformHealthReasonCode[];
  readonly baseline: readonly PlatformHealthBaselineSeriesSummary[];
  readonly recommendations: readonly PlatformHealthRecommendation[];
  readonly evidenceBasis: readonly PlatformHealthEvidenceBasisEntry[];
  readonly signalsConsidered: Readonly<Record<string, unknown>>;
  readonly vocabularyVersion: typeof PLATFORM_HEALTH_VOCABULARY_VERSION;
  readonly baselineVersion: typeof PLATFORM_HEALTH_BASELINE_VERSION;
  readonly observabilityDisclosure: typeof PLATFORM_HEALTH_OBSERVABILITY_DISCLOSURE;
  readonly provenance: PlatformHealthRecordedProvenance;
  readonly createdAt: string;
}

/**
 * The composed evaluation read model: the record + the FK-anchored
 * evidence links (the /evidence records, /metrics observations and 056
 * publish attempts behind the verdict) — the honest read-back surface
 * the future consumers (MKT-070+ planners, the Growth Operator
 * platform-health seam, UX-007) consume.
 */
export interface PlatformHealthEvaluationDetail {
  readonly evaluation: PlatformHealthEvaluationRecord;
  /** The FK-anchored /evidence record ids backing the consumed observations (citation order). */
  readonly evidenceIds: readonly string[];
  /** The FK-anchored /metrics observation ids consumed by the evaluation (citation order). */
  readonly metricObservationIds: readonly string[];
  /** The FK-anchored 056 publish-attempt ids behind the verdict (citation order). */
  readonly publishAttemptIds: readonly string[];
}

// ---------------------------------------------------------------------------
// Canonical owner context (implementation-contract §2)
// ---------------------------------------------------------------------------

/**
 * The CANONICAL EVALUATION OWNER CONTEXT: the evaluation resolved to its
 * owning client/agency through the /social-accounts canonical account
 * ownership chain (the /cross-platform-distribution precedent — the
 * account owns the client chain; /clients is not an allowance of this
 * module's row). Evaluation-scoped operations authorize against this
 * context — never against caller-supplied tenant or evaluation identity.
 */
export interface PlatformHealthEvaluationOwnerContext {
  readonly scope: {
    readonly kind: 'platform_health_evaluation';
    readonly agencyId: string;
    readonly clientId: string;
    readonly evaluationId: string;
  };
  readonly evaluation: PlatformHealthEvaluationRecord;
  readonly resolvedAt: string;
}

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

export interface PlatformHealthModuleApi {
  /**
   * THE COMPOSITION (§11): evaluates one social account's current health
   * from OBSERVABLE RECORDS ONLY — the account/grant/authorization facts
   * (055), the connection state (/integrations), the account's 056
   * publish-attempt invocation records (with their provider-exposed
   * restriction signals and rate-limit observations) plus the status-poll
   * history of its most recent referenced attempts, the account's own
   * /metrics series history (the baseline) with the cross-platform
   * control series, and the client's active /experiments (confounders).
   *
   * The account must resolve through /social-accounts canonical ownership
   * and belong to the GIVEN Client (uniform NotFoundError otherwise — a
   * foreign account id is not an existence oracle). The input carries NO
   * signal, state or claim field: a provider notice that is not an
   * observable record is structurally inexpressible as a verdict input.
   * The deterministic pure core composes the verdict; the result is
   * persisted as ONE append-only evaluation record with its FK-anchored
   * evidence links.
   */
  evaluateAccountHealth(
    input: {
      readonly clientId: string;
      readonly socialAccountId: string;
    },
    provenance: PlatformHealthProvenance,
  ): Promise<PlatformHealthEvaluationDetail>;

  /** Raw evaluation record by id (immutable history is always readable). */
  getEvaluation(evaluationId: string): Promise<PlatformHealthEvaluationRecord | null>;

  /**
   * Canonical ownership resolution: the evaluation + its owning chain
   * (through the account's canonical /social-accounts ownership). Null
   * when the evaluation does not exist — callers surface the uniform 404
   * so foreign and unknown identifiers are indistinguishable.
   */
  resolveEvaluationOwnership(
    evaluationId: string,
  ): Promise<PlatformHealthEvaluationOwnerContext | null>;

  /**
   * The composed read-back: the evaluation record + the FK-anchored
   * evidence/metric/publish-attempt links — the evidence basis behind the
   * verdict. Null when unknown.
   */
  getEvaluationDetail(evaluationId: string): Promise<PlatformHealthEvaluationDetail | null>;

  /** The account's evaluation tail (oldest first). Unknown account → NotFoundError. */
  listEvaluationsForAccount(
    clientId: string,
    socialAccountId: string,
  ): Promise<readonly PlatformHealthEvaluationRecord[]>;

  /** The client's evaluations (oldest first, bounded). Unknown Client → NotFoundError. */
  listEvaluationsForClient(clientId: string): Promise<readonly PlatformHealthEvaluationRecord[]>;
}

export interface PlatformHealthModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * Frozen matrix: /platform-health ──→ /social-accounts — the ACCOUNT
   * AUTHORITY, consumed READ-ONLY through the public contract (the
   * account/grant records, the fail-closed usable-authorization +
   * capability-matrix views, the 056 publish-attempt invocation records
   * with their provider-exposed restriction signals/rate limits, the
   * per-attempt status-poll history, the client's account list for the
   * cross-platform control series, and the canonical account ownership
   * chain). No account row is ever mutated from here.
   */
  readonly socialAccounts: SocialAccountsModuleApi;
  /**
   * Frozen matrix: /platform-health ──→ /integrations — the connection
   * operational state (the integration pipe behind the account's
   * authorization), consumed READ-ONLY.
   */
  readonly integrations: IntegrationsModuleApi;
  /**
   * Frozen matrix: /platform-health ──→ /metrics — the OBSERVATION
   * LEDGER authority: the client's metric-observation tail the baseline
   * calculation consumes (the account's own series + the cross-platform
   * control series), consumed READ-ONLY.
   */
  readonly metrics: MetricsModuleApi;
  /**
   * Frozen matrix: /platform-health ──→ /evidence — the SOLE evidence
   * authority: the /evidence records anchoring the consumed metric
   * observations (the evidence basis links), resolved READ-ONLY.
   */
  readonly evidence: EvidenceModuleApi;
  /**
   * Frozen matrix: /platform-health ──→ /experiments — the experiment
   * identity authority: the client's ACTIVE experiments as the anomaly
   * CONFOUNDER context (an experiment measuring the flagged series may
   * explain its deviation — attribution is distinct from causal
   * inference), consumed READ-ONLY. No experiment is created or
   * transitioned here.
   */
  readonly experiments: ExperimentsModuleApi;
}

export { createPlatformHealthModule } from './internal/platform-health-module.ts';
/**
 * The pure deterministic evaluation core (the §11 composition rules, the
 * 'ph-baseline-v1' sustained-deviation baseline, the cross-platform
 * control comparison, the cadence rule, the confidence table and the
 * compliant maneuver mapping) and the input guards — exported for unit
 * tests and future server-side callers (the MKT-070+ planners and the
 * Growth Operator platform-health seam compose these same commands) so
 * the evaluation semantics are part of the module contract. Pure
 * functions: no clock, no randomness, no network.
 */
export {
  evaluatePlatformHealth,
  recommendationsForPlatformHealthState,
  assertValidPlatformHealthProvenance,
  PLATFORM_HEALTH_ANOMALY_DROP_RATIO,
  PLATFORM_HEALTH_MIN_BASELINE_POINTS,
  PLATFORM_HEALTH_RECENT_POINTS,
  PLATFORM_HEALTH_MAX_REASON_CODES,
} from './internal/evaluation.ts';
