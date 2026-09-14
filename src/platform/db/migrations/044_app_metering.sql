-- 044_app_metering.sql — MKT-052 (App Metering and Commercial
-- Attribution).
--
-- The App METERING LEDGER (the mos-app-ecosystem-v1.5.md "Economics"
-- authority: "MOS may meter installations, invocation count,
-- compute/runtime, data volume and premium capabilities. Marketplace
-- attribution is separate from the core financial authority."):
--
--   app_metering_events  → the APPEND-ONLY METER EVENT TAIL (one row per
--                          metered usage observation — installation
--                          selections, invocations and observed usage —
--                          with the frozen five-dimension vocabulary, the
--                          per-dimension unit fence, the canonical source
--                          references, the correlation metadata and the
--                          §8 logical-command identity; UPDATE and DELETE
--                          are rejected outright — corrections are NEW
--                          records, never rewrites);
--   app_metering_rollups → the REBUILDABLE period materialization (the
--                          derived (workspace, app, dimension, month)
--                          aggregates over the tail — a PROJECTION, not a
--                          second truth: every row is rebuildable from the
--                          tail by the disclosed recompute path, which
--                          replaces the whole table atomically inside ONE
--                          transaction).
--
-- Frozen semantics encoded here (FROZEN — never a caller freedom):
--
-- * THE FIVE SPEC DIMENSIONS + THEIR UNITS (mos-app-ecosystem-v1.5.md
--   "Economics", verbatim): installations (unit 'selections'),
--   invocations (unit 'invocations'), compute-runtime (unit
--   'milliseconds'), data-volume (unit 'bytes') and premium-capabilities
--   (unit 'capability-uses'). A CHECK ties every dimension to EXACTLY its
--   unit — the frozen metering vocabulary (the pi-calc-v1 discipline:
--   versioned in code as am-meter-v1, never silently re-stated here).
-- * METERING IS OBSERVATION, NOT BILLING (architecture-lock v1.5 #6's
--   financial-authority posture; the Economics rule): there is
--   deliberately NO price, rate, amount, currency, charge, invoice,
--   payment or balance column ANYWHERE in this migration — the tail
--   meters usage counts; commercial MONETIZATION stays with the core
--   financial authority (a future, separately-governed surface). Static
--   boundary tests prove the absence.
-- * CANONICAL SOURCE REFERENCES (AC-6 provenance): every meter event
--   cites its source (source_kind + source_id + source_link_id) — an
--   MKT-048 install-ledger selection row (+ its lifecycle event id), an
--   MKT-022 extension-invocation ledger row (+ its execution id), or a
--   runtime-host usage observation (validated against a real invocation
--   row). A trigger re-verifies the app identity against the immutable
--   migration-037 registry and the extension identity against the
--   migration-028 registry (read CHECK-ONLY — no registry row is ever
--   created or mutated here).
-- * APP IDENTITY IS A FACT, ATTRIBUTION IS A DERIVATION: the app columns
--   (app_key, app_version_id, version) carry the observation's OWN app
--   identity ONLY where the observed fact includes it (installation
--   selections and usage observations); invocation meter events carry the
--   RAW extension facts (extension_id/key/publisher/version) instead —
--   app attribution of invocations is a VIEW-TIME derivation under the
--   disclosed, versioned assumption set (am-attrib-v1), never materialized
--   into the append-only tail.
-- * AT-MOST-ONCE METERING OF COLLECTED SOURCES: a partial UNIQUE fence
--   guarantees each MKT-048 install-selection row and each MKT-022
--   invocation row is metered AT MOST ONCE per dimension — re-collection
--   converges (zero new rows), even under concurrency.
-- * §8 COMMAND CONVERGENCE: (workspace_id, idempotency_key) is UNIQUE —
--   one logical metering command per workspace. The collection commands
--   use the RESERVED deterministic prefix 'collect:' (re-fenced by the
--   module guard); ingestion keys may not take it.
-- * WORKSPACE-SCOPED, SCOPE-CHAIN-FENCED (the migration 003/004/038
--   pattern): agency/client/workspace are server-derived at metering time
--   and immutable; the tenant fence trigger rejects a crossed scope chain.
-- * PERIOD ATTRIBUTION USES THE SOURCE'S OWN TIME: occurred_at (the
--   source event's timestamp) — NOT the meter recording time — is the
--   period-bucketing basis (an event metered late still counts in the
--   period it happened; disclosed in the assumption set).
-- * NO SECRET MATERIAL ANYWHERE (CRED-001/§21): the only structured
--   payload columns are the closed-vocabulary dimension/unit pair and the
--   bounded capability/state-namespace labels — there is deliberately NO
--   column capable of holding secret material, a secret handle or any
--   free-form caller payload.
-- * NO AUTHORITY TRANSFER (architecture-lock v1.5 #7/#13; the Economics
--   rule "Marketplace attribution is separate from the core financial
--   authority"): this migration creates NO billing, invoice, payment,
--   balance, registry, install, invocation, workflow, execution, evidence,
--   policy or tenant table — the tail is metering observations only, the
--   rollups are derived aggregates, and every catalog/lifecycle fact
--   arrives read-only through the /apps, /app-installs and /extensions
--   public contracts.
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, occurred_at/recorded_at, §8-style idempotency keys +
-- create fingerprints for logical-command convergence. No owner/role/user
-- columns beyond provenance: attribution-read authorization stays exactly
-- the /agencies membership + platform-role authorities resolved at the
-- route layer — no second tenant, permission or identity authority.

-- ---------------------------------------------------------------------------
-- Shape validators (IMMUTABLE so they can serve CHECK constraints)
-- ---------------------------------------------------------------------------

-- The frozen five-dimension metering vocabulary with the per-dimension
-- unit fence (mos-app-ecosystem-v1.5.md "Economics", verbatim — the SAME
-- closed dimension set the migration-037 manifest registry CHECK-fences
-- on meteringDimensions declarations). The vocabulary version is the
-- code-side am-meter-v1 constant; the CHECK is its storage-layer mirror.
CREATE OR REPLACE FUNCTION app_metering_dimension_unit_valid(dimension text, unit text)
RETURNS boolean AS $$
BEGIN
    RETURN (dimension = 'installations' AND unit = 'selections')
        OR (dimension = 'invocations' AND unit = 'invocations')
        OR (dimension = 'compute-runtime' AND unit = 'milliseconds')
        OR (dimension = 'data-volume' AND unit = 'bytes')
        OR (dimension = 'premium-capabilities' AND unit = 'capability-uses');
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ---------------------------------------------------------------------------
-- app_metering_events — the append-only meter event tail
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS app_metering_events (
    event_id         uuid        PRIMARY KEY,
    -- The frozen five-dimension metering vocabulary (the Economics rule,
    -- verbatim) with the per-dimension unit fence.
    dimension        text        NOT NULL
                     CHECK (dimension IN ('installations', 'invocations', 'compute-runtime', 'data-volume', 'premium-capabilities')),
    unit             text        NOT NULL
                     CHECK (app_metering_dimension_unit_valid(dimension, unit)),
    quantity         bigint      NOT NULL CHECK (quantity >= 1),
    -- The metering scope chain (SERVER-DERIVED at metering time, immutable).
    agency_id        uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id        uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id     uuid        NOT NULL REFERENCES workspaces(workspace_id),
    -- The observation's OWN app identity: present ONLY where the observed
    -- fact includes it (installation selections + usage observations);
    -- NULL for invocation observations (attribution is a view-time
    -- derivation — never materialized on the append-only tail). All three
    -- columns are set or cleared together.
    app_key          text
                     CHECK (app_key IS NULL OR app_key ~ '^[a-z][a-z0-9-]{1,62}$'),
    app_version_id   uuid        REFERENCES app_versions(app_version_id),
    version          text
                     CHECK (version IS NULL OR version ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]{1,32})?$'),
    -- The RAW extension facts of an invocation observation (present ONLY
    -- for source_kind 'extension-invocation' — re-verified against the
    -- immutable migration-028 registry by trigger below).
    extension_id     uuid        REFERENCES extensions(extension_id),
    extension_key    text,
    extension_publisher text
                     CHECK (extension_publisher IS NULL OR (length(extension_publisher) >= 1 AND length(extension_publisher) <= 64)),
    extension_version   text
                     CHECK (extension_version IS NULL OR extension_version ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]{1,32})?$'),
    -- The observation's structured usage facts: the capability label of a
    -- premium-capability observation; the bounded app-state namespace of
    -- a data-volume observation (NULL = payload I/O without a namespace).
    capability       text
                     CHECK (capability IS NULL OR (capability ~ '^[a-z][a-z0-9-]{0,63}$' AND length(capability) <= 64)),
    state_namespace  text
                     CHECK (state_namespace IS NULL OR state_namespace ~ '^app:[a-z][a-z0-9-]{1,62}:[a-z][a-z0-9-]{1,30}$'),
    -- The canonical source references (AC-6): which real event/record the
    -- meter event was collected from. source_id = the primary canonical
    -- record id; source_link_id = the secondary canonical reference (the
    -- install lifecycle event id / the invocation's execution id).
    source_kind      text        NOT NULL
                     CHECK (source_kind IN ('app-install-selection', 'extension-invocation', 'observed-usage')),
    source_id        text        NOT NULL
                     CHECK (length(source_id) >= 1 AND length(source_id) <= 200),
    source_link_id   text
                     CHECK (source_link_id IS NULL OR (length(source_link_id) >= 1 AND length(source_link_id) <= 200)),
    -- The source event's OWN time — the period-bucketing basis (an event
    -- metered late still counts in the period it happened).
    occurred_at      timestamptz NOT NULL,
    -- SERVER-DERIVED provenance (never a request field).
    recorded_actor   text        NOT NULL
                     CHECK (length(recorded_actor) >= 1 AND length(recorded_actor) <= 100),
    recorded_via     text        NOT NULL
                     CHECK (length(recorded_via) >= 1 AND length(recorded_via) <= 100),
    correlation_id   text        NOT NULL,
    causation_id     text,
    recorded_at      timestamptz NOT NULL DEFAULT now(),
    -- The §8-style logical command identity + create fingerprint
    -- (convergence proof: one logical metering command per workspace; a
    -- key reused for different content is a conflict).
    idempotency_key  text        NOT NULL
                     CHECK (length(idempotency_key) >= 1 AND length(idempotency_key) <= 200),
    create_fingerprint text      NOT NULL
                     CHECK (length(create_fingerprint) >= 1 AND length(create_fingerprint) <= 128),
    -- THE PAYLOAD-SHAPE FENCE (the frozen per-source event shapes):
    --   * an install-selection meter event is ALWAYS an 'installations'
    --     observation carrying its app identity and the lifecycle event
    --     link, never extension/capability/namespace facts;
    --   * an invocation meter event is ALWAYS an 'invocations'
    --     observation carrying the four extension facts and the execution
    --     link, never app identity or capability/namespace facts;
    --   * an observed-usage event is ALWAYS one of the three usage
    --     dimensions, carries its app identity and the invocation source
    --     link, never extension facts; a premium-capability observation
    --     carries its capability; a compute-runtime observation carries
    --     neither capability nor namespace.
    CONSTRAINT app_metering_event_shape CHECK (
        (source_kind = 'app-install-selection'
           AND dimension = 'installations'
           AND app_key IS NOT NULL AND app_version_id IS NOT NULL AND version IS NOT NULL
           AND extension_id IS NULL AND extension_key IS NULL
           AND extension_publisher IS NULL AND extension_version IS NULL
           AND capability IS NULL AND state_namespace IS NULL
           AND source_link_id IS NOT NULL)
        OR (source_kind = 'extension-invocation'
           AND dimension = 'invocations'
           AND app_key IS NULL AND app_version_id IS NULL AND version IS NULL
           AND extension_id IS NOT NULL AND extension_key IS NOT NULL
           AND extension_publisher IS NOT NULL AND extension_version IS NOT NULL
           AND capability IS NULL AND state_namespace IS NULL
           AND source_link_id IS NOT NULL)
        OR (source_kind = 'observed-usage'
           AND dimension IN ('compute-runtime', 'data-volume', 'premium-capabilities')
           AND app_key IS NOT NULL AND app_version_id IS NOT NULL AND version IS NOT NULL
           AND extension_id IS NULL AND extension_key IS NULL
           AND extension_publisher IS NULL AND extension_version IS NULL
           AND source_link_id IS NOT NULL
           AND ((dimension = 'premium-capabilities' AND capability IS NOT NULL)
                OR (dimension <> 'premium-capabilities' AND capability IS NULL))
           AND (dimension <> 'compute-runtime' OR state_namespace IS NULL))
    )
);

