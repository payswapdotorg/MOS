/**
 * /social-commerce-attribution deterministic pure core (MKT-073).
 *
 * THE EXPORTED FORMULAS (both pinned by unit tests + the boundary
 * tests):
 *
 *   - deriveAttributionIdentity — the ID CONSTRUCTION: the stable
 *     attribution id 'sca-<16hex>' is the first 16 hex of the SHA-256
 *     identity digest over the canonical creation inputs (contract
 *     version + mission + mechanism + purpose + context, DEEP-sorted
 *     canonical JSON). The id is mission-scoped and minted ONCE — it
 *     is carried VERBATIM by every constructed link, every attachment
 *     and every provider-boundary crossing, so it SURVIVES content
 *     transformations (the attachments cite identities, never re-mint
 *     ids) and provider boundaries (the crossing records the exact
 *     field the SAME id rode).
 *
 *   - buildAttributionLink — the 'sca-link-v1' formula set: the
 *     concrete built link per mechanism, EACH a deterministic pure
 *     function of its inputs (no clock, no randomness, no I/O — the
 *     same inputs always produce the same link, the recorded input
 *     digest is the idempotence fence).
 *
 *   - matchAttributionLinks — the 'sca-match-v1' CO-OCCURRENCE
 *     MATCHER: the pure match rules over a conversion event's observed
 *     reference fields — the mechanism-specific match field (the
 *     closed vocabulary of the commerce attribution passthrough) and
 *     the universal 'attributionRef' carrier field (the provider
 *     returning the reference through its own attribution field). The
 *     matcher returns the verified match provenance or null — it
 *     NEVER returns a causal claim (the causal vocabulary is
 *     structurally absent from this file).
 */

import { createHash } from 'node:crypto';
import {
  SOCIAL_COMMERCE_ATTRIBUTION_CONTRACT_VERSION,
  SOCIAL_COMMERCE_ATTRIBUTION_LINK_VERSION,
  SOCIAL_COMMERCE_ATTRIBUTION_MATCH_VERSION,
  type SocialAttributionConstructibleMechanism,
  type SocialAttributionLinkConstructionInput,
  type SocialAttributionLinkConstructionResult,
  type SocialAttributionMatchResult,
  type SocialAttributionObservableLink,
} from '../public.ts';
import { canonicalSocialAttributionJson } from './validation.ts';

// ---------------------------------------------------------------------------
// The id construction (sca-contract-v1)
// ---------------------------------------------------------------------------

/** The canonical identity-input shape (the digest basis). */
export interface AttributionIdentityInput {
  readonly missionId: string;
  readonly mechanism: string;
  readonly purpose: string;
  readonly creationContext: Readonly<Record<string, unknown>>;
}

/**
 * THE ID CONSTRUCTION (deterministic, pure): the identity digest is
 * SHA-256 over the canonical JSON of the creation inputs (the frozen
 * contract version included — a contract change is a NEW identity
 * space); the stable attribution id is its first 16 hex, 'sca-'-
 * prefixed. The same mission + mechanism + purpose + context ALWAYS
 * derive the same id (the idempotence fence); a different context
 * derives a different id (distinct references of the same mission).
 */
export function deriveAttributionIdentity(
  input: AttributionIdentityInput,
): { readonly identityDigest: string; readonly attributionRef: string } {
  const identityDigest = createHash('sha256')
    .update(
      canonicalSocialAttributionJson({
        contractVersion: SOCIAL_COMMERCE_ATTRIBUTION_CONTRACT_VERSION,
        missionId: input.missionId,
        mechanism: input.mechanism,
        purpose: input.purpose,
        creationContext: input.creationContext,
      }),
    )
    .digest('hex');
  return {
    identityDigest,
    attributionRef: `sca-${identityDigest.slice(0, 16)}`,
  };
}

/**
 * The deterministic construction-input digest (SHA-256 over the
 * canonical inputs under the frozen link version — the per-reference
 * construction idempotence fence).
 */
export function deriveConstructionInputDigest(
  input: SocialAttributionLinkConstructionInput,
): string {
  return createHash('sha256')
    .update(
      canonicalSocialAttributionJson({
        constructionVersion: SOCIAL_COMMERCE_ATTRIBUTION_LINK_VERSION,
        mechanism: input.mechanism,
        attributionRef: input.attributionRef,
        missionId: input.missionId,
        baseUrl: input.baseUrl ?? null,
        utmSource: input.utmSource ?? null,
        utmMedium: input.utmMedium ?? null,
        providerLinkId: input.providerLinkId ?? null,
        creatorRef: input.creatorRef ?? null,
        contentRef: input.contentRef ?? null,
        eventName: input.eventName ?? null,
      }),
    )
    .digest('hex');
}

// ---------------------------------------------------------------------------
// The sca-link-v1 formula set (the deterministic link constructions)
// ---------------------------------------------------------------------------

/**
 * The campaign-id composition (PURE): 'sca-<mission8>-<ref12>' — the
 * mission's compact prefix + the attribution id's 12 trailing hex.
 * Deterministic per (mission, reference).
 */
export function deriveCampaignIdentifier(missionId: string, attributionRef: string): string {
  return `sca-${missionId.replace(/-/g, '').slice(0, 8)}-${attributionRef.slice(4)}`;
}

/**
 * The landing-route derivation (PURE): '/sca/<ref12>' — the unique
 * landing route of the reference (the deterministic route the
 * first-party instrumentation serves).
 */
export function deriveLandingRoute(attributionRef: string): string {
  return `/sca/${attributionRef.slice(4)}`;
}

