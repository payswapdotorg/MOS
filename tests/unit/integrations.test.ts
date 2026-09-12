/**
 * MKT-023 unit tests — the pure /integrations contract surfaces (INT-001):
 * the first-party adapter registration guards, the registry builder (the
 * adapter mechanism — adapters as DATA, never provider branches), the
 * connection/webhook/provenance input guards (the §21 secret-leak
 * backstop), the frozen connection lifecycle table, the rate-limit
 * contract, and the pure canonical owner-context composition.
 *
 * Acceptance mapping (work-items.md MKT-023 acceptance: "provider
 * isolation / static checks" — the pure half; the architecture file
 * carries the static isolation proofs, the integration files carry the
 * behavioral ones).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAdapterRegistry,
  containsMaterialShapedKey,
  composeIntegrationConnectionOwnerContext,
  assertValidAdapterRegistration,
  assertValidConnectionRegistration,
  assertValidProvenance,
  assertValidWebhookIngestion,
  INTEGRATION_CAPABILITY_KINDS,
  INTEGRATION_CONNECTION_HEALTHS,
  INTEGRATION_CONNECTION_TRANSITIONS,
  isLegalIntegrationConnectionTransition,
  type IntegrationAdapter,
  type IntegrationConnectionRecord,
  type IntegrationsClientOwnershipSnapshot,
} from '../../src/modules/integrations/public.ts';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';

// ---------------------------------------------------------------------------
// Fixtures (STUB adapters implementing the generic port — never SDKs)
// ---------------------------------------------------------------------------

function stubAdapter(overrides: Partial<IntegrationAdapter> = {}): IntegrationAdapter {
  return {
    descriptor: {
      adapterKey: 'stub-analytics',
      providerLabel: 'Stub Analytics',
      description: 'A stub analytics provider for unit tests.',
    },
    capabilities: [
      {
        capabilityKey: 'reports-read',
        kind: 'read',
        operations: ['listCampaigns', 'getCampaignReport'],
        description: 'Read campaign reports.',
      },
      {
        capabilityKey: 'campaigns-mutate',
        kind: 'mutation',
        operations: ['upsertCampaign'],
        description: 'Upsert campaigns.',
      },
      {
        capabilityKey: 'events-webhook',
        kind: 'webhook',
        operations: ['report.completed'],
        description: 'Receive report completion events.',
      },
    ],
    probeConnection: async () => ({ reachable: true, healthy: true, message: null, rateLimit: null }),
    read: async () => ({ ok: true, records: [], error: null, rateLimit: null }),
    mutate: async () => ({ ok: true, providerRecordId: null, data: null, error: null, rateLimit: null }),
    verifyWebhook: async () => ({ verified: true, reason: null, normalizedEventType: null }),
    ...overrides,
  };
}

function validRegistration() {
  return {
    clientId: 'client-1',
    adapterKey: 'stub-analytics',
    credentialReferenceId: 'credential-1',
    providerConfig: { region: 'eu-west-1', timezone: 'UTC' },
  };
}

function validProvenance() {
  return {
    actor: 'user:0199abcd-0000-7000-8000-000000000001',
    recordedVia: 'api',
    correlationId: 'corr-1',
    causationId: null,
  };
}

function validWebhookInput() {
  return {
    connectionId: 'conn-1',
    eventType: 'report.completed',
    payload: { reportId: 'rep-9', status: 'done' },
    headers: { 'x-provider-signature': 'sig-abc' },
  };
}

function expectInvalid(fn: () => unknown): InvalidRequestError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof InvalidRequestError, `expected InvalidRequestError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected the guard to throw InvalidRequestError');
}

// ---------------------------------------------------------------------------
// The first-party adapter registration guard (the adapter mechanism)
// ---------------------------------------------------------------------------

test('INT-001: a well-formed stub adapter passes the registration guard', () => {
  const problems = assertValidAdapterRegistration(stubAdapter());
  assert.deepEqual(problems, []);
});

test('INT-001: malformed descriptors are rejected loudly (never silently registered)', () => {
  const cases: ReadonlyArray<Partial<IntegrationAdapter>> = [
    { descriptor: { adapterKey: 'Bad_Key', providerLabel: 'x', description: '' } },
    { descriptor: { adapterKey: '', providerLabel: 'x', description: '' } },
    { descriptor: { adapterKey: 'a'.repeat(65), providerLabel: 'x', description: '' } },
    { descriptor: { adapterKey: 'ok-key', providerLabel: '   ', description: '' } },
    { descriptor: { adapterKey: 'ok-key', providerLabel: 'x'.repeat(101), description: '' } },
    { descriptor: { adapterKey: 'ok-key', providerLabel: 'x', description: 'x'.repeat(2001) } },
    { capabilities: [] },
    { capabilities: 'not-an-array' as unknown as [] },
  ];
  for (const overrides of cases) {
    const problems = assertValidAdapterRegistration(stubAdapter(overrides));
    assert.ok(problems.length > 0, `expected problems for ${JSON.stringify(overrides)}`);
  }
});

test('INT-001: capability shape violations are rejected (closed kind set, bounded unique operations)', () => {
  const cases: ReadonlyArray<readonly unknown[]> = [
    [{ capabilityKey: 'bad key', kind: 'read', operations: ['op'], description: '' }],
    [{ capabilityKey: 'k', kind: 'strange', operations: ['op'], description: '' }],
    [{ capabilityKey: 'k', kind: 'read', operations: [], description: '' }],
    [{ capabilityKey: 'k', kind: 'read', operations: ['op', 'op'], description: '' }],
    [{ capabilityKey: 'k', kind: 'read', operations: ['x'.repeat(65)], description: '' }],
    [{ capabilityKey: 'k', kind: 'read', operations: ['op'], description: 'x'.repeat(2001) }],
  ];
  for (const capabilities of cases) {
    const problems = assertValidAdapterRegistration(
      stubAdapter({ capabilities: capabilities as never }),
    );
    assert.ok(problems.length > 0, `expected problems for ${JSON.stringify(capabilities)}`);
  }
});

test('INT-001: duplicate capability keys within one adapter are rejected', () => {
  const problems = assertValidAdapterRegistration(
    stubAdapter({
      capabilities: [
        { capabilityKey: 'dup', kind: 'read', operations: ['a'], description: '' },
        { capabilityKey: 'dup', kind: 'mutation', operations: ['b'], description: '' },
      ] as never,
    }),
  );
  assert.ok(problems.some((problem) => problem.includes('duplicate capabilityKey')));
});

test('INT-001: the closed capability-kind vocabulary is frozen', () => {
  assert.deepEqual(INTEGRATION_CAPABILITY_KINDS, ['read', 'mutation', 'webhook']);
});

// ---------------------------------------------------------------------------
// The registry builder — adapters arrive as DATA (no provider branches)
// ---------------------------------------------------------------------------

test('INT-001: buildAdapterRegistry maps well-formed adapters by adapterKey', () => {
  const registry = buildAdapterRegistry([
    stubAdapter(),
    stubAdapter({
      descriptor: { adapterKey: 'stub-crm', providerLabel: 'Stub CRM', description: 'crm' },
    }),
  ]);
  assert.equal(registry.size, 2);
  assert.ok(registry.has('stub-analytics'));
  assert.ok(registry.has('stub-crm'));
  assert.equal(registry.get('stub-analytics')?.descriptor.providerLabel, 'Stub Analytics');
});

test('INT-001: duplicate adapterKey registrations fail construction loudly', () => {
  assert.throws(
    () => buildAdapterRegistry([stubAdapter(), stubAdapter()]),
    (error) =>
      error instanceof InvalidRequestError &&
      error.details?.some((detail) => detail.includes('duplicate adapterKey')) === true,
  );
});

test('INT-001: a malformed adapter fails construction (the registration surface never drops silently)', () => {
  assert.throws(
    () => buildAdapterRegistry([stubAdapter({ capabilities: [] })]),
    (error) => error instanceof InvalidRequestError,
  );
});

test('INT-001: an empty adapter set registers an empty registry (no first-party connectors in MKT-023)', () => {
  assert.equal(buildAdapterRegistry([]).size, 0);
});

// ---------------------------------------------------------------------------
// Connection registration guard (the §21 credential-by-logical-name half)
// ---------------------------------------------------------------------------

test('INT-001: a well-formed connection registration passes the guard', () => {
  assert.doesNotThrow(() => assertValidConnectionRegistration(validRegistration()));
});

test('§21: providerConfig must be a string→string object with NO material-shaped key at any level', () => {
  const cases: ReadonlyArray<Record<string, unknown>> = [
    { apiKey: 'val' },
    { secret: 'val' },
    { nested: { token: 'val' } },
    { deeper: [{ password: 'val' }] },
    { region: 12 },
    { region: null },
    { region: ['a'] },
  ];
  for (const providerConfig of cases) {
    const error = expectInvalid(() =>
      assertValidConnectionRegistration({
        ...validRegistration(),
        providerConfig: providerConfig as unknown as Record<string, string>,
      }),
    );
    assert.ok(
      error.details?.some((detail) => detail.includes('material') || detail.includes('string')) === true,
      `expected §21/shape problems for ${JSON.stringify(providerConfig)}, got ${JSON.stringify(error.details)}`,
    );
  }
});

test('§21: providerConfig key/value bounds are enforced (32 keys, 512-char values)', () => {
  const tooMany: Record<string, string> = {};
  for (let index = 0; index < 33; index += 1) tooMany[`k${index}`] = 'v';
  expectInvalid(() => assertValidConnectionRegistration({ ...validRegistration(), providerConfig: tooMany }));
  expectInvalid(() =>
    assertValidConnectionRegistration({
      ...validRegistration(),
      providerConfig: { long: 'x'.repeat(513) },
    }),
  );
});

test('INT-001: connection registration identifiers are bounded', () => {
  expectInvalid(() => assertValidConnectionRegistration({ ...validRegistration(), clientId: ' ' }));
  expectInvalid(() =>
    assertValidConnectionRegistration({ ...validRegistration(), adapterKey: 'NOT-LOWERCASE' }),
  );
  expectInvalid(() =>
    assertValidConnectionRegistration({ ...validRegistration(), credentialReferenceId: '' }),
  );
});

// ---------------------------------------------------------------------------
// The material-shaped-key walk (the pure §21 detector)
// ---------------------------------------------------------------------------

test('§21: containsMaterialShapedKey detects material at every nesting level', () => {
  assert.equal(containsMaterialShapedKey(null), false);
  assert.equal(containsMaterialShapedKey('plain'), false);
  assert.equal(containsMaterialShapedKey({ a: { b: { c: 1 } } }), false);
  assert.equal(containsMaterialShapedKey({ secret: 'x' }), true);
  assert.equal(containsMaterialShapedKey({ a: { b: [{ apiKey: 'x' }] } }), true);
  assert.equal(containsMaterialShapedKey({ api_key: 'x' }), true);
  assert.equal(containsMaterialShapedKey({ secretHandle: 'x' }), true);
  assert.equal(containsMaterialShapedKey([{ accessKey: 'x' }]), true);
});

// ---------------------------------------------------------------------------
// Provenance guard (server-derived, fail-closed by rejection)
// ---------------------------------------------------------------------------

test('INT-001: incomplete provenance never reaches the durable records', () => {
  assert.doesNotThrow(() => assertValidProvenance(validProvenance()));
  expectInvalid(() => assertValidProvenance({ ...validProvenance(), actor: ' ' }));
  expectInvalid(() => assertValidProvenance({ ...validProvenance(), recordedVia: 'x'.repeat(101) }));
  expectInvalid(() => assertValidProvenance({ ...validProvenance(), correlationId: '' }));
  expectInvalid(() => assertValidProvenance({ ...validProvenance(), causationId: ' ' }));
});

// ---------------------------------------------------------------------------
// Webhook ingestion guard
// ---------------------------------------------------------------------------

test('INT-001: a well-formed webhook delivery passes the ingestion guard', () => {
  assert.doesNotThrow(() => assertValidWebhookIngestion(validWebhookInput()));
});

test('§21: webhook payloads with material-shaped keys are rejected outright', () => {
  const error = expectInvalid(() =>
    assertValidWebhookIngestion({
      ...validWebhookInput(),
      payload: { reportId: 'r', nested: { token: 'leak' } },
    }),
  );
  assert.ok(error.details?.some((detail) => detail.includes('material')) === true);
});

test('INT-001: webhook delivery shape bounds are enforced', () => {
  expectInvalid(() => assertValidWebhookIngestion({ ...validWebhookInput(), eventType: '' }));
  expectInvalid(() => assertValidWebhookIngestion({ ...validWebhookInput(), eventType: 'x'.repeat(129) }));
  expectInvalid(() =>
    assertValidWebhookIngestion({ ...validWebhookInput(), payload: [] as unknown as Record<string, unknown> }),
  );
  expectInvalid(() => assertValidWebhookIngestion({ ...validWebhookInput(), payload: {} }));
  expectInvalid(() =>
    assertValidWebhookIngestion({ ...validWebhookInput(), headers: { 'x-sig': 42 as unknown as string } }),
  );
  const tooManyHeaders: Record<string, string> = {};
  for (let index = 0; index < 33; index += 1) tooManyHeaders[`h${index}`] = 'v';
  expectInvalid(() =>
    assertValidWebhookIngestion({ ...validWebhookInput(), headers: tooManyHeaders }),
  );
});

// ---------------------------------------------------------------------------
// The frozen connection lifecycle (implementation-contract §20)
// ---------------------------------------------------------------------------

test('INT-001: the connection transition table is exactly the frozen lifecycle', () => {
  assert.deepEqual(INTEGRATION_CONNECTION_TRANSITIONS, {
    registered: ['connected', 'suspended', 'error'],
    connected: ['suspended', 'error'],
    error: ['connected', 'suspended'],
    suspended: ['connected'],
  });
  assert.deepEqual(INTEGRATION_CONNECTION_HEALTHS, ['unknown', 'healthy', 'degraded', 'unreachable']);
});

test('INT-001: every frozen legal transition is legal, every other edge is not', () => {
  const statuses = ['registered', 'connected', 'suspended', 'error'] as const;
  for (const from of statuses) {
    for (const to of statuses) {
      const expected = INTEGRATION_CONNECTION_TRANSITIONS[from].includes(to);
      assert.equal(
        isLegalIntegrationConnectionTransition(from, to),
        expected,
        `${from} -> ${to} must be ${expected ? 'legal' : 'illegal'}`,
      );
    }
  }
  // No terminal state: every status has at least one outgoing edge.
  for (const from of statuses) {
    assert.ok(INTEGRATION_CONNECTION_TRANSITIONS[from].length > 0, `${from} is not terminal`);
  }
});

// ---------------------------------------------------------------------------
// The canonical owner-context composition (implementation-contract §2)
// ---------------------------------------------------------------------------

function connectionFixture(): IntegrationConnectionRecord {
  return {
    connectionId: 'conn-1',
    clientId: 'client-1',
    agencyId: 'agency-1',
    adapterKey: 'stub-analytics',
    providerLabel: 'Stub Analytics',
    status: 'connected',
    health: 'healthy',
    credentialReferenceId: 'credential-1',
    providerConfig: { region: 'eu' },
    rateLimit: null,
    lastError: null,
    lastCheckedAt: null,
    createdBy: null,
    version: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };
}

function clientOwnershipFixture(): IntegrationsClientOwnershipSnapshot {
  return {
    scope: { kind: 'client', agencyId: 'agency-1', clientId: 'client-1' },
    client: { clientId: 'client-1', agencyId: 'agency-1', status: 'active' },
  };
}

test('INT-001 (impl-contract §2): the owner context composes from the CLIENT chain only', () => {
  const context = composeIntegrationConnectionOwnerContext(
    connectionFixture(),
    clientOwnershipFixture(),
    '2026-01-03T00:00:00.000Z',
  );
  assert.equal(context.scope.kind, 'integration');
  assert.equal(context.scope.agencyId, 'agency-1');
  assert.equal(context.scope.clientId, 'client-1');
  assert.equal(context.scope.connectionId, 'conn-1');
  assert.equal(context.connection.connectionId, 'conn-1');
  assert.equal(context.clientOwnership.client.clientId, 'client-1');
  assert.equal(context.resolvedAt, '2026-01-03T00:00:00.000Z');
});

test('INT-001 (impl-contract §2): the composition is PURE — identical inputs compose identical contexts', () => {
  const a = composeIntegrationConnectionOwnerContext(
    connectionFixture(),
    clientOwnershipFixture(),
    '2026-01-03T00:00:00.000Z',
  );
  const b = composeIntegrationConnectionOwnerContext(
    connectionFixture(),
    clientOwnershipFixture(),
    '2026-01-03T00:00:00.000Z',
  );
  assert.deepEqual(a, b);
  // A different Client chain produces a different scope (derivation, not
  // echo: the scope tracks the CLIENT ownership, not the connection row).
  const other = composeIntegrationConnectionOwnerContext(
    connectionFixture(),
    { ...clientOwnershipFixture(), scope: { kind: 'client', agencyId: 'agency-2', clientId: 'client-1' } },
    '2026-01-03T00:00:00.000Z',
  );
  assert.equal(other.scope.agencyId, 'agency-2');
});

test('INT-001 (impl-contract §2): the connection identity never overrides the CLIENT chain scope', () => {
  // A smuggled mismatch (connection row claims another agency) still
  // composes the scope from the resolved CLIENT ownership — the ownership
  // authority wins, the row's denormalized fields lose.
  const mismatched = composeIntegrationConnectionOwnerContext(
    { ...connectionFixture(), agencyId: 'agency-evil' },
    clientOwnershipFixture(),
    '2026-01-03T00:00:00.000Z',
  );
  assert.equal(mismatched.scope.agencyId, 'agency-1');
});
