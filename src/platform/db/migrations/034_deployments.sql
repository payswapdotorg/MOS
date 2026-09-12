-- MKT-040 Marketing Cloud Deployment schema (DEPLOY-002 — the
-- authoritative Deployment control plane; spec/marketing-cloud-deployment-
-- v1.4.md, spec/change-request-004.md, spec/architecture-lock-v1.4.md).
-- PostgreSQL is the system of record (spec/architecture-lock.md).
--
-- Table ownership follows the frozen authority map: "Deployment
-- intent/lifecycle belongs only to /deployments" — BOTH tables here:
--   deployments       → the Deployment IDENTITY records (scope chain +
--                       pinned immutable version selection + policy
--                       reference + runtime requirements + triggers +
--                       lifecycle state)
--   deployment_events → the APPEND-ONLY deployment history ledger
--                       (lifecycle transitions, validation reports,
--                       version-selection revisions, execution requests)
--
-- Frozen semantics encoded here (marketing-cloud-deployment-v1.4.md):
--
-- * DEPLOYMENT IDENTITY (§ "Deployment identity"): one Deployment belongs
--   to EXACTLY one Agency/Client/Workspace (the scope chain is NOT NULL,
--   immutable and re-fenced by trigger), references the immutable
--   playbook_version_id, the resolved workflow version references, the
--   required Domain Pack versions, the required Integration/Extension
--   capability versions, the policy snapshot/reference, the runtime
--   requirements, the trigger/schedule configuration, the lifecycle
--   state + CAS version, and carries audit/correlation metadata on every
--   ledger row (recorded_actor/recorded_via/correlation_id/causation_id —
--   server-derived, implementation-contract §3).
-- * THE FROZEN LIFECYCLE (§ "Lifecycle"):
--     draft → validating → ready → active
--                            ├→ blocked
--     active → paused → active
--     active → disabled
--     active → redeploying → active
--     active → rolling_back → active
--   The status CLOSED set is CHECKed and the transition table is enforced
--   by a trigger BACKSTOP (the migration 029 connection-lifecycle
--   pattern). `blocked` and `disabled` are TERMINAL (no frozen exit edge
--   exists — a blocked/disabled deployment is history; the operator's
--   path forward is a NEW deployment, never a resurrected row).
-- * VERSION/HISTORY SEMANTICS (§ "Version and history semantics"):
--   selection columns (playbook version, workflow version references,
--   pack requirements, capability requirements, runtime requirements,
--   trigger configuration) may ONLY change on the completion edges
--   (redeploying → active, rolling_back → active) — redeploy/rollback
--   change FUTURE version selection only. The history ledger is
--   APPEND-ONLY (UPDATE and DELETE rejected by triggers — the migration
--   015/018/025 pattern): existing records are never rewritten, which is
--   the storage-layer half of DEPLOY-AC-06 (the /executions, /evidence
--   and /learnings tables already reject UPDATE/DELETE by their own
--   frozen triggers — nothing here touches them).
-- * AUTHORITY BOUNDARY (§ "Authority boundary"): this migration creates
--   NO workflow, workflow-instance, execution, task, evidence, outcome
--   or learning table, column or trigger — /deployments owns deployment
--   intent/lifecycle ONLY. The request-execution surface is a REFERENCE
--   recorded on the append-only ledger (execution_ref) toward executions
--   created through the /executions public contract; there is no retry
--   state, no dispatch queue, no worker surface and no orchestration
--   column anywhere in this schema.
-- * RUNTIME NEUTRALITY (§ "Runtime"): a Deployment does NOT imply one VM,
--   process or sandbox. runtime_requirements is a CLOSED shape carrying
--   ONLY the runtime class (pooled-worker | ephemeral-sandbox |
--   persistent-sandbox | dedicated-runtime) — there is NO column and NO
--   accepted payload key capable of encoding infrastructure identity
--   (host/port/region/vm/provider/instance). Runtime allocation belongs
--   to the Execution/Runtime authority.
-- * CLIENT ISOLATION (TENANT-003 hard boundary): the scope chain is
--   re-fenced by trigger (workspace within client within agency) and the
--   pinned playbook version must be usable inside the deployment's
--   Client (Agency-scoped reusable playbook: same agency; Client-scoped
--   playbook: same client) — the Client boundary cannot be crossed even
--   if every application check were bypassed.
-- * POLICY REFERENCE: policy_reference_id points at the /policies
--   version consulted at the last successful gate (validated into
--   'ready' or gated into 'active') and may only change on those
--   transitions; every gated action's fresh fail-closed evaluation
--   decision is recorded in the append-only ledger report instead (the
--   /policies authority owns the decision records).
-- * NO SECRET MATERIAL (implementation-contract §21): every jsonb
--   payload is CHECKed against material-shaped keys at every nesting
--   level (the migration 025/029/030 pattern). Deployments reference
--   capabilities and versions — never credentials or material.
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, created_at/updated_at, version CAS for concurrent
-- mutation, DB-fenced idempotency (one ledger row per logical command
-- key per deployment).

