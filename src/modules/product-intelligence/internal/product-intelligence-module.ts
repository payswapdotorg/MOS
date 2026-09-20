/**
 * /product-intelligence module implementation (MKT-069).
 *
 * Owns the migration 048 tables (through the store): the agency-scoped
 * product-context records, the append-only version tail (the IMMUTABLE
 * declared inputs — corrections are NEW version records), the
 * deterministic inspection pipeline (public page fetch/extract through the
 * GET-only page-reader port + authorized reads through the READ-ONLY
 * /integrations structural port), the append-only retained source facts,
 * the append-only derived model records with FK-anchored evidence links
 * and the append-only risk flags.
 *
 * READ-ONLY GUARANTEE (boundary rule 7): this module expresses NO mutation
 * toward any external source — the page-reader port has no method field at
 * all and the integrations port exposes getConnection + executeRead ONLY
 * (executeMutation is structurally absent). A future write capability is
 * the separately-granted capability-key seam documented in public.ts and
 * docs/implementation/MKT-069.md — deliberately NOT built.
 *
 * NO mission-strategy logic lives here (MKT-070 is a later Work Item):
 * the model records are attachable BY REFERENCE through the read surface.
 *
 * Concurrency: context-record mutations are row-locked CAS transactions;
 * the inspection pipeline performs its bounded external reads FIRST and
 * then persists under the context row lock (a concurrent correction is an
 * honest 409 — the re-run inspects the new inputs).
 */

import {
  ConflictError,
  NotFoundError,
  PolicyDeniedError,
} from '../../../platform/errors/errors.ts';
import type { DbTransaction } from '../../../platform/db/contract.ts';
import type {
  ProductContextDetail,
  ProductContextOwnerContext,
  ProductContextRecord,
  ProductContextVersionRecord,
  ProductInspectionInputRunRecord,
  ProductInspectionRunRecord,
  ProductIntelligenceModuleApi,
  ProductIntelligenceModuleDeps,
  ProductIntelligenceProvenance,
} from '../public.ts';
import {
  PRODUCT_INTELLIGENCE_DERIVED_RECORD_TIER,
  PRODUCT_INTELLIGENCE_HTML_EXTRACTOR,
  PRODUCT_INTELLIGENCE_INTEGRATION_EXTRACTOR,
  PRODUCT_INTELLIGENCE_VOCABULARY_VERSION,
} from '../public.ts';
import {
  assertValidProductContextDeclaration,
  assertValidProductDerivedModelInput,
  assertValidProductIntelligenceProvenance,
  assertValidProductRiskFlagInput,
  composeProductContextOwnerContext,
  derivedVerificationState,
  extractHtmlSourceFacts,
  hashContent,
  ProductIntelligenceStore,
} from './product-intelligence-store.ts';
import type { ExtractedFactCandidate } from './product-intelligence-store.ts';

/**
 * The frozen per-kind authorized-read operation labels (the /integrations
 * NORMALIZED contract operations this module requests): the repository and
 * workspace operations await their future adapters (no first-party adapter
 * declares them yet — an inspection over such an input records the honest
 * capability-refused outcome, never an invented read); the catalog and
 * analytics operations are the EXISTING normalized labels the commerce-cms
 * and generic-analytics adapters declare.
 */
const INPUT_READ_OPERATIONS: Readonly<Record<string, string>> = {
  source_repository: 'repository.read',
  source_workspace: 'workspace.read',
  catalog_inventory: 'listContent',
  current_analytics: 'runReport',
};

/** The bounded inspection envelope (the platform HttpCallPort bounds). */
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_SIZE_CAP_BYTES = 262_144;
const MAX_RECORDS_PER_READ = 25;
const MAX_FACTS_PER_INPUT = 32;

/** One retained fact with its content hash (of the MATERIAL it was extracted from). */
interface PlannedFact {
  readonly candidate: ExtractedFactCandidate;
  readonly contentHash: string;
  readonly fetchedAt: string;
}

