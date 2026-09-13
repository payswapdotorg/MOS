-- MKT-047 App Manifest and Packaging v1 schema (APP-001 — the App
-- registry authority for manifests: the v1.5 App Ecosystem expansion of
-- EXT-001 per spec/change-request-005.md #4 "Expand the existing
-- Extension Registry into an App Ecosystem", spec/mos-app-ecosystem-v1.5.md
-- "Manifest", spec/architecture-lock-v1.5.md #7 "Apps are versioned
-- composition packages over Extensions, capability contracts, UI surfaces
-- and bounded app-owned state" and #11 "Published App Versions are
-- immutable").
-- PostgreSQL is the system of record (spec/architecture-lock.md).
--
-- Table ownership follows the v1.5 App Ecosystem contract: the /apps
-- module (this Work Item's authority) owns exactly these three tables:
--   apps               → the APP KEY OWNERSHIP rows (one row per app key;
--                        the first publisher of a key owns its lineage)
--   app_versions       → the immutable versioned MANIFEST registry (one
--                        row per published (app key, semantic version))
--   app_dependencies   → the per-version DEPENDENCY declarations
--                        (extension/app ranges, validated at publish and
--                        re-fenced by trigger here)
--
-- Frozen semantics encoded here (spec/mos-app-ecosystem-v1.5.md — FROZEN;
-- spec/effective-backlog-v1.5.md MKT-047; spec/frozen-manifest-v1.5.json
-- appRules {publishedVersionsImmutable, boundedAppStateAllowed,
-- directCoreDatabaseWrites: false, serverDerivedPermissions,
-- certificationLevels}; spec/implementation-contract.md §3 "No externally
-- supplied field may override a server-derived actor, owner, provenance,
-- policy decision, or evidence authority value"; §21 "secrets may never
-- appear ... in durable" app payloads; §25 database backstops):
--
-- * THE IMMUTABLE-VERSION REGISTRY (mos-app-ecosystem-v1.5.md "Upgrade and
--   rollback": "Published App Versions are immutable"; architecture-lock
--   v1.5 #11): (app_key, version) is UNIQUE — re-publishing the same app
--   key + semantic version converges to a constraint violation (a
--   ConflictError upstream; never a silent rewrite) and a new version is
--   a NEW row. Published manifest content is IMMUTABLE through EVERY
--   mutation path: UPDATE and DELETE on app_versions are rejected by
--   triggers OUTRIGHT (the migration 008 playbooks + 028 extensions +
--   030 domain_packs registry precedent). The certification_state column
--   is born 'UNVERIFIED' and is likewise frozen at this layer: trust
--   transitions are PLATFORM territory (mos-app-ecosystem-v1.5.md "Trust
--   levels"; the marketplace/trust Work Item owns the platform
--   transition surface) — a developer can never self-certify, and even
--   direct SQL cannot forge a certification on a published row.
-- * APP KEY OWNERSHIP: the apps table carries one row per app key with
--   the SERVER-DERIVED publisher identity of the first publisher
--   (ON CONFLICT DO NOTHING — concurrent first publishes of the same key
--   converge to exactly one owner). Every app_versions row's publisher
--   must equal the owning publisher (trigger) — an app key can never be
--   hijacked by another publisher at any version.
-- * THE PUBLISHER IS SERVER-DERIVED (MKT-047 AC-5; the MKT-032
--   platform_developer role precedent): the publisher column carries the
--   derived identity string ('dev:<userId>' for the authenticated
--   platform developer, 'svc:<label>' for the internal service
--   principal). It is NEVER a request field — the module/route layer
--   derives it from the authenticated principal, and there is NO
--   caller-suppliable publisher input anywhere in this migration.
-- * THE CLOSED VOCABULARIES (DB CHECK, never a caller freedom):
--   - certification_state: UNVERIFIED | COMMUNITY_VERIFIED | MOS_CERTIFIED
--     (frozen enum — spec/frozen-manifest-v1.5.json certificationLevels);
--   - runtime_class: the closed four-class /executions vocabulary
--     (pooled-worker | ephemeral-sandbox | persistent-sandbox |
--     dedicated-runtime) — mirrored here because /apps holds no module
--     import allowance (structural ports only);
--   - data_scopes / mutation_scopes: the closed MKT-047 scope
--     vocabularies (requested scopes are validated against a FROZEN
--     vocabulary — MKT-047 AC-6);
--   - metering_dimensions: the closed economics vocabulary
--     (installations, invocations, compute-runtime, data-volume,
--     premium-capabilities — mos-app-ecosystem-v1.5.md "Economics");
--   - ui surface kinds: the closed six-kind UI vocabulary
--     (command-center-card, client-room-panel, workspace-tab,
--     report-page, editor-pane, action-menu — mos-app-ecosystem-v1.5.md
--     "UI and developer model").
-- * SEMANTIC VERSION + COMPATIBILITY CHECKS: versions are semver labels;
--   the platform compatibility range is ordered (compat_min <=
--   compat_max) under a REAL semver comparator (numeric component
--   ordering — 1.10.0 > 1.9.0 — never text ordering).
-- * APP-OWNED STATE NAMESPACES (mos-app-ecosystem-v1.5.md "Bounded app
--   state"; architecture-lock v1.5 #9): every declared namespace must be
--   namespaced under its OWN app key (app:<appKey>:<local>) and the
--   local segment must not claim a MOS core-authority namespace — the
--   singular authorities denylist (client, workspace, goal, playbook,
--   deployment, workflow, task, execution, evidence, experiment,
--   learning, policy, credential, job — spec/frozen-manifest-v1.5.json
--   singularAuthorities). An app-owned spreadsheet-document namespace is
--   valid; an app-owned competing Workflow state machine is NOT.
-- * DEPENDENCY VALIDATION (MKT-047 AC-6): dependency rows are validated
--   at publish by the module (existence + compatibility-range checks
--   through the /extensions structural port and the /apps registry) and
--   re-fenced here by trigger: an extension dependency must have at
--   least one PUBLISHED extensions-registry version inside the declared
--   range (the migration 028 registry is read check-only — no extension
--   row is created or mutated); an app dependency must reference an
--   EXISTING apps row (a published app key) and cannot be a
--   self-dependency. The dependency table is APPEND-ONLY (UPDATE/DELETE
--   rejected) — the declaration is part of the immutable version.
-- * NO SECRET MATERIAL ANYWHERE (CRED-001 / §21): every jsonb payload is
--   CHECKed against material-shaped keys at every nesting level (the
--   migration 025/028/030 pattern), and there is deliberately NO column
--   capable of holding secret material or a secret handle. Credential
--   references are required BY LOGICAL NAME ONLY
--   (required_credential_names — uppercase logical labels).
-- * NO TENANT IDENTITY, NO PROVENANCE, NO LIFECYCLE AUTHORITY FROM
--   CALLERS: the registry rows carry NO agency/client/workspace columns
--   at all (an App Version is global catalog state — the 028/030
--   posture), NO caller-suppliable provenance columns beyond the
--   server-derived created_by, and this migration creates NO install,
--   lifecycle, credential, audit, workflow, execution or evidence table
--   — app installation/upgrade/rollback is MKT-048 territory and every
--   mutation stays behind the existing authorities.
-- * COMPOSITION, NOT AUTHORITY TRANSFER (architecture-lock v1.5 #7/#13):
--   this migration creates no table that shadows a singular authority;
--   the /apps registry only records DECLARATIONS that compose over the
--   existing /extensions registry and execute through the existing
--   authorities.
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, created_at/updated_at, §8-style idempotency keys + create
-- fingerprints for logical-command convergence. No owner/role/user
-- columns beyond provenance: publishing authorization stays exactly the
-- frozen platform_developer/platform_administrator role authority
-- (users module) resolved at the route layer — no second tenant,
-- permission or identity authority. No provider SDK coupling, no
-- Marketplace tables (MKT-050), no Developer Portal tables (MKT-049),
-- no install tables (MKT-048), no metering ledger (MKT-052).

-- ---------------------------------------------------------------------------
-- Semver comparator (IMMUTABLE — numeric component ordering, never text)
-- ---------------------------------------------------------------------------

-- Real semantic-version ordering for X.Y.Z(-prerelease) labels: numeric
-- major/minor/patch comparison (so 1.10.0 > 1.9.0 — text ordering would
-- get this wrong), with prerelease labels sorting BELOW their release
-- (1.0.0-alpha < 1.0.0) and dot-separated prerelease identifiers compared
-- numerically when both are numeric, lexically otherwise (semver
-- semantics, bounded). Labels outside the semver shape compare 0.
CREATE OR REPLACE FUNCTION apps_semver_cmp(a text, b text)
RETURNS integer AS $$
DECLARE
    a_parts text[] := regexp_split_to_array(split_part(a, '-', 1), '\.');
    b_parts text[] := regexp_split_to_array(split_part(b, '-', 1), '\.');
    a_pre text := CASE WHEN position('-' in a) > 0 THEN substr(a, position('-' in a) + 1) ELSE NULL END;
    b_pre text := CASE WHEN position('-' in b) > 0 THEN substr(b, position('-' in b) + 1) ELSE NULL END;
    a_num integer; b_num integer; i integer;
    a_idents text[]; b_idents text[]; a_ident text; b_ident text;
BEGIN
    IF a IS NULL OR b IS NULL THEN RETURN 0; END IF;
    IF a = b THEN
        -- identical full labels (including prerelease) are equal
        RETURN 0;
    END IF;
    FOR i IN 1..3 LOOP
        a_num := NULLIF(regexp_replace(a_parts[i], '[^0-9]', '', 'g'), '')::integer;
        b_num := NULLIF(regexp_replace(b_parts[i], '[^0-9]', '', 'g'), '')::integer;
        IF a_num IS NULL OR b_num IS NULL THEN RETURN 0; END IF;
        IF a_num <> b_num THEN
            RETURN CASE WHEN a_num < b_num THEN -1 ELSE 1 END;
        END IF;
    END LOOP;
    -- core components equal: a release sorts ABOVE its prereleases
    IF a_pre IS NULL AND b_pre IS NULL THEN RETURN 0; END IF;
    IF a_pre IS NULL THEN RETURN 1; END IF;
    IF b_pre IS NULL THEN RETURN -1; END IF;
    -- both prereleases: compare dot-separated identifiers
    a_idents := string_to_array(a_pre, '.');
    b_idents := string_to_array(b_pre, '.');
    FOR i IN 1..least(array_length(a_idents, 1), array_length(b_idents, 1)) LOOP
        a_ident := a_idents[i];
        b_ident := b_idents[i];
        IF a_ident = b_ident THEN CONTINUE; END IF;
        IF a_ident ~ '^[0-9]+$' AND b_ident ~ '^[0-9]+$' THEN
            RETURN CASE WHEN a_ident::integer < b_ident::integer THEN -1 ELSE 1 END;
        END IF;
        RETURN CASE WHEN a_ident < b_ident THEN -1 ELSE 1 END;
    END LOOP;
    -- shorter identifier list sorts lower (1.0.0-alpha < 1.0.0-alpha.1)
    RETURN CASE WHEN array_length(a_idents, 1) < array_length(b_idents, 1) THEN -1
                WHEN array_length(a_idents, 1) > array_length(b_idents, 1) THEN 1
                ELSE 0 END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ---------------------------------------------------------------------------
-- Shape validators (IMMUTABLE so they can serve CHECK constraints)
-- ---------------------------------------------------------------------------

-- The material-shape validator (the migration 025/028/030 pattern):
-- rejects material-shaped keys at every nesting level of an app payload.
-- There is deliberately NO column anywhere in this migration capable of
-- holding secret material or a secret handle.
CREATE OR REPLACE FUNCTION apps_payload_has_no_material_keys(payload jsonb)
RETURNS boolean AS $$
DECLARE
    key text;
    elem jsonb;
BEGIN
    IF payload IS NULL THEN RETURN true; END IF;
    IF jsonb_typeof(payload) = 'object' THEN
        FOR key IN SELECT * FROM jsonb_object_keys(payload) LOOP
            IF key IN ('secret', 'secretMaterial', 'material', 'password', 'token',
                       'apiKey', 'api_key', 'accessKey', 'secretHandle',
                       'credentialValue', 'secretValue') THEN
                RETURN false;
            END IF;
        END LOOP;
        FOR elem IN SELECT e.value FROM jsonb_each(payload) e LOOP
            IF NOT apps_payload_has_no_material_keys(elem) THEN RETURN false; END IF;
        END LOOP;
    ELSIF jsonb_typeof(payload) = 'array' THEN
        FOR elem IN SELECT a.value FROM jsonb_array_elements(payload) a LOOP
            IF NOT apps_payload_has_no_material_keys(elem) THEN RETURN false; END IF;
        END LOOP;
    END IF;
    RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- The app-scope validator (the closed MKT-047 scope vocabularies):
-- 'data' scopes are the closed tenant-data boundary kinds (the frozen
-- /extensions data-scope set); 'mutation' scopes are the closed
-- authority-invocation kinds (the MOS authority surfaces an App's
-- commands may request — always server-mediated; apps never mutate core
-- tables directly).
CREATE OR REPLACE FUNCTION apps_data_scopes_valid(scopes jsonb)
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

CREATE OR REPLACE FUNCTION apps_mutation_scopes_valid(scopes jsonb)
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

-- The capabilities validator: non-empty bounded array of EXACTLY
-- { name, version } declarations — the capability + capability-version
-- contract of the frozen App manifest; names unique within the list (one
-- capability name = one callable unit), capability versions are semver
-- labels.
CREATE OR REPLACE FUNCTION apps_capabilities_valid(capabilities jsonb)
RETURNS boolean AS $$
DECLARE
    elem jsonb; key_count integer; name text; seen_names text[] := ARRAY[]::text[];
BEGIN
    IF jsonb_typeof(capabilities) <> 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(capabilities) < 1 OR jsonb_array_length(capabilities) > 64 THEN
        RETURN false;
    END IF;
    FOR elem IN SELECT * FROM jsonb_array_elements(capabilities) LOOP
        IF jsonb_typeof(elem) <> 'object' THEN RETURN false; END IF;
        SELECT count(*) INTO key_count FROM jsonb_object_keys(elem);
        IF key_count <> 2 THEN RETURN false; END IF;
        IF NOT (elem ? 'name') OR NOT (elem ? 'version') THEN RETURN false; END IF;
        IF jsonb_typeof(elem->'name') <> 'string'
           OR length(elem->>'name') < 1 OR length(elem->>'name') > 64 THEN
            RETURN false;
        END IF;
        IF jsonb_typeof(elem->'version') <> 'string'
           OR elem->>'version' !~ '^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]{1,32})?$' THEN
            RETURN false;
        END IF;
        name := elem->>'name';
        IF seen_names @> ARRAY[name] THEN RETURN false; END IF;
        seen_names := seen_names || name;
    END LOOP;
    RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- The network-destinations validator (the migration 028
-- network-requirements shape): bounded array of EXACTLY
-- { host, protocol, port, reason } declarations.
CREATE OR REPLACE FUNCTION apps_network_destinations_valid(destinations jsonb)
RETURNS boolean AS $$
DECLARE
    elem jsonb; key_count integer; port_num integer;
BEGIN
    IF jsonb_typeof(destinations) <> 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(destinations) > 32 THEN RETURN false; END IF;
    FOR elem IN SELECT * FROM jsonb_array_elements(destinations) LOOP
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

-- The UI-surfaces validator: bounded array of EXACTLY { surface, route }
-- declarations; surface is the closed six-kind vocabulary of
-- mos-app-ecosystem-v1.5.md "UI and developer model" (UI is presentation
-- only — architecture-lock v1.5 #12).
CREATE OR REPLACE FUNCTION apps_ui_surfaces_valid(surfaces jsonb)
RETURNS boolean AS $$
DECLARE
    elem jsonb; key_count integer;
BEGIN
    IF jsonb_typeof(surfaces) <> 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(surfaces) > 32 THEN RETURN false; END IF;
    FOR elem IN SELECT * FROM jsonb_array_elements(surfaces) LOOP
        IF jsonb_typeof(elem) <> 'object' THEN RETURN false; END IF;
        SELECT count(*) INTO key_count FROM jsonb_object_keys(elem);
        IF key_count <> 2 THEN RETURN false; END IF;
        IF NOT (elem ? 'surface') OR NOT (elem ? 'route') THEN RETURN false; END IF;
        IF jsonb_typeof(elem->'surface') <> 'string' OR NOT (elem->>'surface' IN (
               'command-center-card', 'client-room-panel', 'workspace-tab',
               'report-page', 'editor-pane', 'action-menu')) THEN
            RETURN false;
        END IF;
        IF jsonb_typeof(elem->'route') <> 'string'
           OR elem->>'route' !~ '^/[a-zA-Z0-9._/-]{0,120}$' THEN
            RETURN false;
        END IF;
    END LOOP;
    RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- The labels validator (event subscriptions / metering dimensions /
-- required credential names): bounded unique string arrays.
CREATE OR REPLACE FUNCTION apps_labels_valid(labels jsonb)
RETURNS boolean AS $$
DECLARE
    elem jsonb; label text; seen text[] := ARRAY[]::text[];
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

-- The required-credential-names validator: bounded unique array of
-- LOGICAL labels (uppercase snake case) — credential references are
-- required BY NAME ONLY; values are never storable here (CRED-001).
CREATE OR REPLACE FUNCTION apps_credential_names_valid(names jsonb)
RETURNS boolean AS $$
DECLARE
    elem jsonb; label text; seen text[] := ARRAY[]::text[];
BEGIN
    IF jsonb_typeof(names) <> 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(names) > 32 THEN RETURN false; END IF;
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

-- The metering-dimensions validator: bounded unique array of the CLOSED
-- economics vocabulary (mos-app-ecosystem-v1.5.md "Economics":
-- installations, invocation count, compute/runtime, data volume,
-- premium capabilities). MKT-052 owns the metering ledger; v1 declares
-- and validates dimensions only.
CREATE OR REPLACE FUNCTION apps_metering_dimensions_valid(dimensions jsonb)
RETURNS boolean AS $$
DECLARE
    elem jsonb; dimension text; seen text[] := ARRAY[]::text[];
BEGIN
    IF jsonb_typeof(dimensions) <> 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(dimensions) > 8 THEN RETURN false; END IF;
    FOR elem IN SELECT * FROM jsonb_array_elements(dimensions) LOOP
        IF jsonb_typeof(elem) <> 'string' THEN RETURN false; END IF;
        dimension := elem#>>'{}';
        IF dimension NOT IN ('installations', 'invocations', 'compute-runtime',
                             'data-volume', 'premium-capabilities') THEN
            RETURN false;
        END IF;
        IF seen @> ARRAY[dimension] THEN RETURN false; END IF;
        seen := seen || dimension;
    END LOOP;
    RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- The app-owned state-namespace validator (mos-app-ecosystem-v1.5.md
-- "Bounded app state"; architecture-lock v1.5 #9): every namespace must
-- be namespaced under the ROW'S OWN app key (app:<appKey>:<local>) — an
-- app cannot claim another app's namespace — and the local segment must
-- not claim a MOS CORE-AUTHORITY namespace: the singular authorities
-- denylist (spec/frozen-manifest-v1.5.json singularAuthorities). An
-- app-owned spreadsheet-documents namespace is valid; an app-owned
-- competing Workflow state machine is not.
CREATE OR REPLACE FUNCTION apps_state_namespaces_valid(namespaces jsonb, app_key text)
RETURNS boolean AS $$
DECLARE
    elem jsonb; ns text; local_part text; seen text[] := ARRAY[]::text[];
BEGIN
    IF jsonb_typeof(namespaces) <> 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(namespaces) > 16 THEN RETURN false; END IF;
    FOR elem IN SELECT * FROM jsonb_array_elements(namespaces) LOOP
        IF jsonb_typeof(elem) <> 'string' THEN RETURN false; END IF;
        ns := elem#>>'{}';
        -- structurally namespaced under the OWNING app key only
        IF ns !~ '^app:[a-z][a-z0-9-]{1,62}:[a-z][a-z0-9-]{1,30}$' THEN RETURN false; END IF;
        IF split_part(ns, ':', 2) <> app_key THEN RETURN false; END IF;
        local_part := split_part(ns, ':', 3);
        -- the singular-authorities denylist: core namespaces are not claimable
        IF local_part IN ('client', 'workspace', 'goal', 'playbook', 'deployment',
                          'workflow', 'task', 'execution', 'evidence', 'experiment',
                          'learning', 'policy', 'credential', 'job') THEN
            RETURN false;
        END IF;
        IF seen @> ARRAY[ns] THEN RETURN false; END IF;
        seen := seen || ns;
    END LOOP;
    RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- The configuration-schema validator (the migration 028 config-contract
-- shape): bounded object of field name → EXACTLY
-- { type, required, description, pattern } field contracts.
CREATE OR REPLACE FUNCTION apps_config_schema_valid(contract jsonb)
RETURNS boolean AS $$
DECLARE
    field_key text; field_value jsonb; key_count integer;
BEGIN
    IF jsonb_typeof(contract) <> 'object' THEN RETURN false; END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(contract)) > 64 THEN RETURN false; END IF;
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

-- The dependency-declaration list validator (the in-manifest declaration
-- mirrored row-wise into app_dependencies by the module): bounded array
-- of EXACTLY { kind, publisher, key, minVersion, maxVersion }
-- declarations; kind is 'extension' | 'app'; extension dependencies
-- carry a publisher, app dependencies carry the publisher NULL
-- (coalesced to the empty string in the JSON for the closed shape).
CREATE OR REPLACE FUNCTION apps_dependencies_valid(dependencies jsonb)
RETURNS boolean AS $$
DECLARE
    elem jsonb; key_count integer; kind text;
BEGIN
    IF jsonb_typeof(dependencies) <> 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(dependencies) > 32 THEN RETURN false; END IF;
    FOR elem IN SELECT * FROM jsonb_array_elements(dependencies) LOOP
        IF jsonb_typeof(elem) <> 'object' THEN RETURN false; END IF;
        SELECT count(*) INTO key_count FROM jsonb_object_keys(elem);
        IF key_count <> 5 THEN RETURN false; END IF;
        IF NOT (elem ? 'kind') OR NOT (elem ? 'publisher') OR NOT (elem ? 'key')
           OR NOT (elem ? 'minVersion') OR NOT (elem ? 'maxVersion') THEN
            RETURN false;
        END IF;
        IF jsonb_typeof(elem->'kind') <> 'string' OR NOT (elem->>'kind' IN ('extension', 'app')) THEN
            RETURN false;
        END IF;
        kind := elem->>'kind';
        IF jsonb_typeof(elem->'publisher') = 'null' THEN
            IF kind <> 'app' THEN RETURN false; END IF;
        ELSE
            IF jsonb_typeof(elem->'publisher') <> 'string'
               OR elem->>'publisher' !~ '^[a-z0-9][a-z0-9._-]{0,63}$' THEN RETURN false; END IF;
        END IF;
        IF jsonb_typeof(elem->'key') <> 'string'
           OR elem->>'key' !~ '^[a-z][a-z0-9-]{1,62}$' THEN RETURN false; END IF;
        IF jsonb_typeof(elem->'minVersion') <> 'string'
           OR elem->>'minVersion' !~ '^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]{1,32})?$' THEN RETURN false; END IF;
        IF jsonb_typeof(elem->'maxVersion') <> 'string'
           OR elem->>'maxVersion' !~ '^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]{1,32})?$' THEN RETURN false; END IF;
        IF apps_semver_cmp(elem->>'minVersion', elem->>'maxVersion') > 0 THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ---------------------------------------------------------------------------
-- apps — the APP KEY OWNERSHIP rows (one row per app key)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS apps (
    app_key         text        PRIMARY KEY
                    CHECK (app_key ~ '^[a-z][a-z0-9-]{1,62}$'),
    -- The SERVER-DERIVED publisher identity of the FIRST publisher
    -- ('dev:<userId>' | 'svc:<label>'); owns the key lineage. Never a
    -- request field (derived from the authenticated principal upstream).
    owner_publisher text        NOT NULL
                    CHECK (owner_publisher ~ '^(dev|svc):[a-z0-9][a-z0-9._-]{0,63}$'),
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- App-key ownership is append-only: an owner row can never be rewritten
-- or removed (the registry history is permanent; the ON CONFLICT DO
-- NOTHING insert converges concurrent first publishes of the same key
-- to exactly one owner).
CREATE OR REPLACE FUNCTION apps_owner_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'app key ownership rows are immutable (app key % is owned by %): % is rejected',
        OLD.app_key, OLD.owner_publisher, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS apps_owner_immutable_update_trigger ON apps;
CREATE TRIGGER apps_owner_immutable_update_trigger
BEFORE UPDATE ON apps
FOR EACH ROW EXECUTE FUNCTION apps_owner_immutable();

DROP TRIGGER IF EXISTS apps_owner_immutable_delete_trigger ON apps;
CREATE TRIGGER apps_owner_immutable_delete_trigger
BEFORE DELETE ON apps
FOR EACH ROW EXECUTE FUNCTION apps_owner_immutable();

-- ---------------------------------------------------------------------------
-- app_versions — the immutable versioned MANIFEST registry
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS app_versions (
    app_version_id  uuid        PRIMARY KEY,
    app_key         text        NOT NULL REFERENCES apps(app_key),
    -- The SERVER-DERIVED publisher identity of THIS version (must equal
    -- the key's owner — trigger below; never a request field).
    publisher       text        NOT NULL
                    CHECK (publisher ~ '^(dev|svc):[a-z0-9][a-z0-9._-]{0,63}$'),
    -- The immutable semantic version (semver label, prerelease allowed).
    version         text        NOT NULL
                    CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]{1,32})?$'),
    -- The platform compatibility range (inclusive, REAL semver ordered).
    compat_min      text        NOT NULL
                    CHECK (compat_min ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]{1,32})?$'),
    compat_max      text        NOT NULL
                    CHECK (compat_max ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]{1,32})?$'),
    -- Capabilities + capability versions (closed { name, version } shape).
    capabilities    jsonb       NOT NULL
                    CHECK (apps_capabilities_valid(capabilities))
                    CHECK (apps_payload_has_no_material_keys(capabilities)),
    -- Input/output schemas (bounded objects; material-key fenced).
    input_schema    jsonb       NOT NULL
                    CHECK (jsonb_typeof(input_schema) = 'object')
                    CHECK (apps_payload_has_no_material_keys(input_schema)),
    output_schema   jsonb       NOT NULL
                    CHECK (jsonb_typeof(output_schema) = 'object')
                    CHECK (apps_payload_has_no_material_keys(output_schema)),
    -- Requested data scopes (closed vocabulary).
    data_scopes     jsonb       NOT NULL DEFAULT '[]'::jsonb
                    CHECK (apps_data_scopes_valid(data_scopes)),
    -- Requested mutation scopes (closed vocabulary).
    mutation_scopes jsonb       NOT NULL DEFAULT '[]'::jsonb
                    CHECK (apps_mutation_scopes_valid(mutation_scopes)),
    -- Network destinations (policy-gated at use, not here).
    network_destinations jsonb  NOT NULL DEFAULT '[]'::jsonb
                    CHECK (apps_network_destinations_valid(network_destinations))
                    CHECK (apps_payload_has_no_material_keys(network_destinations)),
    -- The frozen runtime class (the closed /executions vocabulary).
    runtime_class   text        NOT NULL
                    CHECK (runtime_class IN ('pooled-worker', 'ephemeral-sandbox',
                                             'persistent-sandbox', 'dedicated-runtime')),
    -- Event subscriptions (bounded unique labels).
    event_subscriptions jsonb   NOT NULL DEFAULT '[]'::jsonb
                    CHECK (apps_labels_valid(event_subscriptions)),
    -- UI surfaces and routes (closed six-kind surface vocabulary).
    ui_surfaces     jsonb       NOT NULL DEFAULT '[]'::jsonb
                    CHECK (apps_ui_surfaces_valid(ui_surfaces))
                    CHECK (apps_payload_has_no_material_keys(ui_surfaces)),
    -- The configuration schema (field contracts).
    config_schema   jsonb       NOT NULL DEFAULT '{}'::jsonb
                    CHECK (apps_config_schema_valid(config_schema))
                    CHECK (apps_payload_has_no_material_keys(config_schema)),
    -- Credential references required BY LOGICAL NAME ONLY (never values).
    required_credential_names jsonb NOT NULL DEFAULT '[]'::jsonb
                    CHECK (apps_credential_names_valid(required_credential_names)),
    -- App-owned state namespaces (namespaced under the OWN app key; the
    -- core-authority denylist applies — see the validator).
    state_namespaces jsonb      NOT NULL DEFAULT '[]'::jsonb
                    CHECK (apps_state_namespaces_valid(state_namespaces, app_key)),
    -- The app's own storage migration version (bounded non-negative).
    migration_version integer   NOT NULL
                    CHECK (migration_version >= 0 AND migration_version <= 2147483647),
    -- Dependency Apps/Extensions (the in-row declaration; mirrored
    -- row-wise into app_dependencies by the module and re-fenced there).
    dependencies    jsonb       NOT NULL DEFAULT '[]'::jsonb
                    CHECK (apps_dependencies_valid(dependencies))
                    CHECK (apps_payload_has_no_material_keys(dependencies)),
    -- Certification state: PLATFORM TERRITORY, born UNVERIFIED on every
    -- developer publish (frozen enum — a developer can never self-certify;
    -- trust transitions are the MKT-050 marketplace/trust surface).
    certification_state text    NOT NULL DEFAULT 'UNVERIFIED'
                    CHECK (certification_state IN ('UNVERIFIED', 'COMMUNITY_VERIFIED', 'MOS_CERTIFIED')),
    -- Declared support level (bounded label — publisher-declared).
    support_level   text        NOT NULL
                    CHECK (length(support_level) >= 1 AND length(support_level) <= 64),
    -- Metering dimensions (closed economics vocabulary).
    metering_dimensions jsonb   NOT NULL DEFAULT '[]'::jsonb
                    CHECK (apps_metering_dimensions_valid(metering_dimensions)),
    -- The §8-style logical publish command identity (convergence proof).
    idempotency_key text        NOT NULL
                    CHECK (length(idempotency_key) >= 1 AND length(idempotency_key) <= 200),
    create_fingerprint text     NOT NULL
                    CHECK (length(create_fingerprint) >= 1 AND length(create_fingerprint) <= 128),
    created_by      uuid        REFERENCES users(user_id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    -- THE immutable-version fence: re-publishing the same app key +
    -- semantic version converges to a constraint violation; a new
    -- version is a NEW row.
    CONSTRAINT app_versions_key_version_unique UNIQUE (app_key, version),
    -- The platform compatibility range must be ordered (REAL semver
    -- comparison — never text ordering).
    CONSTRAINT app_versions_compat_ordered CHECK (apps_semver_cmp(compat_min, compat_max) <= 0)
);

-- Listing surfaces: by app key (all versions, newest first) and by publisher.
CREATE INDEX IF NOT EXISTS app_versions_key_idx
    ON app_versions (app_key, created_at DESC, app_version_id);
CREATE INDEX IF NOT EXISTS app_versions_publisher_idx
    ON app_versions (publisher, created_at DESC);

-- PUBLISHED APP VERSIONS ARE IMMUTABLE (mos-app-ecosystem-v1.5.md
-- "Upgrade and rollback"; architecture-lock v1.5 #11): NO column of a
-- published version can ever change — corrections publish a NEW
-- version. This trigger rejects every UPDATE outright (including
-- certification_state: trust transitions arrive ONLY through the future
-- platform marketplace/trust surface, never by rewriting a published
-- manifest row), and DELETE is likewise rejected: registry history is
-- permanent.
CREATE OR REPLACE FUNCTION app_versions_registry_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'app version registry rows are immutable (published version % of app % by %): % is rejected — publish a NEW version instead',
        OLD.version, OLD.app_key, OLD.publisher, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS app_versions_registry_immutable_update_trigger ON app_versions;
CREATE TRIGGER app_versions_registry_immutable_update_trigger
BEFORE UPDATE ON app_versions
FOR EACH ROW EXECUTE FUNCTION app_versions_registry_immutable();

DROP TRIGGER IF EXISTS app_versions_registry_immutable_delete_trigger ON app_versions;
CREATE TRIGGER app_versions_registry_immutable_delete_trigger
BEFORE DELETE ON app_versions
FOR EACH ROW EXECUTE FUNCTION app_versions_registry_immutable();

-- The publisher-consistency fence: every version row's publisher must
-- equal the app key's OWNER publisher — an app key can never be
-- published by a second publisher at any version (key-lineage
-- integrity, enforced even by direct SQL).
CREATE OR REPLACE FUNCTION app_versions_publisher_consistent() RETURNS trigger AS $$
DECLARE
    owner text;
BEGIN
    SELECT owner_publisher INTO owner FROM apps WHERE app_key = NEW.app_key;
    IF owner IS NULL OR owner <> NEW.publisher THEN
        RAISE EXCEPTION 'app key % is owned by publisher % — publisher % cannot publish it',
            NEW.app_key, COALESCE(owner, '<none>'), NEW.publisher;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS app_versions_publisher_consistent_trigger ON app_versions;
CREATE TRIGGER app_versions_publisher_consistent_trigger
BEFORE INSERT ON app_versions
FOR EACH ROW EXECUTE FUNCTION app_versions_publisher_consistent();

-- ---------------------------------------------------------------------------
-- app_dependencies — the per-version dependency declarations
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS app_dependencies (
    dependency_id   uuid        PRIMARY KEY,
    app_version_id  uuid        NOT NULL REFERENCES app_versions(app_version_id),
    -- 'extension' | 'app' (closed kind vocabulary).
    kind            text        NOT NULL
                    CHECK (kind IN ('extension', 'app')),
    -- For kind='extension': the dependency extension's PUBLISHER + KEY in
    -- the /extensions registry. For kind='app': publisher NULL (app keys
    -- are globally unique lineages — no publisher disambiguation needed).
    ref_publisher   text
                    CHECK (ref_publisher IS NULL OR ref_publisher ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
    ref_key         text        NOT NULL
                    CHECK (ref_key ~ '^[a-z][a-z0-9-]{1,62}$'),
    -- The declared compatibility range (inclusive bounds; REAL semver
    -- ordered).
    min_version     text        NOT NULL
                    CHECK (min_version ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]{1,32})?$'),
    max_version     text        NOT NULL
                    CHECK (max_version ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]{1,32})?$'),
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- One declaration per (version, kind, publisher, key).
    CONSTRAINT app_dependencies_unique
        UNIQUE (app_version_id, kind, ref_publisher, ref_key),
    -- Extension dependencies carry a publisher; app dependencies do not.
    CONSTRAINT app_dependencies_kind_publisher_shape
        CHECK ((kind = 'extension' AND ref_publisher IS NOT NULL)
            OR (kind = 'app' AND ref_publisher IS NULL)),
    -- The declared range must be ordered (REAL semver comparison).
    CONSTRAINT app_dependencies_range_ordered
        CHECK (apps_semver_cmp(min_version, max_version) <= 0)
);

-- Listing surface: the dependencies of one version.
CREATE INDEX IF NOT EXISTS app_dependencies_version_idx
    ON app_dependencies (app_version_id, kind, ref_key);

-- THE DEPENDENCY VALIDATION BACKSTOP (MKT-047 AC-6): at insert time,
-- every dependency must be REAL and compatible —
--   - kind='extension': at least one PUBLISHED row in the /extensions
--     registry (migration 028 — read CHECK-ONLY; no extension row is
--     ever created or mutated from here) with the declared publisher +
--     key AND a version INSIDE the declared range (REAL semver);
--   - kind='app': the referenced app key must EXIST in the apps table
--     (a published app lineage) with at least one published version
--     inside the declared range, and the dependency must not be a
--     SELF-dependency (an app version can never depend on its own app
--     key — the dependency DAG is built from already-published lineages).
CREATE OR REPLACE FUNCTION app_dependencies_valid_target() RETURNS trigger AS $$
DECLARE
    own_key text;
    version_hit boolean;
BEGIN
    SELECT av.app_key INTO own_key FROM app_versions av WHERE av.app_version_id = NEW.app_version_id;
    IF own_key IS NULL THEN
        RAISE EXCEPTION 'app dependency % references an unknown app version %',
            NEW.dependency_id, NEW.app_version_id;
    END IF;

    IF NEW.kind = 'extension' THEN
        SELECT EXISTS (
            SELECT 1 FROM extensions e
             WHERE e.publisher = NEW.ref_publisher
               AND e.extension_key = NEW.ref_key
               AND apps_semver_cmp(e.version, NEW.min_version) >= 0
               AND apps_semver_cmp(e.version, NEW.max_version) <= 0
        ) INTO version_hit;
        IF NOT version_hit THEN
            RAISE EXCEPTION 'app dependency on extension %/% has no published version inside [% .. %] — dependencies must exist and be compatible',
                NEW.ref_publisher, NEW.ref_key, NEW.min_version, NEW.max_version;
        END IF;
    ELSE
        IF NEW.ref_key = own_key THEN
            RAISE EXCEPTION 'app version % of % cannot declare a dependency on its own app key (dependencies are other, already-published app lineages)',
                NEW.app_version_id, own_key;
        END IF;
        SELECT EXISTS (
            SELECT 1 FROM app_versions v
             WHERE v.app_key = NEW.ref_key
               AND apps_semver_cmp(v.version, NEW.min_version) >= 0
               AND apps_semver_cmp(v.version, NEW.max_version) <= 0
        ) INTO version_hit;
        IF NOT version_hit THEN
            RAISE EXCEPTION 'app dependency on app % has no published version inside [% .. %] — dependencies must exist and be compatible',
                NEW.ref_key, NEW.min_version, NEW.max_version;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS app_dependencies_valid_target_trigger ON app_dependencies;
CREATE TRIGGER app_dependencies_valid_target_trigger
BEFORE INSERT ON app_dependencies
FOR EACH ROW EXECUTE FUNCTION app_dependencies_valid_target();

-- The dependency declarations are APPEND-ONLY (the declaration is part
-- of the immutable published version): UPDATE and DELETE are rejected.
CREATE OR REPLACE FUNCTION app_dependencies_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'app dependency rows are append-only (part of the immutable published version %): % is rejected',
        OLD.app_version_id, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS app_dependencies_append_only_update_trigger ON app_dependencies;
CREATE TRIGGER app_dependencies_append_only_update_trigger
BEFORE UPDATE ON app_dependencies
FOR EACH ROW EXECUTE FUNCTION app_dependencies_append_only();

DROP TRIGGER IF EXISTS app_dependencies_append_only_delete_trigger ON app_dependencies;
CREATE TRIGGER app_dependencies_append_only_delete_trigger
BEFORE DELETE ON app_dependencies
FOR EACH ROW EXECUTE FUNCTION app_dependencies_append_only();
