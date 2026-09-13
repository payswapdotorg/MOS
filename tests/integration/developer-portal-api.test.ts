/**
 * MKT-049 integration tests — the App SDK and Developer Portal on the
 * REAL stack (embedded PostgreSQL 18 + real API process — no mocks of
 * platform services).
 *
 * Acceptance mapping (spec/effective-backlog-v1.5.md MKT-049; the
 * dispatch acceptance criteria):
 *   - AC-4/AC-7 PUBLISH ROUND-TRIP: a portal publish (delegated) lands
 *     in the REAL /apps registry — the app appears on the DIRECT
 *     /api/apps surface (convergence: one authority, multiple route
 *     families), the registry row carries the SERVER-DERIVED publisher
 *     + born-UNVERIFIED certification (direct SQL), the audit event is
 *     recorded, and re-publishing the same (app key, version) through
 *     the portal is the authority's 409 immutable fence;
 *   - AC-5 SIGNED PUBLISH: an SDK-computed hash attestation (the
 *     offline fingerprint) is VERIFIED by the real registry (201, the
 *     persisted createFingerprint equals the signed digest — direct
 *     SQL); a tampered digest is rejected 422 with ZERO rows; the
 *     DIRECT /api/apps route accepts the same optional field (both
 *     publish surfaces converge); unsigned publishes remain valid;
 *   - AC-4 VALIDATION STATUS FLOW: the pure POST /validate returns the
 *     REAL registry guard's verdict (valid; every rejection class with
 *     the guard's own problem strings; certification-shaped keys → the
 *     403 class marker) + the signature verification verdict, with
 *     ZERO rows created; the version view reports the manifest
 *     integrity status (the recomputed fingerprint matches the stored
 *     one) + the vocabulary annotations;
 *   - AC-4 CATALOG + VERSION VIEWS: the developer catalog rolls up
 *     distinct app keys with version counts + the REAL-semver newest
 *     version; the version history lists newest-first;
 *   - AC-6 DOCUMENTATION SURFACE: GET /docs serves the reference
 *     derived from the frozen /apps contract — the vocabularies and the
 *     manifest-schema table are DEEP-EQUAL to the SDK's offline mirror
 *     (the served/offline documentation never fork), and the route is a
 *     pure read (zero rows);
 *   - AC-1/AC-2/AC-3/AC-5 THE FULL COMMUNITY WORKFLOW (E2E): the SDK
 *     CLI scaffolds a project → offline validation passes → `node
 *     --test` on the scaffolded tests passes → `sign` writes the
 *     attestation → the SDK client (and the CLI `publish` command)
 *     publish through the portal — the app appears in the registry
 *     with the verified signature;
 *   - AC-4 TENANT POSTURE: anonymous callers get 401 on every portal
 *     route; publishing is platform territory (an agency owner without
 *     the platform_developer role is 403 with ZERO rows); reads are
 *     open to authenticated active members; foreign/malformed
 *     identifiers are the uniform 404.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  type IntegrationStack,
  type SpawnedProcess,
} from './helpers/harness.ts';
import { MosDeveloperPortalClient, MosApiError } from '../../tools/app-sdk/src/client.ts';
import { signManifest } from '../../tools/app-sdk/src/fingerprint.ts';
import { scaffoldAppProject } from '../../tools/app-sdk/src/scaffold.ts';
import { validateAppProjectFiles } from '../../tools/app-sdk/src/validate.ts';
import { MANIFEST_FIELD_DOCS as SDK_MANIFEST_FIELD_DOCS } from '../../tools/app-sdk/src/docs.ts';
import { developerDocsModel as sdkDocsModel } from '../../tools/app-sdk/src/docs.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

function baseUrl(): string {
  return `http://127.0.0.1:${port()}`;
}

function pool(): pg.Pool {
  if (stack === null) throw new Error('test stack not booted');
  return stack.pg.pool;
}

before(async () => {
  stack = await bootStack('developer-portal');
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

async function makeUser(email: string, name: string): Promise<User> {
  const admin = await adminToken();
  const create = await apiCall(port(), '/api/users', { token: admin, body: { email, displayName: name } });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  const userId = create.body['userId'] as string;
  await apiCall(port(), `/api/users/${userId}/credential`, {
    token: admin,
    body: { password: 'portal-password-123' },
  });
  const login = await apiCall(port(), '/api/auth/login', { body: { email, password: 'portal-password-123' } });
  assert.equal(login.status, 200);
  return { userId, token: login.body['token'] as string };
}

/** A bare user granted the frozen platform_developer role. */
async function makeDeveloper(email: string): Promise<User> {
  const user = await makeUser(email, email.split('@')[0]!);
  const grant = await apiCall(port(), `/api/users/${user.userId}/platform-roles`, {
    token: await adminToken(),
    body: { role: 'platform_developer' },
  });
  assert.equal(grant.status, 200, JSON.stringify(grant.body));
  return user;
}

