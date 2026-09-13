/**
 * MOS App SDK — App PROJECT SCAFFOLDING (MKT-049, spec/
 * effective-backlog-v1.5.md "community developer workflow for
 * scaffolding, local validation, capability contracts, UI surfaces,
 * manifests, tests, signing/publishing and documentation";
 * mos-app-ecosystem-v1.5.md "UI and developer model": "The Developer
 * Portal publishes, validates, certifies, versions, tests and documents
 * Apps").
 *
 * Generates the COMPLETE developer-project layout (pure content
 * generation — no filesystem access; the CLI writes the files):
 *
 *   mos-app.json            the manifest skeleton — VALID against the
 *                           frozen MKT-047 manifest schema (proven by
 *                           tests: the scaffolded manifest passes BOTH
 *                           the SDK's offline mirror AND the registry's
 *                           real assertValidAppManifest)
 *   capabilities/<slug>.json  one capability-contract file per declared
 *                           capability (name + version + description +
 *                           input/output schemas — matching the manifest)
 *   ui/surfaces.json        the UI-surface declarations (presentation
 *                           only — command-center cards / client-room
 *                           panels / workspace tabs / report pages /
 *                           editor panes / action menus; mutations go
 *                           through server capabilities)
 *   tests/app.test.ts       the test skeleton (node:test, standalone)
 *   README.md               the developer README (workflow + endpoints)
 *
 * DETERMINISTIC: identical inputs → byte-identical outputs (no
 * timestamps, no random ids) — regeneration is idempotent and diffable.
 * Imports NOTHING from the MOS repository (standalone).
 */

import type { AppManifest } from './types.ts';
import { APP_UI_SURFACE_KINDS } from './vocabularies.ts';
import { capabilityContractFileName } from './validate.ts';

/** The scaffolding options (all derived defaults when omitted). */
export interface ScaffoldOptions {
  /** The app key (2-63 chars, lowercase letters/digits/dashes — validated). */
  readonly appKey: string;
  /** The initial semantic version (default '0.1.0'). */
  readonly version?: string;
  /** Capability names to declare (default: one 'hello-mos' capability). */
  readonly capabilities?: readonly string[];
  /** UI surface kinds to declare (default: one command-center-card). */
  readonly surfaces?: readonly AppUiSurfaceKindOption[];
  /** A short human description of the app (default derived). */
  readonly description?: string;
}

export type AppUiSurfaceKindOption = (typeof APP_UI_SURFACE_KINDS)[number];

const KEY_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;
const CAPABILITY_NAME_PATTERN = /^.{1,64}$/;
const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]{1,32})?$/;

/** One generated file: relative path + content (deterministic). */
export interface GeneratedFile {
  readonly path: string;
  readonly content: string;
}

export interface ScaffoldResult {
  readonly files: readonly GeneratedFile[];
  readonly manifest: AppManifest;
}

/** Validates the scaffolding inputs with clear error messages. */
export function scaffoldOptionProblems(options: ScaffoldOptions): string[] {
  const problems: string[] = [];
  if (!KEY_PATTERN.test(options.appKey)) {
    problems.push('appKey: must be 2-63 chars, lowercase letters/digits/dashes, starting with a letter');
  }
  if (options.version !== undefined && !SEMVER_PATTERN.test(options.version)) {
    problems.push(`version: '${options.version}' is not a semver label X.Y.Z(-prerelease)`);
  }
  for (const capability of options.capabilities ?? []) {
    if (!CAPABILITY_NAME_PATTERN.test(capability)) {
      problems.push(`capability name '${capability}': must be 1-64 characters`);
    }
  }
  for (const surface of options.surfaces ?? []) {
    if (!(APP_UI_SURFACE_KINDS as readonly string[]).includes(surface)) {
      problems.push(`surface '${surface}': is not in the closed UI-surface-kind vocabulary`);
    }
  }
  return problems;
}

function routeForSurface(appKey: string, surface: AppUiSurfaceKindOption): string {
  return `/apps/${appKey}${surface === 'action-menu' ? '/actions' : ''}/${surface}`;
}

function titleCase(value: string): string {
  return value
    .split('-')
    .filter((segment) => segment.length > 0)
    .map((segment) => segment[0]!.toUpperCase() + segment.slice(1))
    .join(' ');
}

/**
 * The manifest skeleton — VALID against the frozen MKT-047 manifest
 * schema (the closed vocabularies, the namespaced app-owned state, the
 * bounded arrays; the app-owned state namespace claims the app's OWN
 * key, never a core-authority namespace).
 */
export function scaffoldManifest(options: ScaffoldOptions): AppManifest {
  const capabilities = (options.capabilities ?? ['hello-mos']).map((name) => ({
    name,
    version: options.version ?? '0.1.0',
  }));
  const surfaces = options.surfaces ?? ['command-center-card'];
  return {
    appKey: options.appKey,
    version: options.version ?? '0.1.0',
    compatibility: { minPlatform: '1.0.0', maxPlatform: '2.0.0' },
    capabilities,
    inputSchema: { required: [] },
    outputSchema: { required: [] },
    dataScopes: [],
    mutationScopes: [],
    networkDestinations: [],
    runtimeClass: 'pooled-worker',
    eventSubscriptions: [],
    uiSurfaces: surfaces.map((surface) => ({
      surface,
      route: routeForSurface(options.appKey, surface),
    })),
    configSchema: {},
    requiredCredentialNames: [],
    stateNamespaces: [`app:${options.appKey}:documents`],
    migrationVersion: 0,
    dependencies: [],
    supportLevel: 'community',
    meteringDimensions: [],
  };
}

