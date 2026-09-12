-- MKT-037 Creator Operations Domain Pack schema (CREATOR-001).
-- PostgreSQL is the system of record (spec/architecture-lock.md).
--
-- Table ownership follows the frozen authority map (implementation-contract
-- §1 + spec/module-dependency-v1.3.md: "Creator Operations is pack-owned and
-- must not become a peer authority to core modules"): ALL tables here are
-- PACK-OWNED, Client-scoped records of the Creator Operations Domain Pack
-- (spec/creator-operations-v1.3.md §2 "These are pack-owned records. The
-- Client remains the hard security boundary"):
--   creator_profiles              → Creator Profile (§2 subject)
--   creator_accounts              → Creator Account (§2 subject)
--   creator_fans                  → Audience Member / Fan (§2 subject)
--   creator_conversations         → Conversation (§2 subject)
--   creator_conversation_messages → Conversation message records
--   creator_content_assets        → Content Asset (§2 subject)
--   creator_offers                → Offer (§2 subject)
--   creator_operation_approvals   → pack-owned human-approval records for
--                                   sensitive actions (§5 "Sensitive or
--                                   high-risk operations must use Policy and
--                                   human approval gates")
--
-- Engagement Events, Monetization Events and Creator Performance Metrics
-- (§2) are OBSERVATIONS: they enter the COMMON /evidence and /metrics
-- contracts through the pack's mapping adapters (CREATOR-AC-02 — "the pack
-- owns mapping, not a parallel store"). There is deliberately NO
-- creator_evidence / creator_metric table here: /evidence (migration 015)
-- and /metrics (migration 018) stay the only observation authorities.
--
-- Frozen semantics encoded here (spec/creator-operations-v1.3.md — FROZEN;
-- spec/domain-pack-v1.3.md §3 "A Domain Pack MUST NOT introduce an alternate
-- workflow engine, Job engine, evidence authority, tenant authority, or
-- credential store"; spec/requirements-v1.3.md CREATOR-AC-01 "without
-- creating a new tenant authority"; spec/implementation-contract.md §3
-- "No externally supplied field may override a server-derived actor, owner,
-- provenance, policy decision, or evidence authority value"; §21 "secrets
-- may never appear ... in durable" pack payloads; §25 database backstops):
--
-- * THE CLIENT BOUNDARY IS THE EXISTING AUTHORITY (CREATOR-AC-01): every
--   pack-owned record carries agency_id + client_id FOREIGN-KEYed to the
--   EXISTING agencies/clients tables (created by migrations 002/003 — this
--   migration creates NO tenant table of its own) and the scope-chain
--   trigger re-fences client ∈ agency on every row. All record shapes
--   resolve through the existing Client boundary.
-- * THE CHAIN FENCES: a Creator Account belongs to a Creator Profile of
--   the SAME Client; a Fan belongs to a Creator Account of the SAME
--   Client; a Conversation belongs to a Fan and a Creator Account of the
--   SAME Client; a message belongs to its Conversation's Client; a
--   Content Asset and an Offer belong to a Creator Profile of the SAME
--   Client; an approval belongs to its own Client. Crossed rows are
--   impossible even by direct SQL.
-- * PACK-OWNED IDENTITY/CONTENT IS APPEND-ONLY (the migration 015/018/030
--   pattern): identity, scope, provenance and content columns are
--   immutable after insert (corrections append a NEW record); lifecycle
--   columns (where a frozen lifecycle exists) are the only mutable
--   surface, always guarded by the frozen transition table + CAS version.
-- * THE FROZEN LIFECYCLES: account active ⇄ paused with terminal retire;
--   fan subscribed ⇄ churned with terminal remove; conversation
--   open ⇄ paused with terminal close; content draft → in_review →
--   approved → published with terminal reject side-exits; offer
--   draft → active ⇄ paused with terminal retire.
-- * THE APPROVAL-GATED SIDE EFFECTS (CREATOR-AC-06): an outbound
--   conversation message is born 'sent' ONLY through the fail-closed
--   policy + approval gate — the row carries the allowing policy decision
--   id (NOT NULL) and, when the configured policy demanded one, the
--   satisfying approval record id; an unapproved send never writes a row.
--   A published content asset likewise carries its allowing decision id.
--   Inbound messages are born 'received' (an observation, never a side
--   effect) and never carry approval provenance.
-- * CRED-001 / §21 POSTURE: every jsonb payload column is CHECKed against
--   material-shaped keys — there is deliberately NO column capable of
--   holding secret material or a secret handle anywhere in this
--   migration.
-- * NO ALTERNATE AUTHORITY (domain-pack-v1.3.md §3): this migration
--   creates NO agencies/clients/workspaces table (no second tenant
--   authority), NO workflow/workflow-instance table, NO execution table,
--   NO evidence/metric table, NO credential column, NO AI-routing table
--   and NO Job table — /workflows, /executions, /evidence, /metrics,
--   /ai-runtime, /credentials and /jobs stay the only authorities for
--   those concerns (CREATOR-AC-01/AC-02 at the storage layer).
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, created_at, provenance (created_by user uuid), version CAS
-- only where a mutable lifecycle exists. No owner/role/user columns beyond
-- provenance: authorization stays exactly the /agencies membership
-- authority composed with canonical /clients owner resolution — no second
-- tenant, permission, workflow, execution, evidence, credential or audit
-- authority. No provider SDK coupling, no provider-specific columns
-- (platform labels are DATA — CREATOR-AC-05), no pack execution engine,
-- no UI.

-- ---------------------------------------------------------------------------
-- Shape validators (IMMUTABLE so they can serve CHECK constraints)
-- ---------------------------------------------------------------------------

-- The material-shape validator (the migration 025/028/030 pattern): rejects
-- material-shaped keys at every nesting level of a pack-owned payload — the
-- storage-side half of the §21 contract.
CREATE OR REPLACE FUNCTION creator_operations_payload_has_no_material_keys(payload jsonb)
RETURNS boolean AS $$
DECLARE
    key text;
    elem jsonb;
BEGIN
    IF payload IS NULL THEN
        RETURN true;
    END IF;
    IF jsonb_typeof(payload) = 'object' THEN
        FOR key IN SELECT * FROM jsonb_object_keys(payload) LOOP
            IF key IN ('secret', 'secretMaterial', 'material', 'password', 'token',
                       'apiKey', 'api_key', 'accessKey', 'secretHandle') THEN
                RETURN false;
            END IF;
        END LOOP;
        FOR elem IN SELECT e.value FROM jsonb_each(payload) e LOOP
            IF NOT creator_operations_payload_has_no_material_keys(elem) THEN
                RETURN false;
            END IF;
        END LOOP;
    ELSIF jsonb_typeof(payload) = 'array' THEN
        FOR elem IN SELECT a.value FROM jsonb_array_elements(payload) a LOOP
            IF NOT creator_operations_payload_has_no_material_keys(elem) THEN
                RETURN false;
            END IF;
        END LOOP;
    END IF;
    RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ---------------------------------------------------------------------------
-- creator_profiles — the Creator Profile subject (§2)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS creator_profiles (
    profile_id      uuid        PRIMARY KEY,
    -- The EXISTING tenant authority (CREATOR-AC-01): agency/client FKs to
    -- the migration 002/003 tables, scope-chain trigger below.
    agency_id       uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id       uuid        NOT NULL REFERENCES clients(client_id),
    display_name    text        NOT NULL
                    CHECK (length(display_name) >= 1 AND length(display_name) <= 200),
    handle          text        NOT NULL
                    CHECK (handle ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
    -- Provider-neutral creator niches/verticals (data tags, never provider
    -- coupling — CREATOR-AC-05).
    niches          jsonb       NOT NULL DEFAULT '[]'::jsonb
                    CHECK (creator_operations_payload_has_no_material_keys(niches)),
    bio             text        NOT NULL DEFAULT ''
                    CHECK (length(bio) <= 2000),
    attributes      jsonb       NOT NULL DEFAULT '{}'::jsonb
                    CHECK (creator_operations_payload_has_no_material_keys(attributes)),
    created_by      uuid        REFERENCES users(user_id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- One profile handle per client (bounded duplicate fence).
    CONSTRAINT creator_profiles_client_handle_unique UNIQUE (client_id, handle)
);

CREATE INDEX IF NOT EXISTS creator_profiles_client_idx
    ON creator_profiles (client_id, created_at DESC, profile_id);

-- The Client-scope fence: the client must belong to the agency — enforced
-- on INSERT (the append-only trigger below rejects every UPDATE/DELETE).
CREATE OR REPLACE FUNCTION creator_profiles_scope_legal() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM clients c
        WHERE c.client_id = NEW.client_id AND c.agency_id = NEW.agency_id) THEN
        RAISE EXCEPTION 'creator profile % client % does not belong to agency % — pack-owned records cannot cross the Client boundary',
            NEW.profile_id, NEW.client_id, NEW.agency_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS creator_profiles_scope_legal_trigger ON creator_profiles;
CREATE TRIGGER creator_profiles_scope_legal_trigger
BEFORE INSERT ON creator_profiles
FOR EACH ROW EXECUTE FUNCTION creator_profiles_scope_legal();

-- APPEND-ONLY (the migration 015/018/030 pattern): the database itself
-- rejects UPDATE and DELETE on pack-owned profile records. Cross-client
-- re-parenting is therefore IMPOSSIBLE at the storage layer.
CREATE OR REPLACE FUNCTION creator_profiles_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'creator profiles are append-only: % is rejected on profile %',
        TG_OP, OLD.profile_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS creator_profiles_append_only_update_trigger ON creator_profiles;
CREATE TRIGGER creator_profiles_append_only_update_trigger
BEFORE UPDATE ON creator_profiles
FOR EACH ROW EXECUTE FUNCTION creator_profiles_append_only();

DROP TRIGGER IF EXISTS creator_profiles_append_only_delete_trigger ON creator_profiles;
CREATE TRIGGER creator_profiles_append_only_delete_trigger
BEFORE DELETE ON creator_profiles
FOR EACH ROW EXECUTE FUNCTION creator_profiles_append_only();

-- ---------------------------------------------------------------------------
-- creator_operation_approvals — the pack-owned human-approval records
-- (CREATOR-AC-06: "creator conversations or sensitive actions can require
-- configurable human approval before side effects"). Created BEFORE the
-- message/content tables because their side-effect provenance FKs target
-- this table.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS creator_operation_approvals (
    approval_id     uuid        PRIMARY KEY,
    agency_id       uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id       uuid        NOT NULL REFERENCES clients(client_id),
    -- The pack's sensitive-action operation label the approval covers
    -- (closed two-value set today: the conversation send and the content
    -- publish side effects — the gate vocabulary, never caller freedom).
    action          text        NOT NULL
                    CHECK (action IN ('creator.conversation.send', 'creator.content.publish')),
    -- The pack-owned record the approval targets (conversation or content
    -- asset id — validated against the target table by the module; the
    -- shape is bounded here).
    resource_id     uuid        NOT NULL,
    -- The frozen approval decision: 'approved' satisfies the configured
    -- approval requirement; 'rejected' is an explicit NO (both append-only:
    -- a re-decision appends a NEW record).
    decision        text        NOT NULL
                    CHECK (decision IN ('approved', 'rejected')),
    -- HUMAN ACTOR PROVENANCE (CREATOR-AC-04/AC-06): the approving platform
    -- user + the Human Agent specializations the approver carried at
    -- decision time (server-derived from the /field-agents profile by the
    -- route layer — never caller-supplied).
    approver_user_id uuid       NOT NULL REFERENCES users(user_id),
    approver_specializations jsonb NOT NULL DEFAULT '[]'::jsonb
                    CHECK (jsonb_typeof(approver_specializations) = 'array'
                           AND creator_operations_payload_has_no_material_keys(approver_specializations)),
    -- Optional governance notes (bounded, §21-fenced).
    notes           text        NOT NULL DEFAULT ''
                    CHECK (length(notes) <= 2000),
    idempotency_key text        NOT NULL
                    CHECK (length(idempotency_key) >= 1 AND length(idempotency_key) <= 200),
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- The §8-style logical approval command key: a duplicate of the same
    -- logical approval command converges.
    CONSTRAINT creator_operation_approvals_client_idempotency_unique
        UNIQUE (client_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS creator_operation_approvals_client_idx
    ON creator_operation_approvals (client_id, created_at DESC, approval_id);
CREATE INDEX IF NOT EXISTS creator_operation_approvals_resource_idx
    ON creator_operation_approvals (action, resource_id, created_at DESC);

CREATE OR REPLACE FUNCTION creator_operation_approvals_scope_legal() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM clients c
        WHERE c.client_id = NEW.client_id AND c.agency_id = NEW.agency_id) THEN
        RAISE EXCEPTION 'creator approval % client % does not belong to agency % — pack-owned records cannot cross the Client boundary',
            NEW.approval_id, NEW.client_id, NEW.agency_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS creator_operation_approvals_scope_legal_trigger ON creator_operation_approvals;
CREATE TRIGGER creator_operation_approvals_scope_legal_trigger
BEFORE INSERT ON creator_operation_approvals
FOR EACH ROW EXECUTE FUNCTION creator_operation_approvals_scope_legal();

-- APPEND-ONLY: approval history is immutable (a re-decision appends a NEW
-- record — the append-oriented governance pattern).
CREATE OR REPLACE FUNCTION creator_operation_approvals_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'creator approvals are append-only: % is rejected on approval %',
        TG_OP, OLD.approval_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS creator_operation_approvals_append_only_update_trigger ON creator_operation_approvals;
CREATE TRIGGER creator_operation_approvals_append_only_update_trigger
BEFORE UPDATE ON creator_operation_approvals
FOR EACH ROW EXECUTE FUNCTION creator_operation_approvals_append_only();

DROP TRIGGER IF EXISTS creator_operation_approvals_append_only_delete_trigger ON creator_operation_approvals;
CREATE TRIGGER creator_operation_approvals_append_only_delete_trigger
BEFORE DELETE ON creator_operation_approvals
FOR EACH ROW EXECUTE FUNCTION creator_operation_approvals_append_only();

-- ---------------------------------------------------------------------------
-- creator_accounts — the Creator Account subject (§2)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS creator_accounts (
    account_id      uuid        PRIMARY KEY,
    agency_id       uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id       uuid        NOT NULL REFERENCES clients(client_id),
    profile_id      uuid        NOT NULL REFERENCES creator_profiles(profile_id),
    -- Provider-neutral creator-platform LABEL (data, not coupling — the
    -- provider-specific adapter lives behind /integrations — CREATOR-AC-05).
    platform_label  text        NOT NULL
                    CHECK (length(platform_label) >= 1 AND length(platform_label) <= 64),
    account_handle  text        NOT NULL
                    CHECK (length(account_handle) >= 1 AND length(account_handle) <= 128),
    -- The frozen account lifecycle: active ⇄ paused, active|paused →
    -- retired (terminal). Born active.
    status          text        NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'paused', 'retired')),
    metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb
                    CHECK (creator_operations_payload_has_no_material_keys(metadata)),
    version         bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_by      uuid        REFERENCES users(user_id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    retired_at      timestamptz,
    CONSTRAINT creator_accounts_profile_platform_handle_unique
        UNIQUE (profile_id, platform_label, account_handle)
);

CREATE INDEX IF NOT EXISTS creator_accounts_profile_idx
    ON creator_accounts (profile_id, created_at DESC, account_id);
CREATE INDEX IF NOT EXISTS creator_accounts_client_idx
    ON creator_accounts (client_id, status);

-- Scope + chain fence: client ∈ agency AND the profile belongs to the same
-- client (a pack-owned record can never be recorded against crossed rows).
CREATE OR REPLACE FUNCTION creator_accounts_scope_legal() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM clients c
        WHERE c.client_id = NEW.client_id AND c.agency_id = NEW.agency_id) THEN
        RAISE EXCEPTION 'creator account % client % does not belong to agency % — pack-owned records cannot cross the Client boundary',
            NEW.account_id, NEW.client_id, NEW.agency_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM creator_profiles p
        WHERE p.profile_id = NEW.profile_id AND p.client_id = NEW.client_id) THEN
        RAISE EXCEPTION 'creator account % must belong to a creator profile of the same client %',
            NEW.account_id, NEW.client_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS creator_accounts_scope_legal_trigger ON creator_accounts;
CREATE TRIGGER creator_accounts_scope_legal_trigger
BEFORE INSERT OR UPDATE OF agency_id, client_id, profile_id ON creator_accounts
FOR EACH ROW EXECUTE FUNCTION creator_accounts_scope_legal();

-- Identity/scope/content immutability: only the lifecycle, CAS token and
-- timestamps ever move.
CREATE OR REPLACE FUNCTION creator_accounts_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW.account_id <> OLD.account_id THEN
        RAISE EXCEPTION 'account_id % is immutable', OLD.account_id;
    END IF;
    IF NEW.agency_id <> OLD.agency_id OR NEW.client_id <> OLD.client_id
       OR NEW.profile_id <> OLD.profile_id THEN
        RAISE EXCEPTION 'creator account % ownership scope is immutable (was %/%/%)',
            OLD.account_id, OLD.agency_id, OLD.client_id, OLD.profile_id;
    END IF;
    IF NEW.platform_label <> OLD.platform_label OR NEW.account_handle <> OLD.account_handle THEN
        RAISE EXCEPTION 'creator account % identity is immutable (corrections append a NEW record)',
            OLD.account_id;
    END IF;
    IF NEW.metadata <> OLD.metadata THEN
        RAISE EXCEPTION 'creator account % metadata is immutable (corrections append a NEW record)',
            OLD.account_id;
    END IF;
    IF NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'creator account % provenance is immutable', OLD.account_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS creator_accounts_immutable_trigger ON creator_accounts;
CREATE TRIGGER creator_accounts_immutable_trigger
BEFORE UPDATE ON creator_accounts
FOR EACH ROW EXECUTE FUNCTION creator_accounts_immutable();

-- The frozen lifecycle: born active; active ⇄ paused; active|paused →
-- retired (terminal, carries retired_at); every other status carries NULL.
CREATE OR REPLACE FUNCTION creator_accounts_lifecycle_legal() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'active' THEN
            RAISE EXCEPTION 'a creator account is born active (got %)', NEW.status;
        END IF;
        IF NEW.retired_at IS NOT NULL THEN
            RAISE EXCEPTION 'a fresh creator account must not carry retired_at';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD.status = 'retired' THEN
        RAISE EXCEPTION 'creator account % is retired and terminal', OLD.account_id;
    END IF;
    IF NOT (
        (OLD.status = 'active' AND NEW.status IN ('paused', 'retired')) OR
        (OLD.status = 'paused' AND NEW.status IN ('active', 'retired'))
    ) THEN
        RAISE EXCEPTION 'illegal creator account transition % → % (the frozen lifecycle is active ⇄ paused with the terminal retire edge)',
            OLD.status, NEW.status;
    END IF;
    IF NEW.status = 'retired' THEN
        IF NEW.retired_at IS NULL THEN
            RAISE EXCEPTION 'creator account % retired rows must carry retired_at', NEW.account_id;
        END IF;
    ELSE
        IF NEW.retired_at IS NOT NULL THEN
            RAISE EXCEPTION 'creator account % active rows must not carry retired_at', NEW.account_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS creator_accounts_lifecycle_legal_trigger ON creator_accounts;
CREATE TRIGGER creator_accounts_lifecycle_legal_trigger
BEFORE INSERT OR UPDATE OF status ON creator_accounts
FOR EACH ROW EXECUTE FUNCTION creator_accounts_lifecycle_legal();

-- ---------------------------------------------------------------------------
-- creator_fans — the Audience Member / Fan subject (§2)
--
-- Raw fan data stays Client-scoped (creator-operations-v1.3.md §8): the fan
-- record carries only bounded declared profile data (alias + declared
-- tier/tags) — no raw message content, no provider payload blobs.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS creator_fans (
    fan_id          uuid        PRIMARY KEY,
    agency_id       uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id       uuid        NOT NULL REFERENCES clients(client_id),
    account_id      uuid        NOT NULL REFERENCES creator_accounts(account_id),
    -- Bounded audience alias (provider-neutral; no raw PII blobs — §8).
    fan_alias       text        NOT NULL
                    CHECK (length(fan_alias) >= 1 AND length(fan_alias) <= 128),
    -- The frozen fan lifecycle: subscribed ⇄ churned; subscribed|churned →
    -- removed (terminal).
    status          text        NOT NULL DEFAULT 'subscribed'
                    CHECK (status IN ('subscribed', 'churned', 'removed')),
    -- Declared audience tier (closed set — segmentation input, data).
    tier            text        NOT NULL DEFAULT 'standard'
                    CHECK (tier IN ('standard', 'vip', 'top_fan', 'new_fan')),
    tags            jsonb       NOT NULL DEFAULT '[]'::jsonb
                    CHECK (creator_operations_payload_has_no_material_keys(tags)),
    attributes      jsonb       NOT NULL DEFAULT '{}'::jsonb
                    CHECK (creator_operations_payload_has_no_material_keys(attributes)),
    version         bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_by      uuid        REFERENCES users(user_id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    removed_at      timestamptz,
    CONSTRAINT creator_fans_account_alias_unique UNIQUE (account_id, fan_alias)
);

CREATE INDEX IF NOT EXISTS creator_fans_account_idx
    ON creator_fans (account_id, created_at DESC, fan_id);
CREATE INDEX IF NOT EXISTS creator_fans_client_idx
    ON creator_fans (client_id, status);

CREATE OR REPLACE FUNCTION creator_fans_scope_legal() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM clients c
        WHERE c.client_id = NEW.client_id AND c.agency_id = NEW.agency_id) THEN
        RAISE EXCEPTION 'creator fan % client % does not belong to agency % — pack-owned records cannot cross the Client boundary',
            NEW.fan_id, NEW.client_id, NEW.agency_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM creator_accounts a
        WHERE a.account_id = NEW.account_id AND a.client_id = NEW.client_id) THEN
        RAISE EXCEPTION 'creator fan % must belong to a creator account of the same client %',
            NEW.fan_id, NEW.client_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS creator_fans_scope_legal_trigger ON creator_fans;
CREATE TRIGGER creator_fans_scope_legal_trigger
BEFORE INSERT OR UPDATE OF agency_id, client_id, account_id ON creator_fans
FOR EACH ROW EXECUTE FUNCTION creator_fans_scope_legal();

CREATE OR REPLACE FUNCTION creator_fans_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW.fan_id <> OLD.fan_id THEN
        RAISE EXCEPTION 'fan_id % is immutable', OLD.fan_id;
    END IF;
    IF NEW.agency_id <> OLD.agency_id OR NEW.client_id <> OLD.client_id
       OR NEW.account_id <> OLD.account_id THEN
        RAISE EXCEPTION 'creator fan % ownership scope is immutable (was %/%/%)',
            OLD.fan_id, OLD.agency_id, OLD.client_id, OLD.account_id;
    END IF;
    IF NEW.fan_alias <> OLD.fan_alias THEN
        RAISE EXCEPTION 'creator fan % identity is immutable (corrections append a NEW record)',
            OLD.fan_id;
    END IF;
    IF NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'creator fan % provenance is immutable', OLD.fan_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS creator_fans_immutable_trigger ON creator_fans;
CREATE TRIGGER creator_fans_immutable_trigger
BEFORE UPDATE ON creator_fans
FOR EACH ROW EXECUTE FUNCTION creator_fans_immutable();

CREATE OR REPLACE FUNCTION creator_fans_lifecycle_legal() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'subscribed' THEN
            RAISE EXCEPTION 'a creator fan is born subscribed (got %)', NEW.status;
        END IF;
        IF NEW.removed_at IS NOT NULL THEN
            RAISE EXCEPTION 'a fresh creator fan must not carry removed_at';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD.status = 'removed' THEN
        RAISE EXCEPTION 'creator fan % is removed and terminal', OLD.fan_id;
    END IF;
    IF NOT (
        (OLD.status = 'subscribed' AND NEW.status IN ('churned', 'removed')) OR
        (OLD.status = 'churned' AND NEW.status IN ('subscribed', 'removed'))
    ) THEN
        RAISE EXCEPTION 'illegal creator fan transition % → % (the frozen lifecycle is subscribed ⇄ churned with the terminal remove edge)',
            OLD.status, NEW.status;
    END IF;
    IF NEW.status = 'removed' THEN
        IF NEW.removed_at IS NULL THEN
            RAISE EXCEPTION 'creator fan % removed rows must carry removed_at', NEW.fan_id;
        END IF;
    ELSE
        IF NEW.removed_at IS NOT NULL THEN
            RAISE EXCEPTION 'creator fan % live rows must not carry removed_at', NEW.fan_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS creator_fans_lifecycle_legal_trigger ON creator_fans;
CREATE TRIGGER creator_fans_lifecycle_legal_trigger
BEFORE INSERT OR UPDATE OF status ON creator_fans
FOR EACH ROW EXECUTE FUNCTION creator_fans_lifecycle_legal();

-- ---------------------------------------------------------------------------
-- creator_conversations — the Conversation subject (§2)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS creator_conversations (
    conversation_id uuid        PRIMARY KEY,
    agency_id       uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id       uuid        NOT NULL REFERENCES clients(client_id),
    account_id      uuid        NOT NULL REFERENCES creator_accounts(account_id),
    fan_id          uuid        NOT NULL REFERENCES creator_fans(fan_id),
    -- The frozen conversation lifecycle: open ⇄ paused; open|paused →
    -- closed (terminal).
    status          text        NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'paused', 'closed')),
    -- Provider-neutral conversation channel (closed set — data,
    -- CREATOR-AC-05).
    channel         text        NOT NULL DEFAULT 'dm'
                    CHECK (channel IN ('dm', 'post_comment', 'live_chat', 'email')),
    topic           text        NOT NULL DEFAULT ''
                    CHECK (length(topic) <= 200),
    attributes      jsonb       NOT NULL DEFAULT '{}'::jsonb
                    CHECK (creator_operations_payload_has_no_material_keys(attributes)),
    version         bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_by      uuid        REFERENCES users(user_id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    closed_at       timestamptz,
    CONSTRAINT creator_conversations_account_fan_channel_unique
        UNIQUE (account_id, fan_id, channel)
);

CREATE INDEX IF NOT EXISTS creator_conversations_account_idx
    ON creator_conversations (account_id, created_at DESC, conversation_id);
CREATE INDEX IF NOT EXISTS creator_conversations_client_idx
    ON creator_conversations (client_id, status);

CREATE OR REPLACE FUNCTION creator_conversations_scope_legal() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM clients c
        WHERE c.client_id = NEW.client_id AND c.agency_id = NEW.agency_id) THEN
        RAISE EXCEPTION 'creator conversation % client % does not belong to agency % — pack-owned records cannot cross the Client boundary',
            NEW.conversation_id, NEW.client_id, NEW.agency_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM creator_accounts a
        WHERE a.account_id = NEW.account_id AND a.client_id = NEW.client_id) THEN
        RAISE EXCEPTION 'creator conversation % must belong to a creator account of the same client %',
            NEW.conversation_id, NEW.client_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM creator_fans f
        WHERE f.fan_id = NEW.fan_id AND f.account_id = NEW.account_id) THEN
        RAISE EXCEPTION 'creator conversation % must belong to a fan of the same creator account %',
            NEW.conversation_id, NEW.account_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS creator_conversations_scope_legal_trigger ON creator_conversations;
