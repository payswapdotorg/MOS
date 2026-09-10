/**
 * /field-agents persistence (human_agents table — the generic Human Agent
 * profile authority, MKT-025).
 *
 * DB backstops (migration 017 + implementation-contract §3/§25):
 *   - agent identity + the platform identity link (user_id) + provenance are
 *     IMMUTABLE (trigger) — a profile can never become another user's
 *     profile and can never be reassigned;
 *   - ONE profile per platform user (unique index; ON CONFLICT DO NOTHING →
 *     ConflictError) — duplicate creation converges to a single winner,
 *     race-free;
 *   - specializations are a non-empty unique subset of the frozen registry
 *     (CHECK + trigger) — Field Agent additionally requires declared
 *     geography (CHECK);
 *   - authorization_state is active/suspended/contract_ended with
 *     contract_ended TERMINAL (trigger) — contract history can never be
 *     rewritten;
 *   - every mutable row carries a version CAS token (row-locked
 *     transitions);
 *   - jsonb type/cardinality fences backstop the pure validator in
 *     public.ts (single-sourced shape rules).
 *
 * The table has NO tenant columns (no agency_id/client_id/workspace_id):
 * a Human Agent is not a tenant. Agency linkage is the existing
 * agency_memberships authority — this store never queries it (the frozen
 * dependency matrix does not allow /field-agents → /agencies); the
 * candidate pool for eligibility is supplied by authorized callers.
 */

import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import {
  applyReliabilityObservation,
  type HumanAgentRecord,
  type HumanAgentDeclaration,
  type ReliabilityObservation,
} from '../public.ts';

interface HumanAgentRow extends DbRow {
  agent_id: string;
  user_id: string;
  specializations: string[];
  capabilities: unknown;
  availability: unknown;
  location: unknown;
  territories: unknown;
  reliability: unknown;
  relationship_continuity: unknown;
  authorization_state: string;
  created_by: string | null;
  version: number | bigint;
  created_at: Date;
  updated_at: Date;
}

/**
 * PostgreSQL array literal for text[]/uuid[] parameters (the Db port's
 * QueryParam carries only scalars — arrays cross the boundary as explicit
 * array-literal strings with ::text[]/::uuid[] casts; values are strictly
 * validated upstream: frozen registry tags / platform uuids).
 */
function toArrayLiteral(values: readonly string[]): string {
  return `{${values
    .map((value) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`)
    .join(',')}}`;
}

const HUMAN_AGENT_SELECT = `
  SELECT agent_id, user_id, specializations, capabilities, availability, location,
         territories, reliability, relationship_continuity, authorization_state,
         created_by, version, created_at, updated_at
  FROM human_agents
