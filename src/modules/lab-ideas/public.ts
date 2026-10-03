/**
 * MarketingOS module: /lab-ideas
 * Authority: Idea Graph (LAB-004 — spec/effective-backlog-v1.7.md
 * LAB-004: "Map content into idea/problem/claim/hook/narrative/visual/
 * audio/packaging/CTA primitives. Acceptance: observed vs derived
 * separation, retrieval, clustering, novelty, recombination and
 * lineage."; dependencies satisfied: LAB-003 (merged — the
 * /lab-features feature bundles whose bundle versions this module's
 * idea extractions cite BY REFERENCE); spec/
 * architecture-v1.7-marketing-lab.md §6 "Idea Graph" (THE frozen
 * contract: the primitive vocabulary "idea; problem; claim; hook;
 * narrative; visual treatment; audio treatment; packaging; CTA;
 * timing/context"; the supports list "retrieval; clustering; novelty
 * measurement; recombination; mutation; analogy; deliberate
 * inversion; gap discovery"; the separation "The system MUST
 * distinguish: observed source idea; derived abstraction; generated
 * mutation; combined strategy" and "No generated idea is treated as
 * source evidence merely because it resembles an observed item") and
 * §22 multi-tenancy ("All Lab scenarios, corpora, feature bundles,
 * model artifacts, runs and calibration records remain tenant/
 * workspace scoped."); AGENTS.md v1.7 "Multimodal feature bundles
 * and Idea Graph abstractions are versioned and source-linked.";
 * docs/handoff/WORKER-CONTRACT.md "Idea Graph separates observed
 * facts from derived/generated abstractions."; architecture-lock-
 * v1.7 rules 5/6/7/8/29 (the versioned/source-linked Lab-artifact
 * discipline applied to the idea layer).
 *
 * THE IDEA GRAPH (LAB-004's frozen scope):
 *
 *   - THE CLOSED PRIMITIVE VOCABULARY (§6, CHECK-fenced in migration
 *     066): exactly the ten §6 primitives — idea / problem / claim /
 *     hook / narrative / visual_treatment / audio_treatment /
 *     packaging / cta / timing_context — under the pinned idea-set
 *     version 'lab-ideaset-v1'.
 *   - THE CLOSED EDGE-RELATION VOCABULARY (§6's supports list as
 *     graph relations, CHECK-fenced): supports / contradicts /
 *     refines / combines_with / mutates_from / analog_to / inverts /
 *     fills_gap.
 *   - THE OBSERVED-DERIVED-GENERATED-COMBINED SEPARATION (§6, THE
 *     core acceptance): every node carries its origin class from the
 *     closed vocabulary observed_source / derived_abstraction /
 *     generated_mutation / combined_strategy — CHECK-fenced, and the
 *     creation path is FENCED to the origin class: a DECOMPOSITION
 *     of one cited feature bundle produces observed_source nodes
 *     ONLY (the extraction of observed content — never a generated
 *     idea); a graph OPERATION produces the derived/generated/
 *     combined nodes (derive → derived_abstraction; recombine →
 *     combined_strategy; mutate/analogy/invert/fill_gap →
 *     generated_mutation — the operation-kind/output-origin pairing
 *     is CHECK-fenced in migration 066). NO generated idea is ever
 *     treated as source evidence: the retrieval surface REQUIRES the
 *     caller to filter by origin class explicitly (the closed
 *     origin-class list is a mandatory input — evidence-consuming
 *     surfaces pass the exported strict evidence filter
 *     LAB_IDEAS_EVIDENCE_ORIGIN_CLASSES = ['observed_source']), and
 *     NOVELTY is measured against OBSERVED nodes only.
 *   - LINEAGE (recorded DATA, never computed post-hoc from
 *     resemblance): every non-observed node carries its full
 *     recorded lineage — the ordered edge chain (fromNodeId,
 *     toNodeId, relation) through which it descends from its
 *     observed ancestors, built deterministically at creation from
 *     the creating operation's new edges + the inputs' own recorded
 *     lineages, bounded to LAB_IDEAS_MAX_LINEAGE_STEPS — and the
 *     lineage read is a bounded, read-only, tenant-scoped query
 *     resolving the recorded chain + the distinct ancestor records.
 *   - RETRIEVAL: deterministic retrieval over the graph — by
 *     primitive kind, by origin class, by cited bundle/reference,
 *     under the tenant scope; bounded and cursor-paginated
 *     (keyset pagination over (created_at, node_id)); pure SQL — NO
 *     second search engine (the /client-memory retrieval precedent).
 *   - CLUSTERING: deterministic, versioned clustering over the
 *     clusterable primitive space (observed + derived nodes — the
 *     evidence-bearing space; generated/combined nodes are
 *     candidates, not corpus evidence, and never join clusters —
 *     DISCLOSED) under the frozen clustering version
 *     'lab-idea-clustering-v1': within each primitive kind, the
 *     Jaccard-similarity connected components at the frozen
 *     threshold; same node set + same version → the same clusters
 *     (the pure function); cluster assignments are append-only
 *     records carrying the version — never in-place rewrites.
 *   - NOVELTY MEASUREMENT: deterministic novelty scoring of a
 *     candidate primitive against the observed graph under the
 *     frozen novelty version 'lab-idea-novelty-v1': the pure
 *     function 1 − max Jaccard(descriptor token set) over the
 *     OBSERVED nodes of the same primitive kind (1 when the observed
 *     set is empty) — the score is a pure function of the recorded
 *     graph state + the candidate, and the novelty of a
 *     generated/combined node is measured against OBSERVED nodes
 *     ONLY, never against other generated nodes.
 *   - RECOMBINATION + MUTATION (the §6 supports list as first-class
 *     append-only OPERATIONS): every operation records its cited
 *     input node ids, its operation kind from the closed vocabulary,
 *     its output node with the generated/combined/derived origin
 *     class + the recorded lineage + the creation-time novelty score
 *     against the observed graph, and the lineage edges it asserts.
 *     The generative step stays behind the REPLACEABLE
 *     LabIdeaGeneratorPort (the LAB-003 extractor-port precedent):
 *     the first-party implementation is HONEST about what it
 *     produces — the deterministic STRUCTURAL recombination,
 *     derivation and gap recording are first-party; the open-ended
 *     generative mutation (mutate/analogy/invert) ships the honest
 *     PENDING refusal (no row, no node — fail closed) until a real
 *     generator is wired.
 *   - THE DECOMPOSITION PORT (the LAB-003 extractor-port precedent):
 *     a replaceable, test-double-friendly port contract; the
 *     first-party decomposer is HONEST — it derives ONLY the
 *     primitives the cited bundle's feature values honestly support
 *     (a feature in its explicit unavailable state derives NO
 *     primitive — never fabricated), and it asserts NO intra-
 *     decomposition semantic edges (a supports/contradicts relation
 *     is a semantic judgment a deterministic metadata decomposer
 *     cannot make; the edge vocabulary is the real decomposer's and
 *     the operations' surface — DISCLOSED).
 *   - THE VERSIONED IDEA-DECOMPOSITION records: one per decomposition
 *     of one cited feature bundle under one idea-set version — the
 *     deterministic identity digest (a pure function of the cited
 *     bundle's identity fields, the idea-set version, the decomposer
 *     identity+version, the input digest) as the idempotence fence,
 *     and the append-only per-cited-bundle decomposition version
 *     chain (a re-decomposition under a NEW idea-set/decomposer/input
 *     version is a NEW decomposition_version row, never an in-place
 *     rewrite).
 *   - TENANT ISOLATION (§22): every node/edge/decomposition/
 *     operation/cluster row is CLIENT-scoped (the hard security
 *     boundary — spec/architecture.md §4) with the optional
 *     workspace anchor, all cross-tenant reads resolve to the
 *     uniform NotFound (no existence oracle), and the cross-tenant
 *     scope-consistency triggers fence the module's own row
 *     references at the DB.
 *
 * THE FEATURE-BUNDLE CITATION (the /lab family by-reference
 * discipline): the decomposition input cites ONE /lab-features
 * feature bundle OPAQUELY — the bundle id/reference/version, the
 * /lab-corpus reference id + corpus binding, the provider/provider
 * content id/canonical URL, the metadata digest, the extractor +
 * feature-set echoes and the bundle's per-key feature value map —
 * ALL recorded data copied by the caller from the /lab-features
 * public surface. There is NO import of /lab-features (or
 * /lab-corpus or /lab) here and NO /lab-features table is ever read
 * or written by this module (the frozen v1.7 no-cross-module-
 * dependency discipline of the /lab family).
 *
 * What it is NOT (the bounded scope):
 *
 *   - NO second corpus/feature authority: references and feature
 *     bundles stay /lab-corpus's and /lab-features's (LAB-002/003);
 *     this module CONSUMES bundle citations by reference only.
 *   - NO generative invention: the first-party generator produces
 *     ONLY explicitly-labeled structural compositions; the
 *     open-ended generative kinds fail closed with the honest
 *     pending state until a real generator is wired.
 *   - NO semantic edge invention: the first-party decomposer asserts
 *     no supports/contradicts relations (semantic judgment); edges
 *     arrive from real decomposers and from recorded operations.
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
// The frozen vocabularies (CHECK-fenced in migration 066 — closed sets).
// ---------------------------------------------------------------------------

/** The contract vocabulary version of every Idea-Graph artifact (the LAB-001 'lab-contract-v1' discipline). */
export const LAB_IDEAS_CONTRACT_VERSION = 'lab-ideas-contract-v1' as const;

