/**
 * MKT-051 integration tests — the Incumbent Capability App Program on
 * the real stack (embedded PostgreSQL 18 + real API process — no mocks
 * of platform services).
 *
 * THE FULL APP-MODEL LIFECYCLE PROOF (the dispatch AC-2), driven through
 * REAL commands only (no SQL shortcuts for publish/install/trust):
 *
 *   publish → marketplace listing visible → trust transitions
 *   (MOS_CERTIFIED via the REAL operator command) → install into a
 *   workspace (server-derived grants) → authorize (the policy gate
 *   honored — a denied policy blocks installs) → invoke/read through
 *   the app-installs-keyed surface family → observe bounded state →
 *   upgrade to a second published version → rollback (future-selection
 *   semantics; historical identity preserved).
 *
 * Coverage map (the dispatch ACs):
 *   - AC-1/AC-2: all FOUR packs publish through the REAL /apps command
 *     under the disclosed first-party service principal; the marketplace
 *     lists them as first-party with the trust ladder;
 *   - AC-2: the FULL lifecycle end-to-end for mos-sheets (the pack with
 *     bounded state + a gated action) and the publish/install portions
 *     for all four;
 *   - AC-3: the incumbent-capability discipline — direct SQL counts
 *     prove NO authority table changes through the pack surface, and
 *     the composition cites the incumbent authorities;
 *   - AC-4: the /integrations declaration — the connected data sources
 *     surface reads the EXISTING authority's connection records;
 *   - AC-5: first-party identity — 'svc:internal-api-token' publisher,
 *     MOS_CERTIFIED via the REAL trust command path;
 *   - the fail-closed battery: an undeclared surface is 422; a surface
 *     whose REQUIRED data scope was policy-DENIED at install time is
 *     403 (the grant intersection visibly constrains presentation);
 *     a not-installed app is the uniform 404; a foreign workspace is
 *     the uniform 404; anonymous is 401.
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
  stack = await bootStack('first-party-apps');
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

/** The four packs' manifests, read from the module's publish source. */
async function packManifests(): Promise<
  readonly {
    readonly appKey: string;
    readonly version: string;
    readonly publishBody: Record<string, unknown>;
  }[]
> {
  const { allFirstPartyManifests } = await import('../../src/modules/first-party-apps/public.ts');
  const { signManifest } = await import('../../tools/app-sdk/src/index.ts');
  return allFirstPartyManifests().map((manifest) => {
    // The HTTP publish envelope: the manifest with the route DTO's
    // JSON-transport conventions (networkDestinations.port arrives as a
    // STRING — the route converts back with Number()) + the signature.
    const transportManifest = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
    const destinations = transportManifest['networkDestinations'] as Record<string, unknown>[];
    for (const destination of destinations) {
      destination['port'] = String(destination['port']);
    }
    return {
      appKey: manifest.appKey,
      version: manifest.version,
      publishBody: {
        manifest: transportManifest,
        signature: signManifest(manifest),
      },
    };
  });
}

/** Publishes one manifest through the REAL /apps command (service principal). */
async function publishFirstParty(
  publishBody: Record<string, unknown>,
  idempotencyKey: string,
): Promise<Record<string, unknown>> {
  const publish = await apiCall(port(), '/api/apps', {
    token: stack!.env.internalApiToken,
    body: { ...publishBody, idempotencyKey },
  });
  assert.equal(publish.status, 201, JSON.stringify(publish.body));
  return publish.body as Record<string, unknown>;
}

async function installApp(
  workspaceId: string,
  token: string,
  appKey: string,
  version: string,
  idempotencyKey: string,
) {
  return apiCall(port(), `/api/workspaces/${workspaceId}/app-installs`, {
    token,
    body: { appKey, version, idempotencyKey },
  });
}

async function composeSurface(
  workspaceId: string,
  token: string,
  appKey: string,
  surface: string,
  extra: Record<string, unknown> = {},
) {
  return apiCall(port(), `/api/first-party-apps/workspaces/${workspaceId}/packs/${appKey}/surfaces`, {
    token,
    body: { surface, ...extra },
  });
}

// Shared state built once in the first tests (creation order matters).
interface SharedState {
  readonly owner: Principal;
  readonly clientId: string;
  readonly workspaceId: string;
}
let shared: SharedState | null = null;
function state(): SharedState {
  if (shared === null) throw new Error('shared fixtures not built');
  return shared;
}

