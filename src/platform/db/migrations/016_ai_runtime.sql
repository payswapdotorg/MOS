-- MKT-017 AI task profile and model registry schema (AI-001).
-- PostgreSQL is the system of record (spec/architecture-lock.md).
--
-- Table ownership follows the frozen authority map (implementation-contract
-- §1): "AI routing/evaluation/usage → /ai-runtime". This migration delivers
-- the REGISTRY LAYER of the AI Runtime only (work-items.md MKT-017:
-- "implement provider-neutral TaskProfile and normalized model
-- capability/telemetry registry"; requirements AI-001; acceptance
-- AI-AC-01..02):
--
--   * ai_task_profiles     — the provider-neutral TASK PROFILE
--                            (implementation-contract §10: task class, quality
--                            target, risk class, context requirements, latency
--                            target, maximum cost, privacy class, tool
--                            requirements, output schema, evaluator contract,
--                            escalation policy). A TaskProfile is the NEUTRAL
--                            REQUEST CONTRACT that routing (MKT-018) and
--                            adapters (later Work Items) consume: it carries
--                            NO provider names, NO model names and NO
--                            credentials — there is deliberately NO column
--                            capable of holding any of those (AI-AC-01);
--   * ai_model_registry    — the normalized MODEL REGISTRY
--                            (ai-runtime-and-routing.md §3: modality/capability,
--                            context limit, supported tool features,
--                            approximate cost, latency distribution,
--                            reliability, evaluator performance by task class,
--                            privacy characteristics, availability). The
--                            provider/model identities are LABELS — data, never
--                            SDK imports (AI-AC-02);
--   * ai_model_observations— the append-only availability/telemetry
--                            observations behind the registry's current
--                            availability state (history is never overwritten;
--                            the current state is derived from the LATEST
--                            appended observation);
--   * ai_usage_telemetry   — the append-only USAGE TELEMETRY record
--                            (architecture.md §24: model/provider, request
--                            class link, tokens/compute where available, cost,
--                            latency, evaluator outcome link, escalation count;
--                            ai-runtime-and-routing.md §8: model evaluations
--                            and business outcomes remain separate datasets
--                            linked through execution identifiers).
--
-- Frozen scope guard (MKT-017 boundaries): there is deliberately NO routing
-- policy state, NO eligibility/cascade table, NO evaluation result table and
-- NO provider adapter/invocation surface here — those are MKT-018/MKT-019.
--
-- Tenancy follows the frozen scope chain (implementation-contract §2):
--   Agency → Client → Workspace → Task/Execution. TaskProfiles and usage
--   telemetry are WORKSPACE-scoped with the server-derived immutable
--   Client/Agency ownership columns (TENANT-AC-02 posture). The model
--   registry is PLATFORM-level normalized data (models are global facts;
--   tenant-level availability/subscription eligibility is a routing hard
--   filter for MKT-018, never a registry ownership concern).
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, created_at/updated_at, version CAS where concurrent mutation
-- is possible, §8-style logical idempotency fences with create fingerprints
-- for append commands, and database triggers as the final backstops for
-- immutability, terminality, append-only history and scope-chain integrity.

