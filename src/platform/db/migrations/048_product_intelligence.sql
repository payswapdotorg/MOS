-- 048_product_intelligence.sql — MKT-069 (Product Intelligence).
--
-- The PRODUCT/MARKET INSPECTION AND MODEL record layer
-- (spec/effective-backlog-v1.6.md MKT-069; spec/architecture-v1.6.md §7/§8;
-- spec/module-dependency-matrix-v1.6.md boundary rule 7: "Product
-- Intelligence has read-only source-code/product inspection unless a
-- separate write capability is explicitly granted"):
--
--   product_contexts          → the agency-scoped Product Context records
--                                (the current declared version pointer +
--                                the CAS version — the growth_missions
--                                record discipline);
--   product_context_versions  → the APPEND-ONLY VERSION TAIL (one immutable
--                                row per declared product context — the
--                                product name + summary + provenance;
--                                corrections are NEW version records, never
--                                in-place rewrites);
--   product_context_inputs    → the per-version DECLARED INPUTS (the frozen
--                                §8 input-kind vocabulary, each input
--                                carrying its authorization state — public
--                                vs explicitly authorized — and, for
--                                explicitly-authorized inputs, the
--                                /integrations connection reference that
--                                authorizes the read; append-only with the
--                                version snapshot);
--   product_source_facts      → the APPEND-ONLY SOURCE-FACT LEDGER: every
--                                material source fact retained with FULL
--                                provenance (source URL/reference,
--                                fetched-at, extractor identity, content
--                                hash, extraction notes) — extracted
--                                OBSERVATIONS, never conclusions;
--   product_derived_models    → the APPEND-ONLY DERIVED MODEL records (the
--                                §8 derivation set): each carries the
--                                backing source-fact references + canonical
--                                /evidence citations, the ai-runtime
--                                assistance disclosure when derived with
--                                model help, and the server-derived
--                                VERIFICATION STATE — a record without
--                                backing evidence references is 'unverified'
--                                and can never be presented as established;
--                                hypotheses stay hypotheses (frozen kind
--                                CHECK — repetition never promotes);
--   product_risk_flags        → the APPEND-ONLY RISK-FLAG records
--                                (compliance/privacy/toxicity/commercial/
--                                operational) with the severity vocabulary,
--                                provenance and the same evidence-backing
--                                discipline.
--
-- Boundary discipline (frozen by this migration):
-- * READ-ONLY SOURCE INSPECTION (boundary rule 7): the authorization_ref
--   column anchors an EXISTING /integrations connection (migration 029 —
--   the growth_mission_goal_mappings goal-FK precedent); the module reads
--   through the /integrations public contract's read surface ONLY. There
--   is deliberately NO column, table or trigger here capable of expressing
--   a write toward any external source — a future write capability is a
--   separately granted capability key and its own Work Item (documented
--   seam on the module public contract; NOT built here).
-- * NO AUTHORITY TRANSFER: this migration creates NO workflow, execution,
--   playbook, experiment, evidence, learning, mission, job, deployment,
--   integration, credential or tenant table. The agencies registry, the
--   /evidence ledger and the /integrations connection registry are read
--   CHECK-ONLY (trigger reads + the FK anchors): no row of another
--   authority is ever created or mutated here.
-- * THE APPEND-ONLY DISCIPLINE (the 036/044/045 house pattern): the
--   version tail, the per-version inputs, the source-fact ledger, the
--   derived model records and the risk flags reject UPDATE and DELETE
--   outright — not even server code can rewrite what was observed or
--   derived. Corrections are NEW version records; the context record's
--   identity/scope columns are immutable and its version pointer only
--   ever ADVANCES (trigger).
-- * THE HONEST EVIDENCE LINKAGE (the decisions same-client precedent):
--   a derived model / risk flag's source-fact references must belong to
--   the SAME product context (trigger); its canonical /evidence citations
--   must exist and their owning Client must belong to the context's
--   Agency (trigger) — cross-tenant evidence linkage is rejected.
-- * THE VERIFICATION-STATE FENCE (§7: "Model output is a claim unless
--   backed by evidence"): the derived-record CHECK ties
--   verification_state = 'unverified' to ZERO backing references and
--   'evidence_backed' to AT LEAST ONE — the state cannot be asserted
--   independently of the backing. The hypothesis flag is FROZEN to the
--   kind (user_problem_hypothesis / icp_audience_hypothesis): a hypothesis
--   record is born a hypothesis and no UPDATE path exists that could ever
--   change it (append-only).
-- * NO SECRET MATERIAL ANYWHERE (§21): the only structured payload
--   columns are the bounded observation/detail jsonb objects and the
--   bounded provenance columns — there is deliberately NO column capable
--   of holding secret material, a secret handle beyond the /integrations
--   connection reference, or free-form caller payload beyond the declared
--   bounded content.
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, row-locked CAS mutations, append-oriented records. No
-- owner/role/user columns beyond provenance: agency-scope authorization
-- stays exactly the /agencies membership + platform-role authorities
-- resolved at the route layer — no second tenant, permission or identity
-- authority.

-- ---------------------------------------------------------------------------
-- product_contexts — the agency-scoped Product Context records
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS product_contexts (
    product_context_id  uuid        PRIMARY KEY,
    -- AGENCY-SCOPED (spec/effective-backlog-v1.6.md MKT-069 AC-1: the
    -- agency-scoped product-context records; the owning agency is resolved
    -- through the disclosed /agencies structural port BEFORE any write and
    -- is immutable here).
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    -- The CURRENT declared version (the append-only tail pointer).
    current_version_seq integer     NOT NULL CHECK (current_version_seq >= 1),
    -- The CAS token (row-locked mutations advance it by exactly one).
    version             bigint      NOT NULL CHECK (version >= 1),
    created_actor       text        NOT NULL
                        CHECK (length(created_actor) >= 1 AND length(created_actor) <= 100),
    created_at          timestamptz NOT NULL,
    updated_at          timestamptz NOT NULL
);

-- The agency listing surface (oldest first).
CREATE INDEX IF NOT EXISTS product_contexts_agency_idx
    ON product_contexts (agency_id, created_at, product_context_id);

-- CONTEXT-RECORD MUTATION GUARD (the growth_mission_record_guard
-- precedent): identity/scope/provenance are immutable; the CAS version
-- advances by exactly one; the version pointer only ever ADVANCES and
-- must reference an EXISTING declared version of the same context
-- (corrections are NEW version records — the pointer can never regress
-- and can never dangle).
CREATE OR REPLACE FUNCTION product_context_record_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.product_context_id <> OLD.product_context_id
       OR NEW.agency_id <> OLD.agency_id
       OR NEW.created_actor <> OLD.created_actor
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'product context % identity/scope/provenance is immutable — corrections are new version records, never rewrites',
            OLD.product_context_id;
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
        RAISE EXCEPTION 'product context % CAS version must advance by exactly one (expected %, got %)',
            OLD.product_context_id, OLD.version + 1, NEW.version;
    END IF;
    IF NEW.current_version_seq < OLD.current_version_seq THEN
        RAISE EXCEPTION 'product context % current version cannot regress (corrections advance the version tail only)',
            OLD.product_context_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM product_context_versions v
        WHERE v.product_context_id = NEW.product_context_id
          AND v.version_seq = NEW.current_version_seq) THEN
        RAISE EXCEPTION 'product context % current_version_seq % must reference an existing declared version of this context',
            NEW.product_context_id, NEW.current_version_seq;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_context_record_guard_trigger ON product_contexts;
CREATE TRIGGER product_context_record_guard_trigger
    BEFORE UPDATE ON product_contexts
    FOR EACH ROW EXECUTE FUNCTION product_context_record_guard();

-- Context records are never deleted (business history is append-only).
CREATE OR REPLACE FUNCTION product_contexts_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'product contexts cannot be deleted — product intelligence history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_contexts_no_delete_trigger ON product_contexts;
CREATE TRIGGER product_contexts_no_delete_trigger
    BEFORE DELETE ON product_contexts
    FOR EACH ROW EXECUTE FUNCTION product_contexts_no_delete();

-- ---------------------------------------------------------------------------
-- product_context_versions — the append-only declared-context tail
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS product_context_versions (
    product_context_version_id uuid   PRIMARY KEY,
    product_context_id         uuid   NOT NULL REFERENCES product_contexts(product_context_id),
    -- The version sequence within the context (gapless from 1, assigned
    -- under the context row lock).
    version_seq                integer NOT NULL CHECK (version_seq >= 1),
    -- The declared product name (bounded).
    name                       text    NOT NULL
                               CHECK (length(name) >= 1 AND length(name) <= 500),
    -- The bounded free-form declared summary (nullable).
    summary                    text    CHECK (summary IS NULL OR (length(summary) >= 1 AND length(summary) <= 5000)),
    -- SERVER-DERIVED provenance (never a request field).
    recorded_actor             text    NOT NULL
                               CHECK (length(recorded_actor) >= 1 AND length(recorded_actor) <= 100),
    recorded_via               text    NOT NULL
                               CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 100),
    correlation_id             text    NOT NULL,
    causation_id               text,
    created_at                 timestamptz NOT NULL,
    CONSTRAINT product_context_versions_seq_unique UNIQUE (product_context_id, version_seq)
);

