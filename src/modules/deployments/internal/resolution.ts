/**
 * /deployments input guards + the PURE resolution evaluator (MKT-040,
 * DEPLOY-002 — the activation-gate core).
 *
 * Everything in this file is PURE: guards validate shapes against the
 * frozen closed vocabularies (mirrored by the migration 034 CHECKs), the
 * version-constraint matcher implements the deterministic pinned-version
 * semantics, and `evaluateDeploymentResolution` composes the named check
 * results from ALREADY-RESOLVED port snapshots — the same inputs always
 * produce the same report. The module orchestrates the port reads and
 * hands the snapshots here; every failed check is recorded honestly and
 * ANY failed check fails the whole gate (DEPLOY-AC-04: no partially
 * validated deployment becomes READY or ACTIVE).
 *
 * The §21 secret-leak guard (containsMaterialShapedKey) runs on every
 * payload BEFORE insert: nothing secret can enter any deployment record.
 */

import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import type {
  DeploymentCheckResult,
  DeploymentDomainPackRequirement,
  DeploymentCapabilityRequirement,
  DeploymentRuntimeRequirements,
  DeploymentSelection,
  DeploymentTrigger,
  DeploymentValidationReport,
  DeploymentsAdapterSnapshot,
  DeploymentsCredentialReferenceSnapshot,
  DeploymentsExtensionInstallSnapshot,
  DeploymentsExtensionVersionSnapshot,
  DeploymentsIntegrationConnectionSnapshot,
  DeploymentsPackInstallSnapshot,
  DeploymentsPackVersionSnapshot,
  DeploymentsPlaybookSnapshot,
  DeploymentsPlaybookVersionSnapshot,
  DeploymentsWorkflowDefinitionSnapshot,
  DeploymentsWorkflowSnapshot,
  DeploymentsWorkspaceOwnershipSnapshot,
} from '../public.ts';
import {
  DEPLOYMENT_RUNTIME_CLASSES,
  DEPLOYMENT_STATUSES,
} from '../public.ts';

// ---------------------------------------------------------------------------
// Bounded shape constants (mirrored by the migration 034 CHECKs)
// ---------------------------------------------------------------------------

