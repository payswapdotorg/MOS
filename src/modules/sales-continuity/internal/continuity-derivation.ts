/**
 * /sales-continuity pure derivation + guards (MKT-046).
 *
 * EVERYTHING in this file is a PURE function (the profit-derivation
 * precedent): the same decision record + the same derivation version
 * always derive byte-identical carried payloads and playbook inputs —
 * the no-manual-re-entry and version-pinning proofs of
 * spec/architecture-v1.5.md §8.
 *
 *   - deriveCarriedProposalStructure: the structured carry snapshot
 *     (scope / goals / outcomes / assumptions / economics + the source
 *     references with version identity) — a straight programmatic
 *     projection of the decision record's own fields, nothing invented,
 *     nothing re-keyed;
 *   - derivePlaybookInputs: the /playbooks public creation-command
 *     arguments (name, description, strategy, deploymentMetadata) —
 *     deterministic, bounded to the playbook authority's own DTO bounds;
 *   - fingerprintSalesContinuityCreate: the §8-style logical-create
 *     digest (the FNV-1a house pattern — a convergence PROOF, not a
 *     security boundary);
 *   - the input/provenance guards and the DB-conflict classification.
 */

import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import type {
  DecisionRecord,
} from '../../decisions/public.ts';
import type {
  CarriedProposalStructure,
  DerivedPlaybookInputs,
  SalesContinuityCarryInput,
  SalesContinuityDeploymentCarryInput,
  SalesContinuityProvenance,
} from '../public.ts';
import { SALES_CONTINUITY_DERIVATION_VERSION } from '../public.ts';
// The ONE shared cross-module guard of the frozen vocabulary: the §21
// material-key backstop from the /evidence public contract — a single
// source of truth for the forbidden key set (the /decisions and
// /experiments precedent).
// ---------------------------------------------------------------------------
// Shape bounds (module-side; the DB CHECKs mirror the scalar ones)
// ---------------------------------------------------------------------------

// The §21 material-key backstop is applied STRUCTURALLY by the module
// (containsMaterialKey over the derived snapshot jsonb — the house rule:
// the guard checks keys of structured payloads, never free text; the
// import lives in the module implementation, not this pure file).
const MAX_TEXT_200 = 200;
const MAX_TEXT_2000 = 2000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_WORKFLOW_DEFINITION_REFS = 50;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------------------------------------------------------------------------
// The carry payload derivation (pure — the no-manual-re-entry proof)
// ---------------------------------------------------------------------------

/**
 * Derives the structured CARRY SNAPSHOT from one proposal-shaped record.
 * The five §8 dimensions are straight programmatic projections of the
 * decision record's own fields:
 *
 *   scope       ← objective + context;
 *   goals       ← objective (business intent) + hypothesisSummary +
 *                 evidenceRefs + experimentRef;
 *   outcomes    ← expectedImpact + uncertainty;
 *   assumptions ← hypothesisSummary + alternatives + experimentRef;
 *   economics   ← expectedCost + expectedImpactSummary.
 *
 * Purity: the same record always derives the same snapshot; no input
 * other than the record (and the frozen derivation version) participates.
 */
export function deriveCarriedProposalStructure(decision: DecisionRecord): CarriedProposalStructure {
  return {
    derivationVersion: SALES_CONTINUITY_DERIVATION_VERSION,
    source: {
      kind: 'decision',
      decisionId: decision.decisionId,
      fingerprint: decision.createFingerprint,
      disposition: decision.disposition,
    },
    scope: {
      objective: decision.objective,
      context: decision.context,
    },
    goals: {
      objective: decision.objective,
      hypothesisSummary: decision.hypothesisSummary,
      evidenceRefs: [...decision.evidenceRefs],
      experimentRef: decision.experimentRef,
    },
    outcomes: {
      expectedImpact: {
        summary: decision.expectedImpact.summary,
        direction: decision.expectedImpact.direction,
        magnitude: decision.expectedImpact.magnitude,
      },
      uncertainty: decision.uncertainty,
    },
    assumptions: {
      hypothesisSummary: decision.hypothesisSummary,
      alternatives: [...decision.alternatives],
      experimentRef: decision.experimentRef,
    },
    economics: {
      expectedCost: decision.expectedCost,
      expectedImpactSummary: decision.expectedImpact.summary,
    },
  };
}

// ---------------------------------------------------------------------------
// The playbook-input derivation (pure — feeds the /playbooks commands)
// ---------------------------------------------------------------------------

