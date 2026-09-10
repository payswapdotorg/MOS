-- MKT-018 AI routing and cascades schema (AI-002).
-- PostgreSQL is the system of record (spec/architecture-lock.md).
--
-- Table ownership follows the frozen authority map (implementation-contract
-- §1): "AI routing/evaluation/usage → /ai-runtime". This migration delivers
-- the ROUTING LAYER of the AI Runtime (work-items.md MKT-018: "implement
-- hard eligibility, ranking, cost/latency tradeoffs, cheap-first cascade,
-- escalation and provider adapters"; requirements AI-002; acceptance
-- AI-AC-03..07; spec/ai-runtime-and-routing.md §4 routing policy, §5
-- cascade policy, §6 OpenRouter as adapter only, §9 provider independence):
--
--   * ai_routing_policies     — the WORKSPACE-scoped routing policy
--                               declarations (the admin-managed policy that
--                               the routing core interprets: hard-eligibility
--                               weights, ranking weights, cost/latency
--                               tradeoff weights, cascade order). The policy
--                               CONTENT is immutable after creation; the
--                               single lifecycle edge is active → retired,
--                               retired terminal (the registry posture).
--   * ai_selection_decisions  — the APPEND-ONLY routing-decision record
--                               (AI-AC-06: the authoritative selection records
--                               the eligible-set snapshot, the ranking, the
--                               cost/latency tradeoff, the chosen model and
--                               the cascade step, with cost/latency/
--                               evaluation telemetry when AUTHORITATIVE —
--                               not speculative). Written once: UPDATE and
--                               DELETE are DB-rejected (append-oriented).
--   * ai_cascade_runs         — the recorded, replayable CASCADE structure
--                               (§5: the cascade is a recorded, replayable
--                               structure — state transitions persisted). One
--                               row per cascade execution; the status moves
--                               running → completed | escalated | failed |
--                               unknown, with CAS version and the final
--                               model ref;
--   * ai_cascade_steps        — the APPEND-ONLY per-step record inside one
--                               cascade run (each step records the model
--                               attempted, the step type, the validator result,
--                               the observed cost/latency and the outcome).
--                               Written once; the steps are replayable history.
--
-- Frozen scope guard (MKT-018 boundaries): there is deliberately NO
-- evaluation-result table here (MKT-019, AI-003) and NO provider SDK
-- surface. Provider adapters are implementation-only behind the
-- provider-neutral adapter contract in src/modules/ai-runtime/internal/
-- adapters/ (the architecture test guards the boundary: no provider SDK
-- is imported anywhere, and the OpenRouter adapter uses the platform's
-- HttpCallPort contract — fetch-based, never an SDK).
--
-- Tenancy follows the frozen scope chain (implementation-contract §2):
-- routing policies, selection decisions and cascade runs are
-- WORKSPACE-scoped with server-derived immutable Client/Agency ownership
-- (TENANT-AC-02 posture). The model registry is PLATFORM-level normalized
-- data — the routing references it through model_registry_id FKs (any
-- lifecycle state, since history records invocations that HAPPENED).
--
-- Conventions (implementation-contract §3, §25, mirroring migration 016):
-- server-generated opaque identifiers, created_at/updated_at, version CAS
-- where concurrent mutation is possible, §8-style logical idempotency fences
-- with create fingerprints for append commands, and database triggers as
-- the final backstops for immutability, terminality, append-only history and
-- scope-chain integrity.

