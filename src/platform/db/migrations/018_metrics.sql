-- MKT-014 Metric normalization schema (METRIC-001; the INT-001 posture is
-- NEGATIVE here: provider data ARRIVES as already-normalized, source-tagged
-- observations — /metrics owns NO provider state).
-- PostgreSQL is the system of record (spec/architecture-lock.md).

-- Table ownership follows the frozen authority map (implementation-contract §1):
-- metric_observations → /metrics (Metrics)

-- Frozen semantics encoded here (spec/architecture.md §16 "Metrics are
-- observations"; spec/architecture.md §2.6 scientific separation;
-- spec/implementation-contract.md §15 "A Metric Observation contains: metric
-- definition; value + unit; dimension keys; event/observation timestamp;
-- source system; retrieval timestamp; source record/reference; aggregation
-- method; data-quality status"):

-- * METRIC IDENTITY: metric_name + the dimension key set (dimensions) — the
--   identity of the measured series (METRIC-001 "metric identity/name +
--   dimensions"). A dimensionless row ('{}') is a valid total.
-- * VALUE + UNIT: the measured value with its declared unit.
-- * SOURCE/TIMESTAMP/REFERENCE MAPPING (the MKT-014 acceptance): every row
--   carries source_system (provider label or 'internal'), an optional
--   source_ref (provider report id), the OBSERVATION timestamp observed_at
--   (when the metric was true) kept DISTINCT from the RETRIEVAL timestamp
--   retrieved_at (when the platform saw it) — two separate NOT NULL columns
--   so observation time can never collapse into retrieval time — and a
--   reference to the source record: source_ref for provider reports or
--   evidence_ref (FK to evidence) for internal observations backed by the
--   /evidence authority (MKT-013).
-- * DATA-QUALITY POSTURE: quality is a closed 5-value set (ok, partial,
--   estimated, restated, suspect) — interpretable and traceable, extensible
--   only through a code+DB migration change (never a caller freedom);
--   aggregation_method is the optional declared rollup semantics (§15
--   "aggregation method").
-- * PROVENANCE IS SERVER-DERIVED (implementation-contract §3: "No externally
--   supplied field may override a server-derived actor, owner, provenance,
--   policy decision, or evidence authority value"): recorded_actor,
--   recorded_via, correlation_id, causation_id and recorded_at are written
--   exclusively by server code — there is no request DTO path to them (route
--   validation rejects provenance-shaped keys AND the retrieval timestamp;
--   the module API takes provenance as a separate server-built argument).
-- * APPEND-ORIENTED, IMMUTABLE (METRIC-001 acceptance: "observations are
--   append-oriented (immutable rows; corrections are new rows)"): rows are
--   written exactly once. A BEFORE UPDATE OR DELETE trigger rejects every
--   mutation (the migration 015 evidence_append_only pattern). Corrections
--   are NEW rows — e.g. a restated observation is a fresh row with
--   quality='restated' carrying the same metric identity; nothing is ever
--   overwritten. There is deliberately NO supersession fence here: the
--   metric ledger records every observation as-is; interpretation and
--   supersession semantics belong to later analysis (MKT-015+), not to the
--   measurement authority.
-- * CLIENT OWNERSHIP (TENANT-003 hard boundary): client_id is NOT NULL and
--   part of the immutable row. There is deliberately NO ON DELETE CASCADE:
--   observations are immutable measurement history, so a hard client delete
--   is rejected by the append-only trigger instead of erasing the trail
--   (clients are soft-tombstoned in practice; the FK plain-restrict is the
--   belt-and-suspenders history backstop).
-- * NO PROVIDER STATE: no provider sessions, no provider cursors, no
--   credentials, no SDK-shaped columns — provider adapters arrive with
--   MKT-023/024 behind /integrations and stay outside this table (INT-001).
-- * WORKSPACE SCOPE: an optional organizational refinement INSIDE the owning
--   Client; the database itself rejects a workspace that does not belong to
--   the record's Client (trigger — the migration 015 pattern), so the Client
--   boundary cannot be crossed through the workspace column.
-- * EVIDENCE LINKAGE: an observation MAY reference an /evidence record
--   (evidence_ref, FK to evidence(evidence_id)); the database rejects a
--   reference to another Client's evidence (trigger — cross-tenant
--   rejection). /metrics imports no evidence internals; this is the only
--   structural coupling, backstopped here.

-- No owner/role/user columns: authorization stays exactly the /agencies
-- membership authority composed with /clients canonical owner resolution
-- (and /workspaces canonical ownership for the optional scope) — no second
-- tenant/permission authority (frozen matrix: /metrics ──→ /evidence,
-- /integrations; the /clients and /workspaces canonical ownership instances
-- are injected through /metrics' declared structural ports at the
-- composition root, so no forbidden module import exists).

CREATE TABLE IF NOT EXISTS metric_observations (
  observation_id     uuid        PRIMARY KEY,
  client_id          uuid        NOT NULL REFERENCES clients(client_id),
  workspace_id       uuid        REFERENCES workspaces(workspace_id),
  metric_name        text        NOT NULL CHECK (length(metric_name) >= 1
                                        AND length(metric_name) <= 200),
  dimensions         jsonb       NOT NULL DEFAULT '{}'::jsonb
                                        CHECK (jsonb_typeof(dimensions) = 'object'),
  value              numeric     NOT NULL,
  unit               text        NOT NULL CHECK (length(unit) >= 1
                                        AND length(unit) <= 64),
  source_system      text        NOT NULL CHECK (length(source_system) >= 1
                                        AND length(source_system) <= 100),
  source_ref         text        CHECK (source_ref IS NULL OR (length(source_ref) >= 1
                                        AND length(source_ref) <= 512)),
  observed_at        timestamptz NOT NULL,
  retrieved_at       timestamptz NOT NULL,
  evidence_ref       uuid        REFERENCES evidence(evidence_id),
  quality            text        NOT NULL CHECK (quality IN ('ok', 'partial',
                                        'estimated', 'restated', 'suspect')),
  aggregation_method text        CHECK (aggregation_method IS NULL
                                        OR (length(aggregation_method) >= 1
                                        AND length(aggregation_method) <= 100)),
  recorded_actor     text        NOT NULL,
  recorded_via       text        NOT NULL CHECK (length(recorded_via) >= 1
                                        AND length(recorded_via) <= 100),
  correlation_id     text        NOT NULL,
  causation_id       text,
  recorded_at        timestamptz NOT NULL DEFAULT now()
);

-- Listing surfaces: one Client's observations (newest first by
-- server-recorded time), the Workspace-scoped subset, and the per-metric
-- time series (identity + observed_at) that later analysis (MKT-015+) reads
-- without becoming an alternate authority.
CREATE INDEX IF NOT EXISTS metric_observations_client_idx
ON metric_observations (client_id, recorded_at, observation_id);

CREATE INDEX IF NOT EXISTS metric_observations_workspace_idx
ON metric_observations (workspace_id) WHERE workspace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS metric_observations_series_idx
ON metric_observations (client_id, metric_name, observed_at);

-- APPEND-ONLY backstop (the migration 015 evidence_append_only pattern): the
-- database itself rejects UPDATE and DELETE on metric observations. Not even
-- server code can rewrite measurement history; corrections can only be NEW
-- rows.
CREATE OR REPLACE FUNCTION metric_observations_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'metric observations are append-only: % is rejected on metric_observation %', TG_OP, OLD.observation_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS metric_observations_append_only_update_trigger ON metric_observations;
CREATE TRIGGER metric_observations_append_only_update_trigger
BEFORE UPDATE ON metric_observations
FOR EACH ROW EXECUTE FUNCTION metric_observations_append_only();

DROP TRIGGER IF EXISTS metric_observations_append_only_delete_trigger ON metric_observations;
CREATE TRIGGER metric_observations_append_only_delete_trigger
BEFORE DELETE ON metric_observations
FOR EACH ROW EXECUTE FUNCTION metric_observations_append_only();

-- Scope backstop (TENANT-003 at the storage layer, migration 015 pattern): a
-- workspace-scoped observation must reference a Workspace of the SAME Client
-- — the Client boundary cannot be crossed through the workspace column even
-- if every application check were bypassed.
CREATE OR REPLACE FUNCTION metric_workspace_within_client() RETURNS trigger AS $$
BEGIN
  IF NEW.workspace_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM workspaces w
        WHERE w.workspace_id = NEW.workspace_id AND w.client_id = NEW.client_id) THEN
      RAISE EXCEPTION 'metric observation % workspace % does not belong to client % — the workspace scope cannot cross the Client boundary',
        NEW.observation_id, NEW.workspace_id, NEW.client_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS metric_workspace_within_client_trigger ON metric_observations;
CREATE TRIGGER metric_workspace_within_client_trigger
BEFORE INSERT OR UPDATE ON metric_observations
FOR EACH ROW EXECUTE FUNCTION metric_workspace_within_client();

-- Evidence-linkage backstop (cross-tenant rejection): an observation MAY
-- reference an /evidence record, but ONLY one owned by the SAME Client —
-- the /evidence authority stays append-only and tenant-fenced even when a
-- metric observation links to it (same-Client enforced; unknown references
-- are rejected too, belt-and-suspenders ahead of the FK).
CREATE OR REPLACE FUNCTION metric_evidence_ref_same_client() RETURNS trigger AS $$
DECLARE
  v_evidence_client uuid;
BEGIN
  IF NEW.evidence_ref IS NOT NULL THEN
    SELECT client_id INTO v_evidence_client FROM evidence WHERE evidence_id = NEW.evidence_ref;
    IF v_evidence_client IS NULL THEN
      RAISE EXCEPTION 'metric observation % references unknown evidence %', NEW.observation_id, NEW.evidence_ref;
    END IF;
    IF v_evidence_client <> NEW.client_id THEN
      RAISE EXCEPTION 'metric observation % evidence_ref % belongs to another client — cross-tenant evidence linkage is rejected',
        NEW.observation_id, NEW.evidence_ref;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS metric_evidence_ref_same_client_trigger ON metric_observations;
CREATE TRIGGER metric_evidence_ref_same_client_trigger
BEFORE INSERT ON metric_observations
FOR EACH ROW EXECUTE FUNCTION metric_evidence_ref_same_client();
