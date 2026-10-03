-- 068_studio_format_framework.sql — STUDIO-002 (Pluggable Format
-- Framework).
--
-- THE FORMAT CONTRACT + REGISTRY AUTHORITY (spec/
-- effective-backlog-v1.7.md STUDIO-002: "Build the format contract
-- and registry. Acceptance: formats declare input, participant,
-- capture, interviewer, organization, output, provenance and
-- evaluation contracts; new formats do not require another Studio
-- runtime."; dependencies: STUDIO-001 — merged PR #73, migration 064
-- is the runtime schema this framework extends). The governing
-- sub-contract is spec/content-studio-contract-v1.0.md (FROZEN):
-- §2 "The format registry MUST be pluggable. Initial formats:
-- reaction; audio podcast; video podcast. A format declares: format
-- identity/version; input requirements; participant model; capture
-- requirements; interviewer requirements; organization compatibility
-- requirements; output artifact contract; provenance/consent
-- requirements; evaluation hooks. Adding a future format MUST NOT
-- require a second Studio runtime or a second Lab authority.";
-- §3 (the Production Request carries the selected format — resolved
-- through this registry, ACTIVE versions only); §6 (the interviewer
-- representation forms + "The interviewer may adapt questions using
-- previous answers"); §7 (the multi-person participation grants);
-- §12 (the output artifact package vocabulary); §13 (the evaluation
-- verdicts are the Lab's, LAB-023 — the hooks here are DECLARED
-- firing points only); spec/architecture-v1.7-marketing-lab.md
-- §27.5 ("Formats are pluggable. Future formats can be added without
-- changing the Lab authority."), §27.6 (the interviewer construction
-- options incl. "another declared multimodal interviewer
-- representation"), §27.7; architecture-lock-v1.7.md #38 ("Content
-- Studio is a MOS-owned AI+Human production runtime that is both
-- standalone and Lab-invoked. It initially supports reaction, audio
-- podcast and video podcast through a pluggable format contract."),
-- #39, #40, #41, #42, #43, #44.
--
-- Two tables ONLY (the 063/064/065 one-module-owns-its-tables
-- discipline; the STUDIO-001 six runtime tables are UNTOUCHED — this
-- migration is purely additive):
--
--   studio_formats              → the VERSIONED FORMAT REGISTRY
--                                 records: one row per (client,
--                                 format_id, format_version) carrying
--                                 the FULL §2 declaration (all NINE
--                                 declared surfaces) as validated
--                                 declared jsonb data + the honest
--                                 per-stage availability layer + the
--                                 draft → active → retired lifecycle
--                                 (the /lab-agent-body
--                                 versioned-registry precedent:
--                                 append-only version corrections,
--                                 identity immutable, opaque row ids,
--                                 no resurrection);
--   studio_format_capabilities  → the FORMAT-CAPABILITY LINK
--                                 records: the append-only
--                                 normalization of a format version's
--                                 declared requiredCapabilities (the
--                                 OPAQUE capability-reference strings
--                                 — the capability ENGINE is
--                                 /lab-capabilities (LAB-013), NEVER
--                                 here; NO capability table is
--                                 created or referenced).
--
-- Key fences:
--
-- * CHECK-fenced closed vocabularies over the declared jsonb: the §8
--   input modes, the source-artifact mode, the §7 participation
--   grant models, the §9 capture modalities, the §6/§27.6 interviewer
--   representations, the interviewer follow-up discipline, the §14
--   action-kind permission set (the closed set migration 063
--   CHECK-fences for bodies), the §12 output artifact kinds, the
--   consent-kind and provenance-element vocabularies, the evaluation
--   hook firing surfaces and the per-stage availability states —
--   enforced through the IMMUTABLE SQL helper functions below (the
--   module's pure guards are the honest error surface; these CHECKs
--   are the structural authority — defense in depth, the 063/064
--   discipline).
-- * THE GUARDED LIFECYCLE (the 063 precedent): registry rows are
--   BORN DRAFT (the BEFORE INSERT fence); identity/scope/declaration
--   is IMMUTABLE after insert; the status column advances ONLY along
--   draft → active | retired, active → retired (no resurrection, no
--   downgrade); ACTIVATION (draft → active) requires the capability
--   link records to match the declaration's requiredCapabilities
--   EXACTLY (the activation-consistency trigger — a format cannot go
--   active with a desynchronized capability link set); the registry
--   NEVER deletes (retirement closes NEW resolutions only — running
--   sessions carry the bound format identity/version as their own
--   recorded data and never break).
-- * THE VERSION-CHAIN SCOPE FENCE (the 063/064 precedent): a
--   correction (version > 1) must keep the chain's scope
--   (agency/client/workspace) and requires the predecessor version
--   in the same client scope — cross-tenant or cross-workspace chain
--   poisoning is rejected at the DB.
-- * THE APPEND-ONLY LINK DISCIPLINE: the capability link records are
--   INSERT-ONLY (no UPDATE, no DELETE — a format version's link set
--   is fixed at registration; corrections are NEW version rows with
--   their own links), UNIQUE per (format_version_id,
--   capability_reference), and scope-consistent with their parent
--   format row (the cross-tenant scope-consistency trigger).
-- * TENANT ISOLATION (lock v1.7 #29): every registry/link row
--   FK-anchors the owning agency and client (+ optional workspace
--   INSIDE the client) and NOTHING else — the FK anchors are
--   EXACTLY the tenant tables + the same-module studio_formats row;
--   reads resolve foreign/unknown scope to the uniform NotFound at
--   the module (no existence oracle; the client-level fence is the
--   UNIQUE (client_id, format_id, format_version) natural key).
-- * NO PUBLISHING/EXPERIMENT/RIGHTS AUTHORITY (lock v1.7 #43 + §16 —
--   structural): this migration creates NO publishing, distribution,
--   experiment, evidence, rights, policy, workflow, execution or
--   capability table; the declaration's capability references are
--   OPAQUE strings inside the declared jsonb + the link records (the
--   existing authorities stay the sole decision-makers).
-- * NO SECRET MATERIAL ANYWHERE (CRED-001): the only structured
--   payload is the bounded declared-data declaration + the link
--   references; there is deliberately NO column capable of holding
--   secret or credential material, NO binary column and NO media
--   retention surface.
--
-- Conventions (implementation-contract §3, §25): server-generated
-- opaque identifiers (the format_version_id uuid), append-oriented
-- records. No owner/role/user columns: client-scope authorization
-- stays exactly the requireClientAccess route-layer authority — no
-- second tenant, permission or identity authority.
--
-- The initial registry CONTENT is NOT seeded here (the house
-- discipline: migrations are pure DDL — no INSERT anywhere): the
-- three frozen initial formats (reaction, audio-podcast,
-- video-podcast) are the composition-root wired declarations that
-- the module materializes per CLIENT scope on first read
-- (materialize-if-absent, born active through the SAME guarded
-- lifecycle — disclosed in the module + the runbook).
--
-- Numbering disclosure: 068 is the number PRE-ASSIGNED to this
-- delivery by the Tech Lead (the migration tail on frozen main
-- eec1eee is 065; 066 is held by the in-flight parallel LAB-004
-- worker and 067 by the LAB-013 worker — the TL reconciles numbering
-- at merge, the 062/063/064/065 precedent).

-- ---------------------------------------------------------------------------
-- The IMMUTABLE closed-vocabulary helpers (the CHECK-fence substrate)
-- ---------------------------------------------------------------------------

-- True when every element of the jsonb string array is one of the
-- allowed closed vocabulary (a non-array or a non-string element
-- fails; NULL passes — an absent optional surface is legal, the
-- module's pure guards own the deep required-shape discipline).
CREATE OR REPLACE FUNCTION studio_format_jsonb_strings_all_in(value jsonb, allowed text[]) RETURNS boolean AS $$
    SELECT value IS NULL
       OR (jsonb_typeof(value) = 'array'
           AND (SELECT bool_and(elem #>> '{}' = ANY(allowed))
                  FROM jsonb_array_elements(value) AS elem));
$$ LANGUAGE sql IMMUTABLE;

-- True when every evaluation-hook object declares a firesOn within
-- the closed firing-surface vocabulary.
CREATE OR REPLACE FUNCTION studio_format_hook_fireson_in(hooks jsonb) RETURNS boolean AS $$
    SELECT hooks IS NULL
       OR (jsonb_typeof(hooks) = 'array'
           AND (SELECT bool_and(
                    jsonb_typeof(hook) = 'object'
                    AND (hook ->> 'firesOn') = ANY(ARRAY['stage_completion', 'output_recorded']))
                  FROM jsonb_array_elements(hooks) AS hook));
$$ LANGUAGE sql IMMUTABLE;

-- True when the processing-stages array is well-formed (1-16 object
-- stages) and every stage's honest availability state is within the
-- closed vocabulary (with the awaitingModule citation required when
-- the stage awaits a future execution module).
CREATE OR REPLACE FUNCTION studio_format_stages_available(stages jsonb) RETURNS boolean AS $$
    SELECT jsonb_typeof(stages) = 'array'
       AND jsonb_array_length(stages) >= 1
       AND jsonb_array_length(stages) <= 16
       AND (SELECT bool_and(
                jsonb_typeof(stage) = 'object'
                AND (stage -> 'availability' ->> 'status') = ANY(ARRAY['runtime_driven', 'awaiting_execution_module'])
                AND (
                    (stage -> 'availability' ->> 'status') <> 'awaiting_execution_module'
                    OR (stage -> 'availability' ->> 'awaitingModule') IS NOT NULL
                ))
              FROM jsonb_array_elements(stages) AS stage);
$$ LANGUAGE sql IMMUTABLE;

-- ---------------------------------------------------------------------------
-- studio_formats — the versioned format registry (the FULL §2
-- declaration as CHECK-fenced declared data + the guarded lifecycle)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS studio_formats (
    -- The server-generated opaque row identity (the capability
    -- links' FK anchor; the caller-visible identity is the
    -- (format_id, format_version) natural key below).
    format_version_id   uuid        PRIMARY KEY,
    -- THE NATURAL KEY: one row per (client, format_id,
    -- format_version); corrections append NEW version rows under the
    -- SAME format_id (the identity is immutable across the chain).
    format_id           text        NOT NULL
                        CHECK (format_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
    format_version      integer     NOT NULL CHECK (format_version >= 1 AND format_version <= 1000),
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id        uuid        REFERENCES workspaces(workspace_id),
    -- The /lab-agent-body versioned-registry lifecycle: draft →
    -- active → retired, no resurrection (the guard trigger encodes
    -- the exact edges; rows are BORN DRAFT — the BEFORE INSERT
    -- fence).
    status              text        NOT NULL
                        CHECK (status IN ('draft', 'active', 'retired')),
    -- THE FULL §2 DECLARATION as declared data (all NINE surfaces,
    -- one-level-shaped — the module's pure guards validate the deep
    -- shape; these CHECKs pin the closed vocabularies structurally):
    --   surface 2 (input requirements): the §8 input-mode subset +
    --            the source-artifact mode;
    --   surface 3 (participant model): the §7 grant model + the
    --            human-capture mode;
    --   surface 4 (capture requirements): the §9 modality subset;
    --   surface 5 (interviewer requirements): the interviewer mode +
    --            the §6/§27.6 representation subset + the follow-up
    --            discipline;
    --   surface 6 (organization compatibility): the §14 action-kind
    --            permission subset (the closed set migration 063
    --            CHECK-fences) + the minAgentBodies bound;
    --   surface 7 (output artifact contract): the §12 artifact-kind
    --            subset (non-empty);
    --   surface 8 (provenance/consent requirements): the consent-kind
    --            + provenance-element subsets;
    --   surface 9 (evaluation hooks): the closed firing surfaces;
    --   + the per-stage honest availability layer.
    declaration         jsonb       NOT NULL
                        CHECK (jsonb_typeof(declaration) = 'object')
                        CHECK (studio_format_jsonb_strings_all_in(
                            declaration -> 'inputRequirements' -> 'modes',
                            ARRAY['script', 'question_list', 'intent']))
                        CHECK (jsonb_array_length(declaration -> 'inputRequirements' -> 'modes') >= 1)
                        CHECK ((declaration -> 'inputRequirements' ->> 'sourceArtifacts') IN ('required', 'optional'))
                        CHECK ((declaration -> 'participantModel' ->> 'humanCapture') IN ('required', 'optional'))
                        CHECK ((declaration -> 'participantModel' ->> 'participationGrants') IN ('single_scope', 'explicit_grant_per_participant'))
                        CHECK (studio_format_jsonb_strings_all_in(
                            declaration -> 'captureRequirements' -> 'modalities',
                            ARRAY['audio', 'video', 'screen', 'participant_streams', 'alternate_takes']))
                        CHECK (jsonb_array_length(declaration -> 'captureRequirements' -> 'modalities') >= 1)
                        CHECK ((declaration -> 'interviewerRequirements' ->> 'interviewer') IN ('none', 'representation'))
                        CHECK (studio_format_jsonb_strings_all_in(
                            declaration -> 'interviewerRequirements' -> 'representations',
                            ARRAY['voice', 'voice_text', 'avatar', 'prerecorded', 'generated', 'multimodal_declared', 'hybrid']))
                        CHECK ((declaration -> 'interviewerRequirements' ->> 'followUps') IS NULL
                               OR (declaration -> 'interviewerRequirements' ->> 'followUps') IN ('adaptive', 'fixed'))
                        CHECK (studio_format_jsonb_strings_all_in(
                            declaration -> 'organizationRequirements' -> 'requiredPermissions',
                            ARRAY['read', 'analyze', 'compose', 'transform', 'communicate', 'simulate']))
                        CHECK (jsonb_array_length(declaration -> 'organizationRequirements' -> 'requiredPermissions') >= 1)
                        CHECK ((declaration -> 'organizationRequirements' ->> 'minAgentBodies') ~ '^[0-9]{1,2}$'
                               AND (declaration -> 'organizationRequirements' ->> 'minAgentBodies')::int BETWEEN 1 AND 32)
                        CHECK (studio_format_jsonb_strings_all_in(
                            declaration -> 'outputContract' -> 'outputs',
                            ARRAY['raw_captures', 'final_media', 'alternate_takes', 'transcript',
                                  'question_answer_graph', 'timestamps', 'participant_contributions',
                                  'edit_graph', 'transform_graph', 'composition_layout',
                                  'captions_subtitles', 'derived_clips', 'provenance',
                                  'consent_records', 'quality_evaluation_metadata', 'costs_durations']))
                        CHECK (jsonb_array_length(declaration -> 'outputContract' -> 'outputs') >= 1)
                        CHECK (studio_format_jsonb_strings_all_in(
                            declaration -> 'provenanceConsentRequirements' -> 'consent',
                            ARRAY['participant_recording_consent', 'interviewer_representation_disclosure',
                                  'participant_contribution_rights', 'source_artifact_rights']))
                        CHECK (studio_format_jsonb_strings_all_in(
                            declaration -> 'provenanceConsentRequirements' -> 'provenance',
                            ARRAY['source_reference', 'human_capture', 'interviewer_representation',
                                  'generated_vs_human_distinction', 'question_answer_sequence', 'recording',
                                  'transform_graph', 'edit_graph', 'participant_contribution', 'treatment_lineage']))
                        CHECK (studio_format_hook_fireson_in(declaration -> 'evaluationHooks' -> 'hooks'))
                        CHECK (studio_format_stages_available(declaration -> 'processingStages')),
    -- The format-framework contract identity (STUDIO-002 — distinct
    -- from the STUDIO-001 runtime contract pinned on the six
    -- migration-064 tables; the /lab-features versioned-sub-contract
    -- precedent).
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'content-studio-format-v1'),
    created_at          timestamptz NOT NULL,
    updated_at          timestamptz NOT NULL,
    CONSTRAINT studio_formats_natural_key UNIQUE (client_id, format_id, format_version)
);

-- The client's registry tail (version order within each identity).
CREATE INDEX IF NOT EXISTS studio_formats_client_idx
    ON studio_formats (client_id, format_id, format_version, created_at);

-- Registry rows are BORN DRAFT: registration inserts a draft; the
-- explicit guarded activation is the only route to active (the
-- lifecycle gate — a stronger fence than the 063 precedent, disclosed
-- in the runbook).
CREATE OR REPLACE FUNCTION studio_formats_born_draft() RETURNS trigger AS $$
BEGIN
    IF NEW.status <> 'draft' THEN
        RAISE EXCEPTION 'studio format % version % is born with status ''%'' — registry rows are BORN DRAFT and reach active only through the explicit guarded activation',
            NEW.format_id, NEW.format_version, NEW.status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_formats_born_draft_trigger ON studio_formats;
CREATE TRIGGER studio_formats_born_draft_trigger
    BEFORE INSERT ON studio_formats
    FOR EACH ROW EXECUTE FUNCTION studio_formats_born_draft();

-- Registry row identity/scope/declaration is immutable after insert;
-- only the lifecycle status and the server-managed updated_at may
-- advance — draft → active | retired, active → retired (no
-- resurrection, no downgrade, no same-row correction). ACTIVATION
-- additionally requires the capability link records to match the
-- declaration's requiredCapabilities EXACTLY (the
-- activation-consistency fence: a format cannot go active with a
-- desynchronized link set — the links are the normalized declaration).
CREATE OR REPLACE FUNCTION studio_format_guard() RETURNS trigger AS $$
DECLARE
    declared_required text[];
    linked_required text[];
BEGIN
    IF NEW.format_version_id <> OLD.format_version_id
       OR NEW.format_id <> OLD.format_id
       OR NEW.format_version <> OLD.format_version
       OR NEW.agency_id <> OLD.agency_id
       OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.declaration <> OLD.declaration
       OR NEW.contract_version <> OLD.contract_version
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'studio format % version % identity/scope/declaration is immutable — corrections are NEW version rows',
            OLD.format_id, OLD.format_version;
    END IF;
    IF NOT (
           (OLD.status = 'draft' AND NEW.status IN ('active', 'retired'))
        OR (OLD.status = 'active' AND NEW.status = 'retired')
        OR (OLD.status = NEW.status)
    ) THEN
        RAISE EXCEPTION 'studio format % version % lifecycle transition % → % is not legal (draft → active → retired; no resurrection)',
            NEW.format_id, NEW.format_version, OLD.status, NEW.status;
    END IF;
    IF OLD.status = 'draft' AND NEW.status = 'active' THEN
        SELECT COALESCE(array_agg(value ORDER BY value), '{}'::text[]) INTO declared_required
            FROM jsonb_array_elements_text(
                COALESCE(NEW.declaration -> 'organizationRequirements' -> 'requiredCapabilities', '[]'::jsonb));
        SELECT COALESCE(array_agg(capability_reference ORDER BY capability_reference), '{}'::text[]) INTO linked_required
            FROM studio_format_capabilities
            WHERE format_version_id = NEW.format_version_id;
        IF declared_required IS DISTINCT FROM linked_required THEN
            RAISE EXCEPTION 'studio format % version % cannot activate: the capability link records do not match the declared requiredCapabilities (the activation-consistency fence)',
                NEW.format_id, NEW.format_version;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_format_guard_trigger ON studio_formats;
CREATE TRIGGER studio_format_guard_trigger
    BEFORE UPDATE ON studio_formats
    FOR EACH ROW EXECUTE FUNCTION studio_format_guard();

-- Registry rows are never deleted (the format history is
-- append-only; retirement closes NEW resolutions only — running
-- sessions carry the bound format identity/version as their own
-- recorded data and never break).
CREATE OR REPLACE FUNCTION studio_formats_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'studio format registry rows cannot be deleted — format history is append-only (retire, never delete)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_formats_no_delete_trigger ON studio_formats;
CREATE TRIGGER studio_formats_no_delete_trigger
    BEFORE DELETE ON studio_formats
    FOR EACH ROW EXECUTE FUNCTION studio_formats_no_delete();

-- The version-chain scope fence (the 063/064 precedent): a
-- correction (version > 1) requires the predecessor version in the
-- same client scope AND must keep the chain's scope
-- (agency/client/workspace) — cross-tenant or cross-workspace chain
-- poisoning is rejected at the DB.
CREATE OR REPLACE FUNCTION studio_format_chain_scope_check() RETURNS trigger AS $$
DECLARE
    chain_client uuid;
    chain_agency uuid;
    chain_workspace uuid;
BEGIN
    IF NEW.format_version > 1 THEN
        SELECT client_id, agency_id, workspace_id
            INTO chain_client, chain_agency, chain_workspace
            FROM studio_formats
            WHERE client_id = NEW.client_id AND format_id = NEW.format_id AND format_version = NEW.format_version - 1;
        IF chain_client IS NULL THEN
            RAISE EXCEPTION 'studio format version chain is broken (%, %)',
                NEW.format_id, NEW.format_version - 1;
        END IF;
        IF chain_client <> NEW.client_id OR chain_agency <> NEW.agency_id
           OR chain_workspace IS DISTINCT FROM NEW.workspace_id THEN
            RAISE EXCEPTION 'studio format correction must keep the version chain scope (cross-tenant/cross-workspace corrections are rejected)';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_format_chain_scope_trigger ON studio_formats;
CREATE TRIGGER studio_format_chain_scope_trigger
    BEFORE INSERT ON studio_formats
    FOR EACH ROW EXECUTE FUNCTION studio_format_chain_scope_check();

-- ---------------------------------------------------------------------------
-- studio_format_capabilities — the append-only format-capability
-- link records (the normalized declared requiredCapabilities)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS studio_format_capabilities (
    -- The parent registry row (the same-module FK anchor — the ONLY
    -- non-tenant FK in this migration).
    format_version_id   uuid        NOT NULL REFERENCES studio_formats(format_version_id),
    -- The closed capability-link kind: 'required' — the normalized
    -- declaration of the format's organizationRequirements.
    -- requiredCapabilities (the kind vocabulary is CHECK-fenced for
    -- the future link kinds; adding one is a guarded migration).
    capability_kind     text        NOT NULL
                        CHECK (capability_kind IN ('required')),
    -- The OPAQUE capability reference (bounded; the capability ENGINE
    -- is /lab-capabilities, LAB-013 — NEVER this module: no
    -- capability table is created or referenced here).
    capability_reference text       NOT NULL
                        CHECK (char_length(capability_reference) >= 1
                               AND char_length(capability_reference) <= 256),
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id        uuid        REFERENCES workspaces(workspace_id),
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'content-studio-format-v1'),
    created_at          timestamptz NOT NULL,
    CONSTRAINT studio_format_capabilities_pk PRIMARY KEY (format_version_id, capability_reference)
);

-- The parent row's link tail.
CREATE INDEX IF NOT EXISTS studio_format_capabilities_client_idx
    ON studio_format_capabilities (client_id, format_version_id, capability_reference, created_at);

-- The link set of a format version is fixed at registration: the
-- link records are INSERT-ONLY (no UPDATE, no DELETE — corrections
-- are NEW version rows with their own links).
CREATE OR REPLACE FUNCTION studio_format_capabilities_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'studio format capability link records are immutable (INSERT only — corrections are NEW format version rows with their own links)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_format_capabilities_no_update_trigger ON studio_format_capabilities;
CREATE TRIGGER studio_format_capabilities_no_update_trigger
    BEFORE UPDATE ON studio_format_capabilities
    FOR EACH ROW EXECUTE FUNCTION studio_format_capabilities_immutable();

DROP TRIGGER IF EXISTS studio_format_capabilities_no_delete_trigger ON studio_format_capabilities;
CREATE TRIGGER studio_format_capabilities_no_delete_trigger
    BEFORE DELETE ON studio_format_capabilities
    FOR EACH ROW EXECUTE FUNCTION studio_format_capabilities_immutable();

-- The cross-tenant scope-consistency fence: a link record must carry
-- EXACTLY its parent registry row's scope (agency/client/workspace) —
-- cross-tenant or cross-workspace link injection is rejected at the
-- DB (the 064 scope-trigger discipline).
CREATE OR REPLACE FUNCTION studio_format_capability_scope_check() RETURNS trigger AS $$
DECLARE
    parent_client uuid;
    parent_agency uuid;
    parent_workspace uuid;
BEGIN
    SELECT client_id, agency_id, workspace_id
        INTO parent_client, parent_agency, parent_workspace
        FROM studio_formats
        WHERE format_version_id = NEW.format_version_id;
    IF parent_client IS NULL THEN
        RAISE EXCEPTION 'studio format capability link has no parent registry row (%)',
            NEW.format_version_id;
    END IF;
    IF parent_client <> NEW.client_id OR parent_agency <> NEW.agency_id
       OR parent_workspace IS DISTINCT FROM NEW.workspace_id THEN
        RAISE EXCEPTION 'studio format capability link must keep its parent format row scope (cross-tenant/cross-workspace link injection is rejected)';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_format_capability_scope_trigger ON studio_format_capabilities;
CREATE TRIGGER studio_format_capability_scope_trigger
    BEFORE INSERT ON studio_format_capabilities
    FOR EACH ROW EXECUTE FUNCTION studio_format_capability_scope_check();
