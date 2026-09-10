-- MKT-027 Field execution and evidence schema (JOB-001 field subset,
-- EVID-001 field subset; JOB-AC-03..04; EVID-AC-01..03 field subset;
-- spec/work-items.md "enable visit/field execution, structured outcomes,
-- evidence capture, follow-up and continuity"; spec/human-agent-v1.3.md
-- §3/§5; spec/evidence-and-experimentation.md; architecture.md §13
-- "Human Agents use the same Task, Execution, Evidence, Audit, Policy, and
-- Workflow authorities").
--
-- NUMBERING NOTE (worker disclosure): the MKT-027 dispatch reserved
-- migration number 021; 021 sorts BEFORE 023_jobs.sql (which creates the
-- `jobs` table these tables FK-reference) in the runner's lexicographic
-- order, so a 021 numbering cannot apply at all. 024 is the first
-- unreserved number AFTER 023 (019/021/022 are reserved for sibling
-- workers). The integration station may renumber if desired.
--
-- Table ownership follows the frozen authority map (implementation-contract
-- §1): job_visits / job_visit_transitions / job_visit_outcomes /
-- job_visit_evidence → /jobs (the Human Job lifecycle authority — MKT-027
-- EXTENDS the merged MKT-026 module; no second module, no forked Job state).
-- This migration creates EXACTLY these four tables.
--
-- Frozen semantics encoded here:
--   * a VISIT is the /jobs-owned FIELD EXECUTION record of ONE accepted
--     Job: it exists only inside the acceptance window (INSERT is
--     DB-backstopped to jobs.status = 'accepted' — the job-owner trigger),
--     it belongs to exactly ONE Job (FK, no cascade — visit history
--     PROTECTS its job row), and its scope chain is the JOB's scope chain
--     (workspace within client, client within agency — inherited,
--     server-derived, never caller-provided; the scope-chain trigger).
--     Visits are NOT a second workflow/execution engine: they carry NO
--     task linkage of their own (the Task reference stays on the Job),
--     no dispatch/queue/sandbox/runtime-class semantics, no downstream
--     scheduling — the /workflows authority stays untouched (the /jobs
--     module still consumes it READ-ONLY);
--   * the visit status machine is the frozen MKT-027 lifecycle
--     (planned → in_progress; in_progress → completed | cancelled;
--     planned → cancelled) edge-for-edge in a DB trigger; completed and
--     cancelled are TERMINAL (frozen rows);
--   * every applied transition is recorded APPEND-ONLY in
--     job_visit_transitions with FULL server-derived provenance
--     (recorded_actor/recorded_via/correlation_id/causation_id) — the
--     JOB-AC-03 provenance chain extended to every lifecycle event;
--   * the structured visit outcome (JOB-AC-03 field subset) is
--     APPEND-ONLY history with server-derived provenance columns, exactly
--     ONE per visit (UNIQUE fence — replay converges, a different logical
--     submission is a conflict), a frozen field-result vocabulary
--     (succeeded | partial | no_contact | failed — field-specific
--     granularity beyond the job-level succeeded|failed), an explicit
--     follow_up_required flag, structured observations (non-empty jsonb
--     object) and a REQUIRED evidence_ref FK to the /evidence authority's
--     immutable record fenced to the SAME Client (the job_outcomes/
--     metrics pattern) — the outcome preserves actor and evidence
--     provenance and never rewrites history;
--   * EVIDENCE CAPTURE from the field: job_visit_evidence links the
--     visit to the /evidence records captured through the field surface
--     (the evidence rows themselves live in the /evidence authority's
--     append-only ledger — migration 015; nothing here can mutate them,
--     so claims stay claims and EVID-AC-03 holds by construction). The
--     link is fenced to the SAME Client;
--   * FOLLOW-UP: follow_up_of_visit_id references a prior visit of the
--     SAME relationship (agency + client + target identity) that is
--     already completed — the explicit causal follow-up link (validated
--     by trigger);
--   * CONTINUITY (JOB-AC-04): the relationship chain is DERIVED data —
--     (agency_id, client_id, target_identity) is indexed for the chain
--     lookup, but NO history is ever rewritten: visit rows are immutable
--     after terminal, and the continuity surface is a read. The POLICY
--     gate consumes the merged /field-agents profile
--     relationship-continuity block in code (the single checkpoint
--     function) — there is NO second policy engine in SQL or code.
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers (uuid), created_at/updated_at, version CAS for row mutation,
-- DB-fenced uniqueness (duplicate convergence fails closed), append-only
-- history where history matters. No secrets in domain records. No owner/
-- role/user authorization columns: authorization stays exactly the
-- /agencies membership authority composed with canonical owner resolution
-- (visit → job → workflow instance → workflow → workspace → client →
-- agency), exactly like migration 023.

-- ---------------------------------------------------------------------------
-- The visit (the /jobs-owned field execution record of one accepted Job)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_visits (
    visit_id              uuid        PRIMARY KEY,
    -- No ON DELETE CASCADE: visit history PROTECTS its job row — the field
    -- execution history cannot be deleted underneath the Job.
    job_id                uuid        NOT NULL REFERENCES jobs(job_id),
    -- Per-job sequence (1-based), assigned under the job row lock; the
    -- UNIQUE fence below is the race backstop.
    visit_seq             int         NOT NULL CHECK (visit_seq >= 1),
    -- The INHERITED scope chain (the Job's commissioning scope — never
    -- caller-provided; the scope-chain trigger backstops equality with the
    -- job row's scope).
    workspace_id          uuid        NOT NULL REFERENCES workspaces(workspace_id),
    client_id             uuid        NOT NULL REFERENCES clients(client_id),
    agency_id             uuid        NOT NULL REFERENCES agencies(agency_id) ON DELETE CASCADE,
    -- The opaque RELATIONSHIP TARGET identity (venue/person/location key)
    -- — the third coordinate of the continuity relationship
    -- (agency + client + target identity).
    target_identity       text        NOT NULL CHECK (length(target_identity) BETWEEN 1 AND 200),
    status                text        NOT NULL DEFAULT 'planned'
                          CHECK (status IN ('planned', 'in_progress', 'completed', 'cancelled')),
    -- Caller-declared plan (when the visit is scheduled for).
    scheduled_at          timestamptz,
    -- Set exactly when the visit enters in_progress.
    started_at            timestamptz,
    -- Set exactly when the visit completes.
    completed_at          timestamptz,
    -- Set exactly when the visit is cancelled.
    cancelled_at          timestamptz,
    -- The prior visit this visit FOLLOWS UP (null for a fresh visit). The
    -- follow-up trigger fences: same relationship + the prior visit is
    -- completed. No cascade — follow-up history is durable.
    follow_up_of_visit_id uuid        REFERENCES job_visits(visit_id),
    -- The accepted agent's platform user (server-derived from the job's
    -- winning acceptance — the only actor who may open/transition a visit).
    created_by            uuid        REFERENCES users(user_id),
    -- SERVER-DERIVED provenance of the open event (JOB-AC-03 posture).
    recorded_actor        text        NOT NULL CHECK (length(recorded_actor) BETWEEN 3 AND 200),
    recorded_via          text        NOT NULL CHECK (length(recorded_via) BETWEEN 1 AND 100),
    correlation_id        text        NOT NULL CHECK (length(correlation_id) BETWEEN 1 AND 200),
    causation_id          text        CHECK (causation_id IS NULL OR length(causation_id) BETWEEN 1 AND 200),
    version               bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),

    -- One sequence position per job (the per-job visit order fence).
    CONSTRAINT job_visits_seq_key UNIQUE (job_id, visit_seq),
    -- Timestamps exist exactly in their lifecycle states.
    CHECK ((status IN ('in_progress', 'completed')) = (started_at IS NOT NULL)),
    CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
    CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
    CHECK (NOT (completed_at IS NOT NULL AND cancelled_at IS NOT NULL))
);