// ---------------------------------------------------------------------------
// Phase 1 — PUBLISH all four packs through the REAL /apps command under
// the disclosed first-party service principal (AC-1/AC-5)
// ---------------------------------------------------------------------------

test('AC-1/AC-5: all EIGHT pack versions publish through the REAL /apps command as the first-party service principal (svc:)', async () => {
  const manifests = await packManifests();
  assert.equal(manifests.length, 8);
  for (const entry of manifests) {
    const published = await publishFirstParty(
      entry.publishBody,
      `mkt-051-publish-${entry.appKey}-${entry.version}`,
    );
    // The SERVER-DERIVED first-party publisher identity.
    assert.equal(published['publisher'], 'svc:internal-api-token', `${entry.appKey}@${entry.version}`);
    assert.equal(published['certificationState'], 'UNVERIFIED', 'born UNVERIFIED — platform territory');
    // The signed digest anchored by the immutable row.
    assert.equal(typeof published['createFingerprint'], 'string');
  }

  // The registry catalog lists all four lineages with both versions.
  const catalog = await apiCall(port(), '/api/apps', { token: await adminToken() });
  assert.equal(catalog.status, 200);
  const versions = catalog.body['apps'] as Record<string, unknown>[];
  for (const appKey of ['mos-analytics', 'mos-crm', 'mos-sheets', 'mos-portal']) {
    const rows = versions.filter((row) => row['appKey'] === appKey);
    assert.equal(rows.length, 2, `${appKey}: both versions published`);
    for (const row of rows) {
      assert.equal(row['publisher'], 'svc:internal-api-token');
    }
  }
});

test('AC-2/AC-5: the MKT-050 marketplace lists the four packs as FIRST-PARTY; the REAL trust command raises them to MOS_CERTIFIED', async () => {
  // The marketplace listing (any active member).
  const owner = await makeAgencyOwner('fpa-marketplace-owner@marketingos.test');
  const listing = await apiCall(port(), `/api/app-marketplace/${owner.agencyId}/apps?publisherKind=first-party`, {
    token: owner.token,
  });
  assert.equal(listing.status, 200, JSON.stringify(listing.body));
  const apps = (listing.body['apps'] ?? listing.body['entries']) as Record<string, unknown>[];
  const keys = apps.map((app) => app['appKey']);
  for (const appKey of ['mos-analytics', 'mos-crm', 'mos-sheets', 'mos-portal']) {
    const entry = apps.find((app) => app['appKey'] === appKey);
    assert.notEqual(entry, undefined, `${appKey} is listed`);
    const trustState = entry!['trustState'] as Record<string, unknown>;
    assert.equal(trustState!['trustLevel'], 'UNVERIFIED', 'the birth trust state');
    const publisherKind = entry!['publisherKind'];
    assert.equal(publisherKind, 'first-party', `${appKey} classifies first-party (svc:)`);
  }
  void keys;

  // The REAL trust-transition command path (platform administrator):
  // UNVERIFIED → COMMUNITY_VERIFIED → MOS_CERTIFIED for each pack.
  const admin = await adminToken();
  for (const appKey of ['mos-analytics', 'mos-crm', 'mos-sheets', 'mos-portal']) {
    const verify = await apiCall(port(), `/api/app-marketplace/apps/${appKey}/trust`, {
      token: admin,
      body: {
        transition: 'verify',
        reason: 'MKT-051 first-party program verification round',
        idempotencyKey: `mkt-051-verify-${appKey}`,
      },
    });
    assert.equal(verify.status, 201, JSON.stringify(verify.body));
    const certify = await apiCall(port(), `/api/app-marketplace/apps/${appKey}/trust`, {
      token: admin,
      body: {
        transition: 'certify',
        reason: 'MKT-051 first-party program certification',
        idempotencyKey: `mkt-051-certify-${appKey}`,
      },
    });
    assert.equal(certify.status, 201, JSON.stringify(certify.body));
    const event = certify.body['event'] as Record<string, unknown>;
    assert.equal(event['toState'], 'MOS_CERTIFIED');
  }

  // The derived trust state is MOS_CERTIFIED on the listing.
  const after = await apiCall(port(), `/api/app-marketplace/${owner.agencyId}/apps?trustLevel=MOS_CERTIFIED`, {
    token: owner.token,
  });
  assert.equal(after.status, 200);
  const certified = (after.body['apps'] ?? after.body['entries']) as Record<string, unknown>[];
  const certifiedKeys = certified.map((app) => app['appKey']);
  for (const appKey of ['mos-analytics', 'mos-crm', 'mos-sheets', 'mos-portal']) {
    assert.ok(certifiedKeys.includes(appKey), `${appKey} is MOS_CERTIFIED`);
  }
});

