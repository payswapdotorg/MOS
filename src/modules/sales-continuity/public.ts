/**
 * MarketingOS module: /sales-continuity (MKT-046 — Sales-to-Delivery
 * Continuity).
 *
 * Authority: NONE over any composed module — the module is the ORCHESTRATOR
 * of spec/architecture-v1.5.md §8 ("Proposal data may carry structured
 * scope, goals, outcomes, assumptions and economics into the Playbook/
 * Deployment path without manual re-entry. Provenance and version identity
 * are retained"; the primary contract spec/operating-graph-v1.5.md
 * "Sales-to-delivery continuity"; frozen by spec/architecture-lock-v1.5.md
 * rule #15 "PostgreSQL remains authoritative for durable MOS state" and
 * the singular-authorities list of architecture-v1.5.md §2).
 *
 * THE DISCLOSED DISCOVERY (where the proposal/sales surface lives today):
 *
 *   - The structured commercial-proposal surface is the DECISION LEDGER
 *     (/decisions, MKT-042, migration 036). A DecisionRecord IS "the
 *     immutable proposal payload + the lifecycle columns" (the /decisions
 *     public contract's own words) and starts at disposition 'proposed':
 *       * SCOPE        → objective (required) + context (optional);
 *       * GOALS        → objective (the business intent) + hypothesisSummary
 *                       (the informing hypothesis) + evidenceRefs +
 *                       experimentRef (the hypothesis link);
 *       * OUTCOMES     → expectedImpact (structured summary + direction +
 *                       magnitude) + uncertainty (interval | distribution |
 *                       qualitative);
 *       * ASSUMPTIONS  → hypothesisSummary + alternatives (the considered
 *                       alternatives) + experimentRef;
 *       * ECONOMICS    → expectedCost (the declared expected cost) +
 *                       expectedImpact + uncertainty.
 *     A proposal "version" is one immutable ledger row: corrections are NEW
 *     decision records linked through the predecessor/successor chain, so
 *     the canonical decisionId IS the version identity and the row's
 *     createFingerprint is the exact-content proof.
 *   - 'sales_agent' in the Creator Operations Domain Pack contract is a
 *     Human Agent SPECIALIZATION MIRROR only (role metadata — no proposal
 *     store; creator-operations-v1.3.md §4);
 *   - the /policies "access proposals" are CRED-001 credential-access
 *     proposals — unrelated to commercial proposals;
 *   - there is NO other proposal/sales table or module in MOS v1.5.
 *
 * THE CARRY (what this module does):
 *
 *   1. PLAYBOOK CARRY (carryProposalToPlaybook): from a proposal-shaped
 *      record (an ACCEPTED decision of the owning Client — a rejected or
 *      superseded proposal was never approved for delivery; a still-
 *      'proposed' one has not been commercially decided), the module
 *      derives the structured carry payload (scope/goals/outcomes/
 *      assumptions/economics — a deterministic pure function of the
 *      decision record; NO caller-supplied content, no manual re-entry)
 *      and creates the Client-scoped Playbook + its first Playbook Version
 *      THROUGH THE EXISTING /playbooks PUBLIC CREATION COMMANDS
 *      (createClientPlaybook + createPlaybookVersion). The module never
 *      writes playbook tables, never creates a second playbook store, and
 *      never bypasses the playbook authority's own validation.
 *   2. DEPLOYMENT CARRY (carryPlaybookToDeployment, "where applicable"):
 *      the carried Playbook Version is moved through the FROZEN playbook
 *      lifecycle (draft → review → published — the existing
 *      setPlaybookVersionStatus command, whose activation policies run
 *      intact) and one Deployment is configured THROUGH THE EXISTING
 *      /deployments PUBLIC CREATION COMMAND (createDeployment) with the
 *      selection DERIVED from the carried version's own deployment
 *      metadata plus the caller's workflow definition references (delivery
 *      work products, never proposal data). MKT-040 validation semantics
 *      are NOT bypassed: the deployment is born DRAFT and the
 *      validate-before-activate gate stays the /deployments authority's
 *      alone (this module never calls validate/activate/transition).
 *
 * PERSISTENCE CHOICE (AC-6, DISCLOSED): the existing creation commands
 * expose NO provenance-carrying surface (createClientPlaybook/
 * createPlaybookVersion/createDeployment accept no source references), so
 * the module OWNS an append-only continuity ledger — migration
 * 040_sales_continuity.sql (the pre-assigned number; 038/039 belong to
 * sibling deliveries), the 035/036 house style: CHECK-fenced kinds and
 * shapes, the one-shot forward-only completion columns, append-only event
 * tail triggers, and cross-tenant reference fences. The ledger carries:
 *   - the SOURCE references (canonical proposal decisionId + the exact
 *     content fingerprint — the version identity);
 *   - the CARRIED RECORD references (playbookId + playbookVersionId +
 *     versionNumber, later deploymentId) — the delivery-side linkage;
 *   - the CARRIED STRUCTURE SNAPSHOT (the derived scope/goals/outcomes/
 *     assumptions/economics payload as carried, byte-stable);
 *   - the §8-style logical create identity (idempotency key +
 *     fingerprint) and the server-derived provenance columns.
 * No other module's table is created, altered or written.
 *
 * IDENTITY RULES (AC-5): re-carry of the SAME proposal version (the same
 * source decisionId) is a disclosed duplicate-guard no-op — it converges
 * to the recorded carry (replayed=true, no new playbook). A NEW proposal
 * version (a successor decision record — a different decisionId) carries
 * FRESH identity (a new carry row + a new playbook); the old carried
 * identity is preserved and never rewritten (the ledger's
 * forward-completion triggers forbid backwards or repeated rewrites).
 * A carry claimed but never completed stays 'carrying' (an UNRESOLVED
 * claim — the v1.2/v1.3 UNKNOWN posture: unknown side effects are never
 * blindly replayed); re-carrying into it is a ConflictError, disclosed for
 * manual reconciliation.
 *
 * Dependency posture (the frozen matrix line added for MKT-046):
 * /sales-continuity ──→ /decisions, /playbooks, /deployments, /clients,
 * /workspaces — /decisions consumed READ-ONLY (ownership resolution +
 * the proposal record), /playbooks and /deployments consumed through
 * their EXISTING public creation/status commands (the only writes this
 * module can cause anywhere), /clients + /workspaces consumed READ-ONLY
 * through the declared STRUCTURAL PORTS (the /decisions precedent).
 * Cross-module access may only target this public entry (public.ts);
 * internal/ is unimportable from other modules (enforced by
 * tools/arch-check and tests/architecture/sales-continuity-boundary.test.ts).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import type {
  DecisionDisposition,
  DecisionExpectedImpact,
  DecisionRecord,
  DecisionUncertainty,
} from '../decisions/public.ts';
import type {
  PlaybookDeploymentMetadata,
  PlaybookRecord,
  PlaybookStrategy,
  PlaybookVersionRecord,
} from '../playbooks/public.ts';
import type { DeploymentRecord } from '../deployments/public.ts';

// ---------------------------------------------------------------------------
// The frozen carry vocabulary (closed sets — extension is a code change)
// ---------------------------------------------------------------------------

/**
 * The closed lifecycle of one continuity carry (the forward-only
 * completion ladder; the DB trigger is the final backstop):
 *
 *   carrying → carried → deployed
 *
 * 'carrying'  — the ledger claim is durable but the playbook creation has
 *               not completed yet (an in-flight or crashed orchestration;
 *               an UNRESOLVED claim — never blindly replayed);
 * 'carried'   — the playbook + version were created through the /playbooks
 *               creation commands and the linkage is durable;
 * 'deployed'  — the deployment-path carry completed (the version published
 *               through the frozen lifecycle + the deployment configured
 *               through the /deployments creation command).
 */
