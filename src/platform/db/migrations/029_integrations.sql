-- MKT-023 Provider integration boundary schema (INT-001 — generic
-- integration ports + first-party adapter mechanism for marketing data
-- providers). PostgreSQL is the system of record (spec/architecture-lock.md).
--
-- Table ownership follows the frozen authority map (implementation-contract
-- §1): "Integrations → /integrations" — BOTH tables here:
--   integration_connections → the connection/capability METADATA records
--   integration_events      → the append-only webhook/event ingestion ledger
--
-- Frozen semantics encoded here (spec/requirements.md INT-001 "Provide
-- provider-neutral integration interfaces for marketing/CRM/CMS/data
-- systems"; spec/implementation-contract.md §20 "An integration adapter owns
-- provider-specific API/SDK details. Core domains exchange normalized
-- contracts only. The integration boundary must support: connection
-- lifecycle; capability discovery; read operations; mutation operations;
-- webhook/event ingestion; rate-limit/backoff metadata; provider
-- identifiers; source timestamp/ETag/version where available";
-- spec/architecture.md §20 "No provider is the system of record for
-- MarketingOS workflow, deployment, evidence, policy or execution state";
-- §23 "External events are validated, durably persisted, queued and handled
-- idempotently"; implementation-contract §21 credential contract):
--
-- * THE CONNECTION RECORD IS EXACTLY CAPABILITY METADATA: identity, Client
--   ownership (agency derived through the /clients chain), the adapter key
--   + provider label (REGISTRY DATA — the adapter set is injected module
--   dependencies, never a hardcoded provider list), the credential
--   REFERENCE (the /credentials logical-name id — NEVER material), the
--   non-secret provider configuration, the lifecycle status + health, the
--   latest normalized rate-limit/backoff state and the last error. There
--   is deliberately NO workflow/deployment/evidence/policy/execution state
--   in either table (architecture.md §20 — no system of record), NO
--   provider session/cursor columns and NO capability-discovery columns
--   (capabilities are ADAPTER-DECLARED, surfaced through the module's
--   registry view — the database never stores the adapter set).
-- * THE FROZEN CONNECTION LIFECYCLE (implementation-contract §20 "connection
--   lifecycle"): registered (born) → connected | suspended | error;
--   connected → suspended | error; error → connected | suspended;
--   suspended → connected. There is NO terminal state — a connection is
--   operational plumbing, not history, and can always be reconnected. The
--   status CLOSED set is CHECKed and the transition table is enforced by
--   a trigger BACKSTOP (the application module owns the same table; the
--   database rejects any illegal edge even if every application check were
--   bypassed). Same-status updates are legal: they are health/rate-limit
--   bookkeeping, not transitions.
-- * IDENTITY/CONTENT IMMUTABILITY: client ownership, agency, adapter key,
--   provider label, credential reference, provider config, created_by and
--   created_at can NEVER be reassigned through ANY ordinary mutation path
--   (trigger) — only the lifecycle columns (status, health, rate_limit,
--   last_error, last_checked_at) plus the CAS version and updated_at ever
--   change. A connection can never cross the Client boundary, swap its
--   adapter, or re-bind to a different credential reference in place.
-- * THE DUPLICATE-REGISTRATION FENCE (implementation-contract §3/§25):
--   exactly one connection per (client, adapter, credential reference) —
--   concurrent duplicate registrations converge to a constraint violation,
--   never a silent second pipe.
-- * CLIENT OWNERSHIP (TENANT-003 hard boundary): client_id is NOT NULL and
--   immutable; the database itself rejects a client/agency mismatch
--   (trigger) AND a credential reference outside the connection's owning
--   chain (same agency; client-narrowed references must match the
--   connection's Client — trigger), so the Client boundary cannot be
--   crossed through the connection columns or the credential column even
--   if every application check were bypassed.
-- * EVENTS ARE APPEND-ONLY (architecture.md §23 "validated, durably
--   persisted"): the ingestion ledger records one immutable row per
--   verified delivery with SERVER-DERIVED provenance
--   (recorded_actor/recorded_via/correlation_id/causation_id +
--   received_at stamped by the module clock — implementation-contract §3:
--   no externally supplied field may override a server-derived actor,
--   owner or provenance value). UPDATE and DELETE are rejected by triggers
--   (the migration 015/018/025 pattern). There is deliberately NO
--   rewrite, NO dedupe key and NO delivery-status column: the ledger is
--   the raw append-only ingestion history; an unverified delivery writes
--   NOTHING (the module rejects it before any insert).
-- * EVIDENCE LINKAGE: a verified event MAY carry evidence_ref (the derived
--   'source_fact' /evidence observation appended through /evidence's own
--   public contract — class/quality/provenance pinned server-side, never
--   caller-suppliable). The database rejects a reference to another
--   Client's evidence (trigger — the migration 018 pattern); /integrations
--   imports no evidence internals, this is the only structural coupling.
-- * NO SECRET MATERIAL (implementation-contract §21: "Domain records store
--   credential references, never secret material"): provider_config and
--   event payloads are CHECKed against material-shaped keys at every
--   nesting level (function backstop) — nothing secret can enter any
--   integration record through ANY write path. The rate_limit shape is
--   similarly closed (the normalized four-field contract).
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, created_at/updated_at, version CAS for concurrent mutation.
-- No owner/role/user columns beyond provenance: connection administration
-- and event-read authorization stays exactly the /agencies membership
-- authority composed with canonical /clients owner resolution — no second
-- tenant, permission, workflow, execution or deployment authority.

-- ---------------------------------------------------------------------------
-- integration_connections — the connection/capability metadata records
-- ---------------------------------------------------------------------------

-- The material-shape validator (IMMUTABLE so it can serve CHECK
-- constraints): rejects material-shaped keys at every nesting level of a
-- stored integration payload — the storage-side half of the §21
-- credential-by-logical-name contract (the migration 025
-- policy_payload_has_no_material_keys pattern).
CREATE OR REPLACE FUNCTION integration_payload_has_no_material_keys(payload jsonb)
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
            IF NOT integration_payload_has_no_material_keys(elem) THEN
                RETURN false;
            END IF;
        END LOOP;
    ELSIF jsonb_typeof(payload) = 'array' THEN
        FOR elem IN SELECT a.value FROM jsonb_array_elements(payload) a LOOP
            IF NOT integration_payload_has_no_material_keys(elem) THEN
                RETURN false;
            END IF;
        END LOOP;
    END IF;
    RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- The provider-config shape validator (IMMUTABLE): a bounded object of
-- string key → string value with NO material-shaped key anywhere — the
-- connection's non-secret configuration channel (bounded like the module
-- guard: at most 32 keys, keys 1..128, values 1..512).
CREATE OR REPLACE FUNCTION integration_provider_config_valid(config jsonb)
RETURNS boolean AS $$
DECLARE
    key text;
    value jsonb;
    key_count integer := 0;
BEGIN
    IF jsonb_typeof(config) <> 'object' THEN
        RETURN false;
    END IF;
    FOR key, value IN SELECT * FROM jsonb_each(config) LOOP
        key_count := key_count + 1;
        IF length(key) < 1 OR length(key) > 128 THEN
            RETURN false;
        END IF;
        IF jsonb_typeof(value) <> 'string' THEN
            RETURN false;
        END IF;
        IF length(value #>> '{}') < 1 OR length(value #>> '{}') > 512 THEN
            RETURN false;
        END IF;
    END LOOP;
    IF key_count > 32 THEN
        RETURN false;
    END IF;
    RETURN integration_payload_has_no_material_keys(config);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- The rate-limit shape validator (IMMUTABLE): null, or an object whose
-- keys are exactly the closed normalized contract (limitRemaining,
-- limitResetAt, backoffUntil, retryAfterSeconds) with correctly typed
-- values — the §20 "rate-limit/backoff metadata" storage backstop.
CREATE OR REPLACE FUNCTION integration_rate_limit_valid(rate_limit jsonb)
RETURNS boolean AS $$
DECLARE
    key text;
    value jsonb;
    seen integer := 0;
BEGIN
    IF rate_limit IS NULL THEN
        RETURN true;
    END IF;
    IF jsonb_typeof(rate_limit) <> 'object' THEN
        RETURN false;
    END IF;
    FOR key, value IN SELECT * FROM jsonb_each(rate_limit) LOOP
        seen := seen + 1;
        CASE key
            WHEN 'limitRemaining' THEN
                IF jsonb_typeof(value) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
            WHEN 'limitResetAt', 'backoffUntil' THEN
                IF jsonb_typeof(value) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
            WHEN 'retryAfterSeconds' THEN
                IF jsonb_typeof(value) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
            ELSE
                RETURN false;
        END CASE;
    END LOOP;
    IF seen > 4 THEN
        RETURN false;
    END IF;
    RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- The event-payload shape validator (IMMUTABLE): a non-empty bounded
-- object with NO material-shaped key at any nesting level (§21 — provider
-- payloads ride in as data, never as a secret channel; bounded like the
-- module guard: at most 64 top-level keys).
CREATE OR REPLACE FUNCTION integration_event_payload_valid(payload jsonb)
RETURNS boolean AS $$
BEGIN
    IF jsonb_typeof(payload) <> 'object' THEN
        RETURN false;
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(payload)) < 1 THEN
        RETURN false;
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(payload)) > 64 THEN
        RETURN false;
    END IF;
    RETURN integration_payload_has_no_material_keys(payload);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE TABLE IF NOT EXISTS integration_connections (
    connection_id          uuid        PRIMARY KEY,
    client_id              uuid        NOT NULL REFERENCES clients(client_id),
    agency_id              uuid        NOT NULL REFERENCES agencies(agency_id),
    adapter_key            text        NOT NULL CHECK (adapter_key ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
    provider_label         text        NOT NULL CHECK (length(provider_label) >= 1
                                              AND length(provider_label) <= 100),
    status                 text        NOT NULL DEFAULT 'registered'
                                              CHECK (status IN ('registered', 'connected',
                                                       'suspended', 'error')),
    health                 text        NOT NULL DEFAULT 'unknown'
                                              CHECK (health IN ('unknown', 'healthy',
                                                       'degraded', 'unreachable')),
    credential_reference_id uuid       NOT NULL REFERENCES credential_references(credential_id),
    provider_config        jsonb       NOT NULL DEFAULT '{}'::jsonb
                                              CHECK (integration_provider_config_valid(provider_config)),
    rate_limit             jsonb       CHECK (integration_rate_limit_valid(rate_limit)),
    last_error             text        CHECK (last_error IS NULL
                                              OR (length(last_error) >= 1
                                              AND length(last_error) <= 2000)),
    last_checked_at        timestamptz,
    created_by             uuid        REFERENCES users(user_id),
    version                bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);

-- The duplicate-registration fence (implementation-contract §3/§25): one
-- pipe per (client, adapter, credential reference) — concurrent duplicate
-- registrations converge to a constraint violation (ConflictError in the
-- module), never a silent second pipe.
CREATE UNIQUE INDEX IF NOT EXISTS integration_connections_client_adapter_credential_fence
ON integration_connections (client_id, adapter_key, credential_reference_id);

-- Listing surface: one Client's connections (newest first — the module's
-- bounded list reads this order).
CREATE INDEX IF NOT EXISTS integration_connections_client_idx
ON integration_connections (client_id, created_at, connection_id);

-- Registry/adapter operational lookup: the connections of one adapter key
-- (deployment/registry reasoning; never a provider branch in code — the
-- adapter key is DATA on every row).
CREATE INDEX IF NOT EXISTS integration_connections_adapter_idx
ON integration_connections (adapter_key);

-- Tenant fence (TENANT-003 at the storage layer, migration 003/018
-- pattern): the connection's Client must belong to its Agency — the Client
-- boundary cannot be crossed through the connection columns even if every
-- application check were bypassed.
CREATE OR REPLACE FUNCTION integration_connection_client_within_agency() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM clients c
        WHERE c.client_id = NEW.client_id AND c.agency_id = NEW.agency_id) THEN
        RAISE EXCEPTION 'integration connection % client % does not belong to agency % — the Client boundary cannot be crossed',
            NEW.connection_id, NEW.client_id, NEW.agency_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS integration_connection_client_within_agency_trigger ON integration_connections;
CREATE TRIGGER integration_connection_client_within_agency_trigger
BEFORE INSERT OR UPDATE ON integration_connections
FOR EACH ROW EXECUTE FUNCTION integration_connection_client_within_agency();

-- Credential-scope fence (§21 storage backstop): the connection's
-- credential reference must resolve INSIDE the connection's owning chain —
-- same Agency, and a Client-narrowed reference must match the connection's
-- Client exactly. The reference is the /credentials LOGICAL NAME identity;
-- nothing here ever sees material.
CREATE OR REPLACE FUNCTION integration_connection_credential_in_scope() RETURNS trigger AS $$
DECLARE
    v_cred record;
BEGIN
    SELECT agency_id, client_id INTO v_cred
    FROM credential_references WHERE credential_id = NEW.credential_reference_id;
    IF v_cred IS NULL THEN
        RAISE EXCEPTION 'integration connection % references unknown credential reference %',
            NEW.connection_id, NEW.credential_reference_id;
    END IF;
    IF v_cred.agency_id <> NEW.agency_id THEN
        RAISE EXCEPTION 'integration connection % credential reference % belongs to another agency — cross-tenant credential use is rejected',
            NEW.connection_id, NEW.credential_reference_id;
    END IF;
    IF v_cred.client_id IS NOT NULL AND v_cred.client_id <> NEW.client_id THEN
        RAISE EXCEPTION 'integration connection % credential reference % is narrowed to another client — scope-mismatched credential use is rejected',
            NEW.connection_id, NEW.credential_reference_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS integration_connection_credential_in_scope_trigger ON integration_connections;
CREATE TRIGGER integration_connection_credential_in_scope_trigger
BEFORE INSERT OR UPDATE OF credential_reference_id, client_id, agency_id ON integration_connections
FOR EACH ROW EXECUTE FUNCTION integration_connection_credential_in_scope();

-- Identity/content immutability (the 005 credential_references pattern):
-- the connection's identity, ownership, adapter, provider label, credential
-- reference, provider config and creation provenance can NEVER be
-- reassigned through ANY ordinary mutation path — only the lifecycle
-- columns (status, health, rate_limit, last_error, last_checked_at), the
-- CAS version and updated_at ever change.
CREATE OR REPLACE FUNCTION integration_connections_identity_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW.connection_id <> OLD.connection_id THEN
        RAISE EXCEPTION 'connection_id % is immutable', OLD.connection_id;
    END IF;
    IF NEW.client_id <> OLD.client_id THEN
        RAISE EXCEPTION 'integration connection % cannot change Client ownership (was client %)',
            OLD.connection_id, OLD.client_id;
    END IF;
    IF NEW.agency_id <> OLD.agency_id THEN
        RAISE EXCEPTION 'integration connection % cannot change Agency ownership (was agency %)',
            OLD.connection_id, OLD.agency_id;
    END IF;
    IF NEW.adapter_key <> OLD.adapter_key THEN
        RAISE EXCEPTION 'integration connection % cannot change its adapter (was adapter %)',
            OLD.connection_id, OLD.adapter_key;
    END IF;
    IF NEW.provider_label <> OLD.provider_label THEN
        RAISE EXCEPTION 'integration connection % cannot change its provider label (was %)',
            OLD.connection_id, OLD.provider_label;
    END IF;
    IF NEW.credential_reference_id <> OLD.credential_reference_id THEN
        RAISE EXCEPTION 'integration connection % cannot re-bind its credential reference (was %)',
            OLD.connection_id, OLD.credential_reference_id;
    END IF;
    IF NEW.provider_config IS DISTINCT FROM OLD.provider_config THEN
        RAISE EXCEPTION 'integration connection % provider config is immutable',
            OLD.connection_id;
    END IF;
    IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'integration connection % creation provenance is immutable',
            OLD.connection_id;
    END IF;
    IF NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'integration connection % created_at is immutable',
            OLD.connection_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS integration_connections_identity_immutable_trigger ON integration_connections;
CREATE TRIGGER integration_connections_identity_immutable_trigger
BEFORE UPDATE ON integration_connections
FOR EACH ROW EXECUTE FUNCTION integration_connections_identity_immutable();

-- The frozen lifecycle transition table (implementation-contract §20
-- "connection lifecycle"), enforced at the storage layer as the race
-- backstop: registered → connected|suspended|error; connected →
-- suspended|error; error → connected|suspended; suspended → connected. A
-- same-status update is legal (health/rate-limit bookkeeping, not a
-- transition). There is deliberately NO terminal edge and NO delete path:
-- a connection is operational plumbing, not history.
CREATE OR REPLACE FUNCTION integration_connection_transition_legal() RETURNS trigger AS $$
DECLARE
    v_legal text[];
BEGIN
    IF NEW.status = OLD.status THEN
        RETURN NEW;
    END IF;
    CASE OLD.status
        WHEN 'registered' THEN v_legal := ARRAY['connected', 'suspended', 'error'];
        WHEN 'connected'  THEN v_legal := ARRAY['suspended', 'error'];
        WHEN 'error'      THEN v_legal := ARRAY['connected', 'suspended'];
        WHEN 'suspended'  THEN v_legal := ARRAY['connected'];
        ELSE
            RAISE EXCEPTION 'unknown prior status % on integration connection %',
                OLD.status, OLD.connection_id;
    END CASE;
    IF NOT (NEW.status = ANY(v_legal)) THEN
        RAISE EXCEPTION 'illegal integration connection transition % -> % on connection %',
            OLD.status, NEW.status, OLD.connection_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS integration_connection_transition_legal_trigger ON integration_connections;
CREATE TRIGGER integration_connection_transition_legal_trigger
BEFORE UPDATE OF status ON integration_connections
FOR EACH ROW EXECUTE FUNCTION integration_connection_transition_legal();

-- ---------------------------------------------------------------------------
-- integration_events — the append-only webhook/event ingestion ledger
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS integration_events (
    event_id        uuid        PRIMARY KEY,
    connection_id   uuid        NOT NULL REFERENCES integration_connections(connection_id),
    client_id       uuid        NOT NULL REFERENCES clients(client_id),
    adapter_key     text        NOT NULL CHECK (adapter_key ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
    event_type      text        NOT NULL CHECK (length(event_type) >= 1
                                        AND length(event_type) <= 128),
    payload         jsonb       NOT NULL
                                        CHECK (integration_event_payload_valid(payload)),
    evidence_ref    uuid        REFERENCES evidence(evidence_id),
    recorded_actor  text        NOT NULL CHECK (length(recorded_actor) >= 1),
    recorded_via    text        NOT NULL CHECK (length(recorded_via) >= 1
                                        AND length(recorded_via) <= 100),
    correlation_id  text        NOT NULL,
    causation_id    text,
    received_at     timestamptz NOT NULL DEFAULT now()
);

-- Listing surfaces: one Client's ingested events (newest first by the
-- server-stamped receipt time) and one connection's event stream.
CREATE INDEX IF NOT EXISTS integration_events_client_idx
ON integration_events (client_id, received_at, event_id);

CREATE INDEX IF NOT EXISTS integration_events_connection_idx
ON integration_events (connection_id, received_at, event_id);

-- APPEND-ONLY backstop (the migration 015/018/025 pattern): the database
-- itself rejects UPDATE and DELETE on ingested events. Not even server
-- code can rewrite the ingestion ledger — the raw provider-event history
-- is durable exactly as recorded (architecture.md §23).
CREATE OR REPLACE FUNCTION integration_events_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'integration events are append-only: % is rejected on integration_event %',
        TG_OP, OLD.event_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS integration_events_append_only_update_trigger ON integration_events;
CREATE TRIGGER integration_events_append_only_update_trigger
BEFORE UPDATE ON integration_events
FOR EACH ROW EXECUTE FUNCTION integration_events_append_only();

DROP TRIGGER IF EXISTS integration_events_append_only_delete_trigger ON integration_events;
CREATE TRIGGER integration_events_append_only_delete_trigger
BEFORE DELETE ON integration_events
FOR EACH ROW EXECUTE FUNCTION integration_events_append_only();

-- Connection-consistency backstop: the event's client and adapter columns
-- must match its connection row EXACTLY — the denormalized columns are
-- server-derived from the connection on the only write path; a mismatched
-- smuggle is rejected here even if every application check were bypassed.
CREATE OR REPLACE FUNCTION integration_event_connection_consistent() RETURNS trigger AS $$
DECLARE
    v_conn record;
BEGIN
    SELECT client_id, adapter_key INTO v_conn
    FROM integration_connections WHERE connection_id = NEW.connection_id;
    IF v_conn IS NULL THEN
        RAISE EXCEPTION 'integration event % references unknown connection %',
            NEW.event_id, NEW.connection_id;
    END IF;
    IF v_conn.client_id <> NEW.client_id THEN
        RAISE EXCEPTION 'integration event % connection % belongs to another client — cross-tenant event ingestion is rejected',
            NEW.event_id, NEW.connection_id;
    END IF;
    IF v_conn.adapter_key <> NEW.adapter_key THEN
        RAISE EXCEPTION 'integration event % adapter % does not match its connection adapter %',
            NEW.event_id, NEW.adapter_key, v_conn.adapter_key;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS integration_event_connection_consistent_trigger ON integration_events;
CREATE TRIGGER integration_event_connection_consistent_trigger
BEFORE INSERT ON integration_events
FOR EACH ROW EXECUTE FUNCTION integration_event_connection_consistent();

-- Evidence-linkage backstop (cross-tenant rejection, migration 018
-- pattern): a verified event's evidence_ref must be an /evidence record
-- of the SAME Client — the derived 'source_fact' observation flows through
-- /evidence's own public contract and stays tenant-fenced even when the
-- ingestion ledger links to it.
CREATE OR REPLACE FUNCTION integration_event_evidence_ref_same_client() RETURNS trigger AS $$
DECLARE
    v_evidence_client uuid;
BEGIN
    IF NEW.evidence_ref IS NOT NULL THEN
        SELECT client_id INTO v_evidence_client FROM evidence WHERE evidence_id = NEW.evidence_ref;
        IF v_evidence_client IS NULL THEN
            RAISE EXCEPTION 'integration event % references unknown evidence %',
                NEW.event_id, NEW.evidence_ref;
        END IF;
        IF v_evidence_client <> NEW.client_id THEN
            RAISE EXCEPTION 'integration event % evidence_ref % belongs to another client — cross-tenant evidence linkage is rejected',
                NEW.event_id, NEW.evidence_ref;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS integration_event_evidence_ref_same_client_trigger ON integration_events;
CREATE TRIGGER integration_event_evidence_ref_same_client_trigger
BEFORE INSERT ON integration_events
FOR EACH ROW EXECUTE FUNCTION integration_event_evidence_ref_same_client();
