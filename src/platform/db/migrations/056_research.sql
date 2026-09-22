-- 056_research.sql — MKT-062 (Web Research — the /research authority).
--
-- The WEB RESEARCH authority (spec/architecture-v1.6.md §7 — the primary
-- contract: "Research sources may include public web pages, documentation,
-- research papers, news, market sources, public social content, and
-- connected repositories/workspaces when explicitly authorized. Every
-- material source fact retains source provenance. Model output is a claim
-- unless backed by evidence."; spec/effective-backlog-v1.6.md MKT-062;
-- the frozen v1.6 matrix row /research ──→ /integrations, /evidence,
-- /ai-runtime):
--
--   research_sessions              → the AGENCY-SCOPED research-session
--                                    records (the durable research
--                                    session: the declared topic, focus
--                                    question and sources ride IMMUTABLE
--                                    version records — corrections are
--                                    NEW version records, never in-place
--                                    rewrites);
--   research_session_versions      → the APPEND-ONLY VERSION TAIL (one
--                                    immutable row per declared session);
--   research_session_sources       → the per-version DECLARED SOURCE rows:
--                                    public web pages, documentation,
--                                    research papers, news, market sources,
--                                    public social content (public), plus
--                                    connected repositories/workspaces
--                                    ONLY when explicitly authorized (§7)
--                                    — each carrying its public vs
--                                    explicitly-authorized state and, for
--                                    the authorized kinds, the canonical
--                                    integration-connection reference the
--                                    READ-ONLY authorized read flows
--                                    through;
--   research_runs                  → the honest deterministic research-run
--                                    records (status/counts + provenance);
--   research_run_source_outcomes   → the per-source honest outcome rows
--                                    (the outcome vocabulary — failures
--                                    fail closed into honest records);
--   research_source_facts          → the retained observations with FULL
--                                    provenance (fact kind, source ref,
--                                    fetched-at, extractor identity,
--                                    64-char content hash, extraction
--                                    notes, §21-guarded content) —
--                                    EXTRACTED OBSERVATIONS, never
--                                    conclusions;
--   research_insights              → the §7 model-output CLAIM records
--                                    (statement with required summary;
--                                    SERVER-COMPUTED verification state;
--                                    the all-or-none AI-assistance
--                                    disclosure; the single-supersession
--                                    correction chain);
--   research_insight_evidence      → FK-anchored evidence links (the
--                                    same-session scope fence).
--
-- Key fences:
--
-- * CHECK-fenced vocabularies on every enumerated column (the eight
--   source kinds, the two authorization states, the kind-compatible
--   authorization shape, the ten fact kinds, the run statuses, the
--   per-source outcomes, the six derivation kinds, the two verification
--   states).
-- * THE APPEND-ONLY TAILS: version records, declared sources, source
--   facts, insights, insight evidence, research runs and per-source
--   outcomes ALL reject UPDATE and DELETE outright — not even server code
--   can rewrite research history. The session-record guard keeps
--   identity/scope/provenance immutable, the CAS version advancing by
--   exactly one and the version pointer only ever ADVANCING (corrections
--   are NEW version records).
-- * THE READ-ONLY GUARANTEE (§7): this migration creates NO table, column
--   or trigger capable of mutating an external source; the research
--   contract is fetch/read ONLY.
-- * THE DEFERRABLE VERIFICATION INVARIANT (the migration 048 pattern):
--   research_insight verification ⇔ evidence-presence is verified at
--   COMMIT — an 'evidence_backed' insight MUST carry ≥1 evidence row and
--   an 'unverified' insight MUST carry none, for every mutation path
--   including direct SQL ("Model output is a claim unless backed by
--   evidence" — made durable).
-- * THE SINGLE-SUPERSESSION FENCE (the migration 015 /evidence pattern):
--   at most one superseding insight per prior; supersession requires the
--   same session AND the same derivation kind.
-- * THE EVIDENCE SCOPE FENCE: insight evidence links FK-anchor source
--   facts of the SAME research session.
-- * THE INTEGRATION SCOPE FENCE (the migration 046/048 pattern): an
--   authorized source's integration connection must belong to the
--   research session's agency — integration_connections is read
--   CHECK-ONLY (never written here).
-- * NO AUTHORITY TRANSFER: this migration creates NO mission, workflow,
--   execution, playbook, experiment, evidence, learning, job, deployment,
--   integration, credential, tenant or content-intelligence table, and NO
--   experiment/mission/planner state of any kind (research insights are
--   inputs for later composition, never conclusions).
-- * NO SECRET MATERIAL ANYWHERE (CRED-001/§21): the only structured
--   payload columns are the bounded fact/insight statement objects —
--   there is deliberately NO column capable of holding secret material
--   (the module applies the shared /evidence §21 material-key guard at
--   the boundary).
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, row-locked CAS mutations, append-oriented tails. No
-- owner/role/user columns beyond provenance: agency-scope authorization
-- stays exactly the /agencies membership + platform-role authorities
-- resolved at the route layer — no second tenant, permission or identity
-- authority.

-- ---------------------------------------------------------------------------
-- research_sessions — the agency-scoped research-session records
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS research_sessions (
    research_session_id  uuid        PRIMARY KEY,
    -- AGENCY-SCOPED (spec/effective-backlog-v1.6.md MKT-062). The agency
    -- row is resolved at the ROUTE layer (the /app-metering precedent —
    -- /agencies is not a frozen allowance of this module's dependency
    -- row); the FK anchor keeps a dangling agency reference from
    -- persisting.
    agency_id            uuid        NOT NULL REFERENCES agencies(agency_id),
    -- The CURRENT declared version (the append-only tail pointer).
    current_version_seq  integer     NOT NULL CHECK (current_version_seq >= 1),
    -- The CAS token (row-locked mutations advance it by exactly one).
    version              bigint      NOT NULL CHECK (version >= 1),
    created_actor        text        NOT NULL
                         CHECK (length(created_actor) >= 1 AND length(created_actor) <= 100),
    created_at           timestamptz NOT NULL,
    updated_at           timestamptz NOT NULL
);

-- The agency listing surface (oldest first).
CREATE INDEX IF NOT EXISTS research_sessions_agency_idx
    ON research_sessions (agency_id, created_at, research_session_id);

-- SESSION-RECORD MUTATION GUARD: identity/scope/provenance are immutable;
-- the CAS version advances by exactly one; the version pointer only ever
-- ADVANCES and must reference an EXISTING declared version of the same
-- research session (corrections are NEW version records — the pointer can
-- never regress and can never dangle).
CREATE OR REPLACE FUNCTION research_session_record_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.research_session_id <> OLD.research_session_id
       OR NEW.agency_id <> OLD.agency_id
       OR NEW.created_actor <> OLD.created_actor
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'research session % identity/scope/provenance is immutable — corrections are new version records, never rewrites',
            OLD.research_session_id;
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
        RAISE EXCEPTION 'research session % CAS version must advance by exactly one (expected %, got %)',
            OLD.research_session_id, OLD.version + 1, NEW.version;
    END IF;
    IF NEW.current_version_seq < OLD.current_version_seq THEN
        RAISE EXCEPTION 'research session % current version cannot regress (corrections advance the version tail only)',
            NEW.research_session_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM research_session_versions v
        WHERE v.research_session_id = NEW.research_session_id
          AND v.version_seq = NEW.current_version_seq) THEN
        RAISE EXCEPTION 'research session % current_version_seq % must reference an existing declared version of this session',
            NEW.research_session_id, NEW.current_version_seq;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS research_session_record_guard_trigger ON research_sessions;
