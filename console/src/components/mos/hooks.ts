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
  type CredentialReferenceView,
  type DecisionEventRecord,
  type DecisionRecord,
  type DeploymentRecord,
  type DeveloperCatalogApp,
  type DevPortalDocs,
  type DistributionPlanDetailView,
  type DistributionPlansListResponse,
  type EvidenceRecord,
  type ExperimentAnalysisView,
  type ExperimentView,
  type FirstPartyPack,
  type GoalRecord,
  type GrowthMissionDetailView,
  type GrowthMissionsListResponse,
  type IntegrationConnectionView,
  type JobDescriptor,
  type JobsDiscoveryView,
  type JobsQueueView,
  type LearningRecord,
  type LearningRelationshipView,
  type MarketplaceAppDetail,
  type MarketplaceAppEntry,
  type MembershipRecord,
  type MetricObservationView,
  type NotificationDetailView,
  type NotificationInboxItemView,
  type OfferClaimResponse,
  type PackSurfaceComposition,
  type PlaybookRecord,
  type PolicyVersionRecord,
  type ProfitAgencyView,
  type ProfitClientView,
  type RegisteredAdapterView,
  type SocialAccountEventView,
  type SocialAccountView,
  type SocialAuthorizeStartResponse,
  type SocialAuthorizationCompletionResponse,
  type SocialGrantScopeFactsView,
  type SocialGrantView,
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

// --- UX-005 Connections Center composition hooks ----------------------------------
//
// The same COMPOSITION DISCIPLINE as UX-003/004: every hook is a THIN wrapper
// over ONE existing read or mutation surface of the three connection
// authorities (MKT-055 social accounts, MKT-023 integrations, MKT-068
// notification delivery). Zero new authorities, zero client-side derivation
// beyond presentation formatting — each card field names the route it composes.

/** One account's append-only grant history tail (the authorization health
 *  basis): GET /api/clients/:clientId/social-accounts/:accountId/grants —
 *  REFUSES 409 on a disconnected/revoked connection (the honest refusal is
 *  rendered by the card, never worked around). */
export function useSocialAccountGrants(clientId: string | null, accountId: string | null) {
  const query = useMosQuery<{ socialAccountId: string; grants: SocialGrantView[] }>(
    ["social-account-grants", clientId, accountId],
    clientId === null || accountId === null
      ? null
      : `/api/clients/${clientId}/social-accounts/${accountId}/grants`,
  );
  return { ...query, data: query.data?.grants };
}

/** One grant's VERBATIM scope facts (the provider's own answer — grantedScopes
 *  + capabilityTags): GET /api/clients/:clientId/social-accounts/:accountId/grants/:grantId. */
export function useSocialGrantScopeFacts(
  clientId: string | null,
  accountId: string | null,
  grantId: string | null,
) {
  const query = useMosQuery<SocialGrantScopeFactsView>(
    ["social-grant-scope-facts", clientId, accountId, grantId],
    clientId === null || accountId === null || grantId === null
      ? null
      : `/api/clients/${clientId}/social-accounts/${accountId}/grants/${grantId}`,
  );
  return query;
}

/** The adapter registry as data — the REAL capability descriptors (no tenant
 *  data): GET /api/integrations/adapters. Every card's capability section and
 *  the platform list compose THIS registry, so sibling adapters (TikTok etc.)
 *  appear naturally when they register. */
export function useAdapterRegistry() {
  const query = useMosQuery<{ adapters: RegisteredAdapterView[] }>(
    ["integrations-adapters"],
    "/api/integrations/adapters",
  );
  return { ...query, data: query.data?.adapters };
}

/** The client's integration connections (the product/source/store family):
 *  GET /api/clients/:clientId/connections. */
export function useIntegrationConnections(clientId: string | null) {
  const query = useMosQuery<{ clientId: string; connections: IntegrationConnectionView[] }>(
    ["integration-connections", clientId],
    clientId === null ? null : `/api/clients/${clientId}/connections`,
  );
  return { ...query, data: query.data?.connections };
}

/** The agency's live credential references (opaque, non-secret — the pick
 *  list for registering a new integration connection):
 *  GET /api/agencies/:agencyId/credentials. */
export function useAgencyCredentials(agencyId: string | null) {
  const query = useMosQuery<{ credentials: CredentialReferenceView[] }>(
    ["agency-credentials", agencyId],
    agencyId === null ? null : `/api/agencies/${agencyId}/credentials`,
  );
  return { ...query, data: query.data?.credentials };
}

/** The client's in-app notification inbox (the notification family's live
 *  basis): GET /api/clients/:clientId/notifications → { clientId, inbox, vocabularyVersion }. */
