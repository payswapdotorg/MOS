/**
 * /product-intelligence store + input guards (MKT-069).
 *
 * Owns the migration 048 tables: the agency-scoped product-context records,
 * the append-only version tail (the IMMUTABLE declared inputs — corrections
 * are NEW version records), the append-only retained source facts, the
 * append-only derived model records with their FK-anchored evidence links,
 * the append-only risk flags with their evidence links and the append-only
 * inspection run records with their per-input honest outcomes.
 *
 * The §21 material-key backstop is the SHARED /evidence guard
 * (containsMaterialKey — the /sales-continuity /decisions precedent): the
 * ONE /evidence import of this module, READ-ONLY.
 *
 * The deterministic HTML extractor (extractHtmlSourceFacts) is a PURE
 * function: the same input always produces the same facts — no clock, no
 * randomness, no network. Facts are EXTRACTED OBSERVATIONS, never
 * conclusions (architecture-v1.6.md §7).
 */

import { createHash } from 'node:crypto';
import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import { containsMaterialKey } from '../../evidence/public.ts';
import type {
  ProductContextDeclarationInput,
  ProductContextInputDeclaration,
  ProductContextInputRecord,
  ProductContextRecord,
  ProductContextVersionRecord,
  ProductDerivedModelAiAssistanceInput,
  ProductDerivedModelRecord,
  ProductIntelligenceFactKind,
  ProductIntelligenceProvenance,
  ProductIntelligenceRecordedProvenance,
  ProductInspectionInputRunRecord,
  ProductInspectionRunRecord,
  ProductRiskFlagRecord,
  ProductSourceFactRecord,
} from '../public.ts';
import {
  PRODUCT_INTELLIGENCE_AUTHORIZED_INPUT_KINDS,
  PRODUCT_INTELLIGENCE_DERIVATION_KINDS,
  PRODUCT_INTELLIGENCE_HTML_EXTRACTOR,
  PRODUCT_INTELLIGENCE_PUBLIC_INPUT_KINDS,
  PRODUCT_INTELLIGENCE_RISK_CATEGORIES,
  PRODUCT_INTELLIGENCE_RISK_SEVERITIES,
} from '../public.ts';

// ---------------------------------------------------------------------------
// Bounds (the frozen input guards — module-side mirrors of the DB fences)
// ---------------------------------------------------------------------------

export const PRODUCT_INTELLIGENCE_STATEMENT_SUMMARY_MAX = 2000 as const;
const NAME_MAX_LENGTH = 500;
const SUMMARY_MAX_LENGTH = 2000;
const REFERENCE_MAX_LENGTH = 2048;
const ACTOR_MAX_LENGTH = 100;
const MAX_INPUTS_PER_VERSION = 40;
const MAX_STATEMENT_KEYS = 16;
const MAX_STATEMENT_SERIALIZED = 8000;
const MAX_EVIDENCE_REFS = 50;
const CALL_REFERENCE_MAX_LENGTH = 500;
const MITIGATION_MAX_LENGTH = 2000;
const EXTRACTED_TEXT_MAX = 500;
const EXTRACTED_HEADING_MAX = 300;
const EXTRACTED_EXCERPT_MAX = 600;
const MAX_HEADINGS_PER_PAGE = 10;
const MAX_TEXT_EXCERPTS_PER_PAGE = 1;

// ---------------------------------------------------------------------------
// Input guards (pure — exported for unit tests + future server-side callers)
// ---------------------------------------------------------------------------

/**
 * Validates a declared product context against the frozen vocabulary +
 * bounds. The kind-compatible AUTHORIZATION fence is enforced here AND in
 * the migration-048 CHECK (defense in depth): the two public web kinds
 * carry authorization 'public' and NO connection reference; the four
 * authorized kinds carry authorization 'authorized' AND a connection
 * reference.
 */
