/**
 * MarketingOS module: /content-rights
 * Authority: Content Rights and Provenance (MKT-063 —
 * spec/effective-backlog-v1.6.md: "explicit asset-level rights state and
 * publication gate. Acceptance: owned/license/platform-permitted/cleared/
 * review/blocked states, ingredient lineage, fail-closed autonomous
 * publication"; spec/architecture-v1.6.md §9: "Content Rights is an explicit
 * publication gate... Every derived asset keeps lineage to its ingredients.
 * Fair-use reasoning is represented as review evidence, not as an automatic
 * legal guarantee. Autonomous publishing requires a rights state explicitly
 * permitted by mission policy. Rights uncertainty routes to human action";
 * spec/frozen-manifest-v1.6.json hardPublicationRules:
 * rightsUncertaintyFailsClosed + sourceLineageRequired +
 * destinationPolicyGateRequired; spec/module-dependency-matrix-v1.6.md
 * boundary rule 4: "Content Rights can block publication but cannot
 * silently approve unclear rights").
 *
 * This module owns:
 *
 *   - the CLIENT-SCOPED durable RIGHTS RECORDS (migration 051) binding an
 *     explicit rights state to a CONTENT ASSET REFERENCE — an OPAQUE,
 *     grammar-fenced identifier that is the id-based INTEGRATION SEAM for
 *     /content-assets (MKT-064, a LATER Work Item that does not exist on
 *     this baseline; see the DISCLOSED REGISTRATION SUBSET below). Every
 *     record carries SOURCE PROVENANCE (an /evidence FK anchor — where the
 *     asset/claim came from), licence evidence (required the moment the
 *     state claims a licence basis), the destination PLATFORM PERMISSION
 *     SCOPE (what the source's licence permits on which destination
 *     platforms — one append-only row per platform, newest row effective),
 *     and expiry semantics (valid_until evaluated FAIL-CLOSED at gate
 *     time);
 *   - the FROZEN RIGHTS STATE MODEL: owned / license / platform_permitted
 *     / cleared / review / blocked plus the explicit `unknown` initial
 *     state (the backlog acceptance vocabulary VERBATIM; `unknown` is the
 *     undetermined posture architecture-v1.6.md §9 names "unclear").
 *     State transitions are RECORDED EVENTS (append-only
 *     content_rights_events tail — one immutable row per transition with
 *     from_state, to_state, the frozen event kind, the REQUIRED reason and
 *     server-derived provenance), never in-place mutations of history: the
 *     record's current-state column moves ONLY along the CHECK-fenced
 *     transition table, in the SAME transaction as its event row;
 *   - the HUMAN CLEARANCE records: review → cleared happens ONLY through
 *     an explicit clearance event recorded with the ACTOR IDENTITY of the
 *     clearing human and a REQUIRED rationale (fair-use reasoning and any
 *     other supporting material attach as /evidence-referenced review
 *     EVIDENCE on the clearance — evidence for review, never an automatic
 *     legal guarantee, never an auto-clear);
 *   - the INGREDIENT LINEAGE LINKS (immutable, append-only): a composition
 *     (clip, compilation, padded composite — any asset composed from
 *     ingredients) resolves its rights as the CONJUNCTION of its
 *     ingredients. ANY unclear ingredient makes the composite
 *     review_required; ANY blocked/absent ingredient makes the composite
 *     blocked. A composite-kind record with NO lineage links is blocked
 *     outright (sourceLineageRequired — an unauditable composite is not
 *     publishable). Cycle and depth guards fail closed;
 *   - THE PUBLICATION GATE — the explicit gate operation future modules
 *     (MKT-065 cross-platform distribution) call BEFORE publishing:
 *     evaluatePublicationGate(asset, destination) → allow /
 *     review_required / blocked WITH REASONS. FAIL-CLOSED BY CONSTRUCTION:
 *     an absent rights evaluation (no record for the asset) is BLOCKED,
 *     never allowed; unknown and review states NEVER auto-approve — they
 *     return review_required, the one honest surface rights become a
 *     blocked_pending_human_action source for their consumers; a licence
 *     whose valid_until has passed is blocked at evaluation time; the
 *     destination-platform compatibility runs through the /policies
 *     engine (the network dimension, policy key
 *     content.rights.publication.<platform> — destinationPolicyGateRequired)
 *     and only an explicit allow permits, with every decision recorded in
 *     the policy engine's own append-only ledger.
 *
 * What this module deliberately does NOT do (bounded scope, MKT-063):
 *   - NO PUBLICATION AUTHORITY (boundary rule 4): the gate BLOCKS or
 *     refers to review; it never publishes, dispatches, schedules or
 *     acknowledges a publication. There is no publish/post/dispatch verb
 *     anywhere in the module — MKT-065 owns distribution execution;
 *   - NO silent approval of unclear rights (boundary rule 4): only an
 *     explicit human clearance event (actor identity + rationale,
 *     recorded append-only) can move review → cleared, and `unknown`
 *     requires a determination first — there is NO code path from
 *     unknown/review to allow that does not pass through a recorded
 *     human-action event;
 *   - NO content-asset storage (MKT-064, a later Work Item): the module
 *     knows assets ONLY by their opaque refs — no artifact bytes, no
 *     object-store addresses, no transformation state. /content-assets is
 *     the FUTURE consumer of this gate (its frozen matrix row lists
 *     /content-rights), not an import here;
 *   - NO legal advice: the module records rights CLAIMS and their
 *     evidence; the states are operational publication gates, not legal
 *     determinations (fair-use reasoning rides as review evidence);
 *   - NO platform adapter knowledge: destination platforms are opaque
 *     grammar-fenced KEYS carried as data (the /social-accounts adapter-key
 *     precedent — platform-specific rules live behind the adapter plane,
 *     Worker A's surface).
 *
 * DEPENDENCY POSTURE (the frozen v1.6 matrix row:
 * /content-rights → /evidence, /policies, /content-assets):
 *   - /evidence — the MKT-013 authority: every source-provenance,
 *     licence, permission and clearance evidence link is an FK-anchored
 *     same-Client /evidence record (module-level canonical resolution
 *     through the public contract + DB trigger backstops);
 *   - /policies — the MKT-021 execution policy engine: the fail-closed
 *     destination-policy gate of every publication-gate evaluation (every
 *     decision recorded in the engine's own ledger);
 *   - /content-assets — DOES NOT EXIST YET (MKT-064, a later Worker B
 *     session). DISCLOSED REGISTRATION SUBSET (the /product-intelligence
 *     MKT-069 precedent): this delivery registers the currently-
 *     satisfiable subset (evidence, policies) in the enforced matrix;
 *     /content-assets joins the row at MKT-064 time. The content-asset
 *     relationship is an id-based REFERENCE SEAM (the opaque asset ref +
 *     this module's typed port surface), never an import of a nonexistent
 *     module. The backlog dependency list (MKT-013, MKT-022 — both
 *     VERIFIED on this baseline) is the build-time authority.
 *
 * Cross-module access may only target this public entry (public.ts) —
 * internal/ is unimportable from other modules (enforced by the static
 * architecture checker, tools/arch-check).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
// The frozen matrix directions /content-rights ──→ /evidence and
// /content-rights ──→ /policies: the MKT-013 evidence authority (canonical
// record resolution for every evidence link) and the MKT-021 execution
// policy engine (the fail-closed destination gate of every publication-gate
// evaluation).
import type { EvidenceModuleApi } from '../evidence/public.ts';
import type { PoliciesModuleApi } from '../policies/public.ts';

// ---------------------------------------------------------------------------
// The frozen vocabularies (cr-vocab-v1 — a change to ANY value is a NEW
// version string, never a silent re-statement)
// ---------------------------------------------------------------------------

/**
 * The closed RIGHTS STATE vocabulary — the MKT-063 acceptance list
 * VERBATIM (owned / license / platform-permitted / cleared / review /
 * blocked) PLUS the explicit `unknown` initial state (the "unknown/
 * undetermined" posture every record is born in; architecture-v1.6.md §9
 * names it "unclear" — same concept, the backlog acceptance vocabulary is
 * the frozen authority here).
 */
