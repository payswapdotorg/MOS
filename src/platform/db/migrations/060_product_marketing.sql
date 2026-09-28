-- 060_product_marketing.sql — MKT-070 (Product Marketing Mission
-- Planner).
--
-- The PRODUCT MARKETING PLANNER authority (spec/effective-backlog-v1.6.md
-- MKT-070: "choose social platform mix, target metrics, content strategy,
-- attribution and experiment plan for a product-marketing mission";
-- the frozen v1.6 matrix row, VERBATIM:
-- /product-marketing → /growth-missions, /product-intelligence,
-- /content-intelligence, /platform-health, /experiment-analysis):
--
--   product_marketing_plans                          → the AGENCY-SCOPED
--                                                     plan headers (ONE
--                                                     per mission — the
--                                                     mission authority
--                                                     MKT-053 stays the
--                                                     mission DATA MODEL;
--                                                     this planner never
--                                                     becomes a second
--                                                     mission authority);
--   product_marketing_plan_versions                  → the APPEND-ONLY
--                                                     plan version tail
--                                                     (corrections are NEW
--                                                     versions, never
--                                                     in-place rewrites;
--                                                     every version
--                                                     carries actor +
--                                                     provenance + a
--                                                     REQUIRED reason +
--                                                     the deterministic
--                                                     input digest — the
--                                                     idempotent-replanning
--                                                     anchor);
--   product_marketing_plan_cited_product_inputs      → the FK-anchored
--                                                     same-context
--                                                     /product-intelligence
--                                                     declared-input
--                                                     citation links;
--   product_marketing_plan_cited_product_facts       → the FK-anchored
--                                                     same-context
--                                                     /product-intelligence
--                                                     source-fact citation
--                                                     links;
--   product_marketing_plan_cited_product_models      → the FK-anchored
--                                                     same-context
--                                                     /product-intelligence
--                                                     derived-model
--                                                     citation links;
--   product_marketing_plan_cited_product_risk_flags  → the FK-anchored
--                                                     same-context
--                                                     /product-intelligence
--                                                     risk-flag citation
--                                                     links;
--   product_marketing_plan_cited_research_insights   → the FK-anchored
--                                                     same-session
--                                                     /research insight
--                                                     citation links (the
--                                                     MKT-069 disclosure:
--                                                     missions attach
--                                                     research
--                                                     sessions/insights BY
--                                                     REFERENCE);
--   product_marketing_plan_cited_platform_health_evaluations
--                                                    → the FK-anchored
--                                                     same-Client
--                                                     /platform-health
--                                                     evaluation citation
--                                                     links (the health
--                                                     verdicts behind
--                                                     every platform-mix
--                                                     decision — a
--                                                     restricted or
--                                                     publishing_blocked
--                                                     account is excluded
--                                                     or deprioritized
--                                                     WITH the verdict
--                                                     cited, never
--                                                     silently);
--   product_marketing_plan_cited_experiment_analyses → the FK-anchored
--                                                     same-Client
--                                                     /experiment-analysis
--                                                     analysis citation
--                                                     links;
--   product_marketing_plan_cited_allocation_recommendations
--                                                    → the FK-anchored
--                                                     same-Client
--                                                     /experiment-analysis
--                                                     allocation-recommendation
--                                                     citation links;
--   product_marketing_plan_cited_content_hypotheses  → the FK-anchored
--                                                     same-Client
--                                                     /content-intelligence
--                                                     hypothesis citation
--                                                     links.
--
-- Key fences:
--
-- * CHECK-fenced vocabularies on every enumerated column: the plan
--   inclusion tiers (primary/secondary/excluded — the portfolio rows),
--   the strategy version string (pm-plan-v1) and the bounded mission
--   gate carried as data. The portfolio/metric-plan/content-strategy/
--   attribution-plan/experiment-plan/decisions blocks are bounded jsonb
--   (the house jsonb precedent — the module guards are the fence and the
--   boundary tests pin the vocabularies).
-- * THE APPEND-ONLY TAILS: plan versions and every citation link reject
--   UPDATE and DELETE outright — a plan correction is a NEW version
--   record; history is never rewritten (the migration-045/052/058
--   pattern). The plan HEADER is the one mutable row (the version-tail
--   pointer + the CAS token — exactly the growth_missions discipline).
-- * THE SCOPE FENCES: every cross-module FK link is scope-consistent —
--   product-input/fact/model/risk-flag citations stay inside the cited
--   product context; research-insight citations stay inside the cited
--   research session; platform-health/experiment-analysis/
--   content-intelligence citations stay inside the plan's Client. All
--   anchored authority tables are read CHECK-ONLY.
-- * NO AUTHORITY TRANSFER: this migration creates NO mission, goal,
--   product-context, research, health-evaluation, analysis, experiment,
--   account or tenant table — the planner COMPOSES the consumed public
--   contracts READ-ONLY and cites their records by reference (the
--   platform-health evaluation-record discipline). The mission FK anchor
--   keeps a dangling mission reference from persisting.
-- * NO SECOND WORKFLOW/EXECUTION ENGINE: no job, queue, worker, timer or
--   scheduler table exists anywhere in this migration (the Growth
--   Operator MKT-054 owns the bounded delegation; this planner is the
--   deterministic, auditable DECISION layer — architecture-lock-v1.6.md
--   rule 17).
-- * NO SECRET MATERIAL ANYWHERE (CRED-001/§21): the only structured
--   payload columns are the bounded plan blocks — there is deliberately
--   NO column capable of holding secret material.
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, append-oriented tails. No owner/role/user columns beyond
-- provenance: agency-scope authorization stays exactly the
-- route-layer authority — no second tenant, permission or identity
-- authority.

