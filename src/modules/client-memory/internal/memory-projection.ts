/**
 * The PURE /client-memory projections (MKT-044 — Client Operating
 * Memory).
 *
 * Everything in this file is a PURE FUNCTION over plain record snapshots:
 * the module implementation does all I/O (the composed authorities'
 * public contracts) and hands the snapshots here; the same inputs + the
 * same projection version always derive the same memory items (the
 * pinning proof — no hidden state, no clock reads, no randomness, no
 * I/O).
 *
 * Governance rules baked into every item:
 *   - an item CITES the canonical record id (kind + id) and never
 *     shadows the authoritative payload: the `summary` is a bounded
 *     excerpt under the frozen summary bound, `status` is the
 *     authority's own lifecycle state surfaced verbatim, `recordedAt`
 *     is the authority's own timestamp and `workspaceId` is the
 *     authority's own scope column;
 *   - cross-record citations (`links`) name canonical ids of the
 *     composed kinds ONLY — references to records of other authorities
 *     (/executions, /workflows) are not cited (the frozen
 *     linkCitations rule);
 *   - the selection rules are the frozen vocabulary
 *     (CLIENT_MEMORY_SELECTION_RULES): superseded evidence predecessors
 *     are counted and never presented; agency-scoped reusable playbooks
 *     are out of this client's memory surface (disclosed exclusion);
 *   - item ordering is deterministic: kind vocabulary order, then
 *     recordedAt DESC, then id ASC — the pinning-stable order.
 */

import type { ClientRecord } from '../../clients/public.ts';
import type { WorkspaceRecord } from '../../workspaces/public.ts';
import type { GoalRecord } from '../../goals/public.ts';
import type { PlaybookRecord, PlaybookVersionRecord } from '../../playbooks/public.ts';
import type { DeploymentRecord } from '../../deployments/public.ts';
import type { EvidenceRecord } from '../../evidence/public.ts';
import type { ExperimentRecord } from '../../experiments/public.ts';
import type { DecisionRecord } from '../../decisions/public.ts';
import type { LearningRecord } from '../../learnings/public.ts';
import type {
  ClientMemoryItem,
  ClientMemoryKindCounts,
  ClientMemoryKindSlice,
  ClientMemoryRecordKind,
  ClientMemoryView,
  ClientProfileRecap,
  MemorySourceRef,
  ProjectionDisclosure,
  WorkspaceMemoryView,
  WorkspaceRecap,
} from '../public.ts';
import {
  CLIENT_MEMORY_PROJECTION_VERSION,
  CLIENT_MEMORY_RECORD_KINDS,
  CLIENT_MEMORY_SELECTION_RULES,
} from '../public.ts';

// ---------------------------------------------------------------------------
// The derivation input snapshot (re-exported through the public entry)
// ---------------------------------------------------------------------------

/**
 * The pure projection input: plain record snapshots gathered through the
 * composed authorities' PUBLIC CONTRACTS (the module does all I/O; this
 * structure is what the pure functions consume — unit tests feed
 * fixtures). Everything is scoped to ONE CLIENT; the workspace slice and
 * the kind slice are pure filters over the SAME full projection.
 */
export interface ClientMemoryAuthoritySnapshot {
  readonly agencyId: string;
  readonly clientId: string;
  /** The canonical Client record (ownership already resolved upstream — LIVE clients only). */
  readonly client: ClientRecord;
  /** The Client's LIVE workspaces (scope context + the deployment enumeration window). */
  readonly workspaces: readonly WorkspaceRecord[];
  /** The Client's goals (all lifecycle states — the frozen selection rule). */
  readonly goals: readonly GoalRecord[];
  /**
   * The Client's OWN playbooks (client-scoped only — the frozen
   * selection rule) with every immutable version of each.
   */
  readonly playbookEntries: ReadonlyArray<{
    readonly playbook: PlaybookRecord;
    readonly versions: readonly PlaybookVersionRecord[];
  }>;
  /** Every deployment across the Client's LIVE workspaces (any status). */
  readonly deployments: readonly DeploymentRecord[];
  /** The Client's evidence ledger rows (current + superseded — the selection rule filters here). */
  readonly evidence: readonly EvidenceRecord[];
  /** The Client's experiment records (any lifecycle/result state). */
  readonly experiments: readonly ExperimentRecord[];
  /** The Client's decision records (any disposition; observed outcomes ride on ACCEPTED ones). */
  readonly decisions: readonly DecisionRecord[];
  /** The Client's learning records (all derived states). */
  readonly learnings: readonly LearningRecord[];
}

