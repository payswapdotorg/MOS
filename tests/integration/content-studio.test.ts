/**
 * STUDIO-001 + STUDIO-002 integration tests — the /content-studio
 * Content Studio Runtime AND the Pluggable Format Framework against a
 * REAL embedded PostgreSQL stack + the REAL /lab-agent-body module
 * instance behind the composition-parity adapter (exactly as the
 * composition root wires it: platform ports + the disclosed READ-ONLY
 * organization-compatibility port + the §2 format seam). The step
 * EXECUTION drivers are the test's — the runtime's claim/complete
 * surface is driven externally, exactly as the durable worker
 * infrastructure drives it in production.
 *
 * The Work Items' named acceptance battery (spec/
 * effective-backlog-v1.7.md STUDIO-001: "tenant-scoped versioned
 * production sessions, asynchronous/durable processing, guarded
 * lifecycle, no publishing/experiment authority"; STUDIO-002: "Build
 * the format contract and registry. Acceptance: formats declare
 * input, participant, capture, interviewer, organization, output,
 * provenance and evaluation contracts; new formats do not require
 * another Studio runtime."):
 *   (a) THE FULL LIFECYCLE: standalone request → open session (the
 *       REAL organization compatibility validation through the REAL
 *       /lab-agent-body registry) → preparing → processing (the
 *       durable step plan persisted) → claim → complete → the
 *       order-independent plan finalization (the output version
 *       recorded + the guarded processing → review advance) →
 *       completed — with the append-only audit tail carrying every
 *       transition;
 *   (b) THE DURABILITY GUARANTEE: a SECOND module instance over the
 *       same database (the restart simulation) continues the SAME
 *       session from the persisted step state — processing state
 *       lives in PostgreSQL, never module memory;
 *   (c) THE GUARDED LIFECYCLE: illegal edges rejected at the module
 *       AND at the DB trigger; terminal revisions frozen outright;
 *       expiry gated on the request deadline (the clock port);
 *   (d) THE TREATMENT LOOP: review → requestTreatment (with an
 *       alternate organization requiring a revised request binding it
 *       VERBATIM) → the prior revision closed treatment_requested +
 *       frozen → the successor revision born created, linked to the
 *       prior output → its output version carries the parent linkage
 *       (lock v1.7 #42);
 *   (e) THE ORGANIZATION COMPATIBILITY CONTRACT: nonexistent body,
 *       inactive body and insufficient permissions each fail
 *       EXPLICITLY with every incompatibility listed — and NO session
 *       opens (never a silent replacement);
 *   (f) THE TENANT ISOLATION: Bob's scope resolves Alice's
 *       request/session/step/output to the uniform NotFound (no
 *       existence oracle) + the DB scope-consistency triggers reject
 *       cross-tenant injection;
 *   (g) THE ENTRY-MODE FENCE: lab_initiated opens with the Lab
 *       binding; standalone MUST NOT carry Lab fields;
 *   (h) THE DURABLE STEP DISCIPLINE: the honest §17 failure record,
 *       the explicit caller requeue under the declared stopping
 *       policy, the claim CAS (no double-claim) and the §18
 *       output-contract validation rolling back an incomplete package;
 * plus the format-seam pluggability on the real stack (a custom
 * future format through the SAME seam) and the DB append-only
 * backstops (requests/events/outputs/treatments immutable).
 *
 * The STUDIO-002 battery (the format registry over the runtime):
 *   (i) THE PLUGGABILITY PROOF (the core acceptance): a test-only
 *       CUSTOM format registered through the PUBLIC SEAM
 *       (registerFormat → activateFormat) drives a FULL session
 *       end-to-end through the SAME runtime — ZERO runtime changes;
 *   (j) THE REGISTRY SEMANTICS: registration (draft; duplicates and
 *       broken version chains rejected), activation (draft-only,
 *       honest errors for the illegal lifecycle advances), version
 *       corrections (the append-only chain — v2 binds new sessions),
 *       retirement (new sessions refuse; RUNNING sessions never
 *       break — the running session's steps complete, its treatment
 *       loop opens the successor revision and the new output links
 *       the prior one) and the composition-wired initial formats
 *       (materialize-if-absent per scope, born active, never
 *       resurrected after a tenant's retirement);
 *   (k) THE COMPATIBILITY RESOLUTION: a production request's selected
 *       format resolves through the registry — ACTIVE versions only
 *       (draft/retired refuse with the honest lifecycle state);
 *       foreign scope resolves to the uniform NotFound (no existence
 *       oracle — Bob cannot resolve Alice's custom format);
 *   (l) THE FORMAT-CAPABILITY LINK RECORDS: the normalized
 *       requiredCapabilities ride the registry row; the DB backstops
 *       (born-draft, identity immutable, no delete, the
 *       activation-consistency fence, the chain-scope fence, the link
 *       scope fence, the link immutability) reject direct injection.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  bootStack,
  shutdownStack,
  type IntegrationStack,
} from './helpers/harness.ts';
import { PgDb } from '../../src/platform/db/adapters/postgres/pg-db.ts';
import { SystemClock, FakeClock } from '../../src/platform/clock/clock.ts';
import { CryptoIdGenerator } from '../../src/platform/ids/ids.ts';
import { createUsersModule } from '../../src/modules/users/public.ts';
import { createAgenciesModule } from '../../src/modules/agencies/public.ts';
import { createClientsModule } from '../../src/modules/clients/public.ts';
import { createLabAgentBodyModule, type LabAgentBodyActionKind, type LabAgentBodyContract } from '../../src/modules/lab-agent-body/public.ts';
import {
  createContentStudioModule,
  CONTENT_STUDIO_INITIAL_FORMATS,
  type ContentStudioAgentBodyPort,
  type ContentStudioModuleApi,
  type ContentStudioProductionRequestContent,
  type ContentStudioScope,
  type ContentStudioFormatDeclaration,
} from '../../src/modules/content-studio/public.ts';
import { NotFoundError, InvalidRequestError } from '../../src/platform/errors/errors.ts';

let stack: IntegrationStack | null = null;
let db: PgDb | null = null;
let studio: ContentStudioModuleApi = null as unknown as ContentStudioModuleApi;
let agentBody: ReturnType<typeof createLabAgentBodyModule> = null as unknown as ReturnType<typeof createLabAgentBodyModule>;

// The tenant fixtures: Alice's agency + client, Bob's agency + client.
const aliceScope: { agencyId: string; clientId: string } = { agencyId: '', clientId: '' };
const bobScope: { agencyId: string; clientId: string } = { agencyId: '', clientId: '' };

/** The composition-parity organization port (the disclosed composition-root adapter, verbatim). */
function compositionParityAgentBodies(agentBodyModule: ReturnType<typeof createLabAgentBodyModule>): ContentStudioAgentBodyPort {
  return {
    async resolveAgentBody(scope, bodyVersionReference) {
      try {
        const body = await agentBodyModule.getBodyByReference(
          { agencyId: scope.agencyId, clientId: scope.clientId, workspaceId: scope.workspaceId ?? null },
          bodyVersionReference,
        );
        return {
          bodyVersionReference,
          status: body.status,
          permissions: body.contract.permissions,
          safetyConstraints: body.contract.safetyConstraints,
          capabilities: body.contract.capabilities,
        };
      } catch {
        return null;
      }
    },
  };
}

function buildStudio(dbInstance: PgDb, formats: ReadonlyArray<ContentStudioFormatDeclaration> = CONTENT_STUDIO_INITIAL_FORMATS, clock = new SystemClock()): ContentStudioModuleApi {
  return createContentStudioModule({
    db: dbInstance,
    clock,
    ids: new CryptoIdGenerator(),
    agentBodies: compositionParityAgentBodies(agentBody),
    formats,
  });
}

before(async () => {
  stack = await bootStack('content_studio');
  db = new PgDb(stack.env.databaseUrl, 4);
  const clock = new SystemClock();
  const ids = new CryptoIdGenerator();
  const users = createUsersModule({ db, clock, ids });
  const agencies = createAgenciesModule({ db, clock, ids, users });
  const clients = createClientsModule({ db, clock, ids, agencies });
  // The REAL /lab-agent-body module instance (the pawn runtime — the
  // organization bodies resolve through its real registry).
  agentBody = createLabAgentBodyModule({
    db,
    clock,
    ids,
    // The /ai-runtime port is never exercised by this battery (the
    // Studio resolves body REGISTRY reads only, never runs instances) —
    // an honest stub satisfies the structural port.
    aiRuntime: {
      getModel: async () => null,
      appendModelObservation: async () => {},
    },
  });
  studio = buildStudio(db);

  const aliceUser = await users.createUser({ email: 'alice@contentstudio.test', displayName: 'Alice' });
  const aliceAgency = await agencies.createAgency({ name: 'Alice Agency', slug: 'alice-studio', ownerUserId: aliceUser.userId, actorId: null });
  const aliceClient = await clients.createClient({ agencyId: aliceAgency.agency.agencyId, name: 'Alice Client', slug: 'alice-studio-client', actorId: null });
  aliceScope.agencyId = aliceAgency.agency.agencyId;
  aliceScope.clientId = aliceClient.clientId;

  const bobUser = await users.createUser({ email: 'bob@contentstudio.test', displayName: 'Bob' });
  const bobAgency = await agencies.createAgency({ name: 'Bob Agency', slug: 'bob-studio', ownerUserId: bobUser.userId, actorId: null });
  const bobClient = await clients.createClient({ agencyId: bobAgency.agency.agencyId, name: 'Bob Client', slug: 'bob-studio-client', actorId: null });
  bobScope.agencyId = bobAgency.agency.agencyId;
  bobScope.clientId = bobClient.clientId;
});

after(async () => {
  if (db !== null) await db.close();
  if (stack !== null) await shutdownStack(stack);
});

// ---------------------------------------------------------------------------
// The fixtures (the §14 body contract the Studio organizations cite).
// ---------------------------------------------------------------------------

