-- MKT-016 Learning model schema (LEARN-001).
-- PostgreSQL is the system of record (spec/architecture-lock.md).

-- Table ownership follows the frozen authority map (implementation-contract §1):
-- learnings, learning_relationships → /learnings (Learnings)

-- Frozen semantics encoded here (spec/architecture.md §17 "Learning is a
-- durable conclusion linked to supporting evidence/outcomes and
-- applicability. Learning never erases contradictory history";
-- implementation-contract §17 "Learning contract";
-- spec/evidence-and-experimentation.md §8 "Learning — durable conclusion
-- with explicit applicability conditions" and the scientific rules
-- "Learnings have scope and may be contradicted by later evidence",
-- "Repeated experimentation may update a learning but does not erase
-- historical evidence"):

-- * APPEND-ORIENTED, FULLY IMMUTABLE LEARNING ROWS (LEARN-AC-02): a
--   learning row is written exactly once and NEVER mutated — there is no
--   UPDATE path at all (a BEFORE UPDATE OR DELETE trigger rejects every
--   mutation, the migration 015 evidence pattern). The Learning STATE
--   (implementation-contract §17: "state whether it is active, superseded,
--   contradicted, or retired") is NOT a stored, mutable column: it is
--   DERIVED at read time from the append-only relationship history, so
--   contradiction and supersession NEVER rewrite the original row — the
--   original learning row is byte-stable forever.
-- * CONTRADICTION / SUPERSESSION / RETIREMENT ARE NEW RELATIONSHIP ROWS
--   (LEARN-AC-02): learning_relationships is an APPEND-ONLY table (UPDATE
--   and DELETE are rejected by triggers). Each row is one explicit
--   relationship: kind 'contradicts' or 'supersedes' carries a LATER
--   learning (to_learning_id) recorded against an EARLIER one
--   (from_learning_id); kind 'retires' retires the earlier learning with
--   no successor (to_learning_id NULL). Nothing is ever erased
--   ("Learning is never retroactive deletion of evidence").
-- * DERIVED-STATUS PRECEDENCE (deterministic, server-side): a learning
--   targeted by a 'supersedes' relationship derives 'superseded'
--   (terminal — the successor fence allows exactly one); else targeted by
--   'retires' derives 'retired' (terminal — exactly one); else targeted
--   by any 'contradicts' relationship derives 'contradicted' (NOT
--   terminal — later evidence may contradict further, and a contradicted
--   learning may still be superseded or retired); else 'active'.
-- * SUPERSESSION FENCE: at most ONE superseding relationship per prior
--   learning (partial unique index — the migration 015 evidence fence
--   pattern) and at most ONE retirement per learning. Concurrent or
--   replayed attempts converge to one winner; the loser surfaces as a
--   unique violation the store classifies into a domain ConflictError.
-- * TERMINAL-TARGET BACKSTOP: the database itself rejects a relationship
--   that targets an already-superseded or already-retired learning (the
--   race backstop behind the module's derived-status pre-check). Cycles
--   are impossible: a relationship requires both learning rows to exist
--   first and can only point from an earlier record to a later one.
-- * SUPPORTING REFERENCES (LEARN-AC-01): evidence_refs (jsonb array of
--   /evidence record ids) and experiment_refs (jsonb array of /experiments
--   ids — OUTCOME references: the module validates through the /evidence
--   and /experiments public contracts that every reference exists,
--   belongs to the SAME Client and (for experiments) has concluded).
--   The database rejects any reference to another Client's record
--   (triggers — the migration 019 experiment-conclusion evidence-refs
--   pattern), so the owning authorities stay tenant-fenced even when a
--   Learning cites them.
-- * SCOPE-CHAIN CONVENTIONS (the same conventions the other authorities
--   use): client_id is NOT NULL and part of the immutable row; the
--   optional workspace_id must live INSIDE the owning Client (trigger —
--   the migration 015/018/019 pattern); the applicability conditions are
--   a non-empty jsonb object carried on the record ("durable conclusion
--   with explicit applicability conditions").
-- * CONFIDENCE IS A SEPARATE DESCRIPTIVE FIELD (implementation-contract
--   §17): the optional 0..1 score is caller-declared claim metadata,
--   stored on its own column — SEPARATE from provenance (spec/
--   evidence-and-experimentation.md "Provenance is a separate dimension
--   from confidence") and never able to touch ownership or references.
-- * PROVENANCE IS SERVER-DERIVED (implementation-contract §3: "No
--   externally supplied field may override a server-derived actor, owner,
--   provenance, policy decision, or evidence authority value"):
--   recorded_actor, recorded_via, correlation_id, causation_id and
--   recorded_at are written exclusively by server code — there is no
--   request DTO path to them (route validation rejects provenance-shaped
--   keys AND status/supersession-shaped authority keys; the module API
--   takes provenance as a separate server-built argument).
-- * CLIENT OWNERSHIP (TENANT-003 hard boundary): there is deliberately NO
--   ON DELETE CASCADE — learning history is durable, so a hard client
--   delete is rejected by the append-only trigger instead of erasing the
--   trail (clients are soft-tombstoned in practice; the FK plain-restrict
--   is the belt-and-suspenders backstop).
-- * NO PROVIDER STATE: no provider ids, no provider sessions, no
--   SDK-shaped columns. No metric normalization (owned by /metrics), no
--   experiment machinery (owned by /experiments), no evidence classes
--   (owned by /evidence).

-- No owner/role/user columns: authorization stays exactly the /agencies
-- membership authority composed with /clients canonical owner resolution
-- (and /workspaces canonical ownership for the optional scope) — no second
-- tenant/permission authority (frozen matrix: /learnings ──→ /evidence,
-- /experiments, /goals; the /clients and /workspaces canonical ownership
-- instances are injected through /learnings' declared structural ports at
-- the composition root, so no forbidden module import exists).

CREATE TABLE IF NOT EXISTS learnings (
  learning_id                uuid        PRIMARY KEY,
  client_id                  uuid        NOT NULL REFERENCES clients(client_id),
  workspace_id               uuid        REFERENCES workspaces(workspace_id),
  statement                  text        NOT NULL CHECK (length(statement) >= 1
                                         AND length(statement) <= 2000),
  applicability              jsonb       NOT NULL CHECK (jsonb_typeof(applicability) = 'object'
                                         AND applicability <> '{}'::jsonb),
  evidence_refs              jsonb       NOT NULL DEFAULT '[]'::jsonb
                                         CHECK (jsonb_typeof(evidence_refs) = 'array'),
  experiment_refs            jsonb       NOT NULL DEFAULT '[]'::jsonb
                                         CHECK (jsonb_typeof(experiment_refs) = 'array'),
  confidence                 numeric     CHECK (confidence IS NULL
                                         OR (confidence >= 0 AND confidence <= 1)),
  recorded_actor             text        NOT NULL,
  recorded_via               text        NOT NULL CHECK (length(recorded_via) >= 1
                                         AND length(recorded_via) <= 100),
  correlation_id             text        NOT NULL,
  causation_id               text,
  recorded_at                timestamptz NOT NULL DEFAULT now()
);

-- Listing surfaces: one Client's learnings (newest first by
-- server-recorded time) and the Workspace-scoped subset. The derived
-- status is NOT a column — it is computed from the relationship history
-- at read time (the store's SELECT), so these indexes cover the ledger
-- scans only.
CREATE INDEX IF NOT EXISTS learnings_client_idx
ON learnings (client_id, recorded_at, learning_id);

CREATE INDEX IF NOT EXISTS learnings_workspace_idx
ON learnings (workspace_id) WHERE workspace_id IS NOT NULL;

-- The APPEND-ONLY relationship history (LEARN-AC-02): one row per
-- recorded contradiction / supersession / retirement. from_learning_id is
-- the EARLIER (target) learning; to_learning_id is the LATER learning
-- that contradicts or supersedes it (NULL exactly for 'retires').
CREATE TABLE IF NOT EXISTS learning_relationships (
  relationship_id           uuid        PRIMARY KEY,
  from_learning_id          uuid        NOT NULL REFERENCES learnings(learning_id),
  to_learning_id            uuid        REFERENCES learnings(learning_id),
  kind                      text        NOT NULL CHECK (kind IN ('contradicts',
                                         'supersedes', 'retires')),
  recorded_actor            text        NOT NULL,
  recorded_via              text        NOT NULL CHECK (length(recorded_via) >= 1
                                         AND length(recorded_via) <= 100),
  correlation_id            text        NOT NULL,
  causation_id              text,
  recorded_at               timestamptz NOT NULL DEFAULT now(),
  -- The relationship payload shape: contradiction and supersession carry
  -- the later learning; retirement carries none.
  CONSTRAINT learning_relationship_payload CHECK (
    (kind IN ('contradicts', 'supersedes') AND to_learning_id IS NOT NULL)
    OR (kind = 'retires' AND to_learning_id IS NULL)
  ),
  -- A learning can never contradict, supersede or retire itself.
  CONSTRAINT learning_relationship_no_self CHECK (
    to_learning_id IS NULL OR to_learning_id <> from_learning_id
  )
);

CREATE INDEX IF NOT EXISTS learning_relationships_from_idx
ON learning_relationships (from_learning_id, recorded_at, relationship_id);

CREATE INDEX IF NOT EXISTS learning_relationships_to_idx
ON learning_relationships (to_learning_id, recorded_at, relationship_id);

-- SUPERSESSION/RETIREMENT FENCES (LEARN-AC-02, the migration 015 evidence
-- fence pattern): at most ONE superseding relationship per prior learning
-- and at most ONE retirement per learning — the database itself rejects a
-- second successor or a second retirement, so concurrent or replayed
-- attempts converge to exactly one winner (the loser surfaces as a unique
-- violation the store classifies into a domain ConflictError).
-- Contradictions accumulate freely: later evidence may contradict a
-- learning repeatedly, and every row stays in the history.
CREATE UNIQUE INDEX IF NOT EXISTS learning_supersession_fence
ON learning_relationships (from_learning_id) WHERE kind = 'supersedes';

CREATE UNIQUE INDEX IF NOT EXISTS learning_retirement_fence
ON learning_relationships (from_learning_id) WHERE kind = 'retires';

-- APPEND-ONLY backstops (LEARN-AC-02, the migration 015/018/019 pattern):
-- the database itself rejects UPDATE and DELETE on BOTH tables. Learning
-- rows have NO mutable column at all (the state is derived, never stored),
-- and relationship history rows are written exactly once. Not even
-- server-side SQL can rewrite learning history — contradiction and
-- supersession can only ever be NEW rows.
CREATE OR REPLACE FUNCTION learnings_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'learnings are append-only: % is rejected on learning %', TG_OP, OLD.learning_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS learnings_append_only_update_trigger ON learnings;
CREATE TRIGGER learnings_append_only_update_trigger
BEFORE UPDATE ON learnings
FOR EACH ROW EXECUTE FUNCTION learnings_append_only();

DROP TRIGGER IF EXISTS learnings_append_only_delete_trigger ON learnings;
CREATE TRIGGER learnings_append_only_delete_trigger
BEFORE DELETE ON learnings
FOR EACH ROW EXECUTE FUNCTION learnings_append_only();

CREATE OR REPLACE FUNCTION learning_relationships_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'learning relationships are append-only: % is rejected on relationship %', TG_OP, OLD.relationship_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS learning_relationships_append_only_update_trigger ON learning_relationships;
CREATE TRIGGER learning_relationships_append_only_update_trigger
BEFORE UPDATE ON learning_relationships
FOR EACH ROW EXECUTE FUNCTION learning_relationships_append_only();

DROP TRIGGER IF EXISTS learning_relationships_append_only_delete_trigger ON learning_relationships;
CREATE TRIGGER learning_relationships_append_only_delete_trigger
BEFORE DELETE ON learning_relationships
FOR EACH ROW EXECUTE FUNCTION learning_relationships_append_only();

-- Scope backstop (TENANT-003 at the storage layer, migration 015/018/019
-- pattern): a workspace-scoped learning must reference a Workspace of the
-- SAME Client — the Client boundary cannot be crossed through the
-- workspace column even if every application check were bypassed.
CREATE OR REPLACE FUNCTION learning_workspace_within_client() RETURNS trigger AS $$
BEGIN
  IF NEW.workspace_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM workspaces w
        WHERE w.workspace_id = NEW.workspace_id AND w.client_id = NEW.client_id) THEN
      RAISE EXCEPTION 'learning % workspace % does not belong to client % — the workspace scope cannot cross the Client boundary',
        NEW.learning_id, NEW.workspace_id, NEW.client_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS learning_workspace_within_client_trigger ON learnings;
CREATE TRIGGER learning_workspace_within_client_trigger
BEFORE INSERT ON learnings
FOR EACH ROW EXECUTE FUNCTION learning_workspace_within_client();

-- Supporting-reference backstops (cross-tenant rejection, the migration
-- 019 experiment-conclusion evidence-refs pattern): a Learning MAY cite
-- /evidence records and /experiments outcomes, but ONLY ones owned by the
-- SAME Client — the owning authorities stay tenant-fenced even when a
-- Learning cites them (unknown references are rejected too,
-- belt-and-suspenders ahead of the FK-less jsonb arrays).
CREATE OR REPLACE FUNCTION learning_refs_same_client() RETURNS trigger AS $$
DECLARE
  v_ref text;
  v_ref_client uuid;
BEGIN
  FOR v_ref IN SELECT jsonb_array_elements_text(NEW.evidence_refs) LOOP
    IF v_ref !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'learning % cites a malformed evidence reference %', NEW.learning_id, v_ref;
    END IF;
    SELECT client_id INTO v_ref_client FROM evidence WHERE evidence_id = v_ref::uuid;
    IF v_ref_client IS NULL THEN
      RAISE EXCEPTION 'learning % cites unknown evidence %', NEW.learning_id, v_ref;
    END IF;
    IF v_ref_client <> NEW.client_id THEN
      RAISE EXCEPTION 'learning % cites evidence % of another client — cross-tenant evidence linkage is rejected',
        NEW.learning_id, v_ref;
    END IF;
  END LOOP;
  FOR v_ref IN SELECT jsonb_array_elements_text(NEW.experiment_refs) LOOP
    IF v_ref !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'learning % cites a malformed experiment reference %', NEW.learning_id, v_ref;
    END IF;
    SELECT client_id INTO v_ref_client FROM experiments WHERE experiment_id = v_ref::uuid;
    IF v_ref_client IS NULL THEN
      RAISE EXCEPTION 'learning % cites unknown experiment %', NEW.learning_id, v_ref;
    END IF;
    IF v_ref_client <> NEW.client_id THEN
      RAISE EXCEPTION 'learning % cites experiment % of another client — cross-tenant experiment linkage is rejected',
        NEW.learning_id, v_ref;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS learning_refs_same_client_trigger ON learnings;
CREATE TRIGGER learning_refs_same_client_trigger
BEFORE INSERT ON learnings
FOR EACH ROW EXECUTE FUNCTION learning_refs_same_client();

-- Relationship-legality backstops (TENANT-003 + the terminal fence):
--   1. cross-tenant: both learnings of a relationship must belong to the
--      SAME Client (a foreign learning identifier is never a linkage
--      oracle);
--   2. terminal: the target (from) learning must not already be
--      superseded or retired — the race backstop behind the module's
--      derived-status pre-check (a contradicted target is still legal:
--      later evidence may keep arriving).
CREATE OR REPLACE FUNCTION learning_relationship_legal() RETURNS trigger AS $$
DECLARE
  v_from_client uuid;
  v_to_client   uuid;
BEGIN
  SELECT client_id INTO v_from_client FROM learnings WHERE learning_id = NEW.from_learning_id;
  IF v_from_client IS NULL THEN
    RAISE EXCEPTION 'relationship targets unknown learning %', NEW.from_learning_id;
  END IF;
  IF NEW.to_learning_id IS NOT NULL THEN
    SELECT client_id INTO v_to_client FROM learnings WHERE learning_id = NEW.to_learning_id;
    IF v_to_client IS NULL THEN
      RAISE EXCEPTION 'relationship references unknown learning %', NEW.to_learning_id;
    END IF;
    IF v_to_client <> v_from_client THEN
      RAISE EXCEPTION 'learning % of another client cannot be linked to learning % — cross-tenant learning relationships are rejected',
        NEW.to_learning_id, NEW.from_learning_id;
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM learning_relationships r
      WHERE r.from_learning_id = NEW.from_learning_id AND r.kind = 'supersedes') THEN
    RAISE EXCEPTION 'learning % is already superseded — its history is terminal',
      NEW.from_learning_id;
  END IF;
  IF EXISTS (SELECT 1 FROM learning_relationships r
      WHERE r.from_learning_id = NEW.from_learning_id AND r.kind = 'retires') THEN
    RAISE EXCEPTION 'learning % is already retired — its history is terminal',
      NEW.from_learning_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS learning_relationship_legal_trigger ON learning_relationships;
CREATE TRIGGER learning_relationship_legal_trigger
BEFORE INSERT ON learning_relationships
FOR EACH ROW EXECUTE FUNCTION learning_relationship_legal();