export function assertValidProductContextDeclaration(
  declaration: ProductContextDeclarationInput,
): void {
  const problems: string[] = [];
  if (declaration === null || typeof declaration !== 'object' || Array.isArray(declaration)) {
    throw new InvalidRequestError('Invalid product context declaration', [
      'declaration: must be an object',
    ]);
  }
  if (
    declaration.name !== null &&
    (typeof declaration.name !== 'string' ||
      declaration.name.length === 0 ||
      declaration.name.length > NAME_MAX_LENGTH)
  ) {
    problems.push(`name: null or 1..${NAME_MAX_LENGTH} characters`);
  }
  if (
    declaration.summary !== null &&
    (typeof declaration.summary !== 'string' ||
      declaration.summary.length === 0 ||
      declaration.summary.length > SUMMARY_MAX_LENGTH)
  ) {
    problems.push(`summary: null or 1..${SUMMARY_MAX_LENGTH} characters`);
  }
  if (!Array.isArray(declaration.inputs) || declaration.inputs.length === 0) {
    problems.push('inputs: at least one declared input is required');
  } else {
    if (declaration.inputs.length > MAX_INPUTS_PER_VERSION) {
      problems.push(`inputs: at most ${MAX_INPUTS_PER_VERSION} per version`);
    }
    const seen = new Set<string>();
    declaration.inputs.forEach((input, index) => {
      const prefix = `inputs[${index}]`;
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        problems.push(`${prefix}: must be an object`);
        return;
      }
      const knownKind =
        (PRODUCT_INTELLIGENCE_PUBLIC_INPUT_KINDS as readonly string[]).includes(input.kind) ||
        (PRODUCT_INTELLIGENCE_AUTHORIZED_INPUT_KINDS as readonly string[]).includes(input.kind);
      if (typeof input.kind !== 'string' || !knownKind) {
        problems.push(`${prefix}.kind: unknown input kind '${String(input.kind)}'`);
      }
      if (
        typeof input.reference !== 'string' ||
        input.reference.length === 0 ||
        input.reference.length > REFERENCE_MAX_LENGTH
      ) {
        problems.push(`${prefix}.reference: 1..${REFERENCE_MAX_LENGTH} characters`);
      }
      if (input.authorization !== 'public' && input.authorization !== 'authorized') {
        problems.push(
          `${prefix}.authorization: must be 'public' or 'authorized' (got '${String(input.authorization)}')`,
        );
      }
      if (typeof input.integrationConnectionId !== 'string' && input.integrationConnectionId !== null) {
        problems.push(`${prefix}.integrationConnectionId: must be a string or null`);
      }
      // THE KIND-COMPATIBLE AUTHORIZATION FENCE (boundary rule 7).
      const isPublicKind = (PRODUCT_INTELLIGENCE_PUBLIC_INPUT_KINDS as readonly string[]).includes(
        input.kind,
      );
      const isAuthorizedKind = (
        PRODUCT_INTELLIGENCE_AUTHORIZED_INPUT_KINDS as readonly string[]
      ).includes(input.kind);
      if (isPublicKind) {
        if (input.authorization !== 'public') {
          problems.push(
            `${prefix}: the public web kind '${input.kind}' must carry authorization 'public' — public pages need no grant`,
          );
        }
        if (input.integrationConnectionId !== null) {
          problems.push(
            `${prefix}: the public web kind '${input.kind}' must not carry an integration connection reference`,
          );
        }
      } else if (isAuthorizedKind) {
        if (input.authorization !== 'authorized') {
          problems.push(
            `${prefix}: the authorized kind '${input.kind}' REQUIRES authorization 'authorized' — boundary rule 7: source-code/product inspection requires an explicit grant (rejected honestly)`,
          );
        }
        if (typeof input.integrationConnectionId !== 'string' || input.integrationConnectionId.length === 0) {
          problems.push(
            `${prefix}: the authorized kind '${input.kind}' REQUIRES a canonical integration connection reference`,
          );
        }
      }
      // The declared duplicate fence (the DB UNIQUE backstop).
      const key = `${input.kind}\u0000${input.reference}`;
      if (seen.has(key)) {
        problems.push(`${prefix}: duplicate declared input (kind, reference) '${input.kind}'`);
      }
      seen.add(key);
    });
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('Invalid product context declaration', problems);
  }
}

/**
 * SERVER-DERIVED provenance validation (the growth-missions guard): the
 * actor is a bounded labeled principal, the surface is a bounded label,
 * correlation is present — a provenance block is never caller-invented
 * free-form payload.
 */
export function assertValidProductIntelligenceProvenance(
  provenance: ProductIntelligenceProvenance,
): void {
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
    throw new InvalidRequestError('Invalid product intelligence provenance', problems);
  }
}

/**
 * Validates one derived-model recording input: the frozen derivation kind,
 * the bounded statement (a non-empty object with a REQUIRED bounded
 * summary — the CLAIM itself; §21-guarded at every nesting level), the
 * bounded unique evidence references and the AI-assistance disclosure
 * shape (model identity + call reference, all or none).
 */
export function assertValidProductDerivedModelInput(input: {
  readonly derivationKind: string;
  readonly statement: Readonly<Record<string, unknown>>;
  readonly evidenceSourceFactIds: readonly string[];
  readonly aiAssistance: ProductDerivedModelAiAssistanceInput | null;
}): void {
  const problems: string[] = [];
  if (
    typeof input.derivationKind !== 'string' ||
    !(PRODUCT_INTELLIGENCE_DERIVATION_KINDS as readonly string[]).includes(input.derivationKind)
  ) {
    problems.push(`derivationKind: must be one of the frozen §8 derivation kinds`);
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
        problems.push(
          `aiAssistance.callReference: 1..${CALL_REFERENCE_MAX_LENGTH} characters`,
        );
      }
    }
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('Invalid derived model recording', problems);
  }
}

