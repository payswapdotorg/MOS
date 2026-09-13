/**
 * MarketingOS module: /operating-graph (MKT-041 — Agency Operating Graph).
 *
 * Authority: the DERIVED COORDINATION MODEL over the canonical authorities
 * (spec/operating-graph-v1.5.md; spec/architecture-v1.5.md §3; architecture-
 * lock-v1.5 #4). The Operating Graph connects canonical IDs across commercial
 * intent, delivery, execution, evidence and the knowledge side — the v1.5
 * chain Prospect → Client → Goal → Strategy/Hypothesis → Playbook Version →
 * Deployment → Workflow → Task → Human/AI/App/Extension → Execution →
 * Evidence → Outcome → Revenue/Cost/Margin → Decision → Learning, projected
 * onto the authorities that exist today (Prospect/Outcome/economics/decision
 * authorities arrive with later v1.5 Work Items and extend the kind list).
 *
 * THE FROZEN BOUNDARY (never a second authority — architecture-lock-v1.5 #4):
 *
 *   - SOURCE REFERENCES ONLY: nodes are registry rows (canonical id + kind +
 *     scope chain) and edges are relation rows (canonical ids + relation +
 *     epistemic state + version). NO authoritative shape is copied — the
 *     migration's exact reference-only column inventory is asserted by
 *     tests/architecture/operating-graph-boundary.test.ts;
 *   - DERIVED EDGES MAY BE REBUILT: `rebuildClientOperatingGraph` re-derives
 *     the Client's relation set from the composed authorities' PUBLIC
 *     CONTRACTS (read-only) and converges the ledger — a second rebuild with
 *     unchanged authorities appends NOTHING (the convergence proof);
 *   - APPEND-ORIENTED VERSIONS: corrections are NEW edge rows; the prior row
 *     stays addressable forever (the supersession transition is the single
 *     sanctioned UPDATE; DELETE is rejected at the storage layer);
 *   - HISTORICAL VERSIONS REMAIN ADDRESSABLE: edges reference EXACT immutable
 *     versions (a Deployment pins a specific playbook_version id; an instance
 *     pins a specific workflow_definition id) — never a floating "latest";
 *   - THE FROZEN EPISTEMIC VOCABULARY: unknown / observed / predicted /
 *     attributed / causal stay distinct (a CHECK-fenced column; MKT-041's
 *     rebuild-derived relations are 'observed' — read from authoritative
 *     state — and the other four values are reserved for the v1.5 writers
 *     that earn them);
 *   - ISOLATION BEFORE TRAVERSAL: every scope resolves through canonical
 *     ownership (/clients, /workspaces publics) before any dependent read or
 *     write; edge endpoints are cross-tenant-fenced at the storage layer;
 *   - ZERO MUTATION METHODS AGAINST OTHER AUTHORITIES: the module composes
 *     the authorities read-only (the matrix line added for MKT-041) and
 *     writes ONLY its own two derived structures;
 *   - THE HTTP SURFACE IS READ-ONLY (the routes file): agency-scoped GETs
 *     only — the rebuild is a module-level operation for background workers
 *     and later v1.5 Work Items, never a route.
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import type { ClientsModuleApi } from '../clients/public.ts';
import type { WorkspacesModuleApi } from '../workspaces/public.ts';
import type { GoalsModuleApi } from '../goals/public.ts';
import type { PlaybooksModuleApi } from '../playbooks/public.ts';
import type { WorkflowsModuleApi } from '../workflows/public.ts';
import type { ExecutionsModuleApi } from '../executions/public.ts';
import type { DeploymentsModuleApi } from '../deployments/public.ts';
import type { EvidenceModuleApi } from '../evidence/public.ts';
import type { ExperimentsModuleApi } from '../experiments/public.ts';
import type { LearningsModuleApi } from '../learnings/public.ts';

// ---------------------------------------------------------------------------
// The frozen vocabularies (CHECK-fenced in migration 035)
// ---------------------------------------------------------------------------

/**
 * The closed node-kind vocabulary — the canonical authorities the v1.5 chain
 * covers TODAY. Prospect/Outcome/economics/decision authorities do not exist
 * yet; later v1.5 Work Items extend this list (and the migration CHECK)
 * additively. Strategy/Hypothesis live in the immutable playbook version
 * (the version node IS the strategy artifact); Task is the execution's
 * workflow-node linkage (the executes_step relation).
 */
export const OPERATING_GRAPH_NODE_KINDS = [
  'client',
  'goal',
  'playbook',
  'playbook_version',
  'deployment',
  'workflow',
  'workflow_definition',
  'workflow_instance',
  'execution',
  'evidence',
  'experiment',
  'learning',
] as const;

