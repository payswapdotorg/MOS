/**
 * /research store + input guards (MKT-062).
 *
 * Owns the migration 056 tables: the agency-scoped research-session records,
 * the append-only version tail (the IMMUTABLE declared sources — corrections
 * are NEW version records), the append-only retained source facts, the
 * append-only research insight records with their FK-anchored evidence links
 * and the append-only research run records with their per-source honest
 * outcomes.
 *
 * The §21 material-key backstop is the SHARED /evidence guard
 * (containsMaterialKey — the /product-intelligence /decisions precedent):
 * the ONE /evidence import of this module, READ-ONLY.
 *
 * The deterministic HTML extractor (extractResearchHtmlSourceFacts) is a
 * PURE function: the same input always produces the same facts — no clock,
 * no randomness, no network. Facts are EXTRACTED OBSERVATIONS, never
 * conclusions (architecture-v1.6.md §7).
 */

import { createHash } from 'node:crypto';
import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import { containsMaterialKey } from '../../evidence/public.ts';
import type {
  ResearchFactKind,
  ResearchInsightAiAssistanceInput,
  ResearchInsightRecord,
  ResearchProvenance,
  ResearchRecordedProvenance,
  ResearchRunRecord,
  ResearchRunSourceOutcomeRecord,
  ResearchSessionDeclarationInput,
  ResearchSessionRecord,
  ResearchSessionVersionRecord,
  ResearchSourceDeclaration,
  ResearchSourceFactRecord,
  ResearchSourceRecord,
} from '../public.ts';
import {
  RESEARCH_AUTHORIZED_SOURCE_KINDS,
  RESEARCH_DERIVATION_KINDS,
  RESEARCH_PUBLIC_SOURCE_KINDS,
} from '../public.ts';

// ---------------------------------------------------------------------------
// Bounds (the frozen input guards — module-side mirrors of the DB fences)
// ---------------------------------------------------------------------------

export const RESEARCH_STATEMENT_SUMMARY_MAX = 2000 as const;
const TOPIC_MAX_LENGTH = 500;
const FOCUS_MAX_LENGTH = 2000;
const REFERENCE_MAX_LENGTH = 2048;
const ACTOR_MAX_LENGTH = 100;
const MAX_SOURCES_PER_VERSION = 40;
const MAX_STATEMENT_KEYS = 16;
const MAX_STATEMENT_SERIALIZED = 8000;
const MAX_EVIDENCE_REFS = 50;
const CALL_REFERENCE_MAX_LENGTH = 500;
const EXTRACTED_TEXT_MAX = 500;
const EXTRACTED_HEADING_MAX = 300;
const EXTRACTED_EXCERPT_MAX = 600;
const MAX_HEADINGS_PER_PAGE = 10;
const MAX_TEXT_EXCERPTS_PER_PAGE = 1;

// ---------------------------------------------------------------------------
// Input guards (pure — exported for unit tests + future server-side callers)
// ---------------------------------------------------------------------------

/**
 * Validates a declared research session against the frozen vocabulary +
 * bounds. The kind-compatible AUTHORIZATION fence is enforced here AND in
 * the migration-056 CHECK (defense in depth): the six public web kinds
 * carry authorization 'public' and NO connection reference; the two
 * authorized kinds carry authorization 'authorized' AND a connection
 * reference.
 */
