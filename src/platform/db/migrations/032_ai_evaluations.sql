-- MKT-019 AI evaluation framework schema (AI-003).
-- PostgreSQL is the system of record (spec/architecture-lock.md).
--
-- Table ownership follows the frozen authority map (implementation-contract
-- §1): "AI routing/evaluation/usage → /ai-runtime". This migration delivers
-- the EVALUATION LAYER of the AI Runtime (work-items.md MKT-019: "implement
-- task-level evaluators, human-review hooks and execution-linked quality
-- telemetry"; requirements AI-003; acceptance AI-AC-08 + the evaluator
-- regression matrix; spec/ai-runtime-and-routing.md §7 evaluation, §8
-- outcome learning, §9 provider independence; implementation-contract §12
-- Evaluation contract):
--
--   * ai_evaluators                — the PLATFORM-level, PROVIDER-NEUTRAL
--                                    evaluator registry: the task-level
--                                    evaluator definitions the TaskProfile
--                                    evaluator contract (evaluatorIds)
--                                    references BY LABEL. Content is
--                                    immutable after registration (the
--                                    registry posture); the single lifecycle
--                                    edge is active → retired, retired
--                                    TERMINAL. Provider/model identities
--                                    never appear here — the evaluator is
--                                    a normalized kind + a bounded config,
--                                    never an SDK, a client library or a
--                                    credential.
--   * ai_evaluations               — the APPEND-ONLY evaluation OUTCOME
--                                    records (the §12 EvaluationResult
--                                    persisted): verdict (pass/fail/unknown
--                                    — unknown follows the frozen UNKNOWN
--                                    semantics), score, rubric dimensions,
--                                    evidence refs, uncertainty/limitations,
--                                    linked to the TaskProfile, the
--                                    EXECUTION (server-side provenance: the
--                                    module validates the execution
--                                    reference through the /executions
--                                    public API and the scope-chain trigger
--                                    backstops it) and the USAGE TELEMETRY
--                                    row it judges (the §24 evaluator-
--                                    outcome link, now wired by MKT-019).
--                                    Written once: UPDATE and DELETE are
--                                    DB-rejected — evaluation history is
--                                    append-only (never rewritten).
--   * ai_review_requests           — the HUMAN-REVIEW HOOK records (§7
--                                    "human review where needed"): a
--                                    pending review request that surfaces
--                                    review state and moves
--                                    pending → approved | rejected |
--                                    dismissed (all terminal) through
--                                    decideReview. The hook records review
--                                    INTENT and OUTCOME only — humans ACT
--                                    through the existing Job/Task/Execution
--                                    authorities (/jobs, /field-agents);
--                                    this table is NOT a second human
--                                    execution engine (no assignment, no
--                                    claim, no work distribution).
--   * ai_review_request_transitions — the APPEND-ONLY transition history
--                                    of a review request (the lifecycle
--                                    audit trail). At most ONE transition
--                                    per request (UNIQUE fence — the
--                                    pending → terminal edge is single
--                                    shot); UPDATE and DELETE are
--                                    DB-rejected.
--
-- AI-AC-08 (independence from business-outcome measurement): NONE of these
-- tables carries a business-outcome column — no metric/KPI reference, no
-- experiment-outcome reference, no lift/conversion field. Evaluation
-- records link task-level context only (TaskProfile, execution, usage
-- telemetry, evidence citations). Model evaluations and business outcomes
-- remain separate datasets linked through execution identifiers
-- (spec/ai-runtime-and-routing.md §8).
--
-- Every table follows the §3 required identifiers (immutable opaque id,
-- created_at, version/CAS where concurrent mutation is possible, owner
-- references, correlation identity) and the §25 conventions (triggers as
-- the final backstops for immutability, terminality, append-only history
-- and scope-chain integrity).

