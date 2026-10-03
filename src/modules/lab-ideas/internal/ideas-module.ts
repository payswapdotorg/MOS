/**
 * /lab-ideas module implementation (LAB-004 — the Idea Graph).
 *
 * THE ORCHESTRATION ONLY: this module composes the LabIdeasStore
 * (the migration-066 tables) with the PURE contract guards of
 * validation.ts, the frozen novelty + clustering pure functions and
 * the two REPLACEABLE ports (the decomposer + the generator — the
 * LAB-003 extractor-port precedent, wired at the composition root;
 * test doubles satisfy the same contracts).
 *
 * THE DECOMPOSITION PIPELINE (observed primitives — §6):
 *
 *   1. shape gate      — the scope + citation fences (a malformed
 *                        input is the honest whole-call rejection —
 *                        nothing is recorded, never a partial row);
 *   2. scope gate      — the citation's RECORDED owning client must
 *                        match the scope (the recorded-data tenant
 *                        fence — the LAB-003 scope_mismatch gate);
 *   3. identity        — the deterministic input + identity digests
 *                        (pure functions); an identity that already
 *                        exists COMPLETED is the idempotent return
 *                        (the existing decomposition); a RUNNING row
 *                        with the same identity is the honest
 *                        conflict (an incomplete prior attempt —
 *                        direct-DB states are fenced);
 *   4. version chain   — the next decomposition_version on the
 *                        (client, cited bundle) append-only chain
 *                        (the 1000-version bound);
 *   5. the port        — the decomposer runs BEFORE any row exists:
 *                        a port failure leaves NO rows (fail closed,
 *                        nothing fabricated — the atomic-flow
 *                        discipline, DISCLOSED: the born-running
 *                        lifecycle exists at the DB for the future
 *                        long-running decomposition path and is
 *                        guard-proven in the integration battery);
 *   6. THE ATOMIC WRITE (one transaction): the decomposition row is
 *                        born running, the observed nodes + the
 *                        intra-decomposition edges insert (seq
 *                        order), and the single completion advance
 *                        SQL-computes the node/edge counts — a crash
 *                        rolls the whole decomposition back (no
 *                        partial state ever commits).
 *
 * THE OPERATION PIPELINE (derived/generated/combined nodes — §6):
 *
 *   1. shape gate      — the scope + the closed operation fences
 *                        (the per-kind input-count + output-kind
 *                        rules);
 *   2. the inputs      — the cited input nodes load under the
 *                        tenant scope (missing/foreign → the uniform
 *                        NotFound); the per-kind primitive-kind rules
 *                        apply (derive/fill_gap require same-kind
 *                        inputs; the single-input kinds inherit the
 *                        input's kind; recombine carries the
 *                        caller-declared output kind);
 *   3. the generator   — the REPLACEABLE port owns ONLY the content
 *                        generation; the open-ended kinds (mutate/
 *                        analogy/invert) fail closed with the honest
 *                        pending state BEFORE any row exists;
 *   4. the output node — the MODULE owns the origin class (the
 *                        CHECK-fenced kind pairing), the recorded
 *                        lineage (the pure build over the new edges +
 *                        the inputs' own recorded lineages — DATA,
 *                        never resemblance), and the creation-time
 *                        novelty score against the OBSERVED nodes of
 *                        the same kind;
 *   5. THE ATOMIC WRITE (one transaction): the output node first
 *                        (creating_operation_id = the operation id —
 *                        recorded data), then the operation row (the
 *                        output_node_id FK anchor), the input tail
 *                        rows and the lineage edges (each input →
 *                        the output, the operation's relation).
 *
 * THE CLUSTERING RUN: the pure 'lab-idea-clustering-v1' function
 * over the clusterable space (observed + derived) — one run per
 * (client, version): an unchanged node set re-run under the same
 * version is the idempotent return; a changed node set is the honest
 * conflict (re-clustering requires a new version); the run row is
 * born running, the assignments insert, and the completion advance
 * SQL-computes the summary (never asserted separately).
 *
 * THE SCOPE DISCIPLINE (§22): every read resolves foreign/unknown
 * scope to the uniform NotFound (no existence oracle) — exactly the
 * /lab and /lab-features house pattern.
 */

