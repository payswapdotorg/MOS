/**
 * The FIRST-PARTY quality evaluator (LAB-013 — the declared-evaluator
 * port's honest default implementation, the LAB-003 first-party
 * extractor precedent).
 *
 * THE HONEST SHAPE EVALUATION (deliberately deterministic, deliberately
 * modest): the delivered artifact is validated against the capability
 * contract's DECLARED output schema (the one-level subset — the pure
 * validator from validation.ts) and the declared evaluation-contract
 * shape is echoed on the evidence. The verdict is 'pass' when the
 * artifact satisfies the declared schema, 'fail' when it does not —
 * never a fabricated pass, never an invented quality score. Richer
 * evaluator backends (model-graded, human-graded) arrive as future port
 * implementations at the composition root — never silent
 * reinterpretation of the declared data.
 */

import type {
  LabCapabilityEvaluationOutcome,
  LabCapabilityEvaluationRequest,
  LabCapabilityQualityEvaluatorPort,
} from '../public.ts';
import { validateValueAgainstLabCapabilitySchema } from './validation.ts';

export const FIRST_PARTY_EVALUATOR_ID = 'first-party-shape-evaluator' as const;
export const FIRST_PARTY_EVALUATOR_VERSION = '1' as const;

export function createFirstPartyLabCapabilityEvaluator(): LabCapabilityQualityEvaluatorPort {
  return {
    async evaluate(request: LabCapabilityEvaluationRequest): Promise<LabCapabilityEvaluationOutcome> {
      const shapeCheck = validateValueAgainstLabCapabilitySchema(
        request.deliveredArtifact,
        request.outputSchema,
      );
      const evidenceContractCheck = validateValueAgainstLabCapabilitySchema(
        { ...request.deliveredArtifact },
        request.declaredEvaluator.evaluationContract,
      );
      const errors = [...shapeCheck.errors, ...evidenceContractCheck.errors];
      return {
        verdict: errors.length === 0 ? 'pass' : 'fail',
        evidence: {
          evaluatorId: request.declaredEvaluator.evaluatorId,
          evaluatorVersion: request.declaredEvaluator.evaluatorVersion,
          shapeCheckOk: shapeCheck.ok,
          evaluationContractCheckOk: evidenceContractCheck.ok,
          errors: errors.slice(0, 16),
          checkedKeys: Object.keys(request.deliveredArtifact).length,
        },
      };
    },
  };
}
