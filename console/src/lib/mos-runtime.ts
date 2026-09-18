/**
 * In-process MOS runtime for serverless hosting (DEP-005).
 *
 * Production shape: the REAL MOS platform (this repository's own frozen v1.5
 * backend ../src, pre-bundled by `bun build` into `mos-bundle/mos.mjs` with
 * `pg` external — see mos-build/build-bundle.mjs) is booted ONCE per
 * serverless instance through MOS's own
 * composition root — `bootstrapApplication()` (explicit env config → wired
 * services + modules → MOS's own migrate.ts migrations → idempotent platform
 * admin bootstrap) — and every request is served through the SAME
 * `buildApiRouter(services, modules)` the standalone API entrypoint uses.
 *
 * The request adapter below mirrors src/platform/http/server.ts byte-for-byte
 * in behavior: correlation middleware, strict JSON body handling with the
 * configured size limit, typed error mapping, request/response structured
 * logging. NO authority logic lives here — this is transport only.
 *
 * The bundle is loaded from disk with a bundler-ignored dynamic import so
 * `import.meta.url` inside MOS's migrate.ts keeps pointing at the real file
 * and its `migrations/` directory ships next to it (see next.config.ts
 * `outputFileTracingIncludes`).
 */

import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// P0-SRC: pin the bundle's externalized `pg` dependency into the Next.js
// server trace (see ./mos-pg-trace.ts — prevents the §10 rollback outage).
import "./mos-pg-trace";

// --- MOS structural types (wire shapes of the bundle's exports) ------------

export interface MosRequestContext {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: unknown;
  readonly rawBody: Uint8Array | undefined;
}

export interface MosResponsePayload {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: unknown;
}

export interface MosLogger {
  debug(event: string, msg?: string, fields?: Record<string, unknown>): void;
  info(event: string, msg?: string, fields?: Record<string, unknown>): void;
  warn(event: string, msg?: string, fields?: Record<string, unknown>): void;
  error(event: string, msg?: string, fields?: Record<string, unknown>): void;
}

export interface MosQueue {
  claim(workerId: string, limit: number): Promise<ReadonlyArray<Record<string, unknown>>>;
  complete(jobId: string, output: Record<string, unknown>, version: number): Promise<Record<string, unknown>>;
  fail(
    jobId: string,
    error: Record<string, unknown>,
    version: number,
    retryBackoffBaseMs: number,
  ): Promise<Record<string, unknown>>;
  hasPending(): Promise<boolean>;
}

interface MosServices {
  readonly config: {
    httpMaxBodyBytes: number;
    workerPollIntervalMs: number;
    workerBatchSize: number;
    jobRetryBackoffBaseMs: number;
  };
  readonly clock: { nowMs(): number; nowIso(): string };
  readonly ids: { newId(): string };
  readonly db: unknown;
  readonly queue: MosQueue;
  readonly objects: unknown;
  readonly httpCalls: unknown;
  readonly observability: {
    loggerFactory: { forModule(name: string): MosLogger };
    metrics: {
      increment(name: string, labels?: Readonly<Record<string, string>>): void;
      observe(name: string, value: number, labels?: Readonly<Record<string, string>>): void;
      snapshot(): Readonly<Record<string, ReadonlyArray<{ labels: string; value: number }>>>;
    };
  };
}

interface MosAppError {
  readonly httpStatus: number;
  toJSON(): Record<string, unknown>;
}

/** The pre-built MOS bundle's module surface (all MOS's own exports). */
interface MosBundle {
  bootstrapApplication(): Promise<{ services: MosServices; modules: Record<string, unknown> }>;
  buildApiRouter(
    services: MosServices,
    modules: Record<string, unknown>,
  ): {
    resolve(
      method: string,
      path: string,
    ): {
      handler: (request: MosRequestContext, params: Record<string, string>) => Promise<MosResponsePayload>;
      params: Record<string, string>;
    };
  };
  withCorrelation<R>(context: unknown, fn: () => Promise<R>): Promise<R>;
  toAppError(error: unknown): MosAppError;
  isUuid(value: string): boolean;
  runMigrations(db: unknown): Promise<ReadonlyArray<{ name: string; checksum: string }>>;
  InvalidRequestError: new (message: string, details?: ReadonlyArray<string>, cause?: unknown) => MosAppError;
  RequestTooLargeError: new (maxBytes: number) => MosAppError;

