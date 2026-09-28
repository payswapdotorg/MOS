-- 061_lab_corpus.sql — LAB-002 (Reference-First Niche Corpus).
--
-- THE CORPUS AUTHORITY (spec/effective-backlog-v1.7.md LAB-002:
-- "Build provider-neutral niche corpus ingestion using content
-- references and metadata snapshots. Acceptance: reference-first
-- storage, provider-specific acquisition policy, provenance,
-- deduplication, observation timestamps, coverage reporting, no
-- unauthorized media retention."; spec/architecture-v1.7-marketing-lab.md
-- §4 "Reference-first content universe" (the verbatim Content
-- Reference field set), §22 multi-tenancy; EXECUTION-PLAN.md §11
-- media/corpus policy (coverage, freshness, duplication,
-- accessibility, extraction success); frozen-manifest-v1.7.json
-- mediaPolicy: referenceFirst, permanentMediaRetentionRequired=false,
-- mediaAccessIsProviderAndRightsGated, publicUrlDoesNotGrantMediaRights;
-- architecture-lock-v1.7: Lab artifacts never shadow v1.6 authorities):
--
--   lab_corpus_versions                       → the CLIENT-SCOPED
--                                                versioned corpus
--                                                definitions (niche +
--                                                platform + the
--                                                provider-specific
--                                                acquisition policy
--                                                map + the lifecycle);
--   lab_corpus_references                     → the CLIENT-SCOPED
--                                                Content Reference
--                                                rows (the §4 verbatim
--                                                field set; the UNIQUE
--                                                (client, provider,
--                                                provider_content_id)
--                                                DEDUPLICATION FENCE);
--   lab_corpus_observations                   → the append-only
--                                                observation history
--                                                tail (observed_at +
--                                                provenance + digest +
--                                                the availability
--                                                state at sighting
--                                                time).
--
-- Key fences:
--
-- * CHECK-fenced vocabularies on every enumerated column: the corpus
--   lifecycle (draft/active/retired), the closed rights/acquisition
--   bases (public_reference/provider_api_terms/explicit_license/
--   creator_grant), the closed media-availability states (unknown/
--   available_permitted/available_rights_unclear/provider_unavailable/
--   withdrawn) and the pinned contract/policy versions.
-- * THE DEDUPLICATION FENCE: UNIQUE (client_id, provider,
--   provider_content_id) on lab_corpus_references — one reference per
--   provider content item per client, EVER; re-ingestion is an
--   appended observation on the existing row (the module performs the
--   paired observation-insert + availability-advance in one
--   transaction).
-- * THE LIFECYCLE DISCIPLINE: corpus identity columns are immutable
--   after insert (guarded UPDATE trigger — only the lifecycle status
--   and updated_at may advance; corrections are NEW version rows);
--   reference identity is immutable after insert EXCEPT the current
--   media_availability and the feature_bundle_version (the LAB-003
--   extraction seam) — both advance only under the guarded trigger;
--   observations are APPEND-ONLY OUTRIGHT (UPDATE and DELETE
--   rejected).
-- * THE SCOPE FENCES: every row FK-anchors the owning agency and
--   client (+ optional workspace INSIDE the client); references
--   FK-anchor the corpus version they were first recorded under and
--   the scope-consistency trigger rejects any reference whose client
--   does not match its corpus version's client; observations carry
--   the same fence against their reference.
-- * NO UNAUTHORIZED MEDIA RETENTION (§4 structural): this migration
--   creates NO bytea/binary payload column and NO fetched-media
--   column ANYWHERE — the durable corpus is references + metadata +
--   provenance + observation history ONLY; the provider/rights-gated
--   media path lives downstream in the provider adapters
--   (Reference → permitted media access → decode/stream → feature
--   extraction → feature bundle). A public URL is reference data and
--   grants NOTHING.
-- * NO AUTHORITY TRANSFER / NO SHADOWING (§3 — structural): this
--   migration creates NO experiment, decision, evidence, metric,
--   publication, workflow or execution table and NO foreign key into
--   any of them; the /lab scenario's corpus citation is an OPAQUE
--   version string in the /lab binding jsonb (never joined here).
-- * NO SECRET MATERIAL ANYWHERE (CRED-001): the only structured
--   payload columns are the bounded acquisition-policy map and the
--   bounded metadata snapshot — there is deliberately NO column
--   capable of holding secret or credential material.
--
-- Conventions (implementation-contract §3, §25): server-generated
-- opaque identifiers, append-oriented tails. No owner/role/user
-- columns: client-scope authorization stays exactly the
-- requireClientAccess route-layer authority — no second tenant,
-- permission or identity authority.