/** The versioned idea-set definition (§6: the primitive vocabulary of this decomposition version) — the first frozen set. */
export const LAB_IDEA_SET_VERSION = 'lab-ideaset-v1' as const;

/** The frozen clustering version (the deterministic clustering formula identity — same nodes + same version → same clusters). */
export const LAB_IDEA_CLUSTERING_VERSION = 'lab-idea-clustering-v1' as const;

/** The frozen novelty version (the deterministic novelty formula identity — a pure function of the recorded graph state + the candidate). */
export const LAB_IDEA_NOVELTY_VERSION = 'lab-idea-novelty-v1' as const;

/**
 * THE CLOSED PRIMITIVE-KIND VOCABULARY (§6 verbatim, 10 kinds): idea,
 * problem, claim, hook, narrative, visual treatment, audio treatment,
 * packaging, CTA, timing/context.
 */
export const LAB_IDEA_PRIMITIVE_KINDS = [
  'idea',
  'problem',
  'claim',
  'hook',
  'narrative',
  'visual_treatment',
  'audio_treatment',
  'packaging',
  'cta',
  'timing_context',
] as const;
export type LabIdeaPrimitiveKind = (typeof LAB_IDEA_PRIMITIVE_KINDS)[number];

/**
 * THE CLOSED EDGE-RELATION VOCABULARY (§6's supports list as graph
 * relations, 8): supports / contradicts / refines / combines_with /
 * mutates_from / analog_to / inverts / fills_gap. Lineage edges point
 * from the ANCESTOR (input) to the DESCENDANT (output).
 */
