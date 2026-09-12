/**
 * MKT-033 integration test — DEPLOY-AC-02: "queue recovery does not require
 * Redis as authority — recovery test."
 *
 * Runs with REDIS ABSENT ENTIRELY (MOS_REDIS_URL='' — the documented
 * degenerate advisory adapters; no redis-server process exists anywhere in
 * this stack) and proves, against the real embedded PostgreSQL and real
 * worker OS subprocesses:
 *
 *   1. a CONTINUOUS worker is SIGKILLED mid-queue (one job claimed and
 *      mid-execution, one job still pending behind it);
 *   2. the crash leaves RECONCILABLE authoritative state: the in-flight job
 *      is durably 'running' with its claim and attempt recorded — never a
 *      fabricated success, never a silent loss (the v1.2/v1.3 runtime
 *      posture: UNKNOWN/crashed work stays unresolved, never guessed);
 *   3. WITHIN the stale-claim window a fresh worker does NOT blindly replay
 *      the dead claim (it processes the pending work and leaves the crashed
 *      job's state untouched — exactly reconcilable, never blindly replayed);
 *   4. AFTER the claim outlives the configured window, a fresh worker
 *      RECOVERS the job from the authoritative PostgreSQL store alone:
 *      reclaim → re-execute → complete, with at-least-once semantics
 *      (attempts 1 → 2) and NO lost or duplicated final state (exactly one
 *      job row, one terminal outcome, one result; the append-only attempt
 *      ledger records both the crash and the recovery);
 *   5. idempotent resubmission of the SAME key + payload converges on the
 *      SAME durable job — recovery fencing admits no duplicate final state.
 *
 * The queue's authority is the PostgreSQL-backed platform_jobs state at
 * every point in the test (all assertions read the authoritative rows
 * directly). Redis is never started, never configured and never consulted.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  spawnWorker,
  waitFor,
  type IntegrationStack,
  type SpawnedProcess,
} from './helpers/harness.ts';

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;

const SERVICE_TOKEN = 'integration-test-token';

/** NO Redis anywhere in this recovery test (DEPLOY-AC-02's whole point). */
const NO_REDIS_ENV = {
  MOS_REDIS_URL: '',
} as const;

/** Worker 1 (the crash victim): batch 1, a LIVE 60s stale-claim window. */
const VICTIM_ENV = {
  ...NO_REDIS_ENV,
  MOS_WORKER_ID: 'recovery-victim',
  MOS_WORKER_BATCH_SIZE: '1',
  MOS_QUEUE_STALE_CLAIM_MS: '60000',
} as const;

/** Worker 2 (still inside the live-claim window — must NOT replay). */
const WITHIN_WINDOW_ENV = {
  ...NO_REDIS_ENV,
  MOS_WORKER_ID: 'recovery-witness',
  MOS_QUEUE_STALE_CLAIM_MS: '60000',
} as const;

/** Worker 3 (recovery): a 1200ms stale-claim window — the dead claim is stale. */
const RECOVERY_ENV = {
  ...NO_REDIS_ENV,
  MOS_WORKER_ID: 'recovery-worker',
  MOS_QUEUE_STALE_CLAIM_MS: '1200',
} as const;

interface JobRow {
  job_id: string;
  status: string;
  attempts: string;
  claimed_by: string | null;
  idempotency_key: string | null;
  result: Record<string, unknown> | null;
}

function the(): { stack: IntegrationStack; api: SpawnedProcess & { port: number } } {
  if (stack === null || api === null) throw new Error('test stack not booted');
  return { stack, api };
}

async function jobRow(jobId: string): Promise<JobRow> {
  const { stack: st } = the();
  const result = await st.pg.pool.query<JobRow>(
    `SELECT job_id::text, status, attempts::text, claimed_by, idempotency_key, result
     FROM platform_jobs WHERE job_id = $1`,
    [jobId],
  );
  const row = result.rows[0];
  assert.ok(row !== undefined, `job ${jobId} must exist in the authoritative store`);
  return row;
}

async function attemptLedger(jobId: string): Promise<
  ReadonlyArray<{ attempt_no: string; worker_id: string; outcome: string | null; finished: boolean }>
> {
  const { stack: st } = the();
  const result = await st.pg.pool.query<{
    attempt_no: string;
    worker_id: string;
    outcome: string | null;
    finished_at: Date | null;
  }>(
    `SELECT attempt_no::text, worker_id, outcome, finished_at
     FROM platform_job_attempts WHERE job_id = $1 ORDER BY attempt_no`,
    [jobId],
  );
  return result.rows.map((r) => ({
    attempt_no: r.attempt_no,
    worker_id: r.worker_id,
    outcome: r.outcome,
    finished: r.finished_at !== null,
  }));
}

