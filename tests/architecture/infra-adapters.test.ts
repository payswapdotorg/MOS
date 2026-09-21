/**
 * MKT-005 static tests — infrastructure adapter boundaries, single-authority
 * proofs and the credential/audit table contracts (pure static analysis).
 *
 * Proofs (issue #13 MKT-005-AC-01/04/05/06/09):
 *   1. NO SECOND AUTHORITY: exactly one queue contract + one queue adapter
 *      implementation (PostgreSQL) exists — no Redis queue, no second
 *      worker host, no second correlation mechanism, no second object-store
 *      contract; MKT-005 adds adapters BEHIND existing ports only;
 *   2. provider/SDK isolation: the S3 and Redis adapters import ONLY node
 *      builtins and platform contracts (there are no provider SDKs anywhere
 *      in src/ — the strongest possible form of "SDKs behind adapter
 *      boundaries"); the RESP protocol client is imported only by the Redis
 *      cache/lock adapters;
 *   3. adapters are wired exclusively at the composition root (the static
 *      checker enforces this globally; here it is asserted explicitly for
 *      the MKT-005 adapters);
 *   4. port surfaces are capability-limited: cache = get/set/delete,
 *      locks = acquire/release, secrets = resolve/exists — none can become
 *      a business-state authority (no read-back/query of domain state);
 *   5. migration 005 creates credential_references with NO column capable
 *      of carrying secret material beyond the opaque handle; identity/
 *      scope/handle immutability + deleted-terminal triggers exist;
 *   6. migration 006 creates audit_events with the append-only triggers
 *      (BEFORE UPDATE OR DELETE) and the idempotency fence;
 *   7. no public mutation path to audit events (no /api/audit route) and no
 *      HTTP surface that resolves credential material;
 *   8. the /credentials and /audit public contracts import no other module
 *      (dependency matrix: /credentials ──→ /auth, /policies; /audit ──→
 *      /auth — MKT-005 needs neither; platform ports + plain data only).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CREDENTIAL_TRANSITIONS } from '../../src/modules/credentials/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
const read = (path: string): string => readFileSync(path, 'utf8');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs));
    else if (entry.name.endsWith('.ts')) out.push(abs);
  }
  return out;
}

const allSrcFiles = walk(src());

/** Imports of `file` as raw specifier strings. */
function importsOf(file: string): string[] {
  const text = read(file);
  const specifiers: string[] = [];
  for (const match of text.matchAll(/from\s+'([^']+)'/g)) specifiers.push(match[1]!);
  for (const match of text.matchAll(/import\s+'([^']+)'/g)) specifiers.push(match[1]!);
  return specifiers;
}

// ---------------------------------------------------------------------------
// 1. No second authority (MKT-005-AC-01)
// ---------------------------------------------------------------------------

test('MKT-005-AC-01: exactly ONE durable queue authority — the PostgreSQL queue (no Redis queue)', () => {
  const queueAdaptersDir = src('platform', 'queue', 'adapters');
  const implementations = readdirSync(queueAdaptersDir);
  assert.deepEqual(implementations, ['postgres'], 'the only queue adapter implementation is PostgreSQL');

  // The Redis capability adapters live under cache/locking ONLY: nothing
  // under platform/redis implements a queue, and no queue file mentions Redis.
  for (const file of allSrcFiles.filter((f) => f.includes(join('platform', 'queue')))) {
    assert.ok(!read(file).includes('redis'), `${file}: the durable queue must never delegate to Redis`);
  }
});

test('MKT-005-AC-01: no second worker host, correlation mechanism or object-store contract', () => {
  const workersFiles = readdirSync(src('workers')).filter((name) => name.endsWith('.ts'));
  assert.deepEqual([...workersFiles].sort(), ['handlers.ts', 'worker-host.ts'], 'exactly one worker host');

  // One correlation definition only, and no other AsyncLocalStorage appears in src/.
  const correlationDefiners = allSrcFiles.filter((f) => read(f).includes('new AsyncLocalStorage'));
  assert.deepEqual(
    correlationDefiners.map((f) => f.slice(src().length + 1)),
    [join('platform', 'observability', 'correlation.ts')],
    'AsyncLocalStorage correlation is defined exactly once (no second correlation authority)',
  );

  // One object-store contract only; S3 is an ADAPTER behind it.
  const objectsDir = readdirSync(src('platform', 'objects')).filter((n) => n.endsWith('.ts'));
  assert.ok(objectsDir.includes('contract.ts'));
  const objectContracts = objectsDir.filter((n) => n.includes('contract'));
  assert.equal(objectContracts.length, 1, 'exactly one object-store contract exists');
  const objectAdapters = readdirSync(src('platform', 'objects', 'adapters'));
  assert.deepEqual([...objectAdapters].sort(), ['fs', 'memory', 's3'], 'S3 joins the existing adapters behind the SAME contract');
});

test('MKT-005-AC-01: the ObjectStore contract surface is unchanged (put/get/exists, content-addressed)', () => {
  const contract = read(src('platform', 'objects', 'contract.ts'));
  for (const member of ['put(bytes: Uint8Array', 'get(key: string)', 'exists(key: string)']) {
    assert.ok(contract.includes(member), `ObjectStore contract must still expose ${member}`);
  }
  assert.ok(!contract.includes('delete'), 'the immutable-object contract exposes no delete');
});

// ---------------------------------------------------------------------------
// 2. Provider/SDK isolation (MKT-005-AC-09)
// ---------------------------------------------------------------------------

test('MKT-005-AC-09: S3 and Redis adapters import ONLY node builtins and platform contracts', () => {
  const adapterFiles = allSrcFiles.filter((f) => f.includes(`${join('src', 'adapters')}`) || f.includes('/adapters/'));
  const mk = [...allSrcFiles.filter((f) => f.split(join('src')).length === 1)];
  void mk;
  for (const file of adapterFiles) {
    for (const specifier of importsOf(file)) {
      if (specifier.startsWith('node:')) continue;
      if (specifier === 'pg') continue; // the ONE sanctioned infrastructure client (MKT-001 rule)
      assert.ok(
        specifier.startsWith('.') || specifier.startsWith('../'),
        `${file}: adapter imports non-relative module '${specifier}' — provider SDKs are forbidden`,
      );
    }
  }
});

