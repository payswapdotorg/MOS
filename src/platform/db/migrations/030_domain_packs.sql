-- MKT-036 Domain Pack framework schema (PACK-001).
-- PostgreSQL is the system of record (spec/architecture-lock.md).
--
-- Table ownership follows the frozen authority map (implementation-contract
-- §1 + spec/module-dependency-v1.3.md: "/domain-packs is the
-- registry/composition authority for installed Domain Pack versions") —
-- ALL THREE tables here:
--   domain_packs            → the immutable versioned PACK REGISTRY
--                             (published pack versions)
--   domain_pack_installs    → the INSTALLED-VERSION RECORDS (a specific
--                             pack version recorded against the authorized
--                             Workspace/Client context — PACK-AC-01)
--   domain_pack_artifacts   → the per-install ARTIFACT SCOPE RECORDS
--                             (PACK-AC-03: Client-scoped pack-owned data
--                             vs explicitly-declared Agency-scoped reusable
--                             artifacts)
--
-- Frozen semantics encoded here (spec/domain-pack-v1.3.md — FROZEN;
-- spec/requirements-v1.3.md PACK-001; spec/work-item-v1.3-overrides.md
-- MKT-036 "versioned Domain Pack composition contract, installation scope,
-- immutable versions, dependency/compatibility checks, and authority
-- restrictions"; spec/implementation-contract.md §3 "No externally
-- supplied field may override a server-derived actor, owner, provenance,
-- policy decision, or evidence authority value"; §21 "secrets may never
-- appear ... in durable" pack payloads; §25 database backstops):
--
-- * THE IMMUTABLE-VERSION REGISTRY (domain-pack-v1.3.md §4 "Pack versions
--   are immutable once published ... A new version is required for
--   semantic change"): (publisher, pack_key, version) is UNIQUE —
--   re-registration of the same version converges to a constraint
--   violation (a ConflictError upstream; never a silent rewrite), and a
--   new version is a NEW row. Published manifest content is IMMUTABLE
--   through EVERY mutation path (triggers reject UPDATE and DELETE
--   outright — the migration 008 playbooks + 028 extensions precedent).
--   The registry row carries NO tenant columns at all: a pack version is
--   global catalog state, exactly like an extension version.
-- * THE CLOSED ARTIFACT-KIND VOCABULARY (domain-pack-v1.3.md §2 — the
--   pack may provide domain entities/views, goals and metrics, playbook
--   and workflow templates, AI capability definitions, human-agent
--   capability profiles, policies, integration/extension bindings,
--   evidence schemas/evaluators, UI surfaces): 14 kinds, a DB CHECK on
--   the closed set, never a caller freedom. Workflow-template payloads
--   additionally conform to the /workflows §4 definition contract —
--   validated by the /workflows authority's own validator at publish
--   (the framework has NO workflow engine of its own, domain-pack §3).
-- * THE ARTIFACT SCOPE DISTINCTION (domain-pack-v1.3.md §5 "Pack-owned
--   data is Client-scoped unless the pack contract explicitly declares an
--   Agency-scoped reusable artifact such as a playbook template.
--   Cross-client aggregation requires an explicit privacy/governance
--   policy"): scope is the closed 'client' | 'agency-reusable'
--   vocabulary; a 'client' artifact record REQUIRES client_id (NOT NULL)
--   and an 'agency-reusable' artifact record REQUIRES client_id NULL —
--   the distinction is structural, in the manifest, in the records and in
--   every query (PACK-AC-03).
-- * THE INSTALL SCOPE CHAIN (implementation-contract §2): agency →
--   client → workspace are re-fenced by triggers (the client must belong
--   to the agency; the workspace to the client) — the Client boundary
--   cannot be crossed through the install columns even by direct SQL.
--   Scope, pack_id and idempotency identity are IMMUTABLE after install.
-- * THE INSTALL LIFECYCLE: rows are born 'installed'; the frozen
--   transition table is DB-enforced (installed → disabled | uninstalled;
--   disabled → installed | uninstalled); 'uninstalled' is TERMINAL
--   (tombstone — history stays readable, identifiers never replay back
--   to life).
-- * THE ARTIFACT CONSISTENCY FENCE: an artifact row's install must pin
--   the same pack version in the same workspace; a client-scoped
--   artifact's client must equal the install's client; every artifact
--   row's agency must equal the install's agency — crossed rows are
--   impossible even by direct SQL.
-- * THE ARTIFACT RECORDS ARE APPEND-ONLY (the migration 015/018/025/028
--   pattern): UPDATE and DELETE are rejected by triggers. Cross-client
--   re-parenting is therefore impossible — pack-owned Client data cannot
--   cross the Client boundary at the storage layer (PACK-AC-03).
-- * CRED-001 / §21 POSTURE: every jsonb payload is CHECKed against
--   material-shaped keys — there is deliberately NO column capable of
--   holding secret material or a secret handle anywhere in this
--   migration.
-- * NO ALTERNATE AUTHORITY (domain-pack-v1.3.md §3): this migration
--   creates NO workflow table, NO workflow-instance/workflow-state
--   column, NO execution table, NO evidence table, NO credential
--   column, NO AI-routing table and NO Job table — /workflows,
--   /executions, /evidence, /ai-runtime, /credentials and /jobs stay the
--   only authorities for those concerns (PACK-AC-02 at the storage
--   layer). The pack registry only records DECLARATIONS that execute
--   through the existing authorities.
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, created_at/updated_at, version CAS for concurrent mutation.
-- No owner/role/user columns beyond provenance: install authorization
-- stays exactly the /agencies membership authority composed with canonical
-- /workspaces owner resolution — no second tenant, permission, workflow,
-- execution, evidence, credential or audit authority. No provider SDK
-- coupling, no specific business pack rows (MKT-037 is a LATER Work
-- Item), no pack execution engine, no UI.

-- ---------------------------------------------------------------------------
-- Shape validators (IMMUTABLE so they can serve CHECK constraints)
-- ---------------------------------------------------------------------------

-- The material-shape validator (the migration 025/028 pattern): rejects
-- material-shaped keys at every nesting level of a pack payload — the
-- storage-side half of the §21 contract (manifest artifact payloads and
-- declarations are fenced).
CREATE OR REPLACE FUNCTION domain_packs_payload_has_no_material_keys(payload jsonb)
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
            IF NOT domain_packs_payload_has_no_material_keys(elem) THEN
                RETURN false;
            END IF;
        END LOOP;
    ELSIF jsonb_typeof(payload) = 'array' THEN
        FOR elem IN SELECT a.value FROM jsonb_array_elements(payload) a LOOP
            IF NOT domain_packs_payload_has_no_material_keys(elem) THEN
                RETURN false;
            END IF;
        END LOOP;
    END IF;
    RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- The artifact-declaration list validator: non-empty bounded array of
-- EXACTLY { kind, name, description, scope, payload } declarations;
-- kind is the closed domain-pack-v1.3.md §2 14-kind set; scope is the
-- closed §5 two-value set; (kind, name) is unique within the list (one
-- artifact identity per kind); payloads are bounded objects free of
-- material-shaped keys. Workflow-template payload §4 conformance is
-- validated by the /workflows authority's validator at publish (module
-- layer) — the DB enforces the structural shape.
CREATE OR REPLACE FUNCTION domain_packs_artifacts_valid(artifacts jsonb)
RETURNS boolean AS $$
DECLARE
    elem jsonb;
    key_count integer;
    kind text;
    name text;
    scope text;
    seen text[] := ARRAY[]::text[];
BEGIN
    IF jsonb_typeof(artifacts) <> 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(artifacts) < 1 OR jsonb_array_length(artifacts) > 128 THEN
        RETURN false;
    END IF;
    FOR elem IN SELECT * FROM jsonb_array_elements(artifacts) LOOP
        IF jsonb_typeof(elem) <> 'object' THEN RETURN false; END IF;
        SELECT count(*) INTO key_count FROM jsonb_object_keys(elem);
        IF key_count <> 5 THEN RETURN false; END IF;
        IF NOT (elem ? 'kind') OR NOT (elem ? 'name') OR NOT (elem ? 'description')
           OR NOT (elem ? 'scope') OR NOT (elem ? 'payload') THEN
            RETURN false;
        END IF;
        IF jsonb_typeof(elem->'kind') <> 'string' OR NOT (elem->>'kind' IN (
               'domain-entity', 'view', 'goal-definition', 'metric-definition',
               'playbook-template', 'workflow-template', 'ai-capability',
               'human-capability', 'policy', 'integration-binding',
               'extension-binding', 'evidence-schema', 'evaluator',
               'ui-surface')) THEN
            RETURN false;
        END IF;
        IF jsonb_typeof(elem->'name') <> 'string' THEN RETURN false; END IF;
        name := elem->>'name';
        IF length(name) < 1 OR length(name) > 64 THEN RETURN false; END IF;
        IF jsonb_typeof(elem->'description') <> 'string'
           OR length(elem->>'description') < 1
           OR length(elem->>'description') > 512 THEN
            RETURN false;
        END IF;
        IF jsonb_typeof(elem->'scope') <> 'string'
           OR NOT (elem->>'scope' IN ('client', 'agency-reusable')) THEN
            RETURN false;
        END IF;
        scope := elem->>'scope';
        IF jsonb_typeof(elem->'payload') <> 'object' THEN RETURN false; END IF;
        IF octet_length((elem->'payload')::text) > 65536 THEN RETURN false; END IF;
        IF NOT domain_packs_payload_has_no_material_keys(elem->'payload') THEN
            RETURN false;
        END IF;
        kind := elem->>'kind';
        IF seen @> ARRAY[kind || ':' || name] THEN RETURN false; END IF;
        seen := seen || ARRAY[kind || ':' || name];
        IF scope NOT IN ('client', 'agency-reusable') THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- The required-packs (dependency declaration) validator: bounded unique
-- array of EXACTLY { publisher, packKey, version } references. Dependency
-- EXISTENCE is validated at publish/install by the module; a pack
-- self-dependency is rejected by the module guard (the DB shape only).
CREATE OR REPLACE FUNCTION domain_packs_required_packs_valid(required jsonb)
RETURNS boolean AS $$
DECLARE
    elem jsonb;
    key_count integer;
    seen text[] := ARRAY[]::text[];
    ref text;
BEGIN
    IF jsonb_typeof(required) <> 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(required) > 16 THEN
        RETURN false;
    END IF;
    FOR elem IN SELECT * FROM jsonb_array_elements(required) LOOP
        IF jsonb_typeof(elem) <> 'object' THEN RETURN false; END IF;
        SELECT count(*) INTO key_count FROM jsonb_object_keys(elem);
        IF key_count <> 3 THEN RETURN false; END IF;
        IF NOT (elem ? 'publisher') OR NOT (elem ? 'packKey') OR NOT (elem ? 'version') THEN
            RETURN false;
        END IF;
        IF jsonb_typeof(elem->'publisher') <> 'string'
           OR length(elem->>'publisher') < 1
           OR length(elem->>'publisher') > 64 THEN RETURN false; END IF;
        IF jsonb_typeof(elem->'packKey') <> 'string'
           OR length(elem->>'packKey') < 2
           OR length(elem->>'packKey') > 63 THEN RETURN false; END IF;
        IF jsonb_typeof(elem->'version') <> 'string'
           OR elem->>'version' !~ '^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]{1,32})?$' THEN
            RETURN false;
        END IF;
        -- NOTE: the ->> subexpressions are parenthesized because ->> and
        -- || share operator precedence and associate LEFT (a bare chain
        -- would misparse as (text || elem) ->> '…' and fail).
        ref := (elem->>'publisher') || '/' || (elem->>'packKey') || '@' || (elem->>'version');
        IF seen @> ARRAY[ref] THEN RETURN false; END IF;
        seen := seen || ARRAY[ref];
    END LOOP;
    RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ---------------------------------------------------------------------------
-- domain_packs — the immutable versioned pack registry
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS domain_packs (
    pack_id         uuid        PRIMARY KEY,
    pack_key        text        NOT NULL
                    CHECK (pack_key ~ '^[a-z][a-z0-9-]{1,62}$'),
    publisher       text        NOT NULL
                    CHECK (publisher ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
    version         text        NOT NULL
                    CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]{1,32})?$'),
    display_name    text        NOT NULL
                    CHECK (length(display_name) >= 1 AND length(display_name) <= 128),
    description     text        NOT NULL
                    CHECK (length(description) >= 1 AND length(description) <= 512),
    -- Platform compatibility range (inclusive labels; catalog data —
    -- resolved by the Deployment authority at deploy time, never here).
    compat_min      text        NOT NULL
                    CHECK (length(compat_min) >= 1 AND length(compat_min) <= 32),
    compat_max      text        NOT NULL
                    CHECK (length(compat_max) >= 1 AND length(compat_max) <= 32),
    -- Declared pack dependencies: EXACT published (publisher, packKey,
    -- version) references (validated at publish/install by the module).
    required_packs  jsonb       NOT NULL DEFAULT '[]'::jsonb
                    CHECK (domain_packs_required_packs_valid(required_packs)),
    -- The artifact declarations (the §2 closed-kind list with the §5
    -- explicit scope distinction on every artifact).
    artifacts       jsonb       NOT NULL
                    CHECK (domain_packs_artifacts_valid(artifacts))
                    CHECK (domain_packs_payload_has_no_material_keys(artifacts)),
    -- The §8-style logical publish command identity (convergence proof).
    idempotency_key text        NOT NULL
                    CHECK (length(idempotency_key) >= 1 AND length(idempotency_key) <= 200),
    create_fingerprint text     NOT NULL
                    CHECK (length(create_fingerprint) >= 1 AND length(create_fingerprint) <= 128),
    created_by      uuid        REFERENCES users(user_id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    -- THE immutable-version fence: re-publication of the same
    -- (publisher, pack_key, version) is a constraint violation; a new
    -- version is a new row.
    CONSTRAINT domain_packs_version_unique UNIQUE (publisher, pack_key, version)
);

-- Registry listing surfaces: by pack key (all versions, newest first)
-- and by publisher.
CREATE INDEX IF NOT EXISTS domain_packs_key_idx
    ON domain_packs (pack_key, created_at DESC, pack_id);
CREATE INDEX IF NOT EXISTS domain_packs_publisher_idx
    ON domain_packs (publisher, created_at DESC);

-- PUBLISHED PACK VERSIONS ARE IMMUTABLE (domain-pack-v1.3.md §4 +
-- implementation-contract §3): NO column of a published version can ever
-- change — semantic change requires a NEW version. This trigger rejects
-- every UPDATE outright (the row is born complete; updated_at never moves
-- either). DELETE is likewise rejected: registry history is permanent.
CREATE OR REPLACE FUNCTION domain_packs_registry_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'domain pack registry rows are immutable (published version % of % %): % is rejected — publish a NEW version instead',
        OLD.version, OLD.publisher, OLD.pack_key, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS domain_packs_registry_immutable_update_trigger ON domain_packs;
CREATE TRIGGER domain_packs_registry_immutable_update_trigger
BEFORE UPDATE ON domain_packs
FOR EACH ROW EXECUTE FUNCTION domain_packs_registry_immutable();

DROP TRIGGER IF EXISTS domain_packs_registry_immutable_delete_trigger ON domain_packs;
CREATE TRIGGER domain_packs_registry_immutable_delete_trigger
BEFORE DELETE ON domain_packs
FOR EACH ROW EXECUTE FUNCTION domain_packs_registry_immutable();

-- ---------------------------------------------------------------------------
-- domain_pack_installs — the installed-version records (PACK-AC-01)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS domain_pack_installs (
    install_id      uuid        PRIMARY KEY,
    pack_id         uuid        NOT NULL REFERENCES domain_packs(pack_id),
    -- The canonical scope chain (server-derived at install from the
    -- workspace's canonical ownership, immutable): the client must
    -- belong to the agency and the workspace to the client (triggers
    -- below — the Client boundary cannot be crossed through these
    -- columns).
    agency_id       uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id       uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id    uuid        NOT NULL REFERENCES workspaces(workspace_id),
    status          text        NOT NULL DEFAULT 'installed'
                    CHECK (status IN ('installed', 'disabled', 'uninstalled')),
    idempotency_key text        NOT NULL
                    CHECK (length(idempotency_key) >= 1 AND length(idempotency_key) <= 200),
    version         bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_by      uuid        REFERENCES users(user_id),
    uninstalled_at  timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    -- ONE install per (workspace, pack version): a duplicate logical
    -- install command converges; a different command under the same
    -- fence is a conflict (module-classified).
    CONSTRAINT domain_pack_installs_workspace_pack_unique
        UNIQUE (workspace_id, pack_id)
);

-- Listing surfaces: the installs of one workspace (every state —
-- terminal history stays visible) and the installs of one pack version.
CREATE INDEX IF NOT EXISTS domain_pack_installs_workspace_idx
    ON domain_pack_installs (workspace_id, created_at DESC, install_id);
CREATE INDEX IF NOT EXISTS domain_pack_installs_pack_idx
    ON domain_pack_installs (pack_id, status);
CREATE INDEX IF NOT EXISTS domain_pack_installs_agency_idx
    ON domain_pack_installs (agency_id, client_id);

-- The scope-chain fence: the client must belong to the agency AND the
-- workspace to the client — enforced on INSERT and on any scope-column
-- UPDATE (the columns are also frozen by the immutability trigger).
CREATE OR REPLACE FUNCTION domain_pack_installs_scope_legal() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM clients c
        WHERE c.client_id = NEW.client_id AND c.agency_id = NEW.agency_id) THEN
        RAISE EXCEPTION 'domain pack install % client % does not belong to agency % — the install scope cannot cross the Client boundary',
            NEW.install_id, NEW.client_id, NEW.agency_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM workspaces w
        WHERE w.workspace_id = NEW.workspace_id AND w.client_id = NEW.client_id) THEN
        RAISE EXCEPTION 'domain pack install % workspace % does not belong to client % — the install scope cannot cross the Workspace boundary',
            NEW.install_id, NEW.workspace_id, NEW.client_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS domain_pack_installs_scope_legal_trigger ON domain_pack_installs;
CREATE TRIGGER domain_pack_installs_scope_legal_trigger
BEFORE INSERT OR UPDATE OF agency_id, client_id, workspace_id ON domain_pack_installs
FOR EACH ROW EXECUTE FUNCTION domain_pack_installs_scope_legal();

-- Install identity/scope immutability: the pinned pack version, the
-- canonical scope, the idempotency identity and the provenance can NEVER
-- be reassigned. Only the lifecycle state, the CAS token/updated_at and
-- the uninstall timestamp ever change.
CREATE OR REPLACE FUNCTION domain_pack_installs_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW.install_id <> OLD.install_id THEN
        RAISE EXCEPTION 'install_id % is immutable', OLD.install_id;
    END IF;
    IF NEW.pack_id <> OLD.pack_id THEN
        RAISE EXCEPTION 'install % pinned pack version is immutable', OLD.install_id;
    END IF;
    IF NEW.agency_id <> OLD.agency_id OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id <> OLD.workspace_id THEN
        RAISE EXCEPTION 'install % ownership scope is immutable (was %/%/%)',
            OLD.install_id, OLD.agency_id, OLD.client_id, OLD.workspace_id;
    END IF;
    IF NEW.idempotency_key <> OLD.idempotency_key THEN
        RAISE EXCEPTION 'install % idempotency identity is immutable', OLD.install_id;
    END IF;
    IF NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'install % provenance is immutable', OLD.install_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS domain_pack_installs_immutable_trigger ON domain_pack_installs;
CREATE TRIGGER domain_pack_installs_immutable_trigger
BEFORE UPDATE ON domain_pack_installs
FOR EACH ROW EXECUTE FUNCTION domain_pack_installs_immutable();

-- The frozen install lifecycle: rows are born 'installed'; every UPDATE
-- transition must be a frozen edge; 'uninstalled' is TERMINAL (no
-- resurrection) and must carry uninstalled_at; every other status
-- carries NULL.
CREATE OR REPLACE FUNCTION domain_pack_installs_lifecycle_legal() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'installed' THEN
            RAISE EXCEPTION 'a domain pack install is born installed (got %)', NEW.status;
        END IF;
        IF NEW.uninstalled_at IS NOT NULL THEN
            RAISE EXCEPTION 'a fresh domain pack install must not carry uninstalled_at';
        END IF;
        RETURN NEW;
    END IF;
    -- UPDATE: uninstalled is terminal — reject every change.
    IF OLD.status = 'uninstalled' THEN
        RAISE EXCEPTION 'install % is uninstalled and terminal', OLD.install_id;
    END IF;
    IF NOT (
        (OLD.status = 'installed' AND NEW.status IN ('disabled', 'uninstalled')) OR
        (OLD.status = 'disabled' AND NEW.status IN ('installed', 'uninstalled'))
    ) THEN
        RAISE EXCEPTION 'illegal domain pack install transition % → % (the frozen lifecycle is installed ⇄ disabled, with the terminal uninstall edge)',
            OLD.status, NEW.status;
    END IF;
    IF NEW.status = 'uninstalled' THEN
        IF NEW.uninstalled_at IS NULL THEN
            RAISE EXCEPTION 'install % uninstalled rows must carry uninstalled_at', NEW.install_id;
        END IF;
    ELSE
        IF NEW.uninstalled_at IS NOT NULL THEN
            RAISE EXCEPTION 'install % active rows must not carry uninstalled_at', NEW.install_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS domain_pack_installs_lifecycle_legal_trigger ON domain_pack_installs;
CREATE TRIGGER domain_pack_installs_lifecycle_legal_trigger
BEFORE INSERT OR UPDATE OF status ON domain_pack_installs
FOR EACH ROW EXECUTE FUNCTION domain_pack_installs_lifecycle_legal();

-- ---------------------------------------------------------------------------
-- domain_pack_artifacts — the per-install artifact scope records
-- (PACK-AC-03: the explicit Client-scoped vs Agency-scoped-reusable
-- distinction, materialized against the installing context)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS domain_pack_artifacts (
    artifact_id     uuid        PRIMARY KEY,
    install_id      uuid        NOT NULL REFERENCES domain_pack_installs(install_id),
    pack_id         uuid        NOT NULL REFERENCES domain_packs(pack_id),
    -- The closed §2 artifact-kind vocabulary (mirrors the registry CHECK).
    artifact_kind   text        NOT NULL
                    CHECK (artifact_kind IN (
                        'domain-entity', 'view', 'goal-definition', 'metric-definition',
                        'playbook-template', 'workflow-template', 'ai-capability',
                        'human-capability', 'policy', 'integration-binding',
                        'extension-binding', 'evidence-schema', 'evaluator',
                        'ui-surface')),
    artifact_name   text        NOT NULL
                    CHECK (length(artifact_name) >= 1 AND length(artifact_name) <= 64),
    -- The §5 explicit scope distinction: 'client' = pack-owned Client
    -- data confined to the installing Client boundary (client_id NOT
    -- NULL); 'agency-reusable' = explicitly-declared Agency-scoped
    -- reusable artifact (client_id NULL — reachable within the agency).
    scope           text        NOT NULL
                    CHECK (scope IN ('client', 'agency-reusable')),
    -- The resolved access boundary (server-derived at materialization,
    -- immutable): the installing agency; the installing client iff
    -- Client-scoped.
    agency_id       uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id       uuid        REFERENCES clients(client_id),
    -- The materializing install's workspace (provenance of
    -- materialization; the workspace listing surface).
    workspace_id    uuid        NOT NULL REFERENCES workspaces(workspace_id),
    -- THE PACK-AC-03 structural fence: a Client-scoped artifact record
    -- REQUIRES its client; an Agency-scoped reusable artifact record is
    -- client-less. The two scopes are indistinguishable nowhere — the
    -- distinction is explicit in every record.
    CONSTRAINT domain_pack_artifacts_scope_shape CHECK (
        (scope = 'client' AND client_id IS NOT NULL)
        OR (scope = 'agency-reusable' AND client_id IS NULL)
    ),
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- One materialized record per (install, kind, name).
    CONSTRAINT domain_pack_artifacts_install_kind_name_unique
        UNIQUE (install_id, artifact_kind, artifact_name)
);

-- Listing surfaces: the artifacts materialized in one workspace (the
-- workspace's own install artifacts, both scopes); the AGENCY-scoped
-- reusable artifact surface (agency_id + scope='agency-reusable' only —
-- the explicit distinction in queries); per-client resolution.
CREATE INDEX IF NOT EXISTS domain_pack_artifacts_workspace_idx
    ON domain_pack_artifacts (workspace_id, created_at, artifact_id);
CREATE INDEX IF NOT EXISTS domain_pack_artifacts_agency_scope_idx
    ON domain_pack_artifacts (agency_id, scope, created_at, artifact_id);
CREATE INDEX IF NOT EXISTS domain_pack_artifacts_client_idx
    ON domain_pack_artifacts (client_id, scope);
CREATE INDEX IF NOT EXISTS domain_pack_artifacts_install_idx
    ON domain_pack_artifacts (install_id, artifact_kind, artifact_name);

-- The artifact CONSISTENCY fence: the artifact's install must pin the
-- SAME pack version in the SAME workspace; a client-scoped artifact's
-- client must equal the install's client; every artifact's agency must
-- equal the install's agency — an artifact record can never be recorded
-- against crossed install rows, even by direct SQL.
CREATE OR REPLACE FUNCTION domain_pack_artifacts_consistent() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM domain_pack_installs i
        WHERE i.install_id = NEW.install_id
          AND i.pack_id = NEW.pack_id
          AND i.workspace_id = NEW.workspace_id
          AND i.agency_id = NEW.agency_id
    ) THEN
        RAISE EXCEPTION 'artifact % install % must pin the same pack version in the same workspace and agency',
            NEW.artifact_id, NEW.install_id;
    END IF;
    IF NEW.scope = 'client' AND NOT EXISTS (
        SELECT 1 FROM domain_pack_installs i
        WHERE i.install_id = NEW.install_id
          AND i.client_id = NEW.client_id
    ) THEN
        RAISE EXCEPTION 'client-scoped artifact % must carry its install % client — pack-owned Client data cannot cross the Client boundary',
            NEW.artifact_id, NEW.install_id;
    END IF;
    IF NEW.scope = 'agency-reusable' AND NEW.client_id IS NOT NULL THEN
        RAISE EXCEPTION 'agency-reusable artifact % must not carry a client (the §5 explicit distinction)',
            NEW.artifact_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS domain_pack_artifacts_consistent_trigger ON domain_pack_artifacts;
CREATE TRIGGER domain_pack_artifacts_consistent_trigger
BEFORE INSERT ON domain_pack_artifacts
FOR EACH ROW EXECUTE FUNCTION domain_pack_artifacts_consistent();

-- APPEND-ONLY backstop (the migration 015/018/025/028 pattern): the
-- database itself rejects UPDATE and DELETE on artifact scope records.
-- Cross-client re-parenting is therefore IMPOSSIBLE at the storage
-- layer — a Client-scoped artifact record can never be mutated onto
-- another Client (PACK-AC-03 DB backstop), and the scope distinction
-- can never be rewritten after materialization.
CREATE OR REPLACE FUNCTION domain_pack_artifacts_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'domain pack artifacts are append-only: % is rejected on artifact %',
        TG_OP, OLD.artifact_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS domain_pack_artifacts_append_only_update_trigger ON domain_pack_artifacts;
CREATE TRIGGER domain_pack_artifacts_append_only_update_trigger
BEFORE UPDATE ON domain_pack_artifacts
FOR EACH ROW EXECUTE FUNCTION domain_pack_artifacts_append_only();

DROP TRIGGER IF EXISTS domain_pack_artifacts_append_only_delete_trigger ON domain_pack_artifacts;
CREATE TRIGGER domain_pack_artifacts_append_only_delete_trigger
BEFORE DELETE ON domain_pack_artifacts
FOR EACH ROW EXECUTE FUNCTION domain_pack_artifacts_append_only();
