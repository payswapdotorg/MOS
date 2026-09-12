/**
 * Creator Operations Domain Pack — the pack STORE (MKT-037, CREATOR-001).
 *
 * SQL access to the pack-owned, Client-scoped tables of migration 031.
 * The database is the backstop (implementation-contract §25): the
 * migration-031 scope-chain triggers re-fence client ∈ agency and the
 * pack ownership chains on every row, the append-only/immutability
 * triggers reject rewrites, the lifecycle triggers enforce the frozen
 * transition tables, and the unique fences bound duplicates. This store
 * never composes an authority — it only reads/writes pack-owned rows and
 * surfaces the fences as typed outcomes; canonical Client ownership
 * resolution and the observation/policy/AI composition happen in the
 * pack module through the structural ports.
 *
 * Fail-closed contract: every method is pure data access; unique-fence
 * violations are classified (23505 by constraint), CAS races surface as
 * 'version-conflict', and unknown rows surface as null (the module throws
 * the uniform 404).
 */

import type { Db, DbTransaction, DbRow } from '../../../../../platform/db/contract.ts';
import { ConflictError } from '../../../../../platform/errors/errors.ts';
import type { IdGenerator } from '../../../../../platform/ids/ids.ts';
import type { Clock } from '../../../../../platform/clock/clock.ts';
import type {
  CreatorAccountRecord,
  CreatorAccountStatus,
  CreatorContentAssetRecord,
  CreatorContentStatus,
  CreatorConversationRecord,
  CreatorConversationStatus,
  CreatorFanRecord,
  CreatorFanStatus,
  CreatorMessageRecord,
  CreatorOfferRecord,
  CreatorOfferStatus,
  CreatorOperationApprovalRecord,
  CreatorProfileRecord,
} from './contract.ts';

/** The bounded listing limit (server-chosen; append-only rows grow without end). */
const LIST_LIMIT = 200;

/** A converged duplicate: the existing row plus the replay flag. */
export interface CreatorInsertOutcome<T> {
  readonly record: T;
  readonly replayed: boolean;
}

/** Classifies a PostgreSQL write error by fence (the framework store pattern). */
export function classifyCreatorWriteConflict(
  error: unknown,
): 'unique-fence' | 'scope-backstop' | 'lifecycle-backstop' | null {
  const candidate = error as { code?: string };
  if (candidate?.code === '23505') return 'unique-fence';
  if (candidate?.code === '23503') return 'scope-backstop';
  if (candidate?.code === '23514' || candidate?.code === 'P0001') return 'lifecycle-backstop';
  return null;
}

function jsonbArray(value: unknown): readonly string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  return [];
}

function jsonbObject(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || value === undefined) return {};
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : new Date(value as string).toISOString();
}

