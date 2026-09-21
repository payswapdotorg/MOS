/**
 * MKT-056 integration-test harness — the REFERENCE IN-MEMORY SOCIAL
 * PLATFORM ADAPTER (the disclosed test double proving the conformance
 * suite executes; the dispatch: "Ship at least one reference in-memory
 * test double adapter to prove the suite executes").
 *
 * A DISCLOSED TEST DOUBLE AT THE PROVIDER BOUNDARY ONLY: the adapter-host
 * surface under test (the capability gates, the scope pre-check, the
 * policy gates, the idempotency fence, the claim-then-fill ledger) is
 * fully REAL — this double is the platform on the other side of the
 * SocialPlatformAdapter port, exactly like the MKT-055 local OAuth
 * provider double stands in for the OAuth provider.
 *
 * Platform-neutral by construction (the adapter-subtree boundary tests
 * prove no platform identifier exists outside the sanctioned subtrees):
 * the adapter key is 'reference-social' and every behavior is generic.
 *
 * Scriptable surface (the conformance batteries):
 *   - per-operation FAILURE INJECTION (setFailure/clearFailure): the
 *     adapter returns the honest data failure for the taxonomy battery;
 *   - the in-memory PUBLISH STATE MACHINE: submitPublish records a
 *     provider publish (id + content type + payload passthrough) in the
 *     configured submit state (accepted by default, or published /
 *     restricted / failed); advancePublish moves a publish to a later
 *     state for the status-poll battery; the submit COUNT per operation
 *     proves the idempotency fence NEVER replays into the provider;
 *   - CONTEXT RECORDING: every received SocialAdapterCallContext is
 *     recorded per operation — the account-identity/scope propagation
 *     battery asserts the host propagated the MKT-055 facts VERBATIM.
 */

import type {
  SocialAdapterCallContext,
  SocialAdapterFailureCode,
  SocialCapability,
  SocialPlatformAdapter,
  SocialRestrictionSignal,
} from '../../../src/modules/social-accounts/public.ts';

/** The platform-neutral adapter key of the reference double. */
export const REFERENCE_SOCIAL_ADAPTER_KEY = 'reference-social';

/** The full default capability matrix (all five families, full operation sets). */
export function fullReferenceCapabilities(): readonly SocialCapability[] {
  return [
    {
      family: 'account',
      operations: ['verifyAccountIdentity', 'getAccountProfile'],
      requiredScopes: ['account:read'],
      description:
        'Reference account identity binding + profile reads (the conformance default; limitations: none — this is a test double).',
    },
    {
      family: 'content-read',
      operations: ['discoverPublicContent', 'listOwnContent', 'getContent'],
      requiredScopes: ['content:read'],
      description:
        'Reference content discovery/reads (the conformance default; limitations: none — this is a test double).',
    },
    {
      family: 'analytics-read',
      operations: ['readAccountAnalytics', 'readContentAnalytics'],
      requiredScopes: ['analytics:read'],
      description:
        'Reference analytics reads (the conformance default; limitations: none — this is a test double).',
    },
    {
      family: 'publish',
      operations: ['submitPublish', 'getPublishStatus'],
      requiredScopes: ['content:write'],
      description:
        'Reference publish lifecycle with status polling (the conformance default; limitations: none — this is a test double).',
    },
    {
      family: 'restriction-signals',
      operations: ['readRestrictionSignals'],
      requiredScopes: [],
      description:
        'Reference observable restriction signals (the conformance default; limitations: none — this is a test double).',
    },
  ];
}

/** The read-only partial matrix (account + content-read only — the capability-subset proof). */
export function readOnlyReferenceCapabilities(): readonly SocialCapability[] {
  return fullReferenceCapabilities().filter(
    (capability) => capability.family === 'account' || capability.family === 'content-read',
  );
}

