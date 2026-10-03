-- 067_lab_capabilities.sql — LAB-013 (Capability Engine + Arena Adapter).
--
-- THE CAPABILITY GAP/CONTRACT/VERSION AUTHORITY (spec/effective-backlog-
-- v1.7.md LAB-013: "Formalize capability gaps, requests, providers, quality
-- evaluation and verified capability versions. Acceptance: missing
-- capability can be discovered, requested, fulfilled, verified and inserted
-- without creating a second marketplace authority; Arena remains behind
-- Integration/provider contracts."; dependencies satisfied: LAB-001
-- (merged — the /lab contracts and run model) and LAB-011 (merged — the
-- /lab-agent-body versioned registry whose lifecycle discipline the
-- capability version records follow); spec/architecture-v1.7-marketing-lab.md
-- §16 "Capability system" (the Capability record shape: input schema,
-- output schema, constraints, quality evaluator, cost, latency, provenance,
-- implementation/version, simulator implementation if available, real
-- implementation if available, human/provider requirements — "Capabilities
-- are first-class executable contracts"; "The Lab can detect a capability
-- gap when a candidate strategy requires an unavailable quality-preserving
-- action") and §17 "Arena capability acquisition" (the flow "Capability gap
-- → capability contract → value estimate → governed Arena request →
-- human/provider result → verification → capability version → simulation →
-- real test"; "Arena is an external capability provider and is NOT
-- introduced as another MOS marketplace authority"; "Arena results enter
-- MOS through an explicit Integration/provider contract"; "If Arena work
-- ultimately uses the existing Human Agent/Job/Task/Execution plane, those
-- existing authorities remain canonical"; "Human availability is never a
-- prerequisite for ordinary autonomous growth"; "A capability acquired
-- from a human does not automatically grant rights to use the resulting
-- artifact beyond the explicit contract") and §22 multi-tenancy;
-- architecture-lock-v1.7 rules 22/23/24 (the capability/acquisition rules);
-- AGENTS.md v1.7 "Capabilities are explicit contracts with evaluation,
-- cost, latency and provenance" + "Arena is an external capability
-- provider behind Integration, not a MOS marketplace authority"):
--
--   The NINE §17 flow stage tables, created in the flow's own order (each
--   stage cites ONLY earlier stages — the chain is acyclic by construction):
--
--   lab_capability_gaps          → stage 1 — the CAPABILITY GAP records
--                                  (detected when a candidate strategy
--                                  requires an unavailable quality-preserving
--                                  action; cites the strategy + the required
--                                  action shape as OPAQUE data — the /lab
--                                  by-reference discipline, NO FK into /lab);
--   lab_capability_contracts     → stage 2 — the CAPABILITY CONTRACT records
--                                  (the required §16-shaped capability
--                                  contract derived from the gap: schemas,
--                                  constraints, the REQUIRED quality
--                                  evaluator declaration, cost/latency
--                                  ceilings, human/provider requirements);
--   lab_capability_value_estimates → stage 3 — the VALUE ESTIMATE records
--                                  (the honest value/cost/uncertainty basis
--                                  that governs the request — a revised
--                                  estimate supersedes the prior, never
--                                  rewrites it);
--   lab_capability_requests      → stage 4 — the GOVERNED ARENA REQUEST
--                                  records (gap + contract + estimate +
--                                  the DECLARED provider target as DATA —
--                                  adapter key + connection id + operation;
--                                  ZERO provider-selection logic, ZERO
--                                  marketplace vocabulary: no price, bid,
--                                  listing, ranking or negotiation column
--                                  anywhere in this migration);
--   lab_capability_results       → stage 5 — the HUMAN/PROVIDER RESULT
--                                  records (the immutable fulfillment:
--                                  provider outcome or human-plane citation,
--                                  the delivered artifact descriptor and the
--                                  EXPLICIT contract-rights grant — recorded
--                                  DATA, never assumed);
--   lab_capability_verifications → stage 6 — the VERIFICATION records (the
--                                  declared evaluator run: evaluator
--                                  identity + version echo + the verdict
--                                  from the closed vocabulary + the
--                                  evaluation evidence);
--   lab_capability_versions      → stage 7 — the CAPABILITY VERSION records
--                                  (the §16 registry: the FULL declared
--                                  field set per row, the draft → active →
--                                  retired lifecycle, append-only version
--                                  corrections, opaque version references,
--                                  identity immutable — the LAB-011
--                                  body-registry precedent applied to
--                                  capabilities);
--   lab_capability_simulations   → stage 8 — the SIMULATION link records
--                                  (the OPAQUE citation of the /lab
--                                  simulation run that exercised the
--                                  capability version + the outcome);
--   lab_capability_real_tests    → stage 9 — the REAL-TEST link records
--                                  (the OPAQUE citation of the real-plane
--                                  authority record + the outcome — real
--                                  tests always belong to the existing
--                                  authorities, this module only links).
--
-- Key fences:
--
-- * CHECK-fenced closed vocabularies on every enumerated column: the actor
--   split (autonomous/human — every stage record carries its actor; the
--   ordinary §17 path is fully autonomous, the human actor labels the
--   OPTIONAL human surface), the gap lifecycle (open/contracted/resolved/
--   abandoned), the contract lifecycle (derived/withdrawn), the estimate
--   lifecycle (recorded/superseded), the request lifecycle (pending/
--   completed/failed/cancelled), the fulfillment kind (provider/
--   human_plane), the verification verdict (pass/fail/inconclusive), the
--   simulation/real-test outcome (passed/failed/inconclusive), the
--   capability version lifecycle (draft/active/retired), the provenance
--   origin (first_party_declared/arena_provider/human_contribution), the
--   implementation kind (simulator/real/hybrid/declared_only), the §16 gap
--   action kinds (physical_performance/platform_action_gap/
--   authentic_demonstration/specialized_media_treatment), the strategy
--   citation kinds (lab_strategy_candidate/lab_organization_candidate/
--   lab_capability_candidate/external), the human-plane authorities
--   (field-agents/jobs/executions — the canonical Human Agent/Job/Task/
--   Execution plane, cited OPAQUELY, never re-modeled), the real-test
--   authorities (experiments/executions/evidence/workflows), and the
--   pinned contract version ('lab-capabilities-contract-v1').
-- * THE UNVERIFIED-NEVER-PRESENTED RULE (the /product-intelligence
--   derived-record-without-evidence discipline): the verified state of a
--   capability version is NEVER an asserted boolean — it is the LINKED
--   PASSING verification record. The insert trigger rejects a capability
--   version whose source_verification_id cites anything but a verdict
--   'pass' verification in the same scope; a version with NO citation is
--   honestly unverified (the first-party declared path). The read surface
--   derives verification from the linkage.
-- * THE APPEND-ONLY DISCIPLINE: the gap/contract/estimate/request/version
--   records keep identity immutable and advance ONLY their closed status
--   vocabulary under guard (no resurrection, no reopen); the result,
--   verification, simulation and real-test records are APPEND-ONLY
--   OUTRIGHT (UPDATE and DELETE both rejected); NO row of ANY table in
--   this migration is ever deleted.
-- * NO SECOND MARKETPLACE AUTHORITY (§17 — the core acceptance,
--   structural): there is NO marketplace vocabulary anywhere (no price,
--   bid, offer, listing, ranking, escrow or provider-selection column or
--   table); the provider target is CALLER-DECLARED DATA (adapter_key +
--   connection_id + operation) dispatched through the EXISTING
--   /integrations provider contracts at the composition-root-wired
--   structural port — the fail-closed policy/credential/capability gates
--   stay in /integrations, the sole provider authority.
-- * THE HUMAN-PLANE BOUNDARY (§17): the human fulfillment cites the
--   canonical Human Agent/Job/Task/Execution plane OPAQUELY
--   (human_plane_citation as recorded data — plane authority + record
--   reference; NO FK into /field-agents, /jobs or /executions, NO
--   re-modeling of their state); nothing in this schema makes human
--   availability a prerequisite for any autonomous path.
-- * THE CONTRACT-RIGHTS DISCIPLINE (§17): granted_rights is recorded DATA
--   on the result (NULL = nothing granted — an acquired capability grants
--   ONLY its explicit contract rights, never assumed, never inferred);
--   NO binary column, NO secret material, NO media bytes anywhere (the
--   delivered artifact is a bounded jsonb DESCRIPTOR).
-- * FK anchors are EXACTLY the tenant tables (agencies, clients,
--   workspaces) + same-module flow-stage rows — NO FK into /lab,
--   /lab-agent-body, /integrations or ANY other module (the /lab family
--   by-reference discipline: every cross-module citation is opaque uuid/
--   text/jsonb data).
-- * Scope-consistency triggers on every same-module citation: the chain
--   (contract → gap, estimate → contract, request → gap/contract/
--   estimate, result → request, verification → result + contract,
--   version → prior version + cited verification + cited gap, simulation/
--   real-test → version) keeps its client/agency/workspace scope —
--   cross-tenant chain poisoning is rejected at the DB (§22).
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, append-oriented stage records. No owner/role/user columns:
-- client-scope authorization stays exactly the requireClientAccess
-- route-layer authority — no second tenant, permission or identity
-- authority.

-- ---------------------------------------------------------------------------
-- Stage 1 — lab_capability_gaps (the CAPABILITY GAP records)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_capability_gaps (
    gap_id              uuid        PRIMARY KEY,
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id        uuid        REFERENCES workspaces(workspace_id),
    -- The flow spine: born open; contracted when a capability contract is
    -- derived; resolved when a verified capability version cites the chain;
    -- abandoned is the honest terminal for dropped acquisitions.
    status              text        NOT NULL
                        CHECK (status IN ('open', 'contracted', 'resolved', 'abandoned')),
    -- THE ACTOR SPLIT (§17): who detected the gap (the ordinary path is
    -- autonomous; a human may also surface a gap).
    detection_actor     text        NOT NULL
                        CHECK (detection_actor IN ('autonomous', 'human')),
    -- THE OPAQUE STRATEGY CITATION (recorded data — NO FK into /lab or any
    -- module): which candidate strategy required the unavailable action.
    strategy_citation   jsonb       NOT NULL
                        CHECK (jsonb_typeof(strategy_citation) = 'object'
                               AND strategy_citation ? 'strategyKind'
                               AND strategy_citation ? 'strategyReference'
                               AND strategy_citation->>'strategyKind' IN ('lab_strategy_candidate',
                                                                          'lab_organization_candidate',
                                                                          'lab_capability_candidate',
                                                                          'external')
                               AND char_length(strategy_citation->>'strategyReference') >= 1
                               AND char_length(strategy_citation->>'strategyReference') <= 256),
    -- THE REQUIRED ACTION SHAPE (§16 — the unavailable quality-preserving
    -- action, declared data; the closed action-kind vocabulary mirrors the
    -- §16 examples).
    required_action     jsonb       NOT NULL
                        CHECK (jsonb_typeof(required_action) = 'object'
                               AND required_action ? 'actionKind'
                               AND required_action->>'actionKind' IN ('physical_performance',
                                                                      'platform_action_gap',
                                                                      'authentic_demonstration',
                                                                      'specialized_media_treatment')
                               AND char_length(required_action->>'description') >= 1
                               AND char_length(required_action->>'description') <= 1024
                               AND char_length(required_action->>'qualityBar') >= 1
                               AND char_length(required_action->>'qualityBar') <= 512),
    -- The bounded detection rationale (the honest why).
    rationale           text        NOT NULL
                        CHECK (char_length(rationale) >= 1 AND char_length(rationale) <= 1024),
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'lab-capabilities-contract-v1'),
    created_at          timestamptz NOT NULL,
    updated_at          timestamptz NOT NULL
);

