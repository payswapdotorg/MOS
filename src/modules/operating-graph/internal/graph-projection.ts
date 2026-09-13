/**
 * The PURE /operating-graph derivations and view compositions (MKT-041).
 *
 * Everything in this file is a PURE FUNCTION over plain record snapshots:
 * the module implementation does all I/O (the composed authorities' public
 * contracts) and hands the snapshots here; the same inputs always derive the
 * same graph and compose the same views. The derivation NEVER infers a
 * relation that an authoritative reference does not carry, and every
 * endpoint must be a known node before a relation may reference it (the
 * storage-layer endpoint fence mirrors this at the database).
 *
 * Derivation semantics (spec/operating-graph-v1.5.md):
 *   - every relation is 'observed' — read directly from authoritative state
 *     (the other four frozen epistemic values are reserved for the v1.5
 *     writers that earn them; the vocabulary stays DISTINCT here);
 *   - edges reference EXACT immutable versions (a deployment pins a specific
 *     playbook_version id; an instance pins a specific workflow_definition
 *     id) — never a floating "latest";
 *   - references that do not resolve INSIDE the Client's scope (foreign or
 *     unknown) derive NO relation — fail-closed, never a cross-tenant edge;
 *   - an execution's task linkage is reference data: the executes_step
 *     relation exists only when the referenced instance is one of the
 *     Client's own instances;
 *   - the /evidence relations derive from the authority's bounded
 *     newest-first listing (disclosed honestly; out-of-window references
 *     cited by learnings or supersession pointers resolve individually).
 */

import type { GoalRecord } from '../../goals/public.ts';
import type { PlaybookRecord, PlaybookVersionRecord } from '../../playbooks/public.ts';
import type {
  WorkflowDefinitionRecord,
  WorkflowInstanceRecord,
  WorkflowRecord,
} from '../../workflows/public.ts';
import type { ExecutionRecord } from '../../executions/public.ts';
import type { DeploymentRecord } from '../../deployments/public.ts';
import type { EvidenceRecord } from '../../evidence/public.ts';
import type { ExperimentRecord } from '../../experiments/public.ts';
import type { LearningRecord } from '../../learnings/public.ts';
import type {
  AgencyClientGraphTally,
  AgencyOperatingGraphView,
  ClientOperatingGraphView,
  OperatingGraphDerivationNotes,
  OperatingGraphEdgeRecap,
  OperatingGraphEdgeRelation,
  OperatingGraphEdgeState,
  OperatingGraphEdgeVersionRecap,
  OperatingGraphNodeKind,
  OperatingGraphNodeRecap,
  SupersededOperatingGraphEdgeRecap,
} from '../public.ts';
import { OPERATING_GRAPH_EDGE_RELATIONS, OPERATING_GRAPH_EDGE_STATES } from '../public.ts';

// ---------------------------------------------------------------------------
// The derivation input/output shapes (re-exported through the public entry)
// ---------------------------------------------------------------------------

/** A resolved Deployment pin: the immutable version + its owning Playbook. */
export interface ResolvedPlaybookVersion {
  readonly version: PlaybookVersionRecord;
  readonly playbook: PlaybookRecord;
}

/** A resolved workflow definition: the immutable version + its Workflow. */
export interface ResolvedWorkflowDefinition {
  readonly definition: WorkflowDefinitionRecord;
  readonly workflow: WorkflowRecord;
}

/** One derived registry row: a canonical record reference + its own scope. */
export interface DerivedNodeRef {
  readonly kind: OperatingGraphNodeKind;
  readonly id: string;
  readonly agencyId: string;
  /** null = agency-scoped record (agency-reusable Playbook artifacts). */
  readonly clientId: string | null;
  readonly workspaceId: string | null;
}

/** One derived relation: canonical endpoints + the frozen vocabulary. */
export interface DerivedEdgeRef {
  readonly from: { readonly kind: OperatingGraphNodeKind; readonly id: string };
  readonly to: { readonly kind: OperatingGraphNodeKind; readonly id: string };
  readonly relation: OperatingGraphEdgeRelation;
  readonly state: OperatingGraphEdgeState;
  /** The relation's home workspace: the from endpoint's, else the to's. */
  readonly workspaceId: string | null;
}

