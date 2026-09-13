/**
 * The PURE /profit-intelligence derivations (MKT-043).
 *
 * Everything in this file is a PURE FUNCTION over plain record snapshots:
 * the module implementation does all I/O (the composed authorities' public
 * contracts) and hands the snapshots here; the same inputs + the same
 * calculation version always derive the same figures (the pinning proof —
 * no hidden state, no clock reads, no randomness, no I/O).
 *
 * Honesty rules baked into every figure:
 *   - a value is NULL with an explicit reason when it is not derivable —
 *     never a silent zero, never an invented conversion;
 *   - revenue groups by its DECLARED unit and is never converted;
 *   - estimated figures (declared intent + assumptions) never mix into
 *     observed figures (records of what happened);
 *   - every figure cites the canonical record ids it was derived from and
 *     the assumption-set keys it consumed.
 */

import type { MetricObservationRecord } from '../../metrics/public.ts';
import type { ExecutionRecord } from '../../executions/public.ts';
import type { UsageTelemetryRecord } from '../../ai-runtime/public.ts';
import type { JobRecord } from '../../jobs/public.ts';
import type { HumanAgentRecord } from '../../field-agents/public.ts';
import type { GoalRecord } from '../../goals/public.ts';
import type { DeploymentRecord } from '../../deployments/public.ts';
import type { WorkflowInstanceRecord } from '../../workflows/public.ts';
// The /integrations canonical record types are consumed READ-ONLY through
// the /integrations public contract (the frozen matrix line added for
// MKT-043). The snapshot row types below are DERIVED from the public
// contract's own listing-method return types — they ARE the exact
// canonical record types (type identity preserved, never a shadow shape).
// They are derived this way because the MKT-023 INT-001 string-level
// trip-wire (tests/architecture/integrations-connectors-boundary.test.ts)
// forbids the canonical record type-name STRING outside /integrations:
// this file declares NO adapter, connection or webhook surface of its
// own (no second integration boundary).
import type { IntegrationsModuleApi } from '../../integrations/public.ts';

/** The canonical /integrations connection record — the exact public-contract return type. */
type IntegrationConnectionSnapshotRow = Awaited<
  ReturnType<IntegrationsModuleApi['listConnectionsForClient']>
>[number];
/** The canonical /integrations ingested-event record — the exact public-contract return type. */
type IntegrationIngestedEventSnapshotRow = Awaited<
  ReturnType<IntegrationsModuleApi['listIngestedEventsForClient']>
>[number];
import type {
  AdapterActivityRow,
  AiProviderCostSurface,
  CalculationDisclosure,
  ClientContributionRow,
  DeliveryCostBreakdown,
  ExecutionKindCounts,
  HumanCapacitySurface,
  MarginSurface,
  ProfitFigure,
  ProfitSourceRef,
  RevenueCurrencyFigure,
  RevenueRollup,
  ScopeLeakageIndicator,
  ScopeLeakageSurface,
  ServiceContributionRow,
  ProjectContributionRow,
  UtilizationSurface,
} from '../public.ts';
import {
  PROFIT_INTELLIGENCE_ASSUMPTIONS,
  PROFIT_INTELLIGENCE_CALCULATION_VERSION,
} from '../public.ts';

// ---------------------------------------------------------------------------
// The derivation input snapshot (re-exported through the public entry)
// ---------------------------------------------------------------------------

/**
 * One delivered/in-flight job as enumerated through the /jobs public
 * contract: the job record + the ACCEPTED offer through which the module
 * reached it (the offer id is provenance — the enumeration evidence).
 */
export interface ResolvedJobRef {
  readonly job: JobRecord;
  readonly acceptedOfferId: string;
}

/**
 * The pure derivation input: plain record snapshots gathered through the
 * composed authorities' PUBLIC CONTRACTS (the module does all I/O; this
 * structure is what the pure functions consume — unit tests feed
 * fixtures). Everything is scoped to ONE CLIENT (or one WORKSPACE slice)
 * plus the agency human-agent pool context.
 */
export interface ClientAuthoritySnapshot {
  readonly agencyId: string;
  readonly clientId: string;
  /** null at client granularity — the workspace-slice filter. */
  readonly workspaceId: string | null;
  /** The Client's goals (all lifecycle states). */
  readonly goals: readonly GoalRecord[];
  /** The Client's metric observations (the bounded client listing). */
  readonly metricObservations: readonly MetricObservationRecord[];
  /** Per-workspace scope rows: deployments, instances, definitions chain, executions, telemetry. */
  readonly workspaces: ReadonlyArray<{
    readonly workspaceId: string;
    readonly deployments: readonly DeploymentRecord[];
    readonly instances: readonly WorkflowInstanceRecord[];
    /** instance id → its pinned workflow definition id. */
    readonly instanceDefinitionIds: ReadonlyMap<string, string>;
    /** definition id → pinned playbook version id (nullable — a definition may carry none). */
    readonly definitionPlaybookVersionIds: ReadonlyMap<string, string | null>;
    readonly executions: readonly ExecutionRecord[];
    readonly usageTelemetry: readonly UsageTelemetryRecord[];
  }>;
  /** Jobs of the agency's human agents that resolved INTO this client scope. */
  readonly resolvedJobs: readonly ResolvedJobRef[];
  /** The agency's human-agent profiles (capacity pool context). */
  readonly humanAgentProfiles: readonly HumanAgentRecord[];
  /** Membership users with NO resolvable profile (the skipped count). */
  readonly missingProfileUserIds: readonly string[];
  /** The Client's integration connections + ingested adapter events. */
  readonly connections: readonly IntegrationConnectionSnapshotRow[];
  readonly ingestedEvents: readonly IntegrationIngestedEventSnapshotRow[];
  /** playbook version id → owning playbook id (the attribution chain resolution). */
  readonly playbookVersionOwners: ReadonlyMap<string, string>;
}

/** The metric identity key: name + workspace scope + sorted dimensions. */
export interface MetricIdentityKey {
  readonly metricName: string;
  readonly dimensions: string;
  readonly workspaceId: string | null;
}

/** Deterministic metric-identity key of one observation. */
export function metricIdentityKeyOf(observation: MetricObservationRecord): string {
  const dimensionKeys = Object.keys(observation.dimensions).sort();
  const dimensionPart = dimensionKeys
    .map((key) => `${key}=${String(observation.dimensions[key])}`)
    .join(',');
  return `${observation.metricName}|${observation.workspaceId ?? 'client-wide'}|${dimensionPart}`;
}

// ---------------------------------------------------------------------------
// Figure constructors (the shared honesty plumbing)
// ---------------------------------------------------------------------------

function observedFigure(
  value: number,
  currency: string,
  sourceRefs: readonly ProfitSourceRef[],
  assumptionKeys: readonly string[],
): ProfitFigure {
  return {
    value,
    currency,
    provenance: 'observed',
    calculationVersion: PROFIT_INTELLIGENCE_CALCULATION_VERSION,
    sourceRefs,
    assumptionKeys,
    notDerivableReason: null,
  };
}

