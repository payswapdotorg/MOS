/**
 * The FIRST-PARTY /lab-features extractor (LAB-003) — the honest
 * deterministic implementation of the LabFeatureExtractor port.
 *
 * HONEST ABOUT WHAT IT CAN AND CANNOT EXTRACT (the /platform-health
 * observable-signals-only discipline applied to feature extraction):
 *
 *   - DETERMINISTICALLY DERIVED (encoder identity honestly labeled as
 *     a deterministic extractor, never an embedding model):
 *       * duration                    — from the recorded snapshot's
 *                                       duration field, when present;
 *       * engagement                  — from the recorded snapshot's
 *                                       engagement counters, when present;
 *       * retention_impression_metrics — from the recorded snapshot's
 *                                       retention/impression fields, when
 *                                       present ("where available", §5);
 *       * product_references          — from the recorded snapshot's
 *                                       EXPLICIT product/tagged-product
 *                                       fields, when present (never
 *                                       guessed from free text);
 *       * language                    — from the recorded snapshot's
 *                                       declared language field, when
 *                                       present (a provider-declared
 *                                       observation, never a detected
 *                                       guess);
 *       * title_description_hashtag_semantics — the DETERMINISTIC
 *                                       LEXICAL representation of the
 *                                       recorded title/description
 *                                       text (character counts, the
 *                                       frozen whitespace tokenization,
 *                                       the extracted hashtag list) —
 *                                       a lexical bag, honestly labeled
 *                                       'lab-features-lexical', NEVER
 *                                       an embedding or a semantic
 *                                       claim.
 *   - HONESTLY UNAVAILABLE (the closed reasons, never fabricated):
 *       * the embedding-grade features (visual_embedding,
 *         audio_embedding, text_embedding) and the semantic
 *         structures (hook/topic/problem/curiosity/narrative/
 *         information-density/CTA) — 'encoder_unavailable' until a
 *         real encoder is wired through the port;
 *       * the media-grade features with no granted path
 *         (thumbnail/opening-frame/pacing/scene-transitions/visual-
 *         composition/speaking-rate/emotional-trajectory) —
 *         'requires_media_access' when no validated grant opened the
 *         provider/rights-gated path; 'encoder_unavailable' when a
 *         path opened but no decoder/encoder is wired in this
 *         extractor version;
 *       * performance_velocity / age_normalized_performance /
 *         creator_baseline — 'requires_observation_history' (a single
 *         cited metadata snapshot cannot express an observation time
 *         series or a creator's history);
 *       * novelty_reuse_risk — 'requires_corpus_context' (corpus-wide
 *         novelty measurement is the LAB-004 Idea Graph layer, not a
 *         single-reference extraction).
 *
 * The derivation is a PURE FUNCTION of the cited metadata snapshot
 * (+ the media-path record): the same input always produces the same
 * values (the reproducible-identity discipline). Wrong-typed
 * snapshot fields are treated as ABSENT (the honest coarse
 * interpretation — a wrong-typed field is not evidence, disclosed).
 */

import type {
  LabFeatureEncoderIdentity,
  LabFeatureExtractionFailure,
  LabFeatureExtractionInput,
  LabFeatureExtractionResult,
  LabFeatureExtractor,
  LabFeatureKey,
  LabFeatureUnavailableReason,
  LabFeatureValue,
  LabFeatureValueMap,
  LabFeatureModality,
} from '../public.ts';
import { LAB_FEATURE_KEY_LIST, LAB_FEATURE_SET_VERSION } from '../public.ts';

/** The first-party extractor identity (part of the deterministic bundle identity). */
export const FIRST_PARTY_EXTRACTOR_ID = 'lab-first-party-metadata' as const;
export const FIRST_PARTY_EXTRACTOR_VERSION = '1' as const;

/** The deterministic encoder identities (honestly labeled — NOT embedding models). */
const METADATA_ENCODER = { encoderId: 'lab-features-metadata', encoderVersion: '1' } as const;
const LEXICAL_ENCODER = { encoderId: 'lab-features-lexical', encoderVersion: '1' } as const;

