/**
 * MarketingOS module: /lab
 * Authority: Marketing Engineering Lab Contracts and Run Model (LAB-001 —
 * spec/effective-backlog-v1.7.md LAB-001: "Build the Lab Scenario, Lab Run,
 * Strategy Candidate, Organization Candidate, Capability Candidate and
 * Calibration Record contracts. Acceptance: versioned contracts, tenant
 * isolation, deterministic seeds, lifecycle states, no shadowing of v1.6
 * authorities."; spec/architecture-v1.7-marketing-lab.md §3 "Authority
 * boundaries": "v1.7 introduces Lab-owned simulation artifacts only: Lab
 * Scenario; Lab Run; World Model Version; Strategy Candidate; Agent
 * Organization Candidate; Capability Candidate; Calibration Record. A Lab
 * Run is not a business Experiment and never replaces /experiments. A
 * Strategy Candidate is not a Decision and never rewrites the Decision
 * Ledger. A simulated publication is not a real Publication. Historical
 * replay is evidence-backed replay; counterfactual outcomes are model
 * output and MUST be labeled as such."; §9 "A simulator run MUST be able
 * to reproduce a trajectory given a recorded seed/configuration"; §10 Time
 * Machine run-record fields; §12 "The reward definition is versioned and
 * included in every reproducible run"; §22 multi-tenancy; §23 operational
 * constraints (queued runs, resumable runs, deterministic seeds,
 * cancellation, budget caps, concurrency limits, retry/idempotency,
 * artifact lineage); spec/frozen-manifest-v1.7.json labArtifacts;
 * architecture-lock-v1.7 rules: Lab artifacts never shadow v1.6
 * authorities, counterfactuals are model outputs, time-machine lag
 * prevents future leakage, durable workers not synchronous web requests.
 *
 * THE CONTRACT LAYER (LAB-001's frozen scope — the corpus (LAB-002),
 * features (LAB-003), simulator (LAB-005), ensembles (LAB-008), Agent
 * Bodies (LAB-011) and the real bridge (LAB-014) all consume THESE
 * contracts BY REFERENCE; none of their logic lives here):
 *
 *   - THE SEVEN VERSIONED ARTIFACT CONTRACTS: LabScenario, LabRun,
 *     StrategyCandidate, OrganizationCandidate, CapabilityCandidate,
 *     CalibrationRecord and the WorldModelVersion REFERENCE contract (the
 *     versioned pointer shape that run records cite; the version registry
 *     itself is owned by LAB-008's ensemble layer — this module records
 *     the citation shape only, so LAB-005/006/007 can already bind runs
 *     to world-model versions before the ensemble authority exists).
 *   - THE RUN MODEL: the closed run lifecycle (queued → running →
 *     succeeded/failed/cancelled, with the resumable pause/resume pair),
 *     the deterministic seed discipline (a structured 64-bit master seed
 *     + the derived-seed lineage recorded on every run; identical
 *     scenario version + configuration + seeds MUST reproduce the same
 *     trajectory — reproducibility is asserted at the contract layer by
 *     recording everything the simulator needs), the §23 budget caps
 *     (simulated-step + compute-cost + wall-clock-ms caps, honestly
 *     recorded on every run) and the per-client active-run concurrency
 *     limit (the §23 concurrency fence enforced at run start).
 *   - THE FACTUALITY LABELS (§3/§10): every run and every candidate
 *     evaluation summary carries the closed factuality vocabulary —
 *     'factual_historical_replay' (evidence-backed reconstruction) vs
 *     'counterfactual_model_estimate' (world-model output, labeled as
 *     such) vs 'simulated_model_output' (pure simulator output). A
 *     counterfactual or simulated outcome can never be presented as an
 *     observed fact: the label ships on every read surface.
 *   - THE TIME-MACHINE RUN FIELDS (§10 verbatim): wall-clock/reference
 *     timestamps, simulated clock (start/end), observation cutoff,
 *     information lag (minutes, ≥ 0 — the delayed-information fence: at
 *     simulated time T the agent only receives information available at
 *     or before T−lag), world-model version and random seeds.
 *   - THE SINGLE-AGENT BASELINE MANDATE (§15/§20): an OrganizationCandidate
 *     declares the closed topology vocabulary, and the module exposes the
 *     canonical SINGLE_AGENT_BASELINE_TOPOLOGY constant — the generalist
 *     baseline that organization search MUST include (LAB-012 enforces
 *     the search; the contract makes the baseline impossible to miss by
 *     naming it).
 *   - NO SHADOWING (§3, structural): this module owns ONLY its six
 *     migration-059 tables. It creates no Experiment, Decision,
 *     Publication, Evidence, Metric or Execution records and holds no
 *     dependency on any v1.6 authority module (the frozen v1.7 matrix row
 *     for /lab depends on nothing beyond the v1.6 architecture): the
 *     real-world outcome anchors of CalibrationRecord are stored as
 *     opaque same-client EXTERNAL REFERENCES (kind + authority name +
 *     id — validated as UUID shape, never FK-joined, never re-derived)
 *     precisely so the Lab cannot mutate or fabricate authority records;
 *     the LAB-014 bridge is the only future path that binds runs into
 *     real missions THROUGH the existing authorities.
 *
 * Tenant scope: every artifact row is CLIENT-scoped (the hard security
 * boundary — spec/architecture.md §4) with an optional workspace anchor,
 * exactly the platform-health/content-intelligence house pattern. All
 * cross-tenant reads resolve to the uniform NotFound (no existence
 * oracle). Artifacts are APPEND-ONLY with versioned corrections: a
 * scenario correction is a NEW scenario version; a candidate evaluation
 * is a NEW appended evaluation block, never an in-place rewrite (the
 * house lifecycle discipline; CHECK-fenced vocabularies and
 * append-only UPDATE/DELETE rejection triggers in migration 059).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import type { Db } from '../../platform/db/contract.ts';

// ---------------------------------------------------------------------------
// The frozen vocabularies (CHECK-fenced in migration 059 — closed sets).
// ---------------------------------------------------------------------------

/** The contract vocabulary version of every Lab artifact (LAB-001 acceptance: versioned contracts). */
export const LAB_CONTRACT_VERSION = 'lab-contract-v1' as const;

