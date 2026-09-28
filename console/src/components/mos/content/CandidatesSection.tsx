"use client";

// UX-006 — the CANDIDATES family of the Content/Rights surface: the
// client's content candidates (MKT-062 Content Intelligence) as
// operational cards — the §6 observed-feature set, the EVIDENCE links with
// their provenance (the SourceRefList discipline over the /evidence
// ledger), the HYPOTHESES citing each candidate as the DISTINCT derived
// register (never merged into the evidence), and the honest rights state
// per candidate composed from the MKT-063 records through the shared
// /evidence reference. Composed ONLY from:
//
//   GET  /api/clients/:clientId/content-intelligence/candidates   the candidates
//   GET  /api/clients/:clientId/content-intelligence/hypotheses   the hypotheses
//   GET  /api/clients/:clientId/evidence                          the evidence ledger (the provenance join)
//   POST /api/clients/:clientId/content-intelligence/candidates   record one candidate (owner|admin)
//   POST /api/clients/:clientId/content-intelligence/hypotheses   record one hypothesis (owner|admin)
//   GET  /api/clients/:clientId/content-rights                    the rights records (the per-candidate rights state join)
//   GET  /api/clients/:clientId/content-assets                    the asset versions (the candidate→asset join)
//
// The rights state per candidate is a JOIN over real records: the asset
// versions (and the rights records) whose REQUIRED /evidence anchor is
// one of the candidate's own evidence links — the exact anchor both
// authorities require on registration. When nothing matches, the card
// renders the honest "no rights record yet" with the REAL next action
// (register the asset, then the rights record — the authorities' own
// routes), never a silent dead end.

import * as React from "react";
import { ScrollText } from "lucide-react";
import {
  useClientEvidence,
  useContentAssets,
  useContentCandidates,
  useContentHypotheses,
  useContentRights,
  useRecordContentCandidate,
  useRecordContentHypothesis,
} from "@/components/mos/hooks";
import type {
  ContentAssetVersionView,
  ContentCandidateView,
  ContentHypothesisView,
  ContentRightsRecordView,
  EvidenceRecord,
} from "@/lib/mos-api";
import {
  CandidateSignalChip,
  Chip,
  ConfirmGate,
  ContentRecordCard,
  EvidenceProvenanceRows,
  HypothesisBlock,
  InPageLink,
  LabeledRows,
  RightsStateChip,
  SectionSkeleton,
  SelectField,
  SourceLine,
  TextField,
  formatWhen,
  provenanceString,
} from "./content-atoms";
import {
  SectionErrorView as SectionErrorViewInline,
  WorkspaceActionButton,
  WorkspaceEmptyState,
} from "@/components/mos/mission/workspace-atoms";

// The frozen ci-vocab-v1 option sets (mirrored for the record form; the
// route rejects anything else with its own 422 words — the server stays
// the vocabulary authority).
const FORMATS = [
  "short_video", "long_video", "live_stream", "image_post", "carousel", "text_post",
  "thread", "story", "article", "podcast", "webinar", "infographic",
] as const;
const LENGTH_UNITS = ["seconds", "minutes", "hours", "words", "items"] as const;
const HOOK_FEATURES = [
  "question", "bold_claim", "curiosity_gap", "numbered_list", "contrarian", "emotional",
  "urgency", "identity_callout", "pattern_interrupt", "offer_or_price", "testimonial_lead",
  "statistic_lead",
] as const;
const NARRATIVES = [
  "problem_solution", "tutorial", "listicle", "story_arc", "before_after", "myth_busting",
  "comparison", "behind_the_scenes", "interview", "commentary", "reaction", "case_study",
  "news_report", "entertainment_bit",
] as const;
const AUDIENCE_FITS = ["strong_fit", "moderate_fit", "weak_fit", "unclear"] as const;
const FRESHNESS = ["breaking", "recent", "established", "evergreen", "dated"] as const;
const NOVELTY = ["novel", "variation", "common", "saturated"] as const;
const REUSE_RISK = ["low", "medium", "high", "unclear"] as const;
const HYPOTHESIS_KINDS = [
  "format_hypothesis", "topic_hypothesis", "hook_hypothesis", "narrative_hypothesis",
  "timing_hypothesis", "length_hypothesis", "audience_hypothesis", "distribution_hypothesis",
] as const;