-- ---------------------------------------------------------------------------
-- ai_evaluators — the provider-neutral task-level evaluator registry.
--
-- The registry is PLATFORM-level normalized data (exactly like
-- ai_model_registry): platform administrators register evaluator
-- definitions; Workspace-scoped TaskProfiles reference them by evaluator
-- KEY label. The (evaluator_key) pair is unique among ACTIVE entries — a
-- retired evaluator's key may be re-registered as a NEW identity.
--
-- The evaluator CONFIG is a bounded JSON object interpreted by the
-- evaluation core (built-in deterministic evaluators) — e.g. the citation
-- coverage evaluator's expectedEvidenceRefs + threshold, the domain rubric
-- evaluator's dimension bounds, the brand-policy evaluator's denied terms.
-- The config is DATA: no provider/model names other than declarative
-- labels, no SDK references, no credentials.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_evaluators (
    evaluator_registry_id   uuid         PRIMARY KEY,
    -- The evaluator KEY label TaskProfiles reference in evaluatorIds
    -- (normalized label, unique among ACTIVE entries).
    evaluator_key           text         NOT NULL
                            CHECK (length(evaluator_key) >= 2 AND length(evaluator_key) <= 100),
    display_name            text         NOT NULL
                            CHECK (length(display_name) >= 1 AND length(display_name) <= 200),
    -- The closed evaluator-kind vocabulary (spec/ai-runtime-and-routing.md
    -- §7: schema validity; factuality/grounding; evidence citation
    -- coverage; brand-policy compliance; domain rubric score; human
    -- review; downstream task success).
    kind                    text         NOT NULL
                            CHECK (kind IN (
                              'schema-validity',
                              'factuality-grounding',
                              'evidence-citation-coverage',
                              'brand-policy-compliance',
                              'domain-rubric',
                              'human-review',
                              'downstream-task-success'
                            )),
    -- The evaluator definition version (§12 evaluatorVersion — the version
    -- denormalized onto every evaluation record that used it).
    evaluator_version       integer      NOT NULL CHECK (evaluator_version >= 1),
    -- The declarative evaluator configuration (bounded JSON object
    -- interpreted by the evaluation core / the caller-supplied engine).
    config                  jsonb        NOT NULL
                            CHECK (jsonb_typeof(config) = 'object'),
    status                  text         NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'retired')),
    created_by              uuid         REFERENCES users(user_id),
    version                 bigint       NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at              timestamptz  NOT NULL DEFAULT now(),
    updated_at              timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT ai_evaluators_id_unique UNIQUE (evaluator_registry_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_evaluators_active_key_fence
    ON ai_evaluators (evaluator_key) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS ai_evaluators_kind_idx
    ON ai_evaluators (kind, status);

-- Content immutability (append-oriented registry posture): identity, the
-- evaluator key, the kind, the version, the config and the provenance can
-- NEVER be reassigned through any mutation path. Only status (the single
-- lifecycle edge), version (its CAS token) and updated_at ever change.
CREATE OR REPLACE FUNCTION ai_evaluators_content_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW.evaluator_registry_id <> OLD.evaluator_registry_id THEN
        RAISE EXCEPTION 'evaluator_registry_id % is immutable', OLD.evaluator_registry_id;
    END IF;
    IF NEW.evaluator_key <> OLD.evaluator_key
       OR NEW.display_name <> OLD.display_name
       OR NEW.kind <> OLD.kind
       OR NEW.evaluator_version <> OLD.evaluator_version
       OR NEW.config IS DISTINCT FROM OLD.config THEN
        RAISE EXCEPTION 'evaluator % content is immutable (append-oriented registry: corrections register a NEW evaluator)',
            OLD.evaluator_registry_id;
    END IF;
    IF NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'evaluator % provenance is immutable', OLD.evaluator_registry_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_evaluators_content_immutable_trigger ON ai_evaluators;
CREATE TRIGGER ai_evaluators_content_immutable_trigger
    BEFORE UPDATE ON ai_evaluators
    FOR EACH ROW EXECUTE FUNCTION ai_evaluators_content_immutable();

-- Lifecycle backstop: `retired` is a TERMINAL tombstone.
CREATE OR REPLACE FUNCTION ai_evaluators_retired_terminal() RETURNS trigger AS $$
BEGIN
    IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN
        RAISE EXCEPTION 'evaluator % is retired and terminal', OLD.evaluator_registry_id;
    END IF;
    IF OLD.status = 'active' AND NEW.status NOT IN ('active', 'retired') THEN
        RAISE EXCEPTION 'illegal evaluator status % (the lifecycle is active → retired only)',
            NEW.status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_evaluators_retired_terminal_trigger ON ai_evaluators;
CREATE TRIGGER ai_evaluators_retired_terminal_trigger
    BEFORE UPDATE ON ai_evaluators
    FOR EACH ROW EXECUTE FUNCTION ai_evaluators_retired_terminal();

-- ---------------------------------------------------------------------------
-- ai_evaluations — the append-only evaluation OUTCOME records (§12).
--
-- One row = ONE evaluator's outcome for ONE evaluation request (the §8-
-- style logical command identified by (workspace_id, idempotency_key)):
-- the record persists the frozen §12 EvaluationResult shape — evaluatorId
-- (the key label) + evaluatorVersion, pass/fail/score (the verdict + the
-- nullable 0..1 score), dimensions (the rubric breakdown), evidenceRefs
-- (validated citations into the /evidence authority) and
-- uncertaintyOrLimitations (honest disclosure — a model judge's
-- limitations are recorded, never hidden).
--
-- The record is WRITTEN ONCE: the table rejects UPDATE and DELETE
-- (trigger) — corrections append a NEW record. The (workspace_id,
-- idempotency_key, evaluator_key) §8-style fence makes the per-evaluator
-- append converge: a duplicate of the same logical evaluation command
-- replays to the existing row; a key reused for a different command is a
-- conflict, never a silent overwrite.
--
-- Execution linkage is SERVER-PROVEN: the execution reference, when
-- present, is validated through the /executions public API by the module
-- and backstopped here (same-Workspace). The usage-telemetry reference,
-- when present, is the §24 usage row this evaluation judges (same-
-- Workspace). The evaluator reference is REFERENCE data to the registry
-- entry (any lifecycle state — history records evaluations that HAPPENED;
-- the key + version are denormalized so retiring an evaluator never
-- rewrites evaluation history).
--
-- AI-AC-08: there is NO column here that references /metrics KPIs or
-- /experiments outcomes — the evaluation record is task-level context
-- only (profile, execution, usage, evidence citations).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_evaluations (
    evaluation_id           uuid         PRIMARY KEY,
    workspace_id            uuid         NOT NULL REFERENCES workspaces(workspace_id),
    client_id               uuid         NOT NULL REFERENCES clients(client_id),
    agency_id               uuid         NOT NULL REFERENCES agencies(agency_id) ON DELETE CASCADE,
    -- The TaskProfile whose evaluator contract produced this evaluation.
    task_profile_id         uuid         NOT NULL REFERENCES ai_task_profiles(task_profile_id),
    -- Execution context link — REFERENCE data (matrix direction
    -- /ai-runtime ──→ /executions): validated module-side through the
    -- /executions public API and backstopped by the scope-chain trigger.
    -- Nullable: an evaluation may run outside a tracked execution context
    -- (e.g. the evaluator regression matrix).
    execution_id            uuid         REFERENCES executions(execution_id),
    -- The usage-telemetry row this evaluation judges (the §24
    -- evaluator-outcome link). Nullable.
    usage_id                uuid         REFERENCES ai_usage_telemetry(usage_id),
    -- The evaluator registry entry used (any lifecycle state — history).
    evaluator_registry_id   uuid         NOT NULL REFERENCES ai_evaluators(evaluator_registry_id),
    -- The §12 evaluatorId (the key label) + evaluatorVersion,
    -- denormalized at record time (retiring/re-registering the evaluator
    -- never rewrites this history).
    evaluator_key           text         NOT NULL
                            CHECK (length(evaluator_key) >= 2 AND length(evaluator_key) <= 100),
    evaluator_version       integer      NOT NULL CHECK (evaluator_version >= 1),
    -- The §12 pass/fail/score. `unknown` follows the frozen UNKNOWN
    -- semantics: the evaluator could not prove pass or fail — never
    -- auto-resolved to pass.
    verdict                 text         NOT NULL
                            CHECK (verdict IN ('pass', 'fail', 'unknown')),
    -- The normalized 0..1 score (NULL when the evaluator reports a pure
    -- verdict with no score — a signal is never fabricated).
    score                   numeric(6,5) CHECK (score IS NULL OR (score >= 0 AND score <= 1)),
    -- The rubric dimension breakdown (a JSON array of bounded dimension
    -- outcome objects { dimension, verdict, score, notes }).
    dimensions              jsonb        NOT NULL
                            CHECK (jsonb_typeof(dimensions) = 'array'),
    -- The §12 evidenceRefs — validated citations into the /evidence
    -- authority (a JSON array of bounded reference strings; the module
    -- resolves each through the /evidence public API — this table never
    -- becomes a second evidence authority).
    evidence_refs           jsonb        NOT NULL DEFAULT '[]'::jsonb
                            CHECK (jsonb_typeof(evidence_refs) = 'array'),
    -- The §12 uncertaintyOrLimitations — the honest disclosure of what the
    -- evaluator could not prove (bounded text; empty = none disclosed).
    uncertainty_or_limitations text      NOT NULL DEFAULT ''
                            CHECK (length(uncertainty_or_limitations) <= 2000),
    -- Server-derived correlation identity (never caller-supplied).
    correlation_id          text         NOT NULL
                            CHECK (length(correlation_id) >= 1 AND length(correlation_id) <= 128),
    -- §8-style logical append-command key + fingerprint (convergence
    -- proof): one row per (workspace, key, evaluator) — the per-evaluator
    -- slice of ONE evaluation command.
    idempotency_key         text         NOT NULL
                            CHECK (length(idempotency_key) >= 1 AND length(idempotency_key) <= 200),
    create_fingerprint      text         NOT NULL CHECK (length(create_fingerprint) = 64),
    created_by              uuid         REFERENCES users(user_id),
    created_at              timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT ai_evaluations_key_unique UNIQUE (workspace_id, idempotency_key, evaluator_key)
);

