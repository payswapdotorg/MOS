-- 054_experiment_analysis.sql — MKT-067 (Experiment Analysis and Adaptive
-- Allocation).
--
-- The ANALYSIS LAYER over the existing /experiments authority
-- (spec/architecture-v1.6.md §12 "Experiment analysis": "The existing
-- Experiment authority remains responsible for experiment identity/design.
-- v1.6 adds an analysis layer that computes treatment/comparison effects,
-- uncertainty, sample sizes, observation windows, sequential-analysis
-- state, confounders, limitations, practical effect thresholds and
-- recommended next allocation. Adaptive allocation may increase exposure
-- to promising strategy variants while retaining explicit exploration.
-- A negative or inconclusive result remains a valid scientific outcome.";
-- spec/change-request-006.md change #9 "Add Experiment Analysis and adaptive
-- strategy allocation over the existing Experiment authority";
-- spec/module-dependency-matrix-v1.6.md frozen row
-- "/experiment-analysis → /experiments, /metrics, /evidence, /learnings").
--
-- Migration numbering: 054 is PRE-ASSIGNED to MKT-067 (the Tech-Lead
-- assignment; 053_content_assets.sql is the tail on the base; sibling
-- workers MKT-057 and UX-001 were told to add NONE — the Tech Lead
-- reconciles numbering at merge, the 063/064 precedent).
--
-- Tables created here (table ownership follows the frozen authority map):
--
--   experiment_analysis_records
--     → the APPEND-ONLY analysis records (the §12 computed DATA set as
--       durable rows: treatment/comparison effects, uncertainty, sample
--       sizes, observation window, sequential-analysis state, confounders,
--       limitations, the practical effect threshold, the recommended next
--       allocation, and the FULL INPUT SNAPSHOT the computation consumed
--       — experiment reference, consumed metric observations, evidence
--       links, consumed learnings, the window, prior-analysis count —
--       with its deterministic input digest). A negative or inconclusive
--       outcome is a first-class recorded value (outcome CHECK contains
--       'effect_negative', 'inconclusive' and 'insufficient_observations');
--       UPDATE and DELETE are rejected outright — analyses are never
--       discarded, never rewritten as success, never silently retried
--       away (re-analysis is a NEW record).
--   experiment_allocation_recommendations
--     → the APPEND-ONLY adaptive-allocation recommendations (the §12
--       "recommended next allocation" as its own auditable surface): the
--       declared arms (treatment/comparison/strategy_variant/human_treatment
--       kinds with capacity), the computed bounded exploration/exploitation
--       shares, the EXPLORATION FLOOR AS RECORDED DATA (value + source —
--       never a hardcoded magic number), the zero-capacity arms recorded
--       with their exclusion reason (the human-growth invariant: a
--       human-treatment arm with zero capacity never blocks, crashes or
--       invalidates the non-human allocation), and the FULL deterministic
--       input snapshot + digest so re-running the allocator on the same
--       inputs reproduces the same decision. UPDATE and DELETE are
--       rejected outright.
--
-- Frozen semantics encoded here (FROZEN — never a caller freedom):
--
-- * THE ANALYSIS OUTCOME VOCABULARY (ea-vocab-v1): a CLOSED set —
--   'effect_positive' (interval entirely above the practical threshold),
--   'effect_negative' (interval entirely below the negative threshold),
--   'effect_negligible' (interval bounded within ±threshold — a precise
--   null result), 'inconclusive' (interval straddles a boundary — the
--   honest unknown), 'insufficient_observations' (below the declared
--   minimum per arm). A NEGATIVE or INCONCLUSIVE result is a VALID
--   SCIENTIFIC OUTCOME, recorded first-class, never rewritten.
-- * THE RECOMMENDED-ALLOCATION VOCABULARY (the §12 two-arm guidance as
--   data): 'shift_toward_treatment' | 'shift_toward_comparison' |
--   'hold_balanced' | 'conclude_and_adopt' — a RECOMMENDATION recorded as
--   data toward the mission/operator layer; nothing here mutates
--   experiment exposure, platform state or workflow inputs (no second
--   execution engine — the /experiments authority stays sole for
--   experiment identity/design/lifecycle).
-- * THE ARM-KIND VOCABULARY: 'treatment' | 'comparison' |
--   'strategy_variant' | 'human_treatment' — the human-treatment arm is
--   ordinary DATA (architecture-lock-v1.6 rule 43: human amplification is
--   an optional experiment treatment); a zero-capacity arm of ANY kind is
--   excluded from allocation and RECORDED, never an error (rule 44).
-- * THE EXPLORATION FLOOR IS RECORDED DATA: exploration_floor carries its
--   own source column ('declared_input' | 'module_default_v1') — the
--   bounded-exploration guarantee is a recorded fact per recommendation,
--   never a hardcoded magic number invisible to the record.
-- * DETERMINISM: both tables carry the full input snapshot (jsonb) + the
--   canonical input digest; the statistics/allocator cores are pure and
--   versioned (analysis_method + analysis_method_version +
--   vocabulary_version) — same inputs produce the same outputs. There is
--   deliberately NO ai-runtime dependency in this module's matrix row.
-- * APPEND-ONLY (the migration 047/052/053 pattern): the database itself
--   rejects UPDATE and DELETE on both tables — not even server code can
--   rewrite what was analyzed or allocated. Corrections are NEW records.
-- * PROVENANCE IS SERVER-DERIVED (implementation-contract §3):
--   recorded_actor, recorded_via, correlation_id, causation_id and
--   recorded_at are written exclusively by server code — there is no
--   request DTO path to them (route validation rejects provenance-shaped
--   authority fields AND computed-outcome authority fields).
-- * CLIENT OWNERSHIP (TENANT-003 hard boundary): client_id is NOT NULL on
--   every row; the REFERENCED experiment must belong to the SAME Client
--   (trigger — cross-tenant experiment linkage is rejected); the optional
--   workspace must belong to that Client (trigger — the migration
--   015/018/053 pattern).
-- * NO PROVIDER STATE: no provider metric ids, no SDK-shaped columns, no
--   external statistics service references — the observations consumed
--   are MOS /metric observation ids resolved through the public contract.
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, append-oriented tails, database-enforced vocabularies. No
-- owner/role/user columns beyond provenance: agency-scope authorization
-- stays exactly at the route layer — no second tenant, permission or
-- identity authority.