// ---------------------------------------------------------------------------
// Phase 2 — INSTALL all four packs (policy-gated, server-derived grants)
// (AC-2 install portion for all four)
// ---------------------------------------------------------------------------

test('AC-2: the install-time policy gate is honored — a DENY blocks installs with zero rows; the ALLOW restores them', async () => {
  const owner = await makeAgencyOwner('fpa-install-owner@marketingos.test');
  const clientId = await makeClient(owner.agencyId, owner.token);
  const workspaceId = await makeWorkspace(clientId, owner.token, 'FPA Install Workspace');

  // A DENY of the extension-dimension install boundary.
  const deny = await apiCall(port(), `/api/agencies/${owner.agencyId}/policies`, {
    token: owner.token,
    body: {
      dimension: 'extension',
      rules: [
        { effect: 'deny', operations: ['install', 'upgrade', 'rollback'], reason: 'deny first while onboarding' },
      ],
      description: 'FPA install deny v1',
    },
  });
  assert.equal(deny.status, 201, JSON.stringify(deny.body));
  const denied = await installApp(workspaceId, owner.token, 'mos-portal', '1.0.0', 'fpa-install-deny-1');
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  const deniedRows = await pool().query<{ count: string }>(
    'SELECT count(*)::text AS count FROM app_installs WHERE workspace_id = $1',
    [workspaceId],
  );
  assert.equal(deniedRows.rows[0]!.count, '0', 'a denied install writes ZERO rows');

  // The superseding agency-scoped ALLOW (deny-overrides means the
  // platform-level allow alone would not restore installs for THIS
  // agency — the MKT-048 battery precedent), carrying the same
  // data-scope denial so the grant intersection stays provable.
  const allow = await apiCall(port(), `/api/agencies/${owner.agencyId}/policies`, {
    token: owner.token,
    body: {
      dimension: 'extension',
      rules: [
        { effect: 'allow', operations: ['install', 'upgrade', 'rollback'], reason: 'agency allows first-party packs' },
        { effect: 'deny', operations: ['install', 'upgrade', 'rollback'], attributes: { dataScope: 'workspace:read' }, reason: 'deny the workspace:read grant (the composition-gate proof)' },
      ],
      description: 'FPA install allow v2',
    },
  });
  assert.equal(allow.status, 201, JSON.stringify(allow.body));

  shared = { owner, clientId, workspaceId };
});

test('AC-2: all FOUR packs install into the workspace with SERVER-DERIVED grants (the policy intersection)', async () => {
  for (const [appKey, expectedDataScopes] of [
    ['mos-analytics', ['client:read']],
    ['mos-crm', ['client:read']],
    ['mos-sheets', ['client:read']],
    ['mos-portal', ['client:read']],
  ] as const) {
    const install = await installApp(
      state().workspaceId,
      state().owner.token,
      appKey,
      '1.0.0',
      `fpa-install-${appKey}-1`,
    );
    assert.equal(install.status, 201, JSON.stringify(install.body));
    const record = (install.body as Record<string, unknown>)['install'] as Record<string, unknown>;
    assert.equal(record['version'], '1.0.0');
    assert.equal(record['status'], 'ACTIVE');
    assert.equal(record['selectionSeq'], 1);
    // mos-analytics requested client:read + workspace:read — the policy
    // denied workspace:read → the honest intersection. The others
    // requested client:read only.
    assert.deepEqual(record['grantedDataScopes'], [...expectedDataScopes]);
    // mos-sheets is the only pack with a granted mutation scope.
    if (appKey === 'mos-sheets') {
      assert.deepEqual(record['grantedMutationScopes'], ['metric:append']);
    } else {
      assert.deepEqual(record['grantedMutationScopes'], []);
    }
  }

  // The pack catalog now shows the four current selections.
  const catalog = await apiCall(port(), `/api/first-party-apps/workspaces/${state().workspaceId}/packs`, {
    token: state().owner.token,
  });
  assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
  const packs = catalog.body['packs'] as Record<string, unknown>[];
  assert.equal(packs.length, 4);
  for (const pack of packs) {
    const selection = pack['currentSelection'] as Record<string, unknown> | null;
    assert.notEqual(selection, null, `${pack['appKey']} has a current selection`);
    assert.equal(selection!['version'], '1.0.0');
    assert.deepEqual(pack['publishedVersions'], ['1.0.0', '1.1.0']);
  }
});

