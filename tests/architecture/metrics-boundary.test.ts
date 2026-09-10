/**
 * MKT-014 static tests — the Metrics domain is structurally correct in the
 * ACTUAL migration, module contract and route surface (pure static
 * analysis, no DB).
 *
 * Proofs (METRIC-001 "source/timestamp/reference mapping"; the INT-001
 * posture — provider independence; spec/architecture.md §16 "Metrics are
 * observations"; spec/implementation-contract.md §15; frozen matrix
 * /metrics ──→ /evidence, /integrations):
 *   1. migration 018 (the MKT-014-reserved number) creates
 *      `metric_observations` with the required contract fields: immutable
 *      opaque id, Client ownership reference, optional Workspace scope, the
 *      metric identity (name + dimensions), value + unit, the source
 *      descriptor, BOTH timestamps (observed_at + retrieved_at — kept
 *      distinct), the optional evidence reference, the data-quality
 *      posture, the optional aggregation method and the SERVER-DERIVED
 *      provenance columns (actor, recording system, correlation, causation,
 *      recorded_at);
 *   2. observation ownership is EXACTLY the client_id FK (plus the optional
 *      workspace scope FK and the optional evidence_ref FK) — no owner/role/
 *      user columns, no observation column on clients/workspaces/agencies/
 *      users/evidence, and migration 018 creates exactly the one table (no
 *      second authority structures, no provider-state tables);
 *   3. the quality CHECK enumerates the same 5 statuses as the code
 *      taxonomy and the dimensions CHECK requires a jsonb object —
 *      persistence can never drift from code;
 *   4. the APPEND-ONLY backstop exists: BEFORE UPDATE and BEFORE DELETE
 *      triggers reject every mutation on metric_observations (there is
 *      deliberately NO supersession fence — corrections are plain new
 *      rows);
 *   5. the workspace-within-client scope trigger exists AND the
 *      evidence-linkage trigger rejects cross-tenant references by name;
 *   6. the /metrics public contract exposes the canonical owner-context
 *      resolution surface, the server-derived provenance argument type and
 *      the structural /clients + /workspaces ownership ports, and imports
 *      ONLY allowed module publics (/evidence — a subset of the frozen
 *      matrix /metrics ──→ /evidence, /integrations; NO provider SDKs, NO
 *      /integrations internals, and notably NO direct /clients//workspaces
 *      imports even though their authorities are consumed — the frozen
 *      import matrix forbids those directions and the ports keep the
 *      resolution server-side);
 *   7. no mutation authority exists in the /metrics implementation (no
 *      update, no delete, no provider adapters/cursors — the module API
 *      surface is append + read only);
 *   8. the route surface is append-only: ONLY POST/GET registrations, no
 *      PATCH/PUT/DELETE anywhere, and the routes are exactly the metrics
 *      surface (/api/clients/:clientId/metrics + /api/metrics/:observationId);
 *   9. the DTO discipline is structural: the append forbidden
 *      authority-field list includes every provenance-shaped key PLUS the
 *      retrieval timestamp (server-derived) plus identity/ownership keys —
 *      callers can never inject identity, ownership, provenance or the
 *      platform's own timestamps.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { METRIC_QUALITY_STATUSES } from '../../src/modules/metrics/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migration018 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '018_metrics.sql'),
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
const metricsPublic = readFileSync(
  join(repoRoot, 'src', 'modules', 'metrics', 'public.ts'),
  'utf8',
);
const metricsModule = readFileSync(
  join(repoRoot, 'src', 'modules', 'metrics', 'internal', 'metrics-module.ts'),
  'utf8',
);
const metricsStore = readFileSync(
  join(repoRoot, 'src', 'modules', 'metrics', 'internal', 'metrics-store.ts'),
  'utf8',
);
const metricsRoutes = readFileSync(join(repoRoot, 'src', 'api', 'metrics-routes.ts'), 'utf8');

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

test('the metric_observations table carries the required domain contract fields (METRIC-001 data contract)', () => {
  const columns = columnsOf(createTableBlock(migration018, 'metric_observations'));
  for (const required of [
    'observation_id', // immutable opaque identifier (server-generated)
    'client_id', // Client ownership reference (FK) — hard boundary
    'workspace_id', // optional Workspace scope FK (within the Client)
    'metric_name', // metric identity: the series name
    'dimensions', // metric identity: the dimension key set
    'value', // the measured value
    'unit', // the value's declared unit
    'source_system', // declared source system (provider label or 'internal')
    'source_ref', // optional opaque external source reference
    'observed_at', // OBSERVATION timestamp — when the metric was true
    'retrieved_at', // RETRIEVAL timestamp — when the platform saw it (DISTINCT column)
    'evidence_ref', // optional /evidence record reference (internal observations)
    'quality', // the closed data-quality posture set
    'aggregation_method', // optional declared rollup semantics
    'recorded_actor', // SERVER-DERIVED provenance: actor
    'recorded_via', // SERVER-DERIVED provenance: recording system
    'correlation_id', // SERVER-DERIVED provenance: correlation
    'causation_id', // SERVER-DERIVED provenance: causation
    'recorded_at', // SERVER-DERIVED provenance: recording timestamp
  ]) {
    assert.ok(columns.includes(required), `metric_observations.${required} required`);
  }
  // Server-generated identity + Client ownership FK backstop; Workspace
  // scope and evidence linkage are OPTIONAL FKs. NO on-delete cascade:
  // append-only measurement history is never erased by parent deletes.
  assert.ok(
    migration018.includes('client_id          uuid        NOT NULL REFERENCES clients(client_id)'),
    'Client ownership must be a NOT NULL FK to clients (no cascade — history survives)',
  );
  assert.ok(
    migration018.includes('workspace_id       uuid        REFERENCES workspaces(workspace_id)'),
    'Workspace scope must be a (nullable) FK to workspaces',
  );
  assert.ok(
    migration018.includes('evidence_ref       uuid        REFERENCES evidence(evidence_id)'),
    'Evidence linkage must be a (nullable) FK to evidence',
  );
  // The observation/retrieval timestamps are BOTH present and BOTH NOT
  // NULL — the METRIC-001 acceptance: kept distinct as separate columns.
  const tableBlock = createTableBlock(migration018, 'metric_observations');
  assert.ok(
    /observed_at\s+timestamptz\s+NOT NULL/.test(tableBlock),
    'observed_at must be a NOT NULL timestamptz',
  );
  assert.ok(
    /retrieved_at\s+timestamptz\s+NOT NULL/.test(tableBlock),
    'retrieved_at must be a NOT NULL timestamptz (distinct column from observed_at)',
  );
});

test('observation ownership is exactly the client_id FK + optional workspace/evidence references — no conflation, no alternate authority, no provider state', () => {
  const metricsColumns = columnsOf(createTableBlock(migration018, 'metric_observations'));
  for (const column of metricsColumns) {
    if (column === 'client_id' || column === 'workspace_id' || column === 'evidence_ref') continue;
    assert.ok(
      !/owner|role|user|admin|permission/.test(column),
      `metric_observations must not carry ownership/role/user columns (found '${column}')`,
    );
  }

  // The Client→Observation relationship lives ONLY in
  // metric_observations.client_id: no observation column leaks upward into
  // clients/workspaces/agencies/users/evidence, and migration 018 must not
  // redefine the earlier frozen tables.
  for (const [migration, table] of [
    [migration002, 'agencies'],
    [migration002, 'users'],
    [migration003, 'clients'],
    [migration004, 'workspaces'],
    [migration015, 'evidence'],
  ] as const) {
    for (const column of columnsOf(createTableBlock(migration, table))) {
      assert.ok(
        !/observation/.test(column),
        `${table}.${column} — the Client→Observation relationship must not leak above /metrics`,
      );
    }
  }
  for (const table of ['agencies', 'users', 'clients', 'workspaces', 'evidence']) {
    assert.ok(
      !migration018.includes(`CREATE TABLE IF NOT EXISTS ${table} (`),
      `018 must not redefine the frozen ${table} table`,
    );
  }
  // No new tables beyond metric_observations in migration 018 (no permission
  // engine, no experiment/learning structures — those are MKT-015/016 — and
  // NO provider-state tables: no sessions, no cursors, no adapters — INT-001).
  const createdTables = [...migration018.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    createdTables,
    ['metric_observations'],
    'migration 018 must create exactly the metric_observations table — no second authority or provider-state structures',
  );
});

test('the migration quality CHECK and the code taxonomy describe ONE posture set; dimensions are a jsonb object', () => {
  const tableBlock = createTableBlock(migration018, 'metric_observations');
  for (const status of METRIC_QUALITY_STATUSES) {
    assert.ok(tableBlock.includes(`'${status}'`), `quality CHECK must enumerate '${status}'`);
  }
  assert.ok(
    tableBlock.includes("quality IN ('ok', 'partial'"),
    'the quality CHECK must be the closed 5-value enumeration',
  );
  assert.ok(
    tableBlock.includes("jsonb_typeof(dimensions) = 'object'"),
    'dimensions must be CHECKed to be a jsonb object',
  );
  // The append-only surface: no supersession fence exists (corrections are
  // plain new rows — the measurement authority has no supersession graph).
  assert.ok(
    !migration018.includes('supersedes'),
    'the metrics migration must not introduce a supersession graph (corrections are new rows)',
  );
});

test('the append-only backstop exists: UPDATE and DELETE are rejected by the database (METRIC-001 immutable rows)', () => {
  assert.ok(
    migration018.includes('metric_observations_append_only'),
    'the append-only trigger function must exist',
  );
  assert.ok(
    migration018.includes('metric_observations_append_only_update_trigger'),
    'the BEFORE UPDATE trigger must be wired',
  );
  assert.ok(
    migration018.includes('metric_observations_append_only_delete_trigger'),
    'the BEFORE DELETE trigger must be wired',
  );
  const triggerBody = migration018.slice(
    migration018.indexOf('CREATE OR REPLACE FUNCTION metric_observations_append_only'),
    migration018.indexOf('$$ LANGUAGE plpgsql;', migration018.indexOf('metric_observations_append_only')),
  );
  assert.ok(
    triggerBody.includes("'metric observations are append-only: % is rejected on metric_observation %'"),
    'the trigger must reject both operations explicitly',
  );
});

test('the workspace-within-client scope trigger and the cross-tenant evidence-linkage trigger exist', () => {
  assert.ok(
    migration018.includes('metric_workspace_within_client'),
    'the workspace-within-client trigger must exist',
  );
  const scopeBody = migration018.slice(
    migration018.indexOf('CREATE OR REPLACE FUNCTION metric_workspace_within_client'),
    migration018.indexOf('$$ LANGUAGE plpgsql;', migration018.indexOf('metric_workspace_within_client')),
  );
  assert.ok(
    scopeBody.includes('w.workspace_id = NEW.workspace_id AND w.client_id = NEW.client_id'),
    'the trigger must require the workspace to belong to the record client',
  );

  assert.ok(
    migration018.includes('metric_evidence_ref_same_client'),
    'the evidence-linkage trigger must exist',
  );
  const linkageBody = migration018.slice(
    migration018.indexOf('CREATE OR REPLACE FUNCTION metric_evidence_ref_same_client'),
    migration018.indexOf('$$ LANGUAGE plpgsql;', migration018.indexOf('metric_evidence_ref_same_client')),
  );
  assert.ok(
    linkageBody.includes('v_evidence_client <> NEW.client_id'),
    'cross-tenant evidence linkage must be rejected by the database',
  );
  assert.ok(
    linkageBody.includes('cross-tenant evidence linkage is rejected'),
    'the cross-tenant rejection must be named (module error classification matches this marker)',
  );
});

test('the /metrics public contract exposes canonical owner resolution over allowed dependencies only (frozen matrix)', () => {
  assert.ok(
    metricsPublic.includes('export interface MetricOwnerContext'),
    'MetricOwnerContext must be part of the public contract',
  );
  assert.ok(
    metricsPublic.includes('resolveMetricObservationOwnership'),
    'canonical ownership resolution must be part of the module API',
  );
  assert.ok(
    metricsPublic.includes("kind: 'metric'"),
    'the owner context must carry the metric-scoped scope shape',
  );
  assert.ok(
    metricsPublic.includes('export function composeMetricOwnerContext'),
    'the pure composer must be exported',
  );
  // Provenance is a separate, server-derived input dimension.
  assert.ok(
    metricsPublic.includes('export interface MetricProvenance'),
    'the server-derived provenance argument type must be part of the contract',
  );
  // The /clients + /workspaces ownership resolution arrives as STRUCTURAL
  // PORTS (the frozen matrix allows only /evidence + /integrations imports
  // from /metrics — the ports keep the required resolution server-side
  // without a forbidden import).
  assert.ok(
    metricsPublic.includes('export interface ClientOwnershipResolutionPort'),
    'the structural /clients ownership port must be declared',
  );
  assert.ok(
    metricsPublic.includes('export interface WorkspaceOwnershipResolutionPort'),
    'the structural /workspaces ownership port must be declared',
  );

  // Dependency matrix: /metrics ──→ /evidence, /integrations. The public
  // entry must not import any other module (a subset is fine — /integrations
  // is not yet implemented, MKT-023/024).
  const imports = [...metricsPublic.matchAll(/from '\.\.\/([\w-]+)\/public\.ts'/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    [...new Set(imports)].sort(),
    ['evidence'],
    'public.ts may only import the /evidence public contract among module publics (frozen matrix: /metrics ──→ /evidence, /integrations)',
  );
  for (const forbidden of [
    'agencies',
    'auth',
    'users',
    'clients',
    'workspaces',
    'playbooks',
    'workflows',
    'deployments',
    'policies',
    'audit',
    'experiments',
    'learnings',
  ]) {
    assert.ok(
      !imports.includes(forbidden),
      `/metrics must not depend on /${forbidden} (frozen matrix)`,
    );
  }
  // NO provider SDKs and NO cross-module internals: the internal store's
  // only cross-module import is the /evidence public entry (the shared §21
  // guard), and neither module file references a provider SDK at all.
  const storeImports = [...metricsStore.matchAll(/from '\.\.\/\.\.\/([\w-]+)\/public\.ts'/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    [...new Set(storeImports)].sort(),
    ['evidence'],
    'the internal store may only import the /evidence public contract cross-module',
  );
  assert.ok(
    !metricsStore.includes('../integrations/') && !metricsModule.includes('../integrations/'),
    '/metrics must not import /integrations internals (provider adapters are MKT-023/024)',
  );
  for (const source of [metricsPublic, metricsModule, metricsStore, metricsRoutes]) {
    for (const sdk of ['openai', 'anthropic', '@meta', 'facebook', 'googleapis', 'aws-sdk', 'stripe']) {
      assert.ok(
        !source.includes(sdk),
        `/metrics files must not reference provider SDK '${sdk}' (no provider SDKs anywhere)`,
      );
    }
  }
});

test('no mutation authority and no provider state exist in the /metrics implementation (METRIC-001/INT-001)', () => {
  // The module implementation composes the canonical ownership chain — it
  // never re-derives and never invents an authority.
  assert.ok(
    metricsModule.includes('resolveClientOwnership'),
    'the metrics module must resolve Client ownership THROUGH the /clients port',
  );
  assert.ok(
    metricsModule.includes('resolveWorkspaceOwnership'),
    'the metrics module must resolve Workspace scope THROUGH the /workspaces port',
  );
  // The module surface is append + read only: no update, no delete, no
  // promotion, no provider adapter/cursor/session method anywhere in the
  // module (the doc comments SAY provider adapters are out of scope — the
  // assertions below check for actual API surface, imports are covered
  // above).
  for (const forbidden of [
    'updateObservation',
    'updateMetric',
    'deleteObservation',
    'deleteMetric',
    'syncProvider',
    'providerCursor',
    'providerSession',
    'fetchFromProvider',
    'setObservationValue',
  ]) {
    assert.ok(
      !metricsModule.includes(forbidden) && !metricsPublic.includes(forbidden),
      `the metrics module must not expose '${forbidden}' (append-only, no provider state)`,
    );
  }
  // No provider SDK references anywhere in the metrics implementation.
  for (const source of [metricsModule, metricsStore]) {
    for (const sdk of ['openai', 'anthropic', 'facebook', 'googleapis', 'aws-sdk', 'stripe', 'axios']) {
      assert.ok(
        !source.includes(sdk),
        `/metrics implementation must not reference provider SDK '${sdk}'`,
      );
    }
  }
});

test('the route surface is append-only: POST/GET registrations only, no update or delete routes (METRIC-001)', () => {
  // Every router.add registration in the metrics routes file is POST or
  // GET — there is no PATCH, PUT or DELETE surface at all.
  const registrations = [...metricsRoutes.matchAll(/router\.add\(\s*'(\w+)',\s*'([^']+)'/g)].map(
    (match) => [match[1]!, match[2]!] as const,
  );
  assert.ok(registrations.length >= 3, 'the metrics routes file must register its routes');
  for (const [method, path] of registrations) {
    assert.ok(
      method === 'POST' || method === 'GET',
      `metrics routes must only register POST/GET (found ${method} ${path})`,
    );
  }
  // The registered paths are exactly the metrics surface.
  for (const [, path] of registrations) {
    const normalized = path.replace(/:clientId|:observationId/g, '').replace(/\/+/g, '/');
    assert.ok(
      normalized === '/api/clients/metrics' ||
        normalized === '/api/metrics' ||
        normalized.startsWith('/api/metrics/'),
      `metrics routes must only register metrics paths (found '${path}')`,
    );
  }
  // The route layer must use the shared authorize helpers (which resolve
  // canonical ownership first) — never a private permission engine.
  assert.ok(
    metricsRoutes.includes('requireMetricAccess'),
    'metrics routes must authorize through the shared requireMetricAccess helper',
  );
  assert.ok(
    metricsRoutes.includes('requireClientAccess'),
    'client-scoped metrics routes must authorize through requireClientAccess',
  );
  assert.ok(
    !/role.*engine|permissionTable|canAccess|hasPermission/.test(metricsRoutes),
    'metrics routes must not carry a private permission engine',
  );
});

test('the DTO discipline is structural: provenance, identity, ownership AND the retrieval timestamp are caller-rejected', () => {
  // The append forbidden list covers every server-derived dimension.
  const createList = metricsRoutes.slice(
    metricsRoutes.indexOf('METRIC_CREATE_AUTHORITY_FIELDS'),
    metricsRoutes.indexOf('] as const;', metricsRoutes.indexOf('METRIC_CREATE_AUTHORITY_FIELDS')),
  );
  for (const forbidden of [
    'observationId',
    'clientId',
    'agencyId',
    'provenance',
    'actor',
    'recordedActor',
    'recordedVia',
    'correlationId',
    'causationId',
    'recordedAt',
    'retrievedAt',
    'secret',
    'password',
    'apiKey',
  ]) {
    assert.ok(
      createList.includes(`'${forbidden}'`),
      `the append DTO must reject the authority field '${forbidden}'`,
    );
  }
  // Both route validations... exactly one DTO exists (the append body); the
  // forbidden list is actually applied.
  const forbiddenKeyUses = [...metricsRoutes.matchAll(/forbiddenKeys: (\w+)/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    forbiddenKeyUses.sort(),
    ['METRIC_CREATE_AUTHORITY_FIELDS'],
    'the metrics append DTO must apply its forbidden authority-field list',
  );
  // The retrieval timestamp is NOT a DTO field (server-derived), while the
  // observation timestamp IS (caller-declared source mapping). The check
  // spans the validate step ONLY — the execute step legitimately sets
  // `retrievedAt: null` when calling the module (the server-side stamp).
  const validateBlock = metricsRoutes.slice(
    metricsRoutes.indexOf('validateObject<ValidatedMetricAppend>'),
    metricsRoutes.indexOf('execute: async'),
  );
  assert.ok(
    validateBlock.includes('observedAt: stringField'),
    'observedAt must be a declared DTO field (caller-declared source mapping)',
  );
  assert.ok(
    !validateBlock.includes('retrievedAt'),
    'retrievedAt must NOT be a declared DTO field (server-derived)',
  );
  // ... and the execute step passes retrievedAt as the SERVER-side null
  // stamp (the module clock fills it).
  assert.ok(
    metricsRoutes.includes('retrievedAt: null,'),
    'the execute step must pass the server-side null retrieval stamp',
  );
});