export const SALES_CONTINUITY_CARRY_STATES = ['carrying', 'carried', 'deployed'] as const;

export type SalesContinuityCarryState = (typeof SALES_CONTINUITY_CARRY_STATES)[number];

export function isKnownSalesContinuityCarryState(value: string): value is SalesContinuityCarryState {
  return (SALES_CONTINUITY_CARRY_STATES as readonly string[]).includes(value);
}

/**
 * The closed event vocabulary of the append-only continuity tail:
 *   - 'carry-claimed'        — the §8 fence claim (source + snapshot);
 *   - 'playbook-carried'     — the playbook completion (ids + numbers);
 *   - 'deployment-carried'   — the deployment-path completion.
 */
export const SALES_CONTINUITY_EVENT_KINDS = [
  'carry-claimed',
  'playbook-carried',
  'deployment-carried',
] as const;

export type SalesContinuityEventKind = (typeof SALES_CONTINUITY_EVENT_KINDS)[number];

/**
 * The derivation vocabulary of the carried structure — the five frozen
 * proposal dimensions of spec/architecture-v1.5.md §8, each derived
 * programmatically from the decision record (no manual re-entry).
 */
export const SALES_CONTINUITY_CARRIED_DIMENSIONS = [
  'scope',
  'goals',
  'outcomes',
  'assumptions',
  'economics',
] as const;