-- ---------------------------------------------------------------------------
-- product_marketing_plans — the agency-scoped plan headers (ONE per
-- mission; the version-tail pointer + the CAS token)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS product_marketing_plans (
    product_marketing_plan_id  uuid        PRIMARY KEY,
    -- The MISSION this plan plans for (the MKT-053 authority stays sole —
    -- the FK anchor keeps a dangling mission reference from persisting).
    mission_id                 uuid        NOT NULL REFERENCES growth_missions(mission_id),
    -- ONE plan per mission (the planner is the per-mission planning
    -- layer; corrections are NEW versions of the SAME plan).
    CONSTRAINT product_marketing_plans_mission_uniq UNIQUE (mission_id),
    agency_id                  uuid        NOT NULL REFERENCES agencies(agency_id),
    -- The PURSUIT CLIENT (derived server-side from the pursuit workspace
    -- through the canonical ownership chain — the platform-health /
    -- experiment-analysis / content-intelligence surfaces are
    -- client-scoped; the FK anchor is the backstop).
    client_id                  uuid        NOT NULL REFERENCES clients(client_id),
    -- The pursuit workspace narrowing (carried as data; NULL = the client
    -- root scope).
    workspace_id               uuid        REFERENCES workspaces(workspace_id),
    -- The version-tail pointer (only ever ADVANCES; the current plan).
    current_version_seq        integer     NOT NULL CHECK (current_version_seq >= 1),
    -- The CAS token (row-locked version advance).
    version                    integer     NOT NULL CHECK (version >= 1),
    created_actor              text        NOT NULL
                                           CHECK (length(created_actor) >= 1 AND length(created_actor) <= 100),
    created_at                 timestamptz NOT NULL,
    updated_at                 timestamptz NOT NULL
);

-- The agency's plans (the per-agency read).
CREATE INDEX IF NOT EXISTS product_marketing_plans_agency_idx
    ON product_marketing_plans (agency_id, created_at, product_marketing_plan_id);

