"use client";

// UX-003 — THE MISSION WORKSPACE.
//
// One screen answers, for a mission: target, progress, now, next, why,
// evidence, hypothesis, experiment, platforms, health, content, rights,
// transformation, measurement, decision, learning and blockers.
//
// THE COMPOSITION DISCIPLINE (binding): this screen is a presentation
// surface over existing module authorities. It creates NO second analytics
// layer, NO second health model, NO parallel mission state — every datum
// comes from its owning module's real read surface through thin useMosQuery
// wrappers, every mutation goes through the mission module's own routes.
// The client context resolves from the mission's goal mappings (the goal
// that owns the most recently added active mapping); when none resolves (the
// young-mission norm), the client-scoped queries stay DISABLED and every
// such section renders the WORKER-CONTRACT empty state.
//
// Visual direction (binding): calm warm-light surface, soft graphite text,
// restrained teal/green healthy, amber warning, red failure, generous
// whitespace, minimal chrome, progressive disclosure.

import { ArrowLeft } from "lucide-react";
import { FAMILY_PRESENTATION, isObjectiveFamily } from "@/components/mos/create/families";
import { useClient, useGrowthMissionDetail } from "@/components/mos/hooks";
import type { GrowthMissionDetailView } from "@/lib/mos-api";
import { useMosSession } from "@/components/mos/session-store";
import {
  SectionSkeleton,
  SourceLine,
  WorkspaceActionButton,
  formatWhen,
} from "./workspace-atoms";
import { TONE_CHIP_CLASSES, humanizeStatus, shortMissionId, statusTone } from "./status";
import { LifecyclePanel } from "./LifecyclePanel";
import { BlockersSection, NowNextSection, ProgressSection, TargetSection } from "./sections-mission";
import {
  ContentSection,
  DecisionsSection,
  EvidenceSection,
  ExperimentsSection,
  HealthSection,
  LearningsSection,
  MetricsSection,
  PlatformsSection,
  RightsSection,
  TransformationSection,
} from "./sections-client";

export function MissionWorkspaceScreen({ missionId }: { missionId: string }) {
  const navigate = useMosSession((state) => state.navigate);
  const agencyId = useMosSession((state) => state.agencyId);
  const query = useGrowthMissionDetail(missionId);

  if (query.isPending) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-5 pb-12 pt-8 sm:px-8">
        <div className="h-8 w-40 animate-pulse rounded bg-stone-200/70" aria-hidden="true" />
        <div className="h-28 animate-pulse rounded-xl bg-stone-200/60" aria-hidden="true" />
        <div className="h-64 animate-pulse rounded-xl bg-stone-200/50" aria-hidden="true" />
        <p className="text-sm text-stone-500">Loading the mission…</p>
      </div>
    );
  }

  if (query.isError) {
    const notFound =
      typeof query.error === "object" &&
      query.error !== null &&
      "status" in query.error &&
      (query.error as { status?: number }).status === 404;
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-5 pb-12 pt-8 sm:px-8">
        <button
          type="button"
          onClick={() => navigate({ kind: "home" })}
          className="inline-flex min-h-[44px] items-center gap-2 self-start rounded-lg border border-stone-300 bg-white px-4 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100 focus-visible:ring-2 focus-visible:ring-teal-700"
        >
          <ArrowLeft className="size-4" aria-hidden="true" /> Back to Home
        </button>
        {notFound ? (
          <div className="rounded-xl border border-stone-200 bg-white p-6">
            <p className="font-medium text-stone-800">This mission isn&apos;t available.</p>
            <p className="mt-2 text-sm leading-relaxed text-stone-600">
              The server has no mission with this identifier for your session — it may have been
              created under a different agency, or the link is stale. The missions your agencies
              hold are listed on Home under &ldquo;Continue a mission&rdquo;.
            </p>
            <div className="mt-4">
              <WorkspaceActionButton onClick={() => navigate({ kind: "home" })}>
                Go to Home
              </WorkspaceActionButton>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-amber-700/20 bg-amber-50 p-5">
            <p className="font-medium text-amber-900">
              This mission couldn&apos;t be loaded just now.
            </p>
            <p className="mt-1 break-words text-sm leading-relaxed text-amber-900/80">
              {query.error instanceof Error ? query.error.message : String(query.error)}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <WorkspaceActionButton tone="amber" onClick={() => void query.refetch()}>
                Try again
              </WorkspaceActionButton>
              <WorkspaceActionButton onClick={() => navigate({ kind: "home" })}>
                Back to Home
              </WorkspaceActionButton>
            </div>
          </div>
        )}
      </div>
    );
  }

  const detail = query.data;
  if (detail === undefined) return null;

  // The client context: the owner of the most recently added ACTIVE goal
  // mapping (the /goals authority's own ownership resolution, carried live
  // by the mission detail read). Zero active mappings → null (the honest
  // young-mission state; client-scoped queries stay disabled).
  const activeMappings = detail.goalMappings
    .filter((mapping) => mapping.removedAt === null && mapping.goalClientId !== null)
    .sort((a, b) => (b.addedAt ?? "").localeCompare(a.addedAt ?? ""));
  const primaryClientId = activeMappings[0]?.goalClientId ?? null;
  const distinctClients = new Set(
    activeMappings.map((mapping) => mapping.goalClientId as string),
  );

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 pb-12 pt-8 sm:px-8">
      <button
        type="button"
        onClick={() => navigate({ kind: "home" })}
        className="inline-flex min-h-[44px] items-center gap-2 self-start rounded-lg border border-stone-300 bg-white px-4 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100 focus-visible:ring-2 focus-visible:ring-teal-700"
      >
        <ArrowLeft className="size-4" aria-hidden="true" /> Back to Home
      </button>

      <MissionHeader detail={detail} />

      <ClientContextBanner
        clientId={primaryClientId}
        clientCount={distinctClients.size}
      />

      <LifecyclePanel detail={detail} />

      <div className="flex flex-col gap-4" aria-label="Mission answers">
        <TargetSection detail={detail} />
        <ProgressSection detail={detail} agencyId={agencyId} />
        <NowNextSection detail={detail} />
        <EvidenceSection clientId={primaryClientId} />
        <ExperimentsSection clientId={primaryClientId} />
        <PlatformsSection clientId={primaryClientId} />
        <HealthSection clientId={primaryClientId} />
        <ContentSection clientId={primaryClientId} />
        <RightsSection clientId={primaryClientId} />
        <TransformationSection clientId={primaryClientId} />
        <MetricsSection clientId={primaryClientId} />
        <DecisionsSection clientId={primaryClientId} />
        <LearningsSection clientId={primaryClientId} />
        <BlockersSection detail={detail} />
      </div>

      <SourceLine
        sources={[
          "GET /api/growth-missions/:missionId (the mission's own truth — mission, currentVersion, goalMappings, history, terminalDecisionBasis)",
          "client-scoped compositions resolve their inputs from the mission's goal mappings",
        ]}
      />
    </div>
  );
}

