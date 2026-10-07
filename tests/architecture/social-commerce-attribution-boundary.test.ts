/**
 * MKT-073 static tests — the /social-commerce-attribution domain is
 * structurally correct in the ACTUAL migration, module contract and
 * checker provision (pure static analysis, no DB; the
 * commerce-discovery-boundary precedent).
 *
 * Proofs (spec/effective-backlog-v1.6.md MKT-073: "attribution ids
 * survive content transformations and provider boundaries; causal claims
 * remain explicitly separate"; the frozen v1.6 matrix row, VERBATIM:
 * /social-commerce-attribution → /cross-platform-distribution,
 * /integrations, /metrics, /evidence, /growth-missions):
 *   1. migration 069 creates exactly the SIX own tables — OWN tables
 *      ONLY, NO mission/experiment/evidence/metric/commerce-event/
 *      connection/policy/account table, and NO catalog/order/listing/
 *      price/inventory table ANYWHERE (lock rules 32/33);
 *   2. the frozen vocabularies are versioned + CHECK-fenced, INCLUDING
 *      THE CO-OCCURRENCE NOTE CHECK FENCE (a causal-claiming outcome row
 *      is inexpressible at the DB level) and THE ORDER-TRUTH FENCE (an
 *      order conversion REQUIRES the real order-webhook source + the
 *      commerce-event citation; a first-party kind carries none);
 *   3. THE CAUSAL-SEPARATION DISCIPLINE (the core acceptance,
 *      structural): the comment-stripped module code carries NO causal
 *      vocabulary (lift, contribution, incrementality, caused, causal —
 *      the pinned non-causal note aside);
 *   4. THE SURVIVAL-CHAIN FENCE (the core acceptance, structural): the
 *      DB helper fence sca_carried_refs_valid requires the ORIGINAL
 *      content identity — an attachment that dropped it is inexpressible;
 *   5. THE APPEND-ONLY + GUARDED-ADVANCE TRIGGER BATTERY (the 19
 *      triggers: the four append-only families reject UPDATE/DELETE; the
 *      references carry the single guarded active → retired advance; the
 *      crossings the single guarded dispatched → echoed/dropped advance);
 *   6. every FK anchor points ONLY at the tenant tables + same-module
 *      rows (the mission/commerce citations are OPAQUE recorded data);
 *   7. the scope-consistency fences (construction/attachment/crossing/
 *      outcome same-reference + same-tenant);
 *   8. NO provider call of any kind (no HTTP, no fetch, no scheduler);
 *   9. NO commerce/catalog/order/listing/price/inventory verb (lock
 *      rules 32/33 — the order truth flows ONLY through the declared
 *      commerce-event structural port);
 *   10. THE IMPORT BATTERY: the module imports NO other module's public
 *       contract (the five frozen-row directions are BY-REFERENCE /
 *       structural ports — the MKT-069 "imports nothing yet" disclosed
 *       precedent);
 *   11. DML against the module's OWN tables only;
 *   12. the honest 'unavailable' double fence (the DB rejects
 *       construction/attachment/crossing on an unavailable reference);
 *   13. migration 069 sits in its pre-assigned slot (position 63 of the
 *       66-migration list, between 068 and 070 — the merged-tree truth);
 *   14. the checker provision registers the module with EXACTLY its
 *       frozen v1.6 row directions (the retired MKT-070 provision
 *       precedent);
 *   15. the spec registration is HONESTLY PENDING (the §6 line + the
 *       live-matrix row absent — the TL promotes at harvest; both
 *       assertions flip then);
 *   16. the real codebase enforces the frozen boundaries with ZERO
 *       violations + the deterministic cores are PURE.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkArchitecture, parseFrozenModules } from '../../tools/arch-check/checker.ts';
import {
  SOCIAL_COMMERCE_ATTRIBUTION_CONTRACT_VERSION,
  SOCIAL_COMMERCE_ATTRIBUTION_VOCABULARY_VERSION,
  SOCIAL_COMMERCE_ATTRIBUTION_LINK_VERSION,
  SOCIAL_COMMERCE_ATTRIBUTION_MATCH_VERSION,
  SOCIAL_ATTRIBUTION_MECHANISMS,
  SOCIAL_ATTRIBUTION_CONSTRUCTIBLE_MECHANISMS,
  SOCIAL_ATTRIBUTION_CO_OCCURRENCE_NOTE,
  SOCIAL_ATTRIBUTION_REF_PATTERN,
  isConstructibleSocialAttributionMechanism,
} from '../../src/modules/social-commerce-attribution/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
const read = (path: string): string => readFileSync(path, 'utf8');

const migration069 = read(join(repoRoot, 'src', 'platform', 'db', 'migrations', '069_social_commerce_attribution.sql'));
const scaPublic = read(src('modules', 'social-commerce-attribution', 'public.ts'));
const scaModule = read(src('modules', 'social-commerce-attribution', 'internal', 'attribution-module.ts'));
const scaStore = read(src('modules', 'social-commerce-attribution', 'internal', 'attribution-store.ts'));
const scaLinkCore = read(src('modules', 'social-commerce-attribution', 'internal', 'link-core.ts'));
const scaValidation = read(src('modules', 'social-commerce-attribution', 'internal', 'validation.ts'));
const architectureSpec = read(join(repoRoot, 'spec', 'architecture.md'));
const matrixSpec = read(join(repoRoot, 'spec', 'module-dependency-matrix.md'));

const moduleFiles = [
  src('modules', 'social-commerce-attribution', 'public.ts'),
  src('modules', 'social-commerce-attribution', 'internal', 'attribution-module.ts'),
  src('modules', 'social-commerce-attribution', 'internal', 'attribution-store.ts'),
  src('modules', 'social-commerce-attribution', 'internal', 'link-core.ts'),
  src('modules', 'social-commerce-attribution', 'internal', 'validation.ts'),
];

/** Comment-stripped source (prose must not confuse the code scans). */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'" ])\/\/[^\n]*/g, '$1');
}

