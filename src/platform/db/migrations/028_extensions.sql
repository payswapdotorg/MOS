-- MKT-022 Extension registry and manifest contract schema (EXT-001).
-- PostgreSQL is the system of record (spec/architecture-lock.md).
--
-- Table ownership follows the frozen authority map (implementation-contract
-- §1): "Extension registry/invocation contract → /extensions" — ALL THREE
-- tables here:
--   extensions             → the immutable versioned MANIFEST registry
--   extension_installs     → the install/configure lifecycle records
--   extension_invocations  → the append-only invocation ledger (Observe)
--
-- Frozen semantics encoded here (spec/requirements.md EXT-001 "Provide
-- versioned extension manifests, permissions, configuration, installation
-- and invocation contracts"; spec/extension-model.md §2 manifest, §3
-- capability categories, §4 lifecycle, §5 permissions; spec/
-- implementation-contract.md §19 "An extension has a stable publisher +
-- extension ID + version. Versions are immutable"; §3 "No externally
-- supplied field may override a server-derived actor, owner, provenance,
-- policy decision, or evidence authority value"; §21 "secrets may never
-- appear ... in durable extension input blobs"; §25 database backstops):
--
-- * THE IMMUTABLE-VERSION REGISTRY: (publisher, extension_key, version) is
--   UNIQUE — re-registration of the same version converges to a
--   constraint violation (a ConflictError upstream; never a silent
--   rewrite), and a new version is a NEW row. Published manifest content
--   is IMMUTABLE through EVERY mutation path (trigger): publication is
--   the "Publish" step of extension-model.md §4 and corrections publish a
--   NEW version. The registry row carries NO tenant columns at all — an
--   extension version is global catalog state.
-- * THE CLOSED VOCABULARIES (extension-model.md §3 + §5): capability
--   category, permission action and data scope are DB CHECKs on the
--   closed sets. The permission vocabulary contains NO workflow-state,
--   credential-creation, evidence-provenance or audit action — those
--   powers are not declarable, even by direct SQL (EXT-AC-03/EXT-AC-04
--   posture at the storage layer).
-- * CRED-001 POSTURE: required secret names are LOGICAL LABELS; secret
--   bindings map logical names to credential REFERENCE ids; the manifest
--   and every install/invocation payload is CHECKed against
--   material-shaped keys — there is deliberately NO column capable of
--   holding secret material or a secret handle anywhere in this
--   migration.
-- * THE INSTALL SCOPE CHAIN (implementation-contract §2): agency →
--   client → workspace are re-fenced by triggers (the client must belong
--   to the agency; the workspace to the client) — the Client boundary
--   cannot be crossed through the install columns even by direct SQL.
--   Scope, extension_id and granted_scopes are IMMUTABLE after install
--   (a wider grant is a new install — the append-oriented posture).
-- * THE INSTALL LIFECYCLE (extension-model.md §4 install subset): status
--   is born 'installed'; the frozen transition table is DB-enforced
--   (installed → configured | uninstalled; configured → authorized |
--   configured | uninstalled; authorized → configured | disabled |
--   uninstalled; disabled → authorized | uninstalled); 'uninstalled' is
--   TERMINAL (tombstone — no resurrection, identifiers never replay).
-- * THE INVOCATION LEDGER is APPEND-ONLY (the migration 015/018/025
--   pattern): UPDATE and DELETE are rejected by triggers. Every row
--   carries SERVER-DERIVED provenance (recorded_actor/recorded_via/
--   correlation_id/causation_id + issued_at/expires_at/recorded_at).
--   The context TTL is DB-fenced (strictly positive, at most one hour).
--   Cross-row consistency is DB-enforced: the invocation's scope must
--   equal the referenced execution's canonical scope, and the referenced
--   install must live in the SAME workspace and pin the SAME extension
--   version — an invocation context can never be recorded against
--   crossed tenant or install rows.
-- * NO WORKFLOW/EXECUTION MUTATION: this migration creates NO workflow
--   table, NO workflow-state column and NO trigger that touches
--   workflow_instances or workflow tables (EXT-AC-03 — /workflows stays
--   the only workflow-state authority; the executions table is read via
--   FK + consistency triggers only).
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, created_at/updated_at, version CAS for concurrent mutation.
-- No owner/role/user columns beyond provenance: install authorization stays
-- exactly the /agencies membership authority composed with canonical
-- /workspaces owner resolution — no second tenant, permission, workflow,
-- execution, credential or audit authority. No provider SDK coupling, no
-- Developer Portal tables (MKT-032), no provider extension rows (MKT-024),
-- no domain pack tables (MKT-036).

-- ---------------------------------------------------------------------------
-- Shape validators (IMMUTABLE so they can serve CHECK constraints)
-- ---------------------------------------------------------------------------

-- The material-shape validator (the migration-025 pattern): rejects
-- material-shaped keys at every nesting level of an extension payload —
-- the storage-side half of the §21 contract (manifests, config values,
-- invocation inputs and capability/permission descriptors are all
-- fenced).
CREATE OR REPLACE FUNCTION extensions_payload_has_no_material_keys(payload jsonb)
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
            IF NOT extensions_payload_has_no_material_keys(elem) THEN
                RETURN false;
            END IF;
        END LOOP;
    ELSIF jsonb_typeof(payload) = 'array' THEN
        FOR elem IN SELECT a.value FROM jsonb_array_elements(payload) a LOOP
            IF NOT extensions_payload_has_no_material_keys(elem) THEN
                RETURN false;
            END IF;
        END LOOP;
    END IF;
    RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- The capability-list validator: non-empty bounded array of EXACTLY
-- { category, name } descriptors; category is the closed §3 set; names
-- are unique within the list (one capability name = one invocable unit).
CREATE OR REPLACE FUNCTION extensions_capabilities_valid(capabilities jsonb)
RETURNS boolean AS $$
DECLARE
    elem jsonb;
    key_count integer;
    name text;
    seen_names text[] := ARRAY[]::text[];
BEGIN
    IF jsonb_typeof(capabilities) <> 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(capabilities) < 1 OR jsonb_array_length(capabilities) > 32 THEN
        RETURN false;
    END IF;
    FOR elem IN SELECT * FROM jsonb_array_elements(capabilities) LOOP
        IF jsonb_typeof(elem) <> 'object' THEN RETURN false; END IF;
        SELECT count(*) INTO key_count FROM jsonb_object_keys(elem);
        IF key_count <> 2 THEN RETURN false; END IF;
        IF NOT (elem ? 'category') OR NOT (elem ? 'name') THEN RETURN false; END IF;
        IF jsonb_typeof(elem->'category') <> 'string' OR NOT (elem->>'category' IN (
               'data-source', 'research-discovery', 'content-creative-generation',
               'execution-action', 'measurement', 'crm-commerce-integration',
               'field-acquisition', 'ai-capability', 'approval-ui-surface')) THEN
            RETURN false;
        END IF;
        IF jsonb_typeof(elem->'name') <> 'string' THEN RETURN false; END IF;
        name := elem->>'name';
        IF length(name) < 1 OR length(name) > 64 THEN RETURN false; END IF;
        IF seen_names @> ARRAY[name] THEN RETURN false; END IF;
        seen_names := seen_names || name;
    END LOOP;
    RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- The permission-list validator: non-empty bounded array of EXACTLY
-- { action, resource } declarations; action is the closed §5 least-
-- privilege vocabulary (NO workflow/credential/evidence/audit action
-- exists in the set); resource is null or a bounded string.
CREATE OR REPLACE FUNCTION extensions_permissions_valid(permissions jsonb)
RETURNS boolean AS $$
DECLARE
    elem jsonb;
    key_count integer;
BEGIN
    IF jsonb_typeof(permissions) <> 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(permissions) < 1 OR jsonb_array_length(permissions) > 64 THEN
        RETURN false;
    END IF;
    FOR elem IN SELECT * FROM jsonb_array_elements(permissions) LOOP
        IF jsonb_typeof(elem) <> 'object' THEN RETURN false; END IF;
        SELECT count(*) INTO key_count FROM jsonb_object_keys(elem);
        IF key_count < 2 OR key_count > 3 THEN RETURN false; END IF;
        IF NOT (elem ? 'action') OR NOT (elem ? 'resource') THEN RETURN false; END IF;
        IF jsonb_typeof(elem->'action') <> 'string' OR NOT (elem->>'action' IN (
               'data:read', 'data:write', 'network:egress', 'secret:use')) THEN
            RETURN false;
        END IF;
        IF jsonb_typeof(elem->'resource') = 'null' THEN
            NULL; -- resource null is legal
        ELSIF jsonb_typeof(elem->'resource') <> 'string'
              OR length(elem->>'resource') < 1
              OR length(elem->>'resource') > 256 THEN
            RETURN false;
        END IF;
    END LOOP;
    RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- The data-scope validator: bounded unique array of the closed scope
-- vocabulary (client:read / client:write / workspace:read / workspace:write).
CREATE OR REPLACE FUNCTION extensions_data_scopes_valid(scopes jsonb)
RETURNS boolean AS $$
DECLARE
    elem jsonb;
    scope text;
    seen text[] := ARRAY[]::text[];
BEGIN
    IF jsonb_typeof(scopes) <> 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(scopes) > 8 THEN RETURN false; END IF;
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

-- The required-secret-names validator: bounded unique array of LOGICAL
-- labels (uppercase snake case). Values are never storable here.
CREATE OR REPLACE FUNCTION extensions_secret_names_valid(names jsonb)
RETURNS boolean AS $$
DECLARE
    elem jsonb;
    label text;
    seen text[] := ARRAY[]::text[];
BEGIN
    IF jsonb_typeof(names) <> 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(names) > 16 THEN RETURN false; END IF;
    FOR elem IN SELECT * FROM jsonb_array_elements(names) LOOP
        IF jsonb_typeof(elem) <> 'string' THEN RETURN false; END IF;
        label := elem#>>'{}';
        IF label !~ '^[A-Z][A-Z0-9_]{2,47}$' THEN RETURN false; END IF;
        IF seen @> ARRAY[label] THEN RETURN false; END IF;
        seen := seen || label;
    END LOOP;
    RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- The network-requirements validator: bounded array of EXACTLY
-- { host, protocol, port, reason } declarations.
CREATE OR REPLACE FUNCTION extensions_network_requirements_valid(requirements jsonb)
RETURNS boolean AS $$
DECLARE
    elem jsonb;
    key_count integer;
    port_num integer;
BEGIN
    IF jsonb_typeof(requirements) <> 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(requirements) > 16 THEN RETURN false; END IF;
    FOR elem IN SELECT * FROM jsonb_array_elements(requirements) LOOP
        IF jsonb_typeof(elem) <> 'object' THEN RETURN false; END IF;
        SELECT count(*) INTO key_count FROM jsonb_object_keys(elem);
        IF key_count <> 4 THEN RETURN false; END IF;
        IF NOT (elem ? 'host') OR NOT (elem ? 'protocol') OR NOT (elem ? 'port') OR NOT (elem ? 'reason') THEN
            RETURN false;
        END IF;
        IF jsonb_typeof(elem->'host') <> 'string'
           OR length(elem->>'host') < 1 OR length(elem->>'host') > 253 THEN RETURN false; END IF;
        IF jsonb_typeof(elem->'protocol') <> 'string'
           OR length(elem->>'protocol') < 1 OR length(elem->>'protocol') > 16 THEN RETURN false; END IF;
        IF jsonb_typeof(elem->'port') <> 'number' THEN RETURN false; END IF;
        port_num := (elem->>'port')::integer;
        IF port_num < 1 OR port_num > 65535 THEN RETURN false; END IF;
        IF jsonb_typeof(elem->'reason') <> 'string'
           OR length(elem->>'reason') < 1 OR length(elem->>'reason') > 256 THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- The labels validator (event subscriptions / UI surfaces): bounded
-- unique string arrays.
CREATE OR REPLACE FUNCTION extensions_labels_valid(labels jsonb)
RETURNS boolean AS $$
DECLARE
    elem jsonb;
    label text;
    seen text[] := ARRAY[]::text[];
BEGIN
    IF jsonb_typeof(labels) <> 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(labels) > 32 THEN RETURN false; END IF;
    FOR elem IN SELECT * FROM jsonb_array_elements(labels) LOOP
        IF jsonb_typeof(elem) <> 'string' THEN RETURN false; END IF;
        label := elem#>>'{}';
        IF length(label) < 1 OR length(label) > 64 THEN RETURN false; END IF;
        IF seen @> ARRAY[label] THEN RETURN false; END IF;
        seen := seen || label;
    END LOOP;
    RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- The config-contract validator: bounded object of field name → EXACTLY
-- { type, required, description, pattern } field contracts.
CREATE OR REPLACE FUNCTION extensions_config_contract_valid(contract jsonb)
RETURNS boolean AS $$
DECLARE
    field_key text;
    field_value jsonb;
    key_count integer;
BEGIN
    IF jsonb_typeof(contract) <> 'object' THEN RETURN false; END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(contract)) > 32 THEN RETURN false; END IF;
    FOR field_key, field_value IN SELECT * FROM jsonb_each(contract) LOOP
        IF length(field_key) < 1 OR length(field_key) > 64 THEN RETURN false; END IF;
        IF jsonb_typeof(field_value) <> 'object' THEN RETURN false; END IF;
        SELECT count(*) INTO key_count FROM jsonb_object_keys(field_value);
        IF key_count <> 4 THEN RETURN false; END IF;
        IF NOT (field_value ? 'type') OR NOT (field_value ? 'required')
           OR NOT (field_value ? 'description') OR NOT (field_value ? 'pattern') THEN
            RETURN false;
        END IF;
        IF jsonb_typeof(field_value->'type') <> 'string' OR NOT (field_value->>'type' IN (
               'string', 'number', 'boolean', 'object')) THEN RETURN false; END IF;
        IF jsonb_typeof(field_value->'required') <> 'boolean' THEN RETURN false; END IF;
        IF jsonb_typeof(field_value->'description') <> 'string'
           OR length(field_value->>'description') < 1
           OR length(field_value->>'description') > 512 THEN RETURN false; END IF;
        IF jsonb_typeof(field_value->'pattern') = 'null' THEN
            NULL; -- pattern null is legal
        ELSIF jsonb_typeof(field_value->'pattern') <> 'string'
              OR length(field_value->>'pattern') < 1
              OR length(field_value->>'pattern') > 256 THEN
            RETURN false;
        END IF;
    END LOOP;
    RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- The secret-bindings validator: bounded object mapping LOGICAL names to
