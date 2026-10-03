/**
 * MarketingOS module: /lab-simulator
 * Authority: Social Simulator Kernel (LAB-005 — spec/effective-backlog-v1.7.md
 * LAB-005: "Build configurable platform state, candidate generation,
 * exposure/ranking abstraction and content interaction loop.
 * Acceptance: deterministic seeded replay plus stochastic runs; no
 * invented hidden provider state."; dependencies satisfied: LAB-001
 * (merged — the /lab contracts/run model whose seed + factuality
 * vocabularies this module aligns with BY DATA, never by import) and
 * LAB-003 (merged — the /lab-features feature bundles whose citations
 * the simulated content universe carries as OPAQUE recorded data);
 * spec/architecture-v1.7-marketing-lab.md §8 "Social World Model"
 * (THE frozen contract: the configurable world model — content
 * universe; user population; user preferences/interests; user session
 * state; fatigue/repetition response; candidate generation;
 * ranking/exposure; recommendation behavior; creator competition;
 * topic trends; temporal effects; freshness; novelty; account state;
 * observable platform constraints; API/publishing constraints where
 * relevant; business/product conversion behavior where relevant; "The
 * simulator targets observable behavior, not reproduction of a
 * platform's private implementation. Hidden provider
 * moderation/ranking details MUST NOT be invented as factual claims.")
 * and §9 "User and creator dynamics" (the interacting actors —
 * viewers/consumers, the simulated MOS-operated account, competing
 * creators/content sources, the platform recommender/exposure system;
 * "The response of a user or market actor is stochastic and stateful.
 * A simulator run MUST be able to reproduce a trajectory given a
 * recorded seed/configuration, while supporting stochastic ensembles
 * for uncertainty estimation.") and §13 "Uncertainty and simulator
 * ensembles" ("A single learned simulator MUST NOT be treated as
 * ground truth"; "agreement/disagreement across the ensemble is
 * recorded") and §12 (the reward INPUTS the simulator exposes — the
 * raw business-outcome metrics, never a silently substituted vanity
 * metric) and §22 multi-tenancy; AGENTS.md v1.7 "Simulator calibration
 * cannot rewrite historical observations", "Ensemble, OOD and
 * robustness checks precede real deployment"; docs/handoff/
 * WORKER-CONTRACT.md "Simulator state is versioned and
 * reproducible", "Simulator cannot be treated as ground truth";
 * architecture-lock-v1.7 (the versioned/reproducible-simulator
 * discipline).
 *
 * THE SIMULATOR KERNEL (LAB-005's frozen scope):
 *
 *   - THE WORLD-MODEL CONFIGURATION (the closed vocabulary of
 *     world-model knobs, versioned, immutable once instantiated): the
 *     declared topic space shape, the user population and its segment
 *     distributions with per-segment topic affinities, the stochastic
 *     session rates, the fatigue/repetition parameters, the
 *     ranking/exposure curve parameters (THE DECLARED MODELING
 *     ASSUMPTION — never a provider fact), the trend/temporal
 *     parameters with seasonality, the freshness half-life, the
 *     novelty bias, the creator-competition parameters, the account
 *     state, the business/product conversion parameters and the
 *     observable platform + API/publishing constraints. Every knob is
 *     DECLARED DATA carried with its world-model version — never an
 *     ambient global. The deterministic configuration digest (SHA-256
 *     over the canonical JSON of the knob set + the pinned versions)
 *     is the idempotence fence: the same knobs are the same
 *     configuration, ever.
 *   - THE SEED RECORDS: the recorded seed + configuration pair that
 *     reproduces a trajectory exactly — the master seed (an unsigned
 *     64-bit integer as a decimal string), the derived-seed lineage
 *     (the per-subsystem seeds with their derivation labels) and the
 *     cited configuration. The RNG is the DECLARED seeded generator
 *     (identity 'lab-simulator-splitmix64' + version 'lab-sim-rng-v1',
 *     both recorded on the configuration and echoed on the seed).
 *   - THE RUN RECORDS: a simulator run born 'running' with the single
 *     completion advance per the house discipline, carrying its seed
 *     citation, its configuration citation, its engine version, the
 *     factuality label ('simulated_model_output' — the LAB-001
 *     vocabulary, BY DATA: a simulated outcome is never presented as an
 *     observed fact), the bounded step budget, the caller-declared
 *     publishing plan (validated against the world model's declared
 *     API/publishing constraints) and the opaque content-universe
 *     citations; the summary totals are SQL-COMPUTED from the step
 *     rows at the completion advance, never asserted separately.
 *   - THE STEP/TRAJECTORY RECORDS: the recorded interaction loop
 *     steps — the candidates surfaced, the exposure decisions (the
 *     declared ranking model applied), the user interactions with
 *     their stochastic outcomes, the competitor posts, the topic-trend
 *     state — every step APPEND-ONLY with its deterministic step
 *     digest (SHA-256 over the canonical step content), and the
 *     trajectory digest (SHA-256 over the ordered step-digest chain)
 *     recorded at completion.
 *   - THE OBSERVABLE-STATE SNAPSHOTS: what the simulated agent could
 *     observe at each step — the observable/hidden split made
 *     structural. The snapshot carries ONLY observable surfaces (the
 *     exposure outcomes, the interaction counts, the account-state
 *     effects the platform would show); the world model's internals
 *     (fatigue state, trend internals, the ranking scores) and ANY
 *     provider hidden moderation/ranking detail are NEVER materialized
 *     as factual claims — the exposure decisions are labeled with the
 *     declared world-model-assumption marker, never presented as the
 *     provider's actual algorithm.
 *   - DETERMINISTIC SEEDED REPLAY (the core acceptance, structural):
 *     the simulator core is a PURE function of (seed, configuration,
 *     the interaction history) — the same inputs always produce the
 *     same trajectory, step-for-step. A replay run cites the original
 *     run's seed + configuration and carries the recorded
 *     deterministic-replay flag; the module verifies the reproduction
 *     BEFORE any row exists (the step digests compared step-for-step)
 *     and records replayVerified on the completed replay.
 *   - THE STOCHASTIC ENSEMBLE (§13): a family of runs over sampled
 *     seeds/configurations for uncertainty estimation — the member
 *     seeds derived deterministically from the ensemble's own seed,
 *     the member configurations drawn from the caller-declared
 *     configuration space. The ensemble's agreement/disagreement over
 *     the declared outcome metric is SQL-COMPUTED at the single
 *     completion advance; an ensemble of ONE is structurally
 *     inexpressible (a single run is never ground truth).
 *
 * THE CONTENT-UNIVERSE CITATION (the /lab family by-reference
 * discipline): the simulated content universe cites /lab-features
 * feature bundles or /lab-ideas nodes OPAQUELY — the citation kind,
 * the citable reference, the recorded owning client and the caller's
 * declared simulation attributes (the topic from the configuration's
 * declared topic space + the quality). There is NO import of /lab-features
 * or /lab-ideas or /lab here and NO /lab, /lab-features or
 * /lab-ideas table is ever read or written by this module (the
 * frozen v1.7 no-cross-module-dependency discipline of the /lab
 * family).
 *
 * What it is NOT (the bounded scope):
 *
 *   - NO hidden provider state: no moderation/reputation/internal
 *     ranking model of any real platform is modeled as a factual
 *     claim. The exposure/ranking step is a DECLARED world-model
 *     assumption (an explicit modeling choice recorded on the
 *     configuration and labeled on every exposure decision); the
 *     simulator targets OBSERVABLE behavior only.
 *   - NO learned response model: LAB-005 ships the deterministic
 *     KERNEL (the configurable world model + the seeded interaction
 *     loop); the calibrated user/creator dynamics are LAB-006, the
 *     time machine is LAB-007, the trained ensembles are LAB-008.
 *   - NO reward authority: the run summary exposes the RAW §12 reward
 *     inputs (views/engagements/shares/clicks/conversions/revenue/
 *     followers); the mission-specific reward function stays /lab's
 *     versioned contract.
 *   - NO shadowing: no Experiment/Decision/Evidence/Metric/
 *     Publication/Workflow/Execution record is created here; the FK
 *     anchors are exactly the tenant tables + same-module rows.
 *
 * Cross-module access may only target this public entry (public.ts) —
 * internal/ is unimportable from other modules (enforced by the
 * static architecture checker, tools/arch-check).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import type { Db } from '../../platform/db/contract.ts';

// ---------------------------------------------------------------------------
// The frozen vocabularies (CHECK-fenced in migration 071 — closed sets).
// ---------------------------------------------------------------------------

/** The contract vocabulary version of every simulator artifact (the LAB-001 'lab-contract-v1' discipline). */
export const LAB_SIMULATOR_CONTRACT_VERSION = 'lab-simulator-contract-v1' as const;

