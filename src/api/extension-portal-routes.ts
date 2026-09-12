/**
 * /api/extension-portal EXTENSION DEVELOPER PORTAL routes (MKT-032 —
 * UI-003: "Provide Extension Developer/installation surfaces").
 *
 *   DEVELOPER surface (publishing + version history + the testing hook):
 *     POST   /api/extension-portal/versions                                        publish a NEW extension version (platform_developer | platform_administrator — the frozen Platform Developer/Extension Publisher role, users/public.ts: "wired by later extension Work Items")
 *     GET    /api/extension-portal/catalog                                         the developer catalog: distinct extension keys, version counts, the newest version + its compatibility range (any active member)
 *     GET    /api/extension-portal/extensions/:extensionKey/versions               the VERSION HISTORY + compatibility records of one extension key (any active member)
 *     GET    /api/extension-portal/versions/:extensionId                           one published version (any active member)
 *     POST   /api/extension-portal/executions/:executionId/extensions/:extensionId/test   the TESTING HOOK — derive the short-lived invocation context against a LIVE extension-kind Execution (member of the execution's owning agency)
 *
 *   PERMISSION REVIEW surface (frozen claims + review/approval state + the reviewer action):
 *     GET    /api/extension-portal/workspaces/:workspaceId/versions/:extensionId/permission-review   the review view: the version's frozen permission claims, the active extension-dimension policy chain for the workspace's scope, which active rules REFERENCE this version, the recorded extension decisions and the append-oriented review history (any workspace member)
 *     POST   /api/extension-portal/versions/:extensionId/permission-review                           PLATFORM-scoped reviewer action: approve|reject (platform administrator)
 *     POST   /api/extension-portal/agencies/:agencyId/versions/:extensionId/permission-review         AGENCY-scoped reviewer action (owner|admin of the agency | platform administrator)
 *     POST   /api/extension-portal/clients/:clientId/versions/:extensionId/permission-review          CLIENT-scoped reviewer action (owner|admin of the owning agency | platform administrator)
 *
 *   INSTALLATION surface (the install/configure lifecycle + version management, workspace-scoped):
 *     POST   /api/extension-portal/workspaces/:workspaceId/installs                                 install a published version (owner|admin of the owning agency | platform administrator)
 *     GET    /api/extension-portal/workspaces/:workspaceId/installs                                 the workspace installs in ALL states (any active member)
 *     POST   /api/extension-portal/workspaces/:workspaceId/installs/:installId/configure             validate+store config + CRED-001 secret bindings (owner|admin)
 *     POST   /api/extension-portal/workspaces/:workspaceId/installs/:installId/authorize             the authorize edge ("enable"; owner|admin)
 *     POST   /api/extension-portal/workspaces/:workspaceId/installs/:installId/disable               the disable edge (owner|admin)
 *     POST   /api/extension-portal/workspaces/:workspaceId/installs/:installId/uninstall             the TERMINAL uninstall edge (owner|admin)
 *     GET    /api/extension-portal/workspaces/:workspaceId/extensions/:extensionKey/versions         the VERSION-MANAGEMENT view: every published version of the key + which is installed (pinned) in THIS workspace + upgrade availability (any active member)
 *     POST   /api/extension-portal/workspaces/:workspaceId/extensions/:extensionKey/upgrade          the UPGRADE operation: install the target version (delegated) with an optional retiring of the prior install (a SECOND delegated uninstall call — never atomic; owner|admin)
 *
 * AUTHORITY POSTURE (the MKT-030/MKT-031 "route family over an existing
 * authority" precedent — this file is a THIN delegation layer; the
 * reporting-decision-room-routes.ts and jobs-queue-routes.ts patterns):
 *
 *   - The /extensions module (MKT-022, merged) remains the ONLY authority
 *     for extension registration/versioning/compatibility/permissions/
 *     lifecycle: EVERY portal operation delegates to its public contract
 *     (registerExtensionVersion / listExtensionVersions / getExtensionVersion
 *     / installExtension / configureExtension / setExtensionInstallStatus
 *     / beginExtensionInvocation / listExtensionInstalls). This file adds
 *     NO module, NO store, NO table, NO second lifecycle engine — the
 *     install family CONVERGES with the direct MKT-022 surface exactly the
 *     way the MKT-031 work-queue routes converge with the direct /jobs
 *     surface (one authority, multiple route families).
 *   - PERMISSION REVIEW IS REALIZED THROUGH THE FROZEN CONTRACTS: the live
 *     tree's authority owns NO separate review table (state-machines.md has
 *     no REVIEW state for extension versions, and migration 028 creates
 *     none) — the frozen permission-approval mechanism IS the fail-closed
 *     extension-dimension boundary the /extensions authority already
 *     enforces inside installExtension/beginExtensionInvocation through the
 *     merged /policies engine (PolicyDeniedError unless an explicit
 *     recorded 'allow'). The reviewer action is therefore a DELEGATED
 *     declarePolicyVersion call at platform/agency/client scope whose rules
 *     are built from the version's OWN identity (resource=extensionKey,
 *     attributes={extensionId, version}) and MERGED additively into the
 *     scope's active extension policy (existing rules preserved; only a
 *     prior review of the SAME version is replaced — re-review converges,
 *     and the superseded versions remain queryable forever as the review
 *     history). THE SURFACE NEVER EVALUATES PERMISSIONS: rule matching,
 *     deny-overrides composition and decision recording stay exclusively
 *     in the /policies engine, and enforcement stays exclusively in the
 *     /extensions authority's install/invoke gates. A rejected version is
 *     denied at the AUTHORITY even where a broader allow exists
 *     (deny-overrides); an unreviewed version is denied at the AUTHORITY
 *     unless some other rule allows it — there is NO portal path around
 *     the gate because every install path IS the authority's gate.
 *   - SERVER-DERIVED AUTHORITY EVERYWHERE (implementation-contract §3/§23):
 *     every mutation route resolves the canonical owner from durable state
 *     BEFORE authorize/validate/execute; identity, scope, lifecycle,
 *     provenance and policy posture fields are NEVER request-suppliable
 *     (the DTOs reject them explicitly, plus every material-shaped key —
 *     §21); unknown/foreign identifiers are the UNIFORM 404 (no
 *     cross-tenant oracle); CAS conflicts are 409s.
 *   - HONEST DISCLOSURES encoded in the responses: the permission-review
 *     view reports the platform-scope policy as admin-restricted for
 *     non-admin callers (the platform security-configuration surface is
 *     platform-admin-only per policies-routes.ts) and never derives an
 *     allow/deny verdict of its own; the upgrade operation reports that it
 *     is a non-atomic surface-level orchestration of TWO delegated
 *     authority operations; the version-management view reports the pinned
 *     version per install as structural (an install references an
 *     immutable version and never changes it — there is no auto-upgrade to
 *     prevent); the catalog/history listings are the /extensions
 *     authority's bounded newest-first listing.
 */

import { ForbiddenError, NotFoundError } from '../platform/errors/errors.ts';
import type { Principal } from '../platform/http/auth/contract.ts';
import {
  defineMutationRoute,
  defineQueryRoute,
  jsonResponse,
  type OwnerScope,
} from '../platform/http/pipeline.ts';
import type { AppServices } from '../platform/app-services.ts';
import type { Router } from '../platform/http/router.ts';
import { currentCorrelation } from '../platform/observability/correlation.ts';
import {
  arrayField,
  intField,
  objectField,
  optionalString,
  recordField,
  stringField,
  validateObject,
} from '../platform/http/validation.ts';
import type { ApplicationModules } from './application.ts';
import {
  requireAgencyAccess,
  requireClientAccess,
  requireExecutionAccess,
  requirePlatformAdministrator,
  requireWorkspaceAccess,
  resolveContext,
} from './authorize.ts';
import { auditActor, recordMutationAudit } from './audit-emit.ts';
import type {
  ExtensionInstallRecord,
  ExtensionInvocationContext,
  ExtensionRegistryRecord,
} from '../modules/extensions/public.ts';
import { isInvocationContextExpired } from '../modules/extensions/public.ts';
import type {
  PolicyDecisionRecord,
  PolicyRule,
  PolicyVersionRecord,
} from '../modules/policies/public.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SCOPE_PATTERN = /^(client:read|client:write|workspace:read|workspace:write)$/;
const CAPABILITY_NAME_PATTERN = /^.{1,64}$/;
const CREDENTIAL_REF_PATTERN = /^[0-9a-zA-Z][0-9a-zA-Z._:-]{0,63}$/;
const EXTENSION_KEY_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;

// ---------------------------------------------------------------------------
// Server-derived-authority rejection contracts (the MKT-022 route posture)
// ---------------------------------------------------------------------------

/**
 * Fields always server-derived on REGISTRATION (publication): identity,
 * lifecycle, provenance — plus every material-shaped key, so no secret
 * VALUE can be smuggled into a manifest through the portal either
 * (requiredSecretNames are logical names only — CRED-001/§21).
 */
