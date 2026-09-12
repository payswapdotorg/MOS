/**
 * MKT-040 unit tests — the pure /deployments contract surfaces (DEPLOY-002):
 * the frozen lifecycle transition table, the version-constraint matcher,
 * the creation/selection/transition/provenance input guards (the §21
 * secret-leak backstop + the DEPLOY-AC-09 closed runtime shape), and the
 * PURE resolution evaluator (the DEPLOY-AC-04 core: every named check
 * honestly recorded, fail-closed composition).
 *
 * Acceptance mapping (work-items.md MKT-040 acceptance: the pure half; the
 * architecture file carries the static isolation proofs, the integration
 * file carries the behavioral ones).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEPLOYMENT_CHECK_NAMES,
  DEPLOYMENT_EVENT_TYPES,
  DEPLOYMENT_RUNTIME_CLASSES,
  DEPLOYMENT_STATUSES,
  DEPLOYMENT_TRANSITIONS,
  assertValidDeploymentCreation,
  assertValidProvenance,
  assertValidRedeploySelection,
  assertValidTransitionRequest,
  containsMaterialShapedKey,
  evaluateDeploymentResolution,
  isLegalDeploymentTransition,
  satisfiesVersionConstraint,
  type DeploymentSelection,
  type DeploymentsWorkspaceOwnershipSnapshot,
  type DeploymentResolutionSnapshots,
} from '../../src/modules/deployments/public.ts';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';

function validSelection(overrides: Partial<DeploymentSelection> = {}): DeploymentSelection {
  return {
    playbookVersionId: UUID_A,
    workflowDefinitionIds: [UUID_B],
    requiredDomainPacks: [{ name: 'creator-operations', versionConstraint: '^1.0.0' }],
    requiredCapabilities: [
      { kind: 'extension', name: 'email-composer', versionConstraint: '^2.0.0' },
      { kind: 'integration', name: 'meta-ads', versionConstraint: null },
    ],
    runtimeRequirements: { runtimeClass: 'pooled-worker' },
    triggerConfig: [
      { kind: 'manual', config: null },
      { kind: 'schedule', config: { cron: '0 9 * * *' } },
    ],
    ...overrides,
  };
}

function validOwnership(): DeploymentsWorkspaceOwnershipSnapshot {
  return {
    scope: { kind: 'workspace', agencyId: UUID_A, clientId: UUID_B, workspaceId: UUID_C },
    workspace: { workspaceId: UUID_C, clientId: UUID_B, status: 'active' },
    client: { clientId: UUID_B, agencyId: UUID_A, status: 'active' },
    clientOwnership: { agency: { agencyId: UUID_A, status: 'active' } },
  };
}

function validProvenance() {
  return {
    actor: 'user:1',
    recordedVia: 'api',
    correlationId: 'corr-1',
    causationId: null,
  };
}

/** The all-green snapshots fixture (every dependency available). */
function greenSnapshots(): DeploymentResolutionSnapshots {
  return {
    workspaceOwnership: validOwnership(),
    playbookVersion: { versionId: UUID_A, playbookId: UUID_B, status: 'published' },
    playbook: { playbookId: UUID_B, agencyId: UUID_A, clientId: null },
    workflowDefinitions: [
      {
        definition: {
          workflowDefinitionId: UUID_B,
          workflowId: UUID_C,
          status: 'active',
          playbookVersionId: UUID_A,
        },
        workflow: { workflowId: UUID_C, workspaceId: UUID_C },
      },
    ],
    packInstalls: [{ installId: UUID_A, packId: UUID_B, status: 'installed' }],
    packVersions: new Map([[UUID_B, { packId: UUID_B, packKey: 'creator-operations', version: '1.2.0' }]]),
    extensionInstalls: [
      {
        installId: UUID_A,
        extensionId: UUID_C,
        status: 'authorized',
        secretBindings: { emailApiKey: UUID_A },
      },
    ],
    extensionVersions: new Map([
      [UUID_C, { extensionId: UUID_C, extensionKey: 'email-composer', version: '2.1.0' }],
    ]),
    adapters: [{ adapterKey: 'meta-ads' }],
    connections: [
      {
        connectionId: UUID_B,
        clientId: UUID_B,
        adapterKey: 'meta-ads',
        status: 'connected',
        credentialReferenceId: UUID_B,
      },
    ],
    credentials: new Map([
      [UUID_A, { credentialId: UUID_A, agencyId: UUID_A, clientId: null, status: 'active' }],
      [UUID_B, { credentialId: UUID_B, agencyId: UUID_A, clientId: UUID_B, status: 'active' }],
    ]),
    policyDecision: { decisionId: UUID_A, outcome: 'allow' },
  };
}