// ---------------------------------------------------------------------------
// Vocabulary mechanics (deterministic, exported for unit tests)
// ---------------------------------------------------------------------------

/** The frozen kind → presentation-order index (unknown kinds sort last). */
export function clientMemoryKindIndexOf(kind: ClientMemoryRecordKind): number {
  const index = CLIENT_MEMORY_RECORD_KINDS.indexOf(kind);
  return index === -1 ? CLIENT_MEMORY_RECORD_KINDS.length : index;
}

/**
 * The bounded presentation excerpt under the frozen summary bound. The
 * authoritative payload stays on the authority — only the bounded
 * excerpt rides the memory surface.
 */
export function clientMemorySummaryOf(text: string): string {
  const bound = CLIENT_MEMORY_SELECTION_RULES.summaryBound;
  return text.length <= bound ? text : `${text.slice(0, bound)}…`;
}

/** The workspace-slice covering rule: client-wide items + the workspace's own. */
export function coversWorkspace(item: ClientMemoryItem, workspaceId: string): boolean {
  return item.workspaceId === null || item.workspaceId === workspaceId;
}

// ---------------------------------------------------------------------------
// The per-kind item builders (the frozen selection rules, one per kind)
// ---------------------------------------------------------------------------

/** GOAL item: all lifecycle states retained; no record-id links on the goal shape. */
export function goalMemoryItem(goal: GoalRecord): ClientMemoryItem {
  return {
    kind: 'goal',
    id: goal.goalId,
    summary: clientMemorySummaryOf(goal.objective),
    status: goal.status,
    workspaceId: goal.workspaceId,
    recordedAt: goal.createdAt,
    links: [],
  };
}

/** PLAYBOOK item: the client's own playbooks; links cite the optional goal. */
export function playbookMemoryItem(playbook: PlaybookRecord): ClientMemoryItem {
  return {
    kind: 'playbook',
    id: playbook.playbookId,
    summary: clientMemorySummaryOf(playbook.name),
    status: null,
    // Playbooks are client-level records (clientId column, no workspace scope).
    workspaceId: null,
    recordedAt: playbook.createdAt,
    links:
      playbook.goalId === null
        ? []
        : [{ kind: 'goal' as const, id: playbook.goalId }],
  };
}

/** PLAYBOOK-VERSION item: every immutable version; links cite the owning playbook. */
export function playbookVersionMemoryItem(version: PlaybookVersionRecord): ClientMemoryItem {
  return {
    kind: 'playbook-version',
    id: version.versionId,
    summary: clientMemorySummaryOf(`v${version.versionNumber}`),
    status: version.status,
    workspaceId: null,
    recordedAt: version.createdAt,
    links: [{ kind: 'playbook' as const, id: version.playbookId }],
  };
}

/** DEPLOYMENT item: any status; links cite the pinned playbook version (composed kinds only). */
export function deploymentMemoryItem(deployment: DeploymentRecord): ClientMemoryItem {
  return {
    kind: 'deployment',
    id: deployment.deploymentId,
    summary: clientMemorySummaryOf(deployment.status),
    status: deployment.status,
    workspaceId: deployment.workspaceId,
    recordedAt: deployment.createdAt,
    links: [{ kind: 'playbook-version' as const, id: deployment.playbookVersionId }],
  };
}

/**
 * EVIDENCE item: CURRENT rows only (the caller filters superseded rows
 * out — deriveClientMemoryItems applies the rule); links cite the
 * superseded predecessor when the authority names one.
 */
export function evidenceMemoryItem(evidence: EvidenceRecord): ClientMemoryItem {
  const label =
    evidence.source.ref === null
      ? evidence.source.system
      : `${evidence.source.system} ${evidence.source.ref}`;
  return {
    kind: 'evidence',
    id: evidence.evidenceId,
    summary: clientMemorySummaryOf(`${evidence.class} ${label} — observed ${evidence.observedAt}`),
    status: evidence.quality,
    workspaceId: evidence.workspaceId,
    recordedAt: evidence.provenance.recordedAt,
    links:
      evidence.supersedes === null
        ? []
        : [{ kind: 'evidence' as const, id: evidence.supersedes }],
  };
}

