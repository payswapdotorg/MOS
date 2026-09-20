-- 045_growth_missions.sql — MKT-053 (Growth Mission and Objective Model).
--
-- The GROWTH MISSION durable record layer (spec/architecture-v1.6.md §1/§2/§3;
-- spec/architecture-lock-v1.6.md rule 16: "Growth Mission is a durable
-- orchestration layer over existing Goals, Playbooks, Workflows, Executions,
-- Experiments, Evidence and Learning; it is not a replacement authority"):
--
--   growth_missions              → the agency-scoped mission records (the
--                                   declared objective FAMILY + lifecycle
--                                   state + the CAS version + the
--                                   current-version pointer);
--   growth_mission_versions      → the APPEND-ONLY VERSION TAIL (one
--                                   immutable row per declared objective —
--                                   the business outcome VERBATIM + the
--                                   frozen §3 family + the product/market
--                                   context + the provenance; corrections
--                                   are NEW version records, never
--                                   in-place rewrites);
--   growth_mission_target_metrics→ the per-version declared target metrics
--                                   (each binding a named metric to a
--                                   numeric target through an explicit
--                                   comparator, with the INTERMEDIATE flag
--                                   that marks non-terminal-decision metrics);
--   growth_mission_events        → the APPEND-ONLY HISTORY TAIL (every
--                                   lifecycle state transition with
--                                   from/to state + actor + provenance +
--                                   the REQUIRED reason; terminal
--                                   transitions carry the DECLARED objective
--                                   family as their terminal-decision basis;
--                                   the gapless per-mission sequence);
--   growth_mission_goal_mappings → the mission→goal mapping rows (canonical
--                                   goal references through the /goals
--                                   public contract, FK-anchored to the
--                                   migration-007 goals table and
--                                   scope-fenced to the mission's agency;
--                                   removal is an honest UPDATE of the
--                                   removal triple — never a DELETE).
--
-- Frozen semantics encoded here (FROZEN — never a caller freedom):
--
-- * THE §3 OBJECTIVE-FAMILY VOCABULARY (architecture-v1.6.md §3, verbatim):
--   audience_growth, creator_growth, product_marketing, acquisition,
--   lead_generation, revenue, commerce_discovery, hybrid — CHECK-fenced on
--   every family column, and on the terminal-decision-family column of
--   history events. A mission may optimize intermediate metrics, but the
--   TERMINAL decision is evaluated against the declared business objective
--   family: every terminal state_transition event MUST carry it (the
--   terminal-family shape CHECK).
-- * THE §2 LIFECYCLE STATE VOCABULARY (architecture-v1.6.md §2, verbatim):
--   draft/active/paused (non-terminal — the disclosed MKT-053 implementation
--   decision) + the seven TERMINAL states — achieved, stopped_by_user,
--   blocked_pending_human_action, blocked_by_unavailable_capability,
--   budget_quota_exhausted, policy_constrained,
--   failed_after_bounded_recovery — CHECK-fenced on the mission record and
--   on every history event state column.
-- * THE HONEST-STATE RULE (architecture-v1.6.md §2: "The controller never
--   silently converts a block into success."): the frozen transition-pair
--   trigger rejects any illegal (from_status → to_status) pair — terminal
--   states have NO outgoing pairs, and 'achieved' is reachable ONLY from
--   'active'. The state_transition event's from_status must ALSO match the
--   mission's CURRENT state (verified under the module's row lock).
-- * THE IMMUTABLE DECLARED OBJECTIVE: the mission record's identity/scope/
--   provenance columns are immutable (trigger); the version tail and the
--   per-version target metrics reject UPDATE and DELETE outright; the
--   version pointer only ever ADVANCES and must reference an EXISTING
--   declared version of the same mission (trigger); the CAS version must
--   advance by exactly one per mutation (trigger).
-- * THE APPEND-ONLY HISTORY: growth_mission_events rejects UPDATE and
--   DELETE outright — not even server code can rewrite mission history.
--   The event sequence is gapless per mission (UNIQUE (mission_id,
--   event_seq), assigned under the row lock).
-- * THE GOAL MAPPING DISCIPLINE (architecture-lock-v1.6.md rule 16: the
--   Goal authority remains the canonical measurable business-intent
--   authority): mapping rows FK-reference the migration-007 goals table
--   (a dangling reference cannot persist) and are scope-fenced by trigger
--   (the mapped goal's Client must belong to the mission's Agency — the
--   agencies/clients/goals registries are read CHECK-ONLY); mapping changes
--   on a TERMINAL mission are rejected by trigger; an UPDATE may only add
--   the removal triple (removed_at/removed_by/removal_reason — the
--   migration-038 single-supersession precedent); DELETE is rejected; the
--   ACTIVE (mission, goal) fence is partial-unique.
-- * NO AUTHORITY TRANSFER (architecture-lock-v1.6.md rules 16/17): this
--   migration creates NO workflow, execution, playbook, experiment,
--   evidence, learning, job, deployment or tenant table, and NO controller
--   state of any kind — the Growth Operator (MKT-054) is a later Work Item;
--   this module is the durable record contract that later drives it. No
--   goal column is created or mutated here (the /goals authority stays
--   sole; goal progress is never re-stated or re-computed).
-- * NO SECRET MATERIAL ANYWHERE (CRED-001/§21): the only structured
--   payload columns are the bounded product/market context objects and the
--   kind-specific event detail — there is deliberately NO column capable of
--   holding secret material, a secret handle or any free-form caller
--   payload beyond the declared bounded mission content.
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, row-locked CAS mutations, append-oriented tails. No
-- owner/role/user columns beyond provenance: agency-scope authorization
-- stays exactly the /agencies membership + platform-role authorities
-- resolved at the route layer — no second tenant, permission or identity
-- authority.

-- ---------------------------------------------------------------------------
-- growth_missions — the agency-scoped mission records
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS growth_missions (
    mission_id          uuid        PRIMARY KEY,
    -- AGENCY-SCOPED (spec/effective-backlog-v1.6.md MKT-053: agency-scoped
    -- durable mission records; the owning agency is resolved through the
    -- /agencies public contract BEFORE any write and is immutable here).
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    -- The frozen lifecycle state vocabulary (§2): the three disclosed
    -- non-terminal states + the seven TERMINAL §2 states.
    status              text        NOT NULL
                        CHECK (status IN ('draft', 'active', 'paused',
                                          'achieved', 'stopped_by_user',
                                          'blocked_pending_human_action',
                                          'blocked_by_unavailable_capability',
                                          'budget_quota_exhausted',
                                          'policy_constrained',
                                          'failed_after_bounded_recovery')),
    -- The CURRENT declared version (the append-only tail pointer).
    current_version_seq integer     NOT NULL CHECK (current_version_seq >= 1),
    -- The CAS token (row-locked mutations advance it by exactly one).
    version             bigint      NOT NULL CHECK (version >= 1),
    created_actor       text        NOT NULL
                        CHECK (length(created_actor) >= 1 AND length(created_actor) <= 100),
    created_at          timestamptz NOT NULL,
    updated_at          timestamptz NOT NULL
);

-- The agency listing surface (oldest first).
CREATE INDEX IF NOT EXISTS growth_missions_agency_idx
    ON growth_missions (agency_id, created_at, mission_id);

-- MISSION-RECORD MUTATION GUARD: identity/scope/provenance are immutable;
-- the CAS version advances by exactly one; the version pointer only ever
-- ADVANCES and must reference an EXISTING declared version of the same
-- mission (corrections are NEW version records — the pointer can never
-- regress and can never dangle).
CREATE OR REPLACE FUNCTION growth_mission_record_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.mission_id <> OLD.mission_id
       OR NEW.agency_id <> OLD.agency_id
       OR NEW.created_actor <> OLD.created_actor
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'growth mission % identity/scope/provenance is immutable — corrections are new version records, never rewrites',
            OLD.mission_id;
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
        RAISE EXCEPTION 'growth mission % CAS version must advance by exactly one (expected %, got %)',
            OLD.mission_id, OLD.version + 1, NEW.version;
    END IF;
    IF NEW.current_version_seq < OLD.current_version_seq THEN
        RAISE EXCEPTION 'growth mission % current version cannot regress (corrections advance the version tail only)',
            OLD.mission_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM growth_mission_versions v
        WHERE v.mission_id = NEW.mission_id AND v.version_seq = NEW.current_version_seq) THEN
        RAISE EXCEPTION 'growth mission % current_version_seq % must reference an existing declared version of this mission',
            NEW.mission_id, NEW.current_version_seq;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_mission_record_guard_trigger ON growth_missions;
