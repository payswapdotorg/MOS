/**
 * Creator Operations Domain Pack — the FROZEN MANIFEST (MKT-037,
 * CREATOR-001).
 *
 * The versioned Domain Pack manifest of spec/creator-operations-v1.3.md,
 * published through the MKT-036 framework (publishDomainPackVersion — the
 * manifest guard validates the closed 14-kind artifact vocabulary, the §5
 * scope vocabulary, unique (kind, name) identities, the §21 material-key
 * backstop and §4 WORKFLOW-TEMPLATE CONFORMANCE through the /workflows
 * authority's own validator). IMMUTABLE once published; a semantic change
 * publishes a NEW version (domain-pack-v1.3.md §4).
 *
 * Artifact inventory (creator-operations-v1.3.md §2–§7):
 *   - 6 domain-entity + 2 view artifacts        → the §2 subject surface
 *     (pack-owned, Client-scoped);
 *   - 2 metric-definition artifacts             → the §2 Creator
 *     Performance Metric mapping targets (CREATOR-AC-02);
 *   - 10 workflow-template artifacts            → every §3 operating
 *     workflow, each payload an exact /workflows §4 definition content,
 *     executed ONLY through the existing Workflow/Execution authorities,
 *     scope 'agency-reusable' (domain-pack-v1.3.md §5 "an Agency-scoped
 *     reusable artifact such as a playbook template");
 *   - 7 ai-capability artifacts                 → the §5 AI task classes
 *     as EXACT TaskProfile (§10) declarations — routed ONLY through the
 *     /ai-runtime AI Router (CREATOR-AC-03);
 *   - 6 human-capability artifacts              → the §4 human roles as
 *     Human Agent specializations of the GENERIC model — served ONLY
 *     through the existing Job/Task/Execution authorities (CREATOR-AC-04);
 *   - 2 policy artifacts                        → the §5 sensitive-action
 *     approval-gate declarations consumed through the /policies authority
 *     (CREATOR-AC-06);
 *   - 7 integration-binding artifacts           → the §6 normalized
 *     creator-platform capabilities (provider implementations stay behind
 *     /integrations + /extensions — CREATOR-AC-05);
 *   - 5 evidence-schema artifacts               → the §7 observation
 *     content schemas for the COMMON /evidence authority
 *     (CREATOR-AC-02).
 *
 * Every payload is provider-neutral DATA: platform labels, task classes
 * and model-free contracts. No SDK name, no credential, no secret, no
 * provider coupling anywhere (§21 backstop enforced at publication).
 */

import type { DomainPackManifest } from '../../../public.ts';
import {
  CREATOR_HUMAN_SPECIALIZATION_MIRROR,
  type CreatorTaskProfileDeclaration,
} from './contract.ts';

// ---------------------------------------------------------------------------
// The frozen TaskProfile declarations (§5 — CREATOR-AC-03)
// ---------------------------------------------------------------------------

/**
 * The pack's AI task classes (creator-operations-v1.3.md §5: "Typical
 * task classes include classification, retrieval/synthesis, response
 * drafting, content generation, conversation summarization, segmentation,
 * and recommendation"). Each declaration is EXACTLY the eleven §10
 * TaskProfile contract fields; provisioning registers them as REAL
 * /ai-runtime TaskProfiles so the tasks are consumed through the platform
 * AI Router — never through provider-specific model calls.
 */
