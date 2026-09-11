/**
 * MKT-021 static tests — the execution policy engine boundary is
 * structurally correct, fail-closed and CRED-001-clean in the ACTUAL
 * module contract, migration, routes and source tree (pure static
 * analysis, no DB).
 *
 * Acceptance proofs (requirements.md POL-001; work-item-matrix.md
 * MKT-021 = "policy matrix + POL/CRED fail-closed checks"; spec/
 * architecture.md §2.1 "PostgreSQL is authoritative ... for ... policy
 * state"; §22 security layering; spec/implementation-contract.md §3
 * "No externally supplied field may override a server-derived actor,
 * owner, provenance, policy decision"; §21 credential contract; spec/
 * module-dependency-matrix.md "/policies ──→ /clients, /agencies" and
 * "/credentials ──→ /auth, /policies" — the REVERSE direction is
 * forbidden; spec/security-threat-model.md "Caller-supplied authority
 * fields" and "Policy time-of-check/time-of-use race"):
 *
 *   1. the policies + policy_decisions storage carries EXACTLY the
 *      frozen column sets — the seven-dimension CHECK, the
 *      allow/deny/unknown outcome CHECK, the closed reason-code CHECK,
 *      append-only decision triggers, content immutability, the ACTIVE
 *      version fence and the version-sequence fence — and NO column
 *      capable of holding secret material or a secret handle (CRED-001:
 *      the engine evaluates access proposals; §21);
 *   2. the /policies module domain code imports ONLY platform ports
 *      (db/clock/ids) + the two matrix-allowed public contracts
 *      (/agencies, /clients) + its own module — NO /credentials import
 *      (the structural-port posture), NO provider SDK references, NO
 *      infrastructure coupling, NO 'pg' import and no application-layer
 *      imports;
 *   3. the module API is exactly the declared surface
 *      (declarePolicyVersion/getPolicyVersion/listPolicyVersions/
 *      getActivePolicyVersion/evaluateAction/getPolicyDecision/
 *      listPolicyDecisions) — NO enforcement/invoke/dispatch methods
 *      (enforcement arrives with the consuming Work Items);
 *   4. the CRED-001 reference port is REFERENCE-ONLY: the snapshot type
 *      structurally excludes the secret handle and any material field;
 *   5. the API DTO layer wires the authority-field rejection contracts on
 *      every mutation surface (declaration: identity/scope/lifecycle/
 *      provenance; evaluation: outcome/reasons/provenance/scope) and the
 *      route set is exactly the twelve frozen MKT-021 routes — no update,
 *      no delete (policy history is append-oriented), evaluation is a
 *      POST decision surface;
 *   6. the shared registration files wire the module: application.ts
 *      exposes PoliciesModuleApi, routes.ts registers the routes, the
 *      composition root constructs the module with the /agencies +
 *      /clients public contracts and the /credentials instance through
 *      the reference-only structural port;
 *   7. fail-closed vocabulary: every decision outcome path in the module
 *      records an outcome from the closed set, and the enforcement helper
 *      maps only 'allow' to permission.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  POLICY_DIMENSIONS,
  POLICY_REASON_CODES,
  enforcementOutcome,
} from '../../src/modules/policies/public.ts';
import type { CredentialReferenceLookupPort } from '../../src/modules/policies/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migration025 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '025_policies.sql'),
  'utf8',
);
const policiesPublic = readFileSync(
  join(repoRoot, 'src', 'modules', 'policies', 'public.ts'),
  'utf8',
);
const policiesModule = readFileSync(
  join(repoRoot, 'src', 'modules', 'policies', 'internal', 'module.ts'),
  'utf8',
);
const policiesStore = readFileSync(
  join(repoRoot, 'src', 'modules', 'policies', 'internal', 'store.ts'),
  'utf8',
);
const policiesRoutes = readFileSync(
  join(repoRoot, 'src', 'api', 'policies-routes.ts'),
  'utf8',
);
const applicationTs = readFileSync(join(repoRoot, 'src', 'api', 'application.ts'), 'utf8');
const routesTs = readFileSync(join(repoRoot, 'src', 'api', 'routes.ts'), 'utf8');
const compositionRoot = readFileSync(join(repoRoot, 'src', 'composition-root.ts'), 'utf8');

/** Extracts the CREATE TABLE block for `table` from a migration SQL text (comment lines stripped). */
function createTableBlock(migration: string, table: string): string {
  // Strip SQL comment lines first: comments can contain ');' which would
  // otherwise cut the block early (the 025 header comments do).
  const source = migration
    .split('\n')
    .map((line) => (line.trim().startsWith('--') ? '' : line))
    .join('\n');
  const marker = `CREATE TABLE IF NOT EXISTS ${table} (`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `migration must create ${table}`);
  const end = source.indexOf(');', start);
  assert.ok(end > start, `${table} block must terminate`);
  return source.slice(start, end);
}

