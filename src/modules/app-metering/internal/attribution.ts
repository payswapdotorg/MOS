/**
 * /app-metering attribution derivation (MKT-052 — the PURE aggregation
 * functions of the derived attribution read models, the
 * /profit-intelligence profit-derivation precedent).
 *
 * Every function here is PURE over the tail's own meter event records +
 * the resolved app attribution (the module resolves the
 * dependency-declared linkage per invocation event —
 * attributeInvocationToApp in public.ts — and the registry publishers,
 * then passes everything in as data): same inputs + am-attrib-v1 ⇒
 * byte-identical outputs (the pinning proof).
 */

import type { AppMeteringDimension } from '../../apps/public.ts';
import type {
  AppMeteringDimensionAggregate,
  AppMeteringPeriodRow,
  AppMeteringPublisherRow,
  AppMeteringUnit,
} from '../public.ts';
import { APP_METERING_DIMENSIONS, APP_METERING_UNITS } from '../public.ts';

/**
 * The narrow structural slice of a meter event the aggregation consumes
 * (satisfied structurally by AppMeterEventRecord — scope-as-data, so the
 * derivation never touches storage).
 */
export interface AppMeterEventSlice {
  readonly dimension: AppMeteringDimension;
  readonly unit: AppMeteringUnit;
  readonly quantity: number;
  readonly workspaceId: string;
  readonly appKey: string | null;
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly occurredAt: string;
}

/** An accumulator over (dimension → quantity, eventCount). */
type DimensionAccumulator = Map<AppMeteringDimension, { quantity: number; eventCount: number }>;

function accumulate(accumulator: DimensionAccumulator, event: AppMeterEventSlice): void {
  const entry = accumulator.get(event.dimension) ?? { quantity: 0, eventCount: 0 };
  entry.quantity += event.quantity;
  entry.eventCount += 1;
  accumulator.set(event.dimension, entry);
}

/** Finalizes an accumulator into the frozen-vocabulary-ordered rows. */
function finalize(accumulator: DimensionAccumulator): AppMeteringDimensionAggregate[] {
  const rows: AppMeteringDimensionAggregate[] = [];
  for (const dimension of APP_METERING_DIMENSIONS) {
    const entry = accumulator.get(dimension);
    if (entry === undefined) continue;
    rows.push({
      dimension,
      unit: APP_METERING_UNITS[dimension],
      quantity: entry.quantity,
      eventCount: entry.eventCount,
    });
  }
  return rows;
}

/**
 * PURE: the RAW per-dimension totals over a meter-event slice (≡ the
 * rollup projection ≡ direct SQL over the tail — the ground truth; the
 * invocation events count in the raw invocations total whether or not
 * they attribute to an app).
 */
export function aggregateDimensionTotals(
  events: readonly AppMeterEventSlice[],
): readonly AppMeteringDimensionAggregate[] {
  const accumulator: DimensionAccumulator = new Map();
  for (const event of events) {
    accumulate(accumulator, event);
  }
  return finalize(accumulator);
}

/**
 * PURE: groups a meter-event slice into UTC calendar-month period rows
 * (the frozen periodBasis assumption — occurredAt, never the meter
 * recording time), ordered oldest period first.
 */
export function groupByPeriod(
  events: readonly AppMeterEventSlice[],
): readonly AppMeteringPeriodRow[] {
  const byPeriod = new Map<string, DimensionAccumulator>();
  for (const event of events) {
    const date = new Date(event.occurredAt);
    const start = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
    ).toISOString();
    const accumulator = byPeriod.get(start) ?? new Map();
    accumulate(accumulator, event);
    byPeriod.set(start, accumulator);
  }
  return [...byPeriod.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([periodStart, accumulator]) => ({
      periodStart,
      dimensions: finalize(accumulator),
    }));
}

/** One app's attributed slice during the aggregation. */
interface AppBucket {
  readonly events: AppMeterEventSlice[];
}

/**
 * PURE: the per-app attribution aggregation over a meter-event slice
 * (AC-3 — the heart of the derivation). Each event's app attribution
 * arrives as a PRE-RESOLVED map by the event's source identity (the
 * module composes it: installation selections + usage observations by
 * their OWN app identity; invocation events through the DISCLOSED
 * dependency-declared current-selection linkage — exactly one declaring
 * app or disclosed-unattributed). Per-app current-selection counts follow
 * the frozen currentInstallationBasis assumption (the ACTIVE ledger
 * rows). Rows are ordered app-key-lexicographically.
 */
