/**
 * MarketingOS module: /research
 * Authority: Web Research (MKT-062 — spec/effective-backlog-v1.6.md
 * "Web Research and Content Intelligence"; spec/architecture-v1.6.md §7 —
 * the primary contract: "Research sources may include public web pages,
 * documentation, research papers, news, market sources, public social
 * content, and connected repositories/workspaces when explicitly
 * authorized. Every material source fact retains source provenance. Model
 * output is a claim unless backed by evidence.").
 *
 * MKT-062 implements the durable RESEARCH SESSION and SOURCE FACT layer:
 *
 *   - the AGENCY-SCOPED RESEARCH SESSION records carrying the declared
 *     research topic, focus question and SOURCES (public web pages,
 *     documentation, research papers, news, market sources, public social
 *     content — plus connected repositories/workspaces ONLY when
 *     explicitly authorized, each carrying its public vs
 *     explicitly-authorized state). The declared sources ride IMMUTABLE
 *     version records: corrections are NEW version records, never
 *     in-place rewrites (the migration-047/052 lifecycle discipline —
 *     CHECK-fenced vocabularies, append-only UPDATE/DELETE rejection
 *     triggers);
 *   - the DETERMINISTIC RESEARCH PIPELINE: fetch/extract over public URLs
 *     through the in-repo ResearchPageReader contract (GET-only — the
 *     port exposes NO method field; the test suite supplies the disclosed
 *     test double, NO live network) and authorized repository/workspace
 *     reads through the /integrations public contract READ-ONLY (the
 *     structural port below exposes getConnection + executeRead ONLY —
 *     executeMutation is structurally absent, so NO mutation can be
 *     expressed toward any source). Every material source fact is
 *     retained as a SOURCE FACT record with FULL provenance: source
 *     reference, fetched-at, extractor identity, content hash, extraction
 *     notes. Facts are EXTRACTED OBSERVATIONS, never conclusions;
 *   - the append-only RESEARCH INSIGHT records (the §7 model-output
 *     discipline): every AI-assisted derivation carries the /ai-runtime
 *     model-identity disclosure (a registry-resolvable model identity +
 *     call reference), and the verification state is computed SERVER-SIDE
 *     from the record's own evidence set — a derived record without
 *     backing evidence is marked 'unverified' and can never be presented
 *     as established ("Model output is a claim unless backed by
 *     evidence"). Hypotheses never become facts by repetition — every
 *     insight ships the claim-tier disclosure and NO promotion path
 *     exists.
 *
 * What it is NOT (the bounded scope):
 *
 *   - NO second evidence authority: source facts are retained in this
 *     module's OWN migration-056 tables; the /evidence direction is
 *     consumed through the SHARED §21 material-key guard (the
 *     /product-intelligence /decisions precedent — the ONE /evidence
 *     import (containsMaterialKey) lives in the module's store,
 *     READ-ONLY);
 *   - NO mutation toward ANY research source: the page-reader port has
 *     no method field at all and the integrations structural port
 *     exposes getConnection + executeRead ONLY — a write toward a public
 *     page or a connected repository/workspace is not expressible on any
 *     contract of this module;
 *   - NO content-intelligence logic (the /content-intelligence sibling
 *     delivered by this same Work Item owns the candidate/hypothesis
 *     layer and consumes THIS module's read surface through its public
 *     contract only);
 *   - NO experiment/mission/planner logic: research insights are inputs
 *     for later composition, never conclusions.
 *
 * The frozen vocabularies are versioned (RESEARCH_VOCABULARY_VERSION, the
 * gm-vocab-v1 discipline): a change to ANY source kind, authorization
 * state, fact kind, run status, source outcome or derivation kind is a
 * NEW version string — never silently re-stated.
 *
 * DEPENDENCY POSTURE (the frozen v1.6 matrix row registered by this Work
 * Item: /research ──→ /integrations, /evidence, /ai-runtime — verbatim):
 * the consumed contracts arrive through declared narrow STRUCTURAL PORTS
 * (the /growth-missions precedent) — the integrations port exposes
 * getConnection + executeRead ONLY (the read-only guarantee is a
 * compile-time property of the port type), the ai-runtime port exposes
 * getModel ONLY (model-identity validation for the AI-assistance
 * disclosure) and the public page reader is the in-repo test-double
 * contract. The ONE /evidence import (containsMaterialKey — the shared
 * §21 guard) lives in internal/research-store.ts. The agency row is NOT
 * resolvable from this module (/agencies is not a frozen allowance of
 * this row): agency-scope authorization is resolved at the ROUTE layer
 * (the /app-metering precedent) and the migration-056 FK anchor keeps a
 * dangling agency reference from persisting.
 *
 * Cross-module access may only target this public entry (public.ts) —
 * internal/ is unimportable from other modules (enforced by the static
 * architecture checker, tools/arch-check).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';

// ---------------------------------------------------------------------------
// The frozen vocabularies (architecture-v1.6.md §7 + the MKT-062 acceptance)
// ---------------------------------------------------------------------------

/**
 * The closed declared-source kind vocabulary — the §7 source list mapped
 * one-to-one onto the MKT-062 declared-source set:
 *   web_page              — public web pages;
 *   documentation         — public documentation pages;
 *   research_paper        — public research papers;
 *   news                  — public news articles;
 *   market_source         — public market sources;
 *   public_social_content — public social content;
 *   connected_repository  — connected repositories (AUTHORIZED);
 *   connected_workspace   — connected workspaces (AUTHORIZED).
 *
 * The kind-compatible AUTHORIZATION fence (migration 056, CHECK): the six
 * public web kinds carry authorization 'public' and NO connection
 * reference; the two authorized kinds carry authorization 'authorized'
 * AND the canonical integration-connection reference (§7: "connected
 * repositories/workspaces when explicitly authorized" — read through the
 * /integrations public contract, READ-ONLY).
 */
