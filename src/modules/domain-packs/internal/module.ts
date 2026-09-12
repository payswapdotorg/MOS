/**
 * /domain-packs module implementation (MKT-036, PACK-001).
 *
 * Composition over the three-table store with NO cross-module runtime
 * dependencies (the frozen matrix allows sixteen; the framework composes
 * none at module level — the /agents precedent of deliberately-unused
 * allowances):
 *
 *   - PUBLICATION is pure registry publication: the manifest guard runs
 *     first (§2 closed artifact-kind vocabulary, §5 closed scope
 *     vocabulary, unique (kind, name) identities, the §21 material-key
 *     backstop, the §4 WORKFLOW-TEMPLATE CONFORMANCE check through the
 *     /workflows authority's own validator imported by internal/store,
 *     and the self-dependency rejection), then the insert — the
 *     (publisher, pack_key, version) UNIQUE fence makes the version
 *     immutable (re-publication is a ConflictError, a new version is a
 *     new row);
 *   - INSTALLATION resolves the canonical Client/Workspace scope from
 *     the CALLER's durable ownership resolution (scope-as-data — the
 *     module has no /clients//workspaces dependency; the migration-030
 *     triggers re-fence the chain), runs the DEPENDENCY CHECKS (every
 *     manifest-declared required pack must be a PUBLISHED version —
 *     fail-closed InvalidRequestError otherwise), and records the
 *     installed version PLUS the materialized artifact scope records in
 *     ONE transaction (PACK-AC-01/03);
 *   - LIFECYCLE transitions are CAS-guarded on the frozen
 *     installed ⇄ disabled + terminal-uninstall table;
 *   - ARTIFACT READS serve the §5 explicit distinction: the workspace
 *     listing returns the workspace's OWN install artifacts; the agency
 *     listing returns ONLY scope='agency-reusable' records (pack-owned
 *     Client data never aggregates at agency scope).
 *
 * Fail-closed contract: every guard throws before any state is touched;
 * unknown ids surface NotFoundError (uniform — foreign and unknown are
 * indistinguishable); CAS races surface ConflictError.
 */

import { ConflictError, InvalidRequestError, NotFoundError } from '../../../platform/errors/errors.ts';
import { isLegalDomainPackInstallTransition } from '../public.ts';
import type {
  DomainPackInstallRecord,
  DomainPackRegistryRecord,
  DomainPacksModuleApi,
  DomainPacksModuleDeps,
} from '../public.ts';
import {
  assertValidDomainPackInstallInput,
  assertValidDomainPackManifest,
  classifyDomainPacksWriteConflict,
  domainPackCreateFingerprint,
  DomainPacksStore,
} from './store.ts';

