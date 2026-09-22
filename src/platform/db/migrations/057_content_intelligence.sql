-- 057_content_intelligence.sql — MKT-062 (Content Intelligence).
--
-- The CONTENT INTELLIGENCE authority (spec/architecture-v1.6.md §6 — the
-- primary contract: "The Content Intelligence layer normalizes platform
-- observations into evidence and candidate records. Important features can
-- include topic/entity, niche/sub-niche, content format, length, hook
-- features, narrative structure, publishing time, observed performance,
-- performance velocity, engagement, audience-fit signals, freshness,
-- novelty and reuse/duplication risk. Observed competitor/platform
-- performance generates hypotheses. It does not by itself establish
-- causality for the user's account."; spec/effective-backlog-v1.6.md
-- MKT-062; the frozen v1.6 matrix row /content-intelligence ──→
-- /evidence, /metrics, /experiments, /integrations, /research):
--
--   content_candidates                        → the CLIENT-SCOPED append-only
--                                                CANDIDATE records — the §6
--                                                observed-feature set as
--                                                DATA (topic/entity, niche/
--                                                sub-niche, content format,
--                                                length, hook features,
--                                                narrative structure,
--                                                publishing time, observed
--                                                performance, performance
--                                                velocity, engagement,
--                                                audience-fit signal,
--                                                freshness, novelty,
--                                                reuse/duplication risk);
--   content_candidate_evidence                → the FK-anchored /evidence
--                                                observation links (the
--                                                same-Client scope fence —
--                                                /evidence stays the SOLE
--                                                evidence authority);
--   content_candidate_metric_observations     → the FK-anchored /metrics
--                                                observation references (the
--                                                observed-performance anchor;
--                                                the same-Client scope fence);
--   content_hypotheses                        → the append-only HYPOTHESIS
--                                                records with honest framing
--                                                (§6's explicit non-claim
--                                                ships on every view in the
--                                                module contract —
--                                                hypotheses are inputs to
--                                                /experiments, never
--                                                conclusions; the optional
--                                                FK-anchored experiment
--                                                reference validated
--                                                READ-ONLY);
--   content_hypothesis_evidence               → the FK-anchored evidence
--                                                links (the same-Client
--                                                scope fence);
--   content_hypothesis_candidates             → the FK-anchored candidate
--                                                references (the same-Client
--                                                scope fence);
--   content_hypothesis_research_refs          → the /research insight
--                                                citations (FK-anchored to
--                                                the migration-056
--                                                research_insights table;
--                                                the same-AGENCY scope
--                                                fence);
--   content_observation_ingestion_runs        → the honest observation-
--                                                ingestion run records
--                                                (status/counts + the
--                                                appended evidence ids +
--                                                provenance).
--
-- Key fences:
--
-- * CHECK-fenced vocabularies on every enumerated column (the twelve
--   content formats, the five length units, the fourteen narrative
--   structures, the four audience-fit signals, the five freshness states,
--   the four novelty states, the four reuse-risk levels, the eight
--   hypothesis kinds, the two observation kinds, the three ingestion
--   statuses). The hook features are a bounded jsonb array (≤8 items)
--   validated against the closed module-side vocabulary.
-- * THE APPEND-ONLY TAILS: candidates, evidence links, metric links,
--   hypotheses, hypothesis links and ingestion runs ALL reject UPDATE and
--   DELETE outright — observed features are never rewritten in place (a
--   new observation is a NEW candidate; a hypothesis correction is a NEW
--   superseding record).
-- * THE SINGLE-SUPERSESSION FENCE (the migration 015 /evidence pattern):
--   at most one superseding hypothesis per prior; supersession requires
--   the same client AND the same hypothesis kind.
-- * THE SCOPE FENCES: every cross-module FK link is scoped — evidence
--   links to the same Client (evidence read CHECK-ONLY), metric
--   observation links to the same Client (metric_observations read
--   CHECK-ONLY), hypothesis candidate links to the same Client, research
--   insight citations to the same AGENCY (the client's agency resolved
--   through the evidence chain at the module level; the trigger backstop
--   reads clients/evidence/research_insights CHECK-ONLY), experiment
--   references to the same Client (experiments read CHECK-ONLY).
-- * NO AUTHORITY TRANSFER: this migration creates NO evidence, metric,
--   experiment, research-session, mission, workflow, execution, playbook,
--   learning, job, deployment, integration, credential or tenant table —
--   the platform observations become CANONICAL /evidence records through
--   the /evidence public contract (appendEvidence), never a shadow
--   observation ledger; NO experiment is created or transitioned here
--   (at most REFERENCED); NO causality claim is representable anywhere
--   (the §6 non-claim ships on the module contract).
-- * NO SECRET MATERIAL ANYWHERE (CRED-001/§21): the only structured
--   payload columns are the bounded observed-performance/engagement/
--   velocity objects and the hypothesis statement — there is deliberately
--   NO column capable of holding secret material (the module applies the
--   shared /evidence §21 material-key guard at the boundary).
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, append-oriented tails. No owner/role/user columns beyond
-- provenance: client-scope authorization stays exactly the
-- requireClientAccess route-layer authority — no second tenant, permission
-- or identity authority.