-- APPEND-ONLY VERSION TAIL (the migration 045 pattern): the database
-- itself rejects UPDATE and DELETE on the declared context history — a
-- correction is a NEW version row, never a rewrite.
CREATE OR REPLACE FUNCTION product_context_versions_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'product context versions are append-only: % is rejected on version %',
        TG_OP, OLD.product_context_version_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_context_versions_append_only_update_trigger ON product_context_versions;
CREATE TRIGGER product_context_versions_append_only_update_trigger
    BEFORE UPDATE ON product_context_versions
    FOR EACH ROW EXECUTE FUNCTION product_context_versions_append_only();

DROP TRIGGER IF EXISTS product_context_versions_append_only_delete_trigger ON product_context_versions;
CREATE TRIGGER product_context_versions_append_only_delete_trigger
    BEFORE DELETE ON product_context_versions
    FOR EACH ROW EXECUTE FUNCTION product_context_versions_append_only();

-- ---------------------------------------------------------------------------
-- product_context_inputs — the per-version declared inputs (§8, AC-1)
-- ---------------------------------------------------------------------------

-- Each input row rides its IMMUTABLE version snapshot: the frozen §8
-- input-kind vocabulary, the authorization state ('public' vs
-- 'explicitly_authorized'), and — for explicitly-authorized inputs — the
-- /integrations connection reference that authorizes the read (an
-- EXISTING migration-029 connection row; FK-anchored so a dangling
-- authorization reference cannot persist). The per-kind authorization
-- fence below freezes WHICH states each kind may carry (the disclosed
-- module guard is the primary gate; this CHECK is the backstop).
CREATE TABLE IF NOT EXISTS product_context_inputs (
    input_id                 uuid   PRIMARY KEY,
    product_context_version_id uuid NOT NULL REFERENCES product_context_versions(product_context_version_id),
    -- The frozen §8 input-kind vocabulary, CHECK-fenced.
    input_kind               text   NOT NULL
                             CHECK (input_kind IN ('public_site_url',
                                                   'authenticated_app_environment',
                                                   'source_code_repository_url',
                                                   'connected_source_workspace',
                                                   'product_documentation',
                                                   'catalog_inventory',
                                                   'current_analytics')),
    -- The input's source reference (a public URL, a repository URL, a
    -- documentation/catalog/analytics reference — bounded).
    reference                text   NOT NULL
                             CHECK (length(reference) >= 1 AND length(reference) <= 2048),
    -- The authorization state the input was declared with (AC-1).
    authorization_state      text   NOT NULL
                             CHECK (authorization_state IN ('public', 'explicitly_authorized')),
    -- The /integrations connection id authorizing an explicitly-authorized
    -- input (NULL for public inputs — the shape fence below).
    authorization_ref        uuid,
    notes                    text   CHECK (notes IS NULL OR (length(notes) >= 1 AND length(notes) <= 2000)),
    created_at               timestamptz NOT NULL,
    -- THE AUTHORIZATION-SHAPE FENCE: an explicitly-authorized input ALWAYS
    -- carries its authorization reference; a public input NEVER does.
    CONSTRAINT product_context_input_authorization_shape CHECK (
        (authorization_state = 'explicitly_authorized' AND authorization_ref IS NOT NULL)
        OR (authorization_state = 'public' AND authorization_ref IS NULL)
    ),
    -- THE PER-KIND AUTHORIZATION FENCE (the disclosed module guard's
    -- frozen map, made durable): a public product/site URL is public
    -- ONLY; an authenticated application environment and a connected
    -- source workspace are explicitly authorized ONLY; the remaining
    -- kinds may be declared either way.
    CONSTRAINT product_context_input_kind_authorization CHECK (
        (input_kind = 'public_site_url' AND authorization_state = 'public')
        OR (input_kind = 'authenticated_app_environment' AND authorization_state = 'explicitly_authorized')
        OR (input_kind = 'connected_source_workspace' AND authorization_state = 'explicitly_authorized')
        OR (input_kind IN ('source_code_repository_url', 'product_documentation',
                           'catalog_inventory', 'current_analytics'))
    ),
    -- The authorization reference must anchor an EXISTING /integrations
    -- connection (migration 029 — the goal-FK precedent; the connection
    -- registry is read CHECK-ONLY from here).
    CONSTRAINT product_context_input_authorization_fk
        FOREIGN KEY (authorization_ref) REFERENCES integration_connections(connection_id)
);

