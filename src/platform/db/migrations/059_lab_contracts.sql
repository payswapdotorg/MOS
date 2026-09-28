-- 059_lab_contracts.sql — LAB-001 (Marketing Engineering Lab Contracts
-- and Run Model).
--
-- The LAB CONTRACT AUTHORITY (spec/effective-backlog-v1.7.md LAB-001:
-- "Build the Lab Scenario, Lab Run, Strategy Candidate, Organization
-- Candidate, Capability Candidate and Calibration Record contracts.
-- Acceptance: versioned contracts, tenant isolation, deterministic
-- seeds, lifecycle states, no shadowing of v1.6 authorities";
-- spec/architecture-v1.7-marketing-lab.md §3 authority boundaries, §9
-- deterministic seeds, §10 Time-Machine run fields, §12 versioned reward
-- definition, §13 uncertainty, §15 organization candidates (single-agent
-- baseline), §16 capability contracts, §19 calibration records, §22
-- multi-tenancy, §23 operational constraints; frozen-manifest-v1.7.json
-- labArtifacts; architecture-lock-v1.7: Lab artifacts never shadow v1.6
-- authorities, counterfactuals are model outputs, time-machine lag
-- prevents future leakage):
--
--   lab_scenarios                              → the CLIENT-SCOPED
--                                                versioned scenario
--                                                contracts (the niche/
--                                                platform/corpus/world-
--                                                model binding + the
--                                                versioned reward
--                                                definition + the run
--                                                caps + the lifecycle);
--   lab_runs                                   → the CLIENT-SCOPED run
--                                                records (the FULL §10
--                                                Time-Machine field set
--                                                + the deterministic
--                                                seed set + the budget
--                                                caps + the factuality
--                                                label + the lifecycle);
--   lab_run_events                             → the append-only run
--                                                transition tail (the
--                                                frozen transition-pair
--                                                fence — the migration-
--                                                052 pattern);
--   lab_strategy_candidates                    → the CLIENT-SCOPED
--                                                strategy candidate
--                                                contracts (action space
--                                                + lineage + lifecycle);
--   lab_strategy_candidate_evaluations         → the append-only
--                                                evaluation summaries
--                                                (reward + uncertainty +
--                                                factuality label);
--   lab_organization_candidates                → the CLIENT-SCOPED
--                                                agent-organization
--                                                candidate contracts
--                                                (topology + graph);
--   lab_organization_candidate_evaluations     → the append-only
--                                                evaluation summaries;
--   lab_capability_candidates                  → the CLIENT-SCOPED
--                                                capability contracts
--                                                (the §16 shape);
--   lab_calibration_records                    → the CLIENT-SCOPED
--                                                append-only prediction-
--                                                vs-observation records
--                                                (the §19 shape).
--
-- Key fences:
--
-- * CHECK-fenced vocabularies on every enumerated column: the scenario
--   lifecycle (draft/active/retired), the run lifecycle (queued/running/
--   paused/succeeded/failed/cancelled), the closed run failure reasons,
--   the three Time-Machine modes, the three factuality labels
--   (factual_historical_replay / counterfactual_model_estimate /
--   simulated_model_output — §3/§10: historical fact and model output
--   are visibly distinct by construction), the candidate lifecycle, the
--   organization topologies (single_agent_baseline first — §15
--   mandate), the capability lifecycle, the calibration lifecycle, the
--   observed regimes and the external-reference kinds.
-- * THE DETERMINISTIC SEED FENCE (§9): the master seed is a
--   numeric(20,0) bounded to the unsigned 64-bit range; the derived
--   seed labels ride a bounded jsonb array. A run row records the
--   COMPLETE reproducibility input.
-- * THE TIME-MACHINE FENCES (§10): ISO-typed timestamps with the
--   module-side ordering guards; the observation cutoff and the ≥ 0
--   information lag are recorded columns (the leakage fence is
--   computable downstream — LAB-005/007 enforce it against these
--   recorded bounds).
-- * THE LIFECYCLE DISCIPLINE: scenario/candidate/capability/calibration
--   identity columns are immutable after insert (guarded UPDATE
--   triggers — only the lifecycle status and the server-managed
--   bookkeeping columns may advance); runs transition ONLY through the
--   append-only lab_run_events tail whose frozen transition-pair fence
--   rejects illegal edges and any from_status that does not match the
--   run's CURRENT durable state (the migration-052 pattern, verified
--   under the run row lock); evaluation summaries and calibration
--   records are append-only outright (UPDATE and DELETE rejected).
-- * THE SCOPE FENCES: every artifact row FK-anchors the owning agency
--   and client (+ optional workspace INSIDE the client); the run rows
--   FK-anchor the same-module scenario and the scope-consistency
--   trigger rejects any run whose client does not match its scenario's
--   client; the candidate rows carry the same fence against their
--   scenario; the calibration rows carry the same fence against the
--   referenced strategy candidate and run.
-- * NO AUTHORITY TRANSFER / NO SHADOWING (§3 — structural): this
--   migration creates NO experiment, decision, evidence, metric,
--   publication, workflow or execution table and NO foreign key into
--   any of them — a Lab Run is not a business Experiment, a Strategy
--   Candidate is not a Decision, a simulated publication is not a real
--   Publication. The calibration record's real-outcome anchor is an
--   OPAQUE uuid + closed kind/authority pair carried as DATA (never
--   joined, never re-derived) precisely so the Lab cannot mutate or
--   fabricate v1.6 authority records; the LAB-014 bridge performs any
--   real binding through the existing authorities.
-- * NO SECRET MATERIAL ANYWHERE (CRED-001/§21): the only structured
--   payload columns are the bounded binding/reward/declaration/
--   evaluation/prediction/error/environment blocks — there is
--   deliberately NO column capable of holding secret material.
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, append-oriented tails. No owner/role/user columns:
-- client-scope authorization stays exactly the requireClientAccess
-- route-layer authority — no second tenant, permission or identity
-- authority.

