/**
 * MOS API client — the ONLY module in the presentation app that talks to
 * the MOS backend (DEP-002 staging runtime on :3010).
 *
 * Governing rule: the SPA holds ZERO authority state. Every datum rendered
 * comes from a MOS API response; every mutation goes through an EXISTING
 * MOS POST route; 401 clears the session; 403/404 errors are surfaced
 * verbatim (the server's own words, never fabricated data).
 *
 * Transport contract: every request stays SAME-ORIGIN and relative — it goes
 * to the Next.js bridge at /api/mos/<subpath> (src/app/api/mos/[...path]/
 * route.ts), which forwards it server-side to the MOS API. NO XTransformPort
 * query parameter, NO absolute URLs — this is the exact shape the production
 * Vercel deployment will use, and it keeps unknown-query-param 422s (the
 * MOS API's strict query validation) structurally impossible.
 */

/** Base path of the same-origin Next.js bridge in front of the MOS API. */
export const MOS_BRIDGE_BASE = "/api/mos";

/**
 * The port the live MOS staging API listens on (DEP-002 runtime).
 * INFORMATIONAL ONLY — fetches never address it directly; the bridge does.
 */
export const MOS_API_PORT = 3010;

/** Normalized MOS API error (the platform's §23 error envelope). */
export class MosApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: readonly string[];

  constructor(status: number, code: string, message: string, details: readonly string[] = []) {
    super(message);
    this.name = "MosApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type ErrorEnvelope = {
  error?: {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
};

/** Session token holder (the MOS Bearer session — presentation-held). */
let sessionToken: string | null = null;

export function setMosToken(token: string | null): void {
  sessionToken = token;
}

export function getMosToken(): string | null {
  return sessionToken;
}

/** Rewrite a MOS API path onto the same-origin bridge ("/api/x" → "/api/mos/x"). */
function bridgePath(path: string): string {
  return `${MOS_BRIDGE_BASE}/${path.replace(/^\/+api\//, "")}`;
}

/**
 * The single typed fetch wrapper: relative same-origin bridge path, Bearer
 * header when a session token exists, JSON envelope parsing and the
 * platform error normalization (INVALID_REQUEST details included).
 */
export async function mosFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (init?.body !== undefined && init.body !== null) {
    headers["content-type"] = "application/json";
  }
  if (sessionToken !== null) {
    headers.authorization = `Bearer ${sessionToken}`;
  }

  let response: Response;
  try {
    response = await fetch(bridgePath(path), {
      ...init,
      headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
      cache: "no-store",
    });
  } catch (cause) {
    throw new MosApiError(
      0,
      "NETWORK_ERROR",
      `Cannot reach the MOS API bridge (${MOS_BRIDGE_BASE}): ${String(cause)}`,
    );
  }

  let payload: unknown = null;
  const text = await response.text();
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const envelope = (payload ?? {}) as ErrorEnvelope;
    const error = envelope.error ?? {};
    const code = typeof error.code === "string" ? error.code : `HTTP_${response.status}`;
    const message =
      typeof error.message === "string" ? error.message : `MOS API error (HTTP ${response.status})`;
    const details = Array.isArray(error.details)
      ? error.details.filter((entry): entry is string => typeof entry === "string")
      : [];
    throw new MosApiError(response.status, code, message, details);
  }

  return payload as T;
}

export const mosGet = <T>(path: string): Promise<T> => mosFetch<T>(path, { method: "GET" });

