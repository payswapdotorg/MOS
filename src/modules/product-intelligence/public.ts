/**
 * MarketingOS module: /product-intelligence
 * Authority: Product Intelligence (MKT-069 — spec/effective-backlog-v1.6.md
 * section E; spec/architecture-v1.6.md §7/§8 — the primary contract;
 * spec/module-dependency-matrix-v1.6.md boundary rule 7: "Product
 * Intelligence has read-only source-code/product inspection unless a
 * separate write capability is explicitly granted").
 *
 * MKT-069 implements the durable PRODUCT/MARKET INSPECTION and MODEL
 * records — the Product Intelligence layer of architecture-v1.6.md §8:
 *
 *   - the AGENCY-SCOPED PRODUCT CONTEXT records: the mission-optional
 *     Product Context ("A mission can optionally attach a Product
 *     Context."), carrying the DECLARED INPUTS — public product/site
 *     URL(s), product-document references, source-code repository URL(s),
 *     connected source-workspace references, catalog/inventory references
 *     and current-analytics references — each input carrying its
 *     AUTHORIZATION STATE (public vs explicitly authorized). The declared
 *     inputs ride IMMUTABLE version records: corrections are NEW version
 *     records, never in-place rewrites;
 *   - the DETERMINISTIC INSPECTION PIPELINE: fetch/extract over public
 *     product/site pages through the in-repo ProductPageReader contract
 *     (GET-only — the port exposes NO mutation method; the test suite
 *     supplies the disclosed test double, NO live network) and authorized
 *     repository/workspace/catalog/analytics reads through the
 *     /integrations public contract READ-ONLY (the structural port below
 *     exposes executeRead ONLY — executeMutation is structurally absent).
 *     Every material source fact is retained as a SOURCE-FACT record with
 *     FULL provenance: source URL/reference, fetched-at, extractor
 *     identity, content hash, extraction notes. Facts are EXTRACTED
 *     OBSERVATIONS, never conclusions (§7);
 *   - the DERIVED MODEL records — the §8 derivation set: product
 *     capabilities, user/problem hypotheses, ICP/audience hypotheses,
 *     value propositions, conversion paths, content-worthy features,
 *     market language, commercial metrics to optimize — each carrying
 *     (a) the evidence references (source-fact ids) backing it,
 *     (b) the AI-ASSISTANCE DISCLOSURE (model identity + call reference)
 *     when derived with ai-runtime assistance, and (c) a VERIFICATION
 *     STATE computed SERVER-SIDE from its own evidence set: a derived
 *     record without backing evidence references is marked unverified and
 *     can never be presented as established (§7: "Model output is a claim
 *     unless backed by evidence"). Hypotheses are hypotheses: they never
 *     become facts by repetition — every derived record ships the
 *     claim-tier disclosure and NO promotion path exists;
 *   - the RISK FLAGS: explicit risk records (compliance/privacy/toxicity/
 *     commercial/operational) with severity, evidence links, provenance —
 *     append-only;
 *   - the MISSION ATTACHMENT SEAM: the model records are attachable BY
 *     REFERENCE from missions later — this module provides the READ
 *     SURFACE only. MKT-070 (the Product Marketing Mission Planner) does
 *     the planning; NO mission-strategy logic lives here.
 *
 * What this module deliberately does NOT do (bounded scope, MKT-069):
 *   - NO mutation surface toward ANY external source (boundary rule 7):
 *     the inspection contract supports fetch/read operations ONLY. A
 *     future write capability would require a separately granted
 *     capability key — the SEAM is documented here and in the runbook
 *     (docs/implementation/MKT-069.md) and is deliberately NOT built;
 *   - NO mission-strategy/planner logic (MKT-070 is a later Work Item);
 *   - NO Web Research module (MKT-062 is a later Work Item — the frozen
 *     v1.6 matrix row /product-intelligence → /research, /evidence,
 *     /integrations, /ai-runtime is registered with the
 *     currently-satisfiable subset /evidence, /integrations, /ai-runtime
 *     and /research joins the row at MKT-062 time; the disclosure is in
 *     the runbook — the honest additive-registration pattern, not a
 *     redesign);
 *   - NO second evidence authority: source facts are retained in the
 *     module's OWN tables; the /evidence direction is consumed through
 *     the SHARED §21 material-key guard (the /sales-continuity /decisions
 *     precedent — internal/product-intelligence-store.ts imports
 *     containsMaterialKey from the /evidence public entry, READ-ONLY);
 *   - NO source-code WRITE: source-code inspection is analysis-only
 *     (§8: "Source-code inspection is analysis-only unless the user
 *     separately grants write capability") — the integrations port has no
 *     mutation method at all.
 *
 * The frozen vocabularies are versioned (PRODUCT_INTELLIGENCE_VOCABULARY_
 * VERSION, the gm-vocab-v1 discipline): a change to ANY input kind,
 * derivation kind, verification state, risk category or severity is a NEW
 * version string — never silently re-stated.
 *
 * DEPENDENCY POSTURE (the disclosed MKT-069 registration row of
 * spec/module-dependency-matrix.md: /product-intelligence ──→ /evidence,
 * /integrations, /ai-runtime — the currently-satisfiable subset of the
 * frozen v1.6 row): the consumed contracts arrive through declared narrow
 * STRUCTURAL PORTS (the /growth-missions precedent) — the integrations port
 * exposes getConnection + executeRead ONLY (the read-only guarantee is a
 * compile-time property of the port type), the ai-runtime port exposes
 * getModel ONLY (model-identity validation for the AI-assistance
 * disclosure) and the public page reader is the in-repo test-double
 * contract. The ONE /evidence import (containsMaterialKey — the shared §21
 * guard) lives in internal/product-intelligence-store.ts. The agency row
 * is NOT resolvable from this module (/agencies is not a frozen allowance
 * of this row): agency-scope authorization is resolved at the ROUTE layer
 * (the /app-metering precedent) and the migration-048 FK anchor keeps a
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
// The frozen vocabularies (architecture-v1.6.md §8 + the MKT-069 acceptance)
// ---------------------------------------------------------------------------

/**
 * The closed declared-input kind vocabulary — the §8 input list mapped
 * one-to-one onto the MKT-069 declared-input set:
 *   product_site_url   — public product/site URL(s);
 *   product_document   — product-document references (public pages);
 *   source_repository  — source-code repository URL(s) (authorized);
 *   source_workspace   — connected source-workspace references (authorized);
 *   catalog_inventory  — catalog/inventory references (authorized);
 *   current_analytics  — current-analytics references (authorized).
 *
 * The kind-compatible AUTHORIZATION fence (migration 048, CHECK): the two
 * public web kinds carry authorization 'public' and NO connection
 * reference; the four authorized kinds carry authorization 'authorized'
 * AND the canonical integration-connection reference (boundary rule 7 —
 * read-only inspection through an EXISTING authorized integration).
 */
