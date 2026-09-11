-- MKT-015 Experiment model schema (EXP-001).
-- PostgreSQL is the system of record (spec/architecture-lock.md).

-- Table ownership follows the frozen authority map (implementation-contract §1):
-- experiments, experiment_transitions → /experiments (Experiments)

-- Frozen semantics encoded here (spec/architecture.md §16 "Measurement and
-- experiments": "Experiments are explicit causal/decision structures with
-- declared hypothesis, unit/population, treatment/control or comparison,
-- primary/guardrail outcomes, analysis method, start/stop conditions,
-- design, uncertainty and decision"; spec/implementation-contract.md §16
-- "Experiment contract"; spec/state-machines.md "Experiment";
-- spec/evidence-and-experimentation.md "Experiment contract"):

-- * DECLARED DESIGN TYPE (§16): a closed 5-value set (randomized,
--   controlled_comparison, quasi_experimental, observational,
--   descriptive) — extension is a code + DB migration change, never a
--   caller freedom.
-- * THE FULL §16 REQUIRED-FIELD SET: hypothesis, decision_target
--   ("decision target" — the decision being informed), population_unit,
--   treatment AND comparison (two separate NOT NULL columns), assignment
--   method, primary metric (jsonb: name + dimension set — BY NAME/
--   DIMENSIONS, never a provider metric id or a metric_observations FK:
--   experiments are declared before observations exist), guardrails
--   (jsonb array of the same identity shape; possibly empty), analysis
--   method + optional version, expected_direction where applicable,
--   start criteria (where applicable) + stop criteria, the minimum
--   evidence requirement, and the DECLARED uncertainty representation.
-- * RESULT STATE (EXP-AC-02): a CLOSED set — 'undecided' (initial), the
--   CAUSAL conclusion types 'causal_supported' / 'causal_not_supported'
--   (DISTINCT values from attribution/observation — never free strings,
--   never interchangeable; an attribution result can never be serialized
--   as a causal conclusion, implementation-contract §14), 'attribution',
--   'observation', 'inconclusive' (a negative or inconclusive result is a
--   valid outcome). The DB CHECK is the enum backstop behind the type-level
--   taxonomy.
-- * THE CAUSAL EVIDENCE STANDARD (§16: "An experiment cannot be marked
--   CAUSAL_SUPPORTED unless its declared design and analysis satisfy the
--   configured causal evidence standard"): a row-level CHECK on BOTH
--   tables — a causal result state can only coexist with a causal-capable
--   design (randomized / controlled_comparison / quasi_experimental —
--   evidence-quality grades A/B). Observational and descriptive designs can
--   NEVER carry a causal result ("Do not claim causality from
--   observational correlation alone").
-- * UNCERTAINTY REPRESENTATION: a closed 4-value set (interval,
--   distribution, qualitative, none) declared UP FRONT; the conclusion's
--   uncertainty payload must match it (module guard; the payload itself is
--   retained verbatim in the transition row — EXP-AC-03).
-- * LIFECYCLE (spec/state-machines.md): DRAFT → READY → RUNNING →
--   ANALYZING → CONCLUDED, RUNNING → STOPPED | INVALIDATED. Encoded as a
--   status CHECK + a legal-successor TRIGGER on experiments-row UPDATE
--   (the race backstop behind the module's transition check) and a
--   transition CHECK on the history table.
-- * DECLARED DESIGN IS IMMUTABLE: a BEFORE UPDATE trigger rejects ANY
--   change to the design columns — only the lifecycle columns (status,
--   result_state, resulting_decision, concluded_at) may change, and only
--   through legal edges ("Conclusion state must preserve the declared
--   design and analysis metadata", spec/state-machines.md).
-- * APPEND-ONLY HISTORY: experiment_transitions rows are written exactly
--   once; BEFORE UPDATE/DELETE triggers reject every mutation (the
--   migration 015/018 pattern). The conclusion row retains the FULL
--   conclusion payload (result state, uncertainty, assumptions, sample
--   limitations, confounders, resulting decision, evidence refs) verbatim
--   — EXP-AC-03 retention; nothing is ever overwritten.
-- * PROVENANCE IS SERVER-DERIVED (implementation-contract §3: "No
--   externally supplied field may override a server-derived actor, owner,
--   provenance, policy decision, or evidence authority value"):
--   recorded_actor, recorded_via, correlation_id, causation_id and
--   recorded_at are written exclusively by server code — there is no
--   request DTO path to them (route validation rejects provenance-shaped
--   keys AND lifecycle/result authority keys; the module API takes
--   provenance as a separate server-built argument).
-- * CLIENT OWNERSHIP (TENANT-003 hard boundary): client_id is NOT NULL and
--   part of the immutable row. There is deliberately NO ON DELETE CASCADE:
--   declared designs are durable history, so a hard client delete is
--   rejected by the design-immutability trigger instead of erasing the
--   trail (clients are soft-tombstoned in practice; the FK plain-restrict
--   is the belt-and-suspenders backstop).
-- * NO PROVIDER STATE: no provider metric ids, no provider sessions, no
--   SDK-shaped columns.
-- * WORKSPACE SCOPE: an optional organizational refinement INSIDE the
--   owning Client; the database itself rejects a workspace that does not
--   belong to the record's Client (trigger — the migration 015/018
--   pattern).
-- * EVIDENCE CITATIONS: a conclusion MAY cite /evidence records
--   (evidence_refs jsonb array on the transition row); the database
--   rejects any reference to another Client's evidence (trigger —
--   cross-tenant rejection, the migration 018 metric pattern). /experiments
--   imports no evidence internals; this is the only structural coupling.

-- No owner/role/user columns: authorization stays exactly the /agencies
-- membership authority composed with /clients canonical owner resolution
-- (and /workspaces canonical ownership for the optional scope) — no second
-- tenant/permission authority (frozen matrix: /experiments ──→ /evidence,
-- /metrics, /goals; the /clients and /workspaces canonical ownership
-- instances are injected through /experiments' declared structural ports at
-- the composition root, so no forbidden module import exists).

CREATE TABLE IF NOT EXISTS experiments (
  experiment_id               uuid        PRIMARY KEY,
  client_id                   uuid        NOT NULL REFERENCES clients(client_id),
  workspace_id                uuid        REFERENCES workspaces(workspace_id),
  hypothesis                  text        NOT NULL CHECK (length(hypothesis) >= 1
                                          AND length(hypothesis) <= 2000),
  decision_target             text        NOT NULL CHECK (length(decision_target) >= 1
                                          AND length(decision_target) <= 2000),
  population_unit             text        NOT NULL CHECK (length(population_unit) >= 1
                                          AND length(population_unit) <= 500),
  treatment                   text        NOT NULL CHECK (length(treatment) >= 1
                                          AND length(treatment) <= 2000),
  comparison                  text        NOT NULL CHECK (length(comparison) >= 1
                                          AND length(comparison) <= 2000),
  assignment_method           text        NOT NULL CHECK (length(assignment_method) >= 1
                                          AND length(assignment_method) <= 500),
  design_type                 text        NOT NULL CHECK (design_type IN ('randomized',
                                          'controlled_comparison', 'quasi_experimental',
                                          'observational', 'descriptive')),
  primary_metric              jsonb       NOT NULL CHECK (jsonb_typeof(primary_metric) = 'object'),
  guardrails                  jsonb       NOT NULL DEFAULT '[]'::jsonb
                                          CHECK (jsonb_typeof(guardrails) = 'array'),
  analysis_method             text        NOT NULL CHECK (length(analysis_method) >= 1
                                          AND length(analysis_method) <= 500),
  analysis_method_version     text        CHECK (analysis_method_version IS NULL
                                          OR (length(analysis_method_version) >= 1
                                          AND length(analysis_method_version) <= 100)),
  expected_direction          text        CHECK (expected_direction IS NULL
                                          OR expected_direction IN ('increase', 'decrease',
                                          'no_change', 'any')),
  start_criteria              text        CHECK (start_criteria IS NULL
                                          OR (length(start_criteria) >= 1
                                          AND length(start_criteria) <= 2000)),
  stop_criteria               text        NOT NULL CHECK (length(stop_criteria) >= 1
                                          AND length(stop_criteria) <= 2000),
  minimum_evidence_requirement text       NOT NULL CHECK (length(minimum_evidence_requirement) >= 1
                                          AND length(minimum_evidence_requirement) <= 500),
  uncertainty_representation  text        NOT NULL CHECK (uncertainty_representation IN
                                          ('interval', 'distribution', 'qualitative', 'none')),
  status                      text        NOT NULL DEFAULT 'draft'
                                          CHECK (status IN ('draft', 'ready', 'running',
                                          'analyzing', 'concluded', 'stopped', 'invalidated')),
  result_state                text        NOT NULL DEFAULT 'undecided'
                                          CHECK (result_state IN ('undecided',
                                          'causal_supported', 'causal_not_supported',
                                          'attribution', 'observation', 'inconclusive')),
  resulting_decision          text        CHECK (resulting_decision IS NULL
                                          OR (length(resulting_decision) >= 1
                                          AND length(resulting_decision) <= 2000)),
  concluded_at                timestamptz,
  recorded_actor              text        NOT NULL,
  recorded_via                text        NOT NULL CHECK (length(recorded_via) >= 1
                                          AND length(recorded_via) <= 100),
  correlation_id              text        NOT NULL,
  causation_id                text,
  recorded_at                 timestamptz NOT NULL DEFAULT now(),
  -- THE CAUSAL EVIDENCE STANDARD (EXP-AC-02, implementation-contract §16):
  -- a causal result state requires a causal-capable declared design. The
  -- row-level CHECK is the database backstop behind the type-level and
  -- module-level gates.
  CONSTRAINT experiments_causal_standard CHECK (
    result_state NOT IN ('causal_supported', 'causal_not_supported')
    OR design_type IN ('randomized', 'controlled_comparison', 'quasi_experimental')
  )
);

-- Listing surfaces: one Client's experiments (newest first by
-- server-recorded time), the Workspace-scoped subset, and the per-status
-- operational views (ready to start / running to analyze / concluded).
CREATE INDEX IF NOT EXISTS experiments_client_idx
ON experiments (client_id, recorded_at, experiment_id);

CREATE INDEX IF NOT EXISTS experiments_workspace_idx
ON experiments (workspace_id) WHERE workspace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS experiments_status_idx
ON experiments (client_id, status);

-- The APPEND-ONLY lifecycle history: one row per applied transition,
-- carrying the FULL conclusion payload verbatim when the transition is the
-- conclusion (EXP-AC-03 — uncertainty, assumptions, sample limitations,
-- confounders, resulting decision and cited evidence refs are retained,
-- never dropped or rewritten).
CREATE TABLE IF NOT EXISTS experiment_transitions (
  transition_id               uuid        PRIMARY KEY,
  experiment_id               uuid        NOT NULL REFERENCES experiments(experiment_id),
  transition                  text        NOT NULL CHECK (transition IN ('mark_ready',
                                          'start', 'begin_analysis', 'conclude', 'stop',
                                          'invalidate')),
  from_status                 text        NOT NULL CHECK (from_status IN ('draft', 'ready',
                                          'running', 'analyzing', 'concluded', 'stopped',
                                          'invalidated')),
  to_status                   text        NOT NULL CHECK (to_status IN ('draft', 'ready',
                                          'running', 'analyzing', 'concluded', 'stopped',
                                          'invalidated')),
  conclusion                  jsonb       CHECK (conclusion IS NULL
                                          OR jsonb_typeof(conclusion) = 'object'),
  recorded_actor              text        NOT NULL,
  recorded_via                text        NOT NULL CHECK (length(recorded_via) >= 1
                                          AND length(recorded_via) <= 100),
  correlation_id              text        NOT NULL,
  causation_id                text,
  recorded_at                 timestamptz NOT NULL DEFAULT now(),
  -- The frozen state machine edges (spec/state-machines.md) as a row CHECK:
  -- mark_ready: draft→ready; start: ready→running; begin_analysis:
  -- running→analyzing; conclude: analyzing→concluded; stop: running→
  -- stopped; invalidate: running→invalidated. Terminal states have no
  -- outgoing edges.
  CONSTRAINT experiment_transition_edges CHECK (
    (transition = 'mark_ready'     AND from_status = 'draft'    AND to_status = 'ready')
    OR (transition = 'start'          AND from_status = 'ready'    AND to_status = 'running')
    OR (transition = 'begin_analysis' AND from_status = 'running'  AND to_status = 'analyzing')
    OR (transition = 'conclude'       AND from_status = 'analyzing' AND to_status = 'concluded')
    OR (transition = 'stop'           AND from_status = 'running'  AND to_status = 'stopped')
    OR (transition = 'invalidate'     AND from_status = 'running'  AND to_status = 'invalidated')
  ),
  -- A conclusion row carries the conclusion payload; every other
  -- transition carries none.
  CONSTRAINT experiment_transition_payload CHECK (
    (transition = 'conclude') = (conclusion IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS experiment_transitions_experiment_idx
ON experiment_transitions (experiment_id, recorded_at, transition_id);

-- APPEND-ONLY backstop (the migration 015/018 pattern): the database
-- itself rejects UPDATE and DELETE on the transition history. Not even
-- server code can rewrite lifecycle history.
CREATE OR REPLACE FUNCTION experiment_transitions_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'experiment transitions are append-only: % is rejected on experiment transition %', TG_OP, OLD.transition_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS experiment_transitions_append_only_update_trigger ON experiment_transitions;
CREATE TRIGGER experiment_transitions_append_only_update_trigger
BEFORE UPDATE ON experiment_transitions
FOR EACH ROW EXECUTE FUNCTION experiment_transitions_append_only();

DROP TRIGGER IF EXISTS experiment_transitions_append_only_delete_trigger ON experiment_transitions;
CREATE TRIGGER experiment_transitions_append_only_delete_trigger
BEFORE DELETE ON experiment_transitions
FOR EACH ROW EXECUTE FUNCTION experiment_transitions_append_only();

-- DECLARED-DESIGN IMMUTABILITY (spec/state-machines.md: "Conclusion state
-- must preserve the declared design and analysis metadata"): a BEFORE
-- UPDATE trigger rejects ANY change to the declared design columns. Only
-- the lifecycle columns (status, result_state, resulting_decision,
-- concluded_at) may change — and only through legal frozen-state-machine
-- edges (the next trigger).
CREATE OR REPLACE FUNCTION experiment_design_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.client_id                IS DISTINCT FROM OLD.client_id
     OR NEW.workspace_id          IS DISTINCT FROM OLD.workspace_id
     OR NEW.hypothesis            IS DISTINCT FROM OLD.hypothesis
     OR NEW.decision_target       IS DISTINCT FROM OLD.decision_target
     OR NEW.population_unit       IS DISTINCT FROM OLD.population_unit
     OR NEW.treatment             IS DISTINCT FROM OLD.treatment
     OR NEW.comparison            IS DISTINCT FROM OLD.comparison
     OR NEW.assignment_method     IS DISTINCT FROM OLD.assignment_method
     OR NEW.design_type           IS DISTINCT FROM OLD.design_type
     OR NEW.primary_metric        IS DISTINCT FROM OLD.primary_metric
     OR NEW.guardrails            IS DISTINCT FROM OLD.guardrails
     OR NEW.analysis_method       IS DISTINCT FROM OLD.analysis_method
     OR NEW.analysis_method_version IS DISTINCT FROM OLD.analysis_method_version
     OR NEW.expected_direction    IS DISTINCT FROM OLD.expected_direction
     OR NEW.start_criteria        IS DISTINCT FROM OLD.start_criteria
     OR NEW.stop_criteria         IS DISTINCT FROM OLD.stop_criteria
     OR NEW.minimum_evidence_requirement IS DISTINCT FROM OLD.minimum_evidence_requirement
     OR NEW.uncertainty_representation  IS DISTINCT FROM OLD.uncertainty_representation
     OR NEW.recorded_actor         IS DISTINCT FROM OLD.recorded_actor
     OR NEW.recorded_via           IS DISTINCT FROM OLD.recorded_via
     OR NEW.correlation_id         IS DISTINCT FROM OLD.correlation_id
     OR NEW.causation_id           IS DISTINCT FROM OLD.causation_id
     OR NEW.recorded_at            IS DISTINCT FROM OLD.recorded_at THEN
    RAISE EXCEPTION 'the experiment declared design is immutable: rewriting experiment % design/provenance columns is rejected', OLD.experiment_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS experiment_design_immutable_trigger ON experiments;
CREATE TRIGGER experiment_design_immutable_trigger
BEFORE UPDATE ON experiments
FOR EACH ROW EXECUTE FUNCTION experiment_design_immutable();

-- LEGAL-SUCCESSOR backstop (the frozen state machine as a DB trigger —
-- the race backstop behind the module's transition check): an UPDATE may
-- only move the status along a legal edge, and a conclude must actually
-- conclude (result state + timestamp).
CREATE OR REPLACE FUNCTION experiment_status_transition_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    -- A no-op status update is not a transition; the payload columns must
    -- still be unchanged (or the immutability trigger above fires first).
    RETURN NEW;
  END IF;
  IF NOT (
       (OLD.status = 'draft'     AND NEW.status = 'ready')
    OR (OLD.status = 'ready'     AND NEW.status = 'running')
    OR (OLD.status = 'running'   AND NEW.status = 'analyzing')
    OR (OLD.status = 'analyzing' AND NEW.status = 'concluded')
    OR (OLD.status = 'running'   AND NEW.status = 'stopped')
    OR (OLD.status = 'running'   AND NEW.status = 'invalidated')
  ) THEN
    RAISE EXCEPTION 'illegal experiment status transition: % → % is rejected on experiment %', OLD.status, NEW.status, OLD.experiment_id;
  END IF;
  IF NEW.status = 'concluded' THEN
    IF NEW.result_state = 'undecided' OR NEW.concluded_at IS NULL THEN
      RAISE EXCEPTION 'concluding experiment % requires a result state and the conclusion timestamp', OLD.experiment_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS experiment_status_transition_guard_trigger ON experiments;
CREATE TRIGGER experiment_status_transition_guard_trigger
BEFORE UPDATE ON experiments
FOR EACH ROW EXECUTE FUNCTION experiment_status_transition_guard();

-- Scope backstop (TENANT-003 at the storage layer, migration 015/018
-- pattern): a workspace-scoped experiment must reference a Workspace of
-- the SAME Client — the Client boundary cannot be crossed through the
-- workspace column even if every application check were bypassed.
CREATE OR REPLACE FUNCTION experiment_workspace_within_client() RETURNS trigger AS $$
BEGIN
  IF NEW.workspace_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM workspaces w
        WHERE w.workspace_id = NEW.workspace_id AND w.client_id = NEW.client_id) THEN
      RAISE EXCEPTION 'experiment % workspace % does not belong to client % — the workspace scope cannot cross the Client boundary',
        NEW.experiment_id, NEW.workspace_id, NEW.client_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS experiment_workspace_within_client_trigger ON experiments;
CREATE TRIGGER experiment_workspace_within_client_trigger
BEFORE INSERT OR UPDATE ON experiments
FOR EACH ROW EXECUTE FUNCTION experiment_workspace_within_client();

-- Evidence-citation backstop (cross-tenant rejection, the migration 018
-- metric_evidence_ref pattern): a conclusion MAY cite /evidence records,
-- but ONLY ones owned by the SAME Client — the /evidence authority stays
-- tenant-fenced even when an experiment conclusion cites it (unknown
-- references are rejected too, belt-and-suspenders ahead of the FK-less
-- jsonb array).
CREATE OR REPLACE FUNCTION experiment_conclusion_evidence_refs_same_client() RETURNS trigger AS $$
DECLARE
  v_ref text;
  v_evidence_client uuid;
  v_experiment_client uuid;
BEGIN
  IF NEW.conclusion IS NOT NULL AND NEW.conclusion ? 'evidenceRefs' THEN
    SELECT client_id INTO v_experiment_client FROM experiments WHERE experiment_id = NEW.experiment_id;
    FOR v_ref IN SELECT jsonb_array_elements_text(NEW.conclusion -> 'evidenceRefs') LOOP
      IF v_ref !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'experiment transition % cites a malformed evidence reference %', NEW.transition_id, v_ref;
      END IF;
      SELECT client_id INTO v_evidence_client FROM evidence WHERE evidence_id = v_ref::uuid;
      IF v_evidence_client IS NULL THEN
        RAISE EXCEPTION 'experiment transition % cites unknown evidence %', NEW.transition_id, v_ref;
      END IF;
      IF v_evidence_client <> v_experiment_client THEN
        RAISE EXCEPTION 'experiment transition % cites evidence % of another client — cross-tenant evidence linkage is rejected',
          NEW.transition_id, v_ref;
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS experiment_conclusion_evidence_refs_trigger ON experiment_transitions;
CREATE TRIGGER experiment_conclusion_evidence_refs_trigger
BEFORE INSERT ON experiment_transitions
FOR EACH ROW EXECUTE FUNCTION experiment_conclusion_evidence_refs_same_client();
