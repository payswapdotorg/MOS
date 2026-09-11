/**
 * /extensions module implementation (MKT-022, EXT-001).
 *
 * Composition over the three-table store with exactly the frozen matrix
 * dependencies (/extensions ──→ /executions, /policies, /credentials):
 *
 *   - REGISTRATION is pure registry publication: the manifest guard runs
 *     first (EXT-AC-01), then the insert — the (publisher, key, version)
 *     UNIQUE fence makes the version immutable (re-registration is a
 *     ConflictError, a new version is a new row);
 *   - INSTALLATION resolves the canonical Client/Workspace scope from the
 *     CALLER's durable ownership resolution (scope-as-data — the module
 *     has no /clients//workspaces dependency; the migration-028 triggers
 *     re-fence the chain), enforces least-privilege granted scopes and
 *     delegates the extension-dimension 'install' boundary to the merged
 *     /policies engine — FAIL-CLOSED: only an explicit 'allow' proceeds
 *     (deny/unknown/error → PolicyDeniedError);
 *   - CONFIGURATION validates values against the manifest config contract
 *     and binds required secret LOGICAL NAMES to credential REFERENCES
 *     resolved through the /credentials public contract (fail-closed on
 *     unknown/inactive/scope-mismatched references; material is never
 *     resolved, stored or logged);
 *   - INVOCATION derives the SHORT-LIVED context (implementation-contract
 *     §19): the execution's canonical ownership is resolved THROUGH the
 *     /executions public contract (unknown/foreign → uniform 404), the
 *     install must be AUTHORIZED in the execution's workspace, the
 *     requested capability set must be declared by the manifest, the
 *     extension-dimension 'invoke' boundary must be an explicit 'allow'
 *     (recorded append-only by /policies), and only then is the context
 *     composed and recorded ONCE in the append-only invocation ledger.
 *     The context is never a platform credential.
 *
 * Fail-closed contract: every guard throws before any state is touched;
 * policy denials throw PolicyDeniedError; unknown ids surface NotFoundError
 * (uniform — foreign and unknown are indistinguishable); CAS races surface
 * ConflictError.
 */

import { ConflictError, NotFoundError, PolicyDeniedError } from '../../../platform/errors/errors.ts';
import { isTerminalExecutionStatus } from '../../executions/public.ts';
import { enforcementOutcome } from '../../policies/public.ts';
import { isLegalExtensionInstallTransition } from '../public.ts';
import { DEFAULT_INVOCATION_TTL_MS } from '../public.ts';
import type {
  ExtensionInstallRecord,
  ExtensionInstallStatus,
  ExtensionInvocationProvenance,
  ExtensionRegistryRecord,
  ExtensionsModuleApi,
  ExtensionsModuleDeps,
} from '../public.ts';
import {
  assertValidExtensionConfigureInput,
  assertValidExtensionInstallInput,
  assertValidExtensionInvocationInput,
  assertValidExtensionManifest,
  assertValidInvocationProvenance,
  classifyExtensionsWriteConflict,
  composeInvocationContext,
  extensionCreateFingerprint,
  ExtensionsStore,
} from './store.ts';