-- ---------------------------------------------------------------------------
-- ai_task_profiles — the provider-neutral TaskProfile registry.
--
-- Content is IMMUTABLE after creation (trigger): corrections create a NEW
-- profile row (append-oriented registry), never an overwrite. The only
-- mutable columns are status/version/updated_at — the single lifecycle edge
-- is active → retired, with `retired` TERMINAL (a retired profile is a
-- tombstone: its identifiers can never be replayed back to routing use, and
-- a NEW row must carry the correction).
--
-- The (workspace_id, idempotency_key) §8-style fence makes the logical
-- create command converge: a duplicate of the same command (same create
-- fingerprint) replays to the existing row; a key reused for a DIFFERENT
-- command is a conflict, never a silent overwrite.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_task_profiles (
    task_profile_id          uuid         PRIMARY KEY,
    -- The provider-neutral task CLASS (implementation-contract §10): a
    -- normalized label determined by the application/task definition, never
    -- by the provider. No provider/model names may appear here (module
    -- guard + architecture tests enforce the vocabulary shape).
    task_class               text         NOT NULL
                             CHECK (length(task_class) >= 2 AND length(task_class) <= 100),
    quality_target           text         NOT NULL
                             CHECK (length(quality_target) >= 1 AND length(quality_target) <= 100),
    risk_class               text         NOT NULL
                             CHECK (risk_class IN ('low', 'medium', 'high')),
    -- The INPUT CONTRACT (context requirements): a bounded JSON object
    -- (e.g. token bounds, required context modalities) interpreted by
    -- routing (MKT-018). Kept as declared data, top-level shape fenced.
    context_requirements     jsonb        NOT NULL CHECK (jsonb_typeof(context_requirements) = 'object'),
    latency_target_ms        bigint       NOT NULL CHECK (latency_target_ms >= 1),
    -- Budget upper bound per invocation, normalized cost units. Hard filter
    -- material for routing (implementation-contract §11 "budget upper bound").
    max_cost_per_invocation  numeric(12,6) NOT NULL CHECK (max_cost_per_invocation >= 0),
    privacy_class            text         NOT NULL
                             CHECK (privacy_class IN ('public', 'internal', 'confidential', 'restricted')),
    -- Required tool features: a JSON array of normalized labels.
    tool_requirements        jsonb        NOT NULL DEFAULT '[]'::jsonb
                             CHECK (jsonb_typeof(tool_requirements) = 'array'),
    -- The OUTPUT CONTRACT: a bounded JSON-schema-shaped object. An output
    -- that fails schema validation is never accepted (implementation-contract
    -- §11 cascade contract) — the profile carries the contract.
    output_schema            jsonb        NOT NULL CHECK (jsonb_typeof(output_schema) = 'object'),
    -- Evaluation hooks (placeholders until the evaluation framework,
    -- MKT-019): normalized evaluator identifiers.
    evaluator_ids            jsonb        NOT NULL DEFAULT '[]'::jsonb
                             CHECK (jsonb_typeof(evaluator_ids) = 'array'),
    -- Escalation policy declaration (e.g. escalation budget, fallback):
    -- bounded JSON object interpreted by routing (MKT-018).
    escalation_policy        jsonb        NOT NULL CHECK (jsonb_typeof(escalation_policy) = 'object'),
    -- Server-derived scope chain (immutable).
    workspace_id             uuid         NOT NULL REFERENCES workspaces(workspace_id),
    client_id                uuid         NOT NULL REFERENCES clients(client_id),
    agency_id                uuid         NOT NULL REFERENCES agencies(agency_id) ON DELETE CASCADE,
    status                   text         NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'retired')),
    -- §8-style logical create-command key + fingerprint (convergence proof).
    idempotency_key          text         NOT NULL
                             CHECK (length(idempotency_key) >= 1 AND length(idempotency_key) <= 200),
    create_fingerprint       text         NOT NULL CHECK (length(create_fingerprint) = 64),
    created_by               uuid         REFERENCES users(user_id),
    version                  bigint       NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at               timestamptz  NOT NULL DEFAULT now(),
    updated_at               timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT ai_task_profiles_key_unique UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS ai_task_profiles_workspace_idx
    ON ai_task_profiles (workspace_id, created_at, task_profile_id);
CREATE INDEX IF NOT EXISTS ai_task_profiles_task_class_idx
    ON ai_task_profiles (workspace_id, task_class) WHERE status = 'active';

