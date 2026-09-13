-- 038_app_installs.sql — MKT-048 (App Installation, Upgrade and Rollback).
--
-- The workspace-scoped App installation authority (APP-002 — the App
-- lifecycle over the MKT-047 /apps registry): install is workspace-scoped
-- and policy-gated with SERVER-DERIVED granted scopes; an installation
-- selects ONE EXACT App Version; upgrade selects a NEW version for FUTURE
-- invocations; rollback reselects a PREVIOUSLY INSTALLED approved version;
-- published App Versions are immutable and the install ledger is
-- APPEND-ORIENTED — historical selection rows retain their ORIGINAL
-- (app key, version) forever (spec/mos-app-ecosystem-v1.5.md "Install and
-- invoke" + "Upgrade and rollback", verbatim; spec/architecture-lock-v1.5.md
-- #10 "App permissions are least-privilege, policy-gated, server-derived
-- and revocable" + #11 "Published App Versions are immutable; upgrades and
-- rollback affect future selection only"; spec/effective-backlog-v1.5.md
-- MKT-048).
-- PostgreSQL is the system of record (spec/architecture-lock.md).
--
-- Table ownership follows the MKT-048 contract: the /app-installs module
-- (this Work Item's authority) owns exactly these two tables:
--   app_installs        → the APPEND-ORIENTED, VERSIONED INSTALL LEDGER:
--                          one row per EXACT-VERSION SELECTION ever made
--                          for a (workspace, app key) lineage — install,
--                          upgrade and rollback each APPEND a new row; the
--                          prior row is superseded by the SINGLE sanctioned
--                          UPDATE (the migration 035 operating-graph
--                          supersession pattern: status ACTIVE → SUPERSEDED
--                          with superseded_at set — every recorded column
--                          immutable, DELETE rejected);
--   app_install_events  → the append-only lifecycle EVENT TAIL (one row
--                          per installed/upgraded/rolled_back transition
--                          with the prior→new selection linkage — the
--                          migration 036 decision_events pattern; UPDATE
--                          and DELETE rejected outright).
--
-- Frozen semantics encoded here (FROZEN — never a caller freedom):
--
-- * EXACT-VERSION HISTORICAL IDENTITY: every ledger row pins the EXACT
--   (app_key, version, app_version_id) identity, and a trigger re-verifies
--   the triple against the immutable migration-037 registry (the pinned
--   version must be the published row for exactly this app key + semantic
--   version). Historical rows retain their ORIGINAL identity after upgrade
--   AND rollback — the append-only discipline trigger makes every other
--   UPDATE impossible, even by direct SQL.
-- * FUTURE-SELECTION SEMANTICS: within one (workspace, app key) lineage at
--   most ONE row is the CURRENT selection (status 'ACTIVE') — a partial
--   unique fence the database itself enforces against concurrent writers.
--   Upgrade/rollback supersede the current row and append the successor;
--   history is never rewritten (the migration 035 current-fence pattern).
-- * THE SINGLE SANCTIONED UPDATE: a ledger row may ONLY move
--   status ACTIVE → SUPERSEDED together with superseded_at NULL → set —
--   exactly the operating-graph supersession transition. Every recorded
--   column (identity, scope chain, grants, provenance, §8 command key,
--   selection sequence) is immutable; DELETE is rejected outright.
-- * SERVER-DERIVED GRANTS (architecture-lock v1.5 #10; implementation-
--   contract §3): granted_data_scopes / granted_mutation_scopes are
--   CHECK-fenced against the CLOSED MKT-047 scope vocabularies (mirrored
--   from migration 037) AND trigger-fenced as a SUBSET of the pinned
--   manifest's REQUESTED scopes — an install/upgrade/rollback can never
--   grant more than the immutable manifest requests, even by direct SQL.
--   There is NO caller-suppliable grant path: the columns are written only
--   by the module from the policy-intersected derivation.
-- * WORKSPACE-SCOPED, SCOPE-CHAIN-FENCED: agency/client/workspace are
--   server-derived at selection time and immutable; the workspace must
--   belong to the client and the client to the agency (the migration
--   003/004/035 tenant-fence pattern — the scope chain cannot be crossed).
-- * SELECTION SEQUENCE: selection_seq is the monotonic per-(workspace, app
--   key) sequence (1 = the install; upgrade/rollback append 2, 3, ... — a
--   CHECK ties operation 'install' to seq 1); each version of the lineage
--   selection is assigned exactly once (UNIQUE fence).
-- * §8 COMMAND CONVERGENCE: (workspace_id, idempotency_key) is UNIQUE on
--   the ledger and on the event tail — one logical install/upgrade/rollback
--   command per workspace; the create fingerprint detects divergent reuse.
-- * NO SECRET MATERIAL ANYWHERE (CRED-001 / §21): the only jsonb columns
--   are the two closed-vocabulary scope arrays (string arrays, strictly
--   validated) — there is deliberately NO column capable of holding secret
--   material, a secret handle or any free-form caller payload.
-- * NO AUTHORITY TRANSFER (architecture-lock v1.5 #7/#13): this migration
--   creates NO registry, marketplace, metering, workflow, execution,
--   evidence, policy or tenant table — the ledger READS the migration-037
--   app registry (check-only) and composes over the existing authorities.
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, installed_at/recorded_at, §8-style idempotency keys +
-- create fingerprints for logical-command convergence. No owner/role/user
-- columns beyond provenance: install authorization stays exactly the
-- /agencies membership authority + the /policies fail-closed gate resolved
-- at the route/module layer — no second tenant, permission or identity
-- authority.

-- ---------------------------------------------------------------------------
-- Shape validators (IMMUTABLE so they can serve CHECK constraints)
-- ---------------------------------------------------------------------------

-- The granted-DATA-scope validator: the closed MKT-047 tenant-data boundary
-- vocabulary (the same frozen set migration 037 CHECK-fences on requested
-- scopes), bounded and unique. Granted scopes are SERVER-DERIVED; the
-- vocabulary is never a caller freedom.
CREATE OR REPLACE FUNCTION app_installs_data_scopes_valid(scopes jsonb)
RETURNS boolean AS $$
DECLARE
    elem jsonb; scope text; seen text[] := ARRAY[]::text[];
BEGIN
    IF jsonb_typeof(scopes) <> 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(scopes) > 16 THEN RETURN false; END IF;
    FOR elem IN SELECT * FROM jsonb_array_elements(scopes) LOOP
        IF jsonb_typeof(elem) <> 'string' THEN RETURN false; END IF;
        scope := elem#>>'{}';
        IF scope NOT IN ('client:read', 'client:write', 'workspace:read', 'workspace:write') THEN
            RETURN false;
        END IF;
        IF seen @> ARRAY[scope] THEN RETURN false; END IF;
        seen := seen || scope;
    END LOOP;
    RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- The granted-MUTATION-scope validator: the closed MKT-047 authority-
-- invocation vocabulary (the same frozen set migration 037 CHECK-fences on
-- requested scopes), bounded and unique.
CREATE OR REPLACE FUNCTION app_installs_mutation_scopes_valid(scopes jsonb)
RETURNS boolean AS $$
DECLARE
    elem jsonb; scope text; seen text[] := ARRAY[]::text[];
BEGIN
    IF jsonb_typeof(scopes) <> 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(scopes) > 16 THEN RETURN false; END IF;
    FOR elem IN SELECT * FROM jsonb_array_elements(scopes) LOOP
        IF jsonb_typeof(elem) <> 'string' THEN RETURN false; END IF;
        scope := elem#>>'{}';
        IF scope NOT IN ('workflow:dispatch', 'execution:request', 'evidence:append',
                         'metric:append', 'credential:bind') THEN
            RETURN false;
        END IF;
        IF seen @> ARRAY[scope] THEN RETURN false; END IF;
        seen := seen || scope;
    END LOOP;
    RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ---------------------------------------------------------------------------
-- app_installs — the append-oriented, versioned install ledger
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS app_installs (
    install_id       uuid        PRIMARY KEY,
    -- The canonical scope chain (SERVER-DERIVED at selection time, immutable).
    agency_id        uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id        uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id     uuid        NOT NULL REFERENCES workspaces(workspace_id),
    -- The EXACT App Version identity this selection pins (re-verified against
    -- the immutable migration-037 registry by trigger below).
    app_key          text        NOT NULL
                     CHECK (app_key ~ '^[a-z][a-z0-9-]{1,62}$'),
    app_version_id   uuid        NOT NULL REFERENCES app_versions(app_version_id),
    version          text        NOT NULL
                     CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]{1,32})?$'),
    -- How this selection came to be: 'install' (the first selection of the
    -- lineage), 'upgrade' (a NEW version selected for FUTURE invocations) or
    -- 'rollback' (a PREVIOUSLY INSTALLED approved version reselected).
    operation        text        NOT NULL
                     CHECK (operation IN ('install', 'upgrade', 'rollback')),
    -- The SERVER-DERIVED granted scopes (never caller-suppliable): the
    -- manifest's requested scopes intersected with the install-time policy
    -- evaluation and the frozen scope vocabularies. Trigger-fenced BELOW as
    -- a subset of the pinned manifest's requested scopes.
    granted_data_scopes     jsonb NOT NULL DEFAULT '[]'::jsonb
                     CHECK (app_installs_data_scopes_valid(granted_data_scopes)),
    granted_mutation_scopes jsonb NOT NULL DEFAULT '[]'::jsonb
                     CHECK (app_installs_mutation_scopes_valid(granted_mutation_scopes)),
    -- The recorded install-time policy decision that explicitly allowed this
    -- selection (the /policies append-only decision ledger reference).
    policy_decision_id uuid    REFERENCES policy_decisions(decision_id),
    -- The monotonic per-(workspace, app key) selection sequence: the install
    -- is 1; every upgrade/rollback appends the next number. A CHECK ties the
    -- install operation to sequence 1 (a lineage's first selection is always
    -- an install; lifecycle changes are successors).
    selection_seq    integer     NOT NULL CHECK (selection_seq >= 1),
    -- The frozen lifecycle: born ACTIVE; the ONLY sanctioned transition is
    -- ACTIVE → SUPERSEDED (the operating-graph supersession pattern) when a
    -- successor selection is appended.
    status           text        NOT NULL DEFAULT 'ACTIVE'
                     CHECK (status IN ('ACTIVE', 'SUPERSEDED')),
    superseded_at    timestamptz,
    -- Install provenance (SERVER-DERIVED who/when — never a request field).
    installed_by     uuid        REFERENCES users(user_id),
    installed_at     timestamptz NOT NULL DEFAULT now(),
    -- The §8-style logical command identity + create fingerprint
    -- (convergence proof: one logical install/upgrade/rollback command per
    -- workspace; a key reused for different content is a conflict).
    idempotency_key  text        NOT NULL
                     CHECK (length(idempotency_key) >= 1 AND length(idempotency_key) <= 200),
    create_fingerprint text      NOT NULL
                     CHECK (length(create_fingerprint) >= 1 AND length(create_fingerprint) <= 128),
    -- The install operation IS the first selection of the lineage.
    CONSTRAINT app_installs_operation_seq_shape
        CHECK ((operation = 'install' AND selection_seq = 1)
            OR (operation IN ('upgrade', 'rollback') AND selection_seq >= 2)),
    -- The lifecycle shape: an ACTIVE row has no supersession stamp; a
    -- SUPERSEDED row always has one.
    CONSTRAINT app_installs_status_shape
        CHECK ((status = 'ACTIVE' AND superseded_at IS NULL)
            OR (status = 'SUPERSEDED' AND superseded_at IS NOT NULL)),
    -- Each selection version of a lineage is assigned exactly once.
    CONSTRAINT app_installs_seq_unique
        UNIQUE (workspace_id, app_key, selection_seq)
);

