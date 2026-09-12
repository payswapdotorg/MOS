/**
 * MKT-036 unit tests — the frozen Domain Pack framework contract as PURE
 * functions (spec/requirements-v1.3.md PACK-001; spec/domain-pack-v1.3.md
 * §2 artifact list, §3 boundary rules, §4 versioning, §5 data isolation;
 * spec/implementation-contract.md §4 workflow definition contract, §3
 * "No externally supplied field may override a server-derived actor,
 * owner, provenance, policy decision", §21 material-key backstop).
 *
 * Acceptance mapping:
 *   - the CLOSED VOCABULARIES: the fourteen frozen §2 artifact kinds
 *     (each with an interpretable meaning) and the two §5 artifact
 *     scopes;
 *   - the frozen INSTALL lifecycle table edge for edge — 'uninstalled'
 *     terminal;
 *   - the MANIFEST GUARD (PACK-001 declaration contract): unknown
 *     artifact kind, undeclared scope vocabulary, duplicate (kind, name)
 *     identity, secret VALUES smuggled as material-shaped keys, a
 *     self-dependency, and bounds are all rejected;
 *   - §4 WORKFLOW-TEMPLATE CONFORMANCE (PACK-AC-02, unit half): a
 *     template payload that satisfies the /workflows definition-content
 *     contract passes; a template with dangling nodes/duplicate node
 *     ids is rejected — validated through the /workflows authority's
 *     OWN validator, never a pack-side reimplementation;
 *   - the §5 artifact scope resolution (boundary composition purity)
 *     and the PACK-AC-03 scope-matrix predicate (client-scoped data
 *     never reachable from another client's context; agency-reusable
 *     artifacts reachable only within their agency);
 *   - the deterministic manifest fingerprint (canonicalization).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DOMAIN_PACK_ARTIFACT_KINDS,
  DOMAIN_PACK_ARTIFACT_KIND_MEANINGS,
  DOMAIN_PACK_ARTIFACT_SCOPES,
  DOMAIN_PACK_ARTIFACT_SCOPE_MEANINGS,
  DOMAIN_PACK_INSTALL_STATUSES,
  DOMAIN_PACK_INSTALL_TERMINAL_STATUSES,
  DOMAIN_PACK_INSTALL_TRANSITIONS,
  isLegalDomainPackInstallTransition,
  isDomainPackArtifactReachable,
  resolveDomainPackArtifactBoundary,
  type DomainPackManifest,
} from '../../src/modules/domain-packs/public.ts';
import {
  assertValidDomainPackInstallInput,
  assertValidDomainPackManifest,
  domainPackCreateFingerprint,
  payloadHasNoDomainPackMaterialKeys,
} from '../../src/modules/domain-packs/public.ts';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const emptySchema = { type: 'object', properties: {}, required: [] };

function functionNode(nodeId: string): Record<string, unknown> {
  return {
    nodeId,
    nodeType: 'function',
    inputMapping: {},
    outputSchema: { type: 'object', properties: { out: { type: 'string' } }, required: [] },
    executionPolicyRef: null,
    retryPolicy: null,
    timeout: null,
    idempotencyKeyStrategy: null,
    humanApproval: null,
    join: null,
    loop: null,
  };
}

function terminalNode(nodeId: string): Record<string, unknown> {
  return { ...functionNode(nodeId), nodeType: 'terminal' };
}

function successEdge(fromNode: string, toNode: string): Record<string, unknown> {
  return { fromNode, toNode, edgeType: 'success', predicateRef: null, joinSemantics: null };
}

/** A minimal VALID /workflows §4 definition content (the template payload). */
function minimalWorkflowContent(): Record<string, unknown> {
  return {
    graph: {
      nodes: [functionNode('a'), terminalNode('t')],
      edges: [successEdge('a', 't')],
    },
    inputSchema: { ...emptySchema },
    outputSchema: { ...emptySchema },
    retryPolicyDefaults: {},
    concurrencyLimits: {},
    timeoutPolicy: {},
    compensation: [],
  };
}