-- ---------------------------------------------------------------------------
-- lab_corpus_versions — the client-scoped versioned corpus definitions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_corpus_versions (
    -- THE VERSION CHAIN KEY: one row per (corpus, version) —
    -- corrections append NEW version rows under the SAME corpus_id.
    corpus_id           uuid        NOT NULL,
    corpus_version      integer     NOT NULL CHECK (corpus_version >= 1 AND corpus_version <= 1000),
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id        uuid        REFERENCES workspaces(workspace_id),
    status              text        NOT NULL
                        CHECK (status IN ('draft', 'active', 'retired')),
    -- The niche declaration (free-form, versioned with the corpus).
    niche               text        NOT NULL CHECK (char_length(niche) >= 1 AND char_length(niche) <= 512),
    -- The platform declaration (recorded as declared data).
    platform            text        NOT NULL CHECK (char_length(platform) >= 1 AND char_length(platform) <= 64),
    -- The provider-specific acquisition policy map (the pinned
    -- policy vocabulary — per-provider permitted rights bases + the
    -- media-access posture; validated module-side before insert).
    acquisition_policy  jsonb       NOT NULL
                        CHECK (jsonb_typeof(acquisition_policy) = 'object'),
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'lab-corpus-contract-v1'),
    created_at          timestamptz NOT NULL,
    updated_at          timestamptz NOT NULL,
    CONSTRAINT lab_corpus_versions_pk PRIMARY KEY (corpus_id, corpus_version)
);

-- The client's corpus tail (newest version last).
CREATE INDEX IF NOT EXISTS lab_corpus_versions_client_idx
    ON lab_corpus_versions (client_id, corpus_id, corpus_version, created_at);

-- Corpus identity is immutable after insert; only the lifecycle status
-- and the server-managed updated_at may advance (corrections are NEW
-- version rows — the append-only correction path; the LAB-001
-- scenario-guard pattern).
CREATE OR REPLACE FUNCTION lab_corpus_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.corpus_id <> OLD.corpus_id
       OR NEW.corpus_version <> OLD.corpus_version
       OR NEW.agency_id <> OLD.agency_id
       OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.niche <> OLD.niche
       OR NEW.platform <> OLD.platform
       OR NEW.acquisition_policy <> OLD.acquisition_policy
       OR NEW.contract_version <> OLD.contract_version
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'lab corpus % version % identity/scope/policy is immutable — corrections are NEW version rows',
            OLD.corpus_id, OLD.corpus_version;
    END IF;
    IF NOT (
           (OLD.status = 'draft' AND NEW.status IN ('active', 'retired'))
        OR (OLD.status = 'active' AND NEW.status = 'retired')
        OR (OLD.status = NEW.status)
    ) THEN
        RAISE EXCEPTION 'lab corpus transition % → % is not legal (draft → active → retired; no resurrection)',
            OLD.status, NEW.status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_corpus_guard_trigger ON lab_corpus_versions;
CREATE TRIGGER lab_corpus_guard_trigger
    BEFORE UPDATE ON lab_corpus_versions
    FOR EACH ROW EXECUTE FUNCTION lab_corpus_guard();

