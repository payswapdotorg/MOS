"use client";

// UX-005 — the Connections Center's shared presentation atoms: the card
// shell, the connection-state chips, the permission-health display, the
// honest pending-round panel (the OAuth round IS recorded; completion needs
// the provider's callback — NEVER a fake success), the confirm-gate dialog
// (the UX-003 destructive-action precedent) and the drill-down disclosure.
// Presentation ONLY — zero authority state, no fabricated data, no raw JSON.

import * as React from "react";
import { ChevronDown, ExternalLink, ShieldAlert } from "lucide-react";
import {
  Chip,
  LabeledRows,
  SectionSkeleton,
  WorkspaceActionButton,
  formatWhen,
} from "@/components/mos/mission/workspace-atoms";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// --- The connection-state chips ---------------------------------------------------

/** Social binding statuses (MKT-055): connected | disconnected | revoked. */
export function SocialStatusChip({ status }: { status: string }) {
  const cls =
    status === "connected"
      ? "border-teal-800/20 bg-teal-50 text-teal-900"
      : status === "revoked"
        ? "border-red-800/20 bg-red-50 text-red-900"
        : "border-amber-700/20 bg-amber-50 text-amber-900";
  return <Chip label={status.replace(/_/g, " ")} className={cls} />;
}

/** Grant states (MKT-055): pending | authorized | expired | revoked |
 *  refreshed | superseded — historical states render visibly historical. */
export function GrantStateChip({ state }: { state: string }) {
  const historical = state === "refreshed" || state === "superseded";
  const cls =
    state === "authorized"
      ? "border-teal-800/20 bg-teal-50 text-teal-900"
      : state === "expired"
        ? "border-amber-700/20 bg-amber-50 text-amber-900"
        : state === "revoked"
          ? "border-red-800/20 bg-red-50 text-red-900"
          : state === "pending"
            ? "border-stone-300 bg-stone-100 text-stone-600"
            : historical
              ? "border-stone-200 bg-stone-50 text-stone-400"
              : "border-stone-300 bg-stone-100 text-stone-700";
  return (
    <Chip
      label={historical ? `${state.replace(/_/g, " ")} · history` : state.replace(/_/g, " ")}
      className={cls}
    />
  );
}

/** Integration connection statuses (MKT-023) with health. */
export function IntegrationStatusChip({
  status,
  health,
}: {
  status: string;
  health: string;
}) {
  const cls =
    status === "connected" && health === "healthy"
      ? "border-teal-800/20 bg-teal-50 text-teal-900"
      : status === "suspended"
        ? "border-amber-700/20 bg-amber-50 text-amber-900"
        : status === "error" || health === "unreachable"
          ? "border-red-800/20 bg-red-50 text-red-900"
          : "border-stone-300 bg-stone-100 text-stone-700";
  return <Chip label={`${status} · ${health}`} className={cls} />;
}

// --- The card shell ----------------------------------------------------------------

/**
 * One connection card: the operational first screen (provider, identity,
 * state, next action) with a drill-down disclosure for the authorization
 * history — the center is operational, not diagnostic. Touch-friendly,
 * keyboard accessible, aria-wired (the UX-003 section precedent).
 */
export function ConnectionCard({
  id,
  children,
  detail,
  defaultOpen = false,
}: {
  id: string;
  children: React.ReactNode;
  detail: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <li id={id} className="overflow-hidden rounded-xl border border-stone-200 bg-white">
      <div className="px-5 py-4">{children}</div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-detail`}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-[44px] w-full items-center justify-between gap-3 border-t border-stone-100 px-5 py-2.5 text-left transition-colors hover:bg-stone-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-700"
      >
        <span className="text-xs font-medium text-stone-500">
          Authorization history, permissions and provider limitations
        </span>
        <ChevronDown
          aria-hidden="true"
          className={`size-4 shrink-0 text-stone-400 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open ? (
        <div id={`${id}-detail`} className="border-t border-stone-100 bg-stone-50/40 px-5 py-4">
          {detail}
        </div>
      ) : null}
    </li>
  );
}

