/**
 * /operating-graph persistence (operating_graph_nodes + operating_graph_edges
 * — migration 035, the MKT-041-reserved number).
 *
 * Two durable structures, both SOURCE-REFERENCE-ONLY (the derived
 * coordination model — never a copy of authoritative shape):
 *
 *   - `operating_graph_nodes`: the canonical-record registry. Upserts only:
 *     a rebuild refreshes last_refreshed_at on already-registered records;
 *     identity and scope are immutable (trigger); DELETE is rejected.
 *   - `operating_graph_edges`: the APPEND-ORIENTED, VERSIONED relation
 *     ledger. The converge algorithm below is the ONLY writer:
 *       - a derived relation already current and unchanged → NO-OP
 *         (converged — the second-rebuild proof);
 *       - a derived relation whose current row differs in epistemic state →
 *         the prior row is superseded (the single sanctioned UPDATE) and the
 *         NEXT version appended;
 *       - a relation no longer derivable → its current row is superseded
 *         (retraction; the row stays addressable forever);
 *       - a relation derived again after retraction → the next version.
 *
 * The database is the final backstop (the migration 003/015/034 pattern):
 * the scope-chain and endpoint cross-tenant triggers, the current-fence
 * partial unique index and the version-unique constraint all reject what
 * the application checks might miss. Concurrent rebuilds converge through
 * the fences: the loser surfaces as a classified ConflictError.
 */

import { ConflictError } from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type { OperatingGraphEdgeRelation } from '../public.ts';
import type {
  DerivedEdgeRef,
  DerivedNodeRef,
  GraphEdgeRowInput,
  GraphNodeRowInput,
} from './graph-projection.ts';

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface EdgeRow extends DbRow {
  edge_id: string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  from_kind: string;
  from_id: string;
  to_kind: string;
  to_id: string;
  relation: string;
  edge_state: string;
  edge_version: number;
  is_current: boolean;
  recorded_at: Date;
  recorded_by: string;
  superseded_at: Date | null;
}

interface NodeRow extends DbRow {
  node_kind: string;
  node_id: string;
  agency_id: string;
  client_id: string | null;
  workspace_id: string | null;
  first_seen_at: Date;
  last_refreshed_at: Date;
}

interface CurrentEdgeRow {
  readonly edgeId: string;
  readonly fromKind: string;
  readonly fromId: string;
  readonly toKind: string;
  readonly toId: string;
  readonly relation: string;
  readonly edgeState: string;
}

interface MaxVersionRow {
  readonly fromKind: string;
  readonly fromId: string;
  readonly toKind: string;
  readonly toId: string;
  readonly relation: string;
  readonly maxVersion: number;
}

/** The converge outcome (feeds the rebuild report). */
export interface ConvergeOutcome {
  readonly nodesUpserted: number;
  readonly edgesAppended: number;
  readonly edgesSuperseded: number;
  readonly edgesConverged: number;
}

/** Batched multi-row statements stay well inside the parameter budget. */
const INSERT_CHUNK = 400;

function edgeKeyOf(
  fromKind: string,
  fromId: string,
  relation: string,
  toKind: string,
  toId: string,
): string {
  return `${fromKind}:${fromId}|${relation}|${toKind}:${toId}`;
}

