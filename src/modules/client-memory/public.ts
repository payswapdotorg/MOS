/**
 * MarketingOS module: /client-memory (MKT-044 — Client Operating Memory).
 *
 * Authority: DERIVED GOVERNED PROJECTION over the canonical authorities
 * (spec/architecture-v1.5.md §6: "Client memory is a governed projection
 * over canonical client, goal, playbook, deployment, evidence,
 * experiment, outcome, decision and learning records. Retrieval/index
 * technology is non-authoritative."; spec/operating-graph-v1.5.md
 * "Client Operating Memory"; the v1.5 lock posture: no second
 * tenant/data authority — PostgreSQL remains authoritative).
 *
 * The module projects ONE CLIENT'S operating memory — the governed
 * context surface for employees, the AI Operator and the Client Decision
 * Room — by composing the canonical records READ-ONLY through their
 * PUBLIC CONTRACTS. It owns NO durable state (NO client_memory_* tables,
 * NO snapshot store, NO retrieval index, NO recompute operation — the
 * /reporting live-aggregation precedent of MKT-029/030, the exact
 * /profit-intelligence house posture of MKT-043): every view is
 * COMPOSED at read time, so authority changes are visible on the very
 * next read (live-follow — no staleness window at all) and the
 * expected-migration list stays UNCHANGED.
 *
 * THE FROZEN BOUNDARY (never a second tenant/data authority):
 *
 *   - GOVERNED MEANS POLICY-VISIBLE COMPOSITION: what enters the memory
 *     surface is itself governed. The module exposes its composition
 *     rules as a FROZEN, VERSIONED VOCABULARY (the cm-proj-v1 pattern —
 *     the same discipline as pi-calc-v1): the closed record-kind set
 *     that contributes, the per-kind selection rules, the ordering, the
 *     summary bound and the freshness policy all ship VERBATIM in every
 *     response (`projection` disclosure). Changing ANY rule is a NEW
 *     projection version string — never a silent restatement;
 *   - CANONICAL CITATIONS ONLY (never shadowed authoritative shape):
 *     every memory item cites the canonical record id of the authority
 *     row it was derived from (`kind` + `id` + cross-record `links`),
 *     surfaces the authority's own lifecycle status and scope verbatim,
 *     and carries a BOUNDED presentation excerpt under the frozen
 *     summary bound — the /operating-graph source-reference posture;
 *   - RETRIEVAL/INDEX TECHNOLOGY IS NON-AUTHORITATIVE (§6): this
 *     delivery adds NO index and NO cache at all (the disclosed
 *     choice). Had one been added it would be a rebuildable derived
 *     artifact with a disclosed recompute path — the NO-MIGRATION live
 *     derivation makes the question moot: nothing is stored, so nothing
 *     can drift and nothing can become a second query authority;
 *   - ZERO MUTATION METHODS (AC-5): the module API is three READ
 *     methods; every composed dependency is consumed READ-ONLY; the
 *     HTTP surface is GET-only (routes file) with no body and no DTO;
 *   - ISOLATION BEFORE TRAVERSAL (§14): every scope resolves through
 *     canonical ownership (/clients, /workspaces publics) before any
 *     dependent read; memory items never cross the resolved tenant
 *     scope; foreign ≡ unknown ≡ malformed identifiers are the uniform
 *     404 upstream (a foreign identifier is not a traversal oracle);
 *   - OUTCOME RECORDS — DISCLOSED COMPOSITION: there is no separate
 *     outcome authority today; the canonical v1.5 outcome surface is
 *     the Decision Ledger's observed outcome (recorded exactly once on
 *     an ACCEPTED decision with its execution/deployment/learning
 *     references — MKT-042). The memory projection composes outcome
 *     items from those canonical observed outcomes, citing the decision
 *     id. References to authorities OUTSIDE the frozen composition
 *     vocabulary (/executions, /workflows) are not cited as links —
 *     those records are not part of the client-memory composition
 *     (§6 lists no execution/workflow records for client memory).
 *
 * Dependency posture (the frozen matrix line added for MKT-044):
 * /client-memory ──→ /clients, /workspaces, /goals, /playbooks,
 * /deployments, /evidence, /experiments, /decisions, /learnings — every
 * direction consumed READ-ONLY through the public contracts (the
 * /operating-graph / /profit-intelligence composition posture).
 * Cross-module access may only target this public entry (public.ts);
 * internal/ is unimportable from other modules (enforced by
 * tools/arch-check and tests/architecture/client-memory-boundary.test.ts).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { ClientsModuleApi } from '../clients/public.ts';
import type { WorkspacesModuleApi } from '../workspaces/public.ts';
import type { GoalsModuleApi } from '../goals/public.ts';
import type { PlaybooksModuleApi } from '../playbooks/public.ts';
import type { DeploymentsModuleApi } from '../deployments/public.ts';
import type { EvidenceModuleApi } from '../evidence/public.ts';
import type { ExperimentsModuleApi } from '../experiments/public.ts';
import type { DecisionsModuleApi } from '../decisions/public.ts';
import type { LearningsModuleApi } from '../learnings/public.ts';

// ---------------------------------------------------------------------------
// The frozen projection vocabulary (cm-proj-v1 — AC-3: policy-visible
// composition; extension is a code change + version bump, never a caller
// freedom)
// ---------------------------------------------------------------------------

/**
 * The PROJECTION VERSION of every memory view this module derives. Same
 * authority inputs + this version ⇒ byte-identical memory views (the
 * pinning proof). A change to ANY composition rule — a record kind
 * entering or leaving the surface, ANY selection rule, the ordering, the
 * summary bound, the freshness policy — is a NEW version string: views
 * are versioned, never silently re-stated (the cm-proj-v1 pattern, the
 * same discipline as the pi-calc-v1 calculation version).
 */
