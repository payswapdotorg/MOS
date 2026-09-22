"use client";

// UX-001 — "Continue a mission" (the sixth outcome, rendered with live data
// through the console's existing API layer: useMosQuery → same-origin bridge).
// Read-only; zero authority state.
//   • No agency selected → honest gating state (blocker / evidence / required
//     action / resume path) — not an error.
//   • No missions → contract empty state with an explicit working action.
//   • Rows show status + short id + last-updated (the API has no name field);
//     expanding a row mounts a per-mission detail fetch (objective verbatim) —
//     no N+1 on first render, cached per mission by React Query (staleTime 15s).
//   • UX-003: the expanded panel carries a REAL OPEN action into the mission
//     workspace (SPA navigation, kind "mission") — the honest "arriving next"
//     note is retired here and lives on inside the workspace itself.

import { useState } from "react";
// SEAM S3 (one line) — hooks.ts location. If the tree has it elsewhere
// (e.g. "@/lib/hooks"), fix this import only.
import { useMosQuery } from "@/components/mos/hooks";
import {
  CONTINUE_MISSION,
  TODAY_OPERATIONS,
  useAgencyId,
  useNavigate,
} from "@/components/mos/home/outcomes";

type GrowthMissionSummary = {
  missionId: string;
  status?: string;
  currentVersionSeq?: number;
  createdAt?: string;
  updatedAt?: string;
};

type GrowthMissionsResponse = {
  agencyId?: string;
  missions?: GrowthMissionSummary[];
};

type MissionDetailResponse = {
  mission?: { status?: string } | null;
  currentVersion?: { objective?: string } | null;
  history?: unknown[]; // verified at the integration station: serializeDetail
                       // returns { mission, currentVersion, goalMappings,
                       // history, terminalDecisionBasis, vocabularyVersion }.
};

export default function MissionsSection() {
  const agencyId = useAgencyId();

  return (
    <section aria-labelledby="continue-mission-heading" className="flex flex-col gap-3">
      <h2 id="continue-mission-heading" className="text-lg font-semibold text-stone-800">
        {CONTINUE_MISSION.label}
      </h2>
      <p className="max-w-prose text-sm text-stone-600">{CONTINUE_MISSION.blurb}</p>
      {agencyId ? <MissionsList agencyId={agencyId} /> : <AgencyGatingState />}
    </section>
  );
}

function AgencyGatingState() {
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-6">
      <p className="font-medium text-stone-800">No agency is selected yet</p>
      <p className="mt-2 text-sm leading-relaxed text-stone-600">
        Missions are kept inside an agency, and none is selected for this session —
        so there is nothing to list here yet.
      </p>
      <p className="mt-2 text-sm leading-relaxed text-stone-600">
        Select your agency to continue. Everything else on this page works meanwhile,
        and this list fills in on its own once an agency is selected — no reload needed.
      </p>
      {/* SEAM S8 (optional, one line): if the tree's <AgencyGate /> is importable
          and suitable inline, it can replace this panel; the panel is the safe
          fallback that keeps this file compiling blind. */}
    </div>
  );
}

function MissionsList({ agencyId }: { agencyId: string }) {
  // SEAM S4 — assumes useMosQuery returns the standard TanStack Query result
  // object (isLoading / isError / data / refetch). If it narrows the result,
  // adjust only this component's query handling.
  const query = useMosQuery<GrowthMissionsResponse>(
    ["growth-missions", agencyId],
    `/api/agencies/${agencyId}/growth-missions`,
  );

  if (query.isLoading) {
    return (
      <div className="flex flex-col gap-2" aria-hidden="true">
        <div className="h-14 animate-pulse rounded-xl bg-stone-200/60" />
        <div className="h-14 animate-pulse rounded-xl bg-stone-200/60" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="rounded-xl border border-amber-700/20 bg-amber-50 p-5">
        <p className="font-medium text-amber-900">Missions couldn&apos;t be loaded just now.</p>
        <p className="mt-1 text-sm text-amber-900/80">
          Everything else on this page still works. You can retry, or go to Today / Operations.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void query.refetch()}
            className="inline-flex min-h-[44px] items-center rounded-lg border border-amber-700/30 bg-white px-4 text-sm font-medium text-amber-900 transition-colors hover:bg-amber-100 focus-visible:ring-2 focus-visible:ring-amber-700"
          >
            Try again
          </button>
          <OpenTodayOperationsButton />
        </div>
      </div>
    );
  }

  const missions = (query.data?.missions ?? [])
    .filter((mission) => Boolean(mission.missionId))
    .sort((a, b) =>
      (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? ""),
    );

  if (missions.length === 0) {
    return (
      <div className="rounded-xl border border-stone-200 bg-white p-6">
        <p className="font-medium text-stone-800">No missions yet</p>
        <p className="mt-2 text-sm leading-relaxed text-stone-600">
          A mission is guided, step-by-step work toward one of your outcomes — it keeps
          the work moving while you&apos;re away and always shows what happens next.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-stone-600">
          Starting one takes a minute: pick the outcome you want above, or start one here without
          picking first — you&apos;ll say what you want and what success looks like either way.
          It appears right here, and you can pick it up again any time.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <StartMissionButton />
          <OpenTodayOperationsButton />
        </div>
      </div>
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-stone-100 overflow-hidden rounded-xl border border-stone-200 bg-white">
      {missions.map((mission) => (
        <MissionRow key={mission.missionId} mission={mission} />
      ))}
    </ul>
  );
}