-- ---------------------------------------------------------------------------
-- experiment_analysis_records — the append-only analysis tail
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS experiment_analysis_records (
    analysis_id            uuid        PRIMARY KEY,
    -- TENANT: every analysis belongs to exactly one Client.
    client_id              uuid        NOT NULL REFERENCES clients(client_id),
    -- Optional Workspace scope INSIDE the owning Client.
    workspace_id           uuid        REFERENCES workspaces(workspace_id),
    -- THE EXPERIMENT AUTHORITY ANCHOR (read-only): the /experiments record
    -- this analysis was computed over. The analysis layer never creates or
    -- mutates experiments — the FK is the structural fence.
    experiment_id          uuid        NOT NULL REFERENCES experiments(experiment_id),
    -- The frozen deterministic method identity (this Work Item implements
    -- exactly one: the two-sample means analysis).
    analysis_method        text        NOT NULL
                           CHECK (analysis_method IN ('two_sample_means_v1')),
    analysis_method_version text       NOT NULL
                           CHECK (length(analysis_method_version) >= 1
                                  AND length(analysis_method_version) <= 32),
    vocabulary_version     text        NOT NULL
                           CHECK (vocabulary_version = 'ea-vocab-v1'),
    -- THE OBSERVATION WINDOW (§12 "observation windows"): the inclusive
    -- half-open interval [start, end) over observed_at that the computation
    -- consumed. A real, positive window only.
    observation_window_start timestamptz NOT NULL,
    observation_window_end   timestamptz NOT NULL
                           CHECK (observation_window_end > observation_window_start),
    -- SAMPLE SIZES (§12 "sample sizes"): the per-arm counts consumed.
    n_treatment            integer     NOT NULL CHECK (n_treatment >= 0),
    n_comparison           integer     NOT NULL CHECK (n_comparison >= 0),
    -- TREATMENT/COMPARISON EFFECTS (§12): the per-arm means and the effect
    -- estimate (treatment mean − comparison mean) with its standard error.
    -- Nullable exactly when the arm had no observations (a zero-sample arm
    -- is a recorded state, never a fabricated zero).
    treatment_mean         double precision
                           CHECK (treatment_mean IS NULL OR n_treatment > 0),
    comparison_mean        double precision
                           CHECK (comparison_mean IS NULL OR n_comparison > 0),
    effect_estimate        double precision,
    standard_error         double precision
                           CHECK (standard_error IS NULL OR standard_error >= 0),
    -- UNCERTAINTY (§12): the interval payload (kind/level/lower/upper) —
    -- retained verbatim, matching the declared level. An object, always.
    uncertainty            jsonb       NOT NULL
                           CHECK (jsonb_typeof(uncertainty) = 'object'),
    -- SEQUENTIAL-ANALYSIS STATE (§12): the interim-look state (interim
    -- index, max looks, per-look level, cumulative alpha spent, boundary
    -- crossing, continue flag) — computed from the prior-analysis tail.
    sequential_state       jsonb       NOT NULL
                           CHECK (jsonb_typeof(sequential_state) = 'object'),
    -- CONFOUNDERS + LIMITATIONS (§12): the declared inputs MERGED with the
    -- deterministic derived entries. String arrays, retained verbatim.
    confounders            jsonb       NOT NULL DEFAULT '[]'::jsonb
                           CHECK (jsonb_typeof(confounders) = 'array'),
    limitations            jsonb       NOT NULL DEFAULT '[]'::jsonb
                           CHECK (jsonb_typeof(limitations) = 'array'),
    -- THE PRACTICAL EFFECT THRESHOLD (§12): the recorded value + source —
    -- the effect size below which a difference is practically negligible.
    practical_threshold    jsonb       NOT NULL
                           CHECK (jsonb_typeof(practical_threshold) = 'object'),
    -- THE OUTCOME (ea-vocab-v1, the closed CHECK-fenced set). A negative
    -- or inconclusive outcome is a first-class value.
    outcome                text        NOT NULL
                           CHECK (outcome IN ('effect_positive',
                                              'effect_negative',
                                              'effect_negligible',
                                              'inconclusive',
                                              'insufficient_observations')),
    -- RECOMMENDED NEXT ALLOCATION (§12): the two-arm guidance recorded as
    -- DATA. A recommendation — never a mutation of experiment exposure.
    recommended_next_allocation text    NOT NULL
                           CHECK (recommended_next_allocation IN
                                  ('shift_toward_treatment',
                                   'shift_toward_comparison',
                                   'hold_balanced',
                                   'conclude_and_adopt')),
    -- FULL INPUT PROVENANCE (the dispatch's required snapshot): the exact
    -- inputs the computation consumed — the experiment design fields read,
    -- the metric observations consumed (ids + values + observedAt + unit +
    -- quality + arm), the evidence links, the consumed learnings, the
    -- window, prior-analysis count, declared confounders/limitations and
    -- the analysis method identity. An object, always.
    input_snapshot         jsonb       NOT NULL
                           CHECK (jsonb_typeof(input_snapshot) = 'object'),
    -- The canonical deterministic digest of the input snapshot (the
    -- equality token — the growth-operator evidence-snapshot pattern).
    input_digest           text        NOT NULL
                           CHECK (length(input_digest) >= 16
                                  AND length(input_digest) <= 512),
    -- /evidence records cited by this analysis (SAME Client; the module
    -- validates through the /evidence public contract; the trigger is the
    -- race backstop).
    evidence_refs          jsonb       NOT NULL DEFAULT '[]'::jsonb
                           CHECK (jsonb_typeof(evidence_refs) = 'array'),
    -- The /metric observation ids consumed (SAME Client by construction —
    -- they were read through the /metrics public contract for this
    -- Client).
    metric_observation_refs jsonb      NOT NULL DEFAULT '[]'::jsonb
                           CHECK (jsonb_typeof(metric_observation_refs) = 'array'),
    -- The /learnings records consumed as confounder/outcome context (the
    -- client's learnings citing this experiment, read through the
    -- /learnings public contract).
    learning_refs          jsonb       NOT NULL DEFAULT '[]'::jsonb
                           CHECK (jsonb_typeof(learning_refs) = 'array'),
    -- SERVER-DERIVED provenance (never request fields).
    recorded_actor         text        NOT NULL
                           CHECK (length(recorded_actor) >= 1
                                  AND length(recorded_actor) <= 100),
    recorded_via           text        NOT NULL
                           CHECK (length(recorded_via) >= 1
                                  AND length(recorded_via) <= 100),
    correlation_id         text        NOT NULL
                           CHECK (length(correlation_id) >= 1
                                  AND length(correlation_id) <= 100),
    causation_id           text
                           CHECK (causation_id IS NULL
                                  OR (length(causation_id) >= 1
                                      AND length(causation_id) <= 100)),
    recorded_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS experiment_analysis_records_client_idx
    ON experiment_analysis_records (client_id, recorded_at DESC, analysis_id);

CREATE INDEX IF NOT EXISTS experiment_analysis_records_experiment_idx
    ON experiment_analysis_records (experiment_id, recorded_at, analysis_id);

-- TENANT FENCE (the migration 003/029/046/047/051/053 pattern): the
-- referenced experiment must belong to this Client, and the optional
-- workspace must belong to this Client — the scope chain cannot be
-- crossed even by a direct SQL writer.
CREATE OR REPLACE FUNCTION experiment_analysis_scope_chain_consistent() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM experiments e
        WHERE e.experiment_id = NEW.experiment_id
          AND e.client_id = NEW.client_id) THEN
        RAISE EXCEPTION 'experiment analysis % references experiment % of another client — cross-tenant experiment linkage is rejected',
            NEW.analysis_id, NEW.experiment_id;
    END IF;
    IF NEW.workspace_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workspaces w
        WHERE w.workspace_id = NEW.workspace_id AND w.client_id = NEW.client_id) THEN
        RAISE EXCEPTION 'experiment analysis % workspace % does not belong to client % — the tenant scope chain cannot be crossed',
            NEW.analysis_id, NEW.workspace_id, NEW.client_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS experiment_analysis_scope_chain_trigger ON experiment_analysis_records;