-- The continuity scan surface: the completed visits of one relationship
-- (agency + client + target identity), oldest first (JOB-AC-04 — the
-- derived chain lookup; read-only surface, history is never rewritten).
CREATE INDEX IF NOT EXISTS job_visits_relationship_idx
    ON job_visits (agency_id, client_id, target_identity, status, completed_at, visit_id);

-- The job's visit listing surface.
CREATE INDEX IF NOT EXISTS job_visits_job_idx
    ON job_visits (job_id, visit_seq);

-- ---------------------------------------------------------------------------
-- The frozen MKT-027 visit state machine, shared by the row trigger and
-- the history-insert trigger:
--   planned    → in_progress | cancelled
--   in_progress→ completed | cancelled
-- and NOTHING else. completed/cancelled are TERMINAL — frozen history
-- (no outgoing transitions, no self-loops, no skip-edges).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION job_visits_transition_legal(from_status text, to_status text)
RETURNS boolean AS $$
BEGIN
    RETURN (
        (from_status = 'planned' AND to_status IN ('in_progress', 'cancelled'))
        OR (from_status = 'in_progress' AND to_status IN ('completed', 'cancelled'))
    );
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- State-machine backstop: the database itself rejects every illegal status
-- change on a visit — including ANY change to a TERMINAL row (completed/
-- cancelled visits are frozen field-execution history).
CREATE OR REPLACE FUNCTION job_visits_frozen_state_machine() RETURNS trigger AS $$
BEGIN
    IF NOT job_visits_transition_legal(OLD.status, NEW.status) THEN
        IF OLD.status IN ('completed', 'cancelled') THEN
            RAISE EXCEPTION 'visit % is % (terminal) and frozen: terminal visit states are immutable',
                OLD.visit_id, OLD.status;
        END IF;
        IF OLD.status = NEW.status THEN
            RAISE EXCEPTION 'visit % self-transition % → % is illegal (no self-loops in the frozen visit state machine)',
                OLD.visit_id, OLD.status, NEW.status;
        END IF;
        RAISE EXCEPTION 'illegal visit transition % → % (frozen MKT-027 visit state machine)',
            OLD.status, NEW.status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS job_visits_frozen_state_machine_trigger ON job_visits;
