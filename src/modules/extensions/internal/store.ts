/**
 * /extensions persistence + the frozen input guards (MKT-022, EXT-001).
 *
 * DB backstops (migration 028 + implementation-contract §21/§25):
 *   - the (publisher, extension_key, version) UNIQUE fence: a published
 *     version is IMMUTABLE — re-registration converges to a constraint
 *     violation (ConflictError upstream, never a silent rewrite) and a
 *     new version is a new row;
 *   - the registry row itself rejects UPDATE and DELETE (triggers);
 *   - the (workspace_id, extension_id) UNIQUE fence: one install per
 *     extension version per workspace — a duplicate logical install
 *     command converges;
 *   - install scope-chain fences (client ∈ agency, workspace ∈ client),
 *     install identity/scope/grant immutability and the frozen install
 *     lifecycle (born 'installed'; 'uninstalled' terminal);
 *   - the invocation ledger is APPEND-ONLY (UPDATE/DELETE rejected) with
 *     server-derived provenance columns and no request DTO path.
 *
 * The §21 material-key backstop runs at the module boundary (guards) AND
 * in the database (CHECK functions): no manifest, config value, secret
 * binding or invocation input can carry material-shaped keys, and there
 * is NO column capable of holding secret material or a secret handle.
 */

import { createHash } from 'node:crypto';
import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow, DbTransaction, QueryParam } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  ExtensionCapabilityDeclaration,
  ExtensionConfigFieldContract,
  ExtensionDataScope,
  ExtensionInstallRecord,
  ExtensionInstallStatus,
  ExtensionInvocationContext,
  ExtensionInvocationProvenance,
  ExtensionInvocationRecord,
  ExtensionManifest,
  ExtensionRegistryRecord,
} from '../public.ts';
import {
  EXTENSION_CAPABILITY_CATEGORIES,
  EXTENSION_DATA_SCOPES,
  EXTENSION_PERMISSION_ACTIONS,
} from '../public.ts';

// ---------------------------------------------------------------------------
// Bounds (single source of truth for every guard below)
// ---------------------------------------------------------------------------

const KEY_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;
const PUBLISHER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]{1,32})?$/;
const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{2,47}$/;
const CREDENTIAL_REF_PATTERN = /^[0-9a-zA-Z][0-9a-zA-Z._:-]{0,63}$/;
const LABEL_PATTERN = /^.{1,64}$/;

const MAX_CAPABILITIES = 32;
const MAX_PERMISSIONS = 64;
const MAX_SECRET_NAMES = 16;
const MAX_DATA_SCOPES = 8;
const MAX_NETWORK_REQUIREMENTS = 16;
const MAX_EVENT_SUBSCRIPTIONS = 32;
const MAX_UI_SURFACES = 32;
const MAX_CONFIG_FIELDS = 32;
const MAX_SECRET_BINDINGS = 16;
const MAX_REQUESTED_CAPABILITIES = 32;
const MAX_CONTRACT_JSON_BYTES = 16 * 1024;
const MAX_CONFIG_JSON_BYTES = 32 * 1024;
const MAX_INPUT_JSON_BYTES = 64 * 1024;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

/** Material-shaped keys that can never appear in ANY extension payload (§21). */
export const EXTENSION_MATERIAL_SHAPED_KEYS = [
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
 * Authority-shaped keys that can never appear in an invocation INPUT:
 * provenance/scope/decision fields are server-derived (implementation-
 * contract §3) — an extension invocation can never smuggle actor,
 * tenant-scope or policy-posture values, and evidence-provenance-shaped
 * keys are rejected too (EXT-AC-04: evidence references are created
 * through /evidence contracts only, with actor provenance server-derived
 * — the extension context cannot assert provenance fields).
 */
export const INVOCATION_INPUT_AUTHORITY_KEYS = [
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
] as const;

// ---------------------------------------------------------------------------
// Generic payload walking (the module-side §21 backstop)
// ---------------------------------------------------------------------------

/**
 * Rejects material-shaped keys at EVERY nesting level of an arbitrary
 * JSON value. Pure; used by every guard below (the database CHECK
 * functions of migration 028 enforce the identical set).
 */
export function payloadHasNoMaterialKeys(value: unknown, path = 'payload'): string[] {
  const problems: string[] = [];
  if (value === null || value === undefined) return problems;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      problems.push(...payloadHasNoMaterialKeys(item, `${path}[${index}]`));
    });
    return problems;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if ((EXTENSION_MATERIAL_SHAPED_KEYS as readonly string[]).includes(key)) {
        problems.push(`${path}.${key}: material-shaped keys are rejected (secrets never appear in extension payloads — §21)`);
      }
      problems.push(...payloadHasNoMaterialKeys(child, `${path}.${key}`));
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The manifest guard (EXT-AC-01 — the registration contract test)
// ---------------------------------------------------------------------------

function isStringArray(value: unknown, maxItems: number, pattern: RegExp, label: string): string[] {
  const problems: string[] = [];
  if (!Array.isArray(value)) {
    problems.push(`${label}: must be an array`);
    return problems;
  }
  if (value.length > maxItems) {
    problems.push(`${label}: at most ${maxItems} entries`);
  }
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !pattern.test(item)) {
      problems.push(`${label}: entry '${String(item)}' does not match the required format`);
    } else if (seen.has(item)) {
      problems.push(`${label}: duplicate entry '${item}'`);
    }
    if (typeof item === 'string') seen.add(item);
  }
  return problems;
}

/**
 * THE manifest shape guard (spec/extension-model.md §2 + §3 + §5; §21
 * material-key backstop). A manifest that fails shape — unknown
 * capability category, non-least-privilege permission action, secret
 * VALUES instead of logical names, undeclared data-scope vocabulary —
 * is REJECTED (EXT-AC-01: "extension manifest declares capabilities and
 * permissions — contract test"). Pure.
 */
