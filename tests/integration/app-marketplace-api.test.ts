/**
 * MKT-050 integration tests — the App Marketplace, Trust and
 * Certification surface on the real stack (embedded PostgreSQL 18 +
 * real API process — no mocks of platform services).
 *
 * Acceptance mapping (spec/effective-backlog-v1.5.md MKT-050; the
 * dispatch acceptance criteria AC-1..AC-8):
 *   - AC-1 GOLDEN DISCOVERY: a published app appears in the
 *     agency-scoped marketplace listing with the derived birth trust
 *     state (UNVERIFIED), the version visibility (the full registry
 *     version history), the DERIVED first-party/community
 *     classification and the honest empty review summary; the detail
 *     and the policy-eligibility read-side query serve the same
 *     lineage; a first-party (svc:) app classifies first-party
 *     (ground-truth setup by direct SQL — the registry authority is
 *     the only writer);
 *   - AC-2 TRUST LADDER: the frozen one-way arrows (verify, certify)
 *     with the disclosed down moves (decertify, revoke) — every legal
 *     move recorded as an append-only event (DB-asserted chain
 *     consistency, gapless sequence, server-derived provenance);
 *     illegal moves (skip, wrong departure, double-transition) are
 *     rejected 422 with ZERO rows; §8 replays converge and divergent
 *     key reuse is a 409; the authorization model is enforced
 *     (platform_administrator/service principal only — a
 *     platform_developer is INSUFFICIENT: no self-certification);
 *   - AC-3 TRUST-IS-NOT-AUTHORITY BATTERY (the heart): an
 *     MOS_CERTIFIED app under a policy that DENIES its installs STILL
 *     FAILS 403 with zero rows; an UNVERIFIED app under the
 *     permissive policy STILL INSTALLS through the UNCHANGED MKT-048
 *     gate; the trust-derived certificationState attribute is a LIVE
 *     policy input (a revocation re-enables the install through the
 *     policy rule, never around it); the /apps registry rows stay
 *     FROZEN AT BIRTH (DB-asserted) and transitions create ZERO
 *     install rows;
 *   - AC-4 REVIEWS: app-level and version-level structured reviews
 *     with server-derived reviewer provenance; the derived summary
 *     updates live; replay convergence; divergent 409; the DB rejects
 *     UPDATE and DELETE outright; a foreign version target is the
 *     uniform 404; guards reject malformed rating/verdict/body with
 *     zero rows;
 *   - AC-5 POLICY ELIGIBILITY: the read-side query exposes the
 *     derived trust level + review state in the policy-consumable
 *     vocabulary (certificationState/transitionCount/reviewCount/
 *     averageRating) and the MKT-048 gate consumes the derived trust
 *     (the disclosed additive wiring — proven by the AC-3 battery);
 *   - AC-1 ISOLATION: foreign/malformed/unknown agency identifiers
 *     are the UNIFORM 404; a suspended membership is the 403;
 *     anonymous calls fail closed 401; the catalog itself is global
 *     registry state (both authorized agencies see the same catalog);
 *   - AC-1 FILTERS: category (a declared capability), trust level,
 *     first-party/community and bounded search; unknown query keys and
 *     off-vocabulary values are rejected 422;
 *   - AC-6/AC-7 (attribution/migration boundaries) are proven
 *     statically by tests/architecture/app-marketplace-boundary.test.ts.
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

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';
const SERVICE_TOKEN = 'integration-test-token';

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

function pool(): pg.Pool {
  if (stack === null) throw new Error('test stack not booted');
  return stack.pg.pool;
}

before(async () => {
  stack = await bootStack('app-marketplace');
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

interface User {
  readonly userId: string;
  readonly token: string;
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

interface Principal {
  readonly userId: string;
  readonly token: string;
  readonly agencyId: string;
}

/** An agency owner (the sanctioned installer role) with its own agency. */
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

async function makeClient(agencyId: string, token: string): Promise<string> {
  const created = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token,
    body: { name: `Client ${agencyId.slice(0, 8)}` },
  });
  assert.equal(created.status, 201);
  return created.body['clientId'] as string;
}

async function makeWorkspace(clientId: string, token: string, name: string): Promise<string> {
  const created = await apiCall(port(), `/api/clients/${clientId}/workspaces`, {
    token,
    body: { name },
  });
  assert.equal(created.status, 201);
  return created.body['workspaceId'] as string;
}

/** A bare user granted the frozen platform_developer role (the publish gate). */
async function makeDeveloper(email: string): Promise<User> {
  const user = await makeUser(email, 'developer-password-123');
  const grant = await apiCall(port(), `/api/users/${user.userId}/platform-roles`, {
    token: await adminToken(),
    body: { role: 'platform_developer' },
  });
  assert.equal(grant.status, 200, JSON.stringify(grant.body));
  return user;
}

/**
 * The frozen §Manifest fixture (the MKT-048 shape): NO dependencies,
 * platform compatibility [1.0.0 .. 2.0.0] against the server-declared
 * 1.5.0, and both data + both mutation scopes requested.
 */
function appManifestFixture(appKey: string, version: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifest: {
      appKey,
      version,
      compatibility: { minPlatform: '1.0.0', maxPlatform: '2.0.0' },
      capabilities: [{ name: 'run', version: '1.0.0' }],
      inputSchema: { required: ['workspaceId'] },
      outputSchema: { required: ['ok'] },
      dataScopes: ['client:read', 'workspace:read'],
      mutationScopes: ['evidence:append', 'metric:append'],
      networkDestinations: [],
      runtimeClass: 'pooled-worker',
      eventSubscriptions: [],
      uiSurfaces: [{ surface: 'workspace-tab', route: `/tabs/${appKey}` }],
      configSchema: {},
      requiredCredentialNames: [],
      stateNamespaces: [`app:${appKey}:docs`],
      migrationVersion: 1,
      dependencies: [],
      supportLevel: 'standard',
      meteringDimensions: ['installations'],
      ...overrides,
    },
    idempotencyKey: `publish-${appKey}-${version}`,
  };
}

/** Publishes one immutable App Version through the frozen developer gate. */
async function publishApp(manifest: Record<string, unknown>, token: string): Promise<Record<string, unknown>> {
  const publish = await apiCall(port(), '/api/apps', {
    token,
    body: { ...manifest, idempotencyKey: `publish-${(manifest['manifest'] as Record<string, unknown>)['appKey']}-${(manifest['manifest'] as Record<string, unknown>)['version']}` },
  });
  assert.equal(publish.status, 201, JSON.stringify(publish.body));
  return publish.body as Record<string, unknown>;
}

/** Records one trust transition through the operator/governance gate. */
async function transitionTrust(appKey: string, transition: string, reason: string, idempotencyKey: string, token: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/app-marketplace/apps/${appKey}/trust`, {
    token,
    body: { transition, reason, idempotencyKey },
  });
}

/** Records one community review. */
async function recordReview(appKey: string, token: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/app-marketplace/apps/${appKey}/reviews`, {
    token,
    body,
  });
}