// --- The permission-health display ---------------------------------------------------

/**
 * The permission health: required (the intent the round requested) vs
 * granted (the provider's verbatim answer) — BOTH from the real grant
 * records. A scope the provider granted beyond the request is shown too;
 * a requested-but-not-granted scope renders as the honest gap (never a
 * green checkmark).
 */
export function ScopeHealth({
  requested,
  granted,
}: {
  requested: string[] | undefined;
  granted: string[] | undefined;
}) {
  const wanted = requested ?? [];
  const have = granted ?? [];
  if (wanted.length === 0 && have.length === 0) {
    return (
      <p className="text-xs leading-relaxed text-stone-500">
        No scope facts recorded on this grant yet — scopes are recorded when the
        provider answers the authorization round.
      </p>
    );
  }
  const missing = wanted.filter((scope) => !have.includes(scope));
  const extra = have.filter((scope) => !wanted.includes(scope));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
          Granted
        </span>
        {have.length === 0 ? (
          <span className="text-xs text-stone-500">none recorded</span>
        ) : (
          have.map((scope) => (
            <Chip key={scope} label={scope} className="border-teal-800/20 bg-teal-50 text-teal-900" />
          ))
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
          Requested
        </span>
        {wanted.length === 0 ? (
          <span className="text-xs text-stone-500">none recorded</span>
        ) : (
          wanted.map((scope) => (
            <Chip
              key={scope}
              label={scope}
              className={missing.includes(scope) ? "border-amber-700/25 bg-amber-50 text-amber-900" : "border-stone-200 bg-stone-50 text-stone-600"}
            />
          ))
        )}
      </div>
      {missing.length > 0 ? (
        <p className="text-xs leading-relaxed text-amber-900">
          Permission gap — requested but not granted by the provider:{" "}
          {missing.join(", ")}. Operations needing these scopes refuse fail-closed.
        </p>
      ) : null}
      {extra.length > 0 ? (
        <p className="text-xs leading-relaxed text-stone-500">
          The provider also granted: {extra.join(", ")} (recorded verbatim).
        </p>
      ) : null}
    </div>
  );
}

// --- The honest pending-round panel ----------------------------------------------------

/**
 * The pending OAuth round: authorize-start succeeded (201) — the round IS
 * recorded as a PENDING grant with its authorizeUrl. Completing it needs
 * the PROVIDER's callback (the login at the authorize URL, then the code
 * exchange) — this panel NEVER claims success, and offers the honest
 * re-check action (the UI re-reads the real state).
 */
export function PendingRoundPanel({
  round,
  onRecheck,
  rechecking,
}: {
  round: {
    authorizationId: string;
    state: string;
    authorizeUrl: string;
    grantState: string;
  };
  onRecheck: () => void;
  rechecking: boolean;
}) {
  return (
    <div role="status" className="rounded-xl border border-amber-700/20 bg-amber-50/70 p-4">
      <p className="text-sm font-medium text-amber-900">
        Authorization round started — awaiting the provider
      </p>
      <p className="mt-1.5 text-sm leading-relaxed text-amber-900/80">
        The round is recorded (grant{" "}
        <span className="font-mono text-xs">{round.grantState}</span>, authorization id{" "}
        <span className="font-mono text-xs">{round.authorizationId.slice(0, 8)}…</span>). Completing
        it needs the provider&apos;s callback: the account owner signs in at the authorize URL
        below, and the provider redirects back with the authorization code — MOS records the
        binding when that callback lands. This panel never shows a connected state before that
        happens.
      </p>
      <a
        href={round.authorizeUrl}
        target="_blank"
        rel="noreferrer"
        className="mt-2 inline-flex min-h-[44px] items-center gap-1.5 break-all rounded-lg border border-amber-700/30 bg-white px-3 text-sm font-medium text-amber-900 transition-colors hover:bg-amber-100 focus-visible:ring-2 focus-visible:ring-amber-700"
      >
        <ExternalLink className="size-4 shrink-0" aria-hidden="true" />
        <span className="break-all">Open the provider&apos;s authorize URL</span>
      </a>
      <p className="mt-2 break-all font-mono text-[11px] leading-relaxed text-amber-900/60">
        {round.authorizeUrl}
      </p>
      <div className="mt-3">
        <WorkspaceActionButton tone="amber" onClick={onRecheck} disabled={rechecking}>
          {rechecking ? "Checking…" : "Check for the completed connection"}
        </WorkspaceActionButton>
      </div>
    </div>
  );
}

// --- The confirm gate (destructive actions) ----------------------------------------------

/**
 * The confirm-gate dialog for destructive/irreversible connection actions
 * (the UX-003 terminal-decision precedent): names the exact action, the
 * consequence, an optional reason input, and requires an explicit confirm.
 */
export function ConfirmGate({
  open,
  onOpenChange,
  title,
  consequence,
  confirmLabel,
  confirmTone = "destructive",
  busy = false,
  showReason = false,
  reason,
  onReasonChange,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  consequence: string;
  confirmLabel: string;
  confirmTone?: "destructive" | "default";
  busy?: boolean;
  showReason?: boolean;
  reason?: string;
  onReasonChange?: (value: string) => void;
  onConfirm: () => void;
  children?: React.ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="size-5 shrink-0 text-amber-700" aria-hidden="true" />
            {title}
          </DialogTitle>
          <DialogDescription className="text-left leading-relaxed">
            {consequence}
          </DialogDescription>
        </DialogHeader>
        {children}
        {showReason ? (
          <div className="mt-2">
            <label
              htmlFor="confirm-gate-reason"
              className="text-xs font-medium uppercase tracking-wide text-stone-500"
            >
              Reason (recorded on the append-only event tail)
            </label>
            <input
              id="confirm-gate-reason"
              type="text"
              value={reason ?? ""}
              onChange={(event) => onReasonChange?.(event.target.value)}
              placeholder="optional, max 2000 characters"
              className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-800 placeholder:text-stone-400 focus-visible:ring-2 focus-visible:ring-teal-700"
            />
          </div>
        ) : null}
        <DialogFooter className="mt-2 gap-2">
          <WorkspaceActionButton tone="plain" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </WorkspaceActionButton>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`inline-flex min-h-[44px] items-center rounded-lg border px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              confirmTone === "destructive"
                ? "border-red-800/30 bg-red-50 text-red-900 hover:bg-red-100 focus-visible:ring-2 focus-visible:ring-red-700"
                : "border-teal-800/25 bg-white text-teal-900 hover:bg-teal-50 focus-visible:ring-2 focus-visible:ring-teal-700"
            }`}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- The honest route-error line (server words verbatim) -----------------------------------

/** A mutation refusal rendered verbatim (the server's own words, never
 *  reworded into a fake success) — e.g. the fail-closed 409 of the empty
 *  flow registry on a standalone deployment. */
export function RouteRefusalNote({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-amber-700/20 bg-amber-50 p-3">
      <p className="text-xs font-medium text-amber-900">The platform refused this action:</p>
      <p className="mt-1 break-words text-sm leading-relaxed text-amber-900/80">{message}</p>
    </div>
  );
}

/** The evidence-grade provenance block for drill-downs (grant/event tails). */
export function ProvenanceRows({ record }: { record: Record<string, unknown> }) {
  const entries = Object.entries(record).filter(([key]) =>
    ["actor", "recordedVia", "correlationId", "causationId", "recordedAt"].includes(key),
  );
  if (entries.length === 0) return null;
  return <LabeledRows record={Object.fromEntries(entries)} label="Provenance" />;
}

export { SectionSkeleton, formatWhen };
