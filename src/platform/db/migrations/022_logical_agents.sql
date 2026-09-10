-- MKT-020 Logical Agent/Capability contracts schema (AGENT-001).
-- PostgreSQL is the system of record (spec/architecture-lock.md).
--
-- Table ownership follows the frozen authority map (implementation-contract
-- §1): "Logical agents/capabilities → /agents". This migration delivers the
-- LOGICAL AGENT REGISTRY only (work-items.md MKT-020: "implement reusable
-- logical Agent/Capability contracts without infrastructure coupling";
-- requirements AGENT-001; acceptance "provider-neutral capability tests"):
--
--   * logical_agents — the REUSABLE CAPABILITY DECLARATION records
--                      (architecture.md §12: "Agent is a logical reusable
--                      capability. It does not own tenant data, workflow
--                      state, deployment state or infrastructure"):
--                        - identity: server-generated agent_id + the
--                          reusable logical name (agent_key) + the declared
--                          contract version label (version_label) — the
--                          stable identity triple of one declaration;
--                        - declared capabilities: a JSON array of
--                          provider-neutral capability descriptors
--                          ({ capabilityKind, parameters }) — WHAT the
--                          agent can do, expressed as normalized labels +
--                          bounded parameter contracts. NO provider/model
--                          identifiers, NO SDK references, NO credentials
--                          and NO infrastructure coupling can be stored:
--                          the descriptor shape is DB-CHECKed (exactly the
--                          two keys) and there is deliberately NO column
--                          capable of holding provider, model, sandbox,
--                          pool, queue, runtime, deployment, execution,
--                          workflow, client, workspace or goal references
--                          (the AC static tests prove the column set);
--                        - scope: agency_id is the server-derived ownership
--                          — NULL = PLATFORM scope (a platform-normalized
--                          reusable declaration, the /ai-runtime
--                          model-registry posture), set = the owning AGENCY
--                          (tenant-runtime-model.md ownership matrix row
--                          "Agent | Platform/Agency/Client scope | logical
--                          capability"; MKT-020 delivers the Platform and
--                          Agency modes — the frozen MKT-020 acceptance
--                          criteria explicitly forbid client/workspace
--                          tables here, so Client-scoped declarations are
--                          NOT in this Work Item). Scope is IMMUTABLE once
--                          set (trigger);
--                        - lifecycle: status is the single edge
--                          active → retired with `retired` TERMINAL (a
--                          retired declaration is a tombstone: history
--                          stays readable, corrections register a NEW
--                          declaration). Only status, version (the CAS
--                          token) and updated_at ever change — the full
--                          declared contract is immutable (trigger);
--                        - provenance: created_by/created_at are immutable
--                          server-derived history; §8-style idempotency
--                          identity (idempotency_key + create_fingerprint)
--                          makes the logical register command converge.
--
--   * logical_agent_lifecycle_events — the APPEND-ONLY lifecycle history
--                      ("register/retire — append-oriented where history
--                      matters"): one immutable row per applied lifecycle
--                      transition, with the transition pair, the reason and
--                      the provenance. The table rejects UPDATE and DELETE
--                      (trigger), (agent_id, transition) is UNIQUE-fenced
--                      (there is exactly ONE registered event and at most
--                      ONE retired event per declaration — "no second
--                      retirement" is a database invariant), and a
--                      consistency trigger rejects any event that does not
--                      match the agent row's current status.
--
-- Fences (implementation-contract §3/§25 — database backstops for material
-- invariants):
--   - the §8-style LOGICAL COMMAND fences: one idempotency key identifies
--     one logical register command PER SCOPE — a duplicate of the same
--     command (same create fingerprint) converges to the existing row; a
--     key reused for a DIFFERENT command is a conflict. Because platform
--     scope is stored as agency_id NULL (and NULLs are distinct in unique
--     indexes), the fence is split per scope mode;
--   - the ACTIVE DECLARATION fences: one ACTIVE declaration per
--     (scope, agent_key) — concurrent duplicate registrations converge to
--     exactly one winner; retirement frees the key for a NEW identity (the
--     append-oriented versioning path: corrections retire + re-register);
--   - the descriptor shape CHECK: every stored capability descriptor is
--     EXACTLY { capabilityKind: string, parameters: object } — a
--     provider-shaped descriptor can never be persisted, even by direct
--     SQL;
--   - content immutability + retired-terminal + scope immutability +
--     provenance immutability triggers on logical_agents;
--   - append-only + legality + consistency + once-per-transition fences on
--     logical_agent_lifecycle_events.
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, created_at/updated_at, version CAS for concurrent mutation.
-- No owner/role/user columns beyond provenance: logical Agent authorization
-- stays exactly the /agencies membership authority composed with canonical
-- owner resolution — no second tenant, permission, workflow, execution or
-- deployment authority. No execution/task/workflow/deployment/extension/
-- human-agent tables: those belong to /executions, /workflows, /deployments,
-- /extensions and the MKT-025+ scope (deliberately absent here).

-- ---------------------------------------------------------------------------
-- logical_agents — the provider-neutral capability declaration registry
-- ---------------------------------------------------------------------------

-- The capability-descriptor shape validator (IMMUTABLE so it can serve a
-- CHECK constraint; defined BEFORE the table because PostgreSQL resolves
-- the CHECK expression at table-creation time): every element of the
-- capabilities array is EXACTLY an object with the two keys
-- capabilityKind (string) and parameters (object). A
-- provider/model/SDK/credential/infrastructure-shaped descriptor key set
-- is structurally unrepresentable — this is the storage-side half of the
-- provider-neutral capability contract.
CREATE OR REPLACE FUNCTION logical_agents_capabilities_valid(caps jsonb)
RETURNS boolean AS $$
DECLARE
    elem jsonb;
    key_count integer;
BEGIN
    IF jsonb_typeof(caps) <> 'array' THEN
        RETURN false;
    END IF;
    FOR elem IN SELECT * FROM jsonb_array_elements(caps) LOOP
        IF jsonb_typeof(elem) <> 'object' THEN
            RETURN false;
        END IF;
        SELECT count(*) INTO key_count FROM jsonb_object_keys(elem);
        IF key_count <> 2 THEN
            RETURN false;
        END IF;
        IF NOT (elem ? 'capabilityKind') OR NOT (elem ? 'parameters') THEN
            RETURN false;
        END IF;
        IF jsonb_typeof(elem->'capabilityKind') <> 'string' THEN
            RETURN false;
        END IF;
        IF jsonb_typeof(elem->'parameters') <> 'object' THEN
            RETURN false;
        END IF;
    END LOOP;
    RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE TABLE IF NOT EXISTS logical_agents (
    agent_id           uuid        PRIMARY KEY,
    -- The reusable logical NAME of the declaration (e.g.
    -- 'copy-writer', 'web-researcher'). Normalized label; unique among
    -- ACTIVE declarations of its scope (the registration fence below).
    agent_key          text        NOT NULL
                       CHECK (length(agent_key) >= 2 AND length(agent_key) <= 100),
    display_name       text        NOT NULL
                       CHECK (length(display_name) >= 1 AND length(display_name) <= 200),
    -- The declared contract version label of THIS declaration (e.g.
    -- '1.0.0'). The version identity of the capability contract: a
    -- corrected declaration retires the old row and registers a NEW row
    -- (new agent_id) carrying the new version label — append-oriented
    -- versioning, never an in-place rewrite.
    version_label      text        NOT NULL
                       CHECK (length(version_label) >= 1 AND length(version_label) <= 64),
    -- The contract text: what the agent declares it can do and how the
    -- capabilities are used (bounded prose).
    description        text        NOT NULL
                       CHECK (length(description) >= 1 AND length(description) <= 2000),
    -- The DECLARED CAPABILITIES: a JSON array of provider-neutral
    -- descriptors, each EXACTLY { "capabilityKind": <normalized label>,
    -- "parameters": <bounded JSON object> }. The shape is enforced by the
    -- CHECK below (function-based, since CHECK constraints cannot carry
    -- subqueries) — a descriptor carrying any extra key (provider/model/
    -- SDK/credential/infrastructure-shaped or otherwise) can never be
    -- stored. Provider/model/credential VALUES inside parameters are
    -- rejected at the module boundary (the module input guard) and by the
    -- API DTO forbidden-key contracts — the storage here guarantees the
    -- descriptor SHAPE stays provider-neutral.
    capabilities       jsonb       NOT NULL DEFAULT '[]'::jsonb
                       CHECK (jsonb_typeof(capabilities) = 'array')
                       CHECK (logical_agents_capabilities_valid(capabilities)),
    -- Server-derived ownership scope: NULL = PLATFORM scope; set = the
    -- owning Agency. IMMUTABLE once set (trigger) — a declaration can
    -- never silently migrate between scopes.
    agency_id          uuid        REFERENCES agencies(agency_id) ON DELETE CASCADE,
    status             text        NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'retired')),
    -- §8-style logical register-command key + fingerprint (convergence
    -- proof), scoped like the declaration itself.
    idempotency_key    text        NOT NULL
                       CHECK (length(idempotency_key) >= 1 AND length(idempotency_key) <= 200),
    create_fingerprint text        NOT NULL CHECK (length(create_fingerprint) = 64),
    created_by         uuid        REFERENCES users(user_id),
    version            bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

-- The §8-style logical command fences (per scope: platform rows carry
-- agency_id NULL, agency rows carry it set — NULLs are distinct, so each
-- scope mode gets its own fence). One idempotency key identifies ONE
-- logical register command in its scope: a duplicate of the same command
-- (same fingerprint) replays to the existing row; a key reused for a
-- different command is a conflict, never a silent overwrite.
CREATE UNIQUE INDEX IF NOT EXISTS logical_agents_platform_command_fence
    ON logical_agents (idempotency_key) WHERE agency_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS logical_agents_agency_command_fence
    ON logical_agents (agency_id, idempotency_key) WHERE agency_id IS NOT NULL;

-- The ACTIVE DECLARATION fences: one ACTIVE declaration per (scope,
-- agent_key) — race-free under concurrent registration; a retired
-- declaration frees the key for a NEW identity (append-oriented
-- versioning: corrections retire + re-register).
CREATE UNIQUE INDEX IF NOT EXISTS logical_agents_platform_active_key_fence
    ON logical_agents (agent_key) WHERE status = 'active' AND agency_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS logical_agents_agency_active_key_fence
    ON logical_agents (agency_id, agent_key) WHERE status = 'active' AND agency_id IS NOT NULL;

-- Listing surfaces: the platform-scoped declarations, and the declarations
-- of one Agency (retired history stays visible in both by id).
CREATE INDEX IF NOT EXISTS logical_agents_platform_idx
    ON logical_agents (created_at, agent_id) WHERE agency_id IS NULL;
CREATE INDEX IF NOT EXISTS logical_agents_agency_idx
    ON logical_agents (agency_id, created_at, agent_id);
CREATE INDEX IF NOT EXISTS logical_agents_key_idx
    ON logical_agents (agent_key);

-- Content immutability (the append-oriented registry posture): identity,
-- the full declared contract (name, version label, description, the
-- capability descriptors), the ownership scope, the idempotency identity
-- and the provenance can NEVER be reassigned through ANY mutation path.
-- Only status (the single lifecycle edge), version (its CAS token) and
-- updated_at ever change. Corrections retire + re-register as a NEW row.
CREATE OR REPLACE FUNCTION logical_agents_content_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW.agent_id <> OLD.agent_id THEN
        RAISE EXCEPTION 'agent_id % is immutable', OLD.agent_id;
    END IF;
    IF NEW.agent_key <> OLD.agent_key THEN
        RAISE EXCEPTION 'logical agent % key % is immutable (append-oriented registry: corrections register a NEW declaration)',
            OLD.agent_id, OLD.agent_key;
    END IF;
    IF NEW.display_name <> OLD.display_name
       OR NEW.version_label <> OLD.version_label
       OR NEW.description <> OLD.description
       OR NEW.capabilities IS DISTINCT FROM OLD.capabilities THEN
        RAISE EXCEPTION 'logical agent % declared contract is immutable (append-oriented registry: retire and re-register)',
            OLD.agent_id;
    END IF;
    IF NEW.agency_id IS DISTINCT FROM OLD.agency_id THEN
        RAISE EXCEPTION 'logical agent % ownership scope is immutable (was %)',
            OLD.agent_id, COALESCE(OLD.agency_id::text, 'platform');
    END IF;
    IF NEW.idempotency_key <> OLD.idempotency_key OR NEW.create_fingerprint <> OLD.create_fingerprint THEN
        RAISE EXCEPTION 'logical agent % idempotency identity is immutable', OLD.agent_id;
    END IF;
    IF NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'logical agent % provenance is immutable', OLD.agent_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS logical_agents_content_immutable_trigger ON logical_agents;
CREATE TRIGGER logical_agents_content_immutable_trigger
    BEFORE UPDATE ON logical_agents
    FOR EACH ROW EXECUTE FUNCTION logical_agents_content_immutable();

-- Lifecycle backstop: `retired` is a TERMINAL tombstone — the only
-- lifecycle edge is active → retired, and a retired declaration can never
-- silently return to use via UPDATE (no second retirement, no
-- resurrection).
CREATE OR REPLACE FUNCTION logical_agents_retired_terminal() RETURNS trigger AS $$
BEGIN
    IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN
        RAISE EXCEPTION 'logical agent % is retired and terminal', OLD.agent_id;
    END IF;
    IF OLD.status = 'active' AND NEW.status NOT IN ('active', 'retired') THEN
        RAISE EXCEPTION 'illegal logical agent status % (the lifecycle is active → retired only)',
            NEW.status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS logical_agents_retired_terminal_trigger ON logical_agents;
CREATE TRIGGER logical_agents_retired_terminal_trigger
    BEFORE UPDATE ON logical_agents
    FOR EACH ROW EXECUTE FUNCTION logical_agents_retired_terminal();

-- ---------------------------------------------------------------------------
-- logical_agent_lifecycle_events — the append-only lifecycle history
-- ---------------------------------------------------------------------------

-- One immutable row per APPLIED lifecycle transition. Rows are written
-- once and can never be updated or deleted (trigger below); (agent_id,
-- transition) is UNIQUE — there is exactly ONE 'registered' event and at
-- most ONE 'retired' event per declaration, which is the storage end of
-- "terminal retirement, no second retirement".
CREATE TABLE IF NOT EXISTS logical_agent_lifecycle_events (
    event_id     uuid        PRIMARY KEY,
    agent_id     uuid        NOT NULL REFERENCES logical_agents(agent_id) ON DELETE CASCADE,
    -- The applied transition: 'registered' (born active) or 'retired'.
    transition   text        NOT NULL CHECK (transition IN ('registered', 'retired')),
    -- NULL for 'registered' (a declaration is born active); 'active' for
    -- 'retired' (the single lifecycle edge).
    from_status  text        CHECK (from_status IS NULL OR from_status IN ('active', 'retired')),
    to_status    text        NOT NULL CHECK (to_status IN ('active', 'retired')),
    -- The server-recorded reason (e.g. the retire request's reason).
    reason       text        NOT NULL DEFAULT '' CHECK (length(reason) <= 512),
    created_by   uuid        REFERENCES users(user_id),
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT logical_agent_lifecycle_events_once_unique UNIQUE (agent_id, transition)
);

CREATE INDEX IF NOT EXISTS logical_agent_lifecycle_events_agent_idx
    ON logical_agent_lifecycle_events (agent_id, created_at, event_id);

-- Legality + consistency backstop (defense in depth): only the two frozen
-- lifecycle pairs can be RECORDED (registered: NULL → active;
-- retired: active → retired), and the event must match the agent row's
-- CURRENT status — the history can never claim a transition the registry
-- itself did not apply, even if written by direct SQL.
CREATE OR REPLACE FUNCTION logical_agent_lifecycle_events_legal() RETURNS trigger AS $$
BEGIN
    IF NEW.transition = 'registered' THEN
        IF NEW.from_status IS NOT NULL OR NEW.to_status <> 'active' THEN
            RAISE EXCEPTION 'illegal registered lifecycle event (from % to %)',
                COALESCE(NEW.from_status, 'null'), NEW.to_status;
        END IF;
    ELSIF NEW.transition = 'retired' THEN
        IF NEW.from_status <> 'active' OR NEW.to_status <> 'retired' THEN
            RAISE EXCEPTION 'illegal retired lifecycle event (from % to %)',
                COALESCE(NEW.from_status, 'null'), NEW.to_status;
        END IF;
    ELSE
        RAISE EXCEPTION 'unknown logical agent lifecycle transition %', NEW.transition;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM logical_agents a
        WHERE a.agent_id = NEW.agent_id
          AND a.status = NEW.to_status
    ) THEN
        RAISE EXCEPTION 'lifecycle event % does not match logical agent % current status',
            NEW.event_id, NEW.agent_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS logical_agent_lifecycle_events_legal_trigger ON logical_agent_lifecycle_events;
CREATE TRIGGER logical_agent_lifecycle_events_legal_trigger
    BEFORE INSERT ON logical_agent_lifecycle_events
    FOR EACH ROW EXECUTE FUNCTION logical_agent_lifecycle_events_legal();

-- Append-only backstop: lifecycle history is immutable evidence — UPDATE
-- and DELETE are both rejected by the database itself.
CREATE OR REPLACE FUNCTION logical_agent_lifecycle_events_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'logical agent lifecycle events are append-only history (% blocked)',
        TG_OP;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS logical_agent_lifecycle_events_append_only_trigger ON logical_agent_lifecycle_events;
CREATE TRIGGER logical_agent_lifecycle_events_append_only_trigger
    BEFORE UPDATE OR DELETE ON logical_agent_lifecycle_events
    FOR EACH ROW EXECUTE FUNCTION logical_agent_lifecycle_events_append_only();