/** The artifact kinds owned by this module (frozen-manifest-v1.7 labArtifacts). */
export const LAB_ARTIFACT_KINDS = [
  'lab-scenario',
  'lab-run',
  'world-model-version',
  'strategy-candidate',
  'agent-organization-candidate',
  'capability-candidate',
  'calibration-record',
] as const;
export type LabArtifactKind = (typeof LAB_ARTIFACT_KINDS)[number];

/**
 * The closed scenario lifecycle. A scenario is a DRAFT while being
 * composed, ACTIVE once frozen for runs (runs may only bind ACTIVE
 * scenarios — enforced at run create), and RETIRED once deprecated
 * (existing runs keep their recorded scenario version; new runs are
 * refused). Corrections to an ACTIVE scenario are NEW versions, never
 * in-place rewrites.
 */
export const LAB_SCENARIO_STATUSES = ['draft', 'active', 'retired'] as const;
export type LabScenarioStatus = (typeof LAB_SCENARIO_STATUSES)[number];

/**
 * The closed run lifecycle (§23: queued runs, resumable runs,
 * cancellation). Terminal states are immutable; 'failed' carries the
 * closed failure vocabulary; 'paused' is the resumable intermediate
 * (a paused run resumes with the SAME recorded seeds and configuration —
 * reproducibility survives the pause/resume pair).
 */