export const CONTENT_RIGHTS_STATES = [
  'owned',
  'license',
  'platform_permitted',
  'cleared',
  'review',
  'blocked',
  'unknown',
] as const;

export type ContentRightsState = (typeof CONTENT_RIGHTS_STATES)[number];

export function isKnownContentRightsState(value: string): value is ContentRightsState {
  return (CONTENT_RIGHTS_STATES as readonly string[]).includes(value);
}

/**
 * The closed ASSET-KIND vocabulary: a `source` asset (original material)
 * or a `composite` (a clip compiled from several sources, a compilation,
 * a padded composition — anything with ingredients). Padding and
 * compilation material is itself subject to rights and provenance gates
 * (AGENTS.md v1.6 growth-autonomy rules), so composites resolve as the
 * CONJUNCTION of their lineage.
 */
export const CONTENT_RIGHTS_ASSET_KINDS = ['source', 'composite'] as const;

export type ContentRightsAssetKind = (typeof CONTENT_RIGHTS_ASSET_KINDS)[number];

export function isKnownContentRightsAssetKind(value: string): value is ContentRightsAssetKind {
  return (CONTENT_RIGHTS_ASSET_KINDS as readonly string[]).includes(value);
}

/**
 * The closed TRANSITION-EVENT kind vocabulary. The frozen transition
 * table (CHECK-fenced in migration 051, mirrored by the pure
 * `isLegalContentRightsTransition`):
 *
 *   unknown → owned | license | platform_permitted | review | blocked : determination
 *   review → cleared                                                    : human_clearance (clearance REQUIRED)
 *   review → blocked                                                    : review_denial
 *   owned | license | platform_permitted | cleared → review             : contestation
 *   owned | license | platform_permitted | cleared → blocked            : revocation
 *   blocked → review                                                    : re_review_request
 *
 * There is deliberately NO transition into `cleared` except
 * human_clearance from `review` — the fail-closed human-action spine.
 */
