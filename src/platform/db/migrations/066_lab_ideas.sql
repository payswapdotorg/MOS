-- 066_lab_ideas.sql — LAB-004 (Idea Graph).
--
-- THE IDEA-GRAPH AUTHORITY (spec/effective-backlog-v1.7.md LAB-004:
-- "Map content into idea/problem/claim/hook/narrative/visual/audio/
-- packaging/CTA primitives. Acceptance: observed vs derived
-- separation, retrieval, clustering, novelty, recombination and
-- lineage."; dependencies satisfied: LAB-003 — the /lab-features
-- feature bundles cited BY REFERENCE); spec/
-- architecture-v1.7-marketing-lab.md §6 "Idea Graph" (THE frozen
-- contract: the primitive vocabulary — idea, problem, claim, hook,
-- narrative, visual treatment, audio treatment, packaging, CTA,
-- timing/context; the supports list — retrieval, clustering, novelty
-- measurement, recombination, mutation, analogy, deliberate
-- inversion, gap discovery; the separation — "The system MUST
-- distinguish: observed source idea; derived abstraction; generated
-- mutation; combined strategy" and "No generated idea is treated as
-- source evidence merely because it resembles an observed item");
-- §22 multi-tenancy; AGENTS.md v1.7 "Multimodal feature bundles and
-- Idea Graph abstractions are versioned and source-linked.";
-- architecture-lock-v1.7 rules 5/6/7/8/29:
--
--   lab_idea_decompositions      → the versioned IDEA-DECOMPOSITION
--                                  records (one per decomposition of
--                                  one cited feature bundle under one
--                                  idea-set version — the
--                                  DETERMINISTIC identity digest +
--                                  the append-only per-cited-bundle
--                                  version chain; the node/edge
--                                  counts SQL-COMPUTED at the single
--                                  completion advance);
--   lab_idea_nodes               → the CLIENT-SCOPED primitive NODE
--                                  records with the closed
--                                  primitive-kind vocabulary (10) and
--                                  THE CLOSED ORIGIN-CLASS VOCABULARY
--                                  (4) — the observed/derived/
--                                  generated/combined separation is
--                                  FENCED to the creation path:
--                                  observed_source ⟺ a decomposition
--                                  extracted it; every non-observed
--                                  node carries its CREATING
--                                  OPERATION + the RECORDED LINEAGE
--                                  (the ordered edge chain to its
--                                  observed ancestors — DATA, never
--                                  resemblance) + the creation-time
--                                  novelty score against the observed
--                                  graph;
--   lab_idea_edges               → the relation edges with the closed
--                                  8-relation vocabulary, each
--                                  asserted by exactly ONE creator
--                                  (a decomposition or an operation);
--   lab_idea_operations          → the first-class append-only graph
--                                  OPERATION records (derive/recombine/
--                                  mutate/analogy/invert/fill_gap —
--                                  the §6 supports list as recorded
--                                  operations) with the CHECK-fenced
--                                  operation-kind/output-origin
--                                  pairing;
--   lab_idea_operation_inputs    → the append-only input tail (the
--                                  cited input nodes, ordered);
--   lab_idea_cluster_runs        → the versioned CLUSTERING runs
--                                  (born running, the single guarded
--                                  completion advance with the
--                                  summary SQL-COMPUTED from the
--                                  assignment rows; one run per
--                                  (client, clustering version));
--   lab_idea_cluster_assignments → the append-only cluster
--                                  assignment records carrying the
--                                  version through their run — never
--                                  in-place rewrites.
--
-- Key fences:
--
-- * CHECK-fenced vocabularies on every enumerated column: the 10
--   primitive kinds (idea/problem/claim/hook/narrative/
--   visual_treatment/audio_treatment/packaging/cta/timing_context),
--   the 8 edge relations (supports/contradicts/refines/combines_with/
--   mutates_from/analog_to/inverts/fills_gap), the 4 origin classes
--   (observed_source/derived_abstraction/generated_mutation/
--   combined_strategy), the 6 operation kinds (derive/recombine/mutate/
--   analogy/invert/fill_gap) with the CHECK-fenced kind→origin
--   pairing, the pinned versions ('lab-ideas-contract-v1',
--   'lab-ideaset-v1', 'lab-idea-clustering-v1', 'lab-idea-novelty-v1').
-- * THE OBSERVED-DERIVED-GENERATED-COMBINED SEPARATION (the core
--   acceptance, structural at the DB): (origin_class =
--   'observed_source') ⟺ decomposition_id IS NOT NULL ⟺ lineage IS
--   NULL ⟺ novelty_score IS NULL ⟺ cited_bundle_reference IS NOT
--   NULL; (origin_class <> 'observed_source') ⟺ creating_operation_id
--   IS NOT NULL ⟺ creating_operation_kind IS NOT NULL. A generated
--   idea can NEVER carry a decomposition anchor or a bundle citation;
--   an observed idea can NEVER carry a recorded lineage or a novelty
--   score — no mixed-origin row is expressible.
-- * REPRODUCIBLE DECOMPOSITION IDENTITY (the LAB-003 discipline):
--   the identity_digest is a pure-function SHA-256 over the canonical
--   serialization of (the cited bundle identity fields, the idea-set
--   version, the decomposer identity+version, the input digest) —
--   UNIQUE (client_id, identity_digest) makes the deterministic
--   identity the idempotence fence; a changed idea-set/decomposer/
--   input version is a NEW decomposition_version row on the SAME
--   (client, cited bundle) chain (UNIQUE (client_id, bundle_id,
--   decomposition_version)) — append-only version chain per cited
--   bundle, never in-place rewrites.
-- * THE APPEND-ONLY DISCIPLINE: nodes, edges, operations, operation
--   inputs and cluster assignments are APPEND-ONLY OUTRIGHT (UPDATE
--   and DELETE both rejected); decompositions and cluster runs are
--   born 'running' and advance to 'completed' exactly once under the
--   guarded UPDATE trigger (identity/scope/citation columns
--   immutable; only the status, the SQL-computed summary counts and
--   updated_at may advance), and are never deleted.
-- * THE OPAQUE FEATURE-BUNDLE CITATION (the /lab family
--   by-reference discipline): the source linkage columns (bundle_id,
--   bundle_reference, bundle_version, reference_id, corpus_id,
--   corpus_version, provider, provider_content_id, canonical_url,
--   metadata_digest, feature_set_version, extractor_id,
--   extractor_version, bundle_identity_digest) are RECORDED DATA —
--   there is deliberately NO foreign key into lab_feature_bundles,
--   lab_corpus_references or ANY /lab, /lab-features, /lab-corpus or
--   v1.6 authority table: the citation is copied from the
--   /lab-features public surface by the caller.
-- * NO AUTHORITY TRANSFER / NO SHADOWING (§3 — structural): this
--   migration creates NO experiment, decision, evidence, metric,
--   publication, workflow or execution table and NO foreign key into
--   any of them; the FK anchors are EXACTLY the tenant tables
--   (agencies, clients, workspaces) + the same-module rows (node →
--   decomposition; edge → node × 2 + creator; operation → output
--   node; input → operation + node; assignment → run + node).
-- * THE RECORDED-DATA OPERATION BACK-REFERENCE (DISCLOSED): nodes
--   carry creating_operation_id as RECORDED DATA (no FK) because the
--   output node inserts BEFORE its operation row (the operation's
--   output_node_id FK is the STRONG same-module anchor, checked at
--   operation insert; the partial UNIQUE index on
--   nodes.creating_operation_id enforces the one-output-per-operation
--   pairing from the node side, and the module validates the id
--   pairing inside the same transaction).
-- * NO SECRET MATERIAL ANYWHERE (CRED-001): the only structured
--   payload columns are the bounded node attributes, the recorded
--   lineage chain and the bounded text descriptors — there is
--   deliberately NO column capable of holding secret, credential or
--   media-byte material.
--
-- Conventions (implementation-contract §3, §25): server-generated
-- opaque identifiers, append-oriented tails. No owner/role/user
-- columns: client-scope authorization stays exactly the
-- requireClientAccess route-layer authority — no second tenant,
-- permission or identity authority.

-- ---------------------------------------------------------------------------
-- lab_idea_decompositions — the versioned IDEA-DECOMPOSITION records
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_idea_decompositions (
    decomposition_id        uuid        PRIMARY KEY,
    -- THE APPEND-ONLY VERSION CHAIN: (client, cited bundle) → versions
    -- 1..N; re-decompositions under a NEW idea-set/decomposer/input
    -- version are NEW decomposition_version rows, never in-place
    -- rewrites.
    decomposition_version   integer     NOT NULL CHECK (decomposition_version >= 1 AND decomposition_version <= 1000),
    idea_set_version        text        NOT NULL
                            CHECK (idea_set_version IN ('lab-ideaset-v1')),
    -- Born running; the single guarded advance to completed (the
    -- completion update SQL-computes the node/edge counts from the
    -- tail rows in the same transaction).
    status                  text        NOT NULL
                            CHECK (status IN ('running', 'completed')),
    node_count              integer     NOT NULL DEFAULT 0 CHECK (node_count >= 0),
    edge_count              integer     NOT NULL DEFAULT 0 CHECK (edge_count >= 0),
    -- THE OPAQUE FEATURE-BUNDLE CITATION (recorded data, never a join
    -- — the /lab family by-reference discipline: NO FK into any
    -- /lab-features, /lab-corpus or v1.6 authority table).
    bundle_id               uuid        NOT NULL,
    bundle_reference        text        NOT NULL
                            CHECK (bundle_reference ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}#v[1-9][0-9]{0,3}$'),
    bundle_version          integer     NOT NULL CHECK (bundle_version >= 1 AND bundle_version <= 1000),
    reference_id            uuid        NOT NULL,
    corpus_id               uuid        NOT NULL,
    corpus_version          integer     NOT NULL CHECK (corpus_version >= 1),
    provider                text        NOT NULL CHECK (char_length(provider) >= 1 AND char_length(provider) <= 64),
    provider_content_id     text        NOT NULL CHECK (char_length(provider_content_id) >= 1 AND char_length(provider_content_id) <= 256),
    canonical_url           text        NOT NULL CHECK (char_length(canonical_url) >= 1 AND char_length(canonical_url) <= 2048),
    metadata_digest         text        NOT NULL CHECK (metadata_digest ~ '^[0-9a-f]{64}$'),
    feature_set_version     text        NOT NULL CHECK (char_length(feature_set_version) >= 1 AND char_length(feature_set_version) <= 64),
    extractor_id            text        NOT NULL CHECK (char_length(extractor_id) >= 1 AND char_length(extractor_id) <= 64),
    extractor_version       text        NOT NULL CHECK (char_length(extractor_version) >= 1 AND char_length(extractor_version) <= 64),
    bundle_identity_digest  text        NOT NULL CHECK (bundle_identity_digest ~ '^[0-9a-f]{64}$'),
    -- The decomposer identity (part of the deterministic identity).
    decomposer_id           text        NOT NULL CHECK (char_length(decomposer_id) >= 1 AND char_length(decomposer_id) <= 64),
    decomposer_version      text        NOT NULL CHECK (char_length(decomposer_version) >= 1 AND char_length(decomposer_version) <= 64),
    -- REPRODUCIBLE DECOMPOSITION IDENTITY: the pure-function SHA-256
    -- over (the cited bundle identity fields, the idea-set version,
    -- the decomposer identity+version, the input digest).
    identity_digest         text        NOT NULL CHECK (identity_digest ~ '^[0-9a-f]{64}$'),
    input_digest            text        NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
    agency_id               uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id               uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id            uuid        REFERENCES workspaces(workspace_id),
    contract_version        text        NOT NULL
                            CHECK (contract_version = 'lab-ideas-contract-v1'),
    created_at              timestamptz NOT NULL,
    updated_at              timestamptz NOT NULL,
    -- The per-cited-bundle append-only version chain.
    CONSTRAINT lab_idea_decompositions_chain UNIQUE (client_id, bundle_id, decomposition_version),
    -- The deterministic identity idempotence fence (the same identity
    -- inputs are the same decomposition, ever, per client).
    CONSTRAINT lab_idea_decompositions_identity UNIQUE (client_id, identity_digest),
    -- The status-conditional counts fence: a run is born 'running'
    -- with honestly-zero counts (nothing is computed yet); the single
    -- completion update computes them from the tail rows, so at
    -- 'completed' the arithmetic is pinned non-negative (the counts
    -- are SQL-computed, never asserted separately).
    CONSTRAINT lab_idea_decompositions_counts_status
        CHECK ( (status = 'running' AND node_count = 0 AND edge_count = 0)
             OR (status = 'completed') )
);

-- The client's decomposition tail.
CREATE INDEX IF NOT EXISTS lab_idea_decompositions_client_idx
    ON lab_idea_decompositions (client_id, created_at DESC, decomposition_id);
-- The per-cited-bundle version-chain read (the LAB-004 advance seam
-- resolves the latest decomposition per cited bundle through this
-- shape).
CREATE INDEX IF NOT EXISTS lab_idea_decompositions_bundle_idx
    ON lab_idea_decompositions (client_id, bundle_reference, decomposition_version DESC);
-- The retrieval join facet (retrieval by cited reference id).
CREATE INDEX IF NOT EXISTS lab_idea_decompositions_reference_idx
    ON lab_idea_decompositions (client_id, reference_id);

-- Decomposition identity is immutable after insert; ONLY the status,
-- the two SQL-computed counts and updated_at may advance (the single
-- completion transition — running → completed, no resurrection, no
-- reopen).
CREATE OR REPLACE FUNCTION lab_idea_decomposition_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.decomposition_id <> OLD.decomposition_id
       OR NEW.decomposition_version <> OLD.decomposition_version
       OR NEW.idea_set_version <> OLD.idea_set_version
       OR NEW.bundle_id <> OLD.bundle_id
       OR NEW.bundle_reference <> OLD.bundle_reference
       OR NEW.bundle_version <> OLD.bundle_version
       OR NEW.reference_id <> OLD.reference_id
       OR NEW.corpus_id <> OLD.corpus_id
       OR NEW.corpus_version <> OLD.corpus_version
       OR NEW.provider <> OLD.provider
       OR NEW.provider_content_id <> OLD.provider_content_id
       OR NEW.canonical_url <> OLD.canonical_url
       OR NEW.metadata_digest <> OLD.metadata_digest
       OR NEW.feature_set_version <> OLD.feature_set_version
       OR NEW.extractor_id <> OLD.extractor_id
       OR NEW.extractor_version <> OLD.extractor_version
       OR NEW.bundle_identity_digest <> OLD.bundle_identity_digest
       OR NEW.decomposer_id <> OLD.decomposer_id
       OR NEW.decomposer_version <> OLD.decomposer_version
       OR NEW.identity_digest <> OLD.identity_digest
       OR NEW.input_digest <> OLD.input_digest
       OR NEW.agency_id <> OLD.agency_id
       OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.contract_version <> OLD.contract_version
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'lab idea decomposition % identity/scope/citation is immutable — decomposition history is append-only',
            OLD.decomposition_id;
    END IF;
    IF NOT (
           (OLD.status = 'running' AND NEW.status = 'completed')
        OR (OLD.status = NEW.status)
    ) THEN
        RAISE EXCEPTION 'lab idea decomposition transition % → % is not legal (running → completed; no reopen)',
            OLD.status, NEW.status;
    END IF;
    IF NOT (
           (OLD.status = 'running' AND NEW.status = 'completed')
        OR (NEW.node_count = OLD.node_count AND NEW.edge_count = OLD.edge_count)
    ) THEN
        RAISE EXCEPTION 'lab idea decomposition % counts may only change at the single completion advance',
            OLD.decomposition_id;
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'lab idea decomposition % updated_at may not go backwards',
            OLD.decomposition_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_idea_decomposition_guard_trigger ON lab_idea_decompositions;
CREATE TRIGGER lab_idea_decomposition_guard_trigger
    BEFORE UPDATE ON lab_idea_decompositions
    FOR EACH ROW EXECUTE FUNCTION lab_idea_decomposition_guard();

-- Decompositions are never deleted (the decomposition history is
-- append-only).
CREATE OR REPLACE FUNCTION lab_idea_decompositions_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab idea decompositions cannot be deleted — decomposition history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_idea_decompositions_no_delete_trigger ON lab_idea_decompositions;
CREATE TRIGGER lab_idea_decompositions_no_delete_trigger
    BEFORE DELETE ON lab_idea_decompositions
    FOR EACH ROW EXECUTE FUNCTION lab_idea_decompositions_no_delete();

-- ---------------------------------------------------------------------------
-- lab_idea_nodes — the primitive NODE records (the closed
-- primitive-kind + origin-class vocabularies; THE separation fences)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_idea_nodes (
    node_id                 uuid        PRIMARY KEY,
    -- THE OBSERVED ANCHOR: non-null ⟺ origin_class = observed_source
    -- (the decomposition that extracted this node; the FK is the
    -- strong same-module anchor for observed nodes).
    decomposition_id        uuid        REFERENCES lab_idea_decompositions(decomposition_id),
    -- THE OPERATION BACK-REFERENCE (recorded data, DISCLOSED — the
    -- output node inserts BEFORE its operation row; the operation's
    -- output_node_id FK is the strong anchor in the other direction,
    -- and the partial UNIQUE index below enforces the
    -- one-output-per-operation pairing): non-null ⟺ origin_class <>
    -- observed_source.
    creating_operation_id   uuid,
    primitive_kind          text        NOT NULL
                            CHECK (primitive_kind IN ('idea',
                                                      'problem',
                                                      'claim',
                                                      'hook',
                                                      'narrative',
                                                      'visual_treatment',
                                                      'audio_treatment',
                                                      'packaging',
                                                      'cta',
                                                      'timing_context')),
    -- THE CLOSED ORIGIN-CLASS VOCABULARY (§6 verbatim).
    origin_class            text        NOT NULL
                            CHECK (origin_class IN ('observed_source',
                                                    'derived_abstraction',
                                                    'generated_mutation',
                                                    'combined_strategy')),
    -- The honest descriptor of the primitive (bounded).
    descriptor              text        NOT NULL CHECK (char_length(descriptor) >= 1 AND char_length(descriptor) <= 512),
    -- The bounded structured attributes (recorded data — the
    -- structural echo of the cited feature value / the generator's
    -- attributes).
    attributes              jsonb       NOT NULL DEFAULT '{}'
                            CHECK (jsonb_typeof(attributes) = 'object'),
    -- The citable bundle-reference echo (observed nodes only — the
    -- recorded source linkage).
    cited_bundle_reference  text
                            CHECK (cited_bundle_reference IS NULL
                                OR cited_bundle_reference ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}#v[1-9][0-9]{0,3}$'),
    -- The operation-kind echo (non-observed nodes only).
    creating_operation_kind text
                            CHECK (creating_operation_kind IS NULL
                                OR creating_operation_kind IN ('derive', 'recombine', 'mutate', 'analogy', 'invert', 'fill_gap')),
    -- THE RECORDED LINEAGE (the ordered edge chain to the observed
    -- ancestors — DATA recorded at creation, never computed post-hoc
    -- from resemblance; null ⟺ observed_source).
    lineage                 jsonb
                            CHECK (lineage IS NULL OR jsonb_typeof(lineage) = 'array'),
    -- The creation-time novelty score against the OBSERVED graph
    -- (null ⟺ observed_source — observed nodes are the reference
    -- set, not novelty candidates).
    novelty_score           numeric(5,4)
                            CHECK (novelty_score IS NULL OR (novelty_score >= 0 AND novelty_score <= 1)),
    novelty_version         text
                            CHECK (novelty_version IS NULL OR novelty_version IN ('lab-idea-novelty-v1')),
    -- The node position within its creator (deterministic ordering).
    seq                     integer     NOT NULL CHECK (seq >= 1),
    agency_id               uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id               uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id            uuid        REFERENCES workspaces(workspace_id),
    contract_version        text        NOT NULL
                            CHECK (contract_version = 'lab-ideas-contract-v1'),
    created_at              timestamptz NOT NULL,
    updated_at              timestamptz NOT NULL,
    -- THE OBSERVED-DERIVED-GENERATED-COMBINED SEPARATION (the core
    -- acceptance, structural): the origin class is fenced to its
    -- creation path on every axis — no mixed-origin row is
    -- expressible.
    CONSTRAINT lab_idea_nodes_observed_fence
        CHECK ((origin_class = 'observed_source') = (decomposition_id IS NOT NULL)),
    CONSTRAINT lab_idea_nodes_operation_fence
        CHECK ((origin_class <> 'observed_source') = (creating_operation_id IS NOT NULL)),
    CONSTRAINT lab_idea_nodes_kind_echo_fence
        CHECK ((origin_class <> 'observed_source') = (creating_operation_kind IS NOT NULL)),
    CONSTRAINT lab_idea_nodes_lineage_fence
        CHECK ((origin_class = 'observed_source') = (lineage IS NULL)),
    CONSTRAINT lab_idea_nodes_novelty_fence
        CHECK ((origin_class = 'observed_source') = (novelty_score IS NULL)),
    CONSTRAINT lab_idea_nodes_novelty_version_fence
        CHECK ((novelty_score IS NULL) = (novelty_version IS NULL)),
    CONSTRAINT lab_idea_nodes_citation_fence
        CHECK ((cited_bundle_reference IS NOT NULL) = (origin_class = 'observed_source'))
);

-- The deterministic retrieval facet (by origin class + primitive
-- kind, keyset-ordered (created_at, node_id) descending).
CREATE INDEX IF NOT EXISTS lab_idea_nodes_retrieval_idx
    ON lab_idea_nodes (client_id, origin_class, primitive_kind, created_at DESC, node_id DESC);
-- The decomposition node tail.
CREATE INDEX IF NOT EXISTS lab_idea_nodes_decomposition_idx
    ON lab_idea_nodes (decomposition_id, seq, node_id);
-- The observed-by-kind facet (the novelty comparison set — node_id
-- ascending, the deterministic comparison order).
CREATE INDEX IF NOT EXISTS lab_idea_nodes_observed_kind_idx
    ON lab_idea_nodes (client_id, primitive_kind, node_id)
    WHERE origin_class = 'observed_source';
-- The clusterable facet (observed + derived, node_id ascending — the
-- deterministic clustering input order).
CREATE INDEX IF NOT EXISTS lab_idea_nodes_clusterable_idx
    ON lab_idea_nodes (client_id, node_id)
    WHERE origin_class IN ('observed_source', 'derived_abstraction');
-- The one-output-per-operation pairing (the recorded-data
-- back-reference enforced from the node side).
CREATE UNIQUE INDEX IF NOT EXISTS lab_idea_nodes_creating_operation_uidx
    ON lab_idea_nodes (creating_operation_id)
    WHERE creating_operation_id IS NOT NULL;

-- Nodes are APPEND-ONLY OUTRIGHT: no UPDATE, no DELETE (a node is an
-- immutable record of one extraction/generation; corrections are NEW
-- decompositions/operations).
CREATE OR REPLACE FUNCTION lab_idea_nodes_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab idea nodes are append-only (INSERT only — node % is immutable; corrections are new decompositions/operations)',
        NEW.node_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_idea_nodes_no_update_trigger ON lab_idea_nodes;
CREATE TRIGGER lab_idea_nodes_no_update_trigger
    BEFORE UPDATE ON lab_idea_nodes
    FOR EACH ROW EXECUTE FUNCTION lab_idea_nodes_append_only();

DROP TRIGGER IF EXISTS lab_idea_nodes_no_delete_trigger ON lab_idea_nodes;
CREATE TRIGGER lab_idea_nodes_no_delete_trigger
    BEFORE DELETE ON lab_idea_nodes
    FOR EACH ROW EXECUTE FUNCTION lab_idea_nodes_append_only();

-- Scope consistency: an observed node's client must match its
-- decomposition's client (cross-tenant node injection is rejected at
-- the DB — §22). Non-observed nodes carry no FK-able creator at
-- insert time (the recorded-data back-reference, DISCLOSED above);
-- the operation insert trigger checks the reverse anchor.
CREATE OR REPLACE FUNCTION lab_idea_node_scope_check() RETURNS trigger AS $$
DECLARE
    decomposition_client uuid;
    decomposition_workspace uuid;
