-- 053_content_assets.sql — MKT-064 (Content Asset and Transformation
-- Authority).
--
-- The CONTENT ASSETS authority (spec/effective-backlog-v1.6.md MKT-064:
-- "versioned content assets plus first-party/extension transformation
-- execution contracts. Acceptance: crop/reframe/padding/compilation/clip/
-- caption/voice/translation/format transformations retain lineage and
-- quality observations"; spec/architecture-v1.6.md §10 "Transformation
-- system": "A Content Asset is an immutable versioned artifact with
-- lineage. Transformations are capabilities, not a hardcoded provider
-- list. First-party and extension implementations may provide ... Each
-- transformation declares expected effects and constraints. ... Content
-- added as padding or compilation material is itself subject to rights
-- and provenance gates"; spec/architecture-lock-v1.6.md rule 23: "Every
-- derived content artifact retains ingredient and transformation
-- lineage"; rule 24: "Transformation engines are replaceable first-party
-- capabilities or Extensions/Apps and must not become alternate MOS
-- authorities"; spec/module-dependency-matrix-v1.6.md boundary rule 5:
-- "Content Assets stores/derives artifact lineage but cannot become a
-- rights authority"; AGENTS.md: "Transformation engines must preserve
-- source/ingredient lineage and may be first-party capabilities or
-- Extensions/Apps"; "Content used for padding, compilations or composites
-- must carry its own rights/provenance").
--
--   content_assets                     → the CLIENT-SCOPED logical asset
--                                        identities the immutable
--                                        VERSION records hang off (the
--                                        version-sequence fence: one
--                                        monotonic per-asset version
--                                        column, explicit versions only
--                                        — no floating pointers).
--   content_asset_versions             → the IMMUTABLE VERSIONED
--                                        ARTIFACT RECORDS (the frozen
--                                        version discipline): each
--                                        version carries the OPAQUE
--                                        grammar-fenced content-asset
--                                        REFERENCE (the MKT-063 seam
--                                        target — 'ca:' + the canonical
--                                        version id, unique), the
--                                        media/kind metadata, the
--                                        CONTENT-ADDRESSED object-storage
--                                        reference (the MKT-001 ObjectStore
--                                        key — set for materialized and
--                                        derived versions, NULL for
--                                        drafts), the /evidence-anchored
--                                        SOURCE PROVENANCE (required for
--                                        source versions; a derived
--                                        version's provenance IS the
--                                        recorded transformation), and
--                                        the CHECK-fenced lifecycle state
--                                        (draft → materialized; derived
--                                        is the BIRTH state of
--                                        transformation outputs — outputs
--                                        are born WITH their objects and
--                                        their lineage, never mutated
--                                        into existence).
--   content_asset_lifecycle_events     → the fully APPEND-ONLY lifecycle
--                                        event tail (the MKT-063
--                                        discipline): one immutable row
--                                        per birth (registration /
--                                        derivation) or state move
--                                        (materialization), with the
--                                        CHECK-frozen event shapes.
--   content_asset_quality_observations → the APPEND-ONLY quality
--                                        OBSERVATION records: measurable
--                                        facts only (duration, dimensions,
--                                        bitrate, caption coverage,
--                                        language, frame rate, sample
--                                        rate, byte size — the frozen
--                                        transformation-family metric
--                                        vocabulary), never fabricated
--                                        scores (the closed metric
--                                        vocabulary cannot even express
--                                        one).
--   content_transformations            → the RECORDED TRANSFORMATION
--                                        records: the transformation KIND
--                                        (the frozen family — the MKT-064
--                                        acceptance list VERBATIM), the
--                                        per-kind parameters + the output
--                                        spec (bounded JSON objects), the
--                                        resolved ENGINE identity (the
--                                        engine registry is module DATA
--                                        wired at the composition root —
--                                        EMPTY in production by default,
--                                        the MKT-056 discipline), the
--                                        /executions reference (the
--                                        transformation EXECUTION flows
--                                        through the EXISTING execution
--                                        authority — no second engine
--                                        here), and the output version
--                                        link set ONCE at completion.
--   content_transformation_ingredients → the IMMUTABLE ingredient
--                                        lineage links: one row per
--                                        (transformation, input version),
--                                        the input version's ref FROZEN
--                                        at request time (explicit
--                                        versions — a request that does
--                                        not name an exact version is
--                                        rejected by the module guard
--                                        before any write), same-Client
--                                        trigger-fenced.
--
-- MKT-063 SEAM COMPLETION (the mutual registration): /content-rights
-- (migration 051) already speaks the grammar-fenced opaque asset refs
-- and declares the ContentAssetReferencePort typed seam; THIS migration
-- owns the OTHER side — the real version records those refs point at
-- ('ca:' + version id, resolvable per client). The module mints refs
-- from its own canonical ids and calls /content-rights
-- recordLineageLink when it derives assets (the composite/derived
-- conjunction seam) — through the PUBLIC contract only, never a rights
-- table write: NO rights table is created or mutated here (boundary
-- rule 5 — the 063 gate stays the sole rights authority; transforming
-- an asset NEVER mutates rights).
--
-- FAIL-CLOSED POSTURE THROUGHOUT:
--   * the tenant scope chain (agency → client → workspace) is
--     trigger-fenced on every insert/update of the scoped tables (the
--     migration 003/029/046/047/051 pattern);
--   * the /evidence SOURCE-PROVENANCE anchor is FK-anchored AND
--     same-Client trigger-fenced (the migration 023/051 pattern) —
--     cross-tenant evidence linkage is rejected by the database itself
--     (the module surfaces the uniform NotFoundError; /evidence is NOT
--     a frozen allowance of this row, so the anchor rides as the
--     id-based reference seam — the /app-metering route-layer precedent);
--   * every ingredient link's input version must belong to the SAME
--     Client as the transformation — cross-Client ingredients are
--     rejected by the database itself;
--   * the version rows are immutable except the ONE sanctioned
--     lifecycle state move (draft → materialized, which sets the object
--     reference and advances the CAS version) — DELETE is rejected
--     outright (a corrected asset is a NEW version, which is a NEW
--     reference — the MKT-063 re-registration discipline);
--   * the event/observation/ingredient tails are FULLY append-only
--     (UPDATE and DELETE rejected outright);
--   * the transformation rows admit exactly the completion/failure
--     state moves (requested → completed WITH the output version link;
--     requested → failed WITHOUT one) — never a rewrite of the kind,
--     the parameters, the frozen ingredients or the engine choice.
--
-- OWN TABLES ONLY: no rights, policy, evidence, tenant, execution,
-- workflow, job or integration table is created or mutated (the
-- /executions reference is a READ-ONLY FK anchor into the existing
-- execution authority — lifecycle stays owned there; the object store
-- is the platform port, referenced by content-addressed key only).
--
-- Migration numbering: 053 is PRE-ASSIGNED to MKT-064 (the main tail is
-- 051 — MKT-063). 052 is deliberately NOT created here: the sibling
-- MKT-054 WIP holds a 050 collision that the Tech Lead renumbers to 052
-- at its merge; taking 053 leaves the gap for that renumber — disclosed
-- (the Tech Lead reconciles numbering at merge, the MKT-063 precedent).

-- ---------------------------------------------------------------------------
-- content_assets — the logical asset identities
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS content_assets (
    asset_id              uuid        PRIMARY KEY,
    -- The tenant scope chain (SERVER-DERIVED from canonical ownership at
    -- the route/module boundary; immutable).
    agency_id             uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id             uuid        NOT NULL REFERENCES clients(client_id),
    -- The OPTIONAL Workspace narrowing (must belong to the client).
    workspace_id          uuid        REFERENCES workspaces(workspace_id),
    created_by_actor      text        NOT NULL
                          CHECK (length(created_by_actor) >= 1
                                 AND length(created_by_actor) <= 100),
    created_via           text        NOT NULL
                          CHECK (length(created_via) >= 1
                                 AND length(created_via) <= 100),
    correlation_id        text        NOT NULL,
    causation_id          text,
    created_at            timestamptz NOT NULL DEFAULT now()
);

-- Listing surfaces: the client's assets, the workspace slice and the
-- agency audit range.
CREATE INDEX IF NOT EXISTS content_assets_client_idx
    ON content_assets (client_id, created_at DESC, asset_id DESC);
CREATE INDEX IF NOT EXISTS content_assets_workspace_idx
    ON content_assets (workspace_id) WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS content_assets_agency_idx
    ON content_assets (agency_id, created_at DESC, asset_id DESC);

-- TENANT FENCE (the migration 003/029/046/047/051 pattern): the asset's
-- client must belong to its agency, and the optional workspace must
-- belong to the client — the scope chain cannot be crossed even by a
-- direct SQL writer.
CREATE OR REPLACE FUNCTION content_assets_scope_chain_consistent() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM clients c
        WHERE c.client_id = NEW.client_id AND c.agency_id = NEW.agency_id) THEN
        RAISE EXCEPTION 'content asset % client % does not belong to agency % — the tenant scope chain cannot be crossed',
            NEW.asset_id, NEW.client_id, NEW.agency_id;
    END IF;
    IF NEW.workspace_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workspaces w
        WHERE w.workspace_id = NEW.workspace_id AND w.client_id = NEW.client_id) THEN
        RAISE EXCEPTION 'content asset % workspace % does not belong to client % — the tenant scope chain cannot be crossed',
            NEW.asset_id, NEW.workspace_id, NEW.client_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_assets_scope_chain_trigger ON content_assets;