function vocabOptions(values: readonly string[]): Array<{ value: string; label: string }> {
  return values.map((value) => ({ value, label: value.replace(/_/g, " ") }));
}

type KeyValueDraft = { key: string; value: string };

function parseKeyValueRows(rows: KeyValueDraft[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key === "") continue;
    const raw = row.value.trim();
    out[key] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
  }
  return out;
}

function KeyValueEditor({
  idPrefix,
  label,
  rows,
  onRowsChange,
  hint,
}: {
  idPrefix: string;
  label: string;
  rows: KeyValueDraft[];
  onRowsChange: (rows: KeyValueDraft[]) => void;
  hint?: string;
}) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-stone-500">{label}</p>
      <div className="mt-1 space-y-1.5">
        {rows.map((row, index) => (
          <div key={index} className="flex gap-2">
            <input
              id={`${idPrefix}-key-${index}`}
              type="text"
              value={row.key}
              onChange={(event) =>
                onRowsChange(
                  rows.map((entry, i) => (i === index ? { ...entry, key: event.target.value } : entry)),
                )
              }
              placeholder="key (e.g. views)"
              aria-label={`${label} key ${index + 1}`}
              className="min-w-0 flex-1 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-800 placeholder:text-stone-400 focus-visible:ring-2 focus-visible:ring-teal-700"
            />
            <input
              id={`${idPrefix}-value-${index}`}
              type="text"
              value={row.value}
              onChange={(event) =>
                onRowsChange(
                  rows.map((entry, i) => (i === index ? { ...entry, value: event.target.value } : entry)),
                )
              }
              placeholder="value (e.g. 4831)"
              aria-label={`${label} value ${index + 1}`}
              className="min-w-0 flex-1 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-800 placeholder:text-stone-400 focus-visible:ring-2 focus-visible:ring-teal-700"
            />
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onRowsChange([...rows, { key: "", value: "" }])}
        className="mt-1.5 text-xs font-medium text-stone-500 underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-teal-700"
      >
        + another row
      </button>
      {hint ? <p className="mt-1 text-xs leading-relaxed text-stone-500">{hint}</p> : null}
    </div>
  );
}

/** The joined view of one candidate: its evidence ledger records, the asset
 *  versions anchored on the same evidence, and the rights records for those
 *  assets — all REAL records, joined through the /evidence reference. */
type CandidateJoin = {
  evidenceById: Map<string, EvidenceRecord>;
  assetsByEvidence: Map<string, ContentAssetVersionView[]>;
  rightsByAssetRef: Map<string, ContentRightsRecordView>;
};