CREATE TRIGGER creator_conversations_scope_legal_trigger
BEFORE INSERT OR UPDATE OF agency_id, client_id, account_id, fan_id ON creator_conversations
FOR EACH ROW EXECUTE FUNCTION creator_conversations_scope_legal();

CREATE OR REPLACE FUNCTION creator_conversations_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW.conversation_id <> OLD.conversation_id THEN
        RAISE EXCEPTION 'conversation_id % is immutable', OLD.conversation_id;
    END IF;
    IF NEW.agency_id <> OLD.agency_id OR NEW.client_id <> OLD.client_id
       OR NEW.account_id <> OLD.account_id OR NEW.fan_id <> OLD.fan_id THEN
        RAISE EXCEPTION 'creator conversation % ownership scope is immutable (was %/%/%/%)',
            OLD.conversation_id, OLD.agency_id, OLD.client_id, OLD.account_id, OLD.fan_id;
    END IF;
    IF NEW.channel <> OLD.channel THEN
        RAISE EXCEPTION 'creator conversation % channel is immutable', OLD.conversation_id;
    END IF;
    IF NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'creator conversation % provenance is immutable', OLD.conversation_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS creator_conversations_immutable_trigger ON creator_conversations;
CREATE TRIGGER creator_conversations_immutable_trigger
BEFORE UPDATE ON creator_conversations
FOR EACH ROW EXECUTE FUNCTION creator_conversations_immutable();