export const mosPost = <T>(path: string, body?: unknown): Promise<T> =>
  mosFetch<T>(path, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** A fresh client-side idempotency key (API-required correlation input). */
export function newIdempotencyKey(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `${prefix}:${random}`;
}

// ---------------------------------------------------------------------------
// Typed response excerpts (the exact serialization vocabulary the MOS API
// route files emit — see the repository backend src/api/*-routes.ts).
// ---------------------------------------------------------------------------

export type SourceRef = { kind: string; id: string };

export type AuthContext = {
  principal: {
    kind: string;
    userId?: string;
    email?: string;
    displayName?: string;
    status: string;
  };
  platformRoles: string[];
  memberships: Array<{
    agencyId: string;
    role: string;
    membershipStatus: string;
    agencyName?: string;
  }>;
  resolvedAt: string;
};

export type LoginResponse = {
  token: string;
  tokenType: string;
  sessionId: string;
  userId: string;
  expiresAt: string;
};

export type ClientRecord = {
  clientId: string;
  agencyId: string;
  name: string;
  slug: string;
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceRecord = {
  workspaceId: string;
  clientId: string;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type AgencyRecord = {
  agencyId: string;
  name: string;
  slug: string;
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type MembershipRecord = {
  membershipId: string;
  agencyId: string;
  userId: string;
  role: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

// --- Reporting: Agency Command Center (MKT-029) -----------------------------

export type GoalTimeHorizon = { startsOn: string; endsOn: string };

export type CommandCenterGoal = {
  goalId: string;
  clientId: string;
  workspaceId?: string;
  objective: string;
  status: string;
  successCriteria: Array<{
    metric: string;
    comparator: string;
    targetValue: number;
    unit?: string;
    description?: string;
  }>;
  metrics: Array<{ name: string; unit?: string; description?: string }>;
  constraints: Array<{ kind: string; description: string }>;
  timeHorizon?: GoalTimeHorizon;
};

export type CommandCenterView = {
  scope: { kind: string; agencyId: string; clientCount: number };
  generatedAt: string;
  portfolioGoals: {
    goalStatusCounts: Record<string, number>;
    goals: CommandCenterGoal[];
    perClient: Array<{
      clientId: string;
      total: number;
      goalStatusCounts: Record<string, number>;
    }>;
  };
  workflowState: {
    instanceStatusCounts: Record<string, number>;
    workflows: Array<{
      workflowId: string;
      workspaceId: string;
      clientId: string;
      name: string;
      description: string;
      instanceCounts: Record<string, number>;
      instances: Array<{
        workflowInstanceId: string;
        workflowId: string;
        status: string;
        createdAt: string;
        updatedAt: string;
      }>;
    }>;
    perClient: Array<{
      clientId: string;
      total: number;
      instanceStatusCounts: Record<string, number>;
    }>;
  };
  evidenceQuality: {
    totalRecords: number;
    lowGradeRecords: number;
    window: string;
    byClass: Array<{
      class: string;
      total: number;
      gradeCounts: Record<string, number>;
    }>;
    perClient: Array<{ clientId: string; totalRecords: number; lowGradeRecords: number }>;
  };
  risks: {
    basis: string;
    summary: Record<string, number>;
    items: Array<Record<string, string>>;
  };
  pendingApprovals: {
    items: Array<Record<string, string>>;
  };
};

// --- Reporting: Client Decision Room (MKT-030) -------------------------------

export type DecisionRoomView = {
  scope: { kind: string; clientId: string; agencyId: string };
  generatedAt: string;
  whatHappened: {
    goalStatusCounts: Record<string, number>;
    instanceStatusCounts: Record<string, number>;
    goals: CommandCenterGoal[];
    workflows: CommandCenterView["workflowState"]["workflows"];
  };
  why: {
    learningStatusCounts: Record<string, number>;
    learnings: LearningRecord[];
  };
  evidenceQuality: {
    totalRecords: number;
    window: string;
    byClass: Array<{ class: string; total: number; gradeCounts: Record<string, number> }>;
  };
  experiments: {
    experimentStatusCounts: Record<string, number>;
    experiments: Array<{
      experimentId: string;
      workspaceId?: string;
      hypothesis: string;
      decisionTarget: string;
      status: string;
      designType: string;
      analysisMethod: string;
      analysisMethodVersion?: string;
      primaryMetricName: string;
      resultState: string;
      resultingDecision?: string;
      concludedAt?: string;
    }>;
  };
  recommendations: {
    basis: string;
    items: Array<Record<string, unknown>>;
  };
  approvals: { items: Array<Record<string, string>> };
};

// --- AI Operator: Attention Queue (MKT-045) ----------------------------------

export type AttentionItem = {
  itemId: string;
  category: string;
  scope: { agencyId: string; clientId: string | null; workspaceId: string | null };
  priorityScore: number;
  rank: number;
  sourceRefs: SourceRef[];
  rationale: {
    headline: string;
    factors: Array<{ key: string; value: string }>;
  };
  actionContract: {
    kind: string;
    surface: string;
    policyDimension: string;
    policyScopeKind: string;
    targetRef: SourceRef;
    note: string;
  };
  scoreAssumptionKeys: string[];
};

export type AttentionRanking = {
  rankVersion: string;
  categoryVocabularyVersion: string;
  assumptions: Record<string, unknown>;
  sortRule: string;
  basis: string;
  persistence: string;
  consumedProfitIntelligenceVersion: string | null;
};

export type AgencyAttentionView = {
  scope: { kind: string; agencyId: string; clientCount: number; humanAgentCount: number };
  items: AttentionItem[];
  counts: Record<string, number>;
  ranking: AttentionRanking;
  generatedAt: string;
};

// P0-SRC: this type was referenced by useAttentionItem (hooks.ts, added in
// DEP-006b) but never declared — the deployment workspace's repo-wide tsc
// include masked the missing export, which the console's scoped tsconfig
// exposes. Declared here from the real wire contract (the backend's
// serializeDetailView in src/api/ai-operator-routes.ts).
export type AttentionItemDetailView = {
  scope: { kind: string; agencyId: string };
  item: AttentionItem;
  totalItemCount: number;
  categoryCounts: Record<string, number>;
  ranking: AttentionRanking;
  generatedAt: string;
};

// --- Profit Intelligence (MKT-043) --------------------------------------------

export type ProfitFigure = {
  value: number;
  currency: string;
  provenance: string;
  calculationVersion: string;
  sourceRefs: SourceRef[];
  assumptionKeys: string[];
  notDerivableReason?: string;
};

export type ProfitCalculation = {
  calculationVersion: string;
  assumptions: Record<string, unknown>;
  basis: string;
  persistence: string;
};

export type ProfitRevenueRollup = {
  byCurrency: Array<{
    currency: string;
    total: ProfitFigure;
    identityCount: number;
    sourceRefs: SourceRef[];
  }>;
  observationCount: number;
  restatedIdentityCount: number;
  supersededObservationCount: number;
  qualityCounts: Record<string, number>;
  evidenceRefs: SourceRef[];
};

export type ProfitCosts = {
  humanDeliveryCost: ProfitFigure;
  deliveredJobCount: number;
  inFlightJobCount: number;
  automationDeliveryCost: ProfitFigure;
  totalDeliveryCost: ProfitFigure;
  executionCounts: Record<string, number>;
  executionStatusCounts: Record<string, number>;
  aiProvider: {
    telemetryCost: ProfitFigure;
    telemetryRowCount: number;
    adapterActivity: Array<{
      adapterKey: string;
      connectionCount: number;
      ingestedEventCount: number;
      connectionRefs: SourceRef[];
      eventRefs: SourceRef[];
    }>;
    adapterActivityNote: string;
  };
  humanExecutionCostAttribution: string;
};

export type ProfitMargin = {
  realizedRevenue: ProfitFigure;
  realizedDeliveryCost: ProfitFigure;
  realizedMargin: ProfitFigure;
  estimatedRevenue: ProfitFigure;
  estimatedDeliveryCost: ProfitFigure;
  estimatedMargin: ProfitFigure;
  currencyPolicyNote: string;
};

export type ProfitClientView = {
  scope: { kind: string; agencyId: string; clientId: string; workspaceCount: number };
  revenue: ProfitRevenueRollup;
  costs: ProfitCosts;
  capacity: {
    activeProfileCount: number;
    skippedProfileCount: number;
    weeklyCapacityMinutes: number;
    weeklyCapacityCost: ProfitFigure;
    profileRefs: SourceRef[];
  };
  utilization: {
    deliveredWorkMinutes: ProfitFigure;
    capacityMinutes: ProfitFigure;
    utilization: ProfitFigure;
    humanExecutionCount: number;
    numeratorNote: string;
  };
  scopeLeakage: {
    indicators: Array<{
      kind: string;
      rule: string;
      count: number;
      sourceRefs: SourceRef[];
    }>;
  };
  margin: ProfitMargin;
  serviceContributions: Array<{
    playbookId: string;
    deliveryCost: ProfitFigure;
    revenue: ProfitFigure;
    deliveredJobCount: number;
    executionCount: number;
  }>;
  unattributedServiceDeliveryCost: ProfitFigure;
  projectContributions: Array<{
    deploymentId: string;
    deploymentStatus: string;
    deliveryCost: ProfitFigure;
    revenue: ProfitFigure;
    deliveredJobCount: number;
    executionCount: number;
  }>;
  unattributedProjectDeliveryCost: ProfitFigure;
  calculation: ProfitCalculation;
  generatedAt: string;
};

export type ProfitAgencyView = ProfitClientView & {
  scope: { kind: string; agencyId: string; clientCount: number; humanAgentCount: number };
  perClient: Array<{
    clientId: string;
    revenue: ProfitFigure;
    deliveryCost: ProfitFigure;
    margin: ProfitFigure;
  }>;
};

// --- Client domain records ----------------------------------------------------

export type GoalRecord = CommandCenterGoal & {
  version: number;
  createdAt?: string;
  updatedAt?: string;
};

export type PlaybookRecord = {
  playbookId: string;
  agencyId: string;
  clientId?: string;
  goalId?: string;
  name: string;
  description?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type DeploymentRecord = {
  deploymentId: string;
  agencyId: string;
  clientId: string;
  workspaceId: string;
  playbookVersionId: string;
  workflowDefinitionIds: string[];
  requiredDomainPacks: string[];
  requiredCapabilities: string[];
  policyReferenceId: string | null;
  runtimeRequirements: Record<string, unknown>;
  triggerConfig: Record<string, unknown>;
  status: string;
  createdBy: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowRecord = {
  workflowId: string;
  workspaceId: string;
  clientId: string;
  agencyId: string;
  name: string;
  description?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type EvidenceRecord = {
  evidenceId: string;
  clientId: string;
  workspaceId?: string;
  class: string;
  source: { system: string; ref?: string };
  observedAt: string;
  content: Record<string, unknown>;
  contentRef?: string;
  quality: string;
  confidence?: number;
  supersedes?: string;
  supersededBy?: string;
  provenance: {
    actor: string;
    recordedVia: string;
    correlationId: string;
    causationId?: string;
    recordedAt?: string;
  };
};

export type DecisionRecord = {
  decisionId: string;
  clientId: string;
  agencyId: string;
  workspaceId?: string;
  objective: string;
  context?: string;
  hypothesisSummary: string;
  experimentRef?: string;
  evidenceRefs: string[];
  expectedImpact: { summary: string; direction?: string; magnitude?: string };
  uncertainty?: Record<string, unknown>;
  expectedCost?: string;
  alternatives: string[];
  predecessorDecisionId?: string;
  proposer: { actor: string; role: string };
  disposition: string;
  successorDecisionId?: string;
  dispositionAt?: string;
  observedOutcome?: {
    summary: string;
    asExpected?: boolean;
    notes?: string;
  };
  executionRef?: string;
  deploymentRef?: string;
  learningRef?: string;
  provenance: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
};

export type DecisionEventRecord = {
  eventId: string;
  decisionId: string;
  eventType: string;
  actor: string;
  reason?: string | null;
  recordedAt: string;
};

export type LearningRecord = {
  learningId: string;
  clientId: string;
  workspaceId?: string;
  statement: string;
  applicability: Record<string, unknown>;
  evidenceRefs: string[];
  experimentRefs: string[];
  confidence?: number;
  status: string;
  supersededBy?: string;
  provenance: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
};

export type ClientMemoryItem = {
  kind: string;
  id: string;
  summary: string;
  /** Contract: string | null (e.g. playbooks carry no lifecycle status). */
  status: string | null;
  workspaceId: string | null;
  recordedAt: string;
  links: SourceRef[];
};

export type ClientMemoryView = {
  scope: { kind: string; agencyId: string; clientId: string; workspaceCount: number };
  profile: {
    sourceRef: SourceRef;
    name: string;
    slug: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  };
  workspaces: Array<{ workspaceId: string; name: string; status: string }>;
  items: ClientMemoryItem[];
  perKind: Record<string, number>;
  supersededEvidenceCount: number;
  projection: {
    projectionVersion: string;
    recordKinds: string[];
    /** The wire format is the platform's selection-rules record (key → rule), NOT a flat string. */
    selectionRules: Record<string, string>;
    basis: string;
    persistence: string;
    retrievalTechnology: string;
  };
  generatedAt: string;
};

// --- Jobs / Human Work (MKT-026/031) ------------------------------------------

/**
 * A job's public DESCRIPTOR (the candidate/marketplace view — profile data
 * only, no Client data). Wire shape: serializeDescriptor in
 * the repository backend src/api/jobs-routes.ts (src/api/jobs-routes.ts).
 */
export type JobDescriptor = {
  jobId: string;
  title: string;
  description: string;
  eligibility: {
    specialization: string;
    requiredCapabilities: string[];
    territory?: { kind: string; value: string };
    /** Contract: 0 = Sunday … 6 = Saturday; minutes since midnight. */
    availability: { dayOfWeek: number; startMinute: number; endMinute: number };
  };
  status: string;
  createdAt: string;
};

/**
 * The FULL job record (serializeJob — visible to the commissioning side and
 * the accepted agent only; the queue's activeJobs carry this shape).
 */
export type JobRecord = JobDescriptor & {
  workflowInstanceId: string;
  nodeId: string;
  workspaceId: string;
  clientId: string;
  agencyId: string;
  accepted?: { agentId: string; userId: string; offerId: string; at: string };
  createdBy?: string;
  version: number;
  updatedAt: string;
};

/**
 * One open offer in the caller's work queue (serializeOfferForCandidate):
 * the job descriptor rides along when the job record is readable; otherwise
 * the server answers offer-id-only (jobId, no descriptor).
 */
export type QueueOffer = {
  offerId: string;
  job?: JobDescriptor | null;
  /** Present in the offer-id-only wire shape (job record not available). */
  jobId?: string;
  status?: string;
  expiresAt?: string;
  createdAt?: string;
};

/** The queue's compact visit summary (summarizeQueueVisit — obligations view). */
export type QueueVisitSummary = {
  visitId: string;
  visitSeq: number;
  targetIdentity: string;
  status: string;
  scheduledAt?: string;
  startedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  followUpOfVisitId?: string;
};

/** The response of POST /api/jobs/queue/offers/:offerId/accept|decline. */
export type OfferClaimResponse = {
  job: JobRecord;
  offer: {
    offerId: string;
    jobId: string;
    candidateAgentId: string;
    candidateUserId: string;
    status: string;
    terminalReason?: string;
    expiresAt: string;
    acceptedAt?: string;
    createdBy?: string;
    version: number;
    createdAt: string;
    updatedAt: string;
  };
  replayed: boolean;
};

export type QueueAgentProfile = {
  agentId: string;
  specializations: string[];
  capabilities: Array<{ skill: string; level?: string }>;
  availability: Array<{ dayOfWeek: number; startMinute: number; endMinute: number }>;
  location?: { kind: string; value: string };
  territories: Array<{ kind: string; value: string }>;
  authorizationState: string;
};

export type JobsQueueView = {
  agent: QueueAgentProfile;
  offers: QueueOffer[];
  activeJobs: Array<{
    job: JobRecord;
    visits: QueueVisitSummary[];
    obligations: {
      jobOutcomeDue: boolean;
      openVisitIds: string[];
      evidenceDueVisitIds: string[];
    };
  }>;
};

export type JobsDiscoveryView = {
  serviceArea: {
    location?: { kind: string; value: string };
    territories: Array<{ kind: string; value: string }>;
  };
  matched: number;
  jobs: JobDescriptor[];
};

// --- App ecosystem (MKT-047/049/050/051) --------------------------------------

export type AppInstallRecord = {
  installId: string;
  agencyId: string;
  clientId: string;
  workspaceId: string;
  appKey: string;
  appVersionId: string;
  version: string;
  operation: string;
  grantedDataScopes: string[];
  grantedMutationScopes: string[];
  policyDecisionId: string | null;
  selectionSeq: number;
  status: string;
  supersededAt: string | null;
  installedBy?: string;
  installedAt: string;
  idempotencyKey: string;
  createFingerprint: string;
};

export type MarketplaceAppEntry = {
  appKey: string;
  publisher: string;
  publisherKind: string;
  latestVersion: {
    appVersionId: string;
    version: string;
    publishedAt: string;
    capabilities: string[];
    runtimeClass: string;
  } | null;
  versions: Array<{
    appVersionId: string;
    version: string;
    publishedAt: string;
    capabilities: string[];
    runtimeClass: string;
  }>;
  trustState: {
    appKey: string;
    trustLevel: string;
    sinceEventId?: string;
    transitionCount: number;
  };
  reviewSummary: {
    reviewCount: number;
    averageRating?: number;
    verdictCounts: Record<string, number>;
    lastReviewAt?: string;
  };
};

export type MarketplaceAppDetail = {
  entry: MarketplaceAppEntry;
  trustEvents: Array<{
    eventId: string;
    appKey: string;
    transitionSeq: number;
    transition: string;
    fromState: string;
    toState: string;
    reason: string;
    recordedAt: string;
  }>;
  reviews: Array<{
    reviewId: string;
    appKey: string;
    appVersionId?: string;
    rating: number;
    verdict: string;
    body: string;
    recordedAt: string;
  }>;
};

export type FirstPartyPack = {
  appKey: string;
  family: string;
  description: string;
  versions: string[];
  surfaces: Array<{ kind: string; description?: string }>;
  stateNamespaces: string[];
  publishedVersions: Array<{
    appKey: string;
    version: string;
    appVersionId: string;
  }>;
  currentSelection: { installId: string; version: string } | null;
};

export type PackSurfaceComposition = {
  app: Record<string, unknown>;
  install: Record<string, unknown>;
  surface: Record<string, unknown>;
  composedFrom: SourceRef[];
  model: Record<string, unknown>;
  generatedAt: string;
};

export type DeveloperCatalogApp = {
  appKey: string;
  publisher: string;
  versionCount: number;
  newestVersion: string;
  certificationState: string;
};

export type DevPortalDocs = {
  title: string;
  generatedFrom: string;
  manifestFields: Array<{
    field: string;
    type: string;
    required: boolean;
    description: string;
  }>;
};

// --- Administration ------------------------------------------------------------

export type PolicyVersionRecord = {
  policyId: string;
  dimension: string;
  scopeKind: string;
  scopeAgencyId?: string | null;
  scopeClientId?: string | null;
  status: string;
  versionSeq: number;
  rules: Array<{
    effect: string;
    reason: string;
    resource?: string | null;
    operations: string[];
    attributes: Record<string, unknown>;
  }>;
  description?: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type UserRecord = {
  userId: string;
  email: string;
  displayName: string;
  status: string;
  platformRoles: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type PlatformHealth = {
  status: string;
  service: string;
  env: string;
  time: string;
};

// --- Growth missions (MKT-053 — UX-002 mission creation) ----------------------

/** One declared target metric (the frozen create/read vocabulary). */
export type GrowthMissionTargetMetricView = {
  metric: string;
  comparator: string;
  targetValue: number;
  unit?: string | null;
  description?: string | null;
  intermediate: boolean;
};

/** The agency-scoped mission record (serializeMission). */
export type GrowthMissionView = {
  missionId: string;
  agencyId: string;
  status: string;
  currentVersionSeq: number;
  version: number;
  createdActor: unknown;
  createdAt: string;
  updatedAt: string;
};

/** One append-only declared version (serializeVersion) — the objective is
 *  verbatim; corrections are NEW version records, never rewrites. */
export type GrowthMissionVersionView = {
  missionVersionId: string;
  missionId: string;
  versionSeq: number;
  objective: string;
  objectiveFamily: string;
  productContext?: {
    name?: string | null;
    url?: string | null;
    summary?: string | null;
  } | null;
  marketContext?: {
    audience?: string | null;
    geography?: string | null;
    summary?: string | null;
  } | null;
  targetMetrics: GrowthMissionTargetMetricView[];
  provenance: Record<string, unknown>;
};

/** One append-only lifecycle history event (serializeEvent). */
export type GrowthMissionEventView = {
  eventId: string;
  missionId: string;
  eventSeq: number;
  eventKind: string;
  fromStatus: string | null;
  toStatus: string | null;
  /** Cited on terminal transitions: the declared §3 objective family the
   *  terminal decision was evaluated against (the frozen basis). */
  terminalDecisionFamily?: string | null;
  reason: string | null;
  detail?: unknown;
  recordedAt?: string;
  provenance?: Record<string, unknown>;
};

/** One mission→goal mapping with the goal's LIVE status through the /goals
 *  public contract (serializeGoalMapping — the /goals authority remains the
 *  measurable anchor; the mapping view only CARRIES the live status). */
export type GrowthMissionGoalMappingView = {
  mappingId: string;
  missionId: string;
  goalId: string;
  goalStatus: string | null;
  goalClientId: string | null;
  addedAt: string;
  addedBy: string;
  removedAt: string | null;
  removedBy: string | null;
  removalReason: string | null;
};

/** The composed honest read-back (serializeDetail) — what POST create
 *  returns on 201 and GET /api/growth-missions/:missionId serves. */
export type GrowthMissionDetailView = {
  mission: GrowthMissionView;
  currentVersion: GrowthMissionVersionView;
  goalMappings: GrowthMissionGoalMappingView[];
  history: GrowthMissionEventView[];
  terminalDecisionBasis?: unknown;
  vocabularyVersion?: string;
};

/** The agency list response (GET /api/agencies/:agencyId/growth-missions). */
export type GrowthMissionsListResponse = {
  agencyId: string;
  missions: GrowthMissionView[];
};

// --- UX-003 Mission Workspace composition types ---------------------------------
//
// Contract MIRRORS ONLY (same discipline as every type above): each shape
// mirrors the named module's own serializer verbatim. The workspace renders
// these surfaces COMPOSED — it never recomputes, re-derives or caches any
// authority state.

/** A metric identity (name + dimensions) — never a provider metric id. */
export type MetricIdentityView = {
  name: string;
  dimensions: Record<string, string | number | boolean>;
};

/** One experiment (serializeExperiment — GET /api/clients/:clientId/experiments). */
export type ExperimentView = {
  experimentId: string;
  clientId: string;
  workspaceId?: string;
  hypothesis: string;
  decisionTarget: string;
  populationUnit: string;
  treatment: string;
  comparison: string;
  assignmentMethod: string;
  designType: string;
  primaryMetric: MetricIdentityView;
  guardrails: MetricIdentityView[];
  analysisMethod: string;
  analysisMethodVersion?: string;
  expectedDirection?: string;
  startCriteria?: Record<string, unknown>;
  stopCriteria: Record<string, unknown>;
  minimumEvidenceRequirement: Record<string, unknown>;
  uncertaintyRepresentation: string;
  status: string;
  resultState: string | null;
  resultingDecision?: string;
  concludedAt?: string;
  provenance: Record<string, unknown>;
};

/** One metric observation (serializeObservation — GET /api/clients/:clientId/metrics). */
export type MetricObservationView = {
  observationId: string;
  clientId: string;
  workspaceId?: string;
  metricName: string;
  dimensions: Record<string, string | number | boolean>;
  value: number;
  unit: string;
  source: { system: string; ref?: string };
  observedAt: string;
  retrievedAt: string;
  evidenceRef?: string;
  quality: string;
  aggregationMethod?: string;
  provenance: Record<string, unknown>;
};

/** One social account binding (serializeAccount — GET /api/clients/:clientId/social-accounts;
 *  the frozen 056 statuses: connected | disconnected | revoked). */
export type SocialAccountView = {
  socialAccountId: string;
  integrationConnectionId: string;
  agencyId: string;
  clientId: string;
  workspaceId?: string;
  platformId: string;
  externalAccountId: string;
  displayIdentity: string | null;
  verifiedAt?: string;
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

/** One social account event (serializeEvent — the observable-now surface
 *  behind GET /api/clients/:clientId/social-accounts/:accountId/events). */
export type SocialAccountEventView = {
  eventId: string;
  socialAccountId?: string;
  grantId?: string;
  eventType: string;
  initiatedBy: string;
  reason?: string;
  providerRevokeOutcome?: string;
  recordedActor: string;
  recordedVia: string;
  recordedAt: string;
};

/** One content asset version (serializeVersion — GET /api/clients/:clientId/content-assets;
 *  the 064 versioned-asset model). */
export type ContentAssetVersionView = {
  versionId: string;
  assetId: string;
  agencyId: string;
  clientId: string;
  workspaceId?: string;
  version: number;
  assetRef: string;
  mediaKind: string;
  displayName: string | null;
  contentType: string;
  lifecycleState: string;
  objectKey?: string;
  objectDigest?: string;
  objectSize?: number;
  sourceEvidenceRef: string | null;
  provenance: Record<string, unknown>;
  versionCas: number;
  createdAt: string;
  updatedAt: string;
};

/** One content transformation (serializeTransformation — GET
 *  /api/clients/:clientId/content-assets/transformations). */
export type ContentTransformationView = {
  transformationId: string;
  agencyId: string;
  clientId: string;
  workspaceId: string;
  transformationKind: string;
  engineId: string | null;
  status: string;
  executionRef: Record<string, unknown>;
  parameters: Record<string, unknown>;
  outputSpec: Record<string, unknown>;
  outputVersionId?: string;
  completedAt?: string;
  failureReason?: string;
  provenance: Record<string, unknown>;
  versionCas: number;
  createdAt: string;
  updatedAt: string;
};

/** One content rights record (serializeRecord — GET /api/clients/:clientId/content-rights). */
export type ContentRightsRecordView = {
  rightsRecordId: string;
  agencyId: string;
  clientId: string;
  workspaceId?: string;
  contentAssetRef: string;
  assetKind: string;
  state: string;
  sourceEvidenceRef: string | null;
  licenceLabel?: string;
  licenceEvidenceRef?: string;
  validUntil?: string;
  provenance: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
};

/** One experiment analysis (serializeAnalysis — MKT-067
 *  GET /api/clients/:clientId/experiment-analysis/analyses/by-experiment/:experimentId). */
export type ExperimentAnalysisView = {
  analysisId: string;
  clientId: string;
  workspaceId?: string;
  experimentId: string;
  analysisMethod: string;
  analysisMethodVersion: string;
  vocabularyVersion: string;
  observationWindowStart: string;
  observationWindowEnd: string;
  sampleSizes: Record<string, number>;
  treatmentMean?: number;
  comparisonMean?: number;
  effectEstimate?: number;
  standardError?: number;
  uncertainty: Record<string, unknown>;
  sequentialState: Record<string, unknown>;
  confounders: string[];
  limitations: string[];
  practicalThreshold?: { value: number; source: string; description?: string | null };
  /** The frozen outcome vocabulary: effect_positive | effect_negative |
   *  effect_negligible | inconclusive | insufficient_observations. */
  outcome: string;
  /** The frozen direction vocabulary (e.g. shift_to_treatment | hold_balanced). */
  recommendedNextAllocation: string | null;
  inputSnapshot: Record<string, unknown>;
  inputDigest: string;
  evidenceRefs: string[];
  metricObservationRefs: string[];
  learningRefs: string[];
  provenance: Record<string, unknown>;
};

/** One allocation recommendation (serializeRecommendation — MKT-067
 *  GET /api/clients/:clientId/experiment-analysis/allocations/by-experiment/:experimentId). */
export type AllocationRecommendationView = {
  recommendationId: string;
  clientId: string;
  workspaceId?: string;
  experimentId: string;
  analysisId?: string;
  vocabularyVersion: string;
  arms: Array<Record<string, unknown>>;
  allocation: {
    eligibleArms: string[];
    zeroCapacityArms: Array<{ armKey: string; kind: string; reason: string }>;
    shares: Record<string, number>;
    humanTreatmentConsideration: Record<string, unknown>;
    explorationShare: number;
  };
  explorationFloor: number;
  explorationFloorSource: string;
  inputSnapshot: Record<string, unknown>;
  inputDigest: string;
  rationale: string | null;
  provenance: Record<string, unknown>;
};

// --- UX-004 Scientific Trace composition types -----------------------------------
//
// Same discipline as every mirror above: each shape mirrors the named
// module's own serializer verbatim (src/api/cross-platform-distribution-routes.ts
// and src/api/learnings-routes.ts). The trace renders these records — it never
// re-derives, re-computes or re-interprets them.

/** The recorded provenance block of the MKT-065 distribution records
 *  (serializeProvenance — causationId/recordedAt omitted when absent). */
export type DistributionProvenanceView = {
  actor: string;
  recordedVia: string;
  correlationId: string;
  causationId?: string;
  recordedAt?: string;
};

/** One distribution plan (serializePlan — MKT-065
 *  GET /api/clients/:clientId/cross-platform-distribution/plans). */
export type DistributionPlanView = {
  planId: string;
  agencyId: string;
  clientId: string;
  workspaceId?: string;
  missionId?: string;
  sourceAssetRef: string;
  sourceVersionId: string;
  transformationPlan: {
    description: string;
    outputs: Array<{ assetRef: string; variantLabel: string }>;
  };
  planState: string;
  inputDigest: string;
  provenance: DistributionProvenanceView;
  version: number;
  createdAt: string;
  updatedAt: string;
};

/** One destination variant of a plan (serializeDestination — the fan-out row;
 *  destinationStatus is the frozen cpd-vocab-v1 outcome vocabulary). */
export type DistributionDestinationView = {
  destinationId: string;
  planId: string;
  clientId: string;
  position: number;
  socialAccountId: string;
  platformId: string;
  assetRef: string;
  assetVersionId: string;
  targetFormat: string;
  publishRequest: Record<string, unknown>;
  idempotencyKey: string;
  destinationStatus: string;
  provenance: DistributionProvenanceView;
  version: number;
  createdAt: string;
  updatedAt: string;
};

/** One publication link (serializePublication — the per-destination submit-time
 *  mirror of the 056 ledger row; publishState is the provider's own outcome). */
export type DistributionPublicationView = {
  publicationId: string;
  planId: string;
  destinationId: string;
  clientId: string;
  socialAccountId: string;
  publishAttemptId: string;
  idempotencyKey: string;
  publishState: string;
  failureCode?: string;
  providerPublishId?: string;
  providerContentId?: string;
  publishedAt?: string;
  duplicate: boolean;
  provenance: DistributionProvenanceView;
};

/** One immutable lineage event (serializeEvent — eventKind is the frozen
 *  cpd-vocab-v1 tail vocabulary incl. 'measurement_reference'). */
export type DistributionEventView = {
  eventId: string;
  planId: string;
  destinationId?: string;
  clientId: string;
  eventSeq: number;
  eventKind: string;
  payload: Record<string, unknown>;
  provenance: DistributionProvenanceView;
};

/** The composed plan read model (serializeDetail — GET
 *  /api/clients/:clientId/cross-platform-distribution/plans/:planId). */
export type DistributionPlanDetailView = {
  plan: DistributionPlanView;
  destinations: DistributionDestinationView[];
  publications: DistributionPublicationView[];
  events: DistributionEventView[];
  vocabularyVersion: string;
};

/** The plan-list response (GET …/cross-platform-distribution/plans). */
export type DistributionPlansListResponse = {
  clientId: string;
  plans: DistributionPlanView[];
  vocabularyVersion: string;
};

/** One learning relationship row (serializeRelationship — GET
 *  /api/learnings/:learningId/relationships; kind: contradicts | supersedes | retires). */
export type LearningRelationshipView = {
  relationshipId: string;
  fromLearningId: string;
  toLearningId?: string;
  kind: string;
  provenance: {
    actor: string;
    recordedVia: string;
    correlationId: string;
    causationId?: string;
    recordedAt: string;
  };
};


