/**
 * MKT-033 integration test — DEPLOY-AC-01: "control plane and workers start
 * with explicit config — deployment integration test."
 *
 * Proves the FROZEN CAPABILITY TOPOLOGY actually starts, with real
 * infrastructure (embedded PostgreSQL as the authoritative data plane, real
 * OS subprocesses for the control plane and workers):
 *
 *   POSITIVE:
 *   1. the CONTROL PLANE (src/entrypoints/api.ts) boots from EXPLICIT
 *      configuration: the single auditable configuration surface
 *      ('config.effective' — the REDACTED effective-config report with NO
 *      secret material) is logged once at startup, migration state is
 *      verified at startup ('platform.migrations.verified', cross-checked
 *      against platform_schema_migrations in the authoritative store), and
 *      the liveness endpoint answers;
 *   2. the WORKER (src/entrypoints/worker.ts) boots from the SAME explicit
 *      config surface (same 'config.effective' record) and drains cleanly;
 *   3. the composed topology moves real work end-to-end: control plane
 *      submits → durable PostgreSQL queue → worker executes → object-store
 *      artifact (queue, data, workers, control plane all live);
 *   4. the sandbox capability and the AI Runtime capability answer through
 *      the control plane (Workspace-scoped sandbox surface; model registry);
 *   5. graceful shutdown ordering: SIGTERM drains in-flight work BEFORE the
 *      process exits (job.succeeded precedes worker.stopped; api.stopping
 *      precedes a clean exit 0).
 *
 *   NEGATIVE (explicit-config contract — no silent fallbacks, ever):
 *   6. a MISSING MOS_DATABASE_URL aborts startup loudly (structured
 *      *.startup.failed record, non-zero exit) — never a guessed default;
 *   7. INVALID explicit values (bad enum, bad integer) abort startup;
 *   8. HALF-CONFIGURED production adapters abort startup: S3 without its
 *      required settings; the AI provider without endpoint+key;
 *   9. an UNREACHABLE database aborts startup (no silent degraded boot).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  spawnEntrypointExpectFailure,
  spawnWorker,
  waitFor,
  type IntegrationStack,
  type SpawnedProcess,
} from './helpers/harness.ts';
import { findFreePort } from './helpers/pg.ts';

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';
const SERVICE_TOKEN = 'integration-test-token';

/**
 * The EXPLICIT deployment configuration for this stack: every capability is
 * pinned — env, object store (fs with a real dir), secret backend dir,
 * internal API token, bootstrap admin, worker/queue tuning, the AI Runtime
 * provider adapter (openrouter with an explicit endpoint + key) and NO
 * Redis at all (advisory layer absent — DEPLOY-AC-02's recovery posture).
 */
const EXPLICIT_ENV = {
  MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
  MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  MOS_AI_PROVIDER: 'openrouter',
  MOS_AI_OPENROUTER_ENDPOINT: 'http://127.0.0.1:9/v1',
  MOS_AI_OPENROUTER_API_KEY: 'explicit-test-openrouter-key',
  MOS_AI_OPENROUTER_TIMEOUT_MS: '1500',
  MOS_WORKER_ID: 'deploy-topology-worker',
  MOS_QUEUE_STALE_CLAIM_MS: '5000',
  // Explicitly NO Redis: an empty MOS_REDIS_URL selects the documented
  // degenerate advisory adapters (cache: no-op; locks: fail-closed).
  MOS_REDIS_URL: '',
} as const;

function the(): { stack: IntegrationStack; api: SpawnedProcess & { port: number } } {
  if (stack === null || api === null) throw new Error('test stack not booted');
  return { stack, api };
}

function findRecord(process: SpawnedProcess, event: string): Record<string, unknown> | undefined {
  return process
    .logRecords()
    .find((record) => record.event === event) as Record<string, unknown> | undefined;
}