export const RESEARCH_SOURCE_KINDS = [
  'web_page',
  'documentation',
  'research_paper',
  'news',
  'market_source',
  'public_social_content',
  'connected_repository',
  'connected_workspace',
] as const;

export type ResearchSourceKind = (typeof RESEARCH_SOURCE_KINDS)[number];

/** The public web source kinds (fetched through the page reader). */
export const RESEARCH_PUBLIC_SOURCE_KINDS: readonly ResearchSourceKind[] = [
  'web_page',
  'documentation',
  'research_paper',
  'news',
  'market_source',
  'public_social_content',
];

/** The authorized source kinds (read through /integrations, READ-ONLY). */
export const RESEARCH_AUTHORIZED_SOURCE_KINDS: readonly ResearchSourceKind[] = [
  'connected_repository',
  'connected_workspace',
];

export function isKnownResearchSourceKind(value: string): value is ResearchSourceKind {
  return (RESEARCH_SOURCE_KINDS as readonly string[]).includes(value);
}

/** The source authorization states (public vs explicitly authorized). */
export const RESEARCH_AUTHORIZATION_STATES = ['public', 'authorized'] as const;

export type ResearchAuthorizationState = (typeof RESEARCH_AUTHORIZATION_STATES)[number];

/**
 * The frozen per-kind authorized-read operation labels (the /integrations
 * NORMALIZED contract operations this module requests): the repository and
 * workspace operations await their future adapters (no first-party adapter
 * declares them yet — a research run over such a source records the honest
 * capability-refused outcome, never an invented read).
 */
export const RESEARCH_AUTHORIZED_READ_OPERATIONS: Readonly<
  Record<'connected_repository' | 'connected_workspace', string>
> = {
  connected_repository: 'repository.read',
  connected_workspace: 'workspace.read',
};

/**
 * The closed deterministic fact-kind vocabulary — what the frozen
 * deterministic extractors retain (EXTRACTED OBSERVATIONS, never
 * conclusions):
 *   page_title / meta_description / meta_keywords — the document head
 *     observations, verbatim;
 *   og_title / og_description — the OpenGraph observations, verbatim;
 *   canonical_url / page_language — the document identity observations;
 *   heading — one heading observation (level + text, verbatim);
 *   text_excerpt — one bounded plain-text body excerpt;
 *   source_record — one normalized provider record observed through an
 *     authorized /integrations read (carried verbatim).
 */