/** EXPERIMENT item: any lifecycle/result state; no canonical record-id links on the experiment shape. */
export function experimentMemoryItem(experiment: ExperimentRecord): ClientMemoryItem {
  return {
    kind: 'experiment',
    id: experiment.experimentId,
    summary: clientMemorySummaryOf(experiment.hypothesis),
    status: experiment.status,
    workspaceId: experiment.workspaceId,
    recordedAt: experiment.provenance.recordedAt,
    links: [],
  };
}

/**
 * DECISION item: any disposition (corrections are new records); links
 * cite the composed-kind references the ledger's own columns name
 * (evidence refs, the experiment link, the correction predecessor, the
 * supersede successor, the outcome's learning/deployment references —
 * execution references are out of the composition vocabulary).
 */
export function decisionMemoryItem(decision: DecisionRecord): ClientMemoryItem {
  const links: MemorySourceRef[] = [
    ...decision.evidenceRefs.map((evidenceId) => ({ kind: 'evidence' as const, id: evidenceId })),
  ];
  if (decision.experimentRef !== null) {
    links.push({ kind: 'experiment', id: decision.experimentRef });
  }
  if (decision.predecessorDecisionId !== null) {
    links.push({ kind: 'decision', id: decision.predecessorDecisionId });
  }
  if (decision.successorDecisionId !== null) {
    links.push({ kind: 'decision', id: decision.successorDecisionId });
  }
  if (decision.deploymentRef !== null) {
    links.push({ kind: 'deployment', id: decision.deploymentRef });
  }
  if (decision.learningRef !== null) {
    links.push({ kind: 'learning', id: decision.learningRef });
  }
  return {
    kind: 'decision',
    id: decision.decisionId,
    summary: clientMemorySummaryOf(decision.objective),
    status: decision.disposition,
    workspaceId: decision.workspaceId,
    recordedAt: decision.provenance.recordedAt,
    links,
  };
}

/**
 * OUTCOME item: the observed outcome recorded exactly once on an
 * ACCEPTED decision — cited by the decision id (the canonical outcome
 * surface today; disclosed composition). Links cite the outcome's
 * composed-kind references (deployment + learning; execution references
 * are out of the composition vocabulary).
 */
export function outcomeMemoryItem(decision: DecisionRecord): ClientMemoryItem {
  const outcome = decision.observedOutcome;
  if (outcome === null) {
    // The selection rule feeds ONLY decisions that carry an observed
    // outcome (deriveClientMemoryItems applies it); a null outcome here
    // is a contract violation, not a memory state.
    throw new Error(`decision ${decision.decisionId} carries no observed outcome`);
  }
  const links: MemorySourceRef[] = [];
  if (decision.deploymentRef !== null) {
    links.push({ kind: 'deployment', id: decision.deploymentRef });
  }
  if (decision.learningRef !== null) {
    links.push({ kind: 'learning', id: decision.learningRef });
  }
  return {
    kind: 'outcome',
    id: decision.decisionId,
    summary: clientMemorySummaryOf(outcome.summary),
    status:
      outcome.asExpected === null ? null : outcome.asExpected ? 'as-expected' : 'not-as-expected',
    workspaceId: decision.workspaceId,
    recordedAt: decision.outcomeAt ?? decision.provenance.recordedAt,
    links,
  };
}

/** LEARNING item: all derived states; links cite the supporting evidence/experiment references. */
export function learningMemoryItem(learning: LearningRecord): ClientMemoryItem {
  const links: MemorySourceRef[] = [
    ...learning.evidenceRefs.map((evidenceId) => ({ kind: 'evidence' as const, id: evidenceId })),
    ...learning.experimentRefs.map((experimentId) => ({
      kind: 'experiment' as const,
      id: experimentId,
    })),
  ];
  return {
    kind: 'learning',
    id: learning.learningId,
    summary: clientMemorySummaryOf(learning.statement),
    status: learning.status,
    workspaceId: learning.workspaceId,
    recordedAt: learning.provenance.recordedAt,
    links,
  };
}