/**
 * The pure derivation input: plain record snapshots gathered through the
 * composed authorities' PUBLIC CONTRACTS (the module does all I/O; this
 * structure is what the pure projection consumes — unit tests feed
 * fixtures). Resolution maps carry `null` (or an absent key) for references
 * that do not resolve within the Client's scope — the derivation then
 * produces NO relation (fail-closed, no cross-tenant edges).
 */
export interface ClientGraphAuthoritySnapshot {
  readonly agencyId: string;
  readonly clientId: string;
  readonly goals: readonly GoalRecord[];
  readonly playbooks: ReadonlyArray<{
    readonly playbook: PlaybookRecord;
    readonly versions: readonly PlaybookVersionRecord[];
  }>;
  readonly workspaces: ReadonlyArray<{
    readonly workspaceId: string;
    readonly deployments: readonly DeploymentRecord[];
    readonly workflows: ReadonlyArray<{
      readonly workflow: WorkflowRecord;
      readonly definitions: readonly WorkflowDefinitionRecord[];
      readonly instances: readonly WorkflowInstanceRecord[];
    }>;
    readonly executions: readonly ExecutionRecord[];
  }>;
  /** The /evidence authority's bounded newest-first listing (disclosed). */
  readonly evidence: readonly EvidenceRecord[];
  readonly experiments: readonly ExperimentRecord[];
  readonly learnings: readonly LearningRecord[];
  /** Deployment pins resolved through /playbooks (null = unresolvable/foreign). */
  readonly resolvedPlaybookVersions: ReadonlyMap<string, ResolvedPlaybookVersion | null>;
  /** Deployment workflow references resolved through /workflows (null = unresolvable/foreign). */
  readonly resolvedDefinitions: ReadonlyMap<string, ResolvedWorkflowDefinition | null>;
  /** Evidence references resolved through /evidence beyond the listing window (null = unresolvable/foreign). */
  readonly resolvedEvidence: ReadonlyMap<string, EvidenceRecord | null>;
  /** Experiment references resolved through /experiments (null = unresolvable/foreign). */
  readonly resolvedExperiments: ReadonlyMap<string, ExperimentRecord | null>;
}

/** The pure derivation output. */
export interface ClientGraphProjection {
  readonly nodes: readonly DerivedNodeRef[];
  readonly edges: readonly DerivedEdgeRef[];
}

/** The MKT-041 derivation disclosure (honest about the evidence window). */
function operatingGraphDerivationNotes(): OperatingGraphDerivationNotes {
  return {
    basis: 'canonical-authority-records',
    evidenceWindow: 'evidence-authority-bounded-newest-first-listing',
    edgeStates: [...OPERATING_GRAPH_EDGE_STATES],
  };
}

// ---------------------------------------------------------------------------
// The pure derivation
// ---------------------------------------------------------------------------

function nodeKey(kind: OperatingGraphNodeKind, id: string): string {
  return `${kind}:${id}`;
}

function edgeKey(
  from: { kind: OperatingGraphNodeKind; id: string },
  relation: OperatingGraphEdgeRelation,
  to: { kind: OperatingGraphNodeKind; id: string },
): string {
  return `${from.kind}:${from.id}|${relation}|${to.kind}:${to.id}`;
}

/**
 * Derives the Client's operating graph projection from the authority
 * snapshots. PURE: every relation is 'observed', read from an authoritative
 * reference; every endpoint is a registered node before any relation may
 * reference it; foreign or unresolvable references derive NOTHING.
 */
