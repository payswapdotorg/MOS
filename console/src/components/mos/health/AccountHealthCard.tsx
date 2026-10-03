"use client";

// UX-007 — the per-account health card: the descriptive state badge (the
// frozen NINE at its honest weight), the confidence tier + the authority's
// own uncertainty statement, the closed reason codes, the evidence-basis
// drill-down (WHICH observable records produced the verdict — the
// per-constituent entries + the FK-anchored citations), the compliant §11
// maneuver recommendations AS DATA, and the run-evaluation action (the REAL
// POST route, owner|admin gated in the UI with the honest permission state
// for non-owners). Composed ONLY from the MKT-066 evaluation records:
//
//   GET  /api/clients/:clientId/platform-health                                     the client's evaluations (grouped per account by this surface)
//   GET  /api/platform-health/evaluations/:evaluationId                             one evaluation + the FK-anchored citations (on expand)
//   POST /api/clients/:clientId/platform-health/accounts/:socialAccountId/evaluations   run the evaluation (owner|admin, empty body)
//
// plus the MKT-055 account facts (provider, identity, live connection
// status) and the adapter registry label — the same composition the
// Connections Center card uses. Zero new authorities; nothing here invents
// health state, and no shadow-ban synonym is ever rendered.

import * as React from "react";
import { ArrowRight, Play } from "lucide-react";
import {
  usePlatformHealthEvaluationDetail,
  useRunPlatformHealthEvaluation,
} from "@/components/mos/hooks";
import type {
  PlatformHealthEvaluationView,
  RegisteredAdapterView,
  SocialAccountView,
} from "@/lib/mos-api";
import { useMosSession } from "@/components/mos/session-store";
import {
  SectionSkeleton,
  WorkspaceActionButton,
  formatWhen,
} from "@/components/mos/mission/workspace-atoms";
import { SourceRefList } from "@/components/mos/shared";
import {
  ConnectionCard,
  RouteRefusalNote,
  SocialStatusChip,
} from "@/components/mos/connections/connections-atoms";
import { SectionErrorViewInline } from "@/components/mos/connections/SocialConnections";
import {
  BaselineSummaries,
  BlockHeading,
  CitationHint,
  ConfidenceChip,
  EvidenceBasisList,
  EvaluationSummaryRow,
  HealthStateChip,
  HealthStateQualifier,
  ManeuverList,
  ReasonCodeChips,
  StateGlanceIcon,
  UncertaintyStatement,
} from "./health-atoms";

/** The permission affordance the Health tab resolves once and passes down
 *  (the server stays the authority — this is the honest UI state). */
export type HealthRunPermission = {
  status: "checking" | "allowed" | "forbidden";
  role: string | null;
};

// --- The FK-anchored evidence citations (fetched live, on expand) -----------------

/**
 * The citation links behind one verdict — the /evidence records, /metrics
 * observations and 056 publish attempts the evaluation consumed, in
 * citation order, resolved through the single-evaluation read (the
 * expand→fetch house pattern — never a bulk prefetch).
 */
function EvaluationCitations({ evaluationId }: { evaluationId: string }) {
  const detail = usePlatformHealthEvaluationDetail(evaluationId);
  if (detail.isPending) {
    return <SectionSkeleton rows={2} />;
  }
  if (detail.isError) {
    return (
      <SectionErrorViewInline
        error={detail.error}
        what="the evaluation's citation links"
        onRetry={() => void detail.refetch()}
      />
    );
  }
  const data = detail.data;
  return (
    <div className="space-y-2">
      <CitationHint />
      <div>
        <p className="text-xs leading-relaxed text-stone-600">
          Evidence anchors — the /evidence records backing the consumed
          observations ({data.evidenceIds.length})
        </p>
        <SourceRefList refs={data.evidenceIds.map((id) => ({ kind: "evidence", id }))} />
      </div>
      <div>
        <p className="text-xs leading-relaxed text-stone-600">
          Metric observations consumed by the evaluation
          {" "}
          ({data.metricObservationIds.length})
        </p>
        <SourceRefList refs={data.metricObservationIds.map((id) => ({ kind: "metrics.obs", id }))} />
      </div>
      <div>
        <p className="text-xs leading-relaxed text-stone-600">
          Publish attempts behind the verdict — the 056 invocation ledger
          {" "}
          ({data.publishAttemptIds.length})
        </p>
        <SourceRefList refs={data.publishAttemptIds.map((id) => ({ kind: "publish.attempt", id }))} />
      </div>
    </div>
  );
}

