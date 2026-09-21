-- 050_social_adapter_contract.sql — MKT-056 (Social Platform Adapter
-- Contract).
--
-- The NORMALIZED SOCIAL CAPABILITY CONTRACT extension of the existing
-- /social-accounts boundary (spec/effective-backlog-v1.6.md MKT-056:
-- "formalize per-platform capability matrix and normalized social
-- account/content/analytics/publish operations"; acceptance
-- "capability-subset support, adapter conformance suite, no
-- platform-specific knowledge outside adapter subtrees";
-- spec/architecture-v1.6.md §4: "The contract MUST allow a platform to
-- expose a subset of capabilities"; spec/module-dependency-matrix-v1.6.md
-- boundary rules 1/2).
--
-- TABLE-OWNERSHIP CHOICE (disclosed in docs/runbooks/MKT-056.md): this
-- Work Item EXTENDS /social-accounts (the dispatch: "Extend, do not
-- duplicate") — it registers NO new module and NO new spec matrix row;
-- BOTH tables here are OWNED by /social-accounts following the module's
-- own migration-046 store pattern.
--
--   social_publish_attempts          → the PUBLISH IDEMPOTENCY FENCE +
--                                       the claim-then-fill attempt
--                                       ledger: one row per
--                                       (social_account_id,
--                                       idempotency_key) submit — born
--                                       'submitted' (the honest UNKNOWN
--                                       in-flight state of an
--                                       interrupted publish — never
--                                       blindly replayed under the same
--                                       key), single-fill terminal in
--                                       accepted/published/failed/
--                                       restricted with the provider
--                                       refs, the taxonomy failure code
--                                       and the observable restriction
--                                       signals;
--   social_publish_status_observations → the APPEND-ONLY provider
--                                       status-poll history: one
--                                       immutable row per poll — the
--                                       attempt row keeps the
--                                       SUBMIT-TIME fact, the
--                                       observations carry the later
--                                       provider answers.
--
-- DELIBERATE NON-CHOICES (frozen boundary discipline):
--   - NO capability-registration table: the capability matrix is
--     ADAPTER-DECLARED registry DATA validated at construction (the
--     migration-029 discipline — "the database never stores the adapter
--     set"; the MKT-071 commerce precedent). What the storage layer
--     CHECK-fences instead is the OUTCOME vocabulary the matrix gates:
--     the publish states and the failure taxonomy.
--   - NO content/analytics/restriction-signal STATE tables: normalized
--     read operations return DATA to their server-side callers — content
--     observations become evidence/candidates through MKT-062
--     (/content-intelligence, Worker B), platform-health interpretation
--     is MKT-066, distribution publication planning is MKT-065. This
--     contract records, it does not interpret.
--   - NO materialized view of the MKT-055 grant facts: the host resolves
--     the usable authorization (verbatim scopes, capability tags, vault
--     reference) through the module's own read surface at call time.
--
-- Frozen semantics encoded here:
--
-- * PUBLISH IDEMPOTENCY (the dispatch "idempotency rules for publish";
--   AGENTS.md runtime rule "Non-idempotent unknown side effects must not
--   be blindly replayed"): the PARTIAL UNIQUE fence admits at most ONE
--   attempt row per (social_account_id, idempotency_key) — a replayed
--   submit converges on the constraint and is answered from the recorded
--   row (the module surfaces duplicate:true), NEVER a second provider
--   publish. An interrupted submit stays 'submitted' — UNKNOWN,
--   unresolved, requiring reconciliation (never silently success).
-- * CLAIM-THEN-FILL (the migration-046 single-completion-fill
--   discipline): the ONLY sanctioned UPDATE on the attempts table is
--   'submitted' → exactly one of accepted/published/failed/restricted,
--   and only while the row is still 'submitted' (the trigger rejects
--   every other transition, every later UPDATE, and identity/provenance
--   rewrites). DELETE is rejected outright.
-- * OUTCOME-VOCABULARY CONSISTENCY: publish_state ∈ {submitted,
--   accepted, published, failed, restricted}; failure_code ∈ the closed
--   seven-code taxonomy {auth-expired, rate-limited, restricted,
--   policy-denied, provider-unavailable, unsupported-capability,
--   insufficient-scope}; a non-failed state carries NO failure code; a
--   failed state carries one (the pre-flight refusals and the
--   operation-level taxonomy failures; the provider's own
--   post-processing rejection rides provider_failure_reason as
--   passthrough). The observations never carry 'submitted'.
-- * APPEND-ONLY STATUS HISTORY (the migration 015/018/025/029/046
--   pattern): the observation tail rejects UPDATE and DELETE outright.
-- * TENANT FENCE (the migration 046/049 pattern): the attempt's
--   client/agency scope chain is server-derived from the bound social
--   account's own chain; the account-consistency trigger rejects a
--   crossed chain, and the observation-consistency trigger rejects an
--   observation that does not belong to its attempt's account.
-- * NO SECRET MATERIAL (implementation-contract §21): the publish
--   request summary, the provider passthrough and the restriction
--   signals are CHECKed against material-shaped keys at every nesting
--   level (the migration-029 integration_payload_has_no_material_keys
--   function is REUSED — IMMUTABLE and globally unique per the 029
--   discipline). The rate-limit observation columns are the
--   /integrations NormalizedRateLimit shape.
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, recorded_at provenance stamps, no owner/role/user columns
-- beyond provenance — authorization stays exactly the /agencies
-- membership authority composed with canonical /clients owner
-- resolution.

-- ---------------------------------------------------------------------------
-- social_publish_attempts — the publish idempotency fence + the
-- claim-then-fill attempt ledger
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS social_publish_attempts (
    attempt_id              uuid        PRIMARY KEY,
    social_account_id       uuid        NOT NULL REFERENCES social_accounts(social_account_id),
    integration_connection_id uuid      NOT NULL REFERENCES integration_connections(connection_id),
    agency_id               uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id               uuid        NOT NULL REFERENCES clients(client_id),
    -- The platform identity: the integration connection's adapter key
    -- carried as DATA (lock rule 18 — never a provider branch).
    platform_id             text        NOT NULL
                            CHECK (platform_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
    -- The at-most-once identity of the logical publish (the caller's key;
    -- fenced per ACCOUNT — the same key on another account is a different
    -- publish).
    idempotency_key         text        NOT NULL
                            CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    content_type            text        NOT NULL
                            CHECK (content_type ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
    -- The bounded publish request summary (§21-guarded at every nesting
    -- level; the attribution rides VERBATIM as passthrough — §16).
    publish_request         jsonb       NOT NULL
                            CHECK (integration_payload_has_no_material_keys(publish_request)),
    -- The frozen publish-lifecycle vocabulary (CHECK-fenced).
    publish_state           text        NOT NULL
                            CHECK (publish_state IN ('submitted', 'accepted',
                                                     'published', 'failed', 'restricted')),
    -- The closed failure taxonomy (CHECK-fenced; the consistency trigger
    -- below ties it to the failed state).
    failure_code            text
                            CHECK (failure_code IN ('auth-expired', 'rate-limited', 'restricted',
                                                    'policy-denied', 'provider-unavailable',
                                                    'unsupported-capability', 'insufficient-scope')),
    provider_publish_id     text        CHECK (provider_publish_id IS NULL
                                               OR (length(provider_publish_id) >= 1
                                                   AND length(provider_publish_id) <= 128)),
    provider_content_id     text        CHECK (provider_content_id IS NULL
                                               OR (length(provider_content_id) >= 1
                                                   AND length(provider_content_id) <= 128)),
    published_at            timestamptz,
    provider_failure_reason text        CHECK (provider_failure_reason IS NULL
                                               OR length(provider_failure_reason) <= 500),
    -- The observable restriction signals of a 'restricted' outcome
    -- (§21-guarded; ONLY what the provider exposes — §11).
    restriction_signals     jsonb       NOT NULL DEFAULT '[]'::jsonb
                            CHECK (integration_payload_has_no_material_keys(restriction_signals)),
    -- The provider passthrough of the submit outcome (§21-guarded).
    provider_data           jsonb
                            CHECK (provider_data IS NULL
                                   OR integration_payload_has_no_material_keys(provider_data)),
    -- The observed rate-limit/quota signals of the submit call (the
    -- /integrations NormalizedRateLimit shape — a RECORD, never an
    -- enforcement decision; policy stays in /policies).
    rate_limit_remaining    numeric,
    rate_limit_reset_at     timestamptz,
    backoff_until           timestamptz,
    retry_after_seconds     integer     CHECK (retry_after_seconds IS NULL
                                               OR retry_after_seconds >= 0),
    recorded_actor          text        NOT NULL CHECK (length(recorded_actor) >= 1),
    recorded_via            text        NOT NULL CHECK (length(recorded_via) >= 1
                                                 AND length(recorded_via) <= 100),
    correlation_id          text        NOT NULL,
    causation_id            text,
    created_at              timestamptz NOT NULL DEFAULT now(),
    -- The outcome-vocabulary consistency: only a FAILED attempt carries a
    -- taxonomy failure code; the claim state and every non-failed state
    -- carry none.
    CONSTRAINT social_publish_attempt_failure_code_consistency
        CHECK ((publish_state = 'failed' AND failure_code IS NOT NULL)
            OR (publish_state <> 'failed' AND failure_code IS NULL))
);

-- THE PUBLISH IDEMPOTENCY FENCE: at most ONE attempt per (account,
-- idempotency key) — the at-most-once submit semantics are race-free; a
-- concurrent or replayed submit converges here and is answered from the
-- recorded row, never a second provider publish.
CREATE UNIQUE INDEX IF NOT EXISTS social_publish_attempts_idempotency_fence
ON social_publish_attempts (social_account_id, idempotency_key);

-- Listing surfaces: the account's attempts + the client's attempts
-- (newest first).
CREATE INDEX IF NOT EXISTS social_publish_attempts_account_idx
ON social_publish_attempts (social_account_id, created_at DESC, attempt_id DESC);

CREATE INDEX IF NOT EXISTS social_publish_attempts_client_idx
ON social_publish_attempts (client_id, created_at DESC, attempt_id DESC);

-- CLAIM-THEN-FILL: the single sanctioned UPDATE is the completion fill
-- 'submitted' → exactly one terminal/accepted state. Every other UPDATE
-- (a re-fill, an identity/provenance rewrite, a state transition out of
-- a filled state) and every DELETE are rejected outright — the attempt
-- ledger records the submit facts immutably once filled.
CREATE OR REPLACE FUNCTION social_publish_attempts_fill_only() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'social publish attempts are append-only: DELETE is rejected on attempt %',
            OLD.attempt_id;
    END IF;
    -- The single completion fill: submitted → accepted|published|failed|restricted.
    IF OLD.publish_state <> 'submitted' THEN
        RAISE EXCEPTION 'social publish attempt % is ''%'' — a filled attempt is immutable (the single completion fill is the only sanctioned update)',
            OLD.attempt_id, OLD.publish_state;
    END IF;
    IF NEW.publish_state NOT IN ('accepted', 'published', 'failed', 'restricted') THEN
        RAISE EXCEPTION 'social publish attempt % cannot move ''submitted'' → ''%'' — the single completion fill targets accepted/published/failed/restricted',
            OLD.attempt_id, NEW.publish_state;
    END IF;
    -- The claim identity, the request and the provenance are immutable.
    IF NEW.attempt_id <> OLD.attempt_id
       OR NEW.social_account_id <> OLD.social_account_id
       OR NEW.integration_connection_id <> OLD.integration_connection_id
       OR NEW.agency_id <> OLD.agency_id
       OR NEW.client_id <> OLD.client_id
       OR NEW.platform_id <> OLD.platform_id
       OR NEW.idempotency_key <> OLD.idempotency_key
       OR NEW.content_type <> OLD.content_type
       OR NEW.publish_request <> OLD.publish_request
       OR NEW.recorded_actor <> OLD.recorded_actor
       OR NEW.recorded_via <> OLD.recorded_via
       OR NEW.correlation_id <> OLD.correlation_id
       OR NEW.causation_id IS DISTINCT FROM OLD.causation_id
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'social publish attempt % identity/request/provenance columns are immutable (only the outcome columns fill)',
            OLD.attempt_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS social_publish_attempts_fill_only_update_trigger ON social_publish_attempts;
CREATE TRIGGER social_publish_attempts_fill_only_update_trigger
    BEFORE UPDATE ON social_publish_attempts
    FOR EACH ROW EXECUTE FUNCTION social_publish_attempts_fill_only();

DROP TRIGGER IF EXISTS social_publish_attempts_fill_only_delete_trigger ON social_publish_attempts;
CREATE TRIGGER social_publish_attempts_fill_only_delete_trigger
    BEFORE DELETE ON social_publish_attempts
    FOR EACH ROW EXECUTE FUNCTION social_publish_attempts_fill_only();

-- Account-consistency backstop (the migration 046 pattern): the attempt's
-- agency/client chain must match its bound social account row EXACTLY —
-- the denormalized columns are server-derived from the account on the
-- only write path; a mismatched smuggle is rejected here even if every
-- application check were bypassed.
CREATE OR REPLACE FUNCTION social_publish_attempt_account_consistent() RETURNS trigger AS $$
DECLARE
    v_account record;
BEGIN
    SELECT client_id, agency_id, integration_connection_id, platform_id
    INTO v_account FROM social_accounts WHERE social_account_id = NEW.social_account_id;
    IF v_account IS NULL THEN
        RAISE EXCEPTION 'social publish attempt % references unknown social account %',
            NEW.attempt_id, NEW.social_account_id;
    END IF;
    IF v_account.client_id <> NEW.client_id
       OR v_account.agency_id <> NEW.agency_id
       OR v_account.integration_connection_id <> NEW.integration_connection_id
       OR v_account.platform_id <> NEW.platform_id THEN
        RAISE EXCEPTION 'social publish attempt % does not match its social account % — cross-tenant publish attempts are rejected',
            NEW.attempt_id, NEW.social_account_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS social_publish_attempt_account_consistent_trigger ON social_publish_attempts;
CREATE TRIGGER social_publish_attempt_account_consistent_trigger
    BEFORE INSERT ON social_publish_attempts
    FOR EACH ROW EXECUTE FUNCTION social_publish_attempt_account_consistent();

-- ---------------------------------------------------------------------------
-- social_publish_status_observations — the append-only provider
-- status-poll history (one immutable row per poll)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS social_publish_status_observations (
    observation_id          uuid        PRIMARY KEY,
    attempt_id              uuid        NOT NULL REFERENCES social_publish_attempts(attempt_id),
    social_account_id       uuid        NOT NULL REFERENCES social_accounts(social_account_id),
    client_id               uuid        NOT NULL REFERENCES clients(client_id),
    -- The observed provider state of THIS poll (never 'submitted' — a
    -- poll reports a provider answer).
    publish_state           text        NOT NULL
                            CHECK (publish_state IN ('accepted', 'published',
                                                     'failed', 'restricted')),
    failure_code            text
                            CHECK (failure_code IS NULL
                                   OR failure_code IN ('auth-expired', 'rate-limited', 'restricted',
                                                       'policy-denied', 'provider-unavailable',
                                                       'unsupported-capability', 'insufficient-scope')),
    provider_publish_id     text        CHECK (provider_publish_id IS NULL
                                               OR (length(provider_publish_id) >= 1
                                                   AND length(provider_publish_id) <= 128)),
    provider_content_id     text        CHECK (provider_content_id IS NULL
                                               OR (length(provider_content_id) >= 1
                                                   AND length(provider_content_id) <= 128)),
    published_at            timestamptz,
    provider_failure_reason text        CHECK (provider_failure_reason IS NULL
                                               OR length(provider_failure_reason) <= 500),
    restriction_signals     jsonb       NOT NULL DEFAULT '[]'::jsonb
                            CHECK (integration_payload_has_no_material_keys(restriction_signals)),
    provider_data           jsonb
                            CHECK (provider_data IS NULL
                                   OR integration_payload_has_no_material_keys(provider_data)),
    rate_limit_remaining    numeric,
    rate_limit_reset_at     timestamptz,
    backoff_until           timestamptz,
    retry_after_seconds     integer     CHECK (retry_after_seconds IS NULL
                                               OR retry_after_seconds >= 0),
    recorded_actor          text        NOT NULL CHECK (length(recorded_actor) >= 1),
    recorded_via            text        NOT NULL CHECK (length(recorded_via) >= 1
                                                 AND length(recorded_via) <= 100),
    correlation_id          text        NOT NULL,
    causation_id            text,
    observed_at             timestamptz NOT NULL DEFAULT now()
);

-- Listing surface: the observation history of one attempt (poll order).
CREATE INDEX IF NOT EXISTS social_publish_status_observations_attempt_idx
ON social_publish_status_observations (attempt_id, observed_at ASC, observation_id ASC);

-- APPEND-ONLY (the tail discipline): the provider status history is
-- never rewritten — every poll is a new immutable row.
CREATE OR REPLACE FUNCTION social_publish_status_observations_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'social publish status observations are append-only: % is rejected on observation %',
        TG_OP, OLD.observation_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS social_publish_status_observations_append_only_update_trigger ON social_publish_status_observations;
CREATE TRIGGER social_publish_status_observations_append_only_update_trigger
    BEFORE UPDATE ON social_publish_status_observations
    FOR EACH ROW EXECUTE FUNCTION social_publish_status_observations_append_only();

DROP TRIGGER IF EXISTS social_publish_status_observations_append_only_delete_trigger ON social_publish_status_observations;
CREATE TRIGGER social_publish_status_observations_append_only_delete_trigger
    BEFORE DELETE ON social_publish_status_observations
    FOR EACH ROW EXECUTE FUNCTION social_publish_status_observations_append_only();

-- Attempt-consistency backstop: the observation's account/client must
-- match its attempt row EXACTLY — an observation can never disagree with
-- the attempt it belongs to.
CREATE OR REPLACE FUNCTION social_publish_observation_attempt_consistent() RETURNS trigger AS $$
DECLARE
    v_attempt record;
BEGIN
    SELECT social_account_id, client_id INTO v_attempt
    FROM social_publish_attempts WHERE attempt_id = NEW.attempt_id;
    IF v_attempt IS NULL THEN
        RAISE EXCEPTION 'social publish status observation % references unknown attempt %',
            NEW.observation_id, NEW.attempt_id;
    END IF;
    IF v_attempt.social_account_id <> NEW.social_account_id
       OR v_attempt.client_id <> NEW.client_id THEN
        RAISE EXCEPTION 'social publish status observation % does not match its attempt % — the observation history may never disagree with its attempt',
            NEW.observation_id, NEW.attempt_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS social_publish_observation_attempt_consistent_trigger ON social_publish_status_observations;
CREATE TRIGGER social_publish_observation_attempt_consistent_trigger
    BEFORE INSERT ON social_publish_status_observations
    FOR EACH ROW EXECUTE FUNCTION social_publish_observation_attempt_consistent();
