-- MKT-013 Evidence and provenance schema (EVID-001, EVID-AC-01..03).
-- PostgreSQL is the system of record (spec/architecture-lock.md).

-- Table ownership follows the frozen authority map (implementation-contract §1):
-- evidence → /evidence (Evidence/provenance)

-- Frozen semantics encoded here (spec/architecture.md §15 "Evidence records
-- source facts and their provenance and relates them to claims, hypotheses,
-- experiments, outcomes and learnings. Evidence is append-oriented and
-- server-owned."; spec/evidence-and-experimentation.md):

-- * EVIDENCE CLASSES (frozen taxonomy, 8 classes): source_fact,
-- observation, inference, hypothesis, attribution, prediction,
-- causal_estimate, learning. The CHECK enumeration is the closed set —
-- the class of a record is chosen at append and NEVER changes.
-- * AUTHORITY TIERS (EVID-AC-03): source_fact/observation are
-- AUTHORITATIVE classes (directly observed from an authoritative
-- source / normalized measurement from a source); the other six are
-- CLAIM classes (model or human claims: interpretations, hypotheses,
-- credit assignments, forecasts, effect estimates, conclusions).
-- Claims are NEVER auto-promoted to authoritative classes — the DB
-- supersession trigger rejects any superseding record that changes
-- tier, in either direction (no promotion, no authority laundering).
-- * QUALITY TAXONOMY (frozen A..F): a single-letter grade per record —
-- interpretable (every grade has a frozen meaning) and traceable (the
-- grade is stored on the immutable record, next to class and source).
-- * PROVENANCE IS SERVER-DERIVED (implementation-contract §3: "No
-- externally supplied field may override a server-derived actor, owner,
-- provenance, policy decision, or evidence authority value"):
-- recorded_actor, recorded_via, correlation_id, causation_id and
-- recorded_at are written exclusively by server code — there is no
-- request DTO path to them (route validation rejects provenance-shaped
-- keys; the module API takes provenance as a separate server-built
-- argument). Provenance is a SEPARATE dimension from confidence
-- (spec/evidence-and-experimentation.md "Provenance"): the optional
-- confidence score is caller-declared claim metadata that can never
-- touch any provenance column, class or tier.
-- * SOURCE + TIMESTAMP (EVID-AC-01): every record carries a declared
-- source descriptor (source_system + optional source_ref) and the
-- evidence's own observed_at timestamp, next to the traceable content
-- (non-empty jsonb object) and an optional opaque content_ref to a
-- durable artifact.
-- * APPEND-ORIENTED, IMMUTABLE (EVID-AC-02): rows are written exactly
-- once. A BEFORE UPDATE OR DELETE trigger rejects every mutation —
-- not even server-side SQL can rewrite evidence history (the
-- audit_events backstop pattern, migration 006). Corrections and
-- supersession create NEW rows referencing the prior row.
-- * SUPERSESSION GRAPH: supersedes_evidence_id points BACKWARD from a
-- correction to the record it replaces (the append-only expression of
-- the "superseded_by-style relation"). A PARTIAL UNIQUE INDEX fences
-- exactly ONE superseding record per prior record — concurrent or
-- replayed corrections converge to one winner (duplicate
-- convergence). Cycles are impossible: the FK requires the prior row
-- to exist before the reference can be written.
-- * CLIENT OWNERSHIP (TENANT-003 hard boundary): client_id is NOT NULL
-- and part of the immutable row. There is deliberately NO ON DELETE
-- CASCADE: evidence is immutable history, so a hard client delete is
-- rejected by the append-only trigger instead of erasing the trail
-- (clients are soft-tombstoned in practice; the FK plain-restrict is
-- the belt-and-suspenders history backstop).
-- * WORKSPACE SCOPE: an optional organizational refinement INSIDE the
-- owning Client; the database itself rejects a workspace that does
-- not belong to the record's Client (trigger), so the Client
-- boundary cannot be crossed through the workspace column.

-- No owner/role/user columns: authorization stays exactly the /agencies
-- membership authority composed with /clients canonical owner resolution
-- (and /workspaces canonical ownership for the optional scope) — no second
-- tenant/permission authority (frozen matrix: /evidence ──→ /clients,
-- /workspaces, /executions; /evidence imports no other module).

CREATE TABLE IF NOT EXISTS evidence (
  evidence_id            uuid        PRIMARY KEY,
  client_id              uuid        NOT NULL REFERENCES clients(client_id),
  workspace_id           uuid        REFERENCES workspaces(workspace_id),
  class                  text        NOT NULL CHECK (class IN ('source_fact', 'observation',
                                                       'inference', 'hypothesis', 'attribution',
                                                       'prediction', 'causal_estimate', 'learning')),
  source_system          text        NOT NULL CHECK (length(source_system) >= 1
                                        AND length(source_system) <= 100),
  source_ref             text        CHECK (source_ref IS NULL OR (length(source_ref) >= 1
                                        AND length(source_ref) <= 512)),
  observed_at            timestamptz NOT NULL,
  content                jsonb       NOT NULL CHECK (jsonb_typeof(content) = 'object'
                                        AND content <> '{}'::jsonb),
  content_ref            text        CHECK (content_ref IS NULL OR (length(content_ref) >= 1
                                        AND length(content_ref) <= 512)),
  quality                text        NOT NULL CHECK (quality ~ '^[A-F]$'),
  confidence             numeric     CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  supersedes_evidence_id uuid        REFERENCES evidence(evidence_id),
  recorded_actor         text        NOT NULL,
  recorded_via           text        NOT NULL CHECK (length(recorded_via) >= 1
                                        AND length(recorded_via) <= 100),
  correlation_id         text        NOT NULL,
  causation_id           text,
  recorded_at            timestamptz NOT NULL DEFAULT now()
);

-- Listing surfaces: evidence of one Client (newest first by server-recorded
-- time), and the evidence scoped to one Workspace.
CREATE INDEX IF NOT EXISTS evidence_client_idx
ON evidence (client_id, recorded_at, evidence_id);

CREATE INDEX IF NOT EXISTS evidence_workspace_idx
ON evidence (workspace_id) WHERE workspace_id IS NOT NULL;

-- SUPERSESSION FENCE (EVID-AC-02): at most ONE superseding record per prior
-- record — the database itself rejects a second correction of the same
-- record, so concurrent or replayed supersession attempts converge to
-- exactly one winner (the loser surfaces as a unique violation the store
-- classifies into a domain ConflictError).
CREATE UNIQUE INDEX IF NOT EXISTS evidence_supersession_fence
ON evidence (supersedes_evidence_id) WHERE supersedes_evidence_id IS NOT NULL;

-- Authority tier of an evidence class (EVID-AC-03): source_fact/observation
-- are AUTHORITATIVE observations; the six claim classes are model/human
-- CLAIMS. Pure function over the closed CHECK enumeration.
CREATE OR REPLACE FUNCTION evidence_class_tier(cls text) RETURNS text AS $$
BEGIN
  RETURN CASE WHEN cls IN ('source_fact', 'observation')
              THEN 'authoritative'
              ELSE 'claim'
         END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- APPEND-ONLY backstop (EVID-AC-02: "evidence is append-oriented; history
-- is not overwritten — DB trigger"): the database itself rejects UPDATE and
-- DELETE on evidence. Not even server code can rewrite history; corrections
-- can only be NEW rows.
CREATE OR REPLACE FUNCTION evidence_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'evidence is append-only: % is rejected on evidence %', TG_OP, OLD.evidence_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS evidence_append_only_update_trigger ON evidence;
CREATE TRIGGER evidence_append_only_update_trigger
BEFORE UPDATE ON evidence
FOR EACH ROW EXECUTE FUNCTION evidence_append_only();

DROP TRIGGER IF EXISTS evidence_append_only_delete_trigger ON evidence;
CREATE TRIGGER evidence_append_only_delete_trigger
BEFORE DELETE ON evidence
FOR EACH ROW EXECUTE FUNCTION evidence_append_only();

-- SUPERSESSION LEGALITY (EVID-AC-03 storage backstop + tenant isolation):
-- a superseding record must reference a prior record of the SAME Client and
-- must stay within the SAME authority tier. The claim → authoritative
-- direction is rejected by name: claims are never auto-promoted to
-- authoritative classes; the authoritative → claim direction is rejected
-- as well (no authority laundering through demotion).
CREATE OR REPLACE FUNCTION evidence_supersession_legal() RETURNS trigger AS $$
DECLARE
  v_prior_client uuid;
  v_prior_class  text;
BEGIN
  IF NEW.supersedes_evidence_id IS NOT NULL THEN
    SELECT client_id, class INTO v_prior_client, v_prior_class
      FROM evidence WHERE evidence_id = NEW.supersedes_evidence_id;
    IF v_prior_client IS NULL THEN
      RAISE EXCEPTION 'cannot supersede unknown evidence %', NEW.supersedes_evidence_id;
    END IF;
    IF v_prior_client <> NEW.client_id THEN
      RAISE EXCEPTION 'evidence % belongs to another client — cross-tenant supersession is rejected', NEW.supersedes_evidence_id;
    END IF;
    IF evidence_class_tier(v_prior_class) <> evidence_class_tier(NEW.class) THEN
      IF evidence_class_tier(NEW.class) = 'authoritative' THEN
        RAISE EXCEPTION 'claims are never auto-promoted to authoritative classes: evidence % (% -> %)',
          NEW.supersedes_evidence_id, v_prior_class, NEW.class;
      ELSE
        RAISE EXCEPTION 'supersession preserves the authority tier: evidence % (% -> %)',
          NEW.supersedes_evidence_id, v_prior_class, NEW.class;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS evidence_supersession_legal_trigger ON evidence;
CREATE TRIGGER evidence_supersession_legal_trigger
BEFORE INSERT ON evidence
FOR EACH ROW EXECUTE FUNCTION evidence_supersession_legal();

-- Scope backstop (TENANT-003 at the storage layer, goals pattern): a
-- workspace-scoped evidence record must reference a Workspace of the SAME
-- Client — the Client boundary cannot be crossed through the workspace
-- column even if every application check were bypassed.
CREATE OR REPLACE FUNCTION evidence_workspace_within_client() RETURNS trigger AS $$
BEGIN
  IF NEW.workspace_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM workspaces w
        WHERE w.workspace_id = NEW.workspace_id AND w.client_id = NEW.client_id) THEN
      RAISE EXCEPTION 'evidence % workspace % does not belong to client % — the workspace scope cannot cross the Client boundary',
        NEW.evidence_id, NEW.workspace_id, NEW.client_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS evidence_workspace_within_client_trigger ON evidence;
CREATE TRIGGER evidence_workspace_within_client_trigger
BEFORE INSERT OR UPDATE ON evidence
FOR EACH ROW EXECUTE FUNCTION evidence_workspace_within_client();
