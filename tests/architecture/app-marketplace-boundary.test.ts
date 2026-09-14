/**
 * MKT-050 static tests — the App Marketplace, Trust and Certification
 * domain is structurally correct in the ACTUAL migration, module
 * contract and route surface (pure static analysis, no DB).
 *
 * Proofs (spec/mos-app-ecosystem-v1.5.md "Trust levels" + "Manifest" +
 * "Economics" — the primary contract; frozen by
 * spec/architecture-lock-v1.5.md rules #7/#10/#11/#13; frozen matrix
 * registration /app-marketplace ──→ /apps):
 *   1. migration 042 (the PRE-ASSIGNED number) creates exactly
 *      `trust_events` + `app_reviews` — OWN tables ONLY, NO app
 *      catalog table (the marketplace NEVER becomes a second registry:
 *      every catalog fact is an /apps registry row), no install
 *      ledger, no metering/attribution table (MKT-052 boundary), no
 *      tenant/agency/client/workspace columns (the ledgers are global
 *      catalog state, the 037 posture);
 *   2. the FROZEN TRUST VOCABULARY is CHECK-fenced on both state
 *      columns; the legal (transition, from, to) triple fence encodes
 *      EXACTLY the one-way ladder + the disclosed down moves (no
 *      skip, no same-state); the gapless transition sequence, the
 *      §8 idempotency fences, the chain-consistency trigger (the
 *      derived state can never disagree with the recorded tail) and
 *      the append-only UPDATE/DELETE rejection triggers exist;
 *   3. the review records carry the closed rating band + verdict
 *      vocabulary, the bounded body, the same-lineage
 *      version-consistency trigger and the append-only triggers;
 *   4. the /app-marketplace public contract imports ONLY the /apps
 *      public (the matrix-listed direction) — NO other module
 *      imports, NO provider SDKs, NO module-internal cross imports;
 *   5. the store/module mutation surface is INSERT-only on the OWN
 *      tables — NO UPDATE, NO DELETE, no DML on any registry,
 *      install, policy or tenant table (the marketplace never
 *      rewrites the /apps registry);
 *   6. the route surface is exactly the five frozen routes (three
 *      GET-only discovery surfaces + the two POST commands); NO
 *      PATCH/PUT/DELETE (trust events and reviews are append-only);
 *   7. the DTO discipline is structural: the forbidden authority-field
 *      list includes every trust-shaped, review-shaped,
 *      provenance-shaped and material key — trust state is NEVER
 *      caller-suppliable;
 *   8. TRUST-IS-METADATA-NOT-AUTHORITY (the heart of AC-3): the
 *      MKT-048 gate enrichment is ADDITIVE — the pure
 *      buildInstallGateAction is unchanged (the registry birth state
 *      stays its input), the trustState port is OPTIONAL on the
 *      /app-installs deps, the fail-closed gate semantics (explicit
 *      allow required) are untouched, and the composition root wires
 *      the marketplace instance structurally;
 *   9. the disclosed spec registration exists: /app-marketplace in
 *      spec/architecture.md §6 + the matrix row in
 *      spec/module-dependency-matrix.md.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APP_REVIEW_VERDICTS,
  TRUST_TRANSITION_TARGETS,
  MARKETPLACE_PUBLISHER_KINDS,
  APP_REVIEW_RATING_MAX,
  APP_REVIEW_RATING_MIN,
} from '../../src/modules/app-marketplace/public.ts';
import { APP_CERTIFICATION_STATES } from '../../src/modules/apps/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migration042 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '042_app_marketplace.sql'),
  'utf8',
);
const marketplacePublic = readFileSync(
  join(repoRoot, 'src', 'modules', 'app-marketplace', 'public.ts'),
  'utf8',
);
const marketplaceModule = readFileSync(
  join(repoRoot, 'src', 'modules', 'app-marketplace', 'internal', 'module.ts'),
  'utf8',
);
const marketplaceStore = readFileSync(
  join(repoRoot, 'src', 'modules', 'app-marketplace', 'internal', 'store.ts'),
  'utf8',
);
const marketplaceRoutes = readFileSync(
  join(repoRoot, 'src', 'api', 'app-marketplace-routes.ts'),
  'utf8',
);
const appInstallsPublic = readFileSync(
  join(repoRoot, 'src', 'modules', 'app-installs', 'public.ts'),
  'utf8',
);
const appInstallsModule = readFileSync(
  join(repoRoot, 'src', 'modules', 'app-installs', 'internal', 'module.ts'),
  'utf8',
);
const appInstallsStore = readFileSync(
  join(repoRoot, 'src', 'modules', 'app-installs', 'internal', 'store.ts'),
  'utf8',
);
const compositionRoot = readFileSync(
  join(repoRoot, 'src', 'composition-root.ts'),
  'utf8',
);
const routesTs = readFileSync(join(repoRoot, 'src', 'api', 'routes.ts'), 'utf8');
const applicationTs = readFileSync(join(repoRoot, 'src', 'api', 'application.ts'), 'utf8');
const architectureSpec = readFileSync(join(repoRoot, 'spec', 'architecture.md'), 'utf8');
const matrixSpec = readFileSync(
  join(repoRoot, 'spec', 'module-dependency-matrix.md'),
  'utf8',
);

/** Extracts the CREATE TABLE block for `table` from a migration SQL text. */
function createTableBlock(migration: string, table: string): string {
  const marker = `CREATE TABLE IF NOT EXISTS ${table} (`;
  const start = migration.indexOf(marker);
  assert.ok(start >= 0, `migration must create ${table}`);
  const end = migration.indexOf('\n);', start);
  assert.ok(end > start, `${table} block must terminate`);
  return migration.slice(start, end);
}

