-- 071_lab_simulator.sql — LAB-005 (Social Simulator Kernel).
--
-- THE SIMULATOR-KERNEL AUTHORITY (spec/effective-backlog-v1.7.md
-- LAB-005: "Build configurable platform state, candidate generation,
-- exposure/ranking abstraction and content interaction loop.
-- Acceptance: deterministic seeded replay plus stochastic runs; no
-- invented hidden provider state."; dependencies satisfied: LAB-001
-- + LAB-003 merged on main); spec/architecture-v1.7-marketing-lab.md
-- §8 "Social World Model" (THE frozen contract: the configurable world
-- model — content universe; user population; user preferences/
-- interests; user session state; fatigue/repetition response;
-- candidate generation; ranking/exposure; recommendation behavior;
-- creator competition; topic trends; temporal effects; freshness;
-- novelty; account state; observable platform constraints;
-- API/publishing constraints where relevant; business/product
-- conversion behavior where relevant; "The simulator targets
-- observable behavior, not reproduction of a platform's private
-- implementation. Hidden provider moderation/ranking details MUST
-- NOT be invented as factual claims.") and §9 (the interacting
-- actors; "A simulator run MUST be able to reproduce a trajectory
-- given a recorded seed/configuration, while supporting stochastic
-- ensembles for uncertainty estimation") and §13 (the ensemble
-- discipline — a single learned simulator MUST NOT be treated as
-- ground truth) and §22 multi-tenancy:
--
--   lab_simulator_world_configs         → the WORLD-MODEL
--                                        CONFIGURATION records
--                                        (versioned, immutable once
--                                        instantiated: the closed
--                                        vocabulary of world-model
--                                        knobs as DECLARED DATA under
--                                        'lab-worldmodel-v1', the
--                                        declared RNG identity +
--                                        version, the deterministic
--                                        configuration digest as the
--                                        idempotence fence, the
--                                        CHECK-fenced modeling-basis
--                                        label — the no-invented-
--                                        hidden-state discipline,
--                                        structural);
--   lab_simulator_seeds                → the SEED records (the
--                                        recorded seed +
--                                        configuration pair that
--                                        reproduces a trajectory
--                                        exactly: the master seed +
--                                        the derived-seed lineage +
--                                        the FK-anchored config
--                                        citation + the deterministic
--                                        seed digest);
--   lab_simulator_runs                 → the RUN records (born
--                                        'running' with the single
--                                        completion advance: the
--                                        seed + configuration
--                                        citation, the engine
--                                        version, the factuality
--                                        label, the deterministic-
--                                        replay flag + the recorded
--                                        reproduction proof, the
--                                        bounded step budget, the
--                                        publishing plan + the
--                                        content-universe citations,
--                                        and the SQL-COMPUTED
--                                        summary totals);
--   lab_simulator_run_steps             → the STEP/TRAJECTORY
--                                        records (the recorded
--                                        interaction-loop steps:
--                                        candidates surfaced →
--                                        exposure decisions → user
--                                        interactions with their
--                                        stochastic outcomes — every
--                                        step append-only with its
--                                        deterministic step digest);
--   lab_simulator_observable_snapshots  → the OBSERVABLE-STATE
--                                        snapshot records (what the
--                                        simulated agent could
--                                        observe at each step — the
--                                        observable/hidden split:
--                                        ONLY observable state is
--                                        exposed; hidden provider
--                                        internals are never
--                                        materialized as factual
--                                        claims);
--   lab_simulator_ensembles             → the ENSEMBLE records (the
--                                        family of runs over sampled
--                                        seeds/configurations for
--                                        uncertainty estimation —
--                                        the §13 discipline: the
--                                        agreement/disagreement
--                                        SQL-COMPUTED at the single
--                                        completion advance; an
--                                        ensemble of ONE is
--                                        structurally inexpressible);
--   lab_simulator_ensemble_members      → the append-only member
--                                        tail (the sampled member
--                                        seed + its run + its drawn
--                                        configuration citation).
--
-- House disciplines (the 059/061/063/065/066/067 precedents):
--
-- * THE CLOSED VOCABULARIES are CHECK-fenced: the pinned
--   'lab-simulator-contract-v1' / 'lab-worldmodel-v1' /
--   'lab-sim-engine-v1' / 'lab-simulator-splitmix64' /
--   'lab-sim-rng-v1' versions, the modeling basis
--   'declared_world_model_assumptions' (EVERY configuration row is
--   structurally labeled as declared modeling assumptions targeting
--   observable behavior — never a provider fact), the factuality
--   label 'simulated_model_output' (every run row), the closed
--   run/ensemble lifecycles, the closed outcome-metric vocabulary,
--   the 64-hex digest shapes, the u64 master-seed shape + numeric
--   bound, the bounded step budget / pool / plan / member counts.
-- * DETERMINISTIC IDENTITY: the configuration digest and the seed
--   digest are UNIQUE per client (the idempotence fences — the same
--   knobs are the same configuration, the same master seed +
--   configuration pair is the same seed record, ever); the per-step
--   digests + the trajectory digest chain the recorded trajectory
--   (a pure function of the recorded step rows).
-- * THE APPEND-ONLY DISCIPLINE: configurations, seeds, steps,
--   observable snapshots and ensemble members are APPEND-ONLY
--   OUTRIGHT (UPDATE and DELETE both rejected — immutable once
--   instantiated); runs and ensembles are born 'running' with
--   honestly-zero summaries and advance to 'completed' exactly once
--   under the guarded UPDATE trigger (identity/scope/citation/plan/
--   universe immutable; only the status, the SQL-computed summary
--   values and updated_at may advance), and are never deleted.
-- * TENANT ISOLATION (§22): every row is CLIENT-scoped (the optional
--   workspace anchor) with the cross-tenant scope-consistency
--   triggers fencing the module's own row references at the DB (the
--   seed→config, run→seed/config/replay-target, step→run,
--   snapshot→run, member→ensemble/run pairs).
-- * THE OPAQUE CITATIONS (the /lab family by-reference discipline):
--   the content-universe citations (the /lab-features bundle
--   references + the /lab-ideas node references) and their declared
--   simulation attributes are RECORDED DATA — there is NO FK into
--   any /lab, /lab-features, /lab-ideas or v1.6 authority table (the
--   FK anchors are EXACTLY the tenant tables + same-module rows).
-- * NO binary column, NO authority table, NO /lab-features or
--   /lab-ideas or /lab table is created or written here.

