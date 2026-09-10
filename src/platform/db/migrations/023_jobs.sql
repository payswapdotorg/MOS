-- MKT-026 Job marketplace boundary schema (JOB-001, JOB-AC-01..03;
-- spec/job-offer-v1.2.md; spec/human-agent-v1.3.md §3/§4; spec/
-- implementation-clarifications-v1.2.md "Job Offers"; architecture.md §13
-- "Jobs are governed projections of Tasks using candidate-specific Offers
-- and the existing concurrency-safe acceptance contract").
-- PostgreSQL is the system of record (spec/architecture-lock.md).
--
-- Table ownership follows the frozen authority map (implementation-contract
-- §1): jobs/job_offers/job_outcomes → /jobs (Human Job lifecycle). This
-- migration creates EXACTLY these three tables.
--
-- Frozen semantics encoded here:
--   * a Job is a governed PROJECTION of ONE Task occurrence — the logical
--     Task coordinates (workflow instance + node within the instance's
--     pinned definition). "A Job represents exactly one Task projection"
--     (implementation-clarifications-v1.2.md "Job Offers"): the
--     (workflow_instance_id, node_id) pair is UNIQUE-fenced, so projecting
--     the same Task twice is rejected by the database itself — no second
--     assignment identity is ever creatable for one Task (JOB-AC-01);
--   * the Task reference is FK-backed to the workflow-authoritative
--     workflow_instances row and DB-backstopped by THREE triggers:
--     (1) task_reference: the instance must be RUNNING at projection time
--         AND the node must exist in the instance's pinned ACTIVE
--         definition graph AND be a 'human_task' node (only human Tasks
--         project into Jobs).
--     (2) scope_chain: the Job's scope (workspace/client/agency) must equal
--         the instance's server-derived scope, the workspace must belong to
--         the recorded client and the client to the recorded agency —
--         the same within-client backstop the house pattern uses, extended
--         so a Job can never cross its commissioning Task's scope
--         (every Job is scoped to exactly one commissioning Agency and
--         Client, architecture.md §13 / human-agent-v1.3.md §3);
--     (3) identity_immutable: job identity, the Task reference, the scope
--         chain and the public descriptor are immutable through ANY
--         mutation path;
--   * the Job status machine is the frozen MKT-026 lifecycle
--     (projected → offered; offered → accepted | declined | expired;
--     accepted → outcome_submitted) edge-for-edge in a DB trigger;
--     declined/expired/outcome_submitted are TERMINAL (frozen rows);
--   * acceptance columns exist ONLY in the accepted/outcome_submitted
--     states and are NOT NULL there (CHECK);
--   * Offers are candidate-specific persisted records (job + candidate
--     Human Agent + expiry) — job-offer-v1.2.md "Offer model". The offer
--     status machine (open → accepted | declined | expired | withdrawn;
--     every terminal state frozen) is DB-backstopped; terminal states
--     carry an explicit terminal_reason (claimed | declined | expiry |
--     lost | withdrawn) — "Losing offers transition to EXPIRED or
--     WITHDRAWN and cannot later claim the Job";
--   * EXACTLY ONE WINNER per Job (job-offer-v1.2.md "At most one Offer may
--     atomically win a single-acceptance Job"): a partial UNIQUE index
--     enforces at most one accepted offer per job — the concurrency-safe
--     claim backstop even if every application check were bypassed;
--   * one OPEN offer per (job, candidate) — a duplicate open offer for the
--     same candidate is rejected by the database;
--   * the candidate denormalized user id is backstopped to equal the
--     candidate agent profile's immutable platform identity link;
--   * the submitted outcome (JOB-AC-03) is APPEND-ONLY history with
--     server-derived provenance columns (recorded_actor, recorded_via,
--     correlation_id, causation_id, submitted_by, submitted_at), exactly
--     ONE outcome per job (UNIQUE fence — replay converges, a different
--     logical submission is a conflict), a frozen outcome vocabulary
--     (succeeded | failed) and an evidence_ref FK to the /evidence
--     authority's immutable record fenced to the SAME Client (the metrics
--     pattern) — the outcome preserves actor and evidence provenance and
--     never rewrites history;
--   * NO workflow state is owned here: no instance transition is commanded,
--     no node/edge semantics, no graph validation, no downstream
--     scheduling — the outcome record REPORTS (with the observed instance
--     status at report time) and the workflow authority decides.
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers (uuid), created_at/updated_at, version CAS for row mutation,
-- DB-fenced uniqueness (duplicate convergence fails closed), append-only
-- history where history matters. No secrets in domain records. No owner/
-- role/user authorization columns: authorization stays exactly the
-- /agencies membership authority composed with canonical owner resolution
-- (jobs → workflow instance → workflow → workspace → client → agency).

CREATE TABLE IF NOT EXISTS jobs (
    job_id                uuid        PRIMARY KEY,
    -- The governed Task reference (JOB-AC-01): FK to the workflow-authoritative instance.
    -- No ON DELETE CASCADE: an existing Job PROTECTS its Task's instance row —
    -- the projection history cannot be deleted underneath.
    workflow_instance_id  uuid        NOT NULL REFERENCES workflow_instances(workflow_instance_id),
    node_id               text        NOT NULL CHECK (length(node_id) BETWEEN 1 AND 200),
    workspace_id          uuid        NOT NULL REFERENCES workspaces(workspace_id),
    client_id             uuid        NOT NULL REFERENCES clients(client_id),
    agency_id             uuid        NOT NULL REFERENCES agencies(agency_id) ON DELETE CASCADE,
    -- The MINIMUM public descriptor (human-agent-v1.3 §3): what an eligible
    -- agent needs to recognize the work. No Client-specific data.
    title                 text        NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    description           text        NOT NULL CHECK (length(description) BETWEEN 0 AND 2000),
    -- The job eligibility specification (profile-data-only requirements:
    -- specialization, capabilities, optional territory, availability window)
    -- consumed by the /field-agents pure matcher. jsonb object.
    eligibility           jsonb       NOT NULL CHECK (jsonb_typeof(eligibility) = 'object'),
    status                text        NOT NULL DEFAULT 'projected'
                          CHECK (status IN ('projected', 'offered', 'accepted', 'declined',
                                            'expired', 'outcome_submitted')),
    -- Acceptance fields (the winning claim): present exactly in accepted/
    -- outcome_submitted states (CHECKs below). accepted_offer_id is a plain
    -- uuid because job_offers (created later in this migration) references
    -- jobs — the module validates it and the one-winner fence pins it.
    accepted_agent_id     uuid        REFERENCES human_agents(agent_id),
    accepted_user_id      uuid        REFERENCES users(user_id),
    accepted_offer_id     uuid,
    accepted_at           timestamptz,
    created_by            uuid        REFERENCES users(user_id),
    version               bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),

    -- Acceptance columns are set exactly when the job reaches accepted/
    -- outcome_submitted, and never otherwise.
    CHECK (
        (status IN ('accepted', 'outcome_submitted'))
        OR (accepted_agent_id IS NULL AND accepted_user_id IS NULL
            AND accepted_offer_id IS NULL AND accepted_at IS NULL)
    ),
    CHECK (
        (status NOT IN ('accepted', 'outcome_submitted'))
        OR (accepted_agent_id IS NOT NULL AND accepted_user_id IS NOT NULL
            AND accepted_offer_id IS NOT NULL AND accepted_at IS NOT NULL)
    )
);

