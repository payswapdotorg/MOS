/**
 * MarketingOS module: /lab-agent-body
 * Authority: Agent Body Runtime Contract (LAB-011 — spec/
 * effective-backlog-v1.7.md LAB-011: "Implement model-agnostic Agent
 * Body execution with tools, memory, permissions, budgets and
 * evaluation hooks. Acceptance: at least two interchangeable model
 * backends through the existing AI runtime; no second model router.";
 * dependencies satisfied: LAB-001 (merged — the /lab contracts) and the
 * existing /ai-runtime (merged — the model authority); spec/
 * architecture-v1.7-marketing-lab.md §14 "Agent Body" VERBATIM: "An
 * Agent Body is MOS-owned executable structure that can be inhabited
 * by any compatible model supplied through the existing AI runtime. It
 * defines: role contract; input/output contract; tools; permissions;
 * memory interfaces; communication interface; action interface;
 * capabilities; budget; latency limits; evaluation hooks; safety/policy
 * constraints. Conceptually: Agent Body + selected LLM/model +
 * permitted tools/capabilities = Agent Instance. The Lab MUST NOT
 * create a second model-routing authority. Model selection is
 * delegated to the existing AI runtime boundary."; §15 "Agent
 * Organization" ("An agent organization is a graph of Agent Bodies...
 * A single generalist agent is a valid candidate and MUST be included
 * as a baseline" — the organization layer is LAB-012, NOT this module:
 * this module owns the BODIES and the INSTANCE RUNS the organization
 * layer composes); §22 multi-tenancy ("All Lab scenarios, corpora,
 * feature bundles, model artifacts, runs and calibration records
 * remain tenant/workspace scoped. Cross-tenant content may not be
 * silently incorporated into a tenant's proprietary search space.");
 * §23 operational constraints (budget caps); spec/
 * module-dependency-matrix-v1.7.md row `LAB-011 | Agent Body |
 * LAB-001, /ai-runtime | B`; AGENTS.md v1.7 rules ("Agent Body is
 * MOS-owned. LLMs are occupants selected through existing /ai-runtime.
 * Generalist single-agent baseline is mandatory."); architecture-lock
 * -v1.7: Lab artifacts never shadow v1.6 authorities.
 *
 * THE TWO LAYERS (LAB-011's frozen scope):
 *
 *   - THE VERSIONED AGENT BODY REGISTRY (§14 declared data): a body
 *     version is a versioned, append-only, CLIENT-SCOPED record
 *     carrying the FULL §14 field set AS DECLARED DATA — role
 *     contract, input/output contracts, tool declarations,
 *     permissions, memory-interface declarations, communication
 *     interface, action interface, capability references (OPAQUE
 *     strings — the capability ENGINE is LAB-013, NOT this module:
 *     requirements/declarations only), budget, latency limits,
 *     evaluation-hook declarations and safety/policy constraints.
 *     Corrections are NEW version rows (the LAB-001 append-only
 *     discipline; draft → active → retired, no in-place rewrites).
 *     This registry is EXACTLY what /lab organization candidates cite:
 *     LAB-001 public.ts LabOrganizationCandidateDeclaration.
 *     agentBodyVersions is an array of OPAQUE body-version strings —
 *     this module owns both the registry and the reference format
 *     (LAB_AGENT_BODY_REFERENCE_PATTERN: '<bodyId>#v<version>'). NO
 *     import of /lab exists here and NO /lab table is written — the
 *     citation is data, exactly the by-reference discipline the /lab
 *     and /lab-corpus headers prescribe.
 *
 *   - AGENT INSTANCE EXECUTION (§14's formula, made runnable):
 *     `Agent Body version + selected model + permitted tools =
 *     Agent Instance`. runAgentInstance instantiates the instance and
 *     RUNS it: it accepts an input-contract message, resolves the
 *     caller-supplied model identity THROUGH THE /ai-runtime PUBLIC
 *     API (the LabAgentBodyAiRuntimePort structural port — model
 *     identity is DATA flowing through the /ai-runtime boundary; the
 *     real AiRuntimeModuleApi satisfies the port at the composition
 *     root), invokes the model through the caller-supplied
 *     model-backend port (the /ai-runtime ProviderAdapter discipline:
 *     the composition root wires provider adapters; route-time callers
 *     supply them — exactly the /ai-runtime routeTask adapter
 *     precedent), executes permitted tool invocations (results
 *     recorded as events), enforces the declared budget
 *     (model-invocation / tool-invocation / token / cost caps —
 *     exceeded is the honest `budget_exceeded` terminal state, the
 *     LAB-001 run discipline) and latency limits (deadline exceeded is
 *     the honest `latency_exceeded` terminal state), exercises the
 *     declared memory interfaces (bounded read/write with
 *     capacity-refusal — never silent unbounded growth), fires the
 *     declared evaluation hooks (recorded as DATA — hook identity +
 *     payload digest + outcome slot; the evaluation LOGIC is
 *     LAB-016/018, never here) and produces the output-contract
 *     message. Every step is recorded on the append-only run event
 *     tail — the recording substrate LAB-012's organization runtime
 *     composes multi-agent runs from (the organization runtime itself
 *     is LAB-012, deliberately NOT here).
 *
 * THE NO-SECOND-ROUTER RULE (§14, structural): this module implements
 * ZERO model-selection policy — no eligibility, no ranking, no
 * tradeoff, no cascade, no routing-policy interpretation. The model
 * identity arrives as run-input DATA selected by the CALLER (mirroring
 * /lab's LabOrganizationCandidateDeclaration.modelAssignments:
 * "opaque /ai-runtime model identities — the Lab never routes models
 * itself"), is RESOLVED through the /ai-runtime registry port (the
 * /ai-runtime authority: an identity that does not resolve, is
 * retired, or reports `unavailable` is the honest `model_unavailable`
 * terminal failure) and is executed through the model-backend port
 * (the ProviderAdapter discipline). The /ai-runtime routing layer
 * (routeTask/RoutingPolicy) remains the ONE model-routing authority;
 * this module never imports, calls or reimplements it. The static
 * proof lives in tests/architecture/lab-agent-body-boundary.test.ts.
 *
 * Tenant scope: every body/run/event/memory row is CLIENT-scoped (§22
 * — the hard security boundary) with an optional workspace anchor,
 * exactly the /lab and /lab-corpus house pattern. All cross-tenant
 * reads resolve to the uniform NotFound (no existence oracle). Body
 * versions and run events are append-only/immutable per the
 * migration-063 guard triggers; memory entries are bounded current
 * state (last-write-wins per key, upsert-only) whose HISTORY is the
 * append-only memory_write/memory_refused event tail.
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import type { Db } from '../../platform/db/contract.ts';

// ---------------------------------------------------------------------------
// The frozen vocabularies (CHECK-fenced in migration 063 — closed sets).
// ---------------------------------------------------------------------------

/** The contract vocabulary version of every agent-body artifact (the LAB-001 'lab-contract-v1' discipline). */
export const LAB_AGENT_BODY_CONTRACT_VERSION = 'lab-agent-body-contract-v1' as const;