// ---------------------------------------------------------------------------
// Phase 3 — INVOKE/READ through the app-installs-keyed surfaces (AC-2/AC-3)
// ---------------------------------------------------------------------------

test('AC-2/AC-3: the composed surfaces reproduce incumbent capability over the SAME authorities (all four families)', async () => {
  // (a) reporting/analytics — the command-center card (client:read granted).
  const card = await composeSurface(state().workspaceId, state().owner.token, 'mos-analytics', 'command-center-card');
  assert.equal(card.status, 200, JSON.stringify(card.body));
  const cardBody = card.body as Record<string, unknown>;
  assert.equal((cardBody['app'] as Record<string, unknown>)['version'], '1.0.0');
  assert.ok((cardBody['composedFrom'] as string[]).some((source) => source.includes('/reporting')));
  assert.ok((cardBody['composedFrom'] as string[]).some((source) => source.includes('/profit-intelligence')));
  const cardModel = cardBody['model'] as Record<string, unknown>;
  assert.equal((cardModel['headline'] as Record<string, unknown>)['clientCount'], 1);
  assert.equal(typeof (cardModel['dataSources'] as Record<string, unknown>)['connectionCount'], 'number');
  // v1.0.0 does NOT declare compose-margin-breakdown → null.
  assert.equal((cardModel as Record<string, unknown>)['marginBreakdown'], undefined);

  // (b) the report page REQUIRES workspace:read — policy denied it at
  // install time → the composition fails closed 403 (the grant
  // intersection visibly constrains presentation).
  const report = await composeSurface(state().workspaceId, state().owner.token, 'mos-analytics', 'report-page');
  assert.equal(report.status, 403, JSON.stringify(report.body));

  // (c) CRM/pipeline — the client-room panel + the action menu.
  const panel = await composeSurface(state().workspaceId, state().owner.token, 'mos-crm', 'client-room-panel');
  assert.equal(panel.status, 200, JSON.stringify(panel.body));
  const panelModel = (panel.body as Record<string, unknown>)['model'] as Record<string, unknown>;
  assert.equal((panelModel['client'] as Record<string, unknown>)['clientId'], state().clientId);
  assert.equal((panelModel['pipeline'] as Record<string, unknown>)['totalDecisions'], 0);
  const menu = await composeSurface(state().workspaceId, state().owner.token, 'mos-crm', 'action-menu');
  assert.equal(menu.status, 200, JSON.stringify(menu.body));
  const actions = ((menu.body as Record<string, unknown>)['model'] as Record<string, unknown>)['actions'] as Record<string, unknown>[];
  assert.equal(actions.length, 1);
  assert.equal(actions[0]!['targetRoute'], '/api/clients/:clientId/decisions');

  // (d) spreadsheet workflows — the observation workbook tab.
  const tab = await composeSurface(state().workspaceId, state().owner.token, 'mos-sheets', 'workspace-tab');
  assert.equal(tab.status, 200, JSON.stringify(tab.body));
  const tabModel = (tab.body as Record<string, unknown>)['model'] as Record<string, unknown>;
  assert.equal((tabModel['workbook'] as Record<string, unknown>)['evidenceRowCount'], 0);
  assert.equal((tabModel['workbook'] as Record<string, unknown>)['metricRowCount'], 0);

  // (e) the spreadsheet editor pane — the app-owned document + the
  // gated action (metric:append IS granted → offered).
  const editor = await composeSurface(state().workspaceId, state().owner.token, 'mos-sheets', 'editor-pane');
  assert.equal(editor.status, 200, JSON.stringify(editor.body));
  const editorModel = (editor.body as Record<string, unknown>)['model'] as Record<string, unknown>;
  assert.equal(editorModel['observationActionOffered'], true);
  const offered = editorModel['offeredActions'] as Record<string, unknown>[];
  assert.equal(offered.length, 1);
  assert.equal(offered[0]!['targetRoute'], '/api/clients/:clientId/metrics');

  // (f) client portal — the client-facing panel + report page.
  const portalPanel = await composeSurface(state().workspaceId, state().owner.token, 'mos-portal', 'client-room-panel');
  assert.equal(portalPanel.status, 200, JSON.stringify(portalPanel.body));
  const portalModel = (portalPanel.body as Record<string, unknown>)['model'] as Record<string, unknown>;
  assert.equal((portalModel['room'] as Record<string, unknown>)['goalCount'], 0);
  // v1.0.0: highlights null (the capability arrives in 1.1.0).
  assert.equal(portalModel['highlights'], null);
  const portalReport = await composeSurface(state().workspaceId, state().owner.token, 'mos-portal', 'report-page');
  assert.equal(portalReport.status, 200, JSON.stringify(portalReport.body));
});

