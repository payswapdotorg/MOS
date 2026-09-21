/**
 * PLAT-AC-01 evidence: static architecture checks.
 *
 * 1. The frozen module set and dependency matrix are parsed from the FROZEN
 *    SPEC DOCUMENTS themselves (spec/architecture.md §6,
 *    spec/module-dependency-matrix.md, spec/module-dependency-v1.3.md) — the
 *    enforced boundaries cannot drift from the frozen architecture.
 * 2. The real codebase has zero violations: frozen module boundaries exist
 *    and cross-module access uses declared interfaces.
 * 3. Negative fixtures prove that forbidden imports, forbidden dependency
 *    directions and structure violations are REJECTED — the checker is not a
 *    rubber stamp. Each planted violation must be reported exactly, and no
 *    unexpected violation may appear (exact-set assertions).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkArchitecture, parseFrozenMatrix, parseFrozenModules } from '../../tools/arch-check/checker.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const specDir = path.join(repoRoot, 'spec');

test('frozen module set is parsed from spec/architecture.md §6 (43 modules)', () => {
  const modules = parseFrozenModules(path.join(specDir, 'architecture.md'));
  assert.equal(modules.length, 43);
  // Spot-check the full frozen set from the architecture document (the
  // MKT-045 delivery appends /ai-operator — the §7 registration; the
  // MKT-046 delivery appends /sales-continuity — the §8 registration; the
  // MKT-044 delivery appends /client-memory — the §6 registration; the
  // MKT-050 delivery appends /app-marketplace — the trust/certification
  // registration; the MKT-052 delivery appends /app-metering — the
  // metering/attribution registration; the MKT-051 delivery appends
  // /first-party-apps — the Incumbent Capability App Program
  // composition home; the MKT-053 delivery appends /growth-missions —
  // the v1.6 Growth Mission and Objective Model registration; the
  // MKT-055 delivery appends /social-accounts — the v1.6 Social Account
  // and OAuth Connection Model registration; the MKT-069 delivery
  // appends /product-intelligence — the v1.6 Product Intelligence
  // registration).
  // and OAuth Connection Model registration; the MKT-068 delivery
  // appends /notification-delivery — the v1.6 Notification Delivery
  // Plane registration).
  // The MKT-063 delivery appends /content-rights — the v1.6 Content
  // Rights and Provenance registration.
  // The MKT-064 delivery appends /content-assets — the v1.6 Content
  // Asset and Transformation Authority registration (the mutual seam
  // completion of the 063 registration).
  assert.deepEqual(
    [...modules].sort(),
    [
      'agencies', 'agents', 'ai-operator', 'ai-runtime', 'app-installs', 'app-marketplace', 'app-metering', 'audit', 'auth', 'client-memory', 'clients', 'content-assets', 'content-rights', 'credentials',
      'decisions', 'deployments', 'domain-packs', 'evidence', 'executions', 'experiments',
      'extensions', 'field-agents', 'first-party-apps', 'goals', 'growth-missions', 'growth-operator', 'integrations', 'jobs', 'learnings', 'metrics',
      'notification-delivery', 'notifications', 'operating-graph', 'playbooks', 'policies', 'product-intelligence', 'profit-intelligence',
      'reporting', 'sales-continuity', 'social-accounts', 'users', 'workflows', 'workspaces',
    ].sort(),
  );
});

test('frozen dependency matrix is parsed from the frozen spec documents', () => {
  const modules = parseFrozenModules(path.join(specDir, 'architecture.md'));
  // The matrix rows may name the disclosed MKT-047 v1.5 composition
  // provision module 'apps' (the /app-installs row of the MKT-048 delivery
  // does) — parse with the provision module included, exactly as
  // checkArchitecture does.
  const matrix = parseFrozenMatrix(
    path.join(specDir, 'module-dependency-matrix.md'),
    path.join(specDir, 'module-dependency-v1.3.md'),
    [...modules, 'apps'],
  );
  // spec/module-dependency-matrix.md entries:
  assert.deepEqual(matrix['workflows'], ['workspaces', 'goals', 'playbooks', 'executions', 'policies', 'audit']);
  assert.deepEqual(matrix['auth'], ['users']);
  assert.deepEqual(matrix['reporting'], ['goals', 'workflows', 'executions', 'evidence', 'experiments', 'metrics', 'learnings']);
  // spec/module-dependency-v1.3.md addendum entry:
  assert.ok((matrix['domain-packs'] ?? []).includes('workflows'));
  assert.equal(matrix['domain-packs']?.length, 16);
  // Modules with no frozen allowances depend on nothing:
  assert.deepEqual(matrix['users'], []);
  assert.deepEqual(matrix['deployments'], []);
  // The MKT-041 additive matrix line (the /operating-graph read-only
  // composition over the canonical authorities):
  assert.deepEqual(matrix['operating-graph'], [
    'clients', 'workspaces', 'goals', 'playbooks', 'workflows', 'executions',
    'deployments', 'evidence', 'experiments', 'learnings',
  ]);
  // The MKT-048 additive matrix line (the /app-installs App installation
  // authority over the /apps registry + the /policies install gate + the
  // /workspaces ownership and /extensions availability structural ports):
  assert.deepEqual(matrix['app-installs'], ['apps', 'policies', 'workspaces', 'extensions']);
  // The MKT-050 additive matrix line (the /app-marketplace discovery/trust/
  // review surface over the /apps registry — READ-ONLY catalog composition;
  // the MKT-048 trust-state wiring arrives through the disclosed structural
  // port declared in /app-installs' public entry, deliberately off-matrix):
  assert.deepEqual(matrix['app-marketplace'], ['apps']);
  // The MKT-052 additive matrix line (the /app-metering metering and
  // commercial attribution authority over the /apps registry, the
  // /app-installs ledger, the /extensions invocation ledger and the
  // /workspaces ownership structural port):
  assert.deepEqual(matrix['app-metering'], ['apps', 'app-installs', 'extensions', 'workspaces']);
  // The MKT-043 additive matrix line (the /profit-intelligence derived
  // analytics read model over the canonical authorities):
  assert.deepEqual(matrix['profit-intelligence'], [
    'clients', 'workspaces', 'goals', 'playbooks', 'workflows', 'executions',
    'deployments', 'evidence', 'metrics', 'jobs', 'field-agents', 'ai-runtime',
    'integrations',
  ]);
  // The MKT-045 additive matrix line (the /ai-operator derived ranked
  // attention-queue read model over the canonical authorities + the
  // consumed /profit-intelligence public figures):
  assert.deepEqual(matrix['ai-operator'], [
    'clients', 'workspaces', 'workflows', 'executions', 'deployments', 'jobs',
    'policies', 'evidence', 'experiments', 'learnings', 'field-agents',
    'profit-intelligence',
  ]);
  // The MKT-046 additive matrix line (the /sales-continuity §8
  // orchestrator over the proposal + delivery authorities):
  assert.deepEqual(matrix['sales-continuity'], [
    'decisions', 'playbooks', 'deployments', 'clients', 'workspaces', 'evidence',
  ]);
  // The MKT-044 additive matrix line (the /client-memory derived
  // governed-projection read model over the canonical authorities):
  assert.deepEqual(matrix['client-memory'], [
    'clients', 'workspaces', 'goals', 'playbooks', 'deployments', 'evidence',
    'experiments', 'decisions', 'learnings',
  ]);
  // The MKT-051 additive matrix line (the /first-party-apps Incumbent
  // Capability App Program composition home over the /apps registry, the
  // /app-installs ledger, the incumbent authorities and /workspaces for
  // the /reporting scope-as-data enumeration):
  assert.deepEqual(matrix['first-party-apps'], [
    'apps', 'app-installs', 'reporting', 'profit-intelligence', 'clients',
    'workspaces', 'decisions', 'evidence', 'metrics', 'integrations',
  ]);
  // The MKT-053 additive matrix line (the /growth-missions v1.6 Growth
  // Mission and Objective Model over the /agencies agency-row authority
  // and the /goals Goal authority — both consumed READ-ONLY through
  // declared structural ports):
  assert.deepEqual(matrix['growth-missions'], ['agencies', 'goals']);
  // The MKT-055 additive matrix line (the /social-accounts Social Account
  // and OAuth Connection Model over the /integrations connection
  // authority, the /credentials vault, the /policies gates and the
  // /workspaces ownership structural port):
  assert.deepEqual(matrix['social-accounts'], ['integrations', 'credentials', 'policies', 'workspaces']);
  // The MKT-069 additive matrix line (the /product-intelligence Product
  // Intelligence authority over the /evidence §21-guard import, the
  // /integrations READ-ONLY structural port and the /ai-runtime
  // model-identity port — the DISCLOSED currently-satisfiable subset of
  // the frozen v1.6 row; /research joins at MKT-062 time):
  assert.deepEqual(matrix['product-intelligence'], ['evidence', 'integrations', 'ai-runtime']);
  // The MKT-068 additive matrix line (the /notification-delivery
  // Notification Delivery Plane over the /notifications boundary, the
  // /policies per-channel gates and the /credentials vault — the frozen
  // v1.6 row):
  assert.deepEqual(matrix['notification-delivery'], ['notifications', 'policies', 'credentials']);
  // The MKT-054 additive matrix line (the /growth-operator persistent
  // goal-pursuit controller over the mission/goal/delegation/record
  // authorities — the DISCLOSED currently-satisfiable subset of the
  // frozen v1.6 row; /platform-health joins at MKT-066 time, and
  // /playbooks + /deployments are listed allowances the MVP loop does
  // not yet exercise):
  assert.deepEqual(matrix['growth-operator'], [
    'growth-missions', 'goals', 'playbooks', 'deployments', 'workflows',
    'executions', 'evidence', 'experiments', 'learnings', 'decisions',
    'policies',
  ]);
  // The MKT-063 additive matrix line (the /content-rights Content
  // Rights and Provenance authority over the /evidence canonical
  // resolution, the /policies destination gate and the /content-assets
  // derivation seam — the disclosed subset was COMPLETED at MKT-064
  // time by the mutual registration):
  assert.deepEqual(matrix['content-rights'], ['evidence', 'policies', 'content-assets']);
  // The MKT-064 additive matrix line (the /content-assets Content Asset
  // and Transformation Authority over the /executions transformation
  // flow and the /content-rights derivation seam — the DISCLOSED
  // module-importable subset of the frozen v1.6 row: /object-storage is
  // the platform ObjectStore port direction and carries no matrix
  // weight):
  assert.deepEqual(matrix['content-assets'], ['executions', 'content-rights']);
});

test('PLAT-AC-01: real codebase enforces frozen boundaries — zero violations', () => {
  const result = checkArchitecture({
    codeRoot: repoRoot,
    specDir,
    skip: ['tests/architecture/fixtures', 'console'],
  });

  assert.deepEqual(
    result.violations.map((violation) => `[${violation.rule}] ${violation.file}: ${violation.detail}`),
    [],
  );

  // The frozen module boundaries EXIST as module directories with public entries.
  const modulesDir = path.join(repoRoot, 'src', 'modules');
  const onDisk = fs
    .readdirSync(modulesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(onDisk, [...result.frozenModules].sort());
  for (const module of result.frozenModules) {
    assert.ok(
      fs.existsSync(path.join(modulesDir, module, 'public.ts')),
      `module ${module} is missing its public entry`,
    );
  }
  assert.ok(result.filesChecked > 60, 'expected the real codebase to be scanned');
});

test('negative fixture: forbidden imports and dependency directions are rejected (exact set)', () => {
  const fixtureRoot = path.join(repoRoot, 'tests', 'architecture', 'fixtures', 'import-violations');
  const result = checkArchitecture({ codeRoot: fixtureRoot, specDir });

  const actual = result.violations
    .map((violation) => `${violation.rule}|${violation.file}`)
    .sort();

  // Every planted violation must be reported, and nothing else.
  const expected = [
    // The fixture jobs service makes TWO forbidden module imports —
    // /goals (the classic matrix violation) AND /integrations (the
    // module-internal adapter import) — so the matrix rule fires twice.
    'FORBIDDEN_MODULE_DEPENDENCY|src/modules/jobs/internal/service.ts',
    'FORBIDDEN_MODULE_DEPENDENCY|src/modules/jobs/internal/service.ts',
    'CROSS_MODULE_INTERNAL_ACCESS|src/modules/jobs/internal/service.ts',
    'CONCRETE_ADAPTER_ACCESS|src/modules/jobs/internal/service.ts',
    'CROSS_MODULE_INTERNAL_ACCESS|src/modules/workflows/internal/engine.ts',
    'PLATFORM_IMPORTS_MODULE|src/platform/queue/contract.ts',
    // TWO adapter imports live in the fixture api/routes.ts — the
    // platform pg-queue adapter AND the /integrations module-internal
    // meta connector — so the adapter-import rule fires twice (once per
    // import; the violation list is per-import, not per-file).
    'CONCRETE_ADAPTER_ACCESS|src/api/routes.ts',
    'CONCRETE_ADAPTER_ACCESS|src/api/routes.ts',
    'CROSS_MODULE_INTERNAL_ACCESS|src/api/routes.ts',
    'CONCRETE_ADAPTER_ACCESS|src/platform/queue/adapters/postgres/pg-queue.ts',
    'ADAPTER_COUPLING|src/platform/queue/adapters/postgres/pg-queue.ts',
    'EXTERNAL_PACKAGE_IN_SRC|src/workers/worker-host.ts',
    'PG_OUTSIDE_ADAPTER|src/platform/http/server.ts',
    'ENTRYPOINT_BOUNDARY|src/entrypoints/api.ts',
    'IMPORTS_ENTRYPOINT|src/api/routes.ts',
    'COMPOSITION_ROOT_IMPORT|src/workers/worker-host.ts',
    'TEST_MODULE_INTERNAL_IMPORT|tests/unit/sample.test.ts',
    'UNRESOLVED_IMPORT|src/api/routes.ts',
    'MODULE_IMPORTS_APPLICATION|src/modules/goals/internal/service.ts',
    // The /ai-operator registration (the MKT-045 delivery): the fixture
    // provides no ai-operator boundary, so the frozen module is reported
    // missing — exactly as for every other spec-parsed frozen module the
    // fixture omits.
    'MISSING_MODULE|src/modules/ai-operator',
    // The MKT-046 registration adds /sales-continuity to the enforced
    // set; the fixture provides no such boundary → the missing-module
    // violation joins the exact set (the /client-memory boundary stub
    // for the MKT-044 registration is provided — the MKT-043 fixture
    // precedent).
    'MISSING_MODULE|src/modules/sales-continuity',
    // The MKT-050 /app-marketplace §6 registration makes the fixture's
    // missing marketplace boundary a MISSING_MODULE violation (the
    // fixture provides only auth/users/goals — the additive count each
    // sibling promotion adds).
    'MISSING_MODULE|src/modules/app-marketplace',
    // The MKT-052 /app-metering §6 registration makes the fixture's
    // missing metering boundary a MISSING_MODULE violation (the same
    // additive count each sibling promotion adds).
    'MISSING_MODULE|src/modules/app-metering',
    // The MKT-051 /first-party-apps §6 registration makes the fixture's
    // missing pack-home boundary a MISSING_MODULE violation (the same
    // additive count each sibling promotion adds).
    'MISSING_MODULE|src/modules/first-party-apps',
    // The MKT-053 /growth-missions §6 registration makes the fixture's
    // missing mission boundary a MISSING_MODULE violation (the same
    // additive count each sibling promotion adds).
    'MISSING_MODULE|src/modules/growth-missions',
    // The MKT-055 /social-accounts §6 registration (the v1.6 Social
    // Account and OAuth Connection Model) makes the fixture's missing
    // social-accounts boundary a MISSING_MODULE violation (the same
    // additive count each sibling promotion adds).
    'MISSING_MODULE|src/modules/social-accounts',
    // The MKT-069 /product-intelligence §6 registration (the v1.6 Product
    // Intelligence authority) makes the fixture's missing
    // product-intelligence boundary a MISSING_MODULE violation (the same
    // additive count each sibling promotion adds).
    'MISSING_MODULE|src/modules/product-intelligence',
    // The MKT-068 /notification-delivery §6 registration (the v1.6
    // Notification Delivery Plane) makes the fixture's missing
    // notification-delivery boundary a MISSING_MODULE violation (the
    // same additive count each sibling promotion adds).
    'MISSING_MODULE|src/modules/notification-delivery',
    // The MKT-054 /growth-operator §6 registration (the v1.6 Growth
    // Operator) makes the fixture's missing growth-operator boundary a
    // MISSING_MODULE violation (the same additive count each sibling
    // promotion adds).
    'MISSING_MODULE|src/modules/growth-operator',
    // The MKT-063 /content-rights §6 registration (the v1.6 Content
    // Rights and Provenance authority) makes the fixture's missing
    // content-rights boundary a MISSING_MODULE violation (the same
    // additive count each sibling promotion adds).
    'MISSING_MODULE|src/modules/content-rights',
    // The MKT-064 /content-assets §6 registration (the v1.6 Content
    // Asset and Transformation authority) makes the fixture's missing
    // content-assets boundary a MISSING_MODULE violation (the same
    // additive count each sibling promotion adds).
    'MISSING_MODULE|src/modules/content-assets',
  ].sort();

  assert.deepEqual(actual, expected);
});

test('negative fixture: the composition root wiring a module-internal adapter is the SANCTIONED exception (no violation)', () => {
  // The fixture composition root imports BOTH a platform adapter and the
  // /integrations module-internal first-party connector adapter — exactly
  // the frozen "Composition root" provision ("external integration
  // adapters are wired at the composition root") and the
  // CONCRETE_ADAPTER_ACCESS allowance. The fixture api/routes.ts and
  // modules/jobs/internal/service.ts import the SAME adapter and are
  // rejected in the exact-set test above — the exception is composition
  // root ONLY.
  const fixtureRoot = path.join(repoRoot, 'tests', 'architecture', 'fixtures', 'import-violations');
  const result = checkArchitecture({ codeRoot: fixtureRoot, specDir });
  const compositionRootViolations = result.violations.filter(
    (violation) => violation.file === 'src/composition-root.ts',
  );
  assert.deepEqual(compositionRootViolations, []);
});

test('negative fixture: structure violations are rejected (unknown module dir, missing public entry, stray file, missing frozen modules)', () => {
  const fixtureRoot = path.join(repoRoot, 'tests', 'architecture', 'fixtures', 'structure-violations');
  const result = checkArchitecture({ codeRoot: fixtureRoot, specDir });

  const byRule = new Map<string, number>();
  for (const violation of result.violations) {
    byRule.set(violation.rule, (byRule.get(violation.rule) ?? 0) + 1);
  }

  assert.equal(byRule.get('UNKNOWN_MODULE_DIR'), 1);
  assert.equal(byRule.get('MISSING_MODULE_PUBLIC'), 1);
  assert.equal(byRule.get('MODULE_STRUCTURE'), 1);
  // 40 enforced modules (the 39 spec-parsed frozen modules — the v1.4 26
  // PLUS /decisions registered by the MKT-042 delivery, /operating-graph
  // registered by the MKT-041 delivery, /app-installs registered by the
  // MKT-048 delivery, /profit-intelligence registered by the MKT-043
  // delivery, /sales-continuity registered by the MKT-046 delivery,
  // /client-memory registered by the MKT-044 delivery, /ai-operator
  // registered by the MKT-045 delivery, /app-marketplace registered by
  // the MKT-050 delivery, /app-metering registered by the MKT-052
  // delivery, /first-party-apps registered by the MKT-051 delivery,
  // /growth-missions registered by the MKT-053 delivery,
  // /social-accounts registered by the MKT-055 delivery and
  // /product-intelligence registered by the MKT-069 delivery, all per the
  // delivery, /first-party-apps registered by the MKT-051 delivery and
  // /growth-missions registered by the MKT-053 delivery and
  // /social-accounts registered by the MKT-055 delivery and
  // /notification-delivery registered by the MKT-068 delivery, all per the
  // disclosed promotion precedent — PLUS the
  // disclosed MKT-047 v1.5 composition provision 'apps' in
  // tools/arch-check/checker.ts); the fixture provides
  // /content-rights registered by the MKT-063 delivery, /growth-operator
  // registered by the MKT-054 delivery and /content-assets registered by
  // the MKT-064 delivery (the same additive count each sibling promotion
  // adds — the merged-tree truth after the 054 + 064 sibling reconciliation).
  assert.equal(
    [...byRule.values()].reduce((sum, count) => sum + count, 0),
    44,
    'no unexpected violation categories may be reported',
  );

  const unknown = result.violations.find((violation) => violation.rule === 'UNKNOWN_MODULE_DIR');
  assert.equal(unknown?.file, 'src/modules/billing');
  const structure = result.violations.find((violation) => violation.rule === 'MODULE_STRUCTURE');
  assert.equal(structure?.file, 'src/modules/goals/service.ts');
});

test('checker fails loudly when the spec cannot be parsed (no silent drift)', () => {
  const bogusSpecDir = fs.mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp-spec-'));
  try {
    fs.writeFileSync(path.join(bogusSpecDir, 'architecture.md'), '# no module section\n');
    fs.writeFileSync(path.join(bogusSpecDir, 'module-dependency-matrix.md'), '# no matrix\n');
    fs.writeFileSync(path.join(bogusSpecDir, 'module-dependency-v1.3.md'), '# no addendum\n');
    assert.throws(() =>
      checkArchitecture({ codeRoot: path.join(repoRoot, 'tests', 'architecture', 'fixtures', 'structure-violations'), specDir: bogusSpecDir }),
    );
  } finally {
    fs.rmSync(bogusSpecDir, { recursive: true, force: true });
  }
});