export const CLIENT_MEMORY_PROJECTION_VERSION = 'cm-proj-v1' as const;

/**
 * The closed record-kind vocabulary — the canonical record kinds that
 * contribute to the memory surface, in the frozen presentation order.
 * Each kind names its canonical authority (see
 * CLIENT_MEMORY_SOURCE_AUTHORITIES): the memory surface is a projection
 * over THESE records and no others (spec/architecture-v1.5.md §6).
 */
export const CLIENT_MEMORY_RECORD_KINDS = [
  'client',
  'goal',
  'playbook',
  'playbook-version',
  'deployment',
  'evidence',
  'experiment',
  'outcome',
  'decision',
  'learning',
] as const;

export type ClientMemoryRecordKind = (typeof CLIENT_MEMORY_RECORD_KINDS)[number];

/**
 * The authority map — which canonical authority feeds each record kind.
 * Policy-visible composition: the projection's data lineage is part of
 * the frozen vocabulary, not an implementation detail.
 */
export const CLIENT_MEMORY_SOURCE_AUTHORITIES: Readonly<
  Record<ClientMemoryRecordKind, string>
> = {
  client: '/clients',
  goal: '/goals',
  playbook: '/playbooks',
  'playbook-version': '/playbooks',
  deployment: '/deployments',
  evidence: '/evidence',
  experiment: '/experiments',
  outcome: '/decisions (observed outcomes on ACCEPTED decisions)',
  decision: '/decisions',
  learning: '/learnings',
};

/**
 * The frozen selection rules (AC-3: which records enter the memory
 * surface, under which freshness/selection rules). Every entry is
 * exported, documented and surfaced VERBATIM in every response (the
 * `projection.selectionRules` disclosure); changing ANY value is a
 * projection-version bump — never a silent restatement.
 */
