-- 051_content_rights.sql — MKT-063 (Content Rights and Provenance).
--
-- The CONTENT RIGHTS authority (spec/effective-backlog-v1.6.md MKT-063:
-- "explicit asset-level rights state and publication gate. Acceptance:
-- owned/license/platform-permitted/cleared/review/blocked states,
-- ingredient lineage, fail-closed autonomous publication"; spec/
-- architecture-v1.6.md §9: "Content Rights is an explicit publication
-- gate... Every derived asset keeps lineage to its ingredients. Fair-use
-- reasoning is represented as review evidence, not as an automatic legal
-- guarantee"; spec/frozen-manifest-v1.6.json hardPublicationRules:
-- rightsUncertaintyFailsClosed + sourceLineageRequired +
-- destinationPolicyGateRequired; spec/module-dependency-matrix-v1.6.md
-- boundary rule 4: "Content Rights can block publication but cannot
-- silently approve unclear rights"; AGENTS.md v1.6 growth-autonomy rules:
-- "Rights uncertainty fails closed for autonomous publication", "Fair-use
-- reasoning is evidence for review, not an automatic legal guarantee",
-- "Content used for padding, compilations or composites must carry its
-- own rights/provenance").
--
--   content_rights_records        → the CLIENT-SCOPED asset-level RIGHTS
--                                    RECORDS: the rights state bound to
--                                    an OPAQUE content-asset reference
--                                    (the MKT-064 id-based seam — the
--                                    /content-assets module does not
--                                    exist yet and is NOT imported; the
--                                    backlog dependency list MKT-013/
--                                    MKT-022 is the build-time authority),
--                                    the REQUIRED /evidence-anchored
--                                    source provenance, the licence
--                                    evidence + label (required the
--                                    moment the state claims a licence
--                                    basis — the payload-shape CHECK),
--                                    the valid_until expiry horizon
--                                    (evaluated FAIL-CLOSED at gate time)
--                                    and the born-'unknown' current-state
--                                    pointer that moves ONLY along the
--                                    frozen transition table (trigger);
--   content_rights_events         → the fully append-only TRANSITION-EVENT
--                                    tail: one immutable row per state
--                                    transition (from_state, to_state,
--                                    event_kind, the REQUIRED reason,
--                                    server-derived provenance) with the
--                                    (from, to, kind) triple CHECK-fenced
--                                    to the frozen transition table and
--                                    clearance_id REQUIRED exactly for
--                                    human_clearance rows — history is
--                                    never mutated in place;
--   content_rights_clearances     → the HUMAN CLEARANCE records: the
--                                    ONLY sanctioned review → cleared
--                                    path — the ACTOR IDENTITY of the
--                                    clearing human, the REQUIRED
--                                    rationale, the optional /evidence
--                                    reference for supporting review
--                                    evidence (fair-use reasoning rides
--                                    HERE — never an auto-clear), fully
--                                    append-only;
--   content_rights_permissions    → the destination-platform PERMISSION
--                                    SCOPE rows: what the source's
--                                    licence permits on which destination
--                                    platforms (one immutable row per
--                                    recording; the NEWEST row per
--                                    (record, platform) is effective —
--                                    scope changes are NEW rows, the full
--                                    tail stays auditable), each carrying
--                                    its REQUIRED /evidence reference;
--   content_rights_lineage_links  → the immutable INGREDIENT LINEAGE
--                                    links: the composition facts a
--                                    composite resolves as the CONJUNCTION
--                                    of its ingredients (any unclear
--                                    ingredient blocks the composite from
--                                    autonomous publication; any blocked/
--                                    absent ingredient blocks it outright),
--                                    unique per (client, composite,
--                                    ingredient), no self-links, fully
--                                    append-only.
--
-- DISCLOSED REGISTRATION SUBSET (the /product-intelligence MKT-069
-- precedent): the frozen v1.6 matrix row for /content-rights lists
-- /evidence, /policies and /content-assets; /content-assets arrives with
-- MKT-064 (a LATER Worker B session), so this migration + module consume
-- /evidence (FK-anchored same-Client links) and /policies (the gate's
-- destination policy key, recorded in the policy engine's own ledger —
-- no policy table is touched here) and /content-assets joins the row at
-- MKT-064 time.
--
-- FAIL-CLOSED POSTURE THROUGHOUT:
--   * every /evidence link is FK-anchored AND same-Client trigger-fenced
--     (the migration-023 job_outcomes pattern) — cross-tenant evidence
--     linkage is rejected by the database itself;
--   * the tenant scope chain (agency → client → workspace) is
--     trigger-fenced on every insert/update of the scoped tables;
--   * the record's current-state column moves ONLY along the frozen
--     transition-table pairs, with the CAS version advanced — the event
--     tail's CHECK-fenced triples are the persisted mirror (the module
--     writes event + state move in ONE transaction);
--   * `cleared` is reachable ONLY from `review` via human_clearance
--     (event CHECK requires the clearance row) — there is NO schema path
--     from unknown/review to a publishable state that does not pass
--     through a recorded human-action event;
--   * UPDATE/DELETE on the event/clearance/permission/lineage tails are
--     rejected outright (append-only discipline); the rights records are
--     no-DELETE with the single disciplined state-move UPDATE.
--
-- OWN TABLES ONLY: no evidence, policy, credential, tenant, mission,
-- workflow, execution, asset-store or job table is created or mutated
-- (the authorities stay sole, consumed READ-ONLY through their public
-- contracts; /content-assets is the FUTURE consumer of this gate, never
-- an import here).
--
-- Migration numbering: 051 is PRE-ASSIGNED to MKT-063; 049 is the current
-- tail on the base and sibling workers are told 050/051 may collide —
-- kept 051, disclosed (the Tech Lead reconciles at merge).

