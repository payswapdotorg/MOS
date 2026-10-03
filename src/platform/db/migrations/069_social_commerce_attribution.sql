-- 069_social_commerce_attribution.sql — MKT-073 (Social-to-Commerce
-- Attribution).
--
-- The SOCIAL-TO-COMMERCE ATTRIBUTION REFERENCE authority
-- (spec/effective-backlog-v1.6.md MKT-073: "link content/distribution
-- experiments to store visits, product interactions and orders.
-- Dependencies: MKT-065, MKT-071, MKT-072, MKT-052. Acceptance:
-- attribution ids survive content transformations and provider
-- boundaries; causal claims remain explicitly separate.";
-- spec/architecture-v1.6.md §16 "Attribution" — THE frozen contract:
-- "Every social-to-product action can carry a mission-scoped
-- attribution reference. Preferred mechanisms include platform-native
-- links where available, UTM parameters, unique landing routes,
-- campaign identifiers, creator/content identifiers and first-party
-- conversion events. Attributed outcomes flow back as evidence/metrics;
-- attribution is never silently treated as causal proof." — plus §15
-- "Commerce loop" (the commerce test budget context), §17 "Budget and
-- quota" and §18 "Security and tenancy"; the frozen v1.6 matrix row,
-- VERBATIM:
-- /social-commerce-attribution → /cross-platform-distribution,
-- /integrations, /metrics, /evidence, /growth-missions):
--
--   social_attribution_references              → the MISSION-SCOPED
--                                                attribution reference
--                                                records (the stable
--                                                attribution id —
--                                                'sca-<16hex>',
--                                                deterministically
--                                                derived from the
--                                                canonical creation
--                                                inputs; the identity
--                                                digest is the
--                                                idempotence fence;
--                                                the closed §16
--                                                mechanism vocabulary
--                                                with the honest
--                                                'unavailable' state
--                                                for mechanisms a
--                                                platform does not
--                                                offer; born 'active'
--                                                with the SINGLE
--                                                guarded
--                                                active → retired
--                                                advance);
--   social_attribution_link_constructions      → the APPEND-ONLY
--                                                link-construction
--                                                records (the concrete
--                                                built link per
--                                                mechanism — the
--                                                UTM-augmented URL,
--                                                the landing route,
--                                                the campaign id, the
--                                                creator/content
--                                                identifier, the
--                                                recorded provider
--                                                native link id, the
--                                                first-party event
--                                                contract — EACH a
--                                                deterministic pure
--                                                function of its
--                                                inputs under
--                                                'sca-link-v1', with
--                                                the construction
--                                                version, the input
--                                                digest and the
--                                                closed match-field
--                                                vocabulary recorded);
--   social_attribution_attachments             → the APPEND-ONLY
--                                                attachment records
--                                                (which distribution
--                                                action / content
--                                                transformation /
--                                                experiment arm
--                                                carries which
--                                                attribution reference
--                                                — SURVIVING
--                                                TRANSFORMATIONS: the
--                                                attachment cites the
--                                                ORIGINAL content
--                                                identity AND every
--                                                derived/transformed
--                                                identity that
--                                                carried the
--                                                reference, so the id
--                                                survives the
--                                                cross-platform
--                                                distribution chain);
--   social_attribution_provider_crossings      → the PROVIDER-BOUNDARY
--                                                CROSSING records (the
--                                                reference entering a
--                                                provider payload —
--                                                the EXACT field it
--                                                rode, the dispatched
--                                                value; born
--                                                'dispatched' with the
--                                                SINGLE guarded
--                                                advance to 'echoed'
--                                                (the provider echo
--                                                recorded) or
--                                                'dropped' (the honest
--                                                null — a provider
--                                                that drops the
--                                                reference is
--                                                recorded as dropping
--                                                it, NEVER fabricated);
--   social_attribution_conversion_events       → the APPEND-ONLY
--                                                conversion-event
--                                                records (store
--                                                visit / product
--                                                interaction / order
--                                                — the order kind
--                                                sourced ONLY from the
--                                                REAL MKT-071 commerce
--                                                events through the
--                                                existing commerce
--                                                boundary: the order
--                                                webhook with the
--                                                real commerce-event
--                                                citation; store
--                                                visits and product
--                                                interactions from
--                                                first-party
--                                                conversion events;
--                                                actual orders are the
--                                                ONLY order truth);
--   social_attribution_outcomes                → the APPEND-ONLY
--                                                attribution-outcome
--                                                records (THE JOIN:
--                                                conversion event ←
--                                                attribution reference
--                                                → the mission/
--                                                experiment/content
--                                                chain — carrying the
--                                                attribution MECHANISM
--                                                and the match
--                                                provenance (which id
--                                                matched, on which
--                                                event field,
--                                                observed at what time
--                                                by which source) and
--                                                the CHECK-fenced
--                                                co-occurrence note;
--                                                the record is
--                                                CO-OCCURRENCE
--                                                EVIDENCE ONLY and
--                                                structurally NEVER
--                                                asserts causation —
--                                                lift, contribution and
--                                                incrementality are
--                                                OUT OF SCOPE for this
--                                                module; the
--                                                experiment-analysis
--                                                authorities own
--                                                causal estimation)
--                                                plus the
--                                                evidence/metrics
--                                                flowback citation
--                                                (the cited projection
--                                                shape /metrics and
--                                                /evidence consume —
--                                                this module writes
--                                                NEITHER their tables
--                                                nor any other
--                                                module's).
--
-- Key fences:
--
-- * CHECK-fenced closed vocabularies on every enumerated column: the
--   §16 mechanism vocabulary (platform_native_link / utm_parameters /
--   unique_landing_route / campaign_identifier /
--   creator_content_identifier / first_party_conversion_event + the
--   honest 'unavailable' state) on the references; the SIX CONSTRUCTIBLE
--   mechanisms on the link constructions and the outcomes (an
--   'unavailable' reference constructs nothing and matches nothing —
--   the unavailable-reference fence below + the excluded vocabulary are
--   the double fence); the reference states (active / retired), the
--   crossing states (dispatched / echoed / dropped), the conversion
--   kinds (store_visit / product_interaction / order), the conversion
--   sources (order_webhook / first_party_event), the attachment carrier
--   kinds (distribution_action / content_transformation /
--   experiment_arm) and the closed match-field vocabulary
--   (utmContent / landingRoute / campaignId / creatorContentRef /
--   nativeLinkId / attributionRef — the observed-field names of the
--   commerce attribution passthrough).
-- * THE ORDER-TRUTH FENCE (the core acceptance, structural at the DB):
--   a conversion event of kind 'order' REQUIRES event_source
--   'order_webhook' AND a real commerce-event citation AND the store
--   connection it rode; a store visit or product interaction is a
--   FIRST-PARTY conversion event only. There is NO channel anywhere in
--   this module through which an order exists without the real
--   commerce boundary behind it (the migration-049 projections are the
--   ONLY order truth; never a simulated or caller-asserted sale).
-- * THE CO-OCCURRENCE FENCE (the causal-separation discipline,
--   structural): every attribution-outcome row carries the pinned
--   co-occurrence note 'co-occurrence evidence only — never causal
--   proof' (a CHECK-fenced literal — a causal-claiming outcome row is
--   INEXPRESSIBLE at the database level), and the matched field/value
--   provenance is REQUIRED on every row.
-- * THE APPEND-ONLY TAILS: link constructions, attachments, conversion
--   events and outcomes reject UPDATE and DELETE outright — corrections
--   are NEW records; history is never rewritten (the
--   migration-045/052/058/060/062 pattern). The reference rows carry
--   the SINGLE guarded active → retired advance (reason REQUIRED; no
--   reopen, no resurrection; identity/scope/citation immutable); the
--   crossing rows carry the SINGLE guarded dispatched → echoed/dropped
--   advance (the echo pair REQUIRED on 'echoed'; the honest null +
--   reason REQUIRED on 'dropped').
-- * THE UNAVAILABLE-REFERENCE FENCE (DB trigger): a link construction,
--   attachment or provider-boundary crossing whose parent reference is
--   honestly 'unavailable' is REJECTED at the database — an unavailable
--   mechanism builds nothing, carries nothing and crosses nothing (the
--   module's guard is the first fence; this trigger is the backstop).
-- * THE SCOPE FENCES: every same-module citation is scope-consistent —
--   link constructions, attachments, crossings and outcomes carry the
--   SAME agency/client/workspace as their parent reference; a crossing
--   cites a link construction of ITS OWN reference; an outcome cites a
--   conversion event, a reference and a link construction of the SAME
--   scope, with the outcome's mechanism equal to the reference's own
--   mechanism (the mechanism-consistency fence).
-- * NO AUTHORITY TRANSFER / THE FAMILY BY-REFERENCE DISCIPLINE: FK
--   anchors point ONLY at the tenant tables (agencies / clients /
--   workspaces) and same-module rows. There is deliberately NO foreign
--   key into /growth-missions, /cross-platform-distribution,
--   /commerce-discovery, /experiments, /integrations, /metrics,
--   /evidence or ANY other module — the mission, distribution-action,
--   content-transformation, experiment-arm, commerce-event and
--   store-connection citations are OPAQUE recorded data (recorded
--   linkage, never a join; the /lab family by-reference discipline).
--   No mission, experiment, evidence, metric, catalog, order, listing,
--   price or inventory table is created here; this module never becomes
--   a second authority of any kind (architecture-lock-v1.6.md rules
--   32/33 — store mutations flow through Integrations, and the
--   commerce-event projections stay the /integrations boundary's own).
-- * NO CAUSAL COMPUTATION ANYWHERE: no lift, contribution,
--   incrementality, effect, counterfactual or attribution-share column
--   or table exists anywhere in this migration; the causal vocabulary
--   is structurally absent (the experiment-analysis authorities own
--   causal estimation — the frozen row's /metrics + /evidence
--   directions are the flowback CONSUMPTION surface, and the read
--   model this module surfaces is a cited projection that writes
--   nothing).
-- * NO SECRET MATERIAL ANYWHERE (CRED-001/§21): the only structured
--   payload columns are the bounded context/input/provenance/
--   observed-fields/flowback blocks — there is deliberately NO column
--   capable of holding secret material, NO provider credential and NO
--   store connection of this module's own (the commerce boundary owns
--   those).
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, append-oriented tails. No owner/role/user columns beyond
-- provenance: client-scope authorization stays exactly the route-layer
-- authority — no second tenant, permission or identity authority.

-- ---------------------------------------------------------------------------
-- The IMMUTABLE CHECK helpers (the STUDIO-003 068 discipline — the
-- element scans live INSIDE the helpers; the CHECK expressions carry no
-- sublinks)
-- ---------------------------------------------------------------------------

/**
 * The carried-identity chain fence: the jsonb array is bounded (1..50),
 * every element is a bounded string (1..300) and the ORIGINAL content
 * identity is carried (the transformation-survival proof, structural:
 * an attachment that dropped the original identity is inexpressible).
 */
CREATE OR REPLACE FUNCTION sca_carried_refs_valid(carried jsonb, original_content_ref text)
RETURNS boolean
IMMUTABLE
LANGUAGE plpgsql AS $$
DECLARE
    element jsonb;
BEGIN
    IF carried IS NULL OR jsonb_typeof(carried) <> 'array' THEN
        RETURN false;
    END IF;
    IF jsonb_array_length(carried) < 1 OR jsonb_array_length(carried) > 50 THEN
        RETURN false;
    END IF;
    IF NOT (carried @> to_jsonb(original_content_ref)) THEN
        RETURN false;
    END IF;
    FOR element IN SELECT jsonb_array_elements(carried) LOOP
        IF jsonb_typeof(element) <> 'string' THEN
            RETURN false;
        END IF;
        IF length(element #>> '{}') < 1 OR length(element #>> '{}') > 300 THEN
            RETURN false;
        END IF;
    END LOOP;
    RETURN true;
END;
$$;

/**
 * The observed-fields fence: a bounded jsonb OBJECT of SCALAR reference
 * fields only (the commerce attribution-passthrough discipline — at
 * most 20 fields, every value a string of at most 500 characters, a
 * number, a boolean or null; objects/arrays are rejected — the matcher
 * consumes scalars only).
 */
CREATE OR REPLACE FUNCTION sca_observed_fields_valid(observed jsonb)
RETURNS boolean
IMMUTABLE
LANGUAGE plpgsql AS $$
DECLARE
    key text;
    value jsonb;
BEGIN
    IF observed IS NULL OR jsonb_typeof(observed) <> 'object' THEN
        RETURN false;
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(observed)) > 20 THEN
        RETURN false;
    END IF;
    FOR key, value IN SELECT * FROM jsonb_each(observed) LOOP
        IF length(key) < 1 OR length(key) > 100 THEN
            RETURN false;
        END IF;
        IF jsonb_typeof(value) NOT IN ('string', 'number', 'boolean', 'null') THEN
            RETURN false;
        END IF;
        IF jsonb_typeof(value) = 'string' AND length(value #>> '{}') > 500 THEN
            RETURN false;
        END IF;
    END LOOP;
    RETURN true;
END;
$$;

-- ---------------------------------------------------------------------------
-- social_attribution_references — the mission-scoped attribution
-- reference records (the stable attribution id; the closed §16 mechanism
-- vocabulary with the honest 'unavailable' state; born 'active' with the
-- single guarded active → retired advance)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS social_attribution_references (
    attribution_reference_id  uuid        PRIMARY KEY,
    -- The GROWTH MISSION this reference is scoped to (§16: "Every
    -- social-to-product action can carry a mission-scoped attribution
    -- reference"). OPAQUE recorded data — deliberately NOT a foreign
    -- key: the /growth-missions spine stays the sole mission authority
    -- and is cited by reference (the family by-reference discipline).
    mission_id                uuid        NOT NULL,
    agency_id                 uuid        NOT NULL REFERENCES agencies(agency_id),
    -- The PURSUIT CLIENT (derived server-side from the pursuit
    -- workspace through the canonical ownership chain — §18: every row
    -- client-scoped; the FK anchor is the backstop).
    client_id                 uuid        NOT NULL REFERENCES clients(client_id),
    -- The pursuit workspace narrowing (carried as data; the optional
    -- workspace anchor of the §18 tenant discipline).
    workspace_id              uuid        REFERENCES workspaces(workspace_id),
    -- THE STABLE ATTRIBUTION ID — the value that survives content
    -- transformations and provider boundaries: deterministically
    -- derived (the first 16 hex of the identity digest) at creation,
    -- immutable thereafter, and carried verbatim by every constructed
    -- link, every attachment and every provider-boundary crossing.
    attribution_ref           text        NOT NULL
                                          CHECK (attribution_ref ~ '^sca-[0-9a-f]{16}$'),
    -- The deterministic identity digest (SHA-256 over the canonical
    -- creation inputs) — the idempotence fence: the same mission +
    -- mechanism + purpose + context converges on the SAME reference,
    -- never a silent duplicate.
    identity_digest           text        NOT NULL
                                          CHECK (identity_digest ~ '^[0-9a-f]{64}$'),
    -- The closed §16 mechanism vocabulary (sca-vocab-v1) WITH the
    -- honest 'unavailable' state: a platform that offers no attribution
    -- mechanism for the action is recorded as such — never a fabricated
    -- link, never a silently skipped reference.
    mechanism                 text        NOT NULL
                                          CHECK (mechanism IN ('platform_native_link',
                                                                'utm_parameters',
                                                                'unique_landing_route',
                                                                'campaign_identifier',
                                                                'creator_content_identifier',
                                                                'first_party_conversion_event',
                                                                'unavailable')),
    -- The bounded declared purpose of this reference (why it exists).
    purpose                   text        NOT NULL
                                          CHECK (length(purpose) >= 1 AND length(purpose) <= 4000),
    -- The bounded creation context (the recorded linkage data: the
    -- content anchor / experiment arm the reference was minted for —
    -- OPAQUE ids, never a join).
    creation_context          jsonb       NOT NULL DEFAULT '{}'::jsonb
                                          CHECK (jsonb_typeof(creation_context) = 'object'),
    -- The frozen reference lifecycle (sca-vocab-v1): born 'active'; the
    -- SINGLE guarded advance to 'retired' (a retired reference accepts
    -- no new linkage at the module layer; history stays readable).
    status                    text        NOT NULL
                                          CHECK (status IN ('active', 'retired')),
    -- The REQUIRED reason of the retirement (null while active — the
    -- born-state fence below).
    retired_reason            text
                                CHECK (retired_reason IS NULL
                                       OR (length(retired_reason) >= 1 AND length(retired_reason) <= 4000)),
    contract_version          text        NOT NULL
                                          CHECK (contract_version = 'sca-contract-v1'),
    vocabulary_version        text        NOT NULL
                                          CHECK (vocabulary_version = 'sca-vocab-v1'),
    recorded_actor            text        NOT NULL
                                          CHECK (length(recorded_actor) >= 1 AND length(recorded_actor) <= 100),
    recorded_via              text        NOT NULL
                                          CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 100),
    correlation_id            text        NOT NULL
                                          CHECK (length(correlation_id) >= 1 AND length(correlation_id) <= 100),
    causation_id              text,
    created_at                timestamptz NOT NULL,
    updated_at                timestamptz NOT NULL,
    CONSTRAINT social_attribution_references_ref_uniq UNIQUE (attribution_ref),
    CONSTRAINT social_attribution_references_digest_uniq UNIQUE (identity_digest),
    -- THE BORN-STATE FENCE (NULL-safe): a reference is born 'active'
    -- with no retirement reason; only the retirement advance sets one.
    CONSTRAINT social_attribution_references_born_fence
        CHECK ( (status = 'active' AND retired_reason IS NULL)
             OR (status = 'retired' AND retired_reason IS NOT NULL) )
);

-- The client's reference tail.
CREATE INDEX IF NOT EXISTS social_attribution_references_client_idx
    ON social_attribution_references (client_id, created_at DESC, attribution_reference_id);
-- The mission facet (the mission-scoped reads).
CREATE INDEX IF NOT EXISTS social_attribution_references_mission_idx
    ON social_attribution_references (mission_id, created_at DESC, attribution_reference_id);

-- The reference guard: identity, scope, citation and provenance are
-- IMMUTABLE; the ONLY legal UPDATE is the single guarded
-- active → retired advance (reason REQUIRED — a no-op or sideways
-- UPDATE is rejected; there is no reopen and no resurrection); DELETE
-- is rejected outright (the reference tail is append-only history).
CREATE OR REPLACE FUNCTION social_attribution_reference_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.attribution_reference_id <> OLD.attribution_reference_id
       OR NEW.mission_id <> OLD.mission_id
       OR NEW.agency_id <> OLD.agency_id
       OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.attribution_ref <> OLD.attribution_ref
       OR NEW.identity_digest <> OLD.identity_digest
       OR NEW.mechanism <> OLD.mechanism
       OR NEW.purpose <> OLD.purpose
       OR NEW.creation_context IS DISTINCT FROM OLD.creation_context
       OR NEW.contract_version <> OLD.contract_version
       OR NEW.vocabulary_version <> OLD.vocabulary_version
       OR NEW.recorded_actor <> OLD.recorded_actor
       OR NEW.recorded_via <> OLD.recorded_via
       OR NEW.correlation_id <> OLD.correlation_id
       OR NEW.causation_id IS DISTINCT FROM OLD.causation_id
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'attribution reference % identity/scope/citation is immutable — reference history is append-only',
            OLD.attribution_reference_id;
    END IF;
    IF NOT (OLD.status = 'active' AND NEW.status = 'retired'
            AND NEW.retired_reason IS NOT NULL) THEN
        RAISE EXCEPTION 'the only legal attribution-reference advance is active → retired with a reason (no reopen, no sideways update; reference %)',
            OLD.attribution_reference_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS social_attribution_reference_guard_trigger ON social_attribution_references;
CREATE TRIGGER social_attribution_reference_guard_trigger
    BEFORE UPDATE ON social_attribution_references
    FOR EACH ROW EXECUTE FUNCTION social_attribution_reference_guard();

CREATE OR REPLACE FUNCTION social_attribution_reference_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'attribution references are append-only — history is never deleted (reference %)',
        OLD.attribution_reference_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS social_attribution_reference_no_delete_trigger ON social_attribution_references;
CREATE TRIGGER social_attribution_reference_no_delete_trigger
    BEFORE DELETE ON social_attribution_references
    FOR EACH ROW EXECUTE FUNCTION social_attribution_reference_no_delete();

-- ---------------------------------------------------------------------------
-- social_attribution_link_constructions — the APPEND-ONLY
-- link-construction records (the concrete built link per mechanism — a
-- deterministic pure function of its inputs under 'sca-link-v1')
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS social_attribution_link_constructions (
    link_construction_id      uuid        PRIMARY KEY,
    attribution_reference_id  uuid        NOT NULL
                                          REFERENCES social_attribution_references(attribution_reference_id),
    agency_id                 uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id                 uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id              uuid        REFERENCES workspaces(workspace_id),
    -- The frozen construction version (the deterministic formula set:
    -- the UTM assembly, the landing-route derivation, the campaign-id
    -- composition, the creator/content identifier, the recorded
    -- provider native link and the first-party event contract).
    construction_version      text        NOT NULL
                                          CHECK (construction_version = 'sca-link-v1'),
    -- The mechanism this construction realizes — the SIX CONSTRUCTIBLE
    -- mechanisms only ('unavailable' is EXCLUDED: an honestly
    -- unavailable mechanism builds nothing — the vocabulary fence and
    -- the unavailable-reference trigger below are the double fence).
    mechanism                 text        NOT NULL
                                          CHECK (mechanism IN ('platform_native_link',
                                                                'utm_parameters',
                                                                'unique_landing_route',
                                                                'campaign_identifier',
                                                                'creator_content_identifier',
                                                                'first_party_conversion_event')),
    -- The bounded construction inputs (the base URL, the recorded
    -- provider link id, the creator/content refs, the event name —
    -- declared data the pure formula consumes).
    construction_input        jsonb       NOT NULL
                                          CHECK (jsonb_typeof(construction_input) = 'object'),
    -- The deterministic input digest (SHA-256 over the canonical
    -- construction inputs — the construction idempotence fence).
    input_digest              text        NOT NULL
                                          CHECK (input_digest ~ '^[0-9a-f]{64}$'),
    -- THE CONCRETE BUILT LINK (the UTM-augmented URL, the landing
    -- route, the campaign id, the creator/content identifier, the
    -- provider native link id, the first-party event contract).
    constructed_link          text        NOT NULL
                                          CHECK (length(constructed_link) >= 1 AND length(constructed_link) <= 2000),
    -- The closed match-field vocabulary (the observed-field name the
    -- reference rides on the conversion event — the commerce
    -- attribution-passthrough field convention).
    match_field               text        NOT NULL
                                          CHECK (match_field IN ('utmContent',
                                                                 'landingRoute',
                                                                 'campaignId',
                                                                 'creatorContentRef',
                                                                 'nativeLinkId',
                                                                 'attributionRef')),
    -- The exact value the observed field must carry for this
    -- construction to match (the co-occurrence matcher compares this).
    match_value               text        NOT NULL
                                          CHECK (length(match_value) >= 1 AND length(match_value) <= 500),
    recorded_actor            text        NOT NULL
                                          CHECK (length(recorded_actor) >= 1 AND length(recorded_actor) <= 100),
    recorded_via              text        NOT NULL
                                          CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 100),
    correlation_id            text        NOT NULL
                                          CHECK (length(correlation_id) >= 1 AND length(correlation_id) <= 100),
    causation_id              text,
    created_at                timestamptz NOT NULL,
    CONSTRAINT social_attribution_link_constructions_input_uniq
        UNIQUE (attribution_reference_id, input_digest)
);

-- The reference's construction tail.
CREATE INDEX IF NOT EXISTS social_attribution_link_constructions_reference_idx
    ON social_attribution_link_constructions (attribution_reference_id, created_at, link_construction_id);

-- The append-only fence: link constructions reject UPDATE and DELETE
-- outright (a changed input is a NEW construction record).
CREATE OR REPLACE FUNCTION social_attribution_link_constructions_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'attribution link constructions are append-only — corrections are NEW construction records (construction % of reference %)',
        OLD.link_construction_id, OLD.attribution_reference_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS social_attribution_link_constructions_append_only_update_trigger ON social_attribution_link_constructions;
CREATE TRIGGER social_attribution_link_constructions_append_only_update_trigger
    BEFORE UPDATE ON social_attribution_link_constructions
    FOR EACH ROW EXECUTE FUNCTION social_attribution_link_constructions_append_only();
DROP TRIGGER IF EXISTS social_attribution_link_constructions_append_only_delete_trigger ON social_attribution_link_constructions;
CREATE TRIGGER social_attribution_link_constructions_append_only_delete_trigger
    BEFORE DELETE ON social_attribution_link_constructions
    FOR EACH ROW EXECUTE FUNCTION social_attribution_link_constructions_append_only();

-- ---------------------------------------------------------------------------
-- social_attribution_attachments — the APPEND-ONLY attachment records
-- (the transformation-survival surface: which distribution action /
-- content transformation / experiment arm carries which reference, with
-- the ORIGINAL content identity AND every derived/transformed identity
-- that carried it)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS social_attribution_attachments (
    attachment_id             uuid        PRIMARY KEY,
    attribution_reference_id  uuid        NOT NULL
                                          REFERENCES social_attribution_references(attribution_reference_id),
    agency_id                 uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id                 uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id              uuid        REFERENCES workspaces(workspace_id),
    -- The closed carrier-kind vocabulary (sca-vocab-v1): the
    -- distribution action (the MKT-065 plan/destination/publication),
    -- the content transformation (the MKT-064 derived-asset chain) or
    -- the experiment arm (the MKT-052-lineage experiment spine).
    carrier_kind              text        NOT NULL
                                          CHECK (carrier_kind IN ('distribution_action',
                                                                  'content_transformation',
                                                                  'experiment_arm')),
    -- The OPAQUE carrier citation (the recorded linkage data — e.g. the
    -- distribution destination id, the 'ca:' content-asset ref, the
    -- experiment id; never a join, NO foreign key into any other
    -- module).
    carrier_ref               text        NOT NULL
                                          CHECK (length(carrier_ref) >= 1 AND length(carrier_ref) <= 300),
    -- THE ORIGINAL CONTENT IDENTITY the reference attached to at mint
    -- time (the head of the survival chain — opaque recorded data).
    original_content_ref      text        NOT NULL
                                          CHECK (length(original_content_ref) >= 1 AND length(original_content_ref) <= 300),
    -- EVERY DERIVED/TRANSFORMED CONTENT IDENTITY that carried the
    -- reference (the survival chain, append-extended with each
    -- transformation: the ORIGINAL is always carried — the helper
    -- fence makes an attachment that dropped it inexpressible).
    carried_content_refs      jsonb       NOT NULL
                                          CHECK (sca_carried_refs_valid(carried_content_refs, original_content_ref)),
    -- The REQUIRED reason this attachment is recorded (the honest
    -- record of the linkage).
    reason                    text        NOT NULL
                                          CHECK (length(reason) >= 1 AND length(reason) <= 4000),
    recorded_actor            text        NOT NULL
                                          CHECK (length(recorded_actor) >= 1 AND length(recorded_actor) <= 100),
    recorded_via              text        NOT NULL
                                          CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 100),
    correlation_id            text        NOT NULL
                                          CHECK (length(correlation_id) >= 1 AND length(correlation_id) <= 100),
    causation_id              text,
    created_at                timestamptz NOT NULL,
    CONSTRAINT social_attribution_attachments_carrier_uniq
        UNIQUE (attribution_reference_id, carrier_kind, carrier_ref)
);

-- The reference's attachment tail.
CREATE INDEX IF NOT EXISTS social_attribution_attachments_reference_idx
    ON social_attribution_attachments (attribution_reference_id, created_at, attachment_id);
-- The carrier facet (which references rode this carrier).
CREATE INDEX IF NOT EXISTS social_attribution_attachments_carrier_idx
    ON social_attribution_attachments (client_id, carrier_kind, carrier_ref);

-- The append-only fence: attachments reject UPDATE and DELETE outright
-- (an extended survival chain is a NEW attachment record).
CREATE OR REPLACE FUNCTION social_attribution_attachments_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'attribution attachments are append-only — the survival chain extends with NEW attachment records (attachment % of reference %)',
        OLD.attachment_id, OLD.attribution_reference_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS social_attribution_attachments_append_only_update_trigger ON social_attribution_attachments;
CREATE TRIGGER social_attribution_attachments_append_only_update_trigger
    BEFORE UPDATE ON social_attribution_attachments
    FOR EACH ROW EXECUTE FUNCTION social_attribution_attachments_append_only();
DROP TRIGGER IF EXISTS social_attribution_attachments_append_only_delete_trigger ON social_attribution_attachments;
CREATE TRIGGER social_attribution_attachments_append_only_delete_trigger
    BEFORE DELETE ON social_attribution_attachments
    FOR EACH ROW EXECUTE FUNCTION social_attribution_attachments_append_only();

-- ---------------------------------------------------------------------------
-- THE UNAVAILABLE-REFERENCE FENCE (the honest 'unavailable' state,
-- structural): a reference whose mechanism is honestly 'unavailable'
-- constructs nothing, carries nothing and crosses nothing. The fence
-- fires on the link-construction, attachment and crossing inserts (the
-- module's guard is the first fence; this trigger is the backstop).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION social_attribution_reference_not_unavailable() RETURNS trigger AS $$
DECLARE
    parent_mechanism text;
BEGIN
    SELECT mechanism INTO parent_mechanism
      FROM social_attribution_references
     WHERE attribution_reference_id = NEW.attribution_reference_id;
    IF parent_mechanism = 'unavailable' THEN
        RAISE EXCEPTION 'the cited attribution reference % is honestly UNAVAILABLE on its platform — no link may be constructed, carried or dispatched on it (never fabricated)',
            NEW.attribution_reference_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS social_attribution_link_construction_unavailable_fence ON social_attribution_link_constructions;
CREATE TRIGGER social_attribution_link_construction_unavailable_fence
    BEFORE INSERT ON social_attribution_link_constructions
    FOR EACH ROW EXECUTE FUNCTION social_attribution_reference_not_unavailable();

DROP TRIGGER IF EXISTS social_attribution_attachment_unavailable_fence ON social_attribution_attachments;
CREATE TRIGGER social_attribution_attachment_unavailable_fence
    BEFORE INSERT ON social_attribution_attachments
    FOR EACH ROW EXECUTE FUNCTION social_attribution_reference_not_unavailable();

-- (The crossing unavailable-fence trigger is created AFTER the
-- social_attribution_provider_crossings table below — a trigger cannot
-- precede its table.)

-- ---------------------------------------------------------------------------
-- social_attribution_provider_crossings — the PROVIDER-BOUNDARY CROSSING
-- records (the reference entering a provider payload: the exact field it
-- rode; born 'dispatched' with the single guarded advance to 'echoed'
-- (the provider echo recorded) or 'dropped' (the honest null))
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS social_attribution_provider_crossings (
    crossing_id               uuid        PRIMARY KEY,
    attribution_reference_id  uuid        NOT NULL
                                          REFERENCES social_attribution_references(attribution_reference_id),
    -- The constructed link that rode the payload (a construction of the
    -- SAME reference — the scope-consistency trigger below fences it).
    link_construction_id      uuid        NOT NULL
                                          REFERENCES social_attribution_link_constructions(link_construction_id),
    agency_id                 uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id                 uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id              uuid        REFERENCES workspaces(workspace_id),
    -- The provider/platform the payload entered (bounded key — recorded
    -- data; NO provider credential and NO provider call lives here).
    provider_key              text        NOT NULL
                                          CHECK (length(provider_key) >= 1 AND length(provider_key) <= 100),
    -- THE EXACT FIELD the reference rode in the provider payload (the
    -- honest record of the crossing point).
    payload_field             text        NOT NULL
                                          CHECK (length(payload_field) >= 1 AND length(payload_field) <= 200),
    -- The value that entered the provider payload on that field.
    dispatched_value          text        NOT NULL
                                          CHECK (length(dispatched_value) >= 1 AND length(dispatched_value) <= 1000),
    -- The frozen crossing lifecycle (sca-vocab-v1): born 'dispatched';
    -- the SINGLE guarded advance to 'echoed' (the provider returned the
    -- reference — the echo pair recorded) or 'dropped' (the provider
    -- dropped it — the honest null, never a fabricated echo).
    crossing_state            text        NOT NULL
                                          CHECK (crossing_state IN ('dispatched', 'echoed', 'dropped')),
    -- THE PROVIDER ECHO (the value the provider returned; NULL until
    -- echoed and forever NULL on a dropped crossing).
    echo_value                text
                                CHECK (echo_value IS NULL
                                       OR (length(echo_value) >= 1 AND length(echo_value) <= 1000)),
    echo_observed_at          timestamptz,
    -- The REQUIRED reason of the single guarded advance.
    advance_reason            text
                                CHECK (advance_reason IS NULL
                                       OR (length(advance_reason) >= 1 AND length(advance_reason) <= 4000)),
    recorded_actor            text        NOT NULL
                                          CHECK (length(recorded_actor) >= 1 AND length(recorded_actor) <= 100),
    recorded_via              text        NOT NULL
                                          CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 100),
    correlation_id            text        NOT NULL
                                          CHECK (length(correlation_id) >= 1 AND length(correlation_id) <= 100),
    causation_id              text,
    created_at                timestamptz NOT NULL,
    updated_at                timestamptz NOT NULL,
    -- THE STATE FENCE (NULL-safe forms): a crossing is BORN 'dispatched'
    -- with no echo and no advance reason; 'echoed' REQUIRES the echo
    -- pair; 'dropped' REQUIRES the honest null echo + the reason.
    CONSTRAINT social_attribution_crossings_state_fence
        CHECK ( (crossing_state = 'dispatched' AND echo_value IS NULL AND echo_observed_at IS NULL AND advance_reason IS NULL)
             OR (crossing_state = 'echoed' AND echo_value IS NOT NULL AND echo_observed_at IS NOT NULL AND advance_reason IS NOT NULL)
             OR (crossing_state = 'dropped' AND echo_value IS NULL AND echo_observed_at IS NULL AND advance_reason IS NOT NULL) )
);

-- The reference's crossing tail.
CREATE INDEX IF NOT EXISTS social_attribution_crossings_reference_idx
    ON social_attribution_provider_crossings (attribution_reference_id, created_at, crossing_id);
-- The provider facet (the per-provider crossing history).
CREATE INDEX IF NOT EXISTS social_attribution_crossings_provider_idx
    ON social_attribution_provider_crossings (client_id, provider_key, created_at DESC, crossing_id);

-- The crossing guard: identity, scope, citation and the dispatched
-- payload record are IMMUTABLE; the ONLY legal UPDATE is the single
-- guarded dispatched → echoed / dispatched → dropped advance (the echo
-- pair or the honest null + reason; no reopen, no sideways update);
-- DELETE is rejected outright.
CREATE OR REPLACE FUNCTION social_attribution_crossing_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.crossing_id <> OLD.crossing_id
       OR NEW.attribution_reference_id <> OLD.attribution_reference_id
       OR NEW.link_construction_id <> OLD.link_construction_id
       OR NEW.agency_id <> OLD.agency_id
       OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.provider_key <> OLD.provider_key
       OR NEW.payload_field <> OLD.payload_field
       OR NEW.dispatched_value <> OLD.dispatched_value
       OR NEW.recorded_actor <> OLD.recorded_actor
       OR NEW.recorded_via <> OLD.recorded_via
       OR NEW.correlation_id <> OLD.correlation_id
       OR NEW.causation_id IS DISTINCT FROM OLD.causation_id
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'provider-boundary crossing % identity/scope/dispatched payload is immutable — crossing history is append-only',
            OLD.crossing_id;
    END IF;
    IF NOT ( (OLD.crossing_state = 'dispatched' AND NEW.crossing_state = 'echoed'
              AND NEW.echo_value IS NOT NULL AND NEW.echo_observed_at IS NOT NULL
              AND NEW.advance_reason IS NOT NULL)
          OR (OLD.crossing_state = 'dispatched' AND NEW.crossing_state = 'dropped'
              AND NEW.echo_value IS NULL AND NEW.echo_observed_at IS NULL
              AND NEW.advance_reason IS NOT NULL) ) THEN
        RAISE EXCEPTION 'the only legal crossing advances are dispatched → echoed (echo recorded) or dispatched → dropped (the honest null + reason); no reopen, no sideways update (crossing %)',
            OLD.crossing_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS social_attribution_crossing_unavailable_fence ON social_attribution_provider_crossings;
CREATE TRIGGER social_attribution_crossing_unavailable_fence
    BEFORE INSERT ON social_attribution_provider_crossings
    FOR EACH ROW EXECUTE FUNCTION social_attribution_reference_not_unavailable();

DROP TRIGGER IF EXISTS social_attribution_crossing_guard_trigger ON social_attribution_provider_crossings;
CREATE TRIGGER social_attribution_crossing_guard_trigger
    BEFORE UPDATE ON social_attribution_provider_crossings
    FOR EACH ROW EXECUTE FUNCTION social_attribution_crossing_guard();

CREATE OR REPLACE FUNCTION social_attribution_crossings_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'provider-boundary crossings are append-only — history is never deleted (crossing %)',
        OLD.crossing_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS social_attribution_crossings_no_delete_trigger ON social_attribution_provider_crossings;
CREATE TRIGGER social_attribution_crossings_no_delete_trigger
    BEFORE DELETE ON social_attribution_provider_crossings
    FOR EACH ROW EXECUTE FUNCTION social_attribution_crossings_no_delete();

-- ---------------------------------------------------------------------------
-- social_attribution_conversion_events — the APPEND-ONLY
-- conversion-event records (store visit / product interaction / order;
-- the order-truth fence: an order REQUIRES the real MKT-071 order
-- webhook source + the real commerce-event citation)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS social_attribution_conversion_events (
    conversion_event_id       uuid        PRIMARY KEY,
    agency_id                 uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id                 uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id              uuid        REFERENCES workspaces(workspace_id),
    -- The closed conversion-kind vocabulary (sca-vocab-v1).
    conversion_kind           text        NOT NULL
                                          CHECK (conversion_kind IN ('store_visit',
                                                                     'product_interaction',
                                                                     'order')),
    -- The closed conversion-source vocabulary: 'order_webhook' (the
    -- REAL MKT-071 commerce order events, read through the existing
    -- commerce boundary — the ONLY order truth) or
    -- 'first_party_event' (the §16 first-party conversion events: the
    -- landing-route hit, the product interaction recorded first-party).
    event_source              text        NOT NULL
                                          CHECK (event_source IN ('order_webhook',
                                                                  'first_party_event')),
    -- The REAL commerce-event citation (the migration-049 normalized
    -- projection the order conversion derives from — OPAQUE recorded
    -- data, deliberately NOT a foreign key: the /integrations boundary
    -- owns the commerce projections; REQUIRED on orders, forbidden on
    -- first-party kinds by the order-truth fence below).
    commerce_event_id         uuid,
    -- The store connection the cited commerce event rode (OPAQUE
    -- recorded data — this module holds NO store connection of its
    -- own; the commerce boundary owns them).
    store_connection_id       uuid,
    -- The provider's own event id (recorded data — the commerce
    -- event's identity echo).
    provider_event_id         text
                                CHECK (provider_event_id IS NULL
                                       OR (length(provider_event_id) >= 1 AND length(provider_event_id) <= 200)),
    -- The bounded conversion subject (the order number, the product
    -- id, the visited route — recorded data).
    subject_ref               text
                                CHECK (subject_ref IS NULL
                                       OR (length(subject_ref) >= 1 AND length(subject_ref) <= 300)),
    -- When the conversion occurred per the source (null when the
    -- source carries no occurrence time).
    occurred_at               timestamptz,
    -- When the conversion was OBSERVED (server-stamped at recording —
    -- the match provenance's observation time anchor).
    observed_at               timestamptz NOT NULL,
    -- THE OBSERVED REFERENCE FIELDS the co-occurrence matcher runs
    -- over (the commerce attribution passthrough verbatim on orders;
    -- the first-party observed fields on visits/interactions — bounded
    -- scalar fields only, the helper fence).
    observed_fields           jsonb       NOT NULL DEFAULT '{}'::jsonb
                                          CHECK (sca_observed_fields_valid(observed_fields)),
    recorded_actor            text        NOT NULL
                                          CHECK (length(recorded_actor) >= 1 AND length(recorded_actor) <= 100),
    recorded_via              text        NOT NULL
                                          CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 100),
    correlation_id            text        NOT NULL
                                          CHECK (length(correlation_id) >= 1 AND length(correlation_id) <= 100),
    causation_id              text,
    created_at                timestamptz NOT NULL,
    -- THE ORDER-TRUTH FENCE (the core acceptance, structural): an
    -- 'order' conversion REQUIRES the real order-webhook source AND
    -- the real commerce-event citation AND the store connection it
    -- rode; a store visit or product interaction is a FIRST-PARTY
    -- conversion event only. There is NO channel through which an
    -- order exists without the real commerce boundary behind it.
    CONSTRAINT social_attribution_conversion_events_order_truth_fence
        CHECK ( (conversion_kind = 'order'
                 AND event_source = 'order_webhook'
                 AND commerce_event_id IS NOT NULL
                 AND store_connection_id IS NOT NULL)
             OR (conversion_kind IN ('store_visit', 'product_interaction')
                 AND event_source = 'first_party_event'
                 AND commerce_event_id IS NULL
                 AND store_connection_id IS NULL) )
);

-- The client's conversion tail.
CREATE INDEX IF NOT EXISTS social_attribution_conversion_events_client_idx
    ON social_attribution_conversion_events (client_id, created_at DESC, conversion_event_id);
-- The commerce-event citation facet (the per-commerce-event read).
CREATE INDEX IF NOT EXISTS social_attribution_conversion_events_commerce_idx
    ON social_attribution_conversion_events (client_id, commerce_event_id);

-- The append-only fence: conversion events reject UPDATE and DELETE
-- outright (the conversion ledger is raw observation history).
CREATE OR REPLACE FUNCTION social_attribution_conversion_events_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'attribution conversion events are append-only — observation history is never rewritten (conversion event %)',
        OLD.conversion_event_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS social_attribution_conversion_events_append_only_update_trigger ON social_attribution_conversion_events;
CREATE TRIGGER social_attribution_conversion_events_append_only_update_trigger
    BEFORE UPDATE ON social_attribution_conversion_events
    FOR EACH ROW EXECUTE FUNCTION social_attribution_conversion_events_append_only();
DROP TRIGGER IF EXISTS social_attribution_conversion_events_append_only_delete_trigger ON social_attribution_conversion_events;
CREATE TRIGGER social_attribution_conversion_events_append_only_delete_trigger
    BEFORE DELETE ON social_attribution_conversion_events
    FOR EACH ROW EXECUTE FUNCTION social_attribution_conversion_events_append_only();

-- ---------------------------------------------------------------------------
-- social_attribution_outcomes — the APPEND-ONLY attribution-outcome
-- records (THE JOIN: conversion event ← attribution reference → the
-- mission/experiment/content chain; co-occurrence evidence with the
-- match provenance — NEVER a causal claim)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS social_attribution_outcomes (
    attribution_outcome_id    uuid        PRIMARY KEY,
    conversion_event_id       uuid        NOT NULL
                                          REFERENCES social_attribution_conversion_events(conversion_event_id),
    attribution_reference_id  uuid        NOT NULL
                                          REFERENCES social_attribution_references(attribution_reference_id),
    -- The constructed link whose value matched (a construction of the
    -- SAME reference — the scope-consistency trigger below fences it).
    link_construction_id      uuid        NOT NULL
                                          REFERENCES social_attribution_link_constructions(link_construction_id),
    agency_id                 uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id                 uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id              uuid        REFERENCES workspaces(workspace_id),
    -- The attribution MECHANISM of the matched reference (the six
    -- constructible mechanisms — 'unavailable' is EXCLUDED: an
    -- unavailable reference constructs nothing and matches nothing).
    mechanism                 text        NOT NULL
                                          CHECK (mechanism IN ('platform_native_link',
                                                                'utm_parameters',
                                                                'unique_landing_route',
                                                                'campaign_identifier',
                                                                'creator_content_identifier',
                                                                'first_party_conversion_event')),
    -- WHICH EVENT FIELD matched (the closed match-field vocabulary).
    matched_field             text        NOT NULL
                                          CHECK (matched_field IN ('utmContent',
                                                                   'landingRoute',
                                                                   'campaignId',
                                                                   'creatorContentRef',
                                                                   'nativeLinkId',
                                                                   'attributionRef')),
    -- The exact observed value that matched.
    matched_value             text        NOT NULL
                                          CHECK (length(matched_value) >= 1 AND length(matched_value) <= 500),
    -- THE MATCH PROVENANCE (the full co-occurrence evidence: which id
    -- matched, on which event field, observed at what time, by which
    -- source — bounded structured data, never prose).
    match_provenance          jsonb       NOT NULL
                                          CHECK (jsonb_typeof(match_provenance) = 'object'),
    -- THE CO-OCCURRENCE NOTE (the causal-separation discipline,
    -- structural): the pinned literal EVERY outcome row carries — a
    -- causal-claiming outcome row is INEXPRESSIBLE at the database
    -- level. Lift, contribution and incrementality are OUT OF SCOPE
    -- for this module; the experiment-analysis authorities own causal
    -- estimation.
    co_occurrence_note        text        NOT NULL
                                          CHECK (co_occurrence_note = 'co-occurrence evidence only — never causal proof'),
    -- THE EVIDENCE/METRICS FLOWBACK CITATION (the cited projection
    -- shape the /metrics and /evidence consumers read — this module
    -- writes NEITHER their tables nor any other module's; their
    -- authorities stay canonical).
    flowback_citation         jsonb       NOT NULL
                                          CHECK (jsonb_typeof(flowback_citation) = 'object'),
    recorded_actor            text        NOT NULL
                                          CHECK (length(recorded_actor) >= 1 AND length(recorded_actor) <= 100),
    recorded_via              text        NOT NULL
                                          CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 100),
    correlation_id            text        NOT NULL
                                          CHECK (length(correlation_id) >= 1 AND length(correlation_id) <= 100),
    causation_id              text,
    created_at                timestamptz NOT NULL,
    -- ONE outcome per (conversion event, reference) pair — the join is
    -- single-shot and append-only.
    CONSTRAINT social_attribution_outcomes_pair_uniq
        UNIQUE (conversion_event_id, attribution_reference_id)
);