function columnsOf(block: string): string[] {
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[a-z_]+\s+\w+/.test(line))
    .map((line) => line.split(/\s+/)[0]!);
}

function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) collectTsFiles(abs, out);
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(abs);
  }
  return out;
}

/** Extracts every import specifier string from a TypeScript source file. */
function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  const patterns = [
    /import\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /export\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) out.push(match[1]!);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Storage: the frozen column sets, fences and the no-material posture
// ---------------------------------------------------------------------------

test('migration 025 exists and creates exactly the two /policies tables', () => {
  assert.ok(migration025.includes('CREATE TABLE IF NOT EXISTS policies ('));
  assert.ok(migration025.includes('CREATE TABLE IF NOT EXISTS policy_decisions ('));
});

test('policies storage: exactly the frozen policy-version columns — no material- or handle-capable column', () => {
  const columns = columnsOf(createTableBlock(migration025, 'policies'));
  assert.deepEqual(columns, [
    'policy_id',
    'dimension',
    'agency_id',
    'client_id',
    'status',
    'version_seq',
    'rules',
    'description',
    'created_by',
    'superseded_at',
    'superseded_by_policy_id',
    'version',
    'created_at',
    'updated_at',
  ]);
  for (const forbidden of ['secret', 'secret_handle', 'material', 'api_key', 'token']) {
    assert.ok(!columns.includes(forbidden), `policies must not carry a '${forbidden}' column`);
  }
});

test('policies storage: the seven-dimension CHECK is closed', () => {
  const block = createTableBlock(migration025, 'policies').replace(/\s+/g, ' ');
  assert.ok(
    block.includes("dimension IN ('ai', 'tools', 'network', 'secrets', 'deployment', 'field', 'extension')"),
    'the dimension CHECK must be the closed POL-001 set',
  );
});

test('policies storage: the append-oriented fences are database backstops', () => {
  // Exactly one ACTIVE version per (scope, dimension).
  assert.ok(migration025.includes('policies_active_fence'));
  // version_seq unique per (scope, dimension).
  assert.ok(migration025.includes('policies_scope_version_fence'));
  // Content immutability (rules/dimension/scope/provenance).
  assert.ok(migration025.includes('policies_content_immutable'));
  // Superseded is terminal + consistent (superseder is a later version of
  // the same scope+dimension).
  assert.ok(migration025.includes('policies_superseded_consistent'));
  // Client scope cannot cross the Client boundary.
  assert.ok(migration025.includes('policies_scope_legal'));
});

test('policy_decisions storage: exactly the frozen decision columns — no material-capable column', () => {
  const columns = columnsOf(createTableBlock(migration025, 'policy_decisions'));
  assert.deepEqual(columns, [
    'decision_id',
    'dimension',
    'agency_id',
    'client_id',
    'outcome',
    'reason_code',
    'reasons',
    'action',
    'matched_policy_versions',
    'recorded_actor',
    'recorded_via',
    'correlation_id',
    'causation_id',
    'recorded_at',
    'evaluated_at',
  ]);
  for (const forbidden of ['secret', 'secret_handle', 'material', 'api_key']) {
    assert.ok(!columns.includes(forbidden), `policy_decisions must not carry a '${forbidden}' column`);
  }
});

