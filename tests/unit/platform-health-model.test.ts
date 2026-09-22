/**
 * MKT-066 unit tests — the pure evaluation core of /platform-health: the
 * §11 composition rules, the 'ph-baseline-v1' baseline-relative anomaly
 * detection, the observable-signals-only discipline, the reason-code +
 * confidence/uncertainty basis, the compliant §11 maneuver
 * recommendations and the closed nine-state vocabulary.
 *
 * The dispatch's five NAMED tests are here verbatim:
 *   (a) baseline-relative anomaly detection (a baseline deviation
 *       produces the anomaly state; cold-start produces honest
 *       insufficient-baseline);
 *   (b) observable-signals-only discipline (a provider notice with no
 *       observable record cannot produce a verdict — never
 *       hidden-moderation invention; the suspected_distribution_anomaly
 *       state for observable-only evidence);
 *   (c) reason codes + confidence/uncertainty attached to every verdict
 *       with the evidence basis;
 *   (d) compliant response recommendations from the §11 maneuver list as
 *       data (and NO recommendation is an anti-abuse/evasion action);
 *   (e) the closed nine-state vocabulary enforcement.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLATFORM_HEALTH_STATES,
  PLATFORM_HEALTH_REASON_CODES,
  PLATFORM_HEALTH_MANEUVERS,
  PLATFORM_HEALTH_FORBIDDEN_ACTIONS,
  PLATFORM_HEALTH_CONFIDENCE_TIERS,
  PLATFORM_HEALTH_VOCABULARY_VERSION,
  PLATFORM_HEALTH_BASELINE_VERSION,
  PLATFORM_HEALTH_OBSERVABILITY_DISCLOSURE,
  evaluatePlatformHealth,
  recommendationsForPlatformHealthState,
  assertValidPlatformHealthProvenance,
  PLATFORM_HEALTH_ANOMALY_DROP_RATIO,
  PLATFORM_HEALTH_MIN_BASELINE_POINTS,
  PLATFORM_HEALTH_RECENT_POINTS,
  type PlatformHealthEvaluationInput,
  type PlatformHealthMetricPointObservation,
  type PlatformHealthMetricSeriesObservation,
} from '../../src/modules/platform-health/public.ts';

// ---------------------------------------------------------------------------
// The input builders (record-derived observation facts ONLY)
// ---------------------------------------------------------------------------

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const EVALUATED_AT = '2026-09-01T12:00:00.000Z';

function healthyAccount() {
  return {
    socialAccountId: ACCOUNT_ID,
    platformId: 'youtube',
    status: 'connected' as const,
    workspaceId: null,
    grantState: 'authorized',
    grantId: '33333333-3333-4333-8333-333333333333',
    authorizationUsable: true,
    connectionId: '44444444-4444-4444-8444-444444444444',
    connectionStatus: 'connected',
    socialAdapterRegistered: true,
  };
}

function baseInput(): PlatformHealthEvaluationInput {
  return {
    evaluatedAt: EVALUATED_AT,
    account: healthyAccount(),
    publishAttempts: [],
    statusPolls: [],
    metricSeries: [],
    experiments: [],
  };
}

function point(
  observationId: string,
  daysAgo: number,
  value: number,
  quality: string = 'ok',
): PlatformHealthMetricPointObservation {
  const observedAt = new Date(Date.parse(EVALUATED_AT) - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  return { observationId, observedAt, value, quality, evidenceRef: null };
}

/** The account's reach series in a SUSTAINED collapse (both recent < 500). */
function collapsedReachSeries(): PlatformHealthMetricSeriesObservation {
  return {
    scope: 'account',
    platformId: 'youtube',
    metricName: 'social.reach',
    observations: [
      point('obs-1', 10, 1000),
      point('obs-2', 8, 1100),
      point('obs-3', 6, 950),
      point('obs-4', 4, 120),
      point('obs-5', 2, 90),
    ],
  };
}

/** A healthy cross-platform control series on another platform. */
function healthyControlSeries(): PlatformHealthMetricSeriesObservation {
  return {
    scope: 'control',
    platformId: 'instagram',
    metricName: 'social.reach',
    observations: [
      point('ctl-1', 10, 800),
      point('ctl-2', 8, 850),
      point('ctl-3', 6, 780),
      point('ctl-4', 4, 820),
      point('ctl-5', 2, 810),
    ],
  };
}

// ---------------------------------------------------------------------------
// (a) BASELINE-RELATIVE ANOMALY DETECTION — the named test
// ---------------------------------------------------------------------------

