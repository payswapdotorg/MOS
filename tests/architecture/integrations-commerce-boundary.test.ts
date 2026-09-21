/**
 * MKT-071 static architecture tests — the COMMERCE CAPABILITY layer of the
 * EXISTING /integrations boundary is structurally correct and
 * provider-isolated in the ACTUAL source tree (pure static analysis, no
 * DB; the integrations-connectors-boundary precedent).
 *
 * Acceptance proofs (spec/effective-backlog-v1.6.md MKT-071; spec/
 * architecture-v1.6.md §15/§16; spec/module-dependency-matrix-v1.6.md
 * boundary rule 8: "Commerce Discovery never writes directly to
 * catalog/order tables; store mutations flow through Integrations"):
 *
 *   1. the commerce adapter subtree carries BOTH first-party commerce
 *      connectors: the MKT-024 commerce-cms connector (EXTENDED with the
 *      read-only commerce surface) and the MKT-071 commerce-store
 *      connector (the full surface incl. the authorized mutations);
 *   2. the READ-ONLY commerce adapter (commerce-cms) declares NO
 *      mutation-kind capability — the adapter NEVER claims a mutation
 *      capability its provider does not grant (AC-4);
 *   3. the commerce-store adapter declares exactly the two mutating
 *      commerce capabilities (commerce-product-write,
 *      commerce-listing-manage) as kind 'mutation';
 *   4. the frozen commerce vocabularies in the module contract
 *      (public.ts) are CHECK-fence-mirrored by migration 049 (event
 *      kinds, outcomes, mutation capability keys) — the code and the
 *      database cannot drift apart silently;
 *   5. migration 049 owns ONLY the /integrations-module commerce tables
 *      (the dedup fence, the event projection, the mutation ledger): NO
 *      catalog/product/listing/price/inventory/order table exists
 *      anywhere in MOS (the provider store stays the sole catalog/order
 *      authority — boundary rule 8) and the migration holds its numeric
 *      position at the end of the ordered migration list (047/048 are
 *      PRE-ASSIGNED to sibling deliveries);
 *   6. the webhook idempotency design is visible: the dedup fence is a
 *      UNIQUE (adapter_key, provider_event_id) index; the event history
 *      is append-only (UPDATE/DELETE rejected by triggers); a replay is
 *      the honest 'duplicate-received' outcome — never a silent drop;
 *   7. attribution is PASSTHROUGH ONLY (§16): the commerce mappers carry
 *      the provider's attribution/reference fields verbatim; NO
 *      attribution linking, matching or causal computation exists
 *      anywhere in the commerce layer (MKT-073 owns that later);
 *   8. store mutations are recorded through the boundary ONLY: every
 *      commerce mutation lands in the append-only commerce_mutation_
 *      records ledger with its capability key and gating policy decision
 *      (the boundary-rule-8 audit surface); the module core carries NO
 *      provider branch (the registry-is-data posture of the MKT-023
 *      boundary tests, extended additively with the commerce-store key).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
const read = (path: string): string => readFileSync(path, 'utf8');

/** Strips comments so code-token checks do not match documentation. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'" ])\/\/[^\n]*/g, '$1');
}

const commerceAdapter = read(src('modules', 'integrations', 'internal', 'adapters', 'commerce', 'commerce-adapter.ts'));
const commerceStoreAdapter = read(src('modules', 'integrations', 'internal', 'adapters', 'commerce', 'commerce-store-adapter.ts'));
const adapterSupport = read(src('modules', 'integrations', 'internal', 'adapter-support.ts'));
const publicContract = read(src('modules', 'integrations', 'public.ts'));
const moduleCore = read(src('modules', 'integrations', 'internal', 'module.ts'));
const storeCode = read(src('modules', 'integrations', 'internal', 'store.ts'));
const routesCode = read(src('api', 'integrations-routes.ts'));
const migration049 = read(src('platform', 'db', 'migrations', '049_commerce_capabilities.sql'));

// ---------------------------------------------------------------------------
// 1. The two first-party commerce connectors
// ---------------------------------------------------------------------------