-- ---------------------------------------------------------------------------
-- content_rights_records — the asset-level rights records
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS content_rights_records (
    rights_record_id      uuid        PRIMARY KEY,
    -- The tenant scope chain (SERVER-DERIVED from canonical ownership at
    -- the route/module boundary; immutable).
    agency_id             uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id             uuid        NOT NULL REFERENCES clients(client_id),
    -- The OPTIONAL Workspace narrowing (must belong to the client).
    workspace_id          uuid        REFERENCES workspaces(workspace_id),
    -- The OPAQUE CONTENT-ASSET REFERENCE — the MKT-064 id-based seam.
    -- Grammar-fenced (path-safe, no scheme, no whitespace); UNIQUE per
    -- client: one rights record per asset reference (a re-registered
    -- asset is a NEW asset version, which is a NEW reference — the
    -- MKT-064 immutability discipline).
    content_asset_ref     text        NOT NULL
                          CHECK (content_asset_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    -- The asset kind: a source (original material) or a composite (a
    -- clip/compilation/padded composition with ingredients — padding
    -- and compilation material is itself subject to rights and
    -- provenance gates).
    asset_kind            text        NOT NULL
                          CHECK (asset_kind IN ('source', 'composite')),
    -- The CURRENT rights state (the frozen cr-vocab-v1 vocabulary: the
    -- MKT-063 acceptance list VERBATIM + the explicit `unknown` initial
    -- state). Born 'unknown'; moves ONLY along the frozen transition
    -- table (the disciplined state-move trigger below).
    state                 text        NOT NULL DEFAULT 'unknown'
                          CHECK (state IN ('owned', 'license', 'platform_permitted',
                                           'cleared', 'review', 'blocked', 'unknown')),
    -- SOURCE PROVENANCE: the /evidence record anchoring where the
    -- asset/claim came from (REQUIRED — a record without provenance is
    -- never born; FK + same-Client trigger fence below).
    source_evidence_ref   uuid        NOT NULL REFERENCES evidence(evidence_id),
    -- The human-readable licence descriptor (nullable).
    licence_label         text
                          CHECK (licence_label IS NULL
                                 OR (length(licence_label) >= 1
                                     AND length(licence_label) <= 500)),
    -- LICENCE EVIDENCE: the /evidence record backing the licence claim.
    -- REQUIRED the moment the state claims a licence basis (the
    -- payload-shape CHECK below) — a licence state without licence
    -- evidence cannot even be persisted.
    licence_evidence_ref  uuid        REFERENCES evidence(evidence_id),
    -- EXPIRY SEMANTICS: the licence's validity horizon. Evaluated
    -- FAIL-CLOSED at gate time (an expired horizon BLOCKS the
    -- evaluation, whatever the recorded state) — the recorded state
    -- itself is never silently rewritten by time.
    valid_until           timestamptz,
    -- SERVER-DERIVED provenance of the record (never request fields).
    created_by_actor      text        NOT NULL
                          CHECK (length(created_by_actor) >= 1
                                 AND length(created_by_actor) <= 100),
    created_via          text        NOT NULL
                          CHECK (length(created_via) >= 1
                                 AND length(created_via) <= 100),
    correlation_id        text        NOT NULL,
    causation_id          text,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    version               bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),

    -- THE PAYLOAD-SHAPE FENCE: a licence-basis state requires its
    -- licence evidence (a licence/platform-permitted record without a
    -- licence evidence reference cannot exist).
    CONSTRAINT content_rights_record_shape CHECK (
        (state IN ('license', 'platform_permitted') AND licence_evidence_ref IS NOT NULL)
        OR (state NOT IN ('license', 'platform_permitted'))
    )
);