test('MKT-066 (a): a baseline deviation produces the suspected_distribution_anomaly state', () => {
  const result = evaluatePlatformHealth({
    ...baseInput(),
    metricSeries: [collapsedReachSeries()],
  });
  assert.equal(result.state, 'suspected_distribution_anomaly');
  assert.ok(result.reasonCodes.includes('observed_metric_deviation_below_baseline'));
  // The baseline summary discloses the account's OWN reference points.
  const reach = result.baseline.find((series) => series.metricName === 'social.reach');
  assert.ok(reach !== undefined);
  assert.equal(reach.scope, 'account');
  assert.equal(reach.priorPoints, 3);
  assert.ok(reach.baselineMedian !== null && reach.baselineMedian > 900);
  assert.deepEqual([...reach.recentValues], [120, 90]);
  assert.equal(reach.flaggedBelowBaseline, true);
  // The evidence basis names the consumed observation records.
  const consumed = result.evidenceBasis.filter((entry) => entry.kind === 'metric_observation');
  assert.equal(consumed.length, 5);
  // The uncertainty statement carries the honest numbers.
  assert.match(result.uncertainty, /social\.reach/);
  assert.match(result.uncertainty, /baseline median/);
});

test('MKT-066 (a): the deviation must be SUSTAINED — a single dip below half the baseline does not flag', () => {
  const result = evaluatePlatformHealth({
    ...baseInput(),
    metricSeries: [
      {
        scope: 'account',
        platformId: 'youtube',
        metricName: 'social.reach',
        observations: [
          point('obs-1', 10, 1000),
          point('obs-2', 8, 1100),
          point('obs-3', 6, 950),
          point('obs-4', 4, 80),
          point('obs-5', 2, 1050),
        ],
      },
    ],
  });
  assert.equal(result.state, 'healthy');
  assert.ok(!result.reasonCodes.includes('observed_metric_deviation_below_baseline'));
});

test('MKT-066 (a): cold-start produces the honest insufficient-baseline disclosure — never a fabricated verdict', () => {
  const result = evaluatePlatformHealth({
    ...baseInput(),
    metricSeries: [
      {
        scope: 'account',
        platformId: 'youtube',
        metricName: 'social.reach',
        observations: [point('obs-1', 10, 1000), point('obs-2', 8, 90)],
      },
    ],
  });
  // No anomaly verdict is produced without the account's OWN baseline.
  assert.equal(result.state, 'healthy');
  assert.ok(result.reasonCodes.includes('insufficient_baseline'));
  assert.ok(!result.reasonCodes.includes('observed_metric_deviation_below_baseline'));
  assert.equal(result.confidence, 'low');
  assert.match(result.uncertainty, /insufficient baseline for anomaly detection/);
  const reach = result.baseline.find((series) => series.metricName === 'social.reach');
  assert.ok(reach !== undefined);
  assert.equal(reach.insufficientBaseline, true);
  assert.equal(reach.flaggedBelowBaseline, false);
});

test('MKT-066 (a): the baseline is the account\'s OWN history — an absolute threshold without a baseline never fires', () => {
  // A LOW absolute series with a stable own-baseline is NOT an anomaly.
  const result = evaluatePlatformHealth({
    ...baseInput(),
    metricSeries: [
      {
        scope: 'account',
        platformId: 'youtube',
        metricName: 'social.reach',
        observations: [
          point('obs-1', 10, 40),
          point('obs-2', 8, 55),
          point('obs-3', 6, 45),
          point('obs-4', 4, 50),
          point('obs-5', 2, 48),
        ],
      },
    ],
  });
  assert.equal(result.state, 'healthy');
});

test('MKT-066 (a): suspect-quality observations are excluded from the baseline (the /metrics data-quality posture)', () => {
  const result = evaluatePlatformHealth({
    ...baseInput(),
    metricSeries: [
      {
        scope: 'account',
        platformId: 'youtube',
        metricName: 'social.reach',
        observations: [
          point('obs-1', 10, 1000),
          point('obs-2', 8, 1100),
          point('obs-3', 6, 950),
          point('obs-4', 4, 120, 'suspect'),
          point('obs-5', 2, 90, 'suspect'),
        ],
      },
    ],
  });
  // Both recent points are suspect-quality: no quality-passing recent
  // window exists — the honest insufficient posture, never a flag from
  // suspect data.
  assert.equal(result.state, 'healthy');
  const reach = result.baseline.find((series) => series.metricName === 'social.reach');
  assert.ok(reach !== undefined);
  assert.equal(reach.suspectExcluded, 2);
});

