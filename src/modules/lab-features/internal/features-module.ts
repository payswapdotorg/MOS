/**
 * /lab-features module implementation (LAB-003 — the Multimodal
 * Content Feature Bundle).
 *
 * THE ORCHESTRATION ONLY: this module composes the LabFeaturesStore
 * (the migration-065 tables) with the PURE contract guards of
 * validation.ts and the two REPLACEABLE ports (the extractor + the
 * media fetch — the LAB-002 ingestion-seam precedent, wired at the
 * composition root; test doubles satisfy the same contracts).
 *
 * THE EXTRACTION PIPELINE (§4's chain "Reference → permitted media
 * access → decode/stream → feature extraction → feature bundle",
 * with the gates fail-closed in order):
 *
 *   1. shape gate      — the citation + grant fences (a semantically
 *                        invalid citation or grant is the honest
 *                        per-item invalid_input outcome — exactly one
 *                        outcome per item, never a whole-batch
 *                        rejection);
 *   2. scope gate      — the citation's RECORDED owning client must
 *                        match the batch scope (scope_mismatch — the
 *                        recorded-data tenant fence; the real boundary
 *                        stays the caller's own corpus-side scope
 *                        discipline, disclosed);
 *   3. duplicate gate  — the same reference cited twice in ONE batch
 *                        skips the second occurrence;
 *   4. identity        — the deterministic input digest + identity
 *                        digest (pure functions); an identity that
 *                        already exists is the honest
 *                        skipped/already_extracted outcome citing the
 *                        existing bundle (idempotent by construction);
 *   5. MEDIA GATE      — a presented grant fails closed BEFORE any
 *                        bytes are requested unless it is exactly
 *                        (available_permitted, reference_gated):
 *                        availability unknown/provider_unavailable/
 *                        withdrawn → media_unavailable;
 *                        available_rights_unclear or a metadata_only
 *                        posture → rights_not_permitted (§4: a public
 *                        URL grants NOTHING). The gate runs BEFORE the
 *                        modality gate — the §4 chain orders access
 *                        (Reference → permitted media access) before
 *                        decode (→ decode/stream → feature
 *                        extraction): the item's own access posture is
 *                        decided first, the extractor's capability to
 *                        serve a required modality second;
 *   6. modality gate   — a required modality outside the extractor's
 *                        supported set fails closed
 *                        (unsupported_modality) BEFORE extraction;
 *   7. the fetch port  — only a validated grant reaches the port; a
 *                        port refusal fails the item with the port's
 *                        closed reason (the provider adapters enforce
 *                        their own constraints, §4); pending/granted
 *                        outcomes ride through to the extractor (the
 *                        granted bytes on the IN-MEMORY HANDLE, this
 *                        call only — never persisted);
 *   8. the extractor   — a terminal extractor failure fails the item
 *                        with its closed reason; a thrown error or a
 *                        malformed value map fails the item
 *                        extraction_error (never invented success);
 *   9. the bundle      — the value map is validated (the closed
 *                        27-key accounting), the bundle INSERTS as
 *                        the next version on the per-reference
 *                        append-only chain, and the item outcome is
 *                        written in the SAME transaction.
 *
 * THE RUN DISCIPLINE: the batch run row is born 'running' before the
 * first item and advances to 'completed' exactly once with the
 * summary counts SQL-COMPUTED from the item outcome rows (never
 * asserted separately). A module-level error (DB unavailability, a
 * lost chain race against the UNIQUE fences) aborts the call and the
 * run HONESTLY STAYS 'running' with its committed partial outcomes —
 * re-driving the batch is safe (the committed identities skip as
 * already_extracted); the durable resumable-run machinery is the §23
 * LAB runtime layer, not this module (disclosed).
 *
 * THE SCOPE DISCIPLINE (§22): every read resolves foreign/unknown
 * scope to the uniform NotFound (no existence oracle) — exactly the
 * /lab and /lab-corpus house pattern.
 */