export const PRODUCT_INTELLIGENCE_INPUT_KINDS = [
  'product_site_url',
  'product_document',
  'source_repository',
  'source_workspace',
  'catalog_inventory',
  'current_analytics',
] as const;

export type ProductIntelligenceInputKind =
  (typeof PRODUCT_INTELLIGENCE_INPUT_KINDS)[number];

/** The public web input kinds (fetched through the page reader). */
export const PRODUCT_INTELLIGENCE_PUBLIC_INPUT_KINDS: readonly ProductIntelligenceInputKind[] = [
  'product_site_url',
  'product_document',
];

/** The authorized input kinds (read through /integrations, READ-ONLY). */
export const PRODUCT_INTELLIGENCE_AUTHORIZED_INPUT_KINDS: readonly ProductIntelligenceInputKind[] = [
  'source_repository',
  'source_workspace',
  'catalog_inventory',
  'current_analytics',
];

export function isKnownProductIntelligenceInputKind(
  value: string,
): value is ProductIntelligenceInputKind {
  return (PRODUCT_INTELLIGENCE_INPUT_KINDS as readonly string[]).includes(value);
}

/** The input authorization states (public vs explicitly authorized). */
export const PRODUCT_INTELLIGENCE_AUTHORIZATION_STATES = [
  'public',
  'authorized',
] as const;

export type ProductIntelligenceAuthorizationState =
  (typeof PRODUCT_INTELLIGENCE_AUTHORIZATION_STATES)[number];

/**
 * The closed derivation-kind vocabulary — the architecture-v1.6.md §8
 * derivation set, VERBATIM (minus "product risks", which are the separate
 * risk-flag records): "Product Intelligence derives product capabilities,
 * user/problem hypotheses, ICP/audience hypotheses, value propositions,
 * conversion paths, content-worthy features, market language, product
 * risks and commercial metrics to optimize."
 */
