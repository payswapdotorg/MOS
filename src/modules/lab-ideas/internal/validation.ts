/**
 * /lab-ideas contract guards (LAB-004) — the PURE deterministic
 * validation + identity core.
 *
 * These guards enforce the frozen Idea-Graph contract semantics
 * (spec/architecture-v1.7-marketing-lab.md §6 "Idea Graph", §22
 * multi-tenancy; spec/effective-backlog-v1.7.md LAB-004 acceptance:
 * "observed vs derived separation, retrieval, clustering, novelty,
 * recombination and lineage"):
 *
 *   - THE CITATION FENCES (the /lab-features by-reference discipline):
 *     uuid-shaped ids, the citable bundle-reference pattern, a
 *     bounded provider/provider-content-id/canonical URL, the
 *     64-hex digests, and the STRUCTURAL feature-map echo (bounded
 *     keys, closed per-value states — derived carries its value,
 *     unavailable carries its reason; the per-key SEMANTICS stay the
 *     /lab-features module's own contract, never imported);
 *   - THE PROPOSED-NODE/EDGE FENCES: the closed 10-kind primitive
 *     vocabulary, bounded descriptors/attributes, the closed
 *     8-relation edge vocabulary, in-range node indices, no
 *     self-edges, the bounded node/edge counts;
 *   - THE OPERATION FENCES: the closed 6-kind operation vocabulary,
 *     the per-kind input-count minimums (recombine/derive/fill_gap
 *     ≥ 2; mutate/analogy/invert exactly 1), the bounded input list,
 *     no duplicates;
 *   - THE RETRIEVAL DISCIPLINE: the MANDATORY non-empty closed
 *     origin-class filter (the evidence-consumption discipline), the
 *     optional closed primitive-kind subset, the bounded page size,
 *     the opaque cursor shape;
 *   - THE DETERMINISTIC IDENTITY DERIVATION: the canonical JSON
 *     serialization (DEEP sorted keys — the LAB-003 discipline;
 *     arrays keep their order) and the two pure-function SHA-256
 *     digests (input digest over the complete decomposition input;
 *     identity digest over the cited bundle identity fields + the
 *     idea-set version + the decomposer identity+version + the input
 *     digest).
 *
 * Pure functions: no clock, no randomness, no network — the unit
 * battery pins every rule.
 */

import { createHash } from 'node:crypto';
import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import {
  LAB_IDEA_EDGE_RELATIONS,
  LAB_IDEA_OPERATION_KINDS,
  LAB_IDEA_ORIGIN_CLASSES,
  LAB_IDEA_PRIMITIVE_KINDS,
  LAB_IDEA_SET_VERSION,
  LAB_IDEAS_MAX_DECOMPOSITION_EDGES,
  LAB_IDEAS_MAX_DECOMPOSITION_NODES,
  LAB_IDEAS_MAX_OPERATION_INPUTS,
  LAB_IDEAS_RETRIEVAL_MAX_LIMIT,
  type LabIdeaBundleCitation,
  type LabIdeaDecomposer,
  type LabIdeaEdgeRelation,
  type LabIdeaOperationKind,
  type LabIdeaOriginClass,
  type LabIdeaPrimitiveKind,
  type LabIdeaProposedEdge,
  type LabIdeaProposedNode,
  type RetrieveLabIdeaNodesInput,
  type ApplyLabIdeaOperationInput,
  type DecomposeLabIdeaInput,
  type LabIdeasScope,
} from '../public.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HTTP_URL_PATTERN = /^https?:\/\/[^\s]{1,2040}$/;
const DECOMPOSER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The citable bundle-reference pattern (the /lab-features citable form '<bundleId>#v<n>'). */
const BUNDLE_REFERENCE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}#v[1-9][0-9]{0,3}$/;
/** The opaque keyset cursor: base64url of the JSON {c: isoTimestamp, n: nodeId}. */
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{8,512}$/;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function isHex64(value: string): boolean {
  return HEX_64_PATTERN.test(value);
}

function boundedString(value: unknown, min: number, max: number): boolean {
  return typeof value === 'string' && value.length >= min && value.length <= max && value.length === value.trim().length;
}