/** The world-model knob-set schema version (the closed vocabulary of declared world-model knobs). */
export const LAB_SIMULATOR_WORLD_MODEL_VERSION = 'lab-worldmodel-v1' as const;

/** The deterministic interaction-loop engine version (the frozen loop formula identity — replays cross-check against it). */
export const LAB_SIMULATOR_ENGINE_VERSION = 'lab-sim-engine-v1' as const;

/** The declared seeded generator identity (recorded on every configuration — the RNG is part of the reproducibility contract). */
export const LAB_SIMULATOR_RNG_ID = 'lab-simulator-splitmix64' as const;

/** The declared seeded generator version (splitmix64 — the pure deterministic stream). */
export const LAB_SIMULATOR_RNG_VERSION = 'lab-sim-rng-v1' as const;

/**
 * THE MODELING BASIS (the no-invented-hidden-state discipline, made
 * structural): every world-model configuration row is labeled with
 * exactly this basis — the knobs are EXPLICIT DECLARED MODELING
 * ASSUMPTIONS targeting observable behavior, never claims about any
 * provider's actual algorithm or hidden moderation/ranking internals.
 */
export const LAB_SIMULATOR_MODELING_BASIS = 'declared_world_model_assumptions' as const;

/** The full disclosure string shipped on every configuration read surface. */
export const LAB_SIMULATOR_RANKING_DISCLOSURE =
  "The ranking/exposure parameters are DECLARED world-model configuration — explicit modeling assumptions targeting observable behavior. They are NOT claims about any provider's actual algorithm; no hidden provider moderation/ranking state is modeled as a factual claim." as const;