-- ---------------------------------------------------------------------------
-- product_marketing_plan_versions — the APPEND-ONLY plan version tail
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS product_marketing_plan_versions (
    product_marketing_plan_version_id  uuid        PRIMARY KEY,
    product_marketing_plan_id          uuid        NOT NULL REFERENCES product_marketing_plans(product_marketing_plan_id),
    -- Gapless per-plan sequence (assigned under the plan row lock).
    version_seq                        integer     NOT NULL CHECK (version_seq >= 1),
    CONSTRAINT product_marketing_plan_versions_seq_uniq
        UNIQUE (product_marketing_plan_id, version_seq),
    -- The cited /product-intelligence Product Context (the URL/code
    -- context that produced this plan — the FK anchor).
    product_context_id                 uuid        NOT NULL REFERENCES product_contexts(product_context_id),
    -- The product context version the plan was computed against (carried
    -- as data inside the input snapshot; the id column is the anchor).
    product_context_version_id         uuid        NOT NULL REFERENCES product_context_versions(product_context_version_id),
    -- The optionally attached /research session (the MKT-069 disclosure —
    -- missions attach research sessions/insights BY REFERENCE).
    research_session_id                uuid        REFERENCES research_sessions(research_session_id),
    -- The REQUIRED reason every version carries (the honest correction
    -- record — actor + provenance + reason).
    reason                             text        NOT NULL
                                       CHECK (length(reason) >= 1 AND length(reason) <= 4000),
    -- The DETERMINISTIC INPUT SNAPSHOT (the reproducibility anchor: which
    -- mission version, product-context version, research version,
    -- evaluation/analysis/recommendation/hypothesis ids and goal
    -- references the pure core consumed — bounded jsonb object).
    input_snapshot                     jsonb       NOT NULL DEFAULT '{}'::jsonb
                                       CHECK (jsonb_typeof(input_snapshot) = 'object'),
    -- The deterministic input digest (the idempotent-replanning anchor:
    -- the same observable world → the same digest → the honest replay
    -- convergence, never a duplicate version).
    input_digest                       text        NOT NULL
                                       CHECK (length(input_digest) >= 1 AND length(input_digest) <= 500),
    -- The chosen SOCIAL PLATFORM MIX (the auditable portfolio rows:
    -- platform, account, inclusion tier, score, weight share, the cited
    -- health verdict and the deterministic rationale).
    platform_portfolio                 jsonb       NOT NULL DEFAULT '[]'::jsonb
                                       CHECK (jsonb_typeof(platform_portfolio) = 'array'
                                              AND jsonb_array_length(platform_portfolio) <= 32),
    -- The TARGET METRIC PLAN (the frozen objective-family vocabulary
    -- wired to the mission's EXISTING goals BY REFERENCE — goal progress
    -- is never re-stated or re-computed here).
    metric_plan                        jsonb       NOT NULL DEFAULT '[]'::jsonb
                                       CHECK (jsonb_typeof(metric_plan) = 'array'
                                              AND jsonb_array_length(metric_plan) <= 16),
    -- The CONTENT STRATEGY profile (the closed profile vocabulary + the
    -- pillars/format priorities derived from the cited evidence).
    content_strategy                   jsonb       NOT NULL DEFAULT '{}'::jsonb
                                       CHECK (jsonb_typeof(content_strategy) = 'object'),
    -- The ATTRIBUTION PLAN (what will be measured and HOW attribution
    -- will be computed — attribution is distinct from causality, the
    -- plan never claims causal truth).
    attribution_plan                   jsonb       NOT NULL DEFAULT '{}'::jsonb
                                       CHECK (jsonb_typeof(attribution_plan) = 'object'),
    -- The BOUNDED EXPERIMENT PLAN (declared as DATA for the Growth
    -- Operator's bounded-experiment delegation through the EXISTING
    -- /experiments authority — the planner creates no experiment).
    experiment_plan                    jsonb       NOT NULL DEFAULT '{}'::jsonb
                                       CHECK (jsonb_typeof(experiment_plan) = 'object'),
    -- The auditable DECISION entries (every decision with its rationale
    -- and its typed citation references).
    decisions                          jsonb       NOT NULL DEFAULT '[]'::jsonb
                                       CHECK (jsonb_typeof(decisions) = 'array'
                                              AND jsonb_array_length(decisions) <= 64),
    -- The frozen strategy version (a scoring change is a NEW version
    -- string — never silently re-stated).
    strategy_version                   text        NOT NULL
                                       CHECK (strategy_version = 'pm-plan-v1'),
    -- SERVER-DERIVED provenance (never a request field).
    recorded_actor                     text        NOT NULL
                                       CHECK (length(recorded_actor) >= 1 AND length(recorded_actor) <= 100),
    recorded_via                       text        NOT NULL
                                       CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 100),
    correlation_id                     text        NOT NULL,
    causation_id                       text,
    created_at                         timestamptz NOT NULL
);

-- The plan's version tail (oldest first).
CREATE INDEX IF NOT EXISTS product_marketing_plan_versions_plan_idx
    ON product_marketing_plan_versions (product_marketing_plan_id, version_seq);

-- Plan versions are APPEND-ONLY: a correction is a NEW version record;
-- the recorded plan and its citation basis are never rewritten in place.
CREATE OR REPLACE FUNCTION product_marketing_plan_versions_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'product marketing plan versions are append-only: % is rejected on plan version % — a plan correction is a NEW version record',
        TG_OP, COALESCE(NEW.product_marketing_plan_version_id, OLD.product_marketing_plan_version_id);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_marketing_plan_versions_append_only_update_trigger ON product_marketing_plan_versions;
CREATE TRIGGER product_marketing_plan_versions_append_only_update_trigger
    BEFORE UPDATE ON product_marketing_plan_versions
    FOR EACH ROW EXECUTE FUNCTION product_marketing_plan_versions_append_only();

DROP TRIGGER IF EXISTS product_marketing_plan_versions_append_only_delete_trigger ON product_marketing_plan_versions;
CREATE TRIGGER product_marketing_plan_versions_append_only_delete_trigger
    BEFORE DELETE ON product_marketing_plan_versions
    FOR EACH ROW EXECUTE FUNCTION product_marketing_plan_versions_append_only();

-- ---------------------------------------------------------------------------
-- The NINE FK-anchored citation link tables (the platform-health
-- evaluation-record discipline: every plan decision carries its evidence
-- basis as FK-anchored scope-fenced citation links)
-- ---------------------------------------------------------------------------

-- (1) cited /product-intelligence declared inputs (the URL/code context
-- basis — a source_repository/source_workspace input is the code-context
-- signal).
CREATE TABLE IF NOT EXISTS product_marketing_plan_cited_product_inputs (
    product_marketing_plan_version_id  uuid    NOT NULL REFERENCES product_marketing_plan_versions(product_marketing_plan_version_id),
    input_id                           uuid    NOT NULL REFERENCES product_context_inputs(input_id),
    position                           integer NOT NULL CHECK (position >= 1 AND position <= 40),
    CONSTRAINT product_marketing_plan_cited_product_inputs_pk
        PRIMARY KEY (product_marketing_plan_version_id, input_id)
);

