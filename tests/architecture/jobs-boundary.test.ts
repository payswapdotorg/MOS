/**
 * MKT-026 static tests — the Job marketplace boundary is structurally
 * correct in the ACTUAL migration, module contract and routes (pure
 * static analysis, no DB). Proves the frozen architecture boundaries
 * (spec/job-offer-v1.2.md; spec/human-agent-v1.3.md §3/§4;
 * spec/implementation-clarifications-v1.2.md "Job Offers";
 * spec/module-dependency-matrix.md; architecture.md §13; JOB-001):
 *
 *   1. migration 023 creates EXACTLY the three /jobs tables (jobs,
 *      job_offers, job_outcomes) — no second workflow/task/execution
 *      engine structures;
 *   2. JOB-AC-01 (Job references one governed Task): jobs.workflow_instance_id
 *      is a FK to the workflow-authoritative workflow_instances, the
 *      (workflow_instance_id, node_id) task key is UNIQUE-fenced (one Job
 *      per Task projection — no second assignment identity), the
 *      task-reference trigger requires a human_task node of a RUNNING
 *      instance, the scope-chain trigger ties the job scope to the
 *      instance scope (workspace within client, client within agency),
 *      and the identity-immutability trigger freezes the Task reference;
 *   3. the Job status machine is trigger-enforced edge-for-edge and
 *      equals the code registry (JOB_STATUSES/JOB_TRANSITIONS);
 *      declined/expired/outcome_submitted are terminal in both;
 *   4. the EXACTLY-ONE-WINNER acceptance fence exists (partial unique
 *      index on job_offers WHERE status='accepted') plus the
 *      one-open-offer-per-candidate fence and the candidate-consistency
 *      trigger; the offer status CHECK equals OFFER_STATUSES; terminal
 *      offer states are frozen;
 *   5. JOB-AC-03 storage: job_outcomes is append-only (UPDATE/DELETE
 *      rejected), exactly one per job (UNIQUE(job_id)), carries the
 *      server-derived provenance columns and the same-Client evidence
 *      trigger;
 *   6. NO SECOND WORKFLOW ENGINE (JOB-001 "without creating a second
 *      workflow engine"): the /jobs module imports ONLY allowed public
 *      contracts (frozen matrix: /jobs ──→ /workflows, /executions,
 *      /field-agents, /clients, /evidence, /policies — this Work Item
 *      consumes /workflows + /field-agents + /evidence), NEVER a module
 *      internal, and /jobs code NEVER references the /workflows instance
 *      mutation port (transitionWorkflowInstance) — Workflow authority is
 *      preserved: Jobs report (the outcome record references the Task and
 *      the observed instance status), they never own workflow state
 *      transitions; the public contract exports no graph/node/edge/
 *      scheduling concepts;
 *   7. the routes register ONLY the jobs surfaces (/api/jobs/* plus the
 *      Task-projection POST under the workflow-instance path) and compose
 *      the SAME /agencies membership authority (requireClientAccess /
 *      resolveContext — no private permission engine; the frozen matrix
 *      gives /jobs no /agencies module dependency, so composition happens
 *      at the route layer exactly like MKT-025);
 *   8. human-agent-v1.3 §3 (Job access): the marketplace descriptor
 *      serializer structurally carries NO Client/Agency/Workspace/Task
 *      identifiers — eligibility is evaluated BEFORE Client data is
 *      exposed (the listing filters through the /field-agents matcher);
 *   9. the shared registration files wire the module: routes.ts
 *      registers registerJobsRoutes, application.ts exposes the jobs
 *      module contract, composition-root.ts wires createJobsModule.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JOB_STATUSES,
  JOB_TERMINAL_STATUSES,
  OFFER_STATUSES,
} from '../../src/modules/jobs/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
const read = (path: string): string => readFileSync(path, 'utf8');

const migration023 = read(src('platform', 'db', 'migrations', '023_jobs.sql'));
const jobsPublic = read(src('modules', 'jobs', 'public.ts'));
const jobsModule = read(src('modules', 'jobs', 'internal', 'module.ts'));
const jobsStore = read(src('modules', 'jobs', 'internal', 'store.ts'));
const jobsRoutes = read(src('api', 'jobs-routes.ts'));
const routesFile = read(src('api', 'routes.ts'));
const applicationFile = read(src('api', 'application.ts'));
const compositionRoot = read(src('composition-root.ts'));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs));
    else if (entry.name.endsWith('.ts')) out.push(abs);
  }
  return out;
}

/** Imports of `file` as raw specifier strings. */
function importsOf(file: string): string[] {
  const text = read(file);
  const specifiers: string[] = [];
  for (const match of text.matchAll(/from\s+'([^']+)'/g)) specifiers.push(match[1]!);
  for (const match of text.matchAll(/import\s+'([^']+)'/g)) specifiers.push(match[1]!);
  return specifiers;
}