// ---------------------------------------------------------------------------
// The canonical JSON serialization (the reproducibility substrate —
// the LAB-003 discipline: DEEP sorted object keys, arrays keep their
// order because array order is semantic).
// ---------------------------------------------------------------------------

/**
 * The canonical JSON serialization: DEEP sorted object keys (arrays
 * keep their order — array order is semantic), then JSON.stringify.
 * The same logical value always serializes identically regardless of
 * key insertion order — the deterministic-identity discipline.
 */
export function labIdeasCanonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = sortDeep(record[key]);
  }
  return sorted;
}

// ---------------------------------------------------------------------------
// The citation fences (the /lab-features by-reference discipline).
// ---------------------------------------------------------------------------

/**
 * The feature-bundle citation fences: the FULL linkage field set
 * (bounded, uuid-shaped, digest-shaped), the citable
 * bundle-reference pattern, and the STRUCTURAL feature-map echo (at
 * most 64 keys, every value either derived (carrying its bounded
 * representation) or unavailable (carrying its bounded reason)) —
 * recorded data ONLY, never a join, never a media byte.
 */
export function assertValidLabIdeaBundleCitation(citation: LabIdeaBundleCitation): void {
  if (citation === null || typeof citation !== 'object') {
    throw new InvalidRequestError('citation must be an object');
  }
  if (!isUuid(citation.bundleId)) {
    throw new InvalidRequestError('citation.bundleId must be a uuid');
  }
  if (typeof citation.bundleReference !== 'string' || !BUNDLE_REFERENCE_PATTERN.test(citation.bundleReference)) {
    throw new InvalidRequestError('citation.bundleReference must be the citable form <bundleId>#v<n>');
  }
  if (
    citation.bundleVersion === undefined ||
    !Number.isInteger(citation.bundleVersion) ||
    citation.bundleVersion < 1 ||
    citation.bundleVersion > 1000
  ) {
    throw new InvalidRequestError('citation.bundleVersion must be an integer 1-1000');
  }
  if (!isUuid(citation.clientId)) {
    throw new InvalidRequestError('citation.clientId must be a uuid');
  }
  if (!isUuid(citation.referenceId)) {
    throw new InvalidRequestError('citation.referenceId must be a uuid');
  }
  if (!isUuid(citation.corpusId)) {
    throw new InvalidRequestError('citation.corpusId must be a uuid');
  }
  if (!Number.isInteger(citation.corpusVersion) || citation.corpusVersion < 1) {
    throw new InvalidRequestError('citation.corpusVersion must be an integer >= 1');
  }
  if (typeof citation.provider !== 'string' || !PROVIDER_PATTERN.test(citation.provider)) {
    throw new InvalidRequestError('citation.provider must be 1-64 chars of [a-z0-9-]');
  }
  if (!boundedString(citation.providerContentId, 1, 256)) {
    throw new InvalidRequestError('citation.providerContentId must be a trimmed string of 1-256 chars');
  }
  if (typeof citation.canonicalUrl !== 'string' || !HTTP_URL_PATTERN.test(citation.canonicalUrl)) {
    throw new InvalidRequestError('citation.canonicalUrl must be an http(s) URL');
  }
  if (!isHex64(citation.metadataDigest)) {
    throw new InvalidRequestError('citation.metadataDigest must be a 64-char lowercase hex');
  }
  if (!boundedString(citation.featureSetVersion, 1, 64)) {
    throw new InvalidRequestError('citation.featureSetVersion must be a string of 1-64 chars');
  }
  if (typeof citation.extractorId !== 'string' || !DECOMPOSER_ID_PATTERN.test(citation.extractorId)) {
    throw new InvalidRequestError('citation.extractorId must be 1-64 chars of [a-z0-9-]');
  }
  if (!boundedString(citation.extractorVersion, 1, 64)) {
    throw new InvalidRequestError('citation.extractorVersion must be a string of 1-64 chars');
  }
  if (!isHex64(citation.bundleIdentityDigest)) {
    throw new InvalidRequestError('citation.bundleIdentityDigest must be a 64-char lowercase hex');
  }
  // The structural feature-map echo: at most 64 keys, closed states.
  const features = citation.features;
  if (features === null || typeof features !== 'object' || Array.isArray(features)) {
    throw new InvalidRequestError('citation.features must be an object');
  }
  const keys = Object.keys(features);
  if (keys.length > 64) {
    throw new InvalidRequestError('citation.features must hold at most 64 keys');
  }
  for (const key of keys) {
    const value = (features as Record<string, unknown>)[key] as
      | { state?: unknown; value?: unknown; reason?: unknown }
      | undefined
      | null;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new InvalidRequestError(`citation.features['${key}'] must be an object`);
    }
    if (value.state === 'derived') {
      if (value.value === undefined) {
        throw new InvalidRequestError(`citation.features['${key}'] derived value must carry its representation`);
      }
      if (value.reason !== undefined) {
        throw new InvalidRequestError(`citation.features['${key}'] derived value may not carry a reason`);
      }
    } else if (value.state === 'unavailable') {
      if (typeof value.reason !== 'string' || value.reason.length < 1 || value.reason.length > 128) {
        throw new InvalidRequestError(`citation.features['${key}'] unavailable value must carry its reason (1-128 chars)`);
      }
      if (value.value !== undefined) {
        throw new InvalidRequestError(`citation.features['${key}'] unavailable value may not carry a representation (never fabricated)`);
      }
    } else {
      throw new InvalidRequestError(`citation.features['${key}'].state must be 'derived' or 'unavailable'`);
    }
  }
}