export const CONTENT_RIGHTS_EVENT_KINDS = [
  'determination',
  'human_clearance',
  'contestation',
  'revocation',
  'review_denial',
  're_review_request',
] as const;

export type ContentRightsEventKind = (typeof CONTENT_RIGHTS_EVENT_KINDS)[number];

export function isKnownContentRightsEventKind(value: string): value is ContentRightsEventKind {
  return (CONTENT_RIGHTS_EVENT_KINDS as readonly string[]).includes(value);
}

/**
 * The closed PLATFORM PERMISSION vocabulary — what the source's licence
 * permits on ONE destination platform. Rows are append-only facts; the
 * NEWEST row per (rights record, platform) is the effective permission.
 * An ABSENT row for a destination is `unspecified` (not in the DB
 * vocabulary — the gate's runtime fail-closed posture: licence-basis
 * states without a destination row are review_required).
 */
export const CONTENT_RIGHTS_PERMISSIONS = ['permitted', 'not_permitted'] as const;

export type ContentRightsPermission = (typeof CONTENT_RIGHTS_PERMISSIONS)[number];

export function isKnownContentRightsPermission(value: string): value is ContentRightsPermission {
  return (CONTENT_RIGHTS_PERMISSIONS as readonly string[]).includes(value);
}

/**
 * The closed PUBLICATION-GATE outcome vocabulary: allow |
 * review_required | blocked. BOTH non-allow outcomes are fail-closed —
 * the gate never permits on uncertainty. `review_required` is the one
 * honest surface rights become a `blocked_pending_human_action` source
 * for their consumers (MKT-065 distribution, future mission policy);
 * `blocked` is the definite negative (absent evaluation, denied state,
 * expired licence, forbidden destination, denied destination policy,
 * blocked ingredient, unauditable lineage).
 */
export const CONTENT_RIGHTS_GATE_OUTCOMES = ['allow', 'review_required', 'blocked'] as const;

export type ContentRightsGateOutcome = (typeof CONTENT_RIGHTS_GATE_OUTCOMES)[number];

