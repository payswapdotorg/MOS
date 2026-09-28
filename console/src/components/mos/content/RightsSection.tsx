"use client";

// UX-006 — the RIGHTS family of the Content/Rights surface: the client's
// rights records (MKT-063) as operational cards — the frozen state
// vocabulary, the licence facts, THE PUBLICATION GATE evaluation with its
// reasons (the honest WHY an asset is gated: which requirement is unmet,
// with the explicit next action — never a silent dead end), the state
// transitions (the human_clearance kind is the ONLY review → cleared
// path) and the destination-platform permissions. Composed ONLY from:
//
//   GET  /api/clients/:clientId/content-rights                          the records
//   GET  /api/clients/:clientId/content-rights/:rightsRecordId          one record + the append-only tails
//   POST /api/clients/:clientId/content-rights                          register (born 'unknown')
//   POST /api/clients/:clientId/content-rights/gate                     THE GATE (allow / review_required / blocked WITH reasons)
//   POST /api/clients/:clientId/content-rights/:id/transitions          record ONE state transition
//   POST /api/clients/:clientId/content-rights/:id/permissions          append ONE destination permission row
//
// The gate POST is an EVALUATION, never a publication: publishing is
// MKT-065's execution surface and no publish/dispatch verb exists in this
// family. The register/transition forms cite the client's REAL evidence
// records (the /evidence ledger read) as the required provenance anchors.

import * as React from "react";
import { ShieldCheck } from "lucide-react";
import {
  useClientEvidence,
  useContentRights,
  useContentRightsDetail,
  useEvaluateRightsGate,
  useRecordRightsPermission,
  useRecordRightsTransition,
  useRegisterContentRights,
} from "@/components/mos/hooks";
import type {
  ContentRightsGateResultView,
  ContentRightsRecordView,
  EvidenceRecord,
} from "@/lib/mos-api";
import {
  Chip,
  ConfirmGate,
  ContentRecordCard,
  GateOutcomePanel,
  LabeledRows,
  RightsStateChip,
  SectionSkeleton,
  SelectField,
  SourceLine,
  TextField,
  formatWhen,
} from "./content-atoms";
import {
  SectionErrorView as SectionErrorViewInline,
  WorkspaceActionButton,
  WorkspaceEmptyState,
} from "@/components/mos/mission/workspace-atoms";

const EVENT_KINDS = [
  "determination",
  "human_clearance",
  "contestation",
  "revocation",
  "review_denial",
  "re_review_request",
] as const;
const RIGHTS_STATES = [
  "owned",
  "license",
  "platform_permitted",
  "cleared",
  "review",
  "blocked",
  "unknown",
] as const;

function vocabOptions(values: readonly string[]): Array<{ value: string; label: string }> {
  return values.map((value) => ({ value, label: value.replace(/_/g, " ") }));
}

function evidenceOptions(
  evidenceList: EvidenceRecord[],
): Array<{ value: string; label: string }> {
  return evidenceList.map((record) => ({
    value: record.evidenceId,
    label: `${record.class} · ${record.source.system}${record.source.ref ? ` · ${record.source.ref.slice(0, 24)}` : ""} · ${record.observedAt.slice(0, 10)}`,
  }));
}