-- (2) cited /product-intelligence source facts.
CREATE TABLE IF NOT EXISTS product_marketing_plan_cited_product_facts (
    product_marketing_plan_version_id  uuid    NOT NULL REFERENCES product_marketing_plan_versions(product_marketing_plan_version_id),
    source_fact_id                     uuid    NOT NULL REFERENCES product_source_facts(source_fact_id),
    position                           integer NOT NULL CHECK (position >= 1 AND position <= 64),
    CONSTRAINT product_marketing_plan_cited_product_facts_pk
        PRIMARY KEY (product_marketing_plan_version_id, source_fact_id)
);

-- (3) cited /product-intelligence derived models.
CREATE TABLE IF NOT EXISTS product_marketing_plan_cited_product_models (
    product_marketing_plan_version_id  uuid    NOT NULL REFERENCES product_marketing_plan_versions(product_marketing_plan_version_id),
    derived_model_id                   uuid    NOT NULL REFERENCES product_derived_models(derived_model_id),
    position                           integer NOT NULL CHECK (position >= 1 AND position <= 32),
    CONSTRAINT product_marketing_plan_cited_product_models_pk
        PRIMARY KEY (product_marketing_plan_version_id, derived_model_id)
);

-- (4) cited /product-intelligence risk flags.
CREATE TABLE IF NOT EXISTS product_marketing_plan_cited_product_risk_flags (
    product_marketing_plan_version_id  uuid    NOT NULL REFERENCES product_marketing_plan_versions(product_marketing_plan_version_id),
    risk_flag_id                       uuid    NOT NULL REFERENCES product_risk_flags(risk_flag_id),
    position                           integer NOT NULL CHECK (position >= 1 AND position <= 16),
    CONSTRAINT product_marketing_plan_cited_product_risk_flags_pk
        PRIMARY KEY (product_marketing_plan_version_id, risk_flag_id)
);

-- (5) cited /research insights (the by-reference research attachment).
CREATE TABLE IF NOT EXISTS product_marketing_plan_cited_research_insights (
    product_marketing_plan_version_id  uuid    NOT NULL REFERENCES product_marketing_plan_versions(product_marketing_plan_version_id),
    research_insight_id                uuid    NOT NULL REFERENCES research_insights(research_insight_id),
    position                           integer NOT NULL CHECK (position >= 1 AND position <= 32),
    CONSTRAINT product_marketing_plan_cited_research_insights_pk
        PRIMARY KEY (product_marketing_plan_version_id, research_insight_id)
);

-- (6) cited /platform-health evaluations (the health verdicts behind the
-- platform-mix decisions).
CREATE TABLE IF NOT EXISTS product_marketing_plan_cited_platform_health_evaluations (
    product_marketing_plan_version_id      uuid    NOT NULL REFERENCES product_marketing_plan_versions(product_marketing_plan_version_id),
    platform_health_evaluation_id          uuid    NOT NULL REFERENCES platform_health_evaluations(platform_health_evaluation_id),
    position                               integer NOT NULL CHECK (position >= 1 AND position <= 32),
    CONSTRAINT product_marketing_plan_cited_platform_health_evaluations_pk
        PRIMARY KEY (product_marketing_plan_version_id, platform_health_evaluation_id)
);

-- (7) cited /experiment-analysis analyses.
CREATE TABLE IF NOT EXISTS product_marketing_plan_cited_experiment_analyses (
    product_marketing_plan_version_id  uuid    NOT NULL REFERENCES product_marketing_plan_versions(product_marketing_plan_version_id),
    analysis_id                        uuid    NOT NULL REFERENCES experiment_analysis_records(analysis_id),
    position                           integer NOT NULL CHECK (position >= 1 AND position <= 16),
    CONSTRAINT product_marketing_plan_cited_experiment_analyses_pk
        PRIMARY KEY (product_marketing_plan_version_id, analysis_id)
);

-- (8) cited /experiment-analysis allocation recommendations.
CREATE TABLE IF NOT EXISTS product_marketing_plan_cited_allocation_recommendations (
    product_marketing_plan_version_id      uuid    NOT NULL REFERENCES product_marketing_plan_versions(product_marketing_plan_version_id),
    recommendation_id                      uuid    NOT NULL REFERENCES experiment_allocation_recommendations(recommendation_id),
    position                               integer NOT NULL CHECK (position >= 1 AND position <= 16),
    CONSTRAINT product_marketing_plan_cited_allocation_recommendations_pk
        PRIMARY KEY (product_marketing_plan_version_id, recommendation_id)
);

-- (9) cited /content-intelligence hypotheses.
CREATE TABLE IF NOT EXISTS product_marketing_plan_cited_content_hypotheses (
    product_marketing_plan_version_id  uuid    NOT NULL REFERENCES product_marketing_plan_versions(product_marketing_plan_version_id),
    content_hypothesis_id              uuid    NOT NULL REFERENCES content_hypotheses(content_hypothesis_id),
    position                           integer NOT NULL CHECK (position >= 1 AND position <= 32),
    CONSTRAINT product_marketing_plan_cited_content_hypotheses_pk
        PRIMARY KEY (product_marketing_plan_version_id, content_hypothesis_id)
);