export function CandidatesSection({ clientId }: { clientId: string }) {
  const candidates = useContentCandidates(clientId);
  const hypotheses = useContentHypotheses(clientId);
  const evidence = useClientEvidence(clientId);
  const rights = useContentRights(clientId);
  const assets = useContentAssets(clientId);
  const recordCandidate = useRecordContentCandidate(clientId);

  const [recordOpen, setRecordOpen] = React.useState(false);

  const list = candidates.data ?? [];
  const hypothesisList = hypotheses.data ?? [];
  const evidenceList = evidence.data ?? [];
  const rightsList = rights.data ?? [];
  const assetList = assets.data ?? [];

  const join: CandidateJoin = React.useMemo(
    () => ({
      evidenceById: new Map(evidenceList.map((record) => [record.evidenceId, record])),
      assetsByEvidence: (() => {
        const map = new Map<string, ContentAssetVersionView[]>();
        for (const asset of assetList) {
          if (asset.sourceEvidenceRef === null) continue;
          const current = map.get(asset.sourceEvidenceRef) ?? [];
          current.push(asset);
          map.set(asset.sourceEvidenceRef, current);
        }
        return map;
      })(),
      rightsByAssetRef: new Map(rightsList.map((record) => [record.contentAssetRef, record])),
    }),
    [evidenceList, assetList, rightsList],
  );

  return (
    <section id="content-candidates-section" aria-labelledby="content-candidates-heading" className="space-y-3">
      <div>
        <h3 id="content-candidates-heading" className="flex items-center gap-2 font-medium text-stone-800">
          <ScrollText className="size-4 text-stone-400" aria-hidden="true" />
          Content candidates
        </h3>
        <p className="mt-0.5 text-sm leading-relaxed text-stone-600">
          The observed content this client is considering — each candidate carries its §6
          observed-feature set and its EVIDENCE links (what was actually observed, where, when).
          Hypotheses about why a candidate performs are recorded as the SEPARATE derived register
          and never merged into the evidence. A candidate with no rights record yet shows the
          honest not-requested state with the real next action.
        </p>
      </div>

      {candidates.isPending ? (
        <SectionSkeleton rows={3} />
      ) : candidates.isError ? (
        <SectionErrorViewInline
          error={candidates.error}
          what="the content candidates"
          onRetry={() => void candidates.refetch()}
        />
      ) : (
        <>
          {list.length === 0 ? (
            <WorkspaceEmptyState
              missing="No content candidates yet — research a niche to start."
              why="A candidate is the observed-feature record of content that worked somewhere: format, hooks, narrative, performance. Each one cites the client's evidence ledger, so its provenance stays checkable."
              next="Run research above and record a retained fact as client evidence, then record the candidate from that evidence — or record a candidate directly from any evidence the client already holds."
              action={
                <div className="flex flex-wrap gap-2">
                  <InPageLink targetId="content-research-section">Go to Research above</InPageLink>
                  <WorkspaceActionButton
                    onClick={() => setRecordOpen(true)}
                    ariaLabel="Record a content candidate"
                  >
                    Record a candidate
                  </WorkspaceActionButton>
                </div>
              }
            />
          ) : (
            <ul className="flex flex-col gap-3">
              {list.map((candidate) => (
                <CandidateCard
                  key={candidate.contentCandidateId}
                  clientId={clientId}
                  candidate={candidate}
                  join={join}
                  citingHypotheses={hypothesisList.filter((hypothesis) =>
                    hypothesis.candidateIds.includes(candidate.contentCandidateId),
                  )}
                />
              ))}
            </ul>
          )}

          {list.length > 0 ? (
            <div>
              <WorkspaceActionButton
                tone="plain"
                onClick={() => setRecordOpen(true)}
                ariaLabel="Record another content candidate"
              >
                Record another candidate
              </WorkspaceActionButton>
            </div>
          ) : null}
        </>
      )}

      <RecordCandidateGate
        clientId={clientId}
        open={recordOpen}
        onOpenChange={setRecordOpen}
        evidenceList={evidenceList}
        evidencePending={evidence.isPending}
        evidenceError={evidence.isError ? evidence.error : null}
        onRetryEvidence={() => void evidence.refetch()}
        busy={recordCandidate.isPending}
        onSubmit={(payload) => {
          void recordCandidate
            .mutateAsync(payload)
            .catch(() => {
              /* the toast carries the server's own words */
            })
            .finally(() => setRecordOpen(false));
        }}
      />

      <SourceLine
        sources={[
          `GET /api/clients/${clientId.slice(0, 8)}…/content-intelligence/candidates (+ hypotheses)`,
          "GET …/evidence (the provenance join for every evidence link)",
          "GET …/content-rights + …/content-assets (the per-candidate rights state, joined through the shared evidence reference)",
          "POST …/content-intelligence/candidates | hypotheses (record)",
        ]}
      />
    </section>
  );
}

// --- One candidate card ------------------------------------------------------------

