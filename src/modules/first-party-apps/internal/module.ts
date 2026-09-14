/**
 * The /first-party-apps module implementation (MKT-051): the four-pack
 * catalog, the surface composition (the App-model invoke/read over the
 * CURRENT install selection) and the bounded app-state engine.
 *
 * The composition ALWAYS resolves the workspace's CURRENT selection
 * through the /app-installs public contract first (fail-closed when the
 * app is not installed), pins the EXACT immutable registry row through
 * the /apps public contract, and only then dispatches to the family
 * composer — so future-selection semantics (upgrade changes the pinned
 * manifest for FUTURE compositions; rollback reselects) hold by
 * construction, and the SERVER-DERIVED granted scopes are the single
 * composition context. Historical identity is preserved by the ledger
 * rows the module never touches.
 */

import {
  ConflictError,
  ForbiddenError,
  InvalidRequestError,
  NotFoundError,
} from '../../../platform/errors/errors.ts';
import type { AppInstallRecord } from '../../app-installs/public.ts';
import type {
  AppUiSurfaceKind,
  AppVersionRecord,
} from '../../apps/public.ts';
import {
  FIRST_PARTY_APP_PACKS,
  PACK_SURFACE_REQUIRED_DATA_SCOPES,
  type FirstPartyAppsModuleApi,
  type FirstPartyAppsModuleDeps,
  type PackAppStateExport,
  type PackAppStateRecord,
  requiredDataScopesForSurface,
} from '../public.ts';
import {
  PackAppStateBag,
  packAppStateKey,
  packCatalogEntry,
  packStateMutationProblems,
} from './state.ts';
import { composeAnalyticsCommandCenterCard, composeAnalyticsReportPage } from './packs/mos-analytics/compose.ts';
import { composeCrmActionMenu, composeCrmClientRoomPanel } from './packs/mos-crm/compose.ts';
import { composeSheetsEditorPane, composeSheetsWorkspaceTab } from './packs/mos-sheets/compose.ts';
import { composePortalClientRoomPanel, composePortalReportPage } from './packs/mos-portal/compose.ts';

