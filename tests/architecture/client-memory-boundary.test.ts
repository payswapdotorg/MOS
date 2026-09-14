/**
 * MKT-044 static tests — the Client Operating Memory boundary is
 * structurally correct in the ACTUAL route file, the /client-memory
 * module, the shared registration files and the additive spec entries
 * (pure static analysis, no DB; the MKT-043 profit-intelligence-boundary
 * precedent mirrored). Proves the frozen architecture boundaries
 * (spec/architecture-v1.5.md §6: "Client memory is a governed projection
 * over canonical client, goal, playbook, deployment, evidence,
 * experiment, outcome, decision and learning records. Retrieval/index
 * technology is non-authoritative."; spec/module-dependency-matrix.md
 * "/client-memory ──→ /clients, /workspaces, /goals, /playbooks,
 * /deployments, /evidence, /experiments, /decisions, /learnings" + the
 * derived-read-model forbidden-direction bullet):
 *
 *   1. the surface registers EXACTLY THREE routes and all are GETs — NO
 *      mutating verb exists anywhere in the route file (READ-ONLY BY
 *      CONSTRUCTION: there is no write path a frontend bypass could
 *      drive — never a second tenant/data authority);
 *   2. the route file reads NO request body, validates NO DTO and reads
 *      NO query parameter — the GET surface has no DTO at all, so
 *      authority fields (identifiers, statuses, provenance, projection
 *      version) are structurally unreachable, not merely rejected;
 *   3. the route file's imports are whitelisted: platform + authorize +
 *      application + the /client-memory public contract ONLY;
 *   4. thin delegation: the route file's ONLY module calls are the
 *      durable agency/membership authorization reads, the live-scope
 *      selector validations and the three /client-memory reads;
 *   5. the AGENCY tenant boundary is the UNIFORM 404 (malformed/unknown/
 *      foreign agency → 404; foreign client/workspace → the same 404;
 *      an unknown record-kind selector → the same 404; suspended
 *      membership → 403; anonymous → 401 via the authenticator, fail
 *      closed);
 *   6. NO OWNED STATE (the disclosed no-migration choice): the module
 *      owns NO migration (no client_memory_*.sql file exists) — live
 *      derivation over the canonical authorities, the /reporting +
 *      /profit-intelligence precedent; NO retrieval index or cache
 *      exists at all (§6: retrieval/index technology is
 *      non-authoritative);
 *   7. ZERO MUTATION METHODS AND ZERO SQL: the module contract exposes
 *      exactly three READ methods; the module's internal files contain
 *      NO SQL at all (no INSERT/UPDATE/DELETE/FROM — the authorities are
 *      reached through their public contracts only);
 *   8. the frozen projection vocabulary is exported (the version, the
 *      closed record-kind set, the authority map and the full selection
 *      rule record — the cm-proj-v1 pattern);
 *   9. the shared registration files wire the surface ONCE (one module
 *      in the composition root, one registration in routes.ts, one
 *      ApplicationModules member) and the additive spec entries exist
 *      (architecture.md §6 module list + the dependency-matrix line +
 *      the forbidden-direction bullet);
 *  10. the module structure follows the reporting/profit-intelligence
 *      precedent (public.ts + internal/ only);
 *  11. the composed-authority consumption posture: every composed
 *      authority (clients, workspaces, goals, playbooks, deployments,
 *      evidence, experiments, decisions, learnings) is reached through
 *      its PUBLIC entry only — never an internal/ import — and the
 *      module declares no mutation surface over any of them (no second
 *      tenant/data authority).
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

const memoryRoutes = read(src('api', 'client-memory-routes.ts'));
const routesFile = read(src('api', 'routes.ts'));
const compositionRoot = read(src('composition-root.ts'));
const applicationFile = read(src('api', 'application.ts'));
const publicEntry = read(src('modules', 'client-memory', 'public.ts'));
const moduleFile = read(src('modules', 'client-memory', 'internal', 'client-memory-module.ts'));
const projectionFile = read(src('modules', 'client-memory', 'internal', 'memory-projection.ts'));

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

test('the client-memory routes register EXACTLY THREE surfaces — all GETs — and no mutating verb exists in the file', () => {
  const registered = [...memoryRoutes.matchAll(/'(?:GET|POST|PUT|PATCH|DELETE)',\s*'(\/[^']+)'/g)]
    .map((match) => match[1]!);
  assert.deepEqual(registered, [
    '/api/client-memory/:agencyId/clients/:clientId',
    '/api/client-memory/:agencyId/clients/:clientId/workspaces/:workspaceId',
    '/api/client-memory/:agencyId/clients/:clientId/records/:kind',
  ]);
  for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.ok(
      !memoryRoutes.includes(`'${verb}',`),
      `client memory must never register a ${verb} route (a frontend bypass cannot change any authority)`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. No DTO at all — the GET surfaces read no body and no query
// ---------------------------------------------------------------------------

test('the route file reads NO request body, validates NO DTO and reads no query parameters', () => {
  assert.ok(!memoryRoutes.includes('validateObject'), 'the GET surfaces validate no body');
  assert.ok(!memoryRoutes.includes('ctx.request.body'), 'the routes never touch a request body');
  assert.ok(
    !memoryRoutes.includes('forbiddenKeys'),
    'there is no DTO to carry authority fields — the surfaces accept no input at all (path selectors only)',
  );
  assert.ok(
    !memoryRoutes.includes('defineMutationRoute'),
    'client memory registers no mutation pipeline route',
  );
  assert.ok(
    !memoryRoutes.includes('ctx.request.query') && !memoryRoutes.includes('searchParams'),
    'client memory never reads query parameters (scope is server-derived; the kind filter is a frozen-vocabulary path selector)',
  );
});

// ---------------------------------------------------------------------------
// 3. Import whitelist — the composed authorities are reached THROUGH the
//    ApplicationModules aggregate + the /client-memory public contract
// ---------------------------------------------------------------------------

test('the route file imports ONLY platform + authorize + application + the /client-memory public contract', () => {
  const allowed = [
    /^node:/,
    /^\.\.\/platform\//,
    /^\.\.\/modules\/client-memory\/public\.ts$/,
    /^\.\/authorize\.ts$/,
    /^\.\/application\.ts$/,
  ];
  for (const specifier of importsOf(src('api', 'client-memory-routes.ts'))) {
    assert.ok(
      allowed.some((pattern) => pattern.test(specifier)),
      `unexpected import '${specifier}' — the client-memory routes compose the module public contract only`,
    );
  }
  for (const specifier of importsOf(src('api', 'client-memory-routes.ts'))) {
    assert.ok(!specifier.includes('evidence'), 'the route family must not import /evidence directly');
    assert.ok(!specifier.includes('experiments'), 'the route family must not import /experiments directly');
    assert.ok(!specifier.includes('learnings'), 'the route family must not import /learnings directly');
    assert.ok(!specifier.includes('decisions'), 'the route family must not import /decisions directly');
    assert.ok(!specifier.includes('goals'), 'the route family must not import /goals directly');
    assert.ok(!specifier.includes('playbooks'), 'the route family must not import /playbooks directly');
    assert.ok(!specifier.includes('deployments'), 'the route family must not import /deployments directly');
    assert.ok(!specifier.includes('/clients/'), 'the route family must not import the /clients contract directly');
    assert.ok(!specifier.includes('/workspaces/'), 'the route family must not import the /workspaces contract directly');
    assert.ok(!specifier.includes('workflows'), 'the route family must not import /workflows directly');
    assert.ok(!specifier.includes('executions'), 'the route family must not import /executions directly');
    assert.ok(!specifier.includes('metrics'), 'the route family must not import /metrics directly');
    assert.ok(!specifier.includes('/jobs/'), 'the route family must not import the /jobs contract directly');
    assert.ok(!specifier.includes('field-agents'), 'the route family must not import /field-agents directly');
    assert.ok(!specifier.includes('ai-runtime'), 'the route family must not import /ai-runtime directly');
    assert.ok(!specifier.includes('integrations'), 'the route family must not import /integrations directly');
    assert.ok(!specifier.includes('policies'), 'the route family must not import /policies (no second policy surface)');
    assert.ok(!specifier.includes('audit'), 'the route family must not import /audit (reads emit no audit events)');
  }
});

// ---------------------------------------------------------------------------
// 4. Thin delegation — durable authorization + scope validation + the reads
// ---------------------------------------------------------------------------

test('the route file performs ONLY the durable authorization reads + the live-scope selector validations + the three reads', () => {
  const allowedModuleCalls = [
    'modules.agencies.getAgency',
    'modules.clients.listClientsForAgency',
    'modules.workspaces.listWorkspacesForClient',
    'modules.clientMemory.getClientMemory',
    'modules.clientMemory.getWorkspaceMemory',
    'modules.clientMemory.getClientMemoryByKind',
  ];
  for (const match of memoryRoutes.matchAll(/modules\.[a-zA-Z]+\.[A-Za-z]+/g)) {
    assert.ok(
      allowedModuleCalls.includes(match[0]),
      `unexpected module call '${match[0]}' — the client-memory surface is a thin delegation layer`,
    );
  }
  assert.ok(memoryRoutes.includes('resolveContext'));
  assert.ok(memoryRoutes.includes('requireClientMemoryAgency'));
  // Reads emit no audit events (nothing material happened).
  assert.ok(!memoryRoutes.includes('recordMutationAudit'));
  assert.ok(!memoryRoutes.includes('audit-emit'));
});

// ---------------------------------------------------------------------------
// 5. The agency tenant boundary — uniform 404 for foreign identifiers
// ---------------------------------------------------------------------------

test('the agency tenant boundary is the UNIFORM 404: cross-tenant identifiers never leak existence (404, not 403)', () => {
  assert.ok(
    memoryRoutes.includes("if (!UUID_PATTERN.test(agencyId))"),
    'a malformed agency identifier is rejected as the uniform 404',
  );
  assert.ok(
    /agency === null[\s\S]{0,120}NotFoundError\('agency'/.test(memoryRoutes),
    'an unknown agency is the uniform 404',
  );
  const foreignBranch = memoryRoutes.match(
    /if \(membership === undefined\) \{\n\s*\/\/ Hard boundary[\s\S]{0,220}?NotFoundError\('agency', agencyId\);\n\s*\}/,
  );
  assert.ok(
    foreignBranch !== null,
    'a caller with NO membership in the owning agency gets the SAME 404 as an unknown agency (cross-agency data must 404, never 403-leak existence)',
  );
  assert.ok(
    /membership\.membershipStatus !== 'active'[\s\S]{0,120}ForbiddenError/.test(memoryRoutes),
    'only a suspended membership is a 403 (intra-tenant, post-existence)',
  );
  // The client + workspace detail selectors: a foreign or malformed
  // identifier is the same uniform 404 (validated against the OWNING
  // agency's live clients / the owning client's live workspaces).
  assert.ok(
    memoryRoutes.includes("if (!UUID_PATTERN.test(clientId))"),
    'a malformed client identifier is rejected as the uniform 404',
  );
  const foreignClientBranch = memoryRoutes.match(
    /if \(match === undefined\) \{\n\s*\/\/ Hard boundary[\s\S]{0,240}?NotFoundError\('client', clientId\);\n\s*\}/,
  );
  assert.ok(
    foreignClientBranch !== null,
    'a Client of another agency gets the SAME 404 as an unknown client (no cross-agency existence oracle)',
  );
  assert.ok(
    memoryRoutes.includes("if (!UUID_PATTERN.test(workspaceId))"),
    'a malformed workspace identifier is rejected as the uniform 404',
  );
  const foreignWorkspaceBranch = memoryRoutes.match(
    /if \(match === undefined\) \{\n\s*\/\/ Hard boundary[\s\S]{0,240}?NotFoundError\('workspace', workspaceId\);\n\s*\}/,
  );
  assert.ok(
    foreignWorkspaceBranch !== null,
    'a Workspace of another client gets the SAME 404 as an unknown workspace',
  );
  // The record-kind selector: an unknown kind is the SAME uniform 404
  // (fail-closed — no vocabulary oracle; validated against the exported
  // frozen vocabulary, never a caller freedom).
  assert.ok(
    memoryRoutes.includes('requireKnownMemoryKind'),
    'the record-kind path selector is validated against the frozen vocabulary',
  );
  assert.ok(
    /NotFoundError\('client-memory-record-kind'/.test(memoryRoutes),
    'an unknown record-kind selector is the uniform 404 (an unknown selector is indistinguishable from an unknown record)',
  );
});

// ---------------------------------------------------------------------------
// 6. NO OWNED STATE — the disclosed no-migration choice + the
//    non-authoritative retrieval technology (§6)
// ---------------------------------------------------------------------------

test('the module owns NO migration and NO retrieval index — live derivation over the canonical authorities (the disclosed choice)', () => {
  const migrations = readdirSync(src('platform', 'db', 'migrations')).filter((name) =>
    name.endsWith('.sql'),
  );
  for (const name of migrations) {
    assert.ok(
      !name.includes('client-memory') && !name.includes('client_memory'),
      `no client-memory-owned migration may exist (found '${name}') — the delivery is a live derivation, the /reporting + /profit-intelligence precedent`,
    );
  }
  // And the composition root wires the module with NO db/ids — only the
  // clock + the composed public-contract instances.
  const wiring = compositionRoot.match(/createClientMemoryModule\(\{[\s\S]*?\}\);/);
  assert.ok(wiring !== null, 'the composition root constructs the client-memory module');
  assert.ok(!wiring[0]!.includes('db,'), 'the module receives NO database handle (no owned state)');
  assert.ok(!wiring[0]!.includes('ids,'), 'the module receives NO id generator (nothing to mint)');
  assert.ok(wiring[0]!.includes('clock,'), 'the module receives the clock (the generatedAt stamp)');
  // §6: retrieval/index technology is non-authoritative — the module
  // declares NONE (no index, no cache, no store).
  for (const file of [publicEntry, moduleFile, projectionFile]) {
    assert.ok(
      !/retrievalIndex|memoryIndex|SearchIndex|VectorIndex|embedding/i.test(file),
      'client memory declares NO retrieval/index technology (§6 non-authoritative — none exists in this delivery)',
    );
    assert.ok(!file.includes('db.query'), 'no database handle is ever touched');
    assert.ok(!file.includes('deps.db'), 'no database dependency is ever declared');
  }
});

// ---------------------------------------------------------------------------
// 7. ZERO MUTATION METHODS + ZERO SQL (never a second tenant/data authority)
// ---------------------------------------------------------------------------

test('the module contract exposes EXACTLY THREE methods — all READS; no mutation verb exists anywhere in the public entry', () => {
  const apiBlock = publicEntry.match(
    /export interface ClientMemoryModuleApi \{([\s\S]*?)\n\}/,
  );
  assert.ok(apiBlock !== null, 'the module API interface is declared');
  const methods = [...apiBlock[1]!.matchAll(/^\s{2}(get|create|insert|update|delete|append|record|submit|transition|rebuild|recompute|reindex|set|add|remove|put|patch|post|write|mint|register|declare|supersede|cancel|decline|accept|publish|activate|pause|resume|close|open)[A-Za-z]*\(/gm)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(methods, ['get', 'get', 'get'], 'exactly the three read methods');
  for (const mutationVerb of [
    'create', 'insert', 'update', 'delete', 'append', 'record', 'submit',
    'transition', 'rebuild', 'recompute', 'reindex',
  ]) {
    assert.ok(
      !new RegExp(`^\\s{2}${mutationVerb}[A-Za-z]*\\(`, 'm').test(apiBlock[1]!),
      `a '${mutationVerb}*' method must never exist on the client-memory contract`,
    );
  }
});

test('the module internals contain ZERO SQL — the authorities compose through their public contracts only', () => {
  for (const file of [moduleFile, projectionFile]) {
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
        'client memory performs no SQL of any kind (pure projection over the composed public contracts)',
      );
    }
    assert.ok(!file.includes('db.query'), 'no database handle is ever touched');
    assert.ok(!file.includes('deps.db'), 'no database dependency is ever declared');
  }
});

// ---------------------------------------------------------------------------
// 8. The frozen projection vocabulary is exported (AC-3: policy-visible
//    composition — the cm-proj-v1 pattern)
// ---------------------------------------------------------------------------

test('the frozen projection vocabulary is exported (version, record kinds, authority map, selection rules)', () => {
  assert.ok(
    publicEntry.includes('export const CLIENT_MEMORY_PROJECTION_VERSION'),
    'the projection version is an exported frozen constant',
  );
  assert.ok(
    publicEntry.includes("export const CLIENT_MEMORY_RECORD_KINDS = ["),
    'the closed record-kind vocabulary is exported',
  );
  assert.ok(
    publicEntry.includes('export const CLIENT_MEMORY_SOURCE_AUTHORITIES'),
    'the authority map (policy-visible data lineage) is exported',
  );
  assert.ok(
    publicEntry.includes('export const CLIENT_MEMORY_SELECTION_RULES'),
    'the full selection-rule record is exported (no hidden rules)',
  );
  assert.ok(
    publicEntry.includes("persistence: 'none-derived-read-model'") ||
      projectionFile.includes("persistence: 'none-derived-read-model'"),
    'the projection disclosure declares the no-persistence basis',
  );
  assert.ok(
    publicEntry.includes("retrievalTechnology: 'none-live-composition-only'") ||
      projectionFile.includes("retrievalTechnology: 'none-live-composition-only'"),
    'the projection disclosure declares the non-authoritative retrieval posture (§6)',
  );
  // The vocabulary covers EXACTLY the §6 record-kind set (client, goal,
  // playbook, deployment, evidence, experiment, outcome, decision,
  // learning — plus the playbook-version refinement of the playbook
  // kind).
  assert.ok(publicEntry.includes("'outcome'"), 'the outcome record kind is in the vocabulary');
  assert.ok(publicEntry.includes("'decision'"), 'the decision record kind is in the vocabulary');
  assert.ok(publicEntry.includes("'learning'"), 'the learning record kind is in the vocabulary');
});

// ---------------------------------------------------------------------------
// 9. The shared registration files wire the surface; the additive spec
//    entries exist
// ---------------------------------------------------------------------------

test('routes.ts registers the client-memory family ONCE; application.ts exposes the SAME module contract', () => {
  assert.ok(
    routesFile.includes("import { registerClientMemoryRoutes } from './client-memory-routes.ts'"),
  );
  assert.equal(
    (routesFile.match(/registerClientMemoryRoutes\(router, services, modules\)/g) ?? []).length,
    1,
    'the client-memory family is registered exactly once',
  );
  assert.ok(routesFile.includes('MKT-044'));
  assert.ok(compositionRoot.includes('MKT-044'));
  assert.equal(
    (compositionRoot.match(/createClientMemoryModule\(/g) ?? []).length,
    1,
    'the composition root must not wire a second client-memory module',
  );
  assert.ok(applicationFile.includes('readonly clientMemory: ClientMemoryModuleApi'));
});

test('the additive spec entries exist (architecture.md §6 + the dependency-matrix line + the forbidden-direction bullet)', () => {
  const architecture = read(spec('architecture.md'));
  assert.ok(
    /^\/client-memory$/m.test(architecture),
    'the frozen module set includes /client-memory (required by the static checker)',
  );
  const matrix = read(spec('module-dependency-matrix.md'));
  assert.ok(
    matrix.includes(
      '/client-memory ──→ /clients, /workspaces, /goals, /playbooks, /deployments, /evidence, /experiments, /decisions, /learnings',
    ),
    'the dependency matrix carries the additive /client-memory line',
  );
  assert.ok(
    matrix.includes('/client-memory` is the v1.5 Client Operating Memory derived read model'),
    'the forbidden-direction bullet for /client-memory exists',
  );
});

// ---------------------------------------------------------------------------
// 10. The module structure follows the reporting/profit-intelligence
//     precedent
// ---------------------------------------------------------------------------

test('the module structure follows the reporting precedent (public.ts + internal/ only)', () => {
  const moduleDir = src('modules', 'client-memory');
  const entries = readdirSync(moduleDir, { withFileTypes: true })
    .filter((entry) => entry.name !== 'internal')
    .map((entry) => entry.name);
  assert.deepEqual(entries, ['public.ts'], 'exactly public.ts + internal/');
  const internal = readdirSync(join(moduleDir, 'internal')).sort();
  assert.deepEqual(internal, [
    'client-memory-module.ts',
    'memory-projection.ts',
  ]);
});

// ---------------------------------------------------------------------------
// 11. The composed-authority consumption posture — READ-ONLY
//     public-contract composition over EVERY composed authority (no
//     second tenant/data authority). Every authority is reached through
//     its public entry ONLY (never an internal/ import), and the module
//     declares no mutation surface over any of them.
// ---------------------------------------------------------------------------

test('every composed authority is consumed READ-ONLY through its public entry — no internal imports, no mutation surface over any authority', () => {
  const moduleFiles = [
    src('modules', 'client-memory', 'public.ts'),
    src('modules', 'client-memory', 'internal', 'client-memory-module.ts'),
    src('modules', 'client-memory', 'internal', 'memory-projection.ts'),
  ];
  for (const file of moduleFiles) {
    for (const specifier of importsOf(file)) {
      for (const authority of [
        'clients', 'workspaces', 'goals', 'playbooks', 'deployments',
        'evidence', 'experiments', 'decisions', 'learnings',
      ]) {
        if (specifier.includes(`/${authority}/`)) {
          assert.ok(
            /(\.\.\/)+[a-z-]+\/public\.ts$/.test(specifier),
            `the /${authority} contract is composed through its public entry only (found '${specifier}')`,
          );
        }
      }
    }
    // No mutation surface over ANY composed authority may be declared:
    // the module never names another authority's write commands.
    for (const forbidden of [
      'createClient', 'updateClientProfile', 'setClientStatus',
      'createGoal', 'updateGoal', 'setGoalStatus',
      'publishPlaybookVersion', 'createPlaybook',
      'createDeployment', 'activateDeployment', 'transitionDeployment',
      'appendEvidence', 'supersedeEvidence',
      'declareExperiment', 'transitionExperiment', 'concludeExperiment',
      'recordDecision', 'setDecisionDisposition', 'observeDecisionOutcome',
      'appendLearning', 'recordLearning',
    ]) {
      assert.ok(
        !file.includes(forbidden),
        `client memory must never declare a '${forbidden}' call (zero mutation methods over any authority)`,
      );
    }
  }
  // The canonical record types ARE named through their public contracts
  // (the sales-continuity precedent — no string trip-wire exists for
  // these authorities): the snapshot consumes the authority's own rows.
  assert.ok(
    projectionFile.includes("import type { DecisionRecord } from '../../decisions/public.ts'"),
    'the decision records are consumed through the /decisions public contract (the canonical shape)',
  );
  assert.ok(
    projectionFile.includes("import type { EvidenceRecord } from '../../evidence/public.ts'"),
    'the evidence records are consumed through the /evidence public contract (the canonical shape)',
  );
});
