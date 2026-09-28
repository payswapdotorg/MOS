/**
 * /lab-corpus module implementation (LAB-002 — the Reference-First
 * Niche Corpus).
 *
 * THE ORCHESTRATION ONLY: this module composes the LabCorpusStore (the
 * migration-061 tables) with the PURE contract guards of
 * validation.ts — every ingestion/observation passes the frozen
 * contract semantics BEFORE touching the store, and the store's
 * guarded UPDATEs + the migration triggers backstop every rule
 * (defense in depth; the DB fences are the authority, the module
 * guards are the honest error surface).
 *
 * THE INGESTION MODEL (provider-neutral): registerReference validates
 * the §4 Content Reference field set, enforces the corpus's
 * provider-specific acquisition policy (the declared rights basis must
 * be permitted for the provider under the CURRENT policy version),
 * then applies THE DEDUPLICATION FENCE: if the (client, provider,
 * provider_content_id) reference already exists, the ingestion becomes
 * an APPENDED OBSERVATION on the existing row (paired with the
 * current-availability advance in ONE transaction); otherwise the
 * reference is inserted TOGETHER with its first observation row (also
 * one transaction). A reference stays bound to the corpus version it
 * was FIRST recorded under — re-ingesting the same content under a
 * different corpus of the same client appends to the SAME reference
 * (one reference per provider content item per client, EVER; the
 * coverage report measures each corpus's own reference set).
 *
 * THE LIFECYCLE DISCIPLINE (the LAB-001 scenario semantics): the
 * corpus lifecycle transitions apply to the LATEST version row
 * (draft → active → retired, no resurrection); a correction appends a
 * NEW version row as draft (the re-activation gate applies per
 * version); ingestion is refused once the latest version is retired;
 * observations on EXISTING references continue regardless (the
 * observation history is the freshness evidence — §4 observation
 * timestamps).
 *
 * THE SCOPE DISCIPLINE (§22): every read resolves foreign/unknown
 * scope to the uniform NotFound (no existence oracle) — exactly the
 * /lab house pattern.
 */

import { InvalidRequestError, NotFoundError } from '../../../platform/errors/errors.ts';
import type {
  LabCorpusModuleApi,
  LabCorpusModuleDeps,
  LabCorpusObservationRecord,
  LabCorpusReferenceRecord,
  LabCorpusRecord,
  LabCorpusScope,
} from '../public.ts';
import { LAB_CORPUS_MAX_VERSIONS } from '../public.ts';
import {
  assertValidLabCorpusAcquisitionPolicy,
  assertValidLabCorpusObservationInput,
  assertValidLabCorpusReferenceInput,
} from './validation.ts';
import {
  LabCorpusStore,
  mapCorpusRow,
  mapObservationRow,
  mapReferenceRow,
} from './corpus-store.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertScope(scope: LabCorpusScope): void {
  if (scope === null || typeof scope !== 'object') {
    throw new InvalidRequestError('scope must be an object');
  }
  if (!UUID_PATTERN.test(String(scope.agencyId)) || !UUID_PATTERN.test(String(scope.clientId))) {
    throw new InvalidRequestError('scope.agencyId and scope.clientId must be agency/client ids');
  }
  if (scope.workspaceId !== undefined && scope.workspaceId !== null && !UUID_PATTERN.test(String(scope.workspaceId))) {
    throw new InvalidRequestError('scope.workspaceId must be a workspace id or null');
  }
}

function assertUuidShape(resource: string, id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new NotFoundError(resource, id);
  }
}