export function assertValidExtensionManifest(manifest: ExtensionManifest): void {
  const problems: string[] = [];

  if (manifest === null || typeof manifest !== 'object') {
    throw new InvalidRequestError('extension manifest must be an object');
  }
  if (typeof manifest.extensionKey !== 'string' || !KEY_PATTERN.test(manifest.extensionKey)) {
    problems.push('extensionKey: must be 2-63 chars, lowercase letters/digits/dashes, starting with a letter');
  }
  if (typeof manifest.publisher !== 'string' || !PUBLISHER_PATTERN.test(manifest.publisher)) {
    problems.push('publisher: must be 1-64 chars, lowercase letters/digits/dots/dashes/underscores');
  }
  if (typeof manifest.version !== 'string' || !VERSION_PATTERN.test(manifest.version)) {
    problems.push('version: must be a semver-style label X.Y.Z(-prerelease)');
  }

  if (
    manifest.compatibility === null ||
    typeof manifest.compatibility !== 'object' ||
    typeof manifest.compatibility.minPlatform !== 'string' ||
    manifest.compatibility.minPlatform.length < 1 ||
    manifest.compatibility.minPlatform.length > 32 ||
    typeof manifest.compatibility.maxPlatform !== 'string' ||
    manifest.compatibility.maxPlatform.length < 1 ||
    manifest.compatibility.maxPlatform.length > 32
  ) {
    problems.push('compatibility: { minPlatform, maxPlatform } are required bounded platform version labels');
  }

  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) {
    problems.push('capabilities: a manifest must declare at least one capability (extension-model.md §2/§3)');
  } else if (manifest.capabilities.length > MAX_CAPABILITIES) {
    problems.push(`capabilities: at most ${MAX_CAPABILITIES} capabilities per manifest`);
  } else {
    const names = new Set<string>();
    for (const [index, capability] of manifest.capabilities.entries()) {
      const label = `capabilities[${index}]`;
      if (capability === null || typeof capability !== 'object') {
        problems.push(`${label}: must be an object { category, name }`);
        continue;
      }
      if (
        typeof capability.category !== 'string' ||
        !(EXTENSION_CAPABILITY_CATEGORIES as readonly string[]).includes(capability.category)
      ) {
        problems.push(
          `${label}.category: '${String(capability.category)}' is not one of the nine frozen capability categories (extension-model.md §3)`,
        );
      }
      if (typeof capability.name !== 'string' || !LABEL_PATTERN.test(capability.name)) {
        problems.push(`${label}.name: must be 1-64 characters`);
      } else if (names.has(capability.name)) {
        problems.push(`${label}.name: duplicate capability name '${capability.name}'`);
      } else {
        names.add(capability.name);
      }
    }
  }

  if (!Array.isArray(manifest.permissions) || manifest.permissions.length === 0) {
    problems.push('permissions: a manifest must declare at least one permission (extension-model.md §2/§5)');
  } else if (manifest.permissions.length > MAX_PERMISSIONS) {
    problems.push(`permissions: at most ${MAX_PERMISSIONS} permissions per manifest`);
  } else {
    const actions = new Set<string>();
    for (const [index, permission] of manifest.permissions.entries()) {
      const label = `permissions[${index}]`;
      if (permission === null || typeof permission !== 'object') {
        problems.push(`${label}: must be an object { action, resource }`);
        continue;
      }
      if (
        typeof permission.action !== 'string' ||
        !(EXTENSION_PERMISSION_ACTIONS as readonly string[]).includes(permission.action)
      ) {
        problems.push(
          `${label}.action: '${String(permission.action)}' is not in the closed least-privilege permission vocabulary (data:read, data:write, network:egress, secret:use — workflow mutation, credential creation, evidence-provenance assertion and audit disabling are NOT declarable permissions, extension-model.md §5)`,
        );
      } else {
        actions.add(permission.action);
      }
      if (
        permission.resource !== null &&
        permission.resource !== undefined &&
        (typeof permission.resource !== 'string' || permission.resource.length < 1 || permission.resource.length > 256)
      ) {
        problems.push(`${label}.resource: must be 1-256 characters when present`);
      }
    }
    // Least-privilege coherence: declared requirements must be backed by
    // their matching permission (a manifest asking for secrets without
    // secret:use, or for network egress without network:egress, fails
    // declaration).
    if (Array.isArray(manifest.requiredSecretNames) && manifest.requiredSecretNames.length > 0 && !actions.has('secret:use')) {
      problems.push('permissions: a manifest with requiredSecretNames must declare the secret:use permission');
    }
    if (Array.isArray(manifest.networkRequirements) && manifest.networkRequirements.length > 0 && !actions.has('network:egress')) {
      problems.push('permissions: a manifest with networkRequirements must declare the network:egress permission');
    }
  }

  problems.push(...isStringArray(manifest.requiredSecretNames, MAX_SECRET_NAMES, SECRET_NAME_PATTERN, 'requiredSecretNames'));
  problems.push(...isStringArray(manifest.dataScopes, MAX_DATA_SCOPES, /^(client|workspace):(read|write)$/, 'dataScopes'));

  if (!Array.isArray(manifest.networkRequirements) || manifest.networkRequirements.length > MAX_NETWORK_REQUIREMENTS) {
    problems.push(`networkRequirements: must be an array of at most ${MAX_NETWORK_REQUIREMENTS} declarations`);
  } else {
    for (const [index, requirement] of manifest.networkRequirements.entries()) {
      const label = `networkRequirements[${index}]`;
      if (requirement === null || typeof requirement !== 'object') {
        problems.push(`${label}: must be an object { host, protocol, port, reason }`);
        continue;
      }
      if (typeof requirement.host !== 'string' || requirement.host.length < 1 || requirement.host.length > 253) {
        problems.push(`${label}.host: must be 1-253 characters`);
      }
      if (typeof requirement.protocol !== 'string' || requirement.protocol.length < 1 || requirement.protocol.length > 16) {
        problems.push(`${label}.protocol: must be 1-16 characters`);
      }
      if (
        typeof requirement.port !== 'number' ||
        !Number.isSafeInteger(requirement.port) ||
        requirement.port < 1 ||
        requirement.port > 65535
      ) {
        problems.push(`${label}.port: must be an integer between 1 and 65535`);
      }
      if (typeof requirement.reason !== 'string' || requirement.reason.length < 1 || requirement.reason.length > 256) {
        problems.push(`${label}.reason: must be 1-256 characters`);
      }
    }
  }

  if (
    typeof manifest.runtimeClass !== 'string' ||
    !['pooled-worker', 'ephemeral-sandbox', 'persistent-sandbox', 'dedicated-runtime'].includes(manifest.runtimeClass)
  ) {
    problems.push('runtimeClass: must be one of the four frozen runtime classes (implementation-contract §9)');
  }

  for (const [label, contract] of [
    ['inputContract', manifest.inputContract],
    ['outputContract', manifest.outputContract],
  ] as const) {
    if (contract === null || typeof contract !== 'object' || Array.isArray(contract)) {
      problems.push(`${label}: must be a JSON object describing the contract`);
    } else if (Buffer.byteLength(JSON.stringify(contract), 'utf8') > MAX_CONTRACT_JSON_BYTES) {
      problems.push(`${label}: must serialize to at most ${MAX_CONTRACT_JSON_BYTES} bytes`);
    }
  }

  problems.push(...isStringArray(manifest.eventSubscriptions, MAX_EVENT_SUBSCRIPTIONS, LABEL_PATTERN, 'eventSubscriptions'));
  problems.push(...isStringArray(manifest.uiSurfaces, MAX_UI_SURFACES, LABEL_PATTERN, 'uiSurfaces'));

  if (
    manifest.configContract === null ||
    typeof manifest.configContract !== 'object' ||
    Array.isArray(manifest.configContract)
  ) {
    problems.push('configContract: must be an object of field name → field contract');
  } else {
    const fields = Object.entries(manifest.configContract);
    if (fields.length > MAX_CONFIG_FIELDS) {
      problems.push(`configContract: at most ${MAX_CONFIG_FIELDS} fields`);
    }
    for (const [fieldKey, field] of fields) {
      const label = `configContract.${fieldKey}`;
      if (fieldKey.length < 1 || fieldKey.length > 64) {
        problems.push(`${label}: field names must be 1-64 characters`);
      }
      problems.push(...configFieldProblems(field, label));
    }
  }

  // The §21 material-key backstop over the WHOLE manifest.
  problems.push(...payloadHasNoMaterialKeys(manifest, 'manifest'));

  if (problems.length > 0) {
    throw new InvalidRequestError('extension manifest failed the frozen shape/permission declaration contract', problems);
  }
}