/**
 * The closed gate REASON-CODE vocabulary (the honest reasons a gate
 * evaluation cites — negative codes on blocked/review_required outcomes,
 * positive basis codes on allow outcomes).
 */
export const CONTENT_RIGHTS_GATE_REASON_CODES = [
  // Fail-closed negative codes.
  'no_rights_record',
  'rights_state_unknown',
  'rights_state_review',
  'rights_state_blocked',
  'licence_expired',
  'destination_not_permitted',
  'destination_permission_unspecified',
  'policy_denied',
  'ingredient_no_rights_record',
  'ingredient_rights_unclear',
  'ingredient_blocked',
  'lineage_missing',
  'lineage_cycle',
  'lineage_depth_exceeded',
  // Honest positive basis codes (WHY the gate allows — never silent).
  'allowed_owned',
  'allowed_license_scope',
  'allowed_platform_permission',
  'allowed_human_clearance',
] as const;

export type ContentRightsGateReasonCode = (typeof CONTENT_RIGHTS_GATE_REASON_CODES)[number];

export function isKnownContentRightsGateReasonCode(
  value: string,
): value is ContentRightsGateReasonCode {
  return (CONTENT_RIGHTS_GATE_REASON_CODES as readonly string[]).includes(value);
}

/**
 * The frozen vocabulary version (the nd-vocab-v1 discipline): the
 * rights-state, asset-kind, event-kind, permission, gate-outcome and
 * gate reason-code vocabularies above. A change to ANY of them is a NEW
 * version string — the vocabularies are versioned, never silently
 * re-stated.
 */
export const CONTENT_RIGHTS_VOCABULARY_VERSION = 'cr-vocab-v1' as const;

// ---------------------------------------------------------------------------
// Provenance (server-derived — the growth-missions/notifications pattern)
// ---------------------------------------------------------------------------

/**
 * SERVER-DERIVED provenance for every content-rights command: built
 * exclusively from the authenticated principal, the ambient correlation
 * context and the recording surface — never from a request body.
 */