-- ---------------------------------------------------------------------------
-- lab_simulator_world_configs — the versioned, immutable world-model
-- configurations (the closed vocabulary of declared knobs)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_simulator_world_configs (
    config_id           uuid        NOT NULL,
    -- The append-only chain position: a changed knob set is a NEW
    -- (config_id, config_version) row, never an in-place rewrite.
    config_version      integer     NOT NULL CHECK (config_version >= 1 AND config_version <= 1000),
    world_model_version text        NOT NULL
                        CHECK (world_model_version = 'lab-worldmodel-v1'),
    -- THE DECLARED SEEDED GENERATOR (identity + version recorded on
    -- the configuration — the RNG is part of the reproducibility
    -- contract).
    rng_id              text        NOT NULL
                        CHECK (rng_id = 'lab-simulator-splitmix64'),
    rng_version         text        NOT NULL
                        CHECK (rng_version = 'lab-sim-rng-v1'),
    -- THE DECLARED KNOBS (the closed vocabulary — DECLARED DATA under
    -- the world-model version, never ambient globals).
    knobs               jsonb       NOT NULL
                        CHECK (jsonb_typeof(knobs) = 'object'),
    -- The deterministic configuration digest (SHA-256 over the
    -- canonical JSON of the knob set + the pinned versions).
    config_digest       text        NOT NULL CHECK (config_digest ~ '^[0-9a-f]{64}$'),
    -- THE MODELING BASIS (the no-invented-hidden-state discipline,
    -- structural): the knobs are explicit declared modeling
    -- assumptions targeting observable behavior — never claims about
    -- any provider's actual algorithm or hidden moderation/ranking
    -- internals.
    modeling_basis      text        NOT NULL
                        CHECK (modeling_basis = 'declared_world_model_assumptions'),
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id        uuid        REFERENCES workspaces(workspace_id),
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'lab-simulator-contract-v1'),
    created_at          timestamptz NOT NULL,
    CONSTRAINT lab_simulator_world_configs_pkey PRIMARY KEY (config_id, config_version),
    -- The deterministic identity idempotence fence (the same knobs +
    -- pinned versions are the same configuration, ever, per client).
    CONSTRAINT lab_simulator_world_configs_identity UNIQUE (client_id, config_digest)
);

-- The client's configuration chains (the latest version of each chain).
CREATE INDEX IF NOT EXISTS lab_simulator_world_configs_client_idx
    ON lab_simulator_world_configs (client_id, created_at DESC, config_id);
-- The per-chain version read (the version resolution).
CREATE INDEX IF NOT EXISTS lab_simulator_world_configs_chain_idx
    ON lab_simulator_world_configs (config_id, config_version DESC);

-- Configurations are APPEND-ONLY OUTRIGHT (immutable once
-- instantiated): no UPDATE, no DELETE (a changed knob set is a NEW
-- version row).
CREATE OR REPLACE FUNCTION lab_simulator_world_configs_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab simulator world configurations are append-only (INSERT only — configuration % v% is immutable once instantiated; a changed knob set is a new version)',
        NEW.config_id, NEW.config_version;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_simulator_world_configs_no_update_trigger ON lab_simulator_world_configs;
CREATE TRIGGER lab_simulator_world_configs_no_update_trigger
    BEFORE UPDATE ON lab_simulator_world_configs
    FOR EACH ROW EXECUTE FUNCTION lab_simulator_world_configs_append_only();

DROP TRIGGER IF EXISTS lab_simulator_world_configs_no_delete_trigger ON lab_simulator_world_configs;
CREATE TRIGGER lab_simulator_world_configs_no_delete_trigger
    BEFORE DELETE ON lab_simulator_world_configs
    FOR EACH ROW EXECUTE FUNCTION lab_simulator_world_configs_append_only();

-- ---------------------------------------------------------------------------
-- lab_simulator_seeds — the recorded seed + configuration pairs (the
-- reproducibility units)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_simulator_seeds (
    seed_id             uuid        PRIMARY KEY,
    -- The master seed: the decimal string of an unsigned 64-bit
    -- integer [0, 2^64).
    master_seed         text        NOT NULL
                        CHECK (master_seed ~ '^(0|[1-9][0-9]{0,19})$'
                               AND master_seed::numeric >= 0
                               AND master_seed::numeric < 18446744073709551616),
    -- The derived-seed lineage (the per-subsystem RNG streams with
    -- their derivation labels — the complete reproducibility input).
    derived             jsonb       NOT NULL
                        CHECK (jsonb_typeof(derived) = 'array'),
    -- The cited configuration (the seed's pair — the FK-anchored
    -- same-module citation, composite with the chain position).
    config_id           uuid        NOT NULL,
    config_version      integer     NOT NULL CHECK (config_version >= 1),
    -- The cited configuration's digest echo (the recorded linkage data).
    config_digest       text        NOT NULL CHECK (config_digest ~ '^[0-9a-f]{64}$'),
    -- The deterministic seed digest (SHA-256 over the canonical JSON
    -- of masterSeed + configDigest).
    seed_digest         text        NOT NULL CHECK (seed_digest ~ '^[0-9a-f]{64}$'),
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id        uuid        REFERENCES workspaces(workspace_id),
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'lab-simulator-contract-v1'),
    created_at          timestamptz NOT NULL,
    CONSTRAINT lab_simulator_seeds_config_fk
        FOREIGN KEY (config_id, config_version)
        REFERENCES lab_simulator_world_configs (config_id, config_version),
    -- The deterministic identity idempotence fence (the same master
    -- seed + configuration pair is the same seed record, ever, per
    -- client).
    CONSTRAINT lab_simulator_seeds_identity UNIQUE (client_id, seed_digest)
);

