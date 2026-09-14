/**
 * MarketingOS module: /first-party-apps
 * Authority: NONE — the Incumbent Capability App Program composition home
 * (MKT-051, spec/effective-backlog-v1.5.md: "prove the App model with
 * first-party capability packs covering reporting/analytics, CRM/pipeline,
 * spreadsheet workflows and client portals; integrations remain behind the
 * App/Integration contracts").
 *
 * This module is a COMPOSITION LAYER, not an authority (spec/
 * mos-app-ecosystem-v1.5.md "Non-goals": "The App Ecosystem is not a
 * license to create alternate workflow engines, CRM authorities,
 * reporting truth, tenant stores, retry engines, evidence stores or
 * policy engines"; spec/architecture-v1.5.md §9: Apps "reproduce ...
 * external products such as reporting/analytics, CRM, spreadsheet
 * workflows, dashboards, attribution, automation or client portals.
 * This is a composition strategy, not a transfer of authority"). It owns:
 *
 *   - the FOUR FIRST-PARTY CAPABILITY PACKS — the typed App Version
 *     manifests (the single publish source, one frozen definition per
 *     (pack, version)) plus each pack's PRESENTATION-ONLY surface
 *     composers. The packs reproduce incumbent capability SURFACES over
 *     the SAME core authorities:
 *       . mos-analytics  — reporting/analytics: command-center cards +
 *                         report pages over the /reporting (Agency
 *                         Command Center) + /profit-intelligence
 *                         (workspace/agency profit) public contracts,
 *                         with the declared analytics-connector network
 *                         destination + ANALYTICS_API_KEY credential NAME
 *                         constrained to the EXISTING /integrations
 *                         authority (pack code makes ZERO network calls);
 *       . mos-crm        — CRM/pipeline: client-room panels + action
 *                         menus over the /clients + /decisions publics;
 *       . mos-sheets     — spreadsheet workflows: workspace tabs +
 *                         editor panes over the /evidence + /metrics
 *                         observation authorities, with the app-owned
 *                         spreadsheet DOCUMENT bounded state
 *                         (app:mos-sheets:documents) whose cells retain
 *                         LINEAGE to canonical observation ids, and the
 *                         declared 'append-observation' action gated by
 *                         the install's granted 'metric:append' scope;
 *       . mos-portal     — client portal: client-facing client-room
 *                         panels + report pages over the /reporting
 *                         Client Decision Room + /clients publics;
 *   - the SURFACE COMPOSITION (the App-model invoke/read proof): given a
 *     workspace + app key + surface kind, the module resolves the
 *     workspace's CURRENT install selection through the /app-installs
 *     public contract (the exact-version identity + the SERVER-DERIVED
 *     granted scopes), pins the immutable manifest through the /apps
 *     public contract, validates the surface DECLARATION and the surface's
 *     REQUIRED data scopes against the granted scopes (fail-closed: the
 *     policy-derived grant intersection visibly constrains presentation),
 *     and dispatches to the family composer. The composition cites the
 *     incumbent authorities as the SOURCE of every figure (reproduced
 *     surfaces over the SAME authorities — never a second reporting
 *     truth);
 *   - the ACTION MENU contract: pack actions are DECLARATIONS of existing
 *     authority commands (target route + method + the granted mutation
 *     scope that must be held before the action is offered). Pack code
 *     holds ZERO mutation verbs over ANY authority — the operator's
 *     mutations flow through the EXISTING authority routes under the
 *     platform's own authorization (mos-app-ecosystem-v1.5.md "UI and
 *     developer model": "UI is presentation only and invokes server
 *     capabilities for mutations");
 *   - the BOUNDED APP STATE: an IN-MEMORY, namespaced, lineage-carrying
 *     state bag per (workspace, app key, namespace) — the manifest's own
 *     `app:<key>:<local>` namespaces only (the migration-037
 *     core-authority denylist is enforced upstream at publish and
 *     re-verified here at use), bounded in entry count and serialized
 *     size, with EXPLICIT export() and delete() semantics and canonical
 *     record lineage (spec/mos-app-ecosystem-v1.5.md "Bounded app
 *     state": "App state must expose export/delete semantics and retain
 *     lineage to canonical MOS records where it references them").
 *     DISCLOSED: v1 presentation packs (report layouts, pipeline view
 *     configs, spreadsheet document drafts, portal presentation configs)
 *     do NOT need durable tables — NO migration is taken (the MKT-051
 *     REQUIRED preference) and the module holds NO database dependency
 *     at all; persistence, should a later pack genuinely need it, is a
 *     future disclosed Work Item under the app-state namespace rules.
 *
 * What this module deliberately does NOT do (the Non-goals discipline):
 *   - NO mutation verbs over ANY authority: pack composers are READ-ONLY
 *     over /reporting, /profit-intelligence, /clients, /decisions,
 *     /evidence, /metrics and /integrations; the declared actions point
 *     at EXISTING authority routes and execute nothing themselves
 *     (asserted by tests/architecture/first-party-apps-boundary.test.ts);
 *   - NO app registry, install, trust, metering or marketplace surface:
 *     publication rides the REAL /apps command (POST /api/apps or the
 *     Developer Portal), installation/upgrade/rollback ride the REAL
 *     /app-installs commands, trust rides the REAL /app-marketplace trust
 *     command — this module only COMPOSES over their public contracts;
 *   - NO alternate workflow/execution/retry engine, NO CRM authority, NO
 *     reporting truth (every figure cites its authority view), NO tenant
 *     store (the scope chain always arrives from the install record),
 *     NO evidence store, NO policy engine (the install/upgrade/rollback
 *     policy gate stays exactly the /policies engine composed by
 *     /app-installs);
 *   - NO direct network calls, NO provider SDKs, NO secret material
 *     (state values are §21-guarded; the declared credential is a
 *     LOGICAL NAME resolved by the /credentials authority through
 *     /integrations connections, never here).
 *
 * DEPENDENCY POSTURE (the frozen-matrix row added by this Work Item:
 * /first-party-apps ──→ /apps, /app-installs, /reporting,
 * /profit-intelligence, /clients, /workspaces, /decisions, /evidence,
 * /metrics, /integrations): every consumed contract arrives through the
 * listed PUBLIC entries only (verified by tools/arch-check and
 * tests/architecture/first-party-apps-boundary.test.ts); /apps is also
 * the source of the shared §21 material-key guard reused for bounded
 * state values; /workspaces supplies the workspace enumeration the
 * /reporting scope-as-data input requires (the incumbent route's own
 * resolution, reproduced here — the composition scope chain itself
 * arrives from the install record).
 *
 * Cross-module access may only target this public entry (public.ts) —
 * internal/ is unimportable from other modules (enforced by the static
 * architecture checker, tools/arch-check).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { AppInstallsModuleApi } from '../app-installs/public.ts';
import type {
  AppManifest,
  AppUiSurfaceKind,
  AppVersionRecord,
  AppsModuleApi,
} from '../apps/public.ts';
import type { ClientsModuleApi } from '../clients/public.ts';
import type { DecisionsModuleApi } from '../decisions/public.ts';
import type { EvidenceModuleApi } from '../evidence/public.ts';
import type { IntegrationsModuleApi } from '../integrations/public.ts';
import type { MetricsModuleApi } from '../metrics/public.ts';
import type { ProfitIntelligenceModuleApi } from '../profit-intelligence/public.ts';
import type { ReportingModuleApi } from '../reporting/public.ts';
import type { WorkspacesModuleApi } from '../workspaces/public.ts';

// Re-exported so the pack sources and consumers bind to the ONE frozen
// manifest shape (the /apps registry contract — there is no second
// manifest vocabulary anywhere).
export type { AppManifest, AppUiSurfaceKind, AppVersionRecord };

// ---------------------------------------------------------------------------
// The pack family vocabulary (the four incumbent-capability families of
// the MKT-051 objective — one distinct family per first-party pack)
// ---------------------------------------------------------------------------

/**
 * The closed pack-family vocabulary: the four incumbent-capability
 * families the first-party program covers (spec/effective-backlog-v1.5.md
 * MKT-051 objective, verbatim families). Exactly one pack per family.
 */