export interface ContentRightsProvenance {
  /** Server-derived actor label: 'user:<uuid>' | 'service:<label>' | 'worker:<label>'. */
  readonly actor: string;
  /** Server-derived recording surface label ('api' | 'module' | 'test'). */
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

/** Provenance block as persisted on the append-only records. */
export interface ContentRightsRecordedProvenance extends ContentRightsProvenance {
  /** Server-stamped recording time (module clock, never caller input). */
  readonly recordedAt: string;
}

// ---------------------------------------------------------------------------
// Records (the migration 051 storage shapes)
// ---------------------------------------------------------------------------

/**
 * One persisted asset-level RIGHTS RECORD. The current `state` is the
 * live pointer; the full transition history is the append-only event
 * tail (getRightsRecord + listRightsEvents compose the honest view).
 */
export interface ContentRightsRecord {
  readonly rightsRecordId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  /** The OPAQUE content-asset reference — the MKT-064 integration seam. */
  readonly contentAssetRef: string;
  readonly assetKind: ContentRightsAssetKind;
  /** The current rights state (born 'unknown'; moves only along recorded events). */
  readonly state: ContentRightsState;
  /** Source provenance: the /evidence record anchoring where the asset/claim came from. */
  readonly sourceEvidenceRef: string;
  /** Human-readable licence descriptor (nullable — required once the state claims a licence basis). */
  readonly licenceLabel: string | null;
  /** Licence evidence: the /evidence record backing the licence claim (required for license/platform_permitted). */
  readonly licenceEvidenceRef: string | null;
  /** Expiry semantics: the licence's validity horizon (evaluated FAIL-CLOSED at gate time). */
  readonly validUntil: string | null;
  readonly provenance: ContentRightsRecordedProvenance;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One append-only state-transition event (the immutable history tail). */
export interface ContentRightsEventRecord {
  readonly eventId: string;
  readonly rightsRecordId: string;
  readonly fromState: ContentRightsState;
  readonly toState: ContentRightsState;
  readonly eventKind: ContentRightsEventKind;
  /** The REQUIRED bounded reason the transition was recorded. */
  readonly reason: string;
  /** The clearance record (set exactly when eventKind = 'human_clearance'). */
  readonly clearanceId: string | null;
  readonly provenance: ContentRightsRecordedProvenance;
}

/**
 * One HUMAN CLEARANCE record — the ONLY sanctioned review → cleared
 * path: the actor identity of the clearing human, the REQUIRED
 * rationale, and optional /evidence-referenced supporting material
 * (fair-use reasoning attaches HERE, as review evidence — never an
 * automatic legal guarantee, never an auto-clear).
 */
export interface ContentRightsClearanceRecord {
  readonly clearanceId: string;
  readonly rightsRecordId: string;
  readonly clearedByActor: string;
  readonly clearedVia: string;
  readonly rationale: string;
  /** Supporting evidence reference (the fair-use reasoning surface). */
  readonly evidenceRef: string | null;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly clearedAt: string;
}

/** One append-only destination-platform permission-scope row. */
export interface ContentRightsPermissionRecord {
  readonly permissionId: string;
  readonly rightsRecordId: string;
  /** The destination platform KEY (opaque adapter-plane data — the social-accounts precedent). */
  readonly platformKey: string;
  readonly permission: ContentRightsPermission;
  /** The /evidence record backing THIS permission claim. */
  readonly evidenceRef: string;
  readonly provenance: ContentRightsRecordedProvenance;
}

/** One immutable ingredient lineage link. */
export interface ContentRightsLineageRecord {
  readonly lineageLinkId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly compositeAssetRef: string;
  readonly ingredientAssetRef: string;
  readonly provenance: ContentRightsRecordedProvenance;
}

/** The canonical ownership resolution (the route-layer uniform-404 input). */
export interface ContentRightsOwnership {
  readonly scope: {
    readonly kind: 'content_rights';
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceId: string | null;
    readonly rightsRecordId: string;
  };
  readonly record: ContentRightsRecord;
  readonly resolvedAt: string;
}

// ---------------------------------------------------------------------------
// The publication gate (MKT-063 — the explicit gate operation)
// ---------------------------------------------------------------------------

/** One honest gate reason: a frozen code + the bounded human-readable detail. */
export interface ContentRightsGateReason {
  readonly code: ContentRightsGateReasonCode;
  readonly detail: string;
}

/** The per-ingredient breakdown of a composite evaluation (auditable). */
export interface ContentRightsGateIngredientEvaluation {
  readonly assetRef: string;
  readonly outcome: ContentRightsGateOutcome;
  readonly reasonCodes: readonly ContentRightsGateReasonCode[];
}

/** The result of one publication-gate evaluation. */
export interface ContentRightsGateResult {
  readonly outcome: ContentRightsGateOutcome;
  readonly reasons: readonly ContentRightsGateReason[];
  readonly assetRef: string;
  readonly destinationPlatform: string;
  /** True when lineage traversal ran (the asset has ingredient links). */
  readonly composite: boolean;
  /** The per-ingredient breakdown (empty for source assets). */
  readonly ingredientEvaluations: readonly ContentRightsGateIngredientEvaluation[];
  /** The /policies decision that gated the destination (always recorded). */
  readonly policyDecisionId: string;
  readonly evaluatedAt: string;
  readonly vocabularyVersion: string;
}

// ---------------------------------------------------------------------------
// The content-asset reference seam (the MKT-064 typed port)
// ---------------------------------------------------------------------------

/**
 * THE CONTENT-ASSET REFERENCE SEAM (the disclosed ordering decision):
 * MKT-064 (/content-assets — versioned artifacts + transformation
 * execution) does NOT exist on this baseline and lands in a LATER Worker
 * B session. Until then every asset is an OPAQUE, grammar-fenced
 * reference (`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` — path-safe, the
 * occurrence-key grammar precedent). When MKT-064 lands it will either
 * (a) mint refs from its own canonical asset ids and pass them here, or
 * (b) satisfy this typed port — either way the relationship stays an
 * id-based reference, never an import of a nonexistent module. The
 * matrix row for /content-assets (which lists /content-rights as a
 * dependency) is MKT-064's registration to add.
 */
export interface ContentAssetReferencePort {
  /**
   * Resolves the canonical asset descriptor behind one opaque asset ref
   * for a Client (null when unknown). THIS BASELINE SHIPS NO
   * IMPLEMENTATION: the /content-rights module never calls it — it is
   * the declared seam MKT-064 satisfies. Disclosed, not built.
   */
  resolveContentAssetRef(
    clientId: string,
    assetRef: string,
  ): Promise<{ readonly exists: boolean } | null>;
}

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

export interface ContentRightsModuleApi {
  /**
   * Registers the RIGHTS RECORD for one content-asset reference (born
   * 'unknown' — the initial undetermined state; determinations are
   * recorded transition events). One record per (client, asset ref) —
   * the unique fence makes re-registration the honest ConflictError
   * (a re-registered asset is a NEW asset version, which is a NEW ref —
   * the MKT-064 immutability discipline). The source-provenance
   * evidence reference is REQUIRED and resolved canonically through the
   * /evidence public contract BEFORE any write (uniform NotFoundError
   * for unknown/foreign — no cross-tenant oracle; the DB trigger is
   * the backstop).
   */
  registerContentRights(
    input: {
      readonly agencyId: string;
      readonly clientId: string;
      readonly workspaceId: string | null;
      readonly contentAssetRef: string;
      readonly assetKind: ContentRightsAssetKind;
      readonly sourceEvidenceRef: string;
      readonly licenceLabel: string | null;
      readonly licenceEvidenceRef: string | null;
      readonly validUntil: string | null;
    },
    provenance: ContentRightsProvenance,
  ): Promise<ContentRightsRecord>;

