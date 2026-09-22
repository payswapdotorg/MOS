"use client";

/**
 * MOS data hooks — thin TanStack Query wrappers over the single API client.
 * A 401 anywhere clears the session (back to login); every other error is
 * rendered honestly by the calling screen.
 */

import { useEffect } from "react";
import { toast } from "sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { GrowthMissionCreateBody } from "@/components/mos/create/flow";
import {
  mosGet,
  mosPost,
  type AgencyAttentionView,
  type AgencyRecord,
  type AllocationRecommendationView,
  type AppInstallRecord,
  type AuthContext,
  type ClientMemoryView,
  type ClientRecord,
  type CommandCenterView,
  type ContentAssetVersionView,
  type ContentRightsRecordView,
  type ContentTransformationView,
  type DecisionEventRecord,
  type DecisionRecord,
  type DeploymentRecord,
  type DeveloperCatalogApp,
  type DevPortalDocs,
  type EvidenceRecord,
  type ExperimentAnalysisView,
  type ExperimentView,
  type FirstPartyPack,
  type GoalRecord,
  type GrowthMissionDetailView,
  type JobDescriptor,
  type JobsDiscoveryView,
  type JobsQueueView,
  type LearningRecord,
  type MarketplaceAppDetail,
  type MarketplaceAppEntry,
  type MembershipRecord,
  type MetricObservationView,
  type OfferClaimResponse,
  type PackSurfaceComposition,
  type PlaybookRecord,
  type PolicyVersionRecord,
  type ProfitAgencyView,
  type ProfitClientView,
  type SocialAccountEventView,
  type SocialAccountView,
  type UserRecord,
  type WorkflowRecord,
  type WorkspaceRecord,
} from "@/lib/mos-api";
import { useMosSession } from "./session-store";

/** Route any 401 to the login screen + drop the presentation session. */
function useUnauthorizedWatch(error: unknown): void {
  const clearSession = useMosSession((state) => state.clearSession);
  useEffect(() => {
    if (
      error !== null &&
      typeof error === "object" &&
      "status" in error &&
      (error as { status?: number }).status === 401
    ) {
      clearSession();
    }
  }, [error, clearSession]);
}

export function useMosQuery<T>(key: readonly unknown[], path: string | null) {
  const query = useQuery({
    queryKey: key,
    queryFn: () => mosGet<T>(path as string),
    enabled: path !== null,
    retry: false,
    staleTime: 15_000,
  });
  useUnauthorizedWatch(query.error);
  return query;
}

// --- Session -------------------------------------------------------------------

export function useAuthContext() {
  const token = useMosSession((state) => state.token);
  return useMosQuery<AuthContext>(["auth-context"], token === null ? null : "/api/auth/authorization-context");
}

// --- Agency + clients ------------------------------------------------------------

export function useAgency(agencyId: string | null) {
  return useMosQuery<AgencyRecord>(["agency", agencyId], agencyId === null ? null : `/api/agencies/${agencyId}`);
}

export function useMemberships(agencyId: string | null) {
  const query = useMosQuery<{ memberships: MembershipRecord[] }>(
    ["memberships", agencyId],
    agencyId === null ? null : `/api/agencies/${agencyId}/memberships`,
  );
  return { ...query, data: query.data?.memberships };
}

export function useClients(agencyId: string | null) {
  const query = useMosQuery<{ clients: ClientRecord[] }>(
    ["clients", agencyId],
    agencyId === null ? null : `/api/agencies/${agencyId}/clients`,
  );
  return { ...query, data: query.data?.clients };
}

export function useClient(clientId: string | null) {
  return useMosQuery<ClientRecord>(["client", clientId], clientId === null ? null : `/api/clients/${clientId}`);
}

export function useWorkspaces(clientId: string | null) {
  const query = useMosQuery<{ workspaces: WorkspaceRecord[] }>(
    ["workspaces", clientId],
    clientId === null ? null : `/api/clients/${clientId}/workspaces`,
  );
  return { ...query, data: query.data?.workspaces };
}

