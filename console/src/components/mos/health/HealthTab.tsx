"use client";

// UX-007 — the Platform Health console surface: one client-scoped view
// where each connected account's health is SEEN and OPERATED — the
// descriptive state (the frozen NINE), its evidence basis, its honest
// uncertainty and the compliant next actions. Composed ONLY from the
// MKT-066 Platform Health authority through its own routes (zero new
// authorities): the client's evaluations grouped per account as
// newest-first tails, the per-account health cards (AccountHealthCard),
// and the honest empty state before the first evaluation runs. NEVER a
// claimed hidden moderation state, never a shadow-ban rendering, never a
// fabricated probability — every word of the verdict renders exactly as
// the authority returned it.
//
// Entry points: the Client Workspace's "Health" tab (this component) and
// the Connections Center's per-account cross-link (which lands here with
// the account focused — the two surfaces compose the same authority).

import * as React from "react";
import { Plug } from "lucide-react";
import {
  useAdapterRegistry,
  useClientPlatformHealth,
  usePlatformHealthRunPermission,
  useSocialAccounts,
} from "@/components/mos/hooks";
import type {
  PlatformHealthEvaluationView,
  SocialAccountView,
} from "@/lib/mos-api";
import { useMosSession } from "@/components/mos/session-store";
import {
  SectionSkeleton,
  SourceLine,
  WorkspaceActionButton,
} from "@/components/mos/mission/workspace-atoms";
import { SectionErrorViewInline } from "@/components/mos/connections/SocialConnections";
import { AccountHealthCard } from "./AccountHealthCard";

