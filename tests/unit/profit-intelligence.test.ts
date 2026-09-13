/**
 * MKT-043 unit tests — the PURE /profit-intelligence derivations (no DB;
 * the operating-graph projection test precedent). Proves:
 *
 *   - THE FROZEN VOCABULARY (AC-2): the calculation version, the
 *     two-value provenance set, the revenue metric-name set and the full
 *     assumption record are exported constants — and the calculation
 *     disclosure ships them verbatim in every view;
 *   - REVENUE (AC-5a): latest-observation-wins per metric identity
 *     (observedAt, recordedAt tiebreak), grouping by DECLARED unit (never
 *     converted, never mixed), non-revenue names excluded, the dimension
 *     order-insensitivity of the identity key, the restatement +
 *     supersession disclosures and the /evidence provenance refs;
 *   - AI/PROVIDER COST (AC-5c): the telemetry spend sum with per-row
 *     references, the adapter-activity grouping (connections + events,
 *     counts and references only — no invented cost);
 *   - DELIVERY COST (AC-5b): deterministic/extension unit costs, the
 *     delivered-jobs human cost, in-flight jobs NEVER costed, human-kind
 *     executions counted but NOT costed, and the total as the exact
 *     component sum;
 *   - CAPACITY + UTILIZATION (AC-5b): only authorization-ACTIVE profiles
 *     count, weekly minutes sum, the estimated capacity-cost provenance,
 *     utilization null-with-reason on zero capacity;
 *   - SCOPE LEAKAGE (AC-5d): the three indicators — executions outside
 *     the ACTIVE deployed envelope, non-terminal work without a covering
 *     ACTIVE goal (client-wide vs. workspace-scoped covering rule),
 *     ACTIVE goals without delivery;
 *   - MARGIN (AC-5e): realized side = the costing-currency revenue slice
 *     minus observed delivery cost; estimated side = ACTIVE-goal revenue
 *     criteria (vocabulary + costing currency only) minus the standing
 *     weekly capacity commitment; observed and estimated NEVER mix; the
 *     no-FX policy (foreign-currency revenue disclosed as excluded);
 *   - CONTRIBUTION (AC-5e): the per-service attribution chain
 *     (instance → pinned definition → playbook version → playbook), the
 *     per-project (Deployment) attribution, the explicit unattributed
 *     remainders, per-service/project revenue NULL WITH REASON (never
 *     fabricated) and the per-client contribution row;
 *   - ASSUMPTION PROPAGATION (AC-2): every figure's assumptionKeys name
 *     REAL entries of the exported assumption set, every figure carries
 *     the calculation version and canonical source references, and a
 *     not-derivable figure always carries an explicit reason;
 *   - PINNING (AC-7): the same inputs derive byte-identical figures on
 *     every call (pure functions — no hidden state).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROFIT_INTELLIGENCE_ASSUMPTIONS,
  PROFIT_INTELLIGENCE_CALCULATION_VERSION,
  PROFIT_FIGURE_PROVENANCES,
  PROFIT_INTELLIGENCE_REVENUE_METRIC_NAMES,
  aggregateAiProviderCostSurfaces,
  aggregateDeliveryCostBreakdowns,
  aggregateProjectContributions,
  aggregateRevenueRollups,
  aggregateServiceContributions,
  composeCalculationDisclosure,
  deriveAiProviderCostSurface,
  deriveClientContributionRow,
  deriveDeliveryCostBreakdown,
  deriveHumanCapacitySurface,
  deriveMarginSurface,
  deriveProjectContributions,
  deriveRevenueRollup,
  deriveScopeLeakageSurface,
  deriveServiceContributions,
  deriveUtilizationSurface,
  metricIdentityKeyOf,
  type ProfitFigure,
} from '../../src/modules/profit-intelligence/public.ts';
import type {
  ClientAuthoritySnapshot,
  ResolvedJobRef,
} from '../../src/modules/profit-intelligence/public.ts';
import type { MetricObservationRecord } from '../../src/modules/metrics/public.ts';
import type { ExecutionRecord, ExecutionTaskLink } from '../../src/modules/executions/public.ts';
import type { UsageTelemetryRecord } from '../../src/modules/ai-runtime/public.ts';
import type { JobRecord } from '../../src/modules/jobs/public.ts';
import type { HumanAgentRecord } from '../../src/modules/field-agents/public.ts';
import type { GoalRecord } from '../../src/modules/goals/public.ts';
import type { DeploymentRecord } from '../../src/modules/deployments/public.ts';
import type { WorkflowInstanceRecord } from '../../src/modules/workflows/public.ts';
import type {
  IntegrationConnectionRecord,
  IntegrationIngestedEventRecord,
} from '../../src/modules/integrations/public.ts';

// ---------------------------------------------------------------------------
// Fixture identifiers
// ---------------------------------------------------------------------------

const AGENCY = '11111111-1111-4111-8111-111111111111';
const CLIENT = 'aaaaaaaa-0000-4000-8000-000000000001';
const WORKSPACE = 'bbbbbbbb-0000-4000-8000-000000000001';
const WORKSPACE2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const WORKSPACE3 = 'bbbbbbbb-0000-4000-8000-000000000003';
const GOAL_ACTIVE = 'cccccccc-0000-4000-8000-000000000001';
const GOAL_DRAFT = 'cccccccc-0000-4000-8000-000000000002';
const PLAYBOOK = 'dddddddd-0000-4000-8000-000000000001';
const PLAYBOOK_VERSION = 'eeeeeeee-0000-4000-8000-000000000001';
const DEPLOYMENT = 'ffffffff-0000-4000-8000-000000000001';
const WORKFLOW = 'abababab-0000-4000-8000-000000000001';
const DEFINITION = 'cdcdcdcd-0000-4000-8000-000000000001';
const INSTANCE = 'efefefef-0000-4000-8000-000000000001';
const INSTANCE2 = 'efefefef-0000-4000-8000-000000000002';
const EVIDENCE = 'a1a1a1a1-0000-4000-8000-000000000001';
const HUMAN_USER = '99999999-0000-4000-8000-000000000001';
const HUMAN_AGENT_PROFILE = '88888888-0000-4000-8000-000000000001';

// ---------------------------------------------------------------------------
// Fixture constructors (plain record snapshots — the module gathers these
// through the composed authorities' public contracts; unit tests feed them
// directly to the PURE derivations)
// ---------------------------------------------------------------------------

function metricObservation(
  overrides: Partial<MetricObservationRecord> = {},
): MetricObservationRecord {
  return {
    observationId: 'obs-00000000-0000-4000-8000-000000000001',
    clientId: CLIENT,
    workspaceId: null,
    metricName: 'revenue',
    dimensions: {},
    value: 100,
    unit: 'USD',
    source: { system: 'meta-ads', ref: 'report/2026-01-15' },
    observedAt: '2026-01-15T10:30:00.000Z',
    retrievedAt: '2026-01-15T11:00:00.000Z',
    evidenceRef: null,
    quality: 'ok',
    aggregationMethod: null,
    provenance: {
      actor: `user:${HUMAN_USER}`,
      recordedVia: 'api',
      correlationId: 'correlation-1',
      causationId: null,
      recordedAt: '2026-01-15T11:00:00.000Z',
    },
    ...overrides,
  };
}

function workflowNodeLink(instanceId: string): ExecutionTaskLink {
  return { kind: 'workflow-node', workflowInstanceId: instanceId, nodeId: 'a' };
}

function execution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    executionId: 'e0e0e0e0-0000-4000-8000-000000000001',
    taskLink: workflowNodeLink(INSTANCE),
    retryOfExecutionId: null,
    attemptNumber: 1,
    executionKind: 'deterministic',
    runtimeClass: 'pooled-worker',
    idempotencyKey: 'exec-key-1',
    createFingerprint: 'fp-1',
    workspaceId: WORKSPACE,
    clientId: CLIENT,
    agencyId: AGENCY,
    status: 'succeeded',
    retryClassification: null,
    createdBy: null,
    version: 1,
    createdAt: '2026-01-15T10:00:00.000Z',
    updatedAt: '2026-01-15T10:05:00.000Z',
    ...overrides,
  };
}

function usageTelemetry(overrides: Partial<UsageTelemetryRecord> = {}): UsageTelemetryRecord {
  return {
    usageId: 'u1u1u1u1-0000-4000-8000-000000000001',
    workspaceId: WORKSPACE,
    clientId: CLIENT,
    agencyId: AGENCY,
    taskProfileId: 't1t1t1t1-0000-4000-8000-000000000001',
    modelRegistryId: 'm1m1m1m1-0000-4000-8000-000000000001',
    executionId: null,
    correlationId: 'correlation-2',
    outcome: 'succeeded',
    latencyMs: 900,
    costAmount: 0.0125,
    tokensIn: 1500,
    tokensOut: 420,
    evaluationRef: null,
    escalationCount: 0,
    idempotencyKey: 'usage-key-1',
    createFingerprint: 'fp-2',
    createdBy: null,
    createdAt: '2026-01-15T10:05:00.000Z',
    ...overrides,
  };
}

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    jobId: 'j1j1j1j1-0000-4000-8000-000000000001',
    workflowInstanceId: INSTANCE,
    nodeId: 'visit',
    workspaceId: WORKSPACE,
    clientId: CLIENT,
    agencyId: AGENCY,
    title: 'Field visit',
    description: 'Visit the venue.',
    eligibility: {
      specialization: 'field_agent',
      requiredCapabilities: ['canvassing'],
      territory: { kind: 'city', value: 'accra' },
      availability: { dayOfWeek: 2, startMinute: 540, endMinute: 1020 },
    },
    status: 'outcome_submitted',
    acceptedAgentId: HUMAN_AGENT_PROFILE,
    acceptedUserId: HUMAN_USER,
    acceptedOfferId: 'o1o1o1o1-0000-4000-8000-000000000001',
    acceptedAt: '2026-01-16T09:00:00.000Z',
    createdBy: null,
    version: 1,
    createdAt: '2026-01-15T09:00:00.000Z',
    updatedAt: '2026-01-17T09:00:00.000Z',
    ...overrides,
  };
}

function humanAgentProfile(overrides: Partial<HumanAgentRecord> = {}): HumanAgentRecord {
  return {
    agentId: HUMAN_AGENT_PROFILE,
    userId: HUMAN_USER,
    specializations: ['field_agent'],
    capabilities: [{ skill: 'canvassing', level: 'advanced' }],
    availability: [{ dayOfWeek: 2, startMinute: 480, endMinute: 1080 }],
    location: { kind: 'city', value: 'accra' },
    territories: [],
    reliability: {
      completedJobs: 0,
      successfulJobs: 0,
      onTimeCompletions: 0,
      ratingSum: 0,
      ratingCount: 0,
    },
    relationshipContinuity: {
      prefersRepeatClients: true,
      continuity: 'preferred',
      maxConcurrentClientRelationships: 4,
    },
    authorizationState: 'active',
    createdBy: null,
    version: 1,
    createdAt: '2026-01-10T09:00:00.000Z',
    updatedAt: '2026-01-10T09:00:00.000Z',
    ...overrides,
  };
}

function goal(overrides: Partial<GoalRecord> = {}): GoalRecord {
  return {
    goalId: GOAL_ACTIVE,
    clientId: CLIENT,
    workspaceId: null,
    objective: 'Grow activated accounts.',
    successCriteria: [
      {
        metric: 'revenue',
        comparator: '>=',
        targetValue: 5000,
        unit: 'USD',
        description: 'Monthly recurring revenue target',
      },
    ],
    metrics: [{ name: 'revenue', unit: 'USD', description: 'observed only' }],
    constraints: [{ kind: 'risk', description: 'Email fatigue above 4 touches.' }],
    timeHorizon: { startsOn: '2026-04-01', endsOn: '2026-06-30' },
    status: 'active',
    createdBy: null,
    version: 1,
    createdAt: '2026-04-01T09:00:00.000Z',
    updatedAt: '2026-04-01T09:00:00.000Z',
    ...overrides,
  };
}

function deployment(overrides: Partial<DeploymentRecord> = {}): DeploymentRecord {
  return {
    deploymentId: DEPLOYMENT,
    agencyId: AGENCY,
    clientId: CLIENT,
    workspaceId: WORKSPACE,
    playbookVersionId: PLAYBOOK_VERSION,
    workflowDefinitionIds: [DEFINITION],
    requiredDomainPacks: [],
    requiredCapabilities: [],
    policyReferenceId: null,
    runtimeRequirements: { runtimeClass: 'pooled-worker' },
    triggerConfig: [{ kind: 'manual', config: null }],
    status: 'active',
    createdBy: null,
    version: 1,
    createdAt: '2026-04-02T09:00:00.000Z',
    updatedAt: '2026-04-02T09:00:00.000Z',
    ...overrides,
  };
}

function instance(overrides: Partial<WorkflowInstanceRecord> = {}): WorkflowInstanceRecord {
  return {
    workflowInstanceId: INSTANCE,
    workflowId: WORKFLOW,
    workflowDefinitionId: DEFINITION,
    workspaceId: WORKSPACE,
    clientId: CLIENT,
    agencyId: AGENCY,
    status: 'running',
    createdBy: null,
    version: 1,
    createdAt: '2026-04-03T09:00:00.000Z',
    updatedAt: '2026-04-03T09:00:00.000Z',
    ...overrides,
  };
}

function connection(overrides: Partial<IntegrationConnectionRecord> = {}): IntegrationConnectionRecord {
  return {
    connectionId: 'c1c1c1c1-0000-4000-8000-000000000001',
    clientId: CLIENT,
    agencyId: AGENCY,
    adapterKey: 'meta-ads',
    providerLabel: 'Meta Ads',
    status: 'registered',
    health: 'unknown',
    credentialReferenceId: 'k1k1k1k1-0000-4000-8000-000000000001',
    providerConfig: { region: 'eu-west-1' },
    rateLimit: null,
    lastError: null,
    lastCheckedAt: null,
    createdBy: null,
    version: 1,
    createdAt: '2026-04-04T09:00:00.000Z',
    updatedAt: '2026-04-04T09:00:00.000Z',
    ...overrides,
  };
}

function ingestedEvent(overrides: Partial<IntegrationIngestedEventRecord> = {}): IntegrationIngestedEventRecord {
  return {
    eventId: 'v1v1v1v1-0000-4000-8000-000000000001',
    connectionId: 'c1c1c1c1-0000-4000-8000-000000000001',
    clientId: CLIENT,
    adapterKey: 'meta-ads',
    eventType: 'report.completed',
    payload: { reportId: 'rep-1' },
    evidenceRef: null,
    provenance: {
      actor: 'service:webhook',
      recordedVia: 'webhook',
      correlationId: 'correlation-3',
      causationId: null,
      receivedAt: '2026-04-05T09:00:00.000Z',
    },
    ...overrides,
  };
}

/** The full client snapshot fixture (the attribution chain is complete). */
function fullSnapshot(overrides: Partial<ClientAuthoritySnapshot> = {}): ClientAuthoritySnapshot {
  return {
    agencyId: AGENCY,
    clientId: CLIENT,
    workspaceId: null,
    goals: [
      goal(),
      goal({ goalId: GOAL_DRAFT, status: 'draft', workspaceId: WORKSPACE }),
    ],
    metricObservations: [],
    workspaces: [
      {
        workspaceId: WORKSPACE,
        deployments: [deployment()],
        instances: [instance()],
        instanceDefinitionIds: new Map([[INSTANCE, DEFINITION]]),
        definitionPlaybookVersionIds: new Map([[DEFINITION, PLAYBOOK_VERSION]]),
        executions: [execution()],
        usageTelemetry: [usageTelemetry()],
      },
    ],
    resolvedJobs: [
      { job: job(), acceptedOfferId: 'o1o1o1o1-0000-4000-8000-000000000001' },
    ],
    humanAgentProfiles: [humanAgentProfile()],
    missingProfileUserIds: [],
    connections: [connection()],
    ingestedEvents: [ingestedEvent()],
    playbookVersionOwners: new Map([[PLAYBOOK_VERSION, PLAYBOOK]]),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. THE FROZEN VOCABULARY (AC-2)
// ---------------------------------------------------------------------------

test('the calculation vocabulary is frozen and exported (version, provenance, revenue names, assumptions)', () => {
  assert.equal(typeof PROFIT_INTELLIGENCE_CALCULATION_VERSION, 'string');
  assert.ok(PROFIT_INTELLIGENCE_CALCULATION_VERSION.length > 0);
  assert.deepEqual(PROFIT_FIGURE_PROVENANCES, ['observed', 'estimated']);
  // The revenue interpretation set (the explicit assumption).
  assert.ok(PROFIT_INTELLIGENCE_REVENUE_METRIC_NAMES.includes('revenue'));
  assert.ok(PROFIT_INTELLIGENCE_ASSUMPTIONS.revenueMetricNames.includes('mrr'));
  // The assumption set is fully concrete — no hidden constants.
  assert.equal(PROFIT_INTELLIGENCE_ASSUMPTIONS.costingCurrency, 'USD');
  assert.equal(PROFIT_INTELLIGENCE_ASSUMPTIONS.humanDeliveredJobCostUsd, 75);
  assert.equal(PROFIT_INTELLIGENCE_ASSUMPTIONS.deliveredJobMinutes, 120);
  assert.equal(PROFIT_INTELLIGENCE_ASSUMPTIONS.deterministicExecutionCostUsd, 0.05);
  assert.equal(PROFIT_INTELLIGENCE_ASSUMPTIONS.extensionExecutionCostUsd, 0.02);
  assert.equal(PROFIT_INTELLIGENCE_ASSUMPTIONS.humanHourlyRateUsd, 55);
  assert.equal(PROFIT_INTELLIGENCE_ASSUMPTIONS.capacityWindowRecurrence, 'weekly');
  assert.equal(PROFIT_INTELLIGENCE_ASSUMPTIONS.humanExecutionCostAttribution, 'utilization-indicator-only');
  assert.equal(PROFIT_INTELLIGENCE_ASSUMPTIONS.latestObservationWinsPerMetricIdentity, true);
});

test('the calculation disclosure ships the version + the full assumption record verbatim', () => {
  const disclosure = composeCalculationDisclosure();
  assert.equal(disclosure.calculationVersion, PROFIT_INTELLIGENCE_CALCULATION_VERSION);
  assert.deepEqual(disclosure.assumptions, PROFIT_INTELLIGENCE_ASSUMPTIONS);
  assert.equal(disclosure.basis, 'live-derivation-over-canonical-authorities');
  assert.equal(disclosure.persistence, 'none-derived-read-model');
});

// ---------------------------------------------------------------------------
// 2. REVENUE (AC-5a)
// ---------------------------------------------------------------------------

test('revenue: latest-observation-wins per identity; superseded rows are counted, never summed', () => {
  const rollup = deriveRevenueRollup([
    metricObservation({
      observationId: 'obs-1',
      value: 100,
      observedAt: '2026-01-15T10:30:00.000Z',
      provenance: { actor: 'user:x', recordedVia: 'api', correlationId: 'c', causationId: null, recordedAt: '2026-01-15T11:00:00.000Z' },
    }),
    // A LATER restatement of the SAME identity (same name + dimensions +
    // workspace scope) supersedes the 100 row.
    metricObservation({
      observationId: 'obs-2',
      value: 250,
      quality: 'restated',
      observedAt: '2026-01-16T10:30:00.000Z',
      provenance: { actor: 'user:x', recordedVia: 'api', correlationId: 'c', causationId: null, recordedAt: '2026-01-16T11:00:00.000Z' },
    }),
    // An EARLIER row than obs-1 for the same identity — superseded too.
    metricObservation({
      observationId: 'obs-0',
      value: 999,
      observedAt: '2026-01-14T10:30:00.000Z',
      provenance: { actor: 'user:x', recordedVia: 'api', correlationId: 'c', causationId: null, recordedAt: '2026-01-14T11:00:00.000Z' },
    }),
  ]);
  assert.equal(rollup.observationCount, 3, 'all three in-scope rows were examined');
  assert.equal(rollup.supersededObservationCount, 2);
  assert.equal(rollup.restatedIdentityCount, 1);
  assert.equal(rollup.byCurrency.length, 1);
  const usd = rollup.byCurrency[0]!;
  assert.equal(usd.currency, 'USD');
  assert.equal(usd.total.value, 250);
  assert.equal(usd.identityCount, 1);
  assert.deepEqual(
    usd.total.sourceRefs,
    [{ kind: 'metric-observation', id: 'obs-2' }],
    'only the winning row is cited',
  );
  assert.equal(rollup.qualityCounts['restated'], 1);
});

test('revenue: the recordedAt tiebreak resolves same-observedAt restatements', () => {
  const rollup = deriveRevenueRollup([
    metricObservation({
      observationId: 'obs-a',
      value: 100,
      observedAt: '2026-01-15T10:30:00.000Z',
      provenance: { actor: 'user:x', recordedVia: 'api', correlationId: 'c', causationId: null, recordedAt: '2026-01-15T11:00:00.000Z' },
    }),
    metricObservation({
      observationId: 'obs-b',
      value: 300,
      observedAt: '2026-01-15T10:30:00.000Z',
      provenance: { actor: 'user:x', recordedVia: 'api', correlationId: 'c', causationId: null, recordedAt: '2026-01-15T12:00:00.000Z' },
    }),
  ]);
  assert.equal(rollup.byCurrency[0]!.total.value, 300, 'the later-recorded row wins the tie');
});

test('revenue: identities are name + dimensions + workspace scope; dimension order never matters', () => {
  assert.equal(
    metricIdentityKeyOf(metricObservation({ dimensions: { a: 1, b: 'x' } })),
    metricIdentityKeyOf(metricObservation({ dimensions: { b: 'x', a: 1 } })),
    'dimension key order is irrelevant to the identity',
  );
  assert.notEqual(
    metricIdentityKeyOf(metricObservation({ workspaceId: WORKSPACE })),
    metricIdentityKeyOf(metricObservation({ workspaceId: null })),
    'workspace scope splits identities',
  );
  const rollup = deriveRevenueRollup([
    metricObservation({ observationId: 'obs-1', dimensions: { channel: 'meta' }, value: 100 }),
    metricObservation({ observationId: 'obs-2', dimensions: { channel: 'google' }, value: 50 }),
    metricObservation({ observationId: 'obs-3', dimensions: {}, value: 25 }),
    metricObservation({ observationId: 'obs-w', workspaceId: WORKSPACE, dimensions: {}, value: 10 }),
  ]);
  const usd = rollup.byCurrency[0]!;
  assert.equal(usd.identityCount, 4, 'four distinct identities contribute');
  assert.equal(usd.total.value, 185);
});

test('revenue: grouping is by DECLARED unit — never converted, never mixed; non-revenue names excluded', () => {
  const rollup = deriveRevenueRollup([
    metricObservation({ observationId: 'obs-usd', metricName: 'revenue', value: 100, unit: 'USD', dimensions: { series: 'usd' } }),
    metricObservation({ observationId: 'obs-eur', metricName: 'mrr', value: 90, unit: 'EUR', dimensions: { series: 'eur' } }),
    metricObservation({ observationId: 'obs-count', metricName: 'revenue', value: 7, unit: 'count', dimensions: { series: 'count' } }),
    metricObservation({ observationId: 'obs-not-revenue', metricName: 'activation_rate', value: 0.4, unit: '%' }),
  ]);
  assert.equal(rollup.observationCount, 3, 'activation_rate was never in the revenue slice');
  const currencies = rollup.byCurrency.map((entry) => entry.currency);
  assert.deepEqual(currencies, ['count', 'EUR', 'USD'], 'sorted by declared unit (locale order)');
  assert.equal(rollup.byCurrency.find((entry) => entry.currency === 'USD')!.total.value, 100);
  assert.equal(rollup.byCurrency.find((entry) => entry.currency === 'EUR')!.total.value, 90);
  assert.equal(rollup.byCurrency.find((entry) => entry.currency === 'count')!.total.value, 7);
});

test('revenue: evidence provenance refs ship for observations that carry an evidence link', () => {
  const rollup = deriveRevenueRollup([
    metricObservation({ observationId: 'obs-1', dimensions: { series: 'a' }, evidenceRef: EVIDENCE }),
    metricObservation({ observationId: 'obs-2', dimensions: { series: 'b' }, evidenceRef: null }),
  ]);
  assert.deepEqual(rollup.evidenceRefs, [{ kind: 'evidence', id: EVIDENCE }]);
});

// ---------------------------------------------------------------------------
// 3. AI/PROVIDER COST (AC-5c)
// ---------------------------------------------------------------------------

test('AI/provider cost: the telemetry spend sums with per-row references; adapter activity is counts + refs only', () => {
  const surface = deriveAiProviderCostSurface(
    [
      usageTelemetry({ usageId: 'u-1', costAmount: 0.0125 }),
      usageTelemetry({ usageId: 'u-2', costAmount: 0.0075 }),
    ],
    [
      connection({ connectionId: 'c-1' }),
      connection({ connectionId: 'c-2' }),
      connection({ connectionId: 'c-3', adapterKey: 'google-ads' }),
    ],
    [
      ingestedEvent({ eventId: 'v-1' }),
      ingestedEvent({ eventId: 'v-2', adapterKey: 'google-ads' }),
    ],
  );
  assert.equal(surface.telemetryCost.value, 0.02);
  assert.equal(surface.telemetryCost.currency, 'USD');
  assert.equal(surface.telemetryCost.provenance, 'observed');
  assert.deepEqual(surface.telemetryCost.sourceRefs, [
    { kind: 'usage-telemetry', id: 'u-1' },
    { kind: 'usage-telemetry', id: 'u-2' },
  ]);
  assert.equal(surface.telemetryRowCount, 2);
  assert.deepEqual(surface.adapterActivity.map((row) => row.adapterKey), ['google-ads', 'meta-ads']);
  const meta = surface.adapterActivity.find((row) => row.adapterKey === 'meta-ads')!;
  assert.equal(meta.connectionCount, 2);
  assert.equal(meta.ingestedEventCount, 1);
  const google = surface.adapterActivity.find((row) => row.adapterKey === 'google-ads')!;
  assert.equal(google.connectionCount, 1);
  assert.equal(google.ingestedEventCount, 1);
  assert.ok(surface.adapterActivityNote.length > 0, 'the no-invented-cost note is explicit');
});

// ---------------------------------------------------------------------------
// 4. DELIVERY COST (AC-5b)
// ---------------------------------------------------------------------------

test('delivery cost: deterministic + extension unit costs, delivered human jobs, in-flight NEVER costed', () => {
  const breakdown = deriveDeliveryCostBreakdown({
    executions: [
      execution({ executionId: 'e-det-1', executionKind: 'deterministic' }),
      execution({ executionId: 'e-det-2', executionKind: 'deterministic', status: 'failed' }),
      execution({ executionId: 'e-ext-1', executionKind: 'extension' }),
      execution({ executionId: 'e-ai-1', executionKind: 'ai' }),
      execution({ executionId: 'e-hum-1', executionKind: 'human' }),
    ],
    usageTelemetry: [usageTelemetry({ usageId: 'u-1', costAmount: 0.01 })],
    resolvedJobs: [
      { job: job(), acceptedOfferId: 'offer-1' },
      { job: job({ jobId: 'j2', status: 'accepted', acceptedOfferId: 'offer-2' }), acceptedOfferId: 'offer-2' },
    ],
    connections: [],
    ingestedEvents: [],
  });
  // Every lifecycle state counts (the attempt ledger): 2×0.05 + 1×0.02.
  assert.equal(breakdown.automationDeliveryCost.value, 0.12);
  assert.deepEqual(breakdown.executionCounts, { deterministic: 2, ai: 1, human: 1, extension: 1 });
  assert.equal(breakdown.executionStatusCounts['failed'], 1);
  assert.equal(breakdown.executionStatusCounts['succeeded'], 4);
  // One delivered job × 75.
  assert.equal(breakdown.humanDeliveryCost.value, 75);
  assert.equal(breakdown.deliveredJobCount, 1);
  assert.equal(breakdown.inFlightJobCount, 1);
  // AI/provider telemetry is part of the total.
  assert.equal(breakdown.totalDeliveryCost.value, 75.13);
  assert.deepEqual(breakdown.humanDeliveryCost.sourceRefs, [
    { kind: 'job', id: 'j1j1j1j1-0000-4000-8000-000000000001' },
    { kind: 'job-offer', id: 'offer-1' },
  ]);
  // Human-kind executions are an indicator, NOT a cost (no double count).
  assert.equal(breakdown.humanExecutionCostAttribution, 'utilization-indicator-only');
  assert.ok(!breakdown.automationDeliveryCost.sourceRefs.some((ref) => ref.id === 'e-ai-1'));
  assert.ok(!breakdown.automationDeliveryCost.sourceRefs.some((ref) => ref.id === 'e-hum-1'));
});

// ---------------------------------------------------------------------------
// 5. CAPACITY + UTILIZATION (AC-5b)
// ---------------------------------------------------------------------------

test('capacity: only authorization-ACTIVE profiles count; weekly minutes and the estimated cost', () => {
  const surface = deriveHumanCapacitySurface(
    [
      humanAgentProfile({ agentId: 'ha-1', availability: [{ dayOfWeek: 2, startMinute: 480, endMinute: 1080 }] }),
      humanAgentProfile({ agentId: 'ha-2', authorizationState: 'suspended' }),
    ],
    ['user-without-profile'],
  );
  assert.equal(surface.activeProfileCount, 1);
  assert.equal(surface.skippedProfileCount, 2, 'suspended profile + missing profile both skipped');
  assert.equal(surface.weeklyCapacityMinutes, 600);
  assert.equal(surface.weeklyCapacityCost.value, 550); // 600/60 × 55
  assert.equal(surface.weeklyCapacityCost.provenance, 'estimated', 'declared capacity is ESTIMATED, not observed');
  assert.deepEqual(surface.profileRefs, [{ kind: 'human-agent-profile', id: 'ha-1' }]);
});

test('utilization: delivered work minutes over declared capacity; null-with-reason when capacity is zero', () => {
  const withCapacity = deriveUtilizationSurface({
    deliveredJobCount: 2,
    humanExecutionCount: 3,
    capacityMinutes: 600,
    deliveredJobRefs: [{ kind: 'job', id: 'j-1' }],
    capacityRefs: [{ kind: 'human-agent-profile', id: 'ha-1' }],
  });
  assert.equal(withCapacity.deliveredWorkMinutes.value, 240); // 2 × 120
  assert.equal(withCapacity.capacityMinutes.value, 600);
  assert.equal(withCapacity.utilization.value, 0.4);
  assert.equal(withCapacity.humanExecutionCount, 3, 'disclosed indicator');
  assert.ok(withCapacity.numeratorNote.includes('deliberately NOT added'));

  const noCapacity = deriveUtilizationSurface({
    deliveredJobCount: 1,
    humanExecutionCount: 0,
    capacityMinutes: 0,
    deliveredJobRefs: [],
    capacityRefs: [],
  });
  assert.equal(noCapacity.utilization.value, null);
  assert.ok(noCapacity.utilization.notDerivableReason !== null);
  assert.ok(noCapacity.utilization.notDerivableReason!.includes('no declared human capacity'));
});

// ---------------------------------------------------------------------------
// 6. SCOPE LEAKAGE (AC-5d)
// ---------------------------------------------------------------------------

test('scope leakage: the three indicators derive from declared scope vs. delivered work', () => {
  const surface = deriveScopeLeakageSurface({
    goals: [
      // Workspace-scoped ACTIVE goal covering WORKSPACE only.
      goal({ goalId: 'g-active-covered', workspaceId: WORKSPACE }),
      // Workspace-scoped ACTIVE goal whose workspace has ZERO instances —
      // declared scope never delivered.
      goal({ goalId: 'g-active-no-delivery', workspaceId: WORKSPACE3, successCriteria: [] }),
    ],
    workspaces: [
      {
        workspaceId: WORKSPACE,
        // The ACTIVE deployment declares DEFINITION; INSTANCE pins it.
        deployments: [deployment()],
        instances: [instance()],
      },
      {
        workspaceId: WORKSPACE2,
        // NO deployments and NO covering goal (the only ACTIVE goal in
        // scope is WORKSPACE-scoped) — the non-terminal instance leaks.
        deployments: [],
        instances: [instance({ workflowInstanceId: INSTANCE2, workspaceId: WORKSPACE2 })],
      },
      {
        workspaceId: WORKSPACE3,
        // The declared-but-never-delivered workspace: zero instances.
        deployments: [],
        instances: [],
      },
    ],
    executions: [
      // Covered: workflow-node linked to INSTANCE whose definition is
      // declared by the ACTIVE deployment of WORKSPACE.
      execution({ executionId: 'e-covered' }),
      // Outside the deployed envelope: linked to INSTANCE2 (WORKSPACE2 has
      // no ACTIVE deployment declaring its definition).
      execution({ executionId: 'e-leaked', taskLink: workflowNodeLink(INSTANCE2), workspaceId: WORKSPACE2 }),
      // External-request executions are out of the rule entirely.
      execution({
        executionId: 'e-external',
        taskLink: { kind: 'external-request', externalRequestRef: 'ref-1' },
      }),
    ],
  });
  const byKind = new Map(surface.indicators.map((indicator) => [indicator.kind, indicator]));
  const envelope = byKind.get('executions-outside-deployed-envelope')!;
  assert.equal(envelope.count, 1);
  assert.deepEqual(envelope.sourceRefs, [{ kind: 'execution', id: 'e-leaked' }]);
  assert.ok(envelope.rule.length > 0, 'the rule is stated verbatim');

  const withoutGoal = byKind.get('work-without-active-goal')!;
  assert.equal(withoutGoal.count, 1);
  assert.deepEqual(withoutGoal.sourceRefs, [{ kind: 'workflow-instance', id: INSTANCE2 }]);

  const withoutDelivery = byKind.get('active-goals-without-delivery')!;
  assert.equal(withoutDelivery.count, 1);
  assert.deepEqual(withoutDelivery.sourceRefs, [{ kind: 'goal', id: 'g-active-no-delivery' }]);
});

test('scope leakage: the covering rule — a client-wide ACTIVE goal covers EVERY workspace', () => {
  const surface = deriveScopeLeakageSurface({
    goals: [goal({ goalId: 'g-wide', workspaceId: null })],
    workspaces: [
      {
        workspaceId: WORKSPACE,
        deployments: [],
        instances: [instance()],
      },
      {
        workspaceId: WORKSPACE2,
        deployments: [],
        instances: [instance({ workflowInstanceId: INSTANCE2, workspaceId: WORKSPACE2 })],
      },
    ],
    executions: [],
  });
  const byKind = new Map(surface.indicators.map((indicator) => [indicator.kind, indicator]));
  assert.equal(byKind.get('work-without-active-goal')!.count, 0, 'both workspaces are covered');
  // And the client-wide goal HAS delivery (instances exist in scope).
  assert.equal(byKind.get('active-goals-without-delivery')!.count, 0);
});

// ---------------------------------------------------------------------------
// 7. MARGIN (AC-5e)
// ---------------------------------------------------------------------------

test('margin: realized = costing-currency revenue slice − observed delivery cost; estimated = ACTIVE goal criteria − standing capacity', () => {
  const revenue = deriveRevenueRollup([
    metricObservation({ observationId: 'obs-usd', value: 5000, unit: 'USD', dimensions: { series: 'usd' } }),
    metricObservation({ observationId: 'obs-eur', value: 90, unit: 'EUR', dimensions: { series: 'eur' } }),
  ]);
  const costs = deriveDeliveryCostBreakdown({
    executions: [execution()],
    usageTelemetry: [usageTelemetry({ costAmount: 0.0125 })],
    resolvedJobs: [{ job: job(), acceptedOfferId: 'offer-1' }],
    connections: [],
    ingestedEvents: [],
  });
  const capacity = deriveHumanCapacitySurface([humanAgentProfile()], []);
  const margin = deriveMarginSurface({
    revenue,
    costs,
    goals: [
      goal({ goalId: 'g-active', successCriteria: [
        { metric: 'revenue', comparator: '>=', targetValue: 5000, unit: 'USD', description: null },
        { metric: 'arr', comparator: '>=', targetValue: 60000, unit: 'USD', description: null },
        { metric: 'revenue', comparator: '>=', targetValue: 777, unit: 'EUR', description: null },
      ] }),
      goal({ goalId: 'g-draft', status: 'draft', successCriteria: [
        { metric: 'revenue', comparator: '>=', targetValue: 9999, unit: 'USD', description: null },
      ] }),
    ],
    weeklyCapacityCost: capacity.weeklyCapacityCost,
  });
  // Realized: 5000 − (0.05 + 75 + 0.0125) = 4924.94.
  assert.equal(margin.realizedRevenue.value, 5000);
  assert.equal(margin.realizedDeliveryCost.value, 75.06);
  assert.equal(margin.realizedMargin.value, 4924.94);
  assert.equal(margin.realizedRevenue.provenance, 'observed');
  // Estimated: only ACTIVE goals' revenue-vocabulary + USD criteria count
  // (5000 + 60000 — the EUR criterion and the draft goal never mix in).
  assert.equal(margin.estimatedRevenue.value, 65000);
  assert.equal(margin.estimatedRevenue.provenance, 'estimated');
  assert.equal(margin.estimatedDeliveryCost.value, 550); // 600 min × 55/h
  assert.equal(margin.estimatedMargin.value, 64450);
  // The no-FX policy is disclosed: EUR revenue is excluded, never converted.
  assert.ok(margin.currencyPolicyNote.includes('EUR'));
  assert.ok(margin.currencyPolicyNote.includes('NOT converted'));
});

test('margin: zero USD revenue is an observed ZERO (not a null); margins stay derived', () => {
  const revenue = deriveRevenueRollup([
    metricObservation({ observationId: 'obs-eur', value: 90, unit: 'EUR' }),
  ]);
  const costs = deriveDeliveryCostBreakdown({
    executions: [],
    usageTelemetry: [],
    resolvedJobs: [],
    connections: [],
    ingestedEvents: [],
  });
  const capacity = deriveHumanCapacitySurface([], []);
  const margin = deriveMarginSurface({
    revenue,
    costs,
    goals: [],
    weeklyCapacityCost: capacity.weeklyCapacityCost,
  });
  assert.equal(margin.realizedRevenue.value, 0);
  assert.equal(margin.realizedMargin.value, 0);
  assert.equal(margin.estimatedDeliveryCost.value, 0);
});

// ---------------------------------------------------------------------------
// 8. CONTRIBUTION (AC-5e)
// ---------------------------------------------------------------------------

test('service contributions: the attribution chain + the explicit unattributed remainder', () => {
  const snapshot = fullSnapshot({
    workspaces: [
      {
        workspaceId: WORKSPACE,
        deployments: [],
        instances: [instance()],
        instanceDefinitionIds: new Map([[INSTANCE, DEFINITION]]),
        definitionPlaybookVersionIds: new Map([[DEFINITION, PLAYBOOK_VERSION]]),
        executions: [
          // Attribution chain resolves: execution → INSTANCE → DEFINITION →
          // PLAYBOOK_VERSION → PLAYBOOK.
          execution({ executionId: 'e-chained', executionKind: 'deterministic' }),
          // External-request execution: no chain → unattributed.
          execution({
            executionId: 'e-external',
            executionKind: 'extension',
            taskLink: { kind: 'external-request', externalRequestRef: 'ref-1' },
          }),
        ],
        usageTelemetry: [
          // Telemetry linked to the chained execution attributes to the playbook.
          usageTelemetry({ usageId: 'u-chained', costAmount: 0.02, executionId: 'e-chained' }),
          // Telemetry with NO execution link → unattributed.
          usageTelemetry({ usageId: 'u-orphan', costAmount: 0.01, executionId: null }),
        ],
      },
    ],
    resolvedJobs: [
      // The delivered job's instance chain resolves to the playbook.
      { job: job(), acceptedOfferId: 'offer-1' },
      // A delivered job whose instance has NO chain → unattributed.
      {
        job: job({
          jobId: 'j-unchained',
          workflowInstanceId: 'instance-unresolvable',
        }),
        acceptedOfferId: 'offer-2',
      },
    ],
  });
  const result = deriveServiceContributions({ snapshot });
  assert.equal(result.rows.length, 1);
  const row = result.rows[0]!;
  assert.equal(row.playbookId, PLAYBOOK);
  // 0.05 (deterministic execution) + 0.02 (chained telemetry) + 75 (job).
  assert.equal(row.deliveryCost.value, 75.07);
  assert.equal(row.deliveredJobCount, 1);
  assert.equal(row.executionCount, 1);
  // Revenue attribution is NULL WITH REASON — never fabricated.
  assert.equal(row.revenue.value, null);
  assert.ok(row.revenue.notDerivableReason!.includes('no playbook reference'));
  // The unattributed remainder: 0.02 (extension external) + 0.01 (orphan
  // telemetry) + 75 (unchained delivered job).
  assert.equal(result.unattributedDeliveryCost.value, 75.03);
});

test('project contributions: deployments attribute by pinned definition; unattributed is disclosed', () => {
  const snapshot = fullSnapshot({
    workspaces: [
      {
        workspaceId: WORKSPACE,
        deployments: [deployment()],
        instances: [instance()],
        instanceDefinitionIds: new Map([[INSTANCE, DEFINITION]]),
        definitionPlaybookVersionIds: new Map([[DEFINITION, PLAYBOOK_VERSION]]),
        executions: [
          execution({ executionId: 'e-chained', executionKind: 'deterministic' }),
          execution({
            executionId: 'e-external',
            executionKind: 'extension',
            taskLink: { kind: 'external-request', externalRequestRef: 'ref-1' },
          }),
        ],
        usageTelemetry: [
          usageTelemetry({ usageId: 'u-chained', costAmount: 0.02, executionId: 'e-chained' }),
        ],
      },
    ],
    resolvedJobs: [
      { job: job(), acceptedOfferId: 'offer-1' },
      {
        job: job({ jobId: 'j-unchained', workflowInstanceId: 'instance-unresolvable' }),
        acceptedOfferId: 'offer-2',
      },
    ],
  });
  const result = deriveProjectContributions({ snapshot });
  assert.equal(result.rows.length, 1);
  const row = result.rows[0]!;
  assert.equal(row.deploymentId, DEPLOYMENT);
  assert.equal(row.deploymentStatus, 'active');
  // 0.05 + 0.02 (telemetry through the chained execution) + 75.
  assert.equal(row.deliveryCost.value, 75.07);
  assert.equal(row.deliveredJobCount, 1);
  assert.equal(row.executionCount, 2, 'the telemetry attribution counts as an execution attribution');
  assert.equal(row.revenue.value, null);
  assert.ok(row.revenue.notDerivableReason!.includes('no deployment reference'));
  assert.equal(result.unattributedDeliveryCost.value, 75.02, 'extension external + the unchained job');
});

test('client contribution row: revenue − delivery cost in the costing currency', () => {
  const revenue = deriveRevenueRollup([
    metricObservation({ observationId: 'obs-usd', value: 5000, unit: 'USD', dimensions: { series: 'usd' } }),
    metricObservation({ observationId: 'obs-eur', value: 90, unit: 'EUR', dimensions: { series: 'eur' } }),
  ]);
  const costs = deriveDeliveryCostBreakdown({
    executions: [execution()],
    usageTelemetry: [],
    resolvedJobs: [{ job: job(), acceptedOfferId: 'offer-1' }],
    connections: [],
    ingestedEvents: [],
  });
  const row = deriveClientContributionRow({ clientId: CLIENT, revenue, costs });
  assert.equal(row.clientId, CLIENT);
  assert.equal(row.revenue.value, 5000);
  assert.equal(row.deliveryCost.value, 75.05);
  assert.equal(row.margin.value, 4924.95);
});

// ---------------------------------------------------------------------------
// 9. AGGREGATION (the portfolio rollups)
// ---------------------------------------------------------------------------

test('aggregation: revenue rollups, cost breakdowns, AI surfaces, service and project contributions merge purely', () => {
  const revenue = deriveRevenueRollup([
    metricObservation({ observationId: 'obs-1', value: 100, dimensions: { series: 'a' } }),
  ]);
  const revenue2 = deriveRevenueRollup([
    metricObservation({ observationId: 'obs-2', value: 50, unit: 'USD', dimensions: { series: 'b' } }),
    metricObservation({ observationId: 'obs-3', value: 30, unit: 'EUR', dimensions: { series: 'c' } }),
  ]);
  const mergedRevenue = aggregateRevenueRollups([revenue, revenue2]);
  assert.equal(mergedRevenue.byCurrency.find((entry) => entry.currency === 'USD')!.total.value, 150);
  assert.equal(mergedRevenue.byCurrency.find((entry) => entry.currency === 'EUR')!.total.value, 30);
  assert.equal(mergedRevenue.observationCount, 3);

  const costs = deriveDeliveryCostBreakdown({
    executions: [execution()],
    usageTelemetry: [usageTelemetry({ costAmount: 0.01 })],
    resolvedJobs: [{ job: job(), acceptedOfferId: 'offer-1' }],
    connections: [connection()],
    ingestedEvents: [ingestedEvent()],
  });
  const costs2 = deriveDeliveryCostBreakdown({
    executions: [execution({ executionId: 'e-2', executionKind: 'extension' })],
    usageTelemetry: [usageTelemetry({ usageId: 'u-2', costAmount: 0.02 })],
    resolvedJobs: [],
    connections: [connection({ connectionId: 'c-2', adapterKey: 'google-ads' })],
    ingestedEvents: [],
  });
  const mergedCosts = aggregateDeliveryCostBreakdowns([costs, costs2]);
  assert.equal(mergedCosts.automationDeliveryCost.value, 0.07);
  assert.equal(mergedCosts.humanDeliveryCost.value, 75);
  assert.equal(mergedCosts.deliveredJobCount, 1);
  assert.deepEqual(mergedCosts.executionCounts, { deterministic: 1, ai: 0, human: 0, extension: 1 });
  assert.equal(mergedCosts.aiProvider.telemetryCost.value, 0.03);
  assert.equal(mergedCosts.aiProvider.telemetryRowCount, 2);
  assert.deepEqual(
    mergedCosts.aiProvider.adapterActivity.map((row) => row.adapterKey),
    ['google-ads', 'meta-ads'],
  );

  const service = deriveServiceContributions({ snapshot: fullSnapshot() });
  const service2 = deriveServiceContributions({
    snapshot: fullSnapshot({
      workspaces: [
        {
          workspaceId: WORKSPACE,
          deployments: [],
          instances: [instance()],
          instanceDefinitionIds: new Map([[INSTANCE, DEFINITION]]),
          definitionPlaybookVersionIds: new Map([[DEFINITION, PLAYBOOK_VERSION]]),
          executions: [execution({ executionId: 'e-2' })],
          usageTelemetry: [],
        },
      ],
      resolvedJobs: [],
    }),
  });
  const mergedService = aggregateServiceContributions([service, service2]);
  assert.equal(mergedService.rows.length, 1);
  assert.equal(mergedService.rows[0]!.deliveryCost.value, 75.1);
  assert.equal(mergedService.rows[0]!.executionCount, 2);

  const project = deriveProjectContributions({ snapshot: fullSnapshot() });
  const mergedProject = aggregateProjectContributions([project, project]);
  assert.equal(mergedProject.rows.length, 1);
  assert.equal(mergedProject.rows[0]!.deliveryCost.value, 150.1);
  assert.equal(mergedProject.rows[0]!.deliveredJobCount, 2);

  const aiMerged = aggregateAiProviderCostSurfaces([costs.aiProvider, costs2.aiProvider]);
  assert.equal(aiMerged.telemetryCost.value, 0.03);
  assert.equal(aiMerged.adapterActivity.length, 2);
});

// ---------------------------------------------------------------------------
// 10. ASSUMPTION PROPAGATION + HONESTY (AC-2)
// ---------------------------------------------------------------------------

test('assumption propagation: every figure names REAL assumption-set keys, carries the version and canonical refs', () => {
  const assumptionKeys = new Set(Object.keys(PROFIT_INTELLIGENCE_ASSUMPTIONS));
  const snapshot = fullSnapshot();
  const revenue = deriveRevenueRollup(snapshot.metricObservations.length > 0 ? snapshot.metricObservations : [
    metricObservation({ observationId: 'obs-1' }),
  ]);
  const costs = deriveDeliveryCostBreakdown({
    executions: snapshot.workspaces[0]!.executions,
    usageTelemetry: snapshot.workspaces[0]!.usageTelemetry,
    resolvedJobs: snapshot.resolvedJobs,
    connections: snapshot.connections,
    ingestedEvents: snapshot.ingestedEvents,
  });
  const capacity = deriveHumanCapacitySurface(snapshot.humanAgentProfiles, []);
  const margin = deriveMarginSurface({
    revenue,
    costs,
    goals: snapshot.goals,
    weeklyCapacityCost: capacity.weeklyCapacityCost,
  });
  const figures: ProfitFigure[] = [
    revenue.byCurrency[0]!.total,
    costs.automationDeliveryCost,
    costs.humanDeliveryCost,
    costs.totalDeliveryCost,
    costs.aiProvider.telemetryCost,
    capacity.weeklyCapacityCost,
    margin.realizedRevenue,
    margin.realizedMargin,
    margin.estimatedRevenue,
    margin.estimatedMargin,
  ];
  for (const figure of figures) {
    assert.equal(figure.calculationVersion, PROFIT_INTELLIGENCE_CALCULATION_VERSION);
    assert.ok(figure.assumptionKeys.length > 0);
    for (const key of figure.assumptionKeys) {
      assert.ok(assumptionKeys.has(key), `assumption key '${key}' names a REAL assumption-set entry`);
    }
  }
  // Every money figure cites at least one canonical record id.
  for (const figure of [costs.humanDeliveryCost, costs.aiProvider.telemetryCost]) {
    assert.ok(figure.sourceRefs.length > 0);
    for (const ref of figure.sourceRefs) {
      assert.ok(ref.kind.length > 0 && ref.id.length > 0);
    }
  }
});

test('honesty: a not-derivable figure ALWAYS carries an explicit reason (never a silent zero)', () => {
  const noCapacity = deriveUtilizationSurface({
    deliveredJobCount: 0,
    humanExecutionCount: 0,
    capacityMinutes: 0,
    deliveredJobRefs: [],
    capacityRefs: [],
  });
  assert.equal(noCapacity.utilization.value, null);
  assert.ok(noCapacity.utilization.notDerivableReason!.length > 0);
  const service = deriveServiceContributions({ snapshot: fullSnapshot() });
  assert.equal(service.rows[0]!.revenue.value, null);
  assert.ok(service.rows[0]!.revenue.notDerivableReason!.length > 0);
});

// ---------------------------------------------------------------------------
// 11. PINNING (AC-7) — pure functions derive byte-identical figures
// ---------------------------------------------------------------------------

test('calculation-version pinning: the same inputs derive byte-identical figures on every call', () => {
  const observations = [
    metricObservation({ observationId: 'obs-1', value: 100 }),
    metricObservation({ observationId: 'obs-2', value: 250, quality: 'restated', observedAt: '2026-01-16T10:30:00.000Z' }),
  ];
  const executionsList = [
    execution({ executionId: 'e-1' }),
    execution({ executionId: 'e-2', executionKind: 'extension' }),
    execution({ executionId: 'e-3', executionKind: 'human' }),
  ];
  const telemetry = [usageTelemetry({ usageId: 'u-1', costAmount: 0.0125 })];
  const jobsList: ResolvedJobRef[] = [{ job: job(), acceptedOfferId: 'offer-1' }];

  for (let round = 0; round < 2; round += 1) {
    const revenue = deriveRevenueRollup(observations);
    const costs = deriveDeliveryCostBreakdown({
      executions: executionsList,
      usageTelemetry: telemetry,
      resolvedJobs: jobsList,
      connections: [connection()],
      ingestedEvents: [ingestedEvent()],
    });
    const capacity = deriveHumanCapacitySurface([humanAgentProfile()], []);
    const margin = deriveMarginSurface({
      revenue,
      costs,
      goals: [goal()],
      weeklyCapacityCost: capacity.weeklyCapacityCost,
    });
    const serialized = JSON.stringify({ revenue, costs, capacity, margin });
    if (round === 0) {
      (globalThis as { __piPinnedFirst?: string }).__piPinnedFirst = serialized;
    } else {
      assert.equal(
        serialized,
        (globalThis as { __piPinnedFirst?: string }).__piPinnedFirst,
        'same inputs + same calculation version ⇒ byte-identical figures',
      );
    }
  }
  // And the aggregated surfaces pin identically too.
  const breakdownOne = deriveDeliveryCostBreakdown({
    executions: executionsList,
    usageTelemetry: telemetry,
    resolvedJobs: jobsList,
    connections: [],
    ingestedEvents: [],
  });
  assert.deepEqual(
    aggregateDeliveryCostBreakdowns([breakdownOne]),
    breakdownOne,
    'a single-element aggregation is the identity (stable merge)',
  );
});
