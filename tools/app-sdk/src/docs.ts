/**
 * MOS App SDK — the OFFLINE developer documentation generator (MKT-049,
 * spec/mos-app-ecosystem-v1.5.md "UI and developer model": "The
 * Developer Portal publishes, validates, certifies, versions, tests and
 * documents Apps"; the MKT-049 dispatch AC-6).
 *
 * Generates the developer reference (Markdown) from the FROZEN
 * capability contracts + manifest schema — the SDK's standalone mirror
 * of the authority's exported vocabularies/meanings. The CANONICAL
 * served documentation surface is the Developer Portal route
 * GET /api/developer-portal/docs (derived read-only from the /apps
 * public contract at request time — no runtime mutation); this offline
 * generator is the developer-machine mirror (dev-time generation for
 * offline reference: \`node tools/app-sdk/cli.ts docs\`). The two are
 * drift-pinned: tests assert the SDK's vocabulary data equals the
 * authority exports the served route derives from.
 *
 * Imports NOTHING from the MOS repository (standalone).
 */

import {
  APP_CERTIFICATION_STATES,
  APP_CERTIFICATION_STATE_MEANINGS,
  APP_DATA_SCOPES,
  APP_DATA_SCOPE_MEANINGS,
  APP_METERING_DIMENSIONS,
  APP_METERING_DIMENSION_MEANINGS,
  APP_MUTATION_SCOPES,
  APP_MUTATION_SCOPE_MEANINGS,
  APP_RUNTIME_CLASSES,
  APP_RUNTIME_CLASS_MEANINGS,
  APP_SIGNATURE_ALGORITHMS,
  APP_UI_SURFACE_KINDS,
  APP_UI_SURFACE_KIND_MEANINGS,
  APP_CORE_AUTHORITY_NAMESPACES,
} from './vocabularies.ts';

/** One manifest-field reference row (the frozen 19-field contract). */
export interface ManifestFieldDoc {
  readonly field: string;
  readonly type: string;
  readonly required: boolean;
  readonly description: string;
}

/**
 * The frozen manifest field reference (mos-app-ecosystem-v1.5.md
 * "Manifest", verbatim section order).
 */
export const MANIFEST_FIELD_DOCS: readonly ManifestFieldDoc[] = [
  { field: 'appKey', type: 'string', required: true, description: 'app key and publisher identity (the publisher identity is SERVER-DERIVED from the authenticated platform developer — never a manifest field)' },
  { field: 'version', type: 'semver', required: true, description: 'immutable semantic version and compatibility range (a published (appKey, version) pair is immutable; corrections publish a NEW version)' },
  { field: 'compatibility', type: '{ minPlatform, maxPlatform }', required: true, description: 'inclusive platform compatibility range under REAL semver ordering' },
  { field: 'capabilities', type: 'array of { name, version }', required: true, description: 'capabilities and capability versions (bounded, unique names — one name is one callable unit)' },
  { field: 'inputSchema', type: 'object', required: true, description: 'input/output schemas (bounded JSON objects)' },
  { field: 'outputSchema', type: 'object', required: true, description: 'input/output schemas (bounded JSON objects)' },
  { field: 'dataScopes', type: 'array (closed vocabulary)', required: true, description: 'requested data scopes (the frozen tenant-data boundary kinds)' },
  { field: 'mutationScopes', type: 'array (closed vocabulary)', required: true, description: 'requested mutation scopes (the MOS authority surfaces an App may INVOKE — always server-mediated; direct database writes to MOS core tables are forbidden)' },
  { field: 'networkDestinations', type: 'array of { host, protocol, port, reason }', required: true, description: 'network destinations (policy-gated at use)' },
  { field: 'runtimeClass', type: 'enum (closed vocabulary)', required: true, description: 'runtime class (the closed /executions set: pooled-worker | ephemeral-sandbox | persistent-sandbox | dedicated-runtime)' },
  { field: 'eventSubscriptions', type: 'array of labels', required: true, description: 'event subscriptions (bounded unique labels)' },
  { field: 'uiSurfaces', type: 'array of { surface, route }', required: true, description: 'UI surfaces and routes (the closed six-kind vocabulary — presentation only; UI invokes server capabilities for mutations)' },
  { field: 'configSchema', type: 'object of field contracts', required: true, description: 'configuration schema ({ type, required, description, pattern } field contracts — validated at install time)' },
  { field: 'requiredCredentialNames', type: 'array (uppercase snake)', required: true, description: 'credential references required BY NAME ONLY (never values — §21)' },
  { field: 'stateNamespaces', type: 'array (app:<appKey>:<local>)', required: true, description: 'app-owned state namespaces (must claim the OWN app key; the local segment may never be a MOS core-authority namespace — bounded app state)' },
  { field: 'migrationVersion', type: 'integer >= 0', required: true, description: 'migration version (the app\'s own storage migration version)' },
  { field: 'dependencies', type: 'array of { kind, publisher, key, minVersion, maxVersion }', required: true, description: 'dependency Apps/Extensions (a published compatible version must exist inside the declared range; no self-dependency)' },
  { field: 'supportLevel', type: 'string', required: true, description: 'declared support level (bounded publisher-declared label)' },
  { field: 'meteringDimensions', type: 'array (closed vocabulary)', required: true, description: 'metering dimensions (the closed economics vocabulary — MKT-052 owns the ledger)' },
];