export const LAB_IDEA_EDGE_RELATIONS = [
  'supports',
  'contradicts',
  'refines',
  'combines_with',
  'mutates_from',
  'analog_to',
  'inverts',
  'fills_gap',
] as const;
export type LabIdeaEdgeRelation = (typeof LAB_IDEA_EDGE_RELATIONS)[number];

/**
 * THE CLOSED ORIGIN-CLASS VOCABULARY (§6 verbatim, 4): observed_source
 * / derived_abstraction / generated_mutation / combined_strategy —
 * THE observed-vs-derived-vs-generated-vs-combined separation. The
 * creation path is fenced to the class: decompositions produce
 * observed_source nodes only; operations produce the non-observed
 * classes per the operation-kind pairing.
 */
export const LAB_IDEA_ORIGIN_CLASSES = [
  'observed_source',
  'derived_abstraction',
  'generated_mutation',
  'combined_strategy',
] as const;
export type LabIdeaOriginClass = (typeof LAB_IDEA_ORIGIN_CLASSES)[number];

/**
 * THE STRICT EVIDENCE FILTER (the evidence-consumption discipline):
 * the origin classes evidence-consuming surfaces retrieve under.
 * OBSERVED SOURCE IDEAS ONLY — the strictest reading of §6 ("No
 * generated idea is treated as source evidence merely because it
 * resembles an observed item"; the observed/derived/generated/
 * combined distinction): a derived abstraction is derived data, not
 * source evidence. Queries that feed evidence-consuming surfaces
 * pass EXACTLY this list.
 */
export const LAB_IDEAS_EVIDENCE_ORIGIN_CLASSES: ReadonlyArray<LabIdeaOriginClass> = ['observed_source'];

/**
 * THE CLOSED OPERATION-KIND VOCABULARY (the §6 supports list as
 * first-class recorded graph operations, plus the derivation
 * operation for the derived_abstraction class): derive / recombine /
 * mutate / analogy / invert / fill_gap. The pairing fences:
 *   derive    → ≥2 SAME-KIND inputs, output origin derived_abstraction, edge relation refines;
 *   recombine → ≥2 inputs (kinds may mix), output origin combined_strategy,  edge relation combines_with, the caller declares the output primitive kind;
 *   mutate    → exactly 1 input, output origin generated_mutation, edge relation mutates_from (the output kind = the input's kind);
 *   analogy   → exactly 1 input, output origin generated_mutation, edge relation analog_to (the output kind = the input's kind);
 *   invert    → exactly 1 input, output origin generated_mutation, edge relation inverts (the output kind = the input's kind);
 *   fill_gap  → ≥2 SAME-KIND inputs (the delimiting neighbors in one primitive space), output origin generated_mutation, edge relation fills_gap.
 */
export const LAB_IDEA_OPERATION_KINDS = ['derive', 'recombine', 'mutate', 'analogy', 'invert', 'fill_gap'] as const;
export type LabIdeaOperationKind = (typeof LAB_IDEA_OPERATION_KINDS)[number];

/** The operation-kind → edge-relation pairing (the lineage edge an operation asserts from each input to its output). */
export const LAB_IDEA_OPERATION_KIND_RELATION: Readonly<Record<LabIdeaOperationKind, LabIdeaEdgeRelation>> = {
  derive: 'refines',
  recombine: 'combines_with',
  mutate: 'mutates_from',
  analogy: 'analog_to',
  invert: 'inverts',
  fill_gap: 'fills_gap',
};

/** The operation-kind → output origin-class pairing (CHECK-fenced in migration 066). */
export const LAB_IDEA_OPERATION_KIND_OUTPUT_ORIGIN: Readonly<Record<LabIdeaOperationKind, LabIdeaOriginClass>> = {
  derive: 'derived_abstraction',
  recombine: 'combined_strategy',
  mutate: 'generated_mutation',
  analogy: 'generated_mutation',
  invert: 'generated_mutation',
  fill_gap: 'generated_mutation',
};