-- THE APPEND-ONLY FENCE on every citation link table: the citation basis
-- of a recorded plan version is never rewritten.
CREATE OR REPLACE FUNCTION product_marketing_plan_citations_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'product marketing plan citation links are append-only: % is rejected on table %',
        TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_marketing_cited_product_inputs_append_only_update ON product_marketing_plan_cited_product_inputs;
CREATE TRIGGER product_marketing_cited_product_inputs_append_only_update
    BEFORE UPDATE ON product_marketing_plan_cited_product_inputs
    FOR EACH ROW EXECUTE FUNCTION product_marketing_plan_citations_append_only();
DROP TRIGGER IF EXISTS product_marketing_cited_product_inputs_append_only_delete ON product_marketing_plan_cited_product_inputs;
CREATE TRIGGER product_marketing_cited_product_inputs_append_only_delete
    BEFORE DELETE ON product_marketing_plan_cited_product_inputs
    FOR EACH ROW EXECUTE FUNCTION product_marketing_plan_citations_append_only();

DROP TRIGGER IF EXISTS product_marketing_cited_product_facts_append_only_update ON product_marketing_plan_cited_product_facts;
CREATE TRIGGER product_marketing_cited_product_facts_append_only_update
    BEFORE UPDATE ON product_marketing_plan_cited_product_facts
    FOR EACH ROW EXECUTE FUNCTION product_marketing_plan_citations_append_only();
DROP TRIGGER IF EXISTS product_marketing_cited_product_facts_append_only_delete ON product_marketing_plan_cited_product_facts;
CREATE TRIGGER product_marketing_cited_product_facts_append_only_delete
    BEFORE DELETE ON product_marketing_plan_cited_product_facts
    FOR EACH ROW EXECUTE FUNCTION product_marketing_plan_citations_append_only();

DROP TRIGGER IF EXISTS product_marketing_cited_product_models_append_only_update ON product_marketing_plan_cited_product_models;
CREATE TRIGGER product_marketing_cited_product_models_append_only_update
    BEFORE UPDATE ON product_marketing_plan_cited_product_models
    FOR EACH ROW EXECUTE FUNCTION product_marketing_plan_citations_append_only();
DROP TRIGGER IF EXISTS product_marketing_cited_product_models_append_only_delete ON product_marketing_plan_cited_product_models;
CREATE TRIGGER product_marketing_cited_product_models_append_only_delete
    BEFORE DELETE ON product_marketing_plan_cited_product_models
    FOR EACH ROW EXECUTE FUNCTION product_marketing_plan_citations_append_only();

DROP TRIGGER IF EXISTS product_marketing_cited_product_risk_flags_append_only_update ON product_marketing_plan_cited_product_risk_flags;
CREATE TRIGGER product_marketing_cited_product_risk_flags_append_only_update
    BEFORE UPDATE ON product_marketing_plan_cited_product_risk_flags
    FOR EACH ROW EXECUTE FUNCTION product_marketing_plan_citations_append_only();
DROP TRIGGER IF EXISTS product_marketing_cited_product_risk_flags_append_only_delete ON product_marketing_plan_cited_product_risk_flags;
CREATE TRIGGER product_marketing_cited_product_risk_flags_append_only_delete
    BEFORE DELETE ON product_marketing_plan_cited_product_risk_flags
    FOR EACH ROW EXECUTE FUNCTION product_marketing_plan_citations_append_only();

DROP TRIGGER IF EXISTS product_marketing_cited_research_insights_append_only_update ON product_marketing_plan_cited_research_insights;
CREATE TRIGGER product_marketing_cited_research_insights_append_only_update
    BEFORE UPDATE ON product_marketing_plan_cited_research_insights
    FOR EACH ROW EXECUTE FUNCTION product_marketing_plan_citations_append_only();
DROP TRIGGER IF EXISTS product_marketing_cited_research_insights_append_only_delete ON product_marketing_plan_cited_research_insights;
CREATE TRIGGER product_marketing_cited_research_insights_append_only_delete
    BEFORE DELETE ON product_marketing_plan_cited_research_insights
    FOR EACH ROW EXECUTE FUNCTION product_marketing_plan_citations_append_only();

DROP TRIGGER IF EXISTS product_marketing_cited_platform_health_append_only_update ON product_marketing_plan_cited_platform_health_evaluations;
CREATE TRIGGER product_marketing_cited_platform_health_append_only_update
    BEFORE UPDATE ON product_marketing_plan_cited_platform_health_evaluations
    FOR EACH ROW EXECUTE FUNCTION product_marketing_plan_citations_append_only();
DROP TRIGGER IF EXISTS product_marketing_cited_platform_health_append_only_delete ON product_marketing_plan_cited_platform_health_evaluations;
CREATE TRIGGER product_marketing_cited_platform_health_append_only_delete
    BEFORE DELETE ON product_marketing_plan_cited_platform_health_evaluations
    FOR EACH ROW EXECUTE FUNCTION product_marketing_plan_citations_append_only();

