/**
 * MKT-045 static tests — the AI Operator boundary is structurally correct
 * in the ACTUAL route file, the /ai-operator module, the shared
 * registration files and the additive spec entries (pure static analysis,
 * no DB; the MKT-043 profit-intelligence-boundary precedent). Proves the
 * frozen architecture boundaries (spec/architecture-v1.5.md §7: "Command
 * Center may rank attention items … Consequential actions continue
 * through the existing policy/approval contracts";
 * spec/module-dependency-matrix.md "/ai-operator ──→ /clients,
 * /workspaces, /workflows, /executions, /deployments, /jobs, /policies,
 * /evidence, /experiments, /learnings, /field-agents, /profit-intelligence"
 * + the derived-read-model forbidden-direction bullet):
 *
 *   1. the surface registers EXACTLY THREE routes and all are GETs — NO
 *      mutating verb exists anywhere in the route file (READ-ONLY BY
 *      CONSTRUCTION: there is no write path a frontend bypass could
 *      drive — the module never executes or creates actions);
 *   2. the route file reads NO request body, validates NO DTO and reads
 *      NO query parameter — the GET surface has no DTO at all, so
 *      authority fields (identifiers, item ids, categories, scores,
 *      assumptions, rank version) are structurally unreachable, not
 *      merely rejected;
 *   3. the route file's imports are whitelisted: platform + authorize +
 *      application + the /ai-operator public contract ONLY;
 *   4. thin delegation: the route file's ONLY module calls are the
 *      durable agency/membership authorization reads, the server-derived
 *      scope enumeration and the three /ai-operator reads;
 *   5. the AGENCY tenant boundary is the UNIFORM 404 (malformed/unknown/
 *      foreign agency → 404; foreign client → the same 404; foreign,
 *      unknown or malformed item id → the same 404 — nothing is stored,
 *      the queue re-derives; suspended membership → 403; anonymous → 401
 *      via the authenticator, fail closed);
 *   6. NO OWNED STATE (the disclosed AC-4 choice): the module owns NO
 *      migration (no ai_operator_*.sql file exists) — live derivation
 *      over the canonical authorities, the /profit-intelligence
 *      precedent;
 *   7. ZERO MUTATION METHODS AND ZERO SQL: the module contract exposes
 *      exactly three READ methods; the module's internal files contain
 *      NO SQL at all (no INSERT/UPDATE/DELETE/FROM — the authorities are
 *      reached through their public contracts only);
 *   8. the frozen ranking vocabulary is exported (the rank version, the
 *      category vocabulary + its version, the category/action/source/
 *      rationale-factor vocabularies and the full assumption record);
 *   9. the shared registration files wire the surface ONCE (one module
 *      in the composition root, one registration in routes.ts, one
 *      ApplicationModules member) and the additive spec entries exist
 *      (architecture.md §6 module list + the dependency-matrix line +
 *      the forbidden-direction bullet);
 *  10. the module structure follows the profit-intelligence precedent
 *      (public.ts + internal/ only);
 *  11. the /profit-intelligence consumption is READ-ONLY public-contract
 *      composition — scope-leakage and margin-pressure items CONSUME the
 *      PI views and there is NO second margin/leakage derivation
 *      anywhere in the module (no recomputation of its figures);
 *  12. ranking determinism is structural: the derivation files contain
 *      NO clock read (the score is a pure function of the authority rows
 *      — same inputs ⇒ identical order; the only clock use is the
 *      module's generatedAt stamp);
 *  13. the action-contract reference is a REFERENCE, never an execution:
 *      no route or module method drives any policy/decision/workflow
 *      mutation surface (consequential actions continue through the
 *      EXISTING policy/approval contracts on their own surfaces).
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

const operatorRoutes = read(src('api', 'ai-operator-routes.ts'));
const routesFile = read(src('api', 'routes.ts'));
const compositionRoot = read(src('composition-root.ts'));
const applicationFile = read(src('api', 'application.ts'));
const publicEntry = read(src('modules', 'ai-operator', 'public.ts'));
const moduleFile = read(src('modules', 'ai-operator', 'internal', 'ai-operator-module.ts'));
const derivationFile = read(src('modules', 'ai-operator', 'internal', 'attention-derivation.ts'));

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

test('the ai-operator routes register EXACTLY THREE surfaces — all GETs — and no mutating verb exists in the file', () => {
  const registered = [...operatorRoutes.matchAll(/'(?:GET|POST|PUT|PATCH|DELETE)',\s*'(\/[^']+)'/g)]
    .map((match) => match[1]!);
  assert.deepEqual(registered, [
    '/api/ai-operator/:agencyId/attention-queue',
    '/api/ai-operator/:agencyId/attention-queue/:itemId',
    '/api/ai-operator/:agencyId/clients/:clientId/attention-queue',
  ]);
  for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.ok(
      !operatorRoutes.includes(`'${verb}',`),
      `the AI Operator must never register a ${verb} route (it ranks action candidates; every consequential action flows through the EXISTING policy/approval contracts on their own surfaces — a frontend bypass cannot drive anything here)`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. No DTO at all — the GET surfaces read no body and no query
// ---------------------------------------------------------------------------

test('the route file reads NO request body, validates NO DTO and reads no query parameters', () => {
  assert.ok(!operatorRoutes.includes('validateObject'), 'the GET surfaces validate no body');
  assert.ok(!operatorRoutes.includes('ctx.request.body'), 'the routes never touch a request body');
  assert.ok(
    !operatorRoutes.includes('forbiddenKeys'),
    'there is no DTO to carry authority fields — the surfaces accept no input at all',
  );
  assert.ok(
    !operatorRoutes.includes('defineMutationRoute'),
    'the AI Operator registers no mutation pipeline route',
  );
  assert.ok(
    !operatorRoutes.includes('ctx.request.query') && !operatorRoutes.includes('searchParams'),
    'the AI Operator never reads query parameters (scope is server-derived; item ids are path selectors resolved by re-derivation)',
  );
});

// ---------------------------------------------------------------------------
// 3. Import whitelist — the composed authorities are reached THROUGH the
//    ApplicationModules aggregate + the /ai-operator public contract
// ---------------------------------------------------------------------------

test('the route file imports ONLY platform + authorize + application + the /ai-operator public contract', () => {
  const allowed = [
    /^node:/,
    /^\.\.\/platform\//,
    /^\.\.\/modules\/ai-operator\/public\.ts$/,
    /^\.\/authorize\.ts$/,
    /^\.\/application\.ts$/,
  ];
  for (const specifier of importsOf(src('api', 'ai-operator-routes.ts'))) {
    assert.ok(
      allowed.some((pattern) => pattern.test(specifier)),
      `unexpected import '${specifier}' — the ai-operator routes compose the module public contract only`,
    );
  }
  for (const specifier of importsOf(src('api', 'ai-operator-routes.ts'))) {
    for (const authority of [
      'policies', 'evidence', 'experiments', 'learnings', 'workflows', 'executions',
      'deployments', '/jobs/', 'field-agents', 'profit-intelligence', '/clients/',
      '/workspaces/', 'audit', 'decisions',
    ]) {
      assert.ok(
        !specifier.includes(authority),
        `the route family must not import '${authority}' directly (scope-as-data through ApplicationModules only)`,
      );
    }
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
    'modules.aiOperator.getAgencyAttentionQueue',
    'modules.aiOperator.getAttentionItem',
    'modules.aiOperator.getClientAttentionQueue',
  ];
  for (const match of operatorRoutes.matchAll(/modules\.[a-zA-Z]+\.[A-Za-z]+/g)) {
    assert.ok(
      allowedModuleCalls.includes(match[0]),
      `unexpected module call '${match[0]}' — the ai-operator surface is a thin delegation layer`,
    );
  }
  assert.ok(operatorRoutes.includes('resolveContext'));
  assert.ok(operatorRoutes.includes('requireAiOperatorAgency'));
  // Reads emit no audit events (nothing material happened).
  assert.ok(!operatorRoutes.includes('recordMutationAudit'));
  assert.ok(!operatorRoutes.includes('audit-emit'));
});

// ---------------------------------------------------------------------------
// 5. The agency tenant boundary — uniform 404 for foreign identifiers
// ---------------------------------------------------------------------------

test('the agency tenant boundary is the UNIFORM 404: cross-tenant identifiers never leak existence (404, not 403)', () => {
  assert.ok(
    operatorRoutes.includes("if (!UUID_PATTERN.test(agencyId))"),
    'a malformed agency identifier is rejected as the uniform 404',
  );
  assert.ok(
    /agency === null[\s\S]{0,120}NotFoundError\('agency'/.test(operatorRoutes),
    'an unknown agency is the uniform 404',
  );
  const foreignBranch = operatorRoutes.match(
    /if \(membership === undefined\) \{\n\s*\/\/ Hard boundary[\s\S]{0,220}?NotFoundError\('agency', agencyId\);\n\s*\}/,
  );
  assert.ok(
    foreignBranch !== null,
    'a caller with NO membership in the owning agency gets the SAME 404 as an unknown agency (cross-agency data must 404, never 403-leak existence)',
  );
  assert.ok(
    /membership\.membershipStatus !== 'active'[\s\S]{0,120}ForbiddenError/.test(operatorRoutes),
    'only a suspended membership is a 403 (intra-tenant, post-existence)',
  );
  // The client detail selector: a foreign or malformed identifier is the
  // same uniform 404 (validated against the OWNING agency's live clients).
  assert.ok(
    operatorRoutes.includes("if (!UUID_PATTERN.test(clientId))"),
    'a malformed client identifier is rejected as the uniform 404',
  );
  const foreignClientBranch = operatorRoutes.match(
    /if \(match === undefined\) \{\n\s*\/\/ Hard boundary[\s\S]{0,240}?NotFoundError\('client', clientId\);\n\s*\}/,
  );
  assert.ok(
    foreignClientBranch !== null,
    'a Client of another agency gets the SAME 404 as an unknown client (no cross-agency existence oracle)',
  );
  // The item detail selector: the item id is resolved by RE-DERIVING the
  // agency queue — a foreign, unknown or malformed item id is simply
  // absent from THIS agency's queue → the same uniform 404.
  assert.ok(
    /match === undefined[\s\S]{0,120}NotFoundError\('attention-item'/.test(moduleFile),
    'a foreign, unknown or malformed item id is the uniform 404 (nothing is stored; the queue re-derives)',
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
      !name.includes('ai_operator') && !name.includes('ai-operator'),
      `no ai-operator-owned migration may exist (found '${name}') — the delivery is a live derivation, the /profit-intelligence precedent`,
    );
  }
  // And the composition root wires the module with NO db/ids — only the
  // clock + the composed public-contract instances.
  const wiring = compositionRoot.match(/createAiOperatorModule\(\{[\s\S]*?\}\);/);
  assert.ok(wiring !== null, 'the composition root constructs the ai-operator module');
  assert.ok(!wiring[0]!.includes('db,'), 'the module receives NO database handle (no owned state)');
  assert.ok(!wiring[0]!.includes('ids,'), 'the module receives NO id generator (nothing to mint)');
  assert.ok(wiring[0]!.includes('clock,'), 'the module receives the clock (the generatedAt stamp only)');
});

// ---------------------------------------------------------------------------
// 7. ZERO MUTATION METHODS + ZERO SQL (architecture-v1.5.md §7)
// ---------------------------------------------------------------------------

test('the module contract exposes EXACTLY THREE methods — all READS; no mutation verb exists anywhere in the public entry', () => {
  const apiBlock = publicEntry.match(
    /export interface AiOperatorModuleApi \{([\s\S]*?)\n\}/,
  );
  assert.ok(apiBlock !== null, 'the module API interface is declared');
  const methods = [...apiBlock[1]!.matchAll(/^\s{2}(get|create|insert|update|delete|append|record|submit|transition|rebuild|recompute|refresh|set|add|remove|put|patch|post|write|mint|register|declare|supersede|cancel|decline|accept|publish|activate|pause|resume|close|open|rank|execute|approve)[A-Za-z]*\(/gm)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(methods, ['get', 'get', 'get'], 'exactly the three read methods');
  for (const mutationVerb of [
    'create', 'insert', 'update', 'delete', 'append', 'record', 'submit',
    'transition', 'rebuild', 'recompute', 'refresh', 'execute', 'approve',
  ]) {
    assert.ok(
      !new RegExp(`^\\s{2}${mutationVerb}[A-Za-z]*\\(`, 'm').test(apiBlock[1]!),
      `a '${mutationVerb}*' method must never exist on the ai-operator contract`,
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
        'the AI Operator performs no SQL of any kind (pure derivation over the composed public contracts)',
      );
    }
    assert.ok(!file.includes('db.query'), 'no database handle is ever touched');
    assert.ok(!file.includes('deps.db'), 'no database dependency is ever declared');
  }
});

// ---------------------------------------------------------------------------
// 8. The frozen ranking vocabulary is exported (AC-3/AC-6)
// ---------------------------------------------------------------------------

test('the frozen ranking vocabulary is exported (rank version, category vocabulary + version, action/source/factor vocabularies, assumption set)', () => {
  assert.ok(
    publicEntry.includes('export const AI_OPERATOR_RANK_VERSION'),
    'the rank calculation version is an exported frozen constant',
  );
  assert.ok(
    publicEntry.includes("export const ATTENTION_CATEGORY_VOCABULARY_VERSION = 'ao-categories-v1' as const"),
    'the category vocabulary version is an exported frozen constant',
  );
  assert.ok(
    publicEntry.includes('export const ATTENTION_CATEGORIES'),
    'the eight-category vocabulary is exported',
  );
  assert.ok(
    publicEntry.includes('export const ATTENTION_ACTION_CONTRACT_KINDS'),
    'the consequential-action-contract vocabulary is exported',
  );
  assert.ok(
    publicEntry.includes('export const ATTENTION_SOURCE_REF_KINDS'),
    'the source-reference vocabulary is exported',
  );
  assert.ok(
    publicEntry.includes('export const ATTENTION_RATIONALE_FACTOR_KEYS'),
    'the rationale-factor vocabulary is exported',
  );
  assert.ok(
    publicEntry.includes('export const AI_OPERATOR_ASSUMPTIONS'),
    'the full assumption set is exported (no hidden constants)',
  );
  assert.ok(
    publicEntry.includes("persistence: 'none-derived-read-model'") ||
      derivationFile.includes("persistence: 'none-derived-read-model'"),
    'the ranking disclosure declares the no-persistence basis',
  );
});

// ---------------------------------------------------------------------------
// 9. The shared registration files wire the surface; the additive spec
//    entries exist
// ---------------------------------------------------------------------------

test('routes.ts registers the ai-operator family ONCE; application.ts exposes the SAME module contract', () => {
  assert.ok(
    routesFile.includes("import { registerAiOperatorRoutes } from './ai-operator-routes.ts'"),
  );
  assert.equal(
    (routesFile.match(/registerAiOperatorRoutes\(router, services, modules\)/g) ?? []).length,
    1,
    'the ai-operator family is registered exactly once',
  );
  assert.ok(routesFile.includes('MKT-045'));
  assert.ok(compositionRoot.includes('MKT-045'));
  assert.equal(
    (compositionRoot.match(/createAiOperatorModule\(/g) ?? []).length,
    1,
    'the composition root must not wire a second ai-operator module',
  );
  assert.ok(applicationFile.includes('readonly aiOperator: AiOperatorModuleApi'));
});

test('the additive spec entries exist (architecture.md §6 + the dependency-matrix line + the forbidden-direction bullet)', () => {
  const architecture = read(spec('architecture.md'));
  assert.ok(
    /^\/ai-operator$/m.test(architecture),
    'the frozen module set includes /ai-operator (required by the static checker)',
  );
  const matrix = read(spec('module-dependency-matrix.md'));
  assert.ok(
    matrix.includes(
      '/ai-operator ──→ /clients, /workspaces, /workflows, /executions, /deployments, /jobs, /policies, /evidence, /experiments, /learnings, /field-agents, /profit-intelligence',
    ),
    'the dependency matrix carries the additive /ai-operator line',
  );
  assert.ok(
    matrix.includes('/ai-operator` is the v1.5 AI Operator attention-queue read model'),
    'the forbidden-direction bullet for /ai-operator exists',
  );
});

// ---------------------------------------------------------------------------
// 10. The module structure follows the profit-intelligence precedent
// ---------------------------------------------------------------------------

test('the module structure follows the profit-intelligence precedent (public.ts + internal/ only)', () => {
  const moduleDir = src('modules', 'ai-operator');
  const entries = readdirSync(moduleDir, { withFileTypes: true })
    .filter((entry) => entry.name !== 'internal')
    .map((entry) => entry.name);
  assert.deepEqual(entries, ['public.ts'], 'exactly public.ts + internal/');
  const internal = readdirSync(join(moduleDir, 'internal')).sort();
  assert.deepEqual(internal, [
    'ai-operator-module.ts',
    'attention-derivation.ts',
  ]);
});

// ---------------------------------------------------------------------------
// 11. The /profit-intelligence consumption posture (the matrix line's
//     READ-ONLY consumption — no second margin/leakage derivation). The
//     module CONSUMES ClientProfitIntelligenceView through the PUBLIC
//     contract only: the leakage indicators and margin figures arrive
//     fully derived (count/sourceRefs/calculationVersion from PI's own
//     module), and this module never re-derives them — there is no
//     metric-observation read, no cost computation and no leakage rule
//     anywhere in its internals.
// ---------------------------------------------------------------------------

test('the /profit-intelligence consumption is READ-ONLY public-contract composition — scope leakage and margin pressure are CONSUMED, never recomputed', () => {
  for (const file of [publicEntry, moduleFile, derivationFile]) {
    // The composed authority is reached through the PUBLIC entry only —
    // never an internal/ import.
    for (const specifier of importsOf(
      file === publicEntry
        ? src('modules', 'ai-operator', 'public.ts')
        : file === moduleFile
          ? src('modules', 'ai-operator', 'internal', 'ai-operator-module.ts')
          : src('modules', 'ai-operator', 'internal', 'attention-derivation.ts'),
    )) {
      if (specifier.includes('profit-intelligence')) {
        assert.ok(
          /(\.\.\/)+profit-intelligence\/public\.ts$/.test(specifier),
          `the /profit-intelligence contract is composed through its public entry only (found '${specifier}')`,
        );
      }
    }
  }
  // The module composes PI's CLIENT VIEW (the fully derived surface) —
  // never its raw inputs: no metric-observation read, no /metrics import,
  // no cost arithmetic, no revenue rollup, no leakage rule of its own.
  assert.ok(
    derivationFile.includes('readonly profit: ClientProfitIntelligenceView | null'),
    'the consumed surface is the PI CLIENT VIEW (fully derived figures, PI calculation version included)',
  );
  for (const file of [moduleFile, derivationFile]) {
    assert.ok(
      !file.includes('listMetricObservations'),
      'the AI Operator never reads metric observations (margin figures are consumed from PI, never recomputed)',
    );
    assert.ok(
      !file.includes('listConnectionsForClient'),
      'the AI Operator never reads integrations connections (cost figures are consumed from PI, never recomputed)',
    );
    assert.ok(
      !file.includes('totalDeliveryCost'),
      'the AI Operator never computes delivery cost (consumed from PI)',
    );
    assert.ok(
      !file.includes('revenue.byCurrency'),
      'the AI Operator never computes revenue rollups (consumed from PI)',
    );
    assert.ok(
      !/NO\s+ACTIVE\s+deployment/.test(derivationFile),
      'the AI Operator never states a leakage derivation rule of its own (consumed from PI verbatim)',
    );
  }
  // The PI calculation version is consumed + disclosed, not re-declared:
  // the derivation imports the frozen constant from the PI public entry.
  assert.ok(
    derivationFile.includes("PROFIT_INTELLIGENCE_CALCULATION_VERSION } from '../../profit-intelligence/public.ts'"),
    'the consumed PI calculation version is the PI public entry\'s own frozen constant (never re-declared here)',
  );
});

// ---------------------------------------------------------------------------
// 12. Ranking determinism is structural — NO clock read in the derivations
// ---------------------------------------------------------------------------

test('ranking determinism is structural: the pure derivations never read the clock (the score is a pure function of the authority rows)', () => {
  for (const file of [derivationFile]) {
    assert.ok(
      !file.includes('deps.clock') && !file.includes('clock.'),
      'the pure derivation files never touch the clock API (same authority rows ⇒ same scores, any time)',
    );
    assert.ok(
      !/Date\.now\(\)/.test(file),
      'the pure derivations contain no Date.now() (no time-based ranking factor may exist)',
    );
    assert.ok(
      !/new Date\(/.test(file),
      'the pure derivations construct no Date (no time-based ranking factor may exist)',
    );
  }
  // The module's ONLY clock use is the generatedAt stamp on the views.
  const clockUses = [...moduleFile.matchAll(/clock\.[a-zA-Z]+/g)].map((match) => match[0]);
  assert.deepEqual(
    [...new Set(clockUses)],
    ['clock.nowIso'],
    'the module touches the clock only for the generatedAt stamp',
  );
});

// ---------------------------------------------------------------------------
// 13. The action-contract reference is a REFERENCE, never an execution
// ---------------------------------------------------------------------------

test('the action-contract reference never executes: no route or module code drives any authority mutation surface', () => {
  for (const file of [operatorRoutes, moduleFile, derivationFile]) {
    assert.ok(
      !file.includes('evaluateAction('),
      'the AI Operator never calls the policy evaluation surface (it references the pending approval; the OPERATOR re-evaluates through the existing contract)',
    );
    assert.ok(
      !file.includes('declarePolicyVersion('),
      'the AI Operator never declares policy versions',
    );
    assert.ok(
      !file.includes('transitionWorkflowInstance('),
      'the AI Operator never transitions workflow instances',
    );
    assert.ok(
      !file.includes('recordDecision('),
      'the AI Operator never records decisions',
    );
    assert.ok(
      !file.includes('appendEvidence('),
      'the AI Operator never appends evidence',
    );
    assert.ok(
      !file.includes('submitOutcome('),
      'the AI Operator never submits job outcomes',
    );
  }
  // And every item carries the reference: the AttentionActionContract is
  // part of the exported item shape with the policy/approval gate fields.
  assert.ok(
    publicEntry.includes('export interface AttentionActionContract'),
    'the action-contract reference shape is exported',
  );
  assert.ok(
    /readonly policyDimension: PolicyDimension \| null/.test(publicEntry),
    'the action contract carries the policy gate dimension (§7 reference)',
  );
});