-- The client's gap tail.
CREATE INDEX IF NOT EXISTS lab_capability_gaps_client_idx
    ON lab_capability_gaps (client_id, created_at, gap_id);
-- The status facet (the open-gap probe).
CREATE INDEX IF NOT EXISTS lab_capability_gaps_status_idx
    ON lab_capability_gaps (client_id, status);

-- Gap identity is immutable after insert; ONLY the status and updated_at
-- may advance (open → contracted; contracted → resolved; open/contracted →
-- abandoned; no resurrection).
CREATE OR REPLACE FUNCTION lab_capability_gap_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.gap_id <> OLD.gap_id
       OR NEW.agency_id <> OLD.agency_id
       OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.detection_actor <> OLD.detection_actor
       OR NEW.strategy_citation <> OLD.strategy_citation
       OR NEW.required_action <> OLD.required_action
       OR NEW.rationale <> OLD.rationale
       OR NEW.contract_version <> OLD.contract_version
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'lab capability gap % identity/scope/citation is immutable — gap history is append-only',
            OLD.gap_id;
    END IF;
    IF NOT (
           (OLD.status = 'open' AND NEW.status IN ('contracted', 'abandoned'))
        OR (OLD.status = 'contracted' AND NEW.status IN ('resolved', 'abandoned'))
        OR (OLD.status = NEW.status)
    ) THEN
        RAISE EXCEPTION 'lab capability gap transition % → % is not legal (open → contracted → resolved; abandoned is terminal-reachable from open/contracted)',
            OLD.status, NEW.status;
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'lab capability gap % updated_at may not go backwards',
            OLD.gap_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_capability_gap_guard_trigger ON lab_capability_gaps;
CREATE TRIGGER lab_capability_gap_guard_trigger
    BEFORE UPDATE ON lab_capability_gaps
    FOR EACH ROW EXECUTE FUNCTION lab_capability_gap_guard();

-- Gaps are never deleted (the detection history is append-only).
CREATE OR REPLACE FUNCTION lab_capability_gaps_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab capability gaps cannot be deleted — gap history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_capability_gaps_no_delete_trigger ON lab_capability_gaps;
CREATE TRIGGER lab_capability_gaps_no_delete_trigger
    BEFORE DELETE ON lab_capability_gaps
    FOR EACH ROW EXECUTE FUNCTION lab_capability_gaps_no_delete();

-- ---------------------------------------------------------------------------
-- Stage 2 — lab_capability_contracts (the CAPABILITY CONTRACT records)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_capability_contracts (
    contract_id         uuid        PRIMARY KEY,
    -- The citing gap (same-module FK; scope-fenced below).
    gap_id              uuid        NOT NULL REFERENCES lab_capability_gaps(gap_id),
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id        uuid        REFERENCES workspaces(workspace_id),
    -- derived at creation; withdrawn is the honest retraction terminal.
    status              text        NOT NULL
                        CHECK (status IN ('derived', 'withdrawn')),
    -- THE ACTOR SPLIT: who derived the contract.
    actor               text        NOT NULL
                        CHECK (actor IN ('autonomous', 'human')),
    -- The required input/output schemas (the disclosed ONE-LEVEL schema
    -- subset — the LAB-011 message-contract discipline, validated
    -- module-side; the DB keeps the object fence).
    input_schema        jsonb       NOT NULL
                        CHECK (jsonb_typeof(input_schema) = 'object'),
    output_schema       jsonb       NOT NULL
                        CHECK (jsonb_typeof(output_schema) = 'object'),
    -- The declared constraints (bounded string array, module-validated).
    constraints         jsonb       NOT NULL
                        CHECK (jsonb_typeof(constraints) = 'array'),
    -- THE REQUIRED QUALITY EVALUATOR DECLARATION (§16: evaluator identity +
    -- version + the evaluation contract shape — the SAME declaration the
    -- acquired capability version will carry; verification runs THIS
    -- evaluator against the delivered result).
    quality_evaluator   jsonb       NOT NULL
                        CHECK (jsonb_typeof(quality_evaluator) = 'object'
                               AND quality_evaluator ? 'evaluatorId'
                               AND quality_evaluator ? 'evaluatorVersion'
                               AND quality_evaluator ? 'evaluationContract'
                               AND char_length(quality_evaluator->>'evaluatorId') >= 1
                               AND char_length(quality_evaluator->>'evaluatorId') <= 64
                               AND char_length(quality_evaluator->>'evaluatorVersion') >= 1
                               AND char_length(quality_evaluator->>'evaluatorVersion') <= 64
                               AND jsonb_typeof(quality_evaluator->'evaluationContract') = 'object'),
    -- The cost/latency ceilings (the acquisition's declared budget).
    cost_ceiling        jsonb       NOT NULL
                        CHECK (jsonb_typeof(cost_ceiling) = 'object'
                               AND cost_ceiling ? 'costModel'
                               AND cost_ceiling ? 'costUnits'
                               AND char_length(cost_ceiling->>'costModel') >= 1
                               AND char_length(cost_ceiling->>'costModel') <= 64
                               AND (cost_ceiling->>'costUnits')::numeric >= 0),
    latency_ceiling     jsonb       NOT NULL
                        CHECK (jsonb_typeof(latency_ceiling) = 'object'
                               AND latency_ceiling ? 'deadlineMs'
                               AND (latency_ceiling->>'deadlineMs')::numeric >= 1
                               AND (latency_ceiling->>'deadlineMs')::numeric <= 600000),
    -- The human/provider requirements (bounded object array,
    -- module-validated against the closed requirement-kind vocabulary).
    requirements        jsonb       NOT NULL
                        CHECK (jsonb_typeof(requirements) = 'array'),
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'lab-capabilities-contract-v1'),
    created_at          timestamptz NOT NULL,
    updated_at          timestamptz NOT NULL
);