function validManifest(overrides: Partial<DomainPackManifest> = {}): DomainPackManifest {
  return {
    packKey: 'performance-marketing',
    publisher: 'payswap-labs',
    version: '1.0.0',
    displayName: 'Performance Marketing Pack',
    description: 'Specializes MarketingOS for performance marketing operations.',
    compatibility: { minPlatform: '1.2.0', maxPlatform: '1.9.0' },
    requiredPacks: [],
    artifacts: [
      {
        kind: 'domain-entity',
        name: 'campaign-group',
        description: 'A performance campaign grouping entity.',
        scope: 'client',
        payload: { fields: ['id', 'name', 'budget'] },
      },
      {
        kind: 'workflow-template',
        name: 'daily-budget-pacing',
        description: 'Daily budget pacing workflow template.',
        scope: 'client',
        payload: minimalWorkflowContent(),
      },
      {
        kind: 'playbook-template',
        name: 'launch-playbook',
        description: 'The reusable launch playbook template.',
        scope: 'agency-reusable',
        payload: { summary: 'Launch sequence', templates: ['setup', 'scale'] },
      },
    ],
    ...overrides,
  };
}

/** A deep writable clone for negative fixtures (structurally cast back for the guard). */
function writable(manifest: DomainPackManifest): Record<string, unknown> {
  return JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
}

function castManifest(value: Record<string, unknown>): DomainPackManifest {
  return value as unknown as DomainPackManifest;
}

/** Asserts the guard rejects with the InvalidRequestError type. */
function assertRejected(fn: () => void, needle: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof InvalidRequestError, `expected InvalidRequestError, got ${String(caught)}`);
  const details = (caught as InvalidRequestError).details ?? [];
  const haystack = [caught.message, ...details].join('\n');
  assert.ok(
    haystack.includes(needle),
    `expected rejection detail containing '${needle}', got: ${haystack}`,
  );
}

// ---------------------------------------------------------------------------
// The frozen vocabularies
// ---------------------------------------------------------------------------

test('PACK-001 vocabularies: the fourteen frozen §2 artifact kinds, each with an interpretable meaning', () => {
  assert.deepEqual([...DOMAIN_PACK_ARTIFACT_KINDS], [
    'domain-entity',
    'view',
    'goal-definition',
    'metric-definition',
    'playbook-template',
    'workflow-template',
    'ai-capability',
    'human-capability',
    'policy',
    'integration-binding',
    'extension-binding',
    'evidence-schema',
    'evaluator',
    'ui-surface',
  ]);
  for (const kind of DOMAIN_PACK_ARTIFACT_KINDS) {
    assert.ok(
      DOMAIN_PACK_ARTIFACT_KIND_MEANINGS[kind].length > 10,
      `${kind} needs an interpretable meaning`,
    );
  }
});

test('PACK-001 vocabularies: the closed §5 artifact-scope set is exactly client | agency-reusable', () => {
  assert.deepEqual([...DOMAIN_PACK_ARTIFACT_SCOPES], ['client', 'agency-reusable']);
  for (const scope of DOMAIN_PACK_ARTIFACT_SCOPES) {
    assert.ok(DOMAIN_PACK_ARTIFACT_SCOPE_MEANINGS[scope].length > 10);
  }
  // Cross-client aggregation is NOT expressible through the vocabulary.
  for (const forbidden of ['cross-client', 'global', 'platform', 'all-clients']) {
    assert.ok(
      !(DOMAIN_PACK_ARTIFACT_SCOPES as readonly string[]).includes(forbidden),
      `the artifact-scope vocabulary must not contain '${forbidden}'`,
    );
  }
});

// ---------------------------------------------------------------------------
// The frozen install lifecycle (domain-pack-v1.3.md §4)
// ---------------------------------------------------------------------------