-- The per-version input scan surface.
CREATE INDEX IF NOT EXISTS product_context_inputs_version_idx
    ON product_context_inputs (product_context_version_id, input_id);

-- The declared inputs are append-only with their version snapshot.
CREATE OR REPLACE FUNCTION product_context_inputs_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'product context inputs are append-only: % is rejected',
        TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_context_inputs_append_only_update_trigger ON product_context_inputs;
CREATE TRIGGER product_context_inputs_append_only_update_trigger
    BEFORE UPDATE ON product_context_inputs
    FOR EACH ROW EXECUTE FUNCTION product_context_inputs_append_only();

DROP TRIGGER IF EXISTS product_context_inputs_append_only_delete_trigger ON product_context_inputs;
CREATE TRIGGER product_context_inputs_append_only_delete_trigger
    BEFORE DELETE ON product_context_inputs
    FOR EACH ROW EXECUTE FUNCTION product_context_inputs_append_only();

-- ---------------------------------------------------------------------------
-- product_source_facts — the append-only source-fact ledger (AC-2)
-- ---------------------------------------------------------------------------

-- Every material source fact is retained with FULL provenance: the source
-- URL/reference, the fetched-at time, the extractor identity, the content
-- hash and the extraction notes. The observation payload is the EXTRACTED
-- OBSERVATION — never a conclusion (conclusions live ONLY in the derived
-- model records, where they must cite these facts as backing).
CREATE TABLE IF NOT EXISTS product_source_facts (
    source_fact_id            uuid   PRIMARY KEY,
    product_context_id        uuid   NOT NULL REFERENCES product_contexts(product_context_id),
    product_context_version_id uuid  NOT NULL REFERENCES product_context_versions(product_context_version_id),
    -- The declared input the fact was extracted from (the fact rides the
    -- input's version — the same-version fence below).
    input_id                  uuid   NOT NULL REFERENCES product_context_inputs(input_id),
    -- The source URL/reference the fact was observed at (bounded).
    source_url                text   NOT NULL
                              CHECK (length(source_url) >= 1 AND length(source_url) <= 2048),
    -- When the source was fetched/read (module clock at fetch time).
    fetched_at                timestamptz NOT NULL,
    -- The extractor identity (a versioned extractor label, e.g.
    -- 'site-page-extractor-v1' — bounded, disclosed in the runbook).
    extractor                 text   NOT NULL
                              CHECK (length(extractor) >= 1 AND length(extractor) <= 100),
    -- The sha-256 hex hash of the fetched content (exactly 64 hex chars).
    content_hash              text   NOT NULL
                              CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    -- The bounded extraction notes (honest extractor annotations — never
    -- conclusions).
    extraction_notes          text   CHECK (extraction_notes IS NULL OR (length(extraction_notes) >= 1 AND length(extraction_notes) <= 2000)),
    -- The extracted observation (a non-empty JSON object — the observed
    -- content shape, never an interpretation).
    observation               jsonb  NOT NULL CHECK (jsonb_typeof(observation) = 'object'),
    -- SERVER-DERIVED provenance (never a request field).
    actor                     text   NOT NULL
                              CHECK (length(actor) >= 1 AND length(actor) <= 100),
    recorded_via              text   NOT NULL
                              CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 100),
    correlation_id            text   NOT NULL,
    causation_id              text,
    recorded_at               timestamptz NOT NULL,
    -- THE UNCHANGED-SOURCE FENCE: a given input of a given declared
    -- version yields at most ONE fact per (extractor, content) — an
    -- unchanged source is never re-appended as a fresh observation
    -- (re-inspection honestly conflicts; a CHANGED source appends a new
    -- fact).
    CONSTRAINT product_source_facts_source_fence
        UNIQUE (product_context_version_id, input_id, extractor, content_hash)
);