BEGIN
    IF NEW.decomposition_id IS NOT NULL THEN
        SELECT client_id, workspace_id INTO decomposition_client, decomposition_workspace
            FROM lab_idea_decompositions
            WHERE decomposition_id = NEW.decomposition_id;
        IF decomposition_client IS NULL THEN
            RAISE EXCEPTION 'lab idea node must bind an existing decomposition (%)',
                NEW.decomposition_id;
        END IF;
        IF decomposition_client <> NEW.client_id THEN
            RAISE EXCEPTION 'lab idea node client must match its decomposition client (cross-tenant extraction is rejected)';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_idea_node_scope_trigger ON lab_idea_nodes;
CREATE TRIGGER lab_idea_node_scope_trigger
    BEFORE INSERT ON lab_idea_nodes
    FOR EACH ROW EXECUTE FUNCTION lab_idea_node_scope_check();

-- ---------------------------------------------------------------------------
-- lab_idea_operations — the first-class append-only graph OPERATION
-- records (the §6 supports list as recorded operations)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_idea_operations (
    operation_id            uuid        PRIMARY KEY,
    -- THE CLOSED OPERATION-KIND VOCABULARY.
    operation_kind          text        NOT NULL
                            CHECK (operation_kind IN ('derive', 'recombine', 'mutate', 'analogy', 'invert', 'fill_gap')),
    -- The output node this operation produced (the STRONG same-module
    -- FK anchor — the node inserts first in the same transaction).
    output_node_id          uuid        NOT NULL REFERENCES lab_idea_nodes(node_id),
    -- The output node's origin class (the CHECK-fenced pairing).
    output_origin_class     text        NOT NULL
                            CHECK (output_origin_class IN ('observed_source',
                                                           'derived_abstraction',
                                                           'generated_mutation',
                                                           'combined_strategy')),
    -- The operation-kind → output-origin pairing (CHECK-fenced — the
    -- creation path is fenced to the origin class).
    CONSTRAINT lab_idea_operations_kind_origin_pairing
        CHECK ((operation_kind, output_origin_class) IN
               (('derive', 'derived_abstraction'),
                ('recombine', 'combined_strategy'),
                ('mutate', 'generated_mutation'),
                ('analogy', 'generated_mutation'),
                ('invert', 'generated_mutation'),
                ('fill_gap', 'generated_mutation'))),
    -- The generator port identity that produced the output content
    -- (recorded provenance — the replaceable-port echo).
    generator_id            text        NOT NULL CHECK (char_length(generator_id) >= 1 AND char_length(generator_id) <= 64),
    generator_version       text        NOT NULL CHECK (char_length(generator_version) >= 1 AND char_length(generator_version) <= 64),
    agency_id               uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id               uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id            uuid        REFERENCES workspaces(workspace_id),
    contract_version        text        NOT NULL
                            CHECK (contract_version = 'lab-ideas-contract-v1'),
    created_at              timestamptz NOT NULL
);

