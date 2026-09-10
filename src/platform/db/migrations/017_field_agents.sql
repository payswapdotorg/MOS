-- MKT-025 Human Agent / Field Agent profile schema (FIELD-001 + HUMAN-001,
-- spec/human-agent-v1.3.md, spec/work-item-v1.3-overrides.md "MKT-025 —
-- Human Agent foundation").
-- PostgreSQL is the system of record (spec/architecture-lock.md).
--
-- Table ownership follows the frozen authority map (implementation-contract §1):
--   human_agents → /field-agents (Field-agent identity/availability — the
--                  GENERIC HUMAN AGENT authority per spec/module-dependency-v1.3.md:
--                  "/human-agents is represented by the existing /field-agents
--                  authority generalized according to spec/human-agent-v1.3.md;
--                  a second human-execution module is forbidden")
--
-- Frozen semantics encoded here (spec/human-agent-v1.3.md §1, HUMAN-AC-01):
--   * a Human Agent is a PLATFORM IDENTITY linked to exactly one stable user
--     (user_id, immutable, unique): the table carries NO agency_id/client_id/
--     workspace_id columns — a Human Agent is NOT a tenant and owns no Client
--     data by eligibility (human-agent-v1.3 §1). Agency linkage exists ONLY
--     through the existing agency_memberships authority (role 'human_agent',
--     MKT-002) — there is no second linkage column here;
--   * specializations are CAPABILITY METADATA (v1.3 §2: "A specialization is
--     capability metadata, not a second execution model"): a non-empty unique
--     subset of the frozen registry, DB-fenced by CHECK (subset) + trigger
--     (uniqueness). Field Agent is the specialization with location/territory
--     and in-person execution — the DB requires declared geography
--     (location OR ≥1 territory) whenever 'field_agent' is declared
--     (FIELD-AC-01 backstop);
--   * capabilities/skills, availability windows, optional location and
--     territories, relationship-continuity preferences and authorization/
--     contract state are the HUMAN-AC-01 profile shape: jsonb arrays/objects
--     with TYPE and CARDINALITY fences; item shape is validated in the
--     module (single-sourced with the pure public validator);
--   * reliability/quality signals are SERVER-DERIVED aggregates stored on the
--     profile (jsonb object, initialized to zero counters). They are updated
--     ONLY through the server-side module API — never a route, never a
--     caller-supplied field (§23 authority rule);
--   * authorization_state is the frozen active/suspended/contract_ended
--     lifecycle; 'contract_ended' is TERMINAL (DB trigger + code transition
--     table) — contract history can never be rewritten;
--   * NO Job/Task/Execution state lives here: no job/offer/acceptance/
--     dispatch columns, tables or triggers (HUMAN-AC-02 — the Job authority
--     is /jobs, MKT-026). This migration creates exactly ONE table;
--   * provenance (created_by/created_at) is immutable history; every mutable
--     row carries a version CAS token (implementation-contract §3, §25).
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers (uuid), created_at/updated_at, version CAS for concurrent
-- mutation, DB-fenced uniqueness (one profile per platform user — duplicate
-- convergence under concurrent creation is rejected by the database itself).

CREATE TABLE IF NOT EXISTS human_agents (
    agent_id     uuid        PRIMARY KEY,
    user_id      uuid        NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    specializations text[]   NOT NULL,
    capabilities jsonb       NOT NULL,
    availability jsonb       NOT NULL,
    location     jsonb,
    territories  jsonb       NOT NULL,
    reliability  jsonb       NOT NULL,
    relationship_continuity jsonb NOT NULL,
    authorization_state text NOT NULL DEFAULT 'active'
                 CHECK (authorization_state IN ('active', 'suspended', 'contract_ended')),
    created_by   uuid        REFERENCES users(user_id),
    version      bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),

    -- Specializations are a non-empty (1..8) subset of the frozen registry
    -- (mirrors HUMAN_SPECIALIZATIONS in src/modules/field-agents/public.ts;
    -- tests/architecture/field-agents-boundary.test.ts fails if they drift).
    CHECK (
        cardinality(specializations) BETWEEN 1 AND 8
        AND specializations <@ ARRAY[
            'field_agent', 'chatter', 'creator_manager', 'content_manager',
            'growth_manager', 'account_manager', 'reviewer', 'sales_agent'
        ]::text[]
    ),
    -- Capability/skill list: non-empty jsonb array (item shape validated in
    -- the module — single-sourced with the pure public validator).
    CHECK (jsonb_typeof(capabilities) = 'array' AND jsonb_array_length(capabilities) BETWEEN 1 AND 50),
    -- Availability windows: non-empty jsonb array (an agent always declares
    -- when it is available; going fully unavailable is authorization_state).
    CHECK (jsonb_typeof(availability) = 'array' AND jsonb_array_length(availability) BETWEEN 1 AND 100),
    -- Optional current location: null or a strict {kind, value} territory object.
    CHECK (
        location IS NULL
        OR (
            jsonb_typeof(location) = 'object'
            AND jsonb_typeof(location->'kind') = 'string'
            AND jsonb_typeof(location->'value') = 'string'
        )
    ),
    -- Optional service territories: empty..50 strict territory objects
    -- (human-agent-v1.3 §1: "optional geography/territories").
    CHECK (jsonb_typeof(territories) = 'array' AND jsonb_array_length(territories) BETWEEN 0 AND 50),
    -- Server-derived reliability/quality signal aggregate (jsonb object).
    CHECK (jsonb_typeof(reliability) = 'object'),
    -- Relationship-continuity preferences (jsonb object).
    CHECK (jsonb_typeof(relationship_continuity) = 'object'),
    -- FIELD-AC-01 backstop: the Field Agent specialization (in-person
    -- execution) requires declared geography — a current location OR at
    -- least one service territory.
    CHECK (
        NOT ('field_agent' = ANY(specializations))
        OR location IS NOT NULL
        OR jsonb_array_length(territories) >= 1
    )
);

-- ONE Human Agent profile per platform user (frozen identity link): the
-- database rejects duplicate profiles for the same user under concurrent
-- creation (duplicate convergence fails closed here, not only in code).
CREATE UNIQUE INDEX IF NOT EXISTS human_agents_user_key ON human_agents (user_id);

-- Eligibility scan surface: active-authorization profiles addressed by the
-- linked platform user (the candidate pool the /jobs authority (MKT-026)
-- will resolve from agency memberships).
CREATE INDEX IF NOT EXISTS human_agents_active_idx
    ON human_agents (user_id) WHERE authorization_state = 'active';

-- Specialization uniqueness backstop (CHECK constraints cannot contain
-- subqueries, so the duplicate fence is this trigger): specializations are
-- a SET of capability tags, never a multiset.
CREATE OR REPLACE FUNCTION human_agents_specializations_unique() RETURNS trigger AS $$
DECLARE
    distinct_count int;
BEGIN
    SELECT count(DISTINCT s) INTO distinct_count FROM unnest(NEW.specializations) AS s;
    IF distinct_count <> cardinality(NEW.specializations) THEN
        RAISE EXCEPTION 'human agent % specializations must be unique', NEW.agent_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS human_agents_specializations_unique_trigger ON human_agents;
CREATE TRIGGER human_agents_specializations_unique_trigger
    BEFORE INSERT OR UPDATE ON human_agents
    FOR EACH ROW EXECUTE FUNCTION human_agents_specializations_unique();

-- Immutability backstop: agent identity, the platform identity link and
-- provenance can NEVER be reassigned through ANY ordinary mutation path —
-- a Human Agent profile can never become another user's profile.
CREATE OR REPLACE FUNCTION human_agents_identity_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW.agent_id <> OLD.agent_id THEN
        RAISE EXCEPTION 'agent_id % is immutable', OLD.agent_id;
    END IF;
    IF NEW.user_id <> OLD.user_id THEN
        RAISE EXCEPTION 'human agent % cannot change its platform identity link (was user %)',
            OLD.agent_id, OLD.user_id;
    END IF;
    IF NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'human agent % provenance is immutable', OLD.agent_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS human_agents_identity_immutable_trigger ON human_agents;
CREATE TRIGGER human_agents_identity_immutable_trigger
    BEFORE UPDATE ON human_agents
    FOR EACH ROW EXECUTE FUNCTION human_agents_identity_immutable();

-- Lifecycle backstop: a contract-ended Human Agent is terminal history; it
-- can never silently come back to life via UPDATE (the platform must create
-- a NEW profile/contract relationship through the sanctioned flow).
CREATE OR REPLACE FUNCTION human_agents_contract_ended_terminal() RETURNS trigger AS $$
BEGIN
    IF OLD.authorization_state = 'contract_ended' AND NEW.authorization_state <> 'contract_ended' THEN
        RAISE EXCEPTION 'human agent % contract is ended and terminal', OLD.agent_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS human_agents_contract_ended_terminal_trigger ON human_agents;
CREATE TRIGGER human_agents_contract_ended_terminal_trigger
    BEFORE UPDATE ON human_agents
    FOR EACH ROW EXECUTE FUNCTION human_agents_contract_ended_terminal();