-- ---------------------------------------------------------------------------
-- Shared immutable shape validators
-- ---------------------------------------------------------------------------

-- The material-shape validator (IMMUTABLE so it can serve CHECK
-- constraints): rejects material-shaped keys at every nesting level of a
-- stored deployment payload — the storage-side half of the §21
-- credential-by-logical-name contract (the migration 025/029 pattern).
CREATE OR REPLACE FUNCTION deployment_payload_has_no_material_keys(payload jsonb)
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
            IF NOT deployment_payload_has_no_material_keys(elem) THEN
                RETURN false;
            END IF;
        END LOOP;
    ELSIF jsonb_typeof(payload) = 'array' THEN
        FOR elem IN SELECT a.value FROM jsonb_array_elements(payload) a LOOP
            IF NOT deployment_payload_has_no_material_keys(elem) THEN
                RETURN false;
            END IF;
        END LOOP;
    END IF;
    RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Infrastructure-identity key validator (IMMUTABLE): runtime requirements
-- carry ONLY the runtime class — no key capable of encoding vendor or
-- infrastructure identity (DEPLOY-AC-09's storage backstop).
CREATE OR REPLACE FUNCTION deployment_requirements_no_infrastructure_identity(payload jsonb)
RETURNS boolean AS $$
DECLARE
    key text;
BEGIN
    IF payload IS NULL THEN
        RETURN false;
    END IF;
    IF jsonb_typeof(payload) <> 'object' THEN
        RETURN false;
    END IF;
    FOR key IN SELECT * FROM jsonb_object_keys(payload) LOOP
        IF key IN ('host', 'hostname', 'port', 'region', 'zone', 'vm', 'vmId',
                   'instance', 'instanceId', 'provider', 'vendor', 'cloud',
                   'cluster', 'node', 'nodeId', 'machine', 'machineId',
                   'endpoint', 'url', 'address', 'image', 'container',
                   'sandboxId', 'sandbox', 'worker', 'workerId', 'runtimeId') THEN
            RETURN false;
        END IF;
    END LOOP;
    RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- The runtime-requirements shape validator (IMMUTABLE): exactly one
-- "runtimeClass" key whose value is the closed four-class vocabulary —
-- pooled-worker | ephemeral-sandbox | persistent-sandbox |
-- dedicated-runtime (the frozen PlaybookRuntimeRequirements shape, the
-- /executions RuntimeClass vocabulary — one declared class, NOTHING
-- else). This is the DEPLOY-AC-09 storage contract: the deployment
-- REQUESTS a runtime class; runtime allocation itself belongs to the
-- Execution/Runtime authority.
CREATE OR REPLACE FUNCTION deployment_runtime_requirements_valid(requirements jsonb)
RETURNS boolean AS $$
BEGIN
    IF jsonb_typeof(requirements) <> 'object' THEN
        RETURN false;
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(requirements)) <> 1 THEN
        RETURN false;
    END IF;
    IF requirements ? 'runtimeClass' THEN
        IF requirements ->> 'runtimeClass' NOT IN ('pooled-worker', 'ephemeral-sandbox',
                                                   'persistent-sandbox', 'dedicated-runtime') THEN
            RETURN false;
        END IF;
        RETURN true;
    END IF;
    RETURN false;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- The Domain Pack requirement shape validator (IMMUTABLE): a bounded