interface RecordedPublish {
  providerPublishId: string;
  providerContentId: string | null;
  publishState: 'accepted' | 'published' | 'failed' | 'restricted';
  publishedAt: string | null;
  providerFailureReason: string | null;
  restrictionSignals: readonly SocialRestrictionSignal[];
  contentType: string;
  payload: Readonly<Record<string, unknown>>;
  attribution: Readonly<Record<string, unknown>>;
}

const REFERENCE_SIGNAL: SocialRestrictionSignal = {
  signalKind: 'REFERENCE_ELIGIBILITY_HOLD',
  observedAt: '2026-08-01T12:00:00.000Z',
  description: 'The reference platform reports a hypothetical eligibility hold (test double).',
  data: { hold: true, reviewable: true },
};

function failureOf(code: SocialAdapterFailureCode, message: string, rateLimit = null) {
  return { ok: false as const, failure: { code, message, rateLimit } };
}

export interface ReferenceSocialAdapter extends SocialPlatformAdapter {
  /** The number of provider calls received per operation. */
  callCount(operation: string): number;
  /** The recorded call contexts per operation (the propagation battery). */
  contextsOf(operation: string): readonly SocialAdapterCallContext[];
  /** Scripts an operation to return the honest taxonomy failure. */
  setFailure(operation: string, code: SocialAdapterFailureCode, message?: string): void;
  /** Clears an operation's scripted failure. */
  clearFailure(operation: string): void;
  /** The state a fresh submit reports (default 'accepted'). */
  setNextSubmitState(state: 'accepted' | 'published' | 'failed' | 'restricted'): void;
  /** Moves a recorded provider publish to a later state (the poll battery). */
  advancePublish(
    providerPublishId: string,
    state: 'accepted' | 'published' | 'failed' | 'restricted',
    patch?: { readonly providerContentId?: string },
  ): void;
  /** The recorded provider publishes (the fence/idempotency battery). */
  publishes(): readonly RecordedPublish[];
  /** The provider publish ids submitted under a given idempotency key. */
  publishesForIdempotencyKey(idempotencyKey: string): readonly RecordedPublish[];
}

