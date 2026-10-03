/**
 * LAB-013 integration tests — the /lab-capabilities Capability Engine +
 * Arena Adapter against a REAL embedded PostgreSQL stack (the LAB-003
 * module-level harness: real PgDb + real users/agencies/clients public
 * contracts, the module under test composed exactly as the composition
 * root wires it — platform ports + the two replaceable structural ports
 * with TEST DOUBLES satisfying the same contracts).
 *
 * The acceptance battery (spec/effective-backlog-v1.7.md LAB-013:
 * "missing capability can be discovered, requested, fulfilled, verified
 * and inserted without creating a second marketplace authority; Arena
 * remains behind Integration/provider contracts"):
 *   (a) DISCOVERED — the capability gap is detected from an OPAQUE
 *       strategy citation + the required action shape;
 *   (b) REQUESTED — the gap → contract → value estimate → governed
 *       Arena request chain with the caller-declared provider target,
 *       dispatched THROUGH THE STRUCTURAL PORT (the arena test double
 *       stands where the real /integrations instance sits);
 *   (c) FULFILLED — the provider outcome (ok + provider record id) and
 *       the human-plane fulfillment (the canonical plane cited
 *       OPAQUELY, advancing a pending request with the provider echo
 *       honestly null);
 *   (d) VERIFIED — the declared quality evaluator runs against the
 *       delivered artifact; the verdict + the evaluator identity echo
 *       are recorded (pass AND fail paths);
 *   (e) INSERTED — the capability version cites ONLY a passing
 *       verification (the module gate AND the DB trigger backstop), the
 *       origin is DERIVED from the fulfillment kind, the gap advances
 *       contracted → resolved, and the unverified-first-party path is
 *       honestly unverified;
 *   (f) NO SECOND MARKETPLACE AUTHORITY — the provider target is
 *       caller-declared data flowing through the two-method port only;
 *       a failed provider outcome is the honest failed request (never
 *       a fabricated success), and a port-level throw is recorded the
 *       same way;
 *   (g) the simulation + real-test links (the OPAQUE citations + the
 *       closed outcomes);
 *   (h) tenant isolation (§22) — the uniform NotFound for foreign scope
 *       (no existence oracle) + the DB-level cross-tenant chain
 *       injection rejections;
 *   (i) the DB backstops — the append-only triggers (result/
 *       verification UPDATE+DELETE rejected), the guarded lifecycles
 *       (no resurrection, the frozen provider echo) and the estimate
 *       supersession.
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
  createLabCapabilitiesModule,
  createFirstPartyLabCapabilityEvaluator,
  LAB_CAPABILITIES_CONTRACT_VERSION,
  labCapabilityVersionReference,
} from '../../src/modules/lab-capabilities/public.ts';
import type {
  LabCapabilitiesArenaPort,
  LabCapabilitiesModuleApi,
  LabCapabilitiesScope,
  LabCapabilityArenaMutationOutcome,
  LabCapabilityDeclaration,
} from '../../src/modules/lab-capabilities/public.ts';
import { InvalidRequestError, NotFoundError } from '../../src/platform/errors/errors.ts';

let stack: IntegrationStack | null = null;
let db: PgDb | null = null;
let clock: SystemClock | null = null;
let ids: CryptoIdGenerator | null = null;

let capabilities: LabCapabilitiesModuleApi = null as unknown as LabCapabilitiesModuleApi;
let users: ReturnType<typeof createUsersModule> = null as unknown as ReturnType<typeof createUsersModule>;
let agencies: ReturnType<typeof createAgenciesModule> = null as unknown as ReturnType<typeof createAgenciesModule>;
let clients: ReturnType<typeof createClientsModule> = null as unknown as ReturnType<typeof createClientsModule>;
let workspaces: ReturnType<typeof createWorkspacesModule> = null as unknown as ReturnType<typeof createWorkspacesModule>;

let aliceScope: LabCapabilitiesScope = { agencyId: '', clientId: '' };
let bobScope: LabCapabilitiesScope = { agencyId: '', clientId: '' };
let aliceWorkspaceId: string | null = null;

/** The ARENA TEST DOUBLE — stands exactly where the real /integrations instance sits (the same two-method port). */
let nextArenaOutcome: LabCapabilityArenaMutationOutcome | 'throw' = { ok: true, providerRecordId: 'arena-delivery-1', data: null, error: null };
const arenaCalls: ReadonlyArray<{ connectionId: string; operation: string }> = [];
const arena: LabCapabilitiesArenaPort = {
  listRegisteredAdapters: () => [
    {
      descriptor: { adapterKey: 'arena', providerLabel: 'Arena (external capability provider)', description: 'The test-double Arena provider behind the existing provider contracts' },
      capabilities: [{ capabilityKey: 'capability.acquisition', kind: 'mutation', operations: ['requestCapability'], description: 'Acquire a capability per contract' }],
    },
  ],
  async executeMutation(input) {
    (arenaCalls as { connectionId: string; operation: string }[]).push({ connectionId: input.connectionId, operation: input.operation });
    if (nextArenaOutcome === 'throw') {
      throw new Error('test-double transport failure');
    }
    return nextArenaOutcome;
  },
};

