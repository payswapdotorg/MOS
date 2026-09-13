/**
 * MKT-047 integration tests — the App registry (App Manifest and
 * Packaging v1) on the real stack (embedded PostgreSQL 18 + real API
 * process — no mocks of platform services).
 *
 * Acceptance mapping (spec/effective-backlog-v1.5.md MKT-047; the
 * dispatch acceptance criteria AC-2..AC-9):
 *   - AC-2/AC-9 GOLDEN PUBLISH: a fully-declared frozen §Manifest
 *     manifest publishes an immutable App Version; the read-back by
 *     (app key, EXACT version) returns the manifest VERBATIM; the
 *     version history by app key lists every version newest-first; a
 *     new version is a new record; the registry row carries the
 *     SERVER-DERIVED publisher identity (dev:<userId>) and the
 *     born-UNVERIFIED certification state (verified by direct SQL);
 *     every publish emits an append-only audit event;
 *   - AC-4 IMMUTABILITY BATTERY: re-publishing the same app key +
 *     semantic version is a 409 with ZERO new rows; there is NO update
 *     or delete route (every mutating verb 405s at the router); direct
 *     SQL UPDATE and DELETE on published manifests are REJECTED by the
 *     database triggers — including an UPDATE that only touches
 *     certification_state (trust cannot be forged even by direct SQL);
 *   - AC-3/AC-5 DTO GUARD BATTERY: authority-shaped keys (publisher
 *     spoofing, registry identity, provenance), tenant identity keys
 *     and certification-shaped keys are rejected 422 at the route with
 *     ZERO rows; secret-shaped VALUES anywhere in the manifest are
 *     rejected 422 with ZERO rows (the module-level 403 for
 *     certification territory is proven by the unit battery);
 *   - AC-6 DEPENDENCY VALIDATION: a dependency on a MISSING extension
 *     is rejected 422; a dependency on a PUBLISHED extension with an
 *     INCOMPATIBLE range is rejected 422; an app-owned state namespace
 *     claiming a core-authority namespace (workflow) is rejected 422; a
 *     dependency on a missing app is rejected 422; a self-dependency is
 *     rejected 422; a VALID extension dependency publishes and records
 *     the app_dependencies row (verified by direct SQL, re-fenced by
 *     the migration-037 trigger);
 *   - AC-5 CERTIFICATION TERRITORY: every developer publish is born
 *     UNVERIFIED (direct SQL + the read surface); a manifest carrying
 *     certificationState is rejected with zero rows;
 *   - AC-8 COMPATIBILITY QUERY: given the runtime platform version +
 *     available extension versions, the eligible app versions are
 *     returned with honest per-version ineligibility reasons (range,
 *     runtime class, dependency satisfaction);
 *   - AC-9 CONCURRENCY: concurrent same-version publishes yield
 *     EXACTLY ONE winner (one 201, seven 409s, one row);
 *   - AC-8/AC-9 TENANT POSTURE: anonymous callers get 401 on every
 *     route; publishing is platform territory (an agency owner without
 *     the platform_developer role is 403); reads are open to
 *     authenticated active members; the app-key ownership lineage
 *     fence rejects a second publisher (409).
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
  stack = await bootStack('apps');
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
    body: { password: 'apps-password-123' },
  });
  const login = await apiCall(port(), '/api/auth/login', { body: { email, password: 'apps-password-123' } });
  assert.equal(login.status, 200);
  return { userId, token: login.body['token'] as string };
}

/** A bare user granted the frozen platform_developer role (MKT-032 precedent). */
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

/** Publishes one extension version into the /extensions registry (the dependency target). */
async function publishExtension(version: string): Promise<void> {
  const publish = await apiCall(port(), '/api/extensions', {
    token: await adminToken(),
    body: {
      manifest: {
        extensionKey: 'audience-enricher',
        publisher: 'payswap-labs',
        version,
        compatibility: { minPlatform: '1.0.0', maxPlatform: '2.0.0' },
        capabilities: [{ category: 'data-source', name: 'enrich-audience' }],
        permissions: [{ action: 'data:read' }, { action: 'secret:use' }],
        requiredSecretNames: ['DATA_PROVIDER_KEY'],
        dataScopes: ['client:read'],
        networkRequirements: [],
        runtimeClass: 'pooled-worker',
        inputContract: { required: ['audienceId'] },
        outputContract: { required: ['enrichedCount'] },
        eventSubscriptions: [],
        uiSurfaces: [],
        configContract: {},
      },
      idempotencyKey: `apps-dep-${version}`,
    },
  });
  assert.equal(publish.status, 201, JSON.stringify(publish.body));
}

