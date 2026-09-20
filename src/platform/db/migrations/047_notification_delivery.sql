-- 047_notification_delivery.sql — MKT-068 (Notification Delivery Plane).
--
-- The NOTIFICATION DELIVERY authority (spec/architecture-v1.6.md §14:
-- "Notification is a provider-pluggable capability. MVP: in-app and email.
-- Future adapters: WhatsApp, Telegram, SMS, Signal and additional channels.
-- Every notification has event type, urgency, human-readable explanation,
-- source/mission reference, required action, deep link and delivery
-- status."; spec/effective-backlog-v1.6.md MKT-068; spec/
-- module-dependency-matrix-v1.6.md row /notification-delivery →
-- /notifications, /policies, /credentials and boundary rule 9:
-- "Notification Delivery delivers messages only; it does not become
-- canonical task/action state").
--
--   notification_records            → the agency-scoped durable
--                                     notification records carrying the
--                                     FULL §14 field set (event type,
--                                     urgency, human-readable explanation,
--                                     source reference — producing
--                                     authority kind + id —, required
--                                     action NULLABLE, deep link) plus the
--                                     requested channel set and the email
--                                     channel context (recipient USER id +
--                                     the /credentials vault REFERENCE —
--                                     never material, §21). delivery_status
--                                     is the ADAPTER-plane lifecycle ONLY
--                                     (pending → delivered | partial |
--                                     undelivered): NO task/action state
--                                     exists anywhere in this migration
--                                     (boundary rule 9 — the module NEVER
--                                     records "task done" or "action
--                                     taken");
--   notification_delivery_receipts  → the FULLY append-only delivery
--                                     attempt tail: one row per attempt
--                                     (channel, adapter outcome, provider
--                                     message id when present, timestamp)
--                                     with the per-(notification, channel)
--                                     gapless attempt sequence; retries
--                                     append NEW receipts and never
--                                     rewrite; UPDATE/DELETE are rejected
--                                     outright;
--   notification_delivery_dedup_fence
--                                   → the idempotency fence: EXACTLY ONE
--                                     notification per (source kind,
--                                     source id, event type, occurrence
--                                     key) — a replayed event can never
--                                     double-deliver (the global unique
--                                     index backstops the race; the fence
--                                     row is immutable);
--   notification_inbox_states       → the in-app projection read state
--                                     (one row per in-app-delivered
--                                     notification): unread → read is the
--                                     single sanctioned transition, READ is
--                                     terminal, and every recorded fact is
--                                     append-only in effect (the row is
--                                     born unread at delivery; only the
--                                     read transition may touch it, and it
--                                     may never go back).
--
-- The channel vocabulary carries the two MVP channels (in-app, email) AND
-- the four future capability keys (whatsapp, telegram, sms, signal) —
-- DECLARABLE but unimplemented (the adapter registry ships only the two
-- MVP implementations; a future-channel request is refused honestly with
-- a receipt, never silently dropped).
--
-- OWN TABLES ONLY: no notifications-authority predecessor table exists
-- (MKT-001 shipped the /notifications boundary stub with no business
-- logic), and NO integration, credential, policy, tenant, workflow,
-- execution, mission, job or audit table is created or mutated here — the
-- /policies decision engine and the /credentials vault are consumed
-- READ-ONLY through their public contracts. NO secret/material column
-- exists anywhere in this migration (§21: the email provider credential
-- is a vault REFERENCE id; material resolves only through the
-- authorized-execution path inside the sanctioned adapter subtree).
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, created_at/updated_at, version CAS for the narrow
-- lifecycle transitions, provenance columns that are never
-- request-suppliable. No owner/role/user columns beyond the recipient
-- reference and provenance: authorization stays exactly the /agencies
-- membership authority composed with canonical ownership resolution at
-- the route layer — no second tenant or permission authority.

-- ---------------------------------------------------------------------------
-- notification_records — the durable §14 notification records
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS notification_records (
    notification_id       uuid        PRIMARY KEY,
    -- The tenant scope chain (SERVER-DERIVED; immutable). The record is
    -- AGENCY-scoped; the client/workspace narrowing is optional context.
    agency_id             uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id             uuid        REFERENCES clients(client_id),
    workspace_id          uuid        REFERENCES workspaces(workspace_id),
    -- THE §14 FIELD SET.
    event_type            text        NOT NULL
                          CHECK (event_type IN (
                              'mission.state_changed',
                              'mission.blocked_pending_human_action',
                              'execution.failed',
                              'execution.unknown_outcome',
                              'workflow.attention_required')),
    urgency               text        NOT NULL
                          CHECK (urgency IN ('low', 'normal', 'high', 'critical')),
    explanation           text        NOT NULL
                          CHECK (length(explanation) >= 1
                                 AND length(explanation) <= 2000),
    -- The SOURCE REFERENCE: the producing authority (kind + its canonical
    -- record id, VERBATIM — the delivery plane never re-derives producer
    -- state, boundary rule 9).
    source_kind           text        NOT NULL
                          CHECK (source_kind IN ('mission', 'execution', 'workflow', 'job')),
    source_id             text        NOT NULL
                          CHECK (source_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                 AND length(source_id) = 36),
    required_action       text
                          CHECK (required_action IS NULL
                                 OR (length(required_action) >= 1
                                     AND length(required_action) <= 512)),
    deep_link             text        NOT NULL
                          CHECK (length(deep_link) >= 1
                                 AND length(deep_link) <= 1024),
    -- The requested channel set (a non-empty, duplicate-free jsonb array
    -- of the frozen channel keys; validated element-by-element by the
    -- channel-vocabulary trigger below — CHECK constraints cannot carry
    -- subqueries). Immutable for the life of the row.
    requested_channels    jsonb       NOT NULL,
    -- THE EMAIL CHANNEL CONTEXT (payload-shape fenced below): required
    -- exactly when 'email' is requested. The recipient is a canonical
    -- MOS user identity — the address is resolved server-side through
    -- the recipient-address port, NEVER supplied as data (no address
    -- guessing); the provider credential is a /credentials vault
    -- REFERENCE id (§21 — never material).
    recipient_user_id     uuid        REFERENCES users(user_id),
    email_credential_reference_id uuid
                          REFERENCES credential_references(credential_id),
    -- THE ADAPTER-PLANE DELIVERY LIFECYCLE (§14 "delivery status"):
    -- pending at birth; delivered | partial | undelivered after a
    -- fan-out/retry. `delivered` is TERMINAL (the dedup fence makes the
    -- replay path a duplicate-skipped receipt, never a re-delivery). This
    -- is the ONLY mutable lifecycle column — there is NO task/action
    -- state anywhere (boundary rule 9).
    delivery_status       text        NOT NULL DEFAULT 'pending'
                          CHECK (delivery_status IN ('pending', 'delivered', 'partial', 'undelivered')),
    -- SERVER-DERIVED provenance of the recording (never request fields).
    created_by_actor      text        NOT NULL
                          CHECK (length(created_by_actor) >= 1
                                 AND length(created_by_actor) <= 100),
    created_via           text        NOT NULL
                          CHECK (length(created_via) >= 1
                                 AND length(created_via) <= 100),
    correlation_id        text        NOT NULL,
    causation_id          text,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    version               bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    -- THE CHANNEL/EMAIL PAYLOAD-SHAPE FENCE: the requested channel set is
    -- a non-empty bounded array; the email context columns are present
    -- EXACTLY when the email channel is requested. (The element vocabulary
    -- and duplicate-freeness are trigger-fenced below — CHECK constraints
    -- cannot carry subqueries.)
    CONSTRAINT notification_channels_shape CHECK (
        jsonb_typeof(requested_channels) = 'array'
        AND jsonb_array_length(requested_channels) >= 1
        AND jsonb_array_length(requested_channels) <= 6
        AND (
            (requested_channels @> '["email"]'::jsonb
             AND recipient_user_id IS NOT NULL
             AND email_credential_reference_id IS NOT NULL)
            OR (NOT (requested_channels @> '["email"]'::jsonb)
                AND recipient_user_id IS NULL
                AND email_credential_reference_id IS NULL)
        )
    )
);

-- The channel-vocabulary + duplicate-freeness trigger (CHECK constraints
-- cannot carry subqueries over jsonb array elements): every requested
-- channel element must be one of the six frozen channel keys, and the
-- array must be duplicate-free.
CREATE OR REPLACE FUNCTION notification_channel_vocabulary() RETURNS trigger AS $$
DECLARE
    v_channel text;
    v_total bigint;
    v_distinct bigint;
BEGIN
    SELECT count(*), count(DISTINCT e) INTO v_total, v_distinct
      FROM jsonb_array_elements_text(NEW.requested_channels) AS e;
    IF v_total <> v_distinct THEN
        RAISE EXCEPTION 'notification % requests duplicate channel entries — the requested channel set is a set',
            NEW.notification_id;
    END IF;
    FOR v_channel IN SELECT jsonb_array_elements_text(NEW.requested_channels) LOOP
        IF v_channel NOT IN ('in-app', 'email', 'whatsapp', 'telegram', 'sms', 'signal') THEN
            RAISE EXCEPTION 'notification % requests unknown channel ''%'' — the channel vocabulary is frozen (in-app, email, whatsapp, telegram, sms, signal)',
                NEW.notification_id, v_channel;
        END IF;
    END LOOP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notification_channel_vocabulary_trigger ON notification_records;
CREATE TRIGGER notification_channel_vocabulary_trigger
    BEFORE INSERT OR UPDATE OF requested_channels ON notification_records
    FOR EACH ROW EXECUTE FUNCTION notification_channel_vocabulary();

-- TENANT FENCE (the migration 003/004/046 pattern): the record's client
-- must belong to its agency and the optional workspace to the client (the
-- scope chain was resolved server-side by the caller — the database
-- backstops it).
CREATE OR REPLACE FUNCTION notification_scope_chain_consistent() RETURNS trigger AS $$
BEGIN
    IF NEW.client_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM clients c
        WHERE c.client_id = NEW.client_id AND c.agency_id = NEW.agency_id) THEN
        RAISE EXCEPTION 'notification % client % does not belong to agency % — the tenant scope chain cannot be crossed',
            NEW.notification_id, NEW.client_id, NEW.agency_id;
    END IF;
    IF NEW.workspace_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workspaces w
        WHERE w.workspace_id = NEW.workspace_id AND w.client_id = NEW.client_id) THEN
        RAISE EXCEPTION 'notification % workspace % does not belong to client % — the tenant scope chain cannot be crossed',
            NEW.notification_id, NEW.workspace_id, NEW.client_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notification_scope_chain_trigger ON notification_records;
