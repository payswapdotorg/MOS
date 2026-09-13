/**
 * /apps module implementation (MKT-047, APP-001 — the App registry
 * authority for manifests).
 *
 * Composition over the two-table-plus-lineage store with ZERO
 * cross-module imports (the /deployments structural-port posture for
 * modules the frozen dependency matrix does not cover):
 *
 *   - PUBLICATION is pure registry publication: the manifest guard runs
 *     first (the frozen mos-app-ecosystem-v1.5.md §Manifest shape with
 *     the closed vocabularies, the namespaced app-owned state
 *     namespaces with the core-authority denylist, the §21 material-key
 *     backstop and the authority-shaped-key rejection contract —
 *     certification-shaped keys are 403 platform territory, every other
 *     authority-shaped key is 422), then DEPENDENCY VALIDATION resolves
 *     every declared dependency extension through the /extensions
 *     STRUCTURAL PORT (the read-only public-contract view wired at the
 *     composition root: a published version must exist inside the
 *     declared range under REAL semver comparison — a missing extension
 *     or an incompatible range fails closed 422) and every dependency
 *     app against this registry (published lineage + in-range version;
 *     self-dependencies are already rejected by the shape guard), and
 *     only then does the single transaction insert the ownership row,
 *     the immutable manifest row (born UNVERIFIED) and the dependency
 *     rows (the migration-037 trigger re-fences every target). The
 *     (app key, version) UNIQUE fence makes the version immutable
 *     (re-publishing is a ConflictError; a new version is a new row);
 *     the apps ownership row makes the key lineage owned by its first
 *     publisher (a second publisher is a ConflictError);
 *   - READS serve the registry: by id, by EXACT (app key, version),
 *     the version history by app key (newest first — immutable history
 *     is always readable);
 *   - the COMPATIBILITY QUERY is a pure read: given the runtime's
 *     platform version, an optional runtime class and the available
 *     extension versions, the report lists the eligible app versions
 *     (compatibility range, runtime class and dependency satisfaction
 *     — extension dependencies against the query's environment inputs,
 *     app dependencies against the published registry) with honest
 *     per-version ineligibility reasons.
 *
 * Fail-closed contract: every guard throws before any state is touched;
 * registry fences surface ConflictError (immutable version / key
 * lineage); dependency validation failures surface InvalidRequestError
 * (422); certification territory violations surface ForbiddenError
 * (403 — thrown by the shape guard).
 */

import { ConflictError, InvalidRequestError } from '../../../platform/errors/errors.ts';
import { appPublisherIdentityString } from '../public.ts';
import { appDependenciesValid, appVersionInRange } from './store.ts';
import type {
  AppCompatibilityQuery,
  AppCompatibilityReport,
  AppIneligibleVersion,
  AppVersionRecord,
  AppsModuleApi,
  AppsModuleDeps,
} from '../public.ts';
import {
  appCreateFingerprint,
  AppsStore,
  assertValidAppManifest,
  assertValidCompatibilityQuery,
  classifyAppsWriteConflict,
} from './store.ts';