CREATE TRIGGER growth_mission_record_guard_trigger
    BEFORE UPDATE ON growth_missions
    FOR EACH ROW EXECUTE FUNCTION growth_mission_record_guard();

-- Mission records are never deleted (business history is append-only).
CREATE OR REPLACE FUNCTION growth_missions_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'growth missions cannot be deleted — mission history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_missions_no_delete_trigger ON growth_missions;
CREATE TRIGGER growth_missions_no_delete_trigger
    BEFORE DELETE ON growth_missions
    FOR EACH ROW EXECUTE FUNCTION growth_missions_no_delete();

-- ---------------------------------------------------------------------------
-- growth_mission_versions — the append-only declared-objective tail
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS growth_mission_versions (
    mission_version_id  uuid        PRIMARY KEY,
    mission_id          uuid        NOT NULL REFERENCES growth_missions(mission_id),
    -- The version sequence within the mission (gapless from 1, assigned
    -- under the mission row lock).
    version_seq         integer     NOT NULL CHECK (version_seq >= 1),
    -- The DECLARED OBJECTIVE — the business outcome being pursued, VERBATIM
    -- (architecture-v1.6.md §1). IMMUTABLE per version: a correction is a
    -- NEW version row, never a rewrite of this one.
    objective           text        NOT NULL
                        CHECK (length(objective) >= 1 AND length(objective) <= 5000),
    -- The frozen §3 objective-family vocabulary, CHECK-fenced.
    objective_family    text        NOT NULL
                        CHECK (objective_family IN ('audience_growth', 'creator_growth', 'product_marketing',
                                                    'acquisition', 'lead_generation', 'revenue',
                                                    'commerce_discovery', 'hybrid')),
    -- The bounded product/market context objects (validated shapes at the
    -- module boundary; jsonb objects only).
    product_context     jsonb       CHECK (product_context IS NULL OR jsonb_typeof(product_context) = 'object'),
    market_context      jsonb       CHECK (market_context IS NULL OR jsonb_typeof(market_context) = 'object'),
    -- SERVER-DERIVED provenance (never a request field).
    recorded_actor      text        NOT NULL
                        CHECK (length(recorded_actor) >= 1 AND length(recorded_actor) <= 100),
    recorded_via        text        NOT NULL
                        CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 100),
    correlation_id      text        NOT NULL,
    causation_id        text,
    created_at          timestamptz NOT NULL,
    CONSTRAINT growth_mission_versions_seq_unique UNIQUE (mission_id, version_seq)
);

