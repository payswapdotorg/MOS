/**
 * /lab-agent-body contract guards (LAB-011) — the PURE deterministic
 * validation core.
 *
 * These guards enforce the frozen agent-body contract semantics (spec/
 * architecture-v1.7-marketing-lab.md §14 "Agent Body" — the verbatim
 * field set as declared data; §22 multi-tenancy — carried by the
 * module's scope discipline; spec/effective-backlog-v1.7.md LAB-011
 * acceptance: "model-agnostic Agent Body execution with tools, memory,
 * permissions, budgets and evaluation hooks... no second model
 * router"):
 *
 *   - the FULL §14 body-contract discipline (role contract, the
 *     message-schema subset for input/output contracts, tool
 *     declarations, the permission subset, memory-interface
 *     declarations with capacity fences, communication channels, the
 *     SAFE action-verb subset, opaque capability references, the
 *     budget caps, the latency deadline, evaluation-hook declarations,
 *     the mandatory safety-constraint subset);
 *   - the message-schema subset validator (deterministic, one level
 *     deep — the disclosed frozen subset) + the run-time message
 *     enforcement;
 *   - the reserved control-channel fence (a schema declaring
 *     agentToolCalls/agentMemoryWrites is rejected — the collision
 *     fence) and the control-channel stripper (the final output
 *     message is the response minus the reserved keys);
 *   - the agent-instance run-input fences (the opaque body-version
 *     reference, the model identity as DATA, the input message shape);
 *   - the opaque body-version reference format (what /lab cites).
 *
 * Pure functions: no clock, no randomness, no network — the unit
 * battery pins every rule.
 */

import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import {
  LAB_AGENT_BODY_ACTION_KINDS,
  LAB_AGENT_BODY_ACTION_VERBS,
  LAB_AGENT_BODY_LATENCY_DEADLINE_MAX_MS,
  LAB_AGENT_BODY_LATENCY_DEADLINE_MIN_MS,
  LAB_AGENT_BODY_MEMORY_KINDS,
  LAB_AGENT_BODY_MEMORY_WRITES_KEY,
  LAB_AGENT_BODY_MESSAGE_FIELD_TYPES,
  LAB_AGENT_BODY_REFERENCE_PATTERN,
  LAB_AGENT_BODY_SAFETY_CONSTRAINTS,
  LAB_AGENT_BODY_TOOL_CALLS_KEY,
  type LabAgentBodyActionKind,
  type LabAgentBodyContract,
  type LabAgentMessageContractSchema,
  type LabAgentBodyMemoryInterfaceDeclaration,
  type LabAgentBodyScope,
  type LabAgentBodyToolDeclaration,
  type RunLabAgentInstanceInput,
} from '../public.ts';

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MESSAGE_KEYS = 64;
const MAX_PAYLOAD_VALUE_BYTES = 65_536;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedTrimmedString(value: unknown, min: number, max: number): boolean {
  return typeof value === 'string' && value.length >= min && value.length <= max && value.length === value.trim().length;
}

// ---------------------------------------------------------------------------
// The opaque body-version reference (the /lab agentBodyVersions format).
// ---------------------------------------------------------------------------

/** Formats the opaque body-version reference (`<bodyId>#v<version>`) — the exact string /lab organization candidates cite. */
export function formatLabAgentBodyVersionReference(bodyId: string, bodyVersion: number): string {
  return `${bodyId}#v${bodyVersion}`;
}

/** Parses an opaque body-version reference into (bodyId, bodyVersion); throws InvalidRequestError on malformed shape. */
export function parseLabAgentBodyVersionReference(reference: string): { bodyId: string; bodyVersion: number } {
  if (typeof reference !== 'string' || !LAB_AGENT_BODY_REFERENCE_PATTERN.test(reference)) {
    throw new InvalidRequestError('bodyVersionReference must be an opaque body-version reference (<bodyId>#v<version>)');
  }
  const separator = reference.indexOf('#v');
  return {
    bodyId: reference.slice(0, separator),
    bodyVersion: Number(reference.slice(separator + 2)),
  };
}

// ---------------------------------------------------------------------------
// The message-schema subset (§14 input/output contracts).
// ---------------------------------------------------------------------------

/**
 * The message-schema subset guard: `{ type: 'object', required,
 * properties, maxKeys? }` — one level deep, deterministic. The
 * reserved control-channel keys (agentToolCalls / agentMemoryWrites)
 * may NOT be declared as properties (the collision fence: the runtime
 * protocol owns those keys).
 */