const PORTAL_REGISTRATION_AUTHORITY_FIELDS = [
  'extensionId',
  'createFingerprint',
  'createdBy',
  'createdAt',
  'updatedAt',
  'provenance',
  'actor',
  'correlationId',
  'causationId',
  'recordedAt',
  'secret',
  'secretMaterial',
  'material',
  'password',
  'token',
  'apiKey',
  'api_key',
  'accessKey',
  'secretHandle',
] as const;

/** Fields always server-derived on INSTALL (scope, identity, lifecycle). */
const PORTAL_INSTALL_AUTHORITY_FIELDS = [
  'installId',
  'agencyId',
  'clientId',
  'workspaceId',
  'scope',
  'status',
  'config',
  'secretBindings',
  'version',
  'createdBy',
  'createdAt',
  'updatedAt',
  'uninstalledAt',
  'provenance',
  'policyDecisionId',
  'secret',
  'secretMaterial',
  'material',
  'password',
  'token',
  'apiKey',
  'api_key',
  'accessKey',
  'secretHandle',
] as const;

/** Fields always server-derived on CONFIGURE. */
const PORTAL_CONFIGURE_AUTHORITY_FIELDS = [
  'installId',
  'status',
  'grantedScopes',
  'version',
  'createdBy',
  'createdAt',
  'updatedAt',
  'provenance',
  'secret',
  'secretMaterial',
  'material',
  'password',
  'token',
  'apiKey',
  'api_key',
  'accessKey',
  'secretHandle',
] as const;

/** Fields always server-derived on the STATUS edges (authorize/disable/uninstall). */
const PORTAL_STATUS_AUTHORITY_FIELDS = [
  'status',
  'version',
  'createdBy',
  'createdAt',
  'updatedAt',
  'uninstalledAt',
  'provenance',
  'secret',
  'secretMaterial',
  'material',
  'password',
  'token',
  'apiKey',
  'api_key',
  'accessKey',
  'secretHandle',
] as const;

/**
 * Fields always server-derived on the PERMISSION-REVIEW action: the review
 * is COMPOSED server-side from the version's own identity — the caller
 * supplies ONLY the decision and the human reason. Rule shape, effect,
 * operations, resource, attributes, scope, identity, lifecycle and
 * provenance are never request-suppliable, and material-shaped keys are
 * rejected outright (§21 — the engine evaluates access proposals).
 */
const PORTAL_REVIEW_AUTHORITY_FIELDS = [
  'rules',
  'rule',
  'effect',
  'operations',
  'resource',
  'attributes',
  'dimension',
  'scope',
  'scopeKind',
  'agencyId',
  'clientId',
  'policyId',
  'status',
  'versionSeq',
  'version',
  'supersededAt',
  'supersededByPolicyId',
  'createdBy',
  'createdAt',
  'updatedAt',
  'provenance',
  'actor',
  'recordedActor',
  'recordedVia',
  'correlationId',
  'causationId',
  'recordedAt',
  'decisionId',
  'outcome',
  'reasonCode',
  'matchedPolicyVersions',
  'enforcement',
  'secret',
  'secretMaterial',
  'material',
  'password',
  'token',
  'apiKey',
  'api_key',
  'accessKey',
  'secretHandle',
] as const;

/**
 * Fields always server-derived on the TESTING hook: the invocation
 * identity, tenant scope, granted sets, policy posture, runtime class and
 * provenance — the context is derived from the EXECUTION's canonical owner
 * and the installed manifest; a caller can never assert any of them
 * (EXT-AC-02/EXT-AC-04, implementation-contract §19).
 */
const PORTAL_TEST_AUTHORITY_FIELDS = [
  'invocationId',
  'extensionKey',
  'publisher',
  'version',
  'installId',
  'scope',
  'agencyId',
  'clientId',
  'workspaceId',
  'grantedCapabilities',
  'grantedDataScopes',
  'grantedScopes',
  'policyDecisionId',
  'policyOutcome',
  'runtimeClass',
  'inputContract',
  'outputContract',
  'provenance',
  'actor',
  'recordedActor',
  'recordedVia',
  'correlationId',
  'causationId',
  'issuedAt',
  'expiresAt',
  'recordedAt',
  'replayed',
  'secret',
  'secretMaterial',
  'material',
  'password',
  'token',
  'apiKey',
  'api_key',
  'accessKey',
  'secretHandle',
] as const;

/**
 * Authority-shaped keys rejected INSIDE the testing-hook input payload:
 * invocation identity, tenant scope and provenance are server-derived — an
 * extension invocation can never assert them (and the module guard
 * additionally rejects material keys at every nesting level).
 */
const PORTAL_TEST_INPUT_FORBIDDEN_KEYS = [
  'invocationId',
  'extensionId',
  'installId',
  'executionId',
  'scope',
  'agencyId',
  'clientId',
  'workspaceId',
  'grantedCapabilities',
  'grantedDataScopes',
  'grantedScopes',
  'policyDecisionId',
  'policyOutcome',
  'provenance',
  'actor',
  'recordedActor',
  'recordedVia',
  'correlationId',
  'causationId',
  'issuedAt',
  'expiresAt',
  'recordedAt',
  'runtimeClass',
  'evidenceId',
  'evidenceRef',
  'actorProvenance',
  'collectedBy',
  'secret',
  'secretMaterial',
  'material',
  'password',
  'token',
  'apiKey',
  'api_key',
  'accessKey',
  'secretHandle',
] as const;

/** Server-derived provenance for HTTP surfaces (never a request field). */
function serverProvenance(principal: Principal): {
  readonly actor: string;
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
} {
  const correlation = currentCorrelation();
  return {
    actor: auditActor(principal),
    recordedVia: 'api',
    correlationId: correlation.correlationId,
    causationId: correlation.causationId,
  };
}

// ---------------------------------------------------------------------------
// Serialization (opaque, non-secret representations — the MKT-022 shapes)
// ---------------------------------------------------------------------------