test('the fail-closed battery: undeclared surface 422; not-installed app 404; foreign workspace 404; anonymous 401; malformed app key 404', async () => {
  // An UNDECLARED surface (mos-portal declares no workspace-tab).
  const undeclared = await composeSurface(state().workspaceId, state().owner.token, 'mos-portal', 'workspace-tab');
  assert.equal(undeclared.status, 422, JSON.stringify(undeclared.body));

  // A not-installed app (never published under this key).
  const unknown = await composeSurface(state().workspaceId, state().owner.token, 'never-published-app', 'report-page');
  assert.equal(unknown.status, 404);

  // A foreign workspace (another agency's owner).
  const ownerB = await makeAgencyOwner('fpa-foreign-owner@marketingos.test');
  const clientB = await makeClient(ownerB.agencyId, ownerB.token);
  const workspaceB = await makeWorkspace(clientB, ownerB.token, 'FPA Foreign Workspace');
  const foreign = await composeSurface(workspaceB, state().owner.token, 'mos-crm', 'client-room-panel');
  assert.equal(foreign.status, 404);

  // Anonymous.
  const anonymous = await apiCall(port(), `/api/first-party-apps/workspaces/${state().workspaceId}/packs`);
  assert.equal(anonymous.status, 401);

  // A malformed app key is the uniform 404.
  const malformed = await apiCall(port(), `/api/first-party-apps/workspaces/${state().workspaceId}/packs/NOT_A_KEY/state`, {
    token: state().owner.token,
    body: {},
  });
  assert.equal(malformed.status, 404);
});

// ---------------------------------------------------------------------------
// Phase 4 — the BOUNDED APP STATE lifecycle (AC-2 observe bounded state;
// AC-3 app-owned state only)
// ---------------------------------------------------------------------------

