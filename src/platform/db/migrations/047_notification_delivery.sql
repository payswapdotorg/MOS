-- 047_notification_delivery.sql — MKT-068 (Notification Delivery Plane).
--
-- The NOTIFICATION DELIVERY authority (spec/effective-backlog-v1.6.md
-- MKT-068: "real delivery adapters over the existing Notifications
-- boundary"; spec/architecture-v1.6.md §14: "Notification is a
-- provider-pluggable capability. MVP: in-app and email. Future adapters:
-- WhatsApp, Telegram, SMS, Signal and additional channels. Every
-- notification has event type, urgency, human-readable explanation,
-- source/mission reference, required action, deep link and delivery
-- status"; spec/module-dependency-matrix-v1.6.md boundary rule 9:
-- "Notification Delivery delivers messages only; it does not become
-- canonical task/action state").
--
--   notifications                     → the agency-scoped durable NOTIFICATION
--                                      RECORDS carrying the full §14 field
--                                      set: event type, urgency, the
--                                      human-readable explanation, the
--                                      SOURCE REFERENCE (the producing
--                                      authority's kind + opaque record id —
--                                      carried as DATA, never resolved
--                                      here), the nullable required action,
--                                      the deep link (a RELATIVE route —
--                                      never an absolute URL) and the
--                                      ADAPTER-PLANE delivery status
--                                      (pending → dispatched; NEVER a
--                                      business/task state — boundary
--                                      rule 9);
--   notification_delivery_fences     → the DEDUP FENCE: exactly ONE row per
--                                      (source kind, source id, event type,
--                                      occurrence key) — a replayed event
--                                      occurrence can never create a second
--                                      notification (the unique fence is
--                                      the race-free backstop; the second
--                                      attempt surfaces an honest
--                                      duplicate-skipped receipt on the
--                                      ORIGINAL notification);
--   notification_delivery_receipts   → the append-only DELIVERY-ATTEMPT
--                                      tail: one row per channel attempt
--                                      (channel, outcome, provider message
--                                      id when present, the honest refusal
--                                      reason, the policy decision that
--                                      gated the attempt, provenance,
--                                      timestamp). Retries are NEW rows —
--                                      UPDATE and DELETE are rejected
--                                      outright by trigger;
--   notification_inbox_items         → the IN-APP READ STATE projection:
--                                      exactly ONE durable inbox row per
--                                      delivered notification (the future
--                                      console reads this surface), with
--                                      the read/unread transition
--                                      (read_at NULL → set EXACTLY ONCE,
--                                      never unset, never re-set — the
--                                      append-only transition discipline).
--
-- Vocabulary fences (CHECK): event type, urgency, source kind, delivery
-- status, receipt outcome and channel are CLOSED vocabularies, versioned
-- in the module (nd-vocab-v1) — a change to any of them is a NEW version,
-- never a silent re-statement. The channel fence deliberately admits the
-- FULL declared channel set (in_app + email implemented; whatsapp,
-- telegram, sms, signal the declared-pluggable-but-unimplemented keys of
-- architecture-v1.6.md §14) so a future channel adapter appends receipts
-- without migration churn; the MODULE-level registration still accepts
-- only implemented channels (fail-closed until their Work Items arrive).
--
-- Delivery-status discipline: the ONLY sanctioned UPDATE on a
-- notification row is the single pending → dispatched fill (the dispatch
-- ran; the per-channel truth is the receipt tail); DELETE is rejected
-- outright. The receipts, fences and inbox rows are FULLY append-only
-- (UPDATE/DELETE rejected outright; the inbox read transition is the one
-- narrow sanctioned UPDATE, NULL → set-once, trigger-fenced).
--
-- Tenancy: agency/client scope chain is SERVER-DERIVED by callers from
-- canonical ownership state and DB-backstopped here (the migration
-- 003/029/046 tenant fence: the client must belong to the agency; the
-- optional workspace must belong to the client). No owner/role/user
-- columns beyond provenance — authorization stays exactly the /agencies
-- membership authority composed with canonical /clients owner resolution
-- at the route layer; no second tenant or permission authority.
--
-- OWN TABLES ONLY (MKT-068 AC-10): NO notifications-module table is
-- created or mutated (the /notifications boundary from MKT-001 stays
-- boundary-only — this migration IS the delivery plane behind it), and
-- no policy, credential, tenant, workflow, execution, mission or job
-- table is created or mutated: the consumed authorities stay sole
-- (policies through its public evaluateAction contract — every gate
-- decision recorded in ITS ledger; credentials through its public
-- resolveCredentialMaterial contract — vault reference by id ONLY, there
-- is deliberately NO token, secret, material or handle column anywhere
-- in this migration, a static boundary test proves the absence).
-- Task/action state is NEVER recorded here (boundary rule 9): no
-- done/acknowledged/acted-on column exists — the read/unread state of
-- the in-app projection is a DELIVERY fact, not a task state.

-- ---------------------------------------------------------------------------
-- notifications — the durable notification records (the §14 field set)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS notifications (
    notification_id       uuid        PRIMARY KEY,
    -- The tenant scope chain (SERVER-DERIVED from canonical ownership at
    -- the route/module boundary; immutable).
    agency_id             uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id             uuid        NOT NULL REFERENCES clients(client_id),
    -- The OPTIONAL Workspace narrowing (must belong to the client).
    workspace_id          uuid        REFERENCES workspaces(workspace_id),
    -- §14: the event type (the frozen nd-vocab-v1 vocabulary).
    event_type            text        NOT NULL
                          CHECK (event_type IN (
                              'mission_attention_required', 'mission_terminal',
                              'execution_attention_required', 'deployment_attention_required',
                              'approval_required', 'anomaly_detected', 'quota_exhausted',
                              'policy_denied', 'system_notice')),
    -- §14: the urgency (the frozen vocabulary).
    urgency               text        NOT NULL
                          CHECK (urgency IN ('routine', 'important', 'urgent', 'critical')),
    -- §14: the human-readable explanation.
    explanation           text        NOT NULL
                          CHECK (length(explanation) >= 1 AND length(explanation) <= 2000),
    -- §14: the source/mission reference — the producing authority's kind
    -- (frozen vocabulary) + its OPAQUE record id, carried as DATA. The
    -- delivery plane NEVER resolves the source (no existence oracle, no
    -- cross-module read).
    source_kind           text        NOT NULL
                          CHECK (source_kind IN (
                              'growth_mission', 'execution', 'deployment',
                              'workflow_instance', 'job', 'experiment',
                              'platform', 'extension')),
    source_id             text        NOT NULL
                          CHECK (length(source_id) >= 1 AND length(source_id) <= 256),
    -- §14: the required action (nullable — informational notifications
    -- carry none).
    required_action       text
                          CHECK (required_action IS NULL
                                 OR (length(required_action) >= 1
                                     AND length(required_action) <= 1000)),
    -- §14: the deep link — a RELATIVE route into the console (never an
    -- absolute URL, never a scheme — CHECK-fenced).
    deep_link             text        NOT NULL
                          CHECK (deep_link LIKE '/%'
                                 AND length(deep_link) <= 500
                                 AND deep_link NOT LIKE '%://%'
                                 AND deep_link !~ '[[:space:]]'),
    -- The ADAPTER-PLANE delivery lifecycle (boundary rule 9: NEVER a
    -- business/task state): pending (created, dispatch not yet run) →
    -- dispatched (the dispatch ran; the per-channel truth is the receipt
    -- tail). Terminal: the dispatch fill runs exactly once.
    delivery_status       text        NOT NULL DEFAULT 'pending'
                          CHECK (delivery_status IN ('pending', 'dispatched')),
    -- SERVER-DERIVED provenance of the record (never request fields).
    created_by_actor      text        NOT NULL
                          CHECK (length(created_by_actor) >= 1
                                 AND length(created_by_actor) <= 100),
    created_via          text        NOT NULL
                          CHECK (length(created_via) >= 1
                                 AND length(created_via) <= 100),
    correlation_id        text        NOT NULL,
    causation_id          text,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    version               bigint      NOT NULL DEFAULT 1 CHECK (version >= 1)
);

-- Listing surfaces: the Client's notifications (the console inbox
-- back-range), the Workspace slice and the agency audit range.
CREATE INDEX IF NOT EXISTS notifications_client_idx
    ON notifications (client_id, created_at DESC, notification_id DESC);
