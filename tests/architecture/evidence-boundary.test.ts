/**
 * MKT-013 static tests — the Evidence/provenance domain is structurally
 * correct in the ACTUAL migration, module contract and route surface (pure
 * static analysis, no DB).
 *
 * Proofs (EVID-001, EVID-AC-01..03, spec/architecture.md §15 "Evidence is
 * append-oriented and server-owned", spec/evidence-and-experimentation.md,
 * spec/module-dependency-matrix.md "/evidence ──→ /clients, /workspaces,
 * /executions"):
 *   1. migration 015 creates `evidence` with the required contract fields:
 *      immutable opaque id, Client ownership reference, optional Workspace
 *      scope, the 8-class enumeration, the source descriptor, the evidence
 *      timestamp, traceable content + reference, the quality grade, the
 *      separate confidence dimension, the supersession reference and the
 *      SERVER-DERIVED provenance columns (actor, recording system,
 *      correlation, causation, recorded_at);
 *   2. Evidence ownership is EXACTLY the client_id FK (plus the optional
 *      workspace scope FK) — no owner/role/user columns on evidence, no
 *      evidence column on clients/workspaces/agencies/users (the
 *      Client→Evidence relationship is stored ONLY here), and migration
 *      015 creates exactly the evidence table (no second authority
 *      structures);
 *   3. the class CHECK enumerates the same 8 classes as the code taxonomy
 *      and the quality CHECK is the closed single-letter A..F set —
 *      persistence can never drift from code;
 *   4. the APPEND-ONLY backstop exists (EVID-AC-02): BEFORE UPDATE and
 *      BEFORE DELETE triggers reject every mutation on evidence;
 *   5. the SUPERSESSION FENCE exists (partial unique index — one
 *      superseding record per prior record) and the supersession legality
 *      trigger backstops EVID-AC-03 at the storage layer: a claim-class
 *      record can never be superseded into an authoritative class, and
 *      supersession can never cross the Client boundary;
 *   6. the workspace-within-client scope trigger exists (the Client
 *      boundary cannot be crossed through the workspace column);
 *   7. the /evidence public contract exposes the canonical owner-context
 *      resolution surface and imports ONLY the allowed authorities
 *      (/clients, /workspaces — a subset of the frozen matrix);
 *   8. the route surface is append-only (EVID-AC-02/03): ONLY
 *      POST/GET registrations, no PATCH/PUT/DELETE anywhere, and the
 *      supersession command is its own explicit POST route;
 *   9. the DTO discipline is structural: the create/supersede forbidden
 *      authority-field lists include every provenance-shaped key plus the
 *      supersession keys on create (callers can never inject identity,
 *      ownership, provenance or supersession).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVIDENCE_CLASSES } from '../../src/modules/evidence/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migration015 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '015_evidence.sql'),
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
const evidencePublic = readFileSync(
  join(repoRoot, 'src', 'modules', 'evidence', 'public.ts'),
  'utf8',
);
const evidenceModule = readFileSync(
  join(repoRoot, 'src', 'modules', 'evidence', 'internal', 'evidence-module.ts'),
  'utf8',
);
const evidenceRoutes = readFileSync(join(repoRoot, 'src', 'api', 'evidence-routes.ts'), 'utf8');

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

test('the evidence table carries the required domain contract fields (EVID-001 data contract)', () => {
  const columns = columnsOf(createTableBlock(migration015, 'evidence'));
  for (const required of [
    'evidence_id', // immutable opaque identifier (server-generated)
    'client_id', // Client ownership reference (FK) — hard boundary
    'workspace_id', // optional Workspace scope FK (within the Client)
    'class', // the 8-class evidence taxonomy
    'source_system', // declared source of the evidence (EVID-AC-01)
    'source_ref', // optional opaque external source reference
    'observed_at', // the evidence's own timestamp (EVID-AC-01)
    'content', // traceable content payload (non-empty jsonb object)
    'content_ref', // optional opaque durable-artifact reference
    'quality', // the A..F quality grade
    'confidence', // SEPARATE caller-declared confidence dimension
    'supersedes_evidence_id', // the append-only supersession relation
    'recorded_actor', // SERVER-DERIVED provenance: actor
    'recorded_via', // SERVER-DERIVED provenance: recording system
    'correlation_id', // SERVER-DERIVED provenance: correlation
    'causation_id', // SERVER-DERIVED provenance: causation
    'recorded_at', // SERVER-DERIVED provenance: recording timestamp
  ]) {
    assert.ok(columns.includes(required), `evidence.${required} required`);
  }
  // Server-generated identity + Client ownership FK backstop; Workspace
  // scope is an OPTIONAL FK (client-wide evidence has NULL scope). NO
  // on-delete cascade: immutable history is never erased by parent deletes.
  assert.ok(
    migration015.includes('client_id              uuid        NOT NULL REFERENCES clients(client_id)'),
    'Client ownership must be a NOT NULL FK to clients (no cascade — history survives)',
  );
  assert.ok(
    migration015.includes('workspace_id           uuid        REFERENCES workspaces(workspace_id)'),
    'Workspace scope must be a (nullable) FK to workspaces',
  );
});

test('Evidence ownership is exactly the client_id FK + optional workspace scope — no conflation, no alternate authority', () => {
  const evidenceColumns = columnsOf(createTableBlock(migration015, 'evidence'));
  for (const column of evidenceColumns) {
    if (column === 'client_id' || column === 'workspace_id') continue;
    assert.ok(
      !/owner|role|user|admin|permission/.test(column),
      `evidence must not carry ownership/role/user columns (found '${column}')`,
    );
  }

  // The Client→Evidence relationship lives ONLY in evidence.client_id: no
  // evidence column leaks upward into clients/workspaces/agencies/users,
  // and migration 015 must not redefine the earlier frozen tables.
  for (const [migration, table] of [
    [migration002, 'agencies'],
    [migration002, 'users'],
    [migration003, 'clients'],
    [migration004, 'workspaces'],
  ] as const) {
    for (const column of columnsOf(createTableBlock(migration, table))) {
      assert.ok(
        !/evidence/.test(column),
        `${table}.${column} — the Client→Evidence relationship must not leak above /evidence`,
      );
    }
  }
  for (const table of ['agencies', 'users', 'clients', 'workspaces']) {
    assert.ok(
      !migration015.includes(`CREATE TABLE IF NOT EXISTS ${table} (`),
      `015 must not redefine the frozen ${table} table`,
    );
  }
  // No new tables beyond evidence in migration 015 (no permission engine,
  // no metric/experiment/learning structures — those are MKT-014..016).
  const createdTables = [...migration015.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    createdTables,
    ['evidence'],
    'migration 015 must create exactly the evidence table — no second authority structures',
  );
});

test('the migration class CHECK and the code taxonomy describe ONE class set; quality is the closed A..F set', () => {
  const evidenceBlock = createTableBlock(migration015, 'evidence');
  for (const cls of EVIDENCE_CLASSES) {
    assert.ok(evidenceBlock.includes(`'${cls}'`), `class CHECK must enumerate '${cls}'`);
  }
  assert.ok(
    evidenceBlock.includes("class IN ('source_fact', 'observation'"),
    'the class CHECK must be the closed 8-class enumeration',
  );
  assert.ok(
    evidenceBlock.includes("quality ~ '^[A-F]$'"),
    'quality must be CHECKed to a single A..F letter (closed, interpretable set)',
  );
  assert.ok(
    evidenceBlock.includes("jsonb_typeof(content) = 'object'"),
    'content must be CHECKed to be a jsonb object',
  );
  assert.ok(
    evidenceBlock.includes("content <> '{}'::jsonb"),
    'content must be CHECKed to be non-empty (traceable content)',
  );
  assert.ok(
    evidenceBlock.includes('confidence >= 0 AND confidence <= 1'),
    'confidence must be CHECKed to the 0..1 range',
  );
});

test('the append-only backstop exists: UPDATE and DELETE are rejected by the database (EVID-AC-02)', () => {
  assert.ok(
    migration015.includes('evidence_append_only'),
    'the append-only trigger function must exist',
  );
  assert.ok(
    migration015.includes('evidence_append_only_update_trigger'),
    'the BEFORE UPDATE trigger must be wired',
  );
  assert.ok(
    migration015.includes('evidence_append_only_delete_trigger'),
    'the BEFORE DELETE trigger must be wired',
  );
  const triggerBody = migration015.slice(
    migration015.indexOf('CREATE OR REPLACE FUNCTION evidence_append_only'),
    migration015.indexOf("$$ LANGUAGE plpgsql;", migration015.indexOf('evidence_append_only')),
  );
  assert.ok(
    triggerBody.includes("'evidence is append-only: % is rejected on evidence %'"),
    'the trigger must reject both operations explicitly',
  );
});

test('the supersession fence and the EVID-AC-03 storage backstop exist', () => {
  // ONE superseding record per prior record (duplicate convergence).
  assert.ok(
    migration015.includes('CREATE UNIQUE INDEX IF NOT EXISTS evidence_supersession_fence'),
    'the partial unique supersession fence must exist',
  );
  assert.ok(
    migration015.includes('ON evidence (supersedes_evidence_id) WHERE supersedes_evidence_id IS NOT NULL'),
    'the fence must be partial over the backward supersession pointer',
  );

  // Tier preservation: claims are never auto-promoted to authoritative
  // classes, and supersession can never cross the Client boundary.
  assert.ok(
    migration015.includes('evidence_supersession_legal'),
    'the supersession legality trigger must exist',
  );
  const triggerBody = migration015.slice(
    migration015.indexOf('CREATE OR REPLACE FUNCTION evidence_supersession_legal'),
    migration015.indexOf("$$ LANGUAGE plpgsql;", migration015.indexOf('evidence_supersession_legal')),
  );
  assert.ok(
    triggerBody.includes("evidence_class_tier(v_prior_class) <> evidence_class_tier(NEW.class)"),
    'the trigger must enforce tier preservation',
  );
  assert.ok(
    triggerBody.includes('claims are never auto-promoted to authoritative classes'),
    'the claim→authoritative direction must be rejected by name (EVID-AC-03)',
  );
  assert.ok(
    triggerBody.includes('v_prior_client <> NEW.client_id'),
    'cross-tenant supersession must be rejected by the database',
  );
  // The tier function itself: source_fact/observation are the only
  // authoritative classes.
  const tierFunction = migration015.slice(
    migration015.indexOf('CREATE OR REPLACE FUNCTION evidence_class_tier'),
    migration015.indexOf("$$ LANGUAGE plpgsql;", migration015.indexOf('evidence_class_tier')),
  );
  assert.ok(
    tierFunction.includes("cls IN ('source_fact', 'observation')"),
    'the DB tier function must mark exactly source_fact/observation authoritative',
  );
});

test('the workspace scope can never cross the Client boundary in the database', () => {
  assert.ok(
    migration015.includes('evidence_workspace_within_client'),
    'the workspace-within-client trigger must exist',
  );
  const triggerBody = migration015.slice(
    migration015.indexOf('CREATE OR REPLACE FUNCTION evidence_workspace_within_client'),
    migration015.indexOf(
      '$$ LANGUAGE plpgsql;',
      migration015.indexOf('evidence_workspace_within_client'),
    ),
  );
  assert.ok(
    triggerBody.includes('w.workspace_id = NEW.workspace_id AND w.client_id = NEW.client_id'),
    'the trigger must require the workspace to belong to the record client',
  );
});

test('the /evidence public contract exposes canonical owner resolution over allowed dependencies only', () => {
  assert.ok(
    evidencePublic.includes('export interface EvidenceOwnerContext'),
    'EvidenceOwnerContext must be part of the public contract',
  );
  assert.ok(
    evidencePublic.includes('resolveEvidenceOwnership'),
    'canonical ownership resolution must be part of the module API',
  );
  assert.ok(
    evidencePublic.includes("kind: 'evidence'"),
    'the owner context must carry the evidence-scoped OwnerScope shape',
  );
  assert.ok(
    evidencePublic.includes('export function composeEvidenceOwnerContext'),
    'the pure composer must be exported',
  );
  // Provenance is a separate, server-derived input dimension.
  assert.ok(
    evidencePublic.includes('export interface EvidenceProvenance'),
    'the server-derived provenance argument type must be part of the contract',
  );

  // Dependency matrix: /evidence ──→ /clients, /workspaces, /executions.
  // The public entry must not import any other module (and uses a subset).
  const imports = [...evidencePublic.matchAll(/from '\.\.\/([\w-]+)\/public\.ts'/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    [...new Set(imports)].sort(),
    ['clients', 'workspaces'],
    'public.ts may only import /clients and /workspaces among module publics (frozen matrix: /evidence ──→ /clients, /workspaces, /executions)',
  );
  for (const forbidden of [
    'agencies',
    'auth',
    'users',
    'playbooks',
    'workflows',
    'deployments',
    'policies',
    'audit',
    'metrics',
    'experiments',
    'learnings',
    'integrations',
  ]) {
    assert.ok(
      !imports.includes(forbidden),
      `/evidence must not depend on /${forbidden} (frozen matrix)`,
    );
  }
});

test('no mutation authority and no promotion path exist in the /evidence implementation (EVID-AC-02/03)', () => {
  // The module implementation composes /clients + /workspaces canonical
  // ownership — it never re-derives and never invents an authority.
  assert.ok(
    evidenceModule.includes('resolveClientOwnership'),
    'the evidence module must resolve Client ownership THROUGH /clients',
  );
  assert.ok(
    evidenceModule.includes('resolveWorkspaceOwnership'),
    'the evidence module must resolve Workspace scope THROUGH /workspaces',
  );
  // The module surface is append + read only: no update, no delete, no
  // class-rewrite, no promotion method anywhere in the module.
  for (const forbidden of [
    'updateEvidence',
    'deleteEvidence',
    'promoteEvidence',
    'promote(',
    'setEvidenceClass',
  ]) {
    assert.ok(
      !evidenceModule.includes(forbidden) && !evidencePublic.includes(forbidden),
      `the evidence module must not expose '${forbidden}' (append-only, no promotion)`,
    );
  }
});

test('the route surface is append-only: POST/GET registrations only, no update or delete routes (EVID-AC-02/03)', () => {
  // Every router.add registration in the evidence routes file is POST or
  // GET — there is no PATCH, PUT or DELETE surface at all.
  const registrations = [...evidenceRoutes.matchAll(/router\.add\(\s*'(\w+)',\s*'([^']+)'/g)].map(
    (match) => [match[1]!, match[2]!] as const,
  );
  assert.ok(registrations.length >= 4, 'the evidence routes file must register its routes');
  for (const [method, path] of registrations) {
    assert.ok(
      method === 'POST' || method === 'GET',
      `evidence routes must only register POST/GET (found ${method} ${path})`,
    );
  }
  // The registered paths are exactly the evidence surface.
  for (const [, path] of registrations) {
    const normalized = path.replace(/:clientId|:evidenceId/g, '').replace(/\/+/g, '/');
    assert.ok(
      normalized === '/api/clients/evidence' ||
        normalized === '/api/evidence' ||
        normalized.startsWith('/api/evidence/'),
      `evidence routes must only register evidence paths (found '${path}')`,
    );
  }
  // Supersession is its own EXPLICIT command route (not reachable from the
  // plain append route).
  assert.ok(
    evidenceRoutes.includes("'/api/evidence/:evidenceId/supersede'"),
    'the explicit supersede command route must exist',
  );
  // The route layer must use the shared authorize helpers (which resolve
  // canonical ownership first) — never a private permission engine.
  assert.ok(
    evidenceRoutes.includes('requireEvidenceAccess'),
    'evidence routes must authorize through the shared requireEvidenceAccess helper',
  );
  assert.ok(
    evidenceRoutes.includes('requireClientAccess'),
    'client-scoped evidence routes must authorize through requireClientAccess',
  );
  assert.ok(
    !/role.*engine|permissionTable|canAccess|hasPermission/.test(evidenceRoutes),
    'evidence routes must not carry a private permission engine',
  );
});

test('the DTO discipline is structural: provenance, identity, ownership and supersession are caller-rejected (EVID-AC-03 posture)', () => {
  // The create forbidden list covers every server-derived dimension.
  const createList = evidenceRoutes.slice(
    evidenceRoutes.indexOf('EVIDENCE_CREATE_AUTHORITY_FIELDS'),
    evidenceRoutes.indexOf('] as const;', evidenceRoutes.indexOf('EVIDENCE_CREATE_AUTHORITY_FIELDS')),
  );
  for (const forbidden of [
    'evidenceId',
    'clientId',
    'agencyId',
    'provenance',
    'actor',
    'recordedActor',
    'recordedVia',
    'correlationId',
    'causationId',
    'recordedAt',
    'supersedes',
    'supersedesBy',
    'supersedesEvidenceId',
    'supersededBy',
    'secret',
    'password',
    'apiKey',
  ]) {
    assert.ok(
      createList.includes(`'${forbidden}'`),
      `the create DTO must reject the authority field '${forbidden}'`,
    );
  }
  // The supersede DTO additionally rejects workspaceId (scope is INHERITED
  // from the prior record — corrections never move scope).
  const supersedeList = evidenceRoutes.slice(
    evidenceRoutes.indexOf('EVIDENCE_SUPERSEDE_AUTHORITY_FIELDS'),
    evidenceRoutes.indexOf('] as const;', evidenceRoutes.indexOf('EVIDENCE_SUPERSEDE_AUTHORITY_FIELDS')),
  );
  assert.ok(
    supersedeList.includes("'workspaceId'"),
    'the supersede DTO must reject workspaceId (scope-preserving correction)',
  );
  // Both route validations actually apply their forbidden lists.
  const forbiddenKeyUses = [...evidenceRoutes.matchAll(/forbiddenKeys: (\w+)/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    forbiddenKeyUses.sort(),
    ['EVIDENCE_CREATE_AUTHORITY_FIELDS', 'EVIDENCE_SUPERSEDE_AUTHORITY_FIELDS'],
    'both evidence DTOs must apply their forbidden authority-field lists',
  );
});
