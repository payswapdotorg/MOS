"use client";

// UX-008 — the Human Treatment console surface: one client-scoped view
// where the OPTIONAL HUMAN ARM of the client's growth work is SEEN — the
// human arm of each experiment (its bounded allocation, its truthful
// availability state and its outcome attribution, composed ONLY from the
// MKT-067 experiment-analysis authority through its existing routes), the
// never-blocks guarantee made VISIBLE (the non-human arms proceeding with
// their computed shares whenever the human arm is unfunded, excluded or
// absent — change-request-006 rule 21: never a hidden failure, never a
// simulated success), and the ONE honest human blocker — a genuinely
// mandatory rights/policy/capability review — rendered as the explicit
// blocked-pending-human-action state with its recorded reason, composed
// from the growth-missions authority (the client's missions through their
// goal mappings). Zero new authorities: the /experiments, /experiment-
// analysis and /growth-missions surfaces composed as-is; the per-client
// human OFFER outcomes (declined/expired offers) have no client-scoped
// read surface yet and render the honest "not yet exposed" disclosure —
// never invented, never hidden.

import * as React from "react";
import { ArrowRight, ClipboardList, Users } from "lucide-react";
import {
  useAgencyGrowthMissions,
  useClient,
  useExperimentsForClient,
  useGrowthMissionDetail,
} from "@/components/mos/hooks";
import { useMosSession } from "@/components/mos/session-store";
import {
  Chip,
  SectionSkeleton,
  SourceLine,
  WorkspaceActionButton,
  formatWhen,
  provenanceString,
} from "@/components/mos/mission/workspace-atoms";
import { SectionErrorViewInline } from "@/components/mos/connections/SocialConnections";
import {
  STATUS_MEANING,
  TONE_CHIP_CLASSES,
  humanizeStatus,
  statusTone,
} from "@/components/mos/mission/status";
import type { GrowthMissionView } from "@/lib/mos-api";
import { HumanTreatmentExperimentCard } from "./HumanTreatmentExperimentCard";

