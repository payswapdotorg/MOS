/**
 * MKT-056 — the SOCIAL PLATFORM ADAPTER CONFORMANCE SUITE (the reusable
 * contract-test battery any adapter runs against; the dispatch: "a
 * reusable contract-test battery any adapter runs against
 * (capability-subset enforcement, fail-closed unknown ops, error
 * taxonomy, publish idempotency, account identity/scope propagation)").
 *
 * The suite is an IMPERATIVE battery (node:assert inside; the caller
 * wraps the single awaited run in its test()). It boots its OWN
 * full-stack environment per invocation — embedded PostgreSQL, the
 * spawned production API (fixtures + policies) and the IN-PROCESS
 * application composed with the adapter under test supplied through the
 * DISCLOSED AppOptions seams (integrationAdapters +
 * socialAccountFlows + socialPlatformAdapters) — exactly the MKT-055
 * in-process precedent, so the CONTRACT HOST under test (the capability
 * gates, the scope pre-check, the /policies fail-closed gates, the
 * idempotency fence, the claim-then-fill ledger) is fully REAL for
 * every adapter that runs the suite.
 *
 * The MKT-057..061 platform deliveries run this suite with their
 * platform adapter + their platform double (the provider boundary is
 * the adapter's own concern); this delivery proves the suite executes
 * with the disclosed reference in-memory double
 * (tests/integration/helpers/reference-social-adapter.ts).
 *
 * REQUIREMENTS on the adapter under test (the conformance
 * preconditions, documented):
 *   - the adapter DECLARES the 'account' family (the identity-binding
 *     core every platform exposes) — the propagation + taxonomy
 *     batteries ride its two operations;
 *   - the adapter's capability requiredScopes are SATISFIED by the
 *     full-scope fixture grant ['account:read','content:read',
 *     'analytics:read','content:write'] (the read-only fixture grant
 *     ['account:read','content:read'] drives the insufficient-scope
 *     battery — the suite derives which families refuse from the
 *     adapter's own declarations);
 *   - the adapter's operations follow the port contract (failures as
 *     data, never thrown; contexts recorded are the host's — the suite
 *     hands the CALL-COUNTING surface in via the adapterHandle).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import type pg from 'pg';
import type {
  IntegrationAdapter,
  IntegrationAdapterCallContext,
  NormalizedMutationRequest,
  NormalizedReadRequest,
  NormalizedMutationResult,
  NormalizedReadResult,
  AdapterProbeResult,
  WebhookDeliveryInput,
  WebhookVerificationResult,
} from '../../../src/modules/integrations/public.ts';
import type { CredentialsModuleApi } from '../../../src/modules/credentials/public.ts';
import type { IntegrationsModuleApi } from '../../../src/modules/integrations/public.ts';
import type {
  SocialAccountsModuleApi,
  SocialCapabilityFamily,
  SocialPlatformAdapter,
} from '../../../src/modules/social-accounts/public.ts';
import { SOCIAL_CAPABILITY_FAMILIES } from '../../../src/modules/social-accounts/public.ts';
import { bootstrapApplication } from '../../../src/composition-root.ts';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  type IntegrationStack,
  type SpawnedProcess,
} from './harness.ts';
import { createLocalOAuthFlow, type LocalOAuthProvider } from './oauth-provider.ts';
import type { ReferenceSocialAdapter } from './reference-social-adapter.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';
const CRM_SECRET_HANDLE = 'social-conformance-pipe-key';

/** The full-scope fixture grant (satisfies every default reference capability). */
const FULL_SCOPES = ['account:read', 'content:read', 'analytics:read', 'content:write'] as const;
/** The read-only fixture grant (drives the insufficient-scope battery). */
const READ_ONLY_SCOPES = ['account:read', 'content:read'] as const;

export interface SocialAdapterConformanceInput {
  /** The adapter under test (registered under its own descriptor key). */
  readonly adapter: SocialPlatformAdapter;
  /**
   * The call-counting/observation handle of the adapter double. The
   * reference double implements it; a platform delivery's double exposes
   * the same minimal surface (callCount/contextsOf/setFailure/
   * clearFailure/advancePublish/publishesForIdempotencyKey).
   */
  readonly adapterHandle: ReferenceSocialAdapter;
  /** The OAuth flow double of the platform (the MKT-055 local provider). */
  readonly provider: LocalOAuthProvider;
  /** Unique label for the embedded database (parallel suite runs must not collide). */
  readonly label: string;
}

export interface SocialAdapterConformanceReport {
  readonly scenarios: readonly { readonly name: string; readonly ok: true }[];
  readonly failed: 0;
}

interface Principal {
  readonly userId: string;
  readonly token: string;
  readonly agencyId: string;
}

const PROVENANCE = {
  actor: 'user:00000000-0000-7000-8000-0000000000bb',
  recordedVia: 'test',
  correlationId: 'social-adapter-conformance',
  causationId: null,
} as const;

/**
 * The minimal /integrations stub pipe of the platform under test: a
 * probe-only adapter registered under the platform key so the
 * integration CONNECTION can exist (the social account attaches through
 * an EXISTING authorized integration — the platform's concrete
 * integration adapter arrives with its own Work Item).
 */