function bodyContract(permissions: ReadonlyArray<LabAgentBodyActionKind>): LabAgentBodyContract {
  return {
    roleContract: { role: 'reaction-composer', description: 'Composes reaction output from source + capture.' },
    inputContract: { type: 'object', required: ['source'], properties: { source: { type: 'string' }, capture: { type: 'string' } } },
    outputContract: { type: 'object', required: ['final_media'], properties: { final_media: { type: 'string' } } },
    tools: [{ toolId: 'clip-selector', actionKind: 'read', description: 'Selects source clips.' }],
    permissions,
    memoryInterfaces: [{ memoryId: 'org-notes', kind: 'body_scoped', capacityEntries: 4 }],
    communicationInterface: [{ channelId: 'org-bus', direction: 'outbound', messageKind: 'composition' }],
    actionInterface: ['draft_content', 'cite_evidence'],
    capabilities: ['capability:clip-selection@v2'],
    budget: { maxModelInvocations: 3, maxToolInvocations: 5, maxTokensIn: 100_000, maxTokensOut: 100_000, maxCostUnits: 10 },
    latencyLimits: { deadlineMs: 60_000 },
    evaluationHooks: [{ hookId: 'quality-hook' }],
    safetyConstraints: ['no_fake_engagement', 'no_deceptive_attribution'],
  };
}

async function makeActiveBody(permissions: ReadonlyArray<LabAgentBodyActionKind> = ['read', 'transform', 'compose'], scope: ContentStudioScope = aliceScope): Promise<string> {
  const created = await agentBody.createBody({ scope, contract: bodyContract(permissions) });
  await agentBody.activateBody(scope, created.bodyId);
  return `${created.bodyId}#v${created.bodyVersion}`;
}

function standaloneRequest(bodyReference: string, overrides: Partial<ContentStudioProductionRequestContent> = {}): ContentStudioProductionRequestContent {
  return {
    entryMode: 'standalone',
    formatId: 'reaction',
    formatVersion: 1,
    organization: {
      organizationId: 'org-reaction-composer',
      organizationVersion: 1,
      agentBodyReferences: [bodyReference],
      capabilities: [],
    },
    input: {
      mode: 'intent',
      intent: 'A punchy reaction to the launch video.',
      sourceArtifactReferences: ['asset:01923f7e-8b1d-7abc-9def-0123456789cd'],
    },
    output: { requiredOutputs: ['final_media'] },
    acceptanceCriteria: ['hook lands in the first 3 seconds'],
    budget: { maxCostUnits: 12.5, maxDurationMs: 3_600_000 },
    deadline: '2099-12-01T12:00:00.000Z',
    delayStoppingPolicy: { retryLimit: 2 },
    provenanceConsent: { consentReferences: ['consent:participant-recording-1'] },
    ...overrides,
  };
}

/** Drives a session revision through the full lifecycle to review; returns the session + output. */
async function driveToReview(sessionId: string, scope: ContentStudioScope = aliceScope, module: ContentStudioModuleApi = studio) {
  let session = await module.getSession(scope, sessionId);
  if (session.state === 'created') {
    session = await module.advanceSession({ scope, sessionId, to: 'preparing' });
  }
  if (session.state === 'preparing') {
    session = await module.advanceSession({ scope, sessionId, to: 'processing' });
  }
  assert.equal(session.state, 'processing');
  const outputs: Array<{ outputVersionId: string }> = [];
  for (let round = 0; round < 8; round += 1) {
    const claimed = await module.claimProcessingSteps({ scope, sessionId, limit: 4, lockedBy: 'integration-driver' });
    if (claimed.length === 0) break;
    for (const step of claimed) {
      const isFinalStage = step.stageIndex === 3;
      const result = await module.completeProcessingStep({
        scope,
        stepId: step.stepId,
        output: isFinalStage
          ? { final_media: 'media:composed-reaction-1', transcript: 'text:composed-transcript' }
          : { intermediate: `artifact:${step.stageId}` },
        costUnits: 0.75,
        durationMs: 1_200,
      });
      if (result.outputVersion !== null) outputs.push({ outputVersionId: result.outputVersion.outputVersionId });
    }
  }
  session = await module.getSession(scope, sessionId);
  return { session, outputVersionId: outputs[0]?.outputVersionId ?? null };
}

// ---------------------------------------------------------------------------
// (a) THE FULL LIFECYCLE — the standalone happy path end-to-end.
// ---------------------------------------------------------------------------

test('STUDIO-001: the standalone lifecycle end-to-end — request → validated organization → preparing → processing (the persisted plan) → claim → complete → output version → review → completed, with the append-only audit tail', async () => {
  const bodyReference = await makeActiveBody();
  const request = await studio.createProductionRequest({ scope: aliceScope, content: standaloneRequest(bodyReference) });
  assert.equal(request.requestVersion, 1);
  assert.equal(request.content.entryMode, 'standalone');

  const session = await studio.openSession({ scope: aliceScope, requestId: request.requestId });
  assert.equal(session.state, 'created');
  assert.equal(session.revision, 1);
  assert.equal(session.requestVersion, 1);
  assert.equal(session.organizationValidation.resolvedBodies.length, 1);
  assert.equal(session.organizationValidation.resolvedBodies[0]!.bodyVersionReference, bodyReference);
  assert.equal(session.organizationValidation.resolvedBodies[0]!.status, 'active');

  // The guarded advance: created → preparing → processing.
  const preparing = await studio.advanceSession({ scope: aliceScope, sessionId: session.sessionId, to: 'preparing' });
  assert.equal(preparing.state, 'preparing');
  const processing = await studio.advanceSession({ scope: aliceScope, sessionId: session.sessionId, to: 'processing' });
  assert.equal(processing.state, 'processing');

  // THE DURABLE PLAN: one persisted step per declared stage (§9).
  const steps = await studio.listProcessingSteps(aliceScope, session.sessionId);
  assert.equal(steps.length, 3);
  assert.deepEqual(steps.map((step) => step.stageId), ['capture_ingestion', 'organization_treatment', 'output_assembly']);
  assert.ok(steps.every((step) => step.status === 'queued' && step.attempts === 0));

  // The claim + complete loop (the durable driver).
  const first = await studio.claimProcessingSteps({ scope: aliceScope, limit: 2, lockedBy: 'driver-1' });
  assert.equal(first.length, 2);
  assert.ok(first.every((step) => step.status === 'running' && step.lockedBy === 'driver-1'));

  const completionA = await studio.completeProcessingStep({ scope: aliceScope, stepId: first[0]!.stepId, output: { intermediate: 'artifact:capture' }, costUnits: 0.5, durationMs: 900 });
  assert.equal(completionA.step.status, 'succeeded');
  assert.equal(completionA.outputVersion, null, 'the plan is not complete yet');
  const completionB = await studio.completeProcessingStep({ scope: aliceScope, stepId: first[1]!.stepId, output: { intermediate: 'artifact:treatment' }, costUnits: 0.25, durationMs: 400 });
  assert.equal(completionB.outputVersion, null);

  // Advancing to review before the plan completes is refused (the runtime guard).
  await assert.rejects(
    () => studio.advanceSession({ scope: aliceScope, sessionId: session.sessionId, to: 'review' }),
    (error: unknown) => error instanceof InvalidRequestError && /non-succeeded processing step/.test(error.message),
  );

  // The final stage completes the plan: the output version is recorded
  // (validated against the request's output contract) and the session
  // advances processing → review through the guarded path.
  const second = await studio.claimProcessingSteps({ scope: aliceScope, limit: 4, lockedBy: 'driver-1' });
  assert.equal(second.length, 1);
  const finalCompletion = await studio.completeProcessingStep({
    scope: aliceScope,
    stepId: second[0]!.stepId,
    output: { final_media: 'media:composed-reaction-1' },
    costUnits: 1.0,
    durationMs: 2_000,
  });
  assert.equal(finalCompletion.step.status, 'succeeded');
  assert.ok(finalCompletion.outputVersion !== null);
  assert.equal(finalCompletion.session!.state, 'review');
  assert.equal(finalCompletion.outputVersion!.artifactPackage.final_media, 'media:composed-reaction-1');
  assert.equal(finalCompletion.outputVersion!.parentOutputVersionId, null);
  assert.ok(finalCompletion.outputVersion!.aggregateCostUnits > 0);

  // Review → completed (the standalone user accepts the result — §14).
  const completed = await studio.advanceSession({ scope: aliceScope, sessionId: session.sessionId, to: 'completed' });
  assert.equal(completed.state, 'completed');
  assert.equal(completed.terminalReason, null);

  // The append-only audit tail carries the whole journey.
  const events = await studio.listSessionEvents(aliceScope, session.sessionId);
  const kinds = events.map((event) => event.eventKind);
  assert.deepEqual(kinds, [
    'session_opened', 'organization_loaded', 'state_advanced',
    'processing_plan_recorded', 'state_advanced',
    'step_claimed', 'step_claimed', 'step_completed', 'step_completed',
    'step_claimed', 'step_completed', 'output_version_recorded',
    'state_advanced', 'state_advanced',
  ]);
  assert.ok(events.every((event) => /^[0-9a-f]{64}$/.test(event.payloadDigest)));
  const outputs = await studio.getSessionOutputs(aliceScope, session.sessionId);
  assert.equal(outputs.length, 1);
});

// ---------------------------------------------------------------------------
// (b) THE DURABILITY GUARANTEE — the restart simulation.
// ---------------------------------------------------------------------------

