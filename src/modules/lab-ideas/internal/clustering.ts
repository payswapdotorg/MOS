/**
 * /lab-ideas deterministic clustering (LAB-004) — the frozen
 * CLUSTERING formula (pure function).
 *
 * THE FROZEN CLUSTERING FORMULA ('lab-idea-clustering-v1',
 * disclosed):
 *
 *   clusterable(nodes) = the observed_source + derived_abstraction
 *   nodes (the evidence-bearing space — generated/combined nodes are
 *   candidates, NOT corpus evidence, and never join clusters —
 *   DISCLOSED);
 *
 *   within each primitive kind: the undirected similarity graph
 *   where two nodes are similar iff
 *   Jaccard(tokens(u.descriptor), tokens(v.descriptor)) ≥ 0.5
 *   (LAB_IDEA_CLUSTERING_SIMILARITY_THRESHOLD — the frozen
 *   threshold; tokens = the frozen novelty tokenization);
 *
 *   clusters = the connected components of that graph, PLUS every
 *   node not similar to any other node as its own singleton
 *   component;
 *
 *   clusterKey(component) = '<primitive-kind>#<the component's
 *   lexicographically smallest node id>' (the deterministic key);
 *   clusterSize(component) = |component| (recorded on every member
 *   row — the run-time snapshot).
 *
 * Same node set + same version → the same clusters: the function is
 * a PURE function of the recorded node set (deterministic input
 * ordering by node id, deterministic component enumeration,
 * deterministic keys). Cluster assignments are append-only records
 * carrying the version — never in-place rewrites; the module's run
 * discipline (one run per (client, clustering version)) makes the
 * re-cluster path a NEW version, never a rewrite.
 */

import {
  LAB_IDEA_CLUSTERING_SIMILARITY_THRESHOLD,
  type LabIdeaOriginClass,
  type LabIdeaPrimitiveKind,
} from '../public.ts';
import { labIdeaJaccardSimilarity, labIdeaTokenSet } from './novelty.ts';

/** The clusterable node input (the recorded fields the pure function consumes). */
export interface LabIdeaClusterableNode {
  nodeId: string;
  primitiveKind: LabIdeaPrimitiveKind;
  originClass: LabIdeaOriginClass;
  descriptor: string;
}

/** One computed cluster assignment (the pure function output — the append-only record input). */
export interface LabIdeaComputedAssignment {
  nodeId: string;
  primitiveKind: LabIdeaPrimitiveKind;
  clusterKey: string;
  clusterSize: number;
}

/** The clusterable origin classes (observed + derived — the evidence-bearing space; generated/combined never cluster, DISCLOSED). */
export const LAB_IDEA_CLUSTERABLE_ORIGIN_CLASSES: ReadonlyArray<LabIdeaOriginClass> = [
  'observed_source',
  'derived_abstraction',
];

/**
 * THE FROZEN CLUSTERING: kind-partitioned Jaccard connected
 * components at the frozen threshold over the clusterable primitive
 * space. Pure — same node set, same assignments, ever.
 */
export function clusterLabIdeaNodes(nodes: ReadonlyArray<LabIdeaClusterableNode>): ReadonlyArray<LabIdeaComputedAssignment> {
  // (1) The clusterable space: observed + derived nodes only.
  const clusterable = nodes
    .filter((node) => LAB_IDEA_CLUSTERABLE_ORIGIN_CLASSES.includes(node.originClass))
    .slice()
    .sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
  // (2) Group by primitive kind (deterministic order).
  const byKind = new Map<LabIdeaPrimitiveKind, LabIdeaClusterableNode[]>();
  for (const node of clusterable) {
    const bucket = byKind.get(node.primitiveKind) ?? [];
    bucket.push(node);
    byKind.set(node.primitiveKind, bucket);
  }
  // (3) The similarity graph per kind → connected components.
  const assignments: LabIdeaComputedAssignment[] = [];
  for (const kind of [...byKind.keys()].sort()) {
    const bucket = byKind.get(kind)!;
    const tokenSets = new Map<string, ReadonlyArray<string>>();
    for (const node of bucket) tokenSets.set(node.nodeId, labIdeaTokenSet(node.descriptor));
    // Union-find over the bucket (deterministic: the bucket is node_id-ascending).
    const parent = new Map<string, string>();
    const find = (nodeId: string): string => {
      let root = nodeId;
      while (parent.get(root) !== root) root = parent.get(root)!;
      let current = nodeId;
      while (parent.get(current) !== current) {
        const next = parent.get(current)!;
        parent.set(current, root);
        current = next;
      }
      return root;
    };
    for (const node of bucket) parent.set(node.nodeId, node.nodeId);
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const u = bucket[i]!;
        const v = bucket[j]!;
        const similarity = labIdeaJaccardSimilarity(tokenSets.get(u.nodeId)!, tokenSets.get(v.nodeId)!);
        if (similarity >= LAB_IDEA_CLUSTERING_SIMILARITY_THRESHOLD) {
          const rootU = find(u.nodeId);
          const rootV = find(v.nodeId);
          if (rootU !== rootV) {
            // Deterministic union direction: the lexicographically
            // smaller root becomes the parent.
            const [keep, merge] = rootU < rootV ? [rootU, rootV] : [rootV, rootU];
            parent.set(merge, keep);
          }
        }
      }
    }
    // (4) The components + the deterministic keys.
    const components = new Map<string, string[]>();
    for (const node of bucket) {
      const root = find(node.nodeId);
      const members = components.get(root) ?? [];
      members.push(node.nodeId);
      components.set(root, members);
    }
    for (const members of components.values()) {
      const sorted = members.slice().sort();
      const smallest = sorted[0]!;
      const clusterKey = `${kind}#${smallest}`;
      for (const nodeId of sorted) {
        assignments.push({ nodeId, primitiveKind: kind, clusterKey, clusterSize: sorted.length });
      }
    }
  }
  return assignments;
}