-- Corpus rows are never deleted (history is append-only).
CREATE OR REPLACE FUNCTION lab_corpus_versions_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab corpus versions cannot be deleted — corpus history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_corpus_versions_no_delete_trigger ON lab_corpus_versions;
CREATE TRIGGER lab_corpus_versions_no_delete_trigger
    BEFORE DELETE ON lab_corpus_versions
    FOR EACH ROW EXECUTE FUNCTION lab_corpus_versions_no_delete();

-- ---------------------------------------------------------------------------
-- lab_corpus_references — the client-scoped Content Reference rows
-- (the §4 verbatim field set + the DEDUPLICATION FENCE)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_corpus_references (
    reference_id        uuid        PRIMARY KEY,
    -- The reference binds EXACTLY the corpus version it was FIRST
    -- recorded under (the composite FK; a corrected corpus never
    -- re-aims an existing reference).
    corpus_id           uuid        NOT NULL,
    corpus_version      integer     NOT NULL CHECK (corpus_version >= 1),
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id        uuid        REFERENCES workspaces(workspace_id),
    provider            text        NOT NULL CHECK (char_length(provider) >= 1 AND char_length(provider) <= 64),
    provider_content_id text        NOT NULL CHECK (char_length(provider_content_id) >= 1 AND char_length(provider_content_id) <= 256),
    canonical_url       text        NOT NULL CHECK (char_length(canonical_url) >= 1 AND char_length(canonical_url) <= 2048),
    creator_ref         text        CHECK (creator_ref IS NULL
                                       OR (char_length(creator_ref) >= 1 AND char_length(creator_ref) <= 256)),
    publication_time    timestamptz,
    -- The FIRST observation time (the §4 observation timestamp of record).
    observation_time    timestamptz NOT NULL,
    -- The declared rights/acquisition basis (the closed vocabulary;
    -- the corpus policy map fences which bases are permitted per
    -- provider at ingestion — module-side gate; this column keeps the
    -- declared basis honest forever).
    rights_basis        text        NOT NULL
                        CHECK (rights_basis IN ('public_reference',
                                                'provider_api_terms',
                                                'explicit_license',
                                                'creator_grant')),
    -- The provenance pair (collection method/version — §4).
    collection_method   text        NOT NULL CHECK (char_length(collection_method) >= 1 AND char_length(collection_method) <= 64),
    collection_version  text        NOT NULL CHECK (char_length(collection_version) >= 1 AND char_length(collection_version) <= 64),
    -- The metadata snapshot (the durable observation — bounded
    -- module-side to 256 keys; NEVER media bytes: there is no binary
    -- column in this migration at all).
    metadata_snapshot   jsonb       NOT NULL
                        CHECK (jsonb_typeof(metadata_snapshot) = 'object'),
    -- The metadata digest (the deduplication/coverage measurement key).
    metadata_digest     text        NOT NULL CHECK (metadata_digest ~ '^[0-9a-f]{64}$'),
    -- The CURRENT media availability state (advances ONLY through
    -- appended observations under the guarded trigger below).
    media_availability  text        NOT NULL
                        CHECK (media_availability IN ('unknown',
                                                      'available_permitted',
                                                      'available_rights_unclear',
                                                      'provider_unavailable',
                                                      'withdrawn')),
    -- The feature bundle version ('pending' until LAB-003 extracts —
    -- the extraction-success dimension of coverage reporting).
    feature_bundle_version text     NOT NULL DEFAULT 'pending'
                        CHECK (char_length(feature_bundle_version) >= 1 AND char_length(feature_bundle_version) <= 128),
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'lab-corpus-contract-v1'),
    created_at          timestamptz NOT NULL,
    updated_at          timestamptz NOT NULL,
    CONSTRAINT lab_corpus_references_corpus_fk
        FOREIGN KEY (corpus_id, corpus_version)
        REFERENCES lab_corpus_versions(corpus_id, corpus_version),
    -- THE DEDUPLICATION FENCE: one reference per (client, provider,
    -- provider content item) — re-ingestion appends an observation on
    -- the existing row (never a second reference).
    CONSTRAINT lab_corpus_references_dedup UNIQUE (client_id, provider, provider_content_id)
);

