/**
 * /lab-agent-body persistence (LAB-011 — the migration-063 tables).
 *
 * Owns EXACTLY the four own tables (the 059/060/061 discipline):
 *
 *   lab_agent_body_versions, lab_agent_instance_runs,
 *   lab_agent_run_events, lab_agent_memory_entries.
 *
 * NO AUTHORITY TRANSFER / NO SHADOWING (§3): no experiment, decision,
 * evidence, metric, publication, workflow or execution table is
 * written or joined here; no /lab table is written either — the /lab
 * organization candidate's agentBodyVersions citation is an opaque
 * string in /lab's own declaration jsonb. The /ai-runtime boundary is
 * consumed through the module's structural port (registry reads +
 * observation appends) — NO /ai-runtime table is written by this
 * module (the observations flow through the port's public API, the
 * sole model authority).
 *
 * Body versions are append-only with the guarded status advance (the
 * LAB-001 discipline); run events are APPEND-ONLY OUTRIGHT; runs are
 * born 'running' and advance to exactly one terminal state under the
 * guarded UPDATE trigger (identity/model/input immutable); memory
 * entries are bounded current state (upsert per key; the history is
 * the event tail). Every read is CLIENT-scoped (the uniform tenant
 * fence; the module resolves foreign/unknown scope to the uniform
 * NotFound — no existence oracle).
 */

import { createHash } from 'node:crypto';
import type { DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  LabAgentBodyActionKind,
  LabAgentBodyContract,
  LabAgentBodyEventKind,
  LabAgentBodyMemoryKind,
  LabAgentBodyRunFailureReason,
  LabAgentBodyScope,
  LabAgentBodyStatus,
  LabAgentInstanceRunRecord,
  LabAgentMemoryEntryRecord,
  LabAgentRunEventRecord,
} from '../public.ts';
import { LAB_AGENT_BODY_CONTRACT_VERSION } from '../public.ts';

// ---------------------------------------------------------------------------
// Row shapes (snake_case as returned by PostgreSQL)
// ---------------------------------------------------------------------------

interface BodyVersionRow extends DbRow {
  body_id: string;
  body_version: number;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  status: string;
  role_contract: unknown;
  input_contract: unknown;
  output_contract: unknown;
  tools: unknown;
  permissions: unknown;
  memory_interfaces: unknown;
  communication_interface: unknown;
  action_interface: unknown;
  capabilities: unknown;
  budget: unknown;
  latency_limits: unknown;
  evaluation_hooks: unknown;
  safety_constraints: unknown;
  contract_version: string;
  created_at: Date;
  updated_at: Date;
}

interface RunRow extends DbRow {
  run_id: string;
  body_id: string;
  body_version: number;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  model_registry_id: string;
  model_provider_label: string;
  model_key: string;
  model_display_name: string;
  status: string;
  failure_reason: string | null;
  input_message: unknown;
  output_message: unknown;
  addressed_channel: string | null;
  model_invocations: number | string;
  tool_invocations: number | string;
  observed_tokens_in: number | string;
  observed_tokens_out: number | string;
  observed_cost_units: number | string;
  started_at: Date;
  finished_at: Date | null;
  contract_version: string;
  created_at: Date;
  updated_at: Date;
}

interface EventRow extends DbRow {
  event_id: string;
  run_id: string;
  agency_id: string;
  client_id: string;
  seq: number | string;
  event_kind: string;
  payload: unknown;
  payload_digest: string;
  contract_version: string;
  created_at: Date;
}