const SCOPE = { agencyId: UUID_A, clientId: UUID_B, workspaceId: UUID_C };

// ---------------------------------------------------------------------------
// The frozen lifecycle table
// ---------------------------------------------------------------------------

test('DEPLOY-AC-05 unit: the frozen lifecycle table is exactly the drawn contract', () => {
  assert.deepEqual(DEPLOYMENT_TRANSITIONS, {
    draft: ['validating'],
    validating: ['ready'],
    ready: ['active', 'blocked'],
    active: ['paused', 'disabled', 'redeploying', 'rolling_back'],
    paused: ['active'],
    redeploying: ['active'],
    rolling_back: ['active'],
    blocked: [],
    disabled: [],
  });
  assert.equal(DEPLOYMENT_STATUSES.length, 9);
  assert.equal(DEPLOYMENT_EVENT_TYPES.length, 12);
  assert.equal(DEPLOYMENT_CHECK_NAMES.length, 9);
});

test('DEPLOY-AC-05 unit: every legal edge is legal, every non-edge is rejected', () => {
  const legal: ReadonlyArray<[string, string]> = [
    ['draft', 'validating'],
    ['validating', 'ready'],
    ['ready', 'active'],
    ['ready', 'blocked'],
    ['active', 'paused'],
    ['paused', 'active'],
    ['active', 'disabled'],
    ['active', 'redeploying'],
    ['redeploying', 'active'],
    ['active', 'rolling_back'],
    ['rolling_back', 'active'],
  ];
  for (const [from, to] of legal) {
    assert.ok(
      isLegalDeploymentTransition(from as never, to as never),
      `${from} -> ${to} must be legal`,
    );
  }
  let rejected = 0;
  for (const from of DEPLOYMENT_STATUSES) {
    for (const to of DEPLOYMENT_STATUSES) {
      if (from === to) continue;
      if (legal.some(([f, t]) => f === from && t === to)) continue;
      assert.equal(
        isLegalDeploymentTransition(from, to),
        false,
        `${from} -> ${to} must be rejected`,
      );
      rejected += 1;
    }
  }
  assert.equal(rejected, 72 - 11, 'exactly 11 legal edges in the 9-state machine');
  // Terminal states reject EVERYTHING.
  for (const terminal of ['blocked', 'disabled'] as const) {
    for (const to of DEPLOYMENT_STATUSES) {
      assert.equal(isLegalDeploymentTransition(terminal, to), false);
    }
  }
});

// ---------------------------------------------------------------------------
// The version-constraint matcher
// ---------------------------------------------------------------------------

test('DEPLOY-002 unit: version constraint semantics (null, *, exact, caret, fail-closed)', () => {
  assert.equal(satisfiesVersionConstraint('1.2.3', null), true);
  assert.equal(satisfiesVersionConstraint('anything', '*'), true);
  assert.equal(satisfiesVersionConstraint('1.2.3', '1.2.3'), true);
  assert.equal(satisfiesVersionConstraint('1.2.4', '1.2.3'), false);
  assert.equal(satisfiesVersionConstraint('1.2', '1.2.0'), true); // 1.2 == 1.2.0 numerically
  assert.equal(satisfiesVersionConstraint('1.3.0', '^1.2.0'), true);
  assert.equal(satisfiesVersionConstraint('1.1.9', '^1.2.0'), false);
  assert.equal(satisfiesVersionConstraint('2.0.0', '^1.2.0'), false);
  assert.equal(satisfiesVersionConstraint('1.2.0', '^1.2.0'), true);
  // Unknown constraint syntax fails closed.
  assert.equal(satisfiesVersionConstraint('1.2.3', '~1.2.0'), false);
  assert.equal(satisfiesVersionConstraint('1.2.3', '>=1.0.0'), false);
  assert.equal(satisfiesVersionConstraint('not-a-version', '1.2.3'), false);
});