-- ---------------------------------------------------------------------------
-- content_candidates — the client-scoped append-only candidate records
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS content_candidates (
    content_candidate_id  uuid        PRIMARY KEY,
    -- CLIENT-SCOPED (the /evidence precedent). The client row is resolved
    -- at the ROUTE layer (requireClientAccess — /clients is not an
    -- allowance of this module's dependency row); the FK anchor keeps a
    -- dangling client reference from persisting.
    client_id             uuid        NOT NULL REFERENCES clients(client_id),
    -- Optional Workspace scope INSIDE the owning Client.
    workspace_id          uuid        REFERENCES workspaces(workspace_id),
    -- The §6 observed features (DATA, never conclusions).
    topic_entity          text        NOT NULL
                          CHECK (length(topic_entity) >= 1 AND length(topic_entity) <= 300),
    niche                 text        NOT NULL
                          CHECK (length(niche) >= 1 AND length(niche) <= 200),
    sub_niche             text        CHECK (sub_niche IS NULL
                                   OR (length(sub_niche) >= 1 AND length(sub_niche) <= 200)),
    content_format        text        NOT NULL
                          CHECK (content_format IN ('short_video', 'long_video', 'live_stream',
                                                     'image_post', 'carousel', 'text_post',
                                                     'thread', 'story', 'article', 'podcast',
                                                     'webinar', 'infographic')),
    -- The observed length pair: both or neither (the module guard mirrors
    -- this CHECK).
    length_value          bigint      CHECK (length_value IS NULL
                                   OR (length_value >= 0 AND length_value <= 10000000)),
    length_unit           text        CHECK (length_unit IS NULL
                                   OR length_unit IN ('seconds', 'minutes', 'hours',
                                                       'words', 'items')),
    CONSTRAINT content_candidates_length_shape CHECK (
        (length_value IS NULL AND length_unit IS NULL)
        OR (length_value IS NOT NULL AND length_unit IS NOT NULL)
    ),
    -- The observed hook features (a bounded jsonb array of the closed
    -- module-side vocabulary — 0..8 items, no duplicates).
    hook_features         jsonb       NOT NULL DEFAULT '[]'::jsonb
                          CHECK (jsonb_typeof(hook_features) = 'array'
                                 AND jsonb_array_length(hook_features) <= 8),
    narrative_structure   text        NOT NULL
                          CHECK (narrative_structure IN ('problem_solution', 'tutorial',
                                                          'listicle', 'story_arc', 'before_after',
                                                          'myth_busting', 'comparison',
                                                          'behind_the_scenes', 'interview',
                                                          'commentary', 'reaction', 'case_study',
                                                          'news_report', 'entertainment_bit')),
    -- The observed publishing time (null = unobserved).
    published_at          timestamptz,
    -- The observed performance/velocity/engagement points (bounded JSON
    -- objects of observed DATA; §21-guarded at the module boundary).
    observed_performance  jsonb       NOT NULL
                          CHECK (jsonb_typeof(observed_performance) = 'object'),
    performance_velocity  jsonb       CHECK (performance_velocity IS NULL
                                   OR jsonb_typeof(performance_velocity) = 'object'),
    engagement            jsonb       CHECK (engagement IS NULL
                                   OR jsonb_typeof(engagement) = 'object'),
    audience_fit          text        NOT NULL
                          CHECK (audience_fit IN ('strong_fit', 'moderate_fit', 'weak_fit',
                                                   'unclear')),
    freshness_state       text        NOT NULL
                          CHECK (freshness_state IN ('breaking', 'recent', 'established',
                                                      'evergreen', 'dated')),
    novelty_state         text        NOT NULL
                          CHECK (novelty_state IN ('novel', 'variation', 'common', 'saturated')),
    reuse_risk            text        NOT NULL
                          CHECK (reuse_risk IN ('low', 'medium', 'high', 'unclear')),
    -- SERVER-DERIVED provenance (never a request field).
    recorded_actor        text        NOT NULL
                          CHECK (length(recorded_actor) >= 1 AND length(recorded_actor) <= 100),
    recorded_via          text        NOT NULL
                          CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 100),
    correlation_id        text        NOT NULL,
    causation_id          text,
    created_at            timestamptz NOT NULL
);