interface MemoryEntryRow extends DbRow {
  entry_id: string;
  body_id: string;
  run_id: string | null;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  memory_id: string;
  kind: string;
  entry_key: string;
  entry_value: unknown;
  contract_version: string;
  created_at: Date;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// The canonical payload digest (the deterministic event/hook digest)
// ---------------------------------------------------------------------------

/**
 * The canonical payload digest: SHA-256 over the JSON serialization
 * with SORTED keys (deterministic regardless of insertion order — the
 * reproducibility discipline).
 */
export function canonicalPayloadDigest(payload: Readonly<Record<string, unknown>>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(payload).sort()) {
    sorted[key] = payload[key];
  }
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

/** The PostgreSQL array-literal serialization (the /field-agents toArrayLiteral precedent — text[] params ride as literals with ::text[] casts). */
function toArrayLiteral(values: readonly string[]): string {
  return `{${values
    .map((value) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`)
    .join(',')}}`;
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function toIso(value: Date): string {
  return value.toISOString();
}

export function mapBodyVersionRow(r: BodyVersionRow): {
  bodyId: string;
  bodyVersion: number;
  agencyId: string;
  clientId: string;
  workspaceId: string | null;
  status: LabAgentBodyStatus;
  contract: LabAgentBodyContract;
  bodyVersionReference: string;
  contractVersion: string;
  createdAt: string;
  updatedAt: string;
} {
  return {
    bodyId: r.body_id,
    bodyVersion: Number(r.body_version),
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    status: r.status as LabAgentBodyStatus,
    contract: {
      roleContract: r.role_contract as LabAgentBodyContract['roleContract'],
      inputContract: r.input_contract as LabAgentBodyContract['inputContract'],
      outputContract: r.output_contract as LabAgentBodyContract['outputContract'],
      tools: r.tools as LabAgentBodyContract['tools'],
      permissions: r.permissions as LabAgentBodyContract['permissions'],
      memoryInterfaces: r.memory_interfaces as LabAgentBodyContract['memoryInterfaces'],
      communicationInterface: r.communication_interface as LabAgentBodyContract['communicationInterface'],
      actionInterface: r.action_interface as LabAgentBodyContract['actionInterface'],
      capabilities: r.capabilities as LabAgentBodyContract['capabilities'],
      budget: r.budget as LabAgentBodyContract['budget'],
      latencyLimits: r.latency_limits as LabAgentBodyContract['latencyLimits'],
      evaluationHooks: r.evaluation_hooks as LabAgentBodyContract['evaluationHooks'],
      safetyConstraints: r.safety_constraints as LabAgentBodyContract['safetyConstraints'],
    },
    bodyVersionReference: `${r.body_id}#v${Number(r.body_version)}`,
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