test('STUDIO-001: THE DURABILITY PROOF — a SECOND module instance over the same database continues the SAME session from the persisted step state (processing state is never in-memory)', async () => {
  const bodyReference = await makeActiveBody();
  const request = await studio.createProductionRequest({ scope: aliceScope, content: standaloneRequest(bodyReference) });
  const session = await studio.openSession({ scope: aliceScope, requestId: request.requestId });
  await studio.advanceSession({ scope: aliceScope, sessionId: session.sessionId, to: 'preparing' });
  await studio.advanceSession({ scope: aliceScope, sessionId: session.sessionId, to: 'processing' });

  // Claim + complete ONE step with the first instance.
  const first = await studio.claimProcessingSteps({ scope: aliceScope, sessionId: session.sessionId, limit: 1, lockedBy: 'instance-a' });
  assert.equal(first.length, 1);
  await studio.completeProcessingStep({ scope: aliceScope, stepId: first[0]!.stepId, output: { intermediate: 'artifact:capture' } });

  // THE RESTART: a brand-new module instance over the SAME database.
  const restarted = buildStudio(db!);
  const sessionAfter = await restarted.getSession(aliceScope, session.sessionId);
  assert.equal(sessionAfter.state, 'processing', 'the session state survived the restart');
  const stepsAfter = await restarted.listProcessingSteps(aliceScope, session.sessionId);
  assert.equal(stepsAfter.filter((step) => step.status === 'succeeded').length, 1, 'the completed step survived the restart');
  assert.equal(stepsAfter.filter((step) => step.status === 'queued').length, 2, 'the pending steps survived the restart');

  // The restarted instance continues the SAME session to completion.
  const claimed = await restarted.claimProcessingSteps({ scope: aliceScope, sessionId: session.sessionId, limit: 4, lockedBy: 'instance-b' });
  assert.equal(claimed.length, 2);
  for (const step of claimed) {
    await restarted.completeProcessingStep({
      scope: aliceScope,
      stepId: step.stepId,
      output: step.stageIndex === 3 ? { final_media: 'media:composed-after-restart' } : { intermediate: 'artifact:treatment' },
    });
  }
  const finished = await restarted.getSession(aliceScope, session.sessionId);
  assert.equal(finished.state, 'review');
  const outputs = await restarted.getSessionOutputs(aliceScope, session.sessionId);
  assert.equal(outputs.length, 1);
  assert.equal((outputs[0]!.artifactPackage as Record<string, unknown>).final_media, 'media:composed-after-restart');
});

// ---------------------------------------------------------------------------
// (c) THE GUARDED LIFECYCLE — illegal edges + the terminal freeze + the expiry clock.
// ---------------------------------------------------------------------------

test('STUDIO-001: the guarded lifecycle — illegal edges are rejected at the module AND at the DB trigger; terminal revisions are frozen outright', async () => {
  const bodyReference = await makeActiveBody();
  const request = await studio.createProductionRequest({ scope: aliceScope, content: standaloneRequest(bodyReference) });
  const session = await studio.openSession({ scope: aliceScope, requestId: request.requestId });

  // The module guards: the skipped-state jump is refused.
  await assert.rejects(
    () => studio.advanceSession({ scope: aliceScope, sessionId: session.sessionId, to: 'review' }),
    (error: unknown) => error instanceof InvalidRequestError && /not legal/.test(error.message),
  );
  // The terminal-reason fence: cancelled without a reason is refused.
  await assert.rejects(
    () => studio.advanceSession({ scope: aliceScope, sessionId: session.sessionId, to: 'cancelled' }),
    (error: unknown) => error instanceof InvalidRequestError && /terminalReason/.test(error.message),
  );
  // Expiry before the deadline is refused (the honest §17 delay bound).
  await assert.rejects(
    () => studio.advanceSession({ scope: aliceScope, sessionId: session.sessionId, to: 'expired', terminalReason: 'deadline_passed' }),
    (error: unknown) => error instanceof InvalidRequestError && /cannot expire before the request deadline/.test(error.message),
  );

  // The honest cancellation path.
  const cancelled = await studio.advanceSession({ scope: aliceScope, sessionId: session.sessionId, to: 'cancelled', terminalReason: 'user_cancelled' });
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.terminalReason, 'user_cancelled');

  // The DB trigger backstops: a terminal revision is frozen outright.
  await assert.rejects(
    () => db!.query(`UPDATE studio_sessions SET state = 'processing' WHERE session_id = $1 AND revision = 1`, [session.sessionId]),
    /terminal revisions are frozen/,
  );

  // The DB trigger backstop: an illegal edge is rejected even by a direct write.
  const request2 = await studio.createProductionRequest({ scope: aliceScope, content: standaloneRequest(bodyReference) });
  const session2 = await studio.openSession({ scope: aliceScope, requestId: request2.requestId });
  await assert.rejects(
    () => db!.query(`UPDATE studio_sessions SET state = 'review' WHERE session_id = $1 AND revision = 1`, [session2.sessionId]),
    /not legal/,
  );
  // The identity immutability backstop.
  await assert.rejects(
    () => db!.query(`UPDATE studio_sessions SET format_id = 'audio-podcast' WHERE session_id = $1 AND revision = 1`, [session2.sessionId]),
    /immutable/,
  );
});

test('STUDIO-001: the expiry path — the deadline gate opens only after the clock passes the request deadline (the FakeClock proof)', async () => {
  const bodyReference = await makeActiveBody();
  // A module instance on the FAKE clock (the deterministic time port).
  const fakeClock = new FakeClock(Date.parse('2026-01-01T00:00:00.000Z'));
  const clocked = createContentStudioModule({
    db: db!,
    clock: fakeClock,
    ids: new CryptoIdGenerator(),
    agentBodies: compositionParityAgentBodies(agentBody),
    formats: CONTENT_STUDIO_INITIAL_FORMATS,
  });
  const content = standaloneRequest(bodyReference, { deadline: '2026-06-01T00:00:00.000Z' });
  const request = await clocked.createProductionRequest({ scope: aliceScope, content });
  const session = await clocked.openSession({ scope: aliceScope, requestId: request.requestId });

  // Before the deadline: expiry is refused.
  await assert.rejects(
    () => clocked.advanceSession({ scope: aliceScope, sessionId: session.sessionId, to: 'expired', terminalReason: 'deadline_passed' }),
    /cannot expire before the request deadline/,
  );
  // After the deadline: the honest expiry lands.
  fakeClock.set(Date.parse('2026-07-01T00:00:00.000Z'));
  const expired = await clocked.advanceSession({ scope: aliceScope, sessionId: session.sessionId, to: 'expired', terminalReason: 'deadline_passed' });
  assert.equal(expired.state, 'expired');
  assert.equal(expired.terminalReason, 'deadline_passed');
});

// ---------------------------------------------------------------------------
// (d) THE TREATMENT LOOP — the linked revision + the output lineage.
// ---------------------------------------------------------------------------

test('STUDIO-001: THE TREATMENT LOOP — requestTreatment closes the reviewed revision, opens the linked successor (the alternate organization bound VERBATIM through a revised request) and the successor output carries the parent lineage', async () => {
  const bodyReference = await makeActiveBody();
  const request = await studio.createProductionRequest({ scope: aliceScope, content: standaloneRequest(bodyReference) });
  const session = await studio.openSession({ scope: aliceScope, requestId: request.requestId });
  const { outputVersionId } = await driveToReview(session.sessionId);
  assert.notEqual(outputVersionId, null);

  // A treatment WITH an alternate organization but WITHOUT the revised
  // request is refused (the §4 no-silent-replacement fence).
  const alternateBodyReference = await makeActiveBody();
  await assert.rejects(
    () => studio.requestTreatment({
      scope: aliceScope,
      sessionId: session.sessionId,
      targetOutputVersionId: outputVersionId!,
      treatment: {
        defect: 'The intro trails off.',
        desiredChange: 'Tighten the first 3 seconds.',
        alternateOrganization: {
          organizationId: 'org-reaction-composer',
          organizationVersion: 2,
          agentBodyReferences: [alternateBodyReference],
          capabilities: [],
        },
      },
    }),
    (error: unknown) => error instanceof InvalidRequestError && /revisedRequest/.test(error.message),
  );

  // The alternate organization must be bound VERBATIM by the revised request.
  const mismatchedRevision = standaloneRequest(bodyReference, {
    organization: { organizationId: 'org-reaction-composer', organizationVersion: 2, agentBodyReferences: [bodyReference], capabilities: [] },
  });
  await assert.rejects(
    () => studio.requestTreatment({
      scope: aliceScope,
      sessionId: session.sessionId,
      targetOutputVersionId: outputVersionId!,
      treatment: {
        defect: 'The intro trails off.',
        desiredChange: 'Tighten the first 3 seconds.',
        alternateOrganization: { organizationId: 'org-reaction-composer', organizationVersion: 2, agentBodyReferences: [alternateBodyReference], capabilities: [] },
      },
      revisedRequest: mismatchedRevision,
    }),
    (error: unknown) => error instanceof InvalidRequestError && /VERBATIM/.test(error.message),
  );

  // The sanctioned treatment: alternate organization + the revised
  // request binding it exactly.
  const result = await studio.requestTreatment({
    scope: aliceScope,
    sessionId: session.sessionId,
    targetOutputVersionId: outputVersionId!,
    treatment: {
      defect: 'The intro trails off.',
      desiredChange: 'Tighten the first 3 seconds.',
      targetQuality: 'hook-quality-v2',
      affectedArtifacts: ['final_media'],
      alternateOrganization: { organizationId: 'org-reaction-composer', organizationVersion: 2, agentBodyReferences: [alternateBodyReference], capabilities: [] },
      retryLimit: 1,
    },
    revisedRequest: standaloneRequest(alternateBodyReference, {
      organization: { organizationId: 'org-reaction-composer', organizationVersion: 2, agentBodyReferences: [alternateBodyReference], capabilities: [] },
    }),
  });
  assert.equal(result.closedRevision.state, 'treatment_requested');
  assert.equal(result.closedRevision.revision, 1);
  assert.equal(result.successorRevision.revision, 2);
  assert.equal(result.successorRevision.state, 'created');
  assert.equal(result.successorRevision.priorOutputVersionId, outputVersionId);
  assert.equal(result.successorRevision.originTreatmentId, result.treatment.treatmentId);
  assert.equal(result.successorRevision.organization.organizationVersion, 2);
  assert.equal(result.successorRevision.requestVersion, 2, 'the successor binds the revised request version');
  assert.equal(result.treatment.successorRevision, 2);
  assert.equal(result.treatment.targetOutputVersionId, outputVersionId);

  // The closed revision is frozen (treatment_requested is terminal).
  await assert.rejects(
    () => db!.query(`UPDATE studio_sessions SET state = 'processing' WHERE session_id = $1 AND revision = 1`, [session.sessionId]),
    /terminal revisions are frozen/,
  );

  // The successor runs to its own review — its output version carries
  // the parent lineage (lock v1.7 #42: every treatment creates a NEW
  // linked output version).
  const successor = await driveToReview(session.sessionId);
  assert.equal(successor.session.state, 'review');
  assert.equal(successor.session.revision, 2);
  assert.notEqual(successor.outputVersionId, null);
  const successorOutput = await studio.getOutputVersion(aliceScope, successor.outputVersionId!);
  assert.equal(successorOutput.parentOutputVersionId, outputVersionId, 'the treatment lineage is linked to the prior output');
  const allOutputs = await studio.getSessionOutputs(aliceScope, session.sessionId);
  assert.equal(allOutputs.length, 2);
  const treatments = await studio.listTreatmentRequests(aliceScope, session.sessionId);
  assert.equal(treatments.length, 1);
  assert.equal(treatments[0]!.specification.defect, 'The intro trails off.');
});