export function createReferenceSocialAdapter(options?: {
  readonly adapterKey?: string;
  readonly capabilities?: readonly SocialCapability[];
}): ReferenceSocialAdapter {
  const adapterKey = options?.adapterKey ?? REFERENCE_SOCIAL_ADAPTER_KEY;
  const capabilities = options?.capabilities ?? fullReferenceCapabilities();

  const callCounts = new Map<string, number>();
  const contexts = new Map<string, SocialAdapterCallContext[]>();
  const failures = new Map<string, { code: SocialAdapterFailureCode; message: string }>();
  const publishesById = new Map<string, RecordedPublish>();
  const publishesByKey = new Map<string, RecordedPublish[]>();
  let publishSequence = 0;
  let nextSubmitState: 'accepted' | 'published' | 'failed' | 'restricted' = 'accepted';

  function record(operation: string, context: SocialAdapterCallContext): void {
    callCounts.set(operation, (callCounts.get(operation) ?? 0) + 1);
    const list = contexts.get(operation) ?? [];
    list.push(context);
    contexts.set(operation, list);
  }

  function scriptedFailure(operation: string) {
    const scripted = failures.get(operation);
    if (scripted === undefined) return null;
    return failureOf(scripted.code, scripted.message);
  }

  function ownContentRecords(context: SocialAdapterCallContext) {
    return [0, 1, 2].map((index) => ({
      providerContentId: `ref-content-${context.externalAccountId}-${index}`,
      authorExternalAccountId: context.externalAccountId,
      contentFormat: 'reference-post',
      publishedAt: `2026-08-0${index + 1}T10:00:00.000Z`,
      sourceTimestamp: `2026-08-0${index + 1}T10:00:00.000Z`,
      engagement: { viewCount: 100 * (index + 1), likeCount: 10 * (index + 1), commentCount: index, shareCount: index },
      data: { reference: true, index, passthrough: { note: 'verbatim provider payload' } },
      etag: `ref-etag-${index}`,
      sourceVersion: `ref-v${index}`,
    }));
  }

  return {
    descriptor: {
      adapterKey,
      providerLabel: `Reference Social Platform (${adapterKey})`,
      description:
        'The disclosed in-memory reference platform of the MKT-056 conformance suite — a test double at the provider boundary only; the contract host under test is fully real.',
    },
    capabilities,

    callCount(operation) {
      return callCounts.get(operation) ?? 0;
    },
    contextsOf(operation) {
      return [...(contexts.get(operation) ?? [])];
    },
    setFailure(operation, code, message) {
      failures.set(operation, { code, message: message ?? `the reference platform scripted a ${code} failure` });
    },
    clearFailure(operation) {
      failures.delete(operation);
    },
    setNextSubmitState(state) {
      nextSubmitState = state;
    },
    advancePublish(providerPublishId, state, patch) {
      const publish = publishesById.get(providerPublishId);
      if (publish === undefined) return;
      publish.publishState = state;
      publish.publishedAt = state === 'published' ? '2026-08-02T12:00:00.000Z' : null;
      publish.providerContentId = patch?.providerContentId ?? publish.providerContentId;
      publish.providerFailureReason =
        state === 'failed' ? 'the reference platform rejected the processed publish (test double)' : null;
    },
    publishes() {
      return [...publishesById.values()];
    },
    publishesForIdempotencyKey(idempotencyKey) {
      return [...(publishesByKey.get(idempotencyKey) ?? [])];
    },

    async verifyAccountIdentity(context) {
      record('verifyAccountIdentity', context);
      const scripted = scriptedFailure('verifyAccountIdentity');
      if (scripted !== null) return scripted;
      return {
        ok: true,
        identity: {
          externalAccountId: context.externalAccountId,
          displayIdentity: `reference:${context.externalAccountId}`,
          verifiedAt: '2026-07-01T09:30:00.000Z',
        },
        rateLimit: null,
      };
    },

    async getAccountProfile(context) {
      record('getAccountProfile', context);
      const scripted = scriptedFailure('getAccountProfile');
      if (scripted !== null) return scripted;
      return {
        ok: true,
        profile: {
          externalAccountId: context.externalAccountId,
          displayIdentity: `reference:${context.externalAccountId}`,
          verifiedAt: '2026-07-01T09:30:00.000Z',
          accountKind: 'reference-professional',
          followerCount: 4242,
          data: { reference: true, platformHint: context.platformId },
        },
        rateLimit: null,
      };
    },

    async discoverPublicContent(context, input) {
      record('discoverPublicContent', context);
      const scripted = scriptedFailure('discoverPublicContent');
      if (scripted !== null) return scripted;
      return {
        ok: true,
        page: {
          records: [0, 1].map((index) => ({
            providerContentId: `ref-public-${input.query.replace(/\W+/g, '-')}-${index}`,
            authorExternalAccountId: `ref-author-${index}`,
            contentFormat: 'reference-video',
            publishedAt: '2026-08-01T08:00:00.000Z',
            sourceTimestamp: '2026-08-01T08:00:00.000Z',
            engagement: { viewCount: 9000 + index, likeCount: 400 + index, commentCount: 20 + index, shareCount: 5 + index },
            data: { reference: true, query: input.query },
            etag: `ref-pub-etag-${index}`,
            sourceVersion: 'ref-v1',
          })),
          pageCursor: null,
        },
        rateLimit: null,
      };
    },

    async listOwnContent(context) {
      record('listOwnContent', context);
      const scripted = scriptedFailure('listOwnContent');
      if (scripted !== null) return scripted;
      return { ok: true, page: { records: ownContentRecords(context), pageCursor: null }, rateLimit: null };
    },

    async getContent(context, input) {
      record('getContent', context);
      const scripted = scriptedFailure('getContent');
      if (scripted !== null) return scripted;
      const own = ownContentRecords(context).find((r) => r.providerContentId === input.providerContentId);
      // An unknown provider content id is an honest null record (the
      // provider reports no such content — never a fabricated failure).
      return { ok: true, record: own ?? null, rateLimit: null };
    },

    async readAccountAnalytics(context, input) {
      record('readAccountAnalytics', context);
      const scripted = scriptedFailure('readAccountAnalytics');
      if (scripted !== null) return scripted;
      return {
        ok: true,
        observations: [
          {
            metric: 'reference.views',
            value: 12345,
            windowStart: input.windowStart,
            windowEnd: input.windowEnd,
            data: { reference: true },
          },
          { metric: 'reference.followers', value: 4242, windowStart: null, windowEnd: null, data: {} },
        ],
        rateLimit: null,
      };
    },

    async readContentAnalytics(context, input) {
      record('readContentAnalytics', context);
      const scripted = scriptedFailure('readContentAnalytics');
      if (scripted !== null) return scripted;
      return {
        ok: true,
        observations: input.providerContentIds.map((id) => ({
          metric: 'reference.content.views',
          value: id.length * 100,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
          data: { providerContentId: id },
        })),
        rateLimit: null,
      };
    },

    async submitPublish(context, input) {
      record('submitPublish', context);
      const scripted = scriptedFailure('submitPublish');
      if (scripted !== null) return scripted;
      publishSequence += 1;
      const providerPublishId = `ref-publish-${publishSequence}`;
      const publish: RecordedPublish = {
        providerPublishId,
        providerContentId: nextSubmitState === 'published' ? `ref-content-published-${publishSequence}` : null,
        publishState: nextSubmitState,
        publishedAt: nextSubmitState === 'published' ? '2026-08-02T12:00:00.000Z' : null,
        providerFailureReason: nextSubmitState === 'failed' ? 'the reference platform rejected the submit' : null,
        restrictionSignals:
          nextSubmitState === 'restricted' ? [REFERENCE_SIGNAL] : [],
        contentType: input.request.contentType,
        payload: input.request.payload,
        attribution: input.request.attribution,
      };
      publishesById.set(providerPublishId, publish);
      const keyList = publishesByKey.get(input.idempotencyKey) ?? [];
      keyList.push(publish);
      publishesByKey.set(input.idempotencyKey, keyList);
      return {
        ok: true,
        submission: {
          publishState: publish.publishState,
          providerPublishId,
          providerContentId: publish.providerContentId,
          publishedAt: publish.publishedAt,
          providerFailureReason: publish.providerFailureReason,
          restrictionSignals: publish.restrictionSignals,
          providerData: { reference: true, receivedContentType: input.request.contentType },
        },
        rateLimit: null,
      };
    },

    async getPublishStatus(context, input) {
      record('getPublishStatus', context);
      const scripted = scriptedFailure('getPublishStatus');
      if (scripted !== null) return scripted;
      const publish = publishesById.get(input.providerPublishId);
      if (publish === undefined) {
        return failureOf('provider-unavailable', `the reference platform reports no publish '${input.providerPublishId}'`);
      }
      return {
        ok: true,
        status: {
          publishState: publish.publishState,
          providerPublishId: publish.providerPublishId,
          providerContentId: publish.providerContentId,
          publishedAt: publish.publishedAt,
          providerFailureReason: publish.providerFailureReason,
          restrictionSignals: publish.restrictionSignals,
          providerData: { reference: true },
        },
        rateLimit: null,
      };
    },

    async readRestrictionSignals(context) {
      record('readRestrictionSignals', context);
      const scripted = scriptedFailure('readRestrictionSignals');
      if (scripted !== null) return scripted;
      return { ok: true, signals: [REFERENCE_SIGNAL], rateLimit: null };
    },
  };
}