-- APPEND-ONLY VERSION TAIL (the migration 036/044 pattern): the database
-- itself rejects UPDATE and DELETE on the declared objective history — the
-- objective is immutable per version; corrections are NEW records.
CREATE OR REPLACE FUNCTION growth_mission_versions_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'growth mission versions are append-only: % is rejected on version %',
        TG_OP, OLD.mission_version_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_mission_versions_append_only_update_trigger ON growth_mission_versions;
CREATE TRIGGER growth_mission_versions_append_only_update_trigger
    BEFORE UPDATE ON growth_mission_versions
    FOR EACH ROW EXECUTE FUNCTION growth_mission_versions_append_only();

DROP TRIGGER IF EXISTS growth_mission_versions_append_only_delete_trigger ON growth_mission_versions;
CREATE TRIGGER growth_mission_versions_append_only_delete_trigger
    BEFORE DELETE ON growth_mission_versions
    FOR EACH ROW EXECUTE FUNCTION growth_mission_versions_append_only();

-- ---------------------------------------------------------------------------
-- growth_mission_target_metrics — the per-version declared target metrics
-- ---------------------------------------------------------------------------

-- The declared target metrics ride the immutable version snapshot: a
-- metric binds a named metric to a numeric target through an explicit
-- comparator; `intermediate` marks the metrics that are NOT the
-- terminal-decision basis (architecture-v1.6.md §3: "A mission may optimize
-- intermediate metrics, but the terminal decision is evaluated against the
-- declared business objective.").
CREATE TABLE IF NOT EXISTS growth_mission_target_metrics (
    mission_version_id  uuid        NOT NULL REFERENCES growth_mission_versions(mission_version_id),
    metric              text        NOT NULL
                        CHECK (length(metric) >= 1 AND length(metric) <= 100),
    comparator          text        NOT NULL
                        CHECK (comparator IN ('>=', '>', '<=', '<', '==')),
    target_value        numeric     NOT NULL,
    unit                text        CHECK (unit IS NULL OR length(unit) <= 50),
    description         text        CHECK (description IS NULL OR length(description) <= 500),
    intermediate        boolean     NOT NULL,
    CONSTRAINT growth_mission_target_metrics_pk
        PRIMARY KEY (mission_version_id, metric)
);

-- The declared metrics are append-only with their version snapshot.
CREATE OR REPLACE FUNCTION growth_mission_target_metrics_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'growth mission target metrics are append-only: % is rejected',
        TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_mission_target_metrics_append_only_update_trigger ON growth_mission_target_metrics;
CREATE TRIGGER growth_mission_target_metrics_append_only_update_trigger
    BEFORE UPDATE ON growth_mission_target_metrics
    FOR EACH ROW EXECUTE FUNCTION growth_mission_target_metrics_append_only();

DROP TRIGGER IF EXISTS growth_mission_target_metrics_append_only_delete_trigger ON growth_mission_target_metrics;
CREATE TRIGGER growth_mission_target_metrics_append_only_delete_trigger
    BEFORE DELETE ON growth_mission_target_metrics
    FOR EACH ROW EXECUTE FUNCTION growth_mission_target_metrics_append_only();

-- ---------------------------------------------------------------------------
-- growth_mission_events — the append-only history tail
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS growth_mission_events (
    event_id             uuid       PRIMARY KEY,
    mission_id           uuid       NOT NULL REFERENCES growth_missions(mission_id),
    -- The gapless per-mission sequence (assigned under the row lock).
    event_seq            bigint     NOT NULL CHECK (event_seq >= 1),
    event_kind           text       NOT NULL
                         CHECK (event_kind IN ('mission_created', 'version_recorded',
                                               'goal_mapped', 'goal_unmapped', 'state_transition')),
    -- State columns: set ONLY on state_transition events (both together).
    from_status          text       CHECK (from_status IS NULL OR from_status IN
                         ('draft', 'active', 'paused', 'achieved', 'stopped_by_user',
                          'blocked_pending_human_action', 'blocked_by_unavailable_capability',
                          'budget_quota_exhausted', 'policy_constrained',
                          'failed_after_bounded_recovery')),
    to_status            text       CHECK (to_status IS NULL OR to_status IN
                         ('draft', 'active', 'paused', 'achieved', 'stopped_by_user',
                          'blocked_pending_human_action', 'blocked_by_unavailable_capability',
                          'budget_quota_exhausted', 'policy_constrained',
                          'failed_after_bounded_recovery')),
    -- The DECLARED objective family a terminal transition was evaluated
    -- against (architecture-v1.6.md §3 — the terminal-decision basis, made
    -- durable; NULL unless to_status is terminal).
    terminal_decision_family text  CHECK (terminal_decision_family IS NULL OR terminal_decision_family IN
                         ('audience_growth', 'creator_growth', 'product_marketing',
                          'acquisition', 'lead_generation', 'revenue',
                          'commerce_discovery', 'hybrid')),
    -- The REQUIRED reason of a state transition / goal unmapping.
    reason               text       CHECK (reason IS NULL OR (length(reason) >= 1 AND length(reason) <= 2000)),
    -- The kind-specific structured detail (goal id / version seq only).
    detail               jsonb      CHECK (detail IS NULL OR jsonb_typeof(detail) = 'object'),
    -- SERVER-DERIVED provenance (never a request field).
    actor                text       NOT NULL
                         CHECK (length(actor) >= 1 AND length(actor) <= 100),
    recorded_via         text       NOT NULL
                         CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 100),
    correlation_id       text       NOT NULL,
    causation_id         text,
    recorded_at          timestamptz NOT NULL,
    CONSTRAINT growth_mission_events_seq_unique UNIQUE (mission_id, event_seq),
    -- THE EVENT-SHAPE FENCE (the frozen per-kind payloads):
    --   * mission_created: born 'draft', no from-state, no reason requirement
    --     beyond the honest auto-recorded one (the module always sets one);
    --   * version_recorded / goal_mapped: no state columns, no terminal family;
    --   * goal_unmapped: no state columns, REQUIRED reason (honest removal);
    --   * state_transition: BOTH state columns + REQUIRED reason.
    CONSTRAINT growth_mission_event_shape CHECK (
        (event_kind = 'mission_created'
           AND from_status IS NULL AND to_status = 'draft'
           AND terminal_decision_family IS NULL)
        OR (event_kind = 'version_recorded'
           AND from_status IS NULL AND to_status IS NULL
           AND terminal_decision_family IS NULL
           AND reason IS NOT NULL)
        OR (event_kind = 'goal_mapped'
           AND from_status IS NULL AND to_status IS NULL
           AND terminal_decision_family IS NULL
           AND reason IS NOT NULL)
        OR (event_kind = 'goal_unmapped'
           AND from_status IS NULL AND to_status IS NULL
           AND terminal_decision_family IS NULL
           AND reason IS NOT NULL)
        OR (event_kind = 'state_transition'
           AND from_status IS NOT NULL AND to_status IS NOT NULL
           AND reason IS NOT NULL)
    ),
    -- THE TERMINAL-DECISION FENCE (§3 made durable): a transition INTO a
    -- terminal state MUST carry the declared objective family it was
    -- evaluated against; a non-terminal transition NEVER carries one.
    CONSTRAINT growth_mission_terminal_family_shape CHECK (
        (to_status IN ('achieved', 'stopped_by_user', 'blocked_pending_human_action',
                      'blocked_by_unavailable_capability', 'budget_quota_exhausted',
                      'policy_constrained', 'failed_after_bounded_recovery')
           AND terminal_decision_family IS NOT NULL)
        OR ((to_status IS NULL OR to_status NOT IN
             ('achieved', 'stopped_by_user', 'blocked_pending_human_action',
              'blocked_by_unavailable_capability', 'budget_quota_exhausted',
              'policy_constrained', 'failed_after_bounded_recovery'))
           AND terminal_decision_family IS NULL)
    )
);