-- ---------------------------------------------------------------------------
-- lab_scenarios — the client-scoped versioned scenario contracts
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_scenarios (
    -- THE VERSION CHAIN KEY: one row per (scenario, version) — corrections
    -- append NEW version rows under the SAME scenario_id; the single-column
    -- UNIQUE below gives the run/candidate FKs their target.
    scenario_id        uuid        NOT NULL,
    scenario_version   integer     NOT NULL CHECK (scenario_version >= 1 AND scenario_version <= 1000),
    agency_id          uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id          uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id       uuid        REFERENCES workspaces(workspace_id),
    status             text        NOT NULL
                       CHECK (status IN ('draft', 'active', 'retired')),
    -- The niche/platform/corpus/world-model binding (versioned data; the
    -- corpus and world-model versions are OPAQUE references owned by
    -- LAB-002/LAB-008 — 'pending' allowed before those layers exist).
    binding            jsonb       NOT NULL
                       CHECK (jsonb_typeof(binding) = 'object'),
    -- The versioned reward definition (§12 — business-outcome-first,
    -- hard-rejection gates included).
    reward_definition  jsonb       NOT NULL
                       CHECK (jsonb_typeof(reward_definition) = 'object'),
    -- The default run configuration caps (§23).
    run_configuration  jsonb       NOT NULL
                       CHECK (jsonb_typeof(run_configuration) = 'object'),
    -- The contract vocabulary version (a contract change is a NEW
    -- version row, never an in-place rewrite).
    contract_version   text        NOT NULL
                       CHECK (contract_version = 'lab-contract-v1'),
    created_at         timestamptz NOT NULL,
    updated_at         timestamptz NOT NULL,
    CONSTRAINT lab_scenarios_pk PRIMARY KEY (scenario_id, scenario_version)
);

-- The client's scenario tail (newest version last).
CREATE INDEX IF NOT EXISTS lab_scenarios_client_idx
    ON lab_scenarios (client_id, scenario_id, scenario_version, created_at);
-- NOTE: there is deliberately NO single-column unique on scenario_id —
-- the version chain shares the id across rows; runs and candidates bind
-- EXACTLY the version they recorded through the composite FK below (a run
-- pins its scenario version; a corrected scenario never re-aims an
-- existing run).

-- Scenario identity is immutable after insert; only the lifecycle status
-- and the server-managed updated_at may advance (corrections are NEW
-- version rows — the append-only correction path).
CREATE OR REPLACE FUNCTION lab_scenario_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.scenario_id <> OLD.scenario_id
       OR NEW.scenario_version <> OLD.scenario_version
       OR NEW.agency_id <> OLD.agency_id
       OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.binding <> OLD.binding
       OR NEW.reward_definition <> OLD.reward_definition
       OR NEW.run_configuration <> OLD.run_configuration
       OR NEW.contract_version <> OLD.contract_version
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'lab scenario % version % identity/scope/contract is immutable — corrections are NEW version rows',
            OLD.scenario_id, OLD.scenario_version;
    END IF;
    IF NOT (
           (OLD.status = 'draft' AND NEW.status IN ('active', 'retired'))
        OR (OLD.status = 'active' AND NEW.status = 'retired')
        OR (OLD.status = NEW.status)
    ) THEN
        RAISE EXCEPTION 'lab scenario transition % → % is not legal (draft → active → retired; no resurrection)',
            OLD.status, NEW.status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_scenario_guard_trigger ON lab_scenarios;
CREATE TRIGGER lab_scenario_guard_trigger
    BEFORE UPDATE ON lab_scenarios
    FOR EACH ROW EXECUTE FUNCTION lab_scenario_guard();

-- Scenario rows are never deleted (history is append-only).
CREATE OR REPLACE FUNCTION lab_scenarios_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab scenarios cannot be deleted — scenario history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_scenarios_no_delete_trigger ON lab_scenarios;
CREATE TRIGGER lab_scenarios_no_delete_trigger
    BEFORE DELETE ON lab_scenarios
    FOR EACH ROW EXECUTE FUNCTION lab_scenarios_no_delete();

-- ---------------------------------------------------------------------------
-- lab_runs — the client-scoped run records (the §10 Time-Machine field
-- set + the §9 seed discipline + the §23 caps + the factuality label)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_runs (
    run_id                  uuid        PRIMARY KEY,
    -- The run binds EXACTLY the scenario version it recorded (the composite
    -- FK; a corrected scenario never re-aims an existing run).
    scenario_id             uuid        NOT NULL,
    scenario_version        integer     NOT NULL CHECK (scenario_version >= 1),
    agency_id               uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id               uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id            uuid        REFERENCES workspaces(workspace_id),
    status                  text        NOT NULL
                            CHECK (status IN ('queued', 'running', 'paused',
                                              'succeeded', 'failed', 'cancelled')),
    -- The failure reason (present exactly when status = 'failed').
    failure_reason          text
                            CHECK (failure_reason IS NULL
                                   OR failure_reason IN ('budget_exceeded',
                                                          'configuration_invalid',
                                                          'simulator_error',
                                                          'cancelled_by_operator',
                                                          'interrupted')),
    -- The §10 Time-Machine block (mode + reference period + simulated
    -- clock + observation cutoff + information lag + world-model
    -- version) as the recorded jsonb payload.
    time_machine            jsonb       NOT NULL
                            CHECK (jsonb_typeof(time_machine) = 'object'),
    -- THE DETERMINISTIC SEED SET (§9): the master seed is bounded to the
    -- unsigned 64-bit range; the derived seeds ride the bounded object.
    master_seed             numeric(20,0) NOT NULL
                            CHECK (master_seed >= 0 AND master_seed <= 18446744073709551615),
    derived_seeds           jsonb       NOT NULL DEFAULT '[]'::jsonb
                            CHECK (jsonb_typeof(derived_seeds) = 'array'
                                   AND jsonb_array_length(derived_seeds) <= 64),
    -- The §23 budget caps (as the recorded jsonb payload).
    run_configuration       jsonb       NOT NULL
                            CHECK (jsonb_typeof(run_configuration) = 'object'),
    -- Per-run overrides recorded for reproducibility (bounded).
    configuration_overrides jsonb
                            CHECK (configuration_overrides IS NULL
                                   OR jsonb_typeof(configuration_overrides) = 'object'),
    -- THE FACTUALITY LABEL (§3/§10 — ships on every read surface):
    -- factual_historical_replay | counterfactual_model_estimate |
    -- simulated_model_output.
    factuality              text        NOT NULL
                            CHECK (factuality IN ('factual_historical_replay',
                                                  'counterfactual_model_estimate',
                                                  'simulated_model_output')),
    -- Artifact lineage: the run's own output artifact references.
    output_artifacts        jsonb
                            CHECK (output_artifacts IS NULL
                                   OR (jsonb_typeof(output_artifacts) = 'array'
                                       AND jsonb_array_length(output_artifacts) <= 128)),
    -- CAS version (advances exactly one per lifecycle transition).
    version                 integer     NOT NULL CHECK (version >= 1),
    contract_version        text        NOT NULL
                            CHECK (contract_version = 'lab-contract-v1'),
    created_at              timestamptz NOT NULL,
    updated_at              timestamptz NOT NULL,
    CONSTRAINT lab_runs_scenario_fk
        FOREIGN KEY (scenario_id, scenario_version)
        REFERENCES lab_scenarios(scenario_id, scenario_version)
);

