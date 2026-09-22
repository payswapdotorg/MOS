"use client";

// UX-003 — the LIFECYCLE action: the explicit, deliberate mission status
// transition through the REAL contract (POST /api/growth-missions/:missionId/
// status — REQUIRED reason; owner|admin; CAS on the mission's live version).
//
// Binding rules honored here:
//   • NEVER auto-activate — this panel only acts on an explicit operator
//     click with a typed reason;
//   • the offered transitions mirror the frozen table VERBATIM (the server
//     re-validates — a 409 renders its own words inline);
//   • activation/resumption requires ≥1 mapped goal (the frozen server rule,
//     mirrored client-side as a hint — the server stays the authority);
//   • terminal states have NO outgoing transitions — the honest disclosure,
//     never a hidden path back.

import * as React from "react";
import { useSetGrowthMissionStatus } from "@/components/mos/hooks";
import { MosApiError, type GrowthMissionDetailView } from "@/lib/mos-api";
import {
  SourceLine,
  WorkspaceActionButton,
  formatWhen,
} from "./workspace-atoms";
import {
  TONE_CHIP_CLASSES,
  humanizeStatus,
  isTerminalMissionStatus,
  legalSuccessors,
  statusTone,
} from "./status";

const REASON_LIMIT = 2000;

/** A plain action label per successor status (the common path reads first). */
function transitionLabel(currentStatus: string, successor: string): string {
  if (successor === "active") {
    return currentStatus === "paused" ? "Resume the mission" : "Activate the mission";
  }
  switch (successor) {
    case "paused":
      return "Pause the mission";
    case "achieved":
      return "Record achieved";
    case "stopped_by_user":
      return "Stop the mission";
    case "blocked_pending_human_action":
      return "Record blocked — pending human action";
    case "blocked_by_unavailable_capability":
      return "Record blocked — unavailable capability";
    case "budget_quota_exhausted":
      return "Record budget or quota exhausted";
    case "policy_constrained":
      return "Record policy-constrained";
    case "failed_after_bounded_recovery":
      return "Record failed after bounded recovery";
    default:
      return `Move to ${humanizeStatus(successor)}`;
  }
}

export function LifecyclePanel({ detail }: { detail: GrowthMissionDetailView }) {
  const status = detail.mission.status;
  const missionId = detail.mission.missionId;
  const mutation = useSetGrowthMissionStatus(missionId);

  if (isTerminalMissionStatus(status)) {
    return (
      <div className="rounded-xl border border-stone-200 bg-white p-5">
        <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">Lifecycle</p>
        <p className="mt-1 font-medium text-stone-800">
          This mission is {humanizeStatus(status).toLowerCase()} — terminal
        </p>
        <p className="mt-1.5 text-sm leading-relaxed text-stone-600">
          Terminal states have no path back — that is deliberate. The record and its full history
          stay readable, and the objective can be carried forward by a new mission. No transition
          can be recorded here.
        </p>
        <p className="mt-2 text-xs text-stone-500">
          Version {detail.mission.currentVersionSeq} of the declared content · mission record
          version {detail.mission.version} · updated {formatWhen(detail.mission.updatedAt) || "—"}
        </p>
      </div>
    );
  }

  const successors = legalSuccessors(status);
  const activeMappingCount = detail.goalMappings.filter((m) => m.removedAt === null).length;

  return (
    <LifecycleForm
      detail={detail}
      successors={successors}
      activeMappingCount={activeMappingCount}
      mutation={mutation}
    />
  );
}

