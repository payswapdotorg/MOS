/**
 * /lab-ideas persistence (LAB-004 — the migration-066 tables).
 *
 * Owns EXACTLY the seven own tables (the 061/063/065 discipline):
 *
 *   lab_idea_decompositions, lab_idea_nodes, lab_idea_edges,
 *   lab_idea_operations, lab_idea_operation_inputs,
 *   lab_idea_cluster_runs, lab_idea_cluster_assignments.
 *
 * NO AUTHORITY TRANSFER / NO SHADOWING (§3): no experiment, decision,
 * evidence, metric, publication, workflow or execution table is
 * written or joined here; no /lab-features or /lab-corpus table is
 * written either — the bundle citation columns are OPAQUE recorded
 * citation data (the /lab family by-reference discipline; this store
 * never issues any SQL against lab_feature_* or lab_corpus_*).
 *
 * Node/edge/operation/input/assignment rows are APPEND-ONLY OUTRIGHT
 * (UPDATE and DELETE rejected by the migration-066 triggers); the
 * decomposition and cluster-run rows are born 'running' and advance
 * to 'completed' exactly once with their summary counts
 * SQL-COMPUTED from the tail rows (never asserted separately).
 *
 * Every read is CLIENT-scoped (the uniform tenant fence; the module
 * resolves foreign/unknown scope to the uniform NotFound — no
 * existence oracle). The retrieval read is a KEYSET-PAGINATED query
 * over (created_at, node_id) — pure SQL, no second search engine.
 */

import type { DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  LabIdeaClusterAssignmentRecord,
  LabIdeaClusterRunRecord,
  LabIdeaDecompositionRecord,
  LabIdeaEdgeRecord,
  LabIdeaNodeRecord,
  LabIdeaOperationRecord,
  LabIdeaOriginClass,
  LabIdeaPrimitiveKind,
  LabIdeasScope,
} from '../public.ts';
import {
  LAB_IDEAS_CONTRACT_VERSION,
  LAB_IDEAS_RETRIEVAL_MAX_LIMIT,
} from '../public.ts';

// ---------------------------------------------------------------------------
// Row shapes (snake_case as returned by PostgreSQL)
// ---------------------------------------------------------------------------

export interface DecompositionRow extends DbRow {
  decomposition_id: string;
  decomposition_version: number | string;
  idea_set_version: string;
  status: string;
  node_count: number | string;
  edge_count: number | string;
  bundle_id: string;
  bundle_reference: string;
  bundle_version: number | string;
  reference_id: string;
  corpus_id: string;
  corpus_version: number | string;
  provider: string;
  provider_content_id: string;
  canonical_url: string;
  metadata_digest: string;
  feature_set_version: string;
  extractor_id: string;
  extractor_version: string;
  bundle_identity_digest: string;
  decomposer_id: string;
  decomposer_version: string;
  identity_digest: string;
  input_digest: string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  contract_version: string;
  created_at: Date;
  updated_at: Date;
}

export interface NodeRow extends DbRow {
  node_id: string;
  decomposition_id: string | null;
  creating_operation_id: string | null;
  primitive_kind: string;
  origin_class: string;
  descriptor: string;
  attributes: unknown;
  cited_bundle_reference: string | null;
  creating_operation_kind: string | null;
  lineage: unknown;
  novelty_score: string | number | null;
  novelty_version: string | null;
  seq: number | string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  contract_version: string;
  created_at: Date;
  updated_at: Date;
}

export interface EdgeRow extends DbRow {
  edge_id: string;
  from_node_id: string;
  to_node_id: string;
  relation: string;
  decomposition_id: string | null;
  operation_id: string | null;
  seq: number | string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  contract_version: string;
  created_at: Date;
}

export interface OperationRow extends DbRow {
  operation_id: string;
  operation_kind: string;
  output_node_id: string;
  output_origin_class: string;
  generator_id: string;
  generator_version: string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  contract_version: string;
  created_at: Date;
}

export interface OperationInputRow extends DbRow {
  input_id: string;
  operation_id: string;
  node_id: string;
  seq: number | string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  contract_version: string;
  created_at: Date;
}

