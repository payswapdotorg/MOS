/**
 * /lab-agent-body Agent Instance runtime (LAB-011 — §14's formula made
 * runnable: `Agent Body version + selected model + permitted tools =
 * Agent Instance`).
 *
 * THE EXECUTION MODEL (the bounded agent loop):
 *
 *   1. The input-contract message is validated against the body's
 *      declared inputContract — a violation is the honest
 *      `input_contract_violation` terminal failure (the run record
 *      exists: run_started + run_failed events, no model invocation).
 *   2. The caller-supplied model identity is RESOLVED through the
 *      /ai-runtime port (the model authority — identity as DATA). An
 *      identity that does not resolve, is retired, reports
 *      `unavailable`, or whose provider the supplied backend does not
 *      serve is the honest `model_unavailable` terminal failure.
 *   3. THE LOOP (bounded by the body's declared budget + deadline):
 *      invoke the model through the caller-supplied backend (the
 *      routeTask adapter discipline — never a selection), append the
 *      honest availability observation through the /ai-runtime port,
 *      record the model_invocation event, enforce the token/cost
 *      caps (`budget_exceeded`) and the deadline (`latency_exceeded`),
 *      apply the model-issued memory writes (bounded; capacity
 *      refusals are recorded, non-terminal), then execute the
 *      model-requested tool calls under the permission fence
 *      (undeclared tool / unpermitted action kind = the fail-closed
 *      `permission_refused` terminal refusal; a failing permitted tool
 *      = `tool_error`) and re-invoke the model with the tool results.
 *      A response with NO tool calls is the FINAL response: the
 *      control channels are stripped and the remaining message is
 *      validated against the outputContract (violation =
 *      `output_contract_violation`).
 *   4. At the terminal transition the declared evaluation hooks fire
 *      (hook identity + terminal-payload digest + the 'pending'
 *      outcome slot — DATA for LAB-016/018; no evaluation logic here)
 *      and the guarded terminal advance closes the run.
 *
 * DETERMINISTIC CHECK ORDER (disclosed): after every model invocation
 * the budget caps are checked BEFORE the deadline (an invocation that
 * breaks both fails `budget_exceeded`); the deadline is checked before
 * every invocation and again after it. A crash mid-run leaves the
 * honest `running` row (resume is later Lab work — the record never
 * lies).
 */

import type { Clock } from '../../../platform/clock/clock.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  LabAgentBodyAiRuntimePort,
  LabAgentBodyContract,
  LabAgentBodyEventKind,
  LabAgentBodyMemoryRefusalReason,
  LabAgentBodyModelBackendPort,
  LabAgentBodyRunFailureReason,
  LabAgentBodyScope,
  LabAgentBodyToolCall,
  LabAgentBodyToolExecutorPort,
  LabAgentBodyToolRefusalReason,
  LabAgentInstanceRunRecord,
  LabAgentMemoryEntryRecord,
} from '../public.ts';
import { LAB_AGENT_BODY_MEMORY_WRITES_KEY, LAB_AGENT_BODY_TOOL_CALLS_KEY } from '../public.ts';
import { canonicalPayloadDigest, mapMemoryEntryRow, mapRunRow } from './agent-body-store.ts';
import type { LabAgentBodyStore } from './agent-body-store.ts';
import { stripRuntimeControlChannels, validateLabAgentMessageAgainstContract } from './validation.ts';

/** The bounded serialized size under which a tool result is recorded VERBATIM on its event (beyond: digest-only + the omit flag — never silent truncation). */
const TOOL_RESULT_RECORD_LIMIT_BYTES = 8192;

export interface AgentInstanceRunContext {
  readonly runId: string;
  readonly scope: LabAgentBodyScope;
  readonly body: {
    readonly bodyId: string;
    readonly bodyVersion: number;
    readonly contract: LabAgentBodyContract;
  };
  readonly model: {
    readonly modelRegistryId: string;
    readonly providerLabel: string;
    readonly modelKey: string;
    readonly displayName: string;
    /** The registry-resolved lifecycle + availability snapshot (DATA — drives the honest model_unavailable gate). */
    readonly status: 'active' | 'retired' | 'unresolved';
    readonly availabilityState: 'available' | 'degraded' | 'unavailable';
  };
  readonly inputMessage: Readonly<Record<string, unknown>>;
  readonly addressedChannel: string | null;
}

export interface AgentInstanceRunPorts {
  readonly store: LabAgentBodyStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly aiRuntime: LabAgentBodyAiRuntimePort;
}