// Shared by the error and empty states. Deliberately duplicated from
// HomeScreen's Today / Operations entry (small, and it keeps the delivered
// file set exactly as directed: four components + the registry).
function OpenTodayOperationsButton() {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate(TODAY_OPERATIONS.view)}
      className="inline-flex min-h-[44px] items-center rounded-lg border border-teal-800/25 bg-white px-4 text-sm font-medium text-teal-900 transition-colors hover:bg-teal-50 focus-visible:ring-2 focus-visible:ring-teal-700"
    >
      {TODAY_OPERATIONS.label}
    </button>
  );
}

// UX-002 — the unseeded entry into the ONE reusable mission-creation flow
// (no family pre-selected; the outcome step asks for both words and kind).
function StartMissionButton() {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate({ kind: "create-mission" })}
      className="inline-flex min-h-[44px] items-center rounded-lg border border-teal-800/25 bg-white px-4 text-sm font-medium text-teal-900 transition-colors hover:bg-teal-50 focus-visible:ring-2 focus-visible:ring-teal-700"
    >
      Start a mission
    </button>
  );
}

function MissionRow({ mission }: { mission: GrowthMissionSummary }) {
  const [open, setOpen] = useState(false);
  const dateLabel = mission.updatedAt ? formatDate(mission.updatedAt) : "";

  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`mission-detail-${mission.missionId}`}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-[56px] w-full items-center justify-between gap-4 px-5 py-3 text-left transition-colors hover:bg-stone-100/50 focus-visible:ring-2 focus-visible:ring-teal-700"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-stone-800">
            Mission {shortMissionId(mission.missionId)}
          </span>
          {dateLabel ? (
            <span className="block text-xs text-stone-500">Updated {dateLabel}</span>
          ) : null}
        </span>
        {mission.status ? <StatusChip status={mission.status} /> : null}
        <span aria-hidden="true" className="shrink-0 text-stone-400">{open ? "↑" : "→"}</span>
      </button>
      {open ? (
        <div
          id={`mission-detail-${mission.missionId}`}
          className="border-t border-stone-100 bg-stone-50/60 px-5 py-4"
        >
          <MissionDetail missionId={mission.missionId} fallbackStatus={mission.status} />
        </div>
      ) : null}
    </li>
  );
}

function MissionDetail({
  missionId,
  fallbackStatus,
}: {
  missionId: string;
  fallbackStatus?: string;
}) {
  const query = useMosQuery<MissionDetailResponse>(
    ["growth-mission", missionId],
    `/api/growth-missions/${missionId}`,
  );
  const navigate = useNavigate();

  if (query.isLoading) {
    return (
      <div className="flex flex-col gap-2" aria-hidden="true">
        <div className="h-4 w-3/4 animate-pulse rounded bg-stone-200/70" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-stone-200/70" />
      </div>
    );
  }

  const status = query.data?.mission?.status ?? fallbackStatus;
  const objective = query.data?.currentVersion?.objective?.trim();
  const history = query.data?.history;
  const historyCount = Array.isArray(history) ? history.length : null;

  return (
    <div className="flex flex-col items-start gap-2">
      {status ? <StatusChip status={status} /> : null}
      {objective ? (
        <p className="max-w-prose text-sm leading-relaxed text-stone-700">{objective}</p>
      ) : query.isError ? (
        <>
          <p className="text-sm text-amber-900">
            This mission&apos;s details couldn&apos;t be loaded just now.
          </p>
          <button
            type="button"
            onClick={() => void query.refetch()}
            className="inline-flex min-h-[44px] items-center rounded-lg border border-amber-700/30 bg-white px-3 text-sm font-medium text-amber-900 transition-colors hover:bg-amber-100 focus-visible:ring-2 focus-visible:ring-amber-700"
          >
            Try again
          </button>
        </>
      ) : (
        <p className="text-sm text-stone-500">
          Details for this mission aren&apos;t available yet.
        </p>
      )}
      {historyCount !== null ? (
        <p className="text-xs text-stone-500">
          {historyCount} recorded update{historyCount === 1 ? "" : "s"} so far.
        </p>
      ) : null}
      <button
        type="button"
        onClick={() => navigate({ kind: "mission", missionId })}
        className="mt-1 inline-flex min-h-[44px] items-center rounded-lg border border-teal-800/25 bg-white px-4 text-sm font-medium text-teal-900 transition-colors hover:bg-teal-50 focus-visible:ring-2 focus-visible:ring-teal-700"
      >
        Open the mission workspace →
      </button>
    </div>
  );
}

// Real status vocabulary (MKT-053): draft | active | paused | stopped_by_user
// | terminal states. Coloring stays honest: teal = actively running, amber =
// paused. Everything else — draft, stopped by the user, terminal, unknown —
// renders in calm graphite with the status shown as-is (humanized). Red is
// reserved for an explicit failure status, which this vocabulary does not
// expose; if one exists, it is a single new entry in STATUS_STYLES.
const STATUS_STYLES: Record<string, string> = {
  active: "border-teal-800/20 bg-teal-50 text-teal-900",
  paused: "border-amber-700/20 bg-amber-50 text-amber-900",
};

function StatusChip({ status }: { status: string }) {
  const cls = STATUS_STYLES[status.toLowerCase()] ?? "border-stone-300 bg-stone-100 text-stone-700";
  return (
    <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium ${cls}`}>
      {humanizeStatus(status)}
    </span>
  );
}

function humanizeStatus(status: string): string {
  const text = status.replace(/_/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function shortMissionId(id: string): string {
  return id.length <= 10 ? id : `${id.slice(0, 8)}…`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