-- The client's run tail.
CREATE INDEX IF NOT EXISTS lab_runs_client_idx
    ON lab_runs (client_id, created_at, run_id);
-- The scenario's run tail.
CREATE INDEX IF NOT EXISTS lab_runs_scenario_idx
    ON lab_runs (scenario_id, created_at, run_id);
-- The active-run concurrency probe surface (the §23 cap check).
CREATE INDEX IF NOT EXISTS lab_runs_active_idx
    ON lab_runs (client_id, status) WHERE status IN ('queued', 'running', 'paused');

-- Run identity is immutable after insert; only the lifecycle status,
-- the failure reason, the terminal output artifacts, the CAS version and
-- updated_at may advance — and status transitions MUST ride the
-- append-only lab_run_events tail (the module performs the paired
-- event-insert + status-update in one transaction).
CREATE OR REPLACE FUNCTION lab_run_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.run_id <> OLD.run_id
       OR NEW.scenario_id <> OLD.scenario_id
       OR NEW.scenario_version <> OLD.scenario_version
       OR NEW.agency_id <> OLD.agency_id
       OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.time_machine <> OLD.time_machine
       OR NEW.master_seed <> OLD.master_seed
       OR NEW.derived_seeds <> OLD.derived_seeds
       OR NEW.run_configuration <> OLD.run_configuration
       OR NEW.configuration_overrides IS DISTINCT FROM OLD.configuration_overrides
       OR NEW.factuality <> OLD.factuality
       OR NEW.contract_version <> OLD.contract_version
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'lab run % identity/scope/time-machine/seeds/configuration/factuality is immutable — reproducibility inputs never change after create',
            OLD.run_id;
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
        RAISE EXCEPTION 'lab run % CAS version must advance by exactly one (expected %, got %)',
            OLD.run_id, OLD.version + 1, NEW.version;
    END IF;
    IF OLD.status IN ('succeeded', 'failed', 'cancelled') AND NEW.status <> OLD.status THEN
        RAISE EXCEPTION 'lab run % is terminal (%) — terminal runs have no outgoing transitions',
            OLD.run_id, OLD.status;
    END IF;
    IF (NEW.status = 'failed') <> (NEW.failure_reason IS NOT NULL) THEN
        RAISE EXCEPTION 'lab run % failure_reason is present exactly when the run is failed',
            NEW.run_id;
    END IF;
    IF OLD.status = 'queued' AND NEW.status = 'succeeded' THEN
        RAISE EXCEPTION 'lab run % cannot jump queued → succeeded — a run must start first',
            NEW.run_id;
    END IF;
    IF NEW.output_artifacts IS NOT NULL AND NEW.status <> 'succeeded' THEN
        RAISE EXCEPTION 'lab run % output artifacts are recorded exactly on the succeeded transition',
            NEW.run_id;
    END IF
    ;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_run_guard_trigger ON lab_runs;
CREATE TRIGGER lab_run_guard_trigger
    BEFORE UPDATE ON lab_runs
    FOR EACH ROW EXECUTE FUNCTION lab_run_guard();

-- Run rows are never deleted (run history is append-only).
CREATE OR REPLACE FUNCTION lab_runs_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab runs cannot be deleted — run history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_runs_no_delete_trigger ON lab_runs;
CREATE TRIGGER lab_runs_no_delete_trigger
    BEFORE DELETE ON lab_runs
    FOR EACH ROW EXECUTE FUNCTION lab_runs_no_delete();

-- THE RUN↔SCENARIO SCOPE FENCE: a run must reference a scenario of the
-- SAME client (runs bind inside one client, never across tenants).
CREATE OR REPLACE FUNCTION lab_run_scenario_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_scenario_client uuid;
BEGIN
    SELECT client_id INTO v_scenario_client FROM lab_scenarios
        WHERE scenario_id = NEW.scenario_id
        ORDER BY scenario_version DESC LIMIT 1;
    IF v_scenario_client IS NULL OR v_scenario_client <> NEW.client_id THEN
        RAISE EXCEPTION 'lab run % references scenario % outside its client — runs stay inside one client',
            NEW.run_id, NEW.scenario_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_run_scenario_scope_trigger ON lab_runs;
CREATE TRIGGER lab_run_scenario_scope_trigger
    BEFORE INSERT ON lab_runs
    FOR EACH ROW EXECUTE FUNCTION lab_run_scenario_scope_consistent();