function estimatedFigure(
  value: number,
  currency: string,
  sourceRefs: readonly ProfitSourceRef[],
  assumptionKeys: readonly string[],
): ProfitFigure {
  return {
    value,
    currency,
    provenance: 'estimated',
    calculationVersion: PROFIT_INTELLIGENCE_CALCULATION_VERSION,
    sourceRefs,
    assumptionKeys,
    notDerivableReason: null,
  };
}

function notDerivableFigure(
  currency: string,
  reason: string,
  sourceRefs: readonly ProfitSourceRef[],
  assumptionKeys: readonly string[],
): ProfitFigure {
  return {
    value: null,
    currency,
    provenance: 'observed',
    calculationVersion: PROFIT_INTELLIGENCE_CALCULATION_VERSION,
    sourceRefs,
    assumptionKeys,
    notDerivableReason: reason,
  };
}

const ref = (kind: ProfitSourceRef['kind'], id: string): ProfitSourceRef => ({ kind, id });

function mergeRefs(...groups: readonly (readonly ProfitSourceRef[])[]): ProfitSourceRef[] {
  const seen = new Set<string>();
  const out: ProfitSourceRef[] = [];
  for (const group of groups) {
    for (const sourceRef of group) {
      const key = `${sourceRef.kind}:${sourceRef.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(sourceRef);
    }
  }
  return out;
}

function roundMoney(value: number): number {
  // Money figures round to cents: floating summation artifacts must never
  // leak into a derived figure (the pinning proof needs stable values).
  return Math.round(value * 100) / 100;
}

const COST_ASSUMPTION_KEYS = [
  'deterministicExecutionCostUsd',
  'extensionExecutionCostUsd',
  'humanDeliveredJobCostUsd',
  'costingCurrency',
  'telemetryCostCurrency',
  'humanExecutionCostAttribution',
] as const;

// ---------------------------------------------------------------------------
// Revenue (AC-5a): the latest-observation-wins rollup with evidence
// provenance, grouped by declared unit
// ---------------------------------------------------------------------------

/**
 * Derives the revenue rollup. Rule (the disclosed assumption
 * `latestObservationWinsPerMetricIdentity`): for each metric identity
 * (name + dimensions + workspace scope), the LATEST observation by
 * observedAt (recordedAt tiebreak) contributes; superseded predecessors
 * are counted (the disclosure) but never summed; figures group by the
 * DECLARED unit — no conversion, no mixing.
 */
export function deriveRevenueRollup(observations: readonly MetricObservationRecord[]): RevenueRollup {
  const revenueNames = new Set<string>(PROFIT_INTELLIGENCE_ASSUMPTIONS.revenueMetricNames);
  const inScope = observations.filter((observation) => revenueNames.has(observation.metricName));

  // Latest-wins per identity (observedAt, then recordedAt as tiebreak).
  const latestByIdentity = new Map<string, MetricObservationRecord>();
  for (const observation of inScope) {
    const key = metricIdentityKeyOf(observation);
    const prior = latestByIdentity.get(key);
    if (prior === undefined) {
      latestByIdentity.set(key, observation);
      continue;
    }
    const priorMoment = `${prior.observedAt}|${prior.provenance.recordedAt}`;
    const nextMoment = `${observation.observedAt}|${observation.provenance.recordedAt}`;
    if (nextMoment >= priorMoment) {
      latestByIdentity.set(key, observation);
    }
  }

  const contributing = [...latestByIdentity.values()];
  const supersededObservationCount = inScope.length - contributing.length;

  // Group by declared unit.
  const byCurrency = new Map<string, { total: number; identities: number; refs: ProfitSourceRef[] }>();
  for (const observation of contributing) {
    const entry = byCurrency.get(observation.unit) ?? { total: 0, identities: 0, refs: [] };
    entry.total = roundMoney(entry.total + observation.value);
    entry.identities += 1;
    entry.refs.push(ref('metric-observation', observation.observationId));
    byCurrency.set(observation.unit, entry);
  }
  const byCurrencyFigures: RevenueCurrencyFigure[] = [...byCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, entry]) => ({
      currency,
      total: observedFigure(
        entry.total,
        currency,
        entry.refs,
        ['revenueMetricNames', 'latestObservationWinsPerMetricIdentity'],
      ),
      identityCount: entry.identities,
      sourceRefs: entry.refs,
    }));

  const qualityCounts: Record<string, number> = {};
  for (const observation of contributing) {
    qualityCounts[observation.quality] = (qualityCounts[observation.quality] ?? 0) + 1;
  }
  const restatedIdentityCount = contributing.filter(
    (observation) => observation.quality === 'restated',
  ).length;
  const evidenceRefs = mergeRefs(
    contributing
      .filter((observation) => observation.evidenceRef !== null)
      .map((observation) => ref('evidence', observation.evidenceRef!)),
  );

  return {
    byCurrency: byCurrencyFigures,
    observationCount: inScope.length,
    restatedIdentityCount,
    supersededObservationCount,
    qualityCounts: { ...qualityCounts },
    evidenceRefs,
  };
}

/** Merges per-client revenue rollups into a portfolio rollup (pure). */
export function aggregateRevenueRollups(rollups: readonly RevenueRollup[]): RevenueRollup {
  const byCurrency = new Map<string, { total: number; identities: number; refs: ProfitSourceRef[] }>();
  for (const rollup of rollups) {
    for (const entry of rollup.byCurrency) {
      const prior = byCurrency.get(entry.currency) ?? { total: 0, identities: 0, refs: [] };
      prior.total = roundMoney(prior.total + entry.total.value!);
      prior.identities += entry.identityCount;
      prior.refs = mergeRefs(prior.refs, entry.sourceRefs);
      byCurrency.set(entry.currency, prior);
    }
  }
  const qualityCounts: Record<string, number> = {};
  let observationCount = 0;
  let restatedIdentityCount = 0;
  let supersededObservationCount = 0;
  const evidenceRefs = mergeRefs(...rollups.map((rollup) => rollup.evidenceRefs));
  for (const rollup of rollups) {
    observationCount += rollup.observationCount;
    restatedIdentityCount += rollup.restatedIdentityCount;
    supersededObservationCount += rollup.supersededObservationCount;
    for (const [quality, count] of Object.entries(rollup.qualityCounts)) {
      qualityCounts[quality] = (qualityCounts[quality] ?? 0) + count;
    }
  }
  return {
    byCurrency: [...byCurrency.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, entry]) => ({
        currency,
        total: observedFigure(
          entry.total,
          currency,
          entry.refs,
          ['revenueMetricNames', 'latestObservationWinsPerMetricIdentity'],
        ),
        identityCount: entry.identities,
        sourceRefs: entry.refs,
      })),
    observationCount,
    restatedIdentityCount,
    supersededObservationCount,
    qualityCounts: { ...qualityCounts },
    evidenceRefs,
  };
}

// ---------------------------------------------------------------------------
// AI/provider cost (AC-5c): telemetry spend + integrations adapter activity
// ---------------------------------------------------------------------------

/**
 * Derives the AI/provider cost surface: the observed telemetry spend plus
 * the integrations adapter activity (counts + references — deliberately
 * NOT costed; the authority carries no provider-billing data today).
 */
export function deriveAiProviderCostSurface(
  usageTelemetry: readonly UsageTelemetryRecord[],
  connections: readonly IntegrationConnectionSnapshotRow[],
  ingestedEvents: readonly IntegrationIngestedEventSnapshotRow[],
): AiProviderCostSurface {
  const total = usageTelemetry.reduce((sum, row) => sum + row.costAmount, 0);
  const telemetryCost = observedFigure(
    roundMoney(total),
    PROFIT_INTELLIGENCE_ASSUMPTIONS.telemetryCostCurrency,
    usageTelemetry.map((row) => ref('usage-telemetry', row.usageId)),
    ['telemetryCostCurrency'],
  );

  const adapters = new Map<
    string,
    { connections: IntegrationConnectionSnapshotRow[]; events: IntegrationIngestedEventSnapshotRow[] }
  >();
  for (const connection of connections) {
    const entry = adapters.get(connection.adapterKey) ?? { connections: [], events: [] };
    entry.connections.push(connection);
    adapters.set(connection.adapterKey, entry);
  }
  for (const event of ingestedEvents) {
    const entry = adapters.get(event.adapterKey) ?? { connections: [], events: [] };
    entry.events.push(event);
    adapters.set(event.adapterKey, entry);
  }
  const adapterActivity: AdapterActivityRow[] = [...adapters.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([adapterKey, entry]) => ({
      adapterKey,
      connectionCount: entry.connections.length,
      ingestedEventCount: entry.events.length,
      connectionRefs: entry.connections.map((connection) =>
        ref('integration-connection', connection.connectionId),
      ),
      eventRefs: entry.events.map((event) => ref('ingested-integration-event', event.eventId)),
    }));

  return {
    telemetryCost,
    telemetryRowCount: usageTelemetry.length,
    adapterActivity,
    adapterActivityNote:
      'integrations adapter activity is presented as counts + canonical references only: the /integrations authority carries no provider-billing amounts, and no per-event price assumption is invented',
  };
}

/** Merges per-client AI/provider cost surfaces (pure). */
export function aggregateAiProviderCostSurfaces(
  surfaces: readonly AiProviderCostSurface[],
): AiProviderCostSurface {
  const total = surfaces.reduce((sum, surface) => sum + (surface.telemetryCost.value ?? 0), 0);
  const merged = new Map<string, AdapterActivityRow>();
  for (const surface of surfaces) {
    for (const row of surface.adapterActivity) {
      const prior = merged.get(row.adapterKey);
      if (prior === undefined) {
        merged.set(row.adapterKey, { ...row });
        continue;
      }
      merged.set(row.adapterKey, {
        adapterKey: row.adapterKey,
        connectionCount: prior.connectionCount + row.connectionCount,
        ingestedEventCount: prior.ingestedEventCount + row.ingestedEventCount,
        connectionRefs: mergeRefs(prior.connectionRefs, row.connectionRefs),
        eventRefs: mergeRefs(prior.eventRefs, row.eventRefs),
      });
    }
  }
  return {
    telemetryCost: observedFigure(
      roundMoney(total),
      PROFIT_INTELLIGENCE_ASSUMPTIONS.telemetryCostCurrency,
      mergeRefs(...surfaces.map((surface) => surface.telemetryCost.sourceRefs)),
      ['telemetryCostCurrency'],
    ),
    telemetryRowCount: surfaces.reduce((sum, surface) => sum + surface.telemetryRowCount, 0),
    adapterActivity: [...merged.values()].sort((a, b) => a.adapterKey.localeCompare(b.adapterKey)),
    adapterActivityNote:
      'integrations adapter activity is presented as counts + canonical references only: the /integrations authority carries no provider-billing amounts, and no per-event price assumption is invented',
  };
}

// ---------------------------------------------------------------------------
// Delivery cost (AC-5b): the executions attempt ledger + delivered jobs
// ---------------------------------------------------------------------------

/**
 * Derives the delivery-cost breakdown over the executions attempt ledger
 * (every lifecycle state counts — the same every-state posture as the
 * command-center risk reads), the delivered-jobs surface and the AI/provider
 * telemetry. Human-kind executions are counted but NOT costed (the jobs
 * surface owns human delivery cost — double counting is the alternative).
 */
export function deriveDeliveryCostBreakdown(input: {
  readonly executions: readonly ExecutionRecord[];
  readonly usageTelemetry: readonly UsageTelemetryRecord[];
  readonly resolvedJobs: readonly ResolvedJobRef[];
  readonly connections: readonly IntegrationConnectionSnapshotRow[];
  readonly ingestedEvents: readonly IntegrationIngestedEventSnapshotRow[];
}): DeliveryCostBreakdown {
  const { executions, usageTelemetry, resolvedJobs, connections, ingestedEvents } = input;

  const executionCounts: ExecutionKindCounts = {
    deterministic: executions.filter((execution) => execution.executionKind === 'deterministic').length,
    ai: executions.filter((execution) => execution.executionKind === 'ai').length,
    human: executions.filter((execution) => execution.executionKind === 'human').length,
    extension: executions.filter((execution) => execution.executionKind === 'extension').length,
  };
  const executionStatusCounts: Record<string, number> = {};
  for (const execution of executions) {
    executionStatusCounts[execution.status] = (executionStatusCounts[execution.status] ?? 0) + 1;
  }

  const automationCost =
    executionCounts.deterministic * PROFIT_INTELLIGENCE_ASSUMPTIONS.deterministicExecutionCostUsd +
    executionCounts.extension * PROFIT_INTELLIGENCE_ASSUMPTIONS.extensionExecutionCostUsd;
  const automationRefs = executions
    .filter(
      (execution) =>
        execution.executionKind === 'deterministic' || execution.executionKind === 'extension',
    )
    .map((execution) => ref('execution', execution.executionId));
  const automationDeliveryCost = observedFigure(
    roundMoney(automationCost),
    PROFIT_INTELLIGENCE_ASSUMPTIONS.costingCurrency,
    automationRefs,
    ['deterministicExecutionCostUsd', 'extensionExecutionCostUsd', 'costingCurrency'],
  );

  const deliveredJobs = resolvedJobs.filter((job) => job.job.status === 'outcome_submitted');
  const inFlightJobs = resolvedJobs.filter((job) => job.job.status === 'accepted');
  const humanDeliveryRefs = mergeRefs(
    deliveredJobs.map(({ job }) => ref('job', job.jobId)),
    deliveredJobs.map(({ acceptedOfferId }) => ref('job-offer', acceptedOfferId)),
  );
  const humanDeliveryCost = observedFigure(
    roundMoney(deliveredJobs.length * PROFIT_INTELLIGENCE_ASSUMPTIONS.humanDeliveredJobCostUsd),
    PROFIT_INTELLIGENCE_ASSUMPTIONS.costingCurrency,
    humanDeliveryRefs,
    ['humanDeliveredJobCostUsd', 'costingCurrency'],
  );

  const aiProvider = deriveAiProviderCostSurface(usageTelemetry, connections, ingestedEvents);
  const totalDeliveryCost = observedFigure(
    roundMoney(
      automationCost +
        deliveredJobs.length * PROFIT_INTELLIGENCE_ASSUMPTIONS.humanDeliveredJobCostUsd +
        (aiProvider.telemetryCost.value ?? 0),
    ),
    PROFIT_INTELLIGENCE_ASSUMPTIONS.costingCurrency,
    mergeRefs(automationRefs, humanDeliveryRefs, aiProvider.telemetryCost.sourceRefs),
    COST_ASSUMPTION_KEYS,
  );

  return {
    humanDeliveryCost,
    deliveredJobCount: deliveredJobs.length,
    inFlightJobCount: inFlightJobs.length,
    automationDeliveryCost,
    totalDeliveryCost,
    executionCounts,
    executionStatusCounts: { ...executionStatusCounts },
    aiProvider,
    humanExecutionCostAttribution: PROFIT_INTELLIGENCE_ASSUMPTIONS.humanExecutionCostAttribution,
  };
}

/** Merges per-client delivery-cost breakdowns into a portfolio breakdown (pure). */
export function aggregateDeliveryCostBreakdowns(
  breakdowns: readonly DeliveryCostBreakdown[],
): DeliveryCostBreakdown {
  const sum = (pick: (breakdown: DeliveryCostBreakdown) => number): number =>
    breakdowns.reduce((total, breakdown) => total + pick(breakdown), 0);
  const automationCost = sum((breakdown) => breakdown.automationDeliveryCost.value ?? 0);
  const humanCost = sum((breakdown) => breakdown.humanDeliveryCost.value ?? 0);
  const aiProvider = aggregateAiProviderCostSurfaces(breakdowns.map((b) => b.aiProvider));
  const automationDeliveryCost = observedFigure(
    roundMoney(automationCost),
    PROFIT_INTELLIGENCE_ASSUMPTIONS.costingCurrency,
    mergeRefs(...breakdowns.map((b) => b.automationDeliveryCost.sourceRefs)),
    ['deterministicExecutionCostUsd', 'extensionExecutionCostUsd', 'costingCurrency'],
  );
  const humanDeliveryCost = observedFigure(
    roundMoney(humanCost),
    PROFIT_INTELLIGENCE_ASSUMPTIONS.costingCurrency,
    mergeRefs(...breakdowns.map((b) => b.humanDeliveryCost.sourceRefs)),
    ['humanDeliveredJobCostUsd', 'costingCurrency'],
  );
  const executionCounts: ExecutionKindCounts = {
    deterministic: sum((b) => b.executionCounts.deterministic),
    ai: sum((b) => b.executionCounts.ai),
    human: sum((b) => b.executionCounts.human),
    extension: sum((b) => b.executionCounts.extension),
  };
  const executionStatusCounts: Record<string, number> = {};
  for (const breakdown of breakdowns) {
    for (const [status, count] of Object.entries(breakdown.executionStatusCounts)) {
      executionStatusCounts[status] = (executionStatusCounts[status] ?? 0) + count;
    }
  }
  return {
    humanDeliveryCost,
    deliveredJobCount: sum((b) => b.deliveredJobCount),
    inFlightJobCount: sum((b) => b.inFlightJobCount),
    automationDeliveryCost,
    totalDeliveryCost: observedFigure(
      roundMoney(automationCost + humanCost + (aiProvider.telemetryCost.value ?? 0)),
      PROFIT_INTELLIGENCE_ASSUMPTIONS.costingCurrency,
      mergeRefs(
        automationDeliveryCost.sourceRefs,
        humanDeliveryCost.sourceRefs,
        aiProvider.telemetryCost.sourceRefs,
      ),
      COST_ASSUMPTION_KEYS,
    ),
    executionCounts,
    executionStatusCounts: { ...executionStatusCounts },
    aiProvider,
    humanExecutionCostAttribution: PROFIT_INTELLIGENCE_ASSUMPTIONS.humanExecutionCostAttribution,
  };
}

// ---------------------------------------------------------------------------
// Human capacity + utilization (AC-5b — the jobs/field-agents surfaces)
// ---------------------------------------------------------------------------

/**
 * Derives the human-capacity surface over the /field-agents declarations:
 * only authorization-ACTIVE profiles count; each weekly-recurring
 * availability window contributes its minute span; the cost is the
 * declared capacity × the assumed hourly rate (an ESTIMATED figure —
 * declared intent, not a recorded spend).
 */
export function deriveHumanCapacitySurface(
  profiles: readonly HumanAgentRecord[],
  missingProfileUserIds: readonly string[],
): HumanCapacitySurface {
  const active = profiles.filter((profile) => profile.authorizationState === 'active');
  const weeklyCapacityMinutes = active.reduce(
    (total, profile) =>
      total +
      profile.availability.reduce(
        (windowSum, window) => windowSum + Math.max(0, window.endMinute - window.startMinute),
        0,
      ),
    0,
  );
  const weeklyCapacityCost = estimatedFigure(
    roundMoney((weeklyCapacityMinutes / 60) * PROFIT_INTELLIGENCE_ASSUMPTIONS.humanHourlyRateUsd),
    PROFIT_INTELLIGENCE_ASSUMPTIONS.costingCurrency,
    active.map((profile) => ref('human-agent-profile', profile.agentId)),
    ['humanHourlyRateUsd', 'capacityWindowRecurrence', 'costingCurrency'],
  );
  return {
    activeProfileCount: active.length,
    skippedProfileCount: profiles.length - active.length + missingProfileUserIds.length,
    weeklyCapacityMinutes,
    weeklyCapacityCost,
    profileRefs: active.map((profile) => ref('human-agent-profile', profile.agentId)),
  };
}

/**
 * Derives utilization: delivered human work (the /jobs surface — delivered
 * jobs × assumed minutes per job) over declared capacity (the /field-agents
 * availability pool). Null (with reason) when no capacity is declared.
 */
export function deriveUtilizationSurface(input: {
  readonly deliveredJobCount: number;
  readonly humanExecutionCount: number;
  readonly capacityMinutes: number;
  readonly deliveredJobRefs: readonly ProfitSourceRef[];
  readonly capacityRefs: readonly ProfitSourceRef[];
}): UtilizationSurface {
  const { deliveredJobCount, humanExecutionCount, capacityMinutes } = input;
  const deliveredWorkMinutes = observedFigure(
    deliveredJobCount * PROFIT_INTELLIGENCE_ASSUMPTIONS.deliveredJobMinutes,
    'minutes',
    input.deliveredJobRefs,
    ['deliveredJobMinutes'],
  );
  const capacityFigure = observedFigure(
    capacityMinutes,
    'minutes',
    input.capacityRefs,
    ['capacityWindowRecurrence'],
  );
  const utilization =
    capacityMinutes > 0
      ? observedFigure(
          roundMoney(
            (deliveredJobCount * PROFIT_INTELLIGENCE_ASSUMPTIONS.deliveredJobMinutes) / capacityMinutes,
          ),
          'ratio',
          mergeRefs(input.deliveredJobRefs, input.capacityRefs),
          ['deliveredJobMinutes', 'capacityWindowRecurrence'],
        )
      : notDerivableFigure(
          'ratio',
          'no declared human capacity in the agency pool (denominator is zero)',
          mergeRefs(input.deliveredJobRefs, input.capacityRefs),
          ['deliveredJobMinutes', 'capacityWindowRecurrence'],
        );
  return {
    deliveredWorkMinutes,
    capacityMinutes: capacityFigure,
    utilization,
    humanExecutionCount,
    numeratorNote:
      'the numerator counts delivered jobs only; human-kind executions are disclosed as a runtime indicator and deliberately NOT added (the jobs surface owns delivered human work — counting both would double-count)',
  };
}

// ---------------------------------------------------------------------------
// Scope leakage (AC-5d — declared scope vs. delivered work over
// goals/playbooks/deployments/workflows)
// ---------------------------------------------------------------------------

const NON_TERMINAL_INSTANCE_STATUSES = new Set<string>([
  'draft',
  'ready',
  'running',
  'paused',
  'blocked',
]);

/**
 * Derives the three scope-leakage indicators:
 *   1. executions-outside-deployed-envelope — delivered runtime work whose
 *      instance's pinned definition is NOT declared by any ACTIVE
 *      deployment of the workspace (delivery beyond the deployed scope);
 *   2. work-without-active-goal — non-terminal workflow instances in
 *      workspaces no ACTIVE goal covers (delivered work pursuing no
 *      declared commercial intent);
 *   3. active-goals-without-delivery — ACTIVE goals with zero workflow
 *      instances in their scope (declared scope never delivered).
 */
export function deriveScopeLeakageSurface(input: {
  readonly goals: readonly GoalRecord[];
  readonly workspaces: ReadonlyArray<{
    readonly workspaceId: string;
    readonly deployments: readonly DeploymentRecord[];
    readonly instances: readonly WorkflowInstanceRecord[];
  }>;
  readonly executions: readonly ExecutionRecord[];
}): ScopeLeakageSurface {
  const indicators: ScopeLeakageIndicator[] = [];

  // 1. Executions outside the ACTIVE deployed envelope.
  const uncoveredExecutionRefs: ProfitSourceRef[] = [];
  for (const execution of input.executions) {
    const taskLink = execution.taskLink;
    if (taskLink.kind !== 'workflow-node') continue;
    const workspace = input.workspaces.find(
      (entry) => entry.workspaceId === execution.workspaceId,
    );
    if (workspace === undefined) continue;
    const instance = workspace.instances.find(
      (candidate) => candidate.workflowInstanceId === taskLink.workflowInstanceId,
    );
    if (instance === undefined) continue;
    const covered = workspace.deployments.some(
      (deployment) =>
        deployment.status === 'active' &&
        deployment.workflowDefinitionIds.includes(instance.workflowDefinitionId),
    );
    if (!covered) {
      uncoveredExecutionRefs.push(ref('execution', execution.executionId));
    }
  }
  indicators.push({
    kind: 'executions-outside-deployed-envelope',
    rule: 'an execution counts when its task-linked workflow instance pins a definition that NO ACTIVE deployment of the workspace declares (delivery outside the deployed envelope; external-request executions are out of rule)',
    count: uncoveredExecutionRefs.length,
    sourceRefs: uncoveredExecutionRefs,
  });

  // 2. Non-terminal instances with no covering ACTIVE goal.
  const uncoveredInstanceRefs: ProfitSourceRef[] = [];
  for (const workspace of input.workspaces) {
    const coveredByActiveGoal = input.goals.some(
      (goal) =>
        goal.status === 'active' &&
        (goal.workspaceId === null || goal.workspaceId === workspace.workspaceId),
    );
    if (coveredByActiveGoal) continue;
    for (const instance of workspace.instances) {
      if (!NON_TERMINAL_INSTANCE_STATUSES.has(instance.status)) continue;
      uncoveredInstanceRefs.push(ref('workflow-instance', instance.workflowInstanceId));
    }
  }
  indicators.push({
    kind: 'work-without-active-goal',
    rule: 'a non-terminal workflow instance counts when NO ACTIVE goal of the client covers its workspace (client-wide goals cover every workspace; workspace-scoped goals cover exactly their own)',
    count: uncoveredInstanceRefs.length,
    sourceRefs: uncoveredInstanceRefs,
  });

  // 3. ACTIVE goals with zero workflow instances in scope.
  const undeliveredGoalRefs: ProfitSourceRef[] = [];
  for (const goal of input.goals) {
    if (goal.status !== 'active') continue;
    const hasDelivery = input.workspaces.some(
      (workspace) =>
        (goal.workspaceId === null || goal.workspaceId === workspace.workspaceId) &&
        workspace.instances.length > 0,
    );
    if (!hasDelivery) {
      undeliveredGoalRefs.push(ref('goal', goal.goalId));
    }
  }
  indicators.push({
    kind: 'active-goals-without-delivery',
    rule: 'an ACTIVE goal counts when zero workflow instances exist in its scope (its own workspace, or any workspace of the client when client-wide)',
    count: undeliveredGoalRefs.length,
    sourceRefs: undeliveredGoalRefs,
  });

  return { indicators };
}

// ---------------------------------------------------------------------------
// Margin (AC-5e — estimated vs. realized, provenance kept distinct)
// ---------------------------------------------------------------------------

/**
 * Derives the margin surface. Realized side: the costing-currency slice of
 * the revenue rollup minus the observed delivery cost. Estimated side:
 * ACTIVE-goal success-criterion targets (revenue vocabulary + costing
 * currency only) minus the standing weekly human-capacity commitment.
 * Revenue in other currencies is NEVER converted — it is disclosed as
 * excluded instead (the currency policy note).
 */
export function deriveMarginSurface(input: {
  readonly revenue: RevenueRollup;
  readonly costs: DeliveryCostBreakdown;
  readonly goals: readonly GoalRecord[];
  readonly weeklyCapacityCost: ProfitFigure;
}): MarginSurface {
  const { revenue, costs, goals, weeklyCapacityCost } = input;
  const costingCurrency = PROFIT_INTELLIGENCE_ASSUMPTIONS.costingCurrency;
  const revenueNames = new Set<string>(PROFIT_INTELLIGENCE_ASSUMPTIONS.revenueMetricNames);

  const costingSlice = revenue.byCurrency.find((entry) => entry.currency === costingCurrency);
  const excludedCurrencies = revenue.byCurrency
    .filter((entry) => entry.currency !== costingCurrency)
    .map((entry) => entry.currency);
  const realizedRevenue = observedFigure(
    costingSlice?.total.value ?? 0,
    costingCurrency,
    costingSlice?.sourceRefs ?? [],
    ['revenueMetricNames', 'latestObservationWinsPerMetricIdentity', 'costingCurrency'],
  );
  const realizedDeliveryCost = observedFigure(
    costs.totalDeliveryCost.value!,
    costingCurrency,
    costs.totalDeliveryCost.sourceRefs,
    COST_ASSUMPTION_KEYS,
  );
  const realizedMargin = observedFigure(
    roundMoney(realizedRevenue.value! - realizedDeliveryCost.value!),
    costingCurrency,
    mergeRefs(realizedRevenue.sourceRefs, realizedDeliveryCost.sourceRefs),
    [
      'revenueMetricNames',
      'latestObservationWinsPerMetricIdentity',
      ...COST_ASSUMPTION_KEYS,
    ],
  );

  // Estimated revenue: ACTIVE-goal success-criterion targets (revenue
  // vocabulary + costing currency only — no unit, no conversion).
  const estimatedGoalRefs: ProfitSourceRef[] = [];
  let estimatedRevenueValue = 0;
  for (const goal of goals) {
    if (goal.status !== 'active') continue;
    for (const criterion of goal.successCriteria) {
      if (!revenueNames.has(criterion.metric)) continue;
      if (criterion.unit !== costingCurrency) continue;
      estimatedRevenueValue += criterion.targetValue;
      estimatedGoalRefs.push(ref('goal', goal.goalId));
    }
  }
  const estimatedRevenue = estimatedFigure(
    roundMoney(estimatedRevenueValue),
    costingCurrency,
    estimatedGoalRefs,
    ['revenueMetricNames', 'costingCurrency'],
  );
  const estimatedDeliveryCost = estimatedFigure(
    weeklyCapacityCost.value!,
    costingCurrency,
    weeklyCapacityCost.sourceRefs,
    ['humanHourlyRateUsd', 'capacityWindowRecurrence', 'costingCurrency'],
  );
  const estimatedMargin = estimatedFigure(
    roundMoney(estimatedRevenue.value! - estimatedDeliveryCost.value!),
    costingCurrency,
    mergeRefs(estimatedRevenue.sourceRefs, estimatedDeliveryCost.sourceRefs),
    ['revenueMetricNames', 'costingCurrency', 'humanHourlyRateUsd', 'capacityWindowRecurrence'],
  );

  return {
    realizedRevenue,
    realizedDeliveryCost,
    realizedMargin,
    estimatedRevenue,
    estimatedDeliveryCost,
    estimatedMargin,
    currencyPolicyNote:
      excludedCurrencies.length === 0
        ? `revenue is grouped by declared unit and margin derives only in the costing currency (${costingCurrency}); no FX conversion assumption exists`
        : `revenue is grouped by declared unit and margin derives only in the costing currency (${costingCurrency}); revenue recorded in ${excludedCurrencies.join(', ')} is NOT converted and NOT part of the margin (no FX assumption exists)`,
  };
}

// ---------------------------------------------------------------------------
// Contribution breakdown (AC-5e — client / service / project)
// ---------------------------------------------------------------------------

/** The per-service attribution result: rows + the explicitly-unattributed remainder. */
export interface ServiceContributionResult {
  readonly rows: readonly ServiceContributionRow[];
  /** Cost with NO playbook attribution (executions without a pinned playbook-version chain, telemetry without a resolvable execution link) — disclosed, never hidden. */
  readonly unattributedDeliveryCost: ProfitFigure;
}

/** The per-project attribution result: rows + the explicitly-unattributed remainder. */
export interface ProjectContributionResult {
  readonly rows: readonly ProjectContributionRow[];
  /** Cost attributed to NO deployment (delivery outside every declared project envelope) — disclosed, never hidden. */
  readonly unattributedDeliveryCost: ProfitFigure;
}

/** delivery-cost attribution chain: instance → definition → playbook version → playbook. */
function playbookOfInstance(input: {
  readonly workspaces: ClientAuthoritySnapshot['workspaces'];
  readonly playbookVersionOwners: ReadonlyMap<string, string>;
  readonly instanceId: string;
}): string | null {
  for (const workspace of input.workspaces) {
    const definitionId = workspace.instanceDefinitionIds.get(input.instanceId);
    if (definitionId === undefined) continue;
    const playbookVersionId = workspace.definitionPlaybookVersionIds.get(definitionId);
    if (playbookVersionId === undefined || playbookVersionId === null) return null;
    return input.playbookVersionOwners.get(playbookVersionId) ?? null;
  }
  return null;
}

/**
 * Derives the per-service (Playbook) contribution rows: every delivered
 * cost component attributes through the instance → pinned definition →
 * playbook-version chain; revenue carries no playbook reference today —
 * the revenue figure is null WITH reason (never fabricated). Cost that
 * attributes to NO playbook returns as the explicit unattributed figure.
 */
export function deriveServiceContributions(input: {
  readonly snapshot: ClientAuthoritySnapshot;
}): ServiceContributionResult {
  const { snapshot } = input;
  const entries = new Map<
    string,
    {
      cost: number;
      refs: ProfitSourceRef[];
      deliveredJobCount: number;
      executionCount: number;
    }
  >();
  let unattributedCost = 0;
  const unattributedRefs: ProfitSourceRef[] = [];

  const attribute = (playbookId: string | null, amount: number, refs: ProfitSourceRef[]): void => {
    if (playbookId === null) {
      unattributedCost += amount;
      unattributedRefs.push(...refs);
      return;
    }
    const entry = entries.get(playbookId) ?? { cost: 0, refs: [], deliveredJobCount: 0, executionCount: 0 };
    entry.cost += amount;
    entry.refs = mergeRefs(entry.refs, refs);
    entries.set(playbookId, entry);
  };

  for (const workspace of snapshot.workspaces) {
    for (const execution of workspace.executions) {
      if (execution.executionKind !== 'deterministic' && execution.executionKind !== 'extension') {
        continue;
      }
      const unitCost =
        execution.executionKind === 'deterministic'
          ? PROFIT_INTELLIGENCE_ASSUMPTIONS.deterministicExecutionCostUsd
          : PROFIT_INTELLIGENCE_ASSUMPTIONS.extensionExecutionCostUsd;
      const refs = [ref('execution', execution.executionId)];
      const playbookId =
        execution.taskLink.kind === 'workflow-node'
          ? playbookOfInstance({
              workspaces: snapshot.workspaces,
              playbookVersionOwners: snapshot.playbookVersionOwners,
              instanceId: execution.taskLink.workflowInstanceId,
            })
          : null;
      attribute(playbookId, unitCost, refs);
      if (playbookId !== null) {
        const entry = entries.get(playbookId)!;
        entry.executionCount += 1;
        entries.set(playbookId, entry);
      }
    }
    for (const usage of workspace.usageTelemetry) {
      if (usage.executionId === null) {
        unattributedCost += usage.costAmount;
        unattributedRefs.push(ref('usage-telemetry', usage.usageId));
        continue;
      }
      const execution = workspace.executions.find(
        (candidate) => candidate.executionId === usage.executionId,
      );
      if (execution === undefined || execution.taskLink.kind !== 'workflow-node') {
        unattributedCost += usage.costAmount;
        unattributedRefs.push(ref('usage-telemetry', usage.usageId));
        continue;
      }
      const playbookId = playbookOfInstance({
        workspaces: snapshot.workspaces,
        playbookVersionOwners: snapshot.playbookVersionOwners,
        instanceId: execution.taskLink.workflowInstanceId,
      });
      attribute(playbookId, usage.costAmount, [ref('usage-telemetry', usage.usageId)]);
    }
  }
  for (const resolved of snapshot.resolvedJobs) {
    if (resolved.job.status !== 'outcome_submitted') continue;
    if (snapshot.workspaceId !== null && resolved.job.workspaceId !== snapshot.workspaceId) continue;
    const playbookId = playbookOfInstance({
      workspaces: snapshot.workspaces,
      playbookVersionOwners: snapshot.playbookVersionOwners,
      instanceId: resolved.job.workflowInstanceId,
    });
    const refs = [ref('job', resolved.job.jobId), ref('job-offer', resolved.acceptedOfferId)];
    attribute(playbookId, PROFIT_INTELLIGENCE_ASSUMPTIONS.humanDeliveredJobCostUsd, refs);
    if (playbookId !== null) {
      const entry = entries.get(playbookId)!;
      entry.deliveredJobCount += 1;
      entries.set(playbookId, entry);
    }
  }

  const rows: ServiceContributionRow[] = [...entries.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([playbookId, entry]) => ({
      playbookId,
      deliveryCost: observedFigure(
        roundMoney(entry.cost),
        PROFIT_INTELLIGENCE_ASSUMPTIONS.costingCurrency,
        entry.refs,
        COST_ASSUMPTION_KEYS,
      ),
      revenue: notDerivableFigure(
        PROFIT_INTELLIGENCE_ASSUMPTIONS.costingCurrency,
        'metric observations carry no playbook reference — per-service revenue attribution arrives with the v1.5 sales-to-delivery continuity work (MKT-046)',
        [],
        ['revenueMetricNames'],
      ),
      deliveredJobCount: entry.deliveredJobCount,
      executionCount: entry.executionCount,
    }));
  return {
    rows,
    unattributedDeliveryCost: observedFigure(
      roundMoney(unattributedCost),
      PROFIT_INTELLIGENCE_ASSUMPTIONS.costingCurrency,
      unattributedRefs,
      COST_ASSUMPTION_KEYS,
    ),
  };
}

/**
 * Derives the per-project (Deployment) contribution rows: executions, jobs
 * and telemetry whose instance's pinned definition is one of the
 * deployment's declared workflow definitions. Revenue attribution is null
 * with reason; cost that attributes to NO deployment is the explicit
 * unattributed figure.
 */
export function deriveProjectContributions(input: {
  readonly snapshot: ClientAuthoritySnapshot;
}): ProjectContributionResult {
  const { snapshot } = input;
  const entries = new Map<
    string,
    {
      deployment: DeploymentRecord;
      cost: number;
      refs: ProfitSourceRef[];
      deliveredJobCount: number;
      executionCount: number;
    }
  >();
  for (const workspace of snapshot.workspaces) {
    for (const deployment of workspace.deployments) {
      entries.set(deployment.deploymentId, {
        deployment,
        cost: 0,
        refs: [],
        deliveredJobCount: 0,
        executionCount: 0,
      });
    }
  }
  let unattributedCost = 0;
  const unattributedRefs: ProfitSourceRef[] = [];

  const attributeToDefinition = (
    definitionId: string | undefined,
    amount: number,
    refs: ProfitSourceRef[],
    kind: 'execution' | 'job',
  ): void => {
    if (definitionId === undefined) {
      unattributedCost += amount;
      unattributedRefs.push(...refs);
      return;
    }
    let attributed = false;
    for (const entry of entries.values()) {
      if (!entry.deployment.workflowDefinitionIds.includes(definitionId)) continue;
      entry.cost += amount;
      entry.refs = mergeRefs(entry.refs, refs);
      if (kind === 'execution') entry.executionCount += 1;
      else entry.deliveredJobCount += 1;
      attributed = true;
    }
    if (!attributed) {
      unattributedCost += amount;
      unattributedRefs.push(...refs);
    }
  };

  for (const workspace of snapshot.workspaces) {
    for (const execution of workspace.executions) {
      if (execution.executionKind !== 'deterministic' && execution.executionKind !== 'extension') {
        continue;
      }
      const unitCost =
        execution.executionKind === 'deterministic'
          ? PROFIT_INTELLIGENCE_ASSUMPTIONS.deterministicExecutionCostUsd
          : PROFIT_INTELLIGENCE_ASSUMPTIONS.extensionExecutionCostUsd;
      const definitionId =
        execution.taskLink.kind === 'workflow-node'
          ? workspace.instanceDefinitionIds.get(execution.taskLink.workflowInstanceId)
          : undefined;
      attributeToDefinition(
        definitionId,
        unitCost,
        [ref('execution', execution.executionId)],
        'execution',
      );
    }
    for (const usage of workspace.usageTelemetry) {
      // The reconciliation rule (the same honesty posture as the service
      // attribution): EVERY cost component lands either in an attributed
      // row or in the disclosed unattributed remainder — a telemetry row
      // with NO execution link (or an execution whose task link carries no
      // workflow instance) attributes to NO deployment, so its cost is
      // unattributed, never silently dropped.
      if (usage.executionId === null) {
        unattributedCost += usage.costAmount;
        unattributedRefs.push(ref('usage-telemetry', usage.usageId));
        continue;
      }
      const execution = workspace.executions.find(
        (candidate) => candidate.executionId === usage.executionId,
      );
      if (execution === undefined || execution.taskLink.kind !== 'workflow-node') {
        unattributedCost += usage.costAmount;
        unattributedRefs.push(ref('usage-telemetry', usage.usageId));
        continue;
      }
      const definitionId = workspace.instanceDefinitionIds.get(execution.taskLink.workflowInstanceId);
      attributeToDefinition(
        definitionId,
        usage.costAmount,
        [ref('usage-telemetry', usage.usageId)],
        'execution',
      );
    }
  }
  for (const resolved of snapshot.resolvedJobs) {
    if (resolved.job.status !== 'outcome_submitted') continue;
    if (snapshot.workspaceId !== null && resolved.job.workspaceId !== snapshot.workspaceId) continue;
    const workspace = snapshot.workspaces.find(
      (entry) => entry.workspaceId === resolved.job.workspaceId,
    );
    const definitionId = workspace?.instanceDefinitionIds.get(resolved.job.workflowInstanceId);
    attributeToDefinition(
      definitionId,
      PROFIT_INTELLIGENCE_ASSUMPTIONS.humanDeliveredJobCostUsd,
      [ref('job', resolved.job.jobId), ref('job-offer', resolved.acceptedOfferId)],
      'job',
    );
  }

  const rows: ProjectContributionRow[] = [...entries.values()]
    .sort(
      (a, b) =>
        a.deployment.createdAt.localeCompare(b.deployment.createdAt) ||
        a.deployment.deploymentId.localeCompare(b.deployment.deploymentId),
    )
    .map((entry) => ({
      deploymentId: entry.deployment.deploymentId,
      deploymentStatus: entry.deployment.status,
      deliveryCost: observedFigure(
        roundMoney(entry.cost),
        PROFIT_INTELLIGENCE_ASSUMPTIONS.costingCurrency,
        entry.refs,
        COST_ASSUMPTION_KEYS,
      ),
      revenue: notDerivableFigure(
        PROFIT_INTELLIGENCE_ASSUMPTIONS.costingCurrency,
        'metric observations carry no deployment reference — per-project revenue attribution arrives with the v1.5 sales-to-delivery continuity work (MKT-046)',
        [],
        ['revenueMetricNames'],
      ),
      deliveredJobCount: entry.deliveredJobCount,
      executionCount: entry.executionCount,
    }));
  return {
    rows,
    unattributedDeliveryCost: observedFigure(
      roundMoney(unattributedCost),
      PROFIT_INTELLIGENCE_ASSUMPTIONS.costingCurrency,
      unattributedRefs,
      COST_ASSUMPTION_KEYS,
    ),
  };
}

/** Merges per-client service-contribution results across the portfolio (pure). */
export function aggregateServiceContributions(
  results: readonly ServiceContributionResult[],
): ServiceContributionResult {
  const merged = new Map<string, ServiceContributionRow>();
  for (const result of results) {
    for (const row of result.rows) {
      const prior = merged.get(row.playbookId);
      if (prior === undefined) {
        merged.set(row.playbookId, { ...row });
        continue;
      }
      merged.set(row.playbookId, {
        ...row,
        deliveryCost: observedFigure(
          roundMoney(prior.deliveryCost.value! + row.deliveryCost.value!),
          row.deliveryCost.currency,
          mergeRefs(prior.deliveryCost.sourceRefs, row.deliveryCost.sourceRefs),
          COST_ASSUMPTION_KEYS,
        ),
        deliveredJobCount: prior.deliveredJobCount + row.deliveredJobCount,
        executionCount: prior.executionCount + row.executionCount,
      });
    }
  }
  return {
    rows: [...merged.values()].sort((a, b) => a.playbookId.localeCompare(b.playbookId)),
    unattributedDeliveryCost: observedFigure(
      roundMoney(
        results.reduce((sum, result) => sum + (result.unattributedDeliveryCost.value ?? 0), 0),
      ),
      PROFIT_INTELLIGENCE_ASSUMPTIONS.costingCurrency,
      mergeRefs(...results.map((result) => result.unattributedDeliveryCost.sourceRefs)),
      COST_ASSUMPTION_KEYS,
    ),
  };
}

/** Merges per-client project-contribution results across the portfolio (pure). */
export function aggregateProjectContributions(
  results: readonly ProjectContributionResult[],
): ProjectContributionResult {
  const merged = new Map<string, ProjectContributionRow>();
  for (const result of results) {
    for (const row of result.rows) {
      const prior = merged.get(row.deploymentId);
      if (prior === undefined) {
        merged.set(row.deploymentId, { ...row });
        continue;
      }
      merged.set(row.deploymentId, {
        ...row,
        deliveryCost: observedFigure(
          roundMoney(prior.deliveryCost.value! + row.deliveryCost.value!),
          row.deliveryCost.currency,
          mergeRefs(prior.deliveryCost.sourceRefs, row.deliveryCost.sourceRefs),
          COST_ASSUMPTION_KEYS,
        ),
        deliveredJobCount: prior.deliveredJobCount + row.deliveredJobCount,
        executionCount: prior.executionCount + row.executionCount,
      });
    }
  }
  return {
    rows: [...merged.values()].sort((a, b) => a.deploymentId.localeCompare(b.deploymentId)),
    unattributedDeliveryCost: observedFigure(
      roundMoney(
        results.reduce((sum, result) => sum + (result.unattributedDeliveryCost.value ?? 0), 0),
      ),
      PROFIT_INTELLIGENCE_ASSUMPTIONS.costingCurrency,
      mergeRefs(...results.map((result) => result.unattributedDeliveryCost.sourceRefs)),
      COST_ASSUMPTION_KEYS,
    ),
  };
}

/** The per-client contribution row (the client dimension of AC-5e). */
export function deriveClientContributionRow(input: {
  readonly clientId: string;
  readonly revenue: RevenueRollup;
  readonly costs: DeliveryCostBreakdown;
}): ClientContributionRow {
  const costingCurrency = PROFIT_INTELLIGENCE_ASSUMPTIONS.costingCurrency;
  const costingSlice = input.revenue.byCurrency.find(
    (entry) => entry.currency === costingCurrency,
  );
  const revenue = observedFigure(
    costingSlice?.total.value ?? 0,
    costingCurrency,
    costingSlice?.sourceRefs ?? [],
    ['revenueMetricNames', 'latestObservationWinsPerMetricIdentity', 'costingCurrency'],
  );
  const deliveryCost = observedFigure(
    input.costs.totalDeliveryCost.value!,
    costingCurrency,
    input.costs.totalDeliveryCost.sourceRefs,
    COST_ASSUMPTION_KEYS,
  );
  const margin = observedFigure(
    roundMoney(revenue.value! - deliveryCost.value!),
    costingCurrency,
    mergeRefs(revenue.sourceRefs, deliveryCost.sourceRefs),
    [
      'revenueMetricNames',
      'latestObservationWinsPerMetricIdentity',
      ...COST_ASSUMPTION_KEYS,
    ],
  );
  return { clientId: input.clientId, revenue, deliveryCost, margin };
}

// ---------------------------------------------------------------------------
// The calculation disclosure (every view carries it)
// ---------------------------------------------------------------------------

export function composeCalculationDisclosure(): CalculationDisclosure {
  return {
    calculationVersion: PROFIT_INTELLIGENCE_CALCULATION_VERSION,
    assumptions: PROFIT_INTELLIGENCE_ASSUMPTIONS,
    basis: 'live-derivation-over-canonical-authorities',
    persistence: 'none-derived-read-model',
  };
}