CREATE OR REPLACE FUNCTION creator_conversations_lifecycle_legal() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'open' THEN
            RAISE EXCEPTION 'a creator conversation is born open (got %)', NEW.status;
        END IF;
        IF NEW.closed_at IS NOT NULL THEN
            RAISE EXCEPTION 'a fresh creator conversation must not carry closed_at';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD.status = 'closed' THEN
        RAISE EXCEPTION 'creator conversation % is closed and terminal', OLD.conversation_id;
    END IF;
    IF NOT (
        (OLD.status = 'open' AND NEW.status IN ('paused', 'closed')) OR
        (OLD.status = 'paused' AND NEW.status IN ('open', 'closed'))
    ) THEN
        RAISE EXCEPTION 'illegal creator conversation transition % → % (the frozen lifecycle is open ⇄ paused with the terminal close edge)',
            OLD.status, NEW.status;
    END IF;
    IF NEW.status = 'closed' THEN
        IF NEW.closed_at IS NULL THEN
            RAISE EXCEPTION 'creator conversation % closed rows must carry closed_at', NEW.conversation_id;
        END IF;
    ELSE
        IF NEW.closed_at IS NOT NULL THEN
            RAISE EXCEPTION 'creator conversation % live rows must not carry closed_at', NEW.conversation_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS creator_conversations_lifecycle_legal_trigger ON creator_conversations;
