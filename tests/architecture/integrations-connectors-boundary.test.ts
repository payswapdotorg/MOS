/**
 * MKT-024 static architecture tests — the FIRST-PARTY CONNECTORS are
 * structurally correct and PROVIDER-ISOLATED in the ACTUAL boundary source
 * tree (pure static analysis, no DB; the ai-routing-boundary precedent).
 *
 * Acceptance proofs (requirements.md INT-001 + METRIC-001; work-items.md
 * MKT-024; work-item-matrix.md "connector contract + source mapping
 * tests"; Tech-Lead guidance "provider isolation: NO provider SDK/API
 * import outside internal/adapters/**; domain modules import ONLY port
 * contracts; no second integration boundary"):
 *
 *   1. the five first-party connector subtrees EXIST under the sanctioned
 *      home src/modules/integrations/internal/adapters/<provider>/ (meta,
 *      google-ads, analytics, crm, commerce);
 *   2. every connector adapter file imports ONLY node builtins, the
 *      /integrations public entry (the PORT contract), the shared
 *      provider-neutral support module and the platform HttpCallPort —
 *      NO provider SDK, NO cross-module import, NO application-layer
 *      import, NO adapter→adapter import;
 *   3. the boundary CORE (public contract + module core + store) contains
 *      NO provider-specific branch — no first-party provider name appears
 *      anywhere outside the adapter subtrees and the composition-root
 *      wiring (the registry is DATA, never code branches);
 *   4. NO file anywhere in src/ imports a provider SDK package (the
 *      marketing-provider denylist: Meta/Google/analytics/CRM/commerce
 *      SDK package spellings);
 *   5. the concrete connectors are imported ONLY by the composition root,
 *      which registers exactly the five first-party adapters as DATA into
 *      the module's adapter set (the frozen "Composition root" wiring);
 *   6. there is NO second integration boundary: no other module declares
 *      adapter/connection/webhook-ingestion surfaces (the /integrations
 *      authority is unique);
 *   7. the source-mapping contracts the connectors emit (envelope kinds,
 *      §20 support list: provider ids, source timestamp, ETag, version,
 *      rate-limit) are visible in the adapter code and consumed by the
 *      server-side delivery emitter in src/api (METRIC-001), which itself
 *      imports ONLY the module PUBLIC entries.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
const read = (path: string): string => readFileSync(path, 'utf8');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs));
    else if (entry.name.endsWith('.ts')) out.push(abs);
  }
  return out;
}

const allSrcFiles = walk(src());

/** Imports of `file` as raw specifier strings. */
function importsOf(file: string): string[] {
  const text = read(file);
  const specifiers: string[] = [];
  for (const match of text.matchAll(/from\s+'([^']+)'/g)) specifiers.push(match[1]!);
  for (const match of text.matchAll(/import\s+'([^']+)'/g)) specifiers.push(match[1]!);
  for (const match of text.matchAll(/from\s+"([^"]+)"/g)) specifiers.push(match[1]!);
  return specifiers;
}

/**
 * Strips block and line comments so code-token checks do not match
 * documentation examples (a provider name quoted in a doc comment is not
 * a code branch).
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'" ])\/\/[^\n]*/g, '$1');
}

const ADAPTERS_DIR = src('modules', 'integrations', 'internal', 'adapters');
const FIRST_PARTY_CONNECTORS = ['meta', 'google-ads', 'analytics', 'crm', 'commerce'] as const;
const FIRST_PARTY_ADAPTER_KEYS = ['meta-ads', 'google-ads', 'generic-analytics', 'crm', 'commerce-cms'] as const;

const connectorFiles: string[] = [];
for (const provider of FIRST_PARTY_CONNECTORS) {
  const providerDir = join(ADAPTERS_DIR, provider);
  for (const file of walk(providerDir)) connectorFiles.push(file);
}

const boundaryCoreFiles = [
  src('modules', 'integrations', 'public.ts'),
  src('modules', 'integrations', 'internal', 'module.ts'),
  src('modules', 'integrations', 'internal', 'store.ts'),
  src('modules', 'integrations', 'internal', 'policy-gate.ts'),
];