export function RightsSection({ clientId }: { clientId: string }) {
  const records = useContentRights(clientId);
  const evidence = useClientEvidence(clientId);
  const register = useRegisterContentRights(clientId);

  const [registerOpen, setRegisterOpen] = React.useState(false);

  const list = records.data ?? [];

  return (
    <section id="content-rights-section" aria-labelledby="content-rights-heading" className="space-y-3">
      <div>
        <h3 id="content-rights-heading" className="flex items-center gap-2 font-medium text-stone-800">
          <ShieldCheck className="size-4 text-stone-400" aria-hidden="true" />
          Rights gates
        </h3>
        <p className="mt-0.5 text-sm leading-relaxed text-stone-600">
          The rights state of every asset this client wants to publish — owned, licensed,
          platform-permitted, cleared, in review or blocked — with the publication gate&apos;s own
          evaluation: what is unmet, in the gate&apos;s words, and the next action that state
          needs. Records are born &lsquo;unknown&apos; and every change is an append-only
          transition; the human clearance is the only review → cleared path.
        </p>
      </div>

      {records.isPending ? (
        <SectionSkeleton rows={3} />
      ) : records.isError ? (
        <SectionErrorViewInline
          error={records.error}
          what="the rights records"
          onRetry={() => void records.refetch()}
        />
      ) : (
        <>
          {list.length === 0 ? (
            <WorkspaceEmptyState
              missing="No rights records exist on this client yet."
              why="Before anything is published, each asset needs its rights state — the gate refuses absent records fail-closed, and an undetermined state never auto-approves. A record is born 'unknown' and the licence facts ride its determination."
              next="Register the rights record for an asset: cite the client's evidence as the source provenance (from a candidate's evidence links) and the licence facts when they are known. The publication gate then evaluates it against each destination."
              action={
                <WorkspaceActionButton
                  onClick={() => setRegisterOpen(true)}
                  ariaLabel="Register a rights record"
                >
                  Register a rights record
                </WorkspaceActionButton>
              }
            />
          ) : (
            <ul className="flex flex-col gap-3">
              {list.map((record) => (
                <RightsRecordCard key={record.rightsRecordId} clientId={clientId} record={record} />
              ))}
            </ul>
          )}

          {list.length > 0 ? (
            <div>
              <WorkspaceActionButton
                tone="plain"
                onClick={() => setRegisterOpen(true)}
                ariaLabel="Register another rights record"
              >
                Register another rights record
              </WorkspaceActionButton>
            </div>
          ) : null}
        </>
      )}

      <RegisterRightsGate
        clientId={clientId}
        open={registerOpen}
        onOpenChange={setRegisterOpen}
        evidenceList={evidence.data ?? []}
        evidencePending={evidence.isPending}
        evidenceError={evidence.isError ? evidence.error : null}
        onRetryEvidence={() => void evidence.refetch()}
        busy={register.isPending}
        onSubmit={(payload) => {
          void register
            .mutateAsync(payload)
            .catch(() => {
              /* the toast carries the server's own words */
            })
            .finally(() => setRegisterOpen(false));
        }}
      />

      <SourceLine
        sources={[
          `GET /api/clients/${clientId.slice(0, 8)}…/content-rights (+ :rightsRecordId detail on expand)`,
          "POST …/content-rights (register) · POST …/content-rights/gate (THE GATE evaluation)",
          "POST …/content-rights/:id/transitions | …/content-rights/:id/permissions (state transitions + destination permissions)",
        ]}
      />
    </section>
  );
}

// --- One rights record card ----------------------------------------------------------

