/**
 * MKT-016 static tests — the Learnings domain is structurally correct in
 * the ACTUAL migration, module contract and route surface (pure static
 * analysis, no DB).
 *
 * Proofs (LEARN-001; spec/implementation-contract.md §17 "Learning
 * contract"; spec/architecture.md §17; spec/evidence-and-experimentation.md
 * §8 + scientific rules; frozen matrix
 * /learnings ──→ /evidence, /experiments, /goals):
 *   1. migration 027 (the MKT-016-reserved number) creates exactly
 *      `learnings` + `learning_relationships` with the required §17
 *      contract fields: immutable opaque id, Client ownership FK, optional
 *      Workspace scope FK, the statement, the applicability conditions
 *      (jsonb), the supporting evidence_refs + experiment_refs (jsonb
 *      arrays), the descriptive confidence, and the SERVER-DERIVED
 *      provenance columns — and NO stored state column (the state is
 *      DERIVED from the relationship history, LEARN-AC-02);
 *   2. learning ownership is EXACTLY the client_id FK (plus the optional
 *      workspace scope FK) — no owner/role/user columns, no learning
 *      column leaking into other frozen tables, no provider-state
 *      structures, no metric-normalization or experiment-machinery
 *      structures;
 *   3. LEARN-AC-02 (static): the relationship-kind CHECK enumerates
 *      exactly the code taxonomy (contradicts/supersedes/retires); the
 *      payload CHECK requires the later learning exactly for
 *      contradiction/supersession and forbids it for retirement; the
 *      no-self CHECK exists; the SUPERSESSION and RETIREMENT fences are
 *      partial unique indexes; learnings AND learning_relationships are
 *      APPEND-ONLY (UPDATE/DELETE triggers on BOTH tables); the
 *      terminal-target trigger rejects relationships against
 *      superseded/retired learnings; the cross-tenant relationship
 *      trigger and the cross-tenant reference triggers exist;
 *   4. the /learnings public contract exposes the canonical owner-context
 *      resolution surface, the server-derived provenance argument type,
 *      the structural /clients + /workspaces ownership ports, the frozen
 *      state/relationship taxonomies, and imports ONLY allowed module
 *      publics (/evidence + /experiments — exactly the used subset of the
 *      frozen matrix /learnings ──→ /evidence, /experiments, /goals; NO
 *      provider SDKs, NO /clients//workspaces imports);
 *   5. no mutation authority exists in the /learnings implementation at
 *      all (the store runs NO UPDATE and NO DELETE — the Learning row is
 *      fully immutable and state changes are NEW relationship rows);
 *   6. the route surface is POST/GET only (no PATCH/PUT/DELETE — there is
 *      no erase path), and the routes are exactly the learnings surface;
 *   7. the DTO discipline is structural: the create + relationship
 *      forbidden authority-field lists include every provenance-shaped
 *      key PLUS the derived-state authority keys (status, supersededBy) —
 *      callers can never inject identity, ownership, provenance or
 *      derived Learning state.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LEARNING_RELATIONSHIP_KINDS,
  LEARNING_STATUSES,
  LEARNING_STATUS_PRECEDENCE,
  TERMINAL_LEARNING_STATUSES,
} from '../../src/modules/learnings/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migration027 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '027_learnings.sql'),
  'utf8',
);
const migration002 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '002_identity_agencies.sql'),
  'utf8',
);
const migration003 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '003_clients.sql'),
  'utf8',
);
const migration004 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '004_workspaces.sql'),
  'utf8',
);
const migration015 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '015_evidence.sql'),
  'utf8',
);
const migration019 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '019_experiments.sql'),
  'utf8',
);
const learningsPublic = readFileSync(
  join(repoRoot, 'src', 'modules', 'learnings', 'public.ts'),
  'utf8',
);
const learningsModule = readFileSync(
  join(repoRoot, 'src', 'modules', 'learnings', 'internal', 'learnings-module.ts'),
  'utf8',
);
const learningsStore = readFileSync(
  join(repoRoot, 'src', 'modules', 'learnings', 'internal', 'learnings-store.ts'),
  'utf8',
);
const learningsRoutes = readFileSync(
  join(repoRoot, 'src', 'api', 'learnings-routes.ts'),
  'utf8',
);

/** Extracts the CREATE TABLE block for `table` from a migration SQL text. */
function createTableBlock(migration: string, table: string): string {
  const marker = `CREATE TABLE IF NOT EXISTS ${table} (`;
  const start = migration.indexOf(marker);
  assert.ok(start >= 0, `migration must create ${table}`);
  const end = migration.indexOf(');', start);
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

test('the learnings table carries the full §17 Learning contract fields (LEARN-001 data contract)', () => {
  const block = createTableBlock(migration027, 'learnings');
  const columns = columnsOf(block);
  for (const required of [
    'learning_id', // immutable opaque identifier (server-generated)
    'client_id', // Client ownership reference (FK) — hard boundary
    'workspace_id', // optional Workspace scope FK (within the Client)
    'statement', // the durable conclusion statement
    'applicability', // the applicability conditions (non-empty jsonb object)
    'evidence_refs', // supporting /evidence record ids (jsonb array)
    'experiment_refs', // supporting /experiments outcome ids (jsonb array)
    'confidence', // the separate descriptive confidence (0..1, nullable)
    'recorded_actor', // SERVER-DERIVED provenance: actor
    'recorded_via', // SERVER-DERIVED provenance: recording system
    'correlation_id', // SERVER-DERIVED provenance: correlation
    'causation_id', // SERVER-DERIVED provenance: causation
    'recorded_at', // SERVER-DERIVED provenance: recording timestamp
  ]) {
    assert.ok(columns.includes(required), `learnings.${required} required`);
  }
  // Client ownership FK backstop; Workspace scope is an OPTIONAL FK. NO
  // on-delete cascade: learning history is never erased.
  assert.ok(
    /client_id\s+uuid\s+NOT NULL REFERENCES clients\(client_id\)/.test(block),
    'Client ownership must be a NOT NULL FK to clients (no cascade — history survives)',
  );
  assert.ok(
    /workspace_id\s+uuid\s+REFERENCES workspaces\(workspace_id\)/.test(block),
    'Workspace scope must be a (nullable) FK to workspaces',
  );
  // THE CENTRAL LEARN-AC-02 DESIGN DECISION: there is deliberately NO
  // stored, mutable state column on the learning row — the §17 state
  // (active/superseded/contradicted/retired) is DERIVED from the
  // relationship history at read time, so contradiction and supersession
  // never rewrite the row.
  for (const forbiddenStateColumn of [
    'status',
    'state',
    'lifecycle_state',
    'superseded_by',
    'supersededby',
    'contradicted',
    'retired',
    'retired_at',
    'updated_at',
    'version',
  ]) {
    assert.ok(
      !columns.includes(forbiddenStateColumn),
      `learnings must NOT carry the stored state column '${forbiddenStateColumn}' (the state is derived — LEARN-AC-02)`,
    );
  }
  // The applicability conditions are a non-empty jsonb object; the
  // reference arrays are jsonb arrays; the confidence is a bounded
  // numeric.
  assert.ok(
    /applicability\s+jsonb\s+NOT NULL CHECK \(jsonb_typeof\(applicability\) = 'object'/.test(block),
    'applicability must be a non-empty jsonb object',
  );
  assert.ok(
    /evidence_refs\s+jsonb\s+NOT NULL DEFAULT '\[\]'::jsonb/.test(block),
    'evidence_refs must be a jsonb array',
  );
  assert.ok(
    /experiment_refs\s+jsonb\s+NOT NULL DEFAULT '\[\]'::jsonb/.test(block),
    'experiment_refs must be a jsonb array',
  );
  assert.ok(
    /confidence\s+numeric\s+CHECK \(confidence IS NULL/.test(block),
    'confidence must be a nullable bounded numeric (the separate descriptive field)',
  );
});

test('learning ownership is exactly the client_id FK + optional workspace scope — no conflation, no provider state, no machinery', () => {
  const learningColumns = columnsOf(createTableBlock(migration027, 'learnings'));
  for (const column of learningColumns) {
    if (column === 'client_id' || column === 'workspace_id') continue;
    assert.ok(
      !/owner|role|user|admin|permission/.test(column),
      `learnings must not carry ownership/role/user columns (found '${column}')`,
    );
  }
  // No metric normalization, no experiment machinery, no evidence classes:
  // the Learning authority owns the Learning record + relationships ONLY.
  for (const column of learningColumns) {
    assert.ok(
      !/provider|sdk|assignment|treatment|observation_run|normaliz/.test(column),
      `learnings must not carry machinery columns (found '${column}')`,
    );
  }
  // The Client→Learning relationship lives ONLY in learnings.client_id:
  // no learning column leaks upward into the frozen tables, and migration
  // 027 must not redefine them.
  for (const [migration, table] of [
    [migration002, 'agencies'],
    [migration002, 'users'],
    [migration003, 'clients'],
    [migration004, 'workspaces'],
    [migration015, 'evidence'],
    [migration019, 'experiments'],
  ] as const) {
    for (const column of columnsOf(createTableBlock(migration, table))) {
      assert.ok(
        !/learning/.test(column),
        `${table}.${column} — the Client→Learning relationship must not leak above /learnings`,
      );
    }
    assert.ok(
      !migration027.includes(`CREATE TABLE IF NOT EXISTS ${table} (`),
      `027 must not redefine the frozen ${table} table`,
    );
  }
  // Exactly the two /learnings tables — no permission engine, no
  // inference-graph runtime structures, no reporting projections, no
  // provider state.
  const createdTables = [...migration027.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    createdTables,
    ['learnings', 'learning_relationships'],
    'migration 027 must create exactly the learnings + learning_relationships tables',
  );
});

test('LEARN-AC-02 (static): relationship rows carry the state changes; the fences, append-only triggers and tenant backstops exist', () => {
  const relationshipsBlock = createTableBlock(migration027, 'learning_relationships');
  for (const required of [
    'relationship_id',
    'from_learning_id',
    'to_learning_id',
    'kind',
    'recorded_actor',
    'recorded_via',
    'correlation_id',
    'causation_id',
    'recorded_at',
  ]) {
    assert.ok(
      columnsOf(relationshipsBlock).includes(required),
      `learning_relationships.${required} required`,
    );
  }
  // The kind CHECK enumerates exactly the code taxonomy.
  for (const kind of LEARNING_RELATIONSHIP_KINDS) {
    assert.ok(relationshipsBlock.includes(`'${kind}'`), `the kind CHECK must enumerate '${kind}'`);
  }
  assert.ok(!relationshipsBlock.includes("'replaces'"), 'no free-string relationship kinds');

  // The payload CHECK: the later learning rides EXACTLY the
  // contradiction/supersession; retirement carries none.
  const payloadConstraint = relationshipsBlock
    .slice(relationshipsBlock.indexOf('CONSTRAINT learning_relationship_payload'))
    .replace(/\s+/g, ' ');
  assert.ok(
    payloadConstraint.includes(
      "(kind IN ('contradicts', 'supersedes') AND to_learning_id IS NOT NULL)",
    ),
    'contradiction/supersession must carry the later learning',
  );
  assert.ok(
    payloadConstraint.includes("(kind = 'retires' AND to_learning_id IS NULL)"),
    'retirement must carry no later learning',
  );
  // The no-self CHECK.
  assert.ok(
    /CONSTRAINT learning_relationship_no_self/.test(relationshipsBlock),
    'the no-self CHECK must exist (a learning cannot relate to itself)',
  );
  assert.ok(
    /to_learning_id <> from_learning_id/.test(relationshipsBlock),
    'the no-self CHECK must compare the ids',
  );

  // THE FENCES (single supersession, single retirement).
  assert.ok(
    /CREATE UNIQUE INDEX IF NOT EXISTS learning_supersession_fence\s*ON learning_relationships \(from_learning_id\) WHERE kind = 'supersedes'/.test(
      migration027,
    ),
    'the supersession fence must be a partial unique index over the target per superseding kind',
  );
  assert.ok(
    /CREATE UNIQUE INDEX IF NOT EXISTS learning_retirement_fence\s*ON learning_relationships \(from_learning_id\) WHERE kind = 'retires'/.test(
      migration027,
    ),
    'the retirement fence must be a partial unique index over the target',
  );

  // APPEND-ONLY on BOTH tables: UPDATE and DELETE triggers reject every
  // mutation — the original learning row is byte-stable forever.
  for (const table of ['learnings', 'learning_relationships']) {
    const function_ = `${table}_append_only`;
    assert.ok(migration027.includes(function_), `the ${table} append-only trigger function must exist`);
    assert.ok(
      migration027.includes(`${function_}_update_trigger`),
      `the ${table} BEFORE UPDATE trigger must be wired`,
    );
    assert.ok(
      migration027.includes(`${function_}_delete_trigger`),
      `the ${table} BEFORE DELETE trigger must be wired`,
    );
  }
  assert.ok(
    migration027.includes('learnings are append-only'),
    'the learnings append-only rejection must be named',
  );
  assert.ok(
    migration027.includes('learning relationships are append-only'),
    'the relationships append-only rejection must be named',
  );

  // TERMINAL-TARGET backstop: relationships against superseded/retired
  // learnings are rejected at the DB level.
  assert.ok(
    migration027.includes('learning_relationship_legal'),
    'the relationship-legality trigger must exist',
  );
  const legalityBody = migration027.slice(
    migration027.indexOf('CREATE OR REPLACE FUNCTION learning_relationship_legal'),
    migration027.indexOf('$$ LANGUAGE plpgsql;', migration027.indexOf('learning_relationship_legal')),
  );
  assert.ok(
    legalityBody.includes("r.kind = 'supersedes'") && legalityBody.includes('history is terminal'),
    'the trigger must reject targeting an already-superseded learning',
  );
  assert.ok(
    legalityBody.includes("r.kind = 'retires'") && legalityBody.includes('already retired'),
    'the trigger must reject targeting an already-retired learning',
  );
  // Cross-tenant relationships are rejected.
  assert.ok(
    legalityBody.includes('cross-tenant learning relationships are rejected'),
    'the cross-tenant relationship rejection must be named (module error classification matches this marker)',
  );

  // WORKSPACE-WITHIN-CLIENT scope fence.
  assert.ok(
    migration027.includes('learning_workspace_within_client'),
    'the workspace-within-client trigger must exist',
  );
  const scopeBody = migration027.slice(
    migration027.indexOf('CREATE OR REPLACE FUNCTION learning_workspace_within_client'),
    migration027.indexOf(
      '$$ LANGUAGE plpgsql;',
      migration027.indexOf('learning_workspace_within_client'),
    ),
  );
  assert.ok(
    scopeBody.includes('w.workspace_id = NEW.workspace_id AND w.client_id = NEW.client_id'),
    'the trigger must require the workspace to belong to the record client',
  );

  // CROSS-TENANT supporting-reference fences (evidence + experiments).
  assert.ok(
    migration027.includes('learning_refs_same_client'),
    'the supporting-reference trigger must exist',
  );
  const refsBody = migration027.slice(
    migration027.indexOf('CREATE OR REPLACE FUNCTION learning_refs_same_client'),
    migration027.indexOf('$$ LANGUAGE plpgsql;', migration027.indexOf('learning_refs_same_client')),
  );
  assert.ok(
    refsBody.includes('jsonb_array_elements_text(NEW.evidence_refs)'),
    'the trigger must fence EVERY cited evidence ref',
  );
  assert.ok(
    refsBody.includes('jsonb_array_elements_text(NEW.experiment_refs)'),
    'the trigger must fence EVERY cited experiment ref',
  );
  assert.ok(
    refsBody.includes('cross-tenant evidence linkage is rejected'),
    'the cross-tenant evidence rejection must be named',
  );
  assert.ok(
    refsBody.includes('cross-tenant experiment linkage is rejected'),
    'the cross-tenant experiment rejection must be named',
  );
});

test('the /learnings public contract exposes canonical owner resolution over allowed dependencies only (frozen matrix)', () => {
  assert.ok(
    learningsPublic.includes('export interface LearningOwnerContext'),
    'LearningOwnerContext must be part of the public contract',
  );
  assert.ok(
    learningsPublic.includes('resolveLearningOwnership'),
    'canonical ownership resolution must be part of the module API',
  );
  assert.ok(
    learningsPublic.includes("kind: 'learning'"),
    'the owner context must carry the learning-scoped scope shape',
  );
  assert.ok(
    learningsPublic.includes('export function composeLearningOwnerContext'),
    'the pure composer must be exported',
  );
  // Provenance is a separate, server-derived input dimension.
  assert.ok(
    learningsPublic.includes('export interface LearningProvenance'),
    'the server-derived provenance argument type must be part of the contract',
  );
  // The /clients + /workspaces ownership resolution arrives as STRUCTURAL
  // PORTS (the frozen matrix allows only /evidence, /experiments, /goals
  // imports from /learnings — the ports keep the required resolution
  // server-side without a forbidden import).
  assert.ok(
    learningsPublic.includes('export interface ClientOwnershipResolutionPort'),
    'the structural /clients ownership port must be declared',
  );
  assert.ok(
    learningsPublic.includes('export interface WorkspaceOwnershipResolutionPort'),
    'the structural /workspaces ownership port must be declared',
  );
  // The frozen taxonomies are part of the module contract.
  assert.ok(
    learningsPublic.includes('export const LEARNING_STATUSES'),
    'the frozen state taxonomy must be exported',
  );
  assert.ok(
    learningsPublic.includes('export const LEARNING_RELATIONSHIP_KINDS'),
    'the frozen relationship-kind taxonomy must be exported',
  );

  // Dependency matrix: /learnings ──→ /evidence, /experiments, /goals. The
  // public entry must not import any other module (a subset is fine —
  // /goals stays an unused allowed direction).
  const imports = [...learningsPublic.matchAll(/from '\.\.\/([\w-]+)\/public\.ts'/g)].map(
    (match) => match[1]!,
  );
  for (const imported of [...new Set(imports)]) {
    assert.ok(
      ['evidence', 'experiments', 'goals'].includes(imported),
      `public.ts may only import allowed module publics (found '${imported}'; frozen matrix: /learnings ──→ /evidence, /experiments, /goals)`,
    );
  }
  assert.deepEqual(
    [...new Set(imports)].sort(),
    ['evidence', 'experiments'],
    'public.ts imports exactly the /evidence + /experiments public contracts (the used allowed dependencies)',
  );
  for (const forbidden of [
    'clients',
    'workspaces',
    'agencies',
    'auth',
    'executions',
    'workflows',
    'metrics',
    'integrations',
    'extensions',
    'ai-runtime',
    'jobs',
    'policies',
  ]) {
    assert.ok(
      !learningsPublic.includes(`from '../${forbidden}/`),
      `public.ts must not import the /${forbidden} module (frozen matrix)`,
    );
  }
  // No provider SDKs anywhere in the module.
  for (const source of [learningsPublic, learningsModule, learningsStore]) {
    assert.ok(!/from 'openai|anthropic|google|@ai-sdk|LangChain/i.test(source), 'no provider SDK imports');
  }
});

test('no mutation authority exists in the /learnings implementation at all (state changes are NEW rows)', () => {
  // The store runs NO UPDATE and NO DELETE on learnings — the row is
  // written exactly once and stays byte-stable forever (LEARN-AC-02).
  assert.equal(
    [...learningsStore.matchAll(/UPDATE learnings\b/g)].length,
    0,
    'the store must never UPDATE learning rows',
  );
  assert.equal(
    [...learningsStore.matchAll(/DELETE FROM learnings\b/g)].length,
    0,
    'the store must never DELETE learning rows',
  );
  // The relationship history is append-only: no UPDATE/DELETE.
  assert.ok(
    !/UPDATE learning_relationships|DELETE FROM learning_relationships/.test(learningsStore),
    'the implementation must never rewrite the relationship history',
  );
  // The store derives the state at READ time (the SELECT-side CASE) —
  // never at write time.
  assert.ok(
    learningsStore.includes('AS derived_status'),
    'the store must derive the status in the read SELECT (never stored)',
  );
  assert.ok(
    learningsStore.includes('AS superseded_by'),
    'the store must derive the successor pointer in the read SELECT (never stored)',
  );
  // The module validates supporting references THROUGH the owning
  // authorities' public contracts (getEvidence/getExperiment) — no direct
  // table reach-in, no internals import.
  assert.ok(
    learningsModule.includes('await evidence.getEvidence('),
    'evidence references validate through the /evidence public contract',
  );
  assert.ok(
    learningsModule.includes('await experiments.getExperiment('),
    'experiment references validate through the /experiments public contract',
  );
  // No metric normalization, no experiment machinery, no evidence classes
  // — the Learning authority owns the Learning record + relationships ONLY.
  for (const source of [learningsModule, learningsStore]) {
    assert.ok(
      !/normalizeMetric|applyTransition|appendEvidence\(|classifyEvidence|createExperiment/i.test(
        source,
      ),
      'the learnings module runs no other authority\'s machinery',
    );
  }
});

test('the route surface is POST/GET registrations only, and exactly the learnings surface (LEARN-001)', () => {
  const registrations = [
    ...learningsRoutes.matchAll(/router\.add\(\s*'([A-Z]+)',\s*'([^']+)'/g),
  ].map((match) => [match[1]!, match[2]!] as const);
  assert.deepEqual(
    registrations,
    [
      ['POST', '/api/clients/:clientId/learnings'],
      ['GET', '/api/clients/:clientId/learnings'],
      ['GET', '/api/learnings/:learningId'],
      ['POST', '/api/learnings/:learningId/relationships'],
      ['GET', '/api/learnings/:learningId/relationships'],
    ],
    'the learnings surface is exactly append/list/read/relate/history',
  );
  for (const [method] of registrations) {
    assert.ok(
      method === 'POST' || method === 'GET',
      `no mutation verb other than the append/relationship commands (found ${method})`,
    );
  }
  // No PATCH/PUT/DELETE anywhere (there is no erase path: "Learning is
  // never retroactive deletion of evidence").
  assert.ok(!/'(PATCH|PUT|DELETE)'/.test(learningsRoutes), 'no PATCH/PUT/DELETE routes');
  // No second permission/role engine in the routes (authorization composes
  // the /agencies membership authority).
  assert.ok(
    !/role.*engine|permissionTable|canAccess|hasPermission/.test(learningsRoutes),
    'no alternate permission authority in the routes',
  );
  // Provenance is built server-side in the routes (never from the body).
  assert.ok(
    learningsRoutes.includes('function serverProvenance('),
    'the routes must build provenance server-side',
  );
});

test('the DTO discipline is structural: provenance AND derived-state authority are caller-rejected on BOTH write surfaces', () => {
  const createAuthorityList = learningsRoutes.slice(
    learningsRoutes.indexOf('const LEARNING_CREATE_AUTHORITY_FIELDS'),
    learningsRoutes.indexOf('] as const;', learningsRoutes.indexOf('const LEARNING_CREATE_AUTHORITY_FIELDS')),
  );
  for (const authorityField of [
    'learningId',
    'clientId',
    'agencyId',
    'status',
    'supersededBy',
    'provenance',
    'actor',
    'recordedActor',
    'recordedVia',
    'correlationId',
    'causationId',
    'recordedAt',
    'secret',
    'apiKey',
  ]) {
    assert.ok(
      createAuthorityList.includes(`'${authorityField}'`),
      `the create DTO must reject the authority field '${authorityField}'`,
    );
  }
  const relationshipAuthorityList = learningsRoutes.slice(
    learningsRoutes.indexOf('const LEARNING_RELATIONSHIP_AUTHORITY_FIELDS'),
    learningsRoutes.indexOf(
      '] as const;',
      learningsRoutes.indexOf('const LEARNING_RELATIONSHIP_AUTHORITY_FIELDS'),
    ),
  );
  for (const authorityField of [
    'relationshipId',
    'fromLearningId',
    'status',
    'supersededBy',
    'provenance',
    'actor',
    'recordedAt',
    'correlationId',
    'recordedVia',
  ]) {
    assert.ok(
      relationshipAuthorityList.includes(`'${authorityField}'`),
      `the relationship DTO must reject the authority field '${authorityField}'`,
    );
  }
});

test('the frozen state/kind taxonomies and terminal set are structurally consistent (code ↔ migration)', () => {
  // The code taxonomies match the migration CHECK literals exactly.
  const learningsBlock = createTableBlock(migration027, 'learnings');
  const relationshipsBlock = createTableBlock(migration027, 'learning_relationships');
  for (const status of LEARNING_STATUSES) {
    assert.ok(
      migration027.includes(`'${status}'`),
      `the migration must know the frozen state '${status}'`,
    );
  }
  for (const kind of LEARNING_RELATIONSHIP_KINDS) {
    assert.ok(
      relationshipsBlock.includes(`'${kind}'`),
      `the migration kind CHECK must enumerate '${kind}'`,
    );
  }
  // The terminal set and the precedence cover the taxonomy exactly once.
  assert.deepEqual(
    [...LEARNING_STATUS_PRECEDENCE].sort(),
    [...LEARNING_STATUSES].sort(),
    'the precedence covers every frozen state exactly once',
  );
  assert.deepEqual(
    [...TERMINAL_LEARNING_STATUSES].sort(),
    ['retired', 'superseded'],
    'exactly superseded and retired are terminal',
  );
  // The derived-status SELECT encodes the same precedence
  // (superseded > retired > contradicted > active).
  const derivedCase = learningsStore.slice(
    learningsStore.indexOf('CASE'),
    learningsStore.indexOf('END AS derived_status'),
  );
  const supersededAt = derivedCase.indexOf("'superseded'");
  const retiredAt = derivedCase.indexOf("'retired'");
  const contradictedAt = derivedCase.indexOf("'contradicted'");
  const activeAt = derivedCase.indexOf("'active'");
  assert.ok(supersededAt >= 0 && retiredAt > supersededAt, 'superseded precedes retired in the derivation');
  assert.ok(retiredAt >= 0 && contradictedAt > retiredAt, 'retired precedes contradicted in the derivation');
  assert.ok(contradictedAt >= 0 && activeAt > contradictedAt, 'contradicted precedes active in the derivation');
  assert.ok(!learningsBlock.includes("'active'"), 'the learnings table stores no state literal (derived only)');
});