export function createDomainPacksModule(deps: DomainPacksModuleDeps): DomainPacksModuleApi {
  const store = new DomainPacksStore(deps.db, deps.clock, deps.ids);

  /** Registry row or uniform 404 (foreign and unknown are indistinguishable). */
  async function packOr404(packId: string): Promise<DomainPackRegistryRecord> {
    const pack = await store.getDomainPackVersion(packId);
    if (pack === null) {
      throw new NotFoundError('domain pack', packId);
    }
    return pack;
  }

  /** Install row or uniform 404. */
  async function installOr404(installId: string): Promise<DomainPackInstallRecord> {
    const install = await store.getDomainPackInstall(installId);
    if (install === null) {
      throw new NotFoundError('domain pack install', installId);
    }
    return install;
  }

  return {
    async publishDomainPackVersion(input) {
      // PACK-001: the frozen manifest shape/artifact-declaration
      // contract (including §4 workflow-template conformance and the
      // self-dependency rejection) runs BEFORE any write.
      assertValidDomainPackManifest(input.manifest);
      const inserted = await store.insertDomainPackVersion({
        manifest: input.manifest,
        idempotencyKey: input.idempotencyKey,
        createFingerprint: domainPackCreateFingerprint(input.manifest),
        createdBy: input.actorId,
      });
      if (inserted === 'taken') {
        // The immutable-version fence fired: the (publisher, key,
        // version) triple already exists — deterministic 409, never a
        // silent rewrite (a new version is a new record —
        // domain-pack-v1.3.md §4).
        throw new ConflictError(
          `domain pack version ${input.manifest.publisher}/${input.manifest.packKey}@${input.manifest.version} is already published and immutable (publish a NEW version instead)`,
        );
      }
      return inserted;
    },

    async getDomainPackVersion(packId) {
      return store.getDomainPackVersion(packId);
    },

    async listDomainPackVersions(input) {
      return store.listDomainPackVersions(input.packKey);
    },

    async installDomainPack(input) {
      assertValidDomainPackInstallInput(input);
      const pack = await packOr404(input.packId);

      // DEPENDENCY CHECKS (work-item-v1.3-overrides.md MKT-036
      // "dependency/compatibility checks"): every declared required
      // pack must be a PUBLISHED version. The framework records the
      // declaration; pack execution resolves through the existing
      // authorities. A pack can never self-depend (publish-time guard);
      // cycles are impossible because dependencies must already be
      // published (DAG by construction).
      for (const required of pack.manifest.requiredPacks) {
        const resolved = await store.findDomainPackVersion(
          required.publisher,
          required.packKey,
          required.version,
        );
        if (resolved === null) {
          throw new InvalidRequestError(
            `domain pack ${pack.manifest.publisher}/${pack.manifest.packKey}@${pack.manifest.version} requires ${required.publisher}/${required.packKey}@${required.version}, which is not published (dependencies must be published versions)`,
          );
        }
      }

      try {
        const install = await store.insertDomainPackInstall({
          pack,
          agencyId: input.scope.agencyId,
          clientId: input.scope.clientId,
          workspaceId: input.scope.workspaceId,
          idempotencyKey: input.idempotencyKey,
          createdBy: input.actorId,
        });
        if (install === 'taken') {
          // The (workspace, pack version) fence fired: the version is
          // already installed here. A duplicate of the SAME logical
          // install command converges; a different command is a 409.
          const existing = await store.findDomainPackInstall(input.scope.workspaceId, input.packId);
          if (
            existing !== null &&
            existing.idempotencyKey === input.idempotencyKey
          ) {
            return { install: existing, replayed: true };
          }
          throw new ConflictError(
            `domain pack version ${pack.manifest.packKey}@${pack.manifest.version} is already installed in this workspace`,
          );
        }
        return { install, replayed: false };
      } catch (error) {
        if (classifyDomainPacksWriteConflict(error) === 'install-fence') {
          const existing = await store.findDomainPackInstall(input.scope.workspaceId, input.packId);
          if (
            existing !== null &&
            existing.idempotencyKey === input.idempotencyKey
          ) {
            return { install: existing, replayed: true };
          }
          throw new ConflictError(
            `domain pack version ${pack.manifest.packKey}@${pack.manifest.version} is already installed in this workspace`,
          );
        }
        throw error;
      }
    },

    async getDomainPackInstall(installId) {
      return store.getDomainPackInstall(installId);
    },

    async listDomainPackInstalls(workspaceId) {
      return store.listDomainPackInstalls(workspaceId);
    },

    async setDomainPackInstallStatus(input) {
      // The frozen transition table decides legality: 'disable' and
      // 'uninstall' leave 'installed'; 'enable' (installed as target)
      // is legal ONLY from 'disabled'; 'uninstalled' is terminal.
      const install = await installOr404(input.installId);
      if (!isLegalDomainPackInstallTransition(install.status, input.status)) {
        throw new ConflictError(
          `illegal domain pack install transition ${install.status} → ${input.status} (the frozen lifecycle)`,
        );
      }
      return deps.db.transaction(async (tx) => {
        const locked = await store.lockDomainPackInstall(tx, input.installId);
        if (locked === null) {
          throw new NotFoundError('domain pack install', input.installId);
        }
        if (!isLegalDomainPackInstallTransition(locked.status, input.status)) {
          throw new ConflictError(
            `illegal domain pack install transition ${locked.status} → ${input.status} (the frozen lifecycle)`,
          );
        }
        const outcome = await store.updateDomainPackInstall(tx, {
          installId: input.installId,
          status: input.status,
          expectedVersion: input.expectedVersion,
        });
        if (outcome === 'not-found') {
          throw new NotFoundError('domain pack install', input.installId);
        }
        if (outcome === 'version-conflict') {
          throw new ConflictError('domain pack install was modified concurrently (CAS mismatch)');
        }
        return outcome.updated;
      });
    },

    async getDomainPackArtifact(artifactId) {
      return store.getDomainPackArtifact(artifactId);
    },

    async listDomainPackArtifactsForWorkspace(workspaceId) {
      return store.listDomainPackArtifactsForWorkspace(workspaceId);
    },

    async listDomainPackArtifactsForAgency(agencyId) {
      return store.listDomainPackArtifactsForAgency(agencyId);
    },
  };
}