// ---------------------------------------------------------------------------
// The proposed-node/edge fences (the decomposer result discipline).
// ---------------------------------------------------------------------------

/**
 * The proposed-node fences: the closed 10-kind primitive vocabulary,
 * the bounded descriptor (1-512 chars) and the bounded structured
 * attributes (a JSON object). NEVER-FABRICATE: the decomposer
 * proposes ONLY what the cited feature values honestly support.
 */
export function assertValidLabIdeaProposedNodes(nodes: ReadonlyArray<LabIdeaProposedNode>): void {
  if (!Array.isArray(nodes)) {
    throw new InvalidRequestError('decomposition nodes must be an array');
  }
  if (nodes.length > LAB_IDEAS_MAX_DECOMPOSITION_NODES) {
    throw new InvalidRequestError(`decomposition may propose at most ${LAB_IDEAS_MAX_DECOMPOSITION_NODES} nodes`);
  }
  for (let seq = 1; seq <= nodes.length; seq += 1) {
    const node = nodes[seq - 1] as LabIdeaProposedNode | undefined;
    if (node === null || typeof node !== 'object') {
      throw new InvalidRequestError(`proposed node #${seq} must be an object`);
    }
    if (!LAB_IDEA_PRIMITIVE_KINDS.includes(node.primitiveKind as LabIdeaPrimitiveKind)) {
      throw new InvalidRequestError(`proposed node #${seq} primitiveKind must be one of ${LAB_IDEA_PRIMITIVE_KINDS.join(', ')}`);
    }
    if (!boundedString(node.descriptor, 1, 512)) {
      throw new InvalidRequestError(`proposed node #${seq} descriptor must be a trimmed string of 1-512 chars`);
    }
    const attributes = node.attributes === undefined ? {} : node.attributes;
    if (attributes === null || typeof attributes !== 'object' || Array.isArray(attributes)) {
      throw new InvalidRequestError(`proposed node #${seq} attributes must be an object`);
    }
    if (Object.keys(attributes).length > 32) {
      throw new InvalidRequestError(`proposed node #${seq} attributes must hold at most 32 keys`);
    }
  }
}

/**
 * The proposed-edge fences: the closed 8-relation vocabulary,
 * 1-based in-range node indices, no self-edges, the bounded count.
 */
