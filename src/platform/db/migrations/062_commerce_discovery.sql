-- 062_commerce_discovery.sql — MKT-072 (Commerce Discovery
-- Mission).
--
-- The COMMERCE DISCOVERY MISSION authority (spec/effective-backlog-v1.6.md
-- MKT-072: "discover viable products/niches, test demand via social
-- experiments, recommend listing candidates and learn from actual orders.
-- Acceptance: market → candidate → content → traffic → order → learning
-- golden path with economic guardrails."; spec/architecture-v1.6.md §15
-- "Commerce loop", §16 "Attribution", §17 "Budget and quota"; the frozen
-- v1.6 matrix row, VERBATIM:
-- /commerce-discovery → /growth-missions, /product-intelligence,
-- /content-intelligence, /experiment-analysis, /integrations,
-- /platform-health):
--
--   commerce_discovery_missions                        → the AGENCY-SCOPED
--                                                     discovery-mission
--                                                     headers (ONE per
--                                                     growth mission — the
--                                                     mission authority
--                                                     MKT-053 stays the
--                                                     mission DATA MODEL;
--                                                     this module never
--                                                     becomes a second
--                                                     mission authority);
--                                                     the frozen discovery
--                                                     lifecycle state +
--                                                     the CAS token;
--   commerce_discovery_mission_versions               → the APPEND-ONLY
--                                                     version tail (the
--                                                     DECLARED bounded-spend
--                                                     budget fields — the
--                                                     MKT-054 budget
--                                                     convention — plus the
--                                                     DETERMINISTIC derived
--                                                     selection/candidate-
--                                                     proposal/demand-test-
--                                                     plan/economic-gate
--                                                     blocks, the input
--                                                     snapshot + the
--                                                     deterministic input
--                                                     digest — the
--                                                     idempotent-recompose
--                                                     anchor);
--   commerce_discovery_events                         → the APPEND-ONLY
--                                                     history tail (every
--                                                     state transition and
--                                                     operational append
--                                                     carries actor +
--                                                     provenance + a
--                                                     REQUIRED reason);
--   commerce_discovery_candidates                     → the APPEND-ONLY
--                                                     product/listing
--                                                     candidate records
--                                                     (the provenance-cited
--                                                     proposals being
--                                                     pursued, with the
--                                                     demand-test hypothesis
--                                                     and the declared
--                                                     estimated economics);
--   commerce_discovery_demand_tests                   → the demand-test
--                                                     arm records (born
--                                                     'launched' with the
--                                                     FK-anchored experiment
--                                                     reference created
--                                                     through the EXISTING
--                                                     /experiments authority
--                                                     + the RECORDED test
--                                                     spend bookkeeping;
--                                                     the SINGLE guarded
--                                                     launched→concluded
--                                                     advance);
--   commerce_discovery_outcomes                       → the APPEND-ONLY
--                                                     learning-loop outcome
--                                                     records (the observed
--                                                     order counts/values
--                                                     DERIVED from the real
--                                                     MKT-071 commerce
--                                                     events + the viability
--                                                     verdict evaluated
--                                                     against the declared
--                                                     economic gates + the
--                                                     listing recommendation
--                                                     AS DATA);
--   commerce_discovery_guardrail_evaluations          → the APPEND-ONLY
--                                                     economic-guardrail
--                                                     evaluation records
--                                                     (the declared bounds
--                                                     vs the REAL observed
--                                                     spend/count values,
--                                                     the verdict, the
--                                                     breach reason codes,
--                                                     the cited policy
--                                                     context and the cited
--                                                     observations);
--   the THIRTEEN citation link tables                 → the FK-anchored
--                                                     scope-fenced citation
--                                                     basis of the versions,
--                                                     candidates, outcomes
--                                                     and evaluations.
--
-- Key fences:
--
-- * CHECK-fenced vocabularies on every enumerated column: the discovery
--   lifecycle states (active / guardrail_blocked / concluded /
--   stopped_by_user), the event kinds, the demand-test states
--   (launched / concluded), the guardrail verdicts (within_bounds /
--   breached), the breach reason codes, the viability verdicts, the
--   listing recommendations and the strategy version string (cd-plan-v1).
--   The derived selection/candidate-proposal/demand-test-plan/economic-
--   gates/decisions blocks and the observed order-value maps are bounded
--   jsonb (the house jsonb precedent — the module guards are the fence and
--   the boundary tests pin the vocabularies).
-- * THE BOUNDED-SPEND DECLARATIONS (the acceptance's core): every version
--   row carries spend_currency (bounded text), test_budget_minor_units
--   (integer 0..2000000000), max_demand_tests (integer 1..50) and
--   min_order_count_for_viability (integer 1..1000) — honest seams,
--   fail-closed (the module refuses demand-test launches without a
--   current version and refuses launches that would exceed the declared
--   budget/test-count bounds).
-- * THE APPEND-ONLY TAILS: mission versions, history events, candidates,
--   outcomes, guardrail evaluations and EVERY citation link reject UPDATE
--   and DELETE outright — corrections are NEW records; history is never
--   rewritten (the migration-045/052/058/060 pattern). The demand-test
--   rows allow EXACTLY ONE guarded advance (launched → concluded — the
--   migration-050/063 single-terminal-advance discipline; any other
--   UPDATE is rejected). The mission HEADER is the one mutable row family
--   (the lifecycle state + the version-tail pointer + the CAS token —
--   exactly the growth_missions discipline).
-- * THE SCOPE FENCES: every cross-module FK link is scope-consistent —
--   product-derived-model citations stay inside the cited product
--   context; content-candidate/content-hypothesis citations, platform-
--   health citations, experiment-analysis citations and metric-observation
--   citations stay inside the discovery mission's Client; commerce-event
--   citations stay inside the declared store connection's events (the
--   learning loop learns from ITS store's orders); policy-version
--   citations stay on the mission's scope chain (platform / same agency /
--   same client); the demand test's experiment stays inside the discovery
--   mission's Client (a discovery mission's demand tests ARE experiments
--   through the authority — same-client only). All anchored authority
--   tables are read CHECK-ONLY.
-- * NO AUTHORITY TRANSFER: this migration creates NO mission, goal,
--   product-context, content-candidate, content-hypothesis, health-
--   evaluation, analysis, experiment, metric-observation, commerce-event,
--   connection, policy, account or tenant table — the module COMPOSES the
--   consumed public contracts READ-ONLY and cites their records by
--   reference (the platform-health evaluation-record discipline). The
--   mission FK anchor keeps a dangling mission reference from persisting.
-- * NO SECOND ORDER/INVENTORY AUTHORITY (lock rules 32/33): no catalog,
--   order, listing, price or inventory table exists anywhere in this
--   migration; the listing recommendation is DATA; store mutations flow
--   through Integrations and never through this module.
-- * NO SECOND EXPERIMENT ENGINE: the demand tests reference the
--   /experiments authority's rows by FK anchor; no experiment lifecycle
--   table exists here.
-- * NO SECOND WORKFLOW/EXECUTION ENGINE: no job, queue, worker, timer or
--   scheduler table exists anywhere in this migration (the Growth
--   Operator MKT-054 owns the bounded delegation).
-- * NO SECRET MATERIAL ANYWHERE (CRED-001/§21): the only structured
--   payload columns are the bounded plan/observed blocks — there is
--   deliberately NO column capable of holding secret material.
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, append-oriented tails. No owner/role/user columns beyond
-- provenance: agency-scope authorization stays exactly the
-- route-layer authority — no second tenant, permission or identity
-- authority.