const DISPATCH_PROVENANCE = {
  actor: 'integration-test',
  recordedVia: 'lab-capabilities.integration',
  correlationId: 'corr-1',
  causationId: null,
};

const OUTPUT_SCHEMA = {
  type: 'object' as const,
  required: ['videoUrl'],
  properties: { videoUrl: { type: 'string' as const }, durationSeconds: { type: 'integer' as const } },
};
const EVALUATION_CONTRACT = {
  type: 'object' as const,
  required: ['videoUrl'],
  properties: { videoUrl: { type: 'string' as const } },
};
const QUALITY_EVALUATOR = { evaluatorId: 'quality-shape-evaluator', evaluatorVersion: '1', evaluationContract: EVALUATION_CONTRACT };

function declaration(overrides: Partial<LabCapabilityDeclaration> = {}): LabCapabilityDeclaration {
  return {
    capabilityKey: 'physical-performance-stunt',
    displayName: 'Physical performance stunt (acquired)',
    inputSchema: { type: 'object', required: ['brief'], properties: { brief: { type: 'string' } } },
    outputSchema: OUTPUT_SCHEMA,
    constraints: ['no_fake_engagement', 'no_impersonation'],
    qualityEvaluator: QUALITY_EVALUATOR,
    cost: { costModel: 'abstract-units', costUnits: 40 },
    latency: { expectedP50Ms: 250, expectedP95Ms: 4_000, deadlineMs: 30_000 },
    implementation: { implementationId: 'arena-provider-impl', implementationVersion: '1', implementationKind: 'real' },
    simulatorImplementation: null,
    realImplementation: { implementationId: 'arena-provider-impl', implementationVersion: '1' },
    requirements: [{ requirementKind: 'human_performance', description: 'A specific physical performance' }],
    provenanceSourceNote: 'acquired through the governed Arena flow',
    ...overrides,
  };
}

/** Runs the stages 1-4 (gap → contract → estimate → pending request) and returns the pending request. */
async function chainToRequest(scope: LabCapabilitiesScope, adapterKey = 'arena'): Promise<{
  gap: Awaited<ReturnType<LabCapabilitiesModuleApi['detectCapabilityGap']>>;
  contract: Awaited<ReturnType<LabCapabilitiesModuleApi['deriveCapabilityContract']>>;
  estimate: Awaited<ReturnType<LabCapabilitiesModuleApi['recordCapabilityValueEstimate']>>;
  request: Awaited<ReturnType<LabCapabilitiesModuleApi['createCapabilityRequest']>>;
}> {
  const gap = await capabilities.detectCapabilityGap({
    scope,
    strategyCitation: { strategyKind: 'lab_strategy_candidate', strategyReference: '00000000-0000-0000-0000-0000000000s1' },
    requiredAction: { actionKind: 'physical_performance', description: 'A skate trick indistinguishable from a skilled human', qualityBar: 'broadcast-grade' },
    rationale: 'The candidate strategy requires an unavailable quality-preserving action',
  });
  const contract = await capabilities.deriveCapabilityContract({
    scope,
    gapId: gap.gapId,
    inputSchema: { type: 'object', required: ['brief'], properties: { brief: { type: 'string' } } },
    outputSchema: OUTPUT_SCHEMA,
    constraints: ['no_fake_engagement'],
    qualityEvaluator: QUALITY_EVALUATOR,
    costCeiling: { costModel: 'abstract-units', costUnits: 50 },
    latencyCeilingMs: 30_000,
    requirements: [{ requirementKind: 'human_performance', description: 'A specific physical performance' }],
  });
  const estimate = await capabilities.recordCapabilityValueEstimate({
    scope,
    contractId: contract.contractId,
    figures: {
      estimatedValueUnits: 120,
      expectedQualityLift: 0.3,
      estimatedCostCeiling: 50,
      uncertainty: 'moderate — niche response model unverified',
      basis: 'corpus performance velocity of comparable demonstrations',
    },
  });
  const request = await capabilities.createCapabilityRequest({
    scope,
    gapId: gap.gapId,
    contractId: contract.contractId,
    estimateId: estimate.estimateId,
    adapterKey,
    connectionId: '00000000-0000-0000-0000-0000000000c0',
    operation: 'requestCapability',
    requestParameters: { contractEcho: contract.contractId, qualityBar: 'broadcast-grade' },
    requestedRights: { usageScope: 'lab-simulation-and-production', redistribution: false, attributionRequired: true, licenseTerms: null },
  });
  return { gap, contract, estimate, request };
}