const jobsModuleFiles = walk(src('modules', 'jobs'));

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
    .map((line) => line.split(/\s+/)[0]!)
    .filter((column) => column !== 'CHECK');
}

// ---------------------------------------------------------------------------
// 1. Exactly the three /jobs tables
// ---------------------------------------------------------------------------

test('migration 023 creates exactly the THREE /jobs tables (no engine structures)', () => {
  const createdTables = [...migration023.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    createdTables.sort(),
    ['job_offers', 'job_outcomes', 'jobs'],
    'migration 023 must create exactly jobs, job_offers and job_outcomes',
  );
});

// ---------------------------------------------------------------------------
// 2. JOB-AC-01 — the governed Task reference
// ---------------------------------------------------------------------------

test('JOB-AC-01: the Job Task reference is FK-backed to workflow_instances with the house scope chain', () => {
  const jobsBlock = createTableBlock(migration023, 'jobs');
  const columns = columnsOf(jobsBlock);
  for (const required of [
    'job_id',
    'workflow_instance_id',
    'node_id',
    'workspace_id',
    'client_id',
    'agency_id',
    'title',
    'description',
    'eligibility',
    'status',
    'accepted_agent_id',
    'accepted_user_id',
    'accepted_offer_id',
    'accepted_at',
    'created_by',
    'version',
    'created_at',
    'updated_at',
  ]) {
    assert.ok(columns.includes(required), `jobs.${required} required (the projection contract)`);
  }
  assert.ok(
    migration023.includes(
      'workflow_instance_id  uuid        NOT NULL REFERENCES workflow_instances(workflow_instance_id)',
    ),
    'workflow_instance_id must be a NOT NULL FK to the workflow-authoritative instances',
  );
  // The scope chain columns are FKs to the house tenant tables.
  assert.ok(jobsBlock.includes('REFERENCES workspaces(workspace_id)'));
  assert.ok(jobsBlock.includes('REFERENCES clients(client_id)'));
  assert.ok(jobsBlock.includes('REFERENCES agencies(agency_id)'));
});

test('JOB-AC-01: ONE Job per Task projection — the (workflow_instance_id, node_id) task key is UNIQUE-fenced', () => {
  assert.ok(
    migration023.includes(
      'CREATE UNIQUE INDEX IF NOT EXISTS jobs_task_key ON jobs (workflow_instance_id, node_id)',
    ),
    'the task key unique fence must exist (no second assignment identity for one Task)',
  );
});