-- One rights record per (client, asset reference) — the re-registration
-- fence (the honest ConflictError at the module surface).
CREATE UNIQUE INDEX IF NOT EXISTS content_rights_records_asset_fence
    ON content_rights_records (client_id, content_asset_ref);

-- Listing surfaces: the client's records, the workspace slice and the
-- agency audit range.
CREATE INDEX IF NOT EXISTS content_rights_records_client_idx
    ON content_rights_records (client_id, created_at DESC, rights_record_id DESC);
CREATE INDEX IF NOT EXISTS content_rights_records_workspace_idx
    ON content_rights_records (workspace_id) WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS content_rights_records_agency_idx
    ON content_rights_records (agency_id, created_at DESC, rights_record_id DESC);

-- TENANT FENCE (the migration 003/029/046/047 pattern): the record's
-- client must belong to its agency, and the optional workspace must
-- belong to the client — the scope chain cannot be crossed even by a
-- direct SQL writer.
CREATE OR REPLACE FUNCTION content_rights_scope_chain_consistent() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM clients c
        WHERE c.client_id = NEW.client_id AND c.agency_id = NEW.agency_id) THEN
        RAISE EXCEPTION 'content rights record % client % does not belong to agency % — the tenant scope chain cannot be crossed',
            NEW.rights_record_id, NEW.client_id, NEW.agency_id;
    END IF;
    IF NEW.workspace_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workspaces w
        WHERE w.workspace_id = NEW.workspace_id AND w.client_id = NEW.client_id) THEN
        RAISE EXCEPTION 'content rights record % workspace % does not belong to client % — the tenant scope chain cannot be crossed',
            NEW.rights_record_id, NEW.workspace_id, NEW.client_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_rights_scope_chain_trigger ON content_rights_records;
CREATE TRIGGER content_rights_scope_chain_trigger
    BEFORE INSERT OR UPDATE OF agency_id, client_id, workspace_id ON content_rights_records
    FOR EACH ROW EXECUTE FUNCTION content_rights_scope_chain_consistent();

-- SAME-CLIENT EVIDENCE BACKSTOP (the migration 023 job_outcomes pattern):
-- every /evidence link of the record (source provenance + licence
-- evidence) must belong to the SAME Client — cross-tenant evidence
-- linkage is rejected by the database itself.
CREATE OR REPLACE FUNCTION content_rights_evidence_same_client() RETURNS trigger AS $$
DECLARE
    v_client   uuid;
    v_evidence_client uuid;
BEGIN
    v_client := NEW.client_id;
    SELECT client_id INTO v_evidence_client FROM evidence WHERE evidence.evidence_id = NEW.source_evidence_ref;
    IF v_evidence_client IS NULL THEN
        RAISE EXCEPTION 'content rights record % references unknown source evidence %',
            NEW.rights_record_id, NEW.source_evidence_ref;
    END IF;
    IF v_evidence_client <> v_client THEN
        RAISE EXCEPTION 'content rights record % source evidence % belongs to another client — cross-tenant evidence linkage is rejected',
            NEW.rights_record_id, NEW.source_evidence_ref;
    END IF;
    IF NEW.licence_evidence_ref IS NOT NULL THEN
        SELECT client_id INTO v_evidence_client FROM evidence WHERE evidence.evidence_id = NEW.licence_evidence_ref;
        IF v_evidence_client IS NULL THEN
            RAISE EXCEPTION 'content rights record % references unknown licence evidence %',
                NEW.rights_record_id, NEW.licence_evidence_ref;
        END IF;
        IF v_evidence_client <> v_client THEN
            RAISE EXCEPTION 'content rights record % licence evidence % belongs to another client — cross-tenant evidence linkage is rejected',
                NEW.rights_record_id, NEW.licence_evidence_ref;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_rights_evidence_same_client_trigger ON content_rights_records;
