/**
 * The mos-sheets pack manifests — the spreadsheet-workflows family
 * (MKT-051 AC-1c: "spreadsheet workflows (workspace tabs + editor panes
 * over /evidence + /metrics observation authorities)").
 *
 * The SINGLE PUBLISH SOURCE (the /apps registry publish path rides these
 * typed definitions). Version 1.0.0 is the initial capability set; 1.1.0
 * adds 'compose-formula-summary' (the upgrade/rollback lifecycle proof).
 *
 * Incumbent-capability discipline: the workbook's rows are the /evidence
 * and /metrics observation ledgers themselves — the pack REPRODUCES the
 * Excel/Sheets-style workspace tab + editor pane over the SAME
 * observation authorities and never becomes a second evidence store.
 * The app-owned spreadsheet DOCUMENT lives in the bounded app state
 * namespace app:mos-sheets:documents (in-memory in this module, with
 * export/delete semantics and lineage to canonical observation ids).
 *
 * The declared 'append-observation' action is gated by the install's
 * granted 'metric:append' mutation scope: the action DECLARES the
 * EXISTING /api/clients/:clientId/metrics route (the /metrics
 * authority's own append command) — when offered and invoked, the
 * mutation flows through the authority route under the platform's own
 * authorization, never through pack code.
 */

import type { AppManifest } from '../../../../apps/public.ts';

/** The v1.0.0 manifest (the initial capability set). */
export const MOS_SHEETS_MANIFEST_1_0_0: AppManifest = {
  appKey: 'mos-sheets',
  version: '1.0.0',
  compatibility: { minPlatform: '1.0.0', maxPlatform: '2.0.0' },
  capabilities: [
    { name: 'compose-observation-workbook', version: '1.0.0' },
    { name: 'compose-spreadsheet-editor', version: '1.0.0' },
  ],
  inputSchema: { required: ['workspaceId'] },
  outputSchema: { required: ['app', 'model'] },
  dataScopes: ['client:read'],
  mutationScopes: ['metric:append'],
  networkDestinations: [],
  runtimeClass: 'pooled-worker',
  eventSubscriptions: [],
  uiSurfaces: [
    { surface: 'workspace-tab', route: '/apps/mos-sheets/workspace-tab' },
    { surface: 'editor-pane', route: '/apps/mos-sheets/editor-pane' },
  ],
  configSchema: {
    defaultDocumentKey: {
      type: 'string',
      required: false,
      description: 'The default spreadsheet document key opened in the editor pane.',
      pattern: '^[a-z0-9][a-z0-9-]{0,63}$',
    },
  },
  requiredCredentialNames: [],
  stateNamespaces: ['app:mos-sheets:documents'],
  migrationVersion: 0,
  dependencies: [],
  supportLevel: 'first-party',
  meteringDimensions: ['installations', 'invocations', 'data-volume'],
};

/** The v1.1.0 manifest (adds the formula-summary capability). */
export const MOS_SHEETS_MANIFEST_1_1_0: AppManifest = {
  ...MOS_SHEETS_MANIFEST_1_0_0,
  version: '1.1.0',
  capabilities: [
    ...MOS_SHEETS_MANIFEST_1_0_0.capabilities,
    { name: 'compose-formula-summary', version: '1.0.0' },
  ],
};

/** All mos-sheets manifests, ascending (the publish source). */
export const MOS_SHEETS_MANIFESTS: readonly AppManifest[] = [
  MOS_SHEETS_MANIFEST_1_0_0,
  MOS_SHEETS_MANIFEST_1_1_0,
];
