/**
 * /lab-simulator contract guards (LAB-005) — the PURE deterministic
 * validation + digest core.
 *
 * These guards enforce the frozen Social-Simulator-Kernel contract
 * semantics (spec/architecture-v1.7-marketing-lab.md §8 "Social World
 * Model" — the closed vocabulary of world-model knobs, every knob
 * DECLARED DATA with its version, never an ambient global; §9 — the
 * recorded seed/configuration reproducibility pair; spec/
 * effective-backlog-v1.7.md LAB-005 acceptance: "deterministic seeded
 * replay plus stochastic runs; no invented hidden provider state"):
 *
 *   - THE SCOPE/KNOB FENCES: the closed world-model knob vocabulary
 *     (the topic space shape, the population segments with their
 *     share sum + exact affinity coverage, the bounded numeric ranges
 *     of every section — population/fatigue/ranking/trends/freshness/
 *     novelty/competition/account/conversion/constraints/interaction);
 *   - THE UNIVERSE CITATION FENCES: the closed citation-kind
 *     vocabulary, the citable reference shapes, the recorded-client
 *     tenant fence, the topics ⊆ the configuration's declared topics;
 *   - THE PUBLISHING-PLAN FENCES: the bounded in-range entries, the
 *     declared API/publishing constraints enforced (the per-step cap
 *     + the minimum steps between posts), no duplicate slots;
 *   - THE RUN/ENSEMBLE INPUT FENCES: the bounded step budget, the
 *     master-seed u64 shape, the member count ≥ 2 (an ensemble of
 *     ONE is inexpressible — a single run is never ground truth), the
 *     bounded declared configuration space, the closed outcome-metric
 *     vocabulary;
 *   - THE DETERMINISTIC DIGEST DERIVATIONS: the canonical JSON
 *     serialization (DEEP sorted keys — the LAB-003/LAB-004
 *     discipline; arrays keep their order) and the pure-function
 *     SHA-256 digests (the configuration digest over the knob set +
 *     the pinned versions; the seed digest over masterSeed +
 *     configDigest; the step digest over the canonical step content;
 *     the observable digest over the canonical observable projection;
 *     the trajectory digest over the ordered step-digest chain).
 *
 * Pure functions: no clock, no randomness, no network — the unit
 * battery pins every rule.
 */

import { createHash } from 'node:crypto';
import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import {
  LAB_SIMULATOR_CITATION_KINDS,
  LAB_SIMULATOR_MAX_CONFIG_VERSIONS,
  LAB_SIMULATOR_MAX_ENSEMBLE_CONFIGS,
  LAB_SIMULATOR_MAX_ENSEMBLE_MEMBERS,
  LAB_SIMULATOR_MAX_PLAN_ENTRIES,
  LAB_SIMULATOR_MAX_STEPS,
  LAB_SIMULATOR_MAX_UNIVERSE_ITEMS,
  LAB_SIMULATOR_MIN_ENSEMBLE_MEMBERS,
  LAB_SIMULATOR_OUTCOME_METRICS,
  LAB_SIMULATOR_RNG_ID,
  LAB_SIMULATOR_RNG_VERSION,
  LAB_SIMULATOR_WORLD_MODEL_VERSION,
  type CreateLabSimulatorEnsembleInput,
  type CreateLabSimulatorSeedInput,
  type CreateLabSimulatorWorldConfigInput,
  type LabSimulatorScope,
  type LabSimulatorUniverseItemCitation,
  type LabSimulatorWorldKnobs,
  type RunLabSimulationInput,
} from '../public.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MASTER_SEED_PATTERN = /^(0|[1-9][0-9]{0,19})$/;
const BUNDLE_REFERENCE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}#v[1-9][0-9]{0,3}$/;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;
/** The u64 upper bound, decimal: 2^64 − 1. */
const U64_MAX = 18_446_744_073_709_551_615n;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** A finite number in [min, max]. */
function inRange(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InvalidRequestError(`${label} must be a finite number`);
  }
  if (value < min || value > max) {
    throw new InvalidRequestError(`${label} must be within [${min}, ${max}]`);
  }
  return value;
}

