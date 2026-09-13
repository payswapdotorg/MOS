/**
 * MKT-049 unit tests — the App SDK FUNCTIONAL battery (scaffolding,
 * project validation rules, signing, docs generation and the typed HTTP
 * client surface; the drift pins live in app-sdk-drift.test.ts).
 *
 * Acceptance mapping (the MKT-049 dispatch):
 *   - AC-2 SCAFFOLDING: the scaffolder generates the COMPLETE project
 *     layout (manifest skeleton + capability contracts + UI-surface
 *     declarations + test skeleton + README); the scaffolded manifest
 *     is VALID against the REAL MKT-047 registry guard (the authority's
 *     own assertValidAppManifest — not just the SDK mirror); generation
 *     is DETERMINISTIC (byte-identical regeneration); scaffolding
 *     options are validated with clear messages;
 *   - AC-3 LOCAL VALIDATION: the project validator's STRUCTURAL rules
 *     (capability-contract reference resolution, version agreement,
 *     orphan files, UI-surface correspondence, test-file presence,
 *     signature verification) with clear file-prefixed messages;
 *   - AC-5 SIGNING: sign → verify round trip through the project
 *     layout; a tampered manifest invalidates the attestation with the
 *     re-sign hint;
 *   - AC-6 DOCUMENTATION: the offline generator renders the frozen
 *     vocabularies + the 19-field manifest reference + the signature
 *     guide;
 *   - AC-1 CLIENT SURFACE: the typed client issues the correct
 *     requests (method, path, auth header, body shapes) and maps
 *     responses/typed errors (404 → MosApiError, etc.) over a stubbed
 *     fetch — no network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertValidAppManifest } from '../../src/modules/apps/public.ts';
import { MosApiError, MosDeveloperPortalClient } from '../../tools/app-sdk/src/client.ts';
import { developerDocsModel, generateDeveloperDocsMarkdown } from '../../tools/app-sdk/src/docs.ts';
import { signManifest } from '../../tools/app-sdk/src/fingerprint.ts';
import {
  scaffoldAppProject,
  scaffoldManifest,
  scaffoldOptionProblems,
} from '../../tools/app-sdk/src/scaffold.ts';
import { validateAppProjectFiles } from '../../tools/app-sdk/src/validate.ts';
import { APP_PROJECT_FILES } from '../../tools/app-sdk/src/validate.ts';

// ---------------------------------------------------------------------------
// Fixtures: the scaffolded project as a file map
// ---------------------------------------------------------------------------

function scaffoldedFiles(overrides: ScaffoldInput = {}): Record<string, string> {
  const result = scaffoldAppProject({
    appKey: 'agency-analytics',
    ...(overrides.capabilities !== undefined ? { capabilities: overrides.capabilities } : {}),
    ...(overrides.surfaces !== undefined ? { surfaces: overrides.surfaces } : {}),
  });
  const files: Record<string, string> = {};
  for (const file of result.files) {
    files[file.path] = file.content;
  }
  return files;
}

interface ScaffoldInput {
  readonly capabilities?: readonly string[];
  readonly surfaces?: readonly ('command-center-card' | 'client-room-panel' | 'workspace-tab' | 'report-page' | 'editor-pane' | 'action-menu')[];
}

function setManifestField(files: Record<string, string>, mutate: (manifest: Record<string, unknown>) => void): void {
  const manifest = JSON.parse(files[APP_PROJECT_FILES.manifest]!) as Record<string, unknown>;
  mutate(manifest);
  files[APP_PROJECT_FILES.manifest] = `${JSON.stringify(manifest, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// AC-2 — scaffolding
// ---------------------------------------------------------------------------

test('MKT-049 AC-2: the scaffolder generates the COMPLETE project layout (manifest + capability contracts + UI surfaces + tests + README)', () => {
  const files = scaffoldedFiles();
  assert.deepEqual(Object.keys(files).sort(), [
    'README.md',
    'capabilities/hello-mos.json',
    'mos-app.json',
    'tests/app.test.ts',
    'ui/surfaces.json',
  ]);
});

test('MKT-049 AC-2: the scaffolded manifest is VALID against the REAL MKT-047 registry guard (the authority, not just the mirror)', () => {
  const manifest = scaffoldManifest({ appKey: 'agency-analytics' });
  // The authority's own publish-time guard accepts the skeleton.
  assertValidAppManifest(manifest);
});

test('MKT-049 AC-2: the scaffolded manifest declares capabilities, UI surfaces and an own-key state namespace', () => {
  const manifest = scaffoldManifest({ appKey: 'agency-analytics' });
  assert.equal(manifest.appKey, 'agency-analytics');
  assert.equal(manifest.version, '0.1.0');
  assert.ok(manifest.capabilities.length >= 1, 'at least one capability');
  assert.deepEqual(manifest.stateNamespaces, ['app:agency-analytics:documents']);
  assert.ok(manifest.uiSurfaces.every((surface) => surface.route.startsWith('/apps/agency-analytics')));
  // UI surfaces are presentation-only declarations of the closed vocabulary.
  assert.ok(manifest.uiSurfaces.every((surface) => surface.surface === 'command-center-card'));
});

test('MKT-049 AC-2: the scaffolder accepts multiple capabilities and multiple surface kinds', () => {
  const files = scaffoldedFiles({
    capabilities: ['render-dashboard', 'export-report'],
    surfaces: ['client-room-panel', 'workspace-tab'],
  });
  const manifest = JSON.parse(files['mos-app.json']!) as {
    capabilities: Array<{ name: string }>;
    uiSurfaces: Array<{ surface: string }>;
  };
  assert.deepEqual(
    manifest.capabilities.map((capability) => capability.name),
    ['render-dashboard', 'export-report'],
  );
  assert.deepEqual(
    manifest.uiSurfaces.map((surface) => surface.surface),
    ['client-room-panel', 'workspace-tab'],
  );
  assert.ok('capabilities/render-dashboard.json' in files);
  assert.ok('capabilities/export-report.json' in files);
  // The scaffolded project is VALID as a whole.
  const verdict = validateAppProjectFiles(files);
  assert.deepEqual([...verdict.problems], []);
  assert.ok(verdict.valid);
});

test('MKT-049 AC-2: scaffolding is DETERMINISTIC (byte-identical regeneration)', () => {
  const first = scaffoldAppProject({ appKey: 'agency-analytics' });
  const second = scaffoldAppProject({ appKey: 'agency-analytics' });
  assert.deepEqual(first.files, second.files);
  const other = scaffoldAppProject({ appKey: 'different-app' });
  assert.notDeepEqual(first.files, other.files);
});

test('MKT-049 AC-2: scaffolding option problems are clear (bad key, bad surface, bad version)', () => {
  assert.ok(scaffoldOptionProblems({ appKey: 'Bad_Key' }).length > 0);
  assert.ok(
    scaffoldOptionProblems({
      appKey: 'ok-app',
      surfaces: ['sidebar-widget'] as unknown as readonly ['command-center-card'],
    })[0]!.includes('closed UI-surface-kind vocabulary'),
  );
  assert.ok(
    scaffoldOptionProblems({ appKey: 'ok-app', version: '1.0' })[0]!.includes('semver'),
  );
  assert.deepEqual(scaffoldOptionProblems({ appKey: 'ok-app' }), []);
});

// ---------------------------------------------------------------------------
// AC-3 — the project validator's structural rules
// ---------------------------------------------------------------------------

test('MKT-049 AC-3: a missing manifest is a clear problem', () => {
  const verdict = validateAppProjectFiles({});
  assert.ok(!verdict.valid);
  assert.match(verdict.problems[0]!, /mos-app\.json: missing — the App manifest is required/);
});

test('MKT-049 AC-3: a malformed manifest JSON is a clear problem', () => {
  const verdict = validateAppProjectFiles({ 'mos-app.json': '{not json' });
  assert.ok(!verdict.valid);
  assert.match(verdict.problems[0]!, /not valid JSON/);
});

test('MKT-049 AC-3: manifest guard problems surface file-prefixed (closed vocabulary + state namespace)', () => {
  const files = scaffoldedFiles();
  setManifestField(files, (manifest) => {
    manifest['dataScopes'] = ['client:readd'];
    manifest['stateNamespaces'] = ['app:agency-analytics:workflow'];
  });
  const verdict = validateAppProjectFiles(files);
  assert.ok(!verdict.valid);
  assert.ok(verdict.problems.some((problem) => problem.includes("mos-app.json: dataScopes[0]: 'client:readd' is not in the closed dataScopes vocabulary")));
  assert.ok(verdict.problems.some((problem) => problem.includes('claims the MOS core-authority namespace \'workflow\'')));
  // The raw manifest-level verdict is the drift-comparable mirror result.
  assert.equal(verdict.manifest.rejectionClass, 'invalid');
});

test('MKT-049 AC-3: a missing capability-contract file is a clear problem (capability-contract references must resolve)', () => {
  const files = scaffoldedFiles();
  delete files['capabilities/hello-mos.json'];
  const verdict = validateAppProjectFiles(files);
  assert.ok(!verdict.valid);
  assert.match(
    verdict.problems[0]!,
    /capabilities\/hello-mos\.json: missing — the manifest declares capability 'hello-mos'@'0\.1\.0'; every declared capability needs a contract file/,
  );
});

test('MKT-049 AC-3: a capability contract that disagrees with the manifest declaration is a problem (the manifest is the authority)', () => {
  const files = scaffoldedFiles();
  const contract = JSON.parse(files['capabilities/hello-mos.json']!) as Record<string, unknown>;
  contract['version'] = '9.9.9';
  files['capabilities/hello-mos.json'] = `${JSON.stringify(contract, null, 2)}\n`;
  const verdict = validateAppProjectFiles(files);
  assert.ok(!verdict.valid);
  assert.match(
    verdict.problems[0]!,
    /declares capability 'hello-mos'@'9\.9\.9' but the manifest declares 'hello-mos'@'0\.1\.0' \(the manifest is the authority\)/,
  );
});

test('MKT-049 AC-3: an orphan capability contract file is a clear problem', () => {
  const files = scaffoldedFiles();
  files['capabilities/rogue.json'] = `${JSON.stringify(
    { name: 'rogue', version: '0.1.0', description: 'x', inputSchema: {}, outputSchema: {} },
    null,
    2,
  )}\n`;
  const verdict = validateAppProjectFiles(files);
  assert.ok(!verdict.valid);
  assert.match(verdict.problems[0]!, /no matching manifest capability declaration/);
});

test('MKT-049 AC-3: a malformed capability contract shape is a clear problem', () => {
  const files = scaffoldedFiles();
  files['capabilities/hello-mos.json'] = `${JSON.stringify({ name: 'hello-mos' }, null, 2)}\n`;
  const verdict = validateAppProjectFiles(files);
  assert.ok(!verdict.valid);
  assert.match(verdict.problems[0]!, /must declare exactly \{ name, version, description, inputSchema, outputSchema \}/);
});

test('MKT-049 AC-3: missing UI-surface declarations (when the manifest declares surfaces) are a problem', () => {
  const files = scaffoldedFiles();
  delete files[APP_PROJECT_FILES.uiSurfaces];
  const verdict = validateAppProjectFiles(files);
  assert.ok(!verdict.valid);
  assert.match(verdict.problems[0]!, /ui\/surfaces\.json: missing — the manifest declares UI surfaces/);
});

test('MKT-049 AC-3: a UI declaration without a matching manifest surface is a problem (presentation must mirror the manifest)', () => {
  const files = scaffoldedFiles();
  const ui = JSON.parse(files[APP_PROJECT_FILES.uiSurfaces]!) as { surfaces: Array<Record<string, unknown>> };
  ui['surfaces'][0]!['route'] = '/apps/agency-analytics/somewhere-else';
  files[APP_PROJECT_FILES.uiSurfaces] = `${JSON.stringify(ui, null, 2)}\n`;
  const verdict = validateAppProjectFiles(files);
  assert.ok(!verdict.valid);
  assert.ok(
    verdict.problems.some((problem) => problem.includes('has no matching mos-app.json uiSurfaces declaration')),
    JSON.stringify(verdict.problems),
  );
  assert.ok(
    verdict.problems.some((problem) => problem.includes("missing the presentation declaration for manifest surface 'command-center-card'")),
    JSON.stringify(verdict.problems),
  );
});

test('MKT-049 AC-3: a UI declaration with an out-of-vocabulary surface kind is a problem', () => {
  const files = scaffoldedFiles();
  const ui = JSON.parse(files[APP_PROJECT_FILES.uiSurfaces]!) as { surfaces: Array<Record<string, unknown>> };
  ui['surfaces'][0]!['surface'] = 'sidebar-widget';
  files[APP_PROJECT_FILES.uiSurfaces] = `${JSON.stringify(ui, null, 2)}\n`;
  const verdict = validateAppProjectFiles(files);
  assert.ok(!verdict.valid);
  assert.ok(
    verdict.problems.some((problem) => problem.includes("surface 'sidebar-widget' is not in the closed UI-surface-kind vocabulary")),
    JSON.stringify(verdict.problems),
  );
});

test('MKT-049 AC-3: a project without a test file is a problem (test-file presence)', () => {
  const files = scaffoldedFiles();
  delete files['tests/app.test.ts'];
  const verdict = validateAppProjectFiles(files);
  assert.ok(!verdict.valid);
  assert.match(
    verdict.problems[0]!,
    /tests: no test file found — at least one tests\/\*\.test\.ts is required/,
  );
});

// ---------------------------------------------------------------------------
// AC-5 — signing through the project layout
// ---------------------------------------------------------------------------

test('MKT-049 AC-5: sign → validate round trip: a valid attestation passes and a tampered manifest fails with the re-sign hint', () => {
  const files = scaffoldedFiles();
  const manifest = JSON.parse(files[APP_PROJECT_FILES.manifest]!) as Record<string, unknown>;
  const signature = signManifest(manifest);
  files[APP_PROJECT_FILES.signature] = `${JSON.stringify(signature, null, 2)}\n`;
  assert.ok(validateAppProjectFiles(files).valid, 'the signed scaffolded project validates');

  // Tamper with the manifest content AFTER signing: the attestation must
  // fail closed with the current-fingerprint hint.
  const tampered = JSON.parse(files[APP_PROJECT_FILES.manifest]!) as Record<string, unknown>;
  (tampered['capabilities'] as Array<Record<string, unknown>>)[0]!['name'] = 'renamed-capability';
  files[APP_PROJECT_FILES.manifest] = `${JSON.stringify(tampered, null, 2)}\n`;
  const verdict = validateAppProjectFiles(files);
  assert.ok(!verdict.valid);
  assert.ok(
    verdict.problems.some((problem) => problem.includes('attestation mismatch — the signed digest does not equal this manifest\'s canonical fingerprint')),
    JSON.stringify(verdict.problems),
  );
  assert.ok(
    verdict.problems.some((problem) => problem.includes("the canonical fingerprint of the current mos-app.json is '")),
    'the re-sign hint carries the current fingerprint',
  );
});

test('MKT-049 AC-5: a malformed signature.json is a clear problem', () => {
  const files = scaffoldedFiles();
  files[APP_PROJECT_FILES.signature] = `${JSON.stringify({ algorithm: 'rsa' }, null, 2)}\n`;
  const verdict = validateAppProjectFiles(files);
  assert.ok(!verdict.valid);
  assert.ok(verdict.problems.some((problem) => problem.includes('signature.json: signature: must declare exactly { algorithm, digest }')));
  assert.ok(verdict.problems.some((problem) => problem.includes("signature.algorithm: 'rsa' is not in the closed signature-algorithm vocabulary")));
});

// ---------------------------------------------------------------------------
// AC-6 — the offline documentation generation
// ---------------------------------------------------------------------------

test('MKT-049 AC-6: the offline docs generator renders the frozen vocabularies, the 19-field manifest reference and the signature guide', () => {
  const markdown = generateDeveloperDocsMarkdown();
  assert.match(markdown, /# MOS App SDK and Developer Portal — developer documentation/);
  assert.match(markdown, /## The App manifest \(the frozen 19-field contract\)/);
  assert.match(markdown, /\| `appKey` \| `string` \| yes \|/);
  assert.match(markdown, /## The frozen vocabularies/);
  assert.match(markdown, /### Certification states \(trust levels\)/);
  assert.match(markdown, /### UI surface kinds \(presentation only\)/);
  assert.match(markdown, /## Signing \(the optional hash attestation\)/);
  assert.match(markdown, /manifest-sha256-fingerprint/);
  assert.match(markdown, /## The Developer Portal endpoints/);
  const model = developerDocsModel();
  assert.equal(model.manifestFields.length, 19);
  assert.equal(model.vocabularies['certificationStates']!.length, 3);
  assert.equal(model.vocabularies['runtimeClasses']!.length, 4);
  assert.equal(model.vocabularies['dataScopes']!.length, 4);
  assert.equal(model.vocabularies['mutationScopes']!.length, 5);
  assert.equal(model.vocabularies['uiSurfaceKinds']!.length, 6);
  assert.equal(model.vocabularies['meteringDimensions']!.length, 5);
});

// ---------------------------------------------------------------------------
// AC-1 — the typed client surface (stubbed fetch; no network)
// ---------------------------------------------------------------------------

interface RecordedRequest {
  readonly url: string;
  readonly init: RequestInit;
}

function stubClient(
  handler: (request: RecordedRequest) => { status: number; body: unknown },
): { client: MosDeveloperPortalClient; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const request: RecordedRequest = {
      url: String(url),
      init: init ?? {},
    };
    requests.push(request);
    const reply = handler(request);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;
  return {
    client: new MosDeveloperPortalClient({
      baseUrl: 'http://127.0.0.1:3999',
      token: 'test-token',
      fetchImpl,
    }),
    requests,
  };
}

test('MKT-049 AC-1: the client issues correctly-shaped requests for every developer surface', async () => {
  const manifest = scaffoldManifest({ appKey: 'agency-analytics' });
  const signature = signManifest(manifest);
  const { client, requests } = stubClient((request) => {
    // Route-shaped replies so every parser path runs.
    if (request.url.endsWith('/api/developer-portal/catalog')) {
      return { status: 200, body: { apps: [] } };
    }
    if (request.url.endsWith('/versions')) {
      return { status: 200, body: { versions: [] } };
    }
    if (request.url.includes('/versions/')) {
      return { status: 200, body: { appVersionId: 'id' } };
    }
    return { status: 200, body: { ok: true } };
  });

  await client.getCatalog();
  await client.getAppVersions('agency-analytics');
  await client.getAppVersion('agency-analytics', '1.2.0');
  await client.getDocs();
  await client.validateManifest(manifest, signature);
  await client.publishAppVersion(manifest, 'publish-key-1', signature);
  await client.queryCompatibility({
    platformVersion: '1.5.0',
    runtimeClass: null,
    extensionVersions: [],
  });

  const byPath = requests.map((request) => `${(request.init.method as string) ?? 'GET'} ${request.url}`);
  assert.deepEqual(byPath, [
    'GET http://127.0.0.1:3999/api/developer-portal/catalog',
    'GET http://127.0.0.1:3999/api/developer-portal/apps/agency-analytics/versions',
    'GET http://127.0.0.1:3999/api/developer-portal/apps/agency-analytics/versions/1.2.0',
    'GET http://127.0.0.1:3999/api/developer-portal/docs',
    'POST http://127.0.0.1:3999/api/developer-portal/validate',
    'POST http://127.0.0.1:3999/api/developer-portal/publish',
    'POST http://127.0.0.1:3999/api/apps/compatibility',
  ]);

  // The auth header + JSON body shapes.
  for (const request of requests) {
    const headers = request.init.headers as Record<string, string>;
    assert.equal(headers['authorization'], 'Bearer test-token');
  }
  const validateBody = JSON.parse(String(requests[4]!.init.body)) as Record<string, unknown>;
  assert.ok('manifest' in validateBody);
  assert.equal((validateBody['signature'] as Record<string, unknown>)['algorithm'], 'manifest-sha256-fingerprint');
  const publishBody = JSON.parse(String(requests[5]!.init.body)) as Record<string, unknown>;
  assert.equal(publishBody['idempotencyKey'], 'publish-key-1');
  assert.ok('manifest' in publishBody);
  assert.ok('signature' in publishBody);
  const compatBody = JSON.parse(String(requests[6]!.init.body)) as Record<string, unknown>;
  assert.equal(compatBody['platformVersion'], '1.5.0');
});

test('MKT-049 AC-1: the client maps responses and surfaces typed errors (404 semantics preserved)', async () => {
  const { client } = stubClient(() => ({
    status: 404,
    body: { code: 'NOT_FOUND', message: 'app version not found: x@1.0.0' },
  }));
  await assert.rejects(client.getAppVersion('x', '1.0.0'), (error: unknown) => {
    assert.ok(error instanceof MosApiError);
    assert.equal(error.status, 404);
    assert.equal(error.code, 'NOT_FOUND');
    assert.equal(error.message, 'app version not found: x@1.0.0');
    return true;
  });
});

test('MKT-049 AC-1: the client maps validation responses (422 problem details preserved)', async () => {
  const { client } = stubClient(() => ({
    status: 422,
    body: {
      code: 'INVALID_REQUEST',
      message: 'app manifest failed the frozen mos-app-ecosystem-v1.5.md §Manifest shape contract',
      details: ['dataScopes[0]: must be a string'],
    },
  }));
  const manifest = scaffoldManifest({ appKey: 'agency-analytics' });
  await assert.rejects(client.validateManifest(manifest), (error: unknown) => {
    assert.ok(error instanceof MosApiError);
    assert.equal(error.status, 422);
    assert.deepEqual(error.details, ['dataScopes[0]: must be a string']);
    return true;
  });
});

test('MKT-049 AC-1: the client parses the catalog, version view and publish result DTOs', async () => {
  const manifest = scaffoldManifest({ appKey: 'agency-analytics' });
  const record = {
    appVersionId: 'id-1',
    appKey: 'agency-analytics',
    publisher: 'dev:user-1',
    manifest,
    certificationState: 'UNVERIFIED',
    idempotencyKey: 'k1',
    createFingerprint: 'f'.repeat(64),
    createdBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const publish = stubClient(() => ({
    status: 201,
    body: {
      appVersion: record,
      signature: { algorithm: 'manifest-sha256-fingerprint', digest: 'f'.repeat(64), verified: true },
    },
  }));
  const publishResult = await publish.client.publishAppVersion(manifest, 'k1', signManifest(manifest));
  assert.equal(publishResult.appVersion.appVersionId, 'id-1');
  assert.equal(publishResult.signature!.verified, true);

  const view = stubClient(() => ({
    status: 200,
    body: {
      ...record,
      validationStatus: {
        published: true,
        manifestValidAtPublish: true,
        integrity: { algorithm: 'manifest-sha256-fingerprint', digest: 'f'.repeat(64), verified: true },
      },
      vocabulary: { dataScopes: {} },
    },
  }));
  const versionView = await view.client.getAppVersion('agency-analytics', '0.1.0');
  assert.equal(versionView.validationStatus.integrity.verified, true);
  assert.equal(versionView.validationStatus.manifestValidAtPublish, true);
});
