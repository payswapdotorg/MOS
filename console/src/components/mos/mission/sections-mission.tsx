"use client";

// UX-003 — the mission-own sections: TARGET, PROGRESS (goal mappings with
// live goal status + the real goal-mapping action), NOW / NEXT (the history
// tail rendered plainly + the honest Growth Operator disclosure) and
// BLOCKERS (the mission's own blocked statuses with reason through history).
// Every datum comes from GET /api/growth-missions/:missionId — the mission
// module stays the authority; nothing here recomputes or fabricates.

import * as React from "react";
import { FAMILY_PRESENTATION, isObjectiveFamily } from "@/components/mos/create/families";
import { useClients, useGoals, useMapGoalToMission } from "@/components/mos/hooks";
import type {
  GrowthMissionDetailView,
  GrowthMissionEventView,
  GrowthMissionGoalMappingView,
} from "@/lib/mos-api";
import { MosApiError } from "@/lib/mos-api";
import { useMosSession } from "@/components/mos/session-store";
import {
  Chip,
  GoalStatusChip,
  SectionErrorView,
  SectionSkeleton,
  SourceLine,
  WorkspaceActionButton,
  WorkspaceEmptyState,
  WorkspaceSection,
  formatWhen,
  provenanceString,
} from "./workspace-atoms";
import {
  STATUS_MEANING,
  TONE_CHIP_CLASSES,
  humanizeStatus,
  isBlockedStatus,
  isTerminalMissionStatus,
  statusTone,
} from "./status";

// --- TARGET -----------------------------------------------------------------------