-- THE CURRENT-SELECTION FENCE: within one (workspace, app key) lineage at
-- most ONE row is the current selection — the database itself rejects a
-- second concurrent writer converging the same lineage (the migration 035
-- partial-unique pattern). Upgrade/rollback supersede the current row FIRST
-- and append the successor in the same transaction.
CREATE UNIQUE INDEX IF NOT EXISTS app_installs_current_fence
    ON app_installs (workspace_id, app_key) WHERE status = 'ACTIVE';

-- The §8 command fence: one logical command key per workspace.
CREATE UNIQUE INDEX IF NOT EXISTS app_installs_idempotency_key_unique
    ON app_installs (workspace_id, idempotency_key);

-- Listing surfaces: the workspace's full selection history (current +
-- superseded) and the agency rollup of current selections.
CREATE INDEX IF NOT EXISTS app_installs_lineage_idx
    ON app_installs (workspace_id, app_key, selection_seq);
CREATE INDEX IF NOT EXISTS app_installs_agency_current_idx
    ON app_installs (agency_id, installed_at DESC) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS app_installs_app_version_idx
    ON app_installs (app_version_id);

-- TENANT FENCE (the migration 003/004/035 pattern): a selection's workspace
-- must belong to its client and its client to its agency — the scope chain
-- cannot be crossed even if every application check were bypassed.
CREATE OR REPLACE FUNCTION app_installs_scope_chain_consistent() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM clients c
        WHERE c.client_id = NEW.client_id AND c.agency_id = NEW.agency_id) THEN
        RAISE EXCEPTION 'app install scope: client % does not belong to agency % — the tenant scope chain cannot be crossed',
            NEW.client_id, NEW.agency_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM workspaces w
        WHERE w.workspace_id = NEW.workspace_id AND w.client_id = NEW.client_id) THEN
        RAISE EXCEPTION 'app install scope: workspace % does not belong to client % — the tenant scope chain cannot be crossed',
            NEW.workspace_id, NEW.client_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS app_installs_scope_chain_trigger ON app_installs;
