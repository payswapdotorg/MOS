/**
 * MKT-013 unit tests — the frozen evidence class/quality/tier taxonomy, the
 * canonical owner-context composer and the append guards (pure functions,
 * no DB).
 *
 * Proofs (spec/evidence-and-experimentation.md; EVID-AC-01/03):
 *   - EVIDENCE_CLASSES is exactly the 8 frozen classes, split into the two
 *     AUTHORITATIVE classes (source_fact/observation) and the six CLAIM
 *     classes — the EVID-AC-03 promotion boundary: every claim class is
 *     detectably NOT authoritative, so no claim can masquerade as an
 *     authoritative observation class;
 *   - the quality taxonomy is exactly A..F, every grade carries an
 *     interpretable meaning (traceability) and isKnownEvidenceQuality
 *     rejects everything outside the closed set (extension is a code+DB
 *     change, never a caller freedom);
 *   - the append guard enforces the frozen shapes at the authority
 *     boundary: closed class and quality sets, non-empty JSON-object
 *     content, §21 material-key rejection at EVERY nesting level, the
 *     declared-method requirement for attribution/causal_estimate, bounded
 *     source/content references, 0..1 confidence and a real observedAt
 *     timestamp;
 *   - the provenance guard fails closed on incomplete server-derived
 *     provenance (provenance is never defaulted from caller input);
 *   - composeEvidenceOwnerContext derives the canonical scope from the
 *     CLIENT OWNERSHIP and the evidence record only (never from caller
 *     input) and is pure: identical inputs compose identical outputs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTHORITATIVE_EVIDENCE_CLASSES,
  CLAIM_EVIDENCE_CLASSES,
  EVIDENCE_CLASSES,
  EVIDENCE_QUALITY_GRADES,
  EVIDENCE_QUALITY_MEANINGS,
  assertValidEvidenceAppend,
  assertValidEvidenceProvenance,
  composeEvidenceOwnerContext,
  containsMaterialKey,
  evidenceClassTier,
  isAuthoritativeEvidenceClass,
  isKnownEvidenceClass,
  isKnownEvidenceQuality,
  type EvidenceAppendInput,
  type EvidenceRecord,
} from '../../src/modules/evidence/public.ts';
import type { ClientOwnerContext } from '../../src/modules/clients/public.ts';
import type { WorkspaceRecord } from '../../src/modules/workspaces/public.ts';

test('EVIDENCE_CLASSES is exactly the 8 frozen evidence classes', () => {
  assert.deepEqual([...EVIDENCE_CLASSES].sort(), [
    'attribution',
    'causal_estimate',
    'hypothesis',
    'inference',
    'learning',
    'observation',
    'prediction',
    'source_fact',
  ]);
  for (const cls of EVIDENCE_CLASSES) {
    assert.equal(isKnownEvidenceClass(cls), true, `${cls} must be a known class`);
  }
  for (const foreign of ['fact', 'source', 'observation_report', 'Experiment', '']) {
    assert.equal(isKnownEvidenceClass(foreign), false, `'${foreign}' must be unknown`);
  }
});

test('the authority tiers are the EVID-AC-03 promotion boundary: 2 authoritative, 6 claims', () => {
  assert.deepEqual([...AUTHORITATIVE_EVIDENCE_CLASSES].sort(), ['observation', 'source_fact']);
  assert.deepEqual([...CLAIM_EVIDENCE_CLASSES].sort(), [
    'attribution',
    'causal_estimate',
    'hypothesis',
    'inference',
    'learning',
    'prediction',
  ]);
  for (const cls of EVIDENCE_CLASSES) {
    assert.equal(
      evidenceClassTier(cls),
      isAuthoritativeEvidenceClass(cls) ? 'authoritative' : 'claim',
      `tier(${cls}) must agree with the tier membership`,
    );
  }
  // Every claim class is detectably NOT authoritative: a claim can never
  // masquerade as an authoritative observation class (EVID-AC-03).
  for (const claim of CLAIM_EVIDENCE_CLASSES) {
    assert.equal(evidenceClassTier(claim), 'claim');
    assert.equal(isAuthoritativeEvidenceClass(claim), false);
  }
  for (const authoritative of AUTHORITATIVE_EVIDENCE_CLASSES) {
    assert.equal(evidenceClassTier(authoritative), 'authoritative');
    assert.equal(isAuthoritativeEvidenceClass(authoritative), true);
  }
});

test('the quality taxonomy is exactly A..F with an interpretable meaning per grade', () => {
  assert.deepEqual([...EVIDENCE_QUALITY_GRADES], ['A', 'B', 'C', 'D', 'E', 'F']);
  for (const grade of EVIDENCE_QUALITY_GRADES) {
    const meaning = EVIDENCE_QUALITY_MEANINGS[grade];
    assert.equal(typeof meaning, 'string', `grade ${grade} must carry a meaning`);
    assert.ok(meaning.length > 0, `grade ${grade} meaning must be non-empty (interpretable)`);
    assert.equal(isKnownEvidenceQuality(grade), true);
  }
  // The set is closed: extension is a code + DB migration change, never a
  // caller freedom.
  for (const foreign of ['G', 'a', '', 'AA', 'A1', 'A+', 'B-']) {
    assert.equal(isKnownEvidenceQuality(foreign), false, `'${foreign}' must be rejected`);
  }
});

const validAppend: EvidenceAppendInput = {
  clientId: 'client-1',
  workspaceId: null,
  class: 'source_fact',
  source: { system: 'meta-ads', ref: 'report/2026-01-15' },
  observedAt: '2026-01-15T10:30:00.000Z',
  content: { metric: 'spend', value: 123.45, currency: 'USD' },
  contentRef: null,
  quality: 'C',
  confidence: null,
  supersedesEvidenceId: null,
};

test('the append guard accepts a well-formed record for every authoritative and claim class', () => {
  for (const cls of EVIDENCE_CLASSES) {
    const input: EvidenceAppendInput = {
      ...validAppend,
      class: cls,
      // The frozen definitions of attribution/causal_estimate require a
      // declared method.
      content:
        cls === 'attribution' || cls === 'causal_estimate'
          ? { method: 'last-touch', window: '30d' }
          : validAppend.content,
      quality: cls === 'source_fact' ? 'D' : 'E',
    };
    assert.doesNotThrow(() => assertValidEvidenceAppend(input), `class ${cls}`);
  }
  // Supersession-targeting input is structurally valid too (the tier and
  // prior-existence rules run against durable state in the module).
  assert.doesNotThrow(() =>
    assertValidEvidenceAppend({ ...validAppend, class: 'inference', supersedesEvidenceId: 'ev-1' }),
  );
});

test('the append guard rejects every malformed shape (fail closed)', () => {
  const rejects = (input: EvidenceAppendInput, needle: string): void => {
    assert.throws(
      () => assertValidEvidenceAppend(input),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        // The guard's specific reasons ride in the typed error details.
        const rendered = [
          error.message,
          ...(('details' in error ? (error.details ?? []) : []) as string[]),
        ].join('\n');
        assert.ok(
          rendered.includes(needle),
          `expected '${rendered}' to mention '${needle}'`,
        );
        return true;
      },
    );
  };
  // Malformed class/quality values exercise the guard's closed sets — they
  // are deliberately outside the frozen unions, so they enter through the
  // input type (what a raw JSON body would carry).
  rejects(
    { ...validAppend, class: 'gut_feeling' as unknown as EvidenceAppendInput['class'] },
    'frozen evidence classes',
  );
  rejects(
    { ...validAppend, quality: 'G' as unknown as EvidenceAppendInput['quality'] },
    'frozen A..F grades',
  );
  rejects(
    { ...validAppend, content: {} as Record<string, unknown> },
    'must not be empty',
  );
  rejects(
    {
      ...validAppend,
      content: 'prose is not traceable content' as unknown as Record<string, unknown>,
    },
    'must be a JSON object',
  );
  rejects({ ...validAppend, observedAt: 'not-a-timestamp' }, 'ISO 8601');
  rejects({ ...validAppend, source: { system: '', ref: null } }, 'source.system');
  rejects({ ...validAppend, confidence: 1.5 }, 'between 0 and 1');
  rejects({ ...validAppend, confidence: -0.1 }, 'between 0 and 1');
  rejects(
    { ...validAppend, confidence: Number.NaN },
    'finite number',
  );
  rejects(
    { ...validAppend, supersedesEvidenceId: '' },
    'non-empty identifier',
  );
  rejects(
    { ...validAppend, class: 'attribution', content: { credit: 'channel-a' } },
    'declared method',
  );
  rejects(
    { ...validAppend, class: 'causal_estimate', content: { effect: 2.1 } },
    'declared method',
  );
});

test('the §21 material-key backstop rejects secret-shaped keys at every nesting level', () => {
  assert.equal(containsMaterialKey({ metric: 'spend' }), false);
  assert.equal(containsMaterialKey({ nested: { deep: { ok: 1 } }, list: [{ ok: 2 }] }), false);
  assert.equal(containsMaterialKey('scalar'), false);
  assert.equal(containsMaterialKey(null), false);

  assert.equal(containsMaterialKey({ secret: 'x' }), true, 'top level');
  assert.equal(containsMaterialKey({ nested: { apiKey: 'x' } }), true, 'nested object');
  assert.equal(containsMaterialKey({ rows: [{ token: 'x' }] }), true, 'inside an array');
  assert.equal(containsMaterialKey({ credentials: { password: 'x' } }), true, 'deep');
  assert.equal(containsMaterialKey({ Token: 'x' }), true, 'case-insensitive key match');

  // The append guard runs the same backstop on the content payload.
  assert.throws(
    () =>
      assertValidEvidenceAppend({
        ...validAppend,
        content: { report: { secret: 'must never enter evidence' } },
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const rendered = [
        error.message,
        ...(('details' in error ? (error.details ?? []) : []) as string[]),
      ].join('\n');
      assert.ok(rendered.includes('§21'), `expected '${rendered}' to mention '§21'`);
      return true;
    },
  );
});

test('the provenance guard fails closed on incomplete server-derived provenance', () => {
  const complete = {
    actor: 'user:0192-uuid',
    recordedVia: 'api',
    correlationId: 'corr-1',
    causationId: null,
  };
  assert.doesNotThrow(() => assertValidEvidenceProvenance(complete));
  assert.doesNotThrow(() =>
    assertValidEvidenceProvenance({ ...complete, causationId: 'job-9' }),
  );

  for (const broken of [
    { ...complete, actor: '' },
    { ...complete, recordedVia: '' },
    { ...complete, recordedVia: 'x'.repeat(101) },
    { ...complete, correlationId: '' },
    { ...complete, causationId: '' },
  ]) {
    assert.throws(
      () => assertValidEvidenceProvenance(broken),
      /provenance is server-derived and must be complete/,
    );
  }
});

const clientOwnership: ClientOwnerContext = {
  scope: { kind: 'client', agencyId: 'agency-1', clientId: 'client-1' },
  client: {
    clientId: 'client-1',
    agencyId: 'agency-1',
    name: 'Client One',
    slug: 'client-one',
    status: 'active',
    createdBy: null,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  agency: { agencyId: 'agency-1', slug: 'agency-one', status: 'active' },
  resolvedAt: '2026-01-02T00:00:00.000Z',
};

const baseEvidence: EvidenceRecord = {
  evidenceId: 'evidence-1',
  clientId: 'client-1',
  workspaceId: null,
  class: 'source_fact',
  source: { system: 'internal', ref: 'export/2026-01' },
  observedAt: '2026-01-15T10:30:00.000Z',
  content: { metric: 'spend', value: 100 },
  contentRef: null,
  quality: 'D',
  confidence: null,
  supersedes: null,
  supersededBy: null,
  provenance: {
    actor: 'user:user-9',
    recordedVia: 'api',
    correlationId: 'corr-1',
    causationId: null,
    recordedAt: '2026-01-15T10:31:00.000Z',
  },
};

const scopedWorkspace: WorkspaceRecord = {
  workspaceId: 'workspace-1',
  clientId: 'client-1',
  name: 'Workspace One',
  slug: 'workspace-one',
  status: 'active',
  createdBy: null,
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

test('composeEvidenceOwnerContext derives the canonical scope from durable ownership only', () => {
  const context = composeEvidenceOwnerContext(baseEvidence, clientOwnership, null, '2026-01-16');
  assert.deepEqual(context.scope, {
    kind: 'evidence',
    agencyId: 'agency-1',
    clientId: 'client-1',
    workspaceId: null,
    evidenceId: 'evidence-1',
  });
  assert.equal(context.client, clientOwnership.client);
  assert.equal(context.clientOwnership, clientOwnership);
  assert.equal(context.workspace, null);
  assert.equal(context.evidence, baseEvidence);

  // Workspace-scoped record: the workspace row rides along.
  const scoped = composeEvidenceOwnerContext(
    { ...baseEvidence, workspaceId: 'workspace-1' },
    clientOwnership,
    scopedWorkspace,
    '2026-01-16',
  );
  assert.equal(scoped.scope.workspaceId, 'workspace-1');
  assert.equal(scoped.workspace, scopedWorkspace);

  // The scope is derived from the CLIENT OWNERSHIP agency and the record's
  // own ownership fields — a caller-supplied agency id appears nowhere in
  // the composition inputs.
  assert.equal(scoped.scope.agencyId, clientOwnership.scope.agencyId);
});

test('composeEvidenceOwnerContext is pure — identical inputs compose identical outputs', () => {
  const first = composeEvidenceOwnerContext(baseEvidence, clientOwnership, null, 't');
  const second = composeEvidenceOwnerContext(baseEvidence, clientOwnership, null, 't');
  assert.deepEqual(first, second);
});