CREATE TRIGGER research_session_record_guard_trigger
    BEFORE UPDATE ON research_sessions
    FOR EACH ROW EXECUTE FUNCTION research_session_record_guard();

-- Session records are never deleted (research history is append-only).
CREATE OR REPLACE FUNCTION research_sessions_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'research sessions cannot be deleted — research history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS research_sessions_no_delete_trigger ON research_sessions;
CREATE TRIGGER research_sessions_no_delete_trigger
    BEFORE DELETE ON research_sessions
    FOR EACH ROW EXECUTE FUNCTION research_sessions_no_delete();

-- ---------------------------------------------------------------------------
-- research_session_versions — the append-only declared-session tail
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS research_session_versions (
    research_session_version_id uuid     PRIMARY KEY,
    research_session_id   uuid        NOT NULL REFERENCES research_sessions(research_session_id),
    -- The version sequence within the session (gapless from 1, assigned
    -- under the session row lock).
    version_seq          integer     NOT NULL CHECK (version_seq >= 1),
    -- The bounded declared research topic + focus question (declared
    -- content, never authoritative truth; the AUTHORITATIVE observations
    -- are the source facts).
    topic                text        CHECK (topic IS NULL
                                        OR (length(topic) >= 1 AND length(topic) <= 500)),
    focus                text        CHECK (focus IS NULL
                                        OR (length(focus) >= 1 AND length(focus) <= 2000)),
    -- SERVER-DERIVED provenance (never a request field).
    recorded_actor       text        NOT NULL
                         CHECK (length(recorded_actor) >= 1 AND length(recorded_actor) <= 100),
    recorded_via         text        NOT NULL
                         CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 100),
    correlation_id       text        NOT NULL,
    causation_id         text,
    created_at           timestamptz NOT NULL,
    CONSTRAINT research_session_versions_seq_unique UNIQUE (research_session_id, version_seq)
);

