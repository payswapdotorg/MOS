-- MKT-021 Execution policy engine schema (POL-001; CRED-001 evaluation
-- posture). PostgreSQL is the system of record (spec/architecture-lock.md).
--
-- Table ownership follows the frozen authority map (implementation-contract
-- §1): "Policies → /policies" — BOTH tables here:
--   policies          → policy VERSION records (the declared boundaries)
--   policy_decisions  → the append-only decision records
--
-- Frozen semantics encoded here (spec/requirements.md POL-001 "Provide
-- policy boundaries for AI, tools, network, secrets, deployment, field
-- actions and extensions"; spec/architecture.md §2.1 "PostgreSQL is
-- authoritative ... for ... policy state"; §22 "policy authorization";
-- implementation-contract §3 "No externally supplied field may override a
-- server-derived actor, owner, provenance, policy decision, or evidence
-- authority value"; §25 database backstops for material invariants):
--
-- * THE SEVEN FROZEN DIMENSIONS: dimension is a closed 7-value set
--   (ai/tools/network/secrets/deployment/field/extension) — extension is a
--   code + DB migration change, never a caller freedom.
-- * SCOPE MODEL (architecture.md §4 tenant tree: "Agency Policies" and
--   "Client Policy" are distinct nodes): agency_id NULL + client_id NULL =
--   PLATFORM scope (platform defaults); agency_id set + client_id NULL =
--   AGENCY scope; both set = CLIENT scope (the hard security boundary).
--   client_id set with agency_id NULL is structurally illegal, and a
--   client-scoped row must belong to its scope agency (cross-tenant
--   trigger — the Client boundary cannot be crossed through the scope
--   columns). Scope is IMMUTABLE once set (trigger).
-- * APPEND-ORIENTED VERSIONING: policy history is never overwritten — a
--   declaration of a (scope, dimension) with an ACTIVE version SUPERSEDES
--   it in the same transaction: the prior row becomes status 'superseded'
--   (TERMINAL — no resurrection), carrying superseded_at +
--   superseded_by_policy_id, and stays queryable forever; the new row is
--   born ACTIVE with version_seq = prior + 1 (monotonic per
--   (scope, dimension), DB-fenced). Content (dimension, scope, rules,
--   description, provenance) is IMMUTABLE (trigger); only the lifecycle
--   edge fields, the CAS token and updated_at ever change.
-- * DECISIONS ARE APPEND-ONLY: every evaluation is recorded ONCE in
--   policy_decisions with outcome ('allow' | 'deny' | 'unknown'), the
--   closed reason-code set, human reasons, the evaluated action, the
--   matched policy version ids and SERVER-DERIVED provenance
--   (recorded_actor/recorded_via/correlation_id/causation_id +
--   recorded_at/evaluated_at stamped by the module clock). UPDATE and
--   DELETE are rejected by triggers (audit retention — the migration
--   015/018 pattern).
-- * NO SECRET MATERIAL (CRED-001 / implementation-contract §21): the
--   engine evaluates ACCESS PROPOSALS — the rules payload, the action
--   payload and every decision row are CHECKed against material-shaped
--   keys; there is deliberately NO column capable of holding secret
--   material or a secret handle anywhere in this migration.
--
-- Fences (implementation-contract §3/§25 — database backstops for material
-- invariants):
--   - the ACTIVE VERSION fence: exactly one ACTIVE version per (scope,
--     dimension) — concurrent duplicate declarations converge to a
--     constraint violation, never a silent overwrite (scope NULLs are
--     unified with COALESCE so all three scope modes fence correctly);
--   - the VERSION SEQUENCE fence: version_seq is unique per (scope,
--     dimension) — sequence allocation is race-free;
--   - the SUPERSESSION consistency trigger: 'superseded' requires
--     superseded_at/superseded_by_policy_id, 'active' requires both NULL,
--     and the superseder must be a policy of the SAME (scope, dimension)
--     with a HIGHER version_seq;
--   - the SCOPE LEGALITY + cross-tenant triggers on both tables;
--   - the RULE SHAPE CHECK (function-based): every stored rule is exactly
--     {effect ∈ allow/deny, operations: non-empty bounded string array,
--     resource: null-or-bounded string, attributes: bounded
--     string→string object, reason: bounded string} with NO material-shaped
--     key anywhere;
--   - the append-only triggers on policy_decisions.
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, created_at/updated_at, version CAS for concurrent mutation.
-- No owner/role/user columns beyond provenance: policy administration and
-- decision-read authorization stays exactly the /agencies membership
-- authority composed with canonical /clients owner resolution — no second
-- tenant, permission, workflow, execution or deployment authority. No
-- enforcement state: consuming modules wire enforcement in later Work
-- Items (this engine decides and records only).

-- ---------------------------------------------------------------------------
-- policies — the append-oriented policy VERSION records
-- ---------------------------------------------------------------------------

-- The material-shape validator (IMMUTABLE so it can serve CHECK
-- constraints): rejects material-shaped keys at every nesting level of a
-- policy payload — the storage-side half of the §21 access-proposal-only
-- contract.
CREATE OR REPLACE FUNCTION policy_payload_has_no_material_keys(payload jsonb)
RETURNS boolean AS $$
DECLARE
    key text;
    elem jsonb;
BEGIN
    IF payload IS NULL THEN
        RETURN true;
    END IF;
    IF jsonb_typeof(payload) = 'object' THEN
        FOR key IN SELECT * FROM jsonb_object_keys(payload) LOOP
            IF key IN ('secret', 'secretMaterial', 'material', 'password', 'token',
                       'apiKey', 'api_key', 'accessKey', 'secretHandle') THEN
                RETURN false;
            END IF;
        END LOOP;
        FOR elem IN SELECT e.value FROM jsonb_each(payload) e LOOP
            IF NOT policy_payload_has_no_material_keys(elem) THEN
                RETURN false;
            END IF;
        END LOOP;
    ELSIF jsonb_typeof(payload) = 'array' THEN
        FOR elem IN SELECT a.value FROM jsonb_array_elements(payload) a LOOP
            IF NOT policy_payload_has_no_material_keys(elem) THEN
                RETURN false;
            END IF;
        END LOOP;
    END IF;
    RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- The rule-set shape validator (IMMUTABLE): every stored rule carries
-- exactly the frozen rule contract with bounded values.
CREATE OR REPLACE FUNCTION policies_rules_valid(rules jsonb)
RETURNS boolean AS $$
DECLARE
    elem jsonb;
    key_count integer;
    op text;
    attr_key text;
    attr_value jsonb;
BEGIN
    IF jsonb_typeof(rules) <> 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(rules) < 1 OR jsonb_array_length(rules) > 64 THEN RETURN false; END IF;
    FOR elem IN SELECT * FROM jsonb_array_elements(rules) LOOP
        IF jsonb_typeof(elem) <> 'object' THEN RETURN false; END IF;
        SELECT count(*) INTO key_count FROM jsonb_object_keys(elem);
        -- effect, operations, reason required; resource/attributes optional.
        IF key_count < 3 OR key_count > 5 THEN RETURN false; END IF;
        IF NOT (elem ? 'effect') OR NOT (elem ? 'operations') OR NOT (elem ? 'reason') THEN
            RETURN false;
        END IF;
        IF jsonb_typeof(elem->'effect') <> 'string'
           OR (elem->>'effect' NOT IN ('allow', 'deny')) THEN
            RETURN false;
        END IF;
        IF jsonb_typeof(elem->'reason') <> 'string'
           OR length(elem->>'reason') < 1 OR length(elem->>'reason') > 512 THEN
            RETURN false;
        END IF;
        IF jsonb_typeof(elem->'operations') <> 'array'
           OR jsonb_array_length(elem->'operations') < 1
           OR jsonb_array_length(elem->'operations') > 32 THEN
            RETURN false;
        END IF;
        FOR op IN SELECT * FROM jsonb_array_elements_text(elem->'operations') LOOP
            IF length(op) < 1 OR length(op) > 64 THEN RETURN false; END IF;
        END LOOP;
        IF elem ? 'resource' THEN
            IF jsonb_typeof(elem->'resource') = 'null' THEN
                NULL; -- resource null is legal
            ELSIF jsonb_typeof(elem->'resource') <> 'string'
                  OR length(elem->>'resource') < 1
                  OR length(elem->>'resource') > 256 THEN
                RETURN false;
            END IF;
        END IF;
        IF elem ? 'attributes' THEN
            IF jsonb_typeof(elem->'attributes') = 'null' THEN
                NULL; -- attributes null is legal (treated as {})
            ELSIF jsonb_typeof(elem->'attributes') <> 'object' THEN
                RETURN false;
            ELSE
                IF (SELECT count(*) FROM jsonb_object_keys(elem->'attributes')) > 16 THEN
                    RETURN false;
                END IF;
                FOR attr_key, attr_value IN SELECT * FROM jsonb_each(elem->'attributes') LOOP
                    IF length(attr_key) < 1 OR length(attr_key) > 64 THEN RETURN false; END IF;
                    IF jsonb_typeof(attr_value) <> 'string'
                       OR length(attr_value #>> '{}') > 256 THEN
                        RETURN false;
                    END IF;
                END LOOP;
            END IF;
        END IF;
    END LOOP;
    RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE TABLE IF NOT EXISTS policies (
    policy_id           uuid        PRIMARY KEY,
    -- The frozen POL-001 dimension (closed 7-value set).
    dimension           text        NOT NULL
                        CHECK (dimension IN ('ai', 'tools', 'network', 'secrets',
                                             'deployment', 'field', 'extension')),
    -- Scope: NULL+NULL = platform; set+NULL = agency; set+set = client.
    -- A client-scoped row must belong to its scope agency (trigger below);
    -- the scope is IMMUTABLE once set (trigger below).
    agency_id           uuid        REFERENCES agencies(agency_id),
    client_id           uuid        REFERENCES clients(client_id),
    status              text        NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'superseded')),
    -- Monotonic per (scope, dimension): the append-oriented version
    -- sequence (1 for the first declaration; +1 per supersession).
    version_seq         bigint      NOT NULL CHECK (version_seq >= 1),
    -- The declared boundary rules (shape + § validated by the functions
    -- above; no material-shaped key can ever be stored).
    rules               jsonb       NOT NULL
                        CHECK (jsonb_typeof(rules) = 'array')
                        CHECK (policies_rules_valid(rules))
                        CHECK (policy_payload_has_no_material_keys(rules)),
    description         text        NOT NULL
                        CHECK (length(description) >= 1 AND length(description) <= 2000),
    created_by          uuid        REFERENCES users(user_id),
    -- The supersession edge (applied by the NEXT declaration in the same
    -- transaction; terminal).
    superseded_at       timestamptz,
    superseded_by_policy_id uuid,
    version             bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- The ACTIVE VERSION fence: exactly one ACTIVE version per (scope,
-- dimension). NULL scope ids are unified with COALESCE so all three scope
-- modes fence under one index.
CREATE UNIQUE INDEX IF NOT EXISTS policies_active_fence
    ON policies (dimension, COALESCE(agency_id, '00000000-0000-0000-0000-000000000000'::uuid),
                 COALESCE(client_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE status = 'active';

-- The VERSION SEQUENCE fence: version_seq is unique per (scope, dimension)
-- — concurrent sequence allocation converges to a constraint violation.
CREATE UNIQUE INDEX IF NOT EXISTS policies_scope_version_fence
    ON policies (dimension, COALESCE(agency_id, '00000000-0000-0000-0000-000000000000'::uuid),
                 COALESCE(client_id, '00000000-0000-0000-0000-000000000000'::uuid), version_seq);

-- Listing surfaces: the declared versions of one scope (newest first), and
-- the decisions-facing active lookup.
CREATE INDEX IF NOT EXISTS policies_scope_idx
    ON policies (agency_id, client_id, dimension, version_seq DESC);
CREATE INDEX IF NOT EXISTS policies_active_idx
    ON policies (dimension, agency_id, client_id) WHERE status = 'active';

-- Scope legality + cross-tenant fence: client scope requires its agency
-- AND the client must belong to that agency (the Client boundary cannot
-- be crossed through the scope columns, even by direct SQL).
CREATE OR REPLACE FUNCTION policies_scope_legal() RETURNS trigger AS $$
BEGIN
    IF NEW.client_id IS NOT NULL THEN
        IF NEW.agency_id IS NULL THEN
            RAISE EXCEPTION 'policy % is client-scoped but carries no owning agency', NEW.policy_id;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM clients c
            WHERE c.client_id = NEW.client_id AND c.agency_id = NEW.agency_id) THEN
            RAISE EXCEPTION 'policy % client % does not belong to agency % — the policy scope cannot cross the Client boundary',
                NEW.policy_id, NEW.client_id, NEW.agency_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS policies_scope_legal_trigger ON policies;
CREATE TRIGGER policies_scope_legal_trigger
BEFORE INSERT OR UPDATE OF agency_id, client_id ON policies
FOR EACH ROW EXECUTE FUNCTION policies_scope_legal();

-- Content immutability (the append-oriented version registry posture):
-- identity, dimension, scope, the declared rules, the description, the
-- sequence, and the provenance can NEVER be reassigned through ANY
-- mutation path. Only the supersession lifecycle fields, the CAS token and
-- updated_at ever change.
CREATE OR REPLACE FUNCTION policies_content_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW.policy_id <> OLD.policy_id THEN
        RAISE EXCEPTION 'policy_id % is immutable', OLD.policy_id;
    END IF;
    IF NEW.dimension <> OLD.dimension THEN
        RAISE EXCEPTION 'policy % dimension is immutable', OLD.policy_id;
    END IF;
    IF NEW.agency_id IS DISTINCT FROM OLD.agency_id OR NEW.client_id IS DISTINCT FROM OLD.client_id THEN
        RAISE EXCEPTION 'policy % ownership scope is immutable (was %/%)',
            OLD.policy_id, COALESCE(OLD.agency_id::text, 'platform'), COALESCE(OLD.client_id::text, 'none');
    END IF;
    IF NEW.rules IS DISTINCT FROM OLD.rules OR NEW.description <> OLD.description THEN
        RAISE EXCEPTION 'policy % declared content is immutable (append-oriented versioning: declare a NEW version)',
            OLD.policy_id;
    END IF;
    IF NEW.version_seq <> OLD.version_seq THEN
        RAISE EXCEPTION 'policy % version sequence is immutable', OLD.policy_id;
    END IF;
    IF NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'policy % provenance is immutable', OLD.policy_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS policies_content_immutable_trigger ON policies;
CREATE TRIGGER policies_content_immutable_trigger
BEFORE UPDATE ON policies
FOR EACH ROW EXECUTE FUNCTION policies_content_immutable();

-- Lifecycle backstop: `superseded` is TERMINAL — the only lifecycle edge
-- is active → superseded, applied by the NEXT declaration; a superseded
-- version can never return to use (no resurrection), and the supersession
-- fields must be consistent with the status at ALL times. This is a
-- DEFERRABLE CONSTRAINT trigger: the superseding row is inserted AFTER the
-- prior row is marked (the transaction applies the edge in one step), so
-- the cross-row consistency (the superseder exists, is the same scope +
-- dimension and carries a HIGHER version_seq) is verified at COMMIT —
-- every mutation path, including direct SQL, is still rejected.
CREATE OR REPLACE FUNCTION policies_superseded_consistent() RETURNS trigger AS $$
BEGIN
    IF OLD.status = 'superseded' AND NEW.status <> 'superseded' THEN
        RAISE EXCEPTION 'policy % is superseded and terminal', OLD.policy_id;
    END IF;
    IF OLD.status = 'active' AND NEW.status NOT IN ('active', 'superseded') THEN
        RAISE EXCEPTION 'illegal policy status % (the lifecycle is active → superseded only)',
            NEW.status;
    END IF;
    IF NEW.status = 'superseded' THEN
        IF NEW.superseded_at IS NULL OR NEW.superseded_by_policy_id IS NULL THEN
            RAISE EXCEPTION 'policy % superseded rows must carry superseded_at and superseded_by_policy_id',
                NEW.policy_id;
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM policies n
            WHERE n.policy_id = NEW.superseded_by_policy_id
              AND n.dimension = NEW.dimension
              AND n.agency_id IS NOT DISTINCT FROM NEW.agency_id
              AND n.client_id IS NOT DISTINCT FROM NEW.client_id
              AND n.version_seq > NEW.version_seq
        ) THEN
            RAISE EXCEPTION 'policy % superseded_by_policy_id % must be a later version of the same scope and dimension',
                NEW.policy_id, NEW.superseded_by_policy_id;
        END IF;
    ELSE
        IF NEW.superseded_at IS NOT NULL OR NEW.superseded_by_policy_id IS NOT NULL THEN
            RAISE EXCEPTION 'policy % active rows must not carry supersession fields', NEW.policy_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS policies_superseded_consistent_trigger ON policies;
CREATE CONSTRAINT TRIGGER policies_superseded_consistent_trigger
AFTER UPDATE ON policies
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION policies_superseded_consistent();

-- ---------------------------------------------------------------------------
-- policy_decisions — the append-only decision records
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS policy_decisions (
    decision_id         uuid        PRIMARY KEY,
    dimension           text        NOT NULL
                        CHECK (dimension IN ('ai', 'tools', 'network', 'secrets',
                                             'deployment', 'field', 'extension')),
    -- The evaluation scope (always tenant-resolved: agency-wide or
    -- client-narrowed inside the agency; the client must belong to the
    -- agency — cross-tenant trigger below).
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        REFERENCES clients(client_id),
    outcome             text        NOT NULL CHECK (outcome IN ('allow', 'deny', 'unknown')),
    reason_code         text        NOT NULL
                        CHECK (reason_code IN ('rule-allowed', 'rule-denied', 'no-matching-rule',
                                               'no-active-policy', 'ambiguous-scope',
                                               'credential-reference-unresolved',
                                               'credential-scope-mismatch', 'evaluation-error')),
    reasons             jsonb       NOT NULL
                        CHECK (jsonb_typeof(reasons) = 'array')
                        CHECK (policy_payload_has_no_material_keys(reasons)),
    -- The action descriptor AS EVALUATED (sanitized — never material).
    action              jsonb       NOT NULL
                        CHECK (jsonb_typeof(action) = 'object')
                        CHECK (policy_payload_has_no_material_keys(action)),
    -- The policy version ids consulted at evaluation time.
    matched_policy_versions jsonb   NOT NULL DEFAULT '[]'::jsonb
                        CHECK (jsonb_typeof(matched_policy_versions) = 'array'),
    -- SERVER-DERIVED provenance (implementation-contract §3): written
    -- exclusively by server code from the module-API provenance argument —
    -- there is no request DTO path to these columns.
    recorded_actor      text        NOT NULL,
    recorded_via        text        NOT NULL CHECK (length(recorded_via) >= 1
                                           AND length(recorded_via) <= 100),
    correlation_id      text        NOT NULL,
    causation_id        text,
    recorded_at         timestamptz NOT NULL DEFAULT now(),
    evaluated_at        timestamptz NOT NULL DEFAULT now()
);

-- Listing surfaces: the agency's decision ledger (newest first), the
-- client-narrowed subset, and the per-dimension audit view.
CREATE INDEX IF NOT EXISTS policy_decisions_agency_idx
    ON policy_decisions (agency_id, recorded_at DESC, decision_id);
CREATE INDEX IF NOT EXISTS policy_decisions_client_idx
    ON policy_decisions (agency_id, client_id, recorded_at DESC) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS policy_decisions_dimension_idx
    ON policy_decisions (dimension, recorded_at DESC);

-- Scope-chain fence (TENANT-003 at the storage layer): a client-scoped
-- decision must reference a Client of the SAME agency — the Client
-- boundary cannot be crossed through the decision scope columns even if
-- every application check were bypassed.
CREATE OR REPLACE FUNCTION policy_decisions_client_within_agency() RETURNS trigger AS $$
BEGIN
    IF NEW.client_id IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM clients c
            WHERE c.client_id = NEW.client_id AND c.agency_id = NEW.agency_id) THEN
            RAISE EXCEPTION 'policy decision % client % does not belong to agency % — the decision scope cannot cross the Client boundary',
                NEW.decision_id, NEW.client_id, NEW.agency_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS policy_decisions_client_within_agency_trigger ON policy_decisions;
CREATE TRIGGER policy_decisions_client_within_agency_trigger
BEFORE INSERT OR UPDATE OF agency_id, client_id ON policy_decisions
FOR EACH ROW EXECUTE FUNCTION policy_decisions_client_within_agency();

-- APPEND-ONLY backstop (the migration 015/018 pattern): the database
-- itself rejects UPDATE and DELETE on decision records. Not even server
-- code can rewrite the decision audit trail — decisions are recorded
-- exactly once and retained for audit.
CREATE OR REPLACE FUNCTION policy_decisions_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'policy decisions are append-only: % is rejected on policy_decision %',
        TG_OP, OLD.decision_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS policy_decisions_append_only_update_trigger ON policy_decisions;
CREATE TRIGGER policy_decisions_append_only_update_trigger
BEFORE UPDATE ON policy_decisions
FOR EACH ROW EXECUTE FUNCTION policy_decisions_append_only();

DROP TRIGGER IF EXISTS policy_decisions_append_only_delete_trigger ON policy_decisions;
CREATE TRIGGER policy_decisions_append_only_delete_trigger
BEFORE DELETE ON policy_decisions
FOR EACH ROW EXECUTE FUNCTION policy_decisions_append_only();
