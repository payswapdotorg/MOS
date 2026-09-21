-- 049_commerce_capabilities.sql — MKT-071 (Commerce Catalog and Order
-- Capabilities).
--
-- The COMMERCE CAPABILITY layer of the EXISTING /integrations boundary
-- (spec/effective-backlog-v1.6.md MKT-071: "extend the existing commerce
-- integration boundary to catalog, product listing, price/inventory and
-- order-event capabilities"; spec/architecture-v1.6.md §15: "The existing
-- Integration boundary becomes capable of commerce operations required by
-- v1.6: catalog read, product read/write where authorized, product
-- listing, price/inventory read, order read, order webhook and attribution
-- data"; spec/module-dependency-matrix-v1.6.md boundary rule 8: "Commerce
-- Discovery never writes directly to catalog/order tables; store mutations
-- flow through Integrations"):
--
--   commerce_webhook_event_fences → the WEBHOOK DEDUP FENCE (MKT-071
--                                   AC-3): exactly ONE row per
--                                   (adapter_key, provider_event_id) —
--                                   inbound order/product events are
--                                   deduplicated by (provider id, event
--                                   id); a replayed webhook can never
--                                   claim a second ingested event. The
--                                   fence row records the claimed
--                                   integration-events ledger row, the
--                                   raw-event hash, the normalized shape
--                                   version and the claim provenance;
--   commerce_events               → the append-only NORMALIZED EVENT
--                                   PROJECTION / EVENT HISTORY (AC-3/6/7):
--                                   one row per commerce webhook delivery
--                                   OBSERVATION — outcome 'ingested' (the
--                                   first delivery: references the
--                                   integration_events ledger row + the
--                                   derived /evidence observation) or
--                                   'duplicate-received' (a replay: the
--                                   honest no-op record surfacing in the
--                                   event history — NEVER a silent drop;
--                                   references the ingested row it
--                                   duplicated). FULLY append-only:
--                                   UPDATE and DELETE are rejected by
--                                   triggers;
--   commerce_mutation_records     → the append-only COMMERCE MUTATION
--                                   LEDGER (AC-4): one row per store
--                                   mutation that flowed THROUGH the
--                                   /integrations boundary (product write,
--                                   listing management) with the declaring
--                                   capability key, the operation, the
--                                   provider-visible outcome and the
--                                   policy decision that gated it — the
--                                   audit surface proving store mutations
--                                   flow through Integrations (matrix
--                                   boundary rule 8) and nothing else.
--
-- NO CATALOG/PRODUCT/LISTING/ORDER AUTHORITY IS CREATED HERE: there is
-- deliberately NO product/listing/catalog table, NO price/inventory table
-- and NO order table — the provider store remains the SOLE catalog and
-- order authority (boundary rule 8; architecture §19 "no second commerce
-- order authority"); MOS keeps only the dedup fence, the append-only
-- event history and the append-only mutation ledger (a disclosed
-- projection choice — see docs/implementation/MKT-071.md). NO catalog
-- write path exists anywhere in this migration.
--
-- Vocabulary fences (CHECK): the event kinds ('order', 'product',
-- 'listing'), the event outcomes ('ingested', 'duplicate-received') and
-- the commerce mutation capability keys ('commerce-product-write',
-- 'commerce-listing-manage') are CLOSED vocabularies mirrored from the
-- module contract (src/modules/integrations/public.ts — COMMERCE_EVENT_
-- KINDS / COMMERCE_EVENT_OUTCOMES / COMMERCE_MUTATION_CAPABILITY_KEYS; a
-- static boundary test proves the mirror). A change to any of them is a
-- NEW vocabulary version, never a silent re-statement.
--
-- Attribution is PASSTHROUGH DATA (architecture §16): the normalized
-- event payload column carries the provider's attribution/reference
-- fields VERBATIM (jsonb, §21-material-key-checked by the migration-029
-- validator); NO attribution linking, matching or causal computation
-- exists anywhere in this layer (MKT-073 owns that later).
--
-- Tenancy: the agency/client scope chain is SERVER-DERIVED by the module
-- from the canonical integration-connection owning chain and
-- DB-backstopped here (the migration 029/046 tenant fence pattern: the
-- client must belong to the agency; the event/fence/ledger rows must
-- match their integration connection's client AND adapter exactly — a
-- smuggled cross-tenant row is rejected even if every application check
-- were bypassed). No owner/role/user columns beyond provenance —
-- authorization stays exactly the /agencies membership authority composed
-- with canonical /clients owner resolution at the route layer; no second
-- tenant or permission authority.
--
-- OWN TABLES ONLY (the /integrations store pattern): migration 029's
-- integration_connections/integration_events remain the sole connection
-- and raw-ledger authorities — consumed here READ-ONLY through FK
-- references; no policy, credential, tenant, workflow, execution,
-- evidence, mission or notification table is created or mutated, and no
-- token/secret/material/handle column exists anywhere (a static boundary
-- test proves the absence — §21: connections reference credentials by
-- logical name only, and nothing secret can ride in through any commerce
-- payload column).

-- ---------------------------------------------------------------------------
-- commerce_webhook_event_fences — the webhook dedup fence (at-most-one
-- ingested event per provider event identity)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS commerce_webhook_event_fences (
    fence_id              uuid        PRIMARY KEY,
    -- The FENCE KEY (AC-3): the provider identity (the adapter key — the
    -- provider id inside MOS) + the provider's OWN event id (opaque,
    -- carried verbatim from the verified delivery by the adapter).
    adapter_key           text        NOT NULL
                          CHECK (adapter_key ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
    provider_event_id     text        NOT NULL
                          CHECK (length(provider_event_id) >= 1
                                 AND length(provider_event_id) <= 256),
    -- The canonical integration connection the delivery arrived through
    -- (READ-ONLY reference; the tenant chain derives from it).
    connection_id         uuid        NOT NULL REFERENCES integration_connections(connection_id),
    client_id             uuid        NOT NULL REFERENCES clients(client_id),
    agency_id             uuid        NOT NULL REFERENCES agencies(agency_id),
    -- The frozen commerce event-kind vocabulary (order/product/listing).
    event_kind            text        NOT NULL
                          CHECK (event_kind IN ('order', 'product', 'listing')),
    -- The adapter-normalized event type (verbatim, e.g. 'commerce:order.created').
    event_type            text        NOT NULL
                          CHECK (length(event_type) >= 1 AND length(event_type) <= 128),
    -- The raw-event hash (sha256 hex of the delivered payload — provenance).
    raw_event_hash        text        NOT NULL
                          CHECK (raw_event_hash ~ '^[a-f0-9]{64}$'),
    -- The normalized shape version stamp (e.g. 'commerce-event-v1').
    shape_version         text        NOT NULL
                          CHECK (length(shape_version) >= 1
                                 AND length(shape_version) <= 64),
    -- The claimed raw-ledger row (the integration_events append of the
    -- FIRST delivery) — complete at birth: a fence row exists only for a
    -- delivery that actually ingested.
    integration_event_id  uuid        NOT NULL REFERENCES integration_events(event_id),
    evidence_ref          uuid,
    -- SERVER-DERIVED claim provenance (never request fields).
    claimed_by_actor      text        NOT NULL
                          CHECK (length(claimed_by_actor) >= 1
                                 AND length(claimed_by_actor) <= 100),
    claimed_via           text        NOT NULL
                          CHECK (length(claimed_via) >= 1
                                 AND length(claimed_via) <= 100),
    correlation_id        text        NOT NULL,
    causation_id          text,
    claimed_at            timestamptz NOT NULL DEFAULT now()
);

-- THE DEDUP FENCE (AC-3): at most ONE row per (adapter_key,
-- provider_event_id) — a replayed webhook can never claim a second
-- ingested event (the race-free backstop; concurrent first-delivery
-- attempts converge on one winner and the losers surface honest
-- duplicate-received history rows).
CREATE UNIQUE INDEX IF NOT EXISTS commerce_webhook_event_fences_provider_event_fence
    ON commerce_webhook_event_fences (adapter_key, provider_event_id);

CREATE INDEX IF NOT EXISTS commerce_webhook_event_fences_integration_event_idx
    ON commerce_webhook_event_fences (integration_event_id);

-- FENCE ROWS ARE FULLY APPEND-ONLY: a claimed provider event is a fact
-- that can never be rewritten or erased (the migration 015/018/046/047
-- pattern).
CREATE OR REPLACE FUNCTION commerce_webhook_event_fence_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'commerce webhook event fence % is append-only (the provider-event claim is an immutable fact)',
        OLD.fence_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_webhook_event_fence_append_only_trigger
    ON commerce_webhook_event_fences;
CREATE TRIGGER commerce_webhook_event_fence_append_only_trigger
    BEFORE UPDATE OR DELETE ON commerce_webhook_event_fences
    FOR EACH ROW EXECUTE FUNCTION commerce_webhook_event_fence_append_only();

-- TENANT/CONNECTION CONSISTENCY (the migration 029 event-consistency
-- pattern): the fence's client and adapter must match its integration
-- connection row EXACTLY — the denormalized columns are server-derived
-- from the connection on the only write path; a mismatched smuggle is
-- rejected here even if every application check were bypassed.
CREATE OR REPLACE FUNCTION commerce_fence_connection_consistent() RETURNS trigger AS $$
DECLARE
    v_conn record;
BEGIN
    SELECT client_id, agency_id, adapter_key INTO v_conn
    FROM integration_connections WHERE connection_id = NEW.connection_id;
    IF v_conn IS NULL THEN
        RAISE EXCEPTION 'commerce webhook event fence % references unknown integration connection %',
            NEW.fence_id, NEW.connection_id;
    END IF;
    IF v_conn.client_id <> NEW.client_id OR v_conn.agency_id <> NEW.agency_id THEN
        RAISE EXCEPTION 'commerce webhook event fence % connection % belongs to another client/agency — cross-tenant fence claims are rejected',
            NEW.fence_id, NEW.connection_id;
    END IF;
    IF v_conn.adapter_key <> NEW.adapter_key THEN
        RAISE EXCEPTION 'commerce webhook event fence % adapter % does not match its connection adapter %',
            NEW.fence_id, NEW.adapter_key, v_conn.adapter_key;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_fence_connection_consistent_trigger ON commerce_webhook_event_fences;
CREATE TRIGGER commerce_fence_connection_consistent_trigger
    BEFORE INSERT ON commerce_webhook_event_fences
    FOR EACH ROW EXECUTE FUNCTION commerce_fence_connection_consistent();

-- ---------------------------------------------------------------------------
-- commerce_events — the append-only normalized event projection (the
-- commerce event history: one row per observed delivery, ingested or
-- duplicate-received)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS commerce_events (
    commerce_event_id     uuid        PRIMARY KEY,
    connection_id         uuid        NOT NULL REFERENCES integration_connections(connection_id),
    client_id             uuid        NOT NULL REFERENCES clients(client_id),
    agency_id             uuid        NOT NULL REFERENCES agencies(agency_id),
    adapter_key           text        NOT NULL
                          CHECK (adapter_key ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
    provider_event_id     text        NOT NULL
                          CHECK (length(provider_event_id) >= 1
                                 AND length(provider_event_id) <= 256),
    -- The frozen commerce event-kind vocabulary.
    event_kind            text        NOT NULL
                          CHECK (event_kind IN ('order', 'product', 'listing')),
    event_type            text        NOT NULL
                          CHECK (length(event_type) >= 1 AND length(event_type) <= 128),
    -- The frozen outcome vocabulary: 'ingested' (the first delivery —
    -- integration_event_ref/evidence_ref present) or 'duplicate-received'
    -- (a replay — the honest no-op record; duplicate_of present).
    outcome               text        NOT NULL
                          CHECK (outcome IN ('ingested', 'duplicate-received')),
    -- The provider's order/product/listing record id the event references
    -- (null when the event carries none).
    provider_record_id    text
                          CHECK (provider_record_id IS NULL
                                 OR (length(provider_record_id) >= 1
                                     AND length(provider_record_id) <= 256)),
    raw_event_hash        text        NOT NULL
                          CHECK (raw_event_hash ~ '^[a-f0-9]{64}$'),
    shape_version         text        NOT NULL
                          CHECK (length(shape_version) >= 1
                                 AND length(shape_version) <= 64),
    -- The delivered payload VERBATIM (§21-material-key-checked) and the
    -- ADAPTER-NORMALIZED event shape (attribution/reference fields carried
    -- VERBATIM as passthrough data — architecture §16; no linking,
    -- matching or causal computation anywhere in this layer).
    payload               jsonb       NOT NULL
                          CHECK (integration_event_payload_valid(payload)),
    normalized            jsonb       NOT NULL
                          CHECK (integration_event_payload_valid(normalized)),
    -- The composition with the existing event-stream path (AC-6): the
    -- raw-ledger row of the FIRST delivery + its derived evidence
    -- observation (both null on duplicate-received rows — a replay
    -- appends NOTHING to the raw ledger or evidence).
    integration_event_ref uuid        REFERENCES integration_events(event_id),
    evidence_ref          uuid,
    -- On duplicate-received rows: the ingested commerce event this replay
    -- matched (the fence's claim).
    duplicate_of          uuid        REFERENCES commerce_events(commerce_event_id),
    -- SERVER-DERIVED provenance (never request fields).
    recorded_actor        text        NOT NULL CHECK (length(recorded_actor) >= 1),
    recorded_via          text        NOT NULL CHECK (length(recorded_via) >= 1
                                        AND length(recorded_via) <= 100),
    correlation_id        text        NOT NULL,
    causation_id          text,
    received_at           timestamptz NOT NULL DEFAULT now(),
    -- The outcome wiring is one atomic fact: an ingested row references
    -- its raw-ledger row; a duplicate-received row references the
    -- ingested row it duplicated and claims no ledger row of its own.
    CONSTRAINT commerce_event_outcome_wiring CHECK (
        (outcome = 'ingested' AND integration_event_ref IS NOT NULL)
        OR (outcome = 'duplicate-received' AND integration_event_ref IS NULL
            AND duplicate_of IS NOT NULL)
    )
);

-- Listing surfaces: the Client's commerce event history (newest first by
-- the server-stamped receipt time) and the fence lookup path.
CREATE INDEX IF NOT EXISTS commerce_events_client_idx
    ON commerce_events (client_id, received_at, commerce_event_id);

CREATE INDEX IF NOT EXISTS commerce_events_provider_event_idx
    ON commerce_events (adapter_key, provider_event_id, outcome);

CREATE INDEX IF NOT EXISTS commerce_events_connection_idx
    ON commerce_events (connection_id, received_at);

-- APPEND-ONLY backstop (the migration 015/018/029 pattern): the database
-- itself rejects UPDATE and DELETE on the commerce event history — not
-- even server code can rewrite it.
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

-- TENANT/CONNECTION CONSISTENCY (the fence pattern, mirrored): the event's
-- client and adapter must match its integration connection row EXACTLY.
CREATE OR REPLACE FUNCTION commerce_event_connection_consistent() RETURNS trigger AS $$
DECLARE
    v_conn record;
BEGIN
    SELECT client_id, agency_id, adapter_key INTO v_conn
    FROM integration_connections WHERE connection_id = NEW.connection_id;
    IF v_conn IS NULL THEN
        RAISE EXCEPTION 'commerce event % references unknown integration connection %',
            NEW.commerce_event_id, NEW.connection_id;
    END IF;
    IF v_conn.client_id <> NEW.client_id OR v_conn.agency_id <> NEW.agency_id THEN
        RAISE EXCEPTION 'commerce event % connection % belongs to another client/agency — cross-tenant event projection is rejected',
            NEW.commerce_event_id, NEW.connection_id;
    END IF;
    IF v_conn.adapter_key <> NEW.adapter_key THEN
        RAISE EXCEPTION 'commerce event % adapter % does not match its connection adapter %',
            NEW.commerce_event_id, NEW.adapter_key, v_conn.adapter_key;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_event_connection_consistent_trigger ON commerce_events;
CREATE TRIGGER commerce_event_connection_consistent_trigger
    BEFORE INSERT ON commerce_events
    FOR EACH ROW EXECUTE FUNCTION commerce_event_connection_consistent();

-- ---------------------------------------------------------------------------
-- commerce_mutation_records — the append-only commerce mutation ledger
-- (the audit surface proving store mutations flow through Integrations)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS commerce_mutation_records (
    commerce_mutation_id  uuid        PRIMARY KEY,
    connection_id         uuid        NOT NULL REFERENCES integration_connections(connection_id),
    client_id             uuid        NOT NULL REFERENCES clients(client_id),
    agency_id             uuid        NOT NULL REFERENCES agencies(agency_id),
    adapter_key           text        NOT NULL
                          CHECK (adapter_key ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
    -- The frozen commerce MUTATION capability-key vocabulary (AC-4/AC-9):
    -- every recorded store mutation declares WHICH capability sanctioned
    -- it. Product writes and listing management are the only mutating
    -- commerce capabilities of the v1.6 surface.
    capability_key        text        NOT NULL
                          CHECK (capability_key IN ('commerce-product-write',
                                                    'commerce-listing-manage')),
    operation             text        NOT NULL
                          CHECK (length(operation) >= 1 AND length(operation) <= 64),
    -- The provider-visible outcome (the honest NormalizedMutationResult):
    -- the provider record id when the provider accepted the mutation, the
    -- bounded error when it refused (unauthorized/invalid-scope/rate-
    -- limited/provider-down are recorded here VERBATIM — never silenced).
    ok                    boolean     NOT NULL,
    provider_record_id    text
                          CHECK (provider_record_id IS NULL
                                 OR (length(provider_record_id) >= 1
                                     AND length(provider_record_id) <= 256)),
    error                 text
                          CHECK (error IS NULL OR (length(error) >= 1
                                 AND length(error) <= 2000)),
    -- The policy decision that gated the attempt (the network-dimension
    -- allow recorded by the /policies authority — the audit trail).
    policy_decision_id    text        NOT NULL
                          CHECK (length(policy_decision_id) >= 1),
    recorded_actor        text        NOT NULL CHECK (length(recorded_actor) >= 1),
    recorded_via          text        NOT NULL CHECK (length(recorded_via) >= 1
                                        AND length(recorded_via) <= 100),
    correlation_id        text        NOT NULL,
    causation_id          text,
    received_at           timestamptz NOT NULL DEFAULT now()
);

-- Listing surface: the Client's commerce mutation history (newest first).
CREATE INDEX IF NOT EXISTS commerce_mutation_records_client_idx
    ON commerce_mutation_records (client_id, received_at, commerce_mutation_id);

-- APPEND-ONLY backstop: a store-mutation record is a fact that can never
-- be rewritten or erased.
CREATE OR REPLACE FUNCTION commerce_mutation_records_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'commerce mutation records are append-only: % is rejected on commerce mutation %',
        TG_OP, OLD.commerce_mutation_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_mutation_records_append_only_update_trigger
    ON commerce_mutation_records;
CREATE TRIGGER commerce_mutation_records_append_only_update_trigger
    BEFORE UPDATE ON commerce_mutation_records
    FOR EACH ROW EXECUTE FUNCTION commerce_mutation_records_append_only();

DROP TRIGGER IF EXISTS commerce_mutation_records_append_only_delete_trigger
    ON commerce_mutation_records;
CREATE TRIGGER commerce_mutation_records_append_only_delete_trigger
    BEFORE DELETE ON commerce_mutation_records
    FOR EACH ROW EXECUTE FUNCTION commerce_mutation_records_append_only();

-- TENANT/CONNECTION CONSISTENCY (the same fence, mirrored).
CREATE OR REPLACE FUNCTION commerce_mutation_connection_consistent() RETURNS trigger AS $$
DECLARE
    v_conn record;
BEGIN
    SELECT client_id, agency_id, adapter_key INTO v_conn
    FROM integration_connections WHERE connection_id = NEW.connection_id;
    IF v_conn IS NULL THEN
        RAISE EXCEPTION 'commerce mutation record % references unknown integration connection %',
            NEW.commerce_mutation_id, NEW.connection_id;
    END IF;
    IF v_conn.client_id <> NEW.client_id OR v_conn.agency_id <> NEW.agency_id THEN
        RAISE EXCEPTION 'commerce mutation record % connection % belongs to another client/agency — cross-tenant mutation records are rejected',
            NEW.commerce_mutation_id, NEW.connection_id;
    END IF;
    IF v_conn.adapter_key <> NEW.adapter_key THEN
        RAISE EXCEPTION 'commerce mutation record % adapter % does not match its connection adapter %',
            NEW.commerce_mutation_id, NEW.adapter_key, v_conn.adapter_key;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_mutation_connection_consistent_trigger
    ON commerce_mutation_records;
CREATE TRIGGER commerce_mutation_connection_consistent_trigger
    BEFORE INSERT ON commerce_mutation_records
    FOR EACH ROW EXECUTE FUNCTION commerce_mutation_connection_consistent();
