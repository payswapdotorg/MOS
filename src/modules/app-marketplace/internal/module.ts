/**
 * /app-marketplace module implementation (MKT-050 — the App Marketplace,
 * Trust and Certification surface over the /apps registry).
 *
 * Composition over the two append-only ledgers (migration 042) and the
 * /apps registry public contract (the frozen-matrix row added by this
 * Work Item: /app-marketplace ──→ /apps):
 *
 *   - DISCOVERY is a DERIVED read model: the registry's public version
 *     listing (READ-ONLY — the marketplace never becomes a second
 *     registry: there is no app catalog table here, every catalog fact
 *     is an /apps registry row) grouped into lineages, enriched with the
 *     DERIVED trust state (the append-only trust_events tail) and the
 *     derived review summary (the append-only app_reviews tail), then
 *     filtered (category = a declared capability, trust level, the
 *     DERIVED first-party/community classification, bounded app-key
 *     search). The agency/tenant scope is route-layer authorization
 *     (server-derived membership) — the catalog itself is global
 *     registry state with no tenant columns (the 037 posture);
 *   - TRUST TRANSITIONS are OPERATOR/GOVERNANCE commands: the pure
 *     one-way-ladder state machine evaluates the proposed move against
 *     the CURRENT DERIVED state (an illegal skip, an illegal down move
 *     or a same-state no-op is rejected 422 with the honest reason —
 *     zero rows), then ONE append-only event row is recorded with
 *     server-derived provenance and §8 idempotency. The from_state
 *     equals the current derived state and the migration-042
 *     chain-consistency trigger re-fences it against the predecessor's
 *     to_state — a transition is NEVER a silent rewrite, and the /apps
 *     registry row stays frozen at its birth state (migration 037);
 *   - REVIEWS are community commands: ONE append-only record (rating,
 *     verdict, body, reviewer provenance) attached at the app or exact
 *     registry-version level (the target resolves through the /apps
 *     public contract and must belong to the same lineage — uniform 404
 *     otherwise). Reviews are DISPLAY METADATA: no policy consumes
 *     review state in this delivery;
 *   - the POLICY ELIGIBILITY read-side query exposes the derived trust
 *     level + review state in the policy-consumable vocabulary. The
 *     MKT-048 install gate consumes the trust part through the
 *     disclosed additive trustState structural port (see
 *     /app-installs public.ts — wired at the composition root): the
 *     gate action's certificationState attribute then carries the
 *     marketplace-DERIVED current state. Trust is METADATA and a policy
 *     input — it NEVER grants authority by itself; the fail-closed
 *     /policies evaluation remains the sole install authority.
 *
 * Fail-closed contract: every guard throws before any state is touched;
 * unknown app keys/versions surface NotFoundError (uniform); illegal
 * transitions surface InvalidRequestError with the honest reason; §8
 * divergent key reuse surfaces IdempotencyConflictError; concurrent
 * tail moves surface ConflictError (the append-only sequence fence).
 */

import {
  IdempotencyConflictError,
  InvalidRequestError,
  NotFoundError,
} from '../../../platform/errors/errors.ts';
import {
  buildPolicyAttributes,
  derivePublisherKind,
  deriveReviewSummary,
  deriveTrustState,
  evaluateTrustTransition,
} from '../public.ts';
import type {
  AppMarketplaceModuleApi,
  AppMarketplaceModuleDeps,
  MarketplaceAppDetail,
  MarketplaceAppEntry,
  MarketplaceFilters,
  MarketplacePolicyEligibility,
  MarketplaceTrustState,
  MarketplaceVersionSummary,
  TrustEventRecord,
} from '../public.ts';
import {
  AppMarketplaceStore,
  appReviewCreateFingerprint,
  assertValidMarketplaceFilters,
  assertValidMarketplaceProvenance,
  assertValidReviewInput,
  assertValidTransitionInput,
  replayOrConflict,
  trustEventCreateFingerprint,
} from './store.ts';

const KEY_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;