/**
 * The frozen §Manifest fixture (one immutable published App Version).
 * The app-owned state namespaces always claim the OVERRIDDEN app's own
 * key (the namespace guard rejects foreign-key claims — AC-6).
 */
function appManifestFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const appKey = (overrides['appKey'] as string | undefined) ?? 'agency-analytics';
  const defaultNamespaces = [`app:${appKey}:spreadsheets`];
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
        { surface: 'command-center-card', route: '/command-center/apps/agency-analytics' },
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
      dependencies: [
        {
          kind: 'extension',
          publisher: 'payswap-labs',
          key: 'audience-enricher',
          minVersion: '1.0.0',
          maxVersion: '2.0.0',
        },
      ],
      supportLevel: 'standard',
      meteringDimensions: ['installations', 'invocations'],
      ...overrides,
    },
    idempotencyKey: 'publish-apps-1.0.0',
  };
}

/** Deep-writable copy for negative payloads. */
function writable(fixture: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(fixture)) as Record<string, unknown>;
}

async function countAppVersions(appKey: string): Promise<number> {
  const result = await pool().query<{ count: string }>(
    'SELECT count(*)::text AS count FROM app_versions WHERE app_key = $1',
    [appKey],
  );
  return Number(result.rows[0]!.count);
}

// Shared state built once in the first tests (creation order matters).
interface SharedState {
  readonly developer: User;
  readonly developerB: User;
  readonly owner: User;
  readonly agencyId: string;
  readonly appV1Id: string;
  readonly appV11Id: string;
}
let shared: SharedState | null = null;
function state(): SharedState {
  if (shared === null) throw new Error('shared fixtures not built');
  return shared;
}

// ---------------------------------------------------------------------------
// AC-2/AC-9 — the golden publish → read-back verbatim → version history
// ---------------------------------------------------------------------------