-- APPEND-ONLY VERSION TAIL (the migration 045/048 pattern): the database
-- itself rejects UPDATE and DELETE on the declared-session history — the
-- declared sources are immutable per version; corrections are NEW records.
CREATE OR REPLACE FUNCTION research_session_versions_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'research session versions are append-only: % is rejected on version %',
        TG_OP, OLD.research_session_version_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS research_session_versions_append_only_update_trigger ON research_session_versions;
CREATE TRIGGER research_session_versions_append_only_update_trigger
    BEFORE UPDATE ON research_session_versions
    FOR EACH ROW EXECUTE FUNCTION research_session_versions_append_only();

DROP TRIGGER IF EXISTS research_session_versions_append_only_delete_trigger ON research_session_versions;
CREATE TRIGGER research_session_versions_append_only_delete_trigger
    BEFORE DELETE ON research_session_versions
    FOR EACH ROW EXECUTE FUNCTION research_session_versions_append_only();

-- ---------------------------------------------------------------------------
-- research_session_sources — the per-version declared sources
-- ---------------------------------------------------------------------------

-- The declared sources (architecture-v1.6.md §7, mapped one-to-one onto
-- the MKT-062 declared-source set): each source carries its KIND, its
-- bounded REFERENCE (a URL for the public web kinds; an opaque canonical
-- reference for the authorized kinds), its AUTHORIZATION STATE (public vs
-- explicitly authorized) and — for the authorized kinds — the CANONICAL
-- integration-connection reference through which the authorized READ
-- flows (§7: read-only research; the connection, never this module, owns
-- the client chain and the credential).
CREATE TABLE IF NOT EXISTS research_session_sources (
    source_id                     uuid     PRIMARY KEY,
    research_session_version_id   uuid     NOT NULL REFERENCES research_session_versions(research_session_version_id),
    kind                          text     NOT NULL
                                  CHECK (kind IN ('web_page', 'documentation', 'research_paper',
                                                   'news', 'market_source', 'public_social_content',
                                                   'connected_repository', 'connected_workspace')),
    reference                     text     NOT NULL
                                  CHECK (length(reference) >= 1 AND length(reference) <= 2048),
    -- (authorization_state: 'authorization' is a reserved SQL keyword.)
    authorization_state           text     NOT NULL
                                  CHECK (authorization_state IN ('public', 'authorized')),
    -- The canonical integration-connection reference of the AUTHORIZED
    -- kinds (REQUIRED for them, FORBIDDEN for the public web kinds).
    integration_connection_id     uuid,
    -- Declaration order preserved (the caller's declared source order is
    -- part of the immutable version snapshot).
    position                      integer  NOT NULL CHECK (position >= 1),
    CONSTRAINT research_session_sources_shape CHECK (
        (kind IN ('web_page', 'documentation', 'research_paper',
                   'news', 'market_source', 'public_social_content')
           AND authorization_state = 'public'
           AND integration_connection_id IS NULL)
        OR (kind IN ('connected_repository', 'connected_workspace')
           AND authorization_state = 'authorized'
           AND integration_connection_id IS NOT NULL)
    ),
    CONSTRAINT research_session_sources_unique
        UNIQUE (research_session_version_id, kind, reference)
);

-- The declared sources are append-only with their version snapshot.
CREATE OR REPLACE FUNCTION research_session_sources_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'research session sources are append-only: % is rejected',
        TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS research_session_sources_append_only_update_trigger ON research_session_sources;