/**
 * The Developer Portal endpoint reference (the frozen MKT-049 route
 * family + the /apps registry routes the SDK client consumes).
 */
export const DEVELOPER_PORTAL_ENDPOINT_DOCS: readonly {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly description: string;
}[] = [
  { method: 'GET', path: '/api/developer-portal/catalog', description: 'the developer catalog: distinct app keys, version counts, the newest published version (any active member)' },
  { method: 'GET', path: '/api/developer-portal/apps/:appKey/versions', description: 'the version history view of one app key (any active member)' },
  { method: 'GET', path: '/api/developer-portal/apps/:appKey/versions/:version', description: 'the developer version view: the manifest + validation status (integrity) + vocabulary annotations (any active member)' },
  { method: 'POST', path: '/api/developer-portal/validate', description: 'online validation through the REAL registry guard (pure — no state change; any active member)' },
  { method: 'POST', path: '/api/developer-portal/publish', description: 'publish a NEW immutable App Version (delegates to the /apps registry publish command; platform_developer | platform_administrator; optional signature verified)' },
  { method: 'GET', path: '/api/developer-portal/docs', description: 'this documentation surface, derived read-only from the frozen /apps public contract (any active member)' },
  { method: 'POST', path: '/api/apps', description: 'the DIRECT registry publish surface (the same authority command; the SDK client uses the portal family)' },
  { method: 'GET', path: '/api/apps/:appKey/versions/:version', description: 'the DIRECT registry manifest read by exact (app key, semantic version)' },
  { method: 'POST', path: '/api/apps/compatibility', description: 'the compatibility query: given platform version + available extension versions → eligible app versions with honest reasons' },
];

/**
 * The structured documentation model (the SDK mirror of what
 * GET /api/developer-portal/docs serves) — usable programmatically.
 */
export function developerDocsModel(): {
  readonly title: string;
  readonly manifestFields: readonly ManifestFieldDoc[];
  readonly vocabularies: Readonly<
    Record<string, ReadonlyArray<{ readonly value: string; readonly meaning: string }>>
  >;
  readonly signatureAlgorithms: readonly string[];
  readonly endpoints: typeof DEVELOPER_PORTAL_ENDPOINT_DOCS;
  readonly workflow: readonly string[];
} {
  return {
    title: 'MOS App SDK and Developer Portal — developer documentation',
    manifestFields: MANIFEST_FIELD_DOCS,
    vocabularies: {
      certificationStates: APP_CERTIFICATION_STATES.map((value) => ({
        value,
        meaning: APP_CERTIFICATION_STATE_MEANINGS[value],
      })),
      runtimeClasses: APP_RUNTIME_CLASSES.map((value) => ({
        value,
        meaning: APP_RUNTIME_CLASS_MEANINGS[value],
      })),
      dataScopes: APP_DATA_SCOPES.map((value) => ({
        value,
        meaning: APP_DATA_SCOPE_MEANINGS[value],
      })),
      mutationScopes: APP_MUTATION_SCOPES.map((value) => ({
        value,
        meaning: APP_MUTATION_SCOPE_MEANINGS[value],
      })),
      uiSurfaceKinds: APP_UI_SURFACE_KINDS.map((value) => ({
        value,
        meaning: APP_UI_SURFACE_KIND_MEANINGS[value],
      })),
      meteringDimensions: APP_METERING_DIMENSIONS.map((value) => ({
        value,
        meaning: APP_METERING_DIMENSION_MEANINGS[value],
      })),
    },
    signatureAlgorithms: [...APP_SIGNATURE_ALGORITHMS],
    endpoints: DEVELOPER_PORTAL_ENDPOINT_DOCS,
    workflow: [
      'scaffold — node tools/app-sdk/cli.ts scaffold <dir> --app-key <key>',
      'validate (offline) — node tools/app-sdk/cli.ts validate <dir>',
      'test — node --test \'<dir>/tests/*.test.ts\'',
      'sign (optional) — node tools/app-sdk/cli.ts sign <dir> (writes signature.json)',
      'publish — node tools/app-sdk/cli.ts publish <dir> --base-url <url> --token <token> --idempotency-key <key>',
      'document — GET /api/developer-portal/docs (served) or node tools/app-sdk/cli.ts docs (offline)',
    ],
  };
}

