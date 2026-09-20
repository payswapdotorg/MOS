/**
 * MarketingOS module: /product-intelligence
 * Authority: Product Intelligence (MKT-069 —
 * spec/effective-backlog-v1.6.md section E; spec/architecture-v1.6.md §7/§8;
 * spec/module-dependency-matrix-v1.6.md boundary rule 7).
 *
 * MKT-069 implements the durable PRODUCT/MARKET INSPECTION AND MODEL record
 * layer of v1.6:
 *
 *   - the AGENCY-SCOPED PRODUCT CONTEXT records (architecture-v1.6.md §8:
 *     "A mission can optionally attach a Product Context.") carrying the
 *     DECLARED INPUTS — public product/site URL(s), authenticated
 *     application environment, source-code repository URL(s), connected
 *     source workspace, product documentation, catalog/inventory and
 *     current analytics — each input carrying its AUTHORIZATION STATE
 *     (public vs explicitly authorized; the explicitly-authorized inputs
 *     carry their /integrations connection reference). Corrections are NEW
 *     version records, never in-place rewrites (the /growth-missions
 *     version-tail discipline);
 *   - the DETERMINISTIC INSPECTION PIPELINE: fetch/extract over public
 *     product/site pages through the FETCHER PORT (read-only — the port
 *     has exactly ONE method, fetch; there is NO write method to
 *     implement), and authorized repository/workspace reads through the
 *     /integrations public contract's READ-ONLY surface (the narrow port
 *     below exposes resolveConnectionOwnership + executeRead ONLY — the
 *     mutation surface of /integrations is deliberately absent from the
 *     port type, so this module CANNOT express an external write even if
 *     it wanted to);
 *   - the APPEND-ONLY SOURCE-FACT LEDGER: every material source fact
 *     retained with FULL provenance — source URL/reference, fetched-at,
 *     extractor identity, content hash, extraction notes
 *     (architecture-v1.6.md §7: "Every material source fact retains source
 *     provenance."). Facts are EXTRACTED OBSERVATIONS, never conclusions;
 *   - the APPEND-ONLY DERIVED MODEL RECORDS (the §8 derivation set):
 *     product capabilities, user/problem hypotheses, ICP/audience
 *     hypotheses, value propositions, conversion paths, content-worthy
 *     features, market language, product risks and commercial metrics to
 *     optimize. Each derived record carries (a) the backing source-fact
 *     references (+ optional canonical /evidence citations), (b) the
 *     ai-runtime assistance disclosure when derived with model help, and
 *     (c) the server-derived VERIFICATION STATE — a derived record
 *     without backing evidence references is 'unverified' and can never
 *     be presented as established (§7: "Model output is a claim unless
 *     backed by evidence."). Hypotheses are hypotheses: the two hypothesis
 *     kinds are born hypotheses (frozen flag, no promotion path exists)
 *     and never become facts by repetition (identical restatements are
 *     rejected);
 *   - the APPEND-ONLY RISK-FLAG records: compliance/privacy/toxicity/
 *     commercial/operational risks with the severity vocabulary,
 *     provenance and the same evidence-backing discipline;
 *   - the MISSION ATTACHMENT SEAM (read surface only): missions
 *     (MKT-070 — the Product Marketing Mission Planner, a LATER Work
 *     Item) attach these model records BY REFERENCE through the read
 *     surface below. NO mission-strategy, channel-mix, metric-selection
 *     or planning logic lives in this module.
 *
 * What this module deliberately does NOT do (bounded scope, MKT-069):
 *
 *   - NO write capability toward ANY external source (boundary rule 7:
 *     "Product Intelligence has read-only source-code/product inspection
 *     unless a separate write capability is explicitly granted"). The
 *     future write seam is DOCUMENTED below
 *     (PRODUCT_INTELLIGENCE_WRITE_CAPABILITY_SEAM) and deliberately NOT
 *     built: no code path consumes it, no route exists for it, and the
 *     ports cannot express it;
 *   - NO mission planning (MKT-070), NO web research/niche clustering
 *     (MKT-062 — the /research direction joins the module's frozen matrix
 *     row at MKT-062 time), NO content/candidate records, NO experiment
 *   - NO second evidence authority: source facts are THIS module's
 *     observation ledger; canonical evidence records remain /evidence's
 *     alone (cited read-only through the evidence port);
 *   - NO provider SDK, NO platform-specific knowledge: authorized reads
 *     flow through the /integrations public contract only.
 *
 * DEPENDENCY POSTURE (the frozen v1.6 matrix row
 * /product-intelligence ──→ /research, /evidence, /integrations, /ai-runtime;
 * this delivery registers the currently-satisfiable subset
 * /product-intelligence ──→ /evidence, /integrations, /ai-runtime —
 * /research arrives with MKT-062, disclosed in docs/implementation/MKT-069.md):
 * every consumed public contract arrives through declared narrow STRUCTURAL
 * PORTS declared in this file — ZERO imports of any other module exist
 * anywhere under src/modules/product-intelligence (proven by
 * tools/arch-check and tests/architecture/product-intelligence-boundary.test.ts;
 * the /growth-missions structural-port precedent). The agency-row
 * resolution port is a DISCLOSED OFF-MATRIX structural port (the
 * /app-installs MKT-050 precedent) — the frozen row stays exactly as
 * registered.
 *
 * Cross-module access may only target this public entry (public.ts) —
 * internal/ is unimportable from other modules (enforced by the static
 * architecture checker, tools/arch-check).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';

// ---------------------------------------------------------------------------
// The frozen vocabularies (architecture-v1.6.md §8 — versioned, never
// silently re-stated; the am-meter-v1 / gm-vocab-v1 discipline)
// ---------------------------------------------------------------------------

/**
 * The frozen §8 input-kind vocabulary (verbatim): the declared inputs a
 * Product Context may carry.
 */