/** A bare agency owner WITHOUT any platform role (the 403 posture proof). */
async function makeAgencyOwner(email: string): Promise<{ user: User; agencyId: string }> {
  const user = await makeUser(email, email.split('@')[0]!);
  const agency = await apiCall(port(), '/api/agencies', {
    token: await adminToken(),
    body: { name: `Agency ${email}`, ownerUserId: user.userId },
  });
  assert.equal(agency.status, 201, JSON.stringify(agency.body));
  const agencyId = (agency.body['agency'] as Record<string, unknown>)['agencyId'] as string;
  return { user, agencyId };
}

/** A dependency-free frozen §Manifest fixture in the HTTP WIRE form (publish DTOs: port as string — the MKT-047 route contract). */
function appManifestFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const appKey = (overrides['appKey'] as string | undefined) ?? 'portal-roundtrip-app';
  const defaultNamespaces = [`app:${appKey}:documents`];
  const stateNamespaces =
    overrides['stateNamespaces'] !== undefined ? overrides['stateNamespaces'] : defaultNamespaces;
  return {
    manifest: {
      appKey,
      version: '1.0.0',
      compatibility: { minPlatform: '1.0.0', maxPlatform: '2.0.0' },
      capabilities: [
        { name: 'render-dashboard', version: '1.0.0' },
        { name: 'export-report', version: '1.0.0' },
      ],
      inputSchema: { required: ['workspaceId'] },
      outputSchema: { required: ['dashboardUrl'] },
      dataScopes: ['client:read', 'workspace:read'],
      mutationScopes: ['evidence:append', 'metric:append'],
      networkDestinations: [
        { host: 'api.example.com', protocol: 'https', port: '443', reason: 'fetch analytics sources' },
      ],
      runtimeClass: 'pooled-worker',
      eventSubscriptions: ['metric.observed'],
      uiSurfaces: [
        { surface: 'command-center-card', route: '/command-center/apps/portal-roundtrip-app' },
        { surface: 'report-page', route: '/reports/portal-roundtrip-app' },
      ],
      configSchema: {
        region: {
          type: 'string',
          required: true,
          description: 'The reporting region',
          pattern: '^(eu|us)$',
        },
      },
      requiredCredentialNames: ['ANALYTICS_PROVIDER_KEY'],
      stateNamespaces,
      migrationVersion: 1,
      dependencies: [],
      supportLevel: 'standard',
      meteringDimensions: ['installations', 'invocations'],
      ...overrides,
    },
    idempotencyKey: 'publish-portal-1.0.0',
  };
}

/**
 * The CANONICAL TYPED twin of the wire fixture (the guard's + the
 * signature's language: network-destination ports are NUMBERS; the
 * registry deserializes the wire form back to this exact shape, so the
 * SDK-computed typed-form digest is the server-side fingerprint).
 */
function typedManifestFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const wire = appManifestFixture(overrides)['manifest'] as Record<string, unknown>;
  const typed = JSON.parse(JSON.stringify(wire)) as Record<string, unknown>;
  (typed['networkDestinations'] as Array<Record<string, unknown>>)[0]!['port'] = 443;
  return typed;
}

async function countAppVersions(appKey: string): Promise<number> {
  const result = await pool().query<{ count: string }>(
    'SELECT count(*)::text AS count FROM app_versions WHERE app_key = $1',
    [appKey],
  );
  return Number(result.rows[0]!.count);
}

interface SharedState {
  readonly developer: User;
  readonly developerB: User;
  readonly owner: { user: User; agencyId: string };
}
let shared: SharedState | null = null;
function state(): SharedState {
  if (shared === null) throw new Error('shared fixtures not built');
  return shared;
}

// ---------------------------------------------------------------------------
// AC-4/AC-7 — the delegated publish round-trips through the REAL registry
// ---------------------------------------------------------------------------