-- The ledger scan surfaces.
CREATE INDEX IF NOT EXISTS product_source_facts_context_idx
    ON product_source_facts (product_context_id, recorded_at, source_fact_id);
CREATE INDEX IF NOT EXISTS product_source_facts_input_idx
    ON product_source_facts (input_id);

-- THE SAME-VERSION FENCE: a source fact's input must belong to the SAME
-- declared version the fact is attached to (the fact rides the version
-- snapshot that declared the input).
CREATE OR REPLACE FUNCTION product_source_fact_input_consistent() RETURNS trigger AS $$
DECLARE
    v_input_version uuid;
    v_input_context uuid;
    v_version_context uuid;
BEGIN
    SELECT product_context_version_id INTO v_input_version
        FROM product_context_inputs WHERE input_id = NEW.input_id;
    IF v_input_version IS NULL THEN
        RAISE EXCEPTION 'source fact % references unknown input % — a dangling input reference cannot persist',
            NEW.source_fact_id, NEW.input_id;
    END IF;
    IF v_input_version <> NEW.product_context_version_id THEN
        RAISE EXCEPTION 'source fact % input % belongs to a different declared version — facts ride the input''s version snapshot',
            NEW.source_fact_id, NEW.input_id;
    END IF;
    SELECT product_context_id INTO v_input_context
        FROM product_context_versions WHERE product_context_version_id = NEW.product_context_version_id;
    SELECT product_context_id INTO v_version_context
        FROM product_contexts WHERE product_context_id = NEW.product_context_id;
    IF v_version_context IS NULL THEN
        RAISE EXCEPTION 'source fact % references unknown product context %',
            NEW.source_fact_id, NEW.product_context_id;
    END IF;
    IF v_input_context IS DISTINCT FROM NEW.product_context_id THEN
        RAISE EXCEPTION 'source fact % input % belongs to another product context — cross-context fact linkage is rejected',
            NEW.source_fact_id, NEW.input_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_source_fact_input_consistent_trigger ON product_source_facts;