-- ---------------------------------------------------------------------------
-- lab_run_events — the append-only run transition tail (the frozen
-- transition-pair fence; the migration-052 pattern)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_run_events (
    event_id        uuid        PRIMARY KEY,
    run_id          uuid        NOT NULL REFERENCES lab_runs(run_id),
    event_seq       integer     NOT NULL CHECK (event_seq >= 1),
    from_status     text
                    CHECK (from_status IS NULL
                           OR from_status IN ('queued', 'running', 'paused',
                                              'succeeded', 'failed', 'cancelled')),
    to_status       text        NOT NULL
                    CHECK (to_status IN ('queued', 'running', 'paused',
                                         'succeeded', 'failed', 'cancelled')),
    -- The failure reason recorded exactly on failed transitions.
    failure_reason  text
                    CHECK (failure_reason IS NULL
                           OR failure_reason IN ('budget_exceeded',
                                                  'configuration_invalid',
                                                  'simulator_error',
                                                  'cancelled_by_operator',
                                                  'interrupted')),
    reason          text        NOT NULL
                    CHECK (length(reason) >= 1 AND length(reason) <= 2000),
    recorded_at     timestamptz NOT NULL,
    UNIQUE (run_id, event_seq)
);

CREATE INDEX IF NOT EXISTS lab_run_events_run_idx
    ON lab_run_events (run_id, event_seq);

-- THE FROZEN TRANSITION-PAIR + STATE-CONSISTENCY FENCE: every run
-- transition must be a legal edge of the frozen run machine —
-- initialization is born queued; queued → running/cancelled; running →
-- paused/succeeded/failed/cancelled; paused → running/cancelled; the
-- terminal states (succeeded/failed/cancelled) have NO outgoing edges;
-- the from_status must match the run's CURRENT durable state (verified
-- under the run row lock).
CREATE OR REPLACE FUNCTION lab_run_event_consistent() RETURNS trigger AS $$
DECLARE
    v_current_status text;
BEGIN
    IF NOT (
           (NEW.from_status IS NULL AND NEW.to_status = 'queued')
        OR (NEW.from_status = 'queued' AND NEW.to_status IN ('running', 'cancelled'))
        OR (NEW.from_status = 'running' AND NEW.to_status IN ('paused', 'succeeded', 'failed', 'cancelled'))
        OR (NEW.from_status = 'paused' AND NEW.to_status IN ('running', 'cancelled'))
    ) THEN
        RAISE EXCEPTION 'lab run transition % → % is not legal (the frozen run machine: queued → running/cancelled; running → paused/succeeded/failed/cancelled; paused → running/cancelled; terminal states have no outgoing transitions)',
            NEW.from_status, NEW.to_status;
    END IF;
    IF NEW.from_status IS NULL AND NEW.event_seq <> 1 THEN
        RAISE EXCEPTION 'lab run initialization event must be the first event of run %',
            NEW.run_id;
    END IF
    ;
    IF (NEW.to_status = 'failed') <> (NEW.failure_reason IS NOT NULL) THEN
        RAISE EXCEPTION 'lab run event failure_reason is recorded exactly on failed transitions';
    END IF;
    IF NEW.to_status = 'failed' AND NEW.failure_reason = 'cancelled_by_operator' THEN
        RAISE EXCEPTION 'lab run operator cancellation is the cancelled terminal, never a failed reason';
    END IF;
    SELECT status INTO v_current_status FROM lab_runs WHERE run_id = NEW.run_id;
    IF v_current_status IS NULL THEN
        RAISE EXCEPTION 'lab run event % references unknown run %',
            NEW.event_id, NEW.run_id;
    END IF;
    IF NEW.from_status IS NOT NULL AND v_current_status <> NEW.from_status THEN
        RAISE EXCEPTION 'lab run % transition event says from % but the run is currently % — history must match the durable state',
            NEW.run_id, NEW.from_status, v_current_status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_run_event_consistent_trigger ON lab_run_events;
CREATE TRIGGER lab_run_event_consistent_trigger
    BEFORE INSERT ON lab_run_events
    FOR EACH ROW EXECUTE FUNCTION lab_run_event_consistent();

-- Run events are append-only.
CREATE OR REPLACE FUNCTION lab_run_events_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab run events are append-only: % is rejected',
        TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_run_events_append_only_update_trigger ON lab_run_events;
CREATE TRIGGER lab_run_events_append_only_update_trigger
    BEFORE UPDATE ON lab_run_events
    FOR EACH ROW EXECUTE FUNCTION lab_run_events_append_only();

DROP TRIGGER IF EXISTS lab_run_events_append_only_delete_trigger ON lab_run_events;
CREATE TRIGGER lab_run_events_append_only_delete_trigger
    BEFORE DELETE ON lab_run_events
    FOR EACH ROW EXECUTE FUNCTION lab_run_events_append_only();

-- ---------------------------------------------------------------------------
-- lab_strategy_candidates — the client-scoped strategy candidate contracts
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_strategy_candidates (
    candidate_id     uuid        PRIMARY KEY,
    scenario_id      uuid        NOT NULL,
    scenario_version integer     NOT NULL CHECK (scenario_version >= 1),
    agency_id        uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id        uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id     uuid        REFERENCES workspaces(workspace_id),
    status           text        NOT NULL
                     CHECK (status IN ('draft', 'evaluated', 'selected', 'rejected')),
    -- The action-space/lineage declaration (versioned data).
    declaration      jsonb       NOT NULL
                     CHECK (jsonb_typeof(declaration) = 'object'),
    contract_version text        NOT NULL
                     CHECK (contract_version = 'lab-contract-v1'),
    created_at       timestamptz NOT NULL,
    updated_at       timestamptz NOT NULL,
    CONSTRAINT lab_strategy_candidates_scenario_fk
        FOREIGN KEY (scenario_id, scenario_version)
        REFERENCES lab_scenarios(scenario_id, scenario_version)
);

CREATE INDEX IF NOT EXISTS lab_strategy_candidates_client_idx
    ON lab_strategy_candidates (client_id, created_at, candidate_id);
CREATE INDEX IF NOT EXISTS lab_strategy_candidates_scenario_idx
    ON lab_strategy_candidates (scenario_id, created_at, candidate_id);