-- The client's candidate tail (oldest first).
CREATE INDEX IF NOT EXISTS content_candidates_client_idx
    ON content_candidates (client_id, created_at, content_candidate_id);
-- The deterministic clustering surface.
CREATE INDEX IF NOT EXISTS content_candidates_niche_idx
    ON content_candidates (client_id, niche, sub_niche);

-- Candidates are append-only: observed features are never rewritten in
-- place (a new observation is a NEW candidate).
CREATE OR REPLACE FUNCTION content_candidates_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'content candidates are append-only: % is rejected on candidate % — a new observation is a NEW candidate',
        TG_OP, OLD.content_candidate_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_candidates_append_only_update_trigger ON content_candidates;
CREATE TRIGGER content_candidates_append_only_update_trigger
    BEFORE UPDATE ON content_candidates
    FOR EACH ROW EXECUTE FUNCTION content_candidates_append_only();

DROP TRIGGER IF EXISTS content_candidates_append_only_delete_trigger ON content_candidates;
CREATE TRIGGER content_candidates_append_only_delete_trigger
    BEFORE DELETE ON content_candidates
    FOR EACH ROW EXECUTE FUNCTION content_candidates_append_only();

-- ---------------------------------------------------------------------------
-- content_candidate_evidence — the FK-anchored /evidence observation links
-- ---------------------------------------------------------------------------

-- The evidence references backing one candidate: FK-anchored /evidence
-- records of the SAME client (the module resolves and validates each
-- reference BEFORE any row persists; the trigger + FK are the backstops).
CREATE TABLE IF NOT EXISTS content_candidate_evidence (
    content_candidate_id  uuid    NOT NULL REFERENCES content_candidates(content_candidate_id),
    evidence_id           uuid    NOT NULL REFERENCES evidence(evidence_id),
    -- Citation order preserved.
    position              integer NOT NULL CHECK (position >= 1),
    CONSTRAINT content_candidate_evidence_pk
        PRIMARY KEY (content_candidate_id, evidence_id)
);

-- Evidence links are append-only.
CREATE OR REPLACE FUNCTION content_candidate_evidence_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'content candidate evidence links are append-only: % is rejected',
        TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_candidate_evidence_append_only_update_trigger ON content_candidate_evidence;
CREATE TRIGGER content_candidate_evidence_append_only_update_trigger
    BEFORE UPDATE ON content_candidate_evidence
    FOR EACH ROW EXECUTE FUNCTION content_candidate_evidence_append_only();

DROP TRIGGER IF EXISTS content_candidate_evidence_append_only_delete_trigger ON content_candidate_evidence;
CREATE TRIGGER content_candidate_evidence_append_only_delete_trigger
    BEFORE DELETE ON content_candidate_evidence
    FOR EACH ROW EXECUTE FUNCTION content_candidate_evidence_append_only();

-- THE EVIDENCE SCOPE FENCE: an evidence link must reference an /evidence
-- record of the SAME client as the candidate (the evidence table is read
-- CHECK-ONLY — never written here; /evidence stays the sole authority).
CREATE OR REPLACE FUNCTION content_candidate_evidence_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_candidate_client uuid;
    v_evidence_client uuid;
BEGIN
    SELECT client_id INTO v_candidate_client
      FROM content_candidates WHERE content_candidate_id = NEW.content_candidate_id;
    SELECT client_id INTO v_evidence_client
      FROM evidence WHERE evidence_id = NEW.evidence_id;
    IF v_candidate_client IS NULL OR v_evidence_client IS NULL
       OR v_candidate_client <> v_evidence_client THEN
        RAISE EXCEPTION 'content candidate evidence link %→% crosses a client boundary — evidence references stay inside one client',
            NEW.content_candidate_id, NEW.evidence_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_candidate_evidence_scope_trigger ON content_candidate_evidence;
