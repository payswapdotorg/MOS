/**
 * MKT-063 integration tests — the Content Rights and Provenance
 * authority on the REAL stack: embedded PostgreSQL 18, a real API
 * process (the production composition) and the SAME in-process
 * application composed against the SAME database for the module-level
 * round trips (the notification-delivery precedent — NO network calls
 * anywhere in this suite).
 *
 * Acceptance mapping (spec/effective-backlog-v1.6.md MKT-063: "explicit
 * asset-level rights state and publication gate. Acceptance: owned/
 * license/platform-permitted/cleared/review/blocked states, ingredient
 * lineage, fail-closed autonomous publication"; the dispatch acceptance
 * criteria):
 *   - AC-1 (the state model): records are born 'unknown'; every legal
 *     transition of the frozen table round-trips at BOTH levels (module
 *     + HTTP) with the append-only event tail recording from/to/kind/
 *     reason — and the history is never mutated in place (direct SQL
 *     UPDATE/DELETE rejected by the migration-051 triggers);
 *   - AC-2 (asset-level records): the record carries the /evidence
 *     FK-anchored source provenance (unknown/foreign evidence = uniform
 *     404), the licence evidence (required for licence-basis states),
 *     the destination permission scope (newest row per platform
 *     effective) and the expiry horizon (a passed valid_until BLOCKS
 *     the gate);
 *   - AC-3 (ingredient lineage): the conjunction — all-allow allows;
 *     ANY unclear ingredient makes the composite review_required; ANY
 *     blocked/absent ingredient blocks it; a composite without lineage
 *     links is blocked outright; cycles and over-depth graphs block;
 *   - AC-4 (fail-closed autonomous publication): the gate never allows
 *     on absent records (blocked), unknown/review states
 *     (review_required — the blocked_pending_human_action surface),
 *     expired licences (blocked), unpermitted destinations (blocked),
 *     unspecified destination scope (review_required) or a non-allow
 *     destination policy (blocked — the fresh-agency no-policy battery
 *     AND the attribute-scoped deny battery); review → cleared happens
 *     ONLY through the recorded human clearance (actor identity +
 *     REQUIRED rationale — the clearance-free/auto attempts are
 *     rejected);
 *   - AC-5 (Client isolation): cross-Client reads/transitions/gates
 *     fail closed with the uniform 404 posture; cross-tenant evidence
 *     linkage and scope chains are rejected by the database itself;
 *   - AC-6 (the round trip at BOTH levels): module-level operations and
 *     the HTTP surfaces carry the same golden path
 *     (register → determine → scope → gate → clear → revoke) with the
 *     full audit tails readable back;
 *   - AC-7 (the fail-closed isolation battery): anonymous 401, the
 *     uniform 404 (foreign ≡ unknown ≡ malformed), the suspended 403;
 *   - AC-8 (the DB backstops): the append-only triggers on the event/
 *     clearance/permission/lineage tails, the no-DELETE on records, the
 *     frozen transition-table CHECKs (an illegal state move is rejected
 *     by the database itself — direct SQL).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  type IntegrationStack,
  type SpawnedProcess,
} from './helpers/harness.ts';
import { bootstrapApplication } from '../../src/composition-root.ts';
import type { ContentRightsModuleApi } from '../../src/modules/content-rights/public.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;
let rights: ContentRightsModuleApi | null = null;

function contentRights(): ContentRightsModuleApi {
  if (rights === null) throw new Error('application not bootstrapped');
  return rights;
}
function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}
function pool(): pg.Pool {
  if (stack === null) throw new Error('test stack not booted');
  return stack.pg.pool;
}

const MODULE_PROVENANCE = {
  actor: 'user:99999999-9999-4999-8999-999999999999',
  recordedVia: 'test',
  correlationId: 'integration-content-rights-1',
  causationId: null,
} as const;

// ---------------------------------------------------------------------------
// Shared fixtures (the notification-delivery precedent)
// ---------------------------------------------------------------------------

interface User {
  readonly userId: string;
  readonly token: string;
}
interface Principal {
  readonly userId: string;
  readonly token: string;
  readonly agencyId: string;
}

let adminTokenCache: string | null = null;
async function adminToken(): Promise<string> {
  if (adminTokenCache !== null) return adminTokenCache;
  const login = await apiCall(port(), '/api/auth/login', {
    body: { email: BOOTSTRAP_EMAIL, password: BOOTSTRAP_PASSWORD },
  });
  assert.equal(login.status, 200);
  adminTokenCache = login.body['token'] as string;
  return adminTokenCache;
}

async function makeUser(email: string, password: string): Promise<User> {
  const admin = await adminToken();
  const create = await apiCall(port(), '/api/users', {
    token: admin,
    body: { email, displayName: email.split('@')[0]! },
  });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  const userId = create.body['userId'] as string;
  await apiCall(port(), `/api/users/${userId}/credential`, {
    token: admin,
    body: { password },
  });
  const login = await apiCall(port(), '/api/auth/login', { body: { email, password } });
  assert.equal(login.status, 200);
  return { userId, token: login.body['token'] as string };
}

async function makeAgencyOwner(email: string): Promise<Principal> {
  const user = await makeUser(email, 'owner-password-123');
  const admin = await adminToken();
  const agency = await apiCall(port(), '/api/agencies', {
    token: admin,
    body: { name: `Agency ${email}`, ownerUserId: user.userId },
  });
  assert.equal(agency.status, 201, JSON.stringify(agency.body));
  const agencyId = (agency.body['agency'] as Record<string, unknown>)['agencyId'] as string;
  return { userId: user.userId, token: user.token, agencyId };
}

let clientSeq = 0;
async function makeClient(agencyId: string, token: string): Promise<string> {
  clientSeq += 1;
  const created = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token,
    body: { name: `Client ${agencyId.slice(0, 8)} ${clientSeq}` },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body['clientId'] as string;
}

/** Declares an AGENCY network policy version with the given rules. */
async function declareNetworkPolicy(
  principal: Principal,
  rules: ReadonlyArray<Record<string, unknown>>,
): Promise<void> {
  const declared = await apiCall(port(), `/api/agencies/${principal.agencyId}/policies`, {
    token: principal.token,
    body: {
      dimension: 'network',
      rules,
      description: 'Integration test content-rights destination policy',
    },
  });
  assert.equal(declared.status, 201, JSON.stringify(declared.body));
}

async function allowAllDestinations(principal: Principal): Promise<void> {
  await declareNetworkPolicy(principal, [
    { effect: 'allow', operations: ['*'], reason: 'integration test allowance' },
  ]);
}