CREATE TRIGGER creator_conversations_lifecycle_legal_trigger
BEFORE INSERT OR UPDATE OF status ON creator_conversations
FOR EACH ROW EXECUTE FUNCTION creator_conversations_lifecycle_legal();

-- ---------------------------------------------------------------------------
-- creator_conversation_messages — the conversation message records
-- (inbound = observation entry, born 'received'; outbound = THE
-- approval-gated side effect, born 'sent' — CREATOR-AC-06: the row is
-- inserted only AFTER the fail-closed policy + approval gate allowed, and
-- carries the allowing decision/approval provenance)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS creator_conversation_messages (
    message_id      uuid        PRIMARY KEY,
    agency_id       uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id       uuid        NOT NULL REFERENCES clients(client_id),
    conversation_id uuid        NOT NULL REFERENCES creator_conversations(conversation_id),
    direction       text        NOT NULL
                    CHECK (direction IN ('inbound', 'outbound')),
    status          text        NOT NULL
                    CHECK (status IN ('received', 'sent')),
    -- The bounded message copy. §8 privacy: raw conversation data is
    -- Client-scoped — it never leaves this table except through the
    -- Client-scoped read surface.
    body            text        NOT NULL
                    CHECK (length(body) >= 1 AND length(body) <= 4000),
    -- CREATOR-AC-06 provenance: the outbound row records the policy
    -- decision id that allowed the side effect (NOT NULL on outbound —
    -- the scope trigger enforces it) and the pack-owned approval record
    -- id that satisfied the configured approval requirement (NULL when
    -- the configured policy allows direct sends without approval).
    policy_decision_id text,
    approval_id     uuid        REFERENCES creator_operation_approvals(approval_id),
    -- Optional /evidence record the observation mapping appended for this
    -- message (the COMMON evidence authority — the pack owns the mapping,
    -- never a parallel store).
    evidence_ref    text        CHECK (evidence_ref IS NULL OR length(evidence_ref) <= 128),
    idempotency_key text        NOT NULL
                    CHECK (length(idempotency_key) >= 1 AND length(idempotency_key) <= 200),
    created_by      uuid        REFERENCES users(user_id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- The §8-style logical send/receive command key: a duplicate of the
    -- same logical message command converges.
    CONSTRAINT creator_conversation_messages_idempotency_unique
        UNIQUE (conversation_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS creator_conversation_messages_conversation_idx
    ON creator_conversation_messages (conversation_id, created_at, message_id);
CREATE INDEX IF NOT EXISTS creator_conversation_messages_client_idx
    ON creator_conversation_messages (client_id, created_at DESC);

CREATE OR REPLACE FUNCTION creator_conversation_messages_scope_legal() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM clients c
        WHERE c.client_id = NEW.client_id AND c.agency_id = NEW.agency_id) THEN
        RAISE EXCEPTION 'creator message % client % does not belong to agency % — pack-owned records cannot cross the Client boundary',
            NEW.message_id, NEW.client_id, NEW.agency_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM creator_conversations k
        WHERE k.conversation_id = NEW.conversation_id
          AND k.client_id = NEW.client_id AND k.agency_id = NEW.agency_id) THEN
        RAISE EXCEPTION 'creator message % must belong to a conversation of the same client %',
            NEW.message_id, NEW.client_id;
    END IF;
    -- The direction/state/provenance shape is part of the frozen contract:
    -- an outbound message is born 'sent' with its ALLOWING policy decision
    -- (the side effect passed the gate); an inbound message is born
    -- 'received' (an observation) and never carries approval provenance.
    IF NEW.direction = 'outbound' AND (NEW.status <> 'sent' OR NEW.policy_decision_id IS NULL) THEN
        RAISE EXCEPTION 'an outbound creator message must be born sent with the allowing policy decision id (the approval-gated side effect)';
    END IF;
    IF NEW.direction = 'inbound' AND (NEW.status <> 'received' OR NEW.policy_decision_id IS NOT NULL OR NEW.approval_id IS NOT NULL) THEN
        RAISE EXCEPTION 'an inbound creator message is born received and never carries approval side-effect provenance';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS creator_conversation_messages_scope_legal_trigger ON creator_conversation_messages;
CREATE TRIGGER creator_conversation_messages_scope_legal_trigger
BEFORE INSERT ON creator_conversation_messages
FOR EACH ROW EXECUTE FUNCTION creator_conversation_messages_scope_legal();

-- APPEND-ONLY: conversation history is immutable (corrections append a new
-- record — the evidence-authority pattern).
CREATE OR REPLACE FUNCTION creator_conversation_messages_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'creator conversation messages are append-only: % is rejected on message %',
        TG_OP, OLD.message_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS creator_conversation_messages_append_only_update_trigger ON creator_conversation_messages;
CREATE TRIGGER creator_conversation_messages_append_only_update_trigger
BEFORE UPDATE ON creator_conversation_messages
FOR EACH ROW EXECUTE FUNCTION creator_conversation_messages_append_only();

DROP TRIGGER IF EXISTS creator_conversation_messages_append_only_delete_trigger ON creator_conversation_messages;
CREATE TRIGGER creator_conversation_messages_append_only_delete_trigger
BEFORE DELETE ON creator_conversation_messages
FOR EACH ROW EXECUTE FUNCTION creator_conversation_messages_append_only();

-- ---------------------------------------------------------------------------
-- creator_content_assets — the Content Asset subject (§2)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS creator_content_assets (
    asset_id        uuid        PRIMARY KEY,
    agency_id       uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id       uuid        NOT NULL REFERENCES clients(client_id),
    profile_id      uuid        NOT NULL REFERENCES creator_profiles(profile_id),
    -- The frozen content lifecycle: draft → in_review → approved →
    -- published (terminal); in_review|approved → rejected (terminal).
    status          text        NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'in_review', 'approved', 'published', 'rejected')),
    title           text        NOT NULL
                    CHECK (length(title) >= 1 AND length(title) <= 200),
    content_kind    text        NOT NULL DEFAULT 'post'
                    CHECK (content_kind IN ('post', 'video_short', 'video_long', 'photo_set', 'stream', 'newsletter')),
    -- Provider-neutral planned platform labels (data — CREATOR-AC-05).
    planned_platforms jsonb     NOT NULL DEFAULT '[]'::jsonb
                    CHECK (creator_operations_payload_has_no_material_keys(planned_platforms)),
    brief           text        NOT NULL DEFAULT ''
                    CHECK (length(brief) <= 4000),
    attributes      jsonb       NOT NULL DEFAULT '{}'::jsonb
                    CHECK (creator_operations_payload_has_no_material_keys(attributes)),
    version         bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_by      uuid        REFERENCES users(user_id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    published_at    timestamptz,
    rejected_at     timestamptz,
    -- CREATOR-AC-06 provenance: the published row records the allowing
    -- policy decision (NOT NULL iff published — the lifecycle trigger
    -- enforces it) and the approval record that satisfied the configured
    -- approval requirement (NULL when the policy allows direct publish).
    policy_decision_id text,
    approval_id     uuid        REFERENCES creator_operation_approvals(approval_id),
    CONSTRAINT creator_content_assets_terminal_shape CHECK (
        (status = 'published' AND published_at IS NOT NULL AND rejected_at IS NULL)
        OR (status = 'rejected' AND rejected_at IS NOT NULL AND published_at IS NULL AND policy_decision_id IS NULL AND approval_id IS NULL)
        OR (status NOT IN ('published', 'rejected') AND published_at IS NULL AND rejected_at IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS creator_content_assets_profile_idx
    ON creator_content_assets (profile_id, created_at DESC, asset_id);
CREATE INDEX IF NOT EXISTS creator_content_assets_client_idx
    ON creator_content_assets (client_id, status);

CREATE OR REPLACE FUNCTION creator_content_assets_scope_legal() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM clients c
        WHERE c.client_id = NEW.client_id AND c.agency_id = NEW.agency_id) THEN
        RAISE EXCEPTION 'creator content asset % client % does not belong to agency % — pack-owned records cannot cross the Client boundary',
            NEW.asset_id, NEW.client_id, NEW.agency_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM creator_profiles p
        WHERE p.profile_id = NEW.profile_id AND p.client_id = NEW.client_id) THEN
        RAISE EXCEPTION 'creator content asset % must belong to a creator profile of the same client %',
            NEW.asset_id, NEW.client_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS creator_content_assets_scope_legal_trigger ON creator_content_assets;
CREATE TRIGGER creator_content_assets_scope_legal_trigger
BEFORE INSERT OR UPDATE OF agency_id, client_id, profile_id ON creator_content_assets
FOR EACH ROW EXECUTE FUNCTION creator_content_assets_scope_legal();

CREATE OR REPLACE FUNCTION creator_content_assets_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW.asset_id <> OLD.asset_id THEN
        RAISE EXCEPTION 'asset_id % is immutable', OLD.asset_id;
    END IF;
    IF NEW.agency_id <> OLD.agency_id OR NEW.client_id <> OLD.client_id
       OR NEW.profile_id <> OLD.profile_id THEN
        RAISE EXCEPTION 'creator content asset % ownership scope is immutable (was %/%/%)',
            OLD.asset_id, OLD.agency_id, OLD.client_id, OLD.profile_id;
    END IF;
    IF NEW.title <> OLD.title OR NEW.content_kind <> OLD.content_kind
       OR NEW.planned_platforms <> OLD.planned_platforms OR NEW.brief <> OLD.brief
       OR NEW.attributes <> OLD.attributes THEN
        RAISE EXCEPTION 'creator content asset % content is immutable (a new asset version is a new record)',
            OLD.asset_id;
    END IF;
    IF NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'creator content asset % provenance is immutable', OLD.asset_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS creator_content_assets_immutable_trigger ON creator_content_assets;
CREATE TRIGGER creator_content_assets_immutable_trigger
BEFORE UPDATE ON creator_content_assets
FOR EACH ROW EXECUTE FUNCTION creator_content_assets_immutable();

CREATE OR REPLACE FUNCTION creator_content_assets_lifecycle_legal() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'draft' THEN
            RAISE EXCEPTION 'a creator content asset is born draft (got %)', NEW.status;
        END IF;
        IF NEW.policy_decision_id IS NOT NULL OR NEW.approval_id IS NOT NULL THEN
            RAISE EXCEPTION 'a fresh creator content asset carries no side-effect provenance (the publish gate has not run)';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD.status IN ('published', 'rejected') THEN
        RAISE EXCEPTION 'creator content asset % is % and terminal', OLD.asset_id, OLD.status;
    END IF;
    IF NOT (
        (OLD.status = 'draft' AND NEW.status IN ('in_review', 'rejected')) OR
        (OLD.status = 'in_review' AND NEW.status IN ('approved', 'rejected')) OR
        (OLD.status = 'approved' AND NEW.status IN ('published', 'rejected'))
    ) THEN
        RAISE EXCEPTION 'illegal creator content asset transition % → % (the frozen lifecycle is draft → in_review → approved → published with the terminal reject side-exits)',
            OLD.status, NEW.status;
    END IF;
    IF NEW.status = 'published' THEN
        IF NEW.published_at IS NULL OR NEW.policy_decision_id IS NULL THEN
            RAISE EXCEPTION 'a published creator content asset must carry published_at and the allowing policy decision id (the approval-gated side effect)';
        END IF;
    END IF;
    IF NEW.status = 'rejected' AND (NEW.policy_decision_id IS NOT NULL OR NEW.approval_id IS NOT NULL) THEN
        RAISE EXCEPTION 'a rejected creator content asset carries no side-effect provenance';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS creator_content_assets_lifecycle_legal_trigger ON creator_content_assets;
CREATE TRIGGER creator_content_assets_lifecycle_legal_trigger
BEFORE INSERT OR UPDATE OF status ON creator_content_assets
FOR EACH ROW EXECUTE FUNCTION creator_content_assets_lifecycle_legal();

-- ---------------------------------------------------------------------------
-- creator_offers — the Offer subject (§2)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS creator_offers (
    offer_id        uuid        PRIMARY KEY,
    agency_id       uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id       uuid        NOT NULL REFERENCES clients(client_id),
    profile_id      uuid        NOT NULL REFERENCES creator_profiles(profile_id),
    -- The frozen offer lifecycle: draft → active ⇄ paused; active|paused →
    -- retired (terminal).
    status          text        NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'active', 'paused', 'retired')),
    title           text        NOT NULL
                    CHECK (length(title) >= 1 AND length(title) <= 200),
    offer_kind      text        NOT NULL DEFAULT 'subscription'
                    CHECK (offer_kind IN ('subscription', 'ppv_message', 'bundle', 'custom', 'tip')),
    price_cents     bigint      NOT NULL CHECK (price_cents >= 0),
    currency        text        NOT NULL DEFAULT 'USD'
                    CHECK (currency ~ '^[A-Z]{3}$'),
    terms           text        NOT NULL DEFAULT ''
                    CHECK (length(terms) <= 2000),
    attributes      jsonb       NOT NULL DEFAULT '{}'::jsonb
                    CHECK (creator_operations_payload_has_no_material_keys(attributes)),
    version         bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_by      uuid        REFERENCES users(user_id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    retired_at      timestamptz,
    CONSTRAINT creator_offers_profile_title_unique UNIQUE (profile_id, title)
);

