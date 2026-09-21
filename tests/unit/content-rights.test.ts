/**
 * MKT-063 unit tests — the frozen Content Rights vocabularies, the pure
 * transition-table math, the lineage conjunction math, the state
 * evaluation core, the policy-key composition and the input/provenance
 * guards (pure functions, no DB).
 *
 * Proofs (spec/effective-backlog-v1.6.md MKT-063: "explicit asset-level
 * rights state and publication gate. Acceptance: owned/license/
 * platform-permitted/cleared/review/blocked states, ingredient lineage,
 * fail-closed autonomous publication"; spec/architecture-v1.6.md §9;
 * spec/frozen-manifest-v1.6.json hardPublicationRules:
 * rightsUncertaintyFailsClosed + sourceLineageRequired +
 * destinationPolicyGateRequired; spec/module-dependency-matrix-v1.6.md
 * boundary rule 4):
 *   - the vocabularies are frozen and versioned (cr-vocab-v1): the
 *     rights states (the MKT-063 acceptance list VERBATIM plus the
 *     explicit `unknown` initial state), the asset kinds, the
 *     transition-event kinds, the platform permissions, the gate
 *     outcomes and the gate reason codes;
 *   - THE TRANSITION TABLE (the fail-closed human-action spine):
 *     every legal (from, to, kind) row passes; every illegal pair is
 *     rejected — `cleared` is reachable ONLY from `review` via
 *     human_clearance, unknown/review NEVER auto-approve, no state
 *     jumps backwards, no same-state events;
 *   - THE CONJUNCTION MATH (the lineage rule): any blocked blocks the
 *     composite; else any review_required makes the composite
 *     review_required; only all-allow allows;
 *   - THE STATE EVALUATION CORE: an expired valid_until BLOCKS whatever
 *     the recorded state; unknown/review → review_required (NEVER an
 *     auto-approve); owned/cleared → allow; license/platform_permitted
 *     decide by the destination permission row (permitted allows,
 *     not_permitted blocks, unspecified fails closed to review);
 *   - THE POLICY GATE KEY: publicationPolicyKey composes
 *     content.rights.publication.<platform>;
 *   - the input guards reject every malformed shape (unknown vocabulary
 *     value, malformed asset ref/platform key/timestamp, oversized
 *     fields, missing clearance on human_clearance, clearance payload on
 *     a non-clearance kind) fail-closed BEFORE any write, and the
 *     provenance guard enforces the server-derived discipline.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';
import {
  conjunctionOfGateOutcomes,
  CONTENT_RIGHTS_ASSET_KINDS,
  CONTENT_RIGHTS_EVENT_KINDS,
  CONTENT_RIGHTS_GATE_OUTCOMES,
  CONTENT_RIGHTS_GATE_REASON_CODES,
  CONTENT_RIGHTS_PERMISSIONS,
  CONTENT_RIGHTS_STATES,
  CONTENT_RIGHTS_VOCABULARY_VERSION,
  evaluateContentRightsState,
  isKnownContentRightsAssetKind,
  isKnownContentRightsEventKind,
  isKnownContentRightsGateReasonCode,
  isKnownContentRightsPermission,
  isKnownContentRightsState,
  isLegalContentRightsTransition,
  publicationPolicyKey,
  type ContentRightsProvenance,
} from '../../src/modules/content-rights/public.ts';
import {
  assertValidContentRightsProvenance,
  assertValidGateInput,
  assertValidLineageInput,
  assertValidPermissionInput,
  assertValidRegisterContentRightsInput,
  assertValidTransitionInput,
  CONTENT_ASSET_REF_PATTERN,
  MAX_LINEAGE_DEPTH,
  PLATFORM_KEY_PATTERN,
  transitionProblems,
} from '../../src/modules/content-rights/public.ts';

// ---------------------------------------------------------------------------
// The frozen vocabularies (AC-1)
// ---------------------------------------------------------------------------

test('MKT-063 AC-1: the rights-state vocabulary is frozen, versioned and closed', () => {
  assert.equal(CONTENT_RIGHTS_VOCABULARY_VERSION, 'cr-vocab-v1');
  // The MKT-063 acceptance list VERBATIM + the explicit initial state.
  assert.deepEqual([...CONTENT_RIGHTS_STATES], [
    'owned', 'license', 'platform_permitted', 'cleared', 'review', 'blocked', 'unknown',
  ]);
  // Asset kinds: source | composite (composites resolve by conjunction).
  assert.deepEqual([...CONTENT_RIGHTS_ASSET_KINDS], ['source', 'composite']);
  // The transition-event kinds.
  assert.deepEqual([...CONTENT_RIGHTS_EVENT_KINDS], [
    'determination', 'human_clearance', 'contestation', 'revocation',
    'review_denial', 're_review_request',
  ]);
  // The platform permissions.
  assert.deepEqual([...CONTENT_RIGHTS_PERMISSIONS], ['permitted', 'not_permitted']);
  // The gate outcomes (both non-allow outcomes are fail-closed).
  assert.deepEqual([...CONTENT_RIGHTS_GATE_OUTCOMES], ['allow', 'review_required', 'blocked']);
  // The reason codes: the honest negative + positive basis set.
  assert.deepEqual([...CONTENT_RIGHTS_GATE_REASON_CODES], [
    'no_rights_record', 'rights_state_unknown', 'rights_state_review', 'rights_state_blocked',
    'licence_expired', 'destination_not_permitted', 'destination_permission_unspecified',
    'policy_denied', 'ingredient_no_rights_record', 'ingredient_rights_unclear',
    'ingredient_blocked', 'lineage_missing', 'lineage_cycle', 'lineage_depth_exceeded',
    'allowed_owned', 'allowed_license_scope', 'allowed_platform_permission',
    'allowed_human_clearance',
  ]);

  // The guards close the vocabularies.
  for (const value of CONTENT_RIGHTS_STATES) assert.ok(isKnownContentRightsState(value));
  for (const value of CONTENT_RIGHTS_ASSET_KINDS) assert.ok(isKnownContentRightsAssetKind(value));
  for (const value of CONTENT_RIGHTS_EVENT_KINDS) assert.ok(isKnownContentRightsEventKind(value));
  for (const value of CONTENT_RIGHTS_PERMISSIONS) assert.ok(isKnownContentRightsPermission(value));
  for (const value of CONTENT_RIGHTS_GATE_REASON_CODES) {
    assert.ok(isKnownContentRightsGateReasonCode(value));
  }
  assert.ok(!isKnownContentRightsState('explicit_license'));
  assert.ok(!isKnownContentRightsState('unclear'));
  assert.ok(!isKnownContentRightsState('undetermined'));
  assert.ok(!isKnownContentRightsEventKind('auto_clear'));
  assert.ok(!isKnownContentRightsPermission('unspecified'));
});

// ---------------------------------------------------------------------------
// THE TRANSITION TABLE (the fail-closed human-action spine)
// ---------------------------------------------------------------------------

test('MKT-063 AC-1: every legal (from, to, kind) row of the frozen transition table passes', () => {
  const legal: ReadonlyArray<[string, string, string]> = [
    // determination: unknown → every determined state.
    ['unknown', 'owned', 'determination'],
    ['unknown', 'license', 'determination'],
    ['unknown', 'platform_permitted', 'determination'],
    ['unknown', 'review', 'determination'],
    ['unknown', 'blocked', 'determination'],
    // THE HUMAN-CLEARANCE SPINE: review → cleared ONLY via human_clearance.
    ['review', 'cleared', 'human_clearance'],
    // review denial.
    ['review', 'blocked', 'review_denial'],
    // contestation: determined states → review.
    ['owned', 'review', 'contestation'],
    ['license', 'review', 'contestation'],
    ['platform_permitted', 'review', 'contestation'],
    ['cleared', 'review', 'contestation'],
    // revocation: determined states → blocked.
    ['owned', 'blocked', 'revocation'],
    ['license', 'blocked', 'revocation'],
    ['platform_permitted', 'blocked', 'revocation'],
    ['cleared', 'blocked', 'revocation'],
    // re-review: blocked → review.
    ['blocked', 'review', 're_review_request'],
  ];
  for (const [from, to, kind] of legal) {
    assert.ok(
      isLegalContentRightsTransition({ from: from as never, to: to as never, kind: kind as never }),
      `${from} -> ${to} (${kind}) must be a legal transition`,
    );
    assert.deepEqual(
      transitionProblems(from as never, { eventKind: kind, toState: to }),
      [],
      `transitionProblems accepts ${from} -> ${to} (${kind})`,
    );
  }
});

test('MKT-063 fail-closed: every illegal transition is rejected — cleared is reachable ONLY from review via human_clearance; unknown/review never auto-approve', () => {
  const illegal: ReadonlyArray<[string, string, string]> = [
    // NO state jumps directly into cleared except review + human_clearance.
    ['unknown', 'cleared', 'determination'],
    ['unknown', 'cleared', 'human_clearance'],
    ['owned', 'cleared', 'human_clearance'],
    ['blocked', 'cleared', 'human_clearance'],
    ['review', 'cleared', 'determination'],
    // review never auto-approves to a publishable state without the clearance.
    ['review', 'owned', 'determination'],
    ['review', 'license', 'determination'],
    ['review', 'platform_permitted', 'determination'],
    // determination only resolves unknown.
    ['owned', 'license', 'determination'],
    ['blocked', 'owned', 'determination'],
    ['cleared', 'owned', 'determination'],
    // human_clearance only clears review.
    ['owned', 'cleared', 'human_clearance'],
    ['unknown', 'cleared', 'human_clearance'],
    // contestation only raises review from determined states.
    ['unknown', 'review', 'contestation'],
    ['blocked', 'review', 'contestation'],
    ['review', 'review', 'contestation'],
    // revocation only blocks determined states.
    ['unknown', 'blocked', 'revocation'],
    ['review', 'blocked', 'revocation'],
    ['blocked', 'blocked', 'revocation'],
    // review_denial only blocks review.
    ['owned', 'blocked', 'review_denial'],
    ['unknown', 'blocked', 'review_denial'],
    // re_review_request only reopens blocked.
    ['owned', 'review', 're_review_request'],
    ['review', 'review', 're_review_request'],
    ['cleared', 'review', 're_review_request'],
    // No same-state events, no backwards jumps.
    ['owned', 'owned', 'determination'],
    ['cleared', 'license', 'contestation'],
    ['cleared', 'platform_permitted', 'revocation'],
    ['blocked', 'owned', 're_review_request'],
  ];
  for (const [from, to, kind] of illegal) {
    assert.ok(
      !isLegalContentRightsTransition({ from: from as never, to: to as never, kind: kind as never }),
      `${from} -> ${to} (${kind}) must be REJECTED`,
    );
    assert.ok(
      transitionProblems(from as never, { eventKind: kind, toState: to }).length > 0,
      `transitionProblems rejects ${from} -> ${to} (${kind})`,
    );
  }
});

// ---------------------------------------------------------------------------
// THE CONJUNCTION MATH (the lineage rule)
// ---------------------------------------------------------------------------

test('MKT-063 AC-3: the conjunction math — any unclear ingredient blocks the composite from autonomous publication', () => {
  // Only all-allow allows.
  assert.equal(conjunctionOfGateOutcomes(['allow', 'allow', 'allow']), 'allow');
  assert.equal(conjunctionOfGateOutcomes(['allow']), 'allow');
  assert.equal(conjunctionOfGateOutcomes([]), 'allow');
  // ANY unclear (review_required) ingredient → the composite is review_required.
  assert.equal(conjunctionOfGateOutcomes(['allow', 'review_required']), 'review_required');
  assert.equal(conjunctionOfGateOutcomes(['review_required', 'allow', 'allow']), 'review_required');
  // ANY blocked ingredient → the composite is blocked (the strongest fail-closed).
  assert.equal(conjunctionOfGateOutcomes(['allow', 'blocked']), 'blocked');
  assert.equal(conjunctionOfGateOutcomes(['review_required', 'blocked']), 'blocked');
  assert.equal(conjunctionOfGateOutcomes(['blocked', 'review_required', 'allow']), 'blocked');
  // blocked dominates review_required — a composite with one blocked and
  // one unclear ingredient is BLOCKED outright.
  assert.equal(conjunctionOfGateOutcomes(['blocked', 'review_required']), 'blocked');
});

// ---------------------------------------------------------------------------
// THE STATE EVALUATION CORE (pure gate semantics)
// ---------------------------------------------------------------------------

test('MKT-063 AC-2/AC-4: the pure state evaluation — expired licences BLOCK; unknown/review NEVER auto-approve; destination scope decides licence bases', () => {
  const NOW = '2026-01-15T12:00:00.000Z';
  const FUTURE = '2027-01-01T00:00:00.000Z';
  const PAST = '2025-01-01T00:00:00.000Z';

  // Unknown → review_required (NEVER an auto-approve — the honest
  // human-action surface).
  assert.equal(
    evaluateContentRightsState({ state: 'unknown', validUntil: null, nowIso: NOW, effectivePermission: 'unspecified' }),
    'review_required',
  );
  assert.equal(
    evaluateContentRightsState({ state: 'unknown', validUntil: FUTURE, nowIso: NOW, effectivePermission: 'permitted' }),
    'review_required',
  );
  // Review → review_required.
  assert.equal(
    evaluateContentRightsState({ state: 'review', validUntil: null, nowIso: NOW, effectivePermission: 'permitted' }),
    'review_required',
  );
  // Blocked → blocked.
  assert.equal(
    evaluateContentRightsState({ state: 'blocked', validUntil: null, nowIso: NOW, effectivePermission: 'permitted' }),
    'blocked',
  );
  // Owned → allow (the user's own content).
  assert.equal(
    evaluateContentRightsState({ state: 'owned', validUntil: null, nowIso: NOW, effectivePermission: 'unspecified' }),
    'allow',
  );
  // Cleared → allow (the recorded explicit human clearance).
  assert.equal(
    evaluateContentRightsState({ state: 'cleared', validUntil: null, nowIso: NOW, effectivePermission: 'unspecified' }),
    'allow',
  );

  // Licence-basis states decide by the destination permission row.
  assert.equal(
    evaluateContentRightsState({ state: 'license', validUntil: FUTURE, nowIso: NOW, effectivePermission: 'permitted' }),
    'allow',
  );
  assert.equal(
    evaluateContentRightsState({ state: 'license', validUntil: FUTURE, nowIso: NOW, effectivePermission: 'not_permitted' }),
    'blocked',
  );
  assert.equal(
    evaluateContentRightsState({ state: 'license', validUntil: FUTURE, nowIso: NOW, effectivePermission: 'unspecified' }),
    'review_required',
  );
  assert.equal(
    evaluateContentRightsState({ state: 'platform_permitted', validUntil: FUTURE, nowIso: NOW, effectivePermission: 'permitted' }),
    'allow',
  );
  assert.equal(
    evaluateContentRightsState({ state: 'platform_permitted', validUntil: FUTURE, nowIso: NOW, effectivePermission: 'not_permitted' }),
    'blocked',
  );
  assert.equal(
    evaluateContentRightsState({ state: 'platform_permitted', validUntil: FUTURE, nowIso: NOW, effectivePermission: 'unspecified' }),
    'review_required',
  );

  // EXPIRY FAILS CLOSED: a passed valid_until BLOCKS whatever the
  // recorded state — even owned/cleared/permitted bases.
  assert.equal(
    evaluateContentRightsState({ state: 'license', validUntil: PAST, nowIso: NOW, effectivePermission: 'permitted' }),
    'blocked',
  );
  assert.equal(
    evaluateContentRightsState({ state: 'owned', validUntil: PAST, nowIso: NOW, effectivePermission: 'unspecified' }),
    'blocked',
  );
  assert.equal(
    evaluateContentRightsState({ state: 'cleared', validUntil: PAST, nowIso: NOW, effectivePermission: 'unspecified' }),
    'blocked',
  );
  assert.equal(
    evaluateContentRightsState({ state: 'platform_permitted', validUntil: PAST, nowIso: NOW, effectivePermission: 'permitted' }),
    'blocked',
  );
  // The exact-boundary instant is expired (<= semantics, fail-closed).
  assert.equal(
    evaluateContentRightsState({ state: 'license', validUntil: NOW, nowIso: NOW, effectivePermission: 'permitted' }),
    'blocked',
  );
});

// ---------------------------------------------------------------------------
// The policy gate key (the destinationPolicyGateRequired hard rule)
// ---------------------------------------------------------------------------

test('MKT-063: publicationPolicyKey composes the destination policy key for every platform', () => {
  assert.equal(publicationPolicyKey('youtube'), 'content.rights.publication.youtube');
  assert.equal(publicationPolicyKey('instagram'), 'content.rights.publication.instagram');
  assert.equal(publicationPolicyKey('facebook_pages'), 'content.rights.publication.facebook_pages');
  assert.equal(publicationPolicyKey('tiktok'), 'content.rights.publication.tiktok');
  assert.equal(publicationPolicyKey('x'), 'content.rights.publication.x');
});

// ---------------------------------------------------------------------------
// The grammar fences (the MKT-064 seam + the platform keys)
// ---------------------------------------------------------------------------

test('MKT-063: the content-asset reference and platform-key grammars are fenced', () => {
  assert.equal(MAX_LINEAGE_DEPTH, 16);
  // Asset refs: opaque, path-safe, bounded.
  for (const ok of ['asset-1', 'clip.42', 'src_2024:final', 'A', 'x'.repeat(128)]) {
    assert.ok(CONTENT_ASSET_REF_PATTERN.test(ok), `asset ref '${ok.slice(0, 12)}' must be valid`);
  }
  for (const bad of ['', '-leading', '.dot', 'has space', 'a/b', 'a\\b', 'a'.repeat(129), 'scheme://x']) {
    assert.ok(!CONTENT_ASSET_REF_PATTERN.test(bad), `asset ref '${bad.slice(0, 12)}' must be REJECTED`);
  }
  // Platform keys: lowercase adapter-plane keys.
  for (const ok of ['youtube', 'x', 'facebook_pages', 'a-b_c1']) {
    assert.ok(PLATFORM_KEY_PATTERN.test(ok), `platform key '${ok}' must be valid`);
  }
  for (const bad of ['', 'YouTube', '1abc', '-abc', 'a b', 'a'.repeat(33), 'a/b']) {
    assert.ok(!PLATFORM_KEY_PATTERN.test(bad), `platform key '${bad}' must be REJECTED`);
  }
});

// ---------------------------------------------------------------------------
// The input guards (fail-closed by rejection — before any write)
// ---------------------------------------------------------------------------

const VALID_PROVENANCE: ContentRightsProvenance = {
  actor: 'user:11111111-1111-4111-8111-111111111111',
  recordedVia: 'test',
  correlationId: 'unit-content-rights-1',
  causationId: null,
};

test('MKT-063: the registration guard rejects every malformed shape fail-closed', () => {
  const base = {
    agencyId: '22222222-2222-4222-8222-222222222222',
    clientId: '33333333-3333-4333-8333-333333333333',
    workspaceId: null,
    contentAssetRef: 'asset-1',
    assetKind: 'source' as const,
    sourceEvidenceRef: '44444444-4444-4444-8444-444444444444',
    licenceLabel: null,
    licenceEvidenceRef: null,
    validUntil: null,
  };
  assertValidRegisterContentRightsInput(base);

  // Malformed tenant scope.
  assert.throws(
    () => assertValidRegisterContentRightsInput({ ...base, agencyId: 'not-a-uuid' }),
    InvalidRequestError,
  );
  // Malformed asset ref (the MKT-064 seam grammar).
  assert.throws(
    () => assertValidRegisterContentRightsInput({ ...base, contentAssetRef: 'bad ref!' }),
    InvalidRequestError,
  );
  // Unknown asset kind.
  assert.throws(
    () => assertValidRegisterContentRightsInput({ ...base, assetKind: 'remix' as never }),
    InvalidRequestError,
  );
  // Source provenance evidence is REQUIRED.
  assert.throws(
    () => assertValidRegisterContentRightsInput({ ...base, sourceEvidenceRef: 'missing' }),
    InvalidRequestError,
  );
  // Malformed licence evidence / label / validUntil.
  assert.throws(
    () => assertValidRegisterContentRightsInput({ ...base, licenceEvidenceRef: 'nope' }),
    InvalidRequestError,
  );
  assert.throws(
    () => assertValidRegisterContentRightsInput({ ...base, licenceLabel: 'x'.repeat(501) }),
    InvalidRequestError,
  );
  assert.throws(
    () => assertValidRegisterContentRightsInput({ ...base, validUntil: 'not-a-timestamp' }),
    InvalidRequestError,
  );
});

test('MKT-063: the transition guard — the clearance payload is REQUIRED exactly for human_clearance', () => {
  const base = {
    rightsRecordId: '55555555-5555-4555-8555-555555555555',
    eventKind: 'determination' as const,
    toState: 'owned' as const,
    reason: 'the asset is the client\'s own recording',
    clearance: null,
  };
  assertValidTransitionInput(base);

  // human_clearance WITHOUT the clearance payload → fail-closed.
  assert.throws(
    () =>
      assertValidTransitionInput({
        ...base,
        eventKind: 'human_clearance',
        toState: 'cleared',
      }),
    InvalidRequestError,
  );
  // human_clearance WITH the payload passes.
  assertValidTransitionInput({
    ...base,
    eventKind: 'human_clearance',
    toState: 'cleared',
    clearance: { rationale: 'the licence covers this destination; reviewed by counsel', evidenceRef: null },
  });
  // A clearance payload on a NON-clearance kind → fail-closed.
  assert.throws(
    () =>
      assertValidTransitionInput({
        ...base,
        clearance: { rationale: 'should not be here', evidenceRef: null },
      }),
    InvalidRequestError,
  );
  // Empty rationale → fail-closed (the human clearance must say WHY).
  assert.throws(
    () =>
      assertValidTransitionInput({
        ...base,
        eventKind: 'human_clearance',
        toState: 'cleared',
        clearance: { rationale: '   ', evidenceRef: null },
      }),
    InvalidRequestError,
  );
  // Unknown kind / unknown target / missing reason → fail-closed.
  assert.throws(
    () => assertValidTransitionInput({ ...base, eventKind: 'auto_clear' as never }),
    InvalidRequestError,
  );
  assert.throws(
    () => assertValidTransitionInput({ ...base, toState: 'explicit_license' as never }),
    InvalidRequestError,
  );
  assert.throws(
    () => assertValidTransitionInput({ ...base, reason: '' }),
    InvalidRequestError,
  );
});

test('MKT-063: the permission/lineage/gate guards reject malformed shapes fail-closed', () => {
  // Permission.
  assertValidPermissionInput({
    rightsRecordId: '55555555-5555-4555-8555-555555555555',
    platformKey: 'youtube',
    permission: 'permitted',
    evidenceRef: '44444444-4444-4444-8444-444444444444',
  });
  assert.throws(
    () =>
      assertValidPermissionInput({
        rightsRecordId: '55555555-5555-4555-8555-555555555555',
        platformKey: 'YouTube',
        permission: 'permitted',
        evidenceRef: '44444444-4444-4444-8444-444444444444',
      }),
    InvalidRequestError,
  );
  assert.throws(
    () =>
      assertValidPermissionInput({
        rightsRecordId: '55555555-5555-4555-8555-555555555555',
        platformKey: 'youtube',
        permission: 'maybe' as never,
        evidenceRef: '44444444-4444-4444-8444-444444444444',
      }),
    InvalidRequestError,
  );

  // Lineage: no self-links, no malformed refs.
  assertValidLineageInput({
    agencyId: '22222222-2222-4222-8222-222222222222',
    clientId: '33333333-3333-4333-8333-333333333333',
    workspaceId: null,
    compositeAssetRef: 'comp-1',
    ingredientAssetRef: 'ingr-1',
  });
  assert.throws(
    () =>
      assertValidLineageInput({
        agencyId: '22222222-2222-4222-8222-222222222222',
        clientId: '33333333-3333-4333-8333-333333333333',
        workspaceId: null,
        compositeAssetRef: 'same-ref',
        ingredientAssetRef: 'same-ref',
      }),
    InvalidRequestError,
  );
  assert.throws(
    () =>
      assertValidLineageInput({
        agencyId: '22222222-2222-4222-8222-222222222222',
        clientId: '33333333-3333-4333-8333-333333333333',
        workspaceId: null,
        compositeAssetRef: 'bad ref',
        ingredientAssetRef: 'ingr-1',
      }),
    InvalidRequestError,
  );

  // Gate.
  assertValidGateInput({
    agencyId: '22222222-2222-4222-8222-222222222222',
    clientId: '33333333-3333-4333-8333-333333333333',
    assetRef: 'asset-1',
    destinationPlatform: 'youtube',
  });
  assert.throws(
    () =>
      assertValidGateInput({
        agencyId: '22222222-2222-4222-8222-222222222222',
        clientId: '33333333-3333-4333-8333-333333333333',
        assetRef: 'asset 1',
        destinationPlatform: 'youtube',
      }),
    InvalidRequestError,
  );
  assert.throws(
    () =>
      assertValidGateInput({
        agencyId: '22222222-2222-4222-8222-222222222222',
        clientId: '33333333-3333-4333-8333-333333333333',
        assetRef: 'asset-1',
        destinationPlatform: 'YouTube',
      }),
    InvalidRequestError,
  );
});

test('MKT-063: the provenance guard enforces the server-derived discipline', () => {
  assertValidContentRightsProvenance(VALID_PROVENANCE);
  assert.throws(
    () => assertValidContentRightsProvenance({ ...VALID_PROVENANCE, actor: '' }),
    InvalidRequestError,
  );
  assert.throws(
    () => assertValidContentRightsProvenance({ ...VALID_PROVENANCE, recordedVia: '' }),
    InvalidRequestError,
  );
  assert.throws(
    () => assertValidContentRightsProvenance({ ...VALID_PROVENANCE, correlationId: '' }),
    InvalidRequestError,
  );
  assert.throws(
    () => assertValidContentRightsProvenance({ ...VALID_PROVENANCE, actor: 'x'.repeat(101) }),
    InvalidRequestError,
  );
});
