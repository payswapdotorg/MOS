"use client";

// UX-006 — the ASSETS family of the Content/Rights surface: the client's
// content asset versions and their transformation chain (MKT-064) as
// operational cards — the versioned asset model (draft → materialized →
// derived), THE MATERIALIZATION MOVE (the operator's own bytes), the
// transformation requests (kind + EXPLICIT ingredient versions + parameters
// + output spec) and their execution, and the lineage drill-down that makes
// the v1.6 lineage-mandatory rule VISIBLE: every derived output renders its
// ingredient tail (the frozen input versions) AND the MKT-063 lineage links
// recorded during execution. Composed ONLY from:
//
//   GET  /api/clients/:clientId/content-assets                                  the versions
//   GET  /api/clients/:clientId/content-assets/transformations                  the transformations
//   GET  /api/clients/:clientId/content-assets/transformations/:id              one + its immutable ingredient tail + output
//   GET  /api/clients/:clientId/content-assets/:versionId                      one + versions-of-asset + events + observations
//   GET  /api/clients/:clientId/content-rights/lineage/:compositeAssetRef      the 063 lineage links of a derived output
//   POST /api/clients/:clientId/content-assets                                  register (born draft)
//   POST /api/clients/:clientId/content-assets/:versionId/materialize           the materialization move
//   POST /api/clients/:clientId/content-assets/transformations                  request a transformation
//   POST /api/clients/:clientId/content-assets/transformations/:id/execute      execute one
//
// The transformation history renders as the DRILL-DOWN (progressive
// disclosure): the first screen is the operational record — what the asset
// is, its lifecycle state, its next action.

import * as React from "react";
import { toast } from "sonner";
import {
  useClientEvidence,
  useContentAssetVersionDetail,
  useContentAssets,
  useContentTransformationDetail,
  useContentTransformations,
  useExecuteContentTransformation,
  useMaterializeContentAsset,
  useRegisterContentAsset,
  useRequestContentTransformation,
  useRightsLineage,
  useWorkspaces,
} from "@/components/mos/hooks";
import type {
  ContentAssetVersionView,
  ContentTransformationView,
  EvidenceRecord,
} from "@/lib/mos-api";
import {
  AssetLifecycleChip,
  Chip,
  ConfirmGate,
  ContentRecordCard,
  LabeledRows,
  SectionSkeleton,
  SelectField,
  SourceLine,
  TextField,
  formatWhen,
} from "./content-atoms";
import { SurfaceSection } from "@/components/mos/surface-section";
import {
  SectionErrorView as SectionErrorViewInline,
  WorkspaceActionButton,
  WorkspaceEmptyState,
} from "@/components/mos/mission/workspace-atoms";