-- The client's contract tail.
CREATE INDEX IF NOT EXISTS lab_capability_contracts_client_idx
    ON lab_capability_contracts (client_id, created_at, contract_id);
-- The gap's contract facet.
CREATE INDEX IF NOT EXISTS lab_capability_contracts_gap_idx
    ON lab_capability_contracts (client_id, gap_id, created_at);

-- Contract identity is immutable after insert; ONLY the status and
-- updated_at may advance (derived → withdrawn; no resurrection).
CREATE OR REPLACE FUNCTION lab_capability_contract_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.contract_id <> OLD.contract_id
       OR NEW.gap_id <> OLD.gap_id
       OR NEW.agency_id <> OLD.agency_id
       OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.actor <> OLD.actor
       OR NEW.input_schema <> OLD.input_schema
       OR NEW.output_schema <> OLD.output_schema
       OR NEW.constraints <> OLD.constraints
       OR NEW.quality_evaluator <> OLD.quality_evaluator
       OR NEW.cost_ceiling <> OLD.cost_ceiling
       OR NEW.latency_ceiling <> OLD.latency_ceiling
       OR NEW.requirements <> OLD.requirements
       OR NEW.contract_version <> OLD.contract_version
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'lab capability contract % identity/scope/contract is immutable — a revised requirement is a NEW contract record',
            OLD.contract_id;
    END IF;
    IF NOT (
           (OLD.status = 'derived' AND NEW.status = 'withdrawn')
        OR (OLD.status = NEW.status)
    ) THEN
        RAISE EXCEPTION 'lab capability contract transition % → % is not legal (derived → withdrawn; no resurrection)',
            OLD.status, NEW.status;
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'lab capability contract % updated_at may not go backwards',
            OLD.contract_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_capability_contract_guard_trigger ON lab_capability_contracts;
CREATE TRIGGER lab_capability_contract_guard_trigger
    BEFORE UPDATE ON lab_capability_contracts
    FOR EACH ROW EXECUTE FUNCTION lab_capability_contract_guard();

-- Contracts are never deleted (the requirement history is append-only).
CREATE OR REPLACE FUNCTION lab_capability_contracts_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab capability contracts cannot be deleted — requirement history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_capability_contracts_no_delete_trigger ON lab_capability_contracts;
CREATE TRIGGER lab_capability_contracts_no_delete_trigger
    BEFORE DELETE ON lab_capability_contracts
    FOR EACH ROW EXECUTE FUNCTION lab_capability_contracts_no_delete();

-- Scope consistency: a contract's scope must match its citing gap's scope
-- (cross-tenant chain poisoning is rejected at the DB — §22).
CREATE OR REPLACE FUNCTION lab_capability_contract_scope_check() RETURNS trigger AS $$
DECLARE
    gap_client uuid;
    gap_agency uuid;
    gap_workspace uuid;
BEGIN
    SELECT client_id, agency_id, workspace_id INTO gap_client, gap_agency, gap_workspace
        FROM lab_capability_gaps
        WHERE gap_id = NEW.gap_id;
    IF gap_client IS NULL THEN
        RAISE EXCEPTION 'lab capability contract must bind an existing gap (%)',
            NEW.gap_id;
    END IF;
    IF gap_client <> NEW.client_id OR gap_agency <> NEW.agency_id
       OR gap_workspace IS DISTINCT FROM NEW.workspace_id THEN
        RAISE EXCEPTION 'lab capability contract scope must match its gap scope (cross-tenant chain injection is rejected)';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_capability_contract_scope_trigger ON lab_capability_contracts;
CREATE TRIGGER lab_capability_contract_scope_trigger
    BEFORE INSERT ON lab_capability_contracts
    FOR EACH ROW EXECUTE FUNCTION lab_capability_contract_scope_check();

-- ---------------------------------------------------------------------------
-- Stage 3 — lab_capability_value_estimates (the VALUE ESTIMATE records)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_capability_value_estimates (
    estimate_id             uuid        PRIMARY KEY,
    contract_id             uuid        NOT NULL REFERENCES lab_capability_contracts(contract_id),
    agency_id               uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id               uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id            uuid        REFERENCES workspaces(workspace_id),
    -- recorded at creation; superseded when a revised estimate is recorded
    -- (a revision is a NEW record — never an in-place rewrite).
    status                  text        NOT NULL
                            CHECK (status IN ('recorded', 'superseded')),
    -- THE ACTOR SPLIT: who recorded the estimate.
    actor                   text        NOT NULL
                            CHECK (actor IN ('autonomous', 'human')),
    -- The estimated value of acquiring the capability (≥ 0 abstract units).
    estimated_value_units   numeric(18,4) NOT NULL
                            CHECK (estimated_value_units >= 0),
    -- The expected quality lift (may be zero — the honest no-lift state).
    expected_quality_lift   numeric(8,4) NOT NULL
                            CHECK (expected_quality_lift >= 0),
    -- The estimated acquisition cost ceiling (≥ 0).
    estimated_cost_ceiling  numeric(18,4) NOT NULL
                            CHECK (estimated_cost_ceiling >= 0),
    -- The honest uncertainty statement (bounded).
    uncertainty             text        NOT NULL
                            CHECK (char_length(uncertainty) >= 1 AND char_length(uncertainty) <= 512),
    -- The estimate basis (bounded — what the estimate was derived from).
    basis                   text        NOT NULL
                            CHECK (char_length(basis) >= 1 AND char_length(basis) <= 1024),
    contract_version        text        NOT NULL
                            CHECK (contract_version = 'lab-capabilities-contract-v1'),
    created_at              timestamptz NOT NULL,
    updated_at              timestamptz NOT NULL
);

-- The contract's estimate tail.
CREATE INDEX IF NOT EXISTS lab_capability_estimates_client_idx
    ON lab_capability_value_estimates (client_id, contract_id, created_at);

-- Estimate identity is immutable after insert; ONLY the status and
-- updated_at may advance (recorded → superseded; no resurrection).
CREATE OR REPLACE FUNCTION lab_capability_estimate_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.estimate_id <> OLD.estimate_id
       OR NEW.contract_id <> OLD.contract_id
       OR NEW.agency_id <> OLD.agency_id
       OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.actor <> OLD.actor
       OR NEW.estimated_value_units <> OLD.estimated_value_units
       OR NEW.expected_quality_lift <> OLD.expected_quality_lift
       OR NEW.estimated_cost_ceiling <> OLD.estimated_cost_ceiling
       OR NEW.uncertainty <> OLD.uncertainty
       OR NEW.basis <> OLD.basis
       OR NEW.contract_version <> OLD.contract_version
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'lab capability value estimate % identity/scope/figures is immutable — a revision is a NEW estimate record',
            OLD.estimate_id;
    END IF;
    IF NOT (
           (OLD.status = 'recorded' AND NEW.status = 'superseded')
        OR (OLD.status = NEW.status)
    ) THEN
        RAISE EXCEPTION 'lab capability value estimate transition % → % is not legal (recorded → superseded; no resurrection)',
            OLD.status, NEW.status;
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'lab capability value estimate % updated_at may not go backwards',
            OLD.estimate_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_capability_estimate_guard_trigger ON lab_capability_value_estimates;
CREATE TRIGGER lab_capability_estimate_guard_trigger
    BEFORE UPDATE ON lab_capability_value_estimates
    FOR EACH ROW EXECUTE FUNCTION lab_capability_estimate_guard();

-- Estimates are never deleted (the value-estimate history is append-only).
CREATE OR REPLACE FUNCTION lab_capability_estimates_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab capability value estimates cannot be deleted — estimate history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_capability_estimates_no_delete_trigger ON lab_capability_value_estimates;
CREATE TRIGGER lab_capability_estimates_no_delete_trigger
    BEFORE DELETE ON lab_capability_value_estimates
    FOR EACH ROW EXECUTE FUNCTION lab_capability_estimates_no_delete();

-- Scope consistency: an estimate's scope must match its contract's scope.
CREATE OR REPLACE FUNCTION lab_capability_estimate_scope_check() RETURNS trigger AS $$
DECLARE
    c_client uuid;
    c_agency uuid;
    c_workspace uuid;
BEGIN
    SELECT client_id, agency_id, workspace_id INTO c_client, c_agency, c_workspace
        FROM lab_capability_contracts
        WHERE contract_id = NEW.contract_id;
    IF c_client IS NULL THEN
        RAISE EXCEPTION 'lab capability value estimate must bind an existing contract (%)',
            NEW.contract_id;
    END IF;
    IF c_client <> NEW.client_id OR c_agency <> NEW.agency_id
       OR c_workspace IS DISTINCT FROM NEW.workspace_id THEN
        RAISE EXCEPTION 'lab capability value estimate scope must match its contract scope (cross-tenant chain injection is rejected)';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_capability_estimate_scope_trigger ON lab_capability_value_estimates;