-- array of {name, versionConstraint} objects (the frozen
-- PlaybookDomainPackRequirement shape).
CREATE OR REPLACE FUNCTION deployment_pack_requirements_valid(requirements jsonb)
RETURNS boolean AS $$
DECLARE
    elem jsonb;
    count integer := 0;
BEGIN
    IF jsonb_typeof(requirements) <> 'array' THEN
        RETURN false;
    END IF;
    FOR elem IN SELECT a.value FROM jsonb_array_elements(requirements) a LOOP
        count := count + 1;
        IF count > 32 THEN
            RETURN false;
        END IF;
        IF jsonb_typeof(elem) <> 'object' THEN
            RETURN false;
        END IF;
        IF NOT (elem ? 'name') OR jsonb_typeof(elem -> 'name') <> 'string' THEN
            RETURN false;
        END IF;
        IF length(elem ->> 'name') < 1 OR length(elem ->> 'name') > 128 THEN
            RETURN false;
        END IF;
        IF (elem ? 'versionConstraint') AND jsonb_typeof(elem -> 'versionConstraint') IS DISTINCT FROM 'string'
           AND jsonb_typeof(elem -> 'versionConstraint') IS DISTINCT FROM 'null' THEN
            RETURN false;
        END IF;
        IF (elem ? 'versionConstraint') AND jsonb_typeof(elem -> 'versionConstraint') = 'string'
           AND length(elem ->> 'versionConstraint') > 64 THEN
            RETURN false;
        END IF;
        IF NOT deployment_payload_has_no_material_keys(elem) THEN
            RETURN false;
        END IF;
    END LOOP;
    RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- The capability requirement shape validator (IMMUTABLE): a bounded array
-- of {kind: integration|extension, name, versionConstraint} objects (the
-- frozen PlaybookCapabilityRequirement shape).
CREATE OR REPLACE FUNCTION deployment_capability_requirements_valid(requirements jsonb)
RETURNS boolean AS $$
DECLARE
    elem jsonb;
    count integer := 0;
BEGIN
    IF jsonb_typeof(requirements) <> 'array' THEN
        RETURN false;
    END IF;
    FOR elem IN SELECT a.value FROM jsonb_array_elements(requirements) a LOOP
        count := count + 1;
        IF count > 32 THEN
            RETURN false;
        END IF;
        IF jsonb_typeof(elem) <> 'object' THEN
            RETURN false;
        END IF;
        IF NOT (elem ? 'kind') OR (elem ->> 'kind') NOT IN ('integration', 'extension') THEN
            RETURN false;
        END IF;
        IF NOT (elem ? 'name') OR jsonb_typeof(elem -> 'name') <> 'string' THEN
            RETURN false;
        END IF;
        IF length(elem ->> 'name') < 1 OR length(elem ->> 'name') > 128 THEN
            RETURN false;
        END IF;
        IF (elem ? 'versionConstraint') AND jsonb_typeof(elem -> 'versionConstraint') IS DISTINCT FROM 'string'
           AND jsonb_typeof(elem -> 'versionConstraint') IS DISTINCT FROM 'null' THEN
            RETURN false;
        END IF;
        IF NOT deployment_payload_has_no_material_keys(elem) THEN
            RETURN false;
        END IF;
    END LOOP;
    RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- The resolved workflow version references validator (IMMUTABLE): a
-- non-empty bounded array of uuid strings (1..8 pinned definition ids,
-- unique — the "resolved workflow version references" of the frozen
-- deployment identity).
CREATE OR REPLACE FUNCTION deployment_workflow_refs_valid(refs jsonb)
RETURNS boolean AS $$
DECLARE
    elem jsonb;
    count integer := 0;
BEGIN
    IF jsonb_typeof(refs) <> 'array' THEN
        RETURN false;
    END IF;
    FOR elem IN SELECT a.value FROM jsonb_array_elements(refs) a LOOP
        count := count + 1;
        IF count > 8 THEN
            RETURN false;
        END IF;
        IF jsonb_typeof(elem) <> 'string' THEN
            RETURN false;
        END IF;
        IF elem ->> 0 !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            RETURN false;
        END IF;
    END LOOP;
    IF count < 1 THEN
        RETURN false;
    END IF;
    RETURN (SELECT count(DISTINCT r) = count FROM jsonb_array_elements_text(refs) AS r);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- The trigger/schedule configuration validator (IMMUTABLE): a non-empty