-- ---------------------------------------------------------------------------
-- commerce_discovery_missions — the agency-scoped discovery-mission
-- headers (ONE per growth mission; the lifecycle state + the version-tail
-- pointer + the CAS token)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS commerce_discovery_missions (
    commerce_discovery_mission_id  uuid        PRIMARY KEY,
    -- The GROWTH MISSION this discovery program rides (the MKT-053
    -- authority stays sole — the FK anchor keeps a dangling mission
    -- reference from persisting; the mission's declared objective family
    -- must be 'commerce_discovery', enforced at the module layer).
    mission_id                     uuid        NOT NULL REFERENCES growth_missions(mission_id),
    -- ONE discovery program per mission (corrections are NEW versions of
    -- the SAME program).
    CONSTRAINT commerce_discovery_missions_mission_uniq UNIQUE (mission_id),
    agency_id                      uuid        NOT NULL REFERENCES agencies(agency_id),
    -- The PURSUIT CLIENT (derived server-side from the pursuit workspace
    -- through the canonical ownership chain — the content-intelligence /
    -- platform-health / experiment-analysis / metrics / commerce-event
    -- surfaces are client-scoped; the FK anchor is the backstop).
    client_id                      uuid        NOT NULL REFERENCES clients(client_id),
    -- The pursuit workspace narrowing (carried as data; NULL = the client
    -- root scope).
    workspace_id                   uuid        REFERENCES workspaces(workspace_id),
    -- The frozen discovery lifecycle state (cd-vocab-v1). 'guardrail_blocked'
    -- is the honest blocked state an economic-guardrail breach produces;
    -- 'concluded' and 'stopped_by_user' are terminal (no outgoing
    -- transitions — the module's transition table + the trigger backstop).
    status                         text        NOT NULL
                                               CHECK (status IN ('active',
                                                                 'guardrail_blocked',
                                                                 'concluded',
                                                                 'stopped_by_user')),
    -- The version-tail pointer (only ever ADVANCES; the current declared
    -- bounded-spend budget + derived plan).
    current_version_seq            integer     NOT NULL CHECK (current_version_seq >= 1),
    -- The CAS token (row-locked lifecycle transitions).
    version                        integer     NOT NULL CHECK (version >= 1),
    created_actor                  text        NOT NULL
                                               CHECK (length(created_actor) >= 1 AND length(created_actor) <= 100),
    created_at                     timestamptz NOT NULL,
    updated_at                     timestamptz NOT NULL
);

-- The agency's discovery programs (the per-agency read).
CREATE INDEX IF NOT EXISTS commerce_discovery_missions_agency_idx
    ON commerce_discovery_missions (agency_id, created_at, commerce_discovery_mission_id);

-- ---------------------------------------------------------------------------
-- commerce_discovery_mission_versions — the APPEND-ONLY version tail (the
-- declared bounded-spend budget + the deterministic derived plan blocks)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS commerce_discovery_mission_versions (
    commerce_discovery_mission_version_id  uuid        PRIMARY KEY,
    commerce_discovery_mission_id          uuid        NOT NULL REFERENCES commerce_discovery_missions(commerce_discovery_mission_id),
    -- Gapless per-program sequence (assigned under the mission row lock).
    version_seq                            integer     NOT NULL CHECK (version_seq >= 1),
    CONSTRAINT commerce_discovery_mission_versions_seq_uniq
        UNIQUE (commerce_discovery_mission_id, version_seq),
    -- The cited /product-intelligence Product Context (the product/market
    -- grounding of this selection — the FK anchor).
    product_context_id                     uuid        NOT NULL REFERENCES product_contexts(product_context_id),
    -- The product context version the selection was computed against
    -- (carried as data inside the input snapshot; the id column is the
    -- anchor).
    product_context_version_id             uuid        NOT NULL REFERENCES product_context_versions(product_context_version_id),
    -- The DECLARED STORE CONNECTION (the commerce boundary anchor this
    -- program's learning loop reads order events through — validated
    -- same-client through the /integrations ownership contract at the
    -- module layer; the FK anchor is the backstop).
    store_connection_id                    uuid        NOT NULL REFERENCES integration_connections(connection_id),
    -- ------------------- THE BOUNDED-SPEND DECLARATIONS -------------------
    -- (the MKT-054 budget convention: honest seams, fail-closed)
    -- The currency of the declared budget and of every recorded demand-test
    -- spend (no FX/decimal-convention authority exists — a spend in another
    -- currency is honestly refused, never silently converted).
    spend_currency                         text        NOT NULL
                                                           CHECK (length(spend_currency) >= 3 AND length(spend_currency) <= 8),
    -- The total demand-test spend bound, in the declared currency's MINOR
    -- units (integer — no decimal-convention invention; 0 = a zero-budget
    -- program that may still record candidates and observations).
    test_budget_minor_units                integer     NOT NULL
                                                           CHECK (test_budget_minor_units >= 0 AND test_budget_minor_units <= 2000000000),
    -- The maximum number of demand tests this program may launch.
    max_demand_tests                       integer     NOT NULL
                                                           CHECK (max_demand_tests >= 1 AND max_demand_tests <= 50),
    -- The economic viability gate: the minimum DISTINCT observed order
    -- count for a candidate to become viable (§15: "A candidate becomes
    -- viable only when it passes the mission's explicit economic and
    -- operational gates.").
    min_order_count_for_viability          integer     NOT NULL
                                                           CHECK (min_order_count_for_viability >= 1 AND min_order_count_for_viability <= 1000),
    -- -----------------------------------------------------------------------
    -- The REQUIRED reason every version carries (the honest correction
    -- record — actor + provenance + reason).
    reason                                 text        NOT NULL
                                                           CHECK (length(reason) >= 1 AND length(reason) <= 4000),
    -- The DETERMINISTIC INPUT SNAPSHOT (the reproducibility anchor: which
    -- mission version, product-context version, candidate/hypothesis/
    -- evaluation/analysis ids and goal references the pure core consumed —
    -- bounded jsonb object).
    input_snapshot                         jsonb       NOT NULL DEFAULT '{}'::jsonb
                                                           CHECK (jsonb_typeof(input_snapshot) = 'object'),
    -- The deterministic input digest (the idempotent-recompose anchor: the
    -- same observable world + the same declared bounds → the same digest →
    -- the honest replay convergence, never a duplicate version).
    input_digest                           text        NOT NULL
                                                           CHECK (length(input_digest) >= 1 AND length(input_digest) <= 500),
    -- The derived MARKET/NICHE SELECTION (the auditable ranked rows: the
    -- niche, the deterministic score, the rationale, the citation trail).
    niche_selection                        jsonb       NOT NULL DEFAULT '[]'::jsonb
                                                           CHECK (jsonb_typeof(niche_selection) = 'array')
                                                           CHECK (jsonb_array_length(niche_selection) <= 16),
    -- The derived LISTING-CANDIDATE PROPOSALS (recommendations as DATA —
    -- never an auto-listing).
    candidate_proposals                    jsonb       NOT NULL DEFAULT '[]'::jsonb
                                                           CHECK (jsonb_typeof(candidate_proposals) = 'array')
                                                           CHECK (jsonb_array_length(candidate_proposals) <= 32),
    -- The derived DEMAND-TEST PLAN (the experiment design template the
    -- demand-test arm instantiates through the /experiments authority).
    demand_test_plan                       jsonb       NOT NULL DEFAULT '{}'::jsonb
                                                           CHECK (jsonb_typeof(demand_test_plan) = 'object'),
    -- The composed ECONOMIC GATES (the declared bounds as the evaluation
    -- contract).
    economic_gates                         jsonb       NOT NULL DEFAULT '{}'::jsonb
                                                           CHECK (jsonb_typeof(economic_gates) = 'object'),
    -- The auditable DECISION entries of the selection core.
    decisions                              jsonb       NOT NULL DEFAULT '[]'::jsonb
                                                           CHECK (jsonb_typeof(decisions) = 'array')
                                                           CHECK (jsonb_array_length(decisions) <= 64),
    strategy_version                       text        NOT NULL
                                                           CHECK (strategy_version = 'cd-plan-v1'),
    recorded_actor                         text        NOT NULL
                                                           CHECK (length(recorded_actor) >= 1 AND length(recorded_actor) <= 100),
    recorded_via                           text        NOT NULL
                                                           CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 100),
    correlation_id                         text        NOT NULL
                                                           CHECK (length(correlation_id) >= 1 AND length(correlation_id) <= 100),
    causation_id                           text,
    created_at                             timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS commerce_discovery_mission_versions_mission_idx
    ON commerce_discovery_mission_versions (commerce_discovery_mission_id, version_seq);

-- The append-only fence: versions reject UPDATE and DELETE outright.
CREATE OR REPLACE FUNCTION commerce_discovery_mission_versions_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'commerce discovery mission versions are append-only — corrections are NEW version records (version % of program %)',
        OLD.version_seq, OLD.commerce_discovery_mission_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_discovery_mission_versions_append_only_update_trigger ON commerce_discovery_mission_versions;
CREATE TRIGGER commerce_discovery_mission_versions_append_only_update_trigger
    BEFORE UPDATE ON commerce_discovery_mission_versions
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_mission_versions_append_only();
DROP TRIGGER IF EXISTS commerce_discovery_mission_versions_append_only_delete_trigger ON commerce_discovery_mission_versions;
CREATE TRIGGER commerce_discovery_mission_versions_append_only_delete_trigger
    BEFORE DELETE ON commerce_discovery_mission_versions
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_mission_versions_append_only();

-- ---------------------------------------------------------------------------
-- commerce_discovery_events — the APPEND-ONLY history tail (actor +
-- provenance + the REQUIRED reason on every transition/append)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS commerce_discovery_events (
    commerce_discovery_event_id    uuid        PRIMARY KEY,
    commerce_discovery_mission_id  uuid        NOT NULL REFERENCES commerce_discovery_missions(commerce_discovery_mission_id),
    -- Gapless per-program sequence (assigned under the mission row lock).
    event_seq                      integer     NOT NULL CHECK (event_seq >= 1),
    CONSTRAINT commerce_discovery_events_seq_uniq
        UNIQUE (commerce_discovery_mission_id, event_seq),
    -- The closed event-kind vocabulary (cd-vocab-v1).
    event_kind                     text        NOT NULL
                                                  CHECK (event_kind IN ('discovery_created',
                                                                        'version_recorded',
                                                                        'state_transition',
                                                                        'candidate_recorded',
                                                                        'demand_test_launched',
                                                                        'demand_test_concluded',
                                                                        'outcome_recorded',
                                                                        'guardrail_evaluated',
                                                                        'guardrail_resolved')),
    -- The lifecycle transition context (null on non-transition events).
    from_status                    text
                                    CHECK (from_status IS NULL OR from_status IN ('active',
                                                                                  'guardrail_blocked',
                                                                                  'concluded',
                                                                                  'stopped_by_user')),
    to_status                      text
                                    CHECK (to_status IS NULL OR to_status IN ('active',
                                                                              'guardrail_blocked',
                                                                              'concluded',
                                                                              'stopped_by_user')),
    -- The REQUIRED reason every event carries (bounded, honest).
    reason                         text        NOT NULL
                                                  CHECK (length(reason) >= 1 AND length(reason) <= 4000),
    -- The kind-specific structured detail (bounded jsonb object; never prose).
    detail                         jsonb       NOT NULL DEFAULT '{}'::jsonb
                                                  CHECK (jsonb_typeof(detail) = 'object'),
    recorded_actor                 text        NOT NULL
                                                  CHECK (length(recorded_actor) >= 1 AND length(recorded_actor) <= 100),
    recorded_via                   text        NOT NULL
                                                  CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 100),
    correlation_id                 text        NOT NULL
                                                  CHECK (length(correlation_id) >= 1 AND length(correlation_id) <= 100),
    causation_id                   text,
    created_at                     timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS commerce_discovery_events_mission_idx
    ON commerce_discovery_events (commerce_discovery_mission_id, event_seq);

-- The append-only fence: history events reject UPDATE and DELETE outright.
CREATE OR REPLACE FUNCTION commerce_discovery_events_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'commerce discovery events are append-only — history is never rewritten (event % of program %)',
        OLD.event_seq, OLD.commerce_discovery_mission_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_discovery_events_append_only_update_trigger ON commerce_discovery_events;
CREATE TRIGGER commerce_discovery_events_append_only_update_trigger
    BEFORE UPDATE ON commerce_discovery_events
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_events_append_only();
DROP TRIGGER IF EXISTS commerce_discovery_events_append_only_delete_trigger ON commerce_discovery_events;
CREATE TRIGGER commerce_discovery_events_append_only_delete_trigger
    BEFORE DELETE ON commerce_discovery_events
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_events_append_only();

-- ---------------------------------------------------------------------------
-- commerce_discovery_candidates — the APPEND-ONLY product/listing
-- candidate records (provenance-cited; the demand-test hypothesis;
-- the declared estimated economics)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS commerce_discovery_candidates (
    commerce_discovery_candidate_id  uuid        PRIMARY KEY,
    commerce_discovery_mission_id    uuid        NOT NULL REFERENCES commerce_discovery_missions(commerce_discovery_mission_id),
    mission_id                       uuid        NOT NULL REFERENCES growth_missions(mission_id),
    agency_id                        uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id                        uuid        NOT NULL REFERENCES clients(client_id),
    -- The bounded candidate descriptor (declared data).
    label                            text        NOT NULL
                                                   CHECK (length(label) >= 1 AND length(label) <= 200),
    niche                            text        NOT NULL
                                                   CHECK (length(niche) >= 1 AND length(niche) <= 200),
    sub_niche                        text
                                       CHECK (sub_niche IS NULL OR (length(sub_niche) >= 1 AND length(sub_niche) <= 200)),
    product_descriptor               text        NOT NULL
                                                   CHECK (length(product_descriptor) >= 1 AND length(product_descriptor) <= 2000),
    -- The DECLARED ESTIMATED ECONOMICS (data toward the human listing
    -- decision — never a guardrail input, never a fabricated actual).
    estimated_cost_minor_units       integer     NOT NULL
                                                   CHECK (estimated_cost_minor_units >= 0 AND estimated_cost_minor_units <= 2000000000),
    estimated_price_minor_units      integer     NOT NULL
                                                   CHECK (estimated_price_minor_units >= 0 AND estimated_price_minor_units <= 2000000000),
    economics_currency               text        NOT NULL
                                                   CHECK (length(economics_currency) >= 3 AND length(economics_currency) <= 8),
    -- The REQUIRED demand-test hypothesis (every candidate carries its
    -- hypothesis — the input to the /experiments authority, never a
    -- conclusion; observed competitor/platform performance does NOT by
    -- itself establish causality for the user's account).
    demand_hypothesis                text        NOT NULL
                                                   CHECK (length(demand_hypothesis) >= 1 AND length(demand_hypothesis) <= 2000),
    recorded_actor                   text        NOT NULL
                                                   CHECK (length(recorded_actor) >= 1 AND length(recorded_actor) <= 100),
    recorded_via                     text        NOT NULL
                                                   CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 100),
    correlation_id                   text        NOT NULL
                                                   CHECK (length(correlation_id) >= 1 AND length(correlation_id) <= 100),
    causation_id                     text,
    created_at                       timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS commerce_discovery_candidates_mission_idx
    ON commerce_discovery_candidates (commerce_discovery_mission_id, created_at, commerce_discovery_candidate_id);

-- The append-only fence: candidates reject UPDATE and DELETE outright (a
-- new observation of the same product angle is a NEW candidate record).
CREATE OR REPLACE FUNCTION commerce_discovery_candidates_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'commerce discovery candidates are append-only — a new observation is a NEW candidate record (candidate %)',
        OLD.commerce_discovery_candidate_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_discovery_candidates_append_only_update_trigger ON commerce_discovery_candidates;
CREATE TRIGGER commerce_discovery_candidates_append_only_update_trigger
    BEFORE UPDATE ON commerce_discovery_candidates
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_candidates_append_only();
DROP TRIGGER IF EXISTS commerce_discovery_candidates_append_only_delete_trigger ON commerce_discovery_candidates;
CREATE TRIGGER commerce_discovery_candidates_append_only_delete_trigger
    BEFORE DELETE ON commerce_discovery_candidates
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_candidates_append_only();

-- ---------------------------------------------------------------------------
-- commerce_discovery_demand_tests — the demand-test arm records (born
-- 'launched' with the FK-anchored experiment reference + the recorded
-- spend; the SINGLE guarded launched→concluded advance)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS commerce_discovery_demand_tests (
    commerce_discovery_demand_test_id  uuid        PRIMARY KEY,
    commerce_discovery_mission_id      uuid        NOT NULL REFERENCES commerce_discovery_missions(commerce_discovery_mission_id),
    commerce_discovery_candidate_id    uuid        NOT NULL REFERENCES commerce_discovery_candidates(commerce_discovery_candidate_id),
    mission_id                         uuid        NOT NULL REFERENCES growth_missions(mission_id),
    agency_id                          uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id                          uuid        NOT NULL REFERENCES clients(client_id),
    -- THE EXPERIMENT REFERENCE: a discovery mission's demand tests ARE
    -- experiments through the authority (created through the EXISTING
    -- /experiments public contract; no second experiment engine — this
    -- module owns no experiment lifecycle).
    experiment_id                      uuid        NOT NULL REFERENCES experiments(experiment_id),
    -- The RECORDED TEST SPEND bookkeeping (the honest seam: the demand
    -- test's cost is recorded as declared data with provenance; the
    -- guardrail sums these against the declared budget — same declared
    -- currency only, never converted).
    test_spend_minor_units             integer     NOT NULL
                                                      CHECK (test_spend_minor_units >= 0 AND test_spend_minor_units <= 2000000000),
    spend_currency                     text        NOT NULL
                                                      CHECK (length(spend_currency) >= 3 AND length(spend_currency) <= 8),
    -- The DERIVED experiment design this test instantiated (the auditable
    -- design payload composed through the authority — bounded jsonb).
    derived_experiment_design          jsonb       NOT NULL DEFAULT '{}'::jsonb
                                                      CHECK (jsonb_typeof(derived_experiment_design) = 'object'),
    -- The demand-test state (born 'launched'; the single conclusion
    -- advance — the guarded trigger below is the backstop).
    state                              text        NOT NULL
                                                      CHECK (state IN ('launched', 'concluded')),
    -- The conclusion read-back (set ONLY by the conclusion advance — the
    -- experiment authority's own concluded fields carried BY REFERENCE).
    conclusion_result_state            text
                                         CHECK (conclusion_result_state IS NULL
                                                OR conclusion_result_state IN ('causal_supported',
                                                                               'causal_not_supported',
                                                                               'attribution',
                                                                               'observation',
                                                                               'inconclusive')),
    conclusion_uncertainty_representation text
                                         CHECK (conclusion_uncertainty_representation IS NULL
                                                OR conclusion_uncertainty_representation IN ('interval',
                                                                                              'distribution',
                                                                                              'qualitative',
                                                                                              'none')),
    conclusion_recorded_at             timestamptz,
    recorded_actor                     text        NOT NULL
                                                      CHECK (length(recorded_actor) >= 1 AND length(recorded_actor) <= 100),
    recorded_via                       text        NOT NULL
                                                      CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 100),
    correlation_id                     text        NOT NULL
                                                      CHECK (length(correlation_id) >= 1 AND length(correlation_id) <= 100),
    causation_id                       text,
    created_at                         timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS commerce_discovery_demand_tests_mission_idx
    ON commerce_discovery_demand_tests (commerce_discovery_mission_id, created_at, commerce_discovery_demand_test_id);
CREATE INDEX IF NOT EXISTS commerce_discovery_demand_tests_experiment_idx
    ON commerce_discovery_demand_tests (experiment_id);

-- THE SINGLE GUARDED ADVANCE: a demand test may be UPDATEd exactly once —
-- the launched→concluded conclusion advance (setting the conclusion
-- read-back); every other UPDATE (and every DELETE) is rejected (the
-- migration-050/063 single-terminal-advance discipline).
CREATE OR REPLACE FUNCTION commerce_discovery_demand_tests_guarded_advance() RETURNS trigger AS $$
BEGIN
    IF OLD.state = 'launched' AND NEW.state = 'concluded'
       AND NEW.conclusion_result_state IS NOT NULL
       AND NEW.commerce_discovery_mission_id = OLD.commerce_discovery_mission_id
       AND NEW.commerce_discovery_candidate_id = OLD.commerce_discovery_candidate_id
       AND NEW.experiment_id = OLD.experiment_id
       AND NEW.test_spend_minor_units = OLD.test_spend_minor_units
       AND NEW.spend_currency = OLD.spend_currency
       AND NEW.derived_experiment_design = OLD.derived_experiment_design THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'demand test % admits exactly one guarded advance (launched → concluded with the conclusion read-back); every other mutation is rejected (was %, requested %)',
        OLD.commerce_discovery_demand_test_id, OLD.state, NEW.state;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_discovery_demand_tests_guarded_advance_trigger ON commerce_discovery_demand_tests;
CREATE TRIGGER commerce_discovery_demand_tests_guarded_advance_trigger
    BEFORE UPDATE ON commerce_discovery_demand_tests
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_demand_tests_guarded_advance();

CREATE OR REPLACE FUNCTION commerce_discovery_demand_tests_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'demand tests are never deleted (demand test %)', OLD.commerce_discovery_demand_test_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_discovery_demand_tests_no_delete_trigger ON commerce_discovery_demand_tests;
CREATE TRIGGER commerce_discovery_demand_tests_no_delete_trigger
    BEFORE DELETE ON commerce_discovery_demand_tests
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_demand_tests_no_delete();

-- ---------------------------------------------------------------------------
-- commerce_discovery_outcomes — the APPEND-ONLY learning-loop outcome
-- records (observed values DERIVED from the real commerce events; the
-- viability verdict; the listing recommendation AS DATA)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS commerce_discovery_outcomes (
    commerce_discovery_outcome_id     uuid        PRIMARY KEY,
    commerce_discovery_mission_id     uuid        NOT NULL REFERENCES commerce_discovery_missions(commerce_discovery_mission_id),
    commerce_discovery_candidate_id   uuid        NOT NULL REFERENCES commerce_discovery_candidates(commerce_discovery_candidate_id),
    mission_id                        uuid        NOT NULL REFERENCES growth_missions(mission_id),
    agency_id                         uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id                         uuid        NOT NULL REFERENCES clients(client_id),
    -- The observed DISTINCT order count (cancelled orders disclosed
    -- separately below — the honest observation, never a causal claim).
    observed_order_count              integer     NOT NULL CHECK (observed_order_count >= 0),
    observed_cancelled_order_count    integer     NOT NULL CHECK (observed_cancelled_order_count >= 0),
    -- The observed order value per currency (a bounded jsonb object of
    -- currency → value sums; NO cross-currency aggregation and NO
    -- conversion is ever performed — no FX/decimal-convention authority
    -- exists).
    observed_order_values             jsonb       NOT NULL DEFAULT '{}'::jsonb
                                                      CHECK (jsonb_typeof(observed_order_values) = 'object'),
    -- The viability verdict evaluated against the CURRENT version's
    -- declared economic gates (cd-vocab-v1).
    viability_verdict                 text        NOT NULL
                                                      CHECK (viability_verdict IN ('viable',
                                                                                   'not_viable',
                                                                                   'insufficient_observations')),
    -- The LISTING RECOMMENDATION as DATA (never an auto-listing; no store
    -- mutation verb exists anywhere in this module).
    listing_recommendation            text        NOT NULL
                                                      CHECK (listing_recommendation IN ('recommend_listing',
                                                                                        'recommend_iteration',
                                                                                        'do_not_list')),
    -- The deterministic rationale (the auditable derivation note).
    rationale                         text        NOT NULL
                                                      CHECK (length(rationale) >= 1 AND length(rationale) <= 4000),
    -- The REQUIRED reason the observation was recorded (actor +
    -- provenance + reason).
    reason                            text        NOT NULL
                                                      CHECK (length(reason) >= 1 AND length(reason) <= 4000),
    recorded_actor                    text        NOT NULL
                                                      CHECK (length(recorded_actor) >= 1 AND length(recorded_actor) <= 100),
    recorded_via                      text        NOT NULL
                                                      CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 100),
    correlation_id                    text        NOT NULL
                                                      CHECK (length(correlation_id) >= 1 AND length(correlation_id) <= 100),
    causation_id                      text,
    created_at                        timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS commerce_discovery_outcomes_mission_idx
    ON commerce_discovery_outcomes (commerce_discovery_mission_id, created_at, commerce_discovery_outcome_id);

-- The append-only fence: outcomes reject UPDATE and DELETE outright (a
-- later observation is a NEW outcome record).
CREATE OR REPLACE FUNCTION commerce_discovery_outcomes_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'commerce discovery outcomes are append-only — a later observation is a NEW outcome record (outcome %)',
        OLD.commerce_discovery_outcome_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_discovery_outcomes_append_only_update_trigger ON commerce_discovery_outcomes;
CREATE TRIGGER commerce_discovery_outcomes_append_only_update_trigger
    BEFORE UPDATE ON commerce_discovery_outcomes
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_outcomes_append_only();
DROP TRIGGER IF EXISTS commerce_discovery_outcomes_append_only_delete_trigger ON commerce_discovery_outcomes;
CREATE TRIGGER commerce_discovery_outcomes_append_only_delete_trigger
    BEFORE DELETE ON commerce_discovery_outcomes
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_outcomes_append_only();

-- ---------------------------------------------------------------------------
-- commerce_discovery_guardrail_evaluations — the APPEND-ONLY economic-
-- guardrail evaluation records (the declared bounds vs the REAL observed
-- values; the verdict; the breach reason codes)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS commerce_discovery_guardrail_evaluations (
    commerce_discovery_evaluation_id    uuid        PRIMARY KEY,
    commerce_discovery_mission_id       uuid        NOT NULL REFERENCES commerce_discovery_missions(commerce_discovery_mission_id),
    mission_id                          uuid        NOT NULL REFERENCES growth_missions(mission_id),
    agency_id                           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id                           uuid        NOT NULL REFERENCES clients(client_id),
    -- The evaluated DECLARED bounds (copied from the current version — the
    -- reproducibility anchor: WHICH bounds produced this verdict).
    evaluated_spend_currency            text        NOT NULL
                                                       CHECK (length(evaluated_spend_currency) >= 3 AND length(evaluated_spend_currency) <= 8),
    evaluated_test_budget_minor_units   integer     NOT NULL
                                                       CHECK (evaluated_test_budget_minor_units >= 0),
    evaluated_max_demand_tests          integer     NOT NULL
                                                       CHECK (evaluated_max_demand_tests >= 1),
    -- The REAL observed values (derived from the demand-test spend
    -- bookkeeping + the commerce-event projections — never caller input).
    observed_spend_minor_units          integer     NOT NULL CHECK (observed_spend_minor_units >= 0),
    observed_demand_test_count          integer     NOT NULL CHECK (observed_demand_test_count >= 0),
    observed_order_count                integer     NOT NULL CHECK (observed_order_count >= 0),
    -- The verdict (cd-guardrails-v1): a breach produces the honest
    -- 'guardrail_blocked' state at the module layer — never a silent
    -- continue.
    verdict                             text        NOT NULL
                                                       CHECK (verdict IN ('within_bounds', 'breached')),
    -- The closed breach-reason vocabulary (empty on within_bounds).
    breach_reasons                      jsonb       NOT NULL DEFAULT '[]'::jsonb
                                                       CHECK (jsonb_typeof(breach_reasons) = 'array')
                                                       CHECK (jsonb_array_length(breach_reasons) <= 8),
    -- The deterministic rationale (the auditable evaluation note).
    rationale                           text        NOT NULL
                                                       CHECK (length(rationale) >= 1 AND length(rationale) <= 4000),
    -- The REQUIRED reason the evaluation was recorded.
    reason                              text        NOT NULL
                                                       CHECK (length(reason) >= 1 AND length(reason) <= 4000),
    recorded_actor                      text        NOT NULL
                                                       CHECK (length(recorded_actor) >= 1 AND length(recorded_actor) <= 100),
    recorded_via                        text        NOT NULL
                                                       CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 100),
    correlation_id                      text        NOT NULL
                                                       CHECK (length(correlation_id) >= 1 AND length(correlation_id) <= 100),
    causation_id                        text,
    created_at                          timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS commerce_discovery_evaluations_mission_idx
    ON commerce_discovery_guardrail_evaluations (commerce_discovery_mission_id, created_at, commerce_discovery_evaluation_id);

-- The append-only fence: evaluations reject UPDATE and DELETE outright.
CREATE OR REPLACE FUNCTION commerce_discovery_evaluations_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'commerce discovery guardrail evaluations are append-only — a re-evaluation is a NEW evaluation record (evaluation %)',
        OLD.commerce_discovery_evaluation_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_discovery_evaluations_append_only_update_trigger ON commerce_discovery_guardrail_evaluations;
CREATE TRIGGER commerce_discovery_evaluations_append_only_update_trigger
    BEFORE UPDATE ON commerce_discovery_guardrail_evaluations
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_evaluations_append_only();
DROP TRIGGER IF EXISTS commerce_discovery_evaluations_append_only_delete_trigger ON commerce_discovery_guardrail_evaluations;
CREATE TRIGGER commerce_discovery_evaluations_append_only_delete_trigger
    BEFORE DELETE ON commerce_discovery_guardrail_evaluations
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_evaluations_append_only();

-- ---------------------------------------------------------------------------
-- THE CITATION LINK TABLES (append-only; FK-anchored; scope-fenced)
-- ---------------------------------------------------------------------------

-- Version citations: the product-context derived models behind the
-- selection + the proposals (same-context fence).
CREATE TABLE IF NOT EXISTS commerce_discovery_version_cited_product_models (
    commerce_discovery_mission_version_id  uuid     NOT NULL REFERENCES commerce_discovery_mission_versions(commerce_discovery_mission_version_id),
    derived_model_id                       uuid     NOT NULL REFERENCES product_derived_models(derived_model_id),
    position                               integer  NOT NULL CHECK (position >= 1 AND position <= 32),
    CONSTRAINT commerce_discovery_version_cited_product_models_pk
        PRIMARY KEY (commerce_discovery_mission_version_id, derived_model_id)
);

-- Version citations: the content candidates behind the niche selection
-- (same-client fence).
CREATE TABLE IF NOT EXISTS commerce_discovery_version_cited_content_candidates (
    commerce_discovery_mission_version_id  uuid     NOT NULL REFERENCES commerce_discovery_mission_versions(commerce_discovery_mission_version_id),
    content_candidate_id                   uuid     NOT NULL REFERENCES content_candidates(content_candidate_id),
    position                               integer  NOT NULL CHECK (position >= 1 AND position <= 64),
    CONSTRAINT commerce_discovery_version_cited_content_candidates_pk
        PRIMARY KEY (commerce_discovery_mission_version_id, content_candidate_id)
);

-- Version citations: the content hypotheses behind the demand-test plan
-- (same-client fence).
CREATE TABLE IF NOT EXISTS commerce_discovery_version_cited_content_hypotheses (
    commerce_discovery_mission_version_id  uuid     NOT NULL REFERENCES commerce_discovery_mission_versions(commerce_discovery_mission_version_id),
    content_hypothesis_id                  uuid     NOT NULL REFERENCES content_hypotheses(content_hypothesis_id),
    position                               integer  NOT NULL CHECK (position >= 1 AND position <= 32),
    CONSTRAINT commerce_discovery_version_cited_content_hypotheses_pk
        PRIMARY KEY (commerce_discovery_mission_version_id, content_hypothesis_id)
);

-- Version citations: the platform-health evaluations behind the
-- selection's platform-risk context (same-client fence).
CREATE TABLE IF NOT EXISTS commerce_discovery_version_cited_platform_health_evaluations (
    commerce_discovery_mission_version_id  uuid     NOT NULL REFERENCES commerce_discovery_mission_versions(commerce_discovery_mission_version_id),
    platform_health_evaluation_id          uuid     NOT NULL REFERENCES platform_health_evaluations(platform_health_evaluation_id),
    position                               integer  NOT NULL CHECK (position >= 1 AND position <= 32),
    CONSTRAINT commerce_discovery_version_cited_platform_health_evaluations_pk
        PRIMARY KEY (commerce_discovery_mission_version_id, platform_health_evaluation_id)
);

-- Version citations: the experiment analyses behind the demand-test plan's
-- prior-analysis context (same-client fence).
CREATE TABLE IF NOT EXISTS commerce_discovery_version_cited_experiment_analyses (
    commerce_discovery_mission_version_id  uuid     NOT NULL REFERENCES commerce_discovery_mission_versions(commerce_discovery_mission_version_id),
    analysis_id                            uuid     NOT NULL REFERENCES experiment_analysis_records(analysis_id),
    position                               integer  NOT NULL CHECK (position >= 1 AND position <= 16),
    CONSTRAINT commerce_discovery_version_cited_experiment_analyses_pk
        PRIMARY KEY (commerce_discovery_mission_version_id, analysis_id)
);

-- Candidate citations: the product-derived-model provenance (same-context
-- fence).
CREATE TABLE IF NOT EXISTS commerce_discovery_candidate_cited_product_models (
    commerce_discovery_candidate_id  uuid     NOT NULL REFERENCES commerce_discovery_candidates(commerce_discovery_candidate_id),
    derived_model_id                 uuid     NOT NULL REFERENCES product_derived_models(derived_model_id),
    position                         integer  NOT NULL CHECK (position >= 1 AND position <= 16),
    CONSTRAINT commerce_discovery_candidate_cited_product_models_pk
        PRIMARY KEY (commerce_discovery_candidate_id, derived_model_id)
);

-- Candidate citations: the content-candidate provenance (same-client
-- fence).
CREATE TABLE IF NOT EXISTS commerce_discovery_candidate_cited_content_candidates (
    commerce_discovery_candidate_id  uuid     NOT NULL REFERENCES commerce_discovery_candidates(commerce_discovery_candidate_id),
    content_candidate_id             uuid     NOT NULL REFERENCES content_candidates(content_candidate_id),
    position                         integer  NOT NULL CHECK (position >= 1 AND position <= 32),
    CONSTRAINT commerce_discovery_candidate_cited_content_candidates_pk
        PRIMARY KEY (commerce_discovery_candidate_id, content_candidate_id)
);

-- Candidate citations: the content-hypothesis provenance (same-client
-- fence).
CREATE TABLE IF NOT EXISTS commerce_discovery_candidate_cited_content_hypotheses (
    commerce_discovery_candidate_id  uuid     NOT NULL REFERENCES commerce_discovery_candidates(commerce_discovery_candidate_id),
    content_hypothesis_id            uuid     NOT NULL REFERENCES content_hypotheses(content_hypothesis_id),
    position                         integer  NOT NULL CHECK (position >= 1 AND position <= 32),
    CONSTRAINT commerce_discovery_candidate_cited_content_hypotheses_pk
        PRIMARY KEY (commerce_discovery_candidate_id, content_hypothesis_id)
);

-- Outcome citations: the REAL commerce events the observation derived from
-- (same-client + same-declared-store-connection fence).
CREATE TABLE IF NOT EXISTS commerce_discovery_outcome_cited_commerce_events (
    commerce_discovery_outcome_id  uuid     NOT NULL REFERENCES commerce_discovery_outcomes(commerce_discovery_outcome_id),
    commerce_event_id              uuid     NOT NULL REFERENCES commerce_events(commerce_event_id),
    position                       integer  NOT NULL CHECK (position >= 1 AND position <= 128),
    CONSTRAINT commerce_discovery_outcome_cited_commerce_events_pk
        PRIMARY KEY (commerce_discovery_outcome_id, commerce_event_id)
);

-- Outcome citations: the metric observations co-cited by the learning
-- observation (same-client fence).
CREATE TABLE IF NOT EXISTS commerce_discovery_outcome_cited_metric_observations (
    commerce_discovery_outcome_id  uuid     NOT NULL REFERENCES commerce_discovery_outcomes(commerce_discovery_outcome_id),
    observation_id                 uuid     NOT NULL REFERENCES metric_observations(observation_id),
    position                       integer  NOT NULL CHECK (position >= 1 AND position <= 64),
    CONSTRAINT commerce_discovery_outcome_cited_metric_observations_pk
        PRIMARY KEY (commerce_discovery_outcome_id, observation_id)
);

-- Evaluation citations: the REAL commerce events the evaluation's observed
-- order count derived from (same-client + same-declared-store-connection
-- fence).
CREATE TABLE IF NOT EXISTS commerce_discovery_evaluation_cited_commerce_events (
    commerce_discovery_evaluation_id  uuid     NOT NULL REFERENCES commerce_discovery_guardrail_evaluations(commerce_discovery_evaluation_id),
    commerce_event_id                 uuid     NOT NULL REFERENCES commerce_events(commerce_event_id),
    position                          integer  NOT NULL CHECK (position >= 1 AND position <= 256),
    CONSTRAINT commerce_discovery_evaluation_cited_commerce_events_pk
        PRIMARY KEY (commerce_discovery_evaluation_id, commerce_event_id)
);

-- Evaluation citations: the metric observations the evaluation consumed
-- (same-client fence).
CREATE TABLE IF NOT EXISTS commerce_discovery_evaluation_cited_metric_observations (
    commerce_discovery_evaluation_id  uuid     NOT NULL REFERENCES commerce_discovery_guardrail_evaluations(commerce_discovery_evaluation_id),
    observation_id                    uuid     NOT NULL REFERENCES metric_observations(observation_id),
    position                          integer  NOT NULL CHECK (position >= 1 AND position <= 128),
    CONSTRAINT commerce_discovery_evaluation_cited_metric_observations_pk
        PRIMARY KEY (commerce_discovery_evaluation_id, observation_id)
);

-- Evaluation citations: the ACTIVE /policies network versions cited as the
-- evaluation's policy context (the scope-chain fence: platform, or the
-- mission's agency, or the pursuit client).
CREATE TABLE IF NOT EXISTS commerce_discovery_evaluation_cited_policy_versions (
    commerce_discovery_evaluation_id  uuid     NOT NULL REFERENCES commerce_discovery_guardrail_evaluations(commerce_discovery_evaluation_id),
    policy_id                         uuid     NOT NULL REFERENCES policies(policy_id),
    position                          integer  NOT NULL CHECK (position >= 1 AND position <= 8),
    CONSTRAINT commerce_discovery_evaluation_cited_policy_versions_pk
        PRIMARY KEY (commerce_discovery_evaluation_id, policy_id)
);

-- The append-only fence for EVERY citation link table: UPDATE and DELETE
-- are rejected outright (the migration-060 citations family discipline).
CREATE OR REPLACE FUNCTION commerce_discovery_citations_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'commerce discovery citation links are append-only — the citation basis of a record is never rewritten';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_discovery_version_cited_product_models_append_only_update ON commerce_discovery_version_cited_product_models;
CREATE TRIGGER commerce_discovery_version_cited_product_models_append_only_update
    BEFORE UPDATE ON commerce_discovery_version_cited_product_models
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_citations_append_only();
DROP TRIGGER IF EXISTS commerce_discovery_version_cited_product_models_append_only_delete ON commerce_discovery_version_cited_product_models;
CREATE TRIGGER commerce_discovery_version_cited_product_models_append_only_delete
    BEFORE DELETE ON commerce_discovery_version_cited_product_models
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_citations_append_only();

DROP TRIGGER IF EXISTS commerce_discovery_version_cited_content_candidates_append_only_update ON commerce_discovery_version_cited_content_candidates;
CREATE TRIGGER commerce_discovery_version_cited_content_candidates_append_only_update
    BEFORE UPDATE ON commerce_discovery_version_cited_content_candidates
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_citations_append_only();
DROP TRIGGER IF EXISTS commerce_discovery_version_cited_content_candidates_append_only_delete ON commerce_discovery_version_cited_content_candidates;
CREATE TRIGGER commerce_discovery_version_cited_content_candidates_append_only_delete
    BEFORE DELETE ON commerce_discovery_version_cited_content_candidates
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_citations_append_only();

DROP TRIGGER IF EXISTS commerce_discovery_version_cited_content_hypotheses_append_only_update ON commerce_discovery_version_cited_content_hypotheses;
CREATE TRIGGER commerce_discovery_version_cited_content_hypotheses_append_only_update
    BEFORE UPDATE ON commerce_discovery_version_cited_content_hypotheses
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_citations_append_only();
DROP TRIGGER IF EXISTS commerce_discovery_version_cited_content_hypotheses_append_only_delete ON commerce_discovery_version_cited_content_hypotheses;
CREATE TRIGGER commerce_discovery_version_cited_content_hypotheses_append_only_delete
    BEFORE DELETE ON commerce_discovery_version_cited_content_hypotheses
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_citations_append_only();

DROP TRIGGER IF EXISTS commerce_discovery_version_cited_platform_health_append_only_update ON commerce_discovery_version_cited_platform_health_evaluations;
CREATE TRIGGER commerce_discovery_version_cited_platform_health_append_only_update
    BEFORE UPDATE ON commerce_discovery_version_cited_platform_health_evaluations
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_citations_append_only();
DROP TRIGGER IF EXISTS commerce_discovery_version_cited_platform_health_append_only_delete ON commerce_discovery_version_cited_platform_health_evaluations;
CREATE TRIGGER commerce_discovery_version_cited_platform_health_append_only_delete
    BEFORE DELETE ON commerce_discovery_version_cited_platform_health_evaluations
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_citations_append_only();

DROP TRIGGER IF EXISTS commerce_discovery_version_cited_experiment_analyses_append_only_update ON commerce_discovery_version_cited_experiment_analyses;
CREATE TRIGGER commerce_discovery_version_cited_experiment_analyses_append_only_update
    BEFORE UPDATE ON commerce_discovery_version_cited_experiment_analyses
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_citations_append_only();
DROP TRIGGER IF EXISTS commerce_discovery_version_cited_experiment_analyses_append_only_delete ON commerce_discovery_version_cited_experiment_analyses;
CREATE TRIGGER commerce_discovery_version_cited_experiment_analyses_append_only_delete
    BEFORE DELETE ON commerce_discovery_version_cited_experiment_analyses
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_citations_append_only();

DROP TRIGGER IF EXISTS commerce_discovery_candidate_cited_product_models_append_only_update ON commerce_discovery_candidate_cited_product_models;
CREATE TRIGGER commerce_discovery_candidate_cited_product_models_append_only_update
    BEFORE UPDATE ON commerce_discovery_candidate_cited_product_models
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_citations_append_only();
DROP TRIGGER IF EXISTS commerce_discovery_candidate_cited_product_models_append_only_delete ON commerce_discovery_candidate_cited_product_models;
CREATE TRIGGER commerce_discovery_candidate_cited_product_models_append_only_delete
    BEFORE DELETE ON commerce_discovery_candidate_cited_product_models
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_citations_append_only();

DROP TRIGGER IF EXISTS commerce_discovery_candidate_cited_content_candidates_append_only_update ON commerce_discovery_candidate_cited_content_candidates;
CREATE TRIGGER commerce_discovery_candidate_cited_content_candidates_append_only_update
    BEFORE UPDATE ON commerce_discovery_candidate_cited_content_candidates
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_citations_append_only();
DROP TRIGGER IF EXISTS commerce_discovery_candidate_cited_content_candidates_append_only_delete ON commerce_discovery_candidate_cited_content_candidates;
CREATE TRIGGER commerce_discovery_candidate_cited_content_candidates_append_only_delete
    BEFORE DELETE ON commerce_discovery_candidate_cited_content_candidates
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_citations_append_only();

DROP TRIGGER IF EXISTS commerce_discovery_candidate_cited_content_hypotheses_append_only_update ON commerce_discovery_candidate_cited_content_hypotheses;
CREATE TRIGGER commerce_discovery_candidate_cited_content_hypotheses_append_only_update
    BEFORE UPDATE ON commerce_discovery_candidate_cited_content_hypotheses
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_citations_append_only();
DROP TRIGGER IF EXISTS commerce_discovery_candidate_cited_content_hypotheses_append_only_delete ON commerce_discovery_candidate_cited_content_hypotheses;
CREATE TRIGGER commerce_discovery_candidate_cited_content_hypotheses_append_only_delete
    BEFORE DELETE ON commerce_discovery_candidate_cited_content_hypotheses
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_citations_append_only();

DROP TRIGGER IF EXISTS commerce_discovery_outcome_cited_commerce_events_append_only_update ON commerce_discovery_outcome_cited_commerce_events;
CREATE TRIGGER commerce_discovery_outcome_cited_commerce_events_append_only_update
    BEFORE UPDATE ON commerce_discovery_outcome_cited_commerce_events
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_citations_append_only();
DROP TRIGGER IF EXISTS commerce_discovery_outcome_cited_commerce_events_append_only_delete ON commerce_discovery_outcome_cited_commerce_events;
CREATE TRIGGER commerce_discovery_outcome_cited_commerce_events_append_only_delete
    BEFORE DELETE ON commerce_discovery_outcome_cited_commerce_events
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_citations_append_only();

DROP TRIGGER IF EXISTS commerce_discovery_outcome_cited_metric_observations_append_only_update ON commerce_discovery_outcome_cited_metric_observations;
CREATE TRIGGER commerce_discovery_outcome_cited_metric_observations_append_only_update
    BEFORE UPDATE ON commerce_discovery_outcome_cited_metric_observations
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_citations_append_only();
DROP TRIGGER IF EXISTS commerce_discovery_outcome_cited_metric_observations_append_only_delete ON commerce_discovery_outcome_cited_metric_observations;
CREATE TRIGGER commerce_discovery_outcome_cited_metric_observations_append_only_delete
    BEFORE DELETE ON commerce_discovery_outcome_cited_metric_observations
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_citations_append_only();

DROP TRIGGER IF EXISTS commerce_discovery_evaluation_cited_commerce_events_append_only_update ON commerce_discovery_evaluation_cited_commerce_events;
CREATE TRIGGER commerce_discovery_evaluation_cited_commerce_events_append_only_update
    BEFORE UPDATE ON commerce_discovery_evaluation_cited_commerce_events
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_citations_append_only();
DROP TRIGGER IF EXISTS commerce_discovery_evaluation_cited_commerce_events_append_only_delete ON commerce_discovery_evaluation_cited_commerce_events;
CREATE TRIGGER commerce_discovery_evaluation_cited_commerce_events_append_only_delete
    BEFORE DELETE ON commerce_discovery_evaluation_cited_commerce_events
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_citations_append_only();

DROP TRIGGER IF EXISTS commerce_discovery_evaluation_cited_metric_observations_append_only_update ON commerce_discovery_evaluation_cited_metric_observations;
CREATE TRIGGER commerce_discovery_evaluation_cited_metric_observations_append_only_update
    BEFORE UPDATE ON commerce_discovery_evaluation_cited_metric_observations
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_citations_append_only();
DROP TRIGGER IF EXISTS commerce_discovery_evaluation_cited_metric_observations_append_only_delete ON commerce_discovery_evaluation_cited_metric_observations;
CREATE TRIGGER commerce_discovery_evaluation_cited_metric_observations_append_only_delete
    BEFORE DELETE ON commerce_discovery_evaluation_cited_metric_observations
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_citations_append_only();

DROP TRIGGER IF EXISTS commerce_discovery_evaluation_cited_policy_versions_append_only_update ON commerce_discovery_evaluation_cited_policy_versions;
CREATE TRIGGER commerce_discovery_evaluation_cited_policy_versions_append_only_update
    BEFORE UPDATE ON commerce_discovery_evaluation_cited_policy_versions
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_citations_append_only();
DROP TRIGGER IF EXISTS commerce_discovery_evaluation_cited_policy_versions_append_only_delete ON commerce_discovery_evaluation_cited_policy_versions;
CREATE TRIGGER commerce_discovery_evaluation_cited_policy_versions_append_only_delete
    BEFORE DELETE ON commerce_discovery_evaluation_cited_policy_versions
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_citations_append_only();

-- ---------------------------------------------------------------------------
-- THE SCOPE FENCES — every citation stays inside its scope (the
-- migration-058/060 discipline; all anchored authority tables read
-- CHECK-ONLY, never written here)
-- ---------------------------------------------------------------------------

-- Product-derived-model citations (version + candidate): the cited model
-- must belong to the SAME product context as the citing version/candidate
-- program's cited context.
CREATE OR REPLACE FUNCTION commerce_discovery_version_cited_product_models_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_version_context uuid;
    v_model_context   uuid;
BEGIN
    SELECT pv.product_context_id INTO v_version_context
      FROM commerce_discovery_mission_versions pv
     WHERE pv.commerce_discovery_mission_version_id = NEW.commerce_discovery_mission_version_id;
    SELECT product_context_id INTO v_model_context
      FROM product_derived_models WHERE derived_model_id = NEW.derived_model_id;
    IF v_version_context IS NULL OR v_model_context IS NULL
       OR v_version_context <> v_model_context THEN
        RAISE EXCEPTION 'commerce discovery version product-model citation %→% crosses the product-context boundary — model citations stay inside the cited product context',
            NEW.commerce_discovery_mission_version_id, NEW.derived_model_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_discovery_version_cited_product_models_scope_trigger ON commerce_discovery_version_cited_product_models;
CREATE TRIGGER commerce_discovery_version_cited_product_models_scope_trigger
    BEFORE INSERT ON commerce_discovery_version_cited_product_models
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_version_cited_product_models_scope_consistent();

CREATE OR REPLACE FUNCTION commerce_discovery_candidate_cited_product_models_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_program            uuid;
    v_program_context    uuid;
    v_model_context      uuid;
BEGIN
    SELECT c.commerce_discovery_mission_id INTO v_program
      FROM commerce_discovery_candidates c
     WHERE c.commerce_discovery_candidate_id = NEW.commerce_discovery_candidate_id;
    SELECT pv.product_context_id INTO v_program_context
      FROM commerce_discovery_mission_versions pv
      JOIN commerce_discovery_missions m
        ON m.commerce_discovery_mission_id = pv.commerce_discovery_mission_id
       AND m.current_version_seq = pv.version_seq
     WHERE m.commerce_discovery_mission_id = v_program;
    SELECT product_context_id INTO v_model_context
      FROM product_derived_models WHERE derived_model_id = NEW.derived_model_id;
    IF v_program_context IS NULL OR v_model_context IS NULL
       OR v_program_context <> v_model_context THEN
        RAISE EXCEPTION 'commerce discovery candidate product-model citation %→% crosses the product-context boundary — model citations stay inside the program''s current cited product context',
            NEW.commerce_discovery_candidate_id, NEW.derived_model_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_discovery_candidate_cited_product_models_scope_trigger ON commerce_discovery_candidate_cited_product_models;
CREATE TRIGGER commerce_discovery_candidate_cited_product_models_scope_trigger
    BEFORE INSERT ON commerce_discovery_candidate_cited_product_models
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_candidate_cited_product_models_scope_consistent();

-- Client-scoped citations (version + candidate content citations, version
-- health/analysis citations, outcome/evaluation metric citations): the
-- cited record must belong to the SAME client as the discovery program.
CREATE OR REPLACE FUNCTION commerce_discovery_version_cited_content_candidates_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_program_client uuid;
    v_cited_client   uuid;
BEGIN
    SELECT m.client_id INTO v_program_client
      FROM commerce_discovery_missions m
      JOIN commerce_discovery_mission_versions pv
        ON pv.commerce_discovery_mission_id = m.commerce_discovery_mission_id
     WHERE pv.commerce_discovery_mission_version_id = NEW.commerce_discovery_mission_version_id;
    SELECT client_id INTO v_cited_client
      FROM content_candidates WHERE content_candidate_id = NEW.content_candidate_id;
    IF v_program_client IS NULL OR v_cited_client IS NULL
       OR v_program_client <> v_cited_client THEN
        RAISE EXCEPTION 'commerce discovery version content-candidate citation %→% crosses the client boundary — candidate citations stay inside one client',
            NEW.commerce_discovery_mission_version_id, NEW.content_candidate_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_discovery_version_cited_content_candidates_scope_trigger ON commerce_discovery_version_cited_content_candidates;
CREATE TRIGGER commerce_discovery_version_cited_content_candidates_scope_trigger
    BEFORE INSERT ON commerce_discovery_version_cited_content_candidates
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_version_cited_content_candidates_scope_consistent();

CREATE OR REPLACE FUNCTION commerce_discovery_version_cited_content_hypotheses_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_program_client uuid;
    v_cited_client   uuid;
BEGIN
    SELECT m.client_id INTO v_program_client
      FROM commerce_discovery_missions m
      JOIN commerce_discovery_mission_versions pv
        ON pv.commerce_discovery_mission_id = m.commerce_discovery_mission_id
     WHERE pv.commerce_discovery_mission_version_id = NEW.commerce_discovery_mission_version_id;
    SELECT client_id INTO v_cited_client
      FROM content_hypotheses WHERE content_hypothesis_id = NEW.content_hypothesis_id;
    IF v_program_client IS NULL OR v_cited_client IS NULL
       OR v_program_client <> v_cited_client THEN
        RAISE EXCEPTION 'commerce discovery version content-hypothesis citation %→% crosses the client boundary — hypothesis citations stay inside one client',
            NEW.commerce_discovery_mission_version_id, NEW.content_hypothesis_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_discovery_version_cited_content_hypotheses_scope_trigger ON commerce_discovery_version_cited_content_hypotheses;
CREATE TRIGGER commerce_discovery_version_cited_content_hypotheses_scope_trigger
    BEFORE INSERT ON commerce_discovery_version_cited_content_hypotheses
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_version_cited_content_hypotheses_scope_consistent();

CREATE OR REPLACE FUNCTION commerce_discovery_version_cited_platform_health_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_program_client uuid;
    v_cited_client   uuid;
BEGIN
    SELECT m.client_id INTO v_program_client
      FROM commerce_discovery_missions m
      JOIN commerce_discovery_mission_versions pv
        ON pv.commerce_discovery_mission_id = m.commerce_discovery_mission_id
     WHERE pv.commerce_discovery_mission_version_id = NEW.commerce_discovery_mission_version_id;
    SELECT client_id INTO v_cited_client
      FROM platform_health_evaluations WHERE platform_health_evaluation_id = NEW.platform_health_evaluation_id;
    IF v_program_client IS NULL OR v_cited_client IS NULL
       OR v_program_client <> v_cited_client THEN
        RAISE EXCEPTION 'commerce discovery version platform-health citation %→% crosses the client boundary — health citations stay inside one client',
            NEW.commerce_discovery_mission_version_id, NEW.platform_health_evaluation_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_discovery_version_cited_platform_health_scope_trigger ON commerce_discovery_version_cited_platform_health_evaluations;
CREATE TRIGGER commerce_discovery_version_cited_platform_health_scope_trigger
    BEFORE INSERT ON commerce_discovery_version_cited_platform_health_evaluations
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_version_cited_platform_health_scope_consistent();

CREATE OR REPLACE FUNCTION commerce_discovery_version_cited_experiment_analyses_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_program_client uuid;
    v_cited_client   uuid;
BEGIN
    SELECT m.client_id INTO v_program_client
      FROM commerce_discovery_missions m
      JOIN commerce_discovery_mission_versions pv
        ON pv.commerce_discovery_mission_id = m.commerce_discovery_mission_id
     WHERE pv.commerce_discovery_mission_version_id = NEW.commerce_discovery_mission_version_id;
    SELECT client_id INTO v_cited_client
      FROM experiment_analysis_records WHERE analysis_id = NEW.analysis_id;
    IF v_program_client IS NULL OR v_cited_client IS NULL
       OR v_program_client <> v_cited_client THEN
        RAISE EXCEPTION 'commerce discovery version experiment-analysis citation %→% crosses the client boundary — analysis citations stay inside one client',
            NEW.commerce_discovery_mission_version_id, NEW.analysis_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_discovery_version_cited_experiment_analyses_scope_trigger ON commerce_discovery_version_cited_experiment_analyses;
CREATE TRIGGER commerce_discovery_version_cited_experiment_analyses_scope_trigger
    BEFORE INSERT ON commerce_discovery_version_cited_experiment_analyses
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_version_cited_experiment_analyses_scope_consistent();

CREATE OR REPLACE FUNCTION commerce_discovery_candidate_cited_content_candidates_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_program_client uuid;
    v_cited_client   uuid;
BEGIN
    SELECT m.client_id INTO v_program_client
      FROM commerce_discovery_missions m
      JOIN commerce_discovery_candidates c
        ON c.commerce_discovery_mission_id = m.commerce_discovery_mission_id
     WHERE c.commerce_discovery_candidate_id = NEW.commerce_discovery_candidate_id;
    SELECT client_id INTO v_cited_client
      FROM content_candidates WHERE content_candidate_id = NEW.content_candidate_id;
    IF v_program_client IS NULL OR v_cited_client IS NULL
       OR v_program_client <> v_cited_client THEN
        RAISE EXCEPTION 'commerce discovery candidate content-candidate citation %→% crosses the client boundary — candidate citations stay inside one client',
            NEW.commerce_discovery_candidate_id, NEW.content_candidate_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_discovery_candidate_cited_content_candidates_scope_trigger ON commerce_discovery_candidate_cited_content_candidates;
CREATE TRIGGER commerce_discovery_candidate_cited_content_candidates_scope_trigger
    BEFORE INSERT ON commerce_discovery_candidate_cited_content_candidates
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_candidate_cited_content_candidates_scope_consistent();

CREATE OR REPLACE FUNCTION commerce_discovery_candidate_cited_content_hypotheses_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_program_client uuid;
    v_cited_client   uuid;
BEGIN
    SELECT m.client_id INTO v_program_client
      FROM commerce_discovery_missions m
      JOIN commerce_discovery_candidates c
        ON c.commerce_discovery_mission_id = m.commerce_discovery_mission_id
     WHERE c.commerce_discovery_candidate_id = NEW.commerce_discovery_candidate_id;
    SELECT client_id INTO v_cited_client
      FROM content_hypotheses WHERE content_hypothesis_id = NEW.content_hypothesis_id;
    IF v_program_client IS NULL OR v_cited_client IS NULL
       OR v_program_client <> v_cited_client THEN
        RAISE EXCEPTION 'commerce discovery candidate content-hypothesis citation %→% crosses the client boundary — hypothesis citations stay inside one client',
            NEW.commerce_discovery_candidate_id, NEW.content_hypothesis_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_discovery_candidate_cited_content_hypotheses_scope_trigger ON commerce_discovery_candidate_cited_content_hypotheses;
CREATE TRIGGER commerce_discovery_candidate_cited_content_hypotheses_scope_trigger
    BEFORE INSERT ON commerce_discovery_candidate_cited_content_hypotheses
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_candidate_cited_content_hypotheses_scope_consistent();

-- Commerce-event citations (outcome + evaluation): the cited event must
-- belong to the SAME client AND to the declared STORE CONNECTION of the
-- program's CURRENT version (the learning loop learns from ITS store's
-- orders — auditable and honest).
CREATE OR REPLACE FUNCTION commerce_discovery_outcome_cited_commerce_events_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_program_client uuid;
    v_store_connection uuid;
    v_event_client   uuid;
    v_event_connection uuid;
BEGIN
    SELECT m.client_id, pv.store_connection_id INTO v_program_client, v_store_connection
      FROM commerce_discovery_missions m
      JOIN commerce_discovery_candidates c
        ON c.commerce_discovery_mission_id = m.commerce_discovery_mission_id
      JOIN commerce_discovery_mission_versions pv
        ON pv.commerce_discovery_mission_id = m.commerce_discovery_mission_id
       AND pv.version_seq = m.current_version_seq
     WHERE c.commerce_discovery_candidate_id = (
         SELECT o.commerce_discovery_candidate_id
           FROM commerce_discovery_outcomes o
          WHERE o.commerce_discovery_outcome_id = NEW.commerce_discovery_outcome_id
     );
    SELECT client_id, connection_id INTO v_event_client, v_event_connection
      FROM commerce_events WHERE commerce_event_id = NEW.commerce_event_id;
    IF v_program_client IS NULL OR v_event_client IS NULL
       OR v_program_client <> v_event_client
       OR v_store_connection IS NULL OR v_store_connection <> v_event_connection THEN
        RAISE EXCEPTION 'commerce discovery outcome commerce-event citation %→% crosses the client/store-connection boundary — order-event citations stay inside the program''s client and its declared store connection',
            NEW.commerce_discovery_outcome_id, NEW.commerce_event_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_discovery_outcome_cited_commerce_events_scope_trigger ON commerce_discovery_outcome_cited_commerce_events;
CREATE TRIGGER commerce_discovery_outcome_cited_commerce_events_scope_trigger
    BEFORE INSERT ON commerce_discovery_outcome_cited_commerce_events
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_outcome_cited_commerce_events_scope_consistent();

CREATE OR REPLACE FUNCTION commerce_discovery_evaluation_cited_commerce_events_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_program_client uuid;
    v_store_connection uuid;
    v_event_client   uuid;
    v_event_connection uuid;
BEGIN
    SELECT m.client_id, pv.store_connection_id INTO v_program_client, v_store_connection
      FROM commerce_discovery_missions m
      JOIN commerce_discovery_mission_versions pv
        ON pv.commerce_discovery_mission_id = m.commerce_discovery_mission_id
       AND pv.version_seq = m.current_version_seq
      JOIN commerce_discovery_guardrail_evaluations e
        ON e.commerce_discovery_mission_id = m.commerce_discovery_mission_id
     WHERE e.commerce_discovery_evaluation_id = NEW.commerce_discovery_evaluation_id;
    SELECT client_id, connection_id INTO v_event_client, v_event_connection
      FROM commerce_events WHERE commerce_event_id = NEW.commerce_event_id;
    IF v_program_client IS NULL OR v_event_client IS NULL
       OR v_program_client <> v_event_client
       OR v_store_connection IS NULL OR v_store_connection <> v_event_connection THEN
        RAISE EXCEPTION 'commerce discovery evaluation commerce-event citation %→% crosses the client/store-connection boundary — order-event citations stay inside the program''s client and its declared store connection',
            NEW.commerce_discovery_evaluation_id, NEW.commerce_event_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_discovery_evaluation_cited_commerce_events_scope_trigger ON commerce_discovery_evaluation_cited_commerce_events;
CREATE TRIGGER commerce_discovery_evaluation_cited_commerce_events_scope_trigger
    BEFORE INSERT ON commerce_discovery_evaluation_cited_commerce_events
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_evaluation_cited_commerce_events_scope_consistent();

-- Metric-observation citations (outcome + evaluation): the cited
-- observation must belong to the SAME client as the discovery program.
CREATE OR REPLACE FUNCTION commerce_discovery_outcome_cited_metric_observations_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_program_client uuid;
    v_cited_client   uuid;
BEGIN
    SELECT m.client_id INTO v_program_client
      FROM commerce_discovery_missions m
      JOIN commerce_discovery_candidates c
        ON c.commerce_discovery_mission_id = m.commerce_discovery_mission_id
      JOIN commerce_discovery_outcomes o
        ON o.commerce_discovery_candidate_id = c.commerce_discovery_candidate_id
     WHERE o.commerce_discovery_outcome_id = NEW.commerce_discovery_outcome_id;
    SELECT client_id INTO v_cited_client
      FROM metric_observations WHERE observation_id = NEW.observation_id;
    IF v_program_client IS NULL OR v_cited_client IS NULL
       OR v_program_client <> v_cited_client THEN
        RAISE EXCEPTION 'commerce discovery outcome metric-observation citation %→% crosses the client boundary — metric citations stay inside one client',
            NEW.commerce_discovery_outcome_id, NEW.observation_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_discovery_outcome_cited_metric_observations_scope_trigger ON commerce_discovery_outcome_cited_metric_observations;
CREATE TRIGGER commerce_discovery_outcome_cited_metric_observations_scope_trigger
    BEFORE INSERT ON commerce_discovery_outcome_cited_metric_observations
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_outcome_cited_metric_observations_scope_consistent();

CREATE OR REPLACE FUNCTION commerce_discovery_evaluation_cited_metric_observations_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_program_client uuid;
    v_cited_client   uuid;
BEGIN
    SELECT m.client_id INTO v_program_client
      FROM commerce_discovery_missions m
      JOIN commerce_discovery_guardrail_evaluations e
        ON e.commerce_discovery_mission_id = m.commerce_discovery_mission_id
     WHERE e.commerce_discovery_evaluation_id = NEW.commerce_discovery_evaluation_id;
    SELECT client_id INTO v_cited_client
      FROM metric_observations WHERE observation_id = NEW.observation_id;
    IF v_program_client IS NULL OR v_cited_client IS NULL
       OR v_program_client <> v_cited_client THEN
        RAISE EXCEPTION 'commerce discovery evaluation metric-observation citation %→% crosses the client boundary — metric citations stay inside one client',
            NEW.commerce_discovery_evaluation_id, NEW.observation_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_discovery_evaluation_cited_metric_observations_scope_trigger ON commerce_discovery_evaluation_cited_metric_observations;
CREATE TRIGGER commerce_discovery_evaluation_cited_metric_observations_scope_trigger
    BEFORE INSERT ON commerce_discovery_evaluation_cited_metric_observations
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_evaluation_cited_metric_observations_scope_consistent();

-- Policy-version citations: the cited ACTIVE network policy must sit on
-- the discovery program's scope chain (platform, or the program's agency,
-- or the pursuit client) — the guardrail evaluation's policy context.
CREATE OR REPLACE FUNCTION commerce_discovery_evaluation_cited_policy_versions_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_agency uuid;
    v_client uuid;
    v_policy_agency uuid;
    v_policy_client uuid;
    v_policy_dimension text;
    v_policy_status text;
BEGIN
    SELECT m.agency_id, m.client_id INTO v_agency, v_client
      FROM commerce_discovery_missions m
      JOIN commerce_discovery_guardrail_evaluations e
        ON e.commerce_discovery_mission_id = m.commerce_discovery_mission_id
     WHERE e.commerce_discovery_evaluation_id = NEW.commerce_discovery_evaluation_id;
    SELECT agency_id, client_id, dimension, status INTO v_policy_agency, v_policy_client, v_policy_dimension, v_policy_status
      FROM policies WHERE policy_id = NEW.policy_id;
    IF v_agency IS NULL OR v_policy_dimension IS NULL
       OR v_policy_dimension <> 'network'
       OR v_policy_status <> 'active'
       OR (v_policy_agency IS NOT NULL AND v_policy_agency <> v_agency)
       OR (v_policy_client IS NOT NULL AND v_policy_client <> v_client) THEN
        RAISE EXCEPTION 'commerce discovery evaluation policy-version citation %→% crosses the scope chain — policy citations stay on the program''s platform/agency/client chain, network dimension, active versions only',
            NEW.commerce_discovery_evaluation_id, NEW.policy_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_discovery_evaluation_cited_policy_versions_scope_trigger ON commerce_discovery_evaluation_cited_policy_versions;
CREATE TRIGGER commerce_discovery_evaluation_cited_policy_versions_scope_trigger
    BEFORE INSERT ON commerce_discovery_evaluation_cited_policy_versions
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_evaluation_cited_policy_versions_scope_consistent();

-- The demand-test experiment fence: the referenced experiment must belong
-- to the SAME client as the discovery program (a discovery mission's
-- demand tests ARE experiments through the authority — same-client only).
CREATE OR REPLACE FUNCTION commerce_discovery_demand_tests_experiment_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_program_client uuid;
    v_experiment_client uuid;
BEGIN
    SELECT m.client_id INTO v_program_client
      FROM commerce_discovery_missions m
     WHERE m.commerce_discovery_mission_id = NEW.commerce_discovery_mission_id;
    SELECT client_id INTO v_experiment_client
      FROM experiments WHERE experiment_id = NEW.experiment_id;
    IF v_program_client IS NULL OR v_experiment_client IS NULL
       OR v_program_client <> v_experiment_client THEN
        RAISE EXCEPTION 'commerce discovery demand test %→experiment % crosses the client boundary — a discovery mission''s demand tests are same-client experiments through the authority',
            NEW.commerce_discovery_demand_test_id, NEW.experiment_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_discovery_demand_tests_experiment_scope_trigger ON commerce_discovery_demand_tests;
CREATE TRIGGER commerce_discovery_demand_tests_experiment_scope_trigger
    BEFORE INSERT ON commerce_discovery_demand_tests
    FOR EACH ROW EXECUTE FUNCTION commerce_discovery_demand_tests_experiment_scope_consistent();
