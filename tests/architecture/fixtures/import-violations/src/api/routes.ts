// PLANTED VIOLATIONS: CONCRETE_ADAPTER_ACCESS + CROSS_MODULE_INTERNAL_ACCESS
// (a module-internal integration adapter imported OUTSIDE the composition
// root — module internals are never importable from the api layer),
// CONCRETE_ADAPTER_ACCESS (platform adapter import outside the composition
// root), IMPORTS_ENTRYPOINT (importing a process entrypoint) and
// UNRESOLVED_IMPORT (import target does not exist).
import { PgQueue } from '../platform/queue/adapters/postgres/pg-queue.ts';
import { FixtureMetaAdapter } from '../modules/integrations/internal/adapters/meta/meta-adapter.ts';
import { apiMain } from '../entrypoints/api.ts';
import { missing } from './does-not-exist.ts';

export function registerRoutes(): unknown {
  return { PgQueue, FixtureMetaAdapter, apiMain, missing };
}