export function deriveClientGraphProjection(
  snapshot: ClientGraphAuthoritySnapshot,
): ClientGraphProjection {
  const { agencyId, clientId } = snapshot;
  const nodes = new Map<string, DerivedNodeRef>();
  const edges = new Map<string, DerivedEdgeRef>();

  const addNode = (node: DerivedNodeRef): void => {
    nodes.set(nodeKey(node.kind, node.id), node);
  };
  const hasNode = (kind: OperatingGraphNodeKind, id: string): boolean =>
    nodes.has(nodeKey(kind, id));
  const nodeWorkspace = (kind: OperatingGraphNodeKind, id: string): string | null =>
    nodes.get(nodeKey(kind, id))?.workspaceId ?? null;

  /**
   * Adds one OBSERVED relation — but only when BOTH endpoint nodes are
   * already registered (the database endpoint fence mirrors this: an edge
   * may never dangle). The relation's home workspace is the from
   * endpoint's, else the to endpoint's.
   */
  const addEdge = (
    from: { kind: OperatingGraphNodeKind; id: string },
    relation: OperatingGraphEdgeRelation,
    to: { kind: OperatingGraphNodeKind; id: string },
  ): void => {
    if (!hasNode(from.kind, from.id) || !hasNode(to.kind, to.id)) return;
    edges.set(edgeKey(from, relation, to), {
      from,
      to,
      relation,
      state: 'observed',
      workspaceId: nodeWorkspace(from.kind, from.id) ?? nodeWorkspace(to.kind, to.id),
    });
  };

  // 1. The Client root.
  addNode({ kind: 'client', id: clientId, agencyId, clientId, workspaceId: null });

  // 2. Goals (every lifecycle state — terminal goals stay visible history).
  for (const goal of snapshot.goals) {
    addNode({
      kind: 'goal',
      id: goal.goalId,
      agencyId,
      clientId,
      workspaceId: goal.workspaceId,
    });
    addEdge({ kind: 'client', id: clientId }, 'has_goal', { kind: 'goal', id: goal.goalId });
  }

  // 3. Client-scoped Playbooks + their immutable versions (the strategy
  //    artifacts). Agency-reusable Playbooks enter the Client graph only
  //    through Deployment pins (step 4) — their agency-level version
  //    relations are not part of a Client's derivable set.
  for (const { playbook, versions } of snapshot.playbooks) {
    addNode({
      kind: 'playbook',
      id: playbook.playbookId,
      agencyId,
      clientId: playbook.clientId,
      workspaceId: null,
    });
    if (playbook.goalId !== null) {
      addEdge(
        { kind: 'goal', id: playbook.goalId },
        'pursued_by_playbook',
        { kind: 'playbook', id: playbook.playbookId },
      );
    }
    for (const version of versions) {
      addNode({
        kind: 'playbook_version',
        id: version.versionId,
        agencyId,
        clientId: playbook.clientId,
        workspaceId: null,
      });
      addEdge(
        { kind: 'playbook', id: playbook.playbookId },
        'has_version',
        { kind: 'playbook_version', id: version.versionId },
      );
    }
  }

  // 4. The delivery side, per Workspace. Workflows/definitions/instances
  //    register BEFORE deployments: a deployment's referenced definition
  //    versions are nodes of the same Workspace enumeration (the
  //    node-before-relation guard requires it).
  for (const workspace of snapshot.workspaces) {
    // Workflows + their definition versions + the instances pinning them.
    for (const { workflow, definitions, instances } of workspace.workflows) {
      addNode({
        kind: 'workflow',
        id: workflow.workflowId,
        agencyId,
        clientId,
        workspaceId: workflow.workspaceId,
      });
      for (const definition of definitions) {
        addNode({
          kind: 'workflow_definition',
          id: definition.workflowDefinitionId,
          agencyId,
          clientId,
          workspaceId: workflow.workspaceId,
        });
        addEdge(
          { kind: 'workflow', id: workflow.workflowId },
          'has_definition',
          { kind: 'workflow_definition', id: definition.workflowDefinitionId },
        );
      }
      for (const instance of instances) {
        addNode({
          kind: 'workflow_instance',
          id: instance.workflowInstanceId,
          agencyId,
          clientId,
          workspaceId: instance.workspaceId,
        });
        addEdge(
          { kind: 'workflow_instance', id: instance.workflowInstanceId },
          'pins_definition',
          { kind: 'workflow_definition', id: instance.workflowDefinitionId },
        );
      }
    }

    // Deployments: the EXACT pinned playbook version + the referenced
    // workflow definition versions (the deployment's own immutable
    // selection — never a floating "latest").
    for (const deployment of workspace.deployments) {
      addNode({
        kind: 'deployment',
        id: deployment.deploymentId,
        agencyId,
        clientId,
        workspaceId: workspace.workspaceId,
      });
      const pin = snapshot.resolvedPlaybookVersions.get(deployment.playbookVersionId) ?? null;
      if (
        pin !== null &&
        pin.playbook.agencyId === agencyId &&
        (pin.playbook.clientId === null || pin.playbook.clientId === clientId)
      ) {
        // The version node carries its OWN scope (agency-scoped when the
        // playbook is agency-reusable IP — the cross-tenant fence allows
        // an agency-scoped endpoint inside a Client graph).
        addNode({
          kind: 'playbook_version',
          id: pin.version.versionId,
          agencyId: pin.playbook.agencyId,
          clientId: pin.playbook.clientId,
          workspaceId: null,
        });
        addEdge(
          { kind: 'deployment', id: deployment.deploymentId },
          'pins_playbook_version',
          { kind: 'playbook_version', id: pin.version.versionId },
        );
      }
      for (const definitionId of deployment.workflowDefinitionIds) {
        const resolved = snapshot.resolvedDefinitions.get(definitionId) ?? null;
        if (resolved === null || resolved.workflow.clientId !== clientId) continue;
        addNode({
          kind: 'workflow_definition',
          id: resolved.definition.workflowDefinitionId,
          agencyId,
          clientId,
          workspaceId: resolved.workflow.workspaceId,
        });
        addEdge(
          { kind: 'deployment', id: deployment.deploymentId },
          'deploys_definition',
          { kind: 'workflow_definition', id: resolved.definition.workflowDefinitionId },
        );
      }
    }

    // Executions (every lifecycle state — failed/unresolved rows stay
    // visible). The task linkage is reference data: the executes_step
    // relation exists only when the referenced instance is one of the
    // Client's own instances (a foreign instance identifier derives
    // NOTHING — fail-closed).
    for (const execution of workspace.executions) {
      addNode({
        kind: 'execution',
        id: execution.executionId,
        agencyId,
        clientId,
        workspaceId: execution.workspaceId,
      });
      addEdge(
        { kind: 'client', id: clientId },
        'runs_execution',
        { kind: 'execution', id: execution.executionId },
      );
      if (execution.taskLink.kind === 'workflow-node') {
        addEdge(
          { kind: 'execution', id: execution.executionId },
          'executes_step',
          { kind: 'workflow_instance', id: execution.taskLink.workflowInstanceId },
        );
      }
    }
  }

  // 5. Evidence — the /evidence authority's bounded newest-first listing.
  //    Out-of-window references (supersession pointers, learning citations)
  //    resolve individually through the resolution maps.
  const evidenceById = new Map(snapshot.evidence.map((record) => [record.evidenceId, record]));
  const resolveEvidence = (evidenceId: string): EvidenceRecord | null =>
    evidenceById.get(evidenceId) ?? snapshot.resolvedEvidence.get(evidenceId) ?? null;
  for (const record of snapshot.evidence) {
    addNode({
      kind: 'evidence',
      id: record.evidenceId,
      agencyId,
      clientId,
      workspaceId: record.workspaceId,
    });
    addEdge(
      { kind: 'client', id: clientId },
      'has_evidence',
      { kind: 'evidence', id: record.evidenceId },
    );
    if (record.supersedes !== null) {
      const target = resolveEvidence(record.supersedes);
      if (target !== null && target.clientId === clientId) {
        addNode({
          kind: 'evidence',
          id: target.evidenceId,
          agencyId,
          clientId,
          workspaceId: target.workspaceId,
        });
        addEdge(
          { kind: 'evidence', id: record.evidenceId },
          'supersedes',
          { kind: 'evidence', id: target.evidenceId },
        );
      }
    }
  }

  // 6. Experiments (the hypothesis-testing records).
  const experimentsById = new Map(snapshot.experiments.map((record) => [record.experimentId, record]));
  for (const record of snapshot.experiments) {
    addNode({
      kind: 'experiment',
      id: record.experimentId,
      agencyId,
      clientId,
      workspaceId: record.workspaceId,
    });
    addEdge(
      { kind: 'client', id: clientId },
      'runs_experiment',
      { kind: 'experiment', id: record.experimentId },
    );
  }

  // 7. Learnings + their supporting references (same-Client only — a
  //    foreign reference derives NOTHING).
  for (const record of snapshot.learnings) {
    addNode({
      kind: 'learning',
      id: record.learningId,
      agencyId,
      clientId,
      workspaceId: record.workspaceId,
    });
    addEdge(
      { kind: 'client', id: clientId },
      'records_learning',
      { kind: 'learning', id: record.learningId },
    );
    for (const evidenceRef of record.evidenceRefs) {
      const target = resolveEvidence(evidenceRef);
      if (target === null || target.clientId !== clientId) continue;
      addNode({
        kind: 'evidence',
        id: target.evidenceId,
        agencyId,
        clientId,
        workspaceId: target.workspaceId,
      });
      addEdge(
        { kind: 'learning', id: record.learningId },
        'supported_by',
        { kind: 'evidence', id: target.evidenceId },
      );
    }
    for (const experimentRef of record.experimentRefs) {
      const target =
        experimentsById.get(experimentRef) ?? snapshot.resolvedExperiments.get(experimentRef) ?? null;
      if (target === null || target.clientId !== clientId) continue;
      addNode({
        kind: 'experiment',
        id: target.experimentId,
        agencyId,
        clientId,
        workspaceId: target.workspaceId,
      });
      addEdge(
        { kind: 'learning', id: record.learningId },
        'derived_from',
        { kind: 'experiment', id: target.experimentId },
      );
    }
  }

  const nodeOrder = (node: DerivedNodeRef): string => `${node.kind}:${node.id}`;
  return {
    nodes: [...nodes.values()].sort((a, b) => nodeOrder(a).localeCompare(nodeOrder(b))),
    edges: [...edges.values()].sort(
      (a, b) =>
        edgeKey(a.from, a.relation, a.to).localeCompare(edgeKey(b.from, b.relation, b.to)),
    ),
  };
}

