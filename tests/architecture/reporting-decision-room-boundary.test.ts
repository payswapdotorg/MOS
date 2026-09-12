/**
 * MKT-030 static tests — the Client Decision Room boundary is structurally
 * correct in the ACTUAL route file, the /reporting module and the shared
 * registration files (pure static analysis, no DB). Proves the frozen
 * architecture boundaries (spec/work-items.md MKT-030; requirements UI-001 +
 * UI-AC-01..02; spec/architecture.md §25 UI; spec/module-dependency-matrix.md
 * "/reporting ──→ /goals, /workflows, /executions, /evidence, /experiments,
 * /metrics, /learnings" + "/reporting must never mutate authoritative domain
 * state"):
 *
 *   1. the decision room registers EXACTLY ONE surface — the GET decision
 *      room view — and NO mutating verb is registered anywhere in the route
 *      file (READ-ONLY BY CONSTRUCTION: a frontend bypass has nothing to
 *      drive; UI-AC-02);
 *   2. the route file reads NO request body and validates NO DTO — the GET
 *      surface has no DTO at all, so authority fields (agency/client/
 *      workspace identifiers, statuses, provenance) are structurally
 *      unreachable, not merely rejected;
 *   3. the route file's imports are whitelisted: platform + authorize +
 *      application + the /reporting and /clients public contracts ONLY —
 *      the composed authorities (/evidence, /experiments, /learnings,
 *      /goals, /workflows) are reached THROUGH the /reporting module
 *      public, never around it (no second composition engine at the route
 *      layer);
 *   4. thin delegation: the route file's ONLY module calls are the
 *      server-derived workspace enumeration + the /reporting read + the
 *      shared client-scoped authorization helper — no store access, no
 *      mutation, no audit emission (reads are not material mutations);
 *   5. the /reporting module internals import ONLY the matrix-allowed
 *      public contracts (/goals, /workflows, /evidence, /experiments,
 *      /learnings) + the module's own public entry + the platform clock —
 *      and NO store implementation of another module is imported;
 *   6. NO mutating module API exists: the /reporting public contract
 *      exposes exactly ONE method — the decision-room read — and no
 *      create/update/set/append/record/transition/delete verb appears in
 *      the contract (the decision room never becomes a write authority);
 *   7. the shared registration files wire the surface (routes.ts registers
 *      it; the composition root builds the reporting module EXACTLY ONCE
 *      with the matrix-allowed dependencies and documents the MKT-030
 *      additions; application.ts exposes the module contract);
 *   8. PURE LIVE AGGREGATION: migration 031 stays RESERVED and unused —
 *      no projection tables exist anywhere under the migrations directory
 *      (the decision room owns no state authority; nothing is derivable-
 *      only because nothing is stored).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
const read = (path: string): string => readFileSync(path, 'utf8');

const decisionRoomRoutes = read(src('api', 'reporting-decision-room-routes.ts'));
const reportingPublic = read(src('modules', 'reporting', 'public.ts'));
const reportingModule = read(src('modules', 'reporting', 'internal', 'reporting-module.ts'));
const routesFile = read(src('api', 'routes.ts'));
const compositionRoot = read(src('composition-root.ts'));
const applicationFile = read(src('api', 'application.ts'));

/** Imports of a file as raw specifier strings. */
function importsOf(file: string): string[] {
  const text = read(file);
  const specifiers: string[] = [];
  for (const match of text.matchAll(/from\s+'([^']+)'/g)) specifiers.push(match[1]!);
  for (const match of text.matchAll(/import\s+'([^']+)'/g)) specifiers.push(match[1]!);
  return specifiers;
}

// ---------------------------------------------------------------------------
// 1. Exactly one surface — a GET (read-only by construction)
// ---------------------------------------------------------------------------