/**
 * The closed body lifecycle (the LAB-001 scenario / LAB-002 corpus
 * discipline): a body is DRAFT while being composed, ACTIVE once
 * frozen for instantiation (runs bind ACTIVE bodies only), RETIRED
 * once deprecated (existing runs keep their recorded version; new runs
 * are refused). Corrections to an ACTIVE body are NEW version rows,
 * never in-place rewrites.
 */
export const LAB_AGENT_BODY_STATUSES = ['draft', 'active', 'retired'] as const;
export type LabAgentBodyStatus = (typeof LAB_AGENT_BODY_STATUSES)[number];

/**
 * The closed tool action-kind vocabulary (§14 "tools" + "permissions"):
 * what KIND of action a declared tool performs. The permission set of
 * a body is a subset of this vocabulary; a tool invocation whose
 * action kind is outside the permission set is REFUSED
 * (`permission_refused`). The vocabulary is deliberately a
 * read/compose/analyze/transform/communicate/simulate set — the
 * §18/§21 publication-and-engagement surface is STRUCTURALLY ABSENT
 * (no 'publish', no 'engage', no 'impersonate' verb exists to permit:
 * the Lab never publishes directly, and the anti-gaming surface cannot
 * be expressed — the /platform-health structural-absence pattern).
 */
export const LAB_AGENT_BODY_ACTION_KINDS = [
  'read',
  'analyze',
  'compose',
  'transform',
  'communicate',
  'simulate',
] as const;
export type LabAgentBodyActionKind = (typeof LAB_AGENT_BODY_ACTION_KINDS)[number];

/**
 * The closed safety/policy constraint vocabulary (§14 "safety/policy
 * constraints" — the §21 anti-gaming hard-rejection gates): every body
 * MUST declare a NON-EMPTY subset (a body without a declared safety
 * posture is inexpressible). The declared set is recorded on every run
 * (the run record carries the body's safety posture as data); the
 * runtime additionally enforces the structural fences — the action
 * kinds above cannot express the forbidden behaviors, and the action
 * verbs below exclude them outright.
 */
export const LAB_AGENT_BODY_SAFETY_CONSTRAINTS = [
  'no_fake_engagement',
  'no_impersonation',
  'no_rights_circumvention',
  'no_anti_abuse_evasion',
  'no_deceptive_attribution',
] as const;
export type LabAgentBodySafetyConstraint = (typeof LAB_AGENT_BODY_SAFETY_CONSTRAINTS)[number];

