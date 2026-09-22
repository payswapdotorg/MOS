/**
 * MarketingOS module: /content-intelligence
 * Authority: Content Intelligence (MKT-062 — spec/effective-backlog-v1.6.md
 * "Web Research and Content Intelligence"; spec/architecture-v1.6.md §6 —
 * the primary contract: "The Content Intelligence layer normalizes
 * platform observations into evidence and candidate records. Important
 * features can include topic/entity, niche/sub-niche, content format,
 * length, hook features, narrative structure, publishing time, observed
 * performance, performance velocity, engagement, audience-fit signals,
 * freshness, novelty and reuse/duplication risk. Observed
 * competitor/platform performance generates hypotheses. It does not by
 * itself establish causality for the user's account.").
 *
 * MKT-062 implements the durable CANDIDATE and HYPOTHESIS layer:
 *
 *   - the OBSERVATION INGESTION pipeline: platform observations are read
 *     through the /integrations public contract READ-ONLY (the structural
 *     port below exposes getConnection + executeRead ONLY —
 *     executeMutation is structurally absent, so NO mutation can be
 *     expressed toward any platform) and normalized into EVIDENCE LINKS
 *     VIA the /evidence public contract (each normalized provider record
 *     becomes ONE append-only /evidence 'observation' record — /evidence
 *     stays the SOLE evidence authority; this module retains no shadow
 *     observation ledger). The frozen per-observation-kind normalized
 *     operation labels: platform_analytics → 'runReport' (the EXISTING
 *     generic-analytics adapter label); platform_content → 'content.list'
 *     (awaits its adapter — an ingestion over it today records the honest
 *     read_error capability outcome, never an invented read);
 *   - the CLIENT-SCOPED CANDIDATE records (migration 057): the §6
 *     observed-feature set as DATA — topic/entity, niche/sub-niche,
 *     content format, length, hook features, narrative structure,
 *     publishing time, observed performance, performance velocity,
 *     engagement, audience-fit signals, freshness, novelty and
 *     reuse/duplication risk — closed vocabularies exactly where the house
 *     pattern uses them, FK-anchored same-Client /evidence links and
 *     optional FK-anchored /metrics observation references for the
 *     observed-performance anchor. Candidates are APPEND-ONLY (a new
 *     observation is a NEW candidate — observed features are never
 *     rewritten);
 *   - the append-only HYPOTHESIS records with HONEST FRAMING: observed
 *     competitor/platform performance generates hypotheses, and §6's
 *     explicit non-claim ships on EVERY hypothesis view (the
 *     CONTENT_INTELLIGENCE_HYPOTHESIS_FRAMING constant): a hypothesis
 *     does NOT itself establish causality for the user's account — it is
 *     an INPUT to /experiments (the optional FK-anchored experiment
 *     reference), never a conclusion. Hypotheses cite the /evidence
 *     records and CANDIDATE records they were generated from, and may
 *     cite /research insight references (same-agency, validated through
 *     the /research public contract READ-ONLY — the research module's
 *     AI-discipline disclosures ride on the cited insights themselves);
 *   - the DETERMINISTIC niche clustering and candidate ranking (the
 *     MKT-062 acceptance): pure functions with frozen calculation
 *     versions — clusterContentCandidatesByNiche ('ci-cluster-v1') groups
 *     candidates by (niche, sub-niche) with per-cluster feature
 *     histograms; rankContentCandidates ('ci-rank-v1') orders candidates
 *     by a DISCLOSED frozen weight vector over the closed-vocab observed
 *     features. Same inputs always produce the same outputs; the ranked
 *     order is a RECOMMENDATION as data toward planners — never a
 *     mutation, never an outcome claim.
 *
 * What it is NOT (the bounded scope):
 *
 *   - NO second evidence authority: platform observations are appended
 *     through the /evidence public contract (appendEvidence) and every
 *     candidate/hypothesis evidence link is FK-anchored to the canonical
 *     evidence table with the same-Client trigger backstop; the ONE
 *     /evidence guard import (containsMaterialKey — the shared §21
 *     material-key backstop) lives in the module's store;
 *   - NO causality claim: hypotheses are inputs to /experiments; the
 *     experiment identity/design authority stays /experiments (no
 *     experiment is created or transitioned here — at most REFERENCED);
 *   - NO platform adapter knowledge: the platform identity is the
 *     /integrations adapter key carried as data; platform-specific rules
 *     live behind the adapter plane;
 *   - NO /ai-runtime consumption (the frozen row lists none): AI-derived
 *     research claims arrive as /research insight references whose own
 *     AI-assistance disclosures ride the research records;
 *   - NO mission/planner logic: candidates and hypotheses are attachable
 *     BY REFERENCE through the read surface.
 *
 * The frozen vocabularies are versioned (CONTENT_INTELLIGENCE_VOCABULARY_
 * VERSION, the gm-vocab-v1 discipline): a change to ANY observation kind,
 * content format, length unit, hook feature, narrative structure,
 * audience-fit signal, freshness/novelty/reuse state, hypothesis kind or
 * ingestion status is a NEW version string — never silently re-stated.
 *
 * DEPENDENCY POSTURE (the frozen v1.6 matrix row registered by this Work
 * Item: /content-intelligence ──→ /evidence, /metrics, /experiments,
 * /integrations, /research — verbatim): /evidence is consumed through its
 * public contract (appendEvidence for the observation normalization +
 * getEvidence for canonical link resolution), /metrics through its public
 * contract (getMetricObservation — the observed-performance anchor
 * validation), /experiments through its public contract (getExperiment —
 * the hypothesis experiment-reference validation, READ-ONLY), /research
 * through its public contract (resolveResearchInsightOwnership — the
 * same-agency research-insight citation validation, READ-ONLY) and
 * /integrations through the declared narrow READ-ONLY STRUCTURAL PORT
 * (getConnection + executeRead ONLY — the read-only guarantee is a
 * compile-time property of the port type; the real IntegrationsModuleApi
 * satisfies it structurally at the composition root). The client ROW is
 * resolved at the route layer (requireClientAccess — /clients is not an
 * allowance of this module's row; the migration-057 FK anchor is the
 * backstop).
 *
 * Cross-module access may only target this public entry (public.ts) —
 * internal/ is unimportable from other modules (enforced by the static
 * architecture checker, tools/arch-check).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import type {
  EvidenceModuleApi,
  EvidenceRecord,
} from '../evidence/public.ts';
import type { MetricsModuleApi } from '../metrics/public.ts';
import type { ExperimentsModuleApi } from '../experiments/public.ts';
import type { ResearchInsightOwnerContext } from '../research/public.ts';

// ---------------------------------------------------------------------------
// The frozen vocabularies (architecture-v1.6.md §6 + the MKT-062 acceptance)
// ---------------------------------------------------------------------------

/**
 * The closed platform-observation kind vocabulary — what the ingestion
 * pipeline reads through the /integrations public contract:
 *   platform_content   — public/own platform content observations;
 *   platform_analytics — observed platform performance/analytics points.
 */