CREATE TRIGGER job_visits_frozen_state_machine_trigger
    BEFORE UPDATE ON job_visits
    FOR EACH ROW EXECUTE FUNCTION job_visits_frozen_state_machine();

-- Immutability backstop (implementation-contract §3): visit identity, the
-- job reference, the sequence, the INHERITED scope chain, the relationship
-- target identity, the follow-up link and the open provenance can NEVER be
-- reassigned through ANY mutation path — a visit can never float to
-- another Job, scope, target or follow-up chain.
CREATE OR REPLACE FUNCTION job_visits_identity_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW.visit_id <> OLD.visit_id THEN
        RAISE EXCEPTION 'visit_id % is immutable', OLD.visit_id;
    END IF;
    IF NEW.job_id <> OLD.job_id THEN
        RAISE EXCEPTION 'visit % cannot change its Job (was job %)',
            OLD.visit_id, OLD.job_id;
    END IF;
    IF NEW.visit_seq <> OLD.visit_seq THEN
        RAISE EXCEPTION 'visit % sequence is immutable (was %)',
            OLD.visit_id, OLD.visit_seq;
    END IF;
    IF NEW.workspace_id <> OLD.workspace_id THEN
        RAISE EXCEPTION 'visit % cannot change Workspace scope (was workspace %)',
            OLD.visit_id, OLD.workspace_id;
    END IF;
    IF NEW.client_id <> OLD.client_id THEN
        RAISE EXCEPTION 'visit % Client ownership is immutable (was client %)',
            OLD.visit_id, OLD.client_id;
    END IF;
    IF NEW.agency_id <> OLD.agency_id THEN
        RAISE EXCEPTION 'visit % cannot change Agency ownership (was agency %)',
            OLD.visit_id, OLD.agency_id;
    END IF;
    IF NEW.target_identity <> OLD.target_identity THEN
        RAISE EXCEPTION 'visit % relationship target identity is immutable (was %)',
            OLD.visit_id, OLD.target_identity;
    END IF;
    IF NEW.follow_up_of_visit_id IS DISTINCT FROM OLD.follow_up_of_visit_id THEN
        RAISE EXCEPTION 'visit % follow-up link is immutable (was %)',
            OLD.visit_id, OLD.follow_up_of_visit_id;
    END IF;
    IF NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'visit % open provenance is immutable', OLD.visit_id;
    END IF;
    IF NEW.recorded_actor <> OLD.recorded_actor OR NEW.recorded_via <> OLD.recorded_via
       OR NEW.correlation_id <> OLD.correlation_id
       OR NEW.causation_id IS DISTINCT FROM OLD.causation_id THEN
        RAISE EXCEPTION 'visit % recorded provenance is immutable', OLD.visit_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS job_visits_identity_immutable_trigger ON job_visits;
