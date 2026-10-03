/**
 * /lab-ideas first-party generator (LAB-004) — the HONEST
 * deterministic implementation of the replaceable
 * LabIdeaGeneratorPort (§6's generative seam — the LAB-003
 * extractor-port precedent).
 *
 * WHAT IS REAL vs DETERMINISTIC-FIRST-PARTY vs PENDING (be explicit):
 *
 *   - The MODULE owns the operation records, the output node's
 *     origin class, the recorded lineage, the lineage edges and the
 *     novelty measurement — none of that is the generator's.
 *   - This first-party generator owns ONLY the content generation,
 *     and it is HONEST about what it produces:
 *     * derive    — REAL first-party DETERMINISTIC STRUCTURAL
 *                  derivation: the shared-structure abstraction over
 *                  the input nodes' descriptor token sets (the
 *                  sorted intersection), explicitly labeled
 *                  'derived abstraction (structural)' — never a
 *                  semantic claim;
 *     * recombine — REAL first-party DETERMINISTIC STRUCTURAL
 *                  recombination: the ordered composition of the
 *                  input primitives, explicitly labeled 'combined
 *                  strategy (structural)' — the recorded composition
 *                  of the cited inputs, never invented content;
 *     * fill_gap  — REAL first-party DETERMINISTIC STRUCTURAL gap
 *                  record: the recorded uncovered space between the
 *                  cited delimiting neighbors, explicitly labeled
 *                  'gap' — a RECORDED FACT about the observed graph,
 *                  never invented content;
 *     * mutate / analogy / invert — the OPEN-ENDED GENERATIVE kinds:
 *                  these ship the HONEST PENDING REFUSAL (no row, no
 *                  node — the operation fails closed before any
 *                  record exists) until a real generator is wired
 *                  through the same replaceable port. A structural
 *                  stand-in for a mutation/analogy/inversion would
 *                  LOOK like an idea while being a marker — exactly
 *                  the fabrication this module refuses.
 */

import {
  LAB_IDEAS_MAX_OPERATION_INPUTS,
  type LabIdeaGenerationOutput,
  type LabIdeaGenerationPending,
  type LabIdeaGeneratorPort,
  type LabIdeaNodeRecord,
  type LabIdeaOperationKind,
} from '../public.ts';
import { labIdeaTokenSet } from './novelty.ts';

export const FIRST_PARTY_GENERATOR_ID = 'lab-ideas-structural-first-party' as const;
export const FIRST_PARTY_GENERATOR_VERSION = '1' as const;

/** Bounds a descriptor to the 512-char fence (honest ellipsis marking, never silent truncation). */
function boundedDescriptor(text: string): string {
  return text.length > 512 ? `${text.slice(0, 509)}...` : text;
}

/** The deterministic structural derivation: the shared-structure abstraction over the inputs (derive). */
function deriveStructural(inputNodes: ReadonlyArray<LabIdeaNodeRecord>): LabIdeaGenerationOutput {
  const kinds = new Set(inputNodes.map((node) => node.primitiveKind));
  const kind = [...kinds].sort().join('+');
  const shared = new Set(labIdeaTokenSet(inputNodes[0]!.descriptor));
  for (let index = 1; index < inputNodes.length; index += 1) {
    const tokens = new Set(labIdeaTokenSet(inputNodes[index]!.descriptor));
    for (const token of shared) {
      if (!tokens.has(token)) shared.delete(token);
    }
  }
  const sharedTokens = [...shared].sort();
  const descriptor = boundedDescriptor(
    `derived abstraction (structural): the shared structure of ${inputNodes.length} ${kind} primitives${
      sharedTokens.length > 0 ? ` — shared tokens: ${sharedTokens.slice(0, 24).join(' ')}` : ' (no shared tokens)'
    }`,
  );
  return {
    status: 'generated',
    descriptor,
    attributes: {
      structural: true,
      inputCount: inputNodes.length,
      inputKinds: [...kinds].sort(),
      sharedTokens: sharedTokens.slice(0, 64),
    },
  };
}

/** The deterministic structural recombination: the ordered composition of the inputs (recombine). */
function recombineStructural(inputNodes: ReadonlyArray<LabIdeaNodeRecord>): LabIdeaGenerationOutput {
  const parts = inputNodes.slice(0, LAB_IDEAS_MAX_OPERATION_INPUTS).map((node) => `<${node.primitiveKind}> ${node.descriptor}`);
  const kinds = [...new Set(inputNodes.map((node) => node.primitiveKind))].sort();
  return {
    status: 'generated',
    descriptor: boundedDescriptor(`combined strategy (structural): ${parts.join(' + ')}`),
    attributes: {
      structural: true,
      inputCount: inputNodes.length,
      inputKinds: kinds,
      inputNodeIds: inputNodes.map((node) => node.nodeId),
    },
  };
}

/** The deterministic structural gap record: the uncovered space between the delimiting neighbors (fill_gap). */
function fillGapStructural(inputNodes: ReadonlyArray<LabIdeaNodeRecord>): LabIdeaGenerationOutput {
  const kinds = [...new Set(inputNodes.map((node) => node.primitiveKind))].sort();
  const union = new Set<string>();
  for (const node of inputNodes) {
    for (const token of labIdeaTokenSet(node.descriptor)) union.add(token);
  }
  return {
    status: 'generated',
    descriptor: boundedDescriptor(
      `gap (structural): the uncovered ${kinds.join('+')} space delimited by ${inputNodes.length} observed neighbors — recorded gap, no observed primitive covers it`,
    ),
    attributes: {
      structural: true,
      gap: true,
      inputCount: inputNodes.length,
      neighborKinds: kinds,
      neighborNodeIds: inputNodes.map((node) => node.nodeId),
      neighborhoodTokens: [...union].sort().slice(0, 64),
    },
  };
}

/** The honest pending refusal for the open-ended generative kinds (mutate/analogy/invert). */
function pendingRefusal(operationKind: LabIdeaOperationKind): LabIdeaGenerationPending {
  return {
    status: 'pending',
    reason: `the open-ended generative kind '${operationKind}' has no generator wired — the first-party port ships the honest pending state (a structural stand-in would fabricate an idea; the real generator arrives through this same replaceable port)`,
  };
}

/** Creates the first-party structural generator (the composition-root wiring; test doubles and the future real generator replace it through the port). */
export function createFirstPartyLabIdeaGenerator(): LabIdeaGeneratorPort {
  return {
    generatorId: FIRST_PARTY_GENERATOR_ID,
    generatorVersion: FIRST_PARTY_GENERATOR_VERSION,
    async generate(input: {
      operationKind: LabIdeaOperationKind;
      inputNodes: ReadonlyArray<LabIdeaNodeRecord>;
    }): Promise<LabIdeaGenerationOutput | LabIdeaGenerationPending> {
      switch (input.operationKind) {
        case 'derive':
          return deriveStructural(input.inputNodes);
        case 'recombine':
          return recombineStructural(input.inputNodes);
        case 'fill_gap':
          return fillGapStructural(input.inputNodes);
        case 'mutate':
        case 'analogy':
        case 'invert':
        default:
          return pendingRefusal(input.operationKind);
      }
    },
  };
}