export function assertValidLabIdeaProposedEdges(
  edges: ReadonlyArray<LabIdeaProposedEdge>,
  nodeCount: number,
): void {
  if (!Array.isArray(edges)) {
    throw new InvalidRequestError('decomposition edges must be an array');
  }
  if (edges.length > LAB_IDEAS_MAX_DECOMPOSITION_EDGES) {
    throw new InvalidRequestError(`decomposition may propose at most ${LAB_IDEAS_MAX_DECOMPOSITION_EDGES} edges`);
  }
  for (let seq = 1; seq <= edges.length; seq += 1) {
    const edge = edges[seq - 1] as LabIdeaProposedEdge | undefined;
    if (edge === null || typeof edge !== 'object') {
      throw new InvalidRequestError(`proposed edge #${seq} must be an object`);
    }
    if (!LAB_IDEA_EDGE_RELATIONS.includes(edge.relation as LabIdeaEdgeRelation)) {
      throw new InvalidRequestError(`proposed edge #${seq} relation must be one of ${LAB_IDEA_EDGE_RELATIONS.join(', ')}`);
    }
    if (!Number.isInteger(edge.fromSeq) || edge.fromSeq < 1 || edge.fromSeq > nodeCount) {
      throw new InvalidRequestError(`proposed edge #${seq} fromSeq must reference a proposed node (1-${nodeCount})`);
    }
    if (!Number.isInteger(edge.toSeq) || edge.toSeq < 1 || edge.toSeq > nodeCount) {
      throw new InvalidRequestError(`proposed edge #${seq} toSeq must reference a proposed node (1-${nodeCount})`);
    }
    if (edge.fromSeq === edge.toSeq) {
      throw new InvalidRequestError(`proposed edge #${seq} may not be a self-edge`);
    }
  }
}

// ---------------------------------------------------------------------------
// The operation + retrieval fences.
// ---------------------------------------------------------------------------

/**
 * The operation fences: the closed 6-kind vocabulary and the
 * per-kind input-count minimums (recombine/derive/fill_gap ≥ 2;
 * mutate/analogy/invert exactly 1), the bounded input list
 * (1-20), no duplicates, uuid-shaped ids, and the
 * output-primitive-kind rule (REQUIRED for recombine — the
 * cross-kind composition; ABSENT for every other kind — the output
 * kind is derived from the inputs).
 */
export function assertValidLabIdeaOperationInput(input: ApplyLabIdeaOperationInput): void {
  if (input === null || typeof input !== 'object') {
    throw new InvalidRequestError('operation input must be an object');
  }
  if (!LAB_IDEA_OPERATION_KINDS.includes(input.operationKind as LabIdeaOperationKind)) {
    throw new InvalidRequestError(`operationKind must be one of ${LAB_IDEA_OPERATION_KINDS.join(', ')}`);
  }
  if (!Array.isArray(input.inputNodeIds)) {
    throw new InvalidRequestError('inputNodeIds must be an array');
  }
  if (input.inputNodeIds.length < 1 || input.inputNodeIds.length > LAB_IDEAS_MAX_OPERATION_INPUTS) {
    throw new InvalidRequestError(`inputNodeIds must be a bounded list of 1-${LAB_IDEAS_MAX_OPERATION_INPUTS} node ids`);
  }
  const seen = new Set<string>();
  for (const nodeId of input.inputNodeIds) {
    if (typeof nodeId !== 'string' || !isUuid(nodeId)) {
      throw new InvalidRequestError('every inputNodeIds entry must be a uuid');
    }
    if (seen.has(nodeId)) {
      throw new InvalidRequestError('inputNodeIds may not contain duplicates');
    }
    seen.add(nodeId);
  }
  const singleInput = input.operationKind === 'mutate' || input.operationKind === 'analogy' || input.operationKind === 'invert';
  if (singleInput && input.inputNodeIds.length !== 1) {
    throw new InvalidRequestError(`operationKind '${input.operationKind}' cites exactly one input node`);
  }
  if (!singleInput && input.inputNodeIds.length < 2) {
    throw new InvalidRequestError(`operationKind '${input.operationKind}' cites at least two input nodes`);
  }
  if (input.operationKind === 'recombine') {
    if (input.outputPrimitiveKind === undefined || input.outputPrimitiveKind === null) {
      throw new InvalidRequestError(
        "operationKind 'recombine' requires outputPrimitiveKind (the caller-declared output primitive kind — the cross-kind composition)",
      );
    }
    if (!LAB_IDEA_PRIMITIVE_KINDS.includes(input.outputPrimitiveKind as LabIdeaPrimitiveKind)) {
      throw new InvalidRequestError(`outputPrimitiveKind must be one of ${LAB_IDEA_PRIMITIVE_KINDS.join(', ')}`);
    }
  } else if (input.outputPrimitiveKind !== undefined && input.outputPrimitiveKind !== null) {
    throw new InvalidRequestError(
      `outputPrimitiveKind may only be declared for operationKind 'recombine' (every other kind derives the output primitive kind from its inputs)`,
    );
  }
}

