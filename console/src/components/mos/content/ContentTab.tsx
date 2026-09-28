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
// Entry points: the Client Workspace's "Content" tab (this component) and
// the mission workspace's content sections' cross-links (UX-003 — the
// mission-context discoverability link).

import { ResearchSection } from "./ResearchSection";
import { CandidatesSection } from "./CandidatesSection";
import { RightsSection } from "./RightsSection";
import { AssetsSection } from "./AssetsSection";
import { SourceLine } from "@/components/mos/mission/workspace-atoms";

export function ContentTab({ clientId }: { clientId: string }) {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-stone-900">Content &amp; rights</h2>
        <p className="mt-1 max-w-prose text-sm leading-relaxed text-stone-600">
          The content pipeline this client operates — from research (what was observed, with full
          provenance) through candidates (the observed-feature records, with their evidence
          separated from the hypotheses about them) and the rights gates (the honest state and
          WHY anything is blocked) to the versioned assets and their recorded transformations
          (every derived output carrying its lineage). Each card shows the live record and the
          one action that state needs next.
        </p>
      </div>

      <ResearchSection clientId={clientId} />
      <CandidatesSection clientId={clientId} />
      <RightsSection clientId={clientId} />
      <AssetsSection clientId={clientId} />

      <div className="rounded-xl border border-stone-200 bg-stone-50/60 px-5 py-4">
        <p className="text-sm leading-relaxed text-stone-600">
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
      </div>
    </div>
  );
}