/**
 * The closed action-verb vocabulary for the §14 ACTION INTERFACE
 * (declared data — the action surface a body's outputs may request;
 * LAB-012's organization runtime composes against it). Every verb is a
 * SAFE in-lab action: the direct-publication / inauthentic-engagement
 * verbs ('publish_directly', 'engage_inauthentically', 'impersonate',
 * 'bypass_platform_restriction', 'fabricate_testimonial') are
 * STRUCTURALLY UNREPRESENTABLE — they are not in the vocabulary and
 * can never be declared or emitted (the /platform-health
 * recommendation-vocabulary pattern; real execution goes through the
 * LAB-014 bridge into the existing v1.6 authorities, never here).
 */
export const LAB_AGENT_BODY_ACTION_VERBS = [
  'draft_content',
  'request_review',
  'cite_evidence',
  'analyze_audience',
  'plan_calendar',
  'simulate_distribution',
  'request_approval',
  'send_internal_message',
] as const;
export type LabAgentBodyActionVerb = (typeof LAB_AGENT_BODY_ACTION_VERBS)[number];

/** The closed memory-interface kind vocabulary (§14 "memory interfaces"): run-scoped scratch or body-scoped persistent memory. */
export const LAB_AGENT_BODY_MEMORY_KINDS = ['run_scoped', 'body_scoped'] as const;
export type LabAgentBodyMemoryKind = (typeof LAB_AGENT_BODY_MEMORY_KINDS)[number];

/** The closed instance-run state vocabulary: a run is RUNNING until it terminates SUCCEEDED or FAILED (terminal). */
export const LAB_AGENT_BODY_RUN_STATUSES = ['running', 'succeeded', 'failed'] as const;
export type LabAgentBodyRunStatus = (typeof LAB_AGENT_BODY_RUN_STATUSES)[number];

/**
 * The closed honest-failure taxonomy (the LAB-001 run discipline —
 * CHECK-fenced in migration 063): why an agent-instance run FAILED.
 *   - `input_contract_violation`  — the input message does not satisfy
 *     the body's input contract (no model invocation happens);
 *   - `model_unavailable`         — the caller-supplied model identity
 *     does not resolve through the /ai-runtime registry, is retired,
 *     reports `unavailable`, or the supplied backend cannot serve its
 *     provider;
 *   - `model_invocation_failed`   — the model backend executed and
 *     returned an invocation-level failure (never a throw — the
 *     ProviderAdapter data discipline);
 *   - `permission_refused`        — the model requested a tool outside
 *     the body's declared tool set or permission set (fail-closed: the
 *     run terminates, the refusal is recorded as an event);
 *   - `tool_error`                — a PERMITTED tool execution failed;
 *   - `budget_exceeded`           — a declared budget cap (model
 *     invocations, tool invocations, tokens in/out, cost units) was
 *     exceeded;
 *   - `latency_exceeded`          — the declared deadline passed;
 *   - `output_contract_violation` — the final model output does not
 *     satisfy the body's output contract.
 */
export const LAB_AGENT_BODY_RUN_FAILURE_REASONS = [
  'input_contract_violation',
  'model_unavailable',
  'model_invocation_failed',
  'permission_refused',
  'tool_error',
  'budget_exceeded',
  'latency_exceeded',
  'output_contract_violation',
] as const;
export type LabAgentBodyRunFailureReason = (typeof LAB_AGENT_BODY_RUN_FAILURE_REASONS)[number];

/**
 * The closed run-event vocabulary (the append-only instance-run tail —
 * the recording substrate LAB-012 composes multi-agent runs from):
 * run_started, model_invocation (one per model round, with the
 * observed telemetry), tool_invocation / tool_refusal (permitted
 * executions / permission fences), memory_write / memory_refused (the
 * bounded-memory events), evaluation_hook (the declared hook firings —
 * DATA only) and run_completed / run_failed (the terminal events).
 */
export const LAB_AGENT_BODY_EVENT_KINDS = [
  'run_started',
  'model_invocation',
  'tool_invocation',
  'tool_refusal',
  'memory_write',
  'memory_refused',
  'evaluation_hook',
  'run_completed',
  'run_failed',
] as const;
export type LabAgentBodyEventKind = (typeof LAB_AGENT_BODY_EVENT_KINDS)[number];

/** The closed memory-refusal reason vocabulary (NON-terminal — the run continues; the write is refused and recorded). */
export const LAB_AGENT_BODY_MEMORY_REFUSAL_REASONS = ['memory_not_declared', 'memory_capacity_exceeded'] as const;
export type LabAgentBodyMemoryRefusalReason = (typeof LAB_AGENT_BODY_MEMORY_REFUSAL_REASONS)[number];