-- The client's operation tail.
CREATE INDEX IF NOT EXISTS lab_idea_operations_client_idx
    ON lab_idea_operations (client_id, created_at DESC, operation_id);
-- The output-node facet (the operation read resolves through it).
CREATE INDEX IF NOT EXISTS lab_idea_operations_output_idx
    ON lab_idea_operations (output_node_id);

-- Operations are APPEND-ONLY OUTRIGHT: no UPDATE, no DELETE (an
-- operation is an immutable record of one recorded graph operation).
CREATE OR REPLACE FUNCTION lab_idea_operations_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab idea operations are append-only (INSERT only — operation % is immutable)',
        NEW.operation_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_idea_operations_no_update_trigger ON lab_idea_operations;
CREATE TRIGGER lab_idea_operations_no_update_trigger
    BEFORE UPDATE ON lab_idea_operations
    FOR EACH ROW EXECUTE FUNCTION lab_idea_operations_append_only();

DROP TRIGGER IF EXISTS lab_idea_operations_no_delete_trigger ON lab_idea_operations;
CREATE TRIGGER lab_idea_operations_no_delete_trigger
    BEFORE DELETE ON lab_idea_operations
    FOR EACH ROW EXECUTE FUNCTION lab_idea_operations_append_only();

-- Scope consistency: the operation's client must match its output
-- node's client AND the output node's recorded back-reference must
-- point back at THIS operation (the id pairing validated at the DB —
-- the recorded-data back-reference's backstop).
CREATE OR REPLACE FUNCTION lab_idea_operation_scope_check() RETURNS trigger AS $$
DECLARE
    output_client uuid;
    output_creating_operation uuid;
BEGIN
    SELECT client_id, creating_operation_id INTO output_client, output_creating_operation
        FROM lab_idea_nodes
        WHERE node_id = NEW.output_node_id;
    IF output_client IS NULL THEN
        RAISE EXCEPTION 'lab idea operation must bind an existing output node (%)',
            NEW.output_node_id;
    END IF;
    IF output_client <> NEW.client_id THEN
        RAISE EXCEPTION 'lab idea operation client must match its output node client (cross-tenant operation injection is rejected)';
    END IF;
    IF output_creating_operation IS NOT NULL AND output_creating_operation <> NEW.operation_id THEN
        RAISE EXCEPTION 'lab idea operation % does not match its output node''s recorded creating operation %',
            NEW.operation_id, output_creating_operation;
    END IF;
    IF output_creating_operation IS NULL THEN
        RAISE EXCEPTION 'lab idea operation % cites an output node with no recorded creating operation (the pairing is mandatory)',
            NEW.operation_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_idea_operation_scope_trigger ON lab_idea_operations;
CREATE TRIGGER lab_idea_operation_scope_trigger
    BEFORE INSERT ON lab_idea_operations
    FOR EACH ROW EXECUTE FUNCTION lab_idea_operation_scope_check();

-- ---------------------------------------------------------------------------
-- lab_idea_operation_inputs — the append-only input tail (the cited
-- input nodes, ordered)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_idea_operation_inputs (
    input_id                uuid        PRIMARY KEY,
    operation_id            uuid        NOT NULL REFERENCES lab_idea_operations(operation_id),
    node_id                 uuid        NOT NULL REFERENCES lab_idea_nodes(node_id),
    -- The cited input position (deterministic ordering).
    seq                     integer     NOT NULL CHECK (seq >= 1),
    agency_id               uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id               uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id            uuid        REFERENCES workspaces(workspace_id),
    contract_version        text        NOT NULL
                            CHECK (contract_version = 'lab-ideas-contract-v1'),
    created_at              timestamptz NOT NULL,
    -- One input row per (operation, position) — the deterministic
    -- input order; one input row per (operation, node) — no duplicate
    -- citations.
    CONSTRAINT lab_idea_operation_inputs_position UNIQUE (operation_id, seq),
    CONSTRAINT lab_idea_operation_inputs_node UNIQUE (operation_id, node_id)
);

-- The input-node facet (the lineage reads resolve through it).
CREATE INDEX IF NOT EXISTS lab_idea_operation_inputs_node_idx
    ON lab_idea_operation_inputs (node_id);

-- Operation inputs are APPEND-ONLY OUTRIGHT: no UPDATE, no DELETE.
CREATE OR REPLACE FUNCTION lab_idea_operation_inputs_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab idea operation inputs are append-only (INSERT only — the cited input history is never rewritten)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_idea_operation_inputs_no_update_trigger ON lab_idea_operation_inputs;
CREATE TRIGGER lab_idea_operation_inputs_no_update_trigger
    BEFORE UPDATE ON lab_idea_operation_inputs
    FOR EACH ROW EXECUTE FUNCTION lab_idea_operation_inputs_append_only();

DROP TRIGGER IF EXISTS lab_idea_operation_inputs_no_delete_trigger ON lab_idea_operation_inputs;
CREATE TRIGGER lab_idea_operation_inputs_no_delete_trigger
    BEFORE DELETE ON lab_idea_operation_inputs
    FOR EACH ROW EXECUTE FUNCTION lab_idea_operation_inputs_append_only();

-- Scope consistency: an input row's client must match its operation's
-- client AND its cited node's client (cross-tenant input injection is
-- rejected at the DB — §22).
CREATE OR REPLACE FUNCTION lab_idea_operation_input_scope_check() RETURNS trigger AS $$
DECLARE
    operation_client uuid;
    node_client uuid;
