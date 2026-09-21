/**
 * MKT-064 integration tests — the Content Asset and Transformation
 * Authority on the REAL stack: embedded PostgreSQL 18, a real API
 * process (the production composition — the engine registry EMPTY by
 * default, the MKT-056 discipline) and the SAME in-process application
 * composed against the SAME database with the DISCLOSED engine doubles
 * through the AppOptions.contentTransformationEngines seam (the
 * notification-delivery precedent — NO network calls anywhere in this
 * suite).
 *
 * Acceptance mapping (spec/effective-backlog-v1.6.md MKT-064: "versioned
 * content assets plus first-party/extension transformation execution
 * contracts. Acceptance: crop/reframe/padding/compilation/clip/caption/
 * voice/translation/format transformations retain lineage and quality
 * observations"; the dispatch acceptance criteria):
 *   - AC-1 (versioned assets): logical asset identities + immutable
 *     version records born draft (explicit versions — the (asset,
 *     version) fence; a correction is a NEW version with a NEW ref);
 *     the materialization move (draft → materialized, the object
 *     content-addressed; CAS + the append-only event tail); version
 *     rows are immutable except the sanctioned move and DELETE is
 *     rejected by the migration-053 triggers; the round trip at BOTH
 *     levels (HTTP + module) with the uniform-404 posture;
 *   - AC-2 (quality observations): append-only measurable facts only
 *     (numeric + language text shapes; the closed metric vocabulary —
 *     a fabricated 'score' is not representable); the tail is never
 *     rewritten in place (direct SQL UPDATE/DELETE rejected);
 *   - AC-3 (transformation execution through /executions): the request
 *     resolves the engine (a kind with no engine fails closed — over
 *     real HTTP against the EMPTY production registry AND at module
 *     level), creates the EXECUTION through the /executions authority
 *     (the external-request link) and freezes the ingredient versions;
 *     the runner drives the execution lifecycle created → queued →
 *     starting → running → succeeded (verified through the executions
 *     module API), runs the engine, stores the output content-addressed
 *     and creates the output version BORN derived WITH lineage (the
 *     derivation event, the byte_size observation, the 063 lineage
 *     links, the output link set ONCE); the replay converges; the
 *     failure path settles both records honestly (requested → failed +
 *     execution failed safe);
 *   - AC-4 (the 063 gate interplay — boundary rule 5): an asset whose
 *     ingredient is RIGHTS-BLOCKED can still be TRANSFORMED (the module
 *     never checks rights) but the derived composite can NEVER pass the
 *     063 publication gate (blocked through the conjunction — the
 *     lineage links this module recorded); the asset-ref grammar
 *     interoperates with the rights records (register for the minted
 *     ref; the ContentAssetReferencePort resolves it);
 *   - AC-5 (Client isolation): cross-Client reads/writes/transforms/
 *     executions fail closed with the uniform 404 posture; cross-Client
 *     ingredient/evidence linkage is rejected by the database itself;
 *   - AC-6 (the DB backstops): the append-only triggers on the event/
 *     observation/ingredient tails, the no-DELETE fences, the illegal
 *     lifecycle/status moves and the status-shape CHECKs are enforced
 *     by the database on direct SQL;
 *   - AC-7 (the auth battery): anonymous 401 + the uniform 404.
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
import type { ContentAssetsModuleApi } from '../../src/modules/content-assets/public.ts';
import {
  createContentAssetReferencePort,
  createCropTransformationEngine,
  createFormatTransformationEngine,
  createPassthroughTransformationEngine,
  mintContentAssetRef,
  type TransformationEngine,
} from '../../src/modules/content-assets/public.ts';
import type { ContentRightsModuleApi } from '../../src/modules/content-rights/public.ts';
import type { ExecutionsModuleApi } from '../../src/modules/executions/public.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;
let assets: ContentAssetsModuleApi | null = null;
let rights: ContentRightsModuleApi | null = null;
let executionsApi: ExecutionsModuleApi | null = null;

function contentAssets(): ContentAssetsModuleApi {
  if (assets === null) throw new Error('application not bootstrapped');
  return assets;
}
function contentRights(): ContentRightsModuleApi {
  if (rights === null) throw new Error('application not bootstrapped');
  return rights;
}
function executionsModule(): ExecutionsModuleApi {
  if (executionsApi === null) throw new Error('application not bootstrapped');
  return executionsApi;
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
  correlationId: 'integration-content-assets-1',
  causationId: null,
} as const;

// ---------------------------------------------------------------------------
// Shared fixtures (the notification-delivery / content-rights precedent)
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

async function makeWorkspace(clientId: string, token: string): Promise<string> {
  const created = await apiCall(port(), `/api/clients/${clientId}/workspaces`, {
    token,
    body: { name: `Workspace ${clientId.slice(0, 8)}` },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body['workspaceId'] as string;
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
      description: 'Integration test content-assets destination policy',
    },
  });
  assert.equal(declared.status, 201, JSON.stringify(declared.body));
}

let evidenceSeq = 0;
/** Creates ONE /evidence record in the client through the REAL routes. */
async function makeEvidence(token: string, clientId: string): Promise<string> {
  evidenceSeq += 1;
  const created = await apiCall(port(), `/api/clients/${clientId}/evidence`, {
    token,
    body: {
      class: 'source_fact',
      sourceSystem: 'content-assets-test',
      sourceRef: `fixture/content-assets/${evidenceSeq}`,
      observedAt: '2026-01-15T10:30:00.000Z',
      content: { kind: 'asset-provenance', seq: evidenceSeq },
      contentRef: `mos-objects://content-assets/${evidenceSeq}`,
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

/**
 * The TEST-LOCAL multi-ingredient compilation engine (the disclosed
 * pluggability proof: the port is public, so the integration suite
 * supplies its OWN engine through the SAME AppOptions seam — a
 * concatenation double, honest about being no real editor).
 */
function createTestCompilationEngine(): TransformationEngine {
  return {
    engineId: 'test:compilation-concat',
    supportedKinds: ['compilation', 'padding'],
    declaredEffects: ['concatenates the ingredient bytes in position order (a disclosed test double — no real editing)'],
    declaredConstraints: ['at least one ingredient'],
    executionKind: 'deterministic',
    async execute(input) {
      const total = input.ingredients.reduce((sum, ingredient) => sum + ingredient.bytes.byteLength, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const ingredient of input.ingredients) {
        out.set(ingredient.bytes, offset);
        offset += ingredient.bytes.byteLength;
      }
      return {
        outputBytes: out,
        outputContentType: 'application/octet-stream',
        qualityObservations: [],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Shared state built once in before()
// ---------------------------------------------------------------------------

let alice: Principal;
let aliceClientId: string;
let aliceWorkspaceId: string;
let bob: Principal;
let bobClientId: string;
let bobWorkspaceId: string;
let aliceEvidenceA: string;
let aliceEvidenceB: string;
let bobEvidence: string;

before(async () => {
  stack = await bootStack('contentassets');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  // Fixtures: two agencies (the golden path + the isolation battery),
  // the clients + workspaces, the network allowance for Alice only
  // (Bob gets NO policy — the 063 gate fails closed there) and the
  // /evidence provenance anchors.
  alice = await makeAgencyOwner('alice@contentassets.test');
  bob = await makeAgencyOwner('bob@contentassets.test');
  aliceClientId = await makeClient(alice.agencyId, alice.token);
  bobClientId = await makeClient(bob.agencyId, bob.token);
  aliceWorkspaceId = await makeWorkspace(aliceClientId, alice.token);
  bobWorkspaceId = await makeWorkspace(bobClientId, bob.token);
  await declareNetworkPolicy(alice, [
    { effect: 'allow', operations: ['*'], reason: 'integration test allowance' },
  ]);

  aliceEvidenceA = await makeEvidence(alice.token, aliceClientId);
  aliceEvidenceB = await makeEvidence(alice.token, aliceClientId);
  bobEvidence = await makeEvidence(bob.token, bobClientId);

  // The in-process application (module-level round trips against the
  // SAME database) — composed with the DISCLOSED engine doubles through
  // the AppOptions seam: the three first-party public doubles + the
  // test-local compilation double (the pluggability proof). The SPAWNED
  // API process deliberately keeps the EMPTY production registry (the
  // MKT-056 discipline — the fail-closed HTTP battery below).
  process.env.MOS_DATABASE_URL = stack.env.databaseUrl;
  process.env.MOS_INTERNAL_API_TOKEN = stack.env.internalApiToken;
  process.env.MOS_ENV = 'test';
  process.env.MOS_OBJECT_STORE = 'fs';
  process.env.MOS_OBJECT_STORE_DIR = stack.env.objectStoreDir;
  process.env.MOS_SECRETS_DIR = stack.env.secretsDir;
  const core = await bootstrapApplication({
    contentTransformationEngines: [
      createPassthroughTransformationEngine(),
      createFormatTransformationEngine(),
      createCropTransformationEngine(),
      createTestCompilationEngine(),
    ],
  });
  assets = core.modules.contentAssets;
  rights = core.modules.contentRights;
  executionsApi = core.modules.executions;
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/** Registers + materializes ONE source asset version (the golden-path fixture). */
async function materializedAsset(
  agencyId: string,
  clientId: string,
  evidenceRef: string,
  displayName: string,
  bytes: Uint8Array,
): Promise<{ assetId: string; versionId: string; assetRef: string }> {
  const version = await contentAssets().registerAssetVersion(
    {
      agencyId,
      clientId,
      workspaceId: null,
      assetId: null,
      mediaKind: 'video',
      displayName,
      contentType: 'video/mp4',
      sourceEvidenceRef: evidenceRef,
    },
    MODULE_PROVENANCE,
  );
  const materialized = await contentAssets().materializeAssetVersion(
    { versionId: version.versionId, bytes },
    MODULE_PROVENANCE,
  );
  return {
    assetId: version.assetId,
    versionId: materialized.record.versionId,
    assetRef: version.assetRef,
  };
}

// ---------------------------------------------------------------------------
// AC-1: the versioned asset records (born draft; explicit versions; the
// materialization move; the round trip at BOTH levels)
// ---------------------------------------------------------------------------

test('AC-1a: a source version is born draft with the minted ref, materializes once, and never re-materializes', async () => {
  const version = await contentAssets().registerAssetVersion(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      assetId: null,
      mediaKind: 'video',
      displayName: 'Launch teaser',
      contentType: 'video/mp4',
      sourceEvidenceRef: aliceEvidenceA,
    },
    MODULE_PROVENANCE,
  );
  assert.equal(version.version, 1);
  assert.equal(version.lifecycleState, 'draft');
  assert.equal(version.assetRef, mintContentAssetRef(version.versionId));
  assert.equal(version.objectKey, null);
  assert.equal(version.sourceEvidenceRef, aliceEvidenceA);

  // The birth event is recorded.
  const events = await contentAssets().listLifecycleEvents(version.versionId);
  assert.equal(events?.length, 1);
  assert.equal(events?.[0]?.eventKind, 'registration');
  assert.equal(events?.[0]?.toState, 'draft');

  // The materialization move: object stored content-addressed, the
  // single sanctioned state move, the event tail grows.
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const materialized = await contentAssets().materializeAssetVersion(
    { versionId: version.versionId, bytes },
    MODULE_PROVENANCE,
  );
  assert.equal(materialized.record.lifecycleState, 'materialized');
  assert.equal(materialized.record.objectSize, bytes.byteLength);
  assert.match(materialized.record.objectKey ?? '', /^[a-f0-9]{64}$/);
  assert.equal(materialized.record.versionCas, 2);
  assert.equal(materialized.event.eventKind, 'materialization');
  assert.equal(materialized.event.fromState, 'draft');
  assert.equal(materialized.event.toState, 'materialized');

  const tail = await contentAssets().listLifecycleEvents(version.versionId);
  assert.equal(tail?.length, 2);

  // A materialized version never re-materializes (the immutable
  // version discipline — the honest ConflictError).
  await assert.rejects(
    () => contentAssets().materializeAssetVersion({ versionId: version.versionId, bytes }, MODULE_PROVENANCE),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /only a DRAFT can be materialized/);
      return true;
    },
  );
});

test('AC-1b: a known asset creates the NEXT explicit version (a correction is a NEW version with a NEW ref)', async () => {
  const first = await contentAssets().registerAssetVersion(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      assetId: null,
      mediaKind: 'image',
      displayName: 'Poster v1',
      contentType: 'image/png',
      sourceEvidenceRef: aliceEvidenceA,
    },
    MODULE_PROVENANCE,
  );
  const second = await contentAssets().registerAssetVersion(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      assetId: first.assetId,
      mediaKind: 'image',
      displayName: 'Poster v2 (corrected)',
      contentType: 'image/png',
      sourceEvidenceRef: aliceEvidenceA,
    },
    MODULE_PROVENANCE,
  );
  assert.equal(second.assetId, first.assetId);
  assert.equal(second.version, 2);
  assert.notEqual(second.assetRef, first.assetRef, 'a correction is a NEW ref');
  const versionsOfAsset = await contentAssets().listVersionsOfAsset(first.assetId);
  assert.equal(versionsOfAsset?.length, 2);
  assert.equal(versionsOfAsset?.[0]?.version, 1);
  assert.equal(versionsOfAsset?.[1]?.version, 2);
});

test('AC-1c: the version discipline is DB-fenced — immutability, no-DELETE, the (asset, version) and ref fences', async () => {
  const { versionId } = await materializedAsset(
    alice.agencyId,
    aliceClientId, aliceEvidenceA, 'Fenced source', new Uint8Array([9, 9, 9]),
  );

  // In-place metadata rewrite is rejected by the disciplined trigger.
  await assertDbRejects(
    'UPDATE content_asset_versions SET display_name = $1 WHERE version_id = $2',
    ['Rewritten', versionId],
    'media/kind metadata is immutable',
  );
  // Rewinding the lifecycle is rejected (materialized → derived).
  await assertDbRejects(
    "UPDATE content_asset_versions SET lifecycle_state = 'derived' WHERE version_id = $1",
    [versionId],
    'illegal content asset lifecycle move',
  );
  // DELETE is rejected outright.
  await assertDbRejects(
    'DELETE FROM content_asset_versions WHERE version_id = $1',
    [versionId],
    'cannot be deleted',
  );
  await assertDbRejects(
    'DELETE FROM content_assets WHERE asset_id = (SELECT asset_id FROM content_asset_versions WHERE version_id = $1)',
    [versionId],
    'cannot be deleted',
  );
  // The ref fence: the same ref cannot exist twice.
  await assertDbRejects(
    `INSERT INTO content_asset_versions (version_id, asset_id, agency_id, client_id, workspace_id, version,
        asset_ref, media_kind, display_name, content_type, lifecycle_state, object_key, object_digest,
        object_size, source_evidence_ref, created_by_actor, created_via, correlation_id)
     SELECT $1, asset_id, agency_id, client_id, workspace_id, version + 10,
        asset_ref, media_kind, display_name, content_type, 'draft', NULL, NULL, NULL,
        source_evidence_ref, 'sql-test', 'test', 'sql-test'
       FROM content_asset_versions WHERE version_id = $2`,
    ['11111111-2222-4333-8444-555555555555', versionId],
    'content_asset_versions_ref_fence',
  );
});

test('AC-1d: the HTTP round trip — register (born draft), materialize (base64), list, by-ref; the authority-field and shape rejections', async () => {
  // Register over HTTP (owner|admin).
  const registered = await apiCall(port(), `/api/clients/${aliceClientId}/content-assets`, {
    token: alice.token,
    body: {
      mediaKind: 'video',
      displayName: 'HTTP teaser',
      contentType: 'video/mp4',
      sourceEvidenceRef: aliceEvidenceA,
    },
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const httpVersion = (registered.body['version'] as Record<string, unknown>);
  const versionId = httpVersion['versionId'] as string;
  assert.equal(httpVersion['lifecycleState'], 'draft');
  assert.match(httpVersion['assetRef'] as string, /^ca:[0-9a-f-]{36}$/);

  // The list surface (any active member).
  const listed = await apiCall(port(), `/api/clients/${aliceClientId}/content-assets`, {
    token: alice.token,
  });
  assert.equal(listed.status, 200);
  const versions = listed.body['versions'] as unknown[];
  assert.ok(versions.length >= 1);

  // The by-ref resolution (any active member).
  const byRef = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/content-assets/by-ref/${httpVersion['assetRef']}`,
    { token: alice.token },
  );
  assert.equal(byRef.status, 200);
  assert.equal((byRef.body['version'] as Record<string, unknown>)['versionId'], versionId);

  // The materialization move over HTTP (base64 transport).
  const payload = Buffer.from(new Uint8Array([7, 7, 7, 7])).toString('base64');
  const materializedHttp = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/content-assets/${versionId}/materialize`,
    { token: alice.token, body: { bytesBase64: payload } },
  );
  assert.equal(materializedHttp.status, 200, JSON.stringify(materializedHttp.body));
  assert.equal(
    (materializedHttp.body['version'] as Record<string, unknown>)['lifecycleState'],
    'materialized',
  );
  assert.equal((materializedHttp.body['event'] as Record<string, unknown>)['eventKind'], 'materialization');

  // Unknown evidence is the uniform 404 (the route-layer canonical
  // resolution — no cross-tenant oracle).
  const unknownEvidence = await apiCall(port(), `/api/clients/${aliceClientId}/content-assets`, {
    token: alice.token,
    body: {
      mediaKind: 'video',
      displayName: 'No evidence',
      contentType: 'video/mp4',
      sourceEvidenceRef: '01234567-89ab-4cde-8f01-234567890abc',
    },
  });
  assert.equal(unknownEvidence.status, 404);

  // Foreign evidence (Bob's, in Alice's client) is the SAME uniform 404.
  const foreignEvidence = await apiCall(port(), `/api/clients/${aliceClientId}/content-assets`, {
    token: alice.token,
    body: {
      mediaKind: 'video',
      displayName: 'Foreign evidence',
      contentType: 'video/mp4',
      sourceEvidenceRef: bobEvidence,
    },
  });
  assert.equal(foreignEvidence.status, 404);

  // An unknown vocabulary value is the 400 shape rejection.
  const badKind = await apiCall(port(), `/api/clients/${aliceClientId}/content-assets`, {
    token: alice.token,
    body: {
      mediaKind: 'hologram',
      displayName: 'Bad kind',
      contentType: 'video/mp4',
      sourceEvidenceRef: aliceEvidenceA,
    },
  });
  assert.equal(badKind.status, 422);

  // An authority field (the server-derived lifecycle state) is rejected.
  const smuggled = await apiCall(port(), `/api/clients/${aliceClientId}/content-assets`, {
    token: alice.token,
    body: {
      mediaKind: 'video',
      displayName: 'Smuggled',
      contentType: 'video/mp4',
      sourceEvidenceRef: aliceEvidenceA,
      lifecycleState: 'materialized',
    },
  });
  assert.equal(smuggled.status, 422);

  // The version detail carries the full tails.
  const detail = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/content-assets/${versionId}`,
    { token: alice.token },
  );
  assert.equal(detail.status, 200);
  const eventsTail = (detail.body['events'] as unknown[]);
  assert.ok(eventsTail.length >= 2, 'the lifecycle tail is readable back');
});

// ---------------------------------------------------------------------------
// AC-2: the quality observations (append-only measurable facts only)
// ---------------------------------------------------------------------------

test('AC-2: quality observations round-trip at both levels; the closed vocabulary and shape guards; the tail is append-only', async () => {
  const { versionId } = await materializedAsset(
    alice.agencyId,
    aliceClientId, aliceEvidenceA, 'Observed source', new Uint8Array([3, 1, 4, 1, 5]),
  );

  // Module level: numeric + language observations.
  const duration = await contentAssets().recordQualityObservation(
    { versionId, metric: 'duration_ms', numericValue: 12500, textValue: null },
    MODULE_PROVENANCE,
  );
  assert.equal(duration.metric, 'duration_ms');
  assert.equal(duration.metricValueNumeric, 12500);
  const language = await contentAssets().recordQualityObservation(
    { versionId, metric: 'language', numericValue: null, textValue: 'pt-BR' },
    MODULE_PROVENANCE,
  );
  assert.equal(language.metricValueText, 'pt-BR');
  const coverage = await contentAssets().recordQualityObservation(
    { versionId, metric: 'caption_coverage_ratio', numericValue: 0.87, textValue: null },
    MODULE_PROVENANCE,
  );
  assert.equal(coverage.metricValueNumeric, 0.87);

  // A re-measurement is a NEW row (the observable tail).
  await contentAssets().recordQualityObservation(
    { versionId, metric: 'caption_coverage_ratio', numericValue: 0.92, textValue: null },
    MODULE_PROVENANCE,
  );
  const tail = await contentAssets().listQualityObservations(versionId);
  assert.equal(tail?.length, 4);

  // The closed vocabulary: a fabricated score is not representable.
  await assert.rejects(
    () => contentAssets().recordQualityObservation(
      { versionId, metric: 'quality_score' as never, numericValue: 5, textValue: null },
      MODULE_PROVENANCE,
    ),
    (error: unknown) => {
      assert.match(error instanceof Error ? error.message : '', /frozen quality-metric vocabulary/);
      return true;
    },
  );
  // The value shapes are exclusive per metric class.
  await assert.rejects(
    () => contentAssets().recordQualityObservation(
      { versionId, metric: 'duration_ms', numericValue: null, textValue: 'long' },
      MODULE_PROVENANCE,
    ),
    (error: unknown) => {
      assert.match(error instanceof Error ? error.message : '', /non-negative finite numeric/);
      return true;
    },
  );
  await assert.rejects(
    () => contentAssets().recordQualityObservation(
      { versionId, metric: 'caption_coverage_ratio', numericValue: 1.5, textValue: null },
      MODULE_PROVENANCE,
    ),
    (error: unknown) => {
      assert.match(error instanceof Error ? error.message : '', /ratio bounded to \[0, 1\]/);
      return true;
    },
  );

  // HTTP level: the observation POST (owner|admin).
  const observed = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/content-assets/${versionId}/observations`,
    { token: alice.token, body: { metric: 'bitrate_kbps', numericValue: '4500' } },
  );
  assert.equal(observed.status, 201, JSON.stringify(observed.body));
  assert.equal(
    (observed.body['observation'] as Record<string, unknown>)['metricValueNumeric'],
    4500,
  );
  const badHttp = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/content-assets/${versionId}/observations`,
    { token: alice.token, body: { metric: 'overall_score' } },
  );
  assert.equal(badHttp.status, 422);

  // The append-only DB backstops: UPDATE and DELETE are rejected.
  await assertDbRejects(
    'UPDATE content_asset_quality_observations SET metric_value_numeric = 1 WHERE version_id = $1',
    [versionId],
    'is append-only',
  );
  await assertDbRejects(
    'DELETE FROM content_asset_quality_observations WHERE version_id = $1',
    [versionId],
    'is append-only',
  );
});

// ---------------------------------------------------------------------------
// AC-3: the transformation execution (through the /executions authority)
// ---------------------------------------------------------------------------

test('AC-3a: the golden path — request (engine resolved, execution created, ingredients frozen) → execute (lifecycle driven, output born derived WITH lineage)', async () => {
  const bytesA = new Uint8Array([10, 20, 30]);
  const bytesB = new Uint8Array([40, 50, 60]);
  const ingredientA = await materializedAsset(alice.agencyId, aliceClientId, aliceEvidenceA, 'Ingredient A', bytesA);
  const ingredientB = await materializedAsset(alice.agencyId, aliceClientId, aliceEvidenceB, 'Ingredient B', bytesB);

  // A draft ingredient cannot be transformed (the honest fail-closed).
  const draft = await contentAssets().registerAssetVersion(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      assetId: null,
      mediaKind: 'video',
      displayName: 'Draft ingredient',
      contentType: 'video/mp4',
      sourceEvidenceRef: aliceEvidenceA,
    },
    MODULE_PROVENANCE,
  );
  await assert.rejects(
    () => contentAssets().requestTransformation(
      {
        agencyId: alice.agencyId,
        clientId: aliceClientId,
        workspaceId: aliceWorkspaceId,
        transformationKind: 'compilation',
        parameters: { layout: 'top-bottom' },
        outputSpec: { mediaKind: 'video', displayName: 'Compiled output' },
        ingredients: [
          { assetId: ingredientA.assetId, version: 1 },
          { assetId: draft.assetId, version: 1 },
        ],
        engineId: null,
      },
      MODULE_PROVENANCE,
    ),
    (error: unknown) => {
      assert.match(error instanceof Error ? error.message : '', /draft ingredient cannot be transformed/);
      return true;
    },
  );

  // THE REQUEST: engine resolved (the test compilation double), the
  // EXECUTION created through the /executions authority, the ingredient
  // versions FROZEN.
  const requested = await contentAssets().requestTransformation(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: aliceWorkspaceId,
      transformationKind: 'compilation',
      parameters: { layout: 'top-bottom' },
      outputSpec: { mediaKind: 'video', displayName: 'Compiled output' },
      ingredients: [
        { assetId: ingredientA.assetId, version: 1 },
        { assetId: ingredientB.assetId, version: 1 },
      ],
      engineId: 'test:compilation-concat',
    },
    MODULE_PROVENANCE,
  );
  const transformation = requested.transformation;
  assert.equal(transformation.status, 'requested');
  assert.equal(transformation.transformationKind, 'compilation');
  assert.equal(transformation.engineId, 'test:compilation-concat');
  assert.equal(transformation.outputVersionId, null);
  assert.equal(requested.ingredients.length, 2);
  assert.equal(requested.ingredients[0]?.inputAssetRef, ingredientA.assetRef);
  assert.equal(requested.ingredients[1]?.inputVersionNumber, 1);

  // The execution exists through the /executions authority (the
  // external-request link; born created).
  const executionBefore = await executionsModule().getExecution(transformation.executionRef);
  assert.ok(executionBefore !== null);
  assert.equal(executionBefore.executionKind, 'deterministic');
  assert.equal(executionBefore.runtimeClass, 'pooled-worker');
  assert.equal(executionBefore.taskLink.kind, 'external-request');
  if (executionBefore.taskLink.kind === 'external-request') {
    assert.equal(executionBefore.taskLink.externalRequestRef, `content-transformation:${transformation.transformationId}`);
  }

  // THE EXECUTION (the module runner).
  const executed = await contentAssets().executeTransformation(
    { transformationId: transformation.transformationId },
    MODULE_PROVENANCE,
  );
  assert.equal(executed.replayed, false);
  assert.equal(executed.transformation.status, 'completed');
  assert.ok(executed.output !== null);
  const output = executed.output!;

  // The output version is BORN derived WITH its object + lineage.
  assert.equal(output.lifecycleState, 'derived');
  assert.equal(output.version, 1);
  assert.equal(output.sourceEvidenceRef, null, 'a derived version carries NO evidence anchor — the recorded transformation IS the provenance');
  assert.equal(output.objectSize, bytesA.byteLength + bytesB.byteLength);
  assert.match(output.objectKey ?? '', /^[a-f0-9]{64}$/);
  assert.equal(output.assetRef, mintContentAssetRef(output.versionId));
  assert.equal(executed.transformation.outputVersionId, output.versionId);
  assert.ok(executed.transformation.completedAt !== null);

  // The derivation event + the byte_size observation.
  const outputEvents = await contentAssets().listLifecycleEvents(output.versionId);
  assert.equal(outputEvents?.length, 1);
  assert.equal(outputEvents?.[0]?.eventKind, 'derivation');
  assert.equal(outputEvents?.[0]?.toState, 'derived');
  const observations = await contentAssets().listQualityObservations(output.versionId);
  assert.equal(observations?.length, 1);
  assert.equal(observations?.[0]?.metric, 'byte_size');
  assert.equal(observations?.[0]?.metricValueNumeric, output.objectSize);

  // The ingredient links are frozen (immutable, position-ordered).
  const links = await contentAssets().listTransformationIngredients(transformation.transformationId);
  assert.equal(links?.length, 2);
  assert.equal(links?.[0]?.inputVersionId, ingredientA.versionId);
  assert.equal(links?.[1]?.inputAssetRef, ingredientB.assetRef);

  // THE EXECUTION LIFECYCLE ended succeeded (through the /executions
  // authority — the append-only transition tail).
  const executionAfter = await executionsModule().getExecution(transformation.executionRef);
  assert.equal(executionAfter?.status, 'succeeded');
  const transitions = await executionsModule().getExecutionTransitions(transformation.executionRef);
  const path = transitions?.map((transition) => transition.toStatus);
  assert.deepEqual(path, ['queued', 'starting', 'running', 'succeeded']);

  // THE 063 LINEAGE LINKS (the conjunction seam — recorded through the
  // rights public contract during execution).
  const rightsLinks = await contentRights().listLineageLinks(aliceClientId, output.assetRef);
  assert.equal(rightsLinks.length, 2);
  assert.deepEqual(
    rightsLinks.map((link) => link.ingredientAssetRef).sort(),
    [ingredientA.assetRef, ingredientB.assetRef].sort(),
  );

  // The REPLAY converges (idempotent — no re-run, the recorded outcome).
  const replayed = await contentAssets().executeTransformation(
    { transformationId: transformation.transformationId },
    MODULE_PROVENANCE,
  );
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.transformation.status, 'completed');
  assert.equal(replayed.output?.versionId, output.versionId);
});

test('AC-3b: the single-ingredient kinds run through the format/crop/passthrough doubles (the declared contract shapes)', async () => {
  const source = await materializedAsset(
    alice.agencyId,
    aliceClientId, aliceEvidenceA, 'Format source', new Uint8Array([11, 22, 33]),
  );

  // The format double: parameters in, measurable output out.
  const formatRequest = await contentAssets().requestTransformation(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: aliceWorkspaceId,
      transformationKind: 'format',
      parameters: { target_format: 'mp4' },
      outputSpec: { mediaKind: 'video', displayName: 'Transcoded output' },
      ingredients: [{ assetId: source.assetId, version: 1 }],
      engineId: 'first-party:format-double',
    },
    MODULE_PROVENANCE,
  );
  assert.equal(formatRequest.transformation.engineId, 'first-party:format-double');
  const formatRun = await contentAssets().executeTransformation(
    { transformationId: formatRequest.transformation.transformationId },
    MODULE_PROVENANCE,
  );
  assert.equal(formatRun.transformation.status, 'completed');
  assert.ok(formatRun.output !== null);
  assert.ok(formatRun.output.objectSize! > 3, 'the synthetic container carries the header + the source bytes');

  // The crop double: the declared rectangle parameters.
  const cropRequest = await contentAssets().requestTransformation(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: aliceWorkspaceId,
      transformationKind: 'crop',
      parameters: { x: 0, y: 0, width: 320, height: 240 },
      outputSpec: { mediaKind: 'video', displayName: 'Cropped output' },
      ingredients: [{ assetId: source.assetId, version: 1 }],
      engineId: 'first-party:crop-double',
    },
    MODULE_PROVENANCE,
  );
  const cropRun = await contentAssets().executeTransformation(
    { transformationId: cropRequest.transformation.transformationId },
    MODULE_PROVENANCE,
  );
  assert.equal(cropRun.transformation.status, 'completed');

  // The passthrough double: a TRUE no-op — the output object converges
  // to the SAME content-addressed key as the input.
  const passthroughRequest = await contentAssets().requestTransformation(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: aliceWorkspaceId,
      transformationKind: 'clip',
      parameters: { start_ms: 0, end_ms: 1000 },
      outputSpec: { mediaKind: 'video', displayName: 'Clipped output' },
      ingredients: [{ assetId: source.assetId, version: 1 }],
      engineId: 'first-party:passthrough',
    },
    MODULE_PROVENANCE,
  );
  const passthroughRun = await contentAssets().executeTransformation(
    { transformationId: passthroughRequest.transformation.transformationId },
    MODULE_PROVENANCE,
  );
  assert.equal(passthroughRun.transformation.status, 'completed');
  const passthroughOutput = passthroughRun.output!;
  assert.equal(
    passthroughOutput.objectKey,
    (await contentAssets().getAssetVersion(source.versionId))?.objectKey,
    'the passthrough no-op output converges to the same content-addressed key',
  );

  // A DERIVED version can itself be transformed (the composition chain —
  // lineage retained at every level).
  const chained = await contentAssets().requestTransformation(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: aliceWorkspaceId,
      transformationKind: 'format',
      parameters: { target_format: 'webm' },
      outputSpec: { mediaKind: 'video', displayName: 'Chained output' },
      ingredients: [{ assetId: passthroughOutput.assetId, version: 1 }],
      engineId: 'first-party:format-double',
    },
    MODULE_PROVENANCE,
  );
  const chainedRun = await contentAssets().executeTransformation(
    { transformationId: chained.transformation.transformationId },
    MODULE_PROVENANCE,
  );
  assert.equal(chainedRun.transformation.status, 'completed');
  const chainedLinks = await contentRights().listLineageLinks(
    aliceClientId,
    chainedRun.output!.assetRef,
  );
  assert.equal(chainedLinks.length, 1);
  assert.equal(chainedLinks[0]?.ingredientAssetRef, passthroughOutput.assetRef);
});

test('AC-3c: the failure path settles both records honestly (engine error → requested → failed + execution failed safe); a failed transformation never reopens', async () => {
  const source = await materializedAsset(
    alice.agencyId,
    aliceClientId, aliceEvidenceA, 'Failing source', new Uint8Array([1, 1, 2, 3, 5]),
  );
  // The compilation double with a SINGLE ingredient is fine, but the
  // format double REJECTS a missing target_format — the engine error
  // path.
  const requested = await contentAssets().requestTransformation(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: aliceWorkspaceId,
      transformationKind: 'format',
      parameters: { wrong_parameter: true },
      outputSpec: { mediaKind: 'video', displayName: 'Failing output' },
      ingredients: [{ assetId: source.assetId, version: 1 }],
      engineId: 'first-party:format-double',
    },
    MODULE_PROVENANCE,
  );
  await assert.rejects(
    () => contentAssets().executeTransformation(
      { transformationId: requested.transformation.transformationId },
      MODULE_PROVENANCE,
    ),
    (error: unknown) => {
      assert.match(error instanceof Error ? error.message : '', /target_format/);
      return true;
    },
  );
  // Both records settled: the transformation failed, the execution
  // failed (safe classification).
  const failed = await contentAssets().getTransformation(requested.transformation.transformationId);
  assert.equal(failed?.status, 'failed');
  assert.match(failed?.failureReason ?? '', /target_format/);
  const execution = await executionsModule().getExecution(requested.transformation.executionRef);
  assert.equal(execution?.status, 'failed');
  assert.equal(execution?.retryClassification, 'safe');

  // A FAILED transformation is settled — a retry is a NEW request.
  await assert.rejects(
    () => contentAssets().executeTransformation(
      { transformationId: requested.transformation.transformationId },
      MODULE_PROVENANCE,
    ),
    (error: unknown) => {
      assert.match(error instanceof Error ? error.message : 'has FAILED', /has FAILED/);
      return true;
    },
  );
});

test('AC-3d: a kind with NO registered engine fails closed at request time (the MKT-056 discipline) — at module level AND over real HTTP against the EMPTY production registry', async () => {
  const source = await materializedAsset(
    alice.agencyId,
    aliceClientId, aliceEvidenceA, 'Unservable source', new Uint8Array([8, 6, 7]),
  );

  // Module level: the registry under test deliberately carries the
  // disclosed passthrough double for EVERY kind (a no-op), so the
  // module-level fail-closed here is the DECLARED-missing-engine path —
  // an engineId that is not registered (or does not support the kind)
  // is refused before any write.
  await assert.rejects(
    () => contentAssets().requestTransformation(
      {
        agencyId: alice.agencyId,
        clientId: aliceClientId,
        workspaceId: aliceWorkspaceId,
        transformationKind: 'voice',
        parameters: { voice: 'narrator-a' },
        outputSpec: { mediaKind: 'audio', displayName: 'Voiced output' },
        ingredients: [{ assetId: source.assetId, version: 1 }],
        engineId: 'first-party:missing-engine',
      },
      MODULE_PROVENANCE,
    ),
    (error: unknown) => {
      assert.match(error instanceof Error ? error.message : '', /no registered transformation engine/);
      return true;
    },
  );
  // The same fail-closed for a declared engine that does not support
  // the requested kind.
  await assert.rejects(
    () => contentAssets().requestTransformation(
      {
        agencyId: alice.agencyId,
        clientId: aliceClientId,
        workspaceId: aliceWorkspaceId,
        transformationKind: 'crop',
        parameters: { x: 0, y: 0, width: 10, height: 10 },
        outputSpec: { mediaKind: 'video', displayName: 'Nope' },
        ingredients: [{ assetId: source.assetId, version: 1 }],
        engineId: 'first-party:missing-engine',
      },
      MODULE_PROVENANCE,
    ),
    (error: unknown) => {
      assert.match(error instanceof Error ? error.message : '', /no registered transformation engine/);
      return true;
    },
  );

  // HTTP level: the SPAWNED API process carries the EMPTY production
  // registry — the request fails closed over real HTTP (409).
  const httpUnservable = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/content-assets/transformations`,
    {
      token: alice.token,
      body: {
        transformationKind: 'voice',
        parameters: { voice: 'narrator-a' },
        outputSpec: { mediaKind: 'audio', displayName: 'Voiced output' },
        ingredients: [{ assetId: source.assetId, version: 1 }],
        workspaceId: aliceWorkspaceId,
      },
    },
  );
  assert.equal(httpUnservable.status, 409, JSON.stringify(httpUnservable.body));
  assert.match(
    String((httpUnservable.body['error'] as Record<string, unknown> | undefined)?.['message'] ?? ''),
    /no registered transformation engine/,
  );
});

test('AC-3e: the transformation record discipline is DB-fenced — terminal moves only, the 1:1 execution fence, the frozen request', async () => {
  const source = await materializedAsset(
    alice.agencyId,
    aliceClientId, aliceEvidenceA, 'Discipline source', new Uint8Array([5, 5, 5]),
  );
  const requested = await contentAssets().requestTransformation(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: aliceWorkspaceId,
      transformationKind: 'clip',
      parameters: { start_ms: 0, end_ms: 500 },
      outputSpec: { mediaKind: 'video', displayName: 'Discipline output' },
      ingredients: [{ assetId: source.assetId, version: 1 }],
      engineId: 'first-party:passthrough',
    },
    MODULE_PROVENANCE,
  );
  // Run the transformation to completion FIRST: the terminal-move
  // battery below needs a settled row.
  await contentAssets().executeTransformation(
    { transformationId: requested.transformation.transformationId },
    MODULE_PROVENANCE,
  );
  const tid = requested.transformation.transformationId;

  // A completed row cannot move to failed (terminal rows never reopen).
  await assertDbRejects(
    "UPDATE content_transformations SET status = 'failed', failure_reason = 'late', version_cas = version_cas + 1 WHERE transformation_id = $1 AND status = 'completed'",
    [tid],
    'illegal content transformation status move',
  );
  // The parameters are immutable (on the settled row).
  await assertDbRejects(
    "UPDATE content_transformations SET parameters = '{\"changed\": true}'::jsonb WHERE transformation_id = $1 AND status = 'completed'",
    [tid],
    'parameters and output spec are immutable',
  );
  // DELETE is rejected.
  await assertDbRejects(
    'DELETE FROM content_transformations WHERE transformation_id = $1',
    [tid],
    'cannot be deleted',
  );
  // The ingredient links are fully append-only.
  await assertDbRejects(
    'DELETE FROM content_transformation_ingredients WHERE transformation_id = $1',
    [tid],
    'is append-only',
  );
  await assertDbRejects(
    'UPDATE content_transformation_ingredients SET position = 99 WHERE transformation_id = $1',
    [tid],
    'is append-only',
  );
  // The lifecycle event tail is fully append-only.
  await assertDbRejects(
    'DELETE FROM content_asset_lifecycle_events WHERE version_id = $1',
    [source.versionId],
    'is append-only',
  );
});

// ---------------------------------------------------------------------------
// AC-4: the 063 gate interplay (boundary rule 5 — blocked ingredients
// are transformable but the composite can never pass the gate)
// ---------------------------------------------------------------------------

test('AC-4: a rights-BLOCKED ingredient is transformable, but the derived composite is UNPUBLISHABLE (the 063 conjunction through this module\'s lineage links)', async () => {
  // Alice's owned ingredient (allow at the gate).
  const ownedBytes = new Uint8Array([1, 2, 3]);
  const owned = await materializedAsset(alice.agencyId, aliceClientId, aliceEvidenceA, 'Owned ingredient', ownedBytes);
  await contentRights().registerContentRights(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      contentAssetRef: owned.assetRef,
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
      rightsRecordId: (await contentRights().getRightsRecordForAsset(aliceClientId, owned.assetRef))!.rightsRecordId,
      eventKind: 'determination',
      toState: 'owned',
      reason: 'the agency owns this source material',
      clearance: null,
    },
    MODULE_PROVENANCE,
  );

  // Alice's BLOCKED ingredient (a revoked asset — definite negative).
  const blockedBytes = new Uint8Array([4, 5, 6]);
  const blocked = await materializedAsset(alice.agencyId, aliceClientId, aliceEvidenceB, 'Blocked ingredient', blockedBytes);
  await contentRights().registerContentRights(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      contentAssetRef: blocked.assetRef,
      assetKind: 'source',
      sourceEvidenceRef: aliceEvidenceB,
      licenceLabel: null,
      licenceEvidenceRef: null,
      validUntil: null,
    },
    MODULE_PROVENANCE,
  );
  await contentRights().recordRightsTransition(
    {
      rightsRecordId: (await contentRights().getRightsRecordForAsset(aliceClientId, blocked.assetRef))!.rightsRecordId,
      eventKind: 'determination',
      toState: 'blocked',
      reason: 'the source holder revoked redistribution',
      clearance: null,
    },
    MODULE_PROVENANCE,
  );

  // THE TRANSFORM STILL RUNS (the module NEVER checks rights — boundary
  // rule 5: transformation records lineage only).
  const compiled = await contentAssets().requestTransformation(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: aliceWorkspaceId,
      transformationKind: 'compilation',
      parameters: { layout: 'side-by-side' },
      outputSpec: { mediaKind: 'video', displayName: 'Mixed composite' },
      ingredients: [
        { assetId: owned.assetId, version: 1 },
        { assetId: blocked.assetId, version: 1 },
      ],
      engineId: 'test:compilation-concat',
    },
    MODULE_PROVENANCE,
  );
  const run = await contentAssets().executeTransformation(
    { transformationId: compiled.transformation.transformationId },
    MODULE_PROVENANCE,
  );
  assert.equal(run.transformation.status, 'completed', 'the blocked ingredient did NOT block the transformation');

  // The owned ingredient alone WOULD publish (the gate allows).
  const ownedGate = await contentRights().evaluatePublicationGate(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      assetRef: owned.assetRef,
      destinationPlatform: 'youtube',
    },
    MODULE_PROVENANCE,
  );
  assert.equal(ownedGate.outcome, 'allow');

  // The DERIVED COMPOSITE can NEVER pass the gate: without a rights
  // record it is blocked (absent); WITH a composite record the
  // conjunction resolves through EXACTLY the lineage links this module
  // recorded — the blocked ingredient blocks the composite.
  const noRecordGate = await contentRights().evaluatePublicationGate(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      assetRef: run.output!.assetRef,
      destinationPlatform: 'youtube',
    },
    MODULE_PROVENANCE,
  );
  assert.equal(noRecordGate.outcome, 'blocked');
  assert.ok(noRecordGate.reasons.some((reason) => reason.code === 'no_rights_record'));

  // Register the composite rights record (a composite with the recorded
  // lineage) — the conjunction blocks through the blocked ingredient.
  await contentRights().registerContentRights(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      contentAssetRef: run.output!.assetRef,
      assetKind: 'composite',
      sourceEvidenceRef: aliceEvidenceA,
      licenceLabel: null,
      licenceEvidenceRef: null,
      validUntil: null,
    },
    MODULE_PROVENANCE,
  );
  const compositeGate = await contentRights().evaluatePublicationGate(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      assetRef: run.output!.assetRef,
      destinationPlatform: 'youtube',
    },
    MODULE_PROVENANCE,
  );
  assert.equal(compositeGate.outcome, 'blocked');
  assert.ok(compositeGate.reasons.some((reason) => reason.code === 'ingredient_blocked'));
  assert.ok(compositeGate.composite);

  // THE ASSET-REF GRAMMAR INTEROP: the rights record for the minted ref
  // resolves through BOTH surfaces — the 063 by-asset read and the
  // ContentAssetReferencePort (the typed seam the module satisfies).
  const rightsForRef = await contentRights().getRightsRecordForAsset(aliceClientId, run.output!.assetRef);
  assert.ok(rightsForRef !== null);
  assert.equal(rightsForRef.contentAssetRef, run.output!.assetRef);
  const referencePort = createContentAssetReferencePort(contentAssets());
  const resolved = await referencePort.resolveContentAssetRef(aliceClientId, run.output!.assetRef);
  assert.deepEqual(resolved, { exists: true });
  const resolvedForeign = await referencePort.resolveContentAssetRef(bobClientId, run.output!.assetRef);
  assert.deepEqual(resolvedForeign, { exists: false });
});

