# MOS Demo Seeding Contract — DEP-001

**Status:** Repository-owned seeding contract (docs only)  
**Related:** `ENVIRONMENT-VARIABLES.md` §4 (seed runner variables), `DEPLOYMENT-PIPELINE.md` §5 (drain pattern the production seed depends on)

This document defines what demo data exists, how it is created, where the seed sources live (CURRENT) and where they must live (TARGET), and the non-negotiable rule separating demo identities from real accounts.

## 1. Principles

1. **Real-API-only.** Every seeded datum is created through the running MOS instance's real HTTP API — never direct SQL, never invented endpoints. The only out-of-band piece is the platform admin identity, which is bootstrapped by MOS's own env contract (`MOS_BOOTSTRAP_PLATFORM_ADMIN_*`).
2. **Idempotent.** Check-then-create by stable names/emails/objectives/source refs; commands with §8 idempotency keys use stable keys and accept the 200 replay. Re-running makes no changes (proven repeatedly on both staging and production: a converged re-run reports `0 creation(s), 57 reused`).
3. **Demo data is presentation material, not authority.** It lives in one demo agency plus the platform catalog. Cross-tenant isolation treats it exactly like any tenant data (a rival owner gets 404/403 against the demo agency — verified in production).
4. **Real sign-ups get zero simulation.** See §6 — this rule is absolute.
5. **Demo state is self-healing.** Fixtures that a demo viewer can consume (e.g. an open human-work offer) are closed out honestly through the real contracts and re-projected on the next seed run, so the demo is always demonstrable in every end state.

## 2. Seed sources (CURRENT vs TARGET)

| Seed | Purpose | CURRENT location | TARGET location |
|---|---|---|---|
| Staging seed | demo agency on the DEP-002 staging runtime (`:3010`) | deployment workspace `mini-services/mos-api-service/seed.ts` | repository (path fixed when the staging runtime is brought repo-side by DEP-002) |
| Production seed | the same demo data on the deployed product | deployment workspace `scripts/seed-production.ts` | `console/scripts/seed-production.ts` after the P0 console recovery lands the console tree |

Both seeds are adapted from one lineage: the production seed is the staging seed ported to the deployed URL (every MOS path `/api/x` rewritten to `${BASE}/api/mos/x` through the same-origin bridge), plus production-specific waiting (§5).

**Runner contract (both seeds):**