export const CONTENT_INTELLIGENCE_OBSERVATION_KINDS = [
  'platform_content',
  'platform_analytics',
] as const;

export type ContentIntelligenceObservationKind =
  (typeof CONTENT_INTELLIGENCE_OBSERVATION_KINDS)[number];

/**
 * The frozen per-kind observation read operation labels (the /integrations
 * NORMALIZED contract operations this module requests): the analytics
 * operation is the EXISTING generic-analytics adapter label; the content
 * operation awaits its adapter (no first-party adapter declares it yet —
 * an ingestion over it today records the honest read_error capability
 * outcome, never an invented read).
 */
export const CONTENT_INTELLIGENCE_OBSERVATION_READ_OPERATIONS: Readonly<
  Record<ContentIntelligenceObservationKind, string>
> = {
  platform_content: 'content.list',
  platform_analytics: 'runReport',
};

/**
 * The closed content-format vocabulary (§6 "content format" — observed as
 * data; the closed set the house pattern uses for enumerated features).
 */
export const CONTENT_INTELLIGENCE_FORMATS = [
  'short_video',
  'long_video',
  'live_stream',
  'image_post',
  'carousel',
  'text_post',
  'thread',
  'story',
  'article',
  'podcast',
  'webinar',
  'infographic',
] as const;

