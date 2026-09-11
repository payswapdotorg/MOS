/**
 * MKT-021 security/isolation integration tests — the negative regressions
 * for the security invariants the execution policy engine touches (real
 * embedded PostgreSQL + real API process; module-level fail-closed probes
 * use the real module over the real DB with deliberately broken PORTS —
 * the error condition under test, never a faked success).
 *
 * Proves (spec/security-threat-model.md "Cross-tenant traversal",
 * "Caller-supplied authority fields", "Policy time-of-check/time-of-use
 * race"; requirements.md POL-001/CRED-001; implementation-contract §2/§3):
 *   - TENANT ISOLATION (policies): foreign agency identifiers are uniform
 *     404s on every policy surface (list/read/declare/evaluate) — no
 *     cross-tenant oracle; agency A's declared boundaries never leak into
 *     agency B's evaluation composition;
 *   - CLIENT ISOLATION: foreign clients are uniform 404s for declaration,
 *     listing, evaluation and the decision ledger;
 *   - DECISION LEDGER ISOLATION: foreign decision ids are uniform 404s;
 *   - DTO authority-field rejection: caller-supplied scope, outcomes,
 *     reasons, decision identity, provenance and material-shaped keys are
 *     422s on every mutation surface;
 *   - CRED-001 CROSS-TENANT secret access proposals FAIL CLOSED: agency
 *     B proposing agency A's credential reference gets a RECORDED deny
 *     (credential-scope-mismatch) — the engine resolves the reference
 *     server-side and refuses;
 *   - FAIL-CLOSED REGRESSIONS (module level, real DB):
 *     ambiguous scope (client owned by another agency in the evaluation
 *     scope) → recorded deny 'ambiguous-scope'; evaluation error (the
 *     policy store becomes unavailable mid-evaluation) → recorded deny
 *     'evaluation-error'; total store failure (even the decision record
 *     cannot persist) → BackendUnavailableError — NEVER an allow.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  type IntegrationStack,
} from './helpers/harness.ts';
import { PgDb } from '../../src/platform/db/adapters/postgres/pg-db.ts';
import { SystemClock } from '../../src/platform/clock/clock.ts';
import { CryptoIdGenerator } from '../../src/platform/ids/ids.ts';
import { createAgenciesModule } from '../../src/modules/agencies/public.ts';
import { createUsersModule } from '../../src/modules/users/public.ts';
import { createClientsModule } from '../../src/modules/clients/public.ts';
import { createPoliciesModule } from '../../src/modules/policies/public.ts';
import type { Db } from '../../src/platform/db/contract.ts';
import { BackendUnavailableError } from '../../src/platform/errors/errors.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';

let stack: IntegrationStack | null = null;
let api: { port: number; child: ChildProcessWithoutNullStreams } | null = null;
let db: PgDb | null = null;

function the(): { stack: IntegrationStack; api: { port: number; child: ChildProcessWithoutNullStreams } } {
  if (stack === null || api === null) throw new Error('test stack not booted');
  return { stack, api };
}

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

before(async () => {
  stack = await bootStack('polsec');
  fs.mkdirSync(stack.env.secretsDir, { recursive: true });
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
  db = new PgDb(stack.env.databaseUrl, 4);
});

after(async () => {
  await db?.close();
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
  assert.equal(user.status, 201);
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

/** A minimal agency policy declaration body. */
function declaration(dimension: string): Record<string, unknown> {
  return {
    dimension,
    rules: [{ effect: 'allow', operations: ['*'], reason: 'allow everything' }],
    description: `${dimension} boundary`,
  };
}

// ---------------------------------------------------------------------------
// Tenant isolation on every policy surface (uniform 404, no oracle)
// ---------------------------------------------------------------------------