-- JOB-AC-01 identity fence: ONE Job per governed Task occurrence — "A Job
-- represents exactly one Task projection"; a second projection of the same
-- (instance, node) Task is rejected by the database itself, so distribution
-- can never create a second assignment identity for one Task.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_task_key ON jobs (workflow_instance_id, node_id);

-- Marketplace scan surface: the offerable jobs (projected/offered).
CREATE INDEX IF NOT EXISTS jobs_offerable_idx
    ON jobs (created_at, job_id) WHERE status IN ('projected', 'offered');

-- Commissioning listing surface: the jobs of one workflow instance.
CREATE INDEX IF NOT EXISTS jobs_instance_idx
    ON jobs (workflow_instance_id, created_at, job_id);

-- ---------------------------------------------------------------------------
-- The frozen MKT-026 Job state machine, shared by the row trigger:
--   projected → offered
--   offered   → accepted | declined | expired
--   accepted  → outcome_submitted
-- and NOTHING else. declined/expired/outcome_submitted are TERMINAL —
-- frozen history (no outgoing transitions, no self-loops, no skip-edges).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION jobs_transition_legal(from_status text, to_status text)
RETURNS boolean AS $$
BEGIN
    RETURN (
        (from_status = 'projected' AND to_status = 'offered')
        OR (from_status = 'offered' AND to_status IN ('accepted', 'declined', 'expired'))
        OR (from_status = 'accepted' AND to_status = 'outcome_submitted')
    );
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- State-machine backstop: the database itself rejects every illegal status
-- change on a Job — including ANY change to a TERMINAL row.
CREATE OR REPLACE FUNCTION jobs_frozen_state_machine() RETURNS trigger AS $$
BEGIN
    IF NOT jobs_transition_legal(OLD.status, NEW.status) THEN
        IF OLD.status IN ('declined', 'expired', 'outcome_submitted') THEN
            RAISE EXCEPTION 'job % is % (terminal) and frozen: terminal states are immutable',
                OLD.job_id, OLD.status;
        END IF;
        IF OLD.status = NEW.status THEN
            RAISE EXCEPTION 'job % self-transition % → % is illegal (no self-loops in the frozen job state machine)',
                OLD.job_id, OLD.status, NEW.status;
        END IF;
        RAISE EXCEPTION 'illegal job transition % → % (frozen MKT-026 job state machine)',
            OLD.status, NEW.status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jobs_frozen_state_machine_trigger ON jobs;