/** Comment-stripped SQL (the migration prose disclosures are not vocabulary). */
function stripSqlComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

// ---------------------------------------------------------------------------
// 1. Migration 069: OWN TABLES ONLY, no authority table, no commerce table
// ---------------------------------------------------------------------------

test('MKT-073: migration 069 creates exactly the SIX own tables — OWN tables ONLY (no authority table, no order/catalog/listing table anywhere)', () => {
  const created = [...migration069.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \(/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(created, [
    'social_attribution_references',
    'social_attribution_link_constructions',
    'social_attribution_attachments',
    'social_attribution_provider_crossings',
    'social_attribution_conversion_events',
    'social_attribution_outcomes',
  ]);
  // No catalog/order/listing/price/inventory table exists anywhere in the
  // migration (lock rules 32/33 — the composed commerce authorities stay
  // sole; actual orders remain external commerce-provider authority).
  for (const forbidden of ['catalog', 'listing', 'inventory', 'price', 'order_book']) {
    assert.ok(
      !created.some((table) => table.includes(forbidden)),
      `no ${forbidden} table exists in the migration`,
    );
  }
  // No other table is written anywhere in the migration (the anchored
  // authority tables appear only inside CHECK-ONLY scope fences; the
  // prose disclosures are stripped before the DDL scan).
  const dmlScan = stripSqlComments(migration069).replace(
    /CREATE OR REPLACE FUNCTION[\s\S]*?LANGUAGE plpgsql;/g,
    '',
  );
  for (const statement of dmlScan.matchAll(/(?:INSERT INTO|DELETE FROM)\s+([a-z_]+)/g)) {
    assert.ok(
      statement[1]!.startsWith('social_attribution_'),
      `the migration writes only the module's own tables (found '${statement[1]}')`,
    );
  }
  // The only sanctioned mutable row families: the references (the single
  // guarded active → retired advance) and the crossings (the single
  // guarded dispatched → echoed/dropped advance) — asserted by the
  // trigger battery below; the store owns the only UPDATEs.
  const updates = [...dmlScan.matchAll(/UPDATE\s+([a-z_]+)/g)].map((match) => match[1]!);
  assert.ok(
    updates.every(
      (table) =>
        table === 'social_attribution_references' || table === 'social_attribution_provider_crossings',
    ),
    `the migration's only UPDATEs are the two guarded advances (found ${updates.join(', ')})`,
  );
});

// ---------------------------------------------------------------------------
// 2. The frozen vocabularies are versioned + CHECK-fenced (incl. THE
//    CO-OCCURRENCE NOTE CHECK FENCE + THE ORDER-TRUTH FENCE)
// ---------------------------------------------------------------------------

test('MKT-073: the frozen vocabulary + version strings are pinned and CHECK-fenced — THE CO-OCCURRENCE NOTE CHECK FENCE + THE ORDER-TRUTH FENCE at the DB level', () => {
  assert.equal(SOCIAL_COMMERCE_ATTRIBUTION_CONTRACT_VERSION, 'sca-contract-v1');
  assert.equal(SOCIAL_COMMERCE_ATTRIBUTION_VOCABULARY_VERSION, 'sca-vocab-v1');
  assert.equal(SOCIAL_COMMERCE_ATTRIBUTION_LINK_VERSION, 'sca-link-v1');
  assert.equal(SOCIAL_COMMERCE_ATTRIBUTION_MATCH_VERSION, 'sca-match-v1');
  // THE PINNED CO-OCCURRENCE NOTE — CHECK-fenced at the database level
  // (migration 069): a causal-claiming outcome row is INEXPRESSIBLE.
  assert.equal(SOCIAL_ATTRIBUTION_CO_OCCURRENCE_NOTE, 'co-occurrence evidence only — never causal proof');
  assert.ok(
    migration069.includes(
      "CHECK (co_occurrence_note = 'co-occurrence evidence only — never causal proof')",
    ),
    'the outcomes table CHECK-fences the pinned co-occurrence note (a causal-claiming row is inexpressible)',
  );
  // THE ORDER-TRUTH FENCE at the DB level: an 'order' conversion
  // REQUIRES the real order-webhook source AND the commerce-event
  // citation AND the store connection; a first-party kind carries none.
  assert.ok(
    migration069.includes('CONSTRAINT social_attribution_conversion_events_order_truth_fence'),
    'the order-truth fence constraint exists',
  );
  assert.ok(
    migration069.includes("conversion_kind = 'order'") &&
      migration069.includes("event_source = 'order_webhook'") &&
      migration069.includes('AND commerce_event_id IS NOT NULL'),
    'an order conversion requires the real MKT-071 order-webhook commerce event',
  );
  assert.ok(
    migration069.includes("conversion_kind IN ('store_visit', 'product_interaction')") &&
      migration069.includes('AND commerce_event_id IS NULL'),
    'a first-party conversion carries no commerce-event citation (there is no caller-asserted order channel)',
  );
  // The stable attribution id grammar + the identity digest are fenced.
  assert.ok(migration069.includes("CHECK (attribution_ref ~ '^sca-[0-9a-f]{16}$')"));
  assert.ok(migration069.includes("CHECK (identity_digest ~ '^[0-9a-f]{64}$')"));
  // The closed vocabularies are CHECK-fenced (sca-vocab-v1 mirrors).
  assert.ok(migration069.includes("CHECK (mechanism IN ('platform_native_link',"));
  assert.ok(migration069.includes("CHECK (status IN ('active', 'retired'))"));
  assert.ok(migration069.includes("CHECK (crossing_state IN ('dispatched', 'echoed', 'dropped'))"));
  assert.ok(migration069.includes("CHECK (conversion_kind IN ('store_visit',"));
  assert.ok(migration069.includes("CHECK (event_source IN ('order_webhook',"));
  assert.ok(migration069.includes("CHECK (carrier_kind IN ('distribution_action',"));
  assert.ok(migration069.includes("CHECK (match_field IN ('utmContent',"));
  // The version strings are CHECK-fenced on every row family.
  assert.ok(migration069.includes("CHECK (contract_version = 'sca-contract-v1')"));
  assert.ok(migration069.includes("CHECK (vocabulary_version = 'sca-vocab-v1')"));
  assert.ok(migration069.includes("CHECK (construction_version = 'sca-link-v1')"));
  // The observed-fields helper fence (the bounded-scalar discipline).
  assert.ok(migration069.includes('CHECK (sca_observed_fields_valid(observed_fields))'));
  // The idempotence fences (the unique digests).
  assert.ok(migration069.includes('CONSTRAINT social_attribution_references_ref_uniq UNIQUE (attribution_ref)'));
  assert.ok(migration069.includes('CONSTRAINT social_attribution_references_digest_uniq UNIQUE (identity_digest)'));
  assert.ok(
    migration069.includes(
      'CONSTRAINT social_attribution_link_constructions_input_uniq',
    ),
  );
  // The public pattern constant matches the DB fence.
  assert.equal(String(SOCIAL_ATTRIBUTION_REF_PATTERN), /^sca-[0-9a-f]{16}$/.toString());
});

// ---------------------------------------------------------------------------
// 3. THE CAUSAL-SEPARATION DISCIPLINE (the core acceptance, structural)
// ---------------------------------------------------------------------------

test('MKT-073: THE CAUSAL-SEPARATION DISCIPLINE — NO causal vocabulary exists anywhere in the module (the comment-stripped scan; the pinned non-causal note aside)', () => {
  for (const file of moduleFiles) {
    const stripped = stripComments(read(file));
    // The pinned non-causal note is the ONE sanctioned occurrence of
    // causal language — the literal disclaimer itself. Everything else
    // must be structurally absent.
    const noteStripped = stripped.replaceAll(
      "'co-occurrence evidence only — never causal proof'",
      '',
    );
    for (const term of ['lift', 'contribution', 'incrementality', 'caused', 'causal']) {
      assert.ok(
        !noteStripped.toLowerCase().includes(term),
        `${file}: the module carries no causal vocabulary ('${term}' — the experiment-analysis authorities own causal estimation)`,
      );
    }
  }
  // The causal vocabulary is likewise absent from the module's own
  // tables (the outcomes table carries the note, the mechanism and the
  // match provenance ONLY — no lift/contribution/incrementality column).
  const ownTableScan = stripSqlComments(migration069);
  for (const term of ['lift', 'contribution', 'incrementality']) {
    assert.ok(
      !ownTableScan.toLowerCase().includes(term),
      `migration 069 carries no causal-estimation column ('${term}')`,
    );
  }
});

// ---------------------------------------------------------------------------
// 4. THE SURVIVAL-CHAIN FENCE (the core acceptance, structural)
// ---------------------------------------------------------------------------

test('MKT-073: THE SURVIVAL-CHAIN FENCE — the DB helper fence requires the ORIGINAL content identity (an attachment that dropped it is inexpressible)', () => {
  // The IMMUTABLE helper: the carried chain must CARRY the original.
  assert.ok(migration069.includes('CREATE OR REPLACE FUNCTION sca_carried_refs_valid('));
  assert.ok(
    migration069.includes('sca_carried_refs_valid(carried_content_refs, original_content_ref)'),
    'the attachments table CHECK-fences the survival chain through the helper',
  );
  // The chain bounds: 1..50 carried identities, every one a bounded
  // string — INSIDE the IMMUTABLE helper.
  assert.ok(
    migration069.includes('jsonb_array_length(carried) < 1 OR jsonb_array_length(carried) > 50'),
  );
  assert.ok(migration069.includes("carried @> to_jsonb(original_content_ref)"));
  // The original head is bounded and required.
  assert.ok(migration069.includes('original_content_ref'));
  // The carrier citation is UNIQUE per reference (one attachment record
  // per (reference, carrier kind, carrier) — a re-record is a conflict,
  // not a rewrite).
  assert.ok(
    migration069.includes('CONSTRAINT social_attribution_attachments_carrier_uniq'),
  );
  // The survival chain is APPEND-EXTENDED: a transformation records a
  // NEW attachment row (the append-only trigger battery below).
  assert.ok(migration069.includes('CREATE OR REPLACE FUNCTION social_attribution_attachments_append_only()'));
});

// ---------------------------------------------------------------------------
// 5. The append-only + guarded-advance trigger battery (the 19 triggers)
// ---------------------------------------------------------------------------

test('MKT-073: the append-only UPDATE/DELETE rejection triggers exist on the four append-only families; the references + crossings carry the single guarded advances', () => {
  // The four append-only families: constructions, attachments,
  // conversion events and outcomes reject UPDATE and DELETE outright.
  for (const table of [
    'social_attribution_link_constructions',
    'social_attribution_attachments',
    'social_attribution_conversion_events',
    'social_attribution_outcomes',
  ]) {
    assert.ok(
      migration069.includes(`BEFORE UPDATE ON ${table}`),
      `${table} rejects UPDATE`,
    );
    assert.ok(
      migration069.includes(`BEFORE DELETE ON ${table}`),
      `${table} rejects DELETE`,
    );
  }
  // The references: the single guarded active → retired advance (no
  // reopen, no resurrection) + the no-delete fence.
  assert.ok(migration069.includes('CREATE OR REPLACE FUNCTION social_attribution_reference_guard()'));
  assert.ok(migration069.includes('CREATE TRIGGER social_attribution_reference_guard_trigger'));
  assert.ok(migration069.includes("IF NOT (OLD.status = 'active' AND NEW.status = 'retired'"));
  assert.ok(migration069.includes('CREATE OR REPLACE FUNCTION social_attribution_reference_no_delete()'));
  assert.ok(migration069.includes('CREATE TRIGGER social_attribution_reference_no_delete_trigger'));
  // The crossings: the single guarded dispatched → echoed/dropped
  // advance (a second attempt is rejected; the born-'dispatched' fence)
  // + the no-delete fence.
  assert.ok(migration069.includes('CREATE OR REPLACE FUNCTION social_attribution_crossing_guard()'));
  assert.ok(migration069.includes('CREATE TRIGGER social_attribution_crossing_guard_trigger'));
  assert.ok(
    migration069.includes(
      "(OLD.crossing_state = 'dispatched' AND NEW.crossing_state = 'echoed'",
    ) && migration069.includes("(OLD.crossing_state = 'dispatched' AND NEW.crossing_state = 'dropped'"),
    'the only legal crossing advances are dispatched → echoed (echo recorded) or dispatched → dropped (the honest null + reason)',
  );
  assert.ok(migration069.includes('CREATE OR REPLACE FUNCTION social_attribution_crossings_no_delete()'));
  assert.ok(migration069.includes('CREATE TRIGGER social_attribution_crossings_no_delete_trigger'));
  // The born-state fences (a crossing is born 'dispatched' with the
  // honest nulls; the state fence CHECK).
  assert.ok(
    migration069.includes('CONSTRAINT social_attribution_crossings_state_fence'),
  );
  assert.ok(
    migration069.includes('CONSTRAINT social_attribution_references_born_fence'),
  );
  // The 19-trigger inventory: the two reference guards + 8 append-only
  // (4 families × update/delete) + 3 unavailable fences + the crossing
  // guard + the crossing no-delete + the 4 scope triggers = 19.
  const triggers = [...migration069.matchAll(/CREATE TRIGGER ([a-z_]+)/g)].map((m) => m[1]!);
  assert.equal(triggers.length, 19, `exactly 19 guard triggers (found ${triggers.length})`);
});

// ---------------------------------------------------------------------------
// 6. The FK anchors: tenant tables + same-module rows ONLY
// ---------------------------------------------------------------------------

test('MKT-073: every FK anchor points ONLY at the tenant tables + same-module rows (the mission/commerce citations are OPAQUE recorded data — no authority FK, no cross-module join)', () => {
  const references = [...migration069.matchAll(/REFERENCES ([a-z_]+)\(/g)].map((m) => m[1]!);
  assert.ok(references.length >= 18, 'the FK anchors exist');
  for (const target of references) {
    assert.ok(
      target === 'agencies' ||
        target === 'clients' ||
        target === 'workspaces' ||
        target.startsWith('social_attribution_'),
      `the FK anchor '${target}' is a tenant table or a same-module row (no cross-module FK)`,
    );
  }
  // The mission citation is deliberately NOT a foreign key (the mission
  // spine stays sole — the /growth-missions direction rides the
  // structural port).
  assert.ok(!migration069.includes('REFERENCES growth_missions'));
  // The commerce-event citation is deliberately NOT a foreign key (the
  // /integrations boundary owns the commerce projections).
  assert.ok(!migration069.includes('REFERENCES commerce_events'));
  assert.ok(!migration069.includes('REFERENCES integration_connections'));
  // No mission/evidence/metric/experiment table is read anywhere in the
  // migration (CHECK-ONLY scope fences touch the module's own rows +
  // the tenant chain only).
  const dmlScan = stripSqlComments(migration069).replace(
    /CREATE OR REPLACE FUNCTION[\s\S]*?LANGUAGE plpgsql;/g,
    '',
  );
  for (const statement of dmlScan.matchAll(/(?:FROM|JOIN)\s+([a-z_]+)/g)) {
    assert.ok(
      statement[1]!.startsWith('social_attribution_') ||
        statement[1] === 'agencies' ||
        statement[1] === 'clients' ||
        statement[1] === 'workspaces',
      `the migration reads only its own rows + the tenant chain (found '${statement[1]}')`,
    );
  }
});

// ---------------------------------------------------------------------------
// 7. The scope-consistency fences
// ---------------------------------------------------------------------------

test('MKT-073: the scope-consistency fences exist (construction/attachment/crossing/outcome same-reference + same-tenant)', () => {
  const scopeFunctions = [
    'social_attribution_link_construction_scope_consistent',
    'social_attribution_attachment_scope_consistent',
    'social_attribution_crossing_scope_consistent',
    'social_attribution_outcome_scope_consistent',
  ];
  for (const fn of scopeFunctions) {
    assert.ok(migration069.includes(`CREATE OR REPLACE FUNCTION ${fn}()`), `${fn} exists`);
    assert.ok(
      migration069.includes(`EXECUTE FUNCTION ${fn}()`),
      `${fn} is wired as a BEFORE INSERT trigger`,
    );
  }
});

// ---------------------------------------------------------------------------
// 8. NO provider call of any kind
// ---------------------------------------------------------------------------

test('MKT-073: NO provider call of any kind exists in the module (no HTTP, no fetch, no provider SDK, no scheduler/timer/loop)', () => {
  for (const file of moduleFiles) {
    const code = stripComments(read(file));
    for (const forbidden of [
      'fetch(',
      'http.request',
      'https.request',
      'XMLHttpRequest',
      'setInterval',
      'setTimeout',
      'setImmediate',
      'process.nextTick',
      'new Worker',
      'cron',
    ]) {
      assert.ok(!code.includes(forbidden), `${file}: no provider-call/scheduler primitive ('${forbidden}')`);
    }
  }
  // The module records crossings as DATA — the provider boundary lives
  // in /integrations (the webhook ingestion path is theirs).
  assert.ok(
    scaModule.includes('NO provider call happens here') ||
      scaPublic.includes('NO provider call of any kind'),
    'the no-provider-call posture is disclosed on the contract',
  );
});

// ---------------------------------------------------------------------------
// 9. NO second commerce authority (lock rules 32/33)
// ---------------------------------------------------------------------------

test('MKT-073: NO commerce/catalog/order/listing/price/inventory verb exists in the module (the order truth flows ONLY through the commerce-event structural port)', () => {
  const code = [stripComments(scaModule), stripComments(scaStore), stripComments(scaPublic)].join('\n');
  for (const forbidden of [
    'createOrder',
    'updateOrder',
    'cancelOrder',
    'createListing',
    'updateListing',
    'setPrice',
    'updateInventory',
    'executeMutation',
    'submitPublish',
    'registerConnection',
    'createCredential',
  ]) {
    assert.ok(
      !code.includes(forbidden),
      `the module never calls '${forbidden}' (no second commerce authority, no store mutation, no provider credential)`,
    );
  }
  // The ONLY commerce consumption is the declared narrow structural
  // port: the client's ALREADY-INGESTED commerce-event projections.
  assert.ok(
    scaModule.includes('commerceEvents.listCommerceEventsForClient('),
    'the module composes exactly the declared commerce-event port read',
  );
});

// ---------------------------------------------------------------------------
// 10. The import battery (zero cross-module imports — the five frozen-row
//     directions are BY-REFERENCE / structural ports)
// ---------------------------------------------------------------------------

test('MKT-073: the module imports NO other module\'s public contract (the five frozen-row directions are BY-REFERENCE / structural ports — the MKT-069 disclosed precedent)', () => {
  const allowed = new Set([
    '../../platform/clock/clock.ts',
    '../../platform/db/contract.ts',
    '../../platform/ids/ids.ts',
    '../../platform/errors/errors.ts',
    '../../../platform/clock/clock.ts',
    '../../../platform/db/contract.ts',
    '../../../platform/ids/ids.ts',
    '../../../platform/errors/errors.ts',
    '../public.ts',
    './internal/attribution-module.ts',
    './internal/attribution-store.ts',
    './internal/link-core.ts',
    './internal/validation.ts',
    './attribution-module.ts',
    './attribution-store.ts',
    './link-core.ts',
    './validation.ts',
  ]);
  for (const file of moduleFiles) {
    const code = stripComments(read(file));
    for (const match of code.matchAll(/from '([^']+)'/g)) {
      const specifier = match[1]!;
      if (specifier === 'node:crypto') continue;
      assert.ok(
        allowed.has(specifier),
        `${file}: import '${specifier}' is a platform port or the module's own file (zero cross-module imports — the structural-port posture)`,
      );
    }
  }
  // The five frozen-row directions are declared as STRUCTURAL PORTS on
  // the public contract (the /cross-platform-distribution direction is
  // exercised BY REFERENCE — opaque recorded data).
  assert.ok(scaPublic.includes('interface SocialAttributionMissionPort'));
  assert.ok(scaPublic.includes('interface SocialAttributionWorkspacePort'));
  assert.ok(scaPublic.includes('interface SocialAttributionCommerceEventPort'));
});

// ---------------------------------------------------------------------------
// 11. DML against the module's OWN tables only
// ---------------------------------------------------------------------------

test('MKT-073: DML against the module\'s OWN tables only (the store queries social_attribution_* exclusively)', () => {
  const storeCode = stripComments(scaStore);
  for (const statement of storeCode.matchAll(/(?:INSERT INTO|UPDATE|DELETE FROM|FROM)\s+([a-z_]+)/g)) {
    const table = statement[1]!;
    assert.ok(
      table.startsWith('social_attribution_'),
      `the store queries only the module's own tables (found '${table}')`,
    );
  }
  // The store's only UPDATEs: the references' single guarded retirement
  // advance and the crossings' single guarded advance.
  const updates = [...storeCode.matchAll(/UPDATE\s+([a-z_]+)/g)].map((match) => match[1]!);
  assert.deepEqual([...updates].sort(), [
    'social_attribution_provider_crossings',
    'social_attribution_references',
  ]);
});

// ---------------------------------------------------------------------------
// 12. The honest 'unavailable' double fence
// ---------------------------------------------------------------------------

test('MKT-073: the honest \'unavailable\' double fence is structural (the DB rejects construction/attachment/crossing on an unavailable reference — never a fabricated link)', () => {
  // The constructible subset excludes 'unavailable' on the contract.
  assert.ok(!(SOCIAL_ATTRIBUTION_CONSTRUCTIBLE_MECHANISMS as readonly string[]).includes('unavailable'));
  assert.ok((SOCIAL_ATTRIBUTION_MECHANISMS as readonly string[]).includes('unavailable'));
  assert.ok(!isConstructibleSocialAttributionMechanism('unavailable'));
  // The DB double fence: the shared guard function + the THREE triggers
  // (constructions, attachments, crossings).
  assert.ok(
    migration069.includes('CREATE OR REPLACE FUNCTION social_attribution_reference_not_unavailable()'),
  );
  for (const trigger of [
    'social_attribution_link_construction_unavailable_fence',
    'social_attribution_attachment_unavailable_fence',
    'social_attribution_crossing_unavailable_fence',
  ]) {
    assert.ok(migration069.includes(`CREATE TRIGGER ${trigger}`), `${trigger} exists`);
  }
  assert.ok(
    migration069.includes('no link may be constructed, carried or dispatched on it'),
    'the honest unavailable error message is pinned',
  );
});

// ---------------------------------------------------------------------------
// 13. The migration slot (position 63 of the 66-migration list)
// ---------------------------------------------------------------------------

test('MKT-073: migration 069 sits in its pre-assigned slot (position 63 of the 66-migration list — between 068 and 070, the merged-tree truth)', () => {
  const numbered = readdirSync(join(repoRoot, 'src', 'platform', 'db', 'migrations'))
    .filter((name) => /^\d+_/.test(name))
    .sort();
  assert.equal(numbered.length, 66);
  assert.equal(numbered[62], '069_social_commerce_attribution.sql');
  assert.equal(numbered[61], '068_studio_format_framework.sql');
  assert.equal(numbered[63], '070_studio_script_question_graph.sql');
});

// ---------------------------------------------------------------------------
// 14. The checker provision (the retired MKT-070 provision precedent)
// ---------------------------------------------------------------------------

test('MKT-073: the checker provision registers the module with EXACTLY its frozen v1.6 row directions (the retired MKT-070 provision precedent)', () => {
  const result = checkArchitecture({
    codeRoot: repoRoot,
    specDir: join(repoRoot, 'spec'),
    skip: ['tests/architecture/fixtures', 'console'],
  });
  assert.deepEqual(
    result.violations.map((violation) => `[${violation.rule}] ${violation.file}: ${violation.detail}`),
    [],
  );
  assert.ok(result.frozenModules.includes('social-commerce-attribution'));
  // The frozen v1.6 row, VERBATIM (the provision directions).
  assert.deepEqual(result.frozenMatrix['social-commerce-attribution'], [
    'cross-platform-distribution',
    'integrations',
    'metrics',
    'evidence',
    'growth-missions',
  ]);
  // 60 enforced modules (58 spec-parsed + the single /apps provision +
  // the disclosed MKT-073 provision).
  assert.equal(result.frozenModules.length, 60);
});

// ---------------------------------------------------------------------------
// 15. The spec registration is HONESTLY PENDING (the TL promotes at
//     harvest; both assertions flip then)
// ---------------------------------------------------------------------------

test('MKT-073: the spec registration is HONESTLY PENDING (the §6 line + the live-matrix row absent — the TL promotes at harvest; both assertions flip then)', () => {
  // The spec files do NOT yet carry the registration (the worker may
  // not edit spec/ — the provision is the disclosed interim; these two
  // assertions flip to their positive forms at the TL's promotion, the
  // MKT-070 harvest precedent).
  assert.ok(
    !/\/social-commerce-attribution/.test(architectureSpec),
    'spec/architecture.md §6 does not yet carry the /social-commerce-attribution line (the TL promotes at harvest)',
  );
  assert.ok(
    !/social-commerce-attribution\s*(──)?→/.test(matrixSpec),
    'spec/module-dependency-matrix.md does not yet carry the row (the TL promotes at harvest)',
  );
  // The spec-parsed module count stays 58 (the module is enforced
  // through the provision only).
  const specModules = parseFrozenModules(join(repoRoot, 'spec', 'architecture.md'));
  assert.equal(specModules.length, 58);
  assert.ok(!specModules.includes('social-commerce-attribution'));
});

// ---------------------------------------------------------------------------
// 16. The deterministic cores are PURE
// ---------------------------------------------------------------------------

test('MKT-073: the deterministic cores are PURE — no clock, no randomness, no network, no I/O (the sca-contract/sca-link/sca-match formulas)', () => {
  for (const core of [scaLinkCore, scaValidation]) {
    const code = stripComments(core);
    for (const forbidden of [
      'Date.now',
      'Math.random',
      'clock.nowIso',
      'fetch(',
      'db.query',
      'new Date(',
    ]) {
      assert.ok(!code.includes(forbidden), `the pure core never uses '${forbidden}'`);
    }
  }
  // The exported formula set (the deterministic identity/link/matcher
  // cores — re-exported through the public entry).
  assert.ok(scaLinkCore.includes('export function deriveAttributionIdentity'));
  assert.ok(scaLinkCore.includes('export function deriveConstructionInputDigest'));
  assert.ok(scaLinkCore.includes('export function deriveCampaignIdentifier'));
  assert.ok(scaLinkCore.includes('export function deriveLandingRoute'));
  assert.ok(scaLinkCore.includes('export function buildAttributionLink'));
  assert.ok(scaLinkCore.includes('export function matchAttributionLinks'));
  assert.ok(scaValidation.includes('export function canonicalSocialAttributionJson'));
  // The pure guards are re-exported through the module public entry
  // (the commerce-discovery pure-core precedent).
  for (const pureExport of [
    'buildAttributionLink',
    'deriveAttributionIdentity',
    'deriveCampaignIdentifier',
    'deriveConstructionInputDigest',
    'deriveLandingRoute',
    'matchAttributionLinks',
    'canonicalSocialAttributionJson',
    'assertValidReferenceCreation',
    'assertValidLinkConstruction',
    'assertValidAttachment',
    'assertValidCrossingRecording',
    'assertValidCrossingAdvance',
    'assertValidFirstPartyConversion',
    'assertValidObservedFields',
  ]) {
    assert.ok(
      scaPublic.includes(pureExport),
      `the pure core '${pureExport}' is re-exported through the module public entry`,
    );
  }
});
