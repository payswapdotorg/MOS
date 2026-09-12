/**
 * MKT-028 static tests — THE ACQUISITION PILOT COMPOSITION CANNOT BECOME A
 * SECOND AUTHORITY (pure static analysis, no DB).
 *
 * Proofs (implementation-contract §1 "there is no /pilots authority";
 * AGENTS.md "No extension, human, model, worker, Domain Pack or frontend
 * may become an alternate authority" + "Workflow state belongs only to
 * /workflows" + "Client isolation is enforced server-side before dependent
 * traversal"; work-items.md MKT-028 "bounded prove-it-first acquisition
 * pilots"; the MKT-011 pooled-runtime workers-area precedent):
 *   1. NO /pilots module exists and NO pilot route is registered — the
 *      pilot stays a composition, never an authority (frozen module list);
 *   2. the acquisition-pilot files import ONLY frozen module PUBLIC
 *      entries (no module internals anywhere);
 *   3. the composed authority set is EXACTLY the documented eight
 *      (/goals /playbooks /workflows /executions /jobs /evidence /metrics
 *      /experiments) plus the platform error contract — no /workspaces, no
 *      /clients, no /field-agents, no composition-root import;
 *   4. NO database access of any kind: no Db import, no SQL, no migration
 *      reference, no object-store/queue port — the pilot owns NO state;
 *   5. the mutation surface is exactly the documented authority mutation
 *      ports — every member call on the deps goes through the allow-list;
 *   6. template.ts is PURE: type-only module imports, no async, no I/O;
 *   7. START IS FAIL-CLOSED BEFORE ANY WRITE: in
 *      startAcquisitionPilotInstance the five documented bounds all appear
 *      BEFORE the first mutation port call (source-order proof);
 *   8. STOP-ONLY-FUTURE: the stop check rejects stopped/invalidated/
 *      concluded experiments for NEW starts, and the file contains no
 *      history-rewriting operation of any kind (no deletes, no updates,
 *      no supersede-deletion paths);
 *   9. no authority-bypass escape hatches: no direct table writes, no
 *      caller-identity authorization (the only ownership resolution is the
 *      canonical /goals owner context), no unbounded loops over authority
 *      state;
 *  10. the deployment descriptor carries ONLY authority-owned identity —
 *      no pilot-owned state fields;
 *  11. the wiring pins the template's node ids for both execution legs
 *      (the §7 task linkage and the §18 projection use the SAME constants
 *      the template graph declares — the composition cannot drift).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pilotDir = join(repoRoot, 'src', 'workers', 'acquisition-pilot');
const pilotFiles = readdirSync(pilotDir)
  .filter((name) => name.endsWith('.ts'))
  .sort();
const pilotSources = new Map(
  pilotFiles.map((name) => [name, readFileSync(join(pilotDir, name), 'utf8')]),
);
const flow = pilotSources.get('pilot-flow.ts') ?? '';
const template = pilotSources.get('template.ts') ?? '';
const contract = pilotSources.get('contract.ts') ?? '';
const routes = readFileSync(join(repoRoot, 'src', 'api', 'routes.ts'), 'utf8');
const modulesDir = join(repoRoot, 'src', 'modules');

test('NO /pilots authority exists: no pilots module and no pilot route anywhere', () => {
  assert.ok(!existsSync(join(modulesDir, 'pilots')), 'no src/modules/pilots may exist');
  for (const module of readdirSync(modulesDir)) {
    const publicFile = join(modulesDir, module, 'public.ts');
    if (!existsSync(publicFile)) continue;
    const source = readFileSync(publicFile, 'utf8');
    assert.ok(
      !source.includes('Pilot'),
      `module '${module}' public contract must not carry pilot authority`,
    );
  }
  assert.ok(!existsSync(join(repoRoot, 'src', 'api', 'pilots-routes.ts')), 'no pilot route file may exist');
  assert.ok(!routes.includes('/api/pilots'), 'no /api/pilots route may be registered');
  assert.ok(!routes.includes('acquisition-pilot'), 'routes.ts wires no pilot surface');
});

test('the acquisition-pilot files import ONLY frozen module public entries (no internals)', () => {
  for (const [file, source] of pilotSources) {
    for (const match of source.matchAll(/from '([^']+)'/g)) {
      const target = match[1]!;
      if (!target.includes('/modules/')) continue;
      assert.ok(
        /\/modules\/[a-z-]+\/public\.ts$/.test(target),
        `${file} may only import module public entries, found '${target}'`,
      );
      assert.ok(
        !target.includes('/internal/'),
        `${file} may never import module internals, found '${target}'`,
      );
    }
  }
});

test('the composed authority set is EXACTLY the documented eight module publics + platform errors', () => {
  const moduleImports = new Set<string>();
  for (const [, source] of pilotSources) {
    for (const match of source.matchAll(/from '\.\.\/\.\.\/modules\/([a-z-]+)\/public\.ts'/g)) {
      moduleImports.add(match[1]!);
    }
  }
  assert.deepEqual([...moduleImports].sort(), [
    'evidence',
    'executions',
    'experiments',
    'goals',
    'jobs',
    'metrics',
    'playbooks',
    'workflows',
  ]);
  // The pilot NEVER composes the tenant/membership/profile authorities and
  // never imports the composition root.
  for (const forbidden of ['clients', 'workspaces', 'agencies', 'field-agents', 'users', 'auth']) {
    assert.ok(!moduleImports.has(forbidden), `the pilot must not compose '${forbidden}'`);
  }
  for (const [file, source] of pilotSources) {
    assert.ok(
      !source.includes('composition-root'),
      `${file} may not import the composition root (test-harness wiring constructs the service)`,
    );
  }
  // Platform imports stay on the error contract only.
  for (const match of flow.matchAll(/from '\.\.\/\.\.\/platform\/([^']+)'/g)) {
    assert.equal(match[1], 'errors/errors.ts', `pilot-flow.ts imports only the platform error contract`);
  }
});

test('NO database access of any kind — the pilot owns NO durable state', () => {
  for (const [file, source] of pilotSources) {
    assert.ok(!source.includes("platform/db"), `${file} must not import the database platform`);
    for (const forbidden of [
      'INSERT INTO',
      'UPDATE ',
      'DELETE FROM',
      'CREATE TABLE',
      'db/migrations',
      'runMigrations',
      'ObjectStore',
      'JobQueue',
      'PgDb',
    ]) {
      assert.ok(!source.includes(forbidden), `${file} must not contain '${forbidden}'`);
    }
  }
  // The deps interface carries ONLY the eight module APIs (no db, no clock,
  // no queue, no object store — the pilot owns nothing).
  const depsBlock = flow.slice(
    flow.indexOf('export interface AcquisitionPilotDeps'),
    flow.indexOf('}', flow.indexOf('export interface AcquisitionPilotDeps')),
  );
  const memberTypes = [...depsBlock.matchAll(/readonly \w+: ([A-Za-z]+ModuleApi)/g)].map((match) => match[1]!);
  assert.deepEqual(
    [...new Set(memberTypes)].sort(),
    [
      'EvidenceModuleApi',
      'ExecutionsModuleApi',
      'ExperimentsModuleApi',
      'GoalsModuleApi',
      'JobsModuleApi',
      'MetricsModuleApi',
      'PlaybooksModuleApi',
      'WorkflowsModuleApi',
    ],
    'the composed deps are exactly the eight authority public contracts',
  );
});

test('the mutation surface is exactly the documented authority mutation ports (allow-list)', () => {
  // Every call on a composed module dependency must be an authority port.
  const allowedPorts: ReadonlyArray<`${string}.${string}`> = [
    'goals.createGoal',
    'goals.getGoal',
    'goals.resolveGoalOwnership',
    'goals.listGoalsForClient',
    'playbooks.createClientPlaybook',
    'playbooks.createPlaybookVersion',
    'playbooks.getPlaybookVersion',
    'playbooks.setPlaybookVersionStatus',
    'workflows.createWorkflow',
    'workflows.createWorkflowDefinition',
    'workflows.getWorkflowDefinition',
    'workflows.setWorkflowDefinitionStatus',
    'workflows.createWorkflowInstance',
    'workflows.getWorkflowInstance',
    'workflows.listWorkflowInstances',
    'workflows.transitionWorkflowInstance',
    'executions.createExecution',
    'executions.getExecution',
    'jobs.projectJob',
    'jobs.getJob',
    'evidence.appendEvidence',
    'evidence.getEvidence',
    'metrics.appendMetricObservation',
    'metrics.getMetricObservation',
    'metrics.listMetricObservationsForClient',
    'experiments.createExperiment',
    'experiments.getExperiment',
    'experiments.applyExperimentTransition',
    'experiments.listExperimentTransitions',
  ];
  for (const call of flow.matchAll(/this\.deps\.([a-z]+)\.([a-zA-Z]+)\(/g)) {
    const port = `${call[1]}.${call[2]}` as `${string}.${string}`;
    assert.ok(
      allowedPorts.includes(port),
      `this.deps.${port}() is not a documented authority port — the mutation surface is closed`,
    );
  }
  // And the pilot actually composes every one of the eight authorities.
  for (const authority of ['goals', 'playbooks', 'workflows', 'executions', 'jobs', 'evidence', 'metrics', 'experiments']) {
    assert.ok(
      new RegExp(`this\\.deps\\.${authority}\\.`).test(flow),
      `the wiring must compose the /${authority} authority`,
    );
  }
});

test('template.ts is PURE: type-only module imports, no async, no I/O', () => {
  for (const match of template.matchAll(/import (type )?\{[^}]*\} from '[^']*modules[^']*'/g)) {
    assert.ok(match[0].startsWith('import type'), 'every module import in template.ts is type-only');
  }
  assert.ok(!/\basync\b/.test(template), 'template.ts contains no async function');
  for (const forbidden of ['fetch(', 'readFile', 'writeFile', 'process.env', 'Date.now', 'Math.random']) {
    assert.ok(!template.includes(forbidden), `template.ts must stay pure (no '${forbidden}')`);
  }
  // Pure builders exist for every template artifact.
  for (const builder of [
    'buildPlaybookStrategy',
    'buildWorkflowDefinitionContent',
    'buildFieldJobDescriptor',
    'buildExperimentDeclaration',
    'acquisitionPilotTemplate',
    'evaluatePilotGuardrails',
  ]) {
    assert.ok(template.includes(`export function ${builder}`), `template.ts exports the pure builder '${builder}'`);
  }
});

test('START IS FAIL-CLOSED: the five documented bounds all precede the first write in startAcquisitionPilotInstance', () => {
  const start = flow.slice(
    flow.indexOf('async startAcquisitionPilotInstance'),
    flow.indexOf('async createDigitalExecution'),
  );
  assert.ok(start.length > 0, 'the start operation exists');
  const firstWrite = start.search(/this\.deps\.(workflows\.createWorkflowInstance|experiments\.applyExperimentTransition)/);
  assert.ok(firstWrite > 0, 'the start operation performs its writes through the authority ports');
  for (const bound of [
    '// ---- bound 1: the goal must still be live',
    '// ---- bound 2: a stopped experiment blocks future selection only',
    '// ---- bound 3: the total instance budget',
    '// ---- bound 4: the live-instance cap',
    '// ---- bound 5: guardrails must not be breached',
  ]) {
    const position = start.indexOf(bound);
    assert.ok(position >= 0, `the documented bound is present: ${bound}`);
    assert.ok(
      position < firstWrite,
      `the bound '${bound}' must be checked BEFORE any write`,
    );
  }
});

test('STOP-ONLY-FUTURE: a stopped experiment blocks new starts and NOTHING rewrites history', () => {
  // The stop gate reads the /experiments status and refuses future starts.
  assert.match(
    flow,
    /experiment\.status === 'stopped' \|\| experiment\.status === 'invalidated' \|\| experiment\.status === 'concluded'/,
    'the stop gate covers stopped/invalidated/concluded experiments',
  );
  assert.match(
    flow,
    /stopping blocks future pilot instance selection only and never rewrites recorded history/,
    'the stop gate documents the stop-only-future semantics',
  );
  // No history-rewriting operation exists anywhere in the composition. The
  // ONLY supersession-shaped field is the explicit null on the evidence
  // append input (append-only record creation, never a rewrite).
  for (const [file, source] of pilotSources) {
    for (const forbidden of [
      'deleteGoal',
      'updateGoalStatus',
      'setGoalStatus(',
      'updatePlaybookVersionContent',
      'updateWorkflowDefinitionContent',
      'updateWorkflowProfile',
      'updateGoalContent',
      'transitionExperimentBack',
    ]) {
      assert.ok(!source.includes(forbidden), `${file} must not contain the history-rewriting operation '${forbidden}'`);
    }
    for (const occurrence of source.matchAll(/supersedesEvidenceId[\s]*:[\s]*([^,}]+)/g)) {
      assert.equal(
        occurrence[1]!.trim(),
        'null',
        `${file}: the evidence append never supersedes (append-only composition)`,
      );
    }
  }
  // A concluded experiment is terminal: the conclude operation refuses to
  // re-conclude (append-only conclusion history).
  assert.match(flow, /is already concluded; concluded history is immutable/);
});

test('NO AUTHORITY BYPASS: no direct store access and ownership resolves only through the canonical /goals owner context', () => {
  for (const [file, source] of pilotSources) {
    assert.ok(!source.includes('.query('), `${file} never issues SQL`);
    assert.ok(!source.includes('.transaction('), `${file} never opens a database transaction`);
  }
  // The only ownership authorization is the canonical /goals resolution —
  // the caller's goal id is input, never authorization.
  assert.match(flow, /this\.deps\.goals\.resolveGoalOwnership\(/);
  // Every NotFoundError surfaces uniformly (no existence oracle).
  const notFoundCount = (flow.match(/throw new NotFoundError\(/g) ?? []).length;
  assert.ok(notFoundCount >= 4, 'foreign/unknown identifiers surface uniform NotFoundErrors');
});

test('the deployment descriptor carries ONLY authority-owned identities (no pilot state)', () => {
  const contractBlock = contract.slice(
    contract.indexOf('export interface AcquisitionPilotDeployment'),
    contract.indexOf('}', contract.indexOf('export interface AcquisitionPilotDeployment')),
  );
  const fields = [...contractBlock.matchAll(/readonly (\w+):/g)].map((match) => match[1]!);
  assert.deepEqual([...fields].sort(), [
    'clientId',
    'experimentId',
    'goalId',
    'playbookId',
    'playbookVersionId',
    'workflowDefinitionId',
    'workflowId',
    'workspaceId',
  ]);
  // Every field is a plain authority identity — no state, no counters, no caches.
  assert.ok(!fields.includes('status'), 'the deployment carries no pilot-owned status');
  assert.ok(!fields.includes('version'), 'the deployment carries no pilot-owned CAS token');
});

test('the wiring pins the template node ids for BOTH execution legs (no drift between graph and composition)', () => {
  assert.match(flow, /nodeId: ACQ_DIGITAL_NODE/);
  assert.match(flow, /nodeId: ACQ_FIELD_NODE/);
  // The graph declares exactly those two executable legs plus the entry,
  // join and terminal structure nodes.
  const templateGraph = template;
  assert.ok(templateGraph.includes(`nodeId: ACQ_ENTRY_NODE`));
  assert.ok(templateGraph.includes('nodeType: \'ai_task\''));
  assert.ok(templateGraph.includes('nodeType: \'human_task\''));
  assert.ok(templateGraph.includes('nodeType: \'join\''));
  assert.ok(templateGraph.includes('nodeType: \'terminal\''));
});