  /** Raw record by id (the live state pointer; the history is the event tail). */
  getRightsRecord(rightsRecordId: string): Promise<ContentRightsRecord | null>;

  /** The record for one (client, asset ref) — null when none exists (the gate's absent-evaluation case). */
  getRightsRecordForAsset(
    clientId: string,
    contentAssetRef: string,
  ): Promise<ContentRightsRecord | null>;

  /**
   * Canonical ownership resolution: the record + its owning chain. Null
   * when the record does not exist OR belongs to another tenant —
   * callers surface a uniform 404 so foreign, unknown and malformed
   * identifiers are indistinguishable (hard-boundary posture).
   */
  resolveRightsOwnership(rightsRecordId: string): Promise<ContentRightsOwnership | null>;

  /** The client's rights records, newest first (bounded, server-chosen limit). */
  listRightsRecordsForClient(clientId: string): Promise<readonly ContentRightsRecord[]>;

  /**
   * Records ONE state transition: appends the immutable event row and
   * moves the record's current state in the SAME transaction (CAS: the
   * record's live state must equal the event's from_state — the losing
   * side of a race is the honest ConflictError, never a torn history).
   * The caller declares the target `toState`; the (from, to, kind)
   * triple must be a row of the frozen transition table — anything
   * else fails closed by rejection (the migration-051 CHECK is the
   * persisted mirror). `human_clearance` requires the clearance payload
   * (rationale REQUIRED; the clearing actor is the SERVER-DERIVED
   * provenance actor — a human identity at the route surface) and
   * creates the clearance record atomically.
   */
  recordRightsTransition(
    input: {
      readonly rightsRecordId: string;
      readonly eventKind: ContentRightsEventKind;
      /** The declared target state (verified against the frozen transition table). */
      readonly toState: ContentRightsState;
      readonly reason: string;
      /** REQUIRED exactly when eventKind = 'human_clearance'. */
      readonly clearance: {
        readonly rationale: string;
        readonly evidenceRef: string | null;
      } | null;
    },
    provenance: ContentRightsProvenance,
  ): Promise<{
    readonly record: ContentRightsRecord;
    readonly event: ContentRightsEventRecord;
    readonly clearance: ContentRightsClearanceRecord | null;
  }>;