/** Validates one risk-flag recording input (the frozen category/severity vocabularies). */
export function assertValidProductRiskFlagInput(input: {
  readonly category: string;
  readonly severity: string;
  readonly statement: Readonly<Record<string, unknown>>;
  readonly mitigation: string | null;
  readonly evidenceSourceFactIds: readonly string[];
}): void {
  const problems: string[] = [];
  if (
    typeof input.category !== 'string' ||
    !(PRODUCT_INTELLIGENCE_RISK_CATEGORIES as readonly string[]).includes(input.category)
  ) {
    problems.push('category: must be one of the frozen risk categories');
  }
  if (
    typeof input.severity !== 'string' ||
    !(PRODUCT_INTELLIGENCE_RISK_SEVERITIES as readonly string[]).includes(input.severity)
  ) {
    problems.push('severity: must be one of the frozen risk severities');
  }
  problems.push(...statementProblems(input.statement, 'statement'));
  if (
    input.mitigation !== null &&
    (typeof input.mitigation !== 'string' ||
      input.mitigation.length === 0 ||
      input.mitigation.length > MITIGATION_MAX_LENGTH)
  ) {
    problems.push(`mitigation: null or 1..${MITIGATION_MAX_LENGTH} characters`);
  }
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
  if (problems.length > 0) {
    throw new InvalidRequestError('Invalid risk flag recording', problems);
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
    summary.length > PRODUCT_INTELLIGENCE_STATEMENT_SUMMARY_MAX
  ) {
    problems.push(
      `${field}.summary: required, 1..${PRODUCT_INTELLIGENCE_STATEMENT_SUMMARY_MAX} characters`,
    );
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(statement);
  } catch {
    serialized = '';
  }
  if (serialized === '' || serialized.length > MAX_STATEMENT_SERIALIZED) {
    problems.push(`${field}: the serialized statement must stay under ${MAX_STATEMENT_SERIALIZED} characters`);
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
export function hashContent(material: string): string {
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

/** One deterministic extraction candidate (before persistence). */
export interface ExtractedFactCandidate {
  readonly factKind: ProductIntelligenceFactKind;
  readonly content: Readonly<Record<string, unknown>>;
  readonly extractionNotes: string;
}

/** Collapses whitespace and bounds a text value. */
function bound(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : collapsed.slice(0, max);
}

/**
 * THE DETERMINISTIC HTML EXTRACTOR ('html-extract-v1'): a PURE, bounded,
 * regex-based extraction of the document-head identity observations, the
 * OpenGraph observations and the first headings/excerpt of the body —
 * EXTRACTED OBSERVATIONS carried VERBATIM (never interpreted, never
 * concluded). Deterministic by construction: no clock, no randomness, no
 * network; the same input always yields the same facts in the same order.
 */
export function extractHtmlSourceFacts(html: string): readonly ExtractedFactCandidate[] {
  const facts: ExtractedFactCandidate[] = [];
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
  let headingMatch: RegExpExecArray | null;
  let headingCount = 0;
  while ((headingMatch = headingPattern.exec(head)) !== null && headingCount < MAX_HEADINGS_PER_PAGE) {
    const text = bound(headingMatch[2]!.replace(/<[^>]*>/g, ' '), EXTRACTED_HEADING_MAX);
    if (text !== '') {
      headingCount += 1;
      facts.push({
        factKind: 'heading',
        content: { level: Number(headingMatch[1]!), text },
        extractionNotes: `extracted from an h${headingMatch[1]} element, document order ${headingCount}`,
      });
    }
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
        extractionNotes: 'tag-stripped plain-text body excerpt (whitespace-collapsed, length-bounded)',
      });
    }
  }

  return facts;
}

/** The frozen extractor identity of the authorized integration reads. */
export const PRODUCT_INTELLIGENCE_READ_NOTES = 'normalized provider record observed through an authorized /integrations read, carried verbatim';

/**
 * THE SERVER-COMPUTED VERIFICATION STATE (never caller-declared):
 * ≥1 cited source fact → 'evidence_backed'; none → 'unverified'
 * (architecture-v1.6.md §7: "Model output is a claim unless backed by
 * evidence"). Exported so the discipline is part of the module contract
 * (unit-testable + the MKT-070 planner's future composition surface);
 * the migration-048 DEFERRABLE constraint trigger is the commit-time
 * backstop.
 */
export function derivedVerificationState(
  evidenceCount: number,
): 'unverified' | 'evidence_backed' {
  return evidenceCount > 0 ? 'evidence_backed' : 'unverified';
}