DROP TRIGGER IF EXISTS product_marketing_cited_experiment_analyses_append_only_update ON product_marketing_plan_cited_experiment_analyses;
CREATE TRIGGER product_marketing_cited_experiment_analyses_append_only_update
    BEFORE UPDATE ON product_marketing_plan_cited_experiment_analyses
    FOR EACH ROW EXECUTE FUNCTION product_marketing_plan_citations_append_only();
DROP TRIGGER IF EXISTS product_marketing_cited_experiment_analyses_append_only_delete ON product_marketing_plan_cited_experiment_analyses;
CREATE TRIGGER product_marketing_cited_experiment_analyses_append_only_delete
    BEFORE DELETE ON product_marketing_plan_cited_experiment_analyses
    FOR EACH ROW EXECUTE FUNCTION product_marketing_plan_citations_append_only();

DROP TRIGGER IF EXISTS product_marketing_cited_allocation_recommendations_append_only_update ON product_marketing_plan_cited_allocation_recommendations;
CREATE TRIGGER product_marketing_cited_allocation_recommendations_append_only_update
    BEFORE UPDATE ON product_marketing_plan_cited_allocation_recommendations
    FOR EACH ROW EXECUTE FUNCTION product_marketing_plan_citations_append_only();
DROP TRIGGER IF EXISTS product_marketing_cited_allocation_recommendations_append_only_delete ON product_marketing_plan_cited_allocation_recommendations;
CREATE TRIGGER product_marketing_cited_allocation_recommendations_append_only_delete
    BEFORE DELETE ON product_marketing_plan_cited_allocation_recommendations
    FOR EACH ROW EXECUTE FUNCTION product_marketing_plan_citations_append_only();

DROP TRIGGER IF EXISTS product_marketing_cited_content_hypotheses_append_only_update ON product_marketing_plan_cited_content_hypotheses;
CREATE TRIGGER product_marketing_cited_content_hypotheses_append_only_update
    BEFORE UPDATE ON product_marketing_plan_cited_content_hypotheses
    FOR EACH ROW EXECUTE FUNCTION product_marketing_plan_citations_append_only();
DROP TRIGGER IF EXISTS product_marketing_cited_content_hypotheses_append_only_delete ON product_marketing_plan_cited_content_hypotheses;
CREATE TRIGGER product_marketing_cited_content_hypotheses_append_only_delete
    BEFORE DELETE ON product_marketing_plan_cited_content_hypotheses
    FOR EACH ROW EXECUTE FUNCTION product_marketing_plan_citations_append_only();

-- ---------------------------------------------------------------------------
-- THE SCOPE FENCES — every citation stays inside its scope (the
-- migration-058 discipline; all anchored authority tables read
-- CHECK-ONLY, never written here)
-- ---------------------------------------------------------------------------

-- Product-context citations (inputs/facts/models/risk flags): the cited
-- record must belong to the SAME product context as the plan version.
-- Each citation table gets its own explicit fence (the migration-058
-- explicit-per-table pattern).

CREATE OR REPLACE FUNCTION product_marketing_cited_product_inputs_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_plan_context  uuid;
    v_input_context uuid;
BEGIN
    SELECT pv.product_context_id INTO v_plan_context
      FROM product_marketing_plan_versions pv
     WHERE pv.product_marketing_plan_version_id = NEW.product_marketing_plan_version_id;
    SELECT pcv.product_context_id INTO v_input_context
      FROM product_context_inputs pci
      JOIN product_context_versions pcv ON pcv.product_context_version_id = pci.product_context_version_id
     WHERE pci.input_id = NEW.input_id;
    IF v_plan_context IS NULL OR v_input_context IS NULL
       OR v_plan_context <> v_input_context THEN
        RAISE EXCEPTION 'product marketing plan product-input citation %→% crosses the product-context boundary — input citations stay inside the cited product context',
            NEW.product_marketing_plan_version_id, NEW.input_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_marketing_cited_product_inputs_scope_trigger ON product_marketing_plan_cited_product_inputs;
CREATE TRIGGER product_marketing_cited_product_inputs_scope_trigger
    BEFORE INSERT ON product_marketing_plan_cited_product_inputs
    FOR EACH ROW EXECUTE FUNCTION product_marketing_cited_product_inputs_scope_consistent();

CREATE OR REPLACE FUNCTION product_marketing_cited_product_facts_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_plan_context  uuid;
    v_fact_context  uuid;
