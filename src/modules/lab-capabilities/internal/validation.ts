/**
 * /lab-capabilities pure contract guards (LAB-013).
 *
 * THE GATE LAYER: every shape that reaches the migration-067 tables is
 * validated HERE first (fail fast, before any durable write), mirroring
 * the CHECK fences exactly — the smallest architecture-consistent
 * interpretation of the §16/§17 declared-data discipline. The one-level
 * schema subset is the LAB-011 message-contract discipline verbatim
 * (deterministic, no JSON-pointer ambiguity); every closed vocabulary is
 * checked against the frozen public constants.
 */

import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import {
  LAB_CAPABILITY_ACTION_KINDS,
  LAB_CAPABILITY_ADAPTER_KEY_PATTERN,
  LAB_CAPABILITY_ACTORS,
  LAB_CAPABILITY_DEADLINE_MAX_MS,
  LAB_CAPABILITY_DEADLINE_MIN_MS,
  LAB_CAPABILITY_HUMAN_PLANE_AUTHORITIES,
  LAB_CAPABILITY_IMPLEMENTATION_KINDS,
  LAB_CAPABILITY_LINK_OUTCOMES,
  LAB_CAPABILITY_MAX_CONSTRAINTS,
  LAB_CAPABILITY_MAX_CONSTRAINT_LENGTH,
  LAB_CAPABILITY_MAX_REQUIREMENTS,
  LAB_CAPABILITY_MAX_VERSIONS,
  LAB_CAPABILITY_REAL_TEST_AUTHORITIES,
  LAB_CAPABILITY_REQUIREMENT_KINDS,
  LAB_CAPABILITY_SCHEMA_FIELD_TYPES,
  LAB_CAPABILITY_SCHEMA_MAX_FIELDS,
  LAB_CAPABILITY_STRATEGY_KINDS,
  LAB_CAPABILITY_VERDICTS,
  type LabCapabilityActionKind,
  type LabCapabilityActor,
  type LabCapabilityConstraint,
  type LabCapabilityGrantedRights,
  type LabCapabilityHumanPlaneCitation,
  type LabCapabilityHumanPlaneAuthority,
  type LabCapabilityImplementation,
  type LabCapabilityImplementationKind,
  type LabCapabilityImplementationReference,
  type LabCapabilityLinkOutcome,
  type LabCapabilityQualityEvaluatorDeclaration,
  type LabCapabilityRealTestAuthority,
  type LabCapabilityRealTestCitation,
  type LabCapabilityRequestedRights,
  type LabCapabilityRequirement,
  type LabCapabilityRequirementKind,
  type LabCapabilityRequiredAction,
  type LabCapabilitySchema,
  type LabCapabilitySchemaFieldType,
  type LabCapabilityStrategyCitation,
  type LabCapabilityStrategyKind,
  type LabCapabilityVerdict,
} from '../public.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAPABILITY_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const EVALUATOR_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new InvalidRequestError(`${label} must be a ${min}-${max} char string`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new InvalidRequestError(`${label} must be a finite number >= 0`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// The one-level schema subset (the LAB-011 message-contract discipline)
// ---------------------------------------------------------------------------