export type FirstPartyPackFamily =
  | 'reporting-analytics'
  | 'crm-pipeline'
  | 'spreadsheet-workflows'
  | 'client-portal';

export const FIRST_PARTY_PACK_FAMILIES: readonly FirstPartyPackFamily[] = [
  'reporting-analytics',
  'crm-pipeline',
  'spreadsheet-workflows',
  'client-portal',
];

export const FIRST_PARTY_PACK_FAMILY_MEANINGS: Readonly<
  Record<FirstPartyPackFamily, string>
> = {
  'reporting-analytics':
    'command-center cards + report pages over the /reporting + /profit-intelligence public contracts',
  'crm-pipeline':
    'client-room panels + action menus over the /clients + /decisions publics',
  'spreadsheet-workflows':
    'workspace tabs + editor panes over the /evidence + /metrics observation authorities',
  'client-portal':
    'client-facing presentation surfaces over the /reporting Client Decision Room + /clients publics',
};

// ---------------------------------------------------------------------------
// The pack catalog (the disclosed first-party publisher posture)
// ---------------------------------------------------------------------------

/**
 * The disclosed FIRST-PARTY publisher identity of the program: the packs
 * publish through the internal service principal — the server-derived
 * 'svc:internal-api-token' publisher the MKT-050 marketplace derives the
 * first-party classification from ('svc:' = first-party). The publish
 * itself rides the REAL /apps command with the platform service
 * principal; this constant is the expected publisher label the tests and
 * the runbook pin (never an input — publisher identity is always
 * server-derived).
 */