-- bounded array (1..16) of {kind: manual|schedule|event, config} —
-- schedule triggers REQUIRE a non-null bounded config object; manual and
-- event triggers may carry one. Config values are bounded strings at the
-- top level (the frozen PlaybookTrigger shape; triggers are resolved and
-- validated by THIS authority — spec/architecture.md §9).
CREATE OR REPLACE FUNCTION deployment_triggers_valid(triggers jsonb)
RETURNS boolean AS $$
DECLARE
    elem jsonb;
    cfg jsonb;
    key text;
    val jsonb;
    count integer := 0;
BEGIN
    IF jsonb_typeof(triggers) <> 'array' THEN
        RETURN false;
    END IF;
    FOR elem IN SELECT a.value FROM jsonb_array_elements(triggers) a LOOP
        count := count + 1;
        IF count > 16 THEN
            RETURN false;
        END IF;
        IF jsonb_typeof(elem) <> 'object' THEN
            RETURN false;
        END IF;
        IF NOT (elem ? 'kind') OR (elem ->> 'kind') NOT IN ('manual', 'schedule', 'event') THEN
            RETURN false;
        END IF;
        IF (elem ? 'config') AND jsonb_typeof(elem -> 'config') = 'object' THEN
            cfg := elem -> 'config';
            IF (SELECT count(*) FROM jsonb_object_keys(cfg)) > 16 THEN
                RETURN false;
            END IF;
            FOR key, val IN SELECT * FROM jsonb_each(cfg) LOOP
                IF length(key) < 1 OR length(key) > 64 THEN
                    RETURN false;
                END IF;
                IF jsonb_typeof(val) <> 'string' THEN
                    RETURN false;
                END IF;
                IF length(val #>> '{}') < 1 OR length(val #>> '{}') > 256 THEN
                    RETURN false;
                END IF;
            END LOOP;
        ELSIF elem -> 'config' IS NOT NULL AND jsonb_typeof(elem -> 'config') <> 'null' THEN
            RETURN false;
        END IF;
        IF (elem ->> 'kind') = 'schedule' AND (elem -> 'config' IS NULL
           OR jsonb_typeof(elem -> 'config') <> 'object') THEN
            RETURN false;
        END IF;
        IF NOT deployment_payload_has_no_material_keys(elem) THEN
            RETURN false;
        END IF;
    END LOOP;
    IF count < 1 THEN
        RETURN false;
    END IF;
    RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- The version-selection snapshot validator (IMMUTABLE): the full
-- selection payload recorded on ledger rows (created/redeploy/rollback/
-- activation revisions) — all four selection arrays + runtime
-- requirements + triggers + the playbook version id.
CREATE OR REPLACE FUNCTION deployment_selection_valid(selection jsonb)
RETURNS boolean AS $$
BEGIN
    IF jsonb_typeof(selection) <> 'object' THEN
        RETURN false;
    END IF;
    IF NOT (selection ? 'playbookVersionId') OR jsonb_typeof(selection -> 'playbookVersionId') <> 'string' THEN
        RETURN false;
    END IF;
    IF NOT (selection ? 'workflowDefinitionIds') OR NOT deployment_workflow_refs_valid(selection -> 'workflowDefinitionIds') THEN
        RETURN false;
    END IF;
    IF NOT (selection ? 'requiredDomainPacks') OR NOT deployment_pack_requirements_valid(selection -> 'requiredDomainPacks') THEN
        RETURN false;
    END IF;
    IF NOT (selection ? 'requiredCapabilities') OR NOT deployment_capability_requirements_valid(selection -> 'requiredCapabilities') THEN
        RETURN false;
    END IF;
    IF NOT (selection ? 'runtimeRequirements') OR NOT deployment_runtime_requirements_valid(selection -> 'runtimeRequirements') THEN
        RETURN false;
    END IF;
    IF NOT (selection ? 'triggerConfig') OR NOT deployment_triggers_valid(selection -> 'triggerConfig') THEN
        RETURN false;
    END IF;
    RETURN deployment_payload_has_no_material_keys(selection);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- The validation-report validator (IMMUTABLE): a bounded object carrying
-- the gate outcome — an `ok` boolean, the named check results and the
-- policy decision reference; no material keys at any level.
CREATE OR REPLACE FUNCTION deployment_validation_report_valid(report jsonb)
RETURNS boolean AS $$
BEGIN
    IF jsonb_typeof(report) <> 'object' THEN
        RETURN false;
    END IF;
    IF NOT (report ? 'ok') OR jsonb_typeof(report -> 'ok') <> 'boolean' THEN
        RETURN false;
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(report)) > 16 THEN
        RETURN false;
    END IF;
    RETURN deployment_payload_has_no_material_keys(report);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ---------------------------------------------------------------------------