export type SalesContinuityCarriedDimension = (typeof SALES_CONTINUITY_CARRIED_DIMENSIONS)[number];

/**
 * The carry derivation version — the deterministic derivation rules this
 * module applies. Same decision record + this version ⇒ byte-identical
 * carried payloads and playbook inputs (the pinning proof, the
 * profit-intelligence calculation-version precedent). A change to ANY
 * derivation rule is a NEW version string — carried structures are
 * versioned, never silently re-stated.
 */
export const SALES_CONTINUITY_DERIVATION_VERSION = 'sc-carry-v1' as const;

// ---------------------------------------------------------------------------
// The carried proposal structure (the derived snapshot — AC-2/AC-4)
// ---------------------------------------------------------------------------

/**
 * The structured CARRY SNAPSHOT derived from one proposal-shaped record
 * (an accepted decision). Every field is a PROGRAMMATIC derivation
 * (internal/continuity-derivation.ts — pure, deterministic, unit-tested);
 * the snapshot is persisted verbatim on the ledger row and stays
 * byte-stable after the claim. The field types ARE the /decisions public
 * contract's own shapes — nothing is re-declared or shadowed.
 */
export interface CarriedProposalStructure {
  /** The derivation identity of this snapshot (the pinning proof). */
  readonly derivationVersion: string;
  readonly source: {
    readonly kind: 'decision';
    /** The canonical proposal record id — the version identity. */
    readonly decisionId: string;
    /** The proposal's exact-content fingerprint (createFingerprint). */
    readonly fingerprint: string;
    /** The disposition at carry time (always 'accepted' — the gate). */
    readonly disposition: DecisionDisposition;
  };
  readonly scope: {
    readonly objective: string;
    readonly context: string | null;
  };
  readonly goals: {
    /** The business intent the delivery path operationalizes. */
    readonly objective: string;
    readonly hypothesisSummary: string;
    readonly evidenceRefs: readonly string[];
    readonly experimentRef: string | null;
  };
  readonly outcomes: {
    readonly expectedImpact: DecisionExpectedImpact;
    readonly uncertainty: DecisionUncertainty | null;
  };
  readonly assumptions: {
    readonly hypothesisSummary: string;
    readonly alternatives: readonly string[];
    readonly experimentRef: string | null;
  };
  readonly economics: {
    readonly expectedCost: string | null;
    readonly expectedImpactSummary: string;
  };
}

/**
 * The derived PLAYBOOK CREATION inputs (the /playbooks public creation
 * command arguments) — deterministic pure functions of the decision
 * record. `name`/`description` feed createClientPlaybook; `strategy` +
 * `deploymentMetadata` feed createPlaybookVersion. Bounds mirror the
 * /playbooks authority's own DTO bounds (name ≤ 200, description ≤ 2000).
 */