export type ContentIntelligenceFormat = (typeof CONTENT_INTELLIGENCE_FORMATS)[number];

export function isKnownContentIntelligenceFormat(value: string): value is ContentIntelligenceFormat {
  return (CONTENT_INTELLIGENCE_FORMATS as readonly string[]).includes(value);
}

/** The closed length-unit vocabulary (§6 "length" — the observed unit). */
export const CONTENT_INTELLIGENCE_LENGTH_UNITS = [
  'seconds',
  'minutes',
  'hours',
  'words',
  'items',
] as const;

export type ContentIntelligenceLengthUnit =
  (typeof CONTENT_INTELLIGENCE_LENGTH_UNITS)[number];

/**
 * The closed hook-feature vocabulary (§6 "hook features" — observed
 * multi-select, 0..8 per candidate).
 */
export const CONTENT_INTELLIGENCE_HOOK_FEATURES = [
  'question',
  'bold_claim',
  'curiosity_gap',
  'numbered_list',
  'contrarian',
  'emotional',
  'urgency',
  'identity_callout',
  'pattern_interrupt',
  'offer_or_price',
  'testimonial_lead',
  'statistic_lead',
] as const;

export type ContentIntelligenceHookFeature =
  (typeof CONTENT_INTELLIGENCE_HOOK_FEATURES)[number];

/**
 * The closed narrative-structure vocabulary (§6 "narrative structure").
 */
export const CONTENT_INTELLIGENCE_NARRATIVE_STRUCTURES = [
  'problem_solution',
  'tutorial',
  'listicle',
  'story_arc',
  'before_after',
  'myth_busting',
  'comparison',
  'behind_the_scenes',
  'interview',
  'commentary',
  'reaction',
  'case_study',
  'news_report',
  'entertainment_bit',
] as const;

export type ContentIntelligenceNarrativeStructure =
  (typeof CONTENT_INTELLIGENCE_NARRATIVE_STRUCTURES)[number];

/**
 * The closed audience-fit signal vocabulary (§6 "audience-fit signals" —
 * the observed signal state, not an inference).
 */
export const CONTENT_INTELLIGENCE_AUDIENCE_FIT_SIGNALS = [
  'strong_fit',
  'moderate_fit',
  'weak_fit',
  'unclear',
] as const;

export type ContentIntelligenceAudienceFitSignal =
  (typeof CONTENT_INTELLIGENCE_AUDIENCE_FIT_SIGNALS)[number];

/**
 * The closed freshness vocabulary (§6 "freshness" — the observed
 * recency posture of the content).
 */
export const CONTENT_INTELLIGENCE_FRESHNESS_STATES = [
  'breaking',
  'recent',
  'established',
  'evergreen',
  'dated',
] as const;

export type ContentIntelligenceFreshnessState =
  (typeof CONTENT_INTELLIGENCE_FRESHNESS_STATES)[number];

/**
 * The closed novelty vocabulary (§6 "novelty" — the observed
 * distinctiveness posture).
 */
export const CONTENT_INTELLIGENCE_NOVELTY_STATES = [
  'novel',
  'variation',
  'common',
  'saturated',
] as const;

export type ContentIntelligenceNoveltyState =
  (typeof CONTENT_INTELLIGENCE_NOVELTY_STATES)[number];

/**
 * The closed reuse/duplication-risk vocabulary (§6 "reuse/duplication
 * risk" — the observed risk posture of reusing the observed angle).
 */
export const CONTENT_INTELLIGENCE_REUSE_RISK_LEVELS = [
  'low',
  'medium',
  'high',
  'unclear',
] as const;

export type ContentIntelligenceReuseRiskLevel =
  (typeof CONTENT_INTELLIGENCE_REUSE_RISK_LEVELS)[number];

/**
 * The closed hypothesis-kind vocabulary — what observed competitor/
 * platform performance generates hypotheses ABOUT.
 */