BEGIN
    SELECT client_id INTO operation_client
        FROM lab_idea_operations
        WHERE operation_id = NEW.operation_id;
    IF operation_client IS NULL THEN
        RAISE EXCEPTION 'lab idea operation input must bind an existing operation (%)',
            NEW.operation_id;
    END IF;
    IF operation_client <> NEW.client_id THEN
        RAISE EXCEPTION 'lab idea operation input client must match its operation client (cross-tenant input injection is rejected)';
    END IF;
    SELECT client_id INTO node_client
        FROM lab_idea_nodes
        WHERE node_id = NEW.node_id;
    IF node_client IS NULL THEN
        RAISE EXCEPTION 'lab idea operation input must bind an existing node (%)',
            NEW.node_id;
    END IF;
    IF node_client <> NEW.client_id THEN
        RAISE EXCEPTION 'lab idea operation input client must match its cited node client (cross-tenant input injection is rejected)';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_idea_operation_input_scope_trigger ON lab_idea_operation_inputs;
CREATE TRIGGER lab_idea_operation_input_scope_trigger
    BEFORE INSERT ON lab_idea_operation_inputs
    FOR EACH ROW EXECUTE FUNCTION lab_idea_operation_input_scope_check();

-- ---------------------------------------------------------------------------
-- lab_idea_edges — the relation edges (the closed 8-relation
-- vocabulary; each asserted by exactly ONE creator)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_idea_edges (
    edge_id                 uuid        PRIMARY KEY,
    -- Lineage edges point from the ANCESTOR (input) to the DESCENDANT
    -- (output); semantic edges (supports/contradicts/...) point from
    -- the asserting node to the asserted node.
    from_node_id            uuid        NOT NULL REFERENCES lab_idea_nodes(node_id),
    to_node_id              uuid        NOT NULL REFERENCES lab_idea_nodes(node_id),
    -- THE CLOSED EDGE-RELATION VOCABULARY (§6's supports list).
    relation                text        NOT NULL
                            CHECK (relation IN ('supports',
                                                'contradicts',
                                                'refines',
                                                'combines_with',
                                                'mutates_from',
                                                'analog_to',
                                                'inverts',
                                                'fills_gap')),
    -- The creator: exactly ONE of the decomposition or the operation
    -- asserted this edge (the num_nonnulls fence).
    decomposition_id        uuid        REFERENCES lab_idea_decompositions(decomposition_id),
    operation_id            uuid        REFERENCES lab_idea_operations(operation_id),
    -- The 1-based position among the creator's edges (deterministic
    -- order).
    seq                     integer     NOT NULL CHECK (seq >= 1),
    agency_id               uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id               uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id            uuid        REFERENCES workspaces(workspace_id),
    contract_version        text        NOT NULL
                            CHECK (contract_version = 'lab-ideas-contract-v1'),
    created_at              timestamptz NOT NULL,
    -- Exactly one creator.
    CONSTRAINT lab_idea_edges_creator_fence
        CHECK (num_nonnulls(decomposition_id, operation_id) = 1),
    -- No self-edges.
    CONSTRAINT lab_idea_edges_no_self
        CHECK (from_node_id <> to_node_id)
);

