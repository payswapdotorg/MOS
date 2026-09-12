/**
 * MKT-037 unit tests — the Creator Operations Domain Pack contract as PURE
 * functions (spec/creator-operations-v1.3.md FROZEN; spec/
 * domain-pack-v1.3.md §2–§5; spec/requirements-v1.3.md CREATOR-AC-01..06).
 *
 * Acceptance mapping:
 *   - the frozen LIFECYCLE tables (migration 031) edge for edge — account,
 *     fan, conversation, content and offer transitions with their terminal
 *     states;
 *   - the CREATOR-AC-06 fail-closed enforcement predicate: only an
 *     explicit 'allow' permits (deny AND unknown both deny — the POL-001
 *     mirror);
 *   - the input GUARDS: subject/observation/approval/provenance shape
 *     rejection, the closed vocabularies (tiers, channels, kinds, metric
 *     names, gate operations, Human Agent specializations) and the §21
 *     material-key backstop at every nesting level;
 *   - the FROZEN MANIFEST: it passes the /domain-packs framework's OWN
 *     manifest guard (§2 closed kinds, §5 closed scopes, unique (kind,
 *     name) identities, §21 backstop, §4 workflow-template conformance
 *     through the /workflows authority's own validator — the strongest
 *     publish-time proof);
 *   - §3 COVERAGE: every operating workflow of creator-operations-v1.3.md
 *     §3 has a template, and every template payload passes the /workflows
 *     §4 definition-content validator;
 *   - CREATOR-AC-03 (unit half): the AI task declarations are EXACTLY the
 *     eleven §10 TaskProfile fields with risk/privacy classes inside the
 *     frozen /ai-runtime vocabularies — provider/model names appear ONLY
 *     as bounded label data;
 *   - CREATOR-AC-04 (unit half): the human roles are specializations of
 *     the GENERIC /field-agents registry (the local mirror is pinned
 *     against the real frozen registry — the /jobs precedent).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertValidDomainPackManifest,
  CREATOR_ACCOUNT_STATUSES,
  CREATOR_ACCOUNT_TERMINAL_STATUSES,
  CREATOR_ACCOUNT_TRANSITIONS,
  CREATOR_CONTENT_STATUSES,
  CREATOR_CONTENT_TERMINAL_STATUSES,
  CREATOR_CONTENT_TRANSITIONS,
  CREATOR_CONVERSATION_STATUSES,
  CREATOR_CONVERSATION_TERMINAL_STATUSES,
  CREATOR_CONVERSATION_TRANSITIONS,
  CREATOR_FAN_STATUSES,
  CREATOR_FAN_TERMINAL_STATUSES,
  CREATOR_FAN_TRANSITIONS,
  CREATOR_FAN_TIERS,
  CREATOR_GATE_OPERATIONS,
  CREATOR_HUMAN_SPECIALIZATION_MIRROR,
  CREATOR_METRIC_NAMES,
  CREATOR_OBSERVATION_SUBJECT_KINDS,
  CREATOR_OFFER_STATUSES,
  CREATOR_OFFER_TERMINAL_STATUSES,
  CREATOR_OFFER_TRANSITIONS,
  CREATOR_OPERATIONS_PACK_MANIFEST,
  CREATOR_ROLE_SPECIALIZATIONS,
  CREATOR_TASK_PROFILE_DECLARATIONS,
  CREATOR_WORKFLOW_TEMPLATES,
  creatorEnforcementOutcome,
  creatorPayloadHasNoMaterialKeys,
  isLegalCreatorAccountTransition,
  isLegalCreatorContentTransition,
  isLegalCreatorConversationTransition,
  isLegalCreatorFanTransition,
  isLegalCreatorOfferTransition,
  assertValidCreatorApprovalInput,
  assertValidCreatorContentTransitionInput,
  assertValidCreatorFanInput,
  assertValidCreatorObservationInput,
  assertValidCreatorProfileInput,
  assertValidCreatorProvenance,
} from '../../src/modules/domain-packs/public.ts';
import { validateWorkflowDefinitionContent } from '../../src/modules/workflows/public.ts';
import {
  TASK_PROFILE_CONTRACT_FIELDS,
  TASK_PROFILE_PRIVACY_CLASSES,
  TASK_PROFILE_RISK_CLASSES,
} from '../../src/modules/ai-runtime/public.ts';
import { HUMAN_SPECIALIZATIONS } from '../../src/modules/field-agents/public.ts';

// ---------------------------------------------------------------------------
// The frozen lifecycle tables (migration 031)
// ---------------------------------------------------------------------------

test('the frozen creator lifecycle tables match migration 031 edge for edge', () => {
  assert.deepEqual(CREATOR_ACCOUNT_STATUSES, ['active', 'paused', 'retired']);
  assert.deepEqual(CREATOR_ACCOUNT_TRANSITIONS, {
    active: ['paused', 'retired'],
    paused: ['active', 'retired'],
    retired: [],
  });
  assert.deepEqual(CREATOR_ACCOUNT_TERMINAL_STATUSES, ['retired']);
  assert.deepEqual(CREATOR_FAN_STATUSES, ['subscribed', 'churned', 'removed']);
  assert.deepEqual(CREATOR_FAN_TRANSITIONS, {
    subscribed: ['churned', 'removed'],
    churned: ['subscribed', 'removed'],
    removed: [],
  });
  assert.deepEqual(CREATOR_FAN_TERMINAL_STATUSES, ['removed']);
  assert.deepEqual(CREATOR_CONVERSATION_STATUSES, ['open', 'paused', 'closed']);
  assert.deepEqual(CREATOR_CONVERSATION_TRANSITIONS, {
    open: ['paused', 'closed'],
    paused: ['open', 'closed'],
    closed: [],
  });
  assert.deepEqual(CREATOR_CONVERSATION_TERMINAL_STATUSES, ['closed']);
  assert.deepEqual(CREATOR_CONTENT_STATUSES, [
    'draft',
    'in_review',
    'approved',
    'published',
    'rejected',
  ]);
  assert.deepEqual(CREATOR_CONTENT_TRANSITIONS, {
    draft: ['in_review', 'rejected'],
    in_review: ['approved', 'rejected'],
    approved: ['published', 'rejected'],
    published: [],
    rejected: [],
  });
  assert.deepEqual(CREATOR_CONTENT_TERMINAL_STATUSES, ['published', 'rejected']);
  assert.deepEqual(CREATOR_OFFER_STATUSES, ['draft', 'active', 'paused', 'retired']);
  assert.deepEqual(CREATOR_OFFER_TRANSITIONS, {
    draft: ['active', 'retired'],
    active: ['paused', 'retired'],
    paused: ['active', 'retired'],
    retired: [],
  });
  assert.deepEqual(CREATOR_OFFER_TERMINAL_STATUSES, ['retired']);
});

test('the lifecycle predicates accept exactly the frozen edges and reject everything else', () => {
  for (const from of CREATOR_ACCOUNT_STATUSES) {
    for (const to of CREATOR_ACCOUNT_STATUSES) {
      assert.equal(
        isLegalCreatorAccountTransition(from, to),
        CREATOR_ACCOUNT_TRANSITIONS[from].includes(to),
        `account ${from} → ${to}`,
      );
    }
  }
  assert.equal(isLegalCreatorAccountTransition('active', 'active'), false);
  assert.equal(isLegalCreatorFanTransition('subscribed', 'subscribed'), false);
  assert.equal(isLegalCreatorFanTransition('removed', 'subscribed'), false);
  assert.equal(isLegalCreatorConversationTransition('closed', 'open'), false);
  assert.equal(isLegalCreatorContentTransition('draft', 'published'), false);
  assert.equal(isLegalCreatorContentTransition('published', 'draft'), false);
  assert.equal(isLegalCreatorOfferTransition('draft', 'paused'), false);
  assert.equal(isLegalCreatorOfferTransition('retired', 'active'), false);
});

// ---------------------------------------------------------------------------
// The CREATOR-AC-06 fail-closed enforcement predicate
// ---------------------------------------------------------------------------

test('the gate enforcement predicate is fail-closed: only an explicit allow permits', () => {
  assert.equal(creatorEnforcementOutcome({ outcome: 'allow' }), 'allow');
  assert.equal(creatorEnforcementOutcome({ outcome: 'deny' }), 'deny');
  assert.equal(creatorEnforcementOutcome({ outcome: 'unknown' }), 'deny');
});

// ---------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------

test('the closed subject vocabularies match the migration-031 CHECKs', () => {
  assert.deepEqual(CREATOR_FAN_TIERS, ['standard', 'vip', 'top_fan', 'new_fan']);
  assert.deepEqual(CREATOR_OBSERVATION_SUBJECT_KINDS, [
    'audience',
    'conversation',
    'content',
    'engagement',
    'monetization',
    'performance',
  ]);
  assert.deepEqual(CREATOR_GATE_OPERATIONS, [
    'creator.conversation.send',
    'creator.content.publish',
  ]);
  // The metric-name vocabulary is the frozen CREATOR-AC-02 mapping target set.
  for (const name of CREATOR_METRIC_NAMES) {
    assert.match(name, /^creator\.[a-z_]+(\.[a-z_]+)?$/);
  }
  assert.ok(CREATOR_METRIC_NAMES.includes('creator.engagement.event_count'));
  assert.ok(CREATOR_METRIC_NAMES.includes('creator.monetization.revenue_cents'));
  assert.ok(CREATOR_METRIC_NAMES.includes('creator.performance.fan_count'));
});

// ---------------------------------------------------------------------------
// The §21 material-key backstop (guards)
// ---------------------------------------------------------------------------

test('the material-key walker rejects material-shaped keys at every nesting level', () => {
  assert.equal(creatorPayloadHasNoMaterialKeys({}), true);
  assert.equal(creatorPayloadHasNoMaterialKeys({ safe: { nested: [1, 'x'] } }), true);
  assert.equal(creatorPayloadHasNoMaterialKeys({ secret: 'x' }), false);
  assert.equal(creatorPayloadHasNoMaterialKeys({ safe: { nested: [{ apiKey: 1 }] } }), false);
  assert.equal(creatorPayloadHasNoMaterialKeys([{ token: 'y' }]), false);
  assert.equal(creatorPayloadHasNoMaterialKeys({ safe: { deep: { deep: { secretHandle: null } } } }), false);
});

// ---------------------------------------------------------------------------
// The input guards
// ---------------------------------------------------------------------------

const UUID = '01234567-89ab-cdef-0123-456789abcdef';

test('the profile guard accepts the frozen shape and rejects violations', () => {
  assert.doesNotThrow(() =>
    assertValidCreatorProfileInput({
      clientId: UUID,
      displayName: 'Ava Creator',
      handle: 'ava-creator',
      niches: ['fitness'],
      bio: 'bio',
      attributes: {},
      idempotencyKey: 'profile-key-1',
    }),
  );
  assert.throws(() =>
    assertValidCreatorProfileInput({
      clientId: 'not-a-uuid',
      displayName: '',
      handle: 'BAD HANDLE',
      niches: 'nope',
      bio: 'x',
      attributes: null,
      idempotencyKey: '',
    }),
  );
  // §21: material-shaped keys inside attributes are rejected.
  assert.throws(() =>
    assertValidCreatorProfileInput({
      clientId: UUID,
      displayName: 'Ava Creator',
      handle: 'ava-creator',
      niches: [],
      bio: '',
      attributes: { nested: { secret: 'x' } },
      idempotencyKey: 'profile-key-2',
    }),
  );
});

test('the fan guard enforces the closed tier vocabulary', () => {
  assert.doesNotThrow(() =>
    assertValidCreatorFanInput({
      accountId: UUID,
      fanAlias: 'fan-1',
      tier: 'vip',
      tags: [],
      attributes: {},
      idempotencyKey: 'fan-key-1',
    }),
  );
  assert.throws(() =>
    assertValidCreatorFanInput({
      accountId: UUID,
      fanAlias: 'fan-1',
      tier: 'platinum',
      tags: [],
      attributes: {},
      idempotencyKey: 'fan-key-2',
    }),
  );
});

test('the approval guard enforces the closed gate-operation and specialization vocabularies', () => {
  assert.doesNotThrow(() =>
    assertValidCreatorApprovalInput({
      clientId: UUID,
      action: 'creator.conversation.send',
      resourceId: UUID,
      decision: 'approved',
      approverUserId: UUID,
      approverSpecializations: ['reviewer'],
      notes: '',
      idempotencyKey: 'approval-key-1',
    }),
  );
  assert.throws(() =>
    assertValidCreatorApprovalInput({
      clientId: UUID,
      action: 'creator.dm.blast',
      resourceId: UUID,
      decision: 'approved',
      approverUserId: UUID,
      approverSpecializations: [],
      notes: '',
      idempotencyKey: 'approval-key-2',
    }),
  );
  assert.throws(() =>
    assertValidCreatorApprovalInput({
      clientId: UUID,
      action: 'creator.conversation.send',
      resourceId: UUID,
      decision: 'maybe',
      approverUserId: UUID,
      approverSpecializations: ['not_a_specialization'],
      notes: '',
      idempotencyKey: 'approval-key-3',
    }),
  );
});

test('the content transition guard enforces the CREATOR-AC-06 provenance contract', () => {
  const provenance = {
    actor: 'user:uuid',
    recordedVia: 'api',
    correlationId: 'corr-1',
    causationId: null,
  };
  // The published edge REQUIRES provenance (the gated side effect).
  assert.throws(() =>
    assertValidCreatorContentTransitionInput({
      assetId: UUID,
      status: 'published',
      expectedVersion: 2,
      approvalId: null,
      provenance: null,
    }),
  );
  assert.doesNotThrow(() =>
    assertValidCreatorContentTransitionInput({
      assetId: UUID,
      status: 'published',
      expectedVersion: 2,
      approvalId: null,
      provenance,
    }),
  );
  // Non-published edges carry NO provenance and NO approval.
  assert.throws(() =>
    assertValidCreatorContentTransitionInput({
      assetId: UUID,
      status: 'in_review',
      expectedVersion: 2,
      approvalId: UUID,
      provenance,
    }),
  );
  assert.doesNotThrow(() =>
    assertValidCreatorContentTransitionInput({
      assetId: UUID,
      status: 'in_review',
      expectedVersion: 2,
      approvalId: null,
      provenance: null,
    }),
  );
});

test('the observation guard enforces the closed mapping vocabulary', () => {
  assert.doesNotThrow(() =>
    assertValidCreatorObservationInput({
      clientId: UUID,
      workspaceId: null,
      subjectKind: 'engagement',
      subjectRef: UUID,
      eventKind: 'tip_received',
      content: { engagementKind: 'tip' },
      observedAt: '2026-01-01T00:00:00.000Z',
      quality: 'C',
      metric: {
        name: 'creator.engagement.event_count',
        value: 1,
        unit: 'events',
        dimensions: { accountId: UUID },
        aggregationMethod: null,
      },
      idempotencyKey: 'obs-key-1',
    }),
  );
  // Unknown metric name rejected (the mapping targets are frozen).
  assert.throws(() =>
    assertValidCreatorObservationInput({
      clientId: UUID,
      workspaceId: null,
      subjectKind: 'engagement',
      subjectRef: null,
      eventKind: 'tip_received',
      content: {},
      observedAt: '2026-01-01T00:00:00.000Z',
      quality: 'C',
      metric: {
        name: 'creator.engagement.tip_total',
        value: 1,
        unit: 'events',
        dimensions: {},
        aggregationMethod: null,
      },
      idempotencyKey: 'obs-key-2',
    }),
  );
  // Unknown subject kind rejected.
  assert.throws(() =>
    assertValidCreatorObservationInput({
      clientId: UUID,
      workspaceId: null,
      subjectKind: 'other',
      subjectRef: null,
      eventKind: 'tip_received',
      content: {},
      observedAt: '2026-01-01T00:00:00.000Z',
      quality: 'C',
      metric: null,
      idempotencyKey: 'obs-key-3',
    }),
  );
  // Malformed quality rejected (the closed A..F grades).
  assert.throws(() =>
    assertValidCreatorObservationInput({
      clientId: UUID,
      workspaceId: null,
      subjectKind: 'engagement',
      subjectRef: null,
      eventKind: 'tip_received',
      content: {},
      observedAt: '2026-01-01T00:00:00.000Z',
      quality: 'G',
      metric: null,
      idempotencyKey: 'obs-key-4',
    }),
  );
});

test('the provenance guard validates the server-derived shape', () => {
  assert.doesNotThrow(() =>
    assertValidCreatorProvenance({
      actor: 'user:uuid',
      recordedVia: 'api',
      correlationId: 'corr-1',
      causationId: null,
    }),
  );
  assert.throws(() =>
    assertValidCreatorProvenance({
      actor: '',
      recordedVia: 'api',
      correlationId: 'corr-1',
      causationId: null,
    }),
  );
});

// ---------------------------------------------------------------------------
// The frozen manifest (the strongest publish-time proof)
// ---------------------------------------------------------------------------

test('the frozen Creator Operations manifest passes the /domain-packs framework manifest guard', () => {
  // This runs the FULL publish-time contract: the closed 14-kind artifact
  // vocabulary, the closed §5 scope vocabulary, unique (kind, name)
  // identities, the §21 material-key backstop at every nesting level, the
  // manifest bounds, and §4 WORKFLOW-TEMPLATE CONFORMANCE through the
  // /workflows authority's own validator.
  assert.doesNotThrow(() => assertValidDomainPackManifest(CREATOR_OPERATIONS_PACK_MANIFEST));
});

test('the manifest identity and artifact inventory match the frozen pack contract', () => {
  assert.equal(CREATOR_OPERATIONS_PACK_MANIFEST.packKey, 'creator-operations');
  assert.equal(CREATOR_OPERATIONS_PACK_MANIFEST.publisher, 'payswap-labs');
  assert.equal(CREATOR_OPERATIONS_PACK_MANIFEST.version, '1.0.0');
  assert.deepEqual(CREATOR_OPERATIONS_PACK_MANIFEST.requiredPacks, []);

  const byKind = new Map<string, number>();
  for (const artifact of CREATOR_OPERATIONS_PACK_MANIFEST.artifacts) {
    byKind.set(artifact.kind, (byKind.get(artifact.kind) ?? 0) + 1);
  }
  assert.equal(byKind.get('domain-entity'), 6, 'the six §2 subject entities');
  assert.equal(byKind.get('view'), 2);
  assert.equal(byKind.get('workflow-template'), 10, 'the ten §3 operating workflows');
  assert.equal(byKind.get('ai-capability'), 7, 'the seven §5 AI task classes');
  assert.equal(byKind.get('human-capability'), 6, 'the six §4 human roles');
  assert.equal(byKind.get('policy'), 2, 'the two CREATOR-AC-06 approval gates');
  assert.equal(byKind.get('integration-binding'), 7, 'the seven §6 normalized capabilities');
  assert.equal(byKind.get('evidence-schema'), 5, 'the five §7 observation schemas');
  assert.equal(byKind.get('metric-definition'), 2);
  assert.equal(CREATOR_OPERATIONS_PACK_MANIFEST.artifacts.length, 47);

  // §5: workflow templates are the Agency-scoped REUSABLE artifacts; the
  // subject surface is Client-scoped pack-owned data.
  for (const artifact of CREATOR_OPERATIONS_PACK_MANIFEST.artifacts) {
    if (artifact.kind === 'workflow-template') {
      assert.equal(artifact.scope, 'agency-reusable');
    } else {
      assert.equal(artifact.scope, 'client');
    }
  }
});

// ---------------------------------------------------------------------------
// §3 workflow-template coverage + §4 definition-content conformance
// ---------------------------------------------------------------------------

test('every §3 operating workflow has a template conforming to the /workflows §4 validator', () => {
  const expectedTemplates = [
    'audience-segmentation',
    'conversation-triage',
    'human-chat-operations',
    'content-planning',
    'growth-experiment',
    'fan-reactivation',
    'offer-testing',
    'revenue-analysis',
    'creator-manager-task-assignment',
    'creator-reporting-approvals',
  ];
  assert.deepEqual(
    Object.keys(CREATOR_WORKFLOW_TEMPLATES).sort(),
    [...expectedTemplates].sort(),
  );
  for (const [name, content] of Object.entries(CREATOR_WORKFLOW_TEMPLATES)) {
    const problems = validateWorkflowDefinitionContent(content);
    assert.deepEqual(problems, [], `template '${name}' must conform to the §4 contract`);
  }
});

test('every human_task template node declares the mandatory human approval requirement', () => {
  let humanTaskNodes = 0;
  for (const content of Object.values(CREATOR_WORKFLOW_TEMPLATES)) {
    const nodes = (content as { graph: { nodes: Record<string, unknown>[] } }).graph.nodes;
    for (const node of nodes) {
      if (node['nodeType'] === 'human_task') {
        humanTaskNodes += 1;
        assert.deepEqual(node['humanApproval'], { required: true, approverPolicyRef: null });
      } else {
        assert.equal(node['humanApproval'], null);
      }
    }
  }
  // Human steps exist in the governed workflows (§3 chat/planning/
  // assignment/approval flows).
  assert.ok(humanTaskNodes >= 7);
});

// ---------------------------------------------------------------------------
// CREATOR-AC-03 (unit half) — the TaskProfile declarations
// ---------------------------------------------------------------------------

test('the AI task declarations are EXACTLY the eleven §10 TaskProfile contract fields', () => {
  assert.equal(CREATOR_TASK_PROFILE_DECLARATIONS.length, 7);
  for (const declaration of CREATOR_TASK_PROFILE_DECLARATIONS) {
    assert.deepEqual(
      Object.keys(declaration).sort(),
      [...TASK_PROFILE_CONTRACT_FIELDS].sort(),
    );
    assert.ok((TASK_PROFILE_RISK_CLASSES as readonly string[]).includes(declaration.riskClass));
    assert.ok(
      (TASK_PROFILE_PRIVACY_CLASSES as readonly string[]).includes(declaration.privacyClass),
    );
    assert.ok(Number.isSafeInteger(declaration.latencyTargetMs));
    assert.ok(declaration.maxCostPerInvocation >= 0);
  }
  // The §5 task-class enumeration: classification, retrieval/synthesis,
  // response drafting, content generation, conversation summarization,
  // segmentation, recommendation.
  const taskClasses = CREATOR_TASK_PROFILE_DECLARATIONS.map((d) => d.taskClass).sort();
  assert.deepEqual(taskClasses, [
    'creator.classification',
    'creator.content_generation',
    'creator.conversation_summarization',
    'creator.recommendation',
    'creator.response_drafting',
    'creator.retrieval_synthesis',
    'creator.segmentation',
  ]);
});

// ---------------------------------------------------------------------------
// CREATOR-AC-04 (unit half) — the human-role specializations
// ---------------------------------------------------------------------------

test('the human specializations mirror the frozen /field-agents registry and cover the §4 roles', () => {
  // The local mirror is pinned against the REAL frozen registry (the /jobs
  // precedent — patterns stay in sync).
  assert.deepEqual([...CREATOR_HUMAN_SPECIALIZATION_MIRROR], [...HUMAN_SPECIALIZATIONS]);
  // §4 roles: Creator Manager, Chatter, Content Manager, Growth Manager,
  // Account Manager, Reviewer.
  assert.deepEqual([...CREATOR_ROLE_SPECIALIZATIONS].sort(), [
    'account_manager',
    'chatter',
    'content_manager',
    'creator_manager',
    'growth_manager',
    'reviewer',
  ]);
  // The manifest human-capability artifacts are exactly these roles as
  // GENERIC Human Agent specializations (never a second execution model).
  const humanArtifacts = CREATOR_OPERATIONS_PACK_MANIFEST.artifacts.filter(
    (artifact) => artifact.kind === 'human-capability',
  );
  assert.deepEqual(
    humanArtifacts
      .map((artifact) => (artifact.payload as { specialization: string }).specialization)
      .sort(),
    [...CREATOR_ROLE_SPECIALIZATIONS].sort(),
  );
});

// ---------------------------------------------------------------------------
// CREATOR-AC-05 (unit half) — provider neutrality of the manifest payloads
// ---------------------------------------------------------------------------

test('the manifest payloads are provider-neutral data — no SDK/provider coupling anywhere', () => {
  const serialized = JSON.stringify(CREATOR_OPERATIONS_PACK_MANIFEST);
  for (const forbidden of [
    'openai',
    'anthropic',
    'onlyfans',
    'fansly',
    'instagram',
    'tiktok',
    'youtube',
    'sdk',
    'sdkPackage',
    'clientLibrary',
    'adapterConfig',
    'credential',
    'apiKey',
    'secret',
    'password',
    'browser',
    'scrape',
    'crawl',
  ]) {
    assert.ok(
      !serialized.toLowerCase().includes(forbidden.toLowerCase()),
      `the frozen manifest must not mention '${forbidden}'`,
    );
  }
});