test('AC-2: a fully-declared frozen §Manifest manifest publishes an immutable App Version; read-back is VERBATIM; the publisher is SERVER-DERIVED; certification is born UNVERIFIED', async () => {
  // The dependency target: one published extension version.
  await publishExtension('1.0.0');
  await publishExtension('1.5.0');

  const developer = await makeDeveloper('apps-developer@marketingos.test');
  const owner = await makeAgencyOwner('apps-owner@marketingos.test');
  const developerB = await makeDeveloper('apps-developer-b@marketingos.test');

  const publish = await apiCall(port(), '/api/apps', {
    token: developer.token,
    body: appManifestFixture({ version: '1.0.0' }),
  });
  assert.equal(publish.status, 201, JSON.stringify(publish.body));
  const published = publish.body as Record<string, unknown>;
  const manifest = published['manifest'] as Record<string, unknown>;
  assert.equal(manifest['appKey'], 'agency-analytics');
  assert.equal(manifest['version'], '1.0.0');
  assert.deepEqual(manifest['requiredCredentialNames'], ['ANALYTICS_PROVIDER_KEY']);
  assert.deepEqual(manifest['stateNamespaces'], ['app:agency-analytics:spreadsheets']);
  assert.deepEqual(manifest['dependencies'], [
    { kind: 'extension', publisher: 'payswap-labs', key: 'audience-enricher', minVersion: '1.0.0', maxVersion: '2.0.0' },
  ]);
  // SERVER-DERIVED publisher identity (AC-5): 'dev:<userId>' — never a
  // request field (the manifest carried no publisher).
  assert.equal(published['publisher'], `dev:${developer.userId}`);
  // PLATFORM TERRITORY: born UNVERIFIED on every developer publish.
  assert.equal(published['certificationState'], 'UNVERIFIED');

  // AUTHORITATIVE state (direct SQL): the registry row exists with the
  // server-derived publisher, the born-UNVERIFIED certification, and the
  // dependency row re-fenced by the migration-037 trigger.
  const stored = await pool().query<{
    app_key: string;
    publisher: string;
    version: string;
    certification_state: string;
    capabilities: unknown;
  }>(
    'SELECT app_key, publisher, version, certification_state, capabilities FROM app_versions WHERE app_version_id = $1',
    [published['appVersionId'] as string],
  );
  assert.equal(stored.rows.length, 1);
  assert.equal(stored.rows[0]!.app_key, 'agency-analytics');
  assert.equal(stored.rows[0]!.publisher, `dev:${developer.userId}`);
  assert.equal(stored.rows[0]!.certification_state, 'UNVERIFIED');
  assert.deepEqual(stored.rows[0]!.capabilities, manifest['capabilities']);
  // The app-key ownership lineage row exists with the SAME publisher.
  const ownership = await pool().query<{ owner_publisher: string }>(
    'SELECT owner_publisher FROM apps WHERE app_key = $1',
    ['agency-analytics'],
  );
  assert.equal(ownership.rows.length, 1);
  assert.equal(ownership.rows[0]!.owner_publisher, `dev:${developer.userId}`);
  // The dependency declaration is recorded (append-only).
  const dependencies = await pool().query<{ kind: string; ref_publisher: string; ref_key: string; min_version: string; max_version: string }>(
    'SELECT kind, ref_publisher, ref_key, min_version, max_version FROM app_dependencies WHERE app_version_id = $1',
    [published['appVersionId'] as string],
  );
  assert.equal(dependencies.rows.length, 1);
  assert.equal(dependencies.rows[0]!.kind, 'extension');
  assert.equal(dependencies.rows[0]!.ref_publisher, 'payswap-labs');
  assert.equal(dependencies.rows[0]!.ref_key, 'audience-enricher');
  // The publish emitted an append-only audit event.
  const audit = await pool().query<{ count: string }>(
    "SELECT count(*)::text AS count FROM audit_events WHERE action = 'apps.version.published' AND target_id = $1",
    [published['appVersionId'] as string],
  );
  assert.equal(Number(audit.rows[0]!.count), 1, 'exactly one audit event per publish');

  // READ-BACK VERBATIM by (app key, EXACT version) — any active member.
  const read = await apiCall(port(), '/api/apps/agency-analytics/versions/1.0.0', {
    token: owner.user.token,
  });
  assert.equal(read.status, 200);
  assert.equal((read.body as Record<string, unknown>)['appVersionId'], published['appVersionId']);
  assert.deepEqual(
    (read.body as Record<string, unknown>)['manifest'],
    manifest,
    'the read-back manifest is verbatim',
  );

  // A NEW version is a NEW record.
  const next = await apiCall(port(), '/api/apps', {
    token: developer.token,
    body: appManifestFixture({ version: '1.1.0' }),
  });
  assert.equal(next.status, 201, JSON.stringify(next.body));
  assert.notEqual(
    (next.body as Record<string, unknown>)['appVersionId'],
    published['appVersionId'],
  );

  shared = {
    developer,
    developerB,
    owner: owner.user,
    agencyId: owner.agencyId,
    appV1Id: published['appVersionId'] as string,
    appV11Id: (next.body as Record<string, unknown>)['appVersionId'] as string,
  };
});

test('AC-8: the version history by app key lists every published version (newest first)', async () => {
  const { owner } = state();
  const history = await apiCall(port(), '/api/apps/agency-analytics/versions', {
    token: owner.token,
  });
  assert.equal(history.status, 200);
  const versions = history.body['versions'] as Record<string, unknown>[];
  assert.equal(versions.length, 2);
  assert.equal((versions[0]!['manifest'] as Record<string, unknown>)['version'], '1.1.0');
  assert.equal((versions[1]!['manifest'] as Record<string, unknown>)['version'], '1.0.0');
  // The catalog lists every published app version.
  const catalog = await apiCall(port(), '/api/apps', { token: owner.token });
  assert.equal(catalog.status, 200);
  assert.equal((catalog.body['apps'] as Record<string, unknown>[]).length, 2);
});

// ---------------------------------------------------------------------------
// AC-4 — the immutability battery
// ---------------------------------------------------------------------------