- Requires `MOS_SEED_BASE_URL` (the running MOS API base — staging runtime URL or the deployed production URL); exits 2 if unset.
- Admin login from `MOS_SEED_ADMIN_EMAIL` / `MOS_SEED_ADMIN_PASSWORD` (default email `admin@mos.demo`; the password comes from the deployed env's bootstrap admin — never hardcoded).
- Service principal: `MOS_INTERNAL_API_TOKEN` of the target deployment where needed.
- Reads the first-party app manifests from MOS source (`src/modules/first-party-apps/public.ts`) — published through the real app contracts, not hand-inserted rows.

## 3. Demo personas

Agency: **Northwind Growth Partners** (the single demo agency). Clients: Helio Robotics (full chain — see §4) and Atlas Freight Systems (goal + metrics). The four first-party packs (`mos-analytics`, `mos-crm`, `mos-sheets`, `mos-portal`) are published, `MOS_CERTIFIED`, and installed in Helio's workspace with a full install/upgrade/rollback ledger.

| Identity | Email | Role in the demo | What their sign-in demonstrates |
|---|---|---|---|
| Casey Okafor | `casey@northwind.demo` | agency owner | rich owner view: 2 clients, 2 active goals, running workflows, attention queue, economics, installed apps |
| Jordan Meyer | `jordan@northwind.demo` | agency operations | the operating surface (strategy/workflows/deployments) |
| Sam Adeyemi | `sam@northwind.demo` | human field agent | the human-work queue: one live OPEN offer (30-day) with working Accept/Decline |
| Platform admin | `admin@mos.demo` | bootstrap platform administrator (env-provided, not seed-created) | platform administration (users, drain) |

Persona emails use the reserved `.demo` suffix; the console shows a presentation-only "Demo — pre-seeded data" badge for `.demo` sessions. **Initial demo passwords are defined inside the seed scripts** (they are deliberately weak demo values, set through the real credential contract); they are not repeated in repository documentation. The bootstrap admin password is env-only (`MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD`) and never in any repository file. Demo credentials grant zero privileges outside the demo agency; all permissions stay server-enforced.

## 4. What the staging seed builds (demo story)

The seed walks the real MOS operating chain end-to-end so every console surface has honest data behind it:

```
Client (Helio Robotics) → Goal → Strategy/Playbook → Workflow → Deployment
  → RUNNING workflow instance → real worker-executed run → Evidence → Outcome
  → Decisions → Learnings → Metrics (revenue with full assumption disclosure)
Client (Atlas Freight Systems) → Goal + Metrics
Platform catalog → 4 first-party packs published + MOS_CERTIFIED
Helio workspace → install@1.0.0 → upgrade@1.1.0 → rollback@1.0.0 ledger
Human work (Sam) → projected instance → offered job → 30-day OPEN offer (self-healing)
```

Idempotency details that matter to re-runs (hard-learned, all fixed in both seeds): the field-agent eligibility probe must carry the required availability window; the `/api/apps` publish check must compare `manifest.version`; client metric references must reuse existing metric identities; the open-offer fixture must detect consumption (accepted/declined through the UI), close out an accepted fixture honestly through the real outcome contract, and re-project a fresh offer.

## 5. Production-seed specifics

- Runs entirely through the deployed URL's same-origin bridge — every datum goes through the real deployed MOS API (no direct Neon writes, ever).
- Because production has no continuous worker (Hobby), the seed's terminal-state wait **kicks the admin-gated drain route** while waiting for queued executions to settle (`DEPLOYMENT-PIPELINE.md` §5).
- Idempotency was proven across repeated runs and every end state (consumed offers, completed chains), converging to `0 creation(s), 57 reused`.

## 6. The real sign-up rule (non-negotiable)

**Real sign-ups get zero simulation.** The sign-up route is a server-side orchestrator over MOS's own admin contracts: create user → set credential → create agency with auto owner membership — nothing else. Consequences that are contract, not accident:

- A new real account starts **genuinely empty**: no client, no goal, no demo datum; every surface renders honest empty states.
- Duplicate email answers an honest `409` — the orchestrator **never** resets the credential of an existing account.
- Admin credentials for the orchestration come from env (fallback chain in `ENVIRONMENT-VARIABLES.md` §5), are never sent to the browser and never logged; if unavailable, sign-up answers an honest 503 rather than degrading.
- Real-agency data and demo data are structurally separated: demo data exists only inside the Northwind demo agency + platform catalog; real agencies see none of it (cross-tenant 404/403, verified in production).

## 7. Operating the seeds

| Environment | Command shape (CURRENT, from the deployment workspace) | Notes |
|---|---|---|
| Staging | run `mini-services/mos-api-service/seed.ts` against the staging runtime | continuous worker settles queue work |
| Production | `MOS_SEED_BASE_URL=https://mos-product.vercel.app … scripts/seed-production.ts` | drain-kicked waits; re-runnable in every end state |

Safe by design: re-running a seed is a no-op once converged. A seed may **add** demo state only through real contracts; it may never mutate or delete real-account data.

## 8. Fact provenance

- Seed sources read directly: workspace `mini-services/mos-api-service/seed.ts` and `scripts/seed-production.ts` (headers, idempotency notes, persona definitions, env contract).
- Idempotency evidence: DEP-006/006b (staging) and DEP-007 (production) records — converged re-runs report `0 creation(s), 57 reused`.
- Real sign-up behavior: DEP-006/007 records + production verification (duplicate 409, empty real agency, no badge).
- Persona/agency structure: the seed constants (agency, clients, apps, objectives) and the production acceptance notes in the worklog.
