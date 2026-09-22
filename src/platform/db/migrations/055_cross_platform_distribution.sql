-- 055_cross_platform_distribution.sql — MKT-065 (Cross-Platform
-- Distribution).
--
-- The DISTRIBUTION PLAN authority (spec/architecture-v1.6.md §5
-- "Cross-platform distribution": "A Distribution Plan maps Source Asset →
-- Rights/Provenance → Transformation Plan → Target Platform → Target
-- Account → Target Format → Publication → Measurement. Cross-platform
-- publication is legal/policy-gated per destination. ... A platform
-- connection never implies rights to redistribute content that originated
-- elsewhere."; spec/architecture-lock-v1.6.md rules 20 ("Cross-platform
-- distribution is rights-gated per source asset and destination"), 29
-- ("Cross-platform publishing requires both source rights and destination
-- capability/policy clearance"); spec/module-dependency-matrix-v1.6.md
-- frozen row "/cross-platform-distribution → /growth-missions,
-- /social-accounts, /content-assets, /content-rights, /integrations,
-- /policies").
--
-- Migration numbering: 055 is PRE-ASSIGNED to MKT-065 (the Tech-Lead
-- assignment; 054_experiment_analysis.sql is the tail on the base; the
-- MKT-057 and UX-002 siblings were told to add NONE — the Tech Lead
-- reconciles numbering at merge, the 063/064/067 precedent).
--
-- Tables created here (table ownership follows the frozen authority map):
--
--   distribution_plans
--     → the DISTRIBUTION PLAN records: the §5 chain as one durable
--       declaration — the SOURCE ASSET (the opaque 064 'ca:' ref + the
--       resolved explicit version id — never a floating pointer), the
--       TRANSFORMATION PLAN (the bounded declared mapping to versioned
--       derived outputs, each an 'ca:' ref that resolved through
--       /content-assets at planning time), the optional MISSION anchor
--       (the /growth-missions read-only FK — the mission authority stays
--       sole for mission identity/lifecycle; nothing here ever mutates a
--       mission), the canonical input digest (deterministic planning),
--       and the plan lifecycle pointer (planned → dispatching →
--       dispatched; re-dispatch of a dispatched plan re-enters
--       'dispatching' — the idempotent convergence discipline; identity
--       columns immutable; no DELETE).
--   distribution_destinations
--     → the per-destination VARIANT rows (one source fans out to N
--       destinations): the TARGET ACCOUNT (the /social-accounts read-only
--       FK + same-Client trigger), the platform id carried as data (the
--       account's adapter key, frozen at planning), the TARGET FORMAT and
--       the destination-specific publish request (the 056 shape frozen at
--       planning), the versioned ASSET ref this destination publishes
--       (the source or one of the transformation outputs), the derived
--       deterministic idempotency key (cpd:<plan>:<destination> — the
--       at-most-once identity toward the 056 ledger), the unique
--       (plan, account, target format) fence and the destination outcome
--       pointer (planned → the frozen outcome vocabulary; a re-dispatch
--       re-evaluates and may move the pointer — never back to 'planned';
--       identity + request immutable; no DELETE).
--   distribution_publications
--     → the per-destination PUBLICATION records: the 056 idempotency-ledger
--       anchor (the social_publish_attempts read-only FK + same-Client
--       trigger), the submit-time publish state mirror (the 056 frozen
--       vocabulary), the provider refs, the duplicate flag of the recorded
--       submit and the failure taxonomy code — ONE row per destination
--       (the unique fence), INSERT-only (append-only trigger; the live
--       publication truth stays the 056 ledger, this row records the
--       submit-time link).
--   distribution_events
--     → the FULLY APPEND-ONLY historical lineage tail (the 047/052/053
--       pattern): one immutable row per recorded fact with the gapless
--       per-plan sequence — planning, gate evaluations (the 063 verdicts
--       WITH reasons), capability resolutions (the per-platform
--       validation verdicts with reasons), policy evaluations (the
--       dispatch gate decisions), publication attempts (the 056 attempt
--       results with provider refs), dispatch completion and measurement
--       references — each with the FULL structured payload and
--       server-derived provenance. UPDATE and DELETE are rejected
--       outright: the lineage is historical, append-only, never rewritten.
--
-- Frozen semantics encoded here (FROZEN — never a caller freedom):
--
-- * THE PLAN LIFECYCLE (cpd-vocab-v1): 'planned' (born), 'dispatching'
--   (a dispatch execution in flight), 'dispatched' (the dispatch
--   completed — re-dispatch re-enters 'dispatching', the idempotent
--   convergence discipline). Identity columns never move; every
--   sanctioned move advances the CAS version.
-- * THE DESTINATION OUTCOME VOCABULARY: 'planned' (born) |
--   'rights_review_required' | 'rights_blocked' (the 063 gate verdicts —
--   fail-closed, NEVER published) | 'capability_rejected' (the
--   per-platform capability validation failed — never attempted blind) |
--   'policy_blocked' (the dispatch policy gate denied/unknown) |
--   'publishing' (the 056 attempt stayed 'submitted' — UNKNOWN, pending
--   reconciliation, never blindly replayed) | 'published' | 'accepted' |
--   'failed' | 'restricted' (the 056 terminal attempt states). The
--   pointer never returns to 'planned'; every sanctioned move advances
--   the CAS version.
-- * THE EVENT-KIND VOCABULARY: 'plan_created' | 'dispatch_started' |
--   'gate_evaluation' | 'capability_resolution' | 'policy_evaluation' |
--   'publication_attempt' | 'dispatch_completed' |
--   'measurement_reference'.
-- * THE PUBLISH-STATE MIRROR: the 056 frozen vocabulary
--   (submitted/accepted/published/failed/restricted) + the 056 failure
--   taxonomy codes CHECK-fenced on the publication rows.
-- * THE REF GRAMMARS: asset refs are the 064-minted 'ca:' refs (the
--   interop grammar, mirrored from migration 053); the derived
--   idempotency keys follow the 056 grammar.
-- * DETERMINISM: the module consumes NO /ai-runtime surface (the frozen
--   row lists none); planning digests are canonical and deterministic.
-- * PROVENANCE IS SERVER-DERIVED (implementation-contract §3):
--   recorded_actor, recorded_via, correlation_id, causation_id and
--   recorded_at are written exclusively by server code — there is no
--   request DTO path to them (route validation rejects
--   provenance-shaped authority fields AND outcome authority fields).
-- * CLIENT OWNERSHIP (TEN-003 hard boundary): client_id is NOT NULL on
--   every row; the referenced social account must belong to the SAME
--   Client (trigger); the referenced publish attempt must belong to the
--   SAME Client (trigger); the optional mission must belong to the SAME
--   Agency as the Client (trigger); the optional workspace must belong to
--   the Client (trigger).
-- * NO PROVIDER STATE: no provider endpoint, token or SDK-shaped columns
--   — the physical publish flows EXCLUSIVELY through the 056
--   submitPublish contract (no second engine).
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, append-oriented tails, database-enforced vocabularies. No
-- owner/role/user columns beyond provenance: agency-scope authorization
-- stays exactly at the route layer — no second tenant, permission or
-- identity authority.

-- ---------------------------------------------------------------------------
-- distribution_plans — the plan records (the §5 chain head)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS distribution_plans (
    plan_id                uuid        PRIMARY KEY,
    -- TENANT: every plan belongs to exactly one Client (the agency is the
    -- client's owning chain, denormalized for the scope fence).
    agency_id              uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id              uuid        NOT NULL REFERENCES clients(client_id),
    -- Optional Workspace scope INSIDE the owning Client.
    workspace_id           uuid        REFERENCES workspaces(workspace_id),
    -- THE MISSION ANCHOR (read-only): the /growth-missions record this plan
    -- serves, if any. The mission authority stays sole for mission
    -- identity/lifecycle — nothing in this module ever mutates it.
    mission_id             uuid        REFERENCES growth_missions(mission_id),
    -- THE SOURCE ASSET: the opaque 064 'ca:' ref + the resolved EXPLICIT
    -- version id (never a floating pointer — the module resolved the ref
    -- through /content-assets before any write).
    source_asset_ref       text        NOT NULL
                           CHECK (source_asset_ref ~ '^ca:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    source_version_id      uuid        NOT NULL,
    -- THE TRANSFORMATION PLAN: the bounded declared mapping to versioned
    -- derived outputs (an object, always — the declared intent recorded
    -- verbatim; every referenced output resolved through /content-assets
    -- at planning time).
    transformation_plan    jsonb       NOT NULL
                           CHECK (jsonb_typeof(transformation_plan) = 'object'),
    -- The plan lifecycle pointer (cpd-vocab-v1).
    plan_state             text        NOT NULL
                           CHECK (plan_state IN ('planned', 'dispatching', 'dispatched')),
    -- The canonical deterministic digest of the plan declaration (same
    -- inputs produce the same digest — the planning reproducibility
    -- anchor).
    input_digest           text        NOT NULL
                           CHECK (length(input_digest) >= 16
                                  AND length(input_digest) <= 512),
    -- SERVER-DERIVED provenance (never request fields).
    recorded_actor         text        NOT NULL
                           CHECK (length(recorded_actor) >= 1
                                  AND length(recorded_actor) <= 100),
    recorded_via           text        NOT NULL
                           CHECK (length(recorded_via) >= 1
                                  AND length(recorded_via) <= 100),
    correlation_id         text        NOT NULL
                           CHECK (length(correlation_id) >= 1
                                  AND length(correlation_id) <= 100),
    causation_id           text
                           CHECK (causation_id IS NULL
                                  OR (length(causation_id) >= 1
                                      AND length(causation_id) <= 100)),
    recorded_at            timestamptz NOT NULL DEFAULT now(),
    -- The CAS token (every sanctioned move advances it).
    version                integer     NOT NULL CHECK (version >= 1),
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS distribution_plans_client_idx
    ON distribution_plans (client_id, created_at DESC, plan_id);

CREATE INDEX IF NOT EXISTS distribution_plans_mission_idx
    ON distribution_plans (mission_id, created_at, plan_id);

-- TENANT FENCE (the migration 051/053/054 pattern): the optional mission
-- must belong to the SAME Agency as the Client; the optional workspace
-- must belong to the Client — the scope chain cannot be crossed even by a
-- direct SQL writer.
CREATE OR REPLACE FUNCTION distribution_plans_scope_chain_consistent() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM clients c
        WHERE c.client_id = NEW.client_id
          AND c.agency_id = NEW.agency_id) THEN
        RAISE EXCEPTION 'distribution plan % references client % of another agency — the tenant scope chain cannot be crossed',
            NEW.plan_id, NEW.client_id;
    END IF;
    IF NEW.mission_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM growth_missions m, clients c
        WHERE m.mission_id = NEW.mission_id
          AND c.client_id = NEW.client_id
          AND m.agency_id = c.agency_id) THEN
        RAISE EXCEPTION 'distribution plan % references mission % of another agency — the mission anchor cannot be crossed',
            NEW.plan_id, NEW.mission_id;
    END IF;
    IF NEW.workspace_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workspaces w
        WHERE w.workspace_id = NEW.workspace_id AND w.client_id = NEW.client_id) THEN
        RAISE EXCEPTION 'distribution plan % workspace % does not belong to client % — the tenant scope chain cannot be crossed',
            NEW.plan_id, NEW.workspace_id, NEW.client_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS distribution_plans_scope_chain_trigger ON distribution_plans;
CREATE TRIGGER distribution_plans_scope_chain_trigger
    BEFORE INSERT OR UPDATE OF client_id, agency_id, workspace_id, mission_id ON distribution_plans
    FOR EACH ROW EXECUTE FUNCTION distribution_plans_scope_chain_consistent();

-- NO DELETE (planned facts are never erased — the audit trail stays).
CREATE OR REPLACE FUNCTION distribution_plans_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'distribution plan % cannot be deleted (distribution history is append-oriented — recorded plans are never erased)',
        OLD.plan_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS distribution_plans_no_delete_trigger ON distribution_plans;
CREATE TRIGGER distribution_plans_no_delete_trigger
    BEFORE DELETE ON distribution_plans
    FOR EACH ROW EXECUTE FUNCTION distribution_plans_no_delete();

-- THE DISCIPLINED PLAN MOVES: identity columns are immutable; the
-- lifecycle pointer moves ONLY along planned → dispatching → dispatched
-- and dispatched → dispatching (the idempotent re-dispatch); a state move
-- advances the CAS version (the 053 pattern: the trigger guards EVERY
-- update, the CAS demand applies to the state move itself).
CREATE OR REPLACE FUNCTION distribution_plans_disciplined_move() RETURNS trigger AS $$
BEGIN
    IF NEW.plan_id <> OLD.plan_id
        OR NEW.client_id <> OLD.client_id
        OR NEW.agency_id <> OLD.agency_id
        OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
        OR NEW.mission_id IS DISTINCT FROM OLD.mission_id
        OR NEW.source_asset_ref <> OLD.source_asset_ref
        OR NEW.source_version_id <> OLD.source_version_id
        OR NEW.transformation_plan <> OLD.transformation_plan
        OR NEW.input_digest <> OLD.input_digest
        OR NEW.recorded_actor <> OLD.recorded_actor
        OR NEW.recorded_via <> OLD.recorded_via
        OR NEW.correlation_id <> OLD.correlation_id
        OR NEW.causation_id IS DISTINCT FROM OLD.causation_id
        OR NEW.recorded_at <> OLD.recorded_at THEN
        RAISE EXCEPTION 'distribution plan % identity and provenance columns are immutable (a corrected plan is a NEW plan)',
            OLD.plan_id;
    END IF;
    IF NEW.plan_state <> OLD.plan_state THEN
        IF NOT (
            (OLD.plan_state = 'planned' AND NEW.plan_state = 'dispatching')
            OR (OLD.plan_state = 'dispatching' AND NEW.plan_state = 'dispatched')
            OR (OLD.plan_state = 'dispatched' AND NEW.plan_state = 'dispatching')
        ) THEN
            RAISE EXCEPTION 'distribution plan % illegal lifecycle move % → % (legal: planned → dispatching → dispatched; dispatched → dispatching on re-dispatch)',
                OLD.plan_id, OLD.plan_state, NEW.plan_state;
        END IF;
        IF NEW.version <> OLD.version + 1 THEN
            RAISE EXCEPTION 'the distribution plan state move must advance the CAS version (plan %)',
                OLD.plan_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS distribution_plans_disciplined_trigger ON distribution_plans;
CREATE TRIGGER distribution_plans_disciplined_trigger
    BEFORE UPDATE ON distribution_plans
    FOR EACH ROW EXECUTE FUNCTION distribution_plans_disciplined_move();

-- ---------------------------------------------------------------------------
-- distribution_destinations — the per-destination variant rows
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS distribution_destinations (
    destination_id         uuid        PRIMARY KEY,
    plan_id                uuid        NOT NULL REFERENCES distribution_plans(plan_id),
    -- TENANT (denormalized for the same-Client fences).
    client_id              uuid        NOT NULL REFERENCES clients(client_id),
    -- The fan-out order (one-based, unique per plan).
    position               integer     NOT NULL CHECK (position >= 1),
    -- THE TARGET ACCOUNT (read-only FK anchor): the /social-accounts
    -- binding this destination publishes through.
    social_account_id      uuid        NOT NULL REFERENCES social_accounts(social_account_id),
    -- The destination platform id (the account's adapter key, frozen at
    -- planning — carried as data; platform rules live behind the adapter
    -- plane).
    platform_id            text        NOT NULL
                           CHECK (platform_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
    -- The versioned asset ref this destination publishes (the source or
    -- one of the declared transformation outputs) + the resolved explicit
    -- version anchor.
    asset_ref              text        NOT NULL
                           CHECK (asset_ref ~ '^ca:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    asset_version_id       uuid        NOT NULL,
    -- THE TARGET FORMAT (the destination-specific format label).
    target_format          text        NOT NULL
                           CHECK (length(target_format) >= 1 AND length(target_format) <= 64),
    -- The destination-specific publish request (the 056 shape, frozen at
    -- planning — an object, always).
    publish_request        jsonb       NOT NULL
                           CHECK (jsonb_typeof(publish_request) = 'object'),
    -- The derived deterministic idempotency key (cpd:<plan>:<destination>
    -- — the at-most-once identity toward the 056 ledger; grammar mirrors
    -- migration 050).
    idempotency_key        text        NOT NULL
                           CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    -- The destination outcome pointer (cpd-vocab-v1).
    destination_status     text        NOT NULL
                           CHECK (destination_status IN
                                  ('planned',
                                   'rights_review_required', 'rights_blocked',
                                   'capability_rejected', 'policy_blocked',
                                   'publishing', 'published', 'accepted',
                                   'failed', 'restricted')),
    -- SERVER-DERIVED provenance (never request fields).
    recorded_actor         text        NOT NULL
                           CHECK (length(recorded_actor) >= 1
                                  AND length(recorded_actor) <= 100),
    recorded_via           text        NOT NULL
                           CHECK (length(recorded_via) >= 1
                                  AND length(recorded_via) <= 100),
    correlation_id         text        NOT NULL
                           CHECK (length(correlation_id) >= 1
                                  AND length(correlation_id) <= 100),
    causation_id           text
                           CHECK (causation_id IS NULL
                                  OR (length(causation_id) >= 1
                                      AND length(causation_id) <= 100)),
    recorded_at            timestamptz NOT NULL DEFAULT now(),
    version                integer     NOT NULL CHECK (version >= 1),
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    -- The fan-out fences: the position is unique per plan; one variant per
    -- (plan, account, target format) — a planning duplicate is refused;
    -- the derived key is globally unique (the direct-SQL backstop of the
    -- at-most-once identity).
    CONSTRAINT distribution_destinations_position_fence UNIQUE (plan_id, position),
    CONSTRAINT distribution_destinations_variant_fence UNIQUE (plan_id, social_account_id, target_format),
    CONSTRAINT distribution_destinations_key_fence UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS distribution_destinations_plan_idx
    ON distribution_destinations (plan_id, position, destination_id);

CREATE INDEX IF NOT EXISTS distribution_destinations_account_idx
    ON distribution_destinations (social_account_id, created_at, destination_id);

-- TENANT FENCE: the referenced social account must belong to the SAME
-- Client and the destination's client must equal the plan's.
CREATE OR REPLACE FUNCTION distribution_destinations_scope_consistent() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM social_accounts s
        WHERE s.social_account_id = NEW.social_account_id
          AND s.client_id = NEW.client_id) THEN
        RAISE EXCEPTION 'distribution destination % references social account % of another client — cross-tenant destination linkage is rejected',
            NEW.destination_id, NEW.social_account_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM distribution_plans p
        WHERE p.plan_id = NEW.plan_id
          AND p.client_id = NEW.client_id) THEN
        RAISE EXCEPTION 'distribution destination % references plan % of another client — the scope chain cannot be crossed',
            NEW.destination_id, NEW.plan_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS distribution_destinations_scope_trigger ON distribution_destinations;
CREATE TRIGGER distribution_destinations_scope_trigger
    BEFORE INSERT OR UPDATE OF client_id, plan_id, social_account_id ON distribution_destinations
    FOR EACH ROW EXECUTE FUNCTION distribution_destinations_scope_consistent();

-- NO DELETE (destination declarations are never erased).
CREATE OR REPLACE FUNCTION distribution_destinations_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'distribution destination % cannot be deleted (distribution history is append-oriented — recorded destinations are never erased)',
        OLD.destination_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS distribution_destinations_no_delete_trigger ON distribution_destinations;
CREATE TRIGGER distribution_destinations_no_delete_trigger
    BEFORE DELETE ON distribution_destinations
    FOR EACH ROW EXECUTE FUNCTION distribution_destinations_no_delete();

-- THE DISCIPLINED DESTINATION MOVES: identity + request columns are
-- immutable; the outcome pointer moves only along the re-evaluation
-- discipline (never back to the born 'planned' state; the 056 terminal
-- states may be re-entered by a re-dispatch's recorded outcome); a
-- status move advances the CAS version (the 053 pattern: the trigger
-- guards EVERY update).
CREATE OR REPLACE FUNCTION distribution_destinations_disciplined_move() RETURNS trigger AS $$
BEGIN
    IF NEW.destination_id <> OLD.destination_id
        OR NEW.plan_id <> OLD.plan_id
        OR NEW.client_id <> OLD.client_id
        OR NEW.position <> OLD.position
        OR NEW.social_account_id <> OLD.social_account_id
        OR NEW.platform_id <> OLD.platform_id
        OR NEW.asset_ref <> OLD.asset_ref
        OR NEW.asset_version_id <> OLD.asset_version_id
        OR NEW.target_format <> OLD.target_format
        OR NEW.publish_request <> OLD.publish_request
        OR NEW.idempotency_key <> OLD.idempotency_key
        OR NEW.recorded_actor <> OLD.recorded_actor
        OR NEW.recorded_via <> OLD.recorded_via
        OR NEW.correlation_id <> OLD.correlation_id
        OR NEW.causation_id IS DISTINCT FROM OLD.causation_id
        OR NEW.recorded_at <> OLD.recorded_at THEN
        RAISE EXCEPTION 'distribution destination % identity and request columns are immutable (a corrected destination is a NEW plan)',
            OLD.destination_id;
    END IF;
    IF NEW.destination_status <> OLD.destination_status THEN
        IF NEW.destination_status = 'planned' THEN
            RAISE EXCEPTION 'distribution destination % illegal outcome move % → planned (the born state is never re-entered)',
                OLD.destination_id, OLD.destination_status;
        END IF;
        IF NEW.version <> OLD.version + 1 THEN
            RAISE EXCEPTION 'the distribution destination outcome move must advance the CAS version (destination %)',
                OLD.destination_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS distribution_destinations_disciplined_trigger ON distribution_destinations;
CREATE TRIGGER distribution_destinations_disciplined_trigger
    BEFORE UPDATE ON distribution_destinations
    FOR EACH ROW EXECUTE FUNCTION distribution_destinations_disciplined_move();

-- ---------------------------------------------------------------------------
-- distribution_publications — the per-destination publication records
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS distribution_publications (
    publication_id         uuid        PRIMARY KEY,
    plan_id                uuid        NOT NULL REFERENCES distribution_plans(plan_id),
    destination_id         uuid        NOT NULL REFERENCES distribution_destinations(destination_id),
    -- TENANT (denormalized for the same-Client fences).
    client_id              uuid        NOT NULL REFERENCES clients(client_id),
    -- THE TARGET ACCOUNT (read-only FK anchor).
    social_account_id      uuid        NOT NULL REFERENCES social_accounts(social_account_id),
    -- THE 056 IDEMPOTENCY-LEDGER ANCHOR (read-only FK): the
    -- social_publish_attempts row the submit claimed. The ledger stays the
    -- live publication truth; this row records the submit-time link.
    publish_attempt_id     uuid        NOT NULL REFERENCES social_publish_attempts(attempt_id),
    idempotency_key        text        NOT NULL
                           CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    -- The submit-time publish-state mirror (the 056 frozen vocabulary).
    publish_state          text        NOT NULL
                           CHECK (publish_state IN
                                  ('submitted', 'accepted', 'published', 'failed', 'restricted')),
    -- The 056 failure taxonomy code (required exactly on 'failed' states).
    failure_code           text
                           CHECK (failure_code IS NULL OR failure_code IN
                                  ('auth-expired', 'rate-limited', 'restricted',
                                   'policy-denied', 'provider-unavailable',
                                   'unsupported-capability', 'insufficient-scope')),
    CONSTRAINT distribution_publications_failure_shape CHECK
        (publish_state = 'failed' OR failure_code IS NULL),
    provider_publish_id    text
                           CHECK (provider_publish_id IS NULL
                                  OR (length(provider_publish_id) >= 1
                                      AND length(provider_publish_id) <= 128)),
    provider_content_id    text
                           CHECK (provider_content_id IS NULL
                                  OR (length(provider_content_id) >= 1
                                      AND length(provider_content_id) <= 128)),
    published_at           timestamptz,
    -- True when the recorded submit was answered from the 056 fence (the
    -- idempotent replay — zero provider traffic).
    duplicate              boolean     NOT NULL,
    -- SERVER-DERIVED provenance (never request fields).
    recorded_actor         text        NOT NULL
                           CHECK (length(recorded_actor) >= 1
                                  AND length(recorded_actor) <= 100),
    recorded_via           text        NOT NULL
                           CHECK (length(recorded_via) >= 1
                                  AND length(recorded_via) <= 100),
    correlation_id         text        NOT NULL
                           CHECK (length(correlation_id) >= 1
                                  AND length(correlation_id) <= 100),
    causation_id           text
                           CHECK (causation_id IS NULL
                                  OR (length(causation_id) >= 1
                                      AND length(causation_id) <= 100)),
    recorded_at            timestamptz NOT NULL DEFAULT now()
);

-- ONE publication row per destination (the 1:1 link fence).
CREATE UNIQUE INDEX IF NOT EXISTS distribution_publications_destination_fence
    ON distribution_publications (destination_id);

CREATE INDEX IF NOT EXISTS distribution_publications_plan_idx
    ON distribution_publications (plan_id, destination_id);

CREATE INDEX IF NOT EXISTS distribution_publications_attempt_idx
    ON distribution_publications (publish_attempt_id);

-- TENANT FENCE: the referenced publish attempt and social account must
-- belong to the SAME Client as the destination.
CREATE OR REPLACE FUNCTION distribution_publications_scope_consistent() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM distribution_destinations d
        WHERE d.destination_id = NEW.destination_id
          AND d.client_id = NEW.client_id) THEN
        RAISE EXCEPTION 'distribution publication % references destination % of another client — the scope chain cannot be crossed',
            NEW.publication_id, NEW.destination_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM social_accounts s
        WHERE s.social_account_id = NEW.social_account_id
          AND s.client_id = NEW.client_id) THEN
        RAISE EXCEPTION 'distribution publication % references social account % of another client — the scope chain cannot be crossed',
            NEW.publication_id, NEW.social_account_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM social_publish_attempts a
        WHERE a.attempt_id = NEW.publish_attempt_id
          AND a.client_id = NEW.client_id) THEN
        RAISE EXCEPTION 'distribution publication % references publish attempt % of another client — cross-tenant publication linkage is rejected',
            NEW.publication_id, NEW.publish_attempt_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS distribution_publications_scope_trigger ON distribution_publications;
CREATE TRIGGER distribution_publications_scope_trigger
    BEFORE INSERT ON distribution_publications
    FOR EACH ROW EXECUTE FUNCTION distribution_publications_scope_consistent();

-- APPEND-ONLY PUBLICATION RECORDS: the database itself rejects UPDATE and
-- DELETE — the submit-time link is never rewritten (the live publication
-- truth stays the 056 ledger; a re-dispatch converges on the fence and
-- adds EVENTS, never rewrites the link row).
CREATE OR REPLACE FUNCTION distribution_publications_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'distribution publication % is append-only (the submit-time publication link is immutable — the live publish truth stays the 056 idempotency ledger)',
        OLD.publication_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS distribution_publications_append_only_trigger ON distribution_publications;
CREATE TRIGGER distribution_publications_append_only_trigger
    BEFORE UPDATE OR DELETE ON distribution_publications
    FOR EACH ROW EXECUTE FUNCTION distribution_publications_append_only();

-- ---------------------------------------------------------------------------
-- distribution_events — the fully append-only historical lineage tail
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS distribution_events (
    event_id               uuid        PRIMARY KEY,
    plan_id                uuid        NOT NULL REFERENCES distribution_plans(plan_id),
    -- NULL for plan-level events (plan_created, dispatch_started,
    -- dispatch_completed); set for destination-scoped events.
    destination_id         uuid        REFERENCES distribution_destinations(destination_id),
    client_id              uuid        NOT NULL REFERENCES clients(client_id),
    -- The gapless per-plan sequence (assigned under the plan row lock).
    event_seq              integer     NOT NULL CHECK (event_seq >= 1),
    -- The frozen event-kind vocabulary.
    event_kind             text        NOT NULL
                           CHECK (event_kind IN
                                  ('plan_created', 'dispatch_started',
                                   'gate_evaluation', 'capability_resolution',
                                   'policy_evaluation', 'publication_attempt',
                                   'dispatch_completed', 'measurement_reference')),
    -- The full structured payload (the gate verdict WITH reasons, the
    -- capability resolution WITH reasons, the policy decision, the 056
    -- attempt result WITH provider refs, the measurement reference) — an
    -- object, always.
    payload                jsonb       NOT NULL
                           CHECK (jsonb_typeof(payload) = 'object'),
    -- SERVER-DERIVED provenance (never request fields).
    recorded_actor         text        NOT NULL
                           CHECK (length(recorded_actor) >= 1
                                  AND length(recorded_actor) <= 100),
    recorded_via           text        NOT NULL
                           CHECK (length(recorded_via) >= 1
                                  AND length(recorded_via) <= 100),
    correlation_id         text        NOT NULL
                           CHECK (length(correlation_id) >= 1
                                  AND length(correlation_id) <= 100),
    causation_id           text
                           CHECK (causation_id IS NULL
                                  OR (length(causation_id) >= 1
                                      AND length(causation_id) <= 100)),
    recorded_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT distribution_events_sequence_fence UNIQUE (plan_id, event_seq)
);

CREATE INDEX IF NOT EXISTS distribution_events_plan_idx
    ON distribution_events (plan_id, event_seq, event_id);

-- EVENT-SHAPE FENCE: a destination-scoped event must reference a
-- destination of the SAME plan (the plan/destination chain cannot be
-- crossed even by a direct SQL writer).
CREATE OR REPLACE FUNCTION distribution_events_destination_shape() RETURNS trigger AS $$
BEGIN
    IF NEW.destination_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM distribution_destinations d
        WHERE d.destination_id = NEW.destination_id
          AND d.plan_id = NEW.plan_id) THEN
        RAISE EXCEPTION 'distribution event % references destination % of another plan — the event/destination chain cannot be crossed',
            NEW.event_id, NEW.destination_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS distribution_events_destination_shape_trigger ON distribution_events;
CREATE TRIGGER distribution_events_destination_shape_trigger
    BEFORE INSERT ON distribution_events
    FOR EACH ROW EXECUTE FUNCTION distribution_events_destination_shape();

-- APPEND-ONLY EVENT TAIL (the migration 047/052/053/054 pattern): the
-- database itself rejects UPDATE and DELETE on the lineage — not even
-- server code can rewrite what was planned, evaluated, attempted or
-- measured. Corrections and re-evaluations are NEW events.
CREATE OR REPLACE FUNCTION distribution_events_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'distribution event % (plan % seq %) is append-only (the distribution lineage is historical — planning, gate evaluations, capability resolutions, publication attempts, outcomes and measurement references are never rewritten)',
        OLD.event_id, OLD.plan_id, OLD.event_seq;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS distribution_events_append_only_trigger ON distribution_events;
CREATE TRIGGER distribution_events_append_only_trigger
    BEFORE UPDATE OR DELETE ON distribution_events
    FOR EACH ROW EXECUTE FUNCTION distribution_events_append_only();