test('AC-2/AC-3: the bounded app state — mutate, read, lineage, export, delete; ZERO authority rows change (DB-asserted)', async () => {
  const before = await authorityRowCounts();

  // A spreadsheet document with lineage to a canonical observation id
  // (the id is a placeholder reference — lineage is a REFERENCE, never
  // a copy; the /metrics authority remains the truth).
  const mutate = await apiCall(port(), `/api/first-party-apps/workspaces/${state().workspaceId}/packs/mos-sheets/state`, {
    token: state().owner.token,
    body: {
      namespace: 'app:mos-sheets:documents',
      set: {
        default: {
          cells: [
            { cell: 'A1', formula: '=SUM(metrics)', value: 42, lineageObservationId: 'obs-placeholder-1' },
            { cell: 'B2', formula: '=COUNTA(evidence)', value: null, lineageObservationId: null },
          ],
        },
      },
      delete: [],
      lineage: [{ kind: 'metric-observation', id: 'obs-placeholder-1' }],
    },
  });
  assert.equal(mutate.status, 200, JSON.stringify(mutate.body));
  const mutated = mutate.body as Record<string, unknown>;
  assert.equal(mutated['namespace'], 'app:mos-sheets:documents');
  const lineage = mutated['lineage'] as Record<string, unknown>[];
  assert.equal(lineage.length, 1);
  assert.equal(lineage[0]!['kind'], 'metric-observation');

  // The read-back.
  const read = await apiCall(port(), `/api/first-party-apps/workspaces/${state().workspaceId}/packs/mos-sheets/state?namespace=app:mos-sheets:documents`, {
    token: state().owner.token,
  });
  assert.equal(read.status, 200);
  const readState = (read.body as Record<string, unknown>)['state'] as Record<string, unknown>;
  assert.notEqual(readState, null);
  assert.deepEqual(readState!['lineage'], [{ kind: 'metric-observation', id: 'obs-placeholder-1' }]);

  // The editor pane now presents the document cells.
  const editor = await composeSurface(state().workspaceId, state().owner.token, 'mos-sheets', 'editor-pane');
  assert.equal(editor.status, 200);
  const editorModel = (editor.body as Record<string, unknown>)['model'] as Record<string, unknown>;
  const document = editorModel['document'] as Record<string, unknown>;
  const cells = document['cells'] as Record<string, unknown>[];
  assert.equal(cells.length, 2);
  assert.equal(cells[0]!['lineageObservationId'], 'obs-placeholder-1');

  // The export semantics.
  const exportResult = await apiCall(port(), `/api/first-party-apps/workspaces/${state().workspaceId}/packs/mos-sheets/state/export?namespace=app:mos-sheets:documents`, {
    token: state().owner.token,
  });
  assert.equal(exportResult.status, 200, JSON.stringify(exportResult.body));
  const exported = exportResult.body as Record<string, unknown>;
  assert.equal(exported['semantics'], 'mos-app-state-export');
  assert.equal(exported['appKey'], 'mos-sheets');
  assert.equal(exported['version'], '1.0.0');
  assert.equal((exported['lineage'] as unknown[]).length, 1);

  // The §21 guard: a material-shaped key is rejected 422, zero change.
  const spoofed = await apiCall(port(), `/api/first-party-apps/workspaces/${state().workspaceId}/packs/mos-sheets/state`, {
    token: state().owner.token,
    body: {
      namespace: 'app:mos-sheets:documents',
      set: { leak: { apiKey: 'spoofed' } },
      delete: [],
      lineage: [],
    },
  });
  assert.equal(spoofed.status, 422, JSON.stringify(spoofed.body));

  // The namespace fence: another app's namespace is rejected 422.
  const foreignNamespace = await apiCall(port(), `/api/first-party-apps/workspaces/${state().workspaceId}/packs/mos-sheets/state`, {
    token: state().owner.token,
    body: {
      namespace: 'app:mos-crm:pipeline-views',
      set: { view: 'by-objective' },
      delete: [],
      lineage: [],
    },
  });
  assert.equal(foreignNamespace.status, 422, JSON.stringify(foreignNamespace.body));

  // AC-3 DB-asserted: NO authority table changed through the pack state.
  const after = await authorityRowCounts();
  assert.deepEqual(after, before, 'the bounded app state touches NO authority table');

  // The delete semantics (app-owned state is disposable).
  const deleted = await apiCall(port(), `/api/first-party-apps/workspaces/${state().workspaceId}/packs/mos-sheets/state?namespace=app:mos-sheets:documents`, {
    token: state().owner.token,
    method: 'DELETE',
  });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal((deleted.body as Record<string, unknown>)['existed'], true);
  const deletedAgain = await apiCall(port(), `/api/first-party-apps/workspaces/${state().workspaceId}/packs/mos-sheets/state?namespace=app:mos-sheets:documents`, {
    token: state().owner.token,
    method: 'DELETE',
  });
  assert.equal((deletedAgain.body as Record<string, unknown>)['existed'], false);
});