CREATE TRIGGER job_visits_identity_immutable_trigger
    BEFORE UPDATE ON job_visits
    FOR EACH ROW EXECUTE FUNCTION job_visits_identity_immutable();

-- Scope-chain backstop: the visit's scope must be EXACTLY its Job's scope
-- (the commissioning Agency + Client + Workspace — INHERITED, never
-- caller-provided). Enforced on INSERT and UPDATE, so a visit can never
-- cross its Job's scope through any column even if every application
-- check were bypassed.
CREATE OR REPLACE FUNCTION job_visits_scope_chain() RETURNS trigger AS $$
DECLARE
    v_workspace_id uuid;
    v_client_id    uuid;
    v_agency_id    uuid;
BEGIN
    SELECT workspace_id, client_id, agency_id
        INTO v_workspace_id, v_client_id, v_agency_id
    FROM jobs
    WHERE jobs.job_id = NEW.job_id;

    IF v_workspace_id IS NULL THEN
        RAISE EXCEPTION 'visit % references unknown job %', NEW.visit_id, NEW.job_id;
    END IF;
    IF NEW.workspace_id <> v_workspace_id OR NEW.client_id <> v_client_id
       OR NEW.agency_id <> v_agency_id THEN
        RAISE EXCEPTION 'visit % scope (workspace %, client %, agency %) must equal its job scope (workspace %, client %, agency %)',
            NEW.visit_id, NEW.workspace_id, NEW.client_id, NEW.agency_id,
            v_workspace_id, v_client_id, v_agency_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS job_visits_scope_chain_trigger ON job_visits;
CREATE TRIGGER job_visits_scope_chain_trigger
    BEFORE INSERT OR UPDATE ON job_visits
    FOR EACH ROW EXECUTE FUNCTION job_visits_scope_chain();

-- Acceptance-window backstop: a visit may only be opened for a job that
-- is in its ACCEPTED state (the winning acceptance exists and the job
-- outcome has not been submitted). Visits live strictly inside the
-- acceptance window — the Job authority's MKT-026 state machine is never
-- forked or extended by field execution.
CREATE OR REPLACE FUNCTION job_visits_job_acceptance() RETURNS trigger AS $$
DECLARE
    v_status text;
BEGIN
    SELECT status INTO v_status FROM jobs WHERE jobs.job_id = NEW.job_id;
    IF v_status IS NULL THEN
        RAISE EXCEPTION 'visit % references unknown job %', NEW.visit_id, NEW.job_id;
    END IF;
    IF v_status <> 'accepted' THEN
        RAISE EXCEPTION 'visit % cannot be opened: job % is % (visits exist only inside the acceptance window)',
            NEW.visit_id, NEW.job_id, v_status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS job_visits_job_acceptance_trigger ON job_visits;
CREATE TRIGGER job_visits_job_acceptance_trigger
    BEFORE INSERT ON job_visits
    FOR EACH ROW EXECUTE FUNCTION job_visits_job_acceptance();

-- Follow-up backstop: follow_up_of_visit_id must reference a prior visit
-- of the SAME relationship (agency + client + target identity) that is
-- already completed — the explicit follow-up link cannot cross
-- relationships, tenants or lifecycle states.
CREATE OR REPLACE FUNCTION job_visits_follow_up_consistent() RETURNS trigger AS $$
DECLARE
    v_agency_id  uuid;
    v_client_id  uuid;
    v_target     text;
    v_status     text;