// ---------------------------------------------------------------------------
// The full projection (the frozen selection rules applied)
// ---------------------------------------------------------------------------

/** The derived item population + the disclosed exclusions. */
export interface ClientMemoryProjectionResult {
  readonly items: readonly ClientMemoryItem[];
  readonly perKind: ClientMemoryKindCounts;
  /** Superseded evidence predecessors excluded by the selection rule (counted, never presented). */
  readonly supersededEvidenceCount: number;
}

/**
 * Derives the full client memory item population from one gathered
 * snapshot — every frozen selection rule applied, every exclusion
 * counted (never silently dropped). PURE: same snapshot ⇒ same items in
 * the same deterministic order.
 */
export function deriveClientMemoryItems(
  snapshot: ClientMemoryAuthoritySnapshot,
): ClientMemoryProjectionResult {
  const items: ClientMemoryItem[] = [];

  for (const goal of snapshot.goals) {
    items.push(goalMemoryItem(goal));
  }

  // The playbook selection rule: the client's OWN playbooks only —
  // agency-scoped reusable operational IP is a disclosed exclusion (the
  // module filters at gathering; this re-application is the fail-closed
  // backstop that makes the rule itself unit-pinned).
  for (const entry of snapshot.playbookEntries) {
    if (entry.playbook.clientId !== snapshot.clientId) continue;
    items.push(playbookMemoryItem(entry.playbook));
    for (const version of entry.versions) {
      items.push(playbookVersionMemoryItem(version));
    }
  }

  for (const deployment of snapshot.deployments) {
    items.push(deploymentMemoryItem(deployment));
  }

  // The evidence selection rule: CURRENT rows only; superseded
  // predecessors are counted and never presented.
  let supersededEvidenceCount = 0;
  for (const evidence of snapshot.evidence) {
    if (evidence.supersededBy !== null) {
      supersededEvidenceCount += 1;
      continue;
    }
    items.push(evidenceMemoryItem(evidence));
  }

  for (const experiment of snapshot.experiments) {
    items.push(experimentMemoryItem(experiment));
  }

  // The outcome selection rule: observed outcomes on ACCEPTED decisions
  // (recorded exactly once — the authority guarantees the pairing).
  for (const decision of snapshot.decisions) {
    if (decision.observedOutcome !== null) {
      items.push(outcomeMemoryItem(decision));
    }
  }

  for (const decision of snapshot.decisions) {
    items.push(decisionMemoryItem(decision));
  }

  for (const learning of snapshot.learnings) {
    items.push(learningMemoryItem(learning));
  }

  const ordered = orderMemoryItems(items);

  const perKind = {} as Record<ClientMemoryRecordKind, number>;
  for (const kind of CLIENT_MEMORY_RECORD_KINDS) {
    perKind[kind] = 0;
  }
  for (const item of ordered) {
    perKind[item.kind] += 1;
  }

  return { items: ordered, perKind, supersededEvidenceCount };
}

/**
 * The deterministic item order: kind vocabulary order, then recordedAt
 * DESC, then id ASC — the pinning-stable order (the frozen `ordering`
 * rule; same population ⇒ same order, always).
 */
export function orderMemoryItems(
  items: readonly ClientMemoryItem[],
): readonly ClientMemoryItem[] {
  return [...items].sort((left, right) => {
    const kindDelta = clientMemoryKindIndexOf(left.kind) - clientMemoryKindIndexOf(right.kind);
    if (kindDelta !== 0) return kindDelta;
    if (left.recordedAt !== right.recordedAt) {
      return left.recordedAt < right.recordedAt ? 1 : -1;
    }
    if (left.id !== right.id) return left.id < right.id ? -1 : 1;
    return 0;
  });
}

// ---------------------------------------------------------------------------
// View composition (the disclosure ships on every surface)
// ---------------------------------------------------------------------------

/** The governance disclosure carried by EVERY view (AC-3: policy-visible). */
export function composeProjectionDisclosure(): ProjectionDisclosure {
  return {
    projectionVersion: CLIENT_MEMORY_PROJECTION_VERSION,
    recordKinds: [...CLIENT_MEMORY_RECORD_KINDS],
    selectionRules: CLIENT_MEMORY_SELECTION_RULES,
    basis: 'live-derivation-over-canonical-authorities',
    persistence: 'none-derived-read-model',
    retrievalTechnology: 'none-live-composition-only',
  };
}