/** An integer in [min, max]. */
function intInRange(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new InvalidRequestError(`${label} must be an integer`);
  }
  return inRange(value, min, max, label);
}

// ---------------------------------------------------------------------------
// The canonical JSON serialization (the reproducibility substrate).
// ---------------------------------------------------------------------------

/**
 * The canonical JSON serialization: DEEP sorted object keys (arrays
 * keep their order — array order is semantic), then JSON.stringify.
 * The same logical value always serializes identically regardless of
 * key insertion order — the deterministic-digest discipline.
 */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = sortDeep(record[key]);
  }
  return sorted;
}

export function labSimulatorCanonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Rounds to 4 decimals (the deterministic numeric-serialization discipline — every digested float is rounded first). */
export function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

// ---------------------------------------------------------------------------
// The scope + master-seed fences.
// ---------------------------------------------------------------------------

export function assertValidLabSimulatorScope(scope: LabSimulatorScope): void {
  if (scope === null || typeof scope !== 'object') {
    throw new InvalidRequestError('scope must be an object');
  }
  if (!isUuid(scope.agencyId)) {
    throw new InvalidRequestError('scope.agencyId must be a uuid');
  }
  if (!isUuid(scope.clientId)) {
    throw new InvalidRequestError('scope.clientId must be a uuid');
  }
  if (scope.workspaceId !== undefined && scope.workspaceId !== null && !isUuid(scope.workspaceId)) {
    throw new InvalidRequestError('scope.workspaceId must be a uuid when present');
  }
}

/** The master-seed fence: the decimal string of an unsigned 64-bit integer [0, 2^64). */
export function assertValidLabSimulatorMasterSeed(masterSeed: string): void {
  if (typeof masterSeed !== 'string' || !MASTER_SEED_PATTERN.test(masterSeed)) {
    throw new InvalidRequestError('masterSeed must be the decimal string of an unsigned 64-bit integer [0, 2^64)');
  }
  if (BigInt(masterSeed) > U64_MAX) {
    throw new InvalidRequestError('masterSeed must be the decimal string of an unsigned 64-bit integer [0, 2^64)');
  }
}

// ---------------------------------------------------------------------------
// THE WORLD-MODEL KNOB FENCES (the closed vocabulary — §8 verbatim coverage).
// ---------------------------------------------------------------------------

/**
 * The full knob-set fences: the closed vocabulary of world-model
 * knobs with their bounded numeric ranges. Every knob is DECLARED DATA
 * under LAB_SIMULATOR_WORLD_MODEL_VERSION — never an ambient global.
 */
