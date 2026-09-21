# MOS Console Source Reconciliation

Status: RESOLVED — repository-owned source + Git deployment

## Current verified state

- canonical repository: payswapdotorg/MOS
- console source exists under console/
- browser E2E harness exists under tests/e2e/
- Vercel project: mos-product
- project id: prj_0OE49bIy6w1MAU1FWOHr6XeQ6xYq
- production alias: https://mos-product.vercel.app
- current production deployment: dpl_8vG4jZrXaRNnMyAhdLc8J4JQJLaB
- current production commit: 039743a6e31f792c44d0fc646d3dcb53843730b1
- current main: 1ef58f86afa0220a7fd546ad03c84bfb82e4656b
- production is five commits behind main
- current production state: READY
- MKT-064 main/preview deployment is READY, but it has not been promoted to production

## Remaining handoff gates

1. outcome-first mission console;
2. browser proof of Growth/Product/Commerce journeys;
3. async worker deployment;
4. provider/account/billing verification;
5. promotion of the accepted main SHA.

Historical runtime note:
an older deployment emitted a missing pg package error. The recent 24-hour production 5xx query returned no logs.
