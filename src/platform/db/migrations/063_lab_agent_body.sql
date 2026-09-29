-- 063_lab_agent_body.sql — LAB-011 (Agent Body Runtime Contract).
--
-- THE AGENT BODY AUTHORITY (spec/effective-backlog-v1.7.md LAB-011:
-- "Implement model-agnostic Agent Body execution with tools, memory,
-- permissions, budgets and evaluation hooks. Acceptance: at least two
-- interchangeable model backends through the existing AI runtime; no
-- second model router."; spec/architecture-v1.7-marketing-lab.md §14
-- "Agent Body" — the verbatim field set as declared data, and the
-- verbatim formula "Agent Body + selected LLM/model + permitted
-- tools/capabilities = Agent Instance" with "The Lab MUST NOT create
-- a second model-routing authority. Model selection is delegated to
-- the existing AI runtime boundary."; §15 (organizations reference
-- agent bodies by opaque body-version strings); §22 multi-tenancy;
-- §23 budget caps; AGENTS.md v1.7 "Agent Body is MOS-owned. LLMs are
-- occupants selected through existing /ai-runtime."; architecture-
-- lock-v1.7: Lab artifacts never shadow v1.6 authorities):
--
--   lab_agent_body_versions      → the CLIENT-SCOPED versioned Agent
--                                  Body registry carrying the FULL §14
--                                  field set as declared data (role
--                                  contract, input/output contracts,
--                                  tools, permissions, memory
--                                  interfaces, communication interface,
--                                  action interface, capability
--                                  references, budget, latency limits,
--                                  evaluation hooks, safety/policy
--                                  constraints) — the registry /lab
--                                  organization candidates cite through
--                                  the OPAQUE body-version reference;
--   lab_agent_instance_runs      → the Agent Instance run records
--                                  (body version + selected model
--                                  identity as DATA + the observed
--                                  budget accounting + the terminal
--                                  state with the closed honest-failure
--                                  taxonomy);
--   lab_agent_run_events         → the APPEND-ONLY run event tail (the
--                                  recording substrate LAB-012 composes
--                                  multi-agent runs from);
--   lab_agent_memory_entries     → the bounded memory current-state
--                                  store (last-write-wins per key; the
--                                  HISTORY is the event tail).
--
-- Key fences:
--
-- * CHECK-fenced vocabularies on every enumerated column: the body
--   lifecycle (draft/active/retired), the run states
--   (running/succeeded/failed), the closed honest-failure taxonomy
--   (input_contract_violation/model_unavailable/model_invocation_
--   failed/permission_refused/tool_error/budget_exceeded/
--   latency_exceeded/output_contract_violation), the nine run-event
--   kinds, the memory kinds (run_scoped/body_scoped), the closed
--   action-kind + safety-constraint label sets on the text[] columns
--   (the <@ subset fence) and the pinned contract version.
-- * THE APPEND-ONLY DISCIPLINE: body version identity is immutable
--   after insert (guarded UPDATE trigger — only the lifecycle status
--   and updated_at may advance; corrections are NEW version rows);
--   run events are APPEND-ONLY OUTRIGHT (UPDATE and DELETE rejected);
--   runs are born 'running' and advance to exactly ONE terminal state
--   under the guarded UPDATE trigger (identity/scope/model/input
--   immutable; only the terminal columns and counters may advance);
--   memory entries are upsert-only current state (identity immutable;
--   entry_value may advance; DELETE rejected).
-- * THE SCOPE FENCES: every row FK-anchors the owning agency and
--   client (+ optional workspace INSIDE the client); runs FK-anchor
--   the EXACT body version they executed; the scope-consistency
--   triggers reject any run/event/memory row whose client does not
--   match its anchor's client (cross-tenant injection is rejected at
--   the DB — §22), and the body version-chain fence rejects a
--   correction whose scope differs from the chain's scope.
-- * NO SECOND MODEL ROUTER (§14, structural): no routing-policy,
--   eligibility, ranking or cascade column or table exists here; the
--   model identity is RECORDED DATA (model_registry_id + the provider/
--   key/display-name snapshot) resolved through the /ai-runtime public
--   boundary at run time — this migration creates NO /ai-runtime
--   table, view or FK into the /ai-runtime registry (the observations
--   flow through the module's /ai-runtime port, the sole authority).
-- * NO AUTHORITY TRANSFER / NO SHADOWING (§3 — structural): this
--   migration creates NO experiment, decision, evidence, metric,
--   publication, workflow or execution table and NO foreign key into
--   any of them; the /lab organization candidate's agentBodyVersions
--   citation is an OPAQUE version string in /lab's own declaration
--   jsonb (never joined here).
-- * NO SECRET MATERIAL ANYWHERE (CRED-001): the only structured
--   payload columns are the bounded §14 contract declarations, the
--   run input/output messages, the bounded event payloads and the
--   memory entry values — there is deliberately NO column capable of
--   holding secret or credential material, and NO binary column
--   exists anywhere.
--
-- Conventions (implementation-contract §3, §25): server-generated
-- opaque identifiers, append-oriented tails. No owner/role/user
-- columns: client-scope authorization stays exactly the
-- requireClientAccess route-layer authority — no second tenant,
-- permission or identity authority.

-- ---------------------------------------------------------------------------
-- lab_agent_body_versions — the client-scoped versioned Agent Body
-- registry (the FULL §14 field set as declared data)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_agent_body_versions (
    -- THE VERSION CHAIN KEY: one row per (body, version) — corrections
    -- append NEW version rows under the SAME body_id.
    body_id             uuid        NOT NULL,
    body_version        integer     NOT NULL CHECK (body_version >= 1 AND body_version <= 1000),
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id        uuid        REFERENCES workspaces(workspace_id),
    status              text        NOT NULL
                        CHECK (status IN ('draft', 'active', 'retired')),
    -- The role contract (§14): the body's role identity + description.
    role_contract       jsonb       NOT NULL
                        CHECK (jsonb_typeof(role_contract) = 'object'),
    -- The input/output message-contract schemas (§14 — the disclosed
    -- one-level schema subset, validated module-side).
    input_contract      jsonb       NOT NULL
                        CHECK (jsonb_typeof(input_contract) = 'object'),
    output_contract     jsonb       NOT NULL
                        CHECK (jsonb_typeof(output_contract) = 'object'),
    -- The tool declarations (§14 "tools" — array of {toolId,
    -- actionKind, description}).
    tools               jsonb       NOT NULL
                        CHECK (jsonb_typeof(tools) = 'array'),
    -- The permission set (§14 "permissions") — a NON-EMPTY subset of
    -- the closed action-kind vocabulary (the <@ fence; the module
    -- validates the deep shape, the DB keeps the closed set honest).
    permissions         text[]      NOT NULL
                        CHECK (array_length(permissions, 1) >= 1
                               AND permissions <@ ARRAY['read','analyze','compose','transform','communicate','simulate']::text[]),
    -- The memory-interface declarations (§14 "memory interfaces" —
    -- array of {memoryId, kind, capacityEntries}).
    memory_interfaces   jsonb       NOT NULL
                        CHECK (jsonb_typeof(memory_interfaces) = 'array'),
    -- The communication interface (§14 — array of {channelId,
    -- direction, messageKind}).
    communication_interface jsonb   NOT NULL
                        CHECK (jsonb_typeof(communication_interface) = 'array'),
    -- The action interface (§14 — a subset of the SAFE action-verb
    -- vocabulary; the publication/engagement verbs are structurally
    -- unrepresentable).
    action_interface    jsonb       NOT NULL
                        CHECK (jsonb_typeof(action_interface) = 'array'),
    -- The capability references (§14 "capabilities" — OPAQUE strings;
    -- the capability ENGINE is LAB-013, never here).
    capabilities        jsonb       NOT NULL
                        CHECK (jsonb_typeof(capabilities) = 'array'),
    -- The declared budget (§14 "budget" + §23 budget caps — the
    -- per-run model-invocation/tool-invocation/token/cost caps).
    budget              jsonb       NOT NULL
                        CHECK (jsonb_typeof(budget) = 'object'),
    -- The latency limits (§14 — the per-run deadline).
    latency_limits      jsonb       NOT NULL
                        CHECK (jsonb_typeof(latency_limits) = 'object'),
    -- The evaluation-hook declarations (§14 "evaluation hooks" —
    -- array of {hookId}; the firings are DATA on the run tail).
    evaluation_hooks    jsonb       NOT NULL
                        CHECK (jsonb_typeof(evaluation_hooks) = 'array'),
    -- The safety/policy constraints (§14) — a NON-EMPTY subset of the
    -- closed §21 hard-rejection vocabulary (a body without a declared
    -- safety posture is inexpressible).
    safety_constraints  text[]      NOT NULL
                        CHECK (array_length(safety_constraints, 1) >= 1
                               AND safety_constraints <@ ARRAY['no_fake_engagement','no_impersonation','no_rights_circumvention','no_anti_abuse_evasion','no_deceptive_attribution']::text[]),
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'lab-agent-body-contract-v1'),
    created_at          timestamptz NOT NULL,
    updated_at          timestamptz NOT NULL,
    CONSTRAINT lab_agent_body_versions_pk PRIMARY KEY (body_id, body_version)
);