test('MKT-066 (a): a cross-platform control divergence sharpens the anomaly (medium confidence); no control keeps it low', () => {
  const withControl = evaluatePlatformHealth({
    ...baseInput(),
    metricSeries: [collapsedReachSeries(), healthyControlSeries()],
  });
  assert.equal(withControl.state, 'suspected_distribution_anomaly');
  assert.ok(withControl.reasonCodes.includes('cross_platform_control_divergence'));
  assert.equal(withControl.confidence, 'medium');
  assert.match(withControl.uncertainty, /controls show no similar deviation/);

  const withoutControl = evaluatePlatformHealth({
    ...baseInput(),
    metricSeries: [collapsedReachSeries()],
  });
  assert.equal(withoutControl.confidence, 'low');
  assert.match(withoutControl.uncertainty, /no cross-platform control series was available/);
});

test('MKT-066 (a): a cross-platform control showing the SAME deviation keeps the honest client-wide caveat', () => {
  const result = evaluatePlatformHealth({
    ...baseInput(),
    metricSeries: [
      collapsedReachSeries(),
      {
        scope: 'control',
        platformId: 'instagram',
        metricName: 'social.reach',
        observations: [
          point('ctl-1', 10, 800),
          point('ctl-2', 8, 850),
          point('ctl-3', 6, 780),
          point('ctl-4', 4, 100),
          point('ctl-5', 2, 95),
        ],
      },
    ],
  });
  assert.equal(result.state, 'suspected_distribution_anomaly');
  assert.equal(result.confidence, 'low');
  assert.match(result.uncertainty, /controls show similar deviation/);
});

// ---------------------------------------------------------------------------
// (b) OBSERVABLE-SIGNALS-ONLY DISCIPLINE — the named test
// ---------------------------------------------------------------------------

test('MKT-066 (b): a provider notice with no observable record cannot produce a verdict — never hidden-moderation invention', () => {
  // The scenario: the operator HEARD "the platform shadow-banned the
  // account" — but there is NO observable record of it (no restriction
  // signal on any 056 record, no metric deviation). The evaluation input
  // has NO signal/claim channel, so the claimed notice is structurally
  // inexpressible: the honest output is the empty-observable posture.
  const result = evaluatePlatformHealth(baseInput());
  assert.equal(result.state, 'healthy');
  assert.ok(result.reasonCodes.includes('no_observable_records'));
  assert.equal(result.confidence, 'low');
  assert.match(result.uncertainty, /no observable records in the composed window/);
  // The §11 non-claim ships on every evaluation view.
  assert.ok(
    PLATFORM_HEALTH_OBSERVABILITY_DISCLOSURE.includes('hidden platform moderation state is never invented'),
  );
});

test('MKT-066 (b): the suspected_distribution_anomaly state is used for observable-only evidence — and NO shadow-ban vocabulary exists anywhere', () => {
  // Observable-only anomaly evidence (the account's own metric collapse)
  // WITHOUT any platform-confirmed restriction → the honest state is
  // suspected_distribution_anomaly.
  const result = evaluatePlatformHealth({
    ...baseInput(),
    metricSeries: [collapsedReachSeries()],
  });
  assert.equal(result.state, 'suspected_distribution_anomaly');
  assert.match(result.uncertainty, /never a shadow-ban claim/);

  // Lock rule 26: no shadow-ban state or synonym exists in ANY frozen
  // vocabulary of the module (states, reason codes, maneuvers).
  const vocabularyText = [
    ...PLATFORM_HEALTH_STATES,
    ...PLATFORM_HEALTH_REASON_CODES,
    ...PLATFORM_HEALTH_MANEUVERS,
  ].join(' ');
  assert.ok(!/shadow/i.test(vocabularyText), 'no shadow-ban vocabulary may exist');
});

test('MKT-066 (b): restricted requires a PLATFORM-CONFIRMED record — the provider-exposed signal kinds', () => {
  // A 056 publish attempt carrying the provider's own restriction signal
  // (e.g. the YouTube adapter's 'video.uploadStatus.rejected') is a
  // platform-confirmed restriction record.
  const result = evaluatePlatformHealth({
    ...baseInput(),
    publishAttempts: [
      {
        attemptId: 'att-1',
        recordedAt: EVALUATED_AT,
        publishState: 'published',
        failureCode: null,
        restrictionSignals: [
          { signalKind: 'video.uploadStatus.rejected', description: 'video vid1 carries uploadStatus=rejected' },
        ],
        rateLimit: null,
      },
    ],
  });
  assert.equal(result.state, 'restricted');
  assert.ok(result.reasonCodes.includes('platform_confirmed_restriction_signal'));
  assert.equal(result.confidence, 'high');
  const signalBasis = result.evidenceBasis.filter((entry) => entry.kind === 'restriction_signal');
  assert.equal(signalBasis.length, 1);
  assert.equal(signalBasis[0]!.signalKind, 'video.uploadStatus.rejected');
});

