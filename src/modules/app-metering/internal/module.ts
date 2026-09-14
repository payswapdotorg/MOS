/**
 * /app-metering module implementation (MKT-052 — App Metering and
 * Commercial Attribution).
 *
 * Composition over the append-only meter event tail + the rollup
 * projection (migration 044) and the composed authorities' PUBLIC
 * CONTRACTS (the frozen-matrix row added by this Work Item:
 * /app-metering ──→ /apps, /app-installs, /extensions, /workspaces):
 *
 *   - COLLECTION is EVENT CONSUMPTION (AC-1): the workspace's REAL
 *     sources are read through the /app-installs public contract (the
 *     install ledger rows + the append-only lifecycle event tail — the
 *     canonical source references) and the /extensions public contract
 *     (the invocation ledger rows, the extension registry resolution for
 *     the publisher facts); every NOT-yet-metered source appends ONE
 *     meter event to the OWN tail with the deterministic 'collect:' §8
 *     command key (idempotent — re-collection appends ZERO rows; the
 *     migration-044 at-most-once source fence re-fences concurrency);
 *     another module's tables are NEVER written;
 *   - INGESTION (AC-1's usage dimensions) is a MODULE-LEVEL command for
 *     server-side callers: the (app, workspace, invocation) CONTEXT is
 *     validated fail-closed through the composed contracts (the app must
 *     be the workspace's CURRENT MKT-048 selection; the dimension must be
 *     manifest-declared; a premium capability must be manifest-declared;
 *     a state namespace must be manifest-declared; the source invocation
 *     must resolve through the real /extensions ledger and belong to the
 *     SAME workspace); the observed quantity itself is
 *     runtime-host-reported (disclosed);
 *   - the ATTRIBUTION VIEWS (AC-3/AC-4) are LIVE derivations over the
 *     OWN tail: the raw per-dimension totals (≡ the rollup projection ≡
 *     direct SQL — the ground truth), the per-app attribution
 *     (installations/usage by their own app identity; invocations by the
 *     DISCLOSED dependency-declared current-selection linkage resolved
 *     per workspace), per-publisher and per-period rollups, and the
 *     honest unattributed-invocations remainder — every view ships the
 *     frozen calculation version (am-attrib-v1) + the assumption record
 *     (the /profit-intelligence discipline);
 *   - the ROLLUP RECOMPUTE (AC-5) is the disclosed module-level rebuild
 *     path: ONE transaction replaces the derived projection with the
 *     deterministic GROUP BY aggregates over the tail (the
 *     operating-graph rebuild precedent).
 *
 * Fail-closed contract: every guard throws before any state is touched;
 * unknown workspaces/apps/invocations surface NotFoundError (uniform —
 * foreign is indistinguishable from unknown); context violations surface
 * InvalidRequestError with the honest reason; §8 divergent key reuse
 * surfaces IdempotencyConflictError; disabled boundaries surface
 * ConflictError for meter WRITES (the /app-installs posture).
 */

import { createHash } from 'node:crypto';
import {
  ConflictError,
  IdempotencyConflictError,
  InvalidRequestError,
  NotFoundError,
} from '../../../platform/errors/errors.ts';
import type { AppManifest, AppMeteringDimension } from '../../apps/public.ts';
import { attributeInvocationToApp, composeAppMeteringCalculationDisclosure, unitOfDimension } from '../public.ts';
import type {
  AgencyAppMeteringView,
  AppMeterEventRecord,
  AppMeteringAppAttribution,
  AppMeteringCollectionOutcome,
  AppMeteringModuleApi,
  AppMeteringModuleDeps,
  AppMeteringProvenance,
  AppMeteringWorkspaceOwnershipSnapshot,
  PublisherAppMeteringView,
  WorkspaceAppMeteringView,
} from '../public.ts';
import {
  aggregateDimensionTotals,
  aggregatePerAppAttribution,
  aggregatePerPublisher,
  groupByPeriod,
  unattributedInvocationsOf,
  type AppMeterEventSlice,
} from './attribution.ts';
import {
  appMeterObservationCreateFingerprint,
  AppMeteringStore,
  assertValidMeteringProvenance,
  assertValidObservationInput,
  assertValidWorkspaceMeteringInput,
  collectInstallSelectionKey,
  collectInvocationKey,
  replayOrConflict,
} from './store.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLISHER_PATTERN = /^dev:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The narrow slice shape the aggregation consumes (scope-as-data). */
function sliceOf(event: AppMeterEventRecord): AppMeterEventSlice {
  return {
    dimension: event.dimension,
    unit: event.unit,
    quantity: event.quantity,
    workspaceId: event.workspaceId,
    appKey: event.appKey,
    sourceKind: event.sourceKind,
    sourceId: event.sourceId,
    occurredAt: event.occurredAt,
  };
}