export const FIRST_PARTY_PUBLISHER_IDENTITY = 'svc:internal-api-token' as const;

/** One first-party pack descriptor (the catalog read model). */
export interface FirstPartyPackDescriptor {
  readonly appKey: string;
  readonly family: FirstPartyPackFamily;
  readonly description: string;
  /** The published/publishable versions of the lineage, ascending. */
  readonly versions: readonly string[];
  /** The UI-surface kinds the pack's manifests declare. */
  readonly surfaces: readonly AppUiSurfaceKind[];
  /** The app-owned state namespaces the pack's manifests declare. */
  readonly stateNamespaces: readonly string[];
}

/**
 * The four first-party capability packs (the frozen catalog — one pack
 * per family). The manifests themselves live in
 * internal/packs/<appKey>/manifests.ts (the single publish source).
 */
export const FIRST_PARTY_APP_PACKS: readonly FirstPartyPackDescriptor[] = [
  {
    appKey: 'mos-analytics',
    family: 'reporting-analytics',
    description:
      'The first-party reporting/analytics pack: AgencyAnalytics-style command-center cards and report pages composed live over the /reporting Agency Command Center and /profit-intelligence public contracts, with connected data sources surfaced through the existing /integrations authority.',
    versions: ['1.0.0', '1.1.0'],
    surfaces: ['command-center-card', 'report-page'],
    stateNamespaces: ['app:mos-analytics:report-layouts'],
  },
  {
    appKey: 'mos-crm',
    family: 'crm-pipeline',
    description:
      'The first-party CRM/pipeline pack: HubSpot-style client-room panels and pipeline action menus composed live over the /clients and /decisions public contracts; declared actions invoke the existing decision-authority command routes.',
    versions: ['1.0.0', '1.1.0'],
    surfaces: ['client-room-panel', 'action-menu'],
    stateNamespaces: ['app:mos-crm:pipeline-views'],
  },
  {
    appKey: 'mos-sheets',
    family: 'spreadsheet-workflows',
    description:
      'The first-party spreadsheet workflows pack: Excel/Sheets-style workspace tabs and editor panes composed live over the /evidence and /metrics observation authorities, with the app-owned spreadsheet document as bounded app state carrying lineage to canonical observation ids.',
    versions: ['1.0.0', '1.1.0'],
    surfaces: ['workspace-tab', 'editor-pane'],
    stateNamespaces: ['app:mos-sheets:documents'],
  },
  {
    appKey: 'mos-portal',
    family: 'client-portal',
    description:
      'The first-party client portal pack: the client-facing presentation surfaces (client-room panels and report pages) composed live over the /reporting Client Decision Room and /clients public contracts.',
    versions: ['1.0.0', '1.1.0'],
    surfaces: ['client-room-panel', 'report-page'],
    stateNamespaces: ['app:mos-portal:presentations'],
  },
];

// ---------------------------------------------------------------------------
// The surface-scope requirement contract (the fail-closed composition map)
// ---------------------------------------------------------------------------

/**
 * The frozen per-surface REQUIRED data-scope map — the composition
 * fail-closes (403) when the install's SERVER-DERIVED granted scopes do
 * not carry every requirement of the requested surface. This is the
 * visible proof that the install-time policy intersection (request ∩
 * policy ∩ vocabulary) constrains PRESENTATION too, not only mutations.
 *
 *   - mos-analytics command-center-card → client:read (the agency
 *     rollup traverses the agency's clients);
 *   - mos-analytics report-page → workspace:read (the workspace profit
 *     report is a workspace-scoped /profit-intelligence read);
 *   - every mos-crm / mos-sheets / mos-portal surface → client:read.
 */