export interface DerivedPlaybookInputs {
  readonly name: string;
  readonly description: string;
  readonly strategy: PlaybookStrategy;
  readonly deploymentMetadata: PlaybookDeploymentMetadata;
}

// ---------------------------------------------------------------------------
// Provenance (server-derived — implementation-contract §3)
// ---------------------------------------------------------------------------

/**
 * SERVER-DERIVED provenance of one continuity mutation (the MKT-013/042
 * pattern): built exclusively from the authenticated principal, the
 * ambient correlation context and the recording surface — never from a
 * request body (route validation rejects provenance-shaped authority
 * fields; this type is a separate module-API argument so no DTO can feed
 * it structurally).
 */
export interface SalesContinuityProvenance {
  readonly actor: string;
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

/** Provenance as persisted on the ledger rows. */
export interface SalesContinuityRecordedProvenance extends SalesContinuityProvenance {
  /** Server-stamped recording time (module clock, never caller input). */
  readonly recordedAt: string;
}

// ---------------------------------------------------------------------------
// Records + inputs
// ---------------------------------------------------------------------------

/** One continuity carry: the durable proposal → delivery linkage row. */
export interface SalesContinuityCarryRecord {
  readonly carryId: string;
  readonly clientId: string;
  /** The owning Agency, server-derived through the canonical /clients chain. */
  readonly agencyId: string;
  /** The source decision's optional Workspace scope (informational provenance). */
  readonly sourceWorkspaceId: string | null;
  // --- the SOURCE references (AC-4: canonical proposal id + version identity) ---
  readonly sourceDecisionId: string;
  readonly sourceFingerprint: string;
  // --- the CARRIED RECORD references (the delivery-side linkage) ---
  readonly carriedPlaybookId: string | null;
  readonly carriedPlaybookVersionId: string | null;
  readonly carriedVersionNumber: number | null;
  readonly carriedDeploymentId: string | null;
  // --- the lifecycle (forward-only completion ladder) ---
  readonly carryState: SalesContinuityCarryState;
  // --- the carried structure snapshot (byte-stable after the claim) ---
  readonly carriedPayload: CarriedProposalStructure;
  // --- the §8-style logical create identity ---
  readonly idempotencyKey: string;
  readonly createFingerprint: string;
  // --- audit metadata (server-derived, immutable) ---
  readonly provenance: SalesContinuityRecordedProvenance;
}

/** One append-only continuity event (the immutable history tail). */
export interface SalesContinuityEventRecord {
  readonly eventId: string;
  readonly carryId: string;
  readonly eventKind: SalesContinuityEventKind;
  /** The completion detail as recorded (ids/numbers of the leg). */
  readonly detail: Readonly<Record<string, string | number | null>>;
  readonly idempotencyKey: string;
  readonly provenance: SalesContinuityRecordedProvenance;
}

/** Module input for the PLAYBOOK CARRY (the proposal-shaped record anchor). */
export interface SalesContinuityCarryInput {
  /** The proposal-shaped record: an ACCEPTED decision of the owning Client. */
  readonly decisionId: string;
  /**
   * Optional canonical /goals link threaded through to the /playbooks
   * creation command (scope INPUT validated by the playbook authority
   * itself — never an authorization, never proposal content re-entry).
   */
  readonly goalId: string | null;
  /** The §8 logical create key (caller-supplied; DB-fenced per Client). */
  readonly idempotencyKey: string;
}

/** Module input for the DEPLOYMENT CARRY (the carried playbook path). */
export interface SalesContinuityDeploymentCarryInput {
  readonly carryId: string;
  /** The deployment target Workspace (scope INPUT, canonically resolved). */
  readonly workspaceId: string;
  /**
   * The workflow definition references to pin — the caller's delivery
   * work products linked to the carried playbook version (validated by
   * the /deployments authority: ACTIVE + workspace-owned + playbook-linked).
   */
  readonly workflowDefinitionIds: readonly string[];
  /** The §8 logical command key (caller-supplied; DB-fenced per carry). */
  readonly idempotencyKey: string;
}

// ---------------------------------------------------------------------------
// Structural ports (frozen-matrix-compliant /clients + /workspaces
// resolution — the /decisions precedent)
// ---------------------------------------------------------------------------

/**
 * Narrow STRUCTURAL view of the /clients canonical owner context (the
 * public-contract shape /sales-continuity consumes). The real
 * ClientOwnerContext satisfies this structurally — /clients remains the
 * ONLY Client ownership authority.
 */
export interface SalesContinuityClientOwnershipSnapshot {
  readonly scope: {
    readonly kind: 'client';
    readonly agencyId: string;
    readonly clientId: string;
  };
  readonly client: {
    readonly clientId: string;
    readonly agencyId: string;
    readonly status: string;
  };
}

/**
 * The slice of the /clients public contract /sales-continuity depends on:
 * canonical server-side Client ownership resolution from durable state.
 * Satisfied structurally by ClientsModuleApi; wired at the composition root.
 */
export interface SalesContinuityClientOwnershipPort {
  resolveClientOwnership(clientId: string): Promise<SalesContinuityClientOwnershipSnapshot | null>;
}

/**
 * Narrow STRUCTURAL view of the /workspaces canonical ownership resolution
 * (the public-contract shape /sales-continuity consumes). The real
 * WorkspaceOwnerContext satisfies this structurally — /workspaces remains
 * the ONLY Workspace ownership authority.
 */
export interface SalesContinuityWorkspaceOwnershipSnapshot {
  readonly workspace: {
    readonly workspaceId: string;
    readonly clientId: string;
    readonly status: string;
  };
}

/**
 * The slice of the /workspaces public contract /sales-continuity depends
 * on: canonical server-side Workspace ownership resolution (the deployment
 * carry's scope input). Satisfied structurally by WorkspacesModuleApi;
 * wired at the composition root.
 */
export interface SalesContinuityWorkspaceOwnershipPort {
  resolveWorkspaceOwnership(workspaceId: string): Promise<SalesContinuityWorkspaceOwnershipSnapshot | null>;
}

// ---------------------------------------------------------------------------
// Canonical owner context (implementation-contract §2)
// ---------------------------------------------------------------------------

/**
 * The CANONICAL CARRY OWNER CONTEXT: the single server-side resolution of
 * WHICH tenant owns the carry (the Client that owns the source decision,
 * + the Agency through the canonical /clients chain), derived from durable
 * state on every call. Carry-scoped operations authorize against this
 * context — never against caller-supplied tenant or carry identity.
 */
export interface SalesContinuityOwnerContext {
  readonly scope: {
    readonly kind: 'sales-continuity-carry';
    readonly agencyId: string;
    readonly clientId: string;
    readonly carryId: string;
  };
  readonly carry: SalesContinuityCarryRecord;
  /** The /clients canonical ownership snapshot this carry resolves through. */
  readonly clientOwnership: SalesContinuityClientOwnershipSnapshot;
  readonly resolvedAt: string;
}

// ---------------------------------------------------------------------------
// The continuity views (the provenance round-trip composition)
// ---------------------------------------------------------------------------

/**
 * The composed CONTINUITY VIEW — the provenance round-trip in one read:
 * the carry row (source references + carried snapshot + linkage) PLUS the
 * LIVE authoritative records resolved through their public contracts at
 * read time (the decision, the playbook, the playbook version, the
 * deployment when carried). The live records are NEVER copies — the view
 * composes the authorities' own current rows (live-follow), while the
 * carried snapshot preserves exactly what was carried.
 */
export interface SalesContinuityView {
  readonly carry: SalesContinuityCarryRecord;
  /** The source proposal record, live through /decisions (never a copy). */
  readonly source: DecisionRecord | null;
  /** The carried playbook, live through /playbooks (null while 'carrying'). */
  readonly playbook: PlaybookRecord | null;
  /** The carried playbook version, live through /playbooks. */
  readonly playbookVersion: PlaybookVersionRecord | null;
  /** The carried deployment, live through /deployments (null until deployed). */
  readonly deployment: DeploymentRecord | null;
  readonly resolvedAt: string;
}

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

export interface SalesContinuityModuleApi {
  /**
   * THE PLAYBOOK CARRY: derives the structured carry payload from the
   * proposal-shaped record and creates the Client-scoped Playbook + its
   * first Version THROUGH THE EXISTING /playbooks creation commands.
   *
   * Canonical owner resolution runs FIRST through the /decisions public
   * contract (resolveDecisionOwnership): unknown, foreign or orphaned
   * decision identifiers are the uniform 404 (no cross-tenant oracle).
   * The proposal gate: only an ACCEPTED decision is carryable (409
   * otherwise — a rejected/superseded proposal was never approved for
   * delivery, a still-'proposed' one is not commercially decided; the
   * disposition authority stays /decisions — this is a read, never a
   * mutation). A disabled owning Client blocks the carry (409 — new use
   * without rewriting history).
   *
   * §8-style convergence (the disclosed duplicate guard): the SOURCE
   * fence is UNIQUE per proposal version — re-carrying the SAME decision
   * converges to the recorded carry (replayed=true; NO new playbook is
   * created); the logical (client, idempotency_key) fence rejects a key
   * reused for a different logical create (409). A claim left 'carrying'
   * is an UNRESOLVED claim: re-carrying into it is a 409, never a blind
   * replay (the v1.2/v1.3 UNKNOWN posture).
   */
  carryProposalToPlaybook(
    input: SalesContinuityCarryInput,
    provenance: SalesContinuityProvenance,
  ): Promise<SalesContinuityCarryOutcome>;