-- The creator edge tails (deterministic order).
CREATE INDEX IF NOT EXISTS lab_idea_edges_decomposition_idx
    ON lab_idea_edges (decomposition_id, seq, edge_id);
CREATE INDEX IF NOT EXISTS lab_idea_edges_operation_idx
    ON lab_idea_edges (operation_id, seq, edge_id);
-- The node facets (the lineage reads resolve through them).
CREATE INDEX IF NOT EXISTS lab_idea_edges_from_node_idx
    ON lab_idea_edges (from_node_id);
CREATE INDEX IF NOT EXISTS lab_idea_edges_to_node_idx
    ON lab_idea_edges (to_node_id);

-- Edges are APPEND-ONLY OUTRIGHT: no UPDATE, no DELETE (an edge is an
-- immutable recorded relation; corrections are new edges).
CREATE OR REPLACE FUNCTION lab_idea_edges_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab idea edges are append-only (INSERT only — edge % is immutable; corrections are new edges)',
        NEW.edge_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_idea_edges_no_update_trigger ON lab_idea_edges;
CREATE TRIGGER lab_idea_edges_no_update_trigger
    BEFORE UPDATE ON lab_idea_edges
    FOR EACH ROW EXECUTE FUNCTION lab_idea_edges_append_only();

DROP TRIGGER IF EXISTS lab_idea_edges_no_delete_trigger ON lab_idea_edges;
CREATE TRIGGER lab_idea_edges_no_delete_trigger
    BEFORE DELETE ON lab_idea_edges
    FOR EACH ROW EXECUTE FUNCTION lab_idea_edges_append_only();