// ---------------------------------------------------------------------------
// AC-5: the Client isolation battery (uniform 404, no cross-tenant oracle)
// ---------------------------------------------------------------------------

test('AC-5: cross-Client isolation — reads, materialization, observation, transformation and execution all fail closed; cross-Client ingredient linkage is DB-rejected', async () => {
  const aliceBytes = new Uint8Array([2, 4, 6]);
  const aliceAsset = await materializedAsset(alice.agencyId, aliceClientId, aliceEvidenceA, 'Alice asset', aliceBytes);
  const bobAsset = await materializedAsset(bob.agencyId, bobClientId, bobEvidence, 'Bob asset', new Uint8Array([6, 4, 2]));

  // HTTP: Bob reading Alice's version by id is the uniform 404.
  const foreignRead = await apiCall(
    port(),
    `/api/clients/${bobClientId}/content-assets/${aliceAsset.versionId}`,
    { token: bob.token },
  );
  assert.equal(foreignRead.status, 404);
  // Bob resolving Alice's ref in his client is the same uniform 404.
  const foreignByRef = await apiCall(
    port(),
    `/api/clients/${bobClientId}/content-assets/by-ref/${aliceAsset.assetRef}`,
    { token: bob.token },
  );
  assert.equal(foreignByRef.status, 404);
  // Bob materializing/observing Alice's version is the uniform 404.
  const foreignMaterialize = await apiCall(
    port(),
    `/api/clients/${bobClientId}/content-assets/${aliceAsset.versionId}/materialize`,
    { token: bob.token, body: { bytesBase64: Buffer.from(new Uint8Array([1])).toString('base64') } },
  );
  assert.equal(foreignMaterialize.status, 404);
  const foreignObserve = await apiCall(
    port(),
    `/api/clients/${bobClientId}/content-assets/${aliceAsset.versionId}/observations`,
    { token: bob.token, body: { metric: 'fps', numericValue: '30' } },
  );
  assert.equal(foreignObserve.status, 404);

  // Module: a cross-client transformation (Bob's workspace + Alice's
  // ingredient) is the uniform 404 on the ingredient.
  await assert.rejects(
    () => contentAssets().requestTransformation(
      {
        agencyId: bob.agencyId,
        clientId: bobClientId,
        workspaceId: bobWorkspaceId,
        transformationKind: 'compilation',
        parameters: {},
        outputSpec: { mediaKind: 'video', displayName: 'Cross-client composite' },
        ingredients: [{ assetId: aliceAsset.assetId, version: 1 }],
        engineId: null,
      },
      MODULE_PROVENANCE,
    ),
    (error: unknown) => {
      assert.match(error instanceof Error ? error.message : '', /not found/i);
      return true;
    },
  );

  // Module: a foreign version id read is null (the port resolves
  // nothing cross-client).
  const foreignVersion = await contentAssets().resolveAssetRef(bobClientId, aliceAsset.assetRef);
  assert.equal(foreignVersion, null);

  // The ownership resolution surface: a foreign (Bob-owned) version id
  // resolves to null under Alice's client scope — the route layer
  // surfaces the same uniform 404 (no cross-tenant oracle).
  const foreignOwnership = await contentAssets().resolveContentAssetsOwnership(bobAsset.versionId);
  assert.ok(foreignOwnership !== null, 'the ownership resolution itself is scope-agnostic');
  assert.notEqual(foreignOwnership.version.clientId, aliceClientId);

  // Bob executing Alice's transformation is the uniform 404 (the module
  // resolves ownership; the route layer narrows by client).
  const aliceTransformation = await contentAssets().requestTransformation(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: aliceWorkspaceId,
      transformationKind: 'clip',
      parameters: { start_ms: 0, end_ms: 100 },
      outputSpec: { mediaKind: 'video', displayName: 'Alice clip' },
      ingredients: [{ assetId: aliceAsset.assetId, version: 1 }],
      engineId: 'first-party:passthrough',
    },
    MODULE_PROVENANCE,
  );
  // Bob cannot even address it through the route surface (uniform 404).
  const foreignExecute = await apiCall(
    port(),
    `/api/clients/${bobClientId}/content-assets/transformations/${aliceTransformation.transformation.transformationId}/execute`,
    { token: bob.token, body: {} },
  );
  assert.equal(foreignExecute.status, 404);
  const foreignTransformationRead = await apiCall(
    port(),
    `/api/clients/${bobClientId}/content-assets/transformations/${aliceTransformation.transformation.transformationId}`,
    { token: bob.token },
  );
  assert.equal(foreignTransformationRead.status, 404);

  // DB fences: a cross-Client ingredient link is rejected by the
  // database itself (the migration-053 same-Client trigger).
  await assertDbRejects(
    `INSERT INTO content_transformation_ingredients
       (ingredient_id, transformation_id, input_version_id, input_asset_ref, position,
        recorded_by_actor, recorded_via, correlation_id, causation_id, created_at)
     VALUES ($1, $2, $3, $4, 0, 'sql-test', 'test', 'sql-test', NULL, now())`,
    [
      '22222222-3333-4444-8555-666666666666',
      aliceTransformation.transformation.transformationId,
      bobAsset.versionId,
      bobAsset.assetRef,
    ],
    'cross-Client composition is rejected',
  );

  // DB fences: a cross-Client evidence anchor is rejected (the
  // migration-053 same-Client trigger on the version rows).
  await assertDbRejects(
    `INSERT INTO content_asset_versions
       (version_id, asset_id, agency_id, client_id, workspace_id, version, asset_ref,
        media_kind, display_name, content_type, lifecycle_state, source_evidence_ref,
        created_by_actor, created_via, correlation_id)
     SELECT $1, asset_id, agency_id, client_id, workspace_id, version + 50, $2,
        'video', 'Cross evidence', 'video/mp4', 'draft', $3, 'sql-test', 'test', 'sql-test'
       FROM content_asset_versions WHERE version_id = $4`,
    [
      '33333333-4444-4555-8666-777777777777',
      `ca:33333333-4444-4555-8666-777777777777`,
      bobEvidence,
      aliceAsset.versionId,
    ],
    'cross-tenant evidence linkage is rejected',
  );

  // The auth battery: anonymous is 401.
  const anonymous = await apiCall(port(), `/api/clients/${aliceClientId}/content-assets`, {
    body: { mediaKind: 'video', displayName: 'x', contentType: 'video/mp4', sourceEvidenceRef: aliceEvidenceA },
  });
  assert.equal(anonymous.status, 401);
});