CREATE INDEX IF NOT EXISTS ai_evaluations_workspace_idx
    ON ai_evaluations (workspace_id, created_at, evaluation_id);
CREATE INDEX IF NOT EXISTS ai_evaluations_profile_idx
    ON ai_evaluations (task_profile_id, created_at);
CREATE INDEX IF NOT EXISTS ai_evaluations_execution_idx
    ON ai_evaluations (execution_id) WHERE execution_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_evaluations_usage_idx
    ON ai_evaluations (usage_id) WHERE usage_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_evaluations_evaluator_idx
    ON ai_evaluations (evaluator_registry_id, created_at);

-- Append-only backstop: evaluation history is immutable — UPDATE and
-- DELETE are both rejected by the database itself (AI-AC-08 posture +
-- "never rewrite historical records": a corrected evaluation appends a
-- NEW record, it never rewrites the prior outcome).
CREATE OR REPLACE FUNCTION ai_evaluations_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'evaluation records are append-only history (% blocked)',
        TG_OP;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_evaluations_append_only_trigger ON ai_evaluations;
CREATE TRIGGER ai_evaluations_append_only_trigger
    BEFORE UPDATE OR DELETE ON ai_evaluations
    FOR EACH ROW EXECUTE FUNCTION ai_evaluations_append_only();