-- credential REFERENCE ids (bounded strings) — never material.
CREATE OR REPLACE FUNCTION extensions_secret_bindings_valid(bindings jsonb)
RETURNS boolean AS $$
DECLARE
    binding_key text;
    binding_value jsonb;
BEGIN
    IF jsonb_typeof(bindings) <> 'object' THEN RETURN false; END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(bindings)) > 16 THEN RETURN false; END IF;
    FOR binding_key, binding_value IN SELECT * FROM jsonb_each(bindings) LOOP
        IF length(binding_key) < 1 OR length(binding_key) > 64 THEN RETURN false; END IF;
        IF jsonb_typeof(binding_value) <> 'string'
           OR length(binding_value#>>'{}') < 1
           OR length(binding_value#>>'{}') > 64 THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ---------------------------------------------------------------------------
-- extensions — the immutable versioned manifest registry
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS extensions (
    extension_id     uuid        PRIMARY KEY,
    extension_key    text        NOT NULL
                     CHECK (extension_key ~ '^[a-z][a-z0-9-]{1,62}$'),
    publisher        text        NOT NULL
                     CHECK (publisher ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
    version          text        NOT NULL
                     CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]{1,32})?$'),
    -- The platform compatibility range (inclusive labels).
    compat_min       text        NOT NULL
                     CHECK (length(compat_min) >= 1 AND length(compat_min) <= 32),
    compat_max       text        NOT NULL
                     CHECK (length(compat_max) >= 1 AND length(compat_max) <= 32),
    -- The §3 capability list (closed categories, unique names).
    capabilities     jsonb       NOT NULL
                     CHECK (extensions_capabilities_valid(capabilities))
                     CHECK (extensions_payload_has_no_material_keys(capabilities)),
    -- The §5 least-privilege permission list (closed action vocabulary).
    permissions      jsonb       NOT NULL
                     CHECK (extensions_permissions_valid(permissions))
                     CHECK (extensions_payload_has_no_material_keys(permissions)),
    -- Required secrets BY LOGICAL NAME (never values — CRED-001).
    required_secret_names jsonb  NOT NULL DEFAULT '[]'::jsonb
                     CHECK (extensions_secret_names_valid(required_secret_names)),
    -- Declared data scopes (closed vocabulary; granted subset at install).
    data_scopes      jsonb       NOT NULL DEFAULT '[]'::jsonb
                     CHECK (extensions_data_scopes_valid(data_scopes)),
    -- Declared network requirements (policy-gated at use, not here).
    network_requirements jsonb   NOT NULL DEFAULT '[]'::jsonb
                     CHECK (extensions_network_requirements_valid(network_requirements))
                     CHECK (extensions_payload_has_no_material_keys(network_requirements)),
    -- The frozen runtime class (implementation-contract §9).
    runtime_class    text        NOT NULL
                     CHECK (runtime_class IN ('pooled-worker', 'ephemeral-sandbox',
                                              'persistent-sandbox', 'dedicated-runtime')),
    input_contract   jsonb       NOT NULL
                     CHECK (jsonb_typeof(input_contract) = 'object')
                     CHECK (extensions_payload_has_no_material_keys(input_contract)),
    output_contract  jsonb       NOT NULL
                     CHECK (jsonb_typeof(output_contract) = 'object')
                     CHECK (extensions_payload_has_no_material_keys(output_contract)),
    event_subscriptions jsonb    NOT NULL DEFAULT '[]'::jsonb
                     CHECK (extensions_labels_valid(event_subscriptions)),
    ui_surfaces      jsonb       NOT NULL DEFAULT '[]'::jsonb
                     CHECK (extensions_labels_valid(ui_surfaces)),
    -- The configuration contract install config values are validated against.
    config_contract  jsonb       NOT NULL DEFAULT '{}'::jsonb
                     CHECK (extensions_config_contract_valid(config_contract))
                     CHECK (extensions_payload_has_no_material_keys(config_contract)),
    -- The §8-style logical register command identity (convergence proof).
    idempotency_key  text        NOT NULL
                     CHECK (length(idempotency_key) >= 1 AND length(idempotency_key) <= 200),
    create_fingerprint text      NOT NULL
                     CHECK (length(create_fingerprint) >= 1 AND length(create_fingerprint) <= 128),
    created_by       uuid        REFERENCES users(user_id),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    -- THE immutable-version fence: re-registration of the same
    -- (publisher, key, version) is a constraint violation; a new version
    -- is a new row.
    CONSTRAINT extensions_version_unique UNIQUE (publisher, extension_key, version)
);

-- Registry listing surfaces: by extension key (all versions, newest
-- first) and by publisher.
CREATE INDEX IF NOT EXISTS extensions_key_idx
    ON extensions (extension_key, created_at DESC, extension_id);
CREATE INDEX IF NOT EXISTS extensions_publisher_idx
    ON extensions (publisher, created_at DESC);

-- PUBLISHED MANIFESTS ARE IMMUTABLE (extension-model.md §2/§4 +
-- implementation-contract §19): NO column of a published version can ever
-- change — corrections publish a NEW version. This trigger rejects every
-- UPDATE outright (the row is born complete; updated_at never moves
-- either). DELETE is likewise rejected: registry history is permanent.
CREATE OR REPLACE FUNCTION extensions_registry_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'extension registry rows are immutable (published version % of % %): % is rejected — publish a NEW version instead',
        OLD.version, OLD.publisher, OLD.extension_key, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS extensions_registry_immutable_update_trigger ON extensions;
CREATE TRIGGER extensions_registry_immutable_update_trigger
BEFORE UPDATE ON extensions
FOR EACH ROW EXECUTE FUNCTION extensions_registry_immutable();

DROP TRIGGER IF EXISTS extensions_registry_immutable_delete_trigger ON extensions;
CREATE TRIGGER extensions_registry_immutable_delete_trigger
BEFORE DELETE ON extensions
FOR EACH ROW EXECUTE FUNCTION extensions_registry_immutable();

-- ---------------------------------------------------------------------------
-- extension_installs — the install/configure lifecycle records
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS extension_installs (
    install_id      uuid        PRIMARY KEY,
    extension_id    uuid        NOT NULL REFERENCES extensions(extension_id),
    -- The canonical scope chain (server-derived at install, immutable):
    -- the client must belong to the agency and the workspace to the
    -- client (triggers below — the Client boundary cannot be crossed
    -- through these columns).
    agency_id       uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id       uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id    uuid        NOT NULL REFERENCES workspaces(workspace_id),
    status          text        NOT NULL DEFAULT 'installed'
                    CHECK (status IN ('installed', 'configured', 'authorized',
                                      'disabled', 'uninstalled')),
    -- Configuration values (validated against the extension's config
    -- contract by the module; material-shaped keys are never storable).
    config          jsonb       NOT NULL DEFAULT '{}'::jsonb
                    CHECK (jsonb_typeof(config) = 'object')
                    CHECK (extensions_payload_has_no_material_keys(config)),
    -- LOGICAL NAME → credential REFERENCE id (never material — CRED-001).
    secret_bindings jsonb       NOT NULL DEFAULT '{}'::jsonb
                    CHECK (extensions_secret_bindings_valid(secret_bindings)),
    -- The granted data scopes (⊆ the extension's declared scopes;
    -- immutable after install — a wider grant is a new install).
    granted_scopes  jsonb       NOT NULL DEFAULT '[]'::jsonb
                    CHECK (extensions_data_scopes_valid(granted_scopes)),
    idempotency_key text        NOT NULL
                    CHECK (length(idempotency_key) >= 1 AND length(idempotency_key) <= 200),
    version         bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_by      uuid        REFERENCES users(user_id),
    uninstalled_at  timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    -- ONE install per (workspace, extension version): a duplicate
    -- logical install command converges; a different command under the
    -- same key is a conflict (module-classified).
    CONSTRAINT extension_installs_workspace_extension_unique
        UNIQUE (workspace_id, extension_id)
);

-- Listing surfaces: the installs of one workspace (every state — terminal
-- history stays visible) and the installs of one extension version.
CREATE INDEX IF NOT EXISTS extension_installs_workspace_idx
    ON extension_installs (workspace_id, created_at DESC, install_id);
CREATE INDEX IF NOT EXISTS extension_installs_extension_idx
    ON extension_installs (extension_id, status);

-- The scope-chain fence: the client must belong to the agency AND the
-- workspace to the client — enforced on INSERT and on any scope-column
-- UPDATE (the columns are also frozen by the immutability trigger).
CREATE OR REPLACE FUNCTION extension_installs_scope_legal() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM clients c
        WHERE c.client_id = NEW.client_id AND c.agency_id = NEW.agency_id) THEN
        RAISE EXCEPTION 'extension install % client % does not belong to agency % — the install scope cannot cross the Client boundary',
            NEW.install_id, NEW.client_id, NEW.agency_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM workspaces w
        WHERE w.workspace_id = NEW.workspace_id AND w.client_id = NEW.client_id) THEN
        RAISE EXCEPTION 'extension install % workspace % does not belong to client % — the install scope cannot cross the Workspace boundary',
            NEW.install_id, NEW.workspace_id, NEW.client_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS extension_installs_scope_legal_trigger ON extension_installs;
CREATE TRIGGER extension_installs_scope_legal_trigger
BEFORE INSERT OR UPDATE OF agency_id, client_id, workspace_id ON extension_installs
FOR EACH ROW EXECUTE FUNCTION extension_installs_scope_legal();

-- Install identity/scope/grant immutability: the pinned extension
-- version, the canonical scope, the granted scopes, the idempotency
-- identity and the provenance can NEVER be reassigned. Only the
-- lifecycle state, the configuration values (configure/reconfigure) and
-- the CAS token/updated_at ever change.
CREATE OR REPLACE FUNCTION extension_installs_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW.install_id <> OLD.install_id THEN
        RAISE EXCEPTION 'install_id % is immutable', OLD.install_id;
    END IF;
    IF NEW.extension_id <> OLD.extension_id THEN
        RAISE EXCEPTION 'install % pinned extension version is immutable', OLD.install_id;
    END IF;
    IF NEW.agency_id <> OLD.agency_id OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id <> OLD.workspace_id THEN
        RAISE EXCEPTION 'install % ownership scope is immutable (was %/%/%)',
            OLD.install_id, OLD.agency_id, OLD.client_id, OLD.workspace_id;
    END IF;
    IF NEW.granted_scopes IS DISTINCT FROM OLD.granted_scopes THEN
        RAISE EXCEPTION 'install % granted scopes are immutable (a wider or different grant is a new install)',
            OLD.install_id;
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