CREATE TRIGGER research_session_sources_append_only_update_trigger
    BEFORE UPDATE ON research_session_sources
    FOR EACH ROW EXECUTE FUNCTION research_session_sources_append_only();

DROP TRIGGER IF EXISTS research_session_sources_append_only_delete_trigger ON research_session_sources;
CREATE TRIGGER research_session_sources_append_only_delete_trigger
    BEFORE DELETE ON research_session_sources
    FOR EACH ROW EXECUTE FUNCTION research_session_sources_append_only();

-- THE INTEGRATION SCOPE FENCE (the migration 046/048 pattern): an
-- authorized source's integration connection must EXIST and belong to the
-- research session's agency — cross-agency connection references cannot
-- persist. The migration-029 integration_connections table is read
-- CHECK-ONLY (never written here).
CREATE OR REPLACE FUNCTION research_source_connection_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_session_agency uuid;
    v_conn record;
BEGIN
    IF NEW.integration_connection_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT s.agency_id INTO v_session_agency
      FROM research_sessions s
      JOIN research_session_versions ver
        ON ver.research_session_id = s.research_session_id
     WHERE ver.research_session_version_id = NEW.research_session_version_id;
    IF v_session_agency IS NULL THEN
        RAISE EXCEPTION 'research session source % references an unknown version %',
            NEW.source_id, NEW.research_session_version_id;
    END IF;
    SELECT connection_id, agency_id INTO v_conn
      FROM integration_connections WHERE connection_id = NEW.integration_connection_id;
    IF v_conn IS NULL THEN
        RAISE EXCEPTION 'research session source % references unknown integration connection % — a dangling authorized reference cannot persist',
            NEW.source_id, NEW.integration_connection_id;
    END IF;
    IF v_conn.agency_id <> v_session_agency THEN
        RAISE EXCEPTION 'research session source % integration connection % belongs to another agency — the agency boundary cannot be crossed',
            NEW.source_id, NEW.integration_connection_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS research_source_connection_scope_trigger ON research_session_sources;
CREATE TRIGGER research_source_connection_scope_trigger
    BEFORE INSERT ON research_session_sources
    FOR EACH ROW EXECUTE FUNCTION research_source_connection_scope_consistent();

-- ---------------------------------------------------------------------------
-- research_runs — the deterministic research run records
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS research_runs (
    research_run_id               uuid     PRIMARY KEY,
    research_session_id           uuid     NOT NULL REFERENCES research_sessions(research_session_id),
    -- The declared version that was researched (facts cite the version's
    -- sources; a later correction never rewrites a completed run).
    research_session_version_id   uuid     NOT NULL REFERENCES research_session_versions(research_session_version_id),
    -- The honest run status: completed (every source produced an outcome
    -- without error), partial (some sources failed), failed (every source
    -- failed) — never invented success.
    status                        text     NOT NULL
                                  CHECK (status IN ('completed', 'partial', 'failed')),
    sources_inspected             integer  NOT NULL CHECK (sources_inspected >= 0),
    facts_retained                integer  NOT NULL CHECK (facts_retained >= 0),
    started_at                    timestamptz NOT NULL,
    finished_at                   timestamptz NOT NULL,
    -- SERVER-DERIVED provenance (never a request field).
    recorded_actor                text     NOT NULL
                                  CHECK (length(recorded_actor) >= 1 AND length(recorded_actor) <= 100),
    recorded_via                  text     NOT NULL
                                  CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 100),
    correlation_id                text     NOT NULL,
    causation_id                  text,
    created_at                    timestamptz NOT NULL
);

-- The session's run tail (oldest first).
CREATE INDEX IF NOT EXISTS research_runs_session_idx
    ON research_runs (research_session_id, created_at, research_run_id);

-- Research runs are append-only (the honest execution record).
CREATE OR REPLACE FUNCTION research_runs_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'research runs are append-only: % is rejected',
        TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS research_runs_append_only_update_trigger ON research_runs;
CREATE TRIGGER research_runs_append_only_update_trigger
    BEFORE UPDATE ON research_runs
    FOR EACH ROW EXECUTE FUNCTION research_runs_append_only();