// ---------------------------------------------------------------------------
// AC-6: the remaining DB backstops (the status shapes)
// ---------------------------------------------------------------------------

test('AC-6: the status-shape CHECKs are DB-enforced (completed carries the output link; failed never does)', async () => {
  const source = await materializedAsset(
    alice.agencyId,
    aliceClientId, aliceEvidenceA, 'Shape source', new Uint8Array([13]),
  );
  const requested = await contentAssets().requestTransformation(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: aliceWorkspaceId,
      transformationKind: 'clip',
      parameters: { start_ms: 0, end_ms: 100 },
      outputSpec: { mediaKind: 'video', displayName: 'Shape output' },
      ingredients: [{ assetId: source.assetId, version: 1 }],
      engineId: 'first-party:passthrough',
    },
    MODULE_PROVENANCE,
  );
  // A completed row WITHOUT the output version link is rejected by the
  // status-shape CHECK.
  await assertDbRejects(
    "UPDATE content_transformations SET status = 'completed', completed_at = now(), version_cas = version_cas + 1 WHERE transformation_id = $1",
    [requested.transformation.transformationId],
    'content_transformation_status_shape',
  );
  // A failed row WITH an output link is likewise rejected.
  await assertDbRejects(
    "UPDATE content_transformations SET status = 'failed', failure_reason = 'x', output_version_id = $2, version_cas = version_cas + 1 WHERE transformation_id = $1",
    [requested.transformation.transformationId, source.versionId],
    'content_transformation_status_shape',
  );
});