test('JOB-AC-01: the task-reference, scope-chain and identity-immutability triggers exist', () => {
  for (const triggerFunction of [
    'jobs_task_reference()',
    'jobs_scope_chain()',
    'jobs_identity_immutable()',
    'jobs_frozen_state_machine()',
  ]) {
    assert.ok(
      migration023.includes(`CREATE OR REPLACE FUNCTION ${triggerFunction}`),
      `trigger function ${triggerFunction} required`,
    );
  }
  // The task reference must check nodeType = 'human_task' of the pinned
  // definition graph and a RUNNING instance.
  assert.ok(migration023.includes("n ->> 'nodeType' = 'human_task'"));
  assert.ok(migration023.includes("v_status <> 'running'"));
  // The scope chain must tie the job scope to the instance scope.
  assert.ok(migration023.includes('NEW.workspace_id <> v_workspace_id'));
  // Immutability: the Task reference and scope can never be reassigned.
  assert.ok(migration023.includes('NEW.workflow_instance_id <> OLD.workflow_instance_id'));
  assert.ok(migration023.includes('NEW.node_id <> OLD.node_id'));
  assert.ok(migration023.includes('NEW.client_id <> OLD.client_id'));
});

// ---------------------------------------------------------------------------
// 3. The frozen Job state machine (DB == code)
// ---------------------------------------------------------------------------

test('the DB job status CHECK enumerates exactly the code registry JOB_STATUSES', () => {
  const jobsBlock = createTableBlock(migration023, 'jobs');
  const checkMatch = jobsBlock.match(/status\s+text\s+NOT NULL DEFAULT 'projected'\s*\n?\s*CHECK \(status IN \(([^)]+)\)/);
  assert.ok(checkMatch !== null, 'jobs.status must carry the frozen vocabulary CHECK');
  const dbStatuses = checkMatch[1]!
    .split(',')
    .map((entry) => entry.trim().replace(/^'|'$/g, ''));
  assert.deepEqual([...dbStatuses].sort(), [...JOB_STATUSES].sort());
});

test('the DB job state machine trigger encodes exactly the frozen transition table', () => {
  const transitionFunction = migration023.match(
    /CREATE OR REPLACE FUNCTION jobs_transition_legal\(from_status text, to_status text\)([\s\S]*?)\$\$ LANGUAGE plpgsql IMMUTABLE;/,
  );
  assert.ok(transitionFunction !== null, 'the transition predicate function must exist');
  const body = transitionFunction[1]!;
  for (const [from, to] of [
    ['projected', 'offered'],
    ['accepted', 'outcome_submitted'],
  ] as const) {
    assert.ok(
      body.includes(`from_status = '${from}' AND to_status = '${to}'`),
      `the legal edge ${from} → ${to} must be encoded`,
    );
  }
  assert.ok(
    body.includes("from_status = 'offered' AND to_status IN ('accepted', 'declined', 'expired')"),
    'the offered → accepted | declined | expired edges must be encoded',
  );
  // Terminal states are frozen by the row trigger.
  const stateMachine = migration023.match(/CREATE OR REPLACE FUNCTION jobs_frozen_state_machine\(\)([\s\S]*?)\$\$ LANGUAGE plpgsql;/)![1]!;
  for (const terminal of JOB_TERMINAL_STATUSES) {
    assert.ok(stateMachine.includes(`'${terminal}'`), `terminal ${terminal} must be frozen`);
  }
});

test('acceptance columns exist exactly in accepted/outcome_submitted states (CHECK pair)', () => {
  const jobsBlock = createTableBlock(migration023, 'jobs');
  assert.ok(
    jobsBlock.includes("CHECK (\n        (status IN ('accepted', 'outcome_submitted'))\n        OR (accepted_agent_id IS NULL"),
    'the acceptance-columns CHECK pair must fence the claim fields to the accepted states',
  );
});

// ---------------------------------------------------------------------------
// 4. Offers — the concurrency-safe acceptance contract (job-offer-v1.2.md)
// ---------------------------------------------------------------------------

test('the EXACTLY-ONE-WINNER fence and the one-open-offer-per-candidate fence exist', () => {
  assert.ok(
    migration023.includes(
      "CREATE UNIQUE INDEX IF NOT EXISTS job_offers_one_winner\n    ON job_offers (job_id) WHERE status = 'accepted'",
    ),
    'the partial unique index (one accepted offer per job) must exist — the v1.2 acceptance backstop',
  );
  assert.ok(
    migration023.includes(
      "CREATE UNIQUE INDEX IF NOT EXISTS job_offers_one_open_per_candidate\n    ON job_offers (job_id, candidate_agent_id) WHERE status = 'open'",
    ),
    'the one-open-offer-per-(job, candidate) fence must exist',
  );
});