function configFieldProblems(field: unknown, label: string): string[] {
  const problems: string[] = [];
  if (field === null || typeof field !== 'object') {
    problems.push(`${label}: must be an object { type, required, description, pattern }`);
    return problems;
  }
  const typed = field as ExtensionConfigFieldContract;
  if (typeof typed.type !== 'string' || !['string', 'number', 'boolean', 'object'].includes(typed.type)) {
    problems.push(`${label}.type: must be one of string/number/boolean/object`);
  }
  if (typeof typed.required !== 'boolean') {
    problems.push(`${label}.required: must be a boolean`);
  }
  if (typeof typed.description !== 'string' || typed.description.length < 1 || typed.description.length > 512) {
    problems.push(`${label}.description: must be 1-512 characters`);
  }
  if (
    typed.pattern !== null &&
    typed.pattern !== undefined &&
    (typeof typed.pattern !== 'string' || typed.pattern.length < 1 || typed.pattern.length > 256)
  ) {
    problems.push(`${label}.pattern: must be 1-256 characters when present`);
  }
  return problems;
}

/**
 * The §8-style fingerprint of one logical register command: a
 * deterministic digest of the CANONICAL manifest (sorted keys at every
 * level) — one idempotency key identifies one manifest; a key reused for
 * different content is a conflict. Pure.
 */
export function extensionCreateFingerprint(manifest: ExtensionManifest): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(manifest as unknown as JSONValue)))
    .update('|mkt-022-extension-manifest')
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Install + configure guards
// ---------------------------------------------------------------------------

/**
 * The install input guard: canonical scope shape, granted-scope
 * least-privilege (⊆ the manifest's DECLARED data scopes — an install
 * can never grant more than the manifest declares), bounded idempotency
 * key. Pure.
 */
export function assertValidExtensionInstallInput(
  input: {
    readonly scope: {
      readonly agencyId: string | null;
      readonly clientId: string | null;
      readonly workspaceId: string | null;
    };
    readonly extensionId: string;
    readonly grantedScopes: readonly ExtensionDataScope[];
    readonly idempotencyKey: string;
  },
  manifest: ExtensionManifest,
): void {
  const problems: string[] = [];
  if (input.scope === null || typeof input.scope !== 'object') {
    problems.push('scope: the canonical install scope is required');
  } else {
    if (typeof input.scope.agencyId !== 'string' || input.scope.agencyId.length === 0) {
      problems.push('scope.agencyId: the owning agency is required');
    }
    if (typeof input.scope.clientId !== 'string' || input.scope.clientId.length === 0) {
      problems.push('scope.clientId: the owning client is required');
    }
    if (typeof input.scope.workspaceId !== 'string' || input.scope.workspaceId.length === 0) {
      problems.push('scope.workspaceId: the owning workspace is required');
    }
  }
  if (typeof input.extensionId !== 'string' || input.extensionId.length === 0) {
    problems.push('extensionId: the published extension version is required');
  }
  if (!Array.isArray(input.grantedScopes)) {
    problems.push('grantedScopes: must be an array of data-scope labels');
  } else {
    for (const scope of input.grantedScopes) {
      if (!(EXTENSION_DATA_SCOPES as readonly string[]).includes(scope)) {
        problems.push(`grantedScopes: '${String(scope)}' is not in the closed data-scope vocabulary`);
      } else if (!(manifest.dataScopes as readonly string[]).includes(scope)) {
        problems.push(
          `grantedScopes: '${scope}' exceeds the manifest's declared data scopes (least-privilege — extension-model.md §5)`,
        );
      }
    }
  }
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length < 1 || input.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    problems.push(`idempotencyKey: must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters`);
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('extension install input failed the frozen contract', problems);
  }
}

