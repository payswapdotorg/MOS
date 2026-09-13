/**
 * The /profit-intelligence module implementation (MKT-043 — Profit
 * Intelligence).
 *
 * A PURE LIVE DERIVATION over the canonical authorities — the /reporting
 * read-model posture (MKT-029/030): the module fetches the resolved scope's
 * authoritative rows through the composed authorities' PUBLIC CONTRACTS,
 * hands the plain snapshots to the PURE derivations
 * (internal/profit-derivation.ts) and composes the view. It owns NO durable
 * state — no tables, no snapshot store, no rebuild operation — so there is
 * nothing to recompute and nothing that can drift: authority changes are
 * visible on the very next read (the live-follow proof).
 *
 * Every composed dependency is consumed READ-ONLY; the module exposes three
 * READ methods and ZERO mutation methods of any kind (architecture-lock
 * v1.5 #6 — derived analytics, never a financial system of record).
 *
 * Isolation before traversal: the Client view resolves canonical Client
 * ownership first (/clients public contract); the Workspace view resolves
 * canonical Workspace ownership first (/workspaces public contract);
 * unknown, tombstoned or foreign identifiers are the uniform 404 upstream.
 */

import { NotFoundError } from '../../../platform/errors/errors.ts';
import type { GoalRecord } from '../../goals/public.ts';
import type {
  AgencyProfitIntelligenceView,
  ClientProfitIntelligenceView,
  ProfitIntelligenceModuleApi,
  ProfitIntelligenceModuleDeps,
  ProfitSourceRef,
  ScopeLeakageSurface,
  WorkspaceProfitIntelligenceView,
} from '../public.ts';
import type { ClientAuthoritySnapshot, ResolvedJobRef } from './profit-derivation.ts';
import {
  aggregateDeliveryCostBreakdowns,
  aggregateProjectContributions,
  aggregateRevenueRollups,
  aggregateServiceContributions,
  composeCalculationDisclosure,
  deriveClientContributionRow,
  deriveDeliveryCostBreakdown,
  deriveHumanCapacitySurface,
  deriveMarginSurface,
  deriveProjectContributions,
  deriveRevenueRollup,
  deriveScopeLeakageSurface,
  deriveServiceContributions,
  deriveUtilizationSurface,
} from './profit-derivation.ts';

/** The per-scope derived bundle (one gathered snapshot → every surface). */
interface ScopedDerivations {
  readonly revenue: ReturnType<typeof deriveRevenueRollup>;
  readonly costs: ReturnType<typeof deriveDeliveryCostBreakdown>;
  readonly capacity: ReturnType<typeof deriveHumanCapacitySurface>;
  readonly utilization: ReturnType<typeof deriveUtilizationSurface>;
  readonly scopeLeakage: ReturnType<typeof deriveScopeLeakageSurface>;
  readonly margin: ReturnType<typeof deriveMarginSurface>;
  readonly service: ReturnType<typeof deriveServiceContributions>;
  readonly project: ReturnType<typeof deriveProjectContributions>;
  readonly snapshot: ClientAuthoritySnapshot;
}