export const CREATOR_TASK_PROFILE_DECLARATIONS: readonly CreatorTaskProfileDeclaration[] = [
  {
    taskClass: 'creator.classification',
    qualityTarget: 'balanced_accuracy',
    riskClass: 'low',
    contextRequirements: { maxInputTokens: 4000, audienceContext: true },
    latencyTargetMs: 2000,
    maxCostPerInvocation: 0.002,
    privacyClass: 'confidential',
    toolRequirements: [],
    outputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string' },
        confidence: { type: 'number' },
      },
      required: ['label'],
    },
    evaluatorIds: [],
    escalationPolicy: { onLowConfidence: 'route_to_human_review' },
  },
  {
    taskClass: 'creator.retrieval_synthesis',
    qualityTarget: 'faithful_grounding',
    riskClass: 'low',
    contextRequirements: { maxInputTokens: 16000, retrievalScope: 'creator_context' },
    latencyTargetMs: 8000,
    maxCostPerInvocation: 0.01,
    privacyClass: 'confidential',
    toolRequirements: ['retrieval'],
    outputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        sources: { type: 'array' },
      },
      required: ['summary'],
    },
    evaluatorIds: [],
    escalationPolicy: { onTimeout: 'retry_once_then_human' },
  },
  {
    taskClass: 'creator.response_drafting',
    qualityTarget: 'audience_appropriate_tone',
    riskClass: 'medium',
    contextRequirements: { maxInputTokens: 8000, conversationHistory: true },
    latencyTargetMs: 4000,
    maxCostPerInvocation: 0.005,
    privacyClass: 'confidential',
    toolRequirements: [],
    outputSchema: {
      type: 'object',
      properties: {
        draftReply: { type: 'string' },
        tone: { type: 'string' },
      },
      required: ['draftReply'],
    },
    evaluatorIds: [],
    // Drafts only — the OUTBOUND SEND is the human/policy-gated side
    // effect (§5), never this task.
    escalationPolicy: { humanApprovalRequiredBeforeSend: true },
  },
  {
    taskClass: 'creator.content_generation',
    qualityTarget: 'brand_aligned_quality',
    riskClass: 'medium',
    contextRequirements: { maxInputTokens: 12000, contentBrief: true },
    latencyTargetMs: 20000,
    maxCostPerInvocation: 0.02,
    privacyClass: 'internal',
    toolRequirements: [],
    outputSchema: {
      type: 'object',
      properties: {
        contentDraft: { type: 'string' },
        variantCount: { type: 'number' },
      },
      required: ['contentDraft'],
    },
    evaluatorIds: [],
    // Generated content is a DRAFT — publication is the human/policy-gated
    // side effect (§5).
    escalationPolicy: { humanApprovalRequiredBeforePublish: true },
  },
  {
    taskClass: 'creator.conversation_summarization',
    qualityTarget: 'faithful_compression',
    riskClass: 'low',
    contextRequirements: { maxInputTokens: 20000, conversationHistory: true },
    latencyTargetMs: 6000,
    maxCostPerInvocation: 0.004,
    privacyClass: 'confidential',
    toolRequirements: [],
    outputSchema: {
      type: 'object',
      properties: {
        conversationSummary: { type: 'string' },
        openActionItems: { type: 'array' },
      },
      required: ['conversationSummary'],
    },
    evaluatorIds: [],
    escalationPolicy: {},
  },
  {
    taskClass: 'creator.segmentation',
    qualityTarget: 'stable_cohort_assignment',
    riskClass: 'low',
    contextRequirements: { maxInputTokens: 24000, audienceAggregates: true },
    latencyTargetMs: 10000,
    maxCostPerInvocation: 0.008,
    privacyClass: 'internal',
    toolRequirements: [],
    outputSchema: {
      type: 'object',
      properties: {
        segments: { type: 'array' },
        segmentCount: { type: 'number' },
      },
      required: ['segments'],
    },
    evaluatorIds: [],
    escalationPolicy: {},
  },
  {
    taskClass: 'creator.recommendation',
    qualityTarget: 'engagement_lift_orientation',
    riskClass: 'low',
    contextRequirements: { maxInputTokens: 12000, performanceAggregates: true },
    latencyTargetMs: 5000,
    maxCostPerInvocation: 0.006,
    privacyClass: 'internal',
    toolRequirements: [],
    outputSchema: {
      type: 'object',
      properties: {
        recommendations: { type: 'array' },
        rationale: { type: 'string' },
      },
      required: ['recommendations'],
    },
    evaluatorIds: [],
    // Recommendations are advisory — attribution must not be presented as
    // causal lift without a qualifying design (§7).
    escalationPolicy: { onLowConfidence: 'mark_as_advisory_only' },
  },
];

// ---------------------------------------------------------------------------
// Workflow-template node factories (§4-conformant shapes)
// ---------------------------------------------------------------------------

type SchemaShape = {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, { readonly type: string }>>;
  readonly required: readonly string[];
};

type InputMapping = Readonly<
  Record<string, { readonly source: 'workflow_input' | 'node_output'; readonly nodeId?: string; readonly path: string }>
>;

function node(
  nodeId: string,
  nodeType: 'function' | 'ai_task' | 'human_task' | 'experiment',
  inputMapping: InputMapping,
  outputSchema: SchemaShape,
): Record<string, unknown> {
  return {
    nodeId,
    nodeType,
    inputMapping,
    outputSchema,
    executionPolicyRef: null,
    retryPolicy: null,
    timeout: null,
    idempotencyKeyStrategy: 'workflow',
    humanApproval: null,
    join: null,
    loop: null,
  };
}

function humanTaskNode(
  nodeId: string,
  inputMapping: InputMapping,
  outputSchema: SchemaShape,
): Record<string, unknown> {
  return {
    ...node(nodeId, 'human_task', inputMapping, outputSchema),
    // §4 node contract: human_task nodes MUST declare their human approval
    // requirement (implementation-contract §4 "human approval requirement
    // if applicable").
    humanApproval: { required: true, approverPolicyRef: null },
  };
}

function terminalNode(nodeId: string, inputMapping: InputMapping): Record<string, unknown> {
  return {
    nodeId,
    nodeType: 'terminal',
    inputMapping,
    outputSchema: { type: 'object', properties: {}, required: [] },
    executionPolicyRef: null,
    retryPolicy: null,
    timeout: null,
    idempotencyKeyStrategy: null,
    humanApproval: null,
    join: null,
    loop: null,
  };
}

function successEdge(fromNode: string, toNode: string): Record<string, unknown> {
  return { fromNode, toNode, edgeType: 'success', predicateRef: null, joinSemantics: null };
}

function workflowInput(path: string): { source: 'workflow_input'; path: string } {
  return { source: 'workflow_input', path };
}

function nodeOutput(nodeId: string, path: string): { source: 'node_output'; nodeId: string; path: string } {
  return { source: 'node_output', nodeId, path };
}

