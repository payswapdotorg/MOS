/**
 * MKT-042 static tests — the Decision Ledger domain is structurally correct
 * in the ACTUAL migration, module contract and route surface (pure static
 * analysis, no DB).
 *
 * Proofs (spec/architecture-v1.5.md §4; the primary contract
 * spec/operating-graph-v1.5.md "Decision Ledger"; frozen by
 * spec/architecture-lock-v1.5.md rule #5 and spec/change-request-005.md
 * change #2; frozen matrix registration
 * /decisions ──→ /evidence, /experiments, /learnings, /executions,
 * /deployments, /policies, /clients, /workspaces):
 *   1. migration 036 (the MKT-042-reserved number) creates exactly
 *      `decisions` + `decision_events` with the full frozen record
 *      vocabulary: immutable opaque id, Client ownership FK (no cascade),
 *      optional Workspace scope FK, the Agency through the canonical
 *      /clients chain, objective/context/hypothesis_summary, the evidence
 *      citations + the experiment hypothesis link, the structured
 *      expected_impact + the SEPARATE uncertainty column, expected_cost,
 *      alternatives, the correction link, the SERVER-DERIVED proposer +
 *      provenance columns, the disposition enum with the successor/outcome
 *      shape CHECKs and the §8 (client_id, idempotency_key) create fence;
 *      the event tail carries the disposition/outcome payloads verbatim
 *      with the (decision_id, idempotency_key) command fence;
 *   2. decision ownership is EXACTLY the client_id FK (plus the optional
 *      workspace scope FK) — no owner/role/user columns, no decision
 *      column leaking into other frozen tables, no provider-state
 *      structures, no workflow/policy machinery (the ledger records
 *      decisions, it does not execute or gate them);
 *   3. lock rule #5 (static): the ledger is APPEND-ORIENTED —
 *      decision_events rejects UPDATE and DELETE; decisions rows are never
 *      erased (BEFORE DELETE trigger); the PROPOSAL columns are immutable
 *      (a BEFORE UPDATE trigger rejects every rewrite); the lifecycle
 *      columns change ONLY along the frozen legal edges (the
 *      legal-lifecycle trigger: proposed → accepted | rejected |
 *      superseded; the outcome exactly once on an accepted record); the
 *      workspace-within-client, correction-link, cross-tenant
 *      evidence/experiment and cross-tenant outcome-reference triggers
 *      exist as the race backstops;
 *   4. the /decisions public contract exposes the canonical owner-context
 *      resolution surface, the server-derived provenance + proposer
 *      argument types, the structural /clients + /workspaces ownership
 *      ports, the frozen disposition taxonomy, and imports ONLY allowed
 *      module publics (/evidence + /experiments + /learnings +
 *      /executions + /deployments — exactly the used subset of the frozen
 *      matrix row; NO provider SDKs, NO /clients//workspaces imports);
 *   5. the store's ONLY mutation surface is the legal lifecycle: INSERT
 *      with the §8 ON CONFLICT fence, the CAS disposition UPDATE (WHERE
 *      disposition = 'proposed') and the one-shot outcome UPDATE (WHERE
 *      disposition = 'accepted' AND observed_outcome IS NULL) — NO DELETE,
 *      and NO UPDATE ever touches a proposal column; the module validates
 *      every reference THROUGH the cited authorities' public contracts
 *      (getEvidence/getExperiment/getExecution/getDeployment/getLearning);
 *   6. the route surface is POST/GET only (no PATCH/PUT/DELETE — there is
 *      no update and no erase path), and the routes are exactly the six
 *      decisions surfaces;
 *   7. the DTO discipline is structural: the create/disposition/outcome
 *      forbidden authority-field lists include every provenance-shaped,
 *      proposer-shaped, lifecycle-authority and material key — callers can
 *      never inject identity, ownership, provenance, proposer or lifecycle
 *      state.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DECISION_DISPOSITIONS,
  DECISION_DISPOSITION_COMMANDS,
  DECISION_DISPOSITION_TABLE,
  DECISION_IMPACT_DIRECTIONS,
  TERMINAL_DECISION_DISPOSITIONS,
} from '../../src/modules/decisions/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migration036 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '036_decisions.sql'),
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
const migration027 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '027_learnings.sql'),
  'utf8',
);
const decisionsPublic = readFileSync(
  join(repoRoot, 'src', 'modules', 'decisions', 'public.ts'),
  'utf8',
);
const decisionsModule = readFileSync(
  join(repoRoot, 'src', 'modules', 'decisions', 'internal', 'decisions-module.ts'),
  'utf8',
);
const decisionsStore = readFileSync(
  join(repoRoot, 'src', 'modules', 'decisions', 'internal', 'decisions-store.ts'),
  'utf8',
);
const decisionsRoutes = readFileSync(
  join(repoRoot, 'src', 'api', 'decisions-routes.ts'),
  'utf8',
);

/** Extracts the CREATE TABLE block for `table` from a migration SQL text. */
function createTableBlock(migration: string, table: string): string {
  const marker = `CREATE TABLE IF NOT EXISTS ${table} (`;
  const start = migration.indexOf(marker);
  assert.ok(start >= 0, `migration must create ${table}`);
  // The block terminator is a `);` at the START of a line — inline `);`
  // sequences appear inside CHECK bodies and comments.
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

test('the decisions table carries the full frozen Decision Ledger record vocabulary', () => {
  const block = createTableBlock(migration036, 'decisions');
  const columns = columnsOf(block);
  for (const required of [
    'decision_id', // immutable opaque identifier (server-generated)
    'client_id', // Client ownership reference (FK) — hard boundary
    'workspace_id', // optional Workspace scope FK (within the Client)
    'agency_id', // the Agency through the canonical /clients chain
    'objective', // the decision objective (required bounded text)
    'context', // the decision context (optional bounded text)
    'hypothesis_summary', // the hypothesis summary informing the decision
    'experiment_ref', // the /experiments hypothesis link
    'evidence_refs', // cited /evidence record ids (jsonb array)
    'expected_impact', // structured expected impact (own column)
    'uncertainty', // the SEPARATE declared uncertainty (own column)
    'expected_cost', // the declared expected cost
    'alternatives', // the considered alternatives (jsonb array)
    'predecessor_decision_id', // the correction link (append-only trail)
    'proposer_actor', // SERVER-DERIVED proposer identity
    'proposer_role', // SERVER-DERIVED proposer role at proposal time
    'disposition', // the frozen lifecycle enum
    'successor_decision_id', // the supersede forward-link
    'disposition_at', // the disposition timestamp
    'observed_outcome', // the one-shot outcome observation
    'execution_ref', // the /executions implementation reference
    'deployment_ref', // the /deployments implementation reference
    'learning_ref', // the /learnings derived-learning reference
    'outcome_at', // the outcome timestamp
    'idempotency_key', // the §8 logical create key
    'create_fingerprint', // the §8 convergence proof
    'recorded_actor', // SERVER-DERIVED provenance: actor
    'recorded_via', // SERVER-DERIVED provenance: recording system
    'correlation_id', // SERVER-DERIVED provenance: correlation
    'causation_id', // SERVER-DERIVED provenance: causation
    'recorded_at', // SERVER-DERIVED provenance: recording timestamp
  ]) {
    assert.ok(columns.includes(required), `decisions.${required} required`);
  }
  // Client ownership FK backstop (no cascade — ledger history survives);
  // Workspace scope is an OPTIONAL FK; the agency rides the row.
  assert.ok(
    /client_id\s+uuid\s+NOT NULL REFERENCES clients\(client_id\)/.test(block),
    'Client ownership must be a NOT NULL FK to clients (no cascade)',
  );
  assert.ok(
    /workspace_id\s+uuid\s+REFERENCES workspaces\(workspace_id\)/.test(block),
    'Workspace scope must be a (nullable) FK to workspaces',
  );
  // Expected impact and uncertainty are TWO SEPARATE structured columns —
  // uncertainty is never conflated with impact.
  assert.ok(
    /expected_impact\s+jsonb\s+NOT NULL CHECK \(jsonb_typeof\(expected_impact\) = 'object'/.test(block),
    'expected_impact must be a structured jsonb object',
  );
  assert.ok(
    /uncertainty\s+jsonb\s+CHECK \(uncertainty IS NULL/.test(block),
    'uncertainty must be its own nullable jsonb column (never conflated)',
  );
  // The frozen disposition enum is a closed CHECK.
  for (const disposition of DECISION_DISPOSITIONS) {
    assert.ok(block.includes(`'${disposition}'`), `the disposition CHECK must enumerate '${disposition}'`);
  }
  assert.ok(!block.includes("'withdrawn'"), 'no free-string dispositions');
  // The lifecycle soundness CHECKs.
  assert.ok(
    /CONSTRAINT decision_successor_shape CHECK/.test(block),
    'only a superseded decision carries a successor (shape CHECK)',
  );
  assert.ok(
    /CONSTRAINT decision_outcome_refs_shape CHECK/.test(block),
    'at most ONE implementation reference (execution XOR deployment)',
  );
  assert.ok(
    /CONSTRAINT decision_outcome_pairing CHECK/.test(block),
    'the outcome observation and its timestamp pair up',
  );
});

test('decision ownership is exactly the client_id FK + optional workspace scope — no conflation, no provider state, no machinery', () => {
  const decisionColumns = columnsOf(createTableBlock(migration036, 'decisions'));
  for (const column of decisionColumns) {
    if (column === 'client_id' || column === 'workspace_id') continue;
    assert.ok(
      !/owner|user|admin|permission/.test(column),
      `decisions must not carry ownership/user columns (found '${column}')`,
    );
  }
  // No provider state, no workflow/policy/credential machinery: the ledger
  // records decisions, it does not execute or gate them.
  for (const column of decisionColumns) {
    assert.ok(
      !/provider|sdk|node_id|task_link|retry|credential|policy_version|workflow/.test(column),
      `decisions must not carry machinery columns (found '${column}')`,
    );
  }
  // The Client→Decision relationship lives ONLY in decisions.client_id:
  // no decision column leaks upward into the frozen tables, and migration
  // 036 must not redefine them.
  for (const [migration, table] of [
    [migration002, 'agencies'],
    [migration002, 'users'],
    [migration003, 'clients'],
    [migration004, 'workspaces'],
    [migration015, 'evidence'],
    [migration019, 'experiments'],
    [migration027, 'learnings'],
  ] as const) {
    for (const column of columnsOf(createTableBlock(migration, table))) {
      // NOTE: `experiments.decision_target` is the pre-existing §16
      // "which decision this experiment informs" TEXT field — not a
      // Decision Ledger reference. The leak pattern matches ledger-id
      // references only (decision_id / decision_ref).
      assert.ok(
        !/^decision(_id|_ref)/.test(column),
        `${table}.${column} — the Client→Decision Ledger relationship must not leak above /decisions`,
      );
    }
    assert.ok(
      !migration036.includes(`CREATE TABLE IF NOT EXISTS ${table} (`),
      `036 must not redefine the frozen ${table} table`,
    );
  }
  // Exactly the two /decisions tables — no policy engine, no operating
  // graph projections, no profit structures, no app state.
  const createdTables = [...migration036.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    createdTables,
    ['decisions', 'decision_events'],
    'migration 036 must create exactly the decisions + decision_events tables',
  );
});

test('lock rule #5 (static): the §8 fences and the append-only backstops exist in the migration', () => {
  // The §8 create fence: one logical create key per Client.
  assert.ok(
    /CREATE UNIQUE INDEX IF NOT EXISTS decisions_idempotency_key_unique\s*ON decisions \(client_id, idempotency_key\)/.test(
      migration036,
    ),
    'the create idempotency fence must be the (client_id, idempotency_key) unique index',
  );
  // The §8 command fence: one logical command key per decision.
  assert.ok(
    /CREATE UNIQUE INDEX IF NOT EXISTS decision_events_idempotency_key_unique\s*ON decision_events \(decision_id, idempotency_key\)/.test(
      migration036,
    ),
    'the event idempotency fence must be the (decision_id, idempotency_key) unique index',
  );
  // The event payload shape CHECK: a disposition event carries the
  // disposition (successor exactly when superseding); an outcome event
  // carries the observation with at most one implementation reference.
  const eventsBlock = createTableBlock(migration036, 'decision_events');
  for (const required of [
    'event_id',
    'decision_id',
    'event_kind',
    'disposition',
    'reason',
    'successor_decision_id',
    'observed_outcome',
    'execution_ref',
    'deployment_ref',
    'learning_ref',
    'idempotency_key',
    'recorded_actor',
    'recorded_via',
    'correlation_id',
    'causation_id',
    'recorded_at',
  ]) {
    assert.ok(columnsOf(eventsBlock).includes(required), `decision_events.${required} required`);
  }
  assert.ok(
    /CONSTRAINT decision_event_payload CHECK/.test(eventsBlock),
    'the event payload shape CHECK must exist',
  );
  assert.ok(
    eventsBlock.includes("(event_kind = 'disposition'"),
    'the disposition event shape must be constrained',
  );
  assert.ok(
    eventsBlock.includes("(event_kind = 'outcome_observed'"),
    'the outcome event shape must be constrained',
  );
  for (const kind of ['disposition', 'outcome_observed']) {
    assert.ok(eventsBlock.includes(`'${kind}'`), `the event kind CHECK must enumerate '${kind}'`);
  }
});

test('lock rule #5 (static): the ledger history is append-only at the database level', () => {
  // decision_events: UPDATE and DELETE are BOTH rejected by triggers —
  // not even server-side SQL can rewrite the event tail.
  assert.ok(
    migration036.includes('CREATE OR REPLACE FUNCTION decision_events_append_only()'),
    'the event append-only trigger function must exist',
  );
  assert.ok(
    migration036.includes('decision_events_append_only_update_trigger'),
    'the event BEFORE UPDATE trigger must be wired',
  );
  assert.ok(
    migration036.includes('decision_events_append_only_delete_trigger'),
    'the event BEFORE DELETE trigger must be wired',
  );
  assert.ok(
    migration036.includes('decision events are append-only'),
    'the event append-only rejection must be named (module error classification matches this marker)',
  );
  // decisions rows are never ERASED either.
  assert.ok(
    migration036.includes('CREATE OR REPLACE FUNCTION decisions_no_delete()'),
    'the no-delete trigger function must exist',
  );
  assert.ok(
    migration036.includes('decisions_no_delete_trigger'),
    'the decisions BEFORE DELETE trigger must be wired',
  );
  assert.ok(
    migration036.includes('decisions are append-only ledger history'),
    'the no-delete rejection must be named',
  );
});

test('lock rule #5 (static): the proposal columns are immutable — only the legal lifecycle edges may change a decision row', () => {
  // The proposal-immutability trigger covers EVERY proposal/audit column.
  assert.ok(
    migration036.includes('CREATE OR REPLACE FUNCTION decision_proposal_immutable()'),
    'the proposal-immutability trigger function must exist',
  );
  assert.ok(
    migration036.includes('decision_proposal_immutable_trigger'),
    'the proposal-immutability trigger must be wired on UPDATE',
  );
  const immutableBody = migration036
    .slice(
      migration036.indexOf('CREATE OR REPLACE FUNCTION decision_proposal_immutable()'),
      migration036.indexOf('$$ LANGUAGE plpgsql;', migration036.indexOf('decision_proposal_immutable()')),
    )
    .replace(/\s+/g, ' ');
  for (const column of [
    'decision_id',
    'client_id',
    'workspace_id',
    'agency_id',
    'objective',
    'context',
    'hypothesis_summary',
    'experiment_ref',
    'evidence_refs',
    'expected_impact',
    'uncertainty',
    'expected_cost',
    'alternatives',
    'predecessor_decision_id',
    'proposer_actor',
    'proposer_role',
    'idempotency_key',
    'create_fingerprint',
    'recorded_actor',
    'recorded_via',
    'correlation_id',
    'causation_id',
    'recorded_at',
  ]) {
    assert.ok(
      new RegExp(`NEW\\.${column}\\s+IS DISTINCT FROM OLD\\.${column}`).test(immutableBody),
      `the immutability trigger must guard '${column}'`,
    );
  }
  assert.ok(
    immutableBody.includes('the decision proposal payload is immutable'),
    'the immutability rejection must be named (module error classification matches this marker)',
  );

  // The legal-lifecycle trigger: ONLY proposed → accepted | rejected |
  // superseded; the outcome lands EXACTLY ONCE on an accepted record.
  assert.ok(
    migration036.includes('CREATE OR REPLACE FUNCTION decision_lifecycle_guard()'),
    'the legal-lifecycle trigger function must exist',
  );
  assert.ok(
    migration036.includes('decision_lifecycle_guard_trigger'),
    'the legal-lifecycle trigger must be wired on UPDATE',
  );
  const lifecycleBody = migration036.slice(
    migration036.indexOf('CREATE OR REPLACE FUNCTION decision_lifecycle_guard()'),
    migration036.indexOf('$$ LANGUAGE plpgsql;', migration036.indexOf('decision_lifecycle_guard()')),
  );
  for (const [from, to] of [
    ['proposed', 'accepted'],
    ['proposed', 'rejected'],
    ['proposed', 'superseded'],
  ] as const) {
    assert.ok(
      lifecycleBody.includes(`(OLD.disposition = '${from}' AND NEW.disposition = '${to}')`),
      `the legal edge ${from} → ${to} must be encoded`,
    );
  }
  assert.ok(
    lifecycleBody.includes('illegal decision disposition transition'),
    'the illegal-transition rejection must be named (module error classification matches this marker)',
  );
  assert.ok(
    lifecycleBody.includes('already recorded its observed outcome exactly once'),
    'the one-shot outcome rule must be encoded',
  );
  assert.ok(
    lifecycleBody.includes("only an accepted decision records an observed outcome"),
    'the outcome requires the accepted disposition',
  );
  // A supersede must name a LIVE same-Client correction successor whose
  // predecessor points back.
  assert.ok(
    lifecycleBody.includes('supersede requires a live correction successor'),
    'the supersede successor rule must be named (module error classification matches this marker)',
  );
  assert.ok(
    lifecycleBody.includes('s.predecessor_decision_id = OLD.decision_id'),
    'the successor must declare THIS decision as its predecessor',
  );
});

test('the tenant fences exist as the race backstops (workspace scope, correction link, proposal refs, outcome refs)', () => {
  // Workspace-within-client.
  assert.ok(
    migration036.includes('CREATE OR REPLACE FUNCTION decision_workspace_within_client()'),
    'the workspace-within-client trigger must exist',
  );
  const scopeBody = migration036.slice(
    migration036.indexOf('CREATE OR REPLACE FUNCTION decision_workspace_within_client()'),
    migration036.indexOf('$$ LANGUAGE plpgsql;', migration036.indexOf('decision_workspace_within_client()')),
  );
  assert.ok(
    scopeBody.includes('w.workspace_id = NEW.workspace_id AND w.client_id = NEW.client_id'),
    'the trigger must require the workspace to belong to the record client',
  );

  // Correction-link legality: exists, same Client, not already superseded.
  assert.ok(
    migration036.includes('CREATE OR REPLACE FUNCTION decision_predecessor_legal()'),
    'the correction-link trigger must exist',
  );
  const predecessorBody = migration036.slice(
    migration036.indexOf('CREATE OR REPLACE FUNCTION decision_predecessor_legal()'),
    migration036.indexOf('$$ LANGUAGE plpgsql;', migration036.indexOf('decision_predecessor_legal()')),
  );
  assert.ok(
    predecessorBody.includes('v_predecessor_disposition = \'superseded\''),
    'the trigger must reject an already-superseded predecessor',
  );
  assert.ok(
    predecessorBody.includes('cross-tenant correction links are rejected'),
    'the cross-tenant predecessor rejection must be named',
  );

  // Proposal references: every cited evidence ref + the experiment link
  // must belong to the SAME Client.
  assert.ok(
    migration036.includes('CREATE OR REPLACE FUNCTION decision_proposal_refs_same_client()'),
    'the proposal-reference trigger must exist',
  );
  const refsBody = migration036.slice(
    migration036.indexOf('CREATE OR REPLACE FUNCTION decision_proposal_refs_same_client()'),
    migration036.indexOf('$$ LANGUAGE plpgsql;', migration036.indexOf('decision_proposal_refs_same_client()')),
  );
  assert.ok(
    refsBody.includes('jsonb_array_elements_text(NEW.evidence_refs)'),
    'the trigger must fence EVERY cited evidence ref',
  );
  assert.ok(
    refsBody.includes('cross-tenant evidence linkage is rejected'),
    'the cross-tenant evidence rejection must be named (module error classification matches this marker)',
  );
  assert.ok(
    refsBody.includes('cross-tenant experiment linkage is rejected'),
    'the cross-tenant experiment rejection must be named (module error classification matches this marker)',
  );

  // Outcome references: the execution/deployment/learning refs must belong
  // to the SAME Client (checked on the UPDATE path).
  assert.ok(
    migration036.includes('CREATE OR REPLACE FUNCTION decision_outcome_refs_same_client()'),
    'the outcome-reference trigger must exist',
  );
  const outcomeRefsBody = migration036.slice(
    migration036.indexOf('CREATE OR REPLACE FUNCTION decision_outcome_refs_same_client()'),
    migration036.indexOf('$$ LANGUAGE plpgsql;', migration036.indexOf('decision_outcome_refs_same_client()')),
  );
  for (const authority of ['learnings', 'executions', 'deployments']) {
    assert.ok(
      outcomeRefsBody.includes(`FROM ${authority} WHERE`),
      `the trigger must fence the /${authority} reference`,
    );
  }
  assert.ok(
    outcomeRefsBody.includes('cross-tenant decision outcome references are rejected'),
    'the cross-tenant outcome rejection must be named (module error classification matches this marker)',
  );
});

test('the /decisions public contract exposes canonical owner resolution over allowed dependencies only (frozen matrix)', () => {
  assert.ok(
    decisionsPublic.includes('export interface DecisionOwnerContext'),
    'DecisionOwnerContext must be part of the public contract',
  );
  assert.ok(
    decisionsPublic.includes('resolveDecisionOwnership'),
    'canonical ownership resolution must be part of the module API',
  );
  assert.ok(
    decisionsPublic.includes("kind: 'decision'"),
    'the owner context must carry the decision-scoped scope shape',
  );
  assert.ok(
    decisionsPublic.includes('export function composeDecisionOwnerContext'),
    'the pure composer must be exported',
  );
  // Provenance and proposer are separate, server-derived input dimensions.
  assert.ok(
    decisionsPublic.includes('export interface DecisionProvenance'),
    'the server-derived provenance argument type must be part of the contract',
  );
  assert.ok(
    decisionsPublic.includes('export interface DecisionProposer'),
    'the server-derived proposer argument type must be part of the contract',
  );
  // The /clients + /workspaces ownership resolution arrives as STRUCTURAL
  // PORTS (the frozen matrix row lists /clients + /workspaces; the ports
  // keep the required resolution server-side without a direct import).
  assert.ok(
    decisionsPublic.includes('export interface DecisionsClientOwnershipPort'),
    'the structural /clients ownership port must be declared',
  );
  assert.ok(
    decisionsPublic.includes('export interface DecisionsWorkspaceOwnershipPort'),
    'the structural /workspaces ownership port must be declared',
  );
  // The frozen taxonomies are part of the module contract.
  assert.ok(
    decisionsPublic.includes('export const DECISION_DISPOSITIONS'),
    'the frozen disposition taxonomy must be exported',
  );
  assert.ok(
    decisionsPublic.includes('export const DECISION_DISPOSITION_TABLE'),
    'the frozen transition table must be exported',
  );

  // Dependency matrix: /decisions ──→ /evidence, /experiments, /learnings,
  // /executions, /deployments, /policies, /clients, /workspaces. The
  // public entry imports exactly the reference-validation authorities
  // (the used subset; /policies stays the reserved unused direction and
  // /clients//workspaces arrive through the structural ports).
  const imports = [...decisionsPublic.matchAll(/from '\.\.\/([\w-]+)\/public\.ts'/g)].map(
    (match) => match[1]!,
  );
  for (const imported of [...new Set(imports)]) {
    assert.ok(
      ['evidence', 'experiments', 'learnings', 'executions', 'deployments'].includes(imported),
      `public.ts may only import allowed module publics (found '${imported}'; frozen matrix: /decisions ──→ /evidence, /experiments, /learnings, /executions, /deployments, /policies, /clients, /workspaces)`,
    );
  }
  assert.deepEqual(
    [...new Set(imports)].sort(),
    ['deployments', 'evidence', 'executions', 'experiments', 'learnings'],
    'public.ts imports exactly the reference-validation public contracts',
  );
  for (const forbidden of [
    'clients',
    'workspaces',
    'agencies',
    'auth',
    'workflows',
    'metrics',
    'integrations',
    'extensions',
    'domain-packs',
    'ai-runtime',
    'jobs',
    'policies',
  ]) {
    assert.ok(
      !decisionsPublic.includes(`from '../${forbidden}/`),
      `public.ts must not import the /${forbidden} module (frozen matrix; /policies stays the reserved unused direction; /clients//workspaces arrive as structural ports)`,
    );
  }
  // No provider SDKs anywhere in the module.
  for (const source of [decisionsPublic, decisionsModule, decisionsStore]) {
    assert.ok(!/from 'openai|anthropic|google|@ai-sdk|LangChain/i.test(source), 'no provider SDK imports');
  }
});

test('the store’s only mutation surface is the legal lifecycle (no DELETE, no proposal rewrite)', () => {
  // NO DELETE anywhere — ledger history is never erased through the store.
  assert.equal(
    [...decisionsStore.matchAll(/DELETE FROM decisions?\b/g)].length,
    0,
    'the store must never DELETE decision rows',
  );
  assert.equal(
    [...decisionsStore.matchAll(/DELETE FROM decision_events\b/g)].length,
    0,
    'the store must never DELETE event rows',
  );
  // The ONLY two UPDATE statements are the CAS disposition and the
  // one-shot outcome — and they touch ONLY the lifecycle columns.
  const updates = [...decisionsStore.matchAll(/UPDATE decisions SET ([^W]*)/g)].map(
    (match) => match[1]!.replace(/\s+/g, ' ').trim(),
  );
  assert.equal(updates.length, 2, `exactly two UPDATE statements (found ${updates.length})`);
  for (const update of updates) {
    for (const forbidden of [
      'objective',
      'context',
      'hypothesis_summary',
      'experiment_ref',
      'evidence_refs',
      'expected_impact',
      'uncertainty',
      'expected_cost',
      'alternatives',
      'predecessor_decision_id',
      'proposer_actor',
      'proposer_role',
      'idempotency_key',
      'create_fingerprint',
    ]) {
      assert.ok(
        !update.includes(forbidden),
        `the store UPDATE must never touch the proposal column '${forbidden}'`,
      );
    }
  }
  // The CAS guards: disposition transitions only from 'proposed'; the
  // outcome only on an accepted record that has not observed one yet.
  assert.ok(
    decisionsStore.includes("WHERE decision_id = $1 AND disposition = 'proposed'"),
    'the disposition UPDATE must CAS on the proposed state',
  );
  assert.ok(
    decisionsStore.includes("WHERE decision_id = $1 AND disposition = 'accepted' AND observed_outcome IS NULL"),
    'the outcome UPDATE must CAS on accepted + not-yet-observed',
  );
  // The §8 create fence: ON CONFLICT (client_id, idempotency_key).
  assert.ok(
    decisionsStore.includes('ON CONFLICT (client_id, idempotency_key) DO NOTHING'),
    'the create must fence through the (client_id, idempotency_key) unique constraint',
  );
  // The event inserts are the append-only history tail.
  assert.equal(
    [...decisionsStore.matchAll(/INSERT INTO decision_events/g)].length,
    2,
    'exactly the disposition + outcome event inserts',
  );
  // The module validates references THROUGH the cited authorities' public
  // contracts — no direct table reach-in, no internals import.
  assert.ok(
    decisionsModule.includes('await evidence.getEvidence('),
    'evidence references validate through the /evidence public contract',
  );
  assert.ok(
    decisionsModule.includes('await experiments.getExperiment('),
    'experiment references validate through the /experiments public contract',
  );
  assert.ok(
    decisionsModule.includes('await executions.getExecution('),
    'execution references validate through the /executions public contract',
  );
  assert.ok(
    decisionsModule.includes('await deployments.getDeployment('),
    'deployment references validate through the /deployments public contract',
  );
  assert.ok(
    decisionsModule.includes('await learnings.getLearning('),
    'learning references validate through the /learnings public contract',
  );
  // No other authority's machinery runs inside the ledger.
  for (const source of [decisionsModule, decisionsStore]) {
    assert.ok(
      !/createExecution|dispatchExecution|applyWorkflow|evaluateAction|appendEvidence\(|createExperiment/i.test(
        source,
      ),
      'the decisions module runs no other authority\'s machinery',
    );
  }
});

test('the route surface is POST/GET registrations only, and exactly the six decisions surfaces', () => {
  const registrations = [
    ...decisionsRoutes.matchAll(/router\.add\(\s*'([A-Z]+)',\s*'([^']+)'/g),
  ].map((match) => [match[1]!, match[2]!] as const);
  assert.deepEqual(
    registrations,
    [
      ['POST', '/api/clients/:clientId/decisions'],
      ['GET', '/api/clients/:clientId/decisions'],
      ['GET', '/api/decisions/:decisionId'],
      ['POST', '/api/decisions/:decisionId/disposition'],
      ['POST', '/api/decisions/:decisionId/outcome'],
      ['GET', '/api/decisions/:decisionId/events'],
    ],
    'the decisions surface is exactly record/list/read/disposition/outcome/history',
  );
  for (const [method] of registrations) {
    assert.ok(
      method === 'POST' || method === 'GET',
      `no mutation verb other than the record/disposition/outcome commands (found ${method})`,
    );
  }
  // NO PATCH/PUT/DELETE anywhere: there is no update and no erase path —
  // corrections are NEW records; the proposal payload is immutable.
  assert.ok(!/'(PATCH|PUT|DELETE)'/.test(decisionsRoutes), 'no PATCH/PUT/DELETE routes');
  // No second permission/role engine in the routes (authorization composes
  // the /agencies membership authority).
  assert.ok(
    !/role.*engine|permissionTable|canAccess|hasPermission/.test(decisionsRoutes),
    'no alternate permission authority in the routes',
  );
  // Provenance AND proposer are built server-side in the routes (never
  // from the body).
  assert.ok(
    decisionsRoutes.includes('function serverProvenance('),
    'the routes must build provenance server-side',
  );
  assert.ok(
    decisionsRoutes.includes('async function serverProposer('),
    'the routes must derive the proposer server-side from durable membership',
  );
});

test('the DTO discipline is structural: provenance, proposer, lifecycle and material authority are caller-rejected on every write surface', () => {
  const createAuthorityList = decisionsRoutes.slice(
    decisionsRoutes.indexOf('const DECISION_CREATE_AUTHORITY_FIELDS'),
    decisionsRoutes.indexOf('] as const;', decisionsRoutes.indexOf('const DECISION_CREATE_AUTHORITY_FIELDS')),
  );
  for (const authorityField of [
    'decisionId',
    'clientId',
    'agencyId',
    'disposition',
    'successorDecisionId',
    'observedOutcome',
    'executionRef',
    'deploymentRef',
    'learningRef',
    'proposer',
    'proposerActor',
    'proposerRole',
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
  // workspaceId is deliberately NOT forbidden on the create surface: it is
  // SCOPE INPUT (the learnings/experiments precedent — "workspaceId is
  // scope INPUT validated against canonical workspace ownership inside
  // the module"), never an authorization; a foreign workspace identifier
  // is a uniform 404 (proven by the integration suite).
  assert.ok(
    !createAuthorityList.includes("'workspaceId'"),
    'the create DTO must ACCEPT workspaceId as scope input (validated canonically inside the module)',
  );
  assert.ok(
    /workspaceId: optionalString\(\{ minLength: 36, maxLength: 36 \}\)/.test(decisionsRoutes),
    'the create DTO must validate workspaceId as a uuid-shaped optional field',
  );
  const dispositionAuthorityList = decisionsRoutes.slice(
    decisionsRoutes.indexOf('const DECISION_DISPOSITION_AUTHORITY_FIELDS'),
    decisionsRoutes.indexOf(
      '] as const;',
      decisionsRoutes.indexOf('const DECISION_DISPOSITION_AUTHORITY_FIELDS'),
    ),
  );
  for (const authorityField of [
    'decisionId',
    'clientId',
    'agencyId',
    'eventId',
    'disposition',
    'dispositionAt',
    'observedOutcome',
    'proposer',
    'provenance',
    'recordedAt',
    'correlationId',
    'secret',
    'apiKey',
  ]) {
    assert.ok(
      dispositionAuthorityList.includes(`'${authorityField}'`),
      `the disposition DTO must reject the authority field '${authorityField}'`,
    );
  }
  const outcomeAuthorityList = decisionsRoutes.slice(
    decisionsRoutes.indexOf('const DECISION_OUTCOME_AUTHORITY_FIELDS'),
    decisionsRoutes.indexOf(
      '] as const;',
      decisionsRoutes.indexOf('const DECISION_OUTCOME_AUTHORITY_FIELDS'),
    ),
  );
  for (const authorityField of [
    'decisionId',
    'clientId',
    'agencyId',
    'eventId',
    'disposition',
    'successorDecisionId',
    'outcomeAt',
    'proposer',
    'provenance',
    'recordedAt',
    'correlationId',
    'secret',
    'apiKey',
  ]) {
    assert.ok(
      outcomeAuthorityList.includes(`'${authorityField}'`),
      `the outcome DTO must reject the authority field '${authorityField}'`,
    );
  }
});

test('the frozen disposition taxonomies are structurally consistent (code ↔ migration)', () => {
  // The code taxonomy matches the migration CHECK literals exactly.
  const decisionsBlock = createTableBlock(migration036, 'decisions');
  for (const disposition of DECISION_DISPOSITIONS) {
    assert.ok(
      decisionsBlock.includes(`'${disposition}'`),
      `the migration must know the frozen disposition '${disposition}'`,
    );
  }
  // The impact-direction vocabulary matches too.
  for (const direction of DECISION_IMPACT_DIRECTIONS) {
    assert.ok(
      decisionsBlock.includes(`'${direction}'`),
      `the migration must know the frozen impact direction '${direction}'`,
    );
  }
  // The command table's three targets are exactly the terminal set.
  assert.deepEqual(
    [...TERMINAL_DECISION_DISPOSITIONS].sort(),
    ['accepted', 'rejected', 'superseded'],
    'exactly accepted, rejected and superseded are terminal',
  );
  assert.deepEqual(
    [...DECISION_DISPOSITION_COMMANDS].map((command) => DECISION_DISPOSITION_TABLE[command].to).sort(),
    [...TERMINAL_DECISION_DISPOSITIONS].sort(),
    'every disposition command targets a terminal state (history never rewrites)',
  );
  // The event tail knows only disposition events with TERMINAL targets
  // (creation IS the row, not an event).
  const eventsBlock = createTableBlock(migration036, 'decision_events');
  assert.ok(
    !eventsBlock.includes("'proposed'"),
    'the event tail never carries a proposed disposition (creation is the row itself)',
  );
});
