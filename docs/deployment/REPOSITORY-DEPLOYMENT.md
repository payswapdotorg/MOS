# Repository-Driven Production Deployment (DEP-003)
Task: DEP-003 — deployment plane, Worker C lane
Status: Wired and verified — 2026-09-18, ~19:20–19:26 UTC
Scope of this change: documentation only. No application code changes.
Provenance: all infrastructure operations and verification curls below wereexecuted by the Tech Lead on 2026-09-18 ~19:20–19:26 UTC; outputs are transcribedfrom that execution record.
1. What was wired

The Vercel project mos-product is now connected to the GitHub repositorypayswapdotorg/MOS, and production deployments are built from the repositoryrather than from local/CLI uploads.

Setting	Value
Vercel project	mos-product (prj_0OE49bIy6w1MAU1FWOHr6XeQ6xYq)
Team	team_4KOoA5CgtYaOF85yFXPeMXLt
Git link	github / payswapdotorg/MOS
Production branch	main
Root Directory	console
Install command	bun install
Build command	bun run build:bundle → next build (documented chain; console/vercel.json carries buildCommand)
Framework	nextjs

The whole repository is cloned on Vercel's build machine, so build:bundlereading ../src works with Root Directory console/.

2. Exact API calls made

All calls authenticated with Authorization: Bearer <vercel-token>; team scopevia ?teamId=team_4KOoA5CgtYaOF85yFXPeMXLt. (Exact request bodies retained inthe Tech Lead's execution log.)

Link the repositoryPOST /v9/projects/prj_0OE49bIy6w1MAU1FWOHr6XeQ6xYq/link?teamId=…body: { "gitSource": { "type": "github", "org": "payswapdotorg", "repo": "MOS" } }

Configure build settingsPATCH /v9/projects/prj_0OE49bIy6w1MAU1FWOHr6XeQ6xYq?teamId=…body keys: rootDirectory="console", installCommand="bun install",buildCommand (documented chain above), framework="nextjs"

Confirm — GET /v9/projects/prj_0OE49bIy6w1MAU1FWOHr6XeQ6xYq?teamId=…→ link.type=github, org/repo payswapdotorg/MOS, productionBranch=main,rootDirectory=console.

Trigger production deployment from the git sourcePOST /v13/deployments?teamId=…body: { "gitSource": { "type": "github", "repoId": 1363348192, "org": "payswapdotorg", "repo": "MOS", "ref": "main" }, "target": "production" }

Poll — GET /v13/deployments/dpl_4LeKE3vHwJeH8DUR1GL3MNddaWUb?teamId=…→ readyState transitions to READY.

3. Production deployment built from the repository
Deployment id: dpl_4LeKE3vHwJeH8DUR1GL3MNddaWUb
Source: API-triggered from the git source (payswapdotorg/MOS @ main,target production) — not from a local workspace.
Commit: 9e900de2c7a4d015fb9252ed8243d05652c7fc62 (repository main headat trigger time — the F-1 erratum commit)
State: INITIALIZING → READY (first poll, ~30 s)
Deployment URL: https://mos-product-f60upxbrr-ekonplacidegmailcoms-projects.vercel.app
Production alias: mos-product.vercel.app auto-attached to this READYproduction deployment.

Honesty note — build cache: the build completed quickly because console/was unchanged between the previous and this deployment (build cache hit). Thisdeployment proves the repo→Vercel wiring and a repo-sourced productionartifact, but did not exercise the full cold pipeline (see §6, gap 1).

4. Verification evidence

All checks executed live, 2026-09-18 ~19:25 UTC:

Check	Recorded result
GET https://mos-product.vercel.app/api/mos/platform/health	{"status":"ok","service":"marketingos-platform-api","env":"prod","time":"2026-09-18T19:25:24.950Z"}
GET https://mos-product.vercel.app/	HTTP 200, 20,624 bytes; contains the Demo accounts marker and Marketing Operating System
GET https://mos-product-f60upxbrr-ekonplacidegmailcoms-projects.vercel.app/	HTTP 200
GET <deployment-url>/api/mos/platform/health	status ok, env prod
5. Rollback safety

Known-good pre-change artifact: dpl_Ggjek4trEkcAMa9WN2AB2DVwBSAA(READY; CLI-sourced; the long-running production deployment immediately beforethis wiring).

Never roll back to pre-fix artifacts. Historical failure class:Cannot find package 'pg' imported from /var/task/mos-bundle/mos.mjs. Therepository build pins pg via console/src/lib/mos-pg-trace.ts; see also thepg rollback warning in console/README.md.

Procedure:

Promote the known-good deployment back to production: Vercel dashboard →project mos-product → Deployments → dpl_Ggjek4trEkcAMa9WN2AB2DVwBSAA →Promote to Production (Instant Rollback), or the equivalent promote API call.
Re-verify: curl https://mos-product.vercel.app/api/mos/platform/health →{"status":"ok","env":"prod"}.
Record the rollback (when, by whom, target artifact) in this document.
6. Current vs target gaps
#	Current	Target	Note
1	READY deployment reused build cache (console/ unchanged)	Full bun install + build:bundle + next build cold run from repo	Next content-changing deployment exercises the full pipeline — verify its build logs.
2	API-triggered production deploy from repo main proven	Push-to-main auto-deploy	Auto-deploy on push depends on the Vercel GitHub App installation/scope on payswapdotorg/MOS; confirm on the next push to main.
3	Git link + API trigger satisfies repository-driven deployment	—	GitHub Actions CI fallback was not required and was not added.
4	HTTP-level verification (health + login-screen markers)	Browser demo-login journey	No browser tool in the worker lane; Tech Lead to re-verify a demo-account login in a browser against mos-product.vercel.app.
5	16 MOS_* env vars untouched	n/a	Write-only by policy; never read or modified.