-- Scope-chain backstop: the evaluation's Client must own its Workspace and
-- its Agency must own that Client; the referenced TaskProfile and the
-- usage-telemetry row must belong to the SAME Workspace; the execution
-- reference, when present, must belong to the SAME Workspace — tenant
-- isolation holds even under direct SQL rewrites.
CREATE OR REPLACE FUNCTION ai_evaluations_scope_chain() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM workspaces w
        WHERE w.workspace_id = NEW.workspace_id
          AND w.client_id = NEW.client_id
    ) THEN
        RAISE EXCEPTION 'evaluation % workspace % does not belong to client %',
            NEW.evaluation_id, NEW.workspace_id, NEW.client_id;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM clients c
        WHERE c.client_id = NEW.client_id
          AND c.agency_id = NEW.agency_id
    ) THEN
        RAISE EXCEPTION 'evaluation % client % does not belong to agency %',
            NEW.evaluation_id, NEW.client_id, NEW.agency_id;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM ai_task_profiles p
        WHERE p.task_profile_id = NEW.task_profile_id
          AND p.workspace_id = NEW.workspace_id
    ) THEN
        RAISE EXCEPTION 'evaluation % task profile % does not belong to workspace %',
            NEW.evaluation_id, NEW.task_profile_id, NEW.workspace_id;
    END IF;
    IF NEW.usage_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM ai_usage_telemetry u
        WHERE u.usage_id = NEW.usage_id
          AND u.workspace_id = NEW.workspace_id
    ) THEN
        RAISE EXCEPTION 'evaluation % usage telemetry % does not belong to workspace %',
            NEW.evaluation_id, NEW.usage_id, NEW.workspace_id;
    END IF;
    IF NEW.execution_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM executions e
        WHERE e.execution_id = NEW.execution_id
          AND e.workspace_id = NEW.workspace_id
    ) THEN
        RAISE EXCEPTION 'evaluation % execution % does not belong to workspace %',
            NEW.evaluation_id, NEW.execution_id, NEW.workspace_id;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM ai_evaluators ev
        WHERE ev.evaluator_registry_id = NEW.evaluator_registry_id
    ) THEN
        RAISE EXCEPTION 'evaluation % evaluator % does not exist',
            NEW.evaluation_id, NEW.evaluator_registry_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_evaluations_scope_chain_trigger ON ai_evaluations;