CREATE TRIGGER content_assets_scope_chain_trigger
    BEFORE INSERT OR UPDATE OF agency_id, client_id, workspace_id ON content_assets
    FOR EACH ROW EXECUTE FUNCTION content_assets_scope_chain_consistent();

-- No-DELETE: asset identities are append-oriented (versions are the
-- correction discipline — there is no erasure surface).
CREATE OR REPLACE FUNCTION content_assets_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'content asset % cannot be deleted — asset history is append-oriented (a correction is a NEW version, never erasure)',
        OLD.asset_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_assets_no_delete_trigger ON content_assets;
CREATE TRIGGER content_assets_no_delete_trigger
    BEFORE DELETE ON content_assets
    FOR EACH ROW EXECUTE FUNCTION content_assets_no_delete();

-- ---------------------------------------------------------------------------
-- content_asset_versions — the immutable versioned artifact records
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS content_asset_versions (
    version_id            uuid        PRIMARY KEY,
    -- The logical asset this version belongs to (FK + same-scope trigger
    -- fence below: a version's scope chain must equal its asset's).
    asset_id              uuid        NOT NULL REFERENCES content_assets(asset_id),
    -- The version's scope chain (denormalized from the asset for direct
    -- listing/fence surfaces; trigger-enforced to EQUAL the asset's).
    agency_id             uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id             uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id          uuid        REFERENCES workspaces(workspace_id),
    -- The explicit version number (monotonic per asset; one-based). The
    -- (asset, version) UNIQUE fence is the version discipline: callers
    -- name EXACT versions — no floating pointers, no 'latest'.
    version               bigint      NOT NULL CHECK (version >= 1),
    -- The OPAQUE CONTENT-ASSET REFERENCE — the MKT-063 seam target.
    -- Minted server-side from the canonical version id ('ca:' + uuid),
    -- grammar-fenced (path-safe, no scheme, no whitespace — the
    -- migration-051 ref grammar accepts it), GLOBALLY unique (the ref IS
    -- the version identity: a re-registered asset is a NEW version,
    -- which is a NEW reference).
    asset_ref             text        NOT NULL
                          CHECK (asset_ref ~ '^ca:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    -- The media/kind metadata (the frozen ca-vocab-v1 media vocabulary).
    media_kind            text        NOT NULL
                          CHECK (media_kind IN ('video', 'audio', 'image', 'text', 'document')),
    display_name          text        NOT NULL
                          CHECK (length(display_name) >= 1
                                 AND length(display_name) <= 200),
    content_type          text        NOT NULL
                          CHECK (length(content_type) >= 3
                                 AND length(content_type) <= 100),
    -- The lifecycle state (the frozen ca-vocab-v1 lifecycle vocabulary):
    -- born 'draft' (source registration — no object yet) or born
    -- 'derived' (transformation output — born WITH its object and its
    -- lineage); 'materialized' means an object EXISTS at the key. The
    -- ONLY sanctioned state move is draft → materialized (the
    -- disciplined state-move trigger below; a derived version is never
    -- mutated — an existing version can never BECOME a transformation
    -- output, outputs are NEW versions).
    lifecycle_state       text        NOT NULL DEFAULT 'draft'
                          CHECK (lifecycle_state IN ('draft', 'materialized', 'derived')),
    -- The CONTENT-ADDRESSED object-storage reference (the MKT-001
    -- ObjectStore key: a SHA-256 hex digest — content-addressed,
    -- immutable by construction). NULL exactly for drafts (the
    -- materialization shape CHECK below).
    object_key            text
                          CHECK (object_key IS NULL
                                 OR object_key ~ '^[a-f0-9]{64}$'),
    object_digest         text
                          CHECK (object_digest IS NULL
                                 OR object_digest ~ '^[a-f0-9]{64}$'),
    object_size           bigint      CHECK (object_size IS NULL OR object_size >= 0),
    -- SOURCE PROVENANCE: the /evidence record anchoring where the asset
    -- came from. REQUIRED for source versions (draft/materialized —
    -- human-created and imported content enters the pipeline with the
    -- same evidence-anchored provenance); a DERIVED version's provenance
    -- IS the recorded transformation (its ingredient links + execution
    -- trail — the shape CHECK below forbids the column there, so the
    -- derivation can never be quietly substituted by a claim).
    source_evidence_ref   uuid        REFERENCES evidence(evidence_id),
    created_by_actor      text        NOT NULL
                          CHECK (length(created_by_actor) >= 1
                                 AND length(created_by_actor) <= 100),
    created_via           text        NOT NULL
                          CHECK (length(created_via) >= 1
                                 AND length(created_via) <= 100),
    correlation_id        text        NOT NULL,
    causation_id          text,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    version_cas           bigint      NOT NULL DEFAULT 1 CHECK (version_cas >= 1),

    -- THE MATERIALIZATION SHAPE: an object reference exists exactly for
    -- materialized and derived versions; drafts carry none.
    CONSTRAINT content_asset_version_materialization_shape CHECK (
        (lifecycle_state = 'draft'
         AND object_key IS NULL AND object_digest IS NULL AND object_size IS NULL)
        OR (lifecycle_state IN ('materialized', 'derived')
            AND object_key IS NOT NULL AND object_digest IS NOT NULL AND object_size IS NOT NULL)
    ),
    -- THE PROVENANCE SHAPE: source versions REQUIRE the /evidence-anchored
    -- source provenance; derived versions carry NONE (the recorded
    -- transformation IS their provenance).
    CONSTRAINT content_asset_version_provenance_shape CHECK (
        (lifecycle_state IN ('draft', 'materialized') AND source_evidence_ref IS NOT NULL)
        OR (lifecycle_state = 'derived' AND source_evidence_ref IS NULL)
    )
);

-- The version discipline fences: one explicit version number per asset;
-- the ref is globally unique (it encodes the canonical version id).
CREATE UNIQUE INDEX IF NOT EXISTS content_asset_versions_asset_version_fence
    ON content_asset_versions (asset_id, version);
CREATE UNIQUE INDEX IF NOT EXISTS content_asset_versions_ref_fence
    ON content_asset_versions (asset_ref);

-- Listing surfaces: the client's versions, the versions of one asset,
-- the workspace slice and the agency audit range.
CREATE INDEX IF NOT EXISTS content_asset_versions_client_idx
    ON content_asset_versions (client_id, created_at DESC, version_id DESC);
CREATE INDEX IF NOT EXISTS content_asset_versions_asset_idx
    ON content_asset_versions (asset_id, version DESC);
CREATE INDEX IF NOT EXISTS content_asset_versions_workspace_idx
    ON content_asset_versions (workspace_id) WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS content_asset_versions_agency_idx
    ON content_asset_versions (agency_id, created_at DESC, version_id DESC);

-- The version scope chain equals the asset's (the denormalization
-- fence — a version can never carry a scope its asset does not).
CREATE OR REPLACE FUNCTION content_asset_versions_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_agency uuid;
    v_client uuid;
    v_workspace uuid;