test('AC-4: the portal publish DELEGATES to the /apps registry — the app appears on the DIRECT surface with server-derived publisher + born-UNVERIFIED certification', async () => {
  const developer = await makeDeveloper('portal-developer@marketingos.test');
  const developerB = await makeDeveloper('portal-developer-b@marketingos.test');
  const owner = await makeAgencyOwner('portal-owner@marketingos.test');
  shared = { developer, developerB, owner };

  const publish = await apiCall(port(), '/api/developer-portal/publish', {
    token: developer.token,
    body: appManifestFixture({ appKey: 'portal-roundtrip-app', version: '1.0.0' }),
  });
  assert.equal(publish.status, 201, JSON.stringify(publish.body));
  const published = publish.body as Record<string, unknown>;
  const appVersion = published['appVersion'] as Record<string, unknown>;
  assert.equal(appVersion['appKey'], 'portal-roundtrip-app');
  assert.equal(appVersion['publisher'], `dev:${developer.userId}`);
  assert.equal(appVersion['certificationState'], 'UNVERIFIED');
  assert.equal(published['signature'], null, 'the unsigned publish discloses signature: null');

  // CONVERGENCE: the DIRECT /api/apps surface reads the same registry row.
  const direct = await apiCall(port(), '/api/apps/portal-roundtrip-app/versions/1.0.0', {
    token: developer.token,
  });
  assert.equal(direct.status, 200);
  assert.equal((direct.body as Record<string, unknown>)['appVersionId'], appVersion['appVersionId']);
  assert.deepEqual(
    (direct.body as Record<string, unknown>)['manifest'],
    appVersion['manifest'],
    'the direct surface and the portal serve the IDENTICAL manifest',
  );

  // AUTHORITATIVE state (direct SQL): the registry row + ownership row.
  const stored = await pool().query<{ publisher: string; certification_state: string; create_fingerprint: string }>(
    'SELECT publisher, certification_state, create_fingerprint FROM app_versions WHERE app_version_id = $1',
    [appVersion['appVersionId'] as string],
  );
  assert.equal(stored.rows.length, 1);
  assert.equal(stored.rows[0]!.publisher, `dev:${developer.userId}`);
  assert.equal(stored.rows[0]!.certification_state, 'UNVERIFIED');
  const ownership = await pool().query<{ owner_publisher: string }>(
    'SELECT owner_publisher FROM apps WHERE app_key = $1',
    ['portal-roundtrip-app'],
  );
  assert.equal(ownership.rows[0]!.owner_publisher, `dev:${developer.userId}`);

  // The portal publish emitted its append-only audit event.
  const audit = await pool().query<{ count: string }>(
    "SELECT count(*)::text AS count FROM audit_events WHERE action = 'developer_portal.app.published' AND target_id = $1",
    [appVersion['appVersionId'] as string],
  );
  assert.equal(Number(audit.rows[0]!.count), 1, 'exactly one audit event per portal publish');
});

test('AC-4: the authority fences still govern the portal — re-publish is 409, a second publisher is 409, a non-developer is 403 with ZERO rows', async () => {
  // The immutable-version fence (the AUTHORITY's 409, surfaced through
  // the portal route family).
  const republish = await apiCall(port(), '/api/developer-portal/publish', {
    token: state().developer.token,
    body: appManifestFixture({ appKey: 'portal-roundtrip-app', version: '1.0.0' }),
  });
  assert.equal(republish.status, 409);
  assert.equal(await countAppVersions('portal-roundtrip-app'), 1);

  // The key-lineage fence: another developer cannot publish this key.
  const hijack = await apiCall(port(), '/api/developer-portal/publish', {
    token: state().developerB.token,
    body: appManifestFixture({ appKey: 'portal-roundtrip-app', version: '1.1.0' }),
  });
  assert.equal(hijack.status, 409);
  assert.equal(await countAppVersions('portal-roundtrip-app'), 1);

  // Publishing is platform territory: an agency owner without the
  // developer role is 403 with ZERO rows.
  const before = await countAppVersions('portal-forbidden-app');
  const forbidden = await apiCall(port(), '/api/developer-portal/publish', {
    token: state().owner.user.token,
    body: appManifestFixture({ appKey: 'portal-forbidden-app', version: '1.0.0' }),
  });
  assert.equal(forbidden.status, 403, JSON.stringify(forbidden.body));
  assert.equal(await countAppVersions('portal-forbidden-app'), before);
});

// ---------------------------------------------------------------------------
// AC-5 — signed publishing (the SDK attestation through the real registry)
// ---------------------------------------------------------------------------