// ---------------------------------------------------------------------------
// (e) THE ORGANIZATION COMPATIBILITY CONTRACT — explicit failures, never silent replacement.
// ---------------------------------------------------------------------------

test('STUDIO-001: THE COMPATIBILITY CONTRACT — a nonexistent body reference fails EXPLICITLY and NO session opens (never a silent replacement)', async () => {
  const ghostReference = '01923f7e-8b1d-7abc-9def-01234567dead#v1';
  const request = await studio.createProductionRequest({ scope: aliceScope, content: standaloneRequest(ghostReference) });
  await assert.rejects(
    () => studio.openSession({ scope: aliceScope, requestId: request.requestId }),
    (error: unknown) =>
      error instanceof InvalidRequestError &&
      /does not satisfy the Studio compatibility contract/.test(error.message) &&
      (error.details ?? []).some((detail) => detail.includes('does not resolve in scope')),
  );
  // NO session opened — the requested organization was never replaced.
  const sessions = await studio.listSessions(aliceScope);
  assert.ok(sessions.every((listed) => listed.requestId !== request.requestId), 'no session exists for the failed request');
});

test('STUDIO-001: the compatibility contract — an INACTIVE (draft) body version and insufficient permissions each fail with the explicit incompatibility listed', async () => {
  // A draft body (never activated).
  const draft = await agentBody.createBody({ scope: aliceScope, contract: bodyContract(['read', 'transform', 'compose']) });
  const draftReference = `${draft.bodyId}#v${draft.bodyVersion}`;
  const draftRequest = await studio.createProductionRequest({ scope: aliceScope, content: standaloneRequest(draftReference) });
  await assert.rejects(
    () => studio.openSession({ scope: aliceScope, requestId: draftRequest.requestId }),
    (error: unknown) =>
      error instanceof InvalidRequestError &&
      (error.details ?? []).some((detail) => detail.includes('is draft')),
  );

  // An active body WITHOUT the format's required 'transform' permission.
  const limitedReference = await makeActiveBody(['read', 'compose']);
  const limitedRequest = await studio.createProductionRequest({ scope: aliceScope, content: standaloneRequest(limitedReference) });
  await assert.rejects(
    () => studio.openSession({ scope: aliceScope, requestId: limitedRequest.requestId }),
    (error: unknown) =>
      error instanceof InvalidRequestError &&
      (error.details ?? []).some((detail) => detail.includes("required permission 'transform'")),
  );
});

// ---------------------------------------------------------------------------
// (f) THE TENANT ISOLATION — the uniform NotFound + the DB backstops.
// ---------------------------------------------------------------------------

test('STUDIO-001: THE TENANT ISOLATION — the foreign scope resolves every record to the uniform NotFound (no existence oracle)', async () => {
  const bodyReference = await makeActiveBody();
  const request = await studio.createProductionRequest({ scope: aliceScope, content: standaloneRequest(bodyReference) });
  const session = await studio.openSession({ scope: aliceScope, requestId: request.requestId });
  await studio.advanceSession({ scope: aliceScope, sessionId: session.sessionId, to: 'preparing' });
  await studio.advanceSession({ scope: aliceScope, sessionId: session.sessionId, to: 'processing' });
  const steps = await studio.listProcessingSteps(aliceScope, session.sessionId);
  const claimed = await studio.claimProcessingSteps({ scope: aliceScope, sessionId: session.sessionId, limit: 1, lockedBy: 'driver' });
  const completion = await studio.completeProcessingStep({ scope: aliceScope, stepId: claimed[0]!.stepId, output: { intermediate: 'x' } });

  // Bob sees nothing of Alice's production (uniform NotFound).
  await assert.rejects(() => studio.getProductionRequest(bobScope, request.requestId), NotFoundError);
  await assert.rejects(() => studio.getSession(bobScope, session.sessionId), NotFoundError);
  await assert.rejects(() => studio.listSessionEvents(bobScope, session.sessionId), NotFoundError);
  await assert.rejects(() => studio.listProcessingSteps(bobScope, session.sessionId), NotFoundError);
  await assert.rejects(() => studio.listSessionRevisions(bobScope, session.sessionId), NotFoundError);
  await assert.rejects(() => studio.listTreatmentRequests(bobScope, session.sessionId), NotFoundError);
  // Bob cannot advance, claim, complete or treat Alice's session.
  await assert.rejects(() => studio.advanceSession({ scope: bobScope, sessionId: session.sessionId, to: 'cancelled', terminalReason: 'user_cancelled' }), NotFoundError);
  const bobClaimed = await studio.claimProcessingSteps({ scope: bobScope, limit: 4, lockedBy: 'bob-driver' });
  assert.equal(bobClaimed.length, 0, 'the claim is tenant-fenced — Bob claims none of Alice steps');
  await assert.rejects(() => studio.completeProcessingStep({ scope: bobScope, stepId: claimed[0]!.stepId, output: {} }), NotFoundError);

  // The DB scope-consistency backstop: a cross-tenant event injection is rejected.
  await assert.rejects(
    () => db!.query(
      `INSERT INTO studio_session_events (event_id, session_id, revision, agency_id, client_id, seq, event_kind, payload, payload_digest, contract_version, created_at)
       VALUES ($1, $2, 1, $3, $4, 99, 'state_advanced', '{}', $5, 'content-studio-runtime-v1', now())`,
      [new CryptoIdGenerator().newId(), session.sessionId, bobScope.agencyId, bobScope.clientId, 'a'.repeat(64)],
    ),
    /cross-tenant events are rejected/,
  );
  // The DB scope-consistency backstop: a cross-tenant step injection is rejected.
  await assert.rejects(
    () => db!.query(
      `INSERT INTO studio_processing_steps (step_id, session_id, revision, agency_id, client_id, stage_id, stage_index, status, attempts, run_at, cost_units, duration_ms, contract_version, created_at, updated_at)
       VALUES ($1, $2, 1, $3, $4, 'rogue-stage', 9, 'queued', 0, now(), 0, 0, 'content-studio-runtime-v1', now(), now())`,
      [new CryptoIdGenerator().newId(), session.sessionId, bobScope.agencyId, bobScope.clientId],
    ),
    /cross-tenant steps are rejected/,
  );

  // Bob's own production is fully independent (the same runtime, the
  // other tenant).
  const bobBody = await makeActiveBody(['read', 'transform', 'compose'], bobScope);
  const bobRequest = await studio.createProductionRequest({ scope: bobScope, content: standaloneRequest(bobBody) });
  const bobSession = await studio.openSession({ scope: bobScope, requestId: bobRequest.requestId });
  assert.equal(bobSession.state, 'created');
  const bobSessions = await studio.listSessions(bobScope);
  assert.equal(bobSessions.length, 1);
  assert.equal(bobSessions[0]!.sessionId, bobSession.sessionId);

  void steps;
  void completion;
});

// ---------------------------------------------------------------------------
// (g) THE ENTRY-MODE FENCE — standalone vs lab_initiated.
// ---------------------------------------------------------------------------

test('STUDIO-001: the entry-mode fence — a lab_initiated request opens with its Lab binding; a standalone request MUST NOT carry Lab fields', async () => {
  const bodyReference = await makeActiveBody();
  // Standalone WITH a lab binding is refused at creation.
  await assert.rejects(
    () => studio.createProductionRequest({
      scope: aliceScope,
      content: standaloneRequest(bodyReference, { labBinding: { strategyReference: 'strategy:x' } }),
    }),
    /entry-mode fence/,
  );
  // lab_initiated WITHOUT a binding is refused.
  await assert.rejects(
    () => studio.createProductionRequest({ scope: aliceScope, content: standaloneRequest(bodyReference, { entryMode: 'lab_initiated' }) }),
    /labBinding is required/,
  );
  // The sanctioned lab_initiated request opens through the SAME runtime.
  const labRequest = await studio.createProductionRequest({
    scope: aliceScope,
    content: standaloneRequest(bodyReference, {
      entryMode: 'lab_initiated',
      labBinding: { strategyReference: 'strategy:lab-run-42/candidate-7', missionReference: 'mission:xyz', transformGraphReference: 'transform-graph:tg-9' },
    }),
  });
  const labSession = await studio.openSession({ scope: aliceScope, requestId: labRequest.requestId });
  assert.equal(labSession.state, 'created');
  const events = await studio.listSessionEvents(aliceScope, labSession.sessionId);
  assert.equal(events[0]!.eventKind, 'session_opened');
  assert.equal((events[0]!.payload as Record<string, unknown>).entryMode, 'lab_initiated');
});

// ---------------------------------------------------------------------------
// (h) THE DURABLE STEP DISCIPLINE — honest failures, the bounded requeue, the CAS claim, the output-contract validation.
// ---------------------------------------------------------------------------