// ---------------------------------------------------------------------------
// The view compositions (pure)
// ---------------------------------------------------------------------------

/** One registry row as loaded from the store (already scope-checked). */
export interface GraphNodeRowInput {
  readonly kind: OperatingGraphNodeKind;
  readonly id: string;
  readonly agencyId: string;
  readonly clientId: string | null;
  readonly workspaceId: string | null;
  readonly firstSeenAt: string;
  readonly lastRefreshedAt: string;
}

/** One edge ledger row as loaded from the store (current or historical). */
export interface GraphEdgeRowInput {
  readonly edgeId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly fromKind: OperatingGraphNodeKind;
  readonly fromId: string;
  readonly toKind: OperatingGraphNodeKind;
  readonly toId: string;
  readonly relation: OperatingGraphEdgeRelation;
  readonly edgeState: OperatingGraphEdgeState;
  readonly edgeVersion: number;
  readonly isCurrent: boolean;
  readonly recordedAt: string;
  readonly recordedBy: string;
  readonly supersededAt: string | null;
}

function versionRecap(row: GraphEdgeRowInput): OperatingGraphEdgeVersionRecap {
  return {
    edgeId: row.edgeId,
    edgeVersion: row.edgeVersion,
    edgeState: row.edgeState,
    recordedAt: row.recordedAt,
    recordedBy: row.recordedBy,
    supersededAt: row.supersededAt,
  };
}