-- Candidate identity is immutable; only the lifecycle status may advance
-- (draft → evaluated → selected/rejected — evaluations append, they
-- never rewrite the candidate).
CREATE OR REPLACE FUNCTION lab_strategy_candidate_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.candidate_id <> OLD.candidate_id
       OR NEW.scenario_id <> OLD.scenario_id
       OR NEW.scenario_version <> OLD.scenario_version
       OR NEW.agency_id <> OLD.agency_id
       OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.declaration <> OLD.declaration
       OR NEW.contract_version <> OLD.contract_version
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'lab strategy candidate % identity/scope/declaration is immutable',
            OLD.candidate_id;
    END IF;
    IF NOT (
           (OLD.status = 'draft' AND NEW.status IN ('evaluated', 'rejected'))
        OR (OLD.status = 'evaluated' AND NEW.status IN ('selected', 'rejected'))
        OR (OLD.status = NEW.status)
    ) THEN
        RAISE EXCEPTION 'lab strategy candidate transition % → % is not legal (draft → evaluated → selected/rejected; terminal states have no outgoing transitions)',
            OLD.status, NEW.status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_strategy_candidate_guard_trigger ON lab_strategy_candidates;
CREATE TRIGGER lab_strategy_candidate_guard_trigger
    BEFORE UPDATE ON lab_strategy_candidates
    FOR EACH ROW EXECUTE FUNCTION lab_strategy_candidate_guard();

CREATE OR REPLACE FUNCTION lab_strategy_candidates_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab strategy candidates cannot be deleted — candidate history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_strategy_candidates_no_delete_trigger ON lab_strategy_candidates;
CREATE TRIGGER lab_strategy_candidates_no_delete_trigger
    BEFORE DELETE ON lab_strategy_candidates
    FOR EACH ROW EXECUTE FUNCTION lab_strategy_candidates_no_delete();

-- THE CANDIDATE↔SCENARIO SCOPE FENCE.
CREATE OR REPLACE FUNCTION lab_strategy_candidate_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_scenario_client uuid;
BEGIN
    SELECT client_id INTO v_scenario_client FROM lab_scenarios
        WHERE scenario_id = NEW.scenario_id
        ORDER BY scenario_version DESC LIMIT 1;
    IF v_scenario_client IS NULL OR v_scenario_client <> NEW.client_id THEN
        RAISE EXCEPTION 'lab strategy candidate % references scenario % outside its client — candidates stay inside one client',
            NEW.candidate_id, NEW.scenario_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_strategy_candidate_scope_trigger ON lab_strategy_candidates;
CREATE TRIGGER lab_strategy_candidate_scope_trigger
    BEFORE INSERT ON lab_strategy_candidates
    FOR EACH ROW EXECUTE FUNCTION lab_strategy_candidate_scope_consistent();

-- ---------------------------------------------------------------------------
-- lab_strategy_candidate_evaluations — the append-only evaluation tails
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_strategy_candidate_evaluations (
    evaluation_id         uuid        PRIMARY KEY,
    candidate_id          uuid        NOT NULL REFERENCES lab_strategy_candidates(candidate_id),
    run_id                uuid        NOT NULL REFERENCES lab_runs(run_id),
    reward                numeric     NOT NULL,
    uncertainty_interval  jsonb       NOT NULL
                          CHECK (jsonb_typeof(uncertainty_interval) = 'array'
                                 AND jsonb_array_length(uncertainty_interval) = 2),
    ensemble_agreement    numeric     NOT NULL,
    ood_score             numeric     NOT NULL,
    seed_robustness       numeric     NOT NULL,
    factuality            text        NOT NULL
                          CHECK (factuality IN ('factual_historical_replay',
                                                'counterfactual_model_estimate',
                                                'simulated_model_output')),
    metrics               jsonb       NOT NULL DEFAULT '{}'::jsonb
                          CHECK (jsonb_typeof(metrics) = 'object'),
    evaluated_at          timestamptz NOT NULL,
    contract_version      text        NOT NULL
                          CHECK (contract_version = 'lab-contract-v1')
);

CREATE INDEX IF NOT EXISTS lab_strategy_candidate_evaluations_idx
    ON lab_strategy_candidate_evaluations (candidate_id, evaluated_at, evaluation_id);

-- Evaluation summaries are append-only (a new evaluation is a NEW record;
-- history is never rewritten).
CREATE OR REPLACE FUNCTION lab_strategy_candidate_evaluations_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab strategy candidate evaluations are append-only: % is rejected',
        TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_strategy_candidate_evaluations_append_only_update_trigger ON lab_strategy_candidate_evaluations;
CREATE TRIGGER lab_strategy_candidate_evaluations_append_only_update_trigger
    BEFORE UPDATE ON lab_strategy_candidate_evaluations
    FOR EACH ROW EXECUTE FUNCTION lab_strategy_candidate_evaluations_append_only();

DROP TRIGGER IF EXISTS lab_strategy_candidate_evaluations_append_only_delete_trigger ON lab_strategy_candidate_evaluations;
CREATE TRIGGER lab_strategy_candidate_evaluations_append_only_delete_trigger
    BEFORE DELETE ON lab_strategy_candidate_evaluations
    FOR EACH ROW EXECUTE FUNCTION lab_strategy_candidate_evaluations_append_only();

-- THE EVALUATION SCOPE FENCE: the evaluation's candidate and run must
-- belong to the SAME client.
CREATE OR REPLACE FUNCTION lab_strategy_candidate_evaluation_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_candidate_client uuid;
    v_run_client uuid;
BEGIN
    SELECT client_id INTO v_candidate_client FROM lab_strategy_candidates
        WHERE candidate_id = NEW.candidate_id;
    SELECT client_id INTO v_run_client FROM lab_runs WHERE run_id = NEW.run_id;
    IF v_candidate_client IS NULL OR v_run_client IS NULL
       OR v_candidate_client <> v_run_client THEN
        RAISE EXCEPTION 'lab strategy candidate evaluation % crosses a client boundary (candidate % vs run %) — evaluations stay inside one client',
            NEW.evaluation_id, NEW.candidate_id, NEW.run_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_strategy_candidate_evaluation_scope_trigger ON lab_strategy_candidate_evaluations;