export const RESEARCH_FACT_KINDS = [
  'page_title',
  'meta_description',
  'meta_keywords',
  'og_title',
  'og_description',
  'canonical_url',
  'page_language',
  'heading',
  'text_excerpt',
  'source_record',
] as const;

export type ResearchFactKind = (typeof RESEARCH_FACT_KINDS)[number];

/** The frozen extractor identities (recorded on every retained fact). */
export const RESEARCH_HTML_EXTRACTOR = 'research-html-extract-v1' as const;
export const RESEARCH_INTEGRATION_EXTRACTOR = 'research-integration-read-v1' as const;

/** The honest research run statuses. */
export const RESEARCH_RUN_STATUSES = ['completed', 'partial', 'failed'] as const;

export type ResearchRunStatus = (typeof RESEARCH_RUN_STATUSES)[number];

/** The per-source honest outcome vocabulary (failures fail closed into honest records). */
export const RESEARCH_SOURCE_OUTCOMES = [
  'facts_extracted',
  'no_facts_extracted',
  'unauthorized_refused',
  'fetch_http_error',
  'fetch_transport_error',
  'read_error',
  'read_refused',
] as const;

export type ResearchSourceOutcome = (typeof RESEARCH_SOURCE_OUTCOMES)[number];

/**
 * The closed derivation-kind vocabulary — the §7 research insight set
 * (every insight a CLAIM, never a conclusion): the recorded research
 * syntheses over retained source facts.
 */
export const RESEARCH_DERIVATION_KINDS = [
  'topic_synthesis',
  'trend_observation',
  'market_note',
  'audience_signal',
  'competitor_signal',
  'source_critique',
] as const;

export type ResearchDerivationKind = (typeof RESEARCH_DERIVATION_KINDS)[number];

export function isKnownResearchDerivationKind(value: string): value is ResearchDerivationKind {
  return (RESEARCH_DERIVATION_KINDS as readonly string[]).includes(value);
}

/**
 * The verification-state vocabulary (architecture-v1.6.md §7: "Model output
 * is a claim unless backed by evidence"): 'unverified' — the insight cites
 * NO backing source fact and can never be presented as established;
 * 'evidence_backed' — the insight cites at least one retained source fact.
 * The state is computed SERVER-SIDE from the record's own evidence set
 * (never caller-declared) and the migration-056 deferred constraint
 * trigger is the commit-time backstop. A verification-state transition is
 * a NEW superseding record (the /evidence single-supersession discipline)
 * — never an in-place rewrite.
 */
export const RESEARCH_VERIFICATION_STATES = ['unverified', 'evidence_backed'] as const;

export type ResearchVerificationState = (typeof RESEARCH_VERIFICATION_STATES)[number];

/**
 * THE CLAIM-TIER DISCLOSURE: every research insight is a CLAIM — a
 * synthesis never becomes a fact by repetition. This constant ships on
 * every insight view so the rule is disclosed, not implicit (the
 * /product-intelligence derived-record-tier precedent). There is NO
 * promotion path from the claim tier: evidence_backed means "cites
 * retained source facts", never "established truth".
 */
export const RESEARCH_DERIVED_RECORD_TIER = 'claim' as const;

/**
 * The frozen vocabulary version (the gm-vocab-v1 discipline): the source
 * kinds, authorization states, fact kinds, run statuses, per-source
 * outcomes, derivation kinds and verification states. A change to ANY of
 * them is a NEW version string — the vocabularies are versioned, never
 * silently re-stated.
 */
export const RESEARCH_VOCABULARY_VERSION = 'rs-vocab-v1' as const;

// ---------------------------------------------------------------------------
// Provenance (server-derived — implementation-contract §3)
// ---------------------------------------------------------------------------