export function createReferenceIntegrationStub(adapterKey: string): IntegrationAdapter {
  return {
    descriptor: {
      adapterKey,
      providerLabel: `Reference pipe (${adapterKey})`,
      description: 'The disclosed conformance-suite stub integration pipe of the platform under test (probe-only).',
    },
    capabilities: [
      {
        capabilityKey: 'reference-pipe-probe',
        kind: 'read',
        operations: ['probe'],
        description: 'The probe-only capability of the conformance stub pipe.',
      },
    ],
    async probeConnection(_context: IntegrationAdapterCallContext): Promise<AdapterProbeResult> {
      return { reachable: true, healthy: true, message: null, rateLimit: null };
    },
    async read(_context: IntegrationAdapterCallContext, _request: NormalizedReadRequest): Promise<NormalizedReadResult> {
      return { ok: false, records: [], error: 'the conformance stub pipe performs no reads', rateLimit: null };
    },
    async mutate(
      _context: IntegrationAdapterCallContext,
      _request: NormalizedMutationRequest,
    ): Promise<NormalizedMutationResult> {
      return { ok: false, providerRecordId: null, data: null, error: 'the conformance stub pipe performs no mutations', rateLimit: null };
    },
    async verifyWebhook(
      _context: IntegrationAdapterCallContext,
      _delivery: WebhookDeliveryInput,
    ): Promise<WebhookVerificationResult> {
      return { verified: false, reason: 'the conformance stub pipe verifies no webhooks', normalizedEventType: null };
    },
  };
}

/**
 * Runs the full conformance battery against the adapter under test.
 * Throws (assert) on the FIRST failure — the caller's test surfaces it.
 */