/**
 * Validates configuration values against the manifest's declared config
 * contract: every supplied key must be DECLARED, every required field
 * present, values type-checked (and pattern-checked where declared).
 * Pure; returns the problem list.
 */
export function validateConfigAgainstContract(
  config: Readonly<Record<string, unknown>>,
  contract: Readonly<Record<string, ExtensionConfigFieldContract>>,
): string[] {
  const problems: string[] = [];
  const declared = new Set(Object.keys(contract));
  for (const key of Object.keys(config)) {
    if (!declared.has(key)) {
      problems.push(`config.${key}: not declared in the manifest config contract (unknown configuration is rejected)`);
    }
  }
  for (const [key, field] of Object.entries(contract)) {
    if (field.required && !(key in config)) {
      problems.push(`config.${key}: required by the manifest config contract`);
      continue;
    }
    if (!(key in config)) continue;
    const value = config[key];
    if (value === undefined) {
      problems.push(`config.${key}: required by the manifest config contract`);
      continue;
    }
    switch (field.type) {
      case 'string':
        if (typeof value !== 'string') problems.push(`config.${key}: must be a string`);
        else if (field.pattern !== null && field.pattern !== undefined && !new RegExp(field.pattern).test(value)) {
          problems.push(`config.${key}: does not match the declared pattern`);
        }
        break;
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) problems.push(`config.${key}: must be a number`);
        break;
      case 'boolean':
        if (typeof value !== 'boolean') problems.push(`config.${key}: must be a boolean`);
        break;
      case 'object':
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          problems.push(`config.${key}: must be an object`);
        }
        break;
    }
  }
  return problems;
}

/**
 * The configure input guard: config values validated against the
 * manifest's config contract, secret bindings covering EXACTLY the
 * manifest's requiredSecretNames (logical names → credential reference
 * ids — values are never acceptable), the §21 backstop on config.
 * Pure.
 */
export function assertValidExtensionConfigureInput(
  input: {
    readonly installId: string;
    readonly config: Readonly<Record<string, unknown>>;
    readonly secretBindings: Readonly<Record<string, string>>;
    readonly expectedVersion: number;
  },
  manifest: ExtensionManifest,
): void {
  const problems: string[] = [];
  if (typeof input.installId !== 'string' || input.installId.length === 0) {
    problems.push('installId: required');
  }
  if (typeof input.expectedVersion !== 'number' || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    problems.push('expectedVersion: the CAS token is required');
  }
  if (input.config === null || typeof input.config !== 'object' || Array.isArray(input.config)) {
    problems.push('config: must be an object of configuration values');
  } else {
    if (Buffer.byteLength(JSON.stringify(input.config), 'utf8') > MAX_CONFIG_JSON_BYTES) {
      problems.push(`config: must serialize to at most ${MAX_CONFIG_JSON_BYTES} bytes`);
    }
    problems.push(...validateConfigAgainstContract(input.config, manifest.configContract));
    problems.push(...payloadHasNoMaterialKeys(input.config, 'config'));
  }
  const requiredNames = new Set(manifest.requiredSecretNames);
  if (input.secretBindings === null || typeof input.secretBindings !== 'object' || Array.isArray(input.secretBindings)) {
    problems.push('secretBindings: must be an object mapping required secret logical names to credential reference ids');
  } else {
    const bound = Object.keys(input.secretBindings);
    if (bound.length > MAX_SECRET_BINDINGS) {
      problems.push(`secretBindings: at most ${MAX_SECRET_BINDINGS} bindings`);
    }
    for (const name of bound) {
      if (!requiredNames.has(name)) {
        problems.push(`secretBindings.${name}: not a required secret logical name of the manifest`);
      }
    }
    for (const required of requiredNames) {
      if (!bound.includes(required)) {
        problems.push(`secretBindings.${required}: the manifest requires this logical name to be bound`);
      }
    }
    for (const [name, reference] of Object.entries(input.secretBindings)) {
      if (typeof reference !== 'string' || !CREDENTIAL_REF_PATTERN.test(reference)) {
        problems.push(`secretBindings.${name}: must map to a credential reference id (never a secret value — CRED-001)`);
      }
    }
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('extension configuration failed the manifest contract', problems);
  }
}

// ---------------------------------------------------------------------------
// Invocation guards
// ---------------------------------------------------------------------------

/**
 * The required-keys view of an input/output contract: the common
 * JSON-Schema subset { required: string[] } when declared. Pure.
 */
export function requiredKeysOfContract(
  contract: Readonly<Record<string, unknown>>,
): readonly string[] {
  const required = contract['required'];
  if (Array.isArray(required) && required.every((key) => typeof key === 'string')) {
    return required as readonly string[];
  }
  return [];
}

/**
 * Validates the invocation INPUT against the manifest input contract:
 * the payload must be a bounded JSON object, carry no material-shaped key
 * (§21 — secrets never appear in durable extension input blobs) and no
 * authority-shaped key (implementation-contract §3 — invocation
 * identity/scope/provenance are server-derived; an extension can never
 * assert them), and every contract-required key must be present. Pure.
 */
export function validateInvocationInputAgainstContract(
  input: Readonly<Record<string, unknown>>,
  inputContract: Readonly<Record<string, unknown>>,
): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(input)) {
    if ((INVOCATION_INPUT_AUTHORITY_KEYS as readonly string[]).includes(key)) {
      problems.push(`input.${key}: authority-shaped keys are rejected (invocation identity, scope, provenance and policy posture are server-derived — implementation-contract §3)`);
    }
  }
  problems.push(...payloadHasNoMaterialKeys(input, 'input'));
  for (const key of requiredKeysOfContract(inputContract)) {
    if (!(key in input)) {
      problems.push(`input.${key}: required by the manifest input contract`);
    }
  }
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > MAX_INPUT_JSON_BYTES) {
    problems.push(`input: must serialize to at most ${MAX_INPUT_JSON_BYTES} bytes`);
  }
  return problems;
}