-- The history scan surface (per-mission, sequence-ordered).
CREATE INDEX IF NOT EXISTS growth_mission_events_mission_idx
    ON growth_mission_events (mission_id, event_seq);

-- THE FROZEN TRANSITION-PAIR TRIGGER (the honest-state rule): only the
-- legal (from_status → to_status) pairs may enter the tail — terminal
-- states have NO outgoing pairs (a block is NEVER silently converted into
-- success; 'achieved' is reachable ONLY from 'active'), and the event's
-- from_status must match the mission's CURRENT state (the module appends
-- the event under the mission row lock BEFORE the record mutation).
CREATE OR REPLACE FUNCTION growth_mission_event_consistent() RETURNS trigger AS $$
DECLARE
    v_current_status text;
BEGIN
    IF NEW.event_kind = 'state_transition' THEN
        IF NOT (
               (NEW.from_status = 'draft' AND NEW.to_status IN ('active', 'stopped_by_user'))
            OR (NEW.from_status = 'active' AND NEW.to_status IN
                  ('paused', 'achieved', 'stopped_by_user', 'blocked_pending_human_action',
                   'blocked_by_unavailable_capability', 'budget_quota_exhausted',
                   'policy_constrained', 'failed_after_bounded_recovery'))
            OR (NEW.from_status = 'paused' AND NEW.to_status IN ('active', 'stopped_by_user'))
        ) THEN
            RAISE EXCEPTION 'growth mission transition % → % is not legal (the frozen lifecycle: terminal states have no outgoing transitions; a block is never silently converted into success)',
                NEW.from_status, NEW.to_status;
        END IF;
        SELECT status INTO v_current_status FROM growth_missions
            WHERE mission_id = NEW.mission_id;
        IF v_current_status IS NULL THEN
            RAISE EXCEPTION 'growth mission event % references unknown mission %',
                NEW.event_id, NEW.mission_id;
        END IF;
        IF v_current_status <> NEW.from_status THEN
            RAISE EXCEPTION 'growth mission % transition event says from % but the mission is currently % — history must match the durable state',
                NEW.mission_id, NEW.from_status, v_current_status;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_mission_event_consistent_trigger ON growth_mission_events;