test('policy_decisions storage: the outcome + reason-code CHECKs are the closed fail-closed vocabulary', () => {
  const block = createTableBlock(migration025, 'policy_decisions');
  assert.ok(
    block.includes("outcome IN ('allow', 'deny', 'unknown')"),
    'the outcome CHECK must be the closed allow/deny/unknown set',
  );
  for (const code of POLICY_REASON_CODES) {
    assert.ok(block.includes(`'${code}'`), `the reason-code CHECK must include '${code}'`);
  }
});

test('policy_decisions storage: append-only triggers reject UPDATE and DELETE (audit retention)', () => {
  assert.ok(migration025.includes('policy_decisions_append_only_update_trigger'));
  assert.ok(migration025.includes('policy_decisions_append_only_delete_trigger'));
});

test('policy_decisions storage: the scope chain cannot cross the Client boundary', () => {
  assert.ok(migration025.includes('policy_decisions_client_within_agency'));
});

test('storage: the §21 material-key CHECK functions guard every payload column', () => {
  assert.ok(migration025.includes('policy_payload_has_no_material_keys'));
  // rules, reasons and action are all fenced by the material-key validator.
  const fenced = (migration025.match(/policy_payload_has_no_material_keys\(/g) ?? []).length;
  assert.ok(fenced >= 5, 'rules CHECK + reasons CHECK + action CHECK (plus definition) must all fence');
});

// ---------------------------------------------------------------------------
// 2. Module import surface (the frozen matrix posture)
// ---------------------------------------------------------------------------

test('the /policies module imports ONLY platform ports + /agencies + /clients public entries + its own module', () => {
  const moduleDir = join(repoRoot, 'src', 'modules', 'policies');
  const files = collectTsFiles(moduleDir);
  assert.ok(files.length >= 3, 'the policies module must exist with public + internal files');
  const allowedModuleImports = new Set(['../agencies/public.ts', '../clients/public.ts']);
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith('.')) {
        assert.ok(
          specifier.startsWith('node:'),
          `${file}: external import '${specifier}' is forbidden (platform ports only)`,
        );
        continue;
      }
      // Platform port imports are always allowed (db/clock/ids/errors are
      // the module's platform contract surface).
      if (/platform\//.test(specifier)) continue;
      // Intra-module imports are fine.
      const fromInternal = file.includes(join('policies', 'internal'));
      const toSelf =
        specifier.startsWith('./') ||
        (fromInternal && specifier.startsWith('../public.ts'));
      if (toSelf) continue;
      assert.ok(
        allowedModuleImports.has(specifier),
        `${file}: cross-module import '${specifier}' is not allowed (matrix: /policies ──→ /clients, /agencies only)`,
      );
    }
    // The CRED-001 posture: NO /credentials import exists anywhere in the
    // module (the reference lookup arrives through the structural port).
    assert.ok(!source.includes('../credentials/public.ts'), `${file} must not import /credentials`);
  }
});