BEGIN
    IF NEW.follow_up_of_visit_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT agency_id, client_id, target_identity, status
        INTO v_agency_id, v_client_id, v_target, v_status
    FROM job_visits
    WHERE job_visits.visit_id = NEW.follow_up_of_visit_id;

    IF v_agency_id IS NULL THEN
        RAISE EXCEPTION 'visit % references unknown follow-up visit %',
            NEW.visit_id, NEW.follow_up_of_visit_id;
    END IF;
    IF v_agency_id <> NEW.agency_id OR v_client_id <> NEW.client_id
       OR v_target <> NEW.target_identity THEN
        RAISE EXCEPTION 'visit % follow-up target % belongs to a different relationship — follow-ups stay inside (agency, client, target) %/%/%',
            NEW.visit_id, NEW.follow_up_of_visit_id, NEW.agency_id, NEW.client_id, NEW.target_identity;
    END IF;
    IF v_status <> 'completed' THEN
        RAISE EXCEPTION 'visit % follow-up target % is % — follow-ups reference COMPLETED visits only',
            NEW.visit_id, NEW.follow_up_of_visit_id, v_status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS job_visits_follow_up_consistent_trigger ON job_visits;
CREATE TRIGGER job_visits_follow_up_consistent_trigger
    BEFORE INSERT OR UPDATE ON job_visits
    FOR EACH ROW EXECUTE FUNCTION job_visits_follow_up_consistent();

-- ---------------------------------------------------------------------------
-- The append-only visit transition history (the workflow_instance_
-- transitions pattern): one row per APPLIED transition, with FULL
-- server-derived provenance. Every lifecycle event of the field execution
-- is durably attributed (JOB-AC-03 posture extended to every transition).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_visit_transitions (
    transition_id   uuid        PRIMARY KEY,
    -- CASCADE: the history is subordinate bookkeeping of its visit row
    -- (visits themselves are never deleted — no path exists).
    visit_id        uuid        NOT NULL REFERENCES job_visits(visit_id) ON DELETE CASCADE,
    from_status     text        NOT NULL
                    CHECK (from_status IN ('planned', 'in_progress', 'completed', 'cancelled')),
    to_status       text        NOT NULL
                    CHECK (to_status IN ('planned', 'in_progress', 'completed', 'cancelled')),
    reason          text        NOT NULL DEFAULT '' CHECK (length(reason) <= 2000),
    created_by      uuid        REFERENCES users(user_id),
    -- SERVER-DERIVED provenance of the transition event.
    recorded_actor  text        NOT NULL CHECK (length(recorded_actor) BETWEEN 3 AND 200),
    recorded_via    text        NOT NULL CHECK (length(recorded_via) BETWEEN 1 AND 100),
    correlation_id  text        NOT NULL CHECK (length(correlation_id) BETWEEN 1 AND 200),
    causation_id    text        CHECK (causation_id IS NULL OR length(causation_id) BETWEEN 1 AND 200),
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS job_visit_transitions_visit_idx
    ON job_visit_transitions (visit_id, created_at, transition_id);

-- History-consistency backstop (the MKT-009 erratum pattern): a history
-- row is only legal when it records a legal machine edge AND matches the
-- visit's actual status timeline (from_status must be a state the visit
-- could legally hold; to_status must be a legal successor).
CREATE OR REPLACE FUNCTION job_visit_transitions_legal() RETURNS trigger AS $$
BEGIN
    IF NOT job_visits_transition_legal(NEW.from_status, NEW.to_status) THEN
        RAISE EXCEPTION 'illegal visit transition history % → % (frozen MKT-027 visit state machine)',
            NEW.from_status, NEW.to_status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS job_visit_transitions_legal_trigger ON job_visit_transitions;
CREATE TRIGGER job_visit_transitions_legal_trigger
    BEFORE INSERT ON job_visit_transitions
    FOR EACH ROW EXECUTE FUNCTION job_visit_transitions_legal();

-- Append-only backstop: applied transitions are immutable history.
CREATE OR REPLACE FUNCTION job_visit_transitions_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'visit transitions are append-only history (% blocked)', TG_OP;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS job_visit_transitions_append_only_trigger ON job_visit_transitions;
CREATE TRIGGER job_visit_transitions_append_only_trigger
    BEFORE UPDATE OR DELETE ON job_visit_transitions
    FOR EACH ROW EXECUTE FUNCTION job_visit_transitions_append_only();

