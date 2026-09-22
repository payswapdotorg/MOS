// UX-001 — Single source of truth for the six outcome entries and their
// destinations. Exact user-facing vocabulary lives here; do not reword labels.
// A destination is either an existing console view ("view", navigated through
// the zustand session store) or a contract-compliant "coming next" state
// ("soon") with an explicit, working in-app action — never a dead end.

// SEAM S1/S2 (two lines, this file only) — the exported zustand hook name and
// the agency-id field name in session-store.ts. If the tree differs, fix THIS
// import and the two helpers below; every home component touches the store
// only through them.
import { useMosSession } from "@/components/mos/session-store";
import type { MosView } from "@/components/mos/session-store";

export type OutcomeDestination =
  | { kind: "view"; view: MosView }
  | { kind: "soon"; title: string; whatIsComing: string; whatYouCanDoNow: string };

export type Outcome = {
  id: string;
  label: string; // exact vocabulary — binding
  blurb: string; // one line of plain language, no internal jargon
  destination: OutcomeDestination;
};

// The five start outcomes — FLIPPED to the real UX-002 mission-creation
// flow (one view destination per outcome, pre-seeding the frozen §3 family).
// The label vocabulary is unchanged and binding. The sixth entry
// ("Continue a mission", below) stays as-is: live data, no flip needed.
export const START_OUTCOMES: Outcome[] = [
  {
    id: "grow-audience",
    label: "Grow an audience",
    blurb: "Connect your channels and reach more of the right people.",
    destination: { kind: "view", view: { kind: "create-mission", family: "audience_growth" } },
  },
  {
    id: "market-product",
    label: "Market a product",
    blurb: "Plan and run promotion for something you sell.",
    destination: { kind: "view", view: { kind: "create-mission", family: "product_marketing" } },
  },
  {
    id: "find-product",
    label: "Find a product to sell",
    blurb: "Discover products worth offering to your audience.",
    destination: { kind: "view", view: { kind: "create-mission", family: "commerce_discovery" } },
  },
  {
    id: "generate-leads",
    label: "Generate leads",
    blurb: "Turn attention into people genuinely interested in what you offer.",
    destination: { kind: "view", view: { kind: "create-mission", family: "lead_generation" } },
  },
  {
    id: "generate-revenue",
    label: "Generate revenue",
    blurb: "Move from interest to income, with clear next steps.",
    destination: { kind: "view", view: { kind: "create-mission", family: "revenue" } },
  },
];

// The sixth entry — rendered by MissionsSection with live data. The label
// lives here so all six exact strings are verifiable in one file.
export const CONTINUE_MISSION = {
  id: "continue-mission",
  label: "Continue a mission", // exact vocabulary — binding
  blurb: "Guided work that is already running for you.",
} as const;

export const TODAY_OPERATIONS: { label: string; view: MosView; blurb: string } = {
  label: "Today / Operations",
  view: { kind: "command-center" },
  blurb: "A live view of what ran, what's queued, and what needs you.",
};

// Store access for the whole home feature. Return types left inferred so they
// adapt to the tree's store without extra annotations.
export const useNavigate = () => useMosSession((s) => s.navigate);
export const useAgencyId = () => useMosSession((s) => s.agencyId);
