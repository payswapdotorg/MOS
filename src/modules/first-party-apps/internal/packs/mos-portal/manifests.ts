/**
 * The mos-portal pack manifests — the client-portal family (MKT-051
 * AC-1d: "client portal (client-facing presentation surfaces)").
 *
 * The SINGLE PUBLISH SOURCE (the /apps registry publish path rides these
 * typed definitions). Version 1.0.0 is the initial capability set; 1.1.0
 * adds 'compose-portal-highlights' (the upgrade/rollback lifecycle
 * proof).
 *
 * Incumbent-capability discipline: the client-facing room is the
 * /reporting Client Decision Room and the client roster the /clients
 * public contract — the pack REPRODUCES the client-facing presentation
 * surfaces over the SAME authorities. The portal's own presentation
 * configuration is bounded app state (app:mos-portal:presentations);
 * every underlying figure remains authority-owned.
 */

import type { AppManifest } from '../../../../apps/public.ts';

/** The v1.0.0 manifest (the initial capability set). */
export const MOS_PORTAL_MANIFEST_1_0_0: AppManifest = {
  appKey: 'mos-portal',
  version: '1.0.0',
  compatibility: { minPlatform: '1.0.0', maxPlatform: '2.0.0' },
  capabilities: [
    { name: 'compose-portal-client-room', version: '1.0.0' },
    { name: 'compose-portal-report', version: '1.0.0' },
  ],
  inputSchema: { required: ['workspaceId'] },
  outputSchema: { required: ['app', 'model'] },
  dataScopes: ['client:read'],
  mutationScopes: [],
  networkDestinations: [],
  runtimeClass: 'pooled-worker',
  eventSubscriptions: [],
  uiSurfaces: [
    { surface: 'client-room-panel', route: '/apps/mos-portal/client-room-panel' },
    { surface: 'report-page', route: '/apps/mos-portal/report-page' },
  ],
  configSchema: {
    presentationTheme: {
      type: 'string',
      required: false,
      description: 'The portal presentation theme label (e.g. default).',
      pattern: '^[a-z][a-z0-9-]{0,31}$',
    },
  },
  requiredCredentialNames: [],
  stateNamespaces: ['app:mos-portal:presentations'],
  migrationVersion: 0,
  dependencies: [],
  supportLevel: 'first-party',
  meteringDimensions: ['installations', 'invocations'],
};

/** The v1.1.0 manifest (adds the portal-highlights capability). */
export const MOS_PORTAL_MANIFEST_1_1_0: AppManifest = {
  ...MOS_PORTAL_MANIFEST_1_0_0,
  version: '1.1.0',
  capabilities: [
    ...MOS_PORTAL_MANIFEST_1_0_0.capabilities,
    { name: 'compose-portal-highlights', version: '1.0.0' },
  ],
};

/** All mos-portal manifests, ascending (the publish source). */
export const MOS_PORTAL_MANIFESTS: readonly AppManifest[] = [
  MOS_PORTAL_MANIFEST_1_0_0,
  MOS_PORTAL_MANIFEST_1_1_0,
];