export type OperatingGraphNodeKind = (typeof OPERATING_GRAPH_NODE_KINDS)[number];

/**
 * The frozen five-value epistemic vocabulary (spec/operating-graph-v1.5.md:
 * "unknown, observed, predicted, attributed and causal states stay
 * distinct"). MKT-041's rebuild-derived relations are 'observed' — read
 * directly from authoritative state; the other values are reserved for the
 * v1.5 writers that earn them (Decision Ledger attributions, Profit
 * Intelligence predictions, causal-experiment claims).
 */
export const OPERATING_GRAPH_EDGE_STATES = [
  'unknown',
  'observed',
  'predicted',
  'attributed',
  'causal',
] as const;

export type OperatingGraphEdgeState = (typeof OPERATING_GRAPH_EDGE_STATES)[number];

/**
 * The closed relation vocabulary — the chain links derivable from the
 * existing authorities' own columns. Every relation is derived READ-ONLY
 * from an authoritative reference (never inferred, never caller-supplied).
 */
export const OPERATING_GRAPH_EDGE_RELATIONS = [
  'has_goal',
  'pursued_by_playbook',
  'has_version',
  'pins_playbook_version',
  'deploys_definition',
  'has_definition',
  'pins_definition',
  'executes_step',
  'runs_execution',
  'has_evidence',
  'supersedes',
  'runs_experiment',
  'records_learning',
  'supported_by',
  'derived_from',
] as const;

export type OperatingGraphEdgeRelation = (typeof OPERATING_GRAPH_EDGE_RELATIONS)[number];

// ---------------------------------------------------------------------------
// Views (the read model)
// ---------------------------------------------------------------------------

/** One registry row as presented by the read model. */
export interface OperatingGraphNodeRecap {
  readonly kind: OperatingGraphNodeKind;
  readonly id: string;
  readonly agencyId: string;
  readonly clientId: string | null;
  readonly workspaceId: string | null;
  readonly firstSeenAt: string;
  readonly lastRefreshedAt: string;
}

/** One edge VERSION row (any version — historical ones stay addressable). */
export interface OperatingGraphEdgeVersionRecap {
  readonly edgeId: string;
  readonly edgeVersion: number;
  readonly edgeState: OperatingGraphEdgeState;
  readonly recordedAt: string;
  readonly recordedBy: string;
  readonly supersededAt: string | null;
}

/** One relation: its current version + the full version history. */
export interface OperatingGraphEdgeRecap {
  readonly fromKind: OperatingGraphNodeKind;
  readonly fromId: string;
  readonly toKind: OperatingGraphNodeKind;
  readonly toId: string;
  readonly relation: OperatingGraphEdgeRelation;
  readonly workspaceId: string | null;
  readonly current: OperatingGraphEdgeVersionRecap;
  readonly history: readonly OperatingGraphEdgeVersionRecap[];
}

/** A relation whose derivation no longer holds — kept addressable as history. */
export interface SupersededOperatingGraphEdgeRecap {
  readonly fromKind: OperatingGraphNodeKind;
  readonly fromId: string;
  readonly toKind: OperatingGraphNodeKind;
  readonly toId: string;
  readonly relation: OperatingGraphEdgeRelation;
  readonly lastVersion: OperatingGraphEdgeVersionRecap;
}

/** The honest derivation disclosure (no unbounded-ledger claims). */
export interface OperatingGraphDerivationNotes {
  readonly basis: 'canonical-authority-records';
  readonly evidenceWindow: 'evidence-authority-bounded-newest-first-listing';
  readonly edgeStates: readonly OperatingGraphEdgeState[];
}

/** The Client's operating graph — the full derived relation set + history. */
export interface ClientOperatingGraphView {
  readonly scope: {
    readonly kind: 'client-operating-graph';
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceCount: number;
  };
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly nodes: readonly OperatingGraphNodeRecap[];
  readonly edges: readonly OperatingGraphEdgeRecap[];
  readonly supersededEdges: readonly SupersededOperatingGraphEdgeRecap[];
  readonly derivation: OperatingGraphDerivationNotes;
  readonly generatedAt: string;
}

/** One Client's tally inside the Agency view. */
export interface AgencyClientGraphTally {
  readonly clientId: string;
  readonly workspaceCount: number;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly relationCounts: Readonly<Record<OperatingGraphEdgeRelation, number>>;
}

/** The Agency's operating graph — the portfolio rollup over the Client graphs. */
export interface AgencyOperatingGraphView {
  readonly scope: {
    readonly kind: 'agency-operating-graph';
    readonly agencyId: string;
    readonly clientCount: number;
  };
  readonly totals: {
    readonly nodeCount: number;
    readonly edgeCount: number;
  };
  readonly perClient: readonly AgencyClientGraphTally[];
  readonly derivation: OperatingGraphDerivationNotes;
  readonly generatedAt: string;
}