test('AC-4: re-publishing the same app key + semantic version is a 409 with ZERO new rows', async () => {
  const { developer } = state();
  const before = await countAppVersions('agency-analytics');
  const rePublish = await apiCall(port(), '/api/apps', {
    token: developer.token,
    body: appManifestFixture({ version: '1.0.0' }),
  });
  assert.equal(rePublish.status, 409, JSON.stringify(rePublish.body));
  assert.ok(JSON.stringify(rePublish.body).includes('immutable'));
  assert.equal(await countAppVersions('agency-analytics'), before, 'zero new rows');
});

test('AC-4: there is NO update or delete route — every mutating verb 405s at the router', async () => {
  const { owner } = state();
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    const attempted = await apiCall(port(), '/api/apps/agency-analytics/versions/1.0.0', {
      token: owner.token,
      method,
      body: { anything: true },
    });
    assert.equal(attempted.status, 405, `${method} must 405 (no update/delete surface exists)`);
  }
  const attemptedAll = await apiCall(port(), '/api/apps', { token: owner.token, method: 'DELETE' });
  assert.equal(attemptedAll.status, 405);
});

test('AC-4 DB backstop: published manifest rows reject UPDATE and DELETE by direct SQL (including certification-only UPDATEs)', async () => {
  const { appV1Id } = state();
  await assert.rejects(
    () => pool().query('UPDATE app_versions SET version = $1 WHERE app_version_id = $2', ['9.9.9', appV1Id]),
    (error: { message?: string }) => {
      assert.ok((error.message ?? '').includes('immutable'), `expected the immutability trigger, got: ${error.message}`);
      return true;
    },
  );
  await assert.rejects(
    () => pool().query('UPDATE app_versions SET support_level = $1 WHERE app_version_id = $2', ['premium', appV1Id]),
    (error: { message?: string }) => {
      assert.ok((error.message ?? '').includes('immutable'));
      return true;
    },
  );
  // Trust cannot be forged even by direct SQL: a certification-only
  // UPDATE is rejected by the same trigger (transitions are the future
  // MKT-050 platform surface, never a manifest rewrite).
  await assert.rejects(
    () => pool().query("UPDATE app_versions SET certification_state = 'MOS_CERTIFIED' WHERE app_version_id = $1", [appV1Id]),
    (error: { message?: string }) => {
      assert.ok((error.message ?? '').includes('immutable'));
      return true;
    },
  );
  await assert.rejects(
    () => pool().query('DELETE FROM app_versions WHERE app_version_id = $1', [appV1Id]),
    (error: { message?: string }) => {
      assert.ok((error.message ?? '').includes('immutable'));
      return true;
    },
  );
  // The dependency rows are append-only (part of the immutable version).
  await assert.rejects(
    () => pool().query("UPDATE app_dependencies SET min_version = '0.1.0' WHERE app_version_id = $1", [appV1Id]),
    (error: { message?: string }) => {
      assert.ok((error.message ?? '').includes('append-only'));
      return true;
    },
  );
  await assert.rejects(
    () => pool().query('DELETE FROM app_dependencies WHERE app_version_id = $1', [appV1Id]),
    (error: { message?: string }) => {
      assert.ok((error.message ?? '').includes('append-only'));
      return true;
    },
  );
  // The app-key ownership row is immutable (the lineage can never be
  // rewritten or removed).
  await assert.rejects(
    () => pool().query("UPDATE apps SET owner_publisher = 'dev:attacker' WHERE app_key = 'agency-analytics'"),
    (error: { message?: string }) => {
      assert.ok((error.message ?? '').includes('immutable'));
      return true;
    },
  );
});

test('AC-5: the app-key ownership lineage fence — a SECOND publisher cannot publish the same app key (409)', async () => {
  const { developerB } = state();
  const before = await countAppVersions('agency-analytics');
  const hijack = await apiCall(port(), '/api/apps', {
    token: developerB.token,
    body: appManifestFixture({ version: '2.0.0' }),
  });
  assert.equal(hijack.status, 409, JSON.stringify(hijack.body));
  assert.ok(JSON.stringify(hijack.body).includes('owned by another publisher'));
  assert.equal(await countAppVersions('agency-analytics'), before, 'zero new rows');
});

// ---------------------------------------------------------------------------
// AC-3/AC-5 — the DTO guard battery (422 + ZERO rows)
// ---------------------------------------------------------------------------