-- Scope consistency: an edge's client must match BOTH its nodes'
-- clients AND (when present) its creator's client (cross-tenant edge
-- injection is rejected at the DB — §22).
CREATE OR REPLACE FUNCTION lab_idea_edge_scope_check() RETURNS trigger AS $$
DECLARE
    from_client uuid;
    to_client uuid;
    decomposition_client uuid;
    operation_client uuid;
BEGIN
    SELECT client_id INTO from_client FROM lab_idea_nodes WHERE node_id = NEW.from_node_id;
    IF from_client IS NULL THEN
        RAISE EXCEPTION 'lab idea edge must bind an existing from-node (%)',
            NEW.from_node_id;
    END IF;
    IF from_client <> NEW.client_id THEN
        RAISE EXCEPTION 'lab idea edge client must match its from-node client (cross-tenant edge injection is rejected)';
    END IF;
    SELECT client_id INTO to_client FROM lab_idea_nodes WHERE node_id = NEW.to_node_id;
    IF to_client IS NULL THEN
        RAISE EXCEPTION 'lab idea edge must bind an existing to-node (%)',
            NEW.to_node_id;
    END IF;
    IF to_client <> NEW.client_id THEN
        RAISE EXCEPTION 'lab idea edge client must match its to-node client (cross-tenant edge injection is rejected)';
    END IF;
    IF NEW.decomposition_id IS NOT NULL THEN
        SELECT client_id INTO decomposition_client FROM lab_idea_decompositions WHERE decomposition_id = NEW.decomposition_id;
        IF decomposition_client IS NULL OR decomposition_client <> NEW.client_id THEN
            RAISE EXCEPTION 'lab idea edge client must match its decomposition client (cross-tenant edge injection is rejected)';
        END IF;
    END IF;
    IF NEW.operation_id IS NOT NULL THEN
        SELECT client_id INTO operation_client FROM lab_idea_operations WHERE operation_id = NEW.operation_id;
        IF operation_client IS NULL OR operation_client <> NEW.client_id THEN
            RAISE EXCEPTION 'lab idea edge client must match its operation client (cross-tenant edge injection is rejected)';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_idea_edge_scope_trigger ON lab_idea_edges;