-- The reference's outcome tail.
CREATE INDEX IF NOT EXISTS social_attribution_outcomes_reference_idx
    ON social_attribution_outcomes (attribution_reference_id, created_at, attribution_outcome_id);
-- The conversion-event facet.
CREATE INDEX IF NOT EXISTS social_attribution_outcomes_conversion_idx
    ON social_attribution_outcomes (conversion_event_id, created_at, attribution_outcome_id);
-- The client's outcome tail (the flowback read model's primary facet).
CREATE INDEX IF NOT EXISTS social_attribution_outcomes_client_idx
    ON social_attribution_outcomes (client_id, created_at DESC, attribution_outcome_id);

-- The append-only fence: outcomes reject UPDATE and DELETE outright
-- (the co-occurrence evidence history is never rewritten).
CREATE OR REPLACE FUNCTION social_attribution_outcomes_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'attribution outcomes are append-only — the co-occurrence evidence history is never rewritten (outcome %)',
        OLD.attribution_outcome_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS social_attribution_outcomes_append_only_update_trigger ON social_attribution_outcomes;
CREATE TRIGGER social_attribution_outcomes_append_only_update_trigger
    BEFORE UPDATE ON social_attribution_outcomes
    FOR EACH ROW EXECUTE FUNCTION social_attribution_outcomes_append_only();