BEGIN
    SELECT a.agency_id, a.client_id, a.workspace_id
      INTO v_agency, v_client, v_workspace
      FROM content_assets a WHERE a.asset_id = NEW.asset_id;
    IF v_client IS NULL THEN
        RAISE EXCEPTION 'content asset version % references unknown asset %',
            NEW.version_id, NEW.asset_id;
    END IF;
    IF NEW.agency_id <> v_agency OR NEW.client_id <> v_client
       OR NEW.workspace_id IS DISTINCT FROM v_workspace THEN
        RAISE EXCEPTION 'content asset version % scope chain must equal its asset''s scope chain (asset %)',
            NEW.version_id, NEW.asset_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_asset_versions_scope_trigger ON content_asset_versions;
CREATE TRIGGER content_asset_versions_scope_trigger
    BEFORE INSERT OR UPDATE OF asset_id, agency_id, client_id, workspace_id
    ON content_asset_versions
    FOR EACH ROW EXECUTE FUNCTION content_asset_versions_scope_consistent();

-- SAME-CLIENT SOURCE-PROVENANCE BACKSTOP (the migration 023/051 pattern):
-- every /evidence link of a version must belong to the SAME Client —
-- cross-tenant evidence linkage is rejected by the database itself.
CREATE OR REPLACE FUNCTION content_asset_versions_evidence_same_client() RETURNS trigger AS $$
DECLARE
    v_evidence_client uuid;