test('the frozen install lifecycle table: installed ⇄ disabled + terminal uninstall; uninstalled rejects everything', () => {
  assert.deepEqual(DOMAIN_PACK_INSTALL_TRANSITIONS['installed'], ['disabled', 'uninstalled']);
  assert.deepEqual(DOMAIN_PACK_INSTALL_TRANSITIONS['disabled'], ['installed', 'uninstalled']);
  assert.deepEqual(DOMAIN_PACK_INSTALL_TRANSITIONS['uninstalled'], []);
  assert.deepEqual([...DOMAIN_PACK_INSTALL_STATUSES], ['installed', 'disabled', 'uninstalled']);
  assert.deepEqual([...DOMAIN_PACK_INSTALL_TERMINAL_STATUSES], ['uninstalled']);
  assert.equal(isLegalDomainPackInstallTransition('installed', 'disabled'), true);
  assert.equal(isLegalDomainPackInstallTransition('disabled', 'installed'), true);
  assert.equal(isLegalDomainPackInstallTransition('installed', 'uninstalled'), true);
  assert.equal(isLegalDomainPackInstallTransition('disabled', 'uninstalled'), true);
  // Illegal edges: skip-edges and resurrection.
  assert.equal(isLegalDomainPackInstallTransition('uninstalled', 'installed'), false);
  assert.equal(isLegalDomainPackInstallTransition('uninstalled', 'disabled'), false);
  assert.equal(isLegalDomainPackInstallTransition('uninstalled', 'uninstalled'), false);
});

// ---------------------------------------------------------------------------
// The manifest guard (PACK-001 declaration contract)
// ---------------------------------------------------------------------------

test('PACK-001 manifest guard: a fully-declared §2/§5 manifest passes the shape guard', () => {
  assertValidDomainPackManifest(validManifest());
});

test('PACK-001 manifest guard: an unknown artifact kind is rejected (the closed §2 set)', () => {
  const manifest = writable(validManifest());
  ((manifest['artifacts'] as Record<string, unknown>[])[0]!)['kind'] = 'creator-workflow';
  assertRejected(() => assertValidDomainPackManifest(castManifest(manifest)), 'fourteen frozen artifact kinds');
});

test('PACK-001 manifest guard: an undeclared artifact scope is rejected (the closed §5 set)', () => {
  const manifest = writable(validManifest());
  ((manifest['artifacts'] as Record<string, unknown>[])[0]!)['scope'] = 'global';
  assertRejected(() => assertValidDomainPackManifest(castManifest(manifest)), 'client | agency-reusable');
});

test('PACK-001 manifest guard: a duplicate (kind, name) artifact identity is rejected', () => {
  const manifest = writable(validManifest());
  const artifacts = manifest['artifacts'] as Record<string, unknown>[];
  manifest['artifacts'] = [...artifacts, { ...artifacts[0]! }];
  assertRejected(() => assertValidDomainPackManifest(castManifest(manifest)), 'duplicate artifact identity');
});

test('PACK-001 manifest guard: secret VALUES are never acceptable in any artifact payload (§21/CRED-001)', () => {
  const smuggled = writable(validManifest());
  ((smuggled['artifacts'] as Record<string, unknown>[])[0]!)['payload'] = { nested: { token: 'MATERIAL-do-not-leak' } };
  assertRejected(() => assertValidDomainPackManifest(castManifest(smuggled)), 'material-shaped keys are rejected');
  // The pure walker fences every nesting level.
  assert.deepEqual(
    payloadHasNoDomainPackMaterialKeys({ deep: { deeper: [{ apiKey: 'x' }] } }),
    ['payload.deep.deeper[0].apiKey: material-shaped keys are rejected (secrets never appear in pack declarations — §21)'],
  );
});

test('PACK-001 manifest guard: a self-dependency is rejected at publication', () => {
  const manifest = validManifest({
    requiredPacks: [{ publisher: 'payswap-labs', packKey: 'performance-marketing', version: '1.0.0' }],
  });
  assertRejected(() => assertValidDomainPackManifest(manifest), 'cannot declare itself as a dependency');
});

test('PACK-001 manifest guard: a manifest without artifacts is rejected (a pack declares §2 artifacts)', () => {
  assertRejected(() => assertValidDomainPackManifest(validManifest({ artifacts: [] })), 'at least one artifact');
});

test('PACK-001 manifest guard: malformed identity/metadata declarations are rejected', () => {
  assertRejected(() => assertValidDomainPackManifest(validManifest({ packKey: 'Bad_Key' })), 'packKey');
  assertRejected(() => assertValidDomainPackManifest(validManifest({ publisher: 'NO-CAPS' })), 'publisher');
  assertRejected(() => assertValidDomainPackManifest(validManifest({ version: '1.0' })), 'version');
  assertRejected(
    () => assertValidDomainPackManifest(validManifest({ compatibility: { minPlatform: '', maxPlatform: '1.9.0' } })),
    'compatibility',
  );
});