test('the DB offer status CHECK enumerates exactly the code registry OFFER_STATUSES; terminal states frozen', () => {
  const offersBlock = createTableBlock(migration023, 'job_offers');
  const checkMatch = offersBlock.match(/status\s+text\s+NOT NULL DEFAULT 'open'\s*\n?\s*CHECK \(status IN \(([^)]+)\)/);
  assert.ok(checkMatch !== null, 'job_offers.status must carry the frozen vocabulary CHECK');
  const dbStatuses = checkMatch[1]!
    .split(',')
    .map((entry) => entry.trim().replace(/^'|'$/g, ''));
  assert.deepEqual([...dbStatuses].sort(), [...OFFER_STATUSES].sort());

  const offerMachine = migration023.match(/CREATE OR REPLACE FUNCTION job_offers_frozen_state_machine\(\)([\s\S]*?)\$\$ LANGUAGE plpgsql;/)![1]!;
  assert.ok(offerMachine.includes("IF OLD.status <> 'open' THEN"), 'terminal offer rows are frozen');
  assert.ok(
    offerMachine.includes("NEW.status NOT IN ('accepted', 'declined', 'expired', 'withdrawn')"),
    'only the four terminal targets are legal from open',
  );
  assert.ok(
    offersBlock.includes("CHECK ((status = 'open') = (terminal_reason IS NULL))"),
    'terminal states carry an explicit reason; open never does',
  );
});

test('the candidate-consistency and offer identity-immutability triggers exist', () => {
  assert.ok(migration023.includes('CREATE OR REPLACE FUNCTION job_offers_candidate_consistent()'));
  assert.ok(migration023.includes('CREATE OR REPLACE FUNCTION job_offers_identity_immutable()'));
  const immutability = migration023.match(/CREATE OR REPLACE FUNCTION job_offers_identity_immutable\(\)([\s\S]*?)\$\$ LANGUAGE plpgsql;/)![1]!;
  assert.ok(immutability.includes('NEW.candidate_agent_id <> OLD.candidate_agent_id'));
  assert.ok(immutability.includes('NEW.expires_at <> OLD.expires_at'), 'the expiry contract is immutable');
});

// ---------------------------------------------------------------------------
// 5. JOB-AC-03 storage — append-only provenance-preserving outcomes
// ---------------------------------------------------------------------------

test('job_outcomes: append-only, exactly one per job, server-derived provenance columns, same-Client evidence fence', () => {
  const outcomesBlock = createTableBlock(migration023, 'job_outcomes');
  const columns = columnsOf(outcomesBlock);
  for (const required of [
    'job_outcome_id',
    'job_id',
    'outcome',
    'payload_ref',
    'evidence_ref',
    'reported_instance_status',
    'recorded_actor',
    'recorded_via',
    'correlation_id',
    'causation_id',
    'submitted_by',
    'submitted_at',
    'created_at',
  ]) {
    assert.ok(columns.includes(required), `job_outcomes.${required} required (JOB-AC-03)`);
  }
  assert.ok(
    outcomesBlock.includes("CONSTRAINT job_outcomes_job_key UNIQUE (job_id)"),
    'exactly one outcome per job (the replay convergence fence)',
  );
  assert.ok(
    outcomesBlock.includes("outcome IN ('succeeded', 'failed')"),
    'the frozen outcome vocabulary',
  );
  assert.ok(
    outcomesBlock.includes('evidence_ref        uuid        NOT NULL REFERENCES evidence(evidence_id)'),
    'the evidence reference is FK-backed to the /evidence authority',
  );
  assert.ok(
    migration023.includes('CREATE OR REPLACE FUNCTION job_outcomes_append_only()'),
    'the append-only trigger must exist',
  );
  assert.ok(
    /BEFORE\s+UPDATE\s+OR\s+DELETE\s+ON\s+job_outcomes/.test(migration023),
    'the append-only trigger rejects UPDATE and DELETE',
  );
  assert.ok(
    migration023.includes('CREATE OR REPLACE FUNCTION job_outcomes_evidence_same_client()'),
    'the same-Client evidence backstop must exist (the metrics pattern)',
  );
  const appendOnlyFn = migration023.match(/CREATE OR REPLACE FUNCTION job_outcomes_append_only\(\)([\s\S]*?)\$\$ LANGUAGE plpgsql;/)![1]!;
  assert.ok(
    appendOnlyFn.includes('append-only history'),
    'the append-only function raises on mutation',
  );
  assert.ok(
    /BEFORE\s+UPDATE\s+OR\s+DELETE\s+ON\s+job_outcomes/.test(migration023),
    'append-only must reject UPDATE and DELETE',
  );
});