CREATE TRIGGER growth_mission_event_consistent_trigger
    BEFORE INSERT ON growth_mission_events
    FOR EACH ROW EXECUTE FUNCTION growth_mission_event_consistent();

-- APPEND-ONLY HISTORY TAIL (the migration 036/044 pattern): the database
-- itself rejects UPDATE and DELETE on the mission history — not even
-- server code can rewrite what happened.
CREATE OR REPLACE FUNCTION growth_mission_events_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'growth mission events are append-only: % is rejected on event %',
        TG_OP, OLD.event_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_mission_events_append_only_update_trigger ON growth_mission_events;
CREATE TRIGGER growth_mission_events_append_only_update_trigger
    BEFORE UPDATE ON growth_mission_events
    FOR EACH ROW EXECUTE FUNCTION growth_mission_events_append_only();

DROP TRIGGER IF EXISTS growth_mission_events_append_only_delete_trigger ON growth_mission_events;
CREATE TRIGGER growth_mission_events_append_only_delete_trigger
    BEFORE DELETE ON growth_mission_events
    FOR EACH ROW EXECUTE FUNCTION growth_mission_events_append_only();

-- ---------------------------------------------------------------------------
-- growth_mission_goal_mappings — the mission→goal mapping
-- ---------------------------------------------------------------------------

