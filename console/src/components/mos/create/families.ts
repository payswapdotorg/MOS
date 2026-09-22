// UX-002 — the frozen §3 objective-family vocabulary, mirrored VERBATIM from
// the platform contract (src/modules/growth-missions/public.ts
// GROWTH_MISSION_OBJECTIVE_FAMILIES — gm-vocab-v1). The console may present
// friendly labels, but every value it sends is one of these exact strings —
// nothing here may drift from the frozen backend vocabulary.

export const OBJECTIVE_FAMILIES = [
  "audience_growth",
  "creator_growth",
  "product_marketing",
  "acquisition",
  "lead_generation",
  "revenue",
  "commerce_discovery",
  "hybrid",
] as const;

export type ObjectiveFamily = (typeof OBJECTIVE_FAMILIES)[number];

export function isObjectiveFamily(value: string): value is ObjectiveFamily {
  return (OBJECTIVE_FAMILIES as readonly string[]).includes(value);
}

/** Plain-language presentation for each frozen family (labels only — the
 *  wire values are the frozen strings above, never these words). */
export const FAMILY_PRESENTATION: Record<ObjectiveFamily, { label: string; hint: string }> = {
  audience_growth: {
    label: "Audience growth",
    hint: "Reach more of the right people, more often.",
  },
  creator_growth: {
    label: "Creator growth",
    hint: "Grow your own presence as a creator.",
  },
  product_marketing: {
    label: "Product marketing",
    hint: "Promote something specific you sell.",
  },
  acquisition: {
    label: "Acquisition",
    hint: "Win new customers, end to end.",
  },
  lead_generation: {
    label: "Lead generation",
    hint: "Find people genuinely interested in what you offer.",
  },
  revenue: {
    label: "Revenue",
    hint: "Turn interest into income.",
  },
  commerce_discovery: {
    label: "Commerce discovery",
    hint: "Find products worth offering to your audience.",
  },
  hybrid: {
    label: "Hybrid",
    hint: "A mix of outcomes — describe it in your own words.",
  },
};

/**
 * The home-outcome → family pre-seed map (the UX-002 dispatch): each of the
 * five start outcomes seeds the outcome step with its frozen family. The
 * sixth home entry ("Continue a mission") is NOT here — it stays as-is.
 */
export const HOME_OUTCOME_FAMILY_SEEDS: Record<string, ObjectiveFamily> = {
  "grow-audience": "audience_growth",
  "market-product": "product_marketing",
  "find-product": "commerce_discovery",
  "generate-leads": "lead_generation",
  "generate-revenue": "revenue",
};