function RightsRecordCard({
  clientId,
  record,
}: {
  clientId: string;
  record: ContentRightsRecordView;
}) {
  const detail = useContentRightsDetail(clientId, record.rightsRecordId);
  const evaluateGate = useEvaluateRightsGate(clientId);
  const transition = useRecordRightsTransition(clientId);
  const permission = useRecordRightsPermission(clientId);

  const [destination, setDestination] = React.useState("youtube");
  const [gateResult, setGateResult] = React.useState<ContentRightsGateResultView | null>(null);
  const [transitionOpen, setTransitionOpen] = React.useState(false);
  const [permissionOpen, setPermissionOpen] = React.useState(false);

  const runGate = () => {
    void evaluateGate
      .mutateAsync({ assetRef: record.contentAssetRef, destinationPlatform: destination })
      .then((outcome) => setGateResult(outcome.gate))
      .catch(() => {
        /* the toast carries the server's own words */
      });
  };

  return (
    <ContentRecordCard
      id={`rights-card-${record.rightsRecordId}`}
      detailLabel="Transition history, destination permissions and clearances"
      detail={(open) =>
        open ? (
          <RightsDetailBody detail={detail} />
        ) : null
      }
    >
        <div className="space-y-2.5">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate font-medium text-stone-800">
                Asset <span className="font-mono text-sm text-stone-500">{record.contentAssetRef}</span>
              </p>
              <p className="mt-0.5 text-sm text-stone-500">
                {record.assetKind}
                {record.licenceLabel ? ` · ${record.licenceLabel}` : " · no licence label recorded"}
              </p>
            </div>
            <span className="shrink-0 text-xs text-stone-400">
              updated {formatWhen(record.updatedAt)}
            </span>
          </div>

          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <RightsStateChip state={record.state} />
            {record.validUntil ? (
              <Chip
                label={`valid until ${record.validUntil.slice(0, 10)}`}
                className="border-stone-200 bg-stone-50 text-stone-600"
              />
            ) : null}
            <span className="font-mono text-[11px] text-stone-400">
              v{record.version} · evidence:{record.sourceEvidenceRef?.slice(0, 8) ?? "—"}…
            </span>
          </div>

          <div className="rounded-lg border border-stone-200 bg-stone-50/60 px-3 py-2.5">
            <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
              The publication gate — evaluate before any destination
            </p>
            <div className="mt-1.5 flex flex-wrap items-end gap-2">
              <div className="w-44">
                <label
                  htmlFor={`gate-destination-${record.rightsRecordId}`}
                  className="text-xs font-medium uppercase tracking-wide text-stone-500"
                >
                  Destination platform
                </label>
                <input
                  id={`gate-destination-${record.rightsRecordId}`}
                  type="text"
                  value={destination}
                  onChange={(event) => setDestination(event.target.value)}
                  placeholder="e.g. youtube"
                  className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-800 placeholder:text-stone-400 focus-visible:ring-2 focus-visible:ring-teal-700"
                />
              </div>
              <WorkspaceActionButton
                tone="teal"
                onClick={runGate}
                disabled={evaluateGate.isPending || destination.trim() === ""}
                ariaLabel={`Evaluate the publication gate for ${record.contentAssetRef}`}
              >
                {evaluateGate.isPending ? "Evaluating…" : "Evaluate the gate"}
              </WorkspaceActionButton>
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-stone-500">
              The gate evaluates the recorded rights and the destination policy — allow,
              review_required or blocked, with the reason codes in its own words. It never
              publishes: distribution is a separate authority.
            </p>
          </div>

          {gateResult ? <GateOutcomePanel gate={gateResult} onDismiss={() => setGateResult(null)} /> : null}

          <div className="flex flex-wrap gap-2">
            <WorkspaceActionButton
              tone="plain"
              onClick={() => setTransitionOpen(true)}
              ariaLabel={`Record a state transition for ${record.contentAssetRef}`}
            >
              Record a state transition
            </WorkspaceActionButton>
            <WorkspaceActionButton
              tone="plain"
              onClick={() => setPermissionOpen(true)}
              ariaLabel={`Record a destination permission for ${record.contentAssetRef}`}
            >
              Record a destination permission
            </WorkspaceActionButton>
          </div>
        </div>
      <TransitionGate
        clientId={clientId}
        record={record}
        open={transitionOpen}
        onOpenChange={setTransitionOpen}
        busy={transition.isPending}
        onSubmit={(payload) => {
          void transition
            .mutateAsync({ rightsRecordId: record.rightsRecordId, ...payload })
            .catch(() => {
              /* the toast carries the server's own words */
            })
            .finally(() => setTransitionOpen(false));
        }}
      />
      <PermissionGate
        clientId={clientId}
        record={record}
        open={permissionOpen}
        onOpenChange={setPermissionOpen}
        busy={permission.isPending}
        onSubmit={(payload) => {
          void permission
            .mutateAsync({ rightsRecordId: record.rightsRecordId, ...payload })
            .catch(() => {
              /* the toast carries the server's own words */
            })
            .finally(() => setPermissionOpen(false));
        }}
      />
    </ContentRecordCard>
  );
}

// --- The expanded rights detail ------------------------------------------------------