// ---------------------------------------------------------------------------
// The rebuild report
// ---------------------------------------------------------------------------

/** What one rebuild derived, converged and appended (the audit-shaped proof). */
export interface OperatingGraphRebuildReport {
  readonly scope: {
    readonly kind: 'client-operating-graph-rebuild';
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceCount: number;
  };
  /** Authority records enumerated by the derivation. */
  readonly nodesSeen: number;
  /** Registry rows upserted (new or refreshed). */
  readonly nodesUpserted: number;
  /** Distinct relations in the derived set. */
  readonly edgesDerived: number;
  /** NEW edge rows appended by this rebuild (version 1 or a later version). */
  readonly edgesAppended: number;
  /** Current rows superseded by this rebuild (retractions + version bumps). */
  readonly edgesSuperseded: number;
  /** Derived relations already current and unchanged (converged). */
  readonly edgesConverged: number;
  /** True when this rebuild appended NOTHING — the second-run proof. */
  readonly converged: boolean;
  readonly rebuiltAt: string;
  readonly recordedBy: string;
}

// ---------------------------------------------------------------------------
// Module contract
// ---------------------------------------------------------------------------

export interface OperatingGraphModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * The frozen matrix line added for MKT-041 (read-only composition):
   * /operating-graph ──→ /clients, /workspaces, /goals, /playbooks,
   * /workflows, /executions, /deployments, /evidence, /experiments,
   * /learnings.
   */
  readonly clients: ClientsModuleApi;
  readonly workspaces: WorkspacesModuleApi;
  readonly goals: GoalsModuleApi;
  readonly playbooks: PlaybooksModuleApi;
  readonly workflows: WorkflowsModuleApi;
  readonly executions: ExecutionsModuleApi;
  readonly deployments: DeploymentsModuleApi;
  readonly evidence: EvidenceModuleApi;
  readonly experiments: ExperimentsModuleApi;
  readonly learnings: LearningsModuleApi;
}

export interface OperatingGraphModuleApi {
  /**
   * Re-derives one Client's relation set from the composed authorities'
   * public contracts (READ-ONLY) and converges the derived ledger:
   * new relations append; changed relations append the next version and
   * supersede the prior; relations no longer derivable are superseded
   * (never deleted — history stays addressable). Idempotent: a rebuild
   * against unchanged authorities appends NOTHING (converged=true).
   *
   * NOT an HTTP surface — the routes are read-only by construction; the
   * rebuild is the module-level operation for background workers and the
   * later v1.5 Work Items (the composition root wires it once).
   */
  rebuildClientOperatingGraph(input: {
    readonly clientId: string;
  }): Promise<OperatingGraphRebuildReport>;

  /**
   * The Client's operating graph — every CURRENT relation with its full
   * version history, plus the superseded relations kept addressable. The
   * Client resolves through canonical ownership first (tombstoned or
   * unknown → the uniform 404 upstream; a foreign Client identifier is not
   * a traversal oracle).
   */
  getClientOperatingGraph(input: { readonly clientId: string }): Promise<ClientOperatingGraphView>;

  /**
   * The Agency's operating graph — the portfolio rollup over the agency's
   * Client graphs. The aggregation scope arrives as SERVER-DERIVED data
   * (the route resolves the agency's live Clients + Workspace counts from
   * durable state — the command-center scope-as-data posture; the module
   * never imports /agencies).
   */
  getAgencyOperatingGraph(input: {
    readonly agencyId: string;
    readonly clients: ReadonlyArray<{ readonly clientId: string; readonly workspaceCount: number }>;
  }): Promise<AgencyOperatingGraphView>;
}

export { createOperatingGraphModule } from './internal/operating-graph-module.ts';

// The pure derivation/view-composition types + functions (unit-tested;
// re-exported so tests and future read-side emitters compose the exact
// module semantics). See internal/graph-projection.ts.
export type {
  AgencyClientTallyInput,
  ClientGraphAuthoritySnapshot,
  ClientGraphProjection,
  DerivedEdgeRef,
  DerivedNodeRef,
  GraphEdgeRowInput,
  GraphNodeRowInput,
  ResolvedPlaybookVersion,
  ResolvedWorkflowDefinition,
} from './internal/graph-projection.ts';
export {
  composeAgencyOperatingGraphView,
  composeClientOperatingGraphView,
  deriveClientGraphProjection,
} from './internal/graph-projection.ts';