export const LAB_RUN_STATUSES = [
  'queued',
  'running',
  'paused',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type LabRunStatus = (typeof LAB_RUN_STATUSES)[number];

/** The closed run failure vocabulary (migration 059 CHECK fence). */
export const LAB_RUN_FAILURE_REASONS = [
  'budget_exceeded',
  'configuration_invalid',
  'simulator_error',
  'cancelled_by_operator',
  'interrupted',
] as const;
export type LabRunFailureReason = (typeof LAB_RUN_FAILURE_REASONS)[number];

/**
 * The closed Time-Machine mode vocabulary (§10): historical_replay
 * (evidence-backed reconstruction — factual), delayed_information
 * (historical replay behind an information lag), counterfactual
 * (branching alternate actions from a historical state — model output).
 */
export const LAB_RUN_MODES = [
  'historical_replay',
  'delayed_information',
  'counterfactual',
] as const;
export type LabRunMode = (typeof LAB_RUN_MODES)[number];

/**
 * The closed factuality vocabulary (§3/§10 — the visible label that
 * separates historical fact from model output). 'factual_historical_replay'
 * is reserved for runs whose outcomes reconstruct RETAINED EVIDENCE;
 * 'counterfactual_model_estimate' and 'simulated_model_output' are model
 * outputs and are labeled as such on every read surface.
 */
export const LAB_FACTUALITY_LABELS = [
  'factual_historical_replay',
  'counterfactual_model_estimate',
  'simulated_model_output',
] as const;
export type LabFactualityLabel = (typeof LAB_FACTUALITY_LABELS)[number];

/**
 * The closed candidate lifecycle shared by strategy and organization
 * candidates: DRAFT while composing, EVALUATED once a Lab run has
 * appended an evaluation summary, SELECTED when chosen for real-bridge
 * candidacy (a selection here is Lab bookkeeping ONLY — the real
 * Decision Ledger is untouched; LAB-014 performs any real promotion
 * through the v1.6 authorities), REJECTED when discarded.
 */
export const LAB_CANDIDATE_STATUSES = ['draft', 'evaluated', 'selected', 'rejected'] as const;
export type LabCandidateStatus = (typeof LAB_CANDIDATE_STATUSES)[number];

/**
 * The closed organization topology vocabulary (§15 search dimensions;
 * the generalist single-agent baseline is the first entry — §15: "A
 * single generalist agent is a valid candidate and MUST be included as
 * a baseline").
 */
export const LAB_ORGANIZATION_TOPOLOGIES = [
  'single_agent_baseline',
  'specialized_pipeline',
  'hierarchical_delegation',
  'debate_consensus',
  'custom_graph',
] as const;
export type LabOrganizationTopology = (typeof LAB_ORGANIZATION_TOPOLOGIES)[number];

/**
 * The closed capability-candidate lifecycle: DECLARED when the contract
 * is specified, SIMULATION_VERIFIED once a simulator implementation has
 * passed its quality evaluator in a run, REAL_VERIFIED once the real
 * implementation is verified (the Arena acquisition path, LAB-013), and
 * the terminal pair. The capability-gap flow (§16) starts here.
 */
export const LAB_CAPABILITY_STATUSES = [
  'declared',
  'simulation_verified',
  'real_verified',
  'rejected',
] as const;
export type LabCapabilityStatus = (typeof LAB_CAPABILITY_STATUSES)[number];

/**
 * The closed calibration-record lifecycle (§19): RECORDED when the
 * prediction-vs-observation pair is appended, APPLIED when a calibration
 * update/version cites it. Append-only; a recalibration is a NEW record.
 */
export const LAB_CALIBRATION_STATUSES = ['recorded', 'applied'] as const;
export type LabCalibrationStatus = (typeof LAB_CALIBRATION_STATUSES)[number];

/** The closed external-reference kinds a calibration record may anchor (READ-ONLY opaque references — no authority mutation). */
export const LAB_EXTERNAL_REFERENCE_KINDS = [
  'experiment',
  'evidence',
  'metric_observation',
  'publish_attempt',
] as const;
export type LabExternalReferenceKind = (typeof LAB_EXTERNAL_REFERENCE_KINDS)[number];

/** The closed observed-regime vocabulary (§19 — the calibration environment classification). */
export const LAB_OBSERVED_REGIMES = ['regime-stable', 'regime-shift', 'regime-unknown'] as const;
export type LabObservedRegime = (typeof LAB_OBSERVED_REGIMES)[number];

/** The maximum number of simultaneously ACTIVE (queued|running|paused) runs per client (§23 concurrency limit). */
export const LAB_MAX_ACTIVE_RUNS_PER_CLIENT = 4;

/** The upper bound of scenario versions per scenario (the append-only correction chain fence). */
export const LAB_MAX_SCENARIO_VERSIONS = 1000;

// ---------------------------------------------------------------------------
// The deterministic seed discipline (§9/§10/§23).
// ---------------------------------------------------------------------------

/**
 * A recorded deterministic seed set (§9: "A simulator run MUST be able to
 * reproduce a trajectory given a recorded seed/configuration"). The master
 * seed is an unsigned 64-bit integer recorded as a decimal string (the
 * JSON-safe representation; PostgreSQL numeric-precision safe). Derived
 * seeds (per-subsystem) are recorded WITH their derivation labels so the
 * run record is the complete reproducibility input.
 */
export interface LabSeedSet {
  /** The master seed, decimal string of an unsigned 64-bit integer [0, 2^64). */
  masterSeed: string;
  /** Named derived seeds (e.g. 'user_population', 'ranking', 'creator_competition') — each a decimal-string u64. */
  derived: ReadonlyArray<{ label: string; seed: string }>;
}

// ---------------------------------------------------------------------------
// Lab Scenario (the versioned experiment definition).
// ---------------------------------------------------------------------------

/** The versioned reward-definition block (§12 — business-outcome-first, included in every reproducible run). */
export interface LabRewardDefinition {
  /** The reward vocabulary version ('lab-reward-v1' — frozen with this contract). */
  version: string;
  /** The declared target outcome (mission-bound business outcome, not a vanity metric). */
  declaredTargetOutcome: string;
  /** The weight vector over the §12 component list (component name → non-negative weight). */
  weights: Readonly<Record<string, number>>;
  /** Hard-rejection gates (§21 anti-gaming: disallowed behaviors reject the candidate outright). */
  hardRejectionGates: ReadonlyArray<string>;
}

/** The scenario's platform/niche binding declaration (versioned data; adapters are NOT resolved here — LAB-002 owns the corpus). */
export interface LabScenarioBinding {
  /** The niche declaration (free-form, versioned with the scenario). */
  niche: string;
  /** The platform under simulation (the closed social-accounts platform vocabulary is resolved by LAB-005 — recorded here as declared data). */
  platform: string;
  /** The corpus reference (opaque version string owned by LAB-002 — 'pending' before the corpus exists). */
  corpusVersion: string;
  /** The world-model binding (opaque version reference owned by LAB-008 — 'pending' allowed). */
  worldModelVersion: string;
}

/**
 * A Lab Scenario: the frozen, versioned definition a Lab Run binds.
 * Corrections are NEW versions (scenarioVersion + 1) — never in-place
 * rewrites; each version row is append-only and immutable.
 */
export interface LabScenarioRecord {
  scenarioId: string;
  /** The immutable version number (starts at 1; corrections append). */
  scenarioVersion: number;
  agencyId: string;
  clientId: string;
  workspaceId: string | null;
  status: LabScenarioStatus;
  binding: LabScenarioBinding;
  reward: LabRewardDefinition;
  /** The default run configuration (per-run overrides must stay within these caps). */
  runConfiguration: LabRunConfiguration;
  contractVersion: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Lab Run (the Time-Machine run record — §10 verbatim field set).
// ---------------------------------------------------------------------------

/** The §23 operational caps of a run (exceeded → failed(budget_exceeded), honestly). */
export interface LabRunConfiguration {
  /** Maximum simulated steps (the simulator-loop cap, > 0). */
  maxSimulatedSteps: number;
  /** Maximum aggregate compute cost (abstract cost units, ≥ 0). */
  maxComputeCostUnits: number;
  /** Maximum wall-clock milliseconds the run may occupy in the durable worker (≥ 0). */
  maxWallClockMs: number;
}

/** The §10 run record fields (wall-clock/reference timestamps, simulated clock, observation cutoff, information lag, world-model version, random seeds). */
export interface LabRunTimeMachine {
  mode: LabRunMode;
  /** The reference (historical) period start — ISO 8601 UTC. */
  referenceStart: string;
  /** The reference (historical) period end — ISO 8601 UTC (≥ referenceStart). */
  referenceEnd: string;
  /** The simulated clock start (ISO 8601 UTC; defaults to referenceStart). */
  simulatedClockStart: string;
  /** The simulated clock end (ISO 8601 UTC; ≥ simulatedClockStart). */
  simulatedClockEnd: string;
  /**
   * The observation cutoff — the historical evidence boundary (ISO 8601
   * UTC). Historical replay may not read evidence observed after this
   * cutoff; counterfactual branches may not either (future-information
   * leakage fence, §10).
   */
  observationCutoff: string;
  /**
   * The information lag in minutes (≥ 0). At simulated time T the agent
   * only receives information available at or before T − lag. Zero means
   * no lag (pure historical replay).
   */
  informationLagMinutes: number;
  /** The world-model version the run executes against (opaque version reference). */
  worldModelVersion: string;
}

/** A Lab Run: the reproducible execution record. NEVER an Experiment (§3 — no FK, no authority transfer). */
export interface LabRunRecord {
  runId: string;
  scenarioId: string;
  /** The scenario version this run bound (immutable snapshot reference). */
  scenarioVersion: number;
  agencyId: string;
  clientId: string;
  workspaceId: string | null;
  status: LabRunStatus;
  /** The failure reason (present exactly when status = 'failed'). */
  failureReason: LabRunFailureReason | null;
  timeMachine: LabRunTimeMachine;
  seeds: LabSeedSet;
  configuration: LabRunConfiguration;
  /** The factuality label of the run's OUTCOMES (§3/§10 — ships on every read surface). */
  factuality: LabFactualityLabel;
  /** Per-run overrides recorded for reproducibility (bounded, within scenario caps). */
  configurationOverrides: Readonly<Record<string, number | string | boolean>> | null;
  /** Artifact lineage: the run's own output artifact references (opaque version strings owned by their producing modules). */
  outputArtifacts: ReadonlyArray<{ kind: string; version: string }> | null;
  contractVersion: string;
  createdAt: string;
  /** The last lifecycle transition timestamp. */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Strategy Candidate (§6/§7/§12 — never a Decision, §3).
// ---------------------------------------------------------------------------

/** A strategy candidate's action-space and lineage declaration (versioned data). */
export interface LabStrategyCandidateDeclaration {
  /** The action-space spec version (opaque; owned by the strategy layer modules). */
  actionSpaceVersion: string;
  /** The declared content-strategy actions (the §7 modality-agnostic vocabulary as data). */
  declaredActions: ReadonlyArray<string>;
  /** Parent candidate lineage (recombination/mutation — the §6 Idea Graph outputs, by candidate id). */
  parentCandidateIds: ReadonlyArray<string>;
  /** The idea-graph primitives consumed (opaque idea references — LAB-004 owns them). */
  ideaReferences: ReadonlyArray<{ kind: string; reference: string }>;
}

/**
 * An appended evaluation summary (LAB-008/009 write these as DATA after
 * runs complete; LAB-001 stores them append-only with their factuality
 * label — a simulated outcome is a model output, labeled as such).
 */
export interface LabCandidateEvaluationSummary {
  runId: string;
  /** Business reward per the versioned reward definition (§12). */
  reward: number;
  /** Uncertainty interval [low, high] (§13 — never a bare point estimate). */
  uncertaintyInterval: [number, number];
  /** Ensemble agreement/disagreement (§13). */
  ensembleAgreement: number;
  /** Out-of-distribution score (§13). */
  oodScore: number;
  /** Robustness across seeds (§20). */
  seedRobustness: number;
  /** The factuality label of the evaluated outcome. */
  factuality: LabFactualityLabel;
  /** The full metric block as versioned data (closed by the evaluating module). */
  metrics: Readonly<Record<string, number>>;
  evaluatedAt: string;
}

/** A Strategy Candidate: a candidate strategy for Lab evaluation. NEVER a Decision (§3). */
export interface LabStrategyCandidateRecord {
  candidateId: string;
  scenarioId: string;
  scenarioVersion: number;
  agencyId: string;
  clientId: string;
  workspaceId: string | null;
  status: LabCandidateStatus;
  declaration: LabStrategyCandidateDeclaration;
  /** Append-only evaluation summaries (newest last; never rewritten). */
  evaluations: ReadonlyArray<LabCandidateEvaluationSummary>;
  contractVersion: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Organization Candidate (§14/§15 — Agent Body graph as declared data).
// ---------------------------------------------------------------------------

/** The canonical single-agent generalist baseline (§15 mandate — the named constant organization search must include). */
export const LAB_SINGLE_AGENT_BASELINE_TOPOLOGY: LabOrganizationTopology = 'single_agent_baseline';

/** An organization candidate's graph declaration (Agent Bodies referenced by opaque body-version strings — LAB-011 owns the bodies). */
export interface LabOrganizationCandidateDeclaration {
  topology: LabOrganizationTopology;
  /** The agent-body version references (opaque; LAB-011 owns the registry). */
  agentBodyVersions: ReadonlyArray<string>;
  /** The declared communication/delegation edges (from-role → to-role, bounded data). */
  edges: ReadonlyArray<{ fromRole: string; toRole: string; kind: string }>;
  /** Shared vs private memory declarations per role (§15 search dimension). */
  memoryScopes: Readonly<Record<string, 'shared' | 'private'>>;
  /** Model assignments (opaque /ai-runtime model identities — the Lab never routes models itself, §14). */
  modelAssignments: Readonly<Record<string, string>>;
  /** Budget allocation per role (non-negative shares). */
  budgetAllocation: Readonly<Record<string, number>>;
}

/** An Agent Organization Candidate: a candidate organization for Lab evaluation (graph as versioned data). */
export interface LabOrganizationCandidateRecord {
  organizationCandidateId: string;
  scenarioId: string;
  scenarioVersion: number;
  agencyId: string;
  clientId: string;
  workspaceId: string | null;
  status: LabCandidateStatus;
  declaration: LabOrganizationCandidateDeclaration;
  evaluations: ReadonlyArray<LabCandidateEvaluationSummary>;
  contractVersion: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Capability Candidate (§16 — first-class executable contract as data).
// ---------------------------------------------------------------------------

/** A Capability Candidate: the §16 contract shape (the capability-gap flow starts here; LAB-013 owns the engine). */
export interface LabCapabilityCandidateRecord {
  capabilityCandidateId: string;
  agencyId: string;
  clientId: string;
  workspaceId: string | null;
  status: LabCapabilityStatus;
  /** The §16 contract fields as versioned data. */
  contract: {
    /** Input schema reference (opaque schema id + version). */
    inputSchemaRef: string;
    /** Output schema reference (opaque schema id + version). */
    outputSchemaRef: string;
    /** Declared constraints (bounded data). */
    constraints: ReadonlyArray<string>;
    /** The quality-evaluator reference (opaque). */
    qualityEvaluatorRef: string;
    /** Abstract cost (≥ 0 cost units). */
    costUnits: number;
    /** Latency bound (ms, ≥ 0). */
    latencyBoundMs: number;
    /** Provenance statement (the honest origin disclosure). */
    provenance: string;
    /** Simulator implementation reference (opaque; 'pending' when unimplemented). */
    simulatorImplementationRef: string;
    /** Real implementation reference (opaque; 'pending' when unimplemented). */
    realImplementationRef: string;
    /** Human/provider requirements (§16 — a capability may require an authentic human/provider artifact). */
    humanProviderRequirements: ReadonlyArray<string>;
  };
  contractVersion: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Calibration Record (§19 — prediction vs observation; append-only).
// ---------------------------------------------------------------------------

/**
 * A Calibration Record: one prediction-vs-observation pair with its
 * uncertainty, error, environment state, observed regime and the
 * calibration update that cites it. The real outcome is an OPAQUE
 * same-client external reference (READ-ONLY, never FK-joined — the Lab
 * cannot mutate or fabricate authority records; LAB-014's bridge is the
 * only real binding path).
 */
export interface LabCalibrationRecordRecord {
  calibrationRecordId: string;
  agencyId: string;
  clientId: string;
  workspaceId: string | null;
  status: LabCalibrationStatus;
  /** The world-model version whose prediction is being calibrated (opaque). */
  worldModelVersion: string;
  /** The strategy candidate whose prediction is calibrated (same-client reference). */
  strategyCandidateId: string;
  /** The Lab run that produced the prediction (same-client reference). */
  runId: string;
  /** The simulated prediction block (versioned data). */
  simulatedPrediction: {
    reward: number;
    uncertaintyInterval: [number, number];
    factuality: LabFactualityLabel;
    metrics: Readonly<Record<string, number>>;
  };
  /** The real-outcome anchor — an OPAQUE external reference (validated UUID; never joined). */
  realOutcome: {
    referenceKind: LabExternalReferenceKind;
    authority: 'experiments' | 'evidence' | 'metrics' | 'social-accounts';
    referenceId: string;
    outcomeSummary: Readonly<Record<string, number>>;
    observedAt: string;
  };
  /** The prediction error block (recorded as data — signed per metric). */
  predictionError: Readonly<Record<string, number>>;
  /** The environment state summary (bounded data). */
  environmentState: Readonly<Record<string, number | string>>;
  /** The observed regime (closed LAB_OBSERVED_REGIMES vocabulary). */
  observedRegime: LabObservedRegime;
  /** The calibration update/version that cites this record (opaque; 'pending' until applied). */
  calibrationUpdateVersion: string;
  contractVersion: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// World Model Version reference (§10/§13 — the citation shape).
// ---------------------------------------------------------------------------

/**
 * The WorldModelVersion REFERENCE contract: the versioned pointer that
 * run records and calibration records cite. The version REGISTRY is
 * owned by LAB-008's ensemble layer; LAB-001 records the citation shape
 * so runs can bind world-model versions from day one.
 */
export interface LabWorldModelVersionReference {
  /** The opaque world-model version string (e.g. 'wm-ensemble-v1-<hash>'). */
  version: string;
  /** The model family/kind label (recorded as data). */
  kind: string;
  /** The training corpus cutoff — the Time-Machine leakage fence anchor (ISO 8601 UTC). */
  trainingCutoff: string;
}

// ---------------------------------------------------------------------------
// The module ports (deps) and public API.
// ---------------------------------------------------------------------------

/** Module dependencies (platform ports only — the frozen /lab row consumes NO v1.6 authority module). */
export interface LabModuleDeps {
  db: Db;
  clock: Clock;
  ids: IdGenerator;
}

/** The scope every artifact is created/read under (the uniform NotFound for foreign scope — no existence oracle). */
export interface LabScope {
  agencyId: string;
  clientId: string;
  workspaceId?: string | null;
}

/** Scenario creation input (the version-1 record; the module assigns ids/versions/timestamps). */
export interface CreateLabScenarioInput {
  scope: LabScope;
  binding: LabScenarioBinding;
  reward: LabRewardDefinition;
  runConfiguration: LabRunConfiguration;
}

/** Run creation input (binds an ACTIVE scenario; records the full §10 field set + seeds). */
export interface CreateLabRunInput {
  scope: LabScope;
  scenarioId: string;
  timeMachine: LabRunTimeMachine;
  seeds: LabSeedSet;
  configurationOverrides?: Readonly<Record<string, number | string | boolean>> | null;
}

/** Strategy candidate creation input. */
export interface CreateLabStrategyCandidateInput {
  scope: LabScope;
  scenarioId: string;
  declaration: LabStrategyCandidateDeclaration;
}

/** Organization candidate creation input (the single-agent baseline is creatable directly — see LAB_SINGLE_AGENT_BASELINE_TOPOLOGY). */
export interface CreateLabOrganizationCandidateInput {
  scope: LabScope;
  scenarioId: string;
  declaration: LabOrganizationCandidateDeclaration;
}

/** Capability candidate creation input. */
export interface CreateLabCapabilityCandidateInput {
  scope: LabScope;
  contract: LabCapabilityCandidateRecord['contract'];
}

/** Calibration record creation input. */
export interface CreateLabCalibrationRecordInput {
  scope: LabScope;
  worldModelVersion: string;
  strategyCandidateId: string;
  runId: string;
  simulatedPrediction: LabCalibrationRecordRecord['simulatedPrediction'];
  realOutcome: LabCalibrationRecordRecord['realOutcome'];
  predictionError: Readonly<Record<string, number>>;
  environmentState: Readonly<Record<string, number | string>>;
  observedRegime: LabObservedRegime;
}

/** The /lab module public API — the frozen contract surface consumed by the later Lab modules (LAB-002..018) and the console bridges. */
export interface LabModuleApi {
  // --- Scenario lifecycle ---
  createScenario(input: CreateLabScenarioInput): Promise<LabScenarioRecord>;
  getScenario(scope: LabScope, scenarioId: string): Promise<LabScenarioRecord>;
  listScenarios(scope: LabScope): Promise<ReadonlyArray<LabScenarioRecord>>;
  /** Activates a DRAFT scenario (the frozen-at-run gate). */
  activateScenario(scope: LabScope, scenarioId: string): Promise<LabScenarioRecord>;
  /** Retires an ACTIVE scenario (new runs refused; existing runs keep their bound version). */
  retireScenario(scope: LabScope, scenarioId: string): Promise<LabScenarioRecord>;
  /** Appends a corrected scenario version (the append-only correction path — returns the NEW version record). */
  correctScenario(
    scope: LabScope,
    scenarioId: string,
    correction: { binding?: LabScenarioBinding; reward?: LabRewardDefinition; runConfiguration?: LabRunConfiguration },
  ): Promise<LabScenarioRecord>;

  // --- Run model (§23 lifecycle + reproducibility) ---
  createRun(input: CreateLabRunInput): Promise<LabRunRecord>;
  getRun(scope: LabScope, runId: string): Promise<LabRunRecord>;
  listRuns(scope: LabScope, scenarioId?: string): Promise<ReadonlyArray<LabRunRecord>>;
  /** Starts a QUEUED run (enforces the per-client active-run concurrency cap). */
  startRun(scope: LabScope, runId: string): Promise<LabRunRecord>;
  /** Pauses a RUNNING run (resumable — same seeds, same configuration). */
  pauseRun(scope: LabScope, runId: string): Promise<LabRunRecord>;
  /** Resumes a PAUSED run. */
  resumeRun(scope: LabScope, runId: string): Promise<LabRunRecord>;
  /** Completes a RUNNING run (records the output artifact lineage). */
  completeRun(scope: LabScope, runId: string, outputArtifacts: ReadonlyArray<{ kind: string; version: string }>): Promise<LabRunRecord>;
  /** Fails a run with the closed failure vocabulary. */
  failRun(scope: LabScope, runId: string, reason: LabRunFailureReason): Promise<LabRunRecord>;
  /** Cancels a QUEUED/RUNNING/PAUSED run (terminal). */
  cancelRun(scope: LabScope, runId: string): Promise<LabRunRecord>;

  // --- Candidates ---
  createStrategyCandidate(input: CreateLabStrategyCandidateInput): Promise<LabStrategyCandidateRecord>;
  getStrategyCandidate(scope: LabScope, candidateId: string): Promise<LabStrategyCandidateRecord>;
  listStrategyCandidates(scope: LabScope, scenarioId?: string): Promise<ReadonlyArray<LabStrategyCandidateRecord>>;
  /** Appends an evaluation summary (the append-only path — the candidate moves draft → evaluated). */
  appendStrategyCandidateEvaluation(scope: LabScope, candidateId: string, summary: LabCandidateEvaluationSummary): Promise<LabStrategyCandidateRecord>;
  /** Marks a candidate selected/rejected (Lab bookkeeping ONLY — the Decision Ledger is untouched, §3). */
  setStrategyCandidateStatus(scope: LabScope, candidateId: string, status: 'selected' | 'rejected'): Promise<LabStrategyCandidateRecord>;

  createOrganizationCandidate(input: CreateLabOrganizationCandidateInput): Promise<LabOrganizationCandidateRecord>;
  getOrganizationCandidate(scope: LabScope, organizationCandidateId: string): Promise<LabOrganizationCandidateRecord>;
  listOrganizationCandidates(scope: LabScope, scenarioId?: string): Promise<ReadonlyArray<LabOrganizationCandidateRecord>>;
  appendOrganizationCandidateEvaluation(scope: LabScope, organizationCandidateId: string, summary: LabCandidateEvaluationSummary): Promise<LabOrganizationCandidateRecord>;
  setOrganizationCandidateStatus(scope: LabScope, organizationCandidateId: string, status: 'selected' | 'rejected'): Promise<LabOrganizationCandidateRecord>;

  createCapabilityCandidate(input: CreateLabCapabilityCandidateInput): Promise<LabCapabilityCandidateRecord>;
  getCapabilityCandidate(scope: LabScope, capabilityCandidateId: string): Promise<LabCapabilityCandidateRecord>;
  listCapabilityCandidates(scope: LabScope): Promise<ReadonlyArray<LabCapabilityCandidateRecord>>;
  setCapabilityCandidateStatus(scope: LabScope, capabilityCandidateId: string, status: LabCapabilityStatus): Promise<LabCapabilityCandidateRecord>;

  createCalibrationRecord(input: CreateLabCalibrationRecordInput): Promise<LabCalibrationRecordRecord>;
  getCalibrationRecord(scope: LabScope, calibrationRecordId: string): Promise<LabCalibrationRecordRecord>;
  listCalibrationRecords(scope: LabScope, worldModelVersion?: string): Promise<ReadonlyArray<LabCalibrationRecordRecord>>;
  /** Marks a calibration record applied by a calibration update version (LAB-015's update cites it). */
  applyCalibrationRecord(scope: LabScope, calibrationRecordId: string, calibrationUpdateVersion: string): Promise<LabCalibrationRecordRecord>;
}

export { createLabModule } from './internal/lab-module.ts';
/**
 * The pure contract guards (seed discipline, Time-Machine field fences,
 * budget-cap validation, factuality labeling rules, reward-definition
 * validation) — exported for unit tests and the later Lab modules so the
 * CONTRACT semantics are part of the module surface. Pure functions: no
 * clock, no randomness, no network.
 */
export {
  assertValidLabSeedSet,
  assertValidLabRunTimeMachine,
  assertValidLabRunConfiguration,
  assertValidLabRewardDefinition,
  assertValidLabFactualityForMode,
  LAB_U64_MAX,
} from './internal/validation.ts';