-- The client's body tail (newest version last).
CREATE INDEX IF NOT EXISTS lab_agent_body_versions_client_idx
    ON lab_agent_body_versions (client_id, body_id, body_version, created_at);

-- Body version identity is immutable after insert; only the lifecycle
-- status and the server-managed updated_at may advance (corrections
-- are NEW version rows — the append-only correction path; the
-- LAB-001/LAB-002 guard pattern).
CREATE OR REPLACE FUNCTION lab_agent_body_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.body_id <> OLD.body_id
       OR NEW.body_version <> OLD.body_version
       OR NEW.agency_id <> OLD.agency_id
       OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.role_contract <> OLD.role_contract
       OR NEW.input_contract <> OLD.input_contract
       OR NEW.output_contract <> OLD.output_contract
       OR NEW.tools <> OLD.tools
       OR NEW.permissions <> OLD.permissions
       OR NEW.memory_interfaces <> OLD.memory_interfaces
       OR NEW.communication_interface <> OLD.communication_interface
       OR NEW.action_interface <> OLD.action_interface
       OR NEW.capabilities <> OLD.capabilities
       OR NEW.budget <> OLD.budget
       OR NEW.latency_limits <> OLD.latency_limits
       OR NEW.evaluation_hooks <> OLD.evaluation_hooks
       OR NEW.safety_constraints <> OLD.safety_constraints
       OR NEW.contract_version <> OLD.contract_version
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'lab agent body % version % identity/scope/contract is immutable — corrections are NEW version rows',
            OLD.body_id, OLD.body_version;
    END IF;
    IF NOT (
           (OLD.status = 'draft' AND NEW.status IN ('active', 'retired'))
        OR (OLD.status = 'active' AND NEW.status = 'retired')
        OR (OLD.status = NEW.status)
    ) THEN
        RAISE EXCEPTION 'lab agent body transition % → % is not legal (draft → active → retired; no resurrection)',
            OLD.status, NEW.status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_agent_body_guard_trigger ON lab_agent_body_versions;