/**
 * Pure composition of the canonical product-context owner context from the
 * context record (the composeGrowthMissionOwnerContext precedent). Purity
 * is asserted by unit tests — the same inputs always compose the same
 * context. The agency ROW is resolved at the route layer (/agencies is not
 * a frozen allowance of this module's dependency row — the /app-metering
 * precedent); this context carries the scope identity the route layer
 * authorizes.
 */
export function composeProductContextOwnerContext(
  context: ProductContextRecord,
  resolvedAt: string,
): {
  readonly scope: {
    readonly kind: 'product-context';
    readonly agencyId: string;
    readonly productContextId: string;
  };
  readonly context: ProductContextRecord;
  readonly resolvedAt: string;
} {
  return {
    scope: {
      kind: 'product-context',
      agencyId: context.agencyId,
      productContextId: context.productContextId,
    },
    context,
    resolvedAt,
  };
}

// ---------------------------------------------------------------------------
// Row shapes (snake_case DB rows)
// ---------------------------------------------------------------------------

interface ContextRow extends DbRow {
  product_context_id: string;
  agency_id: string;
  current_version_seq: number;
  version: number;
  created_actor: string;
  created_at: Date;
  updated_at: Date;
}

interface VersionRow extends DbRow {
  product_context_version_id: string;
  product_context_id: string;
  version_seq: number;
  name: string | null;
  summary: string | null;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
}

interface InputRow extends DbRow {
  input_id: string;
  product_context_version_id: string;
  kind: string;
  reference: string;
  authorization_state: string;
  integration_connection_id: string | null;
  position: number;
}