-- The client's seed tail.
CREATE INDEX IF NOT EXISTS lab_simulator_seeds_client_idx
    ON lab_simulator_seeds (client_id, created_at DESC, seed_id);
-- The configuration citation facet.
CREATE INDEX IF NOT EXISTS lab_simulator_seeds_config_idx
    ON lab_simulator_seeds (config_id, config_version);

-- Seeds are APPEND-ONLY OUTRIGHT: no UPDATE, no DELETE.
CREATE OR REPLACE FUNCTION lab_simulator_seeds_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab simulator seeds are append-only (INSERT only — seed % is immutable; the recorded seed + configuration pair is the reproducibility unit)',
        NEW.seed_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_simulator_seeds_no_update_trigger ON lab_simulator_seeds;
CREATE TRIGGER lab_simulator_seeds_no_update_trigger
    BEFORE UPDATE ON lab_simulator_seeds
    FOR EACH ROW EXECUTE FUNCTION lab_simulator_seeds_append_only();

DROP TRIGGER IF EXISTS lab_simulator_seeds_no_delete_trigger ON lab_simulator_seeds;
CREATE TRIGGER lab_simulator_seeds_no_delete_trigger
    BEFORE DELETE ON lab_simulator_seeds
    FOR EACH ROW EXECUTE FUNCTION lab_simulator_seeds_append_only();

-- Scope consistency: the seed's client must match its cited
-- configuration's client (cross-tenant seed injection is rejected at
-- the DB — §22).
CREATE OR REPLACE FUNCTION lab_simulator_seed_scope_check() RETURNS trigger AS $$
DECLARE
    config_client uuid;
    config_digest_recorded text;
BEGIN
    SELECT client_id, config_digest INTO config_client, config_digest_recorded
        FROM lab_simulator_world_configs
        WHERE config_id = NEW.config_id AND config_version = NEW.config_version;
    IF config_client IS NULL THEN
        RAISE EXCEPTION 'lab simulator seed must bind an existing configuration (% v%)',
            NEW.config_id, NEW.config_version;
    END IF;
    IF config_client <> NEW.client_id THEN
        RAISE EXCEPTION 'lab simulator seed client must match its configuration client (cross-tenant seed injection is rejected)';
    END IF;
    IF config_digest_recorded <> NEW.config_digest THEN
        RAISE EXCEPTION 'lab simulator seed config digest echo must match the cited configuration digest';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_simulator_seed_scope_trigger ON lab_simulator_seeds;
CREATE TRIGGER lab_simulator_seed_scope_trigger
    BEFORE INSERT ON lab_simulator_seeds
    FOR EACH ROW EXECUTE FUNCTION lab_simulator_seed_scope_check();

-- ---------------------------------------------------------------------------
-- lab_simulator_runs — the simulator run records (born running; the
-- single completion advance)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_simulator_runs (
    run_id              uuid        PRIMARY KEY,
    -- Born running; the single guarded advance to completed (the
    -- completion update SQL-computes the summary from the step rows
    -- in the same transaction).
    status              text        NOT NULL
                        CHECK (status IN ('running', 'completed')),
    seed_id             uuid        NOT NULL REFERENCES lab_simulator_seeds(seed_id),
    -- The configuration citation (FK-anchored same-module; must equal
    -- the seed's configuration — the trigger fence below).
    config_id           uuid        NOT NULL,
    config_version      integer     NOT NULL CHECK (config_version >= 1),
    config_digest       text        NOT NULL CHECK (config_digest ~ '^[0-9a-f]{64}$'),
    -- The engine version that produced the trajectory (the replay
    -- cross-check: an engine change is a NEW version, and replays of
    -- old runs honestly fail the digest comparison).
    engine_version      text        NOT NULL
                        CHECK (engine_version = 'lab-sim-engine-v1'),
    -- THE FACTUALITY LABEL (the LAB-001 vocabulary, BY DATA): a
    -- simulated outcome is a model output and is labeled as such on
    -- every read surface — it can never be presented as an observed
    -- fact.
    factuality          text        NOT NULL
                        CHECK (factuality = 'simulated_model_output'),
    -- THE DETERMINISTIC-REPLAY FLAG: a replay cites the original
    -- run's seed + configuration and MUST reproduce its trajectory
    -- step-for-step (the module verifies every step digest BEFORE
    -- any row exists; the recorded proof ships on the row).
    deterministic_replay boolean    NOT NULL,
    replay_of_run_id    uuid        REFERENCES lab_simulator_runs(run_id),
    replay_verified     boolean,
    -- The bounded interaction-loop budget.
    step_budget         integer     NOT NULL CHECK (step_budget >= 1 AND step_budget <= 1000),
    -- The caller-declared publishing plan (part of the
    -- reproducibility input; validated against the declared
    -- API/publishing constraints before anything is simulated).
    publishing_plan     jsonb       NOT NULL
                        CHECK (jsonb_typeof(publishing_plan) = 'array'),
    -- The opaque content-universe citations (part of the
    -- reproducibility input — recorded data, never a join).
    content_universe    jsonb       NOT NULL
                        CHECK (jsonb_typeof(content_universe) = 'array'),
    -- THE SQL-COMPUTED SUMMARY (at the single completion advance;
    -- honestly zero while running — never asserted separately).
    step_count          integer     NOT NULL DEFAULT 0 CHECK (step_count >= 0),
    total_impressions   integer     NOT NULL DEFAULT 0 CHECK (total_impressions >= 0),
    total_views         integer     NOT NULL DEFAULT 0 CHECK (total_views >= 0),
    total_engagements   integer     NOT NULL DEFAULT 0 CHECK (total_engagements >= 0),
    total_shares        integer     NOT NULL DEFAULT 0 CHECK (total_shares >= 0),
    total_clicks        integer     NOT NULL DEFAULT 0 CHECK (total_clicks >= 0),
    total_conversions   integer     NOT NULL DEFAULT 0 CHECK (total_conversions >= 0),
    total_revenue       numeric(20,4) NOT NULL DEFAULT 0 CHECK (total_revenue >= 0),
    total_followers_gained integer  NOT NULL DEFAULT 0 CHECK (total_followers_gained >= 0),
    -- The trajectory digest (SHA-256 over the ordered step-digest
    -- chain — recorded at completion).
    trajectory_digest   text        CHECK (trajectory_digest IS NULL OR trajectory_digest ~ '^[0-9a-f]{64}$'),
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id        uuid        REFERENCES workspaces(workspace_id),
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'lab-simulator-contract-v1'),
    created_at          timestamptz NOT NULL,
    updated_at          timestamptz NOT NULL,
    CONSTRAINT lab_simulator_runs_config_fk
        FOREIGN KEY (config_id, config_version)
        REFERENCES lab_simulator_world_configs (config_id, config_version),
    -- THE REPLAY FENCES: a normal run carries no replay columns; a
    -- replay carries the original + the recorded proof (the step
    -- digests matched step-for-step — no unverified replay row is
    -- expressible). The IS TRUE / NOT-deterministic_replay forms keep
    -- the fence NULL-SAFE (a bare = comparison passes a CHECK on
    -- NULL — the fence must reject, never shrug).
    CONSTRAINT lab_simulator_runs_replay_fence
        CHECK ( (NOT deterministic_replay AND replay_of_run_id IS NULL AND replay_verified IS NULL)
             OR (deterministic_replay AND replay_of_run_id IS NOT NULL AND replay_verified IS TRUE) ),
    -- The status-conditional summary fence: a run is born 'running'
    -- with an honestly-zero summary (nothing is computed yet); the
    -- single completion update computes the summary from the step
    -- rows, so at 'completed' the step count is pinned to the
    -- declared budget and the trajectory digest is present.
    CONSTRAINT lab_simulator_runs_summary_status
        CHECK ( (status = 'running'
                 AND step_count = 0 AND total_impressions = 0 AND total_views = 0
                 AND total_engagements = 0 AND total_shares = 0 AND total_clicks = 0
                 AND total_conversions = 0 AND total_revenue = 0 AND total_followers_gained = 0
                 AND trajectory_digest IS NULL)
             OR (status = 'completed'
                 AND step_count = step_budget AND trajectory_digest IS NOT NULL) )
);