// --- One evaluation's full picture (the latest or an expanded tail row) -----------

function EvaluationPicture({ evaluation }: { evaluation: PlatformHealthEvaluationView }) {
  return (
    <div className="space-y-3">
      <EvaluationSummaryRow evaluation={evaluation} />
      <HealthStateQualifier state={evaluation.state} />
      <UncertaintyStatement uncertainty={evaluation.uncertainty} />
      <div>
        <BlockHeading>Reason codes — the closed vocabulary, as recorded</BlockHeading>
        <div className="mt-1.5">
          <ReasonCodeChips reasonCodes={evaluation.reasonCodes} />
        </div>
      </div>
      <div>
        <BlockHeading>Compliant next actions — the §11 maneuver list, as data</BlockHeading>
        <div className="mt-1.5">
          <ManeuverList recommendations={evaluation.recommendations} />
        </div>
      </div>
      <div>
        <BlockHeading>Evidence basis — which observable records produced the verdict</BlockHeading>
        <div className="mt-1.5">
          <EvidenceBasisList basis={evaluation.evidenceBasis} />
        </div>
      </div>
      <div>
        <BlockHeading>Evidence citations — the FK-anchored links behind the verdict</BlockHeading>
        <div className="mt-1.5">
          <EvaluationCitations evaluationId={evaluation.evaluationId} />
        </div>
      </div>
      <div>
        <BlockHeading>Baseline summaries — the {evaluation.baselineVersion} disclosure</BlockHeading>
        <div className="mt-1.5">
          <BaselineSummaries baseline={evaluation.baseline} />
        </div>
      </div>
      <div>
        <BlockHeading>Signals considered — the composition disclosure</BlockHeading>
        <div className="mt-1.5">
          <SignalsConsideredRecord evaluation={evaluation} />
        </div>
      </div>
      <EvaluationMeta evaluation={evaluation} />
    </div>
  );
}

/** The signals-considered disclosure as formatted labeled rows — every key
 *  visible, never a raw JSON dump. */