/** The client profile recap — the client record itself, cited. */
export function clientProfileRecapOf(client: ClientRecord): ClientProfileRecap {
  return {
    sourceRef: { kind: 'client', id: client.clientId },
    name: client.name,
    slug: client.slug,
    status: client.status,
    createdAt: client.createdAt,
    updatedAt: client.updatedAt,
  };
}

/** The workspace recaps — scope context of the memory surface (the Client's LIVE workspaces). */
export function workspaceRecapsOf(
  workspaces: readonly WorkspaceRecord[],
): readonly WorkspaceRecap[] {
  return workspaces.map((workspace) => ({
    workspaceId: workspace.workspaceId,
    name: workspace.name,
    status: workspace.status,
  }));
}

/** Composes the full CLIENT memory view from one gathered snapshot. */
export function composeClientMemoryView(
  snapshot: ClientMemoryAuthoritySnapshot,
  generatedAt: string,
): ClientMemoryView {
  const projection = deriveClientMemoryItems(snapshot);
  return {
    scope: {
      kind: 'client-memory',
      agencyId: snapshot.agencyId,
      clientId: snapshot.clientId,
      workspaceCount: snapshot.workspaces.length,
    },
    profile: clientProfileRecapOf(snapshot.client),
    workspaces: workspaceRecapsOf(snapshot.workspaces),
    items: projection.items,
    perKind: projection.perKind,
    supersededEvidenceCount: projection.supersededEvidenceCount,
    projection: composeProjectionDisclosure(),
    generatedAt,
  };
}

/**
 * Composes the WORKSPACE memory slice — the covering rule (client-wide
 * items + the workspace's own items) applied as a pure filter over the
 * FULL projection (same selection rules, same ordering).
 */
export function composeWorkspaceMemoryView(
  snapshot: ClientMemoryAuthoritySnapshot,
  workspaceId: string,
  generatedAt: string,
): WorkspaceMemoryView {
  const projection = deriveClientMemoryItems(snapshot);
  const workspace = snapshot.workspaces.find(
    (candidate) => candidate.workspaceId === workspaceId,
  );
  if (workspace === undefined) {
    // The module guarantees the slice workspace is among the Client's
    // LIVE workspaces (canonical ownership resolved before gathering);
    // a missing row here is a contract violation, not a memory state.
    throw new Error(
      `workspace ${workspaceId} is not among client ${snapshot.clientId}'s live workspaces`,
    );
  }
  const covering = projection.items.filter((item) => coversWorkspace(item, workspaceId));
  const perKind = {} as Record<ClientMemoryRecordKind, number>;
  for (const kind of CLIENT_MEMORY_RECORD_KINDS) {
    perKind[kind] = 0;
  }
  for (const item of covering) {
    perKind[item.kind] += 1;
  }
  return {
    scope: {
      kind: 'workspace-memory',
      agencyId: snapshot.agencyId,
      clientId: snapshot.clientId,
      workspaceId,
    },
    profile: clientProfileRecapOf(snapshot.client),
    workspace: {
      workspaceId: workspace.workspaceId,
      name: workspace.name,
      status: workspace.status,
    },
    items: covering,
    perKind,
    supersededEvidenceCount: projection.supersededEvidenceCount,
    projection: composeProjectionDisclosure(),
    generatedAt,
  };
}

/**
 * Composes the kind-filtered retrieval slice — a pure filter over the
 * DERIVED items (search over derived data, never a second query
 * authority): the full memory composes first, then ONE frozen
 * vocabulary kind's items are presented.
 */
export function composeKindMemorySlice(
  snapshot: ClientMemoryAuthoritySnapshot,
  kind: ClientMemoryRecordKind,
  generatedAt: string,
): ClientMemoryKindSlice {
  const projection = deriveClientMemoryItems(snapshot);
  return {
    scope: {
      kind: 'client-memory-kind-slice',
      agencyId: snapshot.agencyId,
      clientId: snapshot.clientId,
      recordKind: kind,
    },
    items: projection.items.filter((item) => item.kind === kind),
    perKindTotal: projection.perKind[kind],
    projection: composeProjectionDisclosure(),
    generatedAt,
  };
}