export const PACK_SURFACE_REQUIRED_DATA_SCOPES: Readonly<
  Record<string, ReadonlyArray<'client:read' | 'workspace:read'>>
> = {
  'mos-analytics:command-center-card': ['client:read'],
  'mos-analytics:report-page': ['workspace:read'],
  'mos-crm:client-room-panel': ['client:read'],
  'mos-crm:action-menu': ['client:read'],
  'mos-sheets:workspace-tab': ['client:read'],
  'mos-sheets:editor-pane': ['client:read'],
  'mos-portal:client-room-panel': ['client:read'],
  'mos-portal:report-page': ['client:read'],
};

/** Pure: the required data scopes of one (app key, surface) pair. */
export function requiredDataScopesForSurface(
  appKey: string,
  surface: AppUiSurfaceKind,
): readonly ('client:read' | 'workspace:read')[] {
  return PACK_SURFACE_REQUIRED_DATA_SCOPES[`${appKey}:${surface}`] ?? [];
}

// ---------------------------------------------------------------------------
// The declared action-menu contract (presentation-only declarations of
// EXISTING authority commands — zero mutation verbs in pack code)
// ---------------------------------------------------------------------------

/**
 * One DECLARED pack action: the presentation-layer declaration of an
 * EXISTING authority command. The declaration names the authority route
 * the operator's client invokes for the mutation (mos-app-ecosystem
 * -v1.5.md "UI and developer model": "UI is presentation only and
 * invokes server capabilities for mutations"); the optional
 * `requiredMutationScope` is the install-granted scope that must be held
 * before the action is OFFERED on the surface (the granted-scope gate
 * over presentation). Pack code executes NOTHING — it declares.
 */
export interface DeclaredPackAction {
  readonly actionId: string;
  readonly title: string;
  readonly description: string;
  /** The EXISTING authority command route the client invokes. */
  readonly targetRoute: string;
  readonly method: 'POST';
  /** The install-granted mutation scope required before offering (null = none). */
  readonly requiredMutationScope: 'metric:append' | null;
  /** Canonical record kind the action targets (lineage hint, read-only). */
  readonly authority: 'metrics' | 'decisions';
}

// ---------------------------------------------------------------------------
// The composed surface models (presentation over the incumbent views)
// ---------------------------------------------------------------------------

/**
 * The shared composition envelope: the exact App Version identity of the
 * CURRENT selection (historical identity preserved by the /app-installs
 * ledger), the install context and the source citations. Every surface
 * model rides this envelope so the presentation always names WHICH
 * authority views produced it (never a second truth).
 */
export interface PackSurfaceEnvelope {
  readonly app: {
    readonly appKey: string;
    readonly family: FirstPartyPackFamily;
    readonly version: string;
    readonly appVersionId: string;
    readonly publisher: string;
    /** The pinned manifest's declared capabilities (the feature set). */
    readonly capabilities: readonly string[];
  };
  readonly install: {
    readonly installId: string;
    readonly selectionSeq: number;
    readonly grantedDataScopes: readonly string[];
    readonly grantedMutationScopes: readonly string[];
  };
  readonly surface: {
    readonly kind: AppUiSurfaceKind;
    readonly route: string;
  };
  /** The incumbent authorities whose public contracts composed this model. */
  readonly composedFrom: readonly string[];
  readonly generatedAt: string;
}

/** The mos-analytics command-center-card model (agency-scoped). */
export interface AnalyticsCommandCenterCardModel {
  readonly headline: {
    readonly clientCount: number;
    readonly goalCount: number;
    readonly goalsByStatus: Readonly<Record<string, number>>;
    readonly workflowInstanceCount: number;
    readonly pendingApprovals: number;
  };
  readonly risks: {
    readonly blockedInstanceCount: number;
    readonly failedExecutionCount: number;
    readonly lowGradeEvidenceCount: number;
  };
  readonly portfolio: {
    /** The /profit-intelligence portfolio margin figure (cited, never recomputed). */
    readonly realizedMargin: { readonly amount: number | null; readonly currency: string | null };
    readonly revenueObservationCount: number;
  };
  readonly dataSources: {
    /** Connected /integrations data-source connections (read-only surface). */
    readonly connectionCount: number;
    readonly adapters: readonly string[];
  };
}