function CandidateCard({
  clientId,
  candidate,
  join,
  citingHypotheses,
}: {
  clientId: string;
  candidate: ContentCandidateView;
  join: CandidateJoin;
  citingHypotheses: ContentHypothesisView[];
}) {
  // The candidate→asset→rights join (over REAL records): the asset versions
  // whose REQUIRED /evidence anchor is one of this candidate's evidence
  // links, then the rights record for that asset's minted ref.
  const linkedAssets = candidate.evidenceIds
    .flatMap((evidenceId) => join.assetsByEvidence.get(evidenceId) ?? [])
    .filter(
      (asset, index, all) => all.findIndex((other) => other.assetRef === asset.assetRef) === index,
    );
  const linkedRights =
    linkedAssets
      .map((asset) => join.rightsByAssetRef.get(asset.assetRef))
      .find((record) => record !== undefined) ?? null;

  const firstEvidence =
    candidate.evidenceIds[0] !== undefined
      ? join.evidenceById.get(candidate.evidenceIds[0])
      : undefined;

  return (
    <ContentRecordCard
      id={`candidate-${candidate.contentCandidateId}`}
      detailLabel="Evidence links, observed features, hypotheses and rights linkage"
        detail={(open) =>
          open ? (
            <CandidateDetailBody
              clientId={clientId}
              candidate={candidate}
              evidenceById={join.evidenceById}
              citingHypotheses={citingHypotheses}
            />
          ) : null
        }
      >
        <div className="space-y-2">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate font-medium text-stone-800">{candidate.topicEntity}</p>
              <p className="mt-0.5 truncate text-sm text-stone-500">
                {candidate.niche}
                {candidate.subNiche ? ` · ${candidate.subNiche}` : ""}
                {" · "}
                {candidate.contentFormat.replace(/_/g, " ")}
              </p>
            </div>
            <span className="shrink-0 text-xs text-stone-400">
              observed {formatWhen(provenanceString(candidate.provenance, "recordedAt"))}
            </span>
          </div>

          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <Chip
              label={candidate.contentFormat.replace(/_/g, " ")}
              className="border-stone-300 bg-stone-100 text-stone-700"
            />
            <CandidateSignalChip kind="audience fit" value={candidate.audienceFit} />
            <CandidateSignalChip kind="freshness" value={candidate.freshness} />
            <CandidateSignalChip kind="novelty" value={candidate.novelty} />
            <CandidateSignalChip kind="reuse risk" value={candidate.reuseRisk} />
            {candidate.lengthValue !== undefined ? (
              <Chip
                label={`${candidate.lengthValue} ${candidate.lengthUnit ?? ""}`.trim()}
                className="border-stone-200 bg-stone-50 text-stone-600"
              />
            ) : null}
          </div>

          <p className="font-mono text-[11px] leading-relaxed text-stone-400">
            {candidate.evidenceIds.length} evidence link(s)
            {firstEvidence
              ? ` · ${firstEvidence.source.system}${firstEvidence.source.ref ? ` · ${firstEvidence.source.ref}` : ""} · observed ${formatWhen(firstEvidence.observedAt)}`
              : " · the cited evidence is not in the current ledger"}
            {candidate.metricObservationIds.length > 0
              ? ` · ${candidate.metricObservationIds.length} metric anchor(s)`
              : ""}
          </p>

          <CandidateRightsLine
            linkedAsset={linkedAssets[0] ?? null}
            linkedRights={linkedRights}
            evidenceMissing={candidate.evidenceIds.length === 0}
          />
        </div>
    </ContentRecordCard>
  );
}

/** The per-candidate rights line — the honest gate state + next action. */
function CandidateRightsLine({
  linkedAsset,
  linkedRights,
  evidenceMissing,
}: {
  linkedAsset: ContentAssetVersionView | null;
  linkedRights: ContentRightsRecordView | null;
  evidenceMissing: boolean;
}) {
  if (evidenceMissing) {
    return (
      <div className="rounded-lg border border-amber-700/20 bg-amber-50/60 px-3 py-2">
        <p className="text-xs leading-relaxed text-amber-900">
          No evidence links on this record — the rights linkage and the asset pipeline both anchor
          on the /evidence reference, so nothing can be requested for it.
        </p>
      </div>
    );
  }
  if (linkedRights !== null) {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-stone-500">Rights:</span>
        <RightsStateChip state={linkedRights.state} />
        <InPageLink targetId={`rights-card-${linkedRights.rightsRecordId}`}>
          Open the rights record
        </InPageLink>
      </div>
    );
  }
  if (linkedAsset !== null) {
    return (
      <div className="rounded-lg border border-amber-700/20 bg-amber-50/60 px-3 py-2">
        <p className="text-xs leading-relaxed text-amber-900">
          No rights record yet for asset{" "}
          <span className="font-mono">{linkedAsset.assetRef}</span> (the asset version registered
          from this candidate&apos;s evidence). Before anything publishes, the rights record must
          be registered and its state determined — the gate fails closed on an absent record.
        </p>
        <p className="mt-1 text-xs leading-relaxed text-amber-900/80">
          Next action: register the rights record in the Rights family below, citing this
          candidate&apos;s evidence as the source provenance.
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-amber-700/20 bg-amber-50/60 px-3 py-2">
      <p className="text-xs leading-relaxed text-amber-900">
        No rights record and no asset version are linked to this candidate yet — nothing has been
        requested. The pipeline anchors on the candidate&apos;s /evidence reference: an asset
        version is registered from it (the platform mints the asset ref), then the rights record
        for that ref.
      </p>
      <p className="mt-1 text-xs leading-relaxed text-amber-900/80">
        Next action: register the asset version in the Assets family below (the source evidence
        comes pre-filled from this candidate), then the rights record.
      </p>
    </div>
  );
}