export function assertValidLabAgentMessageSchema(schema: LabAgentMessageContractSchema, label: string): void {
  if (!isPlainObject(schema)) {
    throw new InvalidRequestError(`${label} must be an object`);
  }
  if (schema.type !== 'object') {
    throw new InvalidRequestError(`${label}.type must be 'object' (the disclosed schema subset)`);
  }
  if (!Array.isArray(schema.required)) {
    throw new InvalidRequestError(`${label}.required must be an array`);
  }
  if (schema.required.length > MAX_MESSAGE_KEYS) {
    throw new InvalidRequestError(`${label}.required must hold at most ${MAX_MESSAGE_KEYS} keys`);
  }
  if (!isPlainObject(schema.properties)) {
    throw new InvalidRequestError(`${label}.properties must be an object`);
  }
  const propertyNames = Object.keys(schema.properties);
  if (propertyNames.length < 1 || propertyNames.length > MAX_MESSAGE_KEYS) {
    throw new InvalidRequestError(`${label}.properties must hold 1-${MAX_MESSAGE_KEYS} fields`);
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
    if (name === LAB_AGENT_BODY_TOOL_CALLS_KEY || name === LAB_AGENT_BODY_MEMORY_WRITES_KEY) {
      throw new InvalidRequestError(`${label}.properties may not declare the reserved control-channel key '${name}'`);
    }
    if (!isPlainObject(field) || !LAB_AGENT_BODY_MESSAGE_FIELD_TYPES.includes(field['type'] as never)) {
      throw new InvalidRequestError(
        `${label}.properties['${name}'].type must be one of ${LAB_AGENT_BODY_MESSAGE_FIELD_TYPES.join(', ')}`,
      );
    }
  }
  if (schema.maxKeys !== undefined && schema.maxKeys !== null) {
    if (typeof schema.maxKeys !== 'number' || !Number.isSafeInteger(schema.maxKeys) || schema.maxKeys < 1 || schema.maxKeys > MAX_MESSAGE_KEYS) {
      throw new InvalidRequestError(`${label}.maxKeys must be an integer 1-${MAX_MESSAGE_KEYS}`);
    }
  }
}

/**
 * The run-time message enforcement (deterministic): every required key
 * present with the declared type; present properties type-checked;
 * unknown keys allowed but bounded by the schema's maxKeys (default
 * ${MAX_MESSAGE_KEYS}); values bounded in serialized size (the honest
 * payload fence).
 */