-- The client's run tail.
CREATE INDEX IF NOT EXISTS lab_simulator_runs_client_idx
    ON lab_simulator_runs (client_id, created_at DESC, run_id);
-- The seed citation facet.
CREATE INDEX IF NOT EXISTS lab_simulator_runs_seed_idx
    ON lab_simulator_runs (seed_id);
-- The replay-target facet (the original's replay tail).
CREATE INDEX IF NOT EXISTS lab_simulator_runs_replay_of_idx
    ON lab_simulator_runs (replay_of_run_id);

-- Run identity is immutable after insert; ONLY the status, the nine
-- SQL-computed summary values, the trajectory digest and updated_at
-- may advance (the single completion transition — running →
-- completed, no resurrection, no reopen).
CREATE OR REPLACE FUNCTION lab_simulator_run_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.run_id <> OLD.run_id
       OR NEW.seed_id <> OLD.seed_id
       OR NEW.config_id <> OLD.config_id
       OR NEW.config_version <> OLD.config_version
       OR NEW.config_digest <> OLD.config_digest
       OR NEW.engine_version <> OLD.engine_version
       OR NEW.factuality <> OLD.factuality
       OR NEW.deterministic_replay <> OLD.deterministic_replay
       OR NEW.replay_of_run_id IS DISTINCT FROM OLD.replay_of_run_id
       OR NEW.replay_verified IS DISTINCT FROM OLD.replay_verified
       OR NEW.step_budget <> OLD.step_budget
       OR NEW.publishing_plan IS DISTINCT FROM OLD.publishing_plan
       OR NEW.content_universe IS DISTINCT FROM OLD.content_universe
       OR NEW.agency_id <> OLD.agency_id
       OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.contract_version <> OLD.contract_version
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'lab simulator run % identity/scope/citation is immutable — run history is append-only',
            OLD.run_id;
    END IF;
    IF NOT (
           (OLD.status = 'running' AND NEW.status = 'completed')
        OR (OLD.status = NEW.status)
    ) THEN
        RAISE EXCEPTION 'lab simulator run transition % → % is not legal (running → completed; no reopen)',
            OLD.status, NEW.status;
    END IF;
    IF NOT (
           (OLD.status = 'running' AND NEW.status = 'completed')
        OR (NEW.step_count = OLD.step_count
            AND NEW.total_impressions = OLD.total_impressions
            AND NEW.total_views = OLD.total_views
            AND NEW.total_engagements = OLD.total_engagements
            AND NEW.total_shares = OLD.total_shares
            AND NEW.total_clicks = OLD.total_clicks
            AND NEW.total_conversions = OLD.total_conversions
            AND NEW.total_revenue = OLD.total_revenue
            AND NEW.total_followers_gained = OLD.total_followers_gained
            AND NEW.trajectory_digest IS NOT DISTINCT FROM OLD.trajectory_digest)
    ) THEN
        RAISE EXCEPTION 'lab simulator run % summary may only change at the single completion advance',
            OLD.run_id;
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'lab simulator run % updated_at may not go backwards',
            OLD.run_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_simulator_run_guard_trigger ON lab_simulator_runs;
CREATE TRIGGER lab_simulator_run_guard_trigger
    BEFORE UPDATE ON lab_simulator_runs
    FOR EACH ROW EXECUTE FUNCTION lab_simulator_run_guard();

-- Runs are never deleted (the run history is append-only).
CREATE OR REPLACE FUNCTION lab_simulator_runs_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab simulator runs cannot be deleted — run history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_simulator_runs_no_delete_trigger ON lab_simulator_runs;
CREATE TRIGGER lab_simulator_runs_no_delete_trigger
    BEFORE DELETE ON lab_simulator_runs
    FOR EACH ROW EXECUTE FUNCTION lab_simulator_runs_no_delete();

-- Scope consistency: the run's client must match its seed's client
-- AND its configuration's client, its config digest echo must match
-- the configuration, its seed citation must pair the SAME
-- configuration, and (for replays) the cited original must be a
-- COMPLETED run of the SAME seed under the SAME client (cross-tenant
-- run injection is rejected at the DB — §22).
CREATE OR REPLACE FUNCTION lab_simulator_run_scope_check() RETURNS trigger AS $$
DECLARE
    seed_client uuid;
    seed_config_id uuid;
    seed_config_version integer;
    config_client uuid;
    config_digest_recorded text;
    replay_client uuid;
    replay_status text;
    replay_seed uuid;
BEGIN
    SELECT client_id, config_id, config_version INTO seed_client, seed_config_id, seed_config_version
        FROM lab_simulator_seeds WHERE seed_id = NEW.seed_id;
    IF seed_client IS NULL THEN
        RAISE EXCEPTION 'lab simulator run must bind an existing seed (%)',
            NEW.seed_id;
    END IF;
    IF seed_client <> NEW.client_id THEN
        RAISE EXCEPTION 'lab simulator run client must match its seed client (cross-tenant run injection is rejected)';
    END IF;
    IF seed_config_id <> NEW.config_id OR seed_config_version <> NEW.config_version THEN
        RAISE EXCEPTION 'lab simulator run must cite the SAME configuration as its seed (the seed + configuration pair is the reproducibility unit)';
    END IF;
    SELECT client_id, config_digest INTO config_client, config_digest_recorded
        FROM lab_simulator_world_configs
        WHERE config_id = NEW.config_id AND config_version = NEW.config_version;
    IF config_client IS NULL THEN
        RAISE EXCEPTION 'lab simulator run must bind an existing configuration (% v%)',
            NEW.config_id, NEW.config_version;
    END IF;
    IF config_client <> NEW.client_id THEN
        RAISE EXCEPTION 'lab simulator run client must match its configuration client (cross-tenant run injection is rejected)';
    END IF;
    IF config_digest_recorded <> NEW.config_digest THEN
        RAISE EXCEPTION 'lab simulator run config digest echo must match the cited configuration digest';
    END IF;
    IF NEW.replay_of_run_id IS NOT NULL THEN
        SELECT client_id, status, seed_id INTO replay_client, replay_status, replay_seed
            FROM lab_simulator_runs WHERE run_id = NEW.replay_of_run_id;
        IF replay_client IS NULL THEN
            RAISE EXCEPTION 'lab simulator replay run must cite an existing original run (%)',
                NEW.replay_of_run_id;
        END IF;
        IF replay_client <> NEW.client_id THEN
            RAISE EXCEPTION 'lab simulator replay run client must match its original run client (cross-tenant replay injection is rejected)';
        END IF;
        IF replay_status <> 'completed' THEN
            RAISE EXCEPTION 'lab simulator replay run must cite a COMPLETED original run (the trajectory to reproduce exists)';
        END IF;
        IF replay_seed <> NEW.seed_id THEN
            RAISE EXCEPTION 'lab simulator replay run must cite the original run''s SAME seed (deterministic seeded replay)';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_simulator_run_scope_trigger ON lab_simulator_runs;
CREATE TRIGGER lab_simulator_run_scope_trigger
    BEFORE INSERT ON lab_simulator_runs
    FOR EACH ROW EXECUTE FUNCTION lab_simulator_run_scope_check();

-- ---------------------------------------------------------------------------
-- lab_simulator_run_steps — the STEP/TRAJECTORY records (the
-- recorded interaction-loop steps — append-only outright)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_simulator_run_steps (
    step_id             uuid        PRIMARY KEY,
    run_id              uuid        NOT NULL REFERENCES lab_simulator_runs(run_id),
    -- The 1-based step position (the append-only trajectory order).
    seq                 integer     NOT NULL CHECK (seq >= 1),
    -- The candidate-generation phase (the candidates surfaced).
    candidates          jsonb       NOT NULL CHECK (jsonb_typeof(candidates) = 'array'),
    -- The exposure/ranking phase (the declared curve applied — every
    -- decision carries the declared-modeling-assumption label).
    exposure            jsonb       NOT NULL CHECK (jsonb_typeof(exposure) = 'array'),
    -- The user-interaction phase (the stochastic outcomes per
    -- segment — the stateful response record).
    interactions        jsonb       NOT NULL CHECK (jsonb_typeof(interactions) = 'array'),
    -- The creator-competition phase (this step's competitor posts).
    competitor_posts    jsonb       NOT NULL CHECK (jsonb_typeof(competitor_posts) = 'array'),
    -- The topic-trend state after the step (simulation internals —
    -- the audit trail only, never the observable surface).
    topic_trends        jsonb       NOT NULL CHECK (jsonb_typeof(topic_trends) = 'object'),
    -- The flat observable outcome metrics (the run's SQL-computed
    -- summary reads exactly these).
    impressions         integer     NOT NULL CHECK (impressions >= 0),
    views               integer     NOT NULL CHECK (views >= 0),
    engagements         integer     NOT NULL CHECK (engagements >= 0),
    shares              integer     NOT NULL CHECK (shares >= 0),
    clicks              integer     NOT NULL CHECK (clicks >= 0),
    conversions         integer     NOT NULL CHECK (conversions >= 0),
    revenue             numeric(20,4) NOT NULL DEFAULT 0 CHECK (revenue >= 0),
    followers_gained    integer     NOT NULL CHECK (followers_gained >= 0),
    competitor_post_count integer    NOT NULL CHECK (competitor_post_count >= 0),
    -- The deterministic step digest (SHA-256 over the canonical step
    -- content — the trajectory chain link).
    step_digest         text        NOT NULL CHECK (step_digest ~ '^[0-9a-f]{64}$'),
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id        uuid        REFERENCES workspaces(workspace_id),
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'lab-simulator-contract-v1'),
    created_at          timestamptz NOT NULL,
    -- One step per (run, position) — the append-only trajectory order.
    CONSTRAINT lab_simulator_run_steps_seq UNIQUE (run_id, seq)
);

-- The run's step tail (ascending — the trajectory read).
CREATE INDEX IF NOT EXISTS lab_simulator_run_steps_run_idx
    ON lab_simulator_run_steps (run_id, seq, step_id);

-- Steps are APPEND-ONLY OUTRIGHT: no UPDATE, no DELETE (a step is an
-- immutable record of one interaction-loop iteration).
CREATE OR REPLACE FUNCTION lab_simulator_run_steps_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab simulator run steps are append-only (INSERT only — step % of run % is immutable)',
        NEW.seq, NEW.run_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_simulator_run_steps_no_update_trigger ON lab_simulator_run_steps;
CREATE TRIGGER lab_simulator_run_steps_no_update_trigger
    BEFORE UPDATE ON lab_simulator_run_steps
    FOR EACH ROW EXECUTE FUNCTION lab_simulator_run_steps_append_only();

DROP TRIGGER IF EXISTS lab_simulator_run_steps_no_delete_trigger ON lab_simulator_run_steps;
CREATE TRIGGER lab_simulator_run_steps_no_delete_trigger
    BEFORE DELETE ON lab_simulator_run_steps
    FOR EACH ROW EXECUTE FUNCTION lab_simulator_run_steps_append_only();

-- Scope consistency: a step's client must match its run's client
-- (cross-tenant step injection is rejected at the DB — §22).
CREATE OR REPLACE FUNCTION lab_simulator_run_step_scope_check() RETURNS trigger AS $$
DECLARE
    run_client uuid;
BEGIN
    SELECT client_id INTO run_client FROM lab_simulator_runs WHERE run_id = NEW.run_id;
    IF run_client IS NULL THEN
        RAISE EXCEPTION 'lab simulator run step must bind an existing run (%)',
            NEW.run_id;
    END IF;
    IF run_client <> NEW.client_id THEN
        RAISE EXCEPTION 'lab simulator run step client must match its run client (cross-tenant step injection is rejected)';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_simulator_run_step_scope_trigger ON lab_simulator_run_steps;
CREATE TRIGGER lab_simulator_run_step_scope_trigger
    BEFORE INSERT ON lab_simulator_run_steps
    FOR EACH ROW EXECUTE FUNCTION lab_simulator_run_step_scope_check();

-- ---------------------------------------------------------------------------
-- lab_simulator_observable_snapshots — the OBSERVABLE-STATE snapshot
-- records (the observable/hidden split — append-only outright)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_simulator_observable_snapshots (
    snapshot_id         uuid        PRIMARY KEY,
    run_id              uuid        NOT NULL REFERENCES lab_simulator_runs(run_id),
    -- The step position (one snapshot per step).
    seq                 integer     NOT NULL CHECK (seq >= 1),
    -- THE OBSERVABLE STATE: ONLY the surfaces the platform would
    -- show (the exposure outcomes, the interaction counts, the
    -- account-state effects) + the factuality label. Hidden provider
    -- internals are NEVER materialized here — the world model's own
    -- internals (fatigue/trends/ranking scores) never enter the
    -- agent-facing projection.
    observable_state    jsonb       NOT NULL CHECK (jsonb_typeof(observable_state) = 'object'),
    -- The deterministic observable digest (the agent-facing
    -- trajectory identity — the replay comparison's second chain).
    observable_digest   text        NOT NULL CHECK (observable_digest ~ '^[0-9a-f]{64}$'),
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id        uuid        REFERENCES workspaces(workspace_id),
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'lab-simulator-contract-v1'),
    created_at          timestamptz NOT NULL,
    -- One snapshot per (run, position).
    CONSTRAINT lab_simulator_observable_snapshots_seq UNIQUE (run_id, seq)
);

-- The run's snapshot tail (ascending — the agent-facing read).
CREATE INDEX IF NOT EXISTS lab_simulator_observable_snapshots_run_idx
    ON lab_simulator_observable_snapshots (run_id, seq, snapshot_id);

-- Observable snapshots are APPEND-ONLY OUTRIGHT: no UPDATE, no
-- DELETE (the observable trajectory is never rewritten).
CREATE OR REPLACE FUNCTION lab_simulator_observable_snapshots_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab simulator observable snapshots are append-only (INSERT only — snapshot % of run % is immutable)',
        NEW.seq, NEW.run_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_simulator_observable_snapshots_no_update_trigger ON lab_simulator_observable_snapshots;
CREATE TRIGGER lab_simulator_observable_snapshots_no_update_trigger
    BEFORE UPDATE ON lab_simulator_observable_snapshots
    FOR EACH ROW EXECUTE FUNCTION lab_simulator_observable_snapshots_append_only();

DROP TRIGGER IF EXISTS lab_simulator_observable_snapshots_no_delete_trigger ON lab_simulator_observable_snapshots;
CREATE TRIGGER lab_simulator_observable_snapshots_no_delete_trigger
    BEFORE DELETE ON lab_simulator_observable_snapshots
    FOR EACH ROW EXECUTE FUNCTION lab_simulator_observable_snapshots_append_only();

-- Scope consistency: a snapshot's client must match its run's client
-- (cross-tenant snapshot injection is rejected at the DB — §22).
CREATE OR REPLACE FUNCTION lab_simulator_observable_snapshot_scope_check() RETURNS trigger AS $$
DECLARE
    run_client uuid;
BEGIN
    SELECT client_id INTO run_client FROM lab_simulator_runs WHERE run_id = NEW.run_id;
    IF run_client IS NULL THEN
        RAISE EXCEPTION 'lab simulator observable snapshot must bind an existing run (%)',
            NEW.run_id;
    END IF;
    IF run_client <> NEW.client_id THEN
        RAISE EXCEPTION 'lab simulator observable snapshot client must match its run client (cross-tenant snapshot injection is rejected)';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_simulator_observable_snapshot_scope_trigger ON lab_simulator_observable_snapshots;
CREATE TRIGGER lab_simulator_observable_snapshot_scope_trigger
    BEFORE INSERT ON lab_simulator_observable_snapshots
    FOR EACH ROW EXECUTE FUNCTION lab_simulator_observable_snapshot_scope_check();

-- ---------------------------------------------------------------------------
-- lab_simulator_ensembles — the ENSEMBLE records (a family of runs
-- over sampled seeds/configurations for uncertainty estimation — §13)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_simulator_ensembles (
    ensemble_id         uuid        PRIMARY KEY,
    -- Born running; the single guarded advance to completed (the
    -- completion update SQL-computes the uncertainty summary from
    -- the member runs in the same transaction).
    status              text        NOT NULL
                        CHECK (status IN ('running', 'completed')),
    -- THE §13 FENCE: an ensemble of ONE is structurally
    -- inexpressible (a single run is never ground truth).
    member_count        integer     NOT NULL
                        CHECK (member_count >= 2 AND member_count <= 32),
    -- The ensemble's own seed (the member seeds derive
    -- deterministically from it — the recorded sampling basis).
    ensemble_seed       text        NOT NULL
                        CHECK (ensemble_seed ~ '^(0|[1-9][0-9]{0,19})$'
                               AND ensemble_seed::numeric >= 0
                               AND ensemble_seed::numeric < 18446744073709551616),
    -- The declared outcome metric the agreement is measured over
    -- (the closed §12 reward-input vocabulary).
    outcome_metric      text        NOT NULL
                        CHECK (outcome_metric IN ('impressions', 'views', 'engagements',
                                                   'shares', 'clicks', 'conversions',
                                                   'followers_gained')),
    -- The declared configuration space the members sample over
    -- (recorded data — the member rows carry the FK-anchored
    -- citations).
    config_citations    jsonb       NOT NULL
                        CHECK (jsonb_typeof(config_citations) = 'array'),
    -- THE SQL-COMPUTED UNCERTAINTY SUMMARY (at the single completion
    -- advance; honestly zero while running).
    mean_outcome        numeric(20,4) NOT NULL DEFAULT 0 CHECK (mean_outcome >= 0),
    min_outcome         numeric(20,4) NOT NULL DEFAULT 0 CHECK (min_outcome >= 0),
    max_outcome         numeric(20,4) NOT NULL DEFAULT 0 CHECK (max_outcome >= 0),
    -- The agreement fraction (the majority side of the mean — the
    -- §13 agreement/disagreement record).
    agreement_fraction  numeric(5,4) NOT NULL DEFAULT 0
                        CHECK (agreement_fraction >= 0 AND agreement_fraction <= 1),
    disagreement_fraction numeric(5,4) NOT NULL DEFAULT 0
                        CHECK (disagreement_fraction >= 0 AND disagreement_fraction <= 1),
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id        uuid        REFERENCES workspaces(workspace_id),
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'lab-simulator-contract-v1'),
    created_at          timestamptz NOT NULL,
    updated_at          timestamptz NOT NULL,
    -- The status-conditional summary fence.
    CONSTRAINT lab_simulator_ensembles_summary_status
        CHECK ( (status = 'running'
                 AND mean_outcome = 0 AND min_outcome = 0 AND max_outcome = 0
                 AND agreement_fraction = 0 AND disagreement_fraction = 0)
             OR (status = 'completed'
                 AND min_outcome <= mean_outcome
                 AND mean_outcome <= max_outcome) )
);