/** The per-run event recorder (seq assigned here; the UNIQUE fence is the DB backstop). */
class RunEventRecorder {
  private nextSeq = 1;
  private readonly events: Array<{ eventKind: LabAgentBodyEventKind; payload: Record<string, unknown> }> = [];
  private readonly store: LabAgentBodyStore;
  private readonly runId: string;
  private readonly scope: LabAgentBodyScope;

  constructor(store: LabAgentBodyStore, runId: string, scope: LabAgentBodyScope) {
    this.store = store;
    this.runId = runId;
    this.scope = scope;
  }

  async record(eventKind: LabAgentBodyEventKind, payload: Readonly<Record<string, unknown>>): Promise<void> {
    const seq = this.nextSeq;
    this.nextSeq += 1;
    await this.store.insertEvent({
      eventId: this.store.newId(),
      runId: this.runId,
      scope: this.scope,
      seq,
      eventKind,
      payload: { ...payload },
    });
    this.events.push({ eventKind, payload: { ...payload } });
  }

  /** The recorded kinds in order (test/LAB-012 composition evidence). */
  kinds(): ReadonlyArray<LabAgentBodyEventKind> {
    return this.events.map((event) => event.eventKind);
  }
}

function asToolCalls(raw: unknown): ReadonlyArray<LabAgentBodyToolCall> | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) return null;
  const calls: LabAgentBodyToolCall[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const toolId = record['toolId'];
    if (typeof toolId !== 'string' || toolId.length === 0) continue;
    const args = record['arguments'];
    calls.push({
      toolId,
      arguments: (typeof args === 'object' && args !== null && !Array.isArray(args) ? args : {}) as Record<string, unknown>,
    });
  }
  return calls;
}

function asMemoryWrites(raw: unknown): ReadonlyArray<{ memoryId: string; entryKey: string; entryValue: Record<string, unknown> }> | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) return null;
  const writes: Array<{ memoryId: string; entryKey: string; entryValue: Record<string, unknown> }> = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const memoryId = record['memoryId'];
    const entryKey = record['entryKey'];
    const entryValue = record['entryValue'];
    if (typeof memoryId !== 'string' || memoryId.length === 0) continue;
    if (typeof entryKey !== 'string' || entryKey.length === 0 || entryKey.length > 256) continue;
    if (typeof entryValue !== 'object' || entryValue === null || Array.isArray(entryValue)) continue;
    writes.push({ memoryId, entryKey, entryValue: entryValue as Record<string, unknown> });
  }
  return writes;
}

function entriesToMemoryContext(
  bodyScoped: ReadonlyArray<LabAgentMemoryEntryRecord>,
  runScoped: ReadonlyArray<LabAgentMemoryEntryRecord>,
  contract: LabAgentBodyContract,
): Record<string, ReadonlyArray<Record<string, unknown>>> {
  const context: Record<string, ReadonlyArray<Record<string, unknown>>> = {};
  for (const memory of contract.memoryInterfaces) {
    context[memory.memoryId] = [];
  }
  for (const entry of [...bodyScoped, ...runScoped]) {
    const current = context[entry.memoryId] ?? [];
    context[entry.memoryId] = [...current, { key: entry.entryKey, value: entry.entryValue, kind: entry.kind }];
  }
  return context;
}

/**
 * Executes one agent-instance run to its terminal state and returns
 * the terminal run record. Every failure path is an HONEST recorded
 * terminal state (the closed taxonomy) — the run record never lies.
 */