DROP TRIGGER IF EXISTS social_attribution_outcomes_append_only_delete_trigger ON social_attribution_outcomes;
CREATE TRIGGER social_attribution_outcomes_append_only_delete_trigger
    BEFORE DELETE ON social_attribution_outcomes
    FOR EACH ROW EXECUTE FUNCTION social_attribution_outcomes_append_only();

-- ---------------------------------------------------------------------------
-- THE SCOPE-CONSISTENCY TRIGGERS (every same-module citation): the link
-- constructions, attachments, crossings and outcomes carry the SAME
-- agency/client/workspace as their parent reference; a crossing cites a
-- link construction of ITS OWN reference; an outcome cites a conversion
-- event, a reference and a link construction of the SAME scope with the
-- reference's OWN mechanism. The anchored tables are read CHECK-ONLY.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION social_attribution_link_construction_scope_consistent() RETURNS trigger AS $$
DECLARE
    parent RECORD;
BEGIN
    SELECT agency_id, client_id, workspace_id, mechanism
      INTO parent
      FROM social_attribution_references
     WHERE attribution_reference_id = NEW.attribution_reference_id;
    IF parent IS NULL THEN
        RAISE EXCEPTION 'the cited attribution reference % does not exist', NEW.attribution_reference_id;
    END IF;
    IF NEW.agency_id <> parent.agency_id
       OR NEW.client_id <> parent.client_id
       OR NEW.workspace_id IS DISTINCT FROM parent.workspace_id THEN
        RAISE EXCEPTION 'link construction % must carry the SAME scope as its attribution reference % (scope-consistency fence)',
            NEW.link_construction_id, NEW.attribution_reference_id;
    END IF;
    IF NEW.mechanism <> parent.mechanism THEN
        RAISE EXCEPTION 'link construction % must realize the reference''s OWN mechanism % (mechanism-consistency fence)',
            NEW.link_construction_id, parent.mechanism;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS social_attribution_link_construction_scope_trigger ON social_attribution_link_constructions;