-- Registry content is immutable (implementation-contract §3 + the
-- append-oriented registry posture): identity, the full neutral contract,
-- the idempotency identity, the server-derived scope and the provenance can
-- NEVER be reassigned through ANY mutation path. Only status (the single
-- lifecycle edge), version (its CAS token) and updated_at ever change.
CREATE OR REPLACE FUNCTION ai_task_profiles_content_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW.task_profile_id <> OLD.task_profile_id THEN
        RAISE EXCEPTION 'task_profile_id % is immutable', OLD.task_profile_id;
    END IF;
    IF NEW.task_class <> OLD.task_class
       OR NEW.quality_target <> OLD.quality_target
       OR NEW.risk_class <> OLD.risk_class
       OR NEW.context_requirements IS DISTINCT FROM OLD.context_requirements
       OR NEW.latency_target_ms <> OLD.latency_target_ms
       OR NEW.max_cost_per_invocation <> OLD.max_cost_per_invocation
       OR NEW.privacy_class <> OLD.privacy_class
       OR NEW.tool_requirements IS DISTINCT FROM OLD.tool_requirements
       OR NEW.output_schema IS DISTINCT FROM OLD.output_schema
       OR NEW.evaluator_ids IS DISTINCT FROM OLD.evaluator_ids
       OR NEW.escalation_policy IS DISTINCT FROM OLD.escalation_policy THEN
        RAISE EXCEPTION 'task profile % content is immutable (append-oriented registry: corrections create a NEW profile)',
            OLD.task_profile_id;
    END IF;
    IF NEW.workspace_id <> OLD.workspace_id THEN
        RAISE EXCEPTION 'task profile % cannot change Workspace scope (was workspace %)',
            OLD.task_profile_id, OLD.workspace_id;
    END IF;
    IF NEW.client_id <> OLD.client_id THEN
        RAISE EXCEPTION 'task profile % Client ownership is immutable (was client %)',
            OLD.task_profile_id, OLD.client_id;
    END IF;
    IF NEW.agency_id <> OLD.agency_id THEN
        RAISE EXCEPTION 'task profile % cannot change Agency ownership (was agency %)',
            OLD.task_profile_id, OLD.agency_id;
    END IF;
    IF NEW.idempotency_key <> OLD.idempotency_key OR NEW.create_fingerprint <> OLD.create_fingerprint THEN
        RAISE EXCEPTION 'task profile % idempotency identity is immutable', OLD.task_profile_id;
    END IF;
    IF NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'task profile % provenance is immutable', OLD.task_profile_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_task_profiles_content_immutable_trigger ON ai_task_profiles;
CREATE TRIGGER ai_task_profiles_content_immutable_trigger
    BEFORE UPDATE ON ai_task_profiles
    FOR EACH ROW EXECUTE FUNCTION ai_task_profiles_content_immutable();

-- Lifecycle backstop: `retired` is a TERMINAL tombstone — the only lifecycle
-- edge is active → retired, and a retired profile can never silently return
-- to routing use via UPDATE.
CREATE OR REPLACE FUNCTION ai_task_profiles_retired_terminal() RETURNS trigger AS $$
BEGIN
    IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN
        RAISE EXCEPTION 'task profile % is retired and terminal', OLD.task_profile_id;
    END IF;
    IF OLD.status = 'active' AND NEW.status NOT IN ('active', 'retired') THEN
        RAISE EXCEPTION 'illegal task profile status % (the lifecycle is active → retired only)',
            NEW.status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_task_profiles_retired_terminal_trigger ON ai_task_profiles;
CREATE TRIGGER ai_task_profiles_retired_terminal_trigger
    BEFORE UPDATE ON ai_task_profiles
    FOR EACH ROW EXECUTE FUNCTION ai_task_profiles_retired_terminal();

-- Scope-chain backstop (same posture as every workspace-scoped authority):
-- the profile's Client must own the recorded Workspace and its Agency must
-- own that Client — the chain (Agency → Client → Workspace → Task) cannot be
-- crossed through any column even if every application check were bypassed.
CREATE OR REPLACE FUNCTION ai_task_profiles_scope_chain() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM workspaces w
        WHERE w.workspace_id = NEW.workspace_id
          AND w.client_id = NEW.client_id
    ) THEN
        RAISE EXCEPTION 'task profile % workspace % does not belong to client %',
            NEW.task_profile_id, NEW.workspace_id, NEW.client_id;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM clients c
        WHERE c.client_id = NEW.client_id
          AND c.agency_id = NEW.agency_id
    ) THEN
        RAISE EXCEPTION 'task profile % client % does not belong to agency %',
            NEW.task_profile_id, NEW.client_id, NEW.agency_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_task_profiles_scope_chain_trigger ON ai_task_profiles;
CREATE TRIGGER ai_task_profiles_scope_chain_trigger
    BEFORE INSERT OR UPDATE ON ai_task_profiles
    FOR EACH ROW EXECUTE FUNCTION ai_task_profiles_scope_chain();