test('STUDIO-001: the honest failure + the explicit caller requeue under the declared stopping policy (retryLimit 0 forbids, retryLimit 2 allows)', async () => {
  // retryLimit 0: no requeue allowed.
  const bodyA = await makeActiveBody();
  const requestA = await studio.createProductionRequest({ scope: aliceScope, content: standaloneRequest(bodyA, { delayStoppingPolicy: { retryLimit: 0 } }) });
  const sessionA = await studio.openSession({ scope: aliceScope, requestId: requestA.requestId });
  await studio.advanceSession({ scope: aliceScope, sessionId: sessionA.sessionId, to: 'preparing' });
  await studio.advanceSession({ scope: aliceScope, sessionId: sessionA.sessionId, to: 'processing' });
  const claimedA = await studio.claimProcessingSteps({ scope: aliceScope, sessionId: sessionA.sessionId, limit: 1, lockedBy: 'driver' });
  const failedA = await studio.failProcessingStep({ scope: aliceScope, stepId: claimedA[0]!.stepId, failureReason: 'provider_failure', failureDetail: 'the composition backend timed out' });
  assert.equal(failedA.status, 'failed');
  assert.equal(failedA.failureReason, 'provider_failure');
  // The session stays processing — the failure is recorded, the
  // economic branch decision stays the caller's (§17).
  assert.equal((await studio.getSession(aliceScope, sessionA.sessionId)).state, 'processing');
  await assert.rejects(
    () => studio.requeueProcessingStep({ scope: aliceScope, stepId: claimedA[0]!.stepId }),
    /stopping policy allows at most 0/,
  );

  // retryLimit 2: the requeue lands, the step is claimable again.
  const bodyB = await makeActiveBody();
  const requestB = await studio.createProductionRequest({ scope: aliceScope, content: standaloneRequest(bodyB, { delayStoppingPolicy: { retryLimit: 2 } }) });
  const sessionB = await studio.openSession({ scope: aliceScope, requestId: requestB.requestId });
  await studio.advanceSession({ scope: aliceScope, sessionId: sessionB.sessionId, to: 'preparing' });
  await studio.advanceSession({ scope: aliceScope, sessionId: sessionB.sessionId, to: 'processing' });
  const claimedB = await studio.claimProcessingSteps({ scope: aliceScope, sessionId: sessionB.sessionId, limit: 1, lockedBy: 'driver' });
  await studio.failProcessingStep({ scope: aliceScope, stepId: claimedB[0]!.stepId, failureReason: 'provider_failure' });
  const requeued = await studio.requeueProcessingStep({ scope: aliceScope, stepId: claimedB[0]!.stepId });
  assert.equal(requeued.status, 'queued');
  assert.equal(requeued.attempts, 1, 'the attempt accounting is monotonic');
  const reclaimed = await studio.claimProcessingSteps({ scope: aliceScope, sessionId: sessionB.sessionId, limit: 4, lockedBy: 'driver' });
  assert.ok(reclaimed.some((step) => step.stepId === claimedB[0]!.stepId));
  assert.equal(reclaimed.find((step) => step.stepId === claimedB[0]!.stepId)!.attempts, 2);
  // The honest failure is on the audit tail.
  const events = await studio.listSessionEvents(aliceScope, sessionB.sessionId);
  assert.ok(events.some((event) => event.eventKind === 'step_failed'));
  assert.ok(events.some((event) => event.eventKind === 'step_requeued'));
});

test('STUDIO-001: the claim CAS — a claimed (running) step is never double-claimed; the claim batch respects the limit', async () => {
  const bodyReference = await makeActiveBody();
  const request = await studio.createProductionRequest({ scope: aliceScope, content: standaloneRequest(bodyReference) });
  const session = await studio.openSession({ scope: aliceScope, requestId: request.requestId });
  await studio.advanceSession({ scope: aliceScope, sessionId: session.sessionId, to: 'preparing' });
  await studio.advanceSession({ scope: aliceScope, sessionId: session.sessionId, to: 'processing' });

  const first = await studio.claimProcessingSteps({ scope: aliceScope, sessionId: session.sessionId, limit: 2, lockedBy: 'driver-a' });
  assert.equal(first.length, 2);
  const second = await studio.claimProcessingSteps({ scope: aliceScope, sessionId: session.sessionId, limit: 2, lockedBy: 'driver-b' });
  assert.equal(second.length, 1, 'the remaining queued step only — the running ones are not re-claimed');
  const third = await studio.claimProcessingSteps({ scope: aliceScope, sessionId: session.sessionId, limit: 4, lockedBy: 'driver-c' });
  assert.equal(third.length, 0, 'nothing queued remains');
});

test('STUDIO-001: the §18 output-contract validation — a final-stage package missing a required output kind rolls the completion back honestly', async () => {
  const bodyReference = await makeActiveBody();
  const request = await studio.createProductionRequest({ scope: aliceScope, content: standaloneRequest(bodyReference) });
  const session = await studio.openSession({ scope: aliceScope, requestId: request.requestId });
  await studio.advanceSession({ scope: aliceScope, sessionId: session.sessionId, to: 'preparing' });
  await studio.advanceSession({ scope: aliceScope, sessionId: session.sessionId, to: 'processing' });

  const claimed = await studio.claimProcessingSteps({ scope: aliceScope, sessionId: session.sessionId, limit: 2, lockedBy: 'driver' });
  await studio.completeProcessingStep({ scope: aliceScope, stepId: claimed[0]!.stepId, output: { intermediate: 'x' } });
  await studio.completeProcessingStep({ scope: aliceScope, stepId: claimed[1]!.stepId, output: { intermediate: 'y' } });
  const finalStep = (await studio.claimProcessingSteps({ scope: aliceScope, sessionId: session.sessionId, limit: 1, lockedBy: 'driver' }))[0]!;

  // The missing-required-output completion is refused AND rolled back
  // (the step stays running — the transaction never landed).
  await assert.rejects(
    () => studio.completeProcessingStep({ scope: aliceScope, stepId: finalStep.stepId, output: { wrong_kind: 'no final media here' } }),
    /missing the required output\(s\): final_media/,
  );
  const steps = await studio.listProcessingSteps(aliceScope, session.sessionId);
  assert.equal(steps.find((step) => step.stepId === finalStep.stepId)!.status, 'running', 'the rolled-back completion left the step running');
  // The session is still processing (no output was recorded).
  assert.equal((await studio.getSession(aliceScope, session.sessionId)).state, 'processing');
  // The honest retry with the full package lands.
  await studio.completeProcessingStep({ scope: aliceScope, stepId: finalStep.stepId, output: { final_media: 'media:retry-lands' } });
  assert.equal((await studio.getSession(aliceScope, session.sessionId)).state, 'review');
});

// ---------------------------------------------------------------------------
// The format-seam pluggability on the REAL stack + the request versioning.
// ---------------------------------------------------------------------------

test('STUDIO-001: the §2 seam on the real stack — a brand-new future format produces sessions through the SAME runtime (no second Studio runtime)', async () => {
  const futureFormat: ContentStudioFormatDeclaration = {
    formatId: 'carousel-thread',
    formatVersion: 1,
    inputRequirements: { modes: ['script'], sourceArtifacts: 'optional' },
    participantModel: { participants: { min: 2, max: 2 }, humanCapture: 'optional', participationGrants: 'explicit_grant_per_participant' },
    captureRequirements: { modalities: ['screen'] },
    interviewerRequirements: { interviewer: 'representation', representations: ['voice'], followUps: 'adaptive' },
    organizationRequirements: { minAgentBodies: 1, requiredPermissions: ['read', 'compose'] },
    outputContract: { outputs: ['final_media', 'transcript'] },
    provenanceConsentRequirements: {
      consent: ['participant_recording_consent', 'participant_contribution_rights'],
      provenance: ['question_answer_sequence', 'recording'],
    },
    evaluationHooks: { hooks: [{ hookId: 'engagement-hook', firesOn: 'output_recorded' }] },
    processingStages: [
      { stageId: 'thread_preparation', availability: { status: 'runtime_driven' } },
      { stageId: 'output_assembly', availability: { status: 'runtime_driven' } },
    ],
  };
  const wired = buildStudio(db!, [...CONTENT_STUDIO_INITIAL_FORMATS, futureFormat]);
  assert.equal((await wired.listFormats(aliceScope)).length, 4);

  const bodyReference = await makeActiveBody();
  const request = await wired.createProductionRequest({
    scope: aliceScope,
    content: standaloneRequest(bodyReference, {
      formatId: 'carousel-thread',
      formatVersion: 1,
      input: { mode: 'script', script: { opening: 'Three points, then the punchline.' } },
      output: { requiredOutputs: ['final_media', 'transcript'] },
    }),
  });
  const session = await wired.openSession({ scope: aliceScope, requestId: request.requestId });
  await wired.advanceSession({ scope: aliceScope, sessionId: session.sessionId, to: 'preparing' });
  await wired.advanceSession({ scope: aliceScope, sessionId: session.sessionId, to: 'processing' });
  const steps = await wired.listProcessingSteps(aliceScope, session.sessionId);
  assert.deepEqual(steps.map((step) => step.stageId), ['thread_preparation', 'output_assembly']);
  for (const step of steps) {
    await wired.claimProcessingSteps({ scope: aliceScope, sessionId: session.sessionId, limit: 2, lockedBy: 'driver' });
    const completion = await wired.completeProcessingStep({
      scope: aliceScope,
      stepId: step.stepId,
      output: step.stageId === 'output_assembly'
        ? { final_media: 'media:carousel', transcript: 'text:thread' }
        : { intermediate: 'x' },
    });
    if (step.stageId === 'output_assembly') {
      assert.equal(completion.session!.state, 'review');
      assert.equal(completion.outputVersion!.artifactPackage.transcript, 'text:thread');
    }
  }
  const completed = await wired.advanceSession({ scope: aliceScope, sessionId: session.sessionId, to: 'completed' });
  assert.equal(completed.state, 'completed');
});

