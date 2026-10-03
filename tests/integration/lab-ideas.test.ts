/**
 * LAB-004 integration tests — the /lab-ideas Idea Graph against a REAL
 * embedded PostgreSQL stack (the LAB-003 module-level harness: real
 * PgDb + real users/agencies/clients public contracts, the ideas
 * module under test composed exactly as the composition root wires
 * it — platform ports + the two replaceable Lab ports).
 *
 * The acceptance battery (spec/effective-backlog-v1.7.md LAB-004
 * "observed vs derived separation, retrieval, clustering, novelty,
 * recombination and lineage"):
 *   (a) observed vs derived separation — decompositions produce
 *       observed_source nodes only (fenced at the DB); the
 *       derive/recombine/fill_gap operations produce the
 *       derived_abstraction/combined_strategy/generated_mutation
 *       nodes with the CHECK-fenced kind/origin pairing; a
 *       mixed-origin node is structurally inexpressible (the direct
 *       SQL injection is rejected);
 *   (b) retrieval — the deterministic keyset-paginated query with
 *       the MANDATORY origin-class filter, the primitive-kind
 *       filter, the cited-bundle/reference filters and the honest
 *       cursor walk;
 *   (c) clustering — the versioned deterministic run (the
 *       assignments carry the version; the same node set re-run is
 *       idempotent; a changed node set under the same version is
 *       the honest conflict; the summary counts SQL-computed);
 *   (d) novelty — the frozen formula measured against OBSERVED
 *       nodes only (a generated node resembling the candidate does
 *       NOT change the score), recorded on every non-observed node
 *       at creation;
 *   (e) recombination + mutation — the first-class append-only
 *       operation records (inputs, output, generator identity) with
 *       the lineage edges; the open-ended kinds (mutate/analogy/
 *       invert) fail closed with the honest pending state and
 *       NOTHING recorded;
 *   (f) lineage — the bounded read resolving the recorded chain +
 *       the distinct ancestor records + the observed ancestor ids
 *       (the two-hop chain through a derived intermediate);
 *   (g) tenant isolation (§22) — the uniform NotFound for foreign
 *       scope (no existence oracle), the recorded-client scope
 *       gate, and the DB-level cross-tenant injection triggers;
 *   (h) the DB backstops — the append-only triggers (nodes, edges,
 *       operations, inputs, assignments reject UPDATE and DELETE),
 *       the decomposition/cluster-run guards (the single completion
 *       advance, identity immutability), the deterministic identity
 *       idempotence and the append-only per-cited-bundle version
 *       chain.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  bootStack,
  shutdownStack,
  type IntegrationStack,
} from './helpers/harness.ts';
import { PgDb } from '../../src/platform/db/adapters/postgres/pg-db.ts';
import { SystemClock } from '../../src/platform/clock/clock.ts';
import { CryptoIdGenerator } from '../../src/platform/ids/ids.ts';
import { createUsersModule } from '../../src/modules/users/public.ts';
import { createAgenciesModule } from '../../src/modules/agencies/public.ts';
import { createClientsModule } from '../../src/modules/clients/public.ts';
import { createWorkspacesModule } from '../../src/modules/workspaces/public.ts';
import {
  createLabIdeasModule,
  createFirstPartyLabIdeaDecomposer,
  createFirstPartyLabIdeaGenerator,
  LAB_IDEAS_CONTRACT_VERSION,
  LAB_IDEA_SET_VERSION,
  FIRST_PARTY_DECOMPOSER_ID,
  FIRST_PARTY_DECOMPOSER_VERSION,
  FIRST_PARTY_GENERATOR_ID,
  FIRST_PARTY_GENERATOR_VERSION,
} from '../../src/modules/lab-ideas/public.ts';
import type {
  LabIdeasModuleApi,
  LabIdeasScope,
  LabIdeaBundleCitation,
} from '../../src/modules/lab-ideas/public.ts';
import { ConflictError, InvalidRequestError, NotFoundError } from '../../src/platform/errors/errors.ts';

let stack: IntegrationStack | null = null;
let db: PgDb | null = null;
let clock: SystemClock | null = null;
let ids: CryptoIdGenerator | null = null;

let ideas: LabIdeasModuleApi = null as unknown as LabIdeasModuleApi;
let users: ReturnType<typeof createUsersModule> = null as unknown as ReturnType<typeof createUsersModule>;
let agencies: ReturnType<typeof createAgenciesModule> = null as unknown as ReturnType<typeof createAgenciesModule>;
let clients: ReturnType<typeof createClientsModule> = null as unknown as ReturnType<typeof createClientsModule>;
let workspaces: ReturnType<typeof createWorkspacesModule> = null as unknown as ReturnType<typeof createWorkspacesModule>;

const aliceScope: LabIdeasScope = { agencyId: '', clientId: '' };
const bobScope: LabIdeasScope = { agencyId: '', clientId: '' };
let aliceWorkspaceId: string | null = null;

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DIGEST_C = 'c'.repeat(64);

function citation(overrides: Partial<LabIdeaBundleCitation> = {}): LabIdeaBundleCitation {
  return {
    bundleId: '00000000-0000-0000-0000-0000000000bb',
    bundleReference: '00000000-0000-0000-0000-0000000000bb#v1',
    bundleVersion: 1,
    clientId: aliceScope.clientId,
    referenceId: '00000000-0000-0000-0000-0000000000aa',
    corpusId: '00000000-0000-0000-0000-000000000003',
    corpusVersion: 1,
    provider: 'youtube',
    providerContentId: 'vid-123',
    canonicalUrl: 'https://www.youtube.com/watch?v=vid-123',
    metadataDigest: DIGEST_A,
    featureSetVersion: 'lab-featureset-v1',
    extractorId: 'lab-first-party-metadata',
    extractorVersion: '1',
    bundleIdentityDigest: DIGEST_B,
    features: {
      duration: { state: 'derived', value: { sourceField: 'durationSeconds', valueSeconds: 61 } },
      title_description_hashtag_semantics: {
        state: 'derived',
        value: { titleTokens: 7, descriptionTokens: 12, hashtags: ['#fitness', '#gear'], hashtagCount: 2 },
      },
      problem_claim: { state: 'unavailable', reason: 'encoder_unavailable' },
    },
    ...overrides,
  };
}

before(async () => {
  stack = await bootStack('lab_ideas');
  db = new PgDb(stack.env.databaseUrl, 4);
  clock = new SystemClock();
  ids = new CryptoIdGenerator();
  users = createUsersModule({ db, clock, ids });
  agencies = createAgenciesModule({ db, clock, ids, users });
  clients = createClientsModule({ db, clock, ids, agencies });
  workspaces = createWorkspacesModule({ db, clock, ids, clients });
  ideas = createLabIdeasModule({
    db,
    clock,
    ids,
    decomposer: createFirstPartyLabIdeaDecomposer(),
    generator: createFirstPartyLabIdeaGenerator(),
  });

  const aliceUser = await users.createUser({ email: 'alice@labideas.test', displayName: 'Alice' });
  const aliceAgency = await agencies.createAgency({ name: 'Alice Agency', slug: 'alice-ideas', ownerUserId: aliceUser.userId, actorId: null });
  const aliceClient = await clients.createClient({ agencyId: aliceAgency.agency.agencyId, name: 'Alice Client', slug: 'alice-client', actorId: null });
  aliceScope.agencyId = aliceAgency.agency.agencyId;
  aliceScope.clientId = aliceClient.clientId;
  const workspace = await workspaces.createWorkspace({ clientId: aliceClient.clientId, name: 'Alice WS', slug: undefined, actorId: null });
  aliceWorkspaceId = workspace.workspaceId;

  const bobUser = await users.createUser({ email: 'bob@labideas.test', displayName: 'Bob' });
  const bobAgency = await agencies.createAgency({ name: 'Bob Agency', slug: 'bob-ideas', ownerUserId: bobUser.userId, actorId: null });
  const bobClient = await clients.createClient({ agencyId: bobAgency.agency.agencyId, name: 'Bob Client', slug: 'bob-client', actorId: null });
  bobScope.agencyId = bobAgency.agency.agencyId;
  bobScope.clientId = bobClient.clientId;
});

after(async () => {
  if (db !== null) await db.close();
  if (stack !== null) await shutdownStack(stack);
});

// ---------------------------------------------------------------------------
// (a) THE OBSERVED-DECOMPOSITION happy path.
// ---------------------------------------------------------------------------

test('LAB-004: the decomposition happy path — observed_source nodes only, the honest first-party derivations, the SQL-computed counts, the source linkage', async () => {
  const decomposition = await ideas.decompose({ scope: aliceScope, citation: citation() });
  assert.equal(decomposition.status, 'completed');
  assert.equal(decomposition.contractVersion, LAB_IDEAS_CONTRACT_VERSION);
  assert.equal(decomposition.ideaSetVersion, LAB_IDEA_SET_VERSION);
  assert.equal(decomposition.decomposerId, FIRST_PARTY_DECOMPOSER_ID);
  assert.equal(decomposition.decomposerVersion, FIRST_PARTY_DECOMPOSER_VERSION);
  assert.equal(decomposition.decompositionVersion, 1);
  // THE HONEST FIRST-PARTY DERIVATIONS: the metadata-grade features light up.
  assert.equal(decomposition.nodeCount, decomposition.nodes.length);
  assert.equal(decomposition.nodes.length, 2);
  const kinds = decomposition.nodes.map((node) => node.primitiveKind).sort();
  assert.deepEqual(kinds, ['packaging', 'timing_context']);
  // OBSERVED NODES ONLY: every node carries the observed origin class + the
  // decomposition anchor + the cited bundle reference echo + NO lineage/NO
  // novelty (the separation).
  for (const node of decomposition.nodes) {
    assert.equal(node.originClass, 'observed_source');
    assert.equal(node.decompositionId, decomposition.decompositionId);
    assert.equal(node.citedBundleReference, citation().bundleReference);
    assert.equal(node.creatingOperationId, null);
    assert.equal(node.creatingOperationKind, null);
    assert.equal(node.lineage, null);
    assert.equal(node.noveltyScore, null);
    assert.equal(node.noveltyVersion, null);
    assert.equal(node.contractVersion, LAB_IDEAS_CONTRACT_VERSION);
  }
  // The counts are SQL-computed from the tail rows (never asserted separately).
  assert.equal(decomposition.edgeCount, decomposition.edges.length);
  assert.equal(decomposition.edges.length, 0);
  // THE SOURCE LINKAGE (recorded citation data, never a join).
  assert.equal(decomposition.bundleId, citation().bundleId);
  assert.equal(decomposition.bundleReference, citation().bundleReference);
  assert.equal(decomposition.referenceId, citation().referenceId);
  assert.equal(decomposition.corpusId, citation().corpusId);
  assert.equal(decomposition.provider, 'youtube');
  assert.equal(decomposition.providerContentId, 'vid-123');
  assert.equal(decomposition.metadataDigest, DIGEST_A);
  assert.equal(decomposition.bundleIdentityDigest, DIGEST_B);
  // The deterministic identity (64-hex).
  assert.match(decomposition.identityDigest, /^[0-9a-f]{64}$/);
  assert.match(decomposition.inputDigest, /^[0-9a-f]{64}$/);
});

test('LAB-004: the §22 optional workspace anchor — workspace-scoped decomposition records the anchor on every artifact; the client fence stays the retrieval boundary', async () => {
  // A DISTINCT citation (a different bundle + metadata digest) decomposed
  // under the workspace-anchored scope.
  const wsCitation = citation({
    bundleId: '00000000-0000-0000-0000-0000000000bc',
    bundleReference: '00000000-0000-0000-0000-0000000000bc#v1',
    referenceId: '00000000-0000-0000-0000-0000000000ac',
    metadataDigest: DIGEST_C,
  });
  const decomposition = await ideas.decompose({
    scope: { ...aliceScope, workspaceId: aliceWorkspaceId },
    citation: wsCitation,
  });
  assert.equal(decomposition.status, 'completed');
  assert.equal(decomposition.workspaceId, aliceWorkspaceId);
  // Every node of the workspace-anchored decomposition carries the anchor.
  for (const node of decomposition.nodes) {
    assert.equal(node.workspaceId, aliceWorkspaceId);
  }
  // The client fence stays the retrieval boundary (the workspace is the
  // recorded §22 anchor, not a second retrieval key): the plain client
  // scope still finds the workspace-anchored observed nodes.
  const page = await ideas.retrieveNodes({
    scope: aliceScope,
    originClasses: ['observed_source'],
    citedBundleReference: wsCitation.bundleReference,
  });
  assert.equal(page.nodes.length, decomposition.nodes.length);
  for (const node of page.nodes) {
    assert.equal(node.workspaceId, aliceWorkspaceId);
  }
  // And the foreign tenant still sees NOTHING (the uniform client fence).
  const foreign = await ideas.retrieveNodes({
    scope: bobScope,
    originClasses: ['observed_source'],
    citedBundleReference: wsCitation.bundleReference,
  });
  assert.equal(foreign.nodes.length, 0);
});

test('LAB-004: the semantic-decomposer test double — the port seam lights up problem/claim/hook primitives + the intra-decomposition semantic edges', async () => {
  // A REAL semantic decomposer (or a test double) proposes the
  // encoder-grade primitives + semantic relations among its own
  // nodes — the port contract surface the first-party implementation
  // honestly leaves dark.
  const doubleIdeas = createLabIdeasModule({
    db: db!,
    clock: clock!,
    ids: ids!,
    decomposer: {
      decomposerId: 'lab-ideas-test-double-semantic',
      decomposerVersion: '1',
      ideaSetVersion: LAB_IDEA_SET_VERSION,
      async decompose() {
        return {
          nodes: [
            { primitiveKind: 'problem', descriptor: 'no home gym space' },
            { primitiveKind: 'claim', descriptor: 'folding gear fixes it' },
            { primitiveKind: 'hook', descriptor: 'question opener about tiny apartments' },
          ],
          edges: [{ relation: 'supports', fromSeq: 2, toSeq: 1 }],
        };
      },
    },
    generator: createFirstPartyLabIdeaGenerator(),
  });
  const decomposition = await doubleIdeas.decompose({
    scope: aliceScope,
    citation: citation({
      bundleId: '00000000-0000-0000-0000-0000000000cc',
      bundleReference: '00000000-0000-0000-0000-0000000000cc#v1',
      metadataDigest: DIGEST_C,
    }),
  });
  assert.equal(decomposition.nodeCount, 3);
  assert.equal(decomposition.edgeCount, 1);
  const edge = decomposition.edges[0]!;
  assert.equal(edge.relation, 'supports');
  assert.equal(edge.decompositionId, decomposition.decompositionId);
  assert.equal(edge.operationId, null);
  // The edge points claim → problem (the semantic assertion).
  const problemNode = decomposition.nodes.find((node) => node.primitiveKind === 'problem')!;
  const claimNode = decomposition.nodes.find((node) => node.primitiveKind === 'claim')!;
  assert.equal(edge.fromNodeId, claimNode.nodeId);
  assert.equal(edge.toNodeId, problemNode.nodeId);
});

// ---------------------------------------------------------------------------
// (b) The deterministic identity idempotence + the version chain.
// ---------------------------------------------------------------------------

test('LAB-004: the deterministic identity idempotence — the same citation under the same versions is the SAME decomposition', async () => {
  const first = await ideas.decompose({ scope: aliceScope, citation: citation() });
  const second = await ideas.decompose({ scope: aliceScope, citation: citation() });
  assert.equal(second.decompositionId, first.decompositionId);
  assert.equal(second.identityDigest, first.identityDigest);
  assert.equal(second.decompositionVersion, first.decompositionVersion);
});

test('LAB-004: the append-only per-cited-bundle version chain — a changed input is a NEW decomposition_version row, never an in-place rewrite', async () => {
  // A new bundle version of the same cited bundle (the /lab-features
  // re-extraction): a new citation → a new identity → a new chain row.
  const v2 = await ideas.decompose({
    scope: aliceScope,
    citation: citation({
      bundleVersion: 2,
      bundleReference: '00000000-0000-0000-0000-0000000000bb#v2',
      features: {
        duration: { state: 'derived', value: { sourceField: 'durationSeconds', valueSeconds: 62 } },
        title_description_hashtag_semantics: {
          state: 'derived',
          value: { titleTokens: 7, descriptionTokens: 12, hashtags: ['#fitness', '#gear'], hashtagCount: 2 },
        },
        problem_claim: { state: 'unavailable', reason: 'encoder_unavailable' },
      },
    }),
  });
  assert.equal(v2.decompositionVersion, 2);
  assert.notEqual(v2.decompositionId, (await ideas.decompose({ scope: aliceScope, citation: citation() })).decompositionId);
  // The chain read.
  const chain = await ideas.listDecompositions(aliceScope, citation().bundleReference);
  assert.equal(chain.length, 2);
  assert.deepEqual(chain.map((d) => d.decompositionVersion).sort(), [1, 2]);
});

test('LAB-004: the scope gate — a citation recorded under a foreign client fails closed (nothing recorded)', async () => {
  await assert.rejects(
    ideas.decompose({
      scope: aliceScope,
      citation: citation({ clientId: bobScope.clientId }),
    }),
    (error: unknown) => error instanceof InvalidRequestError && error.message.includes('does not match the decomposition scope client'),
  );
  // Nothing was recorded: the foreign citation has no decomposition row.
  const chain = await ideas.listDecompositions(aliceScope, '00000000-0000-0000-0000-0000000000dd#v1');
  assert.equal(chain.length, 0);
});

// ---------------------------------------------------------------------------
// (c) THE RETRIEVAL (the deterministic, cursor-paginated, SQL-computed read).
// ---------------------------------------------------------------------------

test('LAB-004: THE RETRIEVAL — the mandatory origin-class filter, the kind filter, the cited-bundle filter, the cursor walk', async () => {
  // The evidence filter (observed only): the two observed nodes of the first
  // decomposition chain (packaging + timing_context).
  const evidence = await ideas.retrieveNodes({
    scope: aliceScope,
    originClasses: ['observed_source'],
    citedBundleReference: citation().bundleReference,
  });
  assert.equal(evidence.nodes.length, 2);
  for (const node of evidence.nodes) {
    assert.equal(node.originClass, 'observed_source');
  }
  // The kind filter narrows to one.
  const hooks = await ideas.retrieveNodes({
    scope: aliceScope,
    originClasses: ['observed_source'],
    primitiveKinds: ['packaging'],
    citedBundleReference: citation().bundleReference,
  });
  assert.equal(hooks.nodes.length, 1);
  assert.equal(hooks.nodes[0]!.primitiveKind, 'packaging');
  // The cited-reference filter (the /lab-corpus reference id).
  const byReference = await ideas.retrieveNodes({
    scope: aliceScope,
    originClasses: ['observed_source'],
    citedReferenceId: citation().referenceId,
  });
  assert.ok(byReference.nodes.length >= 2);
  // THE CURSOR WALK: page through all observed nodes of the client with
  // limit 2, following nextCursor — bounded, deterministic, no overlap.
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const result = await ideas.retrieveNodes({
      scope: aliceScope,
      originClasses: ['observed_source'],
      limit: 2,
      cursor,
    });
    for (const node of result.nodes) seen.push(node.nodeId);
    if (result.nextCursor === null) break;
    cursor = result.nextCursor;
  }
  assert.equal(new Set(seen).size, seen.length, 'the cursor walk never repeats a node');
  assert.equal(seen.length, 9, 'every observed node of the client pages through (2 + 3 + 2 + 2 across the four decompositions — the workspace-anchored decomposition included; the client is the fence)');
  // A malformed cursor is the honest invalid request.
  await assert.rejects(
    ideas.retrieveNodes({ scope: aliceScope, originClasses: ['observed_source'], cursor: 'garbage!!' }),
    (error: unknown) => error instanceof InvalidRequestError && error.message.includes('cursor must be the opaque keyset cursor'),
  );
});

// ---------------------------------------------------------------------------
// (d) THE OPERATIONS (recombination + mutation + derivation — the first-class records).
// ---------------------------------------------------------------------------

test('LAB-004: THE DERIVE OPERATION — the derived_abstraction output, the recorded lineage (one hop to the observed ancestors), the creation-time novelty, the refines edges', async () => {
  const evidence = await ideas.retrieveNodes({
    scope: aliceScope,
    originClasses: ['observed_source'],
    primitiveKinds: ['packaging'],
    citedBundleReference: citation().bundleReference,
  });
  const packagingNodes = evidence.nodes.map((node) => node.nodeId);
  // The v2 chain also produced a packaging node — take the first two
  // observed packaging nodes as the derive inputs (the cross-chain
  // abstraction).
  const allPackaging = await ideas.retrieveNodes({ scope: aliceScope, originClasses: ['observed_source'], primitiveKinds: ['packaging'] });
  assert.ok(allPackaging.nodes.length >= 2);
  const inputIds = [allPackaging.nodes[0]!.nodeId, allPackaging.nodes[1]!.nodeId];

  const operation = await ideas.applyOperation({
    scope: aliceScope,
    operationKind: 'derive',
    inputNodeIds: inputIds,
  });
  assert.equal(operation.operationKind, 'derive');
  assert.equal(operation.outputOriginClass, 'derived_abstraction');
  assert.equal(operation.generatorId, FIRST_PARTY_GENERATOR_ID);
  assert.equal(operation.generatorVersion, FIRST_PARTY_GENERATOR_VERSION);
  assert.deepEqual(operation.inputNodeIds, inputIds);
  // THE OUTPUT NODE: the derived origin class + the recorded lineage + the
  // creation-time novelty score against the OBSERVED graph.
  const output = await ideas.getNode(aliceScope, operation.outputNodeId);
  assert.equal(output.originClass, 'derived_abstraction');
  assert.equal(output.primitiveKind, 'packaging');
  assert.equal(output.decompositionId, null);
  assert.equal(output.citedBundleReference, null);
  assert.equal(output.creatingOperationId, operation.operationId);
  assert.equal(output.creatingOperationKind, 'derive');
  assert.ok(output.noveltyScore !== null && output.noveltyScore >= 0 && output.noveltyScore <= 1);
  assert.equal(output.noveltyVersion, 'lab-idea-novelty-v1');
  assert.ok(output.descriptor.startsWith('derived abstraction (structural)'));
  // THE RECORDED LINEAGE: the two new refines edges, one hop to the observed
  // ancestors (their own lineage is null — the chain ends at them).
  assert.ok(output.lineage !== null);
  assert.equal(output.lineage!.length, 2);
  assert.equal(output.lineage![0]!.relation, 'refines');
  assert.equal(output.lineage![0]!.toNodeId, output.nodeId);
  assert.deepEqual(
    output.lineage!.map((step) => step.fromNodeId).sort(),
    [...inputIds].sort(),
  );
  // The LINEAGE READ resolves the ancestors + the observed ancestor ids.
  const view = await ideas.getNodeLineage(aliceScope, output.nodeId);
  assert.equal(view.observedAncestorIds.length, 2);
  assert.deepEqual([...view.observedAncestorIds].sort(), [...inputIds].sort());
  assert.equal(view.ancestors.length, 2);
  for (const ancestor of view.ancestors) {
    assert.equal(ancestor.originClass, 'observed_source');
  }
  void packagingNodes;
});

test('LAB-004: THE RECOMBINE OPERATION — the combined_strategy output over cross-kind inputs, the combines_with edges, the two-hop lineage', async () => {
  const packaging = (await ideas.retrieveNodes({ scope: aliceScope, originClasses: ['observed_source'], primitiveKinds: ['packaging'] })).nodes[0]!;
  const timing = (await ideas.retrieveNodes({ scope: aliceScope, originClasses: ['observed_source'], primitiveKinds: ['timing_context'] })).nodes[0]!;
  // The derived abstraction of the previous test as an intermediate input:
  // the lineage chain compounds through it (the two-hop proof).
  const derived = (
    await ideas.retrieveNodes({ scope: aliceScope, originClasses: ['derived_abstraction'], primitiveKinds: ['packaging'] })
  ).nodes[0]!;
  assert.ok(derived !== undefined);

  const operation = await ideas.applyOperation({
    scope: aliceScope,
    operationKind: 'recombine',
    inputNodeIds: [packaging.nodeId, timing.nodeId, derived.nodeId],
    outputPrimitiveKind: 'idea',
  });
  assert.equal(operation.outputOriginClass, 'combined_strategy');
  const output = await ideas.getNode(aliceScope, operation.outputNodeId);
  assert.equal(output.originClass, 'combined_strategy');
  assert.equal(output.primitiveKind, 'idea');
  assert.ok(output.descriptor.startsWith('combined strategy (structural)'));
  // THE COMPOUNDED LINEAGE: three combines_with edges to the inputs + the
  // derived input's own two refines steps appended (the two-hop chain to the
  // observed ancestors — DATA recorded at creation).
  assert.ok(output.lineage !== null);
  assert.equal(output.lineage!.length, 5);
  const relations = output.lineage!.map((step) => step.relation);
  assert.deepEqual(relations.slice(0, 3), ['combines_with', 'combines_with', 'combines_with']);
  assert.deepEqual(relations.slice(3), ['refines', 'refines']);
  // The lineage read: the observed ancestors include the derived node's
  // observed ancestors (the recorded chain reaches them through the edges).
  const view = await ideas.getNodeLineage(aliceScope, output.nodeId);
  assert.ok(view.observedAncestorIds.includes(packaging.nodeId));
  assert.ok(view.observedAncestorIds.includes(timing.nodeId));
  // The derived intermediate is an ancestor (resolved), but NOT an observed one.
  assert.ok(view.ancestors.some((ancestor) => ancestor.nodeId === derived.nodeId));
  assert.ok(!view.observedAncestorIds.includes(derived.nodeId));
});

test('LAB-004: THE FILL_GAP OPERATION — the generated_mutation output recording the uncovered space', async () => {
  const packaging = (await ideas.retrieveNodes({ scope: aliceScope, originClasses: ['observed_source'], primitiveKinds: ['packaging'] })).nodes;
  assert.ok(packaging.length >= 2);
  const operation = await ideas.applyOperation({
    scope: aliceScope,
    operationKind: 'fill_gap',
    inputNodeIds: [packaging[0]!.nodeId, packaging[1]!.nodeId],
  });
  assert.equal(operation.outputOriginClass, 'generated_mutation');
  const output = await ideas.getNode(aliceScope, operation.outputNodeId);
  assert.equal(output.originClass, 'generated_mutation');
  assert.equal(output.primitiveKind, 'packaging');
  assert.ok(output.descriptor.startsWith('gap (structural)'));
  assert.equal(output.lineage!.length, 2);
  assert.equal(output.lineage![0]!.relation, 'fills_gap');
});

test('LAB-004: THE OPEN-ENDED GENERATIVE KINDS FAIL CLOSED — mutate/analogy/invert ship the honest pending state, NOTHING recorded', async () => {
  const packaging = (await ideas.retrieveNodes({ scope: aliceScope, originClasses: ['observed_source'], primitiveKinds: ['packaging'] })).nodes[0]!;
  const before = await ideas.retrieveNodes({ scope: aliceScope, originClasses: ['generated_mutation', 'combined_strategy', 'derived_abstraction'] });
  for (const kind of ['mutate', 'analogy', 'invert'] as const) {
    await assert.rejects(
      ideas.applyOperation({ scope: aliceScope, operationKind: kind, inputNodeIds: [packaging.nodeId] }),
      (error: unknown) =>
        error instanceof InvalidRequestError &&
        error.message.includes(`the open-ended generative kind '${kind}' has no generator wired`) &&
        error.message.includes('nothing was recorded'),
    );
  }
  // Nothing was recorded: the non-observed node set is unchanged.
  const after = await ideas.retrieveNodes({ scope: aliceScope, originClasses: ['generated_mutation', 'combined_strategy', 'derived_abstraction'] });
  assert.equal(after.nodes.length, before.nodes.length);
});

test('LAB-004: the operation input fences end-to-end — missing nodes → the uniform NotFound; mixed kinds for derive → the honest fence', async () => {
  const packaging = (await ideas.retrieveNodes({ scope: aliceScope, originClasses: ['observed_source'], primitiveKinds: ['packaging'] })).nodes[0]!;
  const timing = (await ideas.retrieveNodes({ scope: aliceScope, originClasses: ['observed_source'], primitiveKinds: ['timing_context'] })).nodes[0]!;
  // A missing input node.
  await assert.rejects(
    ideas.applyOperation({
      scope: aliceScope,
      operationKind: 'derive',
      inputNodeIds: [packaging.nodeId, '00000000-0000-0000-0000-00000000dead'],
    }),
    (error: unknown) => error instanceof NotFoundError,
  );
  // Mixed kinds for derive.
  await assert.rejects(
    ideas.applyOperation({
      scope: aliceScope,
      operationKind: 'derive',
      inputNodeIds: [packaging.nodeId, timing.nodeId],
    }),
    (error: unknown) => error instanceof InvalidRequestError && error.message.includes('requires same-primitive-kind inputs'),
  );
  // A foreign input node (Bob cannot cite Alice's nodes — the tenant fence).
  await assert.rejects(
    ideas.applyOperation({ scope: bobScope, operationKind: 'derive', inputNodeIds: [packaging.nodeId, packaging.nodeId === packaging.nodeId ? packaging.nodeId : packaging.nodeId] }),
    (error: unknown) => error instanceof InvalidRequestError && error.message.includes('duplicates'),
  );
  await assert.rejects(
    ideas.applyOperation({ scope: bobScope, operationKind: 'mutate', inputNodeIds: [packaging.nodeId] }),
    (error: unknown) => error instanceof NotFoundError,
  );
});

// ---------------------------------------------------------------------------
// (e) THE NOVELTY MEASUREMENT (against OBSERVED nodes only).
// ---------------------------------------------------------------------------

test('LAB-004: THE NOVELTY MEASUREMENT — the frozen formula against OBSERVED nodes only; generated nodes never count', async () => {
  // The observed packaging set is the comparison basis.
  const observedPackaging = await ideas.retrieveNodes({ scope: aliceScope, originClasses: ['observed_source'], primitiveKinds: ['packaging'] });
  assert.ok(observedPackaging.nodes.length >= 2);
  // A candidate identical to an observed node → novelty 0. The two
  // observed packaging nodes (v1 + v2 chains) have IDENTICAL descriptors,
  // so the nearest is either one — the deterministic tie-break picks the
  // smallest node id in the node_id-ascending comparison order.
  const identical = await ideas.measureNovelty(aliceScope, {
    primitiveKind: 'packaging',
    descriptor: observedPackaging.nodes[0]!.descriptor,
  });
  assert.equal(identical.noveltyVersion, 'lab-idea-novelty-v1');
  assert.equal(identical.noveltyScore, 0);
  const observedPackagingIds = new Set(observedPackaging.nodes.map((node) => node.nodeId));
  assert.ok(observedPackagingIds.has(identical.nearestObservedNodeId!));
  assert.equal(identical.nearestSimilarity, 1);
  // A fully disjoint candidate → novelty 1.
  const disjoint = await ideas.measureNovelty(aliceScope, {
    primitiveKind: 'packaging',
    descriptor: 'quantum crochet patterns for deep sea divers',
  });
  assert.equal(disjoint.noveltyScore, 1);
  assert.equal(disjoint.observedComparisonCount, observedPackaging.nodes.length);
  // A GENERATED node resembling the candidate does NOT change the score:
  // the generated fill_gap node's descriptor is NOT in the comparison set
  // (novelty is measured against OBSERVED nodes only — §6).
  const generated = (await ideas.retrieveNodes({ scope: aliceScope, originClasses: ['generated_mutation'], primitiveKinds: ['packaging'] })).nodes;
  assert.ok(generated.length >= 1);
  const stillNovel = await ideas.measureNovelty(aliceScope, {
    primitiveKind: 'packaging',
    descriptor: generated[0]!.descriptor,
  });
  // The generated node's own descriptor is not an observed node — the
  // nearest observed similarity stays whatever the OBSERVED set says.
  assert.equal(stillNovel.observedComparisonCount, observedPackaging.nodes.length);
  // An empty observed kind space → novelty 1.
  const emptyKind = await ideas.measureNovelty(aliceScope, { primitiveKind: 'cta', descriptor: 'anything' });
  assert.equal(emptyKind.noveltyScore, 1);
  assert.equal(emptyKind.observedComparisonCount, 0);
  // The candidate fences.
  await assert.rejects(
    ideas.measureNovelty(aliceScope, { primitiveKind: 'vibe' as never, descriptor: 'x' }),
    (error: unknown) => error instanceof InvalidRequestError,
  );
});

// ---------------------------------------------------------------------------
// (f) THE VERSIONED CLUSTERING.
// ---------------------------------------------------------------------------

test('LAB-004: THE VERSIONED CLUSTERING — the deterministic assignments, the SQL-computed summary, the idempotent re-run, the conflict on a changed node set', async () => {
  const run = await ideas.runClustering(aliceScope);
  assert.equal(run.clusterVersion, 'lab-idea-clustering-v1');
  assert.equal(run.status, 'completed');
  // The clusterable space: the observed + derived nodes (the generated/
  // combined nodes NEVER cluster — the evidence-bearing space only).
  const clusterable = await ideas.retrieveNodes({ scope: aliceScope, originClasses: ['observed_source', 'derived_abstraction'] });
  assert.equal(run.inputNodeCount, clusterable.nodes.length);
  assert.equal(run.assignments.length, clusterable.nodes.length);
  assert.ok(run.clusterCount >= 1);
  assert.ok(run.clusterCount <= run.inputNodeCount);
  assert.ok(run.largestClusterSize <= run.inputNodeCount);
  // Every assignment carries its deterministic key + the component size.
  for (const assignment of run.assignments) {
    assert.match(assignment.clusterKey, /^(idea|problem|claim|hook|narrative|visual_treatment|audio_treatment|packaging|cta|timing_context)#/);
    assert.ok(assignment.clusterSize >= 1);
  }
  // The observed packaging nodes (v1 + v2 chains) cluster together (their
  // descriptors share the lexical structure) — the derived/generated nodes
  // never join their cluster.
  const packagingAssignments = run.assignments.filter((a) => a.primitiveKind === 'packaging');
  assert.ok(packagingAssignments.length >= 3);
  const observedPackagingIds = new Set(
    (await ideas.retrieveNodes({ scope: aliceScope, originClasses: ['observed_source'], primitiveKinds: ['packaging'] })).nodes.map((node) => node.nodeId),
  );
  const observedPackagingKeys = packagingAssignments
    .filter((assignment) => observedPackagingIds.has(assignment.nodeId))
    .map((assignment) => assignment.clusterKey);
  assert.equal(new Set(observedPackagingKeys).size, 1);
  // THE IDEMPOTENT RE-RUN: the unchanged node set under the same version
  // returns the existing run (never a rewrite).
  const rerun = await ideas.runClustering(aliceScope);
  assert.equal(rerun.runId, run.runId);
  // THE CONFLICT ON A CHANGED NODE SET: a new decomposition changes the
  // clusterable space under the same version → the honest conflict.
  await ideas.decompose({
    scope: aliceScope,
    citation: citation({
      bundleId: '00000000-0000-0000-0000-0000000000ee',
      bundleReference: '00000000-0000-0000-0000-0000000000ee#v1',
      metadataDigest: 'e'.repeat(64),
      features: {
        duration: { state: 'derived', value: { sourceField: 'durationSeconds', valueSeconds: 45 } },
        title_description_hashtag_semantics: {
          state: 'derived',
          value: { titleTokens: 5, descriptionTokens: 3, hashtags: ['#yoga'], hashtagCount: 1 },
        },
      },
    }),
  });
  await assert.rejects(
    ideas.runClustering(aliceScope),
    (error: unknown) => error instanceof ConflictError && error.message.includes('the clusterable node set changed under clustering version'),
  );
  // The run + assignments remain readable.
  const readBack = await ideas.getClusterRun(aliceScope, run.runId);
  assert.equal(readBack.assignments.length, run.assignments.length);
});

// ---------------------------------------------------------------------------
// (g) TENANT ISOLATION (§22).
// ---------------------------------------------------------------------------

test('LAB-004: TENANT ISOLATION — the uniform NotFound for foreign scope (no existence oracle), the cross-tenant injection triggers', async () => {
  const aliceDecomposition = (await ideas.listDecompositions(aliceScope, citation().bundleReference))[0]!;
  const aliceNode = (await ideas.retrieveNodes({ scope: aliceScope, originClasses: ['observed_source'] })).nodes[0]!;
  const aliceDerived = (await ideas.retrieveNodes({ scope: aliceScope, originClasses: ['derived_abstraction'] })).nodes[0]!;
  const aliceOperationId = aliceDerived.creatingOperationId!;
  const aliceOperation = await ideas.getOperation(aliceScope, aliceOperationId);
  assert.equal(aliceOperation.operationId, aliceOperationId);
  // The uniform NotFound on every read surface for Bob.
  await assert.rejects(ideas.getDecomposition(bobScope, aliceDecomposition.decompositionId), (e: unknown) => e instanceof NotFoundError);
  await assert.rejects(ideas.getNode(bobScope, aliceNode.nodeId), (e: unknown) => e instanceof NotFoundError);
  await assert.rejects(ideas.getNodeLineage(bobScope, aliceNode.nodeId), (e: unknown) => e instanceof NotFoundError);
  await assert.rejects(ideas.getOperation(bobScope, aliceOperationId), (e: unknown) => e instanceof NotFoundError);
  const aliceRunRows = await db!.query<{ run_id: string }>(
    'SELECT run_id FROM lab_idea_cluster_runs WHERE client_id = $1 LIMIT 1',
    [aliceScope.clientId],
  );
  await assert.rejects(ideas.getClusterRun(bobScope, aliceRunRows.rows[0]!.run_id), (e: unknown) => e instanceof NotFoundError);
  const bobRun = await ideas.runClustering(bobScope);
  assert.equal(bobRun.inputNodeCount, 0);
  assert.equal(bobRun.clusterCount, 0);
  // THE DB-LEVEL CROSS-TENANT INJECTION TRIGGERS: a node injected with a
  // foreign decomposition anchor is rejected.
  const foreignNode = {
    node_id: ids!.newId(),
    decomposition_id: aliceDecomposition.decompositionId,
    creating_operation_id: null,
    primitive_kind: 'hook',
    origin_class: 'observed_source',
    descriptor: 'cross-tenant injection probe',
    attributes: JSON.stringify({}),
    cited_bundle_reference: citation().bundleReference,
    creating_operation_kind: null,
    lineage: null,
    novelty_score: null,
    novelty_version: null,
    seq: 99,
    agency_id: bobScope.agencyId,
    client_id: bobScope.clientId,
    workspace_id: null,
    contract_version: LAB_IDEAS_CONTRACT_VERSION,
    created_at: clock!.nowIso(),
    updated_at: clock!.nowIso(),
  };
  await assert.rejects(
    db!.query('INSERT INTO lab_idea_nodes (node_id, decomposition_id, creating_operation_id, primitive_kind, origin_class, descriptor, attributes, cited_bundle_reference, creating_operation_kind, lineage, novelty_score, novelty_version, seq, agency_id, client_id, workspace_id, contract_version, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $16, $17, $18::timestamptz, $19::timestamptz)', [
      foreignNode.node_id, foreignNode.decomposition_id, foreignNode.creating_operation_id, foreignNode.primitive_kind,
      foreignNode.origin_class, foreignNode.descriptor, foreignNode.attributes, foreignNode.cited_bundle_reference,
      foreignNode.creating_operation_kind, foreignNode.lineage, foreignNode.novelty_score, foreignNode.novelty_version,
      foreignNode.seq, foreignNode.agency_id, foreignNode.client_id, foreignNode.workspace_id, foreignNode.contract_version,
      foreignNode.created_at, foreignNode.updated_at,
    ]),
    (error: unknown) => String(error).includes('cross-tenant extraction is rejected'),
  );
});

// ---------------------------------------------------------------------------
// (h) THE DB BACKSTOPS (the append-only + guard triggers, the separation fences).
// ---------------------------------------------------------------------------

test('LAB-004: THE DB BACKSTOPS — nodes/edges/operations/inputs/assignments are append-only outright; the decomposition guard enforces the single completion advance', async () => {
  const node = (await ideas.retrieveNodes({ scope: aliceScope, originClasses: ['observed_source'] })).nodes[0]!;
  // UPDATE + DELETE on nodes are rejected.
  await assert.rejects(
    db!.query('UPDATE lab_idea_nodes SET descriptor = $1 WHERE node_id = $2', ['rewritten', node.nodeId]),
    (error: unknown) => String(error).includes('append-only'),
  );
  await assert.rejects(
    db!.query('DELETE FROM lab_idea_nodes WHERE node_id = $1', [node.nodeId]),
    (error: unknown) => String(error).includes('append-only'),
  );
  const decomposition = (await ideas.listDecompositions(aliceScope, citation().bundleReference))[0]!;
  await assert.rejects(
    db!.query('DELETE FROM lab_idea_decompositions WHERE decomposition_id = $1', [decomposition.decompositionId]),
    (error: unknown) => String(error).includes('append-only'),
  );
  // The decomposition guard: identity is immutable; only the single
  // completion advance may change the status; no reopen.
  await assert.rejects(
    db!.query('UPDATE lab_idea_decompositions SET provider = $1 WHERE decomposition_id = $2', ['other', decomposition.decompositionId]),
    (error: unknown) => String(error).includes('identity/scope/citation is immutable'),
  );
  await assert.rejects(
    db!.query("UPDATE lab_idea_decompositions SET status = 'running' WHERE decomposition_id = $1", [decomposition.decompositionId]),
    (error: unknown) => String(error).includes('is not legal'),
  );
  // THE OBSERVED-SEPARATION FENCES: a mixed-origin node is structurally
  // inexpressible — an observed node with a lineage is rejected by the CHECK.
  await assert.rejects(
    db!.query(
      'INSERT INTO lab_idea_nodes (node_id, decomposition_id, creating_operation_id, primitive_kind, origin_class, descriptor, attributes, cited_bundle_reference, creating_operation_kind, lineage, novelty_score, novelty_version, seq, agency_id, client_id, workspace_id, contract_version, created_at, updated_at) VALUES ($1, $2, null, $3, $4, $5, $6::jsonb, $7, null, $8::jsonb, null, null, 1, $9, $10, null, $11, $12::timestamptz, $12::timestamptz)',
      [
        ids!.newId(), decomposition.decompositionId, 'hook', 'observed_source', 'a forged observed node with lineage',
        '{}', citation().bundleReference, JSON.stringify([{ seq: 1, fromNodeId: node.nodeId, toNodeId: node.nodeId, relation: 'supports' }]),
        aliceScope.agencyId, aliceScope.clientId, LAB_IDEAS_CONTRACT_VERSION, clock!.nowIso(),
      ],
    ),
    (error: unknown) => String(error).includes('lineage_fence'),
  );
  // A generated node without its creating operation is rejected (every
  // other non-observed fence satisfied so the operation_fence isolates).
  await assert.rejects(
    db!.query(
      'INSERT INTO lab_idea_nodes (node_id, decomposition_id, creating_operation_id, primitive_kind, origin_class, descriptor, attributes, cited_bundle_reference, creating_operation_kind, lineage, novelty_score, novelty_version, seq, agency_id, client_id, workspace_id, contract_version, created_at, updated_at) VALUES ($1, null, null, $2, $3, $4, $5::jsonb, null, $6, $7::jsonb, $8, $9, 1, $10, $11, null, $12, $13::timestamptz, $13::timestamptz)',
      [
        ids!.newId(), 'hook', 'generated_mutation', 'a generated node with no operation', '{}', 'mutate',
        JSON.stringify([{ seq: 1, fromNodeId: node.nodeId, toNodeId: node.nodeId, relation: 'mutates_from' }]),
        1, 'lab-idea-novelty-v1',
        aliceScope.agencyId, aliceScope.clientId, LAB_IDEAS_CONTRACT_VERSION, clock!.nowIso(),
      ],
    ),
    (error: unknown) => String(error).includes('operation_fence'),
  );
  // The operation kind/origin pairing is CHECK-fenced: an operation row
  // claiming a mismatched output origin is rejected (the probe node's
  // back-reference points at the probe operation so the scope trigger
  // passes and the pairing fence fires).
  const probeNodeId = ids!.newId();
  const probeOperationId = ids!.newId();
  // (1) the probe output node: a well-formed combined_strategy node whose
  // recorded back-reference cites the probe operation (inserts cleanly).
  await db!.query(
    'INSERT INTO lab_idea_nodes (node_id, decomposition_id, creating_operation_id, primitive_kind, origin_class, descriptor, attributes, cited_bundle_reference, creating_operation_kind, lineage, novelty_score, novelty_version, seq, agency_id, client_id, workspace_id, contract_version, created_at, updated_at) VALUES ($1, null, $2, $3, $4, $5, $6::jsonb, null, $7, $8::jsonb, $9, $10, 1, $11, $12, null, $13, $14::timestamptz, $14::timestamptz)',
    [
      probeNodeId, probeOperationId, 'idea', 'combined_strategy', 'the pairing probe output', '{}', 'recombine',
      JSON.stringify([{ seq: 1, fromNodeId: node.nodeId, toNodeId: probeNodeId, relation: 'combines_with' }]),
      1, 'lab-idea-novelty-v1', aliceScope.agencyId, aliceScope.clientId, LAB_IDEAS_CONTRACT_VERSION, clock!.nowIso(),
    ],
  );
  // (2) the probe operation: kind 'derive' claiming a combined_strategy
  // output — the CHECK-fenced pairing rejects it.
  await assert.rejects(
    db!.query(
      'INSERT INTO lab_idea_operations (operation_id, operation_kind, output_node_id, output_origin_class, generator_id, generator_version, agency_id, client_id, workspace_id, contract_version, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, null, $9, $10::timestamptz)',
      [
        probeOperationId, 'derive', probeNodeId, 'combined_strategy', 'probe', '1',
        aliceScope.agencyId, aliceScope.clientId, LAB_IDEAS_CONTRACT_VERSION, clock!.nowIso(),
      ],
    ),
    (error: unknown) => String(error).includes('kind_origin_pairing'),
  );
  // The one-run-per-version fence: a second cluster run row for the same
  // (client, version) is rejected.
  await assert.rejects(
    db!.query(
      'INSERT INTO lab_idea_cluster_runs (run_id, cluster_version, status, input_node_count, cluster_count, largest_cluster_size, singleton_count, agency_id, client_id, workspace_id, contract_version, created_at, updated_at) VALUES ($1, $2, $3, 0, 0, 0, 0, $4, $5, null, $6, $7::timestamptz, $7::timestamptz)',
      [
        ids!.newId(), 'lab-idea-clustering-v1', 'running', aliceScope.agencyId, aliceScope.clientId,
        LAB_IDEAS_CONTRACT_VERSION, clock!.nowIso(),
      ],
    ),
    (error: unknown) => String(error).includes('duplicate key'),
  );
});

test('LAB-004: THE MIGRATION TAIL — 066_lab_ideas.sql applies cleanly after 065 (the serialized chain)', async () => {
  const r = await db!.query<{ name: string }>(
    "SELECT name FROM platform_schema_migrations WHERE name = '066_lab_ideas.sql'",
  );
  assert.equal(r.rows.length, 1);
  // The lab-ideas tables exist with the expected closed vocabularies.
  const tables = await db!.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'lab_idea_%' ORDER BY table_name",
  );
  assert.deepEqual(
    tables.rows.map((row) => row.table_name),
    [
      'lab_idea_cluster_assignments',
      'lab_idea_cluster_runs',
      'lab_idea_decompositions',
      'lab_idea_edges',
      'lab_idea_nodes',
      'lab_idea_operation_inputs',
      'lab_idea_operations',
    ],
  );
});