export function assertValidResearchSessionDeclaration(
  declaration: ResearchSessionDeclarationInput,
): void {
  const problems: string[] = [];
  if (declaration === null || typeof declaration !== 'object' || Array.isArray(declaration)) {
    throw new InvalidRequestError('Invalid research session declaration', [
      'declaration: must be an object',
    ]);
  }
  if (
    declaration.topic !== null &&
    (typeof declaration.topic !== 'string' ||
      declaration.topic.length === 0 ||
      declaration.topic.length > TOPIC_MAX_LENGTH)
  ) {
    problems.push(`topic: null or 1..${TOPIC_MAX_LENGTH} characters`);
  }
  if (
    declaration.focus !== null &&
    (typeof declaration.focus !== 'string' ||
      declaration.focus.length === 0 ||
      declaration.focus.length > FOCUS_MAX_LENGTH)
  ) {
    problems.push(`focus: null or 1..${FOCUS_MAX_LENGTH} characters`);
  }
  if (!Array.isArray(declaration.sources) || declaration.sources.length === 0) {
    problems.push('sources: at least one declared source is required');
  } else {
    if (declaration.sources.length > MAX_SOURCES_PER_VERSION) {
      problems.push(`sources: at most ${MAX_SOURCES_PER_VERSION} per version`);
    }
    const seen = new Set<string>();
    declaration.sources.forEach((source, index) => {
      const prefix = `sources[${index}]`;
      if (source === null || typeof source !== 'object' || Array.isArray(source)) {
        problems.push(`${prefix}: must be an object`);
        return;
      }
      const knownKind =
        (RESEARCH_PUBLIC_SOURCE_KINDS as readonly string[]).includes(source.kind) ||
        (RESEARCH_AUTHORIZED_SOURCE_KINDS as readonly string[]).includes(source.kind);
      if (typeof source.kind !== 'string' || !knownKind) {
        problems.push(`${prefix}.kind: unknown source kind '${String(source.kind)}'`);
      }
      if (
        typeof source.reference !== 'string' ||
        source.reference.length === 0 ||
        source.reference.length > REFERENCE_MAX_LENGTH
      ) {
        problems.push(`${prefix}.reference: 1..${REFERENCE_MAX_LENGTH} characters`);
      }
      if (source.authorization !== 'public' && source.authorization !== 'authorized') {
        problems.push(
          `${prefix}.authorization: must be 'public' or 'authorized' (got '${String(source.authorization)}')`,
        );
      }
      if (
        typeof source.integrationConnectionId !== 'string' &&
        source.integrationConnectionId !== null
      ) {
        problems.push(`${prefix}.integrationConnectionId: must be a string or null`);
      }
      // THE KIND-COMPATIBLE AUTHORIZATION FENCE (§7).
      const isPublicKind = (RESEARCH_PUBLIC_SOURCE_KINDS as readonly string[]).includes(
        source.kind,
      );
      const isAuthorizedKind = (RESEARCH_AUTHORIZED_SOURCE_KINDS as readonly string[]).includes(
        source.kind,
      );
      if (isPublicKind) {
        if (source.authorization !== 'public') {
          problems.push(
            `${prefix}: the public web kind '${source.kind}' must carry authorization 'public' — public research sources need no grant`,
          );
        }
        if (source.integrationConnectionId !== null) {
          problems.push(
            `${prefix}: the public web kind '${source.kind}' must not carry an integration connection reference`,
          );
        }
      } else if (isAuthorizedKind) {
        if (source.authorization !== 'authorized') {
          problems.push(
            `${prefix}: the authorized kind '${source.kind}' REQUIRES authorization 'authorized' — §7: connected repositories/workspaces only when explicitly authorized`,
          );
        }
        if (
          typeof source.integrationConnectionId !== 'string' ||
          source.integrationConnectionId.length === 0
        ) {
          problems.push(
            `${prefix}: the authorized kind '${source.kind}' REQUIRES a canonical integration connection reference`,
          );
        }
      }
      // The declared duplicate fence (the DB UNIQUE backstop).
      const key = `${source.kind}\u0000${source.reference}`;
      if (seen.has(key)) {
        problems.push(`${prefix}: duplicate declared source (kind, reference) '${source.kind}'`);
      }
      seen.add(key);
    });
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('Invalid research session declaration', problems);
  }
}

/**
 * SERVER-DERIVED provenance validation (the growth-missions guard): the
 * actor is a bounded labeled principal, the surface is a bounded label,
 * correlation is present — a provenance block is never caller-invented
 * free-form payload.
 */
export function assertValidResearchProvenance(provenance: ResearchProvenance): void {
  const problems: string[] = [];
  if (
    typeof provenance.actor !== 'string' ||
    provenance.actor.length === 0 ||
    provenance.actor.length > ACTOR_MAX_LENGTH
  ) {
    problems.push('provenance.actor: a server-derived actor label is required');
  }
  if (
    typeof provenance.recordedVia !== 'string' ||
    provenance.recordedVia.length === 0 ||
    provenance.recordedVia.length > ACTOR_MAX_LENGTH
  ) {
    problems.push('provenance.recordedVia: a server-derived surface label is required');
  }
  if (typeof provenance.correlationId !== 'string' || provenance.correlationId.length === 0) {
    problems.push('provenance.correlationId: required');
  }
  if (
    provenance.causationId !== null &&
    (typeof provenance.causationId !== 'string' || provenance.causationId.length === 0)
  ) {
    problems.push('provenance.causationId: must be null or a non-empty string');
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('Invalid research provenance', problems);
  }
}

/**
 * Validates one research-insight recording input: the frozen derivation
 * kind, the bounded statement (a non-empty object with a REQUIRED bounded
 * summary — the CLAIM itself; §21-guarded at every nesting level), the
 * bounded unique evidence references and the AI-assistance disclosure
 * shape (model identity + call reference, all or none).
 */