/** Definition-level policy blocks (empty = no defaults declared). */
const EMPTY_RETRY_DEFAULTS = {};
const EMPTY_CONCURRENCY = {};
const EMPTY_TIMEOUT = {};

/**
 * One §4-conformant linear workflow template: entry → (work) → terminal.
 * Every human step carries the human approval requirement; AI steps are
 * TaskProfile-consumed nodes; experiment steps ride the /experiments
 * authority node class.
 */
function linearTemplate(
  inputProperties: Readonly<Record<string, { readonly type: string }>>,
  nodes: readonly Record<string, unknown>[],
  edges: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return {
    graph: { nodes, edges },
    inputSchema: { type: 'object', properties: inputProperties, required: [] },
    outputSchema: { type: 'object', properties: {}, required: [] },
    retryPolicyDefaults: EMPTY_RETRY_DEFAULTS,
    concurrencyLimits: EMPTY_CONCURRENCY,
    timeoutPolicy: EMPTY_TIMEOUT,
    compensation: [],
  };
}

// ---------------------------------------------------------------------------
// The §3 workflow templates (10 — every operating workflow of the spec)
// ---------------------------------------------------------------------------

/**
 * The ten governed workflow templates of creator-operations-v1.3.md §3,
 * keyed by template name. Each payload is an EXACT WorkflowDefinitionContent
 * (the /workflows §4 contract — validated through the Workflow
 * authority's own validator at publication and materialized as Workflow
 * Definitions ONLY through the /workflows authority). Human steps carry
 * the mandatory human approval requirement; their Job projections ride
 * the existing /jobs authority with the pack's §4 specialization
 * guidance.
 */
export const CREATOR_WORKFLOW_TEMPLATES: Readonly<
  Record<string, Record<string, unknown>>
