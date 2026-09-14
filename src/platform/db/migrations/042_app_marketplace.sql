-- 042_app_marketplace.sql — MKT-050 (App Marketplace, Trust and
-- Certification).
--
-- The marketplace/trust/certification surface over the MKT-047 /apps
-- registry: the DISCOVERY surface is a derived read over registry rows
-- (the marketplace NEVER becomes a second registry — no app catalog table
-- is created here); the TRUST LIFECYCLE is an APPEND-ONLY EVENT LEDGER
-- (mos-app-ecosystem-v1.5.md "Trust levels": UNVERIFIED →
-- COMMUNITY_VERIFIED → MOS_CERTIFIED — one-way arrows; "Trust level is
-- metadata and a policy input. It never grants authority by itself"); the
-- REVIEW metadata is an APPEND-ONLY record set attached at the app or
-- app-version level ("review data is display metadata" — never a policy
-- input unless a policy explicitly consumes it).
--
-- PostgreSQL is the system of record (spec/architecture-lock.md). The
-- registry's own certification_state column stays FROZEN AT BIRTH
-- (migration 037 rejects every UPDATE on app_versions — "trust
-- transitions arrive ONLY through the future platform marketplace/trust
-- surface, never by rewriting a published manifest row"): the CURRENT
-- trust state of an app lineage is DERIVED from the trust_events tail
-- (the to_state of the newest event; no events → the UNVERIFIED birth
-- state). A trust transition is NEVER a silent rewrite: every up/down
-- move is a NEW append-only event row with operator provenance.
--
-- Table ownership follows the MKT-050 contract: the /app-marketplace
-- module (this Work Item's authority) owns exactly these two tables:
--   trust_events  → the APPEND-ONLY trust transition ledger: one row per
--                   transition per app lineage, with the monotonic
--                   per-lineage transition_seq, the frozen from/to state
--                   vocabulary, the closed transition labels, the
--                   operator reason and the server-derived provenance;
--                   UPDATE and DELETE are rejected outright (even by
--                   direct SQL);
--   app_reviews   → the APPEND-ONLY review records: structured rating +
--                   verdict + body + reviewer provenance + timestamps,
--                   attached at the app level (app_version_id NULL) or
--                   at the exact app-version level (app_version_id set);
--                   UPDATE and DELETE are rejected outright.
--
-- Frozen semantics encoded here (FROZEN — never a caller freedom):
--
-- * THE FROZEN TRUST VOCABULARY (mos-app-ecosystem-v1.5.md "Trust
--   levels"; spec/frozen-manifest-v1.5.json certificationLevels):
--   from_state/to_state ∈ {UNVERIFIED, COMMUNITY_VERIFIED,
--   MOS_CERTIFIED} — CHECK-fenced on every row.
-- * THE ONE-WAY LADDER + THE DISCLOSED DOWN-TRANSITIONS: the up arrows
--   are exactly the frozen one-way ladder (verify: UNVERIFIED →
--   COMMUNITY_VERIFIED; certify: COMMUNITY_VERIFIED → MOS_CERTIFIED —
--   no skipping: UNVERIFIED → MOS_CERTIFIED is REJECTED). The DISCLOSED
--   down moves are revocations, never silent rewrites: decertify
--   (MOS_CERTIFIED → COMMUNITY_VERIFIED), revoke (COMMUNITY_VERIFIED →
--   UNVERIFIED or MOS_CERTIFIED → UNVERIFIED). Every legal (transition,
--   from_state, to_state) triple is CHECK-fenced; same-state and
--   illegal-skip transitions are structurally impossible.
-- * CHAIN CONSISTENCY (the event-sourced derivation fence): the first
--   event of a lineage (transition_seq 1) must depart from the registry
--   BIRTH state UNVERIFIED; every later event's from_state must equal
--   the to_state of its predecessor (trigger) — the derived CURRENT
--   state (newest to_state) can never disagree with the recorded tail.
-- * APP-LINEAGE EXISTENCE: every event/review references a PUBLISHED app
--   key (FK to the migration-037 apps ownership rows — the lineage exists
--   because at least one version was published; read CHECK-ONLY: no
--   registry row is ever created or mutated here).
-- * REVIEW VERSION CONSISTENCY: a version-level review's app_version_id
--   must belong to the SAME app key (trigger) — a review can never be
--   attached to another lineage's version.
-- * NO SECRET MATERIAL ANYWHERE (CRED-001 / §21): there is deliberately
--   NO jsonb column and NO free-form caller payload in either table —
--   every column is a bounded scalar with a CHECK fence; the review body
--   is bounded text with no material-shaped column name.
-- * NO AUTHORITY TRANSFER (architecture-lock v1.5 #7/#10/#13): trust is
--   METADATA and a policy input — it never grants authority by itself;
--   this migration creates NO install ledger (038 stays the sole install
--   authority), NO registry table (037 stays the sole app catalog), NO
--   metering/attribution table (MKT-052 territory — "Marketplace
--   attribution is separate from the core financial authority") and NO
--   policy table (025 stays the sole policy authority).
-- * SERVER-DERIVED PROVENANCE (implementation-contract §3): recorded
--   actor/via/correlation/causation columns are written only by the
--   module from the authenticated principal — never request fields (the
--   route DTOs reject provenance-shaped keys).
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, recorded_at timestamps, §8-style idempotency keys +
-- create fingerprints for logical-command convergence. No owner/role/user
-- columns beyond provenance: trust-transition authorization (the
-- platform operator/governance gate) and review authorization (the
-- active-member community gate) stay exactly at the /agencies membership
-- + platform-roles authorities resolved at the route layer — no second
-- tenant, permission or identity authority.

-- ---------------------------------------------------------------------------
-- trust_events — the append-only trust transition ledger
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS trust_events (
    event_id         uuid        PRIMARY KEY,
    -- The published app lineage this transition applies to (read
    -- CHECK-ONLY through the FK to the migration-037 ownership rows).
    app_key          text        NOT NULL REFERENCES apps(app_key),
    -- The monotonic per-lineage transition sequence (1 = the first
    -- recorded transition; the derived CURRENT state is the to_state of
    -- the highest seq). Concurrent writers of the same next seq converge
    -- to exactly one winner (UNIQUE fence).
    transition_seq   integer     NOT NULL CHECK (transition_seq >= 1),
    -- The closed transition-label vocabulary: the two frozen one-way up
    -- arrows (verify, certify) + the three DISCLOSED down moves
    -- (decertify, revoke — the revocation family).
    transition       text        NOT NULL
                     CHECK (transition IN ('verify', 'certify', 'decertify', 'revoke')),
    -- The frozen trust vocabulary (CHECK-fenced on BOTH states).
    from_state       text        NOT NULL
                     CHECK (from_state IN ('UNVERIFIED', 'COMMUNITY_VERIFIED', 'MOS_CERTIFIED')),
    to_state         text        NOT NULL
                     CHECK (to_state IN ('UNVERIFIED', 'COMMUNITY_VERIFIED', 'MOS_CERTIFIED')),
    -- The operator's recorded reason (bounded — part of the permanent
    -- governance record).
    reason           text        NOT NULL
                     CHECK (length(reason) >= 1 AND length(reason) <= 512),
    -- SERVER-DERIVED provenance (never a request field).
    recorded_actor   text        NOT NULL
                     CHECK (length(recorded_actor) >= 1 AND length(recorded_actor) <= 100),
    recorded_via     text        NOT NULL
                     CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 100),
    correlation_id   text        NOT NULL,
    causation_id     text,
    recorded_at      timestamptz NOT NULL DEFAULT now(),
    -- The §8-style logical command identity + create fingerprint
    -- (convergence proof: one logical transition command; a key reused
    -- for different content is a conflict).
    idempotency_key  text        NOT NULL
                     CHECK (length(idempotency_key) >= 1 AND length(idempotency_key) <= 200),
    create_fingerprint text      NOT NULL
                     CHECK (length(create_fingerprint) >= 1 AND length(create_fingerprint) <= 128),
    -- THE frozen transition-triple fence: exactly the legal (label,
    -- from, to) moves. The up ladder is the spec's one-way arrows with NO
    -- skipping; the down moves are the DISCLOSED revocations. A
    -- same-state "transition" is structurally impossible.
    CONSTRAINT trust_events_triple_legal CHECK (
        (transition = 'verify' AND from_state = 'UNVERIFIED'
             AND to_state = 'COMMUNITY_VERIFIED')
        OR (transition = 'certify' AND from_state = 'COMMUNITY_VERIFIED'
             AND to_state = 'MOS_CERTIFIED')
        OR (transition = 'decertify' AND from_state = 'MOS_CERTIFIED'
             AND to_state = 'COMMUNITY_VERIFIED')
        OR (transition = 'revoke' AND from_state = 'COMMUNITY_VERIFIED'
             AND to_state = 'UNVERIFIED')
        OR (transition = 'revoke' AND from_state = 'MOS_CERTIFIED'
             AND to_state = 'UNVERIFIED')
    ),
    -- Each transition sequence of a lineage is assigned exactly once.
    CONSTRAINT trust_events_seq_unique UNIQUE (app_key, transition_seq)
);

-- The §8 command fence: one logical transition command, globally.
CREATE UNIQUE INDEX IF NOT EXISTS trust_events_idempotency_key_unique
    ON trust_events (idempotency_key);

-- Listing surfaces: the per-lineage tail (derivation + display) and the
-- governance audit trail (newest first).
CREATE INDEX IF NOT EXISTS trust_events_lineage_idx
    ON trust_events (app_key, transition_seq);
CREATE INDEX IF NOT EXISTS trust_events_recorded_idx
    ON trust_events (recorded_at DESC, event_id);

-- CHAIN CONSISTENCY (the event-sourced derivation fence): the first
-- event of a lineage departs from the registry BIRTH state (UNVERIFIED —
-- every published App Version is born UNVERIFIED and the registry row is
-- frozen); every later event departs from its predecessor's to_state.
-- The derived CURRENT state (the newest to_state) can never disagree
-- with the recorded tail, even by direct SQL.
CREATE OR REPLACE FUNCTION trust_events_chain_consistent() RETURNS trigger AS $$
DECLARE
    v_prior_to text;
BEGIN
    IF NEW.transition_seq = 1 THEN
        IF NEW.from_state <> 'UNVERIFIED' THEN
            RAISE EXCEPTION 'trust event % is the first transition of app % and must depart from the UNVERIFIED birth state, not %',
                NEW.event_id, NEW.app_key, NEW.from_state;
        END IF;
        RETURN NEW;
    END IF;
    SELECT to_state INTO v_prior_to FROM trust_events
        WHERE app_key = NEW.app_key AND transition_seq = NEW.transition_seq - 1;
    IF v_prior_to IS NULL THEN
        RAISE EXCEPTION 'trust event % is transition seq % of app % but the predecessor seq is missing (the tail must be gapless)',
            NEW.event_id, NEW.transition_seq, NEW.app_key;
    END IF;
    IF v_prior_to <> NEW.from_state THEN
        RAISE EXCEPTION 'trust event % departs from % but app % is at % (the from_state must equal the predecessor''s to_state — transitions are append-only events, never rewrites)',
            NEW.event_id, NEW.from_state, NEW.app_key, v_prior_to;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trust_events_chain_trigger ON trust_events;
CREATE TRIGGER trust_events_chain_trigger
    BEFORE INSERT ON trust_events
    FOR EACH ROW EXECUTE FUNCTION trust_events_chain_consistent();

-- APPEND-ONLY GOVERNANCE HISTORY (the migration 036/038 event-tail
-- pattern): the database itself rejects UPDATE and DELETE on the trust
-- ledger — a trust transition is NEVER a silent rewrite; corrections and
-- revocations are NEW event rows.
CREATE OR REPLACE FUNCTION trust_events_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'trust events are append-only: % is rejected on event % (trust transitions are recorded events, never rewrites)',
        TG_OP, OLD.event_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trust_events_append_only_update_trigger ON trust_events;
CREATE TRIGGER trust_events_append_only_update_trigger
    BEFORE UPDATE ON trust_events
    FOR EACH ROW EXECUTE FUNCTION trust_events_append_only();

DROP TRIGGER IF EXISTS trust_events_append_only_delete_trigger ON trust_events;
CREATE TRIGGER trust_events_append_only_delete_trigger
    BEFORE DELETE ON trust_events
    FOR EACH ROW EXECUTE FUNCTION trust_events_append_only();

-- ---------------------------------------------------------------------------
-- app_reviews — the append-only review records
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS app_reviews (
    review_id        uuid        PRIMARY KEY,
    -- The published app lineage this review is attached to (app-level
    -- when app_version_id is NULL; exact-version-level otherwise).
    app_key          text        NOT NULL REFERENCES apps(app_key),
    -- OPTIONAL: the EXACT registry version row this review targets (the
    -- trigger below re-fences that it belongs to the SAME app key).
    app_version_id   uuid        REFERENCES app_versions(app_version_id),
    -- The structured rating (1..5 — the closed integer band).
    rating           integer     NOT NULL CHECK (rating >= 1 AND rating <= 5),
    -- The closed structured-verdict vocabulary.
    verdict          text        NOT NULL CHECK (verdict IN ('positive', 'mixed', 'negative')),
    -- The bounded review body (display metadata — no authority fields,
    -- no material columns anywhere in this table).
    body             text        NOT NULL
                     CHECK (length(body) >= 1 AND length(body) <= 2000),
    -- SERVER-DERIVED reviewer provenance (never a request field).
    recorded_actor   text        NOT NULL
                     CHECK (length(recorded_actor) >= 1 AND length(recorded_actor) <= 100),
    recorded_via     text        NOT NULL
                     CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 100),
    correlation_id   text        NOT NULL,
    causation_id     text,
    recorded_at      timestamptz NOT NULL DEFAULT now(),
    -- The §8-style logical command identity + create fingerprint.
    idempotency_key  text        NOT NULL
                     CHECK (length(idempotency_key) >= 1 AND length(idempotency_key) <= 200),
    create_fingerprint text      NOT NULL
                     CHECK (length(create_fingerprint) >= 1 AND length(create_fingerprint) <= 128)
);

-- The §8 command fence: one logical review command, globally.
CREATE UNIQUE INDEX IF NOT EXISTS app_reviews_idempotency_key_unique
    ON app_reviews (idempotency_key);

-- Listing surfaces: the per-lineage review tail (newest first) and the
-- per-version slice.
CREATE INDEX IF NOT EXISTS app_reviews_lineage_idx
    ON app_reviews (app_key, recorded_at DESC, review_id);
CREATE INDEX IF NOT EXISTS app_reviews_version_idx
    ON app_reviews (app_version_id) WHERE app_version_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS app_reviews_actor_idx
    ON app_reviews (recorded_actor, recorded_at DESC);

-- REVIEW VERSION CONSISTENCY: a version-level review's target must be a
-- published version of the SAME app key (read CHECK-ONLY — no registry
-- row is ever created or mutated here).
CREATE OR REPLACE FUNCTION app_reviews_version_consistent() RETURNS trigger AS $$
DECLARE
    v_app_key text;
BEGIN
    IF NEW.app_version_id IS NULL THEN RETURN NEW; END IF;
    SELECT app_key INTO v_app_key FROM app_versions
        WHERE app_version_id = NEW.app_version_id;
    IF v_app_key IS NULL THEN
        RAISE EXCEPTION 'review % references an unknown app version %',
            NEW.review_id, NEW.app_version_id;
    END IF;
    IF v_app_key <> NEW.app_key THEN
        RAISE EXCEPTION 'review % targets app % but version % belongs to app % — a review can never attach to another lineage''s version',
            NEW.review_id, NEW.app_key, NEW.app_version_id, v_app_key;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS app_reviews_version_consistent_trigger ON app_reviews;
CREATE TRIGGER app_reviews_version_consistent_trigger
    BEFORE INSERT ON app_reviews
    FOR EACH ROW EXECUTE FUNCTION app_reviews_version_consistent();

-- APPEND-ONLY REVIEW HISTORY (the migration 038 event-tail pattern): the
-- database itself rejects UPDATE and DELETE on the review records —
-- reviews are display metadata with permanent history; corrections are
-- NEW review rows, never rewrites.
CREATE OR REPLACE FUNCTION app_reviews_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'app reviews are append-only: % is rejected on review % (review history is never rewritten)',
        TG_OP, OLD.review_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS app_reviews_append_only_update_trigger ON app_reviews;
CREATE TRIGGER app_reviews_append_only_update_trigger
    BEFORE UPDATE ON app_reviews
    FOR EACH ROW EXECUTE FUNCTION app_reviews_append_only();

DROP TRIGGER IF EXISTS app_reviews_append_only_delete_trigger ON app_reviews;
CREATE TRIGGER app_reviews_append_only_delete_trigger
    BEFORE DELETE ON app_reviews
    FOR EACH ROW EXECUTE FUNCTION app_reviews_append_only();