CREATE TRIGGER app_installs_scope_chain_trigger
    BEFORE INSERT OR UPDATE OF agency_id, client_id, workspace_id ON app_installs
    FOR EACH ROW EXECUTE FUNCTION app_installs_scope_chain_consistent();

-- EXACT-VERSION IDENTITY + LEAST-PRIVILEGE GRANTS (the storage-layer fence
-- of SERVER-DERIVATION): the pinned (app_key, version, app_version_id)
-- triple must match the immutable migration-037 registry row EXACTLY, and
-- the granted scopes must be a SUBSET of that manifest's REQUESTED scopes —
-- a selection can never grant more than the immutable manifest requests,
-- and the pinned identity can never drift, even by direct SQL. The registry
-- is read CHECK-ONLY: no app_versions row is ever created or mutated here.
CREATE OR REPLACE FUNCTION app_installs_identity_and_grants_consistent() RETURNS trigger AS $$
DECLARE
    v_app_key text;
    v_version text;
    v_data_scopes jsonb;
    v_mutation_scopes jsonb;
BEGIN
    SELECT app_key, version, data_scopes, mutation_scopes
      INTO v_app_key, v_version, v_data_scopes, v_mutation_scopes
      FROM app_versions WHERE app_version_id = NEW.app_version_id;
    IF v_app_key IS NULL THEN
        RAISE EXCEPTION 'app install % references an unknown app version %',
            NEW.install_id, NEW.app_version_id;
    END IF;
    IF v_app_key <> NEW.app_key OR v_version <> NEW.version THEN
        RAISE EXCEPTION 'app install % pins (%@%) but the registry version % is %@% — the exact-version identity must match the immutable registry',
            NEW.install_id, NEW.app_key, NEW.version, NEW.app_version_id, v_app_key, v_version;
    END IF;
    IF NOT (v_data_scopes @> NEW.granted_data_scopes) THEN
        RAISE EXCEPTION 'app install % grants data scopes beyond the manifest request of %@% — granted scopes are server-derived and least-privilege',
            NEW.install_id, NEW.app_key, NEW.version;
    END IF;
    IF NOT (v_mutation_scopes @> NEW.granted_mutation_scopes) THEN
        RAISE EXCEPTION 'app install % grants mutation scopes beyond the manifest request of %@% — granted scopes are server-derived and least-privilege',
            NEW.install_id, NEW.app_key, NEW.version;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS app_installs_identity_grants_trigger ON app_installs;
