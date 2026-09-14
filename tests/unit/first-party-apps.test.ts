/**
 * MKT-051 unit tests — the first-party capability pack manifests, the
 * surface-scope requirement map, the declared actions and the bounded
 * app-state guards (pure, no DB).
 *
 * Acceptance mapping (the dispatch AC-1/AC-3/AC-8):
 *   - AC-1: all EIGHT pack manifests (4 packs x 2 versions) are VALID
 *     against the REAL MKT-047 registry guard (assertValidAppManifest),
 *     the SDK's OFFLINE mirror (validateAppManifest — the drift-pinned
 *     copy), and their optional signatures verify against the REAL
 *     server-side fingerprint (appCreateFingerprint == the SDK's
 *     signManifest digest);
 *   - AC-1: each pack exercises a DISTINCT incumbent-capability family
 *     with UI-surface declarations (presentation only), capability
 *     declarations, and EXPLICITLY BOUNDED app state (the app's own
 *     app:<key>:<local> namespaces only — never a core-authority
 *     namespace);
 *   - AC-3: the state-namespace discipline (the migration-037 denylist
 *     via isLegalAppStateNamespace), the §21 material-key backstop over
 *     bounded state values, the entry/size/lineage bounds;
 *   - AC-1: the four families surface the frozen UI-surface vocabulary
 *     the ecosystem spec names (command-center-card + report-page /
 *     client-room-panel + action-menu / workspace-tab + editor-pane /
 *     client-facing presentation).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appCreateFingerprint,
  assertValidAppManifest,
  isLegalAppStateNamespace,
} from '../../src/modules/apps/public.ts';
import {
  validateAppManifest,
  signManifest,
} from '../../tools/app-sdk/src/index.ts';
import {
  FIRST_PARTY_APP_PACKS,
  FIRST_PARTY_PUBLISHER_IDENTITY,
  PACK_SURFACE_REQUIRED_DATA_SCOPES,
  PACK_STATE_MAX_ENTRIES,
  requiredDataScopesForSurface,
} from '../../src/modules/first-party-apps/public.ts';
import {
  MOS_SHEETS_APPEND_OBSERVATION_ACTION,
  allFirstPartyManifests,
  declaredActionFor,
  packAppStateKey,
  packCatalogEntry,
  packStateMutationProblems,
} from '../../src/modules/first-party-apps/public.ts';

// ---------------------------------------------------------------------------
// AC-1 — the four packs, the manifest battery
// ---------------------------------------------------------------------------

test('AC-1: exactly FOUR first-party packs, one per DISTINCT incumbent-capability family', () => {
  assert.equal(FIRST_PARTY_APP_PACKS.length, 4);
  const families = FIRST_PARTY_APP_PACKS.map((pack) => pack.family);
  assert.deepEqual([...families].sort(), [
    'client-portal',
    'crm-pipeline',
    'reporting-analytics',
    'spreadsheet-workflows',
  ]);
  // One pack per family (no family duplication).
  assert.equal(new Set(families).size, 4);
  // One app key per pack.
  assert.equal(new Set(FIRST_PARTY_APP_PACKS.map((pack) => pack.appKey)).size, 4);
});

test('AC-1: all EIGHT pack manifests pass the REAL MKT-047 registry guard (assertValidAppManifest)', () => {
  const manifests = allFirstPartyManifests();
  assert.equal(manifests.length, 8);
  for (const manifest of manifests) {
    assert.doesNotThrow(() => assertValidAppManifest(manifest), `${manifest.appKey}@${manifest.version}`);
  }
});

test('AC-1: all EIGHT pack manifests pass the App SDK OFFLINE mirror validator (the drift-pinned copy)', () => {
  for (const manifest of allFirstPartyManifests()) {
    const verdict = validateAppManifest(manifest);
    assert.ok(verdict.valid, `${manifest.appKey}@${manifest.version}: ${JSON.stringify(verdict.problems)}`);
  }
});

test('AC-1/AC-5(first-party identity): the optional MKT-049 hash attestation verifies — the SDK digest equals the REAL server-side fingerprint', () => {
  for (const manifest of allFirstPartyManifests()) {
    const signature = signManifest(manifest);
    const serverFingerprint = appCreateFingerprint(manifest);
    assert.equal(signature.digest, serverFingerprint, `${manifest.appKey}@${manifest.version}`);
    assert.equal(signature.algorithm, 'manifest-sha256-fingerprint');
  }
});

test('AC-1: each pack declares UI SURFACES (presentation only) from the frozen ecosystem vocabulary', () => {
  const expectedSurfaces: Record<string, string[]> = {
    'mos-analytics': ['command-center-card', 'report-page'],
    'mos-crm': ['client-room-panel', 'action-menu'],
    'mos-sheets': ['workspace-tab', 'editor-pane'],
    'mos-portal': ['client-room-panel', 'report-page'],
  };
  for (const [appKey, surfaces] of Object.entries(expectedSurfaces)) {
    for (const version of ['1.0.0', '1.1.0']) {
      const manifest = allFirstPartyManifests().find(
        (entry) => entry.appKey === appKey && entry.version === version,
      );
      assert.notEqual(manifest, undefined, `${appKey}@${version}`);
      assert.deepEqual(
        manifest!.uiSurfaces.map((surface) => surface.surface).sort(),
        [...surfaces].sort(),
      );
      for (const surface of manifest!.uiSurfaces) {
        assert.ok(surface.route.startsWith('/'), 'routes are bounded paths');
      }
    }
  }
});

test('AC-1: each pack declares CAPABILITIES (>= 2) and the 1.1.0 upgrade ADDS a capability (the lifecycle proof input)', () => {
  const additions: Record<string, string> = {
    'mos-analytics': 'compose-margin-breakdown',
    'mos-crm': 'compose-pipeline-summary',
    'mos-sheets': 'compose-formula-summary',
    'mos-portal': 'compose-portal-highlights',
  };
  for (const manifest of allFirstPartyManifests()) {
    assert.ok(manifest.capabilities.length >= 2, `${manifest.appKey}: >= 2 capabilities`);
    // Capability names unique.
    const names = manifest.capabilities.map((capability) => capability.name);
    assert.equal(new Set(names).size, names.length);
    if (manifest.version === '1.1.0') {
      assert.ok(
        names.includes(additions[manifest.appKey]!),
        `${manifest.appKey}@1.1.0 adds ${additions[manifest.appKey]}`,
      );
    } else {
      assert.ok(
        !names.includes(additions[manifest.appKey]!),
        `${manifest.appKey}@1.0.0 does not yet declare the 1.1.0 addition`,
      );
    }
  }
});

test('AC-1: the bounded app state is EXPLICITLY bounded — the pack\'s OWN app:<key>:<local> namespaces only, never a core-authority namespace', () => {
  for (const manifest of allFirstPartyManifests()) {
    assert.ok(manifest.stateNamespaces.length >= 1, `${manifest.appKey}: declares app state`);
    for (const namespace of manifest.stateNamespaces) {
      // The REAL registry namespace predicate (appKey, namespace).
      assert.ok(
        isLegalAppStateNamespace(manifest.appKey, namespace).legal,
        `${manifest.appKey}: ${namespace} is a legal app-owned namespace`,
      );
      // The namespace is under the app's OWN key.
      assert.ok(
        namespace.startsWith(`app:${manifest.appKey}:`),
        `${manifest.appKey}: ${namespace} is namespaced under the app's own key`,
      );
    }
  }
});

test('AC-1: the mos-analytics connector declaration is constrained — network destination + credential LOGICAL NAME, consumed only by the EXISTING /integrations authority', () => {
  const analytics = allFirstPartyManifests().filter(
    (manifest) => manifest.appKey === 'mos-analytics',
  );
  for (const manifest of analytics) {
    // ONE declared network destination (the analytics connector host).
    assert.equal(manifest.networkDestinations.length, 1);
    const destination = manifest.networkDestinations[0]!;
    assert.equal(destination.protocol, 'https');
    assert.equal(destination.port, 443);
    assert.ok(destination.reason.includes('/integrations'), 'the reason names the /integrations authority');
    // The credential reference is a LOGICAL NAME ONLY (never material).
    assert.deepEqual(manifest.requiredCredentialNames, ['ANALYTICS_API_KEY']);
  }
  // The other three packs declare NO network destinations (no connectors).
  for (const manifest of allFirstPartyManifests()) {
    if (manifest.appKey !== 'mos-analytics') {
      assert.deepEqual(manifest.networkDestinations, [], `${manifest.appKey}: no direct network`);
      assert.deepEqual(manifest.requiredCredentialNames, []);
    }
  }
});

test('AC-1: mos-sheets is the ONLY pack requesting a mutation scope — metric:append (the gated append-observation action input)', () => {
  for (const manifest of allFirstPartyManifests()) {
    if (manifest.appKey === 'mos-sheets') {
      assert.deepEqual(manifest.mutationScopes, ['metric:append']);
    } else {
      assert.deepEqual(manifest.mutationScopes, [], `${manifest.appKey}: presentation only`);
    }
  }
});

test('the pack catalog aggregation matches the frozen descriptors (publish source = catalog)', () => {
  for (const descriptor of FIRST_PARTY_APP_PACKS) {
    const entry = packCatalogEntry(descriptor.appKey);
    assert.notEqual(entry, null);
    assert.equal(entry!.family, descriptor.family);
    assert.deepEqual(entry!.versions, ['1.0.0', '1.1.0']);
    assert.deepEqual([...entry!.surfaces].sort(), [...descriptor.surfaces].sort());
    assert.deepEqual(entry!.stateNamespaces, [...descriptor.stateNamespaces]);
  }
  assert.equal(packCatalogEntry('not-a-pack'), null);
  // The disclosed first-party publisher identity (the svc: label).
  assert.equal(FIRST_PARTY_PUBLISHER_IDENTITY, 'svc:internal-api-token');
  assert.ok(FIRST_PARTY_PUBLISHER_IDENTITY.startsWith('svc:'));
});

// ---------------------------------------------------------------------------
// The surface-scope requirement map (the fail-closed composition contract)
// ---------------------------------------------------------------------------

test('every declared (pack, surface) pair carries its REQUIRED data-scope requirement (the composition gate map)', () => {
  for (const [pair, required] of Object.entries(PACK_SURFACE_REQUIRED_DATA_SCOPES)) {
    const [appKey, surface] = pair.split(':')!;
    const descriptor = FIRST_PARTY_APP_PACKS.find((pack) => pack.appKey === appKey);
    assert.notEqual(descriptor, null, `${appKey} is a first-party pack`);
    assert.ok(
      descriptor!.surfaces.includes(surface as never),
      `${appKey} declares the ${surface} surface`,
    );
    assert.ok(required.length >= 1, `${pair}: at least one required scope`);
    for (const scope of required) {
      assert.ok(['client:read', 'workspace:read'].includes(scope));
    }
  }
  // Every pack surface has a map entry.
  for (const descriptor of FIRST_PARTY_APP_PACKS) {
    for (const surface of descriptor.surfaces) {
      assert.ok(
        requiredDataScopesForSurface(descriptor.appKey, surface).length >= 1,
        `${descriptor.appKey}:${surface} is mapped`,
      );
    }
  }
  // Unknown pairs carry no requirement (fail-closed at the declaration check instead).
  assert.deepEqual(requiredDataScopesForSurface('unknown-app', 'report-page'), []);
});

// ---------------------------------------------------------------------------
// The declared actions (presentation-only declarations of EXISTING routes)
// ---------------------------------------------------------------------------

test('the declared actions point at EXISTING authority command routes and gate on granted mutation scopes — pack code executes nothing', () => {
  const sheetsActions = declaredActionFor('mos-sheets', 'editor-pane');
  assert.equal(sheetsActions.length, 1);
  const action = sheetsActions[0]!;
  assert.equal(action.actionId, 'mos-sheets:append-observation');
  assert.equal(action.method, 'POST');
  // The EXISTING /metrics authority append route.
  assert.equal(action.targetRoute, '/api/clients/:clientId/metrics');
  assert.equal(action.requiredMutationScope, 'metric:append');
  assert.equal(action.authority, 'metrics');

  const crmActions = declaredActionFor('mos-crm', 'action-menu');
  assert.equal(crmActions.length, 1);
  assert.equal(crmActions[0]!.targetRoute, '/api/clients/:clientId/decisions');
  assert.equal(crmActions[0]!.requiredMutationScope, null);
  assert.equal(crmActions[0]!.authority, 'decisions');

  // No actions on non-action surfaces.
  assert.deepEqual(declaredActionFor('mos-analytics', 'report-page'), []);
  assert.deepEqual(declaredActionFor('mos-portal', 'client-room-panel'), []);
  // The exported constant is the same declaration.
  assert.equal(MOS_SHEETS_APPEND_OBSERVATION_ACTION.actionId, 'mos-sheets:append-observation');
});

// ---------------------------------------------------------------------------
// AC-3 — the bounded app-state guards (pure)
// ---------------------------------------------------------------------------

test('AC-3: the §21 material-key backstop rejects material-shaped keys in bounded state values (the SHARED /apps guard)', () => {
  const problems = packStateMutationProblems({
    appKey: 'mos-sheets',
    namespace: 'app:mos-sheets:documents',
    nextEntries: { layout: { apiKey: 'spoofed' } },
    lineage: [],
  });
  assert.ok(problems.some((problem) => problem.includes('material-shaped')), JSON.stringify(problems));
  // Clean entries pass.
  assert.deepEqual(
    packStateMutationProblems({
      appKey: 'mos-sheets',
      namespace: 'app:mos-sheets:documents',
      nextEntries: { default: { cells: [] } },
      lineage: [],
    }),
    [],
  );
});

test('AC-3: the namespace fence — bounded state cannot escape the pack\'s own app:<key>:<local> namespaces', () => {
  const problems = packStateMutationProblems({
    appKey: 'mos-sheets',
    namespace: 'app:mos-crm:pipeline-views',
    nextEntries: {},
    lineage: [],
  });
  assert.ok(problems.some((problem) => problem.includes("own bounded namespaces")));
  // A core-authority-shaped namespace is rejected by the pattern itself
  // (the REAL registry predicate takes (appKey, namespace)).
  assert.equal(
    isLegalAppStateNamespace('mos-sheets', 'workflow').legal,
    false,
    'a core-authority namespace is never a legal app-owned namespace',
  );
  assert.equal(
    isLegalAppStateNamespace('mos-sheets', 'app:workflow:state').legal,
    false,
    'a CORE-AUTHORITY owner key is denied by the registry denylist',
  );
  assert.equal(
    isLegalAppStateNamespace('mos-sheets', 'app:mos-sheets:documents').legal,
    true,
    'the pack\'s own namespace is legal',
  );
});

test('AC-3: the bounded-state bounds — entry count, serialized size, lineage count and lineage kind vocabulary', () => {
  // Entry count.
  const tooMany: Record<string, unknown> = {};
  for (let i = 0; i < PACK_STATE_MAX_ENTRIES + 1; i += 1) {
    tooMany[`k${i}`] = i;
  }
  assert.ok(
    packStateMutationProblems({
      appKey: 'mos-crm',
      namespace: 'app:mos-crm:pipeline-views',
      nextEntries: tooMany,
      lineage: [],
    }).some((problem) => problem.includes('at most 64 entries')),
  );
  // Serialized size.
  const huge = { blob: 'x'.repeat(70_000) };
  assert.ok(
    packStateMutationProblems({
      appKey: 'mos-crm',
      namespace: 'app:mos-crm:pipeline-views',
      nextEntries: huge,
      lineage: [],
    }).some((problem) => problem.includes('serialize')),
  );
  // Lineage kind vocabulary + count.
  assert.ok(
    packStateMutationProblems({
      appKey: 'mos-portal',
      namespace: 'app:mos-portal:presentations',
      nextEntries: {},
      lineage: [{ kind: 'not-a-kind' as 'metric-observation', id: 'x' }],
    }).some((problem) => problem.includes('closed lineage vocabulary')),
  );
  const manyRefs: { kind: 'metric-observation'; id: string }[] = Array.from(
    { length: 65 },
    (_, i) => ({
      kind: 'metric-observation' as const,
      id: `obs-${i}`,
    }),
  );
  assert.ok(
    packStateMutationProblems({
      appKey: 'mos-portal',
      namespace: 'app:mos-portal:presentations',
      nextEntries: {},
      lineage: manyRefs,
    }).some((problem) => problem.includes('canonical references')),
  );
});

test('the state map key is stable and namespaced (workspace | app | namespace)', () => {
  assert.equal(
    packAppStateKey('ws-1', 'mos-sheets', 'app:mos-sheets:documents'),
    'ws-1|mos-sheets|app:mos-sheets:documents',
  );
});