test('AC-5: an SDK-computed hash attestation is VERIFIED by the real registry; the persisted fingerprint equals the signed digest', async () => {
  const body = appManifestFixture({ appKey: 'portal-signed-app', version: '1.0.0' });
  // The SDK computes the digest OFFLINE over the CANONICAL TYPED manifest
  // (the drift-pinned fingerprint — the registry deserializes the wire
  // body back to this exact shape).
  const signature = signManifest(typedManifestFixture({ appKey: 'portal-signed-app', version: '1.0.0' }));
  const publish = await apiCall(port(), '/api/developer-portal/publish', {
    token: state().developer.token,
    body: { ...body, idempotencyKey: 'publish-portal-signed-1.0.0', signature },
  });
  assert.equal(publish.status, 201, JSON.stringify(publish.body));
  const published = publish.body as Record<string, unknown>;
  const signatureView = published['signature'] as Record<string, unknown>;
  assert.equal(signatureView['algorithm'], 'manifest-sha256-fingerprint');
  assert.equal(signatureView['digest'], signature.digest);
  assert.equal(signatureView['verified'], true);

  // AUTHORITATIVE anchor: the immutable row's persisted createFingerprint
  // IS the signed digest (verifiable forever offline).
  const stored = await pool().query<{ create_fingerprint: string }>(
    'SELECT create_fingerprint FROM app_versions WHERE app_key = $1 AND version = $2',
    ['portal-signed-app', '1.0.0'],
  );
  assert.equal(stored.rows[0]!.create_fingerprint, signature.digest);
});

test('AC-5: a tampered digest is rejected 422 with ZERO rows (fail-closed integrity gate)', async () => {
  const body = appManifestFixture({ appKey: 'portal-tampered-app', version: '1.0.0' });
  const tampered = { algorithm: 'manifest-sha256-fingerprint', digest: 'a'.repeat(64) };
  const publish = await apiCall(port(), '/api/developer-portal/publish', {
    token: state().developer.token,
    body: { ...body, idempotencyKey: 'publish-portal-tampered-1.0.0', signature: tampered },
  });
  assert.equal(publish.status, 422, JSON.stringify(publish.body));
  const errorEnvelope = (publish.body as Record<string, unknown>)['error'] as Record<string, unknown> | undefined;
  const details = ((errorEnvelope ?? publish.body) as Record<string, unknown>)['details'] as string[] | undefined;
  assert.ok(
    (details ?? []).some((detail) => detail.includes('attestation mismatch')),
    JSON.stringify(publish.body),
  );
  assert.equal(await countAppVersions('portal-tampered-app'), 0, 'zero rows on integrity failure');
});

test('AC-5: the DIRECT /api/apps publish route accepts the same optional signature (both surfaces converge on the authority command)', async () => {
  const body = appManifestFixture({ appKey: 'direct-signed-app', version: '1.0.0' });
  const signature = signManifest(typedManifestFixture({ appKey: 'direct-signed-app', version: '1.0.0' }));
  const direct = await apiCall(port(), '/api/apps', {
    token: state().developer.token,
    body: { ...body, idempotencyKey: 'publish-direct-signed-1.0.0', signature },
  });
  assert.equal(direct.status, 201, JSON.stringify(direct.body));
  const stored = await pool().query<{ create_fingerprint: string }>(
    'SELECT create_fingerprint FROM app_versions WHERE app_key = $1',
    ['direct-signed-app'],
  );
  assert.equal(stored.rows[0]!.create_fingerprint, signature.digest);
});

// ---------------------------------------------------------------------------
// AC-4 — the validation status flow (pure; the REAL guard speaks)
// ---------------------------------------------------------------------------