CREATE TRIGGER notification_scope_chain_trigger
    BEFORE INSERT OR UPDATE OF agency_id, client_id, workspace_id ON notification_records
    FOR EACH ROW EXECUTE FUNCTION notification_scope_chain_consistent();

-- RECORD IMMUTABILITY + THE FROZEN ADAPTER-PLANE LIFECYCLE: the scope
-- chain, the §14 field set, the source reference, the requested channel
-- set, the email context and the creation provenance can NEVER be
-- reassigned through ANY ordinary mutation path; the ONLY mutable
-- columns are the adapter-plane delivery lifecycle (delivery_status),
-- updated_at and the CAS version.
CREATE OR REPLACE FUNCTION notification_records_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW.notification_id <> OLD.notification_id THEN
        RAISE EXCEPTION 'notification_id % is immutable', OLD.notification_id;
    END IF;
    IF NEW.agency_id <> OLD.agency_id
       OR NEW.client_id IS DISTINCT FROM OLD.client_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
        RAISE EXCEPTION 'notification % cannot change its tenant scope chain',
            OLD.notification_id;
    END IF;
    IF NEW.event_type <> OLD.event_type
       OR NEW.urgency <> OLD.urgency
       OR NEW.explanation <> OLD.explanation
       OR NEW.source_kind <> OLD.source_kind
       OR NEW.source_id <> OLD.source_id
       OR NEW.required_action IS DISTINCT FROM OLD.required_action
       OR NEW.deep_link <> OLD.deep_link THEN
        RAISE EXCEPTION 'notification % cannot rewrite its §14 field set — corrections are NEW notification records',
            OLD.notification_id;
    END IF;
    IF NEW.requested_channels IS DISTINCT FROM OLD.requested_channels THEN
        RAISE EXCEPTION 'notification % cannot rewrite its requested channel set',
            OLD.notification_id;
    END IF;
    IF NEW.recipient_user_id IS DISTINCT FROM OLD.recipient_user_id
       OR NEW.email_credential_reference_id IS DISTINCT FROM OLD.email_credential_reference_id THEN
        RAISE EXCEPTION 'notification % cannot rewrite its email channel context',
            OLD.notification_id;
    END IF;
    IF NEW.created_by_actor <> OLD.created_by_actor
       OR NEW.created_via <> OLD.created_via
       OR NEW.correlation_id <> OLD.correlation_id
       OR NEW.causation_id IS DISTINCT FROM OLD.causation_id
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'notification % creation provenance is immutable',
            OLD.notification_id;
    END IF;
    -- THE FROZEN ADAPTER-PLANE LIFECYCLE: pending → delivered | partial |
    -- undelivered; partial/undelivered may move again (retries append new
    -- receipts); delivered is TERMINAL.
    IF NEW.delivery_status <> OLD.delivery_status THEN
        IF OLD.delivery_status = 'delivered' THEN
            RAISE EXCEPTION 'notification % is delivered — the adapter-plane delivery lifecycle is terminal and cannot be re-opened in place',
                OLD.notification_id;
        END IF;
        IF NEW.delivery_status NOT IN ('delivered', 'partial', 'undelivered') THEN
            RAISE EXCEPTION 'illegal notification delivery-status transition % -> % on notification %',
                OLD.delivery_status, NEW.delivery_status, OLD.notification_id;
        END IF;
        IF OLD.delivery_status = 'pending' AND NEW.delivery_status = 'pending' THEN
            RAISE EXCEPTION 'illegal notification delivery-status transition pending -> pending on notification %',
                OLD.notification_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notification_records_immutable_trigger ON notification_records;