CREATE TRIGGER experiment_analysis_scope_chain_trigger
    BEFORE INSERT OR UPDATE OF client_id, workspace_id, experiment_id ON experiment_analysis_records
    FOR EACH ROW EXECUTE FUNCTION experiment_analysis_scope_chain_consistent();

-- APPEND-ONLY ANALYSIS TAIL (the migration 047/052 pattern): the database
-- itself rejects UPDATE and DELETE on the analysis history — not even
-- server code can rewrite what was analyzed. A negative or inconclusive
-- result is preserved exactly as recorded; corrections and re-analyses
-- are NEW records.
CREATE OR REPLACE FUNCTION experiment_analysis_records_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'experiment analysis % is append-only (recorded analyses are immutable — a negative or inconclusive result is preserved, never rewritten; re-analysis is a NEW record)',
        OLD.analysis_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS experiment_analysis_records_append_only_trigger ON experiment_analysis_records;
CREATE TRIGGER experiment_analysis_records_append_only_trigger
    BEFORE UPDATE OR DELETE ON experiment_analysis_records
    FOR EACH ROW EXECUTE FUNCTION experiment_analysis_records_append_only();

-- ---------------------------------------------------------------------------
-- experiment_allocation_recommendations — the append-only allocation tail
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS experiment_allocation_recommendations (
    recommendation_id      uuid        PRIMARY KEY,
    -- TENANT: every recommendation belongs to exactly one Client.
    client_id              uuid        NOT NULL REFERENCES clients(client_id),
    -- Optional Workspace scope INSIDE the owning Client.
    workspace_id           uuid        REFERENCES workspaces(workspace_id),
    -- THE EXPERIMENT AUTHORITY ANCHOR (read-only): the /experiments record
    -- whose strategy variants the allocation is over.
    experiment_id          uuid        NOT NULL REFERENCES experiments(experiment_id),
    -- Optional linkage to the analysis record this allocation was derived
    -- from (nullable: an allocation may stand alone over declared arms;
    -- when present it must belong to the SAME Client AND experiment).
    analysis_id            uuid        REFERENCES experiment_analysis_records(analysis_id),
    vocabulary_version     text        NOT NULL
                           CHECK (vocabulary_version = 'ea-vocab-v1'),
    -- THE DECLARED ARMS (the allocator input, recorded verbatim): one
    -- entry per arm — armKey, kind (treatment/comparison/strategy_variant/
    -- human_treatment), observable capacity, sample size, mean, variance.
    arms                   jsonb       NOT NULL
                           CHECK (jsonb_typeof(arms) = 'array'),
    -- THE COMPUTED ALLOCATION (the allocator output, recorded verbatim):
    -- the per-arm shares over the eligible arms, the eligible-arm list and
    -- the zero-capacity arms WITH their exclusion reasons (the human-growth
    -- invariant trail).
    allocation             jsonb       NOT NULL
                           CHECK (jsonb_typeof(allocation) = 'object'),
    -- THE EXPLORATION FLOOR AS RECORDED DATA: the bounded-exploration
    -- guarantee (a share of exposure reserved for exploration, distributed
    -- equally over the eligible arms) with ITS SOURCE — never a hardcoded
    -- magic number invisible to the record.
    exploration_floor      double precision NOT NULL
                           CHECK (exploration_floor > 0 AND exploration_floor <= 0.5),
    exploration_floor_source text      NOT NULL
                           CHECK (exploration_floor_source IN
                                  ('declared_input', 'module_default_v1')),
    -- FULL INPUT PROVENANCE + the canonical deterministic digest (the
    -- reproducibility anchor: re-running the allocator on the same
    -- snapshot reproduces the same decision — test-proven).
    input_snapshot         jsonb       NOT NULL
                           CHECK (jsonb_typeof(input_snapshot) = 'object'),
    input_digest           text        NOT NULL
                           CHECK (length(input_digest) >= 16
                                  AND length(input_digest) <= 512),
    -- The deterministic recommendation rationale (explicit, honest,
    -- bounded).
    rationale              text        NOT NULL
                           CHECK (length(rationale) >= 1 AND length(rationale) <= 4000),
    -- SERVER-DERIVED provenance (never request fields).
    recorded_actor         text        NOT NULL
                           CHECK (length(recorded_actor) >= 1
                                  AND length(recorded_actor) <= 100),
    recorded_via           text        NOT NULL
                           CHECK (length(recorded_via) >= 1
                                  AND length(recorded_via) <= 100),
    correlation_id         text        NOT NULL
                           CHECK (length(correlation_id) >= 1
                                  AND length(correlation_id) <= 100),
    causation_id           text
                           CHECK (causation_id IS NULL
                                  OR (length(causation_id) >= 1
                                      AND length(causation_id) <= 100)),
    recorded_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS experiment_allocation_recommendations_client_idx
    ON experiment_allocation_recommendations (client_id, recorded_at DESC, recommendation_id);

CREATE INDEX IF NOT EXISTS experiment_allocation_recommendations_experiment_idx
    ON experiment_allocation_recommendations (experiment_id, recorded_at, recommendation_id);

-- TENANT FENCE: the referenced experiment must belong to this Client, the
-- optional analysis must belong to the SAME Client AND experiment, and
-- the optional workspace must belong to this Client.
CREATE OR REPLACE FUNCTION experiment_allocation_scope_chain_consistent() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM experiments e
        WHERE e.experiment_id = NEW.experiment_id
          AND e.client_id = NEW.client_id) THEN
        RAISE EXCEPTION 'allocation recommendation % references experiment % of another client — cross-tenant experiment linkage is rejected',
            NEW.recommendation_id, NEW.experiment_id;
    END IF;
    IF NEW.analysis_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM experiment_analysis_records a
        WHERE a.analysis_id = NEW.analysis_id
          AND a.client_id = NEW.client_id
          AND a.experiment_id = NEW.experiment_id) THEN
        RAISE EXCEPTION 'allocation recommendation % references analysis % outside this client/experiment — the linkage chain cannot be crossed',
            NEW.recommendation_id, NEW.analysis_id;
    END IF;
    IF NEW.workspace_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workspaces w
        WHERE w.workspace_id = NEW.workspace_id AND w.client_id = NEW.client_id) THEN
        RAISE EXCEPTION 'allocation recommendation % workspace % does not belong to client % — the tenant scope chain cannot be crossed',
            NEW.recommendation_id, NEW.workspace_id, NEW.client_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS experiment_allocation_scope_chain_trigger ON experiment_allocation_recommendations;
CREATE TRIGGER experiment_allocation_scope_chain_trigger
    BEFORE INSERT OR UPDATE OF client_id, workspace_id, experiment_id, analysis_id ON experiment_allocation_recommendations
    FOR EACH ROW EXECUTE FUNCTION experiment_allocation_scope_chain_consistent();

-- APPEND-ONLY ALLOCATION TAIL: the database itself rejects UPDATE and
-- DELETE on the allocation history — every decision stays auditable with
-- its full input snapshot; a revised allocation is a NEW recommendation.
CREATE OR REPLACE FUNCTION experiment_allocation_recommendations_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'experiment allocation recommendation % is append-only (allocation decisions are immutable records — a revised allocation is a NEW recommendation)',
        OLD.recommendation_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS experiment_allocation_recommendations_append_only_trigger ON experiment_allocation_recommendations;
CREATE TRIGGER experiment_allocation_recommendations_append_only_trigger
    BEFORE UPDATE OR DELETE ON experiment_allocation_recommendations
    FOR EACH ROW EXECUTE FUNCTION experiment_allocation_recommendations_append_only();
