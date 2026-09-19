-- 046_social_accounts.sql — MKT-055 (Social Account and OAuth Connection
-- Model).
--
-- The SOCIAL ACCOUNT AND OAUTH CONNECTION authority (spec/
-- architecture-v1.6.md §4: "Social accounts are external account identities
-- attached to a Client/Workspace through an authorized integration";
-- spec/effective-backlog-v1.6.md MKT-055: "first-class social-account
-- authorization over existing Credentials/Integrations"):
--
--   social_accounts             → the ACCOUNT IDENTITY BINDING records: one
--                                  external account identity (platform id —
--                                  the OPAQUE provider identifier carried
--                                  from the integration connection's
--                                  adapter key; external account id; display
--                                  identity; verified-at) attached to a
--                                  Client (agency derived SERVER-SIDE
--                                  through the integration connection's own
--                                  owning chain) and an OPTIONAL Workspace,
--                                  THROUGH an EXISTING authorized Integration
--                                  connection (canonical integration
--                                  reference, READ-ONLY);
--   social_account_grants       → the append-oriented AUTHORIZATION-GRANT
--                                  records: the OAuth connect-flow states
--                                  (pending → authorized → expired/revoked/
--                                  refreshed/superseded) with the canonical
--                                  credential-vault reference (NEVER token
--                                  material — §21) and the successor link;
--   social_account_events       → the APPEND-ONLY authorization-grant/
--                                  history tail: one immutable row per
--                                  lifecycle event with SERVER-DERIVED
--                                  provenance (UPDATE and DELETE rejected
--                                  outright);
--   social_account_grant_scopes → the SCOPE RECORDS: the EXACT granted
--                                  scope list recorded VERBATIM (kind
--                                  'granted-scope', order preserved) plus
--                                  the platform-normalized CAPABILITY TAGS
--                                  (kind 'capability-tag') — a faithful
--                                  RECORD of what the platform granted,
--                                  never an assumption of parity
--                                  (architecture-lock-v1.6 rule 19).
--
-- Frozen semantics encoded here (FROZEN — never a caller freedom):
--
-- * THE FROZEN ACCOUNT LIFECYCLE (MKT-055 AC-5): connected (born) →
--   disconnected | revoked. BOTH non-connected states are TERMINAL — a
--   disconnected or revoked connection is UNUSABLE and can never be
--   re-activated in place. Re-connecting the same external account under
--   the same integration is the NEW-RECORD path (a fresh binding row +
--   a fresh authorization cycle), never a resurrection.
-- * THE FROZEN GRANT LIFECYCLE (MKT-055 AC-2): pending (born at
--   authorize-start) → authorized (the single completion fill) | expired |
--   revoked ; authorized → expired | revoked | refreshed | superseded ;
--   expired → refreshed | superseded | revoked ; revoked / refreshed /
--   superseded are TERMINAL. Refresh and reauthorize transitions are NEW
--   RECORDS (the successor grant) + history events — never in-place
--   rewrites of the recorded authorization facts (scopes, identity,
--   credential reference, completion provenance and expiry are IMMUTABLE
--   once recorded).
-- * ONE CONNECTION BINDS ONE PLATFORM IDENTITY (MKT-055 AC-4): a partial
--   UNIQUE fence allows at most ONE connected binding per integration
--   connection; a second partial fence allows at most ONE connected
--   binding per (client, platform, external account) — re-connecting the
--   SAME external account under the SAME integration converges on the
--   single active binding (the completion supersedes the current grant),
--   while a CONFLICTING binding (a different external account on a bound
--   connection, or the same external account on a different connection
--   of the same Client) is rejected fail-closed by the fences.
-- * AT MOST ONE AUTHORIZED GRANT per account: a partial UNIQUE fence on
--   (social_account_id) WHERE grant_state = 'authorized' — no duplicate
--   active authorization can ever coexist (the supersede/refresh path
--   transitions the old grant BEFORE the successor is inserted, all
--   inside ONE transaction).
-- * SECRETS THROUGH THE /credentials VAULT BY CANONICAL REFERENCE
--   (MKT-055 AC-3; implementation-contract §21; architecture-lock-v1.6
--   rule 28): the grants table carries credential_reference_id ONLY —
--   there is deliberately NO token, code, secret, material or handle
--   column ANYWHERE in this migration (a static boundary test proves the
--   absence). The social-account grant is its OWN least-privilege
--   credential reference (kind 'social_account_oauth' — created through
--   the /credentials public contract, never shared with product/source/
--   store credentials): it confers NO product, source or store access.
-- * CANONICAL INTEGRATION REFERENCE (READ-ONLY): integration_connection_id
--   FK-references the migration-029 integration_connections table and is
--   immutable; the platform identity (platform_id) is the connection's
--   adapter key CARRIED AS DATA at binding time (the adapter registry is
--   injected data, never a hardcoded provider list — no platform-specific
--   knowledge lives in this module).
-- * THE PENDING-STATE FENCE: a pending grant records only the
--   authorize-start facts (state token, requested scopes, optional
--   expected account for reauthorize rounds); the credential/expiry/
--   completion facts are NULL until the single completion fill — the
--   ONLY sanctioned UPDATE that may fill them (trigger: fill exactly
--   once, only from 'pending', only to 'authorized').
-- * TENANT FENCE (the migration 003/004/029/044 pattern): agency/client
--   are SERVER-DERIVED through the integration connection's owning chain
--   and immutable; the scope-chain trigger rejects a crossed chain; the
--   optional workspace must belong to the owning client.
-- * NO AUTHORITY TRANSFER (architecture-lock-v1.6 rules 18/19/28): this
--   migration creates NO integration, credential, tenant, workflow,
--   execution, evidence, policy, product, store or publishing table —
--   the integration/credential authorities stay sole and are consumed
--   READ-ONLY through their public contracts. There is NO capability,
--   discovery, publishing or analytics surface here (MKT-056+ scope).
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, created_at/updated_at, version CAS for the narrow lifecycle
-- transitions, provenance columns that are never request-suppliable. No
-- owner/role/user columns beyond provenance: authorization stays exactly
-- the /agencies membership authority composed with canonical /clients
-- owner resolution at the route layer — no second tenant or permission
-- authority.

-- ---------------------------------------------------------------------------
-- social_accounts — the account identity binding records
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS social_accounts (
    social_account_id      uuid        PRIMARY KEY,
    -- The canonical integration reference (READ-ONLY): the EXISTING
    -- authorized integration connection this account is attached through.
    -- Immutable for the life of the binding row.
    integration_connection_id uuid     NOT NULL REFERENCES integration_connections(connection_id),
    -- The tenant scope chain (SERVER-DERIVED at binding time from the
    -- integration connection's own owning chain; immutable).
    agency_id              uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id              uuid        NOT NULL REFERENCES clients(client_id),
    -- The OPTIONAL Workspace narrowing (must belong to the owning client).
    workspace_id           uuid        REFERENCES workspaces(workspace_id),
    -- The platform identity: the integration connection's adapter key
    -- CARRIED AS DATA (the opaque provider identifier — never a hardcoded
    -- provider list; adapters declare themselves, the migration-029
    -- registry posture).
    platform_id            text        NOT NULL
                            CHECK (platform_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
    -- The EXTERNAL account identity (opaque provider-side identifiers,
    -- recorded VERBATIM from the authorization outcome — never normalized,
    -- never a MOS identity).
    external_account_id    text        NOT NULL
                            CHECK (length(external_account_id) >= 1
                                   AND length(external_account_id) <= 256),
    display_identity       text        NOT NULL
                            CHECK (length(display_identity) >= 1
                                   AND length(display_identity) <= 256),
    verified_at            timestamptz,
    -- The frozen binding lifecycle: connected (born) → disconnected |
    -- revoked (BOTH terminal — a dead binding can never be re-activated
    -- in place; MKT-055 AC-5 fail-closed disconnect/revocation).
    status                 text        NOT NULL DEFAULT 'connected'
                            CHECK (status IN ('connected', 'disconnected', 'revoked')),
    -- SERVER-DERIVED provenance of the binding (never request fields).
    created_by_actor       text        NOT NULL
                            CHECK (length(created_by_actor) >= 1
                                   AND length(created_by_actor) <= 100),
    created_via            text        NOT NULL
                            CHECK (length(created_via) >= 1
                                   AND length(created_via) <= 100),
    correlation_id         text        NOT NULL,
    causation_id           text,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    version                bigint      NOT NULL DEFAULT 1 CHECK (version >= 1)
);

-- ONE CONNECTION BINDS ONE PLATFORM IDENTITY (AC-4): at most ONE
-- connected binding per integration connection — a second live binding
-- on the same connection is impossible even under concurrency.
CREATE UNIQUE INDEX IF NOT EXISTS social_accounts_connection_active_fence
    ON social_accounts (integration_connection_id)
    WHERE status = 'connected';

-- At most ONE connected binding per (client, platform, external account):
-- re-connecting the same external account converges on the single active
-- binding; a duplicate active binding of the same platform identity in
-- one Client is impossible (conflicting bindings are rejected fail-closed).
CREATE UNIQUE INDEX IF NOT EXISTS social_accounts_identity_active_fence
    ON social_accounts (client_id, platform_id, external_account_id)
    WHERE status = 'connected';

-- Listing surfaces: the Client's bindings, the Workspace slice and the
-- integration connection's bindings (the reconnect-convergence lookup).
CREATE INDEX IF NOT EXISTS social_accounts_client_idx
    ON social_accounts (client_id, created_at, social_account_id);
CREATE INDEX IF NOT EXISTS social_accounts_workspace_idx
    ON social_accounts (workspace_id) WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS social_accounts_connection_idx
    ON social_accounts (integration_connection_id, created_at);

-- TENANT FENCE (the migration 003/004/029/044 pattern): the binding's
-- client must belong to its agency (the scope chain was derived through
-- the integration connection's own /clients resolution — the database
-- backstops it), and the optional workspace must belong to the client.
CREATE OR REPLACE FUNCTION social_account_scope_chain_consistent() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM clients c
        WHERE c.client_id = NEW.client_id AND c.agency_id = NEW.agency_id) THEN
        RAISE EXCEPTION 'social account % client % does not belong to agency % — the tenant scope chain cannot be crossed',
            NEW.social_account_id, NEW.client_id, NEW.agency_id;
    END IF;
    IF NEW.workspace_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workspaces w
        WHERE w.workspace_id = NEW.workspace_id AND w.client_id = NEW.client_id) THEN
        RAISE EXCEPTION 'social account % workspace % does not belong to client % — the tenant scope chain cannot be crossed',
            NEW.social_account_id, NEW.workspace_id, NEW.client_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS social_account_scope_chain_trigger ON social_accounts;
CREATE TRIGGER social_account_scope_chain_trigger
    BEFORE INSERT OR UPDATE OF agency_id, client_id, workspace_id ON social_accounts
    FOR EACH ROW EXECUTE FUNCTION social_account_scope_chain_consistent();

-- CANONICAL INTEGRATION-REFERENCE CONSISTENCY (read CHECK-ONLY — the
-- migration-029 authority is never mutated here): the binding's agency,
-- client and platform identity must match its integration connection row
-- EXACTLY (the connection owns the canonical chain; the binding can
-- never smuggle a crossed integration reference).
CREATE OR REPLACE FUNCTION social_account_integration_consistent() RETURNS trigger AS $$
DECLARE
    v_conn record;
BEGIN
    SELECT client_id, agency_id, adapter_key INTO v_conn
      FROM integration_connections WHERE connection_id = NEW.integration_connection_id;
    IF v_conn IS NULL THEN
        RAISE EXCEPTION 'social account % references unknown integration connection %',
            NEW.social_account_id, NEW.integration_connection_id;
    END IF;
    IF v_conn.client_id <> NEW.client_id OR v_conn.agency_id <> NEW.agency_id THEN
        RAISE EXCEPTION 'social account % integration connection % belongs to another client/agency — cross-tenant attachment is rejected',
            NEW.social_account_id, NEW.integration_connection_id;
    END IF;
    IF v_conn.adapter_key <> NEW.platform_id THEN
        RAISE EXCEPTION 'social account % platform % does not match its integration connection adapter %',
            NEW.social_account_id, NEW.platform_id, v_conn.adapter_key;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS social_account_integration_consistent_trigger ON social_accounts;
CREATE TRIGGER social_account_integration_consistent_trigger
    BEFORE INSERT ON social_accounts
    FOR EACH ROW EXECUTE FUNCTION social_account_integration_consistent();

-- BINDING-IDENTITY IMMUTABILITY + THE FROZEN ACCOUNT LIFECYCLE: the
-- integration reference, the tenant scope chain, the platform/external
-- identity, the verification stamp and the creation provenance can NEVER
-- be reassigned through ANY ordinary mutation path; the ONLY mutable
-- columns are the lifecycle (status), updated_at and the CAS version.
-- disconnected and revoked are TERMINAL (the transition table backstop).
-- The display identity is the BINDING-TIME record: a later provider-side
-- rename is live provider state (the future adapter layer's read
-- surface), never a rewrite of the recorded binding facts.
CREATE OR REPLACE FUNCTION social_accounts_identity_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW.social_account_id <> OLD.social_account_id THEN
        RAISE EXCEPTION 'social_account_id % is immutable', OLD.social_account_id;
    END IF;
    IF NEW.integration_connection_id <> OLD.integration_connection_id THEN
        RAISE EXCEPTION 'social account % cannot change its integration connection (was %)',
            OLD.social_account_id, OLD.integration_connection_id;
    END IF;
    IF NEW.agency_id <> OLD.agency_id OR NEW.client_id <> OLD.client_id THEN
        RAISE EXCEPTION 'social account % cannot change its tenant scope chain',
            OLD.social_account_id;
    END IF;
    IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
        RAISE EXCEPTION 'social account % cannot change its workspace attachment (was %)',
            OLD.social_account_id, OLD.workspace_id;
    END IF;
    IF NEW.platform_id <> OLD.platform_id THEN
        RAISE EXCEPTION 'social account % cannot change its platform identity (was %)',
            OLD.social_account_id, OLD.platform_id;
    END IF;
    IF NEW.external_account_id <> OLD.external_account_id THEN
        RAISE EXCEPTION 'social account % cannot change its external account identity (was %)',
            OLD.social_account_id, OLD.external_account_id;
    END IF;
    IF NEW.display_identity <> OLD.display_identity THEN
        RAISE EXCEPTION 'social account % cannot rewrite its display identity (was %) — provider-side identity changes are fresh authorization facts on NEW records',
            OLD.social_account_id, OLD.display_identity;
    END IF;
    IF NEW.verified_at IS DISTINCT FROM OLD.verified_at THEN
        RAISE EXCEPTION 'social account % cannot rewrite its verification stamp',
            OLD.social_account_id;
    END IF;
    IF NEW.created_by_actor <> OLD.created_by_actor
       OR NEW.created_via <> OLD.created_via
       OR NEW.correlation_id <> OLD.correlation_id
       OR NEW.causation_id IS DISTINCT FROM OLD.causation_id
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'social account % creation provenance is immutable',
            OLD.social_account_id;
    END IF;
    -- THE FROZEN ACCOUNT LIFECYCLE (MKT-055 AC-5): connected →
    -- disconnected | revoked; disconnected and revoked are TERMINAL — a
    -- dead binding can never be re-activated in place.
    IF NEW.status <> OLD.status THEN
        IF OLD.status <> 'connected' THEN
            RAISE EXCEPTION 'social account % is % — the binding lifecycle state is terminal and cannot be re-activated in place',
                OLD.social_account_id, OLD.status;
        END IF;
        IF NEW.status NOT IN ('disconnected', 'revoked') THEN
            RAISE EXCEPTION 'illegal social account transition % -> % on account %',
                OLD.status, NEW.status, OLD.social_account_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS social_accounts_identity_immutable_trigger ON social_accounts;
CREATE TRIGGER social_accounts_identity_immutable_trigger
    BEFORE UPDATE ON social_accounts
    FOR EACH ROW EXECUTE FUNCTION social_accounts_identity_immutable();

-- ---------------------------------------------------------------------------
-- social_account_grants — the append-oriented authorization-grant records
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS social_account_grants (
    grant_id               uuid        PRIMARY KEY,
    -- The integration connection the authorization cycle runs through
    -- (canonical, READ-ONLY; immutable for the life of the grant row).
    integration_connection_id uuid     NOT NULL REFERENCES integration_connections(connection_id),
    -- The tenant scope chain (SERVER-DERIVED from the connection's owning
    -- chain; immutable).
    agency_id              uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id              uuid        NOT NULL REFERENCES clients(client_id),
    -- The OPTIONAL Workspace narrowing chosen at authorize-start: carried
    -- by the round to the binding at completion (an authorize-start fact —
    -- immutable, like the state token and the requested scopes).
    workspace_id           uuid        REFERENCES workspaces(workspace_id),
    -- The bound account: NULL while a FRESH round is pending (the
    -- external identity is unknown until the callback); SET exactly once
    -- by the single completion fill — or PRE-SET at REAUTHORIZE start
    -- (the expected identity of the round). Immutable after the fill.
    social_account_id      uuid        REFERENCES social_accounts(social_account_id),
    -- The platform identity (the connection's adapter key, carried as data).
    platform_id            text        NOT NULL
                            CHECK (platform_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
    -- THE FROZEN GRANT LIFECYCLE (MKT-055 AC-2).
    grant_state            text        NOT NULL DEFAULT 'pending'
                            CHECK (grant_state IN ('pending', 'authorized', 'expired',
                                                   'revoked', 'refreshed', 'superseded')),
    -- The opaque anti-CSRF state token of the authorize-start round
    -- (server-generated; UNIQUE — the callback correlates the round).
    state_token            text        NOT NULL,
    -- The requested scopes of the round (recorded as INTENT; the GRANTED
    -- list is the verbatim scope records below). NULL when the round
    -- requested the provider default.
    requested_scopes       jsonb
                            CHECK (requested_scopes IS NULL
                                   OR (jsonb_typeof(requested_scopes) = 'array'
                                       AND jsonb_array_length(requested_scopes) >= 1
                                       AND jsonb_array_length(requested_scopes) <= 64)),
    -- The credential-vault REFERENCE of the token set (the /credentials
    -- logical name — NEVER material; §21). NULL while pending; filled
    -- exactly once by the completion.
    credential_reference_id uuid       REFERENCES credential_references(credential_id),
    -- The token expiry (the platform-reported access-token expiry).
    expires_at             timestamptz,
    -- The successor link: set when this grant is refreshed/superseded —
    -- the append-only forward pointer (the new grant is a NEW record; the
    -- old one never rewrites its recorded facts).
    successor_grant_id     uuid        REFERENCES social_account_grants(grant_id)
                            DEFERRABLE INITIALLY DEFERRED,
    -- The completion timestamp (NULL while pending).
    completed_at           timestamptz,
    -- SERVER-DERIVED provenance (never request fields): the start of the
    -- round and (after the fill) the completion provenance.
    started_by_actor      text        NOT NULL
                            CHECK (length(started_by_actor) >= 1
                                   AND length(started_by_actor) <= 100),
    started_via           text        NOT NULL
                            CHECK (length(started_via) >= 1
                                   AND length(started_via) <= 100),
    started_correlation_id text        NOT NULL,
    started_causation_id   text,
    completed_by_actor     text
                            CHECK (completed_by_actor IS NULL
                                   OR (length(completed_by_actor) >= 1
                                       AND length(completed_by_actor) <= 100)),
    completed_via         text
                            CHECK (completed_via IS NULL
                                   OR (length(completed_via) >= 1
                                       AND length(completed_via) <= 100)),
    completed_correlation_id text,
    completed_causation_id text,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    version                bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    -- THE PAYLOAD-SHAPE FENCE:
    --   * a PENDING round carries ONLY the authorize-start facts (the
    --     account may be pre-bound for reauthorize rounds; the completion
    --     facts are all NULL);
    --   * an AUTHORIZED-or-later grant is FULLY filled (account binding,
    --     credential reference, completion provenance) — its expires_at
    --     may legitimately be NULL (providers are not required to report
    --     token expiry);
    --   * an EXPIRED/REVOKED row is EITHER a fully-filled grant that
    --     died (it completed at least once) OR a dead round that never
    --     completed (an expired/cancelled authorize-start).
    CONSTRAINT social_account_grant_shape CHECK (
        (grant_state = 'pending'
           AND credential_reference_id IS NULL
           AND expires_at IS NULL
           AND successor_grant_id IS NULL
           AND completed_at IS NULL
           AND completed_by_actor IS NULL
           AND completed_via IS NULL
           AND completed_correlation_id IS NULL
           AND completed_causation_id IS NULL)
        OR (grant_state IN ('authorized', 'expired', 'revoked', 'refreshed', 'superseded')
           AND social_account_id IS NOT NULL
           AND credential_reference_id IS NOT NULL
           AND completed_at IS NOT NULL
           AND completed_by_actor IS NOT NULL
           AND completed_via IS NOT NULL
           AND completed_correlation_id IS NOT NULL)
        OR (grant_state IN ('expired', 'revoked')
           AND credential_reference_id IS NULL
           AND expires_at IS NULL
           AND successor_grant_id IS NULL
           AND completed_at IS NULL
           AND completed_by_actor IS NULL
           AND completed_via IS NULL
           AND completed_correlation_id IS NULL
           AND completed_causation_id IS NULL)
    )
);

-- THE STATE-TOKEN FENCE: the opaque state token is UNIQUE — the callback
-- correlates exactly one authorize-start round (a replayed or forged
-- state can never hit two rounds).
CREATE UNIQUE INDEX IF NOT EXISTS social_account_grants_state_token_unique
    ON social_account_grants (state_token);

-- AT MOST ONE AUTHORIZED GRANT PER ACCOUNT (no duplicate active
-- authorization — the refresh/supersede path transitions the old grant
-- BEFORE the successor is inserted, all inside one transaction).
CREATE UNIQUE INDEX IF NOT EXISTS social_account_grants_authorized_fence
    ON social_account_grants (social_account_id)
    WHERE grant_state = 'authorized' AND social_account_id IS NOT NULL;

-- Listing surfaces: the account's grant tail (the authorization history),
-- the client slice and the connection's rounds.
CREATE INDEX IF NOT EXISTS social_account_grants_account_idx
    ON social_account_grants (social_account_id, created_at, grant_id)
    WHERE social_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS social_account_grants_client_idx
    ON social_account_grants (client_id, created_at, grant_id);
CREATE INDEX IF NOT EXISTS social_account_grants_connection_idx
    ON social_account_grants (integration_connection_id, created_at);

-- TENANT FENCE + CANONICAL INTEGRATION REFERENCE (the binding pattern):
-- the grant's scope chain must match its integration connection exactly.
CREATE OR REPLACE FUNCTION social_account_grant_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_conn record;
BEGIN
    SELECT client_id, agency_id, adapter_key INTO v_conn
      FROM integration_connections WHERE connection_id = NEW.integration_connection_id;
    IF v_conn IS NULL THEN
        RAISE EXCEPTION 'social account grant % references unknown integration connection %',
            NEW.grant_id, NEW.integration_connection_id;
    END IF;
    IF v_conn.client_id <> NEW.client_id OR v_conn.agency_id <> NEW.agency_id THEN
        RAISE EXCEPTION 'social account grant % integration connection % belongs to another client/agency — cross-tenant authorization is rejected',
            NEW.grant_id, NEW.integration_connection_id;
    END IF;
    IF v_conn.adapter_key <> NEW.platform_id THEN
        RAISE EXCEPTION 'social account grant % platform % does not match its integration connection adapter %',
            NEW.grant_id, NEW.platform_id, v_conn.adapter_key;
    END IF;
    IF NEW.workspace_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workspaces w
        WHERE w.workspace_id = NEW.workspace_id AND w.client_id = NEW.client_id) THEN
        RAISE EXCEPTION 'social account grant % workspace % does not belong to client % — the tenant scope chain cannot be crossed',
            NEW.grant_id, NEW.workspace_id, NEW.client_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS social_account_grant_scope_consistent_trigger ON social_account_grants;
CREATE TRIGGER social_account_grant_scope_consistent_trigger
    BEFORE INSERT OR UPDATE OF integration_connection_id, agency_id, client_id, platform_id, workspace_id ON social_account_grants
    FOR EACH ROW EXECUTE FUNCTION social_account_grant_scope_consistent();

-- GRANT-ROW DISCIPLINE (the migration 005/029 immutability pattern, made
-- append-only): identity facts (the integration reference, the scope
-- chain, the platform, the state token, the requested scopes, the start
-- provenance) are IMMUTABLE through ANY mutation path. The ONLY
-- sanctioned UPDATEs are:
--   1. THE COMPLETION FILL: pending → authorized, filling exactly-once
--      the nullable completion facts (account binding, credential
--      reference, expiry, completion provenance). The fill can never run
--      twice, never rewrite a filled fact and never touch a consumed
--      round.
--   2. THE NARROW LIFECYCLE TRANSITION: the grant_state move (+ the
--      successor link, updated_at, CAS version) under the frozen
--      transition table.
CREATE OR REPLACE FUNCTION social_account_grant_row_disciplined() RETURNS trigger AS $$
BEGIN
    IF NEW.grant_id <> OLD.grant_id THEN
        RAISE EXCEPTION 'grant_id % is immutable', OLD.grant_id;
    END IF;
    IF NEW.integration_connection_id <> OLD.integration_connection_id
       OR NEW.agency_id <> OLD.agency_id OR NEW.client_id <> OLD.client_id
       OR NEW.platform_id <> OLD.platform_id THEN
        RAISE EXCEPTION 'social account grant % identity/scope columns are immutable',
            OLD.grant_id;
    END IF;
    IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
        RAISE EXCEPTION 'social account grant % authorize-start workspace attachment is immutable',
            OLD.grant_id;
    END IF;
    IF NEW.state_token <> OLD.state_token
       OR NEW.requested_scopes IS DISTINCT FROM OLD.requested_scopes THEN
        RAISE EXCEPTION 'social account grant % authorize-start facts are immutable',
            OLD.grant_id;
    END IF;
    IF NEW.started_by_actor <> OLD.started_by_actor
       OR NEW.started_via <> OLD.started_via
       OR NEW.started_correlation_id <> OLD.started_correlation_id
       OR NEW.started_causation_id IS DISTINCT FROM OLD.started_causation_id
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'social account grant % start provenance is immutable',
            OLD.grant_id;
    END IF;

    IF OLD.grant_state = 'pending' AND NEW.grant_state = 'authorized' THEN
        -- THE COMPLETION FILL (exactly once, from pending only): every
        -- completion fact must be ARRIVING; a filled fact can never be
        -- re-filled or rewritten, and the expected account of a
        -- reauthorize round can never be re-bound.
        IF OLD.social_account_id IS NOT NULL AND NEW.social_account_id <> OLD.social_account_id THEN
            RAISE EXCEPTION 'social account grant % cannot re-bind its expected account (was %)',
                OLD.grant_id, OLD.social_account_id;
        END IF;
        IF OLD.credential_reference_id IS NOT NULL OR OLD.expires_at IS NOT NULL
           OR OLD.completed_at IS NOT NULL OR OLD.successor_grant_id IS NOT NULL THEN
            RAISE EXCEPTION 'social account grant % was already completed — the completion fill runs exactly once',
                OLD.grant_id;
        END IF;
        IF NEW.successor_grant_id IS NOT NULL THEN
            RAISE EXCEPTION 'social account grant % cannot name a successor at completion time',
                OLD.grant_id;
        END IF;
        IF NEW.social_account_id IS NULL OR NEW.credential_reference_id IS NULL
           OR NEW.completed_at IS NULL OR NEW.completed_by_actor IS NULL
           OR NEW.completed_via IS NULL OR NEW.completed_correlation_id IS NULL THEN
            RAISE EXCEPTION 'social account grant % completion fill is incomplete',
                OLD.grant_id;
        END IF;
        RETURN NEW;
    END IF;

    -- THE RECORDED-FACT IMMUTABILITY (every OTHER update — same-state
    -- rewrites included): only the grant_state, the successor link and
    -- the CAS bookkeeping columns may ever change after the completion
    -- fill; the recorded authorization facts are immutable.
    IF NEW.social_account_id IS DISTINCT FROM OLD.social_account_id
       OR NEW.credential_reference_id IS DISTINCT FROM OLD.credential_reference_id
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
       OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
       OR NEW.completed_by_actor IS DISTINCT FROM OLD.completed_by_actor
       OR NEW.completed_via IS DISTINCT FROM OLD.completed_via
       OR NEW.completed_correlation_id IS DISTINCT FROM OLD.completed_correlation_id
       OR NEW.completed_causation_id IS DISTINCT FROM OLD.completed_causation_id THEN
        RAISE EXCEPTION 'social account grant % recorded authorization facts are immutable — refresh/reauthorize appends NEW records',
            OLD.grant_id;
    END IF;

    -- THE NARROW LIFECYCLE TRANSITION (any state/successor move):
    IF OLD.grant_state <> NEW.grant_state
       OR NEW.successor_grant_id IS DISTINCT FROM OLD.successor_grant_id THEN
        -- THE FROZEN GRANT TRANSITION TABLE (MKT-055 AC-2): pending →
        -- authorized | expired | revoked ; authorized → expired | revoked |
        -- refreshed | superseded ; expired → refreshed | superseded |
        -- revoked ; revoked / refreshed / superseded are TERMINAL.
        DECLARE
            v_legal text[];
        BEGIN
            CASE OLD.grant_state
                WHEN 'pending'    THEN v_legal := ARRAY['authorized', 'expired', 'revoked'];
                WHEN 'authorized' THEN v_legal := ARRAY['expired', 'revoked', 'refreshed', 'superseded'];
                WHEN 'expired'    THEN v_legal := ARRAY['refreshed', 'superseded', 'revoked'];
                ELSE v_legal := ARRAY[]::text[];
            END CASE;
            IF NOT (NEW.grant_state = ANY(v_legal)) THEN
                RAISE EXCEPTION 'illegal social account grant transition % -> % on grant %',
                    OLD.grant_state, NEW.grant_state, OLD.grant_id;
            END IF;
            -- A refresh/supersede move MUST name its successor.
            IF NEW.grant_state IN ('refreshed', 'superseded') AND NEW.successor_grant_id IS NULL THEN
                RAISE EXCEPTION 'social account grant % moved to % without a successor link',
                    OLD.grant_id, NEW.grant_state;
            END IF;
        END;
        RETURN NEW;
    END IF;

    -- Any other UPDATE (same state, same successor): only the CAS
    -- bookkeeping columns may change — nothing else exists to change.
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS social_account_grant_row_disciplined_trigger ON social_account_grants;
CREATE TRIGGER social_account_grant_row_disciplined_trigger
    BEFORE UPDATE ON social_account_grants
    FOR EACH ROW EXECUTE FUNCTION social_account_grant_row_disciplined();

-- NO DELETE on grants: the authorization history is never erased (the
-- append-only discipline; corrections are NEW records).
CREATE OR REPLACE FUNCTION social_account_grants_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'social account grants are append-oriented history: DELETE is rejected on grant %',
        OLD.grant_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS social_account_grants_no_delete_trigger ON social_account_grants;
CREATE TRIGGER social_account_grants_no_delete_trigger
    BEFORE DELETE ON social_account_grants
    FOR EACH ROW EXECUTE FUNCTION social_account_grants_no_delete();

-- ---------------------------------------------------------------------------
-- social_account_events — the append-only authorization-grant/history tail
-- ---------------------------------------------------------------------------

-- The frozen history-event vocabulary: one row per lifecycle fact, with
-- the initiation source (operator | external-signal) and a bounded human
-- reason. UPDATE and DELETE are rejected outright — not even server code
-- can rewrite authorization history.
CREATE TABLE IF NOT EXISTS social_account_events (
    event_id               uuid        PRIMARY KEY,
    -- The account the event belongs to (NULL only for authorize-started
    -- events of fresh rounds that have no binding yet).
    social_account_id      uuid        REFERENCES social_accounts(social_account_id),
    -- The grant the event belongs to (NULL for account-level events).
    grant_id               uuid        REFERENCES social_account_grants(grant_id),
    event_type             text        NOT NULL
                            CHECK (event_type IN (
                                'authorization_started',
                                'authorization_completed',
                                'authorization_expired',
                                'authorization_revoked',
                                'grant_refreshed',
                                'grant_superseded',
                                'account_disconnected',
                                'account_revoked')),
    initiated_by           text        NOT NULL
                            CHECK (initiated_by IN ('operator', 'external-signal')),
    reason                 text
                            CHECK (reason IS NULL
                                   OR (length(reason) >= 1 AND length(reason) <= 2000)),
    -- The best-effort provider-side revocation outcome recorded on
    -- disconnect/revocation events (NULL elsewhere): 'not-requested' |
    -- 'revoked' | 'skipped-policy-denied' | 'failed' — disclosure, never
    -- authority (the MOS-side fail-closed state is the event itself).
    provider_revoke_outcome text
                            CHECK (provider_revoke_outcome IS NULL
                                   OR provider_revoke_outcome IN (
                                       'not-requested', 'revoked',
                                       'skipped-policy-denied', 'failed')),
    recorded_actor         text        NOT NULL
                            CHECK (length(recorded_actor) >= 1
                                   AND length(recorded_actor) <= 100),
    recorded_via           text        NOT NULL
                            CHECK (length(recorded_via) >= 1
                                   AND length(recorded_via) <= 100),
    correlation_id         text        NOT NULL,
    causation_id           text,
    recorded_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT social_account_event_anchor CHECK (
        social_account_id IS NOT NULL OR grant_id IS NOT NULL
    )
);

-- Listing surfaces: the account's history tail (oldest first) and the
-- grant's event stream.
CREATE INDEX IF NOT EXISTS social_account_events_account_idx
    ON social_account_events (social_account_id, recorded_at, event_id)
    WHERE social_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS social_account_events_grant_idx
    ON social_account_events (grant_id, recorded_at, event_id)
    WHERE grant_id IS NOT NULL;

-- APPEND-ONLY TAIL (the migration 015/018/025/044 pattern): the database
-- itself rejects UPDATE and DELETE — the raw authorization history is
-- durable exactly as recorded.
CREATE OR REPLACE FUNCTION social_account_events_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'social account events are append-only: % is rejected on event %',
        TG_OP, OLD.event_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS social_account_events_append_only_update_trigger ON social_account_events;
CREATE TRIGGER social_account_events_append_only_update_trigger
    BEFORE UPDATE ON social_account_events
    FOR EACH ROW EXECUTE FUNCTION social_account_events_append_only();

DROP TRIGGER IF EXISTS social_account_events_append_only_delete_trigger ON social_account_events;
CREATE TRIGGER social_account_events_append_only_delete_trigger
    BEFORE DELETE ON social_account_events
    FOR EACH ROW EXECUTE FUNCTION social_account_events_append_only();

-- ---------------------------------------------------------------------------
-- social_account_grant_scopes — the scope records (verbatim + normalized)
-- ---------------------------------------------------------------------------

-- The EXACT granted scope list (kind 'granted-scope', order preserved by
-- position — recorded VERBATIM from the authorization outcome, never
-- normalized, never assumed) plus the platform-normalized CAPABILITY TAGS
-- (kind 'capability-tag'). Append-only: the records of one grant's
-- authorization facts are never rewritten (a changed grant is a NEW grant
-- with NEW scope records — architecture-lock-v1.6 rule 19: capability
-- parity is never assumed; this is a RECORD, not a promise).
CREATE TABLE IF NOT EXISTS social_account_grant_scopes (
    grant_id               uuid        NOT NULL REFERENCES social_account_grants(grant_id),
    -- The frozen two-kind scope-record vocabulary.
    scope_kind              text        NOT NULL
                            CHECK (scope_kind IN ('granted-scope', 'capability-tag')),
    -- The EXACT scope string (verbatim for granted-scope; the normalized
    -- platform tag for capability-tag).
    scope_value             text        NOT NULL
                            CHECK (length(scope_value) >= 1
                                   AND length(scope_value) <= 256),
    -- The position within the recorded list (order preservation).
    position                integer     NOT NULL CHECK (position >= 0 AND position <= 255),
    CONSTRAINT social_account_grant_scopes_pk
        PRIMARY KEY (grant_id, scope_kind, position)
);

-- The verification path: all scope records of one grant.
CREATE INDEX IF NOT EXISTS social_account_grant_scopes_grant_idx
    ON social_account_grant_scopes (grant_id);

-- APPEND-ONLY (the tail discipline): scope records are the verbatim
-- authorization facts — UPDATE and DELETE are rejected outright.
CREATE OR REPLACE FUNCTION social_account_grant_scopes_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'social account grant scopes are append-only: % is rejected on grant % scope record',
        TG_OP, OLD.grant_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS social_account_grant_scopes_append_only_update_trigger ON social_account_grant_scopes;
CREATE TRIGGER social_account_grant_scopes_append_only_update_trigger
    BEFORE UPDATE ON social_account_grant_scopes
    FOR EACH ROW EXECUTE FUNCTION social_account_grant_scopes_append_only();

DROP TRIGGER IF EXISTS social_account_grant_scopes_append_only_delete_trigger ON social_account_grant_scopes;
CREATE TRIGGER social_account_grant_scopes_append_only_delete_trigger
    BEFORE DELETE ON social_account_grant_scopes
    FOR EACH ROW EXECUTE FUNCTION social_account_grant_scopes_append_only();