/** The citable bundle-reference pattern (the /lab-features citable form '<bundleId>#v<n>'). */
export const LAB_IDEA_BUNDLE_REFERENCE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}#v[1-9][0-9]{0,3}$/;

/** Validates a cited bundle reference shape standalone (the per-cited-bundle chain read filter). */
export function assertValidLabIdeaBundleReference(bundleReference: string): void {
  if (typeof bundleReference !== 'string' || !LAB_IDEA_BUNDLE_REFERENCE_PATTERN.test(bundleReference)) {
    throw new InvalidRequestError('citedBundleReference must be the citable form <bundleId>#v<n>');
  }
}

/**
 * THE RETRIEVAL DISCIPLINE: the origin-class filter is MANDATORY
 * (non-empty, closed vocabulary, no duplicates — the
 * evidence-consuming caller filters explicitly; evidence surfaces
 * pass LAB_IDEAS_EVIDENCE_ORIGIN_CLASSES), the optional
 * primitive-kind subset is closed and duplicate-free, the page size
 * is bounded, the cursor is the opaque shape.
 */
export function assertValidLabIdeaRetrievalInput(input: RetrieveLabIdeaNodesInput): void {
  if (input === null || typeof input !== 'object') {
    throw new InvalidRequestError('retrieval input must be an object');
  }
  if (!Array.isArray(input.originClasses) || input.originClasses.length < 1) {
    throw new InvalidRequestError(
      'originClasses is REQUIRED — queries must filter by origin class explicitly (evidence surfaces pass LAB_IDEAS_EVIDENCE_ORIGIN_CLASSES)',
    );
  }
  const seenOrigins = new Set<string>();
  for (const originClass of input.originClasses) {
    if (!LAB_IDEA_ORIGIN_CLASSES.includes(originClass as LabIdeaOriginClass)) {
      throw new InvalidRequestError(`originClasses entry '${String(originClass)}' must be one of ${LAB_IDEA_ORIGIN_CLASSES.join(', ')}`);
    }
    if (seenOrigins.has(originClass)) {
      throw new InvalidRequestError('originClasses may not contain duplicates');
    }
    seenOrigins.add(originClass);
  }
  if (input.primitiveKinds !== undefined && input.primitiveKinds !== null) {
    if (!Array.isArray(input.primitiveKinds) || input.primitiveKinds.length < 1) {
      throw new InvalidRequestError('primitiveKinds must be a non-empty list when provided');
    }
    const seenKinds = new Set<string>();
    for (const kind of input.primitiveKinds) {
      if (!LAB_IDEA_PRIMITIVE_KINDS.includes(kind as LabIdeaPrimitiveKind)) {
        throw new InvalidRequestError(`primitiveKinds entry '${String(kind)}' must be one of ${LAB_IDEA_PRIMITIVE_KINDS.join(', ')}`);
      }
      if (seenKinds.has(kind)) {
        throw new InvalidRequestError('primitiveKinds may not contain duplicates');
      }
      seenKinds.add(kind);
    }
  }
  if (
    input.citedBundleReference !== undefined &&
    input.citedBundleReference !== null &&
    (typeof input.citedBundleReference !== 'string' || !BUNDLE_REFERENCE_PATTERN.test(input.citedBundleReference))
  ) {
    throw new InvalidRequestError('citedBundleReference must be the citable form <bundleId>#v<n>');
  }
  if (
    input.citedReferenceId !== undefined &&
    input.citedReferenceId !== null &&
    (typeof input.citedReferenceId !== 'string' || !isUuid(input.citedReferenceId))
  ) {
    throw new InvalidRequestError('citedReferenceId must be a uuid');
  }
  if (
    input.limit !== undefined &&
    input.limit !== null &&
    (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > LAB_IDEAS_RETRIEVAL_MAX_LIMIT)
  ) {
    throw new InvalidRequestError(`limit must be an integer 1-${LAB_IDEAS_RETRIEVAL_MAX_LIMIT}`);
  }
  if (input.cursor !== undefined && input.cursor !== null && input.cursor !== '') {
    if (typeof input.cursor !== 'string' || !CURSOR_PATTERN.test(input.cursor)) {
      throw new InvalidRequestError('cursor must be the opaque keyset cursor from a previous page');
    }
  }
}