CREATE TRIGGER content_candidate_evidence_scope_trigger
    BEFORE INSERT ON content_candidate_evidence
    FOR EACH ROW EXECUTE FUNCTION content_candidate_evidence_scope_consistent();

-- ---------------------------------------------------------------------------
-- content_candidate_metric_observations — the FK-anchored /metrics anchors
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS content_candidate_metric_observations (
    content_candidate_id    uuid    NOT NULL REFERENCES content_candidates(content_candidate_id),
    metric_observation_id   uuid    NOT NULL REFERENCES metric_observations(observation_id),
    position                integer NOT NULL CHECK (position >= 1),
    CONSTRAINT content_candidate_metric_observations_pk
        PRIMARY KEY (content_candidate_id, metric_observation_id)
);

-- Metric links are append-only.
CREATE OR REPLACE FUNCTION content_candidate_metric_links_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'content candidate metric observation links are append-only: % is rejected',
        TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_candidate_metric_links_append_only_update_trigger ON content_candidate_metric_observations;
CREATE TRIGGER content_candidate_metric_links_append_only_update_trigger
    BEFORE UPDATE ON content_candidate_metric_observations
    FOR EACH ROW EXECUTE FUNCTION content_candidate_metric_links_append_only();

DROP TRIGGER IF EXISTS content_candidate_metric_links_append_only_delete_trigger ON content_candidate_metric_observations;
CREATE TRIGGER content_candidate_metric_links_append_only_delete_trigger
    BEFORE DELETE ON content_candidate_metric_observations
    FOR EACH ROW EXECUTE FUNCTION content_candidate_metric_links_append_only();

-- THE METRIC SCOPE FENCE: a metric observation link must reference an
-- observation of the SAME client (the metric_observations table is read
-- CHECK-ONLY — never written here).
CREATE OR REPLACE FUNCTION content_candidate_metric_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_candidate_client uuid;
    v_metric_client uuid;
BEGIN
    SELECT client_id INTO v_candidate_client
      FROM content_candidates WHERE content_candidate_id = NEW.content_candidate_id;
    SELECT client_id INTO v_metric_client
      FROM metric_observations WHERE observation_id = NEW.metric_observation_id;
    IF v_candidate_client IS NULL OR v_metric_client IS NULL
       OR v_candidate_client <> v_metric_client THEN
        RAISE EXCEPTION 'content candidate metric link %→% crosses a client boundary — metric observation references stay inside one client',
            NEW.content_candidate_id, NEW.metric_observation_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_candidate_metric_scope_trigger ON content_candidate_metric_observations;
CREATE TRIGGER content_candidate_metric_scope_trigger
    BEFORE INSERT ON content_candidate_metric_observations
    FOR EACH ROW EXECUTE FUNCTION content_candidate_metric_scope_consistent();

-- ---------------------------------------------------------------------------
-- content_hypotheses — the append-only hypothesis records
-- ---------------------------------------------------------------------------

-- The §6 hypothesis records with honest framing: observed competitor/
-- platform performance generates hypotheses — it does NOT by itself
-- establish causality for the user's account (the framing ships on every
-- view in the module contract; hypotheses are inputs to /experiments,
-- never conclusions).
CREATE TABLE IF NOT EXISTS content_hypotheses (
    content_hypothesis_id           uuid     PRIMARY KEY,
    client_id                       uuid     NOT NULL REFERENCES clients(client_id),
    workspace_id                    uuid     REFERENCES workspaces(workspace_id),
    hypothesis_kind                 text     NOT NULL
                                    CHECK (hypothesis_kind IN ('format_hypothesis',
                                                                'topic_hypothesis',
                                                                'hook_hypothesis',
                                                                'narrative_hypothesis',
                                                                'timing_hypothesis',
                                                                'length_hypothesis',
                                                                'audience_hypothesis',
                                                                'distribution_hypothesis')),
    -- The hypothesis statement (a bounded non-empty JSON object with a
    -- required summary — the CLAIM; §21-guarded at the module boundary).
    statement                       jsonb    NOT NULL
                                    CHECK (jsonb_typeof(statement) = 'object'
                                           AND statement ? 'summary'
                                           AND length(statement ->> 'summary') >= 1
                                           AND length(statement ->> 'summary') <= 2000),
    -- The single-supersession correction chain (the migration 015
    -- /evidence pattern): a correction is a NEW record citing the prior
    -- one; the prior is never rewritten.
    supersedes_content_hypothesis_id uuid    REFERENCES content_hypotheses(content_hypothesis_id),
    -- The optional /experiments reference this hypothesis feeds (validated
    -- READ-ONLY through the /experiments public contract; NO experiment is
    -- created or transitioned here).
    experiment_id                   uuid     REFERENCES experiments(experiment_id),
    -- SERVER-DERIVED provenance (never a request field).
    recorded_actor                  text     NOT NULL
                                    CHECK (length(recorded_actor) >= 1 AND length(recorded_actor) <= 100),
    recorded_via                    text     NOT NULL
                                    CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 100),
    correlation_id                  text     NOT NULL,
    causation_id                    text,
    created_at                      timestamptz NOT NULL
);

