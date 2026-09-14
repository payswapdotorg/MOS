/**
 * The mos-crm pack manifests — the CRM/pipeline family (MKT-051 AC-1b:
 * "CRM/pipeline (client-room panels + action menus over /clients +
 * /decisions publics)").
 *
 * The SINGLE PUBLISH SOURCE (the /apps registry publish path rides these
 * typed definitions). Version 1.0.0 is the initial capability set; 1.1.0
 * adds 'compose-pipeline-summary' (the upgrade/rollback lifecycle proof).
 *
 * Incumbent-capability discipline: the client roster comes from the
 * /clients public contract and the pipeline stages from the /decisions
 * Decision Ledger — the pack REPRODUCES a HubSpot-style client-room
 * panel over the SAME authorities and never becomes a second CRM
 * authority (no client/pipeline table of its own, no mutation verb).
 * The declared action menu points at the EXISTING decisions command
 * route; pack code executes nothing.
 */

import type { AppManifest } from '../../../../apps/public.ts';

/** The v1.0.0 manifest (the initial capability set). */
export const MOS_CRM_MANIFEST_1_0_0: AppManifest = {
  appKey: 'mos-crm',
  version: '1.0.0',
  compatibility: { minPlatform: '1.0.0', maxPlatform: '2.0.0' },
  capabilities: [
    { name: 'compose-client-pipeline-panel', version: '1.0.0' },
    { name: 'compose-pipeline-action-menu', version: '1.0.0' },
  ],
  inputSchema: { required: ['workspaceId'] },
  outputSchema: { required: ['app', 'model'] },
  dataScopes: ['client:read'],
  mutationScopes: [],
  networkDestinations: [],
  runtimeClass: 'pooled-worker',
  eventSubscriptions: [],
  uiSurfaces: [
    { surface: 'client-room-panel', route: '/apps/mos-crm/client-room-panel' },
    { surface: 'action-menu', route: '/apps/mos-crm/action-menu' },
  ],
  configSchema: {
    pipelineView: {
      type: 'string',
      required: false,
      description: 'The default pipeline view label (e.g. by-objective).',
      pattern: '^[a-z][a-z0-9-]{0,31}$',
    },
  },
  requiredCredentialNames: [],
  stateNamespaces: ['app:mos-crm:pipeline-views'],
  migrationVersion: 0,
  dependencies: [],
  supportLevel: 'first-party',
  meteringDimensions: ['installations', 'invocations'],
};

/** The v1.1.0 manifest (adds the pipeline-summary capability). */
export const MOS_CRM_MANIFEST_1_1_0: AppManifest = {
  ...MOS_CRM_MANIFEST_1_0_0,
  version: '1.1.0',
  capabilities: [
    ...MOS_CRM_MANIFEST_1_0_0.capabilities,
    { name: 'compose-pipeline-summary', version: '1.0.0' },
  ],
};

/** All mos-crm manifests, ascending (the publish source). */
export const MOS_CRM_MANIFESTS: readonly AppManifest[] = [
  MOS_CRM_MANIFEST_1_0_0,
  MOS_CRM_MANIFEST_1_1_0,
];