CREATE TRIGGER product_source_fact_input_consistent_trigger
    BEFORE INSERT ON product_source_facts
    FOR EACH ROW EXECUTE FUNCTION product_source_fact_input_consistent();

-- APPEND-ONLY SOURCE-FACT LEDGER: the database itself rejects UPDATE and
-- DELETE on the observation history — not even server code can rewrite
-- what was observed.
CREATE OR REPLACE FUNCTION product_source_facts_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'product source facts are append-only: % is rejected on fact %',
        TG_OP, OLD.source_fact_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_source_facts_append_only_update_trigger ON product_source_facts;
CREATE TRIGGER product_source_facts_append_only_update_trigger
    BEFORE UPDATE ON product_source_facts
    FOR EACH ROW EXECUTE FUNCTION product_source_facts_append_only();

DROP TRIGGER IF EXISTS product_source_facts_append_only_delete_trigger ON product_source_facts;
CREATE TRIGGER product_source_facts_append_only_delete_trigger
    BEFORE DELETE ON product_source_facts
    FOR EACH ROW EXECUTE FUNCTION product_source_facts_append_only();

-- ---------------------------------------------------------------------------
-- product_derived_models — the append-only derived model records (§8, AC-3)
-- ---------------------------------------------------------------------------

-- Each derived record is a MODEL CLAIM (never an observation): the frozen
-- §8 derivation kind, the derived statement (verbatim), an optional
-- structured detail payload, the backing source-fact references + canonical
-- /evidence citations, the ai-runtime assistance disclosure when derived
-- with model help, and the server-derived verification state.
CREATE TABLE IF NOT EXISTS product_derived_models (
    derived_model_id          uuid   PRIMARY KEY,
    product_context_id        uuid   NOT NULL REFERENCES product_contexts(product_context_id),
    -- The declared version the derivation was recorded against (the
    -- version current at recording time — server-derived).
    product_context_version_id uuid  NOT NULL REFERENCES product_context_versions(product_context_version_id),
    -- The frozen §8 derivation-kind vocabulary (nine kinds, CHECK-fenced).
    derivation_kind           text   NOT NULL
                              CHECK (derivation_kind IN ('product_capability',
                                                          'user_problem_hypothesis',
                                                          'icp_audience_hypothesis',
                                                          'value_proposition',
                                                          'conversion_path',
                                                          'content_worthy_feature',
                                                          'market_language',
                                                          'product_risk',
                                                          'commercial_metric')),
    -- The derived statement (the claim/hypothesis, verbatim — bounded).
    statement                 text   NOT NULL
                              CHECK (length(statement) >= 1 AND length(statement) <= 2000),
    -- Optional structured derivation detail (a JSON object).
    detail                    jsonb  CHECK (detail IS NULL OR jsonb_typeof(detail) = 'object'),
    -- The backing source-fact references (jsonb array of this module's
    -- source-fact ids — same-context trigger below; the AC-3 evidence
    -- links).
    source_fact_ids           jsonb  NOT NULL DEFAULT '[]'::jsonb
                              CHECK (jsonb_typeof(source_fact_ids) = 'array'),
    -- Canonical /evidence citations (jsonb array of /evidence record ids
    -- — same-agency trigger below; the /decisions citation precedent).
    evidence_citations        jsonb  NOT NULL DEFAULT '[]'::jsonb
                              CHECK (jsonb_typeof(evidence_citations) = 'array'),
    -- The ai-runtime assistance disclosure (model identity + call
    -- reference — the /ai-runtime selection-decision id the derivation was
    -- produced through; all-or-nothing pair).
    ai_model_identity         text   CHECK (ai_model_identity IS NULL OR (length(ai_model_identity) >= 1 AND length(ai_model_identity) <= 200)),
    ai_call_reference         text   CHECK (ai_call_reference IS NULL OR (length(ai_call_reference) >= 1 AND length(ai_call_reference) <= 100)),
    -- The server-derived verification state (the §7 claim-unless-backed
    -- rule, made durable).
    verification_state        text   NOT NULL
                              CHECK (verification_state IN ('unverified', 'evidence_backed')),
    -- The frozen hypothesis flag: TRUE exactly for the two hypothesis
    -- kinds — hypotheses never become facts (no promotion path exists;
    -- the rows are append-only).
    hypothesis                boolean NOT NULL,
    -- SERVER-DERIVED provenance (never a request field).
    actor                     text   NOT NULL
                              CHECK (length(actor) >= 1 AND length(actor) <= 100),
    recorded_via              text   NOT NULL
                              CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 100),
    correlation_id            text   NOT NULL,
    causation_id              text,
    recorded_at               timestamptz NOT NULL,
    -- THE VERIFICATION-STATE FENCE (AC-3c): 'unverified' exactly when NO
    -- backing reference exists; 'evidence_backed' exactly when at least
    -- ONE does. The state can never be asserted independently of the
    -- backing — a derived record without evidence references is marked
    -- unverified and can never be presented as established.
    CONSTRAINT product_derived_model_verification_shape CHECK (
        (verification_state = 'unverified'
           AND jsonb_array_length(source_fact_ids) = 0
           AND jsonb_array_length(evidence_citations) = 0)
        OR (verification_state = 'evidence_backed'
           AND (jsonb_array_length(source_fact_ids) > 0
                OR jsonb_array_length(evidence_citations) > 0))
    ),
    -- THE HYPOTHESIS-KIND FENCE: the hypothesis flag is FROZEN to the
    -- derivation kind — user/problem and ICP/audience records are born
    -- hypotheses and no path can change that.
    CONSTRAINT product_derived_model_hypothesis_shape CHECK (
        (hypothesis AND derivation_kind IN ('user_problem_hypothesis', 'icp_audience_hypothesis'))
        OR (NOT hypothesis AND derivation_kind NOT IN ('user_problem_hypothesis', 'icp_audience_hypothesis'))
    ),
    -- THE AI-ASSISTANCE PAIR FENCE: the disclosure is all-or-nothing.
    CONSTRAINT product_derived_model_ai_shape CHECK (
        (ai_model_identity IS NULL) = (ai_call_reference IS NULL)
    ),
    -- REPETITION NEVER PROMOTES (AC-3): an identical (context, kind,
    -- statement) derivation is rejected — recording the same claim again
    -- is not new evidence and never changes any state.
    CONSTRAINT product_derived_model_statement_unique
        UNIQUE (product_context_id, derivation_kind, statement)
);