CREATE TRIGGER lab_capability_estimate_scope_trigger
    BEFORE INSERT ON lab_capability_value_estimates
    FOR EACH ROW EXECUTE FUNCTION lab_capability_estimate_scope_check();

-- ---------------------------------------------------------------------------
-- Stage 4 — lab_capability_requests (the GOVERNED ARENA REQUEST records)
--
-- NO SECOND MARKETPLACE AUTHORITY (§17, structural): the provider target is
-- CALLER-DECLARED DATA (adapter_key + connection_id + operation) — there is
-- deliberately NO provider-selection, ranking, pricing, bidding, listing or
-- negotiation column anywhere; the dispatch flows through the EXISTING
-- /integrations provider contracts (the composition-root-wired structural
-- port), so the fail-closed policy/credential/capability gates stay in the
-- sole provider authority.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_capability_requests (
    request_id          uuid        PRIMARY KEY,
    -- The full chain citation (same-module FKs; scope-fenced below).
    gap_id              uuid        NOT NULL REFERENCES lab_capability_gaps(gap_id),
    contract_id         uuid        NOT NULL REFERENCES lab_capability_contracts(contract_id),
    estimate_id         uuid        NOT NULL REFERENCES lab_capability_value_estimates(estimate_id),
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id        uuid        REFERENCES workspaces(workspace_id),
    -- Born pending; the governed dispatch advances it to completed (the
    -- provider outcome fulfilled) or failed (the provider outcome refused);
    -- cancelled is the pre-dispatch retraction. No resurrection.
    status              text        NOT NULL
                        CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
    -- THE ACTOR SPLIT: who authorized the request (the ordinary path is
    -- autonomous; a human may authorize — never a prerequisite).
    actor               text        NOT NULL
                        CHECK (actor IN ('autonomous', 'human')),
    -- THE DECLARED PROVIDER TARGET (DATA, not selection): the /integrations
    -- adapter key + the connection id (OPAQUE — no FK into /integrations)
    -- + the normalized operation label (validated against the adapter's
    -- capability surface by the /integrations gates at dispatch time).
    adapter_key         text        NOT NULL
                        CHECK (char_length(adapter_key) >= 1 AND char_length(adapter_key) <= 64),
    connection_id       uuid        NOT NULL,
    operation           text        NOT NULL
                        CHECK (char_length(operation) >= 1 AND char_length(operation) <= 128),
    -- The governed request payload (the contract echo + the requested
    -- rights + the budget — bounded object data).
    request_parameters  jsonb       NOT NULL
                        CHECK (jsonb_typeof(request_parameters) = 'object'),
    -- THE REQUESTED RIGHTS (what MOS asks the contract to grant — recorded
    -- data; the GRANTED rights are recorded on the result, never here).
    requested_rights    jsonb       NOT NULL
                        CHECK (jsonb_typeof(requested_rights) = 'object'),
    -- The honest provider-outcome echo (set exactly once, at the dispatch
    -- advance; NULL before dispatch — never fabricated).
    provider_ok         boolean,
    provider_record_id  text        CHECK (provider_record_id IS NULL
                                       OR (char_length(provider_record_id) >= 1 AND char_length(provider_record_id) <= 256)),
    provider_error      text        CHECK (provider_error IS NULL
                                       OR (char_length(provider_error) >= 1 AND char_length(provider_error) <= 512)),
    dispatched_at       timestamptz,
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'lab-capabilities-contract-v1'),
    created_at          timestamptz NOT NULL,
    updated_at          timestamptz NOT NULL
);

-- The client's request tail.
CREATE INDEX IF NOT EXISTS lab_capability_requests_client_idx
    ON lab_capability_requests (client_id, created_at, request_id);
-- The gap's request facet.
CREATE INDEX IF NOT EXISTS lab_capability_requests_gap_idx
    ON lab_capability_requests (client_id, gap_id, created_at);
-- The status facet (the pending-request probe).
CREATE INDEX IF NOT EXISTS lab_capability_requests_status_idx
    ON lab_capability_requests (client_id, status);

-- Request identity is immutable after insert; ONLY the status, the
-- provider echo columns and updated_at may advance, and the echo columns
-- may move NULL → value ONLY as the status leaves 'pending' (the single
-- dispatch advance; frozen after).
CREATE OR REPLACE FUNCTION lab_capability_request_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.request_id <> OLD.request_id
       OR NEW.gap_id <> OLD.gap_id
       OR NEW.contract_id <> OLD.contract_id
       OR NEW.estimate_id <> OLD.estimate_id
       OR NEW.agency_id <> OLD.agency_id
       OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.actor <> OLD.actor
       OR NEW.adapter_key <> OLD.adapter_key
       OR NEW.connection_id <> OLD.connection_id
       OR NEW.operation <> OLD.operation
       OR NEW.request_parameters <> OLD.request_parameters
       OR NEW.requested_rights <> OLD.requested_rights
       OR NEW.contract_version <> OLD.contract_version
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'lab capability request % identity/scope/target is immutable — request history is append-only',
            OLD.request_id;
    END IF;
    IF NOT (
           (OLD.status = 'pending' AND NEW.status IN ('completed', 'failed', 'cancelled'))
        OR (OLD.status = NEW.status)
    ) THEN
        RAISE EXCEPTION 'lab capability request transition % → % is not legal (pending → completed/failed/cancelled; no reopen)',
            OLD.status, NEW.status;
    END IF;
    IF OLD.status = 'pending' THEN
        -- Leaving pending is the ONLY moment the echo columns may appear.
        IF NEW.status = 'cancelled' AND (NEW.provider_ok IS NOT NULL OR NEW.dispatched_at IS NOT NULL) THEN
            RAISE EXCEPTION 'lab capability request % cancellation may not fabricate a provider outcome',
                OLD.request_id;
        END IF;
    ELSE
        -- After the dispatch advance the echo columns are frozen.
        IF NEW.provider_ok IS DISTINCT FROM OLD.provider_ok
           OR NEW.provider_record_id IS DISTINCT FROM OLD.provider_record_id
           OR NEW.provider_error IS DISTINCT FROM OLD.provider_error
           OR NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at THEN
            RAISE EXCEPTION 'lab capability request % provider echo is frozen after the dispatch advance',
                OLD.request_id;
        END IF;
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'lab capability request % updated_at may not go backwards',
            OLD.request_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_capability_request_guard_trigger ON lab_capability_requests;
CREATE TRIGGER lab_capability_request_guard_trigger
    BEFORE UPDATE ON lab_capability_requests
    FOR EACH ROW EXECUTE FUNCTION lab_capability_request_guard();

-- Requests are never deleted (the acquisition history is append-only).
CREATE OR REPLACE FUNCTION lab_capability_requests_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab capability requests cannot be deleted — acquisition history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_capability_requests_no_delete_trigger ON lab_capability_requests;
CREATE TRIGGER lab_capability_requests_no_delete_trigger
    BEFORE DELETE ON lab_capability_requests
    FOR EACH ROW EXECUTE FUNCTION lab_capability_requests_no_delete();

-- Scope consistency: a request's scope must match its gap's, its
-- contract's AND its estimate's scope (the full chain).
CREATE OR REPLACE FUNCTION lab_capability_request_scope_check() RETURNS trigger AS $$
DECLARE
    gap_client uuid;
    gap_agency uuid;
    gap_workspace uuid;
    c_client uuid;
    c_agency uuid;
    c_workspace uuid;
    e_client uuid;
    e_agency uuid;
    e_workspace uuid;
BEGIN
    SELECT client_id, agency_id, workspace_id INTO gap_client, gap_agency, gap_workspace
        FROM lab_capability_gaps WHERE gap_id = NEW.gap_id;
    IF gap_client IS NULL THEN
        RAISE EXCEPTION 'lab capability request must bind an existing gap (%)', NEW.gap_id;
    END IF;
    SELECT client_id, agency_id, workspace_id INTO c_client, c_agency, c_workspace
        FROM lab_capability_contracts WHERE contract_id = NEW.contract_id;
    IF c_client IS NULL THEN
        RAISE EXCEPTION 'lab capability request must bind an existing contract (%)', NEW.contract_id;
    END IF;
    SELECT client_id, agency_id, workspace_id INTO e_client, e_agency, e_workspace
        FROM lab_capability_value_estimates WHERE estimate_id = NEW.estimate_id;
    IF e_client IS NULL THEN
        RAISE EXCEPTION 'lab capability request must bind an existing estimate (%)', NEW.estimate_id;
    END IF;
    IF NEW.client_id <> gap_client OR NEW.agency_id <> gap_agency OR NEW.workspace_id IS DISTINCT FROM gap_workspace
       OR NEW.client_id <> c_client OR NEW.agency_id <> c_agency OR NEW.workspace_id IS DISTINCT FROM c_workspace
       OR NEW.client_id <> e_client OR NEW.agency_id <> e_agency OR NEW.workspace_id IS DISTINCT FROM e_workspace THEN
        RAISE EXCEPTION 'lab capability request scope must match its gap/contract/estimate chain scope (cross-tenant chain injection is rejected)';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_capability_request_scope_trigger ON lab_capability_requests;