-- ---------------------------------------------------------------------------
-- ai_routing_policies — the workspace-scoped routing policy declarations.
--
-- Content is IMMUTABLE after creation (trigger): corrections create a NEW
-- policy row (append-oriented registry). The only mutable columns are
-- status/version/updated_at — the single lifecycle edge is active → retired,
-- retired TERMINAL (a retired policy is a tombstone: routing never re-
-- selects it; a NEW row must carry the correction).
--
-- The (workspace_id, idempotency_key) §8-style fence makes the logical create
-- command converge: a duplicate of the same command (same create fingerprint)
-- replays to the existing row; a key reused for a DIFFERENT command is a
-- conflict, never a silent overwrite.
--
-- The (workspace_id, policy_name) pair is unique among ACTIVE entries —
-- a retired policy's name may be re-registered as a NEW identity.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_routing_policies (
    routing_policy_id       uuid         PRIMARY KEY,
    -- The admin-managed policy name (Workspace-unique among ACTIVE entries).
    policy_name             text         NOT NULL
                            CHECK (length(policy_name) >= 1 AND length(policy_name) <= 100),
    -- The declarative policy content: a bounded JSON object interpreted by
    -- the routing core. Carries:
    --   - hardEligibility: privacy/policy/capability/quota/subscription/
    --     availability filters (declarative — e.g. denylisted provider
    --     labels, required privacy class floor).
    --   - ranking: quality-signal weights per task class (used by the
    --     performance ranking phase).
    --   - tradeoff: cost/latency tradeoff weights (used by the tradeoff
    --     phase).
    --   - cascade: cascade order, max escalations, frontier/human
    --     escalation policy.
    -- The policy is DATA — no provider/model names other than declarative
    -- allow/deny lists of LABELS (which the routing core matches against
    -- the registry entries).
    policy_content          jsonb        NOT NULL
                            CHECK (jsonb_typeof(policy_content) = 'object'),
    -- Server-derived scope chain (immutable).
    workspace_id            uuid         NOT NULL REFERENCES workspaces(workspace_id),
    client_id               uuid         NOT NULL REFERENCES clients(client_id),
    agency_id               uuid         NOT NULL REFERENCES agencies(agency_id) ON DELETE CASCADE,
    status                  text         NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'retired')),
    -- §8-style logical create-command key + fingerprint (convergence proof).
    idempotency_key         text         NOT NULL
                            CHECK (length(idempotency_key) >= 1 AND length(idempotency_key) <= 200),
    create_fingerprint      text         NOT NULL CHECK (length(create_fingerprint) = 64),
    created_by              uuid         REFERENCES users(user_id),
    version                 bigint       NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at              timestamptz  NOT NULL DEFAULT now(),
    updated_at              timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT ai_routing_policies_key_unique UNIQUE (workspace_id, idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_routing_policies_active_name_fence
    ON ai_routing_policies (workspace_id, policy_name) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS ai_routing_policies_workspace_idx
    ON ai_routing_policies (workspace_id, created_at, routing_policy_id);

-- Content immutability (append-oriented registry posture): identity, the
-- policy name, the policy content, the idempotency identity, the server-
-- derived scope and the provenance can NEVER be reassigned through any
-- mutation path. Only status (the single lifecycle edge), version (its CAS
-- token) and updated_at ever change.
CREATE OR REPLACE FUNCTION ai_routing_policies_content_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW.routing_policy_id <> OLD.routing_policy_id THEN
        RAISE EXCEPTION 'routing_policy_id % is immutable', OLD.routing_policy_id;
    END IF;
    IF NEW.policy_name <> OLD.policy_name
       OR NEW.policy_content IS DISTINCT FROM OLD.policy_content THEN
        RAISE EXCEPTION 'routing policy % content is immutable (append-oriented registry: corrections create a NEW policy)',
            OLD.routing_policy_id;
    END IF;
    IF NEW.workspace_id <> OLD.workspace_id THEN
        RAISE EXCEPTION 'routing policy % cannot change Workspace scope (was workspace %)',
            OLD.routing_policy_id, OLD.workspace_id;
    END IF;
    IF NEW.client_id <> OLD.client_id THEN
        RAISE EXCEPTION 'routing policy % Client ownership is immutable (was client %)',
            OLD.routing_policy_id, OLD.client_id;
    END IF;
    IF NEW.agency_id <> OLD.agency_id THEN
        RAISE EXCEPTION 'routing policy % cannot change Agency ownership (was agency %)',
            OLD.routing_policy_id, OLD.agency_id;
    END IF;
    IF NEW.idempotency_key <> OLD.idempotency_key OR NEW.create_fingerprint <> OLD.create_fingerprint THEN
        RAISE EXCEPTION 'routing policy % idempotency identity is immutable', OLD.routing_policy_id;
    END IF;
    IF NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'routing policy % provenance is immutable', OLD.routing_policy_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_routing_policies_content_immutable_trigger ON ai_routing_policies;
CREATE TRIGGER ai_routing_policies_content_immutable_trigger
    BEFORE UPDATE ON ai_routing_policies
    FOR EACH ROW EXECUTE FUNCTION ai_routing_policies_content_immutable();

-- Lifecycle backstop: `retired` is a TERMINAL tombstone.
CREATE OR REPLACE FUNCTION ai_routing_policies_retired_terminal() RETURNS trigger AS $$
BEGIN
    IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN
        RAISE EXCEPTION 'routing policy % is retired and terminal', OLD.routing_policy_id;
    END IF;
    IF OLD.status = 'active' AND NEW.status NOT IN ('active', 'retired') THEN
        RAISE EXCEPTION 'illegal routing policy status % (the lifecycle is active → retired only)',
            NEW.status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_routing_policies_retired_terminal_trigger ON ai_routing_policies;
CREATE TRIGGER ai_routing_policies_retired_terminal_trigger
    BEFORE UPDATE ON ai_routing_policies
    FOR EACH ROW EXECUTE FUNCTION ai_routing_policies_retired_terminal();

-- Scope-chain backstop: the policy's Client must own the recorded Workspace
-- and its Agency must own that Client.
CREATE OR REPLACE FUNCTION ai_routing_policies_scope_chain() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM workspaces w
        WHERE w.workspace_id = NEW.workspace_id
          AND w.client_id = NEW.client_id
    ) THEN
        RAISE EXCEPTION 'routing policy % workspace % does not belong to client %',
            NEW.routing_policy_id, NEW.workspace_id, NEW.client_id;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM clients c
        WHERE c.client_id = NEW.client_id
          AND c.agency_id = NEW.agency_id
    ) THEN
        RAISE EXCEPTION 'routing policy % client % does not belong to agency %',
            NEW.routing_policy_id, NEW.client_id, NEW.agency_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_routing_policies_scope_chain_trigger ON ai_routing_policies;
