/**
 * The aggregated first-party pack catalog + the bounded app-state engine
 * and input guards (MKT-051).
 *
 * Two concerns live here:
 *   1. the PACK CATALOG — the frozen aggregation of the four packs'
 *      manifests (the single publish source surface the module and the
 *      tests consume; one pack per incumbent-capability family);
 *   2. the BOUNDED APP STATE — the in-memory, namespaced, lineage-
 *      carrying state bag with the pure input guards (§21 material-key
 *      backstop via the SHARED /apps guard payloadHasNoAppsMaterialKeys,
 *      entry/size/lineage bounds, the manifest-namespace fence). NO
 *      durable state: the module takes NO migration and holds NO
 *      database dependency (the MKT-051 required preference,
 *      disclosed) — the state is presentation-layer app-owned data
 *      (mos-app-ecosystem-v1.5.md "Bounded app state").
 */

import {
  payloadHasNoAppsMaterialKeys,
  type AppManifest,
} from '../../apps/public.ts';
import type {
  FirstPartyPackDescriptor,
  PackStateLineageRef,
} from '../public.ts';
import { MOS_ANALYTICS_MANIFESTS } from './packs/mos-analytics/manifests.ts';
import { MOS_CRM_MANIFESTS } from './packs/mos-crm/manifests.ts';
import { MOS_PORTAL_MANIFESTS } from './packs/mos-portal/manifests.ts';
import { MOS_SHEETS_MANIFESTS } from './packs/mos-sheets/manifests.ts';

// ---------------------------------------------------------------------------
// The pack catalog (the single publish source, aggregated)
// ---------------------------------------------------------------------------

/** All first-party pack manifests, pack-major, version-ascending. */
export const FIRST_PARTY_PACK_MANIFESTS: readonly (readonly AppManifest[])[] = [
  MOS_ANALYTICS_MANIFESTS,
  MOS_CRM_MANIFESTS,
  MOS_SHEETS_MANIFESTS,
  MOS_PORTAL_MANIFESTS,
];

/**
 * The flattened catalog: every (pack, version) manifest of the program
 * (8 manifests — 4 packs x 2 versions). The publish path iterates THIS
 * list (through the REAL /apps command, one publish per manifest).
 */
export function allFirstPartyManifests(): readonly AppManifest[] {
  return FIRST_PARTY_PACK_MANIFESTS.flat();
}

/** Pure: the catalog descriptor of one app key (null when unknown). */
export function packCatalogEntry(appKey: string): FirstPartyPackDescriptor | null {
  const manifests = allFirstPartyManifests().filter(
    (manifest) => manifest.appKey === appKey,
  );
  if (manifests.length === 0) return null;
  const [first] = manifests;
  if (first === undefined) return null;
  const surfaces = new Set(first.uiSurfaces.map((surface) => surface.surface));
  const stateNamespaces = new Set(first.stateNamespaces);
  for (const manifest of manifests.slice(1)) {
    for (const surface of manifest.uiSurfaces) surfaces.add(surface.surface);
    for (const namespace of manifest.stateNamespaces) stateNamespaces.add(namespace);
  }
  const family =
    appKey === 'mos-analytics'
      ? ('reporting-analytics' as const)
      : appKey === 'mos-crm'
        ? ('crm-pipeline' as const)
        : appKey === 'mos-sheets'
          ? ('spreadsheet-workflows' as const)
          : ('client-portal' as const);
  return {
    appKey,
    family,
    description: FIRST_PARTY_APP_DESCRIPTIONS[appKey] ?? '',
    versions: manifests.map((manifest) => manifest.version),
    surfaces: [...surfaces],
    stateNamespaces: [...stateNamespaces],
  };
}

const FIRST_PARTY_APP_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'mos-analytics':
    'The first-party reporting/analytics pack: AgencyAnalytics-style command-center cards and report pages composed live over the /reporting Agency Command Center and /profit-intelligence public contracts, with connected data sources surfaced through the existing /integrations authority.',
  'mos-crm':
    'The first-party CRM/pipeline pack: HubSpot-style client-room panels and pipeline action menus composed live over the /clients and /decisions public contracts; declared actions invoke the existing decision-authority command routes.',
  'mos-sheets':
    'The first-party spreadsheet workflows pack: Excel/Sheets-style workspace tabs and editor panes composed live over the /evidence and /metrics observation authorities, with the app-owned spreadsheet document as bounded app state carrying lineage to canonical observation ids.',
  'mos-portal':
    'The first-party client portal pack: the client-facing presentation surfaces (client-room panels and report pages) composed live over the /reporting Client Decision Room and /clients public contracts.',
};

// ---------------------------------------------------------------------------
// The declared action catalog (presentation-only declarations of EXISTING
// authority commands — zero mutation verbs in pack code)
// ---------------------------------------------------------------------------

import type { DeclaredPackAction } from '../public.ts';

/**
 * The mos-sheets 'append-observation' declared action: the presentation
 * declaration of the /metrics authority's OWN append command. Offered on
 * the editor-pane surface only when the install's SERVER-DERIVED granted
 * mutation scopes include 'metric:append'; the invocation contract is
 * the EXISTING authority route (pack code never executes a mutation).
 */
export const MOS_SHEETS_APPEND_OBSERVATION_ACTION: DeclaredPackAction = {
  actionId: 'mos-sheets:append-observation',
  title: 'Append metric observation',
  description:
    'Append one metric observation row to the workbook through the existing /metrics authority append command (the platform authorizes the mutation on the authority route; this app only declares and links it).',
  targetRoute: '/api/clients/:clientId/metrics',
  method: 'POST',
  requiredMutationScope: 'metric:append',
  authority: 'metrics',
};

