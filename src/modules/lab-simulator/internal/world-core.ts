/**
 * /lab-simulator engine core (LAB-005) — the PURE deterministic
 * interaction loop.
 *
 * THE CORE ACCEPTANCE, STRUCTURAL (spec/effective-backlog-v1.7.md
 * LAB-005: "deterministic seeded replay plus stochastic runs; no
 * invented hidden provider state"; spec/
 * architecture-v1.7-marketing-lab.md §9: "The response of a user or
 * market actor is stochastic and stateful. A simulator run MUST be
 * able to reproduce a trajectory given a recorded seed/configuration"):
 *
 *   simulateLabTrajectory(knobs, masterSeed, stepBudget, publishingPlan,
 *   contentUniverse) is a PURE FUNCTION of (seed, configuration, the
 *   interaction history) — no clock, no I/O, no ambient state. The
 *   same inputs always produce the same trajectory, step-for-step:
 *   every stochastic draw rides one of the five declared splitmix64
 *   streams (user-sessions / competition / trends / ranking /
 *   interactions) in a FIXED consumption order, and every stateful
 *   quantity (fatigue, novelty, trends, followers) evolves as a pure
 *   function of the recorded step history.
 *
 * THE INTERACTION LOOP (per step, the fixed RNG consumption order):
 *
 *   1. USER SESSIONS      — per segment (declared order): the
 *                           stochastic session count around the
 *                           declared session-rate mean.
 *   2. TOPIC TRENDS       — per topic (declared order): the stateful
 *                           trend update (persistence toward the
 *                           seasonal baseline + the volatility noise).
 *   3. CREATOR COMPETITION— the declared number of competitor posts,
 *                           each with a drawn competitor index, a
 *                           trend-weighted topic and a jittered
 *                           quality (the competing content that
 *                           crowds the feed).
 *   4. CANDIDATE POOL     — the live account items + the live
 *                           competitor items, scored by the declared
 *                           pre-score (quality × freshness × trend),
 *                           bounded to the declared pool size (the
 *                           candidate-generation step).
 *   5. EXPOSURE/RANKING   — the declared exposure curve applied to the
 *                           pool (position shares; the declared
 *                           exploration promotion) — THE DECLARED
 *                           MODELING ASSUMPTION, labeled on every
 *                           recorded exposure decision (never a
 *                           provider fact).
 *   6. USER INTERACTIONS  — per segment × account pool item (pool
 *                           order): the stochastic response counts
 *                           (views/skips/engagements/shares/clicks/
 *                           conversions) under the stateful fatigue +
 *                           novelty dynamics, drawn through the
 *                           aggregate binomial approximation (the
 *                           Irwin-Hall z).
 *   7. OBSERVABLE STATE   — the observable projection recorded for the
 *                           agent (the observable/hidden split: ONLY
 *                           the surfaces the platform would show; the
 *                           model internals never enter it).
 *
 * Every float that enters a recorded step or a digest is rounded to
 * 4 decimals FIRST (the deterministic numeric-serialization
 * discipline); the step digest is the SHA-256 over the canonical step
 * content; the trajectory digest is the SHA-256 over the ordered
 * step-digest chain.
 */

import { LAB_SIMULATOR_FACTUALITY, LAB_SIMULATOR_MODELING_BASIS, LAB_SIMULATOR_RNG_LABELS, type LabSimulatorPublishAction, type LabSimulatorUniverseItemCitation, type LabSimulatorWorldKnobs } from '../public.ts';
import { createLabSimulatorRng } from './rng.ts';
import { computeLabSimulatorObservableDigest, computeLabSimulatorStepDigest, computeLabSimulatorTrajectoryDigest, round4 } from './validation.ts';