CREATE TRIGGER social_attribution_link_construction_scope_trigger
    BEFORE INSERT ON social_attribution_link_constructions
    FOR EACH ROW EXECUTE FUNCTION social_attribution_link_construction_scope_consistent();

CREATE OR REPLACE FUNCTION social_attribution_attachment_scope_consistent() RETURNS trigger AS $$
DECLARE
    parent RECORD;
BEGIN
    SELECT agency_id, client_id, workspace_id
      INTO parent
      FROM social_attribution_references
     WHERE attribution_reference_id = NEW.attribution_reference_id;
    IF parent IS NULL THEN
        RAISE EXCEPTION 'the cited attribution reference % does not exist', NEW.attribution_reference_id;
    END IF;
    IF NEW.agency_id <> parent.agency_id
       OR NEW.client_id <> parent.client_id
       OR NEW.workspace_id IS DISTINCT FROM parent.workspace_id THEN
        RAISE EXCEPTION 'attachment % must carry the SAME scope as its attribution reference % (scope-consistency fence)',
            NEW.attachment_id, NEW.attribution_reference_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS social_attribution_attachment_scope_trigger ON social_attribution_attachments;
CREATE TRIGGER social_attribution_attachment_scope_trigger
    BEFORE INSERT ON social_attribution_attachments
    FOR EACH ROW EXECUTE FUNCTION social_attribution_attachment_scope_consistent();

