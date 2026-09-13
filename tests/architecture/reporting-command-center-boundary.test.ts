/**
 * MKT-029 static tests — the Agency Command Center boundary is structurally
 * correct in the ACTUAL route file, the /reporting module and the shared
 * registration files (pure static analysis, no DB; the MKT-030
 * reporting-decision-room-boundary.test.ts precedent, agency-scoped). Proves
 * the frozen architecture boundaries (spec/work-items.md MKT-029;
 * requirements UI-001 + UI-AC-01..02; spec/architecture.md §25 UI;
 * spec/module-dependency-matrix.md "/reporting ──→ /goals, /workflows,
 * /executions, /evidence, /experiments, /metrics, /learnings" +
 * "/reporting must never mutate authoritative domain state"):
 *
 *   1. the command center registers EXACTLY ONE surface — the GET
 *      command-center view — and NO mutating verb is registered anywhere in
 *      the route file (READ-ONLY BY CONSTRUCTION: a frontend bypass has
 *      nothing to drive; UI-AC-02);
 *   2. the route file reads NO request body and validates NO DTO — the GET
 *      surface has no DTO at all, so authority fields (agency/client/
 *      workspace identifiers, statuses, provenance) are structurally
 *      unreachable, not merely rejected;
 *   3. the route file's imports are whitelisted: platform + authorize +
 *      application + the /reporting public contract ONLY — the composed
 *      authorities (/evidence, /experiments, /executions, /learnings,
 *      /goals, /workflows, /clients, /workspaces) are reached THROUGH the
 *      ApplicationModules aggregate and the /reporting module public, never
 *      imported around them (no second composition engine at the route
 *      layer);
 *   4. thin delegation: the route file's ONLY module calls are the durable
 *      agency/membership authorization reads, the server-derived agency
 *      client/workspace enumeration and the /reporting read — no store
 *      access, no mutation, no audit emission (reads are not material
 *      mutations);
 *   5. the AGENCY tenant boundary is the UNIFORM 404: the authorization
 *      helper resolves the durable agency row first (malformed/unknown →
 *      404) and a caller with NO membership in the owning agency gets the
 *      SAME 404 (never a 403 that leaks the agency's existence) — only a
 *      suspended membership or disabled identity is a 403, and the surface
 *      is registered AFTER authentication (anonymous 401 at the
 *      authenticator, fail closed);
 *   6. NO command-center projection state exists: no migration file
 *      mentions the command center (the pure live aggregation owns no
 *      state authority; migration 032 stays RESERVED).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
const read = (path: string): string => readFileSync(path, 'utf8');

const commandCenterRoutes = read(src('api', 'reporting-command-center-routes.ts'));
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

test('the command-center routes register EXACTLY ONE surface — the GET command-center view — and no mutating verb exists in the file', () => {
  const registered = [...commandCenterRoutes.matchAll(/'(?:GET|POST|PUT|PATCH|DELETE)',\s*'(\/[^']+)'/g)]
    .map((match) => match[1]!);
  assert.deepEqual(registered, ['/api/reporting/command-center/:agencyId']);
  for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.ok(
      !commandCenterRoutes.includes(`'${verb}',`),
      `the command center must never register a ${verb} route (UI-AC-02: a frontend bypass cannot change outcomes)`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. No DTO at all — the GET surface reads no body
// ---------------------------------------------------------------------------

test('the route file reads NO request body and validates NO DTO (authority fields are structurally unreachable)', () => {
  assert.ok(!commandCenterRoutes.includes('validateObject'), 'the GET surface validates no body');
  assert.ok(!commandCenterRoutes.includes('ctx.request.body'), 'the route never touches a request body');
  assert.ok(
    !commandCenterRoutes.includes('forbiddenKeys'),
    'there is no DTO to carry authority fields — the surface accepts no input at all',
  );
  assert.ok(
    !commandCenterRoutes.includes('defineMutationRoute'),
    'the command center registers no mutation pipeline route',
  );
  // Query parameters are never read either (the scope is server-derived
  // from the authenticated identity + durable agency/membership state).
  assert.ok(
    !commandCenterRoutes.includes('ctx.request.query') && !commandCenterRoutes.includes('searchParams'),
    'the command center never reads query parameters',
  );
});

// ---------------------------------------------------------------------------
// 3. Import whitelist — the composed authorities are reached THROUGH the
//    ApplicationModules aggregate + the /reporting module public
// ---------------------------------------------------------------------------

test('the route file imports ONLY platform + authorize + application + the /reporting public contract', () => {
  const allowed = [
    /^node:/,
    /^\.\.\/platform\//,
    /^\.\.\/modules\/reporting\/public\.ts$/,
    /^\.\/authorize\.ts$/,
    /^\.\/application\.ts$/,
  ];
  for (const specifier of importsOf(src('api', 'reporting-command-center-routes.ts'))) {
    assert.ok(
      allowed.some((pattern) => pattern.test(specifier)),
      `unexpected import '${specifier}' — the command-center routes compose the /reporting module public contract only`,
    );
  }
  // Explicit negatives: the composed authorities are reached through the
  // /reporting module, never imported directly by the route family.
  for (const specifier of importsOf(src('api', 'reporting-command-center-routes.ts'))) {
    assert.ok(!specifier.includes('evidence'), 'the route family must not import /evidence directly');
    assert.ok(!specifier.includes('experiments'), 'the route family must not import /experiments directly');
    assert.ok(!specifier.includes('executions'), 'the route family must not import /executions directly');
    assert.ok(!specifier.includes('learnings'), 'the route family must not import /learnings directly');
    assert.ok(!specifier.includes('goals'), 'the route family must not import /goals directly');
    assert.ok(!specifier.includes('workflows'), 'the route family must not import /workflows directly');
    assert.ok(!specifier.includes('/clients/'), 'the route family must not import the /clients contract directly');
    assert.ok(!specifier.includes('/workspaces/'), 'the route family must not import the /workspaces contract directly');
    assert.ok(!specifier.includes('policies'), 'the route family must not import /policies (no second policy surface)');
    assert.ok(!specifier.includes('audit'), 'the route family must not import /audit (reads emit no audit events)');
  }
});

// ---------------------------------------------------------------------------
// 4. Thin delegation — durable authorization + scope enumeration + the read
// ---------------------------------------------------------------------------

test('the route file performs ONLY the durable authorization reads + the server-derived agency enumeration + the /reporting read', () => {
  const allowedModuleCalls = [
    'modules.agencies.getAgency',
    'modules.clients.listClientsForAgency',
    'modules.workspaces.listWorkspacesForClient',
    'modules.reporting.getAgencyCommandCenter',
  ];
  for (const match of commandCenterRoutes.matchAll(/modules\.[a-zA-Z]+\.[A-Za-z]+/g)) {
    assert.ok(
      allowedModuleCalls.includes(match[0]),
      `unexpected module call '${match[0]}' — the command center is a thin delegation surface`,
    );
  }
  // The shared authorization posture (never a second permission engine):
  // the route authorizes through the durable-membership authority
  // (resolveContext) and its own uniform-404 agency check.
  assert.ok(commandCenterRoutes.includes('resolveContext'));
  assert.ok(commandCenterRoutes.includes('requireCommandCenterAgency'));
  // Reads emit no audit events (nothing material happened).
  assert.ok(!commandCenterRoutes.includes('recordMutationAudit'));
  assert.ok(!commandCenterRoutes.includes('audit-emit'));
});

// ---------------------------------------------------------------------------
// 5. The agency tenant boundary — uniform 404 for foreign agencies
// ---------------------------------------------------------------------------

test('the agency tenant boundary is the UNIFORM 404: cross-agency identifiers never leak existence (404, not 403)', () => {
  // Malformed → 404; unknown agency → 404; foreign caller (NO membership in
  // the owning agency) → the SAME 404; suspended membership → 403; the
  // authenticator runs BEFORE authorization (anonymous is 401, fail closed).
  assert.ok(
    commandCenterRoutes.includes("if (!UUID_PATTERN.test(agencyId))"),
    'a malformed agency identifier is rejected as the uniform 404',
  );
  assert.ok(
    /agency === null[\s\S]{0,120}NotFoundError\('agency'/.test(commandCenterRoutes),
    'an unknown agency is the uniform 404',
  );
  const foreignBranch = commandCenterRoutes.match(
    /if \(membership === undefined\) \{\n\s*\/\/ Hard boundary[\s\S]{0,220}?NotFoundError\('agency', agencyId\);\n\s*\}/,
  );
  assert.ok(
    foreignBranch !== null,
    'a caller with NO membership in the owning agency gets the SAME 404 as an unknown agency (cross-agency data must 404, never 403-leak existence)',
  );
  assert.ok(
    /membership\.membershipStatus !== 'active'[\s\S]{0,120}ForbiddenError/.test(commandCenterRoutes),
    'only a suspended membership is a 403 (intra-tenant, post-existence)',
  );
  assert.ok(
    /membership\.membershipStatus !== 'active'/.test(commandCenterRoutes) &&
      !/membership\.membershipStatus !== 'active'[\s\S]{0,80}NotFoundError/.test(commandCenterRoutes),
    'the suspended-membership failure is NOT a 404 (it is the intra-tenant 403 posture)',
  );
});

// ---------------------------------------------------------------------------
// 6. PURE LIVE AGGREGATION — the command center owns no state
// ---------------------------------------------------------------------------

test('no command-center projection migration exists — the live aggregation owns no state', () => {
  const migrationsDir = src('platform', 'db', 'migrations');
  const migrations = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql'));
  assert.ok(migrations.length > 0, 'the migrations directory is the expected non-empty authority');
  for (const migration of migrations) {
    assert.ok(
      !migration.includes('command_center') && !migration.includes('command-center'),
      `no command-center projection table may exist (found '${migration}') — the command center owns no state authority`,
    );
  }
  // The composition root still documents migration 032 as RESERVED (the
  // reporting module owns NO state of any kind).
  assert.ok(compositionRoot.includes('migration 032 stays RESERVED'));
});

// ---------------------------------------------------------------------------
// 7. The shared registration files wire the surface
// ---------------------------------------------------------------------------

test('routes.ts registers the command-center family ONCE; application.ts exposes the SAME module contract (one authority, two route families)', () => {
  assert.ok(routesFile.includes("import { registerReportingCommandCenterRoutes } from './reporting-command-center-routes.ts'"));
  assert.equal(
    (routesFile.match(/registerReportingCommandCenterRoutes\(router, services, modules\)/g) ?? []).length,
    1,
    'the command-center family is registered exactly once',
  );
  assert.ok(routesFile.includes('MKT-029'));
  assert.ok(compositionRoot.includes('MKT-029'));
  // No SECOND reporting module is wired (the family registers against the
  // SAME composition-root-built module — the jobs-visits precedent).
  assert.equal(
    (compositionRoot.match(/createReportingModule\(/g) ?? []).length,
    1,
    'the composition root must not wire a second reporting module',
  );
  assert.ok(applicationFile.includes('readonly reporting: ReportingModuleApi'));
});