function LifecycleForm({
  detail,
  successors,
  activeMappingCount,
  mutation,
}: {
  detail: GrowthMissionDetailView;
  successors: string[];
  activeMappingCount: number;
  mutation: ReturnType<typeof useSetGrowthMissionStatus>;
}) {
  const status = detail.mission.status;
  const [selected, setSelected] = React.useState<string | null>(
    status === "draft" ? (successors[0] ?? null) : null,
  );
  const [reason, setReason] = React.useState("");
  const [confirmed, setConfirmed] = React.useState(false);

  const reasonTrimmed = reason.trim();
  const reasonTooLong = reason.length > REASON_LIMIT;
  const reasonReady = reasonTrimmed !== "" && !reasonTooLong;
  const needsGoal = selected === "active" && activeMappingCount === 0;
  const canSubmit = selected !== null && reasonReady && !needsGoal && !mutation.isPending;

  const submit = () => {
    if (selected === null || !reasonReady) return;
    // CAS: the version sent is the LIVE mission record version from this
    // fetch — the server rejects a stale one with its own words (409).
    mutation.mutate({
      status: selected,
      reason: reasonTrimmed,
      version: detail.mission.version,
    });
    setConfirmed(false);
  };

  return (
    <div className="rounded-xl border border-stone-200 bg-white p-5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">Lifecycle</p>
      <p className="mt-1 flex flex-wrap items-center gap-2 font-medium text-stone-800">
        <span
          className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
            TONE_CHIP_CLASSES[statusTone(status)]
          }`}
        >
          {humanizeStatus(status)}
        </span>
        <span className="text-sm font-normal text-stone-500">
          · version {detail.mission.currentVersionSeq} of the declared content · updated{" "}
          {formatWhen(detail.mission.updatedAt) || "—"}
        </span>
      </p>

      {successors.length === 0 ? (
        <p className="mt-3 text-sm leading-relaxed text-stone-600">
          No transitions are available from this state.
        </p>
      ) : (
        <form
          className="mt-4 flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (confirmed) {
              submit();
            } else {
              setConfirmed(true);
            }
          }}
        >
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-stone-600">Transition</span>
            <div className="flex flex-wrap gap-2">
              {successors.map((successor) => {
                const isSelected = selected === successor;
                return (
                  <button
                    key={successor}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => {
                      setSelected(successor);
                      setConfirmed(false);
                    }}
                    className={`inline-flex min-h-[44px] items-center rounded-lg border px-4 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-teal-700 ${
                      isSelected
                        ? "border-teal-700/40 bg-teal-50 text-teal-900"
                        : "border-stone-300 bg-white text-stone-700 hover:bg-stone-100"
                    }`}
                  >
                    {transitionLabel(status, successor)}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="mission-transition-reason" className="text-xs font-medium text-stone-600">
              Reason <span className="text-stone-400">(required — recorded in the mission&apos;s history)</span>
            </label>
            <textarea
              id="mission-transition-reason"
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                setConfirmed(false);
              }}
              rows={3}
              maxLength={REASON_LIMIT}
              placeholder={
                selected === "active"
                  ? "e.g. The goal is mapped and the target is set — begin the pursuit."
                  : "Say why this transition is being made, in your own words."
              }
              className="w-full resize-y rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm leading-relaxed text-stone-800 placeholder:text-stone-400 focus-visible:ring-2 focus-visible:ring-teal-700"
            />
            {reasonTrimmed === "" ? (
              <p className="text-xs text-stone-400">A reason is required — every transition is recorded with it.</p>
            ) : null}
            {reasonTooLong ? (
              <p className="text-xs text-red-900">
                The reason is over the {REASON_LIMIT}-character limit (currently {reason.length}).
              </p>
            ) : null}
          </div>

          {needsGoal ? (
            <p className="rounded-lg border border-amber-700/20 bg-amber-50 p-3 text-sm leading-relaxed text-amber-900/90">
              Activating (or resuming) requires at least one mapped goal — this mission has none
              yet. Map a goal in the Progress section first; the server enforces the same rule.
            </p>
          ) : null}

          {mutation.isError ? (
            <div className="rounded-lg border border-red-800/20 bg-red-50 p-3" role="alert">
              <p className="text-sm font-medium text-red-900">
                The transition was refused by the server.
              </p>
              {mutation.error instanceof MosApiError ? (
                <>
                  <p className="mt-1 break-words text-sm leading-relaxed text-red-900/80">
                    {mutation.error.status} · {mutation.error.code} — {mutation.error.message}
                  </p>
                  {mutation.error.details.length > 0 ? (
                    <ul className="mt-1 list-disc pl-5 text-xs leading-relaxed text-red-900/80">
                      {mutation.error.details.map((detail) => (
                        <li key={detail} className="break-words">
                          {detail}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              ) : (
                <p className="mt-1 break-words text-sm leading-relaxed text-red-900/80">
                  {mutation.error instanceof Error ? mutation.error.message : String(mutation.error)}
                </p>
              )}
              <p className="mt-1 text-xs leading-relaxed text-red-900/70">
                Nothing changed — the mission is exactly as it was. If the version moved (someone
                else transitioned it first), the fresh state above is current; try again from it.
              </p>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            {confirmed && canSubmit ? (
              <>
                <WorkspaceActionButton type="submit" disabled={mutation.isPending}>
                  {mutation.isPending ? "Recording…" : `Yes — record it (${humanizeStatus(selected ?? "")})`}
                </WorkspaceActionButton>
                <WorkspaceActionButton
                  tone="plain"
                  type="button"
                  onClick={() => setConfirmed(false)}
                >
                  Let me reconsider
                </WorkspaceActionButton>
              </>
            ) : (
              <WorkspaceActionButton type="submit" disabled={!canSubmit}>
                {mutation.isPending ? "Recording…" : "Record the transition"}
              </WorkspaceActionButton>
            )}
          </div>

          <p className="text-xs leading-relaxed text-stone-500">
            This action is deliberate: it never happens automatically, and activating a mission is
            never done for you. The reason is recorded permanently in the mission&apos;s history
            with your identity.
          </p>
        </form>
      )}
      <SourceLine sources={["POST /api/growth-missions/:missionId/status (reason + CAS version)"]} />
    </div>
  );
}