-- The §8 command fence: one logical metering command key per workspace.
CREATE UNIQUE INDEX IF NOT EXISTS app_metering_events_idempotency_key_unique
    ON app_metering_events (workspace_id, idempotency_key);

-- THE AT-MOST-ONCE METERING FENCE for collected sources: each MKT-048
-- install-selection row and each MKT-022 invocation row is metered AT
-- MOST ONCE per dimension — re-collection converges (zero new rows),
-- even under concurrent collectors (the second writer hits the fence).
-- Observed-usage events are EXEMPT (each is its own §8 logical command —
-- the runtime host may legitimately observe multiple usage records
-- against one source record across dimensions and commands).
CREATE UNIQUE INDEX IF NOT EXISTS app_metering_events_source_once_fence
    ON app_metering_events (source_kind, source_id, dimension)
    WHERE source_kind IN ('app-install-selection', 'extension-invocation');

-- Listing surfaces: the workspace tail (oldest first), the agency slice,
-- the per-app slice and the per-dimension period scan (the rollup
-- recompute's GROUP BY path).
CREATE INDEX IF NOT EXISTS app_metering_events_workspace_idx
    ON app_metering_events (workspace_id, occurred_at, event_id);
CREATE INDEX IF NOT EXISTS app_metering_events_agency_idx
    ON app_metering_events (agency_id, occurred_at, event_id);
CREATE INDEX IF NOT EXISTS app_metering_events_app_idx
    ON app_metering_events (app_key) WHERE app_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS app_metering_events_period_idx
    ON app_metering_events (workspace_id, dimension, occurred_at);
CREATE INDEX IF NOT EXISTS app_metering_events_extension_idx
    ON app_metering_events (extension_id) WHERE extension_id IS NOT NULL;

-- TENANT FENCE (the migration 003/004/038 pattern): a meter event's
-- workspace must belong to its client and its client to its agency — the
-- scope chain cannot be crossed even if every application check were
-- bypassed.
CREATE OR REPLACE FUNCTION app_metering_scope_chain_consistent() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM clients c
        WHERE c.client_id = NEW.client_id AND c.agency_id = NEW.agency_id) THEN
        RAISE EXCEPTION 'app metering scope: client % does not belong to agency % — the tenant scope chain cannot be crossed',
            NEW.client_id, NEW.agency_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM workspaces w
        WHERE w.workspace_id = NEW.workspace_id AND w.client_id = NEW.client_id) THEN
        RAISE EXCEPTION 'app metering scope: workspace % does not belong to client % — the tenant scope chain cannot be crossed',
            NEW.workspace_id, NEW.client_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS app_metering_scope_chain_trigger ON app_metering_events;