export function createLabCorpusModule(deps: LabCorpusModuleDeps): LabCorpusModuleApi {
  const store = new LabCorpusStore(deps.db, deps.clock, deps.ids);

  /** Runs the body against a transaction-bound store (the paired append+advance discipline). */
  const withTx = <T>(body: (txStore: LabCorpusStore) => Promise<T>): Promise<T> =>
    deps.db.transaction((tx) => body(new LabCorpusStore(tx, deps.clock, deps.ids)));

  const requireLatestCorpus = async (scope: LabCorpusScope, corpusId: string): Promise<LabCorpusRecord> => {
    assertUuidShape('lab corpus', corpusId);
    const row = await store.findLatestCorpusVersion(scope.clientId, corpusId);
    if (row === null) {
      throw new NotFoundError('lab corpus', corpusId);
    }
    return mapCorpusRow(row);
  };

  const requireReference = async (scope: LabCorpusScope, referenceId: string): Promise<LabCorpusReferenceRecord> => {
    assertUuidShape('lab corpus reference', referenceId);
    const row = await store.findReference(scope.clientId, referenceId);
    if (row === null) {
      throw new NotFoundError('lab corpus reference', referenceId);
    }
    return mapReferenceRow(row);
  };

  /** Appends one observation and advances the reference's current availability — ONE transaction (the pairing discipline). */
  const appendObservation = async (
    scope: LabCorpusScope,
    referenceId: string,
    input: { observedAt: string; collectionMethod: string; collectionVersion: string; metadataDigest: string; mediaAvailability: string },
  ): Promise<LabCorpusObservationRecord> => {
    const observationId = store.newId();
    return withTx(async (txStore) => {
      const observationRow = await txStore.insertObservation({
        observationId,
        referenceId,
        scope,
        observedAt: input.observedAt,
        collectionMethod: input.collectionMethod,
        collectionVersion: input.collectionVersion,
        metadataDigest: input.metadataDigest,
        mediaAvailability: input.mediaAvailability as LabCorpusObservationRecord['mediaAvailability'],
      });
      await txStore.updateReferenceAvailability(referenceId, input.mediaAvailability as LabCorpusObservationRecord['mediaAvailability']);
      return mapObservationRow(observationRow);
    });
  };

  return {
    // --- Corpus lifecycle ---

    async createCorpus(input) {
      assertScope(input.scope);
      if (typeof input.niche !== 'string' || input.niche.trim().length < 1 || input.niche.length > 512) {
        throw new InvalidRequestError('niche must be a trimmed string of 1-512 chars');
      }
      if (typeof input.platform !== 'string' || input.platform.trim().length < 1 || input.platform.length > 64) {
        throw new InvalidRequestError('platform must be a trimmed string of 1-64 chars');
      }
      assertValidLabCorpusAcquisitionPolicy(input.acquisitionPolicy);
      const row = await store.insertCorpus({
        corpusId: store.newId(),
        corpusVersion: 1,
        scope: input.scope,
        status: 'draft',
        niche: input.niche.trim(),
        platform: input.platform.trim(),
        acquisitionPolicy: input.acquisitionPolicy,
      });
      return mapCorpusRow(row);
    },

    async getCorpus(scope, corpusId) {
      assertScope(scope);
      return requireLatestCorpus(scope, corpusId);
    },

    async listCorpora(scope) {
      assertScope(scope);
      const rows = await store.listLatestCorpora(scope.clientId);
      return rows.map(mapCorpusRow);
    },

    async activateCorpus(scope, corpusId) {
      assertScope(scope);
      const corpus = await requireLatestCorpus(scope, corpusId);
      if (corpus.status !== 'draft') {
        throw new InvalidRequestError(`lab corpus ${corpusId} is ${corpus.status} — only a draft corpus can be activated`);
      }
      const row = await store.updateCorpusStatus(scope.clientId, corpusId, corpus.corpusVersion, 'active');
      if (row === null) throw new NotFoundError('lab corpus', corpusId);
      return mapCorpusRow(row);
    },

    async retireCorpus(scope, corpusId) {
      assertScope(scope);
      const corpus = await requireLatestCorpus(scope, corpusId);
      if (corpus.status !== 'active') {
        throw new InvalidRequestError(`lab corpus ${corpusId} is ${corpus.status} — only an active corpus can be retired`);
      }
      const row = await store.updateCorpusStatus(scope.clientId, corpusId, corpus.corpusVersion, 'retired');
      if (row === null) throw new NotFoundError('lab corpus', corpusId);
      return mapCorpusRow(row);
    },

    async correctCorpus(scope, corpusId, correction) {
      assertScope(scope);
      const corpus = await requireLatestCorpus(scope, corpusId);
      if (corpus.corpusVersion >= LAB_CORPUS_MAX_VERSIONS) {
        throw new InvalidRequestError(`lab corpus ${corpusId} has reached the version chain bound (${LAB_CORPUS_MAX_VERSIONS})`);
      }
      const niche = correction.niche ?? corpus.niche;
      const platform = correction.platform ?? corpus.platform;
      const acquisitionPolicy = correction.acquisitionPolicy ?? corpus.acquisitionPolicy;
      if (typeof niche !== 'string' || niche.trim().length < 1 || niche.length > 512) {
        throw new InvalidRequestError('niche must be a trimmed string of 1-512 chars');
      }
      if (typeof platform !== 'string' || platform.trim().length < 1 || platform.length > 64) {
        throw new InvalidRequestError('platform must be a trimmed string of 1-64 chars');
      }
      assertValidLabCorpusAcquisitionPolicy(acquisitionPolicy);
      // A correction starts a fresh chain as draft (the activation gate
      // applies per version: the corrected version must be re-activated
      // before scenario bindings cite it).
      const row = await store.insertCorpus({
        corpusId,
        corpusVersion: corpus.corpusVersion + 1,
        scope: { agencyId: corpus.agencyId, clientId: corpus.clientId, workspaceId: corpus.workspaceId },
        status: 'draft',
        niche: niche.trim(),
        platform: platform.trim(),
        acquisitionPolicy,
      });
      return mapCorpusRow(row);
    },

    // --- Provider-neutral ingestion (the dedup fence + the policy gate) ---

    async registerReference(input) {
      assertScope(input.scope);
      assertUuidShape('lab corpus', input.corpusId);
      const nowIso = store.nowIso();
      assertValidLabCorpusReferenceInput(input, nowIso);
      const corpus = await requireLatestCorpus(input.scope, input.corpusId);
      if (corpus.status === 'retired') {
        throw new InvalidRequestError(`lab corpus ${input.corpusId} is retired — new ingestion is refused`);
      }
      // THE PROVIDER-SPECIFIC ACQUISITION POLICY GATE (§4): the
      // provider must be declared in the corpus policy and the
      // declared rights basis must be permitted for that provider
      // under the CURRENT policy version.
      const providerPolicy = corpus.acquisitionPolicy.providers[input.provider];
      if (providerPolicy === undefined) {
        throw new InvalidRequestError(`provider '${input.provider}' is not declared in the corpus acquisition policy`);
      }
      if (!providerPolicy.permittedBases.includes(input.rightsBasis)) {
        throw new InvalidRequestError(`rights basis '${input.rightsBasis}' is not permitted for provider '${input.provider}' under the corpus acquisition policy`);
      }
      // THE DEDUPLICATION FENCE: one reference per (client, provider,
      // provider_content_id) — re-ingestion appends an observation.
      const existing = await store.findReferenceByProviderContentId(input.scope.clientId, input.provider, input.providerContentId);
      if (existing !== null) {
        const observation = await appendObservation(
          input.scope,
          existing.reference_id,
          {
            observedAt: nowIso,
            collectionMethod: input.collectionMethod,
            collectionVersion: input.collectionVersion,
            metadataDigest: input.metadataDigest,
            mediaAvailability: input.mediaAvailability ?? 'unknown',
          },
        );
        void observation;
        const refreshed = await store.findReference(input.scope.clientId, existing.reference_id);
        return mapReferenceRow(refreshed ?? existing);
      }
      const referenceId = store.newId();
      return withTx(async (txStore) => {
        const referenceRow = await txStore.insertReference({
          referenceId,
          corpusId: corpus.corpusId,
          corpusVersion: corpus.corpusVersion,
          scope: input.scope,
          provider: input.provider,
          providerContentId: input.providerContentId,
          canonicalUrl: input.canonicalUrl,
          creatorRef: input.creatorRef ?? null,
          publicationTime: input.publicationTime ?? null,
          observationTime: nowIso,
          rightsBasis: input.rightsBasis,
          collectionMethod: input.collectionMethod,
          collectionVersion: input.collectionVersion,
          metadataSnapshot: input.metadataSnapshot,
          metadataDigest: input.metadataDigest,
          mediaAvailability: input.mediaAvailability ?? 'unknown',
        });
        // The first sighting is observation #1 of the append-only tail
        // (the reference row's observation_time is the same instant —
        // the tail is complete from birth).
        await txStore.insertObservation({
          observationId: txStore.newId(),
          referenceId,
          scope: input.scope,
          observedAt: nowIso,
          collectionMethod: input.collectionMethod,
          collectionVersion: input.collectionVersion,
          metadataDigest: input.metadataDigest,
          mediaAvailability: input.mediaAvailability ?? 'unknown',
        });
        return mapReferenceRow(referenceRow);
      });
    },

    async getReference(scope, referenceId) {
      assertScope(scope);
      return requireReference(scope, referenceId);
    },

    async listReferences(scope, corpusId, provider) {
      assertScope(scope);
      if (corpusId !== undefined) assertUuidShape('lab corpus', corpusId);
      const rows = await store.listReferences(scope.clientId, corpusId, provider);
      return rows.map(mapReferenceRow);
    },

    // --- Observation history ---

    async recordObservation(input) {
      assertScope(input.scope);
      assertUuidShape('lab corpus reference', input.referenceId);
      const nowIso = store.nowIso();
      assertValidLabCorpusObservationInput(input, nowIso);
      // Foreign/unknown scope resolves to the uniform NotFound BEFORE
      // any write (the migration scope trigger is the backstop).
      await requireReference(input.scope, input.referenceId);
      return appendObservation(input.scope, input.referenceId, {
        observedAt: input.observedAt ?? nowIso,
        collectionMethod: input.collectionMethod,
        collectionVersion: input.collectionVersion,
        metadataDigest: input.metadataDigest,
        mediaAvailability: input.mediaAvailability,
      });
    },

    async listObservations(scope, referenceId) {
      assertScope(scope);
      assertUuidShape('lab corpus reference', referenceId);
      await requireReference(scope, referenceId);
      const rows = await store.listObservations(scope.clientId, referenceId);
      return rows.map(mapObservationRow);
    },

    // --- Coverage reporting ---

    async coverageReport(scope, corpusId) {
      assertScope(scope);
      const corpus = await requireLatestCorpus(scope, corpusId);
      const [byProviderRows, byAvailabilityRows, extraction, collisionGroups, window] = await Promise.all([
        store.countReferencesByFacet(scope.clientId, corpusId, 'provider'),
        store.countReferencesByFacet(scope.clientId, corpusId, 'media_availability'),
        store.countExtractionStates(scope.clientId, corpusId),
        store.countDigestCollisionGroups(scope.clientId, corpusId),
        store.observationWindow(scope.clientId, corpusId),
      ]);
      const byProvider: Record<string, number> = {};
      for (const row of byProviderRows) byProvider[row.key] = Number(row.n);
      const byMediaAvailability: Record<string, number> = {};
      for (const row of byAvailabilityRows) byMediaAvailability[row.key] = Number(row.n);
      const totalReferences = Object.values(byProvider).reduce((sum, n) => sum + n, 0);
      return {
        corpusId,
        corpusVersion: corpus.corpusVersion,
        computedAt: store.nowIso(),
        totalReferences,
        byProvider,
        byMediaAvailability,
        extractedReferences: extraction.extracted,
        pendingExtractionReferences: extraction.pending,
        digestCollisionGroups: collisionGroups,
        totalObservations: window.total,
        oldestObservationAt: window.oldest === null ? null : new Date(window.oldest).toISOString(),
        newestObservationAt: window.newest === null ? null : new Date(window.newest).toISOString(),
      };
    },
  };
}