CREATE TRIGGER notification_records_immutable_trigger
    BEFORE UPDATE ON notification_records
    FOR EACH ROW EXECUTE FUNCTION notification_records_immutable();

-- Records are never deleted (the audit/history posture of the append-only
-- tails; the module exposes no delete surface).
CREATE OR REPLACE FUNCTION notification_records_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'notification_records rows are never deleted — the delivery history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notification_records_no_delete_trigger ON notification_records;
CREATE TRIGGER notification_records_no_delete_trigger
    BEFORE DELETE ON notification_records
    FOR EACH ROW EXECUTE FUNCTION notification_records_no_delete();

-- Listing surfaces: the agency's records (newest first), the optional
-- client slice and the inbox lookups.
CREATE INDEX IF NOT EXISTS notification_records_agency_idx
    ON notification_records (agency_id, created_at, notification_id);
CREATE INDEX IF NOT EXISTS notification_records_client_idx
    ON notification_records (client_id, created_at) WHERE client_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- notification_delivery_receipts — the append-only delivery attempt tail
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS notification_delivery_receipts (
    receipt_id            uuid        PRIMARY KEY,
    notification_id        uuid        NOT NULL REFERENCES notification_records(notification_id),
    -- Denormalized agency scope (server-derived at append time; immutable)
    -- so the isolation reads never traverse foreign tenants.
    agency_id             uuid        NOT NULL REFERENCES agencies(agency_id),
    channel               text        NOT NULL
                          CHECK (channel IN ('in-app', 'email', 'whatsapp', 'telegram', 'sms', 'signal')),
    -- The per-(notification, channel) gapless attempt sequence: 1 for the
    -- first attempt on a channel, +1 per retry — retries are NEW receipts.
    attempt_seq           bigint      NOT NULL CHECK (attempt_seq >= 1),
    -- The frozen adapter-outcome vocabulary. `duplicate_skipped` is the
    -- honest fence receipt of a REPLAYED event (the second attempt); it
    -- is NOT a delivery outcome and never participates in the record's
    -- delivery_status computation.
    outcome               text        NOT NULL
                          CHECK (outcome IN ('delivered', 'failed', 'refused', 'duplicate_skipped')),
    -- The bounded honest reason (refusal cause, failure cause, or the
    -- duplicate-skip provenance). NULL when nothing needs saying.
    reason                text
                          CHECK (reason IS NULL
                                 OR (length(reason) >= 1 AND length(reason) <= 512)),
    -- The provider message id when the adapter obtained one (email — on a
    -- delivered OR failed provider attempt).
    provider_message_id   text
                          CHECK (provider_message_id IS NULL
                                 OR (length(provider_message_id) >= 1
                                     AND length(provider_message_id) <= 256)),
    -- The /policies decision id when a policy gate decided the refusal
    -- (traceability into the append-only decision ledger).
    policy_decision_id    text
                          CHECK (policy_decision_id IS NULL
                                 OR (length(policy_decision_id) >= 1
                                     AND length(policy_decision_id) <= 64)),
    -- SERVER-DERIVED provenance (never request fields).
    recorded_actor        text        NOT NULL
                          CHECK (length(recorded_actor) >= 1
                                 AND length(recorded_actor) <= 100),
    recorded_via          text        NOT NULL
                          CHECK (length(recorded_via) >= 1
                                 AND length(recorded_via) <= 100),
    correlation_id        text        NOT NULL,
    causation_id          text,
    recorded_at           timestamptz NOT NULL DEFAULT now(),
    -- NO updated_at / version: FULLY append-only.
    -- The attempt payload shape: a provider message id exists only on
    -- delivered/failed provider attempts; a policy decision id only on a
    -- policy-refused attempt; a duplicate-skip receipt carries ONLY the
    -- skip fact (no provider message, no policy decision).
    CONSTRAINT notification_receipt_shape CHECK (
        (outcome = 'duplicate_skipped'
            AND provider_message_id IS NULL
            AND policy_decision_id IS NULL)
        OR (outcome IN ('delivered', 'failed', 'refused')
            AND (provider_message_id IS NULL
                 OR outcome IN ('delivered', 'failed'))
            AND (policy_decision_id IS NULL
                 OR outcome = 'refused'))
    )
);