let evidenceSeq = 0;
/** Creates ONE /evidence record in the client through the REAL routes. */
async function makeEvidence(token: string, clientId: string): Promise<string> {
  evidenceSeq += 1;
  const created = await apiCall(port(), `/api/clients/${clientId}/evidence`, {
    token,
    body: {
      class: 'source_fact',
      sourceSystem: 'content-rights-test',
      sourceRef: `fixture/content-rights/${evidenceSeq}`,
      observedAt: '2026-01-15T10:30:00.000Z',
      content: { kind: 'rights-provenance', seq: evidenceSeq },
      contentRef: `mos-objects://content-rights/${evidenceSeq}`,
      quality: 'C',
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body['evidenceId'] as string;
}

async function assertDbRejects(sql: string, params: unknown[], marker: string): Promise<void> {
  await assert.rejects(
    () => pool().query(sql, params as never[]),
    (error: unknown) => {
      assert.ok(
        error instanceof Error && error.message.includes(marker),
        `expected the database to reject with '${marker}', got: ${error instanceof Error ? error.message : String(error)}`,
      );
      return true;
    },
  );
}

// ---------------------------------------------------------------------------
// Shared state built once in before()
// ---------------------------------------------------------------------------

let alice: Principal;
let aliceClientId: string;
let bob: Principal;
let bobClientId: string;
let carol: Principal;
let carolClientId: string;
let suspendedMember: User;
let suspendedMembershipId: string;
let aliceEvidenceA: string;
let aliceEvidenceB: string;
let aliceEvidenceC: string;
let bobEvidence: string;

before(async () => {
  stack = await bootStack('contentrights');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  // Fixtures: three agencies (the gate golden path + the isolation + the
  // no-policy batteries), the clients, the network allowance for Alice
  // only (Bob gets a deny-scoped policy; Carol gets NO policy — the
  // fail-closed no-active-policy battery) and the /evidence anchors.
  alice = await makeAgencyOwner('alice@contentrights.test');
  bob = await makeAgencyOwner('bob@contentrights.test');
  carol = await makeAgencyOwner('carol@contentrights.test');
  aliceClientId = await makeClient(alice.agencyId, alice.token);
  bobClientId = await makeClient(bob.agencyId, bob.token);
  carolClientId = await makeClient(carol.agencyId, carol.token);
  await allowAllDestinations(alice);
  // Bob: allow everything EXCEPT tiktok destinations (the deny-scoped
  // destination-policy battery).
  await declareNetworkPolicy(bob, [
    { effect: 'allow', operations: ['*'], reason: 'integration test allowance' },
    { effect: 'deny', operations: ['content.rights.publication.tiktok'], reason: 'tiktok is not sanctioned for this agency' },
  ]);
  // Carol: NO policy at all (the fail-closed no-active-policy battery).

  aliceEvidenceA = await makeEvidence(alice.token, aliceClientId);
  aliceEvidenceB = await makeEvidence(alice.token, aliceClientId);
  aliceEvidenceC = await makeEvidence(alice.token, aliceClientId);
  bobEvidence = await makeEvidence(bob.token, bobClientId);

  // The in-process application (module-level round trips against the
  // SAME database).
  process.env.MOS_DATABASE_URL = stack.env.databaseUrl;
  process.env.MOS_INTERNAL_API_TOKEN = stack.env.internalApiToken;
  process.env.MOS_ENV = 'test';
  process.env.MOS_OBJECT_STORE = 'fs';
  process.env.MOS_OBJECT_STORE_DIR = stack.env.objectStoreDir;
  process.env.MOS_SECRETS_DIR = stack.env.secretsDir;
  const core = await bootstrapApplication();
  rights = core.modules.contentRights;

  // A suspended member of alice's agency (the 403 battery).
  suspendedMember = await makeUser('suspended@contentrights.test', 'suspended-pass-123');
  const membership = await apiCall(port(), `/api/agencies/${alice.agencyId}/memberships`, {
    token: alice.token,
    body: { userId: suspendedMember.userId, role: 'agency_operator' },
  });
  assert.equal(membership.status, 201, JSON.stringify(membership.body));
  suspendedMembershipId = membership.body['membershipId'] as string;
  const suspend = await apiCall(
    port(),
    `/api/agencies/${alice.agencyId}/memberships/${suspendedMembershipId}`,
    {
      token: alice.token,
      method: 'PATCH',
      body: { status: 'disabled', version: membership.body['version'] as number },
    },
  );
  assert.equal(suspend.status, 200, JSON.stringify(suspend.body));
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

// ---------------------------------------------------------------------------
// AC-1/AC-6: THE MODULE-LEVEL GOLDEN PATH — the full lifecycle
// ---------------------------------------------------------------------------

test('AC-6 golden path (module level): register (born unknown) → determine → scope → gate allow → contest → HUMAN CLEARANCE → revoke — the full frozen lifecycle with the append-only event tail', async () => {
  const assetRef = 'mkt063-golden-source-1';

  // 1. REGISTER: born 'unknown' — the explicit initial undetermined state.
  const registered = await contentRights().registerContentRights(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      contentAssetRef: assetRef,
      assetKind: 'source',
      sourceEvidenceRef: aliceEvidenceA,
      licenceLabel: 'CC-BY-4.0',
      licenceEvidenceRef: aliceEvidenceB,
      validUntil: null,
    },
    MODULE_PROVENANCE,
  );
  assert.equal(registered.state, 'unknown');
  assert.equal(registered.assetKind, 'source');
  assert.equal(registered.sourceEvidenceRef, aliceEvidenceA);
  assert.equal(registered.licenceEvidenceRef, aliceEvidenceB);
  assert.equal(registered.licenceLabel, 'CC-BY-4.0');
  assert.equal(registered.version, 1);

  // 2. THE GATE on the unknown state: review_required — NEVER an
  //    auto-approve (rightsUncertaintyFailsClosed).
  const unknownGate = await contentRights().evaluatePublicationGate(
    { agencyId: alice.agencyId, clientId: aliceClientId, assetRef, destinationPlatform: 'youtube' },
    MODULE_PROVENANCE,
  );
  assert.equal(unknownGate.outcome, 'review_required');
  assert.ok(unknownGate.reasons.some((reason) => reason.code === 'rights_state_unknown'));
  assert.equal(unknownGate.composite, false);
  assert.ok(unknownGate.policyDecisionId.length > 0, 'every gate evaluation records a policy decision');

  // 3. DETERMINATION: unknown → license (the licence evidence was
  //    recorded up front).
  const determination = await contentRights().recordRightsTransition(
    {
      rightsRecordId: registered.rightsRecordId,
      eventKind: 'determination',
      toState: 'license',
      reason: 'the CC-BY-4.0 licence deed was verified against the recorded licence evidence',
      clearance: null,
    },
    MODULE_PROVENANCE,
  );
  assert.equal(determination.record.state, 'license');
  assert.equal(determination.event.fromState, 'unknown');
  assert.equal(determination.event.toState, 'license');
  assert.equal(determination.event.eventKind, 'determination');
  assert.equal(determination.clearance, null);
  assert.equal(determination.record.version, 2);

  // 4. THE DESTINATION PERMISSION SCOPE: the licence permits youtube,
  //    not tiktok.
  const permitted = await contentRights().recordPlatformPermission(
    {
      rightsRecordId: registered.rightsRecordId,
      platformKey: 'youtube',
      permission: 'permitted',
      evidenceRef: aliceEvidenceB,
    },
    MODULE_PROVENANCE,
  );
  assert.equal(permitted.permission, 'permitted');
  await contentRights().recordPlatformPermission(
    {
      rightsRecordId: registered.rightsRecordId,
      platformKey: 'tiktok',
      permission: 'not_permitted',
      evidenceRef: aliceEvidenceB,
    },
    MODULE_PROVENANCE,
  );

  // 5. THE GATE: permitted destination → allow (the honest positive
  //    basis); unpermitted destination → blocked.
  const allowGate = await contentRights().evaluatePublicationGate(
    { agencyId: alice.agencyId, clientId: aliceClientId, assetRef, destinationPlatform: 'youtube' },
    MODULE_PROVENANCE,
  );
  assert.equal(allowGate.outcome, 'allow');
  assert.ok(allowGate.reasons.some((reason) => reason.code === 'allowed_license_scope'));
  const deniedDestGate = await contentRights().evaluatePublicationGate(
    { agencyId: alice.agencyId, clientId: aliceClientId, assetRef, destinationPlatform: 'tiktok' },
    MODULE_PROVENANCE,
  );
  assert.equal(deniedDestGate.outcome, 'blocked');
  assert.ok(deniedDestGate.reasons.some((reason) => reason.code === 'destination_not_permitted'));

  // An UNSPECIFIED destination (no permission row) fails closed to
  // review_required.
  const unspecifiedGate = await contentRights().evaluatePublicationGate(
    { agencyId: alice.agencyId, clientId: aliceClientId, assetRef, destinationPlatform: 'instagram' },
    MODULE_PROVENANCE,
  );
  assert.equal(unspecifiedGate.outcome, 'review_required');
  assert.ok(unspecifiedGate.reasons.some((reason) => reason.code === 'destination_permission_unspecified'));

  // 6. CONTESTATION: license → review (the rights question reopened).
  await contentRights().recordRightsTransition(
    {
      rightsRecordId: registered.rightsRecordId,
      eventKind: 'contestation',
      toState: 'review',
      reason: 'the source reported a licence dispute; the question is reopened',
      clearance: null,
    },
    MODULE_PROVENANCE,
  );
  const reviewGate = await contentRights().evaluatePublicationGate(
    { agencyId: alice.agencyId, clientId: aliceClientId, assetRef, destinationPlatform: 'youtube' },
    MODULE_PROVENANCE,
  );
  assert.equal(reviewGate.outcome, 'review_required');
  assert.ok(reviewGate.reasons.some((reason) => reason.code === 'rights_state_review'));

  // 7. THE HUMAN CLEARANCE: review → cleared — the ONLY sanctioned path,
  //    with the actor identity + REQUIRED rationale recorded.
  const cleared = await contentRights().recordRightsTransition(
    {
      rightsRecordId: registered.rightsRecordId,
      eventKind: 'human_clearance',
      toState: 'cleared',
      reason: 'human review concluded the licence dispute in the client\'s favour',
      clearance: {
        rationale: 'Counsel reviewed the CC-BY-4.0 deed and the attribution implementation; the dispute is without merit (fair-use analysis attached as evidence)',
        evidenceRef: aliceEvidenceC,
      },
    },
    MODULE_PROVENANCE,
  );
  assert.equal(cleared.record.state, 'cleared');
  assert.equal(cleared.event.fromState, 'review');
  assert.equal(cleared.event.eventKind, 'human_clearance');
  assert.ok(cleared.clearance !== null);
  assert.equal(cleared.clearance.clearedByActor, MODULE_PROVENANCE.actor);
  assert.ok(cleared.clearance.rationale.includes('Counsel reviewed'));
  assert.equal(cleared.clearance.evidenceRef, aliceEvidenceC);

  // The cleared state allows (the recorded explicit human clearance —
  // the destination-policy gate still applies).
  const clearedGate = await contentRights().evaluatePublicationGate(
    { agencyId: alice.agencyId, clientId: aliceClientId, assetRef, destinationPlatform: 'youtube' },
    MODULE_PROVENANCE,
  );
  assert.equal(clearedGate.outcome, 'allow');
  assert.ok(clearedGate.reasons.some((reason) => reason.code === 'allowed_human_clearance'));

  // 8. REVOCATION: cleared → blocked (terminal fail-closed).
  await contentRights().recordRightsTransition(
    {
      rightsRecordId: registered.rightsRecordId,
      eventKind: 'revocation',
      toState: 'blocked',
      reason: 'the licence holder revoked the grant',
      clearance: null,
    },
    MODULE_PROVENANCE,
  );
  const revokedGate = await contentRights().evaluatePublicationGate(
    { agencyId: alice.agencyId, clientId: aliceClientId, assetRef, destinationPlatform: 'youtube' },
    MODULE_PROVENANCE,
  );
  assert.equal(revokedGate.outcome, 'blocked');
  assert.ok(revokedGate.reasons.some((reason) => reason.code === 'rights_state_blocked'));

  // 9. THE APPEND-ONLY EVENT TAIL: every transition is a recorded event,
  //    in order, never mutated.
  const events = await contentRights().listRightsEvents(registered.rightsRecordId);
  assert.ok(events !== null);
  assert.equal(events.length, 4);
  assert.deepEqual(
    events.map((event) => `${event.fromState}>${event.toState}:${event.eventKind}`),
    [
      'unknown>license:determination',
      'license>review:contestation',
      'review>cleared:human_clearance',
      'cleared>blocked:revocation',
    ],
  );

  // The clearance tail reads back.
  const clearances = await contentRights().listClearances(registered.rightsRecordId);
  assert.ok(clearances !== null);
  assert.equal(clearances.length, 1);
  assert.equal(clearances[0]!.clearanceId, cleared.clearance!.clearanceId);

  // The permission tail reads back in order.
  const permissions = await contentRights().listPlatformPermissions(registered.rightsRecordId);
  assert.ok(permissions !== null);
  assert.equal(permissions.length, 2);
});

// ---------------------------------------------------------------------------
// AC-4: THE FAIL-CLOSED BATTERY (absent / expired / no-policy / deny-scoped)
// ---------------------------------------------------------------------------

test('AC-4 fail-closed: an ABSENT rights evaluation is BLOCKED, never allowed', async () => {
  const gate = await contentRights().evaluatePublicationGate(
    { agencyId: alice.agencyId, clientId: aliceClientId, assetRef: 'never-registered-asset', destinationPlatform: 'youtube' },
    MODULE_PROVENANCE,
  );
  assert.equal(gate.outcome, 'blocked');
  assert.ok(gate.reasons.some((reason) => reason.code === 'no_rights_record'));
  assert.equal(gate.composite, false);
});

test('AC-4 fail-closed: an EXPIRED licence horizon BLOCKS at gate time whatever the recorded state', async () => {
  const assetRef = 'mkt063-expired-licence';
  const registered = await contentRights().registerContentRights(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      contentAssetRef: assetRef,
      assetKind: 'source',
      sourceEvidenceRef: aliceEvidenceA,
      licenceLabel: 'Expired commercial licence',
      licenceEvidenceRef: aliceEvidenceB,
      validUntil: '2025-01-01T00:00:00.000Z',
    },
    MODULE_PROVENANCE,
  );
  await contentRights().recordRightsTransition(
    {
      rightsRecordId: registered.rightsRecordId,
      eventKind: 'determination',
      toState: 'license',
      reason: 'determined against the recorded licence evidence',
      clearance: null,
    },
    MODULE_PROVENANCE,
  );
  await contentRights().recordPlatformPermission(
    {
      rightsRecordId: registered.rightsRecordId,
      platformKey: 'youtube',
      permission: 'permitted',
      evidenceRef: aliceEvidenceB,
    },
    MODULE_PROVENANCE,
  );
  // The permission row permits, the policy allows — the EXPIRED horizon
  // still BLOCKS (fail-closed by time).
  const gate = await contentRights().evaluatePublicationGate(
    { agencyId: alice.agencyId, clientId: aliceClientId, assetRef, destinationPlatform: 'youtube' },
    MODULE_PROVENANCE,
  );
  assert.equal(gate.outcome, 'blocked');
  assert.ok(gate.reasons.some((reason) => reason.code === 'licence_expired'));
});

test('AC-4 fail-closed: a NO-POLICY agency never allows — the destination policy gate is required (destinationPolicyGateRequired)', async () => {
  const assetRef = 'mkt063-carol-owned';
  await contentRights().registerContentRights(
    {
      agencyId: carol.agencyId,
      clientId: carolClientId,
      workspaceId: null,
      contentAssetRef: assetRef,
      assetKind: 'source',
      sourceEvidenceRef: (await makeEvidence(carol.token, carolClientId)),
      licenceLabel: null,
      licenceEvidenceRef: null,
      validUntil: null,
    },
    MODULE_PROVENANCE,
  );
  // Even a fully-determined OWNED asset is BLOCKED without an explicit
  // destination-policy allow.
  const carolEvidence = await makeEvidence(carol.token, carolClientId);
  const registered = await contentRights().getRightsRecordForAsset(carolClientId, assetRef);
  assert.ok(registered !== null);
  await contentRights().recordRightsTransition(
    {
      rightsRecordId: registered.rightsRecordId,
      eventKind: 'determination',
      toState: 'owned',
      reason: 'the client\'s own studio recording',
      clearance: null,
    },
    MODULE_PROVENANCE,
  );
  void carolEvidence;
  const gate = await contentRights().evaluatePublicationGate(
    { agencyId: carol.agencyId, clientId: carolClientId, assetRef, destinationPlatform: 'youtube' },
    MODULE_PROVENANCE,
  );
  assert.equal(gate.outcome, 'blocked');
  assert.ok(gate.reasons.some((reason) => reason.code === 'policy_denied'));
});

test('AC-4 fail-closed: an attribute-scoped destination-policy DENY blocks only the denied destination', async () => {
  const assetRef = 'mkt063-bob-owned';
  const bobEvidence = await makeEvidence(bob.token, bobClientId);
  const registered = await contentRights().registerContentRights(
    {
      agencyId: bob.agencyId,
      clientId: bobClientId,
      workspaceId: null,
      contentAssetRef: assetRef,
      assetKind: 'source',
      sourceEvidenceRef: bobEvidence,
      licenceLabel: null,
      licenceEvidenceRef: null,
      validUntil: null,
    },
    MODULE_PROVENANCE,
  );
  await contentRights().recordRightsTransition(
    {
      rightsRecordId: registered.rightsRecordId,
      eventKind: 'determination',
      toState: 'owned',
      reason: 'the client\'s own content',
      clearance: null,
    },
    MODULE_PROVENANCE,
  );
  // youtube: the agency policy allows → the gate allows.
  const youtubeGate = await contentRights().evaluatePublicationGate(
    { agencyId: bob.agencyId, clientId: bobClientId, assetRef, destinationPlatform: 'youtube' },
    MODULE_PROVENANCE,
  );
  assert.equal(youtubeGate.outcome, 'allow');
  assert.ok(youtubeGate.reasons.some((reason) => reason.code === 'allowed_owned'));
  // tiktok: the DENY rule fires → the gate BLOCKS (fail-closed).
  const tiktokGate = await contentRights().evaluatePublicationGate(
    { agencyId: bob.agencyId, clientId: bobClientId, assetRef, destinationPlatform: 'tiktok' },
    MODULE_PROVENANCE,
  );
  assert.equal(tiktokGate.outcome, 'blocked');
  assert.ok(tiktokGate.reasons.some((reason) => reason.code === 'policy_denied'));
});

// ---------------------------------------------------------------------------
// AC-2: asset-level record details (evidence anchors + fences)
// ---------------------------------------------------------------------------

test('AC-2: unknown/foreign evidence is the uniform 404 — no cross-tenant oracle; duplicate registration is the honest 409', async () => {
  const assetRef = 'mkt063-evidence-fences';

  // Foreign evidence (Bob's evidence under Alice's client) → uniform 404.
  await assert.rejects(
    () =>
      contentRights().registerContentRights(
        {
          agencyId: alice.agencyId,
          clientId: aliceClientId,
          workspaceId: null,
          contentAssetRef: assetRef,
          assetKind: 'source',
          sourceEvidenceRef: bobEvidence,
          licenceLabel: null,
          licenceEvidenceRef: null,
          validUntil: null,
        },
        MODULE_PROVENANCE,
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { name?: string }).name, 'NotFoundError');
      return true;
    },
  );

  // Unknown evidence id → the same uniform 404.
  await assert.rejects(
    () =>
      contentRights().registerContentRights(
        {
          agencyId: alice.agencyId,
          clientId: aliceClientId,
          workspaceId: null,
          contentAssetRef: assetRef,
          assetKind: 'source',
          sourceEvidenceRef: '00000000-0000-4000-8000-000000000000',
          licenceLabel: null,
          licenceEvidenceRef: null,
          validUntil: null,
        },
        MODULE_PROVENANCE,
      ),
    (error: unknown) => {
      assert.equal((error as { name?: string }).name, 'NotFoundError');
      return true;
    },
  );

  // A valid registration, then the duplicate → the honest 409.
  const registered = await contentRights().registerContentRights(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      contentAssetRef: assetRef,
      assetKind: 'source',
      sourceEvidenceRef: aliceEvidenceA,
      licenceLabel: null,
      licenceEvidenceRef: null,
      validUntil: null,
    },
    MODULE_PROVENANCE,
  );
  await assert.rejects(
    () =>
      contentRights().registerContentRights(
        {
          agencyId: alice.agencyId,
          clientId: aliceClientId,
          workspaceId: null,
          contentAssetRef: assetRef,
          assetKind: 'source',
          sourceEvidenceRef: aliceEvidenceA,
          licenceLabel: null,
          licenceEvidenceRef: null,
          validUntil: null,
        },
        MODULE_PROVENANCE,
      ),
    (error: unknown) => {
      assert.equal((error as { name?: string }).name, 'ConflictError');
      return true;
    },
  );

  // The SAME asset ref in ANOTHER client is an INDEPENDENT record (the
  // per-Client fence, not a global one).
  const bobRecord = await contentRights().registerContentRights(
    {
      agencyId: bob.agencyId,
      clientId: bobClientId,
      workspaceId: null,
      contentAssetRef: assetRef,
      assetKind: 'source',
      sourceEvidenceRef: bobEvidence,
      licenceLabel: null,
      licenceEvidenceRef: null,
      validUntil: null,
    },
    MODULE_PROVENANCE,
  );
  assert.notEqual(bobRecord.rightsRecordId, registered.rightsRecordId);
});