export function useClientNotifications(clientId: string | null) {
  const query = useMosQuery<{ clientId: string; inbox: NotificationInboxItemView[] }>(
    ["client-notifications", clientId],
    clientId === null ? null : `/api/clients/${clientId}/notifications`,
  );
  return { ...query, data: query.data?.inbox };
}

/** One notification with its full append-only receipt tail (the channel
 *  receipts — the notification-channel health basis, fetched on expand):
 *  GET /api/clients/:clientId/notifications/:notificationId. */
export function useNotificationDetail(clientId: string | null, notificationId: string | null) {
  const query = useMosQuery<NotificationDetailView>(
    ["notification-detail", clientId, notificationId],
    clientId === null || notificationId === null
      ? null
      : `/api/clients/${clientId}/notifications/${notificationId}`,
  );
  return query;
}

// --- UX-005 connection mutations (every one wired to the REAL route) ---------------

/** The connect action — the REAL authorize-start round:
 *  POST /api/clients/:clientId/social-accounts/authorize-start {connectionId}.
 *  201 = the round IS recorded (a PENDING grant) with the authorizeUrl; the
 *  complete step needs the provider's callback — NEVER a fake success. */
export function useSocialAuthorizeStart(clientId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { connectionId: string; requestedScopes?: string[] }) =>
      mosPost<SocialAuthorizeStartResponse>(
        `/api/clients/${clientId}/social-accounts/authorize-start`,
        {
          connectionId: input.connectionId,
          ...(input.requestedScopes === undefined ? {} : { requestedScopes: input.requestedScopes }),
        },
      ),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["social-accounts", clientId] });
      client.invalidateQueries({ queryKey: ["social-account-grants", clientId] });
    },
    onError: (error) => toast.error(String(error instanceof Error ? error.message : error)),
  });
}

/** The reconnect action — the REAL reauthorize round (a fresh PENDING grant
 *  pre-bound to the account; the recovery path of an expired/aging grant):
 *  POST /api/clients/:clientId/social-accounts/:accountId/reauthorize. */
export function useSocialReauthorize(clientId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { accountId: string }) =>
      mosPost<SocialAuthorizeStartResponse>(
        `/api/clients/${clientId}/social-accounts/${input.accountId}/reauthorize`,
        {},
      ),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["social-accounts", clientId] });
      client.invalidateQueries({ queryKey: ["social-account-grants", clientId] });
    },
    onError: (error) => toast.error(String(error instanceof Error ? error.message : error)),
  });
}

/** The refresh action — the REAL token-refresh round (appends the successor
 *  grant; the old grant becomes 'refreshed' with the successor link — the
 *  visibly-historical record): POST …/social-accounts/:accountId/refresh. */
export function useSocialRefresh(clientId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { accountId: string }) =>
      mosPost<SocialAuthorizationCompletionResponse>(
        `/api/clients/${clientId}/social-accounts/${input.accountId}/refresh`,
        {},
      ),
    onSuccess: (outcome) => {
      toast.success(`Authorization refreshed — grant ${outcome.grant.grantState}`);
      client.invalidateQueries({ queryKey: ["social-accounts", clientId] });
      client.invalidateQueries({ queryKey: ["social-account-grants", clientId] });
    },
    onError: (error) => toast.error(String(error instanceof Error ? error.message : error)),
  });
}

/** The disconnect action — the REAL terminal fail-closed death (confirm-gated
 *  in the UI; every authorization-bearing read refuses from here on):
 *  POST …/social-accounts/:accountId/disconnect {reason?, revokeAtProvider?}. */
export function useSocialDisconnect(clientId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { accountId: string; reason?: string; revokeAtProvider?: boolean }) =>
      mosPost<SocialAccountView>(
        `/api/clients/${clientId}/social-accounts/${input.accountId}/disconnect`,
        {
          ...(input.reason === undefined || input.reason === "" ? {} : { reason: input.reason }),
          revokeAtProvider: input.revokeAtProvider ?? false,
        },
      ),
    onSuccess: (account) => {
      toast.success(`Disconnected — ${account.displayIdentity ?? account.externalAccountId}`);
      client.invalidateQueries({ queryKey: ["social-accounts", clientId] });
      client.invalidateQueries({ queryKey: ["social-account-grants", clientId] });
      client.invalidateQueries({ queryKey: ["social-account-events", clientId] });
    },
    onError: (error) => toast.error(String(error instanceof Error ? error.message : error)),
  });
}

/** Register a product/source/store connection (the born state 'registered'):
 *  POST /api/clients/:clientId/connections {adapterKey, credentialReferenceId, providerConfig}. */