// ---------------------------------------------------------------------------
// 6. NO SECOND WORKFLOW ENGINE (JOB-001) — the module boundary
// ---------------------------------------------------------------------------

test('the /jobs module imports ONLY allowed public contracts — never a module internal, never a forbidden direction', () => {
  const allowedModuleDependencies = new Set([
    'workflows',
    'executions',
    'field-agents',
    'clients',
    'evidence',
    'policies',
  ]);
  for (const file of jobsModuleFiles) {
    for (const specifier of importsOf(file)) {
      if (!specifier.startsWith('.')) continue;
      const moduleMatch = specifier.match(/\/modules\/([a-z0-9-]+)\//);
      if (moduleMatch === null) continue;
      const target = moduleMatch[1]!;
      assert.ok(
        allowedModuleDependencies.has(target),
        `${file}: /jobs may depend only on the frozen matrix modules (found '/${target}')`,
      );
      assert.ok(
        specifier.endsWith('public.ts'),
        `${file}: cross-module access must target public.ts (found ${specifier})`,
      );
    }
  }
});

test('the /jobs module consumes /workflows READ-ONLY: the instance mutation port is NEVER invoked', () => {
  for (const file of [jobsPublic, jobsModule, jobsStore, jobsRoutes]) {
    assert.ok(
      !file.includes('transitionWorkflowInstance('),
      'Jobs never own workflow state transitions: the /workflows instance mutation port must never be invoked by /jobs code',
    );
    assert.ok(
      !file.includes('workflow-graph.ts'),
      'Jobs never import the workflow graph validation internals (no second engine surface)',
    );
  }
});

test('the /jobs public contract exports no workflow-engine concepts (no graph/node/edge semantics, no dispatch/scheduling)', () => {
  const exportedSymbols = [...jobsPublic.matchAll(/export (?:const|function|interface|type) ([A-Za-z0-9_]+)/g)]
    .map((match) => match[1]!)
    .filter(
      (symbol) =>
        /Graph|Edge|Node(?!Id)|Dispatch|Schedule|Retry|Compensation|TransitionWorkflow/i.test(symbol),
    );
  // WorkflowNode* type re-uses for the owner context composition are
  // REFERENCE shapes only; there must be no exported engine surface.
  const referenceShapes = ['WorkflowInstanceRecord', 'WorkflowInstanceStatus'];
  const offenders = exportedSymbols.filter((symbol) => !referenceShapes.includes(symbol));
  assert.deepEqual(
    offenders,
    [],
    'the jobs public contract must not export workflow-engine concepts',
  );
  // The store SQL carries no graph/node-instance bookkeeping beyond the
  // immutable (instance, node) task reference.
  assert.ok(!jobsStore.includes('workflow_nodes'));
  assert.ok(!jobsStore.includes('node_status'));
  assert.ok(!jobsStore.includes('next_node'));
});

test('the /jobs module never imports /agencies (route-layer composition, the frozen matrix)', () => {
  for (const file of jobsModuleFiles) {
    for (const specifier of importsOf(file)) {
      assert.ok(
        !specifier.includes('modules/agencies'),
        `${file}: the frozen matrix gives /jobs no /agencies dependency (compose at routes)`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 7. The routes surface
// ---------------------------------------------------------------------------

test('the jobs routes register ONLY the jobs surfaces and compose the shared authorization helpers', () => {
  const registered = [...jobsRoutes.matchAll(/'(?:GET|POST|PUT|PATCH|DELETE)',\s*'(\/[^']+)'/g)]
    .map((match) => match[1]!)
    .sort();
  assert.deepEqual(registered, [
    '/api/jobs/:jobId',
    '/api/jobs/:jobId/offers',
    '/api/jobs/:jobId/offers',
    '/api/jobs/:jobId/offers/:offerId/accept',
    '/api/jobs/:jobId/offers/:offerId/decline',
    '/api/jobs/:jobId/outcome',
    '/api/jobs/:jobId/outcome',
    '/api/jobs/marketplace',
    '/api/jobs/offers',
    '/api/workflows/:workflowId/instances/:instanceId/jobs',
  ].sort());

  // Shared authorization composition (no private permission engine).
  assert.ok(jobsRoutes.includes("from './authorize.ts'"));
  assert.ok(jobsRoutes.includes('requireClientAccess'));
  assert.ok(jobsRoutes.includes('resolveContext'));
  // The literal agent-surface routes are registered before the :jobId
  // patterns (first-match-wins router resolution).
  const marketplaceIndex = jobsRoutes.indexOf("'/api/jobs/marketplace'");
  const jobParamIndex = jobsRoutes.indexOf("'/api/jobs/:jobId'");
  assert.ok(marketplaceIndex >= 0 && jobParamIndex > marketplaceIndex, 'literal routes register first');
});

test('the marketplace descriptor serializer structurally carries NO Client/Task identifiers (§3 minimum data)', () => {
  const serializer = jobsRoutes.match(/function serializeDescriptor\(job: JobRecord\): Record<string, unknown> \{([\s\S]*?)\n\}/)![1]!;
  for (const forbidden of [
    'clientId',
    'agencyId',
    'workspaceId',
    'workflowInstanceId',
    'nodeId',
    'acceptedAgentId',
    'acceptedUserId',
  ]) {
    assert.ok(
      !serializer.includes(forbidden),
      `serializeDescriptor must not expose ${forbidden} (Client data after the eligibility gate only)`,
    );
  }
  // The candidate offer view reuses the descriptor (the decision surface).
  assert.ok(jobsRoutes.includes('function serializeOfferForCandidate('));
  const candidateView = jobsRoutes.match(/function serializeOfferForCandidate\(([\s\S]*?)\n\}/)![1]!;
  assert.ok(candidateView.includes('serializeDescriptor(job)'), 'the candidate view carries the descriptor only');
});

test('DTO authority-field rejection: every /jobs mutation surface forbids provenance/ownership fields (§23)', () => {
  for (const fieldSet of [
    'JOB_PROJECTION_AUTHORITY_FIELDS',
    'OFFER_CREATE_AUTHORITY_FIELDS',
    'OFFER_CLAIM_AUTHORITY_FIELDS',
    'OUTCOME_SUBMIT_AUTHORITY_FIELDS',
  ]) {
    assert.ok(jobsRoutes.includes(`const ${fieldSet} = [`), `${fieldSet} required`);
  }
  // Provenance-shaped keys are rejected on every surface.
  const outcomeFields = jobsRoutes.match(/const OUTCOME_SUBMIT_AUTHORITY_FIELDS = \[([\s\S]*?)\] as const;/)![1]!;
  for (const key of ['recordedActor', 'recordedVia', 'correlationId', 'causationId', 'provenance', 'submittedBy', 'submittedAt']) {
    assert.ok(outcomeFields.includes(`'${key}'`), `outcome DTO must reject the provenance key ${key}`);
  }
  // The projection DTO rejects the path-derived task reference and every
  // scope key (the tenant/linkage fields arrive through the spread).
  const projectionFields = jobsRoutes.match(/const JOB_PROJECTION_AUTHORITY_FIELDS = \[([\s\S]*?)\] as const;/)![1]!;
  const tenantSpread = jobsRoutes.match(/const TENANT_AND_LINKAGE_FIELDS = \[([\s\S]*?)\] as const;/)![1]!;
  for (const key of ['workflowInstanceId', 'jobId', 'status']) {
    assert.ok(projectionFields.includes(`'${key}'`), `projection DTO must reject the authority key ${key}`);
  }
  for (const key of ['clientId', 'agencyId', 'workspaceId']) {
    assert.ok(
      tenantSpread.includes(`'${key}'`),
      `the tenant/linkage spread must reject the scope key ${key}`,
    );
    assert.ok(
      projectionFields.includes('...TENANT_AND_LINKAGE_FIELDS'),
      'the projection DTO must include the tenant/linkage spread',
    );
  }
});

test('outcome provenance is built server-side from the principal and ambient correlation (never the body)', () => {
  const provenanceFn = jobsRoutes.match(/function outcomeProvenance\(principal: Principal, jobId: string\) \{([\s\S]*?)\n\}/)![1]!;
  assert.ok(provenanceFn.includes('auditActor(principal)'));
  assert.ok(provenanceFn.includes('currentCorrelation()'));
  assert.ok(provenanceFn.includes("recordedVia: 'api'"));
});

// ---------------------------------------------------------------------------
// 8. Shared registration files wire the module (MKT-026 additions)
// ---------------------------------------------------------------------------

test('routes.ts registers the jobs routes; application.ts exposes the module; composition-root wires it', () => {
  assert.ok(routesFile.includes("import { registerJobsRoutes } from './jobs-routes.ts'"));
  assert.ok(routesFile.includes('registerJobsRoutes(router, services, modules)'));
  assert.ok(applicationFile.includes("import type { JobsModuleApi } from '../modules/jobs/public.ts'"));
  assert.ok(applicationFile.includes('readonly jobs: JobsModuleApi'));
  assert.ok(compositionRoot.includes("import { createJobsModule } from './modules/jobs/public.ts'"));
  assert.ok(
    compositionRoot.includes(
      'const jobs = createJobsModule({ db, clock, ids, workflows, fieldAgents, evidence })',
    ),
    'the composition root wires exactly the frozen-matrix dependencies (workflows read-only, field-agents, evidence)',
  );
});

test('the module public contract exposes the outcome REPORT surface (the workflow authority consumes it)', () => {
  assert.ok(
    jobsPublic.includes('getJobOutcome(jobId: string): Promise<JobOutcomeRecord | null>'),
    'the submitted outcome is exposed through the /jobs public contract (the report surface)',
  );
  assert.ok(
    jobsPublic.includes('reportedInstanceStatus'),
    'the report carries the observed workflow instance status (report context; no workflow mutation)',
  );
  assert.ok(
    jobsPublic.includes('resolveJobOwnership(jobId: string): Promise<JobOwnerContext | null>'),
    'the canonical owner resolution surface exists (the house pattern)',
  );
});

test('the /jobs store persists the acceptance claim through state-guarded transactions with DB fences', () => {
  assert.ok(jobsStore.includes('FOR UPDATE'), 'row-locked claim transactions (job-first lock ordering)');
  assert.ok(/WHERE job_id = \$\d+ AND status = 'offered'/.test(jobsStore), 'the job acceptance is state-guarded');
  assert.ok(
    /WHERE job_offer_id = \$\d+ AND status = 'open'/.test(jobsStore),
    'the offer claim is state-guarded',
  );
  assert.ok(jobsStore.includes("terminal_reason = 'lost'"), 'losing offers terminalize as expired (reason lost)');
  assert.ok(jobsStore.includes('ON CONFLICT (job_id) DO NOTHING'), 'the one-outcome-per-job fence converges');
});