/**
 * The factuality label of every simulator run (the LAB-001 closed
 * vocabulary, recorded BY DATA — no import of /lab): a simulated
 * outcome is a model output and is labeled as such on every read
 * surface; it can never be presented as an observed fact.
 */
export const LAB_SIMULATOR_FACTUALITY = 'simulated_model_output' as const;

/** The closed universe-citation kind vocabulary (the /lab family by-reference discipline). */
export const LAB_SIMULATOR_CITATION_KINDS = ['lab-features-bundle', 'lab-ideas-node'] as const;
export type LabSimulatorCitationKind = (typeof LAB_SIMULATOR_CITATION_KINDS)[number];

/** The closed derived-seed label vocabulary (the per-subsystem RNG streams, in the engine's fixed consumption order). */
export const LAB_SIMULATOR_RNG_LABELS = [
  'user-sessions',
  'competition',
  'trends',
  'ranking',
  'interactions',
] as const;
export type LabSimulatorRngLabel = (typeof LAB_SIMULATOR_RNG_LABELS)[number];

/**
 * The closed outcome-metric vocabulary (the §12 reward inputs the
 * simulator exposes — the ensemble's agreement is measured over one
 * declared member of this set; 'conversions' is the default because
 * the reward discipline is business-outcome-first).
 */
export const LAB_SIMULATOR_OUTCOME_METRICS = [
  'impressions',
  'views',
  'engagements',
  'shares',
  'clicks',
  'conversions',
  'followers_gained',
] as const;
export type LabSimulatorOutcomeMetric = (typeof LAB_SIMULATOR_OUTCOME_METRICS)[number];

/** The default ensemble outcome metric (the business-outcome-first discipline). */
export const LAB_SIMULATOR_DEFAULT_OUTCOME_METRIC: LabSimulatorOutcomeMetric = 'conversions';

/** The upper bound of simulated steps per run (the bounded interaction loop). */
export const LAB_SIMULATOR_MAX_STEPS = 1000;

/** The upper bound of items in a run's cited content universe. */
export const LAB_SIMULATOR_MAX_UNIVERSE_ITEMS = 64;

/** The upper bound of entries in a run's publishing plan. */
export const LAB_SIMULATOR_MAX_PLAN_ENTRIES = 512;

/** The upper bound of versions per configuration chain (the append-only correction chain fence). */
export const LAB_SIMULATOR_MAX_CONFIG_VERSIONS = 1000;

/** The minimum ensemble member count (§13: an ensemble of ONE is structurally inexpressible — a single run is never ground truth). */
export const LAB_SIMULATOR_MIN_ENSEMBLE_MEMBERS = 2;

/** The maximum ensemble member count (the bounded ensemble). */
export const LAB_SIMULATOR_MAX_ENSEMBLE_MEMBERS = 32;

/** The maximum distinct configurations an ensemble samples over (the declared configuration space). */
export const LAB_SIMULATOR_MAX_ENSEMBLE_CONFIGS = 8;

// ---------------------------------------------------------------------------
// THE WORLD-MODEL KNOBS (the closed vocabulary — §8 verbatim coverage).
// ---------------------------------------------------------------------------

/** One declared topic of the topic space (the preference/topic space shape). */
export interface LabSimulatorTopicDeclaration {
  /** The topic name (1-64 chars, distinct within the configuration). */
  name: string;
  /** The baseline interest in the topic (0..1 — the trend mean-reversion target). */
  baselineInterest: number;
}

/** One user-population segment (the declared distributions of the user population). */
export interface LabSimulatorPopulationSegment {
  /** The segment name (1-64 chars, distinct within the configuration). */
  name: string;
  /** The segment's share of the user population (0..1; the shares sum to 1). */
  share: number;
  /** The expected sessions per step per user in the segment (0..1000 — the stochastic session-rate mean). */
  sessionRatePerStep: number;
  /** The segment's affinity per topic (−1..1) — the keys must cover the configuration's topics exactly. */
  affinity: Readonly<Record<string, number>>;
}