-- ---------------------------------------------------------------------------
-- ai_model_registry — the normalized model registry (platform-level data).
--
-- The provider and model identities are LABELS (data). Adding a provider
-- requires a registry entry and (later) an adapter — never a domain change
-- (ai-runtime-and-routing.md §9). The DECLARED signals (capabilities, tool
-- features, context limit, cost, latency, reliability, quality signals,
-- privacy characteristics) are IMMUTABLE after registration: corrections
-- retire the entry and register a NEW one (append-oriented). The only
-- mutable columns are availability_state (the current state, derived from
-- the LATEST appended observation), version (its CAS token) and updated_at.
--
-- The (provider_label, model_key) pair is unique among ACTIVE entries —
-- race-free under concurrent registration; a retired entry's pair may be
-- re-registered as a NEW identity.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_model_registry (
    model_registry_id      uuid          PRIMARY KEY,
    -- Provider LABEL (data, never an SDK import — AI-AC-02).
    provider_label         text          NOT NULL
                           CHECK (length(provider_label) >= 2 AND length(provider_label) <= 64),
    -- Normalized model key label (data).
    model_key              text          NOT NULL
                           CHECK (length(model_key) >= 1 AND length(model_key) <= 128),
    display_name           text          NOT NULL
                           CHECK (length(display_name) >= 1 AND length(display_name) <= 200),
    -- Modality/capability matrix: a JSON array of normalized labels.
    capabilities           jsonb         NOT NULL
                           CHECK (jsonb_typeof(capabilities) = 'array'),
    -- Supported tool features: a JSON array of normalized labels.
    tool_features          jsonb         NOT NULL DEFAULT '[]'::jsonb
                           CHECK (jsonb_typeof(tool_features) = 'array'),
    context_limit_tokens   bigint        NOT NULL CHECK (context_limit_tokens >= 1),
    -- Approximate cost signals, normalized cost units per million tokens
    -- (NULL = unknown — the signal is never fabricated).
    cost_input_per_mtok    numeric(12,4) CHECK (cost_input_per_mtok IS NULL OR cost_input_per_mtok >= 0),
    cost_output_per_mtok   numeric(12,4) CHECK (cost_output_per_mtok IS NULL OR cost_output_per_mtok >= 0),
    -- Declared latency distribution signals in milliseconds (NULL = unknown).
    latency_p50_ms         bigint        CHECK (latency_p50_ms IS NULL OR latency_p50_ms >= 0),
    latency_p95_ms         bigint        CHECK (latency_p95_ms IS NULL OR latency_p95_ms >= 0),
    -- Reliability signal, 0..1 (NULL = unknown).
    reliability            numeric(5,4)  CHECK (reliability IS NULL OR (reliability >= 0 AND reliability <= 1)),
    -- Evaluator performance BY TASK CLASS (ai-runtime-and-routing.md §3):
    -- a JSON object of task-class → performance signal data. Interpreted by
    -- routing; recorded here as normalized data.
    quality_signals        jsonb         NOT NULL DEFAULT '{}'::jsonb
                           CHECK (jsonb_typeof(quality_signals) = 'object'),
    -- Privacy characteristics: a JSON object of normalized declarations
    -- (e.g. data residency, training-use flags). Data only.
    privacy_characteristics jsonb        NOT NULL DEFAULT '{}'::jsonb
                           CHECK (jsonb_typeof(privacy_characteristics) = 'object'),
    -- CURRENT availability state — server-derived from the LATEST appended
    -- observation (never caller-supplied, never directly updatable).
    availability_state     text          NOT NULL DEFAULT 'available'
                           CHECK (availability_state IN ('available', 'degraded', 'unavailable')),
    status                 text          NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'retired')),
    created_by             uuid          REFERENCES users(user_id),
    version                bigint        NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at             timestamptz   NOT NULL DEFAULT now(),
    updated_at             timestamptz   NOT NULL DEFAULT now()
);

-- Registration fence: one ACTIVE registry entry per (provider_label,
-- model_key) — concurrent duplicate registrations converge to exactly one
-- winner; a retired entry frees the pair for a NEW identity.
CREATE UNIQUE INDEX IF NOT EXISTS ai_model_registry_active_pair_fence
    ON ai_model_registry (provider_label, model_key) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS ai_model_registry_provider_idx
    ON ai_model_registry (provider_label, model_key);

