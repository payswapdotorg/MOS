/**
 * MKT-069 unit tests — the Product Intelligence model contract (pure
 * functions; the growth-missions-model precedent).
 *
 * Acceptance mapping (spec/effective-backlog-v1.6.md MKT-069; the dispatch
 * acceptance criteria AC-1..AC-5):
 *   - AC-1 VOCABULARY PINNING: the seven §8 input kinds, the authorization
 *     states + the frozen per-kind map, the nine §8 derivation kinds, the
 *     risk kinds + severities — all frozen, versioned (pi-vocab-v1);
 *   - AC-1 DECLARATION GUARD: structurally honest declarations only (the
 *     authorization-state shape, the per-kind authorization map, the
 *     public-source URL rule, the bounds, at-least-one input);
 *   - AC-3 HYPOTHESIS STRUCTURE: the two hypothesis kinds are frozen to the
 *     flag; no promotion path exists;
 *   - AC-3 VERIFICATION-STATE TRANSITIONS: 'unverified' ⟺ zero backing
 *     references, 'evidence_backed' ⟺ at least one — presence-only, never
 *     counts (repetition never promotes);
 *   - AC-3/AC-4 DERIVED/RISK INPUT GUARDS + PROVENANCE COMPOSITION + the
 *     owner-context composer purity;
 *   - AC-2 EXTRACTOR PURITY + DETERMINISM: the same content always yields
 *     the same observation + the same sha-256 content hash (site pages and
 *     authorized records).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  // The extractor surface is re-exported through the module's PUBLIC
  // entry (tests never import module internals — the arch-check rule).
  INTEGRATION_RECORD_EXTRACTOR_ID,
  SITE_PAGE_EXTRACTOR_ID,
  extractSiteObservation,
  hashContent,
  integrationRecordObservation,
  PRODUCT_INTELLIGENCE_AUTHORIZATION_STATES,
  PRODUCT_INTELLIGENCE_DERIVATION_KINDS,
  PRODUCT_INTELLIGENCE_HYPOTHESIS_KINDS,
  PRODUCT_INTELLIGENCE_INSPECTION_CAPABILITY,
  PRODUCT_INTELLIGENCE_INPUT_AUTHORIZATIONS,
  PRODUCT_INTELLIGENCE_INPUT_KINDS,
  PRODUCT_INTELLIGENCE_RISK_KINDS,
  PRODUCT_INTELLIGENCE_RISK_SEVERITIES,
  PRODUCT_INTELLIGENCE_VERIFICATION_STATES,
  PRODUCT_INTELLIGENCE_VOCABULARY_VERSION,
  PRODUCT_INTELLIGENCE_WRITE_CAPABILITY_SEAM,
  assertValidDerivedModelInput,
  assertValidProductContextDeclaration,
  assertValidProductIntelligenceProvenance,
  assertValidPublicSourceUrl,
  assertValidRiskFlagInput,
  composeProductContextOwnerContext,
  deriveVerificationState,
  isHypothesisDerivationKind,
} from '../../src/modules/product-intelligence/public.ts';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';

// ---------------------------------------------------------------------------
// AC-1: vocabulary pinning (the frozen §8 vocabularies, verbatim)
// ---------------------------------------------------------------------------

test('AC-1 vocabulary pinning: the seven §8 input kinds, verbatim and frozen', () => {
  assert.deepEqual(PRODUCT_INTELLIGENCE_INPUT_KINDS, [
    'public_site_url',
    'authenticated_app_environment',
    'source_code_repository_url',
    'connected_source_workspace',
    'product_documentation',
    'catalog_inventory',
    'current_analytics',
  ]);
  assert.deepEqual(PRODUCT_INTELLIGENCE_AUTHORIZATION_STATES, ['public', 'explicitly_authorized']);
  // The frozen per-kind authorization map.
  assert.deepEqual(PRODUCT_INTELLIGENCE_INPUT_AUTHORIZATIONS.public_site_url, ['public']);
  assert.deepEqual(
    PRODUCT_INTELLIGENCE_INPUT_AUTHORIZATIONS.authenticated_app_environment,
    ['explicitly_authorized'],
  );
  assert.deepEqual(
    PRODUCT_INTELLIGENCE_INPUT_AUTHORIZATIONS.source_code_repository_url,
    ['public', 'explicitly_authorized'],
  );
  assert.deepEqual(
    PRODUCT_INTELLIGENCE_INPUT_AUTHORIZATIONS.connected_source_workspace,
    ['explicitly_authorized'],
  );
  assert.deepEqual(PRODUCT_INTELLIGENCE_INPUT_AUTHORIZATIONS.product_documentation, [
    'public',
    'explicitly_authorized',
  ]);
  assert.deepEqual(PRODUCT_INTELLIGENCE_INPUT_AUTHORIZATIONS.catalog_inventory, [
    'public',
    'explicitly_authorized',
  ]);
  assert.deepEqual(PRODUCT_INTELLIGENCE_INPUT_AUTHORIZATIONS.current_analytics, [
    'public',
    'explicitly_authorized',
  ]);
});

test('AC-1 vocabulary pinning: the nine §8 derivation kinds + the two hypothesis kinds, verbatim and frozen', () => {
  assert.deepEqual(PRODUCT_INTELLIGENCE_DERIVATION_KINDS, [
    'product_capability',
    'user_problem_hypothesis',
    'icp_audience_hypothesis',
    'value_proposition',
    'conversion_path',
    'content_worthy_feature',
    'market_language',
    'product_risk',
    'commercial_metric',
  ]);
  assert.deepEqual(PRODUCT_INTELLIGENCE_HYPOTHESIS_KINDS, [
    'user_problem_hypothesis',
    'icp_audience_hypothesis',
  ]);
  assert.equal(PRODUCT_INTELLIGENCE_VOCABULARY_VERSION, 'pi-vocab-v1');
});

test('AC-4 vocabulary pinning: the five risk kinds + the three severities + the AC-5 disclosures', () => {
  assert.deepEqual(PRODUCT_INTELLIGENCE_RISK_KINDS, [
    'compliance',
    'privacy',
    'toxicity',
    'commercial',
    'operational',
  ]);
  assert.deepEqual(PRODUCT_INTELLIGENCE_RISK_SEVERITIES, ['low', 'medium', 'high']);
  assert.equal(
    PRODUCT_INTELLIGENCE_INSPECTION_CAPABILITY,
    'source-inspection:fetch-read-only',
  );
  assert.ok(
    PRODUCT_INTELLIGENCE_WRITE_CAPABILITY_SEAM.includes('separately-granted-capability-key'),
    'the write seam documents the separately granted capability key (documented, NOT built)',
  );
});

// ---------------------------------------------------------------------------
// AC-3: hypothesis structure + verification-state transitions
// ---------------------------------------------------------------------------

test('AC-3 hypothesis structure: the two hypothesis kinds are frozen to the flag; every other kind is not', () => {
  assert.ok(isHypothesisDerivationKind('user_problem_hypothesis'));
  assert.ok(isHypothesisDerivationKind('icp_audience_hypothesis'));
  for (const kind of PRODUCT_INTELLIGENCE_DERIVATION_KINDS) {
    if ((PRODUCT_INTELLIGENCE_HYPOTHESIS_KINDS as readonly string[]).includes(kind)) continue;
    assert.equal(isHypothesisDerivationKind(kind), false, `${kind} is not a hypothesis kind`);
  }
});

test('AC-3 verification-state transitions: unverified ⟺ zero backing; evidence_backed ⟺ at least one; presence-only, never counts', () => {
  assert.deepEqual(PRODUCT_INTELLIGENCE_VERIFICATION_STATES, ['unverified', 'evidence_backed']);
  // Zero backing → unverified.
  assert.equal(
    deriveVerificationState({ sourceFactIds: [], evidenceCitations: [] }),
    'unverified',
  );
  // A source-fact reference alone → evidence_backed.
  assert.equal(
    deriveVerificationState({ sourceFactIds: ['f1'], evidenceCitations: [] }),
    'evidence_backed',
  );
  // A canonical evidence citation alone → evidence_backed.
  assert.equal(
    deriveVerificationState({ sourceFactIds: [], evidenceCitations: ['e1'] }),
    'evidence_backed',
  );
  // REPETITION NEVER PROMOTES: the state reads PRESENCE, never counts —
  // one reference and fifty references are equally 'evidence_backed', and
  // no number of unbacked restatements changes anything (the pure
  // function sees only the backing lists of THIS record).
  assert.equal(
    deriveVerificationState({
      sourceFactIds: ['f1', 'f2', 'f3', 'f4', 'f5'],
      evidenceCitations: ['e1', 'e2'],
    }),
    'evidence_backed',
  );
  assert.equal(
    deriveVerificationState({ sourceFactIds: [], evidenceCitations: [] }),
    'unverified',
  );
});

// ---------------------------------------------------------------------------
// AC-1: the declaration guard
// ---------------------------------------------------------------------------

function validDeclaration() {
  return {
    name: 'PaySwap Pro',
    summary: 'The crypto payments product',
    inputs: [
      {
        inputKind: 'public_site_url' as const,
        reference: 'https://payswap.org',
        authorizationState: 'public' as const,
        authorizationRef: null,
        notes: null,
      },
      {
        inputKind: 'source_code_repository_url' as const,
        reference: 'https://github.com/payswapdotorg/MOS',
        authorizationState: 'explicitly_authorized' as const,
        authorizationRef: '11111111-1111-4111-8111-111111111111',
        notes: 'the authorized repository',
      },
    ],
  };
}

test('AC-1 declaration guard: a valid declaration passes', () => {
  assert.doesNotThrow(() => assertValidProductContextDeclaration(validDeclaration()));
});

test('AC-1 declaration guard: the bounds, the required inputs and the kinds are enforced', () => {
  // No inputs at all.
  const empty = { ...validDeclaration(), inputs: [] };
  assert.throws(() => assertValidProductContextDeclaration(empty), InvalidRequestError);
  // Unknown kind.
  const badKind = {
    ...validDeclaration(),
    inputs: [
      { ...validDeclaration().inputs[0]!, inputKind: 'internal_wiki' as never },
    ],
  };
  assert.throws(() => assertValidProductContextDeclaration(badKind), InvalidRequestError);
  // Empty name / over-long name.
  assert.throws(
    () => assertValidProductContextDeclaration({ ...validDeclaration(), name: '' }),
    InvalidRequestError,
  );
  assert.throws(
    () => assertValidProductContextDeclaration({ ...validDeclaration(), name: 'x'.repeat(501) }),
    InvalidRequestError,
  );
});

test('AC-1 declaration guard: the per-kind authorization map + the authorization-shape fence are enforced', () => {
  // A public_site_url declared explicitly authorized → rejected.
  assert.throws(
    () =>
      assertValidProductContextDeclaration({
        ...validDeclaration(),
        inputs: [
          {
            inputKind: 'public_site_url',
            reference: 'https://payswap.org',
            authorizationState: 'explicitly_authorized',
            authorizationRef: '11111111-1111-4111-8111-111111111111',
            notes: null,
          },
        ],
      }),
    InvalidRequestError,
  );
  // A connected source workspace declared public → rejected.
  assert.throws(
    () =>
      assertValidProductContextDeclaration({
        ...validDeclaration(),
        inputs: [
          {
            inputKind: 'connected_source_workspace',
            reference: 'workspace-ref',
            authorizationState: 'public',
            authorizationRef: null,
            notes: null,
          },
        ],
      }),
    InvalidRequestError,
  );
  // An explicitly-authorized input WITHOUT the authorization reference → rejected.
  assert.throws(
    () =>
      assertValidProductContextDeclaration({
        ...validDeclaration(),
        inputs: [
          {
            inputKind: 'connected_source_workspace',
            reference: 'workspace-ref',
            authorizationState: 'explicitly_authorized',
            authorizationRef: null,
            notes: null,
          },
        ],
      }),
    InvalidRequestError,
  );
  // A public input WITH a stray authorization reference → rejected.
  assert.throws(
    () =>
      assertValidProductContextDeclaration({
        ...validDeclaration(),
        inputs: [
          {
            inputKind: 'source_code_repository_url',
            reference: 'https://github.com/payswapdotorg/MOS',
            authorizationState: 'public',
            authorizationRef: '11111111-1111-4111-8111-111111111111',
            notes: null,
          },
        ],
      }),
    InvalidRequestError,
  );
});

test('AC-2 public-source URL rule: https passes, http loopback passes, http non-loopback and junk are rejected', () => {
  assert.doesNotThrow(() => assertValidPublicSourceUrl('https://payswap.org/pricing', 'reference'));
  assert.doesNotThrow(() =>
    assertValidPublicSourceUrl('http://127.0.0.1:8080/fixture.html', 'reference'),
  );
  assert.doesNotThrow(() => assertValidPublicSourceUrl('http://localhost/fixture', 'reference'));
  assert.throws(
    () => assertValidPublicSourceUrl('http://payswap.org', 'reference'),
    InvalidRequestError,
  );
  assert.throws(() => assertValidPublicSourceUrl('not-a-url', 'reference'), InvalidRequestError);
  assert.throws(() => assertValidPublicSourceUrl('ftp://payswap.org', 'reference'), InvalidRequestError);
  // The rule applies to every publicly-declared input at declaration time.
  assert.throws(
    () =>
      assertValidProductContextDeclaration({
        ...validDeclaration(),
        inputs: [
          {
            inputKind: 'public_site_url',
            reference: 'http://payswap.org',
            authorizationState: 'public',
            authorizationRef: null,
            notes: null,
          },
        ],
      }),
    InvalidRequestError,
  );
});

// ---------------------------------------------------------------------------
// AC-3/AC-4: the derived-record / risk-flag input guards + provenance
// ---------------------------------------------------------------------------

test('AC-3 derived-record guard: kinds, statement bounds, duplicate reference lists and the ai-disclosure shape', () => {
  assert.doesNotThrow(() =>
    assertValidDerivedModelInput({
      derivationKind: 'product_capability',
      statement: 'The product accepts crypto payments at checkout.',
      detail: { capability: 'crypto-checkout' },
      sourceFactIds: ['f1'],
      evidenceCitations: [],
      aiAssistance: null,
    }),
  );
  // Unknown kind.
  assert.throws(
    () =>
      assertValidDerivedModelInput({
        derivationKind: 'niche_cluster' as never,
        statement: 'x',
        detail: null,
        sourceFactIds: [],
        evidenceCitations: [],
        aiAssistance: null,
      }),
    InvalidRequestError,
  );
  // Empty / over-long statement.
  assert.throws(
    () =>
      assertValidDerivedModelInput({
        derivationKind: 'value_proposition',
        statement: '',
        detail: null,
        sourceFactIds: [],
        evidenceCitations: [],
        aiAssistance: null,
      }),
    InvalidRequestError,
  );
  assert.throws(
    () =>
      assertValidDerivedModelInput({
        derivationKind: 'value_proposition',
        statement: 'x'.repeat(2001),
        detail: null,
        sourceFactIds: [],
        evidenceCitations: [],
        aiAssistance: null,
      }),
    InvalidRequestError,
  );
  // Duplicate references.
  assert.throws(
    () =>
      assertValidDerivedModelInput({
        derivationKind: 'value_proposition',
        statement: 'x',
        detail: null,
        sourceFactIds: ['f1', 'f1'],
        evidenceCitations: [],
        aiAssistance: null,
      }),
    InvalidRequestError,
  );
  // Half of the ai-disclosure pair.
  assert.throws(
    () =>
      assertValidDerivedModelInput({
        derivationKind: 'value_proposition',
        statement: 'x',
        detail: null,
        sourceFactIds: [],
        evidenceCitations: [],
        aiAssistance: { modelIdentity: 'model-1', callReference: '' },
      }),
    InvalidRequestError,
  );
});

test('AC-4 risk-flag guard: the risk-kind + severity vocabularies and the statement bounds', () => {
  assert.doesNotThrow(() =>
    assertValidRiskFlagInput({
      riskKind: 'compliance',
      severity: 'high',
      statement: 'The pricing page makes an unverified financial-return claim.',
      sourceFactIds: [],
      evidenceCitations: [],
      aiAssistance: null,
    }),
  );
  assert.throws(
    () =>
      assertValidRiskFlagInput({
        riskKind: 'legal' as never,
        severity: 'high',
        statement: 'x',
        sourceFactIds: [],
        evidenceCitations: [],
        aiAssistance: null,
      }),
    InvalidRequestError,
  );
  assert.throws(
    () =>
      assertValidRiskFlagInput({
        riskKind: 'compliance',
        severity: 'critical' as never,
        statement: 'x',
        sourceFactIds: [],
        evidenceCitations: [],
        aiAssistance: null,
      }),
    InvalidRequestError,
  );
});

test('provenance composition: the server-derived provenance guard + the owner-context composer purity', () => {
  const valid = {
    actor: 'user:11111111-1111-4111-8111-111111111111',
    recordedVia: 'api',
    correlationId: 'corr-1',
    causationId: null,
  };
  assert.doesNotThrow(() => assertValidProductIntelligenceProvenance(valid));
  assert.throws(
    () => assertValidProductIntelligenceProvenance({ ...valid, actor: '' }),
    InvalidRequestError,
  );
  assert.throws(
    () => assertValidProductIntelligenceProvenance({ ...valid, recordedVia: '' }),
    InvalidRequestError,
  );
  assert.throws(
    () => assertValidProductIntelligenceProvenance({ ...valid, correlationId: '' }),
    InvalidRequestError,
  );

  // The pure owner-context composer: the same inputs always compose the
  // same context (the composeGrowthMissionOwnerContext precedent).
  const context = {
    productContextId: 'c1',
    agencyId: 'a1',
    currentVersionSeq: 1,
    version: 1,
    createdActor: 'user:u1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const agency = { agencyId: 'a1', status: 'active' };
  const composed = composeProductContextOwnerContext(context, agency, '2026-01-02T00:00:00.000Z');
  assert.deepEqual(composed, composeProductContextOwnerContext(context, agency, '2026-01-02T00:00:00.000Z'));
  assert.equal(composed.scope.kind, 'product-context');
  assert.equal(composed.scope.agencyId, 'a1');
  assert.equal(composed.scope.productContextId, 'c1');
  assert.equal(composed.agency.status, 'active');
});

// ---------------------------------------------------------------------------
// AC-2: extractor purity + determinism
// ---------------------------------------------------------------------------

const FIXTURE_PAGE = `<!doctype html>
<html><head><title>PaySwap Pro — Crypto Payments</title>
<meta name="description" content="Accept crypto payments at checkout with no volatility.">
<link rel="canonical" href="https://payswap.org/">
</head><body>
<h1>Accept crypto payments</h1>
<h2>No volatility, no chargebacks</h2>
<p>PaySwap Pro lets online stores accept stablecoin payments with automatic fiat settlement.</p>
<a href="/pricing">Pricing</a>
<a href="https://docs.payswap.org/">Docs</a>
</body></html>`;

test('AC-2 extractor purity: the same site content always yields the same observation (deterministic)', () => {
  const first = extractSiteObservation(FIXTURE_PAGE);
  const second = extractSiteObservation(FIXTURE_PAGE);
  assert.deepEqual(first, second);
  assert.equal(first.title, 'PaySwap Pro — Crypto Payments');
  assert.equal(first.metaDescription, 'Accept crypto payments at checkout with no volatility.');
  assert.equal(first.canonicalUrl, 'https://payswap.org/');
  assert.deepEqual(first.headings, ['Accept crypto payments', 'No volatility, no chargebacks']);
  assert.equal(first.linkCount, 2);
  assert.ok(first.links.includes('/pricing'));
  assert.ok(first.links.includes('https://docs.payswap.org/'));
  assert.ok(first.textPreview.includes('stablecoin payments'));
  // The extractor labels are versioned identities.
  assert.equal(SITE_PAGE_EXTRACTOR_ID, 'site-page-extractor-v1');
  assert.equal(INTEGRATION_RECORD_EXTRACTOR_ID, 'integration-record-extractor-v1');
});

test('AC-2 extractor bounds: missing structures surface as null/empty, never invented', () => {
  const bare = extractSiteObservation('<p>just text</p>');
  assert.equal(bare.title, null);
  assert.equal(bare.metaDescription, null);
  assert.equal(bare.canonicalUrl, null);
  assert.deepEqual(bare.headings, []);
  assert.equal(bare.linkCount, 0);
  assert.ok(bare.textPreview.length > 0);
});

test('AC-2 content hashing: sha-256, deterministic, distinct for distinct content', () => {
  const hash = hashContent(FIXTURE_PAGE);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, hashContent(FIXTURE_PAGE));
  assert.notEqual(hash, hashContent(`${FIXTURE_PAGE}\n<!-- changed -->`));
});

test('AC-2 authorized-record observation: deterministic canonical-JSON hashing (key order independent)', () => {
  const record = {
    providerRecordId: 'repo-file-1',
    data: { path: 'src/index.ts', lines: 10, language: 'typescript' },
    sourceTimestamp: '2026-01-01T00:00:00.000Z',
    etag: 'v1',
    sourceVersion: 'abc123',
  };
  const first = integrationRecordObservation(record);
  const second = integrationRecordObservation({
    ...record,
    data: { language: 'typescript', lines: 10, path: 'src/index.ts' },
  });
  assert.equal(first.contentHash, second.contentHash, 'canonical JSON hashing is key-order independent');
  assert.deepEqual(first.observation, {
    providerRecordId: 'repo-file-1',
    data: { path: 'src/index.ts', lines: 10, language: 'typescript' },
    sourceTimestamp: '2026-01-01T00:00:00.000Z',
    etag: 'v1',
    sourceVersion: 'abc123',
  });
});
