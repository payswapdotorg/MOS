# MOS Console Source Reconciliation

**Status:** P0 HANDOFF GATE

## Verified state

- Canonical repository: `payswapdotorg/MOS`
- Canonical backend/main head at reconciliation: `2e071d0c313b5dc9fa634fc90ade894bcd2754f0`
- Vercel project: `mos-product`
- Vercel project id: `prj_0OE49bIy6w1MAU1FWOHr6XeQ6xYq`
- Latest inspected production deployment: `dpl_Ggjek4trEkcAMa9WN2AB2DVwBSAA`
- Latest inspected deployment URL: `https://mos-product-pdyball8l-ekonplacidegmailcoms-projects.vercel.app`
- Production aliases include: `https://mos-product.vercel.app`
- Vercel reports the deployment as READY and the project framework as Next.js.
- The deployment source is reported as `cli`, not a Git repository connection.
- GitHub code search/repository inspection found no MOS console frontend source in `payswapdotorg/MOS`.
- Therefore the compiled production console is **not** currently the repository source of truth.

## Required resolution

The next implementation owner must recover the original console source from the source workspace that produced the CLI deployment, then commit that source into MOS.

Do **not** reverse-engineer minified `/_next/static` bundles and declare them source. Compiled assets are runtime evidence only.

## Source acceptance gate

The source reconciliation is complete only when all of the following are true:

1. Frontend source exists under a documented repository path.
2. The frontend package has deterministic install/build/test commands.
3. API base URL, authentication contract and required environment variables are documented.
4. The console builds from a clean checkout.
5. A preview deployment can be produced from the repository.
6. The deployed UI reproduces the known live authentication/demo entrypoint.
7. Browser journey tests can import the frontend from the repository rather than an external local workspace.
8. Vercel production is connected to the repository path or an explicitly documented CI deployment from repository main.
9. No runtime or product behavior depends on undocumented local files.

## Known live runtime evidence

The current live deployment was fetched successfully with HTTP 200.

A historical runtime error was observed on an older deployment before the latest inspected production release:

`Cannot find package 'pg' imported from /var/task/mos-bundle/mos.mjs`.

No runtime errors were found in the inspected period beginning 2026-09-14T21:00:00Z through the current verification time. The historical error must remain documented because a future rollback could reintroduce it.