export function createFirstPartyAppsModule(
  deps: FirstPartyAppsModuleDeps,
): FirstPartyAppsModuleApi {
  const stateBag = new PackAppStateBag();

  /**
   * Resolves the workspace's CURRENT selection of one app key (the
   * single composition context) — null when the lineage has no ACTIVE
   * selection in the workspace (not installed, or every row superseded
   * without a successor, which the ledger's append discipline makes
   * impossible).
   */
  async function currentSelection(
    workspaceId: string,
    appKey: string,
  ): Promise<AppInstallRecord | null> {
    const installs = await deps.appInstalls.listWorkspaceAppInstalls(workspaceId);
    const active = installs.filter(
      (install) => install.appKey === appKey && install.status === 'ACTIVE',
    );
    // At most one ACTIVE selection per (workspace, app key) lineage —
    // the ledger's current-selection fence; a defensive ambiguity is a
    // fail-closed error, never a guess.
    if (active.length > 1) {
      throw new ConflictError(
        `multiple active selections of app '${appKey}' in workspace — the install ledger is inconsistent`,
      );
    }
    return active[0] ?? null;
  }

  /** Pins the EXACT immutable registry row of one selection. */
  async function pinnedVersion(
    install: AppInstallRecord,
  ): Promise<AppVersionRecord> {
    const record = await deps.apps.getAppVersion(install.appVersionId);
    if (record === null) {
      throw new NotFoundError('app version', install.appVersionId);
    }
    return record;
  }

  /**
   * The shared composition gate: current selection → pinned manifest →
   * surface DECLARATION check (422) → REQUIRED data-scope check against
   * the SERVER-DERIVED grants (403). Returns the envelope inputs.
   */
  async function resolveCompositionContext(
    workspaceId: string,
    appKey: string,
    surface: AppUiSurfaceKind,
  ): Promise<{
    readonly install: AppInstallRecord;
    readonly record: AppVersionRecord;
    readonly route: string;
  }> {
    const install = await currentSelection(workspaceId, appKey);
    if (install === null) {
      // Fail closed — the uniform 404 (no existence oracle): an app that
      // is not installed in the workspace composes nothing.
      throw new NotFoundError('app install', `${appKey} in workspace ${workspaceId}`);
    }
    const record = await pinnedVersion(install);
    const declaration = record.manifest.uiSurfaces.find(
      (entry) => entry.surface === surface,
    );
    if (declaration === undefined) {
      throw new InvalidRequestError(
        `app ${appKey}@${record.manifest.version} does not declare the '${surface}' UI surface (the pinned manifest's declared surfaces: ${record.manifest.uiSurfaces.map((entry) => entry.surface).join(', ')})`,
      );
    }
    const required = requiredDataScopesForSurface(appKey, surface);
    const missing = required.filter(
      (scope) => !install.grantedDataScopes.includes(scope),
    );
    if (missing.length > 0) {
      throw new ForbiddenError(
        `app ${appKey}@${record.manifest.version} surface '${surface}' requires data scopes not granted to this installation: ${missing.join(', ')} (the install-time policy intersection is the composition boundary)`,
      );
    }
    return { install, record, route: declaration.route };
  }

  return {
    async listFirstPartyPacks({ workspaceId }) {
      const out = [];
      for (const descriptor of FIRST_PARTY_APP_PACKS) {
        const published = await deps.apps.listAppVersions({
          appKey: descriptor.appKey,
        });
        const publishedVersions = published
          .map((record) => record.manifest.version)
          .sort();
        const install = await currentSelection(workspaceId, descriptor.appKey);
        out.push({
          ...descriptor,
          publishedVersions,
          currentSelection:
            install === null
              ? null
              : {
                  installId: install.installId,
                  version: install.version,
                  grantedDataScopes: [...install.grantedDataScopes],
                  grantedMutationScopes: [...install.grantedMutationScopes],
                },
        });
      }
      return out;
    },

    async composePackSurface({ workspaceId, appKey, surface, documentKey }) {
      const { install, record, route } = await resolveCompositionContext(
        workspaceId,
        appKey,
        surface,
      );
      const manifest = record.manifest;
      const scope = {
        agencyId: install.agencyId,
        clientId: install.clientId,
        workspaceId: install.workspaceId,
      };
      const generatedAt = deps.clock.nowIso();

      const envelope = {
        app: {
          appKey,
          family: packCatalogEntry(appKey)?.family ?? 'client-portal',
          version: manifest.version,
          appVersionId: record.appVersionId,
          publisher: record.publisher,
          capabilities: manifest.capabilities.map((capability) => capability.name),
        },
        install: {
          installId: install.installId,
          selectionSeq: install.selectionSeq,
          grantedDataScopes: [...install.grantedDataScopes],
          grantedMutationScopes: [...install.grantedMutationScopes],
        },
        surface: { kind: surface, route },
        generatedAt,
      };

      if (appKey === 'mos-analytics') {
        if (surface === 'command-center-card') {
          return {
            ...envelope,
            composedFrom: ['/reporting#getAgencyCommandCenter', '/profit-intelligence#getAgencyProfitIntelligence', '/integrations#listConnectionsForClient', '/clients#listClientsForAgency'],
            model: await composeAnalyticsCommandCenterCard(deps, scope, manifest),
          };
        }
        return {
          ...envelope,
          composedFrom: ['/profit-intelligence#getWorkspaceProfitIntelligence'],
          model: await composeAnalyticsReportPage(deps, scope, manifest),
        };
      }

      if (appKey === 'mos-crm') {
        if (surface === 'client-room-panel') {
          return {
            ...envelope,
            composedFrom: ['/clients#getClient', '/decisions#listDecisionsForClient'],
            model: await composeCrmClientRoomPanel(deps, scope, manifest),
          };
        }
        return {
          ...envelope,
          composedFrom: ['/decisions (declared command routes — read-only declarations)'],
          model: composeCrmActionMenu(deps, scope, manifest),
        };
      }

      if (appKey === 'mos-sheets') {
        if (surface === 'workspace-tab') {
          return {
            ...envelope,
            composedFrom: ['/evidence#listEvidenceForClient', '/metrics#listMetricObservationsForClient'],
            model: await composeSheetsWorkspaceTab(deps, scope, manifest),
          };
        }
        const state = stateBag.read(
          packAppStateKey(workspaceId, appKey, 'app:mos-sheets:documents'),
        );
        return {
          ...envelope,
          composedFrom: ['/evidence', '/metrics (the workbook rows)', '/app-installs (the granted mutation scopes)'],
          model: composeSheetsEditorPane(
            deps,
            scope,
            manifest,
            state,
            install.grantedMutationScopes,
            documentKey ?? null,
          ),
        };
      }

      // mos-portal
      if (surface === 'client-room-panel') {
        return {
          ...envelope,
          composedFrom: ['/clients#getClient', '/reporting#getClientDecisionRoom'],
          model: await composePortalClientRoomPanel(deps, scope, manifest),
        };
      }
      return {
        ...envelope,
        composedFrom: ['/clients#getClient', '/reporting#getClientDecisionRoom'],
        model: await composePortalReportPage(deps, scope, manifest),
      };
    },

    async readPackAppState({ workspaceId, appKey, namespace }) {
      const install = await currentSelection(workspaceId, appKey);
      if (install === null) {
        throw new NotFoundError('app install', `${appKey} in workspace ${workspaceId}`);
      }
      const record = await pinnedVersion(install);
      if (!record.manifest.stateNamespaces.includes(namespace)) {
        throw new InvalidRequestError(
          `namespace '${namespace}' is not declared by app ${appKey}@${record.manifest.version} (bounded app state cannot escape the pinned manifest's own namespaces)`,
        );
      }
      return stateBag.read(packAppStateKey(workspaceId, appKey, namespace));
    },

    async mutatePackAppState({ workspaceId, appKey, namespace, set, delete: del, lineage }) {
      const install = await currentSelection(workspaceId, appKey);
      if (install === null) {
        throw new NotFoundError('app install', `${appKey} in workspace ${workspaceId}`);
      }
      const record = await pinnedVersion(install);
      if (!record.manifest.stateNamespaces.includes(namespace)) {
        throw new InvalidRequestError(
          `namespace '${namespace}' is not declared by app ${appKey}@${record.manifest.version} (bounded app state cannot escape the pinned manifest's own namespaces)`,
        );
      }
      const key = packAppStateKey(workspaceId, appKey, namespace);
      const existing = stateBag.read(key);
      const nextEntries: Record<string, unknown> = {
        ...(existing?.entries ?? {}),
      };
      for (const entryKey of del) {
        delete nextEntries[entryKey];
      }
      Object.assign(nextEntries, set);

      const problems = packStateMutationProblems({
        appKey,
        namespace,
        nextEntries,
        lineage: [
          ...(existing?.lineage ?? []).map((ref) => ({ ...ref })),
          ...lineage.map((ref) => ({ ...ref })),
        ],
      });
      if (problems.length > 0) {
        throw new InvalidRequestError(
          'bounded app-state mutation failed the frozen guards',
          problems,
        );
      }

      // Deduplicate lineage refs (kind + id), bounded by the guard.
      const seen = new Set<string>();
      const mergedLineage: {
        readonly kind: 'metric-observation' | 'evidence-record' | 'decision-record' | 'client-record' | 'authority-view';
        readonly id: string;
      }[] = [];
      for (const ref of [...(existing?.lineage ?? []), ...lineage]) {
        const dedupeKey = `${ref.kind}:${ref.id}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        mergedLineage.push({ kind: ref.kind, id: ref.id });
      }

      const next: PackAppStateRecord = {
        workspaceId,
        appKey,
        namespace,
        entries: nextEntries,
        lineage: mergedLineage.slice(0, 64),
        updatedAt: deps.clock.nowIso(),
      };
      stateBag.write(key, next);
      return next;
    },

    async exportPackAppState({ workspaceId, appKey, namespace }) {
      const install = await currentSelection(workspaceId, appKey);
      if (install === null) {
        throw new NotFoundError('app install', `${appKey} in workspace ${workspaceId}`);
      }
      const record = await pinnedVersion(install);
      if (!record.manifest.stateNamespaces.includes(namespace)) {
        throw new InvalidRequestError(
          `namespace '${namespace}' is not declared by app ${appKey}@${record.manifest.version}`,
        );
      }
      const existing = stateBag.read(packAppStateKey(workspaceId, appKey, namespace));
      if (existing === null) {
        throw new NotFoundError('app state', `${appKey}:${namespace}`);
      }
      const exportRecord: PackAppStateExport = {
        semantics: 'mos-app-state-export',
        appKey,
        namespace,
        version: record.manifest.version,
        appVersionId: record.appVersionId,
        entries: existing.entries,
        lineage: existing.lineage,
        exportedAt: deps.clock.nowIso(),
      };
      return exportRecord;
    },

    async deletePackAppState({ workspaceId, appKey, namespace }) {
      const install = await currentSelection(workspaceId, appKey);
      if (install === null) {
        throw new NotFoundError('app install', `${appKey} in workspace ${workspaceId}`);
      }
      const record = await pinnedVersion(install);
      if (!record.manifest.stateNamespaces.includes(namespace)) {
        throw new InvalidRequestError(
          `namespace '${namespace}' is not declared by app ${appKey}@${record.manifest.version}`,
        );
      }
      return stateBag.delete(packAppStateKey(workspaceId, appKey, namespace));
    },
  };
}

void PACK_SURFACE_REQUIRED_DATA_SCOPES;