CREATE OR REPLACE FUNCTION social_attribution_crossing_scope_consistent() RETURNS trigger AS $$
DECLARE
    parent RECORD;
    cited_link RECORD;
BEGIN
    SELECT agency_id, client_id, workspace_id
      INTO parent
      FROM social_attribution_references
     WHERE attribution_reference_id = NEW.attribution_reference_id;
    IF parent IS NULL THEN
        RAISE EXCEPTION 'the cited attribution reference % does not exist', NEW.attribution_reference_id;
    END IF;
    IF NEW.agency_id <> parent.agency_id
       OR NEW.client_id <> parent.client_id
       OR NEW.workspace_id IS DISTINCT FROM parent.workspace_id THEN
        RAISE EXCEPTION 'crossing % must carry the SAME scope as its attribution reference % (scope-consistency fence)',
            NEW.crossing_id, NEW.attribution_reference_id;
    END IF;
    SELECT agency_id, client_id, attribution_reference_id
      INTO cited_link
      FROM social_attribution_link_constructions
     WHERE link_construction_id = NEW.link_construction_id;
    IF cited_link IS NULL THEN
        RAISE EXCEPTION 'the cited link construction % does not exist', NEW.link_construction_id;
    END IF;
    IF cited_link.attribution_reference_id <> NEW.attribution_reference_id THEN
        RAISE EXCEPTION 'crossing % must cite a link construction of ITS OWN attribution reference % (citation fence)',
            NEW.crossing_id, NEW.attribution_reference_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS social_attribution_crossing_scope_trigger ON social_attribution_provider_crossings;