CREATE TRIGGER content_rights_evidence_same_client_trigger
    BEFORE INSERT OR UPDATE OF source_evidence_ref, licence_evidence_ref, client_id
    ON content_rights_records
    FOR EACH ROW EXECUTE FUNCTION content_rights_evidence_same_client();

-- RECORD DISCIPLINE (the migration 046/047 pattern): identity, scope,
-- asset binding, provenance and the recorded facts are IMMUTABLE through
-- ANY mutation path. The ONLY sanctioned UPDATE is THE STATE MOVE: the
-- current-state column may move ONLY along the frozen transition-table
-- pairs (the same pairs the event tail's CHECK fences — the module
-- writes the event row + this move in ONE transaction), advancing the
-- CAS version; anything else about the row is frozen at birth.
-- `cleared` is reachable ONLY from `review` — there is NO legal pair
-- into a publishable state from unknown/review that bypasses the
-- recorded human-action event spine.
CREATE OR REPLACE FUNCTION content_rights_record_disciplined() RETURNS trigger AS $$
BEGIN
    IF NEW.rights_record_id <> OLD.rights_record_id THEN
        RAISE EXCEPTION 'rights_record_id % is immutable', OLD.rights_record_id;
    END IF;
    IF NEW.agency_id <> OLD.agency_id OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
        RAISE EXCEPTION 'content rights record % tenant scope chain is immutable',
            OLD.rights_record_id;
    END IF;
    IF NEW.content_asset_ref <> OLD.content_asset_ref
       OR NEW.asset_kind <> OLD.asset_kind THEN
        RAISE EXCEPTION 'content rights record % asset binding is immutable (a re-registered asset is a NEW asset version = a NEW reference)',
            OLD.rights_record_id;
    END IF;
    IF NEW.source_evidence_ref <> OLD.source_evidence_ref
       OR NEW.licence_label IS DISTINCT FROM OLD.licence_label
       OR NEW.licence_evidence_ref IS DISTINCT FROM OLD.licence_evidence_ref
       OR NEW.valid_until IS DISTINCT FROM OLD.valid_until THEN
        RAISE EXCEPTION 'content rights record % recorded facts are immutable (corrections are recorded transition events, never rewrites)',
            OLD.rights_record_id;
    END IF;
    IF NEW.created_by_actor <> OLD.created_by_actor
       OR NEW.created_via <> OLD.created_via
       OR NEW.correlation_id <> OLD.correlation_id
       OR NEW.causation_id IS DISTINCT FROM OLD.causation_id
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'content rights record % creation provenance is immutable',
            OLD.rights_record_id;
    END IF;

    -- THE STATE MOVE: only along the frozen transition-table pairs.
    IF NEW.state <> OLD.state THEN
        IF NOT (
            (OLD.state = 'unknown' AND NEW.state IN ('owned', 'license', 'platform_permitted', 'review', 'blocked'))
            OR (OLD.state = 'review' AND NEW.state IN ('cleared', 'blocked'))
            OR (OLD.state IN ('owned', 'license', 'platform_permitted', 'cleared') AND NEW.state IN ('review', 'blocked'))
            OR (OLD.state = 'blocked' AND NEW.state = 'review')
        ) THEN
            RAISE EXCEPTION 'illegal content rights state move % -> % on record % (the frozen transition table: cleared is reachable ONLY from review via human_clearance; unknown/review never auto-approve)',
                OLD.state, NEW.state, OLD.rights_record_id;
        END IF;
        IF NEW.version <> OLD.version + 1 THEN
            RAISE EXCEPTION 'the content rights state move must advance the CAS version (record %)',
                OLD.rights_record_id;
        END IF;
        IF NEW.updated_at < OLD.updated_at THEN
            RAISE EXCEPTION 'the content rights state move cannot rewind updated_at (record %)',
                OLD.rights_record_id;
        END IF;
    ELSE
        IF NEW.version <> OLD.version OR NEW.updated_at <> OLD.updated_at THEN
            RAISE EXCEPTION 'content rights record % admits no mutation without a state move (the recorded facts are immutable)',
                OLD.rights_record_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_rights_record_disciplined_trigger ON content_rights_records;