export const PRODUCT_INTELLIGENCE_INPUT_KINDS = [
  'public_site_url',
  'authenticated_app_environment',
  'source_code_repository_url',
  'connected_source_workspace',
  'product_documentation',
  'catalog_inventory',
  'current_analytics',
] as const;

export type ProductIntelligenceInputKind = (typeof PRODUCT_INTELLIGENCE_INPUT_KINDS)[number];

export function isKnownProductIntelligenceInputKind(
  value: string,
): value is ProductIntelligenceInputKind {
  return (PRODUCT_INTELLIGENCE_INPUT_KINDS as readonly string[]).includes(value);
}

/**
 * The input authorization-state vocabulary (AC-1): every declared input
 * carries its authorization state — 'public' (inspectable as a public
 * source) or 'explicitly_authorized' (readable ONLY through the declared
 * /integrations connection reference).
 */
export const PRODUCT_INTELLIGENCE_AUTHORIZATION_STATES = [
  'public',
  'explicitly_authorized',
] as const;

export type ProductIntelligenceAuthorizationState =
  (typeof PRODUCT_INTELLIGENCE_AUTHORIZATION_STATES)[number];

export function isKnownProductIntelligenceAuthorizationState(
  value: string,
): value is ProductIntelligenceAuthorizationState {
  return (PRODUCT_INTELLIGENCE_AUTHORIZATION_STATES as readonly string[]).includes(value);
}

/**
 * The frozen per-kind authorization map (the disclosed MKT-069
 * implementation decision, CHECK-fenced in migration 048): a public
 * product/site URL is public ONLY; an authenticated application
 * environment and a connected source workspace are explicitly authorized
 * ONLY; the remaining kinds may be declared either way (public
 * repositories, public documentation, public catalogs and public analytics
 * exist, and their authorized counterparts exist too).
 */
export const PRODUCT_INTELLIGENCE_INPUT_AUTHORIZATIONS: Readonly<
  Record<ProductIntelligenceInputKind, readonly ProductIntelligenceAuthorizationState[]>
> = {
  public_site_url: ['public'],
  authenticated_app_environment: ['explicitly_authorized'],
  source_code_repository_url: ['public', 'explicitly_authorized'],
  connected_source_workspace: ['explicitly_authorized'],
  product_documentation: ['public', 'explicitly_authorized'],
  catalog_inventory: ['public', 'explicitly_authorized'],
  current_analytics: ['public', 'explicitly_authorized'],
};

/**
 * The frozen §8 derivation-kind vocabulary (verbatim, the full nine):
 * what Product Intelligence derives from the inspected inputs.
 */
export const PRODUCT_INTELLIGENCE_DERIVATION_KINDS = [
  'product_capability',
  'user_problem_hypothesis',
  'icp_audience_hypothesis',
  'value_proposition',
  'conversion_path',
  'content_worthy_feature',
  'market_language',
  'product_risk',
  'commercial_metric',
] as const;

export type ProductIntelligenceDerivationKind =
  (typeof PRODUCT_INTELLIGENCE_DERIVATION_KINDS)[number];

export function isKnownProductIntelligenceDerivationKind(
  value: string,
): value is ProductIntelligenceDerivationKind {
  return (PRODUCT_INTELLIGENCE_DERIVATION_KINDS as readonly string[]).includes(value);
}

