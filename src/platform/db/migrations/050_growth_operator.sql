-- 050_growth_operator.sql — MKT-054 (Growth Operator).
--
-- The GROWTH OPERATOR durable controller layer (spec/effective-backlog-v1.6.md
-- MKT-054: "persistent goal-pursuit controller that selects bounded next
-- experiments/actions and delegates all physical work to existing
-- Workflow/Execution authorities"; spec/architecture-v1.6.md §13: "Growth
-- Operator is a persistent controller, not a workflow engine. It can inspect
-- mission state, inspect current evidence and learnings, select or create the
-- next bounded experiment, request an existing Playbook/Workflow/Execution
-- path, wait for measurement, request analysis, record decisions, update
-- learning and replan. All physical work continues through existing
-- Workflow/Execution authorities. The controller is idempotent and
-- resumable."; spec/architecture-lock-v1.6.md rule 17: "Growth Operator is a
-- decision/replanning controller and is never a second Workflow or Execution
-- engine"; spec/module-dependency-matrix-v1.6.md boundary rule 3: "Growth
-- Operator can create/advance mission decisions but cannot own
-- workflow/execution lifecycle").
--
--   growth_operator_controllers  → ONE controller per mission (UNIQUE
--                                  mission_id): the pursuit scope (the
--                                  validated Client/Workspace the delegated
--                                  work runs in, derived server-side from
--                                  canonical ownership), the frozen
--                                  controller STATE MACHINE, the strategy
--                                  version, the budget/quota policy (max
--                                  in-flight steps, max delegated steps,
--                                  the OPTIONAL human-amplification budget +
--                                  eligible-capacity inputs — zero by
--                                  default) and the CAS version;
--   growth_operator_plan_steps  → the bounded next-experiment/action steps:
--                                  the selected treatment family, the
--                                  explicit rationale, the cited evidence
--                                  refs, the evidence SNAPSHOT DIGEST the
--                                  plan was computed against (idempotent
--                                  replanning: same mission state + evidence
--                                  snapshot → same plan) and the DETERMINISTIC
--                                  idempotency key (UNIQUE per mission —
--                                  the no-double-dispatch fence); the
--                                  delegation identity columns (experiment /
--                                  decision-ledger / workflow / definition /
--                                  instance / execution / observation
--                                  evidence references) fill progressively
--                                  while the step is 'planned';
--   growth_operator_decisions   → the APPEND-ONLY operator decision tail
--                                  (the controller's own auditable decision
--                                  records: controller_initialized / replan /
--                                  delegation / observation /
--                                  gate_encountered / state_transition /
--                                  termination — each with rationale +
--                                  evidence refs + kind-specific structured
--                                  detail; UPDATE and DELETE are rejected
--                                  outright — replans are append-only
--                                  decision records, never silent history
--                                  rewrites);
--   growth_operator_events      → the APPEND-ONLY state-transition audit
--                                  trail (every controller state change with
--                                  from/to + REQUIRED reason + the blocked
--                                  gate kind when entering
--                                  blocked_pending_human_action + the honest
--                                  terminal cause on terminal transitions;
--                                  UPDATE and DELETE are rejected outright).
--
-- Frozen semantics encoded here (FROZEN — never a caller freedom):
--
-- * THE CONTROLLER STATE VOCABULARY (MKT-054: running / paused /
--   blocked_pending_human_action / terminal (achieved / exhausted /
--   terminated-by-policy)) — CHECK-fenced on the controller row and on every
--   event state column, versioned as go-vocab-v1 in the module.
-- * THE HONEST-STATE RULE (architecture-v1.6.md §2: "The controller never
--   silently converts a block into success."): the frozen transition-pair
--   trigger rejects any illegal (from_status → to_status) pair — terminal
--   states have NO outgoing pairs; blocked/paused resume ONLY to running.
-- * THE BLOCKED-STATE SHAPE: entering blocked_pending_human_action requires
--   a REQUIRED block reason + a genuine gate kind (rights/policy/capability
--   — CHECK-fenced); the ONLY truthful human blocker is a genuine
--   rights/policy/capability gate.
-- * THE PLAN-STEP IDEMPOTENCY FENCE: UNIQUE (mission_id, idempotency_key) —
--   a replayed plan command converges to the recorded step; the same
--   mission state + evidence snapshot yields the same deterministic key, so
--   a restart can never double-dispatch the same plan step.
-- * THE PLAN-STEP LIFECYCLE: planned → dispatched → observed (and planned →
--   superseded for a deliberately replaced plan). The bounded UPDATE
--   discipline: while 'planned' the row may only gain delegation identity
--   fills or move to dispatched/superseded; 'dispatched' may only move to
--   'observed' with the observed outcome set; 'observed'/'superseded' rows
--   are FROZEN (any further UPDATE is rejected by trigger). DELETE is
--   rejected outright — plan history is append-only.
-- * THE APPEND-ONLY TAILS: decisions and events reject UPDATE and DELETE
--   outright — not even server code can rewrite operator history. The
--   per-mission decision sequence and the per-controller event sequence are
--   gapless (UNIQUE (mission_id, decision_seq) / (controller_id, event_seq),
--   assigned under the owning row lock).
-- * THE BUDGET/QUOTA FENCES: max_in_flight_steps ∈ [1,5];
--   max_delegated_steps is null (unlimited) or > 0; the human-amplification
--   budget and eligible capacity are >= 0 and DEFAULT TO ZERO — the
--   zero-human state is the DEFAULT configuration, never an error.
-- * NO SECOND EXECUTION ENGINE (rule 17 / boundary rule 3): this migration
--   creates NO task, job, dispatch, queue, sandbox-lease, worker-pool or
--   execution-lifecycle table of its own — the delegation identity columns
--   REFERENCE the existing authorities' tables (experiments 019, decisions
--   036, workflows 009, executions 011, evidence 015) as FK-anchored
--   REFERENCES ONLY; no row of another authority is ever created or mutated
--   from these tables (all delegation flows through the authorities' own
--   public commands from the module).
-- * NO HUMAN-MARKETPLACE DEPENDENCY (rules 43/44; matrix rules 11/12): no
--   field-agent, job, offer or human-work table is created or referenced;
--   the human-amplification inputs are BUDGET/EVIDENCE columns on the
--   controller row, not marketplace state.
-- * NO SECRET MATERIAL ANYWHERE (CRED-001/§21): the only structured payload
--   columns are the bounded plan rationale/evidence references, the
--   kind-specific decision detail and the recorded human-amplification
--   consideration — there is deliberately NO column capable of holding
--   secret material, a secret handle or any free-form caller payload beyond
--   the declared bounded controller content.
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, row-locked CAS mutations, append-oriented tails. No
-- owner/role/user columns beyond provenance: agency-scope authorization
-- stays exactly the /agencies membership + platform-role authorities
-- resolved at the route layer — no second tenant, permission or identity
-- authority.

-- ---------------------------------------------------------------------------
-- growth_operator_controllers — one persistent controller per mission
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS growth_operator_controllers (
    controller_id       uuid        PRIMARY KEY,
    -- ONE controller per mission (the persistent pursuit identity).
    mission_id          uuid        NOT NULL UNIQUE REFERENCES growth_missions(mission_id),
    -- The mission's agency (denormalized from the mission row, immutable,
    -- trigger-verified to match the mission's agency).
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    -- The pursuit scope: the Client/Workspace the delegated work runs in.
    -- Server-derived at initialization from canonical ownership (the
    -- pursuit workspace resolves through its owning client to the mission's
    -- agency BEFORE any write) and immutable thereafter.
    pursuit_client_id   uuid        NOT NULL REFERENCES clients(client_id),
    pursuit_workspace_id uuid      NOT NULL REFERENCES workspaces(workspace_id),
    -- The delegation container: the mission's pursuit WORKFLOW, created
    -- through the /workflows public command at first delegation (nullable
    -- until then; convergent find-or-create by deterministic name).
    pursuit_workflow_id uuid        REFERENCES workflows(workflow_id),
    -- The frozen controller state vocabulary (go-vocab-v1).
    status              text        NOT NULL
                        CHECK (status IN ('running', 'paused',
                                          'blocked_pending_human_action',
                                          'achieved', 'exhausted',
                                          'terminated_by_policy')),
    -- REQUIRED while blocked (the honest record of WHAT human action is
    -- pending); must be cleared to resume.
    blocked_reason      text
                        CHECK (blocked_reason IS NULL
                               OR (length(blocked_reason) >= 1
                                   AND length(blocked_reason) <= 2000)),
    -- The genuine gate kind recorded when entering
    -- blocked_pending_human_action (rights/policy/capability — never a
    -- marketplace dependency).
    blocked_gate_kind   text
                        CHECK (blocked_gate_kind IS NULL
                               OR blocked_gate_kind IN ('rights', 'policy', 'capability')),
    -- The strategy-space version the selection runs under (go-strategy-v1
    -- — a change to the bounded family set/scoring is a NEW version).
    strategy_version    text        NOT NULL
                        CHECK (length(strategy_version) >= 1
                               AND length(strategy_version) <= 64),
    -- The frozen vocabulary version (go-vocab-v1).
    vocabulary_version  text        NOT NULL
                        CHECK (length(vocabulary_version) >= 1
                               AND length(vocabulary_version) <= 64),
    -- BUDGET/QUOTA POLICY (architecture-v1.6.md §17): bounded in-flight
    -- delegation concurrency; total delegation budget (null = unlimited);
    -- the OPTIONAL human-amplification inputs, ZERO BY DEFAULT — the
    -- zero-human state is the normal default, never an error (rules 43/44).
    max_in_flight_steps integer     NOT NULL DEFAULT 1
                        CHECK (max_in_flight_steps >= 1 AND max_in_flight_steps <= 5),
    max_delegated_steps integer
                        CHECK (max_delegated_steps IS NULL OR max_delegated_steps > 0),
    human_amplification_budget integer NOT NULL DEFAULT 0
                        CHECK (human_amplification_budget >= 0),
    human_amplification_eligible_capacity integer NOT NULL DEFAULT 0
                        CHECK (human_amplification_eligible_capacity >= 0),
    -- CAS token (every mutation advances by exactly one).
    version             integer     NOT NULL DEFAULT 1
                        CHECK (version >= 1),
    -- SERVER-DERIVED provenance (never request fields).
    created_actor       text        NOT NULL
                        CHECK (length(created_actor) >= 1 AND length(created_actor) <= 100),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS growth_operator_controllers_agency_idx
    ON growth_operator_controllers (agency_id, created_at, controller_id);

-- CONTROLLER MUTATION GUARD: identity/scope/policy/provenance are
-- immutable; the CAS version advances by exactly one; the blocked-shape
-- fence (blocked ⇒ reason + gate kind; not blocked ⇒ both clear); the
-- pursuit workflow reference only ever fills (never changes once set).
CREATE OR REPLACE FUNCTION growth_operator_controller_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.controller_id <> OLD.controller_id
       OR NEW.mission_id <> OLD.mission_id
       OR NEW.agency_id <> OLD.agency_id
       OR NEW.pursuit_client_id <> OLD.pursuit_client_id
       OR NEW.pursuit_workspace_id <> OLD.pursuit_workspace_id
       OR NEW.strategy_version <> OLD.strategy_version
       OR NEW.vocabulary_version <> OLD.vocabulary_version
       OR NEW.max_in_flight_steps <> OLD.max_in_flight_steps
       OR NEW.max_delegated_steps IS DISTINCT FROM OLD.max_delegated_steps
       OR NEW.human_amplification_budget <> OLD.human_amplification_budget
       OR NEW.human_amplification_eligible_capacity <> OLD.human_amplification_eligible_capacity
       OR NEW.created_actor <> OLD.created_actor
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'growth operator controller % identity/scope/policy/provenance is immutable — budget/policy changes require a NEW controller generation',
            OLD.controller_id;
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
        RAISE EXCEPTION 'growth operator controller % CAS version must advance by exactly one (expected %, got %)',
            OLD.controller_id, OLD.version + 1, NEW.version;
    END IF;
    IF (NEW.pursuit_workflow_id IS NOT NULL AND OLD.pursuit_workflow_id IS NOT NULL
        AND NEW.pursuit_workflow_id <> OLD.pursuit_workflow_id) THEN
        RAISE EXCEPTION 'growth operator controller % pursuit workflow reference cannot change once set',
            OLD.controller_id;
    END IF;
    IF NEW.status = 'blocked_pending_human_action' THEN
        IF NEW.blocked_reason IS NULL OR NEW.blocked_gate_kind IS NULL THEN
            RAISE EXCEPTION 'growth operator controller % entering blocked_pending_human_action requires a block reason AND a genuine gate kind (rights/policy/capability)',
                OLD.controller_id;
        END IF;
    ELSE
        IF NEW.blocked_reason IS NOT NULL OR NEW.blocked_gate_kind IS NOT NULL THEN
            RAISE EXCEPTION 'growth operator controller % block reason/gate kind may only be set while blocked_pending_human_action',
                OLD.controller_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_operator_controller_guard_trigger ON growth_operator_controllers;
CREATE TRIGGER growth_operator_controller_guard_trigger
    BEFORE UPDATE ON growth_operator_controllers
    FOR EACH ROW EXECUTE FUNCTION growth_operator_controller_guard();

-- Controllers are never deleted (pursuit history is append-only).
CREATE OR REPLACE FUNCTION growth_operator_controllers_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'growth operator controllers cannot be deleted — pursuit history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_operator_controllers_no_delete_trigger ON growth_operator_controllers;
CREATE TRIGGER growth_operator_controllers_no_delete_trigger
    BEFORE DELETE ON growth_operator_controllers
    FOR EACH ROW EXECUTE FUNCTION growth_operator_controllers_no_delete();

-- ---------------------------------------------------------------------------
-- growth_operator_plan_steps — the bounded next-experiment/action steps
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS growth_operator_plan_steps (
    step_id             uuid        PRIMARY KEY,
    controller_id       uuid        NOT NULL REFERENCES growth_operator_controllers(controller_id),
    -- Denormalized mission reference (the idempotency fence scope).
    mission_id          uuid        NOT NULL REFERENCES growth_missions(mission_id),
    -- Gapless per-controller step sequence (assigned under the controller
    -- row lock).
    step_seq            integer     NOT NULL CHECK (step_seq >= 1),
    -- THE NO-DOUBLE-DISPATCH FENCE: the DETERMINISTIC idempotency key of
    -- this plan command (derived from the strategy version + the evidence
    -- snapshot digest + the sequence — the same mission state + evidence
    -- snapshot yields the same key, so replays converge to ONE step).
    idempotency_key     text        NOT NULL
                        CHECK (length(idempotency_key) >= 1
                               AND length(idempotency_key) <= 200),
    -- The frozen bounded treatment-family vocabulary (go-strategy-v1).
    treatment_family    text        NOT NULL
                        CHECK (treatment_family IN
                               ('owned_channel_publish', 'content_variant_test',
                                'channel_reallocation', 'measurement_enrichment',
                                'human_amplification')),
    -- The explicit selection rationale (REQUIRED, bounded, honest).
    rationale           text        NOT NULL
                        CHECK (length(rationale) >= 1 AND length(rationale) <= 2000),
    -- The evidence snapshot digest the plan was computed against (the
    -- idempotent-replanning anchor: same digest + same mission state →
    -- same plan).
    evidence_snapshot_digest text   NOT NULL
                        CHECK (length(evidence_snapshot_digest) >= 1
                               AND length(evidence_snapshot_digest) <= 128),
    -- The evidence ids the plan cites (bounded array of canonical ids).
    evidence_refs       jsonb       NOT NULL DEFAULT '[]'::jsonb
                        CHECK (jsonb_typeof(evidence_refs) = 'array'
                               AND jsonb_array_length(evidence_refs) <= 50),
    -- The recorded human-amplification consideration of this replan (the
    -- zero-human state is a RECORDED strategy input, never an absence).
    considered_human    jsonb       NOT NULL
                        CHECK (jsonb_typeof(considered_human) = 'object'),
    -- THE DELEGATION IDENTITY (filled progressively while 'planned';
    -- frozen once 'dispatched'): the experiment, the Decision-Ledger
    -- record, the workflow/definition/instance and the §8-idempotent
    -- execution — every one created through the EXISTING authority's
    -- public command, never here.
    experiment_id       uuid        REFERENCES experiments(experiment_id),
    decision_id         uuid        REFERENCES decisions(decision_id),
    workflow_id         uuid        REFERENCES workflows(workflow_id),
    workflow_definition_id uuid     REFERENCES workflow_definitions(workflow_definition_id),
    workflow_instance_id uuid       REFERENCES workflow_instances(workflow_instance_id),
    execution_id        uuid        REFERENCES executions(execution_id),
    -- The observed-outcome fill (set exactly once, when 'observed').
    observed_outcome    text
                        CHECK (observed_outcome IS NULL
                               OR observed_outcome IN
                                   ('delegated_work_succeeded',
                                    'delegated_work_failed',
                                    'delegated_work_cancelled')),
    observation_evidence_id uuid    REFERENCES evidence(evidence_id),
    observed_at         timestamptz,
    -- The bounded step lifecycle.
    state               text        NOT NULL DEFAULT 'planned'
                        CHECK (state IN ('planned', 'dispatched', 'observed', 'superseded')),
    version             integer     NOT NULL DEFAULT 1
                        CHECK (version >= 1),
    created_actor       text        NOT NULL
                        CHECK (length(created_actor) >= 1 AND length(created_actor) <= 100),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (mission_id, idempotency_key),
    UNIQUE (controller_id, step_seq)
);

CREATE INDEX IF NOT EXISTS growth_operator_plan_steps_mission_idx
    ON growth_operator_plan_steps (mission_id, step_seq);
CREATE INDEX IF NOT EXISTS growth_operator_plan_steps_controller_state_idx
    ON growth_operator_plan_steps (controller_id, state);

-- PLAN-STEP MUTATION GUARD: the plan identity (controller/mission/sequence/
-- key/family/rationale/digest/evidence/consideration) is immutable; the
-- lifecycle advances along the frozen edges (planned → dispatched |
-- superseded; dispatched → observed); the delegation identity columns only
-- ever FILL (never change once set); the observation triple fills exactly
-- on the transition into 'observed'; CAS advances by exactly one.
CREATE OR REPLACE FUNCTION growth_operator_plan_step_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.step_id <> OLD.step_id
       OR NEW.controller_id <> OLD.controller_id
       OR NEW.mission_id <> OLD.mission_id
       OR NEW.step_seq <> OLD.step_seq
       OR NEW.idempotency_key <> OLD.idempotency_key
       OR NEW.treatment_family <> OLD.treatment_family
       OR NEW.rationale <> OLD.rationale
       OR NEW.evidence_snapshot_digest <> OLD.evidence_snapshot_digest
       OR NEW.evidence_refs <> OLD.evidence_refs
       OR NEW.considered_human <> OLD.considered_human
       OR NEW.created_actor <> OLD.created_actor
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'growth operator plan step % identity is immutable — a changed plan is a NEW append-only step',
            OLD.step_id;
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
        RAISE EXCEPTION 'growth operator plan step % CAS version must advance by exactly one (expected %, got %)',
            OLD.step_id, OLD.version + 1, NEW.version;
    END IF;
    -- Delegation identity columns only ever FILL (null → value), never change.
    IF (OLD.experiment_id IS NOT NULL AND NEW.experiment_id IS DISTINCT FROM OLD.experiment_id)
       OR (OLD.decision_id IS NOT NULL AND NEW.decision_id IS DISTINCT FROM OLD.decision_id)
       OR (OLD.workflow_id IS NOT NULL AND NEW.workflow_id IS DISTINCT FROM OLD.workflow_id)
       OR (OLD.workflow_definition_id IS NOT NULL AND NEW.workflow_definition_id IS DISTINCT FROM OLD.workflow_definition_id)
       OR (OLD.workflow_instance_id IS NOT NULL AND NEW.workflow_instance_id IS DISTINCT FROM OLD.workflow_instance_id)
       OR (OLD.execution_id IS NOT NULL AND NEW.execution_id IS DISTINCT FROM OLD.execution_id) THEN
        RAISE EXCEPTION 'growth operator plan step % delegation references cannot change once set',
            OLD.step_id;
    END IF;
    -- The frozen lifecycle edges.
    IF NOT (
           (OLD.state = 'planned' AND NEW.state IN ('dispatched', 'superseded'))
        OR (OLD.state = 'dispatched' AND NEW.state = 'observed')
        OR (OLD.state = NEW.state)
    ) THEN
        RAISE EXCEPTION 'growth operator plan step % transition % → % is not legal (planned → dispatched | superseded; dispatched → observed; observed/superseded are frozen)',
            OLD.step_id, OLD.state, NEW.state;
    END IF;
    -- The observation triple fills EXACTLY on the transition into observed.
    IF NEW.state = 'observed' THEN
        IF NEW.observed_outcome IS NULL OR NEW.observed_at IS NULL THEN
            RAISE EXCEPTION 'growth operator plan step % entering observed requires the observed outcome and timestamp',
                OLD.step_id;
        END IF;
    ELSE
        IF NEW.observed_outcome IS NOT NULL OR NEW.observed_at IS NOT NULL
           OR NEW.observation_evidence_id IS NOT NULL THEN
            RAISE EXCEPTION 'growth operator plan step % observation may only be recorded on the dispatched → observed transition',
                OLD.step_id;
        END IF;
    END IF;
    -- A dispatched step MUST carry the full delegation identity (the work
    -- was requested through every existing authority).
    IF NEW.state IN ('dispatched', 'observed') THEN
        IF NEW.experiment_id IS NULL OR NEW.decision_id IS NULL
           OR NEW.workflow_id IS NULL OR NEW.workflow_definition_id IS NULL
           OR NEW.workflow_instance_id IS NULL OR NEW.execution_id IS NULL THEN
            RAISE EXCEPTION 'growth operator plan step % must carry the full delegation identity before dispatch',
                OLD.step_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_operator_plan_step_guard_trigger ON growth_operator_plan_steps;
CREATE TRIGGER growth_operator_plan_step_guard_trigger
    BEFORE UPDATE ON growth_operator_plan_steps
    FOR EACH ROW EXECUTE FUNCTION growth_operator_plan_step_guard();

-- Plan steps are never deleted (plan history is append-only).
CREATE OR REPLACE FUNCTION growth_operator_plan_steps_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'growth operator plan steps cannot be deleted — plan history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_operator_plan_steps_no_delete_trigger ON growth_operator_plan_steps;
CREATE TRIGGER growth_operator_plan_steps_no_delete_trigger
    BEFORE DELETE ON growth_operator_plan_steps
    FOR EACH ROW EXECUTE FUNCTION growth_operator_plan_steps_no_delete();

-- ---------------------------------------------------------------------------
-- growth_operator_decisions — the append-only operator decision tail
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS growth_operator_decisions (
    decision_id         uuid        PRIMARY KEY,
    controller_id       uuid        NOT NULL REFERENCES growth_operator_controllers(controller_id),
    -- Denormalized mission reference (the gapless sequence scope).
    mission_id          uuid        NOT NULL REFERENCES growth_missions(mission_id),
    -- Gapless per-mission decision sequence (assigned under the controller
    -- row lock).
    decision_seq        integer     NOT NULL CHECK (decision_seq >= 1),
    -- The frozen operator decision-kind vocabulary (go-vocab-v1).
    decision_kind       text        NOT NULL
                        CHECK (decision_kind IN
                               ('controller_initialized', 'replan', 'delegation',
                                'observation', 'gate_encountered', 'state_transition',
                                'termination')),
    -- The treatment family when the decision concerns one (else null).
    treatment_family    text
                        CHECK (treatment_family IS NULL
                               OR treatment_family IN
                                   ('owned_channel_publish', 'content_variant_test',
                                    'channel_reallocation', 'measurement_enrichment',
                                    'human_amplification')),
    -- The REQUIRED honest rationale (bounded).
    rationale           text        NOT NULL
                        CHECK (length(rationale) >= 1 AND length(rationale) <= 2000),
    -- The evidence ids the decision cites (bounded array).
    evidence_refs       jsonb       NOT NULL DEFAULT '[]'::jsonb
                        CHECK (jsonb_typeof(evidence_refs) = 'array'
                               AND jsonb_array_length(evidence_refs) <= 50),
    -- The kind-specific structured detail (never prose-only).
    detail              jsonb       NOT NULL
                        CHECK (jsonb_typeof(detail) = 'object'),
    -- SERVER-DERIVED provenance of the decision (never request fields).
    actor               text        NOT NULL
                        CHECK (length(actor) >= 1 AND length(actor) <= 100),
    recorded_via        text        NOT NULL
                        CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 64),
    correlation_id      text        NOT NULL
                        CHECK (length(correlation_id) >= 1 AND length(correlation_id) <= 128),
    causation_id        text
                        CHECK (causation_id IS NULL
                               OR (length(causation_id) >= 1 AND length(causation_id) <= 128)),
    recorded_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (mission_id, decision_seq)
);

CREATE INDEX IF NOT EXISTS growth_operator_decisions_mission_idx
    ON growth_operator_decisions (mission_id, decision_seq);
CREATE INDEX IF NOT EXISTS growth_operator_decisions_controller_idx
    ON growth_operator_decisions (controller_id, recorded_at, decision_id);

-- APPEND-ONLY DECISION TAIL (the migration 036/044 pattern): the database
-- itself rejects UPDATE and DELETE on the operator decision history — not
-- even server code can rewrite what was decided.
CREATE OR REPLACE FUNCTION growth_operator_decisions_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'growth operator decisions are append-only: % is rejected on decision %',
        TG_OP, OLD.decision_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_operator_decisions_append_only_update_trigger ON growth_operator_decisions;
CREATE TRIGGER growth_operator_decisions_append_only_update_trigger
    BEFORE UPDATE ON growth_operator_decisions
    FOR EACH ROW EXECUTE FUNCTION growth_operator_decisions_append_only();

DROP TRIGGER IF EXISTS growth_operator_decisions_append_only_delete_trigger ON growth_operator_decisions;
CREATE TRIGGER growth_operator_decisions_append_only_delete_trigger
    BEFORE DELETE ON growth_operator_decisions
    FOR EACH ROW EXECUTE FUNCTION growth_operator_decisions_append_only();

-- ---------------------------------------------------------------------------
-- growth_operator_events — the append-only state-transition audit trail
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS growth_operator_events (
    event_id            uuid        PRIMARY KEY,
    controller_id       uuid        NOT NULL REFERENCES growth_operator_controllers(controller_id),
    -- Denormalized mission reference.
    mission_id          uuid        NOT NULL REFERENCES growth_missions(mission_id),
    -- Gapless per-controller event sequence (assigned under the controller
    -- row lock).
    event_seq           integer     NOT NULL CHECK (event_seq >= 1),
    -- The frozen state-transition event shape: from (null on
    -- initialization) + to + REQUIRED reason.
    from_status         text
                        CHECK (from_status IS NULL
                               OR from_status IN ('running', 'paused',
                                                  'blocked_pending_human_action',
                                                  'achieved', 'exhausted',
                                                  'terminated_by_policy')),
    to_status           text        NOT NULL
                        CHECK (to_status IN ('running', 'paused',
                                            'blocked_pending_human_action',
                                            'achieved', 'exhausted',
                                            'terminated_by_policy')),
    -- The honest terminal cause recorded on terminal transitions.
    terminal_cause      text
                        CHECK (terminal_cause IS NULL
                               OR (length(terminal_cause) >= 1
                                   AND length(terminal_cause) <= 200)),
    -- The genuine gate kind recorded when entering
    -- blocked_pending_human_action (rights/policy/capability).
    blocked_gate_kind   text
                        CHECK (blocked_gate_kind IS NULL
                               OR blocked_gate_kind IN ('rights', 'policy', 'capability')),
    -- The REQUIRED honest transition reason (bounded).
    reason              text        NOT NULL
                        CHECK (length(reason) >= 1 AND length(reason) <= 2000),
    -- SERVER-DERIVED provenance (never request fields).
    actor               text        NOT NULL
                        CHECK (length(actor) >= 1 AND length(actor) <= 100),
    recorded_via        text        NOT NULL
                        CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 64),
    correlation_id      text        NOT NULL
                        CHECK (length(correlation_id) >= 1 AND length(correlation_id) <= 128),
    causation_id        text
                        CHECK (causation_id IS NULL
                               OR (length(causation_id) >= 1 AND length(causation_id) <= 128)),
    recorded_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (controller_id, event_seq)
);