CREATE TRIGGER lab_capability_request_scope_trigger
    BEFORE INSERT ON lab_capability_requests
    FOR EACH ROW EXECUTE FUNCTION lab_capability_request_scope_check();

-- ---------------------------------------------------------------------------
-- Stage 5 — lab_capability_results (the HUMAN/PROVIDER RESULT records)
--
-- THE CONTRACT-RIGHTS DISCIPLINE (§17): granted_rights is recorded DATA —
-- NULL means NOTHING was granted (an acquired capability grants ONLY its
-- explicit contract rights, never assumed, never inferred). The delivered
-- artifact is a bounded jsonb DESCRIPTOR — NO binary column, NO media
-- bytes, NO secret material anywhere in this table.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_capability_results (
    result_id           uuid        PRIMARY KEY,
    request_id          uuid        NOT NULL REFERENCES lab_capability_requests(request_id),
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id        uuid        REFERENCES workspaces(workspace_id),
    -- THE CLOSED FULFILLMENT VOCABULARY: a provider outcome or a
    -- human-plane fulfillment (exactly one — the pairing fences below).
    fulfillment_kind    text        NOT NULL
                        CHECK (fulfillment_kind IN ('provider', 'human_plane')),
    -- THE ACTOR SPLIT: who fulfilled (a provider outcome recorded by the
    -- autonomous dispatch carries actor 'autonomous'; a human-plane
    -- fulfillment carries 'human').
    actor               text        NOT NULL
                        CHECK (actor IN ('autonomous', 'human')),
    -- The provider citation (non-null iff fulfillment_kind = 'provider';
    -- recorded data — the /integrations connection stays the authority).
    provider_adapter_key text       CHECK (provider_adapter_key IS NULL
                                       OR (char_length(provider_adapter_key) >= 1 AND char_length(provider_adapter_key) <= 64)),
    provider_record_id  text        CHECK (provider_record_id IS NULL
                                       OR (char_length(provider_record_id) >= 1 AND char_length(provider_record_id) <= 256)),
    -- THE HUMAN-PLANE CITATION (§17 — non-null iff fulfillment_kind =
    -- 'human_plane'; OPAQUE recorded data: the canonical plane authority +
    -- the record reference; NO FK into /field-agents, /jobs or /executions,
    -- NO re-modeling of the human plane — those authorities stay canonical).
    human_plane_citation jsonb      CHECK (human_plane_citation IS NULL
                                       OR (jsonb_typeof(human_plane_citation) = 'object'
                                           AND human_plane_citation ? 'planeAuthority'
                                           AND human_plane_citation ? 'recordReference'
                                           AND human_plane_citation->>'planeAuthority' IN ('field-agents', 'jobs', 'executions')
                                           AND char_length(human_plane_citation->>'recordReference') >= 1
                                           AND char_length(human_plane_citation->>'recordReference') <= 256)),
    -- The delivered artifact descriptor (bounded object data — never
    -- media bytes, never secrets).
    delivered_artifact  jsonb       NOT NULL
                        CHECK (jsonb_typeof(delivered_artifact) = 'object'),
    -- THE EXPLICIT CONTRACT-RIGHTS GRANT (recorded DATA; NULL = nothing
    -- granted beyond the explicit contract statement itself).
    granted_rights      jsonb       CHECK (granted_rights IS NULL
                                       OR jsonb_typeof(granted_rights) = 'object'),
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'lab-capabilities-contract-v1'),
    created_at          timestamptz NOT NULL,
    -- The fulfillment-kind pairing fences: a provider result carries its
    -- provider citation; a human-plane result carries its plane citation.
    CONSTRAINT lab_capability_results_provider_fence
        CHECK ((fulfillment_kind = 'provider') = (provider_adapter_key IS NOT NULL)),
    CONSTRAINT lab_capability_results_human_fence
        CHECK ((fulfillment_kind = 'human_plane') = (human_plane_citation IS NOT NULL))
);

-- The request's result tail.
CREATE INDEX IF NOT EXISTS lab_capability_results_client_idx
    ON lab_capability_results (client_id, created_at, result_id);
-- The request facet.
CREATE INDEX IF NOT EXISTS lab_capability_results_request_idx
    ON lab_capability_results (client_id, request_id, created_at);

-- Results are APPEND-ONLY OUTRIGHT (INSERT only — the fulfillment history
-- is never rewritten, exactly like the /lab-corpus observation tail).
CREATE OR REPLACE FUNCTION lab_capability_results_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab capability results are append-only (INSERT only — result % is immutable)',
        NEW.result_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_capability_results_no_update_trigger ON lab_capability_results;
CREATE TRIGGER lab_capability_results_no_update_trigger
    BEFORE UPDATE ON lab_capability_results
    FOR EACH ROW EXECUTE FUNCTION lab_capability_results_append_only();

DROP TRIGGER IF EXISTS lab_capability_results_no_delete_trigger ON lab_capability_results;
CREATE TRIGGER lab_capability_results_no_delete_trigger
    BEFORE DELETE ON lab_capability_results
    FOR EACH ROW EXECUTE FUNCTION lab_capability_results_append_only();

-- Scope consistency: a result's scope must match its request's scope.
CREATE OR REPLACE FUNCTION lab_capability_result_scope_check() RETURNS trigger AS $$
DECLARE
    r_client uuid;
    r_agency uuid;
    r_workspace uuid;
BEGIN
    SELECT client_id, agency_id, workspace_id INTO r_client, r_agency, r_workspace
        FROM lab_capability_requests
        WHERE request_id = NEW.request_id;
    IF r_client IS NULL THEN
        RAISE EXCEPTION 'lab capability result must bind an existing request (%)',
            NEW.request_id;
    END IF;
    IF r_client <> NEW.client_id OR r_agency <> NEW.agency_id
       OR r_workspace IS DISTINCT FROM NEW.workspace_id THEN
        RAISE EXCEPTION 'lab capability result scope must match its request scope (cross-tenant chain injection is rejected)';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_capability_result_scope_trigger ON lab_capability_results;
CREATE TRIGGER lab_capability_result_scope_trigger
    BEFORE INSERT ON lab_capability_results
    FOR EACH ROW EXECUTE FUNCTION lab_capability_result_scope_check();

-- ---------------------------------------------------------------------------
-- Stage 6 — lab_capability_verifications (the VERIFICATION records)
--
-- THE DECLARED EVALUATOR (§16): every verification echoes the evaluator
-- identity + version it ran (declared on the cited capability contract)
-- and records the verdict from the CLOSED vocabulary + the evaluation
-- evidence. The unverified-never-presented rule is enforced downstream:
-- a capability version may cite ONLY a verdict 'pass' verification.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_capability_verifications (
    verification_id     uuid        PRIMARY KEY,
    result_id           uuid        NOT NULL REFERENCES lab_capability_results(result_id),
    -- The contract whose declared quality evaluator was run (the
    -- declaration source — same-module FK, scope-fenced below).
    contract_id         uuid        NOT NULL REFERENCES lab_capability_contracts(contract_id),
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id        uuid        REFERENCES workspaces(workspace_id),
    -- THE CLOSED VERDICT VOCABULARY (born with the record — a verification
    -- is never rewritten; a re-verification is a NEW record).
    verdict             text        NOT NULL
                        CHECK (verdict IN ('pass', 'fail', 'inconclusive')),
    -- THE ACTOR SPLIT: who ran the verification (the ordinary path is
    -- autonomous; a human may verify).
    actor               text        NOT NULL
                        CHECK (actor IN ('autonomous', 'human')),
    -- The evaluator echo (identity + version — declared DATA from the
    -- contract, never re-declared here).
    evaluator_id        text        NOT NULL
                        CHECK (char_length(evaluator_id) >= 1 AND char_length(evaluator_id) <= 64),
    evaluator_version   text        NOT NULL
                        CHECK (char_length(evaluator_version) >= 1 AND char_length(evaluator_version) <= 64),
    -- The evaluation evidence (what the evaluator observed — bounded
    -- object data; a verdict without evidence is inexpressible).
    evaluation_evidence jsonb       NOT NULL
                        CHECK (jsonb_typeof(evaluation_evidence) = 'object'),
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'lab-capabilities-contract-v1'),
    created_at          timestamptz NOT NULL
);