interface FactRow extends DbRow {
  source_fact_id: string;
  product_context_id: string;
  product_context_version_id: string;
  input_id: string;
  inspection_run_id: string;
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

interface DerivedRow extends DbRow {
  derived_model_id: string;
  product_context_id: string;
  derivation_kind: string;
  statement: Record<string, unknown>;
  verification_state: string;
  supersedes_derived_model_id: string | null;
  ai_model_registry_id: string | null;
  ai_model_display: string | null;
  ai_call_reference: string | null;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
}

interface RiskRow extends DbRow {
  risk_flag_id: string;
  product_context_id: string;
  category: string;
  severity: string;
  statement: Record<string, unknown>;
  mitigation: string | null;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
}

interface RunRow extends DbRow {
  inspection_run_id: string;
  product_context_id: string;
  product_context_version_id: string;
  status: string;
  inputs_inspected: number;
  facts_retained: number;
  started_at: Date;
  finished_at: Date;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
}

interface InputRunRow extends DbRow {
  inspection_input_run_id: string;
  inspection_run_id: string;
  input_id: string;
  outcome: string;
  detail: string | null;
  facts_extracted: number;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** One retained-fact append command (composed by the module's inspection). */
export interface AppendSourceFactInput {
  readonly sourceFactId: string;
  readonly productContextId: string;
  readonly productContextVersionId: string;
  readonly inputId: string;
  readonly inspectionRunId: string;
  readonly factKind: ProductIntelligenceFactKind;
  readonly sourceRef: string;
  readonly fetchedAt: string;
  readonly extractor: string;
  readonly contentHash: string;
  readonly extractionNotes: string | null;
  readonly content: Readonly<Record<string, unknown>>;
  readonly provenance: ProductIntelligenceProvenance;
}

export class ProductIntelligenceStore {
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

  // --- product context record ---

  async insertContext(input: {
    readonly productContextId: string;
    readonly agencyId: string;
    readonly createdActor: string;
    readonly now: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO product_contexts (product_context_id, agency_id, current_version_seq, version,
                                      created_actor, created_at, updated_at)
       VALUES ($1, $2, 1, 1, $3, $4, $4)`,
      [input.productContextId, input.agencyId, input.createdActor, input.now],
    );
  }

  async getContext(productContextId: string): Promise<ProductContextRecord | null> {
    const result = await this.db.query<ContextRow>(`${CONTEXT_SELECT} WHERE product_context_id = $1`, [
      productContextId,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : toContextRecord(row);
  }

  async listContextsForAgency(agencyId: string): Promise<readonly ProductContextRecord[]> {
    const result = await this.db.query<ContextRow>(
      `${CONTEXT_SELECT} WHERE agency_id = $1 ORDER BY created_at, product_context_id`,
      [agencyId],
    );
    return result.rows.map(toContextRecord);
  }

  /** Locks the context row (FOR UPDATE) — every mutation is serialized. */
  async lockContext(
    tx: DbTransaction,
    productContextId: string,
  ): Promise<ProductContextRecord | null> {
    const result = await tx.query<ContextRow>(`${CONTEXT_SELECT} WHERE product_context_id = $1 FOR UPDATE`, [
      productContextId,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : toContextRecord(row);
  }

  async advanceContextVersionRow(tx: DbTransaction, input: {
    readonly productContextId: string;
    readonly versionSeq: number;
    readonly expectedVersion: number;
  }): Promise<'ok' | 'lost'> {
    const result = await tx.query(
      `UPDATE product_contexts
          SET current_version_seq = $2, version = version + 1, updated_at = $3
        WHERE product_context_id = $1 AND version = $4`,
      [input.productContextId, input.versionSeq, this.now(), input.expectedVersion],
    );
    return result.rowCount === 1 ? 'ok' : 'lost';
  }

  async countVersions(tx: DbTransaction, productContextId: string): Promise<number> {
    const result = await tx.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM product_context_versions WHERE product_context_id = $1`,
      [productContextId],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  // --- version tail + declared inputs ---

  async insertVersion(tx: DbTransaction, input: {
    readonly productContextVersionId: string;
    readonly productContextId: string;
    readonly versionSeq: number;
    readonly declaration: ProductContextDeclarationInput;
    readonly provenance: ProductIntelligenceProvenance;
  }): Promise<void> {
    await tx.query(
      `INSERT INTO product_context_versions (product_context_version_id, product_context_id, version_seq,
                                               name, summary, recorded_actor, recorded_via,
                                               correlation_id, causation_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        input.productContextVersionId,
        input.productContextId,
        input.versionSeq,
        input.declaration.name,
        input.declaration.summary,
        input.provenance.actor,
        input.provenance.recordedVia,
        input.provenance.correlationId,
        input.provenance.causationId,
        this.now(),
      ],
    );
    await this.insertInputs(tx, input.productContextVersionId, input.declaration.inputs);
  }

  private async insertInputs(
    tx: DbTransaction,
    productContextVersionId: string,
    inputs: readonly ProductContextInputDeclaration[],
  ): Promise<void> {
    for (const [index, input] of inputs.entries()) {
      await tx.query(
        `INSERT INTO product_context_inputs (input_id, product_context_version_id, kind, reference,
                                              authorization_state, integration_connection_id, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          this.ids.newId(),
          productContextVersionId,
          input.kind,
          input.reference,
          input.authorization,
          input.integrationConnectionId,
          index + 1,
        ],
      );
    }
  }

  async listVersions(productContextId: string): Promise<ProductContextVersionRecord[]> {
    const [versionRows, inputRows] = await Promise.all([
      this.db.query<VersionRow>(
        `SELECT * FROM product_context_versions WHERE product_context_id = $1
          ORDER BY version_seq`,
        [productContextId],
      ),
      this.db.query<InputRow>(
        `SELECT i.* FROM product_context_inputs i
           JOIN product_context_versions v ON v.product_context_version_id = i.product_context_version_id
          WHERE v.product_context_id = $1
          ORDER BY i.position`,
        [productContextId],
      ),
    ]);
    return versionRows.rows.map((row) => {
      const inputs = inputRows.rows
        .filter((input) => input.product_context_version_id === row.product_context_version_id)
        .map(toInputRecord);
      return toVersionRecord(row, inputs);
    });
  }

  async getVersionBySeq(
    tx: DbTransaction,
    productContextId: string,
    versionSeq: number,
  ): Promise<ProductContextVersionRecord | null> {
    const versionRows = await tx.query<VersionRow>(
      `SELECT * FROM product_context_versions WHERE product_context_id = $1 AND version_seq = $2`,
      [productContextId, versionSeq],
    );
    const row = versionRows.rows[0];
    if (row === undefined) return null;
    const inputRows = await tx.query<InputRow>(
      `SELECT * FROM product_context_inputs WHERE product_context_version_id = $1 ORDER BY position`,
      [row.product_context_version_id],
    );
    return toVersionRecord(row, inputRows.rows.map(toInputRecord));
  }

  // --- inspection runs ---

  async insertInspectionRun(tx: DbTransaction, input: {
    readonly inspectionRunId: string;
    readonly productContextId: string;
    readonly productContextVersionId: string;
    readonly status: string;
    readonly inputsInspected: number;
    readonly factsRetained: number;
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly provenance: ProductIntelligenceProvenance;
  }): Promise<void> {
    await tx.query(
      `INSERT INTO product_inspection_runs (inspection_run_id, product_context_id,
                                             product_context_version_id, status, inputs_inspected,
                                             facts_retained, started_at, finished_at,
                                             recorded_actor, recorded_via, correlation_id,
                                             causation_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        input.inspectionRunId,
        input.productContextId,
        input.productContextVersionId,
        input.status,
        input.inputsInspected,
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

  async insertInspectionInputRun(tx: DbTransaction, input: {
    readonly inspectionRunId: string;
    readonly inputId: string;
    readonly outcome: string;
    readonly detail: string | null;
    readonly factsExtracted: number;
  }): Promise<void> {
    await tx.query(
      `INSERT INTO product_inspection_input_runs (inspection_input_run_id, inspection_run_id,
                                                    input_id, outcome, detail, facts_extracted, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        this.ids.newId(),
        input.inspectionRunId,
        input.inputId,
        input.outcome,
        input.detail,
        input.factsExtracted,
        this.now(),
      ],
    );
  }

  async listInspectionRuns(productContextId: string): Promise<ProductInspectionRunRecord[]> {
    const [runRows, inputRunRows] = await Promise.all([
      this.db.query<RunRow>(
        `SELECT * FROM product_inspection_runs WHERE product_context_id = $1
          ORDER BY created_at, inspection_run_id`,
        [productContextId],
      ),
      this.db.query<InputRunRow>(
        `SELECT r.* FROM product_inspection_input_runs r
           JOIN product_inspection_runs s ON s.inspection_run_id = r.inspection_run_id
          WHERE s.product_context_id = $1
          ORDER BY r.created_at, r.inspection_input_run_id`,
        [productContextId],
      ),
    ]);
    return runRows.rows.map((row) => {
      const outcomes = inputRunRows.rows
        .filter((inputRun) => inputRun.inspection_run_id === row.inspection_run_id)
        .map(toInputRunRecord);
      return toRunRecord(row, outcomes);
    });
  }

  // --- retained source facts ---

  async insertSourceFact(tx: DbTransaction, input: AppendSourceFactInput): Promise<void> {
    await tx.query(
      `INSERT INTO product_source_facts (source_fact_id, product_context_id, product_context_version_id,
                                          input_id, inspection_run_id, fact_kind, source_ref, fetched_at,
                                          extractor, content_hash, extraction_notes, content,
                                          recorded_actor, recorded_via, correlation_id, causation_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        input.sourceFactId,
        input.productContextId,
        input.productContextVersionId,
        input.inputId,
        input.inspectionRunId,
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

  async listSourceFacts(productContextId: string): Promise<ProductSourceFactRecord[]> {
    const result = await this.db.query<FactRow>(
      `SELECT * FROM product_source_facts WHERE product_context_id = $1
        ORDER BY created_at, source_fact_id`,
      [productContextId],
    );
    return result.rows.map(toFactRecord);
  }

  async getSourceFact(sourceFactId: string): Promise<ProductSourceFactRecord | null> {
    const result = await this.db.query<FactRow>(`SELECT * FROM product_source_facts WHERE source_fact_id = $1`, [
      sourceFactId,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : toFactRecord(row);
  }

  async countSourceFactsForContext(productContextId: string): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM product_source_facts WHERE product_context_id = $1`,
      [productContextId],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  // --- derived models ---

  async insertDerivedModel(tx: DbTransaction, input: {
    readonly derivedModelId: string;
    readonly productContextId: string;
    readonly derivationKind: string;
    readonly statement: Readonly<Record<string, unknown>>;
    readonly verificationState: string;
    readonly supersedesDerivedModelId: string | null;
    readonly aiModelRegistryId: string | null;
    readonly aiModelDisplay: string | null;
    readonly aiCallReference: string | null;
    readonly provenance: ProductIntelligenceProvenance;
  }): Promise<void> {
    await tx.query(
      `INSERT INTO product_derived_models (derived_model_id, product_context_id, derivation_kind,
                                            statement, verification_state, supersedes_derived_model_id,
                                            ai_model_registry_id, ai_model_display, ai_call_reference,
                                            recorded_actor, recorded_via, correlation_id, causation_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        input.derivedModelId,
        input.productContextId,
        input.derivationKind,
        JSON.stringify(input.statement),
        input.verificationState,
        input.supersedesDerivedModelId,
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

  async insertDerivedModelEvidence(tx: DbTransaction, input: {
    readonly derivedModelId: string;
    readonly sourceFactIds: readonly string[];
  }): Promise<void> {
    for (const [index, sourceFactId] of input.sourceFactIds.entries()) {
      await tx.query(
        `INSERT INTO product_derived_model_evidence (derived_model_id, source_fact_id, position)
         VALUES ($1, $2, $3)`,
        [input.derivedModelId, sourceFactId, index + 1],
      );
    }
  }

  async listDerivedModels(productContextId: string): Promise<ProductDerivedModelRecord[]> {
    const [modelRows, evidenceRows, supersededBy] = await Promise.all([
      this.db.query<DerivedRow>(
        `SELECT * FROM product_derived_models WHERE product_context_id = $1
          ORDER BY created_at, derived_model_id`,
        [productContextId],
      ),
      this.db.query<{ derived_model_id: string; source_fact_id: string }>(
        `SELECT e.derived_model_id, e.source_fact_id FROM product_derived_model_evidence e
           JOIN product_derived_models m ON m.derived_model_id = e.derived_model_id
          WHERE m.product_context_id = $1
          ORDER BY e.derived_model_id, e.position`,
        [productContextId],
      ),
      this.db.query<{ supersedes_derived_model_id: string; superseded_by: string }>(
        `SELECT supersedes_derived_model_id, derived_model_id AS superseded_by
           FROM product_derived_models
          WHERE product_context_id = $1 AND supersedes_derived_model_id IS NOT NULL`,
        [productContextId],
      ),
    ]);
    const supersededByMap = new Map(
      supersededBy.rows.map((row) => [row.supersedes_derived_model_id, row.superseded_by]),
    );
    return modelRows.rows.map((row) => {
      const evidence = evidenceRows.rows
        .filter((link) => link.derived_model_id === row.derived_model_id)
        .map((link) => link.source_fact_id);
      return toDerivedRecord(row, evidence, supersededByMap.get(row.derived_model_id) ?? null);
    });
  }

  async getDerivedModelById(derivedModelId: string): Promise<ProductDerivedModelRecord | null> {
    const modelRows = await this.db.query<DerivedRow>(
      `SELECT * FROM product_derived_models WHERE derived_model_id = $1`,
      [derivedModelId],
    );
    const row = modelRows.rows[0];
    if (row === undefined) return null;
    const [evidenceRows, supersededBy] = await Promise.all([
      this.db.query<{ source_fact_id: string }>(
        `SELECT source_fact_id FROM product_derived_model_evidence
          WHERE derived_model_id = $1 ORDER BY position`,
        [derivedModelId],
      ),
      this.db.query<{ superseded_by: string }>(
        `SELECT derived_model_id AS superseded_by FROM product_derived_models
          WHERE supersedes_derived_model_id = $1`,
        [derivedModelId],
      ),
    ]);
    return toDerivedRecord(
      row,
      evidenceRows.rows.map((link) => link.source_fact_id),
      supersededBy.rows[0]?.superseded_by ?? null,
    );
  }

  // --- risk flags ---

  async insertRiskFlag(tx: DbTransaction, input: {
    readonly riskFlagId: string;
    readonly productContextId: string;
    readonly category: string;
    readonly severity: string;
    readonly statement: Readonly<Record<string, unknown>>;
    readonly mitigation: string | null;
    readonly provenance: ProductIntelligenceProvenance;
  }): Promise<void> {
    await tx.query(
      `INSERT INTO product_risk_flags (risk_flag_id, product_context_id, category, severity,
                                        statement, mitigation, recorded_actor, recorded_via,
                                        correlation_id, causation_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        input.riskFlagId,
        input.productContextId,
        input.category,
        input.severity,
        JSON.stringify(input.statement),
        input.mitigation,
        input.provenance.actor,
        input.provenance.recordedVia,
        input.provenance.correlationId,
        input.provenance.causationId,
        this.now(),
      ],
    );
  }

  async insertRiskFlagEvidence(tx: DbTransaction, input: {
    readonly riskFlagId: string;
    readonly sourceFactIds: readonly string[];
  }): Promise<void> {
    for (const [index, sourceFactId] of input.sourceFactIds.entries()) {
      await tx.query(
        `INSERT INTO product_risk_flag_evidence (risk_flag_id, source_fact_id, position)
         VALUES ($1, $2, $3)`,
        [input.riskFlagId, sourceFactId, index + 1],
      );
    }
  }

  async listRiskFlags(productContextId: string): Promise<ProductRiskFlagRecord[]> {
    const [riskRows, evidenceRows] = await Promise.all([
      this.db.query<RiskRow>(
        `SELECT * FROM product_risk_flags WHERE product_context_id = $1
          ORDER BY created_at, risk_flag_id`,
        [productContextId],
      ),
      this.db.query<{ risk_flag_id: string; source_fact_id: string }>(
        `SELECT e.risk_flag_id, e.source_fact_id FROM product_risk_flag_evidence e
           JOIN product_risk_flags f ON f.risk_flag_id = e.risk_flag_id
          WHERE f.product_context_id = $1
          ORDER BY e.risk_flag_id, e.position`,
        [productContextId],
      ),
    ]);
    return riskRows.rows.map((row) => {
      const evidence = evidenceRows.rows
        .filter((link) => link.risk_flag_id === row.risk_flag_id)
        .map((link) => link.source_fact_id);
      return toRiskRecord(row, evidence);
    });
  }

  async getRiskFlagById(riskFlagId: string): Promise<ProductRiskFlagRecord | null> {
    const riskRows = await this.db.query<RiskRow>(
      `SELECT * FROM product_risk_flags WHERE risk_flag_id = $1`,
      [riskFlagId],
    );
    const row = riskRows.rows[0];
    if (row === undefined) return null;
    const evidenceRows = await this.db.query<{ source_fact_id: string }>(
      `SELECT source_fact_id FROM product_risk_flag_evidence WHERE risk_flag_id = $1 ORDER BY position`,
      [riskFlagId],
    );
    return toRiskRecord(
      row,
      evidenceRows.rows.map((link) => link.source_fact_id),
    );
  }
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

const CONTEXT_SELECT = `SELECT product_context_id, agency_id, current_version_seq, version,
                               created_actor, created_at, updated_at
                          FROM product_contexts`;

function toIso(value: Date): string {
  return value.toISOString();
}

function toContextRecord(row: ContextRow): ProductContextRecord {
  return {
    productContextId: row.product_context_id,
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
): ProductIntelligenceRecordedProvenance {
  return {
    actor,
    recordedVia,
    correlationId,
    causationId,
    recordedAt: toIso(recordedAt),
  };
}

function toInputRecord(row: InputRow): ProductContextInputRecord {
  return {
    inputId: row.input_id,
    productContextVersionId: row.product_context_version_id,
    kind: row.kind as ProductContextInputRecord['kind'],
    reference: row.reference,
    authorization: row.authorization_state as ProductContextInputRecord['authorization'],
    integrationConnectionId: row.integration_connection_id,
    position: row.position,
  };
}

function toVersionRecord(row: VersionRow, inputs: readonly ProductContextInputRecord[]): ProductContextVersionRecord {
  return {
    productContextVersionId: row.product_context_version_id,
    productContextId: row.product_context_id,
    versionSeq: row.version_seq,
    name: row.name,
    summary: row.summary,
    inputs,
    provenance: toRecordedProvenance(
      row.recorded_actor,
      row.recorded_via,
      row.correlation_id,
      row.causation_id,
      row.created_at,
    ),
  };
}

function toFactRecord(row: FactRow): ProductSourceFactRecord {
  return {
    sourceFactId: row.source_fact_id,
    productContextId: row.product_context_id,
    productContextVersionId: row.product_context_version_id,
    inputId: row.input_id,
    inspectionRunId: row.inspection_run_id,
    factKind: row.fact_kind as ProductSourceFactRecord['factKind'],
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

function toDerivedRecord(
  row: DerivedRow,
  evidence: readonly string[],
  supersededBy: string | null,
): ProductDerivedModelRecord {
  return {
    derivedModelId: row.derived_model_id,
    productContextId: row.product_context_id,
    derivationKind: row.derivation_kind as ProductDerivedModelRecord['derivationKind'],
    statement: row.statement,
    verificationState: row.verification_state as ProductDerivedModelRecord['verificationState'],
    supersedesDerivedModelId: row.supersedes_derived_model_id,
    supersededByDerivedModelId: supersededBy,
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

function toRiskRecord(row: RiskRow, evidence: readonly string[]): ProductRiskFlagRecord {
  return {
    riskFlagId: row.risk_flag_id,
    productContextId: row.product_context_id,
    category: row.category as ProductRiskFlagRecord['category'],
    severity: row.severity as ProductRiskFlagRecord['severity'],
    statement: row.statement,
    mitigation: row.mitigation,
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

function toInputRunRecord(row: InputRunRow): ProductInspectionInputRunRecord {
  return {
    inspectionInputRunId: row.inspection_input_run_id,
    inspectionRunId: row.inspection_run_id,
    inputId: row.input_id,
    outcome: row.outcome as ProductInspectionInputRunRecord['outcome'],
    detail: row.detail,
    factsExtracted: row.facts_extracted,
  };
}

function toRunRecord(row: RunRow, outcomes: readonly ProductInspectionInputRunRecord[]): ProductInspectionRunRecord {
  return {
    inspectionRunId: row.inspection_run_id,
    productContextId: row.product_context_id,
    productContextVersionId: row.product_context_version_id,
    status: row.status as ProductInspectionRunRecord['status'],
    inputsInspected: row.inputs_inspected,
    factsRetained: row.facts_retained,
    startedAt: toIso(row.started_at),
    finishedAt: toIso(row.finished_at),
    inputOutcomes: outcomes,
    provenance: toRecordedProvenance(
      row.recorded_actor,
      row.recorded_via,
      row.correlation_id,
      row.causation_id,
      row.created_at,
    ),
  };
}

/** The frozen extractor identities re-exported for the module's fact stamps. */
export { PRODUCT_INTELLIGENCE_HTML_EXTRACTOR };