export function useCreateClient(agencyId: string) {
  const client = useQueryClient();
  const navigate = useMosSession((state) => state.navigate);
  return useMutation({
    mutationFn: (name: string) =>
      mosPost<ClientRecord>(`/api/agencies/${agencyId}/clients`, { name }),
    onSuccess: (record) => {
      toast.success(`Client "${record.name}" created`);
      client.invalidateQueries({ queryKey: ["clients", agencyId] });
      navigate({ kind: "client", clientId: record.clientId, tab: "overview" });
    },
    onError: (error) => toast.error(String(error instanceof Error ? error.message : error)),
  });
}

// --- Growth missions (UX-002 — reusable mission creation) ----------------------

/**
 * Create a Growth Mission through the REAL agency-scoped contract:
 * POST /api/agencies/:agencyId/growth-missions (owner|admin; 201 returns the
 * composed detail — born `draft`, version 1, first history event). The body
 * carries ONLY caller-declarable fields (objective verbatim, the frozen §3
 * family, optional product/market context, optional targetMetrics); every
 * authority field (missionId/status/version/provenance/…) is server-derived
 * and never sent. On success the agency mission list is invalidated (so the
 * home screen's "Continue a mission" refetches live) and the SPA navigates
 * to the honest mission-created read-back.
 */
export function useCreateGrowthMission(agencyId: string) {
  const client = useQueryClient();
  const navigate = useMosSession((state) => state.navigate);
  return useMutation({
    mutationFn: (declaration: GrowthMissionCreateBody) =>
      mosPost<GrowthMissionDetailView>(
        `/api/agencies/${agencyId}/growth-missions`,
        declaration,
      ),
    onSuccess: (detail) => {
      toast.success("Mission created — it starts as a draft");
      client.invalidateQueries({ queryKey: ["growth-missions", agencyId] });
      navigate({ kind: "mission-created", missionId: detail.mission.missionId });
    },
    onError: (error) => toast.error(String(error instanceof Error ? error.message : error)),
  });
}

// --- UX-003 Mission Workspace composition hooks ----------------------------------
//
// The COMPOSITION DISCIPLINE: every hook below is a THIN useMosQuery wrapper
// over ONE existing read surface (or ONE existing mutation route). No second
// analytics layer, no client-side derivation — each datum's authority stays
// the backend module that owns it. Queries are DISABLED (path === null) until
// their real input resolves, so young missions with no client context make
// ZERO client-scoped calls.

/** The mission's own truth — GET /api/growth-missions/:missionId
 *  (the composed honest read-back: record, current version, goal mappings
 *  with LIVE goal status, append-only history, terminal decision basis). */
export function useGrowthMissionDetail(missionId: string | null) {
  return useMosQuery<GrowthMissionDetailView>(
    ["growth-mission", missionId],
    missionId === null ? null : `/api/growth-missions/${missionId}`,
  );
}

/** The client's experiments (the hypothesis + experiment authority):
 *  GET /api/clients/:clientId/experiments. */
export function useExperimentsForClient(clientId: string | null) {
  const query = useMosQuery<{ clientId: string; experiments: ExperimentView[] }>(
    ["experiments", clientId],
    clientId === null ? null : `/api/clients/${clientId}/experiments`,
  );
  return { ...query, data: query.data?.experiments };
}

/** The client's metric observations (the measurement authority):
 *  GET /api/clients/:clientId/metrics. */
export function useMetricObservations(clientId: string | null) {
  const query = useMosQuery<{ clientId: string; observations: MetricObservationView[] }>(
    ["metric-observations", clientId],
    clientId === null ? null : `/api/clients/${clientId}/metrics`,
  );
  return { ...query, data: query.data?.observations };
}

/** The client's social account bindings (the platforms authority — the
 *  frozen 056 connection states): GET /api/clients/:clientId/social-accounts. */