/** The upper bound of lineage steps recorded on any non-observed node (the bounded lineage discipline). */
export const LAB_IDEAS_MAX_LINEAGE_STEPS = 64;

/** The upper bound of cited input nodes per operation (the bounded operation discipline). */
export const LAB_IDEAS_MAX_OPERATION_INPUTS = 20;

/** The retrieval page bound (the bounded, cursor-paginated read). */
export const LAB_IDEAS_RETRIEVAL_MAX_LIMIT = 100;

/** The retrieval default page size. */
export const LAB_IDEAS_RETRIEVAL_DEFAULT_LIMIT = 50;

/** The upper bound of nodes/edges per decomposition (the bounded decomposition discipline). */
export const LAB_IDEAS_MAX_DECOMPOSITION_NODES = 100;
export const LAB_IDEAS_MAX_DECOMPOSITION_EDGES = 200;

/** The upper bound of decomposition versions per (client, cited bundle) chain (the append-only correction chain fence). */
export const LAB_IDEAS_MAX_DECOMPOSITION_VERSIONS = 1000;

/** The frozen Jaccard similarity threshold of the 'lab-idea-clustering-v1' clustering (two same-kind nodes are similar iff Jaccard ≥ 0.5). */
export const LAB_IDEA_CLUSTERING_SIMILARITY_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// The feature-bundle citation (the /lab-features by-reference discipline).
// ---------------------------------------------------------------------------

/**
 * A feature-bundle citation: the FULL source-linkage data one
 * decomposition consumes and every decomposition records — OPAQUE
 * recorded data copied from the /lab-features public surface by the
 * caller (the driver reads the bundle under its own scope and hands
 * the citation over; there is NO import of /lab-features here and NO
 * /lab-features table is ever read or written by this module).
 *
 * The feature value map is the STRUCTURAL echo of the cited bundle's
 * 27-key map: each value carries its state ('derived' with its
 * representation / 'unavailable' with its reason). The shapes are
 * validated STRUCTURALLY here (bounded keys, closed states) — the
 * per-key semantics stay the /lab-features module's own contract
 * (this module's decomposer knows only the keys it maps to
 * primitives, by data knowledge, never by import).
 */
export interface LabIdeaBundleCitation {
  /** The opaque /lab-features bundle id (recorded data — never joined). */
  bundleId: string;
  /** The citable bundle reference ('<bundleId>#v<bundleVersion>' — the /lab-features citable form, recorded data). */
  bundleReference: string;
  bundleVersion: number;
  /** The owning client of the cited bundle, AS RECORDED at extraction time (the recorded-data tenant fence: a mismatch is the honest scope failure). */
  clientId: string;
  /** The opaque /lab-corpus reference id (recorded data — never joined). */
  referenceId: string;
  /** The corpus binding (id + version) the reference was first recorded under (recorded data). */
  corpusId: string;
  corpusVersion: number;
  provider: string;
  providerContentId: string;
  canonicalUrl: string;
  /** The observation metadata digest the cited bundle was extracted from (recorded data). */
  metadataDigest: string;
  /** The feature-set version echo of the cited bundle (recorded data). */
  featureSetVersion: string;
  /** The extractor identity echo of the cited bundle (recorded data). */
  extractorId: string;
  extractorVersion: string;
  /** The deterministic identity digest echo of the cited bundle (recorded data — part of this module's own identity derivation). */
  bundleIdentityDigest: string;
  /** The cited bundle's per-key feature value map (the structural echo — the decomposition input). */
  features: Readonly<Record<string, LabIdeaCitedFeatureValue>>;
}

/** One cited feature value: the structural echo of a /lab-features value (derived with its representation / unavailable with its reason). */
export interface LabIdeaCitedFeatureValue {
  state: 'derived' | 'unavailable';
  /** Present iff derived (the concrete representation the decomposer maps to primitives — bounded JSON). */
  value?: unknown;
  /** Present iff unavailable (the honest closed reason). */
  reason?: string;
}

// ---------------------------------------------------------------------------
// The replaceable ports (the LAB-003 extractor-port precedent).
// ---------------------------------------------------------------------------

/** One primitive NODE proposed by the decomposer for one cited bundle. */
export interface LabIdeaProposedNode {
  primitiveKind: LabIdeaPrimitiveKind;
  /** The honest descriptor of the observed primitive (bounded, 1-512 chars — the decomposition's observable content). */
  descriptor: string;
  /** The bounded structured attributes copied from the cited feature value (recorded data; defaults to {}). */
  attributes?: Readonly<Record<string, unknown>>;
}

/** One intra-decomposition EDGE proposed by the decomposer (a semantic relation among its OWN nodes). */
export interface LabIdeaProposedEdge {
  relation: LabIdeaEdgeRelation;
  /** The index (1-based) of the from-node in the proposed node list. */
  fromSeq: number;
  /** The index (1-based) of the to-node in the proposed node list. */
  toSeq: number;
}

/** The decomposer's result: the observed primitive nodes + the intra-decomposition edges. */
export interface LabIdeaDecompositionResult {
  nodes: ReadonlyArray<LabIdeaProposedNode>;
  edges: ReadonlyArray<LabIdeaProposedEdge>;
}