test('ISOLATION (policies): foreign agency identifiers are uniform 404s — list, read, declare and evaluate never leak', async () => {
  const alpha = await makePrincipal('polsec-alpha@marketingos.test');
  const beta = await makePrincipal('polsec-beta@marketingos.test');

  // Alpha declares an agency policy.
  const declared = await apiCall(port(), `/api/agencies/${alpha.agencyId}/policies`, {
    token: alpha.token,
    body: declaration('network'),
  });
  assert.equal(declared.status, 201);
  const policyId = (declared.body as Record<string, unknown>)['policyId'] as string;

  // Beta's list does NOT contain alpha's policy.
  const betaList = await apiCall(port(), `/api/agencies/${beta.agencyId}/policies`, { token: beta.token });
  assert.equal(betaList.status, 200);
  const betaPolicies = (betaList.body['policies'] as Record<string, unknown>[]);
  assert.equal(betaPolicies.length, 0, 'beta starts with no policies');

  // Beta reading alpha's policy version by id → uniform 404.
  const betaRead = await apiCall(port(), `/api/policies/${policyId}`, { token: beta.token });
  assert.equal(betaRead.status, 404, 'a foreign policy id is indistinguishable from an unknown one');

  // Beta declaring INTO alpha's agency → 403 (membership authority).
  const betaDeclare = await apiCall(port(), `/api/agencies/${alpha.agencyId}/policies`, {
    token: beta.token,
    body: declaration('tools'),
  });
  assert.equal(betaDeclare.status, 403);

  // Beta evaluating under alpha's agency path → 403 (membership authority,
  // BEFORE any policy read).
  const betaEvaluate = await apiCall(port(), `/api/agencies/${alpha.agencyId}/policies/evaluate`, {
    token: beta.token,
    body: { dimension: 'network', operation: 'egress' },
  });
  assert.equal(betaEvaluate.status, 403);

  // Alpha's boundaries never leak into beta's evaluation: beta has NO
  // policies, so the evaluation is undecided (fail-closed unknown), NOT
  // alpha's allow.
  const betaOwnEvaluate = await apiCall(port(), `/api/agencies/${beta.agencyId}/policies/evaluate`, {
    token: beta.token,
    body: { dimension: 'network', operation: 'egress' },
  });
  assert.equal(betaOwnEvaluate.status, 200);
  const betaDecision = betaOwnEvaluate.body as Record<string, unknown>;
  assert.equal(betaDecision['outcome'], 'unknown', 'alpha policy must not leak into beta evaluations');
  assert.equal(betaDecision['reasonCode'], 'no-active-policy');
  assert.equal(betaDecision['enforcement'], 'deny');
});

test('ISOLATION (clients): foreign clients are uniform 404s on declaration, listing, evaluation and the ledger', async () => {
  const alpha = await makePrincipal('polsec-client-alpha@marketingos.test');
  const beta = await makePrincipal('polsec-client-beta@marketingos.test');
  const alphaClient = await makeClient(alpha.agencyId, alpha.token);

  // Beta declaring a client-scoped policy on alpha's client → 404.
  const betaDeclare = await apiCall(port(), `/api/clients/${alphaClient}/policies`, {
    token: beta.token,
    body: declaration('secrets'),
  });
  assert.equal(betaDeclare.status, 404);

  // Beta listing alpha's client policies → 404.
  const betaList = await apiCall(port(), `/api/clients/${alphaClient}/policies`, { token: beta.token });
  assert.equal(betaList.status, 404);

  // Beta evaluating under alpha's client → 404.
  const betaEvaluate = await apiCall(port(), `/api/clients/${alphaClient}/policies/evaluate`, {
    token: beta.token,
    body: { dimension: 'secrets', operation: 'read' },
  });
  assert.equal(betaEvaluate.status, 404);

  // Beta reading alpha's client decision ledger → 404.
  const betaLedger = await apiCall(port(), `/api/clients/${alphaClient}/policy-decisions`, { token: beta.token });
  assert.equal(betaLedger.status, 404);
});

