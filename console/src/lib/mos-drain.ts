/**
 * Bounded on-demand queue drain (DEP-005) — the serverless twin of MOS's
 * `src/entrypoints/worker.ts --drain` mode, composed from the SAME worker
 * pieces (WorkerHost, platform handlers, the MKT-011 pooled runtime) but
 * bounded to a hard time budget so it can run inside a serverless function.
 *
 * Drain orchestration mirrors worker.ts: relay (submit recorded dispatches)
 * → drain the queue → recover (terminalize dead-job executions, re-arm
 * deferred-paused dispatches, release stale sandbox leases); repeat only
 * while a pass re-arms new work (max DRAIN_MAX_PASSES, and never past the
 * budget — a deadline timer calls the graceful host.stop()).
 */

import { getMosApp, type MosApp } from "./mos-runtime";

const DRAIN_MAX_PASSES = 10;

export interface DrainPassReport {
  readonly pass: number;
  readonly relayed: number;
  readonly rearmed: number;
  readonly failed: number;
  readonly leasesReleased: number;
  readonly elapsedMs: number;
}

export interface DrainReport {
  readonly ok: boolean;
  readonly startedAt: string;
  readonly elapsedMs: number;
  readonly budgetMs: number;
  readonly passes: ReadonlyArray<DrainPassReport>;
  readonly pendingAfter: boolean;
  readonly stoppedByDeadline: boolean;
  readonly runtime: {
    readonly bootedAtMs: number;
    readonly migrations: MosApp["migrations"];
    readonly bundlePath: string;
  };
}

/**
 * Runs one bounded drain against the per-instance MOS application. The
 * budget MUST stay comfortably below the serverless function limit (the
 * caller passes e.g. 45_000 for a 60s function).
 */
export async function drainQueue(budgetMs: number): Promise<DrainReport> {
  const app = await getMosApp();
  const { bundle, services, modules } = app;
  const logger = services.observability.loggerFactory.forModule("workers");
  const workerId =
    `drain-${process.pid}-${services.ids.newId().slice(0, 8)}`;

  // --- the exact worker.ts --drain composition ----------------------------
  const pooled = new bundle.PooledRuntimeService({
    db: services.db,
    clock: services.clock,
    ids: services.ids,
    queue: services.queue,
    executions: modules["executions"],
    logger: services.observability.loggerFactory.forModule("pooled.runtime"),
    metrics: services.observability.metrics,
  });
  const pooledHandler = bundle.createPooledRunHandler({
    executions: modules["executions"],
    store: new bundle.ExecutionDispatchesStore(services.db, services.ids),
    runners: bundle.buildPooledTaskRunners({
      objects: services.objects,
      clock: services.clock,
      http: services.httpCalls,
    }),
    logger: services.observability.loggerFactory.forModule("pooled.handler"),
  });
  const handlers = new Map(bundle.buildPlatformHandlers(services));
  handlers.set(bundle.POOLED_HANDLER_KIND, pooledHandler);

  const host = new bundle.WorkerHost(
    {
      claim: (workerIdArg, limit) => services.queue.claim(workerIdArg, limit),
      complete: (jobId, output, version) =>
        services.queue.complete(jobId, { output }, version),
      fail: (jobId, error, version, base) =>
        services.queue.fail(jobId, error, version, base),
      hasPending: () => services.queue.hasPending(),
      logger,
      metrics: services.observability.metrics,
      clock: services.clock,
    },
    handlers,
    {
      workerId,
      pollIntervalMs: services.config.workerPollIntervalMs,
      batchSize: services.config.workerBatchSize,
      retryBackoffBaseMs: services.config.jobRetryBackoffBaseMs,
      drain: true,
    },
  );

  // --- hard deadline: graceful stop, in-flight jobs still finish ----------
  const startedMs = Date.now();
  let stoppedByDeadline = false;
  const deadline = setTimeout(() => {
    stoppedByDeadline = true;
    host.stop();
  }, Math.max(1_000, budgetMs - 2_000));
  if (typeof deadline.unref === "function") deadline.unref();

  const passes: DrainPassReport[] = [];
  let pendingAfter = false;
  try {
    for (let pass = 1; pass <= DRAIN_MAX_PASSES; pass += 1) {
      const passStart = Date.now();
      const relayed = await pooled.relayOnce(services.config.workerBatchSize);
      await host.run();
      const outcome = await pooled.recoverOnce(services.config.workerBatchSize);
      const passReport: DrainPassReport = {
        pass,
        relayed,
        rearmed: outcome.rearmed,
        failed: outcome.failed,
        leasesReleased: outcome.leasesReleased,
        elapsedMs: Date.now() - passStart,
      };
      passes.push(passReport);
      // P0-SRC: fixed a latent type error (TS2783) the deployment workspace's
      // repo-wide tsc include masked — the spread already carries pass
      // (passReport.pass === pass), so the duplicate key was redundant.
      logger.info("pooled.drain.pass", undefined, { ...passReport });
      if (passReport.rearmed === 0) break;
      if (Date.now() - startedMs > budgetMs - 5_000) break;
    }
    pendingAfter = await services.queue.hasPending();
  } finally {
    clearTimeout(deadline);
    host.stop();
  }

  logger.info("pooled.drain.finished", undefined, {
    worker_id: workerId,
    passes: passes.length,
    pending_after: pendingAfter,
    elapsed_ms: Date.now() - startedMs,
  });

  return {
    ok: !pendingAfter,
    startedAt: new Date(startedMs).toISOString(),
    elapsedMs: Date.now() - startedMs,
    budgetMs,
    passes,
    pendingAfter,
    stoppedByDeadline,
    runtime: {
      bootedAtMs: app.bootedAtMs,
      migrations: app.migrations,
      bundlePath: app.bundlePath,
    },
  };
}