/** The mos-analytics report-page model (workspace-scoped profit report). */
export interface AnalyticsReportPageModel {
  readonly revenue: {
    readonly observationCount: number;
    readonly restatedIdentityCount: number;
  };
  readonly costs: {
    readonly deliveredJobCount: number;
    readonly inFlightJobCount: number;
  };
  readonly utilization: { readonly ratio: number | null };
  readonly scopeLeakage: { readonly indicatorCount: number };
  readonly margin: {
    readonly realizedRevenue: number | null;
    readonly realizedDeliveryCost: number | null;
    readonly realizedMargin: number | null;
    readonly currency: string | null;
  };
  readonly calculation: {
    readonly calculationVersion: string;
    readonly basis: string;
    readonly persistence: string;
  };
  /** Present from manifest capability 'compose-margin-breakdown' (v1.1.0). */
  readonly marginBreakdown: {
    readonly estimatedRevenue: number | null;
    readonly estimatedDeliveryCost: number | null;
  } | null;
}

/** The mos-crm client-room-panel model (client + decision pipeline). */
export interface CrmClientRoomPanelModel {
  readonly client: {
    readonly clientId: string;
    readonly name: string;
    readonly status: string;
  };
  readonly pipeline: {
    readonly totalDecisions: number;
    readonly proposed: number;
    readonly accepted: number;
    readonly rejected: number;
    readonly superseded: number;
  };
  readonly recentDecisions: readonly {
    readonly decisionId: string;
    readonly objective: string;
    readonly status: string;
    readonly proposedAt: string;
  }[];
}

/** The mos-crm action-menu model (declared existing authority commands). */
export interface CrmActionMenuModel {
  readonly actions: readonly DeclaredPackAction[];
}

/** The mos-sheets workspace-tab model (the observation workbook summary). */
export interface SheetsWorkspaceTabModel {
  readonly workbook: {
    readonly sheetName: string;
    readonly evidenceRowCount: number;
    readonly metricRowCount: number;
  };
  readonly evidenceSheet: readonly {
    readonly evidenceId: string;
    readonly class: string;
    readonly quality: string;
    readonly observedAt: string;
  }[];
  readonly metricsSheet: readonly {
    readonly observationId: string;
    readonly metricName: string;
    readonly value: number;
    readonly unit: string;
    readonly observedAt: string;
  }[];
}

/** The mos-sheets editor-pane model (the app-owned spreadsheet document). */
export interface SheetsEditorPaneModel {
  readonly document: {
    readonly namespace: 'app:mos-sheets:documents';
    readonly documentKey: string | null;
    /** The document's cells with LINEAGE to canonical observation ids. */
    readonly cells: readonly {
      readonly cell: string;
      readonly formula: string;
      readonly value: number | null;
      readonly lineageObservationId: string | null;
    }[];
  };
  readonly offeredActions: readonly DeclaredPackAction[];
  /** The action-offering gate: the granted 'metric:append' scope (null when not granted). */
  readonly observationActionOffered: boolean;
}

/** The mos-portal client-room-panel model (client-facing highlights). */
export interface PortalClientRoomPanelModel {
  readonly client: {
    readonly clientId: string;
    readonly name: string;
    readonly status: string;
  };
  readonly room: {
    readonly goalCount: number;
    readonly experimentCount: number;
    readonly pendingApprovals: number;
    readonly recommendationCount: number;
  };
  /** Present from manifest capability 'compose-portal-highlights' (v1.1.0). */
  readonly highlights: readonly string[] | null;
}

/** The mos-portal report-page model (the client-facing report). */
export interface PortalReportPageModel {
  readonly client: { readonly name: string };
  readonly evidenceQuality: Readonly<Record<string, number>>;
  readonly experiments: Readonly<Record<string, number>>;
  readonly generatedAt: string;
}

/** One composed pack surface: the envelope + the family model. */
export type PackSurfaceComposition =
  | (PackSurfaceEnvelope & { readonly model: AnalyticsCommandCenterCardModel })
  | (PackSurfaceEnvelope & { readonly model: AnalyticsReportPageModel })
  | (PackSurfaceEnvelope & { readonly model: CrmClientRoomPanelModel })
  | (PackSurfaceEnvelope & { readonly model: CrmActionMenuModel })
  | (PackSurfaceEnvelope & { readonly model: SheetsWorkspaceTabModel })
  | (PackSurfaceEnvelope & { readonly model: SheetsEditorPaneModel })
  | (PackSurfaceEnvelope & { readonly model: PortalClientRoomPanelModel })
  | (PackSurfaceEnvelope & { readonly model: PortalReportPageModel });