-- The client's verification tail.
CREATE INDEX IF NOT EXISTS lab_capability_verifications_client_idx
    ON lab_capability_verifications (client_id, created_at, verification_id);
-- The result facet.
CREATE INDEX IF NOT EXISTS lab_capability_verifications_result_idx
    ON lab_capability_verifications (client_id, result_id, created_at);

-- Verifications are APPEND-ONLY OUTRIGHT (INSERT only — the verification
-- history is evidence).
CREATE OR REPLACE FUNCTION lab_capability_verifications_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab capability verifications are append-only (INSERT only — verification % is immutable)',
        NEW.verification_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_capability_verifications_no_update_trigger ON lab_capability_verifications;
CREATE TRIGGER lab_capability_verifications_no_update_trigger
    BEFORE UPDATE ON lab_capability_verifications
    FOR EACH ROW EXECUTE FUNCTION lab_capability_verifications_append_only();

DROP TRIGGER IF EXISTS lab_capability_verifications_no_delete_trigger ON lab_capability_verifications;
CREATE TRIGGER lab_capability_verifications_no_delete_trigger
    BEFORE DELETE ON lab_capability_verifications
    FOR EACH ROW EXECUTE FUNCTION lab_capability_verifications_append_only();

-- Scope consistency: a verification's scope must match its result's AND
-- its contract's scope.
CREATE OR REPLACE FUNCTION lab_capability_verification_scope_check() RETURNS trigger AS $$
DECLARE
    res_client uuid;
    res_agency uuid;
    res_workspace uuid;
    c_client uuid;
    c_agency uuid;
    c_workspace uuid;
BEGIN
    SELECT client_id, agency_id, workspace_id INTO res_client, res_agency, res_workspace
        FROM lab_capability_results WHERE result_id = NEW.result_id;
    IF res_client IS NULL THEN
        RAISE EXCEPTION 'lab capability verification must bind an existing result (%)', NEW.result_id;
    END IF;
    SELECT client_id, agency_id, workspace_id INTO c_client, c_agency, c_workspace
        FROM lab_capability_contracts WHERE contract_id = NEW.contract_id;
    IF c_client IS NULL THEN
        RAISE EXCEPTION 'lab capability verification must bind an existing contract (%)', NEW.contract_id;
    END IF;
    IF NEW.client_id <> res_client OR NEW.agency_id <> res_agency OR NEW.workspace_id IS DISTINCT FROM res_workspace
       OR NEW.client_id <> c_client OR NEW.agency_id <> c_agency OR NEW.workspace_id IS DISTINCT FROM c_workspace THEN
        RAISE EXCEPTION 'lab capability verification scope must match its result/contract scope (cross-tenant chain injection is rejected)';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_capability_verification_scope_trigger ON lab_capability_verifications;
CREATE TRIGGER lab_capability_verification_scope_trigger
    BEFORE INSERT ON lab_capability_verifications
    FOR EACH ROW EXECUTE FUNCTION lab_capability_verification_scope_check();

-- ---------------------------------------------------------------------------
-- Stage 7 — lab_capability_versions (the CAPABILITY VERSION records —
-- the §16 registry with the LAB-011 lifecycle discipline)
--
-- One row per (capability, version) carrying the FULL §16 declared field
-- set; corrections append NEW version rows under the SAME capability_id;
-- the lifecycle is draft → active → retired; identity is immutable; the
-- opaque version reference is '<capabilityId>#v<version>'.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_capability_versions (
    capability_id       uuid        NOT NULL,
    capability_version  integer     NOT NULL CHECK (capability_version >= 1 AND capability_version <= 1000),
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id        uuid        REFERENCES workspaces(workspace_id),
    -- The caller-declared stable key of the capability chain (immutable
    -- across the chain — the chain fence below).
    capability_key      text        NOT NULL
                        CHECK (char_length(capability_key) >= 1 AND char_length(capability_key) <= 64),
    display_name        text        NOT NULL
                        CHECK (char_length(display_name) >= 1 AND char_length(display_name) <= 128),
    -- THE §16 LIFECYCLE (the LAB-011 body-registry precedent).
    status              text        NOT NULL
                        CHECK (status IN ('draft', 'active', 'retired')),
    -- THE ACTOR SPLIT (§17 — every stage record carries its actor): who
    -- inserted this capability version (the ordinary path is
    -- autonomous; a human may declare/insert — never a prerequisite).
    actor               text        NOT NULL
                        CHECK (actor IN ('autonomous', 'human')),
    -- §16 input/output schemas (the disclosed ONE-LEVEL schema subset —
    -- validated module-side, the DB keeps the object fence).
    input_schema        jsonb       NOT NULL
                        CHECK (jsonb_typeof(input_schema) = 'object'),
    output_schema       jsonb       NOT NULL
                        CHECK (jsonb_typeof(output_schema) = 'object'),
    -- §16 constraints (bounded string array, module-validated).
    constraints         jsonb       NOT NULL
                        CHECK (jsonb_typeof(constraints) = 'array'),
    -- §16 quality evaluator (identity + version + the evaluation contract
    -- shape — the SAME declaration shape as the contract stage; verification
    -- runs THIS declared evaluator).
    quality_evaluator   jsonb       NOT NULL
                        CHECK (jsonb_typeof(quality_evaluator) = 'object'
                               AND quality_evaluator ? 'evaluatorId'
                               AND quality_evaluator ? 'evaluatorVersion'
                               AND quality_evaluator ? 'evaluationContract'
                               AND char_length(quality_evaluator->>'evaluatorId') >= 1
                               AND char_length(quality_evaluator->>'evaluatorId') <= 64
                               AND char_length(quality_evaluator->>'evaluatorVersion') >= 1
                               AND char_length(quality_evaluator->>'evaluatorVersion') <= 64
                               AND jsonb_typeof(quality_evaluator->'evaluationContract') = 'object'),
    -- §16 cost (the abstract cost model + units).
    cost                jsonb       NOT NULL
                        CHECK (jsonb_typeof(cost) = 'object'
                               AND cost ? 'costModel'
                               AND cost ? 'costUnits'
                               AND char_length(cost->>'costModel') >= 1
                               AND char_length(cost->>'costModel') <= 64
                               AND (cost->>'costUnits')::numeric >= 0),
    -- §16 latency (the expected P50/P95 + the deadline).
    latency             jsonb       NOT NULL
                        CHECK (jsonb_typeof(latency) = 'object'
                               AND latency ? 'expectedP50Ms'
                               AND latency ? 'expectedP95Ms'
                               AND latency ? 'deadlineMs'
                               AND (latency->>'expectedP50Ms')::numeric >= 0
                               AND (latency->>'expectedP95Ms')::numeric >= 0
                               AND (latency->>'deadlineMs')::numeric >= 1
                               AND (latency->>'deadlineMs')::numeric <= 600000),
    -- §16 provenance: the closed origin + the bounded provenance note
    -- (the origin column is the CHECK-fenced echo of the jsonb's origin
    -- field — one vocabulary, two representations, module-kept in sync).
    origin              text        NOT NULL
                        CHECK (origin IN ('first_party_declared', 'arena_provider', 'human_contribution')),
    provenance          jsonb       NOT NULL
                        CHECK (jsonb_typeof(provenance) = 'object'
                               AND provenance ? 'origin'
                               AND provenance->>'origin' IN ('first_party_declared', 'arena_provider', 'human_contribution')),
    -- §16 implementation/version (the implementation identity + version +
    -- the closed implementation kind).
    implementation      jsonb       NOT NULL
                        CHECK (jsonb_typeof(implementation) = 'object'
                               AND implementation ? 'implementationId'
                               AND implementation ? 'implementationVersion'
                               AND implementation ? 'implementationKind'
                               AND char_length(implementation->>'implementationId') >= 1
                               AND char_length(implementation->>'implementationId') <= 128
                               AND char_length(implementation->>'implementationVersion') >= 1
                               AND char_length(implementation->>'implementationVersion') <= 64
                               AND implementation->>'implementationKind' IN ('simulator', 'real', 'hybrid', 'declared_only')),
    -- §16 simulator implementation IF AVAILABLE (NULL = not available —
    -- the honest unavailable state, never fabricated).
    simulator_implementation jsonb   CHECK (simulator_implementation IS NULL
                                       OR (jsonb_typeof(simulator_implementation) = 'object'
                                           AND simulator_implementation ? 'implementationId'
                                           AND simulator_implementation ? 'implementationVersion'
                                           AND char_length(simulator_implementation->>'implementationId') >= 1
                                           AND char_length(simulator_implementation->>'implementationId') <= 128
                                           AND char_length(simulator_implementation->>'implementationVersion') >= 1
                                           AND char_length(simulator_implementation->>'implementationVersion') <= 64)),
    -- §16 real implementation IF AVAILABLE (NULL = not available).
    real_implementation jsonb       CHECK (real_implementation IS NULL
                                       OR (jsonb_typeof(real_implementation) = 'object'
                                           AND real_implementation ? 'implementationId'
                                           AND real_implementation ? 'implementationVersion'
                                           AND char_length(real_implementation->>'implementationId') >= 1
                                           AND char_length(real_implementation->>'implementationId') <= 128
                                           AND char_length(real_implementation->>'implementationVersion') >= 1
                                           AND char_length(real_implementation->>'implementationVersion') <= 64)),
    -- §16 human/provider requirements (bounded object array,
    -- module-validated against the closed requirement-kind vocabulary).
    requirements        jsonb       NOT NULL
                        CHECK (jsonb_typeof(requirements) = 'array'),
    -- THE ACQUISITION CITATIONS (NULL for the first-party declared path):
    -- the PASSING verification that produced this version (the
    -- unverified-never-presented trigger fence below) and the gap the
    -- acquisition resolved.
    source_verification_id uuid     REFERENCES lab_capability_verifications(verification_id),
    source_gap_id       uuid        REFERENCES lab_capability_gaps(gap_id),
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'lab-capabilities-contract-v1'),
    created_at          timestamptz NOT NULL,
    updated_at          timestamptz NOT NULL,
    CONSTRAINT lab_capability_versions_pk PRIMARY KEY (capability_id, capability_version)
);

