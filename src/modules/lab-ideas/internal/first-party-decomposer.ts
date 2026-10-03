/**
 * /lab-ideas first-party decomposer (LAB-004) — the HONEST
 * deterministic implementation of the replaceable
 * LabIdeaDecomposer port (the LAB-003 first-party-extractor
 * precedent).
 *
 * HONEST ABOUT WHAT IT PRODUCES (never fabricated):
 *
 *   - The deterministic derivation table maps the cited bundle's
 *     per-key feature values to the §6 primitives ONLY when the
 *     feature value is in its DERIVED state AND the expected value
 *     fields are well-typed — a feature in its explicit unavailable
 *     state derives NO primitive, and a derived value without the
 *     expected fields derives NO primitive either (wrong-typed
 *     fields are treated as absent — the LAB-003 disclosed
 *     discipline). The metadata-grade derivations the first-party
 *     /lab-features extractor actually produces (duration,
 *     title/description/hashtag semantics, language) light up
 *     timing_context + packaging; the encoder-grade semantic
 *     features (topic/problem/claim/hook/narrative/CTA/audio/
 *     visual-structure) honestly derive nothing until a real encoder
 *     is wired — the port is the seam.
 *   - NO semantic edges: a supports/contradicts relation between two
 *     primitives is a semantic judgment a deterministic metadata
 *     decomposer cannot make — the first-party decomposer asserts
 *     ZERO intra-decomposition edges (the edge vocabulary is the
 *     real decomposer's and the graph operations' surface —
 *     DISCLOSED).
 *   - Every produced descriptor is an EXPLICITLY-LABELED record of
 *     the derived feature content (e.g. 'packaging (lexical): 7-token
 *     title, 3 hashtags [#fitness #gear]') — observed data, never
 *     an interpretation.
 */

import {
  LAB_IDEA_SET_VERSION,
  type LabIdeaBundleCitation,
  type LabIdeaDecompositionResult,
  type LabIdeaDecomposer,
  type LabIdeaProposedNode,
} from '../public.ts';

export const FIRST_PARTY_DECOMPOSER_ID = 'lab-ideas-first-party-metadata' as const;
export const FIRST_PARTY_DECOMPOSER_VERSION = '1' as const;

// ---------------------------------------------------------------------------
// The deterministic derivation table (the honest metadata-grade
// mapping — the per-kind source feature keys + the expected value
// fields; wrong-typed fields are treated as absent, disclosed).
// ---------------------------------------------------------------------------

/** One encoder-grade derivation rule: primitive kind ← feature key's derived representation string field. */
interface StringDerivationRule {
  primitiveKind: 'idea' | 'problem' | 'claim' | 'hook' | 'narrative' | 'visual_treatment' | 'cta';
  featureKey: string;
  label: string;
  /** The expected well-typed string field of the derived representation. */
  field: string;
}

/** The encoder-grade §6 mappings — the per-kind expected string fields of a REAL encoder's representations. */
const STRING_DERIVATION_RULES: ReadonlyArray<StringDerivationRule> = [
  { primitiveKind: 'idea', featureKey: 'topic_subtopic_entity', label: 'idea (topics)', field: 'topics' },
  { primitiveKind: 'problem', featureKey: 'problem_claim', label: 'problem', field: 'problem' },
  { primitiveKind: 'claim', featureKey: 'problem_claim', label: 'claim', field: 'claim' },
  { primitiveKind: 'hook', featureKey: 'hook_structure', label: 'hook', field: 'pattern' },
  { primitiveKind: 'narrative', featureKey: 'narrative_structure', label: 'narrative', field: 'structure' },
  { primitiveKind: 'visual_treatment', featureKey: 'visual_composition', label: 'visual treatment (composition)', field: 'composition' },
  { primitiveKind: 'cta', featureKey: 'cta_structure', label: 'cta', field: 'cta' },
];

interface WellTypedString {
  value: string;
}

/** Reads a well-typed non-empty trimmed string field from a derived representation (wrong-typed = absent). */
function stringField(representation: Record<string, unknown>, field: string): WellTypedString | null {
  const raw = representation[field];
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  return { value: raw.trim() };
}

/** Reads a well-typed finite number field from a derived representation (wrong-typed = absent). */
function numberField(representation: Record<string, unknown>, field: string): number | null {
  const raw = representation[field];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return raw;
}

/** Bounds a descriptor to the 512-char fence (honest ellipsis marking, never silent truncation). */
function boundedDescriptor(text: string): string {
  return text.length > 512 ? `${text.slice(0, 509)}...` : text;
}

/** Bounds the attributes object to the 32-key fence (the recorded structural echo). */
function boundedAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
  const bounded: Record<string, unknown> = {};
  for (const key of Object.keys(attributes).sort().slice(0, 32)) {
    bounded[key] = attributes[key];
  }
  return bounded;
}

