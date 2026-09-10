/**
 * MKT-025 static tests — the Human Agent foundation is structurally correct
 * in the ACTUAL migration, module contract and routes (pure static analysis,
 * no DB). Proves the frozen architecture boundaries (spec/human-agent-v1.3.md,
 * spec/module-dependency-v1.3.md, spec/work-item-matrix-v1.3.md):
 *
 *   1. migration 017 creates EXACTLY the human_agents table carrying the
 *      HUMAN-AC-01 contract fields: immutable platform identity link
 *      (user_id FK), specializations, capabilities, availability, optional
 *      location/territories, server-derived reliability, relationship
 *      continuity, authorization/contract state, provenance, version CAS,
 *      server-derived timestamps;
 *   2. a Human Agent is NOT a tenant and owns no Client data by eligibility:
 *      human_agents has NO agency/client/workspace columns, and migration
 *      017 creates no second tables (no linkage structures, no job/offer/
 *      execution tables — agency linkage is the existing
 *      agency_memberships authority of migration 002);
 *   3. the DB CHECK enumerations and the code registries describe ONE
 *      model: specializations <@ the frozen registry ==
 *      HUMAN_SPECIALIZATIONS; authorization_state CHECK ==
 *      HUMAN_AUTHORIZATION_TRANSITIONS keys; contract_ended terminal in
 *      both (persistence can never drift from code);
 *   4. the HUMAN-AC-01 profile groups are DB-fenced (jsonb type +
 *      cardinality) and the Field-Agent geography requirement is a DB CHECK
 *      (FIELD-AC-01 backstop);
 *   5. the identity-link immutability trigger, the specializations
 *      uniqueness trigger and the contract_ended terminal trigger exist;
 *      the one-profile-per-user unique fence exists;
 *   6. NO SECOND HUMAN-EXECUTION MODULE: src/modules contains no
 *      human-agents directory (module-dependency-v1.3: /human-agents is
 *      represented by the EXISTING /field-agents authority — the frozen
 *      module list already contains field-agents);
 *   7. HUMAN-AC-02 (one execution authority): the /field-agents public
 *      contract exports NO job/offer/acceptance/execution state machine —
 *      no exported symbol matching Job/Offer/Acceptance/Execution/Dispatch/
 *      TaskState — and the module imports ONLY allowed dependencies
 *      (frozen matrix: /field-agents ──→ /users, /clients, /policies; this
 *      Work Item consumes /users only). The module never imports /jobs,
 *      /executions, /workflows;
 *   8. the API surface registers ONLY profile/declaration/authorization/
 *      eligibility routes under /api/field-agents and
 *      /api/agencies/:agencyId/field-agents — NO client-data routes exist
 *      (HUMAN-AC-03 fail-closed boundary), and the routes compose the SAME
 *      /agencies membership authority (requireAgencyAccess /
 *      listMembershipsForUser — no private permission engine);
 *   9. the reliability surface is server-side only: no route registers a
 *      reliability mutation (recordReliabilityObservation has NO HTTP
 *      surface — outcome/rating are server-derived).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HUMAN_AUTHORIZATION_TRANSITIONS,
  HUMAN_SPECIALIZATIONS,
} from '../../src/modules/field-agents/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migration017 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '017_field_agents.sql'),
  'utf8',
);
const migration002 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '002_identity_agencies.sql'),
  'utf8',
);
const fieldAgentsPublic = readFileSync(
  join(repoRoot, 'src', 'modules', 'field-agents', 'public.ts'),
  'utf8',
);
const fieldAgentsModule = readFileSync(
  join(repoRoot, 'src', 'modules', 'field-agents', 'internal', 'field-agents-module.ts'),
  'utf8',
);
const fieldAgentsStore = readFileSync(
  join(repoRoot, 'src', 'modules', 'field-agents', 'internal', 'field-agents-store.ts'),
  'utf8',
);
const fieldAgentsRoutes = readFileSync(join(repoRoot, 'src', 'api', 'field-agents-routes.ts'), 'utf8');

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
    .map((line) => line.split(/\s+/)[0]!)
    .filter((column) => column !== 'CHECK');
}

test('migration 017 creates exactly ONE table — human_agents — with the HUMAN-AC-01 contract fields', () => {
  const createdTables = [...migration017.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    createdTables,
    ['human_agents'],
    'migration 017 must create exactly the human_agents table (no second human module, no job/offer/execution structures)',
  );

  const columns = columnsOf(createTableBlock(migration017, 'human_agents'));
  for (const required of [
    'agent_id', // immutable opaque identifier (server-generated)
    'user_id', // stable platform identity link (FK, unique, immutable)
    'specializations', // capability metadata (v1.3 §2)
    'capabilities', // capabilities/skills
    'availability', // availability windows
    'location', // optional current location
    'territories', // optional service territories
    'reliability', // server-derived reliability/quality signals
    'relationship_continuity', // relationship-continuity preferences
    'authorization_state', // authorization/contract state
    'created_by', // provenance (server-derived)
    'version', // CAS token
    'created_at',
    'updated_at',
  ]) {
    assert.ok(columns.includes(required), `human_agents.${required} required (HUMAN-AC-01)`);
  }
});

test('a Human Agent is NOT a tenant: no agency/client/workspace columns, no linkage tables, no Client data', () => {
  const columns = columnsOf(createTableBlock(migration017, 'human_agents'));
  for (const column of columns) {
    if (column === 'user_id' || column === 'created_by') continue; // identity link + provenance
    assert.ok(
      !/agency|client|workspace|tenant|owner/.test(column),
      `human_agents must not carry tenant columns (found '${column}') — agency linkage is the existing membership authority`,
    );
  }

  // The platform identity link is a FK to users (and ONLY users).
  assert.ok(
    migration017.includes('user_id      uuid        NOT NULL REFERENCES users(user_id)'),
    'user_id must be a NOT NULL FK to users',
  );

  // No second linkage/authority tables are created (already asserted: exactly
  // one table). The existing agency_memberships authority stays in migration
  // 002 — untouched by 017 (agency linkage via the human_agent membership
  // role, which already existed):
  assert.ok(
    migration002.includes("'agency_owner', 'agency_admin', 'agency_operator',\n        'client_collaborator', 'human_agent'"),
    'the human_agent membership role pre-exists in migration 002 (agency linkage authority)',
  );
  assert.ok(
    !migration017.includes('CREATE TABLE IF NOT EXISTS agency_memberships'),
    '017 must not redefine the frozen membership authority',
  );
});

test('the DB CHECK registry and the code registry describe ONE specialization model', () => {
  const registryValues = [...HUMAN_SPECIALIZATIONS].sort();
  // The CHECK subset fence lists exactly the frozen registry.
  const checkBlock = migration017.slice(
    migration017.indexOf('specializations <@ ARRAY['),
    migration017.indexOf(']::text[]', migration017.indexOf('specializations <@ ARRAY[')),
  );
  const dbRegistry = [...checkBlock.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!).sort();
  assert.deepEqual(
    dbRegistry,
    registryValues,
    'migration 017 specializations CHECK must enumerate exactly HUMAN_SPECIALIZATIONS',
  );
});

test('the authorization_state CHECK and the code transition table describe ONE lifecycle (contract_ended terminal in both)', () => {
  const agentsBlock = createTableBlock(migration017, 'human_agents');
  assert.ok(
    agentsBlock.includes("('active', 'suspended', 'contract_ended')"),
    'authorization_state CHECK must cover active/suspended/contract_ended',
  );
  assert.deepEqual(
    [...Object.keys(HUMAN_AUTHORIZATION_TRANSITIONS)].sort(),
    ['active', 'contract_ended', 'suspended'],
    'code transition table statuses match the DB CHECK',
  );
  assert.equal(
    HUMAN_AUTHORIZATION_TRANSITIONS.contract_ended.length,
    0,
    'contract_ended is terminal in code',
  );
  assert.ok(
    migration017.includes('human_agents_contract_ended_terminal'),
    'the contract_ended terminal trigger must exist (contract history is frozen in the DB)',
  );
});

test('the HUMAN-AC-01 profile groups are DB-fenced and the Field-Agent geography rule is a DB CHECK', () => {
  assert.ok(
    migration017.includes("jsonb_typeof(capabilities) = 'array'"),
    'capabilities must be CHECKed to be a jsonb array',
  );
  assert.ok(
    migration017.includes('jsonb_array_length(capabilities) BETWEEN 1 AND 50'),
    'capabilities cardinality fence',
  );
  assert.ok(
    migration017.includes("jsonb_typeof(availability) = 'array'"),
    'availability must be CHECKed to be a jsonb array',
  );
  assert.ok(
    migration017.includes('jsonb_array_length(availability) BETWEEN 1 AND 100'),
    'availability cardinality fence',
  );
  assert.ok(
    migration017.includes('jsonb_array_length(territories) BETWEEN 0 AND 50'),
    'territories cardinality fence (optional geography)',
  );
  assert.ok(
    migration017.includes("jsonb_typeof(reliability) = 'object'"),
    'reliability must be CHECKed to be a jsonb object (server-derived aggregate)',
  );
  assert.ok(
    migration017.includes("jsonb_typeof(relationship_continuity) = 'object'"),
    'relationship continuity must be CHECKed to be a jsonb object',
  );
  // FIELD-AC-01 backstop: field_agent ⇒ declared geography.
  assert.ok(
    migration017.includes("NOT ('field_agent' = ANY(specializations))"),
    'the Field-Agent geography CHECK must exist',
  );
  assert.ok(
    migration017.includes('OR location IS NOT NULL'),
    'geography may be satisfied by a location',
  );
  assert.ok(
    migration017.includes('OR jsonb_array_length(territories) >= 1'),
    'geography may be satisfied by a territory',
  );
});

test('identity-link immutability, specialization uniqueness and the one-profile-per-user fence exist', () => {
  assert.ok(
    migration017.includes('human_agents_identity_immutable'),
    'the identity-link immutability trigger must exist',
  );
  const immutableBody = migration017.slice(
    migration017.indexOf('CREATE OR REPLACE FUNCTION human_agents_identity_immutable'),
    migration017.indexOf('$$ LANGUAGE plpgsql;', migration017.indexOf('human_agents_identity_immutable')),
  );
  assert.ok(immutableBody.includes('NEW.agent_id <> OLD.agent_id'), 'agent_id immutability');
  assert.ok(immutableBody.includes('NEW.user_id <> OLD.user_id'), 'platform identity link immutability');
  assert.ok(immutableBody.includes('NEW.created_at <> OLD.created_at'), 'created_at immutability');
  assert.ok(
    immutableBody.includes('NEW.created_by IS DISTINCT FROM OLD.created_by'),
    'created_by immutability',
  );
  assert.ok(
    migration017.includes('human_agents_specializations_unique'),
    'the specialization uniqueness trigger must exist',
  );
  assert.ok(
    migration017.includes('CREATE UNIQUE INDEX IF NOT EXISTS human_agents_user_key'),
    'the one-profile-per-user unique fence must exist (duplicate convergence)',
  );
});

test('NO second human-execution module: /human-agents does not exist — /field-agents is the generalized authority', () => {
  const moduleDirs = readdirSync(join(repoRoot, 'src', 'modules'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.ok(
    moduleDirs.includes('field-agents'),
    'the frozen /field-agents module directory exists (the generalized authority)',
  );
  assert.ok(
    !moduleDirs.includes('human-agents'),
    'a /human-agents module directory is FORBIDDEN (module-dependency-v1.3: represented by /field-agents)',
  );
  assert.ok(
    !existsSync(join(repoRoot, 'src', 'modules', 'human-agents')),
    'no human-agents path may exist anywhere under src/modules',
  );
  // The migration must not create a second human profile table either.
  assert.ok(
    !migration017.includes('human_agent_profiles') && !migration017.includes('field_agents ('),
    'no alternate human profile table naming',
  );
});

test('HUMAN-AC-02: the /field-agents public contract exports NO job/execution engine and imports only allowed dependencies', () => {
  // No exported symbol is a Job/Offer/Acceptance/Execution/Dispatch concept:
  // specializations are capability metadata; the SAME Job/Task/Execution
  // authorities serve every specialization.
  const exportedSymbols = [
    ...fieldAgentsPublic.matchAll(/export (?:interface|type|function|const) (\w+)/g),
  ].map((match) => match[1]!);
  assert.ok(exportedSymbols.length > 0, 'the contract exports its model');
  for (const symbol of exportedSymbols) {
    // Forbidden: Job/Offer/Acceptance/Execution state-machine RECORDS and
    // transitions (the /jobs, /executions authorities). Allowed: the
    // eligibility DATA surface (JobEligibilitySpec, isAgentEligibleForJob)
    // — profile-side matching inputs, never job state.
    assert.ok(
      !/JobRecord|JobStatus|JobState|JobTransition|JobOffer|JobAssignment|Offer|Acceptance|Execution|Dispatch|TaskState|Workflow|Assignment|Queue/.test(
        symbol,
      ),
      `the field-agents public contract must not export ${symbol} (Job/Task/Execution authority belongs to /jobs, /executions — HUMAN-AC-02)`,
    );
  }

  // Dependency matrix: /field-agents ──→ /users, /clients, /policies ONLY.
  const publicImports = [...fieldAgentsPublic.matchAll(/from '\.\.\/([\w-]+)\/public\.ts'/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    [...new Set(publicImports)].sort(),
    ['users'],
    'public.ts may only import /users among module publics (frozen matrix: /field-agents ──→ /users, /clients, /policies; this Work Item consumes /users only)',
  );
  for (const file of [fieldAgentsPublic, fieldAgentsModule, fieldAgentsStore]) {
    for (const forbidden of [
      '../jobs/',
      '../executions/',
      '../workflows/',
      '../agencies/',
      '../auth/',
      '../clients/',
      '../playbooks/',
      '../evidence/',
      '../audit/',
      '../policies/',
    ]) {
      assert.ok(
        !file.includes(`from '${forbidden}`),
        `the field-agents module must not depend on ${forbidden} (frozen matrix)`,
      );
    }
  }

  // No job/execution state machine text in the module implementation.
  for (const machineState of ['OFFERED', 'IN_PROGRESS', 'ACCEPTED', 'DISPATCHED', 'QUEUED']) {
    assert.ok(
      !fieldAgentsModule.includes(machineState) && !fieldAgentsStore.includes(machineState),
      `the field-agents module must not contain the Job machine state '${machineState}' (HUMAN-AC-02)`,
    );
  }
});

test('HUMAN-AC-03 fail-closed boundary: the routes register ONLY profile/declaration/authorization/eligibility surfaces — NO client-data routes', () => {
  const registeredPaths = [...fieldAgentsRoutes.matchAll(/'(\/api\/[\w:/-]+)'/g)].map((match) =>
    match[1]!,
  );
  assert.deepEqual(
    registeredPaths.sort(),
    [
      '/api/agencies/:agencyId/field-agents/eligibility',
      '/api/field-agents',
      '/api/field-agents/:agentId',
      '/api/field-agents/:agentId/authorization',
      '/api/field-agents/:agentId/availability',
      '/api/field-agents/:agentId/profile',
    ],
    'field-agents routes must register exactly the profile/declaration/authorization/eligibility surfaces',
  );
  for (const path of registeredPaths) {
    assert.ok(
      !/client/i.test(path),
      `no client-data route may exist under the field-agents surface (found '${path}')`,
    );
  }
  // The eligibility DTO rejects client-shaped fields BEFORE traversal.
  assert.ok(
    fieldAgentsRoutes.includes("'clientId',") && fieldAgentsRoutes.includes("'jobId',"),
    'the eligibility DTO must reject client/job-shaped authority fields',
  );
  // The routes compose the SAME /agencies membership authority (no private
  // permission engine).
  assert.ok(
    fieldAgentsRoutes.includes('requireAgencyAccess'),
    'the eligibility route must authorize through the shared requireAgencyAccess helper',
  );
  assert.ok(
    fieldAgentsRoutes.includes('listMemberships'),
    'the candidate pool must resolve through the existing /agencies membership authority',
  );
  assert.ok(
    !/role.*engine|permissionTable|canAccess|hasPermission/.test(fieldAgentsRoutes),
    'field-agents routes must not carry a private permission engine',
  );
});

test('the reliability surface is server-side only: recordReliabilityObservation has NO HTTP route', () => {
  assert.ok(
    fieldAgentsPublic.includes('recordReliabilityObservation'),
    'the module API exposes the server-side reliability fold',
  );
  for (const path of [...fieldAgentsRoutes.matchAll(/'(\/api\/[\w:/-]+)'/g)].map((m) => m[1]!)) {
    assert.ok(
      !/reliab/i.test(path),
      `no reliability mutation route may exist (found '${path}') — outcome/rating are server-derived`,
    );
  }
  const registerBody = fieldAgentsRoutes.slice(
    fieldAgentsRoutes.indexOf('export function registerFieldAgentsRoutes'),
  );
  assert.ok(
    !registerBody.includes('recordReliabilityObservation'),
    'routes must never call the server-side reliability fold',
  );
});