BEGIN
    SELECT pv.product_context_id INTO v_plan_context
      FROM product_marketing_plan_versions pv
     WHERE pv.product_marketing_plan_version_id = NEW.product_marketing_plan_version_id;
    SELECT product_context_id INTO v_fact_context
      FROM product_source_facts WHERE source_fact_id = NEW.source_fact_id;
    IF v_plan_context IS NULL OR v_fact_context IS NULL
       OR v_plan_context <> v_fact_context THEN
        RAISE EXCEPTION 'product marketing plan product-fact citation %→% crosses the product-context boundary — fact citations stay inside the cited product context',
            NEW.product_marketing_plan_version_id, NEW.source_fact_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_marketing_cited_product_facts_scope_trigger ON product_marketing_plan_cited_product_facts;
CREATE TRIGGER product_marketing_cited_product_facts_scope_trigger
    BEFORE INSERT ON product_marketing_plan_cited_product_facts
    FOR EACH ROW EXECUTE FUNCTION product_marketing_cited_product_facts_scope_consistent();

CREATE OR REPLACE FUNCTION product_marketing_cited_product_models_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_plan_context   uuid;
    v_model_context  uuid;
BEGIN
    SELECT pv.product_context_id INTO v_plan_context
      FROM product_marketing_plan_versions pv
     WHERE pv.product_marketing_plan_version_id = NEW.product_marketing_plan_version_id;
    SELECT product_context_id INTO v_model_context
      FROM product_derived_models WHERE derived_model_id = NEW.derived_model_id;
    IF v_plan_context IS NULL OR v_model_context IS NULL
       OR v_plan_context <> v_model_context THEN
        RAISE EXCEPTION 'product marketing plan product-model citation %→% crosses the product-context boundary — model citations stay inside the cited product context',
            NEW.product_marketing_plan_version_id, NEW.derived_model_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_marketing_cited_product_models_scope_trigger ON product_marketing_plan_cited_product_models;
CREATE TRIGGER product_marketing_cited_product_models_scope_trigger
    BEFORE INSERT ON product_marketing_plan_cited_product_models
    FOR EACH ROW EXECUTE FUNCTION product_marketing_cited_product_models_scope_consistent();

CREATE OR REPLACE FUNCTION product_marketing_cited_product_risk_flags_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_plan_context  uuid;
    v_flag_context  uuid;
BEGIN
    SELECT pv.product_context_id INTO v_plan_context
      FROM product_marketing_plan_versions pv
     WHERE pv.product_marketing_plan_version_id = NEW.product_marketing_plan_version_id;
    SELECT product_context_id INTO v_flag_context
      FROM product_risk_flags WHERE risk_flag_id = NEW.risk_flag_id;
    IF v_plan_context IS NULL OR v_flag_context IS NULL
       OR v_plan_context <> v_flag_context THEN
        RAISE EXCEPTION 'product marketing plan risk-flag citation %→% crosses the product-context boundary — risk-flag citations stay inside the cited product context',
            NEW.product_marketing_plan_version_id, NEW.risk_flag_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_marketing_cited_product_risk_flags_scope_trigger ON product_marketing_plan_cited_product_risk_flags;
CREATE TRIGGER product_marketing_cited_product_risk_flags_scope_trigger
    BEFORE INSERT ON product_marketing_plan_cited_product_risk_flags
    FOR EACH ROW EXECUTE FUNCTION product_marketing_cited_product_risk_flags_scope_consistent();

-- Research-insight citations: the cited insight must belong to the SAME
-- research session as the plan version (and the version must actually
-- carry one).
CREATE OR REPLACE FUNCTION product_marketing_cited_research_insights_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_plan_session    uuid;
    v_insight_session uuid;
BEGIN
    SELECT pv.research_session_id INTO v_plan_session
      FROM product_marketing_plan_versions pv
     WHERE pv.product_marketing_plan_version_id = NEW.product_marketing_plan_version_id;
    SELECT research_session_id INTO v_insight_session
      FROM research_insights WHERE research_insight_id = NEW.research_insight_id;
    IF v_plan_session IS NULL OR v_insight_session IS NULL
       OR v_plan_session <> v_insight_session THEN
        RAISE EXCEPTION 'product marketing plan research-insight citation %→% crosses the research-session boundary — insight citations stay inside the cited research session',
            NEW.product_marketing_plan_version_id, NEW.research_insight_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_marketing_cited_research_insights_scope_trigger ON product_marketing_plan_cited_research_insights;
CREATE TRIGGER product_marketing_cited_research_insights_scope_trigger
    BEFORE INSERT ON product_marketing_plan_cited_research_insights
    FOR EACH ROW EXECUTE FUNCTION product_marketing_cited_research_insights_scope_consistent();

-- Client-scoped citations (platform-health evaluations, experiment
-- analyses, allocation recommendations, content hypotheses): the cited
-- record must belong to the SAME client as the plan.
CREATE OR REPLACE FUNCTION product_marketing_cited_platform_health_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_plan_client      uuid;
    v_evaluation_client uuid;
