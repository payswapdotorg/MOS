-- 049_commerce_capabilities.sql — MKT-071 (Commerce Catalog and Order
-- Capabilities).
--
-- The COMMERCE CAPABILITY EXTENSION of the existing /integrations boundary
-- (spec/architecture-v1.6.md §15: "The existing Integration boundary
-- becomes capable of commerce operations required by v1.6: catalog read,
-- product read/write where authorized, product listing, price/inventory
-- read, order read, order webhook and attribution data";
-- spec/effective-backlog-v1.6.md MKT-071: "extend the existing commerce
-- integration boundary to catalog, product listing, price/inventory and
-- order-event capabilities"; acceptance "normalized catalog/order/listing
-- capabilities with webhook idempotency and policy-gated mutations").
--
-- TABLE-OWNERSHIP CHOICE (disclosed in docs/implementation/MKT-071.md):
-- this Work Item EXTENDS /integrations — it registers NO new module, so
-- BOTH tables here are OWNED by /integrations following the module's own
-- migration-029 store pattern:
--
--   commerce_event_receipts → the WEBHOOK DEDUP FENCE + the honest
--                              delivery-history records: one append-only
--                              row per VERIFIED commerce event delivery —
--                              outcome 'ingested' for the first delivery
--                              of a (adapter_key, provider_event_id) pair,
--                              outcome 'duplicate' for every replayed
--                              delivery (a replayed webhook is a NO-OP for
--                              the event ledger/evidence/projection, but
--                              its receipt is APPENDED — the duplicate is
--                              surfaced honestly in the event history,
--                              never silently dropped);
--   commerce_events         → the NORMALIZED EVENT PROJECTION: one
--                              immutable row per INGESTED provider event
--                              (duplicates never project) carrying the
--                              normalized commerce event shape, the
--                              provider subject identity and the
--                              attribution/reference fields VERBATIM as
--                              PASSTHROUGH data (spec/architecture-v1.6.md
--                              §16 — mission-scoped attribution reference;
--                              NO attribution linking, matching or causal
--                              computation lives here: MKT-073 owns that).
--
-- DELIBERATE NON-CHOICES (frozen boundary discipline):
--   - NO catalog/product/listing/order STATE tables: commerce catalog,
--     product, listing, price, inventory and order state remain PROVIDER
--     authority accessed through /integrations (AGENTS.md "Commerce
--     orders/inventory remain provider authority accessed through
--     /integrations"; architecture-v1.6.md §19 "not a ... second commerce
--     order authority"; module-dependency-matrix-v1.6.md boundary rule 8
--     "store mutations flow through Integrations"). The module records
--     EVENT history + projections only; every catalog/listing mutation
--     flows through the adapter port to the provider.
--   - NO capability-key COLUMN: capabilities are ADAPTER-DECLARED registry
--     data (the migration-029 discipline — "the database never stores the
--     adapter set"); what the storage layer CHECK-fences instead is the
--     closed EVENT-KIND vocabulary (exactly the commerce-order-webhook
--     capability's declared operations), the delivery-outcome vocabulary
--     and the normalized-shape-version vocabulary.
--
-- Frozen semantics encoded here:
--
-- * WEBHOOK IDEMPOTENCY (MKT-071 AC-3; architecture.md §23 "External
--   events are validated, durably persisted, queued and handled
--   idempotently"): inbound order/product events are deduplicated by the
--   (adapter_key, provider_event_id) pair — the PARTIAL UNIQUE fence
--   admits at most ONE 'ingested' receipt per pair, so concurrent or
--   replayed deliveries converge on the constraint (the module records
--   the loser honestly as a 'duplicate' receipt), never a second ledger
--   event, evidence observation or projection row.
-- * APPEND-ONLY EVENT HISTORY (the migration 015/018/025/029 pattern):
--   both tables reject UPDATE and DELETE outright — the receipt history
--   and the normalized projection are durable exactly as recorded. There
--   is deliberately NO rewrite, NO delivery-status mutation and NO
--   dedupe-collapse column.
-- * PROVENANCE (implementation-contract §3): every receipt carries
--   server-derived provenance (recorded_actor/recorded_via/correlation_id/
--   causation_id + received_at stamped by the module clock) and the RAW
--   EVENT HASH (sha256 hex of the delivered payload) — a replayed
--   delivery with a DIFFERENT payload under the same provider event id is
--   visible in the history (the duplicate receipt records ITS OWN hash).
-- * CHECK-FENCED VOCABULARIES: delivery_outcome ∈ {ingested, duplicate};
--   event_kind ∈ the closed commerce order/product event vocabulary; 
--   normalized_shape_version ∈ the closed normalized shape versions.
--   Adding a kind or shape version is a schema change (a new migration),
--   never a runtime value.
-- * TENANT FENCE (the migration 003/004/029 pattern): client/agency scope
--   is SERVER-DERIVED through the integration connection's owning chain;
--   the connection-consistency trigger rejects a crossed chain, and the
--   duplicate-reference trigger rejects a first_receipt_id that is not
--   the INGESTED receipt of the SAME (adapter_key, provider_event_id)
--   pair (a duplicate receipt can never fabricate a first delivery).
-- * NO SECRET MATERIAL (implementation-contract §21): the normalized
--   payload and the attribution passthrough are CHECKed against
--   material-shaped keys at every nesting level (the migration-029
--   integration_payload_has_no_material_keys function is REUSED — it is
--   IMMUTABLE and globally unique per the 029 discipline).
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, received_at provenance stamps, no owner/role/user columns
-- beyond provenance — authorization stays exactly the /agencies membership
-- authority composed with canonical /clients owner resolution.

-- ---------------------------------------------------------------------------
-- commerce_event_receipts — the webhook dedup fence + delivery history
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS commerce_event_receipts (
    receipt_id              uuid        PRIMARY KEY,
    -- The dedup identity (MKT-071 AC-3): (adapter_key = the provider id,
    -- provider_event_id = the provider's own event identity). The PARTIAL
    -- UNIQUE fence below admits at most ONE 'ingested' receipt per pair.
    adapter_key             text        NOT NULL
                            CHECK (adapter_key ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
    provider_event_id       text        NOT NULL
                            CHECK (length(provider_event_id) >= 1
                                   AND length(provider_event_id) <= 128),
    connection_id           uuid        NOT NULL REFERENCES integration_connections(connection_id),
    client_id               uuid        NOT NULL REFERENCES clients(client_id),
    -- The frozen delivery-outcome vocabulary (CHECK-fenced).
    delivery_outcome        text        NOT NULL
                            CHECK (delivery_outcome IN ('ingested', 'duplicate')),
    -- Set for duplicates ONLY: the ingested receipt this replay duplicates
    -- (the trigger backstop proves it is the ingested receipt of the SAME
    -- dedup pair; NULL on 'ingested' rows).
    first_receipt_id        uuid        REFERENCES commerce_event_receipts(receipt_id),
    -- The sha256 hex of the delivered payload (64 lowercase hex chars) —
    -- recorded per delivery, so a replay with a mutated payload under a
    -- reused event id is VISIBLE in the history.
    raw_event_hash          text        NOT NULL
                            CHECK (raw_event_hash ~ '^[0-9a-f]{64}$'),
    -- The normalized shape version the adapter mapped the event to
    -- (CHECK-fenced closed vocabulary).
    normalized_shape_version text       NOT NULL
                            CHECK (normalized_shape_version IN ('commerce-order-v1', 'commerce-product-v1')),
    -- The closed commerce order/product event vocabulary (CHECK-fenced) —
    -- exactly the commerce-order-webhook capability's declared operations.
    event_kind              text        NOT NULL
                            CHECK (event_kind IN ('order.created', 'order.updated',
                                                  'order.fulfilled', 'order.cancelled',
                                                  'product.created', 'product.updated')),
    recorded_actor          text        NOT NULL CHECK (length(recorded_actor) >= 1),
    recorded_via            text        NOT NULL CHECK (length(recorded_via) >= 1
                                                 AND length(recorded_via) <= 100),
    correlation_id          text        NOT NULL,
    causation_id            text,
    received_at             timestamptz NOT NULL DEFAULT now(),
    -- A duplicate receipt MUST carry its first-delivery reference; an
    -- ingested receipt must NOT (it IS the first delivery).
    CONSTRAINT commerce_receipt_outcome_reference_consistency
        CHECK ((delivery_outcome = 'duplicate' AND first_receipt_id IS NOT NULL)
            OR (delivery_outcome = 'ingested' AND first_receipt_id IS NULL))
);

-- THE WEBHOOK IDEMPOTENCY FENCE (MKT-071 AC-3): at most ONE 'ingested'
-- receipt per (adapter_key, provider_event_id) — concurrent first
-- deliveries converge on this constraint; the module records the loser as
-- an honest 'duplicate' receipt, never a second ingested projection.
CREATE UNIQUE INDEX IF NOT EXISTS commerce_event_receipts_ingested_fence
ON commerce_event_receipts (adapter_key, provider_event_id)
WHERE delivery_outcome = 'ingested';

-- Listing surfaces: the delivery history of one Client (newest first by
-- the server-stamped receipt time — ingested AND duplicate rows alike,
-- the honest event history) and one connection's receipt stream.
CREATE INDEX IF NOT EXISTS commerce_event_receipts_client_idx
ON commerce_event_receipts (client_id, received_at, receipt_id);

CREATE INDEX IF NOT EXISTS commerce_event_receipts_connection_idx
ON commerce_event_receipts (connection_id, received_at, receipt_id);

-- APPEND-ONLY (the migration 015/018/025/029 pattern): the database itself
-- rejects UPDATE and DELETE on the receipt history — not even server code
-- can rewrite the delivery history.
CREATE OR REPLACE FUNCTION commerce_event_receipts_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'commerce event receipts are append-only: % is rejected on receipt %',
        TG_OP, OLD.receipt_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_event_receipts_append_only_update_trigger ON commerce_event_receipts;
CREATE TRIGGER commerce_event_receipts_append_only_update_trigger
    BEFORE UPDATE ON commerce_event_receipts
    FOR EACH ROW EXECUTE FUNCTION commerce_event_receipts_append_only();

DROP TRIGGER IF EXISTS commerce_event_receipts_append_only_delete_trigger ON commerce_event_receipts;
CREATE TRIGGER commerce_event_receipts_append_only_delete_trigger
    BEFORE DELETE ON commerce_event_receipts
    FOR EACH ROW EXECUTE FUNCTION commerce_event_receipts_append_only();

-- Connection-consistency backstop (the migration 029 pattern): the
-- receipt's client must match its connection row EXACTLY — the
-- denormalized columns are server-derived from the connection on the only
-- write path; a mismatched smuggle is rejected here even if every
-- application check were bypassed.
CREATE OR REPLACE FUNCTION commerce_receipt_connection_consistent() RETURNS trigger AS $$
DECLARE
    v_conn record;
BEGIN
    SELECT client_id INTO v_conn
    FROM integration_connections WHERE connection_id = NEW.connection_id;
    IF v_conn IS NULL THEN
        RAISE EXCEPTION 'commerce event receipt % references unknown connection %',
            NEW.receipt_id, NEW.connection_id;
    END IF;
    IF v_conn.client_id <> NEW.client_id THEN
        RAISE EXCEPTION 'commerce event receipt % connection % belongs to another client — cross-tenant commerce event ingestion is rejected',
            NEW.receipt_id, NEW.connection_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_receipt_connection_consistent_trigger ON commerce_event_receipts;
CREATE TRIGGER commerce_receipt_connection_consistent_trigger
    BEFORE INSERT ON commerce_event_receipts
    FOR EACH ROW EXECUTE FUNCTION commerce_receipt_connection_consistent();

-- Duplicate-reference backstop: a 'duplicate' receipt's first_receipt_id
-- must be the INGESTED receipt of the SAME (adapter_key,
-- provider_event_id) pair — a duplicate receipt can never fabricate or
-- re-point its first delivery, and an ingested receipt is never
-- self-referential.
CREATE OR REPLACE FUNCTION commerce_receipt_duplicate_reference_valid() RETURNS trigger AS $$
DECLARE
    v_first record;
BEGIN
    IF NEW.delivery_outcome = 'duplicate' THEN
        SELECT delivery_outcome, adapter_key, provider_event_id INTO v_first
        FROM commerce_event_receipts WHERE receipt_id = NEW.first_receipt_id;
        IF v_first IS NULL THEN
            RAISE EXCEPTION 'commerce event receipt % references unknown first receipt %',
                NEW.receipt_id, NEW.first_receipt_id;
        END IF;
        IF v_first.delivery_outcome <> 'ingested' THEN
            RAISE EXCEPTION 'commerce event receipt % first reference % is not an ingested receipt',
                NEW.receipt_id, NEW.first_receipt_id;
        END IF;
        IF v_first.adapter_key <> NEW.adapter_key
           OR v_first.provider_event_id <> NEW.provider_event_id THEN
            RAISE EXCEPTION 'commerce event receipt % first reference % belongs to a different provider event — duplicate receipts may never cross dedup pairs',
                NEW.receipt_id, NEW.first_receipt_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_receipt_duplicate_reference_valid_trigger ON commerce_event_receipts;
CREATE TRIGGER commerce_receipt_duplicate_reference_valid_trigger
    BEFORE INSERT ON commerce_event_receipts
    FOR EACH ROW EXECUTE FUNCTION commerce_receipt_duplicate_reference_valid();

-- ---------------------------------------------------------------------------
-- commerce_events — the normalized event projection (one row per INGESTED
-- provider event; duplicates never project)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS commerce_events (
    commerce_event_id       uuid        PRIMARY KEY,
    -- The INGESTED receipt this projection belongs to (one projection per
    -- ingested receipt — UNIQUE; the trigger backstop proves the receipt is
    -- an 'ingested' one).
    receipt_id              uuid        NOT NULL UNIQUE REFERENCES commerce_event_receipts(receipt_id),
    -- The append-only migration-029 event-ledger row the ingested delivery
    -- appended (event-stream continuity: webhook → dedup → normalized
    -- event append through the SAME commerce-event-stream path).
    event_id                uuid        NOT NULL UNIQUE REFERENCES integration_events(event_id),
    connection_id           uuid        NOT NULL REFERENCES integration_connections(connection_id),
    client_id               uuid        NOT NULL REFERENCES clients(client_id),
    adapter_key             text        NOT NULL
                            CHECK (adapter_key ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
    provider_event_id       text        NOT NULL
                            CHECK (length(provider_event_id) >= 1
                                   AND length(provider_event_id) <= 128),
    -- The closed commerce order/product event vocabulary (CHECK-fenced).
    event_kind              text        NOT NULL
                            CHECK (event_kind IN ('order.created', 'order.updated',
                                                  'order.fulfilled', 'order.cancelled',
                                                  'product.created', 'product.updated')),
    normalized_shape_version text       NOT NULL
                            CHECK (normalized_shape_version IN ('commerce-order-v1', 'commerce-product-v1')),
    -- The provider subject the event is about (the order id for order
    -- kinds, the product id for product kinds).
    provider_subject_id     text        NOT NULL
                            CHECK (length(provider_subject_id) >= 1
                                   AND length(provider_subject_id) <= 128),
    -- The NORMALIZED commerce event shape (adapter-mapped; bounded object
    -- with NO material-shaped key at any nesting level — §21).
    normalized_payload      jsonb       NOT NULL
                            CHECK (integration_event_payload_valid(normalized_payload)),
    -- The attribution/reference fields VERBATIM as PASSTHROUGH data
    -- (spec/architecture-v1.6.md §16 — mission-scoped attribution
    -- reference; bounded object with NO material-shaped key; may be the
    -- empty object when the provider supplies no reference fields; NO
    -- linking, matching or causal computation is performed or implied).
    attribution             jsonb       NOT NULL DEFAULT '{}'::jsonb
                            CHECK (integration_payload_has_no_material_keys(attribution)),
    received_at             timestamptz NOT NULL DEFAULT now()
);

-- Listing surface: the Client's normalized commerce events (newest first).
CREATE INDEX IF NOT EXISTS commerce_events_client_idx
ON commerce_events (client_id, received_at, commerce_event_id);

-- APPEND-ONLY (the tail discipline): the normalized projection of an
-- ingested event is never rewritten — corrections are NEW provider events.
CREATE OR REPLACE FUNCTION commerce_events_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'commerce events are append-only: % is rejected on commerce event %',
        TG_OP, OLD.commerce_event_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_events_append_only_update_trigger ON commerce_events;
CREATE TRIGGER commerce_events_append_only_update_trigger
    BEFORE UPDATE ON commerce_events
    FOR EACH ROW EXECUTE FUNCTION commerce_events_append_only();

DROP TRIGGER IF EXISTS commerce_events_append_only_delete_trigger ON commerce_events;
CREATE TRIGGER commerce_events_append_only_delete_trigger
    BEFORE DELETE ON commerce_events
    FOR EACH ROW EXECUTE FUNCTION commerce_events_append_only();

-- Projection-consistency backstop: the projection's receipt must be an
-- INGESTED receipt and its denormalized identity columns (connection,
-- client, adapter, provider event, kind, shape version) must match that
-- receipt EXACTLY — a projection can never disagree with its fence row.
CREATE OR REPLACE FUNCTION commerce_event_projection_consistent() RETURNS trigger AS $$
DECLARE
    v_receipt record;
BEGIN
    SELECT delivery_outcome, connection_id, client_id, adapter_key, provider_event_id,
           event_kind, normalized_shape_version
    INTO v_receipt
    FROM commerce_event_receipts WHERE receipt_id = NEW.receipt_id;
    IF v_receipt IS NULL THEN
        RAISE EXCEPTION 'commerce event % references unknown receipt %',
            NEW.commerce_event_id, NEW.receipt_id;
    END IF;
    IF v_receipt.delivery_outcome IS DISTINCT FROM 'ingested' OR v_receipt.connection_id IS DISTINCT FROM NEW.connection_id
       OR v_receipt.client_id IS DISTINCT FROM NEW.client_id
       OR v_receipt.adapter_key IS DISTINCT FROM NEW.adapter_key
       OR v_receipt.provider_event_id IS DISTINCT FROM NEW.provider_event_id
       OR v_receipt.event_kind IS DISTINCT FROM NEW.event_kind
       OR v_receipt.normalized_shape_version IS DISTINCT FROM NEW.normalized_shape_version THEN
        RAISE EXCEPTION 'commerce event % does not match its ingested receipt % — the projection may never disagree with the fence',
            NEW.commerce_event_id, NEW.receipt_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_event_projection_consistent_trigger ON commerce_events;
CREATE TRIGGER commerce_event_projection_consistent_trigger
    BEFORE INSERT ON commerce_events
    FOR EACH ROW EXECUTE FUNCTION commerce_event_projection_consistent();