test('AC-3: authority-shaped keys are rejected 422 with ZERO rows (publisher spoofing, identity, provenance, certification)', async () => {
  const { developer } = state();
  const before = await countAppVersions('guard-app');

  // Publisher spoofing at the top level.
  const spoofedPublisher = writable(appManifestFixture());
  spoofedPublisher['publisher'] = 'dev:00000000-0000-0000-0000-000000000000';
  const publisherReject = await apiCall(port(), '/api/apps', {
    token: developer.token,
    body: { ...spoofedPublisher, manifest: { ...(spoofedPublisher['manifest'] as Record<string, unknown>), appKey: 'guard-app', version: '1.0.0' } },
  });
  assert.equal(publisherReject.status, 422, JSON.stringify(publisherReject.body));
  assert.ok(JSON.stringify(publisherReject.body).includes('forbidden authority field'));

  // Publisher spoofing INSIDE the manifest object.
  const spoofedInManifest = writable(appManifestFixture());
  (spoofedInManifest['manifest'] as Record<string, unknown>)['publisher'] = 'payswap-labs';
  (spoofedInManifest['manifest'] as Record<string, unknown>)['appKey'] = 'guard-app';
  const manifestPublisherReject = await apiCall(port(), '/api/apps', {
    token: developer.token,
    body: spoofedInManifest,
  });
  assert.equal(manifestPublisherReject.status, 422);
  assert.ok(JSON.stringify(manifestPublisherReject.body).includes('forbidden authority field'));

  // Tenant identity keys inside the manifest.
  const tenant = writable(appManifestFixture());
  (tenant['manifest'] as Record<string, unknown>)['agencyId'] = '00000000-0000-0000-0000-000000000000';
  (tenant['manifest'] as Record<string, unknown>)['appKey'] = 'guard-app';
  const tenantReject = await apiCall(port(), '/api/apps', { token: developer.token, body: tenant });
  assert.equal(tenantReject.status, 422);
  assert.ok(JSON.stringify(tenantReject.body).includes('forbidden authority field'));

  // Provenance keys.
  const provenance = writable(appManifestFixture());
  provenance['createdBy'] = '00000000-0000-0000-0000-000000000000';
  (provenance['manifest'] as Record<string, unknown>)['appKey'] = 'guard-app';
  const provenanceReject = await apiCall(port(), '/api/apps', { token: developer.token, body: provenance });
  assert.equal(provenanceReject.status, 422);

  // Certification-shaped key (platform territory): rejected at the route
  // with zero rows (the module-level 403 is proven by the unit battery).
  const certification = writable(appManifestFixture());
  (certification['manifest'] as Record<string, unknown>)['certificationState'] = 'MOS_CERTIFIED';
  (certification['manifest'] as Record<string, unknown>)['appKey'] = 'guard-app';
  const certificationReject = await apiCall(port(), '/api/apps', { token: developer.token, body: certification });
  assert.equal(certificationReject.status, 422, JSON.stringify(certificationReject.body));

  // Registry identity keys.
  const identity = writable(appManifestFixture());
  identity['appVersionId'] = '00000000-0000-0000-0000-000000000000';
  (identity['manifest'] as Record<string, unknown>)['appKey'] = 'guard-app';
  const identityReject = await apiCall(port(), '/api/apps', { token: developer.token, body: identity });
  assert.equal(identityReject.status, 422);

  assert.equal(await countAppVersions('guard-app'), before, 'ZERO rows from every rejection');
});

test('AC-3: secret-shaped VALUES anywhere in the manifest are rejected 422 with ZERO rows (§21/CRED-001)', async () => {
  const { developer } = state();
  const before = await countAppVersions('guard-app');

  const smuggled = writable(appManifestFixture());
  (smuggled['manifest'] as Record<string, unknown>)['appKey'] = 'guard-app';
  ((smuggled['manifest'] as Record<string, unknown>)['inputSchema'] as Record<string, unknown>)['apiKey'] =
    'sk-live-1234567890';
  const reject = await apiCall(port(), '/api/apps', { token: developer.token, body: smuggled });
  assert.equal(reject.status, 422, JSON.stringify(reject.body));
  assert.ok(JSON.stringify(reject.body).includes('material-shaped'));

  assert.equal(await countAppVersions('guard-app'), before, 'ZERO rows');
});