export function useSocialAccounts(clientId: string | null) {
  const query = useMosQuery<{ clientId: string; socialAccounts: SocialAccountView[] }>(
    ["social-accounts", clientId],
    clientId === null ? null : `/api/clients/${clientId}/social-accounts`,
  );
  return { ...query, data: query.data?.socialAccounts };
}

/** One account's append-only event tail — the observable-now surface the
 *  health section composes while Platform Health (MKT-066) is not built:
 *  GET /api/clients/:clientId/social-accounts/:accountId/events. */
export function useSocialAccountEvents(clientId: string | null, accountId: string | null) {
  const query = useMosQuery<{ socialAccountId: string; events: SocialAccountEventView[] }>(
    ["social-account-events", clientId, accountId],
    clientId === null || accountId === null
      ? null
      : `/api/clients/${clientId}/social-accounts/${accountId}/events`,
  );
  return { ...query, data: query.data?.events };
}

/** The client's content asset versions (the 064 versioned-asset model):
 *  GET /api/clients/:clientId/content-assets. */
export function useContentAssets(clientId: string | null) {
  const query = useMosQuery<{ clientId: string; versions: ContentAssetVersionView[] }>(
    ["content-assets", clientId],
    clientId === null ? null : `/api/clients/${clientId}/content-assets`,
  );
  return { ...query, data: query.data?.versions };
}

/** The client's content transformations (the transformation surface):
 *  GET /api/clients/:clientId/content-assets/transformations. */
export function useContentTransformations(clientId: string | null) {
  const query = useMosQuery<{ clientId: string; transformations: ContentTransformationView[] }>(
    ["content-transformations", clientId],
    clientId === null ? null : `/api/clients/${clientId}/content-assets/transformations`,
  );
  return { ...query, data: query.data?.transformations };
}

/** The client's content rights records: GET /api/clients/:clientId/content-rights. */
export function useContentRights(clientId: string | null) {
  const query = useMosQuery<{ clientId: string; records: ContentRightsRecordView[] }>(
    ["content-rights", clientId],
    clientId === null ? null : `/api/clients/${clientId}/content-rights`,
  );
  return { ...query, data: query.data?.records };
}

/** The experiment's sequential analysis tail (the NEW MKT-067 surface):
 *  GET /api/clients/:clientId/experiment-analysis/analyses/by-experiment/:experimentId.
 *  Mounted per-expanded-experiment (the expand→fetch house pattern) — never
 *  a bulk prefetch. */
export function useExperimentAnalyses(clientId: string | null, experimentId: string | null) {
  const query = useMosQuery<{ analyses: ExperimentAnalysisView[] }>(
    ["experiment-analyses", clientId, experimentId],
    clientId === null || experimentId === null
      ? null
      : `/api/clients/${clientId}/experiment-analysis/analyses/by-experiment/${experimentId}`,
  );
  return { ...query, data: query.data?.analyses };
}

/** The experiment's allocation recommendation tail (MKT-067):
 *  GET /api/clients/:clientId/experiment-analysis/allocations/by-experiment/:experimentId. */
export function useExperimentAllocations(clientId: string | null, experimentId: string | null) {
  const query = useMosQuery<{ recommendations: AllocationRecommendationView[] }>(
    ["experiment-allocations", clientId, experimentId],
    clientId === null || experimentId === null
      ? null
      : `/api/clients/${clientId}/experiment-analysis/allocations/by-experiment/${experimentId}`,
  );
  return { ...query, data: query.data?.recommendations };
}

/**
 * The mission lifecycle transition through the REAL contract:
 * POST /api/growth-missions/:missionId/status (owner|admin; REQUIRED reason;
 * CAS on the mission's LIVE version — read fresh from the detail query and
 * sent as-is, never cached). The server validates the frozen transition
 * table and the ≥1-mapped-goal activation rule; a 409/403/422 surfaces the
 * server's own words verbatim in the calling screen (never a faked
 * transition). NEVER auto-invoked — the workspace calls this only from the
 * explicit, deliberate lifecycle action.
 */