DROP TRIGGER IF EXISTS extension_installs_immutable_trigger ON extension_installs;
CREATE TRIGGER extension_installs_immutable_trigger
BEFORE UPDATE ON extension_installs
FOR EACH ROW EXECUTE FUNCTION extension_installs_immutable();

-- The frozen install lifecycle (extension-model.md §4 install subset):
-- rows are born 'installed'; every UPDATE transition must be a frozen
-- edge; 'uninstalled' is TERMINAL (no resurrection) and must carry
-- uninstalled_at; every other status carries NULL.
CREATE OR REPLACE FUNCTION extension_installs_lifecycle_legal() RETURNS trigger AS $$
DECLARE
    legal_targets constant text[] := ARRAY[]::text[];
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'installed' THEN
            RAISE EXCEPTION 'an extension install is born installed (got %)', NEW.status;
        END IF;
        IF NEW.uninstalled_at IS NOT NULL THEN
            RAISE EXCEPTION 'a fresh install must not carry uninstalled_at';
        END IF;
        RETURN NEW;
    END IF;
    -- UPDATE: uninstalled is terminal — reject every change.
    IF OLD.status = 'uninstalled' THEN
        RAISE EXCEPTION 'install % is uninstalled and terminal', OLD.install_id;
    END IF;
    IF NOT (
        (OLD.status = 'installed' AND NEW.status IN ('configured', 'uninstalled')) OR
        (OLD.status = 'configured' AND NEW.status IN ('authorized', 'configured', 'uninstalled')) OR
        (OLD.status = 'authorized' AND NEW.status IN ('configured', 'disabled', 'uninstalled')) OR
        (OLD.status = 'disabled' AND NEW.status IN ('authorized', 'uninstalled'))
    ) THEN
        RAISE EXCEPTION 'illegal extension install transition % → % (the frozen lifecycle is installed → configured → authorized, with disable/uninstall edges)',
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