BEGIN
    SELECT p.client_id INTO v_plan_client
      FROM product_marketing_plans p
      JOIN product_marketing_plan_versions pv ON pv.product_marketing_plan_id = p.product_marketing_plan_id
     WHERE pv.product_marketing_plan_version_id = NEW.product_marketing_plan_version_id;
    SELECT client_id INTO v_evaluation_client
      FROM platform_health_evaluations WHERE platform_health_evaluation_id = NEW.platform_health_evaluation_id;
    IF v_plan_client IS NULL OR v_evaluation_client IS NULL
       OR v_plan_client <> v_evaluation_client THEN
        RAISE EXCEPTION 'product marketing plan platform-health citation %→% crosses the client boundary — health-verdict citations stay inside one client',
            NEW.product_marketing_plan_version_id, NEW.platform_health_evaluation_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_marketing_cited_platform_health_scope_trigger ON product_marketing_plan_cited_platform_health_evaluations;
CREATE TRIGGER product_marketing_cited_platform_health_scope_trigger
    BEFORE INSERT ON product_marketing_plan_cited_platform_health_evaluations
    FOR EACH ROW EXECUTE FUNCTION product_marketing_cited_platform_health_scope_consistent();

CREATE OR REPLACE FUNCTION product_marketing_cited_experiment_analyses_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_plan_client    uuid;
    v_analysis_client uuid;
BEGIN
    SELECT p.client_id INTO v_plan_client
      FROM product_marketing_plans p
      JOIN product_marketing_plan_versions pv ON pv.product_marketing_plan_id = p.product_marketing_plan_id
     WHERE pv.product_marketing_plan_version_id = NEW.product_marketing_plan_version_id;
    SELECT client_id INTO v_analysis_client
      FROM experiment_analysis_records WHERE analysis_id = NEW.analysis_id;
    IF v_plan_client IS NULL OR v_analysis_client IS NULL
       OR v_plan_client <> v_analysis_client THEN
        RAISE EXCEPTION 'product marketing plan experiment-analysis citation %→% crosses the client boundary — analysis citations stay inside one client',
            NEW.product_marketing_plan_version_id, NEW.analysis_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_marketing_cited_experiment_analyses_scope_trigger ON product_marketing_plan_cited_experiment_analyses;
CREATE TRIGGER product_marketing_cited_experiment_analyses_scope_trigger
    BEFORE INSERT ON product_marketing_plan_cited_experiment_analyses
    FOR EACH ROW EXECUTE FUNCTION product_marketing_cited_experiment_analyses_scope_consistent();

CREATE OR REPLACE FUNCTION product_marketing_cited_allocation_recommendations_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_plan_client          uuid;
    v_recommendation_client uuid;
BEGIN
    SELECT p.client_id INTO v_plan_client
      FROM product_marketing_plans p
      JOIN product_marketing_plan_versions pv ON pv.product_marketing_plan_id = p.product_marketing_plan_id
     WHERE pv.product_marketing_plan_version_id = NEW.product_marketing_plan_version_id;
    SELECT client_id INTO v_recommendation_client
      FROM experiment_allocation_recommendations WHERE recommendation_id = NEW.recommendation_id;
    IF v_plan_client IS NULL OR v_recommendation_client IS NULL
       OR v_plan_client <> v_recommendation_client THEN
        RAISE EXCEPTION 'product marketing plan allocation-recommendation citation %→% crosses the client boundary — recommendation citations stay inside one client',
            NEW.product_marketing_plan_version_id, NEW.recommendation_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_marketing_cited_allocation_recommendations_scope_trigger ON product_marketing_plan_cited_allocation_recommendations;
CREATE TRIGGER product_marketing_cited_allocation_recommendations_scope_trigger
    BEFORE INSERT ON product_marketing_plan_cited_allocation_recommendations
    FOR EACH ROW EXECUTE FUNCTION product_marketing_cited_allocation_recommendations_scope_consistent();

CREATE OR REPLACE FUNCTION product_marketing_cited_content_hypotheses_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_plan_client      uuid;
    v_hypothesis_client uuid;
BEGIN
    SELECT p.client_id INTO v_plan_client
      FROM product_marketing_plans p
      JOIN product_marketing_plan_versions pv ON pv.product_marketing_plan_id = p.product_marketing_plan_id
     WHERE pv.product_marketing_plan_version_id = NEW.product_marketing_plan_version_id;
    SELECT client_id INTO v_hypothesis_client
      FROM content_hypotheses WHERE content_hypothesis_id = NEW.content_hypothesis_id;
    IF v_plan_client IS NULL OR v_hypothesis_client IS NULL
       OR v_plan_client <> v_hypothesis_client THEN
        RAISE EXCEPTION 'product marketing plan content-hypothesis citation %→% crosses the client boundary — hypothesis citations stay inside one client',
            NEW.product_marketing_plan_version_id, NEW.content_hypothesis_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_marketing_cited_content_hypotheses_scope_trigger ON product_marketing_plan_cited_content_hypotheses;
CREATE TRIGGER product_marketing_cited_content_hypotheses_scope_trigger
    BEFORE INSERT ON product_marketing_plan_cited_content_hypotheses
    FOR EACH ROW EXECUTE FUNCTION product_marketing_cited_content_hypotheses_scope_consistent();