/**
 * One workspace's CURRENT (ACTIVE) selection context: the dependency
 * manifests of the pinned exact App Versions (read through the
 * /app-installs + /apps public contracts — the linkage inputs).
 */
interface WorkspaceSelectionContext {
  readonly dependencies: ReadonlyArray<{
    readonly appKey: string;
    readonly appVersionId: string;
    readonly version: string;
    readonly dependencies: ReadonlyArray<{
      readonly kind: string;
      readonly publisher: string | null;
      readonly key: string;
      readonly minVersion: string;
      readonly maxVersion: string;
    }>;
  }>;
  readonly currentSelectionCounts: ReadonlyMap<string, number>;
}

export function createAppMeteringModule(deps: AppMeteringModuleDeps): AppMeteringModuleApi {
  const store = new AppMeteringStore(deps.db, deps.clock, deps.ids);
  const { apps, appInstalls, extensions, workspaceOwnership } = deps;
  const now = (): string => deps.clock.nowIso();

  /**
   * Canonical Workspace ownership for a METER WRITE (collection or
   * ingestion): resolved through the /workspaces structural port BEFORE
   * anything else (unknown or tombstoned → uniform NotFoundError — a
   * foreign Workspace is indistinguishable from an unknown one); a
   * disabled boundary → ConflictError (disabled boundaries block new
   * meter events without rewriting history — the /app-installs posture).
   */
  async function requireWorkspaceForWrite(
    workspaceId: string,
  ): Promise<AppMeteringWorkspaceOwnershipSnapshot> {
    const ownership = await workspaceOwnership.resolveWorkspaceOwnership(workspaceId);
    if (ownership === null) {
      throw new NotFoundError('workspace', workspaceId);
    }
    if (ownership.workspace.status !== 'active') {
      throw new ConflictError(
        `workspace ${workspaceId} is ${ownership.workspace.status}; new meter events are blocked`,
      );
    }
    if (ownership.client.status !== 'active') {
      throw new ConflictError(
        `client ${ownership.client.clientId} is ${ownership.client.status}; new meter events are blocked`,
      );
    }
    if (ownership.clientOwnership.agency.status !== 'active') {
      throw new ConflictError(
        `agency ${ownership.clientOwnership.agency.agencyId} is ${ownership.clientOwnership.agency.status}; new meter events are blocked`,
      );
    }
    return ownership;
  }

  /**
   * One workspace's CURRENT selection context (the linkage inputs): the
   * ACTIVE ledger rows' pinned manifests' dependency declarations + the
   * current-selection counts per app. Read READ-ONLY through the
   * /app-installs + /apps public contracts.
   */
  async function workspaceSelectionContext(
    workspaceId: string,
  ): Promise<WorkspaceSelectionContext> {
    const installs = await appInstalls.listWorkspaceAppInstalls(workspaceId);
    const active = installs.filter((row) => row.status === 'ACTIVE');
    const currentSelectionCounts = new Map<string, number>();
    for (const row of active) {
      currentSelectionCounts.set(row.appKey, (currentSelectionCounts.get(row.appKey) ?? 0) + 1);
    }
    const dependencies = await Promise.all(
      active.map(async (row) => {
        const version = await apps.getAppVersion(row.appVersionId);
        return {
          appKey: row.appKey,
          appVersionId: row.appVersionId,
          version: row.version,
          dependencies: version === null ? [] : version.manifest.dependencies,
        };
      }),
    );
    return { dependencies, currentSelectionCounts };
  }

  /**
   * The registry-resolved lineage publishers of a set of app keys (the
   * /apps public listing — the publisher is lineage-consistent by the
   * migration-037 owner fence; null when the lineage is unresolvable —
   * the honest notDerivable posture).
   */
  async function publishersFor(appKeys: readonly string[]): Promise<Map<string, string>> {
    const publishers = new Map<string, string>();
    for (const appKey of new Set(appKeys)) {
      const versions = await apps.listAppVersions({ appKey });
      const publisher = versions[0]?.publisher;
      if (publisher !== undefined) {
        publishers.set(appKey, publisher);
      }
    }
    return publishers;
  }

  /**
   * Resolves the per-event app attribution of a meter-event slice (the
   * AC-3 derivation): install/usage events attribute by their OWN app
   * identity; invocation events by the DISCLOSED dependency-declared
   * current-selection linkage resolved against the workspace's CURRENT
   * selection context (pure linkage — attributeInvocationToApp).
   */
  async function resolveAttribution(
    events: readonly AppMeterEventRecord[],
    contextOf: (workspaceId: string) => Promise<WorkspaceSelectionContext>,
  ): Promise<{
    readonly attributionBySource: ReadonlyMap<string, string | null>;
    readonly invocationAttribution: ReadonlyMap<string, string | null>;
  }> {
    const attributionBySource = new Map<string, string | null>();
    const invocationAttribution = new Map<string, string | null>();
    const contexts = new Map<string, WorkspaceSelectionContext>();
    for (const event of events) {
      if (event.sourceKind !== 'extension-invocation') {
        attributionBySource.set(`${event.sourceKind}:${event.sourceId}`, event.appKey);
        continue;
      }
      let context = contexts.get(event.workspaceId);
      if (context === undefined) {
        context = await contextOf(event.workspaceId);
        contexts.set(event.workspaceId, context);
      }
      const verdict = attributeInvocationToApp(
        {
          extensionPublisher: event.extensionPublisher ?? '',
          extensionKey: event.extensionKey ?? '',
          extensionVersion: event.extensionVersion ?? '',
        },
        context.dependencies,
      );
      const attribution = 'appKey' in verdict ? verdict.appKey : null;
      invocationAttribution.set(event.sourceId, attribution);
      attributionBySource.set(`extension-invocation:${event.sourceId}`, attribution);
    }
    return { attributionBySource, invocationAttribution };
  }

  return {
    // -----------------------------------------------------------------------
    // AC-1: THE COLLECTION COMMAND (event consumption over public contracts)
    // -----------------------------------------------------------------------

    async collectWorkspaceMetering(
      input: { readonly workspaceId: string },
      provenance: AppMeteringProvenance,
    ): Promise<AppMeteringCollectionOutcome> {
      assertValidWorkspaceMeteringInput(input);
      assertValidMeteringProvenance(provenance);
      const ownership = await requireWorkspaceForWrite(input.workspaceId);
      const { agencyId, clientId, workspaceId } = ownership.scope;

      // THE REAL SOURCES through the /app-installs public contract: the
      // append-only selection ledger + the append-only lifecycle event
      // tail (the canonical source references). READ-ONLY.
      const [installRows, lifecycleEvents] = await Promise.all([
        appInstalls.listWorkspaceAppInstalls(workspaceId),
        appInstalls.listWorkspaceAppInstallEvents(workspaceId),
      ]);
      const lifecycleEventOf = new Map<string, string>();
      for (const event of lifecycleEvents) {
        if (!lifecycleEventOf.has(event.installId)) {
          lifecycleEventOf.set(event.installId, event.eventId);
        }
      }

      // THE ALREADY-METERED source set (the idempotent-skip set — the
      // migration-044 at-most-once source fence re-fences it under
      // concurrent collections).
      const meteredSources = await store.listMeteredSourceIds(workspaceId);
      const meteredInstalls = meteredSources.get('app-install-selection') ?? new Set<string>();
      const meteredInvocations = meteredSources.get('extension-invocation') ?? new Set<string>();

      let installationsCollected = 0;
      let installationsAlreadyMetered = 0;
      for (const row of installRows) {
        if (meteredInstalls.has(row.installId)) {
          installationsAlreadyMetered += 1;
          continue;
        }
        const idempotencyKey = collectInstallSelectionKey(row.installId);
        const existing = await store.findMeterEventByIdempotencyKey(workspaceId, idempotencyKey);
        if (existing !== null) {
          installationsAlreadyMetered += 1;
          continue;
        }
        const inserted = await store.insertMeterEvent({
          dimension: 'installations',
          unit: unitOfDimension('installations'),
          quantity: 1,
          agencyId,
          clientId,
          workspaceId,
          appKey: row.appKey,
          appVersionId: row.appVersionId,
          version: row.version,
          extensionId: null,
          extensionKey: null,
          extensionPublisher: null,
          extensionVersion: null,
          capability: null,
          stateNamespace: null,
          sourceKind: 'app-install-selection',
          sourceId: row.installId,
          sourceLinkId: lifecycleEventOf.get(row.installId) ?? row.installId,
          occurredAt: row.installedAt,
          recordedActor: provenance.actor,
          recordedVia: provenance.recordedVia,
          correlationId: provenance.correlationId,
          causationId: provenance.causationId,
          idempotencyKey,
          createFingerprint: collectFingerprint('app-install-selection', row.installId, {
            workspaceId,
            appKey: row.appKey,
            appVersionId: row.appVersionId,
            version: row.version,
          }),
        });
        if (inserted === 'taken') {
          // A concurrent collection converged first — at-most-once holds.
          installationsAlreadyMetered += 1;
          continue;
        }
        installationsCollected += 1;
      }

      // THE REAL INVOCATION SOURCE through the /extensions public
      // contract: the workspace's append-only invocation ledger. The
      // publisher fact resolves through the immutable registry (the
      // ledger row carries the extension id/key/version only). READ-ONLY.
      const invocationRows = await extensions.listExtensionInvocations(workspaceId);
      let invocationsCollected = 0;
      let invocationsAlreadyMetered = 0;
      for (const invocation of invocationRows) {
        if (meteredInvocations.has(invocation.invocationId)) {
          invocationsAlreadyMetered += 1;
          continue;
        }
        const idempotencyKey = collectInvocationKey(invocation.invocationId);
        const existing = await store.findMeterEventByIdempotencyKey(workspaceId, idempotencyKey);
        if (existing !== null) {
          invocationsAlreadyMetered += 1;
          continue;
        }
        const extensionRecord = await extensions.getExtensionVersion(invocation.extensionId);
        if (extensionRecord === null) {
          // The registry is immutable — an invocation's extension version
          // ALWAYS resolves. Unresolvable means data corruption: fail
          // closed rather than meter fabricated facts.
          throw new Error(
            `invocation ${invocation.invocationId} references extension version ${invocation.extensionId} that no longer resolves in the immutable registry`,
          );
        }
        const inserted = await store.insertMeterEvent({
          dimension: 'invocations',
          unit: unitOfDimension('invocations'),
          quantity: 1,
          agencyId,
          clientId,
          workspaceId,
          appKey: null,
          appVersionId: null,
          version: null,
          extensionId: invocation.extensionId,
          extensionKey: invocation.extensionKey,
          extensionPublisher: extensionRecord.manifest.publisher,
          extensionVersion: invocation.version,
          capability: null,
          stateNamespace: null,
          sourceKind: 'extension-invocation',
          sourceId: invocation.invocationId,
          sourceLinkId: invocation.executionId,
          occurredAt: invocation.issuedAt,
          recordedActor: provenance.actor,
          recordedVia: provenance.recordedVia,
          correlationId: provenance.correlationId,
          causationId: provenance.causationId,
          idempotencyKey,
          createFingerprint: collectFingerprint('extension-invocation', invocation.invocationId, {
            workspaceId,
            extensionId: invocation.extensionId,
            extensionKey: invocation.extensionKey,
            extensionPublisher: extensionRecord.manifest.publisher,
            extensionVersion: invocation.version,
          }),
        });
        if (inserted === 'taken') {
          invocationsAlreadyMetered += 1;
          continue;
        }
        invocationsCollected += 1;
      }

      return {
        workspaceId,
        installationsCollected,
        invocationsCollected,
        installationsAlreadyMetered,
        invocationsAlreadyMetered,
        meterEventsAppended: installationsCollected + invocationsCollected,
      };
    },

    // -----------------------------------------------------------------------
    // AC-1: THE USAGE-OBSERVATION INGESTION (module-level command)
    // -----------------------------------------------------------------------

    async recordMeterObservation(
      input: {
        readonly workspaceId: string;
        readonly appKey: string;
        readonly dimension: AppMeteringDimension;
        readonly quantity: number;
        readonly capability: string | null;
        readonly stateNamespace: string | null;
        readonly sourceInvocationId: string;
        readonly idempotencyKey: string;
      },
      provenance: AppMeteringProvenance,
    ): Promise<{ readonly event: AppMeterEventRecord; readonly replayed: boolean }> {
      assertValidObservationInput(input);
      assertValidMeteringProvenance(provenance);
      const ownership = await requireWorkspaceForWrite(input.workspaceId);
      const { agencyId, clientId, workspaceId } = ownership.scope;

      // THE CONTEXT GUARD: the app must be the workspace's CURRENT
      // (ACTIVE) MKT-048 selection — a foreign/unknown app-for-this-
      // workspace is the uniform 404 (no install oracle).
      const installs = await appInstalls.listWorkspaceAppInstalls(workspaceId);
      const current = installs.find(
        (row) => row.appKey === input.appKey && row.status === 'ACTIVE',
      );
      if (current === undefined) {
        throw new NotFoundError('app', `${input.appKey} (current selection in workspace ${workspaceId})`);
      }

      // The pinned manifest (the /apps public contract — READ-ONLY): the
      // metering-declaration guard's authority.
      const versionRecord = await apps.getAppVersion(current.appVersionId);
      if (versionRecord === null) {
        throw new NotFoundError('app version', current.appVersionId);
      }
      const manifest: AppManifest = versionRecord.manifest;

      // METERING DIMENSIONS ARE MANIFEST-DECLARED (the honest 422s).
      if (!manifest.meteringDimensions.includes(input.dimension)) {
        throw new InvalidRequestError(
          `dimension '${input.dimension}' is not declared by the meteringDimensions of app ${input.appKey}@${current.version} (declared: ${manifest.meteringDimensions.length === 0 ? 'none' : manifest.meteringDimensions.join(', ')}) — metering dimensions are manifest-declared`,
        );
      }
      if (
        input.dimension === 'premium-capabilities' &&
        !manifest.capabilities.some((capability) => capability.name === input.capability)
      ) {
        throw new InvalidRequestError(
          `capability '${input.capability}' is not declared by the manifest of app ${input.appKey}@${current.version} — premium-capability observations meter manifest-declared capabilities only`,
        );
      }
      if (
        input.stateNamespace !== null &&
        !manifest.stateNamespaces.includes(input.stateNamespace)
      ) {
        throw new InvalidRequestError(
          `stateNamespace '${input.stateNamespace}' is not declared by the manifest of app ${input.appKey}@${current.version} — data-volume namespaces are manifest-declared app-state namespaces only`,
        );
      }

      // THE CANONICAL PROVENANCE REFERENCE: the source invocation must
      // resolve through the real /extensions ledger and belong to the
      // SAME workspace (uniform 404 — foreign/unknown indistinguishable).
      const invocation = await extensions.getExtensionInvocation(input.sourceInvocationId);
      if (invocation === null || invocation.workspaceId !== workspaceId) {
        throw new NotFoundError('extension invocation', input.sourceInvocationId);
      }

      // The §8 replay convergence (identical fingerprint → the recorded
      // event; a divergent reuse of the key conflicts).
      const fingerprint = appMeterObservationCreateFingerprint({
        workspaceId,
        appKey: input.appKey,
        dimension: input.dimension,
        quantity: input.quantity,
        capability: input.capability,
        stateNamespace: input.stateNamespace,
        sourceInvocationId: input.sourceInvocationId,
      });
      const replay = replayOrConflict(
        input.idempotencyKey,
        await store.findMeterEventByIdempotencyKey(workspaceId, input.idempotencyKey),
        fingerprint,
      );
      if (replay.replayed) {
        return { event: replay.record, replayed: true };
      }

      const inserted = await store.insertMeterEvent({
        dimension: input.dimension,
        unit: unitOfDimension(input.dimension),
        quantity: input.quantity,
        agencyId,
        clientId,
        workspaceId,
        appKey: current.appKey,
        appVersionId: current.appVersionId,
        version: current.version,
        extensionId: null,
        extensionKey: null,
        extensionPublisher: null,
        extensionVersion: null,
        capability: input.dimension === 'premium-capabilities' ? input.capability : null,
        stateNamespace: input.dimension === 'data-volume' ? input.stateNamespace : null,
        sourceKind: 'observed-usage',
        sourceId: invocation.invocationId,
        sourceLinkId: invocation.executionId,
        occurredAt: now(),
        recordedActor: provenance.actor,
        recordedVia: provenance.recordedVia,
        correlationId: provenance.correlationId,
        causationId: provenance.causationId,
        idempotencyKey: input.idempotencyKey,
        createFingerprint: fingerprint,
      });
      if (inserted === 'taken') {
        const recorded = await store.findMeterEventByIdempotencyKey(workspaceId, input.idempotencyKey);
        if (recorded === null) {
          throw new Error(
            `recorded meter event under key '${input.idempotencyKey}' could not be read back`,
          );
        }
        if (recorded.createFingerprint !== fingerprint) {
          throw new IdempotencyConflictError(input.idempotencyKey);
        }
        return { event: recorded, replayed: true };
      }
      return { event: inserted, replayed: false };
    },

    // -----------------------------------------------------------------------
    // AC-5: THE ROLLUP RECOMPUTE (the disclosed rebuild path)
    // -----------------------------------------------------------------------

    async recomputeAttributionRollups() {
      const { rollupRows, rebuiltAt } = await store.recomputeRollups();
      const meterEventsConsidered = await store.countMeterEvents();
      return { rollupRows, meterEventsConsidered, rebuiltAt };
    },

    // -----------------------------------------------------------------------
    // AC-3/AC-4: THE ATTRIBUTION READ MODELS (live derivations)
    // -----------------------------------------------------------------------

    async getWorkspaceAppMetering(workspaceId: string): Promise<WorkspaceAppMeteringView> {
      if (typeof workspaceId !== 'string' || !UUID_PATTERN.test(workspaceId)) {
        throw new InvalidRequestError('workspaceId: must be a canonical workspace id (uuid)');
      }
      const ownership = await workspaceOwnership.resolveWorkspaceOwnership(workspaceId);
      if (ownership === null) {
        throw new NotFoundError('workspace', workspaceId);
      }
      const events = await store.listWorkspaceMeterEvents(workspaceId);
      const context = await workspaceSelectionContext(workspaceId);
      const { attributionBySource, invocationAttribution } = await resolveAttribution(events, () =>
        Promise.resolve(context),
      );
      const attributedAppKeys = [...attributionBySource.values()].filter(
        (appKey): appKey is string => appKey !== null,
      );
      const publishers = await publishersFor([
        ...new Set([...attributedAppKeys, ...context.currentSelectionCounts.keys()]),
      ]);
      const perApp: readonly AppMeteringAppAttribution[] = aggregatePerAppAttribution({
        events: events.map(sliceOf),
        attributionBySource,
        currentSelectionCounts: context.currentSelectionCounts,
        publishers,
      });
      return {
        scope: {
          kind: 'workspace-app-metering',
          agencyId: ownership.scope.agencyId,
          clientId: ownership.scope.clientId,
          workspaceId,
        },
        totals: aggregateDimensionTotals(events.map(sliceOf)),
        perApp,
        unattributedInvocations: unattributedInvocationsOf({ invocationAttribution }),
        calculation: composeAppMeteringCalculationDisclosure(),
        generatedAt: now(),
      };
    },

    async getAgencyAppMetering(agencyId: string): Promise<AgencyAppMeteringView> {
      if (typeof agencyId !== 'string' || !UUID_PATTERN.test(agencyId)) {
        throw new InvalidRequestError('agencyId: must be a canonical agency id (uuid)');
      }
      const events = await store.listAgencyMeterEvents(agencyId);
      const { attributionBySource, invocationAttribution } = await resolveAttribution(
        events,
        workspaceSelectionContext,
      );
      // The current-selection counts across the agency's workspaces (the
      // /app-installs public agency rollup — ACTIVE rows only).
      const current = await appInstalls.listAgencyAppInstalls(agencyId);
      const currentSelectionCounts = new Map<string, number>();
      for (const row of current) {
        currentSelectionCounts.set(row.appKey, (currentSelectionCounts.get(row.appKey) ?? 0) + 1);
      }
      const attributedAppKeys = [...attributionBySource.values()].filter(
        (appKey): appKey is string => appKey !== null,
      );
      const publishers = await publishersFor([
        ...new Set([...attributedAppKeys, ...currentSelectionCounts.keys()]),
      ]);
      const perApp: readonly AppMeteringAppAttribution[] = aggregatePerAppAttribution({
        events: events.map(sliceOf),
        attributionBySource,
        currentSelectionCounts,
        publishers,
      });
      return {
        scope: { kind: 'agency-app-metering', agencyId },
        totals: aggregateDimensionTotals(events.map(sliceOf)),
        perApp,
        perPublisher: aggregatePerPublisher({ perApp }),
        perPeriod: groupByPeriod(events.map(sliceOf)),
        unattributedInvocations: unattributedInvocationsOf({ invocationAttribution }),
        calculation: composeAppMeteringCalculationDisclosure(),
        generatedAt: now(),
      };
    },

    async getPublisherAppMetering(publisher: string): Promise<PublisherAppMeteringView> {
      if (typeof publisher !== 'string' || !PUBLISHER_PATTERN.test(publisher)) {
        throw new InvalidRequestError(
          'publisher: must be the server-derived platform-developer publisher identity (dev:<userId>)',
        );
      }
      const publisherUserId = publisher.slice('dev:'.length);

      // The publisher's app lineages through the /apps public registry
      // contract (READ-ONLY — the global listing filtered by publisher;
      // the lineage publisher is registry-consistent by the owner fence).
      const versions = await apps.listAppVersions({ appKey: null });
      const appKeys = [...new Set(versions.filter((v) => v.publisher === publisher).map((v) => v.appKey))];

      // The attributed events of the publisher's apps (install selections
      // + usage observations — their OWN app identity) ...
      const ownEvents = await store.listMeterEventsForAppKeys(appKeys);

      // ... PLUS the invocation events whose linkage attributes to one of
      // the publisher's apps (the per-workspace linkage derivation). Only
      // workspaces where one of the publisher's apps is CURRENTLY selected
      // are RELEVANT (an invocation elsewhere can never attribute here);
      // the relevant-but-unresolvable invocations are the publisher's
      // disclosed unattributed remainder.
      const invocationEvents = await store.listInvocationMeterEvents();
      const invocationAttribution = new Map<string, string | null>();
      const relevantInvocationAttribution = new Map<string, string | null>();
      const attributedInvocations: AppMeterEventRecord[] = [];
      const contexts = new Map<string, WorkspaceSelectionContext>();
      for (const event of invocationEvents) {
        let context = contexts.get(event.workspaceId);
        if (context === undefined) {
          context = await workspaceSelectionContext(event.workspaceId);
          contexts.set(event.workspaceId, context);
        }
        const publisherAppCurrent = appKeys.some((appKey) =>
          context!.currentSelectionCounts.has(appKey),
        );
        if (!publisherAppCurrent) continue;
        const verdict = attributeInvocationToApp(
          {
            extensionPublisher: event.extensionPublisher ?? '',
            extensionKey: event.extensionKey ?? '',
            extensionVersion: event.extensionVersion ?? '',
          },
          context.dependencies,
        );
        const attribution = 'appKey' in verdict ? verdict.appKey : null;
        invocationAttribution.set(event.sourceId, attribution);
        relevantInvocationAttribution.set(event.sourceId, attribution);
        if (attribution !== null && appKeys.includes(attribution)) {
          attributedInvocations.push(event);
        }
      }

      const events = [...ownEvents, ...attributedInvocations];
      const attributionBySource = new Map<string, string | null>();
      for (const event of events) {
        if (event.sourceKind === 'extension-invocation') {
          attributionBySource.set(
            `extension-invocation:${event.sourceId}`,
            invocationAttribution.get(event.sourceId) ?? null,
          );
        } else {
          attributionBySource.set(`${event.sourceKind}:${event.sourceId}`, event.appKey);
        }
      }
      // The publisher is KNOWN for every app in this view (the registry
      // filter derived the app set from it).
      const publishers = new Map<string, string>(appKeys.map((appKey) => [appKey, publisher]));
      const perApp: readonly AppMeteringAppAttribution[] = aggregatePerAppAttribution({
        events: events.map(sliceOf),
        attributionBySource,
        // The current-selection count is NOT derivable at platform scope
        // through the /app-installs public contract (no global by-app
        // listing) — the honest null, disclosed in the runbook.
        currentSelectionCounts: new Map<string, number>(),
        publishers,
      }).map((row) => ({ ...row, currentSelectionCount: null }));
      return {
        scope: { kind: 'publisher-app-metering', publisher, publisherUserId },
        totals: aggregateDimensionTotals(events.map(sliceOf)),
        perApp,
        perPeriod: groupByPeriod(events.map(sliceOf)),
        unattributedInvocations: unattributedInvocationsOf({
          invocationAttribution: relevantInvocationAttribution,
        }),
        calculation: composeAppMeteringCalculationDisclosure(),
        generatedAt: now(),
      };
    },

    // -----------------------------------------------------------------------
    // Raw tail reads
    // -----------------------------------------------------------------------

    async getAppMeterEvent(eventId: string): Promise<AppMeterEventRecord | null> {
      return store.getAppMeterEvent(eventId);
    },

    async listWorkspaceMeterEvents(workspaceId: string): Promise<readonly AppMeterEventRecord[]> {
      return store.listWorkspaceMeterEvents(workspaceId);
    },
  };
}

/**
 * The §8-style deterministic fingerprint of one collected meter event
 * (the canonical source content — the collection keys are deterministic
 * per source, so identical content converges identically). Pure.
 */
function collectFingerprint(
  kind: 'app-install-selection' | 'extension-invocation',
  sourceId: string,
  content: Record<string, unknown>,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ kind, sourceId, ...content }))
    .update('|mkt-052-collect')
    .digest('hex');
}