/** The closed tool-refusal reason vocabulary (terminal `permission_refused` — fail-closed). */
export const LAB_AGENT_BODY_TOOL_REFUSAL_REASONS = ['undeclared_tool', 'action_not_permitted'] as const;
export type LabAgentBodyToolRefusalReason = (typeof LAB_AGENT_BODY_TOOL_REFUSAL_REASONS)[number];

/**
 * The evaluation-hook outcome slot vocabulary: `pending` is the ONLY
 * value this module records — the hook FIRING is data (hook identity +
 * payload digest + outcome slot); the evaluation OUTCOME is written by
 * the later evaluation consumers (LAB-016/018) into THEIR OWN records
 * citing the run. No evaluation logic exists here (§14 "evaluation
 * hooks" as declarations + firings, never engines).
 */
export const LAB_AGENT_BODY_HOOK_OUTCOMES = ['pending'] as const;
export type LabAgentBodyHookOutcome = (typeof LAB_AGENT_BODY_HOOK_OUTCOMES)[number];

/**
 * The closed message-field type vocabulary of the input/output
 * contract schema subset (the deterministic structural validator of
 * internal/validation.ts): a contract schema is
 * `{ type: 'object', required: string[], properties: Record<string, { type }>, maxKeys?: number }`
 * — one level deep, fully deterministic, no JSON-pointer ambiguity.
 * The subset is DISCLOSED frozen surface: richer schema vocabularies
 * are later additive work, never silent reinterpretation.
 */
export const LAB_AGENT_BODY_MESSAGE_FIELD_TYPES = [
  'string',
  'number',
  'integer',
  'boolean',
  'object',
  'array',
] as const;
export type LabAgentBodyMessageFieldType = (typeof LAB_AGENT_BODY_MESSAGE_FIELD_TYPES)[number];

/**
 * The RESERVED model-response control-channel keys (the agent-runtime
 * protocol): a model backend response may carry `agentToolCalls`
 * (tool invocations the model requests) and `agentMemoryWrites`
 * (memory writes the model issues) BESIDE the output-contract
 * message. The keys are reserved: a contract schema declaring either
 * as a property is REJECTED at body creation (the collision fence),
 * and the FINAL output message is the response with both keys
 * stripped (stripRuntimeControlChannels — pure, exported for tests).
 */
export const LAB_AGENT_BODY_TOOL_CALLS_KEY = 'agentToolCalls' as const;
export const LAB_AGENT_BODY_MEMORY_WRITES_KEY = 'agentMemoryWrites' as const;

/** The upper bound of body versions per body (the append-only correction chain fence). */
export const LAB_AGENT_BODY_MAX_VERSIONS = 1000;

/** The run-deadline bounds (the §14 latency limits — the honest latency_exceeded fence). */
export const LAB_AGENT_BODY_LATENCY_DEADLINE_MIN_MS = 1;
export const LAB_AGENT_BODY_LATENCY_DEADLINE_MAX_MS = 600_000;

/** The opaque body-version reference pattern — what /lab organization candidates cite (`<bodyId>#v<version>`). */
export const LAB_AGENT_BODY_REFERENCE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}#v[1-9][0-9]{0,3}$/;

// ---------------------------------------------------------------------------
// The §14 field set — the declared body-contract data.
// ---------------------------------------------------------------------------

/** The role contract (§14): the body's role identity and description. */
export interface LabAgentBodyRoleContract {
  /** The role label (1-128 chars — e.g. 'generalist-strategist', the §15 single-agent-baseline occupant). */
  readonly role: string;
  /** The role description (0-2000 chars — the honest statement of what this body does). */
  readonly description: string;
}

/**
 * The input/output message-contract schema subset (§14 "input/output
 * contract"): a deterministic one-level object schema. Validated by
 * assertValidLabAgentMessageSchema at body creation; enforced by
 * validateLabAgentMessageAgainstContract at run time.
 */
export interface LabAgentMessageContractSchema {
  readonly type: 'object';
  readonly required: ReadonlyArray<string>;
  readonly properties: Readonly<Record<string, { readonly type: LabAgentBodyMessageFieldType }>>;
  readonly maxKeys?: number | undefined;
}

/** One tool declaration (§14 "tools"): the tool identity + its action kind (the permission fence key). */
export interface LabAgentBodyToolDeclaration {
  /** The tool id (1-64 chars of [a-z0-9-]). */
  readonly toolId: string;
  /** The action kind this tool performs (the closed vocabulary). */
  readonly actionKind: LabAgentBodyActionKind;
  /** The tool description (0-512 chars, declared data). */
  readonly description: string;
}

/** One memory-interface declaration (§14 "memory interfaces"): bounded memory the body may use. */
export interface LabAgentBodyMemoryInterfaceDeclaration {
  /** The memory id (1-64 chars of [a-z0-9-]). */
  readonly memoryId: string;
  /** run_scoped (per-run scratch) or body_scoped (persists across the body's runs, client-scoped). */
  readonly kind: LabAgentBodyMemoryKind;
  /** The capacity fence (1-1000 entries — over-capacity writes are REFUSED and recorded, never silent unbounded growth). */
  readonly capacityEntries: number;
}

