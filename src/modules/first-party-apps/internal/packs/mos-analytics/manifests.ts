/**
 * The mos-analytics pack manifests — the reporting/analytics family
 * (MKT-051 AC-1a: "reporting/analytics (command-center cards + report
 * pages over the /reporting + /profit-intelligence public contracts)").
 *
 * The SINGLE PUBLISH SOURCE: these typed AppManifest definitions are what
 * the delivery publishes through the REAL /apps registry command (the
 * MKT-047 publish path) under the disclosed first-party service
 * principal. Each manifest is a FROZEN definition — version 1.0.0 is the
 * initial capability set, 1.1.0 adds the 'compose-margin-breakdown'
 * capability (the upgrade/rollback lifecycle proof of AC-2: published
 * versions are immutable, a new version is a new registry row).
 *
 * Incumbent-capability discipline (the Non-goals rule): every figure the
 * pack composes comes from the /reporting Agency Command Center and the
 * /profit-intelligence public contracts, cited as composedFrom — the
 * pack REPRODUCES the incumbent reporting surfaces over the SAME
 * authorities and never creates reporting truth of its own.
 *
 * Connector discipline (AC-4): the ONLY network destination is the
 * declared analytics API host with the ANALYTICS_API_KEY credential
 * LOGICAL NAME — both are consumed by the EXISTING /integrations
 * authority (a generic-analytics connection registered by the operator).
 * Pack code itself makes ZERO network calls; the declaration exists so
 * the manifest is honest about what the pack's connected data sources
 * need, and the connection, its credential reference and its policy
 * gates stay entirely inside /integrations (mos-app-ecosystem-v1.5.md:
 * "connectors to external SaaS/data sources" are App contributions that
 * ride the Integration contracts).
 */

import type { AppManifest } from '../../../../apps/public.ts';

/** The v1.0.0 manifest (the initial capability set). */
export const MOS_ANALYTICS_MANIFEST_1_0_0: AppManifest = {
  appKey: 'mos-analytics',
  version: '1.0.0',
  compatibility: { minPlatform: '1.0.0', maxPlatform: '2.0.0' },
  capabilities: [
    { name: 'compose-command-center-card', version: '1.0.0' },
    { name: 'compose-workspace-profit-report', version: '1.0.0' },
  ],
  inputSchema: { required: ['workspaceId'] },
  outputSchema: { required: ['app', 'model'] },
  dataScopes: ['client:read', 'workspace:read'],
  mutationScopes: [],
  networkDestinations: [
    {
      host: 'analytics.api.provider.example',
      protocol: 'https',
      port: 443,
      reason:
        'declared analytics data-source connector — reached ONLY through an /integrations generic-analytics connection (the credential ANALYTICS_API_KEY is a logical name bound by the credentials authority); pack code makes no direct network calls',
    },
  ],
  runtimeClass: 'pooled-worker',
  eventSubscriptions: [],
  uiSurfaces: [
    { surface: 'command-center-card', route: '/apps/mos-analytics/command-center-card' },
    { surface: 'report-page', route: '/apps/mos-analytics/report-page' },
  ],
  configSchema: {
    defaultCurrency: {
      type: 'string',
      required: false,
      description: 'The default currency label for report figures (e.g. USD).',
      pattern: '^[A-Z]{3}$',
    },
  },
  requiredCredentialNames: ['ANALYTICS_API_KEY'],
  stateNamespaces: ['app:mos-analytics:report-layouts'],
  migrationVersion: 0,
  dependencies: [],
  supportLevel: 'first-party',
  meteringDimensions: ['installations', 'invocations'],
};

/** The v1.1.0 manifest (adds the margin-breakdown capability). */
export const MOS_ANALYTICS_MANIFEST_1_1_0: AppManifest = {
  ...MOS_ANALYTICS_MANIFEST_1_0_0,
  version: '1.1.0',
  capabilities: [
    ...MOS_ANALYTICS_MANIFEST_1_0_0.capabilities,
    { name: 'compose-margin-breakdown', version: '1.0.0' },
  ],
};

/** All mos-analytics manifests, ascending (the publish source). */
export const MOS_ANALYTICS_MANIFESTS: readonly AppManifest[] = [
  MOS_ANALYTICS_MANIFEST_1_0_0,
  MOS_ANALYTICS_MANIFEST_1_1_0,
];