-- The client's capability tail (newest version last).
CREATE INDEX IF NOT EXISTS lab_capability_versions_client_idx
    ON lab_capability_versions (client_id, capability_id, capability_version, created_at);
-- The status facet (the active-capability probe).
CREATE INDEX IF NOT EXISTS lab_capability_versions_status_idx
    ON lab_capability_versions (client_id, status);

-- Capability version identity is immutable after insert; only the
-- lifecycle status and the server-managed updated_at may advance
-- (corrections are NEW version rows — the append-only correction path).
CREATE OR REPLACE FUNCTION lab_capability_version_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.capability_id <> OLD.capability_id
       OR NEW.capability_version <> OLD.capability_version
       OR NEW.agency_id <> OLD.agency_id
       OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.capability_key <> OLD.capability_key
       OR NEW.display_name <> OLD.display_name
       OR NEW.actor <> OLD.actor
       OR NEW.input_schema <> OLD.input_schema
       OR NEW.output_schema <> OLD.output_schema
       OR NEW.constraints <> OLD.constraints
       OR NEW.quality_evaluator <> OLD.quality_evaluator
       OR NEW.cost <> OLD.cost
       OR NEW.latency <> OLD.latency
       OR NEW.origin <> OLD.origin
       OR NEW.provenance <> OLD.provenance
       OR NEW.implementation <> OLD.implementation
       OR NEW.simulator_implementation IS DISTINCT FROM OLD.simulator_implementation
       OR NEW.real_implementation IS DISTINCT FROM OLD.real_implementation
       OR NEW.requirements <> OLD.requirements
       OR NEW.source_verification_id IS DISTINCT FROM OLD.source_verification_id
       OR NEW.source_gap_id IS DISTINCT FROM OLD.source_gap_id
       OR NEW.contract_version <> OLD.contract_version
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'lab capability % version % identity/scope/contract is immutable — corrections are NEW version rows',
            OLD.capability_id, OLD.capability_version;
    END IF;
    IF NOT (
           (OLD.status = 'draft' AND NEW.status IN ('active', 'retired'))
        OR (OLD.status = 'active' AND NEW.status = 'retired')
        OR (OLD.status = NEW.status)
    ) THEN
        RAISE EXCEPTION 'lab capability transition % → % is not legal (draft → active → retired; no resurrection)',
            OLD.status, NEW.status;
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'lab capability % version % updated_at may not go backwards',
            OLD.capability_id, OLD.capability_version;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_capability_version_guard_trigger ON lab_capability_versions;
CREATE TRIGGER lab_capability_version_guard_trigger
    BEFORE UPDATE ON lab_capability_versions
    FOR EACH ROW EXECUTE FUNCTION lab_capability_version_guard();

-- Capability versions are never deleted (the registry history is
-- append-only).
CREATE OR REPLACE FUNCTION lab_capability_versions_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab capability versions cannot be deleted — capability history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_capability_versions_no_delete_trigger ON lab_capability_versions;
CREATE TRIGGER lab_capability_versions_no_delete_trigger
    BEFORE DELETE ON lab_capability_versions
    FOR EACH ROW EXECUTE FUNCTION lab_capability_versions_no_delete();

-- The version-chain scope fence (the LAB-011 chain discipline): a
-- correction (version > 1) must keep the chain's scope AND the chain's
-- capability key — cross-tenant or cross-key chain poisoning is rejected
-- at the DB.
CREATE OR REPLACE FUNCTION lab_capability_chain_scope_check() RETURNS trigger AS $$
DECLARE
    chain_client uuid;
    chain_agency uuid;
    chain_workspace uuid;
    chain_key text;
BEGIN
    IF NEW.capability_version > 1 THEN
        SELECT client_id, agency_id, workspace_id, capability_key
            INTO chain_client, chain_agency, chain_workspace, chain_key
            FROM lab_capability_versions
            WHERE capability_id = NEW.capability_id AND capability_version = NEW.capability_version - 1;
        IF chain_client IS NULL THEN
            RAISE EXCEPTION 'lab capability version chain is broken (%, %)',
                NEW.capability_id, NEW.capability_version - 1;
        END IF;
        IF chain_client <> NEW.client_id OR chain_agency <> NEW.agency_id
           OR chain_workspace IS DISTINCT FROM NEW.workspace_id
           OR chain_key <> NEW.capability_key THEN
            RAISE EXCEPTION 'lab capability correction must keep the version chain scope and key (cross-tenant/cross-key corrections are rejected)';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_capability_chain_scope_trigger ON lab_capability_versions;
CREATE TRIGGER lab_capability_chain_scope_trigger
    BEFORE INSERT ON lab_capability_versions
    FOR EACH ROW EXECUTE FUNCTION lab_capability_chain_scope_check();

-- THE UNVERIFIED-NEVER-PRESENTED FENCE (the core verification discipline):
-- a capability version that cites a verification may cite ONLY a verdict
-- 'pass' verification in the SAME scope (a version citing a failing or
-- inconclusive verification is inexpressible; a version with NO citation
-- is honestly unverified — the first-party declared path).
CREATE OR REPLACE FUNCTION lab_capability_verification_citation_check() RETURNS trigger AS $$
DECLARE
    v_verdict text;
    v_client uuid;
    v_agency uuid;
    v_workspace uuid;
BEGIN
    IF NEW.source_verification_id IS NOT NULL THEN
        SELECT verdict, client_id, agency_id, workspace_id
            INTO v_verdict, v_client, v_agency, v_workspace
            FROM lab_capability_verifications
            WHERE verification_id = NEW.source_verification_id;
        IF v_verdict IS NULL THEN
            RAISE EXCEPTION 'lab capability version must cite an existing verification (%)',
                NEW.source_verification_id;
        END IF;
        IF v_verdict <> 'pass' THEN
            RAISE EXCEPTION 'lab capability version may cite only a PASSING verification (cited verdict: % — the unverified-never-presented rule)',
                v_verdict;
        END IF;
        IF v_client <> NEW.client_id OR v_agency <> NEW.agency_id
           OR v_workspace IS DISTINCT FROM NEW.workspace_id THEN
            RAISE EXCEPTION 'lab capability version must cite a verification in its own scope (cross-tenant citation is rejected)';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_capability_verification_citation_trigger ON lab_capability_versions;
CREATE TRIGGER lab_capability_verification_citation_trigger
    BEFORE INSERT ON lab_capability_versions
    FOR EACH ROW EXECUTE FUNCTION lab_capability_verification_citation_check();

-- The acquisition-gap citation fence: when present, the cited gap must
-- exist in the same scope.
CREATE OR REPLACE FUNCTION lab_capability_gap_citation_check() RETURNS trigger AS $$
DECLARE
    g_client uuid;
    g_agency uuid;
    g_workspace uuid;
BEGIN
    IF NEW.source_gap_id IS NOT NULL THEN
        SELECT client_id, agency_id, workspace_id
            INTO g_client, g_agency, g_workspace
            FROM lab_capability_gaps
            WHERE gap_id = NEW.source_gap_id;
        IF g_client IS NULL THEN
            RAISE EXCEPTION 'lab capability version must cite an existing gap (%)',
                NEW.source_gap_id;
        END IF;
        IF g_client <> NEW.client_id OR g_agency <> NEW.agency_id
           OR g_workspace IS DISTINCT FROM NEW.workspace_id THEN
            RAISE EXCEPTION 'lab capability version must cite a gap in its own scope (cross-tenant citation is rejected)';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_capability_gap_citation_trigger ON lab_capability_versions;