CREATE TRIGGER app_metering_scope_chain_trigger
    BEFORE INSERT OR UPDATE OF agency_id, client_id, workspace_id ON app_metering_events
    FOR EACH ROW EXECUTE FUNCTION app_metering_scope_chain_consistent();

-- CANONICAL IDENTITY RE-VERIFICATION (the storage-layer fence of the
-- source references — the migration 038 exact-version pattern): where a
-- meter event carries an app identity, the pinned (app_key, version,
-- app_version_id) triple must match the immutable migration-037 registry
-- row EXACTLY; where it carries an extension identity, the four
-- extension facts must match the immutable migration-028 registry row.
-- The registries are read CHECK-ONLY: no app_versions or extensions row
-- is ever created or mutated here.
CREATE OR REPLACE FUNCTION app_metering_identity_consistent() RETURNS trigger AS $$
DECLARE
    v_app_key text;
    v_version text;
    v_ext_key text;
    v_ext_publisher text;
    v_ext_version text;
BEGIN
    IF NEW.app_version_id IS NOT NULL THEN
        SELECT app_key, version INTO v_app_key, v_version
          FROM app_versions WHERE app_version_id = NEW.app_version_id;
        IF v_app_key IS NULL THEN
            RAISE EXCEPTION 'app metering event % references an unknown app version %',
                NEW.event_id, NEW.app_version_id;
        END IF;
        IF v_app_key <> NEW.app_key OR v_version <> NEW.version THEN
            RAISE EXCEPTION 'app metering event % pins (%@%) but the registry version % is %@% — the exact-version identity must match the immutable registry',
                NEW.event_id, NEW.app_key, NEW.version, NEW.app_version_id, v_app_key, v_version;
        END IF;
    END IF;
    IF NEW.extension_id IS NOT NULL THEN
        SELECT extension_key, publisher, version
          INTO v_ext_key, v_ext_publisher, v_ext_version
          FROM extensions WHERE extension_id = NEW.extension_id;
        IF v_ext_key IS NULL THEN
            RAISE EXCEPTION 'app metering event % references an unknown extension version %',
                NEW.event_id, NEW.extension_id;
        END IF;
        IF v_ext_key <> NEW.extension_key OR v_ext_publisher <> NEW.extension_publisher
           OR v_ext_version <> NEW.extension_version THEN
            RAISE EXCEPTION 'app metering event % pins extension %@% but the registry version % is %@% — the extension identity must match the immutable registry',
                NEW.event_id, NEW.extension_key, NEW.extension_publisher, NEW.extension_id, v_ext_key, v_ext_version;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS app_metering_identity_trigger ON app_metering_events;