// ---------------------------------------------------------------------------
// 1. The sanctioned first-party connector home
// ---------------------------------------------------------------------------

test('INT-001 static: the five first-party connector subtrees exist under internal/adapters/<provider>/', () => {
  for (const provider of FIRST_PARTY_CONNECTORS) {
    assert.ok(
      existsSync(join(ADAPTERS_DIR, provider)),
      `the ${provider} connector subtree exists under the sanctioned adapter home`,
    );
  }
  assert.ok(connectorFiles.length >= 5, 'one adapter file per connector subtree at minimum');
});

// ---------------------------------------------------------------------------
// 2. Connector adapters import ONLY the port contract + shared support
// ---------------------------------------------------------------------------

test('INT-001 static: every connector adapter file implements the generic port and imports ONLY allowed surfaces', () => {
  // The exact allowed import specifiers for a connector adapter file at
  // internal/adapters/<provider>/<provider>-adapter.ts: the module PUBLIC
  // entry (the PORT), the shared provider-neutral support module and the
  // platform HttpCallPort contract (fetch-based — no provider SDK).
  const ALLOWED_CONNECTOR_IMPORTS = new Set([
    '../../../public.ts',
    '../../adapter-support.ts',
    '../../../../../platform/http/outbound.ts',
  ]);
  for (const file of connectorFiles) {
    for (const specifier of importsOf(file)) {
      if (specifier.startsWith('node:')) continue;
      assert.ok(
        ALLOWED_CONNECTOR_IMPORTS.has(specifier),
        `${file}: connector adapters may import ONLY the module public entry (the PORT), the shared adapter support module and the platform HttpCallPort — found '${specifier}'`,
      );
    }
  }
  // Every connector implements the generic port contract.
  for (const file of connectorFiles) {
    const text = read(file);
    assert.ok(
      text.includes('implements IntegrationAdapter'),
      `${file}: the connector implements the generic IntegrationAdapter port`,
    );
  }
});

test('INT-001 static: NO provider SDK import anywhere in src/ (marketing provider denylist)', () => {
  const providerSdkPackages = [
    'facebook',
    'facebook-node-sdk',
    '@facebook/node-sdk',
    'fb',
    'googleapis',
    '@google-cloud/ads',
    'google-ads-api',
    'google-ads-node',
    'ga4',
    'gtag',
    'hubspot',
    'salesforce',
    'jsforce',
    'zoho',
    'shopify',
    '@shopify/shopify-api',
    'contentful',
    'strapi',
    'wordpress',
  ];
  for (const file of allSrcFiles) {
    for (const specifier of importsOf(file)) {
      if (specifier.startsWith('.') || specifier.startsWith('node:') || specifier.startsWith('/')) continue;
      for (const sdk of providerSdkPackages) {
        assert.ok(
          specifier !== sdk && specifier !== `${sdk}/`,
          `${file}: no provider SDK may be imported anywhere in src/ (found '${specifier}')`,
        );
      }
    }
  }
});