CREATE INDEX IF NOT EXISTS notifications_workspace_idx
    ON notifications (workspace_id) WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS notifications_agency_idx
    ON notifications (agency_id, created_at DESC, notification_id DESC);

-- TENANT FENCE (the migration 003/029/046 pattern): the notification's
-- client must belong to its agency, and the optional workspace must
-- belong to the client — the scope chain cannot be crossed even by a
-- direct SQL writer.
CREATE OR REPLACE FUNCTION notification_scope_chain_consistent() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM clients c
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

DROP TRIGGER IF EXISTS notification_scope_chain_trigger ON notifications;
CREATE TRIGGER notification_scope_chain_trigger
    BEFORE INSERT OR UPDATE OF agency_id, client_id, workspace_id ON notifications
    FOR EACH ROW EXECUTE FUNCTION notification_scope_chain_consistent();

-- RECORD DISCIPLINE (the migration 046 grant-row pattern): every §14
-- fact, the tenant scope chain and the creation provenance are IMMUTABLE
-- through ANY mutation path. The ONLY sanctioned UPDATE is the single
-- delivery-status fill (pending → dispatched): it can never run twice,
-- never touch anything but the status, updated_at and the CAS version,
-- and never reopen a dispatched record. DELETE is rejected outright
-- (notification history is append-oriented; the honest removal surfaces
-- of future Work Items are recorded states, never erasure here).
CREATE OR REPLACE FUNCTION notification_row_disciplined() RETURNS trigger AS $$
BEGIN
    IF NEW.notification_id <> OLD.notification_id THEN
        RAISE EXCEPTION 'notification_id % is immutable', OLD.notification_id;
    END IF;
    IF NEW.agency_id <> OLD.agency_id OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
        RAISE EXCEPTION 'notification % tenant scope chain is immutable',
            OLD.notification_id;
    END IF;
    IF NEW.event_type <> OLD.event_type OR NEW.urgency <> OLD.urgency
       OR NEW.explanation <> OLD.explanation OR NEW.source_kind <> OLD.source_kind
       OR NEW.source_id <> OLD.source_id
       OR NEW.required_action IS DISTINCT FROM OLD.required_action
       OR NEW.deep_link <> OLD.deep_link THEN
        RAISE EXCEPTION 'notification % §14 content fields are immutable (was recorded at creation — corrections are NEW notifications)',
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
    -- THE SINGLE DELIVERY-STATUS FILL: pending → dispatched, exactly
    -- once; a dispatched record never reopens and nothing else may move.
    IF NEW.delivery_status <> OLD.delivery_status THEN
        IF OLD.delivery_status <> 'pending' OR NEW.delivery_status <> 'dispatched' THEN
            RAISE EXCEPTION 'illegal notification delivery-status transition % -> % on notification % (the adapter-plane lifecycle is pending -> dispatched, exactly once)',
                OLD.delivery_status, NEW.delivery_status, OLD.notification_id;
        END IF;
        IF NEW.version <> OLD.version + 1 THEN
            RAISE EXCEPTION 'the delivery-status fill must advance the CAS version (notification %)',
                OLD.notification_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notification_row_disciplined_trigger ON notifications;