export interface ClientMemorySelectionRules {
  /** The client profile enters through canonical ownership resolution; tombstoned clients resolve to nothing (uniform 404 upstream). */
  readonly clientProfile: 'live-canonical-ownership-resolution-tombstones-never-resolve';
  /** Goals: every record of the client in every lifecycle state — memory includes history. */
  readonly goals: 'all-lifecycle-states-retained';
  /**
   * Playbooks: the client's OWN (client-scoped) playbooks only —
   * agency-scoped reusable operational IP is out of this client's
   * memory surface (disclosed exclusion, never silently dropped).
   */
  readonly playbooks: 'client-scoped-own-playbooks-only-agency-reusable-ip-excluded';
  /** Playbook versions: every immutable version of the client's own playbooks (any version status). */
  readonly playbookVersions: 'every-immutable-version-of-the-own-playbooks';
  /** Deployments: every deployment across the client's LIVE workspaces, any lifecycle status. */
  readonly deployments: 'every-deployment-across-live-workspaces-all-states';
  /**
   * Evidence: CURRENT rows only (supersededBy IS NULL) — supersession
   * chains keep their freshest row; superseded predecessors are counted
   * (`supersededEvidenceCount`) and never presented (the metrics
   * latest-wins discipline applied to the evidence ledger).
   */
  readonly evidence: 'current-rows-only-superseded-predecessors-counted-never-presented';
  /** Experiments: every record, any lifecycle or result state. */
  readonly experiments: 'all-records-any-lifecycle-or-result-state';
  /**
   * Outcomes: the observed outcomes recorded exactly once on ACCEPTED
   * decisions (the canonical v1.5 outcome surface; there is no separate
   * outcome authority today — disclosed composition).
   */
  readonly outcomes: 'observed-outcomes-on-accepted-decisions-recorded-exactly-once';
  /** Decisions: every record, any disposition — corrections are NEW records (append-oriented ledger). */
  readonly decisions: 'all-records-any-disposition-corrections-are-new-records';
  /** Learnings: every record with its DERIVED state (active/superseded/retired) — history retained. */
  readonly learnings: 'all-records-derived-states-history-retained';
  /** Deterministic item ordering: kind vocabulary order, then recordedAt DESC, then id ASC (the pinning-stable order). */
  readonly ordering: 'kind-vocabulary-order-then-recordedAt-desc-then-id-asc';
  /** The bounded presentation excerpt bound (characters) — never the full authoritative payload. */
  readonly summaryBound: number;
  /** Freshness: nothing is stored; authority changes appear on the very next read. */
  readonly freshness: 'live-derivation-next-read';
  /**
   * The workspace slice covering rule: a workspace memory view carries
   * the client-wide items (workspace scope null) plus the workspace's
   * OWN items — the /profit-intelligence covering precedent.
   */
  readonly workspaceSliceCovering: 'client-wide-plus-own-workspace';
  /**
   * Cross-record citations are emitted only for target kinds inside the
   * frozen composition vocabulary — references to records of other
   * authorities (/executions, /workflows) are not cited because those
   * records are not part of the client-memory composition (§6).
   */
  readonly linkCitations: 'composed-kinds-only';
}

export const CLIENT_MEMORY_SELECTION_RULES: ClientMemorySelectionRules = {
  clientProfile: 'live-canonical-ownership-resolution-tombstones-never-resolve',
  goals: 'all-lifecycle-states-retained',
  playbooks: 'client-scoped-own-playbooks-only-agency-reusable-ip-excluded',
  playbookVersions: 'every-immutable-version-of-the-own-playbooks',
  deployments: 'every-deployment-across-live-workspaces-all-states',
  evidence: 'current-rows-only-superseded-predecessors-counted-never-presented',
  experiments: 'all-records-any-lifecycle-or-result-state',
  outcomes: 'observed-outcomes-on-accepted-decisions-recorded-exactly-once',
  decisions: 'all-records-any-disposition-corrections-are-new-records',
  learnings: 'all-records-derived-states-history-retained',
  ordering: 'kind-vocabulary-order-then-recordedAt-desc-then-id-asc',
  summaryBound: 280,
  freshness: 'live-derivation-next-read',
  workspaceSliceCovering: 'client-wide-plus-own-workspace',
  linkCitations: 'composed-kinds-only',
};