BEGIN
    IF NEW.source_evidence_ref IS NOT NULL THEN
        SELECT client_id INTO v_evidence_client FROM evidence
            WHERE evidence.evidence_id = NEW.source_evidence_ref;
        IF v_evidence_client IS NULL THEN
            RAISE EXCEPTION 'content asset version % references unknown source evidence %',
                NEW.version_id, NEW.source_evidence_ref;
        END IF;
        IF v_evidence_client <> NEW.client_id THEN
            RAISE EXCEPTION 'content asset version % source evidence % belongs to another client — cross-tenant evidence linkage is rejected',
                NEW.version_id, NEW.source_evidence_ref;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_asset_versions_evidence_same_client_trigger
    ON content_asset_versions;
CREATE TRIGGER content_asset_versions_evidence_same_client_trigger
    BEFORE INSERT OR UPDATE OF source_evidence_ref, client_id
    ON content_asset_versions
    FOR EACH ROW EXECUTE FUNCTION content_asset_versions_evidence_same_client();

-- RECORD DISCIPLINE (the migration 051 pattern): identity, scope, asset
-- binding, ref, media/kind metadata and creation provenance are
-- IMMUTABLE through ANY mutation path. The ONLY sanctioned UPDATE is
-- THE LIFECYCLE STATE MOVE: draft → materialized (setting the object
-- reference trio + advancing the CAS version in the SAME statement);
-- anything else about the row is frozen at birth. A derived version
-- admits NO mutation at all (it is born complete — an existing version
-- can never become a transformation output; outputs are NEW versions).
CREATE OR REPLACE FUNCTION content_asset_versions_disciplined() RETURNS trigger AS $$
BEGIN
    IF NEW.version_id <> OLD.version_id THEN
        RAISE EXCEPTION 'version_id % is immutable', OLD.version_id;
    END IF;
    IF NEW.asset_id <> OLD.asset_id OR NEW.version <> OLD.version
       OR NEW.asset_ref <> OLD.asset_ref THEN
        RAISE EXCEPTION 'content asset version % identity is immutable (a correction is a NEW version, which is a NEW reference)',
            OLD.version_id;
    END IF;
    IF NEW.agency_id <> OLD.agency_id OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
        RAISE EXCEPTION 'content asset version % tenant scope chain is immutable',
            OLD.version_id;
    END IF;
    IF NEW.media_kind <> OLD.media_kind
       OR NEW.display_name <> OLD.display_name
       OR NEW.content_type <> OLD.content_type THEN
        RAISE EXCEPTION 'content asset version % media/kind metadata is immutable (a correction is a NEW version)',
            OLD.version_id;
    END IF;
    IF NEW.source_evidence_ref IS DISTINCT FROM OLD.source_evidence_ref
       OR NEW.created_by_actor <> OLD.created_by_actor
       OR NEW.created_via <> OLD.created_via
       OR NEW.correlation_id <> OLD.correlation_id
       OR NEW.causation_id IS DISTINCT FROM OLD.causation_id
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'content asset version % provenance is immutable',
            OLD.version_id;
    END IF;

    -- THE STATE MOVE: draft → materialized ONLY.
    IF NEW.lifecycle_state <> OLD.lifecycle_state THEN
        IF NOT (OLD.lifecycle_state = 'draft' AND NEW.lifecycle_state = 'materialized') THEN
            RAISE EXCEPTION 'illegal content asset lifecycle move % -> % on version % (draft → materialized is the ONLY state move; derived is the BIRTH state of transformation outputs — an existing version can never become one)',
                OLD.lifecycle_state, NEW.lifecycle_state, OLD.version_id;
        END IF;
        IF NEW.version_cas <> OLD.version_cas + 1 THEN
            RAISE EXCEPTION 'the content asset lifecycle move must advance the CAS version (version %)',
                OLD.version_id;
        END IF;
        IF NEW.updated_at < OLD.updated_at THEN
            RAISE EXCEPTION 'the content asset lifecycle move cannot rewind updated_at (version %)',
                OLD.version_id;
        END IF;
    ELSE
        IF NEW.version_cas <> OLD.version_cas OR NEW.updated_at <> OLD.updated_at THEN
            RAISE EXCEPTION 'content asset version % admits no mutation without a lifecycle state move (the version record is immutable)',
                OLD.version_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_asset_versions_disciplined_trigger ON content_asset_versions;