import { InvalidRequestError, NotFoundError } from '../../../platform/errors/errors.ts';
import type {
  LabFeatureBatchItemRecord,
  LabFeatureBatchRunRecord,
  LabFeatureExtractionConfiguration,
  LabFeatureExtractionFailure,
  LabFeatureExtractionInput,
  LabFeatureExtractionResult,
  LabFeatureFailureReason,
  LabFeatureMediaGrant,
  LabFeatureModality,
  LabFeatureReferenceCitation,
  LabFeatureValueMap,
  LabFeaturesModuleApi,
  LabFeaturesModuleDeps,
  LabFeaturesScope,
} from '../public.ts';
import {
  LAB_FEATURES_MAX_BUNDLE_VERSIONS,
  LAB_FEATURE_MODALITIES,
  LAB_FEATURE_SET_VERSION,
} from '../public.ts';
import {
  assertValidLabFeatureBatchInput,
  assertValidLabFeatureCitation,
  assertValidLabFeatureMediaGrant,
  assertValidLabFeatureValueMap,
  computeLabFeatureIdentityDigest,
  computeLabFeatureInputDigest,
} from './validation.ts';
import { LabFeaturesStore, mapBundleRow, mapItemRow, mapRunRow } from './features-store.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXTRACTOR_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function assertScope(scope: LabFeaturesScope): void {
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

/**
 * The honest citation echo for an outcome row: a field is echoed ONLY
 * when it passes its own fence (a malformed field is honestly NULL,
 * never a fabricated placeholder — an invalid_input item's citation
 * may be malformed enough to carry no echo at all).
 */
function citationEcho(citation: LabFeatureReferenceCitation | null | undefined): {
  referenceId: string | null;
  provider: string | null;
  providerContentId: string | null;
} {
  if (citation === null || typeof citation !== 'object') {
    return { referenceId: null, provider: null, providerContentId: null };
  }
  const referenceId =
    typeof citation.referenceId === 'string' && UUID_PATTERN.test(citation.referenceId) ? citation.referenceId : null;
  const provider = typeof citation.provider === 'string' && PROVIDER_PATTERN.test(citation.provider) ? citation.provider : null;
  const providerContentId =
    typeof citation.providerContentId === 'string' &&
    citation.providerContentId.length >= 1 &&
    citation.providerContentId.length <= 256 &&
    citation.providerContentId.length === citation.providerContentId.trim().length
      ? citation.providerContentId
      : null;
  return { referenceId, provider, providerContentId };
}

