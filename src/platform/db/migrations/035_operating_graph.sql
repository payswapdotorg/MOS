-- 035_operating_graph.sql — MKT-041 (Agency Operating Graph).
--
-- The v1.5 Operating Graph is a DERIVED COORDINATION MODEL over the canonical
-- authorities (spec/operating-graph-v1.5.md; spec/architecture-v1.5.md §3;
-- architecture-lock-v1.5 #4: "The Operating Graph is a derived
-- coordination/read-write composition model and never a replacement for those
-- authorities"). Two durable structures, BOTH holding SOURCE REFERENCES ONLY —
-- canonical identifiers, kinds and the workspace/client/agency scope chain —
-- never a copy of authoritative shape: the exact reference-only column
-- inventory is asserted by tests/architecture/operating-graph-boundary.test.ts:
--
--   - `operating_graph_nodes`: the canonical-record registry. ONE row per
--     (node_kind, node_id) ever observed by a rebuild — the node kind
--     vocabulary is a closed CHECK over the twelve existing authorities the
--     v1.5 chain covers (Prospect/Outcome/economics authorities do not exist
--     yet; they extend this list in later Work Items). Rows are registry
--     entries, not copies: identity + scope + first_seen/last_refreshed only.
--
--   - `operating_graph_edges`: the APPEND-ORIENTED, VERSIONED relation ledger.
--     Every row is one derived relation between two canonical records, scoped
--     to one Client graph (agency/client/workspace scope chain), carrying the
--     frozen five-value epistemic vocabulary (unknown/observed/predicted/
--     attributed/causal — spec/operating-graph-v1.5.md: "unknown, observed,
--     predicted, attributed and causal states stay distinct"). Versions are
--     append-only: corrections are NEW rows (higher edge_version), the prior
--     row stays addressable forever; the single sanctioned UPDATE is the
--     supersession transition (is_current true → false with superseded_at
--     set) — every recorded column is immutable and DELETE is rejected.
--
-- The database is the final backstop for every material invariant (the
-- migration 003/004/034 pattern):
--   - the closed node-kind, relation and edge-state vocabularies are CHECKs;
--   - the scope chain cannot be crossed (workspace ∈ client ∈ agency);
--   - edge endpoints cannot cross the tenant (endpoint nodes must exist with
--     a scope consistent with the edge — a cross-client or cross-agency
--     endpoint is rejected even if every application check were bypassed);
--   - within one Client graph a (from, relation, to) resolves to at most ONE
--     current row (partial unique fence) and each version is assigned once
--     (full unique constraint);
--   - derived-edge history is never rewritten (append-only trigger) and the
--     node registry never changes identity/scope (registry-discipline
--     trigger).
--
-- NO authoritative table of another module is created, altered or referenced
-- for writes: the graph rebuilds READ the authorities through their public
-- contracts (the frozen matrix line added for MKT-041) and write ONLY the two
-- derived structures above.

-- ---------------------------------------------------------------------------
-- The canonical-record registry
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS operating_graph_nodes (
    node_kind          text        NOT NULL
                       CHECK (node_kind IN ('client', 'goal', 'playbook', 'playbook_version',
                                            'deployment', 'workflow', 'workflow_definition',
                                            'workflow_instance', 'execution', 'evidence',
                                            'experiment', 'learning')),
    node_id            uuid        NOT NULL,
    -- The record's OWN scope chain (agency-scoped records carry client NULL).
    agency_id          uuid        NOT NULL REFERENCES agencies(agency_id) ON DELETE CASCADE,
    client_id          uuid        REFERENCES clients(client_id) ON DELETE CASCADE,
    workspace_id       uuid        REFERENCES workspaces(workspace_id),
    first_seen_at      timestamptz NOT NULL DEFAULT now(),
    last_refreshed_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT operating_graph_nodes_pk PRIMARY KEY (node_kind, node_id)
);

-- Listing surface: the registry rows of one Agency's Clients.
CREATE INDEX IF NOT EXISTS operating_graph_nodes_client_idx
    ON operating_graph_nodes (client_id, node_kind) WHERE client_id IS NOT NULL;

-- Tenant fence (the migration 003/018/034 pattern): a node's workspace must
-- belong to its client and its client to its agency — the scope chain cannot
-- be crossed even if every application check were bypassed.
CREATE OR REPLACE FUNCTION operating_graph_scope_chain_consistent() RETURNS trigger AS $$
BEGIN
    IF NEW.client_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM clients c
        WHERE c.client_id = NEW.client_id AND c.agency_id = NEW.agency_id) THEN
        RAISE EXCEPTION 'operating graph node/edge scope: client % does not belong to agency % — the tenant scope chain cannot be crossed',
            NEW.client_id, NEW.agency_id;
    END IF;
    IF NEW.workspace_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workspaces w
        WHERE w.workspace_id = NEW.workspace_id AND w.client_id = NEW.client_id) THEN
        RAISE EXCEPTION 'operating graph node/edge scope: workspace % does not belong to client % — the tenant scope chain cannot be crossed',
            NEW.workspace_id, NEW.client_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS operating_graph_nodes_scope_chain_trigger ON operating_graph_nodes;