CREATE TRIGGER lab_idea_edge_scope_trigger
    BEFORE INSERT ON lab_idea_edges
    FOR EACH ROW EXECUTE FUNCTION lab_idea_edge_scope_check();

-- ---------------------------------------------------------------------------
-- lab_idea_cluster_runs — the versioned CLUSTERING runs (one run per
-- (client, clustering version) — the version-bump discipline)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_idea_cluster_runs (
    run_id                  uuid        PRIMARY KEY,
    cluster_version         text        NOT NULL
                            CHECK (cluster_version IN ('lab-idea-clustering-v1')),
    -- Born running; the single guarded advance to completed (the
    -- completion update SQL-computes the summary from the assignment
    -- rows in the same transaction).
    status                  text        NOT NULL
                            CHECK (status IN ('running', 'completed')),
    -- The summary — SQL-COMPUTED at completion from the assignment
    -- rows (never asserted separately; the row-level arithmetic
    -- fences below pin the completed state).
    input_node_count        integer     NOT NULL DEFAULT 0 CHECK (input_node_count >= 0),
    cluster_count           integer     NOT NULL DEFAULT 0 CHECK (cluster_count >= 0),
    largest_cluster_size    integer     NOT NULL DEFAULT 0 CHECK (largest_cluster_size >= 0),
    singleton_count         integer     NOT NULL DEFAULT 0 CHECK (singleton_count >= 0),
    agency_id               uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id               uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id            uuid        REFERENCES workspaces(workspace_id),
    contract_version        text        NOT NULL
                            CHECK (contract_version = 'lab-ideas-contract-v1'),
    created_at              timestamptz NOT NULL,
    updated_at              timestamptz NOT NULL,
    -- ONE RUN PER (client, clustering version): the version-bump
    -- discipline — re-clustering after a node-set change requires a
    -- NEW version (the assignments are append-only records carrying
    -- the version; never in-place rewrites).
    CONSTRAINT lab_idea_cluster_runs_version UNIQUE (client_id, cluster_version),
    -- The status-conditional summary fence: a run is born 'running'
    -- with honestly-zero summary (nothing is computed yet); at
    -- 'completed' the arithmetic is pinned (the clusters are a
    -- partition of the input: cluster_count ≤ input_node_count,
    -- largest_cluster_size ≤ input_node_count, and the singletons
    -- are a subset of the clusters).
    CONSTRAINT lab_idea_cluster_runs_summary_status
        CHECK ( (status = 'running' AND input_node_count = 0 AND cluster_count = 0
                 AND largest_cluster_size = 0 AND singleton_count = 0)
             OR (status = 'completed' AND cluster_count <= input_node_count
                 AND largest_cluster_size <= input_node_count
                 AND singleton_count <= cluster_count) )
);

-- Run identity is immutable after insert; ONLY the status, the four
-- SQL-computed summary values and updated_at may advance (the single
-- completion transition — running → completed, no resurrection, no
-- reopen).
CREATE OR REPLACE FUNCTION lab_idea_cluster_run_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.run_id <> OLD.run_id
       OR NEW.cluster_version <> OLD.cluster_version
       OR NEW.agency_id <> OLD.agency_id
       OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.contract_version <> OLD.contract_version
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'lab idea cluster run % identity/scope is immutable — cluster run history is append-only',
            OLD.run_id;
    END IF;
    IF NOT (
           (OLD.status = 'running' AND NEW.status = 'completed')
        OR (OLD.status = NEW.status)
    ) THEN
        RAISE EXCEPTION 'lab idea cluster run transition % → % is not legal (running → completed; no reopen)',
            OLD.status, NEW.status;
    END IF;
    IF NOT (
           (OLD.status = 'running' AND NEW.status = 'completed')
        OR (NEW.input_node_count = OLD.input_node_count
            AND NEW.cluster_count = OLD.cluster_count
            AND NEW.largest_cluster_size = OLD.largest_cluster_size
            AND NEW.singleton_count = OLD.singleton_count)
    ) THEN
        RAISE EXCEPTION 'lab idea cluster run % summary may only change at the single completion advance',
            OLD.run_id;
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'lab idea cluster run % updated_at may not go backwards',
            OLD.run_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_idea_cluster_run_guard_trigger ON lab_idea_cluster_runs;