export function TreatmentsTab({ clientId }: { clientId: string }) {
  const navigate = useMosSession((state) => state.navigate);
  const experiments = useExperimentsForClient(clientId);
  const client = useClient(clientId);
  const experimentList = experiments.data ?? [];

  // The open-card set (presentation state only — which drill-downs are
  // expanded; the data itself always comes from the API).
  const [openIds, setOpenIds] = React.useState<ReadonlySet<string>>(new Set());
  const toggle = (experimentId: string) => {
    setOpenIds((previous) => {
      const next = new Set(previous);
      if (next.has(experimentId)) next.delete(experimentId);
      else next.add(experimentId);
      return next;
    });
  };

  return (
    <div className="space-y-8">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-stone-900">
          <Users className="size-5" aria-hidden="true" /> Human treatment
        </h2>
        <p className="mt-1 max-w-prose text-sm leading-relaxed text-stone-600">
          Human work is an optional experiment arm on this client&apos;s missions — it
          competes alongside the automated treatments, with a bounded budget and the same
          evidence loop. This surface shows the human arm of each experiment exactly as the
          allocation authority recorded it: eligible and funded, unfunded with zero capacity,
          or not declared. When the human arm is unavailable the non-human arms keep
          proceeding — that guarantee is shown, never assumed. Only a genuinely mandatory
          rights, policy or capability review may block work on a human decision, and that
          state is rendered explicitly with its recorded reason.
        </p>
      </div>

      <section aria-labelledby="treatments-experiments-heading" className="space-y-3">
        <div>
          <h3 id="treatments-experiments-heading" className="font-medium text-stone-800">
            The human arm of each experiment
          </h3>
          <p className="mt-0.5 text-xs leading-relaxed text-stone-500">
            Every experiment on this client, with its bounded allocation and outcome
            attribution — expand an experiment to load its live allocation and analysis
            tails from the experiment-analysis authority.
          </p>
        </div>
        {experiments.isPending ? (
          <SectionSkeleton rows={3} />
        ) : experiments.isError ? (
          <SectionErrorViewInline
            error={experiments.error}
            what="the client's experiments"
            onRetry={() => void experiments.refetch()}
          />
        ) : experimentList.length === 0 ? (
          <div className="rounded-lg border border-dashed border-stone-300 bg-stone-50/60 p-4">
            <p className="text-sm font-medium text-stone-700">
              No experiments are declared on this client yet.
            </p>
            <p className="mt-1.5 text-sm leading-relaxed text-stone-600">
              A human treatment arm exists only inside an experiment — there is no human arm
              to show until an experiment is declared and the bounded allocator records an
              allocation over its arms. Nothing is invented here, and the absence of human
              work never blocks the client&apos;s missions.
            </p>
            <p className="mt-1.5 text-sm leading-relaxed text-stone-600">
              The same experiment list composes the Scientific trace tab; missions are
              created from the home screen&apos;s outcome choices.
            </p>
            <div className="mt-3">
              <WorkspaceActionButton
                tone="teal"
                onClick={() => navigate({ kind: "client", clientId, tab: "trace" })}
                ariaLabel="Open the Scientific trace tab"
              >
                <span className="inline-flex items-center gap-1.5">
                  Open the Scientific trace
                  <ArrowRight className="size-4" aria-hidden="true" />
                </span>
              </WorkspaceActionButton>
            </div>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {experimentList.map((experiment) => (
              <HumanTreatmentExperimentCard
                key={experiment.experimentId}
                clientId={clientId}
                experiment={experiment}
                open={openIds.has(experiment.experimentId)}
                onToggle={() => toggle(experiment.experimentId)}
              />
            ))}
          </ul>
        )}
      </section>

      <MissionStatesSection clientId={clientId} agencyId={client.data?.agencyId ?? null} />

      <div className="rounded-xl border border-stone-200 bg-stone-50/60 px-5 py-4">
        <p className="text-sm leading-relaxed text-stone-600">
          This surface composes three existing authorities and holds no state of its own:
          the experiment records and their MKT-067 allocation/analysis tails, and the
          growth-missions lifecycle records for the missions that reference this client
          through their goal mappings. One honest gap: the per-client human OFFER outcomes —
          which creator was offered what, and the declined/expired offer records — are held
          by the jobs authority but have no client-scoped read surface yet, so they cannot
          be shown here without inventing them. Your own offers, the eligibility-gated
          marketplace and accepted work remain fully visible on the Human Work surface.
        </p>
        <div className="mt-3">
          <WorkspaceActionButton
            tone="plain"
            onClick={() => navigate({ kind: "human-work" })}
            ariaLabel="Open the Human Work surface"
          >
            <span className="inline-flex items-center gap-1.5">
              <ClipboardList className="size-4" aria-hidden="true" />
              Open Human Work (your own offers and queue)
            </span>
          </WorkspaceActionButton>
        </div>
        <SourceLine
          sources={[
            `GET /api/clients/${clientId.slice(0, 8)}…/experiments (which experiments exist)`,
            "GET /api/clients/:clientId/experiment-analysis/allocations/by-experiment/:experimentId (the bounded allocation + the human-arm consideration, on expand)",
            "GET /api/clients/:clientId/experiment-analysis/analyses/by-experiment/:experimentId (the outcome attribution, on expand)",
            "GET /api/agencies/:agencyId/growth-missions + GET /api/growth-missions/:missionId (the client's missions through their goal mappings — the blocked/paused/terminal vocabulary)",
          ]}
        />
      </div>
    </div>
  );
}

// --- The mission-level states (the never-blocks vocabulary + the one blocker) -----

/**
 * The client's missions — the agency's missions whose ACTIVE goal mappings
 * reference goals of THIS client (presentation grouping over the served
 * records, the HealthTab per-account grouping discipline). Each renders
 * with its frozen lifecycle status, its meaning in one plain sentence and,
 * for the blocked family, the recorded reason VERBATIM — the explicit
 * blocked-pending-human-action exception among them.
 */