-- Declared-signal immutability: identity, the provider/model labels, the
-- display name, the capability/cost/latency/reliability/quality/privacy
-- DECLARED signals and the provenance are immutable after registration —
-- corrections retire + re-register (append-oriented registry). The ONLY
-- mutable columns are the observation-derived current availability_state,
-- its version CAS token and updated_at.
CREATE OR REPLACE FUNCTION ai_model_registry_declared_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW.model_registry_id <> OLD.model_registry_id THEN
        RAISE EXCEPTION 'model_registry_id % is immutable', OLD.model_registry_id;
    END IF;
    IF NEW.provider_label <> OLD.provider_label OR NEW.model_key <> OLD.model_key THEN
        RAISE EXCEPTION 'model % (% / %) identity labels are immutable — re-register as a new entry',
            OLD.model_registry_id, OLD.provider_label, OLD.model_key;
    END IF;
    IF NEW.display_name <> OLD.display_name
       OR NEW.capabilities IS DISTINCT FROM OLD.capabilities
       OR NEW.tool_features IS DISTINCT FROM OLD.tool_features
       OR NEW.context_limit_tokens <> OLD.context_limit_tokens
       OR NEW.cost_input_per_mtok IS DISTINCT FROM OLD.cost_input_per_mtok
       OR NEW.cost_output_per_mtok IS DISTINCT FROM OLD.cost_output_per_mtok
       OR NEW.latency_p50_ms IS DISTINCT FROM OLD.latency_p50_ms
       OR NEW.latency_p95_ms IS DISTINCT FROM OLD.latency_p95_ms
       OR NEW.reliability IS DISTINCT FROM OLD.reliability
       OR NEW.quality_signals IS DISTINCT FROM OLD.quality_signals
       OR NEW.privacy_characteristics IS DISTINCT FROM OLD.privacy_characteristics THEN
        RAISE EXCEPTION 'model % declared signals are immutable (append-oriented registry: retire and re-register)',
            OLD.model_registry_id;
    END IF;
    IF NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'model % provenance is immutable', OLD.model_registry_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_model_registry_declared_immutable_trigger ON ai_model_registry;
CREATE TRIGGER ai_model_registry_declared_immutable_trigger
    BEFORE UPDATE ON ai_model_registry
    FOR EACH ROW EXECUTE FUNCTION ai_model_registry_declared_immutable();

-- Lifecycle backstop: `retired` is TERMINAL; the only lifecycle edge is
-- active → retired.
CREATE OR REPLACE FUNCTION ai_model_registry_retired_terminal() RETURNS trigger AS $$
BEGIN
    IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN
        RAISE EXCEPTION 'model % is retired and terminal', OLD.model_registry_id;
    END IF;
    IF OLD.status = 'active' AND NEW.status NOT IN ('active', 'retired') THEN
        RAISE EXCEPTION 'illegal model status % (the lifecycle is active → retired only)',
            NEW.status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_model_registry_retired_terminal_trigger ON ai_model_registry;
CREATE TRIGGER ai_model_registry_retired_terminal_trigger
    BEFORE UPDATE ON ai_model_registry
    FOR EACH ROW EXECUTE FUNCTION ai_model_registry_retired_terminal();

