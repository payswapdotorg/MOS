/**
 * MKT-056 static tests — the Social Platform Adapter Contract is
 * structurally correct in the ACTUAL migration, module contract and
 * composition surface (pure static analysis, no DB; the
 * social-accounts-boundary + notification-delivery-boundary precedents).
 *
 * Proofs (spec/effective-backlog-v1.6.md MKT-056 — acceptance
 * "capability-subset support, adapter conformance suite, no
 * platform-specific knowledge outside adapter subtrees";
 * spec/architecture-v1.6.md §4; spec/architecture-lock-v1.6.md rules
 * #18/#19/#37; spec/module-dependency-matrix-v1.6.md boundary rules 1/2):
 *   1. migration 050 creates EXACTLY the two own tables —
 *      social_publish_attempts + social_publish_status_observations —
 *      OWN tables ONLY (the MKT-055 module-extension posture: no new
 *      module, no capability-registration table — the matrix is
 *      adapter-declared registry data);
 *   2. THE FROZEN VOCABULARIES are CHECK-fenced: the publish lifecycle
 *      (submitted → accepted|published|failed|restricted, the single
 *      completion fill trigger with the immutable identity/provenance
 *      columns) and the seven-code failure taxonomy; the observations
 *      never carry 'submitted'; the idempotency fence is the unique
 *      (social_account_id, idempotency_key) index; the append-only
 *      UPDATE/DELETE rejection triggers; the account/attempt consistency
 *      backstops; the §21 material-key CHECKs on every jsonb column;
 *   3. THE MODULE CONTRACT: the frozen five families + the closed
 *      per-family operation vocabularies + the taxonomy + the publish
 *      states agree between the public entry and the migration CHECKs;
 *      the module API exposes exactly the frozen normalized-operation
 *      surface; the §21 material-shaped identifier backstop on the new
 *      module code;
 *   4. THE PROVIDER-NEUTRAL BOUNDARY (lock rule 18 + boundary rules 1/2,
 *      the AC-3 core): NO platform-specific knowledge anywhere in src/
 *      OUTSIDE the sanctioned adapter subtrees (any 'adapters' path
 *      segment — the concrete provider seams) and the composition root
 *      (the sanctioned wiring path) — no social platform name, no
 *      platform endpoint, no platform SDK import (the arch-check
 *      EXTERNAL_PACKAGE_IN_SRC rule already proves the SDK half);
 *   5. THE ADAPTER SUBTREE contract: internal/adapters/ exists with the
 *      re-export shim as its ONLY current resident (the MKT-057..061
 *      platform implementations arrive there), and NOTHING in src/
 *      imports it yet (the composition root will, as data);
 *   6. THE COMPOSITION SEAMS: AppOptions.socialPlatformAdapters +
 *      AppOptions.integrationAdapters exist, the production registries
 *      stay EMPTY by default (fail-closed until the platform
 *      deliveries), and the module deps carry the socialAdapters data
 *      surface;
 *   7. THE DISCLOSED REGISTRATION POSTURE: this Work Item registers NO
 *      new module and NO new matrix row (the /social-accounts extension
 *      posture) — the enforced frozen set and the /social-accounts
 *      matrix row are unchanged, and 050_social_adapter_contract.sql
 *      holds the numeric tail position.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkArchitecture, parseFrozenMatrix, parseFrozenModules } from '../../tools/arch-check/checker.ts';
import {
  SOCIAL_ADAPTER_FAILURE_CODES,
  SOCIAL_CAPABILITY_FAMILIES,
  SOCIAL_FAMILY_OPERATIONS,
  SOCIAL_PUBLISH_STATES,
} from '../../src/modules/social-accounts/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
const read = (path: string): string => readFileSync(path, 'utf8');

const migration050 = read(src('platform', 'db', 'migrations', '050_social_adapter_contract.sql'));
const socialPublic = read(src('modules', 'social-accounts', 'public.ts'));
const socialModule = read(src('modules', 'social-accounts', 'internal', 'module.ts'));
const socialAdapterContract = read(src('modules', 'social-accounts', 'internal', 'adapter-contract.ts'));
const socialAdapterStore = read(src('modules', 'social-accounts', 'internal', 'adapter-store.ts'));
const adaptersShim = read(src('modules', 'social-accounts', 'internal', 'adapters', 'adapter-contract.ts'));
const compositionRoot = read(src('composition-root.ts'));
const architectureSpec = read(join(repoRoot, 'spec', 'architecture.md'));
const matrixSpec = read(join(repoRoot, 'spec', 'module-dependency-matrix.md'));

/** Comment-stripped source (prose must not confuse the code scans). */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'" ])\/\/[^\n]*/g, '$1');
}

