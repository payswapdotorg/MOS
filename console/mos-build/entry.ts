/**
 * DEP-005 build entry (NOT part of MOS — deployment-phase wiring only).
 *
 * Bundles the REAL MOS platform from THIS REPOSITORY's own backend source
 * (the frozen v1.5 tree under `<repo>/src/`, git-tracked and identical to the
 * pristine 2e071d0 source that built the live production deployment) into a
 * single serverless-loadable ESM module (`mos-bundle/mos.mjs`) with
 * `bun build --target=node --external=pg` — the exact DEP-005b recipe.
 *
 * Run it through the documented script: `bun run build:bundle`
 * (mos-build/build-bundle.mjs), which also syncs the repo's own SQL
 * migrations into `mos-bundle/migrations/` next to the bundle.
 *
 * Everything exported here is MOS's own code, re-exported verbatim:
 *   - bootstrapApplication / loadConfig — the composition root (runs MOS's
 *     own migrate.ts migrations on boot);
 *   - buildApiRouter — the full ~49-family API surface over services+modules;
 *   - runMigrations — MOS's migration runner (idempotent re-verify);
 *   - withCorrelation / toAppError / isUuid — the §23 request-shaping pieces
 *     the HTTP server uses (reused by the in-process adapter);
 *   - the worker drain wiring pieces (WorkerHost, platform handlers, the
 *     MKT-011 pooled runtime) — exactly what src/entrypoints/worker.ts
 *     composes for its --drain mode.
 *
 * The bundle keeps `pg` external (resolved from node_modules at runtime) so
 * node-postgres behaves exactly as in every MOS integration test.
 */

export { bootstrapApplication, loadConfig } from '../../src/composition-root.ts';
export { buildApiRouter } from '../../src/api/routes.ts';
export { runMigrations } from '../../src/platform/db/migrate.ts';
export { toAppError, InvalidRequestError, RequestTooLargeError } from '../../src/platform/errors/errors.ts';
export { withCorrelation } from '../../src/platform/observability/correlation.ts';
export { isUuid } from '../../src/platform/ids/ids.ts';

export { WorkerHost } from '../../src/workers/worker-host.ts';
export { buildPlatformHandlers } from '../../src/workers/handlers.ts';
export { createPooledRunHandler } from '../../src/workers/pooled/pooled-handler.ts';
export { ExecutionDispatchesStore } from '../../src/workers/pooled/execution-dispatches-store.ts';
export { PooledRuntimeService } from '../../src/workers/pooled/pooled-runtime.ts';
export { POOLED_HANDLER_KIND, buildPooledTaskRunners } from '../../src/workers/pooled/contract.ts';