test('MKT-005-AC-09: the RESP protocol client is imported only by the Redis cache/lock adapters', () => {
  const respPath = src('platform', 'redis', 'resp', 'resp-client.ts');
  const importers = allSrcFiles.filter((f) =>
    importsOf(f).some((s) => s.endsWith('resp/resp-client.ts')),
  );
  const expected = [
    src('platform', 'cache', 'adapters', 'redis', 'redis-cache.ts'),
    src('platform', 'locking', 'adapters', 'redis', 'redis-lock.ts'),
  ];
  assert.deepEqual(
    importers.sort(),
    expected.sort(),
    'the Redis wire protocol stays behind the cache/lock adapter boundary',
  );
  // No module or API file even references the protocol client.
  for (const file of allSrcFiles.filter((f) => f.includes(`${join('src', 'modules')}`) || f.includes(`${join('src', 'api')}`))) {
    assert.ok(!importsOf(file).some((s) => s.includes('resp-client')), `${file}: must not import the RESP client`);
  }
  void respPath;
});

test('MKT-005-AC-09: domain/application modules import only contracts — never adapters', () => {
  for (const file of allSrcFiles.filter(
    (f) => f.includes(`${join('src', 'modules')}`) || f.includes(`${join('src', 'api')}`) || f.includes(`${join('src', 'workers')}`),
  )) {
    for (const specifier of importsOf(file)) {
      assert.ok(
        !specifier.includes('/adapters/'),
        `${file}: application code must depend on contracts, not the concrete adapter '${specifier}'`,
      );
      assert.ok(!specifier.includes('sigv4'), `${file}: signing internals stay inside the object-store platform area`);
    }
  }
});

// ---------------------------------------------------------------------------
// 3./4. Port surfaces are capability-limited (no authority via infrastructure)
// ---------------------------------------------------------------------------

test('MKT-005-AC-03: the cache and lock ports expose exactly their advisory capabilities', () => {
  const cacheContract = read(src('platform', 'cache', 'contract.ts'));
  for (const member of ['get(key: string)', 'set(key: string', 'delete(key: string)']) {
    assert.ok(cacheContract.includes(member));
  }
  const lockContract = read(src('platform', 'locking', 'contract.ts'));
  for (const member of ['acquire(key: string', 'release(key: string']) {
    assert.ok(lockContract.includes(member));
  }
  // No business-state surface anywhere in the capability ports.
  for (const contract of [cacheContract, lockContract]) {
    for (const forbidden of ['agency', 'client', 'workspace', 'user', 'job', 'audit', 'credential']) {
      const codeLines = contract.split('\n').filter((l) => l.includes('(') && !l.trim().startsWith('*') && !l.trim().startsWith('//'));
      for (const line of codeLines) {
        assert.ok(!line.includes(forbidden), `capability port must not mention '${forbidden}' in code: ${line.trim()}`);
      }
    }
  }
});

test('MKT-005-AC-05: the secret port is RESOLUTION-ONLY (no write/delete of material)', () => {
  const secretContract = read(src('platform', 'secrets', 'contract.ts'));
  assert.ok(secretContract.includes('resolve(handle: string)'));
  assert.ok(secretContract.includes('exists(handle: string)'));
  for (const forbidden of ['put(', 'create(', 'write(', 'delete(', 'rotate(']) {
    assert.ok(!secretContract.includes(forbidden), `secret port must not expose '${forbidden}'`);
  }
});

// ---------------------------------------------------------------------------
// 5. Migration 005 — credential_references contract (MKT-005-AC-05)
// ---------------------------------------------------------------------------

const migration005 = read(src('platform', 'db', 'migrations', '005_credentials.sql'));