-- The client's ensemble tail.
CREATE INDEX IF NOT EXISTS lab_simulator_ensembles_client_idx
    ON lab_simulator_ensembles (client_id, created_at DESC, ensemble_id);

-- Ensemble identity is immutable after insert; ONLY the status, the
-- five SQL-computed uncertainty values and updated_at may advance
-- (the single completion transition — running → completed, no
-- resurrection, no reopen).
CREATE OR REPLACE FUNCTION lab_simulator_ensemble_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.ensemble_id <> OLD.ensemble_id
       OR NEW.member_count <> OLD.member_count
       OR NEW.ensemble_seed <> OLD.ensemble_seed
       OR NEW.outcome_metric <> OLD.outcome_metric
       OR NEW.config_citations IS DISTINCT FROM OLD.config_citations
       OR NEW.agency_id <> OLD.agency_id
       OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.contract_version <> OLD.contract_version
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'lab simulator ensemble % identity/scope is immutable — ensemble history is append-only',
            OLD.ensemble_id;
    END IF;
    IF NOT (
           (OLD.status = 'running' AND NEW.status = 'completed')
        OR (OLD.status = NEW.status)
    ) THEN
        RAISE EXCEPTION 'lab simulator ensemble transition % → % is not legal (running → completed; no reopen)',
            OLD.status, NEW.status;
    END IF;
    IF NOT (
           (OLD.status = 'running' AND NEW.status = 'completed')
        OR (NEW.mean_outcome = OLD.mean_outcome
            AND NEW.min_outcome = OLD.min_outcome
            AND NEW.max_outcome = OLD.max_outcome
            AND NEW.agreement_fraction = OLD.agreement_fraction
            AND NEW.disagreement_fraction = OLD.disagreement_fraction)
    ) THEN
        RAISE EXCEPTION 'lab simulator ensemble % summary may only change at the single completion advance',
            OLD.ensemble_id;
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'lab simulator ensemble % updated_at may not go backwards',
            OLD.ensemble_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_simulator_ensemble_guard_trigger ON lab_simulator_ensembles;