-- ---------------------------------------------------------------------------
-- The structured visit outcome (JOB-AC-03 field subset): append-only,
-- exactly one per visit, with SERVER-DERIVED actor/evidence provenance
-- preserved forever, structured field observations and a REQUIRED
-- same-Client evidence reference.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_visit_outcomes (
    visit_outcome_id  uuid        PRIMARY KEY,
    -- No ON DELETE CASCADE: outcome history PROTECTS its visit row.
    visit_id          uuid        NOT NULL REFERENCES job_visits(visit_id),
    -- The frozen field-result vocabulary (structured outcome dimension 1):
    -- field-specific granularity beyond the job-level succeeded|failed.
    result            text        NOT NULL CHECK (result IN ('succeeded', 'partial', 'no_contact', 'failed')),
    -- The explicit follow-up declaration (dimension 2): the agent reports
    -- that a follow-up visit is required (the next visit may link to this
    -- one through follow_up_of_visit_id).
    follow_up_required boolean    NOT NULL DEFAULT false,
    -- Free-form bounded report notes (dimension 3, never load-bearing).
    notes             text        NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
    -- The structured observation payload (dimension 4): a non-empty JSON
    -- object of normalized field observations. The §21 backstop in code
    -- rejects material-shaped keys (the evidence guard pattern) and this
    -- CHECK keeps the shape (non-empty object).
    observations      jsonb       NOT NULL
                      CHECK (jsonb_typeof(observations) = 'object' AND observations <> '{}'::jsonb),
    -- The /evidence authority's immutable record backing this outcome
    -- (dimension 5) — FK-fenced to the SAME Client as the visit's job
    -- (trigger below: the job_outcomes/metrics pattern). A human
    -- narrative alone never establishes truth; the evidence reference
    -- preserves the chain.
    evidence_ref      uuid        NOT NULL REFERENCES evidence(evidence_id),
    -- SERVER-DERIVED provenance (JOB-AC-03) — no request DTO can ever
    -- write these columns through the module surface.
    recorded_actor    text        NOT NULL CHECK (length(recorded_actor) BETWEEN 3 AND 200),
    recorded_via      text        NOT NULL CHECK (length(recorded_via) BETWEEN 1 AND 100),
    correlation_id    text        NOT NULL CHECK (length(correlation_id) BETWEEN 1 AND 200),
    causation_id      text        CHECK (causation_id IS NULL OR length(causation_id) BETWEEN 1 AND 200),
    submitted_by      uuid        REFERENCES users(user_id),
    submitted_at      timestamptz NOT NULL DEFAULT now(),
    created_at        timestamptz NOT NULL DEFAULT now(),

    -- Exactly ONE outcome per visit, ever (the replay convergence fence).
    CONSTRAINT job_visit_outcomes_visit_key UNIQUE (visit_id)
);

-- Same-Client evidence backstop (the job_outcomes/metrics pattern): the
-- outcome's evidence record must belong to the SAME Client as the
-- visit's job — cross-tenant evidence linkage is rejected by the
-- database itself.
CREATE OR REPLACE FUNCTION job_visit_outcomes_evidence_same_client() RETURNS trigger AS $$
DECLARE
    v_evidence_client uuid;
    v_visit_client    uuid;
BEGIN
    SELECT client_id INTO v_visit_client FROM job_visits WHERE job_visits.visit_id = NEW.visit_id;
    IF v_visit_client IS NULL THEN
        RAISE EXCEPTION 'visit outcome % references unknown visit %', NEW.visit_outcome_id, NEW.visit_id;
    END IF;
    SELECT client_id INTO v_evidence_client FROM evidence WHERE evidence.evidence_id = NEW.evidence_ref;
    IF v_evidence_client IS NULL THEN
        RAISE EXCEPTION 'visit outcome % references unknown evidence %',
            NEW.visit_outcome_id, NEW.evidence_ref;
    END IF;
    IF v_evidence_client <> v_visit_client THEN
        RAISE EXCEPTION 'visit outcome % evidence % belongs to another client — cross-tenant evidence linkage is rejected',
            NEW.visit_outcome_id, NEW.evidence_ref;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS job_visit_outcomes_evidence_same_client_trigger ON job_visit_outcomes;
CREATE TRIGGER job_visit_outcomes_evidence_same_client_trigger
    BEFORE INSERT ON job_visit_outcomes
    FOR EACH ROW EXECUTE FUNCTION job_visit_outcomes_evidence_same_client();