export const CONTENT_INTELLIGENCE_HYPOTHESIS_KINDS = [
  'format_hypothesis',
  'topic_hypothesis',
  'hook_hypothesis',
  'narrative_hypothesis',
  'timing_hypothesis',
  'length_hypothesis',
  'audience_hypothesis',
  'distribution_hypothesis',
] as const;

export type ContentIntelligenceHypothesisKind =
  (typeof CONTENT_INTELLIGENCE_HYPOTHESIS_KINDS)[number];

export function isKnownContentIntelligenceHypothesisKind(
  value: string,
): value is ContentIntelligenceHypothesisKind {
  return (CONTENT_INTELLIGENCE_HYPOTHESIS_KINDS as readonly string[]).includes(value);
}

/** The honest ingestion run statuses. */
export const CONTENT_INTELLIGENCE_INGESTION_STATUSES = [
  'completed',
  'refused',
  'failed',
] as const;

export type ContentIntelligenceIngestionStatus =
  (typeof CONTENT_INTELLIGENCE_INGESTION_STATUSES)[number];

/**
 * THE HYPOTHESIS FRAMING DISCLOSURE (§6's explicit non-claim, verbatim in
 * substance): observed competitor/platform performance does NOT by itself
 * establish causality for the user's account — a hypothesis is an INPUT
 * to /experiments, never a conclusion. This constant ships on EVERY
 * hypothesis view so the rule is disclosed, not implicit (the
 * growth-missions terminal-decision-basis precedent).
 */
export const CONTENT_INTELLIGENCE_HYPOTHESIS_FRAMING =
  'hypothesis-not-causal: observed competitor/platform performance does not by itself establish causality for this account — this record is an input to experiments, never a conclusion' as const;

/**
 * The frozen vocabulary version (the gm-vocab-v1 discipline): the
 * observation kinds, read operation labels, content formats, length units,
 * hook features, narrative structures, audience-fit signals,
 * freshness/novelty/reuse states, hypothesis kinds and ingestion
 * statuses. A change to ANY of them is a NEW version string — the
 * vocabularies are versioned, never silently re-stated.
 */
export const CONTENT_INTELLIGENCE_VOCABULARY_VERSION = 'ci-vocab-v1' as const;

/** The frozen niche-clustering calculation version. */
export const CONTENT_INTELLIGENCE_CLUSTERING_VERSION = 'ci-cluster-v1' as const;

/** The frozen candidate-ranking calculation version. */
export const CONTENT_INTELLIGENCE_RANKING_VERSION = 'ci-rank-v1' as const;

// ---------------------------------------------------------------------------
// Provenance (server-derived — implementation-contract §3)
// ---------------------------------------------------------------------------

/**
 * SERVER-DERIVED provenance for every module command (the
 * growth-missions precedent): built exclusively from the authenticated
 * principal, the ambient correlation context and the recording surface —
 * never from a request body.
 */