CREATE TRIGGER jobs_frozen_state_machine_trigger
    BEFORE UPDATE ON jobs
    FOR EACH ROW EXECUTE FUNCTION jobs_frozen_state_machine();

-- Immutability backstop (implementation-contract §3): job identity, the
-- governed Task reference, the server-derived scope chain, the public
-- descriptor, the eligibility specification and provenance can NEVER be
-- reassigned through ANY mutation path — a Job can never float to another
-- Task, scope or contract.
CREATE OR REPLACE FUNCTION jobs_identity_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW.job_id <> OLD.job_id THEN
        RAISE EXCEPTION 'job_id % is immutable', OLD.job_id;
    END IF;
    IF NEW.workflow_instance_id <> OLD.workflow_instance_id THEN
        RAISE EXCEPTION 'job % cannot change its Task workflow instance (was instance %)',
            OLD.job_id, OLD.workflow_instance_id;
    END IF;
    IF NEW.node_id <> OLD.node_id THEN
        RAISE EXCEPTION 'job % cannot change its Task node (was node %)',
            OLD.job_id, OLD.node_id;
    END IF;
    IF NEW.workspace_id <> OLD.workspace_id THEN
        RAISE EXCEPTION 'job % cannot change Workspace scope (was workspace %)',
            OLD.job_id, OLD.workspace_id;
    END IF;
    IF NEW.client_id <> OLD.client_id THEN
        RAISE EXCEPTION 'job % Client ownership is immutable (was client %)',
            OLD.job_id, OLD.client_id;
    END IF;
    IF NEW.agency_id <> OLD.agency_id THEN
        RAISE EXCEPTION 'job % cannot change Agency ownership (was agency %)',
            OLD.job_id, OLD.agency_id;
    END IF;
    IF NEW.title <> OLD.title OR NEW.description <> OLD.description
       OR NEW.eligibility <> OLD.eligibility THEN
        RAISE EXCEPTION 'job % descriptor and eligibility are immutable', OLD.job_id;
    END IF;
    IF NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'job % provenance is immutable', OLD.job_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jobs_identity_immutable_trigger ON jobs;