/** Derives the primitive nodes from the citation's feature-map echo (the honest derivation table). */
function deriveNodes(citation: LabIdeaBundleCitation): LabIdeaProposedNode[] {
  const nodes: LabIdeaProposedNode[] = [];
  const features = citation.features as Readonly<Record<string, unknown>>;

  // (1) The metadata-grade §6 mappings — the derivations the
  // first-party /lab-features extractor actually produces.
  // packaging ← title/description/hashtag semantics (the lexical bag).
  const packaging = features['title_description_hashtag_semantics'] as
    | { state?: unknown; value?: unknown }
    | undefined;
  if (packaging !== undefined && packaging.state === 'derived' && packaging.value !== null && typeof packaging.value === 'object') {
    const representation = packaging.value as Record<string, unknown>;
    const titleTokens = numberField(representation, 'titleTokens');
    const hashtags = Array.isArray(representation['hashtags'])
      ? (representation['hashtags'] as unknown[]).filter((tag): tag is string => typeof tag === 'string' && tag.length > 0)
      : [];
    if (titleTokens !== null || hashtags.length > 0) {
      const hashtagList = hashtags.slice(0, 12).join(' ');
      const parts: string[] = ['packaging (lexical)'];
      if (titleTokens !== null) parts.push(`${titleTokens}-token title`);
      if (hashtags.length > 0) parts.push(`${hashtags.length} hashtags${hashtagList.length > 0 ? ` [${hashtagList}]` : ''}`);
      nodes.push({
        primitiveKind: 'packaging',
        descriptor: boundedDescriptor(parts.join(', ')),
        attributes: boundedAttributes({
          sourceKey: 'title_description_hashtag_semantics',
          titleTokens: titleTokens ?? null,
          descriptionTokens: numberField(representation, 'descriptionTokens'),
          hashtagCount: hashtags.length,
          hashtags: hashtags.slice(0, 12),
        }),
      });
    }
  }
  // timing_context ← duration (the recorded seconds).
  const duration = features['duration'] as { state?: unknown; value?: unknown } | undefined;
  if (duration !== undefined && duration.state === 'derived' && duration.value !== null && typeof duration.value === 'object') {
    const valueSeconds = numberField(duration.value as Record<string, unknown>, 'valueSeconds');
    if (valueSeconds !== null && valueSeconds >= 0) {
      nodes.push({
        primitiveKind: 'timing_context',
        descriptor: boundedDescriptor(`timing context: ${Math.round(valueSeconds * 1000) / 1000}s recorded duration`),
        attributes: boundedAttributes({ sourceKey: 'duration', valueSeconds }),
      });
    }
  }
  // audio_treatment ← speaking rate (the recorded words-per-minute) —
  // the metadata-grade numeric mapping.
  const speakingRate = features['speaking_rate'] as { state?: unknown; value?: unknown } | undefined;
  if (speakingRate !== undefined && speakingRate.state === 'derived' && speakingRate.value !== null && typeof speakingRate.value === 'object') {
    const wordsPerMinute = numberField(speakingRate.value as Record<string, unknown>, 'wordsPerMinute');
    if (wordsPerMinute !== null && wordsPerMinute >= 0) {
      nodes.push({
        primitiveKind: 'audio_treatment',
        descriptor: boundedDescriptor(`audio treatment (speaking rate): ${Math.round(wordsPerMinute * 100) / 100} words/minute`),
        attributes: boundedAttributes({ sourceKey: 'speaking_rate', wordsPerMinute }),
      });
    }
  }

  // (2) The encoder-grade §6 mappings — the per-kind expected string
  // fields of a REAL encoder's representations. With the first-party
  // /lab-features extractor these keys honestly record their
  // unavailable state (no primitive derived); with a real encoder
  // wired (or a test double), the same table lights up.
  for (const rule of STRING_DERIVATION_RULES) {
    const feature = features[rule.featureKey] as { state?: unknown; value?: unknown } | undefined;
    if (feature === undefined || feature.state !== 'derived' || feature.value === null || typeof feature.value !== 'object') {
      continue;
    }
    const representation = feature.value as Record<string, unknown>;
    const field = stringField(representation, rule.field);
    if (field === null) {
      // Wrong-typed or absent field — honestly derive NO primitive.
      continue;
    }
    nodes.push({
      primitiveKind: rule.primitiveKind,
      descriptor: boundedDescriptor(`${rule.label}: ${field.value}`),
      attributes: boundedAttributes({ sourceKey: rule.featureKey, [rule.field]: field.value }),
    });
  }
  return nodes;
}

/** Creates the first-party decomposer (the composition-root wiring; test doubles replace it through the port). */
export function createFirstPartyLabIdeaDecomposer(): LabIdeaDecomposer {
  return {
    decomposerId: FIRST_PARTY_DECOMPOSER_ID,
    decomposerVersion: FIRST_PARTY_DECOMPOSER_VERSION,
    ideaSetVersion: LAB_IDEA_SET_VERSION,
    async decompose(input: { citation: LabIdeaBundleCitation }): Promise<LabIdeaDecompositionResult> {
      const nodes = deriveNodes(input.citation);
      // HONEST: zero semantic edges from the deterministic metadata
      // decomposer (a supports/contradicts relation is a semantic
      // judgment — never invented here; DISCLOSED).
      return { nodes, edges: [] };
    },
  };
}