-- The model scan surface.
CREATE INDEX IF NOT EXISTS product_derived_models_context_idx
    ON product_derived_models (product_context_id, recorded_at, derived_model_id);

-- THE SAME-CONTEXT SOURCE-FACT FENCE (the decisions same-client
-- precedent): every cited source fact must exist and belong to the SAME
-- product context — cross-context fact linkage is rejected.
CREATE OR REPLACE FUNCTION product_derived_model_facts_same_context() RETURNS trigger AS $$
DECLARE
    v_ref text;
    v_fact_context uuid;
BEGIN
    FOR v_ref IN SELECT jsonb_array_elements_text(NEW.source_fact_ids) LOOP
        IF v_ref !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            RAISE EXCEPTION 'derived model % cites a malformed source-fact reference %',
                NEW.derived_model_id, v_ref;
        END IF;
        SELECT product_context_id INTO v_fact_context
            FROM product_source_facts WHERE source_fact_id = v_ref::uuid;
        IF v_fact_context IS NULL THEN
            RAISE EXCEPTION 'derived model % cites unknown source fact %',
                NEW.derived_model_id, v_ref;
        END IF;
        IF v_fact_context <> NEW.product_context_id THEN
            RAISE EXCEPTION 'derived model % cites source fact % of another product context — cross-context fact linkage is rejected',
                NEW.derived_model_id, v_ref;
        END IF;
    END LOOP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_derived_model_facts_same_context_trigger ON product_derived_models;
CREATE TRIGGER product_derived_model_facts_same_context_trigger
    BEFORE INSERT ON product_derived_models
    FOR EACH ROW EXECUTE FUNCTION product_derived_model_facts_same_context();

-- THE SAME-AGENCY EVIDENCE FENCE (the decisions evidence-citation
-- precedent): every canonical /evidence citation must exist and its
-- owning Client must belong to the context's Agency — the /evidence
-- ledger is read CHECK-ONLY from here.
CREATE OR REPLACE FUNCTION product_derived_model_evidence_same_agency() RETURNS trigger AS $$
DECLARE
    v_ref text;
    v_ref_client uuid;
    v_ref_agency uuid;
    v_context_agency uuid;