// ---------------------------------------------------------------------------
// §4 workflow-template conformance (PACK-AC-02, unit half)
// ---------------------------------------------------------------------------

test('PACK-AC-02: a workflow-template payload satisfying the /workflows §4 contract passes the guard', () => {
  const manifest = validManifest({
    artifacts: [
      {
        kind: 'workflow-template',
        name: 'compliant-template',
        description: 'A conforming workflow template.',
        scope: 'client',
        payload: minimalWorkflowContent(),
      },
    ],
  });
  assertValidDomainPackManifest(manifest);
});

test('PACK-AC-02: a workflow template with a dangling edge is rejected through the /workflows authority validator', () => {
  const content = minimalWorkflowContent() as { graph: { edges: unknown[] } };
  content.graph.edges = [successEdge('a', 'nonexistent-node')];
  const manifest = validManifest({
    artifacts: [
      {
        kind: 'workflow-template',
        name: 'dangling-template',
        description: 'A non-conforming workflow template.',
        scope: 'client',
        payload: content,
      },
    ],
  });
  assertRejected(() => assertValidDomainPackManifest(manifest), '§4 definition contract');
});

test('PACK-AC-02: a workflow template with duplicate node ids is rejected (the §4 MUST list)', () => {
  const content = minimalWorkflowContent() as { graph: { nodes: unknown[] } };
  content.graph.nodes = [functionNode('a'), functionNode('a'), terminalNode('t')];
  const manifest = validManifest({
    artifacts: [
      {
        kind: 'workflow-template',
        name: 'duplicate-node-template',
        description: 'A non-conforming workflow template.',
        scope: 'client',
        payload: content,
      },
    ],
  });
  assertRejected(() => assertValidDomainPackManifest(manifest), '§4 definition contract');
});

test('PACK-AC-02: a non-workflow-template artifact payload is NOT run through the §4 validator (declarations stay free-form)', () => {
  const manifest = validManifest({
    artifacts: [
      {
        kind: 'goal-definition',
        name: 'pipeline-goal',
        description: 'A goal definition declaration.',
        scope: 'client',
        // This is NOT a workflow definition — no §4 conformance required.
        payload: { objective: 'Grow pipeline', metric: 'qualified_leads', target: 100 },
      },
    ],
  });
  assertValidDomainPackManifest(manifest);
});

// ---------------------------------------------------------------------------
// The install input guard
// ---------------------------------------------------------------------------

test('the install input guard: canonical scope + bounded idempotency key', () => {
  assertValidDomainPackInstallInput({
    scope: { agencyId: 'a1', clientId: 'c1', workspaceId: 'w1' },
    packId: 'p1',
    idempotencyKey: 'install-1',
  });
  assertRejected(
    () =>
      assertValidDomainPackInstallInput({
        scope: { agencyId: '', clientId: 'c1', workspaceId: 'w1' },
        packId: 'p1',
        idempotencyKey: 'install-1',
      }),
    'scope.agencyId',
  );
  assertRejected(
    () =>
      assertValidDomainPackInstallInput({
        scope: { agencyId: 'a1', clientId: '', workspaceId: 'w1' },
        packId: 'p1',
        idempotencyKey: 'install-1',
      }),
    'scope.clientId',
  );
  assertRejected(
    () =>
      assertValidDomainPackInstallInput({
        scope: { agencyId: 'a1', clientId: 'c1', workspaceId: '' },
        packId: 'p1',
        idempotencyKey: 'install-1',
      }),
    'scope.workspaceId',
  );
  assertRejected(
    () =>
      assertValidDomainPackInstallInput({
        scope: { agencyId: 'a1', clientId: 'c1', workspaceId: 'w1' },
        packId: 'p1',
        idempotencyKey: '',
      }),
    'idempotencyKey',
  );
});

// ---------------------------------------------------------------------------
// The §5 artifact scope resolution + the PACK-AC-03 scope matrix predicate
// ---------------------------------------------------------------------------

const INSTALL_SCOPE = {
  agencyId: 'b3c1a111-1111-4111-8111-111111111111',
  clientId: 'c4d2a222-2222-4222-8222-222222222222',
  workspaceId: 'w5e3a333-3333-4333-8333-333333333333',
};

