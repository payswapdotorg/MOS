-- 048_product_intelligence.sql — MKT-069 (Product Intelligence).
--
-- The PRODUCT INTELLIGENCE authority (spec/architecture-v1.6.md §8 — the
-- primary contract; spec/effective-backlog-v1.6.md MKT-069: "inspect public
-- product/site information and explicitly authorized source code/workspaces
-- to build a product/market model"; spec/module-dependency-matrix-v1.6.md
-- boundary rule 7: "Product Intelligence has read-only source-code/product
-- inspection unless a separate write capability is explicitly granted"):
--
--   product_contexts              → the AGENCY-SCOPED product-context
--                                    records (the mission-optional Product
--                                    Context of architecture-v1.6.md §8 — a
--                                    Growth Mission MAY attach one by
--                                    reference; MKT-070 does the planning,
--                                    this module holds the durable
--                                    product/market model records only);
--   product_context_versions      → the APPEND-ONLY VERSION TAIL (one
--                                    immutable row per declared context —
--                                    the bounded name/summary + the declared
--                                    INPUTS ride the version records;
--                                    corrections are NEW version records,
--                                    never in-place rewrites);
--   product_context_inputs        → the per-version DECLARED INPUT rows:
--                                    public product/site URL(s),
--                                    product-document references,
--                                    source-code repository URL(s), connected
--                                    source-workspace references,
--                                    catalog/inventory references and
--                                    current-analytics references — each
--                                    carrying its AUTHORIZATION STATE
--                                    (public vs explicitly authorized) and
--                                    the canonical integration-connection
--                                    reference for the authorized kinds;
--   product_source_facts          → the APPEND-ONLY SOURCE-FACT records —
--                                    every material source fact retained
--                                    with FULL provenance (source
--                                    URL/reference, fetched-at, extractor
--                                    identity, content hash, extraction
--                                    notes). Facts are EXTRACTED
--                                    OBSERVATIONS, never conclusions
--                                    (architecture-v1.6.md §7);
--   product_derived_models        → the APPEND-ONLY derived model records —
--                                    the §8 derivation set (product
--                                    capabilities, user/problem hypotheses,
--                                    ICP/audience hypotheses, value
--                                    propositions, conversion paths,
--                                    content-worthy features, market
--                                    language, commercial metrics to
--                                    optimize), each carrying its evidence
--                                    references, its AI-assistance
--                                    disclosure and its VERIFICATION STATE;
--   product_derived_model_evidence→ the FK-anchored evidence links (a
--                                    derived record cites source facts of
--                                    the SAME product context — a dangling
--                                    reference cannot persist);
--   product_risk_flags            → the APPEND-ONLY explicit risk records
--                                    (compliance/privacy/toxicity/
--                                    commercial/operational) with severity,
--                                    evidence links and provenance;
--   product_risk_flag_evidence    → the FK-anchored risk evidence links;
--   product_inspection_runs       → the deterministic inspection run
--                                    records (one row per executed
--                                    fetch/extract pass over the current
--                                    declared inputs);
--   product_inspection_input_runs → the per-input HONEST outcome rows (the
--                                    fetched/no-facts/refused/failed
--                                    vocabulary — every input's outcome is
--                                    recorded, never hidden).
--
-- Frozen semantics encoded here (FROZEN — never a caller freedom):
--
-- * THE §8 INPUT VOCABULARY (architecture-v1.6.md §8 "Inputs may include",
--   mapped one-to-one onto the MKT-069 declared-input set): product_site_url,
--   product_document, source_repository, source_workspace, catalog_inventory,
--   current_analytics — CHECK-fenced with the kind-compatible AUTHORIZATION
--   fence: the two PUBLIC web kinds (product_site_url, product_document)
--   carry authorization 'public' and NO connection reference; the four
--   AUTHORIZED kinds (source_repository, source_workspace, catalog_inventory,
--   current_analytics) carry authorization 'authorized' AND a canonical
--   integration-connection reference (boundary rule 7: source-code/product
--   inspection is READ-ONLY and explicitly authorized — an authorized input
--   without a connection, or a web kind claiming authorization, cannot
--   persist).
-- * THE §8 DERIVATION VOCABULARY: product_capabilities,
--   user_problem_hypotheses, icp_audience_hypotheses, value_propositions,
--   conversion_paths, content_worthy_features, market_language,
--   commercial_metrics — CHECK-fenced (product risks are the separate
--   risk-flag records).
-- * THE VERIFICATION-STATE DISCIPLINE (architecture-v1.6.md §7: "Model
--   output is a claim unless backed by evidence"): 'unverified' |
--   'evidence_backed', CHECK-fenced, computed SERVER-SIDE from the record's
--   own evidence set and verified at COMMIT by the deferred constraint
--   trigger — an 'evidence_backed' record with NO evidence row and an
--   'unverified' record WITH evidence rows are both rejected, for every
--   mutation path including direct SQL. Hypotheses never become facts: the
--   derived records are always CLAIMS (the module composes the tier
--   disclosure on every read; no promotion path exists).
-- * THE RISK VOCABULARY: categories compliance/privacy/toxicity/commercial/
--   operational (the MKT-069 acceptance list) and severities low/medium/
--   high/critical — CHECK-fenced; risk records are append-only.
-- * THE READ-ONLY GUARANTEE (boundary rule 7): this migration creates NO
--   table, column or trigger capable of mutating an external source; the
--   inspection contract is fetch/read ONLY. A future write capability
--   requires a separately granted capability key — a SEAM DOCUMENTED IN THE
--   RUNBOOK, deliberately NOT BUILT here.
-- * THE APPEND-ONLY TAILS: version records, declared inputs, source facts,
--   derived models, derived-model evidence, risk flags, risk evidence,
--   inspection runs and per-input outcomes ALL reject UPDATE and DELETE
--   outright — not even server code can rewrite inspection or derivation
--   history. The product-context record guard keeps identity/scope/
--   provenance immutable, the CAS version advancing by exactly one and the
--   version pointer only ever ADVANCING (corrections are NEW version
--   records).
-- * THE EVIDENCE SCOPE FENCE: derived-model and risk-flag evidence links
--   FK-anchor source facts of the SAME product context (a foreign fact
--   identifier cannot persist as evidence — trigger + FK backstops).
-- * THE INTEGRATION SCOPE FENCE (the migration 046 pattern): an authorized
--   input's integration connection must belong to the product context's
--   agency — the migration-029 integration_connections table is read
--   CHECK-ONLY (never written here).
-- * THE §8 SINGLE-SUPERSESSION FENCE (the migration 015 /evidence pattern):
--   a derived model may supersede at most ONE prior record and be superseded
--   by at most ONE later record (partial unique) — verification-state
--   transitions are NEW records (the unverified → evidence_backed
--   correction), never in-place rewrites.
-- * NO AUTHORITY TRANSFER: this migration creates NO mission, workflow,
--   execution, playbook, experiment, evidence, learning, job, deployment,
--   research, integration, credential or tenant table, and NO
--   mission-strategy/planner state of any kind (MKT-070 is a later Work
--   Item; the model records are attachable BY REFERENCE through this
--   module's read surface only).
-- * NO SECRET MATERIAL ANYWHERE (CRED-001/§21): the only structured payload
--   columns are the bounded fact/derived/risk statement objects and the
--   kind-specific disclosure blocks — there is deliberately NO column
--   capable of holding secret material or any free-form caller payload
--   beyond the declared bounded content (the module applies the shared
--   /evidence §21 material-key guard at the boundary).
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, row-locked CAS mutations, append-oriented tails. No
-- owner/role/user columns beyond provenance: agency-scope authorization
-- stays exactly the /agencies membership + platform-role authorities
-- resolved at the route layer — no second tenant, permission or identity
-- authority.

-- ---------------------------------------------------------------------------
-- product_contexts — the agency-scoped product-context records
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS product_contexts (
    product_context_id  uuid        PRIMARY KEY,
    -- AGENCY-SCOPED (spec/effective-backlog-v1.6.md MKT-069: agency-scoped
    -- product-context records; architecture-v1.6.md §8: the mission-optional
    -- Product Context). The agency row is resolved at the ROUTE layer
    -- (the /app-metering precedent — /agencies is not a frozen allowance of
    -- this module's dependency row); the FK anchor keeps a dangling agency
    -- reference from persisting.
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

-- CONTEXT-RECORD MUTATION GUARD: identity/scope/provenance are immutable;
-- the CAS version advances by exactly one; the version pointer only ever
-- ADVANCES and must reference an EXISTING declared version of the same
-- product context (corrections are NEW version records — the pointer can
-- never regress and can never dangle).
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
            NEW.product_context_id;
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

-- Context records are never deleted (product/market history is append-only).
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
    product_context_version_id uuid     PRIMARY KEY,
    product_context_id   uuid        NOT NULL REFERENCES product_contexts(product_context_id),
    -- The version sequence within the context (gapless from 1, assigned
    -- under the context row lock).
    version_seq          integer     NOT NULL CHECK (version_seq >= 1),
    -- The bounded declared context description (the product's name and a
    -- bounded summary — declared content, never authoritative product
    -- truth; the AUTHORITATIVE observations are the source facts).
    name                 text        CHECK (name IS NULL
                                         OR (length(name) >= 1 AND length(name) <= 500)),
    summary              text        CHECK (summary IS NULL
                                         OR (length(summary) >= 1 AND length(summary) <= 2000)),
    -- SERVER-DERIVED provenance (never a request field).
    recorded_actor       text        NOT NULL
                         CHECK (length(recorded_actor) >= 1 AND length(recorded_actor) <= 100),
    recorded_via         text        NOT NULL
                         CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 100),
    correlation_id       text        NOT NULL,
    causation_id         text,
    created_at           timestamptz NOT NULL,
    CONSTRAINT product_context_versions_seq_unique UNIQUE (product_context_id, version_seq)
);

-- APPEND-ONLY VERSION TAIL (the migration 045 pattern): the database itself
-- rejects UPDATE and DELETE on the declared-context history — the declared
-- inputs are immutable per version; corrections are NEW records.
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
-- product_context_inputs — the per-version declared inputs
-- ---------------------------------------------------------------------------

-- The declared inputs (architecture-v1.6.md §8, mapped one-to-one onto the
-- MKT-069 declared-input set): each input carries its KIND, its bounded
-- REFERENCE (a URL for the web kinds; an opaque canonical reference for the
-- authorized kinds), its AUTHORIZATION STATE (public vs explicitly
-- authorized) and — for the authorized kinds — the CANONICAL
-- integration-connection reference through which the authorized READ flows
-- (boundary rule 7: read-only inspection; the connection, never this
-- module, owns the client chain and the credential).
CREATE TABLE IF NOT EXISTS product_context_inputs (
    input_id                     uuid     PRIMARY KEY,
    product_context_version_id   uuid     NOT NULL REFERENCES product_context_versions(product_context_version_id),
    kind                         text     NOT NULL
                                 CHECK (kind IN ('product_site_url', 'product_document',
                                                  'source_repository', 'source_workspace',
                                                  'catalog_inventory', 'current_analytics')),
    reference                    text     NOT NULL
                                 CHECK (length(reference) >= 1 AND length(reference) <= 2048),
    -- (authorization_state: 'authorization' is a reserved SQL keyword.)
    authorization_state          text     NOT NULL
                                 CHECK (authorization_state IN ('public', 'authorized')),
    -- The canonical integration-connection reference of the AUTHORIZED
    -- kinds (REQUIRED for them, FORBIDDEN for the public web kinds).
    integration_connection_id    uuid,
    -- Declaration order preserved (the caller's declared input order is
    -- part of the immutable version snapshot).
    position                     integer  NOT NULL CHECK (position >= 1),
    CONSTRAINT product_context_inputs_shape CHECK (
        (kind IN ('product_site_url', 'product_document')
           AND authorization_state = 'public'
           AND integration_connection_id IS NULL)
        OR (kind IN ('source_repository', 'source_workspace',
                     'catalog_inventory', 'current_analytics')
           AND authorization_state = 'authorized'
           AND integration_connection_id IS NOT NULL)
    ),
    CONSTRAINT product_context_inputs_unique
        UNIQUE (product_context_version_id, kind, reference)
);

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

-- THE INTEGRATION SCOPE FENCE (the migration 046 pattern): an authorized
-- input's integration connection must EXIST and belong to the product
-- context's agency — cross-agency connection references cannot persist. The
-- migration-029 integration_connections table is read CHECK-ONLY (never
-- written here).
CREATE OR REPLACE FUNCTION product_input_connection_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_context_agency uuid;
    v_conn record;
BEGIN
    IF NEW.integration_connection_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT v.agency_id INTO v_context_agency
      FROM product_contexts v
      JOIN product_context_versions ver
        ON ver.product_context_id = v.product_context_id
     WHERE ver.product_context_version_id = NEW.product_context_version_id;
    IF v_context_agency IS NULL THEN
        RAISE EXCEPTION 'product context input % references an unknown version %',
            NEW.input_id, NEW.product_context_version_id;
    END IF;
    SELECT connection_id, agency_id INTO v_conn
      FROM integration_connections WHERE connection_id = NEW.integration_connection_id;
    IF v_conn IS NULL THEN
        RAISE EXCEPTION 'product context input % references unknown integration connection % — a dangling authorized reference cannot persist',
            NEW.input_id, NEW.integration_connection_id;
    END IF;
    IF v_conn.agency_id <> v_context_agency THEN
        RAISE EXCEPTION 'product context input % integration connection % belongs to another agency — the agency boundary cannot be crossed',
            NEW.input_id, NEW.integration_connection_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_input_connection_scope_trigger ON product_context_inputs;
CREATE TRIGGER product_input_connection_scope_trigger
    BEFORE INSERT ON product_context_inputs
    FOR EACH ROW EXECUTE FUNCTION product_input_connection_scope_consistent();

-- ---------------------------------------------------------------------------
-- product_inspection_runs — the deterministic inspection run records
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS product_inspection_runs (
    inspection_run_id            uuid     PRIMARY KEY,
    product_context_id           uuid     NOT NULL REFERENCES product_contexts(product_context_id),
    -- The declared version that was inspected (facts cite the version's
    -- inputs; a later correction never rewrites a completed run).
    product_context_version_id   uuid     NOT NULL REFERENCES product_context_versions(product_context_version_id),
    -- The honest run status: completed (every input produced an outcome
    -- without error), partial (some inputs failed), failed (every input
    -- failed) — never invented success.
    status                       text     NOT NULL
                                 CHECK (status IN ('completed', 'partial', 'failed')),
    inputs_inspected             integer  NOT NULL CHECK (inputs_inspected >= 0),
    facts_retained               integer  NOT NULL CHECK (facts_retained >= 0),
    started_at                   timestamptz NOT NULL,
    finished_at                  timestamptz NOT NULL,
    -- SERVER-DERIVED provenance (never a request field).
    recorded_actor               text     NOT NULL
                                 CHECK (length(recorded_actor) >= 1 AND length(recorded_actor) <= 100),
    recorded_via                 text     NOT NULL
                                 CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 100),
    correlation_id               text     NOT NULL,
    causation_id                 text,
    created_at                   timestamptz NOT NULL
);

-- The context's run tail (oldest first).
CREATE INDEX IF NOT EXISTS product_inspection_runs_context_idx
    ON product_inspection_runs (product_context_id, created_at, inspection_run_id);

-- Inspection runs are append-only (the honest execution record).
CREATE OR REPLACE FUNCTION product_inspection_runs_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'product inspection runs are append-only: % is rejected',
        TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_inspection_runs_append_only_update_trigger ON product_inspection_runs;
CREATE TRIGGER product_inspection_runs_append_only_update_trigger
    BEFORE UPDATE ON product_inspection_runs
    FOR EACH ROW EXECUTE FUNCTION product_inspection_runs_append_only();

DROP TRIGGER IF EXISTS product_inspection_runs_append_only_delete_trigger ON product_inspection_runs;
CREATE TRIGGER product_inspection_runs_append_only_delete_trigger
    BEFORE DELETE ON product_inspection_runs
    FOR EACH ROW EXECUTE FUNCTION product_inspection_runs_append_only();

-- ---------------------------------------------------------------------------
-- product_inspection_input_runs — the per-input honest outcome rows
-- ---------------------------------------------------------------------------

-- Every inspected input's outcome is recorded honestly: facts extracted,
-- no facts extracted, unauthorized refused (boundary rule 7 — the read-only
-- authorization gate), fetch/transport errors, integration read errors and
-- policy-refused reads. NOTHING is silently dropped.
CREATE TABLE IF NOT EXISTS product_inspection_input_runs (
    inspection_input_run_id  uuid    PRIMARY KEY,
    inspection_run_id        uuid    NOT NULL REFERENCES product_inspection_runs(inspection_run_id),
    input_id                 uuid    NOT NULL REFERENCES product_context_inputs(input_id),
    outcome                  text    NOT NULL
                             CHECK (outcome IN ('facts_extracted', 'no_facts_extracted',
                                                 'unauthorized_refused', 'fetch_http_error',
                                                 'fetch_transport_error', 'read_error',
                                                 'read_refused')),
    detail                   text    CHECK (detail IS NULL
                                      OR (length(detail) >= 1 AND length(detail) <= 2000)),
    facts_extracted          integer NOT NULL CHECK (facts_extracted >= 0),
    created_at               timestamptz NOT NULL
);

-- The per-input outcome rows are append-only.
CREATE OR REPLACE FUNCTION product_inspection_input_runs_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'product inspection input outcomes are append-only: % is rejected',
        TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_inspection_input_runs_append_only_update_trigger ON product_inspection_input_runs;
CREATE TRIGGER product_inspection_input_runs_append_only_update_trigger
    BEFORE UPDATE ON product_inspection_input_runs
    FOR EACH ROW EXECUTE FUNCTION product_inspection_input_runs_append_only();

DROP TRIGGER IF EXISTS product_inspection_input_runs_append_only_delete_trigger ON product_inspection_input_runs;
CREATE TRIGGER product_inspection_input_runs_append_only_delete_trigger
    BEFORE DELETE ON product_inspection_input_runs
    FOR EACH ROW EXECUTE FUNCTION product_inspection_input_runs_append_only();

-- ---------------------------------------------------------------------------
-- product_source_facts — the append-only retained source facts
-- ---------------------------------------------------------------------------

-- Every material source fact retained with FULL provenance
-- (architecture-v1.6.md §7: "Every material source fact retains source
-- provenance."): the source URL/reference observed, the fetched-at time,
-- the EXTRACTOR IDENTITY (the frozen, versioned extractor label), the
-- CONTENT HASH of the material the fact was extracted from, the extraction
-- notes and the bounded extracted observation content. Facts are EXTRACTED
-- OBSERVATIONS, never conclusions — the fact kinds are the frozen
-- deterministic-extractor vocabulary.
CREATE TABLE IF NOT EXISTS product_source_facts (
    source_fact_id               uuid     PRIMARY KEY,
    product_context_id           uuid     NOT NULL REFERENCES product_contexts(product_context_id),
    product_context_version_id   uuid     NOT NULL REFERENCES product_context_versions(product_context_version_id),
    -- The declared input the fact was extracted FROM (FK-anchored — a
    -- dangling input reference cannot persist).
    input_id                     uuid     NOT NULL REFERENCES product_context_inputs(input_id),
    inspection_run_id            uuid     NOT NULL REFERENCES product_inspection_runs(inspection_run_id),
    -- The frozen deterministic fact-kind vocabulary.
    fact_kind                    text     NOT NULL
                                 CHECK (fact_kind IN ('page_title', 'meta_description',
                                                      'meta_keywords', 'og_title', 'og_description',
                                                      'canonical_url', 'page_language', 'heading',
                                                      'text_excerpt', 'source_record')),
    -- The source URL/reference the fact was observed at (VERBATIM).
    source_ref                   text     NOT NULL
                                 CHECK (length(source_ref) >= 1 AND length(source_ref) <= 2048),
    fetched_at                   timestamptz NOT NULL,
    -- The EXTRACTOR IDENTITY: the frozen, versioned extractor label
    -- ('html-extract-v1' for public page extraction; 'integration-read-v1'
    -- for authorized reads through the /integrations public contract).
    extractor                    text     NOT NULL
                                 CHECK (length(extractor) >= 1 AND length(extractor) <= 100),
    -- The CONTENT HASH: sha256 hex of the material the fact was extracted
    -- from (the fetched page body / the normalized provider record).
    content_hash                 text     NOT NULL
                                 CHECK (length(content_hash) = 64),
    -- The bounded extraction notes (the honest observation notes).
    extraction_notes             text     CHECK (extraction_notes IS NULL
                                          OR (length(extraction_notes) >= 1
                                              AND length(extraction_notes) <= 2000)),
    -- The bounded extracted observation content (a non-empty JSON object;
    -- §21-guarded at the module boundary — material-shaped keys never
    -- persist here).
    content                      jsonb    NOT NULL
                                 CHECK (jsonb_typeof(content) = 'object'),
    -- SERVER-DERIVED provenance (never a request field).
    recorded_actor               text     NOT NULL
                                 CHECK (length(recorded_actor) >= 1 AND length(recorded_actor) <= 100),
    recorded_via                 text     NOT NULL
                                 CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 100),
    correlation_id               text     NOT NULL,
    causation_id                 text,
    created_at                   timestamptz NOT NULL
);

-- The context's fact tail (oldest first) + the input/lookup surfaces.
CREATE INDEX IF NOT EXISTS product_source_facts_context_idx
    ON product_source_facts (product_context_id, created_at, source_fact_id);
CREATE INDEX IF NOT EXISTS product_source_facts_input_idx
    ON product_source_facts (input_id, created_at);

-- Source facts are append-only (the retained observation ledger).
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
-- product_derived_models — the append-only derived model records
-- ---------------------------------------------------------------------------

-- The §8 derivation set: product capabilities, user/problem hypotheses,
-- ICP/audience hypotheses, value propositions, conversion paths,
-- content-worthy features, market language, commercial metrics to optimize
-- (product risks are the separate risk-flag records). Every derived record
-- is a CLAIM (architecture-v1.6.md §7: "Model output is a claim unless
-- backed by evidence") — its verification state is computed SERVER-SIDE
-- from its own evidence set, and the AI-assistance disclosure is carried
-- verbatim when the record was derived with ai-runtime assistance.
CREATE TABLE IF NOT EXISTS product_derived_models (
    derived_model_id             uuid     PRIMARY KEY,
    product_context_id           uuid     NOT NULL REFERENCES product_contexts(product_context_id),
    derivation_kind              text     NOT NULL
                                 CHECK (derivation_kind IN ('product_capabilities',
                                                             'user_problem_hypotheses',
                                                             'icp_audience_hypotheses',
                                                             'value_propositions',
                                                             'conversion_paths',
                                                             'content_worthy_features',
                                                             'market_language',
                                                             'commercial_metrics')),
    -- The derived statement (a bounded non-empty JSON object with a
    -- required summary — the CLAIM itself; a hypothesis stays a
    -- hypothesis, never a fact).
    statement                    jsonb    NOT NULL
                                 CHECK (jsonb_typeof(statement) = 'object'
                                        AND statement ? 'summary'
                                        AND length(statement ->> 'summary') >= 1
                                        AND length(statement ->> 'summary') <= 2000),
    -- The verification state — computed SERVER-SIDE from the record's own
    -- evidence set (never caller-declared); the deferred constraint
    -- trigger below is the commit-time backstop.
    verification_state           text     NOT NULL
                                 CHECK (verification_state IN ('unverified', 'evidence_backed')),
    -- The single-supersession correction chain (the migration 015
    -- /evidence pattern): a correction is a NEW record citing the prior
    -- one; the prior is never rewritten. Verification-state transitions
    -- ride this chain (an unverified record is corrected by an
    -- evidence-backed one).
    supersedes_derived_model_id  uuid     REFERENCES product_derived_models(derived_model_id),
    -- The AI-ASSISTANCE DISCLOSURE (architecture-v1.6.md §7): when the
    -- record was derived with ai-runtime assistance, the model identity
    -- (registry id + the display label snapshotted at record time) and
    -- the model call reference are carried verbatim — all three or none.
    ai_model_registry_id         uuid,
    ai_model_display             text     CHECK (ai_model_display IS NULL
                                          OR (length(ai_model_display) >= 1
                                              AND length(ai_model_display) <= 300)),
    ai_call_reference            text     CHECK (ai_call_reference IS NULL
                                          OR (length(ai_call_reference) >= 1
                                              AND length(ai_call_reference) <= 500)),
    -- SERVER-DERIVED provenance (never a request field).
    recorded_actor               text     NOT NULL
                                 CHECK (length(recorded_actor) >= 1 AND length(recorded_actor) <= 100),
    recorded_via                 text     NOT NULL
                                 CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 100),
    correlation_id               text     NOT NULL,
    causation_id                 text,
    created_at                   timestamptz NOT NULL,
    CONSTRAINT product_derived_model_ai_shape CHECK (
        (ai_model_registry_id IS NULL AND ai_model_display IS NULL AND ai_call_reference IS NULL)
        OR (ai_model_registry_id IS NOT NULL AND ai_model_display IS NOT NULL
            AND ai_call_reference IS NOT NULL)
    )
);

-- The context's derived-model tail (oldest first).
CREATE INDEX IF NOT EXISTS product_derived_models_context_idx
    ON product_derived_models (product_context_id, created_at, derived_model_id);

-- THE SINGLE-SUPERSESSION FENCE (the migration 015 pattern): at most ONE
-- superseding record per prior record.
CREATE UNIQUE INDEX IF NOT EXISTS product_derived_model_supersession_fence
    ON product_derived_models (supersedes_derived_model_id)
    WHERE supersedes_derived_model_id IS NOT NULL;

-- Derived model records are append-only: corrections are NEW records.
CREATE OR REPLACE FUNCTION product_derived_models_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'product derived models are append-only: % is rejected on model %',
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

-- THE SUPERSESSION CONSISTENCY FENCE (the migration 025 deferred pattern):
-- a superseding record must reference a record of the SAME product context
-- and the SAME derivation kind (a correction never changes its subject),
-- verified at COMMIT — every mutation path, including direct SQL.
CREATE OR REPLACE FUNCTION product_derived_model_supersession_consistent() RETURNS trigger AS $$
DECLARE
    v_prior record;
BEGIN
    IF NEW.supersedes_derived_model_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT product_context_id, derivation_kind, supersedes_derived_model_id
      INTO v_prior
      FROM product_derived_models
     WHERE derived_model_id = NEW.supersedes_derived_model_id;
    IF v_prior IS NULL THEN
        RAISE EXCEPTION 'derived model % supersedes unknown record % — a dangling correction cannot persist',
            NEW.derived_model_id, NEW.supersedes_derived_model_id;
    END IF;
    IF v_prior.product_context_id <> NEW.product_context_id THEN
        RAISE EXCEPTION 'derived model % cannot supersede a record of another product context — the context boundary cannot be crossed',
            NEW.derived_model_id;
    END IF;
    IF v_prior.derivation_kind <> NEW.derivation_kind THEN
        RAISE EXCEPTION 'derived model % must supersede a record of the same derivation kind (a correction never changes its subject)',
            NEW.derived_model_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_derived_model_supersession_trigger ON product_derived_models;
CREATE CONSTRAINT TRIGGER product_derived_model_supersession_trigger
    AFTER INSERT ON product_derived_models
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION product_derived_model_supersession_consistent();

-- ---------------------------------------------------------------------------
-- product_derived_model_evidence — the FK-anchored evidence links
-- ---------------------------------------------------------------------------

-- The evidence references backing one derived record: FK-anchored source
-- facts of the SAME product context (the module resolves and validates each
-- reference BEFORE any row persists; the trigger + FK are the backstops).
CREATE TABLE IF NOT EXISTS product_derived_model_evidence (
    derived_model_id  uuid    NOT NULL REFERENCES product_derived_models(derived_model_id),
    source_fact_id    uuid    NOT NULL REFERENCES product_source_facts(source_fact_id),
    -- Citation order preserved.
    position          integer NOT NULL CHECK (position >= 1),
    CONSTRAINT product_derived_model_evidence_pk
        PRIMARY KEY (derived_model_id, source_fact_id)
);

-- Evidence links are append-only.
CREATE OR REPLACE FUNCTION product_derived_model_evidence_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'product derived model evidence links are append-only: % is rejected',
        TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_derived_model_evidence_append_only_update_trigger ON product_derived_model_evidence;
CREATE TRIGGER product_derived_model_evidence_append_only_update_trigger
    BEFORE UPDATE ON product_derived_model_evidence
    FOR EACH ROW EXECUTE FUNCTION product_derived_model_evidence_append_only();

DROP TRIGGER IF EXISTS product_derived_model_evidence_append_only_delete_trigger ON product_derived_model_evidence;
CREATE TRIGGER product_derived_model_evidence_append_only_delete_trigger
    BEFORE DELETE ON product_derived_model_evidence
    FOR EACH ROW EXECUTE FUNCTION product_derived_model_evidence_append_only();

-- THE VERIFICATION-STATE INVARIANT (architecture-v1.6.md §7: "Model output
-- is a claim unless backed by evidence" — made durable): verified at COMMIT
-- — an 'evidence_backed' derived record MUST carry at least one evidence
-- row and an 'unverified' record MUST carry none, for every mutation path
-- including direct SQL. The state is computed server-side from the record's
-- own evidence set; this deferred trigger is the backstop that makes the
-- invariant unfalsifiable.
CREATE OR REPLACE FUNCTION product_derived_model_verification_consistent() RETURNS trigger AS $$
DECLARE
    v_evidence_count integer;
BEGIN
    SELECT count(*) INTO v_evidence_count
      FROM product_derived_model_evidence
     WHERE derived_model_id = NEW.derived_model_id;
    IF NEW.verification_state = 'evidence_backed' AND v_evidence_count = 0 THEN
        RAISE EXCEPTION 'derived model % is evidence_backed but cites no source fact — a derived record without backing evidence can never be presented as established',
            NEW.derived_model_id;
    END IF;
    IF NEW.verification_state = 'unverified' AND v_evidence_count > 0 THEN
        RAISE EXCEPTION 'derived model % is unverified but cites % source fact(s) — the verification state must match the evidence set',
            NEW.derived_model_id, v_evidence_count;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_derived_model_verification_trigger ON product_derived_models;
CREATE CONSTRAINT TRIGGER product_derived_model_verification_trigger
    AFTER INSERT ON product_derived_models
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION product_derived_model_verification_consistent();

-- THE EVIDENCE SCOPE FENCE: an evidence link must reference a source fact
-- of the SAME product context as the derived record.
CREATE OR REPLACE FUNCTION product_derived_model_evidence_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_model_context uuid;
    v_fact_context uuid;
BEGIN
    SELECT product_context_id INTO v_model_context
      FROM product_derived_models WHERE derived_model_id = NEW.derived_model_id;
    SELECT product_context_id INTO v_fact_context
      FROM product_source_facts WHERE source_fact_id = NEW.source_fact_id;
    IF v_model_context IS NULL OR v_fact_context IS NULL OR v_model_context <> v_fact_context THEN
        RAISE EXCEPTION 'derived model evidence link %→% crosses a product context boundary — evidence references stay inside one context',
            NEW.derived_model_id, NEW.source_fact_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_derived_model_evidence_scope_trigger ON product_derived_model_evidence;
CREATE TRIGGER product_derived_model_evidence_scope_trigger
    BEFORE INSERT ON product_derived_model_evidence
    FOR EACH ROW EXECUTE FUNCTION product_derived_model_evidence_scope_consistent();

-- ---------------------------------------------------------------------------
-- product_risk_flags — the append-only explicit risk records
-- ---------------------------------------------------------------------------

-- Explicit risk records with provenance and severity: the MKT-069 frozen
-- risk categories (compliance, privacy, toxicity, commercial, operational)
-- and the severity vocabulary (low, medium, high, critical). Append-only —
-- the risk history is never rewritten.
CREATE TABLE IF NOT EXISTS product_risk_flags (
    risk_flag_id        uuid     PRIMARY KEY,
    product_context_id  uuid     NOT NULL REFERENCES product_contexts(product_context_id),
    category            text     NOT NULL
                        CHECK (category IN ('compliance', 'privacy', 'toxicity',
                                             'commercial', 'operational')),
    severity            text     NOT NULL
                        CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    -- The risk statement (a bounded non-empty JSON object with a required
    -- summary) + the optional bounded mitigation note.
    statement           jsonb    NOT NULL
                        CHECK (jsonb_typeof(statement) = 'object'
                               AND statement ? 'summary'
                               AND length(statement ->> 'summary') >= 1
                               AND length(statement ->> 'summary') <= 2000),
    mitigation          text     CHECK (mitigation IS NULL
                               OR (length(mitigation) >= 1 AND length(mitigation) <= 2000)),
    -- SERVER-DERIVED provenance (never a request field).
    recorded_actor      text     NOT NULL
                        CHECK (length(recorded_actor) >= 1 AND length(recorded_actor) <= 100),
    recorded_via        text     NOT NULL
                        CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 100),
    correlation_id      text     NOT NULL,
    causation_id        text,
    created_at          timestamptz NOT NULL
);

-- The context's risk tail (oldest first).
CREATE INDEX IF NOT EXISTS product_risk_flags_context_idx
    ON product_risk_flags (product_context_id, created_at, risk_flag_id);

-- Risk flags are append-only.
CREATE OR REPLACE FUNCTION product_risk_flags_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'product risk flags are append-only: % is rejected on risk %',
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

-- ---------------------------------------------------------------------------
-- product_risk_flag_evidence — the FK-anchored risk evidence links
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS product_risk_flag_evidence (
    risk_flag_id   uuid    NOT NULL REFERENCES product_risk_flags(risk_flag_id),
    source_fact_id uuid    NOT NULL REFERENCES product_source_facts(source_fact_id),
    position       integer NOT NULL CHECK (position >= 1),
    CONSTRAINT product_risk_flag_evidence_pk
        PRIMARY KEY (risk_flag_id, source_fact_id)
);

-- Risk evidence links are append-only.
CREATE OR REPLACE FUNCTION product_risk_flag_evidence_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'product risk flag evidence links are append-only: % is rejected',
        TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_risk_flag_evidence_append_only_update_trigger ON product_risk_flag_evidence;
CREATE TRIGGER product_risk_flag_evidence_append_only_update_trigger
    BEFORE UPDATE ON product_risk_flag_evidence
    FOR EACH ROW EXECUTE FUNCTION product_risk_flag_evidence_append_only();

DROP TRIGGER IF EXISTS product_risk_flag_evidence_append_only_delete_trigger ON product_risk_flag_evidence;
CREATE TRIGGER product_risk_flag_evidence_append_only_delete_trigger
    BEFORE DELETE ON product_risk_flag_evidence
    FOR EACH ROW EXECUTE FUNCTION product_risk_flag_evidence_append_only();

-- THE RISK EVIDENCE SCOPE FENCE: a risk evidence link must reference a
-- source fact of the SAME product context as the risk flag.
CREATE OR REPLACE FUNCTION product_risk_flag_evidence_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_risk_context uuid;
    v_fact_context uuid;
BEGIN
    SELECT product_context_id INTO v_risk_context
      FROM product_risk_flags WHERE risk_flag_id = NEW.risk_flag_id;
    SELECT product_context_id INTO v_fact_context
      FROM product_source_facts WHERE source_fact_id = NEW.source_fact_id;
    IF v_risk_context IS NULL OR v_fact_context IS NULL OR v_risk_context <> v_fact_context THEN
        RAISE EXCEPTION 'risk flag evidence link %→% crosses a product context boundary — evidence references stay inside one context',
            NEW.risk_flag_id, NEW.source_fact_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_risk_flag_evidence_scope_trigger ON product_risk_flag_evidence;
CREATE TRIGGER product_risk_flag_evidence_scope_trigger
    BEFORE INSERT ON product_risk_flag_evidence
    FOR EACH ROW EXECUTE FUNCTION product_risk_flag_evidence_scope_consistent();