CREATE TRIGGER operating_graph_nodes_scope_chain_trigger
    BEFORE INSERT OR UPDATE OF agency_id, client_id, workspace_id ON operating_graph_nodes
    FOR EACH ROW EXECUTE FUNCTION operating_graph_scope_chain_consistent();

-- Registry discipline: a node row's identity and scope are immutable — only
-- the refresh timestamp may ever move. DELETE is rejected: the registry is
-- append/refresh-only (derived history stays addressable).
CREATE OR REPLACE FUNCTION operating_graph_nodes_registry_discipline() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'operating graph registry rows are retained (append-oriented registry): DELETE is rejected on % %',
            OLD.node_kind, OLD.node_id;
    END IF;
    IF NEW.node_kind <> OLD.node_kind OR NEW.node_id <> OLD.node_id
       OR NEW.agency_id <> OLD.agency_id
       OR NEW.client_id IS DISTINCT FROM OLD.client_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.first_seen_at <> OLD.first_seen_at THEN
        RAISE EXCEPTION 'operating graph node % % identity and scope are immutable',
            OLD.node_kind, OLD.node_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS operating_graph_nodes_registry_trigger ON operating_graph_nodes;
CREATE TRIGGER operating_graph_nodes_registry_trigger
    BEFORE UPDATE OR DELETE ON operating_graph_nodes
    FOR EACH ROW EXECUTE FUNCTION operating_graph_nodes_registry_discipline();