import { ConflictError, InvalidRequestError, NotFoundError } from '../../../platform/errors/errors.ts';
import type {
  ApplyLabIdeaOperationInput,
  LabIdeaDecompositionRecord,
  LabIdeaDecompositionResult,
  LabIdeaDecomposer,
  LabIdeaLineageStep,
  LabIdeaLineageView,
  LabIdeaNodeRecord,
  LabIdeaOperationRecord,
  LabIdeaOriginClass,
  LabIdeaPrimitiveKind,
  LabIdeaProposedEdge,
  LabIdeasModuleApi,
  LabIdeasModuleDeps,
  LabIdeasScope,
} from '../public.ts';
import {
  LAB_IDEA_CLUSTERING_VERSION,
  LAB_IDEA_OPERATION_KIND_OUTPUT_ORIGIN,
  LAB_IDEA_OPERATION_KIND_RELATION,
  LAB_IDEAS_MAX_DECOMPOSITION_VERSIONS,
  LAB_IDEAS_RETRIEVAL_DEFAULT_LIMIT,
} from '../public.ts';
import {
  assertValidLabIdeaBundleReference,
  assertValidLabIdeaDecomposeInput,
  assertValidLabIdeaDecomposerDeclaration,
  assertValidLabIdeaOperationInput,
  assertValidLabIdeaProposedEdges,
  assertValidLabIdeaProposedNodes,
  assertValidLabIdeaRetrievalInput,
  assertValidLabIdeasScope,
  computeLabIdeaIdentityDigest,
  computeLabIdeaInputDigest,
} from './validation.ts';
import { buildLabIdeaLineage, computeLabIdeaNovelty } from './novelty.ts';
import { assertValidLabIdeaLineage } from './novelty.ts';
import { clusterLabIdeaNodes } from './clustering.ts';
import {
  LabIdeasStore,
  mapClusterAssignmentRow,
  mapClusterRunRow,
  mapDecompositionRow,
  mapEdgeRow,
  mapNodeRow,
  mapOperationRow,
  type NodeRow,
} from './ideas-store.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERATOR_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The decoded keyset cursor payload. */
interface CursorPayload {
  createdAt: string;
  nodeId: string;
}