test('AC-2: a licence-basis state without licence evidence cannot even be persisted (the payload-shape fence)', async () => {
  const assetRef = 'mkt063-licence-shape';
  // Registered WITHOUT licence evidence...
  const registered = await contentRights().registerContentRights(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      contentAssetRef: assetRef,
      assetKind: 'source',
      sourceEvidenceRef: aliceEvidenceA,
      licenceLabel: null,
      licenceEvidenceRef: null,
      validUntil: null,
    },
    MODULE_PROVENANCE,
  );
  // ...the determination to 'license' is rejected BY THE DATABASE
  // (content_rights_record_shape): there is no schema path into a
  // licence-basis state without its licence evidence.
  await assert.rejects(
    () =>
      contentRights().recordRightsTransition(
        {
          rightsRecordId: registered.rightsRecordId,
          eventKind: 'determination',
          toState: 'license',
          reason: 'attempting a licence determination without licence evidence',
          clearance: null,
        },
        MODULE_PROVENANCE,
      ),
    (error: unknown) => {
      assert.ok(
        error instanceof Error && error.message.includes('content_rights_record_shape'),
        `expected the licence-basis payload-shape fence, got: ${error instanceof Error ? error.message : String(error)}`,
      );
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// AC-3: THE INGREDIENT LINEAGE CONJUNCTION
// ---------------------------------------------------------------------------

/** Registers a determined source asset in Alice's client. */
async function registerAliceSource(
  assetRef: string,
  state: 'owned' | 'review' | 'blocked',
): Promise<string> {
  const registered = await contentRights().registerContentRights(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      contentAssetRef: assetRef,
      assetKind: 'source',
      sourceEvidenceRef: aliceEvidenceA,
      licenceLabel: null,
      licenceEvidenceRef: null,
      validUntil: null,
    },
    MODULE_PROVENANCE,
  );
  await contentRights().recordRightsTransition(
    {
      rightsRecordId: registered.rightsRecordId,
      eventKind: 'determination',
      toState: state,
      reason: `determined ${state} for the conjunction fixtures`,
      clearance: null,
    },
    MODULE_PROVENANCE,
  );
  return registered.rightsRecordId;
}

test('AC-3 conjunction: all-allow ingredients allow; ANY unclear ingredient makes the composite review_required; ANY blocked/absent ingredient blocks it', async () => {
  // Three determined ingredients.
  await registerAliceSource('mkt063-ingr-ok-1', 'owned');
  await registerAliceSource('mkt063-ingr-ok-2', 'owned');
  await registerAliceSource('mkt063-ingr-unclear', 'review');
  await registerAliceSource('mkt063-ingr-blocked', 'blocked');

  // The composite record (owned basis — its own state allows).
  const compositeOk = await contentRights().registerContentRights(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      contentAssetRef: 'mkt063-comp-ok',
      assetKind: 'composite',
      sourceEvidenceRef: aliceEvidenceA,
      licenceLabel: null,
      licenceEvidenceRef: null,
      validUntil: null,
    },
    MODULE_PROVENANCE,
  );
  await contentRights().recordRightsTransition(
    {
      rightsRecordId: compositeOk.rightsRecordId,
      eventKind: 'determination',
      toState: 'owned',
      reason: 'the composite is the client\'s own edit',
      clearance: null,
    },
    MODULE_PROVENANCE,
  );
  await contentRights().recordLineageLink(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      compositeAssetRef: 'mkt063-comp-ok',
      ingredientAssetRef: 'mkt063-ingr-ok-1',
    },
    MODULE_PROVENANCE,
  );
  await contentRights().recordLineageLink(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      compositeAssetRef: 'mkt063-comp-ok',
      ingredientAssetRef: 'mkt063-ingr-ok-2',
    },
    MODULE_PROVENANCE,
  );

  // All-allow conjunction → allow, with the per-ingredient breakdown.
  const allowGate = await contentRights().evaluatePublicationGate(
    { agencyId: alice.agencyId, clientId: aliceClientId, assetRef: 'mkt063-comp-ok', destinationPlatform: 'youtube' },
    MODULE_PROVENANCE,
  );
  assert.equal(allowGate.outcome, 'allow');
  assert.equal(allowGate.composite, true);
  assert.equal(allowGate.ingredientEvaluations.length, 2);
  assert.ok(allowGate.ingredientEvaluations.every((ingredient) => ingredient.outcome === 'allow'));

  // ANY unclear ingredient → the composite is review_required
  // (blocked_pending_human_action for the consumer).
  const compositeUnclear = await contentRights().registerContentRights(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      contentAssetRef: 'mkt063-comp-unclear',
      assetKind: 'composite',
      sourceEvidenceRef: aliceEvidenceA,
      licenceLabel: null,
      licenceEvidenceRef: null,
      validUntil: null,
    },
    MODULE_PROVENANCE,
  );
  await contentRights().recordRightsTransition(
    {
      rightsRecordId: compositeUnclear.rightsRecordId,
      eventKind: 'determination',
      toState: 'owned',
      reason: 'the composite is the client\'s own edit',
      clearance: null,
    },
    MODULE_PROVENANCE,
  );
  for (const ingredient of ['mkt063-ingr-ok-1', 'mkt063-ingr-unclear']) {
    await contentRights().recordLineageLink(
      {
        agencyId: alice.agencyId,
        clientId: aliceClientId,
        workspaceId: null,
        compositeAssetRef: 'mkt063-comp-unclear',
        ingredientAssetRef: ingredient,
      },
      MODULE_PROVENANCE,
    );
  }
  const unclearGate = await contentRights().evaluatePublicationGate(
    { agencyId: alice.agencyId, clientId: aliceClientId, assetRef: 'mkt063-comp-unclear', destinationPlatform: 'youtube' },
    MODULE_PROVENANCE,
  );
  assert.equal(unclearGate.outcome, 'review_required');
  assert.ok(unclearGate.reasons.some((reason) => reason.code === 'ingredient_rights_unclear'));

  // ANY blocked ingredient → the composite is blocked outright.
  const compositeBlocked = await contentRights().registerContentRights(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      contentAssetRef: 'mkt063-comp-blocked',
      assetKind: 'composite',
      sourceEvidenceRef: aliceEvidenceA,
      licenceLabel: null,
      licenceEvidenceRef: null,
      validUntil: null,
    },
    MODULE_PROVENANCE,
  );
  await contentRights().recordRightsTransition(
    {
      rightsRecordId: compositeBlocked.rightsRecordId,
      eventKind: 'determination',
      toState: 'owned',
      reason: 'the composite is the client\'s own edit',
      clearance: null,
    },
    MODULE_PROVENANCE,
  );
  for (const ingredient of ['mkt063-ingr-ok-1', 'mkt063-ingr-blocked']) {
    await contentRights().recordLineageLink(
      {
        agencyId: alice.agencyId,
        clientId: aliceClientId,
        workspaceId: null,
        compositeAssetRef: 'mkt063-comp-blocked',
        ingredientAssetRef: ingredient,
      },
      MODULE_PROVENANCE,
    );
  }
  const blockedGate = await contentRights().evaluatePublicationGate(
    { agencyId: alice.agencyId, clientId: aliceClientId, assetRef: 'mkt063-comp-blocked', destinationPlatform: 'youtube' },
    MODULE_PROVENANCE,
  );
  assert.equal(blockedGate.outcome, 'blocked');
  assert.ok(blockedGate.reasons.some((reason) => reason.code === 'ingredient_blocked'));

  // An ABSENT ingredient record → the composite is blocked
  // (ingredient_no_rights_record — fail-closed).
  const compositeAbsent = await contentRights().registerContentRights(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      contentAssetRef: 'mkt063-comp-absent',
      assetKind: 'composite',
      sourceEvidenceRef: aliceEvidenceA,
      licenceLabel: null,
      licenceEvidenceRef: null,
      validUntil: null,
    },
    MODULE_PROVENANCE,
  );
  await contentRights().recordRightsTransition(
    {
      rightsRecordId: compositeAbsent.rightsRecordId,
      eventKind: 'determination',
      toState: 'owned',
      reason: 'the composite is the client\'s own edit',
      clearance: null,
    },
    MODULE_PROVENANCE,
  );
  await contentRights().recordLineageLink(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      compositeAssetRef: 'mkt063-comp-absent',
      ingredientAssetRef: 'never-registered-ingredient',
    },
    MODULE_PROVENANCE,
  );
  const absentGate = await contentRights().evaluatePublicationGate(
    { agencyId: alice.agencyId, clientId: aliceClientId, assetRef: 'mkt063-comp-absent', destinationPlatform: 'youtube' },
    MODULE_PROVENANCE,
  );
  assert.equal(absentGate.outcome, 'blocked');
  assert.ok(absentGate.reasons.some((reason) => reason.code === 'ingredient_no_rights_record'));
});