export async function executeAgentInstanceRun(
  ports: AgentInstanceRunPorts,
  context: AgentInstanceRunContext,
  backend: LabAgentBodyModelBackendPort,
  toolExecutor: LabAgentBodyToolExecutorPort,
): Promise<LabAgentInstanceRunRecord> {
  const { store, clock, aiRuntime } = ports;
  const { runId, scope, body, model, inputMessage } = context;
  const contract = body.contract;
  const recorder = new RunEventRecorder(store, runId, scope);

  const startedAtMs = clock.nowMs();
  const deadlineAtMs = startedAtMs + contract.latencyLimits.deadlineMs;

  const usage = {
    modelInvocations: 0,
    toolInvocations: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUnits: 0,
  };

  const fail = async (reason: LabAgentBodyRunFailureReason, detail: string): Promise<LabAgentInstanceRunRecord> => {
    await recorder.record('run_failed', { reason, detail: detail.slice(0, 512) });
    // The declared evaluation hooks fire at EVERY terminal transition —
    // the failure payload is as digestible as the output payload
    // (LAB-016/018 evaluate failures too).
    for (const hook of contract.evaluationHooks) {
      await recorder.record('evaluation_hook', {
        hookId: hook.hookId,
        payloadDigest: canonicalPayloadDigest({ reason, detail }),
        outcome: 'pending',
      });
    }
    const finishedAtIso = store.nowIso();
    const row = await store.updateRunTerminal({
      runId,
      status: 'failed',
      failureReason: reason,
      outputMessage: null,
      modelInvocations: usage.modelInvocations,
      toolInvocations: usage.toolInvocations,
      observedTokensIn: usage.tokensIn,
      observedTokensOut: usage.tokensOut,
      observedCostUnits: usage.costUnits,
      finishedAtIso,
    });
    if (row === null) throw new Error(`agent instance run ${runId} disappeared mid-run`);
    return mapRunRow(row);
  };

  await recorder.record('run_started', {
    bodyVersionReference: `${body.bodyId}#v${body.bodyVersion}`,
    modelRegistryId: model.modelRegistryId,
    modelProviderLabel: model.providerLabel,
    modelKey: model.modelKey,
    addressedChannel: context.addressedChannel,
    safetyConstraints: [...contract.safetyConstraints],
  });

  // --- 1. The input-contract gate (the honest input_contract_violation). ---
  const inputCheck = validateLabAgentMessageAgainstContract(contract.inputContract, inputMessage, 'inputMessage');
  if (!inputCheck.ok) {
    return await fail('input_contract_violation', inputCheck.violations.join('; '));
  }

  // --- 2. The model-identity resolution through the /ai-runtime port. ---
  if (model.status !== 'active') {
    return await fail('model_unavailable', `model ${model.modelRegistryId} is ${model.status} in the /ai-runtime registry`);
  }
  if (model.availabilityState === 'unavailable') {
    return await fail('model_unavailable', `model ${model.modelRegistryId} reports 'unavailable' in the /ai-runtime registry`);
  }
  if (backend.providerLabel !== model.providerLabel) {
    return await fail(
      'model_unavailable',
      `the supplied model backend serves provider '${backend.providerLabel}' but model ${model.modelRegistryId} belongs to provider '${model.providerLabel}' (a wiring mismatch — never a silent fallback)`,
    );
  }

  // --- 3. The bounded agent loop. ---
  let toolResults: ReadonlyArray<{ toolId: string; ok: boolean; result: Readonly<Record<string, unknown>> | null }> | null = null;
  let finalOutput: Readonly<Record<string, unknown>> | null = null;

  for (let round = 1; round <= contract.budget.maxModelInvocations; round += 1) {
    // The invocation-cap + deadline pre-checks.
    if (usage.modelInvocations >= contract.budget.maxModelInvocations) {
      return await fail('budget_exceeded', `the declared max model invocations (${contract.budget.maxModelInvocations}) was reached before round ${round}`);
    }
    if (clock.nowMs() > deadlineAtMs) {
      return await fail('latency_exceeded', `the declared deadline (${contract.latencyLimits.deadlineMs}ms) passed before round ${round}`);
    }

    // The memory read path: the current declared-memory contents.
    const [bodyScopedRows, runScopedRows] = await Promise.all([
      store.listBodyScopedMemory(scope.clientId, body.bodyId),
      store.listRunScopedMemory(scope.clientId, runId),
    ]);
    const memory = entriesToMemoryContext(
      bodyScopedRows.map(mapMemoryEntryRow),
      runScopedRows.map(mapMemoryEntryRow),
      contract,
    );

    // THE MODEL INVOCATION — through the caller-supplied backend only
    // (the identity is DATA; this module selects nothing).
    const invocation = await backend.invokeModel({
      modelRegistryId: model.modelRegistryId,
      providerLabel: model.providerLabel,
      modelKey: model.modelKey,
      taskClass: contract.roleContract.role,
      inputMessage,
      memory,
      toolDeclarations: contract.tools,
      toolResults,
      budget: {
        maxCostUnits: contract.budget.maxCostUnits - usage.costUnits,
        remainingMs: Math.max(0, deadlineAtMs - clock.nowMs()),
      },
    });
    usage.modelInvocations += 1;
    if (invocation.tokensIn !== null && Number.isFinite(invocation.tokensIn)) usage.tokensIn += invocation.tokensIn;
    if (invocation.tokensOut !== null && Number.isFinite(invocation.tokensOut)) usage.tokensOut += invocation.tokensOut;
    if (Number.isFinite(invocation.costUnits)) usage.costUnits += invocation.costUnits;

    await recorder.record('model_invocation', {
      round,
      modelRegistryId: model.modelRegistryId,
      providerLabel: model.providerLabel,
      modelKey: model.modelKey,
      ok: invocation.ok,
      error: invocation.error === null ? null : invocation.error.slice(0, 512),
      latencyMs: invocation.latencyMs,
      costUnits: invocation.costUnits,
      tokensIn: invocation.tokensIn,
      tokensOut: invocation.tokensOut,
    });

    // The honest availability observation through the /ai-runtime
    // public API (the same registry the routing layer aggregates
    // from — source 'lab-agent-body').
    await aiRuntime.appendModelObservation({
      modelRegistryId: model.modelRegistryId,
      availabilityState: invocation.ok ? 'available' : 'unavailable',
      observedLatencyP50Ms: invocation.latencyMs,
      observedLatencyP95Ms: null,
      source: 'lab-agent-body',
      notes: `agent-instance run ${runId} round ${round}`,
      actorId: null,
    });

    if (!invocation.ok || invocation.output === null) {
      return await fail('model_invocation_failed', invocation.error ?? 'the model backend returned no output');
    }

    // The budget caps (checked before the deadline — the disclosed order).
    if (usage.tokensIn > contract.budget.maxTokensIn) {
      return await fail('budget_exceeded', `cumulative input tokens ${usage.tokensIn} exceeded the declared cap ${contract.budget.maxTokensIn}`);
    }
    if (usage.tokensOut > contract.budget.maxTokensOut) {
      return await fail('budget_exceeded', `cumulative output tokens ${usage.tokensOut} exceeded the declared cap ${contract.budget.maxTokensOut}`);
    }
    if (usage.costUnits > contract.budget.maxCostUnits) {
      return await fail('budget_exceeded', `cumulative cost units ${usage.costUnits} exceeded the declared cap ${contract.budget.maxCostUnits}`);
    }
    if (clock.nowMs() > deadlineAtMs) {
      return await fail('latency_exceeded', `the declared deadline (${contract.latencyLimits.deadlineMs}ms) passed during round ${round}`);
    }

    const response = invocation.output;

    // The memory writes (bounded; refusals recorded, non-terminal).
    const memoryWrites = asMemoryWrites(response[LAB_AGENT_BODY_MEMORY_WRITES_KEY]);
    if (memoryWrites !== null) {
      for (const write of memoryWrites) {
        const declaration = contract.memoryInterfaces.find((memory) => memory.memoryId === write.memoryId);
        if (declaration === undefined) {
          await recorder.record('memory_refused', {
            memoryId: write.memoryId,
            entryKey: write.entryKey,
            reason: 'memory_not_declared' as LabAgentBodyMemoryRefusalReason,
          });
          continue;
        }
        const runAnchor = declaration.kind === 'run_scoped' ? runId : null;
        const keyExists = await store.memoryKeyExists(scope.clientId, body.bodyId, write.memoryId, runAnchor, write.entryKey);
        if (!keyExists) {
          const count = await store.countMemoryEntries(scope.clientId, body.bodyId, write.memoryId, runAnchor);
          if (count >= declaration.capacityEntries) {
            await recorder.record('memory_refused', {
              memoryId: write.memoryId,
              entryKey: write.entryKey,
              reason: 'memory_capacity_exceeded' as LabAgentBodyMemoryRefusalReason,
              capacityEntries: declaration.capacityEntries,
            });
            continue;
          }
        }
        await store.upsertMemoryEntry({
          entryId: store.newId(),
          bodyId: body.bodyId,
          runId: runAnchor,
          scope,
          memoryId: write.memoryId,
          kind: declaration.kind,
          entryKey: write.entryKey,
          entryValue: write.entryValue,
        });
        await recorder.record('memory_write', {
          memoryId: write.memoryId,
          entryKey: write.entryKey,
          kind: declaration.kind,
          valueDigest: canonicalPayloadDigest(write.entryValue),
        });
      }
    }

    // The tool calls (the permission fence — fail-closed).
    const toolCalls = asToolCalls(response[LAB_AGENT_BODY_TOOL_CALLS_KEY]);
    if (toolCalls !== null && toolCalls.length > 0) {
      const roundResults: Array<{ toolId: string; ok: boolean; result: Readonly<Record<string, unknown>> | null }> = [];
      for (const call of toolCalls) {
        if (usage.toolInvocations >= contract.budget.maxToolInvocations) {
          return await fail('budget_exceeded', `the declared max tool invocations (${contract.budget.maxToolInvocations}) was reached`);
        }
        const declaration = contract.tools.find((tool) => tool.toolId === call.toolId);
        if (declaration === undefined) {
          await recorder.record('tool_refusal', {
            toolId: call.toolId,
            reason: 'undeclared_tool' as LabAgentBodyToolRefusalReason,
          });
          return await fail('permission_refused', `the model requested the undeclared tool '${call.toolId}'`);
        }
        if (!contract.permissions.includes(declaration.actionKind)) {
          await recorder.record('tool_refusal', {
            toolId: call.toolId,
            actionKind: declaration.actionKind,
            reason: 'action_not_permitted' as LabAgentBodyToolRefusalReason,
          });
          return await fail(
            'permission_refused',
            `the tool '${call.toolId}' performs action kind '${declaration.actionKind}' which is not in the body's permission set`,
          );
        }
        let outcome: { ok: boolean; result: Readonly<Record<string, unknown>> | null; error: string | null };
        try {
          outcome = await toolExecutor.executeTool({
            toolId: call.toolId,
            actionKind: declaration.actionKind,
            arguments: call.arguments,
          });
        } catch (error) {
          outcome = { ok: false, result: null, error: `tool executor threw: ${String(error).slice(0, 400)}` };
        }
        usage.toolInvocations += 1;
        const resultDigest = outcome.result === null ? null : canonicalPayloadDigest(outcome.result);
        let recordedResult: Record<string, unknown> | null = null;
        let resultRecorded = false;
        if (outcome.result !== null) {
          const serialized = JSON.stringify(outcome.result);
          if (serialized.length <= TOOL_RESULT_RECORD_LIMIT_BYTES) {
            recordedResult = { ...outcome.result };
            resultRecorded = true;
          }
        }
        await recorder.record('tool_invocation', {
          toolId: call.toolId,
          actionKind: declaration.actionKind,
          ok: outcome.ok,
          error: outcome.error === null ? null : outcome.error.slice(0, 512),
          resultDigest,
          result: recordedResult,
          resultRecorded,
        });
        if (!outcome.ok) {
          return await fail('tool_error', `the tool '${call.toolId}' failed: ${outcome.error ?? 'no error detail'}`);
        }
        roundResults.push({ toolId: call.toolId, ok: true, result: outcome.result });
      }
      toolResults = roundResults;
      continue; // Re-invoke the model with the tool results.
    }

    // No tool calls: the FINAL response — strip the control channels
    // and validate the output-contract message.
    const outputMessage = stripRuntimeControlChannels(response);
    const outputCheck = validateLabAgentMessageAgainstContract(contract.outputContract, outputMessage, 'outputMessage');
    if (!outputCheck.ok) {
      return await fail('output_contract_violation', outputCheck.violations.join('; '));
    }
    finalOutput = outputMessage;
    break;
  }

  if (finalOutput === null) {
    // The loop exhausted the invocation cap with tool calls still
    // pending — the honest budget_exceeded terminal state.
    return await fail('budget_exceeded', `the declared max model invocations (${contract.budget.maxModelInvocations}) was exhausted while tool calls were still pending`);
  }

  // --- 4. The terminal success + the evaluation-hook firings. ---
  await recorder.record('run_completed', {
    outputDigest: canonicalPayloadDigest(finalOutput),
    modelInvocations: usage.modelInvocations,
    toolInvocations: usage.toolInvocations,
    observedTokensIn: usage.tokensIn,
    observedTokensOut: usage.tokensOut,
    observedCostUnits: usage.costUnits,
  });
  for (const hook of contract.evaluationHooks) {
    await recorder.record('evaluation_hook', {
      hookId: hook.hookId,
      payloadDigest: canonicalPayloadDigest({ output: finalOutput }),
      outcome: 'pending',
    });
  }
  const finishedAtIso = store.nowIso();
  const row = await store.updateRunTerminal({
    runId,
    status: 'succeeded',
    failureReason: null,
    outputMessage: finalOutput,
    modelInvocations: usage.modelInvocations,
    toolInvocations: usage.toolInvocations,
    observedTokensIn: usage.tokensIn,
    observedTokensOut: usage.tokensOut,
    observedCostUnits: usage.costUnits,
    finishedAtIso,
  });
  if (row === null) throw new Error(`agent instance run ${runId} disappeared mid-run`);
  return mapRunRow(row);
}