/** The full world-model knob set (every knob DECLARED DATA under LAB_SIMULATOR_WORLD_MODEL_VERSION). */
export interface LabSimulatorWorldKnobs {
  /** The user population (§8 user population + user session state): the declared size + segment distributions. */
  population: {
    /** The simulated user population size (1..10,000,000). */
    totalUsers: number;
    /** The population segments (1..16). */
    segments: ReadonlyArray<LabSimulatorPopulationSegment>;
  };
  /** The preference/topic space shape (§8 user preferences/interests + topic trends baseline): the declared topics (1..32). */
  topics: ReadonlyArray<LabSimulatorTopicDeclaration>;
  /** The fatigue/repetition response (§8): the stateful per-(segment, topic) accumulation. */
  fatigue: {
    /** The fatigue added per step per exposed account item of the topic (0..1). */
    incrementPerExposure: number;
    /** The multiplicative fatigue decay per step (0..1). */
    decayPerStep: number;
    /** The view-probability penalty at saturated fatigue (0..1). */
    responsePenalty: number;
  };
  /**
   * The ranking/exposure curve (§8 ranking/exposure + recommendation
   * behavior) — THE DECLARED MODELING ASSUMPTION (never a provider
   * fact; see LAB_SIMULATOR_RANKING_DISCLOSURE).
   */
  ranking: {
    /** The exposure share weight of the first feed position (0..1). */
    exposureTopWeight: number;
    /** The position decay power of the exposure curve (0..10). */
    exposureDecayPower: number;
    /** The exploration rate — the probability a tail candidate is promoted per step (0..1). */
    explorationRate: number;
    /** The candidate pool size bound (1..64 — the candidate generation step). */
    candidatePoolSize: number;
  };
  /** The trend/temporal parameters (§8 topic trends + temporal effects): the stateful trend dynamics. */
  trends: {
    /** The trend noise magnitude per step (0..1). */
    volatility: number;
    /** The trend persistence — the share of the prior trend kept per step (0..1). */
    persistence: number;
    /** The seasonal modulation amplitude of the baseline (0..1). */
    seasonalityAmplitude: number;
    /** The seasonality period in steps (1..10,000). */
    seasonalityPeriodSteps: number;
  };
  /** The freshness decay (§8 freshness): the content half-life. */
  freshness: {
    /** The freshness half-life in steps (1..10,000). */
    halfLifeSteps: number;
  };
  /** The novelty response (§8 novelty): the population's preference for unseen content. */
  novelty: {
    /** The novelty bias added to the view probability per fresh exposure (0..1). */
    noveltyBias: number;
  };
  /** The creator competition (§9 competing creators/content sources): the competing-post stream. */
  competition: {
    /** The number of distinct competing creators (0..1,000). */
    competitorCount: number;
    /** The competitor post quality mean (0..1). */
    competitorQualityMean: number;
    /** The competitor post quality jitter magnitude (0..1). */
    competitorQualitySigma: number;
    /** The competitor posts per step (0..100 — the declared crowd-out rate). */
    competitorPostsPerStep: number;
  };
  /** The simulated MOS-operated account state (§9). */
  account: {
    /** The initial follower count (0..10,000,000). */
    initialFollowers: number;
    /** The followers gained per engagement+share (0..1). */
    followerGainPerEngagement: number;
  };
  /** The business/product conversion behavior (§8 where relevant): the view → click → convert chain. */
  conversion: {
    /** The per-view click probability base (0..1). */
    viewToClickProbability: number;
    /** The per-click conversion probability (0..1). */
    clickToConversionProbability: number;
    /** The value of one conversion (0..1,000,000). */
    conversionValue: number;
  };
  /** The observable platform + API/publishing constraints (§8): enforced on every publishing plan. */
  constraints: {
    /** The maximum account posts per step the platform accepts (1..64). */
    maxAccountPostsPerStep: number;
    /** The minimum steps between the account's consecutive posts (0..100). */
    minStepsBetweenPosts: number;
  };
  /** The user interaction response model (§9 — stochastic and stateful). */
  interaction: {
    /** The base per-exposure view probability (0..1). */
    baseViewProbability: number;
    /** The per-view engagement probability base (0..1). */
    engagePerViewProbability: number;
    /** The per-engagement share probability base (0..1). */
    sharePerEngageProbability: number;
    /** The quality sensitivity of the response (0..1). */
    qualitySensitivity: number;
  };
}

// ---------------------------------------------------------------------------
// The content-universe citation (the /lab family by-reference discipline).
// ---------------------------------------------------------------------------

/**
 * One cited content item of the simulated content universe: an OPAQUE
 * reference to a /lab-features feature bundle or a /lab-ideas node,
 * copied by the caller from those modules' public surfaces (recorded
 * data — never a join), plus the caller's DECLARED simulation
 * attributes (the topic from the configuration's declared topic
 * space + the quality). The declared attributes are the CALLER's
 * modeling input — they are never claims about the cited artifact's
 * actual platform performance.
 */
export interface LabSimulatorUniverseItemCitation {
  /** The closed citation kind (a /lab-features bundle or a /lab-ideas node). */
  citationKind: LabSimulatorCitationKind;
  /**
   * The opaque citable reference — '<bundleId>#v<n>' for feature
   * bundles, the node id for idea nodes (recorded data, never
   * joined).
   */
  reference: string;
  /** The owning client of the cited artifact AS RECORDED at citation time (the recorded-data tenant fence). */
  recordedClientId: string;
  /** The declared simulation topic — MUST be one of the cited configuration's declared topics. */
  topic: string;
  /** The declared simulation quality (0..1). */
  quality: number;
}