CREATE TRIGGER lab_simulator_ensemble_guard_trigger
    BEFORE UPDATE ON lab_simulator_ensembles
    FOR EACH ROW EXECUTE FUNCTION lab_simulator_ensemble_guard();

-- Ensembles are never deleted.
CREATE OR REPLACE FUNCTION lab_simulator_ensembles_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab simulator ensembles cannot be deleted — ensemble history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_simulator_ensembles_no_delete_trigger ON lab_simulator_ensembles;
CREATE TRIGGER lab_simulator_ensembles_no_delete_trigger
    BEFORE DELETE ON lab_simulator_ensembles
    FOR EACH ROW EXECUTE FUNCTION lab_simulator_ensembles_no_delete();

-- ---------------------------------------------------------------------------
-- lab_simulator_ensemble_members — the append-only member tail (the
-- sampled member seed + its run + its drawn configuration citation)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_simulator_ensemble_members (
    member_id           uuid        PRIMARY KEY,
    ensemble_id         uuid        NOT NULL REFERENCES lab_simulator_ensembles(ensemble_id),
    -- The member's run (the FK-anchored same-module reference to the
    -- completed member run).
    run_id              uuid        NOT NULL REFERENCES lab_simulator_runs(run_id),
    -- The 1-based member position (the deterministic sampling order).
    seq                 integer     NOT NULL CHECK (seq >= 1),
    -- The member's sampled NEW seed (derived deterministically from
    -- the ensemble seed — a NEW seed, never the original run's).
    member_seed         text        NOT NULL
                        CHECK (member_seed ~ '^(0|[1-9][0-9]{0,19})$'
                               AND member_seed::numeric >= 0
                               AND member_seed::numeric < 18446744073709551616),
    -- The member's drawn configuration citation (from the ensemble's
    -- declared configuration space).
    config_id           uuid        NOT NULL,
    config_version      integer     NOT NULL CHECK (config_version >= 1),
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id        uuid        REFERENCES workspaces(workspace_id),
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'lab-simulator-contract-v1'),
    created_at          timestamptz NOT NULL,
    -- One member per (ensemble, position); one run per ensemble (no
    -- duplicate member runs).
    CONSTRAINT lab_simulator_ensemble_members_seq UNIQUE (ensemble_id, seq),
    CONSTRAINT lab_simulator_ensemble_members_run UNIQUE (ensemble_id, run_id),
    CONSTRAINT lab_simulator_ensemble_members_config_fk
        FOREIGN KEY (config_id, config_version)
        REFERENCES lab_simulator_world_configs (config_id, config_version)
);