export async function runSocialAdapterConformanceSuite(
  input: SocialAdapterConformanceInput,
): Promise<SocialAdapterConformanceReport> {
  const platformKey = input.adapter.descriptor.adapterKey;
  const scenarios: { name: string; ok: true }[] = [];
  const passed = (name: string): void => {
    scenarios.push({ name, ok: true });
  };

  let stack: IntegrationStack | null = null;
  let api: (SpawnedProcess & { port: number }) | null = null;
  let accounts: SocialAccountsModuleApi | null = null;
  let integrationsModule: IntegrationsModuleApi | null = null;
  let credentialsModule: CredentialsModuleApi | null = null;
  const module = (): SocialAccountsModuleApi => {
    if (accounts === null) throw new Error('application not bootstrapped');
    return accounts;
  };
  const integrationsApi = (): IntegrationsModuleApi => {
    if (integrationsModule === null) throw new Error('application not bootstrapped');
    return integrationsModule;
  };
  const credentialsApi = (): CredentialsModuleApi => {
    if (credentialsModule === null) throw new Error('application not bootstrapped');
    return credentialsModule;
  };
  const httpPort = (): number => {
    if (api === null) throw new Error('api not spawned');
    return api.port;
  };
  const pool = (): pg.Pool => {
    if (stack === null) throw new Error('test stack not booted');
    return stack.pg.pool;
  };

  try {
    // -----------------------------------------------------------------
    // Boot: embedded PostgreSQL + spawned API + in-process app with the
    // adapter under test through the DISCLOSED composition seams.
    // -----------------------------------------------------------------
    stack = await bootStack(`social_conf_${input.label}`);
    fs.writeFileSync(
      `${stack.env.secretsDir}/${CRM_SECRET_HANDLE}.secret`,
      JSON.stringify({ accessToken: 'conformance-pipe-bearer', webhookSecret: null }),
      { mode: 0o600 },
    );
    api = await spawnApi(stack.env, {
      MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
      MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
    });
    process.env.MOS_DATABASE_URL = stack.env.databaseUrl;
    process.env.MOS_INTERNAL_API_TOKEN = stack.env.internalApiToken;
    process.env.MOS_ENV = 'test';
    process.env.MOS_OBJECT_STORE = 'fs';
    process.env.MOS_OBJECT_STORE_DIR = stack.env.objectStoreDir;
    process.env.MOS_SECRETS_DIR = stack.env.secretsDir;
    const core = await bootstrapApplication({
      integrationAdapters: [createReferenceIntegrationStub(platformKey)],
      socialAccountFlows: [
        createLocalOAuthFlow(input.provider, { adapterKey: platformKey, secretsDir: stack.env.secretsDir }),
        // The CRM-keyed flow serves the unknown-platform battery (the
        // account binds through an EXISTING production integration pipe
        // whose platform has NO registered social adapter).
        createLocalOAuthFlow(input.provider, { adapterKey: 'crm', secretsDir: stack.env.secretsDir }),
      ],
      socialPlatformAdapters: [input.adapter],
    });
    accounts = core.modules.socialAccounts;
    integrationsModule = core.modules.integrations;
    credentialsModule = core.modules.credentials;
    const port = httpPort;

    // -----------------------------------------------------------------
    // Fixtures: two agencies (isolation), two clients, policies, two
    // platform connections, four accounts (full/read-only/death/expiry)
    // + one CRM-keyed account (the unknown-platform battery).
    // -----------------------------------------------------------------
    let adminTokenCache: string | null = null;
    const adminToken = async (): Promise<string> => {
      if (adminTokenCache !== null) return adminTokenCache;
      const login = await apiCall(port(), '/api/auth/login', {
        body: { email: BOOTSTRAP_EMAIL, password: BOOTSTRAP_PASSWORD },
      });
      assert.equal(login.status, 200);
      adminTokenCache = login.body['token'] as string;
      return adminTokenCache;
    };
    const makeUser = async (email: string): Promise<{ userId: string; token: string }> => {
      const admin = await adminToken();
      const create = await apiCall(port(), '/api/users', {
        token: admin,
        body: { email, displayName: email.split('@')[0]! },
      });
      assert.equal(create.status, 201, JSON.stringify(create.body));
      const userId = create.body['userId'] as string;
      await apiCall(port(), `/api/users/${userId}/credential`, { token: admin, body: { password: 'conf-pass-123' } });
      const login = await apiCall(port(), '/api/auth/login', { body: { email, password: 'conf-pass-123' } });
      assert.equal(login.status, 200);
      return { userId, token: login.body['token'] as string };
    };
    const makeAgencyOwner = async (email: string): Promise<Principal> => {
      const user = await makeUser(email);
      const admin = await adminToken();
      const agency = await apiCall(port(), '/api/agencies', {
        token: admin,
        body: { name: `Agency ${email}`, ownerUserId: user.userId },
      });
      assert.equal(agency.status, 201, JSON.stringify(agency.body));
      return {
        userId: user.userId,
        token: user.token,
        agencyId: (agency.body['agency'] as Record<string, unknown>)['agencyId'] as string,
      };
    };
    const makeClient = async (principal: Principal, name: string): Promise<string> => {
      const created = await apiCall(port(), `/api/agencies/${principal.agencyId}/clients`, {
        token: principal.token,
        body: { name },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      return created.body['clientId'] as string;
    };
    const allowAll = async (principal: Principal, dimension: 'network' | 'secrets'): Promise<void> => {
      const declared = await apiCall(port(), `/api/agencies/${principal.agencyId}/policies`, {
        token: principal.token,
        body: {
          dimension,
          rules: [{ effect: 'allow', operations: ['*'], reason: 'conformance allowance' }],
          description: `Conformance ${dimension} allowance`,
        },
      });
      assert.equal(declared.status, 201, JSON.stringify(declared.body));
    };
    let connectionSequence = 0;
    const makeConnection = async (principal: Principal, clientId: string, adapterKey: string): Promise<string> => {
      // The connection is created through the IN-PROCESS integrations
      // module (the spawned production API has no knowledge of the
      // platform stub — the AppOptions seam applies to the in-process
      // composition; both share the SAME database).
      connectionSequence += 1;
      const credential = await credentialsApi().createCredentialReference({
        agencyId: principal.agencyId,
        clientId,
        kind: 'integration_api_key',
        // NOTE: the credential-label grammar is letters/digits/spaces/dots/
        // underscores/slashes (NO dashes — the migration-005 pattern); the
        // platform key's dashes are slugified and the sequence suffix keeps
        // the (agency, label) fence happy (one credential per connection —
        // the frozen MKT-055 rule: ONE connection binds ONE platform
        // identity, so every account identity gets its OWN connection).
        label: `conformance_${adapterKey.replaceAll('-', '_')}_${clientId.slice(0, 8)}_${connectionSequence}`,
        secretHandle: CRM_SECRET_HANDLE,
        actorId: null,
      });
      const registered = await integrationsApi().registerConnection(
        {
          clientId,
          adapterKey,
          credentialReferenceId: credential.credentialId,
          providerConfig: { apiBaseUrl: input.provider.url, platformHint: adapterKey },
        },
        PROVENANCE,
      );
      const connected = await integrationsApi().connectConnection(
        { connectionId: registered.connectionId, expectedVersion: 1 },
        PROVENANCE,
      );
      assert.equal(connected.status, 'connected');
      return registered.connectionId;
    };
    /** The full OAuth handshake through the REAL module + the flow double. */
    const connectAccount = async (
      principal: Principal,
      clientId: string,
      connectionId: string,
      fixture: {
        readonly accountId: string;
        readonly scopes: readonly string[];
        readonly capabilityTags?: readonly string[];
        readonly expiresInMs?: number | null;
      },
    ): Promise<string> => {
      const start = await module().startAuthorization(
        { clientId, integrationConnectionId: connectionId, workspaceId: null, requestedScopes: [...fixture.scopes], expectedAccountId: null },
        PROVENANCE,
      );
      const issued = input.provider.issueAuthorization({
        accountId: fixture.accountId,
        displayIdentity: `conf:${fixture.accountId}`,
        verifiedAt: '2026-07-01T09:30:00.000Z',
        scopes: [...fixture.scopes],
        capabilityTags: fixture.capabilityTags ?? ['conformance-tag'],
        expiresInMs: fixture.expiresInMs === undefined ? 3_600_000 : fixture.expiresInMs,
      });
      const completion = await module().completeAuthorization(
        { clientId, state: start.grant.stateToken, code: issued.code },
        PROVENANCE,
      );
      return completion.account.socialAccountId;
    };

    const alice = await makeAgencyOwner('alice@conformance.test');
    const bob = await makeAgencyOwner('bob@conformance.test');
    const aliceClientId = await makeClient(alice, 'Conformance Client A');
    const bobClientId = await makeClient(bob, 'Conformance Client B');
    await allowAll(alice, 'network');
    await allowAll(alice, 'secrets');
    await allowAll(bob, 'network');
    await allowAll(bob, 'secrets');

    const alicePlatformConnectionA = await makeConnection(alice, aliceClientId, platformKey);
    const alicePlatformConnectionB = await makeConnection(alice, aliceClientId, platformKey);
    const alicePlatformConnectionC = await makeConnection(alice, aliceClientId, platformKey);
    const alicePlatformConnectionE = await makeConnection(alice, aliceClientId, platformKey);
    const aliceCrmConnection = await makeConnection(alice, aliceClientId, 'crm');
    const bobPlatformConnection = await makeConnection(bob, bobClientId, platformKey);

    // Account A: full scopes (the golden-path account).
    const accountA = await connectAccount(alice, aliceClientId, alicePlatformConnectionA, {
      accountId: `conf-a-${input.label}`,
      scopes: FULL_SCOPES,
      capabilityTags: ['conformance-tag', 'second.tag:v2'],
    });
    // Account B: read-only scopes (the insufficient-scope battery).
    const accountB = await connectAccount(alice, aliceClientId, alicePlatformConnectionB, {
      accountId: `conf-b-${input.label}`,
      scopes: READ_ONLY_SCOPES,
    });
    // Account C: the death battery (disconnected).
    const accountC = await connectAccount(alice, aliceClientId, alicePlatformConnectionC, {
      accountId: `conf-c-${input.label}`,
      scopes: FULL_SCOPES,
    });
    // Account E: the lazy-expiry battery (expired grant).
    const accountE = await connectAccount(alice, aliceClientId, alicePlatformConnectionE, {
      accountId: `conf-e-${input.label}`,
      scopes: FULL_SCOPES,
      expiresInMs: -60_000,
    });
    // Account F: the CRM-keyed platform (no registered social adapter).
    const accountF = await connectAccount(alice, aliceClientId, aliceCrmConnection, {
      accountId: `conf-f-${input.label}`,
      scopes: FULL_SCOPES,
    });
    // Bob's account (the cross-client isolation battery).
    const accountD = await connectAccount(bob, bobClientId, bobPlatformConnection, {
      accountId: `conf-d-${input.label}`,
      scopes: FULL_SCOPES,
    });

    const declaredFamilies = new Set<SocialCapabilityFamily>(
      input.adapter.capabilities.map((capability) => capability.family),
    );
    const publishDeclared = declaredFamilies.has('publish');
    const statusDeclared =
      publishDeclared &&
      (input.adapter.capabilities.find((c) => c.family === 'publish')?.operations.includes('getPublishStatus') ?? false);
    const satisfiedByReadOnly = (family: SocialCapabilityFamily): boolean => {
      const capability = input.adapter.capabilities.find((c) => c.family === family);
      if (capability === undefined) return false;
      return capability.requiredScopes.every((scope) => (READ_ONLY_SCOPES as readonly string[]).includes(scope));
    };

    // -----------------------------------------------------------------
    // Scenario 1 — registry data + the capability matrix view.
    // -----------------------------------------------------------------
    {
      const registered = module().listRegisteredSocialAdapters();
      const own = registered.find((info) => info.descriptor.adapterKey === platformKey);
      assert.ok(own !== undefined, 'the adapter under test is registered');
      assert.deepEqual(
        own.capabilities.map((c) => c.family).sort(),
        [...declaredFamilies].sort(),
        'the registry exposes the declared capability subset',
      );
      const view = await module().resolveAccountCapabilityMatrix(accountA);
      assert.ok(view !== null);
      assert.equal(view.registered, true);
      assert.equal(view.authorizationUsable, true);
      assert.deepEqual(
        view.capabilities.map((c) => c.family).sort(),
        [...declaredFamilies].sort(),
        'the account view carries the platform subset',
      );
      assert.ok(view.scopeSatisfaction.every((s) => s.satisfied), 'the full-scope grant satisfies every declared capability');
      passed('registry-data + capability matrix view');
    }

    // -----------------------------------------------------------------
    // Scenario 2 — account identity/scope propagation (VERBATIM).
    // -----------------------------------------------------------------
    {
      const identity = await module().verifyAccountIdentity(accountA, PROVENANCE);
      assert.equal(identity.ok, true, JSON.stringify(identity));
      assert.equal(identity.identity.externalAccountId, `conf-a-${input.label}`);
      const profile = await module().readAccountProfile(accountA, PROVENANCE);
      assert.equal(profile.ok, true, JSON.stringify(profile));
      const contexts = input.adapterHandle.contextsOf('verifyAccountIdentity');
      assert.ok(contexts.length >= 1, 'the adapter received the call context');
      const context = contexts[0]!;
      assert.equal(context.socialAccountId, accountA);
      assert.equal(context.platformId, platformKey);
      assert.equal(context.externalAccountId, `conf-a-${input.label}`);
      assert.equal(context.agencyId, alice.agencyId);
      assert.equal(context.clientId, aliceClientId);
      assert.equal(context.workspaceId, null);
      // The VERBATIM grant scope list + the recorded capability tags
      // (the MKT-055 facts propagated faithfully, order preserved).
      assert.deepEqual(context.grantedScopes, [...FULL_SCOPES]);
      assert.deepEqual(context.capabilityTags, ['conformance-tag', 'second.tag:v2']);
      assert.deepEqual(context.providerConfig.platformHint, platformKey, 'the connection providerConfig rides the context');
      assert.ok(context.credentialMaterial.length > 0, 'the credential material resolved in-process');
      passed('account identity/scope propagation (verbatim scopes + tags + config + material)');
    }

    // -----------------------------------------------------------------
    // Scenario 3 — content-read family (declared subset only).
    // -----------------------------------------------------------------
    if (declaredFamilies.has('content-read')) {
      const discovery = await module().discoverPublicContent(accountA, { query: 'growth marketing', pageCursor: null, limit: 2 }, PROVENANCE);
      assert.equal(discovery.ok, true, JSON.stringify(discovery));
      assert.ok(discovery.page.records.length > 0);
      const own = await module().listOwnContent(accountA, { pageCursor: null, limit: 10 }, PROVENANCE);
      assert.equal(own.ok, true, JSON.stringify(own));
      assert.ok(own.page.records.length > 0);
      const first = own.page.records[0]!;
      const single = await module().getContent(accountA, { providerContentId: first.providerContentId }, PROVENANCE);
      assert.equal(single.ok, true, JSON.stringify(single));
      assert.ok(single.record !== null);
      assert.equal(single.record!.providerContentId, first.providerContentId);
      passed('content-read operations (discovery + own listing + single read)');
    }

    // -----------------------------------------------------------------
    // Scenario 4 — analytics-read family (declared subset only).
    // -----------------------------------------------------------------
    if (declaredFamilies.has('analytics-read')) {
      const accountAnalytics = await module().readAccountAnalytics(
        accountA,
        { windowStart: '2026-08-01T00:00:00.000Z', windowEnd: '2026-08-31T00:00:00.000Z' },
        PROVENANCE,
      );
      assert.equal(accountAnalytics.ok, true, JSON.stringify(accountAnalytics));
      assert.ok(accountAnalytics.observations.length > 0);
      const own = await module().listOwnContent(accountA, { pageCursor: null, limit: 1 }, PROVENANCE);
      assert.equal(own.ok, true);
      const contentAnalytics = await module().readContentAnalytics(
        accountA,
        { providerContentIds: [own.page.records[0]!.providerContentId], windowStart: null, windowEnd: null },
        PROVENANCE,
      );
      assert.equal(contentAnalytics.ok, true, JSON.stringify(contentAnalytics));
      assert.ok(contentAnalytics.observations.length > 0);
      passed('analytics-read operations (account + per-content observations)');
    }

    // -----------------------------------------------------------------
    // Scenario 5 — restriction-signals family (declared subset only).
    // -----------------------------------------------------------------
    if (declaredFamilies.has('restriction-signals')) {
      const signals = await module().readRestrictionSignals(accountA, PROVENANCE);
      assert.equal(signals.ok, true, JSON.stringify(signals));
      assert.ok(signals.signals.length > 0);
      assert.ok(typeof signals.signals[0]!.signalKind === 'string');
      passed('restriction-signal read (observable signals only)');
    }

    // -----------------------------------------------------------------
    // Scenario 6/7/8 — the publish lifecycle (submit → replay → poll).
    // -----------------------------------------------------------------
    let attemptIdForIsolation: string | null = null;
    if (publishDeclared) {
      const publishRequest = {
        contentType: 'reference-post',
        payload: { title: 'Conformance publish', body: 'The normalized publish request payload.' },
        mediaAssets: [{ assetReference: 'content-asset:conf-1', mediaKind: 'video', descriptor: { filename: 'clip.mp4' } }],
        attribution: { missionId: 'mission-1', experimentId: 'exp-1' },
        scheduledFor: null,
      };
      const key = `conf-publish-${input.label}`;
      const submit = await module().submitPublish(accountA, { idempotencyKey: key, request: publishRequest }, PROVENANCE);
      assert.equal(submit.duplicate, false);
      assert.equal(submit.attempt.publishState, 'accepted', JSON.stringify(submit));
      assert.ok(submit.attempt.providerPublishId !== null);
      assert.equal(submit.submission.publishState, 'accepted');
      assert.equal(input.adapterHandle.publishesForIdempotencyKey(key).length, 1, 'the provider saw exactly ONE publish');
      attemptIdForIsolation = submit.attempt.attemptId;
      passed('publish submit (the claim-then-fill golden path)');

      // The REPLAY: same key → the fence answers from the recorded
      // attempt, ZERO provider calls.
      const providerSubmitsBefore = input.adapterHandle.callCount('submitPublish');
      const replay = await module().submitPublish(accountA, { idempotencyKey: key, request: publishRequest }, PROVENANCE);
      assert.equal(replay.duplicate, true, 'the replayed key is answered from the fence');
      assert.equal(replay.attempt.attemptId, submit.attempt.attemptId, 'the SAME attempt row');
      assert.equal(replay.attempt.publishState, 'accepted');
      assert.equal(input.adapterHandle.callCount('submitPublish'), providerSubmitsBefore, 'ZERO provider calls on replay');
      assert.equal(input.adapterHandle.publishesForIdempotencyKey(key).length, 1, 'still exactly ONE provider publish');
      const roundTrip = await module().getPublishAttempt(accountA, submit.attempt.attemptId);
      assert.equal(roundTrip.attemptId, submit.attempt.attemptId);
      passed('publish idempotency under replay (same attempt, zero provider calls)');

      if (statusDeclared) {
        const first = await module().refreshPublishStatus(accountA, submit.attempt.attemptId, PROVENANCE);
        assert.equal(first.observation.publishState, 'accepted');
        // Advance the provider state and poll again: the observation
        // history carries the later answer; the attempt keeps the
        // submit-time fact.
        input.adapterHandle.advancePublish(submit.attempt.providerPublishId!, 'published', {
          providerContentId: 'ref-content-published-1',
        });
        const second = await module().refreshPublishStatus(accountA, submit.attempt.attemptId, PROVENANCE);
        assert.equal(second.observation.publishState, 'published');
        assert.equal(second.observation.providerContentId, 'ref-content-published-1');
        assert.equal(second.attempt.publishState, 'accepted', 'the attempt row keeps the SUBMIT-TIME fact');
        const history = await module().listPublishStatusObservations(accountA, submit.attempt.attemptId);
        assert.equal(history.length, 2, 'one immutable observation per poll');
        passed('publish status lifecycle (append-only observation history)');
      }
    }

    // -----------------------------------------------------------------
    // Scenario 9 — capability-subset enforcement (fail-closed unknown
    // ops on UNDECLARED families, zero provider traffic).
    // -----------------------------------------------------------------
    {
      for (const family of SOCIAL_CAPABILITY_FAMILIES) {
        if (declaredFamilies.has(family)) continue;
        const before = totalCalls(input.adapterHandle);
        const outcome = await runFamilyProbe(module(), accountA, family, PROVENANCE);
        assert.ok(!outcome.ok, `the undeclared family '${family}' refuses`);
        assert.equal(outcome.failure.code, 'unsupported-capability');
        assert.equal(totalCalls(input.adapterHandle), before, `zero provider traffic for the undeclared family '${family}'`);
      }
      if ([...SOCIAL_CAPABILITY_FAMILIES].every((family) => declaredFamilies.has(family))) {
        // The FULL adapter declares everything — the subset enforcement
        // is proven structurally by the partial run (the caller runs
        // the suite twice); assert the declared families DO respond.
        const before = totalCalls(input.adapterHandle);
        const outcome = await module().readAccountProfile(accountA, PROVENANCE);
        assert.equal(outcome.ok, true, JSON.stringify(outcome));
        assert.ok(totalCalls(input.adapterHandle) > before);
      }
      passed('capability-subset enforcement (undeclared families fail closed, zero traffic)');
    }

    // -----------------------------------------------------------------
    // Scenario 10 — the scope pre-flight (read-only grant).
    // -----------------------------------------------------------------
    {
      for (const family of SOCIAL_CAPABILITY_FAMILIES) {
        if (!declaredFamilies.has(family) || satisfiedByReadOnly(family)) continue;
        const before = totalCalls(input.adapterHandle);
        const outcome = await runFamilyProbe(module(), accountB, family, PROVENANCE);
        assert.ok(!outcome.ok, `the read-only grant refuses the '${family}' family`);
        assert.equal(outcome.failure.code, 'insufficient-scope');
        assert.equal(totalCalls(input.adapterHandle), before, `zero provider traffic for the scope-refused family '${family}'`);
      }
      passed('scope pre-flight (insufficient-scope refuses before any traffic)');
    }

    // -----------------------------------------------------------------
    // Scenario 11 — the error taxonomy (scripted provider failures).
    // -----------------------------------------------------------------
    {
      const taxonomy: readonly { code: 'auth-expired' | 'rate-limited' | 'restricted' | 'provider-unavailable'; retryable: boolean }[] = [
        { code: 'auth-expired', retryable: false },
        { code: 'rate-limited', retryable: true },
        { code: 'restricted', retryable: false },
        { code: 'provider-unavailable', retryable: true },
      ];
      for (const { code, retryable } of taxonomy) {
        input.adapterHandle.setFailure('getAccountProfile', code, `the reference platform scripted ${code}`);
        const outcome = await module().readAccountProfile(accountA, PROVENANCE);
        assert.ok(!outcome.ok, `the scripted ${code} failure surfaces`);
        assert.equal(outcome.failure.code, code);
        assert.ok(outcome.failure.message.includes(code));
        input.adapterHandle.clearFailure('getAccountProfile');
        const recovered = await module().readAccountProfile(accountA, PROVENANCE);
        assert.equal(recovered.ok, true, 'clearing the scripting recovers');
        void retryable;
      }
      passed('error taxonomy (the four provider-failure codes surface as data)');
    }

    // -----------------------------------------------------------------
    // Scenario 12 — the /policies fail-closed gate (deny → honest
    // policy-denied data failure, zero provider traffic; publish
    // refusals are RECORDED on the fence).
    // -----------------------------------------------------------------
    {
      const deny = await apiCall(api.port, `/api/agencies/${alice.agencyId}/policies`, {
        token: alice.token,
        body: {
          dimension: 'network',
          rules: [
            { effect: 'deny', operations: ['social-adapter.read'], reason: 'conformance deny' },
            { effect: 'deny', operations: ['social-adapter.publish'], reason: 'conformance deny' },
          ],
          description: 'Conformance network denial',
        },
      });
      assert.equal(deny.status, 201, JSON.stringify(deny.body));
      const before = totalCalls(input.adapterHandle);
      const refused = await module().readAccountProfile(accountA, PROVENANCE);
      assert.ok(!refused.ok);
      assert.equal(refused.failure.code, 'policy-denied');
      assert.equal(totalCalls(input.adapterHandle), before, 'zero provider traffic on the policy denial');
      if (publishDeclared) {
        const submit = await module().submitPublish(
          accountA,
          {
            idempotencyKey: `conf-policy-denied-${input.label}`,
            request: {
              contentType: 'reference-post',
              payload: { title: 'Denied publish' },
              mediaAssets: [],
              attribution: {},
              scheduledFor: null,
            },
          },
          PROVENANCE,
        );
        assert.equal(submit.duplicate, false);
        assert.equal(submit.attempt.publishState, 'failed');
        assert.equal(submit.attempt.failureCode, 'policy-denied', 'the pre-flight refusal is RECORDED on the fence');
        assert.equal(totalCalls(input.adapterHandle), before, 'the denied publish never reached the provider');
      }
      await allowAll(alice, 'network');
      const recovered = await module().readAccountProfile(accountA, PROVENANCE);
      assert.equal(recovered.ok, true, 're-allowing the dimension recovers');
      passed('policy fail-closed gate (honest policy-denied data failures, recorded publish refusals)');
    }

    // -----------------------------------------------------------------
    // Scenario 13 — dead binding (disconnected account refuses).
    // -----------------------------------------------------------------
    {
      await module().disconnectAccount(
        { socialAccountId: accountC, reason: 'conformance death', revokeAtProvider: false },
        PROVENANCE,
      );
      await assert.rejects(
        () => module().readAccountProfile(accountC, PROVENANCE),
        (error: unknown) => error instanceof Error && error.message.includes('disconnected'),
        'a disconnected account refuses with the fail-closed conflict',
      );
      passed('dead binding (disconnect refuses every adapter operation)');
    }

    // -----------------------------------------------------------------
    // Scenario 14 — lazy expiry (the auth-expired reauthorization signal).
    // -----------------------------------------------------------------
    {
      const view = await module().resolveAccountCapabilityMatrix(accountE);
      assert.ok(view !== null);
      assert.equal(view.authorizationUsable, false, 'the expired grant is not usable');
      const before = totalCalls(input.adapterHandle);
      const outcome = await module().readAccountProfile(accountE, PROVENANCE);
      assert.ok(!outcome.ok);
      assert.equal(outcome.failure.code, 'auth-expired');
      assert.equal(totalCalls(input.adapterHandle), before, 'zero provider traffic on the expired grant');
      passed('lazy expiry (the honest auth-expired reauthorization signal)');
    }

    // -----------------------------------------------------------------
    // Scenario 15 — cross-client isolation.
    // -----------------------------------------------------------------
    {
      const aliceAttempts = await module().listPublishAttemptsForClient(aliceClientId);
      const bobAttempts = await module().listPublishAttemptsForClient(bobClientId);
      const aliceIds = new Set(aliceAttempts.map((attempt) => attempt.attemptId));
      const bobIds = new Set(bobAttempts.map((attempt) => attempt.attemptId));
      for (const id of aliceIds) assert.ok(!bobIds.has(id), 'no cross-client attempt leakage');
      if (publishDeclared && attemptIdForIsolation !== null) {
        // A foreign account id cannot read alice's attempt (uniform 404).
        await assert.rejects(
          () => module().getPublishAttempt(accountD, attemptIdForIsolation),
          (error: unknown) => error instanceof Error,
          'a foreign account cannot read another account attempt (uniform 404)',
        );
        await assert.rejects(
          () => module().listPublishStatusObservations(accountD, attemptIdForIsolation),
          () => true,
          'a foreign account cannot read another account observation history',
        );
      }
      // A foreign account id on the module surface is the uniform 404.
      await assert.rejects(
        () => module().readAccountProfile('00000000-0000-4000-8000-000000000000', PROVENANCE),
        () => true,
        'an unknown account is the uniform 404',
      );
      passed('cross-client isolation (attempt/observation reads are account-scoped)');
    }

    // -----------------------------------------------------------------
    // Scenario 16 — unknown platform (no registered adapter refuses).
    // -----------------------------------------------------------------
    {
      const view = await module().resolveAccountCapabilityMatrix(accountF);
      assert.ok(view !== null);
      assert.equal(view.registered, false, 'the CRM-keyed platform has no registered social adapter');
      assert.deepEqual(view.capabilities, []);
      await assert.rejects(
        () => module().readAccountProfile(accountF, PROVENANCE),
        (error: unknown) =>
          error instanceof Error && error.message.includes('no social platform adapter is registered'),
        'an operation on a platform without a registered adapter is refused fail-closed',
      );
      passed('unknown platform (no registered adapter refuses fail-closed)');
    }

    // -----------------------------------------------------------------
    // Scenario 17 — the DB fences (the direct battery).
    // -----------------------------------------------------------------
    {
      if (publishDeclared && attemptIdForIsolation !== null) {
        const attemptRow = await pool().query(
          'SELECT attempt_id, publish_state, failure_code FROM social_publish_attempts WHERE attempt_id = $1',
          [attemptIdForIsolation],
        );
        assert.equal(attemptRow.rowCount, 1, 'the attempt row is durable');
        const observationIds = await pool().query<{ observation_id: string }>(
          'SELECT observation_id FROM social_publish_status_observations WHERE attempt_id = $1 LIMIT 1',
          [attemptIdForIsolation],
        );
        const observationId = observationIds.rows[0]?.observation_id ?? null;
        if (observationId !== null) {
          await assert.rejects(
            () => pool().query('DELETE FROM social_publish_status_observations WHERE observation_id = $1', [observationId]),
            (error: unknown) => error instanceof Error && error.message.includes('append-only'),
            'the observation tail rejects DELETE',
          );
        }
        await assert.rejects(
          () => pool().query('DELETE FROM social_publish_attempts WHERE attempt_id = $1', [attemptIdForIsolation]),
          (error: unknown) => error instanceof Error && error.message.includes('append-only'),
          'the attempt ledger rejects DELETE',
        );
        await assert.rejects(
          () =>
            pool().query(
              "UPDATE social_publish_attempts SET publish_state = 'published' WHERE attempt_id = $1 AND publish_state = 'accepted'",
              [attemptIdForIsolation],
            ),
          (error: unknown) => error instanceof Error && error.message.includes('immutable'),
          'a filled attempt is immutable (only the single submitted→terminal fill is sanctioned)',
        );
      }
      passed('DB fences (append-only triggers + the single-fill discipline)');
    }

    return { scenarios, failed: 0 };
  } finally {
    // NOTE: the caller owns the provider double (it closes it); this
    // suite tears down only its OWN stack + API process.
    api?.child.kill('SIGKILL');
    if (stack !== null) {
      await shutdownStack(stack);
    }
  }
}

function totalCalls(handle: ReferenceSocialAdapter): number {
  return ['verifyAccountIdentity', 'getAccountProfile', 'discoverPublicContent', 'listOwnContent', 'getContent', 'readAccountAnalytics', 'readContentAnalytics', 'submitPublish', 'getPublishStatus', 'readRestrictionSignals'].reduce(
    (sum, operation) => sum + handle.callCount(operation),
    0,
  );
}

/** The normalized probe outcome (the subset/scope batteries route on it). */
interface FamilyProbeOutcome {
  readonly ok: boolean;
  readonly failure: { readonly code: string; readonly message: string };
}

/** Runs one representative operation of a family (the subset/scope probes). */
async function runFamilyProbe(
  module: SocialAccountsModuleApi,
  accountId: string,
  family: SocialCapabilityFamily,
  provenance: typeof PROVENANCE,
): Promise<FamilyProbeOutcome> {
  switch (family) {
    case 'account':
      return collapse(await module.readAccountProfile(accountId, provenance));
    case 'content-read':
      return collapse(await module.discoverPublicContent(accountId, { query: 'probe', pageCursor: null, limit: 1 }, provenance));
    case 'analytics-read':
      return collapse(await module.readAccountAnalytics(accountId, { windowStart: null, windowEnd: null }, provenance));
    case 'publish': {
      // The publish submit never THROWS a refusal — the fence RECORDS it;
      // the probe outcome collapses the attempt row.
      const submit = await module.submitPublish(
        accountId,
        {
          idempotencyKey: `probe-${family}-${accountId}`,
          request: { contentType: 'reference-post', payload: { probe: true }, mediaAssets: [], attribution: {}, scheduledFor: null },
        },
        provenance,
      );
      return submit.attempt.failureCode === null
        ? { ok: true, failure: { code: '', message: '' } }
        : {
            ok: false,
            failure: {
              code: submit.attempt.failureCode,
              message: `the publish attempt failed with '${submit.attempt.failureCode}'`,
            },
          };
    }
    case 'restriction-signals':
      return collapse(await module.readRestrictionSignals(accountId, provenance));
  }
}

/** Collapses a data-outcome union into the probe shape. */
function collapse(
  outcome: { ok: true } | { ok: false; failure: { code: string; message: string } },
): FamilyProbeOutcome {
  return outcome.ok ? { ok: true, failure: { code: '', message: '' } } : { ok: false, failure: outcome.failure };
}