/** The engine's trajectory input — the complete reproducibility input set. */
export interface LabSimulatorTrajectoryInput {
  knobs: LabSimulatorWorldKnobs;
  /** The master seed (the decimal u64 — the seed record's recorded master). */
  masterSeed: string;
  /** The bounded step budget. */
  stepBudget: number;
  /** The caller-declared publishing plan (already validated against the declared constraints). */
  publishingPlan: ReadonlyArray<LabSimulatorPublishAction>;
  /** The cited content universe (already validated against the configuration's topics). */
  contentUniverse: ReadonlyArray<LabSimulatorUniverseItemCitation>;
}

/** One engine step: the full loop telemetry + the deterministic digests + the observable projection. */
export interface LabSimulatorEngineStep {
  seq: number;
  candidates: ReadonlyArray<{
    itemId: string;
    source: 'account' | 'competitor';
    topic: string;
    quality: number;
    ageSteps: number;
    candidateScore: number;
  }>;
  exposure: ReadonlyArray<{
    itemId: string;
    source: 'account' | 'competitor';
    position: number;
    exposureShare: number;
    impressions: number;
    rankingModel: string;
  }>;
  interactions: ReadonlyArray<{
    segment: string;
    sessions: number;
    views: number;
    skips: number;
    engagements: number;
    shares: number;
    clicks: number;
    conversions: number;
    revenue: number;
    followersGained: number;
  }>;
  competitorPosts: ReadonlyArray<{ itemId: string; competitorIndex: number; topic: string; quality: number }>;
  topicTrends: Readonly<Record<string, number>>;
  metrics: {
    impressions: number;
    views: number;
    engagements: number;
    shares: number;
    clicks: number;
    conversions: number;
    revenue: number;
    followersGained: number;
    competitorPostCount: number;
  };
  stepDigest: string;
  observableState: Readonly<Record<string, unknown>>;
  observableDigest: string;
}

/** The engine's trajectory result: the steps + the summary + the trajectory digest. */
export interface LabSimulatorTrajectoryResult {
  steps: ReadonlyArray<LabSimulatorEngineStep>;
  summary: {
    stepCount: number;
    totalImpressions: number;
    totalViews: number;
    totalEngagements: number;
    totalShares: number;
    totalClicks: number;
    totalConversions: number;
    totalRevenue: number;
    totalFollowersGained: number;
  };
  trajectoryDigest: string;
}