function serializeExtension(record: ExtensionRegistryRecord): Record<string, unknown> {
  return {
    extensionId: record.extensionId,
    manifest: {
      extensionKey: record.manifest.extensionKey,
      publisher: record.manifest.publisher,
      version: record.manifest.version,
      compatibility: record.manifest.compatibility,
      capabilities: record.manifest.capabilities,
      permissions: record.manifest.permissions,
      requiredSecretNames: record.manifest.requiredSecretNames,
      dataScopes: record.manifest.dataScopes,
      networkRequirements: record.manifest.networkRequirements,
      runtimeClass: record.manifest.runtimeClass,
      inputContract: record.manifest.inputContract,
      outputContract: record.manifest.outputContract,
      eventSubscriptions: record.manifest.eventSubscriptions,
      uiSurfaces: record.manifest.uiSurfaces,
      configContract: record.manifest.configContract,
    },
    idempotencyKey: record.idempotencyKey,
    createFingerprint: record.createFingerprint,
    ...(record.createdBy === null ? {} : { createdBy: record.createdBy }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function serializeInstall(record: ExtensionInstallRecord): Record<string, unknown> {
  return {
    installId: record.installId,
    extensionId: record.extensionId,
    agencyId: record.agencyId,
    clientId: record.clientId,
    workspaceId: record.workspaceId,
    status: record.status,
    config: record.config,
    secretBindings: record.secretBindings,
    grantedScopes: record.grantedScopes,
    idempotencyKey: record.idempotencyKey,
    version: record.version,
    ...(record.createdBy === null ? {} : { createdBy: record.createdBy }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function serializePolicyVersion(record: PolicyVersionRecord): Record<string, unknown> {
  return {
    policyId: record.policyId,
    dimension: record.dimension,
    scopeKind: record.scopeKind,
    ...(record.agencyId === null ? {} : { agencyId: record.agencyId }),
    ...(record.clientId === null ? {} : { clientId: record.clientId }),
    status: record.status,
    versionSeq: record.versionSeq,
    rules: record.rules,
    description: record.description,
    ...(record.createdBy === null ? {} : { createdBy: record.createdBy }),
    ...(record.supersededAt === null ? {} : { supersededAt: record.supersededAt }),
    ...(record.supersededByPolicyId === null ? {} : { supersededByPolicyId: record.supersededByPolicyId }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function serializeDecision(record: PolicyDecisionRecord): Record<string, unknown> {
  return {
    decisionId: record.decisionId,
    dimension: record.dimension,
    agencyId: record.agencyId,
    ...(record.clientId === null ? {} : { clientId: record.clientId }),
    outcome: record.outcome,
    reasonCode: record.reasonCode,
    reasons: record.reasons,
    action: record.action,
    matchedPolicyVersions: record.matchedPolicyVersions,
    provenance: record.provenance,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerExtensionPortalRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('extension-portal.api');

  /** Canonical workspace owner scope; 404 BEFORE dependent traversal. */
  async function workspaceOwner(workspaceId: string): Promise<OwnerScope> {
    const ownership = await modules.workspaces.resolveWorkspaceOwnership(workspaceId);
    if (ownership === null) {
      throw new NotFoundError('workspace', workspaceId);
    }
    return {
      kind: 'workspace',
      agencyId: ownership.scope.agencyId,
      clientId: ownership.scope.clientId,
      workspaceId: ownership.scope.workspaceId,
    };
  }

  /** Canonical agency owner scope; 404 BEFORE dependent traversal. */
  async function agencyOwner(agencyId: string): Promise<OwnerScope> {
    const agency = await modules.agencies.getAgency(agencyId);
    if (agency === null) {
      throw new NotFoundError('agency', agencyId);
    }
    return { kind: 'agency', agencyId };
  }

  /** Canonical client owner scope (agency derived from durable ownership). */
  async function clientOwner(clientId: string): Promise<OwnerScope> {
    const ownership = await modules.clients.resolveClientOwnership(clientId);
    if (ownership === null) {
      throw new NotFoundError('client', clientId);
    }
    return {
      kind: 'client',
      agencyId: ownership.client.agencyId,
      clientId: ownership.client.clientId,
    };
  }

  /**
   * The install-scoped owner: the install row → its workspace, resolved
   * from durable state BEFORE authorize (uniform 404 for foreign/unknown).
   */
  async function installOwner(workspaceId: string, installId: string): Promise<OwnerScope> {
    const install = await modules.extensions.getExtensionInstall(installId);
    if (install === null || install.workspaceId !== workspaceId) {
      throw new NotFoundError('extension install', installId);
    }
    return {
      kind: 'workspace',
      agencyId: install.agencyId,
      clientId: install.clientId,
      workspaceId: install.workspaceId,
    };
  }

  /** Registry row or uniform 404 (foreign and unknown are indistinguishable). */
  async function extensionOr404(extensionId: string): Promise<ExtensionRegistryRecord> {
    if (!UUID_PATTERN.test(extensionId)) {
      throw new NotFoundError('extension', extensionId);
    }
    const extension = await modules.extensions.getExtensionVersion(extensionId);
    if (extension === null) {
      throw new NotFoundError('extension', extensionId);
    }
    return extension;
  }

  /**
   * DEVELOPER authorization: the frozen platform_developer role
   * ("Platform Developer/Extension Publisher ... wired by later extension
   * Work Items" — this Work Item wires it) or the platform administrator;
   * the internal service principal publishes like every platform surface.
   */
  async function requireDeveloperRole(principal: Principal): Promise<void> {
    if (principal.kind === 'service') return;
    const context = await resolveContext(modules, principal);
    if (context === null || context.principal.status !== 'active') {
      throw new ForbiddenError('Active user identity required');
    }
    if (
      context.platformRoles.includes('platform_developer') ||
      context.platformRoles.includes('platform_administrator')
    ) {
      return;
    }
    throw new ForbiddenError(
      'Publishing through the Extension Developer Portal requires the platform_developer or platform_administrator role',
    );
  }

  /**
   * The manifest DTO spec: the frozen EXT-001 field contract — identity,
   * compatibility range, the §3 capability list, the §5 permission list,
   * required secret LOGICAL NAMES, data scopes, network requirements,
   * runtime class, the input/output contracts, event subscriptions, UI
   * surfaces and the config contract. Identical declarative shape to the
   * direct MKT-022 registration surface (surface-level input hygiene; the
   * /extensions authority's assertValidExtensionManifest guard remains the
   * single semantic enforcement point behind it).
   */
  function manifestSpec() {
    return {
      forbiddenKeys: PORTAL_REGISTRATION_AUTHORITY_FIELDS,
      fields: {
        manifest: objectField({
          fields: {
            extensionKey: stringField({ pattern: EXTENSION_KEY_PATTERN }),
            publisher: stringField({ pattern: /^[a-z0-9][a-z0-9._-]{0,63}$/ }),
            version: stringField({ pattern: /^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]{1,32})?$/ }),
            compatibility: objectField({
              fields: {
                minPlatform: stringField({ minLength: 1, maxLength: 32 }),
                maxPlatform: stringField({ minLength: 1, maxLength: 32 }),
              },
            }),
            capabilities: arrayField({
              minItems: 1,
              maxItems: 32,
              item: objectField({
                fields: {
                  category: stringField({
                    pattern: /^(data-source|research-discovery|content-creative-generation|execution-action|measurement|crm-commerce-integration|field-acquisition|ai-capability|approval-ui-surface)$/,
                  }),
                  name: stringField({ minLength: 1, maxLength: 64 }),
                },
              }),
            }),
            permissions: arrayField({
              minItems: 1,
              maxItems: 64,
              item: objectField({
                fields: {
                  action: stringField({ pattern: /^(data:read|data:write|network:egress|secret:use)$/ }),
                  resource: optionalString({ minLength: 1, maxLength: 256 }),
                },
              }),
            }),
            requiredSecretNames: arrayField({
              minItems: 0,
              maxItems: 16,
              item: stringField({ pattern: /^[A-Z][A-Z0-9_]{2,47}$/ }),
            }),
            dataScopes: arrayField({
              minItems: 0,
              maxItems: 8,
              item: stringField({ pattern: SCOPE_PATTERN }),
            }),
            networkRequirements: arrayField({
              minItems: 0,
              maxItems: 16,
              item: objectField({
                fields: {
                  host: stringField({ minLength: 1, maxLength: 253 }),
                  protocol: stringField({ minLength: 1, maxLength: 16 }),
                  port: stringField({ pattern: /^(?:[1-9][0-9]{0,4})$/ }),
                  reason: stringField({ minLength: 1, maxLength: 256 }),
                },
              }),
            }),
            runtimeClass: stringField({
              pattern: /^(pooled-worker|ephemeral-sandbox|persistent-sandbox|dedicated-runtime)$/,
            }),
            inputContract: recordField({ maxDepthKeys: 32 }),
            outputContract: recordField({ maxDepthKeys: 32 }),
            eventSubscriptions: arrayField({
              minItems: 0,
              maxItems: 32,
              item: stringField({ minLength: 1, maxLength: 64 }),
            }),
            uiSurfaces: arrayField({
              minItems: 0,
              maxItems: 32,
              item: stringField({ minLength: 1, maxLength: 64 }),
            }),
            configContract: recordField({ maxDepthKeys: 32 }),
          },
        }),
        idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
      },
    };
  }

  type ValidatedRegistration = {
    readonly manifest: {
      readonly extensionKey: string;
      readonly publisher: string;
      readonly version: string;
      readonly compatibility: { readonly minPlatform: string; readonly maxPlatform: string };
      readonly capabilities: ReadonlyArray<{ readonly category: string; readonly name: string }>;
      readonly permissions: ReadonlyArray<{ readonly action: string; readonly resource: string | undefined }>;
      readonly requiredSecretNames: readonly string[];
      readonly dataScopes: readonly string[];
      readonly networkRequirements: ReadonlyArray<{
        readonly host: string;
        readonly protocol: string;
        readonly port: string;
        readonly reason: string;
      }>;
      readonly runtimeClass: string;
      readonly inputContract: Record<string, unknown>;
      readonly outputContract: Record<string, unknown>;
      readonly eventSubscriptions: readonly string[];
      readonly uiSurfaces: readonly string[];
      readonly configContract: Record<string, unknown>;
    };
    readonly idempotencyKey: string;
  };

  /** Rebuilds the typed manifest from the validated DTO. */
  function deserializeManifest(dto: ValidatedRegistration['manifest']) {
    const configContract: Record<string, {
      type: 'string' | 'number' | 'boolean' | 'object';
      required: boolean;
      description: string;
      pattern: string | null;
    }> = {};
    const rawConfig = dto.configContract as Record<string, unknown>;
    for (const [key, field] of Object.entries(rawConfig)) {
      if (field !== null && typeof field === 'object' && !Array.isArray(field)) {
        const typed = field as {
          type?: unknown;
          required?: unknown;
          description?: unknown;
          pattern?: unknown;
        };
        configContract[key] = {
          type: (typeof typed.type === 'string' && ['string', 'number', 'boolean', 'object'].includes(typed.type)
            ? typed.type
            : 'string') as 'string' | 'number' | 'boolean' | 'object',
          required: typed.required === true,
          description: typeof typed.description === 'string' ? typed.description : '',
          pattern: typeof typed.pattern === 'string' ? typed.pattern : null,
        };
      }
    }
    return {
      extensionKey: dto.extensionKey,
      publisher: dto.publisher,
      version: dto.version,
      compatibility: { minPlatform: dto.compatibility.minPlatform, maxPlatform: dto.compatibility.maxPlatform },
      capabilities: dto.capabilities.map((capability) => ({
        category: capability.category as ExtensionRegistryRecord['manifest']['capabilities'][number]['category'],
        name: capability.name,
      })),
      permissions: dto.permissions.map((permission) => ({
        action: permission.action as ExtensionRegistryRecord['manifest']['permissions'][number]['action'],
        resource: permission.resource === undefined ? null : permission.resource,
      })),
      requiredSecretNames: dto.requiredSecretNames,
      dataScopes: dto.dataScopes as ExtensionRegistryRecord['manifest']['dataScopes'],
      networkRequirements: dto.networkRequirements.map((requirement) => ({
        host: requirement.host,
        protocol: requirement.protocol,
        port: Number(requirement.port),
        reason: requirement.reason,
      })),
      runtimeClass: dto.runtimeClass as ExtensionRegistryRecord['manifest']['runtimeClass'],
      inputContract: dto.inputContract,
      outputContract: dto.outputContract,
      eventSubscriptions: dto.eventSubscriptions,
      uiSurfaces: dto.uiSurfaces,
      configContract,
    };
  }

  // -------------------------------------------------------------------------
  // The permission-review composition (delegated to the /policies authority)
  // -------------------------------------------------------------------------

  /**
   * Pure predicate: does this rule record a PRIOR REVIEW of exactly this
   * extension version (resource = the key AND attributes pin the registry
   * id + version)? Used ONLY to converge re-reviews of the same version —
   * this is not permission evaluation; the /policies engine alone decides
   * outcomes, and only at the /extensions authority's gates.
   */
  function ruleReviewsVersion(rule: PolicyRule, extension: ExtensionRegistryRecord): boolean {
    return (
      rule.resource === extension.manifest.extensionKey &&
      rule.attributes['extensionId'] === extension.extensionId &&
      rule.attributes['version'] === extension.manifest.version
    );
  }

  /**
   * The DELEGATED reviewer action: declares the extension-dimension policy
   * version at the given scope through the /policies public contract — the
   * frozen permission-approval authority whose decisions the /extensions
   * install/invoke gates enforce fail-closed. The rules are COMPOSED
   * server-side: every rule of the scope's current active extension policy
   * is PRESERVED except a prior review of THIS version (re-review
   * converges), then exactly one version-scoped review rule is appended:
   * approve → allow(install,invoke) for this version; reject →
   * deny(install,invoke) for this version (deny-overrides at the authority
   * means a rejected version is denied even where broader allows exist).
   * The superseded policy versions remain queryable forever — the
   * append-oriented review history.
   */
  async function declarePermissionReview(input: {
    readonly scope: { readonly agencyId: string | null; readonly clientId: string | null };
    readonly extension: ExtensionRegistryRecord;
    readonly decision: 'approve' | 'reject';
    readonly reason: string;
    readonly actorId: string | null;
  }): Promise<PolicyVersionRecord> {
    const active = await modules.policies.getActivePolicyVersion({
      scope: { agencyId: input.scope.agencyId, clientId: input.scope.clientId },
      dimension: 'extension',
    });
    const preservedRules = active === null
      ? []
      : active.rules.filter((rule) => !ruleReviewsVersion(rule, input.extension));
    const reviewRule: PolicyRule = {
      effect: input.decision === 'approve' ? 'allow' : 'deny',
      operations: ['install', 'invoke'],
      resource: input.extension.manifest.extensionKey,
      attributes: {
        extensionId: input.extension.extensionId,
        version: input.extension.manifest.version,
      },
      reason: input.reason,
    };
    return modules.policies.declarePolicyVersion({
      scope: { agencyId: input.scope.agencyId, clientId: input.scope.clientId },
      dimension: 'extension',
      rules: [...preservedRules, reviewRule],
      description: `Extension permission review (${input.decision}) of ${input.extension.manifest.publisher}/${input.extension.manifest.extensionKey}@${input.extension.manifest.version}`,
      actorId: input.actorId,
    });
  }

  /** Is this caller a platform administrator (platform-scope reads)? */
  async function isPlatformAdmin(principal: Principal): Promise<boolean> {
    if (principal.kind === 'service') return true;
    const context = await resolveContext(modules, principal);
    return context !== null
      && context.principal.status === 'active'
      && context.platformRoles.includes('platform_administrator');
  }

  /** The shared reviewer-action route body contract. */
  function reviewSpec() {
    return {
      forbiddenKeys: PORTAL_REVIEW_AUTHORITY_FIELDS,
      fields: {
        decision: stringField({ pattern: /^(approve|reject)$/ }),
        reason: stringField({ minLength: 1, maxLength: 512 }),
      },
    };
  }

  type ValidatedReview = { readonly decision: string; readonly reason: string };

  /**
   * The shared reviewer-action mutation: resolve the canonical owner from
   * durable state BEFORE authorize (the route's own resolver), resolve the
   * version (uniform 404), delegate the /policies declaration, audit it,
   * and disclose honestly that enforcement happens at the /extensions
   * authority's gates. `resolveScope` derives the declaration scope from
   * the SAME durable ownership chain.
   */
  function reviewRoute(
    path: string,
    resolveOwner: (params: Record<string, string>) => Promise<OwnerScope>,
    authorize: (principal: Principal, params: Record<string, string>) => Promise<void>,
    resolveScope: (params: Record<string, string>) => Promise<{ agencyId: string | null; clientId: string | null }>,
  ): void {
    router.add(
      'POST',
      path,
      defineMutationRoute<
        Record<string, string>,
        { policy: PolicyVersionRecord; extension: ExtensionRegistryRecord; decision: string }
      >({
        authenticator: services.auth,
        resolveOwner: async (_ctx, params) => resolveOwner(params),
        authorize: async (ctx) => {
          await authorize(ctx.principal, ctx.params);
        },
        validate: (ctx) => validateObject<ValidatedReview>(ctx.request.body, reviewSpec()),
        execute: async (ctx) => {
          const body = ctx.validated as ValidatedReview;
          const decision = body.decision === 'approve' ? 'approve' : body.decision === 'reject' ? 'reject' : null;
          if (decision === null) {
            // Unreachable past the DTO pattern guard; kept fail-closed.
            throw new ForbiddenError('decision must be approve or reject');
          }
          const extension = await extensionOr404(ctx.params['extensionId'] ?? '');
          const scope = await resolveScope(ctx.params);
          const policy = await declarePermissionReview({
            scope,
            extension,
            decision,
            reason: body.reason,
            actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
          });
          return { policy, extension, decision };
        },
        emit: async (ctx) => {
          logger.info('extension-portal.permission_reviewed', undefined, {
            extension_id: ctx.result.extension.extensionId,
            extension_key: ctx.result.extension.manifest.extensionKey,
            version: ctx.result.extension.manifest.version,
            decision: ctx.result.decision,
            policy_id: ctx.result.policy.policyId,
            scope_kind: ctx.result.policy.scopeKind,
            correlation_id: currentCorrelation().correlationId,
          });
          await recordMutationAudit(modules, ctx.principal, ctx.owner, {
            action: 'extension_portal.permission_reviewed',
            targetType: 'extension_version',
            targetId: ctx.result.extension.extensionId,
            idempotencyKey: `extension_portal.permission_reviewed:${ctx.result.policy.policyId}`,
            details: {
              decision: ctx.result.decision,
              policyId: ctx.result.policy.policyId,
              scopeKind: ctx.result.policy.scopeKind,
              extensionKey: ctx.result.extension.manifest.extensionKey,
              version: ctx.result.extension.manifest.version,
            },
          });
        },
        respond: (ctx) =>
          jsonResponse(201, {
            review: {
              decision: ctx.result.decision,
              extensionId: ctx.result.extension.extensionId,
              extensionKey: ctx.result.extension.manifest.extensionKey,
              version: ctx.result.extension.manifest.version,
              scopeKind: ctx.result.policy.scopeKind,
              policyId: ctx.result.policy.policyId,
              versionSeq: ctx.result.policy.versionSeq,
            },
            policy: serializePolicyVersion(ctx.result.policy),
            // HONEST DISCLOSURE: the review is a delegated /policies
            // declaration — the surface never evaluates permissions; the
            // /extensions authority's install/invoke gates enforce this
            // review fail-closed at use time.
            enforcement:
              'delegated: the /extensions authority install/invoke gates evaluate this review through the /policies engine (fail-closed)',
          }),
      }),
    );
  }

  // -------------------------------------------------------------------------
  // DEVELOPER surface — publication
  // -------------------------------------------------------------------------

  // POST /api/extension-portal/versions — publish one immutable extension
  // version (the DEVELOPER posture: the frozen platform_developer role or
  // the platform administrator). Delegates to registerExtensionVersion:
  // the manifest guard runs at the AUTHORITY (EXT-AC-01); re-registration
  // of the same (publisher, key, version) is the authority's 409; a new
  // version is a new registry row.
  router.add(
    'POST',
    '/api/extension-portal/versions',
    defineMutationRoute<Record<string, string>, ExtensionRegistryRecord>({
      authenticator: services.auth,
      resolveOwner: async () => ({ kind: 'platform' }),
      authorize: async (ctx) => {
        await requireDeveloperRole(ctx.principal);
      },
      validate: (ctx) => validateObject<ValidatedRegistration>(ctx.request.body, manifestSpec()),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedRegistration;
        return modules.extensions.registerExtensionVersion({
          manifest: deserializeManifest(body.manifest),
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
          idempotencyKey: body.idempotencyKey,
        });
      },
      emit: async (ctx) => {
        logger.info('extension-portal.version.published', undefined, {
          extension_id: ctx.result.extensionId,
          extension_key: ctx.result.manifest.extensionKey,
          publisher: ctx.result.manifest.publisher,
          version: ctx.result.manifest.version,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'extension_portal.version.published',
          targetType: 'extension_version',
          targetId: ctx.result.extensionId,
          idempotencyKey: `extension_portal.version.published:${ctx.result.extensionId}`,
          details: {
            extensionKey: ctx.result.manifest.extensionKey,
            publisher: ctx.result.manifest.publisher,
            version: ctx.result.manifest.version,
            runtimeClass: ctx.result.manifest.runtimeClass,
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeExtension(ctx.result)),
    }),
  );

  // GET /api/extension-portal/catalog — the developer catalog: the distinct
  // extension keys of the /extensions authority's global registry with
  // their version counts and the newest version's compatibility range and
  // permission summary (a presentation grouping over the authoritative
  // listing — any active member).
  router.add(
    'GET',
    '/api/extension-portal/catalog',
    defineQueryRoute<Record<string, string>, readonly ExtensionRegistryRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        if (ctx.principal.kind === 'service') return;
        const context = await resolveContext(modules, ctx.principal);
        if (context === null || context.principal.status !== 'active') {
          throw new ForbiddenError('Active user identity required');
        }
      },
      execute: async () => modules.extensions.listExtensionVersions({ extensionKey: null }),
      respond: (ctx) => {
        // Presentation-only grouping over the authority's listing.
        const byKey = new Map<string, { versions: ExtensionRegistryRecord[] }>();
        for (const record of ctx.result) {
          const entry = byKey.get(record.manifest.extensionKey) ?? { versions: [] };
          entry.versions.push(record);
          byKey.set(record.manifest.extensionKey, entry);
        }
        const entries = [...byKey.entries()].map(([extensionKey, entry]) => {
          const newest = entry.versions[0]!;
          return {
            extensionKey,
            publisher: newest.manifest.publisher,
            versionCount: entry.versions.length,
            newestVersion: newest.manifest.version,
            compatibility: newest.manifest.compatibility,
            permissionActions: [...new Set(newest.manifest.permissions.map((permission) => permission.action))].sort(),
            dataScopes: newest.manifest.dataScopes,
            runtimeClass: newest.manifest.runtimeClass,
            newestExtensionId: newest.extensionId,
          };
        });
        return jsonResponse(200, {
          // Honest window disclosure: the /extensions authority's bounded
          // newest-first listing, grouped presentation-only at the route.
          listing: 'extensions-authority-bounded-newest-first-listing',
          extensions: entries,
        });
      },
    }),
  );

  // GET /api/extension-portal/extensions/:extensionKey/versions — the
  // VERSION HISTORY + compatibility records of one extension key. Delegates
  // to the authority's key-narrowed listing (listExtensionVersions) — the
  // module contract has always supported the filter; the direct MKT-022
  // route family lists the whole catalog, the portal surfaces the
  // per-extension history view.
  router.add(
    'GET',
    '/api/extension-portal/extensions/:extensionKey/versions',
    defineQueryRoute<{ extensionKey: string }, readonly ExtensionRegistryRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        if (ctx.principal.kind === 'service') return;
        const context = await resolveContext(modules, ctx.principal);
        if (context === null || context.principal.status !== 'active') {
          throw new ForbiddenError('Active user identity required');
        }
      },
      execute: async (ctx) => {
        if (!EXTENSION_KEY_PATTERN.test(ctx.params.extensionKey)) {
          // A malformed key is indistinguishable from an unknown one.
          throw new NotFoundError('extension key', ctx.params.extensionKey);
        }
        return modules.extensions.listExtensionVersions({ extensionKey: ctx.params.extensionKey });
      },
      respond: (ctx) =>
        jsonResponse(200, {
          extensionKey: ctx.params.extensionKey,
          listing: 'extensions-authority-bounded-newest-first-listing',
          versions: ctx.result.map((record) => ({
            extensionId: record.extensionId,
            version: record.manifest.version,
            compatibility: record.manifest.compatibility,
            permissions: record.manifest.permissions,
            dataScopes: record.manifest.dataScopes,
            runtimeClass: record.manifest.runtimeClass,
            createdAt: record.createdAt,
          })),
        }),
    }),
  );

  // GET /api/extension-portal/versions/:extensionId — one published version
  // (the manifest + compatibility record; any active member).
  router.add(
    'GET',
    '/api/extension-portal/versions/:extensionId',
    defineQueryRoute<{ extensionId: string }, ExtensionRegistryRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        if (ctx.principal.kind === 'service') return;
        const context = await resolveContext(modules, ctx.principal);
        if (context === null || context.principal.status !== 'active') {
          throw new ForbiddenError('Active user identity required');
        }
      },
      execute: async (ctx) => extensionOr404(ctx.params.extensionId),
      respond: (ctx) => jsonResponse(200, serializeExtension(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // DEVELOPER surface — the TESTING hook (a thin pass-through to the
  // authority's invocation contract; NEVER a second execution engine)
  // -------------------------------------------------------------------------

  // POST /api/extension-portal/executions/:executionId/extensions/:extensionId/test
  // — derive the short-lived invocation context for a LIVE extension-kind
  // Execution: the EXACT authority operation the direct MKT-022 invocation
  // route exposes (beginExtensionInvocation), surfaced version-first for
  // the developer test flow. The execution must exist and be live; the
  // version must be installed AND authorized in the execution's workspace
  // (the authority resolves all of this from durable state — the test hook
  // is NOT a bypass; it rides the full fail-closed pipeline including the
  // extension-dimension 'invoke' policy gate).
  router.add(
    'POST',
    '/api/extension-portal/executions/:executionId/extensions/:extensionId/test',
    defineMutationRoute<{ executionId: string; extensionId: string }, ExtensionInvocationContext>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        if (!UUID_PATTERN.test(params.executionId)) {
          throw new NotFoundError('execution', params.executionId);
        }
        const ownership = await modules.executions.resolveExecutionOwnership(params.executionId);
        if (ownership === null) {
          throw new NotFoundError('execution', params.executionId);
        }
        return {
          kind: 'execution',
          agencyId: ownership.scope.agencyId,
          clientId: ownership.scope.clientId,
          workspaceId: ownership.scope.workspaceId,
          executionId: ownership.scope.executionId,
        };
      },
      authorize: async (ctx) => {
        await requireExecutionAccess(modules, ctx.principal, ctx.params.executionId);
      },
      validate: (ctx) =>
        validateObject<{
          requestedCapabilities: readonly string[];
          input: Record<string, unknown>;
        }>(ctx.request.body, {
          forbiddenKeys: PORTAL_TEST_AUTHORITY_FIELDS,
          fields: {
            requestedCapabilities: arrayField({
              minItems: 1,
              maxItems: 32,
              item: stringField({ pattern: CAPABILITY_NAME_PATTERN }),
            }),
            // The invocation INPUT payload is free-form EXCEPT the
            // authority/material-shaped keys (the module guard additionally
            // rejects material keys at every nesting level).
            input: recordField({
              forbiddenKeys: PORTAL_TEST_INPUT_FORBIDDEN_KEYS,
            }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as {
          requestedCapabilities: readonly string[];
          input: Record<string, unknown>;
        };
        return modules.extensions.beginExtensionInvocation(
          {
            executionId: ctx.params.executionId,
            extensionId: ctx.params.extensionId,
            requestedCapabilities: body.requestedCapabilities,
            input: body.input,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('extension-portal.version.tested', undefined, {
          execution_id: ctx.result.executionId,
          invocation_id: ctx.result.invocationId,
          extension_id: ctx.result.extensionId,
          extension_key: ctx.result.extensionKey,
          policy_decision_id: ctx.result.policyDecisionId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'extension_portal.version.tested',
          targetType: 'extension_invocation',
          targetId: ctx.result.invocationId,
          details: {
            extensionId: ctx.result.extensionId,
            extensionKey: ctx.result.extensionKey,
            version: ctx.result.version,
            executionId: ctx.result.executionId,
            policyDecisionId: ctx.result.policyDecisionId,
            grantedDataScopes: [...ctx.result.grantedDataScopes].sort().join(','),
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(201, {
          invocationId: ctx.result.invocationId,
          extensionId: ctx.result.extensionId,
          extensionKey: ctx.result.extensionKey,
          version: ctx.result.version,
          installId: ctx.result.installId,
          executionId: ctx.result.executionId,
          scope: ctx.result.scope,
          grantedCapabilities: ctx.result.grantedCapabilities,
          grantedDataScopes: ctx.result.grantedDataScopes,
          policyDecisionId: ctx.result.policyDecisionId,
          policyOutcome: 'allow',
          runtimeClass: ctx.result.runtimeClass,
          input: ctx.result.input,
          provenance: ctx.result.provenance,
          issuedAt: ctx.result.issuedAt,
          expiresAt: ctx.result.expiresAt,
          // The honest lifetime statement (server-derived, not a request field).
          expired: isInvocationContextExpired(
            { expiresAt: ctx.result.expiresAt },
            new Date().toISOString(),
          ),
          // HONEST DISCLOSURE: the test hook is the authority's invocation
          // path itself — it derives the context (never a credential) from
          // the execution's canonical owner and the authorized install; it
          // is NOT a second execution engine and NOT a policy bypass.
          testingHook:
            'delegated: beginExtensionInvocation on the /extensions authority (the short-lived context; no execution engine)',
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // PERMISSION REVIEW surface — the review view (read composition)
  // -------------------------------------------------------------------------

  // GET /api/extension-portal/workspaces/:workspaceId/versions/:extensionId/permission-review
  // — the review view for the workspace's scope chain: the version's
  // frozen permission claims, the active extension-dimension policy
  // versions (platform visibility is platform-admin-only — the security
  // configuration surface posture), which active rules REFERENCE this
  // version (a factual reference annotation, NOT an evaluation), the
  // recorded extension-dimension decisions that touched this extension
  // (the authoritative evaluated outcomes), and the append-oriented review
  // history. The surface NEVER derives an allow/deny verdict.
  router.add(
    'GET',
    '/api/extension-portal/workspaces/:workspaceId/versions/:extensionId/permission-review',
    defineQueryRoute<
      { workspaceId: string; extensionId: string },
      {
        extension: ExtensionRegistryRecord;
        platformPolicy: PolicyVersionRecord | null;
        agencyPolicy: PolicyVersionRecord | null;
        clientPolicy: PolicyVersionRecord | null;
        reviewHistory: readonly PolicyVersionRecord[];
        decisions: readonly PolicyDecisionRecord[];
        platformVisible: boolean;
      }
    >({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
      },
      execute: async (ctx) => {
        const extension = await extensionOr404(ctx.params.extensionId);
        const ownership = await modules.workspaces.resolveWorkspaceOwnership(ctx.params.workspaceId);
        if (ownership === null) {
          throw new NotFoundError('workspace', ctx.params.workspaceId);
        }
        const { agencyId, clientId } = ownership.scope;
        const platformVisible = await isPlatformAdmin(ctx.principal);
        const platformPolicy = platformVisible
          ? await modules.policies.getActivePolicyVersion({
              scope: { agencyId: null, clientId: null },
              dimension: 'extension',
            })
          : null;
        const agencyPolicy = await modules.policies.getActivePolicyVersion({
          scope: { agencyId, clientId: null },
          dimension: 'extension',
        });
        const clientPolicy = await modules.policies.getActivePolicyVersion({
          scope: { agencyId, clientId },
          dimension: 'extension',
        });
        const reviewHistory = (
          await modules.policies.listPolicyVersions({
            scope: { agencyId, clientId: null },
            dimension: 'extension',
            includeSuperseded: true,
          })
        ).concat(
          await modules.policies.listPolicyVersions({
            scope: { agencyId, clientId },
            dimension: 'extension',
            includeSuperseded: true,
          }),
        );
        // The recorded decisions of this scope — BOTH the agency-wide
        // ledger (client_id null) and the client-narrowed ledger (the
        // install/invoke gates record at the action's client scope),
        // newest first, filtered presentation-only to the extension
        // dimension + THIS extension's resource.
        const recorded = (
          await modules.policies.listPolicyDecisions({ agencyId, clientId: null })
        ).concat(await modules.policies.listPolicyDecisions({ agencyId, clientId }));
        const decisions = recorded.filter(
          (decision) =>
            decision.dimension === 'extension' &&
            decision.action.resource === extension.manifest.extensionKey,
        );
        return {
          extension,
          platformPolicy,
          agencyPolicy,
          clientPolicy,
          reviewHistory,
          decisions,
          platformVisible,
        };
      },
      respond: (ctx) => {
        const { extension, platformPolicy, agencyPolicy, clientPolicy, reviewHistory, decisions, platformVisible } = ctx.result;
        /** Factual reference annotation (NOT a permission evaluation). */
        const referencing = (policy: PolicyVersionRecord | null) =>
          policy === null
            ? []
            : policy.rules
                .map((rule, index) => ({ rule, index }))
                .filter(({ rule }) => ruleReviewsVersion(rule, extension))
                .map(({ index }) => index);
        return jsonResponse(200, {
          extension: {
            extensionId: extension.extensionId,
            extensionKey: extension.manifest.extensionKey,
            publisher: extension.manifest.publisher,
            version: extension.manifest.version,
          },
          // The FROZEN permission claims under review (immutable manifest
          // content — the closed §5 vocabulary; the authority rejected
          // anything else at publication).
          permissionClaims: {
            permissions: extension.manifest.permissions,
            permissionActions: [...new Set(extension.manifest.permissions.map((permission) => permission.action))].sort(),
            requiredSecretNames: extension.manifest.requiredSecretNames,
            dataScopes: extension.manifest.dataScopes,
            networkRequirements: extension.manifest.networkRequirements,
            runtimeClass: extension.manifest.runtimeClass,
            vocabularyNote:
              'closed vocabulary: data:read|data:write|network:egress|secret:use — workflow-state mutation, credential creation, evidence-provenance fabrication and audit disabling are not declarable permissions',
          },
          // The review/approval state the install/invoke gates honor.
          approvalState: {
            platform: platformVisible
              ? platformPolicy === null
                ? { declared: false }
                : {
                    declared: true,
                    policy: serializePolicyVersion(platformPolicy),
                    rulesReferencingThisVersion: referencing(platformPolicy),
                  }
              : {
                  declared: null,
                  visibility: 'platform-administrator-only (the platform security-configuration surface)',
                },
            agency:
              agencyPolicy === null
                ? { declared: false }
                : {
                    declared: true,
                    policy: serializePolicyVersion(agencyPolicy),
                    rulesReferencingThisVersion: referencing(agencyPolicy),
                  },
            client:
              clientPolicy === null
                ? { declared: false }
                : {
                    declared: true,
                    policy: serializePolicyVersion(clientPolicy),
                    rulesReferencingThisVersion: referencing(clientPolicy),
                  },
          },
          // The recorded AUTHORITY outcomes (install/invoke attempts on
          // this extension at this agency) — the evaluated history, not a
          // surface verdict.
          recordedDecisions: decisions.map(serializeDecision),
          decisionLedgerWindow:
            'policies-authority-bounded-newest-first-listing (agency-wide, filtered presentation-only to this extension)',
          // The append-oriented review history (superseded policy versions
          // stay queryable forever — every review is preserved).
          reviewHistory: reviewHistory.map(serializePolicyVersion),
          // HONEST DISCLOSURE: this view never evaluates permissions.
          evaluationNote:
            'this surface displays review state and recorded decisions only; rule matching and deny-overrides composition happen exclusively in the /policies engine, enforced fail-closed at the /extensions authority install/invoke gates',
        });
      },
    }),
  );

  // -------------------------------------------------------------------------
  // PERMISSION REVIEW surface — the reviewer actions (delegated calls)
  // -------------------------------------------------------------------------

  // PLATFORM-scoped review (platform administrator only — the platform
  // security-configuration posture of POST /api/policies).
  reviewRoute(
    '/api/extension-portal/versions/:extensionId/permission-review',
    async () => ({ kind: 'platform' }),
    async (principal) => {
      await requirePlatformAdministrator(modules, principal);
    },
    async () => ({ agencyId: null, clientId: null }),
  );

  // AGENCY-scoped review (owner|admin of the agency | platform admin).
  reviewRoute(
    '/api/extension-portal/agencies/:agencyId/versions/:extensionId/permission-review',
    async (params) => agencyOwner(params['agencyId'] ?? ''),
    async (principal, params) => {
      await requireAgencyAccess(modules, principal, params['agencyId'] ?? '', [
        'agency_owner',
        'agency_admin',
      ]);
    },
    async (params) => ({ agencyId: params['agencyId'] ?? null, clientId: null }),
  );

  // CLIENT-scoped review (owner|admin of the OWNING agency | platform
  // admin; the canonical Client ownership resolves from durable state —
  // uniform 404 for foreign/unknown clients).
  reviewRoute(
    '/api/extension-portal/clients/:clientId/versions/:extensionId/permission-review',
    async (params) => clientOwner(params['clientId'] ?? ''),
    async (principal, params) => {
      await requireClientAccess(modules, principal, params['clientId'] ?? '', [
        'agency_owner',
        'agency_admin',
      ]);
    },
    async (params) => {
      const ownership = await modules.clients.resolveClientOwnership(params['clientId'] ?? '');
      if (ownership === null) {
        throw new NotFoundError('client', params['clientId'] ?? '');
      }
      return { agencyId: ownership.client.agencyId, clientId: ownership.client.clientId };
    },
  );

  // -------------------------------------------------------------------------
  // INSTALLATION surface — install/configure/lifecycle (workspace-scoped,
  // converging with the direct MKT-022 install family exactly like the
  // MKT-031 work-queue routes converge with the direct /jobs surface)
  // -------------------------------------------------------------------------

  // POST /api/extension-portal/workspaces/:workspaceId/installs — install a
  // published version. The scope is SERVER-DERIVED from the canonical
  // workspace ownership; the authority's fail-closed install policy gate
  // runs INSIDE installExtension (an unreviewed/unapproved version is
  // denied at the AUTHORITY — the surface cannot work around it).
  router.add(
    'POST',
    '/api/extension-portal/workspaces/:workspaceId/installs',
    defineMutationRoute<{ workspaceId: string }, { install: ExtensionInstallRecord; replayed: boolean }>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => workspaceOwner(params.workspaceId),
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ extensionId: string; grantedScopes: readonly string[]; idempotencyKey: string }>(
          ctx.request.body,
          {
            forbiddenKeys: PORTAL_INSTALL_AUTHORITY_FIELDS,
            fields: {
              extensionId: stringField({ pattern: UUID_PATTERN }),
              grantedScopes: arrayField({
                minItems: 0,
                maxItems: 8,
                item: stringField({ pattern: SCOPE_PATTERN }),
              }),
              idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
            },
          },
        ),
      execute: async (ctx) => {
        const body = ctx.validated as { extensionId: string; grantedScopes: readonly string[]; idempotencyKey: string };
        const owner = ctx.owner;
        if (owner.kind !== 'workspace') {
          throw new NotFoundError('workspace', ctx.params.workspaceId);
        }
        return modules.extensions.installExtension(
          {
            scope: {
              agencyId: owner.agencyId,
              clientId: owner.clientId,
              workspaceId: owner.workspaceId,
            },
            extensionId: body.extensionId,
            grantedScopes: body.grantedScopes as ExtensionInstallRecord['grantedScopes'],
            idempotencyKey: body.idempotencyKey,
            actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('extension-portal.installed', undefined, {
          workspace_id: ctx.params.workspaceId,
          install_id: ctx.result.install.installId,
          extension_id: ctx.result.install.extensionId,
          status: ctx.result.install.status,
          replayed: ctx.result.replayed,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'extension_portal.installed',
          targetType: 'extension_install',
          targetId: ctx.result.install.installId,
          afterVersion: ctx.result.install.version,
          idempotencyKey: `extension_portal.installed:${ctx.result.install.installId}`,
          details: {
            extensionId: ctx.result.install.extensionId,
            workspaceId: ctx.result.install.workspaceId,
            status: ctx.result.install.status,
            grantedScopes: [...ctx.result.install.grantedScopes].sort().join(','),
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(ctx.result.replayed ? 200 : 201, {
          install: serializeInstall(ctx.result.install),
          replayed: ctx.result.replayed,
        }),
    }),
  );

  // GET /api/extension-portal/workspaces/:workspaceId/installs — the
  // workspace's installs in EVERY state (terminal history stays visible).
  router.add(
    'GET',
    '/api/extension-portal/workspaces/:workspaceId/installs',
    defineQueryRoute<{ workspaceId: string }, readonly ExtensionInstallRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
      },
      execute: async (ctx) => modules.extensions.listExtensionInstalls(ctx.params.workspaceId),
      respond: (ctx) =>
        jsonResponse(200, {
          workspaceId: ctx.params.workspaceId,
          installs: ctx.result.map(serializeInstall),
        }),
    }),
  );

  // POST .../configure — validate + store configuration values against the
  // manifest's declared config contract, binding every required secret
  // LOGICAL NAME to a credential REFERENCE (never material).
  router.add(
    'POST',
    '/api/extension-portal/workspaces/:workspaceId/installs/:installId/configure',
    defineMutationRoute<{ workspaceId: string; installId: string }, ExtensionInstallRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => installOwner(params.workspaceId, params.installId),
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ config: Record<string, unknown>; secretBindings: Record<string, unknown>; expectedVersion: number }>(
          ctx.request.body,
          {
            forbiddenKeys: PORTAL_CONFIGURE_AUTHORITY_FIELDS,
            fields: {
              config: recordField({ maxDepthKeys: 32 }),
              secretBindings: recordField({ maxDepthKeys: 16 }),
              expectedVersion: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
            },
          },
        ),
      execute: async (ctx) => {
        const body = ctx.validated as {
          config: Record<string, unknown>;
          secretBindings: Record<string, unknown>;
          expectedVersion: number;
        };
        const secretBindings: Record<string, string> = {};
        for (const [name, reference] of Object.entries(body.secretBindings)) {
          if (typeof reference !== 'string' || !CREDENTIAL_REF_PATTERN.test(reference)) {
            throw new NotFoundError('credential reference', String(reference));
          }
          secretBindings[name] = reference;
        }
        return modules.extensions.configureExtension({
          installId: ctx.params.installId,
          config: body.config,
          secretBindings,
          expectedVersion: body.expectedVersion,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('extension-portal.configured', undefined, {
          workspace_id: ctx.params.workspaceId,
          install_id: ctx.result.installId,
          status: ctx.result.status,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'extension_portal.configured',
          targetType: 'extension_install',
          targetId: ctx.result.installId,
          afterVersion: ctx.result.version,
          details: {
            status: ctx.result.status,
            boundSecretNames: Object.keys(ctx.result.secretBindings).sort().join(','),
          },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeInstall(ctx.result)),
    }),
  );

  /**
   * The shared CAS lifecycle-edge route (authorize / disable / uninstall —
   * every edge is the authority's frozen transition table; "enable" is the
   * disabled → authorized edge the authority exposes).
   */
  function statusEdgeRoute(
    path: string,
    status: 'authorized' | 'disabled' | 'uninstalled',
    action: string,
  ): void {
    router.add(
      'POST',
      path,
      defineMutationRoute<{ workspaceId: string; installId: string }, ExtensionInstallRecord>({
        authenticator: services.auth,
        resolveOwner: async (_ctx, params) => installOwner(params.workspaceId, params.installId),
        authorize: async (ctx) => {
          await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId, [
            'agency_owner',
            'agency_admin',
          ]);
        },
        validate: (ctx) =>
          validateObject<{ expectedVersion: number }>(ctx.request.body, {
            forbiddenKeys: PORTAL_STATUS_AUTHORITY_FIELDS,
            fields: {
              expectedVersion: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
            },
          }),
        execute: async (ctx) => {
          const body = ctx.validated as { expectedVersion: number };
          return modules.extensions.setExtensionInstallStatus({
            installId: ctx.params.installId,
            status,
            expectedVersion: body.expectedVersion,
            actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
          });
        },
        emit: async (ctx) => {
          logger.info(`extension-portal.install.${action}`, undefined, {
            install_id: ctx.result.installId,
            status: ctx.result.status,
            correlation_id: currentCorrelation().correlationId,
          });
          await recordMutationAudit(modules, ctx.principal, ctx.owner, {
            action: `extension_portal.install.${action}`,
            targetType: 'extension_install',
            targetId: ctx.result.installId,
            afterVersion: ctx.result.version,
            details: { status: ctx.result.status },
          });
        },
        respond: (ctx) => jsonResponse(200, serializeInstall(ctx.result)),
      }),
    );
  }

  statusEdgeRoute(
    '/api/extension-portal/workspaces/:workspaceId/installs/:installId/authorize',
    'authorized',
    'authorized',
  );
  statusEdgeRoute(
    '/api/extension-portal/workspaces/:workspaceId/installs/:installId/disable',
    'disabled',
    'disabled',
  );
  statusEdgeRoute(
    '/api/extension-portal/workspaces/:workspaceId/installs/:installId/uninstall',
    'uninstalled',
    'uninstalled',
  );

  // -------------------------------------------------------------------------
  // VERSION MANAGEMENT — the workspace view + the upgrade operation
  // -------------------------------------------------------------------------

  // GET /api/extension-portal/workspaces/:workspaceId/extensions/:extensionKey/versions
  // — the VERSION-MANAGEMENT view: every published version of the key (the
  // registry history), which version each of the workspace's installs of
  // this key is PINNED to (structural: an install references an immutable
  // version and never changes it), and which published versions are not
  // yet installed (the upgrade candidates). Read-only composition over
  // the authority's listings.
  router.add(
    'GET',
    '/api/extension-portal/workspaces/:workspaceId/extensions/:extensionKey/versions',
    defineQueryRoute<
      { workspaceId: string; extensionKey: string },
      {
        versions: readonly ExtensionRegistryRecord[];
        installs: readonly { install: ExtensionInstallRecord; extension: ExtensionRegistryRecord }[];
      }
    >({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
      },
      execute: async (ctx) => {
        if (!EXTENSION_KEY_PATTERN.test(ctx.params.extensionKey)) {
          throw new NotFoundError('extension key', ctx.params.extensionKey);
        }
        const versions = await modules.extensions.listExtensionVersions({
          extensionKey: ctx.params.extensionKey,
        });
        const workspaceInstalls = await modules.extensions.listExtensionInstalls(ctx.params.workspaceId);
        const installs: { install: ExtensionInstallRecord; extension: ExtensionRegistryRecord }[] = [];
        for (const install of workspaceInstalls) {
          const extension = await modules.extensions.getExtensionVersion(install.extensionId);
          if (extension === null || extension.manifest.extensionKey !== ctx.params.extensionKey) {
            continue;
          }
          installs.push({ install, extension });
        }
        return { versions, installs };
      },
      respond: (ctx) => {
        const { versions, installs } = ctx.result;
        const installedIds = new Set(installs.map(({ install }) => install.extensionId));
        return jsonResponse(200, {
          workspaceId: ctx.params.workspaceId,
          extensionKey: ctx.params.extensionKey,
          publishedVersions: versions.map((record) => ({
            extensionId: record.extensionId,
            version: record.manifest.version,
            compatibility: record.manifest.compatibility,
            createdAt: record.createdAt,
            installedInWorkspace: installedIds.has(record.extensionId),
          })),
          installedVersions: installs.map(({ install, extension }) => ({
            installId: install.installId,
            extensionId: install.extensionId,
            version: extension.manifest.version,
            status: install.status,
            pinned: true,
            grantedScopes: install.grantedScopes,
            rowVersion: install.version,
            createdAt: install.createdAt,
            updatedAt: install.updatedAt,
          })),
          // HONEST DISCLOSURES: pinning is structural (the install row's
          // immutable version reference — there is no auto-upgrade to
          // prevent); the upgrade path is the explicit install of another
          // published version.
          versioningNote:
            'an install references an immutable registry version and never changes it (pinning is structural); upgrading installs another published version alongside and retires the prior install through its own uninstall edge',
          listing: 'extensions-authority-bounded-newest-first-listing',
        });
      },
    }),
  );

  // POST /api/extension-portal/workspaces/:workspaceId/extensions/:extensionKey/upgrade
  // — the UPGRADE operation: install the target published version of the
  // extension key into the workspace (ONE delegated authority call through
  // the full fail-closed install pipeline — the permission review must
  // approve the TARGET version or the authority denies), optionally
  // retiring the prior install (a SECOND delegated uninstall call —
  // disclosed as non-atomic surface-level orchestration; every mutation is
  // the authority's own gated operation, in order, with independent audit).
  router.add(
    'POST',
    '/api/extension-portal/workspaces/:workspaceId/extensions/:extensionKey/upgrade',
    defineMutationRoute<
      { workspaceId: string; extensionKey: string },
      {
        target: ExtensionInstallRecord;
        replayed: boolean;
        prior: ExtensionInstallRecord | null;
        priorRetired: boolean;
        priorRetireError: string | null;
      }
    >({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => workspaceOwner(params.workspaceId),
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{
          targetExtensionId: string;
          grantedScopes: readonly string[];
          idempotencyKey: string;
          retirePriorVersion: string | undefined;
        }>(ctx.request.body, {
          forbiddenKeys: PORTAL_INSTALL_AUTHORITY_FIELDS,
          fields: {
            targetExtensionId: stringField({ pattern: UUID_PATTERN }),
            grantedScopes: arrayField({
              minItems: 0,
              maxItems: 8,
              item: stringField({ pattern: SCOPE_PATTERN }),
            }),
            idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
            retirePriorVersion: optionalString({ pattern: /^(true|false)$/ }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as {
          targetExtensionId: string;
          grantedScopes: readonly string[];
          idempotencyKey: string;
          retirePriorVersion: string | undefined;
        };
        if (!EXTENSION_KEY_PATTERN.test(ctx.params.extensionKey)) {
          throw new NotFoundError('extension key', ctx.params.extensionKey);
        }
        const owner = ctx.owner;
        if (owner.kind !== 'workspace') {
          throw new NotFoundError('workspace', ctx.params.workspaceId);
        }
        // The target must be a published version OF THIS extension key
        // (resolved from durable registry state — uniform 404 otherwise).
        const target = await extensionOr404(body.targetExtensionId);
        if (target.manifest.extensionKey !== ctx.params.extensionKey) {
          throw new NotFoundError('extension version', body.targetExtensionId);
        }
        // The prior live install of this key in the workspace (resolved
        // from durable state; the target version itself never qualifies —
        // an upgrade targets a DIFFERENT version by definition).
        const workspaceInstalls = await modules.extensions.listExtensionInstalls(owner.workspaceId);
        let prior: ExtensionInstallRecord | null = null;
        for (const install of workspaceInstalls) {
          if (install.extensionId === target.extensionId) continue;
          const extension = await modules.extensions.getExtensionVersion(install.extensionId);
          if (extension === null || extension.manifest.extensionKey !== ctx.params.extensionKey) continue;
          if (install.status === 'uninstalled') continue;
          if (prior === null || install.createdAt > prior.createdAt) {
            prior = install;
          }
        }
        // Delegated call #1: the authority's gated install of the target.
        const installed = await modules.extensions.installExtension(
          {
            scope: {
              agencyId: owner.agencyId,
              clientId: owner.clientId,
              workspaceId: owner.workspaceId,
            },
            extensionId: target.extensionId,
            grantedScopes: body.grantedScopes as ExtensionInstallRecord['grantedScopes'],
            idempotencyKey: body.idempotencyKey,
            actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
          },
          serverProvenance(ctx.principal),
        );
        // Delegated call #2 (optional): retire the prior install through
        // its own uninstall edge. Non-atomic by disclosure: a failure here
        // leaves BOTH installs live (the surface reports it honestly; the
        // caller can drive the uninstall edge directly).
        let priorRetired = false;
        let priorRetireError: string | null = null;
        if (body.retirePriorVersion === 'true' && prior !== null) {
          try {
            await modules.extensions.setExtensionInstallStatus({
              installId: prior.installId,
              status: 'uninstalled',
              expectedVersion: prior.version,
              actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
            });
            priorRetired = true;
          } catch (error) {
            priorRetired = false;
            priorRetireError =
              error instanceof Error ? error.message : 'the prior install could not be retired';
          }
        }
        return {
          target: installed.install,
          replayed: installed.replayed,
          prior,
          priorRetired,
          priorRetireError,
        };
      },
      emit: async (ctx) => {
        logger.info('extension-portal.upgraded', undefined, {
          workspace_id: ctx.params.workspaceId,
          extension_key: ctx.params.extensionKey,
          install_id: ctx.result.target.installId,
          prior_install_id: ctx.result.prior === null ? null : ctx.result.prior.installId,
          prior_retired: ctx.result.priorRetired,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'extension_portal.upgraded',
          targetType: 'extension_install',
          targetId: ctx.result.target.installId,
          afterVersion: ctx.result.target.version,
          idempotencyKey: `extension_portal.upgraded:${ctx.result.target.installId}`,
          details: {
            extensionKey: ctx.params.extensionKey,
            extensionId: ctx.result.target.extensionId,
            priorInstallId: ctx.result.prior === null ? null : ctx.result.prior.installId,
            priorRetired: ctx.result.priorRetired,
            priorRetireError: ctx.result.priorRetireError,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(ctx.result.replayed ? 200 : 201, {
          upgrade: {
            extensionKey: ctx.params.extensionKey,
            targetInstall: serializeInstall(ctx.result.target),
            replayed: ctx.result.replayed,
            priorInstall: ctx.result.prior === null ? null : serializeInstall(ctx.result.prior),
            priorRetired: ctx.result.priorRetired,
            ...(ctx.result.priorRetireError === null
              ? {}
              : { priorRetireError: ctx.result.priorRetireError }),
          },
          // HONEST DISCLOSURE: two delegated authority operations, in
          // order, each independently gated and audited — never atomic.
          orchestrationNote:
            'non-atomic surface orchestration of two delegated /extensions authority operations (install target, then optionally uninstall prior); every gate runs inside the authority',
        }),
    }),
  );
}