  /**
   * THE DEPLOYMENT CARRY ("where applicable"): completes the carried
   * playbook's path into a Deployment through the EXISTING commands:
   *   1. the carried version moves draft → review → published THROUGH
   *      setPlaybookVersionStatus (the frozen lifecycle; the activation
   *      policies — ACTIVE agency/client — run inside the playbook
   *      authority, never bypassed). An ALREADY-PUBLISHED version skips
   *      the leg (the operator may publish through the /playbooks routes
   *      directly — the /workflows authority requires a definition's
   *      pinned version published before the definition itself can
   *      activate, so publication precedes this command in the natural
   *      operator flow; walking a draft/review version here makes a
   *      retry after the definitions are activated convergent). A RETIRED
   *      version never enters the deployment path (409);
   *   2. createDeployment configures one deployment (born DRAFT) whose
   *      selection is DERIVED from the published version's own
   *      deployment metadata + the caller's workflow definition
   *      references. The /deployments authority's own validation runs
   *      intact (workspace ownership, published pin, workspace-owned
   *      playbook-linked ACTIVE definitions, immutable-version
   *      compatibility); the MKT-040 validate-before-activate gate is
   *      NEVER invoked here — the deployment is born DRAFT and
   *      activation stays the /deployments authority's own routes.
   *
   * The carry must be 'carried' (the playbook leg completed). A foreign
   * or unknown carry/workspace is the uniform 404; a workspace of a
   * DIFFERENT Client than the carry is the uniform 404 (isolation before
   * traversal); the deployment carry is one-shot per carry (re-request
   * with the SAME logical key converges to the recorded deployment —
   * replayed=true; a different key is a 409 — the disclosed one-shot).
   */
  carryPlaybookToDeployment(
    input: SalesContinuityDeploymentCarryInput,
    provenance: SalesContinuityProvenance,
  ): Promise<SalesContinuityDeploymentCarryOutcome>;