-- The client's hypothesis tail (oldest first).
CREATE INDEX IF NOT EXISTS content_hypotheses_client_idx
    ON content_hypotheses (client_id, created_at, content_hypothesis_id);

-- THE SINGLE-SUPERSESSION FENCE (the migration 015 pattern): at most ONE
-- superseding record per prior record.
CREATE UNIQUE INDEX IF NOT EXISTS content_hypothesis_supersession_fence
    ON content_hypotheses (supersedes_content_hypothesis_id)
    WHERE supersedes_content_hypothesis_id IS NOT NULL;

-- Hypotheses are append-only: corrections are NEW records.
CREATE OR REPLACE FUNCTION content_hypotheses_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'content hypotheses are append-only: % is rejected on hypothesis %',
        TG_OP, OLD.content_hypothesis_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_hypotheses_append_only_update_trigger ON content_hypotheses;
CREATE TRIGGER content_hypotheses_append_only_update_trigger
    BEFORE UPDATE ON content_hypotheses
    FOR EACH ROW EXECUTE FUNCTION content_hypotheses_append_only();

DROP TRIGGER IF EXISTS content_hypotheses_append_only_delete_trigger ON content_hypotheses;
CREATE TRIGGER content_hypotheses_append_only_delete_trigger
    BEFORE DELETE ON content_hypotheses
    FOR EACH ROW EXECUTE FUNCTION content_hypotheses_append_only();

-- THE SUPERSESSION CONSISTENCY FENCE (the migration 025/048 deferred
-- pattern): a superseding hypothesis must reference a record of the SAME
-- client and the SAME hypothesis kind (a correction never changes its
-- subject), verified at COMMIT — every mutation path, including direct
-- SQL. The superseded prior must not itself already be superseded (the
-- fence above is the race backstop).
CREATE OR REPLACE FUNCTION content_hypothesis_supersession_consistent() RETURNS trigger AS $$
DECLARE
    v_prior record;
BEGIN
    IF NEW.supersedes_content_hypothesis_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT client_id, hypothesis_kind
      INTO v_prior
      FROM content_hypotheses
     WHERE content_hypothesis_id = NEW.supersedes_content_hypothesis_id;
    IF v_prior IS NULL THEN
        RAISE EXCEPTION 'content hypothesis % supersedes unknown record % — a dangling correction cannot persist',
            NEW.content_hypothesis_id, NEW.supersedes_content_hypothesis_id;
    END IF;
    IF v_prior.client_id <> NEW.client_id THEN
        RAISE EXCEPTION 'content hypothesis % cannot supersede a record of another client — the client boundary cannot be crossed',
            NEW.content_hypothesis_id;
    END IF;
    IF v_prior.hypothesis_kind <> NEW.hypothesis_kind THEN
        RAISE EXCEPTION 'content hypothesis % must supersede a record of the same hypothesis kind (a correction never changes its subject)',
            NEW.content_hypothesis_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_hypothesis_supersession_trigger ON content_hypotheses;
CREATE CONSTRAINT TRIGGER content_hypothesis_supersession_trigger
    AFTER INSERT ON content_hypotheses
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION content_hypothesis_supersession_consistent();