/** One caller-declared publish action of a run's publishing plan (the strategy under simulation, as data). */
export interface LabSimulatorPublishAction {
  /** The universe item index to publish (0..universe.length-1). */
  itemIndex: number;
  /** The 1-based step at which the item publishes (1..stepBudget; the item is live from that step onward). */
  atStep: number;
}

// ---------------------------------------------------------------------------
// The records (the public read shapes).
// ---------------------------------------------------------------------------

/** A WORLD-MODEL CONFIGURATION record: the versioned, immutable knob set. */
export interface LabSimulatorWorldConfigRecord {
  configId: string;
  /** The append-only chain position (starts at 1; a changed knob set is a NEW version row, never a rewrite). */
  configVersion: number;
  worldModelVersion: string;
  rngId: string;
  rngVersion: string;
  /** THE DECLARED KNOBS (the closed vocabulary under the world-model version). */
  knobs: Readonly<LabSimulatorWorldKnobs>;
  /** The deterministic configuration digest (SHA-256 over the canonical JSON of the knob set + the pinned versions) — the idempotence fence. */
  configDigest: string;
  /** The modeling basis label (structurally CHECK-fenced — the no-invented-hidden-state discipline). */
  modelingBasis: typeof LAB_SIMULATOR_MODELING_BASIS;
  agencyId: string;
  clientId: string;
  workspaceId: string | null;
  contractVersion: string;
  createdAt: string;
}

/** A SEED record: the recorded seed + configuration pair that reproduces a trajectory exactly. */
export interface LabSimulatorSeedRecord {
  seedId: string;
  /** The master seed — the decimal string of an unsigned 64-bit integer [0, 2^64). */
  masterSeed: string;
  /** The derived-seed lineage (one entry per RNG label — the complete reproducibility input). */
  derived: ReadonlyArray<{ label: LabSimulatorRngLabel; seed: string }>;
  /** The cited configuration (the seed's pair — FK-anchored same-module). */
  configId: string;
  configVersion: number;
  /** The cited configuration's digest echo (the recorded linkage data). */
  configDigest: string;
  /** The deterministic seed digest (SHA-256 over the canonical JSON of masterSeed + configDigest) — the idempotence fence. */
  seedDigest: string;
  agencyId: string;
  clientId: string;
  workspaceId: string | null;
  contractVersion: string;
  createdAt: string;
}

/** A RUN record: one simulator run (born running; the single completion advance). */
export interface LabSimulatorRunRecord {
  runId: string;
  status: 'running' | 'completed';
  seedId: string;
  /** The configuration citation (FK-anchored same-module; must equal the seed's configuration). */
  configId: string;
  configVersion: number;
  configDigest: string;
  /** The engine version that produced the trajectory (the replay cross-check). */
  engineVersion: string;
  /** The factuality label (LAB-001 vocabulary, BY DATA — a simulated outcome is never an observed fact). */
  factuality: typeof LAB_SIMULATOR_FACTUALITY;
  /** The deterministic-replay flag (a replay cites the original run's seed + configuration and reproduces its trajectory). */
  deterministicReplay: boolean;
  /** The original run this replay reproduces (non-null ⟺ deterministicReplay). */
  replayOfRunId: string | null;
  /** The recorded reproduction proof (non-null ⟺ deterministicReplay; the step digests matched step-for-step). */
  replayVerified: boolean | null;
  /** The bounded interaction-loop budget (1..LAB_SIMULATOR_MAX_STEPS). */
  stepBudget: number;
  /** The caller-declared publishing plan (part of the reproducibility input; validated against the declared constraints). */
  publishingPlan: ReadonlyArray<LabSimulatorPublishAction>;
  /** The opaque content-universe citations (part of the reproducibility input). */
  contentUniverse: ReadonlyArray<LabSimulatorUniverseItemCitation>;
  // --- The SQL-computed summary (at the single completion advance; honestly zero while running) ---
  stepCount: number;
  totalImpressions: number;
  totalViews: number;
  totalEngagements: number;
  totalShares: number;
  totalClicks: number;
  totalConversions: number;
  totalRevenue: number;
  totalFollowersGained: number;
  /** The trajectory digest (SHA-256 over the ordered step-digest chain; recorded at completion). */
  trajectoryDigest: string | null;
  agencyId: string;
  clientId: string;
  workspaceId: string | null;
  contractVersion: string;
  createdAt: string;
  updatedAt: string;
}

/** One surfaced candidate of a step's candidate-generation phase (the audit trail). */
export interface LabSimulatorStepCandidate {
  itemId: string;
  source: 'account' | 'competitor';
  topic: string;
  quality: number;
  ageSteps: number;
  /** The candidate-generation score (the declared freshness × quality × trend pre-score). */
  candidateScore: number;
}