/**
 * The HYPOTHESIS kinds: user/problem hypotheses and ICP/audience
 * hypotheses are BORN hypotheses (the frozen flag rides the record; no
 * promotion path exists — hypotheses never become facts by repetition).
 */
export const PRODUCT_INTELLIGENCE_HYPOTHESIS_KINDS = [
  'user_problem_hypothesis',
  'icp_audience_hypothesis',
] as const;

export type ProductIntelligenceHypothesisKind =
  (typeof PRODUCT_INTELLIGENCE_HYPOTHESIS_KINDS)[number];

export function isHypothesisDerivationKind(
  kind: ProductIntelligenceDerivationKind,
): boolean {
  return (PRODUCT_INTELLIGENCE_HYPOTHESIS_KINDS as readonly string[]).includes(kind);
}

/**
 * The verification-state vocabulary (AC-3c): a derived record without
 * backing evidence references is 'unverified' and can never be presented
 * as established; a record with at least one backing reference (source
 * fact or canonical evidence citation) is 'evidence_backed'. The state is
 * SERVER-DERIVED from the backing (deriveVerificationState below — the
 * pure function; the migration-048 CHECK fence is the durable backstop)
 * and can never be caller-asserted.
 */
export const PRODUCT_INTELLIGENCE_VERIFICATION_STATES = [
  'unverified',
  'evidence_backed',
] as const;

export type ProductIntelligenceVerificationState =
  (typeof PRODUCT_INTELLIGENCE_VERIFICATION_STATES)[number];

/**
 * The frozen risk-kind vocabulary (AC-4): compliance, privacy, toxicity,
 * commercial, operational.
 */
export const PRODUCT_INTELLIGENCE_RISK_KINDS = [
  'compliance',
  'privacy',
  'toxicity',
  'commercial',
  'operational',
] as const;

export type ProductIntelligenceRiskKind = (typeof PRODUCT_INTELLIGENCE_RISK_KINDS)[number];

export function isKnownProductIntelligenceRiskKind(
  value: string,
): value is ProductIntelligenceRiskKind {
  return (PRODUCT_INTELLIGENCE_RISK_KINDS as readonly string[]).includes(value);
}

/**
 * The frozen severity vocabulary (AC-4; the /ai-runtime risk-class
 * precedent — low/medium/high).
 */
export const PRODUCT_INTELLIGENCE_RISK_SEVERITIES = ['low', 'medium', 'high'] as const;

export type ProductIntelligenceRiskSeverity = (typeof PRODUCT_INTELLIGENCE_RISK_SEVERITIES)[number];

export function isKnownProductIntelligenceRiskSeverity(
  value: string,
): value is ProductIntelligenceRiskSeverity {
  return (PRODUCT_INTELLIGENCE_RISK_SEVERITIES as readonly string[]).includes(value);
}

/**
 * The frozen vocabulary version (the am-meter-v1 / gm-vocab-v1
 * discipline): the input kinds, the authorization states + per-kind map,
 * the derivation kinds, the hypothesis kinds, the verification states,
 * the risk kinds and the severities below. A change to ANY of them is a
 * NEW version string — the vocabularies are versioned, never silently
 * re-stated.
 */
export const PRODUCT_INTELLIGENCE_VOCABULARY_VERSION = 'pi-vocab-v1' as const;

/**
 * The disclosed inspection capability (AC-5): the inspection contract
 * supports fetch/read operations ONLY. This constant ships on every
 * composed read so the read-only guarantee is disclosed, not implicit.
 */
export const PRODUCT_INTELLIGENCE_INSPECTION_CAPABILITY =
  'source-inspection:fetch-read-only' as const;

/**
 * THE DOCUMENTED WRITE SEAM (AC-5 / boundary rule 7 — documented, NOT
 * built): a future write capability toward an external source would
 * require a SEPARATELY GRANTED capability key — a distinct, explicit
 * authorization surface of its own Work Item (its own port, its own
 * policy gates, its own migration). This constant is the named seam; NO
 * code path consumes it, NO route exists for it, and none of this
 * module's ports can express a write. It exists so the boundary is a
 * documented contract rather than an implicit absence.
 */
export const PRODUCT_INTELLIGENCE_WRITE_CAPABILITY_SEAM =
  'product-intelligence.source-write:separately-granted-capability-key (documented seam — NOT built; boundary rule 7)' as const;

/**
 * The disclosed provider-neutral read-operation label the inspection
 * pipeline issues through the /integrations public contract for
 * explicitly-authorized inputs. Repo/workspace-capable adapters declare
 * this operation on a read capability; an adapter that does not declare
 * it fails the read honestly (capability discovery inside /integrations).
 */
export const PRODUCT_INTELLIGENCE_INSPECTION_READ_OPERATION = 'source.read' as const;

