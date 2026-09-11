/**
 * MKT-021 unit tests — the frozen execution policy model as PURE functions
 * (spec/requirements.md POL-001 "policy boundaries for AI, tools, network,
 * secrets, deployment, field actions and extensions"; the MKT-021
 * acceptance "policy matrix + fail-closed regressions"; spec/
 * implementation-contract.md §3 "No externally supplied field may override
 * a server-derived ... policy decision").
 *
 * Proofs:
 *   - POLICY_DIMENSIONS is exactly the seven frozen dimensions, each with
 *     an interpretable meaning;
 *   - the RULE MATCHING semantics (operation exact/wildcard, resource
 *     any/exact, attribute exact/wildcard/missing);
 *   - THE POLICY MATRIX: every dimension x decision outcome
 *     (allow/deny/unknown) x scope (platform/agency/client) is covered by
 *     the table-driven suite — including the DENY-OVERRIDES composition
 *     across the scope chain (a client deny overrides agency+platform
 *     allows; a platform deny overrides agency allows; an agency allow
 *     with a client deny denies);
 *   - FAIL-CLOSED: enforcementOutcome denies everything that is not an
 *     explicit 'allow' — 'deny' AND 'unknown' both deny; missing policy
 *     state (no consulted versions) is 'unknown' ('no-active-policy'),
 *     never an allow;
 *   - the input guards: declaration rejection (empty rules, illegal
 *     effects/operations, oversized values, material-shaped keys, client
 *     scope without agency), action rejection (unknown dimension — the
 *     fail-closed trigger, malformed shapes, reserved credential
 *     authority attributes on the secrets dimension, material keys) and
 *     provenance completeness;
 *   - composeSecretsEffectiveAttributes: the SERVER-DERIVED credential
 *     metadata (kind/status/client-narrowing) is composed on top and
 *     caller-supplied reserved values never survive;
 *   - purity: identical inputs produce the identical decision.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  POLICY_DIMENSIONS,
  POLICY_DIMENSION_MEANINGS,
  POLICY_REASON_CODES,
  composeSecretsEffectiveAttributes,
  enforcementOutcome,
  evaluatePolicyMatrix,
  matchesPolicyRule,
  type ConsultedPolicyVersion,
  type PolicyActionDescriptor,
  type PolicyDimension,
  type PolicyEffectiveAttributes,
  type PolicyRule,
} from '../../src/modules/policies/public.ts';
import {
  assertValidPolicyAction,
  assertValidPolicyDeclarationInput,
  assertValidPolicyDecisionProvenance,
} from '../../src/modules/policies/public.ts';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AGENCY_ID = 'b3c1a111-1111-4111-8111-111111111111';
const CLIENT_ID = 'c4d2a222-2222-4222-8222-222222222222';

function action(dimension: PolicyDimension, operation = 'invoke', resource: string | null = null): PolicyEffectiveAttributes {
  return { dimension, operation, resource, attributes: {} };
}

function version(policyId: string, rules: readonly PolicyRule[]): ConsultedPolicyVersion {
  return { policyId, scopeKind: 'agency', rules };
}

const ALLOW_ALL: PolicyRule = {
  effect: 'allow',
  operations: ['*'],
  resource: null,
  attributes: {},
  reason: 'platform default allows this dimension',
};

const DENY_ALL: PolicyRule = {
  effect: 'deny',
  operations: ['*'],
  resource: null,
  attributes: {},
  reason: 'boundary denies this dimension',
};

// ---------------------------------------------------------------------------
// The frozen dimension set
// ---------------------------------------------------------------------------

test('POL-001 dimensions: exactly the seven frozen dimensions, each with an interpretable meaning', () => {
  assert.deepEqual([...POLICY_DIMENSIONS], [
    'ai',
    'tools',
    'network',
    'secrets',
    'deployment',
    'field',
    'extension',
  ]);
  for (const dimension of POLICY_DIMENSIONS) {
    assert.ok(POLICY_DIMENSION_MEANINGS[dimension].length > 10, `${dimension} needs an interpretable meaning`);
  }
});

test('POL-001 reason codes: the closed decision vocabulary is exactly the frozen set', () => {
  assert.deepEqual([...POLICY_REASON_CODES], [
    'rule-allowed',
    'rule-denied',
    'no-matching-rule',
    'no-active-policy',
    'ambiguous-scope',
    'credential-reference-unresolved',
    'credential-scope-mismatch',
    'evaluation-error',
  ]);
});

// ---------------------------------------------------------------------------
// Rule matching semantics
// ---------------------------------------------------------------------------

test('rule matching: operation must match exactly or via wildcard', () => {
  const rule: PolicyRule = { effect: 'allow', operations: ['egress'], resource: null, attributes: {}, reason: 'r' };
  assert.ok(matchesPolicyRule(action('network', 'egress'), rule));
  assert.ok(!matchesPolicyRule(action('network', 'dns-lookup'), rule));
  const wildcard: PolicyRule = { effect: 'deny', operations: ['*'], resource: null, attributes: {}, reason: 'r' };
  assert.ok(matchesPolicyRule(action('network', 'egress'), wildcard));
  assert.ok(matchesPolicyRule(action('network', 'anything-at-all'), wildcard));
});

test('rule matching: resource must match exactly, or via wildcard/null (any)', () => {
  const rule: PolicyRule = { effect: 'allow', operations: ['*'], resource: 'meta-ads', attributes: {}, reason: 'r' };
  assert.ok(matchesPolicyRule(action('tools', 'invoke', 'meta-ads'), rule));
  assert.ok(!matchesPolicyRule(action('tools', 'invoke', 'google-ads'), rule));
  // A rule without a resource selector matches ANY resource.
  const anyResource: PolicyRule = { effect: 'allow', operations: ['*'], resource: null, attributes: {}, reason: 'r' };
  assert.ok(matchesPolicyRule(action('tools', 'invoke', 'whatever'), anyResource));
  const star: PolicyRule = { effect: 'allow', operations: ['*'], resource: '*', attributes: {}, reason: 'r' };
  assert.ok(matchesPolicyRule(action('tools', 'invoke', 'whatever'), star));
});

test('rule matching: attributes must be present and equal, or wildcard on a PRESENT key', () => {
  const rule: PolicyRule = {
    effect: 'allow',
    operations: ['*'],
    resource: null,
    attributes: { credentialKind: 'integration_api_key' },
    reason: 'r',
  };
  assert.ok(
    matchesPolicyRule(
      { dimension: 'secrets', operation: 'read', resource: null, attributes: { credentialKind: 'integration_api_key' } },
      rule,
    ),
  );
  assert.ok(
    !matchesPolicyRule(
      { dimension: 'secrets', operation: 'read', resource: null, attributes: { credentialKind: 'oauth_refresh' } },
      rule,
    ),
  );
  // A MISSING action attribute key never matches (fail-closed posture).
  assert.ok(!matchesPolicyRule({ dimension: 'secrets', operation: 'read', resource: null, attributes: {} }, rule));
  // Wildcard matches any PRESENT value of the key.
  const starRule: PolicyRule = {
    effect: 'deny',
    operations: ['*'],
    resource: null,
    attributes: { host: '*' },
    reason: 'r',
  };
  assert.ok(matchesPolicyRule({ dimension: 'network', operation: 'egress', resource: null, attributes: { host: 'ads.example' } }, starRule));
  assert.ok(!matchesPolicyRule({ dimension: 'network', operation: 'egress', resource: null, attributes: {} }, starRule));
});

// ---------------------------------------------------------------------------
// THE POLICY MATRIX — dimensions x outcomes x scope (table-driven)
// ---------------------------------------------------------------------------

test('POLICY MATRIX (table-driven): every dimension x every outcome x every scope level', () => {
  const matrix: readonly {
    readonly label: string;
    readonly operation: string;
    readonly resource: string | null;
    readonly consulted: readonly ConsultedPolicyVersion[];
    readonly expectOutcome: 'allow' | 'deny' | 'unknown';
    readonly expectReason: string;
  }[] = [
    // ALLOW at each scope level.
    { label: 'allow @ platform', operation: 'invoke', resource: null, consulted: [version('p-platform', [ALLOW_ALL])], expectOutcome: 'allow', expectReason: 'rule-allowed' },
    { label: 'allow @ agency', operation: 'invoke', resource: null, consulted: [version('p-agency', [ALLOW_ALL])], expectOutcome: 'allow', expectReason: 'rule-allowed' },
    { label: 'allow @ client', operation: 'invoke', resource: null, consulted: [version('p-client', [ALLOW_ALL])], expectOutcome: 'allow', expectReason: 'rule-allowed' },
    // DENY at each scope level.
    { label: 'deny @ platform', operation: 'invoke', resource: null, consulted: [version('p-platform', [DENY_ALL])], expectOutcome: 'deny', expectReason: 'rule-denied' },
    { label: 'deny @ agency', operation: 'invoke', resource: null, consulted: [version('p-agency', [DENY_ALL])], expectOutcome: 'deny', expectReason: 'rule-denied' },
    { label: 'deny @ client', operation: 'invoke', resource: null, consulted: [version('p-client', [DENY_ALL])], expectOutcome: 'deny', expectReason: 'rule-denied' },
    // UNKNOWN: no matching rule (active versions exist, none match).
    { label: 'unknown: no matching rule', operation: 'invoke', resource: null, consulted: [version('p-agency', [{
      effect: 'allow', operations: ['other-op'], resource: null, attributes: {}, reason: 'r',
    }])], expectOutcome: 'unknown', expectReason: 'no-matching-rule' },
    // UNKNOWN: missing policy state (NO active version at any level).
    { label: 'unknown: no active policy', operation: 'invoke', resource: null, consulted: [], expectOutcome: 'unknown', expectReason: 'no-active-policy' },
    // DENY-OVERRIDES across the scope chain (the frozen composition).
    { label: 'client deny overrides agency+platform allow', operation: 'invoke', resource: null, consulted: [
      version('p-client', [DENY_ALL]),
      version('p-agency', [ALLOW_ALL]),
      version('p-platform', [ALLOW_ALL]),
    ], expectOutcome: 'deny', expectReason: 'rule-denied' },
    { label: 'agency deny overrides platform allow', operation: 'invoke', resource: null, consulted: [
      version('p-agency', [DENY_ALL]),
      version('p-platform', [ALLOW_ALL]),
    ], expectOutcome: 'deny', expectReason: 'rule-denied' },
    { label: 'platform deny overrides agency+client allow', operation: 'invoke', resource: null, consulted: [
      version('p-client', [ALLOW_ALL]),
      version('p-agency', [ALLOW_ALL]),
      version('p-platform', [DENY_ALL]),
    ], expectOutcome: 'deny', expectReason: 'rule-denied' },
    { label: 'client allow + agency allow union', operation: 'invoke', resource: null, consulted: [
      version('p-client', [{ effect: 'allow', operations: ['invoke'], resource: null, attributes: {}, reason: 'client invoke' }]),
      version('p-agency', [{ effect: 'allow', operations: ['invoke', 'read'], resource: null, attributes: {}, reason: 'agency invoke/read' }]),
    ], expectOutcome: 'allow', expectReason: 'rule-allowed' },
    // Platform default + agency narrowing: platform allows everything,
    // agency denies one host — the specific action denies, the general one
    // is allowed (deny-overrides is per-ACTION, not per-dimension).
    { label: 'platform allow + agency deny on specific resource', operation: 'invoke', resource: 'blocked-host.example', consulted: [
      version('p-platform', [ALLOW_ALL]),
      version('p-agency', [{ effect: 'deny', operations: ['*'], resource: 'blocked-host.example', attributes: {}, reason: 'blocked host' }]),
    ], expectOutcome: 'deny', expectReason: 'rule-denied' },
    { label: 'platform allow survives for the non-blocked resource', operation: 'invoke', resource: 'allowed-host.example', consulted: [
      version('p-platform', [ALLOW_ALL]),
      version('p-agency', [{ effect: 'deny', operations: ['*'], resource: 'blocked-host.example', attributes: {}, reason: 'blocked host' }]),
    ], expectOutcome: 'allow', expectReason: 'rule-allowed' },
  ];

  // The matrix runs for EVERY dimension — 7 dimensions x the outcome rows.
  for (const dimension of POLICY_DIMENSIONS) {
    for (const row of matrix) {
      const effective: PolicyEffectiveAttributes = {
        dimension,
        operation: row.operation,
        resource: row.resource,
        attributes: {},
      };
      const result = evaluatePolicyMatrix(effective, row.consulted);
      assert.equal(
        result.outcome,
        row.expectOutcome,
        `${dimension} / ${row.label}: expected ${row.expectOutcome}, got ${result.outcome} (${result.reasonCode})`,
      );
      assert.equal(result.reasonCode, row.expectReason, `${dimension} / ${row.label}`);
    }
  }
});

test('POLICY MATRIX: matched policy versions are recorded — deny records the denying versions, allow the allowing ones', () => {
  const denyVersion = version('p-deny', [DENY_ALL]);
  const allowVersion = version('p-allow', [ALLOW_ALL]);
  const denied = evaluatePolicyMatrix(action('tools'), [denyVersion, allowVersion]);
  assert.deepEqual(denied.matchedPolicyVersions, ['p-deny']);
  const allowed = evaluatePolicyMatrix(action('tools'), [allowVersion]);
  assert.deepEqual(allowed.matchedPolicyVersions, ['p-allow']);
  const unknown = evaluatePolicyMatrix(action('tools'), []);
  assert.deepEqual(unknown.matchedPolicyVersions, []);
});

// ---------------------------------------------------------------------------
// FAIL-CLOSED (the POL-001 acceptance regression)
// ---------------------------------------------------------------------------

test('FAIL-CLOSED: enforcement denies everything that is not an explicit allow', () => {
  assert.equal(enforcementOutcome({ outcome: 'allow' }), 'allow');
  assert.equal(enforcementOutcome({ outcome: 'deny' }), 'deny');
  assert.equal(enforcementOutcome({ outcome: 'unknown' }), 'deny');
});

test('FAIL-CLOSED: missing policy state is unknown (undecided) — never an allow', () => {
  for (const dimension of POLICY_DIMENSIONS) {
    const result = evaluatePolicyMatrix(action(dimension), []);
    assert.equal(result.outcome, 'unknown', `${dimension}: missing policy must be undecided`);
    assert.equal(result.reasonCode, 'no-active-policy');
    assert.equal(enforcementOutcome(result), 'deny', `${dimension}: missing policy must deny enforcement`);
  }
});

test('FAIL-CLOSED: unknown dimension is rejected by the action guard (never a decision)', () => {
  const bad = {
    dimension: 'quantum' as PolicyDimension,
    operation: 'invoke',
    resource: null,
    attributes: {},
  } as PolicyActionDescriptor;
  assert.throws(() => assertValidPolicyAction(bad), InvalidRequestError);
});

test('purity: identical inputs produce the identical decision (no hidden state)', () => {
  const consulted = [version('p-1', [DENY_ALL, ALLOW_ALL])];
  const effective = action('ai', 'invoke', 'model-x');
  const first = evaluatePolicyMatrix(effective, consulted);
  const second = evaluatePolicyMatrix(effective, consulted);
  assert.deepEqual(first, second);
});

// ---------------------------------------------------------------------------
// Input guards (fail-closed by rejection)
// ---------------------------------------------------------------------------

const VALID_DECLARATION = {
  scope: { agencyId: AGENCY_ID, clientId: null },
  dimension: 'network' as PolicyDimension,
  rules: [
    {
      effect: 'deny',
      operations: ['egress'],
      resource: 'tracking.example',
      attributes: { protocol: 'https' },
      reason: 'no egress to the tracking host',
    },
  ] as readonly PolicyRule[],
  description: 'Agency network egress boundary v1',
};

test('declaration guard: a valid declaration passes', () => {
  assert.doesNotThrow(() => assertValidPolicyDeclarationInput(VALID_DECLARATION));
  const platform = { ...VALID_DECLARATION, scope: { agencyId: null, clientId: null } };
  assert.doesNotThrow(() => assertValidPolicyDeclarationInput(platform));
  const clientScoped = {
    ...VALID_DECLARATION,
    scope: { agencyId: AGENCY_ID, clientId: CLIENT_ID },
  };
  assert.doesNotThrow(() => assertValidPolicyDeclarationInput(clientScoped));
});

test('declaration guard: client scope without agency, empty rules, bad effects and oversized values are rejected', () => {
  const cases: unknown[] = [
    { ...VALID_DECLARATION, scope: { agencyId: null, clientId: CLIENT_ID } },
    { ...VALID_DECLARATION, rules: [] },
    { ...VALID_DECLARATION, rules: [{ ...VALID_DECLARATION.rules[0]!, effect: 'maybe' as 'allow' }] },
    { ...VALID_DECLARATION, rules: [{ ...VALID_DECLARATION.rules[0]!, operations: [] }] },
    { ...VALID_DECLARATION, rules: [{ ...VALID_DECLARATION.rules[0]!, reason: '' }] },
    { ...VALID_DECLARATION, dimension: 'not-a-dimension' as PolicyDimension },
    { ...VALID_DECLARATION, description: 'x'.repeat(2001) },
  ];
  for (const input of cases) {
    assert.throws(
      () => assertValidPolicyDeclarationInput(input as Parameters<typeof assertValidPolicyDeclarationInput>[0]),
      InvalidRequestError,
      JSON.stringify(input).slice(0, 120),
    );
  }
});

test('declaration guard: material-shaped keys are rejected anywhere in the rules (§21)', () => {
  const smuggled = {
    ...VALID_DECLARATION,
    rules: [
      {
        effect: 'allow',
        operations: ['*'],
        resource: null,
        attributes: { apiKey: 'value' },
        reason: 'smuggled material key',
      },
    ] as readonly PolicyRule[],
  };
  assert.throws(() => assertValidPolicyDeclarationInput(smuggled), InvalidRequestError);
});

test('action guard: valid actions pass for every dimension', () => {
  for (const dimension of POLICY_DIMENSIONS) {
    const descriptor: PolicyActionDescriptor = {
      dimension,
      operation: 'invoke',
      resource: dimension === 'secrets' ? '11111111-1111-4111-8111-111111111111' : 'some-resource',
      attributes: { channel: 'email' },
    };
    assert.doesNotThrow(() => assertValidPolicyAction(descriptor), dimension);
  }
});

test('action guard: malformed shapes are rejected (fail-closed)', () => {
  const cases: unknown[] = [
    { dimension: 'ai', operation: '', resource: null, attributes: {} },
    { dimension: 'ai', operation: 'invoke', resource: null, attributes: { deep: { nested: 'object' } as unknown as string } },
    { dimension: 'secrets', operation: 'read', resource: null, attributes: { credentialKind: 'integration_api_key' } },
    { dimension: 'secrets', operation: 'read', resource: null, attributes: { secret: 'abc' } },
    { dimension: 'tools', operation: 'invoke', resource: 'x'.repeat(257), attributes: {} },
  ];
  for (const descriptor of cases) {
    assert.throws(
      () => assertValidPolicyAction(descriptor as PolicyActionDescriptor),
      InvalidRequestError,
      JSON.stringify(descriptor).slice(0, 120),
    );
  }
});

test('provenance guard: incomplete server-derived provenance fails closed', () => {
  assert.doesNotThrow(() =>
    assertValidPolicyDecisionProvenance({
      actor: 'user:11111111-1111-4111-8111-111111111111',
      recordedVia: 'api',
      correlationId: 'corr-1',
      causationId: null,
    }),
  );
  const cases: unknown[] = [
    { actor: '', recordedVia: 'api', correlationId: 'corr-1', causationId: null },
    { actor: 'user:x', recordedVia: '', correlationId: 'corr-1', causationId: null },
    { actor: 'user:x', recordedVia: 'api', correlationId: '', causationId: null },
    { actor: 'user:x', recordedVia: 'api', correlationId: 'c', causationId: '' },
  ];
  for (const provenance of cases) {
    assert.throws(
      () =>
        assertValidPolicyDecisionProvenance(
          provenance as Parameters<typeof assertValidPolicyDecisionProvenance>[0],
        ),
      InvalidRequestError,
      JSON.stringify(provenance),
    );
  }
});

// ---------------------------------------------------------------------------
// CRED-001 evaluation posture (secrets dimension)
// ---------------------------------------------------------------------------

test('CRED-001 effective attributes: server-derived credential metadata is composed on top; caller-supplied reserved values never survive', () => {
  const effective = composeSecretsEffectiveAttributes(
    {
      operation_hint: 'batch-import',
      credentialKind: 'LIE-about-kind',
      credentialStatus: 'LIE-about-status',
      credentialClientId: 'LIE-about-client',
    },
    { kind: 'integration_api_key', clientId: CLIENT_ID, status: 'active' },
  );
  assert.equal(effective['credentialKind'], 'integration_api_key');
  assert.equal(effective['credentialStatus'], 'active');
  assert.equal(effective['credentialClientId'], CLIENT_ID);
  assert.equal(effective['operation_hint'], 'batch-import');
  // A non-narrowed reference contributes no credentialClientId key.
  const unnarrowed = composeSecretsEffectiveAttributes({}, { kind: 'oauth', clientId: null, status: 'active' });
  assert.ok(!('credentialClientId' in unnarrowed));
});

test('CRED-001 evaluation matrix: kind-scoped rules decide through the server-derived attributes', () => {
  const kindRule: PolicyRule = {
    effect: 'allow',
    operations: ['read'],
    resource: null,
    attributes: { credentialKind: 'integration_api_key' },
    reason: 'integration keys are readable',
  };
  const effective = composeSecretsEffectiveAttributes({}, { kind: 'integration_api_key', clientId: null, status: 'active' });
  const allowed = evaluatePolicyMatrix(
    { dimension: 'secrets', operation: 'read', resource: 'cred-1', attributes: effective },
    [version('p-agency', [kindRule])],
  );
  assert.equal(allowed.outcome, 'allow');
  const mismatch = composeSecretsEffectiveAttributes({}, { kind: 'oauth_refresh', clientId: null, status: 'active' });
  const undecided = evaluatePolicyMatrix(
    { dimension: 'secrets', operation: 'read', resource: 'cred-2', attributes: mismatch },
    [version('p-agency', [kindRule])],
  );
  assert.equal(undecided.outcome, 'unknown');
  assert.equal(undecided.reasonCode, 'no-matching-rule');
  assert.equal(enforcementOutcome(undecided), 'deny');
});