/** One exposure decision of a step's exposure/ranking phase (the audit trail — the DECLARED modeling assumption). */
export interface LabSimulatorExposureDecision {
  itemId: string;
  source: 'account' | 'competitor';
  position: number;
  /** The normalized exposure share of the step's sessions (4dp). */
  exposureShare: number;
  /** The impressions the position yields (the segment-summed sessions × the share). */
  impressions: number;
  /** The declared-modeling-assumption marker (never a provider fact). */
  rankingModel: typeof LAB_SIMULATOR_MODELING_BASIS;
}

/** One segment's stochastic interaction outcome over the account's exposed items (the audit trail). */
export interface LabSimulatorSegmentInteractions {
  segment: string;
  sessions: number;
  views: number;
  skips: number;
  engagements: number;
  shares: number;
  clicks: number;
  conversions: number;
  revenue: number;
  followersGained: number;
}

/** One competitor post of a step (the competing creators/content sources). */
export interface LabSimulatorCompetitorPost {
  itemId: string;
  competitorIndex: number;
  topic: string;
  quality: number;
}

/** A STEP/TRAJECTORY record: one recorded interaction-loop step (append-only, with its deterministic digest). */
export interface LabSimulatorStepRecord {
  stepId: string;
  runId: string;
  /** The 1-based step position (append-only order). */
  seq: number;
  candidates: ReadonlyArray<LabSimulatorStepCandidate>;
  exposure: ReadonlyArray<LabSimulatorExposureDecision>;
  interactions: ReadonlyArray<LabSimulatorSegmentInteractions>;
  competitorPosts: ReadonlyArray<LabSimulatorCompetitorPost>;
  /** The topic-trend state after the step (the declared trend dynamics — simulation internals, audit only). */
  topicTrends: Readonly<Record<string, number>>;
  // --- The flat metrics (the step's aggregate observable outcomes) ---
  impressions: number;
  views: number;
  engagements: number;
  shares: number;
  clicks: number;
  conversions: number;
  revenue: number;
  followersGained: number;
  competitorPostCount: number;
  /** The deterministic step digest (SHA-256 over the canonical step content). */
  stepDigest: string;
  agencyId: string;
  clientId: string;
  workspaceId: string | null;
  contractVersion: string;
  createdAt: string;
}

/**
 * An OBSERVABLE-STATE snapshot record: what the simulated agent could
 * observe at each step — the observable/hidden split, structural. The
 * snapshot carries ONLY observable surfaces (the feed positions, the
 * impression/view/engagement counts, the account-state effects the
 * platform would show); the world model's internals and ANY provider
 * hidden moderation/ranking detail appear nowhere in it.
 */
export interface LabSimulatorObservableSnapshotRecord {
  snapshotId: string;
  runId: string;
  seq: number;
  /** The observable state (the factuality label + the aggregate counts + the account state + the per-post analytics the platform would show). */
  observableState: Readonly<Record<string, unknown>>;
  /** The deterministic observable digest (SHA-256 over the canonical observable projection). */
  observableDigest: string;
  agencyId: string;
  clientId: string;
  workspaceId: string | null;
  contractVersion: string;
  createdAt: string;
}

/** An ENSEMBLE MEMBER record: one sampled member run of an ensemble (append-only). */
export interface LabSimulatorEnsembleMemberRecord {
  memberId: string;
  ensembleId: string;
  runId: string;
  /** The 1-based member position (deterministic order). */
  seq: number;
  /** The member's sampled NEW seed (derived deterministically from the ensemble seed). */
  memberSeed: string;
  /** The member's configuration citation (drawn from the ensemble's declared configuration space). */
  configId: string;
  configVersion: number;
  agencyId: string;
  clientId: string;
  workspaceId: string | null;
  contractVersion: string;
  createdAt: string;
}

/**
 * An ENSEMBLE record: a family of runs over sampled seeds/configurations
 * for uncertainty estimation (§13) — a single run is never ground
 * truth; the agreement/disagreement over the declared outcome metric
 * is SQL-computed at the single completion advance.
 */
export interface LabSimulatorEnsembleRecord {
  ensembleId: string;
  status: 'running' | 'completed';
  memberCount: number;
  /** The ensemble's own seed — the member seeds derive deterministically from it. */
  ensembleSeed: string;
  /** The declared outcome metric the agreement is measured over (the closed §12 reward-input vocabulary). */
  outcomeMetric: LabSimulatorOutcomeMetric;
  /** The declared configuration space the members sample over (1..8 citations). */
  configCitations: ReadonlyArray<{ configId: string; configVersion: number }>;
  // --- The SQL-computed uncertainty summary (at the single completion advance) ---
  meanOutcome: number;
  minOutcome: number;
  maxOutcome: number;
  /** The agreement fraction — the majority side of the mean (1 = full agreement; ≥ 0.5 by construction). */
  agreementFraction: number;
  /** The disagreement fraction (1 − agreement). */
  disagreementFraction: number;
  agencyId: string;
  clientId: string;
  workspaceId: string | null;
  contractVersion: string;
  createdAt: string;
  updatedAt: string;
  /** The member tail (carried on reads). */
  members: ReadonlyArray<LabSimulatorEnsembleMemberRecord>;
}