export function assertValidResearchInsightInput(input: {
  readonly derivationKind: string;
  readonly statement: Readonly<Record<string, unknown>>;
  readonly evidenceSourceFactIds: readonly string[];
  readonly aiAssistance: ResearchInsightAiAssistanceInput | null;
}): void {
  const problems: string[] = [];
  if (
    typeof input.derivationKind !== 'string' ||
    !(RESEARCH_DERIVATION_KINDS as readonly string[]).includes(input.derivationKind)
  ) {
    problems.push('derivationKind: must be one of the frozen §7 derivation kinds');
  }
  problems.push(...statementProblems(input.statement, 'statement'));
  if (!Array.isArray(input.evidenceSourceFactIds)) {
    problems.push('evidenceSourceFactIds: must be an array');
  } else {
    if (input.evidenceSourceFactIds.length > MAX_EVIDENCE_REFS) {
      problems.push(`evidenceSourceFactIds: at most ${MAX_EVIDENCE_REFS} references`);
    }
    const seen = new Set<string>();
    for (const [index, ref] of input.evidenceSourceFactIds.entries()) {
      if (typeof ref !== 'string' || ref.length === 0) {
        problems.push(`evidenceSourceFactIds[${index}]: a non-empty source fact id is required`);
      } else if (seen.has(ref)) {
        problems.push(`evidenceSourceFactIds[${index}]: duplicate reference '${ref}'`);
      }
      seen.add(ref);
    }
  }
  if (input.aiAssistance !== null) {
    if (input.aiAssistance === undefined || typeof input.aiAssistance !== 'object') {
      problems.push('aiAssistance: must be an object or null');
    } else {
      if (
        typeof input.aiAssistance.modelRegistryId !== 'string' ||
        input.aiAssistance.modelRegistryId.length === 0
      ) {
        problems.push('aiAssistance.modelRegistryId: a non-empty /ai-runtime registry id is required');
      }
      if (
        typeof input.aiAssistance.callReference !== 'string' ||
        input.aiAssistance.callReference.length === 0 ||
        input.aiAssistance.callReference.length > CALL_REFERENCE_MAX_LENGTH
      ) {
        problems.push(`aiAssistance.callReference: 1..${CALL_REFERENCE_MAX_LENGTH} characters`);
      }
    }
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('Invalid research insight recording', problems);
  }
}