CREATE TRIGGER ai_evaluations_scope_chain_trigger
    BEFORE INSERT ON ai_evaluations
    FOR EACH ROW EXECUTE FUNCTION ai_evaluations_scope_chain();

-- ---------------------------------------------------------------------------
-- ai_review_requests — the human-review hook records (§7 "human review
-- where needed").
--
-- A review request records review INTENT (why human review is requested —
-- e.g. an evaluator failed or reported unknown/uncertainty) and, after the
-- human acts through the EXISTING Job/Task/Execution authorities, the
-- review OUTCOME (approved / rejected / dismissed). The lifecycle is
-- pending → approved | rejected | dismissed, all terminal, moved by
-- decideReview through an append-only transition row.
--
-- This table is a HOOK, not an engine: it carries no assignment, no
-- claims, no work distribution, no outcome submission — humans act through
-- /jobs and /field-agents (the frozen authorities). The hook only records
-- and surfaces review state.
--
-- The (workspace_id, idempotency_key) §8-style fence makes the logical
-- create command converge: a duplicate of the same command replays; a key
-- reused for a different command is a conflict.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_review_requests (
    review_request_id       uuid         PRIMARY KEY,
    workspace_id            uuid         NOT NULL REFERENCES workspaces(workspace_id),
    client_id               uuid         NOT NULL REFERENCES clients(client_id),
    agency_id               uuid         NOT NULL REFERENCES agencies(agency_id) ON DELETE CASCADE,
    -- Execution context link (validated module-side through /executions;
    -- backstopped by the scope-chain trigger). Nullable: a review request
    -- may cite an evaluation alone.
    execution_id            uuid         REFERENCES executions(execution_id),
    -- The evaluation record that triggered the review (same-Workspace,
    -- backstopped). Nullable.
    evaluation_id           uuid         REFERENCES ai_evaluations(evaluation_id),
    -- The review intent — why human review is requested (bounded text).
    reason                  text         NOT NULL
                            CHECK (length(reason) >= 1 AND length(reason) <= 2000),
    state                   text         NOT NULL DEFAULT 'pending'
                            CHECK (state IN ('pending', 'approved', 'rejected', 'dismissed')),
    -- The deciding human (server-derived from the authenticated principal
    -- at decideReview; never caller-supplied on create).
    decided_by              uuid         REFERENCES users(user_id),
    decided_at              timestamptz,
    -- The decision note (bounded; recorded with the transition).
    decision_note           text         CHECK (decision_note IS NULL OR length(decision_note) <= 2000),
    -- Server-derived correlation identity (never caller-supplied).
    correlation_id          text         NOT NULL
                            CHECK (length(correlation_id) >= 1 AND length(correlation_id) <= 128),
    -- §8-style logical create-command key + fingerprint (convergence proof).
    idempotency_key         text         NOT NULL
                            CHECK (length(idempotency_key) >= 1 AND length(idempotency_key) <= 200),
    create_fingerprint      text         NOT NULL CHECK (length(create_fingerprint) = 64),
    created_by              uuid         REFERENCES users(user_id),
    version                 bigint       NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at              timestamptz  NOT NULL DEFAULT now(),
    updated_at              timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT ai_review_requests_key_unique UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS ai_review_requests_workspace_idx
    ON ai_review_requests (workspace_id, created_at, review_request_id);
CREATE INDEX IF NOT EXISTS ai_review_requests_state_idx
    ON ai_review_requests (workspace_id, state);
CREATE INDEX IF NOT EXISTS ai_review_requests_evaluation_idx
    ON ai_review_requests (evaluation_id) WHERE evaluation_id IS NOT NULL;

-- Content immutability: identity, scope, links, reason and the idempotency
-- identity can NEVER be reassigned. Only the lifecycle fields (state,
-- decided_by/decided_at/decision_note — set once by decideReview), the
-- version CAS token and updated_at ever change.
CREATE OR REPLACE FUNCTION ai_review_requests_content_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW.review_request_id <> OLD.review_request_id THEN
        RAISE EXCEPTION 'review_request_id % is immutable', OLD.review_request_id;
    END IF;
    IF NEW.workspace_id <> OLD.workspace_id
       OR NEW.client_id <> OLD.client_id
       OR NEW.agency_id <> OLD.agency_id THEN
        RAISE EXCEPTION 'review request % scope chain is immutable', OLD.review_request_id;
    END IF;
    IF NEW.execution_id IS DISTINCT FROM OLD.execution_id
       OR NEW.evaluation_id IS DISTINCT FROM OLD.evaluation_id THEN
        RAISE EXCEPTION 'review request % context links are immutable', OLD.review_request_id;
    END IF;
    IF NEW.reason <> OLD.reason THEN
        RAISE EXCEPTION 'review request % reason is immutable', OLD.review_request_id;
    END IF;
    IF NEW.idempotency_key <> OLD.idempotency_key OR NEW.create_fingerprint <> OLD.create_fingerprint THEN
        RAISE EXCEPTION 'review request % idempotency identity is immutable', OLD.review_request_id;
    END IF;
    IF NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'review request % provenance is immutable', OLD.review_request_id;
    END IF;
    IF OLD.state <> 'pending' AND (NEW.state <> OLD.state
       OR NEW.decided_by IS DISTINCT FROM OLD.decided_by
       OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
       OR NEW.decision_note IS DISTINCT FROM OLD.decision_note) THEN
        RAISE EXCEPTION 'review request % is % and terminal — the decision is append-only history',
            OLD.review_request_id, OLD.state;
    END IF;
    IF OLD.state = 'pending' AND NEW.state NOT IN ('pending', 'approved', 'rejected', 'dismissed') THEN
        RAISE EXCEPTION 'illegal review request state % (the lifecycle is pending → approved | rejected | dismissed)',
            NEW.state;
    END IF;
    IF OLD.state = 'pending' AND NEW.state <> 'pending'
       AND (NEW.decided_by IS NULL OR NEW.decided_at IS NULL) THEN
        RAISE EXCEPTION 'review request % decision requires a deciding human and a decision time',
            OLD.review_request_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_review_requests_content_immutable_trigger ON ai_review_requests;
CREATE TRIGGER ai_review_requests_content_immutable_trigger
    BEFORE UPDATE ON ai_review_requests
    FOR EACH ROW EXECUTE FUNCTION ai_review_requests_content_immutable();

-- Scope-chain backstop: the request's Client must own its Workspace and
-- its Agency must own that Client; the execution/evaluation references,
-- when present, must belong to the SAME Workspace.
CREATE OR REPLACE FUNCTION ai_review_requests_scope_chain() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM workspaces w
        WHERE w.workspace_id = NEW.workspace_id
          AND w.client_id = NEW.client_id
    ) THEN
        RAISE EXCEPTION 'review request % workspace % does not belong to client %',
            NEW.review_request_id, NEW.workspace_id, NEW.client_id;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM clients c
        WHERE c.client_id = NEW.client_id
          AND c.agency_id = NEW.agency_id
    ) THEN
        RAISE EXCEPTION 'review request % client % does not belong to agency %',
            NEW.review_request_id, NEW.client_id, NEW.agency_id;
    END IF;
    IF NEW.execution_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM executions e
        WHERE e.execution_id = NEW.execution_id
          AND e.workspace_id = NEW.workspace_id
    ) THEN
        RAISE EXCEPTION 'review request % execution % does not belong to workspace %',
            NEW.review_request_id, NEW.execution_id, NEW.workspace_id;
    END IF;
    IF NEW.evaluation_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM ai_evaluations ev
        WHERE ev.evaluation_id = NEW.evaluation_id
          AND ev.workspace_id = NEW.workspace_id
    ) THEN
        RAISE EXCEPTION 'review request % evaluation % does not belong to workspace %',
            NEW.review_request_id, NEW.evaluation_id, NEW.workspace_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_review_requests_scope_chain_trigger ON ai_review_requests;
