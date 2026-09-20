/**
 * The deterministic source extractors of the /product-intelligence
 * inspection pipeline (MKT-069, AC-2).
 *
 * Extractors are PURE functions: the same fetched content ALWAYS yields
 * the same observation, the same extraction notes and the same content
 * hash — the inspection pipeline is deterministic by construction. The
 * extracted payload is an OBSERVATION (what the source contains), never a
 * conclusion (what the source means) — conclusions live only in derived
 * model records, where they must cite source facts as backing (§7:
 * "Model output is a claim unless backed by evidence.").
 *
 * The extractor identities are VERSIONED LABELS (the am-meter-v1
 * discipline): a change to an extraction rule is a NEW label so retained
 * facts always name the exact extractor that produced them.
 */

import { createHash } from 'node:crypto';

/** The site-page extractor identity (public product/site pages). */
export const SITE_PAGE_EXTRACTOR_ID = 'site-page-extractor-v1' as const;

/** The integration-record extractor identity (authorized reads). */
export const INTEGRATION_RECORD_EXTRACTOR_ID = 'integration-record-extractor-v1' as const;

/** Bounded observation sizes (the retained payload stays bounded). */
const TITLE_MAX = 300;
const META_MAX = 500;
const HEADING_MAX = 200;
const HEADINGS_MAX = 20;
const LINKS_MAX = 20;
const TEXT_PREVIEW_MAX = 500;
const NOTES_MAX = 2000;

/** The maximum accepted source body (mirrors the fetcher's size cap). */
export const SOURCE_BODY_MAX_BYTES = 262_144;

/**
 * The sha-256 content hash of a fetched source body (hex, 64 chars) —
 * the deterministic fingerprint retained on every source fact.
 */
export function hashContent(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/** Canonical JSON serialization (stable key order — deterministic hashing). */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Clips a string to a bounded prefix. */
function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/** Extracts the first regex match group (clipped) or null. */
function firstMatch(content: string, pattern: RegExp): string | null {
  const match = content.match(pattern);
  return match === null ? null : clip(match[1]!.trim(), pattern === META_DESCRIPTION_PATTERN ? META_MAX : TITLE_MAX);
}

const TITLE_PATTERN = /<title[^>]*>([\s\S]*?)<\/title>/i;
const META_DESCRIPTION_PATTERN =
  /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i;
const META_DESCRIPTION_PATTERN_2 =
  /<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i;
const CANONICAL_URL_PATTERN = /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']*)["']/i;

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export interface SiteObservation {
  /** The page's <title> (clipped) or null. */
  readonly title: string | null;
  /** The page's meta description (clipped) or null. */
  readonly metaDescription: string | null;
  /** The page's canonical URL hint or null. */
  readonly canonicalUrl: string | null;
  /** Up to 20 h1/h2 heading texts (clipped), document order. */
  readonly headings: readonly string[];
  /** Up to 20 href targets, document order. */
  readonly links: readonly string[];
  /** The count of <a> anchors on the page. */
  readonly linkCount: number;
  /** A bounded tag-stripped text preview. */
  readonly textPreview: string;
  /** The byte length of the fetched body. */
  readonly bodyBytes: number;
}

/**
 * The deterministic site-page extraction (AC-2): bounded structural
 * observations from the fetched HTML/text content — never an
 * interpretation. Pure: the same content always yields the same
 * observation.
 */
export function extractSiteObservation(body: string): SiteObservation {
  const title = firstMatch(body, TITLE_PATTERN);
  const metaDescription =
    firstMatch(body, META_DESCRIPTION_PATTERN) ?? firstMatch(body, META_DESCRIPTION_PATTERN_2);
  const canonicalUrl = firstMatch(body, CANONICAL_URL_PATTERN);

  const headings: string[] = [];
  for (const match of body.matchAll(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi)) {
    const text = collapseWhitespace(decodeEntities(match[1]!.replace(/<[^>]+>/g, ' ')));
    if (text !== '') headings.push(clip(text, HEADING_MAX));
    if (headings.length >= HEADINGS_MAX) break;
  }

  const links: string[] = [];
  let linkCount = 0;
  for (const match of body.matchAll(/<a[^>]+href=["']([^"'#\s]+)["']/gi)) {
    linkCount += 1;
    if (links.length < LINKS_MAX) links.push(clip(match[1]!, META_MAX));
  }

  const textPreview = clip(
    collapseWhitespace(decodeEntities(body.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '))),
    TEXT_PREVIEW_MAX,
  );

  return {
    title,
    metaDescription,
    canonicalUrl,
    headings,
    links,
    linkCount,
    textPreview,
    bodyBytes: Buffer.byteLength(body, 'utf8'),
  };
}

/** The extraction notes for a site-page observation (honest annotations). */
export function siteExtractionNotes(contentType: string | null): string {
  const type = contentType === null ? 'unknown' : clip(contentType, 100);
  return clip(`site page observation; content-type=${type}`, NOTES_MAX);
}

/** The extraction notes for an authorized integration record read. */
export function integrationRecordExtractionNotes(
  providerRecordId: string,
  etag: string | null,
  sourceVersion: string | null,
): string {
  const parts = [
    `authorized read record ${clip(providerRecordId, 100)}`,
    etag === null ? null : `etag=${clip(etag, 100)}`,
    sourceVersion === null ? null : `sourceVersion=${clip(sourceVersion, 100)}`,
  ].filter((part): part is string => part !== null);
  return clip(parts.join('; '), NOTES_MAX);
}

/**
 * The observation payload retained for one authorized integration record
 * (deterministic: the record's own data, verbatim) plus its content hash
 * over the canonical JSON of the record data.
 */
export function integrationRecordObservation(
  record: {
    readonly providerRecordId: string;
    readonly data: Readonly<Record<string, unknown>>;
    readonly sourceTimestamp: string | null;
    readonly etag: string | null;
    readonly sourceVersion: string | null;
  },
): {
  readonly observation: Readonly<Record<string, unknown>>;
  readonly contentHash: string;
} {
  const observation: Record<string, unknown> = {
    providerRecordId: record.providerRecordId,
    data: record.data,
    sourceTimestamp: record.sourceTimestamp,
    etag: record.etag,
    sourceVersion: record.sourceVersion,
  };
  return {
    observation,
    contentHash: hashContent(canonicalJson(observation)),
  };
}