/** The decomposer's terminal failure (fail closed — never invented primitives). */
export interface LabIdeaDecompositionFailure {
  reason: 'decomposition_error' | 'invalid_input';
  detail: string;
}

/**
 * THE DECOMPOSITION PORT (a replaceable, test-double-friendly
 * contract — the LAB-002/LAB-003 port precedent): one decomposition
 * of one cited feature bundle under the pinned idea-set version. The
 * decomposer declares its identity (part of the deterministic
 * decomposition identity); the FIRST-PARTY implementation is honest
 * about what it can and cannot derive — ONLY the primitives the
 * cited feature values honestly support (an unavailable feature
 * derives NO primitive, never fabricated) and NO invented semantic
 * edges.
 */
export interface LabIdeaDecomposer {
  readonly decomposerId: string;
  readonly decomposerVersion: string;
  /** The idea-set version this decomposer serves (must equal the module's pinned version). */
  readonly ideaSetVersion: string;
  decompose(input: {
    citation: LabIdeaBundleCitation;
  }): Promise<LabIdeaDecompositionResult | LabIdeaDecompositionFailure>;
}

/** The generator's output: the honest content of the new node (explicitly-labeled structural composition, or a real generator's output). */
export interface LabIdeaGenerationOutput {
  status: 'generated';
  /** The bounded descriptor of the generated node (the generator's honest content). */
  descriptor: string;
  /** The bounded structured attributes of the generated node (defaults to {}). */
  attributes?: Readonly<Record<string, unknown>>;
}

/**
 * The generator's honest PENDING refusal (the LAB-003 pending-port
 * discipline): the open-ended generative kinds ship the pending
 * state until a real generator is wired — the operation then fails
 * closed BEFORE any row exists (nothing recorded, nothing
 * fabricated).
 */
export interface LabIdeaGenerationPending {
  status: 'pending';
  reason: string;
}

/**
 * THE GENERATOR PORT (§6's generative seam — REPLACEABLE, the
 * LAB-003 extractor-port precedent): the generative step of a graph
 * operation. The MODULE owns the operation records, the output
 * node's origin class, lineage and novelty measurement; this port
 * owns ONLY the content generation. The first-party implementation
 * is honest: derive/recombine/fill_gap produce deterministic
 * STRUCTURAL compositions (explicitly labeled, never semantic
 * invention); mutate/analogy/invert (the open-ended generative
 * kinds) refuse with the honest pending state.
 */
export interface LabIdeaGeneratorPort {
  readonly generatorId: string;
  readonly generatorVersion: string;
  generate(input: {
    operationKind: LabIdeaOperationKind;
    /** The cited input nodes (bounded, same-client, loaded by the module). */
    inputNodes: ReadonlyArray<LabIdeaNodeRecord>;
  }): Promise<LabIdeaGenerationOutput | LabIdeaGenerationPending>;
}

// ---------------------------------------------------------------------------
// The records (the public read shapes).
// ---------------------------------------------------------------------------

/** One ordered lineage step recorded on a non-observed node (from the ancestor towards the descendant). */
export interface LabIdeaLineageStep {
  /** The 1-based position in the recorded chain (deterministic order: the creating operation's new edges first, then the inputs' recorded lineages in input order). */
  seq: number;
  fromNodeId: string;
  toNodeId: string;
  relation: LabIdeaEdgeRelation;
}

/** A primitive NODE record: one node of the Idea Graph. */
export interface LabIdeaNodeRecord {
  nodeId: string;
  primitiveKind: LabIdeaPrimitiveKind;
  originClass: LabIdeaOriginClass;
  descriptor: string;
  attributes: Readonly<Record<string, unknown>>;
  /** The decomposition that extracted this node (non-null ⟺ originClass = observed_source). */
  decompositionId: string | null;
  /** The citable bundle reference echo (observed nodes only — the recorded source linkage). */
  citedBundleReference: string | null;
  /** The operation that produced this node (non-null ⟺ originClass ≠ observed_source; recorded data, module-validated against the operation row). */
  creatingOperationId: string | null;
  /** The operation-kind echo (non-observed nodes only). */
  creatingOperationKind: LabIdeaOperationKind | null;
  /**
   * THE RECORDED LINEAGE (the ordered edge chain to the observed
   * ancestors — DATA recorded at creation, never computed post-hoc
   * from resemblance; null ⟺ originClass = observed_source).
   */
  lineage: ReadonlyArray<LabIdeaLineageStep> | null;
  /**
   * The creation-time novelty score against the OBSERVED graph
   * (null ⟺ originClass = observed_source — observed nodes are the
   * reference set, not novelty candidates).
   */
  noveltyScore: number | null;
  /** The novelty formula version that produced the score (null ⟺ observed_source). */
  noveltyVersion: string | null;
  agencyId: string;
  clientId: string;
  workspaceId: string | null;
  contractVersion: string;
  createdAt: string;
  updatedAt: string;
}