export function assertValidLabSimulatorKnobs(knobs: LabSimulatorWorldKnobs): void {
  if (knobs === null || typeof knobs !== 'object') {
    throw new InvalidRequestError('knobs must be an object');
  }

  // --- The topic space shape (the preference/topic space). ---
  if (!Array.isArray(knobs.topics)) {
    throw new InvalidRequestError('knobs.topics must be an array');
  }
  if (knobs.topics.length < 1 || knobs.topics.length > 32) {
    throw new InvalidRequestError('knobs.topics must hold 1-32 declared topics');
  }
  const topicNames = new Set<string>();
  for (const topic of knobs.topics) {
    if (topic === null || typeof topic !== 'object') {
      throw new InvalidRequestError('each declared topic must be an object');
    }
    if (typeof topic.name !== 'string' || !NAME_PATTERN.test(topic.name)) {
      throw new InvalidRequestError('each declared topic name must be 1-64 chars of [A-Za-z0-9 _-]');
    }
    if (topicNames.has(topic.name)) {
      throw new InvalidRequestError(`the declared topic '${topic.name}' is duplicated`);
    }
    topicNames.add(topic.name);
    inRange(topic.baselineInterest, 0, 1, `topics['${topic.name}'].baselineInterest`);
  }

  // --- The user population + its segment distributions. ---
  const population = knobs.population;
  if (population === null || typeof population !== 'object') {
    throw new InvalidRequestError('knobs.population must be an object');
  }
  intInRange(population.totalUsers, 1, 10_000_000, 'knobs.population.totalUsers');
  if (!Array.isArray(population.segments)) {
    throw new InvalidRequestError('knobs.population.segments must be an array');
  }
  if (population.segments.length < 1 || population.segments.length > 16) {
    throw new InvalidRequestError('knobs.population.segments must hold 1-16 segments');
  }
  const segmentNames = new Set<string>();
  let shareSum = 0;
  for (const segment of population.segments) {
    if (segment === null || typeof segment !== 'object') {
      throw new InvalidRequestError('each population segment must be an object');
    }
    if (typeof segment.name !== 'string' || !NAME_PATTERN.test(segment.name)) {
      throw new InvalidRequestError('each population segment name must be 1-64 chars of [A-Za-z0-9 _-]');
    }
    if (segmentNames.has(segment.name)) {
      throw new InvalidRequestError(`the population segment '${segment.name}' is duplicated`);
    }
    segmentNames.add(segment.name);
    inRange(segment.share, 0, 1, `population.segments['${segment.name}'].share`);
    shareSum += segment.share;
    inRange(segment.sessionRatePerStep, 0, 1000, `population.segments['${segment.name}'].sessionRatePerStep`);
    // The affinity map must cover the configuration's topics EXACTLY (the preference shape).
    if (segment.affinity === null || typeof segment.affinity !== 'object' || Array.isArray(segment.affinity)) {
      throw new InvalidRequestError(`population.segments['${segment.name}'].affinity must be an object`);
    }
    const affinityKeys = Object.keys(segment.affinity);
    if (affinityKeys.length !== topicNames.size || affinityKeys.some((key) => !topicNames.has(key))) {
      throw new InvalidRequestError(
        `population.segments['${segment.name}'].affinity must cover the declared topics exactly (no extra keys)`,
      );
    }
    for (const key of affinityKeys) {
      inRange((segment.affinity as Record<string, unknown>)[key], -1, 1, `affinity['${key}'] of segment '${segment.name}'`);
    }
  }
  if (Math.abs(shareSum - 1) > 1e-6) {
    throw new InvalidRequestError('the population segment shares must sum to 1');
  }

  // --- The fatigue/repetition response. ---
  const fatigue = knobs.fatigue;
  if (fatigue === null || typeof fatigue !== 'object') {
    throw new InvalidRequestError('knobs.fatigue must be an object');
  }
  inRange(fatigue.incrementPerExposure, 0, 1, 'knobs.fatigue.incrementPerExposure');
  inRange(fatigue.decayPerStep, 0, 1, 'knobs.fatigue.decayPerStep');
  inRange(fatigue.responsePenalty, 0, 1, 'knobs.fatigue.responsePenalty');

  // --- The ranking/exposure curve (THE DECLARED MODELING ASSUMPTION). ---
  const ranking = knobs.ranking;
  if (ranking === null || typeof ranking !== 'object') {
    throw new InvalidRequestError('knobs.ranking must be an object');
  }
  inRange(ranking.exposureTopWeight, 0, 1, 'knobs.ranking.exposureTopWeight');
  inRange(ranking.exposureDecayPower, 0, 10, 'knobs.ranking.exposureDecayPower');
  inRange(ranking.explorationRate, 0, 1, 'knobs.ranking.explorationRate');
  intInRange(ranking.candidatePoolSize, 1, 64, 'knobs.ranking.candidatePoolSize');

  // --- The trend/temporal parameters. ---
  const trends = knobs.trends;
  if (trends === null || typeof trends !== 'object') {
    throw new InvalidRequestError('knobs.trends must be an object');
  }
  inRange(trends.volatility, 0, 1, 'knobs.trends.volatility');
  inRange(trends.persistence, 0, 1, 'knobs.trends.persistence');
  inRange(trends.seasonalityAmplitude, 0, 1, 'knobs.trends.seasonalityAmplitude');
  intInRange(trends.seasonalityPeriodSteps, 1, 10_000, 'knobs.trends.seasonalityPeriodSteps');

  // --- The freshness decay. ---
  const freshness = knobs.freshness;
  if (freshness === null || typeof freshness !== 'object') {
    throw new InvalidRequestError('knobs.freshness must be an object');
  }
  intInRange(freshness.halfLifeSteps, 1, 10_000, 'knobs.freshness.halfLifeSteps');

  // --- The novelty response. ---
  const novelty = knobs.novelty;
  if (novelty === null || typeof novelty !== 'object') {
    throw new InvalidRequestError('knobs.novelty must be an object');
  }
  inRange(novelty.noveltyBias, 0, 1, 'knobs.novelty.noveltyBias');

  // --- The creator competition. ---
  const competition = knobs.competition;
  if (competition === null || typeof competition !== 'object') {
    throw new InvalidRequestError('knobs.competition must be an object');
  }
  intInRange(competition.competitorCount, 0, 1000, 'knobs.competition.competitorCount');
  inRange(competition.competitorQualityMean, 0, 1, 'knobs.competition.competitorQualityMean');
  inRange(competition.competitorQualitySigma, 0, 1, 'knobs.competition.competitorQualitySigma');
  intInRange(competition.competitorPostsPerStep, 0, 100, 'knobs.competition.competitorPostsPerStep');

  // --- The account state. ---
  const account = knobs.account;
  if (account === null || typeof account !== 'object') {
    throw new InvalidRequestError('knobs.account must be an object');
  }
  intInRange(account.initialFollowers, 0, 10_000_000, 'knobs.account.initialFollowers');
  inRange(account.followerGainPerEngagement, 0, 1, 'knobs.account.followerGainPerEngagement');

  // --- The business/product conversion behavior. ---
  const conversion = knobs.conversion;
  if (conversion === null || typeof conversion !== 'object') {
    throw new InvalidRequestError('knobs.conversion must be an object');
  }
  inRange(conversion.viewToClickProbability, 0, 1, 'knobs.conversion.viewToClickProbability');
  inRange(conversion.clickToConversionProbability, 0, 1, 'knobs.conversion.clickToConversionProbability');
  inRange(conversion.conversionValue, 0, 1_000_000, 'knobs.conversion.conversionValue');

  // --- The observable platform + API/publishing constraints. ---
  const constraints = knobs.constraints;
  if (constraints === null || typeof constraints !== 'object') {
    throw new InvalidRequestError('knobs.constraints must be an object');
  }
  intInRange(constraints.maxAccountPostsPerStep, 1, 64, 'knobs.constraints.maxAccountPostsPerStep');
  intInRange(constraints.minStepsBetweenPosts, 0, 100, 'knobs.constraints.minStepsBetweenPosts');

  // --- The interaction response model. ---
  const interaction = knobs.interaction;
  if (interaction === null || typeof interaction !== 'object') {
    throw new InvalidRequestError('knobs.interaction must be an object');
  }
  inRange(interaction.baseViewProbability, 0, 1, 'knobs.interaction.baseViewProbability');
  inRange(interaction.engagePerViewProbability, 0, 1, 'knobs.interaction.engagePerViewProbability');
  inRange(interaction.sharePerEngageProbability, 0, 1, 'knobs.interaction.sharePerEngageProbability');
  inRange(interaction.qualitySensitivity, 0, 1, 'knobs.interaction.qualitySensitivity');
}

