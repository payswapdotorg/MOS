/**
 * /social-accounts persistence (the migration-046 tables).
 *
 * DB backstops (migration 046):
 *   - the binding identity/integration/scope columns are IMMUTABLE
 *     (trigger) — a binding can never cross tenants, connections,
 *     workspaces or platform identities;
 *   - the account lifecycle (connected → disconnected | revoked) is
 *     trigger-fenced with BOTH terminal states;
 *   - the grant rows are append-oriented: the ONLY sanctioned UPDATEs
 *     are the single completion fill (pending → authorized) and the
 *     narrow lifecycle transition (the frozen transition table); DELETE
 *     is rejected outright;
 *   - the partial unique fences (one connected binding per connection;
 *     one per (client, platform, external account); one authorized grant
 *     per account; the unique state token) make the idempotent/
 *     conflicting-binding semantics race-free;
 *   - the event tail and the scope records are FULLY append-only
 *     (UPDATE/DELETE rejected outright).
 *
 * Every mutation takes the transaction RUNNER as its first argument (the
 * credentials-store pattern): the module passes the pool for standalone
 * operations and the locked transaction for the multi-step lifecycle
 * sequences (supersede/refresh/disconnect atomicity).
 *
 * The tables have NO column capable of carrying secret material — no
 * token, code, secret or handle column exists anywhere (a static
 * boundary test proves the absence). The credential reference is the
 * /credentials logical-name identity only (§21).
 */

import { ConflictError } from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  SocialAccountEventInsert,
  SocialAccountProvenance,
  SocialAccountRecord,
  SocialAccountStatus,
  SocialGrantRecord,
  SocialGrantScopeFacts,
  SocialGrantState,
} from '../public.ts';
import { classifySocialWriteConflict } from './grant-validation.ts';

interface SocialAccountRow extends DbRow {
  social_account_id: string;
  integration_connection_id: string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  platform_id: string;
  external_account_id: string;
  display_identity: string;
  verified_at: Date | null;
  status: string;
  version: string | number;
  created_at: Date;
  updated_at: Date;
}

interface SocialGrantRow extends DbRow {
  grant_id: string;
  integration_connection_id: string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  social_account_id: string | null;
  platform_id: string;
  grant_state: string;
  state_token: string;
  // jsonb: node-postgres auto-parses to an array (string fallback for safety).
  requested_scopes: unknown;
  credential_reference_id: string | null;
  expires_at: Date | null;
  successor_grant_id: string | null;
  completed_at: Date | null;
  version: string | number;
  created_at: Date;
  updated_at: Date;
}

interface SocialEventRow extends DbRow {
  event_id: string;
  social_account_id: string | null;
  grant_id: string | null;
  event_type: string;
  initiated_by: string;
  reason: string | null;
  provider_revoke_outcome: string | null;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
}

const ACCOUNT_SELECT = `
  SELECT social_account_id, integration_connection_id, agency_id, client_id, workspace_id,
         platform_id, external_account_id, display_identity, verified_at, status,
         version, created_at, updated_at
  FROM social_accounts
`;

const GRANT_SELECT = `
  SELECT grant_id, integration_connection_id, agency_id, client_id, workspace_id, social_account_id,
         platform_id, grant_state, state_token, requested_scopes, credential_reference_id,
         expires_at, successor_grant_id, completed_at, version, created_at, updated_at
  FROM social_account_grants
`;

/** The event-row shape returned by the tail reads (id + recordedAt added). */
export type SocialAccountEventRow = SocialAccountEventInsert & {
  readonly eventId: string;
  readonly recordedAt: string;
};