/** An EDGE record: one relation edge between two nodes. */
export interface LabIdeaEdgeRecord {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
  relation: LabIdeaEdgeRelation;
  /** The decomposition that asserted this edge (exactly one of decompositionId/operationId is set). */
  decompositionId: string | null;
  /** The operation that asserted this edge (the lineage edge of its output). */
  operationId: string | null;
  /** The 1-based position among the creator's edges (deterministic order). */
  seq: number;
  agencyId: string;
  clientId: string;
  workspaceId: string | null;
  contractVersion: string;
  createdAt: string;
}

/** A versioned IDEA-DECOMPOSITION record (one per decomposition of one cited feature bundle under one idea-set version). */
export interface LabIdeaDecompositionRecord {
  decompositionId: string;
  /** The append-only per-cited-bundle version chain position. */
  decompositionVersion: number;
  ideaSetVersion: string;
  /** Born running; the single guarded advance to completed (the node/edge counts SQL-computed at completion). */
  status: 'running' | 'completed';
  nodeCount: number;
  edgeCount: number;
  // --- THE SOURCE LINKAGE (recorded citation data, never a join) ---
  bundleId: string;
  bundleReference: string;
  bundleVersion: number;
  referenceId: string;
  corpusId: string;
  corpusVersion: number;
  provider: string;
  providerContentId: string;
  canonicalUrl: string;
  metadataDigest: string;
  featureSetVersion: string;
  extractorId: string;
  extractorVersion: string;
  bundleIdentityDigest: string;
  // --- THE DECOMPOSER IDENTITY + THE DETERMINISTIC IDENTITY ---
  decomposerId: string;
  decomposerVersion: string;
  /** THE DETERMINISTIC IDENTITY (the pure-function digest — same inputs, same identity, ever). */
  identityDigest: string;
  inputDigest: string;
  agencyId: string;
  clientId: string;
  workspaceId: string | null;
  contractVersion: string;
  createdAt: string;
  updatedAt: string;
  /** The node tail (carried on reads). */
  nodes: ReadonlyArray<LabIdeaNodeRecord>;
  /** The edge tail (carried on reads). */
  edges: ReadonlyArray<LabIdeaEdgeRecord>;
}

/** A first-class append-only graph OPERATION record (recombination/mutation/derivation/analogy/inversion/gap-fill). */
export interface LabIdeaOperationRecord {
  operationId: string;
  operationKind: LabIdeaOperationKind;
  /** The cited input nodes (ordered, bounded — the operation's inputs). */
  inputNodeIds: ReadonlyArray<string>;
  /** The output node this operation produced (the FK-anchored same-module reference). */
  outputNodeId: string;
  /** The output node's origin class (the CHECK-fenced kind/origin pairing). */
  outputOriginClass: LabIdeaOriginClass;
  /** The generator port identity that produced the output content (recorded provenance). */
  generatorId: string;
  generatorVersion: string;
  /** The output node (carried on reads — the bounded 1-node tail). */
  outputNode: LabIdeaNodeRecord | null;
  agencyId: string;
  clientId: string;
  workspaceId: string | null;
  contractVersion: string;
  createdAt: string;
}

/** One cluster assignment (append-only, carrying the clustering version through its run). */
export interface LabIdeaClusterAssignmentRecord {
  assignmentId: string;
  runId: string;
  nodeId: string;
  /** The deterministic cluster key ('<primitive-kind>#<the component's lexicographically smallest node id>'). */
  clusterKey: string;
  primitiveKind: LabIdeaPrimitiveKind;
  /** The component size at run time (recorded on every member row — the run-time snapshot). */
  clusterSize: number;
  agencyId: string;
  clientId: string;
  workspaceId: string | null;
  contractVersion: string;
  createdAt: string;
}

/** A versioned CLUSTER RUN record (one run per (client, clustering version) — the version-bump discipline). */
export interface LabIdeaClusterRunRecord {
  runId: string;
  clusterVersion: string;
  status: 'running' | 'completed';
  /** The clusterable node count at run time (SQL-computed at completion from the assignment rows). */
  inputNodeCount: number;
  /** The number of distinct clusters (SQL-computed at completion). */
  clusterCount: number;
  /** The largest cluster size (SQL-computed at completion). */
  largestClusterSize: number;
  /** The number of singleton clusters (SQL-computed at completion). */
  singletonCount: number;
  agencyId: string;
  clientId: string;
  workspaceId: string | null;
  contractVersion: string;
  createdAt: string;
  updatedAt: string;
  /** The assignment tail (carried on reads). */
  assignments: ReadonlyArray<LabIdeaClusterAssignmentRecord>;
}

/** A deterministic novelty measurement against the OBSERVED graph (the frozen 'lab-idea-novelty-v1' formula). */
export interface LabIdeaNoveltyMeasure {
  noveltyVersion: string;
  primitiveKind: LabIdeaPrimitiveKind;
  noveltyScore: number;
  /** The number of observed nodes of the same primitive kind the candidate was measured against. */
  observedComparisonCount: number;
  /** The nearest observed node (the max-similarity one; null when the observed set is empty). */
  nearestObservedNodeId: string | null;
  /** The nearest observed node's similarity (the max Jaccard; 0 when the observed set is empty). */
  nearestSimilarity: number;
}

