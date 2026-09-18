# mos-bundle/ — generated output (never committed)

Everything in this directory is **generated** by the deterministic prebuild:

```
bun run build:bundle        # = bun mos-build/build-bundle.mjs
```

1. `mos.mjs` — the REAL MOS platform backend (this repository's own frozen
   v1.5 `../src` tree) bundled into a single serverless-loadable ESM module
   with the exact DEP-005b production recipe:
   `bun build --target=node --external=pg mos-build/entry.ts`. `pg` stays
   external and resolves from `node_modules` at runtime — the historical
   `Cannot find package 'pg'` outage (docs/handoff/CONSOLE-SOURCE-
   RECONCILIATION.md §Known live runtime evidence) came from a deployment
   that lost that resolution; `pg` therefore remains a console dependency.
2. `migrations/*.sql` — the repository's own SQL migrations copied from
   `../src/platform/db/migrations/`. MOS's `migrate.ts` resolves the directory
   relative to the bundle's `import.meta.url`, so it MUST sit next to
   `mos.mjs`; `next.config.ts` `outputFileTracingIncludes` ships both with
   every route that boots MOS in-process.

`bun run build` (and the Vercel build, via `vercel.json` `buildCommand`)
always runs the prebuild before `next build`, so a fresh checkout never needs
a committed binary artifact — the checked-in bundle of the previous
deployment-era workspace was dropped on purpose (P0-SRC decision:
**prebuild, not fallback artifact**). Never hand-edit anything here; rerun
the build script instead.