function columnsOf(block: string): string[] {
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[a-z_]+\s+\w+/.test(line))
    .map((line) => line.split(/\s+/)[0]!);
}

/** Comment-stripped source (prose must not confuse the DML scans). */
function stripComments(source: string): string {
  return source
    .split('\n')
    .filter(
      (line) =>
        !line.trim().startsWith('//') &&
        !line.trim().startsWith('*') &&
        !line.trim().startsWith('/*'),
    )
    .join('\n');
}

test('MKT-050: migration 042 creates exactly the two marketplace tables — NO app catalog table (no second registry)', () => {
  const created = [...migration042.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \(/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    created,
    ['trust_events', 'app_reviews'],
    'own tables ONLY — the marketplace NEVER becomes a second registry (the /apps registry of migration 037 stays the sole catalog; 038 stays the sole install authority; metering is MKT-052 territory)',
  );
  // The migration README declares the no-second-registry posture.
  assert.ok(migration042.includes('the marketplace NEVER becomes a second registry'));
  assert.ok(migration042.includes('NO install ledger (038 stays the sole install'));

  // The trust ledger's frozen columns.
  const trustColumns = columnsOf(createTableBlock(migration042, 'trust_events'));
  for (const required of [
    'event_id', 'app_key', 'transition_seq', 'transition',
    'from_state', 'to_state', 'reason',
    'recorded_actor', 'recorded_via', 'correlation_id', 'causation_id', 'recorded_at',
    'idempotency_key', 'create_fingerprint',
  ]) {
    assert.ok(trustColumns.includes(required), `trust_events must carry '${required}'`);
  }
  // NO tenant columns anywhere (the ledgers are global catalog state).
  for (const block of [
    createTableBlock(migration042, 'trust_events'),
    createTableBlock(migration042, 'app_reviews'),
  ]) {
    for (const forbidden of ['agency_id', 'client_id', 'workspace_id', 'tenant_id']) {
      assert.ok(
        !columnsOf(block).includes(forbidden),
        `the marketplace tables carry NO tenant column '${forbidden}' (global catalog state, the 037 posture)`,
      );
    }
  }

  // The review records' frozen columns.
  const reviewColumns = columnsOf(createTableBlock(migration042, 'app_reviews'));
  for (const required of [
    'review_id', 'app_key', 'app_version_id', 'rating', 'verdict', 'body',
    'recorded_actor', 'recorded_via', 'correlation_id', 'causation_id', 'recorded_at',
    'idempotency_key', 'create_fingerprint',
  ]) {
    assert.ok(reviewColumns.includes(required), `app_reviews must carry '${required}'`);
  }
  // NO secret-capable column and NO jsonb payload anywhere (the §21
  // backstop is structural: bounded scalars only).
  for (const table of ['trust_events', 'app_reviews']) {
    const block = createTableBlock(migration042, table);
    assert.ok(!/jsonb/.test(block), `${table} carries no jsonb payload`);
    assert.ok(!/secret|password|token|api_key/.test(columnsOf(block).join(',')), `${table} carries no material-shaped column`);
  }
});

test('MKT-050: the frozen trust vocabulary and the legal transition-triple fence are CHECK-fenced (no skip, no same-state)', () => {
  // Both state columns enumerate the frozen vocabulary.
  for (const table of ['trust_events']) {
    const block = createTableBlock(migration042, table);
    for (const state of APP_CERTIFICATION_STATES) {
      assert.ok(
        new RegExp(`${'(from|to)_state'}[^\\n]*IN \\('UNVERIFIED', 'COMMUNITY_VERIFIED', 'MOS_CERTIFIED'\\)`).test(block) ||
          block.includes(`CHECK (${'from'}_state IN ('UNVERIFIED', 'COMMUNITY_VERIFIED', 'MOS_CERTIFIED'))`) ||
          block.includes(`CHECK (${'to'}_state IN ('UNVERIFIED', 'COMMUNITY_VERIFIED', 'MOS_CERTIFIED'))`),
        `the state CHECK enumerates '${state}'`,
      );
    }
  }
  assert.ok(
    migration042.includes("CHECK (from_state IN ('UNVERIFIED', 'COMMUNITY_VERIFIED', 'MOS_CERTIFIED'))"),
    'the from_state CHECK fence exists',
  );
  assert.ok(
    migration042.includes("CHECK (to_state IN ('UNVERIFIED', 'COMMUNITY_VERIFIED', 'MOS_CERTIFIED'))"),
    'the to_state CHECK fence exists',
  );
  // The transition label vocabulary.
  assert.ok(
    migration042.includes("CHECK (transition IN ('verify', 'certify', 'decertify', 'revoke'))"),
    'the closed transition-label vocabulary is CHECK-fenced',
  );
  // The legal-triple fence names every legal triple explicitly.
  for (const [transition, targets] of Object.entries(TRUST_TRANSITION_TARGETS)) {
    for (const target of targets) {
      const triple = `transition = '${transition}' AND from_state = '${target.from}'`;
      const toState = `to_state = '${target.to}'`;
      assert.ok(
        migration042.includes(triple) && migration042.includes(toState),
        `the legal triple fence names ${transition}: ${target.from} → ${target.to}`,
      );
    }
  }
  // The one-way ladder semantics are documented as frozen.
  assert.ok(migration042.includes('no skipping: UNVERIFIED → MOS_CERTIFIED is REJECTED'));
  // The §8 fences: the global idempotency key + the gapless per-lineage seq.
  assert.ok(migration042.includes('CONSTRAINT trust_events_seq_unique UNIQUE (app_key, transition_seq)'));
  assert.ok(migration042.includes('trust_events_idempotency_key_unique'));
  assert.ok(migration042.includes('app_reviews_idempotency_key_unique'));
  // The chain-consistency trigger: the first event departs from the
  // UNVERIFIED birth state; every later event from the predecessor's
  // to_state — the derived state can never disagree with the tail.
  assert.ok(/CREATE OR REPLACE FUNCTION trust_events_chain_consistent\(\)/.test(migration042));
  assert.ok(/trust_events_chain_trigger\s*\n?\s*BEFORE INSERT ON trust_events/.test(migration042.replace(/\r/g, '')));
  assert.ok(migration042.includes('must depart from the UNVERIFIED birth state'));
  assert.ok(migration042.includes("predecessor's to_state"));
  // The app lineage FK (read check-only — no registry row is created or
  // mutated from here).
  assert.ok(migration042.includes('REFERENCES apps(app_key)'));
  assert.ok(migration042.includes('read CHECK-ONLY'));
});

test('MKT-050: both ledgers are APPEND-ONLY (UPDATE and DELETE rejected outright by triggers)', () => {
  for (const [table, function_] of [
    ['trust_events', 'trust_events_append_only'],
    ['app_reviews', 'app_reviews_append_only'],
  ] as const) {
    assert.ok(new RegExp(`CREATE OR REPLACE FUNCTION ${function_}\\(\\)`).test(migration042));
    assert.ok(
      new RegExp(`${function_}_update_trigger\\s*\\n?\\s*BEFORE UPDATE ON ${table}`).test(
        migration042.replace(/\r/g, ''),
      ),
      `the ${table} UPDATE rejection trigger exists`,
    );
    assert.ok(
      new RegExp(`${function_}_delete_trigger\\s*\\n?\\s*BEFORE DELETE ON ${table}`).test(
        migration042.replace(/\r/g, ''),
      ),
      `the ${table} DELETE rejection trigger exists`,
    );
  }
  // A trust transition is NEVER a silent rewrite (the migration's own
  // governance prose).
  assert.ok(migration042.includes('NEVER a silent rewrite'));
  // The review version-consistency trigger (same-lineage targets only).
  assert.ok(/CREATE OR REPLACE FUNCTION app_reviews_version_consistent\(\)/.test(migration042));
  assert.ok(migration042.includes("never attach to another lineage''s version"));
  // The review closed vocabularies are CHECK-fenced.
  assert.ok(migration042.includes(`CHECK (rating >= ${APP_REVIEW_RATING_MIN} AND rating <= ${APP_REVIEW_RATING_MAX})`));
  for (const verdict of APP_REVIEW_VERDICTS) {
    assert.ok(migration042.includes(`'${verdict}'`), `the verdict CHECK enumerates '${verdict}'`);
  }
  assert.ok(migration042.includes("CHECK (verdict IN ('positive', 'mixed', 'negative'))"));
  assert.ok(migration042.includes('CHECK (length(body) >= 1 AND length(body) <= 2000)'));
});

test('MKT-050: the public contract imports ONLY the /apps public (the matrix-listed direction)', () => {
  const imports = [...marketplacePublic.matchAll(/from '\.\.\/([\w-]+)\/public\.ts'/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    [...new Set(imports)].sort(),
    ['apps'],
    'public.ts imports exactly the one matrix-listed direction (/app-marketplace ──→ /apps)',
  );
  for (const source of [marketplacePublic, marketplaceModule, marketplaceStore]) {
    assert.ok(!/from '\.\.\/(\w|-)+(\/internal)?\/internal\//.test(source), 'no module-internal cross imports');
    for (const forbidden of [
      'workspaces', 'clients', 'agencies', 'auth', 'users', 'workflows',
      'executions', 'evidence', 'metrics', 'integrations', 'domain-packs',
      'ai-runtime', 'jobs', 'agents', 'audit', 'decisions', 'operating-graph',
      'deployments', 'goals', 'playbooks', 'notifications', 'reporting',
      'app-installs', 'policies', 'extensions',
    ]) {
      assert.ok(
        !source.includes(`from '../../${forbidden}/`) && !source.includes(`from '../${forbidden}/`),
        `the module must not import the /${forbidden} module (the matrix row is /apps only)`,
      );
    }
    assert.ok(!/from 'openai|anthropic|google|@ai-sdk|LangChain/i.test(source), 'no provider SDK imports');
  }
});

test('MKT-050: the mutation surface is INSERT-only on the OWN tables (the marketplace never rewrites the registry)', () => {
  for (const source of [marketplaceStore, marketplaceModule]) {
    const code = stripComments(source);
    // NO UPDATE and NO DELETE DML anywhere — both ledgers are append-only
    // through and through (the DB triggers are the backstop).
    for (const statement of [...code.matchAll(/(INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/g)]) {
      assert.equal(statement[1], 'INSERT INTO', 'the only DML verb is INSERT');
      assert.ok(
        ['trust_events', 'app_reviews'].includes(statement[2]!),
        `DML must target the own tables only (found '${statement[1]} ${statement[2]}')`,
      );
    }
    // The registry, install, policy and tenant tables are never written.
    for (const foreign of [
      'app_versions', 'apps', 'app_dependencies', 'app_installs', 'app_install_events',
      'policy_decisions', 'policy_versions', 'workspaces', 'clients', 'agencies', 'extension',
    ]) {
      assert.ok(
        !new RegExp(`(INSERT INTO|UPDATE|DELETE FROM)\\s+${foreign}\\b`).test(code),
        `the marketplace never writes ${foreign}`,
      );
    }
  }
  // THE LISTING IS REGISTRY DATA ONLY: the module derives every catalog
  // fact from the /apps public version listing (the marketplace NEVER
  // becomes a second registry).
  assert.ok(marketplaceModule.includes('listAppVersions'), 'the module reads the registry listing');
  assert.ok(
    marketplaceModule.includes('THE CATALOG IS REGISTRY DATA ONLY'),
    'the listing derivation is documented as registry-data-only',
  );
});

test('MKT-050: the route surface is exactly the five frozen routes (GET-only discovery + the two POST commands)', () => {
  const registrations = [
    ...marketplaceRoutes.matchAll(/router\.add\(\s*'([A-Z]+)',\s*'([^']+)'/g),
  ].map((match) => [match[1]!, match[2]!] as const);
  assert.deepEqual(
    registrations,
    [
      ['POST', '/api/app-marketplace/apps/:appKey/trust'],
      ['POST', '/api/app-marketplace/apps/:appKey/reviews'],
      ['GET', '/api/app-marketplace/:agencyId/apps'],
      ['GET', '/api/app-marketplace/:agencyId/apps/:appKey'],
      ['GET', '/api/app-marketplace/:agencyId/apps/:appKey/policy-eligibility'],
    ],
    'the marketplace surface is exactly trust/review/listing/detail/eligibility',
  );
  // NO PATCH/PUT/DELETE anywhere: trust events and reviews are
  // append-only; there is no rewrite and no erase path.
  assert.ok(!/'(PATCH|PUT|DELETE)'/.test(marketplaceRoutes), 'no PATCH/PUT/DELETE routes');
  // The discovery family reads NO body (read-only by construction).
  for (const [method, path] of registrations) {
    if (path.includes(':agencyId')) {
      assert.equal(method, 'GET', `the discovery route ${path} is GET-only`);
    }
  }
  // The operator/governance gate is the platform_administrator role (a
  // platform_developer is explicitly insufficient — no self-certification).
  assert.ok(
    marketplaceRoutes.includes("context.platformRoles.includes('platform_administrator')"),
    'trust transitions require the platform_administrator role',
  );
  assert.ok(
    marketplaceRoutes.includes('a platform_developer can never self-certify'),
    'the 403 message names the no-self-certification rule',
  );
  // No second permission/role engine in the routes.
  assert.ok(
    !/role.*engine|permissionTable|canAccess|hasPermission/.test(marketplaceRoutes),
    'no alternate permission authority in the routes',
  );
});

test('MKT-050: the DTO guard rejects every trust-shaped, review-shaped, provenance-shaped and material key', () => {
  const forbiddenListMatch = marketplaceRoutes.match(
    /const MARKETPLACE_AUTHORITY_FIELDS = \[([\s\S]*?)\] as const;/,
  );
  assert.ok(forbiddenListMatch !== null, 'the forbidden authority-field list exists');
  const forbiddenFields = forbiddenListMatch![1]!;
  for (const required of [
    'certificationState', 'trustLevel', 'trust', 'fromState', 'toState',
    'transitionSeq', 'eventId', 'reviewId', 'reviewSummary', 'averageRating',
    'reviewCount', 'provenance', 'actor', 'recordedActor', 'recordedVia',
    'correlationId', 'causationId', 'recordedAt', 'createFingerprint', 'replayed',
  ]) {
    assert.ok(
      forbiddenFields.includes(`'${required}'`),
      `the DTO guard must reject the authority-shaped key '${required}'`,
    );
  }
  assert.ok(
    forbiddenFields.includes('...MATERIAL_KEYS'),
    'the DTO guard spreads the material-shaped key list',
  );
});

test('MKT-050 AC-3 static: the MKT-048 trust enrichment is ADDITIVE — trust is metadata, never authority', () => {
  // 1. The PURE gate action builder is UNCHANGED: the registry record's
  //    birth-state certificationState stays its input (the enrichment
  //    happens in the module wrapper, never in the frozen pure helper).
  const builder = stripComments(appInstallsStore).match(
    /export function buildInstallGateAction\(([\s\S]*?)\n\}/,
  );
  assert.ok(builder !== null, 'buildInstallGateAction exists');
  assert.ok(
    builder![1]!.includes('certificationState: record.certificationState'),
    'the pure builder still derives certificationState from the registry record (MKT-048 semantics preserved)',
  );
  // 2. The trustState port is OPTIONAL on the /app-installs deps.
  assert.ok(appInstallsPublic.includes('AppInstallsTrustStatePort'));
  assert.ok(
    /readonly trustState\?: AppInstallsTrustStatePort;/.test(appInstallsPublic),
    'the trustState dep is optional (unwired = byte-identical MKT-048 behavior)',
  );
  // 3. The enrichment is a thin attribute overlay that preserves the
  //    fail-closed gate: the explicit-allow requirement and the
  //    PolicyDeniedError throw are untouched.
  assert.ok(appInstallsModule.includes('gateActionWithDerivedTrust'));
  assert.ok(
    /if \(trustState === undefined\) \{\s*return action;/.test(appInstallsModule),
    'unwired, the action passes through unchanged',
  );
  assert.ok(
    /enforcementOutcome\(gate\) !== 'allow'/.test(stripComments(appInstallsModule)),
    'the fail-closed explicit-allow requirement is preserved',
  );
  assert.ok(
    stripComments(appInstallsModule).includes('throw new PolicyDeniedError'),
    'the policy denial throw is preserved (trust NEVER grants authority)',
  );
  // 4. The /app-installs module imports NO marketplace code (the port is
  //    declared in its own public entry — the /policies-credentials
  //    precedent). The disclosed DOCUMENTATION may name /app-marketplace;
  //    an import never does.
  for (const source of [appInstallsPublic, appInstallsModule, appInstallsStore]) {
    assert.ok(
      !/from '[^']*app-marketplace/.test(source),
      'zero marketplace imports inside /app-installs (structural port only)',
    );
  }
  // 5. The composition root wires the marketplace instance structurally.
  assert.ok(compositionRoot.includes('trustState: appMarketplace'));
  assert.ok(compositionRoot.includes('createAppMarketplaceModule'));
});

test('MKT-050: application.ts exposes the module, routes.ts registers it, the module boundary is complete', () => {
  assert.ok(applicationTs.includes('appMarketplace: AppMarketplaceModuleApi'));
  assert.ok(applicationTs.includes("from '../modules/app-marketplace/public.ts'"));
  assert.ok(routesTs.includes('registerAppMarketplaceRoutes(router, services, modules)'));
  assert.ok(routesTs.includes("import { registerAppMarketplaceRoutes } from './app-marketplace-routes.ts'"));
  assert.ok(existsSync(join(repoRoot, 'src', 'modules', 'app-marketplace', 'public.ts')));
  assert.ok(existsSync(join(repoRoot, 'src', 'modules', 'app-marketplace', 'internal', 'module.ts')));
  assert.ok(existsSync(join(repoRoot, 'src', 'modules', 'app-marketplace', 'internal', 'store.ts')));
});

test('MKT-050: the disclosed spec registration exists (architecture.md §6 + the dependency-matrix row)', () => {
  assert.ok(
    /^\/app-marketplace$/m.test(architectureSpec),
    'spec/architecture.md §6 lists /app-marketplace',
  );
  assert.ok(
    architectureSpec.includes('`/app-marketplace` is the v1.5 App marketplace, trust and certification surface'),
    'the §6 paragraph names the registration',
  );
  assert.ok(
    /^\/app-marketplace ──→ \/apps$/m.test(matrixSpec),
    'the dependency-matrix row names the sanctioned composition direction',
  );
  assert.ok(
    matrixSpec.includes('`/app-marketplace` is the v1.5 App marketplace, trust and certification surface'),
    'the matrix bullet documents the composition posture',
  );
  // The marketplace attribution boundary is disclosed in the frozen
  // chain (mos-app-ecosystem-v1.5.md "Economics").
  assert.ok(
    matrixSpec.includes('Marketplace attribution stays separate from the core financial authority'),
    'the matrix bullet discloses the economics boundary (no metering/billing in MKT-050)',
  );
});

test('MKT-050: NO metering/attribution state is owned (the economics boundary — MKT-052 territory)', () => {
  // No metering/billing/attribution table, column or route anywhere in
  // the marketplace delivery (mos-app-ecosystem-v1.5.md "Economics").
  for (const source of [migration042, marketplacePublic, marketplaceModule, marketplaceStore, marketplaceRoutes]) {
    for (const forbidden of [/metering_ledger/, /billing/, /invoice/, /charge/, /attribution_table/]) {
      assert.ok(
        !forbidden.test(stripComments(source)),
        `the marketplace owns no metering/attribution state (matched ${forbidden})`,
      );
    }
  }
  // The module's own doc declares the boundary.
  assert.ok(
    marketplacePublic.includes('NO billing, charging, metering or\n *     attribution state'),
    'the module contract declares the MKT-052 boundary',
  );
});

test('MKT-050: the publisher-kind and review vocabularies are closed and derive from the frozen registry identities', () => {
  assert.deepEqual([...MARKETPLACE_PUBLISHER_KINDS].sort(), ['community', 'first-party']);
  // The classification derives from the SERVER-DERIVED registry
  // publisher identity (svc: first-party, dev: community) — never a
  // caller-supplied label.
  assert.ok(marketplacePublic.includes("publisher.startsWith('svc:')"));
  assert.ok(marketplaceRoutes.includes("derivePublisherKind") === false, 'the route surface never classifies publishers (module-side derivation)');
});