/** Deterministic bounded truncation (no content invention, no re-keying). */
function bounded(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/**
 * Derives the /playbooks creation-command arguments from the proposal-
 * shaped record — the exact inputs fed to createClientPlaybook (name,
 * description) and createPlaybookVersion (strategy, deploymentMetadata).
 *
 *   name        ← 'Proposal — <objective>' (≤ 200, the playbook DTO bound);
 *   description ← the objective, context, hypothesis summary, expected
 *                 impact and expected cost, composed verbatim (≤ 2000);
 *   strategy    ← summary = objective + hypothesis summary; exactly ONE
 *                 template whose name is the objective and whose
 *                 description is the expected-impact summary (the
 *                 proposal's outcome expectation, carried as the first
 *                 strategy/workflow template);
 *   deploymentMetadata ← the minimal clean declaration: no packs, no
 *                 capabilities (the proposal vocabulary carries none —
 *                 nothing invented), the runtime class 'pooled-worker'
 *                 and exactly one MANUAL trigger — the two DISCLOSED
 *                 default assumptions of the derived delivery substrate
 *                 (the platform's standard compute allocation for
 *                 normal AI/API/data tasks, MKT-011, and
 *                 operator-initiated execution with no invented
 *                 schedule or event subscription). The /deployments
 *                 authority pins deployments to a concrete runtime
 *                 class and at least one trigger, so the derivation
 *                 declares the defaults explicitly instead of leaving
 *                 them undefined: explicit, deterministic, versioned
 *                 assumptions (the profit-intelligence assumption-set
 *                 posture), never silent constants.
 *
 * Purity: the same record always derives the same inputs.
 */
export function derivePlaybookInputs(decision: DecisionRecord): DerivedPlaybookInputs {
  const objective = decision.objective.trim();
  const hypothesis = decision.hypothesisSummary.trim();
  const descriptionParts = [
    `Carried from proposal ${decision.decisionId}.`,
    `Objective: ${objective}`,
    decision.context === null ? null : `Context: ${decision.context.trim()}`,
    `Hypothesis: ${hypothesis}`,
    `Expected impact: ${decision.expectedImpact.summary.trim()}`,
    decision.expectedCost === null ? null : `Expected cost: ${decision.expectedCost.trim()}`,
  ].filter((part): part is string => part !== null);

  return {
    name: bounded(`Proposal — ${objective}`, MAX_TEXT_200),
    description: bounded(descriptionParts.join(' '), MAX_TEXT_2000),
    strategy: {
      summary: bounded(`Objective: ${objective} — hypothesis: ${hypothesis}`, MAX_TEXT_2000),
      templates: [
        {
          name: bounded(objective, MAX_TEXT_200),
          description: bounded(decision.expectedImpact.summary.trim(), MAX_TEXT_2000),
        },
      ],
    },
    deploymentMetadata: {
      requiredDomainPacks: [],
      requiredCapabilities: [],
      // The disclosed default compute allocation + the disclosed manual
      // trigger (see the doc comment above — part of the frozen
      // sc-carry-v1 derivation rules).
      runtimeRequirements: { runtimeClass: 'pooled-worker' as const },
      triggers: [{ kind: 'manual' as const, config: null }],
    },
  };
}

// ---------------------------------------------------------------------------
// The §8 carry fingerprint (pure)
// ---------------------------------------------------------------------------

/**
 * The deterministic digest of the caller-visible logical carry command
 * (the source decision + the optional goal link) — the convergence proof
 * for the (client_id, idempotency_key) DB fence. The FNV-1a house
 * pattern (a proof, not a security boundary).
 */
export function fingerprintSalesContinuityCreate(input: SalesContinuityCarryInput): string {
  const canonical = JSON.stringify({
    decisionId: input.decisionId,
    goalId: input.goalId,
  });
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `sc1:${hash.toString(16).padStart(8, '0')}:${canonical.length}`;
}

// ---------------------------------------------------------------------------
// Input + provenance guards (pure; the DB CHECKs mirror the scalars)
// ---------------------------------------------------------------------------

function uuidRefProblems(label: string, value: string): string[] {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    return [`${label}: must be a canonical record id (uuid)`];
  }
  return [];
}

/**
 * The playbook-carry input guard: the proposal anchor (a canonical
 * decision id), the optional /goals link (a canonical id or null) and
 * the bounded §8 logical create key. §21 defense in depth — material-
 * shaped keys can never appear in the idempotency key.
 */