CREATE TRIGGER ai_routing_policies_scope_chain_trigger
    BEFORE INSERT OR UPDATE ON ai_routing_policies
    FOR EACH ROW EXECUTE FUNCTION ai_routing_policies_scope_chain();

-- ---------------------------------------------------------------------------
-- ai_selection_decisions — the append-only routing-decision record (AI-AC-06).
--
-- The record of a ROUTING DECISION (§4 + §5 + §24 telemetry): which
-- TaskProfile requested routing, which policy was applied, the eligible-
-- set SNAPSHOT (which models passed the hard-eligibility phase, and which
-- were filtered out with the reason), the performance RANKING, the cost/
-- latency TRADEOFF, the CHOSEN model, the cascade run link (if any), the
-- phase trace (the ordered phase sequence — eligibility → ranking →
-- tradeoff → selection, the AI-AC-04 proof), and — when AUTHORITATIVE
-- (not speculative) — the observed cost/latency/evaluation telemetry.
--
-- The record is WRITTEN ONCE: the table rejects UPDATE and DELETE (trigger)
-- — corrections append a NEW record. The (workspace_id, idempotency_key)
-- §8-style fence makes the logical append command converge: a duplicate of
-- the same command (same fingerprint) replays; a key reused for a different
-- command is a conflict.
--
-- The model ref is REFERENCE DATA to the registry entry (any lifecycle
-- state — history records decisions that HAPPENED, and retiring a candidate
-- never rewrites history). The routing policy ref, when present, must
-- belong to the SAME Workspace (uniform NotFoundError otherwise — a
-- foreign policy id is not a traversal oracle).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_selection_decisions (
    selection_id            uuid         PRIMARY KEY,
    workspace_id            uuid         NOT NULL REFERENCES workspaces(workspace_id),
    client_id               uuid         NOT NULL REFERENCES clients(client_id),
    agency_id               uuid         NOT NULL REFERENCES agencies(agency_id) ON DELETE CASCADE,
    -- The TaskProfile this decision routed (the request class link).
    task_profile_id         uuid         NOT NULL REFERENCES ai_task_profiles(task_profile_id),
    -- The routing policy applied (nullable: a default policy may run without
    -- a persisted policy record — the decision still records the phase
    -- trace and the eligible set).
    routing_policy_id       uuid         REFERENCES ai_routing_policies(routing_policy_id),
    -- The eligible-set snapshot: a JSON array of { modelRegistryId, eligible,
    -- reason } — the hard-eligibility phase output (which models passed,
    -- which were filtered out and why).
    eligible_set            jsonb        NOT NULL
                            CHECK (jsonb_typeof(eligible_set) = 'array'),
    -- The performance ranking: a JSON array of { modelRegistryId, score,
    -- components } — the ranking phase output, ordered by score descending.
    ranking                 jsonb        NOT NULL
                            CHECK (jsonb_typeof(ranking) = 'array'),
    -- The cost/latency tradeoff: a JSON array of { modelRegistryId, score,
    -- costComponent, latencyComponent, qualityComponent } — the tradeoff
    -- phase output, ordered by tradeoff score descending.
    tradeoff                jsonb        NOT NULL
                            CHECK (jsonb_typeof(tradeoff) = 'array'),
    -- The CHOSEN model (the highest-tradeoff-score eligible model).
    chosen_model_registry_id uuid        NOT NULL REFERENCES ai_model_registry(model_registry_id),
    -- The cascade run link (nullable: a single-shot selection has no
    -- cascade run; a cascade-driven selection links the run).
    cascade_run_id          uuid,
    -- The phase trace: a JSON array of phase labels in execution order
    -- (the AI-AC-04 proof: eligibility → ranking → tradeoff → selection).
    phase_trace             jsonb        NOT NULL
                            CHECK (jsonb_typeof(phase_trace) = 'array'),
    -- AUTHORITATIVE vs SPECULATIVE: when true, the observed cost/latency/
    -- evaluation telemetry below is recorded (the selection actually ran
    -- and produced a measurable outcome). When false, the row is a routing
    -- decision snapshot without observed telemetry (e.g., a speculative
    -- pre-routing evaluation, or a cascade in flight).
    authoritative           boolean      NOT NULL DEFAULT false,
    -- Observed cost/latency, recorded when AUTHORITATIVE (NULL when
    -- speculative — the signal is never fabricated).
    observed_latency_ms     bigint       CHECK (observed_latency_ms IS NULL OR observed_latency_ms >= 0),
    observed_cost_amount    numeric(12,6) CHECK (observed_cost_amount IS NULL OR observed_cost_amount >= 0),
    -- Evaluation outcome link (recorded when AUTHORITATIVE; opaque
    -- bounded reference; the evaluation authority is MKT-019).
    evaluation_ref          text         CHECK (evaluation_ref IS NULL OR (length(evaluation_ref) >= 1 AND length(evaluation_ref) <= 512)),
    -- Server-derived correlation identity (never caller-supplied).
    correlation_id          text         NOT NULL
                            CHECK (length(correlation_id) >= 1 AND length(correlation_id) <= 128),
    -- §8-style logical append-command key + fingerprint (convergence proof).
    idempotency_key         text         NOT NULL
                            CHECK (length(idempotency_key) >= 1 AND length(idempotency_key) <= 200),
    create_fingerprint      text         NOT NULL CHECK (length(create_fingerprint) = 64),
    created_by              uuid         REFERENCES users(user_id),
    created_at              timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT ai_selection_decisions_key_unique UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS ai_selection_decisions_workspace_idx
    ON ai_selection_decisions (workspace_id, created_at, selection_id);
CREATE INDEX IF NOT EXISTS ai_selection_decisions_profile_idx
    ON ai_selection_decisions (task_profile_id, created_at);
CREATE INDEX IF NOT EXISTS ai_selection_decisions_model_idx
    ON ai_selection_decisions (chosen_model_registry_id, created_at);
CREATE INDEX IF NOT EXISTS ai_selection_decisions_cascade_idx
    ON ai_selection_decisions (cascade_run_id) WHERE cascade_run_id IS NOT NULL;

-- Append-only backstop: selection decisions are immutable history — UPDATE
-- and DELETE are both rejected by the database itself (AI-AC-06 — the
-- authoritative selection record is never overwritten; corrections append
-- new records).
CREATE OR REPLACE FUNCTION ai_selection_decisions_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'selection decisions are append-only history (% blocked)',
        TG_OP;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_selection_decisions_append_only_trigger ON ai_selection_decisions;
CREATE TRIGGER ai_selection_decisions_append_only_trigger
    BEFORE UPDATE OR DELETE ON ai_selection_decisions
    FOR EACH ROW EXECUTE FUNCTION ai_selection_decisions_append_only();

-- Scope-chain backstop: the decision's Client must own its Workspace and
-- its Agency must own that Client; the referenced TaskProfile must belong
-- to the SAME Workspace; the referenced routing policy, when present,
-- must belong to the SAME Workspace.
CREATE OR REPLACE FUNCTION ai_selection_decisions_scope_chain() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM workspaces w
        WHERE w.workspace_id = NEW.workspace_id
          AND w.client_id = NEW.client_id
    ) THEN
        RAISE EXCEPTION 'selection decision % workspace % does not belong to client %',
            NEW.selection_id, NEW.workspace_id, NEW.client_id;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM clients c
        WHERE c.client_id = NEW.client_id
          AND c.agency_id = NEW.agency_id
    ) THEN
        RAISE EXCEPTION 'selection decision % client % does not belong to agency %',
            NEW.selection_id, NEW.client_id, NEW.agency_id;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM ai_task_profiles p
        WHERE p.task_profile_id = NEW.task_profile_id
          AND p.workspace_id = NEW.workspace_id
    ) THEN
        RAISE EXCEPTION 'selection decision % task profile % does not belong to workspace %',
            NEW.selection_id, NEW.task_profile_id, NEW.workspace_id;
    END IF;
    IF NEW.routing_policy_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM ai_routing_policies rp
        WHERE rp.routing_policy_id = NEW.routing_policy_id
          AND rp.workspace_id = NEW.workspace_id
    ) THEN
        RAISE EXCEPTION 'selection decision % routing policy % does not belong to workspace %',
            NEW.selection_id, NEW.routing_policy_id, NEW.workspace_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_selection_decisions_scope_chain_trigger ON ai_selection_decisions;