CREATE TRIGGER lab_idea_cluster_run_guard_trigger
    BEFORE UPDATE ON lab_idea_cluster_runs
    FOR EACH ROW EXECUTE FUNCTION lab_idea_cluster_run_guard();

-- Cluster runs are never deleted.
CREATE OR REPLACE FUNCTION lab_idea_cluster_runs_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab idea cluster runs cannot be deleted — cluster run history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_idea_cluster_runs_no_delete_trigger ON lab_idea_cluster_runs;
CREATE TRIGGER lab_idea_cluster_runs_no_delete_trigger
    BEFORE DELETE ON lab_idea_cluster_runs
    FOR EACH ROW EXECUTE FUNCTION lab_idea_cluster_runs_no_delete();

-- ---------------------------------------------------------------------------
-- lab_idea_cluster_assignments — the append-only cluster assignment
-- records (carrying the version through their run)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_idea_cluster_assignments (
    assignment_id           uuid        PRIMARY KEY,
    run_id                  uuid        NOT NULL REFERENCES lab_idea_cluster_runs(run_id),
    node_id                 uuid        NOT NULL REFERENCES lab_idea_nodes(node_id),
    -- The deterministic cluster key ('<primitive-kind>#<the
    -- component's lexicographically smallest node id>').
    cluster_key             text        NOT NULL
                            CHECK (char_length(cluster_key) >= 1 AND char_length(cluster_key) <= 128),
    primitive_kind          text        NOT NULL
                            CHECK (primitive_kind IN ('idea',
                                                      'problem',
                                                      'claim',
                                                      'hook',
                                                      'narrative',
                                                      'visual_treatment',
                                                      'audio_treatment',
                                                      'packaging',
                                                      'cta',
                                                      'timing_context')),
    -- The component size at run time (recorded on every member row —
    -- the run-time snapshot).
    cluster_size            integer     NOT NULL CHECK (cluster_size >= 1),
    agency_id               uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id               uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id            uuid        REFERENCES workspaces(workspace_id),
    contract_version        text        NOT NULL
                            CHECK (contract_version = 'lab-ideas-contract-v1'),
    created_at              timestamptz NOT NULL,
    -- One assignment per (run, node) — the version-pinned assignment
    -- set (never rewritten; a re-cluster is a new version's run).
    CONSTRAINT lab_idea_cluster_assignments_node UNIQUE (run_id, node_id)
);

-- The run's assignment tail (node_id ascending — the deterministic
-- assignment order).
CREATE INDEX IF NOT EXISTS lab_idea_cluster_assignments_run_idx
    ON lab_idea_cluster_assignments (run_id, node_id, assignment_id);
-- The node facet (the node's cluster history reads resolve through
-- it).
CREATE INDEX IF NOT EXISTS lab_idea_cluster_assignments_node_idx
    ON lab_idea_cluster_assignments (node_id);

-- Cluster assignments are APPEND-ONLY OUTRIGHT: no UPDATE, no DELETE
-- (the assignment history is never rewritten — re-clustering is a new
-- version's run).
CREATE OR REPLACE FUNCTION lab_idea_cluster_assignments_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'lab idea cluster assignments are append-only (INSERT only — assignment % is immutable; re-clustering is a new version''s run)',
        NEW.assignment_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_idea_cluster_assignments_no_update_trigger ON lab_idea_cluster_assignments;
CREATE TRIGGER lab_idea_cluster_assignments_no_update_trigger
    BEFORE UPDATE ON lab_idea_cluster_assignments
    FOR EACH ROW EXECUTE FUNCTION lab_idea_cluster_assignments_append_only();

DROP TRIGGER IF EXISTS lab_idea_cluster_assignments_no_delete_trigger ON lab_idea_cluster_assignments;
CREATE TRIGGER lab_idea_cluster_assignments_no_delete_trigger
    BEFORE DELETE ON lab_idea_cluster_assignments
    FOR EACH ROW EXECUTE FUNCTION lab_idea_cluster_assignments_append_only();

-- Scope consistency: an assignment's client must match its run's
-- client AND its node's client (cross-tenant assignment injection is
-- rejected at the DB — §22).
CREATE OR REPLACE FUNCTION lab_idea_cluster_assignment_scope_check() RETURNS trigger AS $$
DECLARE
    run_client uuid;
    node_client uuid;
BEGIN
    SELECT client_id INTO run_client FROM lab_idea_cluster_runs WHERE run_id = NEW.run_id;
    IF run_client IS NULL THEN
        RAISE EXCEPTION 'lab idea cluster assignment must bind an existing run (%)',
            NEW.run_id;
    END IF;
    IF run_client <> NEW.client_id THEN
        RAISE EXCEPTION 'lab idea cluster assignment client must match its run client (cross-tenant assignment injection is rejected)';
    END IF;
    SELECT client_id INTO node_client FROM lab_idea_nodes WHERE node_id = NEW.node_id;
    IF node_client IS NULL THEN
        RAISE EXCEPTION 'lab idea cluster assignment must bind an existing node (%)',
            NEW.node_id;
    END IF;
    IF node_client <> NEW.client_id THEN
        RAISE EXCEPTION 'lab idea cluster assignment client must match its node client (cross-tenant assignment injection is rejected)';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_idea_cluster_assignment_scope_trigger ON lab_idea_cluster_assignments;
CREATE TRIGGER lab_idea_cluster_assignment_scope_trigger
    BEFORE INSERT ON lab_idea_cluster_assignments
    FOR EACH ROW EXECUTE FUNCTION lab_idea_cluster_assignment_scope_check();