export function assertValidSalesContinuityCarryInput(input: SalesContinuityCarryInput): void {
  const problems: string[] = [];
  problems.push(...uuidRefProblems('decisionId', input.decisionId));
  if (input.goalId !== null) {
    problems.push(...uuidRefProblems('goalId', input.goalId));
  }
  if (
    typeof input.idempotencyKey !== 'string' ||
    input.idempotencyKey.trim() === '' ||
    input.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH
  ) {
    problems.push(
      `idempotencyKey: a non-empty key of at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters is required`,
    );
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('Sales continuity carry input is not valid', problems);
  }
}

/**
 * The deployment-carry input guard: the carry anchor, the target
 * workspace (canonical ids), the bounded non-empty workflow definition
 * reference list (the caller's delivery work products — each a canonical
 * id, at most 50) and the bounded §8 logical command key.
 */
export function assertValidSalesContinuityDeploymentCarryInput(
  input: SalesContinuityDeploymentCarryInput,
): void {
  const problems: string[] = [];
  problems.push(...uuidRefProblems('carryId', input.carryId));
  problems.push(...uuidRefProblems('workspaceId', input.workspaceId));
  if (!Array.isArray(input.workflowDefinitionIds) || input.workflowDefinitionIds.length === 0) {
    problems.push('workflowDefinitionIds: at least one workflow definition reference is required');
  } else {
    if (input.workflowDefinitionIds.length > MAX_WORKFLOW_DEFINITION_REFS) {
      problems.push(
        `workflowDefinitionIds: at most ${MAX_WORKFLOW_DEFINITION_REFS} references are allowed`,
      );
    }
    input.workflowDefinitionIds.forEach((definitionId, index) => {
      if (typeof definitionId !== 'string' || !UUID_PATTERN.test(definitionId)) {
        problems.push(
          `workflowDefinitionIds[${index}]: must be a canonical workflow definition id (uuid)`,
        );
      }
    });
  }
  if (
    typeof input.idempotencyKey !== 'string' ||
    input.idempotencyKey.trim() === '' ||
    input.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH
  ) {
    problems.push(
      `idempotencyKey: a non-empty key of at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters is required`,
    );
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('Sales continuity deployment carry input is not valid', problems);
  }
}

/**
 * The server-derived provenance guard: the carry's audit identity must be
 * complete BEFORE anything runs (fail closed — the /decisions pattern).
 */
export function assertValidSalesContinuityProvenance(
  provenance: SalesContinuityProvenance,
): void {
  const problems: string[] = [];
  if (typeof provenance.actor !== 'string' || provenance.actor.trim() === '') {
    problems.push('actor: a non-empty server-derived actor label is required');
  }
  if (
    typeof provenance.recordedVia !== 'string' ||
    provenance.recordedVia.trim() === '' ||
    provenance.recordedVia.length > 100
  ) {
    problems.push('recordedVia: a non-empty recording system label of at most 100 characters is required');
  }
  if (typeof provenance.correlationId !== 'string' || provenance.correlationId.trim() === '') {
    problems.push('correlationId: a non-empty correlation identity is required');
  }
  if (
    provenance.causationId !== null &&
    (typeof provenance.causationId !== 'string' || provenance.causationId.trim() === '')
  ) {
    problems.push('causationId: must be null or a non-empty causation identity');
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('Sales continuity provenance is not valid', problems);
  }
}

// ---------------------------------------------------------------------------
// DB-conflict classification (pure — the store/module convergence aid)
// ---------------------------------------------------------------------------

/** The classified conflict families of the continuity ledger's backstops. */
export type SalesContinuityWriteConflict =
  | 'source-fence'
  | 'idempotency-fence'
  | 'forward-completion'
  | 'reference-fence';

/**
 * Classifies a raw DB error from the continuity ledger's triggers/unique
 * fences into the disclosed conflict families (null when unrecognized —
 * the caller rethrows). The house classify*Conflict pattern.
 */
export function classifySalesContinuityWriteConflict(error: unknown): SalesContinuityWriteConflict | null {
  if (!(error instanceof Error)) return null;
  const message = error.message;
  if (message.includes('sales_continuity_carries_source_decision_id_key')) return 'source-fence';
  if (message.includes('sales_continuity_carries_idempotency_key_unique')) return 'idempotency-fence';
  if (message.includes('carry completion is forward-only')) return 'forward-completion';
  if (
    message.includes('does not belong to client') ||
    message.includes('must belong to client') ||
    message.includes('must reference a carry of the same client')
  ) {
    return 'reference-fence';
  }
  return null;
}