test('the decision-room routes register EXACTLY ONE surface — the GET decision-room view — and no mutating verb exists in the file', () => {
  const registered = [...decisionRoomRoutes.matchAll(/'(?:GET|POST|PUT|PATCH|DELETE)',\s*'(\/[^']+)'/g)]
    .map((match) => match[1]!);
  assert.deepEqual(registered, ['/api/reporting/decision-room/:clientId']);
  for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.ok(
      !decisionRoomRoutes.includes(`'${verb}',`),
      `the decision room must never register a ${verb} route (UI-AC-02: a frontend bypass cannot change outcomes)`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. No DTO at all — the GET surface reads no body
// ---------------------------------------------------------------------------

test('the route file reads NO request body and validates NO DTO (authority fields are structurally unreachable)', () => {
  assert.ok(!decisionRoomRoutes.includes('validateObject'), 'the GET surface validates no body');
  assert.ok(!decisionRoomRoutes.includes('ctx.request.body'), 'the route never touches a request body');
  assert.ok(
    !decisionRoomRoutes.includes('forbiddenKeys'),
    'there is no DTO to carry authority fields — the surface accepts no input at all',
  );
  assert.ok(
    !decisionRoomRoutes.includes('defineMutationRoute'),
    'the decision room registers no mutation pipeline route',
  );
});

// ---------------------------------------------------------------------------
// 3. Import whitelist — the composed authorities are reached THROUGH /reporting
// ---------------------------------------------------------------------------

test('the route file imports ONLY platform + authorize + application + the /reporting and /clients public contracts', () => {
  const allowed = [
    /^node:/,
    /^\.\.\/platform\//,
    /^\.\.\/modules\/reporting\/public\.ts$/,
    /^\.\.\/modules\/clients\/public\.ts$/,
    /^\.\/authorize\.ts$/,
    /^\.\/application\.ts$/,
  ];
  for (const specifier of importsOf(src('api', 'reporting-decision-room-routes.ts'))) {
    assert.ok(
      allowed.some((pattern) => pattern.test(specifier)),
      `unexpected import '${specifier}' — the decision-room routes compose the /reporting module public contract only`,
    );
  }
  // Explicit negatives: the composed authorities are reached through the
  // /reporting module, never imported directly by the route family.
  for (const specifier of importsOf(src('api', 'reporting-decision-room-routes.ts'))) {
    assert.ok(!specifier.includes('evidence'), 'the route family must not import /evidence directly');
    assert.ok(!specifier.includes('experiments'), 'the route family must not import /experiments directly');
    assert.ok(!specifier.includes('learnings'), 'the route family must not import /learnings directly');
    assert.ok(!specifier.includes('goals'), 'the route family must not import /goals directly');
    assert.ok(!specifier.includes('workflows'), 'the route family must not import /workflows directly');
    assert.ok(!specifier.includes('field-agents'), 'the route family must not import /field-agents');
  }
});

// ---------------------------------------------------------------------------
// 4. Thin delegation — server-derived scope + the read, nothing else
// ---------------------------------------------------------------------------

test('the route file performs ONLY the server-derived workspace enumeration + the /reporting read + the shared client-scoped authorization', () => {
  const allowedModuleCalls = [
    'modules.workspaces.listWorkspacesForClient',
    'modules.reporting.getClientDecisionRoom',
  ];
  for (const match of decisionRoomRoutes.matchAll(/modules\.[a-zA-Z]+\.[A-Za-z]+/g)) {
    assert.ok(
      allowedModuleCalls.includes(match[0]),
      `unexpected module call '${match[0]}' — the decision room is a thin delegation surface`,
    );
  }
  // The shared authorization posture (never a second permission engine).
  assert.ok(decisionRoomRoutes.includes('requireClientAccess'));
  // Reads emit no audit events (nothing material happened).
  assert.ok(!decisionRoomRoutes.includes('recordMutationAudit'));
  assert.ok(!decisionRoomRoutes.includes('audit-emit'));
});

// ---------------------------------------------------------------------------
// 5. The /reporting module composes ONLY matrix-allowed public contracts
// ---------------------------------------------------------------------------

test('the /reporting module internals import ONLY the matrix-allowed public contracts + the own public entry + the platform clock', () => {
  const allowed = [
    /^node:/,
    /^\.\.\/\.\.\/platform\/clock\/clock\.ts$/,
    /^\.\.\/public\.ts$/,
    /^\.\.\/\.\.\/evidence\/public\.ts$/,
    /^\.\.\/\.\.\/experiments\/public\.ts$/,
    /^\.\.\/\.\.\/goals\/public\.ts$/,
    /^\.\.\/\.\.\/learnings\/public\.ts$/,
    /^\.\.\/\.\.\/workflows\/public\.ts$/,
    /^\.\.\/\.\.\/workspaces\/public\.ts$/,
    /^\.\/decision-room-read-model\.ts$/,
    /^\.\/reporting-module\.ts$/,
  ];
  for (const file of [
    src('modules', 'reporting', 'internal', 'reporting-module.ts'),
    src('modules', 'reporting', 'internal', 'decision-room-read-model.ts'),
  ]) {
    for (const specifier of importsOf(file)) {
      assert.ok(
        allowed.some((pattern) => pattern.test(specifier)),
        `unexpected import '${specifier}' in ${file} — /reporting may compose only the frozen-matrix public contracts`,
      );
    }
  }
  // The frozen matrix direction for /reporting, verbatim.
  const matrix = read(join(repoRoot, 'spec', 'module-dependency-matrix.md'));
  assert.ok(
    matrix.includes('/reporting ──→ /goals, /workflows, /executions, /evidence, /experiments, /metrics, /learnings'),
    'the frozen /reporting dependency line must be present (spec is the source of truth)',
  );
  // No store implementation or internals of ANOTHER module is imported
  // anywhere in the /reporting module (own-module internal imports are the
  // module's right; cross-module internals and stores are the bypass).
  for (const file of [
    src('modules', 'reporting', 'public.ts'),
    src('modules', 'reporting', 'internal', 'reporting-module.ts'),
    src('modules', 'reporting', 'internal', 'decision-room-read-model.ts'),
  ]) {
    for (const specifier of importsOf(file)) {
      const crossModule = specifier.startsWith('../..') || specifier.startsWith('/');
      if (!crossModule) continue;
      assert.ok(
        !specifier.includes('/internal/'),
        `the /reporting module never imports another module's internals (found '${specifier}')`,
      );
      assert.ok(
        !specifier.includes('-store'),
        `the /reporting module never imports a store implementation (found '${specifier}')`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 6. NO mutating module API — exactly one read method
// ---------------------------------------------------------------------------

test('the /reporting public contract exposes EXACTLY ONE method — the decision-room read — and no mutating verb exists', () => {
  const apiBlock = reportingPublic.match(
    /export interface ReportingModuleApi \{([\s\S]*?)\n\}/,
  );
  assert.ok(apiBlock !== null, 'ReportingModuleApi is required');
  const methods = [...apiBlock![1]!.matchAll(/^ {2}([a-zA-Z]+)\(/gm)].map((match) => match[1]!);
  assert.deepEqual(methods, ['getClientDecisionRoom']);
  for (const forbidden of [
    'create',
    'update',
    'set',
    'append',
    'record',
    'transition',
    'delete',
    'remove',
    'mutate',
    'approve',
    'reject',
    'decide',
  ]) {
    assert.ok(
      !methods.some((method) => method.toLowerCase().startsWith(forbidden)),
      `the /reporting contract must never expose a '${forbidden}' verb (read-side authority only)`,
    );
  }
  // And the implementation wires exactly that one method.
  assert.equal((reportingModule.match(/async getClientDecisionRoom\(/g) ?? []).length, 1);
});

// ---------------------------------------------------------------------------
// 7. The shared registration files wire the surface
// ---------------------------------------------------------------------------

test('routes.ts registers the decision-room family; the composition root builds the reporting module EXACTLY ONCE with matrix-allowed dependencies', () => {
  assert.ok(routesFile.includes("import { registerReportingDecisionRoomRoutes } from './reporting-decision-room-routes.ts'"));
  assert.ok(routesFile.includes('registerReportingDecisionRoomRoutes(router, services, modules)'));
  assert.ok(routesFile.includes('MKT-030'));
  assert.ok(compositionRoot.includes('MKT-030'));
  assert.ok(compositionRoot.includes('createReportingModule('));
  assert.equal(
    (compositionRoot.match(/createReportingModule\(/g) ?? []).length,
    1,
    'the composition root must not wire a second reporting module',
  );
  // The wired dependency set is exactly the matrix-allowed subset.
  const wiring = compositionRoot.match(
    /createReportingModule\(\{([\s\S]*?)\}\);/,
  );
  assert.ok(wiring !== null);
  const wired = [...wiring![1]!.matchAll(/\b([a-zA-Z]+),/g)].map((match) => match[1]!);
  assert.deepEqual([...wired].sort(), ['clock', 'evidence', 'experiments', 'goals', 'learnings', 'workflows']);
  // application.ts exposes the module contract to the route builders.
  assert.ok(applicationFile.includes("import type { ReportingModuleApi } from '../modules/reporting/public.ts'"));
  assert.ok(applicationFile.includes('readonly reporting: ReportingModuleApi'));
  // No db/ids are wired into the reporting module: it owns no state.
  assert.ok(!wiring![1]!.includes('db'), 'the reporting module wires no database handle (no owned state)');
  assert.ok(!wiring![1]!.includes('ids'), 'the reporting module wires no id generator (no writes)');
});

// ---------------------------------------------------------------------------
// 8. PURE LIVE AGGREGATION — migration 031 stays RESERVED and unused
// ---------------------------------------------------------------------------

test('no decision-room projection migration exists — the live aggregation owns no state', () => {
  const migrationsDir = src('platform', 'db', 'migrations');
  const migrations = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql'));
  assert.ok(migrations.length > 0, 'the migrations directory is the expected non-empty authority');
  for (const migration of migrations) {
    assert.ok(
      !migration.includes('decision_room'),
      `no decision-room projection table may exist (found '${migration}') — the decision room owns no state authority`,
    );
  }
  assert.ok(
    !existsSync(join(migrationsDir, '031_decision_room.sql')),
    'migration 031 stays RESERVED and unused: the pure live aggregation is the delivered architecture',
  );
  // The composition root documents the reservation decision.
  assert.ok(compositionRoot.includes('migration 031 stays RESERVED'));
});