// ---------------------------------------------------------------------------
// The decomposer + scope declaration fences (the wiring-time gates).
// ---------------------------------------------------------------------------

/** Validates the decomposer port declaration at wiring time (fail fast — the LAB-003 extractor discipline). */
export function assertValidLabIdeaDecomposerDeclaration(decomposer: LabIdeaDecomposer): void {
  if (decomposer === null || typeof decomposer !== 'object' || typeof decomposer.decompose !== 'function') {
    throw new InvalidRequestError('deps.decomposer must be a LabIdeaDecomposer');
  }
  if (typeof decomposer.decomposerId !== 'string' || !DECOMPOSER_ID_PATTERN.test(decomposer.decomposerId)) {
    throw new InvalidRequestError('deps.decomposer.decomposerId must be 1-64 chars of [a-z0-9-]');
  }
  if (typeof decomposer.decomposerVersion !== 'string' || decomposer.decomposerVersion.length < 1 || decomposer.decomposerVersion.length > 64) {
    throw new InvalidRequestError('deps.decomposer.decomposerVersion must be 1-64 chars');
  }
  if (decomposer.ideaSetVersion !== LAB_IDEA_SET_VERSION) {
    throw new InvalidRequestError(
      `deps.decomposer.ideaSetVersion must be '${LAB_IDEA_SET_VERSION}' (the module's pinned idea-set version)`,
    );
  }
}

/** Validates the scope shape (the uniform tenant fence input). */
export function assertValidLabIdeasScope(scope: LabIdeasScope): void {
  if (scope === null || typeof scope !== 'object') {
    throw new InvalidRequestError('scope must be an object');
  }
  if (!isUuid(String(scope.agencyId)) || !isUuid(String(scope.clientId))) {
    throw new InvalidRequestError('scope.agencyId and scope.clientId must be agency/client ids');
  }
  if (scope.workspaceId !== undefined && scope.workspaceId !== null && !isUuid(String(scope.workspaceId))) {
    throw new InvalidRequestError('scope.workspaceId must be a workspace id or null');
  }
}

/** Validates the decompose input shape (scope + citation). */
export function assertValidLabIdeaDecomposeInput(input: DecomposeLabIdeaInput): void {
  if (input === null || typeof input !== 'object') {
    throw new InvalidRequestError('decompose input must be an object');
  }
  assertValidLabIdeasScope(input.scope);
  assertValidLabIdeaBundleCitation(input.citation);
}

// ---------------------------------------------------------------------------
// The deterministic identity derivation (reproducible identity).
// ---------------------------------------------------------------------------

/**
 * THE INPUT DIGEST: SHA-256 over the canonical JSON of the COMPLETE
 * decomposition input of one cited bundle — the citation (identity
 * fields AND the structural feature-map echo). Any change to what
 * the decomposition consumes changes the input digest (and therefore
 * the decomposition identity).
 */
export function computeLabIdeaInputDigest(input: {
  citation: LabIdeaBundleCitation;
}): string {
  return createHash('sha256').update(labIdeasCanonicalJson({ citation: input.citation })).digest('hex');
}

/**
 * THE DETERMINISTIC IDENTITY DIGEST: SHA-256 over the canonical JSON
 * of (the cited bundle's identity fields, the idea-set version, the
 * decomposer identity+version, the input digest) — a PURE FUNCTION:
 * the same inputs always produce the same identity (the idempotence
 * fence); a changed idea-set/decomposer/input version produces a
 * different identity (a NEW decomposition_version row on the same
 * per-cited-bundle chain, never an in-place rewrite).
 */
export function computeLabIdeaIdentityDigest(input: {
  bundleIdentity: {
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
  };
  ideaSetVersion: string;
  decomposerIdentity: { decomposerId: string; decomposerVersion: string };
  inputDigest: string;
}): string {
  return createHash('sha256')
    .update(
      labIdeasCanonicalJson({
        bundleIdentity: input.bundleIdentity,
        ideaSetVersion: input.ideaSetVersion,
        decomposerIdentity: input.decomposerIdentity,
        inputDigest: input.inputDigest,
      }),
    )
    .digest('hex');
}