CREATE TRIGGER app_installs_identity_grants_trigger
    BEFORE INSERT ON app_installs
    FOR EACH ROW EXECUTE FUNCTION app_installs_identity_and_grants_consistent();

-- APPEND-ONLY HISTORY (the migration 035 operating-graph pattern — THE
-- SINGLE SANCTIONED UPDATE): DELETE is rejected outright; an UPDATE may
-- ONLY perform the supersession transition (status ACTIVE → SUPERSEDED
-- with superseded_at NULL → set). Every recorded column — the exact-version
-- identity, the scope chain, the operation, the granted scopes, the policy
-- decision reference, the selection sequence, the provenance and the §8
-- command identity — is immutable. Historical rows retain their ORIGINAL
-- (app key, version) after upgrade AND rollback; corrections are NEW rows.
CREATE OR REPLACE FUNCTION app_installs_history_preserved() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'app install ledger rows are append-only: DELETE is rejected on install %',
            OLD.install_id;
    END IF;
    IF NEW.install_id IS DISTINCT FROM OLD.install_id
       OR NEW.agency_id <> OLD.agency_id
       OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id <> OLD.workspace_id
       OR NEW.app_key <> OLD.app_key
       OR NEW.app_version_id <> OLD.app_version_id
       OR NEW.version <> OLD.version
       OR NEW.operation <> OLD.operation
       OR NEW.granted_data_scopes IS DISTINCT FROM OLD.granted_data_scopes
       OR NEW.granted_mutation_scopes IS DISTINCT FROM OLD.granted_mutation_scopes
       OR NEW.policy_decision_id IS DISTINCT FROM OLD.policy_decision_id
       OR NEW.selection_seq <> OLD.selection_seq
       OR NEW.installed_by IS DISTINCT FROM OLD.installed_by
       OR NEW.installed_at <> OLD.installed_at
       OR NEW.idempotency_key <> OLD.idempotency_key
       OR NEW.create_fingerprint <> OLD.create_fingerprint THEN
        RAISE EXCEPTION 'app install ledger row % is append-only: the recorded selection columns are immutable (upgrade/rollback append NEW rows — history is never rewritten)',
            OLD.install_id;
    END IF;
    IF NOT (OLD.status = 'ACTIVE' AND NEW.status = 'SUPERSEDED'
            AND OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL) THEN
        RAISE EXCEPTION 'app install ledger row % permits only the supersession transition (ACTIVE → SUPERSEDED with superseded_at set)',
            OLD.install_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS app_installs_history_trigger ON app_installs;