-- deployments — the Deployment identity records
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS deployments (
    deployment_id          uuid        PRIMARY KEY,
    agency_id              uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id              uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id           uuid        NOT NULL REFERENCES workspaces(workspace_id),
    playbook_version_id    uuid        NOT NULL REFERENCES playbook_versions(version_id),
    workflow_definition_ids jsonb      NOT NULL
                                         CHECK (deployment_workflow_refs_valid(workflow_definition_ids)),
    required_domain_packs  jsonb       NOT NULL DEFAULT '[]'::jsonb
                                         CHECK (deployment_pack_requirements_valid(required_domain_packs)),
    required_capabilities  jsonb       NOT NULL DEFAULT '[]'::jsonb
                                         CHECK (deployment_capability_requirements_valid(required_capabilities)),
    policy_reference_id    uuid        REFERENCES policies(policy_id),
    runtime_requirements   jsonb       NOT NULL
                                         CHECK (deployment_runtime_requirements_valid(runtime_requirements)
                                                AND deployment_requirements_no_infrastructure_identity(runtime_requirements)),
    trigger_config         jsonb       NOT NULL
                                         CHECK (deployment_triggers_valid(trigger_config)),
    status                 text        NOT NULL DEFAULT 'draft'
                                         CHECK (status IN ('draft', 'validating', 'ready', 'active',
                                                          'paused', 'redeploying', 'rolling_back',
                                                          'blocked', 'disabled')),
    created_by             uuid        REFERENCES users(user_id),
    version                bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Listing surface: one Workspace's deployments (newest first).
CREATE INDEX IF NOT EXISTS deployments_workspace_idx
ON deployments (workspace_id, created_at, deployment_id);

-- Operational surface: the deployments pinning one playbook version (the
-- immutable-version compatibility story; never a code branch).
CREATE INDEX IF NOT EXISTS deployments_playbook_version_idx
ON deployments (playbook_version_id);

-- Tenant fence (TENANT-003 at the storage layer, the migration 003/018/029
-- pattern): the deployment's Workspace must belong to its Client and the
-- Client to its Agency — the scope chain cannot be crossed even if every
-- application check were bypassed.
CREATE OR REPLACE FUNCTION deployment_scope_chain_consistent() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM workspaces w
        WHERE w.workspace_id = NEW.workspace_id AND w.client_id = NEW.client_id) THEN
        RAISE EXCEPTION 'deployment % workspace % does not belong to client % — the Client boundary cannot be crossed',
            NEW.deployment_id, NEW.workspace_id, NEW.client_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM clients c
        WHERE c.client_id = NEW.client_id AND c.agency_id = NEW.agency_id) THEN
        RAISE EXCEPTION 'deployment % client % does not belong to agency % — the Client boundary cannot be crossed',
            NEW.deployment_id, NEW.client_id, NEW.agency_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS deployment_scope_chain_consistent_trigger ON deployments;
CREATE TRIGGER deployment_scope_chain_consistent_trigger
BEFORE INSERT OR UPDATE OF workspace_id, client_id, agency_id ON deployments
FOR EACH ROW EXECUTE FUNCTION deployment_scope_chain_consistent();

-- Playbook-scope fence (the deployment-binding authorization backstop):
-- the pinned playbook version's playbook must be usable INSIDE the
-- deployment's Client — an Agency-scoped reusable playbook must belong to
-- the same Agency; a Client-scoped playbook must belong to the same
-- Client. A deployment can never bind another Client's playbook version
-- through any write path (DEPLOY-AC-08 at the storage layer).
CREATE OR REPLACE FUNCTION deployment_playbook_in_scope() RETURNS trigger AS $$
DECLARE
    v_playbook record;