function SignalsConsideredRecord({ evaluation }: { evaluation: PlatformHealthEvaluationView }) {
  const entries = Object.entries(evaluation.signalsConsidered);
  if (entries.length === 0) {
    return (
      <p className="text-sm leading-relaxed text-stone-600">
        No composition disclosure recorded on this evaluation.
      </p>
    );
  }
  return (
    <dl className="flex flex-col gap-1">
      {entries.map(([key, value]) => (
        <div key={key} className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <dt className="shrink-0 font-mono text-[11px] text-stone-400">{key}</dt>
          <dd className="min-w-0 text-right text-xs leading-relaxed text-stone-700">
            <SignalsValue value={value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function SignalsValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-stone-400">—</span>;
  if (typeof value === "boolean" || typeof value === "number") {
    return <span className="font-mono tabular-nums">{String(value)}</span>;
  }
  if (typeof value === "string") {
    return <span className="break-words">{value === "" ? "—" : value}</span>;
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return <span className="break-words">{(value as string[]).join(", ")}</span>;
  }
  // Unexpected shapes stay fully visible — honest fallback, never dropped.
  return <span className="break-all font-mono text-[11px]">{JSON.stringify(value)}</span>;
}

function EvaluationMeta({ evaluation }: { evaluation: PlatformHealthEvaluationView }) {
  const provenance = evaluation.provenance;
  return (
    <div className="space-y-1.5 border-t border-dashed border-stone-200 pt-2">
      <div className="flex flex-col gap-0.5 font-mono text-[11px] leading-relaxed text-stone-400">
        <span>
          evaluation {evaluation.evaluationId.slice(0, 12)}… · {evaluation.vocabularyVersion} ·{" "}
          {evaluation.baselineVersion}
        </span>
        <span>
          recorded by {provenance.actor} via {provenance.recordedVia} ·{" "}
          {formatWhen(provenance.recordedAt)}
        </span>
        <span>append-only history — a new evaluation is a new record</span>
      </div>
    </div>
  );
}

// --- An earlier evaluation row (the append-only tail) -----------------------------

function EarlierEvaluationRow({ evaluation }: { evaluation: PlatformHealthEvaluationView }) {
  const [open, setOpen] = React.useState(false);
  return (
    <li className="overflow-hidden rounded-lg border border-stone-200 bg-white">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`evaluation-${evaluation.evaluationId}-detail`}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-[48px] w-full flex-wrap items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-stone-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-700"
      >
        <HealthStateChip state={evaluation.state} />
        <ConfidenceChip confidence={evaluation.confidence} />
        <span className="font-mono text-[11px] text-stone-400">
          {evaluation.reasonCodes.length} reason code{evaluation.reasonCodes.length === 1 ? "" : "s"}
        </span>
        <span className="ml-auto text-xs text-stone-400">{formatWhen(evaluation.createdAt)}</span>
      </button>
      {open ? (
        <div
          id={`evaluation-${evaluation.evaluationId}-detail`}
          className="space-y-3 border-t border-stone-100 px-3 py-3"
        >
          <EvaluationPicture evaluation={evaluation} />
        </div>
      ) : null}
    </li>
  );
}

// --- The run-evaluation action (owner|admin gated, honest permission state) -------

function RunEvaluationAction({
  clientId,
  account,
  permission,
  hasEvaluations,
}: {
  clientId: string;
  account: SocialAccountView;
  permission: HealthRunPermission;
  hasEvaluations: boolean;
}) {
  const run = useRunPlatformHealthEvaluation(clientId);
  const runAllowed = permission.status === "allowed";
  return (
    <div className="space-y-1.5">
      <WorkspaceActionButton
        tone={runAllowed ? "teal" : "plain"}
        onClick={() => void run.mutateAsync({ socialAccountId: account.socialAccountId })}
        disabled={!runAllowed || run.isPending}
        ariaLabel={`Run a health evaluation for ${account.displayIdentity ?? account.externalAccountId}`}
      >
        <span className="inline-flex items-center gap-1.5">
          <Play className="size-4" aria-hidden="true" />
          {run.isPending ? "Evaluating…" : hasEvaluations ? "Run evaluation again" : "Run the first evaluation"}
        </span>
      </WorkspaceActionButton>
      {permission.status === "checking" ? (
        <p className="text-xs leading-relaxed text-stone-500">Checking your role…</p>
      ) : null}
      {permission.status === "forbidden" ? (
        <p className="max-w-[260px] text-xs leading-relaxed text-stone-500">
          Running evaluations is reserved to the agency owner and admins
          {permission.role === null ? "" : ` — your role here: ${permission.role.replace(/_/g, " ")}`}.
          The recorded evaluation history stays fully readable.
        </p>
      ) : null}
      {run.isError ? (
        <RouteRefusalNote
          message={run.error instanceof Error ? run.error.message : String(run.error)}
        />
      ) : null}
    </div>
  );
}

// --- The per-account health card ---------------------------------------------------

export function AccountHealthCard({
  clientId,
  account,
  registryAdapter,
  tailNewestFirst,
  permission,
  defaultOpen = false,
  focused = false,
}: {
  clientId: string;
  account: SocialAccountView;
  registryAdapter: RegisteredAdapterView | null;
  /** The account's evaluations, NEWEST first (the append-only tail). */
  tailNewestFirst: PlatformHealthEvaluationView[];
  permission: HealthRunPermission;
  defaultOpen?: boolean;
  focused?: boolean;
}) {
  const navigate = useMosSession((state) => state.navigate);
  const cardRef = React.useRef<HTMLDivElement | null>(null);

  // The Connections→Health cross-link landing: the focused card opens its
  // drill-down and scrolls into view (never a fabricated highlight state —
  // a plain scroll + ring so the operator sees where they landed).
  React.useEffect(() => {
    if (focused) {
      cardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [focused]);

  const latest = tailNewestFirst.length > 0 ? tailNewestFirst[0] : null;
  const earlier = tailNewestFirst.slice(1);
  const providerLabel = registryAdapter?.providerLabel ?? account.platformId.replace(/_/g, " ");
  const dead = account.status === "disconnected" || account.status === "revoked";

  return (
    <ConnectionCard
      id={`health-${account.socialAccountId}`}
      defaultOpen={defaultOpen}
      detailLabel="Evidence basis, recommendations and evaluation history"
      detail={
        <div className="space-y-4">
          {/* UX-010: the run action + the connection cross-link live in the
              disclosure layer — the collapsed card is the calm operating
              picture (state, confidence, uncertainty), the card's single
              primary is disclosed on expand, exactly as wired before. */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <RunEvaluationAction
              clientId={clientId}
              account={account}
              permission={permission}
              hasEvaluations={latest !== null}
            />
            <button
              type="button"
              onClick={() => navigate({ kind: "client", clientId, tab: "connections" })}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-100 focus-visible:ring-2 focus-visible:ring-teal-700"
            >
              <ArrowRight className="size-3.5" aria-hidden="true" />
              See the connection
            </button>
          </div>
          {latest === null ? (
            <p className="text-sm leading-relaxed text-stone-600">
              No evaluation detail to show yet — run the first evaluation to
              compose the account&apos;s health picture from its observable
              records.
            </p>
          ) : (
            <>
              <div>
                <BlockHeading>The latest evaluation (the current picture)</BlockHeading>
                <div className="mt-1.5">
                  <EvaluationPicture evaluation={latest} />
                </div>
              </div>
              {earlier.length > 0 ? (
                <div>
                  <BlockHeading>
                    Earlier evaluations ({earlier.length}, append-only — the history is never rewritten)
                  </BlockHeading>
                  <ul className="mt-1.5 flex flex-col gap-1.5">
                    {earlier.map((evaluation) => (
                      <EarlierEvaluationRow key={evaluation.evaluationId} evaluation={evaluation} />
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-xs leading-relaxed text-stone-500">
                  This is the only evaluation on record for this account — the
                  tail grows append-only as evaluations run.
                </p>
              )}
            </>
          )}
        </div>
      }
    >
      <div
        ref={cardRef}
        className={`flex min-w-0 flex-wrap items-start justify-between gap-3 ${
          focused ? "rounded-lg ring-2 ring-teal-800/30 ring-offset-2" : ""
        }`}
      >
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-stone-800">{providerLabel}</p>
          <p className="mt-0.5 truncate text-sm text-stone-500">
            {account.displayIdentity ?? account.externalAccountId}
          </p>
          {latest === null ? (
            <>
              <p className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <SocialStatusChip status={account.status} />
                <span className="text-[11px] text-stone-400">no evaluations yet</span>
              </p>
              <p className="mt-1.5 rounded-lg border border-dashed border-stone-300 bg-stone-50/60 px-3 py-2 text-sm leading-relaxed text-stone-600">
                No evaluations yet — expand this card to run the first evaluation and compose its
                health picture from the records the platform actually exposed.
              </p>
            </>
          ) : (
            <>
              <p className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <SocialStatusChip status={account.status} />
                <span className="inline-flex items-center gap-1">
                  <StateGlanceIcon state={latest.state} />
                  <HealthStateChip state={latest.state} />
                </span>
                <ConfidenceChip confidence={latest.confidence} />
                <span className="text-[11px] text-stone-400">
                  evaluated {formatWhen(latest.createdAt)}
                </span>
              </p>
              <div className="mt-1.5 max-w-prose space-y-1">
                <HealthStateQualifier state={latest.state} />
                <p className="text-xs leading-relaxed text-stone-500">
                  <span className="font-medium text-stone-600">Uncertainty:</span>{" "}
                  {latest.uncertainty}
                </p>
              </div>
            </>
          )}
          {dead ? (
            <p className="mt-1.5 text-xs leading-relaxed text-stone-500">
              This binding is terminal (disconnected/revoked) — its recorded
              authorization state stays part of the observable picture an
              evaluation composes.
            </p>
          ) : null}
        </div>
      </div>
    </ConnectionCard>
  );
}