CREATE TRIGGER jobs_identity_immutable_trigger
    BEFORE UPDATE ON jobs
    FOR EACH ROW EXECUTE FUNCTION jobs_identity_immutable();

-- Scope-chain + Task-scope backstop (JOB-AC-01): the Job's scope must be
-- EXACTLY the owning instance's server-derived scope, the Workspace must
-- belong to the recorded Client and the Client to the recorded Agency —
-- enforced on INSERT and UPDATE, so the scope chain (Agency → Client →
-- Workspace → Workflow → Instance → Job) cannot be crossed through any
-- column even if every application check were bypassed.
CREATE OR REPLACE FUNCTION jobs_scope_chain() RETURNS trigger AS $$
DECLARE
    v_workspace_id uuid;
    v_client_id    uuid;
    v_agency_id    uuid;
BEGIN
    SELECT workspace_id, client_id, agency_id
        INTO v_workspace_id, v_client_id, v_agency_id
    FROM workflow_instances
    WHERE workflow_instances.workflow_instance_id = NEW.workflow_instance_id;

    IF v_workspace_id IS NULL THEN
        RAISE EXCEPTION 'job % references unknown workflow instance %',
            NEW.job_id, NEW.workflow_instance_id;
    END IF;
    IF NEW.workspace_id <> v_workspace_id OR NEW.client_id <> v_client_id
       OR NEW.agency_id <> v_agency_id THEN
        RAISE EXCEPTION 'job % scope (workspace %, client %, agency %) must equal the Task instance scope (workspace %, client %, agency %)',
            NEW.job_id, NEW.workspace_id, NEW.client_id, NEW.agency_id,
            v_workspace_id, v_client_id, v_agency_id;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM workspaces w
        WHERE w.workspace_id = NEW.workspace_id
          AND w.client_id = NEW.client_id
    ) THEN
        RAISE EXCEPTION 'job % workspace % does not belong to client %',
            NEW.job_id, NEW.workspace_id, NEW.client_id;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM clients c
        WHERE c.client_id = NEW.client_id
          AND c.agency_id = NEW.agency_id
    ) THEN
        RAISE EXCEPTION 'job % client % does not belong to agency %',
            NEW.job_id, NEW.client_id, NEW.agency_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jobs_scope_chain_trigger ON jobs;
CREATE TRIGGER jobs_scope_chain_trigger
    BEFORE INSERT OR UPDATE ON jobs
    FOR EACH ROW EXECUTE FUNCTION jobs_scope_chain();

-- Task-reference backstop (JOB-AC-01): a Job may only project a HUMAN Task
-- of a RUNNING instance — the node must exist in the instance's pinned
-- definition graph with nodeType 'human_task'. The pinned definition of a
-- running instance is ACTIVE and content-frozen, so the check is stable.
CREATE OR REPLACE FUNCTION jobs_task_reference() RETURNS trigger AS $$
DECLARE
    v_status text;
BEGIN
    SELECT status INTO v_status FROM workflow_instances
    WHERE workflow_instances.workflow_instance_id = NEW.workflow_instance_id;

    IF v_status IS NULL THEN
        RAISE EXCEPTION 'job % references unknown workflow instance %',
            NEW.job_id, NEW.workflow_instance_id;
    END IF;
    IF v_status <> 'running' THEN
        RAISE EXCEPTION 'job % can only project a Task of a RUNNING workflow instance (instance is %)',
            NEW.job_id, v_status;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM workflow_instances wi
        JOIN workflow_definitions wd ON wd.workflow_definition_id = wi.workflow_definition_id
        WHERE wi.workflow_instance_id = NEW.workflow_instance_id
          AND EXISTS (
              SELECT 1
              FROM jsonb_array_elements(wd.graph -> 'nodes') AS n
              WHERE n ->> 'nodeId' = NEW.node_id
                AND n ->> 'nodeType' = 'human_task'
          )
    ) THEN
        RAISE EXCEPTION 'job % must reference a human_task node of its instance % pinned definition (node %)',
            NEW.job_id, NEW.workflow_instance_id, NEW.node_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jobs_task_reference_trigger ON jobs;