> = {
  // §3 "audience segmentation"
  'audience-segmentation': linearTemplate(
    { accountId: { type: 'string' }, segmentCount: { type: 'number' } },
    [
      node(
        'load_fan_cohort',
        'function',
        { accountId: workflowInput('accountId'), segmentCount: workflowInput('segmentCount') },
        { type: 'object', properties: { fanCohort: { type: 'array' } }, required: ['fanCohort'] },
      ),
      node(
        'segment_audience',
        'ai_task',
        { fanCohort: nodeOutput('load_fan_cohort', 'fanCohort') },
        { type: 'object', properties: { segments: { type: 'array' } }, required: ['segments'] },
      ),
      humanTaskNode(
        'review_segments',
        { segments: nodeOutput('segment_audience', 'segments') },
        {
          type: 'object',
          properties: { reviewedSegments: { type: 'array' } },
          required: ['reviewedSegments'],
        },
      ),
      terminalNode('record_segments', {
        reviewedSegments: nodeOutput('review_segments', 'reviewedSegments'),
      }),
    ],
    [
      successEdge('load_fan_cohort', 'segment_audience'),
      successEdge('segment_audience', 'review_segments'),
      successEdge('review_segments', 'record_segments'),
    ],
  ),

  // §3 "conversation triage and response drafting"
  'conversation-triage': linearTemplate(
    { conversationId: { type: 'string' } },
    [
      node(
        'load_conversation',
        'function',
        { conversationId: workflowInput('conversationId') },
        {
          type: 'object',
          properties: { messageHistory: { type: 'array' } },
          required: ['messageHistory'],
        },
      ),
      node(
        'draft_reply',
        'ai_task',
        { messageHistory: nodeOutput('load_conversation', 'messageHistory') },
        { type: 'object', properties: { draftReply: { type: 'string' } }, required: ['draftReply'] },
      ),
      humanTaskNode(
        'approve_reply',
        { draftReply: nodeOutput('draft_reply', 'draftReply') },
        {
          type: 'object',
          properties: { approvedReply: { type: 'string' } },
          required: ['approvedReply'],
        },
      ),
      terminalNode('record_reply', {
        approvedReply: nodeOutput('approve_reply', 'approvedReply'),
      }),
    ],
    [
      successEdge('load_conversation', 'draft_reply'),
      successEdge('draft_reply', 'approve_reply'),
      successEdge('approve_reply', 'record_reply'),
    ],
  ),

  // §3 "human chat operations"
  'human-chat-operations': linearTemplate(
    { conversationId: { type: 'string' } },
    [
      node(
        'load_open_conversation',
        'function',
        { conversationId: workflowInput('conversationId') },
        {
          type: 'object',
          properties: { conversationSummary: { type: 'string' } },
          required: ['conversationSummary'],
        },
      ),
      humanTaskNode(
        'respond_to_fan',
        { conversationSummary: nodeOutput('load_open_conversation', 'conversationSummary') },
        { type: 'object', properties: { response: { type: 'string' } }, required: ['response'] },
      ),
      terminalNode('record_response', {
        response: nodeOutput('respond_to_fan', 'response'),
      }),
    ],
    [
      successEdge('load_open_conversation', 'respond_to_fan'),
      successEdge('respond_to_fan', 'record_response'),
    ],
  ),

  // §3 "creator content planning/repurposing"
  'content-planning': linearTemplate(
    { profileId: { type: 'string' }, contentGoal: { type: 'string' } },
    [
      node(
        'load_content_brief',
        'function',
        { profileId: workflowInput('profileId'), contentGoal: workflowInput('contentGoal') },
        { type: 'object', properties: { contentBrief: { type: 'string' } }, required: ['contentBrief'] },
      ),
      node(
        'generate_content_plan',
        'ai_task',
        { contentBrief: nodeOutput('load_content_brief', 'contentBrief') },
        { type: 'object', properties: { contentPlan: { type: 'string' } }, required: ['contentPlan'] },
      ),
      humanTaskNode(
        'review_content_plan',
        { contentPlan: nodeOutput('generate_content_plan', 'contentPlan') },
        {
          type: 'object',
          properties: { approvedPlan: { type: 'string' } },
          required: ['approvedPlan'],
        },
      ),
      terminalNode('record_plan', {
        approvedPlan: nodeOutput('review_content_plan', 'approvedPlan'),
      }),
    ],
    [
      successEdge('load_content_brief', 'generate_content_plan'),
      successEdge('generate_content_plan', 'review_content_plan'),
      successEdge('review_content_plan', 'record_plan'),
    ],
  ),

  // §3 "growth experiments"
  'growth-experiment': linearTemplate(
    { clientId: { type: 'string' }, hypothesis: { type: 'string' } },
    [
      node(
        'load_growth_hypothesis',
        'function',
        { clientId: workflowInput('clientId'), hypothesis: workflowInput('hypothesis') },
        {
          type: 'object',
          properties: { experimentDesign: { type: 'string' } },
          required: ['experimentDesign'],
        },
      ),
      node(
        'run_growth_experiment',
        'experiment',
        { experimentDesign: nodeOutput('load_growth_hypothesis', 'experimentDesign') },
        {
          type: 'object',
          properties: {
            experimentRecordRef: { type: 'string' },
            experimentConclusion: { type: 'string' },
          },
          required: ['experimentRecordRef', 'experimentConclusion'],
        },
      ),
      terminalNode('record_experiment', {
        experimentRecordRef: nodeOutput('run_growth_experiment', 'experimentRecordRef'),
        experimentConclusion: nodeOutput('run_growth_experiment', 'experimentConclusion'),
      }),
    ],
    [
      successEdge('load_growth_hypothesis', 'run_growth_experiment'),
      successEdge('run_growth_experiment', 'record_experiment'),
    ],
  ),

  // §3 "fan reactivation"
  'fan-reactivation': linearTemplate(
    { accountId: { type: 'string' } },
    [
      node(
        'load_churned_fans',
        'function',
        { accountId: workflowInput('accountId') },
        {
          type: 'object',
          properties: { churnedFanCohort: { type: 'array' } },
          required: ['churnedFanCohort'],
        },
      ),
      node(
        'recommend_reactivation',
        'ai_task',
        { churnedFanCohort: nodeOutput('load_churned_fans', 'churnedFanCohort') },
        {
          type: 'object',
          properties: { reactivationPlan: { type: 'string' } },
          required: ['reactivationPlan'],
        },
      ),
      humanTaskNode(
        'approve_outreach',
        { reactivationPlan: nodeOutput('recommend_reactivation', 'reactivationPlan') },
        {
          type: 'object',
          properties: { approvedOutreachPlan: { type: 'string' } },
          required: ['approvedOutreachPlan'],
        },
      ),
      terminalNode('record_reactivation', {
        approvedOutreachPlan: nodeOutput('approve_outreach', 'approvedOutreachPlan'),
      }),
    ],
    [
      successEdge('load_churned_fans', 'recommend_reactivation'),
      successEdge('recommend_reactivation', 'approve_outreach'),
      successEdge('approve_outreach', 'record_reactivation'),
    ],
  ),

  // §3 "offer testing"
  'offer-testing': linearTemplate(
    { profileId: { type: 'string' } },
    [
      node(
        'load_offer_candidates',
        'function',
        { profileId: workflowInput('profileId') },
        {
          type: 'object',
          properties: { offerCandidates: { type: 'array' } },
          required: ['offerCandidates'],
        },
      ),
      node(
        'run_offer_test',
        'experiment',
        { offerCandidates: nodeOutput('load_offer_candidates', 'offerCandidates') },
        {
          type: 'object',
          properties: {
            winningOfferRef: { type: 'string' },
            testConclusion: { type: 'string' },
          },
          required: ['winningOfferRef', 'testConclusion'],
        },
      ),
      terminalNode('record_offer_test', {
        winningOfferRef: nodeOutput('run_offer_test', 'winningOfferRef'),
        testConclusion: nodeOutput('run_offer_test', 'testConclusion'),
      }),
    ],
    [
      successEdge('load_offer_candidates', 'run_offer_test'),
      successEdge('run_offer_test', 'record_offer_test'),
    ],
  ),

  // §3 "revenue analysis"
  'revenue-analysis': linearTemplate(
    { clientId: { type: 'string' }, periodStart: { type: 'string' }, periodEnd: { type: 'string' } },
    [
      node(
        'load_monetization_ledger',
        'function',
        {
          clientId: workflowInput('clientId'),
          periodStart: workflowInput('periodStart'),
          periodEnd: workflowInput('periodEnd'),
        },
        {
          type: 'object',
          properties: { monetizationSummary: { type: 'string' } },
          required: ['monetizationSummary'],
        },
      ),
      node(
        'synthesize_revenue_insight',
        'ai_task',
        { monetizationSummary: nodeOutput('load_monetization_ledger', 'monetizationSummary') },
        {
          type: 'object',
          properties: { revenueInsight: { type: 'string' } },
          required: ['revenueInsight'],
        },
      ),
      terminalNode('record_revenue_report', {
        revenueInsight: nodeOutput('synthesize_revenue_insight', 'revenueInsight'),
      }),
    ],
    [
      successEdge('load_monetization_ledger', 'synthesize_revenue_insight'),
      successEdge('synthesize_revenue_insight', 'record_revenue_report'),
    ],
  ),

  // §3 "creator-manager task assignment"
  'creator-manager-task-assignment': linearTemplate(
    { clientId: { type: 'string' }, taskBacklogRef: { type: 'string' } },
    [
      node(
        'load_task_backlog',
        'function',
        { clientId: workflowInput('clientId'), taskBacklogRef: workflowInput('taskBacklogRef') },
        { type: 'object', properties: { taskBacklog: { type: 'array' } }, required: ['taskBacklog'] },
      ),
      humanTaskNode(
        'assign_creator_tasks',
        { taskBacklog: nodeOutput('load_task_backlog', 'taskBacklog') },
        {
          type: 'object',
          properties: { assignmentSheet: { type: 'array' } },
          required: ['assignmentSheet'],
        },
      ),
      terminalNode('record_assignments', {
        assignmentSheet: nodeOutput('assign_creator_tasks', 'assignmentSheet'),
      }),
    ],
    [
      successEdge('load_task_backlog', 'assign_creator_tasks'),
      successEdge('assign_creator_tasks', 'record_assignments'),
    ],
  ),

  // §3 "client/creator reporting and approvals"
  'creator-reporting-approvals': linearTemplate(
    { clientId: { type: 'string' }, reportPeriod: { type: 'string' } },
    [
      node(
        'collect_creator_metrics',
        'function',
        { clientId: workflowInput('clientId'), reportPeriod: workflowInput('reportPeriod') },
        { type: 'object', properties: { creatorReport: { type: 'string' } }, required: ['creatorReport'] },
      ),
      humanTaskNode(
        'approve_client_report',
        { creatorReport: nodeOutput('collect_creator_metrics', 'creatorReport') },
        {
          type: 'object',
          properties: { approvedReport: { type: 'string' } },
          required: ['approvedReport'],
        },
      ),
      terminalNode('release_report', {
        approvedReport: nodeOutput('approve_client_report', 'approvedReport'),
      }),
    ],
    [
      successEdge('collect_creator_metrics', 'approve_client_report'),
      successEdge('approve_client_report', 'release_report'),
    ],
  ),
};