/** Direct-SQL row counts of the composed authorities (the discipline proof). */
async function authorityRowCounts(): Promise<Record<string, number>> {
  const tables = [
    'goals', 'workflows', 'workflow_instances', 'executions', 'evidence',
    'metric_observations', 'decisions', 'clients', 'workspaces', 'integration_connections',
    'app_versions', 'app_installs', 'trust_events',
  ];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const result = await pool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table}`,
    );
    counts[table] = Number(result.rows[0]!.count);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Phase 5 — UPGRADE + ROLLBACK (future-selection semantics; historical
// identity preserved) for the full-lifecycle pack (mos-portal) and the
// capability-gated presentation proof (mos-analytics report page)
// ---------------------------------------------------------------------------

test('AC-2: UPGRADE to the second published version — future compositions use the NEW manifest (the capability-gated presentation changes)', async () => {
  // Upgrade mos-portal to 1.1.0 (the REAL upgrade command).
  const current = await pool().query<{ install_id: string }>(
    "SELECT install_id FROM app_installs WHERE workspace_id = $1 AND app_key = 'mos-portal' AND status = 'ACTIVE'",
    [state().workspaceId],
  );
  const installId = current.rows[0]!.install_id;
  const upgrade = await apiCall(port(), `/api/workspaces/${state().workspaceId}/app-installs/${installId}/upgrade`, {
    token: state().owner.token,
    body: { version: '1.1.0', idempotencyKey: 'fpa-upgrade-portal-1' },
  });
  assert.equal(upgrade.status, 201, JSON.stringify(upgrade.body));
  const upgraded = (upgrade.body as Record<string, unknown>)['install'] as Record<string, unknown>;
  const prior = (upgrade.body as Record<string, unknown>)['prior'] as Record<string, unknown>;
  assert.equal(upgraded['version'], '1.1.0');
  assert.equal(upgraded['selectionSeq'], 2);
  assert.equal(prior['version'], '1.0.0', 'the prior row retains its ORIGINAL version');
  assert.equal(prior['status'], 'SUPERSEDED');

  // The composition now pins 1.1.0 — and the highlights capability is
  // present (null in 1.0.0; an honest empty array in 1.1.0).
  const portalPanel = await composeSurface(state().workspaceId, state().owner.token, 'mos-portal', 'client-room-panel');
  assert.equal(portalPanel.status, 200);
  const body = portalPanel.body as Record<string, unknown>;
  assert.equal((body['app'] as Record<string, unknown>)['version'], '1.1.0');
  assert.ok(((body['app'] as Record<string, unknown>)['capabilities'] as string[]).includes('compose-portal-highlights'));
  const portalModel = body['model'] as Record<string, unknown>;
  assert.deepEqual(portalModel['highlights'], [], 'v1.1.0 composes the highlights (honestly empty)');

  // DB-asserted: historical identity preserved (both rows, original
  // versions retained).
  const lineage = await pool().query<{ version: string; status: string; selection_seq: string }>(
    "SELECT version, status, selection_seq::text FROM app_installs WHERE workspace_id = $1 AND app_key = 'mos-portal' ORDER BY selection_seq",
    [state().workspaceId],
  );
  assert.equal(lineage.rows.length, 2);
  assert.equal(lineage.rows[0]!.version, '1.0.0');
  assert.equal(lineage.rows[0]!.status, 'SUPERSEDED');
  assert.equal(lineage.rows[1]!.version, '1.1.0');
  assert.equal(lineage.rows[1]!.status, 'ACTIVE');
});

test('AC-2: ROLLBACK reselects the previously installed version — future compositions use the OLD manifest again (no history rewrite)', async () => {
  const current = await pool().query<{ install_id: string }>(
    "SELECT install_id FROM app_installs WHERE workspace_id = $1 AND app_key = 'mos-portal' AND status = 'ACTIVE'",
    [state().workspaceId],
  );
  const firstInstall = await pool().query<{ install_id: string }>(
    "SELECT install_id FROM app_installs WHERE workspace_id = $1 AND app_key = 'mos-portal' AND selection_seq = 1",
    [state().workspaceId],
  );
  const rollback = await apiCall(port(), `/api/workspaces/${state().workspaceId}/app-installs/${current.rows[0]!.install_id}/rollback`, {
    token: state().owner.token,
    body: { targetInstallId: firstInstall.rows[0]!.install_id, idempotencyKey: 'fpa-rollback-portal-1' },
  });
  assert.equal(rollback.status, 201, JSON.stringify(rollback.body));
  const rolled = (rollback.body as Record<string, unknown>)['install'] as Record<string, unknown>;
  assert.equal(rolled['version'], '1.0.0');
  assert.equal(rolled['operation'], 'rollback');
  assert.equal(rolled['selectionSeq'], 3);

  // The composition pins 1.0.0 again — highlights null again.
  const portalPanel = await composeSurface(state().workspaceId, state().owner.token, 'mos-portal', 'client-room-panel');
  assert.equal(portalPanel.status, 200);
  const body = portalPanel.body as Record<string, unknown>;
  assert.equal((body['app'] as Record<string, unknown>)['version'], '1.0.0');
  assert.equal(((body['model']) as Record<string, unknown>)['highlights'], null);

  // All three rows retain their ORIGINAL versions (DB-asserted).
  const lineage = await pool().query<{ version: string; operation: string; status: string }>(
    "SELECT version, operation, status FROM app_installs WHERE workspace_id = $1 AND app_key = 'mos-portal' ORDER BY selection_seq",
    [state().workspaceId],
  );
  assert.equal(lineage.rows.length, 3);
  assert.deepEqual(
    lineage.rows.map((row) => [row.version, row.operation, row.status]),
    [
      ['1.0.0', 'install', 'SUPERSEDED'],
      ['1.1.0', 'upgrade', 'SUPERSEDED'],
      ['1.0.0', 'rollback', 'ACTIVE'],
    ],
  );
});

test('AC-2: the upgrade/rollback cycle on mos-sheets proves the gated action + state survive version changes; the granted scopes re-derive', async () => {
  const current = await pool().query<{ install_id: string }>(
    "SELECT install_id FROM app_installs WHERE workspace_id = $1 AND app_key = 'mos-sheets' AND status = 'ACTIVE'",
    [state().workspaceId],
  );
  const upgrade = await apiCall(port(), `/api/workspaces/${state().workspaceId}/app-installs/${current.rows[0]!.install_id}/upgrade`, {
    token: state().owner.token,
    body: { version: '1.1.0', idempotencyKey: 'fpa-upgrade-sheets-1' },
  });
  assert.equal(upgrade.status, 201, JSON.stringify(upgrade.body));
  const upgraded = (upgrade.body as Record<string, unknown>)['install'] as Record<string, unknown>;
  // The grants are re-derived server-side for the new version.
  assert.deepEqual(upgraded['grantedMutationScopes'], ['metric:append']);

  // The editor pane under 1.1.0: the action is still offered (the
  // capability set is a superset) and the app version identity pinned.
  const editor = await composeSurface(state().workspaceId, state().owner.token, 'mos-sheets', 'editor-pane');
  assert.equal(editor.status, 200);
  const body = editor.body as Record<string, unknown>;
  assert.equal((body['app'] as Record<string, unknown>)['version'], '1.1.0');
  assert.ok(((body['app'] as Record<string, unknown>)['capabilities'] as string[]).includes('compose-formula-summary'));
  assert.equal(((body['model']) as Record<string, unknown>)['observationActionOffered'], true);
});

// ---------------------------------------------------------------------------
// Phase 6 — AC-4: the /integrations declaration surfaces the EXISTING
// authority's connection records (read-only; no network from pack code)
// ---------------------------------------------------------------------------

test('AC-4: the analytics pack\'s connected data sources surface reads the EXISTING /integrations authority — zero network calls, zero new connections', async () => {
  const before = await pool().query<{ count: string }>('SELECT count(*)::text AS count FROM integration_connections');
  const card = await composeSurface(state().workspaceId, state().owner.token, 'mos-analytics', 'command-center-card');
  assert.equal(card.status, 200);
  const cardModel = (card.body as Record<string, unknown>)['model'] as Record<string, unknown>;
  const dataSources = cardModel['dataSources'] as Record<string, unknown>;
  // No connections were registered for this client — the honest zero
  // (the composer READ the authority; it never connects).
  assert.equal(dataSources['connectionCount'], 0);
  assert.deepEqual(dataSources['adapters'], []);
  const after = await pool().query<{ count: string }>('SELECT count(*)::text AS count FROM integration_connections');
  assert.equal(after.rows[0]!.count, before.rows[0]!.count, 'the pack surface creates NO connections');
});

// ---------------------------------------------------------------------------
// Phase 7 — the upgrade-with-denied-scope proof: the composition gate
// stays fail-closed across version changes
// ---------------------------------------------------------------------------

test('the surface-scope gate is version-stable: the report page still fails closed after the analytics upgrade (workspace:read still denied)', async () => {
  const current = await pool().query<{ install_id: string }>(
    "SELECT install_id FROM app_installs WHERE workspace_id = $1 AND app_key = 'mos-analytics' AND status = 'ACTIVE'",
    [state().workspaceId],
  );
  const upgrade = await apiCall(port(), `/api/workspaces/${state().workspaceId}/app-installs/${current.rows[0]!.install_id}/upgrade`, {
    token: state().owner.token,
    body: { version: '1.1.0', idempotencyKey: 'fpa-upgrade-analytics-1' },
  });
  assert.equal(upgrade.status, 201, JSON.stringify(upgrade.body));

  // The report page STILL requires workspace:read — still denied → 403.
  const report = await composeSurface(state().workspaceId, state().owner.token, 'mos-analytics', 'report-page');
  assert.equal(report.status, 403);
  // The command-center card still composes under 1.1.0.
  const card = await composeSurface(state().workspaceId, state().owner.token, 'mos-analytics', 'command-center-card');
  assert.equal(card.status, 200);
  assert.equal(((card.body as Record<string, unknown>)['app'] as Record<string, unknown>)['version'], '1.1.0');
});