// ---------------------------------------------------------------------------
// Provenance (server-derived — implementation-contract §3)
// ---------------------------------------------------------------------------

/**
 * SERVER-DERIVED provenance for every module mutation (the
 * growth-missions pattern): built exclusively from the authenticated
 * principal, the ambient correlation context and the recording surface —
 * never from a request body (route validation rejects provenance-shaped
 * authority fields; this type is a separate module-API argument so no DTO
 * can feed it structurally). `recordedAt` is stamped by the module clock.
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
export interface ProductIntelligenceRecordedProvenance extends ProductIntelligenceProvenance {
  /** Server-stamped recording time (module clock, never caller input). */
  readonly recordedAt: string;
}

// ---------------------------------------------------------------------------
// The declared content (the immutable version records)
// ---------------------------------------------------------------------------

/**
 * ONE declared input (AC-1): the input kind (the frozen §8 vocabulary),
 * the source reference (a public URL, a repository URL, a documentation /
 * catalog / analytics reference), the authorization state and — for an
 * explicitly-authorized input — the /integrations connection id that
 * authorizes the read (null for public inputs).
 */
export interface ProductContextInputDeclaration {
  readonly inputKind: ProductIntelligenceInputKind;
  readonly reference: string;
  readonly authorizationState: ProductIntelligenceAuthorizationState;
  /** The /integrations connection id authorizing an explicitly-authorized input. */
  readonly authorizationRef: string | null;
  /** Optional bounded annotation. */
  readonly notes: string | null;
}

/**
 * The declared product context content — exactly what rides an IMMUTABLE
 * version record. At least one input is required: a product context with
 * nothing to inspect is not a product context.
 */
export interface ProductContextDeclaration {
  /** The product name (bounded). */
  readonly name: string;
  /** Optional bounded free-form summary of the product. */
  readonly summary: string | null;
  /** The declared inputs (1..50, each carrying its authorization state). */
  readonly inputs: readonly ProductContextInputDeclaration[];
}

// ---------------------------------------------------------------------------
// The ai-runtime assistance disclosure (AC-3b)
// ---------------------------------------------------------------------------

/**
 * The model-assistance disclosure a derived record / risk flag carries
 * when it was produced with ai-runtime assistance: the model identity and
 * the /ai-runtime selection-decision call reference. The module validates
 * the disclosure through the /ai-runtime public contract (the selection
 * decision must resolve, belong to the context's agency, and its chosen
 * model registry id must MATCH the disclosed model identity) — the
 * disclosure is cross-checked, never self-attested.
 */