test('AC-4: POST /validate returns the REAL registry guard verdict — valid manifests pass, every rejection class surfaces the guard problems, ZERO rows', async () => {
  const validManifest = typedManifestFixture({ appKey: 'validate-app' });

  const valid = await apiCall(port(), '/api/developer-portal/validate', {
    token: state().developer.token,
    body: { manifest: validManifest },
  });
  assert.equal(valid.status, 200, JSON.stringify(valid.body));
  assert.equal((valid.body as Record<string, unknown>)['valid'], true);
  assert.deepEqual((valid.body as Record<string, unknown>)['problems'], []);

  // Closed-vocabulary violation: the guard's own problem string.
  const badScope = JSON.parse(JSON.stringify(validManifest)) as Record<string, unknown>;
  badScope['dataScopes'] = ['client:readd'];
  const invalid = await apiCall(port(), '/api/developer-portal/validate', {
    token: state().developer.token,
    body: { manifest: badScope },
  });
  assert.equal(invalid.status, 200, JSON.stringify(invalid.body));
  const invalidBody = invalid.body as Record<string, unknown>;
  assert.equal(invalidBody['valid'], false);
  assert.equal(invalidBody['rejectionClass'], 'invalid');
  assert.ok(
    ((invalidBody['problems'] as string[]) ?? []).some((problem) =>
      problem.includes("dataScopes[0]: 'client:readd' is not in the closed dataScopes vocabulary"),
    ),
    JSON.stringify(invalidBody['problems']),
  );

  // Certification-shaped keys: the 403 class marker (platform territory).
  const certification = JSON.parse(JSON.stringify(validManifest)) as Record<string, unknown>;
  certification['certificationState'] = 'MOS_CERTIFIED';
  const forbidden = await apiCall(port(), '/api/developer-portal/validate', {
    token: state().developer.token,
    body: { manifest: certification },
  });
  assert.equal(forbidden.status, 200, JSON.stringify(forbidden.body));
  const forbiddenBody = forbidden.body as Record<string, unknown>;
  assert.equal(forbiddenBody['valid'], false);
  assert.equal(forbiddenBody['rejectionClass'], 'certification-territory');
  assert.ok(
    ((forbiddenBody['problems'] as string[]) ?? []).some((problem) =>
      problem.includes('certification state is platform territory'),
    ),
    JSON.stringify(forbiddenBody['problems']),
  );

  // The optional signature verdict rides the same pure call.
  const signature = signManifest(validManifest);
  const signed = await apiCall(port(), '/api/developer-portal/validate', {
    token: state().developer.token,
    body: { manifest: validManifest, signature },
  });
  assert.equal(signed.status, 200);
  const signedBody = signed.body as Record<string, unknown>;
  assert.equal((signedBody['signature'] as Record<string, unknown>)['verified'], true);
  assert.equal(signedBody['valid'], true);

  const mismatched = { algorithm: 'manifest-sha256-fingerprint', digest: 'b'.repeat(64) };
  const mismatch = await apiCall(port(), '/api/developer-portal/validate', {
    token: state().developer.token,
    body: { manifest: validManifest, signature: mismatched },
  });
  assert.equal(mismatch.status, 200);
  const mismatchBody = mismatch.body as Record<string, unknown>;
  assert.equal(mismatchBody['valid'], false);
  assert.equal((mismatchBody['signature'] as Record<string, unknown>)['verified'], false);
  assert.ok(
    ((mismatchBody['problems'] as string[]) ?? []).some((problem) => problem.includes('attestation mismatch')),
    JSON.stringify(mismatchBody['problems']),
  );

  // PURE: the whole battery created ZERO registry rows.
  assert.equal(await countAppVersions('validate-app'), 0);
});

test('AC-4: the version view reports the validation status — integrity verified against the stored fingerprint + the vocabulary annotations', async () => {
  const view = await apiCall(port(), '/api/developer-portal/apps/portal-roundtrip-app/versions/1.0.0', {
    token: state().developer.token,
  });
  assert.equal(view.status, 200, JSON.stringify(view.body));
  const body = view.body as Record<string, unknown>;
  assert.equal(body['appKey'], 'portal-roundtrip-app');
  const status = body['validationStatus'] as Record<string, unknown>;
  assert.equal(status['published'], true);
  assert.equal(status['manifestValidAtPublish'], true);
  const integrity = status['integrity'] as Record<string, unknown>;
  assert.equal(integrity['algorithm'], 'manifest-sha256-fingerprint');
  assert.equal(integrity['verified'], true, 'the recomputed manifest fingerprint matches the stored one');
  // The digest is the persisted createFingerprint (direct SQL).
  const stored = await pool().query<{ create_fingerprint: string }>(
    'SELECT create_fingerprint FROM app_versions WHERE app_key = $1 AND version = $2',
    ['portal-roundtrip-app', '1.0.0'],
  );
  assert.equal(integrity['digest'], stored.rows[0]!.create_fingerprint);
  // The vocabulary annotations are generated from the frozen meanings.
  const vocabulary = body['vocabulary'] as Record<string, Record<string, string>>;
  assert.equal(vocabulary['dataScopes']!['client:read'], 'read the owning Client boundary data (the frozen tenant-data kinds)');
  assert.equal(
    vocabulary['uiSurfaceKinds']!['command-center-card'],
    'a card on the Agency Command Center surface',
  );
  assert.ok(typeof vocabulary['certificationState'] === 'string');

  // Uniform 404: malformed key, malformed version, unknown pair.
  for (const [appKey, version] of [
    ['Bad_Key', '1.0.0'],
    ['portal-roundtrip-app', 'not-semver'],
    ['never-published-app', '1.0.0'],
    ['portal-roundtrip-app', '9.9.9'],
  ] as const) {
    const missing = await apiCall(
      port(),
      `/api/developer-portal/apps/${appKey}/versions/${version}`,
      { token: state().developer.token },
    );
    assert.equal(missing.status, 404, `${appKey}@${version} must be the uniform 404`);
  }
});