function iso(value: unknown): string {
  return new Date(value as string).toISOString();
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

// ---------------------------------------------------------------------------
// Row mappers (snake_case DB → camelCase record)
// ---------------------------------------------------------------------------

function mapProfile(row: DbRow): CreatorProfileRecord {
  return {
    profileId: String(row['profile_id']),
    agencyId: String(row['agency_id']),
    clientId: String(row['client_id']),
    displayName: String(row['display_name']),
    handle: String(row['handle']),
    niches: jsonbArray(row['niches']),
    bio: String(row['bio'] ?? ''),
    attributes: jsonbObject(row['attributes']),
    createdBy: textOrNull(row['created_by']),
    createdAt: iso(row['created_at']),
  };
}

function mapAccount(row: DbRow): CreatorAccountRecord {
  return {
    accountId: String(row['account_id']),
    agencyId: String(row['agency_id']),
    clientId: String(row['client_id']),
    profileId: String(row['profile_id']),
    platformLabel: String(row['platform_label']),
    accountHandle: String(row['account_handle']),
    status: String(row['status']) as CreatorAccountStatus,
    metadata: jsonbObject(row['metadata']),
    version: Number(row['version']),
    createdBy: textOrNull(row['created_by']),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
    retiredAt: isoOrNull(row['retired_at']),
  };
}

function mapFan(row: DbRow): CreatorFanRecord {
  return {
    fanId: String(row['fan_id']),
    agencyId: String(row['agency_id']),
    clientId: String(row['client_id']),
    accountId: String(row['account_id']),
    fanAlias: String(row['fan_alias']),
    status: String(row['status']) as CreatorFanRecord['status'],
    tier: String(row['tier']) as CreatorFanRecord['tier'],
    tags: jsonbArray(row['tags']),
    attributes: jsonbObject(row['attributes']),
    version: Number(row['version']),
    createdBy: textOrNull(row['created_by']),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
    removedAt: isoOrNull(row['removed_at']),
  };
}

function mapConversation(row: DbRow): CreatorConversationRecord {
  return {
    conversationId: String(row['conversation_id']),
    agencyId: String(row['agency_id']),
    clientId: String(row['client_id']),
    accountId: String(row['account_id']),
    fanId: String(row['fan_id']),
    status: String(row['status']) as CreatorConversationRecord['status'],
    channel: String(row['channel']) as CreatorConversationRecord['channel'],
    topic: String(row['topic'] ?? ''),
    attributes: jsonbObject(row['attributes']),
    version: Number(row['version']),
    createdBy: textOrNull(row['created_by']),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
    closedAt: isoOrNull(row['closed_at']),
  };
}

function mapMessage(row: DbRow): CreatorMessageRecord {
  return {
    messageId: String(row['message_id']),
    agencyId: String(row['agency_id']),
    clientId: String(row['client_id']),
    conversationId: String(row['conversation_id']),
    direction: String(row['direction']) as 'inbound' | 'outbound',
    status: String(row['status']) as 'received' | 'sent',
    body: String(row['body']),
    policyDecisionId: textOrNull(row['policy_decision_id']),
    approvalId: textOrNull(row['approval_id']),
    evidenceRef: textOrNull(row['evidence_ref']),
    idempotencyKey: String(row['idempotency_key']),
    createdBy: textOrNull(row['created_by']),
    createdAt: iso(row['created_at']),
  };
}

function mapContentAsset(row: DbRow): CreatorContentAssetRecord {
  return {
    assetId: String(row['asset_id']),
    agencyId: String(row['agency_id']),
    clientId: String(row['client_id']),
    profileId: String(row['profile_id']),
    status: String(row['status']) as CreatorContentAssetRecord['status'],
    title: String(row['title']),
    contentKind: String(row['content_kind']) as CreatorContentAssetRecord['contentKind'],
    plannedPlatforms: jsonbArray(row['planned_platforms']),
    brief: String(row['brief'] ?? ''),
    attributes: jsonbObject(row['attributes']),
    version: Number(row['version']),
    createdBy: textOrNull(row['created_by']),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
    publishedAt: isoOrNull(row['published_at']),
    rejectedAt: isoOrNull(row['rejected_at']),
    policyDecisionId: textOrNull(row['policy_decision_id']),
    approvalId: textOrNull(row['approval_id']),
  };
}

function mapOffer(row: DbRow): CreatorOfferRecord {
  return {
    offerId: String(row['offer_id']),
    agencyId: String(row['agency_id']),
    clientId: String(row['client_id']),
    profileId: String(row['profile_id']),
    status: String(row['status']) as CreatorOfferRecord['status'],
    title: String(row['title']),
    offerKind: String(row['offer_kind']) as CreatorOfferRecord['offerKind'],
    priceCents: Number(row['price_cents']),
    currency: String(row['currency']),
    terms: String(row['terms'] ?? ''),
    attributes: jsonbObject(row['attributes']),
    version: Number(row['version']),
    createdBy: textOrNull(row['created_by']),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
    retiredAt: isoOrNull(row['retired_at']),
  };
}

function mapApproval(row: DbRow): CreatorOperationApprovalRecord {
  return {
    approvalId: String(row['approval_id']),
    agencyId: String(row['agency_id']),
    clientId: String(row['client_id']),
    action: String(row['action']) as CreatorOperationApprovalRecord['action'],
    resourceId: String(row['resource_id']),
    decision: String(row['decision']) as CreatorOperationApprovalRecord['decision'],
    approverUserId: String(row['approver_user_id']),
    approverSpecializations: jsonbArray(row['approver_specializations']),
    notes: String(row['notes'] ?? ''),
    idempotencyKey: String(row['idempotency_key']),
    createdAt: iso(row['created_at']),
  };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export class CreatorOperationsStore {
  /** The frozen terminal status targets that carry a terminal-at stamp (migration 031). */
  private readonly terminalTargets = new Set<string>(['retired', 'removed', 'closed']);

  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  // ----- Profiles -----------------------------------------------------------

  async insertCreatorProfile(
    input: {
      readonly clientId: string;
      readonly agencyId: string;
      readonly displayName: string;
      readonly handle: string;
      readonly niches: readonly string[];
      readonly bio: string;
      readonly attributes: Readonly<Record<string, unknown>>;
    },
    actorId: string | null,
  ): Promise<CreatorInsertOutcome<CreatorProfileRecord>> {
    const profileId = this.ids.newId();
    try {
      const result = await this.db.query(
        `INSERT INTO creator_profiles
           (profile_id, agency_id, client_id, display_name, handle, niches, bio, attributes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9)
         RETURNING *`,
        [
          profileId,
          input.agencyId,
          input.clientId,
          input.displayName,
          input.handle,
          JSON.stringify(input.niches),
          input.bio,
          JSON.stringify(input.attributes),
          actorId,
        ],
      );
      return { record: mapProfile(result.rows[0]!), replayed: false };
    } catch (error) {
      if (classifyCreatorWriteConflict(error) === 'unique-fence') {
        const existing = await this.findCreatorProfileByHandle(input.clientId, input.handle);
        if (existing !== null) {
          throw new ConflictError(
            `creator profile handle '${input.handle}' already exists in this client (append-only: a correction appends a new handle record)`,
          );
        }
      }
      throw error;
    }
  }

  async findCreatorProfileByHandle(
    clientId: string,
    handle: string,
  ): Promise<CreatorProfileRecord | null> {
    const result = await this.db.query(
      `SELECT * FROM creator_profiles WHERE client_id = $1 AND handle = $2 LIMIT 1`,
      [clientId, handle],
    );
    return result.rows.length > 0 ? mapProfile(result.rows[0]!) : null;
  }

  async getCreatorProfile(profileId: string): Promise<CreatorProfileRecord | null> {
    const result = await this.db.query(
      `SELECT * FROM creator_profiles WHERE profile_id = $1 LIMIT 1`,
      [profileId],
    );
    return result.rows.length > 0 ? mapProfile(result.rows[0]!) : null;
  }

  async listCreatorProfilesForClient(clientId: string): Promise<readonly CreatorProfileRecord[]> {
    const result = await this.db.query(
      `SELECT * FROM creator_profiles WHERE client_id = $1
         ORDER BY created_at DESC, profile_id LIMIT ${LIST_LIMIT}`,
      [clientId],
    );
    return result.rows.map(mapProfile);
  }

  // ----- Accounts -----------------------------------------------------------

  async insertCreatorAccount(
    input: {
      readonly clientId: string;
      readonly agencyId: string;
      readonly profileId: string;
      readonly platformLabel: string;
      readonly accountHandle: string;
      readonly metadata: Readonly<Record<string, unknown>>;
    },
    actorId: string | null,
  ): Promise<CreatorInsertOutcome<CreatorAccountRecord>> {
    const accountId = this.ids.newId();
    try {
      const result = await this.db.query(
        `INSERT INTO creator_accounts
           (account_id, agency_id, client_id, profile_id, platform_label, account_handle, metadata, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         RETURNING *`,
        [
          accountId,
          input.agencyId,
          input.clientId,
          input.profileId,
          input.platformLabel,
          input.accountHandle,
          JSON.stringify(input.metadata),
          actorId,
        ],
      );
      return { record: mapAccount(result.rows[0]!), replayed: false };
    } catch (error) {
      if (classifyCreatorWriteConflict(error) === 'unique-fence') {
        throw new ConflictError(
          `creator account '${input.accountHandle}' on platform label '${input.platformLabel}' already exists for this profile (identity is immutable: a correction appends a new record)`,
        );
      }
      throw error;
    }
  }

  async getCreatorAccount(accountId: string): Promise<CreatorAccountRecord | null> {
    const result = await this.db.query(
      `SELECT * FROM creator_accounts WHERE account_id = $1 LIMIT 1`,
      [accountId],
    );
    return result.rows.length > 0 ? mapAccount(result.rows[0]!) : null;
  }

  async listCreatorAccountsForProfile(
    profileId: string,
  ): Promise<readonly CreatorAccountRecord[]> {
    const result = await this.db.query(
      `SELECT * FROM creator_accounts WHERE profile_id = $1
         ORDER BY created_at DESC, account_id LIMIT ${LIST_LIMIT}`,
      [profileId],
    );
    return result.rows.map(mapAccount);
  }

  async setCreatorAccountStatus(
    input: {
      readonly accountId: string;
      readonly status: CreatorAccountStatus;
      readonly expectedVersion: number;
    },
    actorId: string | null,
  ): Promise<CreatorAccountRecord | 'not-found' | 'version-conflict'> {
    void actorId;
    return this.db.transaction(async (tx) => {
      const updated = await this.casStatusTransition(tx, {
        table: 'creator_accounts',
        key: 'account_id',
        stampColumn: 'retired_at',
        id: input.accountId,
        status: input.status,
        expectedVersion: input.expectedVersion,
      });
      if (typeof updated === 'string') return updated;
      return mapAccount(updated);
    });
  }

  // ----- Fans ---------------------------------------------------------------

  async insertCreatorFan(
    input: {
      readonly clientId: string;
      readonly agencyId: string;
      readonly accountId: string;
      readonly fanAlias: string;
      readonly tier: string;
      readonly tags: readonly string[];
      readonly attributes: Readonly<Record<string, unknown>>;
    },
    actorId: string | null,
  ): Promise<CreatorInsertOutcome<CreatorFanRecord>> {
    const fanId = this.ids.newId();
    try {
      const result = await this.db.query(
        `INSERT INTO creator_fans
           (fan_id, agency_id, client_id, account_id, fan_alias, tier, tags, attributes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
         RETURNING *`,
        [
          fanId,
          input.agencyId,
          input.clientId,
          input.accountId,
          input.fanAlias,
          input.tier,
          JSON.stringify(input.tags),
          JSON.stringify(input.attributes),
          actorId,
        ],
      );
      return { record: mapFan(result.rows[0]!), replayed: false };
    } catch (error) {
      if (classifyCreatorWriteConflict(error) === 'unique-fence') {
        throw new ConflictError(
          `fan alias '${input.fanAlias}' already exists for this creator account (identity is immutable)`,
        );
      }
      throw error;
    }
  }

  async getCreatorFan(fanId: string): Promise<CreatorFanRecord | null> {
    const result = await this.db.query(
      `SELECT * FROM creator_fans WHERE fan_id = $1 LIMIT 1`,
      [fanId],
    );
    return result.rows.length > 0 ? mapFan(result.rows[0]!) : null;
  }

  async listCreatorFansForAccount(accountId: string): Promise<readonly CreatorFanRecord[]> {
    const result = await this.db.query(
      `SELECT * FROM creator_fans WHERE account_id = $1
         ORDER BY created_at DESC, fan_id LIMIT ${LIST_LIMIT}`,
      [accountId],
    );
    return result.rows.map(mapFan);
  }

  async setCreatorFanStatus(
    input: {
      readonly fanId: string;
      readonly status: CreatorFanStatus;
      readonly expectedVersion: number;
    },
    actorId: string | null,
  ): Promise<CreatorFanRecord | 'not-found' | 'version-conflict'> {
    void actorId;
    return this.db.transaction(async (tx) => {
      const updated = await this.casStatusTransition(tx, {
        table: 'creator_fans',
        key: 'fan_id',
        stampColumn: 'removed_at',
        id: input.fanId,
        status: input.status,
        expectedVersion: input.expectedVersion,
      });
      if (typeof updated === 'string') return updated;
      return mapFan(updated);
    });
  }

  // ----- Conversations ------------------------------------------------------

  async insertCreatorConversation(
    input: {
      readonly clientId: string;
      readonly agencyId: string;
      readonly accountId: string;
      readonly fanId: string;
      readonly channel: string;
      readonly topic: string;
      readonly attributes: Readonly<Record<string, unknown>>;
    },
    actorId: string | null,
  ): Promise<CreatorInsertOutcome<CreatorConversationRecord>> {
    const conversationId = this.ids.newId();
    try {
      const result = await this.db.query(
        `INSERT INTO creator_conversations
           (conversation_id, agency_id, client_id, account_id, fan_id, channel, topic, attributes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
         RETURNING *`,
        [
          conversationId,
          input.agencyId,
          input.clientId,
          input.accountId,
          input.fanId,
          input.channel,
          input.topic,
          JSON.stringify(input.attributes),
          actorId,
        ],
      );
      return { record: mapConversation(result.rows[0]!), replayed: false };
    } catch (error) {
      if (classifyCreatorWriteConflict(error) === 'unique-fence') {
        throw new ConflictError(
          `an open conversation in channel '${input.channel}' already exists for this fan and account`,
        );
      }
      throw error;
    }
  }

  async getCreatorConversation(
    conversationId: string,
  ): Promise<CreatorConversationRecord | null> {
    const result = await this.db.query(
      `SELECT * FROM creator_conversations WHERE conversation_id = $1 LIMIT 1`,
      [conversationId],
    );
    return result.rows.length > 0 ? mapConversation(result.rows[0]!) : null;
  }

  async listCreatorConversationsForAccount(
    accountId: string,
  ): Promise<readonly CreatorConversationRecord[]> {
    const result = await this.db.query(
      `SELECT * FROM creator_conversations WHERE account_id = $1
         ORDER BY created_at DESC, conversation_id LIMIT ${LIST_LIMIT}`,
      [accountId],
    );
    return result.rows.map(mapConversation);
  }

  async setCreatorConversationStatus(
    input: {
      readonly conversationId: string;
      readonly status: CreatorConversationStatus;
      readonly expectedVersion: number;
    },
    actorId: string | null,
  ): Promise<CreatorConversationRecord | 'not-found' | 'version-conflict'> {
    void actorId;
    return this.db.transaction(async (tx) => {
      const updated = await this.casStatusTransition(tx, {
        table: 'creator_conversations',
        key: 'conversation_id',
        stampColumn: 'closed_at',
        id: input.conversationId,
        status: input.status,
        expectedVersion: input.expectedVersion,
      });
      if (typeof updated === 'string') return updated;
      return mapConversation(updated);
    });
  }

  // ----- Messages -----------------------------------------------------------

  async insertCreatorMessage(
    input: {
      readonly clientId: string;
      readonly agencyId: string;
      readonly conversationId: string;
      readonly direction: 'inbound' | 'outbound';
      readonly status: 'received' | 'sent';
      readonly body: string;
      readonly policyDecisionId: string | null;
      readonly approvalId: string | null;
      readonly evidenceRef: string | null;
      readonly idempotencyKey: string;
    },
    actorId: string | null,
  ): Promise<CreatorInsertOutcome<CreatorMessageRecord>> {
    const messageId = this.ids.newId();
    try {
      const result = await this.db.query(
        `INSERT INTO creator_conversation_messages
           (message_id, agency_id, client_id, conversation_id, direction, status, body,
            policy_decision_id, approval_id, evidence_ref, idempotency_key, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          messageId,
          input.agencyId,
          input.clientId,
          input.conversationId,
          input.direction,
          input.status,
          input.body,
          input.policyDecisionId,
          input.approvalId,
          input.evidenceRef,
          input.idempotencyKey,
          actorId,
        ],
      );
      return { record: mapMessage(result.rows[0]!), replayed: false };
    } catch (error) {
      if (classifyCreatorWriteConflict(error) === 'unique-fence') {
        // The §8-style logical message command key: a duplicate of the
        // same logical command converges.
        const existing = await this.findCreatorMessageByIdempotency(
          input.conversationId,
          input.idempotencyKey,
        );
        if (existing !== null) {
          return { record: existing, replayed: true };
        }
      }
      throw error;
    }
  }

  async findCreatorMessageByIdempotency(
    conversationId: string,
    idempotencyKey: string,
  ): Promise<CreatorMessageRecord | null> {
    const result = await this.db.query(
      `SELECT * FROM creator_conversation_messages
         WHERE conversation_id = $1 AND idempotency_key = $2 LIMIT 1`,
      [conversationId, idempotencyKey],
    );
    return result.rows.length > 0 ? mapMessage(result.rows[0]!) : null;
  }

  async listCreatorMessages(conversationId: string): Promise<readonly CreatorMessageRecord[]> {
    const result = await this.db.query(
      `SELECT * FROM creator_conversation_messages WHERE conversation_id = $1
         ORDER BY created_at, message_id LIMIT ${LIST_LIMIT}`,
      [conversationId],
    );
    return result.rows.map(mapMessage);
  }

  // ----- Content assets ------------------------------------------------------

  async insertCreatorContentAsset(
    input: {
      readonly clientId: string;
      readonly agencyId: string;
      readonly profileId: string;
      readonly title: string;
      readonly contentKind: string;
      readonly plannedPlatforms: readonly string[];
      readonly brief: string;
      readonly attributes: Readonly<Record<string, unknown>>;
    },
    actorId: string | null,
  ): Promise<CreatorInsertOutcome<CreatorContentAssetRecord>> {
    const assetId = this.ids.newId();
    const result = await this.db.query(
      `INSERT INTO creator_content_assets
         (asset_id, agency_id, client_id, profile_id, title, content_kind, planned_platforms, brief, attributes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10)
       RETURNING *`,
      [
        assetId,
        input.agencyId,
        input.clientId,
        input.profileId,
        input.title,
        input.contentKind,
        JSON.stringify(input.plannedPlatforms),
        input.brief,
        JSON.stringify(input.attributes),
        actorId,
      ],
    );
    return { record: mapContentAsset(result.rows[0]!), replayed: false };
  }

  async getCreatorContentAsset(assetId: string): Promise<CreatorContentAssetRecord | null> {
    const result = await this.db.query(
      `SELECT * FROM creator_content_assets WHERE asset_id = $1 LIMIT 1`,
      [assetId],
    );
    return result.rows.length > 0 ? mapContentAsset(result.rows[0]!) : null;
  }

  async listCreatorContentAssetsForProfile(
    profileId: string,
  ): Promise<readonly CreatorContentAssetRecord[]> {
    const result = await this.db.query(
      `SELECT * FROM creator_content_assets WHERE profile_id = $1
         ORDER BY created_at DESC, asset_id LIMIT ${LIST_LIMIT}`,
      [profileId],
    );
    return result.rows.map(mapContentAsset);
  }

  /**
   * The content lifecycle CAS transition. The PUBLISHED edge carries the
   * gate provenance (the allowing policy decision id, the satisfying
   * approval record id, the published-at stamp); the REJECTED edge
   * carries the rejected-at stamp; every edge bumps the CAS version. The
   * migration-031 lifecycle trigger is the backstop of the frozen
   * transition table.
   */
  async transitionCreatorContentAsset(
    input: {
      readonly assetId: string;
      readonly status: CreatorContentStatus;
      readonly expectedVersion: number;
      readonly policyDecisionId: string | null;
      readonly approvalId: string | null;
    },
  ): Promise<CreatorContentAssetRecord | 'not-found' | 'version-conflict'> {
    return this.db.transaction(async (tx) => {
      const publishedAt: string | null = input.status === 'published' ? this.clock.nowIso() : null;
      const rejectedAt: string | null = input.status === 'rejected' ? this.clock.nowIso() : null;
      const policyDecisionId: string | null =
        input.status === 'published' ? input.policyDecisionId : null;
      const approvalId: string | null = input.status === 'published' ? input.approvalId : null;
      const result = await tx.query(
        `UPDATE creator_content_assets
           SET status = $1, published_at = $2, rejected_at = $3,
               policy_decision_id = $4, approval_id = $5,
               version = version + 1, updated_at = now()
         WHERE asset_id = $6 AND version = $7
         RETURNING *`,
        [input.status, publishedAt, rejectedAt, policyDecisionId, approvalId, input.assetId, input.expectedVersion],
      );
      if (result.rows.length === 0) {
        return await this.distinguishCasOutcome(tx, 'creator_content_assets', 'asset_id', input.assetId);
      }
      return mapContentAsset(result.rows[0]!);
    });
  }

  // ----- Offers ---------------------------------------------------------------

  async insertCreatorOffer(
    input: {
      readonly clientId: string;
      readonly agencyId: string;
      readonly profileId: string;
      readonly title: string;
      readonly offerKind: string;
      readonly priceCents: number;
      readonly currency: string;
      readonly terms: string;
      readonly attributes: Readonly<Record<string, unknown>>;
    },
    actorId: string | null,
  ): Promise<CreatorInsertOutcome<CreatorOfferRecord>> {
    const offerId = this.ids.newId();
    try {
      const result = await this.db.query(
        `INSERT INTO creator_offers
           (offer_id, agency_id, client_id, profile_id, title, offer_kind, price_cents, currency, terms, attributes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
         RETURNING *`,
        [
          offerId,
          input.agencyId,
          input.clientId,
          input.profileId,
          input.title,
          input.offerKind,
          input.priceCents,
          input.currency,
          input.terms,
          JSON.stringify(input.attributes),
          actorId,
        ],
      );
      return { record: mapOffer(result.rows[0]!), replayed: false };
    } catch (error) {
      if (classifyCreatorWriteConflict(error) === 'unique-fence') {
        throw new ConflictError(
          `offer title '${input.title}' already exists for this creator profile (content is immutable: a new offer version is a new record)`,
        );
      }
      throw error;
    }
  }

  async getCreatorOffer(offerId: string): Promise<CreatorOfferRecord | null> {
    const result = await this.db.query(
      `SELECT * FROM creator_offers WHERE offer_id = $1 LIMIT 1`,
      [offerId],
    );
    return result.rows.length > 0 ? mapOffer(result.rows[0]!) : null;
  }

  async listCreatorOffersForProfile(profileId: string): Promise<readonly CreatorOfferRecord[]> {
    const result = await this.db.query(
      `SELECT * FROM creator_offers WHERE profile_id = $1
         ORDER BY created_at DESC, offer_id LIMIT ${LIST_LIMIT}`,
      [profileId],
    );
    return result.rows.map(mapOffer);
  }

  async setCreatorOfferStatus(
    input: {
      readonly offerId: string;
      readonly status: CreatorOfferStatus;
      readonly expectedVersion: number;
    },
    actorId: string | null,
  ): Promise<CreatorOfferRecord | 'not-found' | 'version-conflict'> {
    void actorId;
    return this.db.transaction(async (tx) => {
      const updated = await this.casStatusTransition(tx, {
        table: 'creator_offers',
        key: 'offer_id',
        stampColumn: 'retired_at',
        id: input.offerId,
        status: input.status,
        expectedVersion: input.expectedVersion,
      });
      if (typeof updated === 'string') return updated;
      return mapOffer(updated);
    });
  }

  // ----- Approvals --------------------------------------------------------------

  async insertCreatorApproval(
    input: {
      readonly clientId: string;
      readonly agencyId: string;
      readonly action: string;
      readonly resourceId: string;
      readonly decision: string;
      readonly approverUserId: string;
      readonly approverSpecializations: readonly string[];
      readonly notes: string;
      readonly idempotencyKey: string;
    },
    _actorId: string | null,
  ): Promise<CreatorInsertOutcome<CreatorOperationApprovalRecord>> {
    const approvalId = this.ids.newId();
    try {
      const result = await this.db.query(
        `INSERT INTO creator_operation_approvals
           (approval_id, agency_id, client_id, action, resource_id, decision,
            approver_user_id, approver_specializations, notes, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
         RETURNING *`,
        [
          approvalId,
          input.agencyId,
          input.clientId,
          input.action,
          input.resourceId,
          input.decision,
          input.approverUserId,
          JSON.stringify(input.approverSpecializations),
          input.notes,
          input.idempotencyKey,
        ],
      );
      return { record: mapApproval(result.rows[0]!), replayed: false };
    } catch (error) {
      if (classifyCreatorWriteConflict(error) === 'unique-fence') {
        // The §8-style logical approval command key: a duplicate of the
        // same logical approval command converges.
        const existing = await this.findCreatorApprovalByIdempotency(
          input.clientId,
          input.idempotencyKey,
        );
        if (existing !== null) {
          return { record: existing, replayed: true };
        }
      }
      throw error;
    }
  }

  async findCreatorApprovalByIdempotency(
    clientId: string,
    idempotencyKey: string,
  ): Promise<CreatorOperationApprovalRecord | null> {
    const result = await this.db.query(
      `SELECT * FROM creator_operation_approvals
         WHERE client_id = $1 AND idempotency_key = $2 LIMIT 1`,
      [clientId, idempotencyKey],
    );
    return result.rows.length > 0 ? mapApproval(result.rows[0]!) : null;
  }

  async getCreatorApproval(approvalId: string): Promise<CreatorOperationApprovalRecord | null> {
    const result = await this.db.query(
      `SELECT * FROM creator_operation_approvals WHERE approval_id = $1 LIMIT 1`,
      [approvalId],
    );
    return result.rows.length > 0 ? mapApproval(result.rows[0]!) : null;
  }

  async listCreatorApprovalsForResource(
    action: string,
    resourceId: string,
  ): Promise<readonly CreatorOperationApprovalRecord[]> {
    const result = await this.db.query(
      `SELECT * FROM creator_operation_approvals
         WHERE action = $1 AND resource_id = $2
         ORDER BY created_at DESC, approval_id LIMIT ${LIST_LIMIT}`,
      [action, resourceId],
    );
    return result.rows.map(mapApproval);
  }

  // ----- Shared CAS machinery -----------------------------------------------

  /**
   * One CAS status transition on a lifecycle table: bumps the version,
   * stamps updated_at, sets the terminal-at column (the stamp for a
   * terminal target, NULL for a live row — the frozen lifecycle
   * triggers require exactly that shape) and lets the migration-031
   * lifecycle trigger backstop the frozen transition table.
   * 'not-found' vs 'version-conflict' is distinguished by a follow-up
   * read. Table/key/column identifiers are INTERNAL CONSTANTS (never
   * user input).
   */
  private async casStatusTransition(
    tx: DbTransaction,
    spec: {
      readonly table: string;
      readonly key: string;
      readonly stampColumn: string;
      readonly id: string;
      readonly status: string;
      readonly expectedVersion: number;
    },
  ): Promise<DbRow | 'not-found' | 'version-conflict'> {
    const stamp = this.terminalTargets.has(spec.status) ? this.clock.nowIso() : null;
    const result = await tx.query(
      `UPDATE ${spec.table}
         SET status = $1,
             ${spec.stampColumn} = $2,
             version = version + 1,
             updated_at = now()
       WHERE ${spec.key} = $3 AND version = $4
       RETURNING *`,
      [spec.status, stamp, spec.id, spec.expectedVersion],
    );
    if (result.rows.length === 0) {
      return this.distinguishCasOutcome(tx, spec.table, spec.key, spec.id);
    }
    return result.rows[0]!;
  }

  /** Re-reads the row to distinguish 'not-found' from a CAS 'version-conflict'. */
  private async distinguishCasOutcome(
    tx: DbTransaction,
    table: string,
    key: string,
    id: string,
  ): Promise<'not-found' | 'version-conflict'> {
    const existing = await tx.query(`SELECT version FROM ${table} WHERE ${key} = $1 LIMIT 1`, [id]);
    return existing.rows.length === 0 ? 'not-found' : 'version-conflict';
  }
}