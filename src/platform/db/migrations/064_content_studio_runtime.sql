-- 064_content_studio_runtime.sql — STUDIO-001 (Content Studio Runtime).
--
-- THE STUDIO RUNTIME AUTHORITY (spec/effective-backlog-v1.7.md
-- STUDIO-001: "Build the MOS-owned AI+Human production session
-- runtime used standalone or by the Lab. Acceptance: tenant-scoped
-- versioned production sessions, asynchronous/durable processing,
-- guarded lifecycle, no publishing/experiment authority.";
-- spec/content-studio-contract-v1.0.md — the governing sub-contract:
-- §1 the two entry modes, §2 the pluggable format registry (initial
-- formats reaction/audio-podcast/video-podcast — the SEAM this
-- migration's step plan derives from), §3 the immutable/versioned
-- production request, §4 the organization compatibility contract
-- ("The Studio MUST NOT silently replace a requested organization
-- with a different organization. A compatibility failure is explicit
-- and auditable."), §5 the session lifecycle vocabulary ("State
-- transitions are guarded and append-audited." + "A completed
-- session remains immutable. A retry/treatment creates a new session
-- revision or child production run linked to the prior output."),
-- §9 ("Long-running processing is asynchronous/durable rather than a
-- synchronous web request."), §12 the versioned artifact packages
-- ("Artifact versions are immutable. New treatment produces a new
-- version linked to its predecessor."), §13 the structured treatment
-- request, §17 the failure vocabulary; architecture-lock-v1.7 #38-#44
-- (the Studio production artifacts, the immutable/versioned outputs,
-- the treatment linkage, and #43 "The Studio is not a marketing
-- objective, publishing, rights, policy, experiment, evidence,
-- workflow, execution, model-routing or marketplace authority.");
-- frozen-manifest-v1.7.json studioRules
-- "studioIsNotPublicationOrExperimentAuthority": true;
-- AGENTS.md v1.7 "Long-running simulation/training and production
-- processing use durable worker infrastructure, not synchronous
-- requests"):
--
--   studio_production_requests    → the CLIENT-SCOPED versioned
--                                   immutable production request
--                                   registry (the FULL §3 field set
--                                   as declared jsonb data — the
--                                   entry-mode CHECK fence, the
--                                   format/organization selection,
--                                   the declared budget/deadline/
--                                   stopping policy and the declared
--                                   rights/provenance context);
--   studio_sessions               → the versioned production session
--                                   revisions (one row per (session,
--                                   revision)) carrying the guarded
--                                   §5 state machine column, the
--                                   validated organization snapshot +
--                                   the auditable compatibility
--                                   validation, and the treatment
--                                   linkage (prior output + origin
--                                   treatment on successor
--                                   revisions);
--   studio_session_events         → the APPEND-ONLY session audit
--                                   tail (the §5 "append-audited"
--                                   substrate — every state advance,
--                                   claim, outcome, output and
--                                   treatment is recorded with the
--                                   canonical payload digest);
--   studio_processing_steps       → the DURABLE asynchronous
--                                   processing substrate (§9): one
--                                   persisted row per format-declared
--                                   stage, born 'queued', claimed by
--                                   the CAS batch-claim (queued →
--                                   running), completed or failed
--                                   under the guarded status edges,
--                                   requeued only by the explicit
--                                   caller retry — a restart re-reads
--                                   the same rows and continues;
--   studio_output_versions        → the immutable versioned output
--                                   records (the §12 minimal runtime
--                                   tail — the artifact package as
--                                   declared data with the treatment
--                                   parent linkage; the FULL package/
--                                   provenance richness is STUDIO-010);
--   studio_treatment_requests     → the structured §13 treatment
--                                   requests (declared data: defect,
--                                   desired change, target quality,
--                                   affected artifacts, alternate
--                                   organization, alternate transform,
--                                   human action, retry limit,
--                                   deadline, acceptance test — the
--                                   EVALUATION verdicts are LAB-023,
--                                   never here).
--
-- Key fences:
--
-- * CHECK-fenced vocabularies on every enumerated column: the §5
--   session lifecycle (created/preparing/awaiting_participant/
--   recording/processing/review/treatment_requested/completed/
--   cancelled/failed/expired), the §1 entry modes (standalone/
--   lab_initiated), the §17 honest failure taxonomy (blocked_
--   dependency/capability_failure/participant_delay/processing_
--   delay/provider_failure/budget_exhausted/rights_consent_issue/
--   quality_failure), the terminal reasons, the step statuses
--   (queued/running/succeeded/failed), the ten session event kinds
--   and the pinned contract version.
-- * THE GUARDED LIFECYCLE (§5): session revision identity/scope/
--   request-binding/organization snapshot is immutable after insert;
--   the state column advances ONLY along the frozen legal-edge table
--   (the trigger encodes the exact §5 table — created → preparing |
--   cancelled | failed | expired; preparing → awaiting_participant |
--   recording | processing | cancelled | failed | expired;
--   awaiting_participant → recording | cancelled | failed | expired;
--   recording → processing | cancelled | failed | expired;
--   processing → review | cancelled | failed | expired; review →
--   treatment_requested | completed | cancelled | failed | expired;
--   the terminals have NO outgoing edges) and a TERMINAL revision is
--   frozen outright (no column may move again); the terminal-shape
--   CHECK pins the reason to the cancelled/failed/expired terminals.
-- * THE APPEND-ONLY DISCIPLINE: requests, output versions and
--   treatment requests are INSERT-ONLY (UPDATE and DELETE rejected —
--   corrections are NEW version rows); session events are
--   APPEND-ONLY OUTRIGHT; sessions and steps advance only through
--   their guarded UPDATE triggers.
-- * THE DURABLE QUEUE (§9): the step statuses advance ONLY along
--   queued → running → succeeded | failed (with failed → queued as
--   the explicit caller requeue); the attempts counter is monotonic
--   and bounded; the output payload exists only on a succeeded step;
--   the failure reason only on a failed step.
-- * THE SCOPE FENCES: every row FK-anchors the owning agency and
--   client (+ optional workspace INSIDE the client); sessions bind
--   the EXACT request version they execute (the composite FK); steps
--   bind their session revision; the scope-consistency triggers
--   reject any row whose client does not match its anchor's client
--   (cross-tenant injection is rejected at the DB — the §22/v1.7 #29
--   tenant/workspace scoping), and the request version-chain fence
--   rejects a correction whose scope differs from the chain's scope.
-- * NO PUBLISHING/EXPERIMENT AUTHORITY (§16 + lock v1.7 #43 —
--   structural): this migration creates NO publishing, distribution,
--   experiment, evidence, rights, policy, workflow or execution
--   table and NO foreign key into any of them; the source artifacts
--   and consent records are OPAQUE reference strings inside the
--   request's declared jsonb (the existing Content Asset/Rights
--   authorities stay the sole decision-makers — the Studio is a
--   production runtime, never a second rights/policy engine); the
--   organization's agent bodies are OPAQUE /lab-agent-body
--   version-reference strings resolved through the module's
--   structural port (NO /lab-agent-body table is written here — the
--   pawn runtime stays LAB-011).
-- * NO SECRET MATERIAL ANYWHERE (CRED-001): the only structured
--   payload columns are the bounded declared-data contracts, the
--   audit event payloads, the step outputs and the artifact
--   packages — there is deliberately NO column capable of holding
--   secret or credential material, and NO binary column exists
--   anywhere.
--
-- Conventions (implementation-contract §3, §25): server-generated
-- opaque identifiers, append-oriented tails. No owner/role/user
-- columns: client-scope authorization stays exactly the
-- requireClientAccess route-layer authority — no second tenant,
-- permission or identity authority.
--
-- Numbering disclosure: 064 is the next free number on frozen main
-- (063_lab_agent_body.sql is the tail at base 2a4aa84; 062 remains
-- reserved for the parallel worker per the LAB-011 delivery note).

-- ---------------------------------------------------------------------------
-- studio_production_requests — the client-scoped versioned immutable
-- production request registry (the FULL §3 field set as declared data)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS studio_production_requests (
    -- THE VERSION CHAIN KEY: one row per (request, version) —
    -- corrections append NEW version rows under the SAME request_id
    -- (the alternate-organization treatment path).
    request_id          uuid        NOT NULL,
    request_version     integer     NOT NULL CHECK (request_version >= 1 AND request_version <= 1000),
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id        uuid        REFERENCES workspaces(workspace_id),
    -- The §3 content as declared data: entryMode (CHECK-fenced below),
    -- the format/organization selection, the §8 input (script |
    -- question list | intent + source references), the output
    -- contract, the acceptance criteria, the budget, the deadline,
    -- the delay/stopping policy, the declared rights/provenance
    -- context and the §15 lab binding. The ONLY structured fence the
    -- DB pins is the entry mode — the deep shape is the module's
    -- pure-guard surface (the honest error layer).
    content             jsonb       NOT NULL
                        CHECK (jsonb_typeof(content) = 'object'
                               AND (content->>'entryMode') IN ('standalone', 'lab_initiated')),
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'content-studio-runtime-v1'),
    created_at          timestamptz NOT NULL,
    CONSTRAINT studio_production_requests_pk PRIMARY KEY (request_id, request_version)
);

-- The client's request tail (newest version last).
CREATE INDEX IF NOT EXISTS studio_production_requests_client_idx
    ON studio_production_requests (client_id, request_id, request_version, created_at);

-- Requests are immutable version rows: NO UPDATE, NO DELETE (a
-- correction is a NEW version row — the append-only correction path).
CREATE OR REPLACE FUNCTION studio_production_requests_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'studio production requests are immutable version rows (INSERT only — corrections are NEW version rows)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_production_requests_no_update_trigger ON studio_production_requests;
CREATE TRIGGER studio_production_requests_no_update_trigger
    BEFORE UPDATE ON studio_production_requests
    FOR EACH ROW EXECUTE FUNCTION studio_production_requests_immutable();

DROP TRIGGER IF EXISTS studio_production_requests_no_delete_trigger ON studio_production_requests;
CREATE TRIGGER studio_production_requests_no_delete_trigger
    BEFORE DELETE ON studio_production_requests
    FOR EACH ROW EXECUTE FUNCTION studio_production_requests_immutable();

-- The version-chain scope fence: a correction (version > 1) must keep
-- the chain's scope (agency/client/workspace) — cross-tenant or
-- cross-workspace chain poisoning is rejected at the DB.
CREATE OR REPLACE FUNCTION studio_request_chain_scope_check() RETURNS trigger AS $$
DECLARE
    chain_client uuid;
    chain_agency uuid;
    chain_workspace uuid;
BEGIN
    IF NEW.request_version > 1 THEN
        SELECT client_id, agency_id, workspace_id
            INTO chain_client, chain_agency, chain_workspace
            FROM studio_production_requests
            WHERE request_id = NEW.request_id AND request_version = NEW.request_version - 1;
        IF chain_client IS NULL THEN
            RAISE EXCEPTION 'studio production request version chain is broken (%, %)',
                NEW.request_id, NEW.request_version - 1;
        END IF;
        IF chain_client <> NEW.client_id OR chain_agency <> NEW.agency_id
           OR chain_workspace IS DISTINCT FROM NEW.workspace_id THEN
            RAISE EXCEPTION 'studio production request correction must keep the version chain scope (cross-tenant/cross-workspace corrections are rejected)';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_request_chain_scope_trigger ON studio_production_requests;
CREATE TRIGGER studio_request_chain_scope_trigger
    BEFORE INSERT ON studio_production_requests
    FOR EACH ROW EXECUTE FUNCTION studio_request_chain_scope_check();

-- ---------------------------------------------------------------------------
-- studio_sessions — the versioned production session revisions (the
-- guarded §5 state machine)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS studio_sessions (
    -- THE REVISION CHAIN KEY: one row per (session, revision) — a
    -- retry/treatment opens a NEW revision linked to the prior output
    -- (§5); the current revision carries the live state machine.
    session_id          uuid        NOT NULL,
    revision            integer     NOT NULL CHECK (revision >= 1 AND revision <= 1000),
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id        uuid        REFERENCES workspaces(workspace_id),
    -- The session binds EXACTLY the request version it executes (a
    -- corrected request never re-aims an existing revision).
    request_id          uuid        NOT NULL,
    request_version     integer     NOT NULL CHECK (request_version >= 1),
    -- The §2 format selection snapshot (the seam's declared identity).
    format_id           text        NOT NULL CHECK (char_length(format_id) >= 1 AND char_length(format_id) <= 64),
    format_version      integer     NOT NULL CHECK (format_version >= 1 AND format_version <= 1000),
    -- The §4 organization snapshot: the EXPLICITLY selected submitted
    -- declaration (never a replacement) as declared data.
    organization        jsonb       NOT NULL
                        CHECK (jsonb_typeof(organization) = 'object'),
    -- The recorded compatibility validation (explicit and auditable).
    organization_validation jsonb   NOT NULL
                        CHECK (jsonb_typeof(organization_validation) = 'object'),
    -- THE GUARDED §5 LIFECYCLE (the CHECK-fenced vocabulary; the
    -- legal-edge table is the guard trigger below).
    state               text        NOT NULL
                        CHECK (state IN ('created',
                                          'preparing',
                                          'awaiting_participant',
                                          'recording',
                                          'processing',
                                          'review',
                                          'treatment_requested',
                                          'completed',
                                          'cancelled',
                                          'failed',
                                          'expired')),
    -- The honest terminal reason — present ONLY on the
    -- cancelled/failed/expired terminals (the shape fence below).
    terminal_reason     text
                        CHECK (terminal_reason IS NULL
                               OR terminal_reason IN ('user_cancelled',
                                                       'lab_abandoned',
                                                       'blocked_dependency',
                                                       'capability_failure',
                                                       'participant_delay',
                                                       'processing_delay',
                                                       'provider_failure',
                                                       'budget_exhausted',
                                                       'rights_consent_issue',
                                                       'quality_failure',
                                                       'deadline_passed')),
    -- The §5 treatment linkage: a successor revision (revision > 1)
    -- MUST cite the prior output it treats and the treatment request
    -- that opened it (the shape fence below). The FKs are completed
    -- at the migration tail (the circular lineage: a treatment cites
    -- the session it treats, a successor session cites the treatment
    -- that opened it).
    prior_output_version_id uuid,
    origin_treatment_id uuid,
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'content-studio-runtime-v1'),
    created_at          timestamptz NOT NULL,
    updated_at          timestamptz NOT NULL,
    state_changed_at    timestamptz NOT NULL,
    CONSTRAINT studio_sessions_pk PRIMARY KEY (session_id, revision),
    CONSTRAINT studio_sessions_request_fk
        FOREIGN KEY (request_id, request_version)
        REFERENCES studio_production_requests(request_id, request_version),
    -- THE TERMINAL-SHAPE FENCE: the reason is present exactly on the
    -- cancelled/failed/expired terminals.
    CONSTRAINT studio_sessions_terminal_shape CHECK (
        (state IN ('cancelled', 'failed', 'expired') AND terminal_reason IS NOT NULL)
        OR (state NOT IN ('cancelled', 'failed', 'expired') AND terminal_reason IS NULL)
    ),
    -- THE SUCCESSOR-LINKAGE FENCE: revision 1 is born unlinked; every
    -- successor revision carries the prior output + origin treatment.
    CONSTRAINT studio_sessions_successor_shape CHECK (
        (revision = 1 AND prior_output_version_id IS NULL AND origin_treatment_id IS NULL)
        OR (revision > 1 AND prior_output_version_id IS NOT NULL AND origin_treatment_id IS NOT NULL)
    )
);

-- NOTE: the successor-session FKs (prior_output_version_id /
-- origin_treatment_id) are added AFTER the referenced tables exist
-- (see the ALTER at the tail of this migration — the circular
-- lineage: a treatment cites the session it treats, a successor
-- session cites the treatment that opened it).

-- The client's session tail (newest revision per session).
CREATE INDEX IF NOT EXISTS studio_sessions_client_idx
    ON studio_sessions (client_id, session_id, revision, created_at);
-- The state facet (the driver's visibility surface — §17).
CREATE INDEX IF NOT EXISTS studio_sessions_state_idx
    ON studio_sessions (client_id, state, updated_at);

-- Session revision identity is immutable after insert; ONLY the state
-- column (with its terminal reason) and the server-managed timestamps
-- may advance — and ONLY along the frozen §5 legal-edge table.
CREATE OR REPLACE FUNCTION studio_session_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.session_id <> OLD.session_id
       OR NEW.revision <> OLD.revision
       OR NEW.agency_id <> OLD.agency_id
       OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.request_id <> OLD.request_id
       OR NEW.request_version <> OLD.request_version
       OR NEW.format_id <> OLD.format_id
       OR NEW.format_version <> OLD.format_version
       OR NEW.organization <> OLD.organization
       OR NEW.organization_validation <> OLD.organization_validation
       OR NEW.prior_output_version_id IS DISTINCT FROM OLD.prior_output_version_id
       OR NEW.origin_treatment_id IS DISTINCT FROM OLD.origin_treatment_id
       OR NEW.contract_version <> OLD.contract_version
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'studio session % revision % identity/scope/request/organization is immutable — the revision record never rewrites what it executes',
            OLD.session_id, OLD.revision;
    END IF;
    -- A TERMINAL revision is frozen outright (§5: "A completed session
    -- remains immutable" — extended to every terminal revision).
    IF OLD.state IN ('treatment_requested', 'completed', 'cancelled', 'failed', 'expired')
       AND (NEW.state <> OLD.state
            OR NEW.terminal_reason IS DISTINCT FROM OLD.terminal_reason
            OR NEW.updated_at <> OLD.updated_at
            OR NEW.state_changed_at <> OLD.state_changed_at) THEN
        RAISE EXCEPTION 'studio session % revision % is terminal (%) — terminal revisions are frozen (a retry/treatment opens a NEW linked revision)',
            OLD.session_id, OLD.revision, OLD.state;
    END IF;
    -- THE FROZEN §5 LEGAL-EDGE TABLE (the single transition authority).
    IF NEW.state <> OLD.state THEN
        IF NOT (
               (OLD.state = 'created' AND NEW.state IN ('preparing', 'cancelled', 'failed', 'expired'))
            OR (OLD.state = 'preparing' AND NEW.state IN ('awaiting_participant', 'recording', 'processing', 'cancelled', 'failed', 'expired'))
            OR (OLD.state = 'awaiting_participant' AND NEW.state IN ('recording', 'cancelled', 'failed', 'expired'))
            OR (OLD.state = 'recording' AND NEW.state IN ('processing', 'cancelled', 'failed', 'expired'))
            OR (OLD.state = 'processing' AND NEW.state IN ('review', 'cancelled', 'failed', 'expired'))
            OR (OLD.state = 'review' AND NEW.state IN ('treatment_requested', 'completed', 'cancelled', 'failed', 'expired'))
        ) THEN
            RAISE EXCEPTION 'studio session % revision % transition % → % is not legal (the frozen §5 lifecycle table)',
                OLD.session_id, OLD.revision, OLD.state, NEW.state;
        END IF;
    END IF;
    IF NEW.updated_at < OLD.updated_at OR NEW.state_changed_at < OLD.state_changed_at THEN
        RAISE EXCEPTION 'studio session % revision % timestamps may not go backwards',
            OLD.session_id, OLD.revision;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_session_guard_trigger ON studio_sessions;
CREATE TRIGGER studio_session_guard_trigger
    BEFORE UPDATE ON studio_sessions
    FOR EACH ROW EXECUTE FUNCTION studio_session_guard();

-- Session revisions are never deleted (the revision history is
-- append-only evidence).
CREATE OR REPLACE FUNCTION studio_sessions_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'studio session revisions cannot be deleted — revision history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_sessions_no_delete_trigger ON studio_sessions;
CREATE TRIGGER studio_sessions_no_delete_trigger
    BEFORE DELETE ON studio_sessions
    FOR EACH ROW EXECUTE FUNCTION studio_sessions_no_delete();

-- Scope consistency: a revision's client must match its request
-- version's client (cross-tenant session injection is rejected at the
-- DB — the v1.7 #29 tenant scoping).
CREATE OR REPLACE FUNCTION studio_session_scope_check() RETURNS trigger AS $$
DECLARE
    request_client uuid;
BEGIN
    SELECT client_id INTO request_client
        FROM studio_production_requests
        WHERE request_id = NEW.request_id AND request_version = NEW.request_version;
    IF request_client IS NULL THEN
        RAISE EXCEPTION 'studio session must bind an existing request version (%, %)',
            NEW.request_id, NEW.request_version;
    END IF;
    IF request_client <> NEW.client_id THEN
        RAISE EXCEPTION 'studio session client must match its request version client (cross-tenant sessions are rejected)';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_session_scope_trigger ON studio_sessions;
CREATE TRIGGER studio_session_scope_trigger
    BEFORE INSERT ON studio_sessions
    FOR EACH ROW EXECUTE FUNCTION studio_session_scope_check();

-- ---------------------------------------------------------------------------
-- studio_session_events — the APPEND-ONLY session audit tail (the §5
-- "append-audited" substrate)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS studio_session_events (
    event_id            uuid        PRIMARY KEY,
    session_id          uuid        NOT NULL,
    revision            integer     NOT NULL CHECK (revision >= 1),
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    seq                 integer     NOT NULL CHECK (seq >= 1),
    event_kind          text        NOT NULL
                        CHECK (event_kind IN ('session_opened',
                                               'organization_loaded',
                                               'state_advanced',
                                               'processing_plan_recorded',
                                               'step_claimed',
                                               'step_completed',
                                               'step_failed',
                                               'step_requeued',
                                               'output_version_recorded',
                                               'treatment_requested')),
    payload             jsonb       NOT NULL
                        CHECK (jsonb_typeof(payload) = 'object'),
    payload_digest      text        NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'content-studio-runtime-v1'),
    created_at          timestamptz NOT NULL,
    -- The per-revision sequence fence (the ordered tail).
    CONSTRAINT studio_session_events_seq UNIQUE (session_id, revision, seq)
);

-- The session's event tail (oldest first).
CREATE INDEX IF NOT EXISTS studio_session_events_session_idx
    ON studio_session_events (client_id, session_id, revision, seq);
-- The client's event facet (the audit queries).
CREATE INDEX IF NOT EXISTS studio_session_events_client_idx
    ON studio_session_events (client_id, created_at);

-- Events are APPEND-ONLY OUTRIGHT: no UPDATE, no DELETE (the audit
-- history is evidence — the same discipline as the /lab run events).
CREATE OR REPLACE FUNCTION studio_session_events_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'studio session events are append-only (INSERT only — the audit history is never rewritten)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_session_events_no_update_trigger ON studio_session_events;
CREATE TRIGGER studio_session_events_no_update_trigger
    BEFORE UPDATE ON studio_session_events
    FOR EACH ROW EXECUTE FUNCTION studio_session_events_append_only();

DROP TRIGGER IF EXISTS studio_session_events_no_delete_trigger ON studio_session_events;
CREATE TRIGGER studio_session_events_no_delete_trigger
    BEFORE DELETE ON studio_session_events
    FOR EACH ROW EXECUTE FUNCTION studio_session_events_append_only();

-- Scope consistency: an event's client must match its session's
-- client (cross-tenant event injection is rejected at the DB).
CREATE OR REPLACE FUNCTION studio_session_event_scope_check() RETURNS trigger AS $$
DECLARE
    session_client uuid;
BEGIN
    SELECT client_id INTO session_client
        FROM studio_sessions
        WHERE session_id = NEW.session_id AND revision = NEW.revision;
    IF session_client IS NULL THEN
        RAISE EXCEPTION 'studio session event must bind an existing session revision (%, %)',
            NEW.session_id, NEW.revision;
    END IF;
    IF session_client <> NEW.client_id THEN
        RAISE EXCEPTION 'studio session event client must match its session client (cross-tenant events are rejected)';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_session_event_scope_trigger ON studio_session_events;
CREATE TRIGGER studio_session_event_scope_trigger
    BEFORE INSERT ON studio_session_events
    FOR EACH ROW EXECUTE FUNCTION studio_session_event_scope_check();

-- ---------------------------------------------------------------------------
-- studio_processing_steps — the DURABLE asynchronous processing
-- substrate (§9 — the persisted work that survives restarts)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS studio_processing_steps (
    step_id             uuid        PRIMARY KEY,
    session_id          uuid        NOT NULL,
    revision            integer     NOT NULL CHECK (revision >= 1),
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id        uuid        REFERENCES workspaces(workspace_id),
    -- The format-declared stage this step executes (the §2 seam's
    -- stageId — the plan derivation's declared data).
    stage_id            text        NOT NULL CHECK (char_length(stage_id) >= 1 AND char_length(stage_id) <= 64),
    -- The stage order within the session revision's plan (1-based).
    stage_index         integer     NOT NULL CHECK (stage_index >= 1 AND stage_index <= 16),
    -- THE DURABLE STATUS EDGES: queued → running → succeeded | failed,
    -- with failed → queued as the EXPLICIT caller requeue (the
    -- bounded infrastructure retry — the economic branch decisions
    -- stay the caller's, §17).
    status              text        NOT NULL
                        CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
    attempts            integer     NOT NULL CHECK (attempts >= 0 AND attempts <= 10),
    run_at              timestamptz NOT NULL,
    locked_at           timestamptz,
    locked_by           text
                        CHECK (locked_by IS NULL
                               OR (char_length(locked_by) >= 1 AND char_length(locked_by) <= 128)),
    -- The step's declared output payload — ONLY on a succeeded step.
    output              jsonb
                        CHECK (output IS NULL OR jsonb_typeof(output) = 'object'),
    -- The honest §17 failure reason — ONLY on a failed step.
    failure_reason      text
                        CHECK (failure_reason IS NULL
                               OR failure_reason IN ('blocked_dependency',
                                                      'capability_failure',
                                                      'participant_delay',
                                                      'processing_delay',
                                                      'provider_failure',
                                                      'budget_exhausted',
                                                      'rights_consent_issue',
                                                      'quality_failure')),
    failure_detail      text
                        CHECK (failure_detail IS NULL
                               OR (char_length(failure_detail) >= 1 AND char_length(failure_detail) <= 512)),
    cost_units          double precision NOT NULL CHECK (cost_units >= 0),
    duration_ms         integer     NOT NULL CHECK (duration_ms >= 0),
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'content-studio-runtime-v1'),
    created_at          timestamptz NOT NULL,
    updated_at          timestamptz NOT NULL,
    -- THE STEP-SHAPE FENCE: an output exists only on success; a
    -- failure reason only on failure; a lock identity only while
    -- running.
    CONSTRAINT studio_steps_status_shape CHECK (
        (status = 'queued' AND output IS NULL AND failure_reason IS NULL AND locked_at IS NULL AND locked_by IS NULL)
        OR (status = 'running' AND output IS NULL AND failure_reason IS NULL AND locked_at IS NOT NULL AND locked_by IS NOT NULL)
        OR (status = 'succeeded' AND output IS NOT NULL AND failure_reason IS NULL AND locked_at IS NULL AND locked_by IS NULL)
        OR (status = 'failed' AND output IS NULL AND failure_reason IS NOT NULL AND locked_at IS NULL AND locked_by IS NULL)
    ),
    CONSTRAINT studio_steps_session_fk
        FOREIGN KEY (session_id, revision)
        REFERENCES studio_sessions(session_id, revision)
);

-- The claim surface (the CAS batch-claim reads: due queued steps,
-- oldest first, SKIP LOCKED).
CREATE INDEX IF NOT EXISTS studio_processing_steps_claim_idx
    ON studio_processing_steps (client_id, status, run_at, created_at);
-- The session's step tail (the plan + the §17 visibility surface).
CREATE INDEX IF NOT EXISTS studio_processing_steps_session_idx
    ON studio_processing_steps (client_id, session_id, revision, stage_index);

-- Step identity is immutable after insert; ONLY the status columns
-- (status/attempts/locks/output/failure/telemetry) and updated_at may
-- advance — and ONLY along the durable status edges.
CREATE OR REPLACE FUNCTION studio_step_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.step_id <> OLD.step_id
       OR NEW.session_id <> OLD.session_id
       OR NEW.revision <> OLD.revision
       OR NEW.agency_id <> OLD.agency_id
       OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.stage_id <> OLD.stage_id
       OR NEW.stage_index <> OLD.stage_index
       OR NEW.run_at < OLD.run_at
       OR NEW.contract_version <> OLD.contract_version
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'studio processing step % identity/scope/stage is immutable — the step record never rewrites what it executes',
            OLD.step_id;
    END IF;
    IF NEW.attempts < OLD.attempts THEN
        RAISE EXCEPTION 'studio processing step % attempts may not go backwards',
            OLD.step_id;
    END IF;
    IF NOT (
           (OLD.status = 'queued' AND NEW.status = 'running' AND NEW.attempts = OLD.attempts + 1)
        OR (OLD.status = 'running' AND NEW.status = 'succeeded')
        OR (OLD.status = 'running' AND NEW.status = 'failed')
        OR (OLD.status = 'failed' AND NEW.status = 'queued' AND NEW.attempts = OLD.attempts)
        OR (OLD.status = NEW.status AND NEW.attempts = OLD.attempts)
    ) THEN
        RAISE EXCEPTION 'studio processing step % status/attempt transition % → % (attempts % → %) is not legal (queued → running → succeeded | failed; failed → queued is the explicit caller requeue)',
            OLD.step_id, OLD.status, NEW.status, OLD.attempts, NEW.attempts;
    END IF;
    -- A succeeded step is terminal: its outcome columns never move.
    IF OLD.status = 'succeeded'
       AND (NEW.output IS DISTINCT FROM OLD.output
            OR NEW.cost_units <> OLD.cost_units
            OR NEW.duration_ms <> OLD.duration_ms) THEN
        RAISE EXCEPTION 'studio processing step % is succeeded — the terminal outcome never moves again',
            OLD.step_id;
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'studio processing step % updated_at may not go backwards',
            OLD.step_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_step_guard_trigger ON studio_processing_steps;
CREATE TRIGGER studio_step_guard_trigger
    BEFORE UPDATE ON studio_processing_steps
    FOR EACH ROW EXECUTE FUNCTION studio_step_guard();

-- Steps are never deleted (the durable work history is append-only —
-- a restart re-reads it).
CREATE OR REPLACE FUNCTION studio_processing_steps_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'studio processing steps cannot be deleted — the durable work history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_processing_steps_no_delete_trigger ON studio_processing_steps;
CREATE TRIGGER studio_processing_steps_no_delete_trigger
    BEFORE DELETE ON studio_processing_steps
    FOR EACH ROW EXECUTE FUNCTION studio_processing_steps_no_delete();

-- Scope consistency: a step's client must match its session revision's
-- client (cross-tenant step injection is rejected at the DB).
CREATE OR REPLACE FUNCTION studio_step_scope_check() RETURNS trigger AS $$
DECLARE
    session_client uuid;
BEGIN
    SELECT client_id INTO session_client
        FROM studio_sessions
        WHERE session_id = NEW.session_id AND revision = NEW.revision;
    IF session_client IS NULL THEN
        RAISE EXCEPTION 'studio processing step must bind an existing session revision (%, %)',
            NEW.session_id, NEW.revision;
    END IF;
    IF session_client <> NEW.client_id THEN
        RAISE EXCEPTION 'studio processing step client must match its session client (cross-tenant steps are rejected)';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_step_scope_trigger ON studio_processing_steps;
CREATE TRIGGER studio_step_scope_trigger
    BEFORE INSERT ON studio_processing_steps
    FOR EACH ROW EXECUTE FUNCTION studio_step_scope_check();

-- ---------------------------------------------------------------------------
-- studio_output_versions — the immutable versioned output records (the
-- §12 minimal runtime tail; the FULL package/provenance richness is
-- STUDIO-010)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS studio_output_versions (
    output_version_id   uuid        PRIMARY KEY,
    session_id          uuid        NOT NULL,
    revision            integer     NOT NULL CHECK (revision >= 1),
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id        uuid        REFERENCES workspaces(workspace_id),
    -- The artifact package as DECLARED DATA (every key the request's
    -- output contract requires — validated module-side; the lineage
    -- rides the parent linkage below + the request's declared
    -- provenance/consent context).
    artifact_package    jsonb       NOT NULL
                        CHECK (jsonb_typeof(artifact_package) = 'object'),
    -- THE TREATMENT LINEAGE (lock v1.7 #42: "Each treatment creates a
    -- new linked output version") — the predecessor this version
    -- replaces (NULL on the first version).
    parent_output_version_id uuid   REFERENCES studio_output_versions(output_version_id),
    aggregate_cost_units double precision NOT NULL CHECK (aggregate_cost_units >= 0),
    aggregate_duration_ms integer  NOT NULL CHECK (aggregate_duration_ms >= 0),
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'content-studio-runtime-v1'),
    created_at          timestamptz NOT NULL,
    CONSTRAINT studio_output_versions_session_fk
        FOREIGN KEY (session_id, revision)
        REFERENCES studio_sessions(session_id, revision)
);

-- The session's output lineage (oldest first — the treatment chain).
CREATE INDEX IF NOT EXISTS studio_output_versions_session_idx
    ON studio_output_versions (client_id, session_id, revision, created_at);
-- The parent-lineage facet.
CREATE INDEX IF NOT EXISTS studio_output_versions_parent_idx
    ON studio_output_versions (client_id, parent_output_version_id);

-- Output versions are immutable INSERT-ONLY records (§12 "Artifact
-- versions are immutable. New treatment produces a new version linked
-- to its predecessor."): NO UPDATE, NO DELETE.
CREATE OR REPLACE FUNCTION studio_output_versions_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'studio output versions are immutable (INSERT only — a treatment produces a NEW linked version)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_output_versions_no_update_trigger ON studio_output_versions;
CREATE TRIGGER studio_output_versions_no_update_trigger
    BEFORE UPDATE ON studio_output_versions
    FOR EACH ROW EXECUTE FUNCTION studio_output_versions_immutable();

DROP TRIGGER IF EXISTS studio_output_versions_no_delete_trigger ON studio_output_versions;
CREATE TRIGGER studio_output_versions_no_delete_trigger
    BEFORE DELETE ON studio_output_versions
    FOR EACH ROW EXECUTE FUNCTION studio_output_versions_immutable();

-- Scope consistency: an output's client must match its session
-- revision's client (cross-tenant output injection is rejected at the
-- DB).
CREATE OR REPLACE FUNCTION studio_output_scope_check() RETURNS trigger AS $$
DECLARE
    session_client uuid;
BEGIN
    SELECT client_id INTO session_client
        FROM studio_sessions
        WHERE session_id = NEW.session_id AND revision = NEW.revision;
    IF session_client IS NULL THEN
        RAISE EXCEPTION 'studio output version must bind an existing session revision (%, %)',
            NEW.session_id, NEW.revision;
    END IF;
    IF session_client <> NEW.client_id THEN
        RAISE EXCEPTION 'studio output version client must match its session client (cross-tenant outputs are rejected)';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_output_scope_trigger ON studio_output_versions;
CREATE TRIGGER studio_output_scope_trigger
    BEFORE INSERT ON studio_output_versions
    FOR EACH ROW EXECUTE FUNCTION studio_output_scope_check();

-- ---------------------------------------------------------------------------
-- studio_treatment_requests — the structured §13 treatment requests
-- (declared data; the EVALUATION verdicts are LAB-023, never here)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS studio_treatment_requests (
    treatment_id        uuid        PRIMARY KEY,
    session_id          uuid        NOT NULL,
    -- The revision the treatment CLOSES (the reviewed revision).
    revision            integer     NOT NULL CHECK (revision >= 1),
    -- The output version the treatment targets.
    target_output_version_id uuid   NOT NULL
                        REFERENCES studio_output_versions(output_version_id),
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id        uuid        REFERENCES workspaces(workspace_id),
    -- The §13 structured specification as declared data: defect,
    -- desired change, target quality, affected artifacts, alternate
    -- organization, alternate transform, human action, retry limit,
    -- deadline, acceptance test (the deep shape is the module's
    -- pure-guard surface).
    specification       jsonb       NOT NULL
                        CHECK (jsonb_typeof(specification) = 'object'),
    -- The successor revision this treatment opened (the §5 linkage).
    successor_revision  integer     NOT NULL CHECK (successor_revision >= 2),
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'content-studio-runtime-v1'),
    created_at          timestamptz NOT NULL,
    CONSTRAINT studio_treatment_requests_session_fk
        FOREIGN KEY (session_id, revision)
        REFERENCES studio_sessions(session_id, revision)
);

-- The session's treatment tail (oldest first).
CREATE INDEX IF NOT EXISTS studio_treatment_requests_session_idx
    ON studio_treatment_requests (client_id, session_id, revision, created_at);

-- Treatment requests are immutable INSERT-ONLY records (the treatment
-- history is auditable evidence — a new treatment is a new record):
-- NO UPDATE, NO DELETE.
CREATE OR REPLACE FUNCTION studio_treatment_requests_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'studio treatment requests are immutable (INSERT only — the treatment history is append-only)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_treatment_requests_no_update_trigger ON studio_treatment_requests;
CREATE TRIGGER studio_treatment_requests_no_update_trigger
    BEFORE UPDATE ON studio_treatment_requests
    FOR EACH ROW EXECUTE FUNCTION studio_treatment_requests_immutable();

DROP TRIGGER IF EXISTS studio_treatment_requests_no_delete_trigger ON studio_treatment_requests;
CREATE TRIGGER studio_treatment_requests_no_delete_trigger
    BEFORE DELETE ON studio_treatment_requests
    FOR EACH ROW EXECUTE FUNCTION studio_treatment_requests_immutable();

-- Scope consistency: a treatment's client must match its session
-- revision's client (cross-tenant treatment injection is rejected at
-- the DB).
CREATE OR REPLACE FUNCTION studio_treatment_scope_check() RETURNS trigger AS $$
DECLARE
    session_client uuid;
    output_client uuid;
BEGIN
    SELECT client_id INTO session_client
        FROM studio_sessions
        WHERE session_id = NEW.session_id AND revision = NEW.revision;
    IF session_client IS NULL THEN
        RAISE EXCEPTION 'studio treatment request must bind an existing session revision (%, %)',
            NEW.session_id, NEW.revision;
    END IF;
    IF session_client <> NEW.client_id THEN
        RAISE EXCEPTION 'studio treatment request client must match its session client (cross-tenant treatments are rejected)';
    END IF;
    SELECT client_id INTO output_client
        FROM studio_output_versions
        WHERE output_version_id = NEW.target_output_version_id;
    IF output_client IS NULL OR output_client <> NEW.client_id THEN
        RAISE EXCEPTION 'studio treatment request target output must exist in the same client (cross-tenant outputs are rejected)';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_treatment_scope_trigger ON studio_treatment_requests;
CREATE TRIGGER studio_treatment_scope_trigger
    BEFORE INSERT ON studio_treatment_requests
    FOR EACH ROW EXECUTE FUNCTION studio_treatment_scope_check();

-- ---------------------------------------------------------------------------
-- The circular lineage completion: the successor-session FKs (added
-- after the referenced tables exist — a treatment cites the session it
-- treats; a successor session revision cites the treatment that opened
-- it and the prior output it treats).
-- ---------------------------------------------------------------------------

ALTER TABLE studio_sessions
    DROP CONSTRAINT IF EXISTS studio_sessions_prior_output_fk;
ALTER TABLE studio_sessions
    ADD CONSTRAINT studio_sessions_prior_output_fk
    FOREIGN KEY (prior_output_version_id)
    REFERENCES studio_output_versions(output_version_id);

ALTER TABLE studio_sessions
    DROP CONSTRAINT IF EXISTS studio_sessions_origin_treatment_fk;
ALTER TABLE studio_sessions
    ADD CONSTRAINT studio_sessions_origin_treatment_fk
    FOREIGN KEY (origin_treatment_id)
    REFERENCES studio_treatment_requests(treatment_id);