CREATE TRIGGER app_metering_identity_trigger
    BEFORE INSERT ON app_metering_events
    FOR EACH ROW EXECUTE FUNCTION app_metering_identity_consistent();

-- APPEND-ONLY TAIL (the migration 036/038 event-tail pattern): the
-- database itself rejects UPDATE and DELETE on the meter event tail —
-- not even server code can rewrite metering history. Corrections are NEW
-- records (a restatement is a new event; interpretation belongs to the
-- versioned attribution derivation, never to a rewrite).
CREATE OR REPLACE FUNCTION app_metering_events_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'app metering events are append-only: % is rejected on event %',
        TG_OP, OLD.event_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS app_metering_events_append_only_update_trigger ON app_metering_events;
CREATE TRIGGER app_metering_events_append_only_update_trigger
    BEFORE UPDATE ON app_metering_events
    FOR EACH ROW EXECUTE FUNCTION app_metering_events_append_only();

DROP TRIGGER IF EXISTS app_metering_events_append_only_delete_trigger ON app_metering_events;
CREATE TRIGGER app_metering_events_append_only_delete_trigger
    BEFORE DELETE ON app_metering_events
    FOR EACH ROW EXECUTE FUNCTION app_metering_events_append_only();

-- ---------------------------------------------------------------------------
-- app_metering_rollups — the rebuildable period materialization
-- ---------------------------------------------------------------------------