CREATE TRIGGER content_asset_versions_disciplined_trigger
    BEFORE UPDATE ON content_asset_versions
    FOR EACH ROW EXECUTE FUNCTION content_asset_versions_disciplined();

-- No-DELETE: version history is append-oriented (corrections are NEW
-- versions — the migration-051 no-DELETE discipline).
CREATE OR REPLACE FUNCTION content_asset_versions_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'content asset version % cannot be deleted — version history is append-oriented (a correction is a NEW version, never erasure)',
        OLD.version_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_asset_versions_no_delete_trigger ON content_asset_versions;
CREATE TRIGGER content_asset_versions_no_delete_trigger
    BEFORE DELETE ON content_asset_versions
    FOR EACH ROW EXECUTE FUNCTION content_asset_versions_no_delete();

-- ---------------------------------------------------------------------------
-- content_asset_lifecycle_events — the append-only lifecycle tail
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS content_asset_lifecycle_events (
    event_id              uuid        PRIMARY KEY,
    version_id            uuid        NOT NULL REFERENCES content_asset_versions(version_id),
    -- The event kind (the frozen ca-vocab-v1 lifecycle-event vocabulary):
    -- 'registration'   — a source version was registered (born draft);
    -- 'derivation'     — a version was born as a transformation output;
    -- 'materialization' — the draft → materialized state move.
    event_kind            text        NOT NULL
                          CHECK (event_kind IN ('registration', 'materialization', 'derivation')),
    -- NULL for birth events (there is no from-state); 'draft' for the
    -- materialization move.
    from_state            text
                          CHECK (from_state IS NULL
                                 OR from_state IN ('draft', 'materialized', 'derived')),
    to_state              text        NOT NULL
                          CHECK (to_state IN ('draft', 'materialized', 'derived')),
    -- The REQUIRED bounded reason the event was recorded.
    reason                text        NOT NULL
                          CHECK (length(reason) >= 1 AND length(reason) <= 2000),
    recorded_by_actor     text        NOT NULL
                          CHECK (length(recorded_by_actor) >= 1
                                 AND length(recorded_by_actor) <= 100),
    recorded_via          text        NOT NULL
                          CHECK (length(recorded_via) >= 1
                                 AND length(recorded_via) <= 100),
    correlation_id        text        NOT NULL,
    causation_id          text,
    recorded_at           timestamptz NOT NULL DEFAULT now(),

    -- THE FROZEN EVENT SHAPES: a registration is a draft birth; a
    -- derivation is a derived birth; a materialization is the single
    -- draft → materialized move.
    CONSTRAINT content_asset_lifecycle_event_shape CHECK (
        (event_kind = 'registration' AND from_state IS NULL AND to_state = 'draft')
        OR (event_kind = 'derivation' AND from_state IS NULL AND to_state = 'derived')
        OR (event_kind = 'materialization' AND from_state = 'draft' AND to_state = 'materialized')
    )
);

CREATE INDEX IF NOT EXISTS content_asset_lifecycle_events_version_idx
    ON content_asset_lifecycle_events (version_id, recorded_at, event_id);

-- FULLY APPEND-ONLY: recorded lifecycle history is never rewritten.
CREATE OR REPLACE FUNCTION content_asset_lifecycle_events_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'content asset lifecycle event % is append-only (recorded history is immutable)',
        OLD.event_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_asset_lifecycle_events_append_only_trigger
    ON content_asset_lifecycle_events;
CREATE TRIGGER content_asset_lifecycle_events_append_only_trigger
    BEFORE UPDATE OR DELETE ON content_asset_lifecycle_events
    FOR EACH ROW EXECUTE FUNCTION content_asset_lifecycle_events_append_only();

