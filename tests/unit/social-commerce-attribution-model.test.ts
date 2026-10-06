/**
 * MKT-073 unit tests — the pure deterministic core of
 * /social-commerce-attribution: the sca-contract-v1 identity derivation,
 * the sca-link-v1 formula set, the sca-match-v1 co-occurrence matcher and
 * the pure input guards of validation.ts — plus the acceptance properties
 * at the pure-core level:
 *
 *   (a) DETERMINISM (the core acceptance, half one): the same canonical
 *       creation inputs ALWAYS derive the same identity digest + the same
 *       stable attribution id ('sca-<16hex>') — the idempotence fence;
 *       a different context derives a different id (distinct references
 *       of the same mission);
 *   (b) THE LINK FORMULAS: each of the six constructible mechanisms is a
 *       deterministic pure function of its inputs (no clock, no
 *       randomness, no I/O) with its closed match contract — the exact
 *       observed field + value the reference rides;
 *   (c) THE HONEST 'unavailable' STATE: an honestly unavailable mechanism
 *       is outside the constructible subset (it builds nothing, carries
 *       nothing, crosses nothing, matches nothing — never a fabricated
 *       link);
 *   (d) THE CO-OCCURRENCE MATCHER: the mechanism-specific match field +
 *       the universal 'attributionRef' carrier field; first-in-recorded-
 *       order; NO verified match → null (the co-occurrence is NOT
 *       evidenced); the result is MATCH PROVENANCE ONLY — structurally
 *       never a causal claim (the causal vocabulary is absent);
 *   (e) THE CAUSAL-SEPARATION DISCIPLINE: the pinned co-occurrence note
 *       is the ONLY note vocabulary; no lift/contribution/incrementality
 *       term exists anywhere in the module's exported surface;
 *   (f) THE INPUT GUARDS: the closed vocabularies, the bounded-scalar
 *       maps, the survival-chain fence (the original content identity is
 *       carried — an attachment that dropped it is inexpressible), the
 *       crossing-advance shapes and the order-truth fence (a first-party
 *       'order' kind is honestly refused);
 *   (g) THE CANONICAL JSON: deeply-sorted keys, undefined dropped,
 *       arrays preserved — the deterministic digest basis.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SOCIAL_COMMERCE_ATTRIBUTION_CONTRACT_VERSION,
  SOCIAL_COMMERCE_ATTRIBUTION_VOCABULARY_VERSION,
  SOCIAL_COMMERCE_ATTRIBUTION_LINK_VERSION,
  SOCIAL_COMMERCE_ATTRIBUTION_MATCH_VERSION,
  SOCIAL_ATTRIBUTION_MECHANISMS,
  SOCIAL_ATTRIBUTION_CONSTRUCTIBLE_MECHANISMS,
  SOCIAL_ATTRIBUTION_REFERENCE_STATUSES,
  SOCIAL_ATTRIBUTION_CROSSING_STATUSES,
  SOCIAL_ATTRIBUTION_CONVERSION_KINDS,
  SOCIAL_ATTRIBUTION_CONVERSION_SOURCES,
  SOCIAL_ATTRIBUTION_CARRIER_KINDS,
  SOCIAL_ATTRIBUTION_MATCH_FIELDS,
  SOCIAL_ATTRIBUTION_CO_OCCURRENCE_NOTE,
  SOCIAL_ATTRIBUTION_REF_PATTERN,
  isKnownSocialAttributionMechanism,
  isConstructibleSocialAttributionMechanism,
  buildAttributionLink,
  deriveAttributionIdentity,
  matchAttributionLinks,
  canonicalSocialAttributionJson,
  deriveCampaignIdentifier,
  deriveLandingRoute,
  deriveConstructionInputDigest,
  assertValidReferenceCreation,
  assertValidLinkConstruction,
  assertValidAttachment,
  assertValidCrossingRecording,
  assertValidCrossingAdvance,
  assertValidFirstPartyConversion,
  assertValidObservedFields,
} from '../../src/modules/social-commerce-attribution/public.ts';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';

const MISSION = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const IDENTITY_INPUT = {
  missionId: MISSION,
  mechanism: 'utm_parameters',
  purpose: 'link the kitchen-apron short-video experiment to the store',
  creationContext: {
    contentRef: 'ca:abc123:3',
    experimentArm: 'arm-b-short-video',
    distributionPlan: 'cpd-plan-91',
  },
} as const;

// ---------------------------------------------------------------------------
// 1. The frozen vocabularies + versions (sca-vocab-v1 — the CHECK-fenced
//    migration-069 mirrors)
// ---------------------------------------------------------------------------

test('MKT-073: the frozen vocabulary + version strings are pinned', () => {
  assert.equal(SOCIAL_COMMERCE_ATTRIBUTION_CONTRACT_VERSION, 'sca-contract-v1');
  assert.equal(SOCIAL_COMMERCE_ATTRIBUTION_VOCABULARY_VERSION, 'sca-vocab-v1');
  assert.equal(SOCIAL_COMMERCE_ATTRIBUTION_LINK_VERSION, 'sca-link-v1');
  assert.equal(SOCIAL_COMMERCE_ATTRIBUTION_MATCH_VERSION, 'sca-match-v1');
  // The closed §16 mechanism vocabulary VERBATIM (architecture-v1.6.md §16)
  // WITH the honest 'unavailable' state.
  assert.deepEqual(SOCIAL_ATTRIBUTION_MECHANISMS, [
    'platform_native_link',
    'utm_parameters',
    'unique_landing_route',
    'campaign_identifier',
    'creator_content_identifier',
    'first_party_conversion_event',
    'unavailable',
  ]);
  // 'unavailable' is EXCLUDED from the constructible subset — the honest
  // state builds nothing (never a fabricated link).
  assert.deepEqual(SOCIAL_ATTRIBUTION_CONSTRUCTIBLE_MECHANISMS, [
    'platform_native_link',
    'utm_parameters',
    'unique_landing_route',
    'campaign_identifier',
    'creator_content_identifier',
    'first_party_conversion_event',
  ]);
  assert.deepEqual(SOCIAL_ATTRIBUTION_REFERENCE_STATUSES, ['active', 'retired']);
  assert.deepEqual(SOCIAL_ATTRIBUTION_CROSSING_STATUSES, ['dispatched', 'echoed', 'dropped']);
  assert.deepEqual(SOCIAL_ATTRIBUTION_CONVERSION_KINDS, ['store_visit', 'product_interaction', 'order']);
  assert.deepEqual(SOCIAL_ATTRIBUTION_CONVERSION_SOURCES, ['order_webhook', 'first_party_event']);
  assert.deepEqual(SOCIAL_ATTRIBUTION_CARRIER_KINDS, [
    'distribution_action',
    'content_transformation',
    'experiment_arm',
  ]);
  assert.deepEqual(SOCIAL_ATTRIBUTION_MATCH_FIELDS, [
    'utmContent',
    'landingRoute',
    'campaignId',
    'creatorContentRef',
    'nativeLinkId',
    'attributionRef',
  ]);
});

test('MKT-073: THE PINNED CO-OCCURRENCE NOTE — the causal-separation discipline, structural', () => {
  assert.equal(
    SOCIAL_ATTRIBUTION_CO_OCCURRENCE_NOTE,
    'co-occurrence evidence only — never causal proof',
  );
  // The causal vocabulary is structurally ABSENT from the module's
  // exported note: lift, contribution and incrementality are OUT OF SCOPE
  // for this module (the experiment-analysis authorities own causal
  // estimation — spec/architecture-v1.6.md §16: "attribution is never
  // silently treated as causal proof").
  for (const causalTerm of ['lift', 'contribution', 'incrementality', 'caused', 'causal proof']) {
    assert.ok(
      !SOCIAL_ATTRIBUTION_CO_OCCURRENCE_NOTE.toLowerCase().includes(causalTerm.toLowerCase().split(' ')[0]! === 'causal'
        ? 'caused'
        : causalTerm),
      `the pinned note carries no causal vocabulary ('${causalTerm}')`,
    );
  }
});

test('MKT-073: the mechanism membership guards (the honest unavailable state is a FIRST-CLASS mechanism)', () => {
  assert.ok(isKnownSocialAttributionMechanism('utm_parameters'));
  assert.ok(isKnownSocialAttributionMechanism('unavailable'));
  assert.ok(!isKnownSocialAttributionMechanism('carrier_pigeon'));
  // The constructible subset excludes the honest unavailable state.
  assert.ok(isConstructibleSocialAttributionMechanism('utm_parameters'));
  assert.ok(!isConstructibleSocialAttributionMechanism('unavailable'));
  assert.ok(!isConstructibleSocialAttributionMechanism('not-a-mechanism'));
});

// ---------------------------------------------------------------------------
// 2. THE ID CONSTRUCTION (the core acceptance, half one: the id is
//    deterministic, mission-scoped and stable — it survives because it is
//    never re-minted and every record carries it verbatim)
// ---------------------------------------------------------------------------

test('MKT-073: THE ID CONSTRUCTION is deterministic — the same canonical inputs derive the SAME identity digest + attribution id (the idempotence fence)', () => {
  const first = deriveAttributionIdentity(IDENTITY_INPUT);
  const second = deriveAttributionIdentity(IDENTITY_INPUT);
  assert.equal(first.identityDigest, second.identityDigest);
  assert.equal(first.attributionRef, second.attributionRef);
  // The stable attribution id grammar: 'sca-' + 16 lowercase hex.
  assert.match(first.attributionRef, SOCIAL_ATTRIBUTION_REF_PATTERN);
  assert.ok(first.identityDigest.length === 64);
  // The id is the FIRST 16 HEX of the digest (the derivation is public,
  // verifiable and deterministic).
  assert.equal(first.attributionRef, `sca-${first.identityDigest.slice(0, 16)}`);
});

test('MKT-073: a different creation context derives a DIFFERENT id (distinct references of the same mission — no silent convergence)', () => {
  const base = deriveAttributionIdentity(IDENTITY_INPUT);
  const otherContext = deriveAttributionIdentity({
    ...IDENTITY_INPUT,
    creationContext: { ...IDENTITY_INPUT.creationContext, experimentArm: 'arm-a-long-video' },
  });
  const otherPurpose = deriveAttributionIdentity({
    ...IDENTITY_INPUT,
    purpose: 'a different declared purpose for the same content',
  });
  const otherMechanism = deriveAttributionIdentity({
    ...IDENTITY_INPUT,
    mechanism: 'unique_landing_route',
  });
  const otherMission = deriveAttributionIdentity({ ...IDENTITY_INPUT, missionId: '0f0f0f0f-0f0f-4000-8000-00000000000f' });
  assert.notEqual(base.attributionRef, otherContext.attributionRef);
  assert.notEqual(base.attributionRef, otherPurpose.attributionRef);
  assert.notEqual(base.attributionRef, otherMechanism.attributionRef);
  assert.notEqual(base.attributionRef, otherMission.attributionRef);
});

test('MKT-073: the digest basis is the CANONICAL JSON — key order and undefined fields NEVER change the identity (the key-deep-sort determinism)', () => {
  const reordered = deriveAttributionIdentity({
    missionId: IDENTITY_INPUT.missionId,
    mechanism: IDENTITY_INPUT.mechanism,
    purpose: IDENTITY_INPUT.purpose,
    creationContext: {
      experimentArm: 'arm-b-short-video',
      distributionPlan: 'cpd-plan-91',
      contentRef: 'ca:abc123:3',
    },
  });
  assert.equal(
    deriveAttributionIdentity(IDENTITY_INPUT).identityDigest,
    reordered.identityDigest,
    'a reordered creation context derives the SAME id (the canonical JSON deep-sorts)',
  );
});

test('MKT-073: the construction input digest is deterministic per (reference, inputs) — the construction idempotence fence', () => {
  const identity = deriveAttributionIdentity(IDENTITY_INPUT);
  const input = {
    mechanism: 'utm_parameters',
    attributionRef: identity.attributionRef,
    missionId: MISSION,
    baseUrl: 'https://store.example.test/products/apron',
    utmSource: null,
    utmMedium: null,
    providerLinkId: null,
    creatorRef: null,
    contentRef: null,
    eventName: null,
  } as const;
  assert.equal(deriveConstructionInputDigest(input), deriveConstructionInputDigest(input));
  assert.notEqual(
    deriveConstructionInputDigest(input),
    deriveConstructionInputDigest({ ...input, baseUrl: 'https://other.example.test/' }),
  );
});

// ---------------------------------------------------------------------------
// 3. THE LINK FORMULAS (sca-link-v1 — each mechanism a deterministic pure
//    function of its inputs, with the closed match contract)
// ---------------------------------------------------------------------------

test('MKT-073: the utm_parameters formula — the canonical UTM tuple with the reference riding utm_content', () => {
  const identity = deriveAttributionIdentity(IDENTITY_INPUT);
  const built = buildAttributionLink({
    mechanism: 'utm_parameters',
    attributionRef: identity.attributionRef,
    missionId: MISSION,
    baseUrl: 'https://store.example.test/products/apron',
  });
  assert.ok(built.ok);
  if (!built.ok) return;
  const campaign = deriveCampaignIdentifier(MISSION, identity.attributionRef);
  assert.equal(
    built.built.link,
    `https://store.example.test/products/apron?utm_source=mos&utm_medium=social` +
      `&utm_campaign=${campaign}&utm_content=${identity.attributionRef}`,
  );
  assert.equal(built.built.matchField, 'utmContent');
  assert.equal(built.built.matchValue, identity.attributionRef);
  // The SAME inputs deterministically build the SAME link (pure).
  assert.deepEqual(
    buildAttributionLink({
      mechanism: 'utm_parameters',
      attributionRef: identity.attributionRef,
      missionId: MISSION,
      baseUrl: 'https://store.example.test/products/apron',
    }),
    built,
  );
  // The declared utm source/medium override the defaults.
  const custom = buildAttributionLink({
    mechanism: 'utm_parameters',
    attributionRef: identity.attributionRef,
    missionId: MISSION,
    baseUrl: 'https://store.example.test/products/apron',
    utmSource: 'tiktok',
    utmMedium: 'organic',
  });
  assert.ok(custom.ok && custom.built.link.includes('utm_source=tiktok'));
  assert.ok(custom.ok && custom.built.link.includes('utm_medium=organic'));
  // A missing base URL fails CLOSED (never an invented URL).
  const missing = buildAttributionLink({
    mechanism: 'utm_parameters',
    attributionRef: identity.attributionRef,
    missionId: MISSION,
    baseUrl: null,
  });
  assert.ok(!missing.ok);
});

test('MKT-073: the campaign identifier + landing route derivations (PURE, deterministic per (mission, reference))', () => {
  const identity = deriveAttributionIdentity(IDENTITY_INPUT);
  // 'sca-<mission8>-<ref12>': the mission's compact prefix + the
  // attribution id's 12 trailing hex.
  const campaign = deriveCampaignIdentifier(MISSION, identity.attributionRef);
  assert.equal(campaign, `sca-${MISSION.replace(/-/g, '').slice(0, 8)}-${identity.attributionRef.slice(4)}`);
  assert.equal(deriveCampaignIdentifier(MISSION, identity.attributionRef), campaign);
  // '/sca/<ref12>': the unique landing route.
  const route = deriveLandingRoute(identity.attributionRef);
  assert.equal(route, `/sca/${identity.attributionRef.slice(4)}`);
  assert.equal(deriveLandingRoute(identity.attributionRef), route);
});

test('MKT-073: the unique_landing_route + campaign_identifier formulas — the deterministic route/campaign match contracts', () => {
  const identity = deriveAttributionIdentity(IDENTITY_INPUT);
  const route = buildAttributionLink({
    mechanism: 'unique_landing_route',
    attributionRef: identity.attributionRef,
    missionId: MISSION,
  });
  assert.ok(route.ok);
  if (!route.ok) return;
  assert.equal(route.built.link, `/sca/${identity.attributionRef.slice(4)}`);
  assert.equal(route.built.matchField, 'landingRoute');
  assert.equal(route.built.matchValue, route.built.link);
  const campaign = buildAttributionLink({
    mechanism: 'campaign_identifier',
    attributionRef: identity.attributionRef,
    missionId: MISSION,
  });
  assert.ok(campaign.ok);
  if (!campaign.ok) return;
  assert.equal(campaign.built.matchField, 'campaignId');
  assert.equal(
    campaign.built.link,
    `sca-${MISSION.replace(/-/g, '').slice(0, 8)}-${identity.attributionRef.slice(4)}`,
  );
  assert.equal(campaign.built.matchValue, campaign.built.link);
});

test('MKT-073: the creator_content_identifier + platform_native_link + first_party_conversion_event formulas', () => {
  const identity = deriveAttributionIdentity(IDENTITY_INPUT);
  // creator/content: '<creatorRef>/<contentRef>?sca=<ref>'.
  const creatorContent = buildAttributionLink({
    mechanism: 'creator_content_identifier',
    attributionRef: identity.attributionRef,
    missionId: MISSION,
    creatorRef: 'creator@mos.test',
    contentRef: 'ca:abc123:3',
  });
  assert.ok(creatorContent.ok);
  if (!creatorContent.ok) return;
  assert.equal(
    creatorContent.built.link,
    `creator@mos.test/ca:abc123:3?sca=${identity.attributionRef}`,
  );
  assert.equal(creatorContent.built.matchField, 'creatorContentRef');
  assert.equal(creatorContent.built.matchValue, creatorContent.built.link);
  // A missing creator/content ref fails CLOSED.
  assert.ok(
    !buildAttributionLink({
      mechanism: 'creator_content_identifier',
      attributionRef: identity.attributionRef,
      missionId: MISSION,
      creatorRef: null,
      contentRef: null,
    }).ok,
  );
  // platform-native link: the RECORDED provider-assigned id (recorded
  // data — the provider assigns it; the construction is the echo).
  const native = buildAttributionLink({
    mechanism: 'platform_native_link',
    attributionRef: identity.attributionRef,
    missionId: MISSION,
    providerLinkId: 'tt-l-918273645',
  });
  assert.ok(native.ok);
  if (!native.ok) return;
  assert.equal(native.built.link, 'tt-l-918273645');
  assert.equal(native.built.matchField, 'nativeLinkId');
  assert.equal(native.built.matchValue, 'tt-l-918273645');
  assert.ok(
    !buildAttributionLink({
      mechanism: 'platform_native_link',
      attributionRef: identity.attributionRef,
      missionId: MISSION,
      providerLinkId: null,
    }).ok,
    'a missing provider-assigned id fails closed (never an invented native link)',
  );
  // first-party conversion event: '<eventName>#attributionRef=<ref>'.
  const firstParty = buildAttributionLink({
    mechanism: 'first_party_conversion_event',
    attributionRef: identity.attributionRef,
    missionId: MISSION,
  });
  assert.ok(firstParty.ok);
  if (!firstParty.ok) return;
  assert.equal(
    firstParty.built.link,
    `mos_conversion#attributionRef=${identity.attributionRef}`,
  );
  assert.equal(firstParty.built.matchField, 'attributionRef');
  assert.equal(firstParty.built.matchValue, identity.attributionRef);
  const named = buildAttributionLink({
    mechanism: 'first_party_conversion_event',
    attributionRef: identity.attributionRef,
    missionId: MISSION,
    eventName: 'apron_page_view',
  });
  assert.ok(named.ok && named.built.link.startsWith('apron_page_view#attributionRef='));
});

// ---------------------------------------------------------------------------
// 4. THE CO-OCCURRENCE MATCHER (sca-match-v1 — the verified match, never
//    a caller-asserted match, never a causal claim)
// ---------------------------------------------------------------------------

test('MKT-073: the matcher verifies the MECHANISM-SPECIFIC match field (the exact observed field + value)', () => {
  const identity = deriveAttributionIdentity(IDENTITY_INPUT);
  const links = [
    {
      linkConstructionId: 'lc-1',
      mechanism: 'utm_parameters',
      matchField: 'utmContent',
      matchValue: identity.attributionRef,
      attributionRef: identity.attributionRef,
    },
  ] as const;
  const match = matchAttributionLinks(links, {
    utmSource: 'mos',
    utmContent: identity.attributionRef,
  });
  assert.deepEqual(match, {
    linkConstructionId: 'lc-1',
    mechanism: 'utm_parameters',
    matchedField: 'utmContent',
    matchedValue: identity.attributionRef,
  });
  // A DIFFERENT value on the match field is NO match.
  assert.equal(
    matchAttributionLinks(links, { utmContent: 'sca-0000000000000000' }),
    null,
  );
  // A non-string observed value is NO match (the closed scalar
  // discipline).
  assert.equal(matchAttributionLinks(links, { utmContent: 42 }), null);
});

test('MKT-073: the matcher verifies the UNIVERSAL attributionRef carrier field (the survival proof across provider boundaries)', () => {
  const identity = deriveAttributionIdentity(IDENTITY_INPUT);
  const links = [
    {
      linkConstructionId: 'lc-2',
      mechanism: 'unique_landing_route',
      matchField: 'landingRoute',
      matchValue: `/sca/${identity.attributionRef.slice(4)}`,
      attributionRef: identity.attributionRef,
    },
  ] as const;
  // The provider returned the reference's OWN stable id through its own
  // attribution field — the survival proof.
  const match = matchAttributionLinks(links, {
    providerAttributionRef: 'irrelevant',
    attributionRef: identity.attributionRef,
  });
  assert.deepEqual(match, {
    linkConstructionId: 'lc-2',
    mechanism: 'unique_landing_route',
    matchedField: 'attributionRef',
    matchedValue: identity.attributionRef,
  });
  // ANOTHER reference's id is NO match.
  assert.equal(
    matchAttributionLinks(links, { attributionRef: 'sca-0000000000000000' }),
    null,
  );
});

test('MKT-073: the matcher returns the FIRST verified match in recorded order; empty observed fields → null', () => {
  const identity = deriveAttributionIdentity(IDENTITY_INPUT);
  const links = [
    {
      linkConstructionId: 'lc-a',
      mechanism: 'utm_parameters',
      matchField: 'utmContent',
      matchValue: identity.attributionRef,
      attributionRef: identity.attributionRef,
    },
    {
      linkConstructionId: 'lc-b',
      mechanism: 'unique_landing_route',
      matchField: 'landingRoute',
      matchValue: `/sca/${identity.attributionRef.slice(4)}`,
      attributionRef: identity.attributionRef,
    },
  ] as const;
  // BOTH specific fields present → the FIRST link in recorded order wins.
  const bothMatch = matchAttributionLinks(links, {
    utmContent: identity.attributionRef,
    landingRoute: `/sca/${identity.attributionRef.slice(4)}`,
  });
  assert.equal(bothMatch?.linkConstructionId, 'lc-a');
  assert.equal(bothMatch?.matchedField, 'utmContent');
  // ONLY the second link's specific field present → the second link
  // matches on its own match contract.
  const onlySecond = matchAttributionLinks(links, {
    landingRoute: `/sca/${identity.attributionRef.slice(4)}`,
  });
  assert.equal(onlySecond?.linkConstructionId, 'lc-b');
  assert.equal(onlySecond?.matchedField, 'landingRoute');
  // ONLY the universal 'attributionRef' carrier present → the FIRST link
  // matches through it (every constructed link carries the reference's
  // OWN stable id — the survival proof across provider boundaries).
  const universalOnly = matchAttributionLinks(links, {
    attributionRef: identity.attributionRef,
  });
  assert.equal(universalOnly?.linkConstructionId, 'lc-a');
  assert.equal(universalOnly?.matchedField, 'attributionRef');
  // NO verified match → null (the co-occurrence is NOT evidenced).
  assert.equal(matchAttributionLinks(links, {}), null);
  assert.equal(matchAttributionLinks(links, { utmContent: 'sca-0000000000000000' }), null);
  assert.equal(matchAttributionLinks([], { utmContent: identity.attributionRef }), null);
});

// ---------------------------------------------------------------------------
// 5. THE CANONICAL JSON (the digest basis)
// ---------------------------------------------------------------------------

test('MKT-073: the canonical JSON — deeply sorted keys, undefined dropped, arrays preserved', () => {
  assert.equal(
    canonicalSocialAttributionJson({ b: 1, a: { d: 2, c: 3 } }),
    '{"a":{"c":3,"d":2},"b":1}',
  );
  assert.equal(
    canonicalSocialAttributionJson({ a: undefined, b: null }),
    '{"b":null}',
  );
  assert.equal(canonicalSocialAttributionJson([3, 1, 2]), '[3,1,2]');
  assert.equal(
    canonicalSocialAttributionJson({ x: [{ z: 1, y: 2 }] }),
    '{"x":[{"y":2,"z":1}]}',
  );
  // The same content under different key order is the same canonical
  // JSON (the deterministic identity basis).
  assert.equal(
    canonicalSocialAttributionJson({ a: 1, b: { c: 2, d: 3 } }),
    canonicalSocialAttributionJson({ b: { d: 3, c: 2 }, a: 1 }),
  );
});

// ---------------------------------------------------------------------------
// 6. THE INPUT GUARDS (validation.ts — the closed vocabularies, the
//    bounded-scalar maps, the survival chain, the crossing shapes, the
//    order-truth fence)
// ---------------------------------------------------------------------------

test('MKT-073: the reference creation guard — the closed mechanism vocabulary + the bounded purpose/context', () => {
  assertValidReferenceCreation({
    missionId: MISSION,
    pursuitWorkspaceId: '11111111-1111-4000-8000-000000000001',
    mechanism: 'unavailable',
    purpose: 'the platform offers no attribution mechanism for this action',
    creationContext: {},
  });
  assert.throws(
    () =>
      assertValidReferenceCreation({
        missionId: 'not-a-uuid',
        pursuitWorkspaceId: '11111111-1111-4000-8000-000000000001',
        mechanism: 'utm_parameters',
        purpose: 'x',
        creationContext: {},
      }),
    InvalidRequestError,
  );
  assert.throws(
    () =>
      assertValidReferenceCreation({
        missionId: MISSION,
        pursuitWorkspaceId: '11111111-1111-4000-8000-000000000001',
        mechanism: 'quantum_entanglement' as never,
        purpose: 'x',
        creationContext: {},
      }),
    /closed §16 mechanism vocabulary/,
  );
  assert.throws(
    () =>
      assertValidReferenceCreation({
        missionId: MISSION,
        pursuitWorkspaceId: '11111111-1111-4000-8000-000000000001',
        mechanism: 'utm_parameters',
        purpose: '',
        creationContext: {},
      }),
    InvalidRequestError,
  );
});

test('MKT-073: the bounded-scalar map guard (the attribution-passthrough discipline)', () => {
  // The bounds: at most 20 fields, keys 1..100, scalar values bounded.
  const full: Record<string, unknown> = {};
  for (let index = 0; index < 20; index += 1) full[`f${index}`] = index;
  assertValidObservedFields(full, 'observedFields');
  assert.throws(
    () => assertValidObservedFields({ ...full, extra: 1 }, 'observedFields'),
    /more than 20 observed fields/,
  );
  assert.throws(
    () => assertValidObservedFields({ ['k'.repeat(101)]: 1 }, 'observedFields'),
    /1\.\.100 bound/,
  );
  assert.throws(
    () => assertValidObservedFields({ nested: { deep: 1 } }, 'observedFields'),
    /not a scalar observed field/,
  );
  assert.throws(
    () => assertValidObservedFields({ list: [1, 2] }, 'observedFields'),
    /not a scalar observed field/,
  );
  assert.throws(
    () => assertValidObservedFields({ big: 'x'.repeat(501) }, 'observedFields'),
    /500-character observed-value bound/,
  );
  assert.throws(
    () => assertValidObservedFields({ inf: Number.POSITIVE_INFINITY }, 'observedFields'),
    /not a finite observed value/,
  );
  // Scalars of every permitted kind pass.
  assertValidObservedFields({ s: 'text', n: 1.5, b: true, z: null }, 'observedFields');
});

test('MKT-073: the link construction guard — the mechanism-required fields (the formula fails closed FIRST)', () => {
  const identity = deriveAttributionIdentity(IDENTITY_INPUT);
  const ref = identity.attributionRef;
  // utm_parameters requires a bare http(s) baseUrl with no query string.
  assertValidLinkConstruction(ref, {
    mechanism: 'utm_parameters',
    baseUrl: 'https://store.example.test/apron',
  });
  assert.throws(
    () => assertValidLinkConstruction(ref, { mechanism: 'utm_parameters', baseUrl: 'ftp://nope.test/' }),
    /bare http\(s\) baseUrl/,
  );
  assert.throws(
    () => assertValidLinkConstruction(ref, { mechanism: 'utm_parameters', baseUrl: 'https://store.example.test/?q=1' }),
    /bare http\(s\) baseUrl/,
  );
  assert.throws(
    () => assertValidLinkConstruction(ref, { mechanism: 'utm_parameters', baseUrl: 'https://store.example.test/apron', utmSource: 'not a token!' }),
    /utmSource/,
  );
  // platform_native_link requires the provider-assigned id.
  assert.throws(
    () => assertValidLinkConstruction(ref, { mechanism: 'platform_native_link', providerLinkId: null }),
    /provider-assigned native link id/,
  );
  // creator_content_identifier requires both refs.
  assert.throws(
    () => assertValidLinkConstruction(ref, { mechanism: 'creator_content_identifier', creatorRef: 'c', contentRef: null }),
    /bounded contentRef/,
  );
  // first_party_conversion_event validates the event-name grammar.
  assert.throws(
    () => assertValidLinkConstruction(ref, { mechanism: 'first_party_conversion_event', eventName: 'Not-lower' }),
    /eventName/,
  );
  // THE HONEST UNAVAILABLE STATE builds nothing.
  assert.throws(
    () => assertValidLinkConstruction(ref, { mechanism: 'unavailable' as never }),
    /not constructible/,
  );
  // A malformed attribution id is refused before anything is built.
  assert.throws(
    () => assertValidLinkConstruction('sca-nothex', { mechanism: 'utm_parameters', baseUrl: 'https://x.test/' }),
    /sca-/,
  );
});

test('MKT-073: THE SURVIVAL-CHAIN FENCE — the attachment must CARRY the original content identity (an attachment that dropped it is inexpressible)', () => {
  assertValidAttachment({
    carrierKind: 'content_transformation',
    carrierRef: 'cpd-destination-transform-44',
    originalContentRef: 'ca:abc123:3',
    carriedContentRefs: ['ca:abc123:3', 'ca:abc123:4'],
    reason: 'the short-video transform carried the reference',
  });
  // The chain WITHOUT the original is rejected (the core acceptance:
  // the id survives transformations because the lineage is fenced).
  assert.throws(
    () =>
      assertValidAttachment({
        carrierKind: 'content_transformation',
        carrierRef: 'cpd-destination-transform-44',
        originalContentRef: 'ca:abc123:3',
        carriedContentRefs: ['ca:abc123:4'],
        reason: 'the dropped-original chain',
      }),
    /must CARRY the ORIGINAL content identity/,
  );
  // The closed carrier vocabulary.
  assert.throws(
    () =>
      assertValidAttachment({
        carrierKind: 'subliminal_message' as never,
        carrierRef: 'x',
        originalContentRef: 'ca:abc123:3',
        carriedContentRefs: ['ca:abc123:3'],
        reason: 'r',
      }),
    /closed carrier vocabulary/,
  );
  // The chain bounds: 1..50 entries.
  const tooMany = Array.from({ length: 51 }, (_, index) => `ca:abc123:${index}`);
  assert.throws(
    () =>
      assertValidAttachment({
        carrierKind: 'experiment_arm',
        carrierRef: 'arm-b',
        originalContentRef: 'ca:abc123:3',
        carriedContentRefs: tooMany,
        reason: 'r',
      }),
    /1\.\.50 content identities/,
  );
  assert.throws(
    () =>
      assertValidAttachment({
        carrierKind: 'experiment_arm',
        carrierRef: 'arm-b',
        originalContentRef: 'ca:abc123:3',
        carriedContentRefs: [],
        reason: 'r',
      }),
    /1\.\.50 content identities/,
  );
});

test('MKT-073: the crossing guards — the recorded shape + the single guarded advance (the honest provider boundary)', () => {
  assertValidCrossingRecording({
    providerKey: 'tiktok',
    payloadField: 'link_params.utm_content',
    dispatchedValue: 'sca-0123456789abcdef',
  });
  assert.throws(
    () => assertValidCrossingRecording({ providerKey: 'not a key!', payloadField: 'f', dispatchedValue: 'v' }),
    /providerKey/,
  );
  assert.throws(
    () => assertValidCrossingRecording({ providerKey: 'tiktok', payloadField: 'bad field', dispatchedValue: 'v' }),
    /payloadField/,
  );
  // The advance: 'echoed' REQUIRES the echo value; 'dropped' REQUIRES
  // the honest null (a dropped reference is never fabricated into an
  // echo).
  assertValidCrossingAdvance({ toState: 'echoed', echoValue: 'sca-0123456789abcdef', reason: 'the provider echoed the reference' });
  assertValidCrossingAdvance({ toState: 'dropped', echoValue: null, reason: 'the provider dropped the reference' });
  assert.throws(
    () => assertValidCrossingAdvance({ toState: 'echoed', echoValue: null, reason: 'r' }),
    /echoValue/,
  );
  assert.throws(
    () => assertValidCrossingAdvance({ toState: 'dropped', echoValue: 'sca-0123456789abcdef', reason: 'r' }),
    /never fabricated into an echo/,
  );
  assert.throws(
    () => assertValidCrossingAdvance({ toState: 'lost-in-transit' as never, echoValue: null, reason: 'r' }),
    /'echoed' or 'dropped'/,
  );
});

test('MKT-073: THE ORDER-TRUTH FENCE at the guard level — a first-party conversion is a store visit or a product interaction ONLY', () => {
  assertValidFirstPartyConversion({
    pursuitWorkspaceId: '11111111-1111-4000-8000-000000000001',
    conversionKind: 'store_visit',
    subjectRef: 'session-9f2',
    occurredAt: '2026-10-04T11:00:00.000Z',
    observedFields: { landingRoute: '/sca/0123456789abcdef' },
  });
  assertValidFirstPartyConversion({
    pursuitWorkspaceId: '11111111-1111-4000-8000-000000000001',
    conversionKind: 'product_interaction',
    observedFields: {},
  });
  // The order kind comes from the REAL commerce boundary ONLY.
  assert.throws(
    () =>
      assertValidFirstPartyConversion({
        pursuitWorkspaceId: '11111111-1111-4000-8000-000000000001',
        conversionKind: 'order' as never,
        observedFields: {},
      }),
    /order-truth fence/,
  );
  assert.throws(
    () =>
      assertValidFirstPartyConversion({
        pursuitWorkspaceId: 'not-a-uuid',
        conversionKind: 'store_visit',
        observedFields: {},
      }),
    InvalidRequestError,
  );
});