DROP TRIGGER IF EXISTS research_runs_append_only_delete_trigger ON research_runs;
CREATE TRIGGER research_runs_append_only_delete_trigger
    BEFORE DELETE ON research_runs
    FOR EACH ROW EXECUTE FUNCTION research_runs_append_only();

-- ---------------------------------------------------------------------------
-- research_run_source_outcomes — the per-source honest outcome rows
-- ---------------------------------------------------------------------------

-- Every researched source's outcome is recorded honestly: facts extracted,
-- no facts extracted, unauthorized refused (§7 — the read-only
-- authorization gate), fetch/transport errors, integration read errors and
-- policy-refused reads. NOTHING is silently dropped.
CREATE TABLE IF NOT EXISTS research_run_source_outcomes (
    research_run_source_outcome_id  uuid    PRIMARY KEY,
    research_run_id                 uuid    NOT NULL REFERENCES research_runs(research_run_id),
    source_id                       uuid    NOT NULL REFERENCES research_session_sources(source_id),
    outcome                         text    NOT NULL
                                    CHECK (outcome IN ('facts_extracted', 'no_facts_extracted',
                                                        'unauthorized_refused', 'fetch_http_error',
                                                        'fetch_transport_error', 'read_error',
                                                        'read_refused')),
    detail                          text    CHECK (detail IS NULL
                                           OR (length(detail) >= 1 AND length(detail) <= 2000)),
    facts_extracted                 integer NOT NULL CHECK (facts_extracted >= 0),
    created_at                      timestamptz NOT NULL
);

-- The per-source outcome rows are append-only.
CREATE OR REPLACE FUNCTION research_run_source_outcomes_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'research run source outcomes are append-only: % is rejected',
        TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS research_run_source_outcomes_append_only_update_trigger ON research_run_source_outcomes;
CREATE TRIGGER research_run_source_outcomes_append_only_update_trigger
    BEFORE UPDATE ON research_run_source_outcomes
    FOR EACH ROW EXECUTE FUNCTION research_run_source_outcomes_append_only();

DROP TRIGGER IF EXISTS research_run_source_outcomes_append_only_delete_trigger ON research_run_source_outcomes;
CREATE TRIGGER research_run_source_outcomes_append_only_delete_trigger
    BEFORE DELETE ON research_run_source_outcomes
    FOR EACH ROW EXECUTE FUNCTION research_run_source_outcomes_append_only();

-- ---------------------------------------------------------------------------
-- research_source_facts — the append-only retained source facts
-- ---------------------------------------------------------------------------

-- Every material source fact retained with FULL provenance
-- (architecture-v1.6.md §7: "Every material source fact retains source
-- provenance."): the source URL/reference observed, the fetched-at time,
-- the EXTRACTOR IDENTITY (the frozen, versioned extractor label), the
-- CONTENT HASH of the material the fact was extracted from, the extraction
-- notes and the bounded extracted observation content. Facts are EXTRACTED
-- OBSERVATIONS, never conclusions — the fact kinds are the frozen
-- deterministic-extractor vocabulary.
CREATE TABLE IF NOT EXISTS research_source_facts (
    research_source_fact_id        uuid     PRIMARY KEY,
    research_session_id            uuid     NOT NULL REFERENCES research_sessions(research_session_id),
    research_session_version_id    uuid     NOT NULL REFERENCES research_session_versions(research_session_version_id),
    -- The declared source the fact was extracted FROM (FK-anchored — a
    -- dangling source reference cannot persist).
    source_id                      uuid     NOT NULL REFERENCES research_session_sources(source_id),
    research_run_id                uuid     NOT NULL REFERENCES research_runs(research_run_id),
    -- The frozen deterministic fact-kind vocabulary.
    fact_kind                      text     NOT NULL
                                   CHECK (fact_kind IN ('page_title', 'meta_description',
                                                        'meta_keywords', 'og_title', 'og_description',
                                                        'canonical_url', 'page_language', 'heading',
                                                        'text_excerpt', 'source_record')),
    -- The source URL/reference the fact was observed at (VERBATIM).
    source_ref                     text     NOT NULL
                                   CHECK (length(source_ref) >= 1 AND length(source_ref) <= 2048),
    fetched_at                     timestamptz NOT NULL,
    -- The EXTRACTOR IDENTITY: the frozen, versioned extractor label
    -- ('research-html-extract-v1' for public page extraction;
    -- 'research-integration-read-v1' for authorized reads through the
    -- /integrations public contract).
    extractor                      text     NOT NULL
                                   CHECK (length(extractor) >= 1 AND length(extractor) <= 100),
    -- The CONTENT HASH: sha256 hex of the material the fact was extracted
    -- from (the fetched page body / the normalized provider record).
    content_hash                   text     NOT NULL
                                   CHECK (length(content_hash) = 64),
    -- The bounded extraction notes (the honest observation notes).
    extraction_notes               text     CHECK (extraction_notes IS NULL
                                            OR (length(extraction_notes) >= 1
                                                AND length(extraction_notes) <= 2000)),
    -- The bounded extracted observation content (a non-empty JSON object;
    -- §21-guarded at the module boundary — material-shaped keys never
    -- persist here).
    content                        jsonb    NOT NULL
                                   CHECK (jsonb_typeof(content) = 'object'),
    -- SERVER-DERIVED provenance (never a request field).
    recorded_actor                 text     NOT NULL
                                   CHECK (length(recorded_actor) >= 1 AND length(recorded_actor) <= 100),
    recorded_via                   text     NOT NULL
                                   CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 100),
    correlation_id                 text     NOT NULL,
    causation_id                   text,
    created_at                     timestamptz NOT NULL
);