/**
 * The invocation input guard: requested capabilities must be a
 * non-empty bounded unique list of DECLARED capability names (the
 * undeclared-capability invocation rejection) and the input must satisfy
 * the manifest input contract (above). Pure.
 */
export function assertValidExtensionInvocationInput(
  input: {
    readonly executionId: string;
    readonly extensionId: string;
    readonly requestedCapabilities: readonly string[];
    readonly input: Readonly<Record<string, unknown>>;
  },
  manifest: ExtensionManifest,
): void {
  const problems: string[] = [];
  if (typeof input.executionId !== 'string' || input.executionId.length === 0) {
    problems.push('executionId: required');
  }
  if (typeof input.extensionId !== 'string' || input.extensionId.length === 0) {
    problems.push('extensionId: required');
  }
  if (!Array.isArray(input.requestedCapabilities) || input.requestedCapabilities.length === 0) {
    problems.push('requestedCapabilities: a non-empty list of declared capability names is required');
  } else if (input.requestedCapabilities.length > MAX_REQUESTED_CAPABILITIES) {
    problems.push(`requestedCapabilities: at most ${MAX_REQUESTED_CAPABILITIES} capabilities per invocation`);
  } else {
    const declared = new Set(manifest.capabilities.map((capability) => capability.name));
    const seen = new Set<string>();
    for (const name of input.requestedCapabilities) {
      if (typeof name !== 'string' || name.length === 0 || name.length > 64) {
        problems.push('requestedCapabilities: capability names must be 1-64 characters');
      } else if (!declared.has(name)) {
        problems.push(
          `requestedCapabilities: '${name}' is not a declared capability of ${manifest.extensionKey} ${manifest.version} (the granted capability set is bounded by the manifest — implementation-contract §19)`,
        );
      } else if (seen.has(name)) {
        problems.push(`requestedCapabilities: duplicate capability name '${name}'`);
      } else {
        seen.add(name);
      }
    }
  }
  if (input.input === null || typeof input.input !== 'object' || Array.isArray(input.input)) {
    problems.push('input: must be a JSON object satisfying the manifest input contract');
  } else {
    problems.push(...validateInvocationInputAgainstContract(input.input, manifest.inputContract));
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('extension invocation input failed the frozen contract', problems);
  }
}

/** The server-derived provenance guard (completeness + bounds). Pure. */
export function assertValidInvocationProvenance(provenance: ExtensionInvocationProvenance): void {
  const problems: string[] = [];
  if (typeof provenance.actor !== 'string' || provenance.actor.length < 1 || provenance.actor.length > 100) {
    problems.push('provenance.actor: a server-derived actor label is required');
  }
  if (typeof provenance.recordedVia !== 'string' || provenance.recordedVia.length < 1 || provenance.recordedVia.length > 100) {
    problems.push('provenance.recordedVia: a surface label is required');
  }
  if (typeof provenance.correlationId !== 'string' || provenance.correlationId.length < 1 || provenance.correlationId.length > 128) {
    problems.push('provenance.correlationId: required');
  }
  if (
    provenance.causationId !== null &&
    (typeof provenance.causationId !== 'string' || provenance.causationId.length < 1 || provenance.causationId.length > 128)
  ) {
    problems.push('provenance.causationId: must be a bounded identifier when present');
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('invocation provenance is incomplete', problems);
  }
}

// ---------------------------------------------------------------------------
// Row shapes + mapping
// ---------------------------------------------------------------------------