// ---------------------------------------------------------------------------
// Memory citations (canonical ids only — never shadowed authoritative
// shape)
// ---------------------------------------------------------------------------

/** One canonical record a memory item was derived from / links to. */
export interface MemorySourceRef {
  readonly kind: ClientMemoryRecordKind;
  readonly id: string;
}

// ---------------------------------------------------------------------------
// The memory item — the unit of the projected surface
// ---------------------------------------------------------------------------

/**
 * ONE MEMORY ITEM (AC-2): a governed projection of one canonical record
 * onto the memory surface. `summary` is the BOUNDED presentation excerpt
 * (the frozen summary bound; the authoritative payload stays on the
 * authority); `status` is the authority's own lifecycle state surfaced
 * VERBATIM (null when the kind carries none); `recordedAt` is the
 * authority's own recording timestamp (never invented); `links` cite
 * canonical records of the composed kinds the authority's own reference
 * columns name.
 */
export interface ClientMemoryItem {
  readonly kind: ClientMemoryRecordKind;
  /** The canonical record id (the citation — never a memory-owned identity). */
  readonly id: string;
  readonly summary: string;
  readonly status: string | null;
  /** The item's Workspace scope INSIDE the owning Client (null = client-wide / client-level). */
  readonly workspaceId: string | null;
  readonly recordedAt: string;
  readonly links: readonly MemorySourceRef[];
}

/** The client profile recap — the client record itself, cited. */
export interface ClientProfileRecap {
  readonly sourceRef: MemorySourceRef;
  readonly name: string;
  readonly slug: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One workspace recap inside the client's memory — scope CONTEXT, not a cited memory record (§6 lists no workspace records in the memory composition). */
export interface WorkspaceRecap {
  readonly workspaceId: string;
  readonly name: string;
  readonly status: string;
}

/** The governance disclosure carried by EVERY view (AC-3/AC-6). */
export interface ProjectionDisclosure {
  readonly projectionVersion: string;
  readonly recordKinds: readonly ClientMemoryRecordKind[];
  readonly selectionRules: ClientMemorySelectionRules;
  readonly basis: 'live-derivation-over-canonical-authorities';
  readonly persistence: 'none-derived-read-model';
  /**
   * §6's "Retrieval/index technology is non-authoritative" — the
   * disclosed delivery choice: NO retrieval index and NO cache exist at
   * all; every view is composed live from the authorities' own rows.
   */
  readonly retrievalTechnology: 'none-live-composition-only';
}

// ---------------------------------------------------------------------------
// The derived surfaces (AC-4: the client memory view + the workspace
// slice + the kind-filtered retrieval over the projected records)
// ---------------------------------------------------------------------------

/** The per-kind item counts (every vocabulary kind present, zeros included). */
export type ClientMemoryKindCounts = Readonly<Record<ClientMemoryRecordKind, number>>;

/** The CLIENT's operating memory — the full governed projection. */
export interface ClientMemoryView {
  readonly scope: {
    readonly kind: 'client-memory';
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceCount: number;
  };
  readonly profile: ClientProfileRecap;
  readonly workspaces: readonly WorkspaceRecap[];
  readonly items: readonly ClientMemoryItem[];
  readonly perKind: ClientMemoryKindCounts;
  /** Superseded evidence predecessors excluded by the selection rule (counted, never presented). */
  readonly supersededEvidenceCount: number;
  readonly projection: ProjectionDisclosure;
  readonly generatedAt: string;
}

/** The WORKSPACE's memory slice — the covering-rule projection. */
export interface WorkspaceMemoryView {
  readonly scope: {
    readonly kind: 'workspace-memory';
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceId: string;
  };
  readonly profile: ClientProfileRecap;
  readonly workspace: WorkspaceRecap;
  readonly items: readonly ClientMemoryItem[];
  readonly perKind: ClientMemoryKindCounts;
  readonly supersededEvidenceCount: number;
  readonly projection: ProjectionDisclosure;
  readonly generatedAt: string;
}

/**
 * The kind-filtered retrieval over the PROJECTED records — a filter over
 * the DERIVED memory items (search over derived data, never a second
 * query authority): the full memory composes first, then the items of
 * ONE frozen vocabulary kind are presented.
 */
export interface ClientMemoryKindSlice {
  readonly scope: {
    readonly kind: 'client-memory-kind-slice';
    readonly agencyId: string;
    readonly clientId: string;
    readonly recordKind: ClientMemoryRecordKind;
  };
  readonly items: readonly ClientMemoryItem[];
  /** The kind's count within the FULL client memory (the unfiltered denominator). */
  readonly perKindTotal: number;
  readonly projection: ProjectionDisclosure;
  readonly generatedAt: string;
}

// ---------------------------------------------------------------------------
// Module contract
// ---------------------------------------------------------------------------

export interface ClientMemoryModuleDeps {
  readonly clock: Clock;
  /**
   * The frozen matrix line added for MKT-044 (read-only composition):
   * /client-memory ──→ /clients, /workspaces, /goals, /playbooks,
   * /deployments, /evidence, /experiments, /decisions, /learnings.
   */
  readonly clients: ClientsModuleApi;
  readonly workspaces: WorkspacesModuleApi;
  readonly goals: GoalsModuleApi;
  readonly playbooks: PlaybooksModuleApi;
  readonly deployments: DeploymentsModuleApi;
  readonly evidence: EvidenceModuleApi;
  readonly experiments: ExperimentsModuleApi;
  readonly decisions: DecisionsModuleApi;
  readonly learnings: LearningsModuleApi;
}

export interface ClientMemoryModuleApi {
  /**
   * The CLIENT's operating memory — the full governed projection over
   * the client profile, goals, own playbooks + versions, deployments,
   * current evidence, experiments, observed outcomes, decisions and
   * learnings. Canonical Client ownership resolves FIRST (/clients
   * public contract — isolation before traversal): unknown or
   * tombstoned Client → the uniform 404 upstream.
   */
  getClientMemory(input: {
    readonly clientId: string;
  }): Promise<ClientMemoryView>;