/** The closed modality groups the first-party extractor has derivation logic for. */
const SUPPORTED_MODALITIES: ReadonlyArray<LabFeatureModality> = ['metadata', 'text'];

/** The encoder-grade keys (no real encoder is wired in this version). */
const ENCODER_GRADE_KEYS: ReadonlySet<LabFeatureKey> = new Set([
  'visual_embedding',
  'audio_embedding',
  'text_embedding',
  'hook_structure',
  'topic_subtopic_entity',
  'problem_claim',
  'curiosity_gap',
  'narrative_structure',
  'information_density',
  'cta_structure',
]);

/** The media-grade keys (need permitted media bytes AND a wired decoder). */
const MEDIA_GRADE_KEYS: ReadonlySet<LabFeatureKey> = new Set([
  'thumbnail_representation',
  'opening_frame_representation',
  'pacing',
  'scene_transitions',
  'visual_composition',
  'speaking_rate',
  'emotional_trajectory',
]);

/** The observation-history-grade keys (a single snapshot cannot express them). */
const HISTORY_GRADE_KEYS: ReadonlySet<LabFeatureKey> = new Set([
  'performance_velocity',
  'age_normalized_performance',
  'creator_baseline',
]);

const UNAVAILABLE_DETAIL: Readonly<Record<LabFeatureUnavailableReason, string>> = {
  encoder_unavailable: 'no encoder is wired for this feature in extractor lab-first-party-metadata v1',
  absent_from_source: 'the recorded metadata snapshot carries no field this feature can derive from',
  requires_media_access: 'this feature requires media bytes; no validated media-access grant opened the path',
  requires_observation_history:
    'this feature requires an observation time series; a single cited metadata snapshot cannot express it',
  requires_corpus_context: 'this feature requires corpus-wide context owned by the LAB-004 Idea Graph layer',
};

function unavailable(reason: LabFeatureUnavailableReason): LabFeatureValue {
  return { state: 'unavailable', reason, detail: UNAVAILABLE_DETAIL[reason] };
}

function derived(value: unknown, encoder: LabFeatureEncoderIdentity): LabFeatureValue {
  return { state: 'derived', encoder, value };
}

// ---------------------------------------------------------------------------
// The deterministic snapshot derivations (pure, total — wrong-typed
// fields are treated as absent, disclosed).
// ---------------------------------------------------------------------------

function snapshotNumber(snapshot: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const raw = snapshot[key];
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  return undefined;
}

function snapshotString(snapshot: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const raw = snapshot[key];
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  return undefined;
}

/** duration — from the recorded snapshot's duration field (seconds), when present and well-formed. */
function deriveDuration(snapshot: Readonly<Record<string, unknown>>): LabFeatureValue {
  const seconds =
    snapshotNumber(snapshot, 'durationSeconds') ??
    (snapshotNumber(snapshot, 'durationMs') !== undefined
      ? snapshotNumber(snapshot, 'durationMs')! / 1000
      : undefined);
  if (seconds === undefined || seconds < 0) return unavailable('absent_from_source');
  return derived({ sourceField: seconds >= 0 && snapshot['durationSeconds'] !== undefined ? 'durationSeconds' : 'durationMs', valueSeconds: Math.round(seconds * 1000) / 1000 }, METADATA_ENCODER);
}

/** engagement — from the recorded snapshot's engagement counters, when present. */
function deriveEngagement(snapshot: Readonly<Record<string, unknown>>): LabFeatureValue {
  const views = snapshotNumber(snapshot, 'viewCount');
  const likes = snapshotNumber(snapshot, 'likeCount');
  const comments = snapshotNumber(snapshot, 'commentCount');
  const shares = snapshotNumber(snapshot, 'shareCount');
  if (views === undefined && likes === undefined && comments === undefined && shares === undefined) {
    return unavailable('absent_from_source');
  }
  const counters: Record<string, number> = {};
  if (views !== undefined) counters.viewCount = views;
  if (likes !== undefined) counters.likeCount = likes;
  if (comments !== undefined) counters.commentCount = comments;
  if (shares !== undefined) counters.shareCount = shares;
  return derived({ sourceFields: Object.keys(counters), counters }, METADATA_ENCODER);
}