CREATE TRIGGER lab_agent_body_guard_trigger
    BEFORE UPDATE ON lab_agent_body_versions
    FOR EACH ROW EXECUTE FUNCTION lab_agent_body_guard();

-- Body versions are never deleted (history is append-only).
CREATE OR REPLACE FUNCTION lab_agent_body_versions_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab agent body versions cannot be deleted — body history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_agent_body_versions_no_delete_trigger ON lab_agent_body_versions;
CREATE TRIGGER lab_agent_body_versions_no_delete_trigger
    BEFORE DELETE ON lab_agent_body_versions
    FOR EACH ROW EXECUTE FUNCTION lab_agent_body_versions_no_delete();

-- The version-chain scope fence: a correction (version > 1) must keep
-- the chain's scope (agency/client/workspace) — cross-tenant or
-- cross-workspace chain poisoning is rejected at the DB.
CREATE OR REPLACE FUNCTION lab_agent_body_chain_scope_check() RETURNS trigger AS $$
DECLARE
    chain_client uuid;
    chain_agency uuid;
    chain_workspace uuid;
BEGIN
    IF NEW.body_version > 1 THEN
        SELECT client_id, agency_id, workspace_id
            INTO chain_client, chain_agency, chain_workspace
            FROM lab_agent_body_versions
            WHERE body_id = NEW.body_id AND body_version = NEW.body_version - 1;
        IF chain_client IS NULL THEN
            RAISE EXCEPTION 'lab agent body version chain is broken (%, %)',
                NEW.body_id, NEW.body_version - 1;
        END IF;
        IF chain_client <> NEW.client_id OR chain_agency <> NEW.agency_id
           OR chain_workspace IS DISTINCT FROM NEW.workspace_id THEN
            RAISE EXCEPTION 'lab agent body correction must keep the version chain scope (cross-tenant/cross-workspace corrections are rejected)';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_agent_body_chain_scope_trigger ON lab_agent_body_versions;