CREATE TRIGGER jobs_task_reference_trigger
    BEFORE INSERT ON jobs
    FOR EACH ROW EXECUTE FUNCTION jobs_task_reference();

-- ---------------------------------------------------------------------------
-- Candidate-specific Offers (job-offer-v1.2.md "Offer model": a Job may
-- have multiple candidate-specific Offers; an Offer is not a second Job).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_offers (
    job_offer_id        uuid        PRIMARY KEY,
    -- No ON DELETE CASCADE: an accepted offer PROTECTS its job row (the
    -- claim history cannot be deleted underneath).
    job_id              uuid        NOT NULL REFERENCES jobs(job_id),
    -- The candidate HUMAN AGENT (profile) this Offer is addressed to.
    candidate_agent_id  uuid        NOT NULL REFERENCES human_agents(agent_id),
    -- Server-derived from the candidate profile at creation (the immutable
    -- platform identity link) — the only actor who may accept/decline.
    candidate_user_id   uuid        NOT NULL REFERENCES users(user_id),
    status              text        NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'accepted', 'declined', 'expired', 'withdrawn')),
    -- Why the offer reached its terminal state (REQUIRED on terminal
    -- states, impossible on open): 'claimed' (the winning acceptance),
    -- 'declined' (the candidate declined), 'expiry' (the expiry passed),
    -- 'lost' (a different offer won the job — losing offers cannot later
    -- claim), 'withdrawn' (the commissioning side withdrew it).
    terminal_reason     text
                        CHECK (terminal_reason IS NULL OR terminal_reason IN
                               ('claimed', 'declined', 'expiry', 'lost', 'withdrawn')),
    expires_at          timestamptz NOT NULL,
    accepted_at         timestamptz,
    created_by          uuid        REFERENCES users(user_id),
    version             bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    -- Open offers carry no reason; terminal offers always do.
    CHECK ((status = 'open') = (terminal_reason IS NULL)),
    -- accepted_at exists exactly on the winning acceptance.
    CHECK ((status = 'accepted') = (accepted_at IS NOT NULL))
);