-- THE EXPERIMENT SCOPE FENCE: the optional experiment reference must be an
-- experiment of the SAME client (the experiments table is read CHECK-ONLY
-- — never written here; /experiments stays the sole experiment
-- identity/design authority).
CREATE OR REPLACE FUNCTION content_hypothesis_experiment_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_experiment_client uuid;
BEGIN
    IF NEW.experiment_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT client_id INTO v_experiment_client
      FROM experiments WHERE experiment_id = NEW.experiment_id;
    IF v_experiment_client IS NULL OR v_experiment_client <> NEW.client_id THEN
        RAISE EXCEPTION 'content hypothesis % references an experiment outside its client — experiment references stay inside one client',
            NEW.content_hypothesis_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_hypothesis_experiment_scope_trigger ON content_hypotheses;
CREATE TRIGGER content_hypothesis_experiment_scope_trigger
    BEFORE INSERT ON content_hypotheses
    FOR EACH ROW EXECUTE FUNCTION content_hypothesis_experiment_scope_consistent();

-- ---------------------------------------------------------------------------
-- content_hypothesis_evidence — the FK-anchored evidence links
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS content_hypothesis_evidence (
    content_hypothesis_id  uuid    NOT NULL REFERENCES content_hypotheses(content_hypothesis_id),
    evidence_id            uuid    NOT NULL REFERENCES evidence(evidence_id),
    position               integer NOT NULL CHECK (position >= 1),
    CONSTRAINT content_hypothesis_evidence_pk
        PRIMARY KEY (content_hypothesis_id, evidence_id)
);

-- Evidence links are append-only.
CREATE OR REPLACE FUNCTION content_hypothesis_evidence_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'content hypothesis evidence links are append-only: % is rejected',
        TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_hypothesis_evidence_append_only_update_trigger ON content_hypothesis_evidence;
CREATE TRIGGER content_hypothesis_evidence_append_only_update_trigger
    BEFORE UPDATE ON content_hypothesis_evidence
    FOR EACH ROW EXECUTE FUNCTION content_hypothesis_evidence_append_only();

DROP TRIGGER IF EXISTS content_hypothesis_evidence_append_only_delete_trigger ON content_hypothesis_evidence;
CREATE TRIGGER content_hypothesis_evidence_append_only_delete_trigger
    BEFORE DELETE ON content_hypothesis_evidence
    FOR EACH ROW EXECUTE FUNCTION content_hypothesis_evidence_append_only();

-- THE EVIDENCE SCOPE FENCE (the same-Client rule).
CREATE OR REPLACE FUNCTION content_hypothesis_evidence_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_hypothesis_client uuid;
    v_evidence_client uuid;
BEGIN
    SELECT client_id INTO v_hypothesis_client
      FROM content_hypotheses WHERE content_hypothesis_id = NEW.content_hypothesis_id;
    SELECT client_id INTO v_evidence_client
      FROM evidence WHERE evidence_id = NEW.evidence_id;
    IF v_hypothesis_client IS NULL OR v_evidence_client IS NULL
       OR v_hypothesis_client <> v_evidence_client THEN
        RAISE EXCEPTION 'content hypothesis evidence link %→% crosses a client boundary — evidence references stay inside one client',
            NEW.content_hypothesis_id, NEW.evidence_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_hypothesis_evidence_scope_trigger ON content_hypothesis_evidence;
CREATE TRIGGER content_hypothesis_evidence_scope_trigger
    BEFORE INSERT ON content_hypothesis_evidence
    FOR EACH ROW EXECUTE FUNCTION content_hypothesis_evidence_scope_consistent();

-- ---------------------------------------------------------------------------
-- content_hypothesis_candidates — the FK-anchored candidate references
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS content_hypothesis_candidates (
    content_hypothesis_id  uuid    NOT NULL REFERENCES content_hypotheses(content_hypothesis_id),
    content_candidate_id   uuid    NOT NULL REFERENCES content_candidates(content_candidate_id),
    position               integer NOT NULL CHECK (position >= 1),
    CONSTRAINT content_hypothesis_candidates_pk
        PRIMARY KEY (content_hypothesis_id, content_candidate_id)
);

-- Candidate links are append-only.
CREATE OR REPLACE FUNCTION content_hypothesis_candidates_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'content hypothesis candidate links are append-only: % is rejected',
        TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_hypothesis_candidates_append_only_update_trigger ON content_hypothesis_candidates;