BEGIN
    SELECT p.agency_id, p.client_id INTO v_playbook
    FROM playbooks p
    JOIN playbook_versions v ON v.version_id = NEW.playbook_version_id
    WHERE v.playbook_id = p.playbook_id;
    IF v_playbook IS NULL THEN
        RAISE EXCEPTION 'deployment % pins unknown playbook version %',
            NEW.deployment_id, NEW.playbook_version_id;
    END IF;
    IF v_playbook.agency_id <> NEW.agency_id THEN
        RAISE EXCEPTION 'deployment % playbook version % belongs to another agency — cross-tenant deployment binding is rejected',
            NEW.deployment_id, NEW.playbook_version_id;
    END IF;
    IF v_playbook.client_id IS NOT NULL AND v_playbook.client_id <> NEW.client_id THEN
        RAISE EXCEPTION 'deployment % playbook version % is Client-scoped to another client — cross-tenant deployment binding is rejected',
            NEW.deployment_id, NEW.playbook_version_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS deployment_playbook_in_scope_trigger ON deployments;
CREATE TRIGGER deployment_playbook_in_scope_trigger
BEFORE INSERT OR UPDATE OF playbook_version_id, client_id, agency_id ON deployments
FOR EACH ROW EXECUTE FUNCTION deployment_playbook_in_scope();

-- Scope immutability (the migration 005/029 pattern): a deployment's
-- identity and scope chain NEVER change — only the lifecycle state, the
-- version selection (exactly on the redeploy/rollback completion edges —
-- see the selection-change fence) and the policy reference (exactly on
-- the validation/gate edges) ever move.
CREATE OR REPLACE FUNCTION deployments_identity_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW.deployment_id <> OLD.deployment_id THEN
        RAISE EXCEPTION 'deployment_id % is immutable', OLD.deployment_id;
    END IF;
    IF NEW.workspace_id <> OLD.workspace_id
       OR NEW.client_id <> OLD.client_id
       OR NEW.agency_id <> OLD.agency_id THEN
        RAISE EXCEPTION 'deployment % scope chain is immutable (was workspace % client % agency %)',
            OLD.deployment_id, OLD.workspace_id, OLD.client_id, OLD.agency_id;
    END IF;
    IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'deployment % creation provenance is immutable', OLD.deployment_id;
    END IF;
    IF NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'deployment % created_at is immutable', OLD.deployment_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS deployments_identity_immutable_trigger ON deployments;
CREATE TRIGGER deployments_identity_immutable_trigger
BEFORE UPDATE ON deployments
FOR EACH ROW EXECUTE FUNCTION deployments_identity_immutable();

-- THE VERSION-SELECTION FENCE (marketing-cloud-deployment-v1.4.md
-- "Version and history semantics"): the selection columns change ONLY on
-- the redeploy/rollback completion edges (redeploying → active,
-- rolling_back → active). Redeploy/rollback therefore change FUTURE
-- version selection only; every other transition (validation, pause,
-- resume, disable, block) moves state WITHOUT touching the pinned
-- versions.
CREATE OR REPLACE FUNCTION deployment_selection_change_fenced() RETURNS trigger AS $$
BEGIN
    IF NEW.playbook_version_id = OLD.playbook_version_id
       AND NEW.workflow_definition_ids = OLD.workflow_definition_ids
       AND NEW.required_domain_packs = OLD.required_domain_packs
       AND NEW.required_capabilities = OLD.required_capabilities
       AND NEW.runtime_requirements = OLD.runtime_requirements
       AND NEW.trigger_config = OLD.trigger_config THEN
        RETURN NEW;
    END IF;
    IF OLD.status IN ('redeploying', 'rolling_back') AND NEW.status = 'active' THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'deployment % version selection is immutable outside redeploy/rollback completion (status % -> %)',
        OLD.deployment_id, OLD.status, NEW.status;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS deployment_selection_change_fenced_trigger ON deployments;