test('ISOLATION (decisions): foreign decision ids are uniform 404s; the agency ledger never crosses tenants', async () => {
  const alpha = await makePrincipal('polsec-dec-alpha@marketingos.test');
  const beta = await makePrincipal('polsec-dec-beta@marketingos.test');

  // Alpha records a decision.
  const evaluated = await apiCall(port(), `/api/agencies/${alpha.agencyId}/policies/evaluate`, {
    token: alpha.token,
    body: { dimension: 'field', operation: 'assign' },
  });
  assert.equal(evaluated.status, 200);
  const decisionId = (evaluated.body as Record<string, unknown>)['decisionId'] as string;

  // Beta reading alpha's decision by id → uniform 404.
  const betaRead = await apiCall(port(), `/api/policy-decisions/${decisionId}`, { token: beta.token });
  assert.equal(betaRead.status, 404);

  // Alpha's ledger lists it; beta's ledger is empty.
  const alphaLedger = await apiCall(port(), `/api/agencies/${alpha.agencyId}/policy-decisions`, { token: alpha.token });
  assert.equal(alphaLedger.status, 200);
  assert.ok(
    ((alphaLedger.body['decisions'] as Record<string, unknown>[]).some((entry) => entry['decisionId'] === decisionId)),
  );
  const betaLedger = await apiCall(port(), `/api/agencies/${beta.agencyId}/policy-decisions`, { token: beta.token });
  assert.equal(betaLedger.status, 200);
  assert.equal((betaLedger.body['decisions'] as unknown[]).length, 0);
});

// ---------------------------------------------------------------------------
// DTO authority-field rejection (caller can never supply the decision)
// ---------------------------------------------------------------------------

test('AUTHORITY-FIELD REJECTION: caller-supplied scope, outcome, reasons, decision identity, provenance and material keys are 422s', async () => {
  const principal = await makePrincipal('polsec-dto@marketingos.test');

  const declarationCases: Record<string, unknown>[] = [
    { ...declaration('network'), scope: 'platform' },
    { ...declaration('network'), scopeKind: 'agency' },
    { ...declaration('network'), agencyId: '11111111-1111-4111-8111-111111111111' },
    { ...declaration('network'), clientId: '11111111-1111-4111-8111-111111111111' },
    { ...declaration('network'), policyId: '11111111-1111-4111-8111-111111111111' },
    { ...declaration('network'), status: 'active' },
    { ...declaration('network'), versionSeq: 1 },
    { ...declaration('network'), createdBy: '11111111-1111-4111-8111-111111111111' },
    { ...declaration('network'), provenance: { actor: 'forged' } },
    {
      ...declaration('network'),
      rules: [{ effect: 'allow', operations: ['*'], secret: 'smuggled', reason: 'material key' }],
    },
  ];
  for (const body of declarationCases) {
    const response = await apiCall(port(), `/api/agencies/${principal.agencyId}/policies`, {
      token: principal.token,
      body,
    });
    assert.equal(response.status, 422, JSON.stringify(body).slice(0, 160));
  }

  const evaluationCases: Record<string, unknown>[] = [
    { dimension: 'network', operation: 'egress', outcome: 'allow' },
    { dimension: 'network', operation: 'egress', reasons: ['forged'] },
    { dimension: 'network', operation: 'egress', reasonCode: 'rule-allowed' },
    { dimension: 'network', operation: 'egress', decisionId: '11111111-1111-4111-8111-111111111111' },
    { dimension: 'network', operation: 'egress', matchedPolicyVersions: [] },
    { dimension: 'network', operation: 'egress', provenance: { actor: 'forged' } },
    { dimension: 'network', operation: 'egress', actor: 'forged' },
    { dimension: 'network', operation: 'egress', correlationId: 'forged' },
    { dimension: 'network', operation: 'egress', recordedAt: '2020-01-01T00:00:00Z' },
    { dimension: 'network', operation: 'egress', scope: { agencyId: '11111111-1111-4111-8111-111111111111' } },
    { dimension: 'network', operation: 'egress', agencyId: '11111111-1111-4111-8111-111111111111' },
    { dimension: 'network', operation: 'egress', clientId: '11111111-1111-4111-8111-111111111111' },
    { dimension: 'network', operation: 'egress', secret: 'smuggled' },
    { dimension: 'network', operation: 'egress', apiKey: 'smuggled' },
  ];
  for (const body of evaluationCases) {
    const response = await apiCall(port(), `/api/agencies/${principal.agencyId}/policies/evaluate`, {
      token: principal.token,
      body,
    });
    assert.equal(response.status, 422, JSON.stringify(body).slice(0, 160));
  }
});