/** Every relation key present, zeros included (the house tally posture). */
export function zeroedRelationCounts(): Record<OperatingGraphEdgeRelation, number> {
  const counts = {} as Record<OperatingGraphEdgeRelation, number>;
  for (const relation of OPERATING_GRAPH_EDGE_RELATIONS) counts[relation] = 0;
  return counts;
}

/**
 * Composes the Client's operating graph view from the store's ledger rows:
 * CURRENT relations with their full version history (every version stays
 * addressable), plus the superseded relations whose derivation no longer
 * holds (kept as history — never deleted).
 */
export function composeClientOperatingGraphView(input: {
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceCount: number;
  readonly nodes: readonly GraphNodeRowInput[];
  readonly edgeRows: readonly GraphEdgeRowInput[];
  readonly generatedAt: string;
}): ClientOperatingGraphView {
  const byKey = new Map<string, GraphEdgeRowInput[]>();
  for (const row of input.edgeRows) {
    const key = `${row.fromKind}:${row.fromId}|${row.relation}|${row.toKind}:${row.toId}`;
    const bucket = byKey.get(key);
    if (bucket === undefined) byKey.set(key, [row]);
    else bucket.push(row);
  }

  const edges: OperatingGraphEdgeRecap[] = [];
  const supersededEdges: SupersededOperatingGraphEdgeRecap[] = [];
  for (const rows of byKey.values()) {
    const ordered = [...rows].sort((a, b) => a.edgeVersion - b.edgeVersion);
    const currentRow = ordered.find((row) => row.isCurrent) ?? null;
    if (currentRow === null) {
      const last = ordered[ordered.length - 1]!;
      supersededEdges.push({
        fromKind: last.fromKind,
        fromId: last.fromId,
        toKind: last.toKind,
        toId: last.toId,
        relation: last.relation,
        lastVersion: versionRecap(last),
      });
      continue;
    }
    edges.push({
      fromKind: currentRow.fromKind,
      fromId: currentRow.fromId,
      toKind: currentRow.toKind,
      toId: currentRow.toId,
      relation: currentRow.relation,
      workspaceId: currentRow.workspaceId,
      current: versionRecap(currentRow),
      history: ordered.map(versionRecap),
    });
  }

  const nodeRecaps: OperatingGraphNodeRecap[] = [...input.nodes]
    .map((node) => ({
      kind: node.kind,
      id: node.id,
      agencyId: node.agencyId,
      clientId: node.clientId,
      workspaceId: node.workspaceId,
      firstSeenAt: node.firstSeenAt,
      lastRefreshedAt: node.lastRefreshedAt,
    }))
    .sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  edges.sort((a, b) =>
    `${a.fromKind}:${a.fromId}|${a.relation}|${a.toKind}:${a.toId}`.localeCompare(
      `${b.fromKind}:${b.fromId}|${b.relation}|${b.toKind}:${b.toId}`,
    ),
  );

  return {
    scope: {
      kind: 'client-operating-graph',
      agencyId: input.agencyId,
      clientId: input.clientId,
      workspaceCount: input.workspaceCount,
    },
    nodeCount: nodeRecaps.length,
    edgeCount: edges.length,
    nodes: nodeRecaps,
    edges,
    supersededEdges,
    derivation: operatingGraphDerivationNotes(),
    generatedAt: input.generatedAt,
  };
}