/** The bounded statement guard: a non-empty object with a REQUIRED bounded summary, §21-guarded. */
function statementProblems(
  statement: Readonly<Record<string, unknown>>,
  field: string,
): string[] {
  if (statement === null || typeof statement !== 'object' || Array.isArray(statement)) {
    return [`${field}: must be a non-empty object`];
  }
  const problems: string[] = [];
  const keys = Object.keys(statement);
  if (keys.length === 0) {
    problems.push(`${field}: a non-empty object is required`);
  }
  if (keys.length > MAX_STATEMENT_KEYS) {
    problems.push(`${field}: at most ${MAX_STATEMENT_KEYS} keys`);
  }
  const summary = (statement as Record<string, unknown>)['summary'];
  if (
    typeof summary !== 'string' ||
    summary.length === 0 ||
    summary.length > RESEARCH_STATEMENT_SUMMARY_MAX
  ) {
    problems.push(
      `${field}.summary: required, 1..${RESEARCH_STATEMENT_SUMMARY_MAX} characters`,
    );
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(statement);
  } catch {
    serialized = '';
  }
  if (serialized === '' || serialized.length > MAX_STATEMENT_SERIALIZED) {
    problems.push(
      `${field}: the serialized statement must stay under ${MAX_STATEMENT_SERIALIZED} characters`,
    );
  }
  if (containsMaterialKey(statement)) {
    problems.push(`${field}: material-shaped keys are rejected at every nesting level (§21)`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Content hashing + the deterministic HTML extractor (pure)
// ---------------------------------------------------------------------------

/** sha256 hex (64 chars) of the material a fact was extracted from. */
export function hashResearchContent(material: string): string {
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

/** One deterministic extraction candidate (before persistence). */
export interface ExtractedResearchFactCandidate {
  readonly factKind: ResearchFactKind;
  readonly content: Readonly<Record<string, unknown>>;
  readonly extractionNotes: string;
}

/** Collapses whitespace and bounds a text value. */
function bound(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : collapsed.slice(0, max);
}

/**
 * THE DETERMINISTIC HTML EXTRACTOR ('research-html-extract-v1'): a PURE,
 * bounded, regex-based extraction of the document-head identity
 * observations, the OpenGraph observations and the first headings/excerpt
 * of the body — EXTRACTED OBSERVATIONS carried VERBATIM (never
 * interpreted, never concluded). Deterministic by construction: no clock,
 * no randomness, no network; the same input always yields the same facts
 * in the same order.
 */
export function extractResearchHtmlSourceFacts(
  html: string,
): readonly ExtractedResearchFactCandidate[] {
  const facts: ExtractedResearchFactCandidate[] = [];
  const head = html.length > 200_000 ? html.slice(0, 200_000) : html;

  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  if (title !== null) {
    const value = bound(title[1]!, EXTRACTED_TEXT_MAX);
    if (value !== '') {
      facts.push({
        factKind: 'page_title',
        content: { text: value },
        extractionNotes: 'extracted from the <title> element, verbatim',
      });
    }
  }

  const meta = (name: string, property = false): string | null => {
    const attr = property ? 'property' : 'name';
    const pattern = new RegExp(
      `<meta[^>]*\\s${attr}\\s*=\\s*["']${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`,
      'i',
    );
    const tag = pattern.exec(head);
    if (tag === null) return null;
    const contentMatch = /content\s*=\s*["']([^"']*)["']/i.exec(tag[0]!);
    return contentMatch === null ? null : bound(contentMatch[1]!, EXTRACTED_TEXT_MAX);
  };

  const description = meta('description');
  if (description !== null && description !== '') {
    facts.push({
      factKind: 'meta_description',
      content: { text: description },
      extractionNotes: 'extracted from <meta name="description">, verbatim',
    });
  }
  const keywords = meta('keywords');
  if (keywords !== null && keywords !== '') {
    facts.push({
      factKind: 'meta_keywords',
      content: { text: keywords },
      extractionNotes: 'extracted from <meta name="keywords">, verbatim',
    });
  }
  const ogTitle = meta('og:title', true);
  if (ogTitle !== null && ogTitle !== '') {
    facts.push({
      factKind: 'og_title',
      content: { text: ogTitle },
      extractionNotes: 'extracted from <meta property="og:title">, verbatim',
    });
  }
  const ogDescription = meta('og:description', true);
  if (ogDescription !== null && ogDescription !== '') {
    facts.push({
      factKind: 'og_description',
      content: { text: ogDescription },
      extractionNotes: 'extracted from <meta property="og:description">, verbatim',
    });
  }

  const canonical = /<link[^>]*rel\s*=\s*["']canonical["'][^>]*>/i.exec(head);
  if (canonical !== null) {
    const href = /href\s*=\s*["']([^"']*)["']/i.exec(canonical[0]!);
    if (href !== null && href[1] !== '') {
      facts.push({
        factKind: 'canonical_url',
        content: { url: href[1]! },
        extractionNotes: 'extracted from <link rel="canonical">, verbatim',
      });
    }
  }

  const lang = /<html[^>]*\slang\s*=\s*["']([a-zA-Z-]{2,35})["'][^>]*>/i.exec(head);
  if (lang !== null) {
    facts.push({
      factKind: 'page_language',
      content: { lang: lang[1]!.toLowerCase() },
      extractionNotes: 'extracted from the <html lang> attribute, verbatim',
    });
  }

  // The heading observations (first N, document order — h1..h3).
  const headingPattern = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let headingMatch: RegExpExecArray | null = headingPattern.exec(head);
  let headingCount = 0;
  while (headingMatch !== null && headingCount < MAX_HEADINGS_PER_PAGE) {
    const text = bound(headingMatch[2]!.replace(/<[^>]*>/g, ' '), EXTRACTED_HEADING_MAX);
    if (text !== '') {
      headingCount += 1;
      facts.push({
        factKind: 'heading',
        content: { level: Number(headingMatch[1]!), text },
        extractionNotes: `extracted from an h${headingMatch[1]} element, document order ${headingCount}`,
      });
    }
    headingMatch = headingPattern.exec(head);
  }

  // One bounded plain-text body excerpt (the honest "what the page says"
  // observation — tag-stripped, whitespace-collapsed, length-bounded).
  const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  const bodyText = bound(
    (bodyMatch === null ? html : bodyMatch[1]!).replace(/<[^>]*>/g, ' '),
    EXTRACTED_EXCERPT_MAX,
  );
  if (bodyText !== '') {
    for (let index = 0; index < MAX_TEXT_EXCERPTS_PER_PAGE; index += 1) {
      facts.push({
        factKind: 'text_excerpt',
        content: { excerpt: bodyText },
        extractionNotes:
          'tag-stripped plain-text body excerpt (whitespace-collapsed, length-bounded)',
      });
    }
  }

  return facts;
}

/** The frozen extractor identity of the authorized integration reads. */
export const RESEARCH_READ_NOTES =
  'normalized provider record observed through an authorized /integrations read, carried verbatim';

/**
 * THE SERVER-COMPUTED VERIFICATION STATE (never caller-declared):
 * ≥1 cited source fact → 'evidence_backed'; none → 'unverified'
 * (architecture-v1.6.md §7: "Model output is a claim unless backed by
 * evidence"). Exported so the discipline is part of the module contract
 * (unit-testable + the /content-intelligence sibling's future composition
 * surface); the migration-056 DEFERRABLE constraint trigger is the
 * commit-time backstop.
 */
export function researchDerivedVerificationState(
  evidenceCount: number,
): 'unverified' | 'evidence_backed' {
  return evidenceCount > 0 ? 'evidence_backed' : 'unverified';
}

/**
 * Pure composition of the canonical research-session owner context from the
 * session record (the composeGrowthMissionOwnerContext precedent). Purity
 * is asserted by unit tests — the same inputs always compose the same
 * context. The agency ROW is resolved at the route layer (/agencies is not
 * a frozen allowance of this module's dependency row — the /app-metering
 * precedent); this context carries the scope identity the route layer
 * authorizes.
 */
export function composeResearchSessionOwnerContext(
  session: ResearchSessionRecord,
  resolvedAt: string,
): {
  readonly scope: {
    readonly kind: 'research-session';
    readonly agencyId: string;
    readonly researchSessionId: string;
  };
  readonly session: ResearchSessionRecord;
  readonly resolvedAt: string;
} {
  return {
    scope: {
      kind: 'research-session',
      agencyId: session.agencyId,
      researchSessionId: session.researchSessionId,
    },
    session,
    resolvedAt,
  };
}

// ---------------------------------------------------------------------------
// Row shapes (snake_case DB rows)
// ---------------------------------------------------------------------------

interface SessionRow extends DbRow {
  research_session_id: string;
  agency_id: string;
  current_version_seq: number;
  version: number;
  created_actor: string;
  created_at: Date;
  updated_at: Date;
}

interface VersionRow extends DbRow {
  research_session_version_id: string;
  research_session_id: string;
  version_seq: number;
  topic: string | null;
  focus: string | null;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
}

interface SourceRow extends DbRow {
  source_id: string;
  research_session_version_id: string;
  kind: string;
  reference: string;
  authorization_state: string;
  integration_connection_id: string | null;
  position: number;
}

interface FactRow extends DbRow {
  research_source_fact_id: string;
  research_session_id: string;
  research_session_version_id: string;
  source_id: string;
  research_run_id: string;
  fact_kind: string;
  source_ref: string;
  fetched_at: Date;
  extractor: string;
  content_hash: string;
  extraction_notes: string | null;
  content: Record<string, unknown>;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
}

interface InsightRow extends DbRow {
  research_insight_id: string;
  research_session_id: string;
  derivation_kind: string;
  statement: Record<string, unknown>;
  verification_state: string;
  supersedes_research_insight_id: string | null;
  ai_model_registry_id: string | null;
  ai_model_display: string | null;
  ai_call_reference: string | null;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
}

interface RunRow extends DbRow {
  research_run_id: string;
  research_session_id: string;
  research_session_version_id: string;
  status: string;
  sources_inspected: number;
  facts_retained: number;
  started_at: Date;
  finished_at: Date;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
}

interface RunSourceOutcomeRow extends DbRow {
  research_run_source_outcome_id: string;
  research_run_id: string;
  source_id: string;
  outcome: string;
  detail: string | null;
  facts_extracted: number;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** One retained-fact append command (composed by the module's research pass). */
export interface AppendResearchSourceFactInput {
  readonly sourceFactId: string;
  readonly researchSessionId: string;
  readonly researchSessionVersionId: string;
  readonly sourceId: string;
  readonly researchRunId: string;
  readonly factKind: ResearchFactKind;
  readonly sourceRef: string;
  readonly fetchedAt: string;
  readonly extractor: string;
  readonly contentHash: string;
  readonly extractionNotes: string | null;
  readonly content: Readonly<Record<string, unknown>>;
  readonly provenance: ResearchProvenance;
}

export class ResearchStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  now(): string {
    return this.clock.nowIso();
  }

  newId(): string {
    return this.ids.newId();
  }

  // --- research session record ---

  async insertSession(input: {
    readonly researchSessionId: string;
    readonly agencyId: string;
    readonly createdActor: string;
    readonly now: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO research_sessions (research_session_id, agency_id, current_version_seq, version,
                                       created_actor, created_at, updated_at)
       VALUES ($1, $2, 1, 1, $3, $4, $4)`,
      [input.researchSessionId, input.agencyId, input.createdActor, input.now],
    );
  }

  async getSession(researchSessionId: string): Promise<ResearchSessionRecord | null> {
    const result = await this.db.query<SessionRow>(`${SESSION_SELECT} WHERE research_session_id = $1`, [
      researchSessionId,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : toSessionRecord(row);
  }

  async listSessionsForAgency(agencyId: string): Promise<readonly ResearchSessionRecord[]> {
    const result = await this.db.query<SessionRow>(
      `${SESSION_SELECT} WHERE agency_id = $1 ORDER BY created_at, research_session_id`,
      [agencyId],
    );
    return result.rows.map(toSessionRecord);
  }

  /** Locks the session row (FOR UPDATE) — every mutation is serialized. */
  async lockSession(
    tx: DbTransaction,
    researchSessionId: string,
  ): Promise<ResearchSessionRecord | null> {
    const result = await tx.query<SessionRow>(`${SESSION_SELECT} WHERE research_session_id = $1 FOR UPDATE`, [
      researchSessionId,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : toSessionRecord(row);
  }

  async advanceSessionVersionRow(
    tx: DbTransaction,
    input: {
      readonly researchSessionId: string;
      readonly versionSeq: number;
      readonly expectedVersion: number;
    },
  ): Promise<'ok' | 'lost'> {
    const result = await tx.query(
      `UPDATE research_sessions
          SET current_version_seq = $2, version = version + 1, updated_at = $3
        WHERE research_session_id = $1 AND version = $4`,
      [input.researchSessionId, input.versionSeq, this.now(), input.expectedVersion],
    );
    return result.rowCount === 1 ? 'ok' : 'lost';
  }

  async countVersions(tx: DbTransaction, researchSessionId: string): Promise<number> {
    const result = await tx.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM research_session_versions WHERE research_session_id = $1`,
      [researchSessionId],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  // --- version tail + declared sources ---

  async insertVersion(
    tx: DbTransaction,
    input: {
      readonly researchSessionVersionId: string;
      readonly researchSessionId: string;
      readonly versionSeq: number;
      readonly declaration: ResearchSessionDeclarationInput;
      readonly provenance: ResearchProvenance;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO research_session_versions (research_session_version_id, research_session_id, version_seq,
                                                topic, focus, recorded_actor, recorded_via,
                                                correlation_id, causation_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        input.researchSessionVersionId,
        input.researchSessionId,
        input.versionSeq,
        input.declaration.topic,
        input.declaration.focus,
        input.provenance.actor,
        input.provenance.recordedVia,
        input.provenance.correlationId,
        input.provenance.causationId,
        this.now(),
      ],
    );
    await this.insertSources(tx, input.researchSessionVersionId, input.declaration.sources);
  }

  private async insertSources(
    tx: DbTransaction,
    researchSessionVersionId: string,
    sources: readonly ResearchSourceDeclaration[],
  ): Promise<void> {
    for (const [index, source] of sources.entries()) {
      await tx.query(
        `INSERT INTO research_session_sources (source_id, research_session_version_id, kind, reference,
                                                 authorization_state, integration_connection_id, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          this.ids.newId(),
          researchSessionVersionId,
          source.kind,
          source.reference,
          source.authorization,
          source.integrationConnectionId,
          index + 1,
        ],
      );
    }
  }

  async listVersions(researchSessionId: string): Promise<ResearchSessionVersionRecord[]> {
    const [versionRows, sourceRows] = await Promise.all([
      this.db.query<VersionRow>(
        `SELECT * FROM research_session_versions WHERE research_session_id = $1
          ORDER BY version_seq`,
        [researchSessionId],
      ),
      this.db.query<SourceRow>(
        `SELECT s.* FROM research_session_sources s
           JOIN research_session_versions v ON v.research_session_version_id = s.research_session_version_id
          WHERE v.research_session_id = $1
          ORDER BY s.position`,
        [researchSessionId],
      ),
    ]);
    return versionRows.rows.map((row) => {
      const sources = sourceRows.rows
        .filter((source) => source.research_session_version_id === row.research_session_version_id)
        .map(toSourceRecord);
      return toVersionRecord(row, sources);
    });
  }

  // --- research runs ---

  async insertRun(
    tx: DbTransaction,
    input: {
      readonly researchRunId: string;
      readonly researchSessionId: string;
      readonly researchSessionVersionId: string;
      readonly status: string;
      readonly sourcesInspected: number;
      readonly factsRetained: number;
      readonly startedAt: string;
      readonly finishedAt: string;
      readonly provenance: ResearchProvenance;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO research_runs (research_run_id, research_session_id, research_session_version_id,
                                   status, sources_inspected, facts_retained, started_at, finished_at,
                                   recorded_actor, recorded_via, correlation_id, causation_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        input.researchRunId,
        input.researchSessionId,
        input.researchSessionVersionId,
        input.status,
        input.sourcesInspected,
        input.factsRetained,
        input.startedAt,
        input.finishedAt,
        input.provenance.actor,
        input.provenance.recordedVia,
        input.provenance.correlationId,
        input.provenance.causationId,
        this.now(),
      ],
    );
  }

  async insertRunSourceOutcome(
    tx: DbTransaction,
    input: {
      readonly researchRunId: string;
      readonly sourceId: string;
      readonly outcome: string;
      readonly detail: string | null;
      readonly factsExtracted: number;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO research_run_source_outcomes (research_run_source_outcome_id, research_run_id,
                                                    source_id, outcome, detail, facts_extracted, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        this.ids.newId(),
        input.researchRunId,
        input.sourceId,
        input.outcome,
        input.detail,
        input.factsExtracted,
        this.now(),
      ],
    );
  }

  async listRuns(researchSessionId: string): Promise<ResearchRunRecord[]> {
    const [runRows, outcomeRows] = await Promise.all([
      this.db.query<RunRow>(
        `SELECT * FROM research_runs WHERE research_session_id = $1
          ORDER BY created_at, research_run_id`,
        [researchSessionId],
      ),
      this.db.query<RunSourceOutcomeRow>(
        `SELECT o.* FROM research_run_source_outcomes o
           JOIN research_runs r ON r.research_run_id = o.research_run_id
          WHERE r.research_session_id = $1
          ORDER BY o.created_at, o.research_run_source_outcome_id`,
        [researchSessionId],
      ),
    ]);
    return runRows.rows.map((row) => {
      const outcomes = outcomeRows.rows
        .filter((outcome) => outcome.research_run_id === row.research_run_id)
        .map(toRunSourceOutcomeRecord);
      return toRunRecord(row, outcomes);
    });
  }

  // --- retained source facts ---

  async insertSourceFact(tx: DbTransaction, input: AppendResearchSourceFactInput): Promise<void> {
    await tx.query(
      `INSERT INTO research_source_facts (research_source_fact_id, research_session_id,
                                            research_session_version_id, source_id, research_run_id,
                                            fact_kind, source_ref, fetched_at, extractor, content_hash,
                                            extraction_notes, content,
                                            recorded_actor, recorded_via, correlation_id, causation_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        input.sourceFactId,
        input.researchSessionId,
        input.researchSessionVersionId,
        input.sourceId,
        input.researchRunId,
        input.factKind,
        input.sourceRef,
        input.fetchedAt,
        input.extractor,
        input.contentHash,
        input.extractionNotes,
        JSON.stringify(input.content),
        input.provenance.actor,
        input.provenance.recordedVia,
        input.provenance.correlationId,
        input.provenance.causationId,
        this.now(),
      ],
    );
  }

  async listSourceFacts(researchSessionId: string): Promise<ResearchSourceFactRecord[]> {
    const result = await this.db.query<FactRow>(
      `SELECT * FROM research_source_facts WHERE research_session_id = $1
        ORDER BY created_at, research_source_fact_id`,
      [researchSessionId],
    );
    return result.rows.map(toFactRecord);
  }

  async getSourceFact(sourceFactId: string): Promise<ResearchSourceFactRecord | null> {
    const result = await this.db.query<FactRow>(
      `SELECT * FROM research_source_facts WHERE research_source_fact_id = $1`,
      [sourceFactId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toFactRecord(row);
  }

  // --- research insights ---

  async insertInsight(
    tx: DbTransaction,
    input: {
      readonly researchInsightId: string;
      readonly researchSessionId: string;
      readonly derivationKind: string;
      readonly statement: Readonly<Record<string, unknown>>;
      readonly verificationState: string;
      readonly supersedesResearchInsightId: string | null;
      readonly aiModelRegistryId: string | null;
      readonly aiModelDisplay: string | null;
      readonly aiCallReference: string | null;
      readonly provenance: ResearchProvenance;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO research_insights (research_insight_id, research_session_id, derivation_kind,
                                        statement, verification_state, supersedes_research_insight_id,
                                        ai_model_registry_id, ai_model_display, ai_call_reference,
                                        recorded_actor, recorded_via, correlation_id, causation_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        input.researchInsightId,
        input.researchSessionId,
        input.derivationKind,
        JSON.stringify(input.statement),
        input.verificationState,
        input.supersedesResearchInsightId,
        input.aiModelRegistryId,
        input.aiModelDisplay,
        input.aiCallReference,
        input.provenance.actor,
        input.provenance.recordedVia,
        input.provenance.correlationId,
        input.provenance.causationId,
        this.now(),
      ],
    );
  }

  async insertInsightEvidence(
    tx: DbTransaction,
    input: {
      readonly researchInsightId: string;
      readonly sourceFactIds: readonly string[];
    },
  ): Promise<void> {
    for (const [index, sourceFactId] of input.sourceFactIds.entries()) {
      await tx.query(
        `INSERT INTO research_insight_evidence (research_insight_id, source_fact_id, position)
         VALUES ($1, $2, $3)`,
        [input.researchInsightId, sourceFactId, index + 1],
      );
    }
  }

  async listInsights(researchSessionId: string): Promise<ResearchInsightRecord[]> {
    const [insightRows, evidenceRows, supersededBy] = await Promise.all([
      this.db.query<InsightRow>(
        `SELECT * FROM research_insights WHERE research_session_id = $1
          ORDER BY created_at, research_insight_id`,
        [researchSessionId],
      ),
      this.db.query<{ research_insight_id: string; source_fact_id: string }>(
        `SELECT e.research_insight_id, e.source_fact_id FROM research_insight_evidence e
           JOIN research_insights i ON i.research_insight_id = e.research_insight_id
          WHERE i.research_session_id = $1
          ORDER BY e.research_insight_id, e.position`,
        [researchSessionId],
      ),
      this.db.query<{ supersedes_research_insight_id: string; superseded_by: string }>(
        `SELECT supersedes_research_insight_id, research_insight_id AS superseded_by
           FROM research_insights
          WHERE research_session_id = $1 AND supersedes_research_insight_id IS NOT NULL`,
        [researchSessionId],
      ),
    ]);
    const supersededByMap = new Map(
      supersededBy.rows.map((row) => [row.supersedes_research_insight_id, row.superseded_by]),
    );
    return insightRows.rows.map((row) => {
      const evidence = evidenceRows.rows
        .filter((link) => link.research_insight_id === row.research_insight_id)
        .map((link) => link.source_fact_id);
      return toInsightRecord(row, evidence, supersededByMap.get(row.research_insight_id) ?? null);
    });
  }

  async getInsightById(researchInsightId: string): Promise<ResearchInsightRecord | null> {
    const insightRows = await this.db.query<InsightRow>(
      `SELECT * FROM research_insights WHERE research_insight_id = $1`,
      [researchInsightId],
    );
    const row = insightRows.rows[0];
    if (row === undefined) return null;
    const [evidenceRows, supersededBy] = await Promise.all([
      this.db.query<{ source_fact_id: string }>(
        `SELECT source_fact_id FROM research_insight_evidence
          WHERE research_insight_id = $1 ORDER BY position`,
        [researchInsightId],
      ),
      this.db.query<{ superseded_by: string }>(
        `SELECT research_insight_id AS superseded_by FROM research_insights
          WHERE supersedes_research_insight_id = $1`,
        [researchInsightId],
      ),
    ]);
    return toInsightRecord(
      row,
      evidenceRows.rows.map((link) => link.source_fact_id),
      supersededBy.rows[0]?.superseded_by ?? null,
    );
  }
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

const SESSION_SELECT = `SELECT research_session_id, agency_id, current_version_seq, version,
                               created_actor, created_at, updated_at
                          FROM research_sessions`;

function toIso(value: Date): string {
  return value.toISOString();
}

function toSessionRecord(row: SessionRow): ResearchSessionRecord {
  return {
    researchSessionId: row.research_session_id,
    agencyId: row.agency_id,
    currentVersionSeq: row.current_version_seq,
    version: Number(row.version),
    createdActor: row.created_actor,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toRecordedProvenance(
  actor: string,
  recordedVia: string,
  correlationId: string,
  causationId: string | null,
  recordedAt: Date,
): ResearchRecordedProvenance {
  return {
    actor,
    recordedVia,
    correlationId,
    causationId,
    recordedAt: toIso(recordedAt),
  };
}

function toSourceRecord(row: SourceRow): ResearchSourceRecord {
  return {
    sourceId: row.source_id,
    researchSessionVersionId: row.research_session_version_id,
    kind: row.kind as ResearchSourceRecord['kind'],
    reference: row.reference,
    authorization: row.authorization_state as ResearchSourceRecord['authorization'],
    integrationConnectionId: row.integration_connection_id,
    position: row.position,
  };
}

function toVersionRecord(
  row: VersionRow,
  sources: readonly ResearchSourceRecord[],
): ResearchSessionVersionRecord {
  return {
    researchSessionVersionId: row.research_session_version_id,
    researchSessionId: row.research_session_id,
    versionSeq: row.version_seq,
    topic: row.topic,
    focus: row.focus,
    sources,
    provenance: toRecordedProvenance(
      row.recorded_actor,
      row.recorded_via,
      row.correlation_id,
      row.causation_id,
      row.created_at,
    ),
  };
}

function toFactRecord(row: FactRow): ResearchSourceFactRecord {
  return {
    sourceFactId: row.research_source_fact_id,
    researchSessionId: row.research_session_id,
    researchSessionVersionId: row.research_session_version_id,
    sourceId: row.source_id,
    researchRunId: row.research_run_id,
    factKind: row.fact_kind as ResearchSourceFactRecord['factKind'],
    sourceRef: row.source_ref,
    fetchedAt: toIso(row.fetched_at),
    extractor: row.extractor,
    contentHash: row.content_hash,
    extractionNotes: row.extraction_notes,
    content: row.content,
    provenance: toRecordedProvenance(
      row.recorded_actor,
      row.recorded_via,
      row.correlation_id,
      row.causation_id,
      row.created_at,
    ),
  };
}

function toInsightRecord(
  row: InsightRow,
  evidence: readonly string[],
  supersededBy: string | null,
): ResearchInsightRecord {
  return {
    researchInsightId: row.research_insight_id,
    researchSessionId: row.research_session_id,
    derivationKind: row.derivation_kind as ResearchInsightRecord['derivationKind'],
    statement: row.statement,
    verificationState: row.verification_state as ResearchInsightRecord['verificationState'],
    supersedesResearchInsightId: row.supersedes_research_insight_id,
    supersededByResearchInsightId: supersededBy,
    aiAssistance:
      row.ai_model_registry_id === null
        ? null
        : {
            modelRegistryId: row.ai_model_registry_id,
            modelDisplay: row.ai_model_display ?? '',
            callReference: row.ai_call_reference ?? '',
          },
    evidenceSourceFactIds: evidence,
    provenance: toRecordedProvenance(
      row.recorded_actor,
      row.recorded_via,
      row.correlation_id,
      row.causation_id,
      row.created_at,
    ),
  };
}

function toRunSourceOutcomeRecord(row: RunSourceOutcomeRow): ResearchRunSourceOutcomeRecord {
  return {
    researchRunSourceOutcomeId: row.research_run_source_outcome_id,
    researchRunId: row.research_run_id,
    sourceId: row.source_id,
    outcome: row.outcome as ResearchRunSourceOutcomeRecord['outcome'],
    detail: row.detail,
    factsExtracted: row.facts_extracted,
  };
}

function toRunRecord(
  row: RunRow,
  outcomes: readonly ResearchRunSourceOutcomeRecord[],
): ResearchRunRecord {
  return {
    researchRunId: row.research_run_id,
    researchSessionId: row.research_session_id,
    researchSessionVersionId: row.research_session_version_id,
    status: row.status as ResearchRunRecord['status'],
    sourcesInspected: row.sources_inspected,
    factsRetained: row.facts_retained,
    startedAt: toIso(row.started_at),
    finishedAt: toIso(row.finished_at),
    sourceOutcomes: outcomes,
    provenance: toRecordedProvenance(
      row.recorded_actor,
      row.recorded_via,
      row.correlation_id,
      row.causation_id,
      row.created_at,
    ),
  };
}