`;

export class FieldAgentsStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  /**
   * Insert fenced by the unique index on user_id (one profile per platform
   * user). 'taken' means this user already has a profile — the caller
   * surfaces a ConflictError (duplicate convergence fails closed).
   */
  async insertHumanAgent(input: {
    readonly userId: string;
    readonly declaration: HumanAgentDeclaration;
    readonly actorId: string | null;
    readonly initialReliability: Record<string, number>;
  }): Promise<HumanAgentRecord | 'taken'> {
    const agentId = this.ids.newId();
    const now = this.clock.nowIso();
    const result = await this.db.query(
      `INSERT INTO human_agents
         (agent_id, user_id, specializations, capabilities, availability, location,
          territories, reliability, relationship_continuity, authorization_state,
          created_by, version, created_at, updated_at)
       VALUES ($1, $2, $3::text[], $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb,
               $9::jsonb, 'active', $10, 1, $11, $11)
       ON CONFLICT (user_id) DO NOTHING`,
      [
        agentId,
        input.userId,
        toArrayLiteral(input.declaration.specializations),
        JSON.stringify(input.declaration.capabilities),
        JSON.stringify(input.declaration.availability),
        input.declaration.location === null ? null : JSON.stringify(input.declaration.location),
        JSON.stringify(input.declaration.territories),
        JSON.stringify(input.initialReliability),
        JSON.stringify(input.declaration.relationshipContinuity),
        input.actorId,
        now,
      ],
    );
    if (result.rowCount !== 1) return 'taken';
    const created = await this.getHumanAgent(agentId);
    if (created === null) {
      throw new Error(`inserted human agent profile ${agentId} could not be read back`);
    }
    return created;
  }

  async getHumanAgent(agentId: string): Promise<HumanAgentRecord | null> {
    const result = await this.db.query<HumanAgentRow>(
      `${HUMAN_AGENT_SELECT} WHERE agent_id = $1`,
      [agentId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toHumanAgentRecord(row);
  }

  async getHumanAgentByUser(userId: string): Promise<HumanAgentRecord | null> {
    const result = await this.db.query<HumanAgentRow>(
      `${HUMAN_AGENT_SELECT} WHERE user_id = $1`,
      [userId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toHumanAgentRecord(row);
  }

  /** Locks the profile row (FOR UPDATE) and returns it — CAS serialized. */
  async lockHumanAgent(tx: DbTransaction, agentId: string): Promise<HumanAgentRecord | null> {
    const result = await tx.query<HumanAgentRow>(
      `${HUMAN_AGENT_SELECT} WHERE agent_id = $1 FOR UPDATE`,
      [agentId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toHumanAgentRecord(row);
  }

  /**
   * CAS content update on the CALLER'S transaction (the row was locked
   * there): specializations, capabilities, relationship continuity.
   */
  async updateProfileContent(
    tx: DbTransaction,
    input: {
      readonly agentId: string;
      readonly specializations: readonly string[];
      readonly capabilities: unknown;
      readonly relationshipContinuity: unknown;
      readonly expectedVersion: number;
    },
  ): Promise<'ok' | 'not-found' | 'version-conflict'> {
    const now = this.clock.nowIso();
    const result = await tx.query(
      `UPDATE human_agents
       SET specializations = $1::text[], capabilities = $2::jsonb,
           relationship_continuity = $3::jsonb, version = version + 1, updated_at = $4
       WHERE agent_id = $5 AND version = $6`,
      [
        toArrayLiteral(input.specializations),
        JSON.stringify(input.capabilities),
        JSON.stringify(input.relationshipContinuity),
        now,
        input.agentId,
        input.expectedVersion,
      ],
    );
    return casOutcome(tx, input.agentId, result.rowCount);
  }

  /**
   * CAS availability/territory declaration on the CALLER'S transaction
   * (the row was locked there): availability windows, location, territories.
   */
  async updateDeclaration(
    tx: DbTransaction,
    input: {
      readonly agentId: string;
      readonly availability: unknown;
      readonly location: unknown;
      readonly territories: unknown;
      readonly expectedVersion: number;
    },
  ): Promise<'ok' | 'not-found' | 'version-conflict'> {
    const now = this.clock.nowIso();
    const result = await tx.query(
      `UPDATE human_agents
       SET availability = $1::jsonb, location = $2::jsonb, territories = $3::jsonb,
           version = version + 1, updated_at = $4
       WHERE agent_id = $5 AND version = $6`,
      [
        JSON.stringify(input.availability),
        input.location === null ? null : JSON.stringify(input.location),
        JSON.stringify(input.territories),
        now,
        input.agentId,
        input.expectedVersion,
      ],
    );
    return casOutcome(tx, input.agentId, result.rowCount);
  }

  /**
   * CAS authorization-state transition on the CALLER'S transaction (the row
   * was locked there; the frozen transition table was already checked). The
   * terminal trigger is the final backstop.
   */
  async updateAuthorizationState(
    tx: DbTransaction,
    input: {
      readonly agentId: string;
      readonly authorizationState: string;
      readonly expectedVersion: number;
    },
  ): Promise<'ok' | 'not-found' | 'version-conflict'> {
    const now = this.clock.nowIso();
    const result = await tx.query(
      `UPDATE human_agents
       SET authorization_state = $1, version = version + 1, updated_at = $2
       WHERE agent_id = $3 AND version = $4`,
      [input.authorizationState, now, input.agentId, input.expectedVersion],
    );
    return casOutcome(tx, input.agentId, result.rowCount);
  }

  /**
   * Row-locked server-derived reliability fold: reads the current signals,
   * applies the pure fold and writes the new aggregate (version increments
   * but NO caller CAS — the counters are server-authoritative derived
   * state, serialized by the row lock, exactly like append-only derived
   * state elsewhere).
   */
  async applyReliabilityObservation(
    tx: DbTransaction,
    input: {
      readonly agentId: string;
      readonly observation: ReliabilityObservation;
    },
  ): Promise<HumanAgentRecord | null> {
    const current = await this.lockHumanAgent(tx, input.agentId);
    if (current === null) return null;
    const next = applyReliabilityObservation(current.reliability, input.observation);
    const now = this.clock.nowIso();
    await tx.query(
      `UPDATE human_agents
       SET reliability = $1::jsonb, version = version + 1, updated_at = $2
       WHERE agent_id = $3`,
      [JSON.stringify(next), now, input.agentId],
    );
    const updated = await this.lockHumanAgent(tx, input.agentId);
    if (updated === null) {
      throw new Error(`updated human agent profile ${input.agentId} could not be read back`);
    }
    return updated;
  }

  /**
   * Candidate narrowing for the eligibility lookup: ACTIVE-authorization
   * profiles of the supplied candidate users (null pool = all active
   * profiles — platform-level internal use). Matching SEMANTICS live in the
   * pure public matcher (single-sourced); this query is a narrowing only.
   */
  async listActiveCandidates(
    candidateUserIds: readonly string[] | null,
  ): Promise<readonly HumanAgentRecord[]> {
    const result =
      candidateUserIds === null
        ? await this.db.query<HumanAgentRow>(
            `${HUMAN_AGENT_SELECT} WHERE authorization_state = 'active' ORDER BY created_at, agent_id`,
          )
        : await this.db.query<HumanAgentRow>(
            `${HUMAN_AGENT_SELECT}
             WHERE authorization_state = 'active' AND user_id = ANY($1::uuid[])
             ORDER BY created_at, agent_id`,
            [toArrayLiteral(candidateUserIds)],
          );
    return result.rows.map(toHumanAgentRecord);
  }
}

async function casOutcome(
  tx: DbTransaction,
  agentId: string,
  rowCount: number,
): Promise<'ok' | 'not-found' | 'version-conflict'> {
  if (rowCount === 1) return 'ok';
  const existing = await tx.query<{ version: number }>(
    'SELECT version FROM human_agents WHERE agent_id = $1',
    [agentId],
  );
  if (existing.rows.length === 0) return 'not-found';
  return 'version-conflict';
}

function toHumanAgentRecord(row: HumanAgentRow): HumanAgentRecord {
  return {
    agentId: row.agent_id,
    userId: row.user_id,
    specializations: row.specializations as HumanAgentRecord['specializations'],
    capabilities: row.capabilities as HumanAgentRecord['capabilities'],
    availability: row.availability as HumanAgentRecord['availability'],
    location: (row.location ?? null) as HumanAgentRecord['location'],
    territories: row.territories as HumanAgentRecord['territories'],
    reliability: row.reliability as HumanAgentRecord['reliability'],
    relationshipContinuity: row.relationship_continuity as HumanAgentRecord['relationshipContinuity'],
    authorizationState: row.authorization_state as HumanAgentRecord['authorizationState'],
    createdBy: row.created_by,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