CREATE TRIGGER deployment_selection_change_fenced_trigger
BEFORE UPDATE OF playbook_version_id, workflow_definition_ids, required_domain_packs,
                      required_capabilities, runtime_requirements, trigger_config
ON deployments
FOR EACH ROW EXECUTE FUNCTION deployment_selection_change_fenced();

-- The policy-reference fence: policy_reference_id moves only on the
-- validation edge (→ ready) or a gate edge (→ active) — the snapshot is
-- the consulted policy version of the last successful gate.
CREATE OR REPLACE FUNCTION deployment_policy_reference_fenced() RETURNS trigger AS $$
BEGIN
    IF NEW.policy_reference_id IS NOT DISTINCT FROM OLD.policy_reference_id THEN
        RETURN NEW;
    END IF;
    IF NEW.status IN ('ready', 'active') THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'deployment % policy reference may only be restamped by validation or a gate (status % -> %)',
        OLD.deployment_id, OLD.status, NEW.status;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS deployment_policy_reference_fenced_trigger ON deployments;
CREATE TRIGGER deployment_policy_reference_fenced_trigger
BEFORE UPDATE OF policy_reference_id ON deployments
FOR EACH ROW EXECUTE FUNCTION deployment_policy_reference_fenced();

-- THE FROZEN LIFECYCLE TRANSITION TABLE (marketing-cloud-deployment-v1.4.md
-- "Lifecycle"), enforced at the storage layer as the race backstop:
--   draft → validating
--   validating → ready
--   ready → active | blocked
--   active → paused | disabled | redeploying | rolling_back
--   paused → active
--   redeploying → active
--   rolling_back → active
--   blocked, disabled: TERMINAL (no frozen exit edge — history).
CREATE OR REPLACE FUNCTION deployment_transition_legal() RETURNS trigger AS $$
DECLARE
    v_legal text[];
BEGIN
    IF NEW.status = OLD.status THEN
        RETURN NEW;
    END IF;
    CASE OLD.status
        WHEN 'draft'         THEN v_legal := ARRAY['validating'];
        WHEN 'validating'    THEN v_legal := ARRAY['ready'];
        WHEN 'ready'         THEN v_legal := ARRAY['active', 'blocked'];
        WHEN 'active'        THEN v_legal := ARRAY['paused', 'disabled', 'redeploying', 'rolling_back'];
        WHEN 'paused'        THEN v_legal := ARRAY['active'];
        WHEN 'redeploying'   THEN v_legal := ARRAY['active'];
        WHEN 'rolling_back'  THEN v_legal := ARRAY['active'];
        WHEN 'blocked'       THEN v_legal := ARRAY[]::text[];
        WHEN 'disabled'      THEN v_legal := ARRAY[]::text[];
        ELSE
            RAISE EXCEPTION 'unknown prior status % on deployment %',
                OLD.status, OLD.deployment_id;
    END CASE;
    IF NOT (NEW.status = ANY(v_legal)) THEN
        RAISE EXCEPTION 'illegal deployment transition % -> % on deployment %',
            OLD.status, NEW.status, OLD.deployment_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS deployment_transition_legal_trigger ON deployments;
CREATE TRIGGER deployment_transition_legal_trigger
BEFORE UPDATE OF status ON deployments
FOR EACH ROW EXECUTE FUNCTION deployment_transition_legal();