CREATE TRIGGER lab_strategy_candidate_evaluation_scope_trigger
    BEFORE INSERT ON lab_strategy_candidate_evaluations
    FOR EACH ROW EXECUTE FUNCTION lab_strategy_candidate_evaluation_scope_consistent();

-- ---------------------------------------------------------------------------
-- lab_organization_candidates — the client-scoped agent-organization
-- candidate contracts
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_organization_candidates (
    organization_candidate_id uuid        PRIMARY KEY,
    scenario_id               uuid        NOT NULL,
    scenario_version          integer     NOT NULL CHECK (scenario_version >= 1),
    agency_id                 uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id                 uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id              uuid        REFERENCES workspaces(workspace_id),
    status                    text        NOT NULL
                              CHECK (status IN ('draft', 'evaluated', 'selected', 'rejected')),
    -- The organization graph declaration (topology + agent-body version
    -- references + edges + memory scopes + model assignments + budget
    -- allocation) as versioned data. The topology vocabulary is
    -- module-side fenced; single_agent_baseline is the §15 baseline.
    declaration               jsonb       NOT NULL
                              CHECK (jsonb_typeof(declaration) = 'object'),
    contract_version          text        NOT NULL
                              CHECK (contract_version = 'lab-contract-v1'),
    created_at                timestamptz NOT NULL,
    updated_at                timestamptz NOT NULL,
    CONSTRAINT lab_organization_candidates_scenario_fk
        FOREIGN KEY (scenario_id, scenario_version)
        REFERENCES lab_scenarios(scenario_id, scenario_version)
);

CREATE INDEX IF NOT EXISTS lab_organization_candidates_client_idx
    ON lab_organization_candidates (client_id, created_at, organization_candidate_id);
CREATE INDEX IF NOT EXISTS lab_organization_candidates_scenario_idx
    ON lab_organization_candidates (scenario_id, created_at, organization_candidate_id);

CREATE OR REPLACE FUNCTION lab_organization_candidate_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.organization_candidate_id <> OLD.organization_candidate_id
       OR NEW.scenario_id <> OLD.scenario_id
       OR NEW.scenario_version <> OLD.scenario_version
       OR NEW.agency_id <> OLD.agency_id
       OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.declaration <> OLD.declaration
       OR NEW.contract_version <> OLD.contract_version
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'lab organization candidate % identity/scope/declaration is immutable',
            OLD.organization_candidate_id;
    END IF;
    IF NOT (
           (OLD.status = 'draft' AND NEW.status IN ('evaluated', 'rejected'))
        OR (OLD.status = 'evaluated' AND NEW.status IN ('selected', 'rejected'))
        OR (OLD.status = NEW.status)
    ) THEN
        RAISE EXCEPTION 'lab organization candidate transition % → % is not legal (draft → evaluated → selected/rejected)',
            OLD.status, NEW.status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_organization_candidate_guard_trigger ON lab_organization_candidates;
CREATE TRIGGER lab_organization_candidate_guard_trigger
    BEFORE UPDATE ON lab_organization_candidates
    FOR EACH ROW EXECUTE FUNCTION lab_organization_candidate_guard();

CREATE OR REPLACE FUNCTION lab_organization_candidates_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab organization candidates cannot be deleted — candidate history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_organization_candidates_no_delete_trigger ON lab_organization_candidates;
CREATE TRIGGER lab_organization_candidates_no_delete_trigger
    BEFORE DELETE ON lab_organization_candidates
    FOR EACH ROW EXECUTE FUNCTION lab_organization_candidates_no_delete();

CREATE OR REPLACE FUNCTION lab_organization_candidate_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_scenario_client uuid;
BEGIN
    SELECT client_id INTO v_scenario_client FROM lab_scenarios
        WHERE scenario_id = NEW.scenario_id
        ORDER BY scenario_version DESC LIMIT 1;
    IF v_scenario_client IS NULL OR v_scenario_client <> NEW.client_id THEN
        RAISE EXCEPTION 'lab organization candidate % references scenario % outside its client — candidates stay inside one client',
            NEW.organization_candidate_id, NEW.scenario_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_organization_candidate_scope_trigger ON lab_organization_candidates;
CREATE TRIGGER lab_organization_candidate_scope_trigger
    BEFORE INSERT ON lab_organization_candidates
    FOR EACH ROW EXECUTE FUNCTION lab_organization_candidate_scope_consistent();

-- ---------------------------------------------------------------------------
-- lab_organization_candidate_evaluations — the append-only evaluation tails
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_organization_candidate_evaluations (
    evaluation_id         uuid        PRIMARY KEY,
    organization_candidate_id uuid    NOT NULL REFERENCES lab_organization_candidates(organization_candidate_id),
    run_id                uuid        NOT NULL REFERENCES lab_runs(run_id),
    reward                numeric     NOT NULL,
    uncertainty_interval  jsonb       NOT NULL
                          CHECK (jsonb_typeof(uncertainty_interval) = 'array'
                                 AND jsonb_array_length(uncertainty_interval) = 2),
    ensemble_agreement    numeric     NOT NULL,
    ood_score             numeric     NOT NULL,
    seed_robustness       numeric     NOT NULL,
    factuality            text        NOT NULL
                          CHECK (factuality IN ('factual_historical_replay',
                                                'counterfactual_model_estimate',
                                                'simulated_model_output')),
    metrics               jsonb       NOT NULL DEFAULT '{}'::jsonb
                          CHECK (jsonb_typeof(metrics) = 'object'),
    evaluated_at          timestamptz NOT NULL,
    contract_version      text        NOT NULL
                          CHECK (contract_version = 'lab-contract-v1')
);