test('MKT-071 static: BOTH first-party commerce connectors exist under the sanctioned adapter home', () => {
  assert.ok(existsSync(src('modules', 'integrations', 'internal', 'adapters', 'commerce', 'commerce-adapter.ts')));
  assert.ok(existsSync(src('modules', 'integrations', 'internal', 'adapters', 'commerce', 'commerce-store-adapter.ts')));
  assert.ok(commerceAdapter.includes('implements IntegrationAdapter'));
  assert.ok(commerceStoreAdapter.includes('implements IntegrationAdapter'));
});

// ---------------------------------------------------------------------------
// 2/3. The capability-subset declarations (AC-1/AC-4)
// ---------------------------------------------------------------------------

test('MKT-071 AC-4 static: the READ-ONLY commerce adapter declares NO mutation capability (never claims what the provider does not grant)', () => {
  const capabilities = commerceAdapter.slice(
    commerceAdapter.indexOf('readonly capabilities'),
    commerceAdapter.indexOf('private readonly http'),
  );
  // The commerce/CMS platform grants READ scopes only.
  assert.ok(!capabilities.includes("kind: 'mutation'"), 'commerce-cms never declares a mutation capability');
  assert.ok(capabilities.includes("'commerce-catalog-read'"));
  assert.ok(capabilities.includes("'commerce-product-read'"));
  assert.ok(capabilities.includes("'commerce-price-read'"));
  assert.ok(capabilities.includes("'commerce-inventory-read'"));
  // The honest no-mutation refusal is the adapter's declared posture.
  assert.ok(commerceAdapter.includes('commerce-cms declares no mutation capability'));
});

test('MKT-071 AC-1 static: the commerce-store adapter declares the FULL surface — the two mutating commerce capabilities are kind mutation, the reads + webhook present', () => {
  const capabilities = commerceStoreAdapter.slice(
    commerceStoreAdapter.indexOf('readonly capabilities'),
    commerceStoreAdapter.indexOf('private readonly http'),
  );
  for (const key of ['commerce-catalog-read', 'commerce-product-read', 'commerce-price-read', 'commerce-inventory-read', 'commerce-orders-read', 'commerce-order-webhook']) {
    assert.ok(capabilities.includes(`'${key}'`), `commerce-store declares ${key}`);
  }
  // The mutating capabilities are declared as mutations (where the
  // provider authorizes them — the policy gate carries these keys).
  for (const key of ['commerce-product-write', 'commerce-listing-manage']) {
    const index = capabilities.indexOf(`capabilityKey: '${key}'`);
    assert.ok(index !== -1, `commerce-store declares ${key}`);
    const kind = capabilities.slice(index, index + 200);
    assert.ok(kind.includes("kind: 'mutation'"), `${key} is declared as a mutation capability`);
  }
  // The order-read capability carries BOTH operations (the MKT-024
  // revenue continuity + the MKT-071 line-item records).
  assert.ok(commerceStoreAdapter.includes("'listOrders', 'listOrderRecords'"));
});

// ---------------------------------------------------------------------------
// 4. The vocabulary fences: the module contract mirrors migration 049
// ---------------------------------------------------------------------------

test('MKT-071 AC-9 static: the frozen commerce vocabularies in public.ts are CHECK-fence-mirrored by migration 049', () => {
  // Event kinds: order/product/listing.
  for (const kind of ['order', 'product', 'listing']) {
    assert.ok(publicContract.includes(`'${kind}'`), `public.ts declares the ${kind} event kind`);
    assert.ok(
      migration049.includes(`'${kind}'`),
      `migration 049 CHECK-fences the ${kind} event kind`,
    );
  }
  // Outcomes: ingested / duplicate-received.
  assert.ok(publicContract.includes("'duplicate-received'"));
  assert.ok(migration049.includes("('ingested', 'duplicate-received')"));
  // The mutation capability keys: commerce-product-write / commerce-listing-manage.
  assert.ok(migration049.includes("('commerce-product-write',\n                                                    'commerce-listing-manage')"));
  // The dedup fence key: (adapter_key, provider_event_id).
  assert.ok(migration049.includes('commerce_webhook_event_fences_provider_event_fence'));
  assert.ok(migration049.includes('ON commerce_webhook_event_fences (adapter_key, provider_event_id)'));
});

// ---------------------------------------------------------------------------
// 5. The table-ownership choice (the provider store stays the sole
//    catalog/order authority)
// ---------------------------------------------------------------------------

