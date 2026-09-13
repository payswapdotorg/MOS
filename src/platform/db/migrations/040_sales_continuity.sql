-- MKT-046 Sales-to-Delivery Continuity schema (the continuity ledger —
-- spec/architecture-v1.5.md §8; the primary contract
-- spec/operating-graph-v1.5.md "Sales-to-delivery continuity"; frozen by
-- spec/architecture-lock-v1.5.md rule #15 and the singular-authorities
-- list of spec/architecture-v1.5.md §2). PostgreSQL is the system of
-- record (spec/architecture-lock.md).
--
-- Table ownership follows the authority map:
-- sales_continuity_carries, sales_continuity_events → /sales-continuity
--
-- DISCLOSED PERSISTENCE CHOICE (AC-6): the existing /playbooks and
-- /deployments public creation commands expose NO provenance-carrying
-- surface (no source-reference fields), so the module OWNS this
-- append-only continuity ledger — the 035/036 house style. The module
-- ORCHESTRATES the /playbooks and /deployments creation commands and
-- NEVER writes their tables; this migration creates/alters NOTHING
-- outside the two sales_continuity_* tables. The ledger carries:
--
--   * the SOURCE references (the canonical proposal decision id + the
--     exact-content fingerprint — the proposal VERSION identity: the
--     /decisions ledger is append-only, corrections are NEW records, so
--     the decisionId IS the version and the create_fingerprint is the
--     content proof);
--   * the CARRIED RECORD references (playbook id + version id + version
--     number, later deployment id) — the delivery-side linkage the
--     round-trip reads;
--   * the CARRIED STRUCTURE SNAPSHOT (carried_payload jsonb — the
--     derived scope/goals/outcomes/assumptions/economics, byte-stable
--     after the claim);
--   * the §8-style logical create identity (idempotency key +
--     create fingerprint) and the server-derived provenance columns.
--
-- Frozen semantics encoded here:
--
-- * THE FORWARD-ONLY COMPLETION LADDER: carry_state IN ('carrying',
--   'carried', 'deployed'). The identity columns are IMMUTABLE after
--   insert (trigger); ONLY the completion columns may change, and only
--   forward: the playbook completion sets the playbook references
--   exactly once (from NULL) together with carrying → carried; the
--   deployment completion sets carried_deployment_id exactly once
--   (from NULL) together with carried → deployed. Backwards moves,
--   repeated rewrites, mismatched pairs and completions that skip the
--   ladder are rejected by trigger (the old carried identity is
--   preserved, never rewritten — AC-5).
-- * THE SOURCE FENCE (the disclosed duplicate guard): UNIQUE
--   (source_decision_id) — one carry per proposal version. A re-carry
--   of the SAME decision converges at the module layer; a NEW proposal
--   version (a successor decision record) is a different decision id
--   and therefore a NEW carry row with FRESH identity.
-- * THE §8 LOGICAL CREATE FENCE: UNIQUE (client_id, idempotency_key)
--   ("Application-level check-then-insert is insufficient as the sole
--   duplicate fence").
-- * TENANT FENCES (TENANT-003 hard boundary): client_id is NOT NULL;
--   the source decision, the carried playbook, the carried playbook
--   version and the carried deployment must all belong to the SAME
--   Client (triggers — cross-tenant rejection, the migration
--   019/027/036 pattern). There is deliberately NO ON DELETE CASCADE —
--   continuity linkage history is durable.
-- * NO PROVIDER STATE: no provider ids, no SDK-shaped columns, no
--   workflow/execution machinery. The module never validates or
--   activates deployments (that stays the /deployments authority's
--   MKT-040 gate) and never mutates decisions, playbooks or workflow
--   state.
-- * The carried_payload snapshot is shape-CHECKed at the storage layer:
--   an object carrying the five frozen §8 dimensions (scope, goals,
--   outcomes, assumptions, economics) + the source block with the
--   derivation version — the module guard is the primary check, this
--   CHECK is the backstop.
--
-- No owner/role/user columns: authorization stays exactly the /agencies
-- membership authority composed with the canonical ownership resolutions
-- of /decisions (proposal anchor), /playbooks (delivery side) and
-- /clients (the carry's own scope) — no second tenant/permission
-- authority.

CREATE TABLE IF NOT EXISTS sales_continuity_carries (
  carry_id                    uuid        PRIMARY KEY,
  client_id                   uuid        NOT NULL REFERENCES clients(client_id),
  agency_id                   uuid        NOT NULL REFERENCES agencies(agency_id),
  source_workspace_id         uuid        REFERENCES workspaces(workspace_id),
  -- The SOURCE references (AC-4): the canonical proposal record + the
  -- exact-version content proof. FK to the /decisions authority's table
  -- (a reference, never a write).
  source_decision_id          uuid        NOT NULL REFERENCES decisions(decision_id),
  source_fingerprint          text        NOT NULL CHECK (length(source_fingerprint) >= 1
                                          AND length(source_fingerprint) <= 300),
  -- The CARRIED RECORD references (the delivery-side linkage; one-shot
  -- forward-only completion columns, trigger-fenced).
  carried_playbook_id         uuid        REFERENCES playbooks(playbook_id),
  carried_playbook_version_id uuid        REFERENCES playbook_versions(version_id),
  carried_version_number      integer     CHECK (carried_version_number IS NULL
                                          OR carried_version_number >= 1),
  carried_deployment_id       uuid        REFERENCES deployments(deployment_id),
  carry_state                 text        NOT NULL DEFAULT 'carrying'
                                          CHECK (carry_state IN ('carrying', 'carried',
                                          'deployed')),
  carried_payload             jsonb       NOT NULL CHECK (jsonb_typeof(carried_payload) = 'object'
                                          AND carried_payload ? 'derivationVersion'
                                          AND length(carried_payload ->> 'derivationVersion') >= 1
                                          AND carried_payload ? 'source'
                                          AND carried_payload ? 'scope'
                                          AND carried_payload ? 'goals'
                                          AND carried_payload ? 'outcomes'
                                          AND carried_payload ? 'assumptions'
                                          AND carried_payload ? 'economics'),
  idempotency_key             text        NOT NULL CHECK (length(idempotency_key) >= 1
                                          AND length(idempotency_key) <= 200),
  create_fingerprint          text        NOT NULL CHECK (length(create_fingerprint) >= 1
                                          AND length(create_fingerprint) <= 300),
  recorded_actor              text        NOT NULL,
  recorded_via                text        NOT NULL CHECK (length(recorded_via) >= 1
                                          AND length(recorded_via) <= 100),
  correlation_id              text        NOT NULL,
  causation_id                text,
  recorded_at                 timestamptz NOT NULL DEFAULT now(),
  -- The completion shape (row CHECKs behind the module CAS + the
  -- forward-only trigger below):
  --   * a claim carries NOTHING yet (all carried refs NULL);
  --   * a carried/deployed row carries its playbook references together;
  --   * only a deployed row carries a deployment reference.
  CONSTRAINT carry_completion_shape CHECK (
    (carry_state = 'carrying'
       AND carried_playbook_id IS NULL AND carried_playbook_version_id IS NULL
       AND carried_version_number IS NULL AND carried_deployment_id IS NULL)
    OR (carry_state = 'carried'
       AND carried_playbook_id IS NOT NULL AND carried_playbook_version_id IS NOT NULL
       AND carried_version_number IS NOT NULL AND carried_deployment_id IS NULL)
    OR (carry_state = 'deployed'
       AND carried_playbook_id IS NOT NULL AND carried_playbook_version_id IS NOT NULL
       AND carried_version_number IS NOT NULL AND carried_deployment_id IS NOT NULL)
  )
);

-- THE SOURCE FENCE: one carry per proposal version (the disclosed
-- duplicate guard — the proposal version identity is the decision id).
CREATE UNIQUE INDEX IF NOT EXISTS sales_continuity_carries_source_decision_id_key
ON sales_continuity_carries (source_decision_id);

-- The §8 logical create fence: one logical create key per Client.
CREATE UNIQUE INDEX IF NOT EXISTS sales_continuity_carries_idempotency_key_unique
ON sales_continuity_carries (client_id, idempotency_key);

-- Listing surfaces: the Client's carries (newest first by
-- server-recorded time), the source-decision lookup (the proposal →
-- carried records view) and the carried-playbook lookup (the
-- delivery-side → proposal round-trip view).
CREATE INDEX IF NOT EXISTS sales_continuity_carries_client_idx
ON sales_continuity_carries (client_id, recorded_at, carry_id);

CREATE INDEX IF NOT EXISTS sales_continuity_carries_carried_playbook_idx
ON sales_continuity_carries (carried_playbook_id) WHERE carried_playbook_id IS NOT NULL;

-- The APPEND-ONLY continuity event tail: one row per leg (the claim,
-- the playbook completion, the deployment completion), carrying the
-- completion detail verbatim.
CREATE TABLE IF NOT EXISTS sales_continuity_events (
  event_id                    uuid        PRIMARY KEY,
  carry_id                    uuid        NOT NULL REFERENCES sales_continuity_carries(carry_id),
  event_kind                  text        NOT NULL CHECK (event_kind IN ('carry-claimed',
                                          'playbook-carried', 'deployment-carried')),
  detail                      jsonb       NOT NULL DEFAULT '{}'::jsonb
                                          CHECK (jsonb_typeof(detail) = 'object'),
  idempotency_key             text        NOT NULL CHECK (length(idempotency_key) >= 1
                                          AND length(idempotency_key) <= 200),
  recorded_actor              text        NOT NULL,
  recorded_via                text        NOT NULL CHECK (length(recorded_via) >= 1
                                          AND length(recorded_via) <= 100),
  correlation_id              text        NOT NULL,
  causation_id                text,
  recorded_at                 timestamptz NOT NULL DEFAULT now()
);

-- The §8 event fence: one logical command key per carry.
CREATE UNIQUE INDEX IF NOT EXISTS sales_continuity_events_idempotency_key_unique
ON sales_continuity_events (carry_id, idempotency_key);

CREATE INDEX IF NOT EXISTS sales_continuity_events_carry_idx
ON sales_continuity_events (carry_id, recorded_at, event_id);

-- APPEND-ONLY backstop (the migration 015/018/019/027/036 pattern): the
-- database itself rejects UPDATE and DELETE on the continuity event
-- tail. Not even server code can rewrite carry history.
CREATE OR REPLACE FUNCTION sales_continuity_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'sales continuity events are append-only: % is rejected on continuity event %', TG_OP, OLD.event_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sales_continuity_events_append_only_update_trigger ON sales_continuity_events;
CREATE TRIGGER sales_continuity_events_append_only_update_trigger
BEFORE UPDATE ON sales_continuity_events
FOR EACH ROW EXECUTE FUNCTION sales_continuity_events_append_only();

DROP TRIGGER IF EXISTS sales_continuity_events_append_only_delete_trigger ON sales_continuity_events;
CREATE TRIGGER sales_continuity_events_append_only_delete_trigger
BEFORE DELETE ON sales_continuity_events
FOR EACH ROW EXECUTE FUNCTION sales_continuity_events_append_only();

-- The carry rows themselves are never ERASED either: a BEFORE DELETE
-- trigger rejects every delete (the migration 027/036 pattern — the
-- linkage history is the point of the ledger).
CREATE OR REPLACE FUNCTION sales_continuity_carries_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'sales continuity carries are append-only linkage history: DELETE is rejected on carry %', OLD.carry_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sales_continuity_carries_no_delete_trigger ON sales_continuity_carries;
CREATE TRIGGER sales_continuity_carries_no_delete_trigger
BEFORE DELETE ON sales_continuity_carries
FOR EACH ROW EXECUTE FUNCTION sales_continuity_carries_no_delete();

-- IDENTITY-IMMUTABILITY backstop: a BEFORE UPDATE trigger rejects ANY
-- change to the identity columns (scope chain, source references,
-- §8 logical create identity, provenance, the carried snapshot and the
-- row identity itself). ONLY the completion columns may change — and
-- only through the forward-only completion trigger below.
CREATE OR REPLACE FUNCTION sales_continuity_carry_identity_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.carry_id                    IS DISTINCT FROM OLD.carry_id
     OR NEW.client_id                IS DISTINCT FROM OLD.client_id
     OR NEW.agency_id                IS DISTINCT FROM OLD.agency_id
     OR NEW.source_workspace_id      IS DISTINCT FROM OLD.source_workspace_id
     OR NEW.source_decision_id       IS DISTINCT FROM OLD.source_decision_id
     OR NEW.source_fingerprint       IS DISTINCT FROM OLD.source_fingerprint
     OR NEW.carried_payload          IS DISTINCT FROM OLD.carried_payload
     OR NEW.idempotency_key          IS DISTINCT FROM OLD.idempotency_key
     OR NEW.create_fingerprint       IS DISTINCT FROM OLD.create_fingerprint
     OR NEW.recorded_actor           IS DISTINCT FROM OLD.recorded_actor
     OR NEW.recorded_via             IS DISTINCT FROM OLD.recorded_via
     OR NEW.correlation_id           IS DISTINCT FROM OLD.correlation_id
     OR NEW.causation_id             IS DISTINCT FROM OLD.causation_id
     OR NEW.recorded_at              IS DISTINCT FROM OLD.recorded_at THEN
    RAISE EXCEPTION 'the carry identity is immutable: rewriting carry % identity/snapshot/audit columns is rejected', OLD.carry_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sales_continuity_carry_identity_immutable_trigger ON sales_continuity_carries;
CREATE TRIGGER sales_continuity_carry_identity_immutable_trigger
BEFORE UPDATE ON sales_continuity_carries
FOR EACH ROW EXECUTE FUNCTION sales_continuity_carry_identity_immutable();

-- FORWARD-ONLY COMPLETION backstop (the frozen ladder as a DB trigger —
-- the race backstop behind the module's CAS updates):
--   * carrying → carried requires the playbook references to appear
--     TOGETHER, from NULL, and nothing else to change;
--   * carried → deployed requires the deployment reference to appear,
--     from NULL, and nothing else to change;
--   * every other transition (backwards, repeated, skipping) rejects.
CREATE OR REPLACE FUNCTION sales_continuity_carry_completion_guard() RETURNS trigger AS $$
BEGIN
  -- The playbook-completion edge.
  IF OLD.carry_state = 'carrying' AND NEW.carry_state = 'carried' THEN
    IF OLD.carried_playbook_id IS NOT NULL
       OR OLD.carried_playbook_version_id IS NOT NULL
       OR OLD.carried_version_number IS NOT NULL THEN
      RAISE EXCEPTION 'carry completion is forward-only: carry % already carries playbook references', OLD.carry_id;
    END IF;
    IF NEW.carried_playbook_id IS NULL OR NEW.carried_playbook_version_id IS NULL
       OR NEW.carried_version_number IS NULL THEN
      RAISE EXCEPTION 'carry completion is forward-only: carrying → carried requires the playbook references together (carry %)', OLD.carry_id;
    END IF;
    IF NEW.carried_deployment_id IS NOT NULL THEN
      RAISE EXCEPTION 'carry completion is forward-only: the deployment reference may only appear with carried → deployed (carry %)', OLD.carry_id;
    END IF;
    RETURN NEW;
  END IF;
  -- The deployment-completion edge.
  IF OLD.carry_state = 'carried' AND NEW.carry_state = 'deployed' THEN
    IF OLD.carried_deployment_id IS NOT NULL THEN
      RAISE EXCEPTION 'carry completion is forward-only: carry % already carries a deployment reference', OLD.carry_id;
    END IF;
    IF NEW.carried_deployment_id IS NULL THEN
      RAISE EXCEPTION 'carry completion is forward-only: carried → deployed requires the deployment reference (carry %)', OLD.carry_id;
    END IF;
    IF NEW.carried_playbook_id IS DISTINCT FROM OLD.carried_playbook_id
       OR NEW.carried_playbook_version_id IS DISTINCT FROM OLD.carried_playbook_version_id
       OR NEW.carried_version_number IS DISTINCT FROM OLD.carried_version_number THEN
      RAISE EXCEPTION 'carry completion is forward-only: the playbook references of carry % never change after completion', OLD.carry_id;
    END IF;
    RETURN NEW;
  END IF;
  -- Everything else (no-op updates pass through for the row CHECKs).
  IF NEW.carry_state = OLD.carry_state
     AND NEW.carried_playbook_id IS NOT DISTINCT FROM OLD.carried_playbook_id
     AND NEW.carried_playbook_version_id IS NOT DISTINCT FROM OLD.carried_playbook_version_id
     AND NEW.carried_version_number IS NOT DISTINCT FROM OLD.carried_version_number
     AND NEW.carried_deployment_id IS NOT DISTINCT FROM OLD.carried_deployment_id THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'carry completion is forward-only: % → % with changed completion columns is rejected on carry %', OLD.carry_state, NEW.carry_state, OLD.carry_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sales_continuity_carry_completion_guard_trigger ON sales_continuity_carries;
CREATE TRIGGER sales_continuity_carry_completion_guard_trigger
BEFORE UPDATE ON sales_continuity_carries
FOR EACH ROW EXECUTE FUNCTION sales_continuity_carry_completion_guard();

-- CROSS-TENANT reference backstops (TENANT-003 at the storage layer, the
-- migration 019/027/036 pattern — the module validates through the
-- public contracts first; these triggers are the race backstops):
--   * the source decision must belong to the SAME Client;
--   * the source workspace scope must live INSIDE the owning Client;
--   * the carried playbook must be Client-scoped to the SAME Client;
--   * the carried playbook version must belong to the carried playbook;
--   * the carried deployment must belong to the SAME Client.
CREATE OR REPLACE FUNCTION sales_continuity_carry_reference_fences() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM decisions d
      WHERE d.decision_id = NEW.source_decision_id AND d.client_id = NEW.client_id) THEN
    RAISE EXCEPTION 'carry % source decision % does not belong to client % — the proposal reference cannot cross the Client boundary',
      NEW.carry_id, NEW.source_decision_id, NEW.client_id;
  END IF;
  IF NEW.source_workspace_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM workspaces w
        WHERE w.workspace_id = NEW.source_workspace_id AND w.client_id = NEW.client_id) THEN
      RAISE EXCEPTION 'carry % source workspace % does not belong to client % — the workspace scope cannot cross the Client boundary',
        NEW.carry_id, NEW.source_workspace_id, NEW.client_id;
    END IF;
  END IF;
  IF NEW.carried_playbook_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM playbooks p
        WHERE p.playbook_id = NEW.carried_playbook_id AND p.client_id = NEW.client_id) THEN
      RAISE EXCEPTION 'carry % carried playbook % does not belong to client % — the carried reference cannot cross the Client boundary',
        NEW.carry_id, NEW.carried_playbook_id, NEW.client_id;
    END IF;
  END IF;
  IF NEW.carried_playbook_version_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM playbook_versions v
        WHERE v.version_id = NEW.carried_playbook_version_id
          AND v.playbook_id = NEW.carried_playbook_id) THEN
      RAISE EXCEPTION 'carry % carried playbook version % does not belong to the carried playbook %',
        NEW.carry_id, NEW.carried_playbook_version_id, NEW.carried_playbook_id;
    END IF;
  END IF;
  IF NEW.carried_deployment_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM deployments dep
        WHERE dep.deployment_id = NEW.carried_deployment_id AND dep.client_id = NEW.client_id) THEN
      RAISE EXCEPTION 'carry % carried deployment % does not belong to client % — the carried reference cannot cross the Client boundary',
        NEW.carry_id, NEW.carried_deployment_id, NEW.client_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sales_continuity_carry_reference_fences_trigger ON sales_continuity_carries;
CREATE TRIGGER sales_continuity_carry_reference_fences_trigger
BEFORE INSERT OR UPDATE ON sales_continuity_carries
FOR EACH ROW EXECUTE FUNCTION sales_continuity_carry_reference_fences();