-- The ensemble's member tail (ascending).
CREATE INDEX IF NOT EXISTS lab_simulator_ensemble_members_ensemble_idx
    ON lab_simulator_ensemble_members (ensemble_id, seq, member_id);
-- The run facet.
CREATE INDEX IF NOT EXISTS lab_simulator_ensemble_members_run_idx
    ON lab_simulator_ensemble_members (run_id);

-- Ensemble members are APPEND-ONLY OUTRIGHT: no UPDATE, no DELETE.
CREATE OR REPLACE FUNCTION lab_simulator_ensemble_members_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab simulator ensemble members are append-only (INSERT only — the sampled member history is never rewritten)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_simulator_ensemble_members_no_update_trigger ON lab_simulator_ensemble_members;
CREATE TRIGGER lab_simulator_ensemble_members_no_update_trigger
    BEFORE UPDATE ON lab_simulator_ensemble_members
    FOR EACH ROW EXECUTE FUNCTION lab_simulator_ensemble_members_append_only();

DROP TRIGGER IF EXISTS lab_simulator_ensemble_members_no_delete_trigger ON lab_simulator_ensemble_members;
CREATE TRIGGER lab_simulator_ensemble_members_no_delete_trigger
    BEFORE DELETE ON lab_simulator_ensemble_members
    FOR EACH ROW EXECUTE FUNCTION lab_simulator_ensemble_members_append_only();