export function useSetGrowthMissionStatus(missionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { status: string; reason: string; version: number }) =>
      mosPost<GrowthMissionDetailView>(`/api/growth-missions/${missionId}/status`, {
        status: input.status,
        reason: input.reason,
        version: input.version,
      }),
    onSuccess: (detail) => {
      toast.success(`Mission is now ${detail.mission.status.replace(/_/g, " ")}`);
      queryClient.invalidateQueries({ queryKey: ["growth-mission", missionId] });
      // The home mission list + any agency mission lists follow live.
      queryClient.invalidateQueries({ queryKey: ["growth-missions"] });
    },
    // Errors are DELIBERATELY not toasted: the lifecycle action renders the
    // server's 409/403/422 verbatim inline (the UX-002 precedent) so the
    // operator sees the platform's own words in context.
  });
}

/**
 * Map an EXISTING goal to the mission through the REAL contract:
 * POST /api/growth-missions/:missionId/goal-mappings {goalId} (owner|admin).
 * The /goals authority stays the measurable anchor — this only records the
 * mapping; the live goal status comes back through the detail read.
 */
export function useMapGoalToMission(missionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { goalId: string }) =>
      mosPost<GrowthMissionDetailView>(`/api/growth-missions/${missionId}/goal-mappings`, {
        goalId: input.goalId,
      }),
    onSuccess: () => {
      toast.success("Goal mapped — its live status now shows in progress");
      queryClient.invalidateQueries({ queryKey: ["growth-mission", missionId] });
    },
    // Same deliberate posture as the lifecycle mutation: the calling screen
    // renders the server's own 404/409/403 words inline.
  });
}

// --- Reporting --------------------------------------------------------------------

export function useCommandCenter(agencyId: string | null) {
  return useMosQuery<CommandCenterView>(
    ["command-center", agencyId],
    agencyId === null ? null : `/api/reporting/command-center/${agencyId}`,
  );
}

export function useDecisionRoom(clientId: string | null) {
  return useMosQuery<import("@/lib/mos-api").DecisionRoomView>(
    ["decision-room", clientId],
    clientId === null ? null : `/api/reporting/decision-room/${clientId}`,
  );
}

// --- Client domain surfaces ---------------------------------------------------------

export function useGoals(clientId: string | null) {
  const query = useMosQuery<{ goals: GoalRecord[] }>(
    ["goals", clientId],
    clientId === null ? null : `/api/clients/${clientId}/goals`,
  );
  return { ...query, data: query.data?.goals };
}

export function usePlaybooks(clientId: string | null) {
  const query = useMosQuery<{ playbooks: PlaybookRecord[] }>(
    ["playbooks", clientId],
    clientId === null ? null : `/api/clients/${clientId}/playbooks`,
  );
  return { ...query, data: query.data?.playbooks };
}

export function useDeployments(workspaceId: string | null) {
  const query = useMosQuery<{ deployments: DeploymentRecord[] }>(
    ["deployments", workspaceId],
    workspaceId === null ? null : `/api/workspaces/${workspaceId}/deployments`,
  );
  return { ...query, data: query.data?.deployments };
}

export function useWorkflows(workspaceId: string | null) {
  const query = useMosQuery<{ workflows: WorkflowRecord[] }>(
    ["workflows", workspaceId],
    workspaceId === null ? null : `/api/workspaces/${workspaceId}/workflows`,
  );
  return { ...query, data: query.data?.workflows };
}

export function useEvidence(clientId: string | null) {
  const query = useMosQuery<{ evidence: EvidenceRecord[] }>(
    ["evidence", clientId],
    clientId === null ? null : `/api/clients/${clientId}/evidence`,
  );
  return { ...query, data: query.data?.evidence };
}

export function useDecisions(clientId: string | null) {
  const query = useMosQuery<{ decisions: DecisionRecord[] }>(
    ["decisions", clientId],
    clientId === null ? null : `/api/clients/${clientId}/decisions`,
  );
  return { ...query, data: query.data?.decisions };
}

