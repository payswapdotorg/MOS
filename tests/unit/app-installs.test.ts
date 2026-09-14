/**
 * MKT-048 unit tests — the frozen App installation contract as PURE
 * functions (spec/mos-app-ecosystem-v1.5.md "Install and invoke", "Bounded
 * app state", "Upgrade and rollback"; spec/effective-backlog-v1.5.md
 * MKT-048; spec/architecture-lock-v1.5.md rules #10/#11 — App versions are
 * immutable; upgrade/rollback changes FUTURE version selection only; app
 * permissions are least-privilege, policy-gated and server-derived).
 *
 * Acceptance mapping (MKT-048 AC-11 — "selection/upgrade state machine,
 * scope-intersection derivation, compatibility eligibility"):
 *   - the SELECTION/UPGRADE STATE MACHINE: install is legal exactly when
 *     the lineage is empty; upgrade selects a NEW version (never a
 *     previously selected one — that is rollback); rollback reselects a
 *     PREVIOUSLY INSTALLED approved version; same-version selection
 *     changes are rejected; an empty lineage rejects upgrade/rollback;
 *   - the SCOPE-INTERSECTION DERIVATION: the manifest's requested scopes
 *     ∩ the policy-allowed labels ∩ the FROZEN vocabularies — order
 *     follows the manifest declaration, the result is always a subset of
 *     the request, and labels outside the frozen vocabularies are never
 *     granted;
 *   - the COMPATIBILITY ELIGIBILITY resolution: an eligible report
 *     verdict; an ineligible verdict carries the report's honest reasons;
 *     an absent identity is rejected with honest reasons;
 *   - the input guards: authority-shaped keys (granted scopes, lifecycle,
 *     provenance) and material-shaped keys (§21) are rejected on every
 *     selection input; malformed selectors are rejected; the
 *     SERVER-DERIVED provenance block is validated separately;
 *   - the §8-style create fingerprint: deterministic canonical digest —
 *     identical logical commands converge, divergent content diverges.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_INSTALL_OPERATIONS,
  APP_INSTALL_STATUSES,
  APP_INSTALL_TRANSITIONS,
  evaluateSelectionRequest,
  intersectGrantedScopes,
  resolveTargetCompatibility,
  APP_INSTALLS_PLATFORM_VERSION,
  type AppInstallLineageState,
} from '../../src/modules/app-installs/public.ts';
import {
  APP_INSTALLS_MATERIAL_SHAPED_KEYS,
  appInstallCreateFingerprint,
  assertValidAppInstallProvenance,
  assertValidSelectionInput,
} from '../../src/modules/app-installs/public.ts';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';

const CURRENT: NonNullable<AppInstallLineageState['current']> = {
  installId: 'b65e07a1-1111-4111-8111-111111111111',
  version: '1.0.0',
  selectionSeq: 1,
};

function lineage(
  current: AppInstallLineageState['current'],
  selectedVersions: readonly string[],
): AppInstallLineageState {
  return { current, selectedVersions };
}

test('MKT-048 vocabularies: the three selection operations and the two-state lifecycle', () => {
  assert.deepEqual(APP_INSTALL_OPERATIONS, ['install', 'upgrade', 'rollback']);
  assert.deepEqual(APP_INSTALL_STATUSES, ['ACTIVE', 'SUPERSEDED']);
  // Born ACTIVE; the ONLY sanctioned transition is the supersession —
  // history is never rewritten and rows never leave the ledger.
  assert.deepEqual(APP_INSTALL_TRANSITIONS['ACTIVE'], ['SUPERSEDED']);
  assert.deepEqual(APP_INSTALL_TRANSITIONS['SUPERSEDED'], []);
});

test('selection state machine: install is legal exactly when the lineage is EMPTY', () => {
  const empty: AppInstallLineageState = { current: null, selectedVersions: [] };
  assert.deepEqual(evaluateSelectionRequest(empty, { operation: 'install', targetVersion: '1.0.0' }), { ok: true });
  // An existing current selection blocks a second install.
  const verdict = evaluateSelectionRequest(lineage(CURRENT, ['1.0.0']), {
    operation: 'install',
    targetVersion: '2.0.0',
  });
  assert.equal(verdict.ok, false);
  assert.match((verdict as { reason: string }).reason, /already has a current selection/);
});

test('selection state machine: upgrade selects a NEW version — never a previously selected one', () => {
  const state = lineage(CURRENT, ['1.0.0']);
  // A NEW version upgrades legally.
  assert.deepEqual(
    evaluateSelectionRequest(state, { operation: 'upgrade', targetVersion: '2.0.0' }),
    { ok: true },
  );
  // The CURRENT version itself can never be re-selected.
  const same = evaluateSelectionRequest(state, { operation: 'upgrade', targetVersion: '1.0.0' });
  assert.equal(same.ok, false);
  assert.match((same as { reason: string }).reason, /already the current selection/);
  // A PREVIOUSLY INSTALLED (superseded) version is rollback territory.
  const later = lineage(
    { installId: 'b65e07a1-3333-4333-8333-333333333333', version: '2.0.0', selectionSeq: 2 },
    ['1.0.0', '2.0.0'],
  );
  const rollbackOnly = evaluateSelectionRequest(later, { operation: 'upgrade', targetVersion: '1.0.0' });
  assert.equal(rollbackOnly.ok, false);
  assert.match((rollbackOnly as { reason: string }).reason, /rollback reselects previously installed versions/);
});

test('selection state machine: rollback reselects a PREVIOUSLY INSTALLED approved version', () => {
  const state = lineage(
    { installId: 'b65e07a1-2222-4222-8222-222222222222', version: '2.0.0', selectionSeq: 2 },
    ['1.0.0', '2.0.0'],
  );
  // A previously installed version reselects legally.
  assert.deepEqual(
    evaluateSelectionRequest(state, { operation: 'rollback', targetVersion: '1.0.0' }),
    { ok: true },
  );
  // A version that was NEVER installed is not a rollback target.
  const never = evaluateSelectionRequest(state, { operation: 'rollback', targetVersion: '3.0.0' });
  assert.equal(never.ok, false);
  assert.match((never as { reason: string }).reason, /never installed in this workspace/);
  // The CURRENT version cannot roll back to itself.
  const self = evaluateSelectionRequest(state, { operation: 'rollback', targetVersion: '2.0.0' });
  assert.equal(self.ok, false);
  assert.match((self as { reason: string }).reason, /already the current selection/);
});

test('selection state machine: upgrade/rollback require an existing installation', () => {
  const empty: AppInstallLineageState = { current: null, selectedVersions: [] };
  for (const operation of ['upgrade', 'rollback'] as const) {
    const verdict = evaluateSelectionRequest(empty, { operation, targetVersion: '1.0.0' });
    assert.equal(verdict.ok, false);
    assert.match((verdict as { reason: string }).reason, /not installed in this workspace/);
  }
});

test('scope-intersection derivation: requested ∩ policy-allowed ∩ the frozen vocabularies', () => {
  const grants = intersectGrantedScopes(
    ['client:read', 'client:write', 'workspace:read'] as never,
    ['workflow:dispatch', 'evidence:append', 'metric:append'] as never,
    new Set(['client:read', 'workspace:read', 'workflow:dispatch']),
  );
  // Order follows the manifest declaration; the result is a subset.
  assert.deepEqual(grants.grantedDataScopes, ['client:read', 'workspace:read']);
  assert.deepEqual(grants.grantedMutationScopes, ['workflow:dispatch']);
  // A policy that allows NOTHING grants nothing (least-privilege, honest).
  const denied = intersectGrantedScopes(
    ['client:read', 'workspace:write'] as never,
    ['evidence:append'] as never,
    new Set<string>(),
  );
  assert.deepEqual(denied.grantedDataScopes, []);
  assert.deepEqual(denied.grantedMutationScopes, []);
  // Labels OUTSIDE the frozen vocabularies are never granted (the final
  // filter) even when "allowed".
  const vocab = intersectGrantedScopes(
    ['client:read', 'galaxy:read'] as never,
    ['workflow:dispatch', 'universe:fold'] as never,
    new Set(['client:read', 'galaxy:read', 'workflow:dispatch', 'universe:fold']),
  );
  assert.deepEqual(vocab.grantedDataScopes, ['client:read']);
  assert.deepEqual(vocab.grantedMutationScopes, ['workflow:dispatch']);
});

test('compatibility eligibility: the honest verdict resolution over a compatibility report', () => {
  // Eligible: the exact identity appears in the eligible set.
  const eligible = resolveTargetCompatibility(
    { appKey: 'mailer', version: '1.2.0' },
    {
      eligible: [{ appKey: 'mailer', version: '1.2.0' }],
      ineligible: [],
    },
  );
  assert.equal(eligible.eligible, true);
  // Ineligible: the report's honest reasons ride the verdict.
  const ineligible = resolveTargetCompatibility(
    { appKey: 'mailer', version: '2.0.0' },
    {
      eligible: [],
      ineligible: [
        { appKey: 'mailer', version: '2.0.0', reasons: ['platform version 1.5.0 outside [2.1.0 .. 3.0.0]'] },
      ],
    },
  );
  assert.equal(ineligible.eligible, false);
  assert.deepEqual((ineligible as { reasons: readonly string[] }).reasons, [
    'platform version 1.5.0 outside [2.1.0 .. 3.0.0]',
  ]);
  // ABSENT from the report entirely: honest absence reasons.
  const absent = resolveTargetCompatibility(
    { appKey: 'unknown-app', version: '9.9.9' },
    { eligible: [], ineligible: [] },
  );
  assert.equal(absent.eligible, false);
  assert.ok(
    (absent as { reasons: readonly string[] }).reasons.length > 0,
    'an absent target carries honest reasons',
  );
  // The server-declared platform version is a constant, never a request field.
  assert.equal(APP_INSTALLS_PLATFORM_VERSION, '1.5.0');
});

test('input guard: authority-shaped keys are NEVER caller-suppliable (granted scopes, lifecycle, provenance)', () => {
  const base = {
    workspaceId: '0f0e8d6a-0000-4000-8000-000000000001',
    appKey: 'mailer',
    version: '1.0.0',
    idempotencyKey: 'install-mailer-1',
  };
  // The clean selection input passes.
  assert.doesNotThrow(() => assertValidSelectionInput(base));
  for (const key of ['grantedScopes', 'grantedDataScopes', 'grantedMutationScopes', 'status', 'selectionSeq', 'installedBy', 'provenance', 'createFingerprint', 'policyDecisionId']) {
    assert.throws(
      () => assertValidSelectionInput({ ...base, [key]: 'spoofed' }),
      InvalidRequestError,
      `the authority-shaped key '${key}' must be rejected`,
    );
  }
  // Material-shaped keys (§21) are rejected at every level.
  for (const key of APP_INSTALLS_MATERIAL_SHAPED_KEYS) {
    assert.throws(
      () => assertValidSelectionInput({ ...base, [key]: 'x' }),
      InvalidRequestError,
      `the material-shaped key '${key}' must be rejected`,
    );
  }
});

test('input guard: malformed selectors are rejected fail-closed', () => {
  const base = {
    appKey: 'mailer',
    version: '1.0.0',
    idempotencyKey: 'install-mailer-1',
  };
  assert.throws(() => assertValidSelectionInput({ ...base, workspaceId: 'not-a-uuid' }), InvalidRequestError);
  assert.throws(() => assertValidSelectionInput({ ...base, appKey: 'BadKey' }), InvalidRequestError);
  assert.throws(() => assertValidSelectionInput({ ...base, version: '1.0' }), InvalidRequestError);
  assert.throws(() => assertValidSelectionInput({ ...base, idempotencyKey: '' }), InvalidRequestError);
  assert.throws(() => assertValidSelectionInput({ ...base, installId: 'nope' }), InvalidRequestError);
  assert.throws(() => assertValidSelectionInput({ ...base, targetInstallId: 'nope' }), InvalidRequestError);
  // The SERVER-DERIVED provenance block is validated with its own guard.
  assert.doesNotThrow(() =>
    assertValidAppInstallProvenance({ actor: 'user:abc', recordedVia: 'api', correlationId: 'c-1', causationId: null }),
  );
  assert.throws(
    () => assertValidAppInstallProvenance({ actor: '', recordedVia: 'api', correlationId: 'c-1' }),
    InvalidRequestError,
  );
  assert.throws(
    () => assertValidAppInstallProvenance({ actor: 'user:abc', recordedVia: '', correlationId: 'c-1' }),
    InvalidRequestError,
  );
});

test('§8 create fingerprint: deterministic convergence, divergent content diverges', () => {
  const a = appInstallCreateFingerprint({ appKey: 'mailer', version: '1.0.0', operation: 'install' });
  const aReplay = appInstallCreateFingerprint({ appKey: 'mailer', version: '1.0.0', operation: 'install' });
  assert.equal(a, aReplay, 'identical logical commands converge');
  assert.notEqual(
    a,
    appInstallCreateFingerprint({ appKey: 'mailer', version: '2.0.0', operation: 'install' }),
    'a different version diverges',
  );
  assert.notEqual(
    a,
    appInstallCreateFingerprint({ appKey: 'mailer', version: '1.0.0', operation: 'upgrade' }),
    'a different operation diverges',
  );
  assert.notEqual(
    a,
    appInstallCreateFingerprint({ appKey: 'other', version: '1.0.0', operation: 'install' }),
    'a different app diverges',
  );
  assert.match(a, /^[0-9a-f]{64}$/, 'a bounded sha-256 hex digest');
});