export interface ContentIntelligenceProvenance {
  /** Server-derived actor label: 'user:<uuid>' | 'service:<label>' | 'worker:<label>'. */
  readonly actor: string;
  /** Server-derived recording surface label ('api' | 'module'). */
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

/** Provenance block as persisted on the append-only records. */
export interface ContentIntelligenceRecordedProvenance
  extends ContentIntelligenceProvenance {
  /** Server-stamped recording time (module clock, never caller input). */
  readonly recordedAt: string;
}

// ---------------------------------------------------------------------------
// Records (the migration 057 storage shapes)
// ---------------------------------------------------------------------------

/** One CLIENT-SCOPED candidate record — the §6 observed-feature set as data. */
export interface ContentCandidateRecord {
  readonly contentCandidateId: string;
  readonly clientId: string;
  /** Optional Workspace scope INSIDE the owning Client (null = client-wide). */
  readonly workspaceId: string | null;
  readonly topicEntity: string;
  readonly niche: string;
  readonly subNiche: string | null;
  readonly contentFormat: ContentIntelligenceFormat;
  readonly lengthValue: number | null;
  readonly lengthUnit: ContentIntelligenceLengthUnit | null;
  readonly hookFeatures: readonly ContentIntelligenceHookFeature[];
  readonly narrativeStructure: ContentIntelligenceNarrativeStructure;
  /** The observed publishing time (null = unobserved). */
  readonly publishedAt: string | null;
  /** The observed performance points (a bounded JSON object of observed data). */
  readonly observedPerformance: Readonly<Record<string, unknown>>;
  /** The observed performance velocity (null = unobserved). */
  readonly performanceVelocity: Readonly<Record<string, unknown>> | null;
  /** The observed engagement points (null = unobserved). */
  readonly engagement: Readonly<Record<string, unknown>> | null;
  readonly audienceFit: ContentIntelligenceAudienceFitSignal;
  readonly freshness: ContentIntelligenceFreshnessState;
  readonly novelty: ContentIntelligenceNoveltyState;
  readonly reuseRisk: ContentIntelligenceReuseRiskLevel;
  /** The FK-anchored /evidence observation links, citation order. */
  readonly evidenceIds: readonly string[];
  /** The FK-anchored /metrics observation references, citation order. */
  readonly metricObservationIds: readonly string[];
  readonly provenance: ContentIntelligenceRecordedProvenance;
}

/** One append-only HYPOTHESIS record with honest framing. */
export interface ContentHypothesisRecord {
  readonly contentHypothesisId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly hypothesisKind: ContentIntelligenceHypothesisKind;
  /** The hypothesis statement (a bounded JSON object with a required summary). */
  readonly statement: Readonly<Record<string, unknown>>;
  /** The prior record this record corrects (null for a fresh record). */
  readonly supersedesContentHypothesisId: string | null;
  /** The record that replaced this one (null while current) — derived at read time. */
  readonly supersededByContentHypothesisId: string | null;
  /** The FK-anchored /evidence links, citation order. */
  readonly evidenceIds: readonly string[];
  /** The FK-anchored candidate references, citation order. */
  readonly candidateIds: readonly string[];
  /** The /research insight references (same-agency), citation order. */
  readonly researchInsightIds: readonly string[];
  /** The optional /experiments reference this hypothesis feeds (validated READ-ONLY). */
  readonly experimentId: string | null;
  readonly provenance: ContentIntelligenceRecordedProvenance;
}

/** One honest observation-ingestion run record. */
export interface ContentObservationIngestionRunRecord {
  readonly ingestionRunId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  /** The /integrations connection the observations were read through. */
  readonly connectionId: string;
  readonly observationKind: ContentIntelligenceObservationKind;
  /** The frozen normalized operation label that was requested. */
  readonly operation: string;
  readonly status: ContentIntelligenceIngestionStatus;
  readonly recordsObserved: number;
  readonly evidenceAppended: number;
  /** The appended evidence records (resolved at read time — the ids ride the evidence links). */
  readonly appendedEvidenceIds: readonly string[];
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly detail: string | null;
  readonly provenance: ContentIntelligenceRecordedProvenance;
}

/**
 * The composed candidate read model: the candidate record with its
 * FK-anchored evidence links and /metrics observation references.
 */
export interface ContentCandidateDetail {
  readonly candidate: ContentCandidateRecord;
  /** The §6 non-claim context note — candidates are OBSERVED FEATURES, never conclusions. */
  readonly candidateTier: 'observed_features';
  readonly vocabularyVersion: typeof CONTENT_INTELLIGENCE_VOCABULARY_VERSION;
}

/** The composed hypothesis read model. */
export interface ContentHypothesisDetail {
  readonly hypothesis: ContentHypothesisRecord;
  /** The §6 non-claim framing, on every view (never implicit). */
  readonly hypothesisFraming: typeof CONTENT_INTELLIGENCE_HYPOTHESIS_FRAMING;
  readonly vocabularyVersion: typeof CONTENT_INTELLIGENCE_VOCABULARY_VERSION;
}

// ---------------------------------------------------------------------------
// The narrow /integrations structural port (READ-ONLY — §6 made structural)
// ---------------------------------------------------------------------------

/** The narrow /integrations connection snapshot this module consumes. */
export interface ContentIntelligenceConnectionSnapshot {
  readonly connectionId: string;
  readonly clientId: string;
  readonly agencyId: string;
  readonly adapterKey: string;
  readonly providerLabel: string;
  readonly status: string;
}

/** One normalized provider record observed through an authorized read. */
export interface ContentIntelligenceProviderRecord {
  readonly providerRecordId: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly sourceTimestamp: string | null;
  readonly etag: string | null;
  readonly sourceVersion: string | null;
}

/** The observation-read outcome — DATA, never a thrown invocation failure. */
export interface ContentIntelligenceReadOutcome {
  readonly ok: boolean;
  readonly records: readonly ContentIntelligenceProviderRecord[];
  readonly error: string | null;
  readonly adapterKey: string;
}

/**
 * THE NARROW /integrations PORT (READ-ONLY — §6 made structural): canonical
 * connection resolution + the observation READ surface ONLY. executeMutation,
 * registration and webhook ingestion are STRUCTURALLY ABSENT from this
 * port — the module cannot express a mutation toward any platform. The
 * real IntegrationsModuleApi satisfies this port structurally at the
 * composition root.
 */
export interface ContentIntelligenceIntegrationsPort {
  getConnection(
    connectionId: string,
  ): Promise<ContentIntelligenceConnectionSnapshot | null>;
  executeRead(
    input: {
      readonly connectionId: string;
      readonly operation: string;
      readonly parameters: Readonly<Record<string, unknown>>;
    },
    provenance: ContentIntelligenceProvenance,
  ): Promise<ContentIntelligenceReadOutcome>;
}

// ---------------------------------------------------------------------------
// Canonical owner context (implementation-contract §2)
// ---------------------------------------------------------------------------

/**
 * The CANONICAL CONTENT CANDIDATE OWNER CONTEXT: the single server-side
 * resolution of WHICH client owns the candidate, derived from durable
 * state on every call. Candidate-scoped operations authorize against this
 * context — never against caller-supplied tenant or candidate identity.
 * The client ROW is resolved at the route layer (requireClientAccess —
 * /clients is not an allowance of this module's row; the migration-057 FK
 * anchor is the backstop); this context carries the scope identity the
 * route layer authorizes.
 */
export interface ContentCandidateOwnerContext {
  readonly scope: {
    readonly kind: 'content-candidate';
    readonly agencyId: string;
    readonly clientId: string;
    readonly contentCandidateId: string;
  };
  readonly candidate: ContentCandidateRecord;
  readonly resolvedAt: string;
}

/** The canonical content-hypothesis owner context (same posture). */
export interface ContentHypothesisOwnerContext {
  readonly scope: {
    readonly kind: 'content-hypothesis';
    readonly agencyId: string;
    readonly clientId: string;
    readonly contentHypothesisId: string;
  };
  readonly hypothesis: ContentHypothesisRecord;
  readonly resolvedAt: string;
}

// ---------------------------------------------------------------------------
// The deterministic clustering + ranking contracts (pure, versioned)
// ---------------------------------------------------------------------------

/** One niche cluster of the deterministic ci-cluster-v1 grouping. */
export interface ContentNicheCluster {
  /** The cluster key: 'niche' or 'niche > sub-niche' when sub-niche is present. */
  readonly key: string;
  readonly niche: string;
  readonly subNiche: string | null;
  readonly candidateIds: readonly string[];
  /** The per-format observation counts (the deterministic feature histogram). */
  readonly formatCounts: Readonly<Record<string, number>>;
  /** The per-narrative-structure observation counts. */
  readonly narrativeCounts: Readonly<Record<string, number>>;
  /** The distinct observed hook features, alphabetical. */
  readonly hookFeatures: readonly string[];
}

/** One ranked candidate of the deterministic ci-rank-v1 ordering. */
export interface RankedContentCandidate {
  readonly contentCandidateId: string;
  /** The deterministic score over the closed-vocab observed features (disclosed weights). */
  readonly score: number;
  /** The per-feature score breakdown (disclosed, reproducible). */
  readonly breakdown: Readonly<Record<string, number>>;
}

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

export interface ContentIntelligenceModuleApi {
  /**
   * Runs the OBSERVATION INGESTION over one /integrations connection: the
   * frozen per-kind normalized operation label is executed READ-ONLY, and
   * every normalized provider record is appended as ONE canonical
   * /evidence 'observation' record through the /evidence public contract
   * (the sole evidence authority — this module retains no shadow
   * observation ledger). The run row records the honest outcome
   * (completed | refused | failed, counts, detail). The connection must
   * EXIST, belong to the client (uniform 404 foreign/unknown) and be
   * 'connected' (honest 409 otherwise). Returns the appended evidence
   * records — the ids the candidates then cite.
   */
  runObservationIngestion(
    input: {
      readonly clientId: string;
      readonly workspaceId: string | null;
      readonly connectionId: string;
      readonly observationKind: ContentIntelligenceObservationKind;
    },
    provenance: ContentIntelligenceProvenance,
  ): Promise<{
    readonly run: ContentObservationIngestionRunRecord;
    readonly appendedEvidence: readonly EvidenceRecord[];
  }>;