/** One input's inspection plan outcome (before persistence). */
interface PlannedInputOutcome {
  readonly inputId: string;
  readonly outcome: ProductInspectionInputRunRecord['outcome'];
  readonly detail: string | null;
  readonly facts: readonly PlannedFact[];
  readonly sourceRef: string;
}

const ERROR_OUTCOMES: ReadonlySet<string> = new Set([
  'unauthorized_refused',
  'fetch_http_error',
  'fetch_transport_error',
  'read_error',
  'read_refused',
]);

export function createProductIntelligenceModule(
  deps: ProductIntelligenceModuleDeps,
): ProductIntelligenceModuleApi {
  const store = new ProductIntelligenceStore(deps.db, deps.clock, deps.ids);
  const { clock, pageReader, integrations, aiRuntime } = deps;

  return {
    async createProductContext(input, provenance) {
      assertValidProductIntelligenceProvenance(provenance);
      assertValidProductContextDeclaration(input.declaration);

      // The authorized inputs' connection references resolve through the
      // /integrations public contract BEFORE any write: unknown or FOREIGN
      // (cross-agency) connections are the uniform 404; a non-connected
      // connection is an honest 409 (authorized reads require an
      // authorized integration).
      await assertConnectionsUsable(
        integrations,
        input.agencyId,
        input.declaration.inputs as readonly { authorization: string; integrationConnectionId: string | null }[],
      );

      const productContextId = deps.ids.newId();
      const now = clock.nowIso();
      await deps.db.transaction(async (tx) => {
        await store.insertContext({
          productContextId,
          agencyId: input.agencyId,
          createdActor: provenance.actor,
          now,
        });
        await store.insertVersion(tx, {
          productContextVersionId: deps.ids.newId(),
          productContextId,
          versionSeq: 1,
          declaration: input.declaration,
          provenance,
        });
      });

      return await getDetailOrThrow(store, productContextId);
    },

    async getProductContext(productContextId) {
      return store.getContext(productContextId);
    },

    async resolveProductContextOwnership(productContextId) {
      const context = await store.getContext(productContextId);
      if (context === null) return null;
      return composeProductContextOwnerContext(
        context,
        clock.nowIso(),
      ) as ProductContextOwnerContext;
    },

    async listProductContextsForAgency(agencyId) {
      return store.listContextsForAgency(agencyId);
    },

    async getProductContextDetail(productContextId) {
      const context = await store.getContext(productContextId);
      if (context === null) return null;
      return composeDetail(store, context);
    },

    async getProductContextVersions(productContextId) {
      const context = await store.getContext(productContextId);
      if (context === null) return null;
      return store.listVersions(productContextId);
    },

    async getProductContextSourceFacts(productContextId) {
      const context = await store.getContext(productContextId);
      if (context === null) return null;
      return store.listSourceFacts(productContextId);
    },

    async getProductContextDerivedModels(productContextId) {
      const context = await store.getContext(productContextId);
      if (context === null) return null;
      return store.listDerivedModels(productContextId);
    },

    async getProductContextRiskFlags(productContextId) {
      const context = await store.getContext(productContextId);
      if (context === null) return null;
      return store.listRiskFlags(productContextId);
    },

    async getProductContextInspectionRuns(productContextId) {
      const context = await store.getContext(productContextId);
      if (context === null) return null;
      return store.listInspectionRuns(productContextId);
    },

    async recordProductContextVersion(input, provenance) {
      assertValidProductIntelligenceProvenance(provenance);
      assertValidProductContextDeclaration(input.declaration);

      const context = await store.getContext(input.productContextId);
      if (context === null) {
        throw new NotFoundError('product context', input.productContextId);
      }
      await assertConnectionsUsable(
        integrations,
        context.agencyId,
        input.declaration.inputs as readonly { authorization: string; integrationConnectionId: string | null }[],
      );

      await deps.db.transaction(async (tx) => {
        // CAS-serialized: row lock + explicit version check.
        const current = await lockContextOrThrow(store, tx, input.productContextId);
        if (current.version !== input.expectedVersion) {
          throw new ConflictError(
            `product context version mismatch: current version is ${current.version}`,
          );
        }
        // The correction path: append the NEW immutable version record,
        // advance the pointer (only ever forward).
        const nextVersionSeq = (await store.countVersions(tx, input.productContextId)) + 1;
        await store.insertVersion(tx, {
          productContextVersionId: deps.ids.newId(),
          productContextId: input.productContextId,
          versionSeq: nextVersionSeq,
          declaration: input.declaration,
          provenance,
        });
        const outcome = await store.advanceContextVersionRow(tx, {
          productContextId: input.productContextId,
          versionSeq: nextVersionSeq,
          expectedVersion: input.expectedVersion,
        });
        if (outcome !== 'ok') {
          throw new ConflictError('product context version update lost the version race');
        }
        return input.productContextId;
      });
      return await getDetailOrThrow(store, input.productContextId);
    },

    async runProductInspection(input, provenance) {
      assertValidProductIntelligenceProvenance(provenance);

      const context = await store.getContext(input.productContextId);
      if (context === null) {
        throw new NotFoundError('product context', input.productContextId);
      }

      // The CURRENT declared version + inputs (the inspection always
      // inspects the current declaration).
      const versions = await store.listVersions(input.productContextId);
      const currentVersion =
        versions.find((version) => version.versionSeq === context.currentVersionSeq) ?? versions[0];
      if (currentVersion === undefined) {
        throw new Error(
          `product context ${input.productContextId} has no declared version to inspect`,
        );
      }

      // The bounded deterministic inspection pass (external reads happen
      // BEFORE the persistence transaction; every outcome is honest data).
      const startedAt = clock.nowIso();
      const planned: PlannedInputOutcome[] = [];
      for (const declaredInput of currentVersion.inputs) {
        planned.push(
          await inspectOneInput(declaredInput, context, pageReader, integrations, provenance, clock),
        );
      }
      const finishedAt = clock.nowIso();

      const factsRetained = planned.reduce((sum, outcome) => sum + outcome.facts.length, 0);
      const errorCount = planned.filter((outcome) => ERROR_OUTCOMES.has(outcome.outcome)).length;
      const status: ProductInspectionRunRecord['status'] =
        planned.length === 0
          ? 'completed'
          : errorCount === planned.length
            ? 'failed'
            : errorCount > 0
              ? 'partial'
              : 'completed';

      const inspectionRunId = deps.ids.newId();
      await deps.db.transaction(async (tx) => {
        // Serialize against concurrent corrections: the version we
        // inspected must STILL be the current declaration — a correction
        // that landed mid-flight is an honest 409 (the re-run inspects
        // the new inputs).
        const current = await lockContextOrThrow(store, tx, input.productContextId);
        if (current.currentVersionSeq !== currentVersion.versionSeq) {
          throw new ConflictError(
            `product context ${input.productContextId} was corrected during the inspection (current version ${current.currentVersionSeq}, inspected ${currentVersion.versionSeq}) — re-run the inspection against the new declaration`,
          );
        }

        await store.insertInspectionRun(tx, {
          inspectionRunId,
          productContextId: input.productContextId,
          productContextVersionId: currentVersion.productContextVersionId,
          status,
          inputsInspected: planned.length,
          factsRetained,
          startedAt,
          finishedAt,
          provenance,
        });
        for (const outcome of planned) {
          await store.insertInspectionInputRun(tx, {
            inspectionRunId,
            inputId: outcome.inputId,
            outcome: outcome.outcome,
            detail: outcome.detail,
            factsExtracted: outcome.facts.length,
          });
          for (const fact of outcome.facts) {
            await store.insertSourceFact(tx, {
              sourceFactId: deps.ids.newId(),
              productContextId: input.productContextId,
              productContextVersionId: currentVersion.productContextVersionId,
              inputId: outcome.inputId,
              inspectionRunId,
              factKind: fact.candidate.factKind,
              sourceRef: outcome.sourceRef,
              fetchedAt: fact.fetchedAt,
              extractor:
                fact.candidate.factKind === 'source_record'
                  ? PRODUCT_INTELLIGENCE_INTEGRATION_EXTRACTOR
                  : PRODUCT_INTELLIGENCE_HTML_EXTRACTOR,
              contentHash: fact.contentHash,
              extractionNotes: fact.candidate.extractionNotes,
              content: fact.candidate.content,
              provenance,
            });
          }
        }
      });

      const runs = await store.listInspectionRuns(input.productContextId);
      const run = runs.find((entry) => entry.inspectionRunId === inspectionRunId);
      if (run === undefined) {
        throw new Error(`inspection run ${inspectionRunId} could not be read back`);
      }
      return run;
    },

    async recordDerivedModel(input, provenance) {
      assertValidProductIntelligenceProvenance(provenance);
      assertValidProductDerivedModelInput(input);

      const context = await store.getContext(input.productContextId);
      if (context === null) {
        throw new NotFoundError('product context', input.productContextId);
      }

      // Every cited evidence reference must resolve to a retained source
      // fact of the SAME context (uniform 404 — a foreign fact id is not
      // an oracle).
      for (const sourceFactId of input.evidenceSourceFactIds) {
        const fact = await store.getSourceFact(sourceFactId);
        if (fact === null || fact.productContextId !== input.productContextId) {
          throw new NotFoundError('source fact', sourceFactId);
        }
      }

      // The AI-assistance disclosure: a cited model must resolve through
      // the /ai-runtime registry (any lifecycle state — history records
      // derivations that HAPPENED).
      let aiSnapshot: { modelRegistryId: string; displayName: string } | null = null;
      if (input.aiAssistance !== null) {
        const model = await aiRuntime.getModel(input.aiAssistance.modelRegistryId);
        if (model === null) {
          throw new NotFoundError('model registry entry', input.aiAssistance.modelRegistryId);
        }
        aiSnapshot = { modelRegistryId: model.modelRegistryId, displayName: model.displayName };
      }

      // The correction path (the single-supersession discipline).
      if (input.supersedesDerivedModelId !== null) {
        const prior = await store.getDerivedModelById(input.supersedesDerivedModelId);
        if (prior === null) {
          throw new NotFoundError('derived model', input.supersedesDerivedModelId);
        }
        if (prior.productContextId !== input.productContextId) {
          throw new NotFoundError('derived model', input.supersedesDerivedModelId);
        }
        if (prior.derivationKind !== input.derivationKind) {
          throw new ConflictError(
            `derived model ${input.supersedesDerivedModelId} is of kind ${prior.derivationKind}; a correction must keep the same derivation kind`,
          );
        }
        if (prior.supersededByDerivedModelId !== null) {
          throw new ConflictError(
            `derived model ${input.supersedesDerivedModelId} is already superseded by ${prior.supersededByDerivedModelId} — the single-supersession fence`,
          );
        }
      }

      // THE SERVER-COMPUTED VERIFICATION STATE (never caller-declared;
      // the pure rule + the migration-048 deferred backstop).
      const verificationState = derivedVerificationState(input.evidenceSourceFactIds.length);

      const derivedModelId = deps.ids.newId();
      await deps.db.transaction(async (tx) => {
        await store.insertDerivedModel(tx, {
          derivedModelId,
          productContextId: input.productContextId,
          derivationKind: input.derivationKind,
          statement: input.statement,
          verificationState,
          supersedesDerivedModelId: input.supersedesDerivedModelId,
          aiModelRegistryId: aiSnapshot?.modelRegistryId ?? null,
          aiModelDisplay: aiSnapshot?.displayName ?? null,
          aiCallReference: input.aiAssistance?.callReference ?? null,
          provenance,
        });
        if (input.evidenceSourceFactIds.length > 0) {
          await store.insertDerivedModelEvidence(tx, {
            derivedModelId,
            sourceFactIds: input.evidenceSourceFactIds,
          });
        }
      });

      const record = await store.getDerivedModelById(derivedModelId);
      if (record === null) {
        throw new Error(`derived model ${derivedModelId} could not be read back`);
      }
      return record;
    },

    async getDerivedModel(derivedModelId) {
      return store.getDerivedModelById(derivedModelId);
    },

    async recordProductRiskFlag(input, provenance) {
      assertValidProductIntelligenceProvenance(provenance);
      assertValidProductRiskFlagInput(input);

      const context = await store.getContext(input.productContextId);
      if (context === null) {
        throw new NotFoundError('product context', input.productContextId);
      }
      for (const sourceFactId of input.evidenceSourceFactIds) {
        const fact = await store.getSourceFact(sourceFactId);
        if (fact === null || fact.productContextId !== input.productContextId) {
          throw new NotFoundError('source fact', sourceFactId);
        }
      }

      const riskFlagId = deps.ids.newId();
      await deps.db.transaction(async (tx) => {
        await store.insertRiskFlag(tx, {
          riskFlagId,
          productContextId: input.productContextId,
          category: input.category,
          severity: input.severity,
          statement: input.statement,
          mitigation: input.mitigation,
          provenance,
        });
        if (input.evidenceSourceFactIds.length > 0) {
          await store.insertRiskFlagEvidence(tx, {
            riskFlagId,
            sourceFactIds: input.evidenceSourceFactIds,
          });
        }
      });

      const record = await store.getRiskFlagById(riskFlagId);
      if (record === null) {
        throw new Error(`risk flag ${riskFlagId} could not be read back`);
      }
      return record;
    },

    async getProductRiskFlag(riskFlagId) {
      return store.getRiskFlagById(riskFlagId);
    },
  };
}