BEGIN
    SELECT agency_id INTO v_context_agency
        FROM product_contexts WHERE product_context_id = NEW.product_context_id;
    FOR v_ref IN SELECT jsonb_array_elements_text(NEW.evidence_citations) LOOP
        IF v_ref !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            RAISE EXCEPTION 'derived model % cites a malformed evidence reference %',
                NEW.derived_model_id, v_ref;
        END IF;
        SELECT client_id INTO v_ref_client FROM evidence WHERE evidence_id = v_ref::uuid;
        IF v_ref_client IS NULL THEN
            RAISE EXCEPTION 'derived model % cites unknown evidence %',
                NEW.derived_model_id, v_ref;
        END IF;
        SELECT agency_id INTO v_ref_agency FROM clients WHERE client_id = v_ref_client;
        IF v_ref_agency IS DISTINCT FROM v_context_agency THEN
            RAISE EXCEPTION 'derived model % cites evidence % of another agency — cross-agency evidence linkage is rejected',
                NEW.derived_model_id, v_ref;
        END IF;
    END LOOP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_derived_model_evidence_same_agency_trigger ON product_derived_models;
CREATE TRIGGER product_derived_model_evidence_same_agency_trigger
    BEFORE INSERT ON product_derived_models
    FOR EACH ROW EXECUTE FUNCTION product_derived_model_evidence_same_agency();

-- APPEND-ONLY DERIVED MODEL RECORDS: the database itself rejects UPDATE
-- and DELETE — derived claims are immutable once recorded (a revised claim
-- is a NEW record; the repetition fence above keeps it distinct).
CREATE OR REPLACE FUNCTION product_derived_models_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'product derived models are append-only: % is rejected on record %',
        TG_OP, OLD.derived_model_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_derived_models_append_only_update_trigger ON product_derived_models;
CREATE TRIGGER product_derived_models_append_only_update_trigger
    BEFORE UPDATE ON product_derived_models
    FOR EACH ROW EXECUTE FUNCTION product_derived_models_append_only();

DROP TRIGGER IF EXISTS product_derived_models_append_only_delete_trigger ON product_derived_models;
CREATE TRIGGER product_derived_models_append_only_delete_trigger
    BEFORE DELETE ON product_derived_models
    FOR EACH ROW EXECUTE FUNCTION product_derived_models_append_only();

-- ---------------------------------------------------------------------------
-- product_risk_flags — the append-only risk-flag records (AC-4)
-- ---------------------------------------------------------------------------

-- Explicit risk records: the frozen risk-kind vocabulary
-- (compliance/privacy/toxicity/commercial/operational), the severity
-- vocabulary, the statement, the same evidence-backing discipline
-- (source-fact references + canonical /evidence citations) and the
-- ai-runtime assistance disclosure. Append-only.
CREATE TABLE IF NOT EXISTS product_risk_flags (
    risk_flag_id              uuid   PRIMARY KEY,
    product_context_id        uuid   NOT NULL REFERENCES product_contexts(product_context_id),
    product_context_version_id uuid  NOT NULL REFERENCES product_context_versions(product_context_version_id),
    -- The frozen risk-kind vocabulary (AC-4, CHECK-fenced).
    risk_kind                 text   NOT NULL
                              CHECK (risk_kind IN ('compliance', 'privacy', 'toxicity',
                                                   'commercial', 'operational')),
    -- The frozen severity vocabulary (the ai-runtime risk-class
    -- precedent).
    severity                  text   NOT NULL
                              CHECK (severity IN ('low', 'medium', 'high')),
    -- The risk statement (bounded).
    statement                 text   NOT NULL
                              CHECK (length(statement) >= 1 AND length(statement) <= 2000),
    source_fact_ids           jsonb  NOT NULL DEFAULT '[]'::jsonb
                              CHECK (jsonb_typeof(source_fact_ids) = 'array'),
    evidence_citations        jsonb  NOT NULL DEFAULT '[]'::jsonb
                              CHECK (jsonb_typeof(evidence_citations) = 'array'),
    ai_model_identity         text   CHECK (ai_model_identity IS NULL OR (length(ai_model_identity) >= 1 AND length(ai_model_identity) <= 200)),
    ai_call_reference         text   CHECK (ai_call_reference IS NULL OR (length(ai_call_reference) >= 1 AND length(ai_call_reference) <= 100)),
    -- SERVER-DERIVED provenance (never a request field).
    actor                     text   NOT NULL
                              CHECK (length(actor) >= 1 AND length(actor) <= 100),
    recorded_via              text   NOT NULL
                              CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 100),
    correlation_id            text   NOT NULL,
    causation_id              text,
    recorded_at               timestamptz NOT NULL,
    -- The ai-assistance disclosure is all-or-nothing.
    CONSTRAINT product_risk_flag_ai_shape CHECK (
        (ai_model_identity IS NULL) = (ai_call_reference IS NULL)
    ),
    -- The repetition fence (the derived-record discipline): an identical
    -- (context, kind, statement) risk flag is rejected.
    CONSTRAINT product_risk_flag_statement_unique
        UNIQUE (product_context_id, risk_kind, statement)
);