export function createExtensionsModule(deps: ExtensionsModuleDeps): ExtensionsModuleApi {
  const store = new ExtensionsStore(deps.db, deps.clock, deps.ids);
  const { executions, policies, credentials } = deps;

  /**
   * The shared fail-closed policy gate: evaluates the extension-dimension
   * boundary for `operation` through the merged /policies engine and
   * denies everything that is not an explicit recorded 'allow'
   * (enforcementOutcome maps 'deny' AND 'unknown' to deny — POL-001).
   */
  async function requirePolicyAllow(input: {
    readonly operation: 'install' | 'invoke';
    readonly extension: ExtensionRegistryRecord;
    readonly scope: {
      readonly agencyId: string;
      readonly clientId: string;
    };
  }, provenance: ExtensionInvocationProvenance): Promise<string> {
    const decision = await policies.evaluateAction(
      {
        action: {
          dimension: 'extension',
          operation: input.operation,
          resource: input.extension.manifest.extensionKey,
          attributes: {
            extensionId: input.extension.extensionId,
            version: input.extension.manifest.version,
            runtimeClass: input.extension.manifest.runtimeClass,
          },
        },
        scope: input.scope,
      },
      {
        actor: provenance.actor,
        recordedVia: provenance.recordedVia,
        correlationId: provenance.correlationId,
        causationId: provenance.causationId,
      },
    );
    if (enforcementOutcome(decision) !== 'allow') {
      throw new PolicyDeniedError(
        `extension ${input.operation} of ${input.extension.manifest.extensionKey} ${input.extension.manifest.version} was denied by the extension policy boundary (${decision.reasonCode})`,
      );
    }
    return decision.decisionId;
  }

  /** Registry row or uniform 404 (foreign and unknown are indistinguishable). */
  async function extensionOr404(extensionId: string): Promise<ExtensionRegistryRecord> {
    const extension = await store.getExtensionVersion(extensionId);
    if (extension === null) {
      throw new NotFoundError('extension', extensionId);
    }
    return extension;
  }

  /** Install row or uniform 404. */
  async function installOr404(installId: string): Promise<ExtensionInstallRecord> {
    const install = await store.getExtensionInstall(installId);
    if (install === null) {
      throw new NotFoundError('extension install', installId);
    }
    return install;
  }

  return {
    async registerExtensionVersion(input) {
      // EXT-AC-01: the frozen manifest shape/permission declaration
      // contract runs BEFORE any write.
      assertValidExtensionManifest(input.manifest);
      const inserted = await store.insertExtensionVersion({
        manifest: input.manifest,
        idempotencyKey: input.idempotencyKey,
        createFingerprint: extensionCreateFingerprint(input.manifest),
        createdBy: input.actorId,
      });
      if (inserted === 'taken') {
        // The immutable-version fence fired: the (publisher, key, version)
        // triple already exists — deterministic 409, never a silent
        // rewrite (a new version is a new record).
        throw new ConflictError(
          `extension version ${input.manifest.publisher}/${input.manifest.extensionKey}@${input.manifest.version} is already published and immutable (publish a NEW version instead)`,
        );
      }
      return inserted;
    },

    async getExtensionVersion(extensionId) {
      return store.getExtensionVersion(extensionId);
    },

    async listExtensionVersions(input) {
      return store.listExtensionVersions(input.extensionKey);
    },

    async installExtension(input, provenance) {
      // Provenance is server-derived input (the routes build it from the
      // authenticated principal + ambient correlation context).
      assertValidInvocationProvenance(provenance);
      const extension = await extensionOr404(input.extensionId);
      // Least-privilege granted scopes ⊆ manifest-declared scopes.
      assertValidExtensionInstallInput(
        {
          scope: input.scope,
          extensionId: input.extensionId,
          grantedScopes: input.grantedScopes,
          idempotencyKey: input.idempotencyKey,
        },
        extension.manifest,
      );

      // FAIL-CLOSED extension-dimension 'install' policy gate (the scope
      // chain is the caller-resolved canonical owner).
      await requirePolicyAllow(
        {
          operation: 'install',
          extension,
          scope: { agencyId: input.scope.agencyId, clientId: input.scope.clientId },
        },
        provenance,
      );

      try {
        const install = await store.insertExtensionInstall({
          extensionId: input.extensionId,
          agencyId: input.scope.agencyId,
          clientId: input.scope.clientId,
          workspaceId: input.scope.workspaceId,
          grantedScopes: input.grantedScopes,
          idempotencyKey: input.idempotencyKey,
          createdBy: input.actorId,
        });
        if (install === 'taken') {
          // The (workspace, extension version) fence fired: the version is
          // already installed here. A duplicate of the SAME logical
          // install command converges; a different command is a 409.
          const existing = await store.findExtensionInstall(
            input.scope.workspaceId,
            input.extensionId,
          );
          if (
            existing !== null &&
            existing.idempotencyKey === input.idempotencyKey &&
            (existing.grantedScopes as readonly string[]).length === input.grantedScopes.length &&
            input.grantedScopes.every((scope) => (existing.grantedScopes as readonly string[]).includes(scope))
          ) {
            return { install: existing, replayed: true };
          }
          throw new ConflictError(
            `extension version ${extension.manifest.extensionKey}@${extension.manifest.version} is already installed in this workspace`,
          );
        }
        return { install, replayed: false };
      } catch (error) {
        if (classifyExtensionsWriteConflict(error) === 'install-fence') {
          const existing = await store.findExtensionInstall(
            input.scope.workspaceId,
            input.extensionId,
          );
          if (
            existing !== null &&
            existing.idempotencyKey === input.idempotencyKey &&
            (existing.grantedScopes as readonly string[]).length === input.grantedScopes.length &&
            input.grantedScopes.every((scope) => (existing.grantedScopes as readonly string[]).includes(scope))
          ) {
            return { install: existing, replayed: true };
          }
          throw new ConflictError(
            `extension version ${extension.manifest.extensionKey}@${extension.manifest.version} is already installed in this workspace`,
          );
        }
        throw error;
      }
    },

    async getExtensionInstall(installId) {
      return store.getExtensionInstall(installId);
    },

    async listExtensionInstalls(workspaceId) {
      return store.listExtensionInstalls(workspaceId);
    },

    async configureExtension(input) {
      const install = await installOr404(input.installId);
      const extension = await extensionOr404(install.extensionId);
      if (install.status === 'uninstalled') {
        throw new ConflictError(`extension install ${input.installId} is uninstalled and terminal`);
      }
      // Configuration contract + secret-binding completeness (all
      // requiredSecretNames bound to credential REFERENCES).
      assertValidExtensionConfigureInput(
        {
          installId: input.installId,
          config: input.config,
          secretBindings: input.secretBindings,
          expectedVersion: input.expectedVersion,
        },
        extension.manifest,
      );

      // CRED-001 posture: every binding resolves through the /credentials
      // public contract (references only). The reference must exist, be
      // LIVE (active) and belong to the install's agency scope — a
      // client-narrowed reference must match the install's client.
      // Material is NEVER resolved here.
      for (const [logicalName, credentialId] of Object.entries(input.secretBindings)) {
        const reference = await credentials.getCredentialReference(credentialId);
        if (reference === null || reference.status !== 'active') {
          throw new NotFoundError('credential reference', credentialId);
        }
        const scopeMatches =
          reference.agencyId === install.agencyId &&
          (reference.clientId === null ? true : reference.clientId === install.clientId);
        if (!scopeMatches) {
          // A foreign credential reference is not a traversal oracle.
          throw new NotFoundError('credential reference', credentialId);
        }
        void logicalName;
      }

      // The configure edge: installed|configured|authorized → configured.
      const target: ExtensionInstallStatus = 'configured';
      if (!isLegalExtensionInstallTransition(install.status, target)) {
        throw new ConflictError(
          `extension install ${input.installId} is ${install.status}; configuration is not a legal transition from here`,
        );
      }

      return deps.db.transaction(async (tx) => {
        const locked = await store.lockExtensionInstall(tx, input.installId);
        if (locked === null) {
          throw new NotFoundError('extension install', input.installId);
        }
        if (!isLegalExtensionInstallTransition(locked.status, target)) {
          throw new ConflictError(
            `extension install ${input.installId} is ${locked.status}; configuration is not a legal transition from here`,
          );
        }
        const outcome = await store.updateExtensionInstall(tx, {
          installId: input.installId,
          status: target,
          config: input.config,
          secretBindings: input.secretBindings,
          expectedVersion: input.expectedVersion,
        });
        if (outcome === 'not-found') {
          throw new NotFoundError('extension install', input.installId);
        }
        if (outcome === 'version-conflict') {
          throw new ConflictError('extension install was modified concurrently (CAS mismatch)');
        }
        return outcome.updated;
      });
    },

    async setExtensionInstallStatus(input) {
      if (input.status === 'installed' || input.status === 'configured') {
        throw new ConflictError(
          "status transitions target 'authorized', 'disabled' or 'uninstalled' — configuration is the configure endpoint",
        );
      }
      const install = await installOr404(input.installId);
      if (!isLegalExtensionInstallTransition(install.status, input.status)) {
        throw new ConflictError(
          `illegal extension install transition ${install.status} → ${input.status} (the frozen lifecycle)`,
        );
      }
      return deps.db.transaction(async (tx) => {
        const locked = await store.lockExtensionInstall(tx, input.installId);
        if (locked === null) {
          throw new NotFoundError('extension install', input.installId);
        }
        if (!isLegalExtensionInstallTransition(locked.status, input.status)) {
          throw new ConflictError(
            `illegal extension install transition ${locked.status} → ${input.status} (the frozen lifecycle)`,
          );
        }
        const outcome = await store.updateExtensionInstall(tx, {
          installId: input.installId,
          status: input.status,
          config: null,
          secretBindings: null,
          expectedVersion: input.expectedVersion,
        });
        if (outcome === 'not-found') {
          throw new NotFoundError('extension install', input.installId);
        }
        if (outcome === 'version-conflict') {
          throw new ConflictError('extension install was modified concurrently (CAS mismatch)');
        }
        return outcome.updated;
      });
    },

    async beginExtensionInvocation(input, provenance) {
      assertValidInvocationProvenance(provenance);

      // 1. Canonical execution ownership resolution THROUGH the
      //    /executions public contract (uniform 404 for foreign/unknown/
      //    orphaned ids — the hard-boundary posture).
      const ownership = await executions.resolveExecutionOwnership(input.executionId);
      if (ownership === null) {
        throw new NotFoundError('execution', input.executionId);
      }
      const { execution, workspace } = ownership;
      // The invocation rides an EXTENSION-kind, non-terminal execution.
      if (execution.executionKind !== 'extension') {
        throw new ConflictError(
          `execution ${input.executionId} is ${execution.executionKind}-kind; extension invocation requires an extension-kind execution`,
        );
      }
      if (isTerminalExecutionStatus(execution.status)) {
        throw new ConflictError(
          `execution ${input.executionId} is terminal (${execution.status}); invocation requires a live execution`,
        );
      }

      // 2. The registry row (uniform 404) + the frozen invocation input
      //    guard (undeclared capabilities rejected; input contract).
      const extension = await extensionOr404(input.extensionId);
      assertValidExtensionInvocationInput(
        {
          executionId: input.executionId,
          extensionId: input.extensionId,
          requestedCapabilities: input.requestedCapabilities,
          input: input.input,
        },
        extension.manifest,
      );

      // 3. The install is resolved by (execution workspace, extension
      //    version) from durable state — caller-supplied scope is never
      //    consulted — and must be AUTHORIZED (fail closed).
      const install = await store.findExtensionInstall(workspace.workspaceId, input.extensionId);
      if (install === null) {
        // The version is not installed in the execution's workspace:
        // indistinguishable from an unknown extension (uniform 404 — no
        // cross-tenant oracle).
        throw new NotFoundError('extension install', input.extensionId);
      }
      if (install.status !== 'authorized') {
        throw new ConflictError(
          `extension install ${install.installId} is ${install.status}; invocation requires an authorized install`,
        );
      }

      // 4. FAIL-CLOSED extension-dimension 'invoke' policy gate at the
      //    execution's canonical scope (the decision is recorded
      //    append-only by /policies; only an explicit 'allow' proceeds).
      const policyDecisionId = await requirePolicyAllow(
        {
          operation: 'invoke',
          extension,
          scope: {
            agencyId: ownership.scope.agencyId,
            clientId: ownership.scope.clientId,
          },
        },
        provenance,
      );

      // 5. Compose the short-lived context (pure) and record it ONCE in
      //    the append-only invocation ledger (Observe). The context is
      //    observability + contract state, NEVER a credential.
      const invocationId = deps.ids.newId();
      const issuedAt = deps.clock.nowIso();
      const { context, grantedCapabilities, grantedDataScopes } = composeInvocationContext({
        invocationId,
        extension,
        install,
        executionId: input.executionId,
        scope: {
          agencyId: ownership.scope.agencyId,
          clientId: ownership.scope.clientId,
          workspaceId: ownership.scope.workspaceId,
        },
        requestedCapabilities: input.requestedCapabilities,
        policyDecisionId,
        input: input.input,
        provenance,
        issuedAt,
        ttlMs: DEFAULT_INVOCATION_TTL_MS,
      });
      await store.insertExtensionInvocation({
        invocationId,
        extensionId: extension.extensionId,
        extensionKey: extension.manifest.extensionKey,
        version: extension.manifest.version,
        installId: install.installId,
        executionId: input.executionId,
        agencyId: context.scope.agencyId,
        clientId: context.scope.clientId,
        workspaceId: context.scope.workspaceId,
        grantedCapabilities,
        grantedDataScopes,
        policyDecisionId,
        policyOutcome: 'allow',
        input: input.input,
        provenance,
        issuedAt,
        expiresAt: context.expiresAt,
      });
      return context;
    },

    async getExtensionInvocation(invocationId) {
      return store.getExtensionInvocation(invocationId);
    },

    async listExtensionInvocations(workspaceId) {
      return store.listExtensionInvocations(workspaceId);
    },
  };
}