  /** The client's observation-ingestion runs (oldest first). */
  listObservationIngestionRuns(
    clientId: string,
  ): Promise<readonly ContentObservationIngestionRunRecord[]>;

  /**
   * Records one CANDIDATE record (the §6 observed-feature set as data).
   * Every evidence reference must resolve to an /evidence record of the
   * SAME client (uniform 404 otherwise — a foreign evidence id is not an
   * oracle; at least one link is required: the normalized observation the
   * features were observed from). Optional /metrics observation references
   * must resolve to metric observations of the same client (the
   * observed-performance anchor). Append-only: a new observation is a NEW
   * candidate.
   */
  recordContentCandidate(
    input: {
      readonly clientId: string;
      readonly workspaceId: string | null;
      readonly features: ContentCandidateFeaturesInput;
      readonly evidenceIds: readonly string[];
      readonly metricObservationIds: readonly string[];
    },
    provenance: ContentIntelligenceProvenance,
  ): Promise<ContentCandidateRecord>;

  /** Raw candidate record by id (append-only history is always readable). */
  getContentCandidate(contentCandidateId: string): Promise<ContentCandidateRecord | null>;

  /** Canonical candidate ownership resolution (null when unknown — uniform 404 upstream). */
  resolveContentCandidateOwnership(
    contentCandidateId: string,
  ): Promise<ContentCandidateOwnerContext | null>;