// ---------------------------------------------------------------------------
// The input guards
// ---------------------------------------------------------------------------

test('DEPLOY-AC-03 unit: the creation guard accepts the full frozen identity selection', () => {
  assert.doesNotThrow(() =>
    assertValidDeploymentCreation({ workspaceId: UUID_C, selection: validSelection() }),
  );
});

test('DEPLOY-AC-03 unit: the creation guard rejects malformed shapes', () => {
  const cases: ReadonlyArray<{ input: unknown; match: RegExp }> = [
    {
      input: { workspaceId: 'not-a-uuid', selection: validSelection() },
      match: /workspaceId/,
    },
    {
      input: { workspaceId: UUID_C, selection: { ...validSelection(), playbookVersionId: 'x' } },
      match: /playbookVersionId/,
    },
    {
      input: { workspaceId: UUID_C, selection: { ...validSelection(), workflowDefinitionIds: [] } },
      match: /workflowDefinitionIds/,
    },
    {
      input: {
        workspaceId: UUID_C,
        selection: { ...validSelection(), workflowDefinitionIds: [UUID_B, UUID_B] },
      },
      match: /duplicate/,
    },
    {
      input: { workspaceId: UUID_C, selection: { ...validSelection(), requiredDomainPacks: 'no' } },
      match: /must be an array/,
    },
    {
      input: {
        workspaceId: UUID_C,
        selection: {
          ...validSelection(),
          requiredCapabilities: [{ kind: 'wrong', name: 'x', versionConstraint: null }],
        },
      },
      match: /malformed entry shape/,
    },
    {
      input: {
        workspaceId: UUID_C,
        selection: { ...validSelection(), runtimeRequirements: { runtimeClass: 'aws-ec2' } },
      },
      match: /runtimeClass/,
    },
    {
      input: {
        workspaceId: UUID_C,
        selection: { ...validSelection(), triggerConfig: [{ kind: 'schedule', config: null }] },
      },
      match: /schedule triggers require/,
    },
    {
      input: {
        workspaceId: UUID_C,
        selection: { ...validSelection(), triggerConfig: [{ kind: 'cron', config: null }] },
      },
      match: /kind/,
    },
  ];
  for (const { input, match } of cases) {
    assert.throws(
      () => assertValidDeploymentCreation(input as never),
      (error: unknown) => {
        assert.ok(error instanceof InvalidRequestError);
        assert.match(error.message, /Invalid/);
        assert.ok(
          (error.details ?? []).some((detail) => match.test(detail)),
          `expected a detail matching ${match}; got: ${(error.details ?? []).join(' | ')}`,
        );
        return true;
      },
      `expected rejection for ${JSON.stringify(input)}`,
    );
  }
});

/** Matches an InvalidRequestError whose details contain the pattern. */
function throwsWithDetail(fn: () => void, pattern: RegExp, label: string): void {
  assert.throws(
    fn,
    (error: unknown) => {
      assert.ok(error instanceof InvalidRequestError, `${label}: expected InvalidRequestError`);
      const text = `${error.message} | ${(error.details ?? []).join(' | ')}`;
      assert.match(text, pattern, `${label}: details must match ${pattern}`);
      return true;
    },
    label,
  );
}

