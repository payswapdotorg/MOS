-- 070_studio_script_question_graph.sql — STUDIO-003 (Intent → Script /
-- Question Graph).
--
-- THE INTENT-TO-SCRIPT AUTHORITY (spec/effective-backlog-v1.7.md
-- STUDIO-003: "Support user-provided scripts/questions and
-- intent-driven generation. Acceptance: versioned scripts/question
-- graphs, explicit human-review option, adaptive branching hooks,
-- provenance of generated material."; dependencies: STUDIO-001 —
-- merged PR #73, migration 064; LAB-011 — merged PR #70; STUDIO-002 —
-- merged PR #78, migration 068 is the format framework this delivery
-- hooks into). The governing sub-contract is
-- spec/content-studio-contract-v1.0.md (FROZEN):
-- §3 "A Production Request is immutable/versioned and contains: ...
-- explicit script/question list if supplied; intent if script is not
-- supplied; ... model/capability references; ..." (the request
-- linkage every script/question-graph/intent record carries);
-- §8 "Intent-to-script — The Studio may accept: a complete script; a
-- podcast question list; an intent/objective; an intent plus supplied
-- source material. When only intent is supplied, the selected
-- organization may generate a production script/question graph. The
-- generated script is versioned and reviewable before recording when
-- the format requires explicit user confirmation. An adaptive
-- interviewer may choose a follow-up from the declared question/branch
-- graph based on the preceding answer while preserving the resulting
-- conversation graph.";
-- §6 ("The interviewer may adapt questions using previous answers." +
-- "The Studio MUST preserve: question/answer sequence; interviewer
-- representation provenance; generated versus human-authored
-- distinction; recording provenance; participant consent.");
-- §12 (the artifact package vocabulary incl. 'question/answer graph');
-- §17/§18 (provenance of every implemented path); architecture-v1.7
-- §27.5 ("A Studio production request may provide: an explicit script;
-- a podcast question list; an intent/objective from which the
-- Studio/selected organization generates a script; a Lab-generated
-- production program." + "Formats are pluggable."), §27.6 (the
-- interviewer question/branch graph usage), §28 (the Lab invocation
-- boundary — this module composes, never becomes a second authority);
-- architecture-lock-v1.7 #38-#44 (the Studio production artifacts;
-- #43 "The Studio is not a marketing objective, publishing, rights,
-- policy, experiment, evidence, workflow, execution, model-routing or
-- marketplace authority.").
--
-- Six own tables ONLY (the 063/064/065/068 one-module-owns-its-tables
-- discipline; the STUDIO-001 six runtime tables + the STUDIO-002 two
-- registry tables are UNTOUCHED — this migration is purely additive;
-- the ONE exception is the additive CHECK constraint appended to the
-- same-module studio_formats table at the tail, fencing the new
-- OPTIONAL declaration field — disclosed below):
--
--   studio_intents               → the INTENT records: the materialized
--                                  request intent (the declared
--                                  objective) + the optional supplied
--                                  source/reference material citations
--                                  (OPAQUE strings — never joined, the
--                                  /lab-corpus by-reference discipline);
--                                  one row per (request, request
--                                  version) — the §3 request linkage is
--                                  the natural key; INSERT-only;
--   studio_scripts               → the VERSIONED SCRIPT records: one
--                                  version CHAIN per (request, request
--                                  version — the one-materialization
--                                  fence); origin 'supplied' (the §3
--                                  path — recorded, versioned, NO
--                                  generation, NO review) or 'generated'
--                                  (the organization's output — FULL
--                                  provenance REQUIRED: the intent
--                                  lineage FK + the generator
--                                  organization identity + the
--                                  participating model/capability
--                                  references) + the GUARDED review
--                                  lifecycle (born 'pending'; pending →
--                                  approved | rejected | superseded;
--                                  approved | rejected → superseded; no
--                                  resurrection) + append-only version
--                                  corrections (the chain-scope fence);
--   studio_script_reviews        → the HUMAN-REVIEW DECISION records
--                                  for scripts: the append-only audit
--                                  tail behind every review-state
--                                  advance — the verdict from the
--                                  closed vocabulary, the reviewer actor
--                                  + the honest autonomous/human split;
--   studio_question_graphs       → the VERSIONED QUESTION-GRAPH
--                                  records: the DECLARED question/branch
--                                  graph (nodes are questions with their
--                                  closed modality hints; edges are the
--                                  declared branch conditions from the
--                                  closed condition vocabulary with
--                                  DETERMINISTIC ADJACENCY — at most one
--                                  edge per (from-question, condition));
--                                  the same origin/review/versioning
--                                  discipline as scripts;
--   studio_question_graph_reviews→ the HUMAN-REVIEW DECISION records
--                                  for question graphs (the same
--                                  append-only decision discipline);
--   studio_conversation_edges    → the CONVERSATION-GRAPH HOOK records
--                                  (the adaptive-branching surface): one
--                                  append-only row per conversation step
--                                  — the question asked, the recorded
--                                  answer (OPAQUE reference + closed
--                                  answer kind), the CHOSEN edge (the
--                                  declared edge chosen for the
--                                  preceding answer, validated against
--                                  the declared graph version this
--                                  conversation walks) and the honest
--                                  chooser split (interviewer vs human).
--                                  The interviewer CHOICE MECHANICS are
--                                  STUDIO-004 — this surface is the
--                                  structural home the choices land in
--                                  (the disclosed boundary).
--
-- Key fences:
--
-- * CHECK-fenced closed vocabularies on every enumerated column: the
--   script/question-graph origins (supplied/generated), the review
--   states (pending/approved/rejected/superseded), the review verdicts
--   (approved/rejected/superseded), the reviewer kinds
--   (human/autonomous — the honest split), the question modality hints
--   (the §6/§27.6 interviewer representation vocabulary migration 068
--   CHECK-fences for formats), the branch conditions (the closed
--   condition vocabulary — the DISCLOSED mapping of §8 "based on the
--   preceding answer"), the answer kinds, the chooser kinds
--   (interviewer/human) and the pinned contract version
--   'content-studio-script-v1'.
-- * THE ORIGIN-SHAPE FENCE (the 064 terminal-shape precedent): a
--   SUPPLIED row carries NO generation provenance and NO review state;
--   a GENERATED row REQUIRES the intent lineage + the generator
--   organization identity + the participating model/capability
--   references + the review state (EVERY generated material record
--   carries its provenance structurally — "no generated material is
--   ever presented without its provenance record").
-- * THE GUARDED REVIEW LIFECYCLE (the 063/068 status-guard precedent):
--   generated rows are BORN 'pending' (the born-pending fence); row
--   identity/scope/linkage/provenance is IMMUTABLE after insert; ONLY
--   the review state + updated_at may advance, and ONLY along pending
--   → approved | rejected | superseded, approved → superseded,
--   rejected → superseded (no resurrection, no downgrade); every
--   advance is backed by a matching append-only review decision record
--   (the decision-then-advance trigger ordering — the review insert
--   fires first, then the state advance).
-- * THE VERSION-CHAIN DISCIPLINE: corrections/regenerations append NEW
--   version rows under the same chain id (the chain-scope fence: the
--   chain's agency/client/workspace/request-linkage kept); ONE script
--   chain or ONE question-graph chain per (request, request version)
--   (the deterministic production input — the one-materialization
--   fence: the request's §8 exactly-one input, and the intent path
--   materializes EITHER a generated script chain OR a generated
--   question-graph chain, never both); the request's input mode
--   matches the origin (mode 'script'/'question_list' ⟺ origin
--   'supplied'; mode 'intent' ⟺ origin 'generated' — the scope
--   triggers enforce the pairing).
-- * THE APPEND-ONLY DISCIPLINE: intents, review decisions and
--   conversation edges are INSERT-ONLY (UPDATE and DELETE rejected);
--   scripts and question graphs advance only through the guarded
--   review-state trigger; nothing is ever deleted.
-- * THE DETERMINISTIC ADJACENCY (the declared question/branch graph):
--   the graph jsonb is CHECK-fenced (the IMMUTABLE SQL helpers below):
--   1-128 question nodes each with a bounded unique questionId + text
--   + optional modality hints within the closed 7-member interviewer
--   representation vocabulary; 0-256 declared edges each with from/to
--   endpoints that ARE declared nodes (and differ) + a condition from
--   the closed 6-member condition vocabulary; at most ONE edge per
--   (from, condition) — the interviewer choosing by condition always
--   has a deterministic next question; the entry question is a
--   declared node.
-- * THE CONVERSATION-GRAPH FENCE: every conversation edge row binds
--   the session revision (the composite FK), the declared question
--   graph version it walks (the composite FK — bound to the session's
--   OWN request version, enforced) and the chosen edge (validated
--   against that declared jsonb: the question asked is a declared
--   node; the chosen (from → to, condition) edge is a DECLARED edge;
--   seq 1 asks the declared entry question); the per-conversation seq
--   is UNIQUE.
-- * THE SCOPE FENCES: every row FK-anchors the owning agency and
--   client (+ optional workspace INSIDE the client) and the
--   same-module rows (the exact request version / the intent / the
--   script or graph chain / the session revision); the
--   scope-consistency triggers reject any row whose client does not
--   match its anchor's client (cross-tenant injection is rejected at
--   the DB — the §22/v1.7 #29 tenant/workspace scoping).
-- * NO PUBLISHING/EXPERIMENT/RIGHTS AUTHORITY (lock v1.7 #43 + §16 —
--   structural): this migration creates NO publishing, distribution,
--   experiment, evidence, rights, policy, workflow, execution or
--   capability table and NO foreign key into any other module; the
--   source/reference material citations, the generator model/
--   capability references, the answer references and the reviewer
--   actors are OPAQUE strings inside the declared jsonb (the existing
--   authorities stay the sole decision-makers).
-- * NO SECRET MATERIAL ANYWHERE (CRED-001): the only structured
--   payload columns are the bounded declared-data contracts and the
--   bounded bounded-string identity columns — there is deliberately
--   NO column capable of holding secret or credential material, and
--   NO binary column exists anywhere.
--
-- Conventions (implementation-contract §3, §25): server-generated
-- opaque identifiers, append-oriented tails. No owner/role/user
-- columns: client-scope authorization stays exactly the
-- requireClientAccess route-layer authority — no second tenant,
-- permission or identity authority.
--
-- The additive CHECK on the same-module studio_formats table: §8 says
-- the generated script is reviewable before recording "when the
-- format requires explicit user confirmation" — STUDIO-002's frozen
-- nine-surface declaration shape carries no such field, so this
-- delivery adds the OPTIONAL inputRequirements.generatedInputReview
-- field ('required' | 'not_required'; ABSENT = not required — every
-- existing declaration and every already-materialized tenant registry
-- row is unaffected). The CHECK below fences the closed vocabulary of
-- the new OPTIONAL field on the SAME-MODULE registry table (the
-- smallest architecture-consistent extension, DISCLOSED in the
-- runbook).
--
-- Numbering disclosure: 070 is the number PRE-ASSIGNED to this
-- delivery by the Tech Lead (the migration tail on frozen main
-- 3d5de78 is ...065 → 066 → 067 → 068 → 071; 069 is held by the
-- in-flight parallel MKT-073 worker and 071 is taken by the merged
-- LAB-005 delivery — 070 slots into the 068→071 gap in the ordered
-- list; the TL resolves any stacked shifts at merge, the
-- 062/063/064/065/068 precedent).

-- ---------------------------------------------------------------------------
-- The IMMUTABLE closed-vocabulary helpers (the CHECK-fence substrate)
-- ---------------------------------------------------------------------------

-- True when every question node is a well-formed object with a bounded
-- unique questionId + a bounded text + optional modality hints within
-- the closed §6/§27.6 interviewer representation vocabulary (the same
-- 7-member set migration 068 CHECK-fences for format declarations).
CREATE OR REPLACE FUNCTION studio_graph_nodes_wellformed(nodes jsonb) RETURNS boolean AS $$
    SELECT jsonb_typeof(nodes) = 'array'
       AND jsonb_array_length(nodes) >= 1
       AND jsonb_array_length(nodes) <= 128
       AND (SELECT bool_and(
                jsonb_typeof(node) = 'object'
                AND (node ->> 'questionId') ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
                AND char_length(node ->> 'text') >= 1
                AND char_length(node ->> 'text') <= 2000
                AND (
                    (node -> 'modalityHints') IS NULL
                    OR (jsonb_typeof(node -> 'modalityHints') = 'array'
                        AND jsonb_array_length(node -> 'modalityHints') <= 7
                        AND (SELECT bool_and(hint #>> '{}' = ANY(ARRAY['voice', 'voice_text', 'avatar', 'prerecorded', 'generated', 'multimodal_declared', 'hybrid']))
                               FROM jsonb_array_elements(node -> 'modalityHints') AS hint))
                ))
              FROM jsonb_array_elements(nodes) AS node)
       AND (SELECT count(DISTINCT node ->> 'questionId') = count(*)
              FROM jsonb_array_elements(nodes) AS node);
$$ LANGUAGE sql IMMUTABLE;

-- True when every declared edge is a well-formed object whose endpoints
-- are declared nodes, whose condition is within the closed condition
-- vocabulary, and whose (from, condition) pair is UNIQUE — the
-- DETERMINISTIC ADJACENCY fence (at most one edge per from-question per
-- condition, so a follow-up chosen by condition always resolves to
-- exactly one next question).
CREATE OR REPLACE FUNCTION studio_graph_edges_declared(edges jsonb, nodes jsonb) RETURNS boolean AS $$
    SELECT jsonb_typeof(edges) = 'array'
       AND jsonb_array_length(edges) <= 256
       AND (SELECT bool_and(
                jsonb_typeof(edge) = 'object'
                AND (edge ->> 'fromQuestionId') ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
                AND (edge ->> 'toQuestionId') ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
                AND (edge ->> 'fromQuestionId') IS DISTINCT FROM (edge ->> 'toQuestionId')
                AND (edge ->> 'condition') = ANY(ARRAY['always', 'on_answer_positive', 'on_answer_negative',
                                                       'on_answer_neutral', 'on_answer_elaborate', 'on_answer_abbreviated'])
                AND (edge ->> 'fromQuestionId') IN (SELECT node ->> 'questionId' FROM jsonb_array_elements(nodes) AS node)
                AND (edge ->> 'toQuestionId') IN (SELECT node ->> 'questionId' FROM jsonb_array_elements(nodes) AS node)
              )
              FROM jsonb_array_elements(edges) AS edge)
       AND (SELECT count(*) = count(DISTINCT (edge ->> 'fromQuestionId') || '|' || (edge ->> 'condition'))
              FROM jsonb_array_elements(edges) AS edge);
$$ LANGUAGE sql IMMUTABLE;

-- True when the full declared graph shape is well-formed: the nodes, the
-- edges and the entry question (which must be a declared node).
CREATE OR REPLACE FUNCTION studio_graph_declared_wellformed(declared jsonb) RETURNS boolean AS $$
    SELECT jsonb_typeof(declared) = 'object'
       AND studio_graph_nodes_wellformed(declared -> 'nodes')
       AND studio_graph_edges_declared(declared -> 'edges', declared -> 'nodes')
       AND (declared ->> 'entryQuestionId') ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
       AND (declared ->> 'entryQuestionId') IN (SELECT node ->> 'questionId' FROM jsonb_array_elements(declared -> 'nodes') AS node);
$$ LANGUAGE sql IMMUTABLE;

-- True when a reviewer identity is a bounded non-empty string (the
-- OPAQUE actor identity — never joined).
CREATE OR REPLACE FUNCTION studio_review_actor_bounded(actor text) RETURNS boolean AS $$
    SELECT actor IS NOT NULL AND char_length(actor) >= 1 AND char_length(actor) <= 128;
$$ LANGUAGE sql IMMUTABLE;

-- True when the jsonb value is an array of bounded OPAQUE citation
-- strings (the intent's source references / the generator's model
-- references): at most max_entries entries, each a string of
-- 1..max_chars chars. The subquery lives INSIDE this IMMUTABLE helper
-- (the 068 discipline — CHECK constraint expressions may not carry
-- sublinks; the helpers hide the jsonb traversal).
CREATE OR REPLACE FUNCTION studio_citations_all_bounded(value jsonb, max_entries integer, max_chars integer) RETURNS boolean AS $$
    SELECT jsonb_typeof(value) = 'array'
       AND jsonb_array_length(value) <= max_entries
       AND (SELECT bool_and(
                    jsonb_typeof(ref) = 'string'
                    AND char_length(ref #>> '{}') >= 1
                    AND char_length(ref #>> '{}') <= max_chars
                ) FROM jsonb_array_elements(value) AS ref);
$$ LANGUAGE sql IMMUTABLE;

-- ---------------------------------------------------------------------------
-- studio_intents — the INTENT records (the materialized request intent
-- + the supplied source/reference material citations)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS studio_intents (
    intent_id           uuid        PRIMARY KEY,
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id        uuid        REFERENCES workspaces(workspace_id),
    -- THE §3 REQUEST LINKAGE (the natural key): one intent per (request,
    -- request version) — the request's declared intent materialized as
    -- its own first-class record (the generation lineage anchor).
    request_id          uuid        NOT NULL,
    request_version     integer     NOT NULL CHECK (request_version >= 1),
    -- The declared objective (the §8 intent — bounded, trimmed).
    objective           text        NOT NULL
                        CHECK (char_length(objective) >= 1 AND char_length(objective) <= 2000),
    -- The OPTIONAL supplied source/reference material citations (§8 "an
    -- intent plus supplied source material") — OPAQUE strings, never
    -- joined (the Content Asset authorities stay the decision-makers).
    source_references   jsonb       NOT NULL
                        CHECK (studio_citations_all_bounded(source_references, 64, 512)),
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'content-studio-script-v1'),
    created_at          timestamptz NOT NULL,
    CONSTRAINT studio_intents_request UNIQUE (request_id, request_version)
);

-- The client's intent tail.
CREATE INDEX IF NOT EXISTS studio_intents_client_idx
    ON studio_intents (client_id, request_id, request_version, created_at);

-- Intents are immutable INSERT-ONLY records (the declared objective and
-- its citations never rewrite — a corrected request version carries a
-- NEW intent record): NO UPDATE, NO DELETE.
CREATE OR REPLACE FUNCTION studio_intents_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'studio intents are immutable (INSERT only — a corrected request version carries a NEW intent record)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_intents_no_update_trigger ON studio_intents;
CREATE TRIGGER studio_intents_no_update_trigger
    BEFORE UPDATE ON studio_intents
    FOR EACH ROW EXECUTE FUNCTION studio_intents_immutable();

DROP TRIGGER IF EXISTS studio_intents_no_delete_trigger ON studio_intents;
CREATE TRIGGER studio_intents_no_delete_trigger
    BEFORE DELETE ON studio_intents
    FOR EACH ROW EXECUTE FUNCTION studio_intents_immutable();

-- Scope + mode consistency: the intent must bind an EXISTING request
-- version in the SAME client, and that request version's §8 input mode
-- must be 'intent' (the generation path — a script/question_list
-- request never materializes an intent record).
CREATE OR REPLACE FUNCTION studio_intent_scope_check() RETURNS trigger AS $$
DECLARE
    request_client uuid;
    request_mode text;
BEGIN
    SELECT client_id, content -> 'input' ->> 'mode'
        INTO request_client, request_mode
        FROM studio_production_requests
        WHERE request_id = NEW.request_id AND request_version = NEW.request_version;
    IF request_client IS NULL THEN
        RAISE EXCEPTION 'studio intent must bind an existing request version (%, %)',
            NEW.request_id, NEW.request_version;
    END IF;
    IF request_client <> NEW.client_id THEN
        RAISE EXCEPTION 'studio intent client must match its request version client (cross-tenant intents are rejected)';
    END IF;
    IF request_mode <> 'intent' THEN
        RAISE EXCEPTION 'studio intent requires the request version''s input mode to be ''intent'' (found ''%'') — the intent path is the generation path',
            request_mode;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_intent_scope_trigger ON studio_intents;
CREATE TRIGGER studio_intent_scope_trigger
    BEFORE INSERT ON studio_intents
    FOR EACH ROW EXECUTE FUNCTION studio_intent_scope_check();

-- ---------------------------------------------------------------------------
-- studio_scripts — the VERSIONED SCRIPT records (supplied | generated;
-- the guarded review lifecycle for generated rows)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS studio_scripts (
    -- THE VERSION CHAIN KEY: one row per (script, version) —
    -- corrections/regenerations append NEW version rows under the SAME
    -- script_id (the request-version-chain discipline; the
    -- one-materialization fence below keeps ONE chain per (request,
    -- request version)).
    script_id           uuid        NOT NULL,
    script_version      integer     NOT NULL CHECK (script_version >= 1 AND script_version <= 1000),
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id        uuid        REFERENCES workspaces(workspace_id),
    -- THE §3 REQUEST LINKAGE: the script chain binds EXACTLY the request
    -- version it prepares for (the FK is completed at the migration
    -- tail — the 064 composite-FK discipline).
    request_id          uuid        NOT NULL,
    request_version     integer     NOT NULL CHECK (request_version >= 1),
    -- The §8 origin: 'supplied' (the §3 path — recorded, versioned, NO
    -- generation) or 'generated' (the organization's output — FULL
    -- provenance required below).
    origin              text        NOT NULL
                        CHECK (origin IN ('supplied', 'generated')),
    -- The script body as DECLARED DATA (bounded jsonb; the module's
    -- pure guards own the deep shape).
    body                jsonb       NOT NULL
                        CHECK (jsonb_typeof(body) = 'object'),
    -- THE GENERATION PROVENANCE (REQUIRED on generated rows, FORBIDDEN
    -- on supplied rows — the origin-shape fence below): the intent
    -- lineage (which intent + source citations produced it — the intent
    -- row carries the citations), the generator organization identity
    -- (which organization version generated it, verbatim) and the
    -- participating model/capability references (OPAQUE strings).
    intent_id           uuid        REFERENCES studio_intents(intent_id),
    generator_organization jsonb
                        CHECK (generator_organization IS NULL OR jsonb_typeof(generator_organization) = 'object'),
    generator_model_references jsonb
                        CHECK (generator_model_references IS NULL
                               OR studio_citations_all_bounded(generator_model_references, 32, 256)),
    -- THE EXPLICIT HUMAN-REVIEW OPTION (generated rows only): the
    -- review state from the closed vocabulary — born 'pending'
    -- (the born-pending fence below), advancing ONLY through the
    -- guarded edges (the review-state guard trigger + the append-only
    -- decision records in studio_script_reviews).
    review_state        text
                        CHECK (review_state IS NULL
                               OR review_state IN ('pending', 'approved', 'rejected', 'superseded')),
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'content-studio-script-v1'),
    created_at          timestamptz NOT NULL,
    updated_at          timestamptz NOT NULL,
    CONSTRAINT studio_scripts_pk PRIMARY KEY (script_id, script_version),
    -- THE ORIGIN-SHAPE FENCE: a supplied script carries NO generation
    -- provenance and NO review state; a generated script carries the
    -- FULL provenance + a review state (every generated line carries
    -- its generator identity — structurally).
    CONSTRAINT studio_scripts_origin_shape CHECK (
        (origin = 'supplied'
         AND intent_id IS NULL
         AND generator_organization IS NULL
         AND generator_model_references IS NULL
         AND review_state IS NULL)
        OR (origin = 'generated'
            AND intent_id IS NOT NULL
            AND generator_organization IS NOT NULL
            AND generator_model_references IS NOT NULL
            AND review_state IS NOT NULL)
    )
);

-- The client's script tail (newest version last per chain).
CREATE INDEX IF NOT EXISTS studio_scripts_client_idx
    ON studio_scripts (client_id, script_id, script_version, created_at);
-- The request-linkage facet (the one-materialization resolution).
CREATE INDEX IF NOT EXISTS studio_scripts_request_idx
    ON studio_scripts (client_id, request_id, request_version);
-- The provenance facet (which intents produced which scripts).
CREATE INDEX IF NOT EXISTS studio_scripts_intent_idx
    ON studio_scripts (client_id, intent_id, script_version);

-- Generated rows are BORN 'pending' (the explicit-review surface starts
-- the moment the generated material exists — the 068 born-draft
-- precedent).
CREATE OR REPLACE FUNCTION studio_scripts_born_pending() RETURNS trigger AS $$
BEGIN
    IF NEW.origin = 'generated' AND NEW.review_state <> 'pending' THEN
        RAISE EXCEPTION 'studio script % version % is generated and born with review state ''%'' — generated scripts are BORN PENDING and advance only through the review decisions',
            NEW.script_id, NEW.script_version, NEW.review_state;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_scripts_born_pending_trigger ON studio_scripts;
CREATE TRIGGER studio_scripts_born_pending_trigger
    BEFORE INSERT ON studio_scripts
    FOR EACH ROW EXECUTE FUNCTION studio_scripts_born_pending();

-- Script row identity/scope/linkage/provenance is immutable after
-- insert; ONLY the review state + the server-managed updated_at may
-- advance — and ONLY along the guarded review edges, each advance
-- backed by a matching decision record.
CREATE OR REPLACE FUNCTION studio_script_guard() RETURNS trigger AS $$
DECLARE
    decision_count integer;
BEGIN
    IF NEW.script_id <> OLD.script_id
       OR NEW.script_version <> OLD.script_version
       OR NEW.agency_id <> OLD.agency_id
       OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.request_id <> OLD.request_id
       OR NEW.request_version <> OLD.request_version
       OR NEW.origin <> OLD.origin
       OR NEW.body <> OLD.body
       OR NEW.intent_id IS DISTINCT FROM OLD.intent_id
       OR NEW.generator_organization <> OLD.generator_organization
       OR NEW.generator_model_references <> OLD.generator_model_references
       OR NEW.contract_version <> OLD.contract_version
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'studio script % version % identity/scope/linkage/provenance is immutable — corrections are NEW version rows',
            OLD.script_id, OLD.script_version;
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'studio script % version % updated_at may not go backwards',
            OLD.script_id, OLD.script_version;
    END IF;
    IF OLD.origin = 'supplied' AND NEW.review_state IS DISTINCT FROM OLD.review_state THEN
        RAISE EXCEPTION 'studio script % version % is supplied — supplied scripts carry no review state (the §3 path: user-authored material is its own authority)',
            OLD.script_id, OLD.script_version;
    END IF;
    IF NEW.review_state IS DISTINCT FROM OLD.review_state THEN
        IF NOT (
               (OLD.review_state = 'pending' AND NEW.review_state IN ('approved', 'rejected', 'superseded'))
            OR (OLD.review_state IN ('approved', 'rejected') AND NEW.review_state = 'superseded')
        ) THEN
            RAISE EXCEPTION 'studio script % version % review transition % → % is not legal (born pending; pending → approved | rejected | superseded; approved | rejected → superseded; no resurrection)',
                OLD.script_id, OLD.script_version, OLD.review_state, NEW.review_state;
        END IF;
        -- Every advance is backed by a matching append-only decision
        -- record (inserted BEFORE the advance — the decision-then-
        -- advance ordering).
        SELECT count(*) INTO decision_count
            FROM studio_script_reviews
            WHERE script_id = NEW.script_id AND script_version = NEW.script_version
              AND verdict = NEW.review_state;
        IF decision_count < 1 THEN
            RAISE EXCEPTION 'studio script % version % review advance to ''%'' has no matching decision record — every review-state advance is backed by an append-only review decision',
                NEW.script_id, NEW.script_version, NEW.review_state;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_script_guard_trigger ON studio_scripts;
CREATE TRIGGER studio_script_guard_trigger
    BEFORE UPDATE ON studio_scripts
    FOR EACH ROW EXECUTE FUNCTION studio_script_guard();

-- Scripts are never deleted (the version history is append-only
-- evidence).
CREATE OR REPLACE FUNCTION studio_scripts_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'studio scripts cannot be deleted — script version history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_scripts_no_delete_trigger ON studio_scripts;
CREATE TRIGGER studio_scripts_no_delete_trigger
    BEFORE DELETE ON studio_scripts
    FOR EACH ROW EXECUTE FUNCTION studio_scripts_no_delete();

-- The version-chain scope fence (the 064/068 precedent): a version
-- n > 1 requires version n-1 under the same chain id with the chain's
-- scope + request linkage kept.
CREATE OR REPLACE FUNCTION studio_script_chain_scope_check() RETURNS trigger AS $$
DECLARE
    chain_client uuid;
    chain_agency uuid;
    chain_workspace uuid;
    chain_request_id uuid;
    chain_request_version integer;
BEGIN
    IF NEW.script_version > 1 THEN
        SELECT client_id, agency_id, workspace_id, request_id, request_version
            INTO chain_client, chain_agency, chain_workspace, chain_request_id, chain_request_version
            FROM studio_scripts
            WHERE script_id = NEW.script_id AND script_version = NEW.script_version - 1;
        IF chain_client IS NULL THEN
            RAISE EXCEPTION 'studio script version chain is broken (%, %)',
                NEW.script_id, NEW.script_version - 1;
        END IF;
        IF chain_client <> NEW.client_id OR chain_agency <> NEW.agency_id
           OR chain_workspace IS DISTINCT FROM NEW.workspace_id
           OR chain_request_id <> NEW.request_id
           OR chain_request_version <> NEW.request_version THEN
            RAISE EXCEPTION 'studio script correction must keep the version chain scope + request linkage (cross-tenant/cross-request corrections are rejected)';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_script_chain_scope_trigger ON studio_scripts;
CREATE TRIGGER studio_script_chain_scope_trigger
    BEFORE INSERT ON studio_scripts
    FOR EACH ROW EXECUTE FUNCTION studio_script_chain_scope_check();

-- Scope + mode + one-materialization consistency: the script chain must
-- bind an EXISTING request version in the SAME client whose §8 input
-- mode matches the origin (mode 'script' ⟺ origin 'supplied'; mode
-- 'intent' ⟺ origin 'generated'); ONE script chain per (request,
-- request version); and the request version must not have ALREADY
-- materialized its production input as a QUESTION GRAPH (the §8
-- exactly-one input fence — either the script chain or the graph
-- chain, never both).
CREATE OR REPLACE FUNCTION studio_script_scope_check() RETURNS trigger AS $$
DECLARE
    request_client uuid;
    request_mode text;
    other_chain uuid;
    graph_chain uuid;
BEGIN
    SELECT client_id, content -> 'input' ->> 'mode'
        INTO request_client, request_mode
        FROM studio_production_requests
        WHERE request_id = NEW.request_id AND request_version = NEW.request_version;
    IF request_client IS NULL THEN
        RAISE EXCEPTION 'studio script must bind an existing request version (%, %)',
            NEW.request_id, NEW.request_version;
    END IF;
    IF request_client <> NEW.client_id THEN
        RAISE EXCEPTION 'studio script client must match its request version client (cross-tenant scripts are rejected)';
    END IF;
    IF (NEW.origin = 'supplied' AND request_mode <> 'script')
       OR (NEW.origin = 'generated' AND request_mode <> 'intent') THEN
        RAISE EXCEPTION 'studio script origin ''%'' requires the request version''s input mode to match (found ''%'') — the §8 exactly-one input fence',
            NEW.origin, request_mode;
    END IF;
    SELECT DISTINCT script_id INTO other_chain
        FROM studio_scripts
        WHERE request_id = NEW.request_id AND request_version = NEW.request_version
          AND script_id <> NEW.script_id;
    IF other_chain IS NOT NULL THEN
        RAISE EXCEPTION 'studio script request version (%, %) already carries script chain % — ONE script chain per request version (corrections append under the SAME chain id)',
            NEW.request_id, NEW.request_version, other_chain;
    END IF;
    SELECT DISTINCT graph_id INTO graph_chain
        FROM studio_question_graphs
        WHERE request_id = NEW.request_id AND request_version = NEW.request_version;
    IF graph_chain IS NOT NULL THEN
        RAISE EXCEPTION 'studio script request version (%, %) already carries question-graph chain % — the production input materializes as EITHER a script chain OR a question-graph chain, never both (the §8 exactly-one input fence)',
            NEW.request_id, NEW.request_version, graph_chain;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_script_scope_trigger ON studio_scripts;
CREATE TRIGGER studio_script_scope_trigger
    BEFORE INSERT ON studio_scripts
    FOR EACH ROW EXECUTE FUNCTION studio_script_scope_check();

-- ---------------------------------------------------------------------------
-- studio_script_reviews — the HUMAN-REVIEW DECISION records (the
-- append-only audit tail behind every review-state advance)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS studio_script_reviews (
    review_id           uuid        PRIMARY KEY,
    script_id           uuid        NOT NULL,
    script_version      integer     NOT NULL CHECK (script_version >= 1),
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id        uuid        REFERENCES workspaces(workspace_id),
    -- The decision verdict from the closed vocabulary (pending is NOT a
    -- decision — it is the born state).
    verdict             text        NOT NULL
                        CHECK (verdict IN ('approved', 'rejected', 'superseded')),
    -- THE HONEST AUTONOMOUS/HUMAN SPLIT: who reviewed (a human reviewer
    -- or the autonomous system — e.g. the generation registry
    -- superseding a prior version on regeneration).
    reviewer_kind       text        NOT NULL
                        CHECK (reviewer_kind IN ('human', 'autonomous')),
    -- The OPAQUE reviewer actor identity (bounded; never joined).
    reviewer_actor      text        NOT NULL
                        CHECK (studio_review_actor_bounded(reviewer_actor)),
    -- The optional bounded decision note.
    note                text
                        CHECK (note IS NULL OR (char_length(note) >= 1 AND char_length(note) <= 2000)),
    decided_at          timestamptz NOT NULL,
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'content-studio-script-v1'),
    created_at          timestamptz NOT NULL,
    CONSTRAINT studio_script_reviews_script_fk
        FOREIGN KEY (script_id, script_version)
        REFERENCES studio_scripts(script_id, script_version)
);

-- The script chain's decision tail (oldest first).
CREATE INDEX IF NOT EXISTS studio_script_reviews_script_idx
    ON studio_script_reviews (client_id, script_id, script_version, created_at);

-- Review decisions are immutable INSERT-ONLY records (the review
-- history is auditable evidence): NO UPDATE, NO DELETE.
CREATE OR REPLACE FUNCTION studio_script_reviews_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'studio script review decisions are immutable (INSERT only — the review history is append-only)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_script_reviews_no_update_trigger ON studio_script_reviews;
CREATE TRIGGER studio_script_reviews_no_update_trigger
    BEFORE UPDATE ON studio_script_reviews
    FOR EACH ROW EXECUTE FUNCTION studio_script_reviews_immutable();

DROP TRIGGER IF EXISTS studio_script_reviews_no_delete_trigger ON studio_script_reviews;
CREATE TRIGGER studio_script_reviews_no_delete_trigger
    BEFORE DELETE ON studio_script_reviews
    FOR EACH ROW EXECUTE FUNCTION studio_script_reviews_immutable();

-- Scope + reviewability consistency: the decision's subject must be a
-- GENERATED script version in the SAME client, and the subject's
-- CURRENT review state must permit the verdict (pending → approved |
-- rejected | superseded; approved | rejected → superseded) — the
-- decision-then-advance trigger ordering.
CREATE OR REPLACE FUNCTION studio_script_review_scope_check() RETURNS trigger AS $$
DECLARE
    script_client uuid;
    script_origin text;
    script_state text;
BEGIN
    SELECT client_id, origin, review_state
        INTO script_client, script_origin, script_state
        FROM studio_scripts
        WHERE script_id = NEW.script_id AND script_version = NEW.script_version;
    IF script_client IS NULL THEN
        RAISE EXCEPTION 'studio script review must bind an existing script version (%, %)',
            NEW.script_id, NEW.script_version;
    END IF;
    IF script_client <> NEW.client_id THEN
        RAISE EXCEPTION 'studio script review client must match its script client (cross-tenant reviews are rejected)';
    END IF;
    IF script_origin <> 'generated' THEN
        RAISE EXCEPTION 'studio script reviews target GENERATED script versions only (supplied scripts are user-authored — their own authority)';
    END IF;
    IF NOT (
           (script_state = 'pending' AND NEW.verdict IN ('approved', 'rejected', 'superseded'))
        OR (script_state IN ('approved', 'rejected') AND NEW.verdict = 'superseded')
    ) THEN
        RAISE EXCEPTION 'studio script review verdict ''%'' is not legal from the script''s current review state ''%'' (born pending; pending → approved | rejected | superseded; approved | rejected → superseded)',
            NEW.verdict, script_state;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_script_review_scope_trigger ON studio_script_reviews;
CREATE TRIGGER studio_script_review_scope_trigger
    BEFORE INSERT ON studio_script_reviews
    FOR EACH ROW EXECUTE FUNCTION studio_script_review_scope_check();

-- ---------------------------------------------------------------------------
-- studio_question_graphs — the VERSIONED QUESTION-GRAPH records (the
-- DECLARED question/branch graph; the same origin/review/versioning
-- discipline as scripts)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS studio_question_graphs (
    -- THE VERSION CHAIN KEY: one row per (graph, version).
    graph_id            uuid        NOT NULL,
    graph_version       integer     NOT NULL CHECK (graph_version >= 1 AND graph_version <= 1000),
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id        uuid        REFERENCES workspaces(workspace_id),
    -- THE §3 REQUEST LINKAGE: ONE question-graph chain per (request,
    -- request version) — the one-materialization fence (the scope
    -- trigger below).
    request_id          uuid        NOT NULL,
    request_version     integer     NOT NULL CHECK (request_version >= 1),
    -- The §8 origin (supplied | generated — same pairing as scripts).
    origin              text        NOT NULL
                        CHECK (origin IN ('supplied', 'generated')),
    -- THE DECLARED QUESTION/BRANCH GRAPH (the deterministic adjacency
    -- substrate): nodes are questions with their closed modality hints;
    -- edges are the declared branch conditions; the entry question.
    -- CHECK-fenced through the IMMUTABLE helpers above (the deep shape
    -- is the module's pure-guard surface).
    declared_graph      jsonb       NOT NULL
                        CHECK (studio_graph_declared_wellformed(declared_graph)),
    -- THE GENERATION PROVENANCE (generated rows only — the origin-shape
    -- fence below).
    intent_id           uuid        REFERENCES studio_intents(intent_id),
    generator_organization jsonb
                        CHECK (generator_organization IS NULL OR jsonb_typeof(generator_organization) = 'object'),
    generator_model_references jsonb
                        CHECK (generator_model_references IS NULL
                               OR studio_citations_all_bounded(generator_model_references, 32, 256)),
    -- THE EXPLICIT HUMAN-REVIEW OPTION (generated rows only).
    review_state        text
                        CHECK (review_state IS NULL
                               OR review_state IN ('pending', 'approved', 'rejected', 'superseded')),
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'content-studio-script-v1'),
    created_at          timestamptz NOT NULL,
    updated_at          timestamptz NOT NULL,
    CONSTRAINT studio_question_graphs_pk PRIMARY KEY (graph_id, graph_version),
    CONSTRAINT studio_question_graphs_origin_shape CHECK (
        (origin = 'supplied'
         AND intent_id IS NULL
         AND generator_organization IS NULL
         AND generator_model_references IS NULL
         AND review_state IS NULL)
        OR (origin = 'generated'
            AND intent_id IS NOT NULL
            AND generator_organization IS NOT NULL
            AND generator_model_references IS NOT NULL
            AND review_state IS NOT NULL)
    )
);

-- The client's graph tail (newest version last per chain).
CREATE INDEX IF NOT EXISTS studio_question_graphs_client_idx
    ON studio_question_graphs (client_id, graph_id, graph_version, created_at);
-- The request-linkage facet.
CREATE INDEX IF NOT EXISTS studio_question_graphs_request_idx
    ON studio_question_graphs (client_id, request_id, request_version);
-- The provenance facet.
CREATE INDEX IF NOT EXISTS studio_question_graphs_intent_idx
    ON studio_question_graphs (client_id, intent_id, graph_version);

-- Generated rows are BORN 'pending' (the 068 born-draft precedent).
CREATE OR REPLACE FUNCTION studio_question_graphs_born_pending() RETURNS trigger AS $$
BEGIN
    IF NEW.origin = 'generated' AND NEW.review_state <> 'pending' THEN
        RAISE EXCEPTION 'studio question graph % version % is generated and born with review state ''%'' — generated graphs are BORN PENDING and advance only through the review decisions',
            NEW.graph_id, NEW.graph_version, NEW.review_state;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_question_graphs_born_pending_trigger ON studio_question_graphs;
CREATE TRIGGER studio_question_graphs_born_pending_trigger
    BEFORE INSERT ON studio_question_graphs
    FOR EACH ROW EXECUTE FUNCTION studio_question_graphs_born_pending();

-- Graph row identity/scope/linkage/provenance is immutable after
-- insert; ONLY the review state + updated_at advance — the same
-- guarded review edges + decision-record backing as scripts.
CREATE OR REPLACE FUNCTION studio_question_graph_guard() RETURNS trigger AS $$
DECLARE
    decision_count integer;
BEGIN
    IF NEW.graph_id <> OLD.graph_id
       OR NEW.graph_version <> OLD.graph_version
       OR NEW.agency_id <> OLD.agency_id
       OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.request_id <> OLD.request_id
       OR NEW.request_version <> OLD.request_version
       OR NEW.origin <> OLD.origin
       OR NEW.declared_graph <> OLD.declared_graph
       OR NEW.intent_id IS DISTINCT FROM OLD.intent_id
       OR NEW.generator_organization <> OLD.generator_organization
       OR NEW.generator_model_references <> OLD.generator_model_references
       OR NEW.contract_version <> OLD.contract_version
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'studio question graph % version % identity/scope/linkage/provenance is immutable — corrections are NEW version rows',
            OLD.graph_id, OLD.graph_version;
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'studio question graph % version % updated_at may not go backwards',
            OLD.graph_id, OLD.graph_version;
    END IF;
    IF OLD.origin = 'supplied' AND NEW.review_state IS DISTINCT FROM OLD.review_state THEN
        RAISE EXCEPTION 'studio question graph % version % is supplied — supplied graphs carry no review state (the §3 path: user-authored material is its own authority)',
            OLD.graph_id, OLD.graph_version;
    END IF;
    IF NEW.review_state IS DISTINCT FROM OLD.review_state THEN
        IF NOT (
               (OLD.review_state = 'pending' AND NEW.review_state IN ('approved', 'rejected', 'superseded'))
            OR (OLD.review_state IN ('approved', 'rejected') AND NEW.review_state = 'superseded')
        ) THEN
            RAISE EXCEPTION 'studio question graph % version % review transition % → % is not legal (born pending; pending → approved | rejected | superseded; approved | rejected → superseded; no resurrection)',
                OLD.graph_id, OLD.graph_version, OLD.review_state, NEW.review_state;
        END IF;
        SELECT count(*) INTO decision_count
            FROM studio_question_graph_reviews
            WHERE graph_id = NEW.graph_id AND graph_version = NEW.graph_version
              AND verdict = NEW.review_state;
        IF decision_count < 1 THEN
            RAISE EXCEPTION 'studio question graph % version % review advance to ''%'' has no matching decision record — every review-state advance is backed by an append-only review decision',
                NEW.graph_id, NEW.graph_version, NEW.review_state;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_question_graph_guard_trigger ON studio_question_graphs;
CREATE TRIGGER studio_question_graph_guard_trigger
    BEFORE UPDATE ON studio_question_graphs
    FOR EACH ROW EXECUTE FUNCTION studio_question_graph_guard();

-- Graphs are never deleted.
CREATE OR REPLACE FUNCTION studio_question_graphs_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'studio question graphs cannot be deleted — graph version history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_question_graphs_no_delete_trigger ON studio_question_graphs;
CREATE TRIGGER studio_question_graphs_no_delete_trigger
    BEFORE DELETE ON studio_question_graphs
    FOR EACH ROW EXECUTE FUNCTION studio_question_graphs_no_delete();

-- The version-chain scope fence (the script precedent).
CREATE OR REPLACE FUNCTION studio_question_graph_chain_scope_check() RETURNS trigger AS $$
DECLARE
    chain_client uuid;
    chain_agency uuid;
    chain_workspace uuid;
    chain_request_id uuid;
    chain_request_version integer;
BEGIN
    IF NEW.graph_version > 1 THEN
        SELECT client_id, agency_id, workspace_id, request_id, request_version
            INTO chain_client, chain_agency, chain_workspace, chain_request_id, chain_request_version
            FROM studio_question_graphs
            WHERE graph_id = NEW.graph_id AND graph_version = NEW.graph_version - 1;
        IF chain_client IS NULL THEN
            RAISE EXCEPTION 'studio question graph version chain is broken (%, %)',
                NEW.graph_id, NEW.graph_version - 1;
        END IF;
        IF chain_client <> NEW.client_id OR chain_agency <> NEW.agency_id
           OR chain_workspace IS DISTINCT FROM NEW.workspace_id
           OR chain_request_id <> NEW.request_id
           OR chain_request_version <> NEW.request_version THEN
            RAISE EXCEPTION 'studio question graph correction must keep the version chain scope + request linkage (cross-tenant/cross-request corrections are rejected)';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_question_graph_chain_scope_trigger ON studio_question_graphs;
CREATE TRIGGER studio_question_graph_chain_scope_trigger
    BEFORE INSERT ON studio_question_graphs
    FOR EACH ROW EXECUTE FUNCTION studio_question_graph_chain_scope_check();

-- Scope + mode + one-materialization consistency (the script precedent:
-- mode 'question_list' ⟺ origin 'supplied'; mode 'intent' ⟺ origin
-- 'generated'; ONE graph chain per request version; never BOTH a
-- script chain and a graph chain).
CREATE OR REPLACE FUNCTION studio_question_graph_scope_check() RETURNS trigger AS $$
DECLARE
    request_client uuid;
    request_mode text;
    other_chain uuid;
    script_chain uuid;
BEGIN
    SELECT client_id, content -> 'input' ->> 'mode'
        INTO request_client, request_mode
        FROM studio_production_requests
        WHERE request_id = NEW.request_id AND request_version = NEW.request_version;
    IF request_client IS NULL THEN
        RAISE EXCEPTION 'studio question graph must bind an existing request version (%, %)',
            NEW.request_id, NEW.request_version;
    END IF;
    IF request_client <> NEW.client_id THEN
        RAISE EXCEPTION 'studio question graph client must match its request version client (cross-tenant graphs are rejected)';
    END IF;
    IF (NEW.origin = 'supplied' AND request_mode <> 'question_list')
       OR (NEW.origin = 'generated' AND request_mode <> 'intent') THEN
        RAISE EXCEPTION 'studio question graph origin ''%'' requires the request version''s input mode to match (found ''%'') — the §8 exactly-one input fence',
            NEW.origin, request_mode;
    END IF;
    SELECT DISTINCT graph_id INTO other_chain
        FROM studio_question_graphs
        WHERE request_id = NEW.request_id AND request_version = NEW.request_version
          AND graph_id <> NEW.graph_id;
    IF other_chain IS NOT NULL THEN
        RAISE EXCEPTION 'studio question graph request version (%, %) already carries graph chain % — ONE graph chain per request version (corrections append under the SAME chain id)',
            NEW.request_id, NEW.request_version, other_chain;
    END IF;
    SELECT DISTINCT script_id INTO script_chain
        FROM studio_scripts
        WHERE request_id = NEW.request_id AND request_version = NEW.request_version;
    IF script_chain IS NOT NULL THEN
        RAISE EXCEPTION 'studio question graph request version (%, %) already carries script chain % — the production input materializes as EITHER a script chain OR a question-graph chain, never both (the §8 exactly-one input fence)',
            NEW.request_id, NEW.request_version, script_chain;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_question_graph_scope_trigger ON studio_question_graphs;
CREATE TRIGGER studio_question_graph_scope_trigger
    BEFORE INSERT ON studio_question_graphs
    FOR EACH ROW EXECUTE FUNCTION studio_question_graph_scope_check();

-- ---------------------------------------------------------------------------
-- studio_question_graph_reviews — the HUMAN-REVIEW DECISION records
-- for question graphs (the same append-only decision discipline)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS studio_question_graph_reviews (
    review_id           uuid        PRIMARY KEY,
    graph_id            uuid        NOT NULL,
    graph_version       integer     NOT NULL CHECK (graph_version >= 1),
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id        uuid        REFERENCES workspaces(workspace_id),
    verdict             text        NOT NULL
                        CHECK (verdict IN ('approved', 'rejected', 'superseded')),
    reviewer_kind       text        NOT NULL
                        CHECK (reviewer_kind IN ('human', 'autonomous')),
    reviewer_actor      text        NOT NULL
                        CHECK (studio_review_actor_bounded(reviewer_actor)),
    note                text
                        CHECK (note IS NULL OR (char_length(note) >= 1 AND char_length(note) <= 2000)),
    decided_at          timestamptz NOT NULL,
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'content-studio-script-v1'),
    created_at          timestamptz NOT NULL,
    CONSTRAINT studio_question_graph_reviews_graph_fk
        FOREIGN KEY (graph_id, graph_version)
        REFERENCES studio_question_graphs(graph_id, graph_version)
);

-- The graph chain's decision tail (oldest first).
CREATE INDEX IF NOT EXISTS studio_question_graph_reviews_graph_idx
    ON studio_question_graph_reviews (client_id, graph_id, graph_version, created_at);

-- Review decisions are immutable INSERT-ONLY records: NO UPDATE, NO
-- DELETE.
CREATE OR REPLACE FUNCTION studio_question_graph_reviews_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'studio question graph review decisions are immutable (INSERT only — the review history is append-only)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_question_graph_reviews_no_update_trigger ON studio_question_graph_reviews;
CREATE TRIGGER studio_question_graph_reviews_no_update_trigger
    BEFORE UPDATE ON studio_question_graph_reviews
    FOR EACH ROW EXECUTE FUNCTION studio_question_graph_reviews_immutable();

DROP TRIGGER IF EXISTS studio_question_graph_reviews_no_delete_trigger ON studio_question_graph_reviews;
CREATE TRIGGER studio_question_graph_reviews_no_delete_trigger
    BEFORE DELETE ON studio_question_graph_reviews
    FOR EACH ROW EXECUTE FUNCTION studio_question_graph_reviews_immutable();

-- Scope + reviewability consistency (the script precedent).
CREATE OR REPLACE FUNCTION studio_question_graph_review_scope_check() RETURNS trigger AS $$
DECLARE
    graph_client uuid;
    graph_origin text;
    graph_state text;
BEGIN
    SELECT client_id, origin, review_state
        INTO graph_client, graph_origin, graph_state
        FROM studio_question_graphs
        WHERE graph_id = NEW.graph_id AND graph_version = NEW.graph_version;
    IF graph_client IS NULL THEN
        RAISE EXCEPTION 'studio question graph review must bind an existing graph version (%, %)',
            NEW.graph_id, NEW.graph_version;
    END IF;
    IF graph_client <> NEW.client_id THEN
        RAISE EXCEPTION 'studio question graph review client must match its graph client (cross-tenant reviews are rejected)';
    END IF;
    IF graph_origin <> 'generated' THEN
        RAISE EXCEPTION 'studio question graph reviews target GENERATED graph versions only (supplied graphs are user-authored — their own authority)';
    END IF;
    IF NOT (
           (graph_state = 'pending' AND NEW.verdict IN ('approved', 'rejected', 'superseded'))
        OR (graph_state IN ('approved', 'rejected') AND NEW.verdict = 'superseded')
    ) THEN
        RAISE EXCEPTION 'studio question graph review verdict ''%'' is not legal from the graph''s current review state ''%'' (born pending; pending → approved | rejected | superseded; approved | rejected → superseded)',
            NEW.verdict, graph_state;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_question_graph_review_scope_trigger ON studio_question_graph_reviews;
CREATE TRIGGER studio_question_graph_review_scope_trigger
    BEFORE INSERT ON studio_question_graph_reviews
    FOR EACH ROW EXECUTE FUNCTION studio_question_graph_review_scope_check();

-- ---------------------------------------------------------------------------
-- studio_conversation_edges — the CONVERSATION-GRAPH HOOK records (the
-- adaptive-branching surface: the chosen-edge append surface; the
-- interviewer CHOICE MECHANICS are STUDIO-004 — the disclosed boundary)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS studio_conversation_edges (
    -- The conversation chain identity (one conversation per recorded
    -- interview walk; re-takes open NEW conversations).
    conversation_id    uuid        NOT NULL,
    -- The session revision the conversation belongs to (the interview
    -- happens inside a session revision).
    session_id          uuid        NOT NULL,
    revision            integer     NOT NULL CHECK (revision >= 1),
    agency_id           uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id           uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id        uuid        REFERENCES workspaces(workspace_id),
    -- The ordered step within the conversation (1-based; the ordered
    -- walk tail).
    seq                 integer     NOT NULL CHECK (seq >= 1 AND seq <= 1024),
    -- THE DECLARED GRAPH this conversation walks (the exact version —
    -- the declared question/branch graph bound to the session's request
    -- version): every step cites the version it walked, so the
    -- conversation is reproducible against the declared graph even
    -- after later graph corrections.
    graph_id            uuid        NOT NULL,
    graph_version       integer     NOT NULL CHECK (graph_version >= 1),
    -- The question asked this step (a DECLARED node of the walked
    -- graph — validated by the trigger below).
    question_id         text        NOT NULL
                        CHECK (question_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
    -- The recorded answer to the asked question: the OPAQUE answer
    -- reference (the capture/answer artifact — never joined) + the
    -- closed answer kind.
    answer_reference    text        NOT NULL
                        CHECK (char_length(answer_reference) >= 1 AND char_length(answer_reference) <= 512),
    answer_kind         text        NOT NULL
                        CHECK (answer_kind IN ('audio', 'video', 'text')),
    -- THE CHOSEN EDGE (the declared follow-up chosen for the preceding
    -- answer — §8 "choose a follow-up from the declared question/branch
    -- graph based on the preceding answer"): the chosen target question
    -- + the declared condition of the chosen edge. NULL ends the
    -- conversation (no follow-up).
    chosen_to_question_id text
                        CHECK (chosen_to_question_id IS NULL OR chosen_to_question_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
    chosen_condition    text
                        CHECK (chosen_condition IS NULL
                               OR chosen_condition IN ('always', 'on_answer_positive', 'on_answer_negative',
                                                        'on_answer_neutral', 'on_answer_elaborate', 'on_answer_abbreviated')),
    -- THE HONEST CHOOSER SPLIT: who chose the follow-up — the adaptive
    -- interviewer (autonomous) or an explicit human choice.
    chooser_kind        text        NOT NULL
                        CHECK (chooser_kind IN ('interviewer', 'human')),
    contract_version    text        NOT NULL
                        CHECK (contract_version = 'content-studio-script-v1'),
    created_at          timestamptz NOT NULL,
    CONSTRAINT studio_conversation_edges_pk PRIMARY KEY (conversation_id, seq),
    CONSTRAINT studio_conversation_edges_session_fk
        FOREIGN KEY (session_id, revision)
        REFERENCES studio_sessions(session_id, revision),
    CONSTRAINT studio_conversation_edges_graph_fk
        FOREIGN KEY (graph_id, graph_version)
        REFERENCES studio_question_graphs(graph_id, graph_version),
    -- THE CHOSEN-EDGE SHAPE FENCE: the chosen edge is complete or the
    -- conversation ends (never a half-chosen edge).
    CONSTRAINT studio_conversation_edges_choice_shape CHECK (
        (chosen_to_question_id IS NULL AND chosen_condition IS NULL)
        OR (chosen_to_question_id IS NOT NULL AND chosen_condition IS NOT NULL)
    )
);

-- The session's conversation tail (the conversation graph per session).
CREATE INDEX IF NOT EXISTS studio_conversation_edges_session_idx
    ON studio_conversation_edges (client_id, session_id, revision, conversation_id, seq);
-- The walked-graph facet.
CREATE INDEX IF NOT EXISTS studio_conversation_edges_graph_idx
    ON studio_conversation_edges (client_id, graph_id, graph_version);

-- Conversation edges are APPEND-ONLY OUTRIGHT: no UPDATE, no DELETE
-- (the resulting conversation graph is preserved as data — §8).
CREATE OR REPLACE FUNCTION studio_conversation_edges_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'studio conversation edges are append-only (INSERT only — the resulting conversation graph is preserved as data)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_conversation_edges_no_update_trigger ON studio_conversation_edges;
CREATE TRIGGER studio_conversation_edges_no_update_trigger
    BEFORE UPDATE ON studio_conversation_edges
    FOR EACH ROW EXECUTE FUNCTION studio_conversation_edges_append_only();

DROP TRIGGER IF EXISTS studio_conversation_edges_no_delete_trigger ON studio_conversation_edges;
CREATE TRIGGER studio_conversation_edges_no_delete_trigger
    BEFORE DELETE ON studio_conversation_edges
    FOR EACH ROW EXECUTE FUNCTION studio_conversation_edges_append_only();

-- Scope + declared-graph consistency (the deterministic adjacency
-- backstop): the session revision exists in the SAME client; the walked
-- graph version exists in the SAME client AND is bound to the session's
-- OWN request version; the asked question is a DECLARED node of the
-- walked graph; seq 1 asks the DECLARED entry question; a present
-- chosen edge IS a declared edge of the walked graph (from the asked
-- question, to the chosen target, under the chosen condition) — the
-- choice surface can only land inside the declared question/branch
-- graph.
CREATE OR REPLACE FUNCTION studio_conversation_edge_scope_check() RETURNS trigger AS $$
DECLARE
    session_client uuid;
    session_request_id uuid;
    session_request_version integer;
    graph_client uuid;
    graph_request_id uuid;
    graph_request_version integer;
    declared_entry text;
BEGIN
    SELECT client_id, request_id, request_version
        INTO session_client, session_request_id, session_request_version
        FROM studio_sessions
        WHERE session_id = NEW.session_id AND revision = NEW.revision;
    IF session_client IS NULL THEN
        RAISE EXCEPTION 'studio conversation edge must bind an existing session revision (%, %)',
            NEW.session_id, NEW.revision;
    END IF;
    IF session_client <> NEW.client_id THEN
        RAISE EXCEPTION 'studio conversation edge client must match its session client (cross-tenant conversation edges are rejected)';
    END IF;
    SELECT client_id, request_id, request_version
        INTO graph_client, graph_request_id, graph_request_version
        FROM studio_question_graphs
        WHERE graph_id = NEW.graph_id AND graph_version = NEW.graph_version;
    IF graph_client IS NULL THEN
        RAISE EXCEPTION 'studio conversation edge must bind an existing declared graph version (%, %)',
            NEW.graph_id, NEW.graph_version;
    END IF;
    IF graph_client <> NEW.client_id THEN
        RAISE EXCEPTION 'studio conversation edge client must match its declared graph client (cross-tenant graphs are rejected)';
    END IF;
    IF graph_request_id <> session_request_id OR graph_request_version <> session_request_version THEN
        RAISE EXCEPTION 'studio conversation edge must walk the declared graph bound to the session''s request version (graph: % v%; session request: % v%)',
            graph_request_id, graph_request_version, session_request_id, session_request_version;
    END IF;

    -- The asked question is a declared node.
    IF NOT EXISTS (
        SELECT 1
          FROM studio_question_graphs AS graph,
               jsonb_array_elements(graph.declared_graph -> 'nodes') AS node
         WHERE graph.graph_id = NEW.graph_id AND graph.graph_version = NEW.graph_version
           AND node ->> 'questionId' = NEW.question_id
    ) THEN
        RAISE EXCEPTION 'studio conversation edge question ''%'' is not a declared node of the walked graph (%, %)',
            NEW.question_id, NEW.graph_id, NEW.graph_version;
    END IF;

    -- The entry rule: seq 1 asks the declared entry question.
    IF NEW.seq = 1 THEN
        SELECT graph.declared_graph ->> 'entryQuestionId' INTO declared_entry
            FROM studio_question_graphs AS graph
            WHERE graph.graph_id = NEW.graph_id AND graph.graph_version = NEW.graph_version;
        IF declared_entry IS DISTINCT FROM NEW.question_id THEN
            RAISE EXCEPTION 'studio conversation edge seq 1 must ask the declared entry question (expected ''%'', found ''%'')',
                declared_entry, NEW.question_id;
        END IF;
    END IF;

    -- The chosen edge is a DECLARED edge (when present).
    IF NEW.chosen_to_question_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1
              FROM studio_question_graphs AS graph,
                   jsonb_array_elements(graph.declared_graph -> 'edges') AS edge
             WHERE graph.graph_id = NEW.graph_id AND graph.graph_version = NEW.graph_version
               AND edge ->> 'fromQuestionId' = NEW.question_id
               AND edge ->> 'toQuestionId' = NEW.chosen_to_question_id
               AND edge ->> 'condition' = NEW.chosen_condition
        ) THEN
            RAISE EXCEPTION 'studio conversation edge chosen follow-up (% → % under ''%'') is not a declared edge of the walked graph (%, %)',
                NEW.question_id, NEW.chosen_to_question_id, NEW.chosen_condition, NEW.graph_id, NEW.graph_version;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS studio_conversation_edge_scope_trigger ON studio_conversation_edges;
CREATE TRIGGER studio_conversation_edge_scope_trigger
    BEFORE INSERT ON studio_conversation_edges
    FOR EACH ROW EXECUTE FUNCTION studio_conversation_edge_scope_check();

-- ---------------------------------------------------------------------------
-- The provenance/request FK completion: the script/graph intent-lineage
-- FKs reference studio_intents (created above); the request-version FKs
-- are completed here (the composite FK discipline of 064 — the
-- referenced unique keys exist on the migration-064 table).
-- ---------------------------------------------------------------------------

ALTER TABLE studio_scripts
    DROP CONSTRAINT IF EXISTS studio_scripts_request_version_fk;
ALTER TABLE studio_scripts
    ADD CONSTRAINT studio_scripts_request_version_fk
    FOREIGN KEY (request_id, request_version)
    REFERENCES studio_production_requests(request_id, request_version);

ALTER TABLE studio_question_graphs
    DROP CONSTRAINT IF EXISTS studio_question_graphs_request_version_fk;
ALTER TABLE studio_question_graphs
    ADD CONSTRAINT studio_question_graphs_request_version_fk
    FOREIGN KEY (request_id, request_version)
    REFERENCES studio_production_requests(request_id, request_version);

-- ---------------------------------------------------------------------------
-- The additive format-registry CHECK (the same-module studio_formats
-- table — the §8 "when the format requires explicit user confirmation"
-- declaration field): the OPTIONAL
-- inputRequirements.generatedInputReview field carries the closed
-- vocabulary 'required' | 'not_required'; ABSENT means not required.
-- Every existing declaration (and every already-materialized tenant
-- registry row) carries no such field — NULL passes; the fence pins
-- only the closed vocabulary of the field when present.
-- ---------------------------------------------------------------------------

ALTER TABLE studio_formats
    DROP CONSTRAINT IF EXISTS studio_formats_generated_review_check;
ALTER TABLE studio_formats
    ADD CONSTRAINT studio_formats_generated_review_check
    CHECK ((declaration -> 'inputRequirements' ->> 'generatedInputReview') IS NULL
           OR (declaration -> 'inputRequirements' ->> 'generatedInputReview') IN ('required', 'not_required'));
