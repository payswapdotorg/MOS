-- 065_lab_features.sql — LAB-003 (Multimodal Content Feature Bundle).
--
-- THE FEATURE-BUNDLE AUTHORITY (spec/effective-backlog-v1.7.md LAB-003:
-- "Extract versioned text/audio/visual/metadata representations, with
-- optional ephemeral media access. Acceptance: reproducible feature
-- identity/versioning, source linkage, batch extraction, failure
-- states, tenant isolation."; dependencies satisfied: LAB-002 (merged
-- — the /lab-corpus reference-first corpus); spec/
-- architecture-v1.7-marketing-lab.md §4 "Reference-first content
-- universe" (the media-access chain "Reference → permitted media
-- access → decode/stream → feature extraction → feature bundle"; the
-- temporary-media-bytes rule "The system may retain temporary media
-- bytes only when the acquisition path and rights/policy permit it";
-- the public-URL-grants-NOTHING rule "The Lab MUST NOT assume that a
-- public URL grants permission to download, cache, transform or
-- redistribute media"; "Feature extraction should persist useful
-- derived representations so repeated simulation does not require
-- repeated media access") and §5 "Multimodal Content Feature Bundle"
-- ("The exact feature set is versioned. Feature extraction is
-- reproducible where practical and records encoder/model identity.");
-- §22 multi-tenancy; architecture-lock-v1.7 rules 5/6/7/8/29 (the
-- reference-first corpus rules applied to the feature layer; "All Lab
-- state and artifacts are tenant/workspace scoped"); AGENTS.md v1.7
-- "Multimodal feature bundles and Idea Graph abstractions are
-- versioned and source-linked."):
--
--   lab_feature_batch_runs   → the APPEND-ORIENTED batch extraction
--                              run records (born running, the single
--                              guarded completion advance; the summary
--                              counts are SQL-COMPUTED from the item
--                              outcome rows, never asserted
--                              separately — the CHECK fence pins
--                              extracted+failed+skipped = item_count);
--   lab_feature_bundles      → the CLIENT-SCOPED versioned
--                              FEATURE-BUNDLE records (one per
--                              extraction of one content reference
--                              under one feature-set version — the
--                              DETERMINISTIC identity digest + the
--                              append-only per-reference version
--                              chain; every bundle carries the FULL
--                              citation data of its source and the
--                              derived feature values with their
--                              encoder identity, NEVER media bytes);
--   lab_feature_batch_items  → the append-only per-item outcome tail
--                              (exactly ONE outcome per item from the
--                              closed vocabulary: extracted / failed
--                              with its closed failure reason /
--                              skipped with its closed skip reason).
--
-- Key fences:
--
-- * CHECK-fenced vocabularies on every enumerated column: the run
--   lifecycle (running/completed), the per-item outcome vocabulary
--   (extracted/failed/skipped), the CLOSED FAILURE VOCABULARY
--   (media_unavailable/rights_not_permitted/unsupported_modality/
--   extraction_error/encoder_unavailable/invalid_input/scope_mismatch),
--   the closed skip vocabulary (duplicate_citation_in_batch/
--   already_extracted), the closed media-availability echo vocabulary
--   (unknown/available_permitted/available_rights_unclear/
--   provider_unavailable/withdrawn — the /lab-corpus §4 closed set,
--   recorded as DATA), the closed media-grant posture vocabulary
--   (metadata_only/reference_gated), the closed media-fetch status
--   vocabulary (not_requested/pending/granted/refused), the closed
--   feature-value state vocabulary (derived/unavailable), the closed
--   modality grouping (text/audio/visual/metadata — the <@ subset
--   fence on required_modalities), the pinned contract version
--   ('lab-features-contract-v1') and the pinned feature-set version
--   ('lab-featureset-v1').
-- * REPRODUCIBLE FEATURE IDENTITY (the LAB-003 acceptance): the
--   identity_digest is a pure-function SHA-256 over the canonical
--   serialization of (the cited reference identity fields, the
--   feature-set version, the extractor identity+version, the input
--   digest) — UNIQUE (client_id, identity_digest) makes the
--   deterministic identity the idempotence fence (re-extracting the
--   same input under the same versions is the honest per-item
--   skipped/already_extracted outcome, never a second row); a changed
--   feature-set/extractor/input version is a NEW bundle_version row
--   on the SAME (client, reference) chain (UNIQUE (client_id,
--   reference_id, bundle_version)) — append-only version chain per
--   reference, never in-place rewrites.
-- * THE APPEND-ONLY DISCIPLINE: bundle identity is immutable after
--   insert and bundles are NEVER rewritten or deleted (UPDATE and
--   DELETE both rejected outright — a bundle version is an immutable
--   record of one extraction; corrections are NEW bundle versions);
--   item outcomes are APPEND-ONLY OUTRIGHT (UPDATE and DELETE
--   rejected); runs are born 'running' and advance to 'completed'
--   exactly once under the guarded UPDATE trigger (identity/scope/
--   echo columns immutable; only the status, the summary counts and
--   updated_at may advance), and runs are never deleted.
-- * NO EPHEMERAL-MEDIA PERSISTENCE (§4 structural, the LAB-002
--   no-binary rule applied to the feature layer): this migration
--   creates NO bytea/binary payload column and NO fetched-media
--   column ANYWHERE — media bytes, when a validated grant opens the
--   provider/rights-gated path, ride an in-memory handle through the
--   extraction call ONLY (the replaceable media-fetch port); the
--   durable bundle stores derived representations + identity +
--   linkage data ONLY (the media_fetch_status/bytes columns record
--   WHAT HAPPENED, never the bytes).
-- * THE OPAQUE CORPUS CITATION (the /lab and /lab-corpus
--   by-reference discipline): the source linkage columns (reference_id,
--   corpus_id, corpus_version, provider, provider_content_id,
--   canonical_url, metadata_digest, media_availability_at_extraction)
--   are RECORDED DATA — there is deliberately NO foreign key into
--   lab_corpus_references (or ANY /lab, /lab-corpus or v1.6 authority
--   table): the /lab-corpus reference's feature_bundle_version
--   advance ('pending' → the LAB-003 bundle version) is the LAB-002
--   module's OWN guarded seam, owned by the Tech Lead's LAB-004/005
--   integration — THIS module never writes any /lab-corpus table.
-- * NO AUTHORITY TRANSFER / NO SHADOWING (§3 — structural): this
--   migration creates NO experiment, decision, evidence, metric,
--   publication, workflow or execution table and NO foreign key into
--   any of them; the FK anchors are EXACTLY the tenant tables
--   (agencies, clients, workspaces) + the same-module rows
--   (bundle → creating run; item → run; item → bundle).
-- * NO SECRET MATERIAL ANYWHERE (CRED-001): the only structured
--   payload columns are the bounded citation snapshot echo, the
--   feature value map (derived representations + honest unavailable
--   states + encoder identity) and the bounded error detail — there
--   is deliberately NO column capable of holding secret, credential
--   or media-byte material.
--
-- Conventions (implementation-contract §3, §25): server-generated
-- opaque identifiers, append-oriented tails. No owner/role/user
-- columns: client-scope authorization stays exactly the
-- requireClientAccess route-layer authority — no second tenant,
-- permission or identity authority.

-- ---------------------------------------------------------------------------
-- lab_feature_batch_runs — the append-oriented batch extraction runs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_feature_batch_runs (
    run_id              uuid        PRIMARY KEY,
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id        uuid        REFERENCES workspaces(workspace_id),
    -- Born running; the single guarded advance to completed (the
    -- completion update SQL-computes the summary counts from the
    -- item outcome rows in the same transaction).
    status              text        NOT NULL
                        CHECK (status IN ('running', 'completed')),
    -- The bounded batch size (module-side fence: 1-100 items).
    item_count          integer     NOT NULL CHECK (item_count >= 1 AND item_count <= 100),
    -- The extractor echo (identity is part of the bundle identity —
    -- recorded here for the run's provenance).
    extractor_id        text        NOT NULL CHECK (char_length(extractor_id) >= 1 AND char_length(extractor_id) <= 64),
    extractor_version   text        NOT NULL CHECK (char_length(extractor_version) >= 1 AND char_length(extractor_version) <= 64),
    feature_set_version text        NOT NULL
                        CHECK (feature_set_version IN ('lab-featureset-v1')),
    -- The extraction configuration echo (the closed modality grouping
    -- — the <@ subset fence; an empty array = no modality required).
    required_modalities text[]      NOT NULL DEFAULT '{}'
                        CHECK (required_modalities <@ ARRAY['text','audio','visual','metadata']::text[]),
    -- The summary counts — SQL-COMPUTED from the item outcome rows at
    -- completion (never asserted separately; the STATUS-CONDITIONAL
    -- CHECK fence below pins the arithmetic: a run is born 'running'
    -- with all counts honestly zero — nothing is computed yet — and
    -- the single completion update computes them from the item
    -- outcome rows in the same transaction, so at 'completed' the
    -- sum is pinned to the batch size).
    extracted_count     integer     NOT NULL DEFAULT 0 CHECK (extracted_count >= 0),
    failed_count        integer     NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
    skipped_count       integer     NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'lab-features-contract-v1'),
    created_at          timestamptz NOT NULL,
    updated_at          timestamptz NOT NULL,
    CONSTRAINT lab_feature_batch_runs_counts_sum
        CHECK ( (status = 'running' AND extracted_count = 0 AND failed_count = 0 AND skipped_count = 0)
             OR (status = 'completed' AND extracted_count + failed_count + skipped_count = item_count) )
);

-- The client's batch run tail.
CREATE INDEX IF NOT EXISTS lab_feature_batch_runs_client_idx
    ON lab_feature_batch_runs (client_id, created_at, run_id);
-- The run status facet (the incomplete-run probe).
CREATE INDEX IF NOT EXISTS lab_feature_batch_runs_status_idx
    ON lab_feature_batch_runs (client_id, status);

-- Run identity is immutable after insert; ONLY the status, the three
-- summary counts and updated_at may advance (the single completion
-- transition — running → completed, no resurrection, no reopen).
CREATE OR REPLACE FUNCTION lab_feature_run_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.run_id <> OLD.run_id
       OR NEW.agency_id <> OLD.agency_id
       OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.item_count <> OLD.item_count
       OR NEW.extractor_id <> OLD.extractor_id
       OR NEW.extractor_version <> OLD.extractor_version
       OR NEW.feature_set_version <> OLD.feature_set_version
       OR NEW.required_modalities <> OLD.required_modalities
       OR NEW.contract_version <> OLD.contract_version
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'lab feature batch run % identity/scope/config is immutable — batch run history is append-only',
            OLD.run_id;
    END IF;
    IF NOT (
           (OLD.status = 'running' AND NEW.status = 'completed')
        OR (OLD.status = NEW.status)
    ) THEN
        RAISE EXCEPTION 'lab feature batch run transition % → % is not legal (running → completed; no reopen)',
            OLD.status, NEW.status;
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'lab feature batch run % updated_at may not go backwards',
            OLD.run_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_feature_run_guard_trigger ON lab_feature_batch_runs;
CREATE TRIGGER lab_feature_run_guard_trigger
    BEFORE UPDATE ON lab_feature_batch_runs
    FOR EACH ROW EXECUTE FUNCTION lab_feature_run_guard();

-- Batch runs are never deleted (the extraction history is append-only).
CREATE OR REPLACE FUNCTION lab_feature_runs_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab feature batch runs cannot be deleted — extraction history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_feature_runs_no_delete_trigger ON lab_feature_batch_runs;
CREATE TRIGGER lab_feature_runs_no_delete_trigger
    BEFORE DELETE ON lab_feature_batch_runs
    FOR EACH ROW EXECUTE FUNCTION lab_feature_runs_no_delete();

-- ---------------------------------------------------------------------------
-- lab_feature_bundles — the versioned FEATURE-BUNDLE records (one per
-- extraction of one content reference under one feature-set version)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_feature_bundles (
    bundle_id           uuid        PRIMARY KEY,
    -- THE APPEND-ONLY VERSION CHAIN: (client, reference) → versions
    -- 1..N; corrections/re-extractions under a NEW feature-set or
    -- extractor version are NEW bundle_version rows, never in-place
    -- rewrites.
    reference_id        uuid        NOT NULL,
    bundle_version      integer     NOT NULL CHECK (bundle_version >= 1 AND bundle_version <= 1000),
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id        uuid        REFERENCES workspaces(workspace_id),
    -- THE CREATING RUN (same-module FK — the provenance anchor).
    run_id              uuid        NOT NULL REFERENCES lab_feature_batch_runs(run_id),
    -- THE SOURCE LINKAGE (recorded citation data, NEVER a join — the
    -- /lab-corpus by-reference discipline: no FK into any /lab-corpus
    -- or v1.6 authority table; the corpus advance seam stays the
    -- LAB-002 module's own guarded column).
    corpus_id           uuid        NOT NULL,
    corpus_version      integer     NOT NULL CHECK (corpus_version >= 1),
    provider            text        NOT NULL CHECK (char_length(provider) >= 1 AND char_length(provider) <= 64),
    provider_content_id text        NOT NULL CHECK (char_length(provider_content_id) >= 1 AND char_length(provider_content_id) <= 256),
    canonical_url       text        NOT NULL CHECK (char_length(canonical_url) >= 1 AND char_length(canonical_url) <= 2048),
    -- The metadata digest of the observation snapshot the bundle was
    -- extracted from (the /lab-corpus §4 digest, recorded data).
    metadata_digest     text        NOT NULL CHECK (metadata_digest ~ '^[0-9a-f]{64}$'),
    -- The media-availability state observed at extraction time (the
    -- /lab-corpus closed vocabulary, recorded data).
    media_availability_at_extraction text NOT NULL
                        CHECK (media_availability_at_extraction IN ('unknown',
                                                                    'available_permitted',
                                                                    'available_rights_unclear',
                                                                    'provider_unavailable',
                                                                    'withdrawn')),
    -- The closed media-grant posture the extraction ran under (the
    -- §4 acquisition-posture echo; metadata_only = no media path was
    -- even requestable for this provider under the corpus policy).
    grant_posture       text        NOT NULL
                        CHECK (grant_posture IN ('metadata_only', 'reference_gated')),
    -- THE HONEST MEDIA-PATH RECORD (what happened at the replaceable
    -- fetch port — status + detail + the granted byte LENGTH only;
    -- NEVER the bytes: there is no binary column in this migration).
    media_fetch_status  text        NOT NULL
                        CHECK (media_fetch_status IN ('not_requested', 'pending', 'granted', 'refused')),
    media_fetch_detail  text        CHECK (media_fetch_detail IS NULL
                                       OR (char_length(media_fetch_detail) >= 1 AND char_length(media_fetch_detail) <= 512)),
    media_fetch_bytes   bigint      CHECK (media_fetch_bytes IS NULL OR media_fetch_bytes >= 0),
    -- THE VERSIONED FEATURE SET (§5): the pinned feature-set version
    -- and the extractor identity that produced every value.
    feature_set_version text        NOT NULL
                        CHECK (feature_set_version IN ('lab-featureset-v1')),
    extractor_id        text        NOT NULL CHECK (char_length(extractor_id) >= 1 AND char_length(extractor_id) <= 64),
    extractor_version   text        NOT NULL CHECK (char_length(extractor_version) >= 1 AND char_length(extractor_version) <= 64),
    -- REPRODUCIBLE FEATURE IDENTITY: the pure-function SHA-256 over
    -- (the cited reference identity fields, the feature-set version,
    -- the extractor identity+version, the input digest) — the
    -- deterministic idempotence key.
    identity_digest     text        NOT NULL CHECK (identity_digest ~ '^[0-9a-f]{64}$'),
    input_digest        text        NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
    -- The extraction configuration echo (the closed modality grouping).
    required_modalities text[]      NOT NULL DEFAULT '{}'
                        CHECK (required_modalities <@ ARRAY['text','audio','visual','metadata']::text[]),
    -- THE DERIVED REPRESENTATIONS (§5): the per-key feature value map
    -- — every value carries its state (derived/unavailable), the
    -- derived ones their encoder identity, the unavailable ones their
    -- closed reason; validated module-side against the CLOSED
    -- 27-key feature vocabulary, NEVER media bytes.
    features            jsonb       NOT NULL
                        CHECK (jsonb_typeof(features) = 'object'),
    derived_feature_count   integer NOT NULL CHECK (derived_feature_count >= 0),
    unavailable_feature_count integer NOT NULL CHECK (unavailable_feature_count >= 0),
    -- The closed feature-set size fence (the lab-featureset-v1 set
    -- has exactly 27 keys; every bundle accounts for every key).
    CONSTRAINT lab_feature_bundles_feature_accounting
        CHECK (derived_feature_count + unavailable_feature_count = 27),
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'lab-features-contract-v1'),
    created_at          timestamptz NOT NULL,
    updated_at          timestamptz NOT NULL,
    -- The per-reference append-only version chain.
    CONSTRAINT lab_feature_bundles_chain UNIQUE (client_id, reference_id, bundle_version),
    -- The deterministic identity idempotence fence (the same identity
    -- inputs are the same bundle, ever, per client).
    CONSTRAINT lab_feature_bundles_identity UNIQUE (client_id, identity_digest)
);

-- The client's bundle tail (the per-reference version chain read).
CREATE INDEX IF NOT EXISTS lab_feature_bundles_client_idx
    ON lab_feature_bundles (client_id, reference_id, bundle_version);
-- The corpus-advance-seam facet (the TL's LAB-004/005 integration
-- resolves the latest bundle per reference through this read shape).
CREATE INDEX IF NOT EXISTS lab_feature_bundles_reference_idx
    ON lab_feature_bundles (client_id, reference_id, created_at, bundle_id);

-- Bundles are APPEND-ONLY OUTRIGHT: no UPDATE, no DELETE (a bundle
-- version is an immutable record of one extraction under one
-- feature-set/extractor version; corrections are NEW versions).
CREATE OR REPLACE FUNCTION lab_feature_bundles_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab feature bundles are append-only (INSERT only — bundle % is immutable; corrections are NEW bundle versions)',
        NEW.bundle_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_feature_bundles_no_update_trigger ON lab_feature_bundles;
CREATE TRIGGER lab_feature_bundles_no_update_trigger
    BEFORE UPDATE ON lab_feature_bundles
    FOR EACH ROW EXECUTE FUNCTION lab_feature_bundles_append_only();

DROP TRIGGER IF EXISTS lab_feature_bundles_no_delete_trigger ON lab_feature_bundles;
CREATE TRIGGER lab_feature_bundles_no_delete_trigger
    BEFORE DELETE ON lab_feature_bundles
    FOR EACH ROW EXECUTE FUNCTION lab_feature_bundles_append_only();

-- Scope consistency: a bundle's client must match its creating run's
-- client (cross-tenant bundle injection is rejected at the DB — §22).
CREATE OR REPLACE FUNCTION lab_feature_bundle_scope_check() RETURNS trigger AS $$
DECLARE
    run_client uuid;
    run_workspace uuid;
BEGIN
    SELECT client_id, workspace_id INTO run_client, run_workspace
        FROM lab_feature_batch_runs
        WHERE run_id = NEW.run_id;
    IF run_client IS NULL THEN
        RAISE EXCEPTION 'lab feature bundle must bind an existing batch run (%)',
            NEW.run_id;
    END IF;
    IF run_client <> NEW.client_id THEN
        RAISE EXCEPTION 'lab feature bundle client must match its creating run client (cross-tenant extraction is rejected)';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_feature_bundle_scope_trigger ON lab_feature_bundles;
CREATE TRIGGER lab_feature_bundle_scope_trigger
    BEFORE INSERT ON lab_feature_bundles
    FOR EACH ROW EXECUTE FUNCTION lab_feature_bundle_scope_check();

-- ---------------------------------------------------------------------------
-- lab_feature_batch_items — the append-only per-item outcome tail
-- (exactly ONE outcome per item, from the closed vocabulary)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_feature_batch_items (
    item_id             uuid        PRIMARY KEY,
    run_id              uuid        NOT NULL REFERENCES lab_feature_batch_runs(run_id),
    -- The bundle this item produced (null for failed items and for
    -- skips that produced no bundle).
    bundle_id           uuid        REFERENCES lab_feature_bundles(bundle_id),
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    -- The citation echo (the honest error surface: WHICH content the
    -- outcome is about, recorded data). NULLABLE: an invalid_input
    -- item's citation may be malformed enough to carry no echo at
    -- all — the honest state is NULL, never a fabricated placeholder.
    reference_id        uuid,
    provider            text        CHECK (provider IS NULL
                                       OR (char_length(provider) >= 1 AND char_length(provider) <= 64)),
    provider_content_id text        CHECK (provider_content_id IS NULL
                                       OR (char_length(provider_content_id) >= 1 AND char_length(provider_content_id) <= 256)),
    -- The item position in the batch (deterministic ordering).
    seq                 integer     NOT NULL CHECK (seq >= 1),
    -- THE CLOSED OUTCOME VOCABULARY (exactly one per item).
    outcome             text        NOT NULL
                        CHECK (outcome IN ('extracted', 'failed', 'skipped')),
    -- THE CLOSED FAILURE VOCABULARY (non-null iff outcome = failed).
    failure_reason      text
                        CHECK (failure_reason IS NULL OR failure_reason IN ('media_unavailable',
                                                                            'rights_not_permitted',
                                                                            'unsupported_modality',
                                                                            'extraction_error',
                                                                            'encoder_unavailable',
                                                                            'invalid_input',
                                                                            'scope_mismatch')),
    -- THE CLOSED SKIP VOCABULARY (non-null iff outcome = skipped).
    skip_reason         text
                        CHECK (skip_reason IS NULL OR skip_reason IN ('duplicate_citation_in_batch',
                                                                      'already_extracted')),
    -- The honest per-item error surface (bounded detail).
    error_detail        text        CHECK (error_detail IS NULL
                                       OR (char_length(error_detail) >= 1 AND char_length(error_detail) <= 512)),
    -- The deterministic identity when computable (null when the item
    -- failed before identity derivation — invalid input / scope
    -- mismatch).
    identity_digest     text        CHECK (identity_digest IS NULL OR identity_digest ~ '^[0-9a-f]{64}$'),
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'lab-features-contract-v1'),
    created_at          timestamptz NOT NULL,
    -- The outcome/reason pairing fences: a failure carries exactly
    -- its closed reason; a skip carries exactly its closed reason;
    -- an extraction carries neither.
    CONSTRAINT lab_feature_items_failed_reason_fence
        CHECK ((outcome = 'failed') = (failure_reason IS NOT NULL)),
    CONSTRAINT lab_feature_items_skipped_reason_fence
        CHECK ((outcome = 'skipped') = (skip_reason IS NOT NULL)),
    -- The bundle pairing fence: only an extracted item (or a skip of
    -- an identity already extracted) may carry a bundle id.
    CONSTRAINT lab_feature_items_bundle_fence
        CHECK (bundle_id IS NULL OR outcome IN ('extracted', 'skipped')),
    -- One outcome per (run, position) — the deterministic item order.
    CONSTRAINT lab_feature_items_position UNIQUE (run_id, seq)
);

-- The run's outcome tail (seq order — the deterministic batch order).
CREATE INDEX IF NOT EXISTS lab_feature_items_run_idx
    ON lab_feature_batch_items (run_id, seq, item_id);
-- The client facet (the per-client outcome history probes).
CREATE INDEX IF NOT EXISTS lab_feature_items_client_idx
    ON lab_feature_batch_items (client_id, created_at);

-- Item outcomes are APPEND-ONLY OUTRIGHT: no UPDATE, no DELETE (the
-- per-item outcome history is evidence — an outcome is never
-- rewritten, exactly like the /lab-corpus observation tail).
CREATE OR REPLACE FUNCTION lab_feature_items_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab feature batch items are append-only (INSERT only — outcome history is never rewritten)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_feature_items_no_update_trigger ON lab_feature_batch_items;
CREATE TRIGGER lab_feature_items_no_update_trigger
    BEFORE UPDATE ON lab_feature_batch_items
    FOR EACH ROW EXECUTE FUNCTION lab_feature_items_append_only();

DROP TRIGGER IF EXISTS lab_feature_items_no_delete_trigger ON lab_feature_batch_items;
CREATE TRIGGER lab_feature_items_no_delete_trigger
    BEFORE DELETE ON lab_feature_batch_items
    FOR EACH ROW EXECUTE FUNCTION lab_feature_items_append_only();

-- Scope consistency: an item's client must match its run's client AND
-- (when present) its bundle's client (cross-tenant outcome injection
-- is rejected at the DB — §22).
CREATE OR REPLACE FUNCTION lab_feature_item_scope_check() RETURNS trigger AS $$
DECLARE
    run_client uuid;
    bundle_client uuid;