CREATE TRIGGER ai_review_requests_scope_chain_trigger
    BEFORE INSERT OR UPDATE ON ai_review_requests
    FOR EACH ROW EXECUTE FUNCTION ai_review_requests_scope_chain();

-- ---------------------------------------------------------------------------
-- ai_review_request_transitions — the append-only transition history.
--
-- One row records the single lifecycle transition (pending → terminal).
-- The UNIQUE (review_request_id) fence makes the transition EXACTLY-ONE
-- (concurrent decideReview calls: one wins, the rest fail — the same
-- concurrency discipline as the jobs exactly-one-winner fence). UPDATE and
-- DELETE are DB-rejected: the transition is append-only history.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_review_request_transitions (
    transition_id           uuid         PRIMARY KEY,
    review_request_id       uuid         NOT NULL
                            REFERENCES ai_review_requests(review_request_id) ON DELETE CASCADE,
    from_state              text         NOT NULL
                            CHECK (from_state IN ('pending', 'approved', 'rejected', 'dismissed')),
    to_state                text         NOT NULL
                            CHECK (to_state IN ('pending', 'approved', 'rejected', 'dismissed')),
    -- The deciding human (server-derived; NULL when a system transition
    -- occurs — none exist today).
    decided_by              uuid         REFERENCES users(user_id),
    note                    text         CHECK (note IS NULL OR length(note) <= 2000),
    created_at              timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT ai_review_request_transitions_request_unique UNIQUE (review_request_id),
    -- A transition must MOVE the lifecycle (never a self-transition).
    CONSTRAINT ai_review_request_transitions_must_move CHECK (from_state <> to_state)
);

CREATE INDEX IF NOT EXISTS ai_review_request_transitions_request_idx
    ON ai_review_request_transitions (review_request_id, created_at);

-- Append-only backstop: review transitions are immutable history.
CREATE OR REPLACE FUNCTION ai_review_request_transitions_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'review request transitions are append-only history (% blocked)',
        TG_OP;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_review_request_transitions_append_only_trigger ON ai_review_request_transitions;
CREATE TRIGGER ai_review_request_transitions_append_only_trigger
    BEFORE UPDATE OR DELETE ON ai_review_request_transitions
    FOR EACH ROW EXECUTE FUNCTION ai_review_request_transitions_append_only();
