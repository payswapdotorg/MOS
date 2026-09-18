"use client";

/**
 * Human Work — the caller's OWN work queue (open offers with REAL
 * Accept/Decline through the queue claim contracts, accepted jobs with
 * derived obligations), territory discovery and the eligibility-gated job
 * marketplace. Requires an identity with a Human Agent profile — a 403 is
 * rendered honestly (the server's own words).
 *
 * DEP-006b: every job/offer renders as a FORMATTED card (title, description,
 * status chips, eligibility in human terms) — never a raw JSON dump — and
 * each open offer carries working Accept/Decline buttons wired to
 * POST /api/jobs/queue/offers/:offerId/accept|decline. Every field of the
 * wire contract stays visible; missing fields render honest fallbacks.
 */

import { Check, ClipboardList, Loader2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { JobDescriptor, JobsQueueView, QueueOffer, QueueVisitSummary } from "@/lib/mos-api";
import { useJobsDiscovery, useJobsMarketplace, useJobsQueue, useQueueOfferMutation } from "./hooks";
import {
  EmptyState,
  LoadingSkeleton,
  MosErrorView,
  ScrollList,
  StatusBadge,
  formatWhen,
  shortId,
} from "./shared";

// ---------------------------------------------------------------------------
// Human-term formatting (presentation only — no datum transformed)
// ---------------------------------------------------------------------------

/** The platform contract: 0 = Sunday … 6 = Saturday (field-agents public.ts). */
const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** Minutes since midnight → "09:00" / "17:30". */
function minutesToClock(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** An availability window in human terms: "Tuesday 09:00–17:00". */
function formatAvailabilityWindow(window: {
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
}): string {
  const day = WEEKDAY_NAMES[window.dayOfWeek] ?? `day ${window.dayOfWeek}`;
  return `${day} ${minutesToClock(window.startMinute)}–${minutesToClock(window.endMinute)}`;
}

/** A territory as "city · accra" (honest "—" when the job carries none). */
function formatTerritory(territory: { kind: string; value: string } | undefined): string {
  if (territory === undefined) return "— (no territory constraint)";
  return `${territory.kind} · ${territory.value}`;
}

// ---------------------------------------------------------------------------
// Formatted job rendering (every descriptor field visible)
// ---------------------------------------------------------------------------

/** The eligibility block: specialization, capabilities, territory, window. */
function JobEligibilityBlock({ eligibility }: { eligibility: JobDescriptor["eligibility"] }) {
  const capabilities = eligibility.requiredCapabilities;
  return (
    <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
      <div>
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Specialization
        </p>
        <p className="font-mono text-xs">{eligibility.specialization}</p>
      </div>
      <div>
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Required capabilities
        </p>
        {capabilities.length === 0 ? (
          <p className="text-xs text-muted-foreground">none</p>
        ) : (
          <span className="inline-flex flex-wrap gap-1">
            {capabilities.map((skill) => (
              <Badge key={skill} variant="outline" className="font-mono text-[10px]">
                {skill}
              </Badge>
            ))}
          </span>
        )}
      </div>
      <div>
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Territory
        </p>
        <p className="font-mono text-xs">{formatTerritory(eligibility.territory)}</p>
      </div>
      <div>
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Availability window
        </p>
        <p className="font-mono text-xs">{formatAvailabilityWindow(eligibility.availability)}</p>
      </div>
    </div>
  );
}

/**
 * The body every job card shares: description + eligibility + creation time.
 * Honest fallbacks for every field — never a placeholder that looks like data.
 */
function JobDescriptorBody({ job }: { job: JobDescriptor }) {
  return (
    <div className="space-y-2">
      <p className="text-sm leading-relaxed">
        {job.description === "" ? (
          <span className="italic text-muted-foreground">No description provided.</span>
        ) : (
          job.description
        )}
      </p>
      <JobEligibilityBlock eligibility={job.eligibility} />
      <p className="font-mono text-[10px] text-muted-foreground">
        job {shortId(job.jobId)} · created {formatWhen(job.createdAt)}
      </p>
    </div>
  );
}

/** A job descriptor card (Discovery + Marketplace tabs). */
function JobDescriptorCard({ job }: { job: JobDescriptor }) {
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 text-sm font-medium leading-snug">{job.title}</p>
        <StatusBadge status={job.status} />
      </div>
      <JobDescriptorBody job={job} />
    </div>
  );
}

/**
 * One OPEN offer, formatted (DEP-006b): job title as the heading, offer +
 * job status chips, full descriptor body, and the REAL claim affordances.
 */
function OfferCard({
  offer,
  pendingAction,
  onAccept,
  onDecline,
}: {
  offer: QueueOffer;
  /** The action currently in flight for THIS offer (null = none). */
  pendingAction: "accept" | "decline" | null;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const job = offer.job ?? null;
  const claimPending = pendingAction !== null;
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium leading-snug">
            {job !== null ? job.title : "Job descriptor not available"}
          </p>
          <p className="font-mono text-[10px] text-muted-foreground">
            offer {shortId(offer.offerId)}
            {job !== null ? ` · job ${shortId(job.jobId)}` : offer.jobId !== undefined ? ` · job ${shortId(offer.jobId)}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {offer.status !== undefined ? (
            <Badge variant="secondary" className="font-mono text-[10px]">
              offer {offer.status}
            </Badge>
          ) : null}
          {job !== null ? <StatusBadge status={job.status} /> : null}
        </div>
      </div>

      {job !== null ? (
        <JobDescriptorBody job={job} />
      ) : (
        <p className="text-xs text-muted-foreground">
          The job descriptor is not available for this offer — the queue surfaces it by offer id
          alone. You can still accept or decline it below.
        </p>
      )}

      <p className="font-mono text-[10px] text-muted-foreground">
        offered to you {formatWhen(offer.createdAt)}
        {offer.expiresAt !== undefined ? ` · expires ${formatWhen(offer.expiresAt)}` : ""}
      </p>

      <div className="flex gap-2 pt-1">
        <Button size="sm" disabled={claimPending} onClick={onAccept}>
          {pendingAction === "accept" ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Check className="size-3.5" aria-hidden="true" />
          )}
          Accept
        </Button>
        <Button size="sm" variant="outline" disabled={claimPending} onClick={onDecline}>
          {pendingAction === "decline" ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <X className="size-3.5" aria-hidden="true" />
          )}
          Decline
        </Button>
      </div>
    </div>
  );
}

/** One visit of an accepted job (the obligations-oriented summary view). */
function VisitRow({ visit }: { visit: QueueVisitSummary }) {
  return (
    <div className="rounded border p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="font-mono text-[10px]">
          visit {visit.visitSeq}
        </Badge>
        <StatusBadge status={visit.status} />
        <span className="font-mono text-muted-foreground">{visit.targetIdentity}</span>
      </div>
      <p className="mt-1 font-mono text-[10px] text-muted-foreground">
        {visit.scheduledAt !== undefined ? `scheduled ${formatWhen(visit.scheduledAt)}` : "not scheduled"}
        {visit.startedAt !== undefined ? ` · started ${formatWhen(visit.startedAt)}` : ""}
        {visit.completedAt !== undefined ? ` · completed ${formatWhen(visit.completedAt)}` : ""}
        {visit.cancelledAt !== undefined ? ` · cancelled ${formatWhen(visit.cancelledAt)}` : ""}
        {visit.followUpOfVisitId !== undefined ? ` · follow-up of ${shortId(visit.followUpOfVisitId)}` : ""}
        {" · visit " + shortId(visit.visitId)}
      </p>
    </div>
  );
}

/** One ACCEPTED job with live status, links and derived obligations. */
function ActiveJobCard({
  entry,
}: {
  entry: JobsQueueViewEntry;
}) {
  const { job, visits, obligations } = entry;
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium leading-snug">{job.title}</p>
          <p className="font-mono text-[10px] text-muted-foreground">
            job {shortId(job.jobId)} · node{" "}
            <span className="font-mono">{job.nodeId}</span> of instance {shortId(job.workflowInstanceId)}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <StatusBadge status={job.status} />
          {obligations.jobOutcomeDue ? <Badge variant="destructive">outcome due</Badge> : null}
          {obligations.evidenceDueVisitIds.length > 0 ? (
            <Badge variant="destructive">
              evidence due on {obligations.evidenceDueVisitIds.length} visit
              {obligations.evidenceDueVisitIds.length === 1 ? "" : "s"}
            </Badge>
          ) : null}
        </div>
      </div>

      <JobDescriptorBody job={job} />

      <div className="grid gap-x-6 gap-y-1 font-mono text-[10px] text-muted-foreground sm:grid-cols-2">
        <p>workspace {shortId(job.workspaceId)}</p>
        <p>client {shortId(job.clientId)}</p>
        <p>agency {shortId(job.agencyId)}</p>
        <p>
          v{job.version} · updated {formatWhen(job.updatedAt)}
        </p>
      </div>

      {job.accepted !== undefined ? (
        <p className="font-mono text-[10px] text-muted-foreground">
          accepted by agent {shortId(job.accepted.agentId)} (user {shortId(job.accepted.userId)}) at{" "}
          {formatWhen(job.accepted.at)} via offer {shortId(job.accepted.offerId)}
        </p>
      ) : null}
      {job.createdBy !== undefined ? (
        <p className="font-mono text-[10px] text-muted-foreground">
          projected by {shortId(job.createdBy)}
        </p>
      ) : null}

      <div className="space-y-1.5 pt-1">
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Visits ({visits.length} · {obligations.openVisitIds.length} open)
        </p>
        {visits.length === 0 ? (
          <p className="text-xs text-muted-foreground">No visits recorded.</p>
        ) : (
          <div className="space-y-1.5">
            {visits.map((visit) => (
              <VisitRow key={visit.visitId} visit={visit} />
            ))}
          </div>
        )}
        <p className="text-[10px] text-muted-foreground">
          Visit execution (start/complete/evidence) flows through the MOS{" "}
          <span className="font-mono">/api/jobs/:jobId/visits</span> surface — no SPA shortcut
          exists by design.
        </p>
      </div>
    </div>
  );
}

type JobsQueueViewEntry = JobsQueueView["activeJobs"][number];

// (declared here so ActiveJobCard above can reference it — types are hoisted)

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export function HumanWorkScreen() {
  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <ClipboardList className="size-5" aria-hidden="true" /> Human Work
        </h1>
        <p className="text-sm text-muted-foreground">
          Your own queue and the eligibility-gated job marketplace — all data from the MOS /jobs
          contracts. Identities without a Human Agent profile are denied by the server.
        </p>
      </header>

      <Tabs defaultValue="queue">
        <TabsList>
          <TabsTrigger value="queue">My queue</TabsTrigger>
          <TabsTrigger value="discovery">Discovery</TabsTrigger>
          <TabsTrigger value="marketplace">Marketplace</TabsTrigger>
        </TabsList>

        <TabsContent value="queue" className="mt-4">
          <MyQueueTab />
        </TabsContent>
        <TabsContent value="discovery" className="mt-4">
          <DiscoveryTab />
        </TabsContent>
        <TabsContent value="marketplace" className="mt-4">
          <MarketplaceTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function MyQueueTab() {
  const queue = useJobsQueue();
  const offerMutation = useQueueOfferMutation();
  // The claim currently in flight (offer id + action) — drives the loading
  // state on the CLICKED button; other offers stay actionable.
  const pendingClaim = offerMutation.isPending ? (offerMutation.variables ?? null) : null;

  if (queue.isPending) return <LoadingSkeleton rows={4} />;
  if (queue.isError) {
    return <MosErrorView error={queue.error} what="the work queue" onRetry={() => void queue.refetch()} />;
  }
  const view = queue.data;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Your agent profile</CardTitle>
          <CardDescription className="font-mono text-xs">
            source: GET /api/jobs/queue · agent {shortId(view.agent.agentId)}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Specializations</p>
            <p className="font-mono text-xs">{view.agent.specializations.join(", ") || "—"}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Authorization</p>
            <p className="font-mono text-xs">{view.agent.authorizationState}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Capabilities</p>
            <p className="font-mono text-xs">
              {view.agent.capabilities
                .map((capability) =>
                  capability.level === undefined ? capability.skill : `${capability.skill} (${capability.level})`,
                )
                .join(", ") || "—"}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Availability</p>
            <p className="font-mono text-xs">
              {view.agent.availability.map(formatAvailabilityWindow).join(", ") || "—"}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Location</p>
            <p className="font-mono text-xs">
              {view.agent.location !== undefined
                ? `${view.agent.location.kind}:${view.agent.location.value}`
                : "—"}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Territories</p>
            <p className="font-mono text-xs">
              {view.agent.territories.map((territory) => `${territory.kind}:${territory.value}`).join(", ") || "—"}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Open offers ({view.offers.length})</CardTitle>
          <CardDescription>
            Accept/decline through{" "}
            <span className="font-mono text-xs">POST /api/jobs/queue/offers/:offerId/accept|decline</span>{" "}
            — the buttons below perform the real claim.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {view.offers.length === 0 ? (
            <EmptyState title="No open offers" hint="Offers appear when the commissioning flow addresses your agent profile." />
          ) : (
            <ScrollList label="Open offers" className="space-y-2">
              {view.offers.map((offer) => (
                <OfferCard
                  key={offer.offerId}
                  offer={offer}
                  pendingAction={
                    pendingClaim !== null && pendingClaim.offerId === offer.offerId
                      ? pendingClaim.action
                      : null
                  }
                  onAccept={() => offerMutation.mutate({ offerId: offer.offerId, action: "accept" })}
                  onDecline={() => offerMutation.mutate({ offerId: offer.offerId, action: "decline" })}
                />
              ))}
            </ScrollList>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Accepted jobs ({view.activeJobs.length})</CardTitle>
          <CardDescription>Live status and the derived pending obligations (outcome / evidence due).</CardDescription>
        </CardHeader>
        <CardContent>
          {view.activeJobs.length === 0 ? (
            <EmptyState title="No accepted jobs in flight" hint="Jobs you won appear here with their obligations." />
          ) : (
            <ScrollList label="Active jobs" className="space-y-2">
              {view.activeJobs.map((entry) => (
                <ActiveJobCard key={entry.job.jobId} entry={entry} />
              ))}
            </ScrollList>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function DiscoveryTab() {
  const discovery = useJobsDiscovery();
  if (discovery.isPending) return <LoadingSkeleton rows={3} />;
  if (discovery.isError) {
    return <MosErrorView error={discovery.error} what="job discovery" onRetry={() => void discovery.refetch()} />;
  }
  const view = discovery.data;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Your declared service area</CardTitle>
          <CardDescription className="font-mono text-xs">source: GET /api/jobs/queue/discovery</CardDescription>
        </CardHeader>
        <CardContent className="text-sm">
          {view.serviceArea.location ? (
            <p className="font-mono text-xs">
              location: {view.serviceArea.location.kind}:{view.serviceArea.location.value}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">No location declared.</p>
          )}
          <p className="mt-1 font-mono text-xs">
            territories:{" "}
            {view.serviceArea.territories.map((territory) => `${territory.kind}:${territory.value}`).join(", ") || "—"}
          </p>
          <p className="mt-2 text-sm">
            {view.matched} eligible job{view.matched === 1 ? "" : "s"} matched your profile.
          </p>
        </CardContent>
      </Card>
      {view.jobs.length === 0 ? (
        <EmptyState title="No eligible jobs" hint="The profile-only matcher found no open jobs for your agent profile." />
      ) : (
        <ScrollList label="Matched jobs" className="space-y-2">
          {view.jobs.map((job) => (
            <JobDescriptorCard key={job.jobId} job={job} />
          ))}
        </ScrollList>
      )}
    </div>
  );
}

function MarketplaceTab() {
  const marketplace = useJobsMarketplace();
  if (marketplace.isPending) return <LoadingSkeleton rows={3} />;
  if (marketplace.isError) {
    return (
      <MosErrorView error={marketplace.error} what="the job marketplace" onRetry={() => void marketplace.refetch()} />
    );
  }
  const jobs = marketplace.data?.jobs ?? [];
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Job marketplace</CardTitle>
        <CardDescription className="font-mono text-xs">
          source: GET /api/jobs/marketplace · descriptors only (no client data at this boundary)
        </CardDescription>
      </CardHeader>
      <CardContent>
        {jobs.length === 0 ? (
          <EmptyState title="No open jobs" hint="No jobs with an open round match your agent profile." />
        ) : (
          <ScrollList label="Marketplace jobs" className="space-y-2">
            {jobs.map((job) => (
              <JobDescriptorCard key={job.jobId} job={job} />
            ))}
          </ScrollList>
        )}
      </CardContent>
    </Card>
  );
}