// ---------------------------------------------------------------------------
// AC-6 — dependency validation (fail-closed before any write)
// ---------------------------------------------------------------------------

test('AC-6: a dependency on a MISSING extension is rejected 422 with ZERO rows', async () => {
  const { developer } = state();
  const before = await countAppVersions('dep-app');
  const missing = await apiCall(port(), '/api/apps', {
    token: developer.token,
    body: appManifestFixture({
      appKey: 'dep-app',
      version: '1.0.0',
      dependencies: [
        { kind: 'extension', publisher: 'ghost-labs', key: 'ghost-enricher', minVersion: '1.0.0', maxVersion: '2.0.0' },
      ],
    }),
  });
  assert.equal(missing.status, 422, JSON.stringify(missing.body));
  assert.ok(JSON.stringify(missing.body).includes('no published compatible version'));
  assert.equal(await countAppVersions('dep-app'), before, 'ZERO rows');
});

test('AC-6: a dependency on a PUBLISHED extension with an INCOMPATIBLE range is rejected 422 with ZERO rows', async () => {
  const { developer } = state();
  const before = await countAppVersions('dep-app');
  // The extension exists at 1.0.0 and 1.5.0 — a [3.0.0 .. 4.0.0] range
  // has no published version inside it (REAL semver comparison).
  const incompatible = await apiCall(port(), '/api/apps', {
    token: developer.token,
    body: appManifestFixture({
      appKey: 'dep-app',
      version: '1.0.0',
      dependencies: [
        { kind: 'extension', publisher: 'payswap-labs', key: 'audience-enricher', minVersion: '3.0.0', maxVersion: '4.0.0' },
      ],
    }),
  });
  assert.equal(incompatible.status, 422, JSON.stringify(incompatible.body));
  assert.ok(JSON.stringify(incompatible.body).includes('no published compatible version'));
  assert.equal(await countAppVersions('dep-app'), before, 'ZERO rows');
});

test('AC-6: an app-owned state namespace claiming a CORE-AUTHORITY namespace is rejected 422 with ZERO rows', async () => {
  const { developer } = state();
  const before = await countAppVersions('dep-app');
  const coreClaim = await apiCall(port(), '/api/apps', {
    token: developer.token,
    body: appManifestFixture({
      appKey: 'dep-app',
      version: '1.0.0',
      stateNamespaces: ['app:dep-app:workflow'],
    }),
  });
  assert.equal(coreClaim.status, 422, JSON.stringify(coreClaim.body));
  assert.ok(JSON.stringify(coreClaim.body).includes('core-authority namespace'));
  assert.equal(await countAppVersions('dep-app'), before, 'ZERO rows');
});

test('AC-6: a dependency on a MISSING app and a SELF-dependency are rejected 422 with ZERO rows', async () => {
  const { developer } = state();
  const before = await countAppVersions('dep-app');

  const missingApp = await apiCall(port(), '/api/apps', {
    token: developer.token,
    body: appManifestFixture({
      appKey: 'dep-app',
      version: '1.0.0',
      dependencies: [
        { kind: 'app', publisher: null, key: 'ghost-suite', minVersion: '1.0.0', maxVersion: '2.0.0' },
      ],
    }),
  });
  assert.equal(missingApp.status, 422);
  assert.ok(JSON.stringify(missingApp.body).includes('no published compatible version'));

  const selfDep = await apiCall(port(), '/api/apps', {
    token: developer.token,
    body: appManifestFixture({
      appKey: 'dep-app',
      version: '1.0.0',
      dependencies: [
        { kind: 'app', publisher: null, key: 'dep-app', minVersion: '1.0.0', maxVersion: '2.0.0' },
      ],
    }),
  });
  assert.equal(selfDep.status, 422);
  assert.ok(JSON.stringify(selfDep.body).includes('own app key'));

  assert.equal(await countAppVersions('dep-app'), before, 'ZERO rows');
});