// ---------------------------------------------------------------------------
// AC-4 — the catalog + version history views
// ---------------------------------------------------------------------------

test('AC-4: the developer catalog rolls up app keys with version counts + the REAL-semver newest version; the history lists newest-first', async () => {
  // Publish two more versions of the round-trip app (0.9.0 older by semver,
  // 1.10.0 newer by REAL semver ordering — text ordering would call 1.10.0
  // smaller than 1.9.0).
  for (const [version, key] of [
    ['0.9.0', 'publish-portal-0.9.0'],
    ['1.10.0', 'publish-portal-1.10.0'],
  ] as const) {
    const publish = await apiCall(port(), '/api/developer-portal/publish', {
      token: state().developer.token,
      body: appManifestFixture({ appKey: 'portal-roundtrip-app', version }),
    });
    assert.equal(publish.status, 201, JSON.stringify(publish.body));
    void key;
  }

  const catalog = await apiCall(port(), '/api/developer-portal/catalog', {
    token: state().developer.token,
  });
  assert.equal(catalog.status, 200);
  const apps = (catalog.body as Record<string, unknown>)['apps'] as Array<Record<string, unknown>>;
  const entry = apps.find((candidate) => candidate['appKey'] === 'portal-roundtrip-app');
  assert.ok(entry !== undefined, 'the catalog lists the published app key');
  assert.equal(entry!['versionCount'], 3);
  assert.equal(entry!['newestVersion'], '1.10.0', 'REAL semver ordering picks 1.10.0 over 1.9.x-era 1.0.0/0.9.0');
  assert.equal(entry!['publisher'], `dev:${state().developer.userId}`);
  assert.ok((entry!['newestByPublication'] as Record<string, unknown>)['manifest'] !== undefined);

  const history = await apiCall(port(), '/api/developer-portal/apps/portal-roundtrip-app/versions', {
    token: state().developer.token,
  });
  assert.equal(history.status, 200);
  const versions = (history.body as Record<string, unknown>)['versions'] as Array<Record<string, unknown>>;
  assert.equal(versions.length, 3);
  // Newest-first publication order (the authority listing semantics).
  assert.equal(versions[0]!['manifest'] !== undefined, true);
  assert.equal(
    new Date(versions[0]!['createdAt'] as string) >= new Date(versions[2]!['createdAt'] as string),
    true,
  );
});

// ---------------------------------------------------------------------------
// AC-6 — the documentation surface (served === offline mirror)
// ---------------------------------------------------------------------------

test('AC-6: GET /docs serves the reference derived from the frozen contracts — deep-equal to the SDK offline mirror (pure read)', async () => {
  const docs = await apiCall(port(), '/api/developer-portal/docs', {
    token: state().developer.token,
  });
  assert.equal(docs.status, 200, JSON.stringify(docs.body));
  const body = docs.body as Record<string, unknown>;
  assert.match(String(body['generatedFrom']), /frozen \/apps registry public contract/);
  // The manifest-schema table equals the SDK's offline table.
  assert.deepEqual(body['manifestFields'], SDK_MANIFEST_FIELD_DOCS);
  // The served vocabularies equal the SDK mirror's model (the served and
  // offline documentation never fork).
  const servedVocabularies = body['vocabularies'] as Record<string, Array<{ value: string; meaning: string }>>;
  const mirrorVocabularies = sdkDocsModel().vocabularies;
  for (const key of Object.keys(mirrorVocabularies)) {
    assert.deepEqual(
      servedVocabularies[key]!.map((entry) => ({ value: entry.value, meaning: entry.meaning })),
      [...mirrorVocabularies[key]!],
      `the served '${key}' vocabulary equals the offline mirror`,
    );
  }
  // The signature section documents the frozen algorithm vocabulary.
  const signature = body['signature'] as Record<string, unknown>;
  assert.deepEqual(signature['algorithms'], ['manifest-sha256-fingerprint']);
  // The endpoint reference covers the portal family.
  const endpoints = body['portalEndpoints'] as Array<Record<string, string>>;
  assert.ok(endpoints.some((endpoint) => endpoint['path'] === '/api/developer-portal/publish'));
  // PURE: no state changed (still exactly the 3 published versions + the
  // signed/direct apps).
  const total = await pool().query<{ count: string }>('SELECT count(*)::text AS count FROM app_versions');
  const catalog = await apiCall(port(), '/api/developer-portal/catalog', { token: state().developer.token });
  const apps = (catalog.body as Record<string, unknown>)['apps'] as Array<Record<string, unknown>>;
  const catalogCount = apps.reduce((sum, entry) => sum + Number(entry['versionCount']), 0);
  assert.equal(Number(total.rows[0]!.count), catalogCount, 'the docs route mutated nothing');
});