DROP TRIGGER IF EXISTS extension_installs_lifecycle_legal_trigger ON extension_installs;
CREATE TRIGGER extension_installs_lifecycle_legal_trigger
BEFORE INSERT OR UPDATE OF status ON extension_installs
FOR EACH ROW EXECUTE FUNCTION extension_installs_lifecycle_legal();

-- ---------------------------------------------------------------------------
-- extension_invocations — the append-only invocation ledger (Observe)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS extension_invocations (
    invocation_id   uuid        PRIMARY KEY,
    extension_id    uuid        NOT NULL REFERENCES extensions(extension_id),
    install_id      uuid        NOT NULL REFERENCES extension_installs(install_id),
    -- The execution this invocation is bound to (its canonical scope is
    -- the invocation's scope — trigger-verified below).
    execution_id    uuid        NOT NULL REFERENCES executions(execution_id),
    agency_id       uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id       uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id    uuid        NOT NULL REFERENCES workspaces(workspace_id),
    -- The granted capability set (⊆ the manifest's declared list).
    granted_capabilities jsonb   NOT NULL
                    CHECK (extensions_capabilities_valid(granted_capabilities))
                    CHECK (extensions_payload_has_no_material_keys(granted_capabilities)),
    -- The effective granted data scopes.
    granted_data_scopes jsonb   NOT NULL
                    CHECK (extensions_data_scopes_valid(granted_data_scopes)),
    -- The policy posture: the append-only /policies decision that allowed
    -- this invocation (MKT-022 records explicit allows only — denials are
    -- recorded by /policies in policy_decisions).
    policy_decision_id text     NOT NULL
                    CHECK (length(policy_decision_id) >= 1 AND length(policy_decision_id) <= 64),
    policy_outcome  text        NOT NULL
                    CHECK (policy_outcome IN ('allow', 'deny', 'unknown')),
    -- The validated invocation input (§21: no material-shaped key can
    -- ever be stored in a durable extension input blob).
    input           jsonb       NOT NULL
                    CHECK (jsonb_typeof(input) = 'object')
                    CHECK (extensions_payload_has_no_material_keys(input)),
    -- SERVER-DERIVED provenance (implementation-contract §3): written
    -- exclusively by server code from the module-API provenance argument
    -- — there is no request DTO path to these columns.
    recorded_actor  text        NOT NULL
                    CHECK (length(recorded_actor) >= 1 AND length(recorded_actor) <= 100),
    recorded_via    text        NOT NULL
                    CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 100),
    correlation_id  text        NOT NULL,
    causation_id    text,
    -- The short-lived context window: strictly positive and bounded by
    -- the MAX TTL fence (the module default is five minutes).
    issued_at       timestamptz NOT NULL,
    expires_at      timestamptz NOT NULL
                    CHECK (expires_at > issued_at)
                    CHECK (expires_at <= issued_at + interval '1 hour'),
    recorded_at     timestamptz NOT NULL DEFAULT now()
);

-- Ledger listing surfaces: the invocations of one workspace (newest
-- first) and of one execution (the invocation history of a run).
CREATE INDEX IF NOT EXISTS extension_invocations_workspace_idx
    ON extension_invocations (workspace_id, recorded_at DESC, invocation_id);
CREATE INDEX IF NOT EXISTS extension_invocations_execution_idx
    ON extension_invocations (execution_id, recorded_at);
CREATE INDEX IF NOT EXISTS extension_invocations_install_idx
    ON extension_invocations (install_id, recorded_at);

-- The invocation CONSISTENCY fence: the invocation's scope must equal the
-- referenced execution's canonical scope, and the referenced install must
-- pin the SAME extension version in the SAME workspace — an invocation
-- context can never be recorded against crossed tenant or install rows,
-- even by direct SQL.
CREATE OR REPLACE FUNCTION extension_invocations_consistent() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM executions e
        WHERE e.execution_id = NEW.execution_id
          AND e.agency_id = NEW.agency_id
          AND e.client_id = NEW.client_id
          AND e.workspace_id = NEW.workspace_id
    ) THEN
        RAISE EXCEPTION 'invocation % execution % does not match the invocation scope %/%/% — invocations are bound to their execution canonical owner',
            NEW.invocation_id, NEW.execution_id, NEW.agency_id, NEW.client_id, NEW.workspace_id;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM extension_installs i
        WHERE i.install_id = NEW.install_id
          AND i.extension_id = NEW.extension_id
          AND i.workspace_id = NEW.workspace_id
    ) THEN
        RAISE EXCEPTION 'invocation % install % must pin the same extension version in the same workspace %',
            NEW.invocation_id, NEW.install_id, NEW.workspace_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS extension_invocations_consistent_trigger ON extension_invocations;
CREATE TRIGGER extension_invocations_consistent_trigger
BEFORE INSERT ON extension_invocations
FOR EACH ROW EXECUTE FUNCTION extension_invocations_consistent();

-- APPEND-ONLY backstop (the migration 015/018/025 pattern): the database
-- itself rejects UPDATE and DELETE on invocation records. Not even
-- server code can rewrite the invocation ledger — invocations are
-- recorded exactly once and retained for audit (extension-model.md §4
-- "Observe").
CREATE OR REPLACE FUNCTION extension_invocations_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'extension invocations are append-only: % is rejected on invocation %',
        TG_OP, OLD.invocation_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS extension_invocations_append_only_update_trigger ON extension_invocations;
CREATE TRIGGER extension_invocations_append_only_update_trigger
BEFORE UPDATE ON extension_invocations
FOR EACH ROW EXECUTE FUNCTION extension_invocations_append_only();

DROP TRIGGER IF EXISTS extension_invocations_append_only_delete_trigger ON extension_invocations;
CREATE TRIGGER extension_invocations_append_only_delete_trigger
BEFORE DELETE ON extension_invocations
FOR EACH ROW EXECUTE FUNCTION extension_invocations_append_only();