export function createProfitIntelligenceModule(
  deps: ProfitIntelligenceModuleDeps,
): ProfitIntelligenceModuleApi {
  // -------------------------------------------------------------------------
  // Snapshot gathering (ALL I/O lives here — the derivations stay pure)
  // -------------------------------------------------------------------------

  /**
   * Gathers one Client's authority snapshot through the public contracts
   * (READ-ONLY). `workspaceId` non-null narrows the snapshot to the
   * workspace slice (the workspace view).
   */
  async function gatherClientSnapshot(input: {
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceId: string | null;
    readonly humanAgentUserIds: readonly string[];
  }): Promise<ClientAuthoritySnapshot> {
    const { agencyId, clientId, workspaceId } = input;

    const liveWorkspaces = await deps.workspaces.listWorkspacesForClient(clientId);
    const targetWorkspaces = liveWorkspaces.filter(
      (workspace) => workspaceId === null || workspace.workspaceId === workspaceId,
    );

    const goals = await deps.goals.listGoalsForClient(clientId);
    const metricObservations = await deps.metrics.listMetricObservationsForClient(clientId);
    const connections = await deps.integrations.listConnectionsForClient(clientId);
    const ingestedEvents = await deps.integrations.listIngestedEventsForClient(clientId);

    const workspaceEntries: Array<ClientAuthoritySnapshot['workspaces'][number]> = [];
    const playbookVersionOwners = new Map<string, string>();
    for (const workspace of targetWorkspaces) {
      const deployments = await deps.deployments.listDeploymentsForWorkspace(
        workspace.workspaceId,
      );
      const workflows = await deps.workflows.listWorkflowsForWorkspace(workspace.workspaceId);
      const instances: Array<ClientAuthoritySnapshot['workspaces'][number]['instances'][number]> = [];
      const instanceDefinitionIds = new Map<string, string>();
      const definitionPlaybookVersionIds = new Map<string, string | null>();
      for (const workflow of workflows) {
        for (const definition of await deps.workflows.listWorkflowDefinitions(
          workflow.workflowId,
        )) {
          definitionPlaybookVersionIds.set(
            definition.workflowDefinitionId,
            definition.playbookVersionId,
          );
          if (definition.playbookVersionId !== null) {
            const version = await deps.playbooks.getPlaybookVersion(
              definition.playbookVersionId,
            );
            if (version !== null) {
              playbookVersionOwners.set(version.versionId, version.playbookId);
            }
          }
        }
        for (const instance of await deps.workflows.listWorkflowInstances(workflow.workflowId)) {
          instances.push(instance);
          instanceDefinitionIds.set(instance.workflowInstanceId, instance.workflowDefinitionId);
        }
      }
      const executions = await deps.executions.listExecutionsForWorkspace(workspace.workspaceId);
      const usageTelemetry = await deps.aiRuntime.listUsageTelemetry(workspace.workspaceId);
      workspaceEntries.push({
        workspaceId: workspace.workspaceId,
        deployments,
        instances,
        instanceDefinitionIds,
        definitionPlaybookVersionIds,
        executions,
        usageTelemetry,
      });
    }

    // The /jobs surface enumeration: the public contract exposes no
    // per-scope job listing — jobs are reached through the ACCEPTED offers
    // of the agency's human agents (the scope-as-data membership input)
    // and filtered to THIS scope. This is the disclosed enumeration window
    // (jobs never offered to this agency's humans stay out of it — nothing
    // was delivered through them).
    const resolvedJobs: ResolvedJobRef[] = [];
    const seenJobIds = new Set<string>();
    for (const userId of input.humanAgentUserIds) {
      const offers = await deps.jobs.listOffersForCandidate(userId);
      for (const offer of offers) {
        if (offer.status !== 'accepted') continue;
        if (seenJobIds.has(offer.jobId)) continue;
        const job = await deps.jobs.getJob(offer.jobId);
        if (job === null) continue;
        if (job.agencyId !== agencyId || job.clientId !== clientId) continue;
        if (workspaceId !== null && job.workspaceId !== workspaceId) continue;
        seenJobIds.add(offer.jobId);
        resolvedJobs.push({ job, acceptedOfferId: offer.jobOfferId });
      }
    }

    // The /field-agents capacity pool: the membership users' profiles.
    const humanAgentProfiles = [];
    const missingProfileUserIds: string[] = [];
    for (const userId of input.humanAgentUserIds) {
      const profile = await deps.fieldAgents.getHumanAgentByUser(userId);
      if (profile === null) {
        missingProfileUserIds.push(userId);
        continue;
      }
      humanAgentProfiles.push(profile);
    }

    return {
      agencyId,
      clientId,
      workspaceId,
      goals,
      metricObservations,
      workspaces: workspaceEntries,
      resolvedJobs,
      humanAgentProfiles,
      missingProfileUserIds,
      connections,
      ingestedEvents,
      playbookVersionOwners,
    };
  }

  /** Derives every per-scope surface from one gathered snapshot (pure). */
  function deriveScopedViews(snapshot: ClientAuthoritySnapshot): ScopedDerivations {
    const revenueObservations =
      snapshot.workspaceId === null
        ? snapshot.metricObservations
        : snapshot.metricObservations.filter(
            (observation) => observation.workspaceId === snapshot.workspaceId,
          );
    const revenue = deriveRevenueRollup(revenueObservations);

    const executions = snapshot.workspaces.flatMap((workspace) => workspace.executions);
    const usageTelemetry = snapshot.workspaces.flatMap((workspace) => workspace.usageTelemetry);
    const costs = deriveDeliveryCostBreakdown({
      executions,
      usageTelemetry,
      resolvedJobs: snapshot.resolvedJobs,
      connections: snapshot.connections,
      ingestedEvents: snapshot.ingestedEvents,
    });

    const capacity = deriveHumanCapacitySurface(
      snapshot.humanAgentProfiles,
      snapshot.missingProfileUserIds,
    );

    const deliveredJobs = snapshot.resolvedJobs.filter(
      (resolved) => resolved.job.status === 'outcome_submitted',
    );
    const utilization = deriveUtilizationSurface({
      deliveredJobCount: deliveredJobs.length,
      humanExecutionCount: executions.filter((execution) => execution.executionKind === 'human')
        .length,
      capacityMinutes: capacity.weeklyCapacityMinutes,
      deliveredJobRefs: deliveredJobs.map(({ job }) => ({
        kind: 'job' as const,
        id: job.jobId,
      })),
      capacityRefs: capacity.profileRefs,
    });

    // The workspace-slice goal population: goals COVERING the workspace
    // (its own + client-wide) — the same covering rule feeds BOTH the
    // leakage indicators and the margin (a goal scoped to a DIFFERENT
    // workspace of the client is out of this slice entirely: it is not
    // this workspace's declared scope and never its leakage).
    const coveringGoals: readonly GoalRecord[] =
      snapshot.workspaceId === null
        ? snapshot.goals
        : snapshot.goals.filter(
            (goal) => goal.workspaceId === null || goal.workspaceId === snapshot.workspaceId,
          );
    const scopeLeakage = deriveScopeLeakageSurface({
      goals: coveringGoals,
      workspaces: snapshot.workspaces.map((workspace) => ({
        workspaceId: workspace.workspaceId,
        deployments: workspace.deployments,
        instances: workspace.instances,
      })),
      executions,
    });

    const margin = deriveMarginSurface({
      revenue,
      costs,
      goals: coveringGoals,
      weeklyCapacityCost: capacity.weeklyCapacityCost,
    });

    const service = deriveServiceContributions({ snapshot });
    const project = deriveProjectContributions({ snapshot });

    return { revenue, costs, capacity, utilization, scopeLeakage, margin, service, project, snapshot };
  }

  /**
   * Merges the per-client scope-leakage surfaces into portfolio totals.
   * The per-client snapshots counted each client's goals, workspaces and
   * executions exactly once (client scopes are disjoint), so the merge is
   * a pure count sum + reference union per indicator kind.
   */
  function mergeLeakageSurfaces(surfaces: readonly ScopeLeakageSurface[]): ScopeLeakageSurface {
    const merged = new Map<
      ScopeLeakageSurface['indicators'][number]['kind'],
      { count: number; refs: Map<string, ProfitSourceRef> }
    >();
    for (const surface of surfaces) {
      for (const indicator of surface.indicators) {
        const entry = merged.get(indicator.kind) ?? { count: 0, refs: new Map() };
        entry.count += indicator.count;
        for (const sourceRef of indicator.sourceRefs) {
          entry.refs.set(`${sourceRef.kind}:${sourceRef.id}`, sourceRef);
        }
        merged.set(indicator.kind, entry);
      }
    }
    return {
      indicators: [...merged.entries()].map(([kind, entry]) => ({
        kind,
        rule: LEAKAGE_RULES[kind],
        count: entry.count,
        sourceRefs: [...entry.refs.values()],
      })),
    };
  }

  // -------------------------------------------------------------------------
  // READS — the three derived views
  // -------------------------------------------------------------------------

  return {
    async getClientProfitIntelligence({
      clientId,
      humanAgentUserIds,
    }): Promise<ClientProfitIntelligenceView> {
      // Canonical Client ownership BEFORE any dependent traversal (§14):
      // unknown or tombstoned Client → the uniform 404 (a foreign Client
      // identifier is not a traversal oracle).
      const ownership = await deps.clients.resolveClientOwnership(clientId);
      if (ownership === null) {
        throw new NotFoundError('client', clientId);
      }
      const agencyId = ownership.scope.agencyId;
      const liveWorkspaces = await deps.workspaces.listWorkspacesForClient(clientId);

      const snapshot = await gatherClientSnapshot({
        agencyId,
        clientId,
        workspaceId: null,
        humanAgentUserIds,
      });
      const derived = deriveScopedViews(snapshot);

      return {
        scope: {
          kind: 'client-profit-intelligence',
          agencyId,
          clientId,
          workspaceCount: liveWorkspaces.length,
        },
        revenue: derived.revenue,
        costs: derived.costs,
        capacity: derived.capacity,
        utilization: derived.utilization,
        scopeLeakage: derived.scopeLeakage,
        margin: derived.margin,
        serviceContributions: derived.service.rows,
        unattributedServiceDeliveryCost: derived.service.unattributedDeliveryCost,
        projectContributions: derived.project.rows,
        unattributedProjectDeliveryCost: derived.project.unattributedDeliveryCost,
        calculation: composeCalculationDisclosure(),
        generatedAt: deps.clock.nowIso(),
      };
    },

    async getWorkspaceProfitIntelligence({
      workspaceId,
      humanAgentUserIds,
    }): Promise<WorkspaceProfitIntelligenceView> {
      // Canonical Workspace ownership BEFORE any dependent traversal (§14):
      // unknown, tombstoned or foreign Workspace → the uniform 404.
      const ownership = await deps.workspaces.resolveWorkspaceOwnership(workspaceId);
      if (ownership === null) {
        throw new NotFoundError('workspace', workspaceId);
      }
      const { agencyId, clientId } = ownership.scope;

      const snapshot = await gatherClientSnapshot({
        agencyId,
        clientId,
        workspaceId,
        humanAgentUserIds,
      });
      const derived = deriveScopedViews(snapshot);

      return {
        scope: {
          kind: 'workspace-profit-intelligence',
          agencyId,
          clientId,
          workspaceId,
        },
        revenue: derived.revenue,
        costs: derived.costs,
        utilization: derived.utilization,
        scopeLeakage: derived.scopeLeakage,
        margin: derived.margin,
        calculation: composeCalculationDisclosure(),
        generatedAt: deps.clock.nowIso(),
      };
    },

    async getAgencyProfitIntelligence({
      agencyId,
      clients,
      humanAgentUserIds,
    }): Promise<AgencyProfitIntelligenceView> {
      // The aggregation scope arrived as SERVER-DERIVED data (the route
      // resolved the agency's LIVE Clients + ACTIVE human_agent memberships
      // from durable state — the scope-as-data posture). Each Client's
      // figures derive from that Client's OWN authority rows; the rollup
      // merges the derived results (pure aggregation).
      const perClient: ReturnType<typeof deriveClientContributionRow>[] = [];
      const revenues: ReturnType<typeof deriveRevenueRollup>[] = [];
      const costs: ReturnType<typeof deriveDeliveryCostBreakdown>[] = [];
      const services: ReturnType<typeof deriveServiceContributions>[] = [];
      const projects: ReturnType<typeof deriveProjectContributions>[] = [];
      const leakages: ScopeLeakageSurface[] = [];
      const goalsAcrossPortfolio: GoalRecord[] = [];
      let deliveredJobCount = 0;
      let humanExecutionCount = 0;
      const deliveredJobRefs: Array<{ kind: 'job'; id: string }> = [];

      for (const entry of clients) {
        const ownership = await deps.clients.resolveClientOwnership(entry.clientId);
        // A tombstoned Client drops out of the LIVE scope (the route's
        // listing already excluded tombstones; this re-check is the
        // fail-closed backstop for concurrent deletes).
        if (ownership === null) continue;
        const snapshot = await gatherClientSnapshot({
          agencyId,
          clientId: entry.clientId,
          workspaceId: null,
          humanAgentUserIds,
        });
        const derived = deriveScopedViews(snapshot);
        perClient.push(
          deriveClientContributionRow({
            clientId: entry.clientId,
            revenue: derived.revenue,
            costs: derived.costs,
          }),
        );
        revenues.push(derived.revenue);
        costs.push(derived.costs);
        services.push(derived.service);
        projects.push(derived.project);
        leakages.push(derived.scopeLeakage);
        goalsAcrossPortfolio.push(...snapshot.goals);
        for (const resolved of snapshot.resolvedJobs) {
          if (resolved.job.status !== 'outcome_submitted') continue;
          deliveredJobCount += 1;
          deliveredJobRefs.push({ kind: 'job', id: resolved.job.jobId });
        }
        humanExecutionCount += snapshot.workspaces
          .flatMap((workspace) => workspace.executions)
          .filter((execution) => execution.executionKind === 'human').length;
      }

      const revenue = aggregateRevenueRollups(revenues);
      const portfolioCosts = aggregateDeliveryCostBreakdowns(costs);
      const service = aggregateServiceContributions(services);
      const project = aggregateProjectContributions(projects);

      // The capacity pool resolves once for the portfolio surface (the
      // per-client snapshots each resolved the same pool for their context
      // blocks — the pure function is deterministic, the figures match).
      const poolProfiles = [];
      for (const userId of humanAgentUserIds) {
        const profile = await deps.fieldAgents.getHumanAgentByUser(userId);
        if (profile !== null) poolProfiles.push(profile);
      }
      const capacity = deriveHumanCapacitySurface(poolProfiles, []);

      const utilization = deriveUtilizationSurface({
        deliveredJobCount,
        humanExecutionCount,
        capacityMinutes: capacity.weeklyCapacityMinutes,
        deliveredJobRefs,
        capacityRefs: capacity.profileRefs,
      });

      const margin = deriveMarginSurface({
        revenue,
        costs: portfolioCosts,
        goals: goalsAcrossPortfolio,
        weeklyCapacityCost: capacity.weeklyCapacityCost,
      });

      return {
        scope: {
          kind: 'agency-profit-intelligence',
          agencyId,
          clientCount: perClient.length,
          humanAgentCount: capacity.activeProfileCount,
        },
        perClient,
        serviceContributions: service.rows,
        unattributedServiceDeliveryCost: service.unattributedDeliveryCost,
        projectContributions: project.rows,
        unattributedProjectDeliveryCost: project.unattributedDeliveryCost,
        revenue,
        costs: portfolioCosts,
        capacity,
        utilization,
        scopeLeakage: mergeLeakageSurfaces(leakages),
        margin,
        calculation: composeCalculationDisclosure(),
        generatedAt: deps.clock.nowIso(),
      };
    },
  };
}

/** The frozen leakage rules (mirrored from the pure derivation). */
const LEAKAGE_RULES: Readonly<
  Record<ScopeLeakageSurface['indicators'][number]['kind'], string>
> = {
  'executions-outside-deployed-envelope':
    'an execution counts when its task-linked workflow instance pins a definition that NO ACTIVE deployment of the workspace declares (delivery outside the deployed envelope; external-request executions are out of rule)',
  'work-without-active-goal':
    'a non-terminal workflow instance counts when NO ACTIVE goal of the client covers its workspace (client-wide goals cover every workspace; workspace-scoped goals cover exactly their own)',
  'active-goals-without-delivery':
    'an ACTIVE goal counts when zero workflow instances exist in its scope (its own workspace, or any workspace of the client when client-wide)',
};
