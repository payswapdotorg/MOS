"use client";

// UX-004 — THE SCIENTIFIC TRACE (the composition root).
//
// One client-scoped surface: the full chain from question to learning —
//   Question → Research → Evidence → Hypothesis → Experiment → Publication →
//   Measurement → Analysis → Decision → Learning —
// rendered as the honest epistemic record of what this platform OBSERVED,
// DERIVED and CONCLUDED. The three registers (observed fact / derived claim
// / interpretation) are explained ONCE by a collapsible legend, applied
// consistently by every link below (see trace-atoms), and differ by more
// than color.
//
// THE COMPOSITION DISCIPLINE (binding): this tab composes EXISTING
// authorities only — thin useMosQuery wrappers over the owning modules'
// real read surfaces, no second analytics layer, no parallel trace state.
// The only state held here is VIEW state: which chain links are open, and
// which experiment the operator cross-linked to (a hypothesis row opening
// its experiment; an experiment row opening its analysis). Every datum's
// authority stays the backend module that owns it.

import * as React from "react";
import { useClient } from "@/components/mos/hooks";
import { useMosSession } from "@/components/mos/session-store";
import { SourceLine } from "@/components/mos/mission/workspace-atoms";
import { ChainConnector, RegisterLegend } from "./trace-atoms";
import {
  AnalysisLink,
  DecisionLink,
  EvidenceLink,
  ExperimentLink,
  HypothesisLink,
  LearningLink,
  MeasurementLink,
  PublicationLink,
  QuestionLink,
  ResearchLink,
} from "./trace-links";

export function ScientificTraceTab({ clientId }: { clientId: string }) {
  const agencyId = useMosSession((state) => state.agencyId);
  const client = useClient(clientId);

  // --- View state ONLY (never authority state) --------------------------------
  //
  // Which chain links are open (the question link — the chain head — starts
  // open), which experiment row a hypothesis cross-link focused, and which
  // experiment's analysis sub-row an experiment cross-link focused.
  const [openSections, setOpenSections] = React.useState<Record<string, boolean>>({
    question: true,
  });
  const [focusExperimentId, setFocusExperimentId] = React.useState<string | null>(null);
  const [focusAnalysisExperimentId, setFocusAnalysisExperimentId] = React.useState<string | null>(
    null,
  );
  const pendingScroll = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (pendingScroll.current !== null) {
      const target = document.getElementById(`trace-section-${pendingScroll.current}`);
      if (target !== null) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      pendingScroll.current = null;
    }
  }, [openSections, focusExperimentId, focusAnalysisExperimentId]);

  const setSectionOpen = (id: string, open: boolean) => {
    setOpenSections((previous) => ({ ...previous, [id]: open }));
  };

  const openSection = (id: string) => {
    pendingScroll.current = id;
    setOpenSections((previous) => ({ ...previous, [id]: true }));
  };

  /** Cross-link from a hypothesis row (link 4) to the experiment (link 5). */
  const openExperiment = (experimentId: string) => {
    openSection("experiment");
    setFocusExperimentId(experimentId);
  };

  /** Cross-link from an experiment row (link 5) to its analysis (link 8). */
  const openAnalysis = (experimentId: string) => {
    openSection("analysis");
    setFocusAnalysisExperimentId(experimentId);
  };

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1.5">
        <h2 className="text-lg font-semibold tracking-tight text-stone-800">
          Scientific trace
        </h2>
        <p className="max-w-prose text-sm leading-relaxed text-stone-600">
          The epistemic record for{" "}
          <span className="font-medium text-stone-800">
            {client.data?.name ?? `client ${clientId.slice(0, 8)}…`}
          </span>
          : the full chain from question to learning, rendered honestly — what this platform
          observed, what it derived, and what people concluded. Read it top to bottom; open any
          link for the records behind it.
        </p>
      </header>

      <RegisterLegend />

      <div className="flex flex-col" aria-label="The ten links of the scientific trace">
        <QuestionLink
          clientId={clientId}
          agencyId={agencyId}
          open={openSections["question"] ?? false}
          onOpenChange={(open) => setSectionOpen("question", open)}
        />
        <ChainConnector />
        <ResearchLink
          open={openSections["research"] ?? false}
          onOpenChange={(open) => setSectionOpen("research", open)}
        />
        <ChainConnector />
        <EvidenceLink
          clientId={clientId}
          open={openSections["evidence"] ?? false}
          onOpenChange={(open) => setSectionOpen("evidence", open)}
        />
        <ChainConnector />
        <HypothesisLink
          clientId={clientId}
          open={openSections["hypothesis"] ?? false}
          onOpenChange={(open) => setSectionOpen("hypothesis", open)}
          onOpenExperiment={openExperiment}
        />
        <ChainConnector />
        <ExperimentLink
          clientId={clientId}
          open={openSections["experiment"] ?? false}
          onOpenChange={(open) => setSectionOpen("experiment", open)}
          focusExperimentId={focusExperimentId}
          onOpenAnalysis={openAnalysis}
        />
        <ChainConnector />
        <PublicationLink
          clientId={clientId}
          open={openSections["publication"] ?? false}
          onOpenChange={(open) => setSectionOpen("publication", open)}
        />
        <ChainConnector />
        <MeasurementLink
          clientId={clientId}
          open={openSections["measurement"] ?? false}
          onOpenChange={(open) => setSectionOpen("measurement", open)}
        />
        <ChainConnector />
        <AnalysisLink
          clientId={clientId}
          open={openSections["analysis"] ?? false}
          onOpenChange={(open) => setSectionOpen("analysis", open)}
          focusExperimentId={focusAnalysisExperimentId}
        />
        <ChainConnector />
        <DecisionLink
          clientId={clientId}
          open={openSections["decision"] ?? false}
          onOpenChange={(open) => setSectionOpen("decision", open)}
        />
        <ChainConnector />
        <LearningLink
          clientId={clientId}
          open={openSections["learning"] ?? false}
          onOpenChange={(open) => setSectionOpen("learning", open)}
        />
      </div>

      <SourceLine
        sources={[
          "This trace composes the platform's existing authorities — it holds no data of its own:",
          "GET /api/agencies/:agencyId/growth-missions + GET /api/growth-missions/:missionId (Question, on expand)",
          "GET /api/clients/:clientId/evidence (Evidence) · /experiments (Hypothesis, Experiment, Analysis) · /metrics (Measurement) · /decisions + GET /api/decisions/:decisionId (Decision) · /learnings + GET /api/learnings/:learningId/relationships (Learning)",
          "GET /api/clients/:clientId/cross-platform-distribution/plans/:planId (Publication; plan measurement references on expand) · MKT-067 analyses + allocations by-experiment (Analysis, on expand)",
          "Research (MKT-062): not built yet — the truthful coming state is rendered, never a fabricated store.",
        ]}
      />
    </div>
  );
}