test('STUDIO-001: the request versioning — an appended version binds new sessions; the chain scope fence rejects cross-tenant corrections; requests are immutable at the DB', async () => {
  const bodyReference = await makeActiveBody();
  const request = await studio.createProductionRequest({ scope: aliceScope, content: standaloneRequest(bodyReference) });
  const revised = await studio.appendProductionRequestVersion({
    scope: aliceScope,
    requestId: request.requestId,
    content: standaloneRequest(bodyReference, { acceptanceCriteria: ['tighter hook'] }),
  });
  assert.equal(revised.requestVersion, 2);
  assert.equal((await studio.getProductionRequest(aliceScope, request.requestId)).requestVersion, 2);
  assert.equal((await studio.getProductionRequestVersion(aliceScope, request.requestId, 1)).requestVersion, 1);

  // A session opened after the revision binds the LATEST version by default.
  const session = await studio.openSession({ scope: aliceScope, requestId: request.requestId });
  assert.equal(session.requestVersion, 2);
  // The exact-version binding works too.
  const pinned = await studio.openSession({ scope: aliceScope, requestId: request.requestId, requestVersion: 1 });
  assert.equal(pinned.requestVersion, 1);

  // The chain scope fence: a cross-tenant correction is rejected at the DB.
  await assert.rejects(
    () => db!.query(
      `INSERT INTO studio_production_requests (request_id, request_version, agency_id, client_id, workspace_id, content, contract_version, created_at)
       VALUES ($1, 3, $2, $3, NULL, $4::jsonb, 'content-studio-runtime-v1', now())`,
      [request.requestId, bobScope.agencyId, bobScope.clientId, JSON.stringify({ entryMode: 'standalone' })],
    ),
    /cross-tenant\/cross-workspace corrections are rejected/,
  );
  // Requests are immutable at the DB (UPDATE and DELETE rejected).
  await assert.rejects(
    () => db!.query(`UPDATE studio_production_requests SET content = '{}'::jsonb WHERE request_id = $1 AND request_version = 1`, [request.requestId]),
    /immutable version rows/,
  );
  await assert.rejects(
    () => db!.query(`DELETE FROM studio_production_requests WHERE request_id = $1 AND request_version = 1`, [request.requestId]),
    /immutable version rows/,
  );
});

test('STUDIO-001: the DB append-only backstops — session events, output versions and treatment requests are INSERT-only', async () => {
  const bodyReference = await makeActiveBody();
  const request = await studio.createProductionRequest({ scope: aliceScope, content: standaloneRequest(bodyReference) });
  const session = await studio.openSession({ scope: aliceScope, requestId: request.requestId });
  const { outputVersionId } = await driveToReview(session.sessionId);
  await studio.requestTreatment({
    scope: aliceScope,
    sessionId: session.sessionId,
    targetOutputVersionId: outputVersionId!,
    treatment: { defect: 'Pacing.', desiredChange: 'Tighter cut.' },
  });

  const events = await studio.listSessionEvents(aliceScope, session.sessionId);
  const eventId = events[0]!.eventId;
  await assert.rejects(
    () => db!.query(`UPDATE studio_session_events SET payload = '{}'::jsonb WHERE event_id = $1`, [eventId]),
    /append-only/,
  );
  await assert.rejects(
    () => db!.query(`DELETE FROM studio_session_events WHERE event_id = $1`, [eventId]),
    /append-only/,
  );
  await assert.rejects(
    () => db!.query(`UPDATE studio_output_versions SET artifact_package = '{}'::jsonb WHERE output_version_id = $1`, [outputVersionId]),
    /immutable/,
  );
  await assert.rejects(
    () => db!.query(`DELETE FROM studio_output_versions WHERE output_version_id = $1`, [outputVersionId]),
    /immutable/,
  );
  const treatments = await studio.listTreatmentRequests(aliceScope, session.sessionId);
  await assert.rejects(
    () => db!.query(`UPDATE studio_treatment_requests SET specification = '{}'::jsonb WHERE treatment_id = $1`, [treatments[0]!.treatmentId]),
    /immutable/,
  );
  await assert.rejects(
    () => db!.query(`DELETE FROM studio_treatment_requests WHERE treatment_id = $1`, [treatments[0]!.treatmentId]),
    /immutable/,
  );
  // Steps are never deleted either (the durable work history).
  const steps = await studio.listProcessingSteps(aliceScope, session.sessionId);
  await assert.rejects(
    () => db!.query(`DELETE FROM studio_processing_steps WHERE step_id = $1`, [steps[0]!.stepId]),
    /append-only/,
  );
});

test('STUDIO-001: the step-status DB backstop — the durable status edges reject a direct requeue of a succeeded step and an unclaimed completion', async () => {
  const bodyReference = await makeActiveBody();
  const request = await studio.createProductionRequest({ scope: aliceScope, content: standaloneRequest(bodyReference) });
  const session = await studio.openSession({ scope: aliceScope, requestId: request.requestId });
  await studio.advanceSession({ scope: aliceScope, sessionId: session.sessionId, to: 'preparing' });
  await studio.advanceSession({ scope: aliceScope, sessionId: session.sessionId, to: 'processing' });
  const claimed = await studio.claimProcessingSteps({ scope: aliceScope, sessionId: session.sessionId, limit: 1, lockedBy: 'driver' });
  await studio.completeProcessingStep({ scope: aliceScope, stepId: claimed[0]!.stepId, output: { intermediate: 'x' } });

  // A direct DB requeue of the SUCCEEDED step is rejected (terminal outcome).
  await assert.rejects(
    () => db!.query(`UPDATE studio_processing_steps SET status = 'queued' WHERE step_id = $1`, [claimed[0]!.stepId]),
    /not legal/,
  );
  // A module-level completion of a queued (unclaimed) step is rejected.
  const queuedStep = (await studio.listProcessingSteps(aliceScope, session.sessionId)).find((step) => step.status === 'queued')!;
  await assert.rejects(
    () => studio.completeProcessingStep({ scope: aliceScope, stepId: queuedStep.stepId, output: { intermediate: 'x' } }),
    /only a running \(claimed\) step may complete/,
  );
});

// ---------------------------------------------------------------------------
// The STUDIO-002 battery — the format registry over the runtime.
// ---------------------------------------------------------------------------

/** A test-only CUSTOM format declaration registered through the PUBLIC seam (the pluggability proof). */
function customFormatDeclaration(formatId: string, formatVersion: number): ContentStudioFormatDeclaration {
  return {
    formatId,
    formatVersion,
    inputRequirements: { modes: ['intent', 'script', 'question_list'], sourceArtifacts: 'optional' },
    participantModel: { participants: { min: 1, max: 3 }, humanCapture: 'optional', participationGrants: 'explicit_grant_per_participant' },
    captureRequirements: { modalities: ['screen', 'participant_streams'] },
    interviewerRequirements: { interviewer: 'representation', representations: ['voice', 'voice_text', 'generated'], followUps: 'adaptive' },
    organizationRequirements: {
      minAgentBodies: 1,
      requiredPermissions: ['read', 'compose'],
      requiredCapabilities: formatVersion === 1 ? ['capability:thread-layout@v3'] : ['capability:thread-layout@v4'],
    },
    outputContract: { outputs: ['final_media', 'derived_clips'] },
    provenanceConsentRequirements: {
      consent: ['participant_recording_consent', 'participant_contribution_rights'],
      provenance: ['question_answer_sequence', 'transform_graph', 'treatment_lineage'],
    },
    evaluationHooks: {
      hooks: [
        { hookId: 'thread-quality-hook', firesOn: 'output_recorded' },
        { hookId: 'thread-panel-hook', firesOn: 'stage_completion', stageId: 'panel_capture' },
      ],
    },
    processingStages: [
      { stageId: 'thread_preparation', availability: { status: 'runtime_driven' } },
      { stageId: 'panel_capture', availability: { status: 'runtime_driven' } },
      { stageId: 'output_assembly', availability: { status: 'runtime_driven' } },
    ],
  };
}

test('STUDIO-002 (i): THE PLUGGABILITY PROOF — a test-only CUSTOM format registered through the PUBLIC SEAM drives a FULL session end-to-end through the SAME runtime (ZERO runtime changes)', async () => {
  // 1. Register the custom format through the public seam: born DRAFT.
  const draft = await studio.registerFormat({ scope: aliceScope, declaration: customFormatDeclaration('qa-roundtable', 1) });
  assert.equal(draft.status, 'draft');
  assert.equal(draft.formatId, 'qa-roundtable');
  assert.equal(draft.declaration.participantModel.participants.max, 3);
  assert.deepEqual(draft.capabilityLinks, ['capability:thread-layout@v3']);

  // 2. A DRAFT format does NOT resolve for new sessions (active versions only).
  const bodyReference = await makeActiveBody();
  const request = await studio.createProductionRequest({
    scope: aliceScope,
    content: standaloneRequest(bodyReference, {
      formatId: 'qa-roundtable',
      formatVersion: 1,
      organization: { organizationId: 'org-roundtable', organizationVersion: 1, agentBodyReferences: [bodyReference], capabilities: ['capability:thread-layout@v3'] },
      input: { mode: 'intent', intent: 'A punchy three-person QA roundtable.' },
      output: { requiredOutputs: ['final_media', 'derived_clips'] },
    }),
  });
  await assert.rejects(
    () => studio.openSession({ scope: aliceScope, requestId: request.requestId }),
    (error: unknown) => error instanceof InvalidRequestError && /is draft/.test(error.message),
  );

  // 3. Activate (draft → active) — the capability links ride the record.
  const active = await studio.activateFormat(aliceScope, 'qa-roundtable', 1);
  assert.equal(active.status, 'active');
  assert.deepEqual(active.capabilityLinks, ['capability:thread-layout@v3']);
  assert.equal(active.contractVersion, 'content-studio-format-v1');

  // 4. The SAME runtime drives the custom format end-to-end: the plan is
  //    derived from the DECLARED stages (never runtime code).
  const session = await studio.openSession({ scope: aliceScope, requestId: request.requestId });
  assert.equal(session.state, 'created');
  assert.equal(session.formatId, 'qa-roundtable');
  await studio.advanceSession({ scope: aliceScope, sessionId: session.sessionId, to: 'preparing' });
  await studio.advanceSession({ scope: aliceScope, sessionId: session.sessionId, to: 'processing' });
  const steps = await studio.listProcessingSteps(aliceScope, session.sessionId);
  assert.deepEqual(steps.map((step) => step.stageId), ['thread_preparation', 'panel_capture', 'output_assembly']);
  for (const step of steps) {
    await studio.claimProcessingSteps({ scope: aliceScope, sessionId: session.sessionId, limit: 1, lockedBy: 'pluggability-driver' });
    const completion = await studio.completeProcessingStep({
      scope: aliceScope,
      stepId: step.stepId,
      output: step.stageId === 'output_assembly'
        ? { final_media: 'media:roundtable', derived_clips: 'clip:highlights' }
        : { intermediate: `artifact:${step.stageId}` },
    });
    if (step.stageId === 'output_assembly') {
      assert.equal(completion.session!.state, 'review');
      assert.equal(completion.outputVersion!.artifactPackage.final_media, 'media:roundtable');
    }
  }
  const completed = await studio.advanceSession({ scope: aliceScope, sessionId: session.sessionId, to: 'completed' });
  assert.equal(completed.state, 'completed');
  // The audit tail recorded the full flow through the same event kinds.
  const events = await studio.listSessionEvents(aliceScope, session.sessionId);
  assert.ok(events.some((event) => event.eventKind === 'session_opened'));
  assert.ok(events.some((event) => event.eventKind === 'processing_plan_recorded'));
  assert.ok(events.some((event) => event.eventKind === 'output_version_recorded'));
  // NO second Studio runtime was constructed: the SAME module instance
  // (the one driving reaction sessions in every other test) served the
  // custom format — the pluggability is the seam, proven.
});

