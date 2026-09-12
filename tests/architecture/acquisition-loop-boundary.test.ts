/**
 * MKT-034 static tests — THE ACQUISITION LOOP COMPOSITION CANNOT BECOME A
 * SECOND AUTHORITY (pure static analysis, no DB).
 *
 * Proofs (implementation-contract §1 "there is no /pilots authority" and no
 * /loops authority either; AGENTS.md "No extension, human, model, worker,
 * Domain Pack or frontend may become an alternate authority" + "Workflow
 * state belongs only to /workflows" + "AI routing belongs only to
 * /ai-runtime" + "Evidence/provenance belongs only to /evidence" + "Client
 * isolation is enforced server-side before dependent traversal"; work-
 * items.md MKT-034 "prove ... without bypassing authority boundaries"; the
 * src/workers/acquisition-pilot/ MKT-028 composition precedent):
 *   1. NO /loops module exists and NO loop route is registered — the loop
 *      stays a composition, never an authority (frozen module list);
 *   2. the acquisition-loop files import ONLY frozen module PUBLIC
 *      entries (no module internals anywhere);
 *   3. the composed authority set is EXACTLY the documented eleven
 *      (/goals /playbooks /workflows /executions /jobs /evidence /metrics
 *      /experiments /extensions /ai-runtime /learnings) plus the platform
 *      error contract — no /workspaces, no /clients, no /field-agents, no
 *      /policies, no /reporting, no composition-root import (the extension
 *      publish/review/install chain and the Decision Room read are driven
 *      by the loop's CALLERS through their own public HTTP surfaces);
 *   4. NO database access of any kind: no Db import, no SQL, no migration
 *      reference, no object-store/queue port — the loop owns NO state;
 *   5. the mutation surface is exactly the documented authority mutation
 *      ports (plus the two delegated execution ports the frozen contracts
 *      hand to callers: /ai-runtime routeTask and /extensions
 *      beginExtensionInvocation) — every member call on the deps goes
 *      through the allow-list;
 *   6. template.ts is PURE: type-only module imports, no async, no I/O;
 *   7. START IS FAIL-CLOSED BEFORE ANY WRITE: in startLoopInstance the
 *      five documented bounds all appear BEFORE the first mutation port
 *      call (source-order proof);
 *   8. STOP-ONLY-FUTURE: the stop check rejects stopped/invalidated/
 *      concluded experiments for NEW starts, and the file contains no
 *      history-rewriting operation of any kind (no deletes, no updates,
 *      no supersede-deletion paths);
 *   9. no authority-bypass escape hatches: no direct table writes, no
 *      caller-identity authorization (the only ownership resolutions are
 *      the canonical /goals and /ai-runtime reads), no unbounded loops
 *      over authority state;
 *  10. the deployment descriptor carries ONLY authority-owned identity —
 *      no loop-owned state fields;
 *  11. the wiring pins the template's node ids for all THREE execution
 *      legs (the §7 task linkage, the §19 extension invocation boundary
 *      and the §18 projection use the SAME constants the template graph
 *      declares — the composition cannot drift).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const loopDir = join(repoRoot, 'src', 'workers', 'acquisition-loop');
const loopFiles = readdirSync(loopDir)
  .filter((name) => name.endsWith('.ts'))
  .sort();
const loopSources = new Map(
  loopFiles.map((name) => [name, readFileSync(join(loopDir, name), 'utf8')]),
);
const flow = loopSources.get('loop-flow.ts') ?? '';
const template = loopSources.get('template.ts') ?? '';
const contract = loopSources.get('contract.ts') ?? '';
const routes = readFileSync(join(repoRoot, 'src', 'api', 'routes.ts'), 'utf8');
const modulesDir = join(repoRoot, 'src', 'modules');

test('NO /loops authority exists: no loops module and no loop route anywhere', () => {
  assert.ok(!existsSync(join(modulesDir, 'loops')), 'no src/modules/loops may exist');
  for (const module of readdirSync(modulesDir)) {
    const publicFile = join(modulesDir, module, 'public.ts');
    if (!existsSync(publicFile)) continue;
    const source = readFileSync(publicFile, 'utf8');
    // The generic workflow-graph 'loop' NODE TYPE (WorkflowLoopContract)
    // is a frozen /workflows concept — what no module may carry is the
    // ACQUISITION LOOP composition authority.
    assert.ok(
      !source.includes('AcquisitionLoop'),
      `module '${module}' public contract must not carry acquisition-loop authority`,
    );
    assert.ok(
      !source.includes('acquisition-loop'),
      `module '${module}' public contract must not reference the acquisition-loop composition`,
    );
  }
  assert.ok(!existsSync(join(repoRoot, 'src', 'api', 'loops-routes.ts')), 'no loop route file may exist');
  assert.ok(!routes.includes('/api/loops'), 'no /api/loops route may be registered');
  assert.ok(!routes.includes('acquisition-loop'), 'routes.ts wires no loop surface');
});

test('the acquisition-loop files import ONLY frozen module public entries (no internals)', () => {
  for (const [file, source] of loopSources) {
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

test('the composed authority set is EXACTLY the documented eleven module publics + platform errors', () => {
  const moduleImports = new Set<string>();
  for (const [, source] of loopSources) {
    for (const match of source.matchAll(/from '\.\.\/\.\.\/modules\/([a-z-]+)\/public\.ts'/g)) {
      moduleImports.add(match[1]!);
    }
  }
  assert.deepEqual([...moduleImports].sort(), [
    'ai-runtime',
    'evidence',
    'executions',
    'experiments',
    'extensions',
    'goals',
    'jobs',
    'learnings',
    'metrics',
    'playbooks',
    'workflows',
  ]);
  // The loop NEVER composes the tenant/membership/profile/policy/read-side
  // authorities and never imports the composition root.
  for (const forbidden of [
    'clients',
    'workspaces',
    'agencies',
    'field-agents',
    'users',
    'auth',
    'policies',
    'reporting',
    'integrations',
    'domain-packs',
  ]) {
    assert.ok(!moduleImports.has(forbidden), `the loop must not compose '${forbidden}'`);
  }
  for (const [file, source] of loopSources) {
    assert.ok(
      !source.includes('composition-root'),
      `${file} may not import the composition root (test-harness wiring constructs the service)`,
    );
  }
  // Platform imports stay on the error contract only.
  for (const match of flow.matchAll(/from '\.\.\/\.\.\/platform\/([^']+)'/g)) {
    assert.equal(match[1], 'errors/errors.ts', `loop-flow.ts imports only the platform error contract`);
  }
});

test('NO database access of any kind — the loop owns NO durable state', () => {
  for (const [file, source] of loopSources) {
    assert.ok(!source.includes('platform/db'), `${file} must not import the database platform`);
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
  // The deps interface carries ONLY the eleven module APIs (no db, no
  // clock, no queue, no object store, no provider adapter — the adapter is
  // supplied per routeTask CALL through the ProviderAdapter port, never
  // wired as composition state).
  const depsBlock = flow.slice(
    flow.indexOf('export interface AcquisitionLoopDeps'),
    flow.indexOf('}', flow.indexOf('export interface AcquisitionLoopDeps')),
  );
  const memberTypes = [...depsBlock.matchAll(/readonly \w+: ([A-Za-z]+ModuleApi)/g)].map((match) => match[1]!);
  assert.deepEqual(
    [...new Set(memberTypes)].sort(),
    [
      'AiRuntimeModuleApi',
      'EvidenceModuleApi',
      'ExecutionsModuleApi',
      'ExperimentsModuleApi',
      'ExtensionsModuleApi',
      'GoalsModuleApi',
      'JobsModuleApi',
      'LearningsModuleApi',
      'MetricsModuleApi',
      'PlaybooksModuleApi',
      'WorkflowsModuleApi',
    ],
    'the composed deps are exactly the eleven authority public contracts',
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
    // The two DELEGATED execution ports the frozen contracts hand to
    // callers: the /ai-runtime routing decision (MKT-018 route contract —
    // caller-supplied adapter through the ProviderAdapter port) and the
    // /extensions §19 invocation-context derivation (MKT-022).
    'aiRuntime.getTaskProfile',
    'aiRuntime.routeTask',
    'extensions.beginExtensionInvocation',
    'learnings.createLearning',
    'learnings.getLearning',
    'learnings.listLearningsForClient',
  ];
  for (const call of flow.matchAll(/this\.deps\.([a-zA-Z]+)\.([a-zA-Z]+)\(/g)) {
    const port = `${call[1]}.${call[2]}` as `${string}.${string}`;
    assert.ok(
      allowedPorts.includes(port),
      `this.deps.${port}() is not a documented authority port — the mutation surface is closed`,
    );
  }
  // And the loop actually composes every one of the eleven authorities.
  for (const authority of [
    'goals',
    'playbooks',
    'workflows',
    'executions',
    'jobs',
    'evidence',
    'metrics',
    'experiments',
    'extensions',
    'aiRuntime',
    'learnings',
  ]) {
    assert.ok(
      new RegExp(`this\\.deps\\.${authority}\\.`).test(flow),
      `the wiring must compose the '${authority}' authority`,
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
    'buildExtensionManifest',
    'buildExperimentDeclaration',
    'acquisitionLoopTemplate',
    'evaluateLoopGuardrails',
  ]) {
    assert.ok(template.includes(`export function ${builder}`), `template.ts exports the pure builder '${builder}'`);
  }
});

test('START IS FAIL-CLOSED: the five documented bounds all precede the first write in startLoopInstance', () => {
  const start = flow.slice(
    flow.indexOf('async startLoopInstance'),
    flow.indexOf('async createAiTaskExecution'),
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
    /stopping blocks future loop instance selection only and never rewrites recorded history/,
    'the stop gate documents the stop-only-future semantics',
  );
  // No history-rewriting operation exists anywhere in the composition. The
  // ONLY supersession-shaped field is the explicit null on the evidence
  // append input (append-only record creation, never a rewrite).
  for (const [file, source] of loopSources) {
    for (const forbidden of [
      'deleteGoal',
      'updateGoalStatus',
      'setGoalStatus(',
      'updatePlaybookVersionContent',
      'updateWorkflowDefinitionContent',
      'updateWorkflowProfile',
      'updateGoalContent',
      'transitionExperimentBack',
      'retireTaskProfile',
      'retireModel',
      'setExtensionInstallStatus',
      'configureExtension',
      'installExtension',
      'registerExtensionVersion',
      'recordLearningRelationship',
    ]) {
      assert.ok(!source.includes(forbidden), `${file} must not contain the history-rewriting/authority operation '${forbidden}'`);
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

test('NO AUTHORITY BYPASS: no direct store access and ownership resolves only through canonical authority reads', () => {
  for (const [file, source] of loopSources) {
    assert.ok(!source.includes('.query('), `${file} never issues SQL`);
    assert.ok(!source.includes('.transaction('), `${file} never opens a database transaction`);
  }
  // The only ownership authorizations are the canonical resolutions — the
  // caller's ids are input, never authorization: /goals for the deploy/start
  // gate, /ai-runtime's own TaskProfile record (scope re-fenced against the
  // deployment's workspace) before the routing call, and the §19 invocation
  // resolves the execution's canonical owner INSIDE the /extensions
  // authority (the loop composes the port; it never derives scope itself).
  assert.match(flow, /this\.deps\.goals\.resolveGoalOwnership\(/);
  assert.match(flow, /this\.deps\.aiRuntime\.getTaskProfile\(/);
  assert.match(flow, /profile\.workspaceId !== input\.deployment\.workspaceId/);
  assert.ok(!/scope:\s*\{[^}]*agencyId:\s*input\./s.test(flow), 'the loop never derives tenant scope from caller input');
  // Every NotFoundError surfaces uniformly (no existence oracle).
  const notFoundCount = (flow.match(/throw new NotFoundError\(/g) ?? []).length;
  assert.ok(notFoundCount >= 5, 'foreign/unknown identifiers surface uniform NotFoundErrors');
});

test('the deployment descriptor carries ONLY authority-owned identities (no loop state)', () => {
  const contractBlock = contract.slice(
    contract.indexOf('export interface AcquisitionLoopDeployment'),
    contract.indexOf('}', contract.indexOf('export interface AcquisitionLoopDeployment')),
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
  assert.ok(!fields.includes('status'), 'the deployment carries no loop-owned status');
  assert.ok(!fields.includes('version'), 'the deployment carries no loop-owned CAS token');
  // The extension identity is deliberately NOT a deployment field (the
  // MKT-032/MKT-022 boundary owns it).
  assert.ok(!fields.includes('extensionId'), 'the deployment carries no extension identity (the §19 boundary owns it)');
});

test('the wiring pins the template node ids for ALL THREE execution legs (no drift between graph and composition)', () => {
  assert.match(flow, /nodeId: LOOP_AI_NODE/);
  assert.match(flow, /nodeId: LOOP_EXTENSION_NODE/);
  assert.match(flow, /nodeId: LOOP_FIELD_NODE/);
  // The graph declares exactly those three executable legs plus the entry,
  // join and terminal structure nodes.
  const templateGraph = template;
  assert.ok(templateGraph.includes(`nodeId: LOOP_ENTRY_NODE`));
  assert.ok(templateGraph.includes('nodeType: \'ai_task\''));
  assert.ok(templateGraph.includes('nodeType: \'human_task\''));
  assert.ok(templateGraph.includes('nodeType: \'extension_capability\''));
  assert.ok(templateGraph.includes('nodeType: \'join\''));
  assert.ok(templateGraph.includes('nodeType: \'terminal\''));
  // The join releases only after ALL THREE legs arrive.
  assert.ok(templateGraph.includes('predecessors: [LOOP_AI_NODE, LOOP_FIELD_NODE, LOOP_EXTENSION_NODE]'));
});