/**
 * THE LINK CONSTRUCTION (sca-link-v1 — deterministic pure function of
 * its inputs; the guard fences produce the honest bounded errors, the
 * formula itself fails closed on a missing input):
 *
 *   - utm_parameters: the bare base URL + the canonical UTM tuple
 *     (utm_source default 'mos', utm_medium default 'social',
 *     utm_campaign = the campaign id, utm_content = the attribution
 *     id) — the reference rides utm_content;
 *   - unique_landing_route: '/sca/<ref12>' — the reference rides the
 *     landing route;
 *   - campaign_identifier: the campaign id — the reference rides the
 *     campaign id;
 *   - creator_content_identifier:
 *     '<creatorRef>/<contentRef>?sca=<attributionRef>' — the reference
 *     rides the creator/content identifier;
 *   - platform_native_link: the RECORDED provider-assigned native
 *     link id (recorded data — the provider assigns it; the
 *     construction is the canonical echo of that record) — the
 *     reference rides the native link id;
 *   - first_party_conversion_event:
 *     '<eventName>#attributionRef=<attributionRef>' (eventName default
 *     'mos_conversion') — the declared first-party event contract; the
 *     reference rides the attributionRef field.
 */
export function buildAttributionLink(
  input: SocialAttributionLinkConstructionInput,
): SocialAttributionLinkConstructionResult {
  const { attributionRef, missionId } = input;
  switch (input.mechanism) {
    case 'utm_parameters': {
      if (typeof input.baseUrl !== 'string' || input.baseUrl.length < 1) {
        return { ok: false, error: 'utm_parameters requires a baseUrl' };
      }
      const source = input.utmSource ?? 'mos';
      const medium = input.utmMedium ?? 'social';
      const link = `${input.baseUrl}?utm_source=${source}&utm_medium=${medium}`
        + `&utm_campaign=${deriveCampaignIdentifier(missionId, attributionRef)}`
        + `&utm_content=${attributionRef}`;
      return { ok: true, built: { link, matchField: 'utmContent', matchValue: attributionRef } };
    }
    case 'unique_landing_route': {
      const link = deriveLandingRoute(attributionRef);
      return { ok: true, built: { link, matchField: 'landingRoute', matchValue: link } };
    }
    case 'campaign_identifier': {
      const link = deriveCampaignIdentifier(missionId, attributionRef);
      return { ok: true, built: { link, matchField: 'campaignId', matchValue: link } };
    }
    case 'creator_content_identifier': {
      if (typeof input.creatorRef !== 'string' || typeof input.contentRef !== 'string') {
        return { ok: false, error: 'creator_content_identifier requires creatorRef and contentRef' };
      }
      const link = `${input.creatorRef}/${input.contentRef}?sca=${attributionRef}`;
      return { ok: true, built: { link, matchField: 'creatorContentRef', matchValue: link } };
    }
    case 'platform_native_link': {
      if (typeof input.providerLinkId !== 'string' || input.providerLinkId.length < 1) {
        return { ok: false, error: 'platform_native_link requires the provider-assigned native link id' };
      }
      return {
        ok: true,
        built: { link: input.providerLinkId, matchField: 'nativeLinkId', matchValue: input.providerLinkId },
      };
    }
    case 'first_party_conversion_event': {
      const eventName = input.eventName ?? 'mos_conversion';
      const link = `${eventName}#attributionRef=${attributionRef}`;
      return { ok: true, built: { link, matchField: 'attributionRef', matchValue: attributionRef } };
    }
  }
}

// ---------------------------------------------------------------------------
// The co-occurrence matcher (sca-match-v1)
// ---------------------------------------------------------------------------

/**
 * THE CO-OCCURRENCE MATCHER (pure, deterministic): iterates the
 * reference's constructed links IN RECORDED ORDER and returns the
 * FIRST verified match —
 *
 *   (a) the mechanism-specific match field: the observed field named
 *       by the construction's match contract carries the exact match
 *       value;
 *   (b) the UNIVERSAL 'attributionRef' carrier field: the provider
 *       returned the reference's OWN stable id through its own
 *       attribution field (the survival proof — the value is the
 *       reference's 16-hex id minted by this module).
 *
 * NO verified match → null (the co-occurrence is NOT evidenced; the
 * outcome row stays inexpressible). The result is MATCH PROVENANCE
 * ONLY — never a causal claim.
 */
export function matchAttributionLinks(
  links: readonly SocialAttributionObservableLink[],
  observedFields: Readonly<Record<string, unknown>>,
): SocialAttributionMatchResult {
  for (const link of links) {
    const specific = observedFields[link.matchField];
    if (typeof specific === 'string' && specific === link.matchValue) {
      return {
        linkConstructionId: link.linkConstructionId,
        mechanism: link.mechanism,
        matchedField: link.matchField,
        matchedValue: specific,
      };
    }
    const universal = observedFields['attributionRef'];
    if (typeof universal === 'string' && universal === link.attributionRef) {
      return {
        linkConstructionId: link.linkConstructionId,
        mechanism: link.mechanism,
        matchedField: 'attributionRef',
        matchedValue: universal,
      };
    }
  }
  return null;
}

/** The matcher version constant re-export (the recorded provenance field). */
export const SOCIAL_ATTRIBUTION_MATCHER_VERSION = SOCIAL_COMMERCE_ATTRIBUTION_MATCH_VERSION;

/** The mechanism-typed helper for the store's row mapping. */
export function asConstructibleMechanism(
  mechanism: string,
): SocialAttributionConstructibleMechanism | null {
  const constructible: readonly string[] = [
    'platform_native_link',
    'utm_parameters',
    'unique_landing_route',
    'campaign_identifier',
    'creator_content_identifier',
    'first_party_conversion_event',
  ];
  return (constructible as readonly string[]).includes(mechanism)
    ? (mechanism as SocialAttributionConstructibleMechanism)
    : null;
}