export interface ProductIntelligenceAiAssistance {
  /**
   * The model identity — exactly the /ai-runtime model-registry id the
   * referenced selection decision actually chose (cross-checked at
   * record time; a mismatch is an honest ConflictError).
   */
  readonly modelIdentity: string;
  /** The /ai-runtime selection-decision id the derivation was produced through. */
  readonly callReference: string;
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

/** One IMMUTABLE version record of the declared content (append-only tail). */
export interface ProductContextVersionRecord {
  readonly productContextVersionId: string;
  readonly productContextId: string;
  readonly versionSeq: number;
  readonly name: string;
  readonly summary: string | null;
  readonly provenance: ProductIntelligenceRecordedProvenance;
}

/** One declared input as persisted (append-only with its version snapshot). */
export interface ProductContextInputRecord {
  readonly inputId: string;
  readonly productContextVersionId: string;
  readonly inputKind: ProductIntelligenceInputKind;
  readonly reference: string;
  readonly authorizationState: ProductIntelligenceAuthorizationState;
  readonly authorizationRef: string | null;
  readonly notes: string | null;
}

/**
 * One append-only SOURCE FACT: a retained material observation with FULL
 * provenance — the source URL/reference, the fetched-at time, the
 * extractor identity, the content hash and the extraction notes. The
 * observation payload is the EXTRACTED OBSERVATION, never a conclusion.
 */
export interface ProductSourceFactRecord {
  readonly sourceFactId: string;
  readonly productContextId: string;
  readonly productContextVersionId: string;
  readonly inputId: string;
  readonly sourceUrl: string;
  readonly fetchedAt: string;
  readonly extractor: string;
  readonly contentHash: string;
  readonly extractionNotes: string | null;
  readonly observation: Readonly<Record<string, unknown>>;
  readonly provenance: ProductIntelligenceRecordedProvenance;
}

/**
 * One append-only DERIVED MODEL record (the §8 derivation set): a model
 * CLAIM — never an observation — carrying the backing source-fact
 * references, the canonical /evidence citations, the ai-runtime
 * assistance disclosure (when produced with model help), the
 * server-derived verification state and the frozen hypothesis flag.
 */
export interface ProductDerivedModelRecord {
  readonly derivedModelId: string;
  readonly productContextId: string;
  readonly productContextVersionId: string;
  readonly derivationKind: ProductIntelligenceDerivationKind;
  /** The derived statement — the claim/hypothesis, VERBATIM. */
  readonly statement: string;
  readonly detail: Readonly<Record<string, unknown>> | null;
  /** The backing source-fact ids (the AC-3 evidence links). */
  readonly sourceFactIds: readonly string[];
  /** Canonical /evidence record ids cited as additional backing. */
  readonly evidenceCitations: readonly string[];
  /** The model-assistance disclosure (null when derived without AI assistance). */
  readonly aiAssistance: ProductIntelligenceAiAssistance | null;
  readonly verificationState: ProductIntelligenceVerificationState;
  /** TRUE exactly for the two hypothesis kinds — frozen at record time. */
  readonly hypothesis: boolean;
  readonly provenance: ProductIntelligenceRecordedProvenance;
}

/** One append-only RISK-FLAG record (AC-4). */
export interface ProductRiskFlagRecord {
  readonly riskFlagId: string;
  readonly productContextId: string;
  readonly productContextVersionId: string;
  readonly riskKind: ProductIntelligenceRiskKind;
  readonly severity: ProductIntelligenceRiskSeverity;
  readonly statement: string;
  readonly sourceFactIds: readonly string[];
  readonly evidenceCitations: readonly string[];
  readonly aiAssistance: ProductIntelligenceAiAssistance | null;
  readonly provenance: ProductIntelligenceRecordedProvenance;
}

/**
 * The composed product-context read model: the record, the CURRENT
 * declared version with its inputs, and the complete append-only ledgers
 * (source facts, derived models, risk flags) — the honest read-back
 * surface (AC-7) and the mission-attachment read seam (AC-6: MKT-070
 * attaches these records BY REFERENCE through this surface).
 */
export interface ProductContextDetail {
  readonly context: ProductContextRecord;
  /** The CURRENT declared version (name + summary + provenance). */
  readonly currentVersion: ProductContextVersionRecord;
  /** The CURRENT version's declared inputs. */
  readonly inputs: readonly ProductContextInputRecord[];
  /** The complete source-fact ledger (oldest first). */
  readonly sourceFacts: readonly ProductSourceFactRecord[];
  /** The complete derived-model records (oldest first). */
  readonly derivedModels: readonly ProductDerivedModelRecord[];
  /** The complete risk-flag records (oldest first). */
  readonly riskFlags: readonly ProductRiskFlagRecord[];
  /** The frozen vocabulary version, disclosed on every view. */
  readonly vocabularyVersion: typeof PRODUCT_INTELLIGENCE_VOCABULARY_VERSION;
  /** The read-only inspection capability, disclosed on every view. */
  readonly inspectionCapability: typeof PRODUCT_INTELLIGENCE_INSPECTION_CAPABILITY;
}

// ---------------------------------------------------------------------------
// Canonical ownership ports (frozen-matrix-compliant structural ports —
// the /growth-missions precedent; ZERO cross-module imports)
// ---------------------------------------------------------------------------

/**
 * Narrow STRUCTURAL view of the /agencies public contract this module
 * consumes for the fail-closed agency-scope resolution — a DISCLOSED
 * OFF-MATRIX structural port (the /app-installs MKT-050 precedent: the
 * frozen matrix row stays exactly as registered; the port is wired at the
 * composition root where the real AgenciesModuleApi satisfies it
 * structurally). /agencies remains the ONLY agency authority.
 */
export interface ProductIntelligenceAgencySnapshot {
  readonly agencyId: string;
  readonly status: string;
}

export interface ProductIntelligenceAgencyPort {
  getAgency(agencyId: string): Promise<ProductIntelligenceAgencySnapshot | null>;
}

/**
 * Narrow STRUCTURAL view of the /evidence public contract this module
 * consumes (READ-ONLY — the /decisions evidence-citation precedent): the
 * canonical ownership resolution used to validate canonical /evidence
 * citations on derived records and risk flags. The real
 * EvidenceModuleApi satisfies this structurally — /evidence remains the
 * ONLY evidence/provenance authority and is NEVER mutated from here.
 */
export interface ProductIntelligenceEvidenceOwnershipSnapshot {
  readonly scope: {
    readonly agencyId: string;
    readonly clientId: string;
    readonly evidenceId: string;
  };
  readonly evidence: {
    readonly evidenceId: string;
    readonly clientId: string;
  };
}

export interface ProductIntelligenceEvidencePort {
  resolveEvidenceOwnership(
    evidenceId: string,
  ): Promise<ProductIntelligenceEvidenceOwnershipSnapshot | null>;
}

/**
 * Narrow STRUCTURAL view of the /ai-runtime public contract this module
 * consumes (READ-ONLY — the model-call provenance disclosure patterns):
 * the selection-decision lookup used to cross-check the ai-assistance
 * disclosure on derived records and risk flags. The real
 * AiRuntimeModuleApi satisfies this structurally — /ai-runtime remains
 * the ONLY AI routing authority and is NEVER mutated from here.
 */
export interface ProductIntelligenceSelectionSnapshot {
  readonly selectionId: string;
  readonly agencyId: string;
  readonly chosenModelRegistryId: string;
}

export interface ProductIntelligenceAiRuntimePort {
  getSelectionDecision(
    selectionId: string,
  ): Promise<ProductIntelligenceSelectionSnapshot | null>;
}

/**
 * Narrow STRUCTURAL view of the /integrations public contract this module
 * consumes (READ-ONLY — the authorized external-read path, AC-2): the
 * canonical connection ownership resolution (the authorized-input
 * validation) and the normalized READ surface. THE READ-ONLY GUARANTEE IS
 * STRUCTURAL: this port deliberately exposes resolveConnectionOwnership
 * and executeRead ONLY — the /integrations mutation surface
 * (executeMutation, connection registration, lifecycle transitions) is
 * ABSENT from the port type, so this module cannot express an external
 * write even if it wanted to (boundary rule 7). The real
 * IntegrationsModuleApi satisfies this structurally.
 */
export interface ProductIntelligenceConnectionSnapshot {
  readonly connectionId: string;
  readonly clientId: string;
  readonly agencyId: string;
  readonly status: string;
}

export interface ProductIntelligenceConnectionOwnershipSnapshot {
  readonly scope: {
    readonly agencyId: string;
    readonly clientId: string;
    readonly connectionId: string;
  };
  readonly connection: ProductIntelligenceConnectionSnapshot;
}

/** One normalized provider record as surfaced by the read outcome. */
export interface ProductIntelligenceProviderRecord {
  readonly providerRecordId: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly sourceTimestamp: string | null;
  readonly etag: string | null;
  readonly sourceVersion: string | null;
}

/** The narrowed read outcome (invocation-level failures are DATA, never thrown). */
export interface ProductIntelligenceReadOutcome {
  readonly ok: boolean;
  readonly records: readonly ProductIntelligenceProviderRecord[];
  readonly error: string | null;
}

export interface ProductIntelligenceIntegrationsPort {
  resolveConnectionOwnership(
    connectionId: string,
  ): Promise<ProductIntelligenceConnectionOwnershipSnapshot | null>;
  /**
   * One normalized READ operation (READ-ONLY — there is deliberately NO
   * mutation method on this port).
   */
  executeRead(
    input: {
      readonly connectionId: string;
      readonly operation: string;
      readonly parameters: Readonly<Record<string, unknown>>;
    },
    provenance: ProductIntelligenceProvenance,
  ): Promise<ProductIntelligenceReadOutcome>;
}

// ---------------------------------------------------------------------------
// The fetcher port (AC-2: deterministic fetch over public product/site
// pages — READ-ONLY by construction)
// ---------------------------------------------------------------------------

/** One public-source fetch outcome (transport failures are DATA, never thrown). */
export interface ProductSourceFetch {
  readonly url: string;
  readonly ok: boolean;
  readonly status: number;
  readonly contentType: string | null;
  /** The bounded text body (null when the fetch did not yield a body). */
  readonly body: string | null;
  /** When the fetch completed (module-clock stamped by the implementation). */
  readonly fetchedAt: string;
}

/**
 * THE PRODUCT SOURCE FETCHER PORT (AC-2): the read-only fetch contract of
 * the inspection pipeline. The port has EXACTLY ONE method — fetch — and
 * NO write method exists on it (the read-only guarantee made structural;
 * boundary rule 7). The production implementation rides the platform
 * HttpCallPort (wired at the composition root); the test suite supplies
 * the DISCLOSED IN-REPO TEST DOUBLE (a deterministic URL→content map — NO
 * live network in the test suite) and a loopback fixture-page server for
 * the production-fetcher HTTP path (the oauth-provider precedent).
 */
export interface ProductSourceFetcher {
  fetch(url: string): Promise<ProductSourceFetch>;
}

// ---------------------------------------------------------------------------
// Canonical owner context (implementation-contract §2)
// ---------------------------------------------------------------------------

/** The canonical product-context ownership context (the route-layer input). */
export interface ProductContextOwnerContext {
  readonly scope: {
    readonly kind: 'product-context';
    readonly agencyId: string;
    readonly productContextId: string;
  };
  readonly context: ProductContextRecord;
  /** The /agencies row resolved through the disclosed structural port. */
  readonly agency: ProductIntelligenceAgencySnapshot;
  readonly resolvedAt: string;
}

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

export interface ProductIntelligenceModuleApi {
  /**
   * Creates an AGENCY-SCOPED Product Context (born at version 1 of the
   * declared content). The agency resolves SERVER-SIDE through the
   * disclosed /agencies structural port BEFORE any write: unknown agency
   * → NotFoundError (uniform 404); a disabled agency blocks new use
   * (ConflictError) without rewriting history. The declaration must
   * carry at least one input; every explicitly-authorized input must
   * carry an authorizationRef that resolves through the /integrations
   * port to a connection of the SAME agency (unknown/foreign → the
   * uniform 404 — a foreign connection identifier is not a
   * traversal/existence oracle).
   */
  createProductContext(
    input: {
      readonly agencyId: string;
      readonly declaration: ProductContextDeclaration;
    },
    provenance: ProductIntelligenceProvenance,
  ): Promise<ProductContextDetail>;