/**
 * SERVER-DERIVED provenance for every module command (the
 * growth-missions precedent): built exclusively from the authenticated
 * principal, the ambient correlation context and the recording surface —
 * never from a request body.
 */
export interface ResearchProvenance {
  /** Server-derived actor label: 'user:<uuid>' | 'service:<label>' | 'worker:<label>'. */
  readonly actor: string;
  /** Server-derived recording surface label ('api' | 'module'). */
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

/** Provenance block as persisted on the append-only records. */
export interface ResearchRecordedProvenance extends ResearchProvenance {
  /** Server-stamped recording time (module clock, never caller input). */
  readonly recordedAt: string;
}

// ---------------------------------------------------------------------------
// Records (the migration 056 storage shapes)
// ---------------------------------------------------------------------------

/** One persisted research-session record (the durable research session). */
export interface ResearchSessionRecord {
  readonly researchSessionId: string;
  readonly agencyId: string;
  /** The session's CURRENT declared version (the version-tail pointer). */
  readonly currentVersionSeq: number;
  /** The CAS token (row-locked mutations). */
  readonly version: number;
  readonly createdActor: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One declared source of a session version (each with its authorization state). */
export interface ResearchSourceRecord {
  readonly sourceId: string;
  readonly researchSessionVersionId: string;
  readonly kind: ResearchSourceKind;
  /** The bounded reference (URL for the public web kinds; opaque canonical reference otherwise). */
  readonly reference: string;
  readonly authorization: ResearchAuthorizationState;
  /** The canonical integration-connection reference (authorized kinds only). */
  readonly integrationConnectionId: string | null;
  /** Declaration order (1-based, part of the immutable version snapshot). */
  readonly position: number;
}

/** One IMMUTABLE version record of the declared session. */
export interface ResearchSessionVersionRecord {
  readonly researchSessionVersionId: string;
  readonly researchSessionId: string;
  readonly versionSeq: number;
  readonly topic: string | null;
  readonly focus: string | null;
  /** The declared sources (declaration order preserved). */
  readonly sources: readonly ResearchSourceRecord[];
  readonly provenance: ResearchRecordedProvenance;
}

/**
 * One retained SOURCE FACT — an extracted observation with FULL provenance
 * (§7: "Every material source fact retains source provenance."): the
 * source URL/reference observed, the fetched-at time, the extractor
 * identity, the content hash of the material it was extracted from, the
 * extraction notes and the bounded extracted content. NEVER a conclusion.
 */
export interface ResearchSourceFactRecord {
  readonly sourceFactId: string;
  readonly researchSessionId: string;
  readonly researchSessionVersionId: string;
  /** The declared source the fact was extracted from. */
  readonly sourceId: string;
  readonly researchRunId: string;
  readonly factKind: ResearchFactKind;
  readonly sourceRef: string;
  readonly fetchedAt: string;
  readonly extractor: string;
  readonly contentHash: string;
  readonly extractionNotes: string | null;
  /** The bounded extracted observation content (§21-guarded JSON object). */
  readonly content: Readonly<Record<string, unknown>>;
  readonly provenance: ResearchRecordedProvenance;
}

/**
 * The AI-ASSISTANCE DISCLOSURE carried on a research insight when it was
 * derived with ai-runtime assistance (§7): the model identity (the
 * /ai-runtime registry id + the display label snapshotted at record time)
 * and the model call reference. Null for deterministic derivations.
 */
export interface ResearchInsightAiAssistance {
  readonly modelRegistryId: string;
  readonly modelDisplay: string;
  readonly callReference: string;
}

/**
 * One append-only RESEARCH INSIGHT record — a CLAIM of the §7 derivation
 * set. The verification state is computed server-side from the record's
 * own evidence set; supersession is the correction path (a NEW record
 * citing the prior — verification-state transitions ride this chain, the
 * /evidence single-supersession discipline).
 */
export interface ResearchInsightRecord {
  readonly researchInsightId: string;
  readonly researchSessionId: string;
  readonly derivationKind: ResearchDerivationKind;
  /** The insight statement (a bounded JSON object with a required summary). */
  readonly statement: Readonly<Record<string, unknown>>;
  readonly verificationState: ResearchVerificationState;
  /** The prior record this record corrects (null for a fresh record). */
  readonly supersedesResearchInsightId: string | null;
  /** The record that replaced this one (null while current) — derived at read time. */
  readonly supersededByResearchInsightId: string | null;
  readonly aiAssistance: ResearchInsightAiAssistance | null;
  /** The evidence references (source-fact ids) backing this record, citation order. */
  readonly evidenceSourceFactIds: readonly string[];
  readonly provenance: ResearchRecordedProvenance;
}

/** One per-source honest outcome of a research run. */
export interface ResearchRunSourceOutcomeRecord {
  readonly researchRunSourceOutcomeId: string;
  readonly researchRunId: string;
  readonly sourceId: string;
  readonly outcome: ResearchSourceOutcome;
  readonly detail: string | null;
  readonly factsExtracted: number;
}

/** One research run record (the honest execution record). */
export interface ResearchRunRecord {
  readonly researchRunId: string;
  readonly researchSessionId: string;
  readonly researchSessionVersionId: string;
  readonly status: ResearchRunStatus;
  readonly sourcesInspected: number;
  readonly factsRetained: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly sourceOutcomes: readonly ResearchRunSourceOutcomeRecord[];
  readonly provenance: ResearchRecordedProvenance;
}

/**
 * The composed session read model: the record, the CURRENT declared
 * version with its sources, the complete append-only version tail, the
 * retained source facts, the research insights with their evidence links
 * and the research runs — the honest read-back surface /product-intelligence
 * consumes later and /content-intelligence consumes now (the read surface
 * only).
 */
export interface ResearchSessionDetail {
  readonly session: ResearchSessionRecord;
  readonly currentVersion: ResearchSessionVersionRecord;
  readonly versions: readonly ResearchSessionVersionRecord[];
  readonly sourceFacts: readonly ResearchSourceFactRecord[];
  readonly insights: readonly ResearchInsightRecord[];
  readonly runs: readonly ResearchRunRecord[];
  /** The §7 claim-tier disclosure, on every view (never implicit). */
  readonly derivedRecordTier: typeof RESEARCH_DERIVED_RECORD_TIER;
  /** The vocabulary version disclosure. */
  readonly vocabularyVersion: typeof RESEARCH_VOCABULARY_VERSION;
}

// ---------------------------------------------------------------------------
// The page-reader contract (the in-repo test-double fetcher — GET-only)
// ---------------------------------------------------------------------------

/** One bounded public-page fetch request. GET-ONLY: there is no method. */
export interface ResearchPageFetchRequest {
  /** The absolute https (or loopback http) URL to fetch. */
  readonly url: string;
  /** Deadline for the whole fetch in milliseconds (1..60000). */
  readonly timeoutMs: number;
  /** Maximum accepted response body size in bytes (1..1048576). */
  readonly sizeCapBytes: number;
}

/**
 * The fetch outcome — DATA, never a thrown transport failure (the
 * /integrations adapter precedent): the deterministic pipeline records
 * every outcome honestly.
 */
export interface ResearchPageFetchOutcome {
  /** True when the fetch returned a 2xx body within the size cap. */
  readonly ok: boolean;
  readonly status: number | null;
  readonly body: string | null;
  readonly contentType: string | null;
  readonly transportRefused: boolean;
  readonly timedOut: boolean;
  readonly error: string | null;
}

/**
 * THE RESEARCH PAGE READER (the disclosed test-double fetcher contract):
 * a bounded, GET-ONLY public-page read capability. The REAL implementation
 * (internal/adapters/http-page-reader.ts — the platform HttpCallPort) is
 * wired at the composition root; the test suite supplies the in-repo test
 * double through this interface (NO live network in the test suite). The
 * port deliberately exposes exactly ONE method with NO method field — a
 * mutation toward a public source is not expressible on this contract.
 */
export interface ResearchPageReader {
  fetch(request: ResearchPageFetchRequest): Promise<ResearchPageFetchOutcome>;
}

// ---------------------------------------------------------------------------
// Structural ports (frozen-matrix-compliant /integrations + /ai-runtime,
// both READ-ONLY; the /growth-missions precedent)
// ---------------------------------------------------------------------------

/** The narrow /integrations connection snapshot this module consumes. */
export interface ResearchConnectionSnapshot {
  readonly connectionId: string;
  readonly clientId: string;
  readonly agencyId: string;
  readonly adapterKey: string;
  readonly providerLabel: string;
  readonly status: string;
}

/** One normalized provider record observed through an authorized read. */
export interface ResearchProviderRecord {
  readonly providerRecordId: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly sourceTimestamp: string | null;
  readonly etag: string | null;
  readonly sourceVersion: string | null;
}

/** The authorized-read outcome — DATA, never a thrown invocation failure. */
export interface ResearchReadOutcome {
  readonly ok: boolean;
  readonly records: readonly ResearchProviderRecord[];
  readonly error: string | null;
  readonly adapterKey: string;
}

/**
 * THE NARROW /integrations PORT (READ-ONLY — §7 made structural): canonical
 * connection resolution + the authorized READ surface ONLY. executeMutation,
 * registration and webhook ingestion are STRUCTURALLY ABSENT from this
 * port — the module cannot express a mutation toward any research source.
 * The real IntegrationsModuleApi satisfies this port structurally at the
 * composition root.
 */
export interface ResearchIntegrationsPort {
  getConnection(connectionId: string): Promise<ResearchConnectionSnapshot | null>;
  executeRead(
    input: {
      readonly connectionId: string;
      readonly operation: string;
      readonly parameters: Readonly<Record<string, unknown>>;
    },
    provenance: ResearchProvenance,
  ): Promise<ResearchReadOutcome>;
}

/** The narrow /ai-runtime model snapshot this module consumes. */
export interface ResearchModelSnapshot {
  readonly modelRegistryId: string;
  readonly providerLabel: string;
  readonly modelKey: string;
  readonly displayName: string;
}

/**
 * THE NARROW /ai-runtime PORT (READ-ONLY): model-identity resolution for
 * the AI-assistance disclosure — a cited modelRegistryId must resolve
 * through the registry (any lifecycle state: history records derivations
 * that HAPPENED). The real AiRuntimeModuleApi satisfies this port
 * structurally at the composition root.
 */
export interface ResearchAiRuntimePort {
  getModel(modelRegistryId: string): Promise<ResearchModelSnapshot | null>;
}

// ---------------------------------------------------------------------------
// Canonical owner context (implementation-contract §2)
// ---------------------------------------------------------------------------

/**
 * The CANONICAL RESEARCH SESSION OWNER CONTEXT: the single server-side
 * resolution of WHICH agency owns the research session, derived from
 * durable state on every call. Session-scoped operations authorize against
 * this context — never against caller-supplied tenant or session identity.
 * The agency ROW is resolved at the route layer (/agencies is not a frozen
 * allowance of this module's dependency row — the /app-metering precedent);
 * this context carries the scope identity the route layer authorizes.
 */
export interface ResearchSessionOwnerContext {
  readonly scope: {
    readonly kind: 'research-session';
    readonly agencyId: string;
    readonly researchSessionId: string;
  };
  readonly session: ResearchSessionRecord;
  readonly resolvedAt: string;
}

/**
 * The CANONICAL RESEARCH INSIGHT OWNER CONTEXT: the insight resolved to
 * its owning session's agency (the /content-intelligence same-agency
 * validation surface — its frozen row consumes this module READ-ONLY).
 */
export interface ResearchInsightOwnerContext {
  readonly scope: {
    readonly kind: 'research-insight';
    readonly agencyId: string;
    readonly researchSessionId: string;
    readonly researchInsightId: string;
  };
  readonly insight: ResearchInsightRecord;
  readonly resolvedAt: string;
}

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

export interface ResearchModuleApi {
  /**
   * Creates an AGENCY-SCOPED research session (version 1 of the declared
   * topic/focus/sources). The agency scope is validated at the ROUTE layer
   * (uniform 404 unknown/malformed; the migration-056 FK anchor is the
   * backstop). The declared sources are validated against the frozen
   * kind/authorization fence (public web kinds public; authorized kinds
   * carry a canonical integration-connection reference that must EXIST and
   * belong to the session's agency — the uniform 404 for a foreign/unknown
   * connection; a non-connected connection is an honest 409: authorized
   * reads require an authorized integration).
   */
  createResearchSession(
    input: {
      readonly agencyId: string;
      readonly declaration: ResearchSessionDeclarationInput;
    },
    provenance: ResearchProvenance,
  ): Promise<ResearchSessionDetail>;

