/**
 * MKT-054 static tests — the Growth Operator domain is structurally correct
 * in the ACTUAL migration, module contract and composition wiring (pure
 * static analysis, no DB; the growth-missions-boundary precedent).
 *
 * Proofs (spec/effective-backlog-v1.6.md MKT-054; spec/architecture-v1.6.md
 * §13/§17/§21 — the primary contract; frozen by spec/architecture-lock-v1.6.md
 * rule 17 and spec/module-dependency-matrix-v1.6.md boundary rules 3/11/12;
 * registered matrix row /growth-operator ──→ the satisfiable subset):
 *   1. migration 050 (the PRE-ASSIGNED number) creates exactly the FOUR
 *      operator tables — OWN tables ONLY, NO workflow/execution/task/job/
 *      dispatch/queue/sandbox/playbook/experiment/evidence/learning/
 *      mission/deployment/decision table (the composed authorities stay
 *      sole — architecture-lock-v1.6.md rule 17: the operator is a
 *      controller, NEVER a second workflow or execution engine);
 *   2. THE NO-SECOND-ENGINE FENCE (the cardinal rule, negative form): the
 *      module code contains ZERO execution-engine verbs — no execution
 *      transition, no dispatch/queue submit, no sandbox leasing, no job
 *      pickup, no worker pool, no retry orchestration; the execution port
 *      exposes ONLY create + read; the module's DML touches its OWN tables
 *      only;
 *   3. THE HUMAN-NON-DEPENDENCY FENCE (rules 43/44/45, matrix rules
 *      11/12): no human-marketplace module is imported anywhere in the
 *      module, no field-agent/job/offer table is created or referenced,
 *      and the budget defaults are the ZERO-human state;
 *   4. the FROZEN VOCABULARIES are CHECK-fenced: the six-state controller
 *      machine (three resumable + the three terminal states), the
 *      treatment-family space, the decision kinds, the gate kinds, the
 *      observed outcomes, the plan-step lifecycle;
 *   5. THE HONEST-STATE + APPEND-ONLY BATTERY: the frozen transition-pair
 *      trigger (terminal states have no outgoing pairs; a block is never
 *      silently converted into success), the current-state-match trigger,
 *      the init-first + gate-kind-shape + terminal-cause-shape fences, the
 *      append-only UPDATE/DELETE rejection triggers on the decision tail
 *      and the event tail, the controller mutation guard (identity
 *      immutability + exact CAS advance + the blocked-shape fence) and
 *      the plan-step guard (identity immutability + fill-only delegation
 *      references + frozen lifecycle edges + observation-exactly-once +
 *      the UNIQUE (mission_id, idempotency_key) no-double-dispatch fence);
 *   6. the module's cross-module imports are TYPE-ONLY and target
 *      matrix-listed public entries ONLY (zero runtime imports; the ONE
 *      off-matrix /workspaces port is hand-declared and satisfied by a
 *      composition-root wrapper — the MKT-068 recipient-resolution
 *      precedent);
 *   7. THE PLATFORM-HEALTH SEAM (MKT-066, not yet merged): the typed port
 *      exists, is NOT wired at the composition root, and /platform-health
 *      is NOT in the registered matrix row (it joins at MKT-066 time);
 *   8. the spec registration exists: /growth-operator in
 *      spec/architecture.md §6 + the matrix row + the authority-notes
 *      bullet; 052_growth_operator.sql holds its numeric position;
 *   9. the version discipline: the frozen vocabulary version (go-vocab-v1)
 *      + the strategy version (go-strategy-v1) ship on the public
 *      contract.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkArchitecture, parseFrozenMatrix, parseFrozenModules } from '../../tools/arch-check/checker.ts';
import {
  GROWTH_OPERATOR_DEFAULT_BUDGET,
  GROWTH_OPERATOR_STRATEGY_VERSION,
  GROWTH_OPERATOR_VOCABULARY_VERSION,
} from '../../src/modules/growth-operator/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
const read = (path: string): string => readFileSync(path, 'utf8');

const migration050 = read(join(repoRoot, 'src', 'platform', 'db', 'migrations', '052_growth_operator.sql'));
const operatorPublic = read(src('modules', 'growth-operator', 'public.ts'));
const operatorModule = read(src('modules', 'growth-operator', 'internal', 'growth-operator-module.ts'));
const operatorStore = read(src('modules', 'growth-operator', 'internal', 'growth-operator-store.ts'));
const operatorStrategy = read(src('modules', 'growth-operator', 'internal', 'strategy-space.ts'));
const compositionRoot = read(src('composition-root.ts'));
const applicationTs = read(src('api', 'application.ts'));
const architectureSpec = read(join(repoRoot, 'spec', 'architecture.md'));
const matrixSpec = read(join(repoRoot, 'spec', 'module-dependency-matrix.md'));

/** Comment-stripped source (prose must not confuse the code scans). */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'" ])\/\/[^\n]*/g, '$1');
}

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