  /** Raw context record by id. */
  getProductContext(productContextId: string): Promise<ProductContextRecord | null>;

  /**
   * Canonical context ownership resolution: the context row + the owning
   * agency row through the structural port. Null when the context does
   * not exist — callers surface the uniform 404 so foreign and unknown
   * identifiers are indistinguishable.
   */
  resolveProductContextOwnership(
    productContextId: string,
  ): Promise<ProductContextOwnerContext | null>;

  /** The agency's product contexts (oldest first). Unknown agency → 404. */
  listProductContextsForAgency(
    agencyId: string,
  ): Promise<readonly ProductContextRecord[]>;

  /** The composed honest read-back (AC-7 / the AC-6 mission seam). Null when unknown. */
  getProductContextDetail(productContextId: string): Promise<ProductContextDetail | null>;

  /** The append-only version tail (oldest first). Null when the context is unknown. */
  getProductContextVersions(
    productContextId: string,
  ): Promise<readonly ProductContextVersionRecord[] | null>;

  /**
   * Records a NEW declared version (the correction path — the declared
   * content is IMMUTABLE per version; corrections are NEW version
   * records, never in-place rewrites; AC-1). CAS on the context's
   * `version` (ConflictError on loss); requires an ACTIVE agency (new
   * use); the version-tail pointer only ever ADVANCES. The declared
   * inputs of the new version are validated exactly as at creation.
   */
  recordProductContextVersion(
    input: {
      readonly productContextId: string;
      readonly declaration: ProductContextDeclaration;
      readonly expectedVersion: number;
    },
    provenance: ProductIntelligenceProvenance,
  ): Promise<ProductContextDetail>;