-- ---------------------------------------------------------------------------
-- content_asset_quality_observations — the append-only measurable
-- quality facts (observations, never fabricated scores)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS content_asset_quality_observations (
    observation_id        uuid        PRIMARY KEY,
    version_id            uuid        NOT NULL REFERENCES content_asset_versions(version_id),
    -- The metric (the frozen ca-vocab-v1 quality-metric vocabulary — the
    -- transformation family's measurable vocabulary: duration,
    -- dimensions, bitrate, caption coverage, language, frame rate,
    -- sample rate, byte size). CLOSED: a 'score' cannot even be
    -- expressed — these are observed facts, never fabricated judgments.
    metric                text        NOT NULL
                          CHECK (metric IN ('duration_ms', 'width_px', 'height_px',
                                            'bitrate_kbps', 'caption_coverage_ratio',
                                            'language', 'fps', 'sample_rate_hz', 'byte_size')),
    metric_value_numeric  numeric,
    metric_value_text     text
                          CHECK (metric_value_text IS NULL
                                 OR (length(metric_value_text) >= 1
                                     AND length(metric_value_text) <= 64)),
    observed_at           timestamptz NOT NULL DEFAULT now(),
    recorded_by_actor     text        NOT NULL
                          CHECK (length(recorded_by_actor) >= 1
                                 AND length(recorded_by_actor) <= 100),
    recorded_via          text        NOT NULL
                          CHECK (length(recorded_via) >= 1
                                 AND length(recorded_via) <= 100),
    correlation_id        text        NOT NULL,
    causation_id          text,

    -- THE VALUE SHAPES: 'language' carries a bounded text tag; every
    -- other metric carries a non-negative number (the caption-coverage
    -- ratio is additionally bounded to [0, 1]).
    CONSTRAINT content_asset_quality_observation_shape CHECK (
        (metric = 'language' AND metric_value_numeric IS NULL
         AND metric_value_text IS NOT NULL)
        OR (metric <> 'language' AND metric_value_numeric IS NOT NULL
            AND metric_value_text IS NULL
            AND metric_value_numeric >= 0
            AND (metric <> 'caption_coverage_ratio' OR metric_value_numeric <= 1))
    )
);

CREATE INDEX IF NOT EXISTS content_asset_quality_observations_version_idx
    ON content_asset_quality_observations (version_id, observed_at, observation_id);

-- FULLY APPEND-ONLY: a recorded observation is an immutable measured
-- fact (a re-measurement is a NEW row — the observable tail).
CREATE OR REPLACE FUNCTION content_asset_quality_observations_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'content asset quality observation % is append-only (a recorded measurement is an immutable fact; a re-measurement is a NEW observation)',
        OLD.observation_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_asset_quality_observations_append_only_trigger
    ON content_asset_quality_observations;
CREATE TRIGGER content_asset_quality_observations_append_only_trigger
    BEFORE UPDATE OR DELETE ON content_asset_quality_observations
    FOR EACH ROW EXECUTE FUNCTION content_asset_quality_observations_append_only();

-- ---------------------------------------------------------------------------
-- content_transformations — the recorded transformation records
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS content_transformations (
    transformation_id     uuid        PRIMARY KEY,
    -- The tenant scope chain (SERVER-DERIVED; the workspace is REQUIRED
    -- here — the execution authority is workspace-scoped).
    agency_id             uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id             uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id          uuid        NOT NULL REFERENCES workspaces(workspace_id),
    -- The transformation KIND — the frozen family, the MKT-064 acceptance
    -- list VERBATIM.
    transformation_kind   text        NOT NULL
                          CHECK (transformation_kind IN ('crop', 'reframe', 'padding',
                                                         'compilation', 'clip', 'caption',
                                                         'voice', 'translation', 'format')),
    -- The resolved ENGINE identity (the engine registry is module DATA —
    -- the first-party/extension capability seam; frozen at request time
    -- so the recorded choice survives registry changes; the registry
    -- itself is EMPTY in production by default — the MKT-056 discipline).
    engine_id             text        NOT NULL
                          CHECK (length(engine_id) >= 1 AND length(engine_id) <= 100),
    -- The transformation status (the recorded lifecycle on THIS record;
    -- the RUNTIME lifecycle lives on the referenced execution).
    status                text        NOT NULL DEFAULT 'requested'
                          CHECK (status IN ('requested', 'completed', 'failed')),
    -- The EXECUTION reference — the transformation's work flows through
    -- the EXISTING /executions authority (created through its public
    -- contract; NO second execution engine lives here). UNIQUE: one
    -- transformation per execution.
    execution_ref         uuid        NOT NULL REFERENCES executions(execution_id),
    -- The per-kind parameters and the output spec (bounded JSON objects,
    -- guarded at the module surface).
    parameters            jsonb       NOT NULL
                          CHECK (jsonb_typeof(parameters) = 'object'),
    output_spec           jsonb       NOT NULL
                          CHECK (jsonb_typeof(output_spec) = 'object'),
    -- The OUTPUT version link — set ONCE at completion (the disciplined
    -- completion move below; NULL on requested and failed rows).
    output_version_id     uuid        REFERENCES content_asset_versions(version_id),
    completed_at          timestamptz,
    -- The bounded failure reason (present exactly on failed rows).
    failure_reason        text
                          CHECK (failure_reason IS NULL
                                 OR (length(failure_reason) >= 1
                                     AND length(failure_reason) <= 2000)),
    created_by_actor      text        NOT NULL
                          CHECK (length(created_by_actor) >= 1
                                 AND length(created_by_actor) <= 100),
    created_via           text        NOT NULL
                          CHECK (length(created_via) >= 1
                                 AND length(created_via) <= 100),
    correlation_id        text        NOT NULL,
    causation_id          text,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    version_cas           bigint      NOT NULL DEFAULT 1 CHECK (version_cas >= 1),

    -- THE STATUS SHAPES: completed rows carry the output link + the
    -- completion time and no failure reason; failed rows carry the
    -- failure reason, never an output link; requested rows carry
    -- neither.
    CONSTRAINT content_transformation_status_shape CHECK (
        (status = 'requested' AND output_version_id IS NULL
         AND completed_at IS NULL AND failure_reason IS NULL)
        OR (status = 'completed' AND output_version_id IS NOT NULL
            AND completed_at IS NOT NULL AND failure_reason IS NULL)
        OR (status = 'failed' AND output_version_id IS NULL
            AND completed_at IS NULL AND failure_reason IS NOT NULL)
    )
);