CREATE TRIGGER ai_selection_decisions_scope_chain_trigger
    BEFORE INSERT ON ai_selection_decisions
    FOR EACH ROW EXECUTE FUNCTION ai_selection_decisions_scope_chain();

-- ---------------------------------------------------------------------------
-- ai_cascade_runs — the recorded, replayable cascade structure (§5).
--
-- One row per cascade execution. The status moves running → completed |
-- escalated | failed | unknown with CAS version. The final model ref is
-- recorded when the cascade completes; the escalation count records how
-- many escalations happened (used by the §24 telemetry aggregation).
--
-- The cascade is a RECORDED, REPLAYABLE structure: state transitions are
-- persisted (the steps table holds the per-step history; the run row holds
-- the overall state and CAS version). The (workspace_id, idempotency_key)
-- §8-style fence makes the logical cascade-start command converge.
--
-- `unknown` follows the frozen UNKNOWN semantics: the cascade outcome could
-- not be proven — never success, never auto-resolved; a resolution appends a
-- NEW record (the run row's status moves out of `unknown` via CAS, but a
-- previously-`unknown` row's history is never rewritten).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_cascade_runs (
    cascade_run_id          uuid         PRIMARY KEY,
    workspace_id            uuid         NOT NULL REFERENCES workspaces(workspace_id),
    client_id               uuid         NOT NULL REFERENCES clients(client_id),
    agency_id               uuid         NOT NULL REFERENCES agencies(agency_id) ON DELETE CASCADE,
    -- The TaskProfile this cascade served.
    task_profile_id         uuid         NOT NULL REFERENCES ai_task_profiles(task_profile_id),
    -- The routing policy applied (nullable: a default policy may run).
    routing_policy_id       uuid         REFERENCES ai_routing_policies(routing_policy_id),
    -- The cascade state.
    status                  text         NOT NULL DEFAULT 'running'
                            CHECK (status IN ('running', 'completed', 'escalated', 'failed', 'unknown')),
    -- The final model that satisfied the validator (NULL while the cascade
    -- is in flight or did not complete successfully).
    final_model_registry_id uuid         REFERENCES ai_model_registry(model_registry_id),
    -- The escalation count (§24 telemetry aggregation).
    escalation_count        integer      NOT NULL DEFAULT 0 CHECK (escalation_count >= 0),
    -- The maximum escalations allowed by the policy (denormalized for
    -- replayable inspection of the policy at the time of the cascade).
    max_escalations         integer      NOT NULL DEFAULT 0 CHECK (max_escalations >= 0),
    -- Server-derived correlation identity (never caller-supplied).
    correlation_id          text         NOT NULL
                            CHECK (length(correlation_id) >= 1 AND length(correlation_id) <= 128),
    -- §8-style logical cascade-start key + fingerprint (convergence proof).
    idempotency_key         text         NOT NULL
                            CHECK (length(idempotency_key) >= 1 AND length(idempotency_key) <= 200),
    create_fingerprint      text         NOT NULL CHECK (length(create_fingerprint) = 64),
    created_by              uuid         REFERENCES users(user_id),
    version                 bigint       NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at              timestamptz  NOT NULL DEFAULT now(),
    updated_at              timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT ai_cascade_runs_key_unique UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS ai_cascade_runs_workspace_idx
    ON ai_cascade_runs (workspace_id, created_at, cascade_run_id);
CREATE INDEX IF NOT EXISTS ai_cascade_runs_profile_idx
    ON ai_cascade_runs (task_profile_id, created_at);
CREATE INDEX IF NOT EXISTS ai_cascade_runs_status_idx
    ON ai_cascade_runs (workspace_id, status) WHERE status IN ('running', 'unknown');

-- Scope-chain backstop.
CREATE OR REPLACE FUNCTION ai_cascade_runs_scope_chain() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM workspaces w
        WHERE w.workspace_id = NEW.workspace_id
          AND w.client_id = NEW.client_id
    ) THEN
        RAISE EXCEPTION 'cascade run % workspace % does not belong to client %',
            NEW.cascade_run_id, NEW.workspace_id, NEW.client_id;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM clients c
        WHERE c.client_id = NEW.client_id
          AND c.agency_id = NEW.agency_id
    ) THEN
        RAISE EXCEPTION 'cascade run % client % does not belong to agency %',
            NEW.cascade_run_id, NEW.client_id, NEW.agency_id;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM ai_task_profiles p
        WHERE p.task_profile_id = NEW.task_profile_id
          AND p.workspace_id = NEW.workspace_id
    ) THEN
        RAISE EXCEPTION 'cascade run % task profile % does not belong to workspace %',
            NEW.cascade_run_id, NEW.task_profile_id, NEW.workspace_id;
    END IF;
    IF NEW.routing_policy_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM ai_routing_policies rp
        WHERE rp.routing_policy_id = NEW.routing_policy_id
          AND rp.workspace_id = NEW.workspace_id
    ) THEN
        RAISE EXCEPTION 'cascade run % routing policy % does not belong to workspace %',
            NEW.cascade_run_id, NEW.routing_policy_id, NEW.workspace_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_cascade_runs_scope_chain_trigger ON ai_cascade_runs;