CREATE TRIGGER lab_agent_body_chain_scope_trigger
    BEFORE INSERT ON lab_agent_body_versions
    FOR EACH ROW EXECUTE FUNCTION lab_agent_body_chain_scope_check();

-- ---------------------------------------------------------------------------
-- lab_agent_instance_runs — the Agent Instance run records (§14's
-- formula instantiated: body version + selected model (DATA) +
-- permitted tools, run to an honest terminal state)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_agent_instance_runs (
    run_id              uuid        PRIMARY KEY,
    -- The run binds EXACTLY the body version it executed (the
    -- composite FK; a corrected body never re-aims an existing run).
    body_id             uuid        NOT NULL,
    body_version        integer     NOT NULL CHECK (body_version >= 1),
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id        uuid        REFERENCES workspaces(workspace_id),
    -- THE MODEL IDENTITY AS DATA (§14: selected by the CALLER through
    -- the /ai-runtime boundary — never selected here; the snapshot is
    -- resolved through the /ai-runtime registry at run start). There
    -- is deliberately NO routing-policy, eligibility or cascade column
    -- anywhere (the no-second-router rule is structural).
    model_registry_id   uuid        NOT NULL,
    model_provider_label text       NOT NULL CHECK (char_length(model_provider_label) >= 1 AND char_length(model_provider_label) <= 64),
    model_key           text        NOT NULL CHECK (char_length(model_key) >= 1 AND char_length(model_key) <= 128),
    model_display_name  text        NOT NULL CHECK (char_length(model_display_name) >= 1 AND char_length(model_display_name) <= 256),
    status              text        NOT NULL
                        CHECK (status IN ('running', 'succeeded', 'failed')),
    -- The closed honest-failure taxonomy (the LAB-001 run discipline).
    failure_reason      text
                        CHECK (failure_reason IS NULL
                               OR failure_reason IN ('input_contract_violation',
                                                      'model_unavailable',
                                                      'model_invocation_failed',
                                                      'permission_refused',
                                                      'tool_error',
                                                      'budget_exceeded',
                                                      'latency_exceeded',
                                                      'output_contract_violation')),
    input_message       jsonb       NOT NULL
                        CHECK (jsonb_typeof(input_message) = 'object'),
    output_message      jsonb
                        CHECK (output_message IS NULL OR jsonb_typeof(output_message) = 'object'),
    -- The terminal-state consistency fence: only a succeeded run
    -- carries an output; only a failed run carries a reason.
    CONSTRAINT lab_agent_runs_terminal_shape CHECK (
        (status = 'running' AND failure_reason IS NULL AND output_message IS NULL)
        OR (status = 'succeeded' AND failure_reason IS NULL AND output_message IS NOT NULL)
        OR (status = 'failed' AND failure_reason IS NOT NULL AND output_message IS NULL)
    ),
    addressed_channel   text
                        CHECK (addressed_channel IS NULL
                               OR (char_length(addressed_channel) >= 1 AND char_length(addressed_channel) <= 64)),
    model_invocations   integer     NOT NULL CHECK (model_invocations >= 0 AND model_invocations <= 10),
    tool_invocations    integer     NOT NULL CHECK (tool_invocations >= 0 AND tool_invocations <= 100),
    observed_tokens_in  integer     NOT NULL CHECK (observed_tokens_in >= 0),
    observed_tokens_out integer     NOT NULL CHECK (observed_tokens_out >= 0),
    observed_cost_units double precision NOT NULL CHECK (observed_cost_units >= 0),
    started_at          timestamptz NOT NULL,
    finished_at         timestamptz,
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'lab-agent-body-contract-v1'),
    created_at          timestamptz NOT NULL,
    updated_at          timestamptz NOT NULL,
    CONSTRAINT lab_agent_instance_runs_body_fk
        FOREIGN KEY (body_id, body_version)
        REFERENCES lab_agent_body_versions(body_id, body_version)
);

-- The client's run tail.
CREATE INDEX IF NOT EXISTS lab_agent_instance_runs_client_idx
    ON lab_agent_instance_runs (client_id, body_id, created_at, run_id);