// ---------------------------------------------------------------------------
// The universe-citation + publishing-plan fences.
// ---------------------------------------------------------------------------

/**
 * The content-universe citation fences: the closed citation-kind
 * vocabulary, the citable reference shapes, the recorded-client tenant
 * fence (the citations must carry the SCOPE's client as their
 * recorded owner), the topics ⊆ the configuration's declared topics,
 * the bounded quality. OPAQUE recorded data ONLY — never a join.
 */
export function assertValidLabSimulatorUniverse(
  scope: LabSimulatorScope,
  universe: ReadonlyArray<LabSimulatorUniverseItemCitation>,
  topicNames: ReadonlySet<string>,
): void {
  if (!Array.isArray(universe)) {
    throw new InvalidRequestError('contentUniverse must be an array');
  }
  if (universe.length < 1 || universe.length > LAB_SIMULATOR_MAX_UNIVERSE_ITEMS) {
    throw new InvalidRequestError(`contentUniverse must hold 1-${LAB_SIMULATOR_MAX_UNIVERSE_ITEMS} cited items`);
  }
  const references = new Set<string>();
  for (let i = 0; i < universe.length; i += 1) {
    const item = universe[i]!;
    if (item === null || typeof item !== 'object') {
      throw new InvalidRequestError(`contentUniverse[${i}] must be an object`);
    }
    if (!LAB_SIMULATOR_CITATION_KINDS.includes(item.citationKind)) {
      throw new InvalidRequestError(`contentUniverse[${i}].citationKind must be one of ${LAB_SIMULATOR_CITATION_KINDS.join(', ')}`);
    }
    if (typeof item.reference !== 'string' || item.reference.length < 1 || item.reference.length > 256) {
      throw new InvalidRequestError(`contentUniverse[${i}].reference must be a string of 1-256 chars`);
    }
    if (item.citationKind === 'lab-features-bundle' && !BUNDLE_REFERENCE_PATTERN.test(item.reference)) {
      throw new InvalidRequestError(`contentUniverse[${i}].reference must be the citable bundle form '<bundleId>#v<n>' for feature-bundle citations`);
    }
    if (item.citationKind === 'lab-ideas-node' && !UUID_PATTERN.test(item.reference)) {
      throw new InvalidRequestError(`contentUniverse[${i}].reference must be the idea-node uuid for idea-node citations`);
    }
    if (references.has(item.citationKind + ':' + item.reference)) {
      throw new InvalidRequestError(`contentUniverse[${i}] duplicates an already-cited item`);
    }
    references.add(item.citationKind + ':' + item.reference);
    if (!isUuid(item.recordedClientId)) {
      throw new InvalidRequestError(`contentUniverse[${i}].recordedClientId must be a uuid`);
    }
    if (item.recordedClientId !== scope.clientId) {
      throw new InvalidRequestError(
        `contentUniverse[${i}] cites an artifact recorded under client ${item.recordedClientId} — cross-tenant citations are rejected (the recorded-data tenant fence)`,
      );
    }
    if (typeof item.topic !== 'string' || !topicNames.has(item.topic)) {
      throw new InvalidRequestError(`contentUniverse[${i}].topic must be one of the configuration's declared topics`);
    }
    inRange(item.quality, 0, 1, `contentUniverse[${i}].quality`);
  }
}