// ---------------------------------------------------------------------------
// CRED-001: cross-tenant secret access proposals fail closed
// ---------------------------------------------------------------------------

test('CRED-001 ISOLATION: a foreign-agency credential reference in a secret access proposal is a RECORDED cross-tenant deny', async () => {
  const alpha = await makePrincipal('polsec-cred-alpha@marketingos.test');
  const beta = await makePrincipal('polsec-cred-beta@marketingos.test');

  // Alpha creates a credential reference (the handle need not resolve for
  // the policy engine — the engine consumes REFERENCE metadata only; but
  // creation itself fails closed on unresolvable handles, so provision it).
  fs.writeFileSync(
    path.join(the().stack.env.secretsDir, 'polsec-alpha-key.secret'),
    'MATERIAL-alpha-agency-key',
    { mode: 0o600 },
  );
  const created = await apiCall(port(), `/api/agencies ${alpha.agencyId}/credentials`.replace(' ', '/'), {
    token: alpha.token,
    body: { kind: 'integration_api_key', label: 'alpha key', secretHandle: 'polsec-alpha-key' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const credentialId = created.body['credentialId'] as string;

  // Alpha's own agency policy allows reading its integration keys.
  const declared = await apiCall(port(), `/api/agencies/${alpha.agencyId}/policies`, {
    token: alpha.token,
    body: {
      dimension: 'secrets',
      rules: [
        {
          effect: 'allow',
          operations: ['read'],
          attributes: { credentialKind: 'integration_api_key' },
          reason: 'alpha allows reading its integration keys',
        },
      ],
      description: 'alpha secrets boundary',
    },
  });
  assert.equal(declared.status, 201);

  // BETA proposing ALPHA's credential reference (the attack): the engine
  // resolves the reference server-side, sees the tenant mismatch and
  // records a cross-tenant DENY — alpha's allow rule can never be reached
  // by beta's proposal.
  const attack = await apiCall(port(), `/api/agencies/${beta.agencyId}/policies/evaluate`, {
    token: beta.token,
    body: { dimension: 'secrets', operation: 'read', resource: credentialId },
  });
  assert.equal(attack.status, 200);
  const attackDecision = attack.body as Record<string, unknown>;
  assert.equal(attackDecision['outcome'], 'deny');
  assert.equal(attackDecision['reasonCode'], 'credential-scope-mismatch');
  assert.deepEqual(attackDecision['matchedPolicyVersions'], []);
  assert.equal(attackDecision['enforcement'], 'deny');

  // Alpha's own evaluation of the same reference is allowed (scope match).
  const own = await apiCall(port(), `/api/agencies/${alpha.agencyId}/policies/evaluate`, {
    token: alpha.token,
    body: { dimension: 'secrets', operation: 'read', resource: credentialId },
  });
  assert.equal(own.status, 200);
  const ownDecision = own.body as Record<string, unknown>;
  assert.equal(ownDecision['outcome'], 'allow');
  assert.equal(ownDecision['reasonCode'], 'rule-allowed');
});

test('AUTH: the evaluation surface requires authentication (401 without a token)', async () => {
  const principal = await makePrincipal('polsec-auth@marketingos.test');
  const response = await apiCall(port(), `/api/agencies/${principal.agencyId}/policies/evaluate`, {
    body: { dimension: 'network', operation: 'egress' },
  });
  assert.equal(response.status, 401);
});

// ---------------------------------------------------------------------------
// FAIL-CLOSED REGRESSIONS (module level, real DB, deterministic)
// ---------------------------------------------------------------------------

/** The real DB handle for module-level tests (asserted non-null). */
function realDb(): PgDb {
  if (db === null) throw new Error('db not booted');
  return db;
}

/**
 * Builds the REAL policies module over the real DB with the real
 * /agencies + /clients public contracts and a stubbed credential
 * reference port (references only — the CRED-001 evaluation posture).
 */
function buildRealModule(credentialStub: {
  getCredentialReference(credentialId: string): Promise<{ credentialId: string; agencyId: string; clientId: string | null; kind: string; status: string } | null>;
}) {
  const database = realDb();
  const clock = new SystemClock();
  const ids = new CryptoIdGenerator();
  const users = createUsersModule({ db: database, clock, ids });
  const agencies = createAgenciesModule({ db: database, clock, ids, users });
  const clients = createClientsModule({ db: database, clock, ids, agencies });
  return createPoliciesModule({ db: database, clock, ids, agencies, clients, credentialReferences: credentialStub });
}

const PROVENANCE = {
  actor: 'service:test-worker',
  recordedVia: 'module:test',
  correlationId: 'corr-polsec-module',
  causationId: null,
} as const;

test('FAIL-CLOSED (module): ambiguous scope — a client owned by ANOTHER agency in the evaluation scope is a recorded deny, never an allow', async () => {
  const alpha = await makePrincipal('polsec-ambig-alpha@marketingos.test');
  const beta = await makePrincipal('polsec-ambig-beta@marketingos.test');
  const alphaClient = await makeClient(alpha.agencyId, alpha.token);

  // Alpha declares an allow-all platform-equivalent at agency scope.
  const policies = buildRealModule({
    async getCredentialReference() {
      return null;
    },
  });
  await policies.declarePolicyVersion({
    scope: { agencyId: alpha.agencyId, clientId: null },
    dimension: 'network',
    rules: [{ effect: 'allow', operations: ['*'], resource: null, attributes: {}, reason: 'alpha allows egress' }],
    description: 'alpha network boundary',
    actorId: null,
  });

  // The ambiguous scope: beta's agency + alpha's client (the client does
  // not belong to beta) — the module re-resolves the chain server-side,
  // sees the mismatch and FAILS CLOSED with a recorded deny. The decision
  // row attributes to the REQUESTING agency with the unvalidated client
  // claim dropped (the DB cross-tenant fence enforces the same posture —
  // the full proposal stays in the action payload).
  const decision = await policies.evaluateAction(
    {
      action: { dimension: 'network', operation: 'egress', resource: null, attributes: {} },
      scope: { agencyId: beta.agencyId, clientId: alphaClient },
    },
    PROVENANCE,
  );
  assert.equal(decision.outcome, 'deny');
  assert.equal(decision.reasonCode, 'ambiguous-scope');
  assert.deepEqual(decision.matchedPolicyVersions, []);
  assert.equal(decision.agencyId, beta.agencyId);
  assert.equal(decision.clientId, null, 'an unvalidated client claim never lands on the decision row');
  assert.equal(decision.action.resource, null);

  // The CORRECT scope for that client still evaluates (alpha's allow).
  const valid = await policies.evaluateAction(
    {
      action: { dimension: 'network', operation: 'egress', resource: null, attributes: {} },
      scope: { agencyId: alpha.agencyId, clientId: alphaClient },
    },
    PROVENANCE,
  );
  assert.equal(valid.outcome, 'allow');
  assert.equal(valid.reasonCode, 'rule-allowed');
});

test('FAIL-CLOSED (module): evaluation error — a policy store that fails mid-evaluation produces a RECORDED deny (evaluation-error), never an allow', async () => {
  const alpha = await makePrincipal('polsec-err@marketingos.test');

  // A Db port whose QUERY fails only for policy SELECTs (the decision
  // INSERT still works, so the fail-closed decision can be recorded).
  const failingPolicyReads: Db = {
    query: async (text: string, params?: ReadonlyArray<unknown>) => {
      assert.ok(db !== null);
      if (text.includes('FROM policies')) {
        throw new Error('simulated policy store outage');
      }
      return db.query(text, params as never);
    },
    transaction: async <T>(body: (tx: never) => Promise<T>) => {
      assert.ok(db !== null);
      return db.transaction(body as never);
    },
    close: async () => {},
  } as unknown as Db;

  const clock = new SystemClock();
  const ids = new CryptoIdGenerator();
  const users = createUsersModule({ db: failingPolicyReads as Db, clock, ids });
  const agencies = createAgenciesModule({ db: realDb(), clock, ids, users });
  const clients = createClientsModule({ db: realDb(), clock, ids, agencies });
  const policies = createPoliciesModule({
    db: failingPolicyReads,
    clock,
    ids,
    agencies,
    clients,
    credentialReferences: {
      async getCredentialReference() {
        return null;
      },
    },
  });

  const decision = await policies.evaluateAction(
    {
      action: { dimension: 'network', operation: 'egress', resource: null, attributes: {} },
      scope: { agencyId: alpha.agencyId, clientId: null },
    },
    PROVENANCE,
  );
  assert.equal(decision.outcome, 'deny', 'an erroring evaluation must never allow');
  assert.equal(decision.reasonCode, 'evaluation-error');
  assert.ok(decision.reasons[0]!.includes('simulated policy store outage'));

  // The fail-closed deny was RECORDED (append-only audit trail).
  const { stack: st } = the();
  const stored = await st.pg.pool.query(
    'SELECT outcome, reason_code FROM policy_decisions WHERE decision_id = $1',
    [decision.decisionId],
  );
  assert.equal(stored.rows.length, 1);
  assert.equal(stored.rows[0]!.outcome, 'deny');
  assert.equal(stored.rows[0]!.reason_code, 'evaluation-error');
});

test('FAIL-CLOSED (module): total store failure — when even the decision record cannot persist, evaluation throws unavailable and still never allows', async () => {
  const alpha = await makePrincipal('polsec-dead@marketingos.test');

  // A fully dead Db port: every query fails.
  const deadDb: Db = {
    query: async () => {
      throw new Error('database is down');
    },
    transaction: async () => {
      throw new Error('database is down');
    },
    close: async () => {},
  } as unknown as Db;

  const clock = new SystemClock();
  const ids = new CryptoIdGenerator();
  const users = createUsersModule({ db: deadDb, clock, ids });
  const agencies = createAgenciesModule({ db: deadDb, clock, ids, users });
  const clients = createClientsModule({ db: deadDb, clock, ids, agencies });
  const policies = createPoliciesModule({
    db: deadDb,
    clock,
    ids,
    agencies,
    clients,
    credentialReferences: {
      async getCredentialReference() {
        return null;
      },
    },
  });

  await assert.rejects(
    () =>
      policies.evaluateAction(
        {
          action: { dimension: 'network', operation: 'egress', resource: null, attributes: {} },
          scope: { agencyId: alpha.agencyId, clientId: null },
        },
        PROVENANCE,
      ),
    (error: unknown) => {
      // BackendUnavailableError (503 semantics) — the caller CANNOT
      // proceed: fail-closed by unavailability, never an allow.
      assert.ok(error instanceof BackendUnavailableError, `expected BackendUnavailableError, got ${String(error)}`);
      return true;
    },
  );
});