test('AC-6: a VALID app dependency on a published app lineage publishes and records the dependency row', async () => {
  const { developer } = state();
  // Publish the dependency app first (a published lineage).
  const dependencyApp = await apiCall(port(), '/api/apps', {
    token: developer.token,
    body: appManifestFixture({
      appKey: 'spreadsheet-engine',
      version: '1.0.0',
      dependencies: [],
    }),
  });
  assert.equal(dependencyApp.status, 201, JSON.stringify(dependencyApp.body));
  // Then the depending app.
  const depending = await apiCall(port(), '/api/apps', {
    token: developer.token,
    body: appManifestFixture({
      appKey: 'dep-app',
      version: '1.0.0',
      dependencies: [
        { kind: 'app', publisher: null, key: 'spreadsheet-engine', minVersion: '1.0.0', maxVersion: '1.9.0' },
      ],
    }),
  });
  assert.equal(depending.status, 201, JSON.stringify(depending.body));
  const dependencies = await pool().query<{ kind: string; ref_key: string }>(
    'SELECT kind, ref_key FROM app_dependencies WHERE app_version_id = $1',
    [(depending.body as Record<string, unknown>)['appVersionId'] as string],
  );
  assert.equal(dependencies.rows.length, 1);
  assert.equal(dependencies.rows[0]!.kind, 'app');
  assert.equal(dependencies.rows[0]!.ref_key, 'spreadsheet-engine');
});

// ---------------------------------------------------------------------------
// AC-8 — the compatibility query
// ---------------------------------------------------------------------------

test('AC-8: the compatibility query returns eligible app versions with honest ineligibility reasons', async () => {
  const { owner } = state();
  // The runtime environment: platform 1.5.0, pooled-worker, the
  // extension published at 1.5.0.
  const eligible = await apiCall(port(), '/api/apps/compatibility', {
    token: owner.token,
    body: {
      platformVersion: '1.5.0',
      runtimeClass: 'pooled-worker',
      extensionVersions: [
        { publisher: 'payswap-labs', extensionKey: 'audience-enricher', version: '1.5.0' },
      ],
    },
  });
  assert.equal(eligible.status, 200, JSON.stringify(eligible.body));
  const eligibleApps = (eligible.body['eligible'] as Record<string, unknown>[]).map(
    (entry) => (entry['manifest'] as Record<string, unknown>)['appKey'],
  );
  assert.ok(eligibleApps.includes('agency-analytics'), 'the compatible version is eligible');
  assert.ok(eligibleApps.includes('spreadsheet-engine'));
  assert.ok(eligibleApps.includes('dep-app'));

  // The runtime class filter: a dedicated-runtime query excludes the
  // pooled-worker versions with an honest reason.
  const runtimeFiltered = await apiCall(port(), '/api/apps/compatibility', {
    token: owner.token,
    body: {
      platformVersion: '1.5.0',
      runtimeClass: 'dedicated-runtime',
      extensionVersions: [
        { publisher: 'payswap-labs', extensionKey: 'audience-enricher', version: '1.5.0' },
      ],
    },
  });
  assert.equal(runtimeFiltered.status, 200);
  const ineligibleEntries = runtimeFiltered.body['ineligible'] as ReadonlyArray<{
    appVersion: Record<string, unknown>;
    reasons: readonly string[];
  }>;
  assert.ok(ineligibleEntries.length > 0);
  assert.ok(
    ineligibleEntries.some((entry) =>
      entry.reasons.some((reason) => reason.includes('runtime class')),
    ),
    'the runtime-class reason is reported',
  );

  // The platform version outside the compatibility range.
  const outOfRange = await apiCall(port(), '/api/apps/compatibility', {
    token: owner.token,
    body: {
      platformVersion: '2.5.0',
      runtimeClass: null,
      extensionVersions: [
        { publisher: 'payswap-labs', extensionKey: 'audience-enricher', version: '1.5.0' },
      ],
    },
  });
  assert.equal(outOfRange.status, 200);
  const outReasons = (outOfRange.body['ineligible'] as ReadonlyArray<{ reasons: readonly string[] }>);
  assert.ok(
    outReasons.some((entry) => entry.reasons.some((reason) => reason.includes('compatibility range'))),
    'the compatibility-range reason is reported',
  );

  // The extension dependency unsatisfied by the environment (3.0.0 is
  // outside the declared [1.0.0 .. 2.0.0]).
  const depMissed = await apiCall(port(), '/api/apps/compatibility', {
    token: owner.token,
    body: {
      platformVersion: '1.5.0',
      runtimeClass: null,
      extensionVersions: [
        { publisher: 'payswap-labs', extensionKey: 'audience-enricher', version: '3.0.0' },
      ],
    },
  });
  assert.equal(depMissed.status, 200);
  const depEntries = depMissed.body['ineligible'] as ReadonlyArray<{
    appVersion: Record<string, unknown>;
    reasons: readonly string[];
  }>;
  const analyticsEntry = depEntries.find(
    (entry) => (entry.appVersion['manifest'] as Record<string, unknown>)['appKey'] === 'agency-analytics',
  );
  assert.ok(analyticsEntry !== undefined, 'agency-analytics is reported ineligible');
  assert.ok(
    analyticsEntry!.reasons.some((reason) => reason.includes('audience-enricher')),
    'the dependency reason names the unsatisfied dependency',
  );
});