export function useRegisterIntegrationConnection(clientId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      adapterKey: string;
      credentialReferenceId: string;
      providerConfig: Record<string, unknown>;
    }) =>
      mosPost<IntegrationConnectionView>(`/api/clients/${clientId}/connections`, {
        adapterKey: input.adapterKey,
        credentialReferenceId: input.credentialReferenceId,
        providerConfig: input.providerConfig,
      }),
    onSuccess: (connection) => {
      toast.success(`Connection registered — ${connection.providerLabel}`);
      client.invalidateQueries({ queryKey: ["integration-connections", clientId] });
    },
    onError: (error) => toast.error(String(error instanceof Error ? error.message : error)),
  });
}

/** The connect probe — the REAL policy-gated CAS transition (a healthy probe
 *  transitions to connected/healthy; an unreachable one to error/unreachable —
 *  the outcome is server-computed, never supplied):
 *  POST /api/clients/:clientId/connections/:connectionId/connect {expectedVersion}. */
export function useConnectIntegrationConnection(clientId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { connectionId: string; expectedVersion: number }) =>
      mosPost<IntegrationConnectionView>(
        `/api/clients/${clientId}/connections/${input.connectionId}/connect`,
        { expectedVersion: input.expectedVersion },
      ),
    onSuccess: (connection) => {
      toast.success(`${connection.providerLabel}: ${connection.status} / ${connection.health}`);
      client.invalidateQueries({ queryKey: ["integration-connections", clientId] });
    },
    onError: (error) => toast.error(String(error instanceof Error ? error.message : error)),
  });
}

/** The administrative pause — the REAL CAS transition (pure bookkeeping, no
 *  provider call; confirm-gated in the UI):
 *  POST /api/clients/:clientId/connections/:connectionId/suspend {expectedVersion, reason?}. */
export function useSuspendIntegrationConnection(clientId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { connectionId: string; expectedVersion: number; reason?: string }) =>
      mosPost<IntegrationConnectionView>(
        `/api/clients/${clientId}/connections/${input.connectionId}/suspend`,
        {
          expectedVersion: input.expectedVersion,
          ...(input.reason === undefined || input.reason === "" ? {} : { reason: input.reason }),
        },
      ),
    onSuccess: (connection) => {
      toast.success(`${connection.providerLabel} suspended`);
      client.invalidateQueries({ queryKey: ["integration-connections", clientId] });
    },
    onError: (error) => toast.error(String(error instanceof Error ? error.message : error)),
  });
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

// --- UX-004 Scientific Trace composition hooks -------------------------------------
//
// Same COMPOSITION DISCIPLINE as the UX-003 hooks above: THIN useMosQuery
// wrappers over existing read surfaces only. The trace composes authorities;
// it never becomes one.

/** The agency's growth missions, ALL lifecycle states (the mission list the
 *  trace's Question link composes — the closest live "question" surface while
 *  the research module MKT-062 is in flight):
 *  GET /api/agencies/:agencyId/growth-missions. */
export function useAgencyGrowthMissions(agencyId: string | null) {
  const query = useMosQuery<GrowthMissionsListResponse>(
    ["growth-missions", agencyId],
    agencyId === null ? null : `/api/agencies/${agencyId}/growth-missions`,
  );
  return { ...query, data: query.data?.missions };
}

/** The client's cross-platform distribution plans (MKT-065 — the Publication
 *  link authority): GET /api/clients/:clientId/cross-platform-distribution/plans. */
export function useDistributionPlans(clientId: string | null) {
  const query = useMosQuery<DistributionPlansListResponse>(
    ["distribution-plans", clientId],
    clientId === null
      ? null
      : `/api/clients/${clientId}/cross-platform-distribution/plans`,
  );
  return { ...query, data: query.data?.plans };
}

/** One distribution plan's composed read-back — destinations, publications and
 *  the full append-only lineage incl. the §5 measurement references (MKT-065).
 *  Mounted per-expanded-plan (the expand→fetch house pattern — never a bulk
 *  prefetch; React Query shares the cache with every other mount):
 *  GET /api/clients/:clientId/cross-platform-distribution/plans/:planId. */
export function useDistributionPlanDetail(clientId: string | null, planId: string | null) {
  return useMosQuery<DistributionPlanDetailView>(
    ["distribution-plan-detail", clientId, planId],
    clientId === null || planId === null
      ? null
      : `/api/clients/${clientId}/cross-platform-distribution/plans/${planId}`,
  );
}

/** One learning's append-only relationship chain — the contradictions,
 *  supersessions and retirements recorded around it (the Learning link's
 *  relatives): GET /api/learnings/:learningId/relationships. */
export function useLearningRelationships(learningId: string | null) {
  const query = useMosQuery<{ learningId: string; relationships: LearningRelationshipView[] }>(
    ["learning-relationships", learningId],
    learningId === null ? null : `/api/learnings/${learningId}/relationships`,
  );
  return { ...query, data: query.data?.relationships };
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
