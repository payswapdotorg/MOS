/**
 * /app-installs module implementation (MKT-048 — the workspace-scoped App
 * installation lifecycle: install, upgrade and rollback over the /apps
 * registry).
 *
 * Composition over the append-oriented ledger store with the
 * disclosed frozen-matrix dependencies (/app-installs ──→ /apps,
 * /extensions, /policies, /workspaces — the registration row added by this
 * Work Item):
 *
 *   - INSTALL resolves the canonical Workspace ownership through the
 *     /workspaces STRUCTURAL PORT first (unknown/tombstoned → uniform 404;
 *     a disabled Workspace/Client/Agency boundary → 409 — disabled
 *     boundaries block new use without rewriting history), resolves the
 *     EXACT (app key, version) through the /apps public contract (uniform
 *     404), validates the MKT-047 compatibility contract against the
 *     SERVER-DECLARED platform version + the workspace's AUTHORIZED
 *     extension versions (the /extensions read-only structural port — the
 *     /deployments capability-check posture), then runs the FAIL-CLOSED
 *     policy gate and derives the granted scopes SERVER-SIDE (the
 *     manifest's requested scopes ∩ per-scope policy evaluations ∩ the
 *     frozen vocabularies). Only then does the single transaction append
 *     the ledger row + the 'installed' event;
 *   - UPGRADE appends the NEW exact version for future invocations: the
 *     prior row is superseded (the SINGLE sanctioned UPDATE) and the
 *     successor row + 'upgraded' event appended in one transaction — the
 *     prior row's historical identity is preserved exactly;
 *   - ROLLBACK reselects a PREVIOUSLY INSTALLED approved version the same
 *     way (a prior — SUPERSEDED — selection row of the SAME lineage, a
 *     foreign/unknown target is a uniform 404), re-running the
 *     compatibility contract and the policy gate at rollback time (the
 *     strictest posture);
 *   - READS serve the ledger (current selections + full append-oriented
 *     history), the event tail and the agency rollup.
 *
 * Fail-closed contract: every guard throws before any state is touched;
 * policy denials throw PolicyDeniedError (403, zero rows); compatibility
 * failures throw InvalidRequestError (422, zero rows, honest reasons);
 * unknown/foreign identifiers surface NotFoundError (uniform); selection
 * races and fence hits surface ConflictError; §8 divergent key reuse
 * surfaces IdempotencyConflictError.
 */

import {
  ConflictError,
  IdempotencyConflictError,
  InvalidRequestError,
  NotFoundError,
  PolicyDeniedError,
} from '../../../platform/errors/errors.ts';
import { enforcementOutcome } from '../../policies/public.ts';
import type { AppDataScope, AppMutationScope, AppVersionRecord } from '../../apps/public.ts';
import {
  APP_INSTALLS_PLATFORM_VERSION,
  evaluateSelectionRequest,
  intersectGrantedScopes,
  resolveTargetCompatibility,
} from '../public.ts';
import type {
  AppInstallOperationOutcome,
  AppInstallProvenance,
  AppInstallsModuleApi,
  AppInstallsModuleDeps,
  AppInstallsWorkspaceOwnershipSnapshot,
} from '../public.ts';
import {
  appInstallCreateFingerprint,
  AppInstallsStore,
  assertValidAppInstallProvenance,
  assertValidSelectionInput,
  buildInstallGateAction,
  buildScopeGrantAction,
} from './store.ts';