export function useLearnings(clientId: string | null) {
  const query = useMosQuery<{ learnings: LearningRecord[] }>(
    ["learnings", clientId],
    clientId === null ? null : `/api/clients/${clientId}/learnings`,
  );
  return { ...query, data: query.data?.learnings };
}

export function useClientMemory(agencyId: string | null, clientId: string | null) {
  return useMosQuery<ClientMemoryView>(
    ["client-memory", agencyId, clientId],
    agencyId === null || clientId === null
      ? null
      : `/api/client-memory/${agencyId}/clients/${clientId}`,
  );
}

export function useDecision(decisionId: string | null) {
  return useMosQuery<DecisionRecord>(["decision", decisionId], decisionId === null ? null : `/api/decisions/${decisionId}`);
}

export function useDecisionEvents(decisionId: string | null) {
  const query = useMosQuery<{ events: DecisionEventRecord[] }>(
    ["decision-events", decisionId],
    decisionId === null ? null : `/api/decisions/${decisionId}/events`,
  );
  return { ...query, data: query.data?.events };
}

export function useDecisionDisposition(decisionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { command: "accept" | "reject"; reason: string }) =>
      mosPost<{ decision: DecisionRecord }>(`/api/decisions/${decisionId}/disposition`, {
        command: input.command,
        ...(input.reason === "" ? {} : { reason: input.reason }),
        idempotencyKey: `spa-disposition:${decisionId}:${input.command}:${Date.now()}`,
      }),
    onSuccess: (result) => {
      toast.success(`Decision ${result.decision.disposition}`);
      client.invalidateQueries({ queryKey: ["decision", decisionId] });
      client.invalidateQueries({ queryKey: ["decision-events", decisionId] });
      client.invalidateQueries({ queryKey: ["decisions"] });
    },
    onError: (error) => toast.error(String(error instanceof Error ? error.message : error)),
  });
}

// --- Attention + Profit --------------------------------------------------------------

export function useAttentionQueue(agencyId: string | null) {
  return useMosQuery<AgencyAttentionView>(
    ["attention-queue", agencyId],
    agencyId === null ? null : `/api/ai-operator/${agencyId}/attention-queue`,
  );
}

export function useAttentionItem(agencyId: string | null, itemId: string | null) {
  return useMosQuery<import("@/lib/mos-api").AttentionItemDetailView>(
    ["attention-item", agencyId, itemId],
    agencyId === null || itemId === null
      ? null
      : `/api/ai-operator/${agencyId}/attention-queue/${encodeURIComponent(itemId)}`,
  );
}

export function useProfitAgency(agencyId: string | null) {
  return useMosQuery<ProfitAgencyView>(
    ["profit-agency", agencyId],
    agencyId === null ? null : `/api/profit-intelligence/${agencyId}`,
  );
}

export function useProfitClient(agencyId: string | null, clientId: string | null) {
  return useMosQuery<ProfitClientView>(
    ["profit-client", agencyId, clientId],
    agencyId === null || clientId === null
      ? null
      : `/api/profit-intelligence/${agencyId}/clients/${clientId}`,
  );
}

// --- Human work -----------------------------------------------------------------------

export function useJobsQueue() {
  return useMosQuery<JobsQueueView>(["jobs-queue"], "/api/jobs/queue");
}

export function useJobsDiscovery() {
  return useMosQuery<JobsDiscoveryView>(["jobs-discovery"], "/api/jobs/queue/discovery");
}

export function useJobsMarketplace() {
  const query = useMosQuery<{ matched: number; jobs: JobDescriptor[] }>(
    ["jobs-marketplace"],
    "/api/jobs/marketplace",
  );
  return { ...query, data: query.data };
}

/**
 * Accept/decline an open offer through the REAL queue claim contracts
 * POST /api/jobs/queue/offers/:offerId/accept|decline (empty body — every
 * decision input is server-derived). The response carries the updated job,
 * the offer and a `replayed` flag (idempotent replay convergence); a 409/404
 * surfaces the server's own words — never a faked transition.
 */