// ---------------------------------------------------------------------------
// The module API inputs.
// ---------------------------------------------------------------------------

/** The scope every simulator artifact is created/read under (the uniform NotFound for foreign/unknown scope — no existence oracle). */
export interface LabSimulatorScope {
  agencyId: string;
  clientId: string;
  workspaceId?: string | null;
}

/** The world-model configuration creation input. */
export interface CreateLabSimulatorWorldConfigInput {
  scope: LabSimulatorScope;
  /** The full declared knob set (validated against the closed vocabulary). */
  knobs: LabSimulatorWorldKnobs;
  /** Optional: the existing configId whose chain this configuration version extends (absent = a fresh chain at version 1). */
  configId?: string | undefined;
}

/** The seed creation input: the recorded seed + configuration pair. */
export interface CreateLabSimulatorSeedInput {
  scope: LabSimulatorScope;
  /** The master seed — the decimal string of an unsigned 64-bit integer [0, 2^64). */
  masterSeed: string;
  /** The cited configuration. */
  configId: string;
  configVersion: number;
}

/** The simulation run input (a NEW run over the cited seed + configuration). */
export interface RunLabSimulationInput {
  scope: LabSimulatorScope;
  /** The cited seed record (the seed + configuration pair that reproduces the trajectory). */
  seedId: string;
  /** The bounded step budget (1..LAB_SIMULATOR_MAX_STEPS). */
  stepBudget: number;
  /** The caller-declared publishing plan (validated against the configuration's declared API/publishing constraints). */
  publishingPlan: ReadonlyArray<LabSimulatorPublishAction>;
  /** The cited content universe (1..LAB_SIMULATOR_MAX_UNIVERSE_ITEMS opaque citations). */
  contentUniverse: ReadonlyArray<LabSimulatorUniverseItemCitation>;
}

/** The deterministic replay input: cite the original run; the replay copies its seed + configuration + plan + universe and reproduces its trajectory. */
export interface CreateLabSimulatorReplayRunInput {
  scope: LabSimulatorScope;
  /** The completed run whose trajectory is reproduced. */
  runId: string;
}

/** The stochastic ensemble input (§13): the member seeds sample NEW seeds over the declared configuration space. */
export interface CreateLabSimulatorEnsembleInput {
  scope: LabSimulatorScope;
  /**
   * The ensemble's own seed (the decimal u64 the member seeds derive
   * from). Absent = a fresh module-generated seed (recorded on the
   * ensemble row — the sampling is reproducible from the record).
   */
  ensembleSeed?: string | undefined;
  /** The member count (2..LAB_SIMULATOR_MAX_ENSEMBLE_MEMBERS — an ensemble of ONE is inexpressible). */
  memberCount: number;
  /** The declared configuration space the members sample over (1..8 citations; member i draws citations[i mod n]). */
  configCitations: ReadonlyArray<{ configId: string; configVersion: number }>;
  /** The declared outcome metric the agreement is measured over (defaults to 'conversions' — business-outcome-first). */
  outcomeMetric?: LabSimulatorOutcomeMetric | undefined;
  /** The shared member run inputs. */
  stepBudget: number;
  publishingPlan: ReadonlyArray<LabSimulatorPublishAction>;
  contentUniverse: ReadonlyArray<LabSimulatorUniverseItemCitation>;
}

// ---------------------------------------------------------------------------
// The module ports (deps) and public API.
// ---------------------------------------------------------------------------

/** Module dependencies (platform ports only — the frozen /lab-simulator row consumes NO other module). */
export interface LabSimulatorModuleDeps {
  db: Db;
  clock: Clock;
  ids: IdGenerator;
}

/** The /lab-simulator module public API — the Social Simulator Kernel surface consumed by the later Lab layers (LAB-006/007/008/009/010, the TL's integrations) BY REFERENCE. */
export interface LabSimulatorModuleApi {
  /**
   * THE WORLD-MODEL CONFIGURATION ENTRY: creates (idempotently — the
   * deterministic digest fence) the versioned, immutable knob set. A
   * changed knob set is a NEW configuration version row on the cited
   * chain, never an in-place rewrite; an identical knob set returns
   * the existing configuration.
   */
  createWorldConfig(input: CreateLabSimulatorWorldConfigInput): Promise<LabSimulatorWorldConfigRecord>;

  /** Reads one configuration (optionally at an explicit version; default = the latest) — the uniform NotFound for foreign/unknown scope. */
  getWorldConfig(scope: LabSimulatorScope, configId: string, configVersion?: number): Promise<LabSimulatorWorldConfigRecord>;

  /** Lists the client's configuration chains (the latest version of each chain, newest first). */
  listWorldConfigs(scope: LabSimulatorScope): Promise<ReadonlyArray<LabSimulatorWorldConfigRecord>>;

  /**
   * THE SEED ENTRY: records the seed + configuration pair
   * (idempotently — the deterministic seed digest fence). The derived
   * per-subsystem seed lineage is computed deterministically from the
   * declared RNG and recorded on the row — the complete
   * reproducibility input.
   */
  createSeed(input: CreateLabSimulatorSeedInput): Promise<LabSimulatorSeedRecord>;