export class SocialAccountsStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  // -------------------------------------------------------------------------
  // Bindings
  // -------------------------------------------------------------------------

  /**
   * Appends a binding row (born 'connected'). The partial unique fences
   * (connection-active + client-identity) back the conflicting-binding
   * rejection under concurrency; a fence hit throws (the module maps it
   * to ConflictError through classifySocialWriteConflict).
   */
  async insertAccount(
    runner: DbTransaction,
    input: {
      readonly integrationConnectionId: string;
      readonly agencyId: string;
      readonly clientId: string;
      readonly workspaceId: string | null;
      readonly platformId: string;
      readonly externalAccountId: string;
      readonly displayIdentity: string;
      readonly verifiedAt: string | null;
    },
    provenance: SocialAccountProvenance,
  ): Promise<SocialAccountRecord> {
    const socialAccountId = this.ids.newId();
    const now = new Date(this.clock.nowIso());
    try {
      await runner.query(
        `INSERT INTO social_accounts
           (social_account_id, integration_connection_id, agency_id, client_id, workspace_id,
            platform_id, external_account_id, display_identity, verified_at, status,
            created_by_actor, created_via, correlation_id, causation_id,
            created_at, updated_at, version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'connected', $10, $11, $12, $13, $14, $14, 1)`,
        [
          socialAccountId,
          input.integrationConnectionId,
          input.agencyId,
          input.clientId,
          input.workspaceId,
          input.platformId,
          input.externalAccountId,
          input.displayIdentity,
          input.verifiedAt === null ? null : new Date(input.verifiedAt),
          provenance.actor,
          provenance.recordedVia,
          provenance.correlationId,
          provenance.causationId,
          now,
        ],
      );
    } catch (error) {
      const fence = classifySocialWriteConflict(error);
      if (fence !== null) {
        throw new ConflictError(
          fence === 'connection-already-bound'
            ? 'the integration connection already binds one platform identity (one connection binds one platform identity — fail-closed)'
            : 'the external account identity already has an active binding in this client (conflicting binding rejected — fail-closed)',
        );
      }
      throw error;
    }
    const created = await this.accountVia(runner, socialAccountId);
    if (created === null) {
      throw new Error(`inserted social account ${socialAccountId} could not be read back`);
    }
    return created;
  }

  async getAccount(socialAccountId: string): Promise<SocialAccountRecord | null> {
    return this.accountVia(this.db, socialAccountId);
  }

  /** The account read on the CALLER'S runner (transactional read-backs). */
  async accountVia(
    runner: DbTransaction,
    socialAccountId: string,
  ): Promise<SocialAccountRecord | null> {
    const result = await runner.query<SocialAccountRow>(
      `${ACCOUNT_SELECT} WHERE social_account_id = $1`,
      [socialAccountId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toAccountRecord(row);
  }

  /**
   * The CONNECTED binding of one integration connection (the
   * idempotent-reconnect convergence lookup) — NULL when the connection
   * is unbound or its binding is dead.
   */
  async getConnectedAccountForConnection(
    integrationConnectionId: string,
  ): Promise<SocialAccountRecord | null> {
    const result = await this.db.query<SocialAccountRow>(
      `${ACCOUNT_SELECT} WHERE integration_connection_id = $1 AND status = 'connected'`,
      [integrationConnectionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toAccountRecord(row);
  }

  async listAccountsForClient(clientId: string): Promise<readonly SocialAccountRecord[]> {
    const result = await this.db.query<SocialAccountRow>(
      `${ACCOUNT_SELECT} WHERE client_id = $1 ORDER BY created_at DESC, social_account_id DESC`,
      [clientId],
    );
    return result.rows.map(toAccountRecord);
  }

  async listAccountsForWorkspace(workspaceId: string): Promise<readonly SocialAccountRecord[]> {
    const result = await this.db.query<SocialAccountRow>(
      `${ACCOUNT_SELECT} WHERE workspace_id = $1 ORDER BY created_at DESC, social_account_id DESC`,
      [workspaceId],
    );
    return result.rows.map(toAccountRecord);
  }

  /**
   * THE DEATH TRANSITION (the terminal account lifecycle move — CAS):
   * connected → disconnected | revoked. The trigger backstops the
   * terminal states (a dead binding can never be re-activated in place).
   */
  async transitionAccountStatus(
    runner: DbTransaction,
    input: {
      readonly socialAccountId: string;
      readonly status: SocialAccountStatus;
      readonly expectedVersion: number;
    },
  ): Promise<SocialAccountRecord> {
    const now = new Date(this.clock.nowIso());
    const result = await runner.query(
      `UPDATE social_accounts
       SET status = $1, version = version + 1, updated_at = $2
       WHERE social_account_id = $3 AND version = $4`,
      [input.status, now, input.socialAccountId, input.expectedVersion],
    );
    if (result.rowCount !== 1) {
      throw new ConflictError(
        `social account ${input.socialAccountId} update lost the version race (or the account is gone)`,
      );
    }
    const updated = await this.accountVia(runner, input.socialAccountId);
    if (updated === null) {
      throw new Error(`updated social account ${input.socialAccountId} could not be read back`);
    }
    return updated;
  }

  // -------------------------------------------------------------------------
  // Grants (the append-oriented authorization records)
  // -------------------------------------------------------------------------

  /** Appends a PENDING round (authorize-start). */
  async insertPendingGrant(
    runner: DbTransaction,
    input: {
      readonly integrationConnectionId: string;
      readonly agencyId: string;
      readonly clientId: string;
      readonly workspaceId: string | null;
      readonly socialAccountId: string | null;
      readonly platformId: string;
      readonly stateToken: string;
      readonly requestedScopes: readonly string[] | null;
    },
    provenance: SocialAccountProvenance,
  ): Promise<SocialGrantRecord> {
    const grantId = this.ids.newId();
    const now = new Date(this.clock.nowIso());
    try {
      await runner.query(
        `INSERT INTO social_account_grants
           (grant_id, integration_connection_id, agency_id, client_id, workspace_id, social_account_id,
            platform_id, grant_state, state_token, requested_scopes,
            started_by_actor, started_via, started_correlation_id, started_causation_id,
            created_at, updated_at, version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10, $11, $12, $13, $14, $14, 1)`,
        [
          grantId,
          input.integrationConnectionId,
          input.agencyId,
          input.clientId,
          input.workspaceId,
          input.socialAccountId,
          input.platformId,
          input.stateToken,
          input.requestedScopes === null ? null : JSON.stringify([...input.requestedScopes]),
          provenance.actor,
          provenance.recordedVia,
          provenance.correlationId,
          provenance.causationId,
          now,
        ],
      );
    } catch (error) {
      if (classifySocialWriteConflict(error) !== null) {
        throw new ConflictError('the authorize-start state token collided — retry the round');
      }
      throw error;
    }
    const created = await this.grantVia(runner, grantId);
    if (created === null) {
      throw new Error(`inserted grant ${grantId} could not be read back`);
    }
    return created;
  }

  /**
   * Appends a SUCCESSOR grant born 'authorized' (the refresh path — the
   * successor of a refresh cycle). The partial authorized-grant fence
   * backs the single-active-authorization invariant: the caller
   * transitions the predecessor BEFORE inserting the successor, inside
   * ONE transaction.
   */
  async insertAuthorizedSuccessorGrant(
    runner: DbTransaction,
    input: {
      readonly grantId: string;
      readonly integrationConnectionId: string;
      readonly agencyId: string;
      readonly clientId: string;
      readonly workspaceId: string | null;
      readonly socialAccountId: string;
      readonly platformId: string;
      readonly stateToken: string;
      readonly requestedScopes: readonly string[] | null;
      readonly credentialReferenceId: string;
      readonly expiresAt: string | null;
      readonly startedByProvenance: SocialAccountProvenance;
    },
    completionProvenance: SocialAccountProvenance,
  ): Promise<SocialGrantRecord> {
    const now = new Date(this.clock.nowIso());
    try {
      await runner.query(
        `INSERT INTO social_account_grants
           (grant_id, integration_connection_id, agency_id, client_id, workspace_id, social_account_id,
            platform_id, grant_state, state_token, requested_scopes,
            credential_reference_id, expires_at, completed_at,
            started_by_actor, started_via, started_correlation_id, started_causation_id,
            completed_by_actor, completed_via, completed_correlation_id, completed_causation_id,
            created_at, updated_at, version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'authorized', $8, $9, $10, $11, $12,
                 $13, $14, $15, $16, $17, $18, $19, $20, $21, $21, 1)`,
        [
          input.grantId,
          input.integrationConnectionId,
          input.agencyId,
          input.clientId,
          input.workspaceId,
          input.socialAccountId,
          input.platformId,
          input.stateToken,
          input.requestedScopes === null ? null : JSON.stringify([...input.requestedScopes]),
          input.credentialReferenceId,
          input.expiresAt === null ? null : new Date(input.expiresAt),
          now,
          input.startedByProvenance.actor,
          input.startedByProvenance.recordedVia,
          input.startedByProvenance.correlationId,
          input.startedByProvenance.causationId,
          completionProvenance.actor,
          completionProvenance.recordedVia,
          completionProvenance.correlationId,
          completionProvenance.causationId,
          now,
        ],
      );
    } catch (error) {
      const fence = classifySocialWriteConflict(error);
      if (fence !== null) {
        throw new ConflictError(
          'the account already holds an authorized grant — the predecessor must transition first (single active authorization)',
        );
      }
      throw error;
    }
    const created = await this.grantVia(runner, input.grantId);
    if (created === null) {
      throw new Error(`inserted successor grant ${input.grantId} could not be read back`);
    }
    return created;
  }

  async getGrant(grantId: string): Promise<SocialGrantRecord | null> {
    return this.grantVia(this.db, grantId);
  }

  /** The grant read on the CALLER'S runner (transactional read-backs). */
  async grantVia(runner: DbTransaction, grantId: string): Promise<SocialGrantRecord | null> {
    const result = await runner.query<SocialGrantRow>(
      `${GRANT_SELECT} WHERE grant_id = $1`,
      [grantId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toGrantRecord(row);
  }

  /** The round correlated by the OPAQUE state token (unique). */
  async getGrantByStateToken(stateToken: string): Promise<SocialGrantRecord | null> {
    const result = await this.db.query<SocialGrantRow>(
      `${GRANT_SELECT} WHERE state_token = $1`,
      [stateToken],
    );
    const row = result.rows[0];
    return row === undefined ? null : toGrantRecord(row);
  }

  /**
   * The CURRENT authorized grant of an account (at most one — the partial
   * fence). NULL when the account holds no authorized grant.
   */
  async getCurrentAuthorizedGrant(
    socialAccountId: string,
  ): Promise<SocialGrantRecord | null> {
    const result = await this.db.query<SocialGrantRow>(
      `${GRANT_SELECT} WHERE social_account_id = $1 AND grant_state = 'authorized'
       ORDER BY created_at DESC, grant_id DESC`,
      [socialAccountId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toGrantRecord(row);
  }

  /**
   * The account's CURRENT REFRESHABLE grant (MKT-055 AC-2 — the frozen
   * contract: authorized OR expired, the refresh-token recovery path).
   * FILLED grants only (`credential_reference_id IS NOT NULL`): a dead
   * expired round that never completed carries no vault reference and is
   * never a refresh candidate. At most one filled authorized-or-expired
   * grant exists at any time (the authorized fence + the supersede
   * discipline), so newest-first + LIMIT 1 is exact.
   */
  async getCurrentRefreshableGrant(
    socialAccountId: string,
  ): Promise<SocialGrantRecord | null> {
    const result = await this.db.query<SocialGrantRow>(
      `${GRANT_SELECT} WHERE social_account_id = $1
         AND grant_state IN ('authorized', 'expired')
         AND credential_reference_id IS NOT NULL
       ORDER BY created_at DESC, grant_id DESC
       LIMIT 1`,
      [socialAccountId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toGrantRecord(row);
  }

  /**
   * Locks an account row (FOR UPDATE) on the caller's transaction — the
   * completion/refresh/death serialization point: every lifecycle
   * transaction that can land an authorized grant on, or kill, an
   * EXISTING binding takes the account lock FIRST, so a completion that
   * races a disconnect/revocation either observes the terminal state and
   * refuses, or commits before the death sweep reads the live-grant set
   * (no authorized grant can survive on a dead binding).
   */
  async lockAccount(
    runner: DbTransaction,
    socialAccountId: string,
  ): Promise<SocialAccountRecord | null> {
    const result = await runner.query<SocialAccountRow>(
      `${ACCOUNT_SELECT} WHERE social_account_id = $1 FOR UPDATE`,
      [socialAccountId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toAccountRecord(row);
  }

  /**
   * The account's CURRENT FILLED grant (authorized or expired, WITH a
   * vault reference) FOR UPDATE on the caller's transaction — the
   * supersede target of a completion. The FILLED filter is load-bearing:
   * a stale expired round that never completed (no credential) must NEVER
   * be picked as the supersede target (transitioning it to 'superseded'
   * would violate the migration-046 payload-shape CHECK — only a
   * revoked/revoked-with-expiry death is legal for a never-completed row).
   */
  async lockCurrentFilledGrant(
    runner: DbTransaction,
    socialAccountId: string,
  ): Promise<SocialGrantRecord | null> {
    const result = await runner.query<SocialGrantRow>(
      `${GRANT_SELECT} WHERE social_account_id = $1
         AND grant_state IN ('authorized', 'expired')
         AND credential_reference_id IS NOT NULL
       ORDER BY created_at DESC, grant_id DESC
       LIMIT 1 FOR UPDATE`,
      [socialAccountId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toGrantRecord(row);
  }

  /**
   * The account's live grants (authorized + expired — the death sweep
   * set) FOR UPDATE on the caller's transaction. Includes never-completed
   * expired rounds: their only legal moves are 'expired' → revoked, which
   * the shape CHECK admits. Read AFTER the account lock inside the death
   * transaction — the definitive set no straggler can escape.
   */
  async lockLiveGrants(
    runner: DbTransaction,
    socialAccountId: string,
  ): Promise<readonly SocialGrantRecord[]> {
    const result = await runner.query<SocialGrantRow>(
      `${GRANT_SELECT} WHERE social_account_id = $1
         AND grant_state IN ('authorized', 'expired')
       ORDER BY created_at DESC, grant_id DESC
       FOR UPDATE`,
      [socialAccountId],
    );
    return result.rows.map(toGrantRecord);
  }

  /** The account's grant tail (the authorization history, newest first). */
  async listGrantsForAccount(socialAccountId: string): Promise<readonly SocialGrantRecord[]> {
    const result = await this.db.query<SocialGrantRow>(
      `${GRANT_SELECT} WHERE social_account_id = $1 ORDER BY created_at DESC, grant_id DESC`,
      [socialAccountId],
    );
    return result.rows.map(toGrantRecord);
  }

  /** Locks a grant row (FOR UPDATE) — the completion/supersede serialization. */
  async lockGrant(
    tx: DbTransaction,
    grantId: string,
  ): Promise<SocialGrantRecord | null> {
    const result = await tx.query<SocialGrantRow>(
      `${GRANT_SELECT} WHERE grant_id = $1 FOR UPDATE`,
      [grantId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toGrantRecord(row);
  }

  /**
   * THE SINGLE COMPLETION FILL (pending → authorized): fills exactly-once
   * the nullable completion facts. The migration-046 trigger backstops
   * the fill discipline (never twice, never a rewrite, never a consumed
   * round); the CAS version backstops the race.
   */
  async completeGrant(
    runner: DbTransaction,
    input: {
      readonly grantId: string;
      readonly socialAccountId: string;
      readonly credentialReferenceId: string;
      readonly expiresAt: string | null;
      readonly expectedVersion: number;
    },
    provenance: SocialAccountProvenance,
  ): Promise<SocialGrantRecord> {
    const now = new Date(this.clock.nowIso());
    const result = await runner.query(
      `UPDATE social_account_grants
       SET grant_state = 'authorized', social_account_id = $1, credential_reference_id = $2,
           expires_at = $3, completed_at = $4,
           completed_by_actor = $5, completed_via = $6,
           completed_correlation_id = $7, completed_causation_id = $8,
           version = version + 1, updated_at = $4
       WHERE grant_id = $9 AND grant_state = 'pending' AND version = $10`,
      [
        input.socialAccountId,
        input.credentialReferenceId,
        input.expiresAt === null ? null : new Date(input.expiresAt),
        now,
        provenance.actor,
        provenance.recordedVia,
        provenance.correlationId,
        provenance.causationId,
        input.grantId,
        input.expectedVersion,
      ],
    );
    if (result.rowCount !== 1) {
      throw new ConflictError(
        `grant ${input.grantId} is not a completable pending round (already consumed, or a version race)`,
      );
    }
    const updated = await this.grantVia(runner, input.grantId);
    if (updated === null) {
      throw new Error(`completed grant ${input.grantId} could not be read back`);
    }
    return updated;
  }

  /**
   * THE NARROW LIFECYCLE TRANSITION (the frozen grant transition table):
   * moves the state (optionally naming the successor link). Called on the
   * CALLER'S transaction where the supersede/refresh ordering matters.
   */
  async transitionGrantState(
    runner: DbTransaction,
    input: {
      readonly grantId: string;
      readonly grantState: SocialGrantState;
      readonly successorGrantId: string | null;
      readonly expectedVersion: number;
    },
  ): Promise<void> {
    const now = new Date(this.clock.nowIso());
    const result = await runner.query(
      `UPDATE social_account_grants
       SET grant_state = $1, successor_grant_id = COALESCE($2, successor_grant_id),
           version = version + 1, updated_at = $3
       WHERE grant_id = $4 AND version = $5`,
      [
        input.grantState,
        input.successorGrantId,
        now,
        input.grantId,
        input.expectedVersion,
      ],
    );
    if (result.rowCount !== 1) {
      throw new ConflictError(
        `grant ${input.grantId} transition to '${input.grantState}' lost the version race (or the grant is gone)`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Scope records (the verbatim + normalized facts)
  // -------------------------------------------------------------------------

  /**
   * Appends the scope records of one completed grant: the EXACT granted
   * scope list VERBATIM (order preserved) + the platform-normalized
   * capability tags. Never rewritten (append-only triggers).
   */
  async insertGrantScopes(
    runner: DbTransaction,
    input: {
      readonly grantId: string;
      readonly grantedScopes: readonly string[];
      readonly capabilityTags: readonly string[];
    },
  ): Promise<void> {
    const rows: unknown[][] = [];
    input.grantedScopes.forEach((scope, position) => {
      rows.push([input.grantId, 'granted-scope', scope, position]);
    });
    input.capabilityTags.forEach((tag, position) => {
      rows.push([input.grantId, 'capability-tag', tag, position]);
    });
    if (rows.length === 0) return;
    const values = rows
      .map((_, index) => {
        const base = index * 4;
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
      })
      .join(', ');
    const params = rows.flat();
    try {
      await runner.query(
        `INSERT INTO social_account_grant_scopes (grant_id, scope_kind, scope_value, position)
         VALUES ${values}`,
        params as never[],
      );
    } catch (error) {
      if (classifySocialWriteConflict(error) !== null) {
        throw new ConflictError('the grant scope records collided — retry');
      }
      throw error;
    }
  }

  /** The scope facts of one grant (verbatim list + capability tags, order preserved). */
  async getGrantScopeFacts(grantId: string): Promise<SocialGrantScopeFacts> {
    const result = await this.db.query<{
      scope_kind: string;
      scope_value: string;
      position: number;
    }>(
      `SELECT scope_kind, scope_value, position FROM social_account_grant_scopes
       WHERE grant_id = $1 ORDER BY scope_kind, position`,
      [grantId],
    );
    const grantedScopes = result.rows
      .filter((row) => row.scope_kind === 'granted-scope')
      .sort((a, b) => a.position - b.position)
      .map((row) => row.scope_value);
    const capabilityTags = result.rows
      .filter((row) => row.scope_kind === 'capability-tag')
      .sort((a, b) => a.position - b.position)
      .map((row) => row.scope_value);
    return { grantedScopes, capabilityTags };
  }

  // -------------------------------------------------------------------------
  // The append-only history tail
  // -------------------------------------------------------------------------

  /** Appends one immutable history event (server-derived provenance). */
  async appendEvent(runner: DbTransaction, event: SocialAccountEventInsert): Promise<void> {
    const eventId = this.ids.newId();
    const now = new Date(this.clock.nowIso());
    await runner.query(
      `INSERT INTO social_account_events
         (event_id, social_account_id, grant_id, event_type, initiated_by, reason,
          provider_revoke_outcome, recorded_actor, recorded_via, correlation_id, causation_id,
          recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        eventId,
        event.socialAccountId,
        event.grantId,
        event.eventType,
        event.initiatedBy,
        event.reason,
        event.providerRevokeOutcome,
        event.recordedActor,
        event.recordedVia,
        event.correlationId,
        event.causationId,
        now,
      ],
    );
  }

  /** The account's history tail (oldest first — the audit read). */
  async listEventsForAccount(
    socialAccountId: string,
  ): Promise<readonly SocialAccountEventRow[]> {
    // The tail includes the events anchored to the account AND the events
    // anchored to its ROUNDS (an authorization_started event of a fresh
    // round predates the binding — it anchors to the grant only).
    const result = await this.db.query<SocialEventRow>(
      `SELECT event_id, social_account_id, grant_id, event_type, initiated_by, reason,
              provider_revoke_outcome, recorded_actor, recorded_via, correlation_id, causation_id, recorded_at
       FROM social_account_events
       WHERE social_account_id = $1
          OR grant_id IN (SELECT grant_id FROM social_account_grants WHERE social_account_id = $1)
       ORDER BY recorded_at, event_id`,
      [socialAccountId],
    );
    return result.rows.map(toEventRecord);
  }
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function toAccountRecord(row: SocialAccountRow): SocialAccountRecord {
  return {
    socialAccountId: row.social_account_id,
    integrationConnectionId: row.integration_connection_id,
    agencyId: row.agency_id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    platformId: row.platform_id,
    externalAccountId: row.external_account_id,
    displayIdentity: row.display_identity,
    verifiedAt: row.verified_at === null ? null : row.verified_at.toISOString(),
    status: row.status as SocialAccountStatus,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toGrantRecord(row: SocialGrantRow): SocialGrantRecord {
  return {
    grantId: row.grant_id,
    integrationConnectionId: row.integration_connection_id,
    agencyId: row.agency_id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    socialAccountId: row.social_account_id,
    platformId: row.platform_id,
    grantState: row.grant_state as SocialGrantState,
    stateToken: row.state_token,
    requestedScopes:
      row.requested_scopes === null || row.requested_scopes === undefined
        ? null
        : Array.isArray(row.requested_scopes)
          ? row.requested_scopes.map((scope) => String(scope))
          : (JSON.parse(String(row.requested_scopes)) as unknown[]).map((scope) => String(scope)),
    credentialReferenceId: row.credential_reference_id,
    expiresAt: row.expires_at === null ? null : row.expires_at.toISOString(),
    successorGrantId: row.successor_grant_id,
    completedAt: row.completed_at === null ? null : row.completed_at.toISOString(),
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toEventRecord(row: SocialEventRow): SocialAccountEventRow {
  return {
    eventId: row.event_id,
    socialAccountId: row.social_account_id,
    grantId: row.grant_id,
    eventType: row.event_type as SocialAccountEventInsert['eventType'],
    initiatedBy: row.initiated_by as 'operator' | 'external-signal',
    reason: row.reason,
    providerRevokeOutcome: row.provider_revoke_outcome as SocialAccountEventInsert['providerRevokeOutcome'],
    recordedActor: row.recorded_actor,
    recordedVia: row.recorded_via,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    recordedAt: row.recorded_at.toISOString(),
  };
}
