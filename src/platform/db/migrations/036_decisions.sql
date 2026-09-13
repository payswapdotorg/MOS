-- MKT-042 Decision Ledger schema (the Decision Ledger authority —
-- spec/architecture-v1.5.md §4; the primary contract
-- spec/operating-graph-v1.5.md "Decision Ledger"; frozen by
-- spec/architecture-lock-v1.5.md rule #5 and spec/change-request-005.md
-- change #2). PostgreSQL is the system of record (spec/architecture-lock.md).

-- Table ownership follows the authority map:
-- decisions, decision_events → /decisions (Decision Ledger)

-- Frozen semantics encoded here:

-- * THE FULL RECORD VOCABULARY of the primary contract ("decision scope,
--   objective, evidence, context, hypothesis summary, expected impact and
--   uncertainty, expected cost, proposer, alternatives, disposition,
--   execution/deployment reference, observed outcome, learning reference
--   and audit metadata"): decision scope = agency_id (server-derived
--   through the canonical /clients chain) + client_id (NOT NULL FK) + the
--   optional workspace_id (FK, must live INSIDE the Client — trigger);
--   objective/context/hypothesis_summary as bounded text; evidence_refs
--   (jsonb array of /evidence ids — same-Client trigger); experiment_ref
--   (the hypothesis link — same-Client trigger); expected_impact (jsonb:
--   summary + closed-set direction + optional magnitude) and uncertainty
--   (jsonb: interval | distribution | qualitative, or NULL) as TWO
--   SEPARATE structured columns — uncertainty is never conflated with
--   impact; expected_cost (bounded text); alternatives (bounded jsonb
--   string array); proposer_actor + proposer_role (SERVER-DERIVED — no
--   request DTO path); disposition (the frozen enum); execution_ref +
--   deployment_ref (at most one — row CHECK; set with the observed
--   outcome); observed_outcome (jsonb, set exactly once) + learning_ref +
--   outcome_at; idempotency_key + create_fingerprint (the §8 fences) and
--   the provenance/audit columns (recorded_actor, recorded_via,
--   correlation_id, causation_id, recorded_at — server-written only).
-- * THE FROZEN DISPOSITION STATE MACHINE: proposed → accepted | rejected
--   | superseded (all three TERMINAL — a second disposition against a
--   terminal record is a 409 at the module and an illegal-edge rejection
--   here; concurrent dispositions converge to exactly ONE winner under
--   the module's CAS UPDATE ... WHERE disposition = 'proposed', with the
--   legal-successor trigger as the race backstop).
-- * APPEND-ORIENTED, NEVER REWRITING (lock rule #5): decision_events is
--   APPEND-ONLY — BEFORE UPDATE OR DELETE triggers reject every mutation
--   (the migration 015/018/019/027 pattern). The decisions PROPOSAL
--   columns are IMMUTABLE after insert — a BEFORE UPDATE trigger rejects
--   any rewrite of them; only the lifecycle columns (disposition,
--   successor_decision_id, disposition_at, observed_outcome,
--   execution_ref, deployment_ref, learning_ref, outcome_at) may change,
--   and only along the frozen legal edges (the next trigger).
-- * CORRECTIONS ARE NEW RECORDS: the correction declares its predecessor
--   (predecessor_decision_id — same-Client, NOT already superseded:
--   trigger); the superseded predecessor forward-links to its successor
--   (successor_decision_id, set by the supersede disposition; the
--   successor must be a live same-Client correction whose predecessor
--   points back: trigger). History is never rewritten.
-- * THE §8 FENCES ("Application-level check-then-insert is insufficient
--   as the sole duplicate fence"): (client_id, idempotency_key) UNIQUE on
--   decisions and (decision_id, idempotency_key) UNIQUE on
--   decision_events. Same-key duplicates converge at the module through
--   the recorded rows (replayed=true); a key reused for a different
--   logical command is a 409.
-- * THE OBSERVED OUTCOME IS ONE-SHOT: only an ACCEPTED decision records
--   an outcome (legal-edge trigger), exactly once (the CAS +
--   observed_outcome IS NOT NULL guard), with at most ONE implementation
--   reference (execution_ref XOR deployment_ref — row CHECK).
-- * TENANT FENCES (TENANT-003 hard boundary): client_id is NOT NULL and
--   part of the immutable row; there is deliberately NO ON DELETE CASCADE
--   — ledger history is durable, so a hard client delete is rejected by
--   the proposal-immutability trigger instead of erasing the trail
--   (clients are soft-tombstoned in practice; the FK plain-restrict is
--   the belt-and-suspenders backstop). The workspace scope must live
--   INSIDE the owning Client (trigger). Cited evidence refs, the
--   experiment link, and the outcome's execution/deployment/learning
--   references must belong to the SAME Client (triggers — cross-tenant
--   rejection, the migration 019/027 pattern): the ledger can LINK the
--   authorities but never rewrite or leak them (lock rule #5).
-- * NO PROVIDER STATE: no provider ids, no provider sessions, no
--   SDK-shaped columns. No workflow/execution/policy machinery — the
--   ledger records decisions, it does not execute or gate them (the
--   /policies allowance is the reserved MKT-045 direction, unused here).

-- No owner/role/user columns: authorization stays exactly the /agencies
-- membership authority composed with /clients canonical owner resolution
-- (and /workspaces canonical ownership for the optional scope) — no
-- second tenant/permission authority. The /evidence, /experiments,
-- /learnings, /executions and /deployments public contracts are consumed
-- READ-ONLY for write-time reference validation (the module layer); the
-- triggers below are their DB backstops.

CREATE TABLE IF NOT EXISTS decisions (
  decision_id                uuid        PRIMARY KEY,
  client_id                  uuid        NOT NULL REFERENCES clients(client_id),
  workspace_id               uuid        REFERENCES workspaces(workspace_id),
  agency_id                  uuid        NOT NULL REFERENCES agencies(agency_id),
  objective                  text        NOT NULL CHECK (length(objective) >= 1
                                         AND length(objective) <= 2000),
  context                    text        CHECK (context IS NULL
                                         OR (length(context) >= 1
                                         AND length(context) <= 2000)),
  hypothesis_summary         text        NOT NULL CHECK (length(hypothesis_summary) >= 1
                                         AND length(hypothesis_summary) <= 2000),
  experiment_ref             uuid,
  evidence_refs              jsonb       NOT NULL DEFAULT '[]'::jsonb
                                         CHECK (jsonb_typeof(evidence_refs) = 'array'),
  expected_impact            jsonb       NOT NULL CHECK (jsonb_typeof(expected_impact) = 'object'
                                         AND expected_impact ? 'summary'
                                         AND length(expected_impact ->> 'summary') >= 1
                                         AND length(expected_impact ->> 'summary') <= 2000
                                         AND (NOT (expected_impact ? 'direction')
                                              OR expected_impact ->> 'direction' IN
                                              ('increase', 'decrease', 'no_change', 'any'))),
  uncertainty                jsonb       CHECK (uncertainty IS NULL
                                         OR (jsonb_typeof(uncertainty) = 'object'
                                         AND uncertainty ? 'kind'
                                         AND uncertainty ->> 'kind' IN
                                         ('interval', 'distribution', 'qualitative'))),
  expected_cost              text        CHECK (expected_cost IS NULL
                                         OR (length(expected_cost) >= 1
                                         AND length(expected_cost) <= 2000)),
  alternatives               jsonb       NOT NULL DEFAULT '[]'::jsonb
                                         CHECK (jsonb_typeof(alternatives) = 'array'),
  predecessor_decision_id    uuid        REFERENCES decisions(decision_id),
  proposer_actor             text        NOT NULL CHECK (length(proposer_actor) >= 1),
  proposer_role              text        NOT NULL CHECK (length(proposer_role) >= 1),
  disposition                text        NOT NULL DEFAULT 'proposed'
                                         CHECK (disposition IN ('proposed', 'accepted',
                                         'rejected', 'superseded')),
  successor_decision_id      uuid        REFERENCES decisions(decision_id),
  disposition_at             timestamptz,
  observed_outcome           jsonb       CHECK (observed_outcome IS NULL
                                         OR (jsonb_typeof(observed_outcome) = 'object'
                                         AND observed_outcome ? 'summary'
                                         AND length(observed_outcome ->> 'summary') >= 1
                                         AND length(observed_outcome ->> 'summary') <= 2000)),
  execution_ref              uuid,
  deployment_ref             uuid,
  learning_ref               uuid,
  outcome_at                 timestamptz,
  idempotency_key            text        NOT NULL CHECK (length(idempotency_key) >= 1
                                         AND length(idempotency_key) <= 200),
  create_fingerprint         text        NOT NULL CHECK (length(create_fingerprint) >= 1
                                         AND length(create_fingerprint) <= 300),
  recorded_actor             text        NOT NULL,
  recorded_via               text        NOT NULL CHECK (length(recorded_via) >= 1
                                         AND length(recorded_via) <= 100),
  correlation_id             text        NOT NULL,
  causation_id               text,
  recorded_at                timestamptz NOT NULL DEFAULT now(),
  -- The frozen lifecycle soundness (row CHECKs behind the module guard +
  -- the triggers below):
  --   * only a SUPERSEDED decision carries a successor;
  --   * an implementation reference rides ONLY the observed outcome;
  --   * at most ONE implementation reference (execution XOR deployment).
  CONSTRAINT decision_successor_shape CHECK (
    (disposition = 'superseded') = (successor_decision_id IS NOT NULL)
  ),
  CONSTRAINT decision_outcome_refs_shape CHECK (
    (execution_ref IS NOT NULL AND deployment_ref IS NULL)
    OR (execution_ref IS NULL AND deployment_ref IS NOT NULL)
    OR (execution_ref IS NULL AND deployment_ref IS NULL)
  ),
  CONSTRAINT decision_outcome_pairing CHECK (
    (observed_outcome IS NULL AND outcome_at IS NULL)
    OR (observed_outcome IS NOT NULL AND outcome_at IS NOT NULL)
  )
);

-- The §8 create fence: one logical create key per Client.
CREATE UNIQUE INDEX IF NOT EXISTS decisions_idempotency_key_unique
ON decisions (client_id, idempotency_key);

-- Listing surfaces: one Client's decisions (newest first by
-- server-recorded time), the Workspace-scoped subset and the per-
-- disposition operational views (proposals awaiting disposition /
-- accepted awaiting outcome).
CREATE INDEX IF NOT EXISTS decisions_client_idx
ON decisions (client_id, recorded_at, decision_id);

CREATE INDEX IF NOT EXISTS decisions_workspace_idx
ON decisions (workspace_id) WHERE workspace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS decisions_disposition_idx
ON decisions (client_id, disposition);

-- The correction-chain surfaces: the predecessor link and the successor
-- forward link (the append-only correction trail).
CREATE INDEX IF NOT EXISTS decisions_predecessor_idx
ON decisions (predecessor_decision_id) WHERE predecessor_decision_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS decisions_successor_idx
ON decisions (successor_decision_id) WHERE successor_decision_id IS NOT NULL;

-- The APPEND-ONLY ledger event tail: one row per disposition or outcome
-- observation, carrying the FULL payload verbatim (the disposition reason
-- and successor; the observed outcome, the execution/deployment reference
-- and the learning reference — the post-execution linkage retained
-- exactly as recorded).
CREATE TABLE IF NOT EXISTS decision_events (
  event_id                   uuid        PRIMARY KEY,
  decision_id                uuid        NOT NULL REFERENCES decisions(decision_id),
  event_kind                 text        NOT NULL CHECK (event_kind IN ('disposition',
                                         'outcome_observed')),
  disposition                text        CHECK (disposition IS NULL
                                         OR disposition IN ('accepted', 'rejected',
                                         'superseded')),
  reason                     text        CHECK (reason IS NULL
                                         OR (length(reason) >= 1
                                         AND length(reason) <= 2000)),
  successor_decision_id      uuid,
  observed_outcome           jsonb       CHECK (observed_outcome IS NULL
                                         OR (jsonb_typeof(observed_outcome) = 'object'
                                         AND observed_outcome ? 'summary'
                                         AND length(observed_outcome ->> 'summary') >= 1
                                         AND length(observed_outcome ->> 'summary') <= 2000)),
  execution_ref              uuid,
  deployment_ref             uuid,
  learning_ref               uuid,
  idempotency_key            text        NOT NULL CHECK (length(idempotency_key) >= 1
                                         AND length(idempotency_key) <= 200),
  recorded_actor             text        NOT NULL,
  recorded_via               text        NOT NULL CHECK (length(recorded_via) >= 1
                                         AND length(recorded_via) <= 100),
  correlation_id             text        NOT NULL,
  causation_id               text,
  recorded_at                timestamptz NOT NULL DEFAULT now(),
  -- The event payload shape: a disposition event carries the disposition
  -- (and the successor exactly when superseding); an outcome event
  -- carries the observed outcome with at most one implementation
  -- reference and the optional learning reference.
  CONSTRAINT decision_event_payload CHECK (
    (event_kind = 'disposition'
       AND disposition IS NOT NULL
       AND observed_outcome IS NULL
       AND execution_ref IS NULL AND deployment_ref IS NULL AND learning_ref IS NULL
       AND ((disposition = 'superseded') = (successor_decision_id IS NOT NULL)))
    OR (event_kind = 'outcome_observed'
       AND disposition IS NULL AND successor_decision_id IS NULL
       AND observed_outcome IS NOT NULL
       AND ((execution_ref IS NOT NULL AND deployment_ref IS NULL)
            OR (execution_ref IS NULL AND deployment_ref IS NOT NULL)
            OR (execution_ref IS NULL AND deployment_ref IS NULL)))
  )
);

-- The §8 event fence: one logical command key per decision.
CREATE UNIQUE INDEX IF NOT EXISTS decision_events_idempotency_key_unique
ON decision_events (decision_id, idempotency_key);

CREATE INDEX IF NOT EXISTS decision_events_decision_idx
ON decision_events (decision_id, recorded_at, event_id);

-- APPEND-ONLY backstop (the migration 015/018/019/027 pattern): the
-- database itself rejects UPDATE and DELETE on the ledger event tail.
-- Not even server code can rewrite decision history.
CREATE OR REPLACE FUNCTION decision_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'decision events are append-only: % is rejected on decision event %', TG_OP, OLD.event_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS decision_events_append_only_update_trigger ON decision_events;
CREATE TRIGGER decision_events_append_only_update_trigger
BEFORE UPDATE ON decision_events
FOR EACH ROW EXECUTE FUNCTION decision_events_append_only();

DROP TRIGGER IF EXISTS decision_events_append_only_delete_trigger ON decision_events;
CREATE TRIGGER decision_events_append_only_delete_trigger
BEFORE DELETE ON decision_events
FOR EACH ROW EXECUTE FUNCTION decision_events_append_only();

-- The ledger rows themselves are never ERASED either: a BEFORE DELETE
-- trigger on decisions rejects every delete (the migration 027 learnings
-- pattern — "Learning is never retroactive deletion of evidence"; the
-- Decision Ledger holds the same durability for the same reason: the
-- append-only history is the point of the authority). Corrections and
-- supersession are NEW records; nothing is ever removed.
CREATE OR REPLACE FUNCTION decisions_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'decisions are append-only ledger history: DELETE is rejected on decision %', OLD.decision_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS decisions_no_delete_trigger ON decisions;
CREATE TRIGGER decisions_no_delete_trigger
BEFORE DELETE ON decisions
FOR EACH ROW EXECUTE FUNCTION decisions_no_delete();

-- PROPOSAL-IMMUTABILITY backstop (lock rule #5's ledger half): a BEFORE
-- UPDATE trigger rejects ANY change to the proposal columns (scope,
-- reasoning payload, references, proposer, §8 create identity, provenance
-- and the row identity itself). Only the lifecycle columns may change —
-- and only through the frozen legal edges (the next trigger).
CREATE OR REPLACE FUNCTION decision_proposal_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.decision_id             IS DISTINCT FROM OLD.decision_id
     OR NEW.client_id            IS DISTINCT FROM OLD.client_id
     OR NEW.workspace_id         IS DISTINCT FROM OLD.workspace_id
     OR NEW.agency_id            IS DISTINCT FROM OLD.agency_id
     OR NEW.objective            IS DISTINCT FROM OLD.objective
     OR NEW.context              IS DISTINCT FROM OLD.context
     OR NEW.hypothesis_summary   IS DISTINCT FROM OLD.hypothesis_summary
     OR NEW.experiment_ref       IS DISTINCT FROM OLD.experiment_ref
     OR NEW.evidence_refs        IS DISTINCT FROM OLD.evidence_refs
     OR NEW.expected_impact      IS DISTINCT FROM OLD.expected_impact
     OR NEW.uncertainty          IS DISTINCT FROM OLD.uncertainty
     OR NEW.expected_cost        IS DISTINCT FROM OLD.expected_cost
     OR NEW.alternatives         IS DISTINCT FROM OLD.alternatives
     OR NEW.predecessor_decision_id IS DISTINCT FROM OLD.predecessor_decision_id
     OR NEW.proposer_actor       IS DISTINCT FROM OLD.proposer_actor
     OR NEW.proposer_role        IS DISTINCT FROM OLD.proposer_role
     OR NEW.idempotency_key      IS DISTINCT FROM OLD.idempotency_key
     OR NEW.create_fingerprint   IS DISTINCT FROM OLD.create_fingerprint
     OR NEW.recorded_actor       IS DISTINCT FROM OLD.recorded_actor
     OR NEW.recorded_via         IS DISTINCT FROM OLD.recorded_via
     OR NEW.correlation_id       IS DISTINCT FROM OLD.correlation_id
     OR NEW.causation_id         IS DISTINCT FROM OLD.causation_id
     OR NEW.recorded_at          IS DISTINCT FROM OLD.recorded_at THEN
    RAISE EXCEPTION 'the decision proposal payload is immutable: rewriting decision % proposal/audit columns is rejected', OLD.decision_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS decision_proposal_immutable_trigger ON decisions;
CREATE TRIGGER decision_proposal_immutable_trigger
BEFORE UPDATE ON decisions
FOR EACH ROW EXECUTE FUNCTION decision_proposal_immutable();

-- LEGAL-LIFECYCLE backstop (the frozen disposition state machine as a DB
-- trigger — the race backstop behind the module's CAS update):
--   * a disposition transition may ONLY move proposed → accepted |
--     rejected | superseded (all three terminal — no outgoing edges);
--   * a supersede must carry its successor and nothing else;
--   * an outcome observation (disposition unchanged) may ONLY land on an
--     ACCEPTED decision that has NOT observed one yet, must set the
--     outcome columns together, and must not touch disposition metadata.
CREATE OR REPLACE FUNCTION decision_lifecycle_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.disposition = OLD.disposition THEN
    -- A pure proposal/audit rewrite touches NO lifecycle column: the
    -- proposal-immutability trigger (decision_proposal_immutable, which
    -- fires after this guard in the alphabetical trigger order) is the
    -- AUTHORITY for that rejection — pass the row through so the error
    -- class is correct, never a misattributed lifecycle error.
    IF NEW.observed_outcome IS NOT DISTINCT FROM OLD.observed_outcome
       AND NEW.outcome_at IS NOT DISTINCT FROM OLD.outcome_at
       AND NEW.execution_ref IS NOT DISTINCT FROM OLD.execution_ref
       AND NEW.deployment_ref IS NOT DISTINCT FROM OLD.deployment_ref
       AND NEW.learning_ref IS NOT DISTINCT FROM OLD.learning_ref
       AND NEW.successor_decision_id IS NOT DISTINCT FROM OLD.successor_decision_id
       AND NEW.disposition_at IS NOT DISTINCT FROM OLD.disposition_at THEN
      RETURN NEW;
    END IF;
    -- The outcome-observation path: disposition unchanged.
    IF NEW.disposition <> 'accepted' THEN
      RAISE EXCEPTION 'illegal decision disposition transition: only an accepted decision records an observed outcome (decision % is %)', OLD.decision_id, OLD.disposition;
    END IF;
    IF OLD.observed_outcome IS NOT NULL OR OLD.outcome_at IS NOT NULL THEN
      RAISE EXCEPTION 'illegal decision disposition transition: decision % already recorded its observed outcome exactly once', OLD.decision_id;
    END IF;
    IF NEW.observed_outcome IS NULL OR NEW.outcome_at IS NULL THEN
      RAISE EXCEPTION 'illegal decision disposition transition: the observed outcome of decision % requires its payload and timestamp', OLD.decision_id;
    END IF;
    IF NEW.successor_decision_id IS DISTINCT FROM OLD.successor_decision_id
       OR NEW.disposition_at IS DISTINCT FROM OLD.disposition_at THEN
      RAISE EXCEPTION 'illegal decision disposition transition: an outcome observation must not rewrite the disposition metadata of decision %', OLD.decision_id;
    END IF;
    RETURN NEW;
  END IF;
  -- The disposition-transition path.
  IF NOT (
       (OLD.disposition = 'proposed' AND NEW.disposition = 'accepted')
    OR (OLD.disposition = 'proposed' AND NEW.disposition = 'rejected')
    OR (OLD.disposition = 'proposed' AND NEW.disposition = 'superseded')
  ) THEN
    RAISE EXCEPTION 'illegal decision disposition transition: % → % is rejected on decision %', OLD.disposition, NEW.disposition, OLD.decision_id;
  END IF;
  IF NEW.observed_outcome IS NOT NULL OR NEW.outcome_at IS NOT NULL
     OR NEW.execution_ref IS NOT NULL OR NEW.deployment_ref IS NOT NULL
     OR NEW.learning_ref IS NOT NULL THEN
    RAISE EXCEPTION 'illegal decision disposition transition: a disposition must not set the outcome columns of decision %', OLD.decision_id;
  END IF;
  IF NEW.disposition_at IS NULL THEN
    RAISE EXCEPTION 'illegal decision disposition transition: the disposition of decision % requires its timestamp', OLD.decision_id;
  END IF;
  IF NEW.disposition = 'superseded' THEN
    IF NEW.successor_decision_id IS NULL THEN
      RAISE EXCEPTION 'supersede requires a live correction successor: decision % must name its successor', OLD.decision_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM decisions s
        WHERE s.decision_id = NEW.successor_decision_id
          AND s.client_id = OLD.client_id
          AND s.predecessor_decision_id = OLD.decision_id
          AND s.disposition = 'proposed') THEN
      RAISE EXCEPTION 'supersede requires a live correction successor: decision % successor must be a same-client proposed correction of it', OLD.decision_id;
    END IF;
  ELSE
    IF NEW.successor_decision_id IS NOT NULL THEN
      RAISE EXCEPTION 'illegal decision disposition transition: only a superseded decision carries a successor (decision %)', OLD.decision_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS decision_lifecycle_guard_trigger ON decisions;
CREATE TRIGGER decision_lifecycle_guard_trigger
BEFORE UPDATE ON decisions
FOR EACH ROW EXECUTE FUNCTION decision_lifecycle_guard();

-- Scope backstop (TENANT-003 at the storage layer, migration 015/018/019/
-- 027 pattern): a workspace-scoped decision must reference a Workspace of
-- the SAME Client — the Client boundary cannot be crossed through the
-- workspace column even if every application check were bypassed.
CREATE OR REPLACE FUNCTION decision_workspace_within_client() RETURNS trigger AS $$
BEGIN
  IF NEW.workspace_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM workspaces w
        WHERE w.workspace_id = NEW.workspace_id AND w.client_id = NEW.client_id) THEN
      RAISE EXCEPTION 'decision % workspace % does not belong to client % — the workspace scope cannot cross the Client boundary',
        NEW.decision_id, NEW.workspace_id, NEW.client_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS decision_workspace_within_client_trigger ON decisions;
CREATE TRIGGER decision_workspace_within_client_trigger
BEFORE INSERT ON decisions
FOR EACH ROW EXECUTE FUNCTION decision_workspace_within_client();

-- Correction-link backstop: the predecessor must exist, belong to the
-- SAME Client and NOT already be superseded (a superseded decision
-- already has its replacement — correct the successor instead).
CREATE OR REPLACE FUNCTION decision_predecessor_legal() RETURNS trigger AS $$
DECLARE
  v_predecessor_client uuid;
  v_predecessor_disposition text;
BEGIN
  IF NEW.predecessor_decision_id IS NOT NULL THEN
    SELECT client_id, disposition INTO v_predecessor_client, v_predecessor_disposition
      FROM decisions WHERE decision_id = NEW.predecessor_decision_id;
    IF v_predecessor_client IS NULL THEN
      RAISE EXCEPTION 'decision % predecessor % is unknown — the correction link cannot point outside the ledger',
        NEW.decision_id, NEW.predecessor_decision_id;
    END IF;
    IF v_predecessor_client <> NEW.client_id THEN
      RAISE EXCEPTION 'decision % predecessor % belongs to another client — cross-tenant correction links are rejected',
        NEW.decision_id, NEW.predecessor_decision_id;
    END IF;
    IF v_predecessor_disposition = 'superseded' THEN
      RAISE EXCEPTION 'decision % predecessor % is already superseded — correct its successor instead',
        NEW.decision_id, NEW.predecessor_decision_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS decision_predecessor_legal_trigger ON decisions;
CREATE TRIGGER decision_predecessor_legal_trigger
BEFORE INSERT ON decisions
FOR EACH ROW EXECUTE FUNCTION decision_predecessor_legal();

-- Proposal-reference backstops (cross-tenant rejection, the migration 019
-- experiment-conclusion / 027 learning-refs pattern): a decision MAY cite
-- /evidence records and link an /experiments hypothesis, but ONLY ones
-- owned by the SAME Client — the cited authorities stay tenant-fenced
-- even when a decision links them (unknown references are rejected too,
-- belt-and-suspenders ahead of the FK-less jsonb array).
CREATE OR REPLACE FUNCTION decision_proposal_refs_same_client() RETURNS trigger AS $$
DECLARE
  v_ref text;
  v_ref_client uuid;
BEGIN
  FOR v_ref IN SELECT jsonb_array_elements_text(NEW.evidence_refs) LOOP
    IF v_ref !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'decision % cites a malformed evidence reference %', NEW.decision_id, v_ref;
    END IF;
    SELECT client_id INTO v_ref_client FROM evidence WHERE evidence_id = v_ref::uuid;
    IF v_ref_client IS NULL THEN
      RAISE EXCEPTION 'decision % cites unknown evidence %', NEW.decision_id, v_ref;
    END IF;
    IF v_ref_client <> NEW.client_id THEN
      RAISE EXCEPTION 'decision % cites evidence % of another client — cross-tenant evidence linkage is rejected',
        NEW.decision_id, v_ref;
    END IF;
  END LOOP;
  IF NEW.experiment_ref IS NOT NULL THEN
    SELECT client_id INTO v_ref_client FROM experiments WHERE experiment_id = NEW.experiment_ref;
    IF v_ref_client IS NULL THEN
      RAISE EXCEPTION 'decision % links unknown experiment %', NEW.decision_id, NEW.experiment_ref;
    END IF;
    IF v_ref_client <> NEW.client_id THEN
      RAISE EXCEPTION 'decision % links experiment % of another client — cross-tenant experiment linkage is rejected',
        NEW.decision_id, NEW.experiment_ref;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS decision_proposal_refs_same_client_trigger ON decisions;
CREATE TRIGGER decision_proposal_refs_same_client_trigger
BEFORE INSERT ON decisions
FOR EACH ROW EXECUTE FUNCTION decision_proposal_refs_same_client();

-- Outcome-reference backstop (cross-tenant rejection on the UPDATE path):
-- the observed outcome's execution/deployment/learning references must
-- belong to the SAME Client — checked exactly when the outcome columns
-- are being set (the race backstop behind the module's write-time
-- validation through the /executions, /deployments and /learnings public
-- contracts).
CREATE OR REPLACE FUNCTION decision_outcome_refs_same_client() RETURNS trigger AS $$
DECLARE
  v_ref_client uuid;
BEGIN
  IF NEW.learning_ref IS NOT NULL AND NEW.learning_ref IS DISTINCT FROM OLD.learning_ref THEN
    SELECT client_id INTO v_ref_client FROM learnings WHERE learning_id = NEW.learning_ref;
    IF v_ref_client IS NULL THEN
      RAISE EXCEPTION 'decision outcome references unknown learning % on decision %', NEW.learning_ref, NEW.decision_id;
    END IF;
    IF v_ref_client <> NEW.client_id THEN
      RAISE EXCEPTION 'decision outcome references learning % of another client — cross-tenant decision outcome references are rejected on decision %',
        NEW.learning_ref, NEW.decision_id;
    END IF;
  END IF;
  IF NEW.execution_ref IS NOT NULL AND NEW.execution_ref IS DISTINCT FROM OLD.execution_ref THEN
    SELECT client_id INTO v_ref_client FROM executions WHERE execution_id = NEW.execution_ref;
    IF v_ref_client IS NULL THEN
      RAISE EXCEPTION 'decision outcome references unknown execution % on decision %', NEW.execution_ref, NEW.decision_id;
    END IF;
    IF v_ref_client <> NEW.client_id THEN
      RAISE EXCEPTION 'decision outcome references execution % of another client — cross-tenant decision outcome references are rejected on decision %',
        NEW.execution_ref, NEW.decision_id;
    END IF;
  END IF;
  IF NEW.deployment_ref IS NOT NULL AND NEW.deployment_ref IS DISTINCT FROM OLD.deployment_ref THEN
    SELECT client_id INTO v_ref_client FROM deployments WHERE deployment_id = NEW.deployment_ref;
    IF v_ref_client IS NULL THEN
      RAISE EXCEPTION 'decision outcome references unknown deployment % on decision %', NEW.deployment_ref, NEW.decision_id;
    END IF;
    IF v_ref_client <> NEW.client_id THEN
      RAISE EXCEPTION 'decision outcome references deployment % of another client — cross-tenant decision outcome references are rejected on decision %',
        NEW.deployment_ref, NEW.decision_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS decision_outcome_refs_same_client_trigger ON decisions;
CREATE TRIGGER decision_outcome_refs_same_client_trigger
BEFORE UPDATE ON decisions
FOR EACH ROW EXECUTE FUNCTION decision_outcome_refs_same_client();