-- The client's corpus reference tail.
CREATE INDEX IF NOT EXISTS lab_corpus_references_client_idx
    ON lab_corpus_references (client_id, corpus_id, created_at, reference_id);
-- The provider facet (ingestion dedup probes + coverage grouping).
CREATE INDEX IF NOT EXISTS lab_corpus_references_provider_idx
    ON lab_corpus_references (client_id, provider, provider_content_id);
-- The digest facet (cross-provider duplication measurement).
CREATE INDEX IF NOT EXISTS lab_corpus_references_digest_idx
    ON lab_corpus_references (client_id, metadata_digest);

-- Reference identity is immutable after insert; ONLY the current
-- media_availability, the feature_bundle_version (the LAB-003 seam)
-- and updated_at may advance — every advance is driven by an appended
-- observation row (the module pairs them in one transaction), so the
-- availability history is always reconstructible from the tail.
CREATE OR REPLACE FUNCTION lab_corpus_reference_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.reference_id <> OLD.reference_id
       OR NEW.corpus_id <> OLD.corpus_id
       OR NEW.corpus_version <> OLD.corpus_version
       OR NEW.agency_id <> OLD.agency_id
       OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.provider <> OLD.provider
       OR NEW.provider_content_id <> OLD.provider_content_id
       OR NEW.canonical_url <> OLD.canonical_url
       OR NEW.creator_ref IS DISTINCT FROM OLD.creator_ref
       OR NEW.publication_time IS DISTINCT FROM OLD.publication_time
       OR NEW.observation_time <> OLD.observation_time
       OR NEW.rights_basis <> OLD.rights_basis
       OR NEW.collection_method <> OLD.collection_method
       OR NEW.collection_version <> OLD.collection_version
       OR NEW.metadata_snapshot <> OLD.metadata_snapshot
       OR NEW.metadata_digest <> OLD.metadata_digest
       OR NEW.contract_version <> OLD.contract_version
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'lab corpus reference % identity/scope/provenance is immutable — re-observation appends to the observation tail',
            OLD.reference_id;
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'lab corpus reference % updated_at may not go backwards',
            OLD.reference_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_corpus_reference_guard_trigger ON lab_corpus_references;
CREATE TRIGGER lab_corpus_reference_guard_trigger
    BEFORE UPDATE ON lab_corpus_references
    FOR EACH ROW EXECUTE FUNCTION lab_corpus_reference_guard();

-- References are never deleted (the corpus universe is append-only).
CREATE OR REPLACE FUNCTION lab_corpus_references_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab corpus references cannot be deleted — reference history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_corpus_references_no_delete_trigger ON lab_corpus_references;
CREATE TRIGGER lab_corpus_references_no_delete_trigger
    BEFORE DELETE ON lab_corpus_references
    FOR EACH ROW EXECUTE FUNCTION lab_corpus_references_no_delete();

-- Scope consistency: a reference's client must match its corpus
-- version's client (cross-tenant corpus poisoning is rejected at the
-- DB — §22 "Cross-tenant content may not be silently incorporated
-- into a tenant's proprietary search space").
CREATE OR REPLACE FUNCTION lab_corpus_reference_scope_check() RETURNS trigger AS $$
DECLARE
    corpus_client uuid;
BEGIN
    SELECT client_id INTO corpus_client
        FROM lab_corpus_versions
        WHERE corpus_id = NEW.corpus_id AND corpus_version = NEW.corpus_version;
    IF corpus_client IS NULL THEN
        RAISE EXCEPTION 'lab corpus reference must bind an existing corpus version (%, %)',
            NEW.corpus_id, NEW.corpus_version;
    END IF;
    IF corpus_client <> NEW.client_id THEN
        RAISE EXCEPTION 'lab corpus reference client must match its corpus version client (cross-tenant ingestion is rejected)';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_corpus_reference_scope_trigger ON lab_corpus_references;