/**
 * The publishing-plan fences: the bounded entries in range, the
 * declared API/publishing CONSTRAINTS enforced (the observable
 * platform contract the world model declares), no duplicate
 * (itemIndex, atStep) slots. THE DECLARED CONSTRAINTS ARE WORLD-MODEL
 * DATA — a plan that violates them is refused before anything is
 * simulated (fail closed).
 */
export function assertValidLabSimulatorPublishingPlan(
  plan: ReadonlyArray<{ itemIndex: number; atStep: number }>,
  universeSize: number,
  stepBudget: number,
  constraints: { maxAccountPostsPerStep: number; minStepsBetweenPosts: number },
): void {
  if (plan === null || typeof plan !== 'object' || !Array.isArray(plan)) {
    throw new InvalidRequestError('publishingPlan must be an array');
  }
  if (plan.length > LAB_SIMULATOR_MAX_PLAN_ENTRIES) {
    throw new InvalidRequestError(`publishingPlan must hold at most ${LAB_SIMULATOR_MAX_PLAN_ENTRIES} entries`);
  }
  const slots = new Set<string>();
  for (let i = 0; i < plan.length; i += 1) {
    const entry = plan[i]!;
    if (entry === null || typeof entry !== 'object') {
      throw new InvalidRequestError(`publishingPlan[${i}] must be an object`);
    }
    intInRange(entry.itemIndex, 0, universeSize - 1, `publishingPlan[${i}].itemIndex`);
    intInRange(entry.atStep, 1, stepBudget, `publishingPlan[${i}].atStep`);
    const slot = `${entry.itemIndex}@${entry.atStep}`;
    if (slots.has(slot)) {
      throw new InvalidRequestError(`publishingPlan[${i}] duplicates the slot ${slot}`);
    }
    slots.add(slot);
  }
  // The declared observable platform constraints, enforced on the plan.
  const perStep = new Map<number, number>();
  for (const entry of plan) {
    perStep.set(entry.atStep, (perStep.get(entry.atStep) ?? 0) + 1);
  }
  for (const [step, count] of [...perStep.entries()].sort((a, b) => a[0] - b[0])) {
    if (count > constraints.maxAccountPostsPerStep) {
      throw new InvalidRequestError(
        `the publishing plan posts ${count} items at step ${step} — the declared platform constraint allows at most ${constraints.maxAccountPostsPerStep} per step`,
      );
    }
  }
  const steps = [...perStep.keys()].sort((a, b) => a - b);
  for (let i = 1; i < steps.length; i += 1) {
    const gap = steps[i]! - steps[i - 1]! - 1;
    if (gap < constraints.minStepsBetweenPosts) {
      throw new InvalidRequestError(
        `the publishing plan leaves only ${gap} steps between the posts at steps ${steps[i - 1]} and ${steps[i]} — the declared platform constraint requires at least ${constraints.minStepsBetweenPosts}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The run/ensemble input fences.
// ---------------------------------------------------------------------------

export function assertValidLabSimulatorRunInput(input: RunLabSimulationInput): void {
  assertValidLabSimulatorScope(input.scope);
  if (!isUuid(input.seedId)) {
    throw new InvalidRequestError('seedId must be a uuid');
  }
  intInRange(input.stepBudget, 1, LAB_SIMULATOR_MAX_STEPS, 'stepBudget');
}

export function assertValidLabSimulatorEnsembleInput(input: CreateLabSimulatorEnsembleInput): void {
  assertValidLabSimulatorScope(input.scope);
  intInRange(input.memberCount, LAB_SIMULATOR_MIN_ENSEMBLE_MEMBERS, LAB_SIMULATOR_MAX_ENSEMBLE_MEMBERS, 'memberCount');
  if (input.ensembleSeed !== undefined) {
    assertValidLabSimulatorMasterSeed(input.ensembleSeed);
  }
  if (!Array.isArray(input.configCitations) || input.configCitations.length < 1 || input.configCitations.length > LAB_SIMULATOR_MAX_ENSEMBLE_CONFIGS) {
    throw new InvalidRequestError(`configCitations must hold 1-${LAB_SIMULATOR_MAX_ENSEMBLE_CONFIGS} configuration citations`);
  }
  const seen = new Set<string>();
  for (let i = 0; i < input.configCitations.length; i += 1) {
    const citation = input.configCitations[i]!;
    if (citation === null || typeof citation !== 'object') {
      throw new InvalidRequestError(`configCitations[${i}] must be an object`);
    }
    if (!isUuid(citation.configId)) {
      throw new InvalidRequestError(`configCitations[${i}].configId must be a uuid`);
    }
    intInRange(citation.configVersion, 1, LAB_SIMULATOR_MAX_CONFIG_VERSIONS, `configCitations[${i}].configVersion`);
    const key = `${citation.configId}#v${citation.configVersion}`;
    if (seen.has(key)) {
      throw new InvalidRequestError(`configCitations[${i}] duplicates the configuration citation ${key}`);
    }
    seen.add(key);
  }
  if (input.outcomeMetric !== undefined && input.outcomeMetric !== null) {
    if (!LAB_SIMULATOR_OUTCOME_METRICS.includes(input.outcomeMetric)) {
      throw new InvalidRequestError(`outcomeMetric must be one of ${LAB_SIMULATOR_OUTCOME_METRICS.join(', ')}`);
    }
  }
  intInRange(input.stepBudget, 1, LAB_SIMULATOR_MAX_STEPS, 'stepBudget');
}

// ---------------------------------------------------------------------------
// The deterministic digest derivations (the reproducibility substrate).
// ---------------------------------------------------------------------------

/**
 * The deterministic CONFIGURATION digest: SHA-256 over the canonical
 * JSON of (the knob set, the world-model version, the declared RNG
 * identity + version). The same knobs + pinned versions are the same
 * configuration, ever — the idempotence fence.
 */
export function computeLabSimulatorConfigDigest(knobs: LabSimulatorWorldKnobs): string {
  return sha256Hex(
    labSimulatorCanonicalJson({
      worldModelVersion: LAB_SIMULATOR_WORLD_MODEL_VERSION,
      rngId: LAB_SIMULATOR_RNG_ID,
      rngVersion: LAB_SIMULATOR_RNG_VERSION,
      knobs,
    }),
  );
}

/** The deterministic SEED digest: SHA-256 over the canonical JSON of (masterSeed, configDigest). */
export function computeLabSimulatorSeedDigest(masterSeed: string, configDigest: string): string {
  return sha256Hex(labSimulatorCanonicalJson({ masterSeed, configDigest }));
}

/** The deterministic STEP digest: SHA-256 over the canonical JSON of the full step content (the loop telemetry). */
export function computeLabSimulatorStepDigest(step: {
  seq: number;
  candidates: unknown;
  exposure: unknown;
  interactions: unknown;
  competitorPosts: unknown;
  topicTrends: unknown;
  metrics: unknown;
}): string {
  return sha256Hex(
    labSimulatorCanonicalJson({
      seq: step.seq,
      candidates: step.candidates,
      exposure: step.exposure,
      interactions: step.interactions,
      competitorPosts: step.competitorPosts,
      topicTrends: step.topicTrends,
      metrics: step.metrics,
    }),
  );
}

/** The deterministic OBSERVABLE digest: SHA-256 over the canonical observable projection (the agent-facing trajectory identity). */
export function computeLabSimulatorObservableDigest(observableState: unknown): string {
  return sha256Hex(labSimulatorCanonicalJson(observableState));
}

/** The deterministic TRAJECTORY digest: SHA-256 over the ordered step-digest chain (a pure function of the recorded step rows). */
export function computeLabSimulatorTrajectoryDigest(stepDigests: ReadonlyArray<string>): string {
  return sha256Hex(stepDigests.join('\n'));
}

// ---------------------------------------------------------------------------
// The create-input fences (the whole-call shape gates).
// ---------------------------------------------------------------------------

export function assertValidLabSimulatorCreateConfigInput(input: CreateLabSimulatorWorldConfigInput): void {
  assertValidLabSimulatorScope(input.scope);
  assertValidLabSimulatorKnobs(input.knobs);
  if (input.configId !== undefined && input.configId !== null) {
    if (!isUuid(input.configId)) {
      throw new InvalidRequestError('configId must be a uuid when extending an existing chain');
    }
  }
}

export function assertValidLabSimulatorCreateSeedInput(input: CreateLabSimulatorSeedInput): void {
  assertValidLabSimulatorScope(input.scope);
  assertValidLabSimulatorMasterSeed(input.masterSeed);
  if (!isUuid(input.configId)) {
    throw new InvalidRequestError('configId must be a uuid');
  }
  intInRange(input.configVersion, 1, LAB_SIMULATOR_MAX_CONFIG_VERSIONS, 'configVersion');
}
