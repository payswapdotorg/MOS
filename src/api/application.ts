/**
 * Application-level module wiring contract (MKT-002, MKT-003, MKT-004,
 * MKT-005, MKT-006, MKT-007, MKT-008, MKT-009, MKT-010, MKT-013, MKT-014).
 *
 * src/api route builders receive the domain modules through this interface —
 * the concrete instances are created ONLY in the composition root (which is
 * not importable from src/api by the static architecture checker). Types come
 * from the frozen module public entries.
 *
 * MKT-005 additions: /credentials (credential references, CRED-001) and
 * /audit (append-only audit trail, AUD-001).
 *
 * MKT-006 additions: /goals (Goal lifecycle, GOAL-001).
 *
 * MKT-007 additions: /playbooks (Playbook versions, PLAY-001).
 *
 * MKT-008 additions: /workflows (Workflow definition graph model, WF-001).
 *
 * MKT-009 additions: /workflows (Workflow instance state machine,
 * implementation-contract §5).
 *
 * MKT-010 additions: /executions (normalized Execution model, EXEC-001).
 *
 * MKT-013 additions: /evidence (Evidence/provenance, EVID-001) — the
 * append-only, server-owned evidence ledger with provenance, quality and
 * the supersession graph.
 *
 * MKT-014 additions: /metrics (Metric normalization, METRIC-001) — the
 * append-only metric observation ledger with source/timestamp/reference
 * mapping, server-derived provenance and NO provider state.
 */

import type { AgenciesModuleApi } from '../modules/agencies/public.ts';
import type { AuditModuleApi } from '../modules/audit/public.ts';
import type { AuthModuleApi } from '../modules/auth/public.ts';
import type { ClientsModuleApi } from '../modules/clients/public.ts';
import type { CredentialsModuleApi } from '../modules/credentials/public.ts';
// MKT-013: /evidence module contract.
import type { EvidenceModuleApi } from '../modules/evidence/public.ts';
import type { ExecutionsModuleApi } from '../modules/executions/public.ts';
import type { GoalsModuleApi } from '../modules/goals/public.ts';
// MKT-014: /metrics module contract.
import type { MetricsModuleApi } from '../modules/metrics/public.ts';
import type { PlaybooksModuleApi } from '../modules/playbooks/public.ts';
import type { UsersModuleApi } from '../modules/users/public.ts';
import type { WorkflowsModuleApi } from '../modules/workflows/public.ts';
import type { WorkspacesModuleApi } from '../modules/workspaces/public.ts';

export interface ApplicationModules {
  readonly users: UsersModuleApi;
  readonly auth: AuthModuleApi;
  readonly agencies: AgenciesModuleApi;
  readonly clients: ClientsModuleApi;
  readonly workspaces: WorkspacesModuleApi;
  readonly credentials: CredentialsModuleApi;
  readonly audit: AuditModuleApi;
  readonly goals: GoalsModuleApi;
  readonly playbooks: PlaybooksModuleApi;
  readonly workflows: WorkflowsModuleApi;
  readonly executions: ExecutionsModuleApi;
  // MKT-013: evidence/provenance authority (EVID-001).
  readonly evidence: EvidenceModuleApi;
  // MKT-014: metric normalization authority (METRIC-001).
  readonly metrics: MetricsModuleApi;
}