// ---------------------------------------------------------------------------
// 1. Migration 050: OWN TABLES ONLY (no authority table, no engine state)
// ---------------------------------------------------------------------------

test('MKT-054: migration 050 creates exactly the four operator tables — OWN tables ONLY (never a second engine)', () => {
  const created = [...migration050.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \(/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    created,
    ['growth_operator_controllers', 'growth_operator_plan_steps', 'growth_operator_decisions', 'growth_operator_events'],
    'own tables ONLY — the persistent controller layer; /workflows (009), /executions (011), /experiments (019), /evidence (015), /decisions (036), /learnings (027), /jobs (023), /playbooks (008), /deployments (034) and the mission records (045) stay the sole authorities (architecture-lock-v1.6.md rule 17: the Growth Operator is a decision/replanning controller and is NEVER a second Workflow or Execution engine)',
  );

  // The controller record's frozen columns.
  const controllerColumns = columnsOf(createTableBlock(migration050, 'growth_operator_controllers'));
  for (const required of [
    'controller_id', 'mission_id', 'agency_id', 'pursuit_client_id', 'pursuit_workspace_id',
    'pursuit_workflow_id', 'status', 'blocked_reason', 'blocked_gate_kind',
    'strategy_version', 'vocabulary_version', 'max_in_flight_steps', 'max_delegated_steps',
    'human_amplification_budget', 'human_amplification_eligible_capacity', 'version',
    'created_actor', 'created_at', 'updated_at',
  ]) {
    assert.ok(controllerColumns.includes(required), `controllers.${required} is required`);
  }

  // The plan-step idempotency fence (the no-double-dispatch guarantee).
  assert.ok(
    /UNIQUE \(mission_id, idempotency_key\)/.test(migration050),
    'the plan steps carry the UNIQUE (mission_id, idempotency_key) no-double-dispatch fence',
  );

  // NO engine table of any kind: no dispatch/queue/task/worker/sandbox/lease
  // table is created (the cardinal rule's storage-side proof).
  for (const forbidden of [
    'execution_dispatches', 'platform_jobs', 'job_offers', 'job_outcomes', 'sandboxes',
    'sandbox_leases', 'workflow_tasks', 'tasks', 'worker_pool', 'growth_operator_jobs',
    'growth_operator_dispatches', 'growth_operator_queue',
  ]) {
    assert.ok(
      !created.includes(forbidden),
      `migration 050 must not create a '${forbidden}' table (the runtime plane owns pickup/dispatch/sandbox leasing — never the operator)`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. THE NO-SECOND-ENGINE FENCE (the cardinal rule, negative form)
// ---------------------------------------------------------------------------

test('MKT-054: THE CARDINAL RULE — zero execution-engine verbs in the module code (comment-stripped)', () => {
  const code = stripComments(operatorModule + '\n' + operatorStore + '\n' + operatorStrategy + '\n' + operatorPublic);

  // The module must NEVER own execution lifecycle: no transition verb, no
  // dispatch submit, no queue, no sandbox leasing, no pickup, no worker
  // pool, no retry orchestration.
  for (const forbidden of [
    'transitionExecution',
    'dispatchExecution',
    'acquireExecutionSandboxLease',
    'releaseExecutionSandboxLease',
    'acquireSandboxLease',
    'releaseSandboxLease',
    'enqueueJob',
    'submitJob',
    'claimJob',
    'pickUpJob',
    'completeJob',
    'failJob',
    'PooledRuntimeService',
    'WorkerPool',
    'retryOrchestrat',
  ]) {
    assert.ok(
      !code.includes(forbidden),
      `the growth-operator module must not contain the execution-engine verb '${forbidden}' (architecture-lock-v1.6.md rule 17 — all physical work flows through the existing authorities; the runtime plane owns the execution lifecycle)`,
    );
  }

  // The execution PORT exposes ONLY create + read: the operator
  // structurally cannot express an execution mutation.
  const portMatch = operatorPublic.match(
    /export type GrowthOperatorExecutionPort = Pick<\s*ExecutionsModuleApi,\s*'createExecution' \| 'getExecution'\s*>;/,
  );
  assert.ok(
    portMatch !== null,
    "the execution port is exactly Pick<ExecutionsModuleApi, 'createExecution' | 'getExecution'> — no transition/mutation method exists on the port",
  );
  // The mission port composes the mission authority's own transition
  // command (boundary rule 3: create/advance mission decisions THROUGH
  // the authority).
  assert.ok(
    /export type GrowthOperatorMissionPort = Pick<\s*GrowthMissionsModuleApi,\s*'getGrowthMission' \| 'getGrowthMissionDetail' \| 'setGrowthMissionStatus'\s*>;/.test(
      operatorPublic,
    ),
    'the mission port is the Pick over the mission authority record/transition commands',
  );
});

test('MKT-054: the store DML targets the OWN four tables ONLY (no authority table is written from here)', () => {
  const code = stripComments(operatorStore + '\n' + operatorModule);
  const dmlTargets = [...code.matchAll(/\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/g)].map(
    (match) => match[1]!,
  );
  assert.ok(dmlTargets.length > 0, 'the store must issue DML');
  for (const target of new Set(dmlTargets)) {
    assert.ok(
      target.startsWith('growth_operator_'),
      `DML against '${target}' is outside the module's own tables (the composed authorities are never written from here — their own public commands are the only path)`,
    );
  }
});

test('MKT-054: migration 050 never writes another authority — the FK anchors are REFERENCES ONLY', () => {
  const sql = stripComments(migration050)
    .split('\n').map((line) => line.replace(/\s*--[^\n]*/, '')).join('\n');
  const writes = [...sql.matchAll(/\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(writes, [], 'the migration contains no DML against any table (DDL + fences only)');
  // The FK anchors to the existing authorities (references only).
  for (const anchor of [
    'REFERENCES growth_missions(mission_id)',
    'REFERENCES experiments(experiment_id)',
    'REFERENCES decisions(decision_id)',
    'REFERENCES workflows(workflow_id)',
    'REFERENCES workflow_definitions(workflow_definition_id)',
    'REFERENCES workflow_instances(workflow_instance_id)',
    'REFERENCES executions(execution_id)',
    'REFERENCES evidence(evidence_id)',
  ]) {
    assert.ok(migration050.includes(anchor), `the delegation identity FK anchor '${anchor}' is required`);
  }
});

// ---------------------------------------------------------------------------
// 3. THE HUMAN-NON-DEPENDENCY FENCE (rules 43/44/45; matrix rules 11/12)
// ---------------------------------------------------------------------------

test('MKT-054: zero human-marketplace dependency — no field-agent/job module import, no human table, zero-default budget', () => {
  const moduleTree = join(repoRoot, 'src', 'modules', 'growth-operator');
  const files = readdirSync(moduleTree, { withFileTypes: true });
  const allSources = [operatorPublic, operatorModule, operatorStore, operatorStrategy].join('\n');
  void files;

  // No human-marketplace module is imported anywhere in the module tree.
  for (const forbidden of [
    "from '../field-agents/public.ts'",
    "from '../../field-agents/public.ts'",
    "from '../jobs/public.ts'",
    "from '../../jobs/public.ts'",
    "from '../growth-human-work/public.ts'",
    "from '../../growth-human-work/public.ts'",
    "from '../human-growth-optimization/public.ts'",
  ]) {
    assert.ok(
      !allSources.includes(forbidden),
      `the growth-operator module must not import the human-marketplace surface '${forbidden}' (optional human growth never becomes a required dependency — matrix rule 11)`,
    );
  }
  // No human/offer/job column or table in the migration.
  for (const forbidden of ['field_agent', 'job_offer', 'job_outcome', 'human_agent', 'creator']) {
    assert.ok(
      !migration050.includes(forbidden),
      `migration 050 must not reference '${forbidden}' (the human-amplification inputs are budget/evidence columns on the controller row — runtime evidence, never a marketplace dependency)`,
    );
  }
  // The budget defaults ARE the zero-human state.
  assert.equal(GROWTH_OPERATOR_DEFAULT_BUDGET.humanAmplificationBudget, 0);
  assert.equal(GROWTH_OPERATOR_DEFAULT_BUDGET.humanAmplificationEligibleCapacity, 0);
  assert.ok(
    /human_amplification_budget integer NOT NULL DEFAULT 0/.test(migration050),
    'the human-amplification budget defaults to ZERO in storage',
  );
  assert.ok(
    /human_amplification_eligible_capacity integer NOT NULL DEFAULT 0/.test(migration050),
    'the eligible human capacity defaults to ZERO in storage',
  );
});

// ---------------------------------------------------------------------------
// 4. The frozen vocabularies are CHECK-fenced in storage
// ---------------------------------------------------------------------------

test('MKT-054: the frozen controller state vocabulary is CHECK-fenced (the six-state machine)', () => {
  const controllerBlock = createTableBlock(migration050, 'growth_operator_controllers');
  assert.ok(
    /CHECK \(status IN \('running', 'paused',\s*'blocked_pending_human_action',\s*'achieved', 'exhausted',\s*'terminated_by_policy'\)\)/.test(
      controllerBlock,
    ),
    'the controller status vocabulary is CHECK-fenced',
  );
  assert.ok(
    /blocked_gate_kind IN \('rights', 'policy', 'capability'\)/.test(controllerBlock),
    'the genuine gate kinds are CHECK-fenced',
  );
  const stepsBlock = createTableBlock(migration050, 'growth_operator_plan_steps');
  assert.ok(
    /treatment_family IN\s*\('owned_channel_publish', 'content_variant_test',\s*'channel_reallocation', 'measurement_enrichment',\s*'human_amplification'\)/.test(
      stepsBlock,
    ),
    'the bounded treatment-family space is CHECK-fenced',
  );
  assert.ok(
    /state IN \('planned', 'dispatched', 'observed', 'superseded'\)/.test(stepsBlock),
    'the plan-step lifecycle is CHECK-fenced',
  );
  assert.ok(
    /observed_outcome IS NULL\s*OR observed_outcome IN\s*\(\s*'delegated_work_succeeded',\s*'delegated_work_failed',\s*'delegated_work_cancelled'\s*\)/.test(
      stepsBlock,
    ),
    'the observed-outcome vocabulary is CHECK-fenced',
  );
  const decisionsBlock = createTableBlock(migration050, 'growth_operator_decisions');
  assert.ok(
    /decision_kind IN\s*\('controller_initialized', 'replan', 'delegation',\s*'observation', 'gate_encountered', 'state_transition',\s*'termination'\)/.test(
      decisionsBlock,
    ),
    'the decision-kind vocabulary is CHECK-fenced',
  );
});

// ---------------------------------------------------------------------------
// 5. THE HONEST-STATE + APPEND-ONLY BATTERY (the DB backstops)
// ---------------------------------------------------------------------------

test('MKT-054: the honest-state battery — the frozen transition-pair, current-state-match, init-first, gate-shape and terminal-cause fences', () => {
  // The frozen transition-pair + current-state-match trigger.
  assert.ok(
    /growth_operator_event_consistent/.test(migration050),
    'the event-consistency trigger exists',
  );
  assert.ok(
    /\(NEW\.from_status = 'running' AND NEW\.to_status IN/.test(migration050),
    'the running-state edges are fenced',
  );
  assert.ok(
    /\(NEW\.from_status = 'paused' AND NEW\.to_status IN \('running', 'terminated_by_policy'\)\)/.test(
      migration050,
    ),
    'paused resumes ONLY to running (or terminates)',
  );
  assert.ok(
    /\(NEW\.from_status = 'blocked_pending_human_action'\s*AND NEW\.to_status IN \('running', 'terminated_by_policy'\)\)/.test(
      migration050,
    ),
    'blocked resumes ONLY to running (or terminates) — a block is never silently converted into success',
  );
  assert.ok(
    /NEW\.from_status IS NULL AND NEW\.to_status = 'running'/.test(migration050),
    'initialization is born running',
  );
  assert.ok(
    /growth operator initialization event must be the first event/.test(migration050),
    'the initialization event must be the first event',
  );
  assert.ok(
    /entering blocked_pending_human_action must record the genuine gate kind/.test(migration050),
    'entering the blocked state requires the genuine gate kind',
  );
  assert.ok(
    /terminal transitions carry the honest terminal cause and non-terminal transitions carry none/.test(
      migration050,
    ),
    'the terminal-cause shape fence exists',
  );
  // The controller blocked-shape fence + CAS + identity immutability.
  assert.ok(
    /entering blocked_pending_human_action requires a block reason AND a genuine gate kind/.test(
      migration050,
    ),
    'the controller blocked-shape fence exists',
  );
  assert.ok(
    /CAS version must advance by exactly one/.test(migration050),
    'the controller CAS fence exists',
  );
  assert.ok(
    /identity\/scope\/policy\/provenance is immutable/.test(migration050),
    'the controller identity-immutability fence exists',
  );
  // The plan-step guard: identity immutable, refs fill-only, frozen edges,
  // observation-exactly-once, no-DELETE.
  assert.ok(
    /delegation references cannot change once set/.test(migration050),
    'the plan-step fill-only delegation-reference fence exists',
  );
  assert.ok(
    /planned → dispatched \| superseded; dispatched → observed; observed\/superseded are frozen/.test(
      migration050,
    ),
    'the plan-step frozen lifecycle edges are fenced',
  );
  assert.ok(
    /observation may only be recorded on the dispatched → observed transition/.test(migration050),
    'the observation-exactly-once fence exists',
  );
  assert.ok(
    /must carry the full delegation identity before dispatch/.test(migration050),
    'a dispatched step must carry the full delegation identity',
  );
  // Append-only: decisions + events reject UPDATE and DELETE outright.
  assert.ok(
    /growth_operator_decisions_append_only/.test(migration050) &&
      /growth_operator_events_append_only/.test(migration050),
    'the decision and event append-only triggers exist',
  );
  assert.ok(
    /growth operator (decisions|events|controllers|plan steps) cannot be deleted/.test(migration050),
    'the no-DELETE fences exist',
  );
});

// ---------------------------------------------------------------------------
// 6. The import posture: TYPE-ONLY, matrix-listed public entries ONLY
// ---------------------------------------------------------------------------

test('MKT-054: the module imports are TYPE-ONLY and target matrix-listed public entries ONLY (zero runtime imports)', () => {
  const moduleDir = join(repoRoot, 'src', 'modules', 'growth-operator');
  const allFiles = [
    ...readdirSync(join(moduleDir, 'internal'), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(moduleDir, 'internal', entry.name)),
    join(moduleDir, 'public.ts'),
  ];
  const matrixRowList = matrixRow();
  for (const file of allFiles) {
    const source = read(file);
    // Multi-line-safe import scanning (import type {..} from '..';).
    for (const match of source.matchAll(/^import\s+(type\s+)?\{[^}]*\}\s+from\s+'([^']+)';/gm)) {
      const isTypeOnly = match[1] !== undefined;
      const specifier = match[2]!;
      // Same-module and platform imports are not cross-module boundaries.
      if (specifier.startsWith('./')) continue;
      if (specifier.includes('/platform/')) continue;
      if (specifier === '../public.ts') continue; // the module's own public entry
      assert.ok(
        isTypeOnly,
        `${file}: the cross-module import '${specifier}' must be type-only (zero runtime imports — the ports are structural)`,
      );
      const target = specifier.replace(/^(\.\.\/)+/, '').replace(/\/public\.ts$/, '');
      assert.ok(
        matrixRowList.includes(target),
        `${file}: the import '${specifier}' targets '${target}' which is NOT a matrix-listed direction of the registered /growth-operator row`,
      );
    }
  }
  // The arch-checker agrees: zero violations on the real tree.
  const result = checkArchitecture({
    codeRoot: repoRoot,
    specDir: join(repoRoot, 'spec'),
    skip: ['tests/architecture/fixtures', 'console'],
  });
  assert.deepEqual(result.violations, []);
});

// ---------------------------------------------------------------------------
// 7. THE PLATFORM-HEALTH SEAM (MKT-066 — not yet merged at this base)
// ---------------------------------------------------------------------------

test('MKT-054: the platform-health seam is typed-but-unwired (the MKT-066 future joins the row later)', () => {
  // The typed port exists on the public contract.
  assert.ok(
    /export interface GrowthOperatorPlatformHealthPort/.test(operatorPublic),
    'the typed platform-health port is declared (the future seam)',
  );
  // It is NOT wired INTO THE OPERATOR. (The MKT-066 delivery now wires
  // the /platform-health module as its OWN frozen authority at the
  // composition root — the re-pin: the honest assertion is that the
  // OPERATOR's platform-health seam receives no instance; the row joins
  // the operator at the MKT-070+ composition time.)
  const operatorWiring = compositionRoot.slice(
    compositionRoot.indexOf('const growthOperator = createGrowthOperatorModule({'),
    compositionRoot.indexOf('const growthOperator = createGrowthOperatorModule({') + 1600,
  );
  assert.ok(
    !/platformHealth/.test(operatorWiring),
    'the platform-health port is NOT wired into the growth operator (the MKT-070+ composition)',
  );
  // The registered matrix row does NOT include platform-health yet.
  const specModules = parseFrozenModules(join(repoRoot, 'spec', 'architecture.md'));
  const matrix = parseFrozenMatrix(
    join(repoRoot, 'spec', 'module-dependency-matrix.md'),
    join(repoRoot, 'spec', 'module-dependency-v1.3.md'),
    [...specModules, 'apps'],
  );
  assert.ok(!matrix['growth-operator']!.includes('platform-health'));
  assert.deepEqual(matrix['growth-operator'], matrixRow());
  // The frozen v1.6 row names it — disclosed in the authority notes.
  assert.ok(
    matrixSpec.includes("the frozen v1.6 matrix row additionally lists `/platform-health`, which arrives with MKT-066"),
    'the /platform-health registration-subset disclosure exists in the authority notes',
  );
});

function matrixRow(): string[] {
  return [
    'growth-missions', 'goals', 'playbooks', 'deployments', 'workflows',
    'executions', 'evidence', 'experiments', 'learnings', 'decisions', 'policies',
  ];
}

// ---------------------------------------------------------------------------
// 8. The spec registration + the composition wiring
// ---------------------------------------------------------------------------

test('MKT-054: the disclosed spec registration exists — §6 line + sentence, the matrix row + authority-notes bullet, the composition wiring', () => {
  // §6 module list line.
  assert.ok(
    /^\/growth-operator$/m.test(architectureSpec),
    'spec/architecture.md §6 carries the /growth-operator module line',
  );
  assert.ok(
    architectureSpec.includes('`/growth-operator` is the v1.6 Growth Operator authority'),
    'the §6 registration sentence exists',
  );
  // The matrix row + the authority-notes bullet.
  assert.ok(
    /^\/growth-operator ──→ \/growth-missions, \/goals, \/playbooks, \/deployments, \/workflows, \/executions, \/evidence, \/experiments, \/learnings, \/decisions, \/policies$/m.test(
      matrixSpec,
    ),
    'the matrix dependency row exists (the disclosed satisfiable subset)',
  );
  assert.ok(
    matrixSpec.includes('- `/growth-operator` is the v1.6 Growth Operator authority'),
    'the matrix authority-notes bullet exists',
  );
  // The composition wiring.
  assert.ok(
    applicationTs.includes('readonly growthOperator: GrowthOperatorModuleApi'),
    'ApplicationModules.growthOperator exists',
  );
  assert.ok(
    applicationTs.includes("from '../modules/growth-operator/public.ts'"),
    'the module public entry import exists',
  );
  assert.ok(
    compositionRoot.includes('const growthOperator = createGrowthOperatorModule'),
    'the composition root constructs the module',
  );
  // The MKT-062 sibling registration appends research + contentIntelligence
  // after crossPlatformDistribution (the additive composition-root
  // adjacency — the same sibling re-pin precedent).
  assert.ok(
    compositionRoot.includes('growthOperator, contentRights, contentAssets, experimentAnalysis, crossPlatformDistribution, research') &&
      compositionRoot.includes('crossPlatformDistribution, research, contentIntelligence, platformHealth },'),
    'the composition root registers the module in the modules map (the MKT-063 sibling joins after it at merge; the MKT-067 sibling joins after that, the MKT-065 sibling after that, and the MKT-062 siblings last)',
  );
  assert.ok(
    compositionRoot.includes('options.growthOperatorGate'),
    'the AppOptions.growthOperatorGate seam exists (the disclosed test/rights-gate double)',
  );
  // The migration tail position (the shared infra-adapters list; the
  // MKT-065 /cross-platform-distribution sibling delivery appends 055
  // after the MKT-067 054, and the MKT-062 sibling delivery appends
  // 056_research + 057_content_intelligence — every tail position shifts
  // once more).
  // The MKT-066 sibling delivery appends 058_platform_health — every
  // tail position shifts once more (the same additive re-pin precedent).
  const migrations = readdirSync(src('platform', 'db', 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  assert.equal(migrations[migrations.length - 7], '052_growth_operator.sql');
});

// ---------------------------------------------------------------------------
// 9. The version discipline
// ---------------------------------------------------------------------------

test('MKT-054: the version discipline ships on the public contract (go-vocab-v1 / go-strategy-v1)', () => {
  assert.equal(GROWTH_OPERATOR_VOCABULARY_VERSION, 'go-vocab-v1');
  assert.equal(GROWTH_OPERATOR_STRATEGY_VERSION, 'go-strategy-v1');
  assert.ok(
    operatorPublic.includes("GROWTH_OPERATOR_VOCABULARY_VERSION = 'go-vocab-v1'"),
    'the vocabulary version is frozen on the contract',
  );
  assert.ok(
    operatorPublic.includes("GROWTH_OPERATOR_STRATEGY_VERSION = 'go-strategy-v1'"),
    'the strategy version is frozen on the contract',
  );
  // The storage carries the version columns.
  assert.ok(/strategy_version\s+text\s+NOT NULL/.test(migration050));
  assert.ok(/vocabulary_version\s+text\s+NOT NULL/.test(migration050));
});
