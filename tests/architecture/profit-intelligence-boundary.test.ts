/**
 * MKT-043 static tests — the Profit Intelligence boundary is structurally
 * correct in the ACTUAL route file, the /profit-intelligence module, the
 * shared registration files and the additive spec entries (pure static
 * analysis, no DB; the MKT-041 operating-graph-boundary precedent). Proves
 * the frozen architecture boundaries (spec/architecture-v1.5.md §5;
 * spec/operating-graph-v1.5.md "Profit Intelligence"; architecture-lock
 * v1.5 #6: "Profit Intelligence is derived analytics and cannot become a
 * financial system of record"; spec/module-dependency-matrix.md
 * "/profit-intelligence ──→ /clients, /workspaces, /goals, /playbooks,
 * /workflows, /executions, /deployments, /evidence, /metrics, /jobs,
 * /field-agents, /ai-runtime, /integrations" + the derived-read-model
 * forbidden-direction bullet):
 *
 *   1. the surface registers EXACTLY THREE routes and all are GETs — NO
 *      mutating verb exists anywhere in the route file (READ-ONLY BY
 *      CONSTRUCTION: there is no write path a frontend bypass could
 *      drive — the module can never mutate a financial authority);
 *   2. the route file reads NO request body, validates NO DTO and reads
 *      NO query parameter — the GET surface has no DTO at all, so
 *      authority fields (identifiers, statuses, provenance, assumptions,
 *      calculation version) are structurally unreachable, not merely
 *      rejected;
 *   3. the route file's imports are whitelisted: platform + authorize +
 *      application + the /profit-intelligence public contract ONLY;
 *   4. thin delegation: the route file's ONLY module calls are the
 *      durable agency/membership authorization reads, the server-derived
 *      scope enumeration and the three /profit-intelligence reads;
 *   5. the AGENCY tenant boundary is the UNIFORM 404 (malformed/unknown/
 *      foreign agency → 404; foreign client/workspace → the same 404;
 *      suspended membership → 403; anonymous → 401 via the
 *      authenticator, fail closed);
 *   6. NO OWNED STATE (the disclosed AC-4 choice): the module owns NO
 *      migration (no profit_intelligence_*.sql file exists) — live
 *      derivation over the canonical authorities, the /reporting
 *      precedent;
 *   7. ZERO MUTATION METHODS AND ZERO SQL: the module contract exposes
 *      exactly three READ methods; the module's internal files contain
 *      NO SQL at all (no INSERT/UPDATE/DELETE/FROM — the authorities are
 *      reached through their public contracts only);
 *   8. the frozen calculation vocabulary is exported (the version, the
 *      two-value provenance set, the revenue metric-name set and the
 *      full assumption record);
 *   9. the shared registration files wire the surface ONCE (one module
 *      in the composition root, one registration in routes.ts, one
 *      ApplicationModules member) and the additive spec entries exist
 *      (architecture.md §6 module list + the dependency-matrix line);
 *  10. the module structure follows the reporting precedent (public.ts +
 *      internal/ only).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
const spec = (...parts: string[]) => join(repoRoot, 'spec', ...parts);
const read = (path: string): string => readFileSync(path, 'utf8');

const profitRoutes = read(src('api', 'profit-intelligence-routes.ts'));
const routesFile = read(src('api', 'routes.ts'));
const compositionRoot = read(src('composition-root.ts'));
const applicationFile = read(src('api', 'application.ts'));
const publicEntry = read(src('modules', 'profit-intelligence', 'public.ts'));
const moduleFile = read(src('modules', 'profit-intelligence', 'internal', 'profit-intelligence-module.ts'));
const derivationFile = read(src('modules', 'profit-intelligence', 'internal', 'profit-derivation.ts'));

/** Imports of a file as raw specifier strings. */
function importsOf(file: string): string[] {
  const text = read(file);
  const specifiers: string[] = [];
  for (const match of text.matchAll(/from\s+'([^']+)'/g)) specifiers.push(match[1]!);
  for (const match of text.matchAll(/import\s+'([^']+)'/g)) specifiers.push(match[1]!);
  return specifiers;
}

// ---------------------------------------------------------------------------
// 1. Exactly three surfaces — all GETs (read-only by construction)
// ---------------------------------------------------------------------------