/**
 * The mos-crm 'record-decision' declared action: the presentation
 * declaration of the /decisions authority's OWN record command. No
 * mutation scope is required to OFFER it (the authority route performs
 * the platform's own authorization when invoked).
 */
export const MOS_CRM_RECORD_DECISION_ACTION: DeclaredPackAction = {
  actionId: 'mos-crm:record-decision',
  title: 'Record decision',
  description:
    'Record one decision on the pipeline through the existing /decisions authority command (the platform authorizes the mutation on the authority route; this app only declares and links it).',
  targetRoute: '/api/clients/:clientId/decisions',
  method: 'POST',
  requiredMutationScope: null,
  authority: 'decisions',
};

/** Pure: the declared actions of one (app key, surface) pair. */
export function declaredActionFor(
  appKey: string,
  surfaceKind: string,
): readonly DeclaredPackAction[] {
  if (appKey === 'mos-sheets' && surfaceKind === 'editor-pane') {
    return [MOS_SHEETS_APPEND_OBSERVATION_ACTION];
  }
  if (appKey === 'mos-crm' && surfaceKind === 'action-menu') {
    return [MOS_CRM_RECORD_DECISION_ACTION];
  }
  return [];
}

// ---------------------------------------------------------------------------
// The bounded app state (in-memory; the pure guards)
// ---------------------------------------------------------------------------

import {
  PACK_STATE_MAX_ENTRIES,
  PACK_STATE_MAX_LINEAGE_REFS,
  PACK_STATE_MAX_SERIALIZED_BYTES,
  type PackAppStateRecord,
} from '../public.ts';

const LINEAGE_KINDS: ReadonlySet<string> = new Set([
  'metric-observation',
  'evidence-record',
  'decision-record',
  'client-record',
  'authority-view',
]);

/** Pure: the in-memory state map key of one (workspace, app, namespace). */
export function packAppStateKey(
  workspaceId: string,
  appKey: string,
  namespace: string,
): string {
  return `${workspaceId}|${appKey}|${namespace}`;
}

/**
 * The pure bounded-state mutation guard: returns the honest problem list
 * of one candidate mutation (empty = valid). Enforces:
 *   - the namespace pattern app:<own app key>:<local> (the frozen
 *     migration-037 shape — bounded state cannot escape the pack's own
 *     namespaces);
 *   - §21: NO material-shaped key anywhere in the entries payload (the
 *     SHARED /apps guard — the same backstop every authority uses);
 *   - the entry-count bound (post-mutation), the serialized-size bound
 *     and the lineage-ref bound (count + closed kind vocabulary).
 * Pure: no state is touched.
 */
export function packStateMutationProblems(input: {
  readonly appKey: string;
  readonly namespace: string;
  readonly nextEntries: Readonly<Record<string, unknown>>;
  readonly lineage: readonly PackStateLineageRef[];
}): string[] {
  const problems: string[] = [];
  const pattern = new RegExp(`^app:${input.appKey}:[a-z][a-z0-9-]{1,30}$`);
  if (!pattern.test(input.namespace)) {
    problems.push(
      `namespace: '${input.namespace}' is not one of this app's own bounded namespaces (app:${input.appKey}:<local>)`,
    );
  }
  const entryKeys = Object.keys(input.nextEntries);
  if (entryKeys.length > PACK_STATE_MAX_ENTRIES) {
    problems.push(
      `entries: at most ${PACK_STATE_MAX_ENTRIES} entries are allowed (bounded app state)`,
    );
  }
  for (const key of entryKeys) {
    if (key.length < 1 || key.length > 64) {
      problems.push(`entries: entry keys must be 1-64 characters ('${key}')`);
    }
  }
  problems.push(
    ...payloadHasNoAppsMaterialKeys(input.nextEntries, 'entries').map((problem) =>
      problem.replace(
        'secrets never appear in app manifests',
        'bounded app state carries no secret material',
      ),
    ),
  );
  const serialized = JSON.stringify(input.nextEntries) ?? '';
  if (serialized.length > PACK_STATE_MAX_SERIALIZED_BYTES) {
    problems.push(
      `entries: the record must serialize to at most ${PACK_STATE_MAX_SERIALIZED_BYTES} bytes (bounded app state)`,
    );
  }
  if (input.lineage.length > PACK_STATE_MAX_LINEAGE_REFS) {
    problems.push(
      `lineage: at most ${PACK_STATE_MAX_LINEAGE_REFS} canonical references are allowed`,
    );
  }
  for (const [index, ref] of input.lineage.entries()) {
    if (!LINEAGE_KINDS.has(ref.kind)) {
      problems.push(`lineage[${index}].kind: '${ref.kind}' is not in the closed lineage vocabulary`);
    }
    if (typeof ref.id !== 'string' || ref.id.length < 1 || ref.id.length > 128) {
      problems.push(`lineage[${index}].id: must be 1-128 characters`);
    }
  }
  return problems;
}

/**
 * The in-memory bounded app-state bag (NOT a durable store — disclosed):
 * a Map keyed by packAppStateKey holding plain records. Created once per
 * composition root instance; the state is process-local presentation
 * state with export/delete semantics (mos-app-ecosystem-v1.5.md
 * "Bounded app state": app state "must expose export/delete semantics
 * and retain lineage to canonical MOS records where it references
 * them").
 */
export class PackAppStateBag {
  private readonly records = new Map<string, PackAppStateRecord>();

  read(key: string): PackAppStateRecord | null {
    return this.records.get(key) ?? null;
  }

  write(key: string, record: PackAppStateRecord): void {
    this.records.set(key, record);
  }

  delete(key: string): boolean {
    return this.records.delete(key);
  }
}