// ---------------------------------------------------------------------------
// The module API inputs.
// ---------------------------------------------------------------------------

/** The decomposition entry input: one cited feature bundle under the tenant scope. */
export interface DecomposeLabIdeaInput {
  scope: LabIdeasScope;
  citation: LabIdeaBundleCitation;
}

/**
 * The graph-operation entry input: the operation kind + the cited input
 * nodes. The OUTPUT primitive kind is deterministic for every kind but
 * recombine: mutate/analogy/invert inherit the single input's kind;
 * derive/fill_gap require same-kind inputs (the output kind is that
 * shared kind); recombine (the cross-kind composition) carries the
 * CALLER-DECLARED output primitive kind from the closed vocabulary.
 */
export interface ApplyLabIdeaOperationInput {
  scope: LabIdeasScope;
  operationKind: LabIdeaOperationKind;
  /** The cited input node ids (bounded: recombine/derive/fill_gap 2-20; mutate/analogy/invert exactly 1; no duplicates). */
  inputNodeIds: ReadonlyArray<string>;
  /** REQUIRED for recombine (the caller-declared output primitive kind); MUST be absent for every other kind (the output kind is derived from the inputs). */
  outputPrimitiveKind?: LabIdeaPrimitiveKind | undefined;
}

/**
 * The deterministic retrieval input (bounded, cursor-paginated,
 * SQL-computed). THE ORIGIN-CLASS FILTER IS MANDATORY: the caller
 * must filter by origin class explicitly — evidence-consuming
 * surfaces pass LAB_IDEAS_EVIDENCE_ORIGIN_CLASSES (the strict
 * observed-only filter).
 */
export interface RetrieveLabIdeaNodesInput {
  scope: LabIdeasScope;
  /** REQUIRED, non-empty, closed vocabulary, no duplicates — the explicit origin-class filter (the evidence-consumption discipline). */
  originClasses: ReadonlyArray<LabIdeaOriginClass>;
  /** Optional: the closed primitive-kind subset filter. */
  primitiveKinds?: ReadonlyArray<LabIdeaPrimitiveKind>;
  /** Optional: filter to observed nodes whose decomposition cites this bundle reference ('<bundleId>#v<n>'). */
  citedBundleReference?: string;
  /** Optional: filter to observed nodes whose decomposition cites this /lab-corpus reference id. */
  citedReferenceId?: string;
  /** The page size (1-100; default 50). */
  limit?: number;
  /** The opaque keyset cursor from a previous page (null/absent = first page). */
  cursor?: string | null;
}

/** One retrieval page (keyset-paginated over (created_at, node_id), newest first). */
export interface LabIdeaNodePage {
  nodes: ReadonlyArray<LabIdeaNodeRecord>;
  /** The next page's cursor (null on the final page). */
  nextCursor: string | null;
}

/** The bounded lineage read: the node + the recorded chain + the resolved distinct ancestor records. */
export interface LabIdeaLineageView {
  node: LabIdeaNodeRecord;
  /** The recorded lineage steps (null for observed nodes — the honest empty state). */
  lineage: ReadonlyArray<LabIdeaLineageStep> | null;
  /** The distinct ancestor node records resolved from the recorded chain (bounded by the lineage fence). */
  ancestors: ReadonlyArray<LabIdeaNodeRecord>;
  /** The distinct OBSERVED ancestor node ids (the recorded evidence grounding of this node). */
  observedAncestorIds: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// The module ports (deps) and public API.
// ---------------------------------------------------------------------------

/** Module dependencies (platform ports + the two replaceable Lab ports — the frozen /lab-ideas row consumes NO other module). */
export interface LabIdeasModuleDeps {
  db: Db;
  clock: Clock;
  ids: IdGenerator;
  decomposer: LabIdeaDecomposer;
  generator: LabIdeaGeneratorPort;
}

/** The scope every Idea-Graph artifact is created/read under (the uniform NotFound for foreign/unknown scope — no existence oracle). */
export interface LabIdeasScope {
  agencyId: string;
  clientId: string;
  workspaceId?: string | null;
}

/** The /lab-ideas module public API — the frozen surface consumed by the later Lab layers (LAB-005 simulator, LAB-019 transform graph, the TL's integrations) BY REFERENCE. */
export interface LabIdeasModuleApi {
  /**
   * THE DECOMPOSITION ENTRY: one cited feature bundle under the
   * pinned idea-set version. The decomposition row is born running,
   * the decomposer port runs, and on success the observed nodes +
   * intra-decomposition edges insert and the row advances to
   * completed with the node/edge counts SQL-computed (never
   * asserted separately). Re-decomposing the same citation under
   * the same versions is idempotent (the deterministic identity
   * fence — the existing completed decomposition is returned).
   */
  decompose(input: DecomposeLabIdeaInput): Promise<LabIdeaDecompositionRecord>;

