// UX-003 — the frozen growth-mission lifecycle vocabulary, mirrored VERBATIM
// from the platform contract (src/modules/growth-missions/public.ts
// GROWTH_MISSION_STATUSES / GROWTH_MISSION_TERMINAL_STATUSES /
// GROWTH_MISSION_TRANSITIONS — gm-vocab-v1). The console may present friendly
// labels and calm tones, but the values it SENDS are these exact strings and
// the offered transitions are exactly the frozen table's rows — nothing here
// may drift from the backend vocabulary.

/** The frozen mission status vocabulary (gm-vocab-v1), verbatim. */
export const MISSION_STATUSES = [
  "draft",
  "active",
  "paused",
  "achieved",
  "stopped_by_user",
  "blocked_pending_human_action",
  "blocked_by_unavailable_capability",
  "budget_quota_exhausted",
  "policy_constrained",
  "failed_after_bounded_recovery",
] as const;

export type MissionStatus = (typeof MISSION_STATUSES)[number];

export function isMissionStatus(value: string): value is MissionStatus {
  return (MISSION_STATUSES as readonly string[]).includes(value);
}

/** The frozen terminal-state list (architecture §2, verbatim) — terminal
 *  states have NO outgoing transitions: the honest-state rule. */
export const TERMINAL_STATUSES: readonly MissionStatus[] = [
  "achieved",
  "stopped_by_user",
  "blocked_pending_human_action",
  "blocked_by_unavailable_capability",
  "budget_quota_exhausted",
  "policy_constrained",
  "failed_after_bounded_recovery",
];

export function isTerminalMissionStatus(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** The frozen transition table, verbatim (the server re-validates legality;
 *  this mirror only decides which transitions the workspace may OFFER). */
export const MISSION_TRANSITIONS: Readonly<Record<MissionStatus, readonly MissionStatus[]>> = {
  draft: ["active", "stopped_by_user"],
  active: [
    "paused",
    "achieved",
    "stopped_by_user",
    "blocked_pending_human_action",
    "blocked_by_unavailable_capability",
    "budget_quota_exhausted",
    "policy_constrained",
    "failed_after_bounded_recovery",
  ],
  paused: ["active", "stopped_by_user"],
  achieved: [],
  stopped_by_user: [],
  blocked_pending_human_action: [],
  blocked_by_unavailable_capability: [],
  budget_quota_exhausted: [],
  policy_constrained: [],
  failed_after_bounded_recovery: [],
};

/** Legal successor statuses OFFERED for a current status (the server remains
 *  the authority — it re-validates the same table on every POST). */
export function legalSuccessors(status: string): MissionStatus[] {
  return isMissionStatus(status) ? [...MISSION_TRANSITIONS[status]] : [];
}

// --- Presentation (labels + the WORKER-CONTRACT visual language) ---------------
//
// calm warm-light surface, soft graphite text, restrained teal/green healthy,
// amber warning, red failure. Draft/stopped are honest graphite; the blocked
// family is amber (attention wanted, not failure); only the
// failed-after-bounded-recovery state is red (true failure).

export type StatusTone = "healthy" | "warning" | "failure" | "neutral";

export function statusTone(status: string): StatusTone {
  switch (status) {
    case "active":
    case "achieved":
      return "healthy";
    case "paused":
    case "blocked_pending_human_action":
    case "blocked_by_unavailable_capability":
    case "budget_quota_exhausted":
    case "policy_constrained":
      return "warning";
    case "failed_after_bounded_recovery":
      return "failure";
    default:
      return "neutral";
  }
}

/** Chip classes per tone (the house style used across UX-001/002). */
export const TONE_CHIP_CLASSES: Record<StatusTone, string> = {
  healthy: "border-teal-800/20 bg-teal-50 text-teal-900",
  warning: "border-amber-700/20 bg-amber-50 text-amber-900",
  failure: "border-red-800/20 bg-red-50 text-red-900",
  neutral: "border-stone-300 bg-stone-100 text-stone-700",
};

/** Human label: the frozen value, underscore-separated words capitalized. */
export function humanizeStatus(status: string): string {
  const text = status.replace(/_/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** One plain-language sentence per status — what the state MEANS (no jargon,
 *  no invented state). Used by the now / next and blockers sections. */
export const STATUS_MEANING: Record<string, string> = {
  draft: "Declared and saved, but not pursuing anything yet — nothing runs until it is activated.",
  active: "Being pursued — the mission's work is composed and advancing through its goals.",
  paused: "Deliberately paused by someone — it holds its place and can be resumed.",
  achieved: "Finished: the declared objective was reached. This is business history now.",
  stopped_by_user: "Stopped by a person. The record and its full history stay readable.",
  blocked_pending_human_action: "Ended blocked: an approval or human decision the system cannot make itself was required.",
  blocked_by_unavailable_capability: "Ended blocked: something the mission needed does not exist or was unavailable.",
  budget_quota_exhausted: "Ended blocked: the budget or quota it was allowed to use ran out.",
  policy_constrained: "Ended blocked: policy limits what the mission may do.",
  failed_after_bounded_recovery: "Ended in failure after every bounded recovery attempt was exhausted.",
};

/** The status's own blocked-family marker (the blockers section's basis). */
export function isBlockedStatus(status: string): boolean {
  return (
    status === "blocked_pending_human_action" ||
    status === "blocked_by_unavailable_capability" ||
    status === "budget_quota_exhausted" ||
    status === "policy_constrained" ||
    status === "failed_after_bounded_recovery"
  );
}

/** A short mission id for titles (the API has no name field). */
export function shortMissionId(id: string): string {
  return id.length <= 10 ? id : `${id.slice(0, 8)}…`;
}