-- The session's fact tail (oldest first) + the source/lookup surfaces.
CREATE INDEX IF NOT EXISTS research_source_facts_session_idx
    ON research_source_facts (research_session_id, created_at, research_source_fact_id);
CREATE INDEX IF NOT EXISTS research_source_facts_source_idx
    ON research_source_facts (source_id, created_at);

-- Source facts are append-only (the retained observation ledger).
CREATE OR REPLACE FUNCTION research_source_facts_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'research source facts are append-only: % is rejected on fact %',
        TG_OP, OLD.research_source_fact_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS research_source_facts_append_only_update_trigger ON research_source_facts;
CREATE TRIGGER research_source_facts_append_only_update_trigger
    BEFORE UPDATE ON research_source_facts
    FOR EACH ROW EXECUTE FUNCTION research_source_facts_append_only();

DROP TRIGGER IF EXISTS research_source_facts_append_only_delete_trigger ON research_source_facts;
CREATE TRIGGER research_source_facts_append_only_delete_trigger
    BEFORE DELETE ON research_source_facts
    FOR EACH ROW EXECUTE FUNCTION research_source_facts_append_only();

-- ---------------------------------------------------------------------------
-- research_insights — the append-only §7 model-output claim records
-- ---------------------------------------------------------------------------

-- The §7 research insight set: topic syntheses, trend observations,
-- market notes, audience signals, competitor signals and source critiques
-- — every insight a CLAIM ("Model output is a claim unless backed by
-- evidence"): its verification state is computed SERVER-SIDE from its own
-- evidence set, and the AI-assistance disclosure is carried verbatim when
-- the insight was derived with ai-runtime assistance.
CREATE TABLE IF NOT EXISTS research_insights (
    research_insight_id             uuid     PRIMARY KEY,
    research_session_id             uuid     NOT NULL REFERENCES research_sessions(research_session_id),
    derivation_kind                 text     NOT NULL
                                    CHECK (derivation_kind IN ('topic_synthesis',
                                                                'trend_observation',
                                                                'market_note',
                                                                'audience_signal',
                                                                'competitor_signal',
                                                                'source_critique')),
    -- The insight statement (a bounded non-empty JSON object with a
    -- required summary — the CLAIM itself; a synthesis stays a claim,
    -- never a fact).
    statement                       jsonb    NOT NULL
                                    CHECK (jsonb_typeof(statement) = 'object'
                                           AND statement ? 'summary'
                                           AND length(statement ->> 'summary') >= 1
                                           AND length(statement ->> 'summary') <= 2000),
    -- The verification state — computed SERVER-SIDE from the record's own
    -- evidence set (never caller-declared); the deferred constraint
    -- trigger below is the commit-time backstop.
    verification_state              text     NOT NULL
                                    CHECK (verification_state IN ('unverified', 'evidence_backed')),
    -- The single-supersession correction chain (the migration 015
    -- /evidence pattern): a correction is a NEW record citing the prior
    -- one; the prior is never rewritten. Verification-state transitions
    -- ride this chain (an unverified record is corrected by an
    -- evidence-backed one).
    supersedes_research_insight_id  uuid     REFERENCES research_insights(research_insight_id),
    -- The AI-ASSISTANCE DISCLOSURE (architecture-v1.6.md §7): when the
    -- insight was derived with ai-runtime assistance, the model identity
    -- (registry id + the display label snapshotted at record time) and
    -- the model call reference are carried verbatim — all three or none.
    ai_model_registry_id            uuid,
    ai_model_display                text     CHECK (ai_model_display IS NULL
                                             OR (length(ai_model_display) >= 1
                                                 AND length(ai_model_display) <= 300)),
    ai_call_reference               text     CHECK (ai_call_reference IS NULL
                                             OR (length(ai_call_reference) >= 1
                                                 AND length(ai_call_reference) <= 500)),
    -- SERVER-DERIVED provenance (never a request field).
    recorded_actor                  text     NOT NULL
                                    CHECK (length(recorded_actor) >= 1 AND length(recorded_actor) <= 100),
    recorded_via                    text     NOT NULL
                                    CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 100),
    correlation_id                  text     NOT NULL,
    causation_id                    text,
    created_at                      timestamptz NOT NULL,
    CONSTRAINT research_insight_ai_shape CHECK (
        (ai_model_registry_id IS NULL AND ai_model_display IS NULL AND ai_call_reference IS NULL)
        OR (ai_model_registry_id IS NOT NULL AND ai_model_display IS NOT NULL
            AND ai_call_reference IS NOT NULL)
    )
);