const MEDIA_KINDS = ["video", "audio", "image", "text", "document"] as const;
const TRANSFORMATION_KINDS = [
  "crop", "reframe", "padding", "compilation", "clip", "caption", "voice", "translation", "format",
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

export function AssetsSection({ clientId }: { clientId: string }) {
  const assets = useContentAssets(clientId);
  const transformations = useContentTransformations(clientId);
  const register = useRegisterContentAsset(clientId);
  const requestTransformation = useRequestContentTransformation(clientId);

  const [registerOpen, setRegisterOpen] = React.useState(false);
  const [requestOpen, setRequestOpen] = React.useState(false);

  const versionList = assets.data ?? [];
  const transformationList = transformations.data ?? [];
  const draftCount = versionList.filter((version) => version.lifecycleState === "draft").length;

  return (
    <SurfaceSection
      id="content-assets"
      label="Assets"
      title="Assets & transformations"
      summary={
        assets.isPending
          ? "loading the asset versions…"
          : assets.isError
            ? "could not load the asset versions — open to retry"
            : versionList.length === 0
              ? "no asset versions yet"
              : `${versionList.length} version${versionList.length === 1 ? "" : "s"} · ${
                  versionList.length - draftCount
                } ready${draftCount > 0 ? ` · ${draftCount} awaiting material` : ""}${
                  transformationList.length > 0
                    ? ` · ${transformationList.length} transformation${transformationList.length === 1 ? "" : "s"}`
                    : ""
                }`
      }
      summaryTone={assets.isError ? "warning" : "neutral"}
    >
      <div id="content-assets-section" className="space-y-3">
        <p className="text-sm leading-relaxed text-stone-600">
          The versioned material this client can publish — each asset version is born draft,
          materializes from the operator&apos;s own bytes, and becomes derived output through
          recorded transformations. Every derived asset renders its lineage: the frozen
          ingredient versions and the rights-lineage links recorded when it was derived.
        </p>

        {assets.isPending ? (
          <SectionSkeleton rows={3} />
        ) : assets.isError ? (
          <SectionErrorViewInline
            error={assets.error}
            what="the content assets"
            onRetry={() => void assets.refetch()}
          />
        ) : (
          <>
            {versionList.length === 0 ? (
              <WorkspaceEmptyState
                missing="No content assets are recorded on this client yet."
                why="An asset version is the material itself — a post, a video, a product shot — anchored on a real evidence record and versioned immutably. Transformations consume materialized versions and produce derived output with mandatory lineage."
                next="Register the first asset version: cite the client's evidence (a candidate's evidence link is the natural anchor), then materialize it with the operator's own file and transform it into channel-ready pieces."
                action={
                  <WorkspaceActionButton
                    tone="plain"
                    onClick={() => setRegisterOpen(true)}
                    ariaLabel="Register an asset version"
                  >
                    Register an asset version
                  </WorkspaceActionButton>
                }
              />
            ) : (
              <ul className="flex flex-col gap-3">
                {versionList.map((version) => (
                  <AssetVersionCard key={version.versionId} clientId={clientId} version={version} />
                ))}
              </ul>
            )}

            {versionList.length > 0 ? (
              <div>
                <WorkspaceActionButton
                  tone="plain"
                  onClick={() => setRegisterOpen(true)}
                  ariaLabel="Register another asset version"
                >
                  Register another asset version
                </WorkspaceActionButton>
              </div>
            ) : null}

          <div className="pt-2">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <h4 className="text-sm font-medium text-stone-700">
                  Transformation chain ({transformationList.length})
                </h4>
                <p className="mt-0.5 text-xs leading-relaxed text-stone-500">
                  Every transformation ever requested on this client — the drill-down of each one
                  carries its frozen ingredients, its output version and the rights-lineage links of
                  that output (the lineage-mandatory rule, made visible).
                </p>
              </div>
              {versionList.length > 0 ? (
                <WorkspaceActionButton
                  tone="plain"
                  onClick={() => setRequestOpen(true)}
                  ariaLabel="Request a transformation"
                >
                  Request a transformation
                </WorkspaceActionButton>
              ) : null}
            </div>
            {transformations.isError ? (
              <div className="mt-2">
                <SectionErrorViewInline
                  error={transformations.error}
                  what="the transformations"
                  onRetry={() => void transformations.refetch()}
                />
              </div>
            ) : transformationList.length === 0 ? (
              <p className="mt-2 text-sm leading-relaxed text-stone-600">
                No transformations requested yet — a transformation is requested from at least one
                materialized version and executed through the platform&apos;s runner; the output
                is born derived with its lineage recorded.
              </p>
            ) : (
              <ul className="mt-2 flex flex-col gap-3">
                {transformationList.map((transformation) => (
                  <TransformationRow
                    key={transformation.transformationId}
                    clientId={clientId}
                    transformation={transformation}
                  />
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      <RegisterAssetGate
        clientId={clientId}
        open={registerOpen}
        onOpenChange={setRegisterOpen}
        evidenceList={undefined}
        busy={register.isPending}
        existingAssets={versionList}
        onSubmit={(payload) => {
          void register
            .mutateAsync(payload)
            .catch(() => {
              /* the toast carries the server's own words */
            })
            .finally(() => setRegisterOpen(false));
        }}
      />

      <RequestTransformationGate
        clientId={clientId}
        open={requestOpen}
        onOpenChange={setRequestOpen}
        versions={versionList}
        busy={requestTransformation.isPending}
        onSubmit={(payload) => {
          void requestTransformation
            .mutateAsync(payload)
            .catch(() => {
              /* the toast carries the server's own words */
            })
            .finally(() => setRequestOpen(false));
        }}
      />

      <SourceLine
        sources={[
          `GET /api/clients/${clientId.slice(0, 8)}…/content-assets (+ :versionId detail, on expand)`,
          "GET …/content-assets/transformations (+ :transformationId ingredient tail, on expand)",
          "GET …/content-rights/lineage/:compositeAssetRef (the 063 lineage links of a derived output)",
          "POST …/content-assets (register) · …/:versionId/materialize · …/transformations (request) · …/transformations/:id/execute",
        ]}
      />
      </div>
    </SurfaceSection>
  );
}

// --- One asset version card ----------------------------------------------------------

function AssetVersionCard({
  clientId,
  version,
}: {
  clientId: string;
  version: ContentAssetVersionView;
}) {
  const materialize = useMaterializeContentAsset(clientId);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const pickAndMaterialize = () => {
    fileInputRef.current?.click();
  };

  const onFilePicked = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined) return;
    if (file.size > 8 * 1024 * 1024) {
      // The route's own bounded contract — surfaced honestly before the
      // round trip (the platform would refuse the oversized payload).
      toast.error(
        `That file is ${(file.size / (1024 * 1024)).toFixed(1)} MB — the materialization contract bounds the inline payload at 8 MB.`,
      );
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const base64 = result.slice(result.indexOf(",") + 1);
      void materialize
        .mutateAsync({ versionId: version.versionId, bytesBase64: base64 })
        .catch(() => {
          /* the toast carries the server's own words */
        });
    };
    reader.readAsDataURL(file);
  };

  return (
    <ContentRecordCard
      id={`asset-${version.versionId}`}
      detailLabel="Materialize, version history, lifecycle events and quality observations"
        detail={(open) =>
          open ? (
            <div className="space-y-4">
              <LabeledRows
                label="Version reference"
                record={{
                  assetRef: version.assetRef,
                  versionId: version.versionId,
                  sourceEvidenceRef: version.sourceEvidenceRef ?? "derived — the recorded transformation is the provenance",
                }}
              />
              {version.lifecycleState === "draft" ? (
                <div className="flex flex-wrap items-center gap-2">
                  {/* UX-010: the card's single primary action lives in the
                      expanded detail — the materialization, exactly as wired
                      before (own file, ≤8 MB, nothing fabricated). */}
                  <input
                    ref={fileInputRef}
                    id={`materialize-file-${version.versionId}`}
                    type="file"
                    accept="*/*"
                    onChange={onFilePicked}
                    className="hidden"
                  />
                  <WorkspaceActionButton
                    tone="teal"
                    onClick={pickAndMaterialize}
                    disabled={materialize.isPending}
                    ariaLabel={`Materialize ${version.displayName ?? version.assetRef}`}
                  >
                    {materialize.isPending ? "Storing…" : "Materialize with a file"}
                  </WorkspaceActionButton>
                  <span className="text-xs leading-relaxed text-stone-500">
                    The operator&apos;s own file (≤8 MB) — the object store keeps the real bytes;
                    nothing is fabricated.
                  </span>
                </div>
              ) : null}
              <AssetVersionDetailBody clientId={clientId} versionId={version.versionId} />
            </div>
          ) : null
        }
      >
        <div className="space-y-2">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate font-medium text-stone-800">
                {version.displayName ?? "Unnamed asset"}
              </p>
              <p className="mt-0.5 truncate text-sm text-stone-500">
                {version.mediaKind} · {version.contentType} · v{version.version}
              </p>
            </div>
            <span className="shrink-0 text-xs text-stone-400">
              recorded {formatWhen(version.createdAt)}
            </span>
          </div>

          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <AssetLifecycleChip state={version.lifecycleState} />
            {version.objectSize !== undefined ? (
              <span className="text-[11px] text-stone-400">
                {(version.objectSize / 1024).toFixed(1)} KB stored
              </span>
            ) : null}
          </div>

          {version.lifecycleState === "draft" ? (
            <p className="text-xs leading-relaxed text-stone-400">
              Expand to materialize this version with the operator&apos;s own file.
            </p>
          ) : null}
        </div>
    </ContentRecordCard>
  );
}

// --- The asset drill-down ------------------------------------------------------------

function AssetVersionDetailBody({
  clientId,
  versionId,
}: {
  clientId: string;
  versionId: string;
}) {
  const detail = useContentAssetVersionDetail(clientId, versionId);
  if (detail.isPending) return <SectionSkeleton rows={3} />;
  if (detail.isError) {
    return (
      <SectionErrorViewInline
        error={detail.error}
        what="the asset version's read-back"
        onRetry={() => void detail.refetch()}
      />
    );
  }
  const view = detail.data;
  if (view === undefined) return null;

  return (
    <div className="space-y-4">
      {view.versionsOfAsset.length > 1 ? (
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
            Versions of this asset ({view.versionsOfAsset.length}) — a correction is a NEW version
          </p>
          <ul className="mt-1 flex flex-col gap-1">
            {view.versionsOfAsset.map((entry) => (
              <li
                key={entry.versionId}
                className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-stone-600"
              >
                <span className="font-mono">v{entry.version}</span>
                <AssetLifecycleChip state={entry.lifecycleState} />
                <span className="font-mono text-stone-400">{entry.assetRef}</span>
                {entry.versionId === view.version.versionId ? (
                  <span className="text-stone-400">(this card)</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
          Lifecycle events (append-only)
        </p>
        {view.events.length === 0 ? (
          <p className="mt-1 text-sm leading-relaxed text-stone-600">
            No lifecycle events recorded yet.
          </p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1.5">
            {view.events.map((event) => (
              <li
                key={event.eventId}
                className="flex min-w-0 flex-wrap items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-3 py-2"
              >
                <Chip
                  label={event.eventKind}
                  className="border-stone-300 bg-stone-100 text-stone-700"
                />
                <span className="font-mono text-[11px] text-stone-500">
                  {event.fromState ?? "—"} → {event.toState}
                </span>
                <span className="ml-auto shrink-0 text-[11px] text-stone-400">
                  {formatWhen(event.provenance.recordedAt)}
                </span>
                {event.reason ? (
                  <p className="w-full text-xs leading-relaxed text-stone-600">{event.reason}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
          Quality observations (measured facts, never scores)
        </p>
        {view.observations.length === 0 ? (
          <p className="mt-1 text-sm leading-relaxed text-stone-600">
            No quality observations recorded on this version.
          </p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1">
            {view.observations.map((observation) => (
              <li
                key={observation.observationId}
                className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-stone-600"
              >
                <span className="font-mono">{observation.metric}</span>
                <span className="font-mono tabular-nums text-stone-800">
                  {observation.metricValueNumeric !== undefined
                    ? observation.metricValueNumeric
                    : observation.metricValueText ?? "—"}
                </span>
                <span className="ml-auto text-stone-400">
                  {formatWhen(observation.observedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// --- One transformation row (the lineage drill-down) ---------------------------------

function TransformationRow({
  clientId,
  transformation,
}: {
  clientId: string;
  transformation: ContentTransformationView;
}) {
  const execute = useExecuteContentTransformation(clientId);

  return (
    <ContentRecordCard
      id={`transformation-${transformation.transformationId}`}
      detailLabel="Frozen ingredients, output version and rights lineage"
        detail={(open) =>
          open ? (
            <TransformationDetailBody
              clientId={clientId}
              transformationId={transformation.transformationId}
            />
          ) : null
        }
      >
        <div className="space-y-2">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium text-stone-800">
                {transformation.transformationKind.replace(/_/g, " ")}
              </p>
              <p className="mt-0.5 text-sm text-stone-500">
                {transformation.engineId !== null ? `engine ${transformation.engineId}` : "engine resolved at request"}
                {" · "}
                requested {formatWhen(transformation.createdAt)}
                {transformation.completedAt
                  ? ` · completed ${formatWhen(transformation.completedAt)}`
                  : ""}
              </p>
            </div>
            <Chip
              label={transformation.status}
              className={
                transformation.status === "completed" || transformation.status === "succeeded"
                  ? "border-teal-800/20 bg-teal-50 text-teal-900"
                  : transformation.status === "failed"
                    ? "border-red-800/20 bg-red-50 text-red-900"
                    : "border-stone-300 bg-stone-100 text-stone-600"
              }
            />
          </div>

          {transformation.failureReason ? (
            <p className="text-sm leading-relaxed text-red-900/80">
              {transformation.failureReason}
            </p>
          ) : null}
          {transformation.outputVersionId ? (
            <p className="font-mono text-[11px] text-stone-400">
              output version {transformation.outputVersionId.slice(0, 12)}… (born derived, with
              lineage)
            </p>
          ) : (
            <p className="font-mono text-[11px] text-stone-400">no output version yet</p>
          )}

          {transformation.status === "requested" ? (
            <div className="flex flex-wrap items-center gap-2">
              <WorkspaceActionButton
                tone="plain"
                onClick={() => {
                  void execute
                    .mutateAsync({
                      transformationId: transformation.transformationId,
                    })
                    .catch(() => {
                      /* the toast carries the server's own words */
                    });
                }}
                disabled={execute.isPending}
                ariaLabel={`Execute the ${transformation.transformationKind} transformation`}
              >
                {execute.isPending ? "Executing…" : "Execute the transformation"}
              </WorkspaceActionButton>
              <span className="text-xs leading-relaxed text-stone-500">
                The module runner drives the execution authority; a completed run stores the
                output and records the derivation lineage. Re-runs converge on the recorded
                outcome.
              </span>
            </div>
          ) : null}
        </div>
    </ContentRecordCard>
  );
}

function TransformationDetailBody({
  clientId,
  transformationId,
}: {
  clientId: string;
  transformationId: string;
}) {
  const detail = useContentTransformationDetail(clientId, transformationId);
  const lineage = useRightsLineage(
    clientId,
    detail.data?.output?.assetRef ?? null,
  );

  if (detail.isPending) return <SectionSkeleton rows={3} />;
  if (detail.isError) {
    return (
      <SectionErrorViewInline
        error={detail.error}
        what="the transformation's read-back"
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
          Frozen ingredients (immutable, position-ordered)
        </p>
        {view.ingredients.length === 0 ? (
          <p className="mt-1 text-sm leading-relaxed text-stone-600">
            No ingredient rows recorded.
          </p>
        ) : (
          <ol className="mt-1 flex flex-col gap-1.5">
            {view.ingredients.map((ingredient) => (
              <li
                key={ingredient.ingredientId}
                className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-stone-200 bg-white px-3 py-2"
              >
                <span className="font-mono text-xs text-stone-500">
                  #{ingredient.position + 1}
                </span>
                <span className="font-mono text-xs text-stone-700">
                  {ingredient.inputAssetRef}
                </span>
                <span className="text-xs text-stone-500">
                  v{ingredient.inputVersionNumber}
                </span>
                <span className="ml-auto font-mono text-[11px] text-stone-400">
                  version:{ingredient.inputVersionId.slice(0, 8)}…
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>

      {view.output ? (
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
            Output version (born derived)
          </p>
          <div className="mt-1 rounded-lg border border-stone-200 bg-white px-3 py-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <AssetLifecycleChip state={view.output.lifecycleState} />
              <span className="font-mono text-xs text-stone-700">{view.output.assetRef}</span>
              <span className="text-xs text-stone-500">
                {view.output.mediaKind} · {view.output.contentType}
              </span>
              {view.output.objectSize !== undefined ? (
                <span className="font-mono text-[11px] text-stone-400">
                  · {(view.output.objectSize / 1024).toFixed(1)} KB
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-stone-500">
              {view.output.displayName ?? "Unnamed output"} — a derived version carries NO
              evidence anchor; the recorded transformation IS the provenance.
            </p>
          </div>
        </div>
      ) : (
        <p className="text-sm leading-relaxed text-stone-600">
          No output version yet — the transformation has not completed.
        </p>
      )}

      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
          Rights lineage links (the 063 conjunction seam — recorded during execution)
        </p>
        {lineage.isPending ? (
          <p className="mt-1 text-sm text-stone-500">loading the lineage links…</p>
        ) : lineage.isError ? (
          <p className="mt-1 text-sm leading-relaxed text-stone-600">
            The lineage read refused — a composite with no lineage links is blocked outright at
            the rights gate (the lineage-mandatory rule).
          </p>
        ) : (lineage.data ?? []).length === 0 ? (
          <p className="mt-1 text-sm leading-relaxed text-stone-600">
            No lineage links recorded for this output — a composite without lineage links is
            blocked outright at the rights gate (sourceLineageRequired).
          </p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1.5">
            {(lineage.data ?? []).map((link) => (
              <li
                key={link.lineageLinkId}
                className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-stone-200 bg-white px-3 py-2"
              >
                <span className="font-mono text-xs text-stone-500">ingredient</span>
                <span className="font-mono text-xs text-stone-700">
                  {link.ingredientAssetRef}
                </span>
                <span className="ml-auto text-[11px] text-stone-400">
                  {formatWhen(link.provenance.recordedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
          Requested parameters and output spec (verbatim)
        </p>
        <LabeledRows record={view.transformation.parameters} label="parameters" />
        <div className="mt-2">
          <LabeledRows record={view.transformation.outputSpec} label="output spec" />
        </div>
      </div>
    </div>
  );
}

// --- The register-asset dialog --------------------------------------------------------

function RegisterAssetGate({
  clientId,
  open,
  onOpenChange,
  evidenceList,
  busy,
  existingAssets,
  onSubmit,
}: {
  clientId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  evidenceList: EvidenceRecord[] | undefined;
  busy: boolean;
  existingAssets: ContentAssetVersionView[];
  onSubmit: (payload: {
    mediaKind: string;
    displayName: string;
    contentType: string;
    sourceEvidenceRef: string;
    assetId?: string;
  }) => void;
}) {
  const evidence = useClientEvidence(clientId);
  const list = evidenceList ?? evidence.data ?? [];
  const [mediaKind, setMediaKind] = React.useState<string>("video");
  const [displayName, setDisplayName] = React.useState("");
  const [contentType, setContentType] = React.useState("video/mp4");
  const [sourceEvidenceRef, setSourceEvidenceRef] = React.useState("");
  const [assetId, setAssetId] = React.useState("");

  const options = evidenceOptions(list);
  const assetOptions = [
    { value: "", label: "— a new logical asset —" },
    ...existingAssets
      .filter((entry, index, all) => all.findIndex((other) => other.assetId === entry.assetId) === index)
      .map((entry) => ({
        value: entry.assetId,
        label: `next version of: ${entry.displayName ?? entry.assetRef} (currently v${entry.version})`,
      })),
  ];

  const valid = displayName.trim() !== "" && sourceEvidenceRef !== "";

  return (
    <ConfirmGate
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onOpenChange(false);
      }}
      title="Register an asset version"
      consequence="This records a NEW immutable asset version — born draft, with the evidence record cited as its source provenance (the REQUIRED anchor the rights pipeline and the candidate linkage share). A version never changes in place: a correction is a NEW version with a NEW minted ref. Materialization (storing the real bytes) is a separate move."
      confirmLabel="Register the version"
      confirmTone="default"
      busy={busy}
      onConfirm={() => {
        if (!valid) return;
        onSubmit({
          mediaKind,
          displayName: displayName.trim(),
          contentType: contentType.trim(),
          sourceEvidenceRef,
          ...(assetId === "" ? {} : { assetId }),
        });
      }}
    >
      <div className="mt-1 space-y-3">
        <TextField
          id="asset-display-name"
          label="Display name"
          value={displayName}
          onChange={setDisplayName}
          placeholder="e.g. Widget explainer — source cut"
          required
          invalid={open && displayName.trim() === ""}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField
            id="asset-media-kind"
            label="Media kind"
            value={mediaKind}
            onChange={setMediaKind}
            options={vocabOptions(MEDIA_KINDS)}
          />
          <TextField
            id="asset-content-type"
            label="Content type"
            value={contentType}
            onChange={setContentType}
            placeholder="e.g. video/mp4"
            required
            hint="The MIME type, 3–100 characters."
          />
        </div>
        {assetOptions.length > 1 ? (
          <SelectField
            id="asset-existing"
            label="Existing asset (optional)"
            value={assetId}
            onChange={setAssetId}
            options={assetOptions}
            hint="Pick an existing logical asset to record its NEXT explicit version — the correction discipline."
          />
        ) : null}
        {evidence.isPending ? (
          <p className="text-sm text-stone-500">loading the client&apos;s evidence ledger…</p>
        ) : evidence.isError ? (
          <SectionErrorViewInline
            error={evidence.error}
            what="the evidence ledger"
            onRetry={() => void evidence.refetch()}
          />
        ) : options.length === 0 ? (
          <p className="text-sm leading-relaxed text-stone-600">
            The client holds no evidence records yet — an asset version requires a real evidence
            reference as its source provenance. Record evidence first (research a fact into the
            ledger above).
          </p>
        ) : (
          <SelectField
            id="asset-source-evidence"
            label="Source evidence (required)"
            value={sourceEvidenceRef}
            onChange={setSourceEvidenceRef}
            options={[{ value: "", label: "— pick an evidence record —" }, ...options]}
            required
            invalid={open && sourceEvidenceRef === ""}
            hint="The evidence record that proves where this material came from — the candidate's evidence link is the natural anchor."
          />
        )}
      </div>
    </ConfirmGate>
  );
}

// --- The request-transformation dialog ------------------------------------------------

function RequestTransformationGate({
  clientId,
  open,
  onOpenChange,
  versions,
  busy,
  onSubmit,
}: {
  clientId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  versions: ContentAssetVersionView[];
  busy: boolean;
  onSubmit: (payload: {
    transformationKind: string;
    parameters: Record<string, unknown>;
    outputSpec: Record<string, unknown>;
    ingredients: Array<{ assetId: string; version: number }>;
    engineId?: string;
    workspaceId: string;
  }) => void;
}) {
  const workspaces = useWorkspaces(clientId);
  const materialized = versions.filter((version) => version.lifecycleState === "materialized");
  const [transformationKind, setTransformationKind] = React.useState<string>("compilation");
  const [pickedIngredients, setPickedIngredients] = React.useState<string[]>([]);
  const [outputDisplayName, setOutputDisplayName] = React.useState("");
  const [outputMediaKind, setOutputMediaKind] = React.useState<string>("video");
  const [engineId, setEngineId] = React.useState("");
  const [parameters, setParameters] = React.useState<Array<{ key: string; value: string }>>([]);
  const [workspaceId, setWorkspaceId] = React.useState("");

  const workspaceList = workspaces.data ?? [];
  const effectiveWorkspaceId =
    workspaceId !== ""
      ? workspaceId
      : workspaceList[0] !== undefined
        ? workspaceList[0].workspaceId
        : "";

  const parsedParameters: Record<string, unknown> = {};
  for (const row of parameters) {
    const key = row.key.trim();
    if (key === "") continue;
    const raw = row.value.trim();
    parsedParameters[key] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
  }

  const ingredients = pickedIngredients
    .map((versionId) => versions.find((version) => version.versionId === versionId))
    .filter((version): version is ContentAssetVersionView => version !== undefined)
    .map((version) => ({ assetId: version.assetId, version: version.version }));

  const valid =
    pickedIngredients.length > 0 &&
    outputDisplayName.trim() !== "" &&
    effectiveWorkspaceId !== "";

  return (
    <ConfirmGate
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onOpenChange(false);
      }}
      title="Request a transformation"
      consequence="This requests one transformation: the kind, the EXPLICIT ingredient versions (frozen at request time), the parameters and the output spec are recorded, an execution is created through the executions authority, and the engine registry resolves the runner. A draft ingredient cannot be transformed — only materialized versions. Executing the request is the next, separate action."
      confirmLabel="Request the transformation"
      confirmTone="default"
      busy={busy}
      onConfirm={() => {
        if (!valid) return;
        onSubmit({
          transformationKind,
          parameters: parsedParameters,
          outputSpec: {
            mediaKind: outputMediaKind,
            displayName: outputDisplayName.trim(),
          },
          ingredients,
          ...(engineId.trim() === "" ? {} : { engineId: engineId.trim() }),
          workspaceId: effectiveWorkspaceId,
        });
      }}
    >
      <div className="mt-1 space-y-3">
        <SelectField
          id="transformation-kind"
          label="Transformation kind"
          value={transformationKind}
          onChange={setTransformationKind}
          options={vocabOptions(TRANSFORMATION_KINDS)}
        />
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
            Ingredient versions (at least one; materialized only)
          </p>
          {materialized.length === 0 ? (
            <p className="mt-1 text-sm leading-relaxed text-stone-600">
              No materialized versions exist yet — a transformation consumes materialized
              ingredients only. Materialize an asset version with the operator&apos;s own file
              first.
            </p>
          ) : (
            <ul className="mos-scroll mt-1 flex max-h-48 flex-col gap-1.5 overflow-y-auto pr-1">
              {materialized.map((version) => {
                const selected = pickedIngredients.includes(version.versionId);
                return (
                  <li key={version.versionId}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      onClick={() =>
                        setPickedIngredients(
                          selected
                            ? pickedIngredients.filter((entry) => entry !== version.versionId)
                            : [...pickedIngredients, version.versionId].slice(0, 16),
                        )
                      }
                      className={`flex min-h-[44px] w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border px-3 py-2 text-left transition-colors focus-visible:ring-2 focus-visible:ring-teal-700 ${
                        selected
                          ? "border-teal-800/25 bg-teal-50"
                          : "border-stone-200 bg-white hover:bg-stone-50"
                      }`}
                    >
                      <span className="text-sm font-medium text-stone-800">
                        {version.displayName ?? "Unnamed asset"}
                      </span>
                      <span className="font-mono text-[11px] text-stone-500">
                        v{version.version} · {version.assetRef.slice(0, 16)}…
                        {version.objectSize !== undefined
                          ? ` · ${(version.objectSize / 1024).toFixed(1)} KB`
                          : ""}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <TextField
          id="transformation-output-name"
          label="Output display name"
          value={outputDisplayName}
          onChange={setOutputDisplayName}
          placeholder="e.g. Compiled output"
          required
          invalid={open && outputDisplayName.trim() === ""}
        />
        <SelectField
          id="transformation-output-kind"
          label="Output media kind"
          value={outputMediaKind}
          onChange={setOutputMediaKind}
          options={vocabOptions(MEDIA_KINDS)}
        />
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
            Parameters (optional, per-kind)
          </p>
          <div className="mt-1 space-y-1.5">
            {parameters.map((row, index) => (
              <div key={index} className="flex gap-2">
                <input
                  id={`transformation-param-key-${index}`}
                  type="text"
                  value={row.key}
                  onChange={(event) =>
                    setParameters(
                      parameters.map((entry, i) =>
                        i === index ? { ...entry, key: event.target.value } : entry,
                      ),
                    )
                  }
                  placeholder="key (e.g. layout)"
                  aria-label={`parameter key ${index + 1}`}
                  className="min-w-0 flex-1 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-800 placeholder:text-stone-400 focus-visible:ring-2 focus-visible:ring-teal-700"
                />
                <input
                  id={`transformation-param-value-${index}`}
                  type="text"
                  value={row.value}
                  onChange={(event) =>
                    setParameters(
                      parameters.map((entry, i) =>
                        i === index ? { ...entry, value: event.target.value } : entry,
                      ),
                    )
                  }
                  placeholder="value (e.g. top-bottom)"
                  aria-label={`parameter value ${index + 1}`}
                  className="min-w-0 flex-1 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-800 placeholder:text-stone-400 focus-visible:ring-2 focus-visible:ring-teal-700"
                />
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setParameters([...parameters, { key: "", value: "" }])}
            className="mt-1.5 text-xs font-medium text-stone-500 underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-teal-700"
          >
            + another parameter
          </button>
        </div>
        <TextField
          id="transformation-engine"
          label="Engine id (optional)"
          value={engineId}
          onChange={setEngineId}
          placeholder="leave empty to let the registry resolve"
          hint="A production deployment registers NO engines by default (the fail-closed discipline); a deployment with registered engines resolves the runner — an unknown engine refuses honestly."
        />
        {workspaces.isPending ? (
          <p className="text-sm text-stone-500">loading the client&apos;s workspaces…</p>
        ) : workspaceList.length === 0 ? (
          <p className="text-sm leading-relaxed text-amber-900">
            This client has no workspace yet — a transformation request is workspace-scoped (the
            REQUIRED narrowing). Create a workspace first.
          </p>
        ) : (
          <SelectField
            id="transformation-workspace"
            label="Workspace (required)"
            value={effectiveWorkspaceId}
            onChange={setWorkspaceId}
            options={workspaceList.map((workspace) => ({
              value: workspace.workspaceId,
              label: workspace.name,
            }))}
          />
        )}
      </div>
    </ConfirmGate>
  );
}