  /** Raw session record by id. */
  getResearchSession(researchSessionId: string): Promise<ResearchSessionRecord | null>;

  /**
   * Canonical ownership resolution: the session record composed into the
   * canonical owner context. Null when the session does not exist —
   * callers surface the uniform 404 so foreign and unknown identifiers
   * are indistinguishable.
   */
  resolveResearchSessionOwnership(
    researchSessionId: string,
  ): Promise<ResearchSessionOwnerContext | null>;

  /** The agency's research sessions (oldest first). */
  listResearchSessionsForAgency(agencyId: string): Promise<readonly ResearchSessionRecord[]>;

  /**
   * The composed honest read-back: record + CURRENT declared version + the
   * full version tail + the retained source facts + the research insights
   * with evidence links + the research runs + the claim-tier disclosure.
   * This is the READ SURFACE /product-intelligence consumes later and
   * /content-intelligence consumes now (by reference — no
   * content-intelligence logic here).
   */
  getResearchSessionDetail(researchSessionId: string): Promise<ResearchSessionDetail | null>;

  /** The append-only version tail (oldest first). Null when unknown. */
  getResearchSessionVersions(
    researchSessionId: string,
  ): Promise<readonly ResearchSessionVersionRecord[] | null>;

  /** The retained source-fact tail (oldest first). Null when unknown. */
  getResearchSessionFacts(
    researchSessionId: string,
  ): Promise<readonly ResearchSourceFactRecord[] | null>;