  // --- worker drain pieces (src/entrypoints/worker.ts --drain wiring) ----
  WorkerHost: new (
    deps: {
      claim: (workerId: string, limit: number) => Promise<ReadonlyArray<Record<string, unknown>>>;
      complete: (jobId: string, output: Record<string, unknown>, version: number) => Promise<Record<string, unknown>>;
      fail: (
        jobId: string,
        error: Record<string, unknown>,
        version: number,
        retryBackoffBaseMs: number,
      ) => Promise<Record<string, unknown>>;
      hasPending: () => Promise<boolean>;
      logger: MosLogger;
      metrics: MosServices["observability"]["metrics"];
      clock: MosServices["clock"];
    },
    handlers: ReadonlyMap<string, (ctx: unknown) => Promise<Record<string, unknown>>>,
    options: {
      workerId: string;
      pollIntervalMs: number;
      batchSize: number;
      retryBackoffBaseMs: number;
      drain: boolean;
    },
  ) => { run(): Promise<void>; stop(): void };
  buildPlatformHandlers(
    services: MosServices,
  ): Iterable<readonly [string, (ctx: unknown) => Promise<Record<string, unknown>>]>;
  createPooledRunHandler(deps: {
    executions: unknown;
    store: unknown;
    runners: unknown;
    logger: MosLogger;
  }): (ctx: unknown) => Promise<Record<string, unknown>>;
  ExecutionDispatchesStore: new (db: unknown, ids: unknown) => unknown;
  PooledRuntimeService: new (deps: {
    db: unknown;
    clock: unknown;
    ids: unknown;
    queue: unknown;
    executions: unknown;
    logger: MosLogger;
    metrics: MosServices["observability"]["metrics"];
  }) => {
    relayOnce(limit: number): Promise<number>;
    recoverOnce(batchLimit?: number): Promise<{ failed: number; rearmed: number; leasesReleased: number }>;
    stop(): void;
  };
  readonly POOLED_HANDLER_KIND: string;
  buildPooledTaskRunners(deps: { objects: unknown; clock: unknown; http: unknown }): unknown;
}

export interface MosApp {
  readonly bundle: MosBundle;
  readonly services: MosServices;
  readonly modules: Record<string, unknown>;
  readonly router: ReturnType<MosBundle["buildApiRouter"]>;
  readonly bootedAtMs: number;
  readonly migrations: { appliedCount: number; latest: string | null };
  readonly bundlePath: string;
}

// --- bundle loading ---------------------------------------------------------

async function findBundlePath(): Promise<string> {
  const candidates = [
    process.env["MOS_BUNDLE_PATH"],
    join(process.cwd(), "mos-bundle", "mos.mjs"),
    join(process.cwd(), "..", "mos-bundle", "mos.mjs"),
    join(process.cwd(), "..", "..", "mos-bundle", "mos.mjs"),
  ].filter((value): value is string => typeof value === "string" && value !== "");
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try the next candidate location
    }
  }
  throw new Error(
    `MOS bundle not found (tried: ${candidates.join(", ")}). The deployment must ship mos-bundle/mos.mjs + mos-bundle/migrations/.`,
  );
}

async function loadBundle(): Promise<{ bundle: MosBundle; path: string }> {
  const bundlePath = await findBundlePath();
  const url = pathToFileURL(bundlePath).href;
  const bundle = (await import(
    /* webpackIgnore: true */ /* turbopackIgnore: true */ url
  )) as unknown as MosBundle;
  return { bundle, path: bundlePath };
}

// --- singleton boot ---------------------------------------------------------

let bootPromise: Promise<MosApp> | null = null;
let bootedApp: MosApp | null = null;

async function boot(): Promise<MosApp> {
  // The composition root fail-fasts when the secret backend directory is
  // absent; on serverless the documented location is /tmp (ephemeral).
  const secretsDir = process.env["MOS_SECRETS_DIR"] ?? "/tmp/mos-secrets";
  await mkdir(secretsDir, { recursive: true });

  const { bundle, path: bundlePath } = await loadBundle();
  const { services, modules } = await bundle.bootstrapApplication();

  // MOS's own migrate.ts, re-run once more post-boot to surface the applied
  // migration list for this deployment's evidence (idempotent + checksummed).
  const applied = await bundle.runMigrations(services.db);

  const router = bundle.buildApiRouter(services, modules);
  const app: MosApp = {
    bundle,
    services,
    modules,
    router,
    bootedAtMs: Date.now(),
    migrations: {
      appliedCount: applied.length,
      latest: applied.length === 0 ? null : applied[applied.length - 1]!.name,
    },
    bundlePath,
  };
  bootedApp = app;
  return app;
}

/** The successfully booted singleton, when a boot has completed (DEP-005b diagnostics). */
export function getBootedMosApp(): MosApp | null {
  return bootedApp;
}

/** Boots (or reuses) the per-instance MOS application singleton. */
export function getMosApp(): Promise<MosApp> {
  if (bootPromise === null) {
    bootPromise = boot().catch((error: unknown) => {
      bootPromise = null; // allow the next request to retry a failed cold boot
      throw error;
    });
  }
  return bootPromise;
}
