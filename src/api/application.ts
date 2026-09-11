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
 *
 * MKT-017 additions: /ai-runtime (AI task profile and model registry,
 * AI-001 — provider-neutral TaskProfiles, normalized model registry,
 * usage telemetry records).

 * MKT-025 additions: /field-agents (generic Human Agent profile authority,
 * FIELD-001 + HUMAN-001 — the generalized /field-agents authority of
 * spec/module-dependency-v1.3.md; no second human-execution module).

 * MKT-026 additions: /jobs (Human Job lifecycle authority, JOB-001 —
 * governed Task projections, candidate-specific Offers, the
 * concurrency-safe acceptance claim and provenance-preserving outcome
 * submission; Workflow authority preserved: the jobs module consumes
 * /workflows READ-ONLY).
 *
 * MKT-020 additions: /agents (logical Agent/Capability contracts,
 * AGENT-001 — provider-neutral reusable capability declarations with
 * platform/agency scope, register/list/read/retire and the append-only
 * lifecycle history).
 *
 * MKT-021 additions: /policies (execution policy engine, POL-001 —
 * append-oriented policy versions with platform/agency/client scope,
 * the fail-closed decision engine and the append-only decision ledger
 * with server-derived provenance; CRED-001 reference-only evaluation
 * posture).
 *
 * MKT-022 additions: /extensions (extension registry and manifest
 * contract, EXT-001 — the immutable versioned manifest registry, the
 * install/configure lifecycle with least-privilege granted scopes and
 * credential-reference secret bindings, the fail-closed invocation
 * policy gate and the short-lived invocation context with the
 * append-only invocation ledger).
 *
 * MKT-027 additions: /jobs field execution (JOB-001 field subset +
 * EVID-001 field subset, JOB-AC-03..04, EVID-AC-01..03 field subset —
 * the visit lifecycle, structured outcomes, evidence capture, follow-up
 * and the policy-gated continuity lookup ride the SAME /jobs module
 * contract: the JobsModuleApi interface is extended in place; NO new
 * module, NO new dependency). */


import type { AgenciesModuleApi } from '../modules/agencies/public.ts';
// MKT-020: /agents module contract (logical Agent/Capability contracts).
import type { AgentsModuleApi } from '../modules/agents/public.ts';
import type { AiRuntimeModuleApi } from '../modules/ai-runtime/public.ts';
import type { AuditModuleApi } from '../modules/audit/public.ts';
import type { AuthModuleApi } from '../modules/auth/public.ts';
import type { ClientsModuleApi } from '../modules/clients/public.ts';
import type { CredentialsModuleApi } from '../modules/credentials/public.ts';
// MKT-013: /evidence module contract.
import type { EvidenceModuleApi } from '../modules/evidence/public.ts';
import type { ExecutionsModuleApi } from '../modules/executions/public.ts';
import type { FieldAgentsModuleApi } from '../modules/field-agents/public.ts';
// MKT-026: /jobs module contract.
import type { JobsModuleApi } from '../modules/jobs/public.ts';
import type { GoalsModuleApi } from '../modules/goals/public.ts';
// MKT-014: /metrics module contract.
import type { MetricsModuleApi } from '../modules/metrics/public.ts';
import type { PlaybooksModuleApi } from '../modules/playbooks/public.ts';
// MKT-021: /policies module contract (execution policy engine).
import type { PoliciesModuleApi } from '../modules/policies/public.ts';
// MKT-022: /extensions module contract (extension registry and manifest
// contract).
import type { ExtensionsModuleApi } from '../modules/extensions/public.ts';
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
  // MKT-017: AI runtime registry authority (AI-001).
  readonly aiRuntime: AiRuntimeModuleApi;

  // MKT-025: the generic Human Agent profile authority (platform identity,
  // specializations as capability metadata, eligibility data).
  readonly fieldAgents: FieldAgentsModuleApi;

  // MKT-026: the Human Job lifecycle authority (Task projections,
  // candidate-specific offers, concurrency-safe acceptance, outcome
  // submission with server-derived provenance).
  // MKT-027: the SAME /jobs authority now also exposes the field-execution
  // surface (visits, structured outcomes, evidence capture, follow-up,
  // continuity) through this same contract — one authority, one type.
  readonly jobs: JobsModuleApi;

  // MKT-020: logical Agent/Capability contracts authority (AGENT-001).
  readonly agents: AgentsModuleApi;

  // MKT-021: execution policy engine authority (POL-001 — the declared
  // policy boundaries, the fail-closed decision engine and the
  // append-only decision records).
  readonly policies: PoliciesModuleApi;

  // MKT-022: extension registry and manifest contract authority
  // (EXT-001 — the immutable versioned manifest registry, the
  // install/configure lifecycle, the short-lived invocation context
  // and the append-only invocation ledger).
  readonly extensions: ExtensionsModuleApi;
}