// ---------------------------------------------------------------------------
// The bounded app state (in-memory, namespaced, lineage-carrying,
// export/delete semantics — spec/mos-app-ecosystem-v1.5.md "Bounded app
// state"; NO durable state, NO migration — the MKT-051 required
// preference, disclosed)
// ---------------------------------------------------------------------------

/** One canonical-record lineage reference an app-state entry carries. */
export interface PackStateLineageRef {
  /** The canonical record kind the entry references. */
  readonly kind:
    | 'metric-observation'
    | 'evidence-record'
    | 'decision-record'
    | 'client-record'
    | 'authority-view';
  /** The canonical record id (or the cited view label for 'authority-view'). */
  readonly id: string;
}

/** One bounded app-state record (the read model). */
export interface PackAppStateRecord {
  readonly workspaceId: string;
  readonly appKey: string;
  readonly namespace: string;
  /** Bounded JSON entries (string keys, §21-guarded values). */
  readonly entries: Readonly<Record<string, unknown>>;
  /** Canonical-record lineage references (bounded, deduplicated). */
  readonly lineage: readonly PackStateLineageRef[];
  readonly updatedAt: string;
}

/** The export serialization of one bounded app-state record. */
export interface PackAppStateExport {
  readonly semantics: 'mos-app-state-export';
  readonly appKey: string;
  readonly namespace: string;
  /** The App Version identity the export was taken under. */
  readonly version: string;
  readonly appVersionId: string;
  readonly entries: Readonly<Record<string, unknown>>;
  readonly lineage: readonly PackStateLineageRef[];
  readonly exportedAt: string;
}

/** The bounded-state input guards' shared bounds (frozen, disclosed). */
export const PACK_STATE_MAX_ENTRIES = 64;
export const PACK_STATE_MAX_SERIALIZED_BYTES = 65_536;
export const PACK_STATE_MAX_LINEAGE_REFS = 64;

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

export interface FirstPartyAppsModuleApi {
  /**
   * The pack catalog (pure read): the four first-party pack descriptors,
   * each enriched with the LIVE registry state — the published versions of
   * the lineage through the /apps public contract and the workspace's
   * current install selection through the /app-installs public contract
   * (null when not installed). Pure read: no state changes.
   */
  listFirstPartyPacks(input: {
    readonly workspaceId: string;
  }): Promise<
    readonly (FirstPartyPackDescriptor & {
      readonly publishedVersions: readonly string[];
      readonly currentSelection: {
        readonly installId: string;
        readonly version: string;
        readonly grantedDataScopes: readonly string[];
        readonly grantedMutationScopes: readonly string[];
      } | null;
    })[]
  >;

  /**
   * COMPOSES one declared pack surface for the workspace's CURRENT
   * install selection (the App-model invoke/read). The current selection
   * resolves through the /app-installs public contract — an app that is
   * not installed in the workspace fails closed (uniform NotFound); the
   * pinned immutable manifest resolves through the /apps public contract
   * (the EXACT App Version identity — future-selection semantics: after
   * an upgrade the composition uses the NEW version's manifest; after a
   * rollback the reselected one). The requested surface must be DECLARED
   * in the pinned manifest's uiSurfaces (an undeclared surface is a 422
   * with zero side effects) and the surface's REQUIRED data scopes must
   * be held in the install's SERVER-DERIVED granted scopes (a missing
   * grant is a 403 — the policy intersection visibly constrains
   * presentation). The family composer then derives the presentation
   * model LIVE from the incumbent authorities' public contracts with
   * canonical source citations. Read-only: no authority state changes.
   */
  composePackSurface(input: {
    readonly workspaceId: string;
    readonly appKey: string;
    readonly surface: AppUiSurfaceKind;
    /** Optional app-state document key (the sheets editor pane's document). */
    readonly documentKey?: string | null;
  }): Promise<PackSurfaceComposition>;