test('MKT-066 (b): the 056 restricted terminal outcome is a platform-confirmed restriction record', () => {
  const result = evaluatePlatformHealth({
    ...baseInput(),
    publishAttempts: [
      {
        attemptId: 'att-1',
        recordedAt: EVALUATED_AT,
        publishState: 'restricted',
        failureCode: null,
        restrictionSignals: [],
        rateLimit: null,
      },
    ],
  });
  assert.equal(result.state, 'restricted');
  assert.ok(result.reasonCodes.includes('restricted_publish_outcome_observed'));
});

test('MKT-066 (b): the status-poll history carries provider-exposed restriction signals too', () => {
  const result = evaluatePlatformHealth({
    ...baseInput(),
    statusPolls: [
      {
        observationId: 'poll-1',
        attemptId: 'att-1',
        publishState: 'published',
        restrictionSignals: [{ signalKind: 'video.regionRestriction', description: null }],
      },
    ],
  });
  assert.equal(result.state, 'restricted');
});

// ---------------------------------------------------------------------------
// (c) REASON CODES + CONFIDENCE/UNCERTAINTY ON EVERY VERDICT — the named test
// ---------------------------------------------------------------------------

test('MKT-066 (c): every verdict carries closed reason codes, a confidence tier, an uncertainty statement and a non-empty evidence basis', () => {
  const scenarios: readonly PlatformHealthEvaluationInput[] = [
    baseInput(),
    { ...baseInput(), metricSeries: [collapsedReachSeries()] },
    {
      ...baseInput(),
      publishAttempts: [
        {
          attemptId: 'att-1',
          recordedAt: EVALUATED_AT,
          publishState: 'restricted',
          failureCode: null,
          restrictionSignals: [],
          rateLimit: null,
        },
      ],
    },
    {
      ...baseInput(),
      account: { ...healthyAccount(), status: 'revoked', grantState: 'revoked' },
    },
    {
      ...baseInput(),
      publishAttempts: [
        {
          attemptId: 'att-1',
          recordedAt: EVALUATED_AT,
          publishState: 'failed',
          failureCode: 'provider-unavailable',
          restrictionSignals: [],
          rateLimit: null,
        },
        {
          attemptId: 'att-2',
          recordedAt: EVALUATED_AT,
          publishState: 'failed',
          failureCode: 'provider-unavailable',
          restrictionSignals: [],
          rateLimit: null,
        },
      ],
    },
    {
      ...baseInput(),
      publishAttempts: [
        {
          attemptId: 'att-1',
          recordedAt: EVALUATED_AT,
          publishState: 'failed',
          failureCode: 'rate-limited',
          restrictionSignals: [],
          rateLimit: { limitRemaining: 0, backoffUntil: null, retryAfterSeconds: null },
        },
      ],
    },
  ];
  for (const scenario of scenarios) {
    const result = evaluatePlatformHealth(scenario);
    assert.ok(result.reasonCodes.length >= 1, `state ${result.state} carries reason codes`);
    for (const code of result.reasonCodes) {
      assert.ok(
        (PLATFORM_HEALTH_REASON_CODES as readonly string[]).includes(code),
        `reason code '${code}' is in the closed vocabulary`,
      );
    }
    assert.ok((PLATFORM_HEALTH_CONFIDENCE_TIERS as readonly string[]).includes(result.confidence));
    assert.ok(result.uncertainty.length > 0, `state ${result.state} carries an uncertainty statement`);
    assert.ok(result.evidenceBasis.length >= 1, `state ${result.state} names its evidence basis`);
    assert.equal(result.baselineVersion, PLATFORM_HEALTH_BASELINE_VERSION);
  }
});