-- The mapping rows FK-anchor the canonical goal reference to the
-- migration-007 goals table (a dangling reference cannot persist) and are
-- scope-fenced + terminal-fenced + removal-only mutable below. The Goal
-- authority stays the sole owner of goal content and progress; the mission
-- never re-states it.
CREATE TABLE IF NOT EXISTS growth_mission_goal_mappings (
    mapping_id       uuid        PRIMARY KEY,
    mission_id       uuid        NOT NULL REFERENCES growth_missions(mission_id),
    goal_id          uuid        NOT NULL REFERENCES goals(goal_id),
    added_at         timestamptz NOT NULL,
    added_by         text        NOT NULL
                     CHECK (length(added_by) >= 1 AND length(added_by) <= 100),
    -- The honest removal triple (all set together, at most once).
    removed_at       timestamptz,
    removed_by       text        CHECK (removed_by IS NULL OR (length(removed_by) >= 1 AND length(removed_by) <= 100)),
    removal_reason   text        CHECK (removal_reason IS NULL OR (length(removal_reason) >= 1 AND length(removal_reason) <= 2000))
);

-- THE ACTIVE (mission, goal) FENCE: one ACTIVE mapping per (mission, goal)
-- — a removed mapping can be re-added as a NEW row (history preserved).
CREATE UNIQUE INDEX IF NOT EXISTS growth_mission_goal_mappings_active_fence
    ON growth_mission_goal_mappings (mission_id, goal_id)
    WHERE removed_at IS NULL;

-- The mapping scan surface.
CREATE INDEX IF NOT EXISTS growth_mission_goal_mappings_mission_idx
    ON growth_mission_goal_mappings (mission_id, added_at, mapping_id);
CREATE INDEX IF NOT EXISTS growth_mission_goal_mappings_goal_idx
    ON growth_mission_goal_mappings (goal_id);

-- THE AGENCY SCOPE FENCE (the migration 038/044 pattern): the mapped
-- goal's Client must belong to the mission's Agency — a cross-agency goal
-- reference cannot persist even if every application check were bypassed.
-- The goals/clients tables are read CHECK-ONLY (no row of another
-- authority is ever created or mutated here).
CREATE OR REPLACE FUNCTION growth_mission_goal_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_goal_client uuid;
    v_goal_agency uuid;
    v_mission_agency uuid;
BEGIN
    SELECT client_id INTO v_goal_client FROM goals WHERE goal_id = NEW.goal_id;
    IF v_goal_client IS NULL THEN
        RAISE EXCEPTION 'growth mission mapping references unknown goal % — a dangling goal reference cannot persist',
            NEW.goal_id;
    END IF;
    SELECT agency_id INTO v_goal_agency FROM clients WHERE client_id = v_goal_client;
    SELECT agency_id INTO v_mission_agency FROM growth_missions WHERE mission_id = NEW.mission_id;
    IF v_mission_agency IS NULL THEN
        RAISE EXCEPTION 'growth mission mapping references unknown mission %',
            NEW.mission_id;
    END IF;
    IF v_goal_agency IS DISTINCT FROM v_mission_agency THEN
        RAISE EXCEPTION 'growth mission % (agency %) cannot map goal % (client of agency %) — the agency boundary cannot be crossed',
            NEW.mission_id, v_mission_agency, NEW.goal_id, v_goal_agency;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_mission_goal_scope_trigger ON growth_mission_goal_mappings;