  /** Raw ledger row by id (any state — durable linkage history). */
  getCarry(carryId: string): Promise<SalesContinuityCarryRecord | null>;

  /**
   * Canonical ownership resolution for one carry: the carry row + the
   * owning Client resolved through the /clients structural port, composed
   * into the owner context. Null when the carry does not exist OR its
   * Client is a deleted tombstone — callers surface a uniform 404.
   */
  resolveCarryOwnership(carryId: string): Promise<SalesContinuityOwnerContext | null>;

  /** The Client's carries, newest first (bounded server-chosen limit). */
  listCarriesForClient(clientId: string): Promise<readonly SalesContinuityCarryRecord[]>;

  /** The append-only continuity event tail of one carry, oldest first. */
  listCarryEvents(carryId: string): Promise<readonly SalesContinuityEventRecord[]>;

  /**
   * The continuity view of one carry: the round-trip composition (the
   * carry + the LIVE source decision, playbook, version and deployment
   * through their public contracts). Null when the carry does not exist
   * or its Client is a deleted tombstone (uniform 404 upstream).
   */
  getContinuity(carryId: string): Promise<SalesContinuityView | null>;

  /**
   * The continuity view anchored on the PROPOSAL: proposal → carried
   * records. The decision resolves canonically through /decisions first
   * (null → uniform 404 upstream); a decision never carried resolves to
   * null (the route surfaces the uniform 404 — an uncarried proposal has
   * no continuity to read).
   */
  getContinuityForProposal(decisionId: string): Promise<SalesContinuityView | null>;