test('MKT-066 (c): the confidence tiers are evidence-derived, never fabricated probabilities', () => {
  // Terminal account records → high (direct durable records).
  const revoked = evaluatePlatformHealth({
    ...baseInput(),
    account: { ...healthyAccount(), status: 'revoked', grantState: 'revoked' },
  });
  assert.equal(revoked.state, 'authorization_blocked');
  assert.equal(revoked.confidence, 'high');
  assert.ok(revoked.reasonCodes.includes('account_revoked'));

  // The lazy unusable read alone → medium (an inference, not a record).
  const lazy = evaluatePlatformHealth({
    ...baseInput(),
    account: { ...healthyAccount(), authorizationUsable: false },
  });
  assert.equal(lazy.state, 'authorization_blocked');
  assert.equal(lazy.confidence, 'medium');
  assert.ok(lazy.reasonCodes.includes('authorization_unusable'));

  // All-failed attempts → medium (inferred from absence of success).
  const blocked = evaluatePlatformHealth({
    ...baseInput(),
    publishAttempts: [
      {
        attemptId: 'att-1',
        recordedAt: EVALUATED_AT,
        publishState: 'failed',
        failureCode: 'provider-unavailable',
        restrictionSignals: [],
        rateLimit: null,
      },
      {
        attemptId: 'att-2',
        recordedAt: EVALUATED_AT,
        publishState: 'failed',
        failureCode: 'provider-unavailable',
        restrictionSignals: [],
        rateLimit: null,
      },
    ],
  });
  assert.equal(blocked.state, 'publishing_blocked');
  assert.equal(blocked.confidence, 'medium');
});

test('MKT-066 (c): the quota state cites the observed rate-limit record', () => {
  const result = evaluatePlatformHealth({
    ...baseInput(),
    publishAttempts: [
      {
        attemptId: 'att-1',
        recordedAt: EVALUATED_AT,
        publishState: 'failed',
        failureCode: 'rate-limited',
        restrictionSignals: [],
        rateLimit: { limitRemaining: 0, backoffUntil: null, retryAfterSeconds: null },
      },
    ],
  });
  assert.equal(result.state, 'quota_limited');
  assert.ok(result.reasonCodes.includes('rate_limit_observed'));
  assert.equal(result.confidence, 'high');

  const backoff = evaluatePlatformHealth({
    ...baseInput(),
    publishAttempts: [
      {
        attemptId: 'att-2',
        recordedAt: EVALUATED_AT,
        publishState: 'published',
        failureCode: null,
        restrictionSignals: [],
        rateLimit: {
          limitRemaining: 5,
          backoffUntil: '2026-09-01T13:00:00.000Z',
          retryAfterSeconds: null,
        },
      },
    ],
  });
  assert.equal(backoff.state, 'quota_limited');
  assert.ok(backoff.reasonCodes.includes('backoff_in_force'));
});

// ---------------------------------------------------------------------------
// (d) COMPLIANT RESPONSE RECOMMENDATIONS — the named test
// ---------------------------------------------------------------------------

test('MKT-066 (d): the recommendations are the §11 maneuver list as data, mapped per state', () => {
  const result = evaluatePlatformHealth({
    ...baseInput(),
    metricSeries: [collapsedReachSeries()],
  });
  assert.equal(result.state, 'suspected_distribution_anomaly');
  const maneuvers = result.recommendations.map((recommendation) => recommendation.maneuver);
  assert.deepEqual([...maneuvers].sort(), [
    'adjust_transformations',
    'change_content_mix',
    'preserve_goal_change_route',
    'shift_to_another_connected_platform',
  ]);
  for (const recommendation of result.recommendations) {
    assert.ok(
      (PLATFORM_HEALTH_MANEUVERS as readonly string[]).includes(recommendation.maneuver),
    );
    assert.ok(recommendation.description.length > 0);
    assert.ok(recommendation.rationale.length > 0);
  }
});

test('MKT-066 (d): NO recommendation is an anti-abuse/evasion action — the forbidden vocabulary is structurally absent', () => {
  // Every state's recommendation set is drawn from the frozen §11
  // maneuver vocabulary; the forbidden actions never appear in ANY
  // emitted recommendation, description or rationale.
  for (const state of PLATFORM_HEALTH_STATES) {
    const recommendations = recommendationsForPlatformHealthState(state);
    for (const recommendation of recommendations) {
      assert.ok(
        (PLATFORM_HEALTH_MANEUVERS as readonly string[]).includes(recommendation.maneuver),
        `state ${state}: '${recommendation.maneuver}' is a frozen §11 maneuver`,
      );
      const text = `${recommendation.maneuver} ${recommendation.description} ${recommendation.rationale}`.toLowerCase();
      for (const forbidden of PLATFORM_HEALTH_FORBIDDEN_ACTIONS) {
        assert.ok(!text.includes(forbidden.replace(/_/g, ' ')), `no forbidden action '${forbidden}'`);
        assert.ok(!text.includes(forbidden), `no forbidden action '${forbidden}'`);
      }
      assert.ok(!/evade|evasion|bypass|fake|impersonat|defeat/i.test(text), 'no evasion/fake/impersonation language');
    }
  }
  // The forbidden vocabulary itself never intersects the maneuver vocabulary.
  for (const forbidden of PLATFORM_HEALTH_FORBIDDEN_ACTIONS) {
    assert.ok(!(PLATFORM_HEALTH_MANEUVERS as readonly string[]).includes(forbidden as never));
  }
  // The healthy state recommends nothing (no compliant maneuver is needed).
  assert.deepEqual(recommendationsForPlatformHealthState('healthy'), []);
});