-- A DERIVED PROJECTION, never a second truth: every row is the (agency,
-- client, workspace, app-or-unattributed, dimension, unit, month) GROUP
-- BY aggregate over the append-only tail, replaceable atomically by the
-- DISCLOSED recompute path (the module's recomputeAttributionRollups:
-- DELETE + INSERT ... SELECT inside ONE transaction). app_key '' is the
-- unattributed bucket (invocation observations whose app attribution is
-- a view-time derivation — disclosed). There is deliberately NO
-- append-only trigger here: the materialization is REPLACED by design;
-- the tail remains the sole source of truth and any rollup row is
-- rebuildable from it.
CREATE TABLE IF NOT EXISTS app_metering_rollups (
    agency_id        uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id        uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id     uuid        NOT NULL REFERENCES workspaces(workspace_id),
    -- '' = the unattributed bucket (raw invocation observations); any
    -- other value is the app key the aggregate attributes to.
    app_key          text        NOT NULL
                     CHECK (app_key = '' OR app_key ~ '^[a-z][a-z0-9-]{1,62}$'),
    dimension        text        NOT NULL
                     CHECK (dimension IN ('installations', 'invocations', 'compute-runtime', 'data-volume', 'premium-capabilities')),
    unit             text        NOT NULL
                     CHECK (app_metering_dimension_unit_valid(dimension, unit)),
    -- The UTC calendar-month bucket start of the aggregate period.
    period_start     timestamptz NOT NULL,
    quantity_sum     bigint      NOT NULL CHECK (quantity_sum >= 0),
    event_count      integer     NOT NULL CHECK (event_count >= 0),
    -- The recompute stamp (the materialization's generation marker; the
    -- aggregate columns themselves are deterministic from the tail).
    rebuilt_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT app_metering_rollups_pk
        PRIMARY KEY (workspace_id, app_key, dimension, period_start)
);

-- The recompute scan path (workspace-major, period-ordered).
CREATE INDEX IF NOT EXISTS app_metering_rollups_period_idx
    ON app_metering_rollups (workspace_id, period_start);
CREATE INDEX IF NOT EXISTS app_metering_rollups_agency_idx
    ON app_metering_rollups (agency_id, period_start);