export function createAppsModule(deps: AppsModuleDeps): AppsModuleApi {
  const store = new AppsStore(deps.db, deps.clock, deps.ids);
  const { extensions } = deps;

  return {
    async publishAppVersion(input) {
      // The frozen manifest shape guard runs BEFORE any write —
      // certification-shaped keys are 403 platform territory; every
      // other authority-shaped key and material-shaped key is 422.
      assertValidAppManifest(input.manifest);

      const publisher = appPublisherIdentityString(input.identity);
      const manifest = input.manifest;

      // DEPENDENCY VALIDATION (MKT-047 AC-6) — fail-closed, BEFORE any
      // write, resolved through the /extensions STRUCTURAL PORT (the
      // read-only public-contract view — composition over the
      // /extensions authority, never a mutation of it) and this
      // registry's own durable state:
      //   - every dependency EXTENSION must EXIST in the /extensions
      //     registry with a published version INSIDE the declared
      //     range (REAL semver comparison — a missing extension or an
      //     incompatible range is rejected 422);
      //   - every dependency APP must be a published lineage with a
      //     version in range;
      //   - self-dependencies are already rejected by the shape guard.
      for (const dependency of manifest.dependencies) {
        if (dependency.kind === 'extension') {
          const published = await extensions.listExtensionVersions({
            extensionKey: dependency.key,
          });
          const candidates = published.filter(
            (candidate) =>
              candidate.manifest.publisher === dependency.publisher &&
              appVersionInRange(
                candidate.manifest.version,
                dependency.minVersion,
                dependency.maxVersion,
              ),
          );
          if (candidates.length === 0) {
            throw new InvalidRequestError(
              `app ${manifest.appKey}@${manifest.version} declares a dependency on extension ${dependency.publisher}/${dependency.key} inside [${dependency.minVersion} .. ${dependency.maxVersion}], which has no published compatible version (dependency extensions must exist and be compatible)`,
            );
          }
        } else {
          const published = await store.listAppVersionKeys(dependency.key);
          const candidates = published.filter((candidate) =>
            appVersionInRange(candidate.version, dependency.minVersion, dependency.maxVersion),
          );
          if (candidates.length === 0) {
            throw new InvalidRequestError(
              `app ${manifest.appKey}@${manifest.version} declares a dependency on app '${dependency.key}' inside [${dependency.minVersion} .. ${dependency.maxVersion}], which has no published compatible version (dependency apps must exist and be compatible)`,
            );
          }
        }
      }

      try {
        const inserted = await store.insertAppVersion({
          manifest,
          publisher,
          idempotencyKey: input.idempotencyKey,
          createFingerprint: appCreateFingerprint(manifest),
          createdBy: input.identity.kind === 'platform_developer' ? input.identity.userId : null,
        });
        if (inserted === 'taken') {
          // The immutable-version fence fired: the (app key, semantic
          // version) pair already exists — deterministic 409, never a
          // silent rewrite (a new version is a new row — AC-4).
          throw new ConflictError(
            `app version ${manifest.appKey}@${manifest.version} is already published and immutable (publish a NEW version instead)`,
          );
        }
        if (inserted === 'foreign-key') {
          // The key-lineage fence fired: another publisher owns this
          // app key — the first publisher owns the lineage (AC-2: app
          // key + publisher identity, server-derived).
          throw new ConflictError(
            `app key '${manifest.appKey}' is owned by another publisher (the first publisher of an app key owns its lineage)`,
          );
        }
        return inserted;
      } catch (error) {
        // The migration-037 backstops re-fence every write: classify the
        // database's own rejection of an illegal insert (dependency
        // validation trigger / unique fences) into the typed errors.
        const conflict = classifyAppsWriteConflict(error);
        if (conflict === 'version-fence') {
          throw new ConflictError(
            `app version ${manifest.appKey}@${manifest.version} is already published and immutable (publish a NEW version instead)`,
          );
        }
        if (conflict === 'dependency-fence') {
          throw new InvalidRequestError(
            `app ${manifest.appKey}@${manifest.version} declares a duplicate dependency declaration (dependencies are unique per version)`,
          );
        }
        if (conflict === 'validation-backstop') {
          // A CHECK/trigger fence rejected the write (the dependency
          // validation trigger is the material case — the shape and
          // namespace CHECKs are pre-fenced by the guard). Surface the
          // database's own reason.
          throw new InvalidRequestError(
            `app ${manifest.appKey}@${manifest.version} was rejected by the registry validation backstop: ${(error as { message?: string }).message ?? 'constraint violation'}`,
          );
        }
        throw error;
      }
    },

    async getAppVersion(appVersionId) {
      return store.getAppVersion(appVersionId);
    },

    async findAppVersion(appKey, version) {
      return store.findAppVersion(appKey, version);
    },

    async listAppVersions(input) {
      return store.listAppVersions(input.appKey);
    },

    async queryCompatibleAppVersions(query: AppCompatibilityQuery): Promise<AppCompatibilityReport> {
      assertValidCompatibilityQuery(query);
      const versions = await store.listAppVersions(null);
      const registryAppVersions = versions.map((record) => ({
        appKey: record.manifest.appKey,
        version: record.manifest.version,
      }));

      const eligible: AppVersionRecord[] = [];
      const ineligible: AppIneligibleVersion[] = [];

      for (const record of versions) {
        const reasons: string[] = [];
        const manifest = record.manifest;

        // 1. The platform compatibility range must contain the query's
        //    platform version (REAL semver comparison).
        if (
          !appVersionInRange(
            query.platformVersion,
            manifest.compatibility.minPlatform,
            manifest.compatibility.maxPlatform,
          )
        ) {
          reasons.push(
            `platform version ${query.platformVersion} is outside the compatibility range [${manifest.compatibility.minPlatform} .. ${manifest.compatibility.maxPlatform}]`,
          );
        }

        // 2. The runtime class must match when the query narrows it.
        if (
          query.runtimeClass !== null &&
          query.runtimeClass !== undefined &&
          manifest.runtimeClass !== query.runtimeClass
        ) {
          reasons.push(
            `runtime class ${manifest.runtimeClass} does not match the requested ${query.runtimeClass}`,
          );
        }

        // 3. Every declared dependency must be satisfied: extension
        //    dependencies against the query's environment inputs; app
        //    dependencies against the published registry (the shared
        //    pure predicate of the publish-time validation).
        reasons.push(
          ...appDependenciesValid(manifest, {
            extensionVersions: query.extensionVersions,
            appVersions: registryAppVersions,
          }),
        );

        if (reasons.length === 0) {
          eligible.push(record);
        } else {
          ineligible.push({ record, reasons });
        }
      }

      return { eligible, ineligible };
    },
  };
}