CREATE TRIGGER notification_row_disciplined_trigger
    BEFORE UPDATE ON notifications
    FOR EACH ROW EXECUTE FUNCTION notification_row_disciplined();

CREATE OR REPLACE FUNCTION notification_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'notification % cannot be deleted — notification history is append-oriented (boundary rule 9: delivery facts are never erased)',
        OLD.notification_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notification_no_delete_trigger ON notifications;
CREATE TRIGGER notification_no_delete_trigger
    BEFORE DELETE ON notifications
    FOR EACH ROW EXECUTE FUNCTION notification_no_delete();

-- ---------------------------------------------------------------------------
-- notification_delivery_fences — the dedup fence (at-most-one
-- notification per event occurrence)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS notification_delivery_fences (
    fence_id              uuid        PRIMARY KEY,
    -- The event-occurrence identity (the fence key): the producing
    -- authority's kind + opaque record id, the event type and the
    -- occurrence key (the producing authority's discriminator for
    -- DISTINCT occurrences of the same event type from the same source —
    -- a monotonic counter, an epoch, an event id; opaque here).
    source_kind           text        NOT NULL
                          CHECK (source_kind IN (
                              'growth_mission', 'execution', 'deployment',
                              'workflow_instance', 'job', 'experiment',
                              'platform', 'extension')),
    source_id             text        NOT NULL
                          CHECK (length(source_id) >= 1 AND length(source_id) <= 256),
    event_type            text        NOT NULL
                          CHECK (event_type IN (
                              'mission_attention_required', 'mission_terminal',
                              'execution_attention_required', 'deployment_attention_required',
                              'approval_required', 'anomaly_detected', 'quota_exhausted',
                              'policy_denied', 'system_notice')),
    occurrence_key        text        NOT NULL
                          CHECK (occurrence_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    -- The notification this occurrence claimed (exactly one).
    notification_id       uuid        NOT NULL REFERENCES notifications(notification_id),
    claimed_by_actor      text        NOT NULL
                          CHECK (length(claimed_by_actor) >= 1
                                 AND length(claimed_by_actor) <= 100),
    claimed_via          text        NOT NULL
                          CHECK (length(claimed_via) >= 1
                                 AND length(claimed_via) <= 100),
    correlation_id        text        NOT NULL,
    causation_id          text,
    claimed_at            timestamptz NOT NULL DEFAULT now(),
    -- The fence's identity columns and its claimed notification are one
    -- atomic fact: a fence row is complete at birth or it does not exist.
    CONSTRAINT notification_delivery_fence_shape CHECK (
        notification_id IS NOT NULL AND claimed_at IS NOT NULL)
);

-- THE OCCURRENCE FENCE: at most ONE row per (source kind, source id,
-- event type, occurrence key) — a replayed event occurrence can never
-- claim a second notification (the race-free backstop; concurrent
-- first-delivery attempts converge on one winner and the losers surface
-- honest duplicate-skipped receipts on the winner's notification).
CREATE UNIQUE INDEX IF NOT EXISTS notification_delivery_fences_occurrence_fence
    ON notification_delivery_fences (source_kind, source_id, event_type, occurrence_key);

-- At most ONE fence row per notification (the 1:1 claim).
CREATE UNIQUE INDEX IF NOT EXISTS notification_delivery_fences_notification_unique
    ON notification_delivery_fences (notification_id);

CREATE INDEX IF NOT EXISTS notification_delivery_fences_notification_idx
    ON notification_delivery_fences (notification_id, claimed_at);

-- FENCE ROWS ARE FULLY APPEND-ONLY: a claimed occurrence is a fact that
-- can never be rewritten or erased — UPDATE and DELETE are rejected
-- outright by trigger.
CREATE OR REPLACE FUNCTION notification_delivery_fence_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'notification delivery fence % is append-only (the occurrence claim is an immutable fact)',
        OLD.fence_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notification_delivery_fence_append_only_trigger
    ON notification_delivery_fences;
CREATE TRIGGER notification_delivery_fence_append_only_trigger
    BEFORE UPDATE OR DELETE ON notification_delivery_fences
    FOR EACH ROW EXECUTE FUNCTION notification_delivery_fence_append_only();

-- ---------------------------------------------------------------------------
-- notification_delivery_receipts — the append-only delivery-attempt tail
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS notification_delivery_receipts (
    receipt_id            uuid        PRIMARY KEY,
    notification_id       uuid        NOT NULL REFERENCES notifications(notification_id),
    -- The channel the attempt ran through (the full declared vocabulary:
    -- in_app + email are implemented; whatsapp/telegram/sms/signal are
    -- the declared-pluggable keys — the module-level registration
    -- accepts only implemented channels today, fail-closed until their
    -- Work Items arrive).
    channel               text        NOT NULL
                          CHECK (channel IN ('in_app', 'email', 'whatsapp', 'telegram', 'sms', 'signal')),
    -- The adapter outcome of THIS attempt: delivered | failed (adapter
    -- failure, honestly recorded) | refused (the /policies gate denied
    -- the channel — fail-closed, never a silent drop) | duplicate_skipped
    -- (the dedup fence stopped a replayed occurrence).
    outcome               text        NOT NULL
                          CHECK (outcome IN ('delivered', 'failed', 'refused', 'duplicate_skipped')),
    -- The provider's message id when the adapter obtained one (the
    -- in-app projection row id for the in-app channel; the provider
    -- message id for external channels).
    provider_message_id  text
                          CHECK (provider_message_id IS NULL
                                 OR (length(provider_message_id) >= 1
                                     AND length(provider_message_id) <= 256)),
    -- The honest failure/refusal reason (bounded; NULL on delivered).
    reason                text
                          CHECK (reason IS NULL
                                 OR (length(reason) >= 1 AND length(reason) <= 1000)),
    -- The /policies decision that gated this attempt (the refusal's
    -- authoritative record lives in the policy engine's own append-only
    -- ledger; the id links the receipt to it). NULL only on
    -- duplicate-skipped receipts (the fence stops before any gate).
    policy_decision_id    uuid        REFERENCES policy_decisions(decision_id),
    -- Payload-shape fence: a delivered receipt carries no refusal reason
    -- (the provider message id is the adapter's to give); a failed or
    -- refused receipt carries the REQUIRED honest reason; a
    -- duplicate-skipped receipt carries neither a reason nor a policy
    -- decision nor a provider message id.
    CONSTRAINT notification_receipt_shape CHECK (
        (outcome = 'delivered' AND reason IS NULL)
        OR (outcome IN ('failed', 'refused') AND reason IS NOT NULL)
        OR (outcome = 'duplicate_skipped' AND reason IS NULL
            AND policy_decision_id IS NULL AND provider_message_id IS NULL)
    ),
    -- SERVER-DERIVED provenance of the attempt (never request fields).
    recorded_by_actor     text        NOT NULL
                          CHECK (length(recorded_by_actor) >= 1
                                 AND length(recorded_by_actor) <= 100),
    recorded_via          text        NOT NULL
                          CHECK (length(recorded_via) >= 1
                                 AND length(recorded_via) <= 100),
    correlation_id        text        NOT NULL,
    causation_id          text,
    recorded_at           timestamptz NOT NULL DEFAULT now()
);

-- The receipt tail reads: per notification (the delivery history) and
-- the per-channel audit range.
CREATE INDEX IF NOT EXISTS notification_delivery_receipts_notification_idx
    ON notification_delivery_receipts (notification_id, recorded_at, receipt_id);
CREATE INDEX IF NOT EXISTS notification_delivery_receipts_channel_idx
    ON notification_delivery_receipts (channel, recorded_at);

-- THE RECEIPT TAIL IS FULLY APPEND-ONLY (MKT-068 AC-5): delivery
-- attempts are immutable facts — retries are NEW rows, never rewrites;
-- UPDATE and DELETE are rejected outright by trigger.
CREATE OR REPLACE FUNCTION notification_delivery_receipt_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'notification delivery receipt % is append-only (delivery attempts are immutable facts — retries are NEW receipts)',
        OLD.receipt_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notification_delivery_receipt_append_only_trigger
    ON notification_delivery_receipts;
CREATE TRIGGER notification_delivery_receipt_append_only_trigger
    BEFORE UPDATE OR DELETE ON notification_delivery_receipts
    FOR EACH ROW EXECUTE FUNCTION notification_delivery_receipt_append_only();

-- ---------------------------------------------------------------------------
-- notification_inbox_items — the in-app read state (the console surface)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS notification_inbox_items (
    inbox_item_id         uuid        PRIMARY KEY,
    -- EXACTLY ONE inbox row per notification (the in-app channel's
    -- durable delivery record; unique-fenced).
    notification_id       uuid        NOT NULL REFERENCES notifications(notification_id),
    -- The read/unread state of the in-app projection: NULL until read,
    -- then set EXACTLY ONCE (never unset, never re-set — the append-only
    -- transition). This is a DELIVERY fact of the in-app channel, NEVER
    -- a task/action state (boundary rule 9: the module never records
    -- "task done" or "action taken" — reading a message is not acting
    -- on it).
    read_at               timestamptz,
    -- Who read it (provenance of the read transition; never a request
    -- field — server-derived from the authenticated principal).
    read_by_actor         text
                          CHECK (read_by_actor IS NULL
                                 OR (length(read_by_actor) >= 1
                                     AND length(read_by_actor) <= 100)),
    read_via             text
                          CHECK (read_via IS NULL
                                 OR (length(read_via) >= 1
                                     AND length(read_via) <= 100)),
    read_correlation_id   text,
    -- The in-app delivery provenance (the delivery attempt's own
    -- provenance — the same actor/via/correlation as the delivered
    -- receipt).
    delivered_by_actor    text        NOT NULL
                          CHECK (length(delivered_by_actor) >= 1
                                 AND length(delivered_by_actor) <= 100),
    delivered_via         text        NOT NULL
                          CHECK (length(delivered_via) >= 1
                                 AND length(delivered_via) <= 100),
    delivered_correlation_id text    NOT NULL,
    delivered_causation_id text,
    created_at            timestamptz NOT NULL DEFAULT now(),
    -- Payload-shape fence: the read facts are all-NULL or all-set.
    CONSTRAINT notification_inbox_read_shape CHECK (
        (read_at IS NULL AND read_by_actor IS NULL AND read_via IS NULL
         AND read_correlation_id IS NULL)
        OR (read_at IS NOT NULL AND read_by_actor IS NOT NULL
            AND read_via IS NOT NULL AND read_correlation_id IS NOT NULL)
    )
);

-- THE 1:1 PROJECTION FENCE: at most one inbox row per notification (the
-- in-app channel's durable delivery is one row — the unique backstop of
-- the at-most-once in-app delivery under concurrency).
CREATE UNIQUE INDEX IF NOT EXISTS notification_inbox_items_notification_unique
    ON notification_inbox_items (notification_id);

-- INBOX-ROW DISCIPLINE: the notification binding, the delivery
-- provenance and the creation time are IMMUTABLE; the ONLY sanctioned
-- UPDATE is the single read fill (all-NULL → all-set, exactly once —
-- never unset, never re-set). DELETE is rejected outright (the in-app
-- delivery fact is never erased).
CREATE OR REPLACE FUNCTION notification_inbox_item_disciplined() RETURNS trigger AS $$
BEGIN
    IF NEW.inbox_item_id <> OLD.inbox_item_id THEN
        RAISE EXCEPTION 'inbox_item_id % is immutable', OLD.inbox_item_id;
    END IF;
    IF NEW.notification_id <> OLD.notification_id THEN
        RAISE EXCEPTION 'inbox item % cannot change its notification (was %)',
            OLD.inbox_item_id, OLD.notification_id;
    END IF;
    IF NEW.delivered_by_actor <> OLD.delivered_by_actor
       OR NEW.delivered_via <> OLD.delivered_via
       OR NEW.delivered_correlation_id <> OLD.delivered_correlation_id
       OR NEW.delivered_causation_id IS DISTINCT FROM OLD.delivered_causation_id
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'inbox item % delivery provenance is immutable',
            OLD.inbox_item_id;
    END IF;
    -- THE SINGLE READ FILL: all-NULL → all-set, exactly once.
    IF OLD.read_at IS NOT NULL THEN
        RAISE EXCEPTION 'inbox item % was already read at % — the read state is an append-only transition (never re-set)',
            OLD.inbox_item_id, OLD.read_at;
    END IF;
    IF NEW.read_at IS NULL OR NEW.read_by_actor IS NULL
       OR NEW.read_via IS NULL OR NEW.read_correlation_id IS NULL THEN
        RAISE EXCEPTION 'the inbox read transition on item % must fill every read fact at once',
            OLD.inbox_item_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notification_inbox_item_disciplined_trigger
    ON notification_inbox_items;
CREATE TRIGGER notification_inbox_item_disciplined_trigger
    BEFORE UPDATE ON notification_inbox_items
    FOR EACH ROW EXECUTE FUNCTION notification_inbox_item_disciplined();

CREATE OR REPLACE FUNCTION notification_inbox_item_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'inbox item % cannot be deleted — the in-app delivery fact is never erased',
        OLD.inbox_item_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notification_inbox_item_no_delete_trigger
    ON notification_inbox_items;
CREATE TRIGGER notification_inbox_item_no_delete_trigger
    BEFORE DELETE ON notification_inbox_items
    FOR EACH ROW EXECUTE FUNCTION notification_inbox_item_no_delete();