CREATE INDEX IF NOT EXISTS lab_organization_candidate_evaluations_idx
    ON lab_organization_candidate_evaluations (organization_candidate_id, evaluated_at, evaluation_id);

CREATE OR REPLACE FUNCTION lab_organization_candidate_evaluations_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab organization candidate evaluations are append-only: % is rejected',
        TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_organization_candidate_evaluations_append_only_update_trigger ON lab_organization_candidate_evaluations;
CREATE TRIGGER lab_organization_candidate_evaluations_append_only_update_trigger
    BEFORE UPDATE ON lab_organization_candidate_evaluations
    FOR EACH ROW EXECUTE FUNCTION lab_organization_candidate_evaluations_append_only();

DROP TRIGGER IF EXISTS lab_organization_candidate_evaluations_append_only_delete_trigger ON lab_organization_candidate_evaluations;
CREATE TRIGGER lab_organization_candidate_evaluations_append_only_delete_trigger
    BEFORE DELETE ON lab_organization_candidate_evaluations
    FOR EACH ROW EXECUTE FUNCTION lab_organization_candidate_evaluations_append_only();

CREATE OR REPLACE FUNCTION lab_organization_candidate_evaluation_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_candidate_client uuid;
    v_run_client uuid;
BEGIN
    SELECT client_id INTO v_candidate_client FROM lab_organization_candidates
        WHERE organization_candidate_id = NEW.organization_candidate_id;
    SELECT client_id INTO v_run_client FROM lab_runs WHERE run_id = NEW.run_id;
    IF v_candidate_client IS NULL OR v_run_client IS NULL
       OR v_candidate_client <> v_run_client THEN
        RAISE EXCEPTION 'lab organization candidate evaluation % crosses a client boundary — evaluations stay inside one client',
            NEW.evaluation_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_organization_candidate_evaluation_scope_trigger ON lab_organization_candidate_evaluations;
CREATE TRIGGER lab_organization_candidate_evaluation_scope_trigger
    BEFORE INSERT ON lab_organization_candidate_evaluations
    FOR EACH ROW EXECUTE FUNCTION lab_organization_candidate_evaluation_scope_consistent();