before(async () => {
  stack = await bootStack('lab_capabilities');
  db = new PgDb(stack.env.databaseUrl, 4);
  clock = new SystemClock();
  ids = new CryptoIdGenerator();
  users = createUsersModule({ db, clock, ids });
  agencies = createAgenciesModule({ db, clock, ids, users });
  clients = createClientsModule({ db, clock, ids, agencies });
  workspaces = createWorkspacesModule({ db, clock, ids, clients });
  capabilities = createLabCapabilitiesModule({
    db,
    clock,
    ids,
    arena,
    evaluator: createFirstPartyLabCapabilityEvaluator(),
  });

  const aliceUser = await users.createUser({ email: 'alice@labcapabilities.test', displayName: 'Alice' });
  const aliceAgency = await agencies.createAgency({ name: 'Alice Agency', slug: 'alice-capabilities', ownerUserId: aliceUser.userId, actorId: null });
  const aliceClient = await clients.createClient({ agencyId: aliceAgency.agency.agencyId, name: 'Alice Client', slug: 'alice-client', actorId: null });
  aliceScope = { agencyId: aliceAgency.agency.agencyId, clientId: aliceClient.clientId };
  const workspace = await workspaces.createWorkspace({ clientId: aliceClient.clientId, name: 'Alice WS', slug: undefined, actorId: null });
  aliceWorkspaceId = workspace.workspaceId;

  const bobUser = await users.createUser({ email: 'bob@labcapabilities.test', displayName: 'Bob' });
  const bobAgency = await agencies.createAgency({ name: 'Bob Agency', slug: 'bob-capabilities', ownerUserId: bobUser.userId, actorId: null });
  const bobClient = await clients.createClient({ agencyId: bobAgency.agency.agencyId, name: 'Bob Client', slug: 'bob-client', actorId: null });
  bobScope = { agencyId: bobAgency.agency.agencyId, clientId: bobClient.clientId };
});

after(async () => {
  if (db !== null) await db.close();
  if (stack !== null) await shutdownStack(stack);
});

// ---------------------------------------------------------------------------
// (a)-(e) THE FULL §17 FLOW — the autonomous provider-fulfilled happy path
// ---------------------------------------------------------------------------