  /** The research insight records (oldest first). Null when unknown. */
  getResearchSessionInsights(
    researchSessionId: string,
  ): Promise<readonly ResearchInsightRecord[] | null>;

  /** The research runs (oldest first). Null when unknown. */
  getResearchSessionRuns(researchSessionId: string): Promise<readonly ResearchRunRecord[] | null>;

  /**
   * Records a NEW declared version (the correction path — the declared
   * sources are IMMUTABLE per version; corrections are NEW version
   * records, never in-place rewrites). CAS on the session's `version`
   * (ConflictError on loss); the version pointer only ever ADVANCES.
   */
  recordResearchSessionVersion(
    input: {
      readonly researchSessionId: string;
      readonly declaration: ResearchSessionDeclarationInput;
      readonly expectedVersion: number;
    },
    provenance: ResearchProvenance,
  ): Promise<ResearchSessionDetail>;

  /**
   * Runs the DETERMINISTIC RESEARCH PASS over the session's CURRENT
   * declared sources: public web sources are fetched through the
   * page-reader port (GET-only) and deterministically extracted; authorized
   * sources are read through the /integrations port (READ-ONLY — the
   * connection must be 'connected' and belong to the session's agency; a
   * non-authorized source is REFUSED HONESTLY with the
   * 'unauthorized_refused' outcome). Every material source fact is
   * retained with FULL provenance (source ref, fetched-at, extractor
   * identity, content hash, extraction notes); every source's outcome is
   * recorded honestly (the per-source outcome rows). Row-locked against
   * concurrent corrections: a version change mid-flight is an honest 409
   * (the re-run researches the new sources).
   */
  runResearch(
    input: {
      readonly researchSessionId: string;
    },
    provenance: ResearchProvenance,
  ): Promise<ResearchRunRecord>;