export const PRODUCT_INTELLIGENCE_DERIVATION_KINDS = [
  'product_capabilities',
  'user_problem_hypotheses',
  'icp_audience_hypotheses',
  'value_propositions',
  'conversion_paths',
  'content_worthy_features',
  'market_language',
  'commercial_metrics',
] as const;

export type ProductIntelligenceDerivationKind =
  (typeof PRODUCT_INTELLIGENCE_DERIVATION_KINDS)[number];

export function isKnownProductIntelligenceDerivationKind(
  value: string,
): value is ProductIntelligenceDerivationKind {
  return (PRODUCT_INTELLIGENCE_DERIVATION_KINDS as readonly string[]).includes(value);
}

/**
 * The verification-state vocabulary (architecture-v1.6.md §7: "Model output
 * is a claim unless backed by evidence"): 'unverified' — the derived record
 * cites NO backing source fact and can never be presented as established;
 * 'evidence_backed' — the record cites at least one retained source fact.
 * The state is computed SERVER-SIDE from the record's own evidence set
 * (never caller-declared) and the migration-048 deferred constraint
 * trigger is the commit-time backstop. A verification-state transition is
 * a NEW superseding record (the /evidence single-supersession discipline)
 * — never an in-place rewrite.
 */
export const PRODUCT_INTELLIGENCE_VERIFICATION_STATES = [
  'unverified',
  'evidence_backed',
] as const;

export type ProductIntelligenceVerificationState =
  (typeof PRODUCT_INTELLIGENCE_VERIFICATION_STATES)[number];

/**
 * THE CLAIM-TIER DISCLOSURE: every derived model record is a CLAIM — a
 * hypothesis never becomes a fact by repetition. This constant ships on
 * every derived-model view so the rule is disclosed, not implicit (the
 * growth-missions terminal-decision-basis precedent). There is NO
 * promotion path from the claim tier: evidence_backed means "cites
 * retained source facts", never "established truth".
 */
export const PRODUCT_INTELLIGENCE_DERIVED_RECORD_TIER = 'claim' as const;

/**
 * The risk-flag vocabularies (the MKT-069 acceptance list): the five risk
 * categories — compliance, privacy, toxicity, commercial, operational —
 * and the four severities — low, medium, high, critical.
 */
export const PRODUCT_INTELLIGENCE_RISK_CATEGORIES = [
  'compliance',
  'privacy',
  'toxicity',
  'commercial',
  'operational',
] as const;

export type ProductIntelligenceRiskCategory =
  (typeof PRODUCT_INTELLIGENCE_RISK_CATEGORIES)[number];

export const PRODUCT_INTELLIGENCE_RISK_SEVERITIES = [
  'low',
  'medium',
  'high',
  'critical',
] as const;

export type ProductIntelligenceRiskSeverity =
  (typeof PRODUCT_INTELLIGENCE_RISK_SEVERITIES)[number];

export function isKnownProductIntelligenceRiskCategory(
  value: string,
): value is ProductIntelligenceRiskCategory {
  return (PRODUCT_INTELLIGENCE_RISK_CATEGORIES as readonly string[]).includes(value);
}

