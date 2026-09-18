/**
 * Deterministic MOS serverless-bundle builder (P0-SRC / UI-001).
 *
 * Reproduces the exact DEP-005b production recipe from THIS repository's own
 * backend source — no local workspace, no external tree:
 *
 *   1. `bun build --target=node --external=pg mos-build/entry.ts
 *      --outfile mos-bundle/mos.mjs` — bundles the repository's frozen v1.5
 *      backend (../src) into a single serverless-loadable ESM module, with
 *      `pg` kept external so node-postgres resolves from node_modules exactly
 *      as in every MOS integration test (and exactly as the live production
 *      deployment does);
 *   2. syncs the repository's own SQL migrations (../src/platform/db/
 *      migrations) into `mos-bundle/migrations/` — MOS's migrate.ts resolves
 *      the directory relative to the bundle's import.meta.url, so it MUST sit
 *      next to mos.mjs (next.config.ts `outputFileTracingIncludes` ships it).
 *
 * `bun run build` always runs this FIRST (and vercel.json wires the same
 * command into the Vercel build), so `next build` always has a fresh,
 * repository-derived bundle. The generated artifacts are gitignored — see
 * mos-bundle/README.md for the reproducibility rationale.
 *
 * Requires Bun (>= 1.2) on PATH — the same toolchain that built the
 * production bundle (DEP-005b) and installs the console (bun.lock).
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, ".."); // console/
const repoSrc = join(root, "..", "src"); // the repository's own MOS backend

function fail(message) {
  console.error(`[build:bundle] ${message}`);
  process.exit(1);
}

// --- 1. bundle the repo backend ------------------------------------------------

const bundleDir = join(root, "mos-bundle");
const outfile = join(bundleDir, "mos.mjs");

const entry = join(here, "entry.ts");
for (const required of [entry, join(repoSrc, "composition-root.ts")]) {
  try {
    statSync(required);
  } catch {
    fail(`missing input: ${required} (the console must live inside the MOS repository so ../src is the frozen v1.5 backend)`);
  }
}

console.log("[build:bundle] bun build --target=node --external=pg mos-build/entry.ts -> mos-bundle/mos.mjs");
const built = spawnSync(
  "bun",
  ["build", entry, "--target=node", "--external=pg", "--outfile", outfile],
  { stdio: "inherit" },
);
if (built.error !== undefined) {
  fail(`could not run bun (${built.error.message}) — Bun >= 1.2 must be installed`);
}
if (built.status !== 0) {
  fail(`bun build exited ${built.status}`);
}

// --- 2. migrations next to the bundle ------------------------------------------

const migrationsSrc = join(repoSrc, "platform", "db", "migrations");
const migrationsOut = join(bundleDir, "migrations");
try {
  const sql = readdirSync(migrationsSrc).filter((name) => name.endsWith(".sql"));
  if (sql.length === 0) {
    fail(`no SQL migrations found in ${migrationsSrc}`);
  }
  mkdirSync(migrationsOut, { recursive: true });
  cpSync(migrationsSrc, migrationsOut, { recursive: true });
  console.log(`[build:bundle] synced ${sql.length} SQL migrations -> mos-bundle/migrations/`);
} catch (error) {
  fail(`migration sync failed: ${String(error)}`);
}

const bytes = statSync(outfile).size;
console.log(`[build:bundle] done: mos-bundle/mos.mjs (${(bytes / 1024 / 1024).toFixed(2)} MB) + migrations — ready for next build`);