-- Scope consistency: a member's client must match its ensemble's
-- client AND its run's client AND its configuration's client
-- (cross-tenant member injection is rejected at the DB — §22).
CREATE OR REPLACE FUNCTION lab_simulator_ensemble_member_scope_check() RETURNS trigger AS $$
DECLARE
    ensemble_client uuid;
    run_client uuid;
    run_status text;
    config_client uuid;
BEGIN
    SELECT client_id INTO ensemble_client FROM lab_simulator_ensembles WHERE ensemble_id = NEW.ensemble_id;
    IF ensemble_client IS NULL THEN
        RAISE EXCEPTION 'lab simulator ensemble member must bind an existing ensemble (%)',
            NEW.ensemble_id;
    END IF;
    IF ensemble_client <> NEW.client_id THEN
        RAISE EXCEPTION 'lab simulator ensemble member client must match its ensemble client (cross-tenant member injection is rejected)';
    END IF;
    SELECT client_id, status INTO run_client, run_status FROM lab_simulator_runs WHERE run_id = NEW.run_id;
    IF run_client IS NULL THEN
        RAISE EXCEPTION 'lab simulator ensemble member must bind an existing run (%)',
            NEW.run_id;
    END IF;
    IF run_client <> NEW.client_id THEN
        RAISE EXCEPTION 'lab simulator ensemble member client must match its run client (cross-tenant member injection is rejected)';
    END IF;
    IF run_status <> 'completed' THEN
        RAISE EXCEPTION 'lab simulator ensemble member run must be completed (the member outcome exists)';
    END IF;
    SELECT client_id INTO config_client FROM lab_simulator_world_configs
        WHERE config_id = NEW.config_id AND config_version = NEW.config_version;
    IF config_client IS NULL THEN
        RAISE EXCEPTION 'lab simulator ensemble member must bind an existing configuration (% v%)',
            NEW.config_id, NEW.config_version;
    END IF;
    IF config_client <> NEW.client_id THEN
        RAISE EXCEPTION 'lab simulator ensemble member client must match its configuration client (cross-tenant member injection is rejected)';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_simulator_ensemble_member_scope_trigger ON lab_simulator_ensemble_members;
CREATE TRIGGER lab_simulator_ensemble_member_scope_trigger
    BEFORE INSERT ON lab_simulator_ensemble_members
    FOR EACH ROW EXECUTE FUNCTION lab_simulator_ensemble_member_scope_check();