  /**
   * Appends ONE destination-platform permission-scope row (immutable;
   * the newest row per platform is the effective permission — scope
   * changes are NEW rows, the full tail stays auditable). The evidence
   * reference is REQUIRED and resolved canonically through /evidence
   * before any write.
   */
  recordPlatformPermission(
    input: {
      readonly rightsRecordId: string;
      readonly platformKey: string;
      readonly permission: ContentRightsPermission;
      readonly evidenceRef: string;
    },
    provenance: ContentRightsProvenance,
  ): Promise<ContentRightsPermissionRecord>;

  /**
   * Records ONE immutable ingredient lineage link (the composition
   * fact). One link per (client, composite ref, ingredient ref) — the
   * unique fence makes a duplicate the honest ConflictError. Links are
   * client-scoped: an ingredient that resolves to no rights record IN
   * THIS CLIENT fails the gate closed (cross-Client composition has no
   * resolvable rights here — disclosed).
   */
  recordLineageLink(
    input: {
      readonly agencyId: string;
      readonly clientId: string;
      readonly workspaceId: string | null;
      readonly compositeAssetRef: string;
      readonly ingredientAssetRef: string;
    },
    provenance: ContentRightsProvenance,
  ): Promise<ContentRightsLineageRecord>;

  /** The lineage links of one composite (client-scoped; order recorded). */
  listLineageLinks(
    clientId: string,
    compositeAssetRef: string,
  ): Promise<readonly ContentRightsLineageRecord[]>;

  /** The append-only transition history of one record (oldest first). Null when the record is unknown. */
  listRightsEvents(
    rightsRecordId: string,
  ): Promise<readonly ContentRightsEventRecord[] | null>;

  /** The full permission-scope tail of one record (oldest first; newest per platform is effective). Null when unknown. */
  listPlatformPermissions(
    rightsRecordId: string,
  ): Promise<readonly ContentRightsPermissionRecord[] | null>;

  /** The clearance history of one record (oldest first). Null when unknown. */
  listClearances(
    rightsRecordId: string,
  ): Promise<readonly ContentRightsClearanceRecord[] | null>;