test('STUDIO-002 (j): the registry semantics — duplicate registration, broken chains, illegal lifecycle advances and append-only version corrections', async () => {
  // A duplicate identity/version is rejected (corrections are NEW version rows).
  const draft = await studio.registerFormat({ scope: aliceScope, declaration: customFormatDeclaration('micro-thread', 1) });
  assert.equal(draft.status, 'draft');
  await assert.rejects(
    () => studio.registerFormat({ scope: aliceScope, declaration: customFormatDeclaration('micro-thread', 1) }),
    /already registered/,
  );

  // A broken version chain is rejected (registering v3 with only v1 present).
  await assert.rejects(
    () => studio.registerFormat({ scope: aliceScope, declaration: customFormatDeclaration('micro-thread', 3) }),
    /version chain must be continuous/,
  );

  // Illegal lifecycle advances: activating an already-active format,
  // retiring an already-retired format, activating a retired format.
  const activated = await studio.activateFormat(aliceScope, 'micro-thread', 1);
  assert.equal(activated.status, 'active');
  await assert.rejects(
    () => studio.activateFormat(aliceScope, 'micro-thread', 1),
    /only a DRAFT format version can activate/,
  );
  const lifecycleProbe = await studio.registerFormat({ scope: aliceScope, declaration: customFormatDeclaration('lifecycle-probe', 1) });
  await studio.activateFormat(aliceScope, 'lifecycle-probe', 1);
  const retiredProbe = await studio.retireFormat(aliceScope, 'lifecycle-probe', 1);
  assert.equal(retiredProbe.status, 'retired');
  await assert.rejects(
    () => studio.activateFormat(aliceScope, 'lifecycle-probe', 1),
    /only a DRAFT format version can activate/,
  );
  await assert.rejects(
    () => studio.retireFormat(aliceScope, 'lifecycle-probe', 1),
    /only an ACTIVE format version can retire/,
  );
  assert.equal(lifecycleProbe.status, 'draft');

  // The append-only version correction: v2 registers as a DRAFT with its own
  // capability links; activating it makes NEW sessions bind v2 while v1
  // remains queryable (history never deletes).
  const v2 = await studio.registerFormat({ scope: aliceScope, declaration: customFormatDeclaration('micro-thread', 2) });
  assert.deepEqual(v2.capabilityLinks, ['capability:thread-layout@v4']);
  const v2Active = await studio.activateFormat(aliceScope, 'micro-thread', 2);
  assert.equal(v2Active.status, 'active');
  assert.equal((await studio.getFormat(aliceScope, 'micro-thread', 1)).status, 'active');
  assert.equal((await studio.getFormat(aliceScope, 'micro-thread', 2)).status, 'active');

  // The registry listing carries every version row in the scope.
  const formats = await studio.listFormats(aliceScope);
  const microThread = formats.filter((format) => format.formatId === 'micro-thread');
  assert.deepEqual(microThread.map((format) => format.formatVersion), [1, 2]);
});

test('STUDIO-002 (j): RETIREMENT NEVER BREAKS RUNNING SESSIONS — the running session completes, its treatment loop opens the successor revision and the new output links the prior one; only NEW sessions refuse', async () => {
  const bodyReference = await makeActiveBody();
  const request = await studio.createProductionRequest({
    scope: aliceScope,
    content: standaloneRequest(bodyReference, {
      formatId: 'qa-roundtable',
      formatVersion: 1,
      organization: { organizationId: 'org-roundtable', organizationVersion: 1, agentBodyReferences: [bodyReference], capabilities: ['capability:thread-layout@v3'] },
      input: { mode: 'intent', intent: 'The roundtable continues after retirement.' },
      output: { requiredOutputs: ['final_media', 'derived_clips'] },
    }),
  });
  const session = await studio.openSession({ scope: aliceScope, requestId: request.requestId });
  await studio.advanceSession({ scope: aliceScope, sessionId: session.sessionId, to: 'preparing' });
  await studio.advanceSession({ scope: aliceScope, sessionId: session.sessionId, to: 'processing' });
  const firstSteps = await studio.claimProcessingSteps({ scope: aliceScope, sessionId: session.sessionId, limit: 1, lockedBy: 'retirement-driver' });
  assert.equal(firstSteps.length, 1);
  await studio.completeProcessingStep({ scope: aliceScope, stepId: firstSteps[0]!.stepId, output: { intermediate: 'artifact:thread_preparation' } });

  // RETIRE the format MID-SESSION (the running session has one step left).
  const retired = await studio.retireFormat(aliceScope, 'qa-roundtable', 1);
  assert.equal(retired.status, 'retired');

  // The RUNNING session keeps driving: the plan derivation already
  // persisted; the remaining steps complete; the output records; the
  // session reaches review — the format row is retired, never deleted.
  const remaining = await studio.claimProcessingSteps({ scope: aliceScope, sessionId: session.sessionId, limit: 2, lockedBy: 'retirement-driver' });
  assert.equal(remaining.length, 2);
  let outputVersionId: string | null = null;
  for (const step of remaining) {
    const completion = await studio.completeProcessingStep({
      scope: aliceScope,
      stepId: step.stepId,
      output: step.stageId === 'output_assembly'
        ? { final_media: 'media:roundtable-retired-mid-session', derived_clips: 'clip:highlights' }
        : { intermediate: 'artifact:panel_capture' },
    });
    if (completion.outputVersion !== null) {
      outputVersionId = completion.outputVersion.outputVersionId;
      assert.equal(completion.session!.state, 'review');
    }
  }
  assert.ok(outputVersionId !== null);

  // The TREATMENT LOOP also survives the retirement (the successor
  // revision resolves the session's OWN format under any status).
  const treatment = await studio.requestTreatment({
    scope: aliceScope,
    sessionId: session.sessionId,
    targetOutputVersionId: outputVersionId!,
    treatment: { defect: 'Pacing lags in panel two.', desiredChange: 'Tighten the panel cuts.' },
  });
  assert.equal(treatment.closedRevision.state, 'treatment_requested');
  assert.equal(treatment.successorRevision.state, 'created');
  assert.equal(treatment.successorRevision.priorOutputVersionId, outputVersionId);
  await studio.advanceSession({ scope: aliceScope, sessionId: session.sessionId, to: 'preparing' });
  await studio.advanceSession({ scope: aliceScope, sessionId: session.sessionId, to: 'processing' });
  const successorSteps = await studio.listProcessingSteps(aliceScope, session.sessionId);
  const r2Steps = successorSteps.filter((step) => step.revision === 2);
  assert.deepEqual(r2Steps.map((step) => step.stageId), ['thread_preparation', 'panel_capture', 'output_assembly']);
  for (const step of r2Steps) {
    await studio.claimProcessingSteps({ scope: aliceScope, sessionId: session.sessionId, limit: 1, lockedBy: 'retirement-driver' });
    const completion = await studio.completeProcessingStep({
      scope: aliceScope,
      stepId: step.stepId,
      output: step.stageId === 'output_assembly'
        ? { final_media: 'media:roundtable-treated', derived_clips: 'clip:highlights-v2' }
        : { intermediate: `artifact:${step.stageId}` },
    });
    if (completion.outputVersion !== null) {
      // The new output links its predecessor (lock v1.7 #42).
      assert.equal(completion.outputVersion.parentOutputVersionId, outputVersionId);
    }
  }
  const completed = await studio.advanceSession({ scope: aliceScope, sessionId: session.sessionId, to: 'completed' });
  assert.equal(completed.state, 'completed');

  // Only NEW sessions refuse the retired format (the honest lifecycle state).
  const newRequest = await studio.createProductionRequest({
    scope: aliceScope,
    content: standaloneRequest(bodyReference, {
      formatId: 'qa-roundtable',
      formatVersion: 1,
      organization: { organizationId: 'org-roundtable', organizationVersion: 1, agentBodyReferences: [bodyReference], capabilities: ['capability:thread-layout@v3'] },
      input: { mode: 'intent', intent: 'This one should refuse.' },
      output: { requiredOutputs: ['final_media', 'derived_clips'] },
    }),
  });
  await assert.rejects(
    () => studio.openSession({ scope: aliceScope, requestId: newRequest.requestId }),
    (error: unknown) => error instanceof InvalidRequestError && /is retired/.test(error.message),
  );
});