  /**
   * The WORKSPACE's memory slice — the covering-rule projection
   * (client-wide items + the workspace's own items). Canonical
   * Workspace ownership resolves FIRST (/workspaces public contract):
   * unknown, tombstoned or foreign Workspace → the uniform 404 upstream.
   */
  getWorkspaceMemory(input: {
    readonly workspaceId: string;
  }): Promise<WorkspaceMemoryView>;

  /**
   * The kind-filtered retrieval over the projected records: the full
   * client memory composes first (the same live derivation), then the
   * items of ONE frozen vocabulary kind are presented — a filter over
   * DERIVED data, never a second query authority. Canonical Client
   * ownership resolves FIRST: unknown or tombstoned Client → the
   * uniform 404 upstream.
   */
  getClientMemoryByKind(input: {
    readonly clientId: string;
    readonly kind: ClientMemoryRecordKind;
  }): Promise<ClientMemoryKindSlice>;
}

export { createClientMemoryModule } from './internal/client-memory-module.ts';

// The pure projection functions + the snapshot type (unit-tested;
// re-exported so tests and future read-side emitters compose the exact
// module semantics). See internal/memory-projection.ts.
export type { ClientMemoryAuthoritySnapshot } from './internal/memory-projection.ts';
export {
  clientMemoryKindIndexOf,
  clientMemorySummaryOf,
  composeClientMemoryView,
  composeKindMemorySlice,
  composeProjectionDisclosure,
  composeWorkspaceMemoryView,
  coversWorkspace,
  deploymentMemoryItem,
  decisionMemoryItem,
  deriveClientMemoryItems,
  evidenceMemoryItem,
  experimentMemoryItem,
  goalMemoryItem,
  learningMemoryItem,
  orderMemoryItems,
  outcomeMemoryItem,
  playbookMemoryItem,
  playbookVersionMemoryItem,
} from './internal/memory-projection.ts';