function MissionStatesSection({
  clientId,
  agencyId,
}: {
  clientId: string;
  agencyId: string | null;
}) {
  const missions = useAgencyGrowthMissions(agencyId);
  const missionList = missions.data ?? [];
  return (
    <section aria-labelledby="treatments-missions-heading" className="space-y-3">
      <div>
        <h3 id="treatments-missions-heading" className="font-medium text-stone-800">
          Mission states — the never-blocks vocabulary
        </h3>
        <p className="mt-0.5 text-xs leading-relaxed text-stone-500">
          What each mission referencing this client did when its human arm (or any arm) was
          unavailable: it kept going, reallocated, paused, or reached an explicit terminal
          state. Only a genuinely mandatory rights/policy/capability review becomes a human
          blocker — recorded as blocked pending human action, with its reason.
        </p>
      </div>
      {agencyId === null ? (
        <SectionSkeleton rows={2} />
      ) : missions.isPending ? (
        <SectionSkeleton rows={2} />
      ) : missions.isError ? (
        <SectionErrorViewInline
          error={missions.error}
          what="the agency's missions"
          onRetry={() => void missions.refetch()}
        />
      ) : missionList.length === 0 ? (
        <p className="rounded-lg border border-dashed border-stone-300 bg-stone-50/60 p-4 text-sm leading-relaxed text-stone-600">
          No missions exist on this agency yet — the mission-level states (paused, terminal,
          blocked pending human action) appear here as soon as a mission referencing this
          client through its goal mappings exists.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {missionList.map((mission) => (
            <ClientMissionRow key={mission.missionId} mission={mission} clientId={clientId} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** One mission row — links to this client (or renders nothing, honestly). */
function ClientMissionRow({
  mission,
  clientId,
}: {
  mission: GrowthMissionView;
  clientId: string;
}) {
  const navigate = useMosSession((state) => state.navigate);
  const detail = useGrowthMissionDetail(mission.missionId);
  if (detail.isError) {
    // The mission list served the record but its composed read failed —
    // render the honest error for THIS mission only, never dropped.
    return (
      <li>
        <SectionErrorViewInline
          error={detail.error}
          what={`mission ${mission.missionId.slice(0, 8)}…'s detail`}
          onRetry={() => void detail.refetch()}
        />
      </li>
    );
  }
  if (detail.data === undefined) {
    // Still loading (or not yet resolvable) — a quiet placeholder row that
    // never looks like data.
    return (
      <li
        className="h-10 animate-pulse rounded-lg border border-stone-200 bg-stone-100/60"
        aria-hidden="true"
      />
    );
  }
  // Presentation grouping only: a mission belongs to this client's picture
  // when an ACTIVE (not removed) goal mapping resolves to a goal of THIS
  // client. Missions of other clients render nothing here — their records
  // stay fully readable on their own clients' surfaces.
  const linked = detail.data.goalMappings.some(
    (mapping) => mapping.removedAt === null && mapping.goalClientId === clientId,
  );
  if (!linked) return null;

  const status = detail.data.mission.status;
  const tone = statusTone(status);
  // The transition event that carries the current status's own recorded
  // reason (the BlockersSection discipline — the evidence basis).
  const statusEvent = [...detail.data.history]
    .reverse()
    .find((event) => event.toStatus === status);
  const isHumanBlocked = status === "blocked_pending_human_action";

  return (
    <li
      className={`rounded-xl border px-4 py-3 ${
        isHumanBlocked ? "border-red-800/25 bg-red-50/60" : "border-stone-200 bg-white"
      }`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-stone-500">
          mission {mission.missionId.slice(0, 8)}…
        </span>
        <Chip label={humanizeStatus(status)} className={TONE_CHIP_CLASSES[tone]} />
        <span className="ml-auto text-xs text-stone-400">
          updated {formatWhen(mission.updatedAt)}
        </span>
      </div>
      <p className="mt-1.5 text-sm leading-relaxed text-stone-700">
        {STATUS_MEANING[status] ?? `The mission is in the ${humanizeStatus(status)} state.`}
      </p>
      {statusEvent?.reason ? (
        <p
          className={`mt-1.5 text-sm leading-relaxed ${isHumanBlocked ? "text-red-900/90" : "text-stone-600"}`}
        >
          <span className="font-medium">Reason recorded:</span> {statusEvent.reason}
        </p>
      ) : null}
      {isHumanBlocked ? (
        <p className="mt-1.5 text-sm leading-relaxed text-red-900/80">
          This is the one human blocker the architecture allows: a genuinely mandatory
          rights, policy or capability review the system cannot perform itself. It is
          recorded explicitly — never a hidden failure — and the mission record stays
          readable as business history.
        </p>
      ) : null}
      <p className="mt-1.5 font-mono text-[11px] text-stone-400">
        recorded by {provenanceString(statusEvent?.provenance, "actor") ?? "the server"} ·
        objective: {detail.data.currentVersion.objective}
      </p>
      <div className="mt-2">
        <WorkspaceActionButton
          tone="plain"
          onClick={() => navigate({ kind: "mission", missionId: mission.missionId })}
          ariaLabel={`Open the mission workspace for mission ${mission.missionId.slice(0, 8)}`}
        >
          <span className="inline-flex items-center gap-1.5">
            Open the mission workspace
            <ArrowRight className="size-4" aria-hidden="true" />
          </span>
        </WorkspaceActionButton>
      </div>
    </li>
  );
}