/** retention/impression metrics — from the recorded snapshot's retention/impression fields, when present ("where available", §5). */
function deriveRetentionImpression(snapshot: Readonly<Record<string, unknown>>): LabFeatureValue {
  const impressions = snapshotNumber(snapshot, 'impressionCount');
  const averageViewPercentage = snapshotNumber(snapshot, 'averageViewPercentage');
  const averageViewSeconds = snapshotNumber(snapshot, 'averageViewSeconds');
  if (
    impressions === undefined &&
    averageViewPercentage === undefined &&
    averageViewSeconds === undefined
  ) {
    return unavailable('absent_from_source');
  }
  const metrics: Record<string, number> = {};
  if (impressions !== undefined) metrics.impressionCount = impressions;
  if (averageViewPercentage !== undefined) metrics.averageViewPercentage = averageViewPercentage;
  if (averageViewSeconds !== undefined) metrics.averageViewSeconds = averageViewSeconds;
  return derived({ sourceFields: Object.keys(metrics), metrics }, METADATA_ENCODER);
}

/** product references — from the recorded snapshot's EXPLICIT product fields, when present (never guessed from free text). */
function deriveProductReferences(snapshot: Readonly<Record<string, unknown>>): LabFeatureValue {
  const raw = snapshot['products'] ?? snapshot['taggedProducts'];
  if (!Array.isArray(raw) || raw.length === 0) return unavailable('absent_from_source');
  const references: Array<Record<string, unknown>> = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const name = typeof record['name'] === 'string' && record['name'].trim().length > 0 ? record['name'].trim() : null;
    const id = typeof record['id'] === 'string' && record['id'].trim().length > 0 ? record['id'].trim() : null;
    const url = typeof record['url'] === 'string' && record['url'].trim().length > 0 ? record['url'].trim() : null;
    if (name === null && id === null && url === null) continue;
    references.push({ name, id, url });
  }
  if (references.length === 0) return unavailable('absent_from_source');
  return derived({ sourceField: snapshot['products'] !== undefined ? 'products' : 'taggedProducts', references }, METADATA_ENCODER);
}

/** language — from the recorded snapshot's declared language field (a provider-declared observation, never a detected guess). */
function deriveLanguage(snapshot: Readonly<Record<string, unknown>>): LabFeatureValue {
  const declared =
    snapshotString(snapshot, 'language') ??
    snapshotString(snapshot, 'defaultLanguage') ??
    snapshotString(snapshot, 'defaultAudioLanguage');
  if (declared === undefined) return unavailable('encoder_unavailable');
  const sourceField =
    snapshot['language'] !== undefined
      ? 'language'
      : snapshot['defaultLanguage'] !== undefined
        ? 'defaultLanguage'
        : 'defaultAudioLanguage';
  return derived({ sourceField, language: declared }, METADATA_ENCODER);
}