  /**
   * READS the bounded app state of one (workspace, app, namespace) — the
   * app-owned presentation state (report layouts, pipeline views,
   * spreadsheet documents, portal presentation configs). The namespace
   * must be DECLARED in the current selection's pinned manifest (an
   * undeclared namespace is a 422 — bounded state cannot escape the
   * manifest's own app:<key>:<local> namespaces). Null when no state was
   * recorded yet. In-memory: no durable state exists (disclosed).
   */
  readPackAppState(input: {
    readonly workspaceId: string;
    readonly appKey: string;
    readonly namespace: string;
  }): Promise<PackAppStateRecord | null>;

  /**
   * MUTATES the bounded app state: sets and/or deletes entries, appending
   * canonical-record lineage references. The namespace must be declared
   * in the current selection's pinned manifest; values are §21-guarded
   * (no material-shaped keys anywhere — the shared /apps guard); the
   * record is bounded (entry count, serialized size, lineage refs — a
   * violation is a 422 with zero state change). App-owned state only:
   * NO authority table is touched (asserted by the integration tests
   * with direct SQL counts).
   */
  mutatePackAppState(input: {
    readonly workspaceId: string;
    readonly appKey: string;
    readonly namespace: string;
    readonly set: Readonly<Record<string, unknown>>;
    readonly delete: readonly string[];
    readonly lineage: readonly PackStateLineageRef[];
  }): Promise<PackAppStateRecord>;

  /**
   * EXPORTS the bounded app state (the spec's export semantics): the
   * full serialization of the record under the current App Version
   * identity. An empty/unknown state is an honest 404 (nothing fabricated).
   */
  exportPackAppState(input: {
    readonly workspaceId: string;
    readonly appKey: string;
    readonly namespace: string;
  }): Promise<PackAppStateExport>;

  /**
   * DELETES the bounded app state of one namespace (the spec's delete
   * semantics — app-owned state is disposable; authority history is NOT).
   * Returns whether a record existed. In-memory only: no authority state
   * is ever deletable from here.
   */
  deletePackAppState(input: {
    readonly workspaceId: string;
    readonly appKey: string;
    readonly namespace: string;
  }): Promise<boolean>;
}

export interface FirstPartyAppsModuleDeps {
  readonly clock: Clock;
  /**
   * Matrix-listed direction: the App registry — the pinned immutable
   * manifest of the current selection's exact App Version. READ-ONLY.
   */
  readonly apps: AppsModuleApi;
  /**
   * Matrix-listed direction: the App installation ledger — the
   * workspace's CURRENT selections with their SERVER-DERIVED granted
   * scopes (the invoke/read composition context). READ-ONLY.
   */
  readonly appInstalls: AppInstallsModuleApi;
  /** Matrix-listed direction: the incumbent reporting authority. READ-ONLY. */
  readonly reporting: ReportingModuleApi;
  /** Matrix-listed direction: the incumbent profit analytics. READ-ONLY. */
  readonly profitIntelligence: ProfitIntelligenceModuleApi;
  /** Matrix-listed direction: the client authority. READ-ONLY. */
  readonly clients: ClientsModuleApi;
  /**
   * Matrix-listed direction: the workspace enumeration the /reporting
   * contract's scope-as-data input requires (the incumbent route's own
   * resolution, reproduced here). READ-ONLY.
   */
  readonly workspaces: WorkspacesModuleApi;
  /** Matrix-listed direction: the Decision Ledger authority. READ-ONLY. */
  readonly decisions: DecisionsModuleApi;
  /** Matrix-listed direction: the evidence observation authority. READ-ONLY. */
  readonly evidence: EvidenceModuleApi;
  /** Matrix-listed direction: the metric observation authority. READ-ONLY. */
  readonly metrics: MetricsModuleApi;
  /**
   * Matrix-listed direction: the integration connection authority — the
   * connected data sources of the declared connectors (the network
   * declaration is POLICY/CONNECTION territory: pack code makes zero
   * network calls). READ-ONLY.
   */
  readonly integrations: IntegrationsModuleApi;
}

export { createFirstPartyAppsModule } from './internal/module.ts';
/**
 * The pure bounded-state input guards (the §21 material-key backstop over
 * state values via the shared /apps guard, the entry/size/lineage bounds)
 * and the pure manifest-shape helpers of the pack catalog — exported for
 * unit tests and future server-side callers so the guard semantics are
 * part of the module contract. Pure functions.
 */
export {
  packAppStateKey,
  packStateMutationProblems,
  declaredActionFor,
  packCatalogEntry,
  MOS_SHEETS_APPEND_OBSERVATION_ACTION,
} from './internal/state.ts';
