/**
 * pg trace pin (P0-SRC / UI-001) — a build-time dependency marker, not runtime
 * logic.
 *
 * `mos-bundle/mos.mjs` is built with `--external=pg`, so the serverless bundle
 * resolves `pg` from `node_modules` at runtime (the DEP-005b recipe). Next.js
 * file tracing cannot see into that prebuilt artifact, so without a static
 * reference the traced serverless function would ship WITHOUT `node_modules/pg`
 * and the bridge would fail with exactly the documented historical outage:
 *
 *   Cannot find package 'pg' imported from /var/task/mos-bundle/mos.mjs
 *
 * (README §10 / CONSOLE-SOURCE-RECONCILIATION "Known live runtime evidence").
 * This side-effect import keeps `pg` (and its full transitive closure, which
 * the tracer computes automatically) inside the traced files of every route
 * that loads MOS in-process — `outputFileTracingIncludes` covers the bundle
 * itself, this pin covers its external dependency.
 */
import "pg";
