/**
 * /lab-ideas deterministic core (LAB-004) — the frozen NOVELTY
 * formula + the lineage construction (pure functions).
 *
 * THE FROZEN NOVELTY FORMULA ('lab-idea-novelty-v1', disclosed):
 *
 *   novelty(candidate, observedSameKindNodes) =
 *       1 − max{ Jaccard(tokens(candidate.descriptor), tokens(n.descriptor)) | n ∈ observedSameKind }
 *     ( 1 when observedSameKind is empty )
 *
 *   tokens(descriptor) = the deduplicated set of lowercase
 *   alphanumeric tokens (split on non-alphanumeric runs, empty
 *   tokens dropped) — the frozen tokenization.
 *   Jaccard(A, B)      = |A ∩ B| / |A ∪ B|   (0 when both sets are
 *   empty — two empty descriptors are NOT identical content).
 *
 * The score is a PURE FUNCTION of (the recorded graph state — the
 * observed nodes of the same primitive kind — and the candidate):
 * no clock, no randomness, no similarity engine, no second search
 * index. NOVELTY IS MEASURED AGAINST OBSERVED NODES ONLY (§6: "No
 * generated idea is treated as source evidence merely because it
 * resembles an observed item" — and symmetrically, a generated
 * candidate is never measured against other generated nodes: the
 * caller-supplied comparison set is the OBSERVED set, and the
 * module's operation path measures every generated/combined/
 * derived output against observed nodes only).
 *
 * THE LINEAGE CONSTRUCTION (deterministic, recorded at creation —
 * never computed post-hoc from resemblance): the creating
 * operation's new edges (each input → the output, the operation's
 * relation, ordered by input position) come first, then each
 * input's own recorded lineage steps are appended in input order
 * (deduplicated by (fromNodeId, toNodeId, relation), renumbered
 * 1..N), bounded by LAB_IDEAS_MAX_LINEAGE_STEPS — a lineage that
 * would exceed the bound fails closed (the honest bound, never a
 * silent truncation).
 */

import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import {
  LAB_IDEA_NOVELTY_VERSION,
  LAB_IDEA_EDGE_RELATIONS,
  LAB_IDEAS_MAX_LINEAGE_STEPS,
  type LabIdeaEdgeRelation,
  type LabIdeaLineageStep,
  type LabIdeaNoveltyMeasure,
  type LabIdeaPrimitiveKind,
} from '../public.ts';

// ---------------------------------------------------------------------------
// The frozen tokenization + similarity (the novelty/clustering substrate).
// ---------------------------------------------------------------------------

/**
 * The frozen tokenization of a descriptor: the DEDUPLICATED set of
 * lowercase alphanumeric tokens (split on non-alphanumeric runs,
 * empty tokens dropped), returned sorted for deterministic
 * serialization. Pure.
 */
export function labIdeaTokenSet(descriptor: string): ReadonlyArray<string> {
  const tokens = new Set<string>();
  for (const raw of descriptor.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length > 0) tokens.add(raw);
  }
  return [...tokens].sort();
}

/**
 * The frozen Jaccard similarity over token sets: |A ∩ B| / |A ∪ B|
 * (0 when both sets are empty — two empty descriptors are not
 * identical content). Pure.
 */
export function labIdeaJaccardSimilarity(a: ReadonlyArray<string>, b: ReadonlyArray<string>): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  let intersection = 0;
  for (const token of b) {
    if (setA.has(token)) intersection += 1;
  }
  const union = setA.size + b.length - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// The frozen novelty formula ('lab-idea-novelty-v1').
// ---------------------------------------------------------------------------

/** The novelty comparison input: one observed node of the same primitive kind. */
export interface LabIdeaNoveltyComparisonNode {
  nodeId: string;
  descriptor: string;
}

/** The pure novelty computation over the observed same-kind comparison set (the frozen formula). */
export function computeLabIdeaNovelty(
  candidate: { primitiveKind: LabIdeaPrimitiveKind; descriptor: string },
  observedSameKind: ReadonlyArray<LabIdeaNoveltyComparisonNode>,
): LabIdeaNoveltyMeasure {
  const candidateTokens = labIdeaTokenSet(candidate.descriptor);
  let nearestNodeId: string | null = null;
  let nearestSimilarity = 0;
  for (const node of observedSameKind) {
    const similarity = labIdeaJaccardSimilarity(candidateTokens, labIdeaTokenSet(node.descriptor));
    if (similarity > nearestSimilarity || (similarity === nearestSimilarity && nearestNodeId === null)) {
      // The deterministic tie-break: the FIRST max-similarity node in
      // the recorded (node_id ascending) comparison order wins.
      nearestNodeId = node.nodeId;
      nearestSimilarity = similarity;
    } else if (similarity === nearestSimilarity && nearestNodeId !== null && node.nodeId < nearestNodeId) {
      nearestNodeId = node.nodeId;
    }
  }
  const noveltyScore = observedSameKind.length === 0 ? 1 : round4(1 - nearestSimilarity);
  return {
    noveltyVersion: LAB_IDEA_NOVELTY_VERSION,
    primitiveKind: candidate.primitiveKind,
    noveltyScore,
    observedComparisonCount: observedSameKind.length,
    nearestObservedNodeId: nearestNodeId,
    nearestSimilarity: round4(nearestSimilarity),
  };
}