  /** Reads one decomposition (with its node + edge tails) — the uniform NotFound for foreign/unknown scope. */
  getDecomposition(scope: LabIdeasScope, decompositionId: string): Promise<LabIdeaDecompositionRecord>;

  /** Lists the client's decompositions (newest first; optionally the per-cited-bundle version chain). */
  listDecompositions(scope: LabIdeasScope, citedBundleReference?: string): Promise<ReadonlyArray<LabIdeaDecompositionRecord>>;

  /** Reads one node — the uniform NotFound for foreign/unknown scope. */
  getNode(scope: LabIdeasScope, nodeId: string): Promise<LabIdeaNodeRecord>;

  /**
   * THE DETERMINISTIC RETRIEVAL: by primitive kind, by origin class
   * (MANDATORY explicit filter), by cited bundle/reference, under
   * the tenant scope — bounded, cursor-paginated, SQL-computed (no
   * second search engine).
   */
  retrieveNodes(input: RetrieveLabIdeaNodesInput): Promise<LabIdeaNodePage>;

  /**
   * THE BOUNDED LINEAGE READ: the node + its recorded lineage chain
   * + the resolved distinct ancestor records + the observed
   * ancestor ids. Read-only, tenant-scoped, uniform NotFound.
   */
  getNodeLineage(scope: LabIdeasScope, nodeId: string): Promise<LabIdeaLineageView>;

  /**
   * THE GRAPH-OPERATION ENTRY (recombination / mutation / derivation
   * / analogy / inversion / gap-fill): records the first-class
   * append-only operation — the cited input nodes, the generator
   * output node (with its origin class + recorded lineage +
   * creation-time novelty score against the OBSERVED graph) and the
   * lineage edges. Open-ended generative kinds (mutate/analogy/
   * invert) fail closed with the honest pending state until a real
   * generator is wired.
   */
  applyOperation(input: ApplyLabIdeaOperationInput): Promise<LabIdeaOperationRecord>;

  /** Reads one operation (with its output node) — the uniform NotFound for foreign/unknown scope. */
  getOperation(scope: LabIdeasScope, operationId: string): Promise<LabIdeaOperationRecord>;

  /**
   * THE DETERMINISTIC NOVELTY MEASUREMENT: the frozen
   * 'lab-idea-novelty-v1' pure function of (the recorded graph
   * state, the candidate) — measured against OBSERVED nodes of the
   * same primitive kind ONLY, never against other generated nodes.
   */
  measureNovelty(scope: LabIdeasScope, candidate: {
    primitiveKind: LabIdeaPrimitiveKind;
    descriptor: string;
  }): Promise<LabIdeaNoveltyMeasure>;

  /**
   * THE VERSIONED CLUSTERING: runs the frozen
   * 'lab-idea-clustering-v1' clustering over the clusterable
   * primitive space (observed + derived nodes) — one run per
   * (client, clustering version): an unchanged node set re-run
   * under the same version is idempotent (the existing run
   * returned); a CHANGED node set under the same version is the
   * honest conflict (re-clustering requires a new version). The
   * assignments are append-only records carrying the version.
   */
  runClustering(scope: LabIdeasScope): Promise<LabIdeaClusterRunRecord>;

  /** Reads one cluster run (with its assignment tail) — the uniform NotFound for foreign/unknown scope. */
  getClusterRun(scope: LabIdeasScope, runId: string): Promise<LabIdeaClusterRunRecord>;
}

export { createLabIdeasModule } from './internal/ideas-module.ts';
export {
  createFirstPartyLabIdeaDecomposer,
  /** The first-party deterministic decomposer identity (honestly labeled). */
  FIRST_PARTY_DECOMPOSER_ID,
  FIRST_PARTY_DECOMPOSER_VERSION,
} from './internal/first-party-decomposer.ts';
export {
  createFirstPartyLabIdeaGenerator,
  /** The first-party structural generator identity (honestly labeled — NOT an open-ended generative model). */
  FIRST_PARTY_GENERATOR_ID,
  FIRST_PARTY_GENERATOR_VERSION,
} from './internal/first-party-generator.ts';
/**
 * The pure contract guards (the citation fences, the node/edge/
 * operation fences, the retrieval input discipline, the deterministic
 * identity derivation, the lineage construction, the frozen novelty
 * + clustering formulas) — exported for unit tests and the later Lab
 * modules so the CONTRACT semantics are part of the module surface.
 * Pure functions: no clock, no randomness, no network.
 */
export {
  assertValidLabIdeaBundleCitation,
  assertValidLabIdeaProposedNodes,
  assertValidLabIdeaProposedEdges,
  assertValidLabIdeaOperationInput,
  assertValidLabIdeaRetrievalInput,
  computeLabIdeaInputDigest,
  computeLabIdeaIdentityDigest,
  labIdeasCanonicalJson,
} from './internal/validation.ts';
export {
  buildLabIdeaLineage,
  labIdeaTokenSet,
  labIdeaJaccardSimilarity,
  computeLabIdeaNovelty,
} from './internal/novelty.ts';
export { clusterLabIdeaNodes } from './internal/clustering.ts';