/** One communication channel declaration (§14 "communication interface" — declared data for LAB-012's composition). */
export interface LabAgentBodyCommunicationChannel {
  /** The channel id (1-64 chars of [a-z0-9-]). */
  readonly channelId: string;
  readonly direction: 'inbound' | 'outbound';
  /** The message kind label (1-64 chars — declared data). */
  readonly messageKind: string;
}

/** One evaluation-hook declaration (§14 "evaluation hooks"): the hook identity that fires at the run's terminal transition. */
export interface LabAgentBodyEvaluationHookDeclaration {
  /** The hook id (1-64 chars of [a-z0-9-]) — what LAB-016/018 resolve when consuming the recorded firings. */
  readonly hookId: string;
}

/** The declared budget (§14 "budget" + §23 budget caps): the per-run caps the runtime enforces honestly. */
export interface LabAgentBodyBudget {
  /** The max model invocations per run (1-10 — the agent-loop bound). */
  readonly maxModelInvocations: number;
  /** The max tool invocations per run (0-100). */
  readonly maxToolInvocations: number;
  /** The max cumulative input tokens per run (1-10_000_000). */
  readonly maxTokensIn: number;
  /** The max cumulative output tokens per run (1-10_000_000). */
  readonly maxTokensOut: number;
  /** The max cumulative cost units per run (>= 0 — the backend-reported cost amount, the /ai-runtime costAmount semantics). */
  readonly maxCostUnits: number;
}

/** The declared latency limits (§14 "latency limits"): the per-run wall-clock deadline. */
export interface LabAgentBodyLatencyLimits {
  /** The run deadline in milliseconds (1-600_000 — exceeded is the honest latency_exceeded terminal state). */
  readonly deadlineMs: number;
}

/**
 * The FULL §14 Agent Body contract — the declared data of one body
 * version. Capability references are OPAQUE STRINGS (the capability
 * ENGINE is LAB-013; this module records requirements/declarations
 * only — no capability resolution happens here).
 */
export interface LabAgentBodyContract {
  readonly roleContract: LabAgentBodyRoleContract;
  readonly inputContract: LabAgentMessageContractSchema;
  readonly outputContract: LabAgentMessageContractSchema;
  /** The tool declarations (0-32). */
  readonly tools: ReadonlyArray<LabAgentBodyToolDeclaration>;
  /** The permission set — a NON-EMPTY subset of the action-kind vocabulary (the tool-invocation fence). */
  readonly permissions: ReadonlyArray<LabAgentBodyActionKind>;
  /** The memory-interface declarations (0-16). */
  readonly memoryInterfaces: ReadonlyArray<LabAgentBodyMemoryInterfaceDeclaration>;
  /** The communication interface (0-16 channels). */
  readonly communicationInterface: ReadonlyArray<LabAgentBodyCommunicationChannel>;
  /** The action interface — a subset of the SAFE action-verb vocabulary (0-16; declared data for LAB-012). */
  readonly actionInterface: ReadonlyArray<LabAgentBodyActionVerb>;
  /** The capability references (0-64 opaque strings — LAB-013 owns the engine). */
  readonly capabilities: ReadonlyArray<string>;
  readonly budget: LabAgentBodyBudget;
  readonly latencyLimits: LabAgentBodyLatencyLimits;
  /** The evaluation-hook declarations (0-16). */
  readonly evaluationHooks: ReadonlyArray<LabAgentBodyEvaluationHookDeclaration>;
  /** The safety/policy constraints — a NON-EMPTY subset of the §21 hard-rejection vocabulary. */
  readonly safetyConstraints: ReadonlyArray<LabAgentBodySafetyConstraint>;
}

// ---------------------------------------------------------------------------
// The persisted records.
// ---------------------------------------------------------------------------