test('the profit-intelligence routes register EXACTLY THREE surfaces — all GETs — and no mutating verb exists in the file', () => {
  const registered = [...profitRoutes.matchAll(/'(?:GET|POST|PUT|PATCH|DELETE)',\s*'(\/[^']+)'/g)]
    .map((match) => match[1]!);
  assert.deepEqual(registered, [
    '/api/profit-intelligence/:agencyId',
    '/api/profit-intelligence/:agencyId/clients/:clientId',
    '/api/profit-intelligence/:agencyId/clients/:clientId/workspaces/:workspaceId',
  ]);
  for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.ok(
      !profitRoutes.includes(`'${verb}',`),
      `profit intelligence must never register a ${verb} route (a frontend bypass cannot change any authority)`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. No DTO at all — the GET surfaces read no body and no query
// ---------------------------------------------------------------------------

test('the route file reads NO request body, validates NO DTO and reads no query parameters', () => {
  assert.ok(!profitRoutes.includes('validateObject'), 'the GET surfaces validate no body');
  assert.ok(!profitRoutes.includes('ctx.request.body'), 'the routes never touch a request body');
  assert.ok(
    !profitRoutes.includes('forbiddenKeys'),
    'there is no DTO to carry authority fields — the surfaces accept no input at all',
  );
  assert.ok(
    !profitRoutes.includes('defineMutationRoute'),
    'profit intelligence registers no mutation pipeline route',
  );
  assert.ok(
    !profitRoutes.includes('ctx.request.query') && !profitRoutes.includes('searchParams'),
    'profit intelligence never reads query parameters (scope is server-derived)',
  );
});

// ---------------------------------------------------------------------------
// 3. Import whitelist — the composed authorities are reached THROUGH the
//    ApplicationModules aggregate + the /profit-intelligence public contract
// ---------------------------------------------------------------------------

test('the route file imports ONLY platform + authorize + application + the /profit-intelligence public contract', () => {
  const allowed = [
    /^node:/,
    /^\.\.\/platform\//,
    /^\.\.\/modules\/profit-intelligence\/public\.ts$/,
    /^\.\/authorize\.ts$/,
    /^\.\/application\.ts$/,
  ];
  for (const specifier of importsOf(src('api', 'profit-intelligence-routes.ts'))) {
    assert.ok(
      allowed.some((pattern) => pattern.test(specifier)),
      `unexpected import '${specifier}' — the profit-intelligence routes compose the module public contract only`,
    );
  }
  for (const specifier of importsOf(src('api', 'profit-intelligence-routes.ts'))) {
    assert.ok(!specifier.includes('evidence'), 'the route family must not import /evidence directly');
    assert.ok(!specifier.includes('metrics'), 'the route family must not import /metrics directly');
    assert.ok(!specifier.includes('executions'), 'the route family must not import /executions directly');
    assert.ok(!specifier.includes('goals'), 'the route family must not import /goals directly');
    assert.ok(!specifier.includes('workflows'), 'the route family must not import /workflows directly');
    assert.ok(!specifier.includes('playbooks'), 'the route family must not import /playbooks directly');
    assert.ok(!specifier.includes('deployments'), 'the route family must not import /deployments directly');
    assert.ok(!specifier.includes('/jobs/'), 'the route family must not import the /jobs contract directly');
    assert.ok(!specifier.includes('field-agents'), 'the route family must not import /field-agents directly');
    assert.ok(!specifier.includes('ai-runtime'), 'the route family must not import /ai-runtime directly');
    assert.ok(!specifier.includes('integrations'), 'the route family must not import /integrations directly');
    assert.ok(!specifier.includes('/clients/'), 'the route family must not import the /clients contract directly');
    assert.ok(!specifier.includes('/workspaces/'), 'the route family must not import the /workspaces contract directly');
    assert.ok(!specifier.includes('policies'), 'the route family must not import /policies (no second policy surface)');
    assert.ok(!specifier.includes('audit'), 'the route family must not import /audit (reads emit no audit events)');
  }
});

// ---------------------------------------------------------------------------
// 4. Thin delegation — durable authorization + scope enumeration + the reads
// ---------------------------------------------------------------------------

test('the route file performs ONLY the durable authorization reads + the server-derived scope enumeration + the three reads', () => {
  const allowedModuleCalls = [
    'modules.agencies.getAgency',
    'modules.agencies.listMemberships',
    'modules.clients.listClientsForAgency',
    'modules.workspaces.listWorkspacesForClient',
    'modules.profitIntelligence.getAgencyProfitIntelligence',
    'modules.profitIntelligence.getClientProfitIntelligence',
    'modules.profitIntelligence.getWorkspaceProfitIntelligence',
  ];
  for (const match of profitRoutes.matchAll(/modules\.[a-zA-Z]+\.[A-Za-z]+/g)) {
    assert.ok(
      allowedModuleCalls.includes(match[0]),
      `unexpected module call '${match[0]}' — the profit-intelligence surface is a thin delegation layer`,
    );
  }
  assert.ok(profitRoutes.includes('resolveContext'));
  assert.ok(profitRoutes.includes('requireProfitIntelligenceAgency'));
  // Reads emit no audit events (nothing material happened).
  assert.ok(!profitRoutes.includes('recordMutationAudit'));
  assert.ok(!profitRoutes.includes('audit-emit'));
});

// ---------------------------------------------------------------------------
// 5. The agency tenant boundary — uniform 404 for foreign identifiers
// ---------------------------------------------------------------------------

test('the agency tenant boundary is the UNIFORM 404: cross-tenant identifiers never leak existence (404, not 403)', () => {
  assert.ok(
    profitRoutes.includes("if (!UUID_PATTERN.test(agencyId))"),
    'a malformed agency identifier is rejected as the uniform 404',
  );
  assert.ok(
    /agency === null[\s\S]{0,120}NotFoundError\('agency'/.test(profitRoutes),
    'an unknown agency is the uniform 404',
  );
  const foreignBranch = profitRoutes.match(
    /if \(membership === undefined\) \{\n\s*\/\/ Hard boundary[\s\S]{0,220}?NotFoundError\('agency', agencyId\);\n\s*\}/,
  );
  assert.ok(
    foreignBranch !== null,
    'a caller with NO membership in the owning agency gets the SAME 404 as an unknown agency (cross-agency data must 404, never 403-leak existence)',
  );
  assert.ok(
    /membership\.membershipStatus !== 'active'[\s\S]{0,120}ForbiddenError/.test(profitRoutes),
    'only a suspended membership is a 403 (intra-tenant, post-existence)',
  );
  // The client + workspace detail selectors: a foreign or malformed
  // identifier is the same uniform 404 (validated against the OWNING
  // agency's live clients / the owning client's live workspaces).
  assert.ok(
    profitRoutes.includes("if (!UUID_PATTERN.test(clientId))"),
    'a malformed client identifier is rejected as the uniform 404',
  );
  const foreignClientBranch = profitRoutes.match(
    /if \(match === undefined\) \{\n\s*\/\/ Hard boundary[\s\S]{0,240}?NotFoundError\('client', clientId\);\n\s*\}/,
  );
  assert.ok(
    foreignClientBranch !== null,
    'a Client of another agency gets the SAME 404 as an unknown client (no cross-agency existence oracle)',
  );
  assert.ok(
    profitRoutes.includes("if (!UUID_PATTERN.test(workspaceId))"),
    'a malformed workspace identifier is rejected as the uniform 404',
  );
  const foreignWorkspaceBranch = profitRoutes.match(
    /if \(match === undefined\) \{\n\s*\/\/ Hard boundary[\s\S]{0,240}?NotFoundError\('workspace', workspaceId\);\n\s*\}/,
  );
  assert.ok(
    foreignWorkspaceBranch !== null,
    'a Workspace of another client gets the SAME 404 as an unknown workspace',
  );
});

// ---------------------------------------------------------------------------
// 6. NO OWNED STATE — the disclosed no-migration choice (AC-4)
// ---------------------------------------------------------------------------

test('the module owns NO migration — live derivation over the canonical authorities (the disclosed AC-4 choice)', () => {
  const migrations = readdirSync(src('platform', 'db', 'migrations')).filter((name) =>
    name.endsWith('.sql'),
  );
  for (const name of migrations) {
    assert.ok(
      !name.includes('profit'),
      `no profit-intelligence-owned migration may exist (found '${name}') — the delivery is a live derivation, the /reporting precedent`,
    );
  }
  // And the composition root wires the module with NO db/ids — only the
  // clock + the composed public-contract instances.
  const wiring = compositionRoot.match(/createProfitIntelligenceModule\(\{[\s\S]*?\}\);/);
  assert.ok(wiring !== null, 'the composition root constructs the profit-intelligence module');
  assert.ok(!wiring[0]!.includes('db,'), 'the module receives NO database handle (no owned state)');
  assert.ok(!wiring[0]!.includes('ids,'), 'the module receives NO id generator (nothing to mint)');
  assert.ok(wiring[0]!.includes('clock,'), 'the module receives the clock (the generatedAt stamp)');
});

// ---------------------------------------------------------------------------
// 7. ZERO MUTATION METHODS + ZERO SQL (architecture-lock v1.5 #6)
// ---------------------------------------------------------------------------

test('the module contract exposes EXACTLY THREE methods — all READS; no mutation verb exists anywhere in the public entry', () => {
  const apiBlock = publicEntry.match(
    /export interface ProfitIntelligenceModuleApi \{([\s\S]*?)\n\}/,
  );
  assert.ok(apiBlock !== null, 'the module API interface is declared');
  const methods = [...apiBlock[1]!.matchAll(/^\s{2}(get|create|insert|update|delete|append|record|submit|transition|rebuild|recompute|set|add|remove|put|patch|post|write|mint|register|declare|supersede|cancel|decline|accept|publish|activate|pause|resume|close|open)[A-Za-z]*\(/gm)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(methods, ['get', 'get', 'get'], 'exactly the three read methods');
  for (const mutationVerb of [
    'create', 'insert', 'update', 'delete', 'append', 'record', 'submit',
    'transition', 'rebuild', 'recompute',
  ]) {
    assert.ok(
      !new RegExp(`^\\s{2}${mutationVerb}[A-Za-z]*\\(`, 'm').test(apiBlock[1]!),
      `a '${mutationVerb}*' method must never exist on the profit-intelligence contract`,
    );
  }
});

test('the module internals contain ZERO SQL — the authorities compose through their public contracts only', () => {
  for (const file of [moduleFile, derivationFile]) {
    for (const pattern of [
      /\bINSERT\s+INTO\b/i,
      /\bUPDATE\s+[a-z_]+\s+SET\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bSELECT\b[\s\S]{0,80}\bFROM\b/i,
      /\bTRUNCATE\b/i,
      /\bALTER\s+TABLE\b/i,
      /\bCREATE\s+TABLE\b/i,
    ]) {
      assert.ok(
        !pattern.test(file),
        'profit intelligence performs no SQL of any kind (pure derivation over the composed public contracts)',
      );
    }
    assert.ok(!file.includes('db.query'), 'no database handle is ever touched');
    assert.ok(!file.includes('deps.db'), 'no database dependency is ever declared');
  }
});

// ---------------------------------------------------------------------------
// 8. The frozen calculation vocabulary is exported (AC-2)
// ---------------------------------------------------------------------------

test('the frozen calculation vocabulary is exported (version, provenance set, revenue names, assumption set)', () => {
  assert.ok(
    publicEntry.includes('export const PROFIT_INTELLIGENCE_CALCULATION_VERSION'),
    'the calculation version is an exported frozen constant',
  );
  assert.ok(
    publicEntry.includes("export const PROFIT_FIGURE_PROVENANCES = ['observed', 'estimated'] as const"),
    'the two-value provenance vocabulary is exported',
  );
  assert.ok(
    publicEntry.includes('export const PROFIT_INTELLIGENCE_REVENUE_METRIC_NAMES'),
    'the revenue metric-name vocabulary is exported',
  );
  assert.ok(
    publicEntry.includes('export const PROFIT_INTELLIGENCE_ASSUMPTIONS'),
    'the full assumption set is exported (no hidden constants)',
  );
  assert.ok(
    publicEntry.includes("persistence: 'none-derived-read-model'") ||
      derivationFile.includes("persistence: 'none-derived-read-model'"),
    'the calculation disclosure declares the no-persistence basis',
  );
});

// ---------------------------------------------------------------------------
// 9. The shared registration files wire the surface; the additive spec
//    entries exist
// ---------------------------------------------------------------------------

test('routes.ts registers the profit-intelligence family ONCE; application.ts exposes the SAME module contract', () => {
  assert.ok(
    routesFile.includes("import { registerProfitIntelligenceRoutes } from './profit-intelligence-routes.ts'"),
  );
  assert.equal(
    (routesFile.match(/registerProfitIntelligenceRoutes\(router, services, modules\)/g) ?? []).length,
    1,
    'the profit-intelligence family is registered exactly once',
  );
  assert.ok(routesFile.includes('MKT-043'));
  assert.ok(compositionRoot.includes('MKT-043'));
  assert.equal(
    (compositionRoot.match(/createProfitIntelligenceModule\(/g) ?? []).length,
    1,
    'the composition root must not wire a second profit-intelligence module',
  );
  assert.ok(applicationFile.includes('readonly profitIntelligence: ProfitIntelligenceModuleApi'));
});

test('the additive spec entries exist (architecture.md §6 + the dependency-matrix line + the forbidden-direction bullet)', () => {
  const architecture = read(spec('architecture.md'));
  assert.ok(
    /^\/profit-intelligence$/m.test(architecture),
    'the frozen module set includes /profit-intelligence (required by the static checker)',
  );
  const matrix = read(spec('module-dependency-matrix.md'));
  assert.ok(
    matrix.includes(
      '/profit-intelligence ──→ /clients, /workspaces, /goals, /playbooks, /workflows, /executions, /deployments, /evidence, /metrics, /jobs, /field-agents, /ai-runtime, /integrations',
    ),
    'the dependency matrix carries the additive /profit-intelligence line',
  );
  assert.ok(
    matrix.includes('/profit-intelligence` is the v1.5 derived Profit Intelligence read model'),
    'the forbidden-direction bullet for /profit-intelligence exists',
  );
});

// ---------------------------------------------------------------------------
// 10. The module structure follows the reporting precedent
// ---------------------------------------------------------------------------

test('the module structure follows the reporting precedent (public.ts + internal/ only)', () => {
  const moduleDir = src('modules', 'profit-intelligence');
  const entries = readdirSync(moduleDir, { withFileTypes: true })
    .filter((entry) => entry.name !== 'internal')
    .map((entry) => entry.name);
  assert.deepEqual(entries, ['public.ts'], 'exactly public.ts + internal/');
  const internal = readdirSync(join(moduleDir, 'internal')).sort();
  assert.deepEqual(internal, [
    'profit-derivation.ts',
    'profit-intelligence-module.ts',
  ]);
});

// ---------------------------------------------------------------------------
// 11. The /integrations composition posture (the matrix line's READ-ONLY
//     consumption — no second integration boundary). The MKT-023 INT-001
//     string-level trip-wire forbids the canonical /integrations record
//     type-name strings outside /integrations, so the derivation derives
//     its snapshot row types from the PUBLIC CONTRACT's own listing-method
//     return types instead — the exact canonical record types, never a
//     re-declared or shadowed shape. This test PROVES that posture.
// ---------------------------------------------------------------------------

test('the /integrations consumption is READ-ONLY public-contract composition — no second integration boundary is declared', () => {
  for (const file of [publicEntry, moduleFile, derivationFile]) {
    // The composed authority is reached through the PUBLIC entry only —
    // never an internal/ import.
    for (const specifier of importsOf(
      file === publicEntry
        ? src('modules', 'profit-intelligence', 'public.ts')
        : file === moduleFile
          ? src('modules', 'profit-intelligence', 'internal', 'profit-intelligence-module.ts')
          : src('modules', 'profit-intelligence', 'internal', 'profit-derivation.ts'),
    )) {
      if (specifier.includes('integrations')) {
        assert.ok(
          /(\.\.\/)+integrations\/public\.ts$/.test(specifier),
          `the /integrations contract is composed through its public entry only (found '${specifier}')`,
        );
      }
    }
    // No adapter/connection/webhook surface of its own is declared (the
    // INT-001 no-second-boundary rule): the module declares no integration
    // adapter interface, no adapter call context and no connection-record
    // interface — the canonical record types are DERIVED from the public
    // contract's method return types (type identity preserved).
    assert.ok(
      !file.includes('interface IntegrationAdapter'),
      'profit intelligence declares no integration adapter port (INT-001)',
    );
    assert.ok(
      !file.includes('IntegrationAdapterCallContext'),
      'profit intelligence declares no adapter call context (INT-001)',
    );
    assert.ok(
      !file.includes('IntegrationConnectionRecord'),
      'the canonical connection-record type is never NAMED outside /integrations (the INT-001 string rule); the derivation uses the public contract\'s own return types',
    );
    assert.ok(
      !file.includes('IntegrationIngestedEventRecord'),
      'the canonical ingested-event type is never NAMED outside /integrations (the INT-001 string rule); the derivation uses the public contract\'s own return types',
    );
    assert.ok(
      !/\binterface\s+Integration\w*(Adapter|Connection|Webhook|Ingest)\w*/.test(file),
      'no integration adapter/connection/webhook interface of its own is declared (no second boundary — the AdapterActivityRow view-model is the derived analytics row, not an integration port)',
    );
  }
  // And the exact-type derivation is the disclosed mechanism: the snapshot
  // row types are Awaited<ReturnType<...>> of the public listing methods.
  assert.ok(
    derivationFile.includes("ReturnType<IntegrationsModuleApi['listConnectionsForClient']>"),
    'the connection snapshot row type IS the public contract\'s listing return type (exact canonical shape)',
  );
  assert.ok(
    derivationFile.includes("ReturnType<IntegrationsModuleApi['listIngestedEventsForClient']>"),
    'the ingested-event snapshot row type IS the public contract\'s listing return type (exact canonical shape)',
  );
});