  /** The composed candidate read-back with the §6 non-claim note. */
  getContentCandidateDetail(
    contentCandidateId: string,
  ): Promise<ContentCandidateDetail | null>;

  /** The client's candidates (oldest first). */
  listContentCandidatesForClient(
    clientId: string,
  ): Promise<readonly ContentCandidateRecord[]>;

  /**
   * Records one HYPOTHESIS record with honest framing (§6: observed
   * competitor/platform performance generates hypotheses — it does NOT by
   * itself establish causality for the user's account; hypotheses are
   * inputs to /experiments, never conclusions). Every evidence reference
   * must resolve to an /evidence record of the SAME client (≥1 required —
   * evidence/hypothesis separation); candidate references must resolve to
   * candidates of the same client; research insight references must
   * resolve through the /research public contract to sessions of the
   * client's agency (uniform 404 otherwise); the optional experiment
   * reference must resolve through the /experiments public contract to an
   * experiment of the same client (READ-ONLY validation — no experiment is
   * created or transitioned here). The optional supersedesContentHypothesisId
   * is the correction path (same client, same hypothesis kind, not already
   * superseded — the single-supersession fence).
   */
  recordContentHypothesis(
    input: {
      readonly clientId: string;
      readonly workspaceId: string | null;
      readonly hypothesisKind: ContentIntelligenceHypothesisKind;
      readonly statement: Readonly<Record<string, unknown>>;
      readonly evidenceIds: readonly string[];
      readonly candidateIds: readonly string[];
      readonly researchInsightIds: readonly string[];
      readonly experimentId: string | null;
      readonly supersedesContentHypothesisId: string | null;
    },
    provenance: ContentIntelligenceProvenance,
  ): Promise<ContentHypothesisRecord>;