/** The frozen whitespace tokenization: strip surrounding non-word characters, split on whitespace runs. */
function tokenize(text: string): string[] {
  return text
    .split(/\s+/)
    .map((token) => token.replace(/^[^\p{L}\p{N}#]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((token) => token.length > 0);
}

/** The frozen hashtag extraction: tokens beginning with '#' (the leading '#' kept, the rest verbatim). */
function extractHashtags(text: string): string[] {
  return tokenize(text).filter((token) => token.startsWith('#') && token.length > 1);
}

/**
 * title/description/hashtag semantics — the DETERMINISTIC LEXICAL
 * representation of the recorded title/description text: character
 * counts, token counts (the frozen tokenization above) and the
 * extracted hashtag list. A lexical bag honestly labeled
 * 'lab-features-lexical' — NEVER an embedding or a semantic claim.
 */
function deriveTitleDescriptionHashtagSemantics(snapshot: Readonly<Record<string, unknown>>): LabFeatureValue {
  const title = typeof snapshot['title'] === 'string' ? snapshot['title'] : '';
  const description = typeof snapshot['description'] === 'string' ? snapshot['description'] : '';
  if (title.trim().length === 0 && description.trim().length === 0) {
    return unavailable('absent_from_source');
  }
  const hashtags = [...extractHashtags(title), ...extractHashtags(description)];
  const representation = {
    titleChars: title.length,
    descriptionChars: description.length,
    titleTokens: tokenize(title).length,
    descriptionTokens: tokenize(description).length,
    hashtags,
    hashtagCount: hashtags.length,
  };
  return derived(representation, LEXICAL_ENCODER);
}

// ---------------------------------------------------------------------------
// The extractor.
// ---------------------------------------------------------------------------

/** Creates the first-party extractor (the composition-root wiring; test doubles replace it through the port). */
export function createFirstPartyLabFeatureExtractor(): LabFeatureExtractor {
  return {
    extractorId: FIRST_PARTY_EXTRACTOR_ID,
    extractorVersion: FIRST_PARTY_EXTRACTOR_VERSION,
    featureSetVersion: LAB_FEATURE_SET_VERSION,
    supportedModalities: SUPPORTED_MODALITIES,

    async extract(input: LabFeatureExtractionInput): Promise<LabFeatureExtractionResult | LabFeatureExtractionFailure> {
      const snapshot = input.citation.metadataSnapshot;
      const mediaPathOpened = input.mediaFetch !== undefined;

      const values: Record<LabFeatureKey, LabFeatureValue> = {} as Record<LabFeatureKey, LabFeatureValue>;
      for (const key of LAB_FEATURE_KEY_LIST) {
        if (key === 'duration') {
          values[key] = deriveDuration(snapshot);
        } else if (key === 'engagement') {
          values[key] = deriveEngagement(snapshot);
        } else if (key === 'retention_impression_metrics') {
          values[key] = deriveRetentionImpression(snapshot);
        } else if (key === 'product_references') {
          values[key] = deriveProductReferences(snapshot);
        } else if (key === 'language') {
          values[key] = deriveLanguage(snapshot);
        } else if (key === 'title_description_hashtag_semantics') {
          values[key] = deriveTitleDescriptionHashtagSemantics(snapshot);
        } else if (key === 'novelty_reuse_risk') {
          values[key] = unavailable('requires_corpus_context');
        } else if (HISTORY_GRADE_KEYS.has(key)) {
          values[key] = unavailable('requires_observation_history');
        } else if (MEDIA_GRADE_KEYS.has(key)) {
          // The honest media-grade ladder: no granted path → the
          // requires_media_access state; a path opened (or refused at
          // the port) but no decoder wired in this extractor version
          // → the encoder_unavailable state. Either way NEVER a
          // fabricated representation.
          values[key] = unavailable(mediaPathOpened ? 'encoder_unavailable' : 'requires_media_access');
        } else if (ENCODER_GRADE_KEYS.has(key)) {
          values[key] = unavailable('encoder_unavailable');
        } else {
          // Unreachable: the closed key list is fully partitioned
          // above (the unit battery pins the partition).
          values[key] = unavailable('encoder_unavailable');
        }
      }

      const mediaFetchStatus: LabFeatureExtractionResult['mediaFetchStatus'] =
        input.mediaFetch === undefined
          ? 'not_requested'
          : input.mediaFetch.status === 'granted'
            ? 'granted'
            : input.mediaFetch.status === 'pending'
              ? 'pending'
              : 'refused';
      const mediaFetchDetail =
        input.mediaFetch === undefined
          ? undefined
          : input.mediaFetch.status === 'granted'
            ? `granted ${input.mediaFetch.handle.byteLength} ephemeral bytes (in-memory handle, this call only)`
            : input.mediaFetch.status === 'pending'
              ? input.mediaFetch.detail
              : input.mediaFetch.detail;
      const mediaFetchBytes =
        input.mediaFetch !== undefined && input.mediaFetch.status === 'granted'
          ? input.mediaFetch.handle.byteLength
          : undefined;

      return {
        values: values as LabFeatureValueMap,
        mediaFetchStatus,
        mediaFetchDetail,
        mediaFetchBytes,
      };
    },
  };
}
