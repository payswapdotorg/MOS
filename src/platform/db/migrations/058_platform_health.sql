-- 058_platform_health.sql — MKT-066 (Platform Health and Distribution
-- Anomaly Detection).
--
-- The PLATFORM HEALTH authority (spec/architecture-v1.6.md §11 — the
-- primary contract: "MOS does not claim access to hidden platform
-- moderation state unless a platform explicitly exposes it. Platform
-- Health is composed from platform-reported restrictions, publishing
-- errors, policy/eligibility signals, copyright/claim signals,
-- recommendation/distribution metrics where available, non-follower
-- reach, search/recommendation impressions where available, engagement
-- and retention, deviations from the account's historical baseline,
-- cross-platform control comparisons, and automation/inauthenticity risk
-- signals observable from first-party metrics or connected platform
-- feedback"; spec/effective-backlog-v1.6.md MKT-066; architecture-lock
-- rules 25/26/27; the frozen v1.6 matrix row /platform-health ──→
-- /social-accounts, /integrations, /metrics, /evidence, /experiments):
--
--   platform_health_evaluations                     → the CLIENT-SCOPED
--                                                    append-only
--                                                    EVALUATION records
--                                                    (the §11 descriptive
--                                                    state verdict + the
--                                                    closed reason-code
--                                                    set + the confidence
--                                                    tier + the honest
--                                                    uncertainty
--                                                    statement + the
--                                                    baseline summaries +
--                                                    the compliant §11
--                                                    maneuver
--                                                    recommendations +
--                                                    the evidence basis +
--                                                    the signals-considered
--                                                    composition
--                                                    disclosure +
--                                                    SERVER-DERIVED
--                                                    provenance);
--   platform_health_evaluation_evidence             → the FK-anchored
--                                                    same-Client /evidence
--                                                    citation links (the
--                                                    evidence basis behind
--                                                    the verdict —
--                                                    evidence read
--                                                    CHECK-ONLY);
--   platform_health_evaluation_metric_observations  → the FK-anchored
--                                                    same-Client /metrics
--                                                    observation citation
--                                                    links (the consumed
--                                                    account/control
--                                                    series points —
--                                                    metric_observations
--                                                    read CHECK-ONLY);
--   platform_health_evaluation_publication_refs     → the FK-anchored
--                                                    same-Client 056
--                                                    publish-attempt
--                                                    citation links (the
--                                                    observable
--                                                    publication-outcome
--                                                    records —
--                                                    social_publish_attempts
--                                                    read CHECK-ONLY).
--
-- Key fences:
--
-- * CHECK-fenced vocabularies on every enumerated column: the FROZEN
--   NINE §11 states (healthy, degraded, restricted,
--   suspected_distribution_anomaly, suspected_automation_risk,
--   authorization_blocked, publishing_blocked, quota_limited,
--   human_review_required — there is deliberately NO shadow-ban state or
--   synonym anywhere in this migration: lock rule 26), the three
--   confidence tiers (high/medium/low — a coarse evidence-derived
--   ranking, never a fabricated probability) and the version strings
--   (ph-vocab-v1 / ph-baseline-v1). The reason codes, baseline
--   summaries, recommendations, evidence basis and signals-considered
--   blocks are bounded jsonb (arrays/objects of the closed module-side
--   vocabularies — the house jsonb precedent: the DB cannot express
--   closed-set membership for jsonb elements without a custom immutable
--   function, which the house migrations do not use — the module guards
--   are the fence and the boundary tests pin the vocabularies).
-- * THE APPEND-ONLY TAILS: evaluations and every citation link reject
--   UPDATE and DELETE outright — a new evaluation is a NEW record,
--   history is never rewritten (the migration-047/052 pattern).
-- * THE SCOPE FENCES: every cross-module FK link is same-Client —
--   evidence links (evidence read CHECK-ONLY), metric observation links
--   (metric_observations read CHECK-ONLY) and publication refs
--   (social_publish_attempts read CHECK-ONLY); the evaluation itself
--   FK-anchors the owning client and the 046 social account.
-- * NO AUTHORITY TRANSFER: this migration creates NO evidence, metric,
--   experiment, account, grant, attempt, integration, mission or tenant
--   table — the health evaluation COMPOSES observable records through
--   the five frozen-row public contracts and cites them by reference;
--   the /platform-health module holds no account registry, no publish
--   ledger, no metrics authority and no evidence authority (the 063/064
--   table discipline).
-- * NO SECRET MATERIAL ANYWHERE (CRED-001/§21): the only structured
--   payload columns are the bounded verdict/reason/baseline/
--   recommendation/evidence-basis/signals blocks — there is deliberately
--   NO column capable of holding secret material (the module applies the
--   shared /evidence §21 material-key guard at the boundary).
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, append-oriented tails. No owner/role/user columns beyond
-- provenance: client-scope authorization stays exactly the
-- requireClientAccess route-layer authority — no second tenant,
-- permission or identity authority.

