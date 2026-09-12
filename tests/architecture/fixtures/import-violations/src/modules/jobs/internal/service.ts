// PLANTED VIOLATIONS: FORBIDDEN_MODULE_DEPENDENCY + CONCRETE_ADAPTER_ACCESS
// + CROSS_MODULE_INTERNAL_ACCESS. /jobs may depend only on /workflows,
// /executions, /field-agents, /clients, /evidence, /policies
// (spec/module-dependency-matrix.md) — /goals is not allowed; and the
// /integrations module-internal ADAPTER is importable by NO module (only
// the composition root wires adapters).
import { goalsModule } from '../../goals/public.ts';
import { FixtureMetaAdapter } from '../../integrations/internal/adapters/meta/meta-adapter.ts';

export const jobsUses = { goalsModule, FixtureMetaAdapter };