-- The EXACTLY-ONE-WINNER fence (job-offer-v1.2.md "At most one Offer may
-- atomically win a single-acceptance Job"): the database rejects a second
-- accepted offer for one job under ANY path — the storage end of the
-- concurrency-safe acceptance claim (the v1.2 Job Offer contract posture).
CREATE UNIQUE INDEX IF NOT EXISTS job_offers_one_winner
    ON job_offers (job_id) WHERE status = 'accepted';

-- One OPEN offer per (job, candidate): a duplicate open offer for the same
-- candidate is rejected; re-offering after that candidate's offer became
-- terminal is a commissioning decision the fences permit only while the
-- job is still offerable.
CREATE UNIQUE INDEX IF NOT EXISTS job_offers_one_open_per_candidate
    ON job_offers (job_id, candidate_agent_id) WHERE status = 'open';

-- Listing surfaces: the offers of one job; the offers addressed to one
-- candidate (by the immutable platform identity link).
CREATE INDEX IF NOT EXISTS job_offers_job_idx
    ON job_offers (job_id, created_at, job_offer_id);
CREATE INDEX IF NOT EXISTS job_offers_candidate_idx
    ON job_offers (candidate_user_id, created_at DESC, job_offer_id);

-- The frozen offer state machine: open → accepted | declined | expired |
-- withdrawn and NOTHING else; every terminal state is FROZEN history (a
-- losing offer "cannot later claim the Job"; decline and expiry are
-- terminal per-offer).
CREATE OR REPLACE FUNCTION job_offers_frozen_state_machine() RETURNS trigger AS $$
BEGIN
    IF OLD.status = 'accepted' AND NEW.status = 'accepted' THEN
        -- Idempotent replay of the winning acceptance converges without a
        -- second transition (the module returns the recorded outcome).
        IF NEW.terminal_reason = OLD.terminal_reason
           AND NEW.accepted_at = OLD.accepted_at
           AND NEW.version = OLD.version THEN
            RETURN NEW;
        END IF;
    END IF;
    IF OLD.status <> 'open' THEN
        RAISE EXCEPTION 'job offer % is % (terminal) and frozen: terminal offer states are immutable',
            OLD.job_offer_id, OLD.status;
    END IF;
    IF NEW.status NOT IN ('accepted', 'declined', 'expired', 'withdrawn') THEN
        RAISE EXCEPTION 'illegal job offer transition % → % (frozen offer state machine)',
            OLD.status, NEW.status;
    END IF;
    IF OLD.status = NEW.status THEN
        RAISE EXCEPTION 'job offer % self-transition % → % is illegal',
            OLD.job_offer_id, OLD.status, NEW.status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS job_offers_frozen_state_machine_trigger ON job_offers;
CREATE TRIGGER job_offers_frozen_state_machine_trigger
    BEFORE UPDATE ON job_offers
    FOR EACH ROW EXECUTE FUNCTION job_offers_frozen_state_machine();

-- Immutability backstop: offer identity, the job reference, the candidate
-- (agent + denormalized user) and the expiry contract can NEVER be
-- reassigned — an Offer can never become another candidate's offer and the
-- expiry window can never be moved once published.
CREATE OR REPLACE FUNCTION job_offers_identity_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW.job_offer_id <> OLD.job_offer_id THEN
        RAISE EXCEPTION 'job_offer_id % is immutable', OLD.job_offer_id;
    END IF;
    IF NEW.job_id <> OLD.job_id THEN
        RAISE EXCEPTION 'job offer % cannot change its Job (was job %)',
            OLD.job_offer_id, OLD.job_id;
    END IF;
    IF NEW.candidate_agent_id <> OLD.candidate_agent_id
       OR NEW.candidate_user_id <> OLD.candidate_user_id THEN
        RAISE EXCEPTION 'job offer % candidate is immutable (was agent % / user %)',
            OLD.job_offer_id, OLD.candidate_agent_id, OLD.candidate_user_id;
    END IF;
    IF NEW.expires_at <> OLD.expires_at THEN
        RAISE EXCEPTION 'job offer % expiry contract is immutable (was %)',
            OLD.job_offer_id, OLD.expires_at;
    END IF;
    IF NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'job offer % provenance is immutable', OLD.job_offer_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS job_offers_identity_immutable_trigger ON job_offers;
CREATE TRIGGER job_offers_identity_immutable_trigger
    BEFORE UPDATE ON job_offers
    FOR EACH ROW EXECUTE FUNCTION job_offers_identity_immutable();

-- Candidate-consistency backstop: the denormalized candidate_user_id must
-- equal the candidate agent profile's immutable platform identity link.
CREATE OR REPLACE FUNCTION job_offers_candidate_consistent() RETURNS trigger AS $$
DECLARE
    v_user_id uuid;
BEGIN
    SELECT user_id INTO v_user_id FROM human_agents
    WHERE human_agents.agent_id = NEW.candidate_agent_id;

    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'job offer % references unknown human agent profile %',
            NEW.job_offer_id, NEW.candidate_agent_id;
    END IF;
    IF v_user_id <> NEW.candidate_user_id THEN
        RAISE EXCEPTION 'job offer % candidate agent % is linked to user %, not user %',
            NEW.job_offer_id, NEW.candidate_agent_id, v_user_id, NEW.candidate_user_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS job_offers_candidate_consistent_trigger ON job_offers;
CREATE TRIGGER job_offers_candidate_consistent_trigger
    BEFORE INSERT OR UPDATE ON job_offers
    FOR EACH ROW EXECUTE FUNCTION job_offers_candidate_consistent();

-- ---------------------------------------------------------------------------
-- The submitted outcome (JOB-AC-03): append-only, exactly one per job,
-- with SERVER-DERIVED actor/evidence provenance preserved forever.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_outcomes (
    job_outcome_id      uuid        PRIMARY KEY,
    -- No ON DELETE CASCADE: outcome history PROTECTS its job row.
    job_id              uuid        NOT NULL REFERENCES jobs(job_id),
    outcome             text        NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
    -- Opaque reference to a durable outcome payload artifact (object store
    -- address etc.) — never inline payload content.
    payload_ref         text        CHECK (payload_ref IS NULL OR length(payload_ref) BETWEEN 1 AND 500),
    -- The /evidence authority's immutable record backing this outcome —
    -- FK-fenced to the SAME Client as the job (trigger below: the metrics
    -- pattern). A human narrative alone never establishes truth
    -- (job-offer-v1.2.md). The evidence reference preserves the chain.
    evidence_ref        uuid        NOT NULL REFERENCES evidence(evidence_id),
    -- The workflow-authoritative instance status OBSERVED at report time —
    -- the report context. Jobs never own workflow state; the workflow
    -- authority decides what to do with the report.
    reported_instance_status text   NOT NULL
                        CHECK (reported_instance_status IN ('draft', 'ready', 'running', 'paused',
                                                           'blocked', 'succeeded', 'failed', 'cancelled')),
    -- SERVER-DERIVED provenance (JOB-AC-03) — no request DTO can ever
    -- write these columns through the module surface.
    recorded_actor      text        NOT NULL CHECK (length(recorded_actor) BETWEEN 3 AND 200),
    recorded_via        text        NOT NULL CHECK (length(recorded_via) BETWEEN 1 AND 100),
    correlation_id      text        NOT NULL CHECK (length(correlation_id) BETWEEN 1 AND 200),
    causation_id        text        CHECK (causation_id IS NULL OR length(causation_id) BETWEEN 1 AND 200),
    submitted_by        uuid        REFERENCES users(user_id),
    submitted_at        timestamptz NOT NULL DEFAULT now(),
    created_at          timestamptz NOT NULL DEFAULT now(),

    -- Exactly ONE outcome per job, ever (the replay convergence fence).
    CONSTRAINT job_outcomes_job_key UNIQUE (job_id)
);

-- Same-Client evidence backstop (the metrics pattern): the outcome's
-- evidence record must belong to the SAME Client as the job —
-- cross-tenant evidence linkage is rejected by the database itself.
CREATE OR REPLACE FUNCTION job_outcomes_evidence_same_client() RETURNS trigger AS $$
DECLARE
    v_evidence_client uuid;
    v_job_client      uuid;
BEGIN
    SELECT client_id INTO v_job_client FROM jobs WHERE jobs.job_id = NEW.job_id;
    IF v_job_client IS NULL THEN
        RAISE EXCEPTION 'job outcome % references unknown job %', NEW.job_outcome_id, NEW.job_id;
    END IF;
    SELECT client_id INTO v_evidence_client FROM evidence WHERE evidence.evidence_id = NEW.evidence_ref;
    IF v_evidence_client IS NULL THEN
        RAISE EXCEPTION 'job outcome % references unknown evidence %',
            NEW.job_outcome_id, NEW.evidence_ref;
    END IF;
    IF v_evidence_client <> v_job_client THEN
        RAISE EXCEPTION 'job outcome % evidence % belongs to another client — cross-tenant evidence linkage is rejected',
            NEW.job_outcome_id, NEW.evidence_ref;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS job_outcomes_evidence_same_client_trigger ON job_outcomes;
CREATE TRIGGER job_outcomes_evidence_same_client_trigger
    BEFORE INSERT ON job_outcomes
    FOR EACH ROW EXECUTE FUNCTION job_outcomes_evidence_same_client();

-- Append-only backstop: submitted outcomes are immutable evidence —
-- UPDATE and DELETE are both rejected by the database itself (JOB-AC-03
-- history preservation).
CREATE OR REPLACE FUNCTION job_outcomes_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'job outcomes are append-only history (% blocked)', TG_OP;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS job_outcomes_append_only_trigger ON job_outcomes;
CREATE TRIGGER job_outcomes_append_only_trigger
    BEFORE UPDATE OR DELETE ON job_outcomes
    FOR EACH ROW EXECUTE FUNCTION job_outcomes_append_only();