CREATE TRIGGER growth_mission_goal_scope_trigger
    BEFORE INSERT ON growth_mission_goal_mappings
    FOR EACH ROW EXECUTE FUNCTION growth_mission_goal_scope_consistent();

-- THE TERMINAL-FREEZE FENCE: goal mappings cannot change on a TERMINAL
-- mission (terminal history is frozen; the module + this trigger agree).
CREATE OR REPLACE FUNCTION growth_mission_mapping_terminal_frozen() RETURNS trigger AS $$
DECLARE
    v_status text;
BEGIN
    SELECT status INTO v_status FROM growth_missions WHERE mission_id = NEW.mission_id;
    IF v_status IN ('achieved', 'stopped_by_user', 'blocked_pending_human_action',
                    'blocked_by_unavailable_capability', 'budget_quota_exhausted',
                    'policy_constrained', 'failed_after_bounded_recovery') THEN
        RAISE EXCEPTION 'growth mission % is % (terminal): its goal mapping cannot change — terminal history is frozen',
            NEW.mission_id, v_status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_mission_mapping_terminal_frozen_trigger ON growth_mission_goal_mappings;
CREATE TRIGGER growth_mission_mapping_terminal_frozen_trigger
    BEFORE INSERT OR UPDATE ON growth_mission_goal_mappings
    FOR EACH ROW EXECUTE FUNCTION growth_mission_mapping_terminal_frozen();

-- THE REMOVAL-ONLY UPDATE FENCE (the migration 038 single-supersession
-- precedent): an UPDATE may only add the removal triple — the mapping
-- identity/history is immutable, the removal happens at most once, and
-- the triple is all-or-nothing. DELETE is rejected outright.
CREATE OR REPLACE FUNCTION growth_mission_mapping_removal_only() RETURNS trigger AS $$
BEGIN
    IF NEW.mapping_id <> OLD.mapping_id
       OR NEW.mission_id <> OLD.mission_id
       OR NEW.goal_id <> OLD.goal_id
       OR NEW.added_at <> OLD.added_at
       OR NEW.added_by <> OLD.added_by THEN
        RAISE EXCEPTION 'growth mission mapping % identity/history is immutable — only the honest removal triple may change',
            OLD.mapping_id;
    END IF;
    IF OLD.removed_at IS NOT NULL
       AND (NEW.removed_at <> OLD.removed_at OR NEW.removed_by <> OLD.removed_by
            OR NEW.removal_reason <> OLD.removal_reason) THEN
        RAISE EXCEPTION 'growth mission mapping % is already removed — the removal triple is final',
            OLD.mapping_id;
    END IF;
    IF (NEW.removed_at IS NULL) <> (NEW.removed_by IS NULL)
       OR (NEW.removed_at IS NULL) <> (NEW.removal_reason IS NULL) THEN
        RAISE EXCEPTION 'growth mission mapping % removal triple must be all-null or all-set',
            NEW.mapping_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_mission_mapping_removal_only_trigger ON growth_mission_goal_mappings;
CREATE TRIGGER growth_mission_mapping_removal_only_trigger
    BEFORE UPDATE ON growth_mission_goal_mappings
    FOR EACH ROW EXECUTE FUNCTION growth_mission_mapping_removal_only();

CREATE OR REPLACE FUNCTION growth_mission_goal_mappings_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'growth mission goal mappings cannot be deleted — goal removal is an honest recorded removal, never an erase';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_mission_goal_mappings_no_delete_trigger ON growth_mission_goal_mappings;
CREATE TRIGGER growth_mission_goal_mappings_no_delete_trigger
    BEFORE DELETE ON growth_mission_goal_mappings
    FOR EACH ROW EXECUTE FUNCTION growth_mission_goal_mappings_no_delete();