CREATE TRIGGER app_installs_history_trigger
    BEFORE UPDATE OR DELETE ON app_installs
    FOR EACH ROW EXECUTE FUNCTION app_installs_history_preserved();

-- ---------------------------------------------------------------------------
-- app_install_events — the append-only lifecycle event tail
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS app_install_events (
    event_id         uuid        PRIMARY KEY,
    -- The NEW selection row this event announces (the appended successor on
    -- upgrade/rollback; the install row on install).
    install_id       uuid        NOT NULL REFERENCES app_installs(install_id),
    -- The scope chain (server-derived, immutable; the listing surface).
    agency_id        uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id        uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id     uuid        NOT NULL REFERENCES workspaces(workspace_id),
    app_key          text        NOT NULL
                     CHECK (app_key ~ '^[a-z][a-z0-9-]{1,62}$'),
    -- The frozen transition vocabulary: an install (the lineage's first
    -- selection), an upgrade (a NEW version selected for future invocations)
    -- or a rollback (a previously installed approved version reselected).
    event_type       text        NOT NULL
                     CHECK (event_type IN ('installed', 'upgraded', 'rolled_back')),
    -- The SUPERSEDED selection this transition moved away from (NULL only
    -- on 'installed' — the first selection has no predecessor).
    prior_install_id uuid        REFERENCES app_installs(install_id),
    -- The selection change: from_version is NULL only on 'installed'.
    from_version     text,
    to_version       text        NOT NULL
                     CHECK (to_version ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]{1,32})?$'),
    -- The recorded policy decision that allowed the transition.
    policy_decision_id uuid      REFERENCES policy_decisions(decision_id),
    -- The §8 logical command identity (converges with the ledger row's key).
    idempotency_key  text        NOT NULL
                     CHECK (length(idempotency_key) >= 1 AND length(idempotency_key) <= 200),
    -- SERVER-DERIVED provenance (never a request field).
    recorded_actor   text        NOT NULL
                     CHECK (length(recorded_actor) >= 1 AND length(recorded_actor) <= 100),
    recorded_via     text        NOT NULL
                     CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 100),
    correlation_id   text        NOT NULL,
    causation_id     text,
    recorded_at      timestamptz NOT NULL DEFAULT now(),
    -- The event payload shape: an install carries no predecessor and no
    -- from_version; an upgrade/rollback carries BOTH.
    CONSTRAINT app_install_event_payload CHECK (
        (event_type = 'installed'
           AND prior_install_id IS NULL AND from_version IS NULL)
        OR (event_type IN ('upgraded', 'rolled_back')
           AND prior_install_id IS NOT NULL AND from_version IS NOT NULL)
    )
);