CREATE TRIGGER lab_corpus_reference_scope_trigger
    BEFORE INSERT ON lab_corpus_references
    FOR EACH ROW EXECUTE FUNCTION lab_corpus_reference_scope_check();

-- ---------------------------------------------------------------------------
-- lab_corpus_observations — the append-only observation history tail
-- (the §4 observation timestamps)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_corpus_observations (
    observation_id      uuid        PRIMARY KEY,
    reference_id        uuid        NOT NULL
                        REFERENCES lab_corpus_references(reference_id),
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    observed_at         timestamptz NOT NULL,
    collection_method   text        NOT NULL CHECK (char_length(collection_method) >= 1 AND char_length(collection_method) <= 64),
    collection_version  text        NOT NULL CHECK (char_length(collection_version) >= 1 AND char_length(collection_version) <= 64),
    metadata_digest     text        NOT NULL CHECK (metadata_digest ~ '^[0-9a-f]{64}$'),
    -- The availability state OBSERVED at this sighting (the current
    -- state on the reference row is the latest of these).
    media_availability  text        NOT NULL
                        CHECK (media_availability IN ('unknown',
                                                      'available_permitted',
                                                      'available_rights_unclear',
                                                      'provider_unavailable',
                                                      'withdrawn')),
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'lab-corpus-contract-v1'),
    created_at          timestamptz NOT NULL
);

-- The reference's observation tail (oldest first — the §4 observation
-- timestamp history).
CREATE INDEX IF NOT EXISTS lab_corpus_observations_reference_idx
    ON lab_corpus_observations (reference_id, observed_at, observation_id);
-- The corpus-wide freshness probes (coverage reporting joins through
-- the reference facet).
CREATE INDEX IF NOT EXISTS lab_corpus_observations_client_idx
    ON lab_corpus_observations (client_id, observed_at);

-- Observations are APPEND-ONLY OUTRIGHT: no UPDATE, no DELETE (the
-- observation history is evidence — the calibration "never rewrites
-- history" discipline applied to corpus sightings).
CREATE OR REPLACE FUNCTION lab_corpus_observations_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab corpus observations are append-only (INSERT only — observation history is never rewritten)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_corpus_observations_no_update_trigger ON lab_corpus_observations;
CREATE TRIGGER lab_corpus_observations_no_update_trigger
    BEFORE UPDATE ON lab_corpus_observations
    FOR EACH ROW EXECUTE FUNCTION lab_corpus_observations_append_only();

DROP TRIGGER IF EXISTS lab_corpus_observations_no_delete_trigger ON lab_corpus_observations;
CREATE TRIGGER lab_corpus_observations_no_delete_trigger
    BEFORE DELETE ON lab_corpus_observations
    FOR EACH ROW EXECUTE FUNCTION lab_corpus_observations_append_only();

-- Scope consistency: an observation's client must match its
-- reference's client (cross-tenant observation injection is rejected
-- at the DB).
CREATE OR REPLACE FUNCTION lab_corpus_observation_scope_check() RETURNS trigger AS $$
DECLARE
    reference_client uuid;
BEGIN
    SELECT client_id INTO reference_client
        FROM lab_corpus_references
        WHERE reference_id = NEW.reference_id;
    IF reference_client IS NULL THEN
        RAISE EXCEPTION 'lab corpus observation must bind an existing reference (%)',
            NEW.reference_id;
    END IF;
    IF reference_client <> NEW.client_id THEN
        RAISE EXCEPTION 'lab corpus observation client must match its reference client (cross-tenant observation is rejected)';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_corpus_observation_scope_trigger ON lab_corpus_observations;
CREATE TRIGGER lab_corpus_observation_scope_trigger
    BEFORE INSERT ON lab_corpus_observations
    FOR EACH ROW EXECUTE FUNCTION lab_corpus_observation_scope_check();