test('DEPLOY-AC-09 unit: the runtime requirements shape is EXACTLY the closed class vocabulary', () => {
  for (const runtimeClass of DEPLOYMENT_RUNTIME_CLASSES) {
    assert.doesNotThrow(() =>
      assertValidDeploymentCreation({
        workspaceId: UUID_C,
        selection: validSelection({ runtimeRequirements: { runtimeClass } }),
      }),
    );
  }
  // No infrastructure identity can enter the runtime requirements.
  throwsWithDetail(
    () =>
      assertValidDeploymentCreation({
        workspaceId: UUID_C,
        selection: {
          ...validSelection(),
          runtimeRequirements: { runtimeClass: 'pooled-worker', region: 'eu-west-1' } as never,
        },
      }),
    /exactly one key "runtimeClass"/,
    'extra runtime key',
  );
  throwsWithDetail(
    () =>
      assertValidDeploymentCreation({
        workspaceId: UUID_C,
        selection: {
          ...validSelection(),
          runtimeRequirements: { host: 'infra.example.com' } as never,
        },
      }),
    /runtimeClass/,
    'infrastructure host key',
  );
});

test('DEPLOY-AC-03 unit: §21 material-shaped keys are rejected at every level', () => {
  assert.ok(containsMaterialShapedKey({ nested: { apiKey: 'x' } }));
  assert.ok(!containsMaterialShapedKey({ safe: 'value' }));
  throwsWithDetail(
    () =>
      assertValidDeploymentCreation({
        workspaceId: UUID_C,
        selection: {
          ...validSelection(),
          triggerConfig: [{ kind: 'event', config: { secret: 'leak' } }],
        },
      }),
    /material-shaped keys are forbidden/,
    'material config',
  );
  throwsWithDetail(
    () => assertValidRedeploySelection({ ...validSelection(), token: 'leak' } as never),
    /material-shaped keys/,
    'material selection key',
  );
});

test('DEPLOY-AC-05 unit: the transition-request guard bounds every payload', () => {
  const base = {
    deploymentId: UUID_A,
    to: 'paused' as const,
    idempotencyKey: 'key-1',
    expectedVersion: 3,
    reason: null,
    redeploySelection: null,
    rollbackTargetEventId: null,
  };
  assert.doesNotThrow(() => assertValidTransitionRequest(base));
  // validating/ready are not externally targetable.
  throwsWithDetail(
    () => assertValidTransitionRequest({ ...base, to: 'validating' }),
    /not externally targetable/,
    'validating target',
  );
  throwsWithDetail(
    () => assertValidTransitionRequest({ ...base, to: 'ready' }),
    /not externally targetable/,
    'ready target',
  );
  // redeploy requires its selection payload; rollback its target event.
  throwsWithDetail(
    () => assertValidTransitionRequest({ ...base, to: 'redeploying' }),
    /redeploySelection: required/,
    'redeploy without selection',
  );
  throwsWithDetail(
    () => assertValidTransitionRequest({ ...base, to: 'rolling_back', rollbackTargetEventId: null }),
    /rollbackTargetEventId/,
    'rollback without target',
  );
  throwsWithDetail(
    () =>
      assertValidTransitionRequest({
        ...base,
        to: 'paused',
        rollbackTargetEventId: UUID_B,
      }),
    /only accepted when to=rolling_back/,
    'target on wrong edge',
  );
  throwsWithDetail(
    () => assertValidTransitionRequest({ ...base, expectedVersion: 0 }),
    /expectedVersion/,
    'zero version',
  );
});

test('DEPLOY-002 unit: the provenance guard bounds the server-derived block', () => {
  assert.doesNotThrow(() => assertValidProvenance(validProvenance()));
  throwsWithDetail(
    () => assertValidProvenance({ ...validProvenance(), actor: '' }),
    /actor/,
    'empty actor',
  );
  throwsWithDetail(
    () => assertValidProvenance({ ...validProvenance(), recordedVia: '' }),
    /recordedVia/,
    'empty surface',
  );
  throwsWithDetail(
    () => assertValidProvenance({ ...validProvenance(), correlationId: '' }),
    /correlationId/,
    'empty correlation',
  );
});

// ---------------------------------------------------------------------------
// The PURE resolution evaluator (the DEPLOY-AC-04 core)
// ---------------------------------------------------------------------------