CREATE TRIGGER lab_capability_gap_citation_trigger
    BEFORE INSERT ON lab_capability_versions
    FOR EACH ROW EXECUTE FUNCTION lab_capability_gap_citation_check();

-- ---------------------------------------------------------------------------
-- Stage 8 — lab_capability_simulations (the SIMULATION link records)
--
-- The OPAQUE citation of the /lab simulation run that exercised the
-- capability version (NO FK into /lab — the durable simulation runtime is
-- the /lab authority; this module only records the link + the outcome).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_capability_simulations (
    simulation_id       uuid        PRIMARY KEY,
    capability_id       uuid        NOT NULL,
    capability_version  integer     NOT NULL,
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id        uuid        REFERENCES workspaces(workspace_id),
    -- THE ACTOR SPLIT: who recorded the simulation link.
    actor               text        NOT NULL
                        CHECK (actor IN ('autonomous', 'human')),
    -- The OPAQUE simulation-run citation (recorded data — the /lab run
    -- stays the authority).
    simulation_reference text       NOT NULL
                        CHECK (char_length(simulation_reference) >= 1 AND char_length(simulation_reference) <= 256),
    -- The closed outcome vocabulary (born with the record).
    outcome             text        NOT NULL
                        CHECK (outcome IN ('passed', 'failed', 'inconclusive')),
    -- The bounded evidence object.
    evidence            jsonb       NOT NULL
                        CHECK (jsonb_typeof(evidence) = 'object'),
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'lab-capabilities-contract-v1'),
    created_at          timestamptz NOT NULL,
    -- The version anchor (same-module composite FK).
    CONSTRAINT lab_capability_simulations_version_fk
        FOREIGN KEY (capability_id, capability_version)
        REFERENCES lab_capability_versions (capability_id, capability_version)
);

-- The client's simulation tail.
CREATE INDEX IF NOT EXISTS lab_capability_simulations_client_idx
    ON lab_capability_simulations (client_id, created_at, simulation_id);
-- The version facet.
CREATE INDEX IF NOT EXISTS lab_capability_simulations_version_idx
    ON lab_capability_simulations (client_id, capability_id, capability_version, created_at);

-- Simulation links are APPEND-ONLY OUTRIGHT.
CREATE OR REPLACE FUNCTION lab_capability_simulations_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab capability simulation links are append-only (INSERT only — link % is immutable)',
        NEW.simulation_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_capability_simulations_no_update_trigger ON lab_capability_simulations;
CREATE TRIGGER lab_capability_simulations_no_update_trigger
    BEFORE UPDATE ON lab_capability_simulations
    FOR EACH ROW EXECUTE FUNCTION lab_capability_simulations_append_only();

DROP TRIGGER IF EXISTS lab_capability_simulations_no_delete_trigger ON lab_capability_simulations;
CREATE TRIGGER lab_capability_simulations_no_delete_trigger
    BEFORE DELETE ON lab_capability_simulations
    FOR EACH ROW EXECUTE FUNCTION lab_capability_simulations_append_only();

-- Scope consistency: a simulation link's scope must match its capability
-- version's scope.
CREATE OR REPLACE FUNCTION lab_capability_simulation_scope_check() RETURNS trigger AS $$
DECLARE
    v_client uuid;
    v_agency uuid;
    v_workspace uuid;
BEGIN
    SELECT client_id, agency_id, workspace_id INTO v_client, v_agency, v_workspace
        FROM lab_capability_versions
        WHERE capability_id = NEW.capability_id AND capability_version = NEW.capability_version;
    IF v_client IS NULL THEN
        RAISE EXCEPTION 'lab capability simulation link must bind an existing capability version (%, %)',
            NEW.capability_id, NEW.capability_version;
    END IF;
    IF v_client <> NEW.client_id OR v_agency <> NEW.agency_id
       OR v_workspace IS DISTINCT FROM NEW.workspace_id THEN
        RAISE EXCEPTION 'lab capability simulation link scope must match its capability version scope (cross-tenant chain injection is rejected)';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_capability_simulation_scope_trigger ON lab_capability_simulations;
CREATE TRIGGER lab_capability_simulation_scope_trigger
    BEFORE INSERT ON lab_capability_simulations
    FOR EACH ROW EXECUTE FUNCTION lab_capability_simulation_scope_check();

-- ---------------------------------------------------------------------------
-- Stage 9 — lab_capability_real_tests (the REAL-TEST link records)
--
-- The OPAQUE citation of the real-plane authority record (experiments/
-- executions/evidence/workflows — the existing authorities own real tests;
-- this module only links) + the outcome.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_capability_real_tests (
    real_test_id        uuid        PRIMARY KEY,
    capability_id       uuid        NOT NULL,
    capability_version  integer     NOT NULL,
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id        uuid        REFERENCES workspaces(workspace_id),
    -- THE ACTOR SPLIT: who recorded the real-test link.
    actor               text        NOT NULL
                        CHECK (actor IN ('autonomous', 'human')),
    -- THE OPAQUE REAL-PLANE CITATION (recorded data — the real authority
    -- stays canonical; NO FK into /experiments, /executions, /evidence or
    -- /workflows).
    real_test_citation  jsonb       NOT NULL
                        CHECK (jsonb_typeof(real_test_citation) = 'object'
                               AND real_test_citation ? 'authority'
                               AND real_test_citation ? 'recordReference'
                               AND real_test_citation->>'authority' IN ('experiments', 'executions', 'evidence', 'workflows')
                               AND char_length(real_test_citation->>'recordReference') >= 1
                               AND char_length(real_test_citation->>'recordReference') <= 256),
    -- The closed outcome vocabulary (born with the record).
    outcome             text        NOT NULL
                        CHECK (outcome IN ('passed', 'failed', 'inconclusive')),
    -- The bounded evidence object.
    evidence            jsonb       NOT NULL
                        CHECK (jsonb_typeof(evidence) = 'object'),
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'lab-capabilities-contract-v1'),
    created_at          timestamptz NOT NULL,
    -- The version anchor (same-module composite FK).
    CONSTRAINT lab_capability_real_tests_version_fk
        FOREIGN KEY (capability_id, capability_version)
        REFERENCES lab_capability_versions (capability_id, capability_version)
);

-- The client's real-test tail.
CREATE INDEX IF NOT EXISTS lab_capability_real_tests_client_idx
    ON lab_capability_real_tests (client_id, created_at, real_test_id);
-- The version facet.
CREATE INDEX IF NOT EXISTS lab_capability_real_tests_version_idx
    ON lab_capability_real_tests (client_id, capability_id, capability_version, created_at);

-- Real-test links are APPEND-ONLY OUTRIGHT.
CREATE OR REPLACE FUNCTION lab_capability_real_tests_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab capability real-test links are append-only (INSERT only — link % is immutable)',
        NEW.real_test_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_capability_real_tests_no_update_trigger ON lab_capability_real_tests;
CREATE TRIGGER lab_capability_real_tests_no_update_trigger
    BEFORE UPDATE ON lab_capability_real_tests
    FOR EACH ROW EXECUTE FUNCTION lab_capability_real_tests_append_only();

DROP TRIGGER IF EXISTS lab_capability_real_tests_no_delete_trigger ON lab_capability_real_tests;
CREATE TRIGGER lab_capability_real_tests_no_delete_trigger
    BEFORE DELETE ON lab_capability_real_tests
    FOR EACH ROW EXECUTE FUNCTION lab_capability_real_tests_append_only();

-- Scope consistency: a real-test link's scope must match its capability
-- version's scope.
CREATE OR REPLACE FUNCTION lab_capability_real_test_scope_check() RETURNS trigger AS $$
DECLARE
    v_client uuid;
    v_agency uuid;
    v_workspace uuid;
BEGIN
    SELECT client_id, agency_id, workspace_id INTO v_client, v_agency, v_workspace
        FROM lab_capability_versions
        WHERE capability_id = NEW.capability_id AND capability_version = NEW.capability_version;
    IF v_client IS NULL THEN
        RAISE EXCEPTION 'lab capability real-test link must bind an existing capability version (%, %)',
            NEW.capability_id, NEW.capability_version;
    END IF;
    IF v_client <> NEW.client_id OR v_agency <> NEW.agency_id
       OR v_workspace IS DISTINCT FROM NEW.workspace_id THEN
        RAISE EXCEPTION 'lab capability real-test link scope must match its capability version scope (cross-tenant chain injection is rejected)';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_capability_real_test_scope_trigger ON lab_capability_real_tests;
CREATE TRIGGER lab_capability_real_test_scope_trigger
    BEFORE INSERT ON lab_capability_real_tests
    FOR EACH ROW EXECUTE FUNCTION lab_capability_real_test_scope_check();
