/**
 * /metrics module implementation (MKT-014, METRIC-001).
 *
 * Thin composition over the append-only store with the canonical owner
 * chain (the goals/evidence pattern): every append resolves the owning
 * Client THROUGH the /clients canonical owner resolution and the optional
 * Workspace scope THROUGH the /workspaces canonical owner resolution BEFORE
 * any write (implementation-contract §2). Because the frozen dependency
 * matrix allows /metrics ──→ /evidence, /integrations only, those two
 * resolutions arrive through the STRUCTURAL PORTS declared in the module's
 * public contract — the concrete /clients and /workspaces public-contract
 * instances are wired at the composition root and satisfy the ports
 * structurally, so the resolution still executes server-side, inside this
 * module, through the exact public-contract methods (identical behavior to
 * /evidence's ownership chain) while the import matrix stays intact.
 * Agency/membership authorization stays in /agencies — this module composes
 * ownership with that authority and never invents a second one.
 *
 * /metrics owns NO provider state (INT-001 posture): no provider sessions,
 * no cursors, no SDK calls anywhere on this path — provider data ARRIVES as
 * already-normalized source-tagged payloads.
 */

import { ConflictError, NotFoundError } from '../../../platform/errors/errors.ts';
import type { MetricsModuleApi, MetricsModuleDeps } from '../public.ts';
import { composeMetricOwnerContext } from '../public.ts';
import {
  assertValidMetricObservationAppend,
  assertValidMetricProvenance,
  classifyMetricInsertConflict,
  MetricObservationStore,
} from './metrics-store.ts';

export function createMetricsModule(deps: MetricsModuleDeps): MetricsModuleApi {
  const store = new MetricObservationStore(deps.db, deps.clock, deps.ids);
  const { clients, workspaces, evidence } = deps;

  return {
    async appendMetricObservation(input, provenance) {
      // Provenance is server-derived and must be complete BEFORE anything
      // else runs — an incomplete provenance fails closed.
      assertValidMetricProvenance(provenance);
      // The frozen metric-observation shapes at the authority boundary.
      assertValidMetricObservationAppend(input);

      // CANONICAL Client owner resolution from durable state BEFORE any
      // write (THROUGH the /clients public-contract instance). Unknown or
      // tombstoned Client → uniform 404; disabled Client blocks new use
      // (409) without rewriting history (the goals/evidence policy).
      const ownership = await clients.resolveClientOwnership(input.clientId);
      if (ownership === null) {
        throw new NotFoundError('client', input.clientId);
      }
      if (ownership.client.status !== 'active') {
        throw new ConflictError(
          `client ${input.clientId} is ${ownership.client.status}; metric observations cannot be appended`,
        );
      }

      // Optional Workspace scope: resolved canonically THROUGH the
      // /workspaces public-contract instance. Unknown, tombstoned, or
      // belonging to a DIFFERENT Client → uniform 404 (a foreign workspace
      // identifier is not a traversal/existence oracle); disabled Workspace
      // blocks new use. The DB scope trigger is the final backstop against
      // races.
      if (input.workspaceId !== null) {
        const workspaceOwnership = await workspaces.resolveWorkspaceOwnership(input.workspaceId);
        if (workspaceOwnership === null || workspaceOwnership.workspace.clientId !== input.clientId) {
          throw new NotFoundError('workspace', input.workspaceId);
        }
        if (workspaceOwnership.workspace.status !== 'active') {
          throw new ConflictError(
            `workspace ${input.workspaceId} is ${workspaceOwnership.workspace.status}; metric observations cannot be scoped to it`,
          );
        }
      }

      // Optional evidence linkage (fail closed): a supplied evidenceRef must
      // resolve to an /evidence record of the SAME Client — a foreign
      // evidence identifier is indistinguishable from an unknown one
      // (uniform 404, no cross-tenant oracle). The metric DB trigger is the
      // race backstop.
      if (input.evidenceRef !== null) {
        const linked = await evidence.getEvidence(input.evidenceRef);
        if (linked === null || linked.clientId !== input.clientId) {
          throw new NotFoundError('evidence', input.evidenceRef);
        }
      }

      try {
        return await store.insertObservation(
          {
            clientId: input.clientId,
            workspaceId: input.workspaceId,
            metricName: input.metricName,
            dimensions: input.dimensions,
            value: input.value,
            unit: input.unit,
            sourceSystem: input.source.system,
            sourceRef: input.source.ref,
            observedAt: input.observedAt,
            retrievedAt: input.retrievedAt,
            evidenceRef: input.evidenceRef,
            quality: input.quality,
            aggregationMethod: input.aggregationMethod,
          },
          provenance,
        );
      } catch (error) {
        // Lost the linkage race: the DB cross-tenant trigger rejected a
        // concurrently-changed evidence ownership — converge to the uniform
        // domain 404.
        if (classifyMetricInsertConflict(error) === 'evidence-ref-client') {
          throw new NotFoundError('evidence', input.evidenceRef ?? '');
        }
        throw error;
      }
    },

    async getMetricObservation(observationId) {
      return store.getObservation(observationId);
    },

    async resolveMetricObservationOwnership(observationId) {
      const observation = await store.getObservation(observationId);
      if (observation === null) return null;
      // Canonical Client ownership THROUGH the /clients public-contract
      // instance — the ONLY Client ownership authority. A deleted
      // (tombstoned) Client never resolves, so an observation owned by a
      // tombstoned Client is indistinguishable from an unknown observation
      // identifier (uniform 404 upstream).
      const clientOwnership = await clients.resolveClientOwnership(observation.clientId);
      if (clientOwnership === null) return null;
      // The Workspace ownership snapshot when workspace-scoped: a deleted
      // (tombstoned) workspace (or its client) resolves null — the
      // observation row itself stays readable (immutable measurement
      // history is never erased); authorization only depends on the
      // client/agency chain.
      const workspace =
        observation.workspaceId === null
          ? null
          : await workspaces.resolveWorkspaceOwnership(observation.workspaceId);
      return composeMetricOwnerContext(
        observation,
        clientOwnership,
        workspace,
        deps.clock.nowIso(),
      );
    },

    async listMetricObservationsForClient(clientId) {
      // Canonical owner resolution before dependent traversal (§2).
      const ownership = await clients.resolveClientOwnership(clientId);
      if (ownership === null) {
        throw new NotFoundError('client', clientId);
      }
      return store.listObservationsForClient(clientId);
    },
  };
}