CREATE TRIGGER ai_cascade_runs_scope_chain_trigger
    BEFORE INSERT OR UPDATE ON ai_cascade_runs
    FOR EACH ROW EXECUTE FUNCTION ai_cascade_runs_scope_chain();

-- ---------------------------------------------------------------------------
-- ai_cascade_steps — the append-only per-step record inside one cascade.
--
-- Each row records one cascade step (cheap-first / fan-out / escalate /
-- frontier / human): the model attempted, the step type, the validator
-- result, the validator reason (when failed), the observed cost/latency, the
-- evaluation link and the outcome. Written once; UPDATE and DELETE are
-- DB-rejected (append-only history — the cascade is replayable).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_cascade_steps (
    cascade_step_id         uuid         PRIMARY KEY,
    cascade_run_id          uuid         NOT NULL
                            REFERENCES ai_cascade_runs(cascade_run_id) ON DELETE CASCADE,
    -- The step index (0-based; unique within the cascade run).
    step_index              integer      NOT NULL CHECK (step_index >= 0),
    -- The model attempted in this step.
    model_registry_id       uuid         NOT NULL REFERENCES ai_model_registry(model_registry_id),
    -- The step type (§5: cheap/deterministic first, fan-out, escalate,
    -- frontier, human).
    step_type               text         NOT NULL
                            CHECK (step_type IN ('cheap-first', 'fan-out', 'escalate', 'frontier', 'human')),
    -- The validator result.
    validator_result        text         NOT NULL DEFAULT 'pending'
                            CHECK (validator_result IN ('pending', 'passed', 'failed', 'unknown')),
    -- The validator reason (when failed; NULL when passed or pending).
    validator_reason        text         CHECK (validator_reason IS NULL OR length(validator_reason) <= 512),
    -- Observed cost/latency (NULL when the step did not invoke — e.g., a
    -- human escalation step records no observed latency).
    observed_latency_ms     bigint       CHECK (observed_latency_ms IS NULL OR observed_latency_ms >= 0),
    observed_cost_amount    numeric(12,6) CHECK (observed_cost_amount IS NULL OR observed_cost_amount >= 0),
    -- Evaluation outcome link.
    evaluation_ref          text         CHECK (evaluation_ref IS NULL OR (length(evaluation_ref) >= 1 AND length(evaluation_ref) <= 512)),
    -- The step outcome (matches the §24 telemetry vocabulary).
    outcome                 text         NOT NULL DEFAULT 'unknown'
                            CHECK (outcome IN ('succeeded', 'failed', 'escalated', 'unknown')),
    created_at              timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT ai_cascade_steps_run_step_unique UNIQUE (cascade_run_id, step_index)
);

CREATE INDEX IF NOT EXISTS ai_cascade_steps_run_idx
    ON ai_cascade_steps (cascade_run_id, step_index);
CREATE INDEX IF NOT EXISTS ai_cascade_steps_model_idx
    ON ai_cascade_steps (model_registry_id, created_at);

-- Append-only backstop: cascade steps are immutable history.
CREATE OR REPLACE FUNCTION ai_cascade_steps_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'cascade steps are append-only history (% blocked)',
        TG_OP;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_cascade_steps_append_only_trigger ON ai_cascade_steps;
CREATE TRIGGER ai_cascade_steps_append_only_trigger
    BEFORE UPDATE OR DELETE ON ai_cascade_steps
    FOR EACH ROW EXECUTE FUNCTION ai_cascade_steps_append_only();
