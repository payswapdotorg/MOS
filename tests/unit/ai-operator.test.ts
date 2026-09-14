/**
 * MKT-045 unit tests — the PURE /ai-operator derivations (no DB; the
 * MKT-043 profit-intelligence unit-test precedent). Proves:
 *
 *   - THE FROZEN VOCABULARY (AC-3/AC-6): the rank calculation version,
 *     the eight-category §7 vocabulary + its version, the closed
 *     source/action/factor vocabularies and the full assumption record
 *     are exported constants — and the ranking disclosure ships them
 *     verbatim in every view;
 *   - BLOCKED WORK (AC-2a): instance blocked/paused, held executions
 *     (pausing/paused), terminally blocked/disabled deployments and
 *     expired/declined jobs derive items; forward-progress states derive
 *     NONE; the recurrence modifier counts FAILED executions linked to
 *     the same workflow instance (capped);
 *   - APPROVALS (AC-2b): only UNDECIDED ('unknown') policy decisions
 *     derive items; severity follows the reason code (no-active-policy /
 *     no-matching-rule / default); the recurrence modifier counts OTHER
 *     undecided decisions on the SAME dimension (capped); the client
 *     narrowing excludes other clients' decisions;
 *   - CLIENT RISK (AC-2c): only CURRENT (unsuperseded) weak-grade
 *     evidence records count (D/E/F); below the threshold no item
 *     exists; the severity is the capped weak count and the grade
 *     distribution ships in the rationale;
 *   - ANOMALIES (AC-2d): failed / unknown / reconciling executions
 *     derive items with the frozen severities (UNKNOWN worst); an UNSAFE
 *     retry classification escalates (+2, capped); the recurrence
 *     modifier is the attempt number minus one (capped);
 *   - SCOPE LEAKAGE (AC-2e): CONSUMED from the /profit-intelligence
 *     view verbatim (its calculation version + canonical source refs
 *     travel with the item; the figures are never recomputed here);
 *     zero-count indicators and a null PI view derive NO items;
 *   - MARGIN PRESSURE (AC-2f): CONSUMED from the /profit-intelligence
 *     realized figures — negative margin is ALWAYS pressure (severity
 *     10); a below-threshold ratio is pressure with the deterministic
 *     depth-below-threshold severity; a non-derivable margin is an
 *     honest absence (NO item), and the PI calculation version ships in
 *     the rationale;
 *   - CAPACITY CONSTRAINT (AC-2g): only authorization-ACTIVE profiles
 *     count; projected demand (open + in-flight jobs × the frozen
 *     per-job minutes) over declared weekly minutes; no item without
 *     demand; zero declared capacity with demand is the total
 *     constraint (severity 10);
 *   - OPPORTUNITIES (AC-2h): ready / analyzing / concluded-with-
 *     causal-supported experiments and CONTRADICTED learnings derive
 *     items with the frozen severities and action contracts;
 *   - THE RANKING CORE (AC-6): the score is exactly base + severity +
 *     recurrence (each capped into its frozen range); the total order is
 *     score DESC → category ASC → itemId ASC with contiguous 1-based
 *     ranks; the same inputs derive BYTE-IDENTICAL queues on every call
 *     and under INPUT-ORDER PERMUTATION (pure determinism — no clock,
 *     no randomness);
 *   - THE AGENCY AGGREGATE + TALLY: deriveAgencyAttentionItems is the
 *     exact union of the client-scoped derivations + the agency
 *     approvals + the one agency capacity item; tallyCategoryCounts
 *     carries EVERY category key (zero for absent);
 *   - ASSUMPTION PROPAGATION (AC-3): every item's scoreAssumptionKeys
 *     name REAL entries of the exported assumption set, and ranking
 *     carries every raw field verbatim (no invented data).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_OPERATOR_ASSUMPTIONS,
  AI_OPERATOR_RANK_VERSION,
  ATTENTION_ACTION_CONTRACT_KINDS,
  ATTENTION_CATEGORIES,
  ATTENTION_CATEGORY_VOCABULARY_VERSION,
  ATTENTION_RATIONALE_FACTOR_KEYS,
  ATTENTION_SOURCE_REF_KINDS,
  attentionItemKey,
  composeRankingDisclosure,
  deriveAgencyAttentionItems,
  deriveApprovalItems,
  deriveAnomalyItems,
  deriveBlockedWorkItems,
  deriveCapacityConstraintItem,
  deriveClientRiskItems,
  deriveMarginPressureItems,
  deriveOpportunityItems,
  deriveScopeLeakageItems,
  rankAttentionItems,
  tallyCategoryCounts,
} from '../../src/modules/ai-operator/public.ts';
import type {
  AgencyScopeSnapshot,
  CapacityJobRows,
  ClientScopeRows,
} from '../../src/modules/ai-operator/public.ts';
import {
  PROFIT_INTELLIGENCE_ASSUMPTIONS,
  PROFIT_INTELLIGENCE_CALCULATION_VERSION,
} from '../../src/modules/profit-intelligence/public.ts';
import type {
  ClientProfitIntelligenceView,
  MarginSurface,
  ProfitFigure,
  ProfitSourceRef,
  ScopeLeakageSurface,
} from '../../src/modules/profit-intelligence/public.ts';
import type { DeploymentRecord } from '../../src/modules/deployments/public.ts';
import type { EvidenceRecord } from '../../src/modules/evidence/public.ts';
import type { ExecutionRecord, ExecutionTaskLink } from '../../src/modules/executions/public.ts';
import type { ExperimentRecord } from '../../src/modules/experiments/public.ts';
import type { HumanAgentRecord } from '../../src/modules/field-agents/public.ts';
import type { JobRecord } from '../../src/modules/jobs/public.ts';
import type { LearningRecord } from '../../src/modules/learnings/public.ts';
import type { PolicyDecisionRecord } from '../../src/modules/policies/public.ts';
import type { WorkflowInstanceRecord } from '../../src/modules/workflows/public.ts';

// ---------------------------------------------------------------------------
// Fixture identifiers
// ---------------------------------------------------------------------------

const AGENCY = '11111111-1111-4111-8111-111111111111';
const CLIENT = 'aaaaaaaa-0000-4000-8000-000000000001';
const WORKSPACE = 'bbbbbbbb-0000-4000-8000-000000000001';
const INSTANCE = 'efefefef-0000-4000-8000-000000000001';
const WORKFLOW = 'abababab-0000-4000-8000-000000000001';
const DEFINITION = 'cdcdcdcd-0000-4000-8000-000000000001';
const DEPLOYMENT = 'ffffffff-0000-4000-8000-000000000001';
const PLAYBOOK_VERSION = 'eeeeeeee-0000-4000-8000-000000000001';
const EVIDENCE = 'a1a1a1a1-0000-4000-8000-000000000001';
const EVIDENCE2 = 'a1a1a1a1-0000-4000-8000-000000000002';
const EVIDENCE3 = 'a1a1a1a1-0000-4000-8000-000000000003';
const EXPERIMENT = 'c3c3c3c3-0000-4000-8000-000000000001';
const LEARNING = 'b7b7b7b7-0000-4000-8000-000000000001';
const HUMAN_USER = '99999999-0000-4000-8000-000000000001';
const HUMAN_AGENT_PROFILE = '88888888-0000-4000-8000-000000000001';
const DECISION = 'd5d5d5d5-0000-4000-8000-000000000001';
const DECISION2 = 'd5d5d5d5-0000-4000-8000-000000000002';
const DECISION3 = 'd5d5d5d5-0000-4000-8000-000000000003';
const DECISION4 = 'd5d5d5d5-0000-4000-8000-000000000004';
const JOB = 'j1j1j1j1-0000-4000-8000-000000000001';
const JOB2 = 'j1j1j1j1-0000-4000-8000-000000000002';
const EXEC = 'e0e0e0e0-0000-4000-8000-000000000001';
const EXEC2 = 'e0e0e0e0-0000-4000-8000-000000000002';
const EXEC3 = 'e0e0e0e0-0000-4000-8000-000000000003';

// ---------------------------------------------------------------------------
// Fixture constructors (plain record snapshots — the module gathers these
// through the composed authorities' public contracts; unit tests feed them
// directly to the PURE derivations)
// ---------------------------------------------------------------------------

function workflowNodeLink(instanceId: string): ExecutionTaskLink {
  return { kind: 'workflow-node', workflowInstanceId: instanceId, nodeId: 'a' };
}

function execution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    executionId: EXEC,
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

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    jobId: JOB,
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

function evidence(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    evidenceId: EVIDENCE,
    clientId: CLIENT,
    workspaceId: null,
    class: 'observation',
    source: { system: 'meta-ads', ref: 'report/2026-09' },
    observedAt: '2026-09-15T10:30:00.000Z',
    content: { metric: 'revenue', value: 5000, unit: 'USD' },
    contentRef: null,
    quality: 'B',
    confidence: null,
    supersedes: null,
    supersededBy: null,
    provenance: {
      actor: `user:${HUMAN_USER}`,
      recordedVia: 'api',
      correlationId: 'correlation-1',
      causationId: null,
      recordedAt: '2026-09-15T11:00:00.000Z',
    },
    ...overrides,
  };
}

function experiment(overrides: Partial<ExperimentRecord> = {}): ExperimentRecord {
  return {
    experimentId: EXPERIMENT,
    clientId: CLIENT,
    workspaceId: WORKSPACE,
    hypothesis: 'Personalized subject lines lift activation.',
    decisionTarget: 'Whether to roll out personalization.',
    populationUnit: 'account',
    treatment: 'personalized-subject',
    comparison: 'static-subject',
    assignmentMethod: 'random',
    designType: 'randomized',
    primaryMetric: { name: 'activation_rate', dimensions: {} },
    guardrails: [],
    analysisMethod: 'difference-in-means',
    analysisMethodVersion: 'v1',
    expectedDirection: 'increase',
    startCriteria: null,
    stopCriteria: 'At 400 accounts or 14 days.',
    minimumEvidenceRequirement: 'B — strong quasi-experimental at minimum',
    uncertaintyRepresentation: 'none',
    status: 'running',
    resultState: 'undecided',
    resultingDecision: null,
    concludedAt: null,
    provenance: {
      actor: `user:${HUMAN_USER}`,
      recordedVia: 'api',
      correlationId: 'correlation-2',
      causationId: null,
      recordedAt: '2026-09-15T11:00:00.000Z',
    },
    ...overrides,
  };
}

function learning(overrides: Partial<LearningRecord> = {}): LearningRecord {
  return {
    learningId: LEARNING,
    clientId: CLIENT,
    workspaceId: WORKSPACE,
    statement: 'Tuesday sends outperform Friday sends.',
    applicability: { channel: 'email' },
    evidenceRefs: [EVIDENCE],
    experimentRefs: [],
    confidence: 0.8,
    status: 'active',
    supersededBy: null,
    provenance: {
      actor: `user:${HUMAN_USER}`,
      recordedVia: 'api',
      correlationId: 'correlation-3',
      causationId: null,
      recordedAt: '2026-09-15T11:00:00.000Z',
    },
    ...overrides,
  };
}

function policyDecision(overrides: Partial<PolicyDecisionRecord> = {}): PolicyDecisionRecord {
  return {
    decisionId: DECISION,
    dimension: 'ai',
    agencyId: AGENCY,
    clientId: null,
    outcome: 'unknown',
    reasonCode: 'no-active-policy',
    reasons: ['No active policy version for dimension ai.'],
    action: { dimension: 'ai', operation: 'generate.copy', resource: null, attributes: {} },
    matchedPolicyVersions: [],
    provenance: {
      actor: `user:${HUMAN_USER}`,
      recordedVia: 'api',
      correlationId: 'correlation-4',
      causationId: null,
      evaluatedAt: '2026-09-15T11:00:00.000Z',
      recordedAt: '2026-09-15T11:00:00.000Z',
    },
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

// --- The /profit-intelligence CLIENT view fixture (CONSUMED, never recomputed) ---

function profitFigure(overrides: Partial<ProfitFigure> = {}): ProfitFigure {
  return {
    value: 0,
    currency: 'USD',
    provenance: 'observed',
    calculationVersion: PROFIT_INTELLIGENCE_CALCULATION_VERSION,
    sourceRefs: [],
    assumptionKeys: [],
    notDerivableReason: null,
    ...overrides,
  };
}

function piMargin(overrides: Partial<MarginSurface> = {}): MarginSurface {
  return {
    realizedRevenue: profitFigure({ value: 10_000 }),
    realizedDeliveryCost: profitFigure({ value: 2_000 }),
    realizedMargin: profitFigure({ value: 8_000 }),
    estimatedRevenue: profitFigure({ value: 10_000, provenance: 'estimated' }),
    estimatedDeliveryCost: profitFigure({ value: 2_000, provenance: 'estimated' }),
    estimatedMargin: profitFigure({ value: 8_000, provenance: 'estimated' }),
    currencyPolicyNote: 'Foreign-currency revenue is excluded (never converted).',
    ...overrides,
  };
}

function piLeakage(indicators: ScopeLeakageSurface['indicators']): ScopeLeakageSurface {
  return { indicators };
}

function piClientView(
  margin: MarginSurface,
  leakage: ScopeLeakageSurface,
): ClientProfitIntelligenceView {
  return {
    scope: { kind: 'client-profit-intelligence', agencyId: AGENCY, clientId: CLIENT, workspaceCount: 1 },
    revenue: {
      byCurrency: [],
      observationCount: 0,
      restatedIdentityCount: 0,
      supersededObservationCount: 0,
      qualityCounts: {},
      evidenceRefs: [],
    },
    costs: {
      humanDeliveryCost: profitFigure(),
      deliveredJobCount: 0,
      inFlightJobCount: 0,
      automationDeliveryCost: profitFigure(),
      totalDeliveryCost: profitFigure(),
      executionCounts: { deterministic: 0, ai: 0, human: 0, extension: 0 },
      executionStatusCounts: {},
      aiProvider: {
        telemetryCost: profitFigure(),
        telemetryRowCount: 0,
        adapterActivity: [],
        adapterActivityNote: 'none',
      },
      humanExecutionCostAttribution: 'utilization-indicator-only',
    },
    capacity: {
      activeProfileCount: 1,
      skippedProfileCount: 0,
      weeklyCapacityMinutes: 600,
      weeklyCapacityCost: profitFigure({ provenance: 'estimated' }),
      profileRefs: [],
    },
    utilization: {
      deliveredWorkMinutes: profitFigure(),
      capacityMinutes: profitFigure({ value: 600 }),
      utilization: profitFigure(),
      humanExecutionCount: 0,
      numeratorNote: 'none',
    },
    scopeLeakage: leakage,
    margin,
    serviceContributions: [],
    unattributedServiceDeliveryCost: profitFigure(),
    projectContributions: [],
    unattributedProjectDeliveryCost: profitFigure(),
    calculation: {
      calculationVersion: PROFIT_INTELLIGENCE_CALCULATION_VERSION,
      assumptions: PROFIT_INTELLIGENCE_ASSUMPTIONS,
      basis: 'live-derivation-over-canonical-authorities',
      persistence: 'none-derived-read-model',
    },
    generatedAt: '2026-09-15T11:00:00.000Z',
  };
}

// --- The client-scope row fixtures ---

function clientRows(overrides: Partial<ClientScopeRows> = {}): ClientScopeRows {
  return {
    agencyId: AGENCY,
    clientId: CLIENT,
    clientStatus: 'live',
    workspaces: [
      {
        workspaceId: WORKSPACE,
        instances: [instance()],
        deployments: [deployment()],
        executions: [execution()],
      },
    ],
    jobs: [job()],
    evidence: [evidence()],
    experiments: [experiment()],
    learnings: [learning()],
    profit: null,
    ...overrides,
  };
}

function emptyClientRows(overrides: Partial<ClientScopeRows> = {}): ClientScopeRows {
  return {
    agencyId: AGENCY,
    clientId: CLIENT,
    clientStatus: 'live',
    workspaces: [],
    jobs: [],
    evidence: [],
    experiments: [],
    learnings: [],
    profit: null,
    ...overrides,
  };
}

function factorValue(item: { readonly rationale: { readonly factors: ReadonlyArray<{ readonly key: string; readonly value: string }> } }, key: string): string {
  const factor = item.rationale.factors.find((entry) => entry.key === key);
  assert.ok(factor !== undefined, `factor '${key}' must exist`);
  return factor.value;
}

function sourceKinds(item: { readonly sourceRefs: ReadonlyArray<{ readonly kind: string }> }): string[] {
  return item.sourceRefs.map((ref) => ref.kind);
}

// ---------------------------------------------------------------------------
// 1. THE FROZEN VOCABULARY (AC-3/AC-6)
// ---------------------------------------------------------------------------

test('the frozen vocabulary: rank version, category vocabulary (+version), closed sets and the full assumption record', () => {
  assert.equal(AI_OPERATOR_RANK_VERSION, 'ao-rank-v1');
  assert.equal(ATTENTION_CATEGORY_VOCABULARY_VERSION, 'ao-categories-v1');
  // The frozen §7 category set, verbatim order.
  assert.deepEqual(ATTENTION_CATEGORIES, [
    'blocked-work',
    'approval',
    'client-risk',
    'anomaly',
    'scope-leakage',
    'margin-pressure',
    'capacity-constraint',
    'opportunity',
  ]);

  // The full assumption record (every value frozen — never silently re-stated).
  assert.deepEqual(AI_OPERATOR_ASSUMPTIONS, {
    categoryBaseWeights: {
      approval: 90,
      anomaly: 85,
      'blocked-work': 80,
      'client-risk': 75,
      'margin-pressure': 70,
      'capacity-constraint': 60,
      'scope-leakage': 55,
      opportunity: 40,
    },
    severityModifierRange: [0, 10],
    recurrenceModifierRange: [0, 5],
    clientRiskWeakEvidenceGrades: ['D', 'E', 'F'],
    clientRiskWeakEvidenceThreshold: 1,
    marginPressureThresholdRatio: 0.15,
    marginPressureNegativeIsAlwaysPressure: true,
    capacityConstraintTriggerRatio: 1.0,
    capacityDemandMinutesPerJob: 120,
    capacityWindowRecurrence: 'weekly',
    approvalDimensionRecurrenceCap: 5,
    anomalyAttemptRecurrenceCap: 5,
    scopeLeakageSeverityCap: 10,
    clientRiskSeverityCap: 10,
  });

  // The closed vocabularies are exported constants.
  assert.ok(ATTENTION_SOURCE_REF_KINDS.includes('policy-decision'));
  assert.ok(ATTENTION_SOURCE_REF_KINDS.includes('metric-observation'));
  assert.ok(ATTENTION_ACTION_CONTRACT_KINDS.includes('policy-evaluation'));
  assert.ok(ATTENTION_ACTION_CONTRACT_KINDS.includes('decision-recording'));
  assert.ok(ATTENTION_RATIONALE_FACTOR_KEYS.includes('source-calculation-version'));

  // The deterministic item identity.
  assert.equal(attentionItemKey('anomaly', 'execution', EXEC), `ao:anomaly:execution:${EXEC}`);
  assert.equal(
    attentionItemKey('scope-leakage', 'client', CLIENT, 'work-without-active-goal'),
    `ao:scope-leakage:client:${CLIENT}:work-without-active-goal`,
  );
});

test('the ranking disclosure ships the frozen vocabulary verbatim in every view', () => {
  const disclosure = composeRankingDisclosure();
  assert.equal(disclosure.rankVersion, AI_OPERATOR_RANK_VERSION);
  assert.equal(disclosure.categoryVocabularyVersion, ATTENTION_CATEGORY_VOCABULARY_VERSION);
  assert.deepEqual(disclosure.assumptions, AI_OPERATOR_ASSUMPTIONS);
  assert.equal(disclosure.basis, 'live-derivation-over-canonical-authorities');
  assert.equal(disclosure.persistence, 'none-derived-read-model');
  assert.equal(
    disclosure.consumedProfitIntelligenceVersion,
    PROFIT_INTELLIGENCE_CALCULATION_VERSION,
    'the CONSUMED /profit-intelligence version is disclosed verbatim (never recomputed here)',
  );
  assert.ok(disclosure.sortRule.includes('priorityScore DESC'));
  assert.ok(disclosure.sortRule.includes('total deterministic order'));
});

// ---------------------------------------------------------------------------
// 2. BLOCKED WORK (AC-2a)
// ---------------------------------------------------------------------------

test('blocked work: stuck instances, held executions, terminally blocked deployments and expired/declined jobs derive items — forward progress derives none', () => {
  const rows = clientRows({
    workspaces: [
      {
        workspaceId: WORKSPACE,
        instances: [
          instance({ status: 'blocked', workflowInstanceId: INSTANCE }),
          instance({ status: 'paused', workflowInstanceId: 'efefefef-0000-4000-8000-000000000002' }),
          instance({ status: 'running', workflowInstanceId: 'efefefef-0000-4000-8000-000000000003' }),
          instance({ status: 'succeeded', workflowInstanceId: 'efefefef-0000-4000-8000-000000000004' }),
        ],
        deployments: [
          deployment({ status: 'blocked', deploymentId: DEPLOYMENT }),
          deployment({ status: 'disabled', deploymentId: 'ffffffff-0000-4000-8000-000000000002' }),
          deployment({ status: 'active', deploymentId: 'ffffffff-0000-4000-8000-000000000003' }),
        ],
        executions: [
          execution({ status: 'paused', executionId: EXEC }),
          execution({ status: 'pausing', executionId: EXEC2 }),
          execution({ status: 'running', executionId: EXEC3 }),
        ],
      },
    ],
    jobs: [
      job({ status: 'expired', jobId: JOB }),
      job({ status: 'declined', jobId: JOB2 }),
      job({ status: 'projected', jobId: 'j1j1j1j1-0000-4000-8000-000000000003' }),
      job({ status: 'offered', jobId: 'j1j1j1j1-0000-4000-8000-000000000004' }),
    ],
  });

  const items = deriveBlockedWorkItems(rows);
  const ids = items.map((item) => item.itemId);
  assert.equal(items.length, 8, 'exactly the stuck/held/blocked/expired records');
  assert.ok(ids.includes(`ao:blocked-work:workflow-instance:${INSTANCE}`));
  assert.ok(ids.includes('ao:blocked-work:workflow-instance:efefefef-0000-4000-8000-000000000002'));
  assert.ok(ids.includes(`ao:blocked-work:deployment:${DEPLOYMENT}`));
  assert.ok(ids.includes('ao:blocked-work:deployment:ffffffff-0000-4000-8000-000000000002'));
  assert.ok(ids.includes(`ao:blocked-work:execution:${EXEC}`));
  assert.ok(ids.includes(`ao:blocked-work:execution:${EXEC2}`));
  assert.ok(ids.includes(`ao:blocked-work:job:${JOB}`));
  assert.ok(ids.includes(`ao:blocked-work:job:${JOB2}`));

  // The frozen severities per posture.
  const byId = new Map(items.map((item) => [item.itemId, item] as const));
  assert.equal(byId.get(`ao:blocked-work:workflow-instance:${INSTANCE}`)!.severity, 8);
  assert.equal(byId.get('ao:blocked-work:workflow-instance:efefefef-0000-4000-8000-000000000002')!.severity, 4);
  assert.equal(byId.get(`ao:blocked-work:deployment:${DEPLOYMENT}`)!.severity, 10);
  assert.equal(byId.get('ao:blocked-work:deployment:ffffffff-0000-4000-8000-000000000002')!.severity, 6);
  assert.equal(byId.get(`ao:blocked-work:execution:${EXEC}`)!.severity, 4);
  assert.equal(byId.get(`ao:blocked-work:execution:${EXEC2}`)!.severity, 5);
  assert.equal(byId.get(`ao:blocked-work:job:${JOB}`)!.severity, 6);
  assert.equal(byId.get(`ao:blocked-work:job:${JOB2}`)!.severity, 5);
  for (const item of items) {
    assert.equal(item.category, 'blocked-work');
    assert.equal(item.recurrence, 0, 'only instance items carry failure recurrence');
    assert.deepEqual(item.scoreAssumptionKeys, [
      'categoryBaseWeights',
      'severityModifierRange',
      'recurrenceModifierRange',
    ]);
  }

  // The action contracts (the EXISTING authority surfaces).
  assert.equal(byId.get(`ao:blocked-work:workflow-instance:${INSTANCE}`)!.actionContract.kind, 'workflow-instance-transition');
  assert.equal(byId.get(`ao:blocked-work:execution:${EXEC}`)!.actionContract.kind, 'execution-reconciliation');
  assert.equal(byId.get(`ao:blocked-work:deployment:${DEPLOYMENT}`)!.actionContract.kind, 'deployment-lifecycle');
  assert.equal(byId.get(`ao:blocked-work:job:${JOB}`)!.actionContract.kind, 'job-outcome-submission');
  assert.equal(
    byId.get(`ao:blocked-work:workflow-instance:${INSTANCE}`)!.actionContract.policyDimension,
    null,
    'the instance transition is governed by its own transition authority',
  );
});

test('blocked work recurrence: FAILED executions linked to the same workflow instance escalate, capped at 5', () => {
  const blockedInstance = instance({ status: 'blocked', workflowInstanceId: INSTANCE });
  const rows = clientRows({
    workspaces: [
      {
        workspaceId: WORKSPACE,
        instances: [blockedInstance],
        deployments: [],
        executions: [
          // 7 failures linked to INSTANCE — the recurrence caps at 5.
          ...Array.from({ length: 7 }, (_, index) =>
            execution({
              executionId: `e0e0e0e0-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
              status: 'failed',
              taskLink: workflowNodeLink(INSTANCE),
            }),
          ),
          // A failure linked to ANOTHER instance never counts here.
          execution({
            executionId: 'e1e1e1e1-0000-4000-8000-000000000009',
            status: 'failed',
            taskLink: workflowNodeLink('efefefef-0000-4000-8000-000000000009'),
          }),
          // A succeeded execution linked to INSTANCE never counts.
          execution({
            executionId: 'e1e1e1e1-0000-4000-8000-000000000010',
            status: 'succeeded',
            taskLink: workflowNodeLink(INSTANCE),
          }),
        ],
      },
    ],
    jobs: [],
  });

  const items = deriveBlockedWorkItems(rows);
  const blocked = items.find((item) => item.itemId === `ao:blocked-work:workflow-instance:${INSTANCE}`)!;
  assert.equal(blocked.recurrence, 5, 'the recurrence modifier caps at recurrenceModifierRange[1]');
  assert.equal(factorValue(blocked, 'linked-failed-executions'), '7', 'the observed count ships verbatim in the rationale');
  // The failed executions themselves are ANOMALY inputs, not blocked-work
  // items (the derivation is per-category).
  assert.equal(items.length, 1);
});

// ---------------------------------------------------------------------------
// 3. APPROVALS (AC-2b)
// ---------------------------------------------------------------------------

test('approvals: only UNDECIDED decisions derive items; severity follows the reason code; recurrence counts same-dimension peers (capped)', () => {
  const decisions = [
    policyDecision({ decisionId: DECISION, outcome: 'unknown', reasonCode: 'no-active-policy' }),
    // A second undecided decision on the SAME dimension.
    policyDecision({
      decisionId: DECISION2,
      outcome: 'unknown',
      reasonCode: 'no-matching-rule',
      dimension: 'ai',
    }),
    // A third + fourth + fifth + sixth + seventh same-dimension peer: the
    // recurrence caps at 5.
    policyDecision({ decisionId: DECISION3, outcome: 'unknown', reasonCode: 'no-matching-rule', dimension: 'ai' }),
    policyDecision({ decisionId: DECISION4, outcome: 'unknown', reasonCode: 'no-matching-rule', dimension: 'ai' }),
    // A DIFFERENT dimension: recurrence 0, and never mixed in.
    policyDecision({
      decisionId: 'd5d5d5d5-0000-4000-8000-000000000005',
      outcome: 'unknown',
      reasonCode: 'no-matching-rule',
      dimension: 'field',
    }),
    // DECIDED outcomes never derive items.
    policyDecision({
      decisionId: 'd5d5d5d5-0000-4000-8000-000000000006',
      outcome: 'allow',
      reasonCode: 'rule-allowed',
      dimension: 'ai',
    }),
    policyDecision({
      decisionId: 'd5d5d5d5-0000-4000-8000-000000000007',
      outcome: 'deny',
      reasonCode: 'rule-denied',
      dimension: 'ai',
    }),
  ];

  const items = deriveApprovalItems(decisions, null);
  assert.equal(items.length, 5, 'exactly the undecided decisions');
  const byId = new Map(items.map((item) => [item.itemId, item] as const));

  // Severity by reason code.
  assert.equal(byId.get(`ao:approval:policy-decision:${DECISION}`)!.severity, 10, 'no-active-policy');
  assert.equal(byId.get(`ao:approval:policy-decision:${DECISION2}`)!.severity, 8, 'no-matching-rule');
  assert.equal(
    byId.get('ao:approval:policy-decision:d5d5d5d5-0000-4000-8000-000000000005')!.severity,
    8,
    'no-matching-rule (field)',
  );

  // Recurrence: same-dimension peers − 1, capped at 5.
  // 'ai' has 4 undecided → recurrence 3 for each ai item.
  assert.equal(byId.get(`ao:approval:policy-decision:${DECISION2}`)!.recurrence, 3);
  assert.equal(factorValue(byId.get(`ao:approval:policy-decision:${DECISION2}`)!, 'same-dimension-undecided-count'), '4');
  assert.equal(byId.get('ao:approval:policy-decision:d5d5d5d5-0000-4000-8000-000000000005')!.recurrence, 0);

  // The action contract references the policy evaluation surface with the
  // gate's dimension + scope kind.
  const contract = byId.get(`ao:approval:policy-decision:${DECISION}`)!.actionContract;
  assert.equal(contract.kind, 'policy-evaluation');
  assert.equal(contract.policyDimension, 'ai');
  assert.equal(contract.policyScopeKind, 'agency');
  assert.equal(contract.targetRef.kind, 'policy-decision');
  assert.equal(contract.targetRef.id, DECISION);

  // Agency-scoped (clientId null) decisions carry no client source ref.
  assert.deepEqual(
    byId.get(`ao:approval:policy-decision:${DECISION}`)!.sourceRefs.map((ref) => ref.kind),
    ['policy-decision'],
  );
});

test(`approvals: the client narrowing keeps ONLY this client's undecided decisions (the client slice)`, () => {
  const clientDecision = policyDecision({
    decisionId: DECISION,
    clientId: CLIENT,
    outcome: 'unknown',
    reasonCode: 'no-matching-rule',
  });
  const otherClientDecision = policyDecision({
    decisionId: DECISION2,
    clientId: 'aaaaaaaa-0000-4000-8000-000000000099',
    outcome: 'unknown',
    reasonCode: 'no-matching-rule',
  });
  const agencyScoped = policyDecision({
    decisionId: DECISION3,
    clientId: null,
    outcome: 'unknown',
    reasonCode: 'no-matching-rule',
  });

  const narrowed = deriveApprovalItems([clientDecision, otherClientDecision, agencyScoped], CLIENT);
  assert.equal(narrowed.length, 1, 'agency-scoped decisions stay in the agency queue only');
  assert.equal(narrowed[0]!.itemId, `ao:approval:policy-decision:${DECISION}`);
  assert.equal(narrowed[0]!.actionContract.policyScopeKind, 'client');
  assert.deepEqual(
    narrowed[0]!.sourceRefs.map((ref) => ref.kind),
    ['policy-decision', 'client'],
    'the client source ref ships on client-scoped approvals',
  );
});

// ---------------------------------------------------------------------------
// 4. CLIENT RISK (AC-2c)
// ---------------------------------------------------------------------------

test('client risk: CURRENT weak-grade evidence (D/E/F) derives the item; superseded records never count; below the threshold no item exists', () => {
  // 12 weak records: severity caps at 10.
  const manyWeak = Array.from({ length: 12 }, (_, index) =>
    evidence({ evidenceId: `a1a1a1a1-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, quality: 'D' }),
  );
  const supersededWeak = evidence({ evidenceId: EVIDENCE2, quality: 'E', supersededBy: EVIDENCE3 });
  const strong = evidence({ evidenceId: EVIDENCE3, quality: 'A' });
  const items = deriveClientRiskItems(clientRows({ evidence: [...manyWeak, supersededWeak, strong] }));
  assert.equal(items.length, 1);
  const item = items[0]!;
  assert.equal(item.itemId, `ao:client-risk:client:${CLIENT}`);
  assert.equal(item.severity, 10, 'the weak-evidence count caps at clientRiskSeverityCap');
  assert.equal(factorValue(item, 'weak-evidence-count'), '12', 'the superseded record never entered');
  assert.equal(factorValue(item, 'weak-evidence-grades'), 'D/E/F');
  assert.equal(factorValue(item, 'evidence-grade-counts'), 'A:1,D:12', 'the full CURRENT grade distribution ships (the superseded record never entered)');
  assert.equal(item.actionContract.kind, 'evidence-append');
  assert.equal(factorValue(item, 'client-status'), 'live');
  // 13 weak evidence refs + the client ref.
  assert.equal(item.sourceRefs.length, 13);

  // ZERO weak records: no item (the honest absence).
  assert.deepEqual(
    deriveClientRiskItems(clientRows({ evidence: [strong] })),
    [],
    'a strong evidence base is not client risk',
  );
  // Below the threshold: no item.
  assert.deepEqual(
    deriveClientRiskItems(clientRows({ evidence: [supersededWeak] })),
    [],
    'a superseded weak record is not client risk',
  );
});

// ---------------------------------------------------------------------------
// 5. ANOMALIES (AC-2d)
// ---------------------------------------------------------------------------

test('anomalies: failed/unknown/reconciling executions derive items with frozen severities; unsafe retries escalate; recurrence is the attempt history', () => {
  const rows = clientRows({
    workspaces: [
      {
        workspaceId: WORKSPACE,
        instances: [],
        deployments: [],
        executions: [
          execution({ executionId: EXEC, status: 'failed', attemptNumber: 1, retryClassification: null }),
          execution({ executionId: EXEC2, status: 'failed', attemptNumber: 4, retryClassification: 'unsafe' }),
          execution({
            executionId: EXEC3,
            status: 'failed',
            attemptNumber: 9,
            retryClassification: 'unsafe',
          }),
          execution({
            executionId: 'e0e0e0e0-0000-4000-8000-000000000004',
            status: 'unknown',
            attemptNumber: 1,
          }),
          execution({
            executionId: 'e0e0e0e0-0000-4000-8000-000000000005',
            status: 'reconciling',
            attemptNumber: 2,
            retryClassification: 'safe',
          }),
          // Forward progress: never an anomaly.
          execution({ executionId: 'e0e0e0e0-0000-4000-8000-000000000006', status: 'succeeded' }),
          execution({ executionId: 'e0e0e0e0-0000-4000-8000-000000000007', status: 'running' }),
        ],
      },
    ],
    jobs: [],
  });

  const items = deriveAnomalyItems(rows);
  assert.equal(items.length, 5);
  const byId = new Map(items.map((item) => [item.itemId, item] as const));

  assert.equal(byId.get(`ao:anomaly:execution:${EXEC}`)!.severity, 6, 'failed baseline');
  assert.equal(byId.get(`ao:anomaly:execution:${EXEC}`)!.recurrence, 0, 'attempt 1 → no recurrence');
  assert.equal(factorValue(byId.get(`ao:anomaly:execution:${EXEC}`)!, 'retry-classification'), 'unset');

  // failed + unsafe: 6 + 2 = 8.
  assert.equal(byId.get(`ao:anomaly:execution:${EXEC2}`)!.severity, 8);
  assert.equal(byId.get(`ao:anomaly:execution:${EXEC2}`)!.recurrence, 3, 'attempt 4 → 3 prior attempts');

  // attempt 9 → recurrence capped at 5; severity capped at 10.
  assert.equal(byId.get(`ao:anomaly:execution:${EXEC3}`)!.recurrence, 5);
  assert.equal(byId.get(`ao:anomaly:execution:${EXEC3}`)!.severity, 8, 'severity stays the capped failed+unsafe value (8 < 10)');

  assert.equal(byId.get('ao:anomaly:execution:e0e0e0e0-0000-4000-8000-000000000004')!.severity, 10, 'UNKNOWN is the worst posture');
  assert.equal(byId.get('ao:anomaly:execution:e0e0e0e0-0000-4000-8000-000000000005')!.severity, 8, 'reconciling');

  for (const item of items) {
    assert.equal(item.category, 'anomaly');
    assert.equal(item.actionContract.kind, 'execution-reconciliation');
    assert.equal(item.actionContract.policyDimension, null);
    assert.ok(factorValue(item, 'execution-kind').length > 0);
    assert.ok(item.rationale.headline.startsWith(`execution ${item.itemId.split(':')[3]}`));
  }
});

// ---------------------------------------------------------------------------
// 6. SCOPE LEAKAGE — CONSUMED from /profit-intelligence (AC-2e)
// ---------------------------------------------------------------------------

test('scope leakage: the PI indicators are CONSUMED verbatim (version + source refs travel with the item) — never recomputed here', () => {
  const piRefs: ProfitSourceRef[] = [
    { kind: 'execution', id: EXEC },
    { kind: 'workflow-instance', id: INSTANCE },
  ];
  const view = piClientView(
    piMargin(),
    piLeakage([
      { kind: 'executions-outside-deployed-envelope', rule: 'rule-a', count: 3, sourceRefs: piRefs },
      { kind: 'work-without-active-goal', rule: 'rule-b', count: 14, sourceRefs: [] },
      { kind: 'active-goals-without-delivery', rule: 'rule-c', count: 0, sourceRefs: [] },
    ]),
  );
  const items = deriveScopeLeakageItems(clientRows({ profit: view }));
  assert.equal(items.length, 2, 'zero-count indicators derive NO items');

  const envelope = items.find(
    (item) => item.itemId === `ao:scope-leakage:client:${CLIENT}:executions-outside-deployed-envelope`,
  )!;
  assert.equal(envelope.severity, 3, 'the leaked-unit count is the severity');
  assert.equal(factorValue(envelope, 'leakage-kind'), 'executions-outside-deployed-envelope');
  assert.equal(factorValue(envelope, 'leaked-count'), '3');
  assert.equal(
    factorValue(envelope, 'source-calculation-version'),
    PROFIT_INTELLIGENCE_CALCULATION_VERSION,
    'the CONSUMED calculation version ships in the rationale',
  );
  // The PI figure's canonical source refs travel VERBATIM (kind identity
  // preserved — never dropped or renamed).
  assert.deepEqual(sourceKinds(envelope), ['client', 'execution', 'workflow-instance']);
  assert.equal(envelope.actionContract.kind, 'decision-recording');

  const withoutGoal = items.find(
    (item) => item.itemId === `ao:scope-leakage:client:${CLIENT}:work-without-active-goal`,
  )!;
  assert.equal(withoutGoal.severity, 10, 'the severity caps at scopeLeakageSeverityCap');

  // A null PI view (no view derivable): NO items.
  assert.deepEqual(deriveScopeLeakageItems(clientRows({ profit: null })), []);
});

// ---------------------------------------------------------------------------
// 7. MARGIN PRESSURE — CONSUMED from /profit-intelligence (AC-2f)
// ---------------------------------------------------------------------------

test('margin pressure: negative margin is ALWAYS pressure (severity 10); below-threshold ratios are pressure with the deterministic depth severity; healthy margins are honest absences', () => {
  // Negative margin: always pressure, severity 10.
  const negative = piClientView(
    piMargin({ realizedMargin: profitFigure({ value: -500, sourceRefs: [{ kind: 'metric-observation', id: 'm-1' }] }) }),
    piLeakage([]),
  );
  const negativeItems = deriveMarginPressureItems(clientRows({ profit: negative }));
  assert.equal(negativeItems.length, 1);
  assert.equal(negativeItems[0]!.itemId, `ao:margin-pressure:client:${CLIENT}`);
  assert.equal(negativeItems[0]!.severity, 10);
  assert.equal(factorValue(negativeItems[0]!, 'realized-margin'), '-500');
  assert.equal(factorValue(negativeItems[0]!, 'margin-ratio'), '-0.05', 'the rounded ratio ships');
  assert.equal(
    factorValue(negativeItems[0]!, 'source-calculation-version'),
    PROFIT_INTELLIGENCE_CALCULATION_VERSION,
  );
  assert.ok(negativeItems[0]!.rationale.headline.includes('negative'));
  assert.deepEqual(sourceKinds(negativeItems[0]!),
    ['client', 'metric-observation'],
    'the consumed figure source refs travel verbatim',
  );

  // Below the threshold: margin 700 / revenue 10000 = 0.07 < 0.15.
  // Severity = ceil((0.15 − 0.07)/0.15 × 9) = ceil(4.8) = 5.
  const shallow = piClientView(
    piMargin({
      realizedRevenue: profitFigure({ value: 10_000 }),
      realizedMargin: profitFigure({ value: 700 }),
    }),
    piLeakage([]),
  );
  const shallowItems = deriveMarginPressureItems(clientRows({ profit: shallow }));
  assert.equal(shallowItems.length, 1);
  assert.equal(shallowItems[0]!.severity, 5);
  assert.equal(factorValue(shallowItems[0]!, 'margin-ratio'), '0.07');
  assert.equal(factorValue(shallowItems[0]!, 'pressure-threshold-ratio'), '0.15');

  // Deep below the threshold: margin 100 / revenue 10000 = 0.01 →
  // ceil((0.14/0.15)×9) = ceil(8.4) = 9 (the clamp top).
  const deep = piClientView(
    piMargin({
      realizedRevenue: profitFigure({ value: 10_000 }),
      realizedMargin: profitFigure({ value: 100 }),
    }),
    piLeakage([]),
  );
  assert.equal(deriveMarginPressureItems(clientRows({ profit: deep }))[0]!.severity, 9);

  // Zero revenue with negative margin: the total-pressure posture.
  const zeroRevenue = piClientView(
    piMargin({
      realizedRevenue: profitFigure({ value: 0 }),
      realizedMargin: profitFigure({ value: -50 }),
    }),
    piLeakage([]),
  );
  const zeroRevenueItems = deriveMarginPressureItems(clientRows({ profit: zeroRevenue }));
  assert.equal(zeroRevenueItems.length, 1);
  assert.equal(zeroRevenueItems[0]!.severity, 10);
  assert.equal(factorValue(zeroRevenueItems[0]!, 'margin-ratio'), 'not-derivable-zero-revenue');

  // A healthy margin (ratio ≥ threshold): NO item.
  const healthy = piClientView(
    piMargin({
      realizedRevenue: profitFigure({ value: 10_000 }),
      realizedMargin: profitFigure({ value: 2_000 }),
    }),
    piLeakage([]),
  );
  assert.deepEqual(
    deriveMarginPressureItems(clientRows({ profit: healthy })),
    [],
    'a healthy margin is an honest absence, not pressure',
  );

  // A NON-DERIVABLE margin (null): NO item (never fabricated pressure).
  const nonDerivable = piClientView(
    piMargin({ realizedMargin: profitFigure({ value: null, notDerivableReason: 'currency mismatch' }) }),
    piLeakage([]),
  );
  assert.deepEqual(
    deriveMarginPressureItems(clientRows({ profit: nonDerivable })),
    [],
    'a non-derivable margin is an honest absence',
  );
  // A null PI view: NO items.
  assert.deepEqual(deriveMarginPressureItems(clientRows({ profit: null })), []);
});

// ---------------------------------------------------------------------------
// 8. CAPACITY CONSTRAINT (AC-2g)
// ---------------------------------------------------------------------------

test('capacity: only ACTIVE profiles count; demand = (open + in-flight) jobs × the frozen per-job minutes; the item exists only when demand exceeds declared capacity', () => {
  const activeProfile = humanAgentProfile({ availability: [{ dayOfWeek: 2, startMinute: 480, endMinute: 1080 }] }); // 600 min
  const suspendedProfile = humanAgentProfile({
    agentId: '88888888-0000-4000-8000-000000000002',
    authorizationState: 'suspended',
    availability: [{ dayOfWeek: 3, startMinute: 0, endMinute: 600 }],
  });

  // 5 open + 1 in-flight jobs × 120 = 720 min > 600 min capacity.
  const capacityJobs: CapacityJobRows = {
    openJobs: Array.from({ length: 5 }, (_, index) =>
      job({ jobId: `j1j1j1j1-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, status: 'offered' }),
    ),
    inFlightJobs: [job({ jobId: JOB2, status: 'accepted' })],
  };
  const items = deriveCapacityConstraintItem(AGENCY, [activeProfile, suspendedProfile], capacityJobs);
  assert.equal(items.length, 1);
  const item = items[0]!;
  assert.equal(item.itemId, `ao:capacity-constraint:agency:${AGENCY}`);
  assert.equal(item.scope.clientId, null, 'the capacity item is agency-pool-scoped');
  // Severity = ceil(720/600 × 5) = 6.
  assert.equal(item.severity, 6);
  assert.equal(factorValue(item, 'declared-capacity-minutes'), '600', 'suspended profiles never count');
  assert.equal(factorValue(item, 'projected-demand-minutes'), '720');
  assert.equal(factorValue(item, 'open-job-count'), '5');
  assert.equal(factorValue(item, 'in-flight-job-count'), '1');
  assert.equal(factorValue(item, 'active-profile-count'), '1');
  assert.equal(item.actionContract.kind, 'field-agent-availability');
  assert.equal(item.actionContract.policyDimension, 'field', 'field work is field-dimension policy-gated');
  assert.equal(item.actionContract.policyScopeKind, 'agency');
  // 6 job refs + 1 active profile ref.
  assert.equal(item.sourceRefs.length, 7);

  // Within capacity: NO item.
  const within: CapacityJobRows = { openJobs: capacityJobs.openJobs.slice(0, 2), inFlightJobs: [] };
  assert.deepEqual(deriveCapacityConstraintItem(AGENCY, [activeProfile], within), [], '240 min demand ≤ 600 min capacity');

  // No demand at all: NO item (even with zero capacity).
  assert.deepEqual(
    deriveCapacityConstraintItem(AGENCY, [], { openJobs: [], inFlightJobs: [] }),
    [],
    'no demand ⇒ no constraint',
  );

  // Demand with ZERO declared capacity: the constraint is total (severity 10).
  const total = deriveCapacityConstraintItem(AGENCY, [], {
    openJobs: [job({ status: 'projected' })],
    inFlightJobs: [],
  });
  assert.equal(total.length, 1);
  assert.equal(total[0]!.severity, 10);
  assert.equal(factorValue(total[0]!, 'declared-capacity-minutes'), '0');
});

// ---------------------------------------------------------------------------
// 9. OPPORTUNITIES (AC-2h)
// ---------------------------------------------------------------------------

test('opportunities: ready/analyzing/promotable experiments and contradicted learnings derive items with frozen severities and action contracts', () => {
  const rows = clientRows({
    experiments: [
      experiment({ status: 'ready', experimentId: 'c3c3c3c3-0000-4000-8000-000000000001' }),
      experiment({ status: 'analyzing', experimentId: 'c3c3c3c3-0000-4000-8000-000000000002' }),
      experiment({
        status: 'concluded',
        resultState: 'causal_supported',
        experimentId: 'c3c3c3c3-0000-4000-8000-000000000003',
        concludedAt: '2026-09-20T09:00:00.000Z',
      }),
      // Never an opportunity.
      experiment({ status: 'running', experimentId: 'c3c3c3c3-0000-4000-8000-000000000004' }),
      experiment({
        status: 'concluded',
        resultState: 'inconclusive',
        experimentId: 'c3c3c3c3-0000-4000-8000-000000000005',
      }),
      experiment({ status: 'stopped', experimentId: 'c3c3c3c3-0000-4000-8000-000000000006' }),
    ],
    learnings: [
      learning({ status: 'contradicted' }),
      learning({ status: 'active', learningId: 'b7b7b7b7-0000-4000-8000-000000000002' }),
      learning({ status: 'superseded', learningId: 'b7b7b7b7-0000-4000-8000-000000000003' }),
    ],
  });

  const items = deriveOpportunityItems(rows);
  assert.equal(items.length, 4);
  const byId = new Map(items.map((item) => [item.itemId, item] as const));

  const ready = byId.get('ao:opportunity:experiment:c3c3c3c3-0000-4000-8000-000000000001')!;
  assert.equal(ready.severity, 4);
  assert.equal(factorValue(ready, 'opportunity-kind'), 'experiment-awaiting-start');
  assert.equal(ready.actionContract.kind, 'experiment-lifecycle');

  const analyzing = byId.get('ao:opportunity:experiment:c3c3c3c3-0000-4000-8000-000000000002')!;
  assert.equal(analyzing.severity, 6);
  assert.equal(factorValue(analyzing, 'opportunity-kind'), 'experiment-analysis-pending');

  const promotable = byId.get('ao:opportunity:experiment:c3c3c3c3-0000-4000-8000-000000000003')!;
  assert.equal(promotable.severity, 8);
  assert.equal(factorValue(promotable, 'opportunity-kind'), 'experiment-promotable');
  assert.equal(promotable.actionContract.kind, 'decision-recording', 'a causal-supported finding promotes through the Decision Ledger');
  assert.ok(promotable.rationale.headline.includes('promotable'));

  const contradicted = byId.get(`ao:opportunity:learning:${LEARNING}`)!;
  assert.equal(contradicted.severity, 7);
  assert.equal(factorValue(contradicted, 'opportunity-kind'), 'learning-contradicted');
  assert.equal(contradicted.actionContract.kind, 'learning-revision');
});

// ---------------------------------------------------------------------------
// 10. THE RANKING CORE (AC-6: deterministic, versioned, total)
// ---------------------------------------------------------------------------

test('the ranking core: score = base + severity + recurrence (each capped); the total order is score DESC → category ASC → itemId ASC', () => {
  // Build a raw candidate set with known score inputs across categories.
  const rows = clientRows({
    workspaces: [
      {
        workspaceId: WORKSPACE,
        instances: [instance({ status: 'blocked', workflowInstanceId: INSTANCE })],
        deployments: [],
        executions: [],
      },
    ],
    jobs: [job({ status: 'expired', jobId: JOB })],
    evidence: [evidence({ evidenceId: EVIDENCE, quality: 'F' })],
    experiments: [experiment({ status: 'ready' })],
    learnings: [learning({ status: 'contradicted' })],
    profit: piClientView(
      piMargin({
        realizedRevenue: profitFigure({ value: 10_000 }),
        realizedMargin: profitFigure({ value: 700 }),
      }),
      piLeakage([{ kind: 'executions-outside-deployed-envelope', rule: 'r', count: 2, sourceRefs: [] }]),
    ),
  });

  const snapshot: AgencyScopeSnapshot = {
    agencyId: AGENCY,
    clients: [rows],
    undecidedPolicyDecisions: [
      policyDecision({ decisionId: DECISION, outcome: 'unknown', reasonCode: 'no-active-policy' }),
    ],
    humanAgentProfiles: [],
    capacityJobs: { openJobs: [], inFlightJobs: [] },
  };

  const raw = deriveAgencyAttentionItems(snapshot);
  // blocked-work instance (80 + 8), blocked-work job expired (80 + 6),
  // anomaly (none), approval (90 + 10), client-risk (75 + 1),
  // scope-leakage (55 + 2), margin-pressure (70 + 5), opportunity
  // experiment (40 + 4) + learning (40 + 7).
  const ranked = rankAttentionItems(raw);
  assert.equal(ranked.length, 8, 'no capacity item: zero demand (empty capacity jobs) ⇒ honest absence');

  // The exact expected order (deterministic, hand-computed):
  //   approval     100  (90 + 10)
  //   blocked-work  88  (80 + 8)
  //   blocked-work  86  (80 + 6)
  //   client-risk   76  (75 + 1)
  //   margin        75  (70 + 5)
  //   scope-leakage 57  (55 + 2)
  //   opportunity   47  (40 + 7, learning — higher severity)
  //   opportunity   44  (40 + 4, experiment)
  const expectedOrder = [
    `ao:approval:policy-decision:${DECISION}`,
    `ao:blocked-work:workflow-instance:${INSTANCE}`,
    `ao:blocked-work:job:${JOB}`,
    `ao:client-risk:client:${CLIENT}`,
    `ao:margin-pressure:client:${CLIENT}`,
    `ao:scope-leakage:client:${CLIENT}:executions-outside-deployed-envelope`,
    `ao:opportunity:learning:${LEARNING}`,
    `ao:opportunity:experiment:${EXPERIMENT}`,
  ];
  assert.deepEqual(
    ranked.map((item) => item.itemId),
    expectedOrder,
    'the queue order is exactly the frozen deterministic rules',
  );
  // The scores are exactly base + severity + recurrence.
  const scores = new Map(ranked.map((item) => [item.itemId, item.priorityScore] as const));
  assert.equal(scores.get(`ao:approval:policy-decision:${DECISION}`), 100);
  assert.equal(scores.get(`ao:blocked-work:workflow-instance:${INSTANCE}`), 88);
  assert.equal(scores.get(`ao:blocked-work:job:${JOB}`), 86);
  assert.equal(scores.get(`ao:client-risk:client:${CLIENT}`), 76);
  assert.equal(scores.get(`ao:margin-pressure:client:${CLIENT}`), 75);
  assert.equal(scores.get(`ao:scope-leakage:client:${CLIENT}:executions-outside-deployed-envelope`), 57);
  assert.equal(scores.get(`ao:opportunity:learning:${LEARNING}`), 47);
  assert.equal(scores.get(`ao:opportunity:experiment:${EXPERIMENT}`), 44);

  // Contiguous 1-based ranks.
  assert.deepEqual(
    ranked.map((item) => item.rank),
    Array.from({ length: ranked.length }, (_, index) => index + 1),
  );
  // The tally carries EVERY category key.
  const counts = tallyCategoryCounts(ranked);
  assert.deepEqual(counts, {
    'blocked-work': 2,
    approval: 1,
    'client-risk': 1,
    anomaly: 0,
    'scope-leakage': 1,
    'margin-pressure': 1,
    'capacity-constraint': 0,
    opportunity: 2,
  });
});

test('the ranking core: severity and recurrence are CAPPED into their frozen ranges in the score', () => {
  const rows = emptyClientRows({
    // 99 weak evidence records: raw severity caps at 10.
    evidence: Array.from({ length: 99 }, (_, index) =>
      evidence({ evidenceId: `a1a1a1a1-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, quality: 'F' }),
    ),
  });
  const [risk] = deriveClientRiskItems(rows);
  assert.ok(risk !== undefined);
  const [ranked] = rankAttentionItems([risk]);
  // 75 (client-risk base) + 10 (capped severity) + 0 = 85.
  assert.equal(ranked!.priorityScore, 85);
});

test('the ranking tiebreak: equal scores order by category ASC (lexicographic), then itemId ASC', () => {
  // Two candidates with identical scores: an expired job (80+6=86) and a
  // declined job (80+5=85)… craft two SAME-score items instead: two
  // expired jobs (both 80 + 6).
  const rows = clientRows({
    workspaces: [],
    jobs: [
      job({ status: 'expired', jobId: 'a1a1a1a1-0000-4000-8000-00000000000a' }),
      job({ status: 'expired', jobId: 'a1a1a1a1-0000-4000-8000-00000000000b' }),
      job({ status: 'declined', jobId: 'a1a1a1a1-0000-4000-8000-00000000000c' }),
    ],
    evidence: [],
    experiments: [],
    learnings: [],
  });
  const ranked = rankAttentionItems(deriveBlockedWorkItems(rows));
  assert.deepEqual(
    ranked.map((item) => item.itemId),
    [
      'ao:blocked-work:job:a1a1a1a1-0000-4000-8000-00000000000a', // 86
      'ao:blocked-work:job:a1a1a1a1-0000-4000-8000-00000000000b', // 86 (itemId ASC tiebreak)
      'ao:blocked-work:job:a1a1a1a1-0000-4000-8000-00000000000c', // 85
    ],
  );
  assert.deepEqual(ranked.map((item) => item.priorityScore), [86, 86, 85]);
});

test('PINNING (AC-6): the same inputs derive BYTE-IDENTICAL queues on every call and under input-order permutation', () => {
  const rows = clientRows({
    workspaces: [
      {
        workspaceId: WORKSPACE,
        instances: [
          instance({ status: 'blocked', workflowInstanceId: INSTANCE }),
          instance({ status: 'paused', workflowInstanceId: 'efefefef-0000-4000-8000-000000000002' }),
        ],
        deployments: [deployment({ status: 'disabled' })],
        executions: [
          execution({ status: 'unknown', executionId: EXEC }),
          execution({ status: 'failed', executionId: EXEC2, attemptNumber: 3, retryClassification: 'unsafe' }),
        ],
      },
    ],
    jobs: [job({ status: 'expired', jobId: JOB })],
    evidence: [evidence({ quality: 'D' }), evidence({ evidenceId: EVIDENCE2, quality: 'E' })],
    experiments: [experiment({ status: 'ready' }), experiment({ status: 'analyzing', experimentId: 'c3c3c3c3-0000-4000-8000-000000000002' })],
    learnings: [learning({ status: 'contradicted' })],
    profit: piClientView(
      piMargin({
        realizedRevenue: profitFigure({ value: 10_000 }),
        realizedMargin: profitFigure({ value: 700 }),
      }),
      piLeakage([{ kind: 'work-without-active-goal', rule: 'r', count: 4, sourceRefs: [] }]),
    ),
  });

  const first = rankAttentionItems(deriveAgencyAttentionItems({
    agencyId: AGENCY,
    clients: [rows],
    undecidedPolicyDecisions: [policyDecision({ decisionId: DECISION, outcome: 'unknown' })],
    humanAgentProfiles: [humanAgentProfile()],
    capacityJobs: { openJobs: [job({ status: 'projected', jobId: JOB2 })], inFlightJobs: [] },
  }));
  const second = rankAttentionItems(deriveAgencyAttentionItems({
    agencyId: AGENCY,
    clients: [rows],
    undecidedPolicyDecisions: [policyDecision({ decisionId: DECISION, outcome: 'unknown' })],
    humanAgentProfiles: [humanAgentProfile()],
    capacityJobs: { openJobs: [job({ status: 'projected', jobId: JOB2 })], inFlightJobs: [] },
  }));
  assert.equal(
    JSON.stringify(second),
    JSON.stringify(first),
    'same authority rows + same rank version ⇒ byte-identical queue (no clock, no randomness)',
  );

  // Input-order permutation: the same queue, byte-identical.
  const reversed = rankAttentionItems([...deriveAgencyAttentionItems({
    agencyId: AGENCY,
    clients: [rows],
    undecidedPolicyDecisions: [policyDecision({ decisionId: DECISION, outcome: 'unknown' })],
    humanAgentProfiles: [humanAgentProfile()],
    capacityJobs: { openJobs: [job({ status: 'projected', jobId: JOB2 })], inFlightJobs: [] },
  })].reverse());
  assert.equal(JSON.stringify(reversed), JSON.stringify(first), 'input order never affects the queue order');
});

// ---------------------------------------------------------------------------
// 11. THE AGENCY AGGREGATE (the exact union)
// ---------------------------------------------------------------------------

test('deriveAgencyAttentionItems is the exact union of the client derivations + the agency approvals + the one capacity item', () => {
  const rows = clientRows();
  const snapshot: AgencyScopeSnapshot = {
    agencyId: AGENCY,
    clients: [rows],
    undecidedPolicyDecisions: [policyDecision({ decisionId: DECISION, outcome: 'unknown' })],
    humanAgentProfiles: [humanAgentProfile()],
    capacityJobs: { openJobs: [job({ status: 'projected', jobId: JOB2 })], inFlightJobs: [] },
  };
  const aggregated = deriveAgencyAttentionItems(snapshot).map((item) => item.itemId).sort();

  const expected = [
    ...deriveBlockedWorkItems(rows),
    ...deriveAnomalyItems(rows),
    ...deriveClientRiskItems(rows),
    ...deriveScopeLeakageItems(rows),
    ...deriveMarginPressureItems(rows),
    ...deriveOpportunityItems(rows),
    ...deriveApprovalItems([policyDecision({ decisionId: DECISION, outcome: 'unknown' })], null),
    ...deriveCapacityConstraintItem(AGENCY, [humanAgentProfile()], {
      openJobs: [job({ status: 'projected', jobId: JOB2 })],
      inFlightJobs: [],
    }),
  ]
    .map((item) => item.itemId)
    .sort();
  assert.deepEqual(aggregated, expected, 'the agency aggregate is exactly the union (no duplicates, no drops)');
});

// ---------------------------------------------------------------------------
// 12. ASSUMPTION PROPAGATION (AC-3: no hidden constants)
// ---------------------------------------------------------------------------

test(`every item's scoreAssumptionKeys name REAL entries of the exported assumption set; ranking carries every raw field verbatim`, () => {
  const assumptionKeys = new Set(Object.keys(AI_OPERATOR_ASSUMPTIONS));
  const rows = clientRows({
    workspaces: [
      {
        workspaceId: WORKSPACE,
        instances: [instance({ status: 'blocked' })],
        deployments: [deployment({ status: 'blocked' })],
        executions: [execution({ status: 'unknown', executionId: EXEC })],
      },
    ],
    jobs: [job({ status: 'expired', jobId: JOB })],
    evidence: [evidence({ quality: 'D' }), evidence({ evidenceId: EVIDENCE2, quality: 'E' })],
    experiments: [experiment({ status: 'ready' })],
    learnings: [learning({ status: 'contradicted' })],
    profit: piClientView(
      piMargin({
        realizedRevenue: profitFigure({ value: 10_000 }),
        realizedMargin: profitFigure({ value: -100 }),
      }),
      piLeakage([{ kind: 'work-without-active-goal', rule: 'r', count: 4, sourceRefs: [] }]),
    ),
  });
  const snapshot: AgencyScopeSnapshot = {
    agencyId: AGENCY,
    clients: [rows],
    undecidedPolicyDecisions: [
      policyDecision({ decisionId: DECISION, outcome: 'unknown', reasonCode: 'no-matching-rule' }),
    ],
    humanAgentProfiles: [humanAgentProfile()],
    capacityJobs: {
      // 6 projected jobs × 120 = 720 min > 600 min declared capacity.
      openJobs: Array.from({ length: 6 }, (_, index) =>
        job({
          jobId: `j1j1j1j1-0000-4000-8000-${String(index + 2).padStart(12, '0')}`,
          status: 'projected',
        }),
      ),
      inFlightJobs: [],
    },
  };
  const raw = deriveAgencyAttentionItems(snapshot);
  const ranked = rankAttentionItems(raw);

  for (const item of ranked) {
    assert.ok(item.scoreAssumptionKeys.length > 0, 'every item discloses its consumed assumptions');
    for (const key of item.scoreAssumptionKeys) {
      assert.ok(assumptionKeys.has(key), `assumption key '${key}' is a REAL exported entry`);
    }
    assert.ok(item.scoreAssumptionKeys.includes('categoryBaseWeights'));
    assert.equal(item.scope.agencyId, AGENCY);
  }

  // Per-category assumption disclosure.
  const byCategory = new Map(ranked.map((item) => [item.category, item] as const));
  assert.deepEqual(byCategory.get('approval')!.scoreAssumptionKeys, [
    'categoryBaseWeights',
    'severityModifierRange',
    'recurrenceModifierRange',
    'approvalDimensionRecurrenceCap',
  ]);
  assert.deepEqual(byCategory.get('client-risk')!.scoreAssumptionKeys, [
    'categoryBaseWeights',
    'severityModifierRange',
    'recurrenceModifierRange',
    'clientRiskWeakEvidenceGrades',
    'clientRiskWeakEvidenceThreshold',
    'clientRiskSeverityCap',
  ]);
  assert.ok(byCategory.get('capacity-constraint')!.scoreAssumptionKeys.includes('capacityDemandMinutesPerJob'));
  assert.ok(byCategory.get('margin-pressure')!.scoreAssumptionKeys.includes('marginPressureThresholdRatio'));
  assert.ok(byCategory.get('scope-leakage')!.scoreAssumptionKeys.includes('scopeLeakageSeverityCap'));
  assert.ok(byCategory.get('anomaly')!.scoreAssumptionKeys.includes('anomalyAttemptRecurrenceCap'));

  // The ranked items carry the raw fields VERBATIM (nothing invented).
  const rawById = new Map(raw.map((item) => [item.itemId, item] as const));
  for (const item of ranked) {
    const source = rawById.get(item.itemId)!;
    assert.deepEqual(item.sourceRefs, source.sourceRefs);
    assert.deepEqual(item.rationale, source.rationale);
    assert.deepEqual(item.actionContract, source.actionContract);
    assert.deepEqual(item.scoreAssumptionKeys, source.scoreAssumptionKeys);
    assert.equal(item.scope.clientId, source.scope.clientId);
    assert.equal(item.scope.workspaceId, source.scope.workspaceId);
  }
});