export function TargetSection({ detail }: { detail: GrowthMissionDetailView }) {
  const metrics = detail.currentVersion.targetMetrics ?? [];
  const objective = detail.currentVersion.objective;
  return (
    <WorkspaceSection
      id="target"
      question="Target"
      title="What success looks like"
      summary={
        metrics.length === 0
          ? "No target metrics declared — the objective in your own words is the target."
          : `${metrics.length} declared target${metrics.length === 1 ? "" : "s"}${
              metrics.some((metric) => metric.intermediate) ? " (some intermediate)" : ""
            }`
      }
      defaultOpen
    >
      <blockquote className="rounded-lg bg-stone-50/80 p-4 text-sm leading-relaxed text-stone-800">
        &ldquo;{objective}&rdquo;
      </blockquote>
      {metrics.length === 0 ? (
        <p className="mt-3 text-sm leading-relaxed text-stone-600">
          This mission carries no numeric targets yet — that is fine for a young mission. The
          objective above, verbatim, is what the mission pursues; targets can be declared in a
          later version of the mission.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-1.5">
          {metrics.map((metric, index) => (
            <li
              key={`${metric.metric}-${index}`}
              className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm text-stone-700"
            >
              <span className="font-medium text-stone-800">{metric.metric}</span>
              <span className="tabular-nums">
                {metric.comparator} {metric.targetValue}
                {metric.unit ? ` ${metric.unit}` : ""}
              </span>
              {metric.intermediate ? (
                <span className="text-xs text-stone-500">· intermediate</span>
              ) : null}
              {metric.description ? (
                <span className="text-xs text-stone-500">· {metric.description}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <SourceLine sources={["GET /api/growth-missions/:missionId (currentVersion)"]} />
    </WorkspaceSection>
  );
}

// --- PROGRESS ----------------------------------------------------------------------

/**
 * Progress is the mission's goal mappings with their LIVE /goals status —
 * never a fabricated percentage. The terminal decision basis is disclosed
 * alongside (the frozen declared-business-objective-family rule). The
 * section also carries the REAL goal-mapping action (POST
 * /api/growth-missions/:missionId/goal-mappings) — the explicit working
 * action an empty young mission needs before it can be activated.
 */
export function ProgressSection({
  detail,
  agencyId,
}: {
  detail: GrowthMissionDetailView;
  agencyId: string | null;
}) {
  const active = detail.goalMappings.filter((mapping) => mapping.removedAt === null);
  const removed = detail.goalMappings.length - active.length;
  const hasActive = active.length > 0;

  return (
    <WorkspaceSection
      id="progress"
      question="Progress"
      title="Goals this mission pursues"
      summary={
        hasActive
          ? `${active.length} mapped goal${active.length === 1 ? "" : "s"}, live status from the Goals authority${
              removed > 0 ? ` · ${removed} removed earlier` : ""
            }`
          : "No goals mapped yet — mapping one is the next step before activation"
      }
      summaryTone={hasActive ? "healthy" : "warning"}
      defaultOpen
    >
      {hasActive ? (
        <ul className="flex flex-col gap-2">
          {active.map((mapping) => (
            <GoalMappingRow key={mapping.mappingId} mapping={mapping} />
          ))}
        </ul>
      ) : (
        <WorkspaceEmptyState
          missing="No goals are mapped to this mission yet."
          why="A mission pursues through goals — they are the measurable anchor, and activating a mission requires at least one mapped goal."
          next="Map an existing goal below (or create one on a client first, then map it here)."
        />
      )}
      {removed > 0 ? (
        <p className="mt-3 text-xs text-stone-500">
          {removed} earlier mapping{removed === 1 ? "" : "s"} removed — removals are recorded, never
          erased.
        </p>
      ) : null}
      <TerminalBasisNote detail={detail} />
      {!isTerminalMissionStatus(detail.mission.status) ? (
        <MapGoalPanel missionId={detail.mission.missionId} agencyId={agencyId} />
      ) : (
        <p className="mt-4 text-xs leading-relaxed text-stone-500">
          This mission ended as {humanizeStatus(detail.mission.status).toLowerCase()} — its goal
          mapping is frozen and stays part of the readable history.
        </p>
      )}
      <SourceLine sources={["GET /api/growth-missions/:missionId (goalMappings, live /goals status)"]} />
    </WorkspaceSection>
  );
}

function GoalMappingRow({ mapping }: { mapping: GrowthMissionGoalMappingView }) {
  const navigate = useMosSession((state) => state.navigate);
  return (
    <li className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-stone-200 bg-stone-50/60 px-4 py-3">
      <span className="min-w-0 flex-1">
        <span className="block font-mono text-xs text-stone-600">goal {mapping.goalId.slice(0, 8)}…</span>
        <span className="mt-0.5 block text-xs text-stone-500">
          Mapped {formatWhen(mapping.addedAt) || "earlier"}
          {mapping.goalClientId ? (
            <>
              {" · "}
              <button
                type="button"
                className="font-medium text-teal-800 underline decoration-teal-800/30 underline-offset-2 hover:decoration-teal-800"
                onClick={() =>
                  navigate({ kind: "client", clientId: mapping.goalClientId as string, tab: "goals" })
                }
              >
                open the client&apos;s goals
              </button>
            </>
          ) : null}
        </span>
      </span>
      <GoalStatusChip status={mapping.goalStatus} />
    </li>
  );
}

/** The frozen terminal-decision basis, disclosed plainly (never a percentage). */
function TerminalBasisNote({ detail }: { detail: GrowthMissionDetailView }) {
  const basis = typeof detail.terminalDecisionBasis === "string" ? detail.terminalDecisionBasis : null;
  return (
    <div className="mt-4 rounded-lg bg-stone-50/70 p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
        How completion is decided
      </p>
      <p className="mt-1 text-sm leading-relaxed text-stone-600">
        Progress here is the live status of the mapped goals — this screen never computes a
        percentage or invents one. When a mission ends, the decision is evaluated against the
        declared objective family
        {basis ? (
          <>
            {" "}
            (basis: <span className="font-mono text-xs">{basis}</span>)
          </>
        ) : null}
        , never against an intermediate metric.
      </p>
    </div>
  );
}

// --- The real goal-mapping action ---------------------------------------------------

/**
 * Map an EXISTING goal through the real POST
 * /api/growth-missions/:missionId/goal-mappings {goalId}. Composes the
 * agency's clients + the chosen client's goals (the /goals authority) and
 * posts the mapping; every error is the server's own words inline.
 */
function MapGoalPanel({ missionId, agencyId }: { missionId: string; agencyId: string | null }) {
  const [open, setOpen] = React.useState(false);
  if (agencyId === null) {
    return (
      <div className="mt-4">
        <p className="text-xs leading-relaxed text-stone-500">
          Mapping a goal needs an agency context — select your agency in the sidebar first.
        </p>
      </div>
    );
  }
  return (
    <div className="mt-4 rounded-lg border border-stone-200 bg-white p-4">
      {!open ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-stone-600">Map an existing goal to this mission.</p>
          <WorkspaceActionButton onClick={() => setOpen(true)}>Map a goal</WorkspaceActionButton>
        </div>
      ) : (
        <MapGoalForm missionId={missionId} agencyId={agencyId} onCancel={() => setOpen(false)} />
      )}
    </div>
  );
}

function MapGoalForm({
  missionId,
  agencyId,
  onCancel,
}: {
  missionId: string;
  agencyId: string;
  onCancel: () => void;
}) {
  const clients = useClients(agencyId);
  const [clientId, setClientId] = React.useState<string | null>(null);
  const goals = useGoals(clientId);
  const mapping = useMapGoalToMission(missionId);
  const [selectedGoalId, setSelectedGoalId] = React.useState<string | null>(null);

  const clientList = clients.data ?? [];
  const goalList = goals.data ?? [];

  React.useEffect(() => {
    if (clientId === null && clientList.length > 0) {
      setClientId(clientList[0]!.clientId);
    }
  }, [clientId, clientList]);

  if (clients.isPending) return <SectionSkeleton rows={2} />;
  if (clients.isError) {
    return (
      <SectionErrorView error={clients.error} what="the agency's clients" onRetry={() => void clients.refetch()} />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm font-medium text-stone-700">Map an existing goal</p>
        <p className="mt-1 text-xs leading-relaxed text-stone-500">
          Goals live inside clients. Pick the client that owns the goal, then the goal itself —
          the mapping is recorded through the mission&apos;s real goal-mapping route.
        </p>
      </div>

      {clientList.length === 0 ? (
        <WorkspaceEmptyState
          missing="This agency has no clients yet, so there are no goals to map."
          why="Goals — the measurable anchor a mission pursues through — are recorded inside a client."
          next="Create a client first, then add a goal to it, and come back here to map it."
          action={
            <WorkspaceActionButton onClick={() => onOpenClients()}>
              Open Clients
            </WorkspaceActionButton>
          }
        />
      ) : (
        <>
          <div className="flex flex-col gap-2">
            <label htmlFor="map-goal-client" className="text-xs font-medium text-stone-600">
              Client
            </label>
            <select
              id="map-goal-client"
              value={clientId ?? ""}
              onChange={(event) => {
                setClientId(event.target.value === "" ? null : event.target.value);
                setSelectedGoalId(null);
              }}
              className="min-h-[44px] w-full rounded-lg border border-stone-300 bg-white px-3 text-sm text-stone-800 focus-visible:ring-2 focus-visible:ring-teal-700"
            >
              {clientList.map((client) => (
                <option key={client.clientId} value={client.clientId}>
                  {client.name}
                </option>
              ))}
            </select>
          </div>

          {clientId !== null ? (
            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium text-stone-600">Goal</span>
              {goals.isPending ? (
                <SectionSkeleton rows={2} />
              ) : goals.isError ? (
                <SectionErrorView
                  error={goals.error}
                  what="the client's goals"
                  onRetry={() => void goals.refetch()}
                />
              ) : goalList.length === 0 ? (
                <p className="rounded-lg border border-dashed border-stone-300 bg-stone-50/60 p-3 text-sm leading-relaxed text-stone-600">
                  This client has no goals yet. Add one on the client&apos;s Goals tab first — the
                  mapping needs an existing goal.
                </p>
              ) : (
                <ul className="flex max-h-64 flex-col gap-1.5 overflow-y-auto pr-1">
                  {goalList.map((goal) => (
                    <li key={goal.goalId}>
                      <label className="flex min-h-[44px] cursor-pointer items-start gap-3 rounded-lg border border-stone-200 px-3 py-2.5 text-sm transition-colors hover:bg-stone-50 has-checked:border-teal-700/40 has-checked:bg-teal-50/50">
                        <input
                          type="radio"
                          name="map-goal-choice"
                          value={goal.goalId}
                          checked={selectedGoalId === goal.goalId}
                          onChange={() => setSelectedGoalId(goal.goalId)}
                          className="mt-1 size-4 accent-teal-700"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block leading-snug text-stone-800">{goal.objective}</span>
                          <span className="mt-1 block text-xs text-stone-500">
                            status {goal.status.replace(/_/g, " ")}
                            {goal.successCriteria.length > 0
                              ? ` · ${goal.successCriteria.length} success criterion${
                                  goal.successCriteria.length === 1 ? "" : "s"
                                }`
                              : ""}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}

          {mapping.isError ? (
            <div className="rounded-lg border border-red-800/20 bg-red-50 p-3" role="alert">
              <p className="text-sm font-medium text-red-900">The mapping was refused by the server.</p>
              {mapping.error instanceof MosApiError ? (
                <>
                  <p className="mt-1 break-words text-sm leading-relaxed text-red-900/80">
                    {mapping.error.status} · {mapping.error.code} — {mapping.error.message}
                  </p>
                  {mapping.error.details.length > 0 ? (
                    <ul className="mt-1 list-disc pl-5 text-xs leading-relaxed text-red-900/80">
                      {mapping.error.details.map((detail) => (
                        <li key={detail} className="break-words">
                          {detail}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              ) : (
                <p className="mt-1 break-words text-sm leading-relaxed text-red-900/80">
                  {mapping.error instanceof Error ? mapping.error.message : String(mapping.error)}
                </p>
              )}
              <p className="mt-1 text-xs leading-relaxed text-red-900/70">
                Nothing was recorded — pick another goal or try again.
              </p>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <WorkspaceActionButton
              disabled={selectedGoalId === null || mapping.isPending}
              onClick={() => {
                if (selectedGoalId !== null) {
                  mapping.mutate({ goalId: selectedGoalId });
                }
              }}
            >
              {mapping.isPending ? "Recording…" : "Record the mapping"}
            </WorkspaceActionButton>
            <WorkspaceActionButton tone="plain" onClick={onCancel}>
              Close
            </WorkspaceActionButton>
          </div>
        </>
      )}
    </div>
  );
}

function onOpenClients() {
  // Navigation through the store (the house pattern) — the Clients surface
  // is one view away, never a dead end.
  useMosSession.getState().navigate({ kind: "clients" });
}

// --- NOW / NEXT ----------------------------------------------------------------------

/**
 * NOW: the latest history events rendered plainly (the append-only tail the
 * mission module owns). NEXT: the honest composition disclosure — next
 * steps are composed server-side by the Growth Operator (§13), whose public
 * read surface is not exposed yet; the workspace never invents a plan.
 */
export function NowNextSection({ detail }: { detail: GrowthMissionDetailView }) {
  const history = detail.history ?? [];
  const [showAll, setShowAll] = React.useState(false);
  const recent = showAll ? [...history].reverse() : [...history].reverse().slice(0, 5);
  const status = detail.mission.status;

  return (
    <WorkspaceSection
      id="now-next"
      question="Now · Next"
      title="What is happening, and what comes next"
      summary={
        history.length === 0
          ? "No recorded events yet"
          : `${history.length} recorded update${history.length === 1 ? "" : "s"} · latest: ${
              latestSummary(history)
            }`
      }
      defaultOpen
    >
      {history.length === 0 ? (
        <WorkspaceEmptyState
          missing="No events are recorded for this mission yet."
          why="Every change — activation, pauses, blocks, goal mappings — is recorded with actor and reason, so the mission's story stays auditable."
          next="The first event exists the moment the mission changes (a goal mapping, a lifecycle transition)."
        />
      ) : (
        <ol className="flex flex-col gap-3">
          {recent.map((event) => (
            <HistoryEventRow key={event.eventId} event={event} />
          ))}
        </ol>
      )}
      {history.length > 5 ? (
        <button
          type="button"
          onClick={() => setShowAll((value) => !value)}
          className="mt-3 text-sm font-medium text-teal-800 underline decoration-teal-800/30 underline-offset-2 hover:decoration-teal-800"
        >
          {showAll ? "Show the latest 5 only" : `Show all ${history.length} events (oldest first)`}
        </button>
      ) : null}

      <div className="mt-5 rounded-lg bg-stone-50/70 p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-stone-500">What comes next</p>
        <p className="mt-1.5 text-sm leading-relaxed text-stone-600">
          {status === "draft"
            ? "This mission is a draft: nothing runs yet. The deliberate path is to map a goal (Progress above) and then activate it with a reason — never automatic."
            : status === "active"
              ? "While the mission is active, next steps are composed server-side by the Growth Operator — a persistent controller that selects bounded next actions and delegates all physical work through the existing workflow and execution authorities. Every transition it makes is recorded in the history above."
              : isTerminalMissionStatus(status)
                ? `This mission is ${status.replace(/_/g, " ")} — terminal. There is no next step for it; its record and history stay readable, and a successor mission can carry the objective forward.`
                : `The mission is ${status.replace(/_/g, " ")} — it holds its place and can be resumed through a lifecycle transition with a reason.`}
        </p>
        <p className="mt-1.5 text-sm leading-relaxed text-stone-600">
          The controller&apos;s own read surface (its current plan, in flight) is not exposed to
          the console yet — this screen shows the mission&apos;s recorded truth only, never an
          invented plan.
        </p>
      </div>
      <SourceLine sources={["GET /api/growth-missions/:missionId (history, oldest first)"]} />
    </WorkspaceSection>
  );
}

function latestSummary(history: GrowthMissionEventView[]): string {
  const latest = history[history.length - 1];
  if (latest === undefined) return "no events";
  if (latest.toStatus !== null) return `${latest.toStatus.replace(/_/g, " ")}`;
  return latest.eventKind.replace(/_/g, " ");
}

function HistoryEventRow({ event }: { event: GrowthMissionEventView }) {
  const toTone = event.toStatus !== null ? statusTone(event.toStatus) : "neutral";
  const recorded = provenanceString(event.provenance, "recordedAt");
  const actor = provenanceString(event.provenance, "actor");
  return (
    <li className="rounded-lg border border-stone-200 bg-stone-50/50 px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Chip label={humanizeStatus(event.eventKind)} className="border-stone-300 bg-white text-stone-700" />
        {event.fromStatus !== null || event.toStatus !== null ? (
          <span className="flex flex-wrap items-center gap-1.5 text-xs text-stone-500">
            {event.fromStatus !== null ? (
              <Chip label={humanizeStatus(event.fromStatus)} className="border-stone-200 bg-stone-50 text-stone-500" />
            ) : null}
            <span aria-hidden="true">→</span>
            {event.toStatus !== null ? (
              <Chip label={humanizeStatus(event.toStatus)} className={TONE_CHIP_CLASSES[toTone]} />
            ) : null}
          </span>
        ) : null}
        <span className="ml-auto text-xs text-stone-400">{formatWhen(recorded) || ""}</span>
      </div>
      {event.reason ? (
        <p className="mt-1.5 text-sm leading-relaxed text-stone-700">{event.reason}</p>
      ) : null}
      {event.terminalDecisionFamily ? (
        <p className="mt-1 text-xs text-stone-500">
          Terminal decision evaluated against the declared {familyLabel(event.terminalDecisionFamily)}{" "}
          objective.
        </p>
      ) : null}
      {typeof actor === "string" && actor !== "" ? (
        <p className="mt-1 font-mono text-[11px] text-stone-400">actor {actor}</p>
      ) : null}
    </li>
  );
}

function familyLabel(family: string): string {
  return isObjectiveFamily(family) ? FAMILY_PRESENTATION[family].label.toLowerCase() : family;
}

// --- BLOCKERS -------------------------------------------------------------------------

/**
 * The mission's own blocked_* statuses — the blocker, its evidence basis
 * (the history event with the reason verbatim), the required action and the
 * resume path. When none: the honest empty state. NEVER a fabricated
 * "shadow ban"-style hidden moderation state.
 */
export function BlockersSection({ detail }: { detail: GrowthMissionDetailView }) {
  const status = detail.mission.status;
  const blocked = isBlockedStatus(status);
  // The terminal event that carries the block's own reason (the evidence basis).
  const blockedEvent = [...(detail.history ?? [])]
    .reverse()
    .find((event) => event.toStatus === status) ?? null;

  return (
    <WorkspaceSection
      id="blockers"
      question="Blockers"
      title="What is in the way"
      summary={
        blocked
          ? `${humanizeStatus(status)} — with the recorded reason`
          : "No blockers recorded — nothing is in the way"
      }
      summaryTone={blocked ? "warning" : "healthy"}
    >
      {blocked && blockedEvent ? (
        <div className="rounded-lg border border-amber-700/20 bg-amber-50 p-4">
          <p className="font-medium text-amber-900">{humanizeStatus(status)}</p>
          <p className="mt-1 text-sm leading-relaxed text-amber-900/90">
            {STATUS_MEANING[status] ?? `The mission ended in the ${humanizeStatus(status)} state.`}
          </p>
          {blockedEvent.reason ? (
            <p className="mt-2 text-sm leading-relaxed text-amber-900/80">
              <span className="font-medium">Reason recorded:</span> {blockedEvent.reason}
            </p>
          ) : null}
          <dl className="mt-3 flex flex-col gap-2 text-sm text-amber-900/80">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-amber-900/60">
                Evidence basis
              </dt>
              <dd className="mt-0.5">
                The mission&apos;s own history (event {blockedEvent.eventSeq}, recorded{" "}
                {formatWhen(provenanceString(blockedEvent.provenance, "recordedAt")) || "with the transition"}
                {blockedEvent.terminalDecisionFamily
                  ? `, evaluated against the declared ${familyLabel(blockedEvent.terminalDecisionFamily)} objective`
                  : ""}
                .
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-amber-900/60">
                Required action
              </dt>
              <dd className="mt-0.5">{requiredActionFor(status)}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-amber-900/60">
                Resume path
              </dt>
              <dd className="mt-0.5">
                Terminal states have no path back — that is deliberate (a block is never silently
                converted into success). The objective can be carried forward by a successor
                mission; this record stays readable as business history.
              </dd>
            </div>
          </dl>
        </div>
      ) : blocked ? (
        // Blocked status without a matching event should be impossible (the
        // state machine writes the event with every transition) — render the
        // honest fallback, never a fabricated reason.
        <div className="rounded-lg border border-amber-700/20 bg-amber-50 p-4">
          <p className="font-medium text-amber-900">{humanizeStatus(status)}</p>
          <p className="mt-1 text-sm leading-relaxed text-amber-900/80">
            {STATUS_MEANING[status] ?? "The mission ended in a blocked state."}
          </p>
          <p className="mt-1 text-sm leading-relaxed text-amber-900/70">
            The blocking transition&apos;s event is in the mission&apos;s history (Now / Next
            above) — the recorded reason and evidence live there.
          </p>
        </div>
      ) : (
        <WorkspaceEmptyState
          missing="No blockers are recorded for this mission."
          why="When something genuinely stops the work — an approval only a person can give, a capability that is missing, an exhausted budget — the mission records the block with its reason, and it appears here with the evidence and the path forward."
          next={`The mission is ${humanizeStatus(status).toLowerCase()} right now; ${
            STATUS_MEANING[status]?.toLowerCase() ?? ""
          }`}
        />
      )}
      <SourceLine sources={["GET /api/growth-missions/:missionId (mission.status, history)"]} />
    </WorkspaceSection>
  );
}

function requiredActionFor(status: string): string {
  switch (status) {
    case "blocked_pending_human_action":
      return "The human decision the mission waited for could not be made by the system. Review the recorded reason, decide outside MOS, and start a successor mission that reflects the decision.";
    case "blocked_by_unavailable_capability":
      return "Something the mission needed does not exist or was unavailable. A successor mission can retry once the capability exists.";
    case "budget_quota_exhausted":
      return "The budget or quota the mission was allowed to use ran out. Fund or re-quota, then carry the objective forward in a successor mission.";
    case "policy_constrained":
      return "Policy limits what this mission may do. Review the policy decision with the platform's administrators; a successor mission can proceed within the policy.";
    case "failed_after_bounded_recovery":
      return "Recovery was attempted within its bounds and failed. The recorded reason and history carry what happened; a successor mission starts clean.";
    default:
      return "Review the recorded reason in the mission's history.";
  }
}