// --- The candidate drill-down --------------------------------------------------------

function CandidateDetailBody({
  clientId,
  candidate,
  evidenceById,
  citingHypotheses,
}: {
  clientId: string;
  candidate: ContentCandidateView;
  evidenceById: Map<string, EvidenceRecord>;
  citingHypotheses: ContentHypothesisView[];
}) {
  const recordHypothesis = useRecordContentHypothesis(clientId);
  const [hypothesisOpen, setHypothesisOpen] = React.useState(false);
  const [hypothesisKind, setHypothesisKind] = React.useState<string>(HYPOTHESIS_KINDS[0]);
  const [summary, setSummary] = React.useState("");

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-teal-900/70">
          Evidence links — the observed facts this candidate is built from
        </p>
        <div className="mt-1">
          <EvidenceProvenanceRows evidenceIds={candidate.evidenceIds} evidenceById={evidenceById} />
        </div>
      </div>

      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
          The §6 observed-feature record (verbatim)
        </p>
        <LabeledRows
          record={{
            topic_entity: candidate.topicEntity,
            niche: candidate.niche,
            ...(candidate.subNiche === undefined ? {} : { sub_niche: candidate.subNiche }),
            content_format: candidate.contentFormat,
            ...(candidate.lengthValue === undefined
              ? {}
              : { length_value: candidate.lengthValue, length_unit: candidate.lengthUnit ?? "" }),
            hook_features: candidate.hookFeatures,
            narrative_structure: candidate.narrativeStructure,
            ...(candidate.publishedAt === undefined ? {} : { published_at: candidate.publishedAt }),
            observed_performance: candidate.observedPerformance,
            ...(candidate.performanceVelocity === undefined
              ? {}
              : { performance_velocity: candidate.performanceVelocity }),
            ...(candidate.engagement === undefined ? {} : { engagement: candidate.engagement }),
          }}
        />
      </div>

      <HypothesisBlock
        hypotheses={citingHypotheses}
        onRecord={() => setHypothesisOpen(true)}
      />

      <ConfirmGate
        open={hypothesisOpen}
        onOpenChange={(open) => {
          if (!open) {
            setHypothesisOpen(false);
            setSummary("");
          }
        }}
        title="Record a hypothesis citing this candidate"
        consequence="This records one hypothesis claim: a DERIVED register record, evidence-linked, that feeds experiments — never a conclusion about what will work for this account. Corrections are new superseding records; the append-only history stays readable."
        confirmLabel="Record the hypothesis"
        confirmTone="default"
        busy={recordHypothesis.isPending}
        onConfirm={() => {
          void recordHypothesis
            .mutateAsync({
              hypothesisKind,
              statement: summary.trim() === "" ? {} : { summary: summary.trim() },
              evidenceIds: candidate.evidenceIds,
              candidateIds: [candidate.contentCandidateId],
            })
            .catch(() => {
              /* the toast carries the server's own words */
            })
            .finally(() => {
              setHypothesisOpen(false);
              setSummary("");
            });
        }}
      >
        <div className="mt-1 space-y-3">
          <SelectField
            id="hypothesis-kind"
            label="Hypothesis kind"
            value={hypothesisKind}
            onChange={setHypothesisKind}
            options={vocabOptions(HYPOTHESIS_KINDS)}
          />
          <TextField
            id="hypothesis-summary"
            label="Statement summary"
            value={summary}
            onChange={setSummary}
            placeholder="e.g. Question-led hooks lift early retention for this niche"
            hint="The claim, in one sentence. It cites this candidate and its evidence links; experiments test it."
          />
          <p className="text-xs leading-relaxed text-stone-500">
            Evidence links: all {candidate.evidenceIds.length} of this candidate&apos;s evidence
            records, cited as the hypothesis&apos;s evidence. Candidate references: this candidate.
            The non-causal framing ships on the record.
          </p>
        </div>
      </ConfirmGate>
    </div>
  );
}