/** The declared-schema guard: one level, deterministic, bounded. */
export function assertValidLabCapabilitySchema(schema: LabCapabilitySchema, label: string): void {
  if (!isPlainObject(schema)) {
    throw new InvalidRequestError(`${label} must be an object`);
  }
  if (schema.type !== 'object') {
    throw new InvalidRequestError(`${label}.type must be 'object' (the disclosed schema subset)`);
  }
  if (!Array.isArray(schema.required)) {
    throw new InvalidRequestError(`${label}.required must be an array`);
  }
  if (schema.required.length > LAB_CAPABILITY_SCHEMA_MAX_FIELDS) {
    throw new InvalidRequestError(`${label}.required must hold at most ${LAB_CAPABILITY_SCHEMA_MAX_FIELDS} keys`);
  }
  if (!isPlainObject(schema.properties)) {
    throw new InvalidRequestError(`${label}.properties must be an object`);
  }
  const propertyNames = Object.keys(schema.properties);
  if (propertyNames.length < 1 || propertyNames.length > LAB_CAPABILITY_SCHEMA_MAX_FIELDS) {
    throw new InvalidRequestError(
      `${label}.properties must hold 1-${LAB_CAPABILITY_SCHEMA_MAX_FIELDS} fields`,
    );
  }
  const seen = new Set<string>();
  for (const name of schema.required) {
    if (typeof name !== 'string' || name.length === 0 || name.length > 128) {
      throw new InvalidRequestError(`${label}.required entries must be 1-128 char strings`);
    }
    if (seen.has(name)) {
      throw new InvalidRequestError(`${label}.required entry '${name}' is duplicated`);
    }
    seen.add(name);
  }
  for (const name of seen) {
    if (!Object.hasOwn(schema.properties, name)) {
      throw new InvalidRequestError(`${label}.required entry '${name}' has no matching property`);
    }
  }
  for (const [name, field] of Object.entries(schema.properties)) {
    if (name.length === 0 || name.length > 128) {
      throw new InvalidRequestError(`${label}.properties keys must be 1-128 chars`);
    }
    if (!isPlainObject(field) || !LAB_CAPABILITY_SCHEMA_FIELD_TYPES.includes(field['type'] as LabCapabilitySchemaFieldType)) {
      throw new InvalidRequestError(
        `${label}.properties['${name}'].type must be one of ${LAB_CAPABILITY_SCHEMA_FIELD_TYPES.join(', ')}`,
      );
    }
  }
  if (schema.maxKeys !== undefined && schema.maxKeys !== null) {
    if (
      typeof schema.maxKeys !== 'number' ||
      !Number.isSafeInteger(schema.maxKeys) ||
      schema.maxKeys < 1 ||
      schema.maxKeys > LAB_CAPABILITY_SCHEMA_MAX_FIELDS
    ) {
      throw new InvalidRequestError(`${label}.maxKeys must be an integer 1-${LAB_CAPABILITY_SCHEMA_MAX_FIELDS}`);
    }
  }
}