test('MKT-071 static (boundary rule 8): migration 049 owns ONLY the /integrations commerce tables — NO catalog/product/listing/price/inventory/order table exists anywhere', () => {
  // The three own tables.
  for (const table of ['commerce_webhook_event_fences', 'commerce_events', 'commerce_mutation_records']) {
    assert.ok(migration049.includes(`CREATE TABLE IF NOT EXISTS ${table} (`), `migration 049 creates ${table}`);
  }
  // No catalog/order authority: the migration creates exactly THREE tables.
  const createdTables = [...migration049.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \(/g)].map((match) => match[1]);
  assert.deepEqual(createdTables.sort(), ['commerce_events', 'commerce_mutation_records', 'commerce_webhook_event_fences']);
  // The disclosed projection choice: the comment documents it.
  assert.ok(migration049.includes('NO CATALOG/PRODUCT/LISTING/ORDER AUTHORITY IS CREATED HERE'));
  // No commerce/catalog/order TABLE is created outside migration 049 (the
  // growth-missions objective-family vocabulary legitimately mentions
  // 'commerce_discovery' as a mission family VALUE — not a table).
  const migrationsDir = src('platform', 'db', 'migrations');
  for (const name of readdirSync(migrationsDir).filter((entry) => entry.endsWith('.sql'))) {
    if (name === '049_commerce_capabilities.sql') continue;
    const content = read(join(migrationsDir, name));
    const createdTables = [...content.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \(/g)].map((match) => match[1]!);
    for (const table of createdTables) {
      assert.ok(
        !table.startsWith('commerce_') && !table.startsWith('catalog') && !table.startsWith('product') &&
          !table.startsWith('listing') && !table.startsWith('order'),
        `${name} must not create the commerce/catalog/product/listing/order table '${table}' (migration 049 is the sole commerce-capability home; the provider store stays the catalog authority)`,
      );
    }
  }
});