-- Gapless per-(notification, channel) attempt sequence under concurrency:
-- the appends are serialized by the module's row lock on the parent
-- notification; the unique index backstops the sequence integrity.
CREATE UNIQUE INDEX IF NOT EXISTS notification_receipts_attempt_unique
    ON notification_delivery_receipts (notification_id, channel, attempt_seq);

-- The receipt tail is per-notification ordered: newest last (append order).
CREATE INDEX IF NOT EXISTS notification_receipts_notification_idx
    ON notification_delivery_receipts (notification_id, recorded_at, receipt_id);
CREATE INDEX IF NOT EXISTS notification_receipts_agency_idx
    ON notification_delivery_receipts (agency_id, recorded_at);

-- FULLY APPEND-ONLY: UPDATE and DELETE are rejected outright — retries
-- create NEW receipts, never rewrites; the recorded attempt history is
-- immutable fact.
CREATE OR REPLACE FUNCTION notification_receipts_append_only_update() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'notification_delivery_receipts rows are append-only — delivery attempts are never rewritten (retries append NEW receipts)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notification_receipts_append_only_update_trigger ON notification_delivery_receipts;
CREATE TRIGGER notification_receipts_append_only_update_trigger
    BEFORE UPDATE ON notification_delivery_receipts
    FOR EACH ROW EXECUTE FUNCTION notification_receipts_append_only_update();