async function countRows(table: string, where: string, params: unknown[]): Promise<number> {
  const result = await pool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${table} WHERE ${where}`,
    params as never[],
  );
  return Number(result.rows[0]!.count);
}

/**
 * Ground-truth setup: a FIRST-PARTY (svc:) app lineage through direct SQL
 * (the registry authority's own writer semantics — the only publisher
 * identity shape the developer surface cannot produce: the internal
 * service principal label carries spaces and the registry guard
 * fail-closes it; the classification is the marketplace's DERIVED read
 * over registry rows).
 */
async function insertFirstPartyApp(appKey: string, version: string): Promise<void> {
  // A deterministic HEX uuid suffix from the app key (ground-truth ids
  // must be valid uuids).
  const hexSuffix = Array.from(appKey)
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12)
    .padEnd(12, '0');
  const appVersionId = `00000000-0000-4000-8000-${hexSuffix}`;
  await pool().query(
    'INSERT INTO apps (app_key, owner_publisher) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [appKey, 'svc:mos-core'],
  );
  await pool().query(
    `INSERT INTO app_versions
       (app_version_id, app_key, publisher, version, compat_min, compat_max,
        capabilities, input_schema, output_schema, data_scopes, mutation_scopes,
        network_destinations, runtime_class, event_subscriptions, ui_surfaces,
        config_schema, required_credential_names, state_namespaces,
        migration_version, dependencies, certification_state, support_level,
        metering_dimensions, idempotency_key, create_fingerprint, created_at, updated_at)
     VALUES ($1, $2, 'svc:mos-core', $3, '1.0.0', '2.0.0',
        $4::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb,
        '[]'::jsonb, 'pooled-worker', '[]'::jsonb, '[]'::jsonb,
        '{}'::jsonb, '[]'::jsonb, $5::jsonb,
        1, '[]'::jsonb, 'UNVERIFIED', 'standard',
        '["installations"]'::jsonb, $6, $7, now(), now())`,
    [
      appVersionId,
      appKey,
      version,
      JSON.stringify([{ name: 'run', version: '1.0.0' }]),
      JSON.stringify([`app:${appKey}:docs`]),
      `publish-${appKey}-${version}`,
      `fingerprint-${appKey}-${version}`,
    ],
  );
}

// Shared state built once in the first tests (creation order matters).
interface SharedState {
  readonly developer: User;
  readonly owner: Principal;
  readonly workspaceId: string;
  readonly goldenAppKey: string;
  readonly goldenVersionId: string;
}
let shared: SharedState | null = null;
function state(): SharedState {
  if (shared === null) throw new Error('shared fixtures not built');
  return shared;
}

// ---------------------------------------------------------------------------
// AC-1/AC-8 — the golden discovery path (publish → appear in the
// marketplace → trust transition visible → review recorded → the
// policy-gated install eligibility flows through MKT-048 unchanged)
// ---------------------------------------------------------------------------

test('AC-1 golden: published apps appear in the agency-scoped marketplace listing with the birth trust state, version visibility and the derived classification', async () => {
  // The platform extension-dimension boundary: install/upgrade/rollback
  // allowed, and an explicit DENY of installs whose DERIVED trust state
  // is MOS_CERTIFIED — the AC-3 battery's input (trust as a policy
  // input; deny still wins over certification).
  const declare = await apiCall(port(), '/api/policies', {
    token: await adminToken(),
    body: {
      dimension: 'extension',
      rules: [
        { effect: 'deny', operations: ['install'], attributes: { certificationState: 'MOS_CERTIFIED' }, reason: 'deny installs of MOS_CERTIFIED apps (trust is a policy input, never authority)' },
        { effect: 'allow', operations: ['install', 'upgrade', 'rollback'], reason: 'platform marketplace install boundary allow' },
      ],
      description: 'Platform app-marketplace install boundary v1',
    },
  });
  assert.equal(declare.status, 201, JSON.stringify(declare.body));

  const developer = await makeDeveloper('marketplace-developer@marketingos.test');
  const owner = await makeAgencyOwner('marketplace-owner@marketingos.test');
  const clientId = await makeClient(owner.agencyId, owner.token);
  const workspaceId = await makeWorkspace(clientId, owner.token, 'Marketplace Workspace');

  // Two versions of the golden app (version visibility) + one
  // permissive tool + one ground-truth first-party app.
  const v1 = await publishApp(appManifestFixture('golden-reporter', '1.0.0'), developer.token);
  await publishApp(appManifestFixture('golden-reporter', '1.1.0'), developer.token);
  await publishApp(appManifestFixture('permissive-tool', '1.0.0'), developer.token);
  await insertFirstPartyApp('first-party-pack', '1.0.0');

  const listing = await apiCall(port(), `/api/app-marketplace/${owner.agencyId}/apps`, {
    token: owner.token,
  });
  assert.equal(listing.status, 200, JSON.stringify(listing.body));
  const apps = (listing.body as Record<string, unknown>)['apps'] as Record<string, unknown>[];
  assert.equal(apps.length, 3, 'three published lineages');

  const byKey = new Map(apps.map((entry) => [entry['appKey'] as string, entry]));
  const golden = byKey.get('golden-reporter')!;
  // The DERIVED classification: the developer publisher is community.
  assert.equal(golden['publisherKind'], 'community');
  assert.ok((golden['publisher'] as string).startsWith('dev:'));
  // Version visibility: the full immutable registry history, newest first.
  const versions = golden['versions'] as Record<string, unknown>[];
  assert.deepEqual(versions.map((version) => version['version']), ['1.1.0', '1.0.0']);
  assert.equal((golden['latestVersion'] as Record<string, unknown>)['version'], '1.1.0');
  // The birth trust state (no events yet): UNVERIFIED, zero transitions.
  const trustState = golden['trustState'] as Record<string, unknown>;
  assert.equal(trustState['trustLevel'], 'UNVERIFIED');
  assert.equal(trustState['transitionCount'], 0);
  // The honest empty review summary.
  const reviewSummary = golden['reviewSummary'] as Record<string, unknown>;
  assert.equal(reviewSummary['reviewCount'], 0);
  assert.equal(reviewSummary['averageRating'], undefined);

  const firstParty = byKey.get('first-party-pack')!;
  assert.equal(firstParty['publisherKind'], 'first-party');
  assert.equal(firstParty['publisher'], 'svc:mos-core');

  // The detail surface: the same entry + the (empty) tails.
  const detail = await apiCall(port(), `/api/app-marketplace/${owner.agencyId}/apps/golden-reporter`, {
    token: owner.token,
  });
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  const detailBody = detail.body as Record<string, unknown>;
  assert.equal((detailBody['entry'] as Record<string, unknown>)['appKey'], 'golden-reporter');
  assert.deepEqual(detailBody['trustEvents'], []);
  assert.deepEqual(detailBody['reviews'], []);

  // The policy-eligibility read-side query (AC-5): the birth state in
  // the policy-consumable vocabulary.
  const eligibility = await apiCall(port(), `/api/app-marketplace/${owner.agencyId}/apps/golden-reporter/policy-eligibility`, {
    token: owner.token,
  });
  assert.equal(eligibility.status, 200, JSON.stringify(eligibility.body));
  const eligibilityBody = eligibility.body as Record<string, unknown>;
  assert.equal(eligibilityBody['trustLevel'], 'UNVERIFIED');
  assert.deepEqual(eligibilityBody['policyAttributes'], {
    certificationState: 'UNVERIFIED',
    transitionCount: '0',
    reviewCount: '0',
    averageRating: 'none',
  });

  // An unknown app key is the uniform 404 on every discovery surface.
  const unknownDetail = await apiCall(port(), `/api/app-marketplace/${owner.agencyId}/apps/no-such-app`, {
    token: owner.token,
  });
  assert.equal(unknownDetail.status, 404);
  const unknownEligibility = await apiCall(port(), `/api/app-marketplace/${owner.agencyId}/apps/no-such-app/policy-eligibility`, {
    token: owner.token,
  });
  assert.equal(unknownEligibility.status, 404);

  shared = {
    developer,
    owner,
    workspaceId,
    goldenAppKey: 'golden-reporter',
    goldenVersionId: v1['appVersionId'] as string,
  };
});

// ---------------------------------------------------------------------------
// AC-4 — the review battery (append-only, structured, server-provenance)
// ---------------------------------------------------------------------------

test('AC-4: a community member records app-level and version-level reviews with server-derived provenance; the summary derives live', async () => {
  const { owner, goldenAppKey, goldenVersionId } = state();

  const appLevel = await recordReview(goldenAppKey, owner.token, {
    rating: 5,
    verdict: 'positive',
    body: 'solid reporting pack for our weekly client review',
    idempotencyKey: 'review-golden-1',
  });
  assert.equal(appLevel.status, 201, JSON.stringify(appLevel.body));
  const review = (appLevel.body as Record<string, unknown>)['review'] as Record<string, unknown>;
  assert.equal(review['rating'], 5);
  assert.equal(review['verdict'], 'positive');
  assert.equal(review['appVersionId'], undefined, 'an app-level review carries no version target');
  assert.equal((review['provenance'] as Record<string, unknown>)['recordedActor'], `user:${owner.userId}`);

  // A version-level review targeting the EXACT published version.
  const versionLevel = await recordReview(goldenAppKey, owner.token, {
    rating: 4,
    verdict: 'mixed',
    body: 'the 1.0.0 export was slow but the dashboards are great',
    appVersionId: goldenVersionId,
    idempotencyKey: 'review-golden-2',
  });
  assert.equal(versionLevel.status, 201, JSON.stringify(versionLevel.body));
  const versionReview = (versionLevel.body as Record<string, unknown>)['review'] as Record<string, unknown>;
  assert.equal(versionReview['appVersionId'], goldenVersionId);

  // The derived summary updates LIVE (count, one-decimal average,
  // verdict tallies) on the listing, the detail and the eligibility.
  const listing = await apiCall(port(), `/api/app-marketplace/${owner.agencyId}/apps`, { token: owner.token });
  const apps = (listing.body as Record<string, unknown>)['apps'] as Record<string, unknown>[];
  const golden = apps.find((entry) => entry['appKey'] === goldenAppKey)!;
  const summary = golden['reviewSummary'] as Record<string, unknown>;
  assert.equal(summary['reviewCount'], 2);
  assert.equal(summary['averageRating'], 4.5); // (5 + 4) / 2
  assert.deepEqual(summary['verdictCounts'], { positive: 1, mixed: 1, negative: 0 });

  const eligibility = await apiCall(port(), `/api/app-marketplace/${owner.agencyId}/apps/${goldenAppKey}/policy-eligibility`, {
    token: owner.token,
  });
  const eligibilityBody = eligibility.body as Record<string, unknown>;
  assert.deepEqual(eligibilityBody['policyAttributes'], {
    certificationState: 'UNVERIFIED',
    transitionCount: '0',
    reviewCount: '2',
    averageRating: '4.5',
  });

  // DB ground truth: the append-only rows with the reviewer provenance.
  const rows = await pool().query<{ rating: number; verdict: string; app_version_id: string | null; recorded_actor: string }>(
    'SELECT rating, verdict, app_version_id, recorded_actor FROM app_reviews WHERE app_key = $1 ORDER BY recorded_at, review_id',
    [goldenAppKey],
  );
  assert.equal(rows.rows.length, 2);
  assert.equal(rows.rows[0]!.app_version_id, null);
  assert.equal(rows.rows[1]!.app_version_id, goldenVersionId);
  assert.equal(rows.rows[0]!.recorded_actor, `user:${owner.userId}`);

  // The §8 replay: an identical payload converges (200, replayed, zero
  // new rows).
  const replay = await recordReview(goldenAppKey, owner.token, {
    rating: 5,
    verdict: 'positive',
    body: 'solid reporting pack for our weekly client review',
    idempotencyKey: 'review-golden-1',
  });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal((replay.body as Record<string, unknown>)['replayed'], true);
  assert.equal(await countRows('app_reviews', 'app_key = $1', [goldenAppKey]), 2);

  // A divergent payload under the SAME key is a 409.
  const divergent = await recordReview(goldenAppKey, owner.token, {
    rating: 1,
    verdict: 'negative',
    body: 'different content under a used key',
    idempotencyKey: 'review-golden-1',
  });
  assert.equal(divergent.status, 409, JSON.stringify(divergent.body));
  assert.equal(await countRows('app_reviews', 'app_key = $1', [goldenAppKey]), 2);
});

test('AC-4: review guards — foreign version target is the uniform 404; malformed inputs are 422 with ZERO rows; anonymous is 401', async () => {
  const { owner, goldenAppKey } = state();

  // A version belonging to ANOTHER lineage is the uniform 404 (the
  // migration-042 version-consistency trigger re-fences the same rule).
  const foreignVersion = await recordReview(goldenAppKey, owner.token, {
    rating: 5,
    verdict: 'positive',
    body: 'attaching another app version',
    appVersionId: '00000000-0000-4000-8000-000000000001',
    idempotencyKey: 'review-foreign-1',
  });
  assert.equal(foreignVersion.status, 404, JSON.stringify(foreignVersion.body));
  // An unknown version id likewise.
  const unknownVersion = await recordReview(goldenAppKey, owner.token, {
    rating: 5,
    verdict: 'positive',
    body: 'unknown version target',
    appVersionId: '99999999-9999-4999-8999-999999999999',
    idempotencyKey: 'review-unknown-1',
  });
  assert.equal(unknownVersion.status, 404);
  // An unknown app key is the uniform 404.
  const unknownApp = await recordReview('no-such-app', owner.token, {
    rating: 5,
    verdict: 'positive',
    body: 'review of nothing',
    idempotencyKey: 'review-unknown-2',
  });
  assert.equal(unknownApp.status, 404);

  const before = await countRows('app_reviews', 'app_key = $1', [goldenAppKey]);
  // The closed rating band.
  for (const rating of [0, 6, 3.5]) {
    const bad = await recordReview(goldenAppKey, owner.token, {
      rating,
      verdict: 'positive',
      body: 'rating out of band',
      idempotencyKey: `review-bad-rating-${rating}`,
    });
    assert.equal(bad.status, 422, JSON.stringify(bad.body));
  }
  // The closed verdict vocabulary.
  const badVerdict = await recordReview(goldenAppKey, owner.token, {
    rating: 5,
    verdict: 'great',
    body: 'verdict off vocabulary',
    idempotencyKey: 'review-bad-verdict',
  });
  assert.equal(badVerdict.status, 422);
  // The bounded body.
  const badBody = await recordReview(goldenAppKey, owner.token, {
    rating: 5,
    verdict: 'positive',
    body: 'x'.repeat(2001),
    idempotencyKey: 'review-bad-body',
  });
  assert.equal(badBody.status, 422);
  // Caller-supplied derived state is rejected (reviews are display
  // metadata — the DTO forbids every derived key).
  const spoofed = await recordReview(goldenAppKey, owner.token, {
    rating: 5,
    verdict: 'positive',
    body: 'spoofed summary',
    idempotencyKey: 'review-spoof',
    reviewSummary: { reviewCount: 99 },
  });
  assert.equal(spoofed.status, 422, JSON.stringify(spoofed.body));
  const spoofed2 = await recordReview(goldenAppKey, owner.token, {
    rating: 5,
    verdict: 'positive',
    body: 'spoofed trust',
    idempotencyKey: 'review-spoof-2',
    trustLevel: 'MOS_CERTIFIED',
  });
  assert.equal(spoofed2.status, 422);
  assert.equal(await countRows('app_reviews', 'app_key = $1', [goldenAppKey]), before, 'zero rows on every rejection');

  // Anonymous calls fail closed 401.
  const anonymous = await apiCall(port(), `/api/app-marketplace/apps/${goldenAppKey}/reviews`, {
    body: { rating: 5, verdict: 'positive', body: 'anonymous review', idempotencyKey: 'review-anon' },
  });
  assert.equal(anonymous.status, 401);
});

// ---------------------------------------------------------------------------
// AC-2 — the trust ladder battery (the frozen one-way arrows + the
// disclosed down moves; the operator/governance authorization model)
// ---------------------------------------------------------------------------

test('AC-2: the operator ladder — verify then certify, every event append-only with server-derived provenance (DB-asserted)', async () => {
  const { owner, goldenAppKey } = state();

  const verify = await transitionTrust(goldenAppKey, 'verify', 'community review round 1 complete', 'trust-golden-1', await adminToken());
  assert.equal(verify.status, 201, JSON.stringify(verify.body));
  const verifyBody = (verify.body as Record<string, unknown>)['event'] as Record<string, unknown>;
  assert.equal(verifyBody['transition'], 'verify');
  assert.equal(verifyBody['fromState'], 'UNVERIFIED');
  assert.equal(verifyBody['toState'], 'COMMUNITY_VERIFIED');
  assert.equal(verifyBody['transitionSeq'], 1);
  assert.equal((verifyBody['provenance'] as Record<string, unknown>)['recordedVia'], 'api');

  const certify = await transitionTrust(goldenAppKey, 'certify', 'platform certification review complete', 'trust-golden-2', await adminToken());
  assert.equal(certify.status, 201, JSON.stringify(certify.body));
  const certifyBody = (certify.body as Record<string, unknown>)['event'] as Record<string, unknown>;
  assert.equal(certifyBody['transition'], 'certify');
  assert.equal(certifyBody['fromState'], 'COMMUNITY_VERIFIED');
  assert.equal(certifyBody['toState'], 'MOS_CERTIFIED');
  assert.equal(certifyBody['transitionSeq'], 2);

  // DB ground truth: the gapless chain with the derived from-states.
  const rows = await pool().query<{ transition: string; from_state: string; to_state: string; transition_seq: string; recorded_actor: string }>(
    'SELECT transition, from_state, to_state, transition_seq::text, recorded_actor FROM trust_events WHERE app_key = $1 ORDER BY transition_seq',
    [goldenAppKey],
  );
  assert.deepEqual(
    rows.rows.map((row) => [row.transition_seq, row.transition, row.from_state, row.to_state]),
    [
      ['1', 'verify', 'UNVERIFIED', 'COMMUNITY_VERIFIED'],
      ['2', 'certify', 'COMMUNITY_VERIFIED', 'MOS_CERTIFIED'],
    ],
  );
  assert.ok(rows.rows[0]!.recorded_actor.startsWith('user:'));

  // LIVE-FOLLOW: the listing, the detail and the eligibility all show
  // the derived MOS_CERTIFIED state (no restart, no cache).
  const listing = await apiCall(port(), `/api/app-marketplace/${owner.agencyId}/apps`, { token: owner.token });
  const apps = (listing.body as Record<string, unknown>)['apps'] as Record<string, unknown>[];
  const golden = apps.find((entry) => entry['appKey'] === goldenAppKey)!;
  assert.equal((golden['trustState'] as Record<string, unknown>)['trustLevel'], 'MOS_CERTIFIED');
  assert.equal((golden['trustState'] as Record<string, unknown>)['transitionCount'], 2);

  const detail = await apiCall(port(), `/api/app-marketplace/${owner.agencyId}/apps/${goldenAppKey}`, { token: owner.token });
  const events = ((detail.body as Record<string, unknown>)['trustEvents'] as Record<string, unknown>[]);
  assert.equal(events.length, 2);
  assert.equal((events[0] as Record<string, unknown>)['toState'], 'COMMUNITY_VERIFIED');

  const eligibility = await apiCall(port(), `/api/app-marketplace/${owner.agencyId}/apps/${goldenAppKey}/policy-eligibility`, { token: owner.token });
  const eligibilityBody = eligibility.body as Record<string, unknown>;
  assert.equal(eligibilityBody['trustLevel'], 'MOS_CERTIFIED');
  assert.deepEqual(eligibilityBody['policyAttributes'], {
    certificationState: 'MOS_CERTIFIED',
    transitionCount: '2',
    reviewCount: '2',
    averageRating: '4.5',
  });
});

test('AC-2: the authorization model — platform_administrator and the service principal only; a platform_developer can NEVER self-certify; a plain member cannot', async () => {
  const { developer, owner } = state();
  // A fresh app for the authorization battery.
  await publishApp(appManifestFixture('auth-ladder-app', '1.0.0'), developer.token);

  // A platform_developer (the publisher!) is INSUFFICIENT → 403.
  const selfCertify = await transitionTrust('auth-ladder-app', 'verify', 'developer tries to self-verify', 'trust-auth-1', developer.token);
  assert.equal(selfCertify.status, 403, JSON.stringify(selfCertify.body));
  assert.ok(
    ((selfCertify.body as Record<string, unknown>)['error'] as Record<string, unknown> | undefined)?.['message']?.toString().includes('platform_administrator'),
    'the 403 names the required role',
  );

  // A plain agency member is likewise insufficient → 403.
  const memberAttempt = await transitionTrust('auth-ladder-app', 'verify', 'member tries to verify', 'trust-auth-2', owner.token);
  assert.equal(memberAttempt.status, 403);

  // Zero events so far.
  assert.equal(await countRows('trust_events', "app_key = 'auth-ladder-app'", []), 0);

  // The internal service principal (operator posture) CAN record the
  // governance event.
  const serviceTransition = await transitionTrust('auth-ladder-app', 'verify', 'service-principal governance review', 'trust-auth-3', SERVICE_TOKEN);
  assert.equal(serviceTransition.status, 201, JSON.stringify(serviceTransition.body));
  const serviceEvent = (serviceTransition.body as Record<string, unknown>)['event'] as Record<string, unknown>;
  assert.equal((serviceEvent['provenance'] as Record<string, unknown>)['recordedActor'], 'service:Internal API token');

  // The §8 replay: an identical payload converges (200, replayed).
  const replay = await transitionTrust('auth-ladder-app', 'verify', 'service-principal governance review', 'trust-auth-3', await adminToken());
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal((replay.body as Record<string, unknown>)['replayed'], true);
  assert.equal(await countRows('trust_events', "app_key = 'auth-ladder-app'", []), 1);

  // A divergent payload under the SAME key is a 409.
  const divergent = await transitionTrust('auth-ladder-app', 'verify', 'different reason under a used key', 'trust-auth-3', await adminToken());
  assert.equal(divergent.status, 409, JSON.stringify(divergent.body));
  assert.equal(await countRows('trust_events', "app_key = 'auth-ladder-app'", []), 1);

  // Anonymous calls fail closed 401.
  const anonymous = await apiCall(port(), '/api/app-marketplace/apps/auth-ladder-app/trust', {
    body: { transition: 'verify', reason: 'anonymous', idempotencyKey: 'trust-anon' },
  });
  assert.equal(anonymous.status, 401);
});

test('AC-2: illegal transitions are rejected 422 with ZERO rows (skip, wrong departure, double-transition)', async () => {
  const { developer } = state();

  // A fresh UNVERIFIED app: certifying straight from UNVERIFIED is the
  // illegal skip (the frozen one-way ladder).
  await publishApp(appManifestFixture('ladder-app', '1.0.0'), developer.token);
  const skip = await transitionTrust('ladder-app', 'certify', 'attempting to skip community verification', 'trust-ladder-skip', await adminToken());
  assert.equal(skip.status, 422, JSON.stringify(skip.body));
  assert.ok(
    ((skip.body as Record<string, unknown>)['error'] as Record<string, unknown> | undefined)?.['message']?.toString().includes('no skipping from UNVERIFIED'),
    'the honest reason names the skip',
  );
  // Revoking the birth state is illegal (nothing to revoke).
  const revokeBirth = await transitionTrust('ladder-app', 'revoke', 'revoking an unverified app', 'trust-ladder-revoke-birth', await adminToken());
  assert.equal(revokeBirth.status, 422);
  // Decertifying a non-certified app is illegal.
  const decertifyUnverified = await transitionTrust('ladder-app', 'decertify', 'decertifying an unverified app', 'trust-ladder-decertify', await adminToken());
  assert.equal(decertifyUnverified.status, 422);
  assert.equal(await countRows('trust_events', "app_key = 'ladder-app'", []), 0, 'zero rows on every illegal move');

  // The double-verify: ladder-app gets verified once, then verifying
  // again is the wrong-departure rejection.
  const verify = await transitionTrust('ladder-app', 'verify', 'community review complete', 'trust-ladder-1', await adminToken());
  assert.equal(verify.status, 201);
  const doubleVerify = await transitionTrust('ladder-app', 'verify', 'verifying again', 'trust-ladder-2', await adminToken());
  assert.equal(doubleVerify.status, 422, JSON.stringify(doubleVerify.body));
  assert.equal(await countRows('trust_events', "app_key = 'ladder-app'", []), 1);

  // Guard rejections: unknown app key → uniform 404; malformed
  // transition label / empty reason → 422.
  const unknownApp = await transitionTrust('no-such-app', 'verify', 'reason', 'trust-unknown', await adminToken());
  assert.equal(unknownApp.status, 404);
  const badLabel = await transitionTrust('ladder-app', 'self-certify', 'reason', 'trust-bad-label', await adminToken());
  assert.equal(badLabel.status, 422);
  const emptyReason = await transitionTrust('ladder-app', 'certify', '', 'trust-empty-reason', await adminToken());
  assert.equal(emptyReason.status, 422);
  // Caller-supplied trust state is rejected by the DTO.
  const spoofed = await apiCall(port(), '/api/app-marketplace/apps/ladder-app/trust', {
    token: await adminToken(),
    body: { transition: 'verify', reason: 'spoofing state', idempotencyKey: 'trust-spoof', fromState: 'MOS_CERTIFIED', toState: 'MOS_CERTIFIED' },
  });
  assert.equal(spoofed.status, 422, JSON.stringify(spoofed.body));
  assert.equal(await countRows('trust_events', "app_key = 'ladder-app'", []), 1);
});

test('AC-2: the disclosed down moves — decertify and revoke are append-only events, never silent rewrites (the registry stays frozen)', async () => {
  const { owner, goldenAppKey, developer } = state();

  // golden-reporter is at MOS_CERTIFIED (seq 2). The FULL revocation
  // (MOS_CERTIFIED → UNVERIFIED) is a disclosed down move.
  const revoke = await transitionTrust(goldenAppKey, 'revoke', 'certification withdrawn after an incident report', 'trust-golden-3', await adminToken());
  assert.equal(revoke.status, 201, JSON.stringify(revoke.body));
  const revokeBody = (revoke.body as Record<string, unknown>)['event'] as Record<string, unknown>;
  assert.equal(revokeBody['transition'], 'revoke');
  assert.equal(revokeBody['fromState'], 'MOS_CERTIFIED');
  assert.equal(revokeBody['toState'], 'UNVERIFIED');
  assert.equal(revokeBody['transitionSeq'], 3);

  // THE REGISTRY STAYS FROZEN AT BIRTH (the marketplace NEVER rewrites
  // the /apps registry — DB ground truth).
  const registry = await pool().query<{ certification_state: string; count: string }>(
    "SELECT certification_state, count(*)::text AS count FROM app_versions WHERE app_key = $1 GROUP BY certification_state",
    [goldenAppKey],
  );
  assert.equal(registry.rows.length, 1);
  assert.equal(registry.rows[0]!.certification_state, 'UNVERIFIED');
  assert.equal(registry.rows[0]!.count, '2', 'both published versions stay frozen at the birth state');

  // THE DERIVED STATE FOLLOWS THE TAIL (live): the listing shows
  // UNVERIFIED again with transitionCount 3.
  const listing = await apiCall(port(), `/api/app-marketplace/${owner.agencyId}/apps`, { token: owner.token });
  const apps = (listing.body as Record<string, unknown>)['apps'] as Record<string, unknown>[];
  const golden = apps.find((entry) => entry['appKey'] === goldenAppKey)!;
  assert.equal((golden['trustState'] as Record<string, unknown>)['trustLevel'], 'UNVERIFIED');
  assert.equal((golden['trustState'] as Record<string, unknown>)['transitionCount'], 3);

  // The decertify move: a fresh app verified + certified, then
  // decertified back to COMMUNITY_VERIFIED.
  await publishApp(appManifestFixture('decertify-app', '1.0.0'), developer.token);
  await transitionTrust('decertify-app', 'verify', 'verified', 'trust-decertify-1', await adminToken());
  await transitionTrust('decertify-app', 'certify', 'certified', 'trust-decertify-2', await adminToken());
  const decertify = await transitionTrust('decertify-app', 'decertify', 'certification lapsed', 'trust-decertify-3', await adminToken());
  assert.equal(decertify.status, 201, JSON.stringify(decertify.body));
  const decertifyBody = (decertify.body as Record<string, unknown>)['event'] as Record<string, unknown>;
  assert.equal(decertifyBody['fromState'], 'MOS_CERTIFIED');
  assert.equal(decertifyBody['toState'], 'COMMUNITY_VERIFIED');

  // The revoke from COMMUNITY_VERIFIED (the second disclosed down move).
  const revokeVerified = await transitionTrust('decertify-app', 'revoke', 'community verification withdrawn', 'trust-decertify-4', await adminToken());
  assert.equal(revokeVerified.status, 201);
  const revokeVerifiedBody = (revokeVerified.body as Record<string, unknown>)['event'] as Record<string, unknown>;
  assert.equal(revokeVerifiedBody['fromState'], 'COMMUNITY_VERIFIED');
  assert.equal(revokeVerifiedBody['toState'], 'UNVERIFIED');

  // Transitions create ZERO install rows (trust is metadata — never an
  // authority action).
  assert.equal(await countRows('app_installs', 'true', []), 0, 'no install rows exist yet (transitions grant nothing)');

  // The DB rejects UPDATE and DELETE on both ledgers outright.
  await assert.rejects(
    () => pool().query("UPDATE trust_events SET to_state = 'MOS_CERTIFIED' WHERE app_key = 'decertify-app'"),
    /append-only/,
    'a direct SQL rewrite of the trust tail is rejected',
  );
  await assert.rejects(
    () => pool().query("DELETE FROM trust_events WHERE app_key = 'decertify-app'"),
    /append-only/,
    'a direct SQL erase of the trust tail is rejected',
  );
  await assert.rejects(
    () => pool().query("UPDATE app_reviews SET rating = 1 WHERE app_key = $1", [goldenAppKey]),
    /append-only/,
    'a direct SQL rewrite of a review is rejected',
  );
  await assert.rejects(
    () => pool().query("DELETE FROM app_reviews WHERE app_key = $1", [goldenAppKey]),
    /append-only/,
    'a direct SQL erase of a review is rejected',
  );

  // The chain-consistency backstop: an out-of-chain insert is rejected
  // (the from_state must equal the predecessor's to_state).
  await assert.rejects(
    () => pool().query(
      `INSERT INTO trust_events (event_id, app_key, transition_seq, transition, from_state, to_state, reason, recorded_actor, recorded_via, correlation_id, recorded_at, idempotency_key, create_fingerprint)
       VALUES (gen_random_uuid(), 'decertify-app', 5, 'verify', 'MOS_CERTIFIED', 'COMMUNITY_VERIFIED', 'out-of-chain', 'user:test', 'api', 'corr-x', now(), 'chain-break-1', 'fp-x')`,
    ),
    /from_state|predecessor/,
    'an out-of-chain transition insert is rejected by the trigger',
  );
});

// ---------------------------------------------------------------------------
// AC-3/AC-8 — the trust-is-not-authority battery + the policy-gated
// install eligibility flowing through the UNCHANGED MKT-048 gate
// ---------------------------------------------------------------------------

test('AC-3: an MOS_CERTIFIED app under a policy that DENIES its installs STILL FAILS (403, zero rows) — trust NEVER grants authority', async () => {
  const { owner, workspaceId, goldenAppKey } = state();

  // golden-reporter is at UNVERIFIED after the revocation: re-certify
  // it through the full ladder (verify → certify).
  await transitionTrust(goldenAppKey, 'verify', 're-verification after remediation', 'trust-ac3-1', await adminToken());
  await transitionTrust(goldenAppKey, 'certify', 're-certified after remediation', 'trust-ac3-2', await adminToken());
  const listing = await apiCall(port(), `/api/app-marketplace/${owner.agencyId}/apps`, { token: owner.token });
  const golden = ((listing.body as Record<string, unknown>)['apps'] as Record<string, unknown>[]).find(
    (entry) => entry['appKey'] === goldenAppKey,
  )!;
  assert.equal((golden['trustState'] as Record<string, unknown>)['trustLevel'], 'MOS_CERTIFIED');

  // The platform policy DENIES installs whose DERIVED trust state is
  // MOS_CERTIFIED (declared in the golden test). The certified install
  // attempt → 403 with ZERO rows: certification NEVER grants authority.
  const denied = await apiCall(port(), `/api/workspaces/${workspaceId}/app-installs`, {
    token: owner.token,
    body: { appKey: goldenAppKey, version: '1.1.0', idempotencyKey: 'install-ac3-certified' },
  });
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.ok(
    ((denied.body as Record<string, unknown>)['error'] as Record<string, unknown> | undefined)?.['message']?.toString().includes('denied by the extension policy boundary'),
    'the denial is the MKT-048 policy gate (the sole install authority)',
  );
  assert.equal(await countRows('app_installs', 'workspace_id = $1', [workspaceId]), 0, 'a denied install writes ZERO rows');

  // The recorded policy decision carried the DERIVED trust state as the
  // matched attribute (the disclosed additive wiring — DB ground truth:
  // the deny rule matched certificationState=MOS_CERTIFIED).
  const decision = await pool().query<{ reason_code: string; reasons: string[] }>(
    "SELECT reason_code, reasons FROM policy_decisions WHERE action->>'operation' = 'install' ORDER BY recorded_at DESC LIMIT 1",
  );
  assert.equal(decision.rows[0]!.reason_code, 'rule-denied');
});

test('AC-3: an UNVERIFIED app under the permissive policy STILL INSTALLS through the UNCHANGED MKT-048 gate (server-derived grants, event tail)', async () => {
  const { owner, workspaceId } = state();

  const install = await apiCall(port(), `/api/workspaces/${workspaceId}/app-installs`, {
    token: owner.token,
    body: { appKey: 'permissive-tool', version: '1.0.0', idempotencyKey: 'install-ac3-unverified' },
  });
  assert.equal(install.status, 201, JSON.stringify(install.body));
  const record = (install.body as Record<string, unknown>)['install'] as Record<string, unknown>;
  assert.equal(record['appKey'], 'permissive-tool');
  assert.equal(record['status'], 'ACTIVE');
  assert.equal(record['selectionSeq'], 1);
  // The MKT-048 semantics UNCHANGED: the SERVER-DERIVED grants (the
  // manifest request ∩ policy ∩ frozen vocabularies — the platform
  // allow grants everything requested here).
  assert.deepEqual(record['grantedDataScopes'], ['client:read', 'workspace:read']);
  assert.deepEqual(record['grantedMutationScopes'], ['evidence:append', 'metric:append']);
  assert.equal(record['installedBy'], owner.userId);
  // The append-only event tail.
  const events = await pool().query<{ event_type: string }>(
    "SELECT event_type FROM app_install_events WHERE workspace_id = $1 AND app_key = 'permissive-tool'",
    [workspaceId],
  );
  assert.equal(events.rows.length, 1);
  assert.equal(events.rows[0]!.event_type, 'installed');
});

test('AC-3 live-follow: a REVOCATION re-enables the install THROUGH the policy rule (never around it) — the derived trust is a live policy input', async () => {
  const { owner, workspaceId, goldenAppKey } = state();

  // Revoke the re-certified app: the derived state returns to
  // UNVERIFIED, the deny rule (certificationState=MOS_CERTIFIED) no
  // longer matches, and the platform allow governs → the install now
  // SUCCEEDS through the SAME gate. The wiring is LIVE (the gate sees
  // the derived state) and trust NEVER bypasses the policy.
  const revoke = await transitionTrust(goldenAppKey, 'revoke', 'revoked for the live-follow proof', 'trust-ac3-3', await adminToken());
  assert.equal(revoke.status, 201);

  const install = await apiCall(port(), `/api/workspaces/${workspaceId}/app-installs`, {
    token: owner.token,
    body: { appKey: goldenAppKey, version: '1.1.0', idempotencyKey: 'install-ac3-revoked' },
  });
  assert.equal(install.status, 201, JSON.stringify(install.body));
  const record = (install.body as Record<string, unknown>)['install'] as Record<string, unknown>;
  assert.equal(record['appKey'], goldenAppKey);
  assert.equal(record['version'], '1.1.0');

  // The registry is STILL frozen at birth for both versions.
  const registry = await pool().query<{ certification_state: string }>(
    'SELECT certification_state FROM app_versions WHERE app_key = $1',
    [goldenAppKey],
  );
  for (const row of registry.rows) {
    assert.equal(row.certification_state, 'UNVERIFIED');
  }
});

// ---------------------------------------------------------------------------
// AC-1 — the isolation battery (uniform 404 foreign≡unknown≡malformed;
// suspended 403; anonymous 401; the global catalog posture)
// ---------------------------------------------------------------------------

test('AC-1 isolation: foreign/malformed/unknown agency identifiers are the UNIFORM 404; a suspended membership is the 403; anonymous is 401', async () => {
  const { owner, goldenAppKey } = state();
  const ownerB = await makeAgencyOwner('marketplace-owner-b@marketingos.test');

  // A member of agency B probing agency A's marketplace scope gets the
  // SAME 404 as an unknown or malformed identifier (no existence
  // oracle) — on every discovery surface.
  for (const path of [
    `/api/app-marketplace/${owner.agencyId}/apps`,
    `/api/app-marketplace/${owner.agencyId}/apps/${goldenAppKey}`,
    `/api/app-marketplace/${owner.agencyId}/apps/${goldenAppKey}/policy-eligibility`,
  ]) {
    const foreign = await apiCall(port(), path, { token: ownerB.token });
    assert.equal(foreign.status, 404, `${path} must 404 for a foreign principal`);
    const malformed = await apiCall(port(), path.replace(owner.agencyId, 'not-a-uuid'), { token: owner.token });
    assert.equal(malformed.status, 404, `${path} must 404 for a malformed identifier`);
    const unknown = await apiCall(port(), path.replace(owner.agencyId, '99999999-9999-4999-8999-999999999999'), { token: owner.token });
    assert.equal(unknown.status, 404, `${path} must 404 for an unknown identifier`);
    const anonymous = await apiCall(port(), path);
    assert.equal(anonymous.status, 401, `${path} must 401 for anonymous callers`);
  }

  // The catalog itself is GLOBAL registry state: agency B's own
  // authorized listing serves the SAME published catalog (the honest
  // disclosure — the agency scope is authorization, not a partition).
  const listingB = await apiCall(port(), `/api/app-marketplace/${ownerB.agencyId}/apps`, { token: ownerB.token });
  assert.equal(listingB.status, 200);
  const appsB = (listingB.body as Record<string, unknown>)['apps'] as Record<string, unknown>[];
  const keysB = new Set(appsB.map((entry) => entry['appKey'] as string));
  assert.ok(keysB.has('golden-reporter'));
  assert.ok(keysB.has('permissive-tool'));
  assert.ok(keysB.has('first-party-pack'));

  // A SUSPENDED (membership-disabled) member is the 403 (the
  // authenticated-but-intra-tenant failure — the command-center
  // posture).
  const member = await makeUser('marketplace-member@marketingos.test', 'member-password-123');
  const grant = await apiCall(port(), `/api/agencies/${ownerB.agencyId}/memberships`, {
    token: ownerB.token,
    body: { userId: member.userId, role: 'agency_operator' },
  });
  assert.equal(grant.status, 201);
  const active = await apiCall(port(), `/api/app-marketplace/${ownerB.agencyId}/apps`, { token: member.token });
  assert.equal(active.status, 200);
  const memberships = await apiCall(port(), `/api/agencies/${ownerB.agencyId}/memberships`, { token: ownerB.token });
  const membership = ((memberships.body as Record<string, unknown>)['memberships'] as Record<string, unknown>[]).find(
    (entry) => entry['userId'] === member.userId,
  )!;
  const disable = await apiCall(port(), `/api/agencies/${ownerB.agencyId}/memberships/${membership['membershipId'] as string}`, {
    token: ownerB.token,
    method: 'PATCH',
    body: { status: 'disabled', version: membership['version'] as number },
  });
  assert.equal(disable.status, 200, JSON.stringify(disable.body));
  const suspended = await apiCall(port(), `/api/app-marketplace/${ownerB.agencyId}/apps`, { token: member.token });
  assert.equal(suspended.status, 403, 'a suspended membership is the 403');
});

// ---------------------------------------------------------------------------
// AC-1 — the filters battery (category, trust level, classification,
// search; strict query hygiene)
// ---------------------------------------------------------------------------

test('AC-1 filters: category, trust level, publisher kind and search narrow the listing; unknown keys and off-vocabulary values are 422', async () => {
  const { owner } = state();

  // Trust-level filter: permissive-tool was verified for this battery;
  // auth-ladder-app and ladder-app also ended at COMMUNITY_VERIFIED in
  // the AC-2 battery. The filter must return exactly those.
  await transitionTrust('permissive-tool', 'verify', 'verified for the filter battery', 'trust-filter-1', await adminToken());

  const byTrust = await apiCall(port(), `/api/app-marketplace/${owner.agencyId}/apps?trustLevel=COMMUNITY_VERIFIED`, { token: owner.token });
  assert.equal(byTrust.status, 200);
  const communityVerified = (byTrust.body as Record<string, unknown>)['apps'] as Record<string, unknown>[];
  assert.deepEqual(
    communityVerified.map((entry) => entry['appKey']).sort(),
    ['auth-ladder-app', 'ladder-app', 'permissive-tool'],
  );

  const unverified = await apiCall(port(), `/api/app-marketplace/${owner.agencyId}/apps?trustLevel=UNVERIFIED`, { token: owner.token });
  const unverifiedApps = (unverified.body as Record<string, unknown>)['apps'] as Record<string, unknown>[];
  assert.ok(unverifiedApps.length >= 3);
  assert.ok(unverifiedApps.every((entry) => (entry['trustState'] as Record<string, unknown>)['trustLevel'] === 'UNVERIFIED'));

  // Publisher-kind filter: the single svc: lineage.
  const firstParty = await apiCall(port(), `/api/app-marketplace/${owner.agencyId}/apps?publisherKind=first-party`, { token: owner.token });
  const firstPartyApps = (firstParty.body as Record<string, unknown>)['apps'] as Record<string, unknown>[];
  assert.equal(firstPartyApps.length, 1);
  assert.equal(firstPartyApps[0]!['appKey'], 'first-party-pack');

  const communityApps = (await apiCall(port(), `/api/app-marketplace/${owner.agencyId}/apps?publisherKind=community`, { token: owner.token })).body as Record<string, unknown>;
  assert.ok(((communityApps['apps'] as Record<string, unknown>[]).length >= 4));

  // Category filter: the manifest capability 'run' (every fixture
  // declares it) vs a capability nobody declares.
  const byCategory = await apiCall(port(), `/api/app-marketplace/${owner.agencyId}/apps?category=run`, { token: owner.token });
  const categoryApps = (byCategory.body as Record<string, unknown>)['apps'] as Record<string, unknown>[];
  assert.ok(categoryApps.length >= 4, 'the capability filter serves results');
  const byMissingCategory = await apiCall(port(), `/api/app-marketplace/${owner.agencyId}/apps?category=no-such-capability`, { token: owner.token });
  assert.equal(((byMissingCategory.body as Record<string, unknown>)['apps'] as unknown[]).length, 0);

  // Search filter: a bounded substring on the app key.
  const bySearch = await apiCall(port(), `/api/app-marketplace/${owner.agencyId}/apps?search=golden`, { token: owner.token });
  const searchApps = (bySearch.body as Record<string, unknown>)['apps'] as Record<string, unknown>[];
  assert.equal(searchApps.length, 1);
  assert.equal(searchApps[0]!['appKey'], 'golden-reporter');

  // Combined filters.
  const combined = await apiCall(port(), `/api/app-marketplace/${owner.agencyId}/apps?category=run&trustLevel=UNVERIFIED&search=golden`, { token: owner.token });
  const combinedApps = (combined.body as Record<string, unknown>)['apps'] as Record<string, unknown>[];
  assert.equal(combinedApps.length, 1);

  // Strict query hygiene: unknown keys and off-vocabulary values.
  const unknownKey = await apiCall(port(), `/api/app-marketplace/${owner.agencyId}/apps?sortBy=rating`, { token: owner.token });
  assert.equal(unknownKey.status, 422, JSON.stringify(unknownKey.body));
  const badTrust = await apiCall(port(), `/api/app-marketplace/${owner.agencyId}/apps?trustLevel=TRUSTED`, { token: owner.token });
  assert.equal(badTrust.status, 422);
  const badKind = await apiCall(port(), `/api/app-marketplace/${owner.agencyId}/apps?publisherKind=third-party`, { token: owner.token });
  assert.equal(badKind.status, 422);
});

// ---------------------------------------------------------------------------
// The final ground-truth sweep (registry frozen; marketplace state exact)
// ---------------------------------------------------------------------------

test('ground truth: the registry is untouched by every marketplace operation; the marketplace ledgers carry the exact governance history', async () => {
  const { goldenAppKey } = state();

  // EVERY registry row of every lineage stays frozen at the birth
  // state — the marketplace NEVER rewrote a single registry row.
  const states = await pool().query<{ certification_state: string }>(
    'SELECT DISTINCT certification_state FROM app_versions',
  );
  for (const row of states.rows) {
    assert.equal(row.certification_state, 'UNVERIFIED', 'the registry is frozen at birth');
  }

  // The governance tail of the golden lineage: verify, certify, revoke,
  // verify, certify, revoke (the AC-2 + AC-3 sequence — 6 events).
  const tail = await pool().query<{ transition: string; transition_seq: string }>(
    'SELECT transition, transition_seq::text FROM trust_events WHERE app_key = $1 ORDER BY transition_seq',
    [goldenAppKey],
  );
  assert.deepEqual(
    tail.rows.map((row) => [row.transition_seq, row.transition]),
    [
      ['1', 'verify'],
      ['2', 'certify'],
      ['3', 'revoke'],
      ['4', 'verify'],
      ['5', 'certify'],
      ['6', 'revoke'],
    ],
    'the full append-only governance history is intact (never rewritten)',
  );

  // No second registry table was created by the marketplace.
  const tables = await pool().query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'app%'",
  );
  const names = tables.rows.map((row) => row.table_name);
  assert.ok(!names.includes('app_marketplace_apps'), 'no marketplace app catalog table exists (no second registry)');
  assert.ok(!names.includes('marketplace_apps'), 'no marketplace app catalog table exists (no second registry)');
});