test('MKT-071 static: 049_commerce_capabilities.sql holds its numeric position at the end of the ordered migration list (047/048 are PRE-ASSIGNED to siblings)', () => {
  const migrationsOnDisk = readdirSync(src('platform', 'db', 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  assert.ok(migrationsOnDisk.includes('049_commerce_capabilities.sql'));
  assert.equal(migrationsOnDisk[migrationsOnDisk.length - 1], '049_commerce_capabilities.sql');
  assert.equal(migrationsOnDisk[migrationsOnDisk.length - 2], '046_social_accounts.sql');
  // 047/048 are NOT in this tree (pre-assigned to sibling deliveries).
  assert.ok(!migrationsOnDisk.some((name) => name.startsWith('047_')));
  assert.ok(!migrationsOnDisk.some((name) => name.startsWith('048_')));
});

// ---------------------------------------------------------------------------
// 6. The webhook idempotency design (AC-3/AC-6)
// ---------------------------------------------------------------------------

test('MKT-071 AC-3/AC-6 static: the webhook idempotency design — the fence, the append-only history, the honest duplicate-received record', () => {
  // The fence is append-only.
  assert.ok(migration049.includes('commerce_webhook_event_fence_append_only'));
  // The event history rejects UPDATE and DELETE outright.
  assert.ok(migration049.includes('commerce_events_append_only_update_trigger'));
  assert.ok(migration049.includes('commerce_events_append_only_delete_trigger'));
  // The mutation ledger is append-only too.
  assert.ok(migration049.includes('commerce_mutation_records_append_only'));
  // The outcome wiring: an ingested row references its ledger row; a
  // duplicate-received row references the ingested row it duplicated.
  assert.ok(migration049.includes('commerce_event_outcome_wiring'));
  // The module composes webhook → dedup → normalized append (the fence
  // composes with the EXISTING event-stream path).
  assert.ok(moduleCore.includes('findCommerceWebhookFence'));
  assert.ok(moduleCore.includes('insertDuplicateCommerceEvent'));
  assert.ok(moduleCore.includes('ingestIdentifiedCommerceEvent'));
  assert.ok(moduleCore.includes('deduplicated'));
  // The raw surface refuses replays fail-closed (no fence bypass).
  assert.ok(moduleCore.includes('ConflictError'));
});

// ---------------------------------------------------------------------------
// 7. Attribution passthrough ONLY (AC-5, §16)
// ---------------------------------------------------------------------------

test('MKT-071 AC-5 static (§16): attribution is PASSTHROUGH data — carried verbatim, never linked/matched/computed', () => {
  // The mappers carry the provider's attribution fields VERBATIM.
  assert.ok(adapterSupport.includes('attribution'));
  assert.ok(adapterSupport.includes('VERBATIM'));
  // The order-records mapping + the webhook event builder carry it through.
  assert.ok(adapterSupport.includes('mapCommerceOrderRecordsResponse'));
  assert.ok(adapterSupport.includes('buildNormalizedCommerceEvent'));
  // NO attribution linking/matching/causal computation exists anywhere in
  // the commerce layer (the forbidden vocabulary).
  for (const file of [commerceAdapter, commerceStoreAdapter, adapterSupport, moduleCore, storeCode, routesCode]) {
    const code = stripComments(file);
    assert.ok(!code.includes('matchAttribution'), 'no attribution matching');
    assert.ok(!code.includes('linkAttribution'), 'no attribution linking');
    assert.ok(!code.includes('attributeOrder'), 'no causal order attribution');
    assert.ok(!code.includes('attributionScore'), 'no attribution scoring');
  }
  // The migration declares the passthrough posture.
  assert.ok(migration049.includes('Attribution is PASSTHROUGH DATA'));
});

// ---------------------------------------------------------------------------
// 8. Store mutations flow through the boundary ONLY (boundary rule 8)
// ---------------------------------------------------------------------------

test('MKT-071 static (boundary rule 8): every commerce mutation is recorded in the append-only ledger with its capability key and gating policy decision', () => {
  // The module records every mutation under a mutating commerce capability.
  assert.ok(moduleCore.includes('isCommerceMutationCapability'));
  assert.ok(moduleCore.includes('insertCommerceMutationRecord'));
  assert.ok(moduleCore.includes('policyDecisionId: networkDecisionId'));
  // The policy gate carries the DECLARING capability key (AC-4).
  assert.ok(moduleCore.includes("capability: declaringCapability.capabilityKey"));
  // The route read-back surfaces exist.
  assert.ok(routesCode.includes("'/api/clients/:clientId/commerce-events'"));
  assert.ok(routesCode.includes("'/api/clients/:clientId/commerce-mutations'"));
  assert.ok(routesCode.includes("'/api/commerce-events/:commerceEventId'"));
});

test('MKT-071 static: the boundary core carries NO provider branch — the registry is DATA (the MKT-023 posture extended additively with commerce-store)', () => {
  // No first-party adapter key appears in the module core/store (the
  // registry is injected data, never code branches).
  for (const file of [moduleCore, storeCode, publicContract]) {
    const code = stripComments(file);
    for (const key of ['commerce-store', 'commerce-cms', 'meta-ads', 'creator-platform']) {
      assert.ok(
        !code.includes(`'${key}'`),
        `${file.slice(repoRoot.length)}: the boundary core must not reference the adapter key '${key}'`,
      );
    }
  }
  // The composition root wires the commerce-store connector (the only
  // sanctioned importer of concrete adapters).
  const compositionRoot = read(src('composition-root.ts'));
  assert.ok(compositionRoot.includes('new CommerceStoreAdapter({ http: httpCalls })'));
});

test('MKT-071 static: NO provider SDK import in the commerce layer (the commerce store denylist)', () => {
  // The architecture checker already enforces the global denylist; this
  // asserts the commerce subtree specifically shops no store SDK.
  const commerceFiles = [
    commerceAdapter,
    commerceStoreAdapter,
    adapterSupport,
  ];
  const storeSdks = ['shopify', '@shopify/shopify-api', 'bigcommerce', 'woocommerce', 'medusa', 'stripe'];
  for (const file of commerceFiles) {
    for (const match of file.matchAll(/from\s+'([^']+)'/g)) {
      const specifier = match[1]!;
      if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
      for (const sdk of storeSdks) {
        assert.ok(specifier !== sdk, `the commerce layer must not import the store SDK '${sdk}'`);
      }
    }
  }
});