CREATE TRIGGER content_rights_record_disciplined_trigger
    BEFORE UPDATE ON content_rights_records
    FOR EACH ROW EXECUTE FUNCTION content_rights_record_disciplined();

-- No-DELETE: rights history is append-oriented (the honest removal
-- surfaces of future Work Items are recorded states, never erasure).
CREATE OR REPLACE FUNCTION content_rights_record_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'content rights record % cannot be deleted — rights history is append-oriented (state transitions are recorded events, never erasure)',
        OLD.rights_record_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_rights_record_no_delete_trigger ON content_rights_records;
CREATE TRIGGER content_rights_record_no_delete_trigger
    BEFORE DELETE ON content_rights_records
    FOR EACH ROW EXECUTE FUNCTION content_rights_record_no_delete();

-- ---------------------------------------------------------------------------
-- content_rights_clearances — the HUMAN CLEARANCE records (the ONLY
-- review → cleared path; created ahead of the events table because the
-- event rows reference them)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS content_rights_clearances (
    clearance_id          uuid        PRIMARY KEY,
    rights_record_id      uuid        NOT NULL REFERENCES content_rights_records(rights_record_id),
    -- The ACTOR IDENTITY of the clearing human (server-derived from the
    -- authenticated principal — the clearance is an explicit human
    -- action, never an automated one).
    cleared_by_actor      text        NOT NULL
                          CHECK (length(cleared_by_actor) >= 1
                                 AND length(cleared_by_actor) <= 100),
    cleared_via           text        NOT NULL
                          CHECK (length(cleared_via) >= 1
                                 AND length(cleared_via) <= 100),
    -- The REQUIRED rationale: WHY the human cleared the rights question.
    rationale             text        NOT NULL
                          CHECK (length(rationale) >= 1 AND length(rationale) <= 4000),
    -- Supporting review EVIDENCE (fair-use reasoning and any other
    -- backing material ride HERE — evidence for review, never an
    -- automatic legal guarantee, never an auto-clear). FK + same-Client
    -- trigger fence below.
    evidence_ref          uuid        REFERENCES evidence(evidence_id),
    correlation_id        text        NOT NULL,
    causation_id          text,
    cleared_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS content_rights_clearances_record_idx
    ON content_rights_clearances (rights_record_id, cleared_at, clearance_id);

-- SAME-CLIENT EVIDENCE BACKSTOP for the clearance's supporting evidence.
CREATE OR REPLACE FUNCTION content_rights_clearance_evidence_same_client() RETURNS trigger AS $$
DECLARE
    v_record_client uuid;
    v_evidence_client uuid;
BEGIN
    SELECT client_id INTO v_record_client FROM content_rights_records
        WHERE content_rights_records.rights_record_id = NEW.rights_record_id;
    IF v_record_client IS NULL THEN
        RAISE EXCEPTION 'clearance % references unknown rights record %',
            NEW.clearance_id, NEW.rights_record_id;
    END IF;
    IF NEW.evidence_ref IS NOT NULL THEN
        SELECT client_id INTO v_evidence_client FROM evidence WHERE evidence.evidence_id = NEW.evidence_ref;
        IF v_evidence_client IS NULL THEN
            RAISE EXCEPTION 'clearance % references unknown evidence %',
                NEW.clearance_id, NEW.evidence_ref;
        END IF;
        IF v_evidence_client <> v_record_client THEN
            RAISE EXCEPTION 'clearance % evidence % belongs to another client — cross-tenant evidence linkage is rejected',
                NEW.clearance_id, NEW.evidence_ref;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_rights_clearance_evidence_same_client_trigger
    ON content_rights_clearances;
CREATE TRIGGER content_rights_clearance_evidence_same_client_trigger
    BEFORE INSERT ON content_rights_clearances
    FOR EACH ROW EXECUTE FUNCTION content_rights_clearance_evidence_same_client();

-- FULLY APPEND-ONLY: a recorded human clearance is an immutable fact.
CREATE OR REPLACE FUNCTION content_rights_clearance_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'content rights clearance % is append-only (a recorded human clearance is an immutable fact)',
        OLD.clearance_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_rights_clearance_append_only_trigger
    ON content_rights_clearances;
CREATE TRIGGER content_rights_clearance_append_only_trigger
    BEFORE UPDATE OR DELETE ON content_rights_clearances
    FOR EACH ROW EXECUTE FUNCTION content_rights_clearance_append_only();

-- ---------------------------------------------------------------------------
-- content_rights_events — the append-only state-transition tail
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS content_rights_events (
    event_id              uuid        PRIMARY KEY,
    rights_record_id      uuid        NOT NULL REFERENCES content_rights_records(rights_record_id),
    -- The state BEFORE the transition (the CAS-from; CHECK-fenced).
    from_state            text        NOT NULL
                          CHECK (from_state IN ('owned', 'license', 'platform_permitted',
                                                 'cleared', 'review', 'blocked', 'unknown')),
    -- The state AFTER the transition (CHECK-fenced).
    to_state              text        NOT NULL
                          CHECK (to_state IN ('owned', 'license', 'platform_permitted',
                                              'cleared', 'review', 'blocked', 'unknown')),
    -- The event kind (the frozen cr-vocab-v1 vocabulary).
    event_kind            text        NOT NULL
                          CHECK (event_kind IN ('determination', 'human_clearance',
                                                 'contestation', 'revocation',
                                                 'review_denial', 're_review_request')),
    -- The REQUIRED bounded reason the transition was recorded.
    reason                text        NOT NULL
                          CHECK (length(reason) >= 1 AND length(reason) <= 2000),
    -- The clearance record — REQUIRED exactly for human_clearance rows
    -- (the event-shape CHECK) and FK-anchored to the immutable clearance.
    clearance_id          uuid        REFERENCES content_rights_clearances(clearance_id),
    -- SERVER-DERIVED provenance (never request fields).
    recorded_by_actor     text        NOT NULL
                          CHECK (length(recorded_by_actor) >= 1
                                 AND length(recorded_by_actor) <= 100),
    recorded_via          text        NOT NULL
                          CHECK (length(recorded_via) >= 1
                                 AND length(recorded_via) <= 100),
    correlation_id        text        NOT NULL,
    causation_id          text,
    recorded_at           timestamptz NOT NULL DEFAULT now(),

    -- THE EVENT SHAPE: only a human_clearance row carries a clearance.
    CONSTRAINT content_rights_event_shape CHECK (
        (event_kind = 'human_clearance' AND clearance_id IS NOT NULL)
        OR (event_kind <> 'human_clearance' AND clearance_id IS NULL)
    ),
    -- THE FROZEN TRANSITION TABLE (the persisted mirror of the module's
    -- pure isLegalContentRightsTransition): every legal (from, to,
    -- kind) triple, and NOTHING else. `cleared` is reachable ONLY from
    -- `review` via human_clearance with the clearance row — the
    -- fail-closed human-action spine; unknown/review NEVER auto-approve.
    CONSTRAINT content_rights_transition_table_check CHECK (
        (from_state = 'unknown' AND event_kind = 'determination'
            AND to_state IN ('owned', 'license', 'platform_permitted', 'review', 'blocked'))
        OR (from_state = 'review' AND event_kind = 'human_clearance' AND to_state = 'cleared')
        OR (from_state = 'review' AND event_kind = 'review_denial' AND to_state = 'blocked')
        OR (from_state IN ('owned', 'license', 'platform_permitted', 'cleared')
            AND event_kind = 'contestation' AND to_state = 'review')
        OR (from_state IN ('owned', 'license', 'platform_permitted', 'cleared')
            AND event_kind = 'revocation' AND to_state = 'blocked')
        OR (from_state = 'blocked' AND event_kind = 're_review_request' AND to_state = 'review')
    )
);

-- The transition tail reads: per record (the full history) and the
-- agency audit range.
CREATE INDEX IF NOT EXISTS content_rights_events_record_idx
    ON content_rights_events (rights_record_id, recorded_at, event_id);
CREATE INDEX IF NOT EXISTS content_rights_events_kind_idx
    ON content_rights_events (event_kind, recorded_at);

-- FULLY APPEND-ONLY (the MKT-063 history discipline): state transitions
-- are RECORDED EVENTS — UPDATE and DELETE are rejected outright; the
-- current-state pointer lives on the record row and moves only along
-- the same fenced pairs.
CREATE OR REPLACE FUNCTION content_rights_event_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'content rights event % is append-only (state transitions are recorded events — history is never mutated in place)',
        OLD.event_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_rights_event_append_only_trigger ON content_rights_events;
CREATE TRIGGER content_rights_event_append_only_trigger
    BEFORE UPDATE OR DELETE ON content_rights_events
    FOR EACH ROW EXECUTE FUNCTION content_rights_event_append_only();

-- ---------------------------------------------------------------------------
-- content_rights_permissions — the destination-platform permission scope
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS content_rights_permissions (
    permission_id         uuid        PRIMARY KEY,
    rights_record_id      uuid        NOT NULL REFERENCES content_rights_records(rights_record_id),
    -- The DESTINATION PLATFORM KEY: an opaque adapter-plane key carried
    -- as data (the /social-accounts adapter-key precedent —
    -- platform-specific rules live behind the adapter plane, never
    -- here; grammar-fenced lowercase).
    platform_key          text        NOT NULL
                          CHECK (platform_key ~ '^[a-z][a-z0-9_-]{0,31}$'),
    -- What the source's licence permits on this destination: permitted
    -- | not_permitted. An ABSENT row for a destination is the gate's
    -- `unspecified` posture (fail-closed to review_required for
    -- licence-basis states — evaluated at gate time, never defaulted).
    permission            text        NOT NULL
                          CHECK (permission IN ('permitted', 'not_permitted')),
    -- The /evidence record backing THIS permission claim (REQUIRED; FK
    -- + same-Client trigger fence below).
    evidence_ref          uuid        NOT NULL REFERENCES evidence(evidence_id),
    -- SERVER-DERIVED provenance (never request fields).
    recorded_by_actor     text        NOT NULL
                          CHECK (length(recorded_by_actor) >= 1
                                 AND length(recorded_by_actor) <= 100),
    recorded_via          text        NOT NULL
                          CHECK (length(recorded_via) >= 1
                                 AND length(recorded_via) <= 100),
    correlation_id        text        NOT NULL,
    causation_id          text,
    recorded_at           timestamptz NOT NULL DEFAULT now()
);

-- The scope tail reads: per record (the full auditable tail — the
-- NEWEST row per platform is the effective permission) and the
-- per-platform audit range.
CREATE INDEX IF NOT EXISTS content_rights_permissions_record_idx
    ON content_rights_permissions (rights_record_id, platform_key, recorded_at, permission_id);
CREATE INDEX IF NOT EXISTS content_rights_permissions_platform_idx
    ON content_rights_permissions (platform_key, recorded_at);

-- SAME-CLIENT EVIDENCE BACKSTOP for the permission claim's evidence.
CREATE OR REPLACE FUNCTION content_rights_permission_evidence_same_client() RETURNS trigger AS $$
DECLARE
    v_record_client uuid;
    v_evidence_client uuid;
BEGIN
    SELECT client_id INTO v_record_client FROM content_rights_records
        WHERE content_rights_records.rights_record_id = NEW.rights_record_id;
    IF v_record_client IS NULL THEN
        RAISE EXCEPTION 'permission % references unknown rights record %',
            NEW.permission_id, NEW.rights_record_id;
    END IF;
    SELECT client_id INTO v_evidence_client FROM evidence WHERE evidence.evidence_id = NEW.evidence_ref;
    IF v_evidence_client IS NULL THEN
        RAISE EXCEPTION 'permission % references unknown evidence %',
            NEW.permission_id, NEW.evidence_ref;
    END IF;
    IF v_evidence_client <> v_record_client THEN
        RAISE EXCEPTION 'permission % evidence % belongs to another client — cross-tenant evidence linkage is rejected',
            NEW.permission_id, NEW.evidence_ref;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_rights_permission_evidence_same_client_trigger
    ON content_rights_permissions;
CREATE TRIGGER content_rights_permission_evidence_same_client_trigger
    BEFORE INSERT ON content_rights_permissions
    FOR EACH ROW EXECUTE FUNCTION content_rights_permission_evidence_same_client();

-- FULLY APPEND-ONLY: permission rows are immutable recorded facts — a
-- scope change is a NEW row (the newest row per platform is effective;
-- the full tail stays auditable). UPDATE/DELETE are rejected outright.
CREATE OR REPLACE FUNCTION content_rights_permission_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'content rights permission % is append-only (scope changes are NEW rows — the permission tail stays auditable)',
        OLD.permission_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_rights_permission_append_only_trigger
    ON content_rights_permissions;
CREATE TRIGGER content_rights_permission_append_only_trigger
    BEFORE UPDATE OR DELETE ON content_rights_permissions
    FOR EACH ROW EXECUTE FUNCTION content_rights_permission_append_only();

-- ---------------------------------------------------------------------------
-- content_rights_lineage_links — the immutable ingredient lineage
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS content_rights_lineage_links (
    lineage_link_id       uuid        PRIMARY KEY,
    -- The tenant scope chain (SERVER-DERIVED; the scope-chain trigger is
    -- the shared content_rights_scope_chain_consistent function).
    agency_id             uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id             uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id          uuid        REFERENCES workspaces(workspace_id),
    -- The COMPOSITE's opaque asset reference (what the composition is).
    composite_asset_ref   text        NOT NULL
                          CHECK (composite_asset_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    -- The INGREDIENT's opaque asset reference (what it was composed
    -- from). The ingredient resolves its OWN rights record by this
    -- reference in the SAME client (a cross-Client ingredient has no
    -- resolvable rights here — the gate fails it closed; disclosed).
    ingredient_asset_ref  text        NOT NULL
                          CHECK (ingredient_asset_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    -- No self-links (an asset cannot be its own ingredient).
    CONSTRAINT content_rights_lineage_no_self CHECK (
        composite_asset_ref <> ingredient_asset_ref
    ),
    -- SERVER-DERIVED provenance (never request fields).
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

-- THE PAIR FENCE: at most ONE link per (client, composite, ingredient) —
-- composition facts are immutable (a duplicate is the honest 409).
CREATE UNIQUE INDEX IF NOT EXISTS content_rights_lineage_links_pair_fence
    ON content_rights_lineage_links (client_id, composite_asset_ref, ingredient_asset_ref);

-- The lineage reads: per composite (the gate's traversal) and the
-- per-ingredient reverse lookup (which composites use this asset).
CREATE INDEX IF NOT EXISTS content_rights_lineage_links_composite_idx
    ON content_rights_lineage_links (client_id, composite_asset_ref, created_at, lineage_link_id);
CREATE INDEX IF NOT EXISTS content_rights_lineage_links_ingredient_idx
    ON content_rights_lineage_links (client_id, ingredient_asset_ref);

DROP TRIGGER IF EXISTS content_rights_lineage_scope_chain_trigger ON content_rights_lineage_links;
CREATE OR REPLACE FUNCTION content_rights_lineage_scope_chain_consistent() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM clients c
        WHERE c.client_id = NEW.client_id AND c.agency_id = NEW.agency_id) THEN
        RAISE EXCEPTION 'content rights lineage link % client % does not belong to agency % — the tenant scope chain cannot be crossed',
            NEW.lineage_link_id, NEW.client_id, NEW.agency_id;
    END IF;
    IF NEW.workspace_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workspaces w
        WHERE w.workspace_id = NEW.workspace_id AND w.client_id = NEW.client_id) THEN
        RAISE EXCEPTION 'content rights lineage link % workspace % does not belong to client % — the tenant scope chain cannot be crossed',
            NEW.lineage_link_id, NEW.workspace_id, NEW.client_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER content_rights_lineage_scope_chain_trigger
    BEFORE INSERT OR UPDATE OF agency_id, client_id, workspace_id ON content_rights_lineage_links
    FOR EACH ROW EXECUTE FUNCTION content_rights_lineage_scope_chain_consistent();

-- FULLY APPEND-ONLY + IMMUTABLE (the MKT-063 lineage discipline): the
-- composition facts are auditable forever — UPDATE and DELETE are
-- rejected outright by trigger (the migration-047 fence/receipt
-- pattern).
CREATE OR REPLACE FUNCTION content_rights_lineage_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'content rights lineage link % is append-only (ingredient lineage is immutable and auditable — the composition facts are never rewritten)',
        OLD.lineage_link_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_rights_lineage_append_only_trigger
    ON content_rights_lineage_links;
CREATE TRIGGER content_rights_lineage_append_only_trigger
    BEFORE UPDATE OR DELETE ON content_rights_lineage_links
    FOR EACH ROW EXECUTE FUNCTION content_rights_lineage_append_only();