// ---------------------------------------------------------------------------
// The deterministic per-input inspection
// ---------------------------------------------------------------------------

/**
 * Inspects ONE declared input: public web kinds are fetched through the
 * GET-only page reader and deterministically extracted; authorized kinds
 * are read through the READ-ONLY /integrations port (the connection must
 * be connected; a policy-denied read is the honest 'read_refused'
 * outcome). The outcome is DATA — never an invented success. The CONTENT
 * HASH is the sha256 of the MATERIAL the facts were extracted from (the
 * fetched page body / the normalized provider record data).
 */
async function inspectOneInput(
  declaredInput: ProductContextVersionRecord['inputs'][number],
  context: ProductContextRecord,
  pageReader: ProductIntelligenceModuleDeps['pageReader'],
  integrations: ProductIntelligenceModuleDeps['integrations'],
  provenance: ProductIntelligenceProvenance,
  clock: ProductIntelligenceModuleDeps['clock'],
): Promise<PlannedInputOutcome> {
  const now = clock.nowIso();

  // THE PUBLIC WEB INPUTS: fetch + deterministic extraction.
  if (declaredInput.authorization === 'public') {
    let fetchOutcome;
    try {
      fetchOutcome = await pageReader.fetch({
        url: declaredInput.reference,
        timeoutMs: FETCH_TIMEOUT_MS,
        sizeCapBytes: FETCH_SIZE_CAP_BYTES,
      });
    } catch (error) {
      return {
        inputId: declaredInput.inputId,
        outcome: 'fetch_transport_error',
        detail: `page reader threw: ${errorText(error)}`,
        facts: [],
        sourceRef: declaredInput.reference,
      };
    }
    if (!fetchOutcome.ok) {
      if (fetchOutcome.transportRefused || fetchOutcome.timedOut) {
        return {
          inputId: declaredInput.inputId,
          outcome: 'fetch_transport_error',
          detail:
            fetchOutcome.error ?? `transport failure (status ${fetchOutcome.status ?? 'none'})`,
          facts: [],
          sourceRef: declaredInput.reference,
        };
      }
      return {
        inputId: declaredInput.inputId,
        outcome: 'fetch_http_error',
        detail: fetchOutcome.error ?? `http status ${fetchOutcome.status ?? 'none'}`,
        facts: [],
        sourceRef: declaredInput.reference,
      };
    }
    const body = fetchOutcome.body ?? '';
    const bodyHash = hashContent(body);
    const candidates = extractHtmlSourceFacts(body).slice(0, MAX_FACTS_PER_INPUT);
    if (candidates.length === 0) {
      return {
        inputId: declaredInput.inputId,
        outcome: 'no_facts_extracted',
        detail: 'the fetched page yielded no deterministic extraction candidates',
        facts: [],
        sourceRef: declaredInput.reference,
      };
    }
    return {
      inputId: declaredInput.inputId,
      outcome: 'facts_extracted',
      detail: null,
      facts: candidates.map((candidate) => ({
        candidate,
        contentHash: bodyHash,
        fetchedAt: now,
      })),
      sourceRef: declaredInput.reference,
    };
  }

  // THE AUTHORIZED INPUTS: read through the /integrations port, READ-ONLY.
  // (The kind-authorization fence guarantees authorization ===
  // 'authorized' here; the belt-and-braces refusal below is the honest
  // backstop for any future relaxation — boundary rule 7.)
  if (declaredInput.authorization !== 'authorized') {
    return {
      inputId: declaredInput.inputId,
      outcome: 'unauthorized_refused',
      detail:
        'boundary rule 7: repository/workspace/catalog/analytics inspection requires an explicitly authorized input — refused honestly',
      facts: [],
      sourceRef: declaredInput.reference,
    };
  }

  const connectionId = declaredInput.integrationConnectionId;
  if (connectionId === null) {
    return {
      inputId: declaredInput.inputId,
      outcome: 'unauthorized_refused',
      detail: 'the authorized input carries no integration connection reference',
      facts: [],
      sourceRef: declaredInput.reference,
    };
  }
  const connection = await integrations.getConnection(connectionId);
  if (connection === null || connection.agencyId !== context.agencyId) {
    return {
      inputId: declaredInput.inputId,
      outcome: 'read_refused',
      detail: 'the integration connection no longer resolves inside this agency',
      facts: [],
      sourceRef: declaredInput.reference,
    };
  }
  if (connection.status !== 'connected') {
    return {
      inputId: declaredInput.inputId,
      outcome: 'read_refused',
      detail: `the integration connection is ${connection.status} — authorized reads require a connected integration`,
      facts: [],
      sourceRef: declaredInput.reference,
    };
  }

  const operation = INPUT_READ_OPERATIONS[declaredInput.kind] ?? 'inspect.read';
  let readOutcome;
  try {
    readOutcome = await integrations.executeRead(
      {
        connectionId,
        operation,
        parameters: { reference: declaredInput.reference },
      },
      provenance,
    );
  } catch (error) {
    if (error instanceof PolicyDeniedError) {
      return {
        inputId: declaredInput.inputId,
        outcome: 'read_refused',
        detail: `policy denied the authorized read: ${errorText(error)}`,
        facts: [],
        sourceRef: declaredInput.reference,
      };
    }
    return {
      inputId: declaredInput.inputId,
      outcome: 'read_error',
      detail: `the authorized read (operation '${operation}') failed: ${errorText(error)}`,
      facts: [],
      sourceRef: declaredInput.reference,
    };
  }
  if (!readOutcome.ok) {
    return {
      inputId: declaredInput.inputId,
      outcome: 'read_error',
      detail: readOutcome.error ?? 'the authorized read returned no records',
      facts: [],
      sourceRef: declaredInput.reference,
    };
  }

  const records = readOutcome.records.slice(0, MAX_RECORDS_PER_READ);
  if (records.length === 0) {
    return {
      inputId: declaredInput.inputId,
      outcome: 'no_facts_extracted',
      detail: null,
      facts: [],
      sourceRef: declaredInput.reference,
    };
  }
  const facts: PlannedFact[] = records.slice(0, MAX_FACTS_PER_INPUT).map((record) => ({
    candidate: {
      factKind: 'source_record' as const,
      content: {
        providerRecordId: record.providerRecordId,
        data: record.data,
      },
      extractionNotes:
        'normalized provider record observed through an authorized /integrations read, carried verbatim',
    },
    contentHash: hashContent(JSON.stringify(record.data)),
    fetchedAt: now,
  }));
  return {
    inputId: declaredInput.inputId,
    outcome: 'facts_extracted',
    detail:
      records.length < readOutcome.records.length
        ? `retained the first ${records.length} of ${readOutcome.records.length} normalized records (the bounded inspection envelope)`
        : null,
    facts,
    sourceRef: declaredInput.reference,
  };
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, 500);
  }
  return String(error).slice(0, 500);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function lockContextOrThrow(
  store: ProductIntelligenceStore,
  tx: DbTransaction,
  productContextId: string,
): Promise<ProductContextRecord> {
  const current = await store.lockContext(tx, productContextId);
  if (current === null) {
    throw new NotFoundError('product context', productContextId);
  }
  return current;
}