test('AC-3 conjunction: a composite WITHOUT lineage links is blocked outright (sourceLineageRequired); cycles block; nested composites conjoin', async () => {
  // A composite-kind record with NO links → blocked (lineage_missing).
  const composite = await contentRights().registerContentRights(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      contentAssetRef: 'mkt063-comp-nolinks',
      assetKind: 'composite',
      sourceEvidenceRef: aliceEvidenceA,
      licenceLabel: null,
      licenceEvidenceRef: null,
      validUntil: null,
    },
    MODULE_PROVENANCE,
  );
  await contentRights().recordRightsTransition(
    {
      rightsRecordId: composite.rightsRecordId,
      eventKind: 'determination',
      toState: 'owned',
      reason: 'determined but never linked',
      clearance: null,
    },
    MODULE_PROVENANCE,
  );
  const noLinksGate = await contentRights().evaluatePublicationGate(
    { agencyId: alice.agencyId, clientId: aliceClientId, assetRef: 'mkt063-comp-nolinks', destinationPlatform: 'youtube' },
    MODULE_PROVENANCE,
  );
  assert.equal(noLinksGate.outcome, 'blocked');
  assert.ok(noLinksGate.reasons.some((reason) => reason.code === 'lineage_missing'));

  // A CYCLE: comp-a → comp-b → comp-a. Both declared composites with
  // links; the gate detects the loop and blocks fail-closed.
  for (const ref of ['mkt063-cycle-a', 'mkt063-cycle-b']) {
    const record = await contentRights().registerContentRights(
      {
        agencyId: alice.agencyId,
        clientId: aliceClientId,
        workspaceId: null,
        contentAssetRef: ref,
        assetKind: 'composite',
        sourceEvidenceRef: aliceEvidenceA,
        licenceLabel: null,
        licenceEvidenceRef: null,
        validUntil: null,
      },
      MODULE_PROVENANCE,
    );
    await contentRights().recordRightsTransition(
      {
        rightsRecordId: record.rightsRecordId,
        eventKind: 'determination',
        toState: 'owned',
        reason: 'cycle fixture',
        clearance: null,
      },
      MODULE_PROVENANCE,
    );
  }
  await contentRights().recordLineageLink(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      compositeAssetRef: 'mkt063-cycle-a',
      ingredientAssetRef: 'mkt063-cycle-b',
    },
    MODULE_PROVENANCE,
  );
  await contentRights().recordLineageLink(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      compositeAssetRef: 'mkt063-cycle-b',
      ingredientAssetRef: 'mkt063-cycle-a',
    },
    MODULE_PROVENANCE,
  );
  const cycleGate = await contentRights().evaluatePublicationGate(
    { agencyId: alice.agencyId, clientId: aliceClientId, assetRef: 'mkt063-cycle-a', destinationPlatform: 'youtube' },
    MODULE_PROVENANCE,
  );
  assert.equal(cycleGate.outcome, 'blocked');
  assert.ok(cycleGate.reasons.some((reason) => reason.code === 'lineage_cycle'));

  // A NESTED composite: outer → inner composite → unclear ingredient.
  // The conjunction propagates through the nesting (the outer composite
  // is review_required because the INNER composite's ingredient is
  // unclear).
  const inner = await contentRights().registerContentRights(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      contentAssetRef: 'mkt063-inner-comp',
      assetKind: 'composite',
      sourceEvidenceRef: aliceEvidenceA,
      licenceLabel: null,
      licenceEvidenceRef: null,
      validUntil: null,
    },
    MODULE_PROVENANCE,
  );
  await contentRights().recordRightsTransition(
    {
      rightsRecordId: inner.rightsRecordId,
      eventKind: 'determination',
      toState: 'owned',
      reason: 'inner composite fixture',
      clearance: null,
    },
    MODULE_PROVENANCE,
  );
  await contentRights().recordLineageLink(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      compositeAssetRef: 'mkt063-inner-comp',
      ingredientAssetRef: 'mkt063-ingr-unclear',
    },
    MODULE_PROVENANCE,
  );
  const outer = await contentRights().registerContentRights(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      contentAssetRef: 'mkt063-outer-comp',
      assetKind: 'composite',
      sourceEvidenceRef: aliceEvidenceA,
      licenceLabel: null,
      licenceEvidenceRef: null,
      validUntil: null,
    },
    MODULE_PROVENANCE,
  );
  await contentRights().recordRightsTransition(
    {
      rightsRecordId: outer.rightsRecordId,
      eventKind: 'determination',
      toState: 'owned',
      reason: 'outer composite fixture',
      clearance: null,
    },
    MODULE_PROVENANCE,
  );
  await contentRights().recordLineageLink(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      compositeAssetRef: 'mkt063-outer-comp',
      ingredientAssetRef: 'mkt063-inner-comp',
    },
    MODULE_PROVENANCE,
  );
  const nestedGate = await contentRights().evaluatePublicationGate(
    { agencyId: alice.agencyId, clientId: aliceClientId, assetRef: 'mkt063-outer-comp', destinationPlatform: 'youtube' },
    MODULE_PROVENANCE,
  );
  assert.equal(nestedGate.outcome, 'review_required');
  assert.ok(nestedGate.reasons.some((reason) => reason.code === 'ingredient_rights_unclear'));
  // The per-ingredient breakdown includes the nested ingredient rows.
  assert.ok(nestedGate.ingredientEvaluations.some((row) => row.assetRef === 'mkt063-ingr-unclear'));

  // Duplicate lineage links are the honest 409 (immutable composition
  // facts — one link per pair).
  await assert.rejects(
    () =>
      contentRights().recordLineageLink(
        {
          agencyId: alice.agencyId,
          clientId: aliceClientId,
          workspaceId: null,
          compositeAssetRef: 'mkt063-inner-comp',
          ingredientAssetRef: 'mkt063-ingr-unclear',
        },
        MODULE_PROVENANCE,
      ),
    (error: unknown) => {
      assert.equal((error as { name?: string }).name, 'ConflictError');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// AC-4/AC-1: THE HUMAN-CLEARANCE SPINE (no auto-clear path)
// ---------------------------------------------------------------------------

test('AC-1/AC-4: review → cleared happens ONLY through the recorded human clearance — every auto/clearance-free attempt fails closed', async () => {
  const assetRef = 'mkt063-clearance-spine';
  const registered = await contentRights().registerContentRights(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      contentAssetRef: assetRef,
      assetKind: 'source',
      sourceEvidenceRef: aliceEvidenceA,
      licenceLabel: null,
      licenceEvidenceRef: null,
      validUntil: null,
    },
    MODULE_PROVENANCE,
  );

  // unknown → cleared is NOT a row of the frozen table (no
  // determination auto-approves into cleared).
  await assert.rejects(
    () =>
      contentRights().recordRightsTransition(
        {
          rightsRecordId: registered.rightsRecordId,
          eventKind: 'determination',
          toState: 'cleared',
          reason: 'attempting an auto-clear',
          clearance: null,
        },
        MODULE_PROVENANCE,
      ),
    (error: unknown) => {
      assert.equal((error as { name?: string }).name, 'ConflictError');
      return true;
    },
  );

  // human_clearance without the clearance payload → fail-closed by
  // rejection (InvalidRequestError BEFORE any write).
  await assert.rejects(
    () =>
      contentRights().recordRightsTransition(
        {
          rightsRecordId: registered.rightsRecordId,
          eventKind: 'human_clearance',
          toState: 'cleared',
          reason: 'clearance-free attempt',
          clearance: null,
        },
        MODULE_PROVENANCE,
      ),
    (error: unknown) => {
      assert.equal((error as { name?: string }).name, 'InvalidRequestError');
      return true;
    },
  );

  // Move to review first (the only path toward cleared).
  await contentRights().recordRightsTransition(
    {
      rightsRecordId: registered.rightsRecordId,
      eventKind: 'determination',
      toState: 'review',
      reason: 'the licence question needs a human',
      clearance: null,
    },
    MODULE_PROVENANCE,
  );

  // A clearance payload on a NON-clearance kind → fail-closed.
  await assert.rejects(
    () =>
      contentRights().recordRightsTransition(
        {
          rightsRecordId: registered.rightsRecordId,
          eventKind: 'contestation',
          toState: 'review',
          reason: 'wrong kind for a payload',
          clearance: { rationale: 'should be rejected', evidenceRef: null },
        },
        MODULE_PROVENANCE,
      ),
    (error: unknown) => {
      assert.equal((error as { name?: string }).name, 'InvalidRequestError');
      return true;
    },
  );

  // The sanctioned path: review → cleared WITH the clearance.
  const cleared = await contentRights().recordRightsTransition(
    {
      rightsRecordId: registered.rightsRecordId,
      eventKind: 'human_clearance',
      toState: 'cleared',
      reason: 'human review completed',
      clearance: { rationale: 'reviewed and cleared by the rights operator', evidenceRef: null },
    },
    MODULE_PROVENANCE,
  );
  assert.equal(cleared.record.state, 'cleared');
  assert.equal(cleared.clearance!.clearedByActor, MODULE_PROVENANCE.actor);

  // Once cleared, no further transition into cleared exists (cleared →
  // cleared is not a row; the state machine is spent).
  await assert.rejects(
    () =>
      contentRights().recordRightsTransition(
        {
          rightsRecordId: registered.rightsRecordId,
          eventKind: 'human_clearance',
          toState: 'cleared',
          reason: 'double clearing',
          clearance: { rationale: 'second clearance', evidenceRef: null },
        },
        MODULE_PROVENANCE,
      ),
    (error: unknown) => {
      assert.equal((error as { name?: string }).name, 'ConflictError');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// AC-8: THE DB BACKSTOPS (append-only + the frozen transition table)
// ---------------------------------------------------------------------------

test('AC-8 DB backstops: the append-only tails reject UPDATE/DELETE; no record DELETE; illegal state moves are rejected by the database itself', async () => {
  const assetRef = 'mkt063-db-backstops';
  const registered = await contentRights().registerContentRights(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      contentAssetRef: assetRef,
      assetKind: 'source',
      sourceEvidenceRef: aliceEvidenceA,
      licenceLabel: null,
      licenceEvidenceRef: null,
      validUntil: null,
    },
    MODULE_PROVENANCE,
  );
  const determined = await contentRights().recordRightsTransition(
    {
      rightsRecordId: registered.rightsRecordId,
      eventKind: 'determination',
      toState: 'owned',
      reason: 'db backstop fixture',
      clearance: null,
    },
    MODULE_PROVENANCE,
  );
  const eventId = determined.event.eventId;

  // The event tail is append-only: no UPDATE (no in-place history
  // mutation), no DELETE.
  await assertDbRejects(
    'UPDATE content_rights_events SET reason = \'rewritten history\' WHERE event_id = $1',
    [eventId],
    'append-only',
  );
  await assertDbRejects(
    'DELETE FROM content_rights_events WHERE event_id = $1',
    [eventId],
    'append-only',
  );

  // The records admit no DELETE.
  await assertDbRejects(
    'DELETE FROM content_rights_records WHERE rights_record_id = $1',
    [registered.rightsRecordId],
    'cannot be deleted',
  );

  // An ILLEGAL state move by direct SQL is rejected by the frozen
  // transition-table pairs (owned → cleared is not legal; unknown →
  // cleared never was).
  await assertDbRejects(
    'UPDATE content_rights_records SET state = \'cleared\', updated_at = now(), version = version + 1 WHERE rights_record_id = $1',
    [registered.rightsRecordId],
    'illegal content rights state move',
  );

  // The recorded facts are immutable through ANY mutation path (the
  // disciplined record trigger).
  await assertDbRejects(
    'UPDATE content_rights_records SET licence_label = \'rewritten\' WHERE rights_record_id = $1',
    [registered.rightsRecordId],
    'recorded facts are immutable',
  );

  // The lineage links are fully append-only + immutable.
  const link = await contentRights().recordLineageLink(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      compositeAssetRef: 'mkt063-db-comp',
      ingredientAssetRef: assetRef,
    },
    MODULE_PROVENANCE,
  );
  await assertDbRejects(
    'UPDATE content_rights_lineage_links SET ingredient_asset_ref = \'rewritten\' WHERE lineage_link_id = $1',
    [link.lineageLinkId],
    'append-only',
  );
  await assertDbRejects(
    'DELETE FROM content_rights_lineage_links WHERE lineage_link_id = $1',
    [link.lineageLinkId],
    'append-only',
  );

  // A direct-SQL event row outside the frozen transition table is
  // rejected by the CHECK (the persisted mirror of the pure guard):
  // a determination that does not resolve the unknown state.
  await assertDbRejects(
    `INSERT INTO content_rights_events
       (event_id, rights_record_id, from_state, to_state, event_kind, reason,
        recorded_by_actor, recorded_via, correlation_id)
     VALUES (gen_random_uuid(), $1, 'owned', 'review', 'determination', 'forged determination from a determined state',
             'forger', 'sql', 'forged')`,
    [registered.rightsRecordId],
    'content_rights_transition_table_check',
  );
  // And a human_clearance row WITHOUT its clearance is rejected by the
  // event-shape CHECK (clearance_id is REQUIRED exactly for the
  // human_clearance kind — there is no clearance-free path into cleared).
  await assertDbRejects(
    `INSERT INTO content_rights_events
       (event_id, rights_record_id, from_state, to_state, event_kind, reason,
        recorded_by_actor, recorded_via, correlation_id)
     VALUES (gen_random_uuid(), $1, 'review', 'cleared', 'human_clearance', 'forged clearance-free event',
             'forger', 'sql', 'forged')`,
    [registered.rightsRecordId],
    'content_rights_event_shape',
  );

  // The permission + clearance tails are append-only too.
  const permission = await contentRights().recordPlatformPermission(
    {
      rightsRecordId: registered.rightsRecordId,
      platformKey: 'youtube',
      permission: 'permitted',
      evidenceRef: aliceEvidenceA,
    },
    MODULE_PROVENANCE,
  );
  await assertDbRejects(
    'UPDATE content_rights_permissions SET permission = \'not_permitted\' WHERE permission_id = $1',
    [permission.permissionId],
    'append-only',
  );
});

// ---------------------------------------------------------------------------
// AC-5/AC-7: THE CLIENT-ISOLATION BATTERY + the HTTP round trip
// ---------------------------------------------------------------------------

test('AC-7 HTTP golden path + isolation: register/list/by-asset/gate/transitions through the routes — uniform 404 on foreign/unknown/malformed, 401 anonymous, 403 suspended', async () => {
  const assetRef = 'mkt063-http-asset';

  // Anonymous → 401.
  const anonymous = await apiCall(port(), `/api/clients/${aliceClientId}/content-rights`, {
    body: { assetRef, destinationPlatform: 'youtube' },
  });
  assert.equal(anonymous.status, 401);

  // Register through the route (owner|admin).
  const registeredResponse = await apiCall(port(), `/api/clients/${aliceClientId}/content-rights`, {
    token: alice.token,
    body: {
      contentAssetRef: assetRef,
      assetKind: 'source',
      sourceEvidenceRef: aliceEvidenceA,
    },
  });
  assert.equal(registeredResponse.status, 201, JSON.stringify(registeredResponse.body));
  const record = registeredResponse.body['record'] as Record<string, unknown>;
  const rightsRecordId = record['rightsRecordId'] as string;
  assert.equal(record['state'], 'unknown');
  assert.equal(record['assetKind'], 'source');

  // The list + by-asset reads.
  const list = await apiCall(port(), `/api/clients/${aliceClientId}/content-rights`, {
    token: alice.token,
  });
  assert.equal(list.status, 200);
  assert.ok((list.body['records'] as unknown[]).length >= 1);
  const byAsset = await apiCall(port(), `/api/clients/${aliceClientId}/content-rights/by-asset/${assetRef}`, {
    token: alice.token,
  });
  assert.equal(byAsset.status, 200);
  assert.equal((byAsset.body['record'] as Record<string, unknown>)['rightsRecordId'], rightsRecordId);

  // The determination transition through the route.
  const transition = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/content-rights/${rightsRecordId}/transitions`,
    {
      token: alice.token,
      body: {
        eventKind: 'determination',
        toState: 'owned',
        reason: 'the client\'s own recording (HTTP)',
      },
    },
  );
  assert.equal(transition.status, 201, JSON.stringify(transition.body));
  assert.equal((transition.body['record'] as Record<string, unknown>)['state'], 'owned');

  // The GATE through the route: allow with reasons + the policy
  // decision id.
  const gate = await apiCall(port(), `/api/clients/${aliceClientId}/content-rights/gate`, {
    token: alice.token,
    body: { assetRef, destinationPlatform: 'youtube' },
  });
  assert.equal(gate.status, 200, JSON.stringify(gate.body));
  const gateBody = gate.body['gate'] as Record<string, unknown>;
  assert.equal(gateBody['outcome'], 'allow');
  assert.ok(typeof gateBody['policyDecisionId'] === 'string' && gateBody['policyDecisionId'] !== '');
  assert.ok(
    (gateBody['reasons'] as unknown[]).some(
      (reason) => (reason as Record<string, unknown>)['code'] === 'allowed_owned',
    ),
  );

  // A human_clearance attempt WITHOUT the rationale → the honest 422
  // (InvalidRequestError — fail-closed by rejection BEFORE any write).
  const badClearance = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/content-rights/${rightsRecordId}/transitions`,
    {
      token: alice.token,
      body: {
        eventKind: 'human_clearance',
        toState: 'cleared',
        reason: 'missing rationale payload',
      },
    },
  );
  assert.equal(badClearance.status, 422);

  // THE UNIFORM 404 BATTERY (foreign ≡ unknown ≡ malformed).
  // Bob's member on Alice's record → 404 (no cross-tenant oracle).
  const foreignTransition = await apiCall(
    port(),
    `/api/clients/${bobClientId}/content-rights/${rightsRecordId}/transitions`,
    {
      token: bob.token,
      body: { eventKind: 'contestation', toState: 'review', reason: 'foreign attempt' },
    },
  );
  assert.equal(foreignTransition.status, 404);
  const foreignDetail = await apiCall(
    port(),
    `/api/clients/${bobClientId}/content-rights/${rightsRecordId}`,
    { token: bob.token },
  );
  assert.equal(foreignDetail.status, 404);
  // Unknown record id → the same 404.
  const unknownDetail = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/content-rights/00000000-0000-4000-8000-000000000000`,
    { token: alice.token },
  );
  assert.equal(unknownDetail.status, 404);
  // Malformed record id → the same 404.
  const malformedDetail = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/content-rights/not-a-uuid`,
    { token: alice.token },
  );
  assert.equal(malformedDetail.status, 404);
  // Foreign evidence in a registration → the uniform 404 (Bob's
  // evidence under Alice's client).
  const foreignEvidence = await apiCall(port(), `/api/clients/${aliceClientId}/content-rights`, {
    token: alice.token,
    body: {
      contentAssetRef: 'mkt063-foreign-evidence',
      assetKind: 'source',
      sourceEvidenceRef: bobEvidence,
    },
  });
  assert.equal(foreignEvidence.status, 404);
  // A foreign workspace narrowing → the uniform 404.
  const foreignWorkspace = await apiCall(port(), `/api/clients/${aliceClientId}/content-rights`, {
    token: alice.token,
    body: {
      contentAssetRef: 'mkt063-foreign-workspace',
      assetKind: 'source',
      sourceEvidenceRef: aliceEvidenceA,
      workspaceId: '00000000-0000-4000-8000-000000000000',
    },
  });
  assert.equal(foreignWorkspace.status, 404);

  // The suspended member → 403.
  const suspendedGate = await apiCall(port(), `/api/clients/${aliceClientId}/content-rights/gate`, {
    token: suspendedMember.token,
    body: { assetRef, destinationPlatform: 'youtube' },
  });
  assert.equal(suspendedGate.status, 403);

  // Bob's gate on Alice's asset: no record in Bob's client → blocked
  // (no_rights_record — records are Client-scoped; the isolation fails
  // closed at the GATE too, not just at the reads).
  const bobGate = await apiCall(port(), `/api/clients/${bobClientId}/content-rights/gate`, {
    token: bob.token,
    body: { assetRef, destinationPlatform: 'youtube' },
  });
  assert.equal(bobGate.status, 200);
  const bobGateBody = bobGate.body['gate'] as Record<string, unknown>;
  assert.equal(bobGateBody['outcome'], 'blocked');
  assert.ok(
    (bobGateBody['reasons'] as unknown[]).some(
      (reason) => (reason as Record<string, unknown>)['code'] === 'no_rights_record',
    ),
  );

  // The permission route appends a scope row (owner|admin) and the
  // lineage route records a composition fact.
  const permissionResponse = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/content-rights/${rightsRecordId}/permissions`,
    {
      token: alice.token,
      body: { platformKey: 'youtube', permission: 'permitted', evidenceRef: aliceEvidenceA },
    },
  );
  assert.equal(permissionResponse.status, 201, JSON.stringify(permissionResponse.body));
  const lineageResponse = await apiCall(port(), `/api/clients/${aliceClientId}/content-rights/lineage`, {
    token: alice.token,
    body: { compositeAssetRef: 'mkt063-http-comp', ingredientAssetRef: assetRef },
  });
  assert.equal(lineageResponse.status, 201, JSON.stringify(lineageResponse.body));
  const lineageRead = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/content-rights/lineage/mkt063-http-comp`,
    { token: alice.token },
  );
  assert.equal(lineageRead.status, 200);
  assert.equal((lineageRead.body['lineageLinks'] as unknown[]).length, 1);

  // The record detail carries the full tails.
  const detail = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/content-rights/${rightsRecordId}`,
    { token: alice.token },
  );
  assert.equal(detail.status, 200);
  const detailBody = detail.body as Record<string, unknown>;
  assert.equal((detailBody['events'] as unknown[]).length, 1);
  assert.equal((detailBody['permissions'] as unknown[]).length, 1);
  assert.equal((detailBody['clearances'] as unknown[]).length, 0);

  // The re-registration through the route → the honest 409.
  const duplicate = await apiCall(port(), `/api/clients/${aliceClientId}/content-rights`, {
    token: alice.token,
    body: {
      contentAssetRef: assetRef,
      assetKind: 'source',
      sourceEvidenceRef: aliceEvidenceA,
    },
  });
  assert.equal(duplicate.status, 409);

  // Non-owner members may READ but not MUTATE (the role fence).
  const operator = await makeUser('operator@contentrights.test', 'operator-pass-123');
  const membership = await apiCall(port(), `/api/agencies/${alice.agencyId}/memberships`, {
    token: alice.token,
    body: { userId: operator.userId, role: 'agency_operator' },
  });
  assert.equal(membership.status, 201);
  const operatorRead = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/content-rights/${rightsRecordId}`,
    { token: operator.token },
  );
  assert.equal(operatorRead.status, 200);
  const operatorRegister = await apiCall(port(), `/api/clients/${aliceClientId}/content-rights`, {
    token: operator.token,
    body: {
      contentAssetRef: 'mkt063-operator-attempt',
      assetKind: 'source',
      sourceEvidenceRef: aliceEvidenceA,
    },
  });
  assert.equal(operatorRegister.status, 403);
});