  /** Reads one seed record — the uniform NotFound for foreign/unknown scope. */
  getSeed(scope: LabSimulatorScope, seedId: string): Promise<LabSimulatorSeedRecord>;

  /**
   * THE SIMULATION RUN ENTRY: executes the bounded interaction loop
   * (candidate generation → exposure/ranking → user interaction
   * sampling → observable feedback) over the cited seed +
   * configuration, and lands the run + its steps + its observable
   * snapshots in ONE atomic write (born running → the tail rows → the
   * single completion advance with the summary SQL-computed from the
   * step rows).
   */
  runSimulation(input: RunLabSimulationInput): Promise<LabSimulatorRunRecord>;

  /**
   * THE DETERMINISTIC REPLAY ENTRY (the core acceptance): cites the
   * original run's seed + configuration (+ plan + universe), re-runs
   * the pure engine and verifies the trajectory step-for-step (every
   * step digest + observable digest) BEFORE any row exists — a
   * mismatch is the honest conflict with nothing recorded; a match
   * lands the replay run with replayVerified = true.
   */
  createReplayRun(input: CreateLabSimulatorReplayRunInput): Promise<LabSimulatorRunRecord>;

  /** Reads one run — the uniform NotFound for foreign/unknown scope. */
  getRun(scope: LabSimulatorScope, runId: string): Promise<LabSimulatorRunRecord>;

  /** Lists the client's runs (newest first). */
  listRuns(scope: LabSimulatorScope): Promise<ReadonlyArray<LabSimulatorRunRecord>>;

  /** Reads one step (the audit trail) — the uniform NotFound for foreign/unknown scope. */
  getStep(scope: LabSimulatorScope, runId: string, seq: number): Promise<LabSimulatorStepRecord>;

  /** Lists a run's steps (the trajectory, ascending). */
  listSteps(scope: LabSimulatorScope, runId: string): Promise<ReadonlyArray<LabSimulatorStepRecord>>;

  /**
   * THE AGENT-FACING OBSERVABLE SURFACE: reads one observable-state
   * snapshot (the observable/hidden split — only what the simulated
   * agent could observe) — the uniform NotFound for foreign/unknown
   * scope.
   */
  getObservableSnapshot(scope: LabSimulatorScope, runId: string, seq: number): Promise<LabSimulatorObservableSnapshotRecord>;

  /** Lists a run's observable-state snapshots (ascending). */
  listObservableSnapshots(scope: LabSimulatorScope, runId: string): Promise<ReadonlyArray<LabSimulatorObservableSnapshotRecord>>;

  /**
   * THE STOCHASTIC ENSEMBLE ENTRY (§13): runs the member family over
   * NEW sampled seeds derived from the ensemble seed, drawn over the
   * declared configuration space, and lands the ensemble + its member
   * runs atomically with the agreement/disagreement SQL-computed at
   * the completion advance. A single run is never ground truth — the
   * ensemble record IS the uncertainty estimate.
   */
  createEnsemble(input: CreateLabSimulatorEnsembleInput): Promise<LabSimulatorEnsembleRecord>;

  /** Reads one ensemble (with its member tail) — the uniform NotFound for foreign/unknown scope. */
  getEnsemble(scope: LabSimulatorScope, ensembleId: string): Promise<LabSimulatorEnsembleRecord>;
}

export { createLabSimulatorModule } from './internal/simulator-module.ts';
export {
  /** The splitmix64 seeded generator factory (the declared RNG — pure deterministic streams per label). */
  createLabSimulatorRng,
  deriveLabSimulatorSeed,
  fnv1a64,
} from './internal/rng.ts';
export {
  /** The PURE engine: the deterministic interaction loop (the same inputs always produce the same trajectory, step-for-step). */
  simulateLabTrajectory,
  type LabSimulatorTrajectoryInput,
  type LabSimulatorTrajectoryResult,
  type LabSimulatorEngineStep,
} from './internal/world-core.ts';
/**
 * The pure contract guards (the knob fences, the universe/plan fences,
 * the run/ensemble input fences, the deterministic digest derivations)
 * — exported for unit tests and the later Lab modules so the CONTRACT
 * semantics are part of the module surface. Pure functions: no clock,
 * no randomness, no network.
 */
export {
  assertValidLabSimulatorScope,
  assertValidLabSimulatorKnobs,
  assertValidLabSimulatorUniverse,
  assertValidLabSimulatorPublishingPlan,
  assertValidLabSimulatorRunInput,
  assertValidLabSimulatorEnsembleInput,
  assertValidLabSimulatorMasterSeed,
  computeLabSimulatorConfigDigest,
  computeLabSimulatorSeedDigest,
  computeLabSimulatorStepDigest,
  computeLabSimulatorObservableDigest,
  computeLabSimulatorTrajectoryDigest,
  labSimulatorCanonicalJson,
} from './internal/validation.ts';