CREATE TRIGGER social_attribution_crossing_scope_trigger
    BEFORE INSERT ON social_attribution_provider_crossings
    FOR EACH ROW EXECUTE FUNCTION social_attribution_crossing_scope_consistent();

CREATE OR REPLACE FUNCTION social_attribution_outcome_scope_consistent() RETURNS trigger AS $$
DECLARE
    parent RECORD;
    cited_event RECORD;
    cited_link RECORD;
BEGIN
    SELECT agency_id, client_id, workspace_id, mechanism
      INTO parent
      FROM social_attribution_references
     WHERE attribution_reference_id = NEW.attribution_reference_id;
    IF parent IS NULL THEN
        RAISE EXCEPTION 'the cited attribution reference % does not exist', NEW.attribution_reference_id;
    END IF;
    IF NEW.agency_id <> parent.agency_id
       OR NEW.client_id <> parent.client_id
       OR NEW.workspace_id IS DISTINCT FROM parent.workspace_id THEN
        RAISE EXCEPTION 'outcome % must carry the SAME scope as its attribution reference % (scope-consistency fence)',
            NEW.attribution_outcome_id, NEW.attribution_reference_id;
    END IF;
    IF NEW.mechanism <> parent.mechanism THEN
        RAISE EXCEPTION 'outcome % must carry the reference''s OWN mechanism % (mechanism-consistency fence)',
            NEW.attribution_outcome_id, parent.mechanism;
    END IF;
    SELECT agency_id, client_id
      INTO cited_event
      FROM social_attribution_conversion_events
     WHERE conversion_event_id = NEW.conversion_event_id;
    IF cited_event IS NULL THEN
        RAISE EXCEPTION 'the cited conversion event % does not exist', NEW.conversion_event_id;
    END IF;
    IF cited_event.agency_id <> NEW.agency_id
       OR cited_event.client_id <> NEW.client_id THEN
        RAISE EXCEPTION 'outcome % must cite a conversion event of the SAME scope (citation fence)',
            NEW.attribution_outcome_id;
    END IF;
    SELECT agency_id, client_id, attribution_reference_id
      INTO cited_link
      FROM social_attribution_link_constructions
     WHERE link_construction_id = NEW.link_construction_id;
    IF cited_link IS NULL THEN
        RAISE EXCEPTION 'the cited link construction % does not exist', NEW.link_construction_id;
    END IF;
    IF cited_link.attribution_reference_id <> NEW.attribution_reference_id THEN
        RAISE EXCEPTION 'outcome % must cite a link construction of the SAME attribution reference % (citation fence)',
            NEW.attribution_outcome_id, NEW.attribution_reference_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS social_attribution_outcome_scope_trigger ON social_attribution_outcomes;
CREATE TRIGGER social_attribution_outcome_scope_trigger
    BEFORE INSERT ON social_attribution_outcomes
    FOR EACH ROW EXECUTE FUNCTION social_attribution_outcome_scope_consistent();