-- ---------------------------------------------------------------------------
-- deployment_events — the append-only deployment history ledger
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS deployment_events (
    event_id          uuid        PRIMARY KEY,
    deployment_id     uuid        NOT NULL REFERENCES deployments(deployment_id),
    idempotency_key   text        NOT NULL CHECK (length(idempotency_key) >= 1
                                            AND length(idempotency_key) <= 200),
    event_type        text        NOT NULL CHECK (event_type IN (
                                    'created', 'validated', 'activated', 'paused',
                                    'resumed', 'disabled', 'blocked',
                                    'redeploy-requested', 'redeploy-applied',
                                    'rollback-requested', 'rollback-applied',
                                    'execution-requested')),
    from_status       text        CHECK (from_status IS NULL
                                            OR from_status IN ('draft', 'validating', 'ready',
                                                               'active', 'paused', 'redeploying',
                                                               'rolling_back', 'blocked', 'disabled')),
    to_status         text        CHECK (to_status IS NULL
                                            OR to_status IN ('draft', 'validating', 'ready',
                                                             'active', 'paused', 'redeploying',
                                                             'rolling_back', 'blocked', 'disabled')),
    selection         jsonb       CHECK (selection IS NULL
                                            OR deployment_selection_valid(selection)),
    validation_report jsonb       CHECK (validation_report IS NULL
                                            OR deployment_validation_report_valid(validation_report)),
    reason            text        CHECK (reason IS NULL
                                            OR (length(reason) >= 1 AND length(reason) <= 2000)),
    execution_ref     uuid        REFERENCES executions(execution_id),
    recorded_actor    text        NOT NULL CHECK (length(recorded_actor) >= 1),
    recorded_via      text        NOT NULL CHECK (length(recorded_via) >= 1
                                            AND length(recorded_via) <= 100),
    correlation_id    text        NOT NULL,
    causation_id      text,
    recorded_at       timestamptz NOT NULL DEFAULT now()
);

-- The logical-command idempotency fence (implementation-contract §3/§8):
-- one ledger row per (deployment, idempotency key) — duplicate delivery
-- of the same material command converges to the recorded row (UNIQUE
-- violation → ConflictError in the module), and a key reused for a
-- DIFFERENT command is rejected by the module's fingerprint check.
CREATE UNIQUE INDEX IF NOT EXISTS deployment_events_idempotency_fence
ON deployment_events (deployment_id, idempotency_key);

-- History surfaces: one deployment's ledger oldest-first (the immutable
-- version-selection revision chain rollback targets read), newest-first
-- for operational reads.
CREATE INDEX IF NOT EXISTS deployment_events_deployment_idx
ON deployment_events (deployment_id, recorded_at, event_id);

-- APPEND-ONLY backstop (the migration 015/018/025 pattern): the database
-- itself rejects UPDATE and DELETE on deployment history — not even
-- server code can rewrite the deployment's recorded past (DEPLOY-AC-06
-- storage half).
CREATE OR REPLACE FUNCTION deployment_events_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'deployment events are append-only: % is rejected on deployment_event %',
        TG_OP, OLD.event_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS deployment_events_append_only_update_trigger ON deployment_events;
CREATE TRIGGER deployment_events_append_only_update_trigger
BEFORE UPDATE ON deployment_events
FOR EACH ROW EXECUTE FUNCTION deployment_events_append_only();

DROP TRIGGER IF EXISTS deployment_events_append_only_delete_trigger ON deployment_events;
CREATE TRIGGER deployment_events_append_only_delete_trigger
BEFORE DELETE ON deployment_events
FOR EACH ROW EXECUTE FUNCTION deployment_events_append_only();

-- Execution-reference fence: an execution-requested ledger row may only
-- reference an execution of the SAME workspace (the request-execution
-- surface records a reference to an /executions record created through
-- its public contract — never a second execution authority).
CREATE OR REPLACE FUNCTION deployment_event_execution_in_scope() RETURNS trigger AS $$
DECLARE
    v_execution record;
BEGIN
    IF NEW.execution_ref IS NOT NULL THEN
        SELECT workspace_id INTO v_execution
        FROM executions WHERE execution_id = NEW.execution_ref;
        IF v_execution IS NULL THEN
            RAISE EXCEPTION 'deployment event % references unknown execution %',
                NEW.event_id, NEW.execution_ref;
        END IF;
        SELECT d.workspace_id INTO v_execution
        FROM deployments d WHERE d.deployment_id = NEW.deployment_id;
        IF v_execution.workspace_id IS DISTINCT FROM (
            SELECT e.workspace_id FROM executions e WHERE e.execution_id = NEW.execution_ref) THEN
            RAISE EXCEPTION 'deployment event % execution_ref % belongs to another workspace — cross-tenant execution request is rejected',
                NEW.event_id, NEW.execution_ref;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS deployment_event_execution_in_scope_trigger ON deployment_events;
CREATE TRIGGER deployment_event_execution_in_scope_trigger
BEFORE INSERT ON deployment_events
FOR EACH ROW EXECUTE FUNCTION deployment_event_execution_in_scope();