// ---------------------------------------------------------------------------
// (e) THE CLOSED NINE-STATE VOCABULARY — the named test
// ---------------------------------------------------------------------------

test('MKT-066 (e): the closed nine-state vocabulary enforcement (§11 verbatim)', () => {
  assert.deepEqual([...PLATFORM_HEALTH_STATES], [
    'healthy',
    'degraded',
    'restricted',
    'suspected_distribution_anomaly',
    'suspected_automation_risk',
    'authorization_blocked',
    'publishing_blocked',
    'quota_limited',
    'human_review_required',
  ]);
  assert.equal(PLATFORM_HEALTH_STATES.length, 9);
  // Every state is reachable through the deterministic rules (the full
  // precedence walk — one input per state).
  const states = new Set<ReturnType<typeof evaluatePlatformHealth>['state']>();
  states.add(evaluatePlatformHealth(baseInput()).state); // healthy
  states.add(
    evaluatePlatformHealth({
      ...baseInput(),
      metricSeries: [collapsedReachSeries()],
    }).state,
  ); // suspected_distribution_anomaly
  states.add(
    evaluatePlatformHealth({
      ...baseInput(),
      publishAttempts: [
        {
          attemptId: 'att-1',
          recordedAt: EVALUATED_AT,
          publishState: 'restricted',
          failureCode: null,
          restrictionSignals: [],
          rateLimit: null,
        },
      ],
    }).state,
  ); // restricted
  states.add(
    evaluatePlatformHealth({
      ...baseInput(),
      account: { ...healthyAccount(), status: 'disconnected', grantState: null },
    }).state,
  ); // authorization_blocked
  states.add(
    evaluatePlatformHealth({
      ...baseInput(),
      publishAttempts: [
        {
          attemptId: 'att-1',
          recordedAt: EVALUATED_AT,
          publishState: 'failed',
          failureCode: 'provider-unavailable',
          restrictionSignals: [],
          rateLimit: null,
        },
        {
          attemptId: 'att-2',
          recordedAt: EVALUATED_AT,
          publishState: 'failed',
          failureCode: 'provider-unavailable',
          restrictionSignals: [],
          rateLimit: null,
        },
      ],
    }).state,
  ); // publishing_blocked
  states.add(
    evaluatePlatformHealth({
      ...baseInput(),
      publishAttempts: [
        {
          attemptId: 'att-1',
          recordedAt: EVALUATED_AT,
          publishState: 'failed',
          failureCode: 'rate-limited',
          restrictionSignals: [],
          rateLimit: { limitRemaining: 0, backoffUntil: null, retryAfterSeconds: null },
        },
      ],
    }).state,
  ); // quota_limited
  states.add(
    evaluatePlatformHealth({
      ...baseInput(),
      publishAttempts: [
        {
          attemptId: 'att-1',
          recordedAt: EVALUATED_AT,
          publishState: 'failed',
          failureCode: 'provider-unavailable',
          restrictionSignals: [],
          rateLimit: null,
        },
        {
          attemptId: 'att-2',
          recordedAt: EVALUATED_AT,
          publishState: 'published',
          failureCode: null,
          restrictionSignals: [],
          rateLimit: null,
        },
        {
          attemptId: 'att-3',
          recordedAt: EVALUATED_AT,
          publishState: 'failed',
          failureCode: 'provider-unavailable',
          restrictionSignals: [],
          rateLimit: null,
        },
        {
          attemptId: 'att-4',
          recordedAt: EVALUATED_AT,
          publishState: 'failed',
          failureCode: 'provider-unavailable',
          restrictionSignals: [],
          rateLimit: null,
        },
      ],
    }).state,
  ); // degraded (elevated failure fraction, not all failed)
  states.add(
    evaluatePlatformHealth({
      ...baseInput(),
      publishAttempts: [
        {
          attemptId: 'att-1',
          recordedAt: EVALUATED_AT,
          publishState: 'failed',
          failureCode: 'auth-expired',
          restrictionSignals: [],
          rateLimit: null,
        },
      ],
    }).state,
  ); // human_review_required (conflicting authorization observations)
  states.add(
    evaluatePlatformHealth({
      ...baseInput(),
      publishAttempts: [
        {
          attemptId: 'att-1',
          recordedAt: EVALUATED_AT,
          publishState: 'published',
          failureCode: null,
          restrictionSignals: [
            { signalKind: 'account.status_under_review', description: null },
          ],
          rateLimit: null,
        },
      ],
    }).state,
  ); // human_review_required (the platform's own review-pending signal)
  states.add(
    evaluatePlatformHealth({
      ...baseInput(),
      publishAttempts: [
        {
          attemptId: 'att-1',
          recordedAt: EVALUATED_AT,
          publishState: 'published',
          failureCode: null,
          restrictionSignals: [
            { signalKind: 'spam.detected', description: null },
          ],
          rateLimit: null,
        },
      ],
    }).state,
  ); // suspected_automation_risk (platform automation feedback)
  assert.deepEqual(
    [...states].sort(),
    [...PLATFORM_HEALTH_STATES].sort(),
    'every one of the frozen nine states is produced by the deterministic rules',
  );
});