export function aggregatePerAppAttribution(input: {
  readonly events: readonly AppMeterEventSlice[];
  /** The PRE-RESOLVED app attribution per event source identity (null = unattributed). */
  readonly attributionBySource: ReadonlyMap<string, string | null>;
  /** The current-selection count per app key within the view's scope. */
  readonly currentSelectionCounts: ReadonlyMap<string, number>;
  /** The registry-resolved lineage publisher per app key (null = unresolvable). */
  readonly publishers: ReadonlyMap<string, string>;
}): readonly {
  readonly appKey: string;
  readonly publisher: string | null;
  readonly dimensions: readonly AppMeteringDimensionAggregate[];
  readonly currentSelectionCount: number;
}[] {
  const byApp = new Map<string, AppBucket>();
  for (const event of input.events) {
    const attribution = input.attributionBySource.get(`${event.sourceKind}:${event.sourceId}`) ?? null;
    if (attribution === null) continue;
    const bucket = byApp.get(attribution) ?? { events: [] };
    bucket.events.push(event);
    byApp.set(attribution, bucket);
  }
  const rows: {
    readonly appKey: string;
    readonly publisher: string | null;
    readonly dimensions: readonly AppMeteringDimensionAggregate[];
    readonly currentSelectionCount: number;
  }[] = [];
  for (const [appKey, bucket] of [...byApp.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    rows.push({
      appKey,
      publisher: input.publishers.get(appKey) ?? null,
      dimensions: aggregateDimensionTotals(bucket.events),
      currentSelectionCount: input.currentSelectionCounts.get(appKey) ?? 0,
    });
  }
  return rows;
}

/**
 * PURE: builds ONE app's attribution row directly (the single-app
 * composition used by tests and future consumers).
 */
export function buildAppAttribution(input: {
  readonly appKey: string;
  readonly publisher: string | null;
  readonly attributedEvents: readonly AppMeterEventSlice[];
  readonly currentSelectionCount: number;
}): {
  readonly appKey: string;
  readonly publisher: string | null;
  readonly dimensions: readonly AppMeteringDimensionAggregate[];
  readonly currentSelectionCount: number;
} {
  return {
    appKey: input.appKey,
    publisher: input.publisher,
    dimensions: aggregateDimensionTotals(input.attributedEvents),
    currentSelectionCount: input.currentSelectionCount,
  };
}

/**
 * PURE: the per-publisher rollup (apps grouped by their registry-resolved
 * lineage publisher; the per-publisher quantities are the sums of the
 * per-app rows), ordered publisher-lexicographically.
 */
export function aggregatePerPublisher(input: {
  readonly perApp: readonly {
    readonly appKey: string;
    readonly publisher: string | null;
    readonly dimensions: readonly AppMeteringDimensionAggregate[];
  }[];
}): readonly AppMeteringPublisherRow[] {
  const publishers = [...new Set(input.perApp.map((app) => app.publisher).filter((p): p is string => p !== null))].sort();
  const rows: AppMeteringPublisherRow[] = [];
  for (const publisher of publishers) {
    const apps = input.perApp.filter((app) => app.publisher === publisher);
    const accumulator: DimensionAccumulator = new Map();
    for (const app of apps) {
      for (const aggregate of app.dimensions) {
        const entry = accumulator.get(aggregate.dimension) ?? { quantity: 0, eventCount: 0 };
        entry.quantity += aggregate.quantity;
        entry.eventCount += aggregate.eventCount;
        accumulator.set(aggregate.dimension, entry);
      }
    }
    rows.push({
      publisher,
      appKeys: apps.map((app) => app.appKey).sort(),
      dimensions: finalize(accumulator),
    });
  }
  return rows;
}

/**
 * PURE: the unattributed-invocations remainder (the honest disclosure —
 * the invocation events that resolved to NO app or to an AMBIGUOUS set
 * under the linkage; counted in the raw totals, never dropped).
 */
export function unattributedInvocationsOf(input: {
  readonly invocationAttribution: ReadonlyMap<string, string | null>;
}): {
  readonly count: number;
  readonly policy: 'disclosed-unattributed';
  readonly reason: string;
} {
  let count = 0;
  for (const appKey of input.invocationAttribution.values()) {
    if (appKey === null) count += 1;
  }
  return {
    count,
    policy: 'disclosed-unattributed',
    reason:
      count === 0
        ? 'every invocation event in scope attributed to exactly one current app selection under the dependency-declared linkage'
        : 'invocation events matching zero or multiple current app selections under the dependency-declared linkage are disclosed as unattributed — counted in the raw totals, never dropped, never split',
  };
}

/** The unit of a dimension (the frozen mapping re-export for consumers). */
export function unitOf(dimension: AppMeteringDimension): AppMeteringUnit {
  return APP_METERING_UNITS[dimension];
}