// ---------------------------------------------------------------------------
// The frozen manifest
// ---------------------------------------------------------------------------

/**
 * The FROZEN Creator Operations Domain Pack manifest (version 1.0.0).
 * Immutable once published; semantic change requires a new version.
 */
export const CREATOR_OPERATIONS_PACK_MANIFEST: DomainPackManifest = {
  packKey: 'creator-operations',
  publisher: 'payswap-labs',
  version: '1.0.0',
  displayName: 'Creator Operations Pack',
  description:
    'Specializes MarketingOS for agencies managing creators, creator accounts, audience engagement, content, growth and monetization operations (creator-operations-v1.3.md) — a composition layer over the common authorities, never a parallel engine.',
  compatibility: { minPlatform: '1.3.0', maxPlatform: '1.9.0' },
  requiredPacks: [],
  artifacts: [
    // ----- §2 domain entities (pack-owned, Client-scoped) ----------------
    {
      kind: 'domain-entity',
      name: 'creator_profile',
      description:
        'The Creator Profile subject (§2): a Client-scoped creator identity with bounded niches/handle/bio. Append-only pack-owned rows (migration 031).',
      scope: 'client',
      payload: {
        subject: 'Creator Profile',
        storageTable: 'creator_profiles',
        keyField: 'profile_id',
        boundary: 'client-scoped pack-owned record; the Client is the hard security boundary',
        mutability: 'append-only (corrections append a new record)',
      },
    },
    {
      kind: 'domain-entity',
      name: 'creator_account',
      description:
        'The Creator Account subject (§2): one creator presence on a creator platform, as a provider-neutral platform LABEL (data, never provider coupling).',
      scope: 'client',
      payload: {
        subject: 'Creator Account',
        storageTable: 'creator_accounts',
        keyField: 'account_id',
        boundary: 'client-scoped pack-owned record; belongs to a same-Client Creator Profile',
        lifecycle: 'active ⇄ paused with terminal retire (born active)',
      },
    },
    {
      kind: 'domain-entity',
      name: 'creator_fan',
      description:
        'The Audience Member / Fan subject (§2): bounded declared audience data (alias + tier + tags) under a creator account — no raw PII blobs (§8).',
      scope: 'client',
      payload: {
        subject: 'Audience Member / Fan',
        storageTable: 'creator_fans',
        keyField: 'fan_id',
        boundary: 'client-scoped pack-owned record; belongs to a same-Client Creator Account',
        lifecycle: 'subscribed ⇄ churned with terminal remove (born subscribed)',
      },
    },
    {
      kind: 'domain-entity',
      name: 'creator_conversation',
      description:
        'The Conversation subject (§2): a provider-neutral channel conversation between a fan and a creator account; outbound messages are policy + human-approval gated side effects (§5).',
      scope: 'client',
      payload: {
        subject: 'Conversation',
        storageTable: 'creator_conversations',
        keyField: 'conversation_id',
        boundary: 'client-scoped pack-owned record; same-account fan + account chain',
        lifecycle: 'open ⇄ paused with terminal close (born open)',
      },
    },
    {
      kind: 'domain-entity',
      name: 'creator_content_asset',
      description:
        'The Content Asset subject (§2): planned creator content with provider-neutral platform labels; publication is the policy + human-approval gated side effect (§5).',
      scope: 'client',
      payload: {
        subject: 'Content Asset',
        storageTable: 'creator_content_assets',
        keyField: 'asset_id',
        boundary: 'client-scoped pack-owned record; belongs to a same-Client Creator Profile',
        lifecycle:
          'draft → in_review → approved → published (terminal) with terminal reject side-exits',
      },
    },
    {
      kind: 'domain-entity',
      name: 'creator_offer',
      description:
        'The Offer subject (§2): a provider-neutral monetization offer (kind + bounded price contract) under a creator profile.',
      scope: 'client',
      payload: {
        subject: 'Offer',
        storageTable: 'creator_offers',
        keyField: 'offer_id',
        boundary: 'client-scoped pack-owned record; belongs to a same-Client Creator Profile',
        lifecycle: 'draft → active ⇄ paused with terminal retire (born draft)',
      },
    },

    // ----- §2 domain views -----------------------------------------------
    {
      kind: 'view',
      name: 'audience_overview',
      description:
        'Audience overview view: fan cohort, tier mix and status counts of one creator account, derived live from the pack-owned subject records.',
      scope: 'client',
      payload: {
        projectionOf: ['creator_fans', 'creator_accounts'],
        shape: { fanCount: 'number', byTier: 'object', byStatus: 'object' },
      },
    },
    {
      kind: 'view',
      name: 'content_pipeline',
      description:
        'Content pipeline view: content assets by lifecycle state of one creator profile, derived live from the pack-owned subject records.',
      scope: 'client',
      payload: {
        projectionOf: ['creator_content_assets'],
        shape: { byStatus: 'object', publishReady: 'number' },
      },
    },

    // ----- §2 metric definitions (the CREATOR-AC-02 mapping targets) -----
    {
      kind: 'metric-definition',
      name: 'creator_operation_event_metrics',
      description:
        'The creator operation event-count metric family the pack maps into the COMMON /metrics ledger: audience, conversation, content and engagement event counts.',
      scope: 'client',
      payload: {
        authority: '/metrics',
        metricNames: [
          'creator.audience.event_count',
          'creator.conversation.event_count',
          'creator.content.event_count',
          'creator.engagement.event_count',
        ],
        unit: 'events',
        note: 'the pack owns the mapping; /metrics stays the only normalization authority',
      },
    },
    {
      kind: 'metric-definition',
      name: 'creator_performance_metrics',
      description:
        'The Creator Performance Metric subject (§2) as /metrics mapping targets: fan count, revenue totals, engagement counts, publish counts and response rates.',
      scope: 'client',
      payload: {
        authority: '/metrics',
        metricNames: [
          'creator.performance.fan_count',
          'creator.performance.revenue_total_cents',
          'creator.performance.engagement_count',
          'creator.performance.content_publish_count',
          'creator.performance.conversation_response_rate',
          'creator.monetization.revenue_cents',
        ],
        note: 'derived/aggregated performance measures; attribution must not be presented as causal lift without a qualifying design (§7)',
      },
    },

    // ----- §3 workflow templates (agency-reusable — §5) --------------------
    ...(Object.entries(CREATOR_WORKFLOW_TEMPLATES).map(([name, content]) => ({
      kind: 'workflow-template' as const,
      name,
      description: `The ${name.replace(/-/g, ' ')} operating workflow (§3) — an exact /workflows §4 definition content, executed ONLY through the existing Workflow/Execution authorities.`,
      scope: 'agency-reusable' as const,
      payload: content,
    }))),

    // ----- §5 AI capabilities (CREATOR-AC-03) -----------------------------
    ...(CREATOR_TASK_PROFILE_DECLARATIONS.map((declaration) => ({
      kind: 'ai-capability' as const,
      name: declaration.taskClass,
      description: `The ${declaration.taskClass} AI task class (§5) as an EXACT TaskProfile (§10) declaration — routed ONLY through the MarketingOS AI Router.`,
      scope: 'client' as const,
      payload: { ...declaration },
    }))),

    // ----- §4 human roles (CREATOR-AC-04) ---------------------------------
    {
      kind: 'human-capability',
      name: 'creator_manager',
      description:
        'The Creator Manager human role (§4) as a Human Agent specialization of the generic model — creator operations oversight, task assignment and reporting.',
      scope: 'client',
      payload: {
        model: 'generic-human-agent',
        specialization: 'creator_manager',
        executesThrough: '/jobs → Task projections of human_task nodes (JOB-AC-01)',
        typicalWorkflows: ['creator-manager-task-assignment', 'creator-reporting-approvals'],
      },
    },
    {
      kind: 'human-capability',
      name: 'chatter',
      description:
        'The Chatter human role (§4) as a Human Agent specialization — human chat operations on creator conversations (response drafting review and approved sends).',
      scope: 'client',
      payload: {
        model: 'generic-human-agent',
        specialization: 'chatter',
        executesThrough: '/jobs → Task projections of human_task nodes (JOB-AC-01)',
        typicalWorkflows: ['conversation-triage', 'human-chat-operations'],
      },
    },
    {
      kind: 'human-capability',
      name: 'content_manager',
      description:
        'The Content Manager human role (§4) as a Human Agent specialization — content planning, review and approval on the publish-gated lifecycle.',
      scope: 'client',
      payload: {
        model: 'generic-human-agent',
        specialization: 'content_manager',
        executesThrough: '/jobs → Task projections of human_task nodes (JOB-AC-01)',
        typicalWorkflows: ['content-planning'],
      },
    },
    {
      kind: 'human-capability',
      name: 'growth_manager',
      description:
        'The Growth Manager human role (§4) as a Human Agent specialization — growth experiments, audience segmentation review and fan reactivation.',
      scope: 'client',
      payload: {
        model: 'generic-human-agent',
        specialization: 'growth_manager',
        executesThrough: '/jobs → Task projections of human_task nodes (JOB-AC-01)',
        typicalWorkflows: ['growth-experiment', 'fan-reactivation', 'audience-segmentation'],
      },
    },
    {
      kind: 'human-capability',
      name: 'account_manager',
      description:
        'The Account Manager human role (§4) as a Human Agent specialization — creator account operations, offer testing and revenue analysis.',
      scope: 'client',
      payload: {
        model: 'generic-human-agent',
        specialization: 'account_manager',
        executesThrough: '/jobs → Task projections of human_task nodes (JOB-AC-01)',
        typicalWorkflows: ['offer-testing', 'revenue-analysis'],
      },
    },
    {
      kind: 'human-capability',
      name: 'reviewer',
      description:
        'The Reviewer human role (§4) as a Human Agent specialization — sensitive-action approval review (the CREATOR-AC-06 human approval gates).',
      scope: 'client',
      payload: {
        model: 'generic-human-agent',
        specialization: 'reviewer',
        executesThrough: '/jobs → Task projections of human_task nodes (JOB-AC-01); pack approval records carry the approver provenance',
        typicalWorkflows: ['creator-reporting-approvals'],
      },
    },

    // ----- §5 policy gate declarations (CREATOR-AC-06) --------------------
    {
      kind: 'policy',
      name: 'conversation_send_approval_gate',
      description:
        'The sensitive-action gate for outbound conversation sends (§5): a network-dimension policy rule set with the server-derived approvalStatus attribute; only an explicit allow permits, fail-closed otherwise.',
      scope: 'client',
      payload: {
        authority: '/policies',
        dimension: 'network',
        operations: ['creator.conversation.send'],
        approvalAttribute: 'approvalStatus',
        approvalValues: ['approved', 'missing'],
        enforcement: "fail-closed (deny AND unknown both deny — only an explicit 'allow' permits)",
        configuration:
          'an allow rule with approvalStatus=approved demands a pack approval record; one with approvalStatus=missing allows direct sends; deny rules veto; no matching rule fails closed',
      },
    },
    {
      kind: 'policy',
      name: 'content_publish_approval_gate',
      description:
        'The sensitive-action gate for content publication (§5): the network-dimension counterpart of the send gate for the publish side effect.',
      scope: 'client',
      payload: {
        authority: '/policies',
        dimension: 'network',
        operations: ['creator.content.publish'],
        approvalAttribute: 'approvalStatus',
        approvalValues: ['approved', 'missing'],
        enforcement: "fail-closed (deny AND unknown both deny — only an explicit 'allow' permits)",
        configuration:
          'an allow rule with approvalStatus=approved demands a pack approval record; one with approvalStatus=missing allows direct publishes; deny rules veto; no matching rule fails closed',
      },
    },

    // ----- §6 integration bindings (CREATOR-AC-05) ------------------------
    {
      kind: 'integration-binding',
      name: 'read_creator_account_metrics',
      description: 'Normalized capability (§6): read creator/account metrics from creator platforms behind the Integration/Extension boundaries.',
      scope: 'client',
      payload: { capability: 'read creator/account metrics', direction: 'inbound', boundary: '/integrations | /extensions' },
    },
    {
      kind: 'integration-binding',
      name: 'read_audience_fan_records',
      description: 'Normalized capability (§6): read audience/fan records behind the Integration/Extension boundaries.',
      scope: 'client',
      payload: { capability: 'read audience/fan records', direction: 'inbound', boundary: '/integrations | /extensions' },
    },
    {
      kind: 'integration-binding',
      name: 'read_conversations_events',
      description: 'Normalized capability (§6): read conversations/events behind the Integration/Extension boundaries.',
      scope: 'client',
      payload: { capability: 'read conversations/events', direction: 'inbound', boundary: '/integrations | /extensions' },
    },
    {
      kind: 'integration-binding',
      name: 'send_approved_communication',
      description:
        'Normalized capability (§6): send an APPROVED communication — the outbound side effect only after the policy + human approval gate (§5).',
      scope: 'client',
      payload: { capability: 'send an approved communication', direction: 'outbound', boundary: '/integrations | /extensions', gate: 'creator.conversation.send' },
    },
    {
      kind: 'integration-binding',
      name: 'publish_approved_content',
      description:
        'Normalized capability (§6): publish APPROVED content — the publish side effect only after the policy + human approval gate (§5).',
      scope: 'client',
      payload: { capability: 'publish approved content', direction: 'outbound', boundary: '/integrations | /extensions', gate: 'creator.content.publish' },
    },
    {
      kind: 'integration-binding',
      name: 'read_monetization_observations',
      description: 'Normalized capability (§6): read monetization/transaction observations behind the Integration/Extension boundaries.',
      scope: 'client',
      payload: { capability: 'read monetization/transaction observations', direction: 'inbound', boundary: '/integrations | /extensions' },
    },
    {
      kind: 'integration-binding',
      name: 'receive_provider_events',
      description: 'Normalized capability (§6): receive provider events/webhooks through the Integration/Extension ingestion ledgers.',
      scope: 'client',
      payload: { capability: 'receive provider events/webhooks', direction: 'inbound', boundary: '/integrations | /extensions' },
    },

    // ----- §7 evidence schemas (CREATOR-AC-02) -----------------------------
    {
      kind: 'evidence-schema',
      name: 'audience_observation_evidence',
      description: 'The §7 audience/fan observation evidence content schema (class: observation, source: creator-operations).',
      scope: 'client',
      payload: {
        evidenceClass: 'observation',
        sourceSystem: 'creator-operations',
        contentSchema: {
          type: 'object',
          properties: {
            subjectKind: { type: 'string' },
            subjectRef: { type: 'string' },
            eventKind: { type: 'string' },
          },
          required: ['subjectKind', 'eventKind'],
        },
      },
    },
    {
      kind: 'evidence-schema',
      name: 'conversation_interaction_evidence',
      description: 'The §7 conversation observation evidence content schema — human interaction records (class: observation).',
      scope: 'client',
      payload: {
        evidenceClass: 'observation',
        sourceSystem: 'creator-operations',
        contentSchema: {
          type: 'object',
          properties: {
            subjectKind: { type: 'string' },
            subjectRef: { type: 'string' },
            eventKind: { type: 'string' },
            direction: { type: 'string' },
          },
          required: ['subjectKind', 'eventKind'],
        },
      },
    },
    {
      kind: 'evidence-schema',
      name: 'content_event_evidence',
      description: 'The §7 content observation evidence content schema — content lifecycle events (class: observation).',
      scope: 'client',
      payload: {
        evidenceClass: 'observation',
        sourceSystem: 'creator-operations',
        contentSchema: {
          type: 'object',
          properties: {
            subjectKind: { type: 'string' },
            subjectRef: { type: 'string' },
            eventKind: { type: 'string' },
          },
          required: ['subjectKind', 'eventKind'],
        },
      },
    },
    {
      kind: 'evidence-schema',
      name: 'engagement_event_evidence',
      description: 'The §7 engagement observation evidence content schema (class: observation).',
      scope: 'client',
      payload: {
        evidenceClass: 'observation',
        sourceSystem: 'creator-operations',
        contentSchema: {
          type: 'object',
          properties: {
            subjectKind: { type: 'string' },
            subjectRef: { type: 'string' },
            eventKind: { type: 'string' },
            engagementKind: { type: 'string' },
          },
          required: ['subjectKind', 'eventKind'],
        },
      },
    },
    {
      kind: 'evidence-schema',
      name: 'monetization_event_evidence',
      description: 'The §7 monetization/transaction observation evidence content schema (class: observation).',
      scope: 'client',
      payload: {
        evidenceClass: 'observation',
        sourceSystem: 'creator-operations',
        contentSchema: {
          type: 'object',
          properties: {
            subjectKind: { type: 'string' },
            subjectRef: { type: 'string' },
            eventKind: { type: 'string' },
            amountCents: { type: 'number' },
            currency: { type: 'string' },
          },
          required: ['subjectKind', 'eventKind'],
        },
      },
    },
  ],
};

/**
 * The frozen human specializations this pack consumes (a local mirror of
 * the /field-agents registry — tests pin the sync). Exported for the
 * provisioning surface and tests.
 */
export const CREATOR_PACK_SPECIALIZATIONS: readonly string[] = [
  ...CREATOR_HUMAN_SPECIALIZATION_MIRROR,
];