CREATE OR REPLACE FUNCTION notification_receipts_append_only_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'notification_delivery_receipts rows are append-only — delivery attempts are never deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notification_receipts_append_only_delete_trigger ON notification_delivery_receipts;
CREATE TRIGGER notification_receipts_append_only_delete_trigger
    BEFORE DELETE ON notification_delivery_receipts
    FOR EACH ROW EXECUTE FUNCTION notification_receipts_append_only_delete();

-- Receipt scope consistency (the denormalized agency must match the
-- parent notification's scope — a receipt can never leak across tenants).
CREATE OR REPLACE FUNCTION notification_receipt_scope_consistent() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM notification_records n
        WHERE n.notification_id = NEW.notification_id
          AND n.agency_id = NEW.agency_id) THEN
        RAISE EXCEPTION 'notification receipt % does not match its notification % agency scope — cross-tenant receipt append rejected',
            NEW.receipt_id, NEW.notification_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notification_receipt_scope_trigger ON notification_delivery_receipts;
CREATE TRIGGER notification_receipt_scope_trigger
    BEFORE INSERT ON notification_delivery_receipts
    FOR EACH ROW EXECUTE FUNCTION notification_receipt_scope_consistent();

-- ---------------------------------------------------------------------------
-- notification_delivery_dedup_fence — the idempotency fence
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS notification_delivery_dedup_fence (
    fence_id              uuid        PRIMARY KEY,
    -- THE FENCE KEY (frozen): exactly one notification per (source kind,
    -- source id, event type, occurrence key). The source id is a canonical
    -- producer UUID (CHECK-fenced above), so the global key space cannot
    -- collide across tenants; the agency column carries the owning scope
    -- for the uniform fail-closed read-back.
    source_kind           text        NOT NULL
                          CHECK (source_kind IN ('mission', 'execution', 'workflow', 'job')),
    source_id             text        NOT NULL
                          CHECK (source_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                 AND length(source_id) = 36),
    event_type            text        NOT NULL
                          CHECK (event_type IN (
                              'mission.state_changed',
                              'mission.blocked_pending_human_action',
                              'execution.failed',
                              'execution.unknown_outcome',
                              'workflow.attention_required')),
    occurrence_key        text        NOT NULL
                          CHECK (length(occurrence_key) >= 1
                                 AND length(occurrence_key) <= 128),
    agency_id             uuid        NOT NULL REFERENCES agencies(agency_id),
    notification_id       uuid        NOT NULL REFERENCES notification_records(notification_id),
    created_at            timestamptz NOT NULL DEFAULT now()
);