export function mapRunRow(r: RunRow): LabAgentInstanceRunRecord {
  return {
    runId: r.run_id,
    bodyId: r.body_id,
    bodyVersion: Number(r.body_version),
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    modelRegistryId: r.model_registry_id,
    modelProviderLabel: r.model_provider_label,
    modelKey: r.model_key,
    modelDisplayName: r.model_display_name,
    status: r.status as LabAgentInstanceRunRecord['status'],
    failureReason: r.failure_reason === null ? null : (r.failure_reason as LabAgentBodyRunFailureReason),
    inputMessage: r.input_message as LabAgentInstanceRunRecord['inputMessage'],
    outputMessage: r.output_message === null ? null : (r.output_message as LabAgentInstanceRunRecord['outputMessage']),
    addressedChannel: r.addressed_channel,
    modelInvocations: Number(r.model_invocations),
    toolInvocations: Number(r.tool_invocations),
    observedTokensIn: Number(r.observed_tokens_in),
    observedTokensOut: Number(r.observed_tokens_out),
    observedCostUnits: Number(r.observed_cost_units),
    startedAt: toIso(r.started_at),
    finishedAt: r.finished_at === null ? null : toIso(r.finished_at),
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

export function mapEventRow(r: EventRow): LabAgentRunEventRecord {
  return {
    eventId: r.event_id,
    runId: r.run_id,
    agencyId: r.agency_id,
    clientId: r.client_id,
    seq: Number(r.seq),
    eventKind: r.event_kind as LabAgentBodyEventKind,
    payload: r.payload as LabAgentRunEventRecord['payload'],
    payloadDigest: r.payload_digest,
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
  };
}

export function mapMemoryEntryRow(r: MemoryEntryRow): LabAgentMemoryEntryRecord {
  return {
    entryId: r.entry_id,
    bodyId: r.body_id,
    runId: r.run_id,
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    memoryId: r.memory_id,
    kind: r.kind as LabAgentBodyMemoryKind,
    entryKey: r.entry_key,
    entryValue: r.entry_value as LabAgentMemoryEntryRecord['entryValue'],
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface InsertBodyVersionInput {
  bodyId: string;
  bodyVersion: number;
  scope: LabAgentBodyScope;
  status: LabAgentBodyStatus;
  contract: LabAgentBodyContract;
}

export interface InsertRunInput {
  runId: string;
  bodyId: string;
  bodyVersion: number;
  scope: LabAgentBodyScope;
  modelRegistryId: string;
  modelProviderLabel: string;
  modelKey: string;
  modelDisplayName: string;
  inputMessage: Readonly<Record<string, unknown>>;
  addressedChannel: string | null;
  startedAtIso: string;
}

export interface TerminalRunUpdateInput {
  runId: string;
  status: 'succeeded' | 'failed';
  failureReason: LabAgentBodyRunFailureReason | null;
  outputMessage: Readonly<Record<string, unknown>> | null;
  modelInvocations: number;
  toolInvocations: number;
  observedTokensIn: number;
  observedTokensOut: number;
  observedCostUnits: number;
  finishedAtIso: string;
}

export interface InsertEventInput {
  eventId: string;
  runId: string;
  scope: LabAgentBodyScope;
  seq: number;
  eventKind: LabAgentBodyEventKind;
  payload: Readonly<Record<string, unknown>>;
}

export interface UpsertMemoryEntryInput {
  entryId: string;
  bodyId: string;
  runId: string | null;
  scope: LabAgentBodyScope;
  memoryId: string;
  kind: LabAgentBodyMemoryKind;
  entryKey: string;
  entryValue: Readonly<Record<string, unknown>>;
}

export class LabAgentBodyStore {
  private readonly db: DbTransaction;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: DbTransaction, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  nowIso(): string {
    return this.clock.nowIso();
  }

  newId(): string {
    return this.ids.newId();
  }

  // --- body versions ---

  async insertBodyVersion(input: InsertBodyVersionInput): Promise<BodyVersionRow> {
    const now = this.nowIso();
    const contract = input.contract;
    const r = await this.db.query<BodyVersionRow>(
      `INSERT INTO lab_agent_body_versions
         (body_id, body_version, agency_id, client_id, workspace_id, status,
          role_contract, input_contract, output_contract, tools, permissions,
          memory_interfaces, communication_interface, action_interface, capabilities,
          budget, latency_limits, evaluation_hooks, safety_constraints,
          contract_version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6,
               $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::text[],
               $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb,
               $16::jsonb, $17::jsonb, $18::jsonb, $19::text[],
               $20, $21::timestamptz, $21::timestamptz)
       RETURNING *`,
      [
        input.bodyId,
        input.bodyVersion,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        input.status,
        JSON.stringify(contract.roleContract),
        JSON.stringify(contract.inputContract),
        JSON.stringify(contract.outputContract),
        JSON.stringify(contract.tools),
        toArrayLiteral(contract.permissions),
        JSON.stringify(contract.memoryInterfaces),
        JSON.stringify(contract.communicationInterface),
        JSON.stringify(contract.actionInterface),
        JSON.stringify(contract.capabilities),
        JSON.stringify(contract.budget),
        JSON.stringify(contract.latencyLimits),
        JSON.stringify(contract.evaluationHooks),
        toArrayLiteral(contract.safetyConstraints),
        LAB_AGENT_BODY_CONTRACT_VERSION,
        now,
      ],
    );
    return r.rows[0]!;
  }

  async findBodyVersion(clientId: string, bodyId: string, bodyVersion: number): Promise<BodyVersionRow | null> {
    const r = await this.db.query<BodyVersionRow>(
      `SELECT * FROM lab_agent_body_versions
        WHERE client_id = $1 AND body_id = $2 AND body_version = $3`,
      [clientId, bodyId, bodyVersion],
    );
    return r.rows[0] ?? null;
  }

  async findLatestBodyVersion(clientId: string, bodyId: string): Promise<BodyVersionRow | null> {
    const r = await this.db.query<BodyVersionRow>(
      `SELECT * FROM lab_agent_body_versions
        WHERE client_id = $1 AND body_id = $2
        ORDER BY body_version DESC LIMIT 1`,
      [clientId, bodyId],
    );
    return r.rows[0] ?? null;
  }

  async listLatestBodies(clientId: string): Promise<ReadonlyArray<BodyVersionRow>> {
    const r = await this.db.query<BodyVersionRow>(
      `SELECT DISTINCT ON (body_id) *
         FROM lab_agent_body_versions
        WHERE client_id = $1
        ORDER BY body_id, body_version DESC`,
      [clientId],
    );
    return r.rows;
  }

  async updateBodyStatus(clientId: string, bodyId: string, bodyVersion: number, status: LabAgentBodyStatus): Promise<BodyVersionRow | null> {
    const now = this.nowIso();
    const r = await this.db.query<BodyVersionRow>(
      `UPDATE lab_agent_body_versions
          SET status = $4, updated_at = $5::timestamptz
        WHERE client_id = $1 AND body_id = $2 AND body_version = $3
        RETURNING *`,
      [clientId, bodyId, bodyVersion, status, now],
    );
    return r.rows[0] ?? null;
  }

  // --- instance runs ---

  async insertRun(input: InsertRunInput): Promise<RunRow> {
    const now = this.nowIso();
    const r = await this.db.query<RunRow>(
      `INSERT INTO lab_agent_instance_runs
         (run_id, body_id, body_version, agency_id, client_id, workspace_id,
          model_registry_id, model_provider_label, model_key, model_display_name,
          status, failure_reason, input_message, output_message, addressed_channel,
          model_invocations, tool_invocations, observed_tokens_in, observed_tokens_out,
          observed_cost_units, started_at, finished_at, contract_version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6,
               $7, $8, $9, $10,
               'running', NULL, $11::jsonb, NULL, $12,
               0, 0, 0, 0, 0, $13::timestamptz, NULL, $14, $15::timestamptz, $15::timestamptz)
       RETURNING *`,
      [
        input.runId,
        input.bodyId,
        input.bodyVersion,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        input.modelRegistryId,
        input.modelProviderLabel,
        input.modelKey,
        input.modelDisplayName,
        JSON.stringify(input.inputMessage),
        input.addressedChannel,
        input.startedAtIso,
        LAB_AGENT_BODY_CONTRACT_VERSION,
        now,
      ],
    );
    return r.rows[0]!;
  }

  async findRun(clientId: string, runId: string): Promise<RunRow | null> {
    const r = await this.db.query<RunRow>(
      `SELECT * FROM lab_agent_instance_runs
        WHERE client_id = $1 AND run_id = $2`,
      [clientId, runId],
    );
    return r.rows[0] ?? null;
  }

  async listRuns(clientId: string, bodyId?: string): Promise<ReadonlyArray<RunRow>> {
    const conditions = ['client_id = $1'];
    const params: Array<string> = [clientId];
    if (bodyId !== undefined) {
      params.push(bodyId);
      conditions.push(`body_id = $${params.length}`);
    }
    const r = await this.db.query<RunRow>(
      `SELECT * FROM lab_agent_instance_runs
        WHERE ${conditions.join(' AND ')}
        ORDER BY created_at, run_id`,
      params,
    );
    return r.rows;
  }

  /** The single guarded terminal advance (identity/model/input immutable — the migration-063 trigger backstop). */
  async updateRunTerminal(input: TerminalRunUpdateInput): Promise<RunRow | null> {
    const now = this.nowIso();
    const r = await this.db.query<RunRow>(
      `UPDATE lab_agent_instance_runs
          SET status = $2, failure_reason = $3, output_message = $4::jsonb,
              model_invocations = $5, tool_invocations = $6,
              observed_tokens_in = $7, observed_tokens_out = $8, observed_cost_units = $9,
              finished_at = $10::timestamptz, updated_at = $11::timestamptz
        WHERE run_id = $1
        RETURNING *`,
      [
        input.runId,
        input.status,
        input.failureReason,
        input.outputMessage === null ? null : JSON.stringify(input.outputMessage),
        input.modelInvocations,
        input.toolInvocations,
        input.observedTokensIn,
        input.observedTokensOut,
        input.observedCostUnits,
        input.finishedAtIso,
        now,
      ],
    );
    return r.rows[0] ?? null;
  }

  // --- the append-only run event tail ---

  async insertEvent(input: InsertEventInput): Promise<EventRow> {
    const now = this.nowIso();
    const r = await this.db.query<EventRow>(
      `INSERT INTO lab_agent_run_events
         (event_id, run_id, agency_id, client_id, seq, event_kind, payload, payload_digest,
          contract_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::timestamptz)
       RETURNING *`,
      [
        input.eventId,
        input.runId,
        input.scope.agencyId,
        input.scope.clientId,
        input.seq,
        input.eventKind,
        JSON.stringify(input.payload),
        canonicalPayloadDigest(input.payload),
        LAB_AGENT_BODY_CONTRACT_VERSION,
        now,
      ],
    );
    return r.rows[0]!;
  }

  async listRunEvents(clientId: string, runId: string): Promise<ReadonlyArray<EventRow>> {
    const r = await this.db.query<EventRow>(
      `SELECT * FROM lab_agent_run_events
        WHERE client_id = $1 AND run_id = $2
        ORDER BY seq, event_id`,
      [clientId, runId],
    );
    return r.rows;
  }

  // --- the bounded memory store ---

  async upsertMemoryEntry(input: UpsertMemoryEntryInput): Promise<MemoryEntryRow> {
    const now = this.nowIso();
    const r = await this.db.query<MemoryEntryRow>(
      `INSERT INTO lab_agent_memory_entries
         (entry_id, body_id, run_id, agency_id, client_id, workspace_id,
          memory_id, kind, entry_key, entry_value, contract_version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12::timestamptz, $12::timestamptz)
       ON CONFLICT (client_id, body_id, memory_id, run_id, entry_key)
       DO UPDATE SET entry_value = EXCLUDED.entry_value, updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [
        input.entryId,
        input.bodyId,
        input.runId,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        input.memoryId,
        input.kind,
        input.entryKey,
        JSON.stringify(input.entryValue),
        LAB_AGENT_BODY_CONTRACT_VERSION,
        now,
      ],
    );
    return r.rows[0]!;
  }

  async listBodyMemoryEntries(clientId: string, bodyId: string, memoryId: string): Promise<ReadonlyArray<MemoryEntryRow>> {
    const r = await this.db.query<MemoryEntryRow>(
      `SELECT * FROM lab_agent_memory_entries
        WHERE client_id = $1 AND body_id = $2 AND memory_id = $3 AND run_id IS NULL
        ORDER BY created_at, entry_id`,
      [clientId, bodyId, memoryId],
    );
    return r.rows;
  }

  async listRunMemoryEntries(clientId: string, runId: string): Promise<ReadonlyArray<MemoryEntryRow>> {
    const r = await this.db.query<MemoryEntryRow>(
      `SELECT * FROM lab_agent_memory_entries
        WHERE client_id = $1 AND run_id = $2
        ORDER BY created_at, entry_id`,
      [clientId, runId],
    );
    return r.rows;
  }

  /** The body-scoped memory contents for the run's read path (all declared body_scoped memories of the body). */
  async listBodyScopedMemory(clientId: string, bodyId: string): Promise<ReadonlyArray<MemoryEntryRow>> {
    const r = await this.db.query<MemoryEntryRow>(
      `SELECT * FROM lab_agent_memory_entries
        WHERE client_id = $1 AND body_id = $2 AND run_id IS NULL
        ORDER BY created_at, entry_id`,
      [clientId, bodyId],
    );
    return r.rows;
  }

  /** The run-scoped memory contents written so far in THIS run (the read path for subsequent rounds). */
  async listRunScopedMemory(clientId: string, runId: string): Promise<ReadonlyArray<MemoryEntryRow>> {
    const r = await this.db.query<MemoryEntryRow>(
      `SELECT * FROM lab_agent_memory_entries
        WHERE client_id = $1 AND run_id = $2
        ORDER BY created_at, entry_id`,
      [clientId, runId],
    );
    return r.rows;
  }

  /** Counts the DISTINCT entry keys of one memory (the capacity fence — last-write-wins means the key count IS the entry count). */
  async countMemoryEntries(clientId: string, bodyId: string, memoryId: string, runId: string | null): Promise<number> {
    if (runId === null) {
      const r = await this.db.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM lab_agent_memory_entries
          WHERE client_id = $1 AND body_id = $2 AND memory_id = $3 AND run_id IS NULL`,
        [clientId, bodyId, memoryId],
      );
      return Number(r.rows[0]?.n ?? 0);
    }
    const r = await this.db.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM lab_agent_memory_entries
        WHERE client_id = $1 AND body_id = $2 AND memory_id = $3 AND run_id = $4`,
      [clientId, bodyId, memoryId, runId],
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  /** Whether one memory key already exists (the capacity fence excludes key overwrites — a same-key write replaces, never grows). */
  async memoryKeyExists(clientId: string, bodyId: string, memoryId: string, runId: string | null, entryKey: string): Promise<boolean> {
    if (runId === null) {
      const r = await this.db.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM lab_agent_memory_entries
          WHERE client_id = $1 AND body_id = $2 AND memory_id = $3 AND run_id IS NULL AND entry_key = $4`,
        [clientId, bodyId, memoryId, entryKey],
      );
      return Number(r.rows[0]?.n ?? 0) > 0;
    }
    const r = await this.db.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM lab_agent_memory_entries
        WHERE client_id = $1 AND body_id = $2 AND memory_id = $3 AND run_id = $4 AND entry_key = $5`,
      [clientId, bodyId, memoryId, runId, entryKey],
    );
    return Number(r.rows[0]?.n ?? 0) > 0;
  }
}

export type { BodyVersionRow, RunRow, EventRow, MemoryEntryRow };
export type { LabAgentBodyActionKind };