/** One live content item in the world (an account item or a competitor post). */
interface LiveItem {
  itemId: string;
  source: 'account' | 'competitor';
  topic: string;
  quality: number;
  publishedAtStep: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * The freshness factor (the DISCLOSED formula): 0.5^(age / halfLife)
 * — an item's exposure-relevance halves every halfLife steps.
 */
function freshnessFactor(ageSteps: number, halfLifeSteps: number): number {
  return 0.5 ** (ageSteps / halfLifeSteps);
}

/**
 * The aggregate binomial approximation (the DISCLOSED stochastic
 * count): the expected count perturbed by an Irwin-Hall z (the sum of
 * three uniforms centered and scaled to unit variance) times the
 * binomial standard deviation, clamped to the capacity. Deterministic
 * given the consumed uniforms.
 */
function stochasticCount(rngUniforms: ReadonlyArray<number>, expected: number, capacity: number): number {
  const z = (rngUniforms[0]! + rngUniforms[1]! + rngUniforms[2]! - 1.5) * 2;
  const p = capacity > 0 ? clamp01(expected / capacity) : 0;
  const sd = Math.sqrt(Math.max(0, capacity * p * (1 - p)));
  const count = Math.round(expected + z * sd);
  return Math.min(capacity, Math.max(0, count));
}

/** The Irwin-Hall z of three fresh uniforms (unit-variance, mean 0). */
function z3(u1: number, u2: number, u3: number): number {
  return (u1 + u2 + u3 - 1.5) * 2;
}

/**
 * THE PURE ENGINE: the deterministic interaction loop. The five RNG
 * streams are created from the master seed (the declared splitmix64
 * derivation) and consumed in the FIXED order documented on the
 * module — the same (seed, configuration, history) always produce
 * the same trajectory, step-for-step.
 */
export function simulateLabTrajectory(input: LabSimulatorTrajectoryInput): LabSimulatorTrajectoryResult {
  const { knobs, masterSeed, stepBudget } = input;
  const universe = input.contentUniverse;
  const plan = input.publishingPlan;

  const rng = {
    sessions: createLabSimulatorRng(masterSeed, LAB_SIMULATOR_RNG_LABELS[0]),
    competition: createLabSimulatorRng(masterSeed, LAB_SIMULATOR_RNG_LABELS[1]),
    trends: createLabSimulatorRng(masterSeed, LAB_SIMULATOR_RNG_LABELS[2]),
    ranking: createLabSimulatorRng(masterSeed, LAB_SIMULATOR_RNG_LABELS[3]),
    interactions: createLabSimulatorRng(masterSeed, LAB_SIMULATOR_RNG_LABELS[4]),
  };

  // The deterministic topic/segment indexes (the declared order is the engine's order).
  const topics = [...knobs.topics];
  const segments = [...knobs.population.segments];
  const topicNames = topics.map((topic) => topic.name);

  // --- The stateful world state (reconstructed identically on every replay). ---
  // The topic trends, initialized at the declared baseline interest.
  const topicTrends = new Map<string, number>();
  for (const topic of topics) {
    topicTrends.set(topic.name, clamp01(topic.baselineInterest));
  }
  // The per-(segment, topic) fatigue accumulation.
  const fatigue = new Map<string, number>();
  for (const segment of segments) {
    for (const topic of topicNames) {
      fatigue.set(`${segment.name}::${topic}`, 0);
    }
  }
  // The per-(segment, item) exposure count (the novelty decay).
  const exposures = new Map<string, number>();
  // The live items (account first, then competitors — each in publication order).
  const liveItems: LiveItem[] = [];
  // The competitor live list bound (the bounded-world memory, DISCLOSED).
  const competitorLiveBound = Math.max(64, knobs.ranking.candidatePoolSize * 8);
  // The account's published items per plan step (deterministic: the plan entries sorted by (atStep, itemIndex)).
  const publishesByStep = new Map<number, number[]>();
  for (const entry of [...plan].sort((a, b) => (a.atStep - b.atStep) || (a.itemIndex - b.itemIndex))) {
    const list = publishesByStep.get(entry.atStep) ?? [];
    list.push(entry.itemIndex);
    publishesByStep.set(entry.atStep, list);
  }
  // The cumulative account state.
  let followers = knobs.account.initialFollowers;
  let totalViews = 0;
  let totalEngagements = 0;
  let totalConversions = 0;
  let totalRevenue = 0;
  let totalFollowersGained = 0;
  let totalImpressions = 0;
  let totalShares = 0;
  let totalClicks = 0;

  const steps: LabSimulatorEngineStep[] = [];

  for (let seq = 1; seq <= stepBudget; seq += 1) {
    // ------------------------------------------------------------------
    // (1) USER SESSIONS — the stochastic per-segment session counts.
    // ------------------------------------------------------------------
    const segmentSessions = segments.map((segment) => {
      const expected = knobs.population.totalUsers * segment.share * segment.sessionRatePerStep;
      const z = z3(rng.sessions.nextFloat(), rng.sessions.nextFloat(), rng.sessions.nextFloat());
      return Math.max(0, Math.round(expected * (1 + 0.2 * z)));
    });
    const totalSessions = segmentSessions.reduce((sum, count) => sum + count, 0);

    // ------------------------------------------------------------------
    // (2) TOPIC TRENDS — the stateful trend update (persistence toward
    //     the seasonal baseline + the volatility noise).
    // ------------------------------------------------------------------
    for (const topic of topics) {
      const seasonal = clamp01(
        topic.baselineInterest *
          (1 + knobs.trends.seasonalityAmplitude * Math.sin((2 * Math.PI * seq) / knobs.trends.seasonalityPeriodSteps)),
      );
      const prior = topicTrends.get(topic.name)!;
      const noise = knobs.trends.volatility * (2 * rng.trends.nextFloat() - 1);
      topicTrends.set(
        topic.name,
        clamp01(knobs.trends.persistence * prior + (1 - knobs.trends.persistence) * seasonal + noise),
      );
    }

    // ------------------------------------------------------------------
    // (3) CREATOR COMPETITION — the declared competitor posts (the
    //     competing content that crowds the feed).
    // ------------------------------------------------------------------
    const competitorPosts: Array<{ itemId: string; competitorIndex: number; topic: string; quality: number }> = [];
    for (let k = 0; k < knobs.competition.competitorPostsPerStep; k += 1) {
      if (knobs.competition.competitorCount === 0) {
        break;
      }
      const competitorIndex = rng.competition.nextInt(0, knobs.competition.competitorCount);
      // The trend-weighted topic pick (the declared topic order; the epsilon keeps the pick total-positive).
      const weights = topicNames.map((name) => Math.max(0, topicTrends.get(name)!) + 0.001);
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      let pick = rng.competition.nextFloat() * total;
      let topicName = topicNames[topicNames.length - 1]!;
      for (let i = 0; i < topicNames.length; i += 1) {
        pick -= weights[i]!;
        if (pick <= 0) {
          topicName = topicNames[i]!;
          break;
        }
      }
      const quality = clamp01(
        knobs.competition.competitorQualityMean +
          knobs.competition.competitorQualitySigma * (2 * rng.competition.nextFloat() - 1),
      );
      competitorPosts.push({
        itemId: `comp-${seq}-${k + 1}`,
        competitorIndex,
        topic: topicName,
        quality: round4(quality),
      });
      liveItems.push({
        itemId: `comp-${seq}-${k + 1}`,
        source: 'competitor',
        topic: topicName,
        quality,
        publishedAtStep: seq,
      });
    }
    // The bounded competitor live list (the most recent posts kept, DISCLOSED).
    const competitorCount2 = liveItems.filter((item) => item.source === 'competitor').length;
    if (competitorCount2 > competitorLiveBound) {
      let toDrop = competitorCount2 - competitorLiveBound;
      for (let i = 0; i < liveItems.length && toDrop > 0; i += 1) {
        if (liveItems[i]!.source === 'competitor') {
          liveItems.splice(i, 1);
          toDrop -= 1;
          i -= 1;
        }
      }
    }

    // ------------------------------------------------------------------
    // (4) THE PUBLISHING — the plan's items join the live pool (the
    //     plan was already validated against the declared constraints).
    // ------------------------------------------------------------------
    for (const itemIndex of publishesByStep.get(seq) ?? []) {
      const cited = universe[itemIndex]!;
      liveItems.push({
        itemId: `acct-${itemIndex}`,
        source: 'account',
        topic: cited.topic,
        quality: cited.quality,
        publishedAtStep: seq,
      });
    }

    // ------------------------------------------------------------------
    // (5) CANDIDATE GENERATION — the scored live pool, bounded to the
    //     declared pool size (the candidate-generation step).
    // ------------------------------------------------------------------
    const scored = liveItems.map((item) => {
      const age = seq - item.publishedAtStep;
      const score = item.quality * freshnessFactor(age, knobs.freshness.halfLifeSteps) * (1 + topicTrends.get(item.topic)!);
      return { item, age, score: round4(score) };
    });
    scored.sort((a, b) => (b.score - a.score) || (a.item.itemId < b.item.itemId ? -1 : a.item.itemId > b.item.itemId ? 1 : 0));
    const pool = scored.slice(0, knobs.ranking.candidatePoolSize);

    const candidatesRecord = pool.map(({ item, age, score }) => ({
      itemId: item.itemId,
      source: item.source,
      topic: item.topic,
      quality: round4(item.quality),
      ageSteps: age,
      candidateScore: score,
    }));

    // ------------------------------------------------------------------
    // (6) EXPOSURE/RANKING — the declared curve applied to the pool
    //     (THE DECLARED MODELING ASSUMPTION — never a provider fact).
    // ------------------------------------------------------------------
    // The exploration promotion (the declared exploration rate): one
    // tail candidate swaps to the head.
    const explore = rng.ranking.nextFloat() < knobs.ranking.explorationRate;
    const promotedIdx = rng.ranking.nextInt(0, pool.length);
    const ordered = [...pool];
    if (explore && pool.length > 1) {
      const [promoted] = ordered.splice(promotedIdx, 1);
      ordered.unshift(promoted!);
    }
    // The position shares: share(p) = topWeight × p^(−decayPower), normalized.
    const shares = ordered.map((_, index) => knobs.ranking.exposureTopWeight * (index + 1) ** (-knobs.ranking.exposureDecayPower));
    const shareTotal = shares.reduce((sum, share) => sum + share, 0);
    const normalizedShares = shareTotal > 0 ? shares.map((share) => share / shareTotal) : shares.map(() => 0);
    const exposureRecord = ordered.map((entry, index) => ({
      itemId: entry.item.itemId,
      source: entry.item.source,
      position: index + 1,
      exposureShare: round4(normalizedShares[index]!),
      impressions: Math.round(totalSessions * normalizedShares[index]!),
      rankingModel: LAB_SIMULATOR_MODELING_BASIS,
    }));

    // The account's pool entries (in exposure order — the interactions iterate them).
    const accountEntries = ordered.filter((entry) => entry.item.source === 'account');

    // The per-(segment, item) response draws (the FIXED consumption
    // order: segment declared order × account pool order).
    const interactionsRecord: Array<{
      segment: string;
      sessions: number;
      views: number;
      skips: number;
      engagements: number;
      shares: number;
      clicks: number;
      conversions: number;
      revenue: number;
      followersGained: number;
    }> = [];
    const perItemViews = new Map<string, number>();
    const perItemEngagements = new Map<string, number>();
    const perItemImpressions = new Map<string, number>();
    const perItemPosition = new Map<string, number>();

    for (let s = 0; s < segments.length; s += 1) {
      const segment = segments[s]!;
      const sessions = segmentSessions[s]!;
      let segViews = 0;
      let segSkips = 0;
      let segEngagements = 0;
      let segShares = 0;
      let segClicks = 0;
      let segConversions = 0;
      let segRevenue = 0;
      let segFollowers = 0;

      for (const entry of accountEntries) {
        const item = entry.item;
        const index = ordered.indexOf(entry);
        const share = normalizedShares[index]!;
        const exposureCount = Math.round(sessions * share);
        perItemImpressions.set(item.itemId, (perItemImpressions.get(item.itemId) ?? 0) + exposureCount);
        if (!perItemPosition.has(item.itemId)) {
          perItemPosition.set(item.itemId, index + 1);
        }

        // The stateful response drivers.
        const exposureKey = `${segment.name}::${item.itemId}`;
        const exposureCountSoFar = exposures.get(exposureKey) ?? 0;
        const novelty = 1 / (1 + exposureCountSoFar);
        const fatigueValue = fatigue.get(`${segment.name}::${item.topic}`) ?? 0;
        const fatiguePenalty = Math.min(1, fatigueValue) * knobs.fatigue.responsePenalty;
        const affinity = (segment.affinity as Record<string, number>)[item.topic] ?? 0;

        // The declared response probabilities (the DISCLOSED formulas).
        const pView = clamp01(
          knobs.interaction.baseViewProbability +
            affinity * 0.25 +
            knobs.novelty.noveltyBias * novelty -
            fatiguePenalty +
            (item.quality - 0.5) * knobs.interaction.qualitySensitivity * 0.5,
        );
        const pEngage = clamp01(knobs.interaction.engagePerViewProbability * (0.5 + item.quality));
        const pShare = clamp01(knobs.interaction.sharePerEngageProbability * (0.5 + 0.5 * novelty));
        const pClick = clamp01(knobs.conversion.viewToClickProbability + affinity * 0.25);

        // The stochastic counts (the aggregate binomial approximation — 15 uniforms per (segment, item), always consumed).
        const expectedViews = exposureCount * pView;
        const views = stochasticCount(
          [rng.interactions.nextFloat(), rng.interactions.nextFloat(), rng.interactions.nextFloat()],
          expectedViews,
          exposureCount,
        );
        const skips = Math.max(0, exposureCount - views);
        const expectedEngagements = views * pEngage;
        const engagements = stochasticCount(
          [rng.interactions.nextFloat(), rng.interactions.nextFloat(), rng.interactions.nextFloat()],
          expectedEngagements,
          views,
        );
        const expectedShares = engagements * pShare;
        const shares = stochasticCount(
          [rng.interactions.nextFloat(), rng.interactions.nextFloat(), rng.interactions.nextFloat()],
          expectedShares,
          engagements,
        );
        const expectedClicks = views * pClick;
        const clicks = stochasticCount(
          [rng.interactions.nextFloat(), rng.interactions.nextFloat(), rng.interactions.nextFloat()],
          expectedClicks,
          views,
        );
        const expectedConversions = clicks * knobs.conversion.clickToConversionProbability;
        const conversions = stochasticCount(
          [rng.interactions.nextFloat(), rng.interactions.nextFloat(), rng.interactions.nextFloat()],
          expectedConversions,
          clicks,
        );
        const revenue = round4(conversions * knobs.conversion.conversionValue);
        const followersGained = Math.round((engagements + shares) * knobs.account.followerGainPerEngagement);

        segViews += views;
        segSkips += skips;
        segEngagements += engagements;
        segShares += shares;
        segClicks += clicks;
        segConversions += conversions;
        segRevenue += revenue;
        segFollowers += followersGained;
        perItemViews.set(item.itemId, (perItemViews.get(item.itemId) ?? 0) + views);
        perItemEngagements.set(item.itemId, (perItemEngagements.get(item.itemId) ?? 0) + engagements);
      }

      interactionsRecord.push({
        segment: segment.name,
        sessions,
        views: segViews,
        skips: segSkips,
        engagements: segEngagements,
        shares: segShares,
        clicks: segClicks,
        conversions: segConversions,
        revenue: round4(segRevenue),
        followersGained: segFollowers,
      });
    }

    // The state updates (the stateful dynamics — fatigue accumulates
    // over the account's pool items per topic, then decays; novelty
    // exposure counts increment).
    for (const entry of accountEntries) {
      const item = entry.item;
      for (const segment of segments) {
        const key = `${segment.name}::${item.topic}`;
        fatigue.set(key, (fatigue.get(key) ?? 0) + knobs.fatigue.incrementPerExposure);
        const exposureKey = `${segment.name}::${item.itemId}`;
        exposures.set(exposureKey, (exposures.get(exposureKey) ?? 0) + 1);
      }
    }
    for (const key of [...fatigue.keys()]) {
      fatigue.set(key, (fatigue.get(key) ?? 0) * (1 - knobs.fatigue.decayPerStep));
    }

    // ------------------------------------------------------------------
    // (7) THE STEP AGGREGATES.
    // ------------------------------------------------------------------
    const stepImpressions = accountEntries.reduce(
      (sum, entry) => sum + (exposureRecord.find((decision) => decision.itemId === entry.item.itemId)?.impressions ?? 0),
      0,
    );
    const stepViews = interactionsRecord.reduce((sum, record) => sum + record.views, 0);
    const stepEngagements = interactionsRecord.reduce((sum, record) => sum + record.engagements, 0);
    const stepShares = interactionsRecord.reduce((sum, record) => sum + record.shares, 0);
    const stepClicks = interactionsRecord.reduce((sum, record) => sum + record.clicks, 0);
    const stepConversions = interactionsRecord.reduce((sum, record) => sum + record.conversions, 0);
    const stepRevenue = round4(interactionsRecord.reduce((sum, record) => sum + record.revenue, 0));
    const stepFollowersGained = interactionsRecord.reduce((sum, record) => sum + record.followersGained, 0);

    totalImpressions += stepImpressions;
    totalViews += stepViews;
    totalEngagements += stepEngagements;
    totalShares += stepShares;
    totalClicks += stepClicks;
    totalConversions += stepConversions;
    totalRevenue = round4(totalRevenue + stepRevenue);
    totalFollowersGained += stepFollowersGained;
    followers += stepFollowersGained;

    const metrics = {
      impressions: stepImpressions,
      views: stepViews,
      engagements: stepEngagements,
      shares: stepShares,
      clicks: stepClicks,
      conversions: stepConversions,
      revenue: stepRevenue,
      followersGained: stepFollowersGained,
      competitorPostCount: competitorPosts.length,
    };

    const topicTrendsRecord: Record<string, number> = {};
    for (const topic of topics) {
      topicTrendsRecord[topic.name] = round4(topicTrends.get(topic.name)!);
    }

    // The deterministic step digest (the full loop telemetry).
    const stepDigest = computeLabSimulatorStepDigest({
      seq,
      candidates: candidatesRecord,
      exposure: exposureRecord,
      interactions: interactionsRecord,
      competitorPosts,
      topicTrends: topicTrendsRecord,
      metrics,
    });

    // ------------------------------------------------------------------
    // (8) THE OBSERVABLE PROJECTION (the observable/hidden split):
    //     ONLY the surfaces the platform would show — the counts, the
    //     account state, the per-post analytics. NO ranking scores, NO
    //     fatigue, NO trends, NO probabilities (the model internals
    //     never enter the agent-facing state).
    // ------------------------------------------------------------------
    const observableState = {
      factuality: LAB_SIMULATOR_FACTUALITY,
      step: seq,
      impressions: metrics.impressions,
      views: metrics.views,
      engagements: metrics.engagements,
      shares: metrics.shares,
      clicks: metrics.clicks,
      conversions: metrics.conversions,
      revenue: metrics.revenue,
      account: {
        followers,
        totalViews,
        totalEngagements,
        totalConversions,
        totalRevenue,
      },
      items: accountEntries.map((entry) => ({
        itemId: entry.item.itemId,
        topic: entry.item.topic,
        position: perItemPosition.get(entry.item.itemId) ?? 0,
        impressions: perItemImpressions.get(entry.item.itemId) ?? 0,
        views: perItemViews.get(entry.item.itemId) ?? 0,
        engagements: perItemEngagements.get(entry.item.itemId) ?? 0,
      })),
      competitorPostsSeen: exposureRecord.filter((decision) => decision.source === 'competitor').length,
    };

    steps.push({
      seq,
      candidates: candidatesRecord,
      exposure: exposureRecord,
      interactions: interactionsRecord,
      competitorPosts,
      topicTrends: topicTrendsRecord,
      metrics,
      stepDigest,
      observableState,
      observableDigest: computeLabSimulatorObservableDigest(observableState),
    });
  }

  const trajectoryDigest = computeLabSimulatorTrajectoryDigest(steps.map((step) => step.stepDigest));

  return {
    steps,
    summary: {
      stepCount: steps.length,
      totalImpressions,
      totalViews,
      totalEngagements,
      totalShares,
      totalClicks,
      totalConversions,
      totalRevenue,
      totalFollowersGained,
    },
    trajectoryDigest,
  };
}