-- One transformation per execution (the 1:1 runtime-identity fence).
CREATE UNIQUE INDEX IF NOT EXISTS content_transformations_execution_fence
    ON content_transformations (execution_ref);

-- Listing surfaces: the client's transformations, the workspace slice
-- and the output-version reverse lookup.
CREATE INDEX IF NOT EXISTS content_transformations_client_idx
    ON content_transformations (client_id, created_at DESC, transformation_id DESC);
CREATE INDEX IF NOT EXISTS content_transformations_workspace_idx
    ON content_transformations (workspace_id, created_at DESC, transformation_id DESC);
CREATE INDEX IF NOT EXISTS content_transformations_output_idx
    ON content_transformations (output_version_id) WHERE output_version_id IS NOT NULL;

-- TENANT FENCE: the transformation's client must belong to its agency
-- and the workspace to the client.
CREATE OR REPLACE FUNCTION content_transformations_scope_chain_consistent() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM clients c
        WHERE c.client_id = NEW.client_id AND c.agency_id = NEW.agency_id) THEN
        RAISE EXCEPTION 'content transformation % client % does not belong to agency % — the tenant scope chain cannot be crossed',
            NEW.transformation_id, NEW.client_id, NEW.agency_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM workspaces w
        WHERE w.workspace_id = NEW.workspace_id AND w.client_id = NEW.client_id) THEN
        RAISE EXCEPTION 'content transformation % workspace % does not belong to client % — the tenant scope chain cannot be crossed',
            NEW.transformation_id, NEW.workspace_id, NEW.client_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_transformations_scope_chain_trigger ON content_transformations;
CREATE TRIGGER content_transformations_scope_chain_trigger
    BEFORE INSERT OR UPDATE OF agency_id, client_id, workspace_id ON content_transformations
    FOR EACH ROW EXECUTE FUNCTION content_transformations_scope_chain_consistent();

-- TRANSFORMATION RECORD DISCIPLINE: identity, scope, kind, engine
-- choice, execution binding, parameters, output spec and creation
-- provenance are IMMUTABLE. The ONLY sanctioned UPDATEs are the
-- terminal state moves (requested → completed with the output version
-- link; requested → failed with the failure reason), each advancing the
-- CAS version. NEVER a rewrite, never a reopen.
CREATE OR REPLACE FUNCTION content_transformations_disciplined() RETURNS trigger AS $$
BEGIN
    IF NEW.transformation_id <> OLD.transformation_id THEN
        RAISE EXCEPTION 'transformation_id % is immutable', OLD.transformation_id;
    END IF;
    IF NEW.agency_id <> OLD.agency_id OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id <> OLD.workspace_id THEN
        RAISE EXCEPTION 'content transformation % tenant scope chain is immutable',
            OLD.transformation_id;
    END IF;
    IF NEW.transformation_kind <> OLD.transformation_kind
       OR NEW.engine_id <> OLD.engine_id
       OR NEW.execution_ref <> OLD.execution_ref THEN
        RAISE EXCEPTION 'content transformation % kind/engine/execution binding is immutable',
            OLD.transformation_id;
    END IF;
    IF NEW.parameters <> OLD.parameters OR NEW.output_spec <> OLD.output_spec THEN
        RAISE EXCEPTION 'content transformation % parameters and output spec are immutable (a changed request is a NEW transformation)',
            OLD.transformation_id;
    END IF;
    IF NEW.created_by_actor <> OLD.created_by_actor
       OR NEW.created_via <> OLD.created_via
       OR NEW.correlation_id <> OLD.correlation_id
       OR NEW.causation_id IS DISTINCT FROM OLD.causation_id
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'content transformation % creation provenance is immutable',
            OLD.transformation_id;
    END IF;

    -- THE TERMINAL STATE MOVES: requested → completed | failed ONLY.
    IF NEW.status <> OLD.status THEN
        IF NOT ((OLD.status = 'requested' AND NEW.status = 'completed')
                OR (OLD.status = 'requested' AND NEW.status = 'failed')) THEN
            RAISE EXCEPTION 'illegal content transformation status move % -> % on transformation % (requested → completed|failed are the ONLY moves; terminal rows never reopen — a retry is a NEW transformation)',
                OLD.status, NEW.status, OLD.transformation_id;
        END IF;
        IF NEW.version_cas <> OLD.version_cas + 1 THEN
            RAISE EXCEPTION 'the content transformation state move must advance the CAS version (transformation %)',
                OLD.transformation_id;
        END IF;
        IF NEW.updated_at < OLD.updated_at THEN
            RAISE EXCEPTION 'the content transformation state move cannot rewind updated_at (transformation %)',
                OLD.transformation_id;
        END IF;
    ELSE
        IF NEW.version_cas <> OLD.version_cas OR NEW.updated_at <> OLD.updated_at THEN
            RAISE EXCEPTION 'content transformation % admits no mutation without a state move (the recorded request is immutable)',
                OLD.transformation_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_transformations_disciplined_trigger ON content_transformations;