CREATE TRIGGER content_hypothesis_candidates_append_only_update_trigger
    BEFORE UPDATE ON content_hypothesis_candidates
    FOR EACH ROW EXECUTE FUNCTION content_hypothesis_candidates_append_only();

DROP TRIGGER IF EXISTS content_hypothesis_candidates_append_only_delete_trigger ON content_hypothesis_candidates;
CREATE TRIGGER content_hypothesis_candidates_append_only_delete_trigger
    BEFORE DELETE ON content_hypothesis_candidates
    FOR EACH ROW EXECUTE FUNCTION content_hypothesis_candidates_append_only();

-- THE CANDIDATE SCOPE FENCE: a hypothesis candidate link must reference a
-- candidate of the SAME client.
CREATE OR REPLACE FUNCTION content_hypothesis_candidates_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_hypothesis_client uuid;
    v_candidate_client uuid;
BEGIN
    SELECT client_id INTO v_hypothesis_client
      FROM content_hypotheses WHERE content_hypothesis_id = NEW.content_hypothesis_id;
    SELECT client_id INTO v_candidate_client
      FROM content_candidates WHERE content_candidate_id = NEW.content_candidate_id;
    IF v_hypothesis_client IS NULL OR v_candidate_client IS NULL
       OR v_hypothesis_client <> v_candidate_client THEN
        RAISE EXCEPTION 'content hypothesis candidate link %→% crosses a client boundary — candidate references stay inside one client',
            NEW.content_hypothesis_id, NEW.content_candidate_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_hypothesis_candidates_scope_trigger ON content_hypothesis_candidates;
CREATE TRIGGER content_hypothesis_candidates_scope_trigger
    BEFORE INSERT ON content_hypothesis_candidates
    FOR EACH ROW EXECUTE FUNCTION content_hypothesis_candidates_scope_consistent();

-- ---------------------------------------------------------------------------
-- content_hypothesis_research_refs — the /research insight citations
-- ---------------------------------------------------------------------------

-- The /research insight citations of a hypothesis: FK-anchored to the
-- migration-056 research_insights table, scoped to the SAME AGENCY (the
-- research sessions are agency-scoped; the client's agency is resolved
-- through the evidence chain at the module level — the trigger backstop
-- reads clients/evidence CHECK-ONLY). The AI-discipline disclosures ride
-- the cited research records themselves (this module's frozen row lists
-- NO /ai-runtime dependency).
CREATE TABLE IF NOT EXISTS content_hypothesis_research_refs (
    content_hypothesis_id  uuid    NOT NULL REFERENCES content_hypotheses(content_hypothesis_id),
    research_insight_id    uuid    NOT NULL REFERENCES research_insights(research_insight_id),
    position               integer NOT NULL CHECK (position >= 1),
    CONSTRAINT content_hypothesis_research_refs_pk
        PRIMARY KEY (content_hypothesis_id, research_insight_id)
);

-- Research citations are append-only.
CREATE OR REPLACE FUNCTION content_hypothesis_research_refs_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'content hypothesis research citations are append-only: % is rejected',
        TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_hypothesis_research_refs_append_only_update_trigger ON content_hypothesis_research_refs;
CREATE TRIGGER content_hypothesis_research_refs_append_only_update_trigger
    BEFORE UPDATE ON content_hypothesis_research_refs
    FOR EACH ROW EXECUTE FUNCTION content_hypothesis_research_refs_append_only();

DROP TRIGGER IF EXISTS content_hypothesis_research_refs_append_only_delete_trigger ON content_hypothesis_research_refs;
CREATE TRIGGER content_hypothesis_research_refs_append_only_delete_trigger
    BEFORE DELETE ON content_hypothesis_research_refs
    FOR EACH ROW EXECUTE FUNCTION content_hypothesis_research_refs_append_only();

-- THE RESEARCH SCOPE FENCE (the same-AGENCY rule): the cited research
-- insight's session agency must equal the hypothesis client's agency
-- (resolved through the canonical client row — read CHECK-ONLY).
CREATE OR REPLACE FUNCTION content_hypothesis_research_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_hypothesis_client uuid;
    v_client_agency uuid;
    v_research_agency uuid;