/** Distinctive markers of the migration 035 fence rejections. */
const EDGE_VERSION_FENCE_MARKER = 'operating_graph_edges_version_unique';
const EDGE_CURRENT_FENCE_MARKER = 'operating_graph_edges_current_fence';

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class OperatingGraphStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  /**
   * Converges one Client's derived ledger to the given projection, in ONE
   * transaction: registry upserts, then the append/supersede/converge plan.
   * A rebuild against unchanged authority state performs ZERO edge writes
   * (nodes only refresh last_refreshed_at).
   */
  async convergeClientGraph(input: {
    readonly agencyId: string;
    readonly clientId: string;
    readonly nodes: readonly DerivedNodeRef[];
    readonly edges: readonly DerivedEdgeRef[];
    readonly recordedBy: string;
  }): Promise<ConvergeOutcome> {
    try {
      return await this.db.transaction(async (tx) => {
        const nodesUpserted = await this.upsertNodes(tx, input.nodes);
        const outcome = await this.convergeEdges(tx, input);
        return { nodesUpserted, ...outcome };
      });
    } catch (error) {
      // Concurrent rebuild lost the fence race — converge to the uniform
      // domain conflict (the loser retries; the ledger stays consistent).
      const candidate = error as { message?: string; constraint?: string; code?: string };
      if (candidate?.code === '23505') {
        const haystack = `${candidate.message ?? ''} ${candidate.constraint ?? ''}`;
        if (
          haystack.includes(EDGE_VERSION_FENCE_MARKER) ||
          haystack.includes(EDGE_CURRENT_FENCE_MARKER)
        ) {
          throw new ConflictError(
            `client ${input.clientId} operating graph rebuild raced a concurrent rebuild; retry`,
          );
        }
      }
      throw error;
    }
  }

  private async upsertNodes(
    tx: DbTransaction,
    nodes: readonly DerivedNodeRef[],
  ): Promise<number> {
    let upserted = 0;
    for (let offset = 0; offset < nodes.length; offset += INSERT_CHUNK) {
      const chunk = nodes.slice(offset, offset + INSERT_CHUNK);
      const values: string[] = [];
      const params: Array<string | null> = [];
      for (const [index, node] of chunk.entries()) {
        const base = index * 5;
        values.push(
          `($${base + 1}::text, $${base + 2}::uuid, $${base + 3}::uuid, $${base + 4}::uuid, $${base + 5}::uuid)`,
        );
        params.push(node.kind, node.id, node.agencyId, node.clientId, node.workspaceId);
      }
      await tx.query(
        `INSERT INTO operating_graph_nodes
           (node_kind, node_id, agency_id, client_id, workspace_id, first_seen_at, last_refreshed_at)
         SELECT kind, id, agency, client, ws, now(), now()
           FROM (VALUES ${values.join(', ')}) AS t(kind, id, agency, client, ws)
         ON CONFLICT (node_kind, node_id)
         DO UPDATE SET last_refreshed_at = now()`,
        params,
      );
      upserted += chunk.length;
    }
    return upserted;
  }

  private async convergeEdges(
    tx: DbTransaction,
    input: {
      readonly agencyId: string;
      readonly clientId: string;
      readonly edges: readonly DerivedEdgeRef[];
      readonly recordedBy: string;
    },
  ): Promise<Omit<ConvergeOutcome, 'nodesUpserted'>> {
    const { agencyId, clientId, edges, recordedBy } = input;

    const currentRows = await this.loadCurrentEdges(tx, clientId);
    const maxVersions = await this.loadMaxVersions(tx, clientId);

    const derivedByKey = new Map<string, DerivedEdgeRef>();
    for (const edge of edges) {
      derivedByKey.set(
        edgeKeyOf(edge.from.kind, edge.from.id, edge.relation, edge.to.kind, edge.to.id),
        edge,
      );
    }
    const currentKeySet = new Set<string>();
    const maxVersionByKey = new Map<string, number>();
    for (const row of maxVersions) {
      maxVersionByKey.set(
        edgeKeyOf(row.fromKind, row.fromId, row.relation, row.toKind, row.toId),
        row.maxVersion,
      );
    }

    const toRetract: string[] = [];
    const toAppend: DerivedEdgeRef[] = [];
    let converged = 0;

    for (const row of currentRows) {
      const key = edgeKeyOf(row.fromKind, row.fromId, row.relation, row.toKind, row.toId);
      currentKeySet.add(key);
      const derived = derivedByKey.get(key);
      if (derived !== undefined && derived.state === row.edgeState) {
        // Already current and unchanged — the convergence proof.
        converged += 1;
        continue;
      }
      // State changed (version bump) or no longer derivable (retraction):
      // supersede the current row; a changed relation appends the next
      // version below.
      toRetract.push(row.edgeId);
      if (derived !== undefined) toAppend.push(derived);
    }
    for (const [key, edge] of derivedByKey) {
      if (currentKeySet.has(key)) continue; // handled above (converged or bumped)
      toAppend.push(edge);
    }

    const now = this.clock.nowIso();
    for (const edgeId of toRetract) {
      await tx.query(
        `UPDATE operating_graph_edges SET is_current = false, superseded_at = $2
         WHERE edge_id = $1 AND is_current`,
        [edgeId, now],
      );
    }
    for (let offset = 0; offset < toAppend.length; offset += INSERT_CHUNK) {
      const chunk = toAppend.slice(offset, offset + INSERT_CHUNK);
      const values: string[] = [];
      const params: Array<string | number | null> = [];
      for (const [index, edge] of chunk.entries()) {
        const key = edgeKeyOf(
          edge.from.kind,
          edge.from.id,
          edge.relation,
          edge.to.kind,
          edge.to.id,
        );
        const nextVersion = (maxVersionByKey.get(key) ?? 0) + 1;
        const base = index * 11;
        values.push(
          `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}::uuid, $${base + 4}::uuid, ` +
            `$${base + 5}::text, $${base + 6}::uuid, $${base + 7}::text, $${base + 8}::uuid, ` +
            `$${base + 9}::text, $${base + 10}::text, $${base + 11}::int)`,
        );
        params.push(
          this.ids.newId(),
          agencyId,
          clientId,
          edge.workspaceId,
          edge.from.kind,
          edge.from.id,
          edge.to.kind,
          edge.to.id,
          edge.relation,
          edge.state,
          nextVersion,
        );
      }
      const recordedAtIndex = chunk.length * 11 + 1;
      await tx.query(
        `INSERT INTO operating_graph_edges
           (edge_id, agency_id, client_id, workspace_id,
            from_kind, from_id, to_kind, to_id, relation, edge_state,
            edge_version, is_current, recorded_at, recorded_by)
         SELECT id, agency, client, ws, fk, fi, tk, ti, rel, st, ver, true, $${recordedAtIndex}::timestamptz, $${recordedAtIndex + 1}::text
           FROM (VALUES ${values.join(', ')})
             AS t(id, agency, client, ws, fk, fi, tk, ti, rel, st, ver)`,
        [...params, now, recordedBy],
      );
    }

    return {
      edgesAppended: toAppend.length,
      edgesSuperseded: toRetract.length,
      edgesConverged: converged,
    };
  }

  private async loadCurrentEdges(
    tx: DbTransaction,
    clientId: string,
  ): Promise<readonly CurrentEdgeRow[]> {
    const result = await tx.query<{
      edge_id: string;
      from_kind: string;
      from_id: string;
      to_kind: string;
      to_id: string;
      relation: string;
      edge_state: string;
    }>(
      `SELECT edge_id, from_kind, from_id, to_kind, to_id, relation, edge_state
       FROM operating_graph_edges
       WHERE client_id = $1 AND is_current`,
      [clientId],
    );
    return result.rows.map((row) => ({
      edgeId: row.edge_id,
      fromKind: row.from_kind,
      fromId: row.from_id,
      toKind: row.to_kind,
      toId: row.to_id,
      relation: row.relation,
      edgeState: row.edge_state,
    }));
  }

  private async loadMaxVersions(
    tx: DbTransaction,
    clientId: string,
  ): Promise<readonly MaxVersionRow[]> {
    const result = await tx.query<{
      from_kind: string;
      from_id: string;
      to_kind: string;
      to_id: string;
      relation: string;
      max_version: string | number;
    }>(
      `SELECT from_kind, from_id, to_kind, to_id, relation, MAX(edge_version) AS max_version
       FROM operating_graph_edges
       WHERE client_id = $1
       GROUP BY from_kind, from_id, to_kind, to_id, relation`,
      [clientId],
    );
    return result.rows.map((row) => ({
      fromKind: row.from_kind,
      fromId: row.from_id,
      toKind: row.to_kind,
      toId: row.to_id,
      relation: row.relation,
      maxVersion: Number(row.max_version),
    }));
  }

  // -------------------------------------------------------------------------
  // Reads (the view surfaces)
  // -------------------------------------------------------------------------

  /** Every edge ledger row of the Client (current + historical), ordered. */
  async listClientEdgeRows(clientId: string): Promise<readonly GraphEdgeRowInput[]> {
    const result = await this.db.query<EdgeRow>(
      `SELECT edge_id, agency_id, client_id, workspace_id, from_kind, from_id, to_kind, to_id,
              relation, edge_state, edge_version, is_current, recorded_at, recorded_by, superseded_at
       FROM operating_graph_edges
       WHERE client_id = $1
       ORDER BY from_kind, from_id, relation, to_kind, to_id, edge_version`,
      [clientId],
    );
    return result.rows.map(OperatingGraphStore.toEdgeRowInput);
  }

  private static toEdgeRowInput(row: EdgeRow): GraphEdgeRowInput {
    return {
      edgeId: row.edge_id,
      agencyId: row.agency_id,
      clientId: row.client_id,
      workspaceId: row.workspace_id,
      fromKind: row.from_kind as GraphEdgeRowInput['fromKind'],
      fromId: row.from_id,
      toKind: row.to_kind as GraphEdgeRowInput['toKind'],
      toId: row.to_id,
      relation: row.relation as GraphEdgeRowInput['relation'],
      edgeState: row.edge_state as GraphEdgeRowInput['edgeState'],
      edgeVersion: Number(row.edge_version),
      isCurrent: row.is_current,
      recordedAt: new Date(row.recorded_at).toISOString(),
      recordedBy: row.recorded_by,
      supersededAt: row.superseded_at === null ? null : new Date(row.superseded_at).toISOString(),
    };
  }

  /** The registry rows for exactly the given endpoint pairs (chunked IN). */
  async listNodesForEndpoints(
    endpoints: ReadonlyArray<{ readonly kind: string; readonly id: string }>,
  ): Promise<readonly GraphNodeRowInput[]> {
    const distinct = new Map<string, { kind: string; id: string }>();
    for (const endpoint of endpoints) distinct.set(`${endpoint.kind}:${endpoint.id}`, endpoint);
    const list = [...distinct.values()];
    const rows: GraphNodeRowInput[] = [];
    for (let offset = 0; offset < list.length; offset += INSERT_CHUNK) {
      const chunk = list.slice(offset, offset + INSERT_CHUNK);
      const values: string[] = [];
      const params: string[] = [];
      for (const [index, endpoint] of chunk.entries()) {
        const base = index * 2;
        values.push(`($${base + 1}::text, $${base + 2}::uuid)`);
        params.push(endpoint.kind, endpoint.id);
      }
      const result = await this.db.query<NodeRow>(
        `SELECT node_kind, node_id, agency_id, client_id, workspace_id,
                first_seen_at, last_refreshed_at
         FROM operating_graph_nodes
         WHERE (node_kind, node_id) IN (VALUES ${values.join(', ')})`,
        params,
      );
      for (const row of result.rows) {
        rows.push({
          kind: row.node_kind as GraphNodeRowInput['kind'],
          id: row.node_id,
          agencyId: row.agency_id,
          clientId: row.client_id,
          workspaceId: row.workspace_id,
          firstSeenAt: new Date(row.first_seen_at).toISOString(),
          lastRefreshedAt: new Date(row.last_refreshed_at).toISOString(),
        });
      }
    }
    return rows;
  }

  /**
   * The per-Client tallies for the Agency view: current edge counts by
   * relation + distinct node participation, computed in SQL over exactly
   * the given Clients.
   */
  async tallyClientGraphs(
    clientIds: readonly string[],
  ): Promise<{
    readonly relationCounts: ReadonlyMap<string, ReadonlyMap<OperatingGraphEdgeRelation, number>>;
    readonly nodeCounts: ReadonlyMap<string, number>;
    readonly totalDistinctNodes: number;
  }> {
    if (clientIds.length === 0) {
      return { relationCounts: new Map(), nodeCounts: new Map(), totalDistinctNodes: 0 };
    }
    const placeholders = clientIds.map((_, index) => `$${index + 1}`).join(', ');

    const relationResult = await this.db.query<{ client_id: string; relation: string; count: string }>(
      `SELECT client_id, relation, count(*) AS count
       FROM operating_graph_edges
       WHERE client_id IN (${placeholders}) AND is_current
       GROUP BY client_id, relation`,
      [...clientIds],
    );
    const relationCounts = new Map<string, Map<OperatingGraphEdgeRelation, number>>();
    for (const row of relationResult.rows) {
      let perClient = relationCounts.get(row.client_id);
      if (perClient === undefined) {
        perClient = new Map();
        relationCounts.set(row.client_id, perClient);
      }
      perClient.set(row.relation as OperatingGraphEdgeRelation, Number(row.count));
    }

    const nodeResult = await this.db.query<{ client_id: string; count: string }>(
      `SELECT client_id, count(*) AS count FROM (
         SELECT DISTINCT client_id, from_kind AS node_kind, from_id AS node_id
         FROM operating_graph_edges
         WHERE client_id IN (${placeholders}) AND is_current
         UNION
         SELECT DISTINCT client_id, to_kind AS node_kind, to_id AS node_id
         FROM operating_graph_edges
         WHERE client_id IN (${placeholders}) AND is_current
       ) participants GROUP BY client_id`,
      [...clientIds],
    );
    const nodeCounts = new Map<string, number>();
    for (const row of nodeResult.rows) nodeCounts.set(row.client_id, Number(row.count));

    const totalResult = await this.db.query<{ count: string }>(
      `SELECT count(*) AS count FROM (
         SELECT DISTINCT from_kind AS node_kind, from_id AS node_id
         FROM operating_graph_edges
         WHERE client_id IN (${placeholders}) AND is_current
         UNION
         SELECT DISTINCT to_kind AS node_kind, to_id AS node_id
         FROM operating_graph_edges
         WHERE client_id IN (${placeholders}) AND is_current
       ) participants`,
      [...clientIds],
    );

    return {
      relationCounts,
      nodeCounts,
      totalDistinctNodes: Number(totalResult.rows[0]?.count ?? '0'),
    };
  }
}