/** A versioned Agent Body record (the registry the /lab organization candidates cite by opaque reference). */
export interface LabAgentBodyRecord {
  readonly bodyId: string;
  readonly bodyVersion: number;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly status: LabAgentBodyStatus;
  /** The FULL §14 contract as declared data. */
  readonly contract: LabAgentBodyContract;
  /** The opaque body-version reference (`<bodyId>#v<version>`) — the exact string /lab cites in agentBodyVersions. */
  readonly bodyVersionReference: string;
  readonly contractVersion: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * One Agent Instance run (§14's formula instantiated and run): body
 * version + selected model (the /ai-runtime identity snapshot, DATA) +
 * the permitted tools executed through the run. The run is the
 * append-only record; the step history is the event tail.
 */
export interface LabAgentInstanceRunRecord {
  readonly runId: string;
  readonly bodyId: string;
  readonly bodyVersion: number;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  /** The caller-supplied /ai-runtime model identity — DATA flowing through the boundary (never selected here). */
  readonly modelRegistryId: string;
  /** The model identity snapshot resolved through the /ai-runtime registry at run start (DATA). */
  readonly modelProviderLabel: string;
  readonly modelKey: string;
  readonly modelDisplayName: string;
  readonly status: LabAgentBodyRunStatus;
  /** The terminal failure reason (closed vocabulary; null unless status = 'failed'). */
  readonly failureReason: LabAgentBodyRunFailureReason | null;
  readonly inputMessage: Readonly<Record<string, unknown>>;
  /** The output-contract message (null unless status = 'succeeded'). */
  readonly outputMessage: Readonly<Record<string, unknown>> | null;
  /** The communication channel the run was addressed through (validated against the body's declared channels; null when unaddressed). */
  readonly addressedChannel: string | null;
  /** The observed usage counters (the honest budget accounting). */
  readonly modelInvocations: number;
  readonly toolInvocations: number;
  readonly observedTokensIn: number;
  readonly observedTokensOut: number;
  readonly observedCostUnits: number;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly contractVersion: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One append-only instance-run event (the recording substrate for LAB-012's composition). */
export interface LabAgentRunEventRecord {
  readonly eventId: string;
  readonly runId: string;
  readonly agencyId: string;
  readonly clientId: string;
  /** The per-run sequence number (1..N, assigned by the runtime, UNIQUE-fenced per run). */
  readonly seq: number;
  readonly eventKind: LabAgentBodyEventKind;
  /** The bounded event payload (structured data — tool results as digests, telemetry, hook identities...). */
  readonly payload: Readonly<Record<string, unknown>>;
  /** The SHA-256 digest of the canonical payload serialization (64 lowercase hex). */
  readonly payloadDigest: string;
  readonly contractVersion: string;
  readonly createdAt: string;
}

/** One bounded memory entry — the CURRENT-STATE store (last-write-wins per key; the history is the event tail). */
export interface LabAgentMemoryEntryRecord {
  readonly entryId: string;
  readonly bodyId: string;
  /** The run anchor (run_scoped memories; null for body_scoped). */
  readonly runId: string | null;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly memoryId: string;
  readonly kind: LabAgentBodyMemoryKind;
  readonly entryKey: string;
  readonly entryValue: Readonly<Record<string, unknown>>;
  readonly contractVersion: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// The /ai-runtime structural ports + the per-call execution ports
// (the routeTask adapter precedent — callers supply execution, the
// composition root wires the registry).
// ---------------------------------------------------------------------------

/**
 * The narrow /ai-runtime model snapshot this module consumes (the
 * registry resolution — identity as DATA). The real
 * ModelRegistryRecord satisfies this shape structurally.
 */
export interface LabAgentBodyModelSnapshot {
  readonly modelRegistryId: string;
  readonly providerLabel: string;
  readonly modelKey: string;
  readonly displayName: string;
  readonly contextLimitTokens: number;
  readonly availabilityState: 'available' | 'degraded' | 'unavailable';
  readonly status: 'active' | 'retired';
}

/**
 * THE NARROW /ai-runtime PORT — the model AUTHORITY boundary (the
 * /product-intelligence model-identity port precedent, extended with
 * the observation append): model-identity resolution (an identity must
 * resolve through the /ai-runtime registry — this module has NO model
 * registry of its own) + the append-only availability-observation
 * surface (every model invocation the runtime performs appends its
 * honest observation — latency + availability — to the SAME registry
 * the routing layer aggregates from; source 'lab-agent-body'). The
 * real AiRuntimeModuleApi satisfies this port structurally at the
 * composition root. READ + one append-only write surface; NO routing
 * surface (routeTask/RoutingPolicy are deliberately absent — the
 * no-second-router rule is structural).
 */
export interface LabAgentBodyAiRuntimePort {
  /** Resolves a model identity through the /ai-runtime registry (any lifecycle state — history records what ran). */
  getModel(modelRegistryId: string): Promise<LabAgentBodyModelSnapshot | null>;
  /** Appends one availability/telemetry observation of the invoked model (append-only; the registry derives its current state). */
  appendModelObservation(input: {
    readonly modelRegistryId: string;
    readonly availabilityState: 'available' | 'degraded' | 'unavailable';
    readonly observedLatencyP50Ms: number | null;
    readonly observedLatencyP95Ms: number | null;
    readonly source: string;
    readonly notes: string;
    readonly actorId: string | null;
  }): Promise<unknown>;
}

/**
 * The provider-neutral model invocation request — the identity triple
 * (DATA resolved through the /ai-runtime registry) + the agent-runtime
 * context (the input-contract message, the current memory contents,
 * the body's tool declarations, the prior round's tool results) + the
 * run's remaining budget.
 */
export interface LabAgentBodyModelInvocationRequest {
  readonly modelRegistryId: string;
  readonly providerLabel: string;
  readonly modelKey: string;
  /** The body's role label (the invocation's task-class context). */
  readonly taskClass: string;
  /** The input-contract message (plus the memory context and tool declarations as data). */
  readonly inputMessage: Readonly<Record<string, unknown>>;
  /** The current memory contents keyed by memoryId (the read path). */
  readonly memory: Readonly<Record<string, ReadonlyArray<Record<string, unknown>>>>;
  /** The body's tool declarations (the model sees its permitted tools as data). */
  readonly toolDeclarations: ReadonlyArray<LabAgentBodyToolDeclaration>;
  /** The prior round's tool results (absent on the first round). */
  readonly toolResults: ReadonlyArray<{ readonly toolId: string; readonly ok: boolean; readonly result: Readonly<Record<string, unknown>> | null }> | null;
  /** The remaining budget the backend should respect (advisory — the runtime enforces the caps itself). */
  readonly budget: { readonly maxCostUnits: number; readonly remainingMs: number };
}

/**
 * The provider-neutral model invocation outcome — the /ai-runtime
 * AdapterResponse discipline VERBATIM: the backend NEVER throws for
 * invocation-level outcomes; transport failures, provider errors and
 * timeouts are RETURNED as data (ok=false + error), so the runtime
 * records the honest `model_invocation_failed` terminal state. The
 * response `output` is the raw model response object; the runtime
 * reads the reserved control channels (agentToolCalls /
 * agentMemoryWrites) and validates the stripped message against the
 * body's output contract.
 */
export interface LabAgentBodyModelInvocationOutcome {
  readonly ok: boolean;
  readonly output: Readonly<Record<string, unknown>> | null;
  readonly error: string | null;
  readonly latencyMs: number;
  readonly costUnits: number;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
}

/**
 * THE MODEL BACKEND PORT (per-run, caller-supplied — the /ai-runtime
 * routeTask `adapter` parameter precedent: "the composition root
 * wires the OpenRouter adapter; tests supply fakes"). The backend
 * serves EXACTLY ONE provider (providerLabel — like
 * ProviderAdapter.providerLabel); the runtime refuses a backend whose
 * provider does not match the resolved model's provider label (the
 * honest `model_unavailable` — a wiring mismatch, never a silent
 * fallback). THIS MODULE NEVER SELECTS BETWEEN BACKENDS: one run, one
 * caller-chosen identity, one backend — no routing logic exists here.
 */
export interface LabAgentBodyModelBackendPort {
  /** The provider label this backend serves (must match the model's providerLabel). */
  readonly providerLabel: string;
  /** Invokes the caller-selected model. NEVER throws for invocation outcomes. */
  invokeModel(request: LabAgentBodyModelInvocationRequest): Promise<LabAgentBodyModelInvocationOutcome>;
}

/**
 * The tool executor port (per-run, caller-supplied — the same
 * adapter-discipline seam): executes ONE PERMITTED tool invocation.
 * The runtime owns the permission fence (declared tool + permitted
 * action kind) BEFORE the executor runs; the executor returns the
 * outcome as data (ok=false is the honest `tool_error` terminal
 * state; a thrown executor error is caught and recorded the same way).
 */
export interface LabAgentBodyToolExecutorPort {
  executeTool(input: {
    readonly toolId: string;
    readonly actionKind: LabAgentBodyActionKind;
    readonly arguments: Readonly<Record<string, unknown>>;
  }): Promise<{ readonly ok: boolean; readonly result: Readonly<Record<string, unknown>> | null; readonly error: string | null }>;
}

/** One model-requested tool call (the reserved control-channel entry). */
export interface LabAgentBodyToolCall {
  readonly toolId: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** One model-issued memory write (the reserved control-channel entry). */
export interface LabAgentBodyMemoryWrite {
  readonly memoryId: string;
  readonly entryKey: string;
  readonly entryValue: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// The module ports (deps) and public API.
// ---------------------------------------------------------------------------

/**
 * Module dependencies: the platform ports (db, clock, ids — the /lab
 * family discipline) PLUS the narrow /ai-runtime structural port (the
 * model authority — satisfied by the real AiRuntimeModuleApi at the
 * composition root; zero cross-module imports exist inside this
 * module). NO model backend lives in the deps: backends are per-run
 * caller-supplied (the routeTask adapter precedent).
 */
export interface LabAgentBodyModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly aiRuntime: LabAgentBodyAiRuntimePort;
}

/** The scope every agent-body artifact is created/read under (the uniform NotFound for foreign scope — no existence oracle). */
export interface LabAgentBodyScope {
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId?: string | null;
}

/** Body creation input (the version-1 record; the module assigns ids/versions/timestamps). */
export interface CreateLabAgentBodyInput {
  readonly scope: LabAgentBodyScope;
  readonly contract: LabAgentBodyContract;
}

/** Body correction input (append-only — a NEW version row as draft). */
export interface CorrectLabAgentBodyInput {
  readonly scope: LabAgentBodyScope;
  readonly bodyId: string;
  readonly contract: LabAgentBodyContract;
}

/**
 * The agent-instance run input (§14's formula as a command): the body
 * version reference (opaque — the same string /lab cites), the
 * caller-selected /ai-runtime model identity (DATA — this module never
 * selects), the input-contract message, the caller-supplied model
 * backend + tool executor (the adapter discipline) and the optional
 * addressed communication channel.
 */
export interface RunLabAgentInstanceInput {
  readonly scope: LabAgentBodyScope;
  /** The opaque body-version reference (`<bodyId>#v<version>`) — resolved to the exact version (which MUST be ACTIVE). */
  readonly bodyVersionReference: string;
  /** The /ai-runtime model identity selected by the CALLER (data — never selected here). */
  readonly modelRegistryId: string;
  /** The input-contract message (must satisfy the body's inputContract; may not carry the reserved control keys). */
  readonly inputMessage: Readonly<Record<string, unknown>>;
  /** The caller-supplied model backend serving the selected identity's provider. */
  readonly backend: LabAgentBodyModelBackendPort;
  /** The caller-supplied tool executor for the body's declared tools. */
  readonly toolExecutor: LabAgentBodyToolExecutorPort;
  /** The optional communication channel the run is addressed through (must be a declared channel). */
  readonly addressedChannel?: string | null;
}

/** The /lab-agent-body module public API — the frozen surface consumed by LAB-012 (organization search), LAB-013 (capabilities) and the evaluation consumers (LAB-016/018) BY REFERENCE. */
export interface LabAgentBodyModuleApi {
  // --- The versioned body registry (the §14 field set) ---
  createBody(input: CreateLabAgentBodyInput): Promise<LabAgentBodyRecord>;
  /** Resolves the LATEST version of a body. */
  getBody(scope: LabAgentBodyScope, bodyId: string): Promise<LabAgentBodyRecord>;
  /** Resolves the EXACT version an opaque body-version reference cites (the /lab agentBodyVersions resolution path). */
  getBodyByReference(scope: LabAgentBodyScope, bodyVersionReference: string): Promise<LabAgentBodyRecord>;
  listBodies(scope: LabAgentBodyScope): Promise<ReadonlyArray<LabAgentBodyRecord>>;
  /** Activates a DRAFT body (the instantiation gate — runs bind ACTIVE bodies only). */
  activateBody(scope: LabAgentBodyScope, bodyId: string): Promise<LabAgentBodyRecord>;
  /** Retires an ACTIVE body (new runs refused; existing runs keep their recorded version). */
  retireBody(scope: LabAgentBodyScope, bodyId: string): Promise<LabAgentBodyRecord>;
  /** Appends a corrected body version (the append-only correction path — returns the NEW version record as draft). */
  correctBody(input: CorrectLabAgentBodyInput): Promise<LabAgentBodyRecord>;

  // --- Agent Instance execution (the runtime) ---
  runAgentInstance(input: RunLabAgentInstanceInput): Promise<LabAgentInstanceRunRecord>;
  getRun(scope: LabAgentBodyScope, runId: string): Promise<LabAgentInstanceRunRecord>;
  listRuns(scope: LabAgentBodyScope, bodyId?: string): Promise<ReadonlyArray<LabAgentInstanceRunRecord>>;
  /** The append-only run event tail (oldest first — the LAB-012 composition substrate). */
  listRunEvents(scope: LabAgentBodyScope, runId: string): Promise<ReadonlyArray<LabAgentRunEventRecord>>;

  // --- Memory interfaces (bounded, scoped — the read surface) ---
  /** The CURRENT body-scoped memory entries of one declared memory (client-fenced; run-scoped memory is readable through the run event tail). */
  readBodyMemory(scope: LabAgentBodyScope, bodyId: string, memoryId: string): Promise<ReadonlyArray<LabAgentMemoryEntryRecord>>;
}

export { createLabAgentBodyModule } from './internal/agent-body-module.ts';
/**
 * The pure contract guards + deterministic helpers (the body-contract
 * discipline, the message-schema subset validator, the run-input
 * fences, the version-reference format) — exported for unit tests
 * and the later Lab modules so the CONTRACT semantics are part of the
 * module surface. Pure functions: no clock, no randomness, no network.
 */
export {
  assertValidLabAgentBodyContract,
  assertValidLabAgentMessageSchema,
  validateLabAgentMessageAgainstContract,
  stripRuntimeControlChannels,
  assertValidRunLabAgentInstanceInput,
  formatLabAgentBodyVersionReference,
  parseLabAgentBodyVersionReference,
} from './internal/validation.ts';