-- Append-only backstop: submitted visit outcomes are immutable evidence —
-- UPDATE and DELETE are both rejected by the database itself (JOB-AC-03
-- history preservation; EVID-AC-02 posture on the field subset).
CREATE OR REPLACE FUNCTION job_visit_outcomes_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'visit outcomes are append-only history (% blocked)', TG_OP;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS job_visit_outcomes_append_only_trigger ON job_visit_outcomes;
CREATE TRIGGER job_visit_outcomes_append_only_trigger
    BEFORE UPDATE OR DELETE ON job_visit_outcomes
    FOR EACH ROW EXECUTE FUNCTION job_visit_outcomes_append_only();

-- ---------------------------------------------------------------------------
-- The evidence-capture link (EVID-AC-01..03 field subset): which /evidence
-- records were captured through THIS visit's field surface. The evidence
-- rows themselves live in the /evidence authority's append-only ledger
-- (migration 015) — this table is the visit-side LINK (derived index),
-- fenced to the SAME Client. Nothing here (or anywhere in /jobs) can
-- mutate an evidence row, so a submitted CLAIM stays a claim forever
-- (EVID-AC-03 by construction — there is no promotion path).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_visit_evidence (
    visit_id        uuid        NOT NULL REFERENCES job_visits(visit_id),
    evidence_id     uuid        NOT NULL REFERENCES evidence(evidence_id),
    -- The capturing accepted agent's platform user (server-derived).
    captured_by     uuid        REFERENCES users(user_id),
    -- SERVER-DERIVED capture provenance (the same dimensions the evidence
    -- row itself carries — actor/recordedVia/correlation/causation).
    recorded_actor  text        NOT NULL CHECK (length(recorded_actor) BETWEEN 3 AND 200),
    recorded_via    text        NOT NULL CHECK (length(recorded_via) BETWEEN 1 AND 100),
    correlation_id  text        NOT NULL CHECK (length(correlation_id) BETWEEN 1 AND 200),
    causation_id    text        CHECK (causation_id IS NULL OR length(causation_id) BETWEEN 1 AND 200),
    created_at      timestamptz NOT NULL DEFAULT now(),

    -- One link per (visit, evidence) pair; the visit_id is part of the key
    -- (the same evidence record may back more than one visit).
    CONSTRAINT job_visit_evidence_key PRIMARY KEY (visit_id, evidence_id)
);

CREATE INDEX IF NOT EXISTS job_visit_evidence_evidence_idx
    ON job_visit_evidence (evidence_id, created_at);

-- Same-Client backstop: the linked evidence record must belong to the
-- SAME Client as the visit's job.
CREATE OR REPLACE FUNCTION job_visit_evidence_same_client() RETURNS trigger AS $$
DECLARE
    v_evidence_client uuid;
    v_visit_client    uuid;
BEGIN
    SELECT client_id INTO v_visit_client FROM job_visits WHERE job_visits.visit_id = NEW.visit_id;
    IF v_visit_client IS NULL THEN
        RAISE EXCEPTION 'visit evidence link % references unknown visit %', NEW.evidence_id, NEW.visit_id;
    END IF;
    SELECT client_id INTO v_evidence_client FROM evidence WHERE evidence.evidence_id = NEW.evidence_id;
    IF v_evidence_client IS NULL THEN
        RAISE EXCEPTION 'visit evidence link references unknown evidence %', NEW.evidence_id;
    END IF;
    IF v_evidence_client <> v_visit_client THEN
        RAISE EXCEPTION 'visit evidence link % belongs to another client — cross-tenant evidence linkage is rejected',
            NEW.evidence_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS job_visit_evidence_same_client_trigger ON job_visit_evidence;
CREATE TRIGGER job_visit_evidence_same_client_trigger
    BEFORE INSERT ON job_visit_evidence
    FOR EACH ROW EXECUTE FUNCTION job_visit_evidence_same_client();

-- Append-only backstop: capture links are durable attribution history.
CREATE OR REPLACE FUNCTION job_visit_evidence_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'visit evidence links are append-only history (% blocked)', TG_OP;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS job_visit_evidence_append_only_trigger ON job_visit_evidence;
CREATE TRIGGER job_visit_evidence_append_only_trigger
    BEFORE UPDATE OR DELETE ON job_visit_evidence
    FOR EACH ROW EXECUTE FUNCTION job_visit_evidence_append_only();
