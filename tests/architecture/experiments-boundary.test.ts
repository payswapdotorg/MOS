/**
 * MKT-015 static tests — the Experiments domain is structurally correct in
 * the ACTUAL migration, module contract and route surface (pure static
 * analysis, no DB).
 *
 * Proofs (EXP-001; spec/implementation-contract.md §16 "Experiment
 * contract"; spec/state-machines.md "Experiment";
 * spec/evidence-and-experimentation.md; frozen matrix
 * /experiments ──→ /evidence, /metrics, /goals):
 *   1. migration 019 (the MKT-015-reserved number) creates exactly
 *      `experiments` + `experiment_transitions` with the required §16
 *      contract fields: immutable opaque id, Client ownership FK, optional
 *      Workspace scope FK, hypothesis, decision_target, population_unit,
 *      treatment AND comparison, assignment_method, design_type,
 *      primary_metric (jsonb identity), guardrails (jsonb array),
 *      analysis_method (+version), expected_direction, start/stop
 *      criteria, minimum_evidence_requirement, the DECLARED
 *      uncertainty_representation, the lifecycle status, the result_state,
 *      the resulting_decision and the SERVER-DERIVED provenance columns;
 *   2. experiment ownership is EXACTLY the client_id FK (plus the optional
 *      workspace scope FK) — no owner/role/user columns, no experiment
 *      column leaking into other frozen tables, no provider-state
 *      structures, no metric-observation FK (the primary metric is BY
 *      NAME + DIMENSIONS, never a provider metric id or observation id);
 *   3. EXP-AC-02 (static): the DB result_state CHECK enumerates exactly
 *      the code taxonomy — the CAUSAL values ('causal_supported',
 *      'causal_not_supported') are DISTINCT enumerated literals from
 *      'attribution'/'observation' — and the CAUSAL EVIDENCE STANDARD is a
 *      row-level CHECK on BOTH tables (a causal result state requires a
 *      causal-capable design); the transition-history edge CHECK encodes
 *      the exact frozen state machine;
 *   4. the DECLARED-DESIGN IMMUTABILITY trigger rejects design-column
 *      rewrites; the LEGAL-SUCCESSOR trigger rejects illegal status
 *      transitions; the transitions table is APPEND-ONLY (UPDATE/DELETE
 *      triggers); the workspace-within-client scope trigger and the
 *      cross-tenant evidence-citation trigger exist;
 *   5. the /experiments public contract exposes the canonical
 *      owner-context resolution surface, the server-derived provenance
 *      argument type and the structural /clients + /workspaces ownership
 *      ports, and imports ONLY allowed module publics (/evidence — a
 *      subset of the frozen matrix /experiments ──→ /evidence, /metrics,
 *      /goals; NO provider SDKs, NO /clients//workspaces imports);
 *   6. no mutation authority exists in the /experiments implementation
 *      beyond the lifecycle columns (the store's ONLY UPDATE touches
 *      status/result_state/resulting_decision/concluded_at — the design
 *      columns are never rewritten);
 *   7. the route surface is POST/GET only (no PATCH/PUT/DELETE — the
 *      design is immutable and lifecycle moves only through the explicit
 *      transitions), and the routes are exactly the experiments surface;
 *   8. the DTO discipline is structural: the create + transition forbidden
 *      authority-field lists include every provenance-shaped key PLUS the
 *      lifecycle/result authority keys (status, resultState, decision) —
 *      callers can never inject identity, ownership, provenance, lifecycle
 *      state or results.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXPERIMENT_DESIGN_TYPES,
  EXPERIMENT_EXPECTED_DIRECTIONS,
  EXPERIMENT_RESULT_STATES,
  EXPERIMENT_STATUSES,
  EXPERIMENT_TRANSITIONS,
  EXPERIMENT_TRANSITION_TABLE,
  EXPERIMENT_UNCERTAINTY_REPRESENTATIONS,
} from '../../src/modules/experiments/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migration019 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '019_experiments.sql'),
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
const migration018 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '018_metrics.sql'),
  'utf8',
);
const experimentsPublic = readFileSync(
  join(repoRoot, 'src', 'modules', 'experiments', 'public.ts'),
  'utf8',
);
const experimentsModule = readFileSync(
  join(repoRoot, 'src', 'modules', 'experiments', 'internal', 'experiments-module.ts'),
  'utf8',
);
const experimentsStore = readFileSync(
  join(repoRoot, 'src', 'modules', 'experiments', 'internal', 'experiments-store.ts'),
  'utf8',
);
const experimentsRoutes = readFileSync(
  join(repoRoot, 'src', 'api', 'experiments-routes.ts'),
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

test('the experiments table carries the full §16 Experiment contract fields (EXP-001 data contract)', () => {
  const columns = columnsOf(createTableBlock(migration019, 'experiments'));
  for (const required of [
    'experiment_id', // immutable opaque identifier (server-generated)
    'client_id', // Client ownership reference (FK) — hard boundary
    'workspace_id', // optional Workspace scope FK (within the Client)
    'hypothesis', // the declared hypothesis
    'decision_target', // the decision being informed (§16 "decision target")
    'population_unit', // population/unit
    'treatment', // treatment
    'comparison', // comparison (SEPARATE column — treatment/comparison)
    'assignment_method', // assignment metadata
    'design_type', // the declared design type (closed 5-value set)
    'primary_metric', // primary metric identity (name + dimensions, jsonb)
    'guardrails', // guardrail metric identities (jsonb array)
    'analysis_method', // analysis method
    'analysis_method_version', // analysis method version (§16 "analysis method/version")
    'expected_direction', // expected direction where applicable
    'start_criteria', // start conditions where applicable
    'stop_criteria', // stop criteria (§16 "stop criteria")
    'minimum_evidence_requirement', // the declared minimum evidence requirement
    'uncertainty_representation', // the DECLARED uncertainty representation
    'status', // the lifecycle state machine column
    'result_state', // the conclusion-type taxonomy column
    'resulting_decision', // the resulting decision (null while undecided)
    'concluded_at', // the conclusion timestamp
    'recorded_actor', // SERVER-DERIVED provenance: actor
    'recorded_via', // SERVER-DERIVED provenance: recording system
    'correlation_id', // SERVER-DERIVED provenance: correlation
    'causation_id', // SERVER-DERIVED provenance: causation
    'recorded_at', // SERVER-DERIVED provenance: recording timestamp
  ]) {
    assert.ok(columns.includes(required), `experiments.${required} required`);
  }
  // Client ownership FK backstop; Workspace scope is an OPTIONAL FK. NO
  // on-delete cascade: declared design history is never erased.
  assert.ok(
    /client_id\s+uuid\s+NOT NULL REFERENCES clients\(client_id\)/.test(
      createTableBlock(migration019, 'experiments'),
    ),
    'Client ownership must be a NOT NULL FK to clients (no cascade — history survives)',
  );
  assert.ok(
    /workspace_id\s+uuid\s+REFERENCES workspaces\(workspace_id\)/.test(
      createTableBlock(migration019, 'experiments'),
    ),
    'Workspace scope must be a (nullable) FK to workspaces',
  );
  // The initial lifecycle state is server-chosen, never caller-supplied.
  assert.ok(
    /status\s+text\s+NOT NULL DEFAULT 'draft'/.test(createTableBlock(migration019, 'experiments')),
    "status must default to 'draft' (server-chosen initial lifecycle)",
  );
  assert.ok(
    /result_state\s+text\s+NOT NULL DEFAULT 'undecided'/.test(
      createTableBlock(migration019, 'experiments'),
    ),
    "result_state must default to 'undecided' (the initial conclusion state)",
  );
});

test('experiment ownership is exactly the client_id FK + optional workspace scope — no conflation, no provider state, no observation FK', () => {
  const experimentColumns = columnsOf(createTableBlock(migration019, 'experiments'));
  for (const column of experimentColumns) {
    if (column === 'client_id' || column === 'workspace_id') continue;
    assert.ok(
      !/owner|role|user|admin|permission/.test(column),
      `experiments must not carry ownership/role/user columns (found '${column}')`,
    );
  }
  // The primary metric is BY NAME + DIMENSIONS: there is deliberately NO
  // metric_observations FK and NO provider-metric-id column — experiments
  // are declared before observations exist.
  for (const column of experimentColumns) {
    assert.ok(
      !/observation|provider|metric_id/.test(column),
      `experiments must not carry observation/provider-metric columns (found '${column}')`,
    );
  }
  // The Client→Experiment relationship lives ONLY in
  // experiments.client_id: no experiment column leaks upward into the
  // frozen tables, and migration 019 must not redefine them.
  for (const [migration, table] of [
    [migration002, 'agencies'],
    [migration002, 'users'],
    [migration003, 'clients'],
    [migration004, 'workspaces'],
    [migration015, 'evidence'],
    [migration018, 'metric_observations'],
  ] as const) {
    for (const column of columnsOf(createTableBlock(migration, table))) {
      assert.ok(
        !/experiment/.test(column),
        `${table}.${column} — the Client→Experiment relationship must not leak above /experiments`,
      );
    }
    assert.ok(
      !migration019.includes(`CREATE TABLE IF NOT EXISTS ${table} (`),
      `019 must not redefine the frozen ${table} table`,
    );
  }
  // Exactly the two /experiments tables — no permission engine, no
  // assignment/traffic-split runtime structures, no learning structures
  // (MKT-016), no provider state.
  const createdTables = [...migration019.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    createdTables,
    ['experiments', 'experiment_transitions'],
    'migration 019 must create exactly the experiments + experiment_transitions tables',
  );
});

test('EXP-AC-02 (static): the DB result-state CHECK is the closed code taxonomy with CAUSAL DISTINCT from attribution/observation; the causal evidence standard is a row CHECK on BOTH tables', () => {
  const experimentsBlock = createTableBlock(migration019, 'experiments');
  // Every code-taxonomy literal is enumerated in the DB CHECK (one set,
  // never drifting).
  for (const resultState of EXPERIMENT_RESULT_STATES) {
    assert.ok(
      experimentsBlock.includes(`'${resultState}'`),
      `the result_state CHECK must enumerate '${resultState}'`,
    );
  }
  // The causal values are DISTINCT enumerated literals — never shared with
  // the attribution/observation values, never a free string.
  for (const causal of ['causal_supported', 'causal_not_supported']) {
    assert.ok(experimentsBlock.includes(`'${causal}'`), `'${causal}' must be its own DB literal`);
  }
  for (const nonCausal of ['attribution', 'observation', 'inconclusive']) {
    assert.ok(experimentsBlock.includes(`'${nonCausal}'`), `'${nonCausal}' must be its own DB literal`);
    assert.notEqual(causalLiteral(nonCausal), causalLiteral('causal_supported'));
  }
  // THE CAUSAL EVIDENCE STANDARD as a database backstop: a causal result
  // state can only coexist with a causal-capable design — on BOTH the
  // experiments row and the transition-history row.
  assert.ok(
    /CONSTRAINT experiments_causal_standard CHECK/i.test(experimentsBlock),
    'the causal-evidence-standard CHECK must exist on experiments',
  );
  const causalConstraint = experimentsBlock.slice(
    experimentsBlock.indexOf('CONSTRAINT experiments_causal_standard'),
  );
  assert.ok(
    causalConstraint.includes("result_state NOT IN ('causal_supported', 'causal_not_supported')"),
    'the CHECK must allow non-causal result states on every design',
  );
  assert.ok(
    causalConstraint.includes(
      "OR design_type IN ('randomized', 'controlled_comparison', 'quasi_experimental')",
    ),
    'the CHECK must require a causal-capable design for causal result states',
  );

  // The design-type CHECK is the frozen 5-value set.
  for (const designType of EXPERIMENT_DESIGN_TYPES) {
    assert.ok(experimentsBlock.includes(`'${designType}'`), `design_type CHECK must enumerate '${designType}'`);
  }
  // The uncertainty-representation and expected-direction CHECKs.
  for (const representation of EXPERIMENT_UNCERTAINTY_REPRESENTATIONS) {
    assert.ok(
      experimentsBlock.includes(`'${representation}'`),
      `uncertainty_representation CHECK must enumerate '${representation}'`,
    );
  }
  for (const direction of EXPERIMENT_EXPECTED_DIRECTIONS) {
    assert.ok(experimentsBlock.includes(`'${direction}'`), `expected_direction CHECK must enumerate '${direction}'`);
  }

  // The transition table carries the result-state taxonomy too (the
  // conclusion row is a first-class retained record).
  const transitionsBlock = createTableBlock(migration019, 'experiment_transitions');
  assert.ok(
    /conclusion\s+jsonb/.test(transitionsBlock),
    'the transition row must retain the conclusion payload as jsonb',
  );
  // The frozen state machine edges are a row CHECK on the history table.
  for (const transition of EXPERIMENT_TRANSITIONS) {
    assert.ok(
      transitionsBlock.includes(`'${transition}'`),
      `the transition CHECK must enumerate '${transition}'`,
    );
  }
  for (const status of EXPERIMENT_STATUSES) {
    assert.ok(transitionsBlock.includes(`'${status}'`), `the status CHECKs must enumerate '${status}'`);
  }
  const edgeConstraint = transitionsBlock
    .slice(transitionsBlock.indexOf('CONSTRAINT experiment_transition_edges'))
    .replace(/\s+/g, ' ');
  for (const transition of EXPERIMENT_TRANSITIONS) {
    const edge = EXPERIMENT_TRANSITION_TABLE[transition];
    assert.ok(
      edgeConstraint.includes(
        `(transition = '${transition}' AND from_status = '${edge.from}' AND to_status = '${edge.to}')`,
      ),
      `the edge CHECK must encode ${transition}: ${edge.from} → ${edge.to}`,
    );
  }
  // The conclusion payload rides ONLY the conclude transition.
  assert.ok(
    /experiment_transition_payload/.test(transitionsBlock),
    'the payload CHECK (conclusion iff conclude) must exist',
  );
});

function causalLiteral(resultState: string): string {
  return `'${resultState}'`;
}

test('the design-immutability, legal-successor, append-only and tenant-fence triggers exist (migration 019 backstops)', () => {
  // DECLARED-DESIGN IMMUTABILITY: any design-column rewrite is rejected.
  assert.ok(
    migration019.includes('experiment_design_immutable'),
    'the design-immutability trigger must exist',
  );
  const immutableBody = migration019.slice(
    migration019.indexOf('CREATE OR REPLACE FUNCTION experiment_design_immutable'),
    migration019.indexOf('$$ LANGUAGE plpgsql;', migration019.indexOf('experiment_design_immutable')),
  );
  for (const designColumn of [
    'hypothesis',
    'decision_target',
    'population_unit',
    'treatment',
    'comparison',
    'assignment_method',
    'design_type',
    'primary_metric',
    'guardrails',
    'analysis_method',
    'stop_criteria',
    'minimum_evidence_requirement',
    'uncertainty_representation',
  ]) {
    assert.ok(
      immutableBody.includes(`NEW.${designColumn}`),
      `the immutability trigger must fence the '${designColumn}' design column`,
    );
  }
  assert.ok(
    immutableBody.includes('the experiment declared design is immutable'),
    'the immutability rejection must be named (module error classification matches this marker)',
  );

  // LEGAL-SUCCESSOR guard: the frozen state machine as a DB trigger.
  assert.ok(
    migration019.includes('experiment_status_transition_guard'),
    'the legal-successor trigger must exist',
  );
  const guardBody = migration019.slice(
    migration019.indexOf('CREATE OR REPLACE FUNCTION experiment_status_transition_guard'),
    migration019.indexOf('$$ LANGUAGE plpgsql;', migration019.indexOf('experiment_status_transition_guard')),
  );
  for (const [from, to] of [
    ['draft', 'ready'],
    ['ready', 'running'],
    ['running', 'analyzing'],
    ['analyzing', 'concluded'],
    ['running', 'stopped'],
    ['running', 'invalidated'],
  ] as const) {
    assert.ok(
      guardBody.includes(`'${from}'`) && guardBody.includes(`'${to}'`),
      `the guard must allow ${from} → ${to}`,
    );
  }
  assert.ok(
    guardBody.includes('illegal experiment status transition'),
    'the illegal-transition rejection must be named (module error classification matches this marker)',
  );

  // APPEND-ONLY transition history: UPDATE and DELETE are rejected.
  assert.ok(
    migration019.includes('experiment_transitions_append_only'),
    'the append-only trigger function must exist',
  );
  assert.ok(
    migration019.includes('experiment_transitions_append_only_update_trigger'),
    'the BEFORE UPDATE trigger must be wired',
  );
  assert.ok(
    migration019.includes('experiment_transitions_append_only_delete_trigger'),
    'the BEFORE DELETE trigger must be wired',
  );

  // WORKSPACE-WITHIN-CLIENT scope fence.
  assert.ok(
    migration019.includes('experiment_workspace_within_client'),
    'the workspace-within-client trigger must exist',
  );
  const scopeBody = migration019.slice(
    migration019.indexOf('CREATE OR REPLACE FUNCTION experiment_workspace_within_client'),
    migration019.indexOf('$$ LANGUAGE plpgsql;', migration019.indexOf('experiment_workspace_within_client')),
  );
  assert.ok(
    scopeBody.includes('w.workspace_id = NEW.workspace_id AND w.client_id = NEW.client_id'),
    'the trigger must require the workspace to belong to the record client',
  );

  // CROSS-TENANT evidence-citation fence on the conclusion payload.
  assert.ok(
    migration019.includes('experiment_conclusion_evidence_refs_same_client'),
    'the evidence-citation trigger must exist',
  );
  const citationBody = migration019.slice(
    migration019.indexOf('CREATE OR REPLACE FUNCTION experiment_conclusion_evidence_refs_same_client'),
    migration019.indexOf('$$ LANGUAGE plpgsql;', migration019.indexOf('experiment_conclusion_evidence_refs_same_client')),
  );
  assert.ok(
    citationBody.includes("jsonb_array_elements_text(NEW.conclusion -> 'evidenceRefs')"),
    'the trigger must fence EVERY cited evidence ref in the conclusion payload',
  );
  assert.ok(
    citationBody.includes('cross-tenant evidence linkage is rejected'),
    'the cross-tenant rejection must be named (module error classification matches this marker)',
  );
});

test('the /experiments public contract exposes canonical owner resolution over allowed dependencies only (frozen matrix)', () => {
  assert.ok(
    experimentsPublic.includes('export interface ExperimentOwnerContext'),
    'ExperimentOwnerContext must be part of the public contract',
  );
  assert.ok(
    experimentsPublic.includes('resolveExperimentOwnership'),
    'canonical ownership resolution must be part of the module API',
  );
  assert.ok(
    experimentsPublic.includes("kind: 'experiment'"),
    'the owner context must carry the experiment-scoped scope shape',
  );
  assert.ok(
    experimentsPublic.includes('export function composeExperimentOwnerContext'),
    'the pure composer must be exported',
  );
  // Provenance is a separate, server-derived input dimension.
  assert.ok(
    experimentsPublic.includes('export interface ExperimentProvenance'),
    'the server-derived provenance argument type must be part of the contract',
  );
  // The /clients + /workspaces ownership resolution arrives as STRUCTURAL
  // PORTS (the frozen matrix allows only /evidence, /metrics, /goals
  // imports from /experiments — the ports keep the required resolution
  // server-side without a forbidden import).
  assert.ok(
    experimentsPublic.includes('export interface ClientOwnershipResolutionPort'),
    'the structural /clients ownership port must be declared',
  );
  assert.ok(
    experimentsPublic.includes('export interface WorkspaceOwnershipResolutionPort'),
    'the structural /workspaces ownership port must be declared',
  );
  // EXP-AC-02 (contract level): the causal and non-causal conclusion types
  // are DISTINCT exported type-level sets.
  assert.ok(
    experimentsPublic.includes('export type CausalResultState'),
    'the causal conclusion types must be a distinct exported type',
  );
  assert.ok(
    experimentsPublic.includes('export type NonCausalResultState'),
    'the attribution/observation conclusion types must be a distinct exported type',
  );
  // The causal evidence standard is part of the module contract.
  assert.ok(
    experimentsPublic.includes('export const CAUSAL_EVIDENCE_STANDARD'),
    'the configured causal evidence standard must be exported',
  );

  // Dependency matrix: /experiments ──→ /evidence, /metrics, /goals. The
  // public entry must not import any other module (a subset is fine —
  // /metrics and /goals stay unused allowed directions).
  const imports = [...experimentsPublic.matchAll(/from '\.\.\/([\w-]+)\/public\.ts'/g)].map(
    (match) => match[1]!,
  );
  for (const imported of [...new Set(imports)]) {
    assert.ok(
      ['evidence', 'metrics', 'goals'].includes(imported),
      `public.ts may only import allowed module publics (found '${imported}'; frozen matrix: /experiments ──→ /evidence, /metrics, /goals)`,
    );
  }
  assert.deepEqual(
    [...new Set(imports)].sort(),
    ['evidence'],
    'public.ts imports exactly the /evidence public contract (the used allowed dependency)',
  );
  for (const forbidden of [
    'clients',
    'workspaces',
    'agencies',
    'auth',
    'executions',
    'workflows',
    'integrations',
    'extensions',
    'ai-runtime',
    'jobs',
    'policies',
  ]) {
    assert.ok(
      !experimentsPublic.includes(`from '../${forbidden}/`),
      `public.ts must not import the /${forbidden} module (frozen matrix)`,
    );
  }
  // No provider SDKs anywhere in the module.
  for (const source of [experimentsPublic, experimentsModule, experimentsStore]) {
    assert.ok(!/from 'openai|anthropic|google|@ai-sdk|LangChain/i.test(source), 'no provider SDK imports');
  }
});

test('no design-mutation authority exists in the /experiments implementation (only lifecycle columns change)', () => {
  // The store's ONLY UPDATE statement touches exactly the lifecycle
  // columns; every design column is written exactly once (INSERT).
  const updateStatements = [...experimentsStore.matchAll(/UPDATE experiments[^;]*;/gs)];
  assert.equal(
    updateStatements.length,
    1,
    'the store must run exactly ONE UPDATE statement (the lifecycle transition)',
  );
  if (updateStatements[0] !== undefined) {
    const update = updateStatements[0]![0];
    assert.ok(
      /SET status = \$2, result_state = \$3, resulting_decision = \$4,\s*concluded_at = \$5/.test(
        update,
      ),
      'the UPDATE must set ONLY the lifecycle columns (status, result_state, resulting_decision, concluded_at)',
    );
    for (const designColumn of [
      'hypothesis',
      'decision_target',
      'primary_metric',
      'guardrails',
      'analysis_method',
      'stop_criteria',
      'uncertainty_representation',
    ]) {
      assert.ok(
        !update.includes(designColumn),
        `the UPDATE must never rewrite the design column '${designColumn}'`,
      );
    }
  }
  // No DELETE on experiments rows (tombstone-style erasure is impossible;
  // INVALIDATED is a lifecycle state, not a deletion).
  assert.ok(
    !/DELETE FROM experiments\b/.test(experimentsStore) && !/DELETE FROM experiments\b/.test(experimentsModule),
    'the implementation must never DELETE experiment rows',
  );
  // No DELETE/UPDATE on the append-only history.
  assert.ok(
    !/UPDATE experiment_transitions|DELETE FROM experiment_transitions/.test(experimentsStore),
    'the implementation must never rewrite the transition history',
  );
  // No outcome computation, no assignment execution, no learnings — the
  // module is the design/lifecycle record only.
  for (const source of [experimentsModule, experimentsStore]) {
    assert.ok(!/computeLift|runAnalysis|assignVariant|splitTraffic|createLearning/i.test(source), 'the experiments module computes nothing and executes no assignment');
  }
});

test('the route surface is POST/GET registrations only, and exactly the experiments surface (EXP-001)', () => {
  const registrations = [
    ...experimentsRoutes.matchAll(/router\.add\(\s*'([A-Z]+)',\s*'([^']+)'/g),
  ].map((match) => [match[1]!, match[2]!] as const);
  assert.deepEqual(
    registrations,
    [
      ['POST', '/api/clients/:clientId/experiments'],
      ['GET', '/api/clients/:clientId/experiments'],
      ['GET', '/api/experiments/:experimentId'],
      ['POST', '/api/experiments/:experimentId/transitions'],
      ['GET', '/api/experiments/:experimentId/transitions'],
    ],
    'the experiments surface is exactly declare/list/read/transition/history',
  );
  for (const [method] of registrations) {
    assert.ok(
      method === 'POST' || method === 'GET',
      `no mutation verb other than the transition command (found ${method})`,
    );
  }
  // No PATCH/PUT/DELETE anywhere (the design is immutable; no erase path).
  assert.ok(!/'(PATCH|PUT|DELETE)'/.test(experimentsRoutes), 'no PATCH/PUT/DELETE routes');
  // No second permission/role engine in the routes (authorization composes
  // the /agencies membership authority).
  assert.ok(
    !/role.*engine|permissionTable|canAccess|hasPermission/.test(experimentsRoutes),
    'no alternate permission authority in the routes',
  );
  // Provenance is built server-side in the routes (never from the body).
  assert.ok(
    experimentsRoutes.includes('function serverProvenance('),
    'the routes must build provenance server-side',
  );
});

test('the DTO discipline is structural: provenance AND lifecycle/result authority are caller-rejected on BOTH write surfaces', () => {
  const createAuthorityList = experimentsRoutes.slice(
    experimentsRoutes.indexOf('const EXPERIMENT_CREATE_AUTHORITY_FIELDS'),
    experimentsRoutes.indexOf('] as const;', experimentsRoutes.indexOf('const EXPERIMENT_CREATE_AUTHORITY_FIELDS')),
  );
  for (const authorityField of [
    'experimentId',
    'clientId',
    'agencyId',
    'status',
    'resultState',
    'resultingDecision',
    'concludedAt',
    'conclusion',
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
  const transitionAuthorityList = experimentsRoutes.slice(
    experimentsRoutes.indexOf('const EXPERIMENT_TRANSITION_AUTHORITY_FIELDS'),
    experimentsRoutes.indexOf(
      '] as const;',
      experimentsRoutes.indexOf('const EXPERIMENT_TRANSITION_AUTHORITY_FIELDS'),
    ),
  );
  for (const authorityField of [
    'status',
    'fromStatus',
    'toStatus',
    'resultState',
    'resultingDecision',
    'concludedAt',
    'provenance',
    'actor',
    'recordedAt',
    'correlationId',
  ]) {
    assert.ok(
      transitionAuthorityList.includes(`'${authorityField}'`),
      `the transition DTO must reject the authority field '${authorityField}'`,
    );
  }
});