// ---------------------------------------------------------------------------
// The determinism + precedence battery (the core invariants)
// ---------------------------------------------------------------------------

test('MKT-066: the evaluation is DETERMINISTIC — the same observable snapshot always produces the same verdict', () => {
  const input: PlatformHealthEvaluationInput = {
    ...baseInput(),
    metricSeries: [collapsedReachSeries(), healthyControlSeries()],
    publishAttempts: [
      {
        attemptId: 'att-1',
        recordedAt: EVALUATED_AT,
        publishState: 'published',
        failureCode: null,
        restrictionSignals: [],
        rateLimit: null,
      },
    ],
  };
  const first = evaluatePlatformHealth(input);
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(evaluatePlatformHealth(input), first);
  }
});

test('MKT-066: the fail-closed precedence — platform-confirmed beats inferred, auth beats everything', () => {
  // A restricted record + a metric collapse → restricted (the confirmed
  // platform record wins over the inferred anomaly).
  const both = evaluatePlatformHealth({
    ...baseInput(),
    metricSeries: [collapsedReachSeries()],
    publishAttempts: [
      {
        attemptId: 'att-1',
        recordedAt: EVALUATED_AT,
        publishState: 'restricted',
        failureCode: null,
        restrictionSignals: [],
        rateLimit: null,
      },
    ],
  });
  assert.equal(both.state, 'restricted');

  // A dead account + everything else → authorization_blocked.
  const dead = evaluatePlatformHealth({
    ...baseInput(),
    account: { ...healthyAccount(), status: 'revoked', grantState: 'revoked' },
    metricSeries: [collapsedReachSeries()],
    publishAttempts: [
      {
        attemptId: 'att-1',
        recordedAt: EVALUATED_AT,
        publishState: 'restricted',
        failureCode: null,
        restrictionSignals: [],
        rateLimit: null,
      },
    ],
  });
  assert.equal(dead.state, 'authorization_blocked');
});

test('MKT-066: unresolved submitted attempts are UNKNOWN — never counted as failures', () => {
  const result = evaluatePlatformHealth({
    ...baseInput(),
    publishAttempts: [
      {
        attemptId: 'att-1',
        recordedAt: EVALUATED_AT,
        publishState: 'submitted',
        failureCode: null,
        restrictionSignals: [],
        rateLimit: null,
      },
      {
        attemptId: 'att-2',
        recordedAt: EVALUATED_AT,
        publishState: 'submitted',
        failureCode: null,
        restrictionSignals: [],
        rateLimit: null,
      },
    ],
  });
  assert.equal(result.state, 'healthy');
});