  /**
   * THE PUBLICATION GATE (fail-closed by construction): evaluates
   * whether the asset's rights permit autonomous publication to ONE
   * destination platform. Returns allow / review_required / blocked
   * WITH reasons. Composition resolves as the CONJUNCTION of
   * ingredients. The destination-policy compatibility runs through the
   * /policies engine (network dimension, key
   * content.rights.publication.<platform>) on EVERY evaluation — the
   * decision id rides the result; a non-allow policy outcome BLOCKS.
   * The agency/client scope is SERVER-DERIVED input (resolved by the
   * route layer from canonical ownership — never a request field).
   * This operation performs NO writes to the module's own tables (the
   * policy decision lands in the policy engine's own ledger).
   */
  evaluatePublicationGate(
    input: {
      readonly agencyId: string;
      readonly clientId: string;
      readonly assetRef: string;
      readonly destinationPlatform: string;
    },
    provenance: ContentRightsProvenance,
  ): Promise<ContentRightsGateResult>;
}

export interface ContentRightsModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Frozen matrix: /content-rights ──→ /evidence (canonical evidence resolution for every evidence link). */
  readonly evidence: EvidenceModuleApi;
  /** Frozen matrix: /content-rights ──→ /policies (the fail-closed destination gate of every publication-gate evaluation). */
  readonly policies: PoliciesModuleApi;
}

// ---------------------------------------------------------------------------
// The pure evaluation core (exported for unit tests — the gate semantics
// are part of the module contract)
// ---------------------------------------------------------------------------

/**
 * The destination-platform policy key of a publication-gate evaluation:
 * the operation label the /policies gate evaluates (e.g.
 * 'content.rights.publication.<platform-key>'). A destination not sanctioned by
 * policy FAILS CLOSED into a blocked gate result (never a silent pass —
 * the destinationPolicyGateRequired hard rule).
 */
export function publicationPolicyKey(platformKey: string): string {
  return `content.rights.publication.${platformKey}`;
}

/**
 * PURE: is the (from, to, kind) triple a row of the frozen transition
 * table? The migration-051 CHECK is the persisted mirror; this pure
 * twin is the module-level guard. `to === 'cleared'` is legal ONLY from
 * 'review' with kind 'human_clearance' — the fail-closed human-action
 * spine.
 */
export function isLegalContentRightsTransition(input: {
  readonly from: ContentRightsState;
  readonly to: ContentRightsState;
  readonly kind: ContentRightsEventKind;
}): boolean {
  const { from, to, kind } = input;
  if (from === to) return false;
  switch (kind) {
    case 'determination':
      return from === 'unknown'
        && (to === 'owned' || to === 'license' || to === 'platform_permitted'
          || to === 'review' || to === 'blocked');
    case 'human_clearance':
      return from === 'review' && to === 'cleared';
    case 'review_denial':
      return from === 'review' && to === 'blocked';
    case 'contestation':
      return (from === 'owned' || from === 'license' || from === 'platform_permitted'
        || from === 'cleared')
        && to === 'review';
    case 'revocation':
      return (from === 'owned' || from === 'license' || from === 'platform_permitted'
        || from === 'cleared')
        && to === 'blocked';
    case 're_review_request':
      return from === 'blocked' && to === 'review';
  }
}

/**
 * PURE CONJUNCTION MATH (the lineage rule): a composite's outcome is the
 * CONJUNCTION of its own evaluation and every ingredient's — any
 * blocked blocks the composite; else any review_required makes the
 * composite review_required; only all-allow allows.
 */
export function conjunctionOfGateOutcomes(
  outcomes: readonly ContentRightsGateOutcome[],
): ContentRightsGateOutcome {
  if (outcomes.includes('blocked')) return 'blocked';
  if (outcomes.includes('review_required')) return 'review_required';
  return 'allow';
}

/**
 * PURE STATE EVALUATION (one record against one destination):
 *   - an expired valid_until BLOCKS outright (fail-closed — an expired
 *     licence basis is never an allow, whatever the recorded state);
 *   - blocked → blocked; unknown/review → review_required (NEVER an
 *     auto-approve — the only human-action surface);
 *   - owned → allow (the user's own content);
 *   - cleared → allow (the recorded human clearance — explicit, never
 *     silent);
 *   - license / platform_permitted → the destination permission row
 *     decides: permitted allows, not_permitted blocks, unspecified
 *     (no row) is review_required.
 */
export function evaluateContentRightsState(input: {
  readonly state: ContentRightsState;
  readonly validUntil: string | null;
  readonly nowIso: string;
  readonly effectivePermission: ContentRightsPermission | 'unspecified';
}): ContentRightsGateOutcome {
  if (input.validUntil !== null && input.validUntil <= input.nowIso) {
    return 'blocked';
  }
  switch (input.state) {
    case 'blocked':
      return 'blocked';
    case 'unknown':
    case 'review':
      return 'review_required';
    case 'owned':
    case 'cleared':
      return 'allow';
    case 'license':
    case 'platform_permitted': {
      if (input.effectivePermission === 'permitted') return 'allow';
      if (input.effectivePermission === 'not_permitted') return 'blocked';
      return 'review_required';
    }
  }
}

export { createContentRightsModule } from './internal/module.ts';
/**
 * The input guards (vocabulary/shape/provenance validation + the
 * transition-legality twin of the migration CHECK) and the pure
 * evaluation helpers — exported for unit tests and future server-side
 * callers (MKT-064's lineage recording, MKT-065's gate call) so the
 * guard semantics are part of the module contract. Pure functions.
 */
export {
  assertValidContentRightsProvenance,
  assertValidRegisterContentRightsInput,
  assertValidTransitionInput,
  assertValidPermissionInput,
  assertValidLineageInput,
  assertValidGateInput,
  CONTENT_ASSET_REF_PATTERN,
  PLATFORM_KEY_PATTERN,
  MAX_LINEAGE_DEPTH,
  transitionProblems,
} from './internal/validation.ts';