interface ExtensionRegistryRow extends DbRow {
  extension_id: string;
  extension_key: string;
  publisher: string;
  version: string;
  compat_min: string;
  compat_max: string;
  capabilities: ExtensionCapabilityDeclaration[];
  permissions: { action: string; resource: string | null }[];
  required_secret_names: string[];
  data_scopes: string[];
  network_requirements: {
    host: string;
    protocol: string;
    port: number;
    reason: string;
  }[];
  runtime_class: string;
  input_contract: Record<string, unknown>;
  output_contract: Record<string, unknown>;
  event_subscriptions: string[];
  ui_surfaces: string[];
  config_contract: Record<string, { type: string; required: boolean; description: string; pattern: string | null }>;
  idempotency_key: string;
  create_fingerprint: string;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ExtensionInstallRow extends DbRow {
  install_id: string;
  extension_id: string;
  agency_id: string;
  client_id: string;
  workspace_id: string;
  status: string;
  config: Record<string, unknown>;
  secret_bindings: Record<string, string>;
  granted_scopes: string[];
  idempotency_key: string;
  version: number | string;
  created_by: string | null;
  uninstalled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface ExtensionInvocationRow extends DbRow {
  invocation_id: string;
  extension_id: string;
  install_id: string;
  execution_id: string;
  agency_id: string;
  client_id: string;
  workspace_id: string;
  granted_capabilities: ExtensionCapabilityDeclaration[];
  granted_data_scopes: string[];
  policy_decision_id: string;
  policy_outcome: string;
  input: Record<string, unknown>;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  issued_at: Date;
  expires_at: Date;
  recorded_at: Date;
}

const EXTENSION_SELECT = `
  SELECT extension_id, extension_key, publisher, version, compat_min, compat_max, capabilities,
         permissions, required_secret_names, data_scopes, network_requirements, runtime_class,
         input_contract, output_contract, event_subscriptions, ui_surfaces, config_contract,
         idempotency_key, create_fingerprint, created_by, created_at, updated_at
  FROM extensions
`;

const INSTALL_SELECT = `
  SELECT install_id, extension_id, agency_id, client_id, workspace_id, status, config,
         secret_bindings, granted_scopes, idempotency_key, version, created_by,
         uninstalled_at, created_at, updated_at
  FROM extension_installs
`;

const INVOCATION_SELECT = `
  SELECT invocation_id, extension_id, install_id, execution_id, agency_id, client_id, workspace_id,
         granted_capabilities, granted_data_scopes, policy_decision_id, policy_outcome, input,
         recorded_actor, recorded_via, correlation_id, causation_id, issued_at, expires_at, recorded_at
  FROM extension_invocations
`;

function toRegistryRecord(row: ExtensionRegistryRow): ExtensionRegistryRecord {
  return {
    extensionId: row.extension_id,
    manifest: {
      extensionKey: row.extension_key,
      publisher: row.publisher,
      version: row.version,
      compatibility: { minPlatform: row.compat_min, maxPlatform: row.compat_max },
      capabilities: row.capabilities,
      permissions: row.permissions as ExtensionManifest['permissions'],
      requiredSecretNames: row.required_secret_names,
      dataScopes: row.data_scopes as ExtensionManifest['dataScopes'],
      networkRequirements: row.network_requirements as ExtensionManifest['networkRequirements'],
      runtimeClass: row.runtime_class as ExtensionManifest['runtimeClass'],
      inputContract: row.input_contract,
      outputContract: row.output_contract,
      eventSubscriptions: row.event_subscriptions,
      uiSurfaces: row.ui_surfaces,
      configContract: row.config_contract as ExtensionManifest['configContract'],
    },
    idempotencyKey: row.idempotency_key,
    createFingerprint: row.create_fingerprint,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toInstallRecord(row: ExtensionInstallRow): ExtensionInstallRecord {
  return {
    installId: row.install_id,
    extensionId: row.extension_id,
    agencyId: row.agency_id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    status: row.status as ExtensionInstallStatus,
    config: row.config,
    secretBindings: row.secret_bindings,
    grantedScopes: row.granted_scopes as ExtensionInstallRecord['grantedScopes'],
    idempotencyKey: row.idempotency_key,
    version: Number(row.version),
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toInvocationRecord(row: ExtensionInvocationRow): ExtensionInvocationRecord {
  return {
    invocationId: row.invocation_id,
    extensionId: row.extension_id,
    extensionKey: '',
    version: '',
    installId: row.install_id,
    executionId: row.execution_id,
    agencyId: row.agency_id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    grantedCapabilities: row.granted_capabilities,
    grantedDataScopes: row.granted_data_scopes as ExtensionInvocationRecord['grantedDataScopes'],
    policyDecisionId: row.policy_decision_id,
    policyOutcome: 'allow',
    input: row.input,
    recordedActor: row.recorded_actor,
    recordedVia: row.recorded_via,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    issuedAt: row.issued_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    recordedAt: row.recorded_at.toISOString(),
  };
}

/**
 * Classifies a postgres error on /extensions writes into the domain
 * conflict it represents (unique-violation fence vs lifecycle backstop).
 * Anything else propagates untouched.
 */
export function classifyExtensionsWriteConflict(error: unknown): 'version-fence' | 'install-fence' | 'lifecycle-backstop' | null {
  const candidate = error as { code?: string; constraint?: string };
  if (candidate?.code === '23505') {
    if (candidate.constraint === 'extension_installs_workspace_extension_unique') return 'install-fence';
    return 'version-fence';
  }
  if (candidate?.code === '23514' || candidate?.code === 'P0001') return 'lifecycle-backstop';
  return null;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface InvocationInsertRow {
  /** The module-allocated identity (the returned context carries it). */
  readonly invocationId: string;
  readonly extensionId: string;
  readonly extensionKey: string;
  readonly version: string;
  readonly installId: string;
  readonly executionId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string;
  readonly grantedCapabilities: readonly ExtensionCapabilityDeclaration[];
  readonly grantedDataScopes: readonly ExtensionDataScope[];
  readonly policyDecisionId: string;
  readonly policyOutcome: 'allow';
  readonly input: Readonly<Record<string, unknown>>;
  readonly provenance: ExtensionInvocationProvenance;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export class ExtensionsStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  /**
   * Inserts one published version. 'taken' means the (publisher, key,
   * version) fence rejected the insert — the immutable version already
   * exists (ConflictError upstream; never a silent rewrite).
   */
  async insertExtensionVersion(row: {
    readonly manifest: ExtensionManifest;
    readonly idempotencyKey: string;
    readonly createFingerprint: string;
    readonly createdBy: string | null;
  }): Promise<ExtensionRegistryRecord | 'taken'> {
    const extensionId = this.ids.newId();
    const now = this.clock.nowIso();
    const manifest = row.manifest;
    const result = await this.db.query(
      `INSERT INTO extensions
         (extension_id, extension_key, publisher, version, compat_min, compat_max, capabilities,
          permissions, required_secret_names, data_scopes, network_requirements, runtime_class,
          input_contract, output_contract, event_subscriptions, ui_surfaces, config_contract,
          idempotency_key, create_fingerprint, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12,
               $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb, $18, $19, $20, $21, $21)
       ON CONFLICT (publisher, extension_key, version) DO NOTHING`,
      [
        extensionId,
        manifest.extensionKey,
        manifest.publisher,
        manifest.version,
        manifest.compatibility.minPlatform,
        manifest.compatibility.maxPlatform,
        JSON.stringify(manifest.capabilities),
        JSON.stringify(manifest.permissions),
        JSON.stringify(manifest.requiredSecretNames),
        JSON.stringify(manifest.dataScopes),
        JSON.stringify(manifest.networkRequirements),
        manifest.runtimeClass,
        JSON.stringify(manifest.inputContract),
        JSON.stringify(manifest.outputContract),
        JSON.stringify(manifest.eventSubscriptions),
        JSON.stringify(manifest.uiSurfaces),
        JSON.stringify(manifest.configContract),
        row.idempotencyKey,
        row.createFingerprint,
        row.createdBy,
        now,
      ],
    );
    if (result.rowCount !== 1) return 'taken';
    const created = await this.getExtensionVersion(extensionId);
    if (created === null) {
      throw new Error(`published extension version ${extensionId} could not be read back`);
    }
    return created;
  }

  async getExtensionVersion(extensionId: string): Promise<ExtensionRegistryRecord | null> {
    const result = await this.db.query<ExtensionRegistryRow>(
      `${EXTENSION_SELECT} WHERE extension_id = $1`,
      [extensionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRegistryRecord(row);
  }

  async listExtensionVersions(extensionKey: string | null): Promise<readonly ExtensionRegistryRecord[]> {
    const clauses: string[] = [];
    const params: (string | null)[] = [];
    if (extensionKey !== null) {
      params.push(extensionKey);
      clauses.push(`extension_key = $${params.length}`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.db.query<ExtensionRegistryRow>(
      `${EXTENSION_SELECT} ${where} ORDER BY created_at DESC, extension_id LIMIT 500`,
      params,
    );
    return result.rows.map(toRegistryRecord);
  }

  /**
   * Inserts one install. 'taken' means the (workspace, extension version)
   * fence rejected the insert — the version is already installed here.
   */
  async insertExtensionInstall(row: {
    readonly extensionId: string;
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceId: string;
    readonly grantedScopes: readonly ExtensionDataScope[];
    readonly idempotencyKey: string;
    readonly createdBy: string | null;
  }): Promise<ExtensionInstallRecord | 'taken'> {
    const installId = this.ids.newId();
    const now = this.clock.nowIso();
    const result = await this.db.query(
      `INSERT INTO extension_installs
         (install_id, extension_id, agency_id, client_id, workspace_id, status, config,
          secret_bindings, granted_scopes, idempotency_key, version, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'installed', '{}'::jsonb, '{}'::jsonb, $6::jsonb, $7, 1, $8, $9, $9)
       ON CONFLICT (workspace_id, extension_id) DO NOTHING`,
      [
        installId,
        row.extensionId,
        row.agencyId,
        row.clientId,
        row.workspaceId,
        JSON.stringify(row.grantedScopes),
        row.idempotencyKey,
        row.createdBy,
        now,
      ],
    );
    if (result.rowCount !== 1) return 'taken';
    const created = await this.getExtensionInstall(installId);
    if (created === null) {
      throw new Error(`inserted extension install ${installId} could not be read back`);
    }
    return created;
  }

  async getExtensionInstall(installId: string): Promise<ExtensionInstallRecord | null> {
    const result = await this.db.query<ExtensionInstallRow>(
      `${INSTALL_SELECT} WHERE install_id = $1`,
      [installId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toInstallRecord(row);
  }

  /**
   * The install of one extension VERSION in one Workspace (null when the
   * version is not installed there). This is the invocation-path lookup:
   * the install is resolved by (execution workspace, extension version)
   * from durable state — never caller-supplied.
   */
  async findExtensionInstall(
    workspaceId: string,
    extensionId: string,
  ): Promise<ExtensionInstallRecord | null> {
    const result = await this.db.query<ExtensionInstallRow>(
      `${INSTALL_SELECT} WHERE workspace_id = $1 AND extension_id = $2`,
      [workspaceId, extensionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toInstallRecord(row);
  }

  async listExtensionInstalls(workspaceId: string): Promise<readonly ExtensionInstallRecord[]> {
    const result = await this.db.query<ExtensionInstallRow>(
      `${INSTALL_SELECT} WHERE workspace_id = $1
       ORDER BY created_at DESC, install_id LIMIT 500`,
      [workspaceId],
    );
    return result.rows.map(toInstallRecord);
  }

  /** Locks the install row (FOR UPDATE) and returns it — CAS serialized. */
  async lockExtensionInstall(
    tx: DbTransaction,
    installId: string,
  ): Promise<ExtensionInstallRecord | null> {
    const result = await tx.query<ExtensionInstallRow>(
      `${INSTALL_SELECT} WHERE install_id = $1 FOR UPDATE`,
      [installId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toInstallRecord(row);
  }

  /**
   * CAS lifecycle/config transition on the CALLER'S transaction (the row
   * was locked there). The immutability + lifecycle triggers are the
   * final backstops.
   */
  async updateExtensionInstall(
    tx: DbTransaction,
    input: {
      readonly installId: string;
      readonly status: ExtensionInstallStatus | null;
      readonly config: Readonly<Record<string, unknown>> | null;
      readonly secretBindings: Readonly<Record<string, string>> | null;
      readonly expectedVersion: number;
    },
  ): Promise<{ readonly updated: ExtensionInstallRecord } | 'not-found' | 'version-conflict'> {
    const now = this.clock.nowIso();
    const statusValue = input.status === null ? undefined : input.status;
    const uninstalledAt = statusValue === 'uninstalled' ? now : statusValue === undefined ? undefined : null;
    const sets: string[] = ['version = version + 1', 'updated_at = $1'];
    const params: QueryParam[] = [now];
    const push = (value: QueryParam, prefix: string): void => {
      params.push(value);
      sets.push(`${prefix} = $${params.length}`);
    };
    if (input.config !== null) push(JSON.stringify(input.config), 'config');
    if (input.secretBindings !== null) push(JSON.stringify(input.secretBindings), 'secret_bindings');
    if (statusValue !== undefined) {
      push(statusValue, 'status');
      if (uninstalledAt !== undefined) push(uninstalledAt, 'uninstalled_at');
    }
    // RETURNING reads the updated row INSIDE the same transaction (an
    // out-of-band read-back on another pooled connection could not see
    // the uncommitted change under READ COMMITTED).
    const result = await tx.query<ExtensionInstallRow>(
      `UPDATE extension_installs SET ${sets.join(', ')}
       WHERE install_id = $${params.length + 1} AND version = $${params.length + 2}
       RETURNING install_id, extension_id, agency_id, client_id, workspace_id, status, config,
                 secret_bindings, granted_scopes, idempotency_key, version, created_by,
                 uninstalled_at, created_at, updated_at`,
      [...params, input.installId, input.expectedVersion],
    );
    if (result.rowCount === 1) return { updated: toInstallRecord(result.rows[0]!) };
    const existing = await tx.query<{ version: number | string }>(
      'SELECT version FROM extension_installs WHERE install_id = $1',
      [input.installId],
    );
    if (existing.rows.length === 0) return 'not-found';
    return 'version-conflict';
  }

  /** Inserts one append-only invocation ledger row (identity from the module). */
  async insertExtensionInvocation(row: InvocationInsertRow): Promise<ExtensionInvocationRecord> {
    const invocationId = row.invocationId;
    const recordedAt = this.clock.nowIso();
    const result = await this.db.query(
      `INSERT INTO extension_invocations
         (invocation_id, extension_id, install_id, execution_id, agency_id, client_id, workspace_id,
          granted_capabilities, granted_data_scopes, policy_decision_id, policy_outcome, input,
          recorded_actor, recorded_via, correlation_id, causation_id, issued_at, expires_at, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12::jsonb,
               $13, $14, $15, $16, $17, $18, $19)
       RETURNING invocation_id`,
      [
        invocationId,
        row.extensionId,
        row.installId,
        row.executionId,
        row.agencyId,
        row.clientId,
        row.workspaceId,
        JSON.stringify(row.grantedCapabilities),
        JSON.stringify(row.grantedDataScopes),
        row.policyDecisionId,
        row.policyOutcome,
        JSON.stringify(row.input),
        row.provenance.actor,
        row.provenance.recordedVia,
        row.provenance.correlationId,
        row.provenance.causationId,
        row.issuedAt,
        row.expiresAt,
        recordedAt,
      ],
    );
    if (result.rowCount !== 1) {
      throw new Error(`extension invocation ${invocationId} could not be recorded`);
    }
    const created = await this.getExtensionInvocation(invocationId);
    if (created === null) {
      throw new Error(`recorded extension invocation ${invocationId} could not be read back`);
    }
    // The ledger row stores the extension identity by id; the enriched
    // key/version are composed from the insert row (immutable inputs).
    return { ...created, extensionKey: row.extensionKey, version: row.version };
  }

  async getExtensionInvocation(invocationId: string): Promise<ExtensionInvocationRecord | null> {
    const result = await this.db.query<ExtensionInvocationRow>(
      `${INVOCATION_SELECT} WHERE invocation_id = $1`,
      [invocationId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    const registry = await this.getExtensionVersion(row.extension_id);
    return {
      ...toInvocationRecord(row),
      extensionKey: registry === null ? '' : registry.manifest.extensionKey,
      version: registry === null ? '' : registry.manifest.version,
    };
  }

  async listExtensionInvocations(workspaceId: string): Promise<readonly ExtensionInvocationRecord[]> {
    const result = await this.db.query<ExtensionInvocationRow>(
      `${INVOCATION_SELECT} WHERE workspace_id = $1
       ORDER BY recorded_at DESC, invocation_id LIMIT 200`,
      [workspaceId],
    );
    const records: ExtensionInvocationRecord[] = [];
    for (const row of result.rows) {
      const registry = await this.getExtensionVersion(row.extension_id);
      records.push({
        ...toInvocationRecord(row),
        extensionKey: registry === null ? '' : registry.manifest.extensionKey,
        version: registry === null ? '' : registry.manifest.version,
      });
    }
    return records;
  }
}

// ---------------------------------------------------------------------------
// Pure context composition (unit-tested)
// ---------------------------------------------------------------------------

type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };

/** Canonical JSON: object keys sorted at EVERY level (deterministic digest). */
function canonicalize(value: JSONValue): JSONValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, JSONValue> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalize(value[key]!);
    }
    return sorted;
  }
  return value;
}

/**
 * Composes the short-lived invocation context from the frozen inputs
 * (pure — the module wraps this with the policy gate and persistence).
 * The scope is ALWAYS the execution's canonical owner.
 */
export function composeInvocationContext(input: {
  readonly invocationId: string;
  readonly extension: ExtensionRegistryRecord;
  readonly install: ExtensionInstallRecord;
  readonly executionId: string;
  readonly scope: {
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceId: string;
  };
  readonly requestedCapabilities: readonly string[];
  readonly policyDecisionId: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly provenance: ExtensionInvocationProvenance;
  readonly issuedAt: string;
  readonly ttlMs: number;
}): {
  readonly context: ExtensionInvocationContext;
  readonly grantedCapabilities: readonly ExtensionCapabilityDeclaration[];
  readonly grantedDataScopes: readonly ExtensionDataScope[];
} {
  const grantedCapabilities = input.extension.manifest.capabilities.filter((capability) =>
    input.requestedCapabilities.includes(capability.name),
  );
  const grantedDataScopes = input.install.grantedScopes.filter((scope) =>
    (input.extension.manifest.dataScopes as readonly string[]).includes(scope),
  );
  const context: ExtensionInvocationContext = {
    invocationId: input.invocationId,
    extensionId: input.extension.extensionId,
    extensionKey: input.extension.manifest.extensionKey,
    version: input.extension.manifest.version,
    installId: input.install.installId,
    executionId: input.executionId,
    scope: {
      kind: 'extension-invocation',
      agencyId: input.scope.agencyId,
      clientId: input.scope.clientId,
      workspaceId: input.scope.workspaceId,
    },
    grantedCapabilities,
    grantedDataScopes,
    policyDecisionId: input.policyDecisionId,
    runtimeClass: input.extension.manifest.runtimeClass,
    input: input.input,
    provenance: input.provenance,
    issuedAt: input.issuedAt,
    expiresAt: new Date(Date.parse(input.issuedAt) + input.ttlMs).toISOString(),
  };
  return { context, grantedCapabilities, grantedDataScopes };
}

export { toInstallRecord, toRegistryRecord, type ExtensionInstallRow, type ExtensionRegistryRow };