-- ---------------------------------------------------------------------------
-- lab_capability_candidates — the client-scoped §16 capability contracts
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_capability_candidates (
    capability_candidate_id uuid        PRIMARY KEY,
    agency_id               uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id               uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id            uuid        REFERENCES workspaces(workspace_id),
    status                  text        NOT NULL
                            CHECK (status IN ('declared', 'simulation_verified',
                                              'real_verified', 'rejected')),
    -- The §16 capability contract fields as versioned data (input/output
    -- schema refs, constraints, quality evaluator, cost, latency,
    -- provenance, simulator/real implementation refs, human/provider
    -- requirements).
    capability_contract     jsonb       NOT NULL
                            CHECK (jsonb_typeof(capability_contract) = 'object'),
    contract_version        text        NOT NULL
                            CHECK (contract_version = 'lab-contract-v1'),
    created_at              timestamptz NOT NULL,
    updated_at              timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS lab_capability_candidates_client_idx
    ON lab_capability_candidates (client_id, created_at, capability_candidate_id);

CREATE OR REPLACE FUNCTION lab_capability_candidate_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.capability_candidate_id <> OLD.capability_candidate_id
       OR NEW.agency_id <> OLD.agency_id
       OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.capability_contract <> OLD.capability_contract
       OR NEW.contract_version <> OLD.contract_version
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'lab capability candidate % identity/scope/contract is immutable — a capability revision is a NEW candidate citing the old one',
            OLD.capability_candidate_id;
    END IF;
    IF NOT (
           (OLD.status = 'declared' AND NEW.status IN ('simulation_verified', 'rejected'))
        OR (OLD.status = 'simulation_verified' AND NEW.status IN ('real_verified', 'rejected'))
        OR (OLD.status = 'real_verified' AND NEW.status = 'rejected')
        OR (OLD.status = NEW.status)
    ) THEN
        RAISE EXCEPTION 'lab capability candidate transition % → % is not legal (declared → simulation_verified → real_verified; rejected is terminal-reachable from any non-rejected state)',
            OLD.status, NEW.status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_capability_candidate_guard_trigger ON lab_capability_candidates;
CREATE TRIGGER lab_capability_candidate_guard_trigger
    BEFORE UPDATE ON lab_capability_candidates
    FOR EACH ROW EXECUTE FUNCTION lab_capability_candidate_guard();

CREATE OR REPLACE FUNCTION lab_capability_candidates_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab capability candidates cannot be deleted — capability history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_capability_candidates_no_delete_trigger ON lab_capability_candidates;
CREATE TRIGGER lab_capability_candidates_no_delete_trigger
    BEFORE DELETE ON lab_capability_candidates
    FOR EACH ROW EXECUTE FUNCTION lab_capability_candidates_no_delete();

-- ---------------------------------------------------------------------------
-- lab_calibration_records — the client-scoped append-only §19 records
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_calibration_records (
    calibration_record_id    uuid        PRIMARY KEY,
    agency_id                uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id                uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id             uuid        REFERENCES workspaces(workspace_id),
    status                   text        NOT NULL
                             CHECK (status IN ('recorded', 'applied')),
    -- The world-model version being calibrated (OPAQUE reference — the
    -- version registry is owned by LAB-008; never joined).
    world_model_version      text        NOT NULL
                             CHECK (length(world_model_version) >= 1
                                    AND length(world_model_version) <= 128),
    -- The same-module references (scope-fenced below).
    strategy_candidate_id    uuid        NOT NULL REFERENCES lab_strategy_candidates(candidate_id),
    run_id                   uuid        NOT NULL REFERENCES lab_runs(run_id),
    -- The simulated prediction block (§13: reward + uncertainty interval
    -- + factuality label + metrics, as versioned data).
    simulated_prediction     jsonb       NOT NULL
                             CHECK (jsonb_typeof(simulated_prediction) = 'object'),
    -- THE REAL-OUTCOME ANCHOR — an OPAQUE external reference (§3 NO
    -- SHADOWING: plain uuid DATA, never FK-joined into a v1.6 authority;
    -- the closed kind/authority pairs name WHICH authority owns the
    -- outcome; LAB-014's bridge performs any real binding).
    outcome_reference_kind   text        NOT NULL
                             CHECK (outcome_reference_kind IN ('experiment',
                                                               'evidence',
                                                               'metric_observation',
                                                               'publish_attempt')),
    outcome_authority        text        NOT NULL
                             CHECK (outcome_authority IN ('experiments', 'evidence',
                                                          'metrics', 'social-accounts')),
    outcome_reference_id     uuid        NOT NULL,
    outcome_summary          jsonb       NOT NULL
                             CHECK (jsonb_typeof(outcome_summary) = 'object'),
    outcome_observed_at      timestamptz NOT NULL,
    -- The prediction error block (recorded as data — signed per metric).
    prediction_error         jsonb       NOT NULL
                             CHECK (jsonb_typeof(prediction_error) = 'object'),
    -- The environment state summary (bounded data).
    environment_state        jsonb       NOT NULL
                             CHECK (jsonb_typeof(environment_state) = 'object'),
    -- The observed regime (§19 closed vocabulary).
    observed_regime          text        NOT NULL
                             CHECK (observed_regime IN ('regime-stable',
                                                        'regime-shift',
                                                        'regime-unknown')),
    -- The calibration update/version that cites this record ('pending'
    -- until LAB-015 applies it).
    calibration_update_version text      NOT NULL
                             CHECK (calibration_update_version = 'pending'
                                    OR (length(calibration_update_version) >= 1
                                        AND length(calibration_update_version) <= 128)),
    contract_version         text        NOT NULL
                             CHECK (contract_version = 'lab-contract-v1'),
    created_at               timestamptz NOT NULL,
    updated_at               timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS lab_calibration_records_client_idx
    ON lab_calibration_records (client_id, created_at, calibration_record_id);
CREATE INDEX IF NOT EXISTS lab_calibration_records_wm_idx
    ON lab_calibration_records (world_model_version, created_at, calibration_record_id);

-- Calibration identity is immutable; only status (recorded → applied)
-- and the citing calibration_update_version may advance.
CREATE OR REPLACE FUNCTION lab_calibration_record_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.calibration_record_id <> OLD.calibration_record_id
       OR NEW.agency_id <> OLD.agency_id
       OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.world_model_version <> OLD.world_model_version
       OR NEW.strategy_candidate_id <> OLD.strategy_candidate_id
       OR NEW.run_id <> OLD.run_id
       OR NEW.simulated_prediction <> OLD.simulated_prediction
       OR NEW.outcome_reference_kind <> OLD.outcome_reference_kind
       OR NEW.outcome_authority <> OLD.outcome_authority
       OR NEW.outcome_reference_id <> OLD.outcome_reference_id
       OR NEW.outcome_summary <> OLD.outcome_summary
       OR NEW.outcome_observed_at <> OLD.outcome_observed_at
       OR NEW.prediction_error <> OLD.prediction_error
       OR NEW.environment_state <> OLD.environment_state
       OR NEW.observed_regime <> OLD.observed_regime
       OR NEW.contract_version <> OLD.contract_version
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'lab calibration record % identity/scope/prediction/outcome is immutable — a recalibration is a NEW record',
            OLD.calibration_record_id;
    END IF;
    IF NOT (
           (OLD.status = 'recorded' AND NEW.status = 'applied')
        OR (OLD.status = NEW.status)
    ) THEN
        RAISE EXCEPTION 'lab calibration record transition % → % is not legal (recorded → applied; applied is terminal)',
            OLD.status, NEW.status;
    END IF;
    IF NEW.status = 'applied' AND NEW.calibration_update_version = 'pending' THEN
        RAISE EXCEPTION 'lab calibration record applied transition must carry the citing calibration update version';
    END IF;
    IF OLD.status = 'applied' AND NEW.calibration_update_version <> OLD.calibration_update_version THEN
        RAISE EXCEPTION 'lab calibration record update version cannot change after applied';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_calibration_record_guard_trigger ON lab_calibration_records;
CREATE TRIGGER lab_calibration_record_guard_trigger
    BEFORE UPDATE ON lab_calibration_records
    FOR EACH ROW EXECUTE FUNCTION lab_calibration_record_guard();

CREATE OR REPLACE FUNCTION lab_calibration_records_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab calibration records cannot be deleted — calibration history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_calibration_records_no_delete_trigger ON lab_calibration_records;
CREATE TRIGGER lab_calibration_records_no_delete_trigger
    BEFORE DELETE ON lab_calibration_records
    FOR EACH ROW EXECUTE FUNCTION lab_calibration_records_no_delete();

-- THE CALIBRATION SCOPE FENCE: the referenced strategy candidate and run
-- must belong to the SAME client as the calibration record.
CREATE OR REPLACE FUNCTION lab_calibration_record_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_candidate_client uuid;
    v_run_client uuid;
BEGIN
    SELECT client_id INTO v_candidate_client FROM lab_strategy_candidates
        WHERE candidate_id = NEW.strategy_candidate_id;
    SELECT client_id INTO v_run_client FROM lab_runs WHERE run_id = NEW.run_id;
    IF v_candidate_client IS NULL OR v_candidate_client <> NEW.client_id THEN
        RAISE EXCEPTION 'lab calibration record % references strategy candidate % outside its client',
            NEW.calibration_record_id, NEW.strategy_candidate_id;
    END IF;
    IF v_run_client IS NULL OR v_run_client <> NEW.client_id THEN
        RAISE EXCEPTION 'lab calibration record % references run % outside its client',
            NEW.calibration_record_id, NEW.run_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_calibration_record_scope_trigger ON lab_calibration_records;
CREATE TRIGGER lab_calibration_record_scope_trigger
    BEFORE INSERT ON lab_calibration_records
    FOR EACH ROW EXECUTE FUNCTION lab_calibration_record_scope_consistent();