export function isKnownProductIntelligenceRiskSeverity(
  value: string,
): value is ProductIntelligenceRiskSeverity {
  return (PRODUCT_INTELLIGENCE_RISK_SEVERITIES as readonly string[]).includes(value);
}

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
export const PRODUCT_INTELLIGENCE_FACT_KINDS = [
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

export type ProductIntelligenceFactKind =
  (typeof PRODUCT_INTELLIGENCE_FACT_KINDS)[number];

/** The frozen extractor identities (recorded on every retained fact). */
export const PRODUCT_INTELLIGENCE_HTML_EXTRACTOR = 'html-extract-v1' as const;
export const PRODUCT_INTELLIGENCE_INTEGRATION_EXTRACTOR = 'integration-read-v1' as const;

/** The honest inspection run statuses + per-input outcome vocabulary. */
export const PRODUCT_INTELLIGENCE_RUN_STATUSES = [
  'completed',
  'partial',
  'failed',
] as const;

export type ProductIntelligenceRunStatus =
  (typeof PRODUCT_INTELLIGENCE_RUN_STATUSES)[number];

export const PRODUCT_INTELLIGENCE_INPUT_RUN_OUTCOMES = [
  'facts_extracted',
  'no_facts_extracted',
  'unauthorized_refused',
  'fetch_http_error',
  'fetch_transport_error',
  'read_error',
  'read_refused',
] as const;

export type ProductIntelligenceInputRunOutcome =
  (typeof PRODUCT_INTELLIGENCE_INPUT_RUN_OUTCOMES)[number];

/**
 * The frozen vocabulary version (the gm-vocab-v1 discipline): the input
 * kinds, authorization states, derivation kinds, verification states, risk
 * categories/severities, fact kinds, run statuses and per-input outcomes.
 * A change to ANY of them is a NEW version string — the vocabularies are
 * versioned, never silently re-stated.
 */
export const PRODUCT_INTELLIGENCE_VOCABULARY_VERSION = 'pi-vocab-v1' as const;

/**
 * THE READ-ONLY CAPABILITY SEAM (boundary rule 7 — documented, NOT built):
 * a future write capability toward inspected sources would arrive as a
 * SEPARATELY GRANTED capability key (e.g. 'product-intelligence.write')
 * consulted through the /policies public contract before any mutation,
 * with its own Work Item, its own policy dimension and its own audited
 * gate. This module defines NO such key, NO such gate and NO mutation
 * method anywhere — the inspection contract below is fetch/read ONLY by
 * construction (the page-reader port has no method field at all; the
 * integrations port exposes executeRead only).
 */
export const PRODUCT_INTELLIGENCE_WRITE_CAPABILITY_SEAM =
  'separately-granted-capability-key (not built — boundary rule 7)' as const;

// ---------------------------------------------------------------------------
// Provenance (server-derived — implementation-contract §3)
// ---------------------------------------------------------------------------

/**
 * SERVER-DERIVED provenance for every module command (the
 * growth-missions precedent): built exclusively from the authenticated
 * principal, the ambient correlation context and the recording surface —
 * never from a request body.
 */
export interface ProductIntelligenceProvenance {
  /** Server-derived actor label: 'user:<uuid>' | 'service:<label>' | 'worker:<label>'. */
  readonly actor: string;
  /** Server-derived recording surface label ('api' | 'module'). */
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

/** Provenance block as persisted on the append-only records. */
export interface ProductIntelligenceRecordedProvenance
  extends ProductIntelligenceProvenance {
  /** Server-stamped recording time (module clock, never caller input). */
  readonly recordedAt: string;
}

// ---------------------------------------------------------------------------
// Records (the migration 048 storage shapes)
// ---------------------------------------------------------------------------

/** One persisted product-context record (the durable Product Context). */
export interface ProductContextRecord {
  readonly productContextId: string;
  readonly agencyId: string;
  /** The context's CURRENT declared version (the version-tail pointer). */
  readonly currentVersionSeq: number;
  /** The CAS token (row-locked mutations). */
  readonly version: number;
  readonly createdActor: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One declared input of a context version (each with its authorization state). */
export interface ProductContextInputRecord {
  readonly inputId: string;
  readonly productContextVersionId: string;
  readonly kind: ProductIntelligenceInputKind;
  /** The bounded reference (URL for the web kinds; opaque canonical reference otherwise). */
  readonly reference: string;
  readonly authorization: ProductIntelligenceAuthorizationState;
  /** The canonical integration-connection reference (authorized kinds only). */
  readonly integrationConnectionId: string | null;
  /** Declaration order (1-based, part of the immutable version snapshot). */
  readonly position: number;
}

/** One IMMUTABLE version record of the declared context. */
export interface ProductContextVersionRecord {
  readonly productContextVersionId: string;
  readonly productContextId: string;
  readonly versionSeq: number;
  readonly name: string | null;
  readonly summary: string | null;
  /** The declared inputs (declaration order preserved). */
  readonly inputs: readonly ProductContextInputRecord[];
  readonly provenance: ProductIntelligenceRecordedProvenance;
}

/**
 * One retained SOURCE FACT — an extracted observation with FULL provenance
 * (§7: "Every material source fact retains source provenance."): the
 * source URL/reference observed, the fetched-at time, the extractor
 * identity, the content hash of the material it was extracted from, the
 * extraction notes and the bounded extracted content. NEVER a conclusion.
 */
export interface ProductSourceFactRecord {
  readonly sourceFactId: string;
  readonly productContextId: string;
  readonly productContextVersionId: string;
  /** The declared input the fact was extracted from. */
  readonly inputId: string;
  readonly inspectionRunId: string;
  readonly factKind: ProductIntelligenceFactKind;
  readonly sourceRef: string;
  readonly fetchedAt: string;
  readonly extractor: string;
  readonly contentHash: string;
  readonly extractionNotes: string | null;
  /** The bounded extracted observation content (§21-guarded JSON object). */
  readonly content: Readonly<Record<string, unknown>>;
  readonly provenance: ProductIntelligenceRecordedProvenance;
}

/**
 * The AI-ASSISTANCE DISCLOSURE carried on a derived record when it was
 * derived with ai-runtime assistance (§7): the model identity (the
 * /ai-runtime registry id + the display label snapshotted at record time)
 * and the model call reference. Null for deterministic derivations.
 */
export interface ProductDerivedModelAiAssistance {
  readonly modelRegistryId: string;
  readonly modelDisplay: string;
  readonly callReference: string;
}

/**
 * One append-only DERIVED MODEL record — a CLAIM of the §8 derivation set.
 * The verification state is computed server-side from the record's own
 * evidence set; supersession is the correction path (a NEW record citing
 * the prior — verification-state transitions ride this chain, the
 * /evidence single-supersession discipline).
 */
export interface ProductDerivedModelRecord {
  readonly derivedModelId: string;
  readonly productContextId: string;
  readonly derivationKind: ProductIntelligenceDerivationKind;
  /** The derived statement (a bounded JSON object with a required summary). */
  readonly statement: Readonly<Record<string, unknown>>;
  readonly verificationState: ProductIntelligenceVerificationState;
  /** The prior record this record corrects (null for a fresh record). */
  readonly supersedesDerivedModelId: string | null;
  /** The record that replaced this one (null while current) — derived at read time. */
  readonly supersededByDerivedModelId: string | null;
  readonly aiAssistance: ProductDerivedModelAiAssistance | null;
  /** The evidence references (source-fact ids) backing this record, citation order. */
  readonly evidenceSourceFactIds: readonly string[];
  readonly provenance: ProductIntelligenceRecordedProvenance;
}

/** One append-only RISK FLAG record. */
export interface ProductRiskFlagRecord {
  readonly riskFlagId: string;
  readonly productContextId: string;
  readonly category: ProductIntelligenceRiskCategory;
  readonly severity: ProductIntelligenceRiskSeverity;
  readonly statement: Readonly<Record<string, unknown>>;
  readonly mitigation: string | null;
  readonly evidenceSourceFactIds: readonly string[];
  readonly provenance: ProductIntelligenceRecordedProvenance;
}

/** One per-input honest outcome of an inspection run. */
export interface ProductInspectionInputRunRecord {
  readonly inspectionInputRunId: string;
  readonly inspectionRunId: string;
  readonly inputId: string;
  readonly outcome: ProductIntelligenceInputRunOutcome;
  readonly detail: string | null;
  readonly factsExtracted: number;
}

/** One inspection run record (the honest execution record). */
export interface ProductInspectionRunRecord {
  readonly inspectionRunId: string;
  readonly productContextId: string;
  readonly productContextVersionId: string;
  readonly status: ProductIntelligenceRunStatus;
  readonly inputsInspected: number;
  readonly factsRetained: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly inputOutcomes: readonly ProductInspectionInputRunRecord[];
  readonly provenance: ProductIntelligenceRecordedProvenance;
}

/**
 * The composed context read model: the record, the CURRENT declared version
 * with its inputs, the complete append-only version tail, the retained
 * source facts, the derived model records with their evidence links, the
 * risk flags and the inspection runs — the honest read-back surface
 * MKT-070 consumes BY REFERENCE (the mission attachment seam).
 */
export interface ProductContextDetail {
  readonly context: ProductContextRecord;
  readonly currentVersion: ProductContextVersionRecord;
  readonly versions: readonly ProductContextVersionRecord[];
  readonly sourceFacts: readonly ProductSourceFactRecord[];
  readonly derivedModels: readonly ProductDerivedModelRecord[];
  readonly riskFlags: readonly ProductRiskFlagRecord[];
  readonly inspectionRuns: readonly ProductInspectionRunRecord[];
  /** The §7 claim-tier disclosure, on every view (never implicit). */
  readonly derivedRecordTier: typeof PRODUCT_INTELLIGENCE_DERIVED_RECORD_TIER;
  /** The vocabulary version disclosure. */
  readonly vocabularyVersion: typeof PRODUCT_INTELLIGENCE_VOCABULARY_VERSION;
}

// ---------------------------------------------------------------------------
// The page-reader contract (the in-repo test-double fetcher — GET-only)
// ---------------------------------------------------------------------------

/** One bounded public-page fetch request. GET-ONLY: there is no method. */
export interface ProductPageFetchRequest {
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
export interface ProductPageFetchOutcome {
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
 * THE PRODUCT PAGE READER (the disclosed test-double fetcher contract):
 * a bounded, GET-ONLY public-page read capability. The REAL implementation
 * (internal/adapters/http-page-reader.ts — the platform HttpCallPort) is
 * wired at the composition root; the test suite supplies the in-repo test
 * double through this interface (NO live network in the test suite). The
 * port deliberately exposes exactly ONE method with NO method field — a
 * mutation toward a public source is not expressible on this contract.
 */
export interface ProductPageReader {
  fetch(request: ProductPageFetchRequest): Promise<ProductPageFetchOutcome>;
}

// ---------------------------------------------------------------------------
// Structural ports (frozen-matrix-compliant /integrations + /ai-runtime,
// both READ-ONLY; the /growth-missions precedent)
// ---------------------------------------------------------------------------

/** The narrow /integrations connection snapshot this module consumes. */
export interface ProductIntelligenceConnectionSnapshot {
  readonly connectionId: string;
  readonly clientId: string;
  readonly agencyId: string;
  readonly adapterKey: string;
  readonly providerLabel: string;
  readonly status: string;
}

/** One normalized provider record observed through an authorized read. */
export interface ProductIntelligenceProviderRecord {
  readonly providerRecordId: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly sourceTimestamp: string | null;
  readonly etag: string | null;
  readonly sourceVersion: string | null;
}

/** The authorized-read outcome — DATA, never a thrown invocation failure. */
export interface ProductIntelligenceReadOutcome {
  readonly ok: boolean;
  readonly records: readonly ProductIntelligenceProviderRecord[];
  readonly error: string | null;
  readonly adapterKey: string;
}

/**
 * THE NARROW /integrations PORT (READ-ONLY — boundary rule 7 made
 * structural): canonical connection resolution + the authorized READ
 * surface ONLY. executeMutation, registration and webhook ingestion are
 * STRUCTURALLY ABSENT from this port — the module cannot express a
 * mutation toward any external source. The real IntegrationsModuleApi
 * satisfies this port structurally at the composition root.
 */
export interface ProductIntelligenceIntegrationsPort {
  getConnection(
    connectionId: string,
  ): Promise<ProductIntelligenceConnectionSnapshot | null>;
  executeRead(
    input: {
      readonly connectionId: string;
      readonly operation: string;
      readonly parameters: Readonly<Record<string, unknown>>;
    },
    provenance: ProductIntelligenceProvenance,
  ): Promise<ProductIntelligenceReadOutcome>;
}

/** The narrow /ai-runtime model snapshot this module consumes. */
export interface ProductIntelligenceModelSnapshot {
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
export interface ProductIntelligenceAiRuntimePort {
  getModel(modelRegistryId: string): Promise<ProductIntelligenceModelSnapshot | null>;
}

// ---------------------------------------------------------------------------
// Canonical owner context (implementation-contract §2)
// ---------------------------------------------------------------------------

/**
 * The CANONICAL PRODUCT CONTEXT OWNER CONTEXT: the single server-side
 * resolution of WHICH agency owns the product context, derived from
 * durable state on every call. Context-scoped operations authorize against
 * this context — never against caller-supplied tenant or context identity.
 * The agency ROW is resolved at the route layer (/agencies is not a frozen
 * allowance of this module's dependency row — the /app-metering precedent);
 * this context carries the scope identity the route layer authorizes.
 */
export interface ProductContextOwnerContext {
  readonly scope: {
    readonly kind: 'product-context';
    readonly agencyId: string;
    readonly productContextId: string;
  };
  readonly context: ProductContextRecord;
  readonly resolvedAt: string;
}

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

export interface ProductIntelligenceModuleApi {
  /**
   * Creates an AGENCY-SCOPED Product Context (version 1 of the declared
   * inputs). The agency scope is validated at the ROUTE layer (uniform 404
   * unknown/malformed; the migration-048 FK anchor is the backstop). The
   * declared inputs are validated against the frozen kind/authorization
   * fence (web kinds public; authorized kinds carry a canonical
   * integration-connection reference that must EXIST and belong to the
   * context's agency — the uniform 404 for a foreign/unknown connection;
   * a non-connected connection is an honest 409: authorized reads require
   * an authorized integration).
   */
  createProductContext(
    input: {
      readonly agencyId: string;
      readonly declaration: ProductContextDeclarationInput;
    },
    provenance: ProductIntelligenceProvenance,
  ): Promise<ProductContextDetail>;

  /** Raw context record by id. */
  getProductContext(productContextId: string): Promise<ProductContextRecord | null>;

  /**
   * Canonical ownership resolution: the context record composed into the
   * canonical owner context. Null when the context does not exist —
   * callers surface the uniform 404 so foreign and unknown identifiers
   * are indistinguishable.
   */
  resolveProductContextOwnership(
    productContextId: string,
  ): Promise<ProductContextOwnerContext | null>;

  /** The agency's product contexts (oldest first). */
  listProductContextsForAgency(
    agencyId: string,
  ): Promise<readonly ProductContextRecord[]>;

  /**
   * The composed honest read-back: record + CURRENT declared version +
   * the full version tail + the retained source facts + the derived model
   * records with evidence links + the risk flags + the inspection runs +
   * the claim-tier disclosure. This is the MISSION ATTACHMENT SEAM read
   * surface (MKT-070 attaches by reference — no mission logic here).
   */
  getProductContextDetail(
    productContextId: string,
  ): Promise<ProductContextDetail | null>;

  /** The append-only version tail (oldest first). Null when unknown. */
  getProductContextVersions(
    productContextId: string,
  ): Promise<readonly ProductContextVersionRecord[] | null>;

  /** The retained source-fact tail (oldest first). Null when unknown. */
  getProductContextSourceFacts(
    productContextId: string,
  ): Promise<readonly ProductSourceFactRecord[] | null>;

  /** The derived model records (oldest first). Null when unknown. */
  getProductContextDerivedModels(
    productContextId: string,
  ): Promise<readonly ProductDerivedModelRecord[] | null>;

  /** The risk flags (oldest first). Null when unknown. */
  getProductContextRiskFlags(
    productContextId: string,
  ): Promise<readonly ProductRiskFlagRecord[] | null>;

  /** The inspection runs (oldest first). Null when unknown. */
  getProductContextInspectionRuns(
    productContextId: string,
  ): Promise<readonly ProductInspectionRunRecord[] | null>;

  /**
   * Records a NEW declared version (the correction path — the declared
   * inputs are IMMUTABLE per version; corrections are NEW version
   * records, never in-place rewrites). CAS on the context's `version`
   * (ConflictError on loss); the version pointer only ever ADVANCES.
   */
  recordProductContextVersion(
    input: {
      readonly productContextId: string;
      readonly declaration: ProductContextDeclarationInput;
      readonly expectedVersion: number;
    },
    provenance: ProductIntelligenceProvenance,
  ): Promise<ProductContextDetail>;

  /**
   * Runs the DETERMINISTIC INSPECTION over the context's CURRENT declared
   * inputs: public web inputs are fetched through the page-reader port
   * (GET-only) and deterministically extracted; authorized inputs are read
   * through the /integrations port (READ-ONLY — the connection must be
   * 'connected' and belong to the context's agency; a non-authorized input
   * is REFUSED HONESTLY with the 'unauthorized_refused' outcome — boundary
   * rule 7). Every material source fact is retained with FULL provenance
   * (source ref, fetched-at, extractor identity, content hash, extraction
   * notes); every input's outcome is recorded honestly (the per-input
   * outcome rows). Row-locked against concurrent corrections: a version
   * change mid-flight is an honest 409 (re-run inspects the new inputs).
   */
  runProductInspection(
    input: {
      readonly productContextId: string;
    },
    provenance: ProductIntelligenceProvenance,
  ): Promise<ProductInspectionRunRecord>;

  /**
   * Records one DERIVED MODEL record (a §8 derivation CLAIM). The
   * verification state is computed SERVER-SIDE from the cited evidence
   * (≥1 resolvable source fact of the SAME context → 'evidence_backed';
   * none → 'unverified') — never caller-declared. Each cited sourceFactId
   * must resolve to a retained source fact of the SAME context (uniform
   * 404 otherwise — a foreign fact id is not an oracle). The AI-assistance
   * disclosure, when present, must cite a model that resolves through the
   * /ai-runtime registry (uniform 404 otherwise). The optional
   * supersedesDerivedModelId is the correction path (same context, same
   * derivation kind, not already superseded — the single-supersession
   * fence; verification-state transitions ride this chain).
   */
  recordDerivedModel(
    input: {
      readonly productContextId: string;
      readonly derivationKind: ProductIntelligenceDerivationKind;
      readonly statement: Readonly<Record<string, unknown>>;
      readonly evidenceSourceFactIds: readonly string[];
      readonly aiAssistance: ProductDerivedModelAiAssistanceInput | null;
      readonly supersedesDerivedModelId: string | null;
    },
    provenance: ProductIntelligenceProvenance,
  ): Promise<ProductDerivedModelRecord>;

  /** Raw derived-model record by id (superseded records included — history stays readable). */
  getDerivedModel(derivedModelId: string): Promise<ProductDerivedModelRecord | null>;

  /**
   * Records one RISK FLAG (compliance/privacy/toxicity/commercial/
   * operational) with severity, optional mitigation and optional evidence
   * references (same-context source facts — uniform 404 otherwise).
   * Append-only.
   */
  recordProductRiskFlag(
    input: {
      readonly productContextId: string;
      readonly category: ProductIntelligenceRiskCategory;
      readonly severity: ProductIntelligenceRiskSeverity;
      readonly statement: Readonly<Record<string, unknown>>;
      readonly mitigation: string | null;
      readonly evidenceSourceFactIds: readonly string[];
    },
    provenance: ProductIntelligenceProvenance,
  ): Promise<ProductRiskFlagRecord>;

  /** Raw risk-flag record by id (append-only history is always readable). */
  getProductRiskFlag(riskFlagId: string): Promise<ProductRiskFlagRecord | null>;
}

/** The declared context content — exactly what rides an IMMUTABLE version record. */
export interface ProductContextDeclarationInput {
  /** The product's declared name (bounded). */
  readonly name: string | null;
  /** The bounded declared summary. */
  readonly summary: string | null;
  /** The declared inputs (1..40, declaration order preserved). */
  readonly inputs: readonly ProductContextInputDeclaration[];
}

/** One declared input — a kind, a bounded reference and its authorization state. */
export interface ProductContextInputDeclaration {
  readonly kind: ProductIntelligenceInputKind;
  readonly reference: string;
  readonly authorization: ProductIntelligenceAuthorizationState;
  /** REQUIRED for the authorized kinds; must be null for the public web kinds. */
  readonly integrationConnectionId: string | null;
}

/** The AI-assistance disclosure input (validated against the /ai-runtime registry). */
export interface ProductDerivedModelAiAssistanceInput {
  readonly modelRegistryId: string;
  readonly callReference: string;
}

export interface ProductIntelligenceModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** The in-repo page-reader contract (test double in tests; the platform HttpCallPort adapter in production). */
  readonly pageReader: ProductPageReader;
  /** Matrix-listed direction (/product-intelligence ──→ /integrations): READ-ONLY authorized source reads. */
  readonly integrations: ProductIntelligenceIntegrationsPort;
  /** Matrix-listed direction (/product-intelligence ──→ /ai-runtime): model-identity resolution for the AI disclosure. */
  readonly aiRuntime: ProductIntelligenceAiRuntimePort;
}

export { createProductIntelligenceModule } from './internal/product-intelligence-module.ts';
/**
 * The input guards (declaration/derived/risk/provenance validation, the
 * §21 material-key backstop and the deterministic HTML extractor) —
 * exported for unit tests and future server-side callers (the MKT-070
 * planner composes these same commands) so the guard semantics are part
 * of the module contract. Pure functions.
 */
export {
  assertValidProductContextDeclaration,
  assertValidProductIntelligenceProvenance,
  assertValidProductDerivedModelInput,
  assertValidProductRiskFlagInput,
  composeProductContextOwnerContext,
  derivedVerificationState,
  extractHtmlSourceFacts,
  hashContent,
  PRODUCT_INTELLIGENCE_STATEMENT_SUMMARY_MAX,
} from './internal/product-intelligence-store.ts';
