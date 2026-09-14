/**
 * The spreadsheet-workflows family composer (mos-sheets) — the
 * PRESENTATION-ONLY composition over the /evidence + /metrics observation
 * authorities (MKT-051 AC-1c).
 *
 * INCUMBENT-CAPABILITY DISCIPLINE (the Non-goals rule): the workbook's
 * rows ARE the /evidence and /metrics observation ledgers — the pack
 * reproduces the Excel/Sheets-style workspace tab + editor pane over the
 * SAME observation authorities and never becomes a second evidence
 * store. The app-owned spreadsheet DOCUMENT lives in the bounded app
 * state (app:mos-sheets:documents) with export/delete semantics and
 * lineage to canonical observation ids.
 *
 * The declared 'append-observation' action is gated by the install's
 * granted 'metric:append' mutation scope and points at the EXISTING
 * /api/clients/:clientId/metrics route — the /metrics authority's own
 * append command. Pack code executes NOTHING.
 */

import {
  MOS_SHEETS_APPEND_OBSERVATION_ACTION,
  declaredActionFor,
} from '../../state.ts';
import type {
  AppManifest,
  FirstPartyAppsModuleDeps,
  PackStateLineageRef,
  PackAppStateRecord,
  SheetsEditorPaneModel,
  SheetsWorkspaceTabModel,
} from '../../../public.ts';

/** The bounded sheet-row cap (presentation paging — never a truth limit). */
const SHEET_ROW_CAP = 25;

/**
 * Composes the observation workbook workspace tab: the client's evidence
 * ledger and metric observation ledger presented as sheet rows (cited
 * canonical ids — the authorities remain the only truth). READ-ONLY.
 */
export async function composeSheetsWorkspaceTab(
  deps: FirstPartyAppsModuleDeps,
  scope: { readonly clientId: string },
  manifest: AppManifest,
): Promise<SheetsWorkspaceTabModel> {
  const evidence = await deps.evidence.listEvidenceForClient(scope.clientId);
  const metrics = await deps.metrics.listMetricObservationsForClient(scope.clientId);

  const hasFormulaSummary = manifest.capabilities.some(
    (capability) => capability.name === 'compose-formula-summary',
  );
  void hasFormulaSummary;

  return {
    workbook: {
      sheetName: `observations-${scope.clientId.slice(0, 8)}`,
      evidenceRowCount: evidence.length,
      metricRowCount: metrics.length,
    },
    evidenceSheet: evidence
      .slice(0, SHEET_ROW_CAP)
      .map((record) => ({
        evidenceId: record.evidenceId,
        class: record.class,
        quality: record.quality,
        observedAt: record.observedAt,
      })),
    metricsSheet: metrics
      .slice(0, SHEET_ROW_CAP)
      .map((record) => ({
        observationId: record.observationId,
        metricName: record.metricName,
        value: record.value,
        unit: record.unit,
        observedAt: record.observedAt,
      })),
  };
}

/** The serialized cell shape of a spreadsheet document entry. */
export interface SheetDocumentCell {
  readonly cell: string;
  readonly formula: string;
  readonly value: number | null;
  readonly lineageObservationId: string | null;
}

/**
 * Composes the spreadsheet editor pane: the app-owned DOCUMENT from the
 * bounded app state (namespace app:mos-sheets:documents) presented as
 * cells with LINEAGE to canonical observation ids, plus the DECLARED
 * actions offered under the install's granted mutation scopes (the
 * 'append-observation' action appears only when 'metric:append' is
 * granted — the policy intersection visibly constrains presentation).
 * READ-ONLY over the authorities; the document is app-owned bounded
 * state only.
 */
export function composeSheetsEditorPane(
  deps: FirstPartyAppsModuleDeps,
  scope: { readonly workspaceId: string },
  manifest: AppManifest,
  state: PackAppStateRecord | null,
  grantedMutationScopes: readonly string[],
  documentKey: string | null,
): SheetsEditorPaneModel {
  const cells: SheetDocumentCell[] = [];
  if (state !== null) {
    const key = documentKey ?? 'default';
    const document = state.entries[key];
    if (document !== null && typeof document === 'object' && !Array.isArray(document)) {
      const record = document as Readonly<Record<string, unknown>>;
      const recordCells = record['cells'];
      if (Array.isArray(recordCells)) {
        for (const entry of recordCells) {
          if (entry === null || typeof entry !== 'object') continue;
          const cell = entry as Readonly<Record<string, unknown>>;
          if (
            typeof cell['cell'] === 'string' &&
            typeof cell['formula'] === 'string'
          ) {
            cells.push({
              cell: cell['cell'],
              formula: cell['formula'],
              value: typeof cell['value'] === 'number' ? cell['value'] : null,
              lineageObservationId:
                typeof cell['lineageObservationId'] === 'string'
                  ? cell['lineageObservationId']
                  : null,
            });
          }
        }
      }
    }
  }

  const observationActionOffered = grantedMutationScopes.includes('metric:append');

  const offered = observationActionOffered
    ? [
        MOS_SHEETS_APPEND_OBSERVATION_ACTION,
        ...declaredActionFor('mos-sheets', 'editor-pane').filter(
          (action) => action.actionId !== MOS_SHEETS_APPEND_OBSERVATION_ACTION.actionId,
        ),
      ]
    : [];

  void deps;
  void scope;
  void manifest;

  return {
    document: {
      namespace: 'app:mos-sheets:documents',
      documentKey,
      cells,
    },
    offeredActions: offered,
    observationActionOffered,
  };
}

/** Pure: the lineage refs of one document's cells (canonical observation ids). */
export function sheetDocumentLineageOf(cells: readonly SheetDocumentCell[]): readonly PackStateLineageRef[] {
  const refs: PackStateLineageRef[] = [];
  for (const cell of cells) {
    if (cell.lineageObservationId !== null) {
      refs.push({ kind: 'metric-observation', id: cell.lineageObservationId });
    }
  }
  return refs;
}