CREATE INDEX IF NOT EXISTS growth_operator_events_controller_idx
    ON growth_operator_events (controller_id, event_seq);
CREATE INDEX IF NOT EXISTS growth_operator_events_mission_idx
    ON growth_operator_events (mission_id, recorded_at, event_id);

-- THE FROZEN TRANSITION-PAIR + STATE-CONSISTENCY FENCE (the migration-045
-- pattern): every state_transition event must be a legal edge of the frozen
-- controller machine (terminal states have NO outgoing pairs; a block is
-- never silently converted into success) and the from_status must match
-- the controller's CURRENT state (verified under the controller row lock).
CREATE OR REPLACE FUNCTION growth_operator_event_consistent() RETURNS trigger AS $$
DECLARE
    v_current_status text;
BEGIN
    IF NOT (
           (NEW.from_status = 'running' AND NEW.to_status IN
              ('paused', 'blocked_pending_human_action', 'achieved',
               'exhausted', 'terminated_by_policy'))
        OR (NEW.from_status = 'paused' AND NEW.to_status IN ('running', 'terminated_by_policy'))
        OR (NEW.from_status = 'blocked_pending_human_action'
              AND NEW.to_status IN ('running', 'terminated_by_policy'))
        OR (NEW.from_status IS NULL AND NEW.to_status = 'running')
    ) THEN
        RAISE EXCEPTION 'growth operator transition % → % is not legal (the frozen controller machine: terminal states have no outgoing transitions; paused/blocked resume only to running; initialization is born running)',
            NEW.from_status, NEW.to_status;
    END IF;
    IF NEW.from_status IS NULL AND NEW.event_seq <> 1 THEN
        RAISE EXCEPTION 'growth operator initialization event must be the first event of controller %',
            NEW.controller_id;
    END IF;
    IF NEW.to_status = 'blocked_pending_human_action' AND NEW.blocked_gate_kind IS NULL THEN
        RAISE EXCEPTION 'growth operator event entering blocked_pending_human_action must record the genuine gate kind (rights/policy/capability)';
    END IF;
    IF NEW.to_status <> 'blocked_pending_human_action' AND NEW.blocked_gate_kind IS NOT NULL THEN
        RAISE EXCEPTION 'growth operator event gate kind may only be recorded on blocked_pending_human_action transitions';
    END IF;
    IF (NEW.to_status IN ('achieved', 'exhausted', 'terminated_by_policy'))
       <> (NEW.terminal_cause IS NOT NULL) THEN
        RAISE EXCEPTION 'growth operator terminal transitions carry the honest terminal cause and non-terminal transitions carry none';
    END IF;
    SELECT status INTO v_current_status FROM growth_operator_controllers
        WHERE controller_id = NEW.controller_id;
    IF v_current_status IS NULL THEN
        RAISE EXCEPTION 'growth operator event % references unknown controller %',
            NEW.event_id, NEW.controller_id;
    END IF;
    IF v_current_status <> NEW.from_status THEN
        RAISE EXCEPTION 'growth operator % transition event says from % but the controller is currently % — history must match the durable state',
            NEW.controller_id, NEW.from_status, v_current_status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_operator_event_consistent_trigger ON growth_operator_events;
CREATE TRIGGER growth_operator_event_consistent_trigger
    BEFORE INSERT ON growth_operator_events
    FOR EACH ROW EXECUTE FUNCTION growth_operator_event_consistent();

-- APPEND-ONLY EVENT TAIL: the database itself rejects UPDATE and DELETE on
-- the controller audit trail — not even server code can rewrite what
-- happened.
CREATE OR REPLACE FUNCTION growth_operator_events_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'growth operator events are append-only: % is rejected on event %',
        TG_OP, OLD.event_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_operator_events_append_only_update_trigger ON growth_operator_events;
CREATE TRIGGER growth_operator_events_append_only_update_trigger
    BEFORE UPDATE ON growth_operator_events
    FOR EACH ROW EXECUTE FUNCTION growth_operator_events_append_only();

DROP TRIGGER IF EXISTS growth_operator_events_append_only_delete_trigger ON growth_operator_events;
CREATE TRIGGER growth_operator_events_append_only_delete_trigger
    BEFORE DELETE ON growth_operator_events
    FOR EACH ROW EXECUTE FUNCTION growth_operator_events_append_only();