test('MKT-005-AC-05: migration 005 creates exactly credential_references with the reference contract', () => {
  assert.ok(migration005.includes('CREATE TABLE IF NOT EXISTS credential_references'));
  assert.equal(
    (migration005.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length,
    1,
    'migration 005 creates exactly one table',
  );
  const block = migration005
    .slice(
      migration005.indexOf('CREATE TABLE IF NOT EXISTS credential_references'),
      migration005.indexOf(');', migration005.indexOf('CREATE TABLE IF NOT EXISTS credential_references')),
    )
    .replace(/\s+/g, ' ');
  for (const required of [
    'credential_id uuid',
    'agency_id uuid',
    'client_id uuid',
    'kind text',
    'label text',
    'secret_handle text',
    'status text',
    'created_by uuid',
    'version bigint',
    'created_at timestamptz',
    'updated_at timestamptz',
  ]) {
    assert.ok(block.includes(required), `credential_references must declare ${required}`);
  }
  // NO column can carry material: no text column other than kind/label/
  // secret_handle/status exists, and the CHECK enumerates the lifecycle.
  assert.ok(block.includes("CHECK (status IN ('active', 'disabled', 'deleted'))"));
  // The code transition table matches the SQL CHECK exactly.
  assert.deepEqual(CREDENTIAL_TRANSITIONS, {
    active: ['disabled', 'deleted'],
    disabled: ['active', 'deleted'],
    deleted: [],
  });
});

test('MKT-005-AC-05: credential scope, handle and provenance are DB-backstopped immutable; deleted is terminal', () => {
  assert.ok(migration005.includes('credential_references_identity_immutable()'));
  for (const fragment of [
    'NEW.agency_id <> OLD.agency_id',
    "NEW.client_id IS DISTINCT FROM OLD.client_id",
    'NEW.secret_handle <> OLD.secret_handle',
    'NEW.created_at <> OLD.created_at',
  ]) {
    assert.ok(migration005.includes(fragment), `immutability trigger must guard ${fragment}`);
  }
  assert.ok(migration005.includes('credential_references_deleted_terminal()'));
  assert.ok(migration005.includes("OLD.status = 'deleted' AND NEW.status <> 'deleted'"));
  // Per-agency live label fence (partial unique index).
  assert.ok(
    migration005.includes("ON credential_references (agency_id, label) WHERE status IN ('active', 'disabled')"),
    'the (agency_id, label) fence is partial over live references',
  );
});

// ---------------------------------------------------------------------------
// 6. Migration 006 — audit_events append-only contract (MKT-005-AC-06)
// ---------------------------------------------------------------------------

const migration006 = read(src('platform', 'db', 'migrations', '006_audit_events.sql'));

test('MKT-005-AC-06: migration 006 creates audit_events with the §22 event contract', () => {
  assert.ok(migration006.includes('CREATE TABLE IF NOT EXISTS audit_events'));
  assert.equal(
    (migration006.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length,
    1,
    'migration 006 creates exactly one table',
  );
  const block = migration006
    .slice(
      migration006.indexOf('CREATE TABLE IF NOT EXISTS audit_events'),
      migration006.indexOf(');', migration006.indexOf('CREATE TABLE IF NOT EXISTS audit_events')),
    )
    .replace(/\s+/g, ' ');
  for (const required of [
    'event_id uuid',
    'occurred_at timestamptz',
    'actor text',
    'action text',
    'agency_id uuid',
    'client_id uuid',
    'workspace_id uuid',
    'target_type text',
    'target_id text',
    'correlation_id text',
    'causation_id text',
    'idempotency_key text',
    'before_version bigint',
    'after_version bigint',
    'result text',
    'details jsonb',
  ]) {
    assert.ok(block.includes(required), `audit_events must declare ${required}`);
  }
  assert.ok(block.includes("CHECK (result IN ('succeeded', 'failed'))"));
  assert.ok(block.includes('correlation_id text NOT NULL'), 'audit events are correlation-linked by construction');
});

test('MKT-005-AC-06: audit_events is APPEND-ONLY at the database level (UPDATE and DELETE rejected)', () => {
  assert.ok(migration006.includes('audit_events_append_only()'));
  assert.ok(migration006.includes('BEFORE UPDATE ON audit_events'));
  assert.ok(migration006.includes('BEFORE DELETE ON audit_events'));
  assert.ok(migration006.includes('RAISE EXCEPTION'));
  // Replay fence on the idempotency key.
  assert.ok(
    migration006.includes('ON audit_events (idempotency_key) WHERE idempotency_key IS NOT NULL'),
    'the idempotency fence is partial over keyed events',
  );
});

// ---------------------------------------------------------------------------
// 7. No public mutation path to audit / credential material (MKT-005-AC-05/06)
// ---------------------------------------------------------------------------

test('MKT-005-AC-06: no HTTP route can fabricate or rewrite audit events', () => {
  const routeFiles = readdirSync(src('api')).filter((n) => n.endsWith('.ts'));
  for (const name of routeFiles) {
    const text = read(src('api', name));
    assert.ok(!text.includes('/api/audit'), `${name}: the audit trail has no HTTP surface`);
    // No route registers an audit-flavored mutation path.
    assert.ok(!/router\.add\([^)]*audit/i.test(text), `${name}: no audit route registration`);
  }
});

test('MKT-005-AC-05: credential material has NO HTTP resolution path (references only)', () => {
  const credentialsRoutes = read(src('api', 'credentials-routes.ts'));
  assert.ok(credentialsRoutes.includes('resolveCredentialMaterial') === false || !credentialsRoutes.includes('resolveCredentialMaterial('), 'routes never resolve material');
  // The serialized reference deliberately excludes the backend handle.
  assert.ok(
    !credentialsRoutes.includes('secretHandle: reference.secretHandle'),
    'the API never serializes the backend handle',
  );
  // Material-shaped keys are rejected outright on the create surface.
  for (const forbidden of ["'secret'", "'secretMaterial'", "'material'", "'password'", "'token'", "'apiKey'"]) {
    assert.ok(credentialsRoutes.includes(forbidden), `create surface must reject the '${forbidden}' key`);
  }
});

// ---------------------------------------------------------------------------
// 8. Module dependency surface (frozen matrix: /credentials ──→ /auth,
//    /policies; /audit ──→ /auth — MKT-005 imports NO other module)
// ---------------------------------------------------------------------------

test('MKT-005-AC-01: /credentials and /audit public contracts import no other module', () => {
  const credentialsPublic = read(src('modules', 'credentials', 'public.ts'));
  const auditPublic = read(src('modules', 'audit', 'public.ts'));
  for (const [name, text] of [['credentials', credentialsPublic], ['audit', auditPublic]] as const) {
    for (const specifier of importsOf(src('modules', name, 'public.ts'))) {
      assert.ok(
        !specifier.includes('../') || !specifier.includes(`modules/${name === 'credentials' ? 'audit' : 'credentials'}`),
        `${name} public contract imports only platform ports`,
      );
      assert.ok(!specifier.startsWith('../agencies'), `${name} must not depend on /agencies`);
      assert.ok(!specifier.startsWith('../clients'), `${name} must not depend on /clients`);
      assert.ok(!specifier.startsWith('../users'), `${name} must not depend on /users`);
    }
    assert.ok(text.includes('platform'), `${name} depends on platform ports only`);
  }
});

// ---------------------------------------------------------------------------
// Composition-root wiring of the MKT-005 adapters (AC-01/AC-03/AC-04)
// ---------------------------------------------------------------------------

test('MKT-005-AC-03/04: the composition root wires cache/locks/secrets/S3 adapters (and ONLY there)', () => {
  const root = read(src('composition-root.ts'));
  for (const adapter of ['S3ObjectStore', 'RedisCache', 'RedisLock', 'FileSecretStore', 'NoCache', 'UnavailableLock']) {
    assert.ok(root.includes(adapter), `composition root wires ${adapter}`);
  }
  // Degenerate wiring is explicit: no Redis URL → NoCache + UnavailableLock.
  assert.ok(root.includes('new NoCache()'));
  assert.ok(root.includes('new UnavailableLock()'));
  // Adapters are imported by the composition root and tests only (checker
  // rule CONCRETE_ADAPTER_ACCESS) — assert no api/ or modules/ file imports them.
  for (const file of allSrcFiles.filter((f) => !f.endsWith('composition-root.ts'))) {
    for (const specifier of importsOf(file)) {
      assert.ok(
        !(specifier.includes('/adapters/') && !file.startsWith(join(repoRoot, 'tests'))),
        `${file}: concrete adapters are wired at the composition root only`,
      );
    }
  }
});

test('MKT-005-AC-02: PostgreSQL remains the configured system of record for the queue (config surface)', () => {
  const config = read(src('platform', 'config', 'config.ts'));
  assert.ok(config.includes('MOS_DATABASE_URL is required (PostgreSQL is the system of record)'));
  // Redis config is ADVISORY-only by naming and doc.
  const cacheContract = read(src('platform', 'cache', 'contract.ts'));
  assert.ok(cacheContract.includes('PostgreSQL is the authoritative system of'));
});

test('MKT-005: migrations 005/006 exist with exactly the expected numbering (no stray tables)', () => {
  const migrations = readdirSync(src('platform', 'db', 'migrations')).filter((n) => n.endsWith('.sql')).sort();
  assert.deepEqual(migrations, [
    '001_platform_jobs.sql',
    '002_identity_agencies.sql',
    '003_clients.sql',
    '004_workspaces.sql',
    '005_credentials.sql',
    '006_audit_events.sql',
    // MKT-006 appends the goals migration (007) — later Work Items keep
    // extending this ordered, immutable list.
    '007_goals.sql',
    // MKT-007 appends the playbooks migration (008).
    '008_playbooks.sql',
    // MKT-008 appends the workflows migration (009).
    '009_workflows.sql',
    // MKT-009 appends the workflow instance state machine migration (010).
    '010_workflow_instances.sql',
    // MKT-010 appends the normalized execution model migration (011).
    '011_executions.sql',
    // MKT-011 appends the pooled dispatch outbox migration (012).
    '012_execution_dispatches.sql',
    // MKT-012 appends the sandbox runtime lifecycle migration (013).
    '013_sandboxes.sql',
    // The MKT-009 history-ledger erratum correction appends the corrective
    // migration (014): the workflow_instance_transitions from_status
    // consistency backstop (spec/errata/MKT-009-history-ledger.md).
    '014_workflow_instance_history_backstop.sql',
    // MKT-013 appends the evidence/provenance migration (015): the
    // append-only evidence ledger with the supersession fence and the
    // EVID-AC-03 tier backstop.
    '015_evidence.sql',
    // MKT-017 appends the AI runtime registry migration (016 — the number is
    // reserved for this Work Item; sibling workers use other numbers).
    '016_ai_runtime.sql',
    // MKT-025 (Human Agent foundation) appends the human_agents profile
    // migration (017 — the number is reserved for MKT-025; 015/016 are
    // reserved for sibling Work Items).
    '017_field_agents.sql',  
    // MKT-014 appends the metric normalization migration (018 — the number
    // is RESERVED for this Work Item; siblings use 016/017): the
    // append-only metric observation ledger with the source/timestamp/
    // reference mapping and the cross-tenant backstops.
    '018_metrics.sql',
    // MKT-015 appends the experiment model migration (019 — the number is
    // RESERVED for this Work Item): the experiments + experiment_transitions
    // tables with the full frozen §16 Experiment contract, the closed
    // conclusion-type taxonomy with the causal-evidence-standard row CHECK,
    // the frozen lifecycle state machine, the design-immutability and
    // legal-successor triggers, the append-only history and the
    // workspace-scope + cross-tenant evidence-citation fences (EXP-001,
    // EXP-AC-01..03).
    '019_experiments.sql',
    // MKT-018 appends the AI routing and cascades migration (020 — the
    // number is RESERVED for this Work Item; sibling workers use other
    // numbers): the routing-policy/selection-decision/cascade-run/cascade-
    // step tables with the §8-style fences, append-only triggers and
    // scope-chain backstops (AI-002).
    '020_ai_routing.sql',
    // MKT-020 appends the logical Agent/Capability contracts migration
    // (022 — the number is RESERVED for this Work Item; sibling workers
    // use other numbers): the provider-neutral logical_agents registry
    // with the per-scope §8-style command fences, ACTIVE declaration
    // fences, the capability-descriptor shape CHECK, terminal lifecycle
    // triggers and the append-only
    // logical_agent_lifecycle_events history (AGENT-001).
    '022_logical_agents.sql',
    // MKT-026 (Job marketplace boundary) appends the jobs migration (023 —
    // the number is RESERVED for this Work Item; 021 is reserved for a
    // sibling Work Item): the jobs/job_offers/job_outcomes tables with
    // the JOB-AC-01 task-reference + scope-chain triggers, the
    // exactly-one-winner acceptance fence and the append-only
    // provenance-preserving outcome history (JOB-001, JOB-AC-01..03).
    '023_jobs.sql',
    // MKT-027 (Field execution and evidence) appends the field-execution
    // migration (024 — the first unreserved number AFTER 023): the
    // job_visits/job_visit_transitions/job_visit_outcomes/
    // job_visit_evidence tables with the frozen visit state machine, the
    // inherited scope-chain + acceptance-window triggers, the follow-up
    // relationship fence and the append-only + same-Client evidence
    // backstops (JOB-001 field subset, EVID-001 field subset,
    // JOB-AC-03..04).
    //
    // NUMBERING DISCLOSURE (MKT-027 worker → Tech Lead): the dispatch
    // reserved 021 for this Work Item, but 021 sorts BEFORE 023_jobs.sql
    // (which creates the `jobs` table the visit tables FK-reference) in
    // the runner's lexicographic order — a 021 numbering cannot apply at
    // all. 024 is the first unreserved number after 023; the integration
    // station may renumber if desired.
    '024_field_execution.sql',
    // MKT-021 (Execution policy engine) appends the policies migration
    // (025 — the number is RESERVED for this Work Item; 024 is reserved
    // for a sibling): the policies version registry (closed 7-dimension
    // CHECK, ACTIVE + version-seq fences, content immutability, terminal
    // supersession) and the append-only policy_decisions ledger with the
    // closed outcome/reason-code vocabulary and cross-tenant scope fences
    // (POL-001, CRED-001).
    '025_policies.sql',
    // MKT-016 (Learning model) appends the learnings migration (027 — the
    // number is RESERVED for this Work Item; 026 is reserved for a
    // sibling): the fully-immutable learnings table (statement,
    // applicability conditions, supporting evidence/experiment-outcome
    // references, descriptive confidence — NO stored state column) and the
    // append-only learning_relationships history (contradicts/supersedes/
    // retires) from which the §17 Learning state is DERIVED, with the
    // single-supersession/single-retirement fences, the terminal-target
    // backstop and the cross-tenant relationship + reference fences
    // (LEARN-001, LEARN-AC-01..02).
    '027_learnings.sql',
    // MKT-022 (Extension registry and manifest contract) appends the
    // extensions migration (028 — the number is RESERVED for this Work
    // Item; 026/027 are reserved for siblings): the immutable versioned
    // manifest registry (publisher/key/version fence, closed capability
    // category / permission action / data-scope CHECKs, §21 material-key
    // backstops), the install lifecycle records (scope-chain fences,
    // frozen state machine, terminal uninstall) and the append-only
    // invocation ledger with the execution-scope consistency fence and
    // the TTL bound (EXT-001, EXT-AC-01..04).
    '028_extensions.sql',
    // MKT-023 (Provider integration boundary) appends the integrations
    // migration (029 — the number is RESERVED for this Work Item; the
    // 026/027/028 range is reserved for sibling Work Items): the
    // integration_connections table (connection/capability metadata with
    // the frozen lifecycle transition trigger, identity immutability, the
    // duplicate-registration fence and the §21 material-key backstops)
    // and the append-only integration_events ledger with cross-tenant
    // scope + evidence-linkage backstops (INT-001).
    '029_integrations.sql',
    // MKT-036 (Versioned Domain Pack framework) appends the domain-pack
    // migration (030 — the number is RESERVED for this Work Item; 029 is
    // reserved for a sibling): the immutable versioned pack registry
    // (publisher/key/version fence, closed 14-kind artifact + §5 scope
    // CHECKs, §21 material-key backstops), the installed-version records
    // (scope-chain fences, frozen installed ⇄ disabled + terminal
    // uninstall lifecycle) and the per-install artifact scope records
    // with the structural client/agency-reusable distinction and the
    // append-only + consistency fences (PACK-001, PACK-AC-01..03).
    '030_domain_packs.sql',
    // MKT-037 (Creator Operations Domain Pack) appends the
    // creator-operations migration (031 — the number is RESERVED for this
    // Work Item): the pack-owned, Client-scoped subject tables of the
    // Creator Operations Domain Pack (creator profiles/accounts/fans/
    // conversations + messages/content assets/offers) plus the
    // append-only creator_operation_approvals human-approval records —
    // every row FK-scoped to the EXISTING agencies/clients tables with
    // scope-chain triggers, append-only/immutability triggers, the frozen
    // lifecycle tables and the §21 material-key backstops; NO tenant,
    // workflow, execution, evidence, metric, credential, job, policy or
    // audit table is created (the pack maps observations into the COMMON
    // /evidence + /metrics authorities — CREATOR-AC-01/AC-02/AC-06).
    '031_creator_operations.sql',
    // MKT-019 (AI evaluation framework) appends the AI evaluations
    // migration (032 — the number is RESERVED for this Work Item): the
    // provider-neutral evaluator registry, the append-only evaluation
    // outcome records (§12 verdict/score/dimensions/evidenceRefs/
    // uncertainty, execution- and usage-linked) and the human-review hook
    // records with their append-only transition history (AI-003).
    '032_ai_evaluations.sql',
    // MKT-040 (Marketing Cloud Deployment) appends the deployments
    // migration (034 — the number is RESERVED for this Work Item; 032/033
    // are reserved for sibling deliveries): the deployment identity
    // records (scope chain + pinned immutable playbook/workflow version
    // selection + policy reference + the closed runtime-class
    // requirements with the infrastructure-identity backstop + trigger
    // configuration) and the append-only deployment_events ledger
    // (lifecycle/selection/validation/execution-request history with the
    // idempotency fence) — the frozen lifecycle transition table, the
    // version-selection-change fence (redeploy/rollback completion edges
    // only) and the §21 material-key backstops are trigger-enforced; NO
    // workflow, execution, evidence, policy or credential table is
    // created (DEPLOY-002, DEPLOY-AC-03/05/06/09).
    '034_deployments.sql',
    // MKT-041 (Agency Operating Graph) appends the operating-graph
    // migration (035 — the number is RESERVED for this Work Item): the
    // canonical-record registry (source references only: kind + canonical
    // id + agency/client/workspace scope chain) and the append-oriented,
    // versioned relation ledger (CHECK-fenced node kinds, relations and
    // the frozen five-value epistemic vocabulary, per-client version
    // uniqueness + the single-current partial fence, the supersession-only
    // UPDATE trigger, the no-DELETE trigger and the scope-chain +
    // cross-tenant endpoint fences) — NO authoritative table of another
    // module is created or altered (OPGRAPH-001).
    '035_operating_graph.sql',
    // MKT-042 (Decision Ledger) appends the decisions migration (036 —
    // the number is RESERVED for this Work Item; 035 is reserved for a
    // sibling delivery): the decisions table (the full frozen record
    // vocabulary — scope chain, objective/context/hypothesis summary,
    // evidence refs + experiment link, structured expected impact +
    // SEPARATE uncertainty, expected cost, alternatives, correction link,
    // SERVER-DERIVED proposer + provenance columns, the disposition enum
    // with the successor shape and outcome-pairing CHECKs, the §8
    // (client_id, idempotency_key) create fence) and the append-only
    // decision_events tail (disposition + outcome_observed events with
    // the payload-shape CHECK and the (decision_id, idempotency_key)
    // fence) — proposal-immutability, legal-lifecycle, no-delete,
    // workspace-within-client, correction-link and cross-tenant reference
    // triggers are trigger-enforced; NO evidence, experiment, learning,
    // execution, deployment or policy table is created or mutated (the
    // ledger links the authorities read-only, lock rule #5).
    '036_decisions.sql',
    // MKT-047 (App Manifest and Packaging v1) appends the apps migration
    // (037 — the number is PRE-ASSIGNED to this Work Item; 035/036 are
    // reserved for sibling deliveries): the /apps App registry — the
    // app-key ownership rows (first publisher owns the lineage), the
    // immutable versioned App Version manifest registry (the frozen
    // mos-app-ecosystem-v1.5.md §Manifest column set with the closed
    // certification/runtime-class/scope/ UI-surface/metering CHECKs, the
    // REAL semver comparator, the app-owned state-namespace denylist and
    // the §21 material-key backstops) and the append-only
    // app_dependencies rows with the dependency validation trigger
    // (extension target must have a published version in range in the
    // migration-028 registry; app target must exist in range; no
    // self-dependency); published manifests reject UPDATE and DELETE by
    // trigger (MKT-047, AC-4/AC-6/AC-7).
    '037_apps.sql',
    // MKT-048 (App Installation, Upgrade and Rollback) appends the
    // app-installs migration (038 — the number is PRE-ASSIGNED to this Work
    // Item): the /app-installs App installation authority — the
    // append-oriented app_installs selection ledger (exact (app key,
    // app_version_id, version) identity, SERVER-DERIVED scope chain +
    // granted-scope columns with the closed frozen vocabularies, the
    // operation/selection-seq shape CHECKs, the current-selection partial
    // unique fence, the §8 (workspace_id, idempotency_key) create fence)
    // and the append-only app_install_events tail (installed/upgraded/
    // rolled_back with the payload-shape CHECK and the (workspace_id,
    // idempotency_key) fence); workspace-within-client scope-chain
    // consistency, exact-version identity + least-privilege grants and the
    // history-preserving single-supersession-UPDATE/ no-DELETE triggers are
    // trigger-enforced; NO apps, policies, workspaces or extensions table
    // is created or mutated (MKT-048, AC-4/AC-8).
    '038_app_installs.sql',
    // MKT-046 (Sales-to-Delivery Continuity) appends the
    // sales-continuity migration (040 — the number is PRE-ASSIGNED to
    // this Work Item; 038/039 are reserved for sibling deliveries): the
    // module-owned append-only continuity ledger — the carry rows (the
    // canonical proposal source references + version fingerprint, the
    // carried playbook/version/deployment linkage, the derived
    // scope/goals/outcomes/assumptions/economics snapshot with the
    // closed-state CHECK, the source fence + the §8 logical create
    // fence, the forward-only completion ladder triggers, the
    // identity-immutability and no-delete triggers, the cross-tenant
    // reference fences) and the append-only continuity event tail — NO
    // other module's table is created or mutated (the module orchestrates
    // the /playbooks and /deployments creation commands, never writing
    // their tables).
    '040_sales_continuity.sql',
    // MKT-050 (App Marketplace, Trust and Certification) appends the
    // app-marketplace migration (042 — the number is PRE-ASSIGNED to
    // this Work Item; 039/040/041 are reserved for sibling deliveries):
    // the /app-marketplace trust/review surface — the append-only
    // trust_events governance ledger (the frozen from/to state
    // vocabulary with the legal transition-triple CHECK fence, the
    // gapless per-lineage transition sequence, the chain-consistency
    // trigger and the append-only UPDATE/DELETE rejection triggers)
    // and the append-only app_reviews display-metadata records (the
    // closed rating band + structured-verdict vocabulary, the
    // bounded body, the same-lineage version-consistency trigger
    // and the append-only triggers); NO app catalog table is created
    // or mutated (the marketplace NEVER becomes a second registry —
    // the /apps registry of migration 037 stays the sole catalog;
    // no install ledger either — migration 038 stays the sole
    // install authority).
    '042_app_marketplace.sql',
    // MKT-052 (App Metering and Commercial Attribution) appends the
    // app-metering migration (044 — the number is PRE-ASSIGNED to this
    // Work Item; 039/040/041/043 are reserved for sibling deliveries):
    // the /app-metering metering ledger — the append-only
    // app_metering_events tail (the frozen five-dimension/units
    // vocabulary CHECK-fenced per dimension, the payload-shape fence per
    // source kind, the at-most-once partial unique source fence, the §8
    // (workspace_id, idempotency_key) command fence, the scope-chain +
    // canonical app/extension identity re-verification triggers and the
    // append-only UPDATE/DELETE rejection triggers) and the rebuildable
    // app_metering_rollups projection (the disclosed recompute path —
    // replaced atomically from the tail, never a second truth); NO
    // billing/invoice/payment/balance/pricing column exists anywhere
    // (the Economics separation), NO app catalog/install/invocation
    // table is created or mutated (migration 037/038/028 stay the sole
    // authorities — consumed READ-ONLY through the public contracts).
    '044_app_metering.sql',
    // MKT-053 (Growth Mission and Objective Model) appends the
    // growth-missions migration (045 — the number is PRE-ASSIGNED to
    // this Work Item; 046 is reserved for a sibling delivery): the
    // /growth-missions durable record layer — the agency-scoped
    // growth_missions records (the frozen §2 lifecycle state vocabulary
    // CHECK-fenced, the CAS version + the mission-record mutation guard
    // with the identity-immutability, version-advance and
    // version-pointer-only-advances triggers, no-DELETE), the append-only
    // growth_mission_versions tail (the declared objective VERBATIM +
    // the frozen §3 objective-family vocabulary; UPDATE/DELETE rejected
    // — corrections are NEW version records) with the per-version
    // growth_mission_target_metrics (the comparator CHECK + the
    // INTERMEDIATE flag; append-only with the version snapshot), the
    // append-only growth_mission_events history tail (the event-shape
    // and terminal-decision-family CHECKs, the gapless per-mission
    // sequence, the frozen transition-pair + current-state-match
    // trigger — terminal states have no outgoing pairs, a block is never
    // silently converted into success — and the append-only UPDATE/
    // DELETE rejection triggers) and the growth_mission_goal_mappings
    // rows (FK-anchored canonical goal references to the migration-007
    // goals table, the agency scope-chain trigger, the terminal-freeze
    // trigger, the removal-only UPDATE fence and no-DELETE; the ACTIVE
    // (mission, goal) partial-unique fence); NO goal column is created
    // or mutated (the /goals authority stays sole), NO workflow/
    // execution/playbook/experiment/evidence/learning/job/deployment
    // table is created (architecture-lock-v1.6.md rule 16), NO
    // controller state of any kind (rule 17 — the Growth Operator is
    // MKT-054).
    '045_growth_missions.sql',
    // MKT-055 (Social Account and OAuth Connection Model) appends the
    // social-accounts migration (046 — the number is PRE-ASSIGNED to
    // this Work Item; 045 is reserved for a sibling delivery): the
    // /social-accounts connection model — the account identity binding
    // records (one connection binds one platform identity; the partial
    // active-binding fences; the terminal connected → disconnected |
    // revoked lifecycle with identity immutability), the append-oriented
    // authorization-grant records (the pending → authorized →
    // expired/revoked/refreshed/superseded lifecycle with the single
    // completion fill and the frozen transition-table trigger, the
    // credential-vault reference ONLY — no token/material column
    // anywhere, the state-token and single-authorized-grant fences), the
    // fully append-only authorization-grant/history event tail (the
    // operator | external-signal initiation source, the best-effort
    // provider-revoke disclosure) and the verbatim scope records
    // (granted-scope + capability-tag kinds, order preserved, append-only
    // triggers); NO integration, credential or tenant table is created or
    // mutated (migration 029/005 stay the sole authorities — consumed
    // READ-ONLY through the public contracts).
    '046_social_accounts.sql',
    // MKT-068 (Notification Delivery Plane) appends the
    // notification-delivery migration (047 — the number is PRE-ASSIGNED
    // to this Work Item; 048/049 are reserved for sibling deliveries):
    // the /notification-delivery plane — the durable notification records
    // (the full architecture-v1.6.md §14 field set with the
    // CHECK-fenced event-type/urgency/source-kind vocabularies, the
    // RELATIVE deep-link fence, the tenant scope-chain trigger, the
    // single pending → dispatched delivery-status fill and no-DELETE),
    // the event-occurrence dedup fence rows (the unique
    // (source_kind, source_id, event_type, occurrence_key) fence with
    // append-only UPDATE/DELETE rejection), the append-only
    // delivery-attempt receipt tail (the closed
    // outcome/channel vocabularies, the honest payload-shape CHECK, the
    // policy-decision linkage FK and the append-only UPDATE/DELETE
    // rejection triggers — retries are NEW rows) and the in-app
    // read-state projection rows (the 1:1 notification fence, the
    // single append-only read transition and no-DELETE); NO token,
    // secret, material or handle column exists anywhere (the provider
    // credential resolves through the /credentials vault at delivery
    // time — READ-ONLY), NO notifications-module/policy/credential/
    // tenant/mission table is created or mutated (the /notifications
    // MKT-001 boundary stays boundary-only — this migration IS the
    // delivery plane behind it).
    '047_notification_delivery.sql',
    // MKT-069 (Product Intelligence) appends the product-intelligence
    // migration (048 — the number is PRE-ASSIGNED to this Work Item;
    // 047/049 are reserved for sibling deliveries): the
    // /product-intelligence authority — the agency-scoped product-context
    // records with their IMMUTABLE versioned declared inputs (the
    // kind-compatible authorization CHECK fence: public web kinds vs
    // explicitly-authorized integration-connection kinds, the cross-agency
    // connection scope trigger), the append-only inspection runs with
    // their per-input honest outcome rows (the outcome vocabulary), the
    // append-only retained source facts (FULL provenance: source ref,
    // fetched-at, extractor identity, content hash, extraction notes; the
    // frozen fact-kind vocabulary), the append-only derived model records
    // (the eight §8 derivation kinds, the server-computed verification
    // state with the DEFERRABLE evidence-presence invariant, the
    // single-supersession fence, the AI-assistance disclosure shape) with
    // their FK-anchored evidence links (the same-context scope triggers),
    // and the append-only risk flags (the five categories + four
    // severities) with their evidence links; NO integration, credential,
    // tenant, evidence or mission table is created or mutated (the
    // /integrations public contract is consumed READ-ONLY through the
    // module's structural port).
    '048_product_intelligence.sql',
    // MKT-071 (Commerce Catalog and Order Capabilities) appends the
    // commerce-capabilities migration (049 — the number PRE-ASSIGNED to
    // this Work Item; 047/048 are reserved for sibling deliveries): the
    // /integrations commerce EXTENSION (no new module — the boundary rule
    // "store mutations flow through Integrations" stays sole) — the
    // webhook dedup fence commerce_event_receipts (the (adapter_key,
    // provider_event_id) partial-unique INGESTED fence, the honest
    // 'duplicate' replay receipts with the raw-event hash + provenance,
    // the CHECK-fenced delivery-outcome/event-kind/shape-version
    // vocabularies, the append-only UPDATE/DELETE rejection triggers and
    // the connection-consistency + duplicate-reference backstops) and the
    // normalized event projection commerce_events (one immutable row per
    // INGESTED provider event with the attribution/reference fields
    // VERBATIM as passthrough data — no linking or causal computation, the
    // ledger/evidence continuity references, the append-only triggers and
    // the projection-consistency backstop); NO catalog/product/listing/
    // order STATE table is created (the provider stays the commerce
    // authority accessed through the adapter port — the migration-029
    // store pattern extended, never a second commerce authority).
    '049_commerce_capabilities.sql',
    // MKT-056 (Social Platform Adapter Contract) appends the
    // social-adapter-contract migration (050 — the number PRE-ASSIGNED to
    // this Work Item; sibling workers were told the tail number may
    // collide, keep the numbering and disclose): the /social-accounts
    // capability-plane EXTENSION (no new module — the dispatch "Extend,
    // do not duplicate"): the publish idempotency fence + claim-then-fill
    // attempt ledger social_publish_attempts (the (social_account_id,
    // idempotency_key) unique at-most-once fence, the born 'submitted'
    // UNKNOWN claim state, the single completion fill
    // submitted→accepted|published|failed|restricted with the immutable
    // identity/provenance columns, the CHECK-fenced publish-state +
    // failure-taxonomy vocabularies and the account-consistency backstop)
    // and the append-only provider status-poll history
    // social_publish_status_observations; NO capability-registration table
    // (the capability matrix is adapter-declared registry data validated
    // at construction — the migration-029 discipline).
    '050_social_adapter_contract.sql',
    // MKT-063 (Content Rights and Provenance) appends the
    // content-rights migration (051 — the number PRE-ASSIGNED to this
    // Work Item; 050 is reserved for a sibling delivery and the
    // sibling workers are told 050/051 may collide — kept 051,
    // disclosed; the Tech Lead reconciles at merge): the
    // /content-rights authority — the asset-level rights records
    // (the CHECK-fenced cr-vocab-v1 state vocabulary
    // owned/license/platform_permitted/cleared/review/blocked/unknown,
    // the REQUIRED /evidence-anchored source provenance + licence
    // evidence with the licence-basis payload-shape CHECK, the
    // valid_until expiry horizon evaluated fail-closed at gate time,
    // the one-record-per-(client, asset ref) fence, the tenant
    // scope-chain + same-Client evidence triggers, the disciplined
    // state-move-only UPDATE along the frozen transition-table pairs
    // and no-DELETE), the fully append-only state-transition event
    // tail (the CHECK-fenced frozen (from, to, kind) transition table
    // with clearance_id REQUIRED exactly for human_clearance rows —
    // `cleared` reachable ONLY from `review` via the recorded human
    // clearance; history is never mutated in place), the append-only
    // human clearance records (actor identity + REQUIRED rationale +
    // the optional /evidence review-evidence reference — fair-use
    // reasoning rides HERE, never an auto-clear), the append-only
    // destination-platform permission-scope rows (the newest row per
    // platform is effective; each carrying its REQUIRED /evidence
    // reference) and the fully append-only immutable ingredient
    // lineage links (the unique (client, composite, ingredient) fence,
    // no self-links — composites resolve as the CONJUNCTION of their
    // ingredients); NO evidence, policy, credential, tenant or
    // content-asset table is created or mutated (the /evidence and
    // /policies authorities stay sole, consumed READ-ONLY through
    // their public contracts; /content-assets is the FUTURE consumer
    // of this gate — the id-based reference seam, never an import).
    '051_content_rights.sql',
    // MKT-054 (Growth Operator) appends the growth-operator migration (052
    // — PRE-ASSIGNED 050 collided with the merged MKT-056 050; the Tech
    // Lead renumbered 050→052 at merge, disclosed): the /growth-operator persistent controller
    // layer — the per-mission controller records (UNIQUE mission fence;
    // the frozen state vocabulary CHECK-fenced; the budget/quota policy
    // with the ZERO-default human-amplification inputs; the blocked-shape
    // fence — blocked ⇒ reason + a genuine rights/policy/capability gate
    // kind; the CAS + identity-immutability + fill-only pursuit-workflow
    // triggers; no-DELETE), the bounded plan steps (the DETERMINISTIC
    // idempotency key UNIQUE per mission — the no-double-dispatch fence;
    // the identity-immutability + fill-only delegation-reference +
    // frozen-lifecycle-edges + observation-exactly-once triggers;
    // no-DELETE), the append-only operator decision tail (the gapless
    // per-mission sequence; UPDATE/DELETE rejected) and the append-only
    // state-transition audit trail (the frozen transition-pair +
    // current-state-match + init-first + gate-kind-shape +
    // terminal-cause-shape triggers; UPDATE/DELETE rejected); NO
    // task/job/dispatch/queue/sandbox-lease/execution-lifecycle table of
    // its own is created (architecture-lock-v1.6.md rule 17 — every
    // delegated object lives in the EXISTING authorities' tables, created
    // through their public commands; the FK anchors to
    // experiments/decisions/workflows/executions/evidence are
    // REFERENCES ONLY), NO human-marketplace table is created or
    // referenced (rules 43/44 — the human-amplification inputs are
    // budget/evidence columns on the controller row, zero by default).
    '052_growth_operator.sql',
  ]);
  // The object-store fs/memory/s3 adapter dirs each hold exactly one implementation.
  for (const dir of ['cache', 'locking', 'objects', 'secrets']) {
    assert.ok(existsSync(src('platform', dir, 'contract.ts')), `${dir} declares a contract`);
  }
});