export function createAppInstallsModule(deps: AppInstallsModuleDeps): AppInstallsModuleApi {
  const store = new AppInstallsStore(deps.db, deps.clock, deps.ids);
  const { apps, policies, workspaceOwnership, extensions, trustState } = deps;

  /**
   * Canonical Workspace ownership for a SELECTION WRITE: resolved through
   * the /workspaces structural port BEFORE anything else (unknown or
   * tombstoned Workspace/Client → uniform NotFoundError — a foreign
   * Workspace is indistinguishable from an unknown one); a disabled
   * Workspace/Client/Agency boundary → ConflictError (disabled boundaries
   * block new selections without rewriting history — the /deployments
   * posture).
   */
  async function requireWorkspaceForWrite(
    workspaceId: string,
  ): Promise<AppInstallsWorkspaceOwnershipSnapshot> {
    const ownership = await workspaceOwnership.resolveWorkspaceOwnership(workspaceId);
    if (ownership === null) {
      throw new NotFoundError('workspace', workspaceId);
    }
    if (ownership.workspace.status !== 'active') {
      throw new ConflictError(
        `workspace ${workspaceId} is ${ownership.workspace.status}; new app install selections are blocked`,
      );
    }
    if (ownership.client.status !== 'active') {
      throw new ConflictError(
        `client ${ownership.client.clientId} is ${ownership.client.status}; new app install selections are blocked`,
      );
    }
    if (ownership.clientOwnership.agency.status !== 'active') {
      throw new ConflictError(
        `agency ${ownership.clientOwnership.agency.agencyId} is ${ownership.clientOwnership.agency.status}; new app install selections are blocked`,
      );
    }
    return ownership;
  }

  /** The EXACT registry row for (app key, version) — uniform 404 otherwise. */
  async function targetVersionOr404(appKey: string, version: string): Promise<AppVersionRecord> {
    const record = await apps.findAppVersion(appKey, version);
    if (record === null) {
      throw new NotFoundError('app version', `${appKey}@${version}`);
    }
    return record;
  }

  /**
   * The compatibility environment of one Workspace: the extension versions
   * AUTHORIZED in the workspace (the /deployments capability-check posture
   * — an extension version is available to an app install when its install
   * is authorized), deduplicated by registry id. READ-ONLY through the
   * /extensions structural port.
   */
  async function workspaceExtensionVersions(workspaceId: string): Promise<
    readonly { readonly publisher: string; readonly extensionKey: string; readonly version: string }[]
  > {
    const installs = await extensions.listExtensionInstalls(workspaceId);
    const byExtensionId = new Map<string, { publisher: string; extensionKey: string; version: string }>();
    for (const install of installs) {
      if (install.status !== 'authorized') continue;
      if (byExtensionId.has(install.extensionId)) continue;
      const version = await extensions.getExtensionVersion(install.extensionId);
      if (version !== null) {
        byExtensionId.set(install.extensionId, {
          publisher: version.publisher,
          extensionKey: version.extensionKey,
          version: version.version,
        });
      }
    }
    return [...byExtensionId.values()];
  }

  /**
   * The MKT-047 compatibility validation (AC-5): the target EXACT (app
   * key, version) must be ELIGIBLE under the /apps public compatibility
   * query evaluated against the server-declared platform version + the
   * workspace's authorized extension versions. Ineligible → 422 with the
   * report's honest reasons (zero rows).
   */
  async function assertTargetCompatible(record: AppVersionRecord, workspaceId: string): Promise<void> {
    const extensionVersions = await workspaceExtensionVersions(workspaceId);
    const report = await apps.queryCompatibleAppVersions({
      platformVersion: APP_INSTALLS_PLATFORM_VERSION,
      runtimeClass: null,
      extensionVersions,
    });
    const verdict = resolveTargetCompatibility(
      { appKey: record.manifest.appKey, version: record.manifest.version },
      {
        eligible: report.eligible.map((entry) => ({
          appKey: entry.appKey,
          version: entry.manifest.version,
        })),
        ineligible: report.ineligible.map((entry) => ({
          appKey: entry.record.appKey,
          version: entry.record.manifest.version,
          reasons: entry.reasons,
        })),
      },
    );
    if (!verdict.eligible) {
      throw new InvalidRequestError(
        `app version ${record.manifest.appKey}@${record.manifest.version} is not compatible with the target environment: ${verdict.reasons.join('; ')}`,
      );
    }
  }

  /**
   * The MKT-050 DISCLOSED ADDITIVE trust-state enrichment: when the
   * OPTIONAL marketplace trustState port is wired, the gate action's
   * certificationState attribute carries the marketplace-DERIVED
   * current state (the trust_events tail) instead of the registry
   * record's frozen BIRTH state. TRUST IS METADATA AND A POLICY INPUT —
   * this enrichment changes NOTHING about the gate's authority: the
   * fail-closed /policies evaluation (explicit allow required,
   * deny-overrides) stays the sole install authority. UNWIRED: the
   * action is byte-identical to the MKT-048 delivery. A port error
   * PROPAGATES (fail-closed: an unresolvable policy input never
   * silently degrades to a stale value).
   */
  async function gateActionWithDerivedTrust(
    record: AppVersionRecord,
    operation: 'install' | 'upgrade' | 'rollback',
  ): Promise<ReturnType<typeof buildInstallGateAction>> {
    const action = buildInstallGateAction(record, operation);
    if (trustState === undefined) {
      return action;
    }
    const derived = await trustState.resolveAppTrustState(record.manifest.appKey);
    if (derived === null) {
      return action;
    }
    return {
      ...action,
      attributes: {
        ...action.attributes,
        certificationState: derived.trustLevel,
      },
    };
  }

  /**
   * The FAIL-CLOSED selection gate + the SERVER-DERIVED grant derivation:
   * the extension-dimension operation gate must be an EXPLICIT recorded
   * allow (deny/unknown → PolicyDeniedError, zero rows — the /deployments
   * policy-gate precedent), then every REQUESTED scope is evaluated
   * per-scope and the granted scopes are the honest intersection (the
   * manifest's request ∩ policy-allowed ∩ the frozen vocabularies). Every
   * evaluation is recorded append-only by the /policies engine.
   */
  async function gateAndDeriveGrants(
    record: AppVersionRecord,
    scope: { readonly agencyId: string; readonly clientId: string },
    operation: 'install' | 'upgrade' | 'rollback',
    provenance: AppInstallProvenance,
  ): Promise<{
    readonly grantedDataScopes: readonly AppDataScope[];
    readonly grantedMutationScopes: readonly AppMutationScope[];
    readonly policyDecisionId: string;
  }> {
    const policyProvenance = {
      actor: provenance.actor,
      recordedVia: provenance.recordedVia,
      correlationId: provenance.correlationId,
      causationId: provenance.causationId,
    };

    // 1. THE OPERATION GATE — only an explicit recorded allow proceeds.
    //    (MKT-050: the action's certificationState attribute carries the
    //    marketplace-DERIVED current trust state when the optional port
    //    is wired — the disclosed additive enrichment above; the gate's
    //    fail-closed authority is UNCHANGED.)
    const gate = await policies.evaluateAction(
      {
        action: await gateActionWithDerivedTrust(record, operation),
        scope: { agencyId: scope.agencyId, clientId: scope.clientId },
      },
      policyProvenance,
    );
    if (enforcementOutcome(gate) !== 'allow') {
      throw new PolicyDeniedError(
        `app ${operation} of ${record.manifest.appKey}@${record.manifest.version} was denied by the extension policy boundary (${gate.reasonCode}: ${gate.reasons.join('; ')})`,
      );
    }

    // 2. PER-SCOPE evaluations — the server-derived intersection.
    const allowedScopes = new Set<string>();
    for (const dataScope of record.manifest.dataScopes) {
      const decision = await policies.evaluateAction(
        {
          action: buildScopeGrantAction(record.manifest.appKey, operation, 'data', dataScope),
          scope: { agencyId: scope.agencyId, clientId: scope.clientId },
        },
        policyProvenance,
      );
      if (enforcementOutcome(decision) === 'allow') {
        allowedScopes.add(dataScope);
      }
    }
    for (const mutationScope of record.manifest.mutationScopes) {
      const decision = await policies.evaluateAction(
        {
          action: buildScopeGrantAction(record.manifest.appKey, operation, 'mutation', mutationScope),
          scope: { agencyId: scope.agencyId, clientId: scope.clientId },
        },
        policyProvenance,
      );
      if (enforcementOutcome(decision) === 'allow') {
        allowedScopes.add(mutationScope);
      }
    }

    // 3. The pure triple intersection (request ∩ policy ∩ frozen vocab).
    const grants = intersectGrantedScopes(
      record.manifest.dataScopes,
      record.manifest.mutationScopes,
      allowedScopes,
    );
    return {
      grantedDataScopes: grants.grantedDataScopes,
      grantedMutationScopes: grants.grantedMutationScopes,
      policyDecisionId: gate.decisionId,
    };
  }

  /**
   * The §8 replay convergence: an idempotency key already recorded for the
   * workspace converges (identical fingerprint → the recorded row with
   * replayed: true and ZERO state change) or conflicts (divergent
   * fingerprint → IdempotencyConflictError).
   */
  async function replayOrConflict(
    workspaceId: string,
    idempotencyKey: string,
    fingerprint: string,
  ): Promise<AppInstallOperationOutcome | null> {
    const existing = await store.findInstallByIdempotencyKey(workspaceId, idempotencyKey);
    if (existing === null) return null;
    if (existing.createFingerprint !== fingerprint) {
      throw new IdempotencyConflictError(idempotencyKey);
    }
    return { install: existing, prior: null, replayed: true };
  }

  /**
   * The fence-hit convergence for the CURRENT-SELECTION fence (the race
   * backstop behind the module's read-then-write): a concurrent duplicate
   * install either replays (identical logical command) or conflicts.
   */
  async function currentFenceOutcome(
    workspaceId: string,
    appKey: string,
    fingerprint: string,
  ): Promise<AppInstallOperationOutcome> {
    const replay = await replayOrConflictByCurrent(workspaceId, appKey, fingerprint);
    if (replay !== null) return replay;
    throw new ConflictError(
      `app ${appKey} is already installed in this workspace (the current-selection fence fired — exactly one install wins)`,
    );
  }

  /** Replay-or-conflict resolved through the lineage's CURRENT selection. */
  async function replayOrConflictByCurrent(
    workspaceId: string,
    appKey: string,
    fingerprint: string,
  ): Promise<AppInstallOperationOutcome | null> {
    const current = await store.findCurrentSelection(workspaceId, appKey);
    if (current === null) return null;
    if (current.createFingerprint === fingerprint) {
      return { install: current, prior: null, replayed: true };
    }
    return null;
  }

  return {
    async installApp(input, provenance) {
      assertValidSelectionInput(input);
      assertValidAppInstallProvenance(provenance);

      // 1. Canonical ownership (uniform 404 for foreign/unknown; disabled
      //    boundaries block new selections).
      const ownership = await requireWorkspaceForWrite(input.workspaceId);
      const scope = {
        agencyId: ownership.scope.agencyId,
        clientId: ownership.scope.clientId,
        workspaceId: ownership.scope.workspaceId,
      };

      // 2. The EXACT target version (uniform 404).
      const record = await targetVersionOr404(input.appKey, input.version);

      // 3. §8 convergence BEFORE any gate/evaluation (a replay never
      //    re-evaluates policy — it converges to the recorded row).
      const fingerprint = appInstallCreateFingerprint({
        appKey: input.appKey,
        version: input.version,
        operation: 'install',
      });
      const replay = await replayOrConflict(input.workspaceId, input.idempotencyKey, fingerprint);
      if (replay !== null) return replay;

      // 4. The lineage's first selection: an existing current selection is
      //    a replay (identical command) or a conflict.
      const current = await store.findCurrentSelection(input.workspaceId, input.appKey);
      if (current !== null) {
        if (current.createFingerprint === fingerprint) {
          return { install: current, prior: null, replayed: true };
        }
        throw new ConflictError(
          `app ${input.appKey} is already installed in this workspace (current selection ${current.version}; new versions arrive by upgrade, prior versions by rollback)`,
        );
      }

      // 5. The MKT-047 compatibility contract (422, zero rows).
      await assertTargetCompatible(record, input.workspaceId);

      // 6. The fail-closed policy gate + the server-derived grants.
      const grants = await gateAndDeriveGrants(
        record,
        { agencyId: scope.agencyId, clientId: scope.clientId },
        'install',
        provenance,
      );

      // 7. The single transactional append (races converge by fence).
      const outcome = await store.applySelection({
        scope,
        appKey: input.appKey,
        appVersionId: record.appVersionId,
        version: record.manifest.version,
        operation: 'install',
        grantedDataScopes: grants.grantedDataScopes,
        grantedMutationScopes: grants.grantedMutationScopes,
        policyDecisionId: grants.policyDecisionId,
        installedBy: input.actorId,
        idempotencyKey: input.idempotencyKey,
        createFingerprint: fingerprint,
        prior: null,
        provenance,
      });
      if (outcome.kind === 'appended') {
        return { install: outcome.install, prior: null, replayed: false };
      }
      if (outcome.kind === 'idempotency-taken') {
        const converged = await replayOrConflict(input.workspaceId, input.idempotencyKey, fingerprint);
        if (converged !== null) return converged;
        throw new IdempotencyConflictError(input.idempotencyKey);
      }
      if (outcome.kind === 'current-fence') {
        return currentFenceOutcome(input.workspaceId, input.appKey, fingerprint);
      }
      // 'stale' is unreachable on install (there is no prior to supersede).
      throw new ConflictError(
        `app ${input.appKey} install raced with a concurrent selection change — retry against the current selection`,
      );
    },

    async upgradeAppInstall(input, provenance) {
      assertValidSelectionInput(input);
      assertValidAppInstallProvenance(provenance);

      // 1. The current selection row (uniform 404 for unknown/foreign).
      const install = await store.getAppInstall(input.installId);
      if (install === null) {
        throw new NotFoundError('app install', input.installId);
      }
      // 2. Canonical ownership of the install's workspace.
      const ownership = await requireWorkspaceForWrite(install.workspaceId);
      const scope = {
        agencyId: ownership.scope.agencyId,
        clientId: ownership.scope.clientId,
        workspaceId: ownership.scope.workspaceId,
      };

      // 3. §8 convergence before any gate/evaluation.
      const fingerprint = appInstallCreateFingerprint({
        appKey: install.appKey,
        version: input.version,
        operation: 'upgrade',
      });
      const replay = await replayOrConflict(install.workspaceId, input.idempotencyKey, fingerprint);
      if (replay !== null) return replay;

      // 4. The row must be the lineage's CURRENT selection.
      if (install.status !== 'ACTIVE') {
        throw new ConflictError(
          `app install ${input.installId} is ${install.status} (the selection moved — superseded rows are history; target the lineage's current selection)`,
        );
      }

      // 5. The pure selection/upgrade state machine (upgrade selects a NEW
      //    version; previously installed versions are reselected by
      //    rollback).
      const lineage = await store.listLineageSelections(install.workspaceId, install.appKey);
      const verdict = evaluateSelectionRequest(
        {
          current: {
            installId: install.installId,
            version: install.version,
            selectionSeq: install.selectionSeq,
          },
          selectedVersions: lineage.map((row) => row.version),
        },
        { operation: 'upgrade', targetVersion: input.version },
      );
      if (!verdict.ok) {
        throw new InvalidRequestError(
          `app upgrade of ${install.appKey} to ${input.version} is rejected: ${verdict.reason}`,
        );
      }

      // 6. The EXACT target version (uniform 404).
      const record = await targetVersionOr404(install.appKey, input.version);

      // 7. The MKT-047 compatibility contract (422, zero rows).
      await assertTargetCompatible(record, install.workspaceId);

      // 8. The fail-closed 'upgrade' policy gate + fresh server-derived
      //    grants for the new version.
      const grants = await gateAndDeriveGrants(
        record,
        { agencyId: scope.agencyId, clientId: scope.clientId },
        'upgrade',
        provenance,
      );

      // 9. The single transactional append: supersede the prior, append the
      //    successor + the 'upgraded' event — the prior row's historical
      //    identity is preserved exactly.
      const outcome = await store.applySelection({
        scope,
        appKey: install.appKey,
        appVersionId: record.appVersionId,
        version: record.manifest.version,
        operation: 'upgrade',
        grantedDataScopes: grants.grantedDataScopes,
        grantedMutationScopes: grants.grantedMutationScopes,
        policyDecisionId: grants.policyDecisionId,
        installedBy: input.actorId,
        idempotencyKey: input.idempotencyKey,
        createFingerprint: fingerprint,
        prior: install,
        provenance,
      });
      if (outcome.kind === 'appended') {
        return { install: outcome.install, prior: outcome.prior, replayed: false };
      }
      if (outcome.kind === 'idempotency-taken') {
        const converged = await replayOrConflict(install.workspaceId, input.idempotencyKey, fingerprint);
        if (converged !== null) return converged;
        throw new IdempotencyConflictError(input.idempotencyKey);
      }
      // 'stale'/'current-fence': the current selection moved mid-flight.
      throw new ConflictError(
        `app upgrade of ${install.appKey} raced with a concurrent selection change — retry against the current selection`,
      );
    },

    async rollbackAppInstall(input, provenance) {
      assertValidSelectionInput(input);
      assertValidAppInstallProvenance(provenance);

      // 1. The current selection row (uniform 404 for unknown/foreign).
      const install = await store.getAppInstall(input.installId);
      if (install === null) {
        throw new NotFoundError('app install', input.installId);
      }
      // 2. Canonical ownership of the install's workspace.
      const ownership = await requireWorkspaceForWrite(install.workspaceId);
      const scope = {
        agencyId: ownership.scope.agencyId,
        clientId: ownership.scope.clientId,
        workspaceId: ownership.scope.workspaceId,
      };

      // 3. The rollback target: a PRIOR selection row of the SAME lineage —
      //    a foreign/unknown target is a uniform 404 (no existence oracle).
      const target = await store.getAppInstall(input.targetInstallId);
      if (
        target === null ||
        target.workspaceId !== install.workspaceId ||
        target.appKey !== install.appKey
      ) {
        throw new NotFoundError('app install', input.targetInstallId);
      }

      // 4. §8 convergence before any gate/evaluation.
      const fingerprint = appInstallCreateFingerprint({
        appKey: install.appKey,
        version: target.version,
        operation: 'rollback',
      });
      const replay = await replayOrConflict(install.workspaceId, input.idempotencyKey, fingerprint);
      if (replay !== null) return replay;

      // 5. The row must be the lineage's CURRENT selection; the target must
      //    be a PRIOR selection (the current row cannot roll back to
      //    itself).
      if (install.status !== 'ACTIVE') {
        throw new ConflictError(
          `app install ${input.installId} is ${install.status} (the selection moved — superseded rows are history; target the lineage's current selection)`,
        );
      }
      if (target.installId === install.installId) {
        throw new ConflictError(
          `app install ${input.targetInstallId} is the CURRENT selection — rollback reselects a PREVIOUSLY INSTALLED version`,
        );
      }

      // 6. The pure selection state machine (rollback reselects a
      //    previously installed approved version).
      const lineage = await store.listLineageSelections(install.workspaceId, install.appKey);
      const verdict = evaluateSelectionRequest(
        {
          current: {
            installId: install.installId,
            version: install.version,
            selectionSeq: install.selectionSeq,
          },
          selectedVersions: lineage.map((row) => row.version),
        },
        { operation: 'rollback', targetVersion: target.version },
      );
      if (!verdict.ok) {
        throw new InvalidRequestError(
          `app rollback of ${install.appKey} to ${target.version} is rejected: ${verdict.reason}`,
        );
      }

      // 7. The EXACT reselected version (uniform 404 — the immutable
      //    registry keeps every published version readable forever).
      const record = await targetVersionOr404(install.appKey, target.version);

      // 8. The compatibility contract RE-RUN at rollback time (the
      //    strictest posture — an incompatible prior version is rejected
      //    with the honest reason, zero rows).
      await assertTargetCompatible(record, install.workspaceId);

      // 9. The fail-closed 'rollback' policy gate + fresh server-derived
      //    grants for the reselected version.
      const grants = await gateAndDeriveGrants(
        record,
        { agencyId: scope.agencyId, clientId: scope.clientId },
        'rollback',
        provenance,
      );

      // 10. The single transactional append: supersede the current, append
      //     the reselection row + the 'rolled_back' event — no history
      //     rewrite anywhere.
      const outcome = await store.applySelection({
        scope,
        appKey: install.appKey,
        appVersionId: record.appVersionId,
        version: record.manifest.version,
        operation: 'rollback',
        grantedDataScopes: grants.grantedDataScopes,
        grantedMutationScopes: grants.grantedMutationScopes,
        policyDecisionId: grants.policyDecisionId,
        installedBy: input.actorId,
        idempotencyKey: input.idempotencyKey,
        createFingerprint: fingerprint,
        prior: install,
        provenance,
      });
      if (outcome.kind === 'appended') {
        return { install: outcome.install, prior: outcome.prior, replayed: false };
      }
      if (outcome.kind === 'idempotency-taken') {
        const converged = await replayOrConflict(install.workspaceId, input.idempotencyKey, fingerprint);
        if (converged !== null) return converged;
        throw new IdempotencyConflictError(input.idempotencyKey);
      }
      throw new ConflictError(
        `app rollback of ${install.appKey} raced with a concurrent selection change — retry against the current selection`,
      );
    },

    async getAppInstall(installId) {
      return store.getAppInstall(installId);
    },

    async listWorkspaceAppInstalls(workspaceId) {
      return store.listWorkspaceAppInstalls(workspaceId);
    },

    async listAgencyAppInstalls(agencyId) {
      return store.listAgencyAppInstalls(agencyId);
    },

    async listWorkspaceAppInstallEvents(workspaceId) {
      return store.listWorkspaceAppInstallEvents(workspaceId);
    },
  };
}