-- The session's insight tail (oldest first).
CREATE INDEX IF NOT EXISTS research_insights_session_idx
    ON research_insights (research_session_id, created_at, research_insight_id);

-- THE SINGLE-SUPERSESSION FENCE (the migration 015 pattern): at most ONE
-- superseding record per prior record.
CREATE UNIQUE INDEX IF NOT EXISTS research_insight_supersession_fence
    ON research_insights (supersedes_research_insight_id)
    WHERE supersedes_research_insight_id IS NOT NULL;

-- Research insights are append-only: corrections are NEW records.
CREATE OR REPLACE FUNCTION research_insights_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'research insights are append-only: % is rejected on insight %',
        TG_OP, OLD.research_insight_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS research_insights_append_only_update_trigger ON research_insights;
CREATE TRIGGER research_insights_append_only_update_trigger
    BEFORE UPDATE ON research_insights
    FOR EACH ROW EXECUTE FUNCTION research_insights_append_only();

DROP TRIGGER IF EXISTS research_insights_append_only_delete_trigger ON research_insights;
CREATE TRIGGER research_insights_append_only_delete_trigger
    BEFORE DELETE ON research_insights
    FOR EACH ROW EXECUTE FUNCTION research_insights_append_only();

-- THE SUPERSESSION CONSISTENCY FENCE (the migration 025/048 deferred
-- pattern): a superseding insight must reference a record of the SAME
-- research session and the SAME derivation kind (a correction never
-- changes its subject), verified at COMMIT — every mutation path,
-- including direct SQL.
CREATE OR REPLACE FUNCTION research_insight_supersession_consistent() RETURNS trigger AS $$
DECLARE
    v_prior record;
BEGIN
    IF NEW.supersedes_research_insight_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT research_session_id, derivation_kind
      INTO v_prior
      FROM research_insights
     WHERE research_insight_id = NEW.supersedes_research_insight_id;
    IF v_prior IS NULL THEN
        RAISE EXCEPTION 'research insight % supersedes unknown record % — a dangling correction cannot persist',
            NEW.research_insight_id, NEW.supersedes_research_insight_id;
    END IF;
    IF v_prior.research_session_id <> NEW.research_session_id THEN
        RAISE EXCEPTION 'research insight % cannot supersede a record of another research session — the session boundary cannot be crossed',
            NEW.research_insight_id;
    END IF;
    IF v_prior.derivation_kind <> NEW.derivation_kind THEN
        RAISE EXCEPTION 'research insight % must supersede a record of the same derivation kind (a correction never changes its subject)',
            NEW.research_insight_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS research_insight_supersession_trigger ON research_insights;
CREATE CONSTRAINT TRIGGER research_insight_supersession_trigger
    AFTER INSERT ON research_insights
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION research_insight_supersession_consistent();