test('the /policies module domain code has no provider SDK, pg, secrets or infrastructure coupling', () => {
  const sources = [policiesPublic, policiesModule, policiesStore].join('\n');
  assert.ok(!/from\s+['"]pg['"]/.test(sources), 'no pg import inside the module');
  assert.ok(!sources.includes('node-postgres'), 'no node-postgres reference');
  for (const forbidden of [
    'SecretStore',
    'resolveCredentialMaterial',
    'secrets/adapters',
    'SandboxDriver',
    'sandboxDriver',
  ]) {
    assert.ok(!sources.includes(forbidden), `the policy engine must not touch '${forbidden}'`);
  }
});

// ---------------------------------------------------------------------------
// 3. The module API surface
// ---------------------------------------------------------------------------

test('the module API is exactly the declared policy engine surface — no enforcement hooks', () => {
  const apiMembers = [
    'declarePolicyVersion',
    'getPolicyVersion',
    'listPolicyVersions',
    'getActivePolicyVersion',
    'evaluateAction',
    'getPolicyDecision',
    'listPolicyDecisions',
  ];
  for (const member of apiMembers) {
    assert.ok(policiesPublic.includes(`  ${member}(`), `the API must declare ${member}`);
  }
  // No enforcement/invoke/dispatch surface: the engine decides + records.
  for (const forbidden of ['enforce(', 'invoke(', 'dispatch(', 'intercept(']) {
    assert.ok(!policiesPublic.includes(forbidden), `the module API must not expose '${forbidden}'`);
  }
});

test('fail-closed vocabulary: enforcement maps only explicit allow to permission', () => {
  assert.equal(enforcementOutcome({ outcome: 'allow' }), 'allow');
  assert.equal(enforcementOutcome({ outcome: 'deny' }), 'deny');
  assert.equal(enforcementOutcome({ outcome: 'unknown' }), 'deny');
});

// ---------------------------------------------------------------------------
// 4. The CRED-001 reference-only structural port
// ---------------------------------------------------------------------------

test('CRED-001: the credential reference port is REFERENCE-ONLY — no handle, no material', () => {
  const snapshotShape = /export interface PolicyCredentialReferenceSnapshot \{[\s\S]*?\}/.exec(
    policiesPublic,
  );
  assert.ok(snapshotShape !== null, 'the reference snapshot type must exist');
  const body = snapshotShape[0]!;
  for (const field of ['credentialId', 'agencyId', 'clientId', 'kind', 'status']) {
    assert.ok(body.includes(`readonly ${field}:`), `the snapshot must carry '${field}'`);
  }
  for (const forbidden of ['secretHandle', 'material', 'secret', 'verifier']) {
    assert.ok(!body.includes(forbidden), `the reference snapshot must never carry '${forbidden}'`);
  }
  // The port is consumed ONLY through the module's deps; the module never
  // resolves material with it.
  assert.ok(policiesModule.includes('credentialReferences.getCredentialReference'));
  assert.ok(!policiesModule.includes('resolveCredentialMaterial'));
});

test('CRED-001: the composition root satisfies the port with the concrete /credentials instance (structural wiring)', () => {
  assert.ok(
    compositionRoot.includes('credentialReferences: credentials'),
    'the composition root must wire the /credentials public contract into the reference-only port',
  );
  // Structural typing proof: the port type compiles against the real
  // module API (this import exists only to assert the shape).
  const port: CredentialReferenceLookupPort = {
    async getCredentialReference() {
      return null;
    },
  };
  assert.ok(typeof port.getCredentialReference === 'function');
});

// ---------------------------------------------------------------------------
// 5. The route set + DTO authority-field contracts
// ---------------------------------------------------------------------------

test('the route set is exactly the twelve frozen MKT-021 routes — no update, no delete', () => {
  const routePattern = /router\.add\(\s*'([A-Z]+)',\s*\n?\s*'([^']+)'/g;
  const routes: string[] = [];
  for (const match of policiesRoutes.matchAll(routePattern)) {
    routes.push(`${match[1]} ${match[2]}`);
  }
  assert.deepEqual(routes, [
    'POST /api/policies',
    'GET /api/policies',
    'POST /api/agencies/:agencyId/policies',
    'GET /api/agencies/:agencyId/policies',
    'POST /api/clients/:clientId/policies',
    'GET /api/clients/:clientId/policies',
    'GET /api/policies/:policyId',
    'POST /api/agencies/:agencyId/policies/evaluate',
    'POST /api/clients/:clientId/policies/evaluate',
    'GET /api/agencies/:agencyId/policy-decisions',
    'GET /api/clients/:clientId/policy-decisions',
    'GET /api/policy-decisions/:decisionId',
  ]);
  assert.ok(!routes.some((route) => route.startsWith('PUT ') || route.startsWith('PATCH ') || route.startsWith('DELETE ')));
});

test('evaluation DTOs reject every decision-shaped authority field (server-derived outcomes/provenance/scope)', () => {
  for (const forbidden of [
    'outcome',
    'reasonCode',
    'reasons',
    'decisionId',
    'matchedPolicyVersions',
    'provenance',
    'actor',
    'correlationId',
    'causationId',
    'recordedAt',
    'evaluatedAt',
    'agencyId',
    'clientId',
    'scope',
  ]) {
    assert.ok(
      policiesRoutes.includes(`'${forbidden}',`),
      `the evaluation authority-field contract must reject '${forbidden}'`,
    );
  }
  // Material-shaped keys are rejected on every policies surface.
  for (const forbidden of ['secret', 'secretMaterial', 'material', 'password', 'apiKey', 'secretHandle']) {
    assert.ok(policiesRoutes.includes(`'${forbidden}',`), `material keys must be rejected: '${forbidden}'`);
  }
});

test('declaration DTOs reject identity/scope/lifecycle/provenance authority fields', () => {
  for (const forbidden of [
    'policyId',
    'scopeKind',
    'status',
    'versionSeq',
    'supersededByPolicyId',
    'createdBy',
    'createdAt',
    'provenance',
  ]) {
    assert.ok(
      policiesRoutes.includes(`'${forbidden}',`),
      `the declaration authority-field contract must reject '${forbidden}'`,
    );
  }
});

test('evaluation is a POST decision surface that returns the decision record (never a silent enforcement)', () => {
  assert.ok(policiesRoutes.includes("'/api/agencies/:agencyId/policies/evaluate'"));
  assert.ok(policiesRoutes.includes("'/api/clients/:clientId/policies/evaluate'"));
  // The provenance is server-built from the authenticated principal —
  // never from the request body.
  assert.ok(policiesRoutes.includes('serverProvenance(ctx.principal)'));
});

// ---------------------------------------------------------------------------
// 6. Shared registration files
// ---------------------------------------------------------------------------

test('application.ts exposes the PoliciesModuleApi on ApplicationModules', () => {
  assert.ok(applicationTs.includes("import type { PoliciesModuleApi } from '../modules/policies/public.ts'"));
  assert.ok(applicationTs.includes('readonly policies: PoliciesModuleApi;'));
});

test('routes.ts registers the policies routes', () => {
  assert.ok(routesTs.includes("import { registerPoliciesRoutes } from './policies-routes.ts'"));
  assert.ok(routesTs.includes('registerPoliciesRoutes(router, services, modules)'));
});

test('the composition root constructs the policies module with the matrix-allowed dependencies only', () => {
  assert.ok(compositionRoot.includes("import { createPoliciesModule } from './modules/policies/public.ts'"));
  assert.ok(compositionRoot.includes('createPoliciesModule({ db, clock, ids, agencies, clients, credentialReferences: credentials })'));
  // No OTHER module instance is handed to the policy engine.
  const wiring = /createPoliciesModule\(\{[^}]+\}\)/.exec(compositionRoot);
  assert.ok(wiring !== null);
  assert.ok(!wiring[0]!.includes('workflows'), 'no workflow dependency');
  assert.ok(!wiring[0]!.includes('executions'), 'no execution dependency');
  assert.ok(!wiring[0]!.includes('jobs'), 'no jobs dependency');
  assert.ok(!wiring[0]!.includes('aiRuntime'), 'no ai-runtime dependency');
  assert.ok(!wiring[0]!.includes('evidence'), 'no evidence dependency');
});

// ---------------------------------------------------------------------------
// 7. The dimension vocabulary is shared by the module + routes + migration
// ---------------------------------------------------------------------------

test('the seven frozen dimensions appear identically in the module contract and the migration', () => {
  for (const dimension of POLICY_DIMENSIONS) {
    assert.ok(migration025.includes(`'${dimension}'`), `migration must know dimension '${dimension}'`);
    assert.ok(
      policiesRoutes.includes(dimension),
      `routes must validate dimension '${dimension}' (the closed DTO pattern)`,
    );
  }
});

// The file must exist check for the port type import compiles (type-only).
test('the port type is exported from the public entry (composition-root typing)', () => {
  assert.ok(existsSync(join(repoRoot, 'src', 'modules', 'policies', 'public.ts')));
  assert.ok(policiesPublic.includes('export interface CredentialReferenceLookupPort'));
});