test('LAB-013: the full §17 flow — gap → contract → estimate → governed request → dispatch → provider result → verification → capability version → simulation → real test', async () => {
  // (a) DISCOVERED: the gap cites the strategy OPAQUELY.
  const { gap, contract, estimate, request } = await chainToRequest(aliceScope);
  assert.equal(gap.status, 'open');
  assert.equal(gap.detectionActor, 'autonomous');
  assert.equal(gap.strategyCitation.strategyKind, 'lab_strategy_candidate');
  assert.equal(gap.requiredAction.actionKind, 'physical_performance');
  assert.equal(gap.contractVersion, LAB_CAPABILITIES_CONTRACT_VERSION);

  // Stage 2: the contract derivation advances the gap open → contracted.
  const gapContracted = await capabilities.getCapabilityGap(aliceScope, gap.gapId);
  assert.equal(gapContracted.status, 'contracted');
  assert.equal(contract.status, 'derived');
  assert.equal(contract.actor, 'autonomous');
  assert.equal(contract.qualityEvaluator.evaluatorId, 'quality-shape-evaluator');
  assert.equal(contract.latencyCeilingMs, 30_000);

  // Stage 3: the estimate.
  assert.equal(estimate.status, 'recorded');
  assert.equal(estimate.estimatedValueUnits, 120);

  // Stage 4: the governed request (born pending; the provider target is caller-declared DATA).
  assert.equal(request.status, 'pending');
  assert.equal(request.adapterKey, 'arena');
  assert.equal(request.operation, 'requestCapability');
  assert.equal(request.providerOk, null);

  // (b) REQUESTED + dispatched THROUGH THE STRUCTURAL PORT.
  nextArenaOutcome = { ok: true, providerRecordId: 'arena-delivery-1', data: null, error: null };
  const dispatched = await capabilities.dispatchCapabilityRequest({
    scope: aliceScope,
    requestId: request.requestId,
    provenance: DISPATCH_PROVENANCE,
  });
  assert.equal(dispatched.status, 'completed');
  assert.equal(dispatched.providerOk, true);
  assert.equal(dispatched.providerRecordId, 'arena-delivery-1');
  assert.ok(dispatched.dispatchedAt !== null);
  // The port call carried the caller-declared target verbatim.
  assert.equal(arenaCalls.length >= 1, true);
  assert.deepEqual(
    { connectionId: '00000000-0000-0000-0000-0000000000c0', operation: 'requestCapability' },
    arenaCalls[arenaCalls.length - 1]!,
  );

  // (c) FULFILLED: the provider result echoes the request (never re-asserted).
  const result = await capabilities.recordProviderCapabilityResult({
    scope: aliceScope,
    requestId: request.requestId,
    deliveredArtifact: { videoUrl: 'https://artifacts.example/arena-delivery-1.mp4', durationSeconds: 42 },
    grantedRights: { usageScope: 'lab-simulation-and-production', redistribution: false, attributionRequired: true, licenseTerms: null },
  });
  assert.equal(result.fulfillmentKind, 'provider');
  assert.equal(result.actor, 'autonomous');
  assert.equal(result.providerAdapterKey, 'arena');
  assert.equal(result.providerRecordId, 'arena-delivery-1');
  assert.equal(result.grantedRights?.usageScope, 'lab-simulation-and-production');

  // (d) VERIFIED: the DECLARED evaluator runs (the contract's declaration, echoed on the record).
  const verification = await capabilities.verifyCapabilityResult({ scope: aliceScope, resultId: result.resultId });
  assert.equal(verification.verdict, 'pass');
  assert.equal(verification.evaluatorId, 'quality-shape-evaluator');
  assert.equal(verification.evaluatorVersion, '1');
  assert.equal((verification.evaluationEvidence as Record<string, unknown>)['shapeCheckOk'], true);

  // (e) INSERTED: the capability version cites the passing verification; the
  // gap advances contracted → resolved; the origin is DERIVED.
  const version = await capabilities.insertCapabilityVersion({
    scope: aliceScope,
    sourceVerificationId: verification.verificationId,
    declaration: declaration(),
  });
  assert.equal(version.capabilityVersion, 1);
  assert.equal(version.capabilityVersionReference, `${version.capabilityId}#v1`);
  assert.equal(version.status, 'draft');
  assert.equal(version.origin, 'arena_provider');
  assert.equal(version.sourceVerificationId, verification.verificationId);
  assert.equal(version.sourceGapId, gap.gapId);
  assert.equal(version.verification.verified, true);
  assert.equal(version.verification.verdict, 'pass');
  assert.ok(version.verification.verifiedAt !== null);
  // The gap is RESOLVED by the insertion.
  const gapResolved = await capabilities.getCapabilityGap(aliceScope, gap.gapId);
  assert.equal(gapResolved.status, 'resolved');

  // The guarded lifecycle: draft → active → retired (the LAB-011 precedent).
  const active = await capabilities.activateCapability(aliceScope, version.capabilityId);
  assert.equal(active.status, 'active');
  assert.equal(active.verification.verified, true, 'the verified state follows the record through the lifecycle');

  // The simulation link (the OPAQUE /lab citation).
  const simulation = await capabilities.recordCapabilitySimulation({
    scope: aliceScope,
    capabilityId: version.capabilityId,
    capabilityVersion: 1,
    simulationReference: '00000000-0000-0000-0000-0000000000r1#v2',
    outcome: 'passed',
    evidence: { rewardDelta: 0.11, seeds: 8 },
  });
  assert.equal(simulation.outcome, 'passed');
  assert.equal(simulation.simulationReference, '00000000-0000-0000-0000-0000000000r1#v2');

  // The real-test link (the OPAQUE real-authority citation).
  const realTest = await capabilities.recordCapabilityRealTest({
    scope: aliceScope,
    capabilityId: version.capabilityId,
    capabilityVersion: 1,
    realTestCitation: { authority: 'experiments', recordReference: '00000000-0000-0000-0000-0000000000e1' },
    outcome: 'inconclusive',
    evidence: { note: 'held-out set pending' },
  });
  assert.equal(realTest.outcome, 'inconclusive');
  assert.equal(realTest.realTestCitation.authority, 'experiments');

  // The read surfaces: the reference resolution + the listing.
  const byReference = await capabilities.getCapabilityByReference(aliceScope, labCapabilityVersionReference(version.capabilityId, 1));
  assert.equal(byReference.capabilityId, version.capabilityId);
  assert.equal(byReference.origin, 'arena_provider');
  const listed = await capabilities.listCapabilities(aliceScope, { status: 'active' });
  assert.ok(listed.some((entry) => entry.capabilityId === version.capabilityId));

  // The append-only correction: a NEW version row (the chain key immutable).
  const corrected = await capabilities.correctCapability({
    scope: aliceScope,
    capabilityId: version.capabilityId,
    declaration: declaration({ displayName: 'Physical performance stunt (acquired, corrected cost)' , cost: { costModel: 'abstract-units', costUnits: 35 } }),
  });
  assert.equal(corrected.capabilityVersion, 2);
  assert.equal(corrected.status, 'draft');
  assert.equal(corrected.origin, 'first_party_declared');
  assert.equal(corrected.verification.verified, false, 'a correction is honestly unverified until new verified evidence exists');
  const chain = await capabilities.listCapabilityVersions(aliceScope, version.capabilityId);
  assert.deepEqual(chain.map((entry) => entry.capabilityVersion), [1, 2]);

  // Retire the ACTIVE version 1 (the latest is 2/draft — retire applies to
  // the latest; use the module on version 1 through the reference path).
  await assert.rejects(
    () => capabilities.retireCapability(aliceScope, version.capabilityId),
    (error: unknown) => error instanceof InvalidRequestError && /draft/.test(error.message),
    'retire applies to the LATEST version — the draft correction blocks it (the LAB-011 per-version gate)',
  );
});

