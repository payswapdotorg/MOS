-- 073_studio_av_capture.sql — STUDIO-007 (Audio/Video Capture).
--
-- THE CAPTURE AUTHORITY SURFACE (spec/effective-backlog-v1.7.md
-- STUDIO-007: "Implement approved audio/video capture and durable
-- artifact persistence through platform storage/access ports.
-- Acceptance: raw takes, alternates and participant/source provenance
-- are preserved; no long-running synchronous HTTP processing.";
-- dependencies: STUDIO-001 — merged PR #73, migration 064 (the runtime
-- whose 'recording' state this capture layer owns); STUDIO-002 —
-- merged PR #78, migration 068 (the format capture-requirements
-- declarations that fence which modalities a format approves);
-- STUDIO-003 — merged PR #81, migration 070 (the declared
-- question/branch graph whose walked version + nodes the graph-driven
-- takes pin; 072 is HELD by the in-flight parallel LAB-006 worker —
-- this migration appends as the 071→073 tail, the TL resolves any
-- stacked shift at merge, the 062/070 precedent). The governing
-- sub-contract is spec/content-studio-contract-v1.0.md (FROZEN):
-- §9 "Capture — Capture is modality-specific but format-neutral. The
-- runtime may capture: audio; video; screen/source material; multiple
-- participant streams; alternate takes. Raw captures are production
-- artifacts and are not assumed to be final content. Capture
-- implementations must use approved storage/access ports and preserve
-- provenance. Long-running processing is asynchronous/durable rather
-- than a synchronous web request." (THE frozen capture rule this
-- migration fences);
-- §5 the session lifecycle vocabulary (capture happens inside the
-- 'recording' state; recording → processing hands the recorded
-- material to the durable step plan);
-- §6 "The Studio MUST preserve: question/answer sequence; interviewer
-- representation provenance; generated versus human-authored
-- distinction; recording provenance; participant consent." (the
-- per-take provenance the capture rows carry structurally);
-- §7 "Each participant joins through an explicit participation grant.
-- Participant identity, account authorization, consent and
-- contribution provenance are kept separately." (the participant
-- identity / grant / consent reference columns);
-- §12 (the artifact package vocabulary incl. 'raw captures' and
-- 'alternate takes' — the take rows are the durable raw-capture
-- records STUDIO-010's package will cite);
-- §17 ("The Studio must expose enough deterministic cost/delay/status
-- information for that decision." — the per-take ingest state +
-- duration);
-- §16 ("The Studio MUST NOT ... turn a participant contribution into
-- an unrestricted reusable asset without the necessary rights/consent"
-- — the take is an INTERMEDIATE production artifact row, never a
-- content-asset registration; the /content-assets authority is never
-- written here); architecture-v1.7 §27.7 ("A Studio session produces a
-- versioned Artifact Package that may contain: raw captures; ...
-- alternate takes; ... provenance/consent records; ..."), §29 (the
-- standalone flow's "interview/capture → review/retake" steps);
-- architecture-lock-v1.7 #38-#44 (in particular #36 "Human-generated
-- media is an intermediate production artifact." and #43 "The Studio
-- is not a marketing objective, publishing, rights, policy,
-- experiment, evidence, workflow, execution, model-routing or
-- marketplace authority."); AGENTS.md v1.7 ("Long-running
-- simulation/training and production processing use durable worker
-- infrastructure, not synchronous requests" + "Human-generated media
-- is an intermediate artifact and must pass through the selected
-- organization for treatment when the strategy requires it").
--
-- Two own tables ONLY (the one-module-owns-its-tables discipline; the
-- STUDIO-001/002/003 tables are UNTOUCHED — this migration is purely
-- additive, ZERO cross-table DDL, no ALTER TABLE anywhere):
--
--   studio_capture_sessions → the CAPTURE SESSION records: the
--                             recording context opened against one
--                             studio session revision while it is in
--                             the 'recording' state — the capture mode
--                             ('graph_walk' — the STUDIO-003
--                             question/branch graph drives the capture
--                             steps, the session pins the walked graph
--                             version EXACTLY like a conversation pins
--                             its first step; 'session_direct' — the
--                             reaction/script-shape captures with no
--                             graph) + the interviewer representation
--                             of the recording context (the §6
--                             vocabulary; NULL exactly for
--                             interviewer-less formats such as
--                             reaction). INSERT-only, immutable: a
--                             changed recording context (a corrected
--                             graph, a different interviewer
--                             representation) opens a NEW capture
--                             session (the re-take/re-conversation
--                             discipline);
--   studio_capture_takes    → the RAW TAKE records: EVERY take is an
--                             append-only durable row carrying the
--                             durable artifact reference (the
--                             content-addressed platform object key +
--                             digest + size — the bytes land through
--                             the platform ObjectStore port at
--                             ingestion, NEVER a bytea column here),
--                             the walked-graph NODE PIN (graph id +
--                             version + the declared question id —
--                             required exactly for graph_walk takes),
--                             the ALTERNATE chain (alternate_of_take_id
--                             — a retake is a NEW take citing the take
--                             it alternates, NEVER an overwrite), the
--                             full participant/source provenance
--                             (participant identity reference, the
--                             optional participation-grant reference,
--                             the REQUIRED consent references, the
--                             source device/input metadata, the
--                             interviewer representation, the content
--                             type) and the ASYNC INGEST state machine
--                             (BORN 'processing' — the ingest verb
--                             returns after the durable landing, any
--                             post-landing analysis is a separate
--                             completion; 'stored' | 'failed' are the
--                             guarded terminal advances; the ingest
--                             columns are the ONLY mutable columns, the
--                             take identity/provenance/artifact
--                             reference is immutable after insert).
--
-- The reference grammar: every take mints the OPAQUE take reference
-- 'studio-take:' + its canonical take uuid — the reference the
-- STUDIO-003 conversation steps' answer_reference and the processing
-- steps' outputs cite (never joined; resolution is the module's
-- getCaptureTakeByReference).
--
-- NO AUTHORITY TRANSFER: no /content-assets or /content-rights table
-- is written or referenced (the durable object references are
-- platform-anchored opaque strings, not FKs — a raw take is an
-- INTERMEDIATE production artifact and NEVER a reusable content-asset
-- registration; §16 + lock #36/#43); no evidence, workflow, execution
-- or publishing surface anywhere.
--
-- Pure DDL (no INSERT, no DELETE, no UPDATE outside trigger bodies);
-- no secret-capable column; NO binary column (CRED-001 — the media
-- bytes live in the platform object store behind the recorded
-- content-addressed reference).

-- ---------------------------------------------------------------------------
-- The pinned sub-contract identity (the FOURTH inside the one module —
-- the migration-064 runtime / migration-068 format / migration-070
-- script identities stay pinned on their own tables, UNTOUCHED).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- studio_capture_sessions — the recording context (INSERT-only).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS studio_capture_sessions (
    -- The capture session identity (one recording context; a changed
    -- context opens a NEW capture session).
    capture_session_id    uuid        NOT NULL,
    -- The studio session revision the capture happens inside (the
    -- revision must be in the 'recording' state — the scope trigger
    -- below re-reads and enforces it).
    session_id            uuid        NOT NULL,
    revision              integer     NOT NULL CHECK (revision >= 1),
    -- The tenant fence (every row client-scoped, the optional
    -- workspace anchor).
    agency_id             uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id             uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id          uuid        REFERENCES workspaces(workspace_id),
    -- THE CAPTURE MODE (the closed two-member vocabulary): a
    -- 'graph_walk' capture session is ADAPTIVE-INTERVIEWER-AWARE — the
    -- STUDIO-003 declared question/branch graph drives the capture
    -- steps, and the capture session PINS the walked graph version
    -- exactly like a conversation pins its first step (a mid-capture
    -- graph correction never re-aims a running capture session; a NEW
    -- capture session walks the corrected version); a 'session_direct'
    -- capture session records against the session itself (the
    -- reaction / supplied-script shapes).
    capture_mode          text        NOT NULL
                          CHECK (capture_mode IN ('graph_walk', 'session_direct')),
    -- The WALKED-GRAPH PIN (required exactly for graph_walk captures;
    -- forbidden for session_direct — the shape fence below).
    graph_id              uuid,
    graph_version         integer     CHECK (graph_version IS NULL OR graph_version >= 1),
    -- The interviewer representation of the recording context (the §6
    -- closed seven-member vocabulary; NULL exactly for interviewer-
    -- less formats such as reaction — the module guards the format's
    -- declared interviewer requirements, the DB fences the vocabulary).
    interviewer_representation text
                          CHECK (interviewer_representation IS NULL
                                 OR interviewer_representation IN ('voice', 'voice_text', 'avatar',
                                                                  'prerecorded', 'generated',
                                                                  'multimodal_declared', 'hybrid')),
    contract_version      text        NOT NULL
                          CHECK (contract_version = 'content-studio-capture-v1'),
    created_at            timestamptz NOT NULL,
    CONSTRAINT studio_capture_sessions_pk PRIMARY KEY (capture_session_id),
    CONSTRAINT studio_capture_sessions_session_fk
        FOREIGN KEY (session_id, revision)
        REFERENCES studio_sessions(session_id, revision),
    CONSTRAINT studio_capture_sessions_graph_fk
        FOREIGN KEY (graph_id, graph_version)
        REFERENCES studio_question_graphs(graph_id, graph_version),
    -- THE MODE-GRAPH SHAPE FENCE: a graph_walk capture session carries
    -- its walked-graph pin; a session_direct capture session carries
    -- none (never a half pin, never a misdirected pin).
    CONSTRAINT studio_capture_sessions_mode_shape CHECK (
        (capture_mode = 'graph_walk' AND graph_id IS NOT NULL AND graph_version IS NOT NULL)
        OR (capture_mode = 'session_direct' AND graph_id IS NULL AND graph_version IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS studio_capture_sessions_session_idx
    ON studio_capture_sessions (client_id, session_id, revision, created_at);

-- Capture sessions are immutable recording contexts: no UPDATE, no
-- DELETE (a changed context is a NEW capture session — the re-take
-- discipline).
CREATE OR REPLACE FUNCTION studio_capture_sessions_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'studio capture sessions are append-only (INSERT only — the recording context is preserved as data; a changed context opens a NEW capture session)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_capture_sessions_no_update_trigger ON studio_capture_sessions;
CREATE TRIGGER studio_capture_sessions_no_update_trigger
    BEFORE UPDATE ON studio_capture_sessions
    FOR EACH ROW EXECUTE FUNCTION studio_capture_sessions_append_only();
DROP TRIGGER IF EXISTS studio_capture_sessions_no_delete_trigger ON studio_capture_sessions;
CREATE TRIGGER studio_capture_sessions_no_delete_trigger
    BEFORE DELETE ON studio_capture_sessions
    FOR EACH ROW EXECUTE FUNCTION studio_capture_sessions_append_only();

-- Scope + recording-state + walked-graph-binding consistency: the
-- session revision exists in the SAME client; the session revision is
-- in the 'recording' state (capture happens inside recording — §5);
-- a graph_walk capture session pins a declared graph version of the
-- SAME client bound to the session's OWN request version (the exact
-- conversation-walk binding of migration 070).
CREATE OR REPLACE FUNCTION studio_capture_session_scope_check() RETURNS trigger AS $$
DECLARE
    session_client uuid;
    session_state text;
    session_request_id uuid;
    session_request_version integer;
    graph_client uuid;
    graph_request_id uuid;
    graph_request_version integer;
BEGIN
    SELECT client_id, state, request_id, request_version
        INTO session_client, session_state, session_request_id, session_request_version
        FROM studio_sessions
        WHERE session_id = NEW.session_id AND revision = NEW.revision;
    IF session_client IS NULL THEN
        RAISE EXCEPTION 'studio capture session must bind an existing session revision (%, %)',
            NEW.session_id, NEW.revision;
    END IF;
    IF session_client <> NEW.client_id THEN
        RAISE EXCEPTION 'studio capture session client must match its session client (cross-tenant capture sessions are rejected)';
    END IF;
    IF session_state <> 'recording' THEN
        RAISE EXCEPTION 'studio capture session may only open while its session revision is ''recording'' (found ''%'' — the §5 capture state)',
            session_state;
    END IF;
    IF NEW.capture_mode = 'graph_walk' THEN
        SELECT client_id, request_id, request_version
            INTO graph_client, graph_request_id, graph_request_version
            FROM studio_question_graphs
            WHERE graph_id = NEW.graph_id AND graph_version = NEW.graph_version;
        IF graph_client IS NULL THEN
            RAISE EXCEPTION 'studio capture session must pin an existing declared graph version (%, %)',
                NEW.graph_id, NEW.graph_version;
        END IF;
        IF graph_client <> NEW.client_id THEN
            RAISE EXCEPTION 'studio capture session client must match its walked graph client (cross-tenant graphs are rejected)';
        END IF;
        IF graph_request_id <> session_request_id OR graph_request_version <> session_request_version THEN
            RAISE EXCEPTION 'studio capture session must pin the declared graph bound to the session''s request version (graph: % v%; session request: % v%)',
                graph_request_id, graph_request_version, session_request_id, session_request_version;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_capture_session_scope_trigger ON studio_capture_sessions;
CREATE TRIGGER studio_capture_session_scope_trigger
    BEFORE INSERT ON studio_capture_sessions
    FOR EACH ROW EXECUTE FUNCTION studio_capture_session_scope_check();

-- ---------------------------------------------------------------------------
-- The bounded string-reference array helper (the 068 IMMUTABLE-helper
-- discipline: the sublink lives INSIDE the helper so the CHECK
-- expressions below carry none).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION studio_capture_refs_all_bounded(payload jsonb)
RETURNS boolean
IMMUTABLE
LANGUAGE sql
AS $$
    SELECT payload IS NOT NULL
       AND jsonb_typeof(payload) = 'array'
       AND jsonb_array_length(payload) >= 1
       AND jsonb_array_length(payload) <= 16
       AND NOT EXISTS (
            SELECT 1
              FROM jsonb_array_elements(payload) AS entry
             WHERE jsonb_typeof(entry) <> 'string'
                OR char_length(entry #>> '{}') < 1
                OR char_length(entry #>> '{}') > 512
       );
$$;

-- ---------------------------------------------------------------------------
-- studio_capture_takes — the append-only RAW TAKE records.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS studio_capture_takes (
    -- The take identity (every take is its own durable record).
    take_id               uuid        NOT NULL,
    -- The OPAQUE TAKE REFERENCE grammar ('studio-take:' + the canonical
    -- take uuid) — the reference the conversation steps'
    -- answer_reference and the processing outputs cite (never joined;
    -- resolution is the module's getCaptureTakeByReference).
    take_reference        text        NOT NULL
                          CHECK (take_reference ~ '^studio-take:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    -- The capture session this take belongs to (the recording context:
    -- the session revision, the walked-graph pin, the interviewer
    -- representation — all carried through this anchor).
    capture_session_id    uuid        NOT NULL
                          REFERENCES studio_capture_sessions(capture_session_id),
    -- The denormalized session-revision binding (the conversation-edge
    -- pattern: queryable per revision + the FK backstop).
    session_id            uuid        NOT NULL,
    revision              integer     NOT NULL CHECK (revision >= 1),
    -- The tenant fence.
    agency_id             uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id             uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id          uuid        REFERENCES workspaces(workspace_id),
    -- THE WALKED-GRAPH NODE PIN (the STUDIO-003 adaptive-interviewer
    -- binding): a take recorded against a walked graph node cites the
    -- walked graph version + the declared question id — required
    -- EXACTLY when the capture session is a graph_walk capture (the
    -- shape fence below + the scope trigger re-reads the declared
    -- graph jsonb, the 070 conversation discipline).
    graph_id              uuid,
    graph_version         integer     CHECK (graph_version IS NULL OR graph_version >= 1),
    question_id           text        CHECK (question_id IS NULL OR question_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
    -- The take modality (the closed §9 media-capture subset — audio,
    -- video, screen/source material; the format's declared capture
    -- requirements fence WHICH modalities a format approves, module-
    -- guarded against the migration-068 studio_formats declarations).
    modality              text        NOT NULL
                          CHECK (modality IN ('audio', 'video', 'screen')),
    -- THE ALTERNATE CHAIN (§9 "alternate takes"): a retake is a NEW
    -- take citing the take it alternates — NEVER an overwrite (the
    -- append-only house discipline; the scope trigger fences the
    -- alternate to the SAME capture session, node pin and modality).
    alternate_of_take_id  uuid        REFERENCES studio_capture_takes(take_id),
    -- THE SOURCE DEVICE/INPUT METADATA (the recording provenance): the
    -- closed input-kind vocabulary (the browser-capture surfaces the
    -- console contract reports — microphone / camera / both / screen
    -- capture / uploaded file) + the bounded client-declared device
    -- label + the bounded declared source metadata object (sample
    -- rate, resolution, browser, ... — declared DATA, never a provider
    -- SDK surface).
    input_kind            text        NOT NULL
                          CHECK (input_kind IN ('microphone', 'camera', 'microphone_and_camera',
                                                'screen_capture', 'uploaded_file')),
    device_label          text        NOT NULL
                          CHECK (char_length(device_label) >= 1 AND char_length(device_label) <= 256),
    source_metadata       jsonb       NOT NULL
                          CHECK (jsonb_typeof(source_metadata) = 'object'
                                 AND char_length(source_metadata::text) <= 65536),
    -- THE PARTICIPANT PROVENANCE (§7 — structural, not optional): the
    -- participant identity reference (opaque), the optional §7
    -- participation-grant reference (REQUIRED by the module exactly
    -- for formats declaring explicit per-participant grants) and the
    -- REQUIRED consent references (≥1 — the recording-consent /
    -- contribution-rights records the take's media depends on).
    participant_reference text        NOT NULL
                          CHECK (char_length(participant_reference) >= 1 AND char_length(participant_reference) <= 256),
    participant_grant_reference text
                          CHECK (participant_grant_reference IS NULL
                                 OR (char_length(participant_grant_reference) >= 1
                                     AND char_length(participant_grant_reference) <= 256)),
    consent_references    jsonb       NOT NULL
                          CHECK (studio_capture_refs_all_bounded(consent_references)),
    -- THE INTERVIEWER REPRESENTATION of the recording context (§6 —
    -- the same closed vocabulary; NULL exactly for interviewer-less
    -- formats; recorded per-take so EVERY take carries its recording
    -- context structurally).
    interviewer_representation text
                          CHECK (interviewer_representation IS NULL
                                 OR interviewer_representation IN ('voice', 'voice_text', 'avatar',
                                                                  'prerecorded', 'generated',
                                                                  'multimodal_declared', 'hybrid')),
    -- THE DURABLE ARTIFACT REFERENCE (the platform storage/access
    -- port): the bytes landed through the platform ObjectStore at
    -- ingestion — the CONTENT-ADDRESSED object key (sha256), the
    -- digest and the exact size are recorded here as opaque
    -- platform-anchored references (NEVER a bytea column; NEVER a
    -- module-local blob; no /content-assets registration — the raw
    -- take is an INTERMEDIATE production artifact, §16 + lock #36).
    object_key            text        NOT NULL
                          CHECK (object_key ~ '^[0-9a-f]{64}$'),
    object_digest         text        NOT NULL
                          CHECK (object_digest ~ '^[0-9a-f]{64}$'),
    object_size           bigint      NOT NULL CHECK (object_size > 0),
    content_type          text        NOT NULL
                          CHECK (content_type ~ '^[a-z0-9!#$&^_.+-]{1,32}/[a-z0-9!#$&^_.+-]{1,64}$'),
    -- THE ASYNC INGEST STATE MACHINE (§9 "Long-running processing is
    -- asynchronous/durable rather than a synchronous web request"):
    -- every take is BORN 'processing' (the born-processing fence
    -- trigger below — the ingest verb returns after the durable
    -- landing; any post-landing analysis/transcode is the separate
    -- completion, NEVER synchronous HTTP work); 'stored' and 'failed'
    -- are the guarded terminal advances (the migration-070 review-
    -- lifecycle pattern); the ingest columns are the ONLY mutable
    -- columns (the guard trigger below).
    ingest_state          text        NOT NULL
                          CHECK (ingest_state IN ('processing', 'stored', 'failed')),
    ingest_analysis       jsonb
                          CHECK (ingest_analysis IS NULL
                                 OR (jsonb_typeof(ingest_analysis) = 'object'
                                     AND char_length(ingest_analysis::text) <= 65536)),
    ingest_failure_reason text
                          CHECK (ingest_failure_reason IS NULL
                                 OR ingest_failure_reason IN ('dependency_blocked', 'capability_failure',
                                                              'participant_delay', 'processing_delay',
                                                              'provider_failure', 'budget_exhausted',
                                                              'rights_consent_issue', 'quality_failure')),
    ingest_failure_detail text
                          CHECK (ingest_failure_detail IS NULL
                                 OR (char_length(ingest_failure_detail) >= 1
                                     AND char_length(ingest_failure_detail) <= 2000)),
    ingest_duration_ms    integer     CHECK (ingest_duration_ms IS NULL OR ingest_duration_ms >= 0),
    ingest_completed_at   timestamptz,
    contract_version      text        NOT NULL
                          CHECK (contract_version = 'content-studio-capture-v1'),
    created_at            timestamptz NOT NULL,
    updated_at            timestamptz NOT NULL,
    CONSTRAINT studio_capture_takes_pk PRIMARY KEY (take_id),
    CONSTRAINT studio_capture_takes_reference_uk UNIQUE (take_reference),
    CONSTRAINT studio_capture_takes_session_fk
        FOREIGN KEY (session_id, revision)
        REFERENCES studio_sessions(session_id, revision),
    CONSTRAINT studio_capture_takes_graph_fk
        FOREIGN KEY (graph_id, graph_version)
        REFERENCES studio_question_graphs(graph_id, graph_version),
    -- THE NODE-PIN SHAPE FENCE: the walked-graph pin is complete or
    -- absent (never a half pin).
    CONSTRAINT studio_capture_takes_node_pin_shape CHECK (
        (graph_id IS NULL AND graph_version IS NULL AND question_id IS NULL)
        OR (graph_id IS NOT NULL AND graph_version IS NOT NULL AND question_id IS NOT NULL)
    ),
    -- THE INGEST-COMPLETION SHAPE FENCE: a processing take carries no
    -- completion; a terminal take carries its completion timestamp.
    CONSTRAINT studio_capture_takes_ingest_shape CHECK (
        (ingest_state = 'processing' AND ingest_completed_at IS NULL)
        OR (ingest_state IN ('stored', 'failed') AND ingest_completed_at IS NOT NULL)
    ),
    -- THE INGEST-FAILURE SHAPE FENCE: a failed take carries its §17
    -- failure reason; a non-failed take carries none.
    CONSTRAINT studio_capture_takes_failure_shape CHECK (
        (ingest_state = 'failed' AND ingest_failure_reason IS NOT NULL)
        OR (ingest_state IN ('processing', 'stored') AND ingest_failure_reason IS NULL
            AND ingest_failure_detail IS NULL)
    ),
    -- THE ANALYSIS SHAPE FENCE: the async completion payload exists
    -- only on stored takes (a failed take carries its failure record).
    CONSTRAINT studio_capture_takes_analysis_shape CHECK (
        ingest_state <> 'failed' OR ingest_analysis IS NULL
    )
);

CREATE INDEX IF NOT EXISTS studio_capture_takes_session_idx
    ON studio_capture_takes (client_id, session_id, revision, created_at);
CREATE INDEX IF NOT EXISTS studio_capture_takes_node_idx
    ON studio_capture_takes (client_id, capture_session_id, graph_id, question_id, modality, created_at);

-- Takes are born 'processing' — the async-ingest contract is
-- STRUCTURAL: the ingest verb performs the durable landing (the
-- platform object put + this row) and returns; the post-landing
-- analysis is the separate completion (NEVER synchronous HTTP work).
CREATE OR REPLACE FUNCTION studio_capture_takes_born_processing() RETURNS trigger AS $$
BEGIN
    IF NEW.ingest_state <> 'processing' THEN
        RAISE EXCEPTION 'studio capture takes are born ''processing'' (found ''%'') — the durable landing is synchronous, any post-landing processing is the separate async completion',
            NEW.ingest_state;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_capture_takes_born_processing_trigger ON studio_capture_takes;
CREATE TRIGGER studio_capture_takes_born_processing_trigger
    BEFORE INSERT ON studio_capture_takes
    FOR EACH ROW EXECUTE FUNCTION studio_capture_takes_born_processing();

-- Take identity/scope/linkage/provenance/artifact-reference is
-- immutable after insert; ONLY the ingest columns + the server-managed
-- updated_at may advance — and ONLY along the guarded edges
-- (processing → stored | failed; terminal takes frozen outright — the
-- honest retry is a NEW take row, optionally the alternate of the
-- failed one).
CREATE OR REPLACE FUNCTION studio_capture_take_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.take_id <> OLD.take_id
       OR NEW.take_reference <> OLD.take_reference
       OR NEW.capture_session_id <> OLD.capture_session_id
       OR NEW.session_id <> OLD.session_id
       OR NEW.revision <> OLD.revision
       OR NEW.agency_id <> OLD.agency_id
       OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.graph_id IS DISTINCT FROM OLD.graph_id
       OR NEW.graph_version IS DISTINCT FROM OLD.graph_version
       OR NEW.question_id IS DISTINCT FROM OLD.question_id
       OR NEW.modality <> OLD.modality
       OR NEW.alternate_of_take_id IS DISTINCT FROM OLD.alternate_of_take_id
       OR NEW.input_kind <> OLD.input_kind
       OR NEW.device_label <> OLD.device_label
       OR NEW.source_metadata <> OLD.source_metadata
       OR NEW.participant_reference <> OLD.participant_reference
       OR NEW.participant_grant_reference IS DISTINCT FROM OLD.participant_grant_reference
       OR NEW.consent_references <> OLD.consent_references
       OR NEW.interviewer_representation IS DISTINCT FROM OLD.interviewer_representation
       OR NEW.object_key <> OLD.object_key
       OR NEW.object_digest <> OLD.object_digest
       OR NEW.object_size <> OLD.object_size
       OR NEW.content_type <> OLD.content_type
       OR NEW.contract_version <> OLD.contract_version
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'studio capture take % identity/scope/linkage/provenance/artifact reference is immutable — a correction or retake is a NEW take row (the alternate chain)',
            OLD.take_id;
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'studio capture take % updated_at may not go backwards',
            OLD.take_id;
    END IF;
    IF NEW.ingest_state <> OLD.ingest_state THEN
        IF NOT (
               (OLD.ingest_state = 'processing' AND NEW.ingest_state IN ('stored', 'failed'))
        ) THEN
            RAISE EXCEPTION 'studio capture take % ingest transition % → % is not legal (born processing; processing → stored | failed; stored/failed are terminal — the honest retry is a NEW take)',
                OLD.take_id, OLD.ingest_state, NEW.ingest_state;
        END IF;
    ELSE
        -- The ingest columns move ONLY with the state advance: a
        -- processing take carries no completion payload ahead of its
        -- advance, and a terminal take's payload is frozen outright.
        IF NEW.ingest_analysis IS DISTINCT FROM OLD.ingest_analysis
           OR NEW.ingest_failure_reason IS DISTINCT FROM OLD.ingest_failure_reason
           OR NEW.ingest_failure_detail IS DISTINCT FROM OLD.ingest_failure_detail
           OR NEW.ingest_duration_ms IS DISTINCT FROM OLD.ingest_duration_ms
           OR NEW.ingest_completed_at IS DISTINCT FROM OLD.ingest_completed_at THEN
            IF OLD.ingest_state = 'processing' THEN
                RAISE EXCEPTION 'studio capture take % is still ''processing'' — the completion payload rides the ingest-state advance only',
                    OLD.take_id;
            ELSE
                RAISE EXCEPTION 'studio capture take % is terminal (''%'') — the ingest record is frozen (the honest retry is a NEW take row)',
                    OLD.take_id, OLD.ingest_state;
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_capture_take_guard_trigger ON studio_capture_takes;
CREATE TRIGGER studio_capture_take_guard_trigger
    BEFORE UPDATE ON studio_capture_takes
    FOR EACH ROW EXECUTE FUNCTION studio_capture_take_guard();

-- Takes are never deleted (the raw-capture history is append-only
-- evidence — §12 raw captures are preserved as data).
CREATE OR REPLACE FUNCTION studio_capture_takes_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'studio capture takes cannot be deleted — raw take history is append-only (alternates are new rows, never overwrites or removals)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_capture_takes_no_delete_trigger ON studio_capture_takes;
CREATE TRIGGER studio_capture_takes_no_delete_trigger
    BEFORE DELETE ON studio_capture_takes
    FOR EACH ROW EXECUTE FUNCTION studio_capture_takes_no_delete();

-- Scope + capture-session + node-pin + alternate consistency (the
-- 070 conversation-scope pattern): the capture session exists in the
-- SAME client and belongs to the take's session revision; the session
-- revision is STILL in the 'recording' state (takes are recorded
-- during capture — a revision that moved on no longer grows takes);
-- a node-pinned take pins the CAPTURE SESSION'S OWN walked graph and
-- a DECLARED node of that graph version; an alternate cites a take of
-- the SAME capture session, the SAME node pin and the SAME modality.
CREATE OR REPLACE FUNCTION studio_capture_take_scope_check() RETURNS trigger AS $$
DECLARE
    capture_client uuid;
    capture_session uuid;
    capture_revision integer;
    -- NOTE: no variable is ever named after a column of the queried
    -- tables (the PL/pgSQL ambiguous-reference fence — `capture_mode`
    -- the COLUMN stays table-qualified by aliasing the source row).
    session_capture_mode text;
    capture_graph_id uuid;
    capture_graph_version integer;
    session_state text;
    alternate_client uuid;
    alternate_capture_session uuid;
    alternate_graph_id uuid;
    alternate_graph_version integer;
    alternate_question text;
    alternate_modality text;
BEGIN
    SELECT sess.client_id, sess.session_id, sess.revision, sess.capture_mode, sess.graph_id, sess.graph_version
        INTO capture_client, capture_session, capture_revision, session_capture_mode,
             capture_graph_id, capture_graph_version
        FROM studio_capture_sessions AS sess
        WHERE sess.capture_session_id = NEW.capture_session_id;
    IF capture_client IS NULL THEN
        RAISE EXCEPTION 'studio capture take must bind an existing capture session (%)',
            NEW.capture_session_id;
    END IF;
    IF capture_client <> NEW.client_id THEN
        RAISE EXCEPTION 'studio capture take client must match its capture session client (cross-tenant takes are rejected)';
    END IF;
    IF capture_session <> NEW.session_id OR capture_revision <> NEW.revision THEN
        RAISE EXCEPTION 'studio capture take must bind its capture session''s session revision (capture session: % r%; take: % r%)',
            capture_session, capture_revision, NEW.session_id, NEW.revision;
    END IF;

    SELECT state INTO session_state
        FROM studio_sessions
        WHERE session_id = NEW.session_id AND revision = NEW.revision;
    IF session_state <> 'recording' THEN
        RAISE EXCEPTION 'studio capture takes may only be recorded while the session revision is ''recording'' (found ''%'')',
            session_state;
    END IF;

    -- The node pin rides the capture session's walked graph exactly.
    IF session_capture_mode = 'graph_walk' THEN
        IF NEW.graph_id IS NULL OR NEW.graph_id <> capture_graph_id
           OR NEW.graph_version <> capture_graph_version THEN
            RAISE EXCEPTION 'studio capture take must pin its capture session''s walked graph (capture session: % v%; take: % v%)',
                capture_graph_id, capture_graph_version, NEW.graph_id, NEW.graph_version;
        END IF;
        IF NOT EXISTS (
            SELECT 1
              FROM studio_question_graphs AS graph,
                   jsonb_array_elements(graph.declared_graph -> 'nodes') AS node
             WHERE graph.graph_id = NEW.graph_id AND graph.graph_version = NEW.graph_version
               AND node ->> 'questionId' = NEW.question_id
        ) THEN
            RAISE EXCEPTION 'studio capture take question ''%'' is not a declared node of the walked graph (%, %)',
                NEW.question_id, NEW.graph_id, NEW.graph_version;
        END IF;
    ELSE
        IF NEW.graph_id IS NOT NULL OR NEW.question_id IS NOT NULL THEN
            RAISE EXCEPTION 'studio capture take against a session_direct capture session carries no walked-graph node pin (graph: %, question: %)',
                NEW.graph_id, NEW.question_id;
        END IF;
    END IF;

    -- The alternate chain: same capture session, same node pin, same
    -- modality (an alternate is a RETAKE of the same capture moment,
    -- never a repurposed citation).
    IF NEW.alternate_of_take_id IS NOT NULL THEN
        SELECT client_id, capture_session_id, graph_id, graph_version, question_id, modality
            INTO alternate_client, alternate_capture_session, alternate_graph_id,
                 alternate_graph_version, alternate_question, alternate_modality
            FROM studio_capture_takes
            WHERE take_id = NEW.alternate_of_take_id;
        IF alternate_client IS NULL THEN
            RAISE EXCEPTION 'studio capture take alternate % does not exist',
                NEW.alternate_of_take_id;
        END IF;
        IF alternate_client <> NEW.client_id THEN
            RAISE EXCEPTION 'studio capture take alternate client must match the take client (cross-tenant alternates are rejected)';
        END IF;
        IF alternate_capture_session <> NEW.capture_session_id
           OR alternate_graph_id IS DISTINCT FROM NEW.graph_id
           OR alternate_graph_version IS DISTINCT FROM NEW.graph_version
           OR alternate_question IS DISTINCT FROM NEW.question_id
           OR alternate_modality <> NEW.modality THEN
            RAISE EXCEPTION 'studio capture take alternate % must share the capture session, the node pin and the modality (alternates are retakes of the SAME capture moment)',
                NEW.alternate_of_take_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_capture_take_scope_trigger ON studio_capture_takes;
CREATE TRIGGER studio_capture_take_scope_trigger
    BEFORE INSERT ON studio_capture_takes
    FOR EACH ROW EXECUTE FUNCTION studio_capture_take_scope_check();