-- ---------------------------------------------------------------------------
-- platform_health_evaluations — the client-scoped append-only evaluation
-- records
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS platform_health_evaluations (
    platform_health_evaluation_id  uuid        PRIMARY KEY,
    -- CLIENT-SCOPED (the /evidence precedent). The client row is resolved
    -- at the ROUTE layer (requireClientAccess — /clients is not an
    -- allowance of this module's dependency row); the FK anchor keeps a
    -- dangling client reference from persisting.
    client_id                      uuid        NOT NULL REFERENCES clients(client_id),
    -- Optional Workspace scope INSIDE the owning Client (the account's
    -- own workspace narrowing, carried as data).
    workspace_id                   uuid        REFERENCES workspaces(workspace_id),
    -- The evaluated account (the 046 FK anchor; the account row is read
    -- CHECK-ONLY through the /social-accounts public contract).
    social_account_id              uuid        NOT NULL REFERENCES social_accounts(social_account_id),
    agency_id                      uuid        NOT NULL REFERENCES agencies(agency_id),
    -- The platform identity: the account record's platform id carried as
    -- DATA (lock rule 18 — never a provider branch).
    platform_id                    text        NOT NULL
                                   CHECK (platform_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
    -- THE FROZEN NINE §11 DESCRIPTIVE STATES (CHECK-fenced; lock rules
    -- 25/26: 'restricted' requires a platform-CONFIRMED restriction
    -- record — observable-only anomaly evidence is
    -- suspected_distribution_anomaly; there is no shadow-ban state).
    evaluated_state                text        NOT NULL
                                   CHECK (evaluated_state IN ('healthy',
                                                               'degraded',
                                                               'restricted',
                                                               'suspected_distribution_anomaly',
                                                               'suspected_automation_risk',
                                                               'authorization_blocked',
                                                               'publishing_blocked',
                                                               'quota_limited',
                                                               'human_review_required')),
    -- The coarse confidence tier (a ranking of the observable evidence,
    -- never a fabricated probability).
    confidence                     text        NOT NULL
                                   CHECK (confidence IN ('high', 'medium', 'low')),
    -- The honest uncertainty statement (bounded).
    uncertainty                    text        NOT NULL
                                   CHECK (length(uncertainty) >= 1 AND length(uncertainty) <= 4000),
    -- The closed reason-code set (bounded jsonb array of the ph-vocab-v1
    -- codes; ≤24 items, no duplicates — module-side validated).
    reason_codes                   jsonb       NOT NULL DEFAULT '[]'::jsonb
                                   CHECK (jsonb_typeof(reason_codes) = 'array'
                                          AND jsonb_array_length(reason_codes) <= 24),
    -- The per-series baseline summaries (the ph-baseline-v1 disclosure).
    baseline                       jsonb       NOT NULL DEFAULT '[]'::jsonb
                                   CHECK (jsonb_typeof(baseline) = 'array'),
    -- The compliant §11 maneuver recommendations (as data; the forbidden
    -- actions are structurally absent from the vocabulary).
    recommendations                jsonb       NOT NULL DEFAULT '[]'::jsonb
                                   CHECK (jsonb_typeof(recommendations) = 'array'),
    -- The evidence basis: WHICH observable records produced the verdict.
    evidence_basis                 jsonb       NOT NULL DEFAULT '[]'::jsonb
                                   CHECK (jsonb_typeof(evidence_basis) = 'array'
                                          AND jsonb_array_length(evidence_basis) <= 128),
    -- The composition disclosure (which surfaces were consulted).
    signals_considered             jsonb       NOT NULL DEFAULT '{}'::jsonb
                                   CHECK (jsonb_typeof(signals_considered) = 'object'),
    -- The frozen version strings (a vocabulary change is a NEW version).
    vocabulary_version             text        NOT NULL
                                   CHECK (vocabulary_version = 'ph-vocab-v1'),
    baseline_version               text        NOT NULL
                                   CHECK (baseline_version = 'ph-baseline-v1'),
    -- SERVER-DERIVED provenance (never a request field).
    recorded_actor                 text        NOT NULL
                                   CHECK (length(recorded_actor) >= 1 AND length(recorded_actor) <= 100),
    recorded_via                   text        NOT NULL
                                   CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 100),
    correlation_id                 text        NOT NULL,
    causation_id                   text,
    created_at                     timestamptz NOT NULL
);

-- The client's evaluation tail (oldest first).
CREATE INDEX IF NOT EXISTS platform_health_evaluations_client_idx
    ON platform_health_evaluations (client_id, created_at, platform_health_evaluation_id);
-- The account's evaluation tail (the per-destination read).
CREATE INDEX IF NOT EXISTS platform_health_evaluations_account_idx
    ON platform_health_evaluations (social_account_id, created_at, platform_health_evaluation_id);

-- Evaluations are append-only: a new evaluation is a NEW record; the
-- recorded verdicts and their bases are never rewritten in place.
CREATE OR REPLACE FUNCTION platform_health_evaluations_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'platform health evaluations are append-only: % is rejected on evaluation % — a new evaluation is a NEW record',
        TG_OP, COALESCE(NEW.platform_health_evaluation_id, OLD.platform_health_evaluation_id);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS platform_health_evaluations_append_only_update_trigger ON platform_health_evaluations;
CREATE TRIGGER platform_health_evaluations_append_only_update_trigger
    BEFORE UPDATE ON platform_health_evaluations
    FOR EACH ROW EXECUTE FUNCTION platform_health_evaluations_append_only();

DROP TRIGGER IF EXISTS platform_health_evaluations_append_only_delete_trigger ON platform_health_evaluations;
CREATE TRIGGER platform_health_evaluations_append_only_delete_trigger
    BEFORE DELETE ON platform_health_evaluations
    FOR EACH ROW EXECUTE FUNCTION platform_health_evaluations_append_only();

-- ---------------------------------------------------------------------------
-- platform_health_evaluation_evidence — the FK-anchored /evidence
-- citation links (the evidence basis behind the verdict)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS platform_health_evaluation_evidence (
    platform_health_evaluation_id  uuid    NOT NULL REFERENCES platform_health_evaluations(platform_health_evaluation_id),
    evidence_id                    uuid    NOT NULL REFERENCES evidence(evidence_id),
    position                       integer NOT NULL CHECK (position >= 1 AND position <= 16),
    CONSTRAINT platform_health_evaluation_evidence_pk
        PRIMARY KEY (platform_health_evaluation_id, evidence_id)
);

-- Evidence links are append-only.
CREATE OR REPLACE FUNCTION platform_health_evaluation_evidence_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'platform health evaluation evidence links are append-only: % is rejected',
        TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS platform_health_evaluation_evidence_append_only_update_trigger ON platform_health_evaluation_evidence;
CREATE TRIGGER platform_health_evaluation_evidence_append_only_update_trigger
    BEFORE UPDATE ON platform_health_evaluation_evidence
    FOR EACH ROW EXECUTE FUNCTION platform_health_evaluation_evidence_append_only();

DROP TRIGGER IF EXISTS platform_health_evaluation_evidence_append_only_delete_trigger ON platform_health_evaluation_evidence;
CREATE TRIGGER platform_health_evaluation_evidence_append_only_delete_trigger
    BEFORE DELETE ON platform_health_evaluation_evidence
    FOR EACH ROW EXECUTE FUNCTION platform_health_evaluation_evidence_append_only();

-- THE EVIDENCE SCOPE FENCE: an evidence citation must reference an
-- /evidence record of the SAME client as the evaluation (the evidence
-- table is read CHECK-ONLY — never written here; /evidence stays the
-- sole evidence authority).
CREATE OR REPLACE FUNCTION platform_health_evaluation_evidence_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_evaluation_client uuid;
    v_evidence_client uuid;
BEGIN
    SELECT client_id INTO v_evaluation_client
      FROM platform_health_evaluations WHERE platform_health_evaluation_id = NEW.platform_health_evaluation_id;
    SELECT client_id INTO v_evidence_client
      FROM evidence WHERE evidence_id = NEW.evidence_id;
    IF v_evaluation_client IS NULL OR v_evidence_client IS NULL
       OR v_evaluation_client <> v_evidence_client THEN
        RAISE EXCEPTION 'platform health evaluation evidence link %→% crosses a client boundary — evidence citations stay inside one client',
            NEW.platform_health_evaluation_id, NEW.evidence_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS platform_health_evaluation_evidence_scope_trigger ON platform_health_evaluation_evidence;
CREATE TRIGGER platform_health_evaluation_evidence_scope_trigger
    BEFORE INSERT ON platform_health_evaluation_evidence
    FOR EACH ROW EXECUTE FUNCTION platform_health_evaluation_evidence_scope_consistent();

-- ---------------------------------------------------------------------------
-- platform_health_evaluation_metric_observations — the FK-anchored
-- /metrics observation citation links (the consumed series points)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS platform_health_evaluation_metric_observations (
    platform_health_evaluation_id  uuid    NOT NULL REFERENCES platform_health_evaluations(platform_health_evaluation_id),
    metric_observation_id          uuid    NOT NULL REFERENCES metric_observations(observation_id),
    position                       integer NOT NULL CHECK (position >= 1 AND position <= 32),
    CONSTRAINT platform_health_evaluation_metric_observations_pk
        PRIMARY KEY (platform_health_evaluation_id, metric_observation_id)
);

-- Metric observation links are append-only.
CREATE OR REPLACE FUNCTION platform_health_evaluation_metric_links_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'platform health evaluation metric observation links are append-only: % is rejected',
        TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS platform_health_evaluation_metric_links_append_only_update_trigger ON platform_health_evaluation_metric_observations;
CREATE TRIGGER platform_health_evaluation_metric_links_append_only_update_trigger
    BEFORE UPDATE ON platform_health_evaluation_metric_observations
    FOR EACH ROW EXECUTE FUNCTION platform_health_evaluation_metric_links_append_only();

DROP TRIGGER IF EXISTS platform_health_evaluation_metric_links_append_only_delete_trigger ON platform_health_evaluation_metric_observations;
CREATE TRIGGER platform_health_evaluation_metric_links_append_only_delete_trigger
    BEFORE DELETE ON platform_health_evaluation_metric_observations
    FOR EACH ROW EXECUTE FUNCTION platform_health_evaluation_metric_links_append_only();

-- THE METRIC SCOPE FENCE: a metric observation citation must reference an
-- observation of the SAME client (the metric_observations table is read
-- CHECK-ONLY — never written here; /metrics stays the sole authority).
CREATE OR REPLACE FUNCTION platform_health_evaluation_metric_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_evaluation_client uuid;
    v_metric_client uuid;
BEGIN
    SELECT client_id INTO v_evaluation_client
      FROM platform_health_evaluations WHERE platform_health_evaluation_id = NEW.platform_health_evaluation_id;
    SELECT client_id INTO v_metric_client
      FROM metric_observations WHERE observation_id = NEW.metric_observation_id;
    IF v_evaluation_client IS NULL OR v_metric_client IS NULL
       OR v_evaluation_client <> v_metric_client THEN
        RAISE EXCEPTION 'platform health evaluation metric link %→% crosses a client boundary — metric observation citations stay inside one client',
            NEW.platform_health_evaluation_id, NEW.metric_observation_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS platform_health_evaluation_metric_scope_trigger ON platform_health_evaluation_metric_observations;
CREATE TRIGGER platform_health_evaluation_metric_scope_trigger
    BEFORE INSERT ON platform_health_evaluation_metric_observations
    FOR EACH ROW EXECUTE FUNCTION platform_health_evaluation_metric_scope_consistent();

-- ---------------------------------------------------------------------------
-- platform_health_evaluation_publication_refs — the FK-anchored 056
-- publish-attempt citation links (the observable publication outcomes)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS platform_health_evaluation_publication_refs (
    platform_health_evaluation_id  uuid    NOT NULL REFERENCES platform_health_evaluations(platform_health_evaluation_id),
    publish_attempt_id             uuid    NOT NULL REFERENCES social_publish_attempts(attempt_id),
    position                       integer NOT NULL CHECK (position >= 1 AND position <= 32),
    CONSTRAINT platform_health_evaluation_publication_refs_pk
        PRIMARY KEY (platform_health_evaluation_id, publish_attempt_id)
);

-- Publication refs are append-only.
CREATE OR REPLACE FUNCTION platform_health_evaluation_publication_refs_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'platform health evaluation publication refs are append-only: % is rejected',
        TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS platform_health_evaluation_publication_refs_append_only_update_trigger ON platform_health_evaluation_publication_refs;
CREATE TRIGGER platform_health_evaluation_publication_refs_append_only_update_trigger
    BEFORE UPDATE ON platform_health_evaluation_publication_refs
    FOR EACH ROW EXECUTE FUNCTION platform_health_evaluation_publication_refs_append_only();

DROP TRIGGER IF EXISTS platform_health_evaluation_publication_refs_append_only_delete_trigger ON platform_health_evaluation_publication_refs;
CREATE TRIGGER platform_health_evaluation_publication_refs_append_only_delete_trigger
    BEFORE DELETE ON platform_health_evaluation_publication_refs
    FOR EACH ROW EXECUTE FUNCTION platform_health_evaluation_publication_refs_append_only();

-- THE PUBLICATION SCOPE FENCE: a publication citation must reference a
-- 056 publish attempt of the SAME client (the social_publish_attempts
-- table is read CHECK-ONLY — never written here; /social-accounts stays
-- the sole publish-ledger authority).
CREATE OR REPLACE FUNCTION platform_health_evaluation_publication_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_evaluation_client uuid;
    v_attempt_client uuid;
BEGIN
    SELECT client_id INTO v_evaluation_client
      FROM platform_health_evaluations WHERE platform_health_evaluation_id = NEW.platform_health_evaluation_id;
    SELECT client_id INTO v_attempt_client
      FROM social_publish_attempts WHERE attempt_id = NEW.publish_attempt_id;
    IF v_evaluation_client IS NULL OR v_attempt_client IS NULL
       OR v_evaluation_client <> v_attempt_client THEN
        RAISE EXCEPTION 'platform health evaluation publication ref %→% crosses a client boundary — publish attempt citations stay inside one client',
            NEW.platform_health_evaluation_id, NEW.publish_attempt_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS platform_health_evaluation_publication_scope_trigger ON platform_health_evaluation_publication_refs;
CREATE TRIGGER platform_health_evaluation_publication_scope_trigger
    BEFORE INSERT ON platform_health_evaluation_publication_refs
    FOR EACH ROW EXECUTE FUNCTION platform_health_evaluation_publication_scope_consistent();