-- The model-identity facet (the DATA citation trail).
CREATE INDEX IF NOT EXISTS lab_agent_instance_runs_model_idx
    ON lab_agent_instance_runs (client_id, model_registry_id);

-- Run identity is immutable after insert; ONLY the terminal columns
-- (status/failure_reason/output_message), the observed counters and
-- the server-managed timestamps may advance — and only ONCE (a
-- terminal run is terminal forever; the runtime's guarded advance is
-- the sole sanctioned mutation path).
CREATE OR REPLACE FUNCTION lab_agent_run_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.run_id <> OLD.run_id
       OR NEW.body_id <> OLD.body_id
       OR NEW.body_version <> OLD.body_version
       OR NEW.agency_id <> OLD.agency_id
       OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.model_registry_id <> OLD.model_registry_id
       OR NEW.model_provider_label <> OLD.model_provider_label
       OR NEW.model_key <> OLD.model_key
       OR NEW.model_display_name <> OLD.model_display_name
       OR NEW.input_message <> OLD.input_message
       OR NEW.addressed_channel IS DISTINCT FROM OLD.addressed_channel
       OR NEW.started_at <> OLD.started_at
       OR NEW.contract_version <> OLD.contract_version
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'lab agent instance run % identity/scope/model/input is immutable — the run record never rewrites what it executed',
            OLD.run_id;
    END IF;
    IF OLD.status <> 'running' AND NEW.status <> OLD.status THEN
        RAISE EXCEPTION 'lab agent instance run % is terminal (%) — terminal runs never change state',
            OLD.run_id, OLD.status;
    END IF;
    IF OLD.status = 'running' AND NEW.status NOT IN ('succeeded', 'failed') THEN
        RAISE EXCEPTION 'lab agent instance run % may only advance running → succeeded/failed (found %)',
            OLD.run_id, NEW.status;
    END IF;
    IF OLD.status <> 'running' AND (NEW.failure_reason IS DISTINCT FROM OLD.failure_reason
       OR NEW.output_message IS DISTINCT FROM OLD.output_message
       OR NEW.finished_at IS DISTINCT FROM OLD.finished_at
       OR NEW.model_invocations <> OLD.model_invocations
       OR NEW.tool_invocations <> OLD.tool_invocations
       OR NEW.observed_tokens_in <> OLD.observed_tokens_in
       OR NEW.observed_tokens_out <> OLD.observed_tokens_out
       OR NEW.observed_cost_units <> OLD.observed_cost_units) THEN
        RAISE EXCEPTION 'lab agent instance run % is terminal — the terminal columns and counters never move again',
            OLD.run_id;
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'lab agent instance run % updated_at may not go backwards',
            OLD.run_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_agent_run_guard_trigger ON lab_agent_instance_runs;
CREATE TRIGGER lab_agent_run_guard_trigger
    BEFORE UPDATE ON lab_agent_instance_runs
    FOR EACH ROW EXECUTE FUNCTION lab_agent_run_guard();

-- Runs are never deleted (the run history is append-only evidence).
CREATE OR REPLACE FUNCTION lab_agent_runs_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab agent instance runs cannot be deleted — run history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_agent_runs_no_delete_trigger ON lab_agent_instance_runs;
CREATE TRIGGER lab_agent_runs_no_delete_trigger
    BEFORE DELETE ON lab_agent_instance_runs
    FOR EACH ROW EXECUTE FUNCTION lab_agent_runs_no_delete();

-- Scope consistency: a run's client must match its body version's
-- client (cross-tenant run injection is rejected at the DB — §22).
CREATE OR REPLACE FUNCTION lab_agent_run_scope_check() RETURNS trigger AS $$
DECLARE
    body_client uuid;
BEGIN
    SELECT client_id INTO body_client
        FROM lab_agent_body_versions
        WHERE body_id = NEW.body_id AND body_version = NEW.body_version;
    IF body_client IS NULL THEN
        RAISE EXCEPTION 'lab agent instance run must bind an existing body version (%, %)',
            NEW.body_id, NEW.body_version;
    END IF;
    IF body_client <> NEW.client_id THEN
        RAISE EXCEPTION 'lab agent instance run client must match its body version client (cross-tenant runs are rejected)';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_agent_run_scope_trigger ON lab_agent_instance_runs;
CREATE TRIGGER lab_agent_run_scope_trigger
    BEFORE INSERT ON lab_agent_instance_runs
    FOR EACH ROW EXECUTE FUNCTION lab_agent_run_scope_check();