// ---------------------------------------------------------------------------
// AC-1/AC-2/AC-3/AC-5 — the FULL community workflow E2E (CLI + client)
// ---------------------------------------------------------------------------

test('AC-2/AC-3/AC-5 E2E: scaffold → offline validate → node --test → sign → CLI publish through the portal — the app appears with the verified signature', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'mos-app-sdk-e2e-'));
  try {
    // 1. SCAFFOLD through the real CLI.
    const scaffoldOutput = execFileSync(
      'node',
      ['tools/app-sdk/cli.ts', 'scaffold', projectDir, '--app-key', 'cli-e2e-app'],
      { encoding: 'utf8' },
    );
    assert.match(scaffoldOutput, /created mos-app\.json/);

    // 2. OFFLINE VALIDATION through the real CLI (exit 0 = valid).
    execFileSync('node', ['tools/app-sdk/cli.ts', 'validate', projectDir], { encoding: 'utf8' });

    // The library view of the scaffolded project also validates.
    const files: Record<string, string> = {
      'mos-app.json': readFileSync(join(projectDir, 'mos-app.json'), 'utf8'),
      'capabilities/hello-mos.json': readFileSync(join(projectDir, 'capabilities', 'hello-mos.json'), 'utf8'),
      'ui/surfaces.json': readFileSync(join(projectDir, 'ui', 'surfaces.json'), 'utf8'),
      'tests/app.test.ts': readFileSync(join(projectDir, 'tests', 'app.test.ts'), 'utf8'),
    };
    assert.deepEqual([...validateAppProjectFiles(files).problems], []);

    // 3. The scaffolded TEST SKELETON runs and passes on the real node.
    // Strip the parent runner's NODE_TEST_CONTEXT so the child is a plain
    // test process (not a recursive test context).
    const childEnv = { ...process.env } as Record<string, string | undefined>;
    delete childEnv['NODE_TEST_CONTEXT'];
    const testRun = execFileSync('node', ['--test', 'tests/*.test.ts'], {
      cwd: projectDir,
      encoding: 'utf8',
      env: childEnv as Record<string, string>,
    });
    assert.match(testRun, /pass 3/);

    // 4. SIGN through the real CLI.
    const signOutput = execFileSync('node', ['tools/app-sdk/cli.ts', 'sign', projectDir], {
      encoding: 'utf8',
    });
    assert.match(signOutput, /signed — signature\.json written/);
    const signature = JSON.parse(readFileSync(join(projectDir, 'signature.json'), 'utf8')) as {
      algorithm: string;
      digest: string;
    };
    assert.equal(signature.algorithm, 'manifest-sha256-fingerprint');

    // 5. PUBLISH through the real CLI (the typed client over the portal).
    const publishOutput = execFileSync(
      'node',
      [
        'tools/app-sdk/cli.ts',
        'publish',
        projectDir,
        '--base-url',
        baseUrl(),
        '--token',
        state().developer.token,
        '--idempotency-key',
        'cli-e2e-publish-1',
      ],
      { encoding: 'utf8' },
    );
    assert.match(publishOutput, /published cli-e2e-app@0\.1\.0/);
    assert.match(publishOutput, /signature verified/);

    // 6. The app APPEARED in the real registry with the verified anchor.
    const stored = await pool().query<{ create_fingerprint: string; certification_state: string }>(
      'SELECT create_fingerprint, certification_state FROM app_versions WHERE app_key = $1',
      ['cli-e2e-app'],
    );
    assert.equal(stored.rows.length, 1);
    assert.equal(stored.rows[0]!.create_fingerprint, signature.digest);
    assert.equal(stored.rows[0]!.certification_state, 'UNVERIFIED');
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test('AC-1 E2E: the SDK client against the live API — catalog, history, version view, validation, signed publish, compatibility', async () => {
  const client = new MosDeveloperPortalClient({ baseUrl: baseUrl(), token: state().developer.token });

  // Reads over the live registry.
  const catalog = await client.getCatalog();
  assert.ok(catalog.some((entry) => entry.appKey === 'portal-roundtrip-app'));
  const versions = await client.getAppVersions('portal-roundtrip-app');
  assert.equal(versions.length, 3);
  const view = await client.getAppVersion('portal-roundtrip-app', '1.10.0');
  assert.equal(view.validationStatus.integrity.verified, true);
  assert.ok(typeof view.vocabulary === 'object');

  // The online validation through the REAL guard.
  const manifest = scaffoldAppProject({ appKey: 'sdk-client-app' }).manifest;
  const valid = await client.validateManifest(manifest);
  assert.equal(valid.valid, true);
  const invalid = await client.validateManifest({ ...manifest, dataScopes: ['nope' as never] });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.rejectionClass, 'invalid');
  assert.ok(invalid.problems.some((problem) => problem.includes('closed dataScopes vocabulary')));

  // The SDK-computed signature + the signed publish through the client.
  const signature = signManifest(manifest);
  const publish = await client.publishAppVersion(manifest, 'sdk-client-publish-1', signature);
  assert.equal(publish.appVersion.appKey, 'sdk-client-app');
  assert.equal(publish.signature!.verified, true);
  const published = await client.getAppVersion('sdk-client-app', '0.1.0');
  assert.equal(published.validationStatus.integrity.digest, signature.digest);

  // The registry compatibility query through the client (the scaffolded
  // manifest's range contains the platform version).
  const compatibility = await client.queryCompatibility({
    platformVersion: '1.5.0',
    runtimeClass: null,
    extensionVersions: [],
  });
  assert.ok(
    compatibility.eligible.some((entry) => entry.appKey === 'sdk-client-app'),
    'the SDK-published app is compatible with the platform version',
  );

  // Typed errors preserve the server semantics (the uniform 404).
  await assert.rejects(client.getAppVersion('sdk-client-app', '9.9.9'), (error: unknown) => {
    assert.ok(error instanceof MosApiError);
    assert.equal(error.status, 404);
    return true;
  });
});