  /**
   * Records one RESEARCH INSIGHT (a §7 derivation CLAIM). The verification
   * state is computed SERVER-SIDE from the cited evidence (≥1 resolvable
   * source fact of the SAME session → 'evidence_backed'; none →
   * 'unverified') — never caller-declared. Each cited sourceFactId must
   * resolve to a retained source fact of the SAME session (uniform 404
   * otherwise — a foreign fact id is not an oracle). The AI-assistance
   * disclosure, when present, must cite a model that resolves through the
   * /ai-runtime registry (uniform 404 otherwise). The optional
   * supersedesResearchInsightId is the correction path (same session, same
   * derivation kind, not already superseded — the single-supersession
   * fence; verification-state transitions ride this chain).
   */
  recordResearchInsight(
    input: {
      readonly researchSessionId: string;
      readonly derivationKind: ResearchDerivationKind;
      readonly statement: Readonly<Record<string, unknown>>;
      readonly evidenceSourceFactIds: readonly string[];
      readonly aiAssistance: ResearchInsightAiAssistanceInput | null;
      readonly supersedesResearchInsightId: string | null;
    },
    provenance: ResearchProvenance,
  ): Promise<ResearchInsightRecord>;

  /** Raw insight record by id (superseded records included — history stays readable). */
  getResearchInsight(researchInsightId: string): Promise<ResearchInsightRecord | null>;