async function submitWork(idempotencyKey: string, durationMs: number): Promise<string> {
  const { api: theApi } = the();
  const submitted = await apiCall(theApi.port, '/api/platform/operations', {
    token: SERVICE_TOKEN,
    body: {
      handler: 'platform.sample.long-running-work',
      input: { durationMs },
      idempotencyKey,
    },
  });
  assert.equal(submitted.status, 202, JSON.stringify(submitted.body));
  return submitted.body['operationId'] as string;
}

before(async () => {
  stack = await bootStack('qrecover');
  api = await spawnApi(stack.env, { ...NO_REDIS_ENV });
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

test('AC-02: a mid-queue worker SIGKILL leaves reconcilable authoritative state (no fabricated success, no loss) — with NO Redis anywhere', async () => {
  const { stack: st } = the();

  // Every process in this stack runs with Redis absent (degenerate advisory
  // adapters); the control plane itself proves it on the shared surface.
  const configRecord = api!.logRecords().find((r) => r.event === 'config.effective') as
    | Record<string, unknown>
    | undefined;
  assert.ok(configRecord !== undefined);
  const report = (configRecord['fields'] as Record<string, unknown>)['config'] as Record<string, unknown>;
  assert.equal((report['redis'] as Record<string, unknown>)['configured'], false, 'no Redis backend is wired at all');

  // Two jobs: the first is claimed and executed (8s of real work); the
  // second stays PENDING behind it (batch size 1) — the queue is mid-flight.
  const killedJobId = await submitWork('recover-crash-001', 8000);
  const queuedJobId = await submitWork('recover-queue-001', 100);

  const victim = await spawnWorker(st.env, { ...VICTIM_ENV }, { drain: false });
  // Wait until the first job is claimed by the victim (authoritative state).
  await waitFor(
    `job ${killedJobId} to be claimed`,
    () => jobRow(killedJobId),
    (row) => row.status === 'running' && row.claimed_by === 'recovery-victim',
  );

  // SIGKILL mid-execution: no completion path, no cleanup, no Redis.
  victim.child.kill('SIGKILL');
  await victim.exitCode();

  // The crash leaves RECONCILABLE state in the authoritative store:
  const crashed = await jobRow(killedJobId);
  assert.equal(crashed.status, 'running', 'the in-flight job stays durably running — never fabricated success');
  assert.equal(crashed.claimed_by, 'recovery-victim', 'the dead worker holds a durable claim');
  assert.equal(crashed.attempts, '1');
  const ledger = await attemptLedger(killedJobId);
  assert.equal(ledger.length, 1, 'the attempt is durably recorded');
  assert.equal(ledger[0]?.outcome, 'running', 'the crash window is recorded as an unresolved attempt');
  assert.equal(ledger[0]?.finished, false, 'the attempt never recorded a finish — unresolved, awaiting reconciliation');

  const stillPending = await jobRow(queuedJobId);
  assert.equal(stillPending.status, 'pending', 'the queued job is untouched pending work');
});

test('AC-02: within the live-claim window a fresh worker does NOT blindly replay the crashed job (and the queue keeps working)', async () => {
  const { stack: st } = the();
  const killedJobId = await st.pg.pool.query<{ job_id: string }>(
    `SELECT job_id::text FROM platform_jobs WHERE idempotency_key = 'recover-crash-001'`,
  );
  const jobId = killedJobId.rows[0]!.job_id;

  // A fresh drain worker INSIDE the 60s claim window: it must complete the
  // pending work, refuse to touch the live (crashed) claim, and exit 0.
  const witness = await spawnWorker(st.env, { ...WITHIN_WINDOW_ENV });
  const exit = await witness.exitCode();
  assert.equal(exit, 0, 'the queue keeps working after the crash (pending job processed, clean drain exit)');

  // The queued job completed with its FIRST attempt (no crash involvement).
  const queued = await jobRow(
    (await st.pg.pool.query<{ job_id: string }>(
      `SELECT job_id::text FROM platform_jobs WHERE idempotency_key = 'recover-queue-001'`,
    )).rows[0]!.job_id,
  );
  assert.equal(queued.status, 'succeeded');
  assert.equal(queued.attempts, '1', 'the pending work needed no recovery at all');

  // The crashed job was NOT blindly replayed within the window: identical
  // authoritative state, still owned by the dead worker, still unresolved.
  const crashed = await jobRow(jobId);
  assert.equal(crashed.status, 'running', 'no blind replay: the crashed claim is left reconcilable');
  assert.equal(crashed.claimed_by, 'recovery-victim');
  assert.equal(crashed.attempts, '1');
  const ledger = await attemptLedger(jobId);
  assert.equal(ledger.length, 1, 'no second attempt was manufactured inside the window');
});

test('AC-02: after the claim outlives the window, recovery from PostgreSQL alone completes the job at-least-once with no duplicated final state', async () => {
  const { stack: st, api: theApi } = the();
  const killedJobId = (
    await st.pg.pool.query<{ job_id: string }>(
      `SELECT job_id::text FROM platform_jobs WHERE idempotency_key = 'recover-crash-001'`,
    )
  ).rows[0]!.job_id;

  // Deterministic staleness (no timing race): wait until the AUTHORITATIVE
  // store itself shows the dead claim aged well past the 1200ms recovery
  // window BEFORE the recovery worker is spawned.
  await waitFor(
    'the dead claim to age past the recovery window',
    async () => {
      const result = await st.pg.pool.query<{ age_ms: string }>(
        `SELECT (EXTRACT(EPOCH FROM (now() - claimed_at)) * 1000)::text AS age_ms
         FROM platform_jobs WHERE job_id = $1`,
        [killedJobId],
      );
      return Number(result.rows[0]?.age_ms ?? 0);
    },
    (ageMs) => ageMs > 3_000,
    30_000,
    100,
  );

  // A fresh worker with that explicit window RECOVERS the job from the
  // authoritative store alone (no Redis anywhere in the process).
  const recovered = await spawnWorker(st.env, { ...RECOVERY_ENV });
  const exit = await recovered.exitCode();
  assert.equal(exit, 0, 'the recovery worker drains to a clean exit');

  // The recovery worker's own config surface proves the no-Redis posture.
  const configRecord = recovered
    .logRecords()
    .find((r) => r.event === 'config.effective') as Record<string, unknown> | undefined;
  assert.ok(configRecord !== undefined);
  const report = (configRecord['fields'] as Record<string, unknown>)['config'] as Record<string, unknown>;
  assert.equal((report['redis'] as Record<string, unknown>)['configured'], false);
  assert.equal((report['queue'] as Record<string, unknown>)['staleClaimMs'], 1200, 'the reclaim window is explicit config');

  // AT-LEAST-ONCE: the job re-executed (attempt 1 crashed → attempt 2
  // completed) and reached exactly ONE terminal final state.
  const final = await jobRow(killedJobId);
  assert.equal(final.status, 'succeeded', 'recovered to a single terminal outcome');
  assert.equal(final.attempts, '2', 'the work executed at least twice — the crash attempt plus the recovery attempt');
  assert.ok(final.result !== null, 'the final result is durably recorded');

  // The append-only attempt ledger records BOTH the crash window and the
  // recovery — history is never erased or rewritten:
  const ledger = await attemptLedger(killedJobId);
  assert.deepEqual(
    ledger.map((row) => [row.attempt_no, row.worker_id, row.outcome, row.finished]),
    [
      ['1', 'recovery-victim', 'running', false], // the durable crash record
      ['2', 'recovery-worker', 'succeeded', true], // the recovery execution
    ],
    'one crash record + one completed recovery execution, append-only',
  );

  // NO DUPLICATED final state: exactly one job row per idempotency key,
  // each terminal exactly once.
  const rows = await st.pg.pool.query<{ idempotency_key: string; status: string; n: string }>(
    `SELECT idempotency_key, status, count(*)::text AS n
     FROM platform_jobs WHERE idempotency_key LIKE 'recover-%'
     GROUP BY idempotency_key, status ORDER BY idempotency_key`,
  );
  assert.deepEqual(
    rows.rows.map((r) => [r.idempotency_key, r.status, r.n]),
    [
      ['recover-crash-001', 'succeeded', '1'],
      ['recover-queue-001', 'succeeded', '1'],
    ],
    'one authoritative row per logical job, each with exactly one final state',
  );

  // The resubmission fence: the SAME key + payload converges on the SAME
  // durable job — recovery can never manufacture a duplicate final state.
  const replay = await apiCall(theApi.port, '/api/platform/operations', {
    token: SERVICE_TOKEN,
    body: {
      handler: 'platform.sample.long-running-work',
      input: { durationMs: 8000 },
      idempotencyKey: 'recover-crash-001',
    },
  });
  assert.equal(replay.status, 202);
  assert.equal(replay.body['idempotentReplay'], true, 'the fence converges the resubmission');
  assert.equal(replay.body['operationId'], killedJobId, 'the SAME durable job identity');

  const afterReplay = await jobRow(killedJobId);
  assert.equal(afterReplay.status, 'succeeded');
  assert.equal(afterReplay.attempts, '2', 'the converged replay adds NO new execution');
});