-- ---------------------------------------------------------------------------
-- lab_agent_run_events — the APPEND-ONLY run event tail (the LAB-012
-- composition substrate)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_agent_run_events (
    event_id            uuid        PRIMARY KEY,
    run_id              uuid        NOT NULL
                        REFERENCES lab_agent_instance_runs(run_id),
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    seq                 integer     NOT NULL CHECK (seq >= 1),
    event_kind          text        NOT NULL
                        CHECK (event_kind IN ('run_started',
                                               'model_invocation',
                                               'tool_invocation',
                                               'tool_refusal',
                                               'memory_write',
                                               'memory_refused',
                                               'evaluation_hook',
                                               'run_completed',
                                               'run_failed')),
    payload             jsonb       NOT NULL
                        CHECK (jsonb_typeof(payload) = 'object'),
    payload_digest      text        NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'lab-agent-body-contract-v1'),
    created_at          timestamptz NOT NULL,
    -- The per-run sequence fence (the ordered tail).
    CONSTRAINT lab_agent_run_events_seq UNIQUE (run_id, seq)
);

-- The run's event tail (oldest first).
CREATE INDEX IF NOT EXISTS lab_agent_run_events_run_idx
    ON lab_agent_run_events (run_id, seq, event_id);
-- The client's event facet (the composition queries).
CREATE INDEX IF NOT EXISTS lab_agent_run_events_client_idx
    ON lab_agent_run_events (client_id, created_at);

-- Events are APPEND-ONLY OUTRIGHT: no UPDATE, no DELETE (the run
-- history is evidence — the same discipline as the /lab run events
-- and the /lab-corpus observations).
CREATE OR REPLACE FUNCTION lab_agent_run_events_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab agent run events are append-only (INSERT only — run history is never rewritten)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_agent_run_events_no_update_trigger ON lab_agent_run_events;
CREATE TRIGGER lab_agent_run_events_no_update_trigger
    BEFORE UPDATE ON lab_agent_run_events
    FOR EACH ROW EXECUTE FUNCTION lab_agent_run_events_append_only();

DROP TRIGGER IF EXISTS lab_agent_run_events_no_delete_trigger ON lab_agent_run_events;
CREATE TRIGGER lab_agent_run_events_no_delete_trigger
    BEFORE DELETE ON lab_agent_run_events
    FOR EACH ROW EXECUTE FUNCTION lab_agent_run_events_append_only();

-- Scope consistency: an event's client must match its run's client
-- (cross-tenant event injection is rejected at the DB).
CREATE OR REPLACE FUNCTION lab_agent_event_scope_check() RETURNS trigger AS $$
DECLARE
    run_client uuid;
BEGIN
    SELECT client_id INTO run_client
        FROM lab_agent_instance_runs
        WHERE run_id = NEW.run_id;
    IF run_client IS NULL THEN
        RAISE EXCEPTION 'lab agent run event must bind an existing run (%)',
            NEW.run_id;
    END IF;
    IF run_client <> NEW.client_id THEN
        RAISE EXCEPTION 'lab agent run event client must match its run client (cross-tenant events are rejected)';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_agent_event_scope_trigger ON lab_agent_run_events;
CREATE TRIGGER lab_agent_event_scope_trigger
    BEFORE INSERT ON lab_agent_run_events
    FOR EACH ROW EXECUTE FUNCTION lab_agent_event_scope_check();