test('AC-5 cross-Client DB fences: cross-tenant lineage scope chains and evidence linkage are rejected by the database itself', async () => {
  // A lineage link whose client does not belong to its agency → the
  // scope-chain trigger rejects the insert.
  await assertDbRejects(
    `INSERT INTO content_rights_lineage_links
       (lineage_link_id, agency_id, client_id, composite_asset_ref, ingredient_asset_ref,
        recorded_by_actor, recorded_via, correlation_id)
     VALUES (gen_random_uuid(), $1, $2, 'forged-comp', 'forged-ingr', 'forger', 'sql', 'forged')`,
    [bob.agencyId, aliceClientId],
    'tenant scope chain cannot be crossed',
  );

  // A rights record citing ANOTHER client's evidence → the same-Client
  // evidence trigger rejects the insert.
  await assertDbRejects(
    `INSERT INTO content_rights_records
       (rights_record_id, agency_id, client_id, content_asset_ref, asset_kind, state,
        source_evidence_ref, created_by_actor, created_via, correlation_id)
     VALUES (gen_random_uuid(), $1, $2, 'forged-asset', 'source', 'unknown', $3, 'forger', 'sql', 'forged')`,
    [alice.agencyId, aliceClientId, bobEvidence],
    'cross-tenant evidence linkage is rejected',
  );
});