/** Every file under a directory (recursive, POSIX-relative paths). */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs));
    else out.push(abs);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Migration 050: OWN TABLES ONLY
// ---------------------------------------------------------------------------

test('MKT-056: migration 050 creates exactly the two publish-ledger tables — OWN tables ONLY (the module-extension posture)', () => {
  const created = [...migration050.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \(/g)].map((m) => m[1]!);
  assert.deepEqual(
    created,
    ['social_publish_attempts', 'social_publish_status_observations'],
    'the publish idempotency fence + the append-only status observation history; NO capability-registration table (the matrix is adapter-declared registry data validated at construction — the migration-029 discipline) and NO other module\'s table',
  );
  // The attempts' frozen columns.
  const attemptColumns = [...migration050.matchAll(/^ {4}([a-z_]+)\s+/gm)].map((m) => m[1]!);
  for (const required of [
    'attempt_id', 'social_account_id', 'integration_connection_id', 'agency_id', 'client_id', 'platform_id',
    'idempotency_key', 'content_type', 'publish_request', 'publish_state', 'failure_code',
    'provider_publish_id', 'provider_content_id', 'published_at', 'provider_failure_reason',
    'restriction_signals', 'provider_data', 'rate_limit_remaining', 'rate_limit_reset_at',
    'backoff_until', 'retry_after_seconds', 'recorded_actor', 'recorded_via', 'correlation_id',
    'causation_id', 'created_at',
  ]) {
    assert.ok(attemptColumns.includes(required), `social_publish_attempts must carry '${required}'`);
  }
  // NO column capable of carrying secret material (§21).
  for (const forbidden of ['token', 'secret', 'password', 'api_key', 'material']) {
    assert.ok(
      !attemptColumns.some((column) => column.includes(forbidden)),
      `no material-shaped column ('${forbidden}') exists on the publish ledger`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. The frozen vocabularies + the database fences
// ---------------------------------------------------------------------------

test('MKT-056: the publish lifecycle + failure taxonomy are CHECK-fenced (the migration-050 mirror of the module contract)', () => {
  // The publish-state vocabulary.
  assert.ok(
    migration050.includes("CHECK (publish_state IN ('submitted', 'accepted',\n                                                     'published', 'failed', 'restricted'))"),
    'the publish-state vocabulary is CHECK-fenced on the attempts',
  );
  assert.ok(
    migration050.includes("CHECK (publish_state IN ('accepted', 'published',\n                                                     'failed', 'restricted'))"),
    'the observation states NEVER include submitted (a poll reports a provider answer)',
  );
  // The failure taxonomy (both tables).
  assert.equal(
    [...migration050.matchAll(/failure_code IN \('auth-expired'/g)].length,
    2,
    'the seven-code taxonomy is CHECK-fenced on BOTH tables (attempts: CHECK (failure_code IN ...; observations: CHECK (failure_code IS NULL OR failure_code IN ...)',
  );
  // The outcome-vocabulary consistency constraint.
  assert.ok(
    migration050.includes('social_publish_attempt_failure_code_consistency'),
    'only a FAILED attempt carries a taxonomy failure code',
  );
  // The publish-state transitions of the module contract agree with the trigger.
  for (const state of SOCIAL_PUBLISH_STATES) {
    assert.ok(migration050.includes(`'${state}'`), `the migration knows the state '${state}'`);
  }
  assert.equal(SOCIAL_PUBLISH_STATES.length, 5);
  assert.equal(SOCIAL_ADAPTER_FAILURE_CODES.length, 7);
});

test('MKT-056: the idempotency fence + the claim-then-fill discipline + the append-only triggers exist', () => {
  // THE FENCE: unique (social_account_id, idempotency_key).
  assert.ok(
    migration050.includes('CREATE UNIQUE INDEX IF NOT EXISTS social_publish_attempts_idempotency_fence\nON social_publish_attempts (social_account_id, idempotency_key)'),
    'the at-most-once fence is the unique (account, key) index',
  );
  // The single completion fill trigger (claim-then-fill).
  assert.ok(
    migration050.includes('social_publish_attempts_fill_only'),
    'the fill-only trigger function exists',
  );
  assert.ok(
    migration050.includes("IF OLD.publish_state <> 'submitted' THEN"),
    'a filled attempt is immutable',
  );
  assert.ok(
    migration050.includes('OR NEW.idempotency_key <> OLD.idempotency_key'),
    'the claim identity is immutable through the fill',
  );
  // The append-only observation tail.
  assert.ok(
    migration050.includes('social_publish_status_observations_append_only'),
    'the observation tail rejects UPDATE/DELETE outright',
  );
  // The DELETE rejection on attempts.
  assert.ok(
    migration050.includes('social publish attempts are append-only: DELETE is rejected'),
    'DELETE on attempts is rejected',
  );
  // The consistency backstops.
  assert.ok(migration050.includes('social_publish_attempt_account_consistent'), 'the account-consistency backstop');
  assert.ok(migration050.includes('social_publish_observation_attempt_consistent'), 'the attempt-consistency backstop');
  // The §21 material-key CHECKs on every jsonb column (five columns:
  // attempts publish_request/restriction_signals/provider_data +
  // observations restriction_signals/provider_data).
  assert.equal(
    [...migration050.matchAll(/integration_payload_has_no_material_keys\(/g)].length,
    5,
    'every jsonb column is §21-guarded (the reused migration-029 IMMUTABLE function)',
  );
});

// ---------------------------------------------------------------------------
// 3. The module contract surface
// ---------------------------------------------------------------------------

test('MKT-056: the module API exposes exactly the frozen normalized-operation surface (module-level only, no HTTP routes)', () => {
  const moduleApiBlock = socialPublic.slice(
    socialPublic.indexOf('export interface SocialAccountsModuleApi'),
    socialPublic.indexOf('export interface SocialAccountsModuleDeps'),
  );
  // The MKT-056 additions (the frozen surface).
  for (const method of [
    'listRegisteredSocialAdapters',
    'resolveAccountCapabilityMatrix',
    'verifyAccountIdentity',
    'readAccountProfile',
    'discoverPublicContent',
    'listOwnContent',
    'getContent',
    'readAccountAnalytics',
    'readContentAnalytics',
    'readRestrictionSignals',
    'submitPublish',
    'refreshPublishStatus',
    'getPublishAttempt',
    'listPublishAttemptsForAccount',
    'listPublishAttemptsForClient',
    'listPublishStatusObservations',
  ]) {
    assert.ok(moduleApiBlock.includes(`${method}(`), `the module API exposes ${method}`);
  }
  // The MKT-055 surface is intact (the extension posture).
  for (const method of ['startAuthorization', 'completeAuthorization', 'refreshAuthorization', 'getUsableAuthorization']) {
    assert.ok(moduleApiBlock.includes(`${method}(`), `the MKT-055 surface keeps ${method}`);
  }
  // NO HTTP route may expose the adapter plane (module-level only — the
  // server-side consumers arrive with the adapter deliveries).
  const routes = read(src('api', 'social-accounts-routes.ts'));
  const stripped = stripComments(routes);
  for (const method of ['submitPublish', 'readAccountProfile', 'discoverPublicContent', 'listRegisteredSocialAdapters', 'resolveAccountCapabilityMatrix']) {
    assert.ok(!stripped.includes(method), `the route surface never exposes ${method} (module-level only in MKT-056)`);
  }
  // The route surface is STILL exactly the frozen twelve (the MKT-055 proof).
  const routeList = [...stripped.matchAll(/router\.add\(\s*'([A-Z]+)',\s*'([^']+)'/g)].map((m) => `${m[1]!} ${m[2]!}`);
  assert.equal(routeList.length, 12, 'no routes were added or removed');
});

test('MKT-056: the frozen five families + the closed operation vocabularies are part of the public contract', () => {
  assert.deepEqual(SOCIAL_CAPABILITY_FAMILIES, ['account', 'content-read', 'analytics-read', 'publish', 'restriction-signals']);
  for (const family of SOCIAL_CAPABILITY_FAMILIES) {
    assert.ok(socialPublic.includes(`'${family}'`), `the public entry knows the family '${family}'`);
    assert.ok(SOCIAL_FAMILY_OPERATIONS[family].length > 0);
  }
  // The adapter port + the call context + the registry data surface.
  for (const marker of [
    'export interface SocialPlatformAdapter',
    'export interface SocialAdapterCallContext',
    'export interface SocialCapability',
  ]) {
    assert.ok(socialAdapterContract.includes(marker), `the internal contract declares '${marker}'`);
  }
  for (const marker of [
    'SocialPlatformAdapter,',
    'SocialAdapterCallContext,',
    'SocialCapability,',
    'readonly socialAdapters: readonly SocialPlatformAdapter[]',
  ]) {
    assert.ok(socialPublic.includes(marker), `the public entry re-exports/carries '${marker}'`);
  }
  // The store DML targets ONLY the own migration-050 tables.
  const storeCode = stripComments(socialAdapterStore);
  const tables = [...storeCode.matchAll(/(?:FROM|INTO|UPDATE)\s+(social_publish_[a-z_]+)/g)].map((m) => m[1]!);
  assert.deepEqual(
    [...new Set(tables)].sort(),
    ['social_publish_attempts', 'social_publish_status_observations'],
    'the publish-ledger store reads/writes ONLY the own tables',
  );
  // No material-shaped identifier in the publish-ledger STORE code (the
  // §21 posture). adapter-contract.ts is EXEMPT exactly like the MKT-055
  // grant-validation guard: it owns the §21 material-key GUARD that
  // legitimately names the rejected key shapes — it is the backstop, not
  // a consumer.
  {
    const code = stripComments(socialAdapterStore);
    for (const forbidden of ['access_token', 'refreshToken', 'apiKey', 'password', 'secretMaterial']) {
      assert.ok(!code.includes(forbidden), `the adapter-store code must never contain '${forbidden}'`);
    }
  }
});

// ---------------------------------------------------------------------------
// 4. THE PLATFORM-KNOWLEDGE FENCE (AC-3 — the core)
// ---------------------------------------------------------------------------

test('MKT-056 AC-3: NO platform-specific knowledge in src/ OUTSIDE the sanctioned adapter subtrees + the composition root', () => {
  // The distinctive identifiers of the v1.6 MVP social platform set
  // (spec/frozen-manifest-v1.6.json mvpSocialPlatforms: youtube, instagram,
  // facebook-pages, tiktok, x). DISCLOSED LIMITATION: the X platform's
  // key is the single letter 'x' — unscannable as a substring; the fence
  // scans its distinctive identifiers (twitter / x.com / api.x.com).
  const platformIdentifiers = [
    'youtube', 'instagram', 'facebook', 'tiktok', 'twitter', 'x.com', 'api.x.com', 'graph.facebook',
  ];
  const offenders: string[] = [];
  for (const file of walk(join(repoRoot, 'src'))) {
    if (!file.endsWith('.ts')) continue;
    const rel = relative(repoRoot, file).split('\\').join('/');
    // The sanctioned zones: the adapter subtrees (any 'adapters' path
    // segment — the concrete provider seams across ALL modules) and the
    // composition root (the sanctioned wiring path).
    const segments = rel.split('/');
    if (segments.includes('adapters')) continue;
    if (rel === 'src/composition-root.ts') continue;
    const text = readFileSync(file, 'utf8').toLowerCase();
    for (const identifier of platformIdentifiers) {
      if (text.includes(identifier)) offenders.push(`${rel}: '${identifier}'`);
    }
  }
  assert.deepEqual(offenders, [], 'platform-specific knowledge lives exclusively behind the adapter subtrees and the composition root');
  // The module core (public + internal, adapters subtree excluded) is
  // provider-neutral: the platform identity is the adapter key as DATA.
  const moduleCore = stripComments(
    socialPublic + socialModule + socialAdapterContract + socialAdapterStore,
  ).toLowerCase();
  for (const identifier of platformIdentifiers) {
    assert.ok(!moduleCore.includes(identifier), `the /social-accounts core must never contain '${identifier}'`);
  }
  assert.ok(
    stripComments(socialModule).includes('adapterRegistry.get(account.platformId)'),
    'the platform identity is a registry data lookup, never a provider branch',
  );
});

test('MKT-056: NO social-SDK import exists anywhere in src/ (the EXTERNAL_PACKAGE_IN_SRC half of the fence)', () => {
  // The arch-check rule already forbids every external package except
  // 'pg' inside adapters; this scan additionally pins the known social
  // SDK package NAMES outside the sanctioned adapter subtrees (inside
  // the subtrees, provider ENDPOINT strings like the ads API host are
  // legitimate — actual SDK IMPORTS remain forbidden everywhere by
  // arch-check's EXTERNAL_PACKAGE_IN_SRC).
  const sdkNames = ['googleapis', 'facebook-node-sdk', '@tiktok/sdk', 'twitter-api-v2', 'instagram-private-api'];
  for (const file of walk(join(repoRoot, 'src'))) {
    if (!file.endsWith('.ts')) continue;
    const rel = relative(repoRoot, file).split('\\').join('/');
    if (rel.split('/').includes('adapters')) continue;
    if (rel === 'src/composition-root.ts') continue;
    const text = readFileSync(file, 'utf8');
    for (const sdk of sdkNames) {
      assert.ok(
        !text.includes(sdk),
        `no social SDK reference ('${sdk}') may exist outside the adapter subtrees — adapters use the platform HttpCallPort (the /integrations INT-001 discipline)`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 5. The adapter subtree contract
// ---------------------------------------------------------------------------

test('MKT-056: the sanctioned adapter subtree exists with the re-export shim as its ONLY current resident', () => {
  const adaptersDir = src('modules', 'social-accounts', 'internal', 'adapters');
  assert.ok(existsSync(adaptersDir), 'internal/adapters/ exists (the MKT-057..061 home)');
  const residents = readdirSync(adaptersDir);
  assert.deepEqual(residents, ['adapter-contract.ts'], 'the subtree currently holds only the re-export shim — the platform implementations arrive with their own Work Items');
  // The shim re-exports the contract from the module's internal contract
  // (NOT from another adapter — ADAPTER_COUPLING is impossible by shape).
  assert.ok(adaptersShim.includes("from '../adapter-contract.ts'"));
  assert.ok(adaptersShim.includes('export type {'));
  // NOTHING in src/ imports the shim yet (comment-stripped: prose
  // mentions do not count; the composition root will wire the concrete
  // adapters as DATA when the platform deliveries land).
  const importers: string[] = [];
  for (const file of walk(join(repoRoot, 'src'))) {
    if (!file.endsWith('.ts')) continue;
    const text = stripComments(readFileSync(file, 'utf8'));
    if (text.includes('internal/adapters/adapter-contract.ts')) importers.push(relative(repoRoot, file));
  }
  assert.deepEqual(importers, [], 'no src/ file imports the adapter-subtree shim yet (the MKT-057..061 adapters import it from their own subtrees)');
});

// ---------------------------------------------------------------------------
// 6. The composition seams
// ---------------------------------------------------------------------------

test('MKT-056: the disclosed composition seams exist; the production registries stay EMPTY by default (fail-closed)', () => {
  // AppOptions seams (the socialAccountFlows precedent).
  assert.ok(
    compositionRoot.includes('readonly socialPlatformAdapters?: ReadonlyArray<SocialPlatformAdapter> | undefined'),
    'AppOptions.socialPlatformAdapters exists',
  );
  assert.ok(
    compositionRoot.includes('readonly integrationAdapters?: ReadonlyArray<IntegrationAdapter> | undefined'),
    'AppOptions.integrationAdapters exists (the conformance-suite stub pipe seam)',
  );
  // The wiring: the module receives the adapter data; the production
  // default is the EMPTY registry.
  assert.ok(
    compositionRoot.includes('socialAdapters: options.socialPlatformAdapters ?? []'),
    'the module socialAdapters dep defaults to EMPTY (fail-closed until MKT-057..061)',
  );
  assert.ok(
    compositionRoot.includes('...(options.integrationAdapters ?? [])'),
    'the integrations registry appends the seam adapters (EMPTY by default)',
  );
  // The module deps surface (the data discipline).
  assert.ok(
    socialPublic.includes('readonly socialAdapters: readonly SocialPlatformAdapter[]'),
    'the module deps carry the adapter registration surface',
  );
  // The registry is built at construction (validated DATA, fail-closed).
  assert.ok(socialModule.includes('buildSocialAdapterRegistry(deps.socialAdapters)'));
});

// ---------------------------------------------------------------------------
// 7. The disclosed registration posture + the migration tail
// ---------------------------------------------------------------------------

test('MKT-056: NO new module/matrix row (the extension posture) — the enforced set and the /social-accounts row are unchanged; 050 holds the tail', () => {
  // The enforced frozen set is UNCHANGED (this Work Item extends an
  // existing module; workers B and C add modules on their branches —
  // the Tech Lead reconciles the counts at merge).
  const result = checkArchitecture({
    codeRoot: repoRoot,
    specDir: join(repoRoot, 'spec'),
    skip: ['tests/architecture/fixtures', 'console'],
  });
  assert.deepEqual(
    result.violations.map((v) => `[${v.rule}] ${v.file}`),
    [],
    'the real codebase enforces the frozen boundaries with ZERO violations',
  );
  assert.ok(result.frozenModules.includes('social-accounts'));
  // The /social-accounts matrix row is the UNCHANGED MKT-055 registration
  // (the v1.6 frozen row's /clients allowance remains deliberately
  // unused — same posture as the MKT-055 delivery).
  const specModules = parseFrozenModules(join(repoRoot, 'spec', 'architecture.md'));
  const matrix = parseFrozenMatrix(
    join(repoRoot, 'spec', 'module-dependency-matrix.md'),
    join(repoRoot, 'spec', 'module-dependency-v1.3.md'),
    [...specModules, 'apps'],
  );
  assert.deepEqual(matrix['social-accounts'], ['integrations', 'credentials', 'policies', 'workspaces']);
  // The §6 module list does NOT grow in this Work Item.
  assert.ok(/^\/social-accounts$/m.test(architectureSpec));
  assert.ok(
    !/^\/social-adapters$/m.test(architectureSpec) && !/^\/social-adapter-contract$/m.test(architectureSpec),
    'this Work Item registers NO new §6 module (the extension posture)',
  );
  assert.ok(
    matrixSpec.includes('/social-accounts ──→ /integrations, /credentials, /policies, /workspaces'),
    'the /social-accounts matrix row is the unchanged MKT-055 registration',
  );
  // 050 holds its numeric position (the disclosed number — the
  // MKT-063 sibling appended 051 after it and the MKT-064 sibling
  // appended 053 after that at merge; the Tech Lead reconciles the
  // sibling tails — 052 is left for the MKT-054 renumber).
  const migrationsOnDisk = readdirSync(src('platform', 'db', 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  // The MKT-067 /experiment-analysis sibling delivery appends 054 and
  // the MKT-065 /cross-platform-distribution sibling delivery appends
  // 055 (the PRE-ASSIGNED numbers — the same additive precedent; every
  // tail position shifts once more).
  assert.equal(migrationsOnDisk[migrationsOnDisk.length -1], '055_cross_platform_distribution.sql');
  assert.equal(migrationsOnDisk[migrationsOnDisk.length -2], '054_experiment_analysis.sql');
  assert.equal(migrationsOnDisk[migrationsOnDisk.length -3], '053_content_assets.sql');
  assert.equal(migrationsOnDisk[migrationsOnDisk.length -4], '052_growth_operator.sql');
  assert.equal(migrationsOnDisk[migrationsOnDisk.length -5], '051_content_rights.sql');
  assert.equal(migrationsOnDisk[migrationsOnDisk.length -6], '050_social_adapter_contract.sql');
  assert.equal(migrationsOnDisk[migrationsOnDisk.length -7], '049_commerce_capabilities.sql');
});

// ---------------------------------------------------------------------------
// 8. The public-contract import posture (the matrix-listed directions only)
// ---------------------------------------------------------------------------

test('MKT-056: the /social-accounts public contract still imports ONLY the matrix-listed module publics', () => {
  const imports = [...socialPublic.matchAll(/from '\.\.\/([\w-]+)\/public\.ts'/g)].map((m) => m[1]!);
  assert.deepEqual([...new Set(imports)].sort(), ['credentials', 'integrations', 'policies']);
  // The new internal files import platform ports + same-module files only.
  for (const file of [socialAdapterContract, socialAdapterStore]) {
    const moduleImports = [...file.matchAll(/from '\.\.\/\.\.\/([\w-]+)\/([\w-]+)\.ts'/g)].map((m) => `${m[1]!}/${m[2]!}`);
    for (const imported of moduleImports) {
      assert.ok(
        imported.startsWith('platform/'),
        `the adapter contract files import platform ports only, found '${imported}'`,
      );
    }
  }
});