export function createAppMarketplaceModule(deps: AppMarketplaceModuleDeps): AppMarketplaceModuleApi {
  const store = new AppMarketplaceStore(deps.db, deps.clock, deps.ids);
  const { apps } = deps;

  /** Guard: a well-formed app key (malformed is a 422 at the module API). */
  function requireWellFormedAppKey(appKey: string): void {
    if (typeof appKey !== 'string' || !KEY_PATTERN.test(appKey)) {
      throw new InvalidRequestError(
        'appKey: must be 2-63 chars, lowercase letters/digits/dashes, starting with a letter',
      );
    }
  }

  /** The published versions of one lineage through the /apps public contract. */
  function versionSummaries(
    versions: ReadonlyArray<Awaited<ReturnType<typeof apps.listAppVersions>>[number]>,
  ): MarketplaceVersionSummary[] {
    return versions.map((record) => ({
      appVersionId: record.appVersionId,
      version: record.manifest.version,
      publishedAt: record.createdAt,
      capabilities: record.manifest.capabilities.map((capability) => capability.name),
      runtimeClass: record.manifest.runtimeClass,
    }));
  }

  /** The derived trust state of one lineage (null when no published lineage). */
  async function trustStateOf(appKey: string): Promise<MarketplaceTrustState | null> {
    const versions = await apps.listAppVersions({ appKey });
    if (versions.length === 0) return null;
    const events = await store.listTrustEvents(appKey);
    return {
      appKey,
      trustLevel: deriveTrustState(events),
      sinceEventId: events.length === 0 ? null : events[events.length - 1]!.eventId,
      transitionCount: events.length,
    };
  }

  /** One listing entry (registry lineage + derived trust + derived reviews). */
  async function entryOf(
    appKey: string,
    versions: readonly MarketplaceVersionSummary[],
    publisher: string,
  ): Promise<MarketplaceAppEntry> {
    const [trustEvents, reviews] = await Promise.all([
      store.listTrustEvents(appKey),
      store.listAppReviews(appKey),
    ]);
    return {
      appKey,
      publisher,
      publisherKind: derivePublisherKind(publisher),
      latestVersion: versions[0] ?? null,
      versions,
      trustState: {
        appKey,
        trustLevel: deriveTrustState(trustEvents),
        sinceEventId:
          trustEvents.length === 0 ? null : trustEvents[trustEvents.length - 1]!.eventId,
        transitionCount: trustEvents.length,
      },
      reviewSummary: deriveReviewSummary(
        reviews.map((review) => ({
          rating: review.rating,
          verdict: review.verdict,
          recordedAt: review.recordedAt,
        })),
      ),
    };
  }

  return {
    async listMarketplaceApps(filters: MarketplaceFilters): Promise<readonly MarketplaceAppEntry[]> {
      assertValidMarketplaceFilters(filters);

      // THE CATALOG IS REGISTRY DATA ONLY (AC-1): every lineage fact comes
      // from the /apps public version listing (READ-ONLY, the authority's
      // bounded newest-first window — the honest disclosure: the listing
      // tallies the registry's bounded listing, never an unbounded
      // recount). The marketplace owns NO catalog table.
      const versions = await apps.listAppVersions({ appKey: null });

      // Group the registry rows into lineages (publisher identity is
      // lineage-consistent — the migration-037 owner fence).
      const lineages = new Map<string, { publisher: string; versions: MarketplaceVersionSummary[] }>();
      for (const record of versions) {
        const summary = versionSummaries([record])[0]!;
        const existing = lineages.get(record.appKey);
        if (existing === undefined) {
          // The registry listing is newest-first: the FIRST row of a
          // lineage is its newest version.
          lineages.set(record.appKey, {
            publisher: record.publisher,
            versions: [summary],
          });
        } else {
          existing.versions.push(summary);
        }
      }

      const entries: MarketplaceAppEntry[] = [];
      for (const [appKey, lineage] of lineages) {
        entries.push(await entryOf(appKey, lineage.versions, lineage.publisher));
      }

      // THE FILTERS (AC-1): category (a declared capability name across
      // the lineage's versions), trust level (the DERIVED state), the
      // DERIVED first-party/community classification and a bounded
      // app-key search substring.
      const search = filters.search === null ? null : filters.search.toLowerCase();
      const filtered = entries.filter((entry) => {
        if (
          filters.category !== null &&
          !entry.versions.some((version) => version.capabilities.includes(filters.category!))
        ) {
          return false;
        }
        if (filters.trustLevel !== null && entry.trustState.trustLevel !== filters.trustLevel) {
          return false;
        }
        if (filters.publisherKind !== null && entry.publisherKind !== filters.publisherKind) {
          return false;
        }
        if (search !== null && !entry.appKey.includes(search)) {
          return false;
        }
        return true;
      });

      // Newest-published first (the lineage's newest registry version).
      filtered.sort((a, b) => {
        const aAt = a.latestVersion?.publishedAt ?? '';
        const bAt = b.latestVersion?.publishedAt ?? '';
        if (aAt !== bAt) return aAt > bAt ? -1 : 1;
        return a.appKey < b.appKey ? -1 : 1;
      });
      return filtered;
    },

    async getMarketplaceApp(appKey: string): Promise<MarketplaceAppDetail | null> {
      requireWellFormedAppKey(appKey);
      const versions = await apps.listAppVersions({ appKey });
      if (versions.length === 0) {
        // Unknown/malformed lineages are indistinguishable (the route
        // surfaces the uniform 404 — no registry existence oracle).
        return null;
      }
      const summaries = versionSummaries(versions);
      const [entry, trustEvents, reviews] = await Promise.all([
        entryOf(appKey, summaries, versions[0]!.publisher),
        store.listTrustEvents(appKey),
        store.listAppReviews(appKey),
      ]);
      return { entry, trustEvents, reviews };
    },

    async resolvePolicyEligibility(appKey: string): Promise<MarketplacePolicyEligibility | null> {
      requireWellFormedAppKey(appKey);
      const versions = await apps.listAppVersions({ appKey });
      if (versions.length === 0) return null;
      const events = await store.listTrustEvents(appKey);
      const reviews = await store.listAppReviews(appKey);
      const trustLevel = deriveTrustState(events);
      const summary = deriveReviewSummary(
        reviews.map((review) => ({
          rating: review.rating,
          verdict: review.verdict,
          recordedAt: review.recordedAt,
        })),
      );
      return {
        appKey,
        trustLevel,
        trustSinceEventId: events.length === 0 ? null : events[events.length - 1]!.eventId,
        transitionCount: events.length,
        reviewState: {
          reviewCount: summary.reviewCount,
          averageRating: summary.averageRating,
          lastReviewAt: summary.lastReviewAt,
        },
        policyAttributes: buildPolicyAttributes({
          trustLevel,
          transitionCount: events.length,
          reviewCount: summary.reviewCount,
          averageRating: summary.averageRating,
        }),
      };
    },

    async recordTrustTransition(input, provenance): Promise<{ readonly event: TrustEventRecord; readonly replayed: boolean }> {
      assertValidTransitionInput(input);
      assertValidMarketplaceProvenance(provenance);

      // The lineage must be a PUBLISHED registry lineage (uniform 404 —
      // read through the /apps public contract).
      const versions = await apps.listAppVersions({ appKey: input.appKey });
      if (versions.length === 0) {
        throw new NotFoundError('app', input.appKey);
      }

      // The §8 replay convergence: an identical logical command
      // converges to the recorded event; a divergent reuse of the key
      // conflicts. Zero state change on replay.
      const fingerprint = trustEventCreateFingerprint({
        appKey: input.appKey,
        transition: input.transition,
        reason: input.reason,
      });
      const replay = replayOrConflict(
        input.idempotencyKey,
        await store.findTrustEventByIdempotencyKey(input.idempotencyKey),
        fingerprint,
      );
      if (replay.replayed) {
        return { event: replay.record, replayed: true };
      }

      // THE STATE MACHINE (AC-2): the proposed transition is evaluated
      // against the CURRENT DERIVED state — the frozen one-way ladder
      // (no skipping) + the disclosed down moves. An illegal move is a
      // 422 with the honest reason and ZERO rows.
      const events = await store.listTrustEvents(input.appKey);
      const current = deriveTrustState(events);
      const verdict = evaluateTrustTransition(current, input.transition);
      if (!verdict.ok) {
        throw new InvalidRequestError(
          `trust transition '${input.transition}' of app '${input.appKey}' is illegal: ${verdict.reason} (the current derived state is ${current} — transitions are append-only events, never rewrites)`,
        );
      }

      // The append: ONE event row with the from_state = the current
      // derived state (the migration-042 chain-consistency trigger
      // re-fences it against the predecessor's to_state).
      const inserted = await store.insertTrustEvent({
        appKey: input.appKey,
        fromState: current,
        toState: verdict.toState,
        transition: input.transition,
        reason: input.reason,
        recordedActor: provenance.actor,
        recordedVia: provenance.recordedVia,
        correlationId: provenance.correlationId,
        causationId: provenance.causationId,
        idempotencyKey: input.idempotencyKey,
        createFingerprint: fingerprint,
      });
      if (inserted === 'taken') {
        // A concurrent identical command converged under the same key:
        // re-read and converge (identical fingerprint) or conflict
        // (divergent content under the same key).
        const recorded = await store.findTrustEventByIdempotencyKey(input.idempotencyKey);
        if (recorded === null) {
          throw new Error(
            `recorded trust event under key '${input.idempotencyKey}' could not be read back`,
          );
        }
        if (recorded.createFingerprint !== fingerprint) {
          throw new IdempotencyConflictError(input.idempotencyKey);
        }
        return { event: recorded, replayed: true };
      }
      return { event: inserted, replayed: false };
    },

    async recordAppReview(input, provenance) {
      assertValidReviewInput(input);
      assertValidMarketplaceProvenance(provenance);

      // The lineage must be a PUBLISHED registry lineage (uniform 404).
      const versions = await apps.listAppVersions({ appKey: input.appKey });
      if (versions.length === 0) {
        throw new NotFoundError('app', input.appKey);
      }

      // A version-level target resolves through the /apps public
      // contract and must belong to the SAME lineage — a foreign or
      // unknown version id is the uniform 404 (no registry oracle).
      if (input.appVersionId !== null) {
        const target = await apps.getAppVersion(input.appVersionId);
        if (target === null || target.appKey !== input.appKey) {
          throw new NotFoundError('app version', input.appVersionId);
        }
      }

      // The §8 replay convergence.
      const fingerprint = appReviewCreateFingerprint({
        appKey: input.appKey,
        appVersionId: input.appVersionId,
        rating: input.rating,
        verdict: input.verdict,
        body: input.body,
      });
      const replay = replayOrConflict(
        input.idempotencyKey,
        await store.findReviewByIdempotencyKey(input.idempotencyKey),
        fingerprint,
      );
      if (replay.replayed) {
        return { review: replay.record, replayed: true };
      }

      const inserted = await store.insertAppReview({
        appKey: input.appKey,
        appVersionId: input.appVersionId,
        rating: input.rating,
        verdict: input.verdict,
        body: input.body,
        recordedActor: provenance.actor,
        recordedVia: provenance.recordedVia,
        correlationId: provenance.correlationId,
        causationId: provenance.causationId,
        idempotencyKey: input.idempotencyKey,
        createFingerprint: fingerprint,
      });
      if (inserted === 'taken') {
        const recorded = await store.findReviewByIdempotencyKey(input.idempotencyKey);
        if (recorded === null) {
          throw new Error(
            `recorded app review under key '${input.idempotencyKey}' could not be read back`,
          );
        }
        if (recorded.createFingerprint !== fingerprint) {
          throw new IdempotencyConflictError(input.idempotencyKey);
        }
        return { review: recorded, replayed: true };
      }
      return { review: inserted, replayed: false };
    },

    async resolveAppTrustState(appKey: string): Promise<MarketplaceTrustState | null> {
      requireWellFormedAppKey(appKey);
      return trustStateOf(appKey);
    },

    async listTrustEvents(appKey: string): Promise<readonly TrustEventRecord[]> {
      requireWellFormedAppKey(appKey);
      return store.listTrustEvents(appKey);
    },

    async listAppReviews(appKey: string) {
      requireWellFormedAppKey(appKey);
      return store.listAppReviews(appKey);
    },
  };
}