/** One Client's raw tally as loaded from the store. */
export interface AgencyClientTallyInput {
  readonly clientId: string;
  readonly nodeCount: number;
  readonly relationCounts: ReadonlyMap<OperatingGraphEdgeRelation, number>;
}

/**
 * Composes the Agency's operating graph view — the portfolio rollup over the
 * Client graphs. The aggregation scope arrives as SERVER-DERIVED data (the
 * route resolved the agency's live Clients + Workspace counts); tallies the
 * store computed for exactly those Clients.
 */
export function composeAgencyOperatingGraphView(input: {
  readonly agencyId: string;
  readonly clients: ReadonlyArray<{ readonly clientId: string; readonly workspaceCount: number }>;
  readonly tallies: readonly AgencyClientTallyInput[];
  readonly totalNodeCount: number;
  readonly generatedAt: string;
}): AgencyOperatingGraphView {
  const talliesByClient = new Map(input.tallies.map((tally) => [tally.clientId, tally]));
  const perClient: AgencyClientGraphTally[] = input.clients.map((client) => {
    const tally = talliesByClient.get(client.clientId);
    const relationCounts = zeroedRelationCounts();
    let edgeCount = 0;
    if (tally !== undefined) {
      for (const [relation, count] of tally.relationCounts) {
        relationCounts[relation] = count;
        edgeCount += count;
      }
    }
    return {
      clientId: client.clientId,
      workspaceCount: client.workspaceCount,
      nodeCount: tally?.nodeCount ?? 0,
      edgeCount,
      relationCounts,
    };
  });

  return {
    scope: {
      kind: 'agency-operating-graph',
      agencyId: input.agencyId,
      clientCount: input.clients.length,
    },
    totals: {
      nodeCount: input.totalNodeCount,
      edgeCount: perClient.reduce((sum, tally) => sum + tally.edgeCount, 0),
    },
    perClient,
    derivation: operatingGraphDerivationNotes(),
    generatedAt: input.generatedAt,
  };
}