export function createLabFeaturesModule(deps: LabFeaturesModuleDeps): LabFeaturesModuleApi {
  const extractor = deps.extractor;
  // The extractor declaration is validated ONCE at wiring time (fail
  // fast): the pinned feature-set version + the shaped identity + the
  // closed modality vocabulary.
  if (extractor === null || typeof extractor !== 'object') {
    throw new InvalidRequestError('deps.extractor must be a LabFeatureExtractor');
  }
  if (!EXTRACTOR_ID_PATTERN.test(String(extractor.extractorId))) {
    throw new InvalidRequestError('deps.extractor.extractorId must be 1-64 chars of [a-z0-9-]');
  }
  if (typeof extractor.extractorVersion !== 'string' || extractor.extractorVersion.length < 1 || extractor.extractorVersion.length > 64) {
    throw new InvalidRequestError('deps.extractor.extractorVersion must be 1-64 chars');
  }
  if (extractor.featureSetVersion !== LAB_FEATURE_SET_VERSION) {
    throw new InvalidRequestError(
      `deps.extractor.featureSetVersion must be '${LAB_FEATURE_SET_VERSION}' (the module's pinned feature-set version)`,
    );
  }
  if (!Array.isArray(extractor.supportedModalities)) {
    throw new InvalidRequestError('deps.extractor.supportedModalities must be an array');
  }
  for (const modality of extractor.supportedModalities) {
    if (!LAB_FEATURE_MODALITIES.includes(modality as LabFeatureModality)) {
      throw new InvalidRequestError(`deps.extractor.supportedModalities entry '${String(modality)}' is not in the closed modality vocabulary`);
    }
  }
  if (deps.mediaFetch === null || typeof deps.mediaFetch !== 'object' || typeof deps.mediaFetch.fetchMedia !== 'function') {
    throw new InvalidRequestError('deps.mediaFetch must be a LabMediaFetchPort');
  }

  const store = new LabFeaturesStore(deps.db, deps.clock, deps.ids);

  /** Runs the body against a transaction-bound store. */
  const withTx = <T>(body: (txStore: LabFeaturesStore) => Promise<T>): Promise<T> =>
    deps.db.transaction((tx) => body(new LabFeaturesStore(tx, deps.clock, deps.ids)));

  /**
   * The §4 media gate: ONLY (available_permitted, reference_gated)
   * opens the path — everything else fails closed BEFORE any bytes are
   * requested. The truth table: unknown / provider_unavailable /
   * withdrawn are AVAILABILITY failures (the media is not assertably
   * there → media_unavailable); available_rights_unclear is a RIGHTS
   * failure (the media may exist, but unclear rights never open a path
   * — §4's public-URL-grants-NOTHING rule → rights_not_permitted);
   * available_permitted opens ONLY under the reference_gated posture
   * (a metadata_only posture means no media path is even requestable
   * for this provider under the corpus policy →
   * rights_not_permitted).
   */
  const mediaGateFailure = (grant: LabFeatureMediaGrant): LabFeatureFailureReason | null => {
    if (grant.availability === 'unknown' || grant.availability === 'provider_unavailable' || grant.availability === 'withdrawn') {
      return 'media_unavailable';
    }
    if (grant.availability === 'available_rights_unclear') {
      return 'rights_not_permitted';
    }
    if (grant.posture !== 'reference_gated') {
      return 'rights_not_permitted';
    }
    return null;
  };

  const requireRun = async (scope: LabFeaturesScope, runId: string): Promise<LabFeatureBatchRunRecord> => {
    assertUuidShape('lab feature batch run', runId);
    const runRow = await store.findRun(scope.clientId, runId);
    if (runRow === null) {
      throw new NotFoundError('lab feature batch run', runId);
    }
    const itemRows = await store.listItems(runId);
    return mapRunRow(runRow, itemRows.map(mapItemRow));
  };

  return {
    async extractBatch(input) {
      assertScope(input.scope);
      assertValidLabFeatureBatchInput(input);
      const configuration: LabFeatureExtractionConfiguration = input.configuration ?? {};
      const requiredModalities: ReadonlyArray<LabFeatureModality> = configuration.requiredModalities ?? [];

      // The run row is born running BEFORE the first item (the
      // provenance anchor bundles FK into).
      const runId = store.newId();
      const runRow = await store.insertRun({
        runId,
        scope: input.scope,
        itemCount: input.items.length,
        extractorId: extractor.extractorId,
        extractorVersion: extractor.extractorVersion,
        featureSetVersion: extractor.featureSetVersion,
        requiredModalities,
      });
      void runRow;

      // The per-reference duplicate fence (one batch, one outcome per
      // reference — the second occurrence skips).
      const seenReferenceIds = new Set<string>();

      const writeOutcome = (
        seq: number,
        citation: LabFeatureReferenceCitation | null | undefined,
        outcome: {
          kind: 'extracted';
          bundleId: string;
          identityDigest: string;
        }
        | { kind: 'skipped'; reason: 'duplicate_citation_in_batch' | 'already_extracted'; bundleId: string | null; identityDigest: string | null }
        | { kind: 'failed'; reason: LabFeatureFailureReason; detail: string; identityDigest: string | null },
      ): Promise<LabFeatureBatchItemRecord> => {
        const echo = citationEcho(citation);
        return withTx(async (txStore) => {
          const itemRow = await txStore.insertItem({
            itemId: txStore.newId(),
            runId,
            scope: input.scope,
            bundleId: outcome.kind === 'failed' ? null : outcome.bundleId,
            referenceId: echo.referenceId,
            provider: echo.provider,
            providerContentId: echo.providerContentId,
            seq,
            outcome: outcome.kind,
            failureReason: outcome.kind === 'failed' ? outcome.reason : null,
            skipReason: outcome.kind === 'skipped' ? outcome.reason : null,
            errorDetail:
              outcome.kind === 'failed'
                ? outcome.detail.length > 512
                  ? `${outcome.detail.slice(0, 509)}...`
                  : outcome.detail
                : null,
            identityDigest: outcome.kind === 'extracted' ? outcome.identityDigest : outcome.identityDigest,
          });
          return mapItemRow(itemRow);
        });
      };

      for (let seq = 1; seq <= input.items.length; seq += 1) {
        const item = input.items[seq - 1]!;
        const citation = item?.citation;

        // (1) shape gate — the citation + grant fences; a
        // semantically invalid citation or grant is the honest
        // per-item failed/invalid_input outcome (exactly one outcome
        // per item, never a whole-batch rejection).
        try {
          assertValidLabFeatureCitation(citation);
          if (item.mediaGrant !== undefined && item.mediaGrant !== null) {
            assertValidLabFeatureMediaGrant(item.mediaGrant);
          }
        } catch (error) {
          await writeOutcome(seq, citation, {
            kind: 'failed',
            reason: 'invalid_input',
            detail: error instanceof Error ? error.message : String(error),
            identityDigest: null,
          });
          continue;
        }

        // (2) scope gate — the recorded owning client must match.
        if (citation.clientId !== input.scope.clientId) {
          await writeOutcome(seq, citation, {
            kind: 'failed',
            reason: 'scope_mismatch',
            detail: `the citation's recorded owning client ${citation.clientId} does not match the batch scope client ${input.scope.clientId}`,
            identityDigest: null,
          });
          continue;
        }

        // (3) duplicate gate
        if (seenReferenceIds.has(citation.referenceId)) {
          await writeOutcome(seq, citation, {
            kind: 'skipped',
            reason: 'duplicate_citation_in_batch',
            bundleId: null,
            identityDigest: null,
          });
          continue;
        }
        seenReferenceIds.add(citation.referenceId);

        // (4) the deterministic identity (pure functions).
        const inputDigest = computeLabFeatureInputDigest({
          citation,
          mediaGrant: item.mediaGrant ?? undefined,
          configuration,
        });
        const identityDigest = computeLabFeatureIdentityDigest({
          referenceIdentity: {
            referenceId: citation.referenceId,
            corpusId: citation.corpusId,
            corpusVersion: citation.corpusVersion,
            provider: citation.provider,
            providerContentId: citation.providerContentId,
            canonicalUrl: citation.canonicalUrl,
            metadataDigest: citation.metadataDigest,
          },
          featureSetVersion: extractor.featureSetVersion,
          extractorIdentity: { extractorId: extractor.extractorId, extractorVersion: extractor.extractorVersion },
          inputDigest,
        });

        // The idempotence probe: the same deterministic identity is
        // the same bundle, ever (per client).
        const existing = await store.findBundleByIdentity(input.scope.clientId, identityDigest);
        if (existing !== null) {
          await writeOutcome(seq, citation, {
            kind: 'skipped',
            reason: 'already_extracted',
            bundleId: existing.bundle_id,
            identityDigest,
          });
          continue;
        }

        // (5) THE MEDIA GATE — fail closed BEFORE any bytes are
        // requested (§4: only available_permitted + reference_gated
        // opens the provider/rights-gated path; the gate runs BEFORE
        // the modality gate — the §4 chain orders access before
        // decode).
        const grant = item.mediaGrant ?? undefined;
        if (grant !== undefined) {
          const gateFailure = mediaGateFailure(grant);
          if (gateFailure !== null) {
            await writeOutcome(seq, citation, {
              kind: 'failed',
              reason: gateFailure,
              detail:
                gateFailure === 'media_unavailable'
                  ? `the presented media grant failed the availability gate (availability '${grant.availability}') — no media path may open`
                  : `the presented media grant failed the rights/posture gate (availability '${grant.availability}', posture '${grant.posture}') — a public URL grants nothing`,
              identityDigest,
            });
            continue;
          }
        }

        // (6) modality gate — a required modality outside the
        // extractor's supported set fails closed BEFORE extraction.
        const unsupported = requiredModalities.find((modality) => !extractor.supportedModalities.includes(modality));
        if (unsupported !== undefined) {
          await writeOutcome(seq, citation, {
            kind: 'failed',
            reason: 'unsupported_modality',
            detail: `the extraction configuration requires modality '${unsupported}' which extractor ${extractor.extractorId} v${extractor.extractorVersion} does not serve (supported: ${[...extractor.supportedModalities].join(', ') || 'none'})`,
            identityDigest,
          });
          continue;
        }

        // (7) the fetch port — only a validated grant reaches it.
        let mediaFetch: LabFeatureExtractionInput['mediaFetch'] = undefined;
        if (grant !== undefined) {
          try {
            const fetchOutcome = await deps.mediaFetch.fetchMedia({ citation, grant });
            if (fetchOutcome.status === 'refused') {
              await writeOutcome(seq, citation, {
                kind: 'failed',
                reason: fetchOutcome.reason,
                detail: `the media fetch port refused: ${fetchOutcome.detail}`,
                identityDigest,
              });
              continue;
            }
            mediaFetch = fetchOutcome;
          } catch (error) {
            await writeOutcome(seq, citation, {
              kind: 'failed',
              reason: 'extraction_error',
              detail: `the media fetch port threw: ${error instanceof Error ? error.message : String(error)}`,
              identityDigest,
            });
            continue;
          }
        }

        // (8) the extractor port.
        let extraction: LabFeatureExtractionResult | LabFeatureExtractionFailure;
        try {
          extraction = await extractor.extract({ citation, grant, mediaFetch, configuration });
        } catch (error) {
          await writeOutcome(seq, citation, {
            kind: 'failed',
            reason: 'extraction_error',
            detail: `the extractor threw: ${error instanceof Error ? error.message : String(error)}`,
            identityDigest,
          });
          continue;
        }
        if ('reason' in extraction && 'values' in extraction === false) {
          const failureDetail = typeof (extraction as LabFeatureExtractionFailure).detail === 'string'
            ? (extraction as LabFeatureExtractionFailure).detail
            : `extractor ${extractor.extractorId} v${extractor.extractorVersion} reported failure reason '${String((extraction as LabFeatureExtractionFailure).reason)}' with no detail`;
          await writeOutcome(seq, citation, {
            kind: 'failed',
            reason: (extraction as LabFeatureExtractionFailure).reason,
            detail: failureDetail.length > 512 ? `${failureDetail.slice(0, 509)}...` : failureDetail,
            identityDigest,
          });
          continue;
        }
        const result = extraction as LabFeatureExtractionResult;
        try {
          assertValidLabFeatureValueMap(result.values);
        } catch (error) {
          await writeOutcome(seq, citation, {
            kind: 'failed',
            reason: 'extraction_error',
            detail: `the extractor returned a malformed value map: ${error instanceof Error ? error.message : String(error)}`,
            identityDigest,
          });
          continue;
        }

        // (9) the bundle: the next version on the per-reference
        // append-only chain + the outcome row, ONE transaction.
        const latest = await store.findLatestBundleVersion(input.scope.clientId, citation.referenceId);
        const bundleVersion = (latest === null ? 0 : Number(latest.bundle_version)) + 1;
        if (bundleVersion > LAB_FEATURES_MAX_BUNDLE_VERSIONS) {
          await writeOutcome(seq, citation, {
            kind: 'failed',
            reason: 'extraction_error',
            detail: `the per-reference bundle version chain has reached the bound (${LAB_FEATURES_MAX_BUNDLE_VERSIONS})`,
            identityDigest,
          });
          continue;
        }
        const values = result.values as LabFeatureValueMap;
        const derivedFeatureCount = Object.values(values).filter((value) => value.state === 'derived').length;
        const bundleId = store.newId();
        try {
          await withTx(async (txStore) => {
            await txStore.insertBundle({
              bundleId,
              referenceId: citation.referenceId,
              bundleVersion,
              scope: input.scope,
              runId,
              corpusId: citation.corpusId,
              corpusVersion: citation.corpusVersion,
              provider: citation.provider,
              providerContentId: citation.providerContentId,
              canonicalUrl: citation.canonicalUrl,
              metadataDigest: citation.metadataDigest,
              mediaAvailabilityAtExtraction: citation.mediaAvailability,
              grantPosture: grant !== undefined ? grant.posture : 'metadata_only',
              mediaFetchStatus: result.mediaFetchStatus,
              mediaFetchDetail: result.mediaFetchDetail,
              mediaFetchBytes: result.mediaFetchBytes,
              featureSetVersion: extractor.featureSetVersion,
              extractorId: extractor.extractorId,
              extractorVersion: extractor.extractorVersion,
              identityDigest,
              inputDigest,
              requiredModalities,
              features: values,
              derivedFeatureCount,
              unavailableFeatureCount: Object.keys(values).length - derivedFeatureCount,
            });
            await txStore.insertItem({
              itemId: txStore.newId(),
              runId,
              scope: input.scope,
              bundleId,
              referenceId: citation.referenceId,
              provider: citation.provider,
              providerContentId: citation.providerContentId,
              seq,
              outcome: 'extracted',
              failureReason: null,
              skipReason: null,
              errorDetail: null,
              identityDigest,
            });
          });
        } catch (error) {
          // A lost identity/chain race against the UNIQUE fences
          // surfaces as the honest item failure (the competing batch
          // produced the bundle first).
          await writeOutcome(seq, citation, {
            kind: 'failed',
            reason: 'extraction_error',
            detail: `the bundle insert failed: ${error instanceof Error ? error.message : String(error)}`,
            identityDigest,
          });
          continue;
        }
      }

      // The completion advance: summary counts SQL-computed from the
      // item outcome rows (never asserted separately).
      const completed = await store.completeRun(runId);
      if (completed === null) {
        throw new NotFoundError('lab feature batch run', runId);
      }
      const itemRows = await store.listItems(runId);
      return mapRunRow(completed, itemRows.map(mapItemRow));
    },

    async getBatchRun(scope, runId) {
      assertScope(scope);
      return requireRun(scope, runId);
    },

    async listBatchRuns(scope) {
      assertScope(scope);
      const runRows = await store.listRuns(scope.clientId);
      return runRows.map((runRow) => mapRunRow(runRow, []));
    },

    async getBundle(scope, bundleId) {
      assertScope(scope);
      assertUuidShape('lab feature bundle', bundleId);
      const bundleRow = await store.findBundle(scope.clientId, bundleId);
      if (bundleRow === null) {
        throw new NotFoundError('lab feature bundle', bundleId);
      }
      return mapBundleRow(bundleRow);
    },

    async listBundles(scope, referenceId) {
      assertScope(scope);
      assertUuidShape('lab corpus reference', referenceId);
      const bundleRows = await store.listBundlesByReference(scope.clientId, referenceId);
      return bundleRows.map(mapBundleRow);
    },
  };
}