test('INT-001 static: NO adapter→adapter imports (each connector depends on contracts only)', () => {
  for (const file of connectorFiles) {
    for (const specifier of importsOf(file)) {
      assert.ok(
        !specifier.includes('/adapters/'),
        `${file}: an adapter may never import another adapter (found '${specifier}') — depend on the port contract and the shared support module`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 3. The boundary core has NO provider branches (the registry is data)
// ---------------------------------------------------------------------------

test('INT-001 static: no first-party provider name appears in the boundary core — the registry is DATA, never code branches', () => {
  for (const file of boundaryCoreFiles) {
    const code = stripComments(read(file));
    for (const key of FIRST_PARTY_ADAPTER_KEYS) {
      assert.ok(
        !code.includes(`'${key}'`),
        `${file}: the boundary core must not reference the first-party adapter key '${key}' (the registry is injected data, not code branches)`,
      );
    }
    for (const provider of FIRST_PARTY_CONNECTORS) {
      // 'crm' also matches the innocuous substring of other words — check
      // it as a quoted/word token only.
      assert.ok(
        !code.includes(`'${provider}'`) && !code.includes(`"${provider}"`),
        `${file}: the boundary core must not reference the provider '${provider}'`,
      );
    }
  }
});

test('INT-001 static: provider-specific code lives ONLY under internal/adapters/** (plus the composition-root wiring)', () => {
  for (const file of allSrcFiles) {
    const relativeToSrc = file.slice(src().length + 1);
    const isConnectorFile = file.startsWith(ADAPTERS_DIR);
    const isCompositionRoot = relativeToSrc === join('composition-root.ts');
    const isAdapterContractHome = file === join(ADAPTERS_DIR, 'adapter-contract.ts');
    const isAdapterSupport = file === src('modules', 'integrations', 'internal', 'adapter-support.ts');
    if (isConnectorFile || isCompositionRoot || isAdapterContractHome || isAdapterSupport) continue;
    const code = stripComments(read(file));
    for (const key of FIRST_PARTY_ADAPTER_KEYS) {
      // The adapter KEY appears only in adapter-land + the wiring; the
      // integration tests are under tests/ (not scanned here).
      assert.ok(
        !code.includes(`'${key}'`),
        `${file}: the first-party adapter key '${key}' may appear only in the adapter subtrees and the composition-root wiring`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 4. The composition root wires exactly the five first-party connectors
// ---------------------------------------------------------------------------

test('INT-001 static: the composition root registers EXACTLY the five first-party connectors as DATA', () => {
  const compositionRoot = read(src('composition-root.ts'));
  for (const provider of FIRST_PARTY_CONNECTORS) {
    assert.ok(
      compositionRoot.includes(`internal/adapters/${provider}/${provider}-adapter.ts`),
      `the composition root wires the ${provider} connector`,
    );
  }
  assert.ok(
    compositionRoot.includes('adapters: [') && compositionRoot.includes('new MetaAdsAdapter({ http: httpCalls })'),
    'the connectors are constructed on the platform HttpCallPort and injected as the module adapter DATA',
  );
});

test('INT-001 static: the concrete connectors are imported ONLY by the composition root', () => {
  for (const file of allSrcFiles) {
    const relativeToSrc = file.slice(src().length + 1);
    if (relativeToSrc === join('composition-root.ts')) continue;
    for (const specifier of importsOf(file)) {
      assert.ok(
        !specifier.includes('/internal/adapters/'),
        `${file}: concrete module-internal adapters are importable only by the composition root (found '${specifier}')`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 5. No second integration boundary
// ---------------------------------------------------------------------------

test('INT-001 static: there is NO second integration boundary — no other module declares adapter/connection/webhook surfaces', () => {
  for (const file of allSrcFiles) {
    if (file.startsWith(src('modules', 'integrations'))) continue;
    if (file.startsWith(src('modules', 'extensions'))) continue; // the extension host is a separate frozen authority
    const relativeToSrc = file.slice(src().length + 1);
    if (!relativeToSrc.startsWith(join('modules'))) continue;
    const text = read(file);
    assert.ok(
      !text.includes('interface IntegrationAdapter') && !text.includes('IntegrationAdapterCallContext'),
      `${file}: only /integrations may declare the integration adapter port (no second boundary)`,
    );
    assert.ok(
      !text.includes('IntegrationConnectionRecord'),
      `${file}: only /integrations may declare connection records (no second boundary)`,
    );
  }
});

// ---------------------------------------------------------------------------
// 6. The METRIC-001 delivery path (server-side emitter) imports only
//    module PUBLIC entries
// ---------------------------------------------------------------------------

test('METRIC-001 static: the server-side observation delivery imports ONLY module public entries', () => {
  const emitter = read(src('api', 'integration-observations.ts'));
  for (const specifier of importsOf(src('api', 'integration-observations.ts'))) {
    if (specifier.startsWith('node:')) continue;
    assert.ok(
      specifier.endsWith('/public.ts') || specifier.startsWith('../platform/'),
      `src/api/integration-observations.ts may import only module public entries and platform contracts — found '${specifier}'`,
    );
  }
  // The METRIC-001 mapping shape is declared in the emitter.
  assert.ok(emitter.includes('observedAt'), 'the observation timestamp mapping is explicit');
  assert.ok(emitter.includes('retrievedAt'), 'the retrieval timestamp mapping is explicit (kept distinct)');
  assert.ok(emitter.includes("class: 'source_fact'"), 'the evidence class is pinned to source_fact (never fabricated)');
  assert.ok(emitter.includes("quality: 'C'"), 'the evidence quality is pinned (never caller-supplied)');
});

test('METRIC-001 static: the sync route delivers through the /metrics and /evidence module APIs (never their internals)', () => {
  const routes = read(src('api', 'integrations-routes.ts'));
  assert.ok(routes.includes("'/api/clients/:clientId/connections/:connectionId/sync'"), 'the sync route exists');
  assert.ok(routes.includes('deliverReadObservations'), 'the route composes the delivery emitter');
  for (const specifier of importsOf(src('api', 'integrations-routes.ts'))) {
    if (specifier.startsWith('node:')) continue;
    assert.ok(
      specifier.endsWith('/public.ts') || specifier.startsWith('../platform/') || specifier.startsWith('./'),
      `src/api/integrations-routes.ts may import only module public entries, platform contracts and api helpers — found '${specifier}'`,
    );
  }
});

// ---------------------------------------------------------------------------
// 7. The §20 support list is visible in the connector contracts
// ---------------------------------------------------------------------------

test('INT-001 static (§20): the connector files surface the frozen support list — provider ids, source timestamp, ETag, version, rate-limit, webhook verification', () => {
  for (const file of connectorFiles) {
    const text = read(file);
    assert.ok(text.includes('providerRecordId'), `${file}: provider identifiers are normalized`);
    assert.ok(text.includes('sourceTimestamp'), `${file}: source timestamps are mapped`);
    assert.ok(text.includes('etag'), `${file}: the ETag metadata path is surfaced`);
  }
  const support = read(src('modules', 'integrations', 'internal', 'adapter-support.ts'));
  assert.ok(support.includes('parseRateLimitHeaders'), 'the rate-limit/backoff metadata parsing exists');
  assert.ok(support.includes('verifyHmacWebhookDelivery'), 'the webhook authenticity verification primitive exists');
  assert.ok(support.includes('NormalizedRateLimit'), 'the normalized rate-limit contract is consumed');
  const googleAds = read(join(ADAPTERS_DIR, 'google-ads', 'google-ads-adapter.ts'));
  assert.ok(googleAds.includes('sourceVersion'), 'the google-ads connector maps source version metadata (§20)');
  const commerce = read(join(ADAPTERS_DIR, 'commerce', 'commerce-adapter.ts'));
  assert.ok(commerce.includes('sourceVersion'), 'the commerce/CMS connector maps content version metadata (§20)');
});

test('INT-001 static: the MKT-023 boundary surface is UNCHANGED in shape (no port moves, no second adapter mechanism)', () => {
  const publicContract = read(src('modules', 'integrations', 'public.ts'));
  assert.ok(publicContract.includes('export interface IntegrationAdapter'), 'the frozen port contract is intact');
  assert.ok(publicContract.includes('adapters: readonly IntegrationAdapter[]'), 'the first-party registration surface (adapter DATA) is intact');
  assert.ok(publicContract.includes('buildAdapterRegistry'), 'the single adapter mechanism (the validated registry) is intact');
  // No second mechanism was added to the boundary for MKT-024.
  const internalFiles = walk(src('modules', 'integrations', 'internal'));
  for (const file of internalFiles) {
    if (file.startsWith(ADAPTERS_DIR)) continue;
    const text = read(file);
    assert.ok(
      !text.includes('registerFirstPartyAdapter'),
      `${file}: no second adapter registration mechanism may exist`,
    );
  }
});