CREATE INDEX IF NOT EXISTS creator_offers_profile_idx
    ON creator_offers (profile_id, created_at DESC, offer_id);
CREATE INDEX IF NOT EXISTS creator_offers_client_idx
    ON creator_offers (client_id, status);

CREATE OR REPLACE FUNCTION creator_offers_scope_legal() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM clients c
        WHERE c.client_id = NEW.client_id AND c.agency_id = NEW.agency_id) THEN
        RAISE EXCEPTION 'creator offer % client % does not belong to agency % — pack-owned records cannot cross the Client boundary',
            NEW.offer_id, NEW.client_id, NEW.agency_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM creator_profiles p
        WHERE p.profile_id = NEW.profile_id AND p.client_id = NEW.client_id) THEN
        RAISE EXCEPTION 'creator offer % must belong to a creator profile of the same client %',
            NEW.offer_id, NEW.client_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS creator_offers_scope_legal_trigger ON creator_offers;
CREATE TRIGGER creator_offers_scope_legal_trigger
BEFORE INSERT OR UPDATE OF agency_id, client_id, profile_id ON creator_offers
FOR EACH ROW EXECUTE FUNCTION creator_offers_scope_legal();

CREATE OR REPLACE FUNCTION creator_offers_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW.offer_id <> OLD.offer_id THEN
        RAISE EXCEPTION 'offer_id % is immutable', OLD.offer_id;
    END IF;
    IF NEW.agency_id <> OLD.agency_id OR NEW.client_id <> OLD.client_id
       OR NEW.profile_id <> OLD.profile_id THEN
        RAISE EXCEPTION 'creator offer % ownership scope is immutable (was %/%/%)',
            OLD.offer_id, OLD.agency_id, OLD.client_id, OLD.profile_id;
    END IF;
    IF NEW.title <> OLD.title OR NEW.offer_kind <> OLD.offer_kind
       OR NEW.price_cents <> OLD.price_cents OR NEW.currency <> OLD.currency
       OR NEW.terms <> OLD.terms OR NEW.attributes <> OLD.attributes THEN
        RAISE EXCEPTION 'creator offer % content is immutable (a new offer version is a new record)',
            OLD.offer_id;
    END IF;
    IF NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'creator offer % provenance is immutable', OLD.offer_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS creator_offers_immutable_trigger ON creator_offers;