test('PACK-AC-03: the §5 boundary resolution — client artifacts keep the installing client; agency-reusable artifacts drop it', () => {
  const clientBoundary = resolveDomainPackArtifactBoundary({ scope: 'client' }, INSTALL_SCOPE);
  assert.deepEqual(clientBoundary, INSTALL_SCOPE);
  const agencyBoundary = resolveDomainPackArtifactBoundary({ scope: 'agency-reusable' }, INSTALL_SCOPE);
  assert.equal(agencyBoundary.agencyId, INSTALL_SCOPE.agencyId);
  assert.equal(agencyBoundary.clientId, null);
  assert.equal(agencyBoundary.workspaceId, INSTALL_SCOPE.workspaceId);
});

test('PACK-AC-03: pack-owned Client data never reaches another client context — the scope-matrix predicate', () => {
  const clientArtifact = {
    scope: 'client' as const,
    agencyId: INSTALL_SCOPE.agencyId,
    clientId: INSTALL_SCOPE.clientId,
    workspaceId: INSTALL_SCOPE.workspaceId,
  };
  // Same client boundary: reachable.
  assert.equal(isDomainPackArtifactReachable(clientArtifact, INSTALL_SCOPE), true);
  // Another client of the SAME agency: NOT reachable (the Client
  // boundary is the workspace hop that materialized the record).
  assert.equal(
    isDomainPackArtifactReachable(clientArtifact, {
      agencyId: INSTALL_SCOPE.agencyId,
      clientId: 'f6d4a444-4444-4444-8444-444444444444',
      workspaceId: 'w7e5a555-5555-4555-8555-555555555555',
    }),
    false,
  );
  // Another agency: NOT reachable (hard boundary).
  assert.equal(
    isDomainPackArtifactReachable(clientArtifact, {
      agencyId: 'a8f6a666-6666-4666-8666-666666666666',
      clientId: null,
      workspaceId: null,
    }),
    false,
  );
});

test('PACK-AC-03: agency-reusable artifacts are reachable within their agency and ONLY within it', () => {
  const reusableArtifact = {
    scope: 'agency-reusable' as const,
    agencyId: INSTALL_SCOPE.agencyId,
    clientId: null,
    workspaceId: INSTALL_SCOPE.workspaceId,
  };
  // Any client context of the owning agency: reachable (the explicit
  // §5 reusable distinction).
  assert.equal(
    isDomainPackArtifactReachable(reusableArtifact, {
      agencyId: INSTALL_SCOPE.agencyId,
      clientId: 'f6d4a444-4444-4444-8444-444444444444',
      workspaceId: 'w7e5a555-5555-4555-8555-555555555555',
    }),
    true,
  );
  // Another agency: NOT reachable.
  assert.equal(
    isDomainPackArtifactReachable(reusableArtifact, {
      agencyId: 'a8f6a666-6666-4666-8666-666666666666',
      clientId: null,
      workspaceId: null,
    }),
    false,
  );
});

// ---------------------------------------------------------------------------
// The deterministic manifest fingerprint
// ---------------------------------------------------------------------------

test('the manifest fingerprint is deterministic and key-order independent (canonical JSON)', () => {
  const one = validManifest();
  // Same content, different object-key insertion order at every level
  // (array order is content: canonical JSON sorts object keys only).
  const two = {
    compatibility: { maxPlatform: '1.9.0', minPlatform: '1.2.0' },
    artifacts: one.artifacts.map((artifact) => ({
      payload: artifact.payload,
      scope: artifact.scope,
      description: artifact.description,
      name: artifact.name,
      kind: artifact.kind,
    })),
    requiredPacks: one.requiredPacks,
    description: one.description,
    displayName: one.displayName,
    version: one.version,
    publisher: one.publisher,
    packKey: one.packKey,
  };
  assert.equal(domainPackCreateFingerprint(one), domainPackCreateFingerprint(two as unknown as DomainPackManifest));
  // Any semantic difference changes the fingerprint.
  const three = writable(validManifest());
  ((three['artifacts'] as Record<string, unknown>[])[0]!)['description'] = 'A different description.';
  assert.notEqual(domainPackCreateFingerprint(one), domainPackCreateFingerprint(castManifest(three)));
});