export function useQueueOfferMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { offerId: string; action: "accept" | "decline" }) =>
      mosPost<OfferClaimResponse>(`/api/jobs/queue/offers/${input.offerId}/${input.action}`, {}),
    onSuccess: (result, input) => {
      const title = result.job.title;
      toast.success(
        `Offer ${input.action === "accept" ? "accepted" : "declined"} — "${title}"` +
          (result.replayed ? " (replayed — this decision was already recorded)" : ""),
      );
      client.invalidateQueries({ queryKey: ["jobs-queue"] });
      client.invalidateQueries({ queryKey: ["jobs-marketplace"] });
      client.invalidateQueries({ queryKey: ["jobs-discovery"] });
    },
    onError: (error) => toast.error(String(error instanceof Error ? error.message : error)),
  });
}

// --- App ecosystem ---------------------------------------------------------------------

export function useWorkspaceInstalls(workspaceId: string | null) {
  const query = useMosQuery<{ workspaceId: string; installs: AppInstallRecord[]; currentSelections: string[] }>(
    ["app-installs", workspaceId],
    workspaceId === null ? null : `/api/workspaces/${workspaceId}/app-installs`,
  );
  return { ...query, data: query.data, installs: query.data?.installs };
}

export function useMarketplace(agencyId: string | null, filters?: { search?: string }) {
  const search = filters?.search?.trim();
  const path =
    agencyId === null
      ? null
      : `/api/app-marketplace/${agencyId}/apps${search ? `?search=${encodeURIComponent(search)}` : ""}`;
  const query = useMosQuery<{ apps: MarketplaceAppEntry[] }>(["marketplace", agencyId, search ?? ""], path);
  return { ...query, data: query.data?.apps };
}

export function useMarketplaceDetail(agencyId: string | null, appKey: string | null) {
  return useMosQuery<MarketplaceAppDetail>(
    ["marketplace-detail", agencyId, appKey],
    agencyId === null || appKey === null ? null : `/api/app-marketplace/${agencyId}/apps/${appKey}`,
  );
}

export function useInstallApp(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { appKey: string; version: string }) =>
      mosPost<{ install: AppInstallRecord }>(`/api/workspaces/${workspaceId}/app-installs`, {
        appKey: input.appKey,
        version: input.version,
        idempotencyKey: `spa-install:${workspaceId}:${input.appKey}:${input.version}:${Date.now()}`,
      }),
    onSuccess: (result) => {
      toast.success(`Installed ${result.install.appKey} @ ${result.install.version}`);
      client.invalidateQueries({ queryKey: ["app-installs", workspaceId] });
      client.invalidateQueries({ queryKey: ["first-party-packs", workspaceId] });
    },
    onError: (error) => toast.error(String(error instanceof Error ? error.message : error)),
  });
}

export function useUpgradeApp(workspaceId: string, installId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (version: string) =>
      mosPost<{ install: AppInstallRecord }>(
        `/api/workspaces/${workspaceId}/app-installs/${installId}/upgrade`,
        { version, idempotencyKey: `spa-upgrade:${installId}:${version}:${Date.now()}` },
      ),
    onSuccess: (result) => {
      toast.success(`Upgraded to ${result.install.appKey} @ ${result.install.version}`);
      client.invalidateQueries({ queryKey: ["app-installs", workspaceId] });
      client.invalidateQueries({ queryKey: ["first-party-packs", workspaceId] });
    },
    onError: (error) => toast.error(String(error instanceof Error ? error.message : error)),
  });
}

export function useRollbackApp(workspaceId: string, installId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (targetInstallId: string) =>
      mosPost<{ install: AppInstallRecord }>(
        `/api/workspaces/${workspaceId}/app-installs/${installId}/rollback`,
        { targetInstallId, idempotencyKey: `spa-rollback:${installId}:${targetInstallId}:${Date.now()}` },
      ),
    onSuccess: (result) => {
      toast.success(`Rolled back to ${result.install.appKey} @ ${result.install.version}`);
      client.invalidateQueries({ queryKey: ["app-installs", workspaceId] });
      client.invalidateQueries({ queryKey: ["first-party-packs", workspaceId] });
    },
    onError: (error) => toast.error(String(error instanceof Error ? error.message : error)),
  });
}