test('STUDIO-002 (j): the composition-wired initial formats — materialize-if-absent per scope, born active, NEVER resurrected after a tenant retirement (the restart simulation)', async () => {
  // Bob's fresh scope lists the wired initial formats (materialized per scope).
  const bobFormats = await studio.listFormats(bobScope);
  assert.deepEqual(bobFormats.map((format) => format.formatId), ['audio-podcast', 'reaction', 'video-podcast']);
  assert.ok(bobFormats.every((format) => format.status === 'active'));
  assert.equal(bobFormats[0]!.declaration.participantModel.participationGrants, 'explicit_grant_per_participant');
  assert.equal(bobFormats[0]!.declaration.interviewerRequirements.representations!.length, 7);
  assert.equal(bobFormats[1]!.declaration.participantModel.participationGrants, 'single_scope');

  // Bob retires reaction@v1 in HIS scope.
  const retired = await studio.retireFormat(bobScope, 'reaction', 1);
  assert.equal(retired.status, 'retired');

  // A SECOND module instance (the restart simulation — the STUDIO-001
  // durability precedent) does NOT resurrect the retired row: the
  // wired materialization is INSERT-only-if-absent.
  const restarted = buildStudio(db!);
  const bobFormatsAfterRestart = await restarted.listFormats(bobScope);
  assert.equal(bobFormatsAfterRestart.find((format) => format.formatId === 'reaction')!.status, 'retired');
  // Alice's scope is untouched by Bob's retirement (per-client registry).
  const aliceFormats = await restarted.listFormats(aliceScope);
  assert.equal(aliceFormats.find((format) => format.formatId === 'reaction')!.status, 'active');

  // Bob cannot OPEN a new reaction session after his retirement.
  const bodyReference = await makeActiveBody(['read', 'transform', 'compose'], bobScope);
  const bobRequest = await restarted.createProductionRequest({
    scope: bobScope,
    content: {
      entryMode: 'standalone',
      formatId: 'reaction',
      formatVersion: 1,
      organization: {
        organizationId: 'org-reaction-composer',
        organizationVersion: 1,
        agentBodyReferences: [bodyReference],
        capabilities: [],
      },
      input: { mode: 'intent', intent: 'A reaction after retirement.', sourceArtifactReferences: ['asset:01923f7e-8b1d-7abc-9def-0123456789cd'] },
      output: { requiredOutputs: ['final_media'] },
      acceptanceCriteria: ['hook lands fast'],
      budget: { maxCostUnits: 5, maxDurationMs: 600_000 },
      deadline: '2099-12-01T12:00:00.000Z',
      delayStoppingPolicy: { retryLimit: 1 },
      provenanceConsent: { consentReferences: ['consent:participant-recording-1'] },
    },
  });
  await assert.rejects(
    () => restarted.openSession({ scope: bobScope, requestId: bobRequest.requestId }),
    (error: unknown) => error instanceof InvalidRequestError && /is retired/.test(error.message),
  );
});

test('STUDIO-002 (k): THE TENANT ISOLATION of the registry — Bob resolves Alice\'s CUSTOM format to the uniform NotFound (no existence oracle); Alice\'s rows are invisible in Bob\'s scope', async () => {
  await studio.registerFormat({ scope: aliceScope, declaration: customFormatDeclaration('alice-private-format', 1) });
  await studio.activateFormat(aliceScope, 'alice-private-format', 1);

  // Bob CANNOT see, list or resolve Alice's custom format.
  await assert.rejects(
    () => studio.getFormat(bobScope, 'alice-private-format', 1),
    (error: unknown) => error instanceof NotFoundError,
  );
  const bobFormats = await studio.listFormats(bobScope);
  assert.ok(!bobFormats.some((format) => format.formatId === 'alice-private-format'), 'the custom format never appears in Bob\'s registry listing');
  // The initial formats materialize per scope — Bob's registry shows his
  // own (his reaction stays retired from the earlier test; the custom
  // format never appears).
  assert.deepEqual(bobFormats.map((format) => `${format.formatId}:${format.status}`), ['audio-podcast:active', 'reaction:retired', 'video-podcast:active']);

  // Alice's custom format resolves in Alice's scope only.
  const aliceResolution = await studio.getFormat(aliceScope, 'alice-private-format', 1);
  assert.equal(aliceResolution.status, 'active');
});

test('STUDIO-002 (l): the FORMAT-REGISTRY DB BACKSTOPS — born-draft, identity immutable, no delete, activation consistency, the chain-scope fence and the link fences reject direct injection', async () => {
  const registered = await studio.registerFormat({ scope: aliceScope, declaration: customFormatDeclaration('backstop-format', 1) });
  const fvid = registered.formatVersionId;

  // BORN DRAFT: a direct INSERT carrying 'active' is rejected.
  await assert.rejects(
    () => db!.query(
      `INSERT INTO studio_formats (format_version_id, format_id, format_version, agency_id, client_id, workspace_id, status, declaration, contract_version, created_at, updated_at)
       VALUES (gen_random_uuid(), 'backstop-format', 2, $1, $2, NULL, 'active', $3::jsonb, 'content-studio-format-v1', now(), now())`,
      [aliceScope.agencyId, aliceScope.clientId, JSON.stringify(customFormatDeclaration('backstop-format', 2))],
    ),
    /BORN DRAFT/,
  );

  // IDENTITY IMMUTABLE: a direct declaration mutation is rejected.
  await assert.rejects(
    () => db!.query(`UPDATE studio_formats SET declaration = declaration || '{"formatVersion": 99}'::jsonb, updated_at = now() WHERE format_version_id = $1`, [fvid]),
    /immutable — corrections are NEW version rows/,
  );

  // NO DELETE.
  await assert.rejects(
    () => db!.query(`DELETE FROM studio_formats WHERE format_version_id = $1`, [fvid]),
    /cannot be deleted/,
  );

  // ACTIVATION CONSISTENCY: a directly-injected draft (no capability
  // link records) cannot activate — the trigger verifies the link set
  // matches the declared requiredCapabilities.
  const probeDeclaration = customFormatDeclaration('activation-probe', 1);
  const probeRow = await db!.query<{ format_version_id: string }>(
    `INSERT INTO studio_formats (format_version_id, format_id, format_version, agency_id, client_id, workspace_id, status, declaration, contract_version, created_at, updated_at)
     VALUES (gen_random_uuid(), 'activation-probe', 1, $1, $2, NULL, 'draft', $3::jsonb, 'content-studio-format-v1', now(), now()) RETURNING format_version_id`,
    [aliceScope.agencyId, aliceScope.clientId, JSON.stringify(probeDeclaration)],
  );
  const probeId = probeRow.rows[0]!.format_version_id;
  await assert.rejects(
    () => db!.query(`UPDATE studio_formats SET status = 'active', updated_at = now() WHERE format_version_id = $1`, [probeId]),
    /capability link records do not match/,
  );
  // Writing the missing link through the module's own registration path
  // is impossible (the format already exists — a duplicate is rejected);
  // the DB backstop allows the link INSERT (append-only) and then the
  // activation passes the consistency fence.
  await db!.query(
    `INSERT INTO studio_format_capabilities (format_version_id, capability_kind, capability_reference, agency_id, client_id, workspace_id, contract_version, created_at)
     VALUES ($1, 'required', $2, $3, $4, NULL, 'content-studio-format-v1', now())`,
    [probeId, probeDeclaration.organizationRequirements.requiredCapabilities![0]!, aliceScope.agencyId, aliceScope.clientId],
  );
  const activatedProbe = await db!.query(`UPDATE studio_formats SET status = 'active', updated_at = now() WHERE format_version_id = $1 RETURNING status`, [probeId]);
  assert.equal(activatedProbe.rows[0]!.status, 'active');

  // Activating the module-registered row (whose links were written
  // transactionally at registration) succeeds through the module path.
  const activated = await studio.activateFormat(aliceScope, 'backstop-format', 1);
  assert.equal(activated.status, 'active');

  // THE LINK FENCES: a link with a mismatched scope is rejected; links
  // are immutable (UPDATE and DELETE rejected).
  await assert.rejects(
    () => db!.query(
      `INSERT INTO studio_format_capabilities (format_version_id, capability_kind, capability_reference, agency_id, client_id, workspace_id, contract_version, created_at)
       VALUES ($1, 'required', 'capability:injected', gen_random_uuid(), $2, NULL, 'content-studio-format-v1', now())`,
      [fvid, aliceScope.clientId],
    ),
    /parent format row scope/,
  );
  await assert.rejects(
    () => db!.query(`UPDATE studio_format_capabilities SET capability_reference = 'capability:x' WHERE format_version_id = $1`, [fvid]),
    /immutable/,
  );
  await assert.rejects(
    () => db!.query(`DELETE FROM studio_format_capabilities WHERE format_version_id = $1`, [fvid]),
    /immutable/,
  );

  // THE CHAIN-SCOPE FENCE: a cross-tenant version-2 correction is rejected.
  await assert.rejects(
    () => db!.query(
      `INSERT INTO studio_formats (format_version_id, format_id, format_version, agency_id, client_id, workspace_id, status, declaration, contract_version, created_at, updated_at)
       VALUES (gen_random_uuid(), 'backstop-format', 2, $1, $2, NULL, 'draft', $3::jsonb, 'content-studio-format-v1', now(), now())`,
      [bobScope.agencyId, bobScope.clientId, JSON.stringify(customFormatDeclaration('backstop-format', 2))],
    ),
    /version chain is broken|keep the version chain scope/,
  );

  // THE CLOSED-VOCABULARY CHECK FENCES: an out-of-vocabulary permission
  // and an out-of-vocabulary output kind cannot land as registry rows.
  const badPermissionDeclaration = customFormatDeclaration('closed-vocab-probe', 1);
  (badPermissionDeclaration as unknown as { organizationRequirements: { requiredPermissions: string[] } }).organizationRequirements.requiredPermissions = ['publish'];
  await assert.rejects(
    () => db!.query(
      `INSERT INTO studio_formats (format_version_id, format_id, format_version, agency_id, client_id, workspace_id, status, declaration, contract_version, created_at, updated_at)
       VALUES (gen_random_uuid(), 'closed-vocab-probe', 1, $1, $2, NULL, 'draft', $3::jsonb, 'content-studio-format-v1', now(), now())`,
      [aliceScope.agencyId, aliceScope.clientId, JSON.stringify(badPermissionDeclaration)],
    ),
    /check constraint/i,
  );
  const badOutputDeclaration = customFormatDeclaration('closed-vocab-probe', 1);
  (badOutputDeclaration as unknown as { outputContract: { outputs: string[] } }).outputContract.outputs = ['vibes'];
  await assert.rejects(
    () => db!.query(
      `INSERT INTO studio_formats (format_version_id, format_id, format_version, agency_id, client_id, workspace_id, status, declaration, contract_version, created_at, updated_at)
       VALUES (gen_random_uuid(), 'closed-vocab-probe', 1, $1, $2, NULL, 'draft', $3::jsonb, 'content-studio-format-v1', now(), now())`,
      [aliceScope.agencyId, aliceScope.clientId, JSON.stringify(badOutputDeclaration)],
    ),
    /check constraint/i,
  );
});