// --- The header (answers WHY: the objective verbatim) --------------------------------

function MissionHeader({ detail }: { detail: GrowthMissionDetailView }) {
  const status = detail.mission.status;
  const family = detail.currentVersion.objectiveFamily;
  const familyLabel = isObjectiveFamily(family) ? FAMILY_PRESENTATION[family].label : null;
  const product = detail.currentVersion.productContext;
  const market = detail.currentVersion.marketContext;

  return (
    <header className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-stone-800">
          Mission {shortMissionId(detail.mission.missionId)}
        </h1>
        <span
          className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
            TONE_CHIP_CLASSES[statusTone(status)]
          }`}
        >
          {humanizeStatus(status)}
        </span>
      </div>
      <p className="text-xs text-stone-500">
        {familyLabel ?? "Outcome recorded"}
        {" · version "}
        {detail.mission.currentVersionSeq} of the declared content · created{" "}
        {formatWhen(detail.mission.createdAt) || "—"} · updated{" "}
        {formatWhen(detail.mission.updatedAt) || "—"}
      </p>

      <div className="rounded-xl border border-stone-200 bg-white p-5">
        <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">Why</p>
        <blockquote className="mt-1.5 text-base leading-relaxed text-stone-800">
          &ldquo;{detail.currentVersion.objective}&rdquo;
        </blockquote>
        <p className="mt-1.5 text-xs text-stone-500">
          The objective, verbatim — every terminal decision on this mission is evaluated against
          the declared objective family ({familyLabel?.toLowerCase() ?? family}), never against an
          intermediate metric.
        </p>
        {product?.name || product?.url || product?.summary || market?.audience || market?.geography || market?.summary ? (
          <div className="mt-4 flex flex-col gap-2 border-t border-stone-100 pt-3">
            {product?.name ? (
              <p className="text-sm text-stone-700">
                <span className="font-medium">Product:</span> {product.name}
                {product.url ? (
                  <>
                    {" · "}
                    <span className="break-all text-stone-500">{product.url}</span>
                  </>
                ) : null}
              </p>
            ) : null}
            {product?.summary ? (
              <p className="text-sm leading-relaxed text-stone-600">{product.summary}</p>
            ) : null}
            {market?.audience || market?.geography ? (
              <p className="text-sm text-stone-700">
                <span className="font-medium">Market:</span>
                {market?.audience ? ` ${market.audience}` : ""}
                {market?.geography ? ` · ${market.geography}` : ""}
              </p>
            ) : null}
            {market?.summary ? (
              <p className="text-sm leading-relaxed text-stone-600">{market.summary}</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </header>
  );
}

// --- The client context banner --------------------------------------------------------

/**
 * Discloses WHICH client's working surfaces the mission composes (resolved
 * from the goal mappings — never guessed), with the working action to open
 * that client's workspace. Multiple mapped clients → the honest note.
 */
function ClientContextBanner({
  clientId,
  clientCount,
}: {
  clientId: string | null;
  clientCount: number;
}) {
  const navigate = useMosSession((state) => state.navigate);
  const client = useClient(clientId);
  if (clientId === null) {
    return (
      <div className="rounded-xl border border-dashed border-stone-300 bg-stone-50/60 p-4">
        <p className="text-sm font-medium text-stone-700">
          Not connected to a client&apos;s working surfaces yet
        </p>
        <p className="mt-1.5 text-sm leading-relaxed text-stone-600">
          The mission composes evidence, experiments, metrics, decisions, learnings, channels,
          content and rights from the client that owns its mapped goal. Once a goal is mapped
          (Progress below), those sections fill in live.
        </p>
      </div>
    );
  }
  const name = client.data?.name;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-stone-200 bg-stone-50/70 p-4">
      <p className="min-w-0 flex-1 text-sm leading-relaxed text-stone-700">
        Composing <span className="font-medium text-stone-800">{name ?? `client ${clientId.slice(0, 8)}…`}</span>
        &apos;s working surfaces — the client that owns the mapped goal.
        {clientCount > 1 ? (
          <>
            {" "}
            Mapped goals span {clientCount} clients; this view composes the most recently mapped
            one.
          </>
        ) : null}
      </p>
      <WorkspaceActionButton
        onClick={() => navigate({ kind: "client", clientId, tab: "overview" })}
      >
        Open the client workspace
      </WorkspaceActionButton>
    </div>
  );
}