export function HealthTab({
  clientId,
  focusSocialAccountId,
}: {
  clientId: string;
  /** The account the Connections cross-link focuses (null on plain tab visits). */
  focusSocialAccountId: string | null;
}) {
  const navigate = useMosSession((state) => state.navigate);
  const accounts = useSocialAccounts(clientId);
  const health = useClientPlatformHealth(clientId);
  const registry = useAdapterRegistry();
  const permission = usePlatformHealthRunPermission(clientId);

  const accountList = accounts.data ?? [];
  const adapters = registry.data ?? [];
  const registryByPlatform = React.useMemo(
    () => new Map(adapters.map((adapter) => [adapter.adapterKey, adapter])),
    [adapters],
  );

  // The client's evaluations (the authority serves them oldest-first),
  // grouped per account for the per-account newest-first tails —
  // presentation grouping only, every record exactly as served.
  const evaluations = health.data?.evaluations ?? [];
  const tailsByAccount = React.useMemo(() => {
    const grouped = new Map<string, PlatformHealthEvaluationView[]>();
    for (const record of evaluations) {
      const tail = grouped.get(record.socialAccountId) ?? [];
      tail.push(record);
      grouped.set(record.socialAccountId, tail);
    }
    return grouped;
  }, [evaluations]);
  const knownAccountIds = React.useMemo(
    () => new Set(accountList.map((account) => account.socialAccountId)),
    [accountList],
  );
  // Evaluations whose account is not in the client's current account list
  // (defensive honesty — accounts are append-only so this should never
  // fire; when it does, the history renders with its honest note instead
  // of being silently dropped).
  const orphanEvaluations = evaluations.filter(
    (record) => !knownAccountIds.has(record.socialAccountId),
  );

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-stone-900">Platform health</h2>
        <p className="mt-1 max-w-prose text-sm leading-relaxed text-stone-600">
          The health picture of every channel this client holds — the descriptive state,
          the observable records that produced it, the honest uncertainty about what the
          evidence does not support, and the compliant next action each state needs. Each
          card composes the platform-health authority&apos;s real evaluation records; the
          evaluation itself reads only what the platform actually exposed.
        </p>
        {health.data?.observabilityDisclosure ? (
          <div className="mt-3 max-w-prose rounded-xl border border-stone-200 bg-stone-50/60 px-4 py-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
              The authority&apos;s standing disclosure — on every evaluation view
            </p>
            <p className="mt-1 text-sm leading-relaxed text-stone-600">
              {health.data.observabilityDisclosure}
            </p>
          </div>
        ) : null}
      </div>

      {accounts.isPending || health.isPending ? (
        <SectionSkeleton rows={4} />
      ) : accounts.isError ? (
        <SectionErrorViewInline
          error={accounts.error}
          what="the client's social accounts"
          onRetry={() => void accounts.refetch()}
        />
      ) : health.isError ? (
        <SectionErrorViewInline
          error={health.error}
          what="the client's platform-health evaluations"
          onRetry={() => void health.refetch()}
        />
      ) : accountList.length === 0 ? (
        <div className="rounded-lg border border-dashed border-stone-300 bg-stone-50/60 p-4">
          <p className="text-sm font-medium text-stone-700">
            No social accounts are connected on this client yet.
          </p>
          <p className="mt-1.5 text-sm leading-relaxed text-stone-600">
            Health is a per-channel picture — it composes the observable records of a
            connected account (its authorization state, publishing outcomes, metric
            history) into a descriptive verdict. With no channel connected there is
            nothing to evaluate yet, and nothing is invented here.
          </p>
          <p className="mt-1.5 text-sm leading-relaxed text-stone-600">
            Connect a platform in the Connections Center first; its health card appears
            here the moment the binding exists.
          </p>
          <div className="mt-3">
            <WorkspaceActionButton
              tone="teal"
              onClick={() => navigate({ kind: "client", clientId, tab: "connections" })}
              ariaLabel="Open the Connections Center"
            >
              <span className="inline-flex items-center gap-1.5">
                <Plug className="size-4" aria-hidden="true" />
                Open the Connections Center
              </span>
            </WorkspaceActionButton>
          </div>
        </div>
      ) : (
        <>
          {evaluations.length === 0 ? (
            <div className="rounded-lg border border-dashed border-stone-300 bg-stone-50/60 p-4">
              <p className="text-sm font-medium text-stone-700">
                No evaluations yet — run the first evaluation on a connected account.
              </p>
              <p className="mt-1.5 text-sm leading-relaxed text-stone-600">
                An evaluation is composed on demand: it reads the account&apos;s observable
                records (authorization state, publish attempts, metric history) and
                records one append-only verdict with its full basis. Until the first run,
                there is honestly no health state to show — never a guessed one.
              </p>
            </div>
          ) : null}
          <ul className="flex flex-col gap-3">
            {accountList.map((account) => (
              <AccountHealthCard
                key={account.socialAccountId}
                clientId={clientId}
                account={account}
                registryAdapter={registryByPlatform.get(account.platformId) ?? null}
                tailNewestFirst={[...(tailsByAccount.get(account.socialAccountId) ?? [])].reverse()}
                permission={permission}
                defaultOpen={focusSocialAccountId === account.socialAccountId}
                focused={focusSocialAccountId === account.socialAccountId}
              />
            ))}
          </ul>
          {orphanEvaluations.length > 0 ? (
            <div className="rounded-xl border border-stone-200 bg-stone-50/60 px-5 py-4">
              <p className="text-sm font-medium text-stone-700">
                {orphanEvaluations.length} evaluation
                {orphanEvaluations.length === 1 ? "" : "s"} reference an account that is
                not in the client&apos;s current account list
              </p>
              <p className="mt-1 text-sm leading-relaxed text-stone-600">
                The evaluation history is append-only and stays readable even when its
                account record is no longer served on the social-accounts surface — the
                citations render, nothing is fabricated and nothing is dropped.
              </p>
              <ul className="mt-2 flex flex-col gap-1">
                {orphanEvaluations.map((record) => (
                  <li key={record.evaluationId} className="font-mono text-[11px] text-stone-500">
                    evaluation {record.evaluationId.slice(0, 12)}… · account{" "}
                    {record.socialAccountId.slice(0, 12)}… · {record.state} ·{" "}
                    {record.createdAt}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}

      <div className="rounded-xl border border-stone-200 bg-stone-50/60 px-5 py-4">
        <p className="text-sm leading-relaxed text-stone-600">
          This surface composes the platform-health authority — it holds no health state
          of its own. The states are the authority&apos;s frozen nine-state vocabulary
          (there is deliberately no shadow-ban state or synonym), the confidence is its
          coarse evidence tier and the uncertainty statement is its own words; the
          recommendations are the compliant §11 maneuver list as data. Evaluations are
          append-only — running one adds a record, it never rewrites history.
        </p>
        <SourceLine
          sources={[
            `GET /api/clients/${clientId.slice(0, 8)}…/platform-health (the client's evaluations, grouped per account by this surface)`,
            "GET /api/platform-health/evaluations/:evaluationId (the FK-anchored evidence citations, on expand)",
            "POST /api/clients/:clientId/platform-health/accounts/:socialAccountId/evaluations (run the evaluation — owner|admin, empty body)",
            "GET /api/clients/:clientId/social-accounts (the account cards' live connection facts)",
          ]}
        />
      </div>
    </div>
  );
}