/** Encodes the opaque keyset cursor (base64url of the JSON {c: isoTimestamp, n: nodeId} — pure-ASCII payload). */
function encodeCursor(row: LabIdeaNodeRecord): string {
  return btoa(JSON.stringify({ c: row.createdAt, n: row.nodeId }))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

/** Decodes + validates the opaque keyset cursor (malformed = the honest invalid request). */
function decodeCursor(cursor: string): CursorPayload {
  let parsed: { c?: unknown; n?: unknown };
  try {
    parsed = JSON.parse(atob(cursor.replaceAll('-', '+').replaceAll('_', '/'))) as { c?: unknown; n?: unknown };
  } catch {
    throw new InvalidRequestError('cursor must be the opaque keyset cursor from a previous page');
  }
  if (typeof parsed.c !== 'string' || typeof parsed.n !== 'string' || !UUID_PATTERN.test(parsed.n)) {
    throw new InvalidRequestError('cursor must be the opaque keyset cursor from a previous page');
  }
  const createdAt = Date.parse(parsed.c);
  if (Number.isNaN(createdAt)) {
    throw new InvalidRequestError('cursor must be the opaque keyset cursor from a previous page');
  }
  return { createdAt: parsed.c, nodeId: parsed.n };
}

export function createLabIdeasModule(deps: LabIdeasModuleDeps): LabIdeasModuleApi {
  // The port declarations are validated ONCE at wiring time (fail
  // fast): the pinned idea-set version + the shaped identities.
  assertValidLabIdeaDecomposerDeclaration(deps.decomposer);
  const decomposer: LabIdeaDecomposer = deps.decomposer;
  const generator = deps.generator;
  if (generator === null || typeof generator !== 'object' || typeof generator.generate !== 'function') {
    throw new InvalidRequestError('deps.generator must be a LabIdeaGeneratorPort');
  }
  if (typeof generator.generatorId !== 'string' || !GENERATOR_ID_PATTERN.test(generator.generatorId)) {
    throw new InvalidRequestError('deps.generator.generatorId must be 1-64 chars of [a-z0-9-]');
  }
  if (typeof generator.generatorVersion !== 'string' || generator.generatorVersion.length < 1 || generator.generatorVersion.length > 64) {
    throw new InvalidRequestError('deps.generator.generatorVersion must be 1-64 chars');
  }

  const store = new LabIdeasStore(deps.db, deps.clock, deps.ids);

  /** Runs the body against a transaction-bound store. */
  const withTx = <T>(body: (txStore: LabIdeasStore) => Promise<T>): Promise<T> =>
    deps.db.transaction((tx) => body(new LabIdeasStore(tx, deps.clock, deps.ids)));

  const requireNode = async (scope: LabIdeasScope, nodeId: string): Promise<NodeRow> => {
    if (!UUID_PATTERN.test(String(nodeId))) {
      throw new NotFoundError('lab idea node', String(nodeId));
    }
    const row = await store.findNode(scope.clientId, nodeId);
    if (row === null) {
      throw new NotFoundError('lab idea node', nodeId);
    }
    return row;
  };

  const readDecomposition = async (clientId: string, row: Parameters<typeof mapDecompositionRow>[0]): Promise<LabIdeaDecompositionRecord> => {
    const nodeRows = await store.listNodesByDecomposition(row.decomposition_id);
    const edgeRows = await store.listEdgesByDecomposition(row.decomposition_id);
    return mapDecompositionRow(row, nodeRows.map(mapNodeRow), edgeRows.map(mapEdgeRow));
  };

  const readOperation = async (scope: LabIdeasScope, operationId: string): Promise<LabIdeaOperationRecord> => {
    const row = await store.findOperation(scope.clientId, operationId);
    if (row === null) {
      throw new NotFoundError('lab idea operation', operationId);
    }
    const inputRows = await store.listOperationInputs(operationId);
    const outputRow = await store.findNode(scope.clientId, row.output_node_id);
    return mapOperationRow(
      row,
      inputRows.map((inputRow) => inputRow.node_id),
      outputRow === null ? null : mapNodeRow(outputRow),
    );
  };

  const readClusterRun = async (scope: LabIdeasScope, runId: string): Promise<ReturnType<typeof mapClusterRunRow>> => {
    const row = await store.findClusterRun(scope.clientId, runId);
    if (row === null) {
      throw new NotFoundError('lab idea cluster run', runId);
    }
    const assignmentRows = await store.listClusterAssignments(runId);
    return mapClusterRunRow(row, assignmentRows.map(mapClusterAssignmentRow));
  };

  return {
    async decompose(input) {
      assertValidLabIdeaDecomposeInput(input);
      const scope = input.scope;
      const citation = input.citation;

      // (2) the scope gate — the citation's RECORDED owning client
      // must match (the recorded-data tenant fence).
      if (citation.clientId !== scope.clientId) {
        throw new InvalidRequestError(
          `the citation's recorded owning client ${citation.clientId} does not match the decomposition scope client ${scope.clientId}`,
        );
      }

      // (3) the deterministic identity (pure functions) + the
      // idempotence probe.
      const inputDigest = computeLabIdeaInputDigest({ citation });
      const identityDigest = computeLabIdeaIdentityDigest({
        bundleIdentity: {
          bundleId: citation.bundleId,
          bundleReference: citation.bundleReference,
          bundleVersion: citation.bundleVersion,
          referenceId: citation.referenceId,
          corpusId: citation.corpusId,
          corpusVersion: citation.corpusVersion,
          provider: citation.provider,
          providerContentId: citation.providerContentId,
          canonicalUrl: citation.canonicalUrl,
          metadataDigest: citation.metadataDigest,
          featureSetVersion: citation.featureSetVersion,
          extractorId: citation.extractorId,
          extractorVersion: citation.extractorVersion,
          bundleIdentityDigest: citation.bundleIdentityDigest,
        },
        ideaSetVersion: decomposer.ideaSetVersion,
        decomposerIdentity: { decomposerId: decomposer.decomposerId, decomposerVersion: decomposer.decomposerVersion },
        inputDigest,
      });
      const existing = await store.findDecompositionByIdentity(scope.clientId, identityDigest);
      if (existing !== null && existing.status === 'completed') {
        // The idempotent return — the same deterministic identity is
        // the same decomposition, ever.
        return readDecomposition(scope.clientId, existing);
      }
      if (existing !== null && existing.status === 'running') {
        throw new ConflictError(
          `a prior decomposition attempt for the cited bundle ${citation.bundleReference} under these versions is incomplete (decomposition ${existing.decomposition_id} stays running) — the honest conflict; re-drive under a NEW decomposer/idea-set version`,
        );
      }

      // (4) the version chain — the next version on the (client,
      // cited bundle) append-only chain.
      const latest = await store.findLatestDecompositionVersion(scope.clientId, citation.bundleId);
      const nextVersion = (latest === null ? 0 : Number(latest.decomposition_version)) + 1;
      if (nextVersion > LAB_IDEAS_MAX_DECOMPOSITION_VERSIONS) {
        throw new InvalidRequestError(
          `the per-cited-bundle decomposition chain for ${citation.bundleReference} reached the ${LAB_IDEAS_MAX_DECOMPOSITION_VERSIONS}-version bound`,
        );
      }

      // (5) THE PORT — runs BEFORE any row exists: a port failure
      // leaves NO rows (fail closed, never fabricated).
      let result: LabIdeaDecompositionResult;
      try {
        const outcome = await decomposer.decompose({ citation });
        if ('reason' in outcome && outcome.reason !== undefined) {
          throw new InvalidRequestError(`the decomposer refused the citation: ${outcome.detail}`);
        }
        result = outcome as LabIdeaDecompositionResult;
      } catch (error) {
        if (error instanceof InvalidRequestError && error.message.startsWith('the decomposer refused the citation:')) {
          throw error;
        }
        throw new InvalidRequestError(
          `the decomposer failed on the cited bundle ${citation.bundleReference}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      // The port result fences: the closed primitive vocabulary, the
      // bounded descriptors/attributes, the closed relation
      // vocabulary + the in-range node indices.
      const proposedNodes = result.nodes ?? [];
      const proposedEdges = result.edges ?? [];
      assertValidLabIdeaProposedNodes(proposedNodes);
      assertValidLabIdeaProposedEdges(proposedEdges, proposedNodes.length);

      // (6) THE ATOMIC WRITE (one transaction): born running → the
      // nodes + edges → the single completion advance with the
      // counts SQL-computed.
      const decompositionId = store.newId();
      const inserted = await withTx(async (txStore) => {
        await txStore.insertDecomposition({
          decompositionId,
          decompositionVersion: nextVersion,
          scope,
          citation,
          decomposerId: decomposer.decomposerId,
          decomposerVersion: decomposer.decomposerVersion,
          identityDigest,
          inputDigest,
        });
        // The inserted node ids in proposed order (the position-stable
        // tail the proposed edges reference).
        const insertedNodeIds: string[] = [];
        let seq = 0;
        for (const proposed of proposedNodes) {
          seq += 1;
          const nodeId = txStore.newId();
          insertedNodeIds.push(nodeId);
          await txStore.insertNode({
            nodeId,
            scope,
            primitiveKind: proposed.primitiveKind,
            originClass: 'observed_source',
            descriptor: proposed.descriptor,
            attributes: proposed.attributes ?? {},
            decompositionId,
            citedBundleReference: citation.bundleReference,
            creatingOperationId: null,
            creatingOperationKind: null,
            lineage: null,
            noveltyScore: null,
            seq,
          });
        }
        let edgeSeq = 0;
        for (const proposed of proposedEdges as ReadonlyArray<LabIdeaProposedEdge>) {
          edgeSeq += 1;
          // The proposed edge references 1-based node positions in the
          // proposed list — resolve to the inserted node ids through
          // the same order (the fences already pinned the range).
          const fromNodeId = insertedNodeIds[proposed.fromSeq - 1];
          const toNodeId = insertedNodeIds[proposed.toSeq - 1];
          if (fromNodeId === undefined || toNodeId === undefined) {
            throw new InvalidRequestError('the proposed edge references an unknown inserted node');
          }
          await txStore.insertEdge({
            edgeId: txStore.newId(),
            scope,
            fromNodeId,
            toNodeId,
            relation: proposed.relation,
            decompositionId,
            operationId: null,
            seq: edgeSeq,
          });
        }
        const completed = await txStore.completeDecomposition(decompositionId);
        if (completed === null) {
          throw new InvalidRequestError('the decomposition completion advance failed');
        }
        return completed;
      });
      void inserted;

      return readDecomposition(scope.clientId, await mustFind(store, scope, decompositionId));
    },

    async getDecomposition(scope, decompositionId) {
      assertValidLabIdeasScope(scope);
      if (!UUID_PATTERN.test(String(decompositionId))) {
        throw new NotFoundError('lab idea decomposition', String(decompositionId));
      }
      const row = await store.findDecomposition(scope.clientId, decompositionId);
      if (row === null) {
        throw new NotFoundError('lab idea decomposition', decompositionId);
      }
      return readDecomposition(scope.clientId, row);
    },

    async listDecompositions(scope, citedBundleReference) {
      assertValidLabIdeasScope(scope);
      if (citedBundleReference !== undefined && citedBundleReference !== null && citedBundleReference !== '') {
        assertValidLabIdeaBundleReference(citedBundleReference);
      }
      const rows = await store.listDecompositions(scope.clientId, citedBundleReference);
      const records: LabIdeaDecompositionRecord[] = [];
      for (const row of rows) {
        records.push(await readDecomposition(scope.clientId, row));
      }
      return records;
    },

    async getNode(scope, nodeId) {
      assertValidLabIdeasScope(scope);
      const row = await requireNode(scope, nodeId);
      return mapNodeRow(row);
    },

    async retrieveNodes(input) {
      assertValidLabIdeasScope(input.scope);
      assertValidLabIdeaRetrievalInput(input);
      const limit = input.limit ?? LAB_IDEAS_RETRIEVAL_DEFAULT_LIMIT;
      const cursor = input.cursor === undefined || input.cursor === null || input.cursor === '' ? null : decodeCursor(input.cursor);
      const rows = await store.retrieveNodes({
        clientId: input.scope.clientId,
        originClasses: [...input.originClasses],
        primitiveKinds: input.primitiveKinds === undefined || input.primitiveKinds === null ? undefined : [...input.primitiveKinds],
        citedBundleReference: input.citedBundleReference === '' ? undefined : input.citedBundleReference,
        citedReferenceId: input.citedReferenceId === '' ? undefined : input.citedReferenceId,
        limit,
        cursor: cursor === null ? null : { createdAt: cursor.createdAt, nodeId: cursor.nodeId },
      });
      // The keyset page: fetch limit+1, return limit, the cursor rides
      // the last returned row.
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const nodes = page.map(mapNodeRow);
      const nextCursor = hasMore && page.length > 0 ? encodeCursor(nodes[nodes.length - 1]!) : null;
      return { nodes, nextCursor };
    },

    async getNodeLineage(scope, nodeId) {
      assertValidLabIdeasScope(scope);
      const row = await requireNode(scope, nodeId);
      const node = mapNodeRow(row);
      if (node.originClass === 'observed_source') {
        // The honest empty state: an observed node IS its own
        // grounding — no recorded chain exists.
        return { node, lineage: null, ancestors: [], observedAncestorIds: [] };
      }
      const lineage = node.lineage ?? [];
      assertValidLabIdeaLineage(lineage);
      // The bounded read: resolve the distinct node ids in the
      // recorded chain (first-appearance order), excluding the node
      // itself.
      const orderedIds: string[] = [];
      const seen = new Set<string>([node.nodeId]);
      for (const step of lineage) {
        for (const id of [step.fromNodeId, step.toNodeId]) {
          if (!seen.has(id)) {
            seen.add(id);
            orderedIds.push(id);
          }
        }
      }
      const ancestorRows = orderedIds.length === 0 ? [] : await store.nodesByIds(scope.clientId, orderedIds);
      const byId = new Map(ancestorRows.map((ancestorRow) => [ancestorRow.node_id, mapNodeRow(ancestorRow)]));
      const ancestors = orderedIds
        .map((id) => byId.get(id))
        .filter((ancestor): ancestor is LabIdeaNodeRecord => ancestor !== undefined);
      const observedAncestorIds = ancestors
        .filter((ancestor) => ancestor.originClass === 'observed_source')
        .map((ancestor) => ancestor.nodeId);
      const view: LabIdeaLineageView = { node, lineage, ancestors, observedAncestorIds };
      return view;
    },

    async applyOperation(input: ApplyLabIdeaOperationInput) {
      assertValidLabIdeasScope(input.scope);
      assertValidLabIdeaOperationInput(input);
      const scope = input.scope;

      // (2) the inputs — the cited nodes load under the tenant scope.
      const inputRows = await store.nodesByIds(scope.clientId, [...input.inputNodeIds]);
      if (inputRows.length !== input.inputNodeIds.length) {
        const found = new Set(inputRows.map((row) => row.node_id));
        const missing = input.inputNodeIds.find((nodeId) => !found.has(nodeId));
        throw new NotFoundError('lab idea node', String(missing));
      }
      const byId = new Map(inputRows.map((row) => [row.node_id, row]));
      const inputNodes = input.inputNodeIds.map((nodeId) => mapNodeRow(byId.get(nodeId)!));

      // (3) the per-kind primitive-kind rules: derive/fill_gap
      // require SAME-KIND inputs (the abstraction/gap lives in one
      // primitive space); the single-input kinds inherit the input's
      // kind; recombine carries the caller-declared output kind.
      const sameKindRequired = input.operationKind === 'derive' || input.operationKind === 'fill_gap';
      let outputPrimitiveKind: LabIdeaPrimitiveKind;
      if (input.operationKind === 'recombine') {
        outputPrimitiveKind = input.outputPrimitiveKind!;
      } else if (sameKindRequired) {
        const firstKind = inputNodes[0]!.primitiveKind;
        const mixed = inputNodes.find((candidate) => candidate.primitiveKind !== firstKind);
        if (mixed !== undefined) {
          throw new InvalidRequestError(
            `operationKind '${input.operationKind}' requires same-primitive-kind inputs ('${firstKind}' vs '${mixed.primitiveKind}') — the abstraction/gap lives in one primitive space`,
          );
        }
        outputPrimitiveKind = firstKind;
      } else {
        outputPrimitiveKind = inputNodes[0]!.primitiveKind;
      }

      // (4) THE GENERATOR — the replaceable content seam. The
      // open-ended kinds fail closed with the honest pending state
      // BEFORE any row exists.
      const generation = await generator.generate({ operationKind: input.operationKind, inputNodes });
      if (generation.status === 'pending') {
        throw new InvalidRequestError(
          `the operation failed closed: ${generation.reason} — nothing was recorded (the honest pending state)`,
        );
      }

      const outputOriginClass: LabIdeaOriginClass = LAB_IDEA_OPERATION_KIND_OUTPUT_ORIGIN[input.operationKind];
      const relation = LAB_IDEA_OPERATION_KIND_RELATION[input.operationKind];
      const outputNodeId = store.newId();
      const operationId = store.newId();

      // The creation-time novelty score against the OBSERVED nodes of
      // the same kind (the frozen formula — observed ONLY, never
      // other generated nodes).
      const observedRows = await store.listObservedNodesByKind(scope.clientId, outputPrimitiveKind);
      const novelty = computeLabIdeaNovelty(
        { primitiveKind: outputPrimitiveKind, descriptor: generation.descriptor },
        observedRows.map((observedRow) => ({ nodeId: observedRow.node_id, descriptor: observedRow.descriptor })),
      );

      // The recorded lineage: the new edges + the inputs' own
      // recorded lineages (DATA, never resemblance).
      const lineage = buildLabIdeaLineage({
        outputNodeId,
        relation,
        inputNodeIds: [...input.inputNodeIds],
        inputLineages: inputNodes.map((candidate) => candidate.lineage),
      });

      // (5) THE ATOMIC WRITE: the output node first
      // (creating_operation_id = the operation id — recorded data),
      // then the operation row (the output_node_id FK anchor), the
      // input tail and the lineage edges.
      await withTx(async (txStore) => {
        await txStore.insertNode({
          nodeId: outputNodeId,
          scope,
          primitiveKind: outputPrimitiveKind,
          originClass: outputOriginClass,
          descriptor: generation.descriptor,
          attributes: generation.attributes ?? {},
          decompositionId: null,
          citedBundleReference: null,
          creatingOperationId: operationId,
          creatingOperationKind: input.operationKind,
          lineage: lineage as ReadonlyArray<LabIdeaLineageStep>,
          noveltyScore: novelty.noveltyScore,
          seq: 1,
        });
        await txStore.insertOperation({
          operationId,
          scope,
          operationKind: input.operationKind,
          outputNodeId,
          outputOriginClass,
          generatorId: generator.generatorId,
          generatorVersion: generator.generatorVersion,
        });
        let seq = 0;
        for (const nodeId of input.inputNodeIds) {
          seq += 1;
          await txStore.insertOperationInput({
            inputId: txStore.newId(),
            operationId,
            scope,
            nodeId,
            seq,
          });
        }
        let edgeSeq = 0;
        for (const nodeId of input.inputNodeIds) {
          edgeSeq += 1;
          await txStore.insertEdge({
            edgeId: txStore.newId(),
            scope,
            fromNodeId: nodeId,
            toNodeId: outputNodeId,
            relation,
            decompositionId: null,
            operationId,
            seq: edgeSeq,
          });
        }
      });

      return readOperation(scope, operationId);
    },

    async getOperation(scope, operationId) {
      assertValidLabIdeasScope(scope);
      if (!UUID_PATTERN.test(String(operationId))) {
        throw new NotFoundError('lab idea operation', String(operationId));
      }
      return readOperation(scope, operationId);
    },

    async measureNovelty(scope, candidate) {
      assertValidLabIdeasScope(scope);
      if (candidate === null || typeof candidate !== 'object') {
        throw new InvalidRequestError('candidate must be an object');
      }
      assertValidLabIdeaRetrievalInput({
        scope,
        originClasses: ['observed_source'],
        primitiveKinds: [candidate.primitiveKind],
      });
      if (typeof candidate.descriptor !== 'string' || candidate.descriptor.trim().length < 1 || candidate.descriptor.length > 512) {
        throw new InvalidRequestError('candidate.descriptor must be a trimmed string of 1-512 chars');
      }
      // Measured against OBSERVED nodes of the same kind ONLY (never
      // other generated nodes) — the deterministic comparison order
      // is node_id ascending.
      const observedRows = await store.listObservedNodesByKind(scope.clientId, candidate.primitiveKind);
      return computeLabIdeaNovelty(
        { primitiveKind: candidate.primitiveKind, descriptor: candidate.descriptor },
        observedRows.map((observedRow) => ({ nodeId: observedRow.node_id, descriptor: observedRow.descriptor })),
      );
    },

    async runClustering(scope) {
      assertValidLabIdeasScope(scope);

      // The pure frozen clustering over the clusterable space
      // (observed + derived — the evidence-bearing space).
      const clusterableRows = await store.listClusterableNodes(scope.clientId);
      const computed = clusterLabIdeaNodes(
        clusterableRows.map((row) => ({
          nodeId: row.node_id,
          primitiveKind: row.primitive_kind as LabIdeaPrimitiveKind,
          originClass: row.origin_class as LabIdeaOriginClass,
          descriptor: row.descriptor,
        })),
      );

      // The one-run-per-version discipline: an unchanged node set
      // re-run under the same version is the idempotent return; a
      // changed node set is the honest conflict (re-clustering
      // requires a new version).
      const existing = await store.findClusterRunByVersion(scope.clientId, LAB_IDEA_CLUSTERING_VERSION);
      if (existing !== null) {
        if (existing.status === 'running') {
          throw new ConflictError(
            `a prior clustering run for version ${LAB_IDEA_CLUSTERING_VERSION} is incomplete (run ${existing.run_id} stays running) — the honest conflict`,
          );
        }
        const existingAssignments = await store.listClusterAssignments(existing.run_id);
        const sameSet =
          existingAssignments.length === computed.length &&
          existingAssignments.every((assignment) => {
            const match = computed.find((candidate) => candidate.nodeId === assignment.node_id);
            return (
              match !== undefined &&
              match.clusterKey === assignment.cluster_key &&
              match.clusterSize === Number(assignment.cluster_size)
            );
          });
        if (sameSet) {
          return readClusterRun(scope, existing.run_id);
        }
        throw new ConflictError(
          `the clusterable node set changed under clustering version ${LAB_IDEA_CLUSTERING_VERSION} — re-clustering requires a new clustering version (the assignments are append-only records carrying the version; never in-place rewrites)`,
        );
      }

      // The atomic write: born running → the assignments → the
      // completion advance with the summary SQL-computed.
      const runId = store.newId();
      await withTx(async (txStore) => {
        await txStore.insertClusterRun({ runId, scope, clusterVersion: LAB_IDEA_CLUSTERING_VERSION });
        for (const assignment of computed) {
          await txStore.insertClusterAssignment({
            assignmentId: txStore.newId(),
            runId,
            scope,
            nodeId: assignment.nodeId,
            clusterKey: assignment.clusterKey,
            primitiveKind: assignment.primitiveKind,
            clusterSize: assignment.clusterSize,
          });
        }
        const completed = await txStore.completeClusterRun(runId);
        if (completed === null) {
          throw new InvalidRequestError('the clustering completion advance failed');
        }
      });

      return readClusterRun(scope, runId);
    },

    async getClusterRun(scope, runId) {
      assertValidLabIdeasScope(scope);
      if (!UUID_PATTERN.test(String(runId))) {
        throw new NotFoundError('lab idea cluster run', String(runId));
      }
      return readClusterRun(scope, runId);
    },
  };
}

/** Resolves the just-inserted decomposition row (the read-back for the return record). */
async function mustFind(store: LabIdeasStore, scope: LabIdeasScope, decompositionId: string): Promise<Parameters<typeof mapDecompositionRow>[0]> {
  const row = await store.findDecomposition(scope.clientId, decompositionId);
  if (row === null) {
    throw new NotFoundError('lab idea decomposition', decompositionId);
  }
  return row;
}