export function validateLabAgentMessageAgainstContract(
  schema: LabAgentMessageContractSchema,
  message: unknown,
  label: string,
): { ok: true } | { ok: false; violations: ReadonlyArray<string> } {
  if (!isPlainObject(message)) {
    return { ok: false, violations: [`${label} must be an object`] };
  }
  const violations: string[] = [];
  const maxKeys = schema.maxKeys ?? MAX_MESSAGE_KEYS;
  const keys = Object.keys(message);
  if (keys.length > maxKeys) {
    violations.push(`${label} holds ${keys.length} keys (max ${maxKeys})`);
  }
  for (const key of schema.required) {
    if (!Object.hasOwn(message, key)) {
      violations.push(`${label} is missing the required key '${key}'`);
    }
  }
  for (const [name, field] of Object.entries(schema.properties)) {
    if (!Object.hasOwn(message, name)) continue;
    const value = message[name];
    const expected = field['type'];
    let matches = false;
    switch (expected) {
      case 'string':
        matches = typeof value === 'string';
        break;
      case 'number':
        matches = typeof value === 'number' && Number.isFinite(value);
        break;
      case 'integer':
        matches = typeof value === 'number' && Number.isSafeInteger(value);
        break;
      case 'boolean':
        matches = typeof value === 'boolean';
        break;
      case 'object':
        matches = isPlainObject(value);
        break;
      case 'array':
        matches = Array.isArray(value);
        break;
    }
    if (!matches) {
      violations.push(`${label}['${name}'] must be of type ${expected}`);
    }
  }
  try {
    if (JSON.stringify(message).length > MAX_PAYLOAD_VALUE_BYTES) {
      violations.push(`${label} exceeds the ${MAX_PAYLOAD_VALUE_BYTES}-byte payload bound`);
    }
  } catch {
    violations.push(`${label} is not JSON-serializable`);
  }
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

/**
 * Strips the reserved runtime control channels from a model response —
 * the OUTPUT-CONTRACT MESSAGE is the response minus agentToolCalls /
 * agentMemoryWrites (pure; exported for the runtime + tests).
 */
export function stripRuntimeControlChannels(
  response: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(response)) {
    if (key === LAB_AGENT_BODY_TOOL_CALLS_KEY || key === LAB_AGENT_BODY_MEMORY_WRITES_KEY) continue;
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The FULL §14 body-contract discipline.
// ---------------------------------------------------------------------------

function assertToolDeclaration(tool: unknown, index: number): asserts tool is LabAgentBodyToolDeclaration {
  if (!isPlainObject(tool)) {
    throw new InvalidRequestError(`contract.tools[${index}] must be an object`);
  }
  if (typeof tool.toolId !== 'string' || !ID_PATTERN.test(tool.toolId)) {
    throw new InvalidRequestError(`contract.tools[${index}].toolId must be 1-64 chars of [a-z0-9-]`);
  }
  if (!LAB_AGENT_BODY_ACTION_KINDS.includes(tool.actionKind as LabAgentBodyActionKind)) {
    throw new InvalidRequestError(
      `contract.tools[${index}].actionKind must be one of ${LAB_AGENT_BODY_ACTION_KINDS.join(', ')}`,
    );
  }
  if (tool.description !== undefined && tool.description !== null && !boundedTrimmedString(tool.description, 0, 512)) {
    throw new InvalidRequestError(`contract.tools[${index}].description must be a trimmed string of 0-512 chars`);
  }
}

function assertMemoryInterface(memory: unknown, index: number): asserts memory is LabAgentBodyMemoryInterfaceDeclaration {
  if (!isPlainObject(memory)) {
    throw new InvalidRequestError(`contract.memoryInterfaces[${index}] must be an object`);
  }
  if (typeof memory.memoryId !== 'string' || !ID_PATTERN.test(memory.memoryId)) {
    throw new InvalidRequestError(`contract.memoryInterfaces[${index}].memoryId must be 1-64 chars of [a-z0-9-]`);
  }
  if (!LAB_AGENT_BODY_MEMORY_KINDS.includes(memory.kind as never)) {
    throw new InvalidRequestError(`contract.memoryInterfaces[${index}].kind must be one of ${LAB_AGENT_BODY_MEMORY_KINDS.join(', ')}`);
  }
  if (
    typeof memory.capacityEntries !== 'number' ||
    !Number.isSafeInteger(memory.capacityEntries) ||
    memory.capacityEntries < 1 ||
    memory.capacityEntries > 1000
  ) {
    throw new InvalidRequestError(`contract.memoryInterfaces[${index}].capacityEntries must be an integer 1-1000`);
  }
}

/**
 * The FULL §14 Agent Body contract guard: the complete declared field
 * set with every closed vocabulary, bound and uniqueness fence. A body
 * contract that passes this guard is honest declared data — the
 * migration-063 CHECK fences are the DB backstop.
 */
export function assertValidLabAgentBodyContract(contract: LabAgentBodyContract): void {
  if (!isPlainObject(contract)) {
    throw new InvalidRequestError('contract must be an object');
  }

  // --- role contract ---
  const role = contract.roleContract;
  if (!isPlainObject(role)) {
    throw new InvalidRequestError('contract.roleContract must be an object');
  }
  if (typeof role.role !== 'string' || !boundedTrimmedString(role.role, 1, 128)) {
    throw new InvalidRequestError('contract.roleContract.role must be a trimmed string of 1-128 chars');
  }
  if (role.description !== undefined && role.description !== null && !boundedTrimmedString(role.description, 0, 2000)) {
    throw new InvalidRequestError('contract.roleContract.description must be a trimmed string of 0-2000 chars');
  }

  // --- input/output contracts (the schema subset) ---
  assertValidLabAgentMessageSchema(contract.inputContract, 'contract.inputContract');
  assertValidLabAgentMessageSchema(contract.outputContract, 'contract.outputContract');

  // --- tools (0-32, unique ids) ---
  if (!Array.isArray(contract.tools)) {
    throw new InvalidRequestError('contract.tools must be an array');
  }
  if (contract.tools.length > 32) {
    throw new InvalidRequestError('contract.tools must hold at most 32 declarations');
  }
  const toolIds = new Set<string>();
  contract.tools.forEach((tool, index) => {
    assertToolDeclaration(tool, index);
    if (toolIds.has(tool.toolId)) {
      throw new InvalidRequestError(`contract.tools toolId '${tool.toolId}' is duplicated`);
    }
    toolIds.add(tool.toolId);
  });

  // --- permissions (non-empty subset of the action-kind vocabulary) ---
  if (!Array.isArray(contract.permissions) || contract.permissions.length < 1 || contract.permissions.length > LAB_AGENT_BODY_ACTION_KINDS.length) {
    throw new InvalidRequestError('contract.permissions must be a non-empty subset of the action-kind vocabulary');
  }
  const permissionsSeen = new Set<string>();
  for (const permission of contract.permissions) {
    if (!LAB_AGENT_BODY_ACTION_KINDS.includes(permission as LabAgentBodyActionKind)) {
      throw new InvalidRequestError(`contract.permissions entry '${String(permission)}' is not in the closed action-kind vocabulary`);
    }
    if (permissionsSeen.has(permission)) {
      throw new InvalidRequestError(`contract.permissions entry '${String(permission)}' is duplicated`);
    }
    permissionsSeen.add(permission);
  }

  // --- memory interfaces (0-16, unique ids) ---
  if (!Array.isArray(contract.memoryInterfaces)) {
    throw new InvalidRequestError('contract.memoryInterfaces must be an array');
  }
  if (contract.memoryInterfaces.length > 16) {
    throw new InvalidRequestError('contract.memoryInterfaces must hold at most 16 declarations');
  }
  const memoryIds = new Set<string>();
  contract.memoryInterfaces.forEach((memory, index) => {
    assertMemoryInterface(memory, index);
    if (memoryIds.has(memory.memoryId)) {
      throw new InvalidRequestError(`contract.memoryInterfaces memoryId '${memory.memoryId}' is duplicated`);
    }
    memoryIds.add(memory.memoryId);
  });

  // --- communication interface (0-16 channels, unique ids) ---
  if (!Array.isArray(contract.communicationInterface)) {
    throw new InvalidRequestError('contract.communicationInterface must be an array');
  }
  if (contract.communicationInterface.length > 16) {
    throw new InvalidRequestError('contract.communicationInterface must hold at most 16 channels');
  }
  const channelIds = new Set<string>();
  for (const [index, channel] of contract.communicationInterface.entries()) {
    if (!isPlainObject(channel)) {
      throw new InvalidRequestError(`contract.communicationInterface[${index}] must be an object`);
    }
    if (typeof channel.channelId !== 'string' || !ID_PATTERN.test(channel.channelId)) {
      throw new InvalidRequestError(`contract.communicationInterface[${index}].channelId must be 1-64 chars of [a-z0-9-]`);
    }
    if (channel.direction !== 'inbound' && channel.direction !== 'outbound') {
      throw new InvalidRequestError(`contract.communicationInterface[${index}].direction must be 'inbound' or 'outbound'`);
    }
    if (typeof channel.messageKind !== 'string' || !boundedTrimmedString(channel.messageKind, 1, 64)) {
      throw new InvalidRequestError(`contract.communicationInterface[${index}].messageKind must be a trimmed string of 1-64 chars`);
    }
    if (channelIds.has(channel.channelId)) {
      throw new InvalidRequestError(`contract.communicationInterface channelId '${channel.channelId}' is duplicated`);
    }
    channelIds.add(channel.channelId);
  }

  // --- action interface (0-16, subset of the SAFE action-verb vocabulary) ---
  if (!Array.isArray(contract.actionInterface)) {
    throw new InvalidRequestError('contract.actionInterface must be an array');
  }
  if (contract.actionInterface.length > 16) {
    throw new InvalidRequestError('contract.actionInterface must hold at most 16 verbs');
  }
  const verbsSeen = new Set<string>();
  for (const verb of contract.actionInterface) {
    if (!LAB_AGENT_BODY_ACTION_VERBS.includes(verb as never)) {
      throw new InvalidRequestError(`contract.actionInterface entry '${String(verb)}' is not in the closed safe action-verb vocabulary`);
    }
    if (verbsSeen.has(verb)) {
      throw new InvalidRequestError(`contract.actionInterface entry '${String(verb)}' is duplicated`);
    }
    verbsSeen.add(verb);
  }

  // --- capabilities (0-64 OPAQUE strings — LAB-013 owns the engine) ---
  if (!Array.isArray(contract.capabilities)) {
    throw new InvalidRequestError('contract.capabilities must be an array');
  }
  if (contract.capabilities.length > 64) {
    throw new InvalidRequestError('contract.capabilities must hold at most 64 references');
  }
  const capabilitiesSeen = new Set<string>();
  for (const capability of contract.capabilities) {
    if (typeof capability !== 'string' || !boundedTrimmedString(capability, 1, 128)) {
      throw new InvalidRequestError('contract.capabilities entries must be trimmed strings of 1-128 chars');
    }
    if (capabilitiesSeen.has(capability)) {
      throw new InvalidRequestError(`contract.capabilities entry '${capability}' is duplicated`);
    }
    capabilitiesSeen.add(capability);
  }

  // --- budget (the per-run caps) ---
  const budget = contract.budget;
  if (!isPlainObject(budget)) {
    throw new InvalidRequestError('contract.budget must be an object');
  }
  if (typeof budget.maxModelInvocations !== 'number' || !Number.isSafeInteger(budget.maxModelInvocations) || budget.maxModelInvocations < 1 || budget.maxModelInvocations > 10) {
    throw new InvalidRequestError('contract.budget.maxModelInvocations must be an integer 1-10');
  }
  if (typeof budget.maxToolInvocations !== 'number' || !Number.isSafeInteger(budget.maxToolInvocations) || budget.maxToolInvocations < 0 || budget.maxToolInvocations > 100) {
    throw new InvalidRequestError('contract.budget.maxToolInvocations must be an integer 0-100');
  }
  if (typeof budget.maxTokensIn !== 'number' || !Number.isSafeInteger(budget.maxTokensIn) || budget.maxTokensIn < 1 || budget.maxTokensIn > 10_000_000) {
    throw new InvalidRequestError('contract.budget.maxTokensIn must be an integer 1-10000000');
  }
  if (typeof budget.maxTokensOut !== 'number' || !Number.isSafeInteger(budget.maxTokensOut) || budget.maxTokensOut < 1 || budget.maxTokensOut > 10_000_000) {
    throw new InvalidRequestError('contract.budget.maxTokensOut must be an integer 1-10000000');
  }
  if (typeof budget.maxCostUnits !== 'number' || !Number.isFinite(budget.maxCostUnits) || budget.maxCostUnits < 0 || budget.maxCostUnits > 1_000_000) {
    throw new InvalidRequestError('contract.budget.maxCostUnits must be a finite number >= 0');
  }

  // --- latency limits ---
  const latency = contract.latencyLimits;
  if (!isPlainObject(latency)) {
    throw new InvalidRequestError('contract.latencyLimits must be an object');
  }
  if (
    typeof latency.deadlineMs !== 'number' ||
    !Number.isSafeInteger(latency.deadlineMs) ||
    latency.deadlineMs < LAB_AGENT_BODY_LATENCY_DEADLINE_MIN_MS ||
    latency.deadlineMs > LAB_AGENT_BODY_LATENCY_DEADLINE_MAX_MS
  ) {
    throw new InvalidRequestError(
      `contract.latencyLimits.deadlineMs must be an integer ${LAB_AGENT_BODY_LATENCY_DEADLINE_MIN_MS}-${LAB_AGENT_BODY_LATENCY_DEADLINE_MAX_MS}`,
    );
  }

  // --- evaluation hooks (0-16, unique ids) ---
  if (!Array.isArray(contract.evaluationHooks)) {
    throw new InvalidRequestError('contract.evaluationHooks must be an array');
  }
  if (contract.evaluationHooks.length > 16) {
    throw new InvalidRequestError('contract.evaluationHooks must hold at most 16 declarations');
  }
  const hookIds = new Set<string>();
  for (const [index, hook] of contract.evaluationHooks.entries()) {
    if (!isPlainObject(hook)) {
      throw new InvalidRequestError(`contract.evaluationHooks[${index}] must be an object`);
    }
    if (typeof hook.hookId !== 'string' || !ID_PATTERN.test(hook.hookId)) {
      throw new InvalidRequestError(`contract.evaluationHooks[${index}].hookId must be 1-64 chars of [a-z0-9-]`);
    }
    if (hookIds.has(hook.hookId)) {
      throw new InvalidRequestError(`contract.evaluationHooks hookId '${hook.hookId}' is duplicated`);
    }
    hookIds.add(hook.hookId);
  }

  // --- safety constraints (NON-EMPTY subset of the §21 vocabulary) ---
  if (!Array.isArray(contract.safetyConstraints) || contract.safetyConstraints.length < 1 || contract.safetyConstraints.length > LAB_AGENT_BODY_SAFETY_CONSTRAINTS.length) {
    throw new InvalidRequestError('contract.safetyConstraints must be a non-empty subset of the safety-constraint vocabulary');
  }
  const safetySeen = new Set<string>();
  for (const constraint of contract.safetyConstraints) {
    if (!LAB_AGENT_BODY_SAFETY_CONSTRAINTS.includes(constraint as never)) {
      throw new InvalidRequestError(`contract.safetyConstraints entry '${String(constraint)}' is not in the closed safety-constraint vocabulary`);
    }
    if (safetySeen.has(constraint)) {
      throw new InvalidRequestError(`contract.safetyConstraints entry '${String(constraint)}' is duplicated`);
    }
    safetySeen.add(constraint);
  }
}

// ---------------------------------------------------------------------------
// The agent-instance run-input fences.
// ---------------------------------------------------------------------------

/**
 * The run-input fences: the scope shape, the opaque body-version
 * reference, the model identity as DATA (a uuid-shaped
 * /ai-runtime registry id — resolution happens through the port at
 * run time, NEVER selection here), the input message shape (an object
 * that does NOT carry the reserved control keys — those are
 * model-response channels) and the required per-call ports.
 */
export function assertValidRunLabAgentInstanceInput(input: RunLabAgentInstanceInput): void {
  if (!isPlainObject(input)) {
    throw new InvalidRequestError('run input must be an object');
  }
  const scope = input.scope as LabAgentBodyScope;
  if (!isPlainObject(scope) || !UUID_PATTERN.test(String(scope.agencyId)) || !UUID_PATTERN.test(String(scope.clientId))) {
    throw new InvalidRequestError('scope.agencyId and scope.clientId must be agency/client ids');
  }
  if (scope.workspaceId !== undefined && scope.workspaceId !== null && !UUID_PATTERN.test(String(scope.workspaceId))) {
    throw new InvalidRequestError('scope.workspaceId must be a workspace id or null');
  }
  parseLabAgentBodyVersionReference(input.bodyVersionReference);
  if (typeof input.modelRegistryId !== 'string' || !UUID_PATTERN.test(input.modelRegistryId)) {
    throw new InvalidRequestError('modelRegistryId must be a /ai-runtime model identity (the caller-selected registry id)');
  }
  if (!isPlainObject(input.inputMessage)) {
    throw new InvalidRequestError('inputMessage must be an object');
  }
  if (Object.hasOwn(input.inputMessage, LAB_AGENT_BODY_TOOL_CALLS_KEY) || Object.hasOwn(input.inputMessage, LAB_AGENT_BODY_MEMORY_WRITES_KEY)) {
    throw new InvalidRequestError(
      `inputMessage may not carry the reserved control-channel keys ('${LAB_AGENT_BODY_TOOL_CALLS_KEY}'/'${LAB_AGENT_BODY_MEMORY_WRITES_KEY}') — those are model-response channels`,
    );
  }
  if (input.addressedChannel !== undefined && input.addressedChannel !== null) {
    if (typeof input.addressedChannel !== 'string' || !ID_PATTERN.test(input.addressedChannel)) {
      throw new InvalidRequestError('addressedChannel must be 1-64 chars of [a-z0-9-] or null');
    }
  }
  const backend = input.backend as { providerLabel?: unknown; invokeModel?: unknown } | null | undefined;
  if (backend === null || backend === undefined || typeof backend !== 'object' || typeof backend.providerLabel !== 'string' || typeof backend.invokeModel !== 'function') {
    throw new InvalidRequestError('backend must be a model backend port (providerLabel + invokeModel) — the /ai-runtime adapter-port discipline');
  }
  const executor = input.toolExecutor as { executeTool?: unknown } | null | undefined;
  if (executor === null || executor === undefined || typeof executor !== 'object' || typeof executor.executeTool !== 'function') {
    throw new InvalidRequestError('toolExecutor must be a tool executor port (executeTool)');
  }
}