-- ---------------------------------------------------------------------------
-- The append-oriented, versioned relation ledger
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS operating_graph_edges (
    edge_id       uuid        PRIMARY KEY,
    -- The scope chain of the owning CLIENT GRAPH (the from endpoint's home).
    agency_id     uuid        NOT NULL REFERENCES agencies(agency_id) ON DELETE CASCADE,
    client_id     uuid        NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
    workspace_id  uuid        REFERENCES workspaces(workspace_id),
    -- The relation endpoints: canonical ids only (source references).
    from_kind     text        NOT NULL
                  CHECK (from_kind IN ('client', 'goal', 'playbook', 'playbook_version',
                                       'deployment', 'workflow', 'workflow_definition',
                                       'workflow_instance', 'execution', 'evidence',
                                       'experiment', 'learning')),
    from_id       uuid        NOT NULL,
    to_kind       text        NOT NULL
                  CHECK (to_kind IN ('client', 'goal', 'playbook', 'playbook_version',
                                     'deployment', 'workflow', 'workflow_definition',
                                     'workflow_instance', 'execution', 'evidence',
                                     'experiment', 'learning')),
    to_id         uuid        NOT NULL,
    -- The closed relation vocabulary (the v1.5 chain links derivable from the
    -- existing authorities).
    relation      text        NOT NULL
                  CHECK (relation IN ('has_goal', 'pursued_by_playbook', 'has_version',
                                      'pins_playbook_version', 'deploys_definition',
                                      'has_definition', 'pins_definition', 'executes_step',
                                      'runs_execution', 'has_evidence', 'supersedes',
                                      'runs_experiment', 'records_learning',
                                      'supported_by', 'derived_from')),
    -- The frozen five-value epistemic vocabulary (never conflated).
    edge_state    text        NOT NULL
                  CHECK (edge_state IN ('unknown', 'observed', 'predicted', 'attributed', 'causal')),
    -- Append-oriented versioning: corrections are NEW rows.
    edge_version  integer     NOT NULL CHECK (edge_version >= 1),
    is_current    boolean     NOT NULL DEFAULT true,
    superseded_at timestamptz,
    recorded_at   timestamptz NOT NULL DEFAULT now(),
    recorded_by   text        NOT NULL CHECK (length(recorded_by) >= 1 AND length(recorded_by) <= 100),
    -- Each version of a relation is assigned exactly once within one Client
    -- graph.
    CONSTRAINT operating_graph_edges_version_unique
        UNIQUE (client_id, from_kind, from_id, relation, to_kind, to_id, edge_version)
);

-- Listing surface: the CURRENT relations of one Client graph.
CREATE INDEX IF NOT EXISTS operating_graph_edges_client_current_idx
    ON operating_graph_edges (client_id, relation) WHERE is_current;

-- Traversal surface: relations by endpoint.
CREATE INDEX IF NOT EXISTS operating_graph_edges_from_idx
    ON operating_graph_edges (from_kind, from_id);

CREATE INDEX IF NOT EXISTS operating_graph_edges_to_idx
    ON operating_graph_edges (to_kind, to_id);

-- CURRENT FENCE: within one Client graph a (from, relation, to) resolves to
-- at most ONE current row — the database itself rejects a second writer
-- converging the same key concurrently (the migration 015 supersession-fence
-- pattern); corrections append the next version instead.
CREATE UNIQUE INDEX IF NOT EXISTS operating_graph_edges_current_fence
    ON operating_graph_edges (client_id, from_kind, from_id, relation, to_kind, to_id)
    WHERE is_current;

DROP TRIGGER IF EXISTS operating_graph_edges_scope_chain_trigger ON operating_graph_edges;
CREATE TRIGGER operating_graph_edges_scope_chain_trigger
    BEFORE INSERT OR UPDATE OF agency_id, client_id, workspace_id ON operating_graph_edges
    FOR EACH ROW EXECUTE FUNCTION operating_graph_scope_chain_consistent();

-- Cross-tenant endpoint fence: both endpoints must already be registered with
-- a scope consistent with the edge — an agency-scoped endpoint (client NULL,
-- e.g. an agency-reusable Playbook Version pinned by a Client's deployment)
-- is legal, but a cross-client or cross-agency endpoint is rejected at the
-- storage layer even if every application check were bypassed.
CREATE OR REPLACE FUNCTION operating_graph_edges_endpoints_in_scope() RETURNS trigger AS $$
DECLARE
    v_from record;
    v_to   record;
BEGIN
    SELECT agency_id, client_id INTO v_from
    FROM operating_graph_nodes WHERE node_kind = NEW.from_kind AND node_id = NEW.from_id;
    SELECT agency_id, client_id INTO v_to
    FROM operating_graph_nodes WHERE node_kind = NEW.to_kind AND node_id = NEW.to_id;
    IF v_from IS NOT NULL THEN
        IF v_from.agency_id <> NEW.agency_id THEN
            RAISE EXCEPTION 'operating graph edge %: from endpoint % % belongs to another agency — cross-tenant relations are rejected',
                NEW.edge_id, NEW.from_kind, NEW.from_id;
        END IF;
        IF v_from.client_id IS NOT NULL AND v_from.client_id <> NEW.client_id THEN
            RAISE EXCEPTION 'operating graph edge %: from endpoint % % belongs to another client — cross-tenant relations are rejected',
                NEW.edge_id, NEW.from_kind, NEW.from_id;
        END IF;
    END IF;
    IF v_to IS NOT NULL THEN
        IF v_to.agency_id <> NEW.agency_id THEN
            RAISE EXCEPTION 'operating graph edge %: to endpoint % % belongs to another agency — cross-tenant relations are rejected',
                NEW.edge_id, NEW.to_kind, NEW.to_id;
        END IF;
        IF v_to.client_id IS NOT NULL AND v_to.client_id <> NEW.client_id THEN
            RAISE EXCEPTION 'operating graph edge %: to endpoint % % belongs to another client — cross-tenant relations are rejected',
                NEW.edge_id, NEW.to_kind, NEW.to_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS operating_graph_edges_endpoints_trigger ON operating_graph_edges;
CREATE TRIGGER operating_graph_edges_endpoints_trigger
    BEFORE INSERT OR UPDATE OF from_kind, from_id, to_kind, to_id ON operating_graph_edges
    FOR EACH ROW EXECUTE FUNCTION operating_graph_edges_endpoints_in_scope();

-- APPEND-ONLY history: DELETE is rejected; the ONLY sanctioned UPDATE is the
-- supersession transition (is_current true → false with superseded_at set).
-- Endpoints, relation, epistemic state, version, scope chain and provenance
-- are immutable — corrections are NEW rows (the migration 015/027 pattern).
CREATE OR REPLACE FUNCTION operating_graph_edges_history_preserved() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'operating graph edges are append-only: DELETE is rejected on edge %',
            OLD.edge_id;
    END IF;
    IF NEW.from_kind <> OLD.from_kind OR NEW.from_id <> OLD.from_id
       OR NEW.to_kind <> OLD.to_kind OR NEW.to_id <> OLD.to_id
       OR NEW.relation <> OLD.relation OR NEW.edge_state <> OLD.edge_state
       OR NEW.edge_version <> OLD.edge_version
       OR NEW.agency_id <> OLD.agency_id OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.recorded_at <> OLD.recorded_at OR NEW.recorded_by <> OLD.recorded_by THEN
        RAISE EXCEPTION 'operating graph edge % is append-only: the recorded relation columns are immutable (corrections are new versions)',
            OLD.edge_id;
    END IF;
    IF NOT (OLD.is_current AND NOT NEW.is_current
            AND OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL) THEN
        RAISE EXCEPTION 'operating graph edge % permits only the supersession transition (current → superseded)',
            OLD.edge_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS operating_graph_edges_history_trigger ON operating_graph_edges;
CREATE TRIGGER operating_graph_edges_history_trigger
    BEFORE UPDATE OR DELETE ON operating_graph_edges
    FOR EACH ROW EXECUTE FUNCTION operating_graph_edges_history_preserved();