export interface ClusterRunRow extends DbRow {
  run_id: string;
  cluster_version: string;
  status: string;
  input_node_count: number | string;
  cluster_count: number | string;
  largest_cluster_size: number | string;
  singleton_count: number | string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  contract_version: string;
  created_at: Date;
  updated_at: Date;
}

export interface ClusterAssignmentRow extends DbRow {
  assignment_id: string;
  run_id: string;
  node_id: string;
  cluster_key: string;
  primitive_kind: string;
  cluster_size: number | string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  contract_version: string;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function toIso(value: Date): string {
  return value.toISOString();
}

/** The PostgreSQL array-literal serialization (the toArrayLiteral house precedent — text[] params ride as literals with ::text[] casts). */
function toArrayLiteral(values: readonly string[]): string {
  return `{${values
    .map((value) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`)
    .join(',')}}`;
}

export function mapDecompositionRow(
  r: DecompositionRow,
  nodes: ReadonlyArray<LabIdeaNodeRecord> = [],
  edges: ReadonlyArray<LabIdeaEdgeRecord> = [],
): LabIdeaDecompositionRecord {
  return {
    decompositionId: r.decomposition_id,
    decompositionVersion: Number(r.decomposition_version),
    ideaSetVersion: r.idea_set_version,
    status: r.status as 'running' | 'completed',
    nodeCount: Number(r.node_count),
    edgeCount: Number(r.edge_count),
    bundleId: r.bundle_id,
    bundleReference: r.bundle_reference,
    bundleVersion: Number(r.bundle_version),
    referenceId: r.reference_id,
    corpusId: r.corpus_id,
    corpusVersion: Number(r.corpus_version),
    provider: r.provider,
    providerContentId: r.provider_content_id,
    canonicalUrl: r.canonical_url,
    metadataDigest: r.metadata_digest,
    featureSetVersion: r.feature_set_version,
    extractorId: r.extractor_id,
    extractorVersion: r.extractor_version,
    bundleIdentityDigest: r.bundle_identity_digest,
    decomposerId: r.decomposer_id,
    decomposerVersion: r.decomposer_version,
    identityDigest: r.identity_digest,
    inputDigest: r.input_digest,
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
    nodes,
    edges,
  };
}

export function mapNodeRow(r: NodeRow): LabIdeaNodeRecord {
  return {
    nodeId: r.node_id,
    primitiveKind: r.primitive_kind as LabIdeaPrimitiveKind,
    originClass: r.origin_class as LabIdeaOriginClass,
    descriptor: r.descriptor,
    attributes: (r.attributes ?? {}) as Record<string, unknown>,
    decompositionId: r.decomposition_id,
    citedBundleReference: r.cited_bundle_reference,
    creatingOperationId: r.creating_operation_id,
    creatingOperationKind: r.creating_operation_kind as LabIdeaOperationRecord['operationKind'] | null,
    lineage: (r.lineage ?? null) as LabIdeaNodeRecord['lineage'],
    noveltyScore: r.novelty_score === null || r.novelty_score === undefined ? null : Number(r.novelty_score),
    noveltyVersion: r.novelty_version,
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

export function mapEdgeRow(r: EdgeRow): LabIdeaEdgeRecord {
  return {
    edgeId: r.edge_id,
    fromNodeId: r.from_node_id,
    toNodeId: r.to_node_id,
    relation: r.relation as LabIdeaEdgeRecord['relation'],
    decompositionId: r.decomposition_id,
    operationId: r.operation_id,
    seq: Number(r.seq),
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
  };
}

export function mapOperationRow(
  r: OperationRow,
  inputNodeIds: ReadonlyArray<string>,
  outputNode: LabIdeaNodeRecord | null = null,
): LabIdeaOperationRecord {
  return {
    operationId: r.operation_id,
    operationKind: r.operation_kind as LabIdeaOperationRecord['operationKind'],
    inputNodeIds,
    outputNodeId: r.output_node_id,
    outputOriginClass: r.output_origin_class as LabIdeaOriginClass,
    generatorId: r.generator_id,
    generatorVersion: r.generator_version,
    outputNode,
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
  };
}

export function mapClusterRunRow(
  r: ClusterRunRow,
  assignments: ReadonlyArray<LabIdeaClusterAssignmentRecord> = [],
): LabIdeaClusterRunRecord {
  return {
    runId: r.run_id,
    clusterVersion: r.cluster_version,
    status: r.status as 'running' | 'completed',
    inputNodeCount: Number(r.input_node_count),
    clusterCount: Number(r.cluster_count),
    largestClusterSize: Number(r.largest_cluster_size),
    singletonCount: Number(r.singleton_count),
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
    assignments,
  };
}

export function mapClusterAssignmentRow(r: ClusterAssignmentRow): LabIdeaClusterAssignmentRecord {
  return {
    assignmentId: r.assignment_id,
    runId: r.run_id,
    nodeId: r.node_id,
    clusterKey: r.cluster_key,
    primitiveKind: r.primitive_kind as LabIdeaPrimitiveKind,
    clusterSize: Number(r.cluster_size),
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
  };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface InsertDecompositionRowInput {
  decompositionId: string;
  decompositionVersion: number;
  scope: LabIdeasScope;
  citation: {
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
  decomposerId: string;
  decomposerVersion: string;
  identityDigest: string;
  inputDigest: string;
}

export interface InsertNodeRowInput {
  nodeId: string;
  scope: LabIdeasScope;
  primitiveKind: LabIdeaPrimitiveKind;
  originClass: LabIdeaOriginClass;
  descriptor: string;
  attributes: Readonly<Record<string, unknown>>;
  /** Null ⟺ non-observed (the origin-class fence). */
  decompositionId: string | null;
  /** The decomposition's bundle-reference echo (observed nodes only). */
  citedBundleReference: string | null;
  /** The creating operation id (recorded data — non-null ⟺ non-observed). */
  creatingOperationId: string | null;
  creatingOperationKind: string | null;
  lineage: ReadonlyArray<{ seq: number; fromNodeId: string; toNodeId: string; relation: string }> | null;
  noveltyScore: number | null;
  seq: number;
}

export interface InsertEdgeRowInput {
  edgeId: string;
  scope: LabIdeasScope;
  fromNodeId: string;
  toNodeId: string;
  relation: string;
  decompositionId: string | null;
  operationId: string | null;
  seq: number;
}

export interface InsertOperationRowInput {
  operationId: string;
  scope: LabIdeasScope;
  operationKind: string;
  outputNodeId: string;
  outputOriginClass: string;
  generatorId: string;
  generatorVersion: string;
}

export interface InsertClusterRunRowInput {
  runId: string;
  scope: LabIdeasScope;
  clusterVersion: string;
}

export interface InsertClusterAssignmentRowInput {
  assignmentId: string;
  runId: string;
  scope: LabIdeasScope;
  nodeId: string;
  clusterKey: string;
  primitiveKind: string;
  clusterSize: number;
}

/** The decoded keyset cursor. */
export interface LabIdeaCursor {
  createdAt: string;
  nodeId: string;
}

export class LabIdeasStore {
  private readonly db: DbTransaction;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: DbTransaction, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  nowIso(): string {
    return this.clock.nowIso();
  }

  newId(): string {
    return this.ids.newId();
  }

  // --- decompositions ---

  async insertDecomposition(input: InsertDecompositionRowInput): Promise<DecompositionRow> {
    const now = this.nowIso();
    const r = await this.db.query<DecompositionRow>(
      `INSERT INTO lab_idea_decompositions
         (decomposition_id, decomposition_version, idea_set_version, status, node_count, edge_count,
          bundle_id, bundle_reference, bundle_version, reference_id, corpus_id, corpus_version,
          provider, provider_content_id, canonical_url, metadata_digest, feature_set_version,
          extractor_id, extractor_version, bundle_identity_digest, decomposer_id, decomposer_version,
          identity_digest, input_digest, agency_id, client_id, workspace_id, contract_version,
          created_at, updated_at)
       VALUES ($1, $2, $3, 'running', 0, 0,
               $4, $5, $6, $7, $8, $9,
               $10, $11, $12, $13, $14,
               $15, $16, $17, $18, $19,
               $20, $21, $22, $23, $24, $25,
               $26::timestamptz, $26::timestamptz)
       RETURNING *`,
      [
        input.decompositionId,
        input.decompositionVersion,
        'lab-ideaset-v1',
        input.citation.bundleId,
        input.citation.bundleReference,
        input.citation.bundleVersion,
        input.citation.referenceId,
        input.citation.corpusId,
        input.citation.corpusVersion,
        input.citation.provider,
        input.citation.providerContentId,
        input.citation.canonicalUrl,
        input.citation.metadataDigest,
        input.citation.featureSetVersion,
        input.citation.extractorId,
        input.citation.extractorVersion,
        input.citation.bundleIdentityDigest,
        input.decomposerId,
        input.decomposerVersion,
        input.identityDigest,
        input.inputDigest,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        LAB_IDEAS_CONTRACT_VERSION,
        now,
      ],
    );
    return r.rows[0]!;
  }

  /**
   * THE COMPLETION ADVANCE: the single guarded running → completed
   * transition with the node/edge counts SQL-COMPUTED from the tail
   * rows (never asserted separately).
   */
  async completeDecomposition(decompositionId: string): Promise<DecompositionRow | null> {
    const now = this.nowIso();
    const r = await this.db.query<DecompositionRow>(
      `UPDATE lab_idea_decompositions
          SET status = 'completed',
              node_count = (SELECT count(*) FROM lab_idea_nodes WHERE decomposition_id = $1),
              edge_count = (SELECT count(*) FROM lab_idea_edges WHERE decomposition_id = $1),
              updated_at = $2::timestamptz
        WHERE decomposition_id = $1
        RETURNING *`,
      [decompositionId, now],
    );
    return r.rows[0] ?? null;
  }

  async findDecompositionByIdentity(clientId: string, identityDigest: string): Promise<DecompositionRow | null> {
    const r = await this.db.query<DecompositionRow>(
      `SELECT * FROM lab_idea_decompositions
        WHERE client_id = $1 AND identity_digest = $2`,
      [clientId, identityDigest],
    );
    return r.rows[0] ?? null;
  }

  async findLatestDecompositionVersion(clientId: string, bundleId: string): Promise<DecompositionRow | null> {
    const r = await this.db.query<DecompositionRow>(
      `SELECT * FROM lab_idea_decompositions
        WHERE client_id = $1 AND bundle_id = $2
        ORDER BY decomposition_version DESC LIMIT 1`,
      [clientId, bundleId],
    );
    return r.rows[0] ?? null;
  }

  async findDecomposition(clientId: string, decompositionId: string): Promise<DecompositionRow | null> {
    const r = await this.db.query<DecompositionRow>(
      `SELECT * FROM lab_idea_decompositions
        WHERE client_id = $1 AND decomposition_id = $2`,
      [clientId, decompositionId],
    );
    return r.rows[0] ?? null;
  }

  async listDecompositions(clientId: string, bundleReference?: string): Promise<ReadonlyArray<DecompositionRow>> {
    if (bundleReference === undefined || bundleReference === null || bundleReference === '') {
      const r = await this.db.query<DecompositionRow>(
        `SELECT * FROM lab_idea_decompositions
          WHERE client_id = $1
          ORDER BY created_at DESC, decomposition_id`,
        [clientId],
      );
      return r.rows;
    }
    // The per-cited-bundle VERSION CHAIN read: the citable reference
    // '<bundleId>#v<n>' resolves to the cited bundle — every
    // decomposition version of that bundle, newest version first.
    const bundleId = bundleReference.split('#', 1)[0]!;
    const r = await this.db.query<DecompositionRow>(
      `SELECT * FROM lab_idea_decompositions
         WHERE client_id = $1 AND bundle_id = $2
         ORDER BY decomposition_version DESC`,
      [clientId, bundleId],
    );
    return r.rows;
  }

  // --- nodes ---

  async insertNode(input: InsertNodeRowInput): Promise<NodeRow> {
    const now = this.nowIso();
    const r = await this.db.query<NodeRow>(
      `INSERT INTO lab_idea_nodes
         (node_id, decomposition_id, creating_operation_id, primitive_kind, origin_class,
          descriptor, attributes, cited_bundle_reference, creating_operation_kind, lineage,
          novelty_score, novelty_version, seq, agency_id, client_id, workspace_id,
          contract_version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5,
               $6, $7::jsonb, $8, $9, $10::jsonb,
               $11, $12, $13, $14, $15, $16,
               $17, $18::timestamptz, $18::timestamptz)
       RETURNING *`,
      [
        input.nodeId,
        input.decompositionId,
        input.creatingOperationId,
        input.primitiveKind,
        input.originClass,
        input.descriptor,
        JSON.stringify(input.attributes ?? {}),
        input.citedBundleReference,
        input.creatingOperationKind,
        input.lineage === null ? null : JSON.stringify(input.lineage),
        input.noveltyScore,
        input.noveltyScore === null ? null : 'lab-idea-novelty-v1',
        input.seq,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        LAB_IDEAS_CONTRACT_VERSION,
        now,
      ],
    );
    return r.rows[0]!;
  }

  async findNode(clientId: string, nodeId: string): Promise<NodeRow | null> {
    const r = await this.db.query<NodeRow>(
      `SELECT * FROM lab_idea_nodes
        WHERE client_id = $1 AND node_id = $2`,
      [clientId, nodeId],
    );
    return r.rows[0] ?? null;
  }

  async nodesByIds(clientId: string, nodeIds: ReadonlyArray<string>): Promise<ReadonlyArray<NodeRow>> {
    if (nodeIds.length === 0) return [];
    const r = await this.db.query<NodeRow>(
      `SELECT * FROM lab_idea_nodes
        WHERE client_id = $1 AND node_id = ANY($2::uuid[])`,
      [clientId, toArrayLiteral([...nodeIds])],
    );
    return r.rows;
  }

  async listNodesByDecomposition(decompositionId: string): Promise<ReadonlyArray<NodeRow>> {
    const r = await this.db.query<NodeRow>(
      `SELECT * FROM lab_idea_nodes
        WHERE decomposition_id = $1
        ORDER BY seq, node_id`,
      [decompositionId],
    );
    return r.rows;
  }

  async listEdgesByDecomposition(decompositionId: string): Promise<ReadonlyArray<EdgeRow>> {
    const r = await this.db.query<EdgeRow>(
      `SELECT * FROM lab_idea_edges
        WHERE decomposition_id = $1
        ORDER BY seq, edge_id`,
      [decompositionId],
    );
    return r.rows;
  }

  async listEdgesByOperation(operationId: string): Promise<ReadonlyArray<EdgeRow>> {
    const r = await this.db.query<EdgeRow>(
      `SELECT * FROM lab_idea_edges
        WHERE operation_id = $1
        ORDER BY seq, edge_id`,
      [operationId],
    );
    return r.rows;
  }

  /** The observed nodes of one primitive kind (node_id ascending — the deterministic comparison order for novelty). */
  async listObservedNodesByKind(clientId: string, primitiveKind: string): Promise<ReadonlyArray<NodeRow>> {
    const r = await this.db.query<NodeRow>(
      `SELECT * FROM lab_idea_nodes
        WHERE client_id = $1 AND origin_class = 'observed_source' AND primitive_kind = $2
        ORDER BY node_id`,
      [clientId, primitiveKind],
    );
    return r.rows;
  }

  /** The clusterable nodes (observed + derived, node_id ascending — the deterministic clustering input order). */
  async listClusterableNodes(clientId: string): Promise<ReadonlyArray<NodeRow>> {
    const r = await this.db.query<NodeRow>(
      `SELECT * FROM lab_idea_nodes
        WHERE client_id = $1 AND origin_class IN ('observed_source', 'derived_abstraction')
        ORDER BY node_id`,
      [clientId],
    );
    return r.rows;
  }
  /**
   * THE DETERMINISTIC RETRIEVAL: the keyset-paginated query over
   * (created_at, node_id) — by origin class (mandatory), by
   * primitive kind, by cited bundle reference / reference id (the
   * same-module decomposition join). Pure SQL, no second search
   * engine.
   */
  async retrieveNodes(input: {
    clientId: string;
    originClasses: ReadonlyArray<string>;
    primitiveKinds?: ReadonlyArray<string> | undefined;
    citedBundleReference?: string | undefined;
    citedReferenceId?: string | undefined;
    limit: number;
    cursor: LabIdeaCursor | null;
  }): Promise<ReadonlyArray<NodeRow>> {
    const params: Array<string | number> = [input.clientId, toArrayLiteral([...input.originClasses])];
    let predicate = 'n.client_id = $1 AND n.origin_class = ANY($2::text[])';
    if (input.primitiveKinds !== undefined && input.primitiveKinds.length > 0) {
      params.push(toArrayLiteral([...input.primitiveKinds]));
      predicate += ` AND n.primitive_kind = ANY($${params.length}::text[])`;
    }
    let join = '';
    if (input.citedBundleReference !== undefined && input.citedBundleReference !== null && input.citedBundleReference !== '') {
      params.push(input.citedBundleReference);
      const paramIndex = params.length;
      join = `JOIN lab_idea_decompositions d ON d.decomposition_id = n.decomposition_id AND d.bundle_reference = $${paramIndex}`;
    }
    if (input.citedReferenceId !== undefined && input.citedReferenceId !== null && input.citedReferenceId !== '') {
      params.push(input.citedReferenceId);
      const paramIndex = params.length;
      const joinClause = `JOIN lab_idea_decompositions d2 ON d2.decomposition_id = n.decomposition_id AND d2.reference_id = $${paramIndex}`;
      join = join === '' ? joinClause : `${join} ${joinClause}`;
    }
    if (input.cursor !== null) {
      params.push(input.cursor.createdAt, input.cursor.nodeId);
      const c = params.length - 1;
      predicate += ` AND (n.created_at, n.node_id) < ($${c}::timestamptz, $${c + 1}::uuid)`;
    }
    params.push(Math.min(input.limit, LAB_IDEAS_RETRIEVAL_MAX_LIMIT) + 1);
    const limitIndex = params.length;
    const r = await this.db.query<NodeRow>(
      `SELECT n.* FROM lab_idea_nodes n ${join}
        WHERE ${predicate}
        ORDER BY n.created_at DESC, n.node_id DESC
        LIMIT $${limitIndex}`,
      params,
    );
    return r.rows;
  }

  // --- operations ---

  async insertOperation(input: InsertOperationRowInput): Promise<OperationRow> {
    const now = this.nowIso();
    const r = await this.db.query<OperationRow>(
      `INSERT INTO lab_idea_operations
         (operation_id, operation_kind, output_node_id, output_origin_class, generator_id, generator_version,
          agency_id, client_id, workspace_id, contract_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6,
               $7, $8, $9, $10, $11::timestamptz)
       RETURNING *`,
      [
        input.operationId,
        input.operationKind,
        input.outputNodeId,
        input.outputOriginClass,
        input.generatorId,
        input.generatorVersion,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        LAB_IDEAS_CONTRACT_VERSION,
        now,
      ],
    );
    return r.rows[0]!;
  }

  async insertOperationInput(input: {
    inputId: string;
    operationId: string;
    scope: LabIdeasScope;
    nodeId: string;
    seq: number;
  }): Promise<OperationInputRow> {
    const now = this.nowIso();
    const r = await this.db.query<OperationInputRow>(
      `INSERT INTO lab_idea_operation_inputs
         (input_id, operation_id, node_id, seq, agency_id, client_id, workspace_id, contract_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)
       RETURNING *`,
      [
        input.inputId,
        input.operationId,
        input.nodeId,
        input.seq,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        LAB_IDEAS_CONTRACT_VERSION,
        now,
      ],
    );
    return r.rows[0]!;
  }

  async findOperation(clientId: string, operationId: string): Promise<OperationRow | null> {
    const r = await this.db.query<OperationRow>(
      `SELECT * FROM lab_idea_operations
        WHERE client_id = $1 AND operation_id = $2`,
      [clientId, operationId],
    );
    return r.rows[0] ?? null;
  }

  async listOperationInputs(operationId: string): Promise<ReadonlyArray<OperationInputRow>> {
    const r = await this.db.query<OperationInputRow>(
      `SELECT * FROM lab_idea_operation_inputs
        WHERE operation_id = $1
        ORDER BY seq, input_id`,
      [operationId],
    );
    return r.rows;
  }

  // --- edges ---

  async insertEdge(input: InsertEdgeRowInput): Promise<EdgeRow> {
    const now = this.nowIso();
    const r = await this.db.query<EdgeRow>(
      `INSERT INTO lab_idea_edges
         (edge_id, from_node_id, to_node_id, relation, decomposition_id, operation_id, seq,
          agency_id, client_id, workspace_id, contract_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
               $8, $9, $10, $11, $12::timestamptz)
       RETURNING *`,
      [
        input.edgeId,
        input.fromNodeId,
        input.toNodeId,
        input.relation,
        input.decompositionId,
        input.operationId,
        input.seq,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        LAB_IDEAS_CONTRACT_VERSION,
        now,
      ],
    );
    return r.rows[0]!;
  }

  // --- cluster runs + assignments ---

  async insertClusterRun(input: InsertClusterRunRowInput): Promise<ClusterRunRow> {
    const now = this.nowIso();
    const r = await this.db.query<ClusterRunRow>(
      `INSERT INTO lab_idea_cluster_runs
         (run_id, cluster_version, status, input_node_count, cluster_count, largest_cluster_size, singleton_count,
          agency_id, client_id, workspace_id, contract_version, created_at, updated_at)
       VALUES ($1, $2, 'running', 0, 0, 0, 0,
               $3, $4, $5, $6, $7::timestamptz, $7::timestamptz)
       RETURNING *`,
      [
        input.runId,
        input.clusterVersion,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        LAB_IDEAS_CONTRACT_VERSION,
        now,
      ],
    );
    return r.rows[0]!;
  }

  /**
   * THE COMPLETION ADVANCE: the single guarded running → completed
   * transition with the summary SQL-COMPUTED from the assignment rows
   * (never asserted separately — the row-level arithmetic fences pin
   * the completed state).
   */
  async completeClusterRun(runId: string): Promise<ClusterRunRow | null> {
    const now = this.nowIso();
    const r = await this.db.query<ClusterRunRow>(
      `UPDATE lab_idea_cluster_runs
          SET status = 'completed',
              input_node_count = (SELECT count(*) FROM lab_idea_cluster_assignments WHERE run_id = $1),
              cluster_count = (SELECT count(DISTINCT cluster_key) FROM lab_idea_cluster_assignments WHERE run_id = $1),
              largest_cluster_size = COALESCE((SELECT max(cluster_size) FROM lab_idea_cluster_assignments WHERE run_id = $1), 0),
              singleton_count = (SELECT count(*) FROM (SELECT DISTINCT cluster_key, cluster_size FROM lab_idea_cluster_assignments WHERE run_id = $1) c WHERE c.cluster_size = 1),
              updated_at = $2::timestamptz
        WHERE run_id = $1
        RETURNING *`,
      [runId, now],
    );
    return r.rows[0] ?? null;
  }

  async findClusterRunByVersion(clientId: string, clusterVersion: string): Promise<ClusterRunRow | null> {
    const r = await this.db.query<ClusterRunRow>(
      `SELECT * FROM lab_idea_cluster_runs
        WHERE client_id = $1 AND cluster_version = $2`,
      [clientId, clusterVersion],
    );
    return r.rows[0] ?? null;
  }

  async findClusterRun(clientId: string, runId: string): Promise<ClusterRunRow | null> {
    const r = await this.db.query<ClusterRunRow>(
      `SELECT * FROM lab_idea_cluster_runs
        WHERE client_id = $1 AND run_id = $2`,
      [clientId, runId],
    );
    return r.rows[0] ?? null;
  }

  async insertClusterAssignment(input: InsertClusterAssignmentRowInput): Promise<ClusterAssignmentRow> {
    const now = this.nowIso();
    const r = await this.db.query<ClusterAssignmentRow>(
      `INSERT INTO lab_idea_cluster_assignments
         (assignment_id, run_id, node_id, cluster_key, primitive_kind, cluster_size,
          agency_id, client_id, workspace_id, contract_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6,
               $7, $8, $9, $10, $11::timestamptz)
       RETURNING *`,
      [
        input.assignmentId,
        input.runId,
        input.nodeId,
        input.clusterKey,
        input.primitiveKind,
        input.clusterSize,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        LAB_IDEAS_CONTRACT_VERSION,
        now,
      ],
    );
    return r.rows[0]!;
  }

  async listClusterAssignments(runId: string): Promise<ReadonlyArray<ClusterAssignmentRow>> {
    const r = await this.db.query<ClusterAssignmentRow>(
      `SELECT * FROM lab_idea_cluster_assignments
        WHERE run_id = $1
        ORDER BY node_id, assignment_id`,
      [runId],
    );
    return r.rows;
  }
}