export function useFirstPartyPacks(workspaceId: string | null) {
  const query = useMosQuery<{ packs: FirstPartyPack[] }>(
    ["first-party-packs", workspaceId],
    workspaceId === null ? null : `/api/first-party-apps/workspaces/${workspaceId}/packs`,
  );
  return { ...query, data: query.data?.packs };
}

export function useComposeSurface(workspaceId: string) {
  return useMutation({
    mutationFn: (input: { appKey: string; surface: string; documentKey?: string }) =>
      mosPost<PackSurfaceComposition>(
        `/api/first-party-apps/workspaces/${workspaceId}/packs/${input.appKey}/surfaces`,
        {
          surface: input.surface,
          ...(input.documentKey === undefined || input.documentKey === ""
            ? {}
            : { documentKey: input.documentKey }),
        },
      ),
    onSuccess: (result) => {
      const surfaceKind =
        typeof result.surface?.["kind"] === "string" ? result.surface["kind"] : "surface";
      toast.success(`Surface composed: ${surfaceKind}`);
    },
    onError: (error) => toast.error(String(error instanceof Error ? error.message : error)),
  });
}

export function useDevCatalog() {
  const query = useMosQuery<{ apps: DeveloperCatalogApp[] }>(["dev-catalog"], "/api/developer-portal/catalog");
  return { ...query, data: query.data?.apps };
}

export function useDevDocs() {
  return useMosQuery<DevPortalDocs>(["dev-docs"], "/api/developer-portal/docs");
}

export function useDevAppVersions(appKey: string | null) {
  const query = useMosQuery<{
    versions: Array<{
      appVersionId: string;
      appKey: string;
      manifest: { version: string; description?: string };
      publisher: string;
      certificationState: string;
      publishedAt: string;
    }>;
  }>(["dev-versions", appKey], appKey === null ? null : `/api/developer-portal/apps/${appKey}/versions`);
  return { ...query, data: query.data?.versions };
}

export function useTrustTransition(appKey: string, agencyId: string | null) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { transition: "verify" | "certify" | "decertify" | "revoke"; reason: string }) =>
      mosPost<unknown>(`/api/app-marketplace/apps/${appKey}/trust`, {
        transition: input.transition,
        reason: input.reason,
        idempotencyKey: `spa-trust:${appKey}:${input.transition}:${Date.now()}`,
      }),
    onSuccess: () => {
      toast.success(`Trust transition recorded: ${appKey}`);
      client.invalidateQueries({ queryKey: ["marketplace", agencyId] });
      client.invalidateQueries({ queryKey: ["marketplace-detail", agencyId, appKey] });
    },
    onError: (error) => toast.error(String(error instanceof Error ? error.message : error)),
  });
}

// --- Administration ---------------------------------------------------------------------

export function usePlatformPolicies() {
  const query = useMosQuery<{ policies: PolicyVersionRecord[] }>(["platform-policies"], "/api/policies");
  return { ...query, data: query.data?.policies };
}

export function useUser(userId: string | null) {
  return useMosQuery<UserRecord>(["user", userId], userId === null || userId === "" ? null : `/api/users/${userId}`);
}

export function useCreateUser() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; displayName: string; password: string }) =>
      mosPost<UserRecord>("/api/users", {
        email: input.email,
        displayName: input.displayName,
      }).then((user) =>
      // MOS's strict body validation accepts EXACTLY {password} on the
      // credential route (unknown fields 422 — verified against staging).
      mosPost<{ userId: string }>(`/api/users/${user.userId}/credential`, {
        password: input.password,
      }).then(() => user),
    ),
    onSuccess: (user) => {
      toast.success(`User created: ${user.email}`);
      client.invalidateQueries({ queryKey: ["user", user.userId] });
    },
    onError: (error) => toast.error(String(error instanceof Error ? error.message : error)),
  });
}