  /** Raw hypothesis record by id (superseded records included — history stays readable). */
  getContentHypothesis(contentHypothesisId: string): Promise<ContentHypothesisRecord | null>;

  /** Canonical hypothesis ownership resolution (null when unknown — uniform 404 upstream). */
  resolveContentHypothesisOwnership(
    contentHypothesisId: string,
  ): Promise<ContentHypothesisOwnerContext | null>;

  /** The composed hypothesis read-back with the §6 framing disclosure. */
  getContentHypothesisDetail(
    contentHypothesisId: string,
  ): Promise<ContentHypothesisDetail | null>;

  /** The client's hypotheses (oldest first). */
  listContentHypothesesForClient(
    clientId: string,
  ): Promise<readonly ContentHypothesisRecord[]>;
}

/** The §6 observed-feature set — exactly what rides one candidate record. */
export interface ContentCandidateFeaturesInput {
  readonly topicEntity: string;
  readonly niche: string;
  readonly subNiche: string | null;
  readonly contentFormat: ContentIntelligenceFormat;
  readonly lengthValue: number | null;
  readonly lengthUnit: ContentIntelligenceLengthUnit | null;
  readonly hookFeatures: readonly ContentIntelligenceHookFeature[];
  readonly narrativeStructure: ContentIntelligenceNarrativeStructure;
  readonly publishedAt: string | null;
  readonly observedPerformance: Readonly<Record<string, unknown>>;
  readonly performanceVelocity: Readonly<Record<string, unknown>> | null;
  readonly engagement: Readonly<Record<string, unknown>> | null;
  readonly audienceFit: ContentIntelligenceAudienceFitSignal;
  readonly freshness: ContentIntelligenceFreshnessState;
  readonly novelty: ContentIntelligenceNoveltyState;
  readonly reuseRisk: ContentIntelligenceReuseRiskLevel;
}

export interface ContentIntelligenceModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Matrix-listed direction (/content-intelligence ──→ /evidence): the SOLE evidence authority (observation normalization + canonical link resolution). */
  readonly evidence: EvidenceModuleApi;
  /** Matrix-listed direction (/content-intelligence ──→ /metrics): metric-observation resolution for the observed-performance anchor. */
  readonly metrics: MetricsModuleApi;
  /** Matrix-listed direction (/content-intelligence ──→ /experiments): experiment-reference validation, READ-ONLY (no experiment is created or transitioned here). */
  readonly experiments: ExperimentsModuleApi;
  /** Matrix-listed direction (/content-intelligence ──→ /integrations): READ-ONLY observation reads (the structural port — executeMutation is absent). */
  readonly integrations: ContentIntelligenceIntegrationsPort;
  /** Matrix-listed direction (/content-intelligence ──→ /research): research-insight citation resolution, READ-ONLY. */
  readonly research: Pick<ResearchInsightResolutionPort, 'resolveResearchInsightOwnership'>;
}

/**
 * The narrow /research resolution surface this module consumes (the
 * ResearchModuleApi satisfies it structurally at the composition root).
 */
export interface ResearchInsightResolutionPort {
  resolveResearchInsightOwnership(
    researchInsightId: string,
  ): Promise<ResearchInsightOwnerContext | null>;
}

export { createContentIntelligenceModule } from './internal/content-intelligence-module.ts';
/**
 * The input guards (candidate/hypothesis/provenance validation, the §21
 * material-key backstop) and the DETERMINISTIC clustering + ranking pure
 * functions — exported for unit tests and future server-side callers so
 * the guard and calculation semantics are part of the module contract.
 * Pure functions.
 */
export {
  assertValidContentCandidateFeatures,
  assertValidContentHypothesisInput,
  assertValidContentIntelligenceProvenance,
  composeContentCandidateOwnerContext,
  clusterContentCandidatesByNiche,
  rankContentCandidates,
  CONTENT_INTELLIGENCE_STATEMENT_SUMMARY_MAX,
} from './internal/content-intelligence-store.ts';