/**
 * Validates the authorized inputs' connection references BEFORE any write:
 * each connection must EXIST, belong to the context's agency (the uniform
 * 404 for a foreign/unknown connection — never an oracle) and be
 * 'connected' (an honest 409 otherwise: authorized reads require an
 * authorized integration).
 */
async function assertConnectionsUsable(
  integrations: ProductIntelligenceModuleDeps['integrations'],
  agencyId: string,
  inputs: readonly { authorization: string; integrationConnectionId: string | null }[],
): Promise<void> {
  const seen = new Set<string>();
  for (const input of inputs) {
    if (input.authorization !== 'authorized') continue;
    const connectionId = input.integrationConnectionId;
    if (connectionId === null || seen.has(connectionId)) continue;
    seen.add(connectionId);
    const connection = await integrations.getConnection(connectionId);
    if (connection === null || connection.agencyId !== agencyId) {
      throw new NotFoundError('integration connection', connectionId ?? '(none)');
    }
    if (connection.status !== 'connected') {
      throw new ConflictError(
        `integration connection ${connectionId} is ${connection.status}; authorized inspection inputs require a connected integration`,
      );
    }
  }
}

/** Composes the honest read-back after a committed mutation. */
async function getDetailOrThrow(
  store: ProductIntelligenceStore,
  productContextId: string,
): Promise<ProductContextDetail> {
  const context = await store.getContext(productContextId);
  if (context === null) {
    throw new Error(`product context ${productContextId} could not be read back`);
  }
  return composeDetail(store, context);
}

