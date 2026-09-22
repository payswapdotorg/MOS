/**
 * MKT-062 unit tests — the /research frozen vocabularies, the deterministic
 * extractor, the input guards, the provenance/owner-context composition,
 * the insight (derived-statement) structure discipline and the
 * verification-state rule (pure functions only — no DB, no network).
 *
 * Acceptance mapping (spec/effective-backlog-v1.6.md MKT-062;
 * spec/architecture-v1.6.md §7):
 *   - VOCABULARY PINNING: the eight declared-source kinds, the two
 *     authorization states, the ten fact kinds, the run/outcome
 *     vocabularies, the six derivation kinds and the two verification
 *     states are pinned exactly (a vocabulary change is a NEW version
 *     string);
 *   - DETERMINISTIC EXTRACTION: the research-html-extract-v1 extractor is
 *     a PURE function (same input → same facts, same order — no clock, no
 *     randomness); the observations are carried VERBATIM and bounded;
 *   - HYPOTHESIS STRUCTURE + VERIFICATION STATE (§7: "Model output is a
 *     claim unless backed by evidence"): the insight statement REQUIRES a
 *     bounded summary; material-shaped keys are rejected at every nesting
 *     level (§21 through the SHARED /evidence guard); the verification
 *     state is the SERVER-COMPUTED pure rule (no evidence → unverified;
 *     ≥1 evidence → evidence_backed) and the claim-tier disclosure is
 *     pinned — a synthesis NEVER becomes a fact;
 *   - THE KIND-COMPATIBLE AUTHORIZATION FENCE (§7: connected
 *     repositories/workspaces ONLY when explicitly authorized);
 *   - PROVENANCE COMPOSITION: the pure owner-context composer and the
 *     server-derived provenance guard.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ResearchSourceDeclaration } from '../../src/modules/research/public.ts';
import {
  RESEARCH_SOURCE_KINDS,
  RESEARCH_AUTHORIZATION_STATES,
  RESEARCH_AUTHORIZED_READ_OPERATIONS,
  RESEARCH_FACT_KINDS,
  RESEARCH_RUN_STATUSES,
  RESEARCH_SOURCE_OUTCOMES,
  RESEARCH_DERIVATION_KINDS,
  RESEARCH_VERIFICATION_STATES,
  RESEARCH_VOCABULARY_VERSION,
  RESEARCH_DERIVED_RECORD_TIER,
  RESEARCH_HTML_EXTRACTOR,
  RESEARCH_INTEGRATION_EXTRACTOR,
  RESEARCH_STATEMENT_SUMMARY_MAX,
  assertValidResearchSessionDeclaration,
  assertValidResearchProvenance,
  assertValidResearchInsightInput,
  composeResearchSessionOwnerContext,
  researchDerivedVerificationState,
  extractResearchHtmlSourceFacts,
  hashResearchContent,
} from '../../src/modules/research/public.ts';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';

// ---------------------------------------------------------------------------
// Vocabulary pinning (a change is a NEW version string)
// ---------------------------------------------------------------------------

test('MKT-062: the eight declared-source kinds are pinned exactly (the §7 source list, one-to-one)', () => {
  assert.deepEqual(RESEARCH_SOURCE_KINDS, [
    'web_page',
    'documentation',
    'research_paper',
    'news',
    'market_source',
    'public_social_content',
    'connected_repository',
    'connected_workspace',
  ]);
  assert.deepEqual(RESEARCH_AUTHORIZATION_STATES, ['public', 'authorized']);
});

test('MKT-062: the frozen per-kind authorized-read operation labels are pinned (the /integrations normalized labels)', () => {
  assert.deepEqual(RESEARCH_AUTHORIZED_READ_OPERATIONS, {
    connected_repository: 'repository.read',
    connected_workspace: 'workspace.read',
  });
});

test('MKT-062: the ten fact kinds, the run/outcome vocabularies and the six derivation kinds are pinned exactly', () => {
  assert.deepEqual(RESEARCH_FACT_KINDS, [
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
  assert.deepEqual(RESEARCH_RUN_STATUSES, ['completed', 'partial', 'failed']);
  assert.deepEqual(RESEARCH_SOURCE_OUTCOMES, [
    'facts_extracted',
    'no_facts_extracted',
    'unauthorized_refused',
    'fetch_http_error',
    'fetch_transport_error',
    'read_error',
    'read_refused',
  ]);
  assert.deepEqual(RESEARCH_DERIVATION_KINDS, [
    'topic_synthesis',
    'trend_observation',
    'market_note',
    'audience_signal',
    'competitor_signal',
    'source_critique',
  ]);
  assert.deepEqual(RESEARCH_VERIFICATION_STATES, ['unverified', 'evidence_backed']);
  assert.equal(RESEARCH_VOCABULARY_VERSION, 'rs-vocab-v1');
  assert.equal(RESEARCH_DERIVED_RECORD_TIER, 'claim');
  assert.equal(RESEARCH_HTML_EXTRACTOR, 'research-html-extract-v1');
  assert.equal(RESEARCH_INTEGRATION_EXTRACTOR, 'research-integration-read-v1');
});

// ---------------------------------------------------------------------------
// The kind-compatible authorization fence (§7)
// ---------------------------------------------------------------------------

function webSource(reference: string): ResearchSourceDeclaration {
  return { kind: 'web_page', reference, authorization: 'public', integrationConnectionId: null };
}

test('MKT-062 §7: the kind-compatible authorization fence accepts the honest shapes and rejects every mismatch', () => {
  // The honest public shape passes.
  assert.doesNotThrow(() =>
    assertValidResearchSessionDeclaration({
      topic: 'Short-form widget content trends',
      focus: 'What formats are growing in the widgets niche?',
      sources: [
        webSource('https://example.test/trends'),
        { kind: 'news', reference: 'https://news.test/widgets', authorization: 'public', integrationConnectionId: null },
        {
          kind: 'connected_repository',
          reference: 'https://github.com/acme/widgets-content',
          authorization: 'authorized',
          integrationConnectionId: '11111111-1111-1111-1111-111111111111',
        },
      ],
    }),
  );

  // A public web kind with a connection reference is REJECTED.
  assert.throws(
    () =>
      assertValidResearchSessionDeclaration({
        topic: null,
        focus: null,
        sources: [
          { kind: 'web_page', reference: 'https://example.test/', authorization: 'public', integrationConnectionId: '11111111-1111-1111-1111-111111111111' },
        ],
      }),
    InvalidRequestError,
  );
  // An authorized kind WITHOUT the explicitly-authorized state is REJECTED.
  assert.throws(
    () =>
      assertValidResearchSessionDeclaration({
        topic: null,
        focus: null,
        sources: [
          { kind: 'connected_workspace', reference: 'workspace:acme', authorization: 'public', integrationConnectionId: null },
        ],
      }),
    InvalidRequestError,
  );
  // An authorized kind WITHOUT a connection reference is REJECTED.
  assert.throws(
    () =>
      assertValidResearchSessionDeclaration({
        topic: null,
        focus: null,
        sources: [
          { kind: 'connected_repository', reference: 'https://github.com/acme/x', authorization: 'authorized', integrationConnectionId: null },
        ],
      }),
    InvalidRequestError,
  );
  // Unknown kinds, empty sources, duplicates and bound violations are rejected.
  assert.throws(
    () =>
      assertValidResearchSessionDeclaration({
        topic: null,
        focus: null,
        sources: [{ kind: 'dark_web_forum', reference: 'x', authorization: 'public', integrationConnectionId: null } as unknown as ResearchSourceDeclaration],
      }),
    InvalidRequestError,
  );
  assert.throws(
    () => assertValidResearchSessionDeclaration({ topic: null, focus: null, sources: [] }),
    InvalidRequestError,
  );
  assert.throws(
    () =>
      assertValidResearchSessionDeclaration({
        topic: null,
        focus: null,
        sources: [webSource('https://a.test/'), webSource('https://a.test/')],
      }),
    InvalidRequestError,
  );
  assert.throws(
    () =>
      assertValidResearchSessionDeclaration({
        topic: 'x'.repeat(501),
        focus: null,
        sources: [webSource('https://a.test/')],
      }),
    InvalidRequestError,
  );
});

// ---------------------------------------------------------------------------
// The deterministic extractor (§7: extracted observations, never conclusions)
// ---------------------------------------------------------------------------

const PAGE = `<!doctype html>
<html lang="en-US">
<head>
  <title>Widgets Weekly — the trend report</title>
  <meta name="description" content="Widget content trends for 2026.">
  <meta name="keywords" content="widgets, trends">
  <meta property="og:title" content="Widgets Weekly">
  <meta property="og:description" content="The trend report.">
  <link rel="canonical" href="https://widgets-weekly.test/report">
</head>
<body>
  <h1>The 2026 widget trend report</h1>
  <p>Short-form widget content is growing fastest.</p>
  <h2>Formats</h2>
  <h3>Timing</h3>
</body>
</html>`;

test('MKT-062: the research-html-extract-v1 extractor is DETERMINISTIC (same input → same facts, same order)', () => {
  const first = extractResearchHtmlSourceFacts(PAGE);
  const second = extractResearchHtmlSourceFacts(PAGE);
  assert.deepEqual(first, second);
  assert.ok(first.length >= 8, 'the extractor retains the head identity + heading + excerpt observations');
  assert.deepEqual(
    first.map((fact) => fact.factKind),
    [
      'page_title',
      'meta_description',
      'meta_keywords',
      'og_title',
      'og_description',
      'canonical_url',
      'page_language',
      'heading',
      'heading',
      'heading',
      'text_excerpt',
    ],
  );
});

test('MKT-062: the observations are carried VERBATIM and BOUNDED (never interpreted, never concluded)', () => {
  const facts = extractResearchHtmlSourceFacts(PAGE);
  const title = facts.find((fact) => fact.factKind === 'page_title')!;
  assert.equal(title.content['text'], 'Widgets Weekly — the trend report');
  const lang = facts.find((fact) => fact.factKind === 'page_language')!;
  assert.equal(lang.content['lang'], 'en-us');
  const headings = facts.filter((fact) => fact.factKind === 'heading');
  assert.deepEqual(
    headings.map((heading) => heading.content['level']),
    [1, 2, 3],
  );
  // A page with no extractable material yields NO facts (the honest empty
  // extraction — never an invented observation).
  assert.deepEqual(extractResearchHtmlSourceFacts('<html><head></head><body></body></html>'), []);
  // The extraction notes disclose the verbatim provenance of every fact.
  for (const fact of facts) {
    assert.ok(fact.extractionNotes.length > 0, 'every retained fact carries extraction notes');
  }
});

test('MKT-062: hashResearchContent is the sha256 of the material (64 hex chars, deterministic)', () => {
  const hash = hashResearchContent('the fetched page body');
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, hashResearchContent('the fetched page body'));
  assert.notEqual(hash, hashResearchContent('a different body'));
});

// ---------------------------------------------------------------------------
// The insight structure discipline + the verification state (§7)
// ---------------------------------------------------------------------------

test('MKT-062 §7: the insight statement REQUIRES a bounded summary; material-shaped keys are rejected at every nesting level', () => {
  assert.doesNotThrow(() =>
    assertValidResearchInsightInput({
      derivationKind: 'trend_observation',
      statement: { summary: 'Short-form widget content grew across the observed sources.' },
      evidenceSourceFactIds: [],
      aiAssistance: null,
    }),
  );
  // A missing summary is rejected.
  assert.throws(
    () =>
      assertValidResearchInsightInput({
        derivationKind: 'trend_observation',
        statement: { note: 'no summary' },
        evidenceSourceFactIds: [],
        aiAssistance: null,
      }),
    InvalidRequestError,
  );
  // An unbounded summary is rejected.
  assert.throws(
    () =>
      assertValidResearchInsightInput({
        derivationKind: 'trend_observation',
        statement: { summary: 'x'.repeat(RESEARCH_STATEMENT_SUMMARY_MAX + 1) },
        evidenceSourceFactIds: [],
        aiAssistance: null,
      }),
    InvalidRequestError,
  );
  // §21: material-shaped keys are rejected at EVERY nesting level.
  assert.throws(
    () =>
      assertValidResearchInsightInput({
        derivationKind: 'trend_observation',
        statement: { summary: 'ok', nested: { secret: 'leak' } },
        evidenceSourceFactIds: [],
        aiAssistance: null,
      }),
    InvalidRequestError,
  );
  // An unknown derivation kind is rejected.
  assert.throws(
    () =>
      assertValidResearchInsightInput({
        derivationKind: 'fortune_telling',
        statement: { summary: 'ok' },
        evidenceSourceFactIds: [],
        aiAssistance: null,
      }),
    InvalidRequestError,
  );
  // Duplicate evidence references are rejected.
  const factId = '22222222-2222-2222-2222-222222222222';
  assert.throws(
    () =>
      assertValidResearchInsightInput({
        derivationKind: 'market_note',
        statement: { summary: 'ok' },
        evidenceSourceFactIds: [factId, factId],
        aiAssistance: null,
      }),
    InvalidRequestError,
  );
  // The AI-assistance disclosure is all-or-none.
  assert.throws(
    () =>
      assertValidResearchInsightInput({
        derivationKind: 'market_note',
        statement: { summary: 'ok' },
        evidenceSourceFactIds: [],
        aiAssistance: { modelRegistryId: '', callReference: 'call-1' },
      }),
    InvalidRequestError,
  );
});

test('MKT-062 §7: the verification state is the SERVER-COMPUTED pure rule — model output is a claim unless backed by evidence', () => {
  assert.equal(researchDerivedVerificationState(0), 'unverified');
  assert.equal(researchDerivedVerificationState(1), 'evidence_backed');
  assert.equal(researchDerivedVerificationState(7), 'evidence_backed');
});

// ---------------------------------------------------------------------------
// Provenance + owner context composition
// ---------------------------------------------------------------------------

test('MKT-062: the server-derived provenance guard rejects caller-invented blocks', () => {
  assert.doesNotThrow(() =>
    assertValidResearchProvenance({
      actor: 'user:11111111-1111-1111-1111-111111111111',
      recordedVia: 'api',
      correlationId: 'corr-1',
      causationId: null,
    }),
  );
  for (const bad of [
    { actor: '', recordedVia: 'api', correlationId: 'c', causationId: null },
    { actor: 'a', recordedVia: '', correlationId: 'c', causationId: null },
    { actor: 'a', recordedVia: 'api', correlationId: '', causationId: null },
    { actor: 'a', recordedVia: 'api', correlationId: 'c', causationId: '' },
  ]) {
    assert.throws(() => assertValidResearchProvenance(bad), InvalidRequestError);
  }
});

test('MKT-062: composeResearchSessionOwnerContext is pure and carries the canonical scope', () => {
  const session = {
    researchSessionId: '33333333-3333-3333-3333-333333333333',
    agencyId: '44444444-4444-4444-4444-444444444444',
    currentVersionSeq: 2,
    version: 3,
    createdActor: 'user:x',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };
  const first = composeResearchSessionOwnerContext(session, '2026-01-03T00:00:00.000Z');
  const second = composeResearchSessionOwnerContext(session, '2026-01-03T00:00:00.000Z');
  assert.deepEqual(first, second);
  assert.equal(first.scope.kind, 'research-session');
  assert.equal(first.scope.agencyId, session.agencyId);
  assert.equal(first.scope.researchSessionId, session.researchSessionId);
  assert.equal(first.session.currentVersionSeq, 2);
});