-- ---------------------------------------------------------------------------
-- lab_agent_memory_entries — the bounded memory current-state store
-- (§14 "memory interfaces": run_scoped scratch + body_scoped persistent;
-- last-write-wins per key; the HISTORY is the event tail)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_agent_memory_entries (
    entry_id            uuid        PRIMARY KEY,
    body_id             uuid        NOT NULL,
    -- The run anchor: NULL for body_scoped memories, the owning run
    -- for run_scoped memories (the kind consistency fence below).
    run_id              uuid        REFERENCES lab_agent_instance_runs(run_id),
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id        uuid        REFERENCES workspaces(workspace_id),
    memory_id           text        NOT NULL CHECK (char_length(memory_id) >= 1 AND char_length(memory_id) <= 64),
    kind                text        NOT NULL
                        CHECK (kind IN ('run_scoped', 'body_scoped')),
    entry_key           text        NOT NULL CHECK (char_length(entry_key) >= 1 AND char_length(entry_key) <= 256),
    entry_value         jsonb       NOT NULL
                        CHECK (jsonb_typeof(entry_value) = 'object'),
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'lab-agent-body-contract-v1'),
    created_at          timestamptz NOT NULL,
    updated_at          timestamptz NOT NULL,
    -- THE KIND CONSISTENCY FENCE: a body_scoped entry has NO run
    -- anchor; a run_scoped entry ALWAYS has one.
    CONSTRAINT lab_agent_memory_kind_shape CHECK (
        (kind = 'body_scoped' AND run_id IS NULL)
        OR (kind = 'run_scoped' AND run_id IS NOT NULL)
    ),
    -- THE LAST-WRITE-WINS KEY: one current entry per (client, body,
    -- memory, run, key) — NULLS NOT DISTINCT so the body_scoped
    -- (run_id NULL) key fences too.
    CONSTRAINT lab_agent_memory_key UNIQUE NULLS NOT DISTINCT
        (client_id, body_id, memory_id, run_id, entry_key)
);

-- The memory read facets.
CREATE INDEX IF NOT EXISTS lab_agent_memory_body_idx
    ON lab_agent_memory_entries (client_id, body_id, memory_id, created_at, entry_id);
CREATE INDEX IF NOT EXISTS lab_agent_memory_run_idx
    ON lab_agent_memory_entries (client_id, run_id, memory_id);

-- Memory entry identity is immutable after insert; ONLY entry_value
-- and updated_at may advance (the last-write-wins upsert — the
-- capacity history is the event tail, never this table).
CREATE OR REPLACE FUNCTION lab_agent_memory_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.entry_id <> OLD.entry_id
       OR NEW.body_id <> OLD.body_id
       OR NEW.run_id IS DISTINCT FROM OLD.run_id
       OR NEW.agency_id <> OLD.agency_id
       OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.memory_id <> OLD.memory_id
       OR NEW.kind <> OLD.kind
       OR NEW.entry_key <> OLD.entry_key
       OR NEW.contract_version <> OLD.contract_version
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'lab agent memory entry % identity/scope is immutable — the value advances, the identity never',
            OLD.entry_id;
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'lab agent memory entry % updated_at may not go backwards',
            OLD.entry_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_agent_memory_guard_trigger ON lab_agent_memory_entries;
CREATE TRIGGER lab_agent_memory_guard_trigger
    BEFORE UPDATE ON lab_agent_memory_entries
    FOR EACH ROW EXECUTE FUNCTION lab_agent_memory_guard();

-- Memory entries are never deleted (the current state advances only
-- by upsert; the capacity accounting stays honest).
CREATE OR REPLACE FUNCTION lab_agent_memory_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab agent memory entries cannot be deleted — memory state advances by upsert only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_agent_memory_no_delete_trigger ON lab_agent_memory_entries;
CREATE TRIGGER lab_agent_memory_no_delete_trigger
    BEFORE DELETE ON lab_agent_memory_entries
    FOR EACH ROW EXECUTE FUNCTION lab_agent_memory_no_delete();

-- Scope consistency: a body_scoped entry's client must match its
-- body's client; a run_scoped entry's client must match its run's
-- client (cross-tenant memory injection is rejected at the DB — §22).
CREATE OR REPLACE FUNCTION lab_agent_memory_scope_check() RETURNS trigger AS $$
DECLARE
    anchor_client uuid;
BEGIN
    IF NEW.run_id IS NULL THEN
        SELECT client_id INTO anchor_client
            FROM lab_agent_body_versions
            WHERE body_id = NEW.body_id;
    ELSE
        SELECT client_id INTO anchor_client
            FROM lab_agent_instance_runs
            WHERE run_id = NEW.run_id;
    END IF;
    IF anchor_client IS NULL THEN
        RAISE EXCEPTION 'lab agent memory entry must bind an existing body/run (%)',
            NEW.body_id;
    END IF;
    IF anchor_client <> NEW.client_id THEN
        RAISE EXCEPTION 'lab agent memory entry client must match its body/run client (cross-tenant memory is rejected)';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_agent_memory_scope_trigger ON lab_agent_memory_entries;
CREATE TRIGGER lab_agent_memory_scope_trigger
    BEFORE INSERT ON lab_agent_memory_entries
    FOR EACH ROW EXECUTE FUNCTION lab_agent_memory_scope_check();