-- The risk scan surface.
CREATE INDEX IF NOT EXISTS product_risk_flags_context_idx
    ON product_risk_flags (product_context_id, recorded_at, risk_flag_id);

-- THE SAME-CONTEXT SOURCE-FACT FENCE (identical discipline to the derived
-- records).
CREATE OR REPLACE FUNCTION product_risk_flag_facts_same_context() RETURNS trigger AS $$
DECLARE
    v_ref text;
    v_fact_context uuid;
BEGIN
    FOR v_ref IN SELECT jsonb_array_elements_text(NEW.source_fact_ids) LOOP
        IF v_ref !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            RAISE EXCEPTION 'risk flag % cites a malformed source-fact reference %',
                NEW.risk_flag_id, v_ref;
        END IF;
        SELECT product_context_id INTO v_fact_context
            FROM product_source_facts WHERE source_fact_id = v_ref::uuid;
        IF v_fact_context IS NULL THEN
            RAISE EXCEPTION 'risk flag % cites unknown source fact %',
                NEW.risk_flag_id, v_ref;
        END IF;
        IF v_fact_context <> NEW.product_context_id THEN
            RAISE EXCEPTION 'risk flag % cites source fact % of another product context — cross-context fact linkage is rejected',
                NEW.risk_flag_id, v_ref;
        END IF;
    END LOOP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_risk_flag_facts_same_context_trigger ON product_risk_flags;
CREATE TRIGGER product_risk_flag_facts_same_context_trigger
    BEFORE INSERT ON product_risk_flags
    FOR EACH ROW EXECUTE FUNCTION product_risk_flag_facts_same_context();

-- THE SAME-AGENCY EVIDENCE FENCE (identical discipline to the derived
-- records; the /evidence ledger is read CHECK-ONLY from here).
CREATE OR REPLACE FUNCTION product_risk_flag_evidence_same_agency() RETURNS trigger AS $$
DECLARE
    v_ref text;
    v_ref_client uuid;
    v_ref_agency uuid;
    v_context_agency uuid;
BEGIN
    SELECT agency_id INTO v_context_agency
        FROM product_contexts WHERE product_context_id = NEW.product_context_id;
    FOR v_ref IN SELECT jsonb_array_elements_text(NEW.evidence_citations) LOOP
        IF v_ref !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            RAISE EXCEPTION 'risk flag % cites a malformed evidence reference %',
                NEW.risk_flag_id, v_ref;
        END IF;
        SELECT client_id INTO v_ref_client FROM evidence WHERE evidence_id = v_ref::uuid;
        IF v_ref_client IS NULL THEN
            RAISE EXCEPTION 'risk flag % cites unknown evidence %',
                NEW.risk_flag_id, v_ref;
        END IF;
        SELECT agency_id INTO v_ref_agency FROM clients WHERE client_id = v_ref_client;
        IF v_ref_agency IS DISTINCT FROM v_context_agency THEN
            RAISE EXCEPTION 'risk flag % cites evidence % of another agency — cross-agency evidence linkage is rejected',
                NEW.risk_flag_id, v_ref;
        END IF;
    END LOOP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_risk_flag_evidence_same_agency_trigger ON product_risk_flags;
CREATE TRIGGER product_risk_flag_evidence_same_agency_trigger
    BEFORE INSERT ON product_risk_flags
    FOR EACH ROW EXECUTE FUNCTION product_risk_flag_evidence_same_agency();

-- APPEND-ONLY RISK FLAGS: the database itself rejects UPDATE and DELETE —
-- the risk register is never rewritten.
CREATE OR REPLACE FUNCTION product_risk_flags_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'product risk flags are append-only: % is rejected on flag %',
        TG_OP, OLD.risk_flag_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_risk_flags_append_only_update_trigger ON product_risk_flags;
CREATE TRIGGER product_risk_flags_append_only_update_trigger
    BEFORE UPDATE ON product_risk_flags
    FOR EACH ROW EXECUTE FUNCTION product_risk_flags_append_only();

DROP TRIGGER IF EXISTS product_risk_flags_append_only_delete_trigger ON product_risk_flags;
CREATE TRIGGER product_risk_flags_append_only_delete_trigger
    BEFORE DELETE ON product_risk_flags
    FOR EACH ROW EXECUTE FUNCTION product_risk_flags_append_only();