-- THE FENCE: the global unique index on the four frozen key fields — a
-- replayed event (or a concurrent double-submit) can never produce a
-- second notification; the loser converges on the duplicate-skipped path.
CREATE UNIQUE INDEX IF NOT EXISTS notification_dedup_fence_unique
    ON notification_delivery_dedup_fence (source_kind, source_id, event_type, occurrence_key);

CREATE INDEX IF NOT EXISTS notification_dedup_fence_notification_idx
    ON notification_delivery_dedup_fence (notification_id);

-- Fence rows are immutable facts (no UPDATE, no DELETE — the fence history
-- is the idempotency audit trail).
CREATE OR REPLACE FUNCTION notification_dedup_fence_append_only_update() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'notification_delivery_dedup_fence rows are immutable — the idempotency fence history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notification_dedup_fence_append_only_update_trigger ON notification_delivery_dedup_fence;
CREATE TRIGGER notification_dedup_fence_append_only_update_trigger
    BEFORE UPDATE ON notification_delivery_dedup_fence
    FOR EACH ROW EXECUTE FUNCTION notification_dedup_fence_append_only_update();

CREATE OR REPLACE FUNCTION notification_dedup_fence_append_only_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'notification_delivery_dedup_fence rows are immutable — the idempotency fence history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notification_dedup_fence_append_only_delete_trigger ON notification_delivery_dedup_fence;
CREATE TRIGGER notification_dedup_fence_append_only_delete_trigger
    BEFORE DELETE ON notification_delivery_dedup_fence
    FOR EACH ROW EXECUTE FUNCTION notification_dedup_fence_append_only_delete();

-- ---------------------------------------------------------------------------
-- notification_inbox_states — the in-app projection read state
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS notification_inbox_states (
    inbox_state_id        uuid        PRIMARY KEY,
    -- ONE row per in-app-delivered notification (the console read surface).
    notification_id       uuid        NOT NULL UNIQUE REFERENCES notification_records(notification_id),
    agency_id             uuid        NOT NULL REFERENCES agencies(agency_id),
    -- The read/unread state: born 'unread' at in-app delivery; unread →
    -- read is the single sanctioned transition and READ IS TERMINAL (an
    -- acknowledged notification is never un-acknowledged — append-only
    -- transitions).
    read_status           text        NOT NULL DEFAULT 'unread'
                          CHECK (read_status IN ('unread', 'read')),
    read_at               timestamptz,
    read_by_actor         text
                          CHECK (read_by_actor IS NULL
                                 OR (length(read_by_actor) >= 1
                                     AND length(read_by_actor) <= 100)),
    version               bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    -- The read-facts shape: the read provenance is present EXACTLY on
    -- rows that have transitioned to read.
    CONSTRAINT notification_inbox_read_shape CHECK (
        (read_status = 'unread'
         AND read_at IS NULL
         AND read_by_actor IS NULL)
        OR (read_status = 'read'
            AND read_at IS NOT NULL
            AND read_by_actor IS NOT NULL)
    )
);

-- The inbox slice listing surfaces (newest first).
CREATE INDEX IF NOT EXISTS notification_inbox_states_agency_idx
    ON notification_inbox_states (agency_id, created_at, notification_id);