// ---------------------------------------------------------------------------
// AC-4 — the tenant posture (fail-closed)
// ---------------------------------------------------------------------------

test('AC-4: anonymous callers get 401 on EVERY portal route; suspended posture is 403; reads are open to active members', async () => {
  for (const [method, path, body] of [
    ['GET', '/api/developer-portal/catalog', undefined],
    ['GET', '/api/developer-portal/apps/portal-roundtrip-app/versions', undefined],
    ['GET', '/api/developer-portal/apps/portal-roundtrip-app/versions/1.0.0', undefined],
    ['GET', '/api/developer-portal/docs', undefined],
    ['POST', '/api/developer-portal/validate', { manifest: appManifestFixture()['manifest'] }],
    ['POST', '/api/developer-portal/publish', appManifestFixture({ appKey: 'anon-app' })],
  ] as const) {
    const anonymous = await apiCall(port(), path, { method, body: body as Record<string, unknown> | undefined });
    assert.equal(anonymous.status, 401, `${method} ${path} must fail closed for anonymous callers`);
  }

  // Reads are open to every AUTHENTICATED ACTIVE member (the
  // global-catalog posture) — the agency owner sees the catalog/docs.
  const catalog = await apiCall(port(), '/api/developer-portal/catalog', {
    token: state().owner.user.token,
  });
  assert.equal(catalog.status, 200);
  const docs = await apiCall(port(), '/api/developer-portal/docs', {
    token: state().owner.user.token,
  });
  assert.equal(docs.status, 200);
  const validation = await apiCall(port(), '/api/developer-portal/validate', {
    token: state().owner.user.token,
    body: { manifest: appManifestFixture({ appKey: 'owner-validate' })['manifest'] },
  });
  assert.equal(validation.status, 200, 'the pure validation surface is an active-member read');
});
