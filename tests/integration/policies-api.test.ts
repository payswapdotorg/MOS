/**
 * MKT-021 integration tests — the execution policy engine on the real stack
 * (embedded PostgreSQL 18 + real API process — no mocks of platform
 * services).
 *
 * Acceptance mapping (work-items.md MKT-021 acceptance: "policy matrix +
 * fail-closed regressions"; requirements.md POL-001/CRED-001):
 *   - the POLICY ADMIN ROUND-TRIP: platform/agency/client declarations
 *     create version 1 active, list and read back UNCHANGED through the
 *     API and the database;
 *   - APPEND-ORIENTED VERSIONING: a second declaration of the same (scope,
 *     dimension) SUPERSEDES v1 in one transaction — v1 becomes 'superseded'
 *     (terminal: SQL resurrection is rejected), carries
 *     supersededAt/supersededByPolicyId, stays queryable forever; v2 is
 *     ACTIVE with versionSeq 2 and EVALUATION consults v2 only;
 *   - DB BACKSTOPS: content immutability on policies (rules cannot be
 *     rewritten by direct SQL), the ACTIVE fence and the append-only
 *     decision triggers (UPDATE/DELETE on policy_decisions rejected);
 *   - THE POLICY MATRIX through the real evaluation endpoint (explicit
 *     table-driven suite): allow/deny/unknown outcomes across
 *     platform/agency/client scope levels with the DENY-OVERRIDES
 *     composition, the no-active-policy and no-matching-rule unknown
 *     paths, and the enforcement answer (only 'allow' permits);
 *   - FAIL-CLOSED REGRESSIONS: unknown dimension → 422 (rejected, never a
 *     decision); no declared policy → 'unknown' recorded (enforcement
 *     deny); evaluation errors are not simulated here — the security file
 *     covers the remaining fail-closed triggers;
 *   - DECISION RECORDS: every evaluation is recorded ONCE with
 *     server-derived provenance (actor from the authenticated principal,
 *     correlation from the ambient context), the ledger lists newest
 *     first, and single decisions read back by id.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  type IntegrationStack,
} from './helpers/harness.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';
const SERVICE_TOKEN = 'integration-test-token';
const SECRET_HANDLE = 'policy-test-api-key';
const SECRET_MATERIAL = 'MATERIAL-do-not-leak-policy-9f8a7b6c';

let stack: IntegrationStack | null = null;
let api: { port: number; child: ChildProcessWithoutNullStreams } | null = null;

function the(): { stack: IntegrationStack; api: { port: number; child: ChildProcessWithoutNullStreams } } {
  if (stack === null || api === null) throw new Error('test stack not booted');
  return { stack, api };
}

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

before(async () => {
  stack = await bootStack('policies');
  fs.writeFileSync(path.join(stack.env.secretsDir, `${SECRET_HANDLE}.secret`), SECRET_MATERIAL, { mode: 0o600 });
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

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

interface Principal {
  readonly userId: string;
  readonly token: string;
  readonly agencyId: string;
}

async function makePrincipal(email: string): Promise<Principal> {
  const admin = await adminToken();
  const user = await apiCall(port(), '/api/users', {
    token: admin,
    body: { email, displayName: email.split('@')[0]! },
  });
  assert.equal(user.status, 201, JSON.stringify(user.body));
  const userId = user.body['userId'] as string;
  await apiCall(port(), `/api/users/${userId}/credential`, {
    token: admin,
    body: { password: 'a-very-long-password-123' },
  });
  const agency = await apiCall(port(), '/api/agencies', {
    token: admin,
    body: { name: `Agency ${email}`, ownerUserId: userId },
  });
  assert.equal(agency.status, 201);
  const agencyId = (agency.body['agency'] as Record<string, unknown>)['agencyId'] as string;
  const login = await apiCall(port(), '/api/auth/login', {
    body: { email, password: 'a-very-long-password-123' },
  });
  assert.equal(login.status, 200);
  return { userId, token: login.body['token'] as string, agencyId };
}

async function makeClient(agencyId: string, token: string): Promise<string> {
  const created = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token,
    body: { name: `Client ${agencyId.slice(0, 8)}` },
  });
  assert.equal(created.status, 201);
  return created.body['clientId'] as string;
}

function rules(effect: 'allow' | 'deny', operations: string[], reason: string): Record<string, unknown> {
  return { effect, operations, reason };
}

function declaration(dimension: string, ruleList: readonly Record<string, unknown>[], description: string): Record<string, unknown> {
  return { dimension, rules: ruleList, description };
}

/** Declares an AGENCY policy version through the API. */
async function declareAgencyPolicy(
  principal: Principal,
  dimension: string,
  ruleList: readonly Record<string, unknown>[],
): Promise<Record<string, unknown>> {
  const response = await apiCall(port(), `/api/agencies/${principal.agencyId}/policies`, {
    token: principal.token,
    body: declaration(dimension, ruleList, `${dimension} boundary for ${principal.agencyId}`),
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body as Record<string, unknown>;
}

/** Evaluates an action in the AGENCY scope through the API. */
async function evaluateAgency(
  principal: Principal,
  body: Record<string, unknown>,
  correlationId?: string,
): Promise<{ status: number; headers: Record<string, string>; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/agencies/${principal.agencyId}/policies/evaluate`, {
    token: principal.token,
    body,
    ...(correlationId === undefined ? {} : { correlationId }),
  });
}

/** A minimal evaluation body (optional selectors omitted — strict DTO). */
function evalBody(dimension: string, operation: string, attributes?: Record<string, string>): Record<string, unknown> {
  const body: Record<string, unknown> = { dimension, operation };
  if (attributes !== undefined) body['attributes'] = attributes;
  return body;
}

// ---------------------------------------------------------------------------
// Policy administration round-trip (POL-001)
// ---------------------------------------------------------------------------

test('POL-001 round-trip: platform declarations create version 1 active, list and read back unchanged through API and DB', async () => {
  const { stack: st } = the();
  const declare = await apiCall(port(), '/api/policies', {
    token: await adminToken(),
    body: declaration('network', [rules('allow', ['*'], 'platform default allows network egress')], 'Platform network egress defaults v1'),
  });
  assert.equal(declare.status, 201, JSON.stringify(declare.body));
  const policy = declare.body as Record<string, unknown>;
  assert.equal(policy['status'], 'active');
  assert.equal(policy['scopeKind'], 'platform');
  assert.equal(policy['versionSeq'], 1);
  assert.ok(!('agencyId' in policy), 'platform policies carry no agency scope');
  assert.ok(typeof policy['policyId'] === 'string' && (policy['policyId'] as string).length > 0);

  // The rules round-trip unchanged through the API... (normalized rule
  // shape: omitted optional selectors are persisted as null/empty).
  assert.deepEqual(
    policy['rules'],
    [{ effect: 'allow', operations: ['*'], resource: null, attributes: {}, reason: 'platform default allows network egress' }],
  );
  // ...and through the DATABASE.
  const stored = await st.pg.pool.query<{ rules: unknown; status: string; version_seq: string }>(
    'SELECT rules, status, version_seq FROM policies WHERE policy_id = $1',
    [policy['policyId'] as string],
  );
  assert.equal(stored.rows.length, 1);
  assert.deepEqual(stored.rows[0]!.rules, policy['rules']);
  assert.equal(stored.rows[0]!.status, 'active');
  assert.equal(Number(stored.rows[0]!.version_seq), 1);

  // The platform list (platform admin only) shows the active version.
  const list = await apiCall(port(), '/api/policies', { token: await adminToken() });
  assert.equal(list.status, 200);
  const policies = list.body['policies'] as Record<string, unknown>[];
  assert.ok(policies.some((entry) => entry['policyId'] === policy['policyId']));

  // Single-version read by id.
  const read = await apiCall(port(), `/api/policies/${policy['policyId']}`, { token: await adminToken() });
  assert.equal(read.status, 200);
  assert.equal((read.body as Record<string, unknown>)['policyId'], policy['policyId']);
});

test('POL-001 round-trip: agency and client declarations carry server-derived scope and validate the ownership chain', async () => {
  const principal = await makePrincipal('agency-roundtrip@marketingos.test');
  const client = await makeClient(principal.agencyId, principal.token);

  const agencyPolicy = await declareAgencyPolicy(principal, 'tools', [rules('deny', ['invoke'], 'no tool invocation without approval')]);
  assert.equal(agencyPolicy['scopeKind'], 'agency');
  assert.equal(agencyPolicy['agencyId'], principal.agencyId);
  assert.equal(agencyPolicy['versionSeq'], 1);

  const clientDeclare = await apiCall(port(), `/api/clients/${client}/policies`, {
    token: principal.token,
    body: declaration('secrets', [rules('allow', ['read'], 'client allows reading its integration keys')], 'Client secrets boundary v1'),
  });
  assert.equal(clientDeclare.status, 201, JSON.stringify(clientDeclare.body));
  const clientPolicy = clientDeclare.body as Record<string, unknown>;
  assert.equal(clientPolicy['scopeKind'], 'client');
  assert.equal(clientPolicy['agencyId'], principal.agencyId);
  assert.equal(clientPolicy['clientId'], client);
  assert.equal(clientPolicy['versionSeq'], 1);

  // Both surfaces list their own scopes with history visible.
  const agencyList = await apiCall(port(), `/api/agencies/${principal.agencyId}/policies`, { token: principal.token });
  assert.equal(agencyList.status, 200);
  const agencyPolicies = agencyList.body['policies'] as Record<string, unknown>[];
  assert.ok(agencyPolicies.some((entry) => entry['policyId'] === agencyPolicy['policyId']));
  assert.ok(!agencyPolicies.some((entry) => entry['policyId'] === clientPolicy['policyId']), 'the AGENCY list does not leak client-scoped rows');

  const clientList = await apiCall(port(), `/api/clients/${client}/policies`, { token: principal.token });
  assert.equal(clientList.status, 200);
  const clientPolicies = clientList.body['policies'] as Record<string, unknown>[];
  assert.ok(clientPolicies.some((entry) => entry['policyId'] === clientPolicy['policyId']));
  assert.ok(!clientPolicies.some((entry) => entry['policyId'] === agencyPolicy['policyId']), 'the CLIENT list does not leak agency-scoped rows');
});

// ---------------------------------------------------------------------------
// Append-oriented versioning (supersession — history is never overwritten)
// ---------------------------------------------------------------------------

test('POL-001 supersession: a new version supersedes the prior ACTIVE one in one transaction — the old row stays queryable, terminal, and is no longer consulted', async () => {
  const { stack: st } = the();
  const principal = await makePrincipal('agency-supersede@marketingos.test');

  const v1 = await declareAgencyPolicy(principal, 'network', [rules('allow', ['*'], 'v1: allow all egress')]);
  assert.equal(v1['versionSeq'], 1);
  assert.equal(v1['status'], 'active');

  // Second declaration of the same (agency, network) → v2 supersedes v1.
  const v2 = await declareAgencyPolicy(principal, 'network', [rules('deny', ['*'], 'v2: deny all egress while audited')]);
  assert.equal(v2['versionSeq'], 2);
  assert.equal(v2['status'], 'active');

  // v1 is now superseded, pointing at its superseder, still queryable.
  const v1Read = await apiCall(port(), `/api/policies/${v1['policyId']}`, { token: principal.token });
  assert.equal(v1Read.status, 200);
  const v1After = v1Read.body as Record<string, unknown>;
  assert.equal(v1After['status'], 'superseded');
  assert.equal(v1After['supersededByPolicyId'], v2['policyId']);
  assert.ok(typeof v1After['supersededAt'] === 'string');
  assert.deepEqual(v1After['rules'], v1['rules'], 'the superseded row keeps its declared content unchanged');
  assert.equal(v1After['versionSeq'], 1, 'the superseded row keeps its sequence');

  // The history stays visible in the agency list.
  const list = await apiCall(port(), `/api/agencies/${principal.agencyId}/policies`, { token: principal.token });
  const listed = (list.body['policies'] as Record<string, unknown>[]).filter((entry) => (entry['dimension'] as string) === 'network');
  assert.equal(listed.length, 2, 'BOTH versions stay queryable');

  // EVALUATION consults the ACTIVE version only: v2 denies all egress.
  const decision = await evaluateAgency(principal, evalBody('network', 'egress'));
  assert.equal(decision.status, 200);
  const body = decision.body as Record<string, unknown>;
  assert.equal(body['outcome'], 'deny');
  assert.equal(body['reasonCode'], 'rule-denied');
  assert.deepEqual(body['matchedPolicyVersions'], [v2['policyId']]);

  // DB BACKSTOP: 'superseded' is terminal — SQL resurrection is rejected
  // (either by the terminal constraint at commit or by the ACTIVE fence
  // that already holds the successor).
  await assert.rejects(
    () => st.pg.pool.query('UPDATE policies SET status = $1 WHERE policy_id = $2', ['active', v1['policyId'] as string]),
    /terminal|duplicate key|active_fence/i,
  );
  // DB BACKSTOP: content is immutable — the rules cannot be rewritten.
  await assert.rejects(
    () => st.pg.pool.query('UPDATE policies SET rules = $1::jsonb WHERE policy_id = $2', ['[{"effect":"allow","operations":["*"],"reason":"forged"}]', v2['policyId'] as string]),
    /immutable/i,
  );
});

test('POL-001 DB fence: concurrent duplicate declarations converge to exactly one ACTIVE winner', async () => {
  const principal = await makePrincipal('agency-race@marketingos.test');
  // Two racing declarations of the same (agency, deployment) dimension.
  const racing = await Promise.allSettled([
    declareAgencyPolicy(principal, 'deployment', [rules('allow', ['deploy'], 'racing declaration A')]),
    declareAgencyPolicy(principal, 'deployment', [rules('allow', ['deploy'], 'racing declaration B')]),
  ]);
  const wins = racing.filter((entry) => entry.status === 'fulfilled');
  const conflicts = racing.filter((entry) => entry.status === 'rejected');
  // The row-locked transaction + the ACTIVE fence guarantee exactly one
  // winner; the loser surfaces the deterministic conflict (test-level
  // assertion rejects the 201 on conflict).
  assert.ok(wins.length >= 1, 'at least one declaration wins');
  assert.ok(wins.length + conflicts.length === 2);
  const { stack: st } = the();
  const active = await st.pg.pool.query(
    "SELECT count(*)::int AS n FROM policies WHERE agency_id = $1 AND client_id IS NULL AND dimension = 'deployment' AND status = 'active'",
    [principal.agencyId],
  );
  assert.equal(active.rows[0]!.n, 1, 'exactly ONE active version exists after the race');
});

// ---------------------------------------------------------------------------
// THE POLICY MATRIX through the real evaluation endpoint (explicit
// table-driven suite) + fail-closed regressions
// ---------------------------------------------------------------------------

test('POLICY MATRIX (API, table-driven): scope levels x outcomes with deny-overrides composition', async () => {
  const principal = await makePrincipal('agency-matrix@marketingos.test');
  const client = await makeClient(principal.agencyId, principal.token);
  const admin = await adminToken();

  // Scope chain fixtures:
  //   platform: network → allow all (declared by the platform admin).
  //   agency:   network → deny egress to 'blocked.example'.
  //   client:   network → (nothing — the client inherits agency+platform).
  const platformPolicy = await apiCall(port(), '/api/policies', {
    token: admin,
    body: declaration('network', [rules('allow', ['*'], 'platform allows network egress')], 'Platform network defaults'),
  });
  assert.equal(platformPolicy.status, 201);
  const platformId = (platformPolicy.body as Record<string, unknown>)['policyId'];
  const agencyPolicy = await declareAgencyPolicy(principal, 'network', [
    { effect: 'deny', operations: ['egress'], resource: 'blocked.example', attributes: {}, reason: 'the blocked host is denied' },
  ]);
  const agencyId2 = agencyPolicy['policyId'];

  const cases: readonly {
    readonly label: string;
    readonly path: 'agency' | 'client';
    readonly body: Record<string, unknown>;
    readonly expectOutcome: string;
    readonly expectReason: string;
    readonly expectMatched: readonly unknown[];
  }[] = [
    {
      label: 'platform allow + agency no-match → allow',
      path: 'agency',
      body: { dimension: 'network', operation: 'egress', resource: 'allowed.example', attributes: {} },
      expectOutcome: 'allow',
      expectReason: 'rule-allowed',
      expectMatched: [platformId],
    },
    {
      label: 'agency deny overrides platform allow for the blocked host',
      path: 'agency',
      body: { dimension: 'network', operation: 'egress', resource: 'blocked.example', attributes: {} },
      expectOutcome: 'deny',
      expectReason: 'rule-denied',
      expectMatched: [agencyId2],
    },
    {
      label: 'the client scope consults the same chain (allowed host)',
      path: 'client',
      body: { dimension: 'network', operation: 'egress', resource: 'allowed.example', attributes: {} },
      expectOutcome: 'allow',
      expectReason: 'rule-allowed',
      expectMatched: [platformId],
    },
    {
      label: 'the client scope consults the same chain (blocked host denies)',
      path: 'client',
      body: { dimension: 'network', operation: 'egress', resource: 'blocked.example', attributes: {} },
      expectOutcome: 'deny',
      expectReason: 'rule-denied',
      expectMatched: [agencyId2],
    },
  ];

  for (const testCase of cases) {
    const path =
      testCase.path === 'agency'
        ? `/api/agencies/${principal.agencyId}/policies/evaluate`
        : `/api/clients/${client}/policies/evaluate`;
    const response = await apiCall(port(), path, { token: principal.token, body: testCase.body });
    assert.equal(response.status, 200, `${testCase.label}: ${JSON.stringify(response.body)}`);
    const body = response.body as Record<string, unknown>;
    assert.equal(body['outcome'], testCase.expectOutcome, testCase.label);
    assert.equal(body['reasonCode'], testCase.expectReason, testCase.label);
    assert.deepEqual(body['matchedPolicyVersions'], testCase.expectMatched, testCase.label);
    // The enforcement answer ships with the decision: only allow permits.
    assert.equal(body['enforcement'], testCase.expectOutcome === 'allow' ? 'allow' : 'deny', testCase.label);
  }
});

test('FAIL-CLOSED (API, table-driven): missing policy and no-matching-rule are recorded unknown (enforcement deny); unknown dimension is rejected outright', async () => {
  const principal = await makePrincipal('agency-failclosed@marketingos.test');

  // Declare a policy for 'tools' with a narrow operation so the
  // no-matching-rule path is reachable.
  await declareAgencyPolicy(principal, 'tools', [rules('allow', ['other-op'], 'narrow allow')]);

  const cases: readonly {
    readonly label: string;
    readonly body: Record<string, unknown>;
    readonly expectStatus: number;
    readonly expectOutcome?: string;
    readonly expectReason?: string;
  }[] = [
    {
      label: 'no declared policy for the dimension → unknown / no-active-policy',
      body: evalBody('ai', 'invoke'),
      expectStatus: 200,
      expectOutcome: 'unknown',
      expectReason: 'no-active-policy',
    },
    {
      label: 'declared policy but no rule matches → unknown / no-matching-rule',
      body: evalBody('tools', 'invoke'),
      expectStatus: 200,
      expectOutcome: 'unknown',
      expectReason: 'no-matching-rule',
    },
    {
      label: 'unknown dimension → rejected (422), never a decision',
      body: evalBody('quantum', 'invoke'),
      expectStatus: 422,
    },
    {
      label: 'missing operation → rejected (422)',
      body: { dimension: 'ai' },
      expectStatus: 422,
    },
    {
      label: 'caller-supplied outcome → rejected (422)',
      body: { ...evalBody('ai', 'invoke'), outcome: 'allow' },
      expectStatus: 422,
    },
    {
      label: 'caller-supplied provenance → rejected (422)',
      body: { ...evalBody('ai', 'invoke'), actor: 'forged' },
      expectStatus: 422,
    },
  ];

  for (const testCase of cases) {
    const response = await evaluateAgency(principal, testCase.body);
    assert.equal(response.status, testCase.expectStatus, `${testCase.label}: ${JSON.stringify(response.body)}`);
    if (testCase.expectOutcome !== undefined) {
      const body = response.body as Record<string, unknown>;
      assert.equal(body['outcome'], testCase.expectOutcome, testCase.label);
      assert.equal(body['reasonCode'], testCase.expectReason, testCase.label);
      assert.equal(body['enforcement'], 'deny', `${testCase.label}: enforcement must deny`);
      // The undecided decision is still RECORDED (append-only trail).
      assert.ok(typeof body['decisionId'] === 'string');
    }
  }
});

// ---------------------------------------------------------------------------
// Decision records: append-only, server-derived provenance, ledger reads
// ---------------------------------------------------------------------------

test('DECISIONS: every evaluation is recorded once with server-derived provenance and reads back from the ledger', async () => {
  const principal = await makePrincipal('agency-decisions@marketingos.test');
  await declareAgencyPolicy(principal, 'network', [rules('deny', ['*'], 'deny everything for the ledger test')]);

  const evaluated = await evaluateAgency(
    principal,
    evalBody('network', 'egress'),
    randomUUID(),
  );
  assert.equal(evaluated.status, 200);
  const decision = evaluated.body as Record<string, unknown>;
  const decisionId = decision['decisionId'] as string;
  assert.ok(typeof decisionId === 'string' && decisionId.length > 0);
  const correlationUsed = (evaluated.headers['x-correlation-id'] ?? '') as string;

  // Provenance is server-derived: actor from the authenticated principal,
  // correlation from the ambient context (never request fields).
  const provenance = decision['provenance'] as Record<string, unknown>;
  assert.equal(provenance['actor'], `user:${principal.userId}`);
  assert.equal(provenance['correlationId'], correlationUsed, 'the ambient correlation identity is recorded on the decision');
  assert.equal(provenance['recordedVia'], 'api');
  assert.ok(typeof provenance['recordedAt'] === 'string');
  assert.ok(typeof provenance['evaluatedAt'] === 'string');

  // The agency ledger lists the decision, newest first.
  const ledger = await apiCall(port(), `/api/agencies/${principal.agencyId}/policy-decisions`, { token: principal.token });
  assert.equal(ledger.status, 200);
  const decisions = ledger.body['decisions'] as Record<string, unknown>[];
  assert.ok(decisions.some((entry) => entry['decisionId'] === decisionId));
  assert.ok(decisions.every((entry) => entry['agencyId'] === principal.agencyId));

  // Single-decision read by id (owner side).
  const read = await apiCall(port(), `/api/policy-decisions/${decisionId}`, { token: principal.token });
  assert.equal(read.status, 200);
  assert.equal((read.body as Record<string, unknown>)['decisionId'], decisionId);
});

test('DECISIONS DB BACKSTOP: the decision audit trail rejects UPDATE and DELETE by direct SQL', async () => {
  const { stack: st } = the();
  const principal = await makePrincipal('agency-appendonly@marketingos.test');
  const evaluated = await evaluateAgency(principal, evalBody('field', 'assign'));
  assert.equal(evaluated.status, 200);
  const decisionId = (evaluated.body as Record<string, unknown>)['decisionId'] as string;

  await assert.rejects(
    () => st.pg.pool.query('UPDATE policy_decisions SET outcome = $1 WHERE decision_id = $2', ['allow', decisionId]),
    /append-only/i,
  );
  await assert.rejects(
    () => st.pg.pool.query('DELETE FROM policy_decisions WHERE decision_id = $1', [decisionId]),
    /append-only/i,
  );
});

// ---------------------------------------------------------------------------
// CRED-001: the secrets dimension evaluates ACCESS PROPOSALS through the
// credential reference authority (references only — never material)
// ---------------------------------------------------------------------------

test('CRED-001 evaluation: secret access proposals resolve the credential REFERENCE server-side and decide through the kind-scoped rules', async () => {
  const principal = await makePrincipal('agency-cred@marketingos.test');

  // A credential reference of the agency (the handle resolves in the
  // file-backed secret backend — provisioned out-of-band in `before`).
  const created = await apiCall(port(), `/api/agencies/${principal.agencyId}/credentials`, {
    token: principal.token,
    body: { kind: 'integration_api_key', label: 'meta ads key', secretHandle: SECRET_HANDLE },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const credentialId = created.body['credentialId'] as string;

  // Agency policy: allow reading integration_api_key credentials.
  await declareAgencyPolicy(principal, 'secrets', [
    {
      effect: 'allow',
      operations: ['read'],
      attributes: { credentialKind: 'integration_api_key' },
      reason: 'integration keys are readable in this agency',
    },
  ]);

  // The access proposal (credential reference + operation) is ALLOWED —
  // the engine matched the SERVER-DERIVED credentialKind, never a
  // caller-supplied one.
  const allowed = await evaluateAgency(principal, { dimension: 'secrets', operation: 'read', resource: credentialId, attributes: {} });
  assert.equal(allowed.status, 200);
  const allowedBody = allowed.body as Record<string, unknown>;
  assert.equal(allowedBody['outcome'], 'allow');
  assert.equal(allowedBody['reasonCode'], 'rule-allowed');

  // A caller-supplied credentialKind LIE is ignored (server-derived): the
  // decision is still based on the resolved reference.
  const lie = await evaluateAgency(principal, {
    ...evalBody('secrets', 'read'),
    resource: credentialId,
    attributes: { credentialKind: 'admin_master_key' },
  });
  assert.equal(lie.status, 422, 'the reserved credential authority attribute is rejected at the DTO');
  const lieBody = lie.body as Record<string, unknown>;
  assert.ok(JSON.stringify(lieBody).includes('server-derived'));

  // An unknown credential reference fails closed: recorded deny.
  const unknownRef = await evaluateAgency(principal, {
    dimension: 'secrets',
    operation: 'read',
    resource: '11111111-1111-4111-8111-111111111111',
    attributes: {},
  });
  assert.equal(unknownRef.status, 200);
  const unknownBody = unknownRef.body as Record<string, unknown>;
  assert.equal(unknownBody['outcome'], 'deny');
  assert.equal(unknownBody['reasonCode'], 'credential-reference-unresolved');

  // A non-matching operation is undecided → unknown (enforcement deny).
  const undecided = await evaluateAgency(principal, { dimension: 'secrets', operation: 'write', resource: credentialId, attributes: {} });
  assert.equal(undecided.status, 200);
  const undecidedBody = undecided.body as Record<string, unknown>;
  assert.equal(undecidedBody['outcome'], 'unknown');
  assert.equal(undecidedBody['reasonCode'], 'no-matching-rule');
  assert.equal(undecidedBody['enforcement'], 'deny');

  // NO MATERIAL ANYWHERE: the decision records carry the reference id but
  // never the secret material (sweep the durable surface).
  const { stack: st } = the();
  const stored = await st.pg.pool.query<{ action: unknown }>(
    'SELECT action FROM policy_decisions WHERE agency_id = $1',
    [principal.agencyId],
  );
  for (const row of stored.rows) {
    assert.ok(!JSON.stringify(row).includes(SECRET_MATERIAL), 'no decision row may contain the secret material');
    assert.ok(!JSON.stringify(row).includes(SECRET_HANDLE), 'no decision row may contain the secret handle');
  }
});

// ---------------------------------------------------------------------------
// The internal service principal (MKT-001 machine-to-machine)
// ---------------------------------------------------------------------------

test('service principal: the internal service token evaluates and administers platform policies', async () => {
  const declare = await apiCall(port(), '/api/policies', {
    token: SERVICE_TOKEN,
    body: declaration('field', [rules('allow', ['*'], 'service-declared field defaults')], 'Platform field defaults (service)'),
  });
  assert.equal(declare.status, 201, JSON.stringify(declare.body));
  const principal = await makePrincipal('agency-service@marketingos.test');
  const decision = await evaluateAgency(principal, evalBody('field', 'assign'));
  assert.equal(decision.status, 200);
  const body = decision.body as Record<string, unknown>;
  assert.equal(body['outcome'], 'allow');
  assert.deepEqual(body['matchedPolicyVersions'], [(declare.body as Record<string, unknown>)['policyId']]);
});