function RightsDetailBody({
  detail,
}: {
  detail: ReturnType<typeof useContentRightsDetail>;
}) {
  if (detail.isPending) return <SectionSkeleton rows={3} />;
  if (detail.isError) {
    return (
      <SectionErrorViewInline
        error={detail.error}
        what="the rights record's append-only tails"
        onRetry={() => void detail.refetch()}
      />
    );
  }
  const view = detail.data;
  if (view === undefined) return null;

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
          Transition history (append-only, oldest first)
        </p>
        {view.events.length === 0 ? (
          <p className="mt-1 text-sm leading-relaxed text-stone-600">
            No transitions recorded — this record is still in its born state.
          </p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1.5">
            {view.events.map((event) => (
              <li
                key={event.eventId}
                className="rounded-lg border border-stone-200 bg-white px-3 py-2"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <Chip
                    label={event.eventKind.replace(/_/g, " ")}
                    className="border-stone-300 bg-stone-100 text-stone-700"
                  />
                  <span className="font-mono text-[11px] text-stone-500">
                    {event.fromState ?? "—"} → {event.toState}
                  </span>
                  <span className="ml-auto shrink-0 text-[11px] text-stone-400">
                    {formatWhen(event.provenance.recordedAt)}
                  </span>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-stone-600">{event.reason}</p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
          Destination permissions (the newest row per platform is effective)
        </p>
        {view.permissions.length === 0 ? (
          <p className="mt-1 text-sm leading-relaxed text-stone-600">
            No destination permissions recorded — an unspecified destination fails closed to
            review_required at the gate.
          </p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1.5">
            {view.permissions.map((permission) => (
              <li
                key={permission.permissionId}
                className="flex min-w-0 flex-wrap items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-3 py-2"
              >
                <span className="font-mono text-xs text-stone-700">{permission.platformKey}</span>
                <Chip
                  label={permission.permission.replace(/_/g, " ")}
                  className={
                    permission.permission === "permitted"
                      ? "border-teal-800/20 bg-teal-50 text-teal-900"
                      : "border-red-800/20 bg-red-50 text-red-900"
                  }
                />
                <span className="ml-auto font-mono text-[11px] text-stone-400">
                  evidence:{permission.evidenceRef.slice(0, 8)}…
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
          Human clearances (the ONLY review → cleared path)
        </p>
        {view.clearances.length === 0 ? (
          <p className="mt-1 text-sm leading-relaxed text-stone-600">
            No clearances recorded — a review state is cleared only by a recorded human clearance
            with its rationale.
          </p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1.5">
            {view.clearances.map((clearance) => (
              <li
                key={clearance.clearanceId}
                className="rounded-lg border border-stone-200 bg-white px-3 py-2"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="font-mono text-[11px] text-stone-500">
                    cleared by {clearance.clearedByActor} · via {clearance.clearedVia}
                  </span>
                  <span className="ml-auto shrink-0 text-[11px] text-stone-400">
                    {formatWhen(clearance.clearedAt)}
                  </span>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-stone-600">{clearance.rationale}</p>
                {clearance.evidenceRef ? (
                  <p className="mt-0.5 font-mono text-[11px] text-stone-400">
                    evidence:{clearance.evidenceRef.slice(0, 8)}…
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// --- The register dialog -------------------------------------------------------------

function RegisterRightsGate({
  clientId,
  open,
  onOpenChange,
  evidenceList,
  evidencePending,
  evidenceError,
  onRetryEvidence,
  busy,
  onSubmit,
}: {
  clientId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  evidenceList: EvidenceRecord[];
  evidencePending: boolean;
  evidenceError: unknown;
  onRetryEvidence: () => void;
  busy: boolean;
  onSubmit: (payload: {
    contentAssetRef: string;
    assetKind: string;
    sourceEvidenceRef: string;
    licenceLabel?: string;
    licenceEvidenceRef?: string;
    validUntil?: string;
  }) => void;
}) {
  void clientId;
  const [contentAssetRef, setContentAssetRef] = React.useState("");
  const [assetKind, setAssetKind] = React.useState<string>("source");
  const [sourceEvidenceRef, setSourceEvidenceRef] = React.useState("");
  const [licenceLabel, setLicenceLabel] = React.useState("");
  const [licenceEvidenceRef, setLicenceEvidenceRef] = React.useState("");
  const [validUntil, setValidUntil] = React.useState("");

  const options = evidenceOptions(evidenceList);
  const valid =
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(contentAssetRef) && sourceEvidenceRef !== "";

  return (
    <ConfirmGate
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onOpenChange(false);
      }}
      title="Register a rights record"
      consequence="This registers the rights record for one content-asset reference — born 'unknown', the explicit undetermined state. The source provenance (a real evidence record of this client) is required; the licence facts recorded up front give a later licence-basis determination its immutable evidence. Recorded facts never change in place: corrections are append-only transition events."
      confirmLabel="Register the record"
      confirmTone="default"
      busy={busy}
      onConfirm={() => {
        if (!valid) return;
        onSubmit({
          contentAssetRef,
          assetKind,
          sourceEvidenceRef,
          ...(licenceLabel.trim() === "" ? {} : { licenceLabel: licenceLabel.trim() }),
          ...(licenceEvidenceRef === "" ? {} : { licenceEvidenceRef }),
          ...(validUntil === "" ? {} : { validUntil: `${validUntil}T00:00:00.000Z` }),
        });
      }}
    >
      <div className="mt-1 space-y-3">
        <TextField
          id="rights-asset-ref"
          label="Content asset ref"
          value={contentAssetRef}
          onChange={setContentAssetRef}
          placeholder="the asset's minted ref (from the Assets family)"
          hint="The reference the gate and the asset pipeline share — copy the minted assetRef of a registered asset version. Letters, digits, dot, underscore, colon and hyphen only."
          required
          invalid={open && contentAssetRef !== "" && !valid}
        />
        <SelectField
          id="rights-asset-kind"
          label="Asset kind"
          value={assetKind}
          onChange={setAssetKind}
          options={[
            { value: "source", label: "source" },
            { value: "composite", label: "composite" },
          ]}
          hint="A composite's ingredients are checked conjunctively at the gate through the recorded lineage links."
        />
        {evidencePending ? (
          <p className="text-sm text-stone-500">loading the client&apos;s evidence ledger…</p>
        ) : evidenceError !== null ? (
          <SectionErrorViewInline error={evidenceError} what="the evidence ledger" onRetry={onRetryEvidence} />
        ) : options.length === 0 ? (
          <p className="text-sm leading-relaxed text-stone-600">
            The client holds no evidence records yet — a rights record requires a real evidence
            reference as its source provenance. Record evidence first (research a fact into the
            ledger, or run an observation ingestion through a connected pipe).
          </p>
        ) : (
          <SelectField
            id="rights-source-evidence"
            label="Source evidence (required)"
            value={sourceEvidenceRef}
            onChange={setSourceEvidenceRef}
            options={[{ value: "", label: "— pick an evidence record —" }, ...options]}
            required
            invalid={open && sourceEvidenceRef === ""}
            hint="The evidence record that proves where this asset came from — the candidate's own evidence link is the natural anchor."
          />
        )}
        <TextField
          id="rights-licence-label"
          label="Licence label (optional)"
          value={licenceLabel}
          onChange={setLicenceLabel}
          placeholder="e.g. CC-BY-4.0"
          hint="The licence name a later determination can cite; a licence-basis state also needs the licence evidence below."
        />
        {options.length > 0 ? (
          <SelectField
            id="rights-licence-evidence"
            label="Licence evidence (optional)"
            value={licenceEvidenceRef}
            onChange={setLicenceEvidenceRef}
            options={[
              { value: "", label: "— none —" },
              ...options,
            ]}
            hint="The evidence record holding the licence deed or terms."
          />
        ) : null}
        <TextField
          id="rights-valid-until"
          label="Valid until (optional)"
          value={validUntil}
          onChange={setValidUntil}
          type="date"
          hint="The licence horizon — an expired horizon blocks at gate time whatever the recorded state."
        />
        {!valid && contentAssetRef !== "" ? (
          <p className="text-xs leading-relaxed text-amber-900">
            The asset ref must match the platform&apos;s reference pattern and an evidence record
            must be picked.
          </p>
        ) : null}
      </div>
    </ConfirmGate>
  );
}

// --- The transition dialog ------------------------------------------------------------

function TransitionGate({
  clientId,
  record,
  open,
  onOpenChange,
  busy,
  onSubmit,
}: {
  clientId: string;
  record: ContentRightsRecordView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  onSubmit: (payload: {
    eventKind: string;
    toState: string;
    reason: string;
    rationale?: string;
    evidenceRef?: string;
  }) => void;
}) {
  void clientId;
  const [eventKind, setEventKind] = React.useState<string>("determination");
  const [toState, setToState] = React.useState<string>("license");
  const [reason, setReason] = React.useState("");
  const [rationale, setRationale] = React.useState("");

  const needsRationale = eventKind === "human_clearance";
  const valid = reason.trim() !== "" && (!needsRationale || rationale.trim() !== "");

  return (
    <ConfirmGate
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onOpenChange(false);
          setReason("");
          setRationale("");
        }
      }}
      title={`Record a state transition — ${record.contentAssetRef}`}
      consequence={`This appends ONE immutable transition event (${eventKind.replace(/_/g, " ")}): the rights state moves from ${record.state} to the chosen target and the reason is recorded verbatim. Recorded facts never change in place; the human_clearance kind is the ONLY review → cleared path and requires the clearing rationale.`}
      confirmLabel="Record the transition"
      confirmTone="default"
      busy={busy}
      onConfirm={() => {
        if (!valid) return;
        onSubmit({
          eventKind,
          toState,
          reason: reason.trim(),
          ...(needsRationale ? { rationale: rationale.trim() } : {}),
        });
      }}
    >
      <div className="mt-1 space-y-3">
        <SelectField
          id="transition-event-kind"
          label="Event kind"
          value={eventKind}
          onChange={setEventKind}
          options={vocabOptions(EVENT_KINDS)}
        />
        <SelectField
          id="transition-to-state"
          label="To state"
          value={toState}
          onChange={setToState}
          options={vocabOptions(RIGHTS_STATES)}
          hint="The frozen state vocabulary — owned, license, platform-permitted, cleared, review, blocked, unknown."
        />
        <TextField
          id="transition-reason"
          label="Reason (required)"
          value={reason}
          onChange={setReason}
          placeholder="e.g. the CC-BY-4.0 licence deed was verified against the recorded licence evidence"
          required
          invalid={open && reason.trim() === ""}
          hint="Recorded verbatim on the append-only event tail."
        />
        {needsRationale ? (
          <TextField
            id="transition-rationale"
            label="Clearance rationale (required for human clearance)"
            value={rationale}
            onChange={setRationale}
            placeholder="e.g. Counsel reviewed the licence deed; the dispute is without merit"
            required
            invalid={open && rationale.trim() === ""}
            hint="The recorded human judgment — the only sanctioned review → cleared path."
          />
        ) : null}
      </div>
    </ConfirmGate>
  );
}

// --- The permission dialog ------------------------------------------------------------

function PermissionGate({
  clientId,
  record,
  open,
  onOpenChange,
  busy,
  onSubmit,
}: {
  clientId: string;
  record: ContentRightsRecordView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  onSubmit: (payload: { platformKey: string; permission: string; evidenceRef: string }) => void;
}) {
  const evidence = useClientEvidence(clientId);
  const [platformKey, setPlatformKey] = React.useState("youtube");
  const [permission, setPermission] = React.useState<string>("permitted");
  const [evidenceRef, setEvidenceRef] = React.useState("");

  const options = evidenceOptions(evidence.data ?? []);
  const valid = /^[a-z][a-z0-9_-]{0,31}$/.test(platformKey) && evidenceRef !== "";

  return (
    <ConfirmGate
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onOpenChange(false);
      }}
      title={`Record a destination permission — ${record.contentAssetRef}`}
      consequence="This appends ONE destination-platform permission row: the newest row per platform is the effective permission at the gate. A permitted destination still passes through the full gate evaluation; a not_permitted destination blocks outright."
      confirmLabel="Record the permission"
      confirmTone="default"
      busy={busy}
      onConfirm={() => {
        if (!valid) return;
        onSubmit({
          platformKey,
          permission,
          evidenceRef,
        });
      }}
    >
      <div className="mt-1 space-y-3">
        <TextField
          id="permission-platform-key"
          label="Platform key"
          value={platformKey}
          onChange={setPlatformKey}
          placeholder="e.g. youtube"
          required
          invalid={open && platformKey !== "" && !/^[a-z][a-z0-9_-]{0,31}$/.test(platformKey)}
          hint="The destination platform key — lowercase letters, digits, underscore and hyphen."
        />
        <SelectField
          id="permission-value"
          label="Permission"
          value={permission}
          onChange={setPermission}
          options={[
            { value: "permitted", label: "permitted" },
            { value: "not_permitted", label: "not permitted" },
          ]}
        />
        <SelectField
          id="permission-evidence"
          label="Evidence (required for a permission row)"
          value={evidenceRef}
          onChange={setEvidenceRef}
          options={[{ value: "", label: "— pick an evidence record —" }, ...options]}
          hint="The evidence record that proves the destination permission (the licence scope, the platform terms)."
        />
      </div>
    </ConfirmGate>
  );
}