// ---------------------------------------------------------------------------
// AC-9 — concurrency: exactly-one-wins on the same version
// ---------------------------------------------------------------------------

test('AC-9: concurrent same-version publishes yield EXACTLY ONE winner (one 201, seven 409s, one row)', async () => {
  const { developer } = state();
  const races = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      apiCall(port(), '/api/apps', {
        token: developer.token,
        body: appManifestFixture({
          appKey: 'race-app',
          version: '1.0.0',
          dependencies: [],
          supportLevel: `standard-${index}`,
        }),
      }),
    ),
  );
  assert.deepEqual(
    races.map((attempt) => attempt.status).sort((a, b) => a - b),
    [201, 409, 409, 409, 409, 409, 409, 409],
    'exactly one publish wins',
  );
  assert.equal(await countAppVersions('race-app'), 1, 'exactly one row');
  // Concurrent FIRST publishes of the same NEW key: one owner row.
  const ownership = await pool().query<{ count: string }>(
    'SELECT count(*)::text AS count FROM apps WHERE app_key = $1',
    ['race-app'],
  );
  assert.equal(Number(ownership.rows[0]!.count), 1, 'exactly one ownership lineage row');
});

// ---------------------------------------------------------------------------
// AC-8/AC-9 — the tenant posture
// ---------------------------------------------------------------------------

test('AC-9: anonymous callers get 401 on every /apps route', async () => {
  for (const route of [
    { method: 'POST', path: '/api/apps' },
    { method: 'GET', path: '/api/apps' },
    { method: 'GET', path: '/api/apps/agency-analytics/versions' },
    { method: 'GET', path: '/api/apps/agency-analytics/versions/1.0.0' },
    { method: 'POST', path: '/api/apps/compatibility' },
  ]) {
    const anonymous = await apiCall(port(), route.path, {
      method: route.method,
      ...(route.method === 'POST' ? { body: { platformVersion: '1.0.0', extensionVersions: [] } } : {}),
    });
    assert.equal(anonymous.status, 401, `${route.method} ${route.path} must require authentication`);
  }
});

test('AC-8: publishing is platform territory — an agency owner WITHOUT the developer role is 403', async () => {
  const { owner } = state();
  const before = await countAppVersions('agency-analytics');
  const forbidden = await apiCall(port(), '/api/apps', {
    token: owner.token,
    body: appManifestFixture({ version: '3.0.0' }),
  });
  assert.equal(forbidden.status, 403, JSON.stringify(forbidden.body));
  assert.ok(JSON.stringify(forbidden.body).includes('platform_developer'));
  assert.equal(await countAppVersions('agency-analytics'), before, 'ZERO rows');
});

test('AC-8: reads are open to every authenticated active member (the catalog posture)', async () => {
  const reader = await makeUser('apps-reader@marketingos.test', 'reader');
  const read = await apiCall(port(), '/api/apps/agency-analytics/versions/1.0.0', {
    token: reader.token,
  });
  assert.equal(read.status, 200);
  const history = await apiCall(port(), '/api/apps/agency-analytics/versions', { token: reader.token });
  assert.equal(history.status, 200);
  const compatibility = await apiCall(port(), '/api/apps/compatibility', {
    token: reader.token,
    body: { platformVersion: '1.5.0', runtimeClass: null, extensionVersions: [] },
  });
  assert.equal(compatibility.status, 200);
});