/** Rounds to 4 decimal places (the numeric(5,4) DB column discipline — deterministic rounding). */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

// ---------------------------------------------------------------------------
// The deterministic lineage construction.
// ---------------------------------------------------------------------------

/**
 * THE LINEAGE CONSTRUCTION (recorded at creation): the operation's
 * new edges (each input → the output node, the operation's relation,
 * ordered by input position) followed by each input's own recorded
 * lineage steps (in input order, deduplicated by
 * (fromNodeId, toNodeId, relation), renumbered 1..N). A lineage
 * exceeding LAB_IDEAS_MAX_LINEAGE_STEPS fails closed.
 */
export function buildLabIdeaLineage(input: {
  outputNodeId: string;
  relation: LabIdeaEdgeRelation;
  /** The operation's input node ids in cited order. */
  inputNodeIds: ReadonlyArray<string>;
  /** Each input's own recorded lineage (null for observed inputs — their chain ends at them). */
  inputLineages: ReadonlyArray<ReadonlyArray<LabIdeaLineageStep> | null>;
}): ReadonlyArray<LabIdeaLineageStep> {
  const steps: Array<{ fromNodeId: string; toNodeId: string; relation: LabIdeaEdgeRelation }> = [];
  const seen = new Set<string>();
  const push = (fromNodeId: string, toNodeId: string, relation: LabIdeaEdgeRelation): void => {
    const key = `${fromNodeId}|${toNodeId}|${relation}`;
    if (seen.has(key)) return;
    seen.add(key);
    steps.push({ fromNodeId, toNodeId, relation });
    if (steps.length > LAB_IDEAS_MAX_LINEAGE_STEPS) {
      throw new InvalidRequestError(
        `the recorded lineage would exceed the ${LAB_IDEAS_MAX_LINEAGE_STEPS}-step bound — the operation chain is too deep (fail closed, never silently truncated)`,
      );
    }
  };
  // (1) The creating operation's new edges — ordered by input position.
  for (const inputNodeId of input.inputNodeIds) {
    push(inputNodeId, input.outputNodeId, input.relation);
  }
  // (2) The inputs' own recorded lineages — in input order.
  for (const lineage of input.inputLineages) {
    if (lineage === null || lineage === undefined) continue;
    for (const step of lineage) {
      push(step.fromNodeId, step.toNodeId, step.relation);
    }
  }
  return steps.map((step, index) => ({ seq: index + 1, ...step }));
}

/** Validates a recorded lineage chain's shape (bounded, well-formed steps — the read-back fence). */
export function assertValidLabIdeaLineage(lineage: unknown): asserts lineage is ReadonlyArray<LabIdeaLineageStep> {
  if (!Array.isArray(lineage)) {
    throw new InvalidRequestError('lineage must be an array');
  }
  if (lineage.length > LAB_IDEAS_MAX_LINEAGE_STEPS) {
    throw new InvalidRequestError(`lineage must hold at most ${LAB_IDEAS_MAX_LINEAGE_STEPS} steps`);
  }
  for (let index = 0; index < lineage.length; index += 1) {
    const step = lineage[index] as LabIdeaLineageStep | null | undefined;
    if (step === null || typeof step !== 'object') {
      throw new InvalidRequestError('every lineage step must be an object');
    }
    if (step.seq !== index + 1) {
      throw new InvalidRequestError('lineage steps must be numbered 1..N in order');
    }
    if (typeof step.fromNodeId !== 'string' || typeof step.toNodeId !== 'string') {
      throw new InvalidRequestError('every lineage step must carry fromNodeId and toNodeId');
    }
    if (typeof step.relation !== 'string' || !LAB_IDEA_EDGE_RELATIONS.includes(step.relation as LabIdeaEdgeRelation)) {
      throw new InvalidRequestError('every lineage step must carry its relation from the closed vocabulary');
    }
  }
}
