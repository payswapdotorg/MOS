"use client";

// UX-006 — the Content/Rights operational surface: one client-scoped
// surface where the content pipeline is seen and operated — research
// sessions and their honest passes, content candidates with evidence vs
// hypothesis separation, rights gates with their publication-gate
// visibility, and the versioned asset pipeline with its mandatory
// transformation lineage — four authority families, zero new authorities.
// Every card composes the real records of an existing authority (MKT-062
// research + content-intelligence, MKT-063 content-rights, MKT-064
// content-assets) through their own routes; every action is wired to the
// REAL route with confirm-gating on material transitions.
//
// UX-010 — the progressive-disclosure hardening: the surface's first view is
// the calm stack of the four family summary rows (each carrying its LIVE
// one-line summary); the records, forms, diagnostics and route names live in
// the expanded families and the collapsed SourcesDisclosure. ONE primary
// action per screen state: "Start a research session" (it opens the Research
// family and its create gate — the pipeline's entry point); every per-card
// action renders in the secondary register at the summary level.
//
// Entry points: the Client Workspace's "Content" tab (this component) and
// the mission workspace's content sections' cross-links (UX-003 — the
// mission-context discoverability link).

import * as React from "react";
import { Microscope } from "lucide-react";
import { ResearchSection } from "./ResearchSection";
import { CandidatesSection } from "./CandidatesSection";
import { RightsSection } from "./RightsSection";
import { AssetsSection } from "./AssetsSection";
import { SourceLine, WorkspaceActionButton } from "@/components/mos/mission/workspace-atoms";
import { SourcesDisclosure } from "@/components/mos/surface-section";

export function ContentTab({ clientId }: { clientId: string }) {
  // The surface's ONE primary action: opening the Research family (where the
  // pipeline starts). Controlled open — the summary level stays calm, the
  // growth action stays singular.
  const [researchOpen, setResearchOpen] = React.useState(false);
  const openResearch = () => {
    setResearchOpen(true);
    document
      .getElementById("section-content-research")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="space-y-6">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-prose">
          <h2 className="text-lg font-semibold tracking-tight text-stone-900">Content &amp; rights</h2>
          <p className="mt-1 text-sm leading-relaxed text-stone-600">
            The content pipeline this client operates — from what was observed in research, through
            the candidates and their rights gates, to the versioned assets and their recorded
            transformations. Open a family to see its records and the one action each needs next.
          </p>
        </div>
        <div className="shrink-0">
          <WorkspaceActionButton
            tone="teal"
            onClick={openResearch}
            ariaLabel="Start a research session — opens the Research family"
          >
            <span className="inline-flex items-center gap-1.5">
              <Microscope className="size-4" aria-hidden="true" />
              Start a research session
            </span>
          </WorkspaceActionButton>
        </div>
      </div>

      <ResearchSection clientId={clientId} open={researchOpen} onOpenChange={setResearchOpen} />
      <CandidatesSection clientId={clientId} />
      <RightsSection clientId={clientId} />
      <AssetsSection clientId={clientId} />

      <SourcesDisclosure id="content-sources" label="Sources & composition">
        <p className="leading-relaxed">
          This surface composes the platform&apos;s existing authorities — it holds no content,
          rights, research or asset state of its own. The evidence/hypothesis separation, the
          rights-gate vocabulary and the lineage-mandatory rule are the authorities&apos; own
          contracts, rendered as they carry them; a record an authority does not populate renders
          its honest absence, never a fabricated value.
        </p>
        <SourceLine
          sources={[
            "GET /api/agencies/:agencyId/research-sessions + GET /api/research-sessions/:id (+ runs, versions, insights POSTs)",
            "GET /api/clients/:clientId/content-intelligence/candidates (+ hypotheses) · GET …/evidence",
            "GET …/content-rights (+ :id tails, gate, transitions, permissions) · GET …/content-assets (+ transformations, :id tails, materialize, execute) · GET …/content-rights/lineage/:compositeAssetRef",
          ]}
        />
      </SourcesDisclosure>
    </div>
  );
}