function vocabularyTable(
  lines: string[],
  heading: string,
  entries: ReadonlyArray<{ readonly value: string; readonly meaning: string }>,
): void {
  lines.push(`### ${heading}`, '', '| value | meaning |', '| --- | --- |');
  for (const entry of entries) {
    lines.push(`| \`${entry.value}\` | ${entry.meaning} |`);
  }
  lines.push('');
}

/**
 * Renders the full developer reference as Markdown (offline dev-time
 * generation; the served route is the canonical surface — DISCLOSED in
 * docs/implementation/MKT-049.md).
 */
export function generateDeveloperDocsMarkdown(): string {
  const model = developerDocsModel();
  const lines: string[] = [];
  lines.push('# MOS App SDK and Developer Portal — developer documentation');
  lines.push('');
  lines.push(
    'Generated from the frozen capability contracts + manifest schema (the /apps registry public contract — spec/mos-app-ecosystem-v1.5.md). The canonical served surface is `GET /api/developer-portal/docs`.',
  );
  lines.push('');
  lines.push('## The App manifest (the frozen 19-field contract)');
  lines.push('');
  lines.push('| field | type | required | description |');
  lines.push('| --- | --- | --- | --- |');
  for (const field of model.manifestFields) {
    lines.push(
      `| \`${field.field}\` | \`${field.type}\` | ${field.required ? 'yes' : 'no'} | ${field.description} |`,
    );
  }
  lines.push('');
  lines.push(
    'No secret material, tenant identity, provenance or lifecycle authority is supplied by the caller in the manifest. Publisher identity is server-derived; certification state is platform territory (born UNVERIFIED). Published App Versions are immutable.',
  );
  lines.push('');
  lines.push('## The frozen vocabularies');
  lines.push('');
  vocabularyTable(lines, 'Certification states (trust levels)', model.vocabularies['certificationStates']!);
  vocabularyTable(lines, 'Runtime classes', model.vocabularies['runtimeClasses']!);
  vocabularyTable(lines, 'Requested data scopes', model.vocabularies['dataScopes']!);
  vocabularyTable(lines, 'Requested mutation scopes', model.vocabularies['mutationScopes']!);
  vocabularyTable(lines, 'UI surface kinds (presentation only)', model.vocabularies['uiSurfaceKinds']!);
  vocabularyTable(lines, 'Metering dimensions', model.vocabularies['meteringDimensions']!);
  lines.push('## App-owned state namespaces');
  lines.push('');
  lines.push(
    'Every namespace must match `app:<owning app key>:<local>` and the local segment may never claim a MOS core-authority namespace. An app-owned spreadsheet-document namespace is valid; an app-owned competing Workflow state machine is not.',
  );
  lines.push('');
  lines.push(`Singular authorities (never claimable): ${APP_CORE_AUTHORITY_NAMESPACES.map((ns) => `\`${ns}\``).join(', ')}.`);
  lines.push('');
  lines.push('## Signing (the optional hash attestation)');
  lines.push('');
  lines.push(
    `Algorithms: ${model.signatureAlgorithms.map((algorithm) => `\`${algorithm}\``).join(', ')}. The digest is the canonical-manifest sha256 fingerprint — the same value the registry computes, persists on the immutable row (createFingerprint) and verifies at publish. Sign offline with \`node tools/app-sdk/cli.ts sign <project-dir>\`; publish the manifest + signature; a mismatch is rejected 422 with zero rows.`,
  );
  lines.push('');
  lines.push('## The Developer Portal endpoints');
  lines.push('');
  lines.push('| method | path | description |');
  lines.push('| --- | --- | --- |');
  for (const endpoint of model.endpoints) {
    lines.push(`| ${endpoint.method} | \`${endpoint.path}\` | ${endpoint.description} |`);
  }
  lines.push('');
  lines.push('## The developer workflow');
  lines.push('');
  for (const step of model.workflow) {
    lines.push(`1. ${step}`);
  }
  lines.push('');
  return lines.join('\n');
}