  /**
   * Runs the DETERMINISTIC INSPECTION PIPELINE over the CURRENT declared
   * version's inputs (AC-2, READ-ONLY — fetch/read operations only):
   *
   *   - every PUBLIC input is fetched through the fetcher port and its
   *     content extracted by the deterministic site-page extractor into
   *     source-fact records (source URL, fetched-at, extractor identity,
   *     content hash, extraction notes — full provenance);
   *   - every EXPLICITLY-AUTHORIZED input is read through the
   *     /integrations public contract's read surface (the connection
   *     must resolve, belong to the context's agency and be CONNECTED —
   *     unknown/foreign → the uniform 404, non-connected → an honest
   *     ConflictError) and every returned provider record becomes a
   *     source-fact record through the integration-record extractor;
   *   - the inspection is ALL-OR-NOTHING: a failed fetch or read fails
   *     the whole command honestly (nothing persists);
   *   - an unchanged source never re-appends: the (version, input,
   *     extractor, content-hash) fence rejects identical re-inspection
   *     with an honest ConflictError (a CHANGED source appends new
   *     facts).
   *
   * CAS on the context's `version` (the inputs inspected are exactly the
   * caller's expected current version's). Requires an ACTIVE agency.
   */
  inspectProductContext(
    input: {
      readonly productContextId: string;
      readonly expectedVersion: number;
    },
    provenance: ProductIntelligenceProvenance,
  ): Promise<ProductContextDetail>;

  /** The source-fact ledger of the context (oldest first). Null when unknown. */
  getSourceFacts(
    productContextId: string,
  ): Promise<readonly ProductSourceFactRecord[] | null>;