export const MAX_WORKFLOW_REFS = 8;
export const MAX_PACK_REQUIREMENTS = 32;
export const MAX_CAPABILITY_REQUIREMENTS = 32;
export const MAX_TRIGGERS = 16;
export const MAX_TRIGGER_CONFIG_KEYS = 16;
export const MAX_TRIGGER_CONFIG_VALUE_LENGTH = 256;
export const MAX_REQUIREMENT_NAME_LENGTH = 128;
export const MAX_VERSION_CONSTRAINT_LENGTH = 64;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
export const MAX_REASON_LENGTH = 2000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Material-shaped key denylist (implementation-contract §21). */
const MATERIAL_SHAPED_KEYS = [
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

/** True when a material-shaped key appears at ANY nesting level. */
export function containsMaterialShapedKey(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some((entry) => containsMaterialShapedKey(entry));
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if ((MATERIAL_SHAPED_KEYS as readonly string[]).includes(key)) return true;
    if (containsMaterialShapedKey(entry)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The version-constraint matcher (deterministic, fail-closed)
// ---------------------------------------------------------------------------

/**
 * The pinned-version constraint semantics (pure, deterministic):
 *   - constraint null → ANY version satisfies (unpinned);
 *   - '*' → any version;
 *   - exact 'X.Y.Z' → string equality;
 *   - '^X.Y.Z' → same MAJOR and (numerically) >= X.Y.Z;
 *   - anything else → false (unknown constraint syntax FAILS CLOSED — a
 *     malformed pin can never silently pass the gate).
 */
export function satisfiesVersionConstraint(
  version: string,
  constraint: string | null,
): boolean {
  if (constraint === null) return true;
  if (constraint === '*') return true;
  if (constraint.startsWith('^')) {
    const base = parseDottedVersion(constraint.slice(1));
    const actual = parseDottedVersion(version);
    if (base === null || actual === null) return false;
    if (majorOf(actual) !== majorOf(base)) return false;
    return compareDotted(actual, base) >= 0;
  }
  if (/^[0-9.]+$/.test(constraint)) {
    const base = parseDottedVersion(constraint);
    const actual = parseDottedVersion(version);
    if (base === null || actual === null) return false;
    return compareDotted(actual, base) === 0;
  }
  return false;
}

interface DottedVersion {
  readonly parts: readonly number[];
}

function parseDottedVersion(value: string): DottedVersion | null {
  if (!/^[0-9]+(\.[0-9]+)*$/.test(value)) return null;
  return { parts: value.split('.').map((part) => Number.parseInt(part, 10)) };
}

function compareDotted(a: DottedVersion, b: DottedVersion): number {
  const length = Math.max(a.parts.length, b.parts.length);
  for (let index = 0; index < length; index += 1) {
    const left = a.parts[index] ?? 0;
    const right = b.parts[index] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

function majorOf(version: DottedVersion): number {
  return version.parts[0] ?? 0;
}

// ---------------------------------------------------------------------------
// Input guards
// ---------------------------------------------------------------------------

/** Provenance guard: server-derived, bounded, never a request field. */
export function assertValidProvenance(
  provenance: {
    readonly actor: string;
    readonly recordedVia: string;
    readonly correlationId: string;
    readonly causationId: string | null;
  },
): void {
  const problems: string[] = [];
  if (typeof provenance.actor !== 'string' || provenance.actor.length < 1 || provenance.actor.length > 200) {
    problems.push('provenance.actor: non-empty string of at most 200 characters');
  }
  if (
    typeof provenance.recordedVia !== 'string' ||
    provenance.recordedVia.length < 1 ||
    provenance.recordedVia.length > 100
  ) {
    problems.push('provenance.recordedVia: non-empty string of at most 100 characters');
  }
  if (typeof provenance.correlationId !== 'string' || provenance.correlationId.length < 1) {
    problems.push('provenance.correlationId: non-empty string');
  }
  if (
    provenance.causationId !== null &&
    (typeof provenance.causationId !== 'string' || provenance.causationId.length < 1)
  ) {
    problems.push('provenance.causationId: null or a non-empty string');
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('Invalid deployment provenance', problems);
  }
}

function assertValidRequirementList(
  label: string,
  requirements: ReadonlyArray<unknown>,
  kindGuard: (requirement: DeploymentDomainPackRequirement | DeploymentCapabilityRequirement) => boolean,
): void {
  if (!Array.isArray(requirements)) {
    throw new InvalidRequestError(`Invalid ${label}`, [`${label}: must be an array`]);
  }
  if (requirements.length > MAX_PACK_REQUIREMENTS) {
    throw new InvalidRequestError(`Invalid ${label}`, [
      `${label}: at most ${MAX_PACK_REQUIREMENTS} entries`,
    ]);
  }
  for (const requirement of requirements) {
    if (requirement === null || typeof requirement !== 'object') {
      throw new InvalidRequestError(`Invalid ${label}`, [`${label}: every entry must be an object`]);
    }
    if (containsMaterialShapedKey(requirement)) {
      throw new InvalidRequestError(`Invalid ${label}`, [
        `${label}: material-shaped keys are forbidden at every level (§21)`,
      ]);
    }
    if (!kindGuard(requirement as DeploymentDomainPackRequirement)) {
      throw new InvalidRequestError(`Invalid ${label}`, [`${label}: malformed entry shape`]);
    }
    const candidate = requirement as DeploymentDomainPackRequirement;
    if (
      candidate.name === undefined ||
      typeof candidate.name !== 'string' ||
      candidate.name.length < 1 ||
      candidate.name.length > MAX_REQUIREMENT_NAME_LENGTH
    ) {
      throw new InvalidRequestError(`Invalid ${label}`, [
        `${label}.name: non-empty string of at most ${MAX_REQUIREMENT_NAME_LENGTH} characters`,
      ]);
    }
    if (
      candidate.versionConstraint !== null &&
      candidate.versionConstraint !== undefined &&
      (typeof candidate.versionConstraint !== 'string' ||
        candidate.versionConstraint.length < 1 ||
        candidate.versionConstraint.length > MAX_VERSION_CONSTRAINT_LENGTH)
    ) {
      throw new InvalidRequestError(`Invalid ${label}`, [
        `${label}.versionConstraint: null or a non-empty string of at most ${MAX_VERSION_CONSTRAINT_LENGTH} characters`,
      ]);
    }
  }
}

function assertValidRuntimeRequirements(requirements: unknown): asserts requirements is DeploymentRuntimeRequirements {
  if (requirements === null || typeof requirements !== 'object' || Array.isArray(requirements)) {
    throw new InvalidRequestError('Invalid runtime requirements', [
      'runtimeRequirements: must be an object',
    ]);
  }
  const keys = Object.keys(requirements);
  if (keys.length !== 1 || keys[0] !== 'runtimeClass') {
    throw new InvalidRequestError('Invalid runtime requirements', [
      'runtimeRequirements: exactly one key "runtimeClass" (DEPLOY-AC-09: no infrastructure identity)',
    ]);
  }
  const runtimeClass = (requirements as { runtimeClass: unknown }).runtimeClass;
  if (
    typeof runtimeClass !== 'string' ||
    !(DEPLOYMENT_RUNTIME_CLASSES as readonly string[]).includes(runtimeClass)
  ) {
    throw new InvalidRequestError('Invalid runtime requirements', [
      `runtimeRequirements.runtimeClass: one of ${DEPLOYMENT_RUNTIME_CLASSES.join(' | ')}`,
    ]);
  }
}

function assertValidTriggers(triggers: unknown): asserts triggers is readonly DeploymentTrigger[] {
  if (!Array.isArray(triggers)) {
    throw new InvalidRequestError('Invalid trigger configuration', [
      'triggerConfig: must be an array',
    ]);
  }
  if (triggers.length < 1) {
    throw new InvalidRequestError('Invalid trigger configuration', [
      'triggerConfig: at least one trigger',
    ]);
  }
  if (triggers.length > MAX_TRIGGERS) {
    throw new InvalidRequestError('Invalid trigger configuration', [
      `triggerConfig: at most ${MAX_TRIGGERS} triggers`,
    ]);
  }
  for (const trigger of triggers) {
    if (trigger === null || typeof trigger !== 'object' || Array.isArray(trigger)) {
      throw new InvalidRequestError('Invalid trigger configuration', [
        'triggerConfig: every trigger must be an object',
      ]);
    }
    if (containsMaterialShapedKey(trigger)) {
      throw new InvalidRequestError('Invalid trigger configuration', [
        'triggerConfig: material-shaped keys are forbidden at every level (§21)',
      ]);
    }
    const kind = (trigger as { kind?: unknown }).kind;
    if (kind !== 'manual' && kind !== 'schedule' && kind !== 'event') {
      throw new InvalidRequestError('Invalid trigger configuration', [
        'triggerConfig.kind: one of manual | schedule | event',
      ]);
    }
    const config = (trigger as { config?: unknown }).config;
    if (config === undefined || config === null) {
      if (kind === 'schedule') {
        throw new InvalidRequestError('Invalid trigger configuration', [
          'triggerConfig: schedule triggers require a non-null config object',
        ]);
      }
      continue;
    }
    if (typeof config !== 'object' || Array.isArray(config)) {
      throw new InvalidRequestError('Invalid trigger configuration', [
        'triggerConfig.config: null or an object of string values',
      ]);
    }
    const entries = Object.entries(config as Record<string, unknown>);
    if (entries.length > MAX_TRIGGER_CONFIG_KEYS) {
      throw new InvalidRequestError('Invalid trigger configuration', [
        `triggerConfig.config: at most ${MAX_TRIGGER_CONFIG_KEYS} keys`,
      ]);
    }
    for (const [key, value] of entries) {
      if (key.length < 1 || key.length > 64) {
        throw new InvalidRequestError('Invalid trigger configuration', [
          'triggerConfig.config: keys of 1..64 characters',
        ]);
      }
      if (typeof value !== 'string' || value.length < 1 || value.length > MAX_TRIGGER_CONFIG_VALUE_LENGTH) {
        throw new InvalidRequestError('Invalid trigger configuration', [
          `triggerConfig.config.${key}: string value of 1..${MAX_TRIGGER_CONFIG_VALUE_LENGTH} characters`,
        ]);
      }
    }
  }
}

/** Guards the full immutable version-selection shape (create + redeploy). */
export function assertValidSelection(selection: unknown): asserts selection is DeploymentSelection {
  if (selection === null || typeof selection !== 'object' || Array.isArray(selection)) {
    throw new InvalidRequestError('Invalid deployment selection', ['selection: must be an object']);
  }
  if (containsMaterialShapedKey(selection)) {
    throw new InvalidRequestError('Invalid deployment selection', [
      'selection: material-shaped keys are forbidden at every level (§21)',
    ]);
  }
  const record = selection as Record<string, unknown>;
  if (typeof record['playbookVersionId'] !== 'string' || !UUID_PATTERN.test(record['playbookVersionId'])) {
    throw new InvalidRequestError('Invalid deployment selection', [
      'selection.playbookVersionId: a playbook version uuid',
    ]);
  }
  const workflowRefs = record['workflowDefinitionIds'];
  if (!Array.isArray(workflowRefs) || workflowRefs.length < 1 || workflowRefs.length > MAX_WORKFLOW_REFS) {
    throw new InvalidRequestError('Invalid deployment selection', [
      `selection.workflowDefinitionIds: 1..${MAX_WORKFLOW_REFS} workflow definition ids`,
    ]);
  }
  const seen = new Set<string>();
  for (const ref of workflowRefs) {
    if (typeof ref !== 'string' || !UUID_PATTERN.test(ref)) {
      throw new InvalidRequestError('Invalid deployment selection', [
        'selection.workflowDefinitionIds: every entry must be a workflow definition uuid',
      ]);
    }
    if (seen.has(ref)) {
      throw new InvalidRequestError('Invalid deployment selection', [
        'selection.workflowDefinitionIds: duplicate definition reference',
      ]);
    }
    seen.add(ref);
  }
  const packRequirementsRaw = record['requiredDomainPacks'];
  if (packRequirementsRaw !== undefined && !Array.isArray(packRequirementsRaw)) {
    throw new InvalidRequestError('Invalid deployment selection', [
      'selection.requiredDomainPacks: must be an array',
    ]);
  }
  const packRequirements = (packRequirementsRaw as unknown[] | undefined) ?? [];
  assertValidRequirementList('selection.requiredDomainPacks', packRequirements, (entry) => {
    const candidate = entry as DeploymentDomainPackRequirement;
    return typeof candidate.name === 'string';
  });
  const capabilityRequirementsRaw = record['requiredCapabilities'];
  if (capabilityRequirementsRaw !== undefined && !Array.isArray(capabilityRequirementsRaw)) {
    throw new InvalidRequestError('Invalid deployment selection', [
      'selection.requiredCapabilities: must be an array',
    ]);
  }
  const capabilityRequirements = (capabilityRequirementsRaw as unknown[] | undefined) ?? [];
  assertValidRequirementList('selection.requiredCapabilities', capabilityRequirements, (entry) => {
    const candidate = entry as DeploymentCapabilityRequirement;
    return (candidate.kind === 'integration' || candidate.kind === 'extension') && typeof candidate.name === 'string';
  });
  assertValidRuntimeRequirements(record['runtimeRequirements']);
  assertValidTriggers(record['triggerConfig']);
}

/** The create input guard (workspace + full initial selection). */
export function assertValidDeploymentCreation(input: {
  readonly workspaceId: string;
  readonly selection: DeploymentSelection;
}): void {
  if (typeof input.workspaceId !== 'string' || !UUID_PATTERN.test(input.workspaceId)) {
    throw new InvalidRequestError('Invalid deployment creation', [
      'workspaceId: a workspace uuid',
    ]);
  }
  assertValidSelection(input.selection);
}

/** The redeploy-selection guard (the pending selection payload). */
export function assertValidRedeploySelection(selection: DeploymentSelection): void {
  assertValidSelection(selection);
}

/** The transition-request guard (bounded payloads per target state). */
export function assertValidTransitionRequest(input: {
  readonly deploymentId: string;
  readonly to: string;
  readonly idempotencyKey: string;
  readonly expectedVersion: number;
  readonly reason: string | null;
  readonly redeploySelection: DeploymentSelection | null;
  readonly rollbackTargetEventId: string | null;
}): void {
  const problems: string[] = [];
  if (typeof input.deploymentId !== 'string' || !UUID_PATTERN.test(input.deploymentId)) {
    problems.push('deploymentId: a deployment uuid');
  }
  if (!(DEPLOYMENT_STATUSES as readonly string[]).includes(input.to)) {
    problems.push(`to: one of ${DEPLOYMENT_STATUSES.join(' | ')}`);
  }
  if (input.to === 'validating' || input.to === 'ready') {
    problems.push(
      `to: '${input.to}' is not externally targetable (validateDeployment is the only path into ready; validating is the atomic in-flight leg)`,
    );
  }
  if (
    typeof input.idempotencyKey !== 'string' ||
    input.idempotencyKey.length < 1 ||
    input.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH
  ) {
    problems.push(`idempotencyKey: non-empty string of at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`);
  }
  if (typeof input.expectedVersion !== 'number' || !Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    problems.push('expectedVersion: a positive integer');
  }
  if (
    input.reason !== null &&
    (typeof input.reason !== 'string' || input.reason.length < 1 || input.reason.length > MAX_REASON_LENGTH)
  ) {
    problems.push(`reason: null or a string of 1..${MAX_REASON_LENGTH} characters`);
  }
  if (input.to === 'redeploying' && input.redeploySelection === null) {
    problems.push('redeploySelection: required when to=redeploying');
  }
  if (input.to !== 'redeploying' && input.redeploySelection !== null) {
    problems.push('redeploySelection: only accepted when to=redeploying');
  }
  if (input.to === 'rolling_back' && (typeof input.rollbackTargetEventId !== 'string' || !UUID_PATTERN.test(input.rollbackTargetEventId))) {
    problems.push('rollbackTargetEventId: a deployment event uuid (a prior selection revision)');
  }
  if (input.to !== 'rolling_back' && input.rollbackTargetEventId !== null) {
    problems.push('rollbackTargetEventId: only accepted when to=rolling_back');
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('Invalid deployment transition request', problems);
  }
  if (input.redeploySelection !== null) {
    assertValidRedeploySelection(input.redeploySelection);
  }
}

// ---------------------------------------------------------------------------
// The PURE resolution evaluator (DEPLOY-AC-04's core)
// ---------------------------------------------------------------------------

/**
 * The port snapshots the evaluator consumes — EVERYTHING the gate checks,
 * already resolved through the structural ports by the module (plus the
 * live policy decision when the module already consulted the policy
 * gate). Pure data in, honest report out.
 */
export interface DeploymentResolutionSnapshots {
  readonly workspaceOwnership: DeploymentsWorkspaceOwnershipSnapshot;
  readonly playbookVersion: DeploymentsPlaybookVersionSnapshot | null;
  readonly playbook: DeploymentsPlaybookSnapshot | null;
  readonly workflowDefinitions: ReadonlyArray<{
    readonly definition: DeploymentsWorkflowDefinitionSnapshot | null;
    readonly workflow: DeploymentsWorkflowSnapshot | null;
  }>;
  readonly packInstalls: readonly DeploymentsPackInstallSnapshot[];
  readonly packVersions: ReadonlyMap<string, DeploymentsPackVersionSnapshot>;
  readonly extensionInstalls: readonly DeploymentsExtensionInstallSnapshot[];
  readonly extensionVersions: ReadonlyMap<string, DeploymentsExtensionVersionSnapshot>;
  readonly adapters: readonly DeploymentsAdapterSnapshot[];
  readonly connections: readonly DeploymentsIntegrationConnectionSnapshot[];
  readonly credentials: ReadonlyMap<string, DeploymentsCredentialReferenceSnapshot>;
  /** The fail-closed policy decision for the gated action (null = not yet evaluated). */
  readonly policyDecision: { readonly decisionId: string; readonly outcome: string } | null;
}

/** The resolution input: the tenant scope + the selection under evaluation. */
export interface DeploymentResolutionInput {
  readonly scope: {
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceId: string;
  };
  readonly selection: DeploymentSelection;
}

/**
 * Evaluates the FULL resolution contract over the snapshots — every named
 * check, honestly recorded, fail-closed composition (ok === every check
 * green). The module calls this for validate (pre-flight) AND for every
 * entry into ACTIVE (the authoritative gate). The policy check reflects
 * the pre-consulted decision: an explicit 'allow' passes; deny/unknown/
 * not-yet-evaluated FAILS (POL-001 fail-closed posture — no deployment
 * action proceeds without an explicit recorded allow).
 */
export function evaluateDeploymentResolution(
  input: DeploymentResolutionInput,
  snapshots: DeploymentResolutionSnapshots,
): DeploymentValidationReport {
  const checks: DeploymentCheckResult[] = [];

  // 1. AUTHORIZATION — the canonical scope chain resolved with every
  // boundary ACTIVE (disabled boundaries block new use; the hard
  // boundary resolution itself happened before any read).
  const ownership = snapshots.workspaceOwnership;
  const boundariesActive =
    ownership.workspace.status === 'active' &&
    ownership.client.status === 'active' &&
    ownership.clientOwnership.agency.status === 'active';
  checks.push({
    check: 'authorization',
    ok: boundariesActive,
    detail: boundariesActive
      ? `workspace ${ownership.workspace.workspaceId} / client ${ownership.client.clientId} / agency ${ownership.clientOwnership.agency.agencyId} all active`
      : `boundary statuses: workspace=${ownership.workspace.status} client=${ownership.client.status} agency=${ownership.clientOwnership.agency.status}`,
  });

  // 2. PLAYBOOK VERSION — exists, PUBLISHED (immutable approved version)
  // and usable inside the deployment's Client.
  const playbookVersion = snapshots.playbookVersion;
  const playbook = snapshots.playbook;
  const playbookOk =
    playbookVersion !== null &&
    playbookVersion.status === 'published' &&
    playbook !== null &&
    playbook.agencyId === input.scope.agencyId &&
    (playbook.clientId === null || playbook.clientId === input.scope.clientId);
  checks.push({
    check: 'playbook-version',
    ok: playbookOk,
    detail: playbookOk
      ? `playbook version ${playbookVersion!.versionId} published and in scope`
      : `playbook version ${input.selection.playbookVersionId}: ${
          playbookVersion === null
            ? 'unknown'
            : `status ${playbookVersion.status}${playbook === null ? ', owning playbook unknown' : playbook.agencyId !== input.scope.agencyId ? ', belongs to another agency' : playbook.clientId !== null && playbook.clientId !== input.scope.clientId ? ', client-scoped to another client' : ''}`
        }`,
  });

  // 3. WORKFLOW VERSIONS — every referenced definition exists, is ACTIVE,
  // belongs to a workflow of the TARGET workspace and pins the
  // deployment's playbook version.
  const workflowProblems: string[] = [];
  snapshots.workflowDefinitions.forEach((entry, index) => {
    const definitionId = input.selection.workflowDefinitionIds[index] ?? 'missing';
    const { definition, workflow } = entry;
    if (definition === null) {
      workflowProblems.push(`definition ${definitionId}: unknown`);
      return;
    }
    if (definition.status !== 'active') {
      workflowProblems.push(`definition ${definitionId}: status ${definition.status} (requires active)`);
    }
    if (definition.playbookVersionId !== input.selection.playbookVersionId) {
      workflowProblems.push(
        `definition ${definitionId}: playbook link ${definition.playbookVersionId ?? 'null'} does not match the pinned playbook version`,
      );
    }
    if (workflow === null) {
      workflowProblems.push(`definition ${definitionId}: owning workflow unknown`);
    } else if (workflow.workspaceId !== input.scope.workspaceId) {
      workflowProblems.push(
        `definition ${definitionId}: workflow ${workflow.workflowId} belongs to another workspace`,
      );
    }
  });
  checks.push({
    check: 'workflow-versions',
    ok: workflowProblems.length === 0,
    detail:
      workflowProblems.length === 0
        ? `${input.selection.workflowDefinitionIds.length} workflow definition reference(s) active, workspace-owned and playbook-linked`
        : workflowProblems.join('; '),
  });

  // 4. DOMAIN PACKS — every required pack is installed in the target
  // workspace with a registry version satisfying the constraint.
  const packProblems: string[] = [];
  for (const requirement of input.selection.requiredDomainPacks) {
    const satisfyingInstall = snapshots.packInstalls.find((install) => {
      if (install.status !== 'installed') return false;
      const packVersion = snapshots.packVersions.get(install.packId);
      return packVersion !== undefined && packVersion.packKey === requirement.name;
    });
    if (satisfyingInstall === undefined) {
      packProblems.push(`pack ${requirement.name}: no installed pack install in workspace ${input.scope.workspaceId}`);
      continue;
    }
    const packVersion = snapshots.packVersions.get(satisfyingInstall.packId)!;
    if (!satisfiesVersionConstraint(packVersion.version, requirement.versionConstraint)) {
      packProblems.push(
        `pack ${requirement.name}: installed version ${packVersion.version} does not satisfy constraint '${requirement.versionConstraint}'`,
      );
    }
  }
  checks.push({
    check: 'domain-packs',
    ok: packProblems.length === 0,
    detail:
      packProblems.length === 0
        ? `${input.selection.requiredDomainPacks.length} required domain pack(s) installed with satisfying versions`
        : packProblems.join('; '),
  });

  // 5. CAPABILITIES — extension: installed AND authorized in the target
  // workspace with a satisfying registry version; integration: adapter
  // registered AND a CONNECTED connection for the target Client.
  const capabilityProblems: string[] = [];
  const satisfyingExtensionInstalls: DeploymentsExtensionInstallSnapshot[] = [];
  const satisfyingConnections: DeploymentsIntegrationConnectionSnapshot[] = [];
  for (const requirement of input.selection.requiredCapabilities) {
    if (requirement.kind === 'extension') {
      const install = snapshots.extensionInstalls.find((entry) => {
        if (entry.status !== 'authorized') return false;
        const extensionVersion = snapshots.extensionVersions.get(entry.extensionId);
        return extensionVersion !== undefined && extensionVersion.extensionKey === requirement.name;
      });
      if (install === undefined) {
        capabilityProblems.push(
          `extension ${requirement.name}: no authorized install in workspace ${input.scope.workspaceId}`,
        );
        continue;
      }
      const extensionVersion = snapshots.extensionVersions.get(install.extensionId)!;
      if (!satisfiesVersionConstraint(extensionVersion.version, requirement.versionConstraint)) {
        capabilityProblems.push(
          `extension ${requirement.name}: authorized version ${extensionVersion.version} does not satisfy constraint '${requirement.versionConstraint}'`,
        );
        continue;
      }
      satisfyingExtensionInstalls.push(install);
    } else {
      const registered = snapshots.adapters.some((adapter) => adapter.adapterKey === requirement.name);
      if (!registered) {
        capabilityProblems.push(`integration ${requirement.name}: adapter not registered`);
        continue;
      }
      const connection = snapshots.connections.find(
        (entry) =>
          entry.clientId === input.scope.clientId &&
          entry.adapterKey === requirement.name &&
          entry.status === 'connected',
      );
      if (connection === undefined) {
        capabilityProblems.push(
          `integration ${requirement.name}: no connected connection for client ${input.scope.clientId}`,
        );
        continue;
      }
      satisfyingConnections.push(connection);
    }
  }
  checks.push({
    check: 'capabilities',
    ok: capabilityProblems.length === 0,
    detail:
      capabilityProblems.length === 0
        ? `${input.selection.requiredCapabilities.length} required capability(ies) available`
        : capabilityProblems.join('; '),
  });

  // 6. CREDENTIAL REFERENCES — every credential reference bound by the
  // satisfying extension installs (secret bindings) and the satisfying
  // integration connections is LIVE and IN SCOPE (same agency; a
  // client-narrowed reference must match the deployment's client).
  const credentialProblems: string[] = [];
  const referenceIds = new Set<string>();
  for (const install of satisfyingExtensionInstalls) {
    for (const referenceId of Object.values(install.secretBindings)) {
      referenceIds.add(referenceId);
    }
  }
  for (const connection of satisfyingConnections) {
    referenceIds.add(connection.credentialReferenceId);
  }
  for (const referenceId of referenceIds) {
    const reference = snapshots.credentials.get(referenceId);
    if (reference === undefined) {
      credentialProblems.push(`credential reference ${referenceId}: unresolved`);
      continue;
    }
    if (reference.status !== 'active') {
      credentialProblems.push(`credential reference ${referenceId}: status ${reference.status}`);
    }
    if (reference.agencyId !== input.scope.agencyId) {
      credentialProblems.push(`credential reference ${referenceId}: belongs to another agency`);
    }
    if (reference.clientId !== null && reference.clientId !== input.scope.clientId) {
      credentialProblems.push(`credential reference ${referenceId}: narrowed to another client`);
    }
  }
  checks.push({
    check: 'credentials',
    ok: credentialProblems.length === 0,
    detail:
      credentialProblems.length === 0
        ? `${referenceIds.size} credential reference(s) live and in scope`
        : credentialProblems.join('; '),
  });

  // 7. POLICY — the fail-closed deployment-dimension evaluation must be
  // an EXPLICIT allow (deny/unknown/not-yet-evaluated all fail closed).
  const policyDecision = snapshots.policyDecision;
  const policyOk = policyDecision !== null && policyDecision.outcome === 'allow';
  checks.push({
    check: 'policy',
    ok: policyOk,
    detail:
      policyDecision === null
        ? 'no policy decision recorded (fail closed)'
        : `policy decision ${policyDecision.decisionId}: ${policyDecision.outcome} (explicit allow required)`,
  });

  // 8. RUNTIME — the closed four-class vocabulary (shape-guarded at the
  // boundary; re-asserted here as the gate's honest check).
  const runtimeClass = input.selection.runtimeRequirements.runtimeClass;
  const runtimeOk = (DEPLOYMENT_RUNTIME_CLASSES as readonly string[]).includes(runtimeClass);
  checks.push({
    check: 'runtime',
    ok: runtimeOk,
    detail: runtimeOk
      ? `runtime class ${runtimeClass} requested (allocation belongs to the Execution/Runtime authority)`
      : `runtime class '${String(runtimeClass)}' is outside the closed vocabulary`,
  });

  // 9. TRIGGERS — the trigger configuration validity (schedule triggers
  // need a config; the closed kind vocabulary).
  const triggerProblems: string[] = [];
  input.selection.triggerConfig.forEach((trigger, index) => {
    if (trigger.kind !== 'manual' && trigger.kind !== 'schedule' && trigger.kind !== 'event') {
      triggerProblems.push(`trigger ${index}: unknown kind '${String((trigger as { kind?: unknown }).kind)}'`);
    }
    if (trigger.kind === 'schedule' && (trigger.config === null || trigger.config === undefined)) {
      triggerProblems.push(`trigger ${index}: schedule triggers require a config`);
    }
  });
  checks.push({
    check: 'triggers',
    ok: triggerProblems.length === 0,
    detail:
      triggerProblems.length === 0
        ? `${input.selection.triggerConfig.length} trigger(s) valid`
        : triggerProblems.join('; '),
  });

  return {
    ok: checks.every((check) => check.ok),
    checks,
    policyDecisionId: policyDecision?.decisionId ?? null,
  };
}