/** The run-time value enforcement (pure): every required key present with the declared type. */
export function validateValueAgainstLabCapabilitySchema(
  value: unknown,
  schema: LabCapabilitySchema,
): { ok: boolean; errors: ReadonlyArray<string> } {
  if (!isPlainObject(value)) {
    return { ok: false, errors: ['value must be an object'] };
  }
  const errors: string[] = [];
  const maxKeys = schema.maxKeys ?? LAB_CAPABILITY_SCHEMA_MAX_FIELDS;
  const keys = Object.keys(value);
  if (keys.length > maxKeys) {
    errors.push(`value holds ${keys.length} keys (maxKeys ${maxKeys})`);
  }
  for (const name of schema.required) {
    if (!Object.hasOwn(value, name)) {
      errors.push(`required key '${name}' is missing`);
    }
  }
  for (const [name, field] of Object.entries(schema.properties)) {
    if (!Object.hasOwn(value, name)) continue;
    const actual = value[name]!;
    let matches = true;
    switch (field.type) {
      case 'string':
        matches = typeof actual === 'string';
        break;
      case 'number':
        matches = typeof actual === 'number' && Number.isFinite(actual);
        break;
      case 'integer':
        matches = typeof actual === 'number' && Number.isSafeInteger(actual);
        break;
      case 'boolean':
        matches = typeof actual === 'boolean';
        break;
      case 'object':
        matches = isPlainObject(actual);
        break;
      case 'array':
        matches = Array.isArray(actual);
        break;
    }
    if (!matches) {
      errors.push(`key '${name}' must be of type ${field.type}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// The §16 declared-field guards
// ---------------------------------------------------------------------------

export function assertValidLabCapabilityQualityEvaluator(
  declaration: LabCapabilityQualityEvaluatorDeclaration,
  label: string,
): void {
  if (!isPlainObject(declaration)) {
    throw new InvalidRequestError(`${label} must be an object`);
  }
  if (typeof declaration.evaluatorId !== 'string' || !EVALUATOR_ID_PATTERN.test(declaration.evaluatorId)) {
    throw new InvalidRequestError(`${label}.evaluatorId must be 1-64 chars of [a-z0-9-]`);
  }
  boundedString(declaration.evaluatorVersion, `${label}.evaluatorVersion`, 1, 64);
  if (declaration.evaluationContract === undefined || declaration.evaluationContract === null) {
    throw new InvalidRequestError(`${label}.evaluationContract is required (the declared evaluation contract shape)`);
  }
  assertValidLabCapabilitySchema(declaration.evaluationContract, `${label}.evaluationContract`);
}

export function assertValidLabCapabilityCost(cost: { costModel: unknown; costUnits: unknown }, label: string): void {
  if (!isPlainObject(cost)) {
    throw new InvalidRequestError(`${label} must be an object`);
  }
  boundedString(cost.costModel, `${label}.costModel`, 1, 64);
  nonNegativeNumber(cost.costUnits, `${label}.costUnits`);
}

export function assertValidLabCapabilityLatencyDeadlineMs(deadlineMs: unknown, label: string): number {
  if (
    typeof deadlineMs !== 'number' ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < LAB_CAPABILITY_DEADLINE_MIN_MS ||
    deadlineMs > LAB_CAPABILITY_DEADLINE_MAX_MS
  ) {
    throw new InvalidRequestError(
      `${label} must be an integer ${LAB_CAPABILITY_DEADLINE_MIN_MS}-${LAB_CAPABILITY_DEADLINE_MAX_MS} (ms)`,
    );
  }
  return deadlineMs;
}

export function assertValidLabCapabilityLatency(
  latency: { expectedP50Ms: unknown; expectedP95Ms: unknown; deadlineMs: unknown },
  label: string,
): void {
  if (!isPlainObject(latency)) {
    throw new InvalidRequestError(`${label} must be an object`);
  }
  const p50 = nonNegativeNumber(latency.expectedP50Ms, `${label}.expectedP50Ms`);
  const p95 = nonNegativeNumber(latency.expectedP95Ms, `${label}.expectedP95Ms`);
  if (p95 < p50) {
    throw new InvalidRequestError(`${label}.expectedP95Ms may not be below expectedP50Ms`);
  }
  assertValidLabCapabilityLatencyDeadlineMs(latency.deadlineMs, `${label}.deadlineMs`);
}

export function assertValidLabCapabilityImplementation(
  implementation: LabCapabilityImplementation,
  label: string,
): void {
  if (!isPlainObject(implementation)) {
    throw new InvalidRequestError(`${label} must be an object`);
  }
  boundedString(implementation.implementationId, `${label}.implementationId`, 1, 128);
  boundedString(implementation.implementationVersion, `${label}.implementationVersion`, 1, 64);
  if (
    typeof implementation.implementationKind !== 'string' ||
    !LAB_CAPABILITY_IMPLEMENTATION_KINDS.includes(implementation.implementationKind as LabCapabilityImplementationKind)
  ) {
    throw new InvalidRequestError(
      `${label}.implementationKind must be one of ${LAB_CAPABILITY_IMPLEMENTATION_KINDS.join(', ')}`,
    );
  }
}

export function assertValidLabCapabilityImplementationReference(
  reference: LabCapabilityImplementationReference | null | undefined,
  label: string,
): LabCapabilityImplementationReference | null {
  if (reference === null || reference === undefined) {
    return null;
  }
  if (!isPlainObject(reference)) {
    throw new InvalidRequestError(`${label} must be an object or null`);
  }
  boundedString(reference.implementationId, `${label}.implementationId`, 1, 128);
  boundedString(reference.implementationVersion, `${label}.implementationVersion`, 1, 64);
  return { implementationId: reference.implementationId, implementationVersion: reference.implementationVersion };
}

export function assertValidLabCapabilityRequirements(
  requirements: ReadonlyArray<LabCapabilityRequirement>,
  label: string,
): void {
  if (!Array.isArray(requirements)) {
    throw new InvalidRequestError(`${label} must be an array`);
  }
  if (requirements.length > LAB_CAPABILITY_MAX_REQUIREMENTS) {
    throw new InvalidRequestError(`${label} must hold at most ${LAB_CAPABILITY_MAX_REQUIREMENTS} entries`);
  }
  for (const requirement of requirements) {
    if (!isPlainObject(requirement)) {
      throw new InvalidRequestError(`${label} entries must be objects`);
    }
    if (
      typeof requirement.requirementKind !== 'string' ||
      !LAB_CAPABILITY_REQUIREMENT_KINDS.includes(requirement.requirementKind as LabCapabilityRequirementKind)
    ) {
      throw new InvalidRequestError(
        `${label}.requirementKind must be one of ${LAB_CAPABILITY_REQUIREMENT_KINDS.join(', ')}`,
      );
    }
    boundedString(requirement.description, `${label}.description`, 1, 512);
  }
}

export function assertValidLabCapabilityConstraints(
  constraints: ReadonlyArray<LabCapabilityConstraint>,
  label: string,
): void {
  if (!Array.isArray(constraints)) {
    throw new InvalidRequestError(`${label} must be an array`);
  }
  if (constraints.length > LAB_CAPABILITY_MAX_CONSTRAINTS) {
    throw new InvalidRequestError(`${label} must hold at most ${LAB_CAPABILITY_MAX_CONSTRAINTS} entries`);
  }
  for (const constraint of constraints) {
    boundedString(constraint, `${label} entries`, 1, LAB_CAPABILITY_MAX_CONSTRAINT_LENGTH);
  }
}

// ---------------------------------------------------------------------------
// The §17 stage payload guards
// ---------------------------------------------------------------------------

export function assertValidLabCapabilityStrategyCitation(
  citation: LabCapabilityStrategyCitation,
  label: string,
): void {
  if (!isPlainObject(citation)) {
    throw new InvalidRequestError(`${label} must be an object`);
  }
  if (
    typeof citation.strategyKind !== 'string' ||
    !LAB_CAPABILITY_STRATEGY_KINDS.includes(citation.strategyKind as LabCapabilityStrategyKind)
  ) {
    throw new InvalidRequestError(`${label}.strategyKind must be one of ${LAB_CAPABILITY_STRATEGY_KINDS.join(', ')}`);
  }
  boundedString(citation.strategyReference, `${label}.strategyReference`, 1, 256);
}

export function assertValidLabCapabilityRequiredAction(action: LabCapabilityRequiredAction, label: string): void {
  if (!isPlainObject(action)) {
    throw new InvalidRequestError(`${label} must be an object`);
  }
  if (typeof action.actionKind !== 'string' || !LAB_CAPABILITY_ACTION_KINDS.includes(action.actionKind as LabCapabilityActionKind)) {
    throw new InvalidRequestError(`${label}.actionKind must be one of ${LAB_CAPABILITY_ACTION_KINDS.join(', ')}`);
  }
  boundedString(action.description, `${label}.description`, 1, 1024);
  boundedString(action.qualityBar, `${label}.qualityBar`, 1, 512);
}

export function assertValidLabCapabilityRequestedRights(rights: LabCapabilityRequestedRights, label: string): void {
  if (!isPlainObject(rights)) {
    throw new InvalidRequestError(`${label} must be an object`);
  }
  boundedString(rights.usageScope, `${label}.usageScope`, 1, 256);
  if (typeof rights.redistribution !== 'boolean') {
    throw new InvalidRequestError(`${label}.redistribution must be a boolean`);
  }
  if (typeof rights.attributionRequired !== 'boolean') {
    throw new InvalidRequestError(`${label}.attributionRequired must be a boolean`);
  }
  if (rights.licenseTerms !== null && rights.licenseTerms !== undefined) {
    boundedString(rights.licenseTerms, `${label}.licenseTerms`, 1, 512);
  }
}

export function assertValidLabCapabilityGrantedRights(
  rights: LabCapabilityGrantedRights | null | undefined,
  label: string,
): LabCapabilityGrantedRights | null {
  if (rights === null || rights === undefined) {
    return null;
  }
  assertValidLabCapabilityRequestedRights(rights, label);
  return {
    usageScope: rights.usageScope,
    redistribution: rights.redistribution,
    attributionRequired: rights.attributionRequired,
    licenseTerms: rights.licenseTerms ?? null,
  };
}

export function assertValidLabCapabilityHumanPlaneCitation(
  citation: LabCapabilityHumanPlaneCitation,
  label: string,
): void {
  if (!isPlainObject(citation)) {
    throw new InvalidRequestError(`${label} must be an object`);
  }
  if (
    typeof citation.planeAuthority !== 'string' ||
    !LAB_CAPABILITY_HUMAN_PLANE_AUTHORITIES.includes(citation.planeAuthority as LabCapabilityHumanPlaneAuthority)
  ) {
    throw new InvalidRequestError(
      `${label}.planeAuthority must be one of ${LAB_CAPABILITY_HUMAN_PLANE_AUTHORITIES.join(', ')} (the canonical human plane)`,
    );
  }
  boundedString(citation.recordReference, `${label}.recordReference`, 1, 256);
}

export function assertValidLabCapabilityRealTestCitation(citation: LabCapabilityRealTestCitation, label: string): void {
  if (!isPlainObject(citation)) {
    throw new InvalidRequestError(`${label} must be an object`);
  }
  if (
    typeof citation.authority !== 'string' ||
    !LAB_CAPABILITY_REAL_TEST_AUTHORITIES.includes(citation.authority as LabCapabilityRealTestAuthority)
  ) {
    throw new InvalidRequestError(
      `${label}.authority must be one of ${LAB_CAPABILITY_REAL_TEST_AUTHORITIES.join(', ')}`,
    );
  }
  boundedString(citation.recordReference, `${label}.recordReference`, 1, 256);
}

export function assertValidLabCapabilityActor(actor: LabCapabilityActor | undefined, label: string): LabCapabilityActor {
  if (actor === undefined || actor === null) {
    return 'autonomous';
  }
  if (typeof actor !== 'string' || !LAB_CAPABILITY_ACTORS.includes(actor as LabCapabilityActor)) {
    throw new InvalidRequestError(`${label} must be one of ${LAB_CAPABILITY_ACTORS.join(', ')}`);
  }
  return actor;
}

export function assertValidLabCapabilityVerdict(verdict: LabCapabilityVerdict, label: string): void {
  if (typeof verdict !== 'string' || !LAB_CAPABILITY_VERDICTS.includes(verdict as LabCapabilityVerdict)) {
    throw new InvalidRequestError(`${label} must be one of ${LAB_CAPABILITY_VERDICTS.join(', ')}`);
  }
}

export function assertValidLabCapabilityLinkOutcome(outcome: LabCapabilityLinkOutcome, label: string): void {
  if (typeof outcome !== 'string' || !LAB_CAPABILITY_LINK_OUTCOMES.includes(outcome as LabCapabilityLinkOutcome)) {
    throw new InvalidRequestError(`${label} must be one of ${LAB_CAPABILITY_LINK_OUTCOMES.join(', ')}`);
  }
}

export function assertValidLabCapabilityAdapterKey(adapterKey: string, label: string): void {
  if (typeof adapterKey !== 'string' || !LAB_CAPABILITY_ADAPTER_KEY_PATTERN.test(adapterKey)) {
    throw new InvalidRequestError(`${label} must be 1-64 chars of [a-z0-9-]`);
  }
}

export function assertValidUuidShape(resource: string, id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new InvalidRequestError(`${resource} must be a uuid`);
  }
}

export function isUuidShape(id: string): boolean {
  return UUID_PATTERN.test(id);
}

export function assertValidLabCapabilityDispatchProvenance(
  provenance: { actor: unknown; recordedVia: unknown; correlationId: unknown; causationId: unknown },
  label: string,
): void {
  if (!isPlainObject(provenance)) {
    throw new InvalidRequestError(`${label} must be an object`);
  }
  boundedString(provenance.actor, `${label}.actor`, 1, 128);
  boundedString(provenance.recordedVia, `${label}.recordedVia`, 1, 128);
  boundedString(provenance.correlationId, `${label}.correlationId`, 1, 128);
  if (provenance.causationId !== null && provenance.causationId !== undefined) {
    boundedString(provenance.causationId, `${label}.causationId`, 1, 128);
  }
}

export function assertValidLabCapabilityEvidence(evidence: unknown, label: string): void {
  if (!isPlainObject(evidence)) {
    throw new InvalidRequestError(`${label} must be an object`);
  }
}

export function assertValidLabCapabilityDeclarationInput(
  declaration: {
    capabilityKey: unknown;
    displayName: unknown;
    provenanceSourceNote: unknown;
  },
  label: string,
): void {
  if (!isPlainObject(declaration)) {
    throw new InvalidRequestError(`${label} must be an object`);
  }
  if (typeof declaration.capabilityKey !== 'string' || !CAPABILITY_KEY_PATTERN.test(declaration.capabilityKey)) {
    throw new InvalidRequestError(`${label}.capabilityKey must be 1-64 chars of [a-z0-9-]`);
  }
  boundedString(declaration.displayName, `${label}.displayName`, 1, 128);
  boundedString(declaration.provenanceSourceNote, `${label}.provenanceSourceNote`, 1, 512);
}

export function assertValidVersionChainBound(currentVersion: number): void {
  if (currentVersion >= LAB_CAPABILITY_MAX_VERSIONS) {
    throw new InvalidRequestError(
      `capability version chain has reached the bound (${LAB_CAPABILITY_MAX_VERSIONS}) — corrections are no longer appendable`,
    );
  }
}