CREATE INDEX IF NOT EXISTS notification_inbox_states_client_idx
    ON notification_inbox_states (notification_id) WHERE read_status = 'unread';

-- The single sanctioned transition: unread → read (terminal). Everything
-- else — identity, scope, delivery-born facts — is immutable; the read
-- facts are set exactly once.
CREATE OR REPLACE FUNCTION notification_inbox_states_disciplined() RETURNS trigger AS $$
BEGIN
    IF NEW.inbox_state_id <> OLD.inbox_state_id
       OR NEW.notification_id <> OLD.notification_id
       OR NEW.agency_id <> OLD.agency_id THEN
        RAISE EXCEPTION 'notification inbox state % identity is immutable',
            OLD.inbox_state_id;
    END IF;
    IF NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'notification inbox state % birth timestamp is immutable',
            OLD.inbox_state_id;
    END IF;
    IF NEW.read_status <> OLD.read_status THEN
        IF OLD.read_status = 'read' THEN
            RAISE EXCEPTION 'notification inbox state % is read — the read transition is terminal and cannot be reversed',
                OLD.inbox_state_id;
        END IF;
        IF NEW.read_status <> 'read' THEN
            RAISE EXCEPTION 'illegal notification inbox transition % -> % on inbox state %',
                OLD.read_status, NEW.read_status, OLD.inbox_state_id;
        END IF;
        -- The read facts are set EXACTLY once, with the transition.
        IF NEW.read_at IS NULL OR NEW.read_by_actor IS NULL THEN
            RAISE EXCEPTION 'notification inbox state % read transition requires the read facts (read_at, read_by_actor)',
                OLD.inbox_state_id;
        END IF;
    ELSE
        -- No transition: the read facts (and everything else) are frozen.
        IF NEW.read_at IS DISTINCT FROM OLD.read_at
           OR NEW.read_by_actor IS DISTINCT FROM OLD.read_by_actor THEN
            RAISE EXCEPTION 'notification inbox state % read facts are set exactly once',
                OLD.inbox_state_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notification_inbox_states_disciplined_trigger ON notification_inbox_states;
CREATE TRIGGER notification_inbox_states_disciplined_trigger
    BEFORE UPDATE ON notification_inbox_states
    FOR EACH ROW EXECUTE FUNCTION notification_inbox_states_disciplined();

-- Inbox rows are never deleted (the read/unread history of the in-app
-- projection is durable; the module exposes no delete surface).
CREATE OR REPLACE FUNCTION notification_inbox_states_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'notification_inbox_states rows are never deleted — the in-app projection history is durable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notification_inbox_states_no_delete_trigger ON notification_inbox_states;
CREATE TRIGGER notification_inbox_states_no_delete_trigger
    BEFORE DELETE ON notification_inbox_states
    FOR EACH ROW EXECUTE FUNCTION notification_inbox_states_no_delete();

-- The inbox scope consistency: the row's agency must match its parent
-- notification's agency (an inbox row can never leak across tenants), and
-- the parent notification must actually carry the in-app channel (an
-- inbox row exists only for in-app-delivered notifications).
CREATE OR REPLACE FUNCTION notification_inbox_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_record record;
BEGIN
    SELECT agency_id, requested_channels INTO v_record
      FROM notification_records WHERE notification_id = NEW.notification_id;
    IF v_record IS NULL THEN
        RAISE EXCEPTION 'notification inbox state % references unknown notification %',
            NEW.inbox_state_id, NEW.notification_id;
    END IF;
    IF v_record.agency_id <> NEW.agency_id THEN
        RAISE EXCEPTION 'notification inbox state % agency % does not match its notification agency % — cross-tenant inbox append rejected',
            NEW.inbox_state_id, NEW.agency_id, v_record.agency_id;
    END IF;
    IF NOT (('["in-app"]'::jsonb <@ v_record.requested_channels)) THEN
        RAISE EXCEPTION 'notification inbox state % requires the notification % to carry the in-app channel',
            NEW.inbox_state_id, NEW.notification_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notification_inbox_scope_trigger ON notification_inbox_states;
CREATE TRIGGER notification_inbox_scope_trigger
    BEFORE INSERT ON notification_inbox_states
    FOR EACH ROW EXECUTE FUNCTION notification_inbox_scope_consistent();
