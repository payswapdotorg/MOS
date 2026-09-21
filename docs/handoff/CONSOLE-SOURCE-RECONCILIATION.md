# MOS Console Source Reconciliation

Status: RESOLVED — repository-owned source + Git deployment

## Verified current state

- canonical repository: payswapdotorg/MOS
- console source exists under console/
- console package has deterministic build/lint/typecheck commands
- browser E2E harness exists under tests/e2e/
- Vercel project: mos-product
- Vercel project id: prj_0OE49bIy6w1MAU1FWOHr6XeQ6xYq
- inspected production deployment: dpl_BwaJi8ho6QDaVq1RUjghezULAXn8
- production alias: https://mos-product.vercel.app
- deployment source: Git
- deployment target: production
- inspected deployment status: READY
- 24-hour production 5xx query returned no logs

## Previous P0 resolution

The previous P0 required recovering console source from an external CLI deployment.

That condition is now resolved. The console source is in the repository and current production is Git-deployed from main.

## Remaining product-completeness gates

1. v1.6 mission UX implementation;
2. browser proof of major Growth/Product/Commerce journeys;
3. reproducible API/worker/console deployment;
4. verified managed-provider configuration;
5. async worker deployment and restart/recovery proof.

## Historical runtime note

An older deployment emitted:
Cannot find package pg imported from /var/task/mos-bundle/mos.mjs

The current console package declares pg, and the current 24-hour production 5xx query returned no matching errors. Keep the historical incident as rollback/debugging context.