CREATE TRIGGER creator_offers_immutable_trigger
BEFORE UPDATE ON creator_offers
FOR EACH ROW EXECUTE FUNCTION creator_offers_immutable();

CREATE OR REPLACE FUNCTION creator_offers_lifecycle_legal() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'draft' THEN
            RAISE EXCEPTION 'a creator offer is born draft (got %)', NEW.status;
        END IF;
        IF NEW.retired_at IS NOT NULL THEN
            RAISE EXCEPTION 'a fresh creator offer must not carry retired_at';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD.status = 'retired' THEN
        RAISE EXCEPTION 'creator offer % is retired and terminal', OLD.offer_id;
    END IF;
    IF NOT (
        (OLD.status = 'draft' AND NEW.status IN ('active', 'retired')) OR
        (OLD.status = 'active' AND NEW.status IN ('paused', 'retired')) OR
        (OLD.status = 'paused' AND NEW.status IN ('active', 'retired'))
    ) THEN
        RAISE EXCEPTION 'illegal creator offer transition % → % (the frozen lifecycle is draft → active ⇄ paused with the terminal retire edge)',
            OLD.status, NEW.status;
    END IF;
    IF NEW.status = 'retired' THEN
        IF NEW.retired_at IS NULL THEN
            RAISE EXCEPTION 'creator offer % retired rows must carry retired_at', NEW.offer_id;
        END IF;
    ELSE
        IF NEW.retired_at IS NOT NULL THEN
            RAISE EXCEPTION 'creator offer % live rows must not carry retired_at', NEW.offer_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS creator_offers_lifecycle_legal_trigger ON creator_offers;
CREATE TRIGGER creator_offers_lifecycle_legal_trigger
BEFORE INSERT OR UPDATE OF status ON creator_offers
FOR EACH ROW EXECUTE FUNCTION creator_offers_lifecycle_legal();