BEGIN
    SELECT client_id INTO v_hypothesis_client
      FROM content_hypotheses WHERE content_hypothesis_id = NEW.content_hypothesis_id;
    SELECT agency_id INTO v_client_agency
      FROM clients WHERE client_id = v_hypothesis_client;
    SELECT s.agency_id INTO v_research_agency
      FROM research_insights i
      JOIN research_sessions s ON s.research_session_id = i.research_session_id
     WHERE i.research_insight_id = NEW.research_insight_id;
    IF v_client_agency IS NULL OR v_research_agency IS NULL
       OR v_client_agency <> v_research_agency THEN
        RAISE EXCEPTION 'content hypothesis research citation %→% crosses an agency boundary — research insight citations stay inside the client''s agency',
            NEW.content_hypothesis_id, NEW.research_insight_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_hypothesis_research_scope_trigger ON content_hypothesis_research_refs;
CREATE TRIGGER content_hypothesis_research_scope_trigger
    BEFORE INSERT ON content_hypothesis_research_refs
    FOR EACH ROW EXECUTE FUNCTION content_hypothesis_research_scope_consistent();

-- ---------------------------------------------------------------------------
-- content_observation_ingestion_runs — the honest ingestion run records
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS content_observation_ingestion_runs (
    ingestion_run_id      uuid        PRIMARY KEY,
    client_id             uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id          uuid        REFERENCES workspaces(workspace_id),
    -- The /integrations connection the observations were read through
    -- (FK-anchored; integration_connections is read CHECK-ONLY here).
    connection_id         uuid        NOT NULL REFERENCES integration_connections(connection_id),
    observation_kind      text        NOT NULL
                          CHECK (observation_kind IN ('platform_content', 'platform_analytics')),
    -- The frozen normalized operation label that was requested.
    operation             text        NOT NULL
                          CHECK (length(operation) >= 1 AND length(operation) <= 100),
    -- The honest run status: completed (records observed, evidence
    -- appended), refused (policy-denied) or failed (read error — the
    -- 'content.list' label awaits its adapter) — never invented success.
    status                text        NOT NULL
                          CHECK (status IN ('completed', 'refused', 'failed')),
    records_observed      integer     NOT NULL CHECK (records_observed >= 0),
    evidence_appended     integer     NOT NULL CHECK (evidence_appended >= 0),
    -- The ids of the /evidence records appended by this run (a bounded
    -- jsonb array — the observations themselves live ONLY in /evidence).
    appended_evidence_ids jsonb       NOT NULL DEFAULT '[]'::jsonb
                          CHECK (jsonb_typeof(appended_evidence_ids) = 'array'),
    started_at            timestamptz NOT NULL,
    finished_at           timestamptz NOT NULL,
    detail                text        CHECK (detail IS NULL
                                   OR (length(detail) >= 1 AND length(detail) <= 2000)),
    -- SERVER-DERIVED provenance (never a request field).
    recorded_actor        text        NOT NULL
                          CHECK (length(recorded_actor) >= 1 AND length(recorded_actor) <= 100),
    recorded_via          text        NOT NULL
                          CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 100),
    correlation_id        text        NOT NULL,
    causation_id          text,
    created_at            timestamptz NOT NULL,
    -- The appended-evidence count must match the id array (the honest
    -- counts discipline).
    CONSTRAINT content_observation_ingestion_counts_consistent CHECK (
        evidence_appended = jsonb_array_length(appended_evidence_ids)
    )
);

-- The client's ingestion-run tail (oldest first).
CREATE INDEX IF NOT EXISTS content_observation_ingestion_runs_client_idx
    ON content_observation_ingestion_runs (client_id, created_at, ingestion_run_id);

-- Ingestion runs are append-only (the honest execution record).
CREATE OR REPLACE FUNCTION content_observation_ingestion_runs_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'content observation ingestion runs are append-only: % is rejected',
        TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_observation_ingestion_runs_append_only_update_trigger ON content_observation_ingestion_runs;
CREATE TRIGGER content_observation_ingestion_runs_append_only_update_trigger
    BEFORE UPDATE ON content_observation_ingestion_runs
    FOR EACH ROW EXECUTE FUNCTION content_observation_ingestion_runs_append_only();

DROP TRIGGER IF EXISTS content_observation_ingestion_runs_append_only_delete_trigger ON content_observation_ingestion_runs;
CREATE TRIGGER content_observation_ingestion_runs_append_only_delete_trigger
    BEFORE DELETE ON content_observation_ingestion_runs
    FOR EACH ROW EXECUTE FUNCTION content_observation_ingestion_runs_append_only();
