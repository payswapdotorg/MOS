/**
 * MKT-069 unit tests — the Product Intelligence frozen vocabularies, the
 * deterministic extractor, the input guards, the provenance/owner-context
 * composition, the hypothesis (derived-statement) structure discipline and
 * the verification-state rule (pure functions only — no DB, no network).
 *
 * Acceptance mapping (spec/effective-backlog-v1.6.md MKT-069; the dispatch
 * acceptance criteria AC-1..AC-6, AC-10 unit half):
 *   - AC-1 VOCABULARY PINNING: the six declared-input kinds, the two
 *     authorization states, the eight §8 derivation kinds, the two
 *     verification states, the five risk categories, the four severities,
 *     the ten fact kinds and the run/outcome vocabularies are pinned
 *     exactly (a vocabulary change is a NEW version string);
 *   - AC-2 DETERMINISTIC EXTRACTION: the html-extract-v1 extractor is a
 *     PURE function (same input → same facts, same order — no clock, no
 *     randomness); the observations are carried VERBATIM and bounded;
 *   - AC-3 HYPOTHESIS STRUCTURE + VERIFICATION STATE: the derived
 *     statement REQUIRES a bounded summary; material-shaped keys are
 *     rejected at every nesting level (§21 through the SHARED /evidence
 *     guard); the verification state is the SERVER-COMPUTED pure rule
 *     (no evidence → unverified; ≥1 evidence → evidence_backed) and the
 *     claim-tier disclosure is pinned — a hypothesis NEVER becomes a fact;
 *   - AC-4 RISK STRUCTURE: the frozen category/severity vocabularies and
 *     the bounded statement/mitigation guards;
 *   - AC-1/AC-7 PROVENANCE COMPOSITION: the pure owner-context composer
 *     and the server-derived provenance guard.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProductContextInputDeclaration } from '../../src/modules/product-intelligence/public.ts';
import {
  PRODUCT_INTELLIGENCE_INPUT_KINDS,
  PRODUCT_INTELLIGENCE_AUTHORIZATION_STATES,
  PRODUCT_INTELLIGENCE_DERIVATION_KINDS,
  PRODUCT_INTELLIGENCE_VERIFICATION_STATES,
  PRODUCT_INTELLIGENCE_RISK_CATEGORIES,
  PRODUCT_INTELLIGENCE_RISK_SEVERITIES,
  PRODUCT_INTELLIGENCE_FACT_KINDS,
  PRODUCT_INTELLIGENCE_RUN_STATUSES,
  PRODUCT_INTELLIGENCE_INPUT_RUN_OUTCOMES,
  PRODUCT_INTELLIGENCE_VOCABULARY_VERSION,
  PRODUCT_INTELLIGENCE_DERIVED_RECORD_TIER,
  PRODUCT_INTELLIGENCE_WRITE_CAPABILITY_SEAM,
  PRODUCT_INTELLIGENCE_HTML_EXTRACTOR,
  PRODUCT_INTELLIGENCE_INTEGRATION_EXTRACTOR,
  PRODUCT_INTELLIGENCE_STATEMENT_SUMMARY_MAX,
  assertValidProductContextDeclaration,
  assertValidProductIntelligenceProvenance,
  assertValidProductDerivedModelInput,
  assertValidProductRiskFlagInput,
  composeProductContextOwnerContext,
  derivedVerificationState,
  extractHtmlSourceFacts,
  hashContent,
} from '../../src/modules/product-intelligence/public.ts';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';

// ---------------------------------------------------------------------------
// AC-1/AC-3/AC-4: vocabulary pinning (a change is a NEW version string)
// ---------------------------------------------------------------------------

test('MKT-069 AC-1: the six declared-input kinds are pinned exactly (the §8 input set, one-to-one)', () => {
  assert.deepEqual(PRODUCT_INTELLIGENCE_INPUT_KINDS, [
    'product_site_url',
    'product_document',
    'source_repository',
    'source_workspace',
    'catalog_inventory',
    'current_analytics',
  ]);
  assert.deepEqual(PRODUCT_INTELLIGENCE_AUTHORIZATION_STATES, ['public', 'authorized']);
});

test('MKT-069 AC-3: the eight §8 derivation kinds are pinned exactly (product risks are the separate risk-flag records)', () => {
  assert.deepEqual(PRODUCT_INTELLIGENCE_DERIVATION_KINDS, [
    'product_capabilities',
    'user_problem_hypotheses',
    'icp_audience_hypotheses',
    'value_propositions',
    'conversion_paths',
    'content_worthy_features',
    'market_language',
    'commercial_metrics',
  ]);
  assert.deepEqual(PRODUCT_INTELLIGENCE_VERIFICATION_STATES, ['unverified', 'evidence_backed']);
});

test('MKT-069 AC-4: the risk categories + severities are pinned exactly (the acceptance list)', () => {
  assert.deepEqual(PRODUCT_INTELLIGENCE_RISK_CATEGORIES, [
    'compliance',
    'privacy',
    'toxicity',
    'commercial',
    'operational',
  ]);
  assert.deepEqual(PRODUCT_INTELLIGENCE_RISK_SEVERITIES, ['low', 'medium', 'high', 'critical']);
});

test('MKT-069 AC-2: the deterministic fact-kind + run/outcome vocabularies are pinned exactly', () => {
  assert.deepEqual(PRODUCT_INTELLIGENCE_FACT_KINDS, [
    'page_title',
    'meta_description',
    'meta_keywords',
    'og_title',
    'og_description',
    'canonical_url',
    'page_language',
    'heading',
    'text_excerpt',
    'source_record',
  ]);
  assert.deepEqual(PRODUCT_INTELLIGENCE_RUN_STATUSES, ['completed', 'partial', 'failed']);
  assert.deepEqual(PRODUCT_INTELLIGENCE_INPUT_RUN_OUTCOMES, [
    'facts_extracted',
    'no_facts_extracted',
    'unauthorized_refused',
    'fetch_http_error',
    'fetch_transport_error',
    'read_error',
    'read_refused',
  ]);
});

test('MKT-069 AC-3/AC-5: the version + tier + seam disclosures are pinned (the gm-vocab-v1 discipline)', () => {
  assert.equal(PRODUCT_INTELLIGENCE_VOCABULARY_VERSION, 'pi-vocab-v1');
  // Hypotheses never become facts: every derived record is a CLAIM.
  assert.equal(PRODUCT_INTELLIGENCE_DERIVED_RECORD_TIER, 'claim');
  // The read-only write seam (boundary rule 7): documented, NOT built.
  assert.ok(
    PRODUCT_INTELLIGENCE_WRITE_CAPABILITY_SEAM.includes('not built'),
    'the write seam discloses that NO write capability is built',
  );
  // The frozen extractor identities.
  assert.equal(PRODUCT_INTELLIGENCE_HTML_EXTRACTOR, 'html-extract-v1');
  assert.equal(PRODUCT_INTELLIGENCE_INTEGRATION_EXTRACTOR, 'integration-read-v1');
});

// ---------------------------------------------------------------------------
// AC-2: the deterministic extractor (pure, verbatim, bounded)
// ---------------------------------------------------------------------------

const PAGE_FIXTURE = `<!doctype html>
<html lang="en-US">
<head>
  <title>PaySwap — Crypto Payments for Teams</title>
  <meta name="description" content="Accept crypto payments with no volatility. Settlement in 24 hours.">
  <meta name="keywords" content="crypto payments, stablecoin, settlement">
  <meta property="og:title" content="PaySwap Pro">
  <meta property="og:description" content="The payments stack for web3 teams.">
  <link rel="canonical" href="https://payswap.org/">
</head>
<body>
  <h1> Crypto Payments for Teams</h1>
  <p>PaySwap lets your business accept stablecoins and settle in fiat.</p>
  <h2>Features</h2>
  <h2>pricing</h2>
  <h3>FAQ</h3>
</body>
</html>`;

test('MKT-069 AC-2: the html-extract-v1 extractor is DETERMINISTIC (the same page yields the same facts, same order)', () => {
  const first = extractHtmlSourceFacts(PAGE_FIXTURE);
  const second = extractHtmlSourceFacts(PAGE_FIXTURE);
  assert.deepEqual(second, first);
  assert.ok(first.length >= 10, `expected the full extraction set, got ${first.length}`);
});

test('MKT-069 AC-2: the extractor retains VERBATIM observations, never conclusions', () => {
  const facts = extractHtmlSourceFacts(PAGE_FIXTURE);
  const byKind = new Map(facts.map((fact) => [fact.factKind, fact]));
  assert.equal(byKind.get('page_title')?.content['text'], 'PaySwap — Crypto Payments for Teams');
  assert.equal(
    byKind.get('meta_description')?.content['text'],
    'Accept crypto payments with no volatility. Settlement in 24 hours.',
  );
  assert.equal(byKind.get('og_title')?.content['text'], 'PaySwap Pro');
  assert.equal(
    byKind.get('og_description')?.content['text'],
    'The payments stack for web3 teams.',
  );
  assert.equal(byKind.get('canonical_url')?.content['url'], 'https://payswap.org/');
  assert.equal(byKind.get('page_language')?.content['lang'], 'en-us');
  // The heading observations (document order, level preserved).
  const headings = facts.filter((fact) => fact.factKind === 'heading');
  assert.deepEqual(
    headings.map((heading) => [heading.content['level'], heading.content['text']]),
    [
      [1, 'Crypto Payments for Teams'],
      [2, 'Features'],
      [2, 'pricing'],
      [3, 'FAQ'],
    ],
  );
  // The bounded plain-text excerpt exists.
  const excerpt = byKind.get('text_excerpt');
  assert.ok(typeof excerpt?.content['excerpt'] === 'string');
  assert.ok((excerpt?.content['excerpt'] as string).includes('accept stablecoins'));
  // Every fact carries its honest extraction notes.
  for (const fact of facts) {
    assert.ok(fact.extractionNotes.length > 0);
  }
});

test('MKT-069 AC-2: the extractor is BOUNDED (whitespace collapsed, text lengths capped, headings capped)', () => {
  const longTitle = 'x'.repeat(2000);
  const noisy = `<html><head><title>${longTitle}</title></head><body>${'<h1>h</h1>'.repeat(30)}   spaced   out   text  </body></html>`;
  const facts = extractHtmlSourceFacts(noisy);
  const title = facts.find((fact) => fact.factKind === 'page_title');
  assert.equal((title?.content['text'] as string).length, 500, 'titles are capped at 500');
  const headings = facts.filter((fact) => fact.factKind === 'heading');
  assert.equal(headings.length, 10, 'at most 10 heading observations are retained');
  const excerpt = facts.find((fact) => fact.factKind === 'text_excerpt');
  assert.ok(!/\s{2,}/.test(excerpt?.content['excerpt'] as string), 'whitespace is collapsed');
  // A page with nothing extractable yields nothing (the honest empty set).
  assert.deepEqual(extractHtmlSourceFacts('<html><body></body></html>'), []);
  assert.deepEqual(extractHtmlSourceFacts(''), []);
});

test('MKT-069 AC-2: hashContent is the sha256 hex of the material (64 chars, known digest)', () => {
  assert.equal(hashContent('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(hashContent(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  for (const material of ['a', 'page body', JSON.stringify({ a: 1 })]) {
    assert.equal(hashContent(material).length, 64);
    assert.match(hashContent(material), /^[0-9a-f]{64}$/);
  }
});

// ---------------------------------------------------------------------------
// AC-1/AC-7: the declaration guard (the kind-compatible authorization fence)
// ---------------------------------------------------------------------------

const VALID_PROVENANCE = {
  actor: 'user:00000000-0000-7000-8000-000000000001',
  recordedVia: 'module',
  correlationId: 'unit-1',
  causationId: null,
} as const;

function publicInput(
  overrides: Partial<ProductContextInputDeclaration> = {},
): ProductContextInputDeclaration {
  return {
    kind: 'product_site_url',
    reference: 'https://acme.test/',
    authorization: 'public',
    integrationConnectionId: null,
    ...overrides,
  };
}

function authorizedInput(
  overrides: Partial<ProductContextInputDeclaration> = {},
): ProductContextInputDeclaration {
  return {
    kind: 'source_repository',
    reference: 'https://github.com/acme/widgets',
    authorization: 'authorized',
    integrationConnectionId: '00000000-0000-7000-8000-0000000000c1',
    ...overrides,
  };
}

test('MKT-069 AC-1: a valid declaration (public + authorized inputs) passes the guard', () => {
  assertValidProductContextDeclaration({
    name: 'PaySwap Pro',
    summary: 'The crypto payments product',
    inputs: [publicInput(), authorizedInput()],
  });
  // Optional name/summary may be null.
  assertValidProductContextDeclaration({
    name: null,
    summary: null,
    inputs: [publicInput()],
  });
});

test('MKT-069 AC-1/AC-7: the kind-compatible authorization fence rejects every mismatch honestly', () => {
  // A repository input claiming 'public' — the non-authorized repo input
  // is rejected honestly (boundary rule 7: source inspection requires an
  // explicit grant).
  assertProblems(
    () =>
      assertValidProductContextDeclaration({
        name: null,
        summary: null,
        inputs: [authorizedInput({ authorization: 'public', integrationConnectionId: null })],
      }),
    ['REQUIRES authorization'],
  );
  // An authorized input without a connection reference.
  assertProblems(
    () =>
      assertValidProductContextDeclaration({
        name: null,
        summary: null,
        inputs: [authorizedInput({ integrationConnectionId: null })],
      }),
    ['REQUIRES a canonical integration connection reference'],
  );
  // A public web kind claiming authorization.
  assertProblems(
    () =>
      assertValidProductContextDeclaration({
        name: null,
        summary: null,
        inputs: [publicInput({ authorization: 'authorized' })],
      }),
    ["must carry authorization 'public'"],
  );
  // A public web kind smuggling a connection reference.
  assertProblems(
    () =>
      assertValidProductContextDeclaration({
        name: null,
        summary: null,
        inputs: [publicInput({ integrationConnectionId: '00000000-0000-7000-8000-0000000000c1' })],
      }),
    ['must not carry an integration connection reference'],
  );
  // Unknown kind.
  assertProblems(
    () =>
      assertValidProductContextDeclaration({
        name: null,
        summary: null,
        inputs: [publicInput({ kind: 'social_profile' as 'product_site_url' })],
      }),
    ["unknown input kind 'social_profile'"],
  );
});

test('MKT-069 AC-1: the declaration guard enforces the bounds + the duplicate fence', () => {
  assertProblems(
    () => assertValidProductContextDeclaration({ name: null, summary: null, inputs: [] }),
    ['at least one declared input is required'],
  );
  const tooMany = Array.from({ length: 41 }, (_, index) =>
    publicInput({ reference: `https://acme.test/${index}` }),
  );
  assertProblems(
    () => assertValidProductContextDeclaration({ name: null, summary: null, inputs: tooMany }),
    ['at most 40 per version'],
  );
  assertProblems(
    () =>
      assertValidProductContextDeclaration({
        name: null,
        summary: null,
        inputs: [publicInput(), publicInput()],
      }),
    ["duplicate declared input (kind, reference) 'product_site_url'"],
  );
  assertProblems(
    () =>
      assertValidProductContextDeclaration({
        name: 'x'.repeat(501),
        summary: null,
        inputs: [publicInput()],
      }),
    ['name: null or 1..500 characters'],
  );
  assertProblems(
    () =>
      assertValidProductContextDeclaration({
        name: null,
        summary: null,
        inputs: [publicInput({ reference: '' })],
      }),
    ['inputs[0].reference: 1..2048 characters'],
  );
});

// ---------------------------------------------------------------------------
// AC-3/AC-4: the derived-statement (hypothesis) + risk guards
// ---------------------------------------------------------------------------

test('MKT-069 AC-3: the derived-statement structure — REQUIRED bounded summary, §21 material-key rejection at every nesting level', () => {
  // Valid: with + without evidence + with + without AI assistance.
  assertValidProductDerivedModelInput({
    derivationKind: 'user_problem_hypotheses',
    statement: { summary: 'Teams struggle to accept stablecoin payments without volatility exposure.' },
    evidenceSourceFactIds: [],
    aiAssistance: null,
  });
  assertValidProductDerivedModelInput({
    derivationKind: 'product_capabilities',
    statement: { summary: 'Hosted checkout + API + webhooks.', details: ['checkout', 'api'] },
    evidenceSourceFactIds: [
      '00000000-0000-7000-8000-0000000000f1',
      '00000000-0000-7000-8000-0000000000f2',
    ],
    aiAssistance: {
      modelRegistryId: '00000000-0000-7000-8000-0000000000m1',
      callReference: 'call-42',
    },
  });
  // Missing summary.
  assertProblems(
    () =>
      assertValidProductDerivedModelInput({
        derivationKind: 'value_propositions',
        statement: { claim: 'no summary' },
        evidenceSourceFactIds: [],
        aiAssistance: null,
      }),
    ['statement.summary: required'],
  );
  // Oversized summary.
  assertProblems(
    () =>
      assertValidProductDerivedModelInput({
        derivationKind: 'value_propositions',
        statement: { summary: 'x'.repeat(PRODUCT_INTELLIGENCE_STATEMENT_SUMMARY_MAX + 1) },
        evidenceSourceFactIds: [],
        aiAssistance: null,
      }),
    [`1..${PRODUCT_INTELLIGENCE_STATEMENT_SUMMARY_MAX} characters`],
  );
  // §21: material-shaped keys are rejected at EVERY nesting level (the
  // SHARED /evidence guard).
  assertProblems(
    () =>
      assertValidProductDerivedModelInput({
        derivationKind: 'market_language',
        statement: { summary: 'ok', nested: { token: 'leak' } },
        evidenceSourceFactIds: [],
        aiAssistance: null,
      }),
    ['material-shaped keys are rejected at every nesting level'],
  );
  // Unknown derivation kind.
  assertProblems(
    () =>
      assertValidProductDerivedModelInput({
        derivationKind: 'competitor_matrix',
        statement: { summary: 'x' },
        evidenceSourceFactIds: [],
        aiAssistance: null,
      }),
    ['frozen §8 derivation kinds'],
  );
  // Duplicate evidence references.
  assertProblems(
    () =>
      assertValidProductDerivedModelInput({
        derivationKind: 'conversion_paths',
        statement: { summary: 'x' },
        evidenceSourceFactIds: [
          '00000000-0000-7000-8000-0000000000f1',
          '00000000-0000-7000-8000-0000000000f1',
        ],
        aiAssistance: null,
      }),
    ['duplicate reference'],
  );
  // The AI-assistance disclosure shape (call reference required).
  assertProblems(
    () =>
      assertValidProductDerivedModelInput({
        derivationKind: 'icp_audience_hypotheses',
        statement: { summary: 'x' },
        evidenceSourceFactIds: [],
        aiAssistance: { modelRegistryId: 'm', callReference: '' },
      }),
    ['aiAssistance.callReference'],
  );
});

test('MKT-069 AC-4: the risk-flag guard — frozen category/severity vocabularies + bounds', () => {
  assertValidProductRiskFlagInput({
    category: 'compliance',
    severity: 'high',
    statement: { summary: 'The checkout flow may collect card data without a compliant processor.' },
    mitigation: 'Route card collection through the licensed PSP.',
    evidenceSourceFactIds: [],
  });
  assertProblems(
    () =>
      assertValidProductRiskFlagInput({
        category: 'legal',
        severity: 'high',
        statement: { summary: 'x' },
        mitigation: null,
        evidenceSourceFactIds: [],
      }),
    ['frozen risk categories'],
  );
  assertProblems(
    () =>
      assertValidProductRiskFlagInput({
        category: 'privacy',
        severity: 'extreme',
        statement: { summary: 'x' },
        mitigation: null,
        evidenceSourceFactIds: [],
      }),
    ['frozen risk severities'],
  );
  assertProblems(
    () =>
      assertValidProductRiskFlagInput({
        category: 'privacy',
        severity: 'low',
        statement: { summary: 'x' },
        mitigation: 'y'.repeat(2001),
        evidenceSourceFactIds: [],
      }),
    ['mitigation: null or 1..2000 characters'],
  );
});

// ---------------------------------------------------------------------------
// AC-3: the verification-state rule (the server-computed pure discipline)
// ---------------------------------------------------------------------------

test('MKT-069 AC-3: the verification state is the SERVER-COMPUTED pure rule — no evidence means unverified, never caller-declared', () => {
  assert.equal(derivedVerificationState(0), 'unverified');
  assert.equal(derivedVerificationState(1), 'evidence_backed');
  assert.equal(derivedVerificationState(7), 'evidence_backed');
  // The state vocabulary offers NO third value: there is no 'established'
  // or 'fact' state — hypotheses never become facts by repetition.
  assert.equal(PRODUCT_INTELLIGENCE_VERIFICATION_STATES.length, 2);
  assert.ok(!PRODUCT_INTELLIGENCE_VERIFICATION_STATES.includes('established' as never));
});

// ---------------------------------------------------------------------------
// AC-1/AC-7: the provenance guard + the pure owner-context composition
// ---------------------------------------------------------------------------

test('MKT-069 AC-1: the server-derived provenance guard (bounded labeled principal, never caller-invented payload)', () => {
  assertValidProductIntelligenceProvenance(VALID_PROVENANCE);
  assertProblems(
    () =>
      assertValidProductIntelligenceProvenance({
        actor: '',
        recordedVia: 'module',
        correlationId: 'c',
        causationId: null,
      }),
    ['provenance.actor'],
  );
  assertProblems(
    () =>
      assertValidProductIntelligenceProvenance({
        actor: 'user:x',
        recordedVia: '',
        correlationId: 'c',
        causationId: null,
      }),
    ['provenance.recordedVia'],
  );
  assertProblems(
    () =>
      assertValidProductIntelligenceProvenance({
        actor: 'user:x',
        recordedVia: 'module',
        correlationId: '',
        causationId: null,
      }),
    ['provenance.correlationId'],
  );
  assertProblems(
    () =>
      assertValidProductIntelligenceProvenance({
        actor: 'user:x',
        recordedVia: 'module',
        correlationId: 'c',
        causationId: '',
      }),
    ['provenance.causationId'],
  );
});

test('MKT-069 AC-7: the pure owner-context composition (the same inputs always compose the same context)', () => {
  const context = {
    productContextId: '00000000-0000-7000-8000-0000000000p1',
    agencyId: '00000000-0000-7000-8000-0000000000a1',
    currentVersionSeq: 2,
    version: 5,
    createdActor: 'user:00000000-0000-7000-8000-0000000000u1',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T01:00:00.000Z',
  };
  const first = composeProductContextOwnerContext(context, '2026-09-20T02:00:00.000Z');
  const second = composeProductContextOwnerContext(context, '2026-09-20T02:00:00.000Z');
  assert.deepEqual(second, first);
  assert.deepEqual(first.scope, {
    kind: 'product-context',
    agencyId: context.agencyId,
    productContextId: context.productContextId,
  });
  assert.equal(first.context, context, 'the record is carried by reference, never shadowed');
  assert.equal(first.resolvedAt, '2026-09-20T02:00:00.000Z');
  // Purity: the source record is never mutated.
  assert.equal(context.currentVersionSeq, 2);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertProblems(call: () => void, expectedSubstrings: readonly string[]): void {
  let caught: unknown = null;
  try {
    call();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof InvalidRequestError, `expected InvalidRequestError, got ${caught}`);
  const details = (caught as InvalidRequestError).details ?? [];
  for (const substring of expectedSubstrings) {
    assert.ok(
      details.some((detail) => detail.includes(substring)),
      `expected a problem containing '${substring}', got ${JSON.stringify(details)}`,
    );
  }
}