// ---------------------------------------------------------------------------
// (f) NO SECOND MARKETPLACE AUTHORITY — the honest failed dispatch + the port throw
// ---------------------------------------------------------------------------

test('LAB-013: the failed provider outcome is the honest failed request — never a fabricated success; a port throw is recorded the same way', async () => {
  const { request } = await chainToRequest(aliceScope);
  nextArenaOutcome = { ok: false, providerRecordId: null, data: null, error: 'provider refused: capability outside contract' };
  const failed = await capabilities.dispatchCapabilityRequest({
    scope: aliceScope,
    requestId: request.requestId,
    provenance: DISPATCH_PROVENANCE,
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.providerOk, false);
  assert.ok(failed.providerError !== null && failed.providerError.includes('provider refused'));
  // A provider result may NOT bind a failed dispatch.
  await assert.rejects(
    () => capabilities.recordProviderCapabilityResult({
      scope: aliceScope,
      requestId: request.requestId,
      deliveredArtifact: { videoUrl: 'https://artifacts.example/x.mp4' },
    }),
    (error: unknown) => error instanceof InvalidRequestError && /completed successful dispatch/.test(error.message),
  );

  // The port-level throw (transport failure) is the honest failed state.
  const { request: request2 } = await chainToRequest(aliceScope);
  nextArenaOutcome = 'throw';
  const thrown = await capabilities.dispatchCapabilityRequest({
    scope: aliceScope,
    requestId: request2.requestId,
    provenance: DISPATCH_PROVENANCE,
  });
  assert.equal(thrown.status, 'failed');
  assert.equal(thrown.providerOk, false);
  assert.ok(thrown.providerError !== null && thrown.providerError.includes('port error'));
  nextArenaOutcome = { ok: true, providerRecordId: 'arena-delivery-1', data: null, error: null };

  // The provider echo is FROZEN after the advance (the DB backstop).
  await assert.rejects(
    () => db!.query(
      `UPDATE lab_capability_requests SET provider_ok = true, provider_error = NULL WHERE request_id = $1`,
      [thrown.requestId],
    ),
    /provider echo is frozen after the dispatch advance/,
  );
});

// ---------------------------------------------------------------------------
// (c)+(d)+(e) The human-plane fulfillment + the failing verification + the citation gate
// ---------------------------------------------------------------------------

test('LAB-013: the human-plane fulfillment — the canonical plane cited OPAQUELY, the pending request advanced with the provider echo honestly null', async () => {
  const { gap, request } = await chainToRequest(aliceScope);
  const result = await capabilities.recordHumanPlaneCapabilityResult({
    scope: aliceScope,
    requestId: request.requestId,
    humanPlaneCitation: { planeAuthority: 'jobs', recordReference: '00000000-0000-0000-0000-0000000000j9' },
    deliveredArtifact: { videoUrl: 'https://artifacts.example/human-plane-1.mp4', durationSeconds: 55 },
    grantedRights: null,
  });
  assert.equal(result.fulfillmentKind, 'human_plane');
  assert.equal(result.actor, 'human');
  assert.equal(result.humanPlaneCitation?.planeAuthority, 'jobs');
  assert.equal(result.grantedRights, null, 'NULL = nothing granted beyond the explicit contract statement (the §17 rule)');

  // The request advanced to completed with the provider echo honestly null.
  const advanced = await capabilities.getCapabilityRequest(aliceScope, request.requestId);
  assert.equal(advanced.status, 'completed');
  assert.equal(advanced.providerOk, null);
  assert.equal(advanced.dispatchedAt, null);

  // The verification passes; the inserted version derives the
  // human_contribution origin.
  const verification = await capabilities.verifyCapabilityResult({ scope: aliceScope, resultId: result.resultId, actor: 'human' });
  assert.equal(verification.verdict, 'pass');
  assert.equal(verification.actor, 'human');
  const version = await capabilities.insertCapabilityVersion({
    scope: aliceScope,
    sourceVerificationId: verification.verificationId,
    declaration: declaration({ capabilityKey: 'human-demonstration', displayName: 'Authentic human demonstration (acquired)' }),
  });
  assert.equal(version.origin, 'human_contribution');
  assert.equal(version.sourceGapId, gap.gapId);
  assert.equal(version.verification.verified, true);
});

test('LAB-013: the failing verification — the version citation gate (module + DB backstop) enforces the unverified-never-presented rule', async () => {
  const { request } = await chainToRequest(aliceScope);
  nextArenaOutcome = { ok: true, providerRecordId: 'arena-delivery-9', data: null, error: null };
  await capabilities.dispatchCapabilityRequest({ scope: aliceScope, requestId: request.requestId, provenance: DISPATCH_PROVENANCE });
  // The delivered artifact VIOLATES the declared output schema.
  const result = await capabilities.recordProviderCapabilityResult({
    scope: aliceScope,
    requestId: request.requestId,
    deliveredArtifact: { videoUrl: 42 },
  });
  const verification = await capabilities.verifyCapabilityResult({ scope: aliceScope, resultId: result.resultId });
  assert.equal(verification.verdict, 'fail');
  assert.equal((verification.evaluationEvidence as Record<string, unknown>)['shapeCheckOk'], false);

  // The MODULE gate: inserting a version citing the failing verification is rejected.
  await assert.rejects(
    () => capabilities.insertCapabilityVersion({
      scope: aliceScope,
      sourceVerificationId: verification.verificationId,
      declaration: declaration({ capabilityKey: 'must-never-insert' }),
    }),
    (error: unknown) => error instanceof InvalidRequestError && /PASSING verification/.test(error.message),
  );

  // The DB backstop: the citation trigger rejects the direct insert too.
  await assert.rejects(
    () => db!.query(
      `INSERT INTO lab_capability_versions
         (capability_id, capability_version, agency_id, client_id, workspace_id, capability_key, display_name,
          status, actor, input_schema, output_schema, constraints, quality_evaluator, cost, latency, origin,
          provenance, implementation, simulator_implementation, real_implementation, requirements,
          source_verification_id, source_gap_id, contract_version, created_at, updated_at)
       VALUES ($1, 1, $2, $3, NULL, 'direct-insert-probe', 'probe', 'draft', 'autonomous', '{}', '{}', '[]',
               $4, $5, $6, 'arena_provider', $7, $8, NULL, NULL, '[]', $9, NULL, 'lab-capabilities-contract-v1',
               now(), now())`,
      [
        '00000000-0000-0000-0000-00000000d001',
        aliceScope.agencyId,
        aliceScope.clientId,
        JSON.stringify(QUALITY_EVALUATOR),
        JSON.stringify({ costModel: 'abstract-units', costUnits: 1 }),
        JSON.stringify({ expectedP50Ms: 1, expectedP95Ms: 2, deadlineMs: 1000 }),
        JSON.stringify({ origin: 'arena_provider', sourceNote: 'probe' }),
        JSON.stringify({ implementationId: 'probe', implementationVersion: '1', implementationKind: 'real' }),
        verification.verificationId,
      ],
    ),
    /may cite only a PASSING verification/,
  );
});

test('LAB-013: the first-party declared path — honestly unverified (the verified state is the linked evidence, never an asserted boolean)', async () => {
  const version = await capabilities.insertCapabilityVersion({
    scope: aliceScope,
    declaration: declaration({ capabilityKey: 'first-party-declared-transform', displayName: 'First-party declared transform' }),
  });
  assert.equal(version.origin, 'first_party_declared');
  assert.equal(version.sourceVerificationId, null);
  assert.equal(version.sourceGapId, null);
  assert.deepEqual(version.verification, {
    verified: false,
    verificationId: null,
    verdict: null,
    evaluatorId: null,
    evaluatorVersion: null,
    verifiedAt: null,
  });
  // Activation does NOT require verification (the rule governs
  // PRESENTATION as verified, not registration).
  const active = await capabilities.activateCapability(aliceScope, version.capabilityId);
  assert.equal(active.status, 'active');
  assert.equal(active.verification.verified, false);
});

// ---------------------------------------------------------------------------
// (i) The DB backstops — append-only, guarded lifecycles, the estimate supersession
// ---------------------------------------------------------------------------

test('LAB-013: the append-only backstops — result/verification UPDATE+DELETE rejected, the gap lifecycle guarded', async () => {
  const { gap, request } = await chainToRequest(aliceScope);
  nextArenaOutcome = { ok: true, providerRecordId: 'arena-delivery-2', data: null, error: null };
  await capabilities.dispatchCapabilityRequest({ scope: aliceScope, requestId: request.requestId, provenance: DISPATCH_PROVENANCE });
  const result = await capabilities.recordProviderCapabilityResult({
    scope: aliceScope,
    requestId: request.requestId,
    deliveredArtifact: { videoUrl: 'https://artifacts.example/arena-delivery-2.mp4' },
  });
  await assert.rejects(
    () => db!.query(`UPDATE lab_capability_results SET delivered_artifact = '{}' WHERE result_id = $1`, [result.resultId]),
    /append-only/,
  );
  await assert.rejects(
    () => db!.query(`DELETE FROM lab_capability_results WHERE result_id = $1`, [result.resultId]),
    /append-only/,
  );
  const verification = await capabilities.verifyCapabilityResult({ scope: aliceScope, resultId: result.resultId });
  await assert.rejects(
    () => db!.query(`UPDATE lab_capability_verifications SET verdict = 'pass' WHERE verification_id = $1`, [verification.verificationId]),
    /append-only/,
  );
  await assert.rejects(
    () => db!.query(`DELETE FROM lab_capability_verifications WHERE verification_id = $1`, [verification.verificationId]),
    /append-only/,
  );
  // No row of ANY stage table is ever deleted.
  await assert.rejects(
    () => db!.query(`DELETE FROM lab_capability_gaps WHERE gap_id = $1`, [gap.gapId]),
    /append-only/,
  );
  // The gap lifecycle: open → resolved is illegal (resolved is
  // terminal-reachable only from contracted).
  const openGap = await capabilities.detectCapabilityGap({
    scope: aliceScope,
    strategyCitation: { strategyKind: 'external', strategyReference: 'lifecycle-probe' },
    requiredAction: { actionKind: 'authentic_demonstration', description: 'An authentic human demonstration', qualityBar: 'authentic' },
    rationale: 'lifecycle probe',
  });
  await assert.rejects(
    () => db!.query(`UPDATE lab_capability_gaps SET status = 'resolved' WHERE gap_id = $1`, [openGap.gapId]),
    /is not legal/,
  );
  // The request lifecycle: no reopen.
  await assert.rejects(
    () => db!.query(`UPDATE lab_capability_requests SET status = 'pending' WHERE request_id = $1`, [request.requestId]),
    /is not legal/,
  );
});

test('LAB-013: the estimate supersession — a revision is a NEW record; the governed request binds the RECORDED estimate', async () => {
  const { gap, contract } = await chainToRequest(aliceScope);
  const first = await capabilities.recordCapabilityValueEstimate({
    scope: aliceScope,
    contractId: contract.contractId,
    figures: { estimatedValueUnits: 100, expectedQualityLift: 0.1, estimatedCostCeiling: 50, uncertainty: 'low', basis: 'first basis' },
  });
  const second = await capabilities.recordCapabilityValueEstimate({
    scope: aliceScope,
    contractId: contract.contractId,
    figures: { estimatedValueUnits: 140, expectedQualityLift: 0.2, estimatedCostCeiling: 45, uncertainty: 'low', basis: 'revised basis' },
  });
  assert.equal(second.status, 'recorded');
  const firstAfter = await capabilities.getCapabilityValueEstimate(aliceScope, first.estimateId);
  assert.equal(firstAfter.status, 'superseded', 'the prior RECORDED estimate was superseded — never rewritten');
  const tail = await capabilities.listCapabilityValueEstimates(aliceScope, { contractId: contract.contractId });
  assert.ok(tail.length >= 2);
  // A request citing the SUPERSEDED estimate is rejected (the ORIGINAL
  // chain's gap — still 'contracted': a request does not advance the gap).
  await assert.rejects(
    () => capabilities.createCapabilityRequest({
      scope: aliceScope,
      gapId: gap.gapId,
      contractId: contract.contractId,
      estimateId: first.estimateId,
      adapterKey: 'arena',
      connectionId: '00000000-0000-0000-0000-0000000000c0',
      operation: 'requestCapability',
      requestParameters: {},
      requestedRights: { usageScope: 'lab-simulation', redistribution: false, attributionRequired: true, licenseTerms: null },
    }),
    (error: unknown) => error instanceof InvalidRequestError && /recorded estimate/.test(error.message),
  );
  void second;
});

// ---------------------------------------------------------------------------
// (h) Tenant isolation (§22) — the uniform NotFound + the DB injection fences
// ---------------------------------------------------------------------------

test('LAB-013: tenant isolation — the uniform NotFound for foreign scope (no existence oracle) + the cross-tenant chain injection rejected at the DB', async () => {
  const { gap, request } = await chainToRequest(aliceScope);
  // The uniform NotFound: foreign and unknown ids are indistinguishable.
  for (const probe of [
    () => capabilities.getCapabilityGap(bobScope, gap.gapId),
    () => capabilities.getCapabilityRequest(bobScope, request.requestId),
    () => capabilities.getCapabilityGap(aliceScope, '00000000-0000-0000-0000-00000000f00f'),
  ]) {
    await assert.rejects(probe, NotFoundError);
  }
  // The malformed id shapes resolve to the same uniform NotFound.
  await assert.rejects(() => capabilities.getCapabilityGap(aliceScope, 'not-a-uuid'), NotFoundError);

  // The DB backstop: a cross-tenant chain injection (Bob's contract row
  // citing Alice's gap) is rejected by the scope trigger.
  await assert.rejects(
    () => db!.query(
      `INSERT INTO lab_capability_contracts
         (contract_id, gap_id, agency_id, client_id, workspace_id, status, actor, input_schema, output_schema,
          constraints, quality_evaluator, cost_ceiling, latency_ceiling, requirements, contract_version,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, NULL, 'derived', 'autonomous', '{}', '{}', '[]', $5, $6, $7, '[]',
               'lab-capabilities-contract-v1', now(), now())`,
      [
        '00000000-0000-0000-0000-00000000d002',
        gap.gapId,
        bobScope.agencyId,
        bobScope.clientId,
        JSON.stringify(QUALITY_EVALUATOR),
        JSON.stringify({ costModel: 'abstract-units', costUnits: 1 }),
        JSON.stringify({ deadlineMs: 1000 }),
      ],
    ),
    /cross-tenant chain injection is rejected/,
  );

  // The workspace anchor rides every row (§22).
  const scoped = await capabilities.detectCapabilityGap({
    scope: { agencyId: aliceScope.agencyId, clientId: aliceScope.clientId, workspaceId: aliceWorkspaceId },
    strategyCitation: { strategyKind: 'external', strategyReference: 'ws-probe' },
    requiredAction: { actionKind: 'platform_action_gap', description: 'A platform-specific action unsupported by APIs', qualityBar: 'parity' },
    rationale: 'workspace probe',
  });
  assert.equal(scoped.workspaceId, aliceWorkspaceId);
});

// ---------------------------------------------------------------------------
// (g) The Arena discovery passthrough (READ-ONLY through the structural port)
// ---------------------------------------------------------------------------

test('LAB-013: the Arena discovery passthrough — the provider registry AS DATA through the two-method port', () => {
  const providers = capabilities.listArenaProviders();
  assert.equal(providers.length, 1);
  assert.equal(providers[0]!.descriptor.adapterKey, 'arena');
  assert.equal(providers[0]!.capabilities[0]!.operations[0], 'requestCapability');
});