before(async () => {
  stack = await bootStack('deploytop');
  api = await spawnApi(stack.env, { ...EXPLICIT_ENV });
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

// ---------------------------------------------------------------------------
// POSITIVE: the control plane starts with explicit config (AC-01)
// ---------------------------------------------------------------------------

test('AC-01: control plane starts from explicit config and logs the single auditable (redacted) config surface', async () => {
  const { api: theApi } = the();

  const started = findRecord(theApi, 'api.started');
  assert.ok(started !== undefined, 'api.started must be logged');
  const startedFields = (started['fields'] ?? {}) as Record<string, unknown>;
  assert.equal(startedFields['env'], 'test');
  assert.equal(startedFields['host'], '127.0.0.1');
  assert.ok(typeof startedFields['port'] === 'number' && (startedFields['port'] as number) > 0);

  // THE auditable configuration surface: one 'config.effective' record,
  // emitted by the shared bootstrap BEFORE any serving, carrying the
  // effective capability topology with secrets reduced to presence markers.
  const records = theApi.logRecords().filter((r) => r.event === 'config.effective');
  assert.equal(records.length, 1, 'exactly one config.effective record at startup');
  const report = (records[0]!['fields'] as Record<string, unknown>)['config'] as Record<string, unknown>;

  assert.equal(report['env'], 'test');
  assert.equal((report['database'] as Record<string, unknown>)['systemOfRecord'], 'postgresql');
  assert.equal((report['objectStore'] as Record<string, unknown>)['kind'], 'fs');
  assert.equal((report['redis'] as Record<string, unknown>)['configured'], false, 'no Redis backend is configured');
  assert.equal((report['queue'] as Record<string, unknown>)['authority'], 'postgresql');
  assert.equal((report['aiRuntime'] as Record<string, unknown>)['provider'], 'openrouter');
  assert.equal(
    (report['worker'] as Record<string, unknown>)['id'],
    'deploy-topology-worker',
    'explicit worker identity is on the shared surface (unused by the api process, still the one config)',
  );

  // REDACTION: secret material never appears — presence flags only.
  assert.equal((report['database'] as Record<string, unknown>)['connectionConfigured'], true);
  assert.equal((report['auth'] as Record<string, unknown>)['internalApiAuthConfigured'], true);
  assert.equal((report['auth'] as Record<string, unknown>)['bootstrapAdminConfigured'], true);
  assert.equal((report['aiRuntime'] as Record<string, unknown>)['providerKeyConfigured'], true);
  const serialized = JSON.stringify(report);
  for (const secret of [
    stack!.env.databaseUrl,
    SERVICE_TOKEN,
    BOOTSTRAP_PASSWORD,
    'explicit-test-openrouter-key',
  ]) {
    assert.ok(!serialized.includes(secret), `secret material must never appear in the config report: ${secret.slice(0, 12)}…`);
  }
});

test('AC-01: startup verifies the migration state against the authoritative store', async () => {
  const { api: theApi, stack: st } = the();

  const verified = findRecord(theApi, 'platform.migrations.verified');
  assert.ok(verified !== undefined, 'platform.migrations.verified must be logged at startup');
  const data = verified['fields'] as Record<string, unknown>;
  const appliedCount = data['applied_count'] as number;
  const latest = data['latest'] as string;
  assert.ok(appliedCount > 0, 'the frozen migration set is applied');
  assert.match(latest, /^\d{3}_/);

  // Cross-check against the AUTHORITATIVE record in PostgreSQL itself.
  const rows = await st.pg.pool.query<{ name: string }>(
    'SELECT name FROM platform_schema_migrations ORDER BY name',
  );
  assert.equal(
    rows.rows.length,
    appliedCount,
    'the startup-reported migration count matches the authoritative platform_schema_migrations table',
  );
  assert.equal(rows.rows[rows.rows.length - 1]?.name, latest, 'the latest applied migration matches');
});

test('AC-01: the control plane answers liveness once up', async () => {
  const { api: theApi } = the();
  const health = await apiCall(theApi.port, '/api/platform/health');
  assert.equal(health.status, 200);
  assert.equal(health.body['status'], 'ok');
  assert.equal(health.body['service'], 'marketingos-platform-api');
  assert.equal(health.body['env'], 'test');
});

// ---------------------------------------------------------------------------
// POSITIVE: workers start with the same explicit config (AC-01)
// ---------------------------------------------------------------------------

test('AC-01: the worker boots from the SAME explicit config surface and drains cleanly', async () => {
  const { stack: st } = the();

  const worker = await spawnWorker(st.env, { ...EXPLICIT_ENV });
  const exit = await worker.exitCode();
  assert.equal(exit, 0, 'drain-mode worker must exit 0');

  // The worker emits the SAME auditable config surface record...
  const configRecords = worker.logRecords().filter((r) => r.event === 'config.effective');
  assert.equal(configRecords.length, 1, 'exactly one config.effective record at worker startup');
  const report = (configRecords[0]!['fields'] as Record<string, unknown>)['config'] as Record<string, unknown>;
  assert.equal((report['aiRuntime'] as Record<string, unknown>)['provider'], 'openrouter');
  assert.equal((report['worker'] as Record<string, unknown>)['id'], 'deploy-topology-worker');
  assert.equal((report['queue'] as Record<string, unknown>)['staleClaimMs'], 5000);

  // ...the migration verification...
  const verified = worker
    .logRecords()
    .find((r) => r.event === 'platform.migrations.verified') as Record<string, unknown> | undefined;
  assert.ok(verified !== undefined, 'worker startup also verifies the migration state');
  assert.ok(((verified['fields'] as Record<string, unknown>)['applied_count'] as number) > 0);

  // ...and the worker lifecycle events.
  assert.ok(worker.logRecords().some((r) => r.event === 'worker.started'), 'worker.started logged');
  assert.ok(worker.logRecords().some((r) => r.event === 'worker.stopped'), 'worker.stopped logged');
});

// ---------------------------------------------------------------------------
// POSITIVE: the deployed topology moves real work end-to-end
// ---------------------------------------------------------------------------

test('AC-01: control plane + worker + queue + object store + data operate as one deployed topology', async () => {
  const { api: theApi, stack: st } = the();

  const submitted = await apiCall(theApi.port, '/api/platform/operations', {
    token: SERVICE_TOKEN,
    body: { handler: 'platform.sample.long-running-work', input: { durationMs: 120 }, idempotencyKey: 'deploy-topology-op-001' },
  });
  assert.equal(submitted.status, 202);
  const operationId = submitted.body['operationId'] as string;

  const worker = await spawnWorker(st.env, { ...EXPLICIT_ENV });
  assert.equal(await worker.exitCode(), 0);

  const final = await waitFor(
    `operation ${operationId} to succeed`,
    () => apiCall(theApi.port, `/api/platform/operations/${operationId}`, { token: SERVICE_TOKEN }),
    (r) => r.body['status'] === 'succeeded',
  );
  assert.equal(final.body['attempts'], 1);

  // The authoritative store carries the durable final state.
  const jobRow = await st.pg.pool.query<{ status: string; attempts: string; idempotency_key: string }>(
    'SELECT status, attempts::text, idempotency_key FROM platform_jobs WHERE job_id = $1',
    [operationId],
  );
  assert.equal(jobRow.rows[0]?.status, 'succeeded');
  assert.equal(jobRow.rows[0]?.idempotency_key, 'deploy-topology-op-001');

  // The result references a real artifact in the configured object store.
  const artifact = (final.body['result'] as Record<string, unknown>)['artifact'] as Record<string, unknown>;
  const key = artifact['key'] as string;
  assert.ok(fs.existsSync(path.join(st.env.objectStoreDir, key.slice(0, 2), key)), 'artifact written to the fs object store');
});

// ---------------------------------------------------------------------------
// POSITIVE: sandbox + AI Runtime capabilities answer through the control plane
// ---------------------------------------------------------------------------

test('AC-01: the sandbox service capability is up — the Workspace-scoped sandbox surface answers', async () => {
  const { api: theApi } = the();

  // Minimal governed tenant chain (agency → client → workspace) through the
  // control-plane routes, using the explicitly configured bootstrap admin.
  const login = await apiCall(theApi.port, '/api/auth/login', {
    body: { email: BOOTSTRAP_EMAIL, password: BOOTSTRAP_PASSWORD },
  });
  assert.equal(login.status, 200);
  const adminToken = login.body['token'] as string;

  const agency = await apiCall(theApi.port, '/api/agencies', {
    token: adminToken,
    body: { name: 'Deployment Topology Agency', ownerUserEmail: BOOTSTRAP_EMAIL },
  });
  assert.equal(agency.status, 201);
  const agencyId = (agency.body['agency'] as Record<string, unknown>)['agencyId'] as string;

  const client = await apiCall(theApi.port, `/api/agencies/${agencyId}/clients`, {
    token: adminToken,
    body: { name: 'Deployment Topology Client' },
  });
  assert.equal(client.status, 201);
  const clientId = client.body['clientId'] as string;

  const workspace = await apiCall(theApi.port, `/api/clients/${clientId}/workspaces`, {
    token: adminToken,
    body: { name: 'Deployment Topology Workspace' },
  });
  assert.equal(workspace.status, 201);
  const workspaceId = workspace.body['workspaceId'] as string;

  // The sandbox capability answers (Workspace-scoped surface, MKT-012).
  const sandboxes = await apiCall(theApi.port, `/api/workspaces/${workspaceId}/sandboxes`, {
    token: adminToken,
  });
  assert.equal(sandboxes.status, 200, JSON.stringify(sandboxes.body));
  assert.ok(Array.isArray(sandboxes.body['sandboxes']), 'the sandbox surface returns the Workspace-scoped list');
  assert.equal((sandboxes.body['sandboxes'] as unknown[]).length, 0);

  // The AI Runtime capability answers (the merged routing/registry surface,
  // MKT-017/MKT-018 — provider-neutral, no provider identity in the API).
  const models = await apiCall(theApi.port, '/api/ai/models', { token: SERVICE_TOKEN });
  assert.equal(models.status, 200, JSON.stringify(models.body));
  assert.ok(Array.isArray(models.body['models']), 'the AI Runtime model registry answers');
});

// ---------------------------------------------------------------------------
// POSITIVE: graceful shutdown ordering drains in-flight work first
// ---------------------------------------------------------------------------

test('AC-01: SIGTERM on the worker drains the in-flight job before exit (graceful shutdown ordering)', async () => {
  const { api: theApi, stack: st } = the();

  const submitted = await apiCall(theApi.port, '/api/platform/operations', {
    token: SERVICE_TOKEN,
    body: { handler: 'platform.sample.long-running-work', input: { durationMs: 2000 }, idempotencyKey: 'deploy-topology-drain-001' },
  });
  assert.equal(submitted.status, 202);
  const operationId = submitted.body['operationId'] as string;

  const worker = await spawnWorker(st.env, { ...EXPLICIT_ENV }, { drain: false });
  // Wait until the job is claimed and running in the authoritative store.
  await waitFor(
    `operation ${operationId} to be running`,
    () => st.pg.pool.query<{ status: string }>('SELECT status FROM platform_jobs WHERE job_id = $1', [operationId]),
    (r) => r.rows[0]?.status === 'running',
  );

  // Graceful stop: the worker must FINISH the in-flight job, then exit.
  worker.child.kill('SIGTERM');
  const exit = await worker.exitCode();
  assert.equal(exit, 0, 'graceful worker shutdown exits 0');

  const finalRow = await st.pg.pool.query<{ status: string; attempts: string }>(
    'SELECT status, attempts::text FROM platform_jobs WHERE job_id = $1',
    [operationId],
  );
  assert.equal(finalRow.rows[0]?.status, 'succeeded', 'the in-flight job was drained, not abandoned');

  // Ordering proof from the worker's own structured records: the job
  // succeeded BEFORE the host stopped claiming/executing.
  const events = worker.logRecords().map((r) => r.event);
  const succeededIndex = events.indexOf('job.succeeded');
  const stoppedIndex = events.indexOf('worker.stopped');
  assert.ok(succeededIndex !== -1, 'job.succeeded logged');
  assert.ok(stoppedIndex !== -1, 'worker.stopped logged');
  assert.ok(succeededIndex < stoppedIndex, 'in-flight work completes before the worker stops (drain ordering)');
});

test('AC-01: SIGTERM on the control plane stops cleanly (api.stopping → exit 0)', async () => {
  const { stack: st } = the();

  // This test consumes the shared api process — it must be the LAST
  // api-dependent test in the file.
  const graceful = await spawnApi(st.env, { ...EXPLICIT_ENV });
  graceful.child.kill('SIGTERM');
  const exit = await graceful.exitCode();
  assert.equal(exit, 0, 'graceful api shutdown exits 0');
  assert.ok(
    graceful.logRecords().some((r) => r.event === 'api.stopping'),
    'api.stopping logged before close',
  );
});

// ---------------------------------------------------------------------------
// NEGATIVE: the explicit-config contract — refuse to start, loudly
// ---------------------------------------------------------------------------

test('AC-01 negative: MISSING MOS_DATABASE_URL aborts control-plane startup (no guessed default)', async () => {
  const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-neg-secrets-'));
  try {
    const failure = await spawnEntrypointExpectFailure('api', {
      MOS_ENV: 'test',
      MOS_SECRETS_DIR: secretsDir,
      // MOS_DATABASE_URL deliberately absent — and NOT inherited.
    });
    assert.notEqual(failure.exitCode, 0, 'startup must fail');
    assert.ok(failure.stderr.includes('"api.startup.failed"'), `structured failure record on stderr: ${failure.stderr.slice(0, 400)}`);
    assert.ok(failure.stderr.includes('CONFIG_INVALID'));
    assert.ok(failure.stderr.includes('MOS_DATABASE_URL is required'));
    assert.ok(!failure.stdout.some((line) => line.includes('"api.started"')), 'the server must never report started');
  } finally {
    fs.rmSync(secretsDir, { recursive: true, force: true });
  }
});

test('AC-01 negative: MISSING MOS_DATABASE_URL aborts worker startup too', async () => {
  const failure = await spawnEntrypointExpectFailure('worker', {
    MOS_ENV: 'test',
    // No database URL: the worker has no system of record — refuse to start.
  });
  assert.notEqual(failure.exitCode, 0);
  assert.ok(failure.stderr.includes('"worker.startup.failed"'));
  assert.ok(failure.stderr.includes('CONFIG_INVALID'));
  assert.ok(failure.stderr.includes('MOS_DATABASE_URL is required'));
});

test('AC-01 negative: INVALID explicit values abort startup loudly (no silent fallback)', async () => {
  const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-neg-secrets-'));
  try {
    // Ambiguous enum value — must fail, not guess.
    const badEnv = await spawnEntrypointExpectFailure('api', {
      MOS_DATABASE_URL: 'postgres://127.0.0.1:5/nope',
      MOS_ENV: 'staging',
      MOS_SECRETS_DIR: secretsDir,
    });
    assert.notEqual(badEnv.exitCode, 0);
    assert.ok(badEnv.stderr.includes('CONFIG_INVALID'));
    assert.ok(badEnv.stderr.includes('MOS_ENV must be one of'));

    // Malformed integer — must fail, not default.
    const badInt = await spawnEntrypointExpectFailure('worker', {
      MOS_DATABASE_URL: 'postgres://127.0.0.1:5/nope',
      MOS_QUEUE_STALE_CLAIM_MS: 'soon',
      MOS_SECRETS_DIR: secretsDir,
    });
    assert.notEqual(badInt.exitCode, 0);
    assert.ok(badInt.stderr.includes('"worker.startup.failed"'));
    assert.ok(badInt.stderr.includes('MOS_QUEUE_STALE_CLAIM_MS must be an integer'));
  } finally {
    fs.rmSync(secretsDir, { recursive: true, force: true });
  }
});

test('AC-01 negative: HALF-CONFIGURED production adapters abort startup (complete-or-absent)', async () => {
  const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-neg-secrets-'));
  try {
    // S3 selected without its required settings.
    const badS3 = await spawnEntrypointExpectFailure('api', {
      MOS_DATABASE_URL: 'postgres://127.0.0.1:5/nope',
      MOS_ENV: 'test',
      MOS_OBJECT_STORE: 's3',
      MOS_SECRETS_DIR: secretsDir,
    });
    assert.notEqual(badS3.exitCode, 0);
    assert.ok(badS3.stderr.includes('MOS_OBJECT_STORE=s3 requires'));

    // AI provider selected without endpoint + key.
    const badAi = await spawnEntrypointExpectFailure('worker', {
      MOS_DATABASE_URL: 'postgres://127.0.0.1:5/nope',
      MOS_ENV: 'test',
      MOS_AI_PROVIDER: 'openrouter',
      MOS_SECRETS_DIR: secretsDir,
    });
    assert.notEqual(badAi.exitCode, 0);
    assert.ok(badAi.stderr.includes('"worker.startup.failed"'));
    assert.ok(badAi.stderr.includes('MOS_AI_PROVIDER=openrouter requires'));

    // AI provider with an endpoint that is not an http(s) URL.
    const badEndpoint = await spawnEntrypointExpectFailure('api', {
      MOS_DATABASE_URL: 'postgres://127.0.0.1:5/nope',
      MOS_ENV: 'test',
      MOS_AI_PROVIDER: 'openrouter',
      MOS_AI_OPENROUTER_ENDPOINT: 'ftp://not-http',
      MOS_AI_OPENROUTER_API_KEY: 'some-key',
      MOS_SECRETS_DIR: secretsDir,
    });
    assert.notEqual(badEndpoint.exitCode, 0);
    assert.ok(badEndpoint.stderr.includes('MOS_AI_OPENROUTER_ENDPOINT must be an http:// or https:// URL'));
  } finally {
    fs.rmSync(secretsDir, { recursive: true, force: true });
  }
});

test('AC-01 negative: an UNREACHABLE database aborts startup (no silent degraded boot)', async () => {
  const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-neg-secrets-'));
  const deadPort = await findFreePort(); // nothing listens here → refused
  try {
    const failure = await spawnEntrypointExpectFailure(
      'api',
      {
        MOS_DATABASE_URL: `postgres://127.0.0.1:${deadPort}/mos`,
        MOS_ENV: 'test',
        MOS_SECRETS_DIR: secretsDir,
      },
      90_000,
    );
    assert.notEqual(failure.exitCode, 0, 'startup must fail when the authoritative store is unreachable');
    assert.ok(failure.stderr.includes('"api.startup.failed"'), `structured failure record: ${failure.stderr.slice(0, 300)}`);
    assert.ok(!failure.stdout.some((line) => line.includes('"api.started"')), 'the server must never report started');
  } finally {
    fs.rmSync(secretsDir, { recursive: true, force: true });
  }
});