test('MKT-066: the automation-risk family — platform feedback is high confidence, cadence-only is low', () => {
  const feedback = evaluatePlatformHealth({
    ...baseInput(),
    publishAttempts: [
      {
        attemptId: 'att-1',
        recordedAt: EVALUATED_AT,
        publishState: 'published',
        failureCode: null,
        restrictionSignals: [{ signalKind: 'automation.detected', description: null }],
        rateLimit: null,
      },
    ],
  });
  assert.equal(feedback.state, 'suspected_automation_risk');
  assert.equal(feedback.confidence, 'high');
  assert.ok(feedback.reasonCodes.includes('platform_automation_risk_signal'));

  // The first-party cadence signal: a 24h burst ≥3× the prior-6-day
  // median daily count (with median ≥ 1) at low confidence.
  const now = Date.parse(EVALUATED_AT);
  const cadenceAttempts = [];
  let seq = 0;
  for (let day = 1; day <= 6; day += 1) {
    seq += 1;
    cadenceAttempts.push({
      attemptId: `att-${seq}`,
      recordedAt: new Date(now - day * 24 * 60 * 60 * 1000).toISOString(),
      publishState: 'published' as const,
      failureCode: null,
      restrictionSignals: [],
      rateLimit: null,
    });
  }
  for (let i = 0; i < 6; i += 1) {
    seq += 1;
    cadenceAttempts.push({
      attemptId: `att-${seq}`,
      recordedAt: new Date(now - i * 60 * 60 * 1000).toISOString(),
      publishState: 'published' as const,
      failureCode: null,
      restrictionSignals: [],
      rateLimit: null,
    });
  }
  const cadence = evaluatePlatformHealth({
    ...baseInput(),
    publishAttempts: cadenceAttempts,
  });
  assert.equal(cadence.state, 'suspected_automation_risk');
  assert.equal(cadence.confidence, 'low');
  assert.ok(cadence.reasonCodes.includes('observed_cadence_above_baseline'));
});

test('MKT-066: the active-experiment confounder disclosure (attribution ≠ causal inference)', () => {
  const result = evaluatePlatformHealth({
    ...baseInput(),
    metricSeries: [collapsedReachSeries()],
    experiments: [
      { experimentId: 'exp-1', status: 'running', primaryMetricName: 'social.reach' },
      { experimentId: 'exp-2', status: 'completed', primaryMetricName: 'social.reach' },
      { experimentId: 'exp-3', status: 'running', primaryMetricName: 'social.engagement' },
    ],
  });
  assert.equal(result.state, 'suspected_distribution_anomaly');
  // Only the RUNNING experiment measuring the FLAGGED series is disclosed.
  assert.match(result.uncertainty, /exp-1/);
  assert.ok(!result.uncertainty.includes('exp-2'));
  assert.ok(!result.uncertainty.includes('exp-3'));
  assert.match(result.uncertainty, /attribution is distinct from causal inference/);
});

test('MKT-066: the unregistered-adapter observability gap is disclosed, never converted into a state', () => {
  const result = evaluatePlatformHealth({
    ...baseInput(),
    account: { ...healthyAccount(), socialAdapterRegistered: false },
  });
  assert.equal(result.state, 'healthy');
  assert.match(result.uncertainty, /no social platform adapter is registered/);
});

// ---------------------------------------------------------------------------
// The frozen constants + guards (the vocabulary discipline)
// ---------------------------------------------------------------------------

test('MKT-066: the frozen calculation constants and vocabulary versions are pinned', () => {
  assert.equal(PLATFORM_HEALTH_MIN_BASELINE_POINTS, 3);
  assert.equal(PLATFORM_HEALTH_RECENT_POINTS, 2);
  assert.equal(PLATFORM_HEALTH_ANOMALY_DROP_RATIO, 0.5);
  assert.equal(PLATFORM_HEALTH_VOCABULARY_VERSION, 'ph-vocab-v1');
  assert.equal(PLATFORM_HEALTH_BASELINE_VERSION, 'ph-baseline-v1');
});

test('MKT-066: the provenance guard rejects malformed provenance (the server-derived discipline)', () => {
  assert.throws(
    () =>
      assertValidPlatformHealthProvenance({
        actor: '',
        recordedVia: 'api',
        correlationId: 'corr-1',
        causationId: null,
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.name === 'InvalidRequestError' &&
      String((error as { details?: readonly string[] }).details?.[0]).includes('provenance.actor'),
  );
  assert.throws(
    () =>
      assertValidPlatformHealthProvenance({
        actor: 'user:1',
        recordedVia: 'api',
        correlationId: '',
        causationId: null,
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.name === 'InvalidRequestError' &&
      String((error as { details?: readonly string[] }).details?.[0]).includes('provenance.correlationId'),
  );
  assertValidPlatformHealthProvenance({
    actor: 'user:1',
    recordedVia: 'api',
    correlationId: 'corr-1',
    causationId: null,
  });
});