BEGIN
    SELECT client_id INTO run_client
        FROM lab_feature_batch_runs
        WHERE run_id = NEW.run_id;
    IF run_client IS NULL THEN
        RAISE EXCEPTION 'lab feature batch item must bind an existing batch run (%)',
            NEW.run_id;
    END IF;
    IF run_client <> NEW.client_id THEN
        RAISE EXCEPTION 'lab feature batch item client must match its run client (cross-tenant outcome injection is rejected)';
    END IF;
    IF NEW.bundle_id IS NOT NULL THEN
        SELECT client_id INTO bundle_client
            FROM lab_feature_bundles
            WHERE bundle_id = NEW.bundle_id;
        IF bundle_client IS NULL THEN
            RAISE EXCEPTION 'lab feature batch item must bind an existing bundle (%)',
                NEW.bundle_id;
        END IF;
        IF bundle_client <> NEW.client_id THEN
            RAISE EXCEPTION 'lab feature batch item client must match its bundle client (cross-tenant outcome injection is rejected)';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_feature_item_scope_trigger ON lab_feature_batch_items;
CREATE TRIGGER lab_feature_item_scope_trigger
    BEFORE INSERT ON lab_feature_batch_items
    FOR EACH ROW EXECUTE FUNCTION lab_feature_item_scope_check();