/**
 * Composes the context read model: the record, the CURRENT declared
 * version with its inputs, the complete version tail, the retained source
 * facts, the derived model records, the risk flags, the inspection runs
 * and the §7 claim-tier disclosure (the mission attachment seam read
 * surface — MKT-070 attaches by reference).
 */
async function composeDetail(
  store: ProductIntelligenceStore,
  context: ProductContextRecord,
): Promise<ProductContextDetail> {
  const [versions, sourceFacts, derivedModels, riskFlags, inspectionRuns] = await Promise.all([
    store.listVersions(context.productContextId),
    store.listSourceFacts(context.productContextId),
    store.listDerivedModels(context.productContextId),
    store.listRiskFlags(context.productContextId),
    store.listInspectionRuns(context.productContextId),
  ]);
  const currentVersion =
    versions.find((version) => version.versionSeq === context.currentVersionSeq) ?? versions[0];
  if (currentVersion === undefined) {
    throw new Error(`product context ${context.productContextId} has no declared version`);
  }
  return {
    context,
    currentVersion,
    versions,
    sourceFacts,
    derivedModels,
    riskFlags,
    inspectionRuns,
    derivedRecordTier: PRODUCT_INTELLIGENCE_DERIVED_RECORD_TIER,
    vocabularyVersion: PRODUCT_INTELLIGENCE_VOCABULARY_VERSION,
  };
}