/**
 * Scaffolds the full App project (pure): the manifest skeleton, one
 * capability-contract file per declared capability, the UI-surface
 * declarations, the test skeleton and the README.
 */
export function scaffoldAppProject(options: ScaffoldOptions): ScaffoldResult {
  const manifest = scaffoldManifest(options);
  const description =
    options.description ?? `The ${titleCase(options.appKey)} MOS App (scaffolded by the MOS App SDK).`;
  const files: GeneratedFile[] = [];

  // --- the manifest ----------------------------------------------------------
  files.push({
    path: 'mos-app.json',
    content: `${JSON.stringify(manifest, null, 2)}\n`,
  });

  // --- the capability contracts ----------------------------------------------
  for (const capability of manifest.capabilities) {
    const contract = {
      name: capability.name,
      version: capability.version,
      description: `The ${capability.name} capability contract of ${manifest.appKey}.`,
      inputSchema: { required: [] },
      outputSchema: { required: [] },
    };
    files.push({
      path: capabilityContractFileName(capability.name),
      content: `${JSON.stringify(contract, null, 2)}\n`,
    });
  }

  // --- the UI-surface declarations (presentation only) ------------------------
  files.push({
    path: 'ui/surfaces.json',
    content: `${JSON.stringify(
      {
        surfaces: manifest.uiSurfaces.map((surface) => ({
          surface: surface.surface,
          route: surface.route,
          title: `${titleCase(manifest.appKey)} ${titleCase(surface.surface)}`,
          description:
            'Presentation only — this surface invokes server capabilities for mutations (architecture-lock v1.5 #12).',
        })),
      },
      null,
      2,
    )}\n`,
  });

  // --- the test skeleton --------------------------------------------------------
  files.push({
    path: 'tests/app.test.ts',
    content: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, '..', 'mos-app.json'), 'utf8')) as Record<
  string,
  unknown
>;

test('the manifest declares the app key and at least one capability', () => {
  assert.equal(typeof manifest['appKey'], 'string');
  assert.ok((manifest['appKey'] as string).length >= 2);
  const capabilities = manifest['capabilities'] as Array<{ name: string; version: string }>;
  assert.ok(Array.isArray(capabilities) && capabilities.length >= 1, 'at least one capability');
  for (const capability of capabilities) {
    assert.ok(capability.name.length >= 1, 'capability names are non-empty');
    assert.match(capability.version, /^\\d+\\.\\d+\\.\\d+/);
  }
});

test('the app-owned state namespaces claim this app key only', () => {
  const appKey = manifest['appKey'] as string;
  const namespaces = manifest['stateNamespaces'] as string[];
  for (const namespace of namespaces) {
    assert.ok(namespace.startsWith(\`app:\${appKey}:\`), \`\${namespace} must be namespaced under this app key\`);
  }
});

test('the UI surfaces are presentation only (no mutation authority)', () => {
  const surfaces = manifest['uiSurfaces'] as Array<{ surface: string; route: string }>;
  const kinds = [
    'command-center-card',
    'client-room-panel',
    'workspace-tab',
    'report-page',
    'editor-pane',
    'action-menu',
  ];
  for (const surface of surfaces) {
    assert.ok(kinds.includes(surface.surface), \`\${surface.surface} is a closed-vocabulary surface kind\`);
    assert.ok(surface.route.startsWith('/'), 'routes are bounded paths');
  }
});
`,
  });

  // --- the README --------------------------------------------------------------
  files.push({
    path: 'README.md',
    content: `# ${titleCase(manifest.appKey)} — a MOS App

${description}

## Layout

- \`mos-app.json\` — the App Version manifest (the frozen MOS App Ecosystem
  manifest contract: capabilities, scopes, UI surfaces, events,
  dependencies, app-owned state namespaces and certification metadata).
- \`capabilities/*.json\` — one capability contract per declared manifest
  capability (name + version + description + input/output schemas).
- \`ui/surfaces.json\` — the UI-surface declarations (presentation only;
  mutations go through server capabilities).
- \`tests/app.test.ts\` — the test skeleton (\`node --test 'tests/*.test.ts'\`).

## Developer workflow (the MOS Developer Portal)

1. Scaffold (done): \`node tools/app-sdk/cli.ts scaffold <dir> --app-key ${manifest.appKey}\`
2. Validate locally: \`node tools/app-sdk/cli.ts validate <dir>\`
3. Test: \`node --test '<dir>/tests/*.test.ts'\`
4. Sign (optional but recommended): \`node tools/app-sdk/cli.ts sign <dir>\`
   — writes \`signature.json\` (the manifest-sha256-fingerprint hash
   attestation the registry verifies at publish).
5. Publish (platform_developer role): \`node tools/app-sdk/cli.ts publish <dir> --base-url <url> --token <token> --idempotency-key <key>\`
   or POST the manifest (+ signature) to
   \`POST /api/developer-portal/publish\`.
6. Document: \`GET /api/developer-portal/docs\` serves the frozen
   capability-contract + manifest-schema reference; offline:
   \`node tools/app-sdk/cli.ts docs\`.

Published App Versions are IMMUTABLE (re-publishing the same app key +
version is rejected 409; corrections publish a NEW version). Every
developer publish is born UNVERIFIED — certification is platform
territory, never a manifest field.
`,
  });

  return { files, manifest };
}
