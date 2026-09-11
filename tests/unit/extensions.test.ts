/**
 * MKT-022 unit tests — the frozen extension model as PURE functions
 * (spec/requirements.md EXT-001; spec/extension-model.md §2 manifest,
 * §3 capability categories, §4 lifecycle, §5 permissions; spec/
 * implementation-contract.md §19; §3 "No externally supplied field may
 * override a server-derived actor, owner, provenance, policy decision").
 *
 * Acceptance mapping:
 *   - EXT-AC-01 (contract test): a manifest that fails SHAPE or
 *     PERMISSION DECLARATION is rejected — unknown capability category,
 *     non-least-privilege permission action (workflow mutation, credential
 *     creation, evidence-provenance fabrication, audit disabling are NOT
 *     declarable), secret VALUES instead of logical names, undeclared
 *     data-scope vocabulary, permission/requirement incoherence;
 *   - the frozen INSTALL lifecycle table (extension-model.md §4) edge for
 *     edge — 'uninstalled' terminal;
 *   - the least-privilege install contract (granted scopes ⊆ manifest);
 *   - the config contract validation (type/required/pattern/undeclared);
 *   - the invocation input contract (undeclared capability rejection,
 *     authority-shaped + material-shaped key rejection, required keys);
 *   - the pure context composition (granted capability set, granted data
 *     scopes, the canonical scope, the TTL) and the EXT-AC-02 scope
 *     predicate (unrelated tenant data is NEVER granted);
 *   - the deterministic manifest fingerprint (canonicalization).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXTENSION_CAPABILITY_CATEGORIES,
  EXTENSION_CAPABILITY_CATEGORY_MEANINGS,
  EXTENSION_DATA_SCOPES,
  EXTENSION_INSTALL_STATUSES,
  EXTENSION_INSTALL_TERMINAL_STATUSES,
  EXTENSION_INSTALL_TRANSITIONS,
  EXTENSION_PERMISSION_ACTIONS,
  DEFAULT_INVOCATION_TTL_MS,
  MAX_INVOCATION_TTL_MS,
  isInvocationContextExpired,
  isLegalExtensionInstallTransition,
  invocationGrantsDataScope,
  type ExtensionManifest,
} from '../../src/modules/extensions/public.ts';
import {
  assertValidExtensionConfigureInput,
  assertValidExtensionInvocationInput,
  assertValidExtensionInstallInput,
  assertValidExtensionManifest,
  assertValidInvocationProvenance,
  composeInvocationContext,
  extensionCreateFingerprint,
  validateConfigAgainstContract,
  type ExtensionInstallRecord,
  type ExtensionInvocationProvenance,
  type ExtensionRegistryRecord,
} from '../../src/modules/extensions/public.ts';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ISSUED_AT = '2026-01-15T10:00:00.000Z';

function validManifest(overrides: Partial<ExtensionManifest> = {}): ExtensionManifest {
  return {
    extensionKey: 'audience-enricher',
    publisher: 'payswap-labs',
    version: '1.4.0',
    compatibility: { minPlatform: '1.2.0', maxPlatform: '1.9.0' },
    capabilities: [
      { category: 'data-source', name: 'enrich-audience' },
      { category: 'research-discovery', name: 'discover-lookalikes' },
    ],
    permissions: [{ action: 'data:read', resource: null }],
    requiredSecretNames: [],
    dataScopes: ['client:read', 'workspace:read'],
    networkRequirements: [],
    runtimeClass: 'pooled-worker',
    inputContract: { required: ['audienceId'] },
    outputContract: { required: ['enrichedCount'] },
    eventSubscriptions: ['goal.created'],
    uiSurfaces: [],
    configContract: {
      region: {
        type: 'string',
        required: true,
        description: 'The enrichment region',
        pattern: '^(eu|us|apac)$',
      },
    },
    ...overrides,
  };
}

const PROVENANCE: ExtensionInvocationProvenance = {
  actor: 'user:b3c1a111-1111-4111-8111-111111111111',
  recordedVia: 'api',
  correlationId: 'corr-1',
  causationId: null,
};

function registryRecord(manifest: ExtensionManifest): ExtensionRegistryRecord {
  return {
    extensionId: 'e1111111-1111-4111-8111-111111111111',
    manifest,
    idempotencyKey: 'register-1',
    createFingerprint: 'fingerprint-1',
    createdBy: null,
    createdAt: ISSUED_AT,
    updatedAt: ISSUED_AT,
  };
}

function installRecord(grantedScopes: readonly string[]): ExtensionInstallRecord {
  return {
    installId: 'i2222222-2222-4222-8222-222222222222',
    extensionId: 'e1111111-1111-4111-8111-111111111111',
    agencyId: 'b3c1a111-1111-4111-8111-111111111111',
    clientId: 'c4d2a222-2222-4222-8222-222222222222',
    workspaceId: 'w5e3a333-3333-4333-8333-333333333333',
    status: 'authorized',
    config: {},
    secretBindings: {},
    grantedScopes: grantedScopes as ExtensionInstallRecord['grantedScopes'],
    idempotencyKey: 'install-1',
    version: 3,
    createdBy: null,
    createdAt: ISSUED_AT,
    updatedAt: ISSUED_AT,
  };
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

test('EXT-001 vocabularies: the nine frozen capability categories, each with an interpretable meaning', () => {
  assert.deepEqual([...EXTENSION_CAPABILITY_CATEGORIES], [
    'data-source',
    'research-discovery',
    'content-creative-generation',
    'execution-action',
    'measurement',
    'crm-commerce-integration',
    'field-acquisition',
    'ai-capability',
    'approval-ui-surface',
  ]);
  for (const category of EXTENSION_CAPABILITY_CATEGORIES) {
    assert.ok(
      EXTENSION_CAPABILITY_CATEGORY_MEANINGS[category].length > 10,
      `${category} needs an interpretable meaning`,
    );
  }
});

test('EXT-001 vocabularies: the closed least-privilege permission actions contain no workflow/credential/evidence/audit power', () => {
  assert.deepEqual([...EXTENSION_PERMISSION_ACTIONS], ['data:read', 'data:write', 'network:egress', 'secret:use']);
  // The §5 forbidden powers are structurally NOT declarable.
  for (const forbidden of ['workflow:write', 'workflow:transition', 'credential:create', 'evidence:provenance', 'audit:disable', 'admin:*']) {
    assert.ok(
      !(EXTENSION_PERMISSION_ACTIONS as readonly string[]).includes(forbidden),
      `the permission vocabulary must not contain '${forbidden}'`,
    );
  }
});

test('EXT-001 vocabularies: the closed data-scope set carries no tenant selector (tenant scope is always server-derived)', () => {
  assert.deepEqual([...EXTENSION_DATA_SCOPES], ['client:read', 'client:write', 'workspace:read', 'workspace:write']);
});

// ---------------------------------------------------------------------------
// EXT-AC-01 — the manifest shape/permission declaration contract test
// ---------------------------------------------------------------------------

test('EXT-AC-01: a fully-declared §2 manifest passes the shape guard', () => {
  assertValidExtensionManifest(validManifest());
  // Every §2 field is present and bounded (pricing metadata remains the
  // registry-visible declaration surface of a later Work Item).
  const manifest = validManifest();
  assert.equal(manifest.requiredSecretNames.length, 0);
  assert.equal(manifest.eventSubscriptions.length, 1);
});

test('EXT-AC-01: a manifest with an unknown capability category is rejected', () => {
  assertRejected(
    () =>
      assertValidExtensionManifest(
        validManifest({
          capabilities: [{ category: 'teleportation' as ExtensionManifest['capabilities'][number]['category'], name: 'x' }],
        }),
      ),
    'nine frozen capability categories',
  );
});

test('EXT-AC-01: a manifest with no capabilities is rejected', () => {
  assertRejected(() => assertValidExtensionManifest(validManifest({ capabilities: [] })), 'at least one capability');
});

test('EXT-AC-01: duplicate capability names are rejected', () => {
  assertRejected(
    () =>
      assertValidExtensionManifest(
        validManifest({
          capabilities: [
            { category: 'data-source', name: 'enrich-audience' },
            { category: 'research-discovery', name: 'enrich-audience' },
          ],
        }),
      ),
    'duplicate capability name',
  );
});

test('EXT-AC-01: non-least-privilege permission actions are rejected (workflow mutation, credential creation, evidence provenance, audit disabling)', () => {
  for (const action of ['workflow:write', 'credential:create', 'evidence:provenance', 'audit:disable']) {
    assertRejected(
      () =>
        assertValidExtensionManifest(
          validManifest({
            permissions: [{ action: action as ExtensionManifest['permissions'][number]['action'], resource: null }],
          }),
        ),
      'closed least-privilege permission vocabulary',
    );
  }
});

test('EXT-AC-01: a manifest with no permissions is rejected', () => {
  assertRejected(() => assertValidExtensionManifest(validManifest({ permissions: [] })), 'at least one permission');
});

test('EXT-AC-01: required secrets without the secret:use permission are rejected (declaration coherence)', () => {
  assertRejected(
    () =>
      assertValidExtensionManifest(
        validManifest({
          requiredSecretNames: ['DATA_PROVIDER_KEY'],
          permissions: [{ action: 'data:read', resource: null }],
        }),
      ),
    'secret:use',
  );
});

test('EXT-AC-01: network requirements without the network:egress permission are rejected (declaration coherence)', () => {
  assertRejected(
    () =>
      assertValidExtensionManifest(
        validManifest({
          networkRequirements: [{ host: 'api.example.com', protocol: 'https', port: 443, reason: 'enrichment API' }],
        }),
      ),
    'network:egress',
  );
});

test('EXT-AC-01: secret VALUES are never acceptable in a manifest (§21 material-key backstop at every nesting level)', () => {
  assertRejected(
    () =>
      assertValidExtensionManifest(
        validManifest({
          inputContract: { required: ['audienceId'], apiKey: 'sk-live-1234567890' } as Record<string, unknown>,
        }),
      ),
    'material-shaped keys',
  );
  // Nested inside an array too.
  assertRejected(
    () =>
      assertValidExtensionManifest(
        validManifest({
          outputContract: { fields: [{ token: 'abc' }] } as unknown as Record<string, unknown>,
        }),
      ),
    'material-shaped keys',
  );
});

test('EXT-AC-01: secret logical names must be UPPERCASE labels, not values', () => {
  assertRejected(
    () => assertValidExtensionManifest(validManifest({ requiredSecretNames: ['sk-live-1234567890'] })),
    'requiredSecretNames',
  );
});

test('EXT-AC-01: undeclared data-scope vocabulary is rejected', () => {
  assertRejected(
    () =>
      assertValidExtensionManifest(
        validManifest({
          dataScopes: ['global:read' as ExtensionManifest['dataScopes'][number]],
          permissions: [{ action: 'data:read', resource: null }],
        }),
      ),
    'required format',
  );
});

test('EXT-AC-01: malformed version labels, keys and publishers are rejected', () => {
  assertRejected(() => assertValidExtensionManifest(validManifest({ version: 'latest' })), 'version');
  assertRejected(() => assertValidExtensionManifest(validManifest({ extensionKey: 'AUDIENCE' })), 'extensionKey');
  assertRejected(() => assertValidExtensionManifest(validManifest({ publisher: '' })), 'publisher');
});

test('EXT-AC-01: malformed config-contract fields are rejected', () => {
  assertRejected(
    () =>
      assertValidExtensionManifest(
        validManifest({
          configContract: {
            region: { type: 'yaml', required: true, description: 'x', pattern: null },
          } as unknown as ExtensionManifest['configContract'],
        }),
      ),
    'type',
  );
});

// ---------------------------------------------------------------------------
// The frozen install lifecycle (extension-model.md §4)
// ---------------------------------------------------------------------------

test('EXT-001 lifecycle: the install statuses are exactly the frozen five', () => {
  assert.deepEqual([...EXTENSION_INSTALL_STATUSES], ['installed', 'configured', 'authorized', 'disabled', 'uninstalled']);
});

test('EXT-001 lifecycle: the frozen transition table is edge-for-edge the §4 install subset', () => {
  assert.deepEqual(EXTENSION_INSTALL_TRANSITIONS, {
    installed: ['configured', 'uninstalled'],
    configured: ['authorized', 'configured', 'uninstalled'],
    authorized: ['configured', 'disabled', 'uninstalled'],
    disabled: ['authorized', 'uninstalled'],
    uninstalled: [],
  });
});

test('EXT-001 lifecycle: uninstalled is terminal and no state transitions into installed', () => {
  assert.deepEqual([...EXTENSION_INSTALL_TERMINAL_STATUSES], ['uninstalled']);
  assert.ok(!isLegalExtensionInstallTransition('uninstalled', 'authorized'));
  assert.ok(!isLegalExtensionInstallTransition('uninstalled', 'installed'));
  assert.ok(!isLegalExtensionInstallTransition('configured', 'installed'));
  // The forward edges.
  assert.ok(isLegalExtensionInstallTransition('installed', 'configured'));
  assert.ok(isLegalExtensionInstallTransition('configured', 'authorized'));
  assert.ok(isLegalExtensionInstallTransition('authorized', 'disabled'));
  assert.ok(isLegalExtensionInstallTransition('disabled', 'authorized'));
  // Reconfigure edges.
  assert.ok(isLegalExtensionInstallTransition('configured', 'configured'));
  assert.ok(isLegalExtensionInstallTransition('authorized', 'configured'));
});

// ---------------------------------------------------------------------------
// The install input guard (least-privilege granted scopes)
// ---------------------------------------------------------------------------

test('install guard: granted scopes exceeding the manifest declaration are rejected (least-privilege)', () => {
  const manifest = validManifest(); // declares client:read + workspace:read
  assertRejected(
    () =>
      assertValidExtensionInstallInput(
        {
          scope: { agencyId: 'a', clientId: 'c', workspaceId: 'w' },
          extensionId: 'e',
          grantedScopes: ['client:write'],
          idempotencyKey: 'k',
        },
        manifest,
      ),
    "exceeds the manifest's declared data scopes",
  );
});

test('install guard: scope shape and idempotency key are required', () => {
  assertRejected(
    () =>
      assertValidExtensionInstallInput(
        {
          scope: { agencyId: null, clientId: 'c', workspaceId: 'w' },
          extensionId: 'e',
          grantedScopes: [],
          idempotencyKey: 'k',
        },
        validManifest(),
      ),
    'scope.agencyId',
  );
  assertRejected(
    () =>
      assertValidExtensionInstallInput(
        {
          scope: { agencyId: 'a', clientId: 'c', workspaceId: 'w' },
          extensionId: 'e',
          grantedScopes: [],
          idempotencyKey: '',
        },
        validManifest(),
      ),
    'idempotencyKey',
  );
});

// ---------------------------------------------------------------------------
// The config contract validation
// ---------------------------------------------------------------------------

test('config validation: required fields, types, patterns and undeclared keys', () => {
  const contract = validManifest().configContract;
  assert.deepEqual(validateConfigAgainstContract({ region: 'eu' }, contract), []);
  assert.deepEqual(validateConfigAgainstConfigMissingRequired(), ['config.region: required by the manifest config contract']);
  function validateConfigAgainstConfigMissingRequired(): string[] {
    return validateConfigAgainstContract({}, contract);
  }
  assert.ok(validateConfigAgainstContract({ region: 'mars' }, contract).some((problem) => problem.includes('pattern')));
  assert.ok(validateConfigAgainstContract({ region: 7 }, contract).some((problem) => problem.includes('must be a string')));
  assert.ok(validateConfigAgainstContract({ extra: 1 }, contract).some((problem) => problem.includes('not declared')));
});

test('configure guard: every required secret logical name must be bound, unknown bindings rejected, material config rejected', () => {
  const manifest = validManifest({
    requiredSecretNames: ['DATA_PROVIDER_KEY'],
    permissions: [
      { action: 'data:read', resource: null },
      { action: 'secret:use', resource: null },
    ],
  });
  // Missing the required binding.
  assertRejected(
    () =>
      assertValidExtensionConfigureInput(
        { installId: 'i', config: { region: 'eu' }, secretBindings: {}, expectedVersion: 1 },
        manifest,
      ),
    'DATA_PROVIDER_KEY',
  );
  // Binding a name the manifest does not require.
  assertRejected(
    () =>
      assertValidExtensionConfigureInput(
        {
          installId: 'i',
          config: { region: 'eu' },
          secretBindings: { OTHER_KEY: 'cred-1', DATA_PROVIDER_KEY: 'cred-2' },
          expectedVersion: 1,
        },
        manifest,
      ),
    'not a required secret logical name',
  );
  // A secret VALUE smuggled as a config value.
  assertRejected(
    () =>
      assertValidExtensionConfigureInput(
        {
          installId: 'i',
          config: { region: 'eu', apiKey: 'sk-live-123' },
          secretBindings: { DATA_PROVIDER_KEY: 'cred-1' },
          expectedVersion: 1,
        },
        manifest,
      ),
    'material-shaped keys',
  );
});

// ---------------------------------------------------------------------------
// The invocation input guard
// ---------------------------------------------------------------------------

test('invocation guard: undeclared capabilities are rejected (the granted capability set is bounded by the manifest)', () => {
  assertRejected(
    () =>
      assertValidExtensionInvocationInput(
        {
          executionId: 'x',
          extensionId: 'e',
          requestedCapabilities: ['launch-missiles'],
          input: { audienceId: 'a1' },
        },
        validManifest(),
      ),
    'not a declared capability',
  );
});

test('invocation guard: duplicate and empty capability lists are rejected', () => {
  assertRejected(
    () =>
      assertValidExtensionInvocationInput(
        {
          executionId: 'x',
          extensionId: 'e',
          requestedCapabilities: ['enrich-audience', 'enrich-audience'],
          input: { audienceId: 'a1' },
        },
        validManifest(),
      ),
    'duplicate',
  );
  assertRejected(
    () =>
      assertValidExtensionInvocationInput(
        { executionId: 'x', extensionId: 'e', requestedCapabilities: [], input: { audienceId: 'a1' } },
        validManifest(),
      ),
    'non-empty',
  );
});

test('invocation guard: authority-shaped keys inside the input are rejected (server-derived identity/scope/provenance/policy posture)', () => {
  for (const key of ['provenance', 'actor', 'agencyId', 'scope', 'policyOutcome', 'evidenceId']) {
    assertRejected(
      () =>
        assertValidExtensionInvocationInput(
          {
            executionId: 'x',
            extensionId: 'e',
            requestedCapabilities: ['enrich-audience'],
            input: { audienceId: 'a1', [key]: 'smuggled' },
          },
          validManifest(),
        ),
      key,
    );
  }
});

test('invocation guard: material-shaped keys inside the input are rejected at every nesting level (§21 durable extension input blobs)', () => {
  assertRejected(
    () =>
      assertValidExtensionInvocationInput(
        {
          executionId: 'x',
          extensionId: 'e',
          requestedCapabilities: ['enrich-audience'],
          input: { audienceId: 'a1', nested: { secretMaterial: 'x' } },
        },
        validManifest(),
      ),
    'material-shaped',
  );
});

test('invocation guard: manifest-required input keys must be present', () => {
  assertRejected(
    () =>
      assertValidExtensionInvocationInput(
        {
          executionId: 'x',
          extensionId: 'e',
          requestedCapabilities: ['enrich-audience'],
          input: { somethingElse: 1 },
        },
        validManifest(),
      ),
    'audienceId',
  );
});

test('provenance guard: incomplete server-derived provenance is rejected', () => {
  assertRejected(
    () => assertValidInvocationProvenance({ actor: '', recordedVia: 'api', correlationId: 'c', causationId: null }),
    'actor',
  );
});

// ---------------------------------------------------------------------------
// The pure context composition + the EXT-AC-02 scope predicate
// ---------------------------------------------------------------------------

test('context composition: granted capabilities, granted scopes, canonical scope and the TTL', () => {
  const manifest = validManifest({
    capabilities: [
      { category: 'data-source', name: 'enrich-audience' },
      { category: 'research-discovery', name: 'discover-lookalikes' },
    ],
    dataScopes: ['client:read', 'workspace:read'],
  });
  const { context, grantedCapabilities, grantedDataScopes } = composeInvocationContext({
    invocationId: 'v3333333-3333-4333-8333-333333333333',
    extension: registryRecord(manifest),
    install: installRecord(['client:read', 'workspace:read']),
    executionId: 'x4444444-4444-4444-8444-444444444444',
    scope: {
      agencyId: 'b3c1a111-1111-4111-8111-111111111111',
      clientId: 'c4d2a222-2222-4222-8222-222222222222',
      workspaceId: 'w5e3a333-3333-4333-8333-333333333333',
    },
    requestedCapabilities: ['enrich-audience'],
    policyDecisionId: 'd5555555-5555-4555-8555-555555555555',
    input: { audienceId: 'a1' },
    provenance: PROVENANCE,
    issuedAt: ISSUED_AT,
    ttlMs: DEFAULT_INVOCATION_TTL_MS,
  });
  assert.deepEqual(grantedCapabilities, [{ category: 'data-source', name: 'enrich-audience' }]);
  assert.deepEqual(grantedDataScopes, ['client:read', 'workspace:read']);
  assert.equal(context.scope.kind, 'extension-invocation');
  assert.equal(context.scope.agencyId, 'b3c1a111-1111-4111-8111-111111111111');
  assert.equal(context.executionId, 'x4444444-4444-4444-8444-444444444444');
  assert.equal(context.policyDecisionId, 'd5555555-5555-4555-8555-555555555555');
  assert.equal(context.runtimeClass, 'pooled-worker');
  // The short-lived window.
  assert.equal(context.expiresAt, '2026-01-15T10:05:00.000Z');
  assert.equal(Date.parse(context.expiresAt) - Date.parse(context.issuedAt), DEFAULT_INVOCATION_TTL_MS);
  // A context NEVER carries credential-shaped fields.
  for (const forbidden of ['secret', 'secretHandle', 'token', 'material']) {
    assert.ok(!JSON.stringify(context).includes(`"${forbidden}":`), `the context must not carry '${forbidden}'`);
  }
});

test('context composition: the granted data scopes are the install grant INTERSECTED with the manifest declaration', () => {
  // The manifest declares client:read only; the install was granted more
  // (impossible through the API, but the composition is defensive).
  const manifest = validManifest({ dataScopes: ['client:read'] });
  const { grantedDataScopes } = composeInvocationContext({
    invocationId: 'v3333333-3333-4333-8333-333333333333',
    extension: registryRecord(manifest),
    install: installRecord(['client:read', 'workspace:read']),
    executionId: 'x4444444-4444-4444-8444-444444444444',
    scope: {
      agencyId: 'a',
      clientId: 'c',
      workspaceId: 'w',
    },
    requestedCapabilities: ['enrich-audience'],
    policyDecisionId: 'd',
    input: { audienceId: 'a1' },
    provenance: PROVENANCE,
    issuedAt: ISSUED_AT,
    ttlMs: DEFAULT_INVOCATION_TTL_MS,
  });
  assert.deepEqual(grantedDataScopes, ['client:read']);
});

test('EXT-AC-02 predicate: invocation grants ONLY the granted scopes of the OWNING client/workspace', () => {
  const manifest = validManifest({ dataScopes: ['client:read', 'workspace:read'] });
  const { context } = composeInvocationContext({
    invocationId: 'v3333333-3333-4333-8333-333333333333',
    extension: registryRecord(manifest),
    install: installRecord(['client:read', 'workspace:read']),
    executionId: 'x4444444-4444-4444-8444-444444444444',
    scope: {
      agencyId: 'b3c1a111-1111-4111-8111-111111111111',
      clientId: 'c4d2a222-2222-4222-8222-222222222222',
      workspaceId: 'w5e3a333-3333-4333-8333-333333333333',
    },
    requestedCapabilities: ['enrich-audience'],
    policyDecisionId: 'd',
    input: { audienceId: 'a1' },
    provenance: PROVENANCE,
    issuedAt: ISSUED_AT,
    ttlMs: DEFAULT_INVOCATION_TTL_MS,
  });
  const own = {
    agencyId: context.scope.agencyId,
    clientId: context.scope.clientId,
    workspaceId: context.scope.workspaceId,
  };
  // Granted scope, owning tenant → granted.
  assert.ok(invocationGrantsDataScope(context, { ...own, scope: 'client:read' }));
  assert.ok(invocationGrantsDataScope(context, { ...own, scope: 'workspace:read' }));
  // UNgranted scope, owning tenant → fail closed.
  assert.ok(!invocationGrantsDataScope(context, { ...own, scope: 'client:write' }));
  // Granted scope label, FOREIGN tenant → never granted (unrelated client data).
  assert.ok(
    !invocationGrantsDataScope(context, {
      agencyId: context.scope.agencyId,
      clientId: '99999999-9999-4999-8999-999999999999',
      workspaceId: null,
      scope: 'client:read',
    }),
  );
  // Foreign workspace of the same client → not granted (scope mismatch).
  assert.ok(
    !invocationGrantsDataScope(context, {
      agencyId: context.scope.agencyId,
      clientId: context.scope.clientId,
      workspaceId: 'w8888888-8888-4888-8888-888888888888',
      scope: 'workspace:read',
    }),
  );
});

test('the invocation TTL window: expiry predicate + the bounded maximum', () => {
  assert.ok(MAX_INVOCATION_TTL_MS >= DEFAULT_INVOCATION_TTL_MS);
  const expiresAt = '2026-01-15T10:05:00.000Z';
  assert.ok(!isInvocationContextExpired({ expiresAt }, '2026-01-15T10:04:59.999Z'));
  assert.ok(isInvocationContextExpired({ expiresAt }, '2026-01-15T10:05:00.000Z'));
  assert.ok(isInvocationContextExpired({ expiresAt }, '2026-01-15T10:05:00.001Z'));
});

// ---------------------------------------------------------------------------
// The deterministic manifest fingerprint
// ---------------------------------------------------------------------------

test('the manifest fingerprint is deterministic and key-order-insensitive', () => {
  const manifest = validManifest();
  const reordered: ExtensionManifest = {
    runtimeClass: manifest.runtimeClass,
    uiSurfaces: manifest.uiSurfaces,
    eventSubscriptions: manifest.eventSubscriptions,
    outputContract: manifest.outputContract,
    inputContract: manifest.inputContract,
    networkRequirements: manifest.networkRequirements,
    dataScopes: manifest.dataScopes,
    requiredSecretNames: manifest.requiredSecretNames,
    permissions: manifest.permissions,
    capabilities: manifest.capabilities,
    compatibility: manifest.compatibility,
    version: manifest.version,
    publisher: manifest.publisher,
    extensionKey: manifest.extensionKey,
    configContract: { region: manifest.configContract['region']! },
  };
  assert.equal(extensionCreateFingerprint(manifest), extensionCreateFingerprint(reordered));
  const different = validManifest({ version: '1.5.0' });
  assert.notEqual(extensionCreateFingerprint(manifest), extensionCreateFingerprint(different));
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

test('purity: identical inputs produce identical guards/compositions', () => {
  const manifest = validManifest();
  assert.doesNotThrow(() => assertValidExtensionManifest(manifest));
  assert.doesNotThrow(() => assertValidExtensionManifest(manifest));
  const first = composeInvocationContext({
    invocationId: 'v',
    extension: registryRecord(manifest),
    install: installRecord(['client:read']),
    executionId: 'x',
    scope: { agencyId: 'a', clientId: 'c', workspaceId: 'w' },
    requestedCapabilities: ['enrich-audience'],
    policyDecisionId: 'd',
    input: { audienceId: 'a1' },
    provenance: PROVENANCE,
    issuedAt: ISSUED_AT,
    ttlMs: DEFAULT_INVOCATION_TTL_MS,
  });
  const second = composeInvocationContext({
    invocationId: 'v',
    extension: registryRecord(manifest),
    install: installRecord(['client:read']),
    executionId: 'x',
    scope: { agencyId: 'a', clientId: 'c', workspaceId: 'w' },
    requestedCapabilities: ['enrich-audience'],
    policyDecisionId: 'd',
    input: { audienceId: 'a1' },
    provenance: PROVENANCE,
    issuedAt: ISSUED_AT,
    ttlMs: DEFAULT_INVOCATION_TTL_MS,
  });
  assert.deepEqual(first, second);
});