-- The §8 event fence: one logical command key per workspace (converges with
-- the ledger row fence — both fire in the same transaction).
CREATE UNIQUE INDEX IF NOT EXISTS app_install_events_idempotency_key_unique
    ON app_install_events (workspace_id, idempotency_key);

-- Listing surfaces: the workspace's transition history and the per-lineage
-- event trail.
CREATE INDEX IF NOT EXISTS app_install_events_workspace_idx
    ON app_install_events (workspace_id, recorded_at, event_id);
CREATE INDEX IF NOT EXISTS app_install_events_install_idx
    ON app_install_events (install_id, recorded_at);
CREATE INDEX IF NOT EXISTS app_install_events_prior_idx
    ON app_install_events (prior_install_id) WHERE prior_install_id IS NOT NULL;

-- The event tail must agree with the ledger row it announces (scope chain,
-- app key, to_version = the row's exact version; the §8 command key equals
-- the row's key — the event and the row are ONE logical command).
CREATE OR REPLACE FUNCTION app_install_events_consistent() RETURNS trigger AS $$
DECLARE
    v_row record;
BEGIN
    SELECT install_id, agency_id, client_id, workspace_id, app_key, version,
           idempotency_key, operation
      INTO v_row
      FROM app_installs WHERE install_id = NEW.install_id;
    IF v_row IS NULL THEN
        RAISE EXCEPTION 'app install event % references an unknown install row %',
            NEW.event_id, NEW.install_id;
    END IF;
    IF v_row.agency_id <> NEW.agency_id OR v_row.client_id <> NEW.client_id
       OR v_row.workspace_id <> NEW.workspace_id OR v_row.app_key <> NEW.app_key
       OR v_row.version <> NEW.to_version OR v_row.idempotency_key <> NEW.idempotency_key THEN
        RAISE EXCEPTION 'app install event % disagrees with its install row % (scope, app key, to_version or command key mismatch)',
            NEW.event_id, NEW.install_id;
    END IF;
    IF (v_row.operation = 'install') <> (NEW.event_type = 'installed') THEN
        RAISE EXCEPTION 'app install event % type % disagrees with install row % operation %',
            NEW.event_id, NEW.event_type, NEW.install_id, v_row.operation;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS app_install_events_consistent_trigger ON app_install_events;
CREATE TRIGGER app_install_events_consistent_trigger
    BEFORE INSERT ON app_install_events
    FOR EACH ROW EXECUTE FUNCTION app_install_events_consistent();

-- APPEND-ONLY backstop (the migration 036 decision_events pattern): the
-- database itself rejects UPDATE and DELETE on the event tail — not even
-- server code can rewrite install history.
CREATE OR REPLACE FUNCTION app_install_events_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'app install events are append-only: % is rejected on event %',
        TG_OP, OLD.event_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS app_install_events_append_only_update_trigger ON app_install_events;
CREATE TRIGGER app_install_events_append_only_update_trigger
    BEFORE UPDATE ON app_install_events
    FOR EACH ROW EXECUTE FUNCTION app_install_events_append_only();

DROP TRIGGER IF EXISTS app_install_events_append_only_delete_trigger ON app_install_events;
CREATE TRIGGER app_install_events_append_only_delete_trigger
    BEFORE DELETE ON app_install_events
    FOR EACH ROW EXECUTE FUNCTION app_install_events_append_only();