  /** The derived-model records of the context (oldest first). Null when unknown. */
  getDerivedModels(
    productContextId: string,
  ): Promise<readonly ProductDerivedModelRecord[] | null>;

  /** The risk flags of the context (oldest first). Null when unknown. */
  getRiskFlags(productContextId: string): Promise<readonly ProductRiskFlagRecord[] | null>;

  /**
   * Records ONE derived model record (AC-3): the frozen §8 kind, the
   * statement (the claim/hypothesis, verbatim), an optional structured
   * detail, the backing source-fact references (must belong to the SAME
   * context — unknown/foreign → the uniform 404), optional canonical
   * /evidence citations (validated through the evidence port: unknown or
   * cross-agency citations → the uniform 404) and the optional ai-runtime
   * assistance disclosure (the call reference must resolve through the
   * ai-runtime port, belong to the context's agency, and its chosen model
   * must MATCH the disclosed model identity — a mismatch is an honest
   * ConflictError). The verification state is SERVER-DERIVED from the
   * backing (unverified with none; evidence_backed with at least one)
   * and the hypothesis flag is FROZEN to the kind. An identical
   * (context, kind, statement) record is an honest ConflictError —
   * hypotheses never become facts by repetition. Requires an ACTIVE
   * agency; the record attaches to the CURRENT declared version.
   */
  recordDerivedModel(
    input: {
      readonly productContextId: string;
      readonly derivationKind: ProductIntelligenceDerivationKind;
      readonly statement: string;
      readonly detail: Readonly<Record<string, unknown>> | null;
      readonly sourceFactIds: readonly string[];
      readonly evidenceCitations: readonly string[];
      readonly aiAssistance: ProductIntelligenceAiAssistance | null;
    },
    provenance: ProductIntelligenceProvenance,
  ): Promise<ProductDerivedModelRecord>;

  /**
   * Records ONE risk flag (AC-4): the frozen risk kind + severity, the
   * statement, and the same evidence-backing / ai-disclosure discipline
   * as the derived records. Append-only; an identical (context, kind,
   * statement) flag is an honest ConflictError. Requires an ACTIVE
   * agency; the flag attaches to the CURRENT declared version.
   */
  recordRiskFlag(
    input: {
      readonly productContextId: string;
      readonly riskKind: ProductIntelligenceRiskKind;
      readonly severity: ProductIntelligenceRiskSeverity;
      readonly statement: string;
      readonly sourceFactIds: readonly string[];
      readonly evidenceCitations: readonly string[];
      readonly aiAssistance: ProductIntelligenceAiAssistance | null;
    },
    provenance: ProductIntelligenceProvenance,
  ): Promise<ProductRiskFlagRecord>;
}

export interface ProductIntelligenceModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * The DISCLOSED OFF-MATRIX structural port (the /app-installs
   * precedent): the agency row authority for the fail-closed
   * agency-scope resolution.
   */
  readonly agencies: ProductIntelligenceAgencyPort;
  /** Matrix-listed direction (/product-intelligence ──→ /evidence): READ-ONLY citations. */
  readonly evidence: ProductIntelligenceEvidencePort;
  /** Matrix-listed direction (/product-intelligence ──→ /ai-runtime): READ-ONLY disclosure cross-check. */
  readonly aiRuntime: ProductIntelligenceAiRuntimePort;
  /** Matrix-listed direction (/product-intelligence ──→ /integrations): READ-ONLY authorized reads. */
  readonly integrations: ProductIntelligenceIntegrationsPort;
  /** The read-only public-source fetcher (the production HttpCallPort adapter or the disclosed test double). */
  readonly fetcher: ProductSourceFetcher;
}

export { createProductIntelligenceModule } from './internal/product-intelligence-module.ts';
export { createHttpProductSourceFetcher } from './internal/http-fetcher.ts';
export {
  SITE_PAGE_EXTRACTOR_ID,
  INTEGRATION_RECORD_EXTRACTOR_ID,
  extractSiteObservation,
  hashContent,
  integrationRecordObservation,
} from './internal/extractor.ts';
/**
 * The input guards (declaration/derivation/risk-flag/provenance
 * validation, the public-URL rule and the verification-state derivation)
 * and the pure owner-context composer — exported for unit tests and
 * future server-side callers (the MKT-070 planner composes these same
 * commands) so the guard semantics are part of the module contract. Pure
 * functions.
 */
export {
  assertValidProductContextDeclaration,
  assertValidProductIntelligenceProvenance,
  assertValidDerivedModelInput,
  assertValidRiskFlagInput,
  assertValidPublicSourceUrl,
  composeProductContextOwnerContext,
  deriveVerificationState,
} from './internal/product-intelligence-store.ts';