  /**
   * Canonical insight ownership resolution (the /content-intelligence
   * read-only consumption surface): the insight resolved to its owning
   * session's agency. Null when unknown — callers surface the uniform 404.
   */
  resolveResearchInsightOwnership(
    researchInsightId: string,
  ): Promise<ResearchInsightOwnerContext | null>;
}

/** The declared session content — exactly what rides an IMMUTABLE version record. */
export interface ResearchSessionDeclarationInput {
  /** The declared research topic (bounded). */
  readonly topic: string | null;
  /** The bounded declared focus question. */
  readonly focus: string | null;
  /** The declared sources (1..40, declaration order preserved). */
  readonly sources: readonly ResearchSourceDeclaration[];
}

/** One declared source — a kind, a bounded reference and its authorization state. */
export interface ResearchSourceDeclaration {
  readonly kind: ResearchSourceKind;
  readonly reference: string;
  readonly authorization: ResearchAuthorizationState;
  /** REQUIRED for the authorized kinds; must be null for the public web kinds. */
  readonly integrationConnectionId: string | null;
}

/** The AI-assistance disclosure input (validated against the /ai-runtime registry). */
export interface ResearchInsightAiAssistanceInput {
  readonly modelRegistryId: string;
  readonly callReference: string;
}

export interface ResearchModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** The in-repo page-reader contract (test double in tests; the platform HttpCallPort adapter in production). */
  readonly pageReader: ResearchPageReader;
  /** Matrix-listed direction (/research ──→ /integrations): READ-ONLY authorized source reads. */
  readonly integrations: ResearchIntegrationsPort;
  /** Matrix-listed direction (/research ──→ /ai-runtime): model-identity resolution for the AI disclosure. */
  readonly aiRuntime: ResearchAiRuntimePort;
}

export { createResearchModule } from './internal/research-module.ts';
/**
 * The input guards (declaration/insight/provenance validation, the §21
 * material-key backstop and the deterministic HTML extractor) — exported
 * for unit tests and future server-side callers (the /content-intelligence
 * sibling and the future MKT-070+ planners compose these same commands) so
 * the guard semantics are part of the module contract. Pure functions.
 */
export {
  assertValidResearchSessionDeclaration,
  assertValidResearchProvenance,
  assertValidResearchInsightInput,
  composeResearchSessionOwnerContext,
  researchDerivedVerificationState,
  extractResearchHtmlSourceFacts,
  hashResearchContent,
  RESEARCH_STATEMENT_SUMMARY_MAX,
} from './internal/research-store.ts';