test('DEPLOY-AC-04 unit: the all-green report passes every named check', () => {
  const report = evaluateDeploymentResolution(
    { scope: SCOPE, selection: validSelection() },
    greenSnapshots(),
  );
  assert.equal(report.ok, true);
  assert.equal(report.checks.length, 9);
  for (const check of report.checks) {
    assert.equal(check.ok, true, `${check.check} should be green: ${check.detail}`);
  }
  assert.equal(report.policyDecisionId, UUID_A);
});

test('DEPLOY-AC-04 unit: EVERY dependency failure fails the gate (no partial pass)', () => {
  // A top-level-writable view of the snapshots (the mutators only
  // reassign fields; the evaluator still receives the frozen shape).
  type MutableSnapshots = {
    -readonly [K in keyof DeploymentResolutionSnapshots]: DeploymentResolutionSnapshots[K];
  };
  const cases: ReadonlyArray<{ label: string; mutate: (s: MutableSnapshots) => void; check: string }> = [
    {
      label: 'disabled workspace boundary',
      check: 'authorization',
      mutate: (s) => {
        s.workspaceOwnership = {
          ...validOwnership(),
          workspace: { workspaceId: UUID_C, clientId: UUID_B, status: 'disabled' },
        };
      },
    },
    {
      label: 'unpublished (draft) playbook version',
      check: 'playbook-version',
      mutate: (s) => {
        s.playbookVersion = { versionId: UUID_A, playbookId: UUID_B, status: 'draft' };
      },
    },
    {
      label: 'retired playbook version',
      check: 'playbook-version',
      mutate: (s) => {
        s.playbookVersion = { versionId: UUID_A, playbookId: UUID_B, status: 'retired' };
      },
    },
    {
      label: 'unknown playbook version',
      check: 'playbook-version',
      mutate: (s) => {
        s.playbookVersion = null;
      },
    },
    {
      label: 'cross-agency playbook',
      check: 'playbook-version',
      mutate: (s) => {
        s.playbook = { playbookId: UUID_B, agencyId: '99999999-9999-4999-8999-999999999999', clientId: null };
      },
    },
    {
      label: 'client-scoped playbook of another client',
      check: 'playbook-version',
      mutate: (s) => {
        s.playbook = { playbookId: UUID_B, agencyId: UUID_A, clientId: '99999999-9999-4999-8999-999999999999' };
      },
    },
    {
      label: 'non-active workflow definition',
      check: 'workflow-versions',
      mutate: (s) => {
        s.workflowDefinitions = [
          {
            definition: { workflowDefinitionId: UUID_B, workflowId: UUID_C, status: 'draft', playbookVersionId: UUID_A },
            workflow: { workflowId: UUID_C, workspaceId: UUID_C },
          },
        ];
      },
    },
    {
      label: 'workflow of another workspace',
      check: 'workflow-versions',
      mutate: (s) => {
        s.workflowDefinitions = [
          {
            definition: { workflowDefinitionId: UUID_B, workflowId: UUID_C, status: 'active', playbookVersionId: UUID_A },
            workflow: { workflowId: UUID_C, workspaceId: '99999999-9999-4999-8999-999999999999' },
          },
        ];
      },
    },
    {
      label: 'definition pinned to a different playbook version',
      check: 'workflow-versions',
      mutate: (s) => {
        s.workflowDefinitions = [
          {
            definition: { workflowDefinitionId: UUID_B, workflowId: UUID_C, status: 'active', playbookVersionId: '99999999-9999-4999-8999-999999999999' },
            workflow: { workflowId: UUID_C, workspaceId: UUID_C },
          },
        ];
      },
    },
    {
      label: 'missing domain pack install',
      check: 'domain-packs',
      mutate: (s) => {
        s.packInstalls = [];
      },
    },
    {
      label: 'disabled domain pack install',
      check: 'domain-packs',
      mutate: (s) => {
        s.packInstalls = [{ installId: UUID_A, packId: UUID_B, status: 'disabled' }];
      },
    },
    {
      label: 'domain pack version below the caret constraint',
      check: 'domain-packs',
      mutate: () => {
        // The selection's constraint moves above the installed 1.2.0.
      },
    },
    {
      label: 'missing extension capability install',
      check: 'capabilities',
      mutate: (s) => {
        s.extensionInstalls = [];
      },
    },
    {
      label: 'extension installed but not authorized',
      check: 'capabilities',
      mutate: (s) => {
        s.extensionInstalls = [
          { installId: UUID_A, extensionId: UUID_C, status: 'configured', secretBindings: { emailApiKey: UUID_A } },
        ];
      },
    },
    {
      label: 'extension version violating the caret constraint',
      check: 'capabilities',
      mutate: () => {
        // The selection's constraint moves above the authorized 2.1.0.
      },
    },
    {
      label: 'unregistered integration adapter',
      check: 'capabilities',
      mutate: (s) => {
        s.adapters = [];
      },
    },
    {
      label: 'integration adapter registered but no connection',
      check: 'capabilities',
      mutate: (s) => {
        s.connections = [];
      },
    },
    {
      label: 'integration connection suspended',
      check: 'capabilities',
      mutate: (s) => {
        s.connections = [
          { connectionId: UUID_B, clientId: UUID_B, adapterKey: 'meta-ads', status: 'suspended', credentialReferenceId: UUID_B },
        ];
      },
    },
    {
      label: 'connection of another client',
      check: 'capabilities',
      mutate: (s) => {
        s.connections = [
          { connectionId: UUID_B, clientId: '99999999-9999-4999-8999-999999999999', adapterKey: 'meta-ads', status: 'connected', credentialReferenceId: UUID_B },
        ];
      },
    },
    {
      label: 'dead credential reference (disabled)',
      check: 'credentials',
      mutate: (s) => {
        s.credentials = new Map([
          [UUID_A, { credentialId: UUID_A, agencyId: UUID_A, clientId: null, status: 'disabled' }],
          [UUID_B, { credentialId: UUID_B, agencyId: UUID_A, clientId: UUID_B, status: 'active' }],
        ]);
      },
    },
    {
      label: 'credential of another agency',
      check: 'credentials',
      mutate: (s) => {
        s.credentials = new Map([
          [UUID_A, { credentialId: UUID_A, agencyId: '99999999-9999-4999-8999-999999999999', clientId: null, status: 'active' }],
          [UUID_B, { credentialId: UUID_B, agencyId: UUID_A, clientId: UUID_B, status: 'active' }],
        ]);
      },
    },
    {
      label: 'client-narrowed credential of another client',
      check: 'credentials',
      mutate: (s) => {
        s.credentials = new Map([
          [UUID_A, { credentialId: UUID_A, agencyId: UUID_A, clientId: '99999999-9999-4999-8999-999999999999', status: 'active' }],
          [UUID_B, { credentialId: UUID_B, agencyId: UUID_A, clientId: UUID_B, status: 'active' }],
        ]);
      },
    },
    {
      label: 'unresolved credential reference',
      check: 'credentials',
      mutate: (s) => {
        s.credentials = new Map();
      },
    },
    {
      label: 'policy decision deny',
      check: 'policy',
      mutate: (s) => {
        s.policyDecision = { decisionId: UUID_A, outcome: 'deny' };
      },
    },
    {
      label: 'policy decision unknown (fail closed)',
      check: 'policy',
      mutate: (s) => {
        s.policyDecision = { decisionId: UUID_A, outcome: 'unknown' };
      },
    },
    {
      label: 'no policy decision at all (fail closed)',
      check: 'policy',
      mutate: (s) => {
        s.policyDecision = null;
      },
    },
    {
      label: 'runtime class outside the closed vocabulary',
      check: 'runtime',
      mutate: () => {
        // The selection itself carries the invalid class.
      },
    },
    {
      label: 'schedule trigger without config',
      check: 'triggers',
      mutate: () => {
        // The selection itself carries the invalid trigger.
      },
    },
  ];

  for (const { label, mutate, check } of cases) {
    // A top-level-writable view of the snapshots (the mutators only
    // reassign fields; the evaluator still receives the frozen shape).
    const snapshots = greenSnapshots() as unknown as {
      -readonly [K in keyof DeploymentResolutionSnapshots]: DeploymentResolutionSnapshots[K];
    };
    if (label === 'extension version violating the caret constraint') {
      const selection = validSelection({
        requiredCapabilities: [
          { kind: 'integration', name: 'meta-ads', versionConstraint: null },
          { kind: 'extension', name: 'email-composer', versionConstraint: '^2.2.0' },
        ],
      });
      const report = evaluateDeploymentResolution({ scope: SCOPE, selection }, greenSnapshots());
      assert.equal(report.ok, false, label);
      assert.ok(
        report.checks.some((entry) => entry.check === 'capabilities' && !entry.ok),
        `${label}: the capabilities check must fail (authorized 2.1.0 < ^2.2.0)`,
      );
      continue;
    }
    if (label === 'domain pack version below the caret constraint') {
      const selection = validSelection({
        requiredDomainPacks: [{ name: 'creator-operations', versionConstraint: '^1.3.0' }],
      });
      const report = evaluateDeploymentResolution({ scope: SCOPE, selection }, greenSnapshots());
      assert.equal(report.ok, false, label);
      assert.ok(
        report.checks.some((entry) => entry.check === 'domain-packs' && !entry.ok),
        `${label}: the domain-packs check must fail (installed 1.2.0 < ^1.3.0)`,
      );
      continue;
    }
    if (label === 'runtime class outside the closed vocabulary') {
      const selection = validSelection({
        runtimeRequirements: { runtimeClass: 'dedicated-runtime' },
        // (a legal class; the illegal one is rejected by the guard — the
        // evaluator re-asserts the vocabulary:)
      });
      (selection.runtimeRequirements as { runtimeClass: string }).runtimeClass = 'vm-lambda';
      const report = evaluateDeploymentResolution({ scope: SCOPE, selection }, snapshots);
      assert.equal(report.ok, false, label);
      assert.ok(
        report.checks.some((entry) => entry.check === 'runtime' && !entry.ok),
        `${label}: the runtime check must fail`,
      );
      continue;
    }
    if (label === 'schedule trigger without config') {
      const selection = validSelection({
        triggerConfig: [
          { kind: 'schedule', config: null },
        ],
      });
      const report = evaluateDeploymentResolution({ scope: SCOPE, selection }, snapshots);
      assert.equal(report.ok, false, label);
      assert.ok(
        report.checks.some((entry) => entry.check === 'triggers' && !entry.ok),
        `${label}: the triggers check must fail`,
      );
      continue;
    }
    mutate(snapshots);
    const report = evaluateDeploymentResolution(
      { scope: SCOPE, selection: validSelection() },
      snapshots,
    );
    assert.equal(report.ok, false, `${label}: the gate must fail`);
    const failed = report.checks.filter((entry) => !entry.ok);
    assert.ok(
      failed.some((entry) => entry.check === check),
      `${label}: the '${check}' check must fail (failed: ${failed.map((f) => f.check).join(',')})`,
    );
    // The failing detail is honest evidence.
    for (const entry of failed) {
      assert.ok(entry.detail.length > 0, `${label}: failing check detail must be non-empty`);
    }
  }
});

test('DEPLOY-AC-04 unit: a single failed check keeps every other check honestly recorded', () => {
  const snapshots = greenSnapshots() as unknown as {
    -readonly [K in keyof DeploymentResolutionSnapshots]: DeploymentResolutionSnapshots[K];
  };
  snapshots.policyDecision = { decisionId: UUID_A, outcome: 'deny' };
  const report = evaluateDeploymentResolution({ scope: SCOPE, selection: validSelection() }, snapshots);
  assert.equal(report.ok, false);
  assert.equal(report.checks.filter((entry) => entry.ok).length, 8);
  assert.equal(report.checks.filter((entry) => !entry.ok).length, 1);
});

test('DEPLOY-AC-04 unit: the evaluator is pure — identical inputs, identical report', () => {
  const first = evaluateDeploymentResolution(
    { scope: SCOPE, selection: validSelection() },
    greenSnapshots(),
  );
  const second = evaluateDeploymentResolution(
    { scope: SCOPE, selection: validSelection() },
    greenSnapshots(),
  );
  assert.deepEqual(first, second);
});