// --- The record-candidate dialog ------------------------------------------------------

function RecordCandidateGate({
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
    features: {
      topicEntity: string;
      niche: string;
      subNiche?: string;
      contentFormat: string;
      lengthValue?: number;
      lengthUnit?: string;
      hookFeatures: string[];
      narrativeStructure: string;
      observedPerformance: Record<string, unknown>;
      audienceFit: string;
      freshness: string;
      novelty: string;
      reuseRisk: string;
    };
    evidenceIds: string[];
    metricObservationIds: string[];
  }) => void;
}) {
  void clientId;
  const [topicEntity, setTopicEntity] = React.useState("");
  const [niche, setNiche] = React.useState("");
  const [subNiche, setSubNiche] = React.useState("");
  const [contentFormat, setContentFormat] = React.useState<string>(FORMATS[0]);
  const [lengthValue, setLengthValue] = React.useState("");
  const [lengthUnit, setLengthUnit] = React.useState<string>(LENGTH_UNITS[0]);
  const [hookFeatures, setHookFeatures] = React.useState<string[]>([]);
  const [narrativeStructure, setNarrativeStructure] = React.useState<string>(NARRATIVES[0]);
  const [observedPerformance, setObservedPerformance] = React.useState<KeyValueDraft[]>([
    { key: "", value: "" },
  ]);
  const [audienceFit, setAudienceFit] = React.useState<string>(AUDIENCE_FITS[0]);
  const [freshness, setFreshness] = React.useState<string>(FRESHNESS[0]);
  const [novelty, setNovelty] = React.useState<string>(NOVELTY[0]);
  const [reuseRisk, setReuseRisk] = React.useState<string>(REUSE_RISK[0]);
  const [evidencePick, setEvidencePick] = React.useState<string[]>([]);

  const parsedPerformance = parseKeyValueRows(observedPerformance);
  const valid =
    topicEntity.trim() !== "" &&
    niche.trim() !== "" &&
    Object.keys(parsedPerformance).length > 0 &&
    evidencePick.length > 0;

  return (
    <ConfirmGate
      open={open}
      onOpenChange={onOpenChange}
      title="Record a content candidate"
      consequence="This records one append-only candidate: the §6 observed-feature set as data, with at least one of the client's evidence records cited as its provenance. Candidates are observed features — never conclusions; the record never feeds publication without the rights pipeline."
      confirmLabel="Record the candidate"
      confirmTone="default"
      busy={busy}
      onConfirm={() => {
        if (!valid) return;
        onSubmit({
          features: {
            topicEntity: topicEntity.trim(),
            niche: niche.trim(),
            ...(subNiche.trim() === "" ? {} : { subNiche: subNiche.trim() }),
            contentFormat,
            ...(lengthValue.trim() === ""
              ? {}
              : { lengthValue: Number(lengthValue), lengthUnit }),
            hookFeatures,
            narrativeStructure,
            observedPerformance: parsedPerformance,
            audienceFit,
            freshness,
            novelty,
            reuseRisk,
          },
          evidenceIds: evidencePick,
          metricObservationIds: [],
        });
      }}
    >
      <div className="mt-1 space-y-3">
        <TextField
          id="candidate-topic-entity"
          label="Topic entity"
          value={topicEntity}
          onChange={setTopicEntity}
          placeholder="e.g. Widget analytics explainer"
          required
          invalid={open && topicEntity.trim() === ""}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            id="candidate-niche"
            label="Niche"
            value={niche}
            onChange={setNiche}
            placeholder="e.g. widgets"
            required
            invalid={open && niche.trim() === ""}
          />
          <TextField
            id="candidate-sub-niche"
            label="Sub-niche"
            value={subNiche}
            onChange={setSubNiche}
            placeholder="e.g. premium widgets"
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField
            id="candidate-format"
            label="Content format"
            value={contentFormat}
            onChange={setContentFormat}
            options={vocabOptions(FORMATS)}
          />
          <SelectField
            id="candidate-narrative"
            label="Narrative structure"
            value={narrativeStructure}
            onChange={setNarrativeStructure}
            options={vocabOptions(NARRATIVES)}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            id="candidate-length-value"
            label="Length value"
            value={lengthValue}
            onChange={setLengthValue}
            placeholder="e.g. 45"
            type="number"
          />
          <SelectField
            id="candidate-length-unit"
            label="Length unit"
            value={lengthUnit}
            onChange={setLengthUnit}
            options={vocabOptions(LENGTH_UNITS)}
          />
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
            Hook features (observed, 0–8)
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {HOOK_FEATURES.map((feature) => {
              const selected = hookFeatures.includes(feature);
              return (
                <button
                  key={feature}
                  type="button"
                  aria-pressed={selected}
                  onClick={() =>
                    setHookFeatures(
                      selected
                        ? hookFeatures.filter((entry) => entry !== feature)
                        : [...hookFeatures, feature].slice(0, 8),
                    )
                  }
                  className={`min-h-[36px] rounded-full border px-3 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-teal-700 ${
                    selected
                      ? "border-teal-800/25 bg-teal-50 text-teal-900"
                      : "border-stone-300 bg-white text-stone-600 hover:bg-stone-50"
                  }`}
                >
                  {feature.replace(/_/g, " ")}
                </button>
              );
            })}
          </div>
        </div>
        <KeyValueEditor
          idPrefix="candidate-performance"
          label="Observed performance (at least one point)"
          rows={observedPerformance}
          onRowsChange={setObservedPerformance}
          hint="What was actually observed, as key/value points — e.g. views 4831, conversions 312."
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField
            id="candidate-audience-fit"
            label="Audience fit"
            value={audienceFit}
            onChange={setAudienceFit}
            options={vocabOptions(AUDIENCE_FITS)}
          />
          <SelectField
            id="candidate-freshness"
            label="Freshness"
            value={freshness}
            onChange={setFreshness}
            options={vocabOptions(FRESHNESS)}
          />
          <SelectField
            id="candidate-novelty"
            label="Novelty"
            value={novelty}
            onChange={setNovelty}
            options={vocabOptions(NOVELTY)}
          />
          <SelectField
            id="candidate-reuse-risk"
            label="Reuse risk"
            value={reuseRisk}
            onChange={setReuseRisk}
            options={vocabOptions(REUSE_RISK)}
          />
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
            Evidence links (at least one — the candidate&apos;s provenance)
          </p>
          {evidencePending ? (
            <p className="mt-1 text-sm text-stone-500">
              loading the client&apos;s evidence ledger…
            </p>
          ) : evidenceError !== null ? (
            <SectionErrorViewInline
              error={evidenceError}
              what="the evidence ledger"
              onRetry={onRetryEvidence}
            />
          ) : evidenceList.length === 0 ? (
            <p className="mt-1 text-sm leading-relaxed text-stone-600">
              The client holds no evidence records yet — a candidate cannot be recorded without
              at least one cited observation. Run research above and record a retained fact as
              evidence first (or ingest platform observations through a connected pipe&apos;s
              ingestion run).
            </p>
          ) : (
            <ul className="mos-scroll mt-1 flex max-h-48 flex-col gap-1.5 overflow-y-auto pr-1">
              {evidenceList.map((record) => {
                const selected = evidencePick.includes(record.evidenceId);
                return (
                  <li key={record.evidenceId}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      onClick={() =>
                        setEvidencePick(
                          selected
                            ? evidencePick.filter((entry) => entry !== record.evidenceId)
                            : [...evidencePick, record.evidenceId].slice(0, 20),
                        )
                      }
                      className={`flex min-h-[44px] w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border px-3 py-2 text-left transition-colors focus-visible:ring-2 focus-visible:ring-teal-700 ${
                        selected
                          ? "border-teal-800/25 bg-teal-50"
                          : "border-stone-200 bg-white hover:bg-stone-50"
                      }`}
                    >
                      <Chip
                        label={record.class}
                        className="border-stone-300 bg-white text-stone-700"
                      />
                      <span className="font-mono text-[11px] text-stone-500">
                        {record.source.system}
                        {record.source.ref ? ` · ${record.source.ref}` : ""}
                      </span>
                      <span className="ml-auto shrink-0 text-[11px] text-stone-400">
                        {formatWhen(record.observedAt)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {!valid ? (
          <p className="text-xs leading-relaxed text-amber-900">
            The topic entity, the niche, at least one observed-performance point and at least one
            evidence link are required — the platform&apos;s own validation enforces the same.
          </p>
        ) : null}
      </div>
    </ConfirmGate>
  );
}