-- ---------------------------------------------------------------------------
-- research_insight_evidence — the FK-anchored evidence links
-- ---------------------------------------------------------------------------

-- The evidence references backing one research insight: FK-anchored source
-- facts of the SAME research session (the module resolves and validates
-- each reference BEFORE any row persists; the trigger + FK are the
-- backstops).
CREATE TABLE IF NOT EXISTS research_insight_evidence (
    research_insight_id  uuid    NOT NULL REFERENCES research_insights(research_insight_id),
    source_fact_id       uuid    NOT NULL REFERENCES research_source_facts(research_source_fact_id),
    -- Citation order preserved.
    position             integer NOT NULL CHECK (position >= 1),
    CONSTRAINT research_insight_evidence_pk
        PRIMARY KEY (research_insight_id, source_fact_id)
);

-- Evidence links are append-only.
CREATE OR REPLACE FUNCTION research_insight_evidence_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'research insight evidence links are append-only: % is rejected',
        TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS research_insight_evidence_append_only_update_trigger ON research_insight_evidence;
CREATE TRIGGER research_insight_evidence_append_only_update_trigger
    BEFORE UPDATE ON research_insight_evidence
    FOR EACH ROW EXECUTE FUNCTION research_insight_evidence_append_only();

DROP TRIGGER IF EXISTS research_insight_evidence_append_only_delete_trigger ON research_insight_evidence;
CREATE TRIGGER research_insight_evidence_append_only_delete_trigger
    BEFORE DELETE ON research_insight_evidence
    FOR EACH ROW EXECUTE FUNCTION research_insight_evidence_append_only();

-- THE VERIFICATION-STATE INVARIANT (architecture-v1.6.md §7: "Model output
-- is a claim unless backed by evidence" — made durable): verified at
-- COMMIT — an 'evidence_backed' insight MUST carry at least one evidence
-- row and an 'unverified' insight MUST carry none, for every mutation path
-- including direct SQL. The state is computed server-side from the
-- record's own evidence set; this deferred trigger is the backstop that
-- makes the invariant unfalsifiable.
CREATE OR REPLACE FUNCTION research_insight_verification_consistent() RETURNS trigger AS $$
DECLARE
    v_evidence_count integer;
BEGIN
    SELECT count(*) INTO v_evidence_count
      FROM research_insight_evidence
     WHERE research_insight_id = NEW.research_insight_id;
    IF NEW.verification_state = 'evidence_backed' AND v_evidence_count = 0 THEN
        RAISE EXCEPTION 'research insight % is evidence_backed but cites no source fact — a derived record without backing evidence can never be presented as established',
            NEW.research_insight_id;
    END IF;
    IF NEW.verification_state = 'unverified' AND v_evidence_count > 0 THEN
        RAISE EXCEPTION 'research insight % is unverified but cites % source fact(s) — the verification state must match the evidence set',
            NEW.research_insight_id, v_evidence_count;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS research_insight_verification_trigger ON research_insights;
CREATE CONSTRAINT TRIGGER research_insight_verification_trigger
    AFTER INSERT ON research_insights
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION research_insight_verification_consistent();

-- THE EVIDENCE SCOPE FENCE: an evidence link must reference a source fact
-- of the SAME research session as the insight.
CREATE OR REPLACE FUNCTION research_insight_evidence_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_insight_session uuid;
    v_fact_session uuid;
BEGIN
    SELECT research_session_id INTO v_insight_session
      FROM research_insights WHERE research_insight_id = NEW.research_insight_id;
    SELECT research_session_id INTO v_fact_session
      FROM research_source_facts WHERE research_source_fact_id = NEW.source_fact_id;
    IF v_insight_session IS NULL OR v_fact_session IS NULL OR v_insight_session <> v_fact_session THEN
        RAISE EXCEPTION 'research insight evidence link %→% crosses a research session boundary — evidence references stay inside one session',
            NEW.research_insight_id, NEW.source_fact_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS research_insight_evidence_scope_trigger ON research_insight_evidence;
CREATE TRIGGER research_insight_evidence_scope_trigger
    BEFORE INSERT ON research_insight_evidence
    FOR EACH ROW EXECUTE FUNCTION research_insight_evidence_scope_consistent();
