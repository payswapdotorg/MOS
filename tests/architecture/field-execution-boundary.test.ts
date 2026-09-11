/**
 * MKT-027 static tests — the field-execution boundary is structurally
 * correct in the ACTUAL migration, module contract and routes (pure
 * static analysis, no DB). Proves the frozen architecture boundaries
 * (spec/work-items.md MKT-027; spec/human-agent-v1.3.md §3/§5/§6;
 * spec/evidence-and-experimentation.md; spec/module-dependency-matrix.md;
 * architecture.md §13; JOB-001 field subset + EVID-001 field subset;
 * JOB-AC-03..04; EVID-AC-01..03 field subset):
 *
 *   1. migration 024 creates EXACTLY the four /jobs field-execution
 *      tables (job_visits, job_visit_transitions, job_visit_outcomes,
 *      job_visit_evidence) — no second workflow/execution engine
 *      structures;
 *   2. the visit scope chain is INHERITED from the Job (FK-backed +
 *      scope-chain trigger ties the visit scope to the job scope), the
 *      acceptance-window trigger fences visits to jobs.status='accepted',
 *      and the identity-immutability trigger freezes identity/scope/
 *      target/follow-up/provenance;
 *   3. the visit status machine is trigger-enforced edge-for-edge and
 *      equals the code registry (VISIT_STATUSES/VISIT_TRANSITIONS);
 *      completed/cancelled are terminal in both; the follow-up link is
 *      fenced to a COMPLETED visit of the SAME relationship;
 *   4. the transition history is append-only with full provenance and
 *      legal-edge-fenced;
 *   5. JOB-AC-03 field-subset storage: job_visit_outcomes is
 *      append-only (UPDATE/DELETE rejected), exactly one per visit
 *      (UNIQUE(visit_id)), carries the server-derived provenance
 *      columns, the frozen field-result vocabulary and the same-Client
 *      evidence trigger; job_visit_evidence is append-only and
 *      same-Client fenced;
 *   6. NO SECOND WORKFLOW/EXECUTION ENGINE (JOB-001): the /jobs module
 *      files (including the MKT-027 visit files) import ONLY the frozen
 *      matrix public contracts and NEVER invoke the /workflows instance
 *      mutation port; no visit file carries graph/node-instance/
 *      dispatch/queue/sandbox semantics;
 *   7. EVID-AC-03 (no self-authorized promotion): there is NO evidence
 *      class-mutation path — the /jobs module calls ONLY the /evidence
 *      public append/read/resolve ports; no file in /jobs can mutate an
 *      evidence record (the /evidence module has no update surface at
 *      all, and /jobs never constructs an evidence row by SQL);
 *   8. the routes register ONLY the field-execution surfaces under
 *      /api/jobs/:jobId/visits/…, compose the SAME authorization
 *      helpers as the MKT-026 jobs routes (no private permission
 *      engine), reject every provenance/ownership-shaped DTO field
 *      (§23), and build provenance server-side;
 *   9. the continuity route is the JOB-AC-04 policy gate: the accepted
 *      agent's view goes through visitContinuityExposedToAgent (the
 *      single checkpoint over the frozen /field-agents profile policy
 *      block) and the gated response structurally carries NO
 *      prior-visit data;
 *   10. the shared registration files wire the surface (routes.ts
 *       registers registerJobsVisitsRoutes; application.ts and
 *       composition-root document the MKT-027 additions).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VISIT_RESULTS,
  VISIT_STATUSES,
  VISIT_TERMINAL_STATUSES,
} from '../../src/modules/jobs/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
const read = (path: string): string => readFileSync(path, 'utf8');

const migration024 = read(src('platform', 'db', 'migrations', '024_field_execution.sql'));
const jobsPublic = read(src('modules', 'jobs', 'public.ts'));
const visitModule = read(src('modules', 'jobs', 'internal', 'visit-module.ts'));
const visitStore = read(src('modules', 'jobs', 'internal', 'visit-store.ts'));
const jobsModuleFile = read(src('modules', 'jobs', 'internal', 'module.ts'));
const visitsRoutes = read(src('api', 'jobs-visits-routes.ts'));
const jobsRoutesFile = read(src('api', 'jobs-routes.ts'));
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
// 1. Exactly the four /jobs field-execution tables
// ---------------------------------------------------------------------------

test('migration 024 creates exactly the FOUR field-execution tables (no engine structures)', () => {
  const createdTables = [...migration024.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    [...createdTables].sort(),
    ['job_visit_evidence', 'job_visit_outcomes', 'job_visit_transitions', 'job_visits'],
    'migration 024 must create exactly the visit, transition-history, outcome and evidence-link tables',
  );
  // No workflow/execution engine structures appear anywhere: the visit
  // tables reference ONLY the Job authority (plus the house tenant and
  // evidence tables through the documented fences) — never the workflow
  // node/instance bookkeeping, dispatch queues or sandbox leases.
  for (const forbidden of [
    'REFERENCES workflow_nodes',
    'REFERENCES workflow_instances',
    'REFERENCES executions',
    'REFERENCES execution_dispatches',
    'REFERENCES sandboxes',
  ]) {
    assert.ok(
      !migration024.includes(forbidden),
      `no ${forbidden} linkage in the field-execution migration (visits carry no task linkage of their own)`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. The visit scope chain is INHERITED from the Job (never caller input)
// ---------------------------------------------------------------------------

test('job_visits: the scope chain is FK-backed and trigger-fenced to the JOB scope (inherited)', () => {
  const visitsBlock = createTableBlock(migration024, 'job_visits');
  const columns = columnsOf(visitsBlock);
  for (const required of [
    'visit_id',
    'job_id',
    'visit_seq',
    'workspace_id',
    'client_id',
    'agency_id',
    'target_identity',
    'status',
    'scheduled_at',
    'started_at',
    'completed_at',
    'cancelled_at',
    'follow_up_of_visit_id',
    'created_by',
    'recorded_actor',
    'recorded_via',
    'correlation_id',
    'causation_id',
    'version',
    'created_at',
    'updated_at',
  ]) {
    assert.ok(columns.includes(required), `job_visits.${required} required`);
  }
  assert.ok(
    visitsBlock.includes('job_id                uuid        NOT NULL REFERENCES jobs(job_id)'),
    'the visit belongs to exactly ONE Job (FK, no cascade — history protects the job row)',
  );
  assert.ok(visitsBlock.includes('REFERENCES workspaces(workspace_id)'));
  assert.ok(visitsBlock.includes('REFERENCES clients(client_id)'));
  assert.ok(visitsBlock.includes('REFERENCES agencies(agency_id)'));
  // The scope-chain trigger ties the visit scope to the JOB scope.
  assert.ok(migration024.includes('CREATE OR REPLACE FUNCTION job_visits_scope_chain()'));
  const scopeChain = migration024.match(/CREATE OR REPLACE FUNCTION job_visits_scope_chain\(\)([\s\S]*?)\$\$ LANGUAGE plpgsql;/)![1]!;
  assert.ok(scopeChain.includes('FROM jobs'));
  assert.ok(scopeChain.includes('NEW.workspace_id <> v_workspace_id'));
  // The acceptance-window trigger fences visits to the acceptance window.
  assert.ok(migration024.includes('CREATE OR REPLACE FUNCTION job_visits_job_acceptance()'));
  const acceptance = migration024.match(/CREATE OR REPLACE FUNCTION job_visits_job_acceptance\(\)([\s\S]*?)\$\$ LANGUAGE plpgsql;/)![1]!;
  assert.ok(acceptance.includes("v_status <> 'accepted'"));
  // The identity-immutability trigger freezes identity/scope/target/
  // follow-up/provenance.
  assert.ok(migration024.includes('CREATE OR REPLACE FUNCTION job_visits_identity_immutable()'));
  const immutable = migration024.match(/CREATE OR REPLACE FUNCTION job_visits_identity_immutable\(\)([\s\S]*?)\$\$ LANGUAGE plpgsql;/)![1]!;
  for (const guard of [
    'NEW.job_id <> OLD.job_id',
    'NEW.visit_seq <> OLD.visit_seq',
    'NEW.workspace_id <> OLD.workspace_id',
    'NEW.client_id <> OLD.client_id',
    'NEW.agency_id <> OLD.agency_id',
    'NEW.target_identity <> OLD.target_identity',
    'NEW.follow_up_of_visit_id IS DISTINCT FROM OLD.follow_up_of_visit_id',
    'NEW.recorded_actor <> OLD.recorded_actor',
  ]) {
    assert.ok(immutable.includes(guard), `identity immutability must guard: ${guard}`);
  }
});

test('job_visits: the per-job sequence fence and the timestamp↔state CHECKs exist', () => {
  assert.ok(
    migration024.includes('CONSTRAINT job_visits_seq_key UNIQUE (job_id, visit_seq)'),
    'the per-job visit order fence must exist',
  );
  const visitsBlock = createTableBlock(migration024, 'job_visits');
  assert.ok(
    visitsBlock.includes("CHECK ((status IN ('in_progress', 'completed')) = (started_at IS NOT NULL))"),
    'started_at exists exactly in the executed states',
  );
  assert.ok(
    visitsBlock.includes("CHECK ((status = 'completed') = (completed_at IS NOT NULL))"),
    'completed_at exists exactly in the completed state',
  );
  assert.ok(
    visitsBlock.includes("CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))"),
    'cancelled_at exists exactly in the cancelled state',
  );
});

// ---------------------------------------------------------------------------
// 3. The frozen visit state machine (DB == code) + the follow-up fence
// ---------------------------------------------------------------------------

test('the DB visit status CHECK enumerates exactly the code registry VISIT_STATUSES', () => {
  const visitsBlock = createTableBlock(migration024, 'job_visits');
  const checkMatch = visitsBlock.match(
    /status\s+text\s+NOT NULL DEFAULT 'planned'\s*\n?\s*CHECK \(status IN \(([^)]+)\)/,
  );
  assert.ok(checkMatch !== null, 'job_visits.status must carry the frozen vocabulary CHECK');
  const dbStatuses = checkMatch[1]!
    .split(',')
    .map((entry) => entry.trim().replace(/^'|'$/g, ''));
  assert.deepEqual([...dbStatuses].sort(), [...VISIT_STATUSES].sort());
});

test('the DB visit state machine trigger encodes exactly the frozen transition table; terminal frozen', () => {
  const transitionFunction = migration024.match(
    /CREATE OR REPLACE FUNCTION job_visits_transition_legal\(from_status text, to_status text\)([\s\S]*?)\$\$ LANGUAGE plpgsql IMMUTABLE;/,
  );
  assert.ok(transitionFunction !== null, 'the transition predicate function must exist');
  const body = transitionFunction[1]!;
  assert.ok(
    body.includes("from_status = 'planned' AND to_status IN ('in_progress', 'cancelled')"),
    'the planned → in_progress | cancelled edges must be encoded',
  );
  assert.ok(
    body.includes("from_status = 'in_progress' AND to_status IN ('completed', 'cancelled')"),
    'the in_progress → completed | cancelled edges must be encoded',
  );
  // Terminal states are frozen by the row trigger (including a completed
  // visit — the outcome stands and cannot be cancelled after the fact).
  const stateMachine = migration024.match(
    /CREATE OR REPLACE FUNCTION job_visits_frozen_state_machine\(\)([\s\S]*?)\$\$ LANGUAGE plpgsql;/,
  )![1]!;
  for (const terminal of VISIT_TERMINAL_STATUSES) {
    assert.ok(stateMachine.includes(`'${terminal}'`), `terminal ${terminal} must be frozen`);
  }
});

test('the follow-up link is fenced to a COMPLETED visit of the SAME relationship', () => {
  assert.ok(migration024.includes('CREATE OR REPLACE FUNCTION job_visits_follow_up_consistent()'));
  const followUp = migration024.match(
    /CREATE OR REPLACE FUNCTION job_visits_follow_up_consistent\(\)([\s\S]*?)\$\$ LANGUAGE plpgsql;/,
  )![1]!;
  assert.ok(followUp.includes('v_target <> NEW.target_identity'), 'same target identity');
  assert.ok(followUp.includes('v_client_id <> NEW.client_id'), 'same client');
  assert.ok(followUp.includes("v_status <> 'completed'"), 'the prior visit must be COMPLETED');
});

// ---------------------------------------------------------------------------
// 4. The append-only transition history with full provenance
// ---------------------------------------------------------------------------

test('job_visit_transitions: append-only, legal-edge-fenced, full provenance columns', () => {
  const transitionsBlock = createTableBlock(migration024, 'job_visit_transitions');
  const columns = columnsOf(transitionsBlock);
  for (const required of [
    'transition_id',
    'visit_id',
    'from_status',
    'to_status',
    'reason',
    'created_by',
    'recorded_actor',
    'recorded_via',
    'correlation_id',
    'causation_id',
    'created_at',
  ]) {
    assert.ok(columns.includes(required), `job_visit_transitions.${required} required`);
  }
  assert.ok(migration024.includes('CREATE OR REPLACE FUNCTION job_visit_transitions_legal()'));
  assert.ok(migration024.includes('CREATE OR REPLACE FUNCTION job_visit_transitions_append_only()'));
  assert.ok(
    /BEFORE\s+UPDATE\s+OR\s+DELETE\s+ON\s+job_visit_transitions/.test(migration024),
    'the transition history rejects UPDATE and DELETE',
  );
});

// ---------------------------------------------------------------------------
// 5. JOB-AC-03 field-subset storage — the structured visit outcome
// ---------------------------------------------------------------------------

test('job_visit_outcomes: append-only, exactly one per visit, provenance columns, frozen vocabulary, same-Client evidence fence', () => {
  const outcomesBlock = createTableBlock(migration024, 'job_visit_outcomes');
  const columns = columnsOf(outcomesBlock);
  for (const required of [
    'visit_outcome_id',
    'visit_id',
    'result',
    'follow_up_required',
    'notes',
    'observations',
    'evidence_ref',
    'recorded_actor',
    'recorded_via',
    'correlation_id',
    'causation_id',
    'submitted_by',
    'submitted_at',
    'created_at',
  ]) {
    assert.ok(columns.includes(required), `job_visit_outcomes.${required} required (JOB-AC-03)`);
  }
  assert.ok(
    outcomesBlock.includes('CONSTRAINT job_visit_outcomes_visit_key UNIQUE (visit_id)'),
    'exactly one outcome per visit (the replay convergence fence)',
  );
  assert.ok(
    outcomesBlock.includes("result IN ('succeeded', 'partial', 'no_contact', 'failed')"),
    'the frozen field-result vocabulary',
  );
  assert.ok(
    outcomesBlock.includes("jsonb_typeof(observations) = 'object' AND observations <> '{}'::jsonb"),
    'observations must be a non-empty JSON object (traceable structured content)',
  );
  assert.ok(
    outcomesBlock.includes('evidence_ref      uuid        NOT NULL REFERENCES evidence(evidence_id)'),
    'the evidence reference is FK-backed to the /evidence authority (REQUIRED)',
  );
  assert.ok(migration024.includes('CREATE OR REPLACE FUNCTION job_visit_outcomes_append_only()'));
  assert.ok(
    /BEFORE\s+UPDATE\s+OR\s+DELETE\s+ON\s+job_visit_outcomes/.test(migration024),
    'the outcome history rejects UPDATE and DELETE',
  );
  assert.ok(
    migration024.includes('CREATE OR REPLACE FUNCTION job_visit_outcomes_evidence_same_client()'),
    'the same-Client evidence backstop must exist (the job_outcomes/metrics pattern)',
  );
});

test('job_visit_evidence: append-only capture links, same-Client fenced, (visit, evidence) key', () => {
  const evidenceBlock = createTableBlock(migration024, 'job_visit_evidence');
  assert.ok(
    evidenceBlock.includes('CONSTRAINT job_visit_evidence_key PRIMARY KEY (visit_id, evidence_id)'),
    'one link per (visit, evidence) pair',
  );
  assert.ok(
    evidenceBlock.includes('evidence_id     uuid        NOT NULL REFERENCES evidence(evidence_id)'),
    'the link is FK-backed to the /evidence authority',
  );
  for (const provenance of ['recorded_actor', 'recorded_via', 'correlation_id', 'causation_id']) {
    assert.ok(evidenceBlock.includes(provenance), `job_visit_evidence.${provenance} required`);
  }
  assert.ok(migration024.includes('CREATE OR REPLACE FUNCTION job_visit_evidence_append_only()'));
  assert.ok(migration024.includes('CREATE OR REPLACE FUNCTION job_visit_evidence_same_client()'));
});

// ---------------------------------------------------------------------------
// 6. NO SECOND WORKFLOW/EXECUTION ENGINE (JOB-001) — the module boundary
// ---------------------------------------------------------------------------

test('the /jobs module (including the MKT-027 visit files) imports ONLY allowed public contracts', () => {
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

test('the visit files NEVER invoke the /workflows instance mutation port and carry no engine semantics', () => {
  for (const file of [jobsPublic, visitModule, visitStore, jobsModuleFile, visitsRoutes]) {
    assert.ok(
      !file.includes('transitionWorkflowInstance('),
      'field execution never commands workflow state transitions (Workflow authority preserved)',
    );
    assert.ok(!file.includes('workflow-graph.ts'));
  }
  // The visit store SQL carries no workflow/graph/dispatch bookkeeping.
  for (const forbidden of [
    'workflow_instances',
    'workflow_nodes',
    'node_status',
    'next_node',
    'execution_dispatches',
    'sandboxes',
    'acquireLease',
    'runtimeClass',
    'dispatch',
  ]) {
    assert.ok(!visitStore.includes(forbidden), `the visit store carries no ${forbidden} semantics`);
  }
  // The visit module is composed INSIDE the same createJobsModule (one
  // authority — no second module registration).
  assert.ok(jobsModuleFile.includes("import { createVisitOperations } from './visit-module.ts'"));
  assert.ok(jobsModuleFile.includes('const visits = createVisitOperations(deps, store)'));
  assert.ok(jobsModuleFile.includes('...visits,'));
});

test('the visit lifecycle is subordinate to the Job acceptance window (no forked Job state machine)', () => {
  // The visit module NEVER writes the jobs.status column: the MKT-026
  // Job state machine is untouched by field execution.
  for (const forbidden of [
    "UPDATE jobs SET status",
    'markJobOffered',
    'applyJobAccepted',
    'markJobOutcomeSubmitted',
    'applyJobRoundClosed',
  ]) {
    assert.ok(!visitModule.includes(forbidden), `the visit module must not touch the job status machine (${forbidden})`);
    assert.ok(!visitStore.includes(forbidden), `the visit store must not touch the job status machine (${forbidden})`);
  }
  // Only jobs.lockJob is shared (the house job-first lock ordering).
  assert.ok(visitModule.includes('jobsStore.lockJob(tx,'));
});

// ---------------------------------------------------------------------------
// 7. EVID-AC-03 — NO self-authorized promotion (no class-mutation path)
// ---------------------------------------------------------------------------

test('EVID-AC-03: the /jobs module calls ONLY the /evidence public append/read/resolve ports — no mutation path', () => {
  // The only /evidence module API invocations in the whole /jobs module.
  const evidenceCalls = [
    ...visitModule.matchAll(/\bevidence\.([A-Za-z]+)\(/g),
    ...jobsModuleFile.matchAll(/\bevidence\.([A-Za-z]+)\(/g),
  ].map((match) => match[1]!);
  const allowedCalls = new Set([
    'appendEvidence',
    'resolveEvidenceOwnership',
    'getEvidence',
    'listEvidenceForClient',
  ]);
  for (const call of evidenceCalls) {
    assert.ok(
      allowedCalls.has(call),
      `/jobs may only consume the /evidence public ports (found evidence.${call})`,
    );
  }
  // The field-capture path appends evidence records THROUGH the module
  // (never raw SQL against the evidence table).
  for (const file of [visitModule, visitStore, jobsModuleFile]) {
    assert.ok(!file.includes('INSERT INTO evidence'), `${file}: no direct evidence-table SQL`);
    assert.ok(!file.includes('UPDATE evidence'), `${file}: no evidence mutation SQL`);
    assert.ok(!file.includes('DELETE FROM evidence'), `${file}: no evidence deletion SQL`);
  }
  // Field capture declares the class ONCE (validated against the frozen
  // set) — there is no re-declaration/promotion anywhere.
  assert.ok(visitModule.includes('supersedesEvidenceId: null'), 'field capture never supersedes');
  assert.ok(visitModule.includes("system: FIELD_AGENT_RECORDED_VIA"), 'the source system is server-stamped');
});

// ---------------------------------------------------------------------------
// 8. The routes surface
// ---------------------------------------------------------------------------

test('the visits routes register ONLY the field-execution surfaces and compose the shared authorization', () => {
  const registered = [...visitsRoutes.matchAll(/'(?:GET|POST|PUT|PATCH|DELETE)',\s*'(\/[^']+)'/g)]
    .map((match) => match[1]!)
    .sort();
  assert.deepEqual(registered, [
    '/api/jobs/:jobId/visits',
    '/api/jobs/:jobId/visits',
    '/api/jobs/:jobId/visits/:visitId',
    '/api/jobs/:jobId/visits/:visitId/cancel',
    '/api/jobs/:jobId/visits/:visitId/complete',
    '/api/jobs/:jobId/visits/:visitId/continuity',
    '/api/jobs/:jobId/visits/:visitId/evidence',
    '/api/jobs/:jobId/visits/:visitId/evidence',
    '/api/jobs/:jobId/visits/:visitId/outcome',
    '/api/jobs/:jobId/visits/:visitId/start',
    '/api/jobs/:jobId/visits/:visitId/transitions',
  ].sort());

  // Shared authorization composition (no private permission engine): the
  // posture helpers are imported FROM jobs-routes.ts (one /jobs surface).
  assert.ok(visitsRoutes.includes("from './jobs-routes.ts'"));
  assert.ok(visitsRoutes.includes('canReadFullJob'));
  assert.ok(visitsRoutes.includes('requireJob'));
  assert.ok(visitsRoutes.includes("from './authorize.ts'"));
  assert.ok(visitsRoutes.includes('resolveContext'));
});

test('DTO authority-field rejection: every field-execution mutation surface forbids provenance/ownership fields (§23)', () => {
  for (const fieldSet of [
    'VISIT_OPEN_AUTHORITY_FIELDS',
    'VISIT_TRANSITION_AUTHORITY_FIELDS',
    'VISIT_OUTCOME_AUTHORITY_FIELDS',
    'VISIT_EVIDENCE_AUTHORITY_FIELDS',
  ]) {
    assert.ok(visitsRoutes.includes(`const ${fieldSet} = [`), `${fieldSet} required`);
  }
  const outcomeFields = visitsRoutes.match(
    /const VISIT_OUTCOME_AUTHORITY_FIELDS = \[([\s\S]*?)\] as const;/,
  )![1]!;
  for (const key of [
    'recordedActor',
    'recordedVia',
    'correlationId',
    'causationId',
    'provenance',
    'submittedBy',
    'submittedAt',
  ]) {
    assert.ok(outcomeFields.includes(`'${key}'`), `outcome DTO must reject the provenance key ${key}`);
  }
  const evidenceFields = visitsRoutes.match(
    /const VISIT_EVIDENCE_AUTHORITY_FIELDS = \[([\s\S]*?)\] as const;/,
  )![1]!;
  for (const key of ['source', 'sourceSystem', 'supersedes', 'supersededBy', 'clientId', 'workspaceId']) {
    assert.ok(
      evidenceFields.includes(`'${key}'`),
      `evidence-capture DTO must reject the authority key ${key}`,
    );
  }
});

test('visit provenance is built server-side from the principal and ambient correlation (never the body)', () => {
  const provenanceFn = visitsRoutes.match(
    /function visitProvenance\(principal: Principal, jobId: string\) \{([\s\S]*?)\n\}/,
  )![1]!;
  assert.ok(provenanceFn.includes('auditActor(principal)'));
  assert.ok(provenanceFn.includes('currentCorrelation()'));
  assert.ok(provenanceFn.includes("recordedVia: 'api'"));
});

// ---------------------------------------------------------------------------
// 9. JOB-AC-04 — the continuity policy gate at the route
// ---------------------------------------------------------------------------

test('JOB-AC-04: the continuity route applies the policy checkpoint and the gated view carries NO prior-visit data', () => {
  assert.ok(visitsRoutes.includes('visitContinuityExposedToAgent'));
  assert.ok(
    visitsRoutes.includes('view.agentContinuityPolicy'),
    'the policy INPUT is the agent profile block resolved server-side',
  );
  // The gated response structurally carries no prior-visit entries.
  const gatedMatch = visitsRoutes.match(/gated: true,\s*\n\s*gatedReason:[\s\S]*?priorVisits: \[\] as unknown\[\],/);
  assert.ok(gatedMatch !== null, 'the gated agent view must return an empty priorVisits array');
  // Only the accepted agent is gated; the commissioning side reads the
  // full chain (client scope owns the data).
  assert.ok(visitsRoutes.includes('isAcceptedAgent'));
  assert.ok(
    visitsRoutes.includes("ctx.principal.userId === job.acceptedUserId"),
    'the accepted agent is identified from the authenticated principal',
  );
});

test('JOB-AC-04: the module resolves the continuity chain as DERIVED data (a read — no history rewrite)', () => {
  // The continuity lookup reads job_visits; it never writes visit rows.
  assert.ok(visitStore.includes('listCompletedVisitsOfRelationship'));
  const continuityQuery = visitStore.match(
    /SELECT[\s\S]*?FROM job_visits[\s\S]*?AND status = 'completed' AND visit_id <> \$4/,
  );
  assert.ok(continuityQuery !== null, 'the chain query selects COMPLETED visits, excluding the current one');
  // The pure checkpoint is exported from the module public contract (the
  // single swap point for the future /policies authority).
  assert.ok(jobsPublic.includes('export function visitContinuityExposedToAgent'));
  assert.ok(
    jobsPublic.includes('MKT-021'),
    'the swap-point contract documents the /policies authority handoff',
  );
});

// ---------------------------------------------------------------------------
// 10. The shared registration files wire the surface
// ---------------------------------------------------------------------------

test('routes.ts registers the visits routes; the shared files document the MKT-027 additions', () => {
  assert.ok(routesFile.includes("import { registerJobsVisitsRoutes } from './jobs-visits-routes.ts'"));
  assert.ok(routesFile.includes('registerJobsVisitsRoutes(router, services, modules)'));
  assert.ok(applicationFile.includes('MKT-027'));
  assert.ok(compositionRoot.includes('MKT-027'));
  assert.ok(compositionRoot.includes('024_field_execution.sql'));
});

test('the jobs-routes posture helpers are exported for the visits surface (one authorization posture)', () => {
  for (const helper of [
    'export async function requireJob',
    'export async function jobOwnerScope',
    'export async function canReadFullJob',
    'export function actorUserId',
  ]) {
    assert.ok(jobsRoutesFile.includes(helper), `jobs-routes must export ${helper}`);
  }
});

test('VISIT_RESULTS registry matches the DB CHECK vocabulary (no drift)', () => {
  const outcomesBlock = createTableBlock(migration024, 'job_visit_outcomes');
  const checkMatch = outcomesBlock.match(/result\s+text\s+NOT NULL CHECK \(result IN \(([^)]+)\)/);
  assert.ok(checkMatch !== null);
  const dbResults = checkMatch[1]!
    .split(',')
    .map((entry) => entry.trim().replace(/^'|'$/g, ''));
  assert.deepEqual([...dbResults].sort(), [...VISIT_RESULTS].sort());
});