-- ---------------------------------------------------------------------------
-- ai_model_observations — append-only availability/telemetry observations.
--
-- Registry observations are HISTORY: every row is written once and can never
-- be updated or deleted (trigger). The registry row's availability_state is
-- the LATEST observation's state — derived on append by the apply-state
-- trigger below (never by a direct update path), so the current state is
-- always backed by immutable history.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_model_observations (
    observation_id          uuid        PRIMARY KEY,
    model_registry_id       uuid        NOT NULL
                            REFERENCES ai_model_registry(model_registry_id) ON DELETE CASCADE,
    -- The OBSERVED availability state (the observation's own record).
    availability_state      text        NOT NULL
                            CHECK (availability_state IN ('available', 'degraded', 'unavailable')),
    -- Observed latency distribution signals in milliseconds (NULL = not
    -- observed in this observation).
    observed_latency_p50_ms bigint      CHECK (observed_latency_p50_ms IS NULL OR observed_latency_p50_ms >= 0),
    observed_latency_p95_ms bigint      CHECK (observed_latency_p95_ms IS NULL OR observed_latency_p95_ms >= 0),
    -- Observation source label (e.g. 'platform-probe', 'usage-aggregate').
    source                  text        NOT NULL
                            CHECK (length(source) >= 1 AND length(source) <= 64),
    notes                   text        NOT NULL DEFAULT ''
                            CHECK (length(notes) <= 512),
    created_by              uuid        REFERENCES users(user_id),
    created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_model_observations_model_idx
    ON ai_model_observations (model_registry_id, created_at, observation_id);

-- Append-only backstop: observations are immutable history.
CREATE OR REPLACE FUNCTION ai_model_observations_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'model observations are append-only history (% blocked)',
        TG_OP;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_model_observations_append_only_trigger ON ai_model_observations;
CREATE TRIGGER ai_model_observations_append_only_trigger
    BEFORE UPDATE OR DELETE ON ai_model_observations
    FOR EACH ROW EXECUTE FUNCTION ai_model_observations_append_only();

-- Current-state derivation: an appended observation sets the registry row's
-- availability_state (and bumps its CAS version) — the ONLY sanctioned
-- mutation path for that column. Observations on a RETIRED entry still
-- record history but never mutate the retired row (a tombstone stays
-- untouched).
CREATE OR REPLACE FUNCTION ai_model_observations_apply_state() RETURNS trigger AS $$
BEGIN
    UPDATE ai_model_registry
       SET availability_state = NEW.availability_state,
           version = version + 1,
           updated_at = now()
     WHERE model_registry_id = NEW.model_registry_id
       AND status = 'active';
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_model_observations_apply_state_trigger ON ai_model_observations;
CREATE TRIGGER ai_model_observations_apply_state_trigger
    AFTER INSERT ON ai_model_observations
    FOR EACH ROW EXECUTE FUNCTION ai_model_observations_apply_state();

-- ---------------------------------------------------------------------------
-- ai_usage_telemetry — the append-only usage telemetry record.
--
-- The record of a routing/invocation outcome (architecture.md §24): which
-- TaskProfile (the request class link), which registry MODEL (the model
-- ref), the execution context link (reference data), the correlation
-- identity, latency, observed cost, tokens/compute where available, the
-- evaluation outcome link (a placeholder reference until the evaluation
-- framework, MKT-019) and the escalation count. The record is WRITTEN ONCE:
-- the table rejects UPDATE and DELETE (trigger) — corrections create new
-- records, never overwrites (append-oriented).
--
-- The (workspace_id, idempotency_key) §8-style fence makes the logical
-- append command converge: a duplicate of the same command (same create
-- fingerprint) replays to the existing row; a key reused for a DIFFERENT
-- command is a conflict.
--
-- The model ref is REFERENCE DATA to the registry entry (which carries the
-- provider/model labels as data); telemetry referencing retired entries or
-- profiles is still recordable — history records invocations that HAPPENED,
-- and retiring a candidate never rewrites history.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_usage_telemetry (
    usage_id           uuid         PRIMARY KEY,
    workspace_id       uuid         NOT NULL REFERENCES workspaces(workspace_id),
    client_id          uuid         NOT NULL REFERENCES clients(client_id),
    agency_id          uuid         NOT NULL REFERENCES agencies(agency_id) ON DELETE CASCADE,
    -- The TaskProfile this invocation served (the request class link).
    task_profile_id    uuid         NOT NULL REFERENCES ai_task_profiles(task_profile_id),
    -- The registry model entry this invocation used (the model ref).
    model_registry_id  uuid         NOT NULL REFERENCES ai_model_registry(model_registry_id),
    -- Execution context link — REFERENCE data (matrix direction
    -- /ai-runtime ──→ /executions): recorded verbatim, scope-checked by the
    -- trigger below. Nullable: telemetry may record invocations outside a
    -- tracked execution context.
    execution_id       uuid         REFERENCES executions(execution_id),
    -- Server-derived correlation identity (never caller-supplied).
    correlation_id     text         NOT NULL
                       CHECK (length(correlation_id) >= 1 AND length(correlation_id) <= 128),
    -- The routing/invocation outcome. `unknown` follows the frozen UNKNOWN
    -- semantics: the external outcome could not be proven — never success.
    outcome            text         NOT NULL
                       CHECK (outcome IN ('succeeded', 'failed', 'escalated', 'unknown')),
    latency_ms         bigint       NOT NULL CHECK (latency_ms >= 0),
    -- Observed cost of the invocation, normalized cost units (>= 0; 0 when
    -- unmeasured — the registry's declared signals carry the estimates).
    cost_amount        numeric(12,6) NOT NULL CHECK (cost_amount >= 0),
    -- Tokens/compute where available (NULL = not reported).
    tokens_in          bigint       CHECK (tokens_in IS NULL OR tokens_in >= 0),
    tokens_out         bigint       CHECK (tokens_out IS NULL OR tokens_out >= 0),
    -- Evaluation outcome link (opaque bounded reference; the evaluation
    -- authority is MKT-019 — recorded here as a link, never fabricated).
    evaluation_ref     text         CHECK (evaluation_ref IS NULL OR (length(evaluation_ref) >= 1 AND length(evaluation_ref) <= 512)),
    escalation_count   integer      NOT NULL DEFAULT 0 CHECK (escalation_count >= 0),
    -- §8-style logical append-command key + fingerprint (convergence proof).
    idempotency_key    text         NOT NULL
                       CHECK (length(idempotency_key) >= 1 AND length(idempotency_key) <= 200),
    create_fingerprint text         NOT NULL CHECK (length(create_fingerprint) = 64),
    created_by         uuid         REFERENCES users(user_id),
    created_at         timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT ai_usage_telemetry_key_unique UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS ai_usage_telemetry_workspace_idx
    ON ai_usage_telemetry (workspace_id, created_at, usage_id);
CREATE INDEX IF NOT EXISTS ai_usage_telemetry_execution_idx
    ON ai_usage_telemetry (execution_id) WHERE execution_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_usage_telemetry_profile_idx
    ON ai_usage_telemetry (task_profile_id, created_at);
CREATE INDEX IF NOT EXISTS ai_usage_telemetry_model_idx
    ON ai_usage_telemetry (model_registry_id, created_at);

-- Append-only backstop: usage telemetry is immutable history — UPDATE and
-- DELETE are both rejected by the database itself.
CREATE OR REPLACE FUNCTION ai_usage_telemetry_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'usage telemetry is append-only history (% blocked)',
        TG_OP;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_usage_telemetry_append_only_trigger ON ai_usage_telemetry;
CREATE TRIGGER ai_usage_telemetry_append_only_trigger
    BEFORE UPDATE OR DELETE ON ai_usage_telemetry
    FOR EACH ROW EXECUTE FUNCTION ai_usage_telemetry_append_only();

-- Scope-chain backstop (tenant isolation at the storage layer): the
-- telemetry row's Client must own its Workspace and its Agency must own that
-- Client; the referenced TaskProfile must belong to the SAME Workspace; and
-- a referenced execution must belong to the SAME Workspace (a foreign
-- execution/profile reference can never be smuggled into another tenant's
-- telemetry). Verified on INSERT (the table is append-only — there is no
-- UPDATE path).
CREATE OR REPLACE FUNCTION ai_usage_telemetry_scope_chain() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM workspaces w
        WHERE w.workspace_id = NEW.workspace_id
          AND w.client_id = NEW.client_id
    ) THEN
        RAISE EXCEPTION 'usage telemetry % workspace % does not belong to client %',
            NEW.usage_id, NEW.workspace_id, NEW.client_id;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM clients c
        WHERE c.client_id = NEW.client_id
          AND c.agency_id = NEW.agency_id
    ) THEN
        RAISE EXCEPTION 'usage telemetry % client % does not belong to agency %',
            NEW.usage_id, NEW.client_id, NEW.agency_id;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM ai_task_profiles p
        WHERE p.task_profile_id = NEW.task_profile_id
          AND p.workspace_id = NEW.workspace_id
    ) THEN
        RAISE EXCEPTION 'usage telemetry % task profile % does not belong to workspace %',
            NEW.usage_id, NEW.task_profile_id, NEW.workspace_id;
    END IF;
    IF NEW.execution_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM executions e
        WHERE e.execution_id = NEW.execution_id
          AND e.workspace_id = NEW.workspace_id
    ) THEN
        RAISE EXCEPTION 'usage telemetry % execution % does not belong to workspace %',
            NEW.usage_id, NEW.execution_id, NEW.workspace_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_usage_telemetry_scope_chain_trigger ON ai_usage_telemetry;
CREATE TRIGGER ai_usage_telemetry_scope_chain_trigger
    BEFORE INSERT ON ai_usage_telemetry
    FOR EACH ROW EXECUTE FUNCTION ai_usage_telemetry_scope_chain();