CREATE TRIGGER content_transformations_disciplined_trigger
    BEFORE UPDATE ON content_transformations
    FOR EACH ROW EXECUTE FUNCTION content_transformations_disciplined();

-- No-DELETE: transformation history is append-oriented.
CREATE OR REPLACE FUNCTION content_transformations_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'content transformation % cannot be deleted — transformation history is append-oriented',
        OLD.transformation_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_transformations_no_delete_trigger ON content_transformations;
CREATE TRIGGER content_transformations_no_delete_trigger
    BEFORE DELETE ON content_transformations
    FOR EACH ROW EXECUTE FUNCTION content_transformations_no_delete();

-- ---------------------------------------------------------------------------
-- content_transformation_ingredients — the immutable ingredient
-- lineage links (explicit input versions, frozen at request time)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS content_transformation_ingredients (
    ingredient_id         uuid        PRIMARY KEY,
    transformation_id     uuid        NOT NULL REFERENCES content_transformations(transformation_id),
    -- The EXPLICIT input version (resolved server-side from the caller's
    -- (asset, version) pair — a request that does not name an exact
    -- version is rejected by the module guard BEFORE any write; the link
    -- freezes the resolved version so later re-registrations can never
    -- silently re-point a recorded transformation).
    input_version_id      uuid        NOT NULL REFERENCES content_asset_versions(version_id),
    -- The input version's OPAQUE REF frozen at request time (the
    -- conjunction-lineage vocabulary the /content-rights gate speaks).
    input_asset_ref       text        NOT NULL
                          CHECK (input_asset_ref ~ '^ca:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    -- The declared ingredient position (order matters for compilations
    -- and padding layouts; unique per transformation).
    position              int         NOT NULL CHECK (position >= 0),
    recorded_by_actor     text        NOT NULL
                          CHECK (length(recorded_by_actor) >= 1
                                 AND length(recorded_by_actor) <= 100),
    recorded_via          text        NOT NULL
                          CHECK (length(recorded_via) >= 1
                                 AND length(recorded_via) <= 100),
    correlation_id        text        NOT NULL,
    causation_id          text,
    created_at            timestamptz NOT NULL DEFAULT now()
);

-- One link per (transformation, input version); one link per position.
CREATE UNIQUE INDEX IF NOT EXISTS content_transformation_ingredients_pair_fence
    ON content_transformation_ingredients (transformation_id, input_version_id);
CREATE UNIQUE INDEX IF NOT EXISTS content_transformation_ingredients_position_fence
    ON content_transformation_ingredients (transformation_id, position);

CREATE INDEX IF NOT EXISTS content_transformation_ingredients_version_idx
    ON content_transformation_ingredients (input_version_id, created_at, ingredient_id);

-- SAME-CLIENT INGREDIENT FENCE: every ingredient version must belong to
-- the SAME Client as the transformation — cross-Client composition is
-- rejected by the database itself (the migration-051 lineage posture:
-- composition material must resolve rights in the composite's client).
CREATE OR REPLACE FUNCTION content_transformation_ingredients_same_client() RETURNS trigger AS $$
DECLARE
    v_client uuid;
    v_ingredient_client uuid;
BEGIN
    SELECT client_id INTO v_client FROM content_transformations
        WHERE content_transformations.transformation_id = NEW.transformation_id;
    IF v_client IS NULL THEN
        RAISE EXCEPTION 'transformation ingredient % references unknown transformation %',
            NEW.ingredient_id, NEW.transformation_id;
    END IF;
    SELECT client_id INTO v_ingredient_client FROM content_asset_versions
        WHERE content_asset_versions.version_id = NEW.input_version_id;
    IF v_ingredient_client IS NULL THEN
        RAISE EXCEPTION 'transformation ingredient % references unknown asset version %',
            NEW.ingredient_id, NEW.input_version_id;
    END IF;
    IF v_ingredient_client <> v_client THEN
        RAISE EXCEPTION 'transformation ingredient % version % belongs to another client — cross-Client composition is rejected',
            NEW.ingredient_id, NEW.input_version_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_transformation_ingredients_same_client_trigger
    ON content_transformation_ingredients;
CREATE TRIGGER content_transformation_ingredients_same_client_trigger
    BEFORE INSERT ON content_transformation_ingredients
    FOR EACH ROW EXECUTE FUNCTION content_transformation_ingredients_same_client();

-- FULLY APPEND-ONLY: a recorded ingredient link is an immutable lineage
-- fact (the MKT-063 lineage discipline — history is never rewritten).
CREATE OR REPLACE FUNCTION content_transformation_ingredients_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'content transformation ingredient % is append-only (a recorded lineage link is an immutable fact)',
        OLD.ingredient_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_transformation_ingredients_append_only_trigger
    ON content_transformation_ingredients;
CREATE TRIGGER content_transformation_ingredients_append_only_trigger
    BEFORE UPDATE OR DELETE ON content_transformation_ingredients
    FOR EACH ROW EXECUTE FUNCTION content_transformation_ingredients_append_only();
