// CLEAN POSITIVE: the composition root is the only src/ place allowed to
// import concrete adapters. Platform-area adapters (pg) AND module-internal
// adapters (the /integrations first-party connector home) are both wired
// here — the frozen module-dependency-matrix.md "Composition root"
// provision: "external integration adapters are wired at the composition
// root". No violation may be reported for this file.
import { PgDb } from './platform/db/adapters/postgres/pg-db.ts';
import { FixtureMetaAdapter } from './modules/integrations/internal/adapters/meta/meta-adapter.ts';

export async function buildAppServices(): Promise<void> {
  void PgDb;
  void FixtureMetaAdapter;
}