  /**
   * The continuity view anchored on the CARRIED PLAYBOOK: delivery side →
   * proposal (the round-trip's other half). The playbook resolves through
   * the /playbooks public contract first (null → uniform 404 upstream); a
   * playbook never carried resolves to null.
   */
  getContinuityForPlaybook(playbookId: string): Promise<SalesContinuityView | null>;
}

/** The playbook-carry outcome: the carry + the created records + the replay flag. */
export interface SalesContinuityCarryOutcome {
  readonly carry: SalesContinuityCarryRecord;
  readonly playbook: PlaybookRecord | null;
  readonly playbookVersion: PlaybookVersionRecord | null;
  /** True when the disclosed duplicate guard converged to the recorded carry. */
  readonly replayed: boolean;
}

/** The deployment-carry outcome: the carry + the configured deployment + the replay flag. */
export interface SalesContinuityDeploymentCarryOutcome {
  readonly carry: SalesContinuityCarryRecord;
  readonly deployment: DeploymentRecord;
  /** True when the one-shot deployment carry converged to the recorded deployment. */
  readonly replayed: boolean;
}

// ---------------------------------------------------------------------------
// The composed public-contract slices (structural ports satisfied by the
// real module instances at the composition root)
// ---------------------------------------------------------------------------

/**
 * The slice of the /decisions public contract /sales-continuity depends on
 * (READ-ONLY): canonical decision ownership resolution + the raw proposal
 * record. Satisfied structurally by DecisionsModuleApi; wired at the
 * composition root.
 */
export interface SalesContinuityDecisionsPort {
  resolveDecisionOwnership(decisionId: string): Promise<{
    readonly scope: {
      readonly kind: 'decision';
      readonly agencyId: string;
      readonly clientId: string;
      readonly workspaceId: string | null;
      readonly decisionId: string;
    };
    readonly decision: DecisionRecord;
    readonly clientOwnership: {
      readonly scope: { readonly kind: 'client'; readonly agencyId: string; readonly clientId: string };
      readonly client: { readonly clientId: string; readonly agencyId: string; readonly status: string };
    };
  } | null>;
  getDecision(decisionId: string): Promise<DecisionRecord | null>;
}

/**
 * The slice of the /playbooks public contract /sales-continuity depends
 * on: the EXISTING creation/status commands (the orchestrated path) plus
 * the explicit-version and playbook reads. Satisfied structurally by
 * PlaybooksModuleApi; wired at the composition root.
 */
export interface SalesContinuityPlaybooksPort {
  createClientPlaybook(input: {
    readonly clientId: string;
    readonly goalId: string | null;
    readonly name: string;
    readonly description: string;
    readonly actorId: string | null;
  }): Promise<PlaybookRecord>;
  createPlaybookVersion(input: {
    readonly playbookId: string;
    readonly strategy: PlaybookStrategy;
    readonly deploymentMetadata: PlaybookDeploymentMetadata;
    readonly actorId: string | null;
  }): Promise<PlaybookVersionRecord>;
  setPlaybookVersionStatus(input: {
    readonly versionId: string;
    readonly status: 'review' | 'published';
    readonly expectedVersion: number;
  }): Promise<PlaybookVersionRecord>;
  getPlaybook(playbookId: string): Promise<PlaybookRecord | null>;
  getPlaybookVersion(versionId: string): Promise<PlaybookVersionRecord | null>;
}

/**
 * The slice of the /deployments public contract /sales-continuity depends
 * on: the EXISTING createDeployment command (the only sanctioned write —
 * the deployment is born DRAFT; validate/activate stay untouched) plus the
 * raw record read. Satisfied structurally by DeploymentsModuleApi; wired
 * at the composition root.
 */
export interface SalesContinuityDeploymentsPort {
  createDeployment(
    input: {
      readonly workspaceId: string;
      readonly selection: {
        readonly playbookVersionId: string;
        readonly workflowDefinitionIds: readonly string[];
        readonly requiredDomainPacks: readonly {
          readonly name: string;
          readonly versionConstraint: string | null;
        }[];
        readonly requiredCapabilities: readonly {
          readonly kind: 'integration' | 'extension';
          readonly name: string;
          readonly versionConstraint: string | null;
        }[];
        readonly runtimeRequirements: { readonly runtimeClass: string | null };
        readonly triggerConfig: readonly {
          readonly kind: 'manual' | 'schedule' | 'event';
          readonly config: Readonly<Record<string, string>> | null;
        }[];
      };
    },
    provenance: {
      readonly actor: string;
      readonly recordedVia: string;
      readonly correlationId: string;
      readonly causationId: string | null;
    },
  ): Promise<DeploymentRecord>;
  getDeployment(deploymentId: string): Promise<DeploymentRecord | null>;
}

export interface SalesContinuityModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * The frozen matrix line added for MKT-046:
   * /sales-continuity ──→ /decisions, /playbooks, /deployments, /clients,
   * /workspaces. /decisions is consumed READ-ONLY (the proposal record +
   * canonical ownership); /playbooks and /deployments are consumed through
   * their EXISTING public creation/status commands (the only sanctioned
   * writes); /clients and /workspaces arrive as the STRUCTURAL PORTS
   * above (the /decisions precedent).
   */
  readonly decisions: SalesContinuityDecisionsPort;
  readonly playbooks: SalesContinuityPlaybooksPort;
  readonly deployments: SalesContinuityDeploymentsPort;
  readonly clients: SalesContinuityClientOwnershipPort;
  readonly workspaces: SalesContinuityWorkspaceOwnershipPort;
}

export { createSalesContinuityModule } from './internal/sales-continuity-module.ts';
/**
 * The pure derivation + guard functions — the carry payload derivation
 * (scope/goals/outcomes/assumptions/economics), the playbook-input
 * derivation, the §8 carry fingerprint, the provenance/input guards and
 * the DB-conflict classification — exported for unit tests and future
 * server-side emitters so the carry semantics are part of the module
 * contract. Pure functions.
 */
export {
  deriveCarriedProposalStructure,
  derivePlaybookInputs,
  fingerprintSalesContinuityCreate,
  assertValidSalesContinuityProvenance,
  assertValidSalesContinuityCarryInput,
  assertValidSalesContinuityDeploymentCarryInput,
  classifySalesContinuityWriteConflict,
} from './internal/continuity-derivation.ts';
