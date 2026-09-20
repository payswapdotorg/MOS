/**
 * /product-intelligence module implementation (MKT-069).
 *
 * Owns the migration 048 tables: the agency-scoped Product Context
 * records, the append-only version tail (+ its per-version declared
 * inputs), the append-only source-fact ledger, the append-only derived
 * model records and the append-only risk flags. The owning agency
 * resolves through the disclosed /agencies structural port BEFORE any
 * write; explicitly-authorized inputs resolve through the /integrations
 * structural port (READ-ONLY); canonical /evidence citations validate
 * through the evidence port; the ai-runtime assistance disclosure
 * cross-checks through the ai-runtime port.
 *
 * THE INSPECTION PIPELINE IS READ-ONLY (boundary rule 7): public inputs
 * are fetched through the fetcher port (fetch is its ONLY method);
 * authorized inputs are read through the integrations port
 * (resolveConnectionOwnership + executeRead are its ONLY methods). There
 * is NO write surface toward any external source in this module — the
 * documented write seam (PRODUCT_INTELLIGENCE_WRITE_CAPABILITY_SEAM) is
 * deliberately unwired.
 *
 * Concurrency: every context mutation is a row-locked CAS transaction
 * (SELECT ... FOR UPDATE + explicit version check). The inspection
 * performs fetches/reads OUTSIDE the write transaction (no external call
 * ever happens under a row lock), then CAS-appends the facts inside it —
 * the inputs inspected are exactly the caller's expected current
 * version's. Authorization derives from durable state on every call — no
 * process-local cache authority.
 *
 * NO mission-strategy logic lives here (MKT-070 — the Product Marketing
 * Mission Planner — is a LATER Work Item): this module exposes exactly
 * the durable record commands + the read surface missions attach to BY
 * REFERENCE.
 */

import { ConflictError, InvalidRequestError, NotFoundError } from '../../../platform/errors/errors.ts';
import type { DbTransaction } from '../../../platform/db/contract.ts';
import type {
  ProductContextDeclaration,
  ProductContextDetail,
  ProductContextInputRecord,
  ProductContextOwnerContext,
  ProductContextRecord,
  ProductContextVersionRecord,
  ProductIntelligenceAiAssistance,
  ProductIntelligenceModuleApi,
  ProductIntelligenceModuleDeps,
  ProductIntelligenceProvenance,
} from '../public.ts';
import {
  PRODUCT_INTELLIGENCE_INSPECTION_CAPABILITY,
  PRODUCT_INTELLIGENCE_INSPECTION_READ_OPERATION,
  PRODUCT_INTELLIGENCE_VOCABULARY_VERSION,
  isHypothesisDerivationKind,
} from '../public.ts';
import {
  INTEGRATION_RECORD_EXTRACTOR_ID,
  SITE_PAGE_EXTRACTOR_ID,
  extractSiteObservation,
  hashContent,
  integrationRecordExtractionNotes,
  integrationRecordObservation,
  siteExtractionNotes,
} from './extractor.ts';
import {
  ProductIntelligenceStore,
  assertValidDerivedModelInput,
  assertValidProductContextDeclaration,
  assertValidProductIntelligenceProvenance,
  assertValidRiskFlagInput,
  composeProductContextOwnerContext,
  deriveVerificationState,
} from './product-intelligence-store.ts';

export function createProductIntelligenceModule(
  deps: ProductIntelligenceModuleDeps,
): ProductIntelligenceModuleApi {
  const store = new ProductIntelligenceStore(deps.db, deps.clock, deps.ids);
  const { agencies, evidence, aiRuntime, integrations, fetcher, clock } = deps;

  return {
    async createProductContext(input, provenance) {
      assertValidProductIntelligenceProvenance(provenance);
      assertValidProductContextDeclaration(input.declaration);

      // CANONICAL agency resolution from durable state BEFORE any write:
      // unknown agency → the uniform 404; a disabled agency blocks new
      // use (409) without rewriting history.
      const agency = await agencies.getAgency(input.agencyId);
      if (agency === null) {
        throw new NotFoundError('agency', input.agencyId);
      }
      if (agency.status !== 'active') {
        throw new ConflictError(
          `agency ${input.agencyId} is ${agency.status}; product contexts cannot be created`,
        );
      }

      // Every explicitly-authorized input's authorization reference must
      // resolve through the /integrations port to a connection of the
      // SAME agency (unknown/foreign → the uniform 404 — a foreign
      // connection identifier is not a traversal/existence oracle).
      await assertInputsAuthorized(integrations, input.declaration, input.agencyId);

      const productContextId = deps.ids.newId();
      const now = clock.nowIso();
      await deps.db.transaction(async (tx) => {
        await store.insertContext({
          productContextId,
          agencyId: input.agencyId,
          createdActor: provenance.actor,
          now,
        });
        await store.appendVersion(tx, {
          productContextId,
          versionSeq: 1,
          declaration: input.declaration,
          provenance,
        });
        return productContextId;
      });

      return await getDetailOrThrow(store, productContextId);
    },

    async getProductContext(productContextId) {
      return store.getContext(productContextId);
    },

    async resolveProductContextOwnership(productContextId) {
      const context = await store.getContext(productContextId);
      if (context === null) return null;
      const agency = await agencies.getAgency(context.agencyId);
      if (agency === null) return null;
      return composeProductContextOwnerContext(context, agency, clock.nowIso()) as ProductContextOwnerContext;
    },

    async listProductContextsForAgency(agencyId) {
      // Canonical owner resolution before dependent traversal.
      const agency = await agencies.getAgency(agencyId);
      if (agency === null) {
        throw new NotFoundError('agency', agencyId);
      }
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

    async recordProductContextVersion(input, provenance) {
      assertValidProductIntelligenceProvenance(provenance);
      assertValidProductContextDeclaration(input.declaration);

      await deps.db.transaction(async (tx) => {
        // CAS-serialized: row lock + explicit version check.
        const current = await lockContextOrThrow(store, tx, input.productContextId);
        if (current.version !== input.expectedVersion) {
          throw new ConflictError(
            `product context version mismatch: current version is ${current.version}`,
          );
        }
        // New use: an ACTIVE agency is required.
        await assertAgencyActive(agencies, current.agencyId, current.productContextId);
        // The declared inputs of the corrected version validate exactly as
        // at creation (authorized inputs must still resolve).
        await assertInputsAuthorized(integrations, input.declaration, current.agencyId);

        // The correction path: append the NEW immutable version record,
        // advance the pointer (only ever forward).
        const nextVersionSeq = (await store.countVersions(tx, input.productContextId)) + 1;
        await store.appendVersion(tx, {
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
      // The honest read-back composes AFTER the commit.
      return await getDetailOrThrow(store, input.productContextId);
    },

    async inspectProductContext(input, provenance) {
      assertValidProductIntelligenceProvenance(provenance);

      // Resolve the caller's expected current version + its inputs BEFORE
      // any external call (no fetch or read ever happens under a row
      // lock): the inputs inspected are exactly the declared version the
      // caller's CAS token names.
      const context = await store.getContext(input.productContextId);
      if (context === null) {
        throw new NotFoundError('product context', input.productContextId);
      }
      if (context.version !== input.expectedVersion) {
        throw new ConflictError(
          `product context version mismatch: current version is ${context.version}`,
        );
      }
      const versions = await store.listVersions(input.productContextId);
      const currentVersion = versions.find(
        (version) => version.versionSeq === context.currentVersionSeq,
      );
      if (currentVersion === undefined) {
        throw new Error(
          `product context ${input.productContextId} has no declared version ${context.currentVersionSeq}`,
        );
      }
      const inputs = await store.listInputsForVersion(currentVersion.productContextVersionId);

      // New use: an ACTIVE agency is required (the inspection performs
      // external reads and appends facts).
      const agency = await agencies.getAgency(context.agencyId);
      if (agency === null) {
        throw new NotFoundError('product context', input.productContextId);
      }
      if (agency.status !== 'active') {
        throw new ConflictError(
          `agency ${context.agencyId} is ${agency.status}; product context ${input.productContextId} cannot be inspected`,
        );
      }

      // THE DETERMINISTIC FETCH/READ PHASE (read-only; all-or-nothing):
      // every failed fetch or read fails the whole command honestly —
      // nothing persists.
      const facts: AppendFactPlan[] = [];
      for (const declaredInput of inputs) {
        if (declaredInput.authorizationState === 'public') {
          const fetchOutcome = await fetcher.fetch(declaredInput.reference);
          if (!fetchOutcome.ok || fetchOutcome.body === null) {
            throw new InvalidRequestError('The public source could not be fetched', [
              `inputs[${declaredInput.inputId}]: ${declaredInput.reference} → fetch status ${fetchOutcome.status} (the inspection is all-or-nothing: nothing persisted)`,
            ]);
          }
          const observation = extractSiteObservation(fetchOutcome.body);
          facts.push({
            productContextId: input.productContextId,
            productContextVersionId: currentVersion.productContextVersionId,
            inputId: declaredInput.inputId,
            sourceUrl: declaredInput.reference,
            fetchedAt: fetchOutcome.fetchedAt,
            extractor: SITE_PAGE_EXTRACTOR_ID,
            contentHash: hashContent(fetchOutcome.body),
            extractionNotes: siteExtractionNotes(fetchOutcome.contentType),
            observation: observation as unknown as Record<string, unknown>,
            provenance,
          });
        } else {
          // The authorized read path (READ-ONLY through the /integrations
          // public contract): the connection must resolve, belong to the
          // context's agency and be CONNECTED.
          const authorizationRef = declaredInput.authorizationRef;
          if (authorizationRef === null) {
            throw new Error(
              `input ${declaredInput.inputId} is explicitly authorized but carries no authorization reference`,
            );
          }
          const ownership = await integrations.resolveConnectionOwnership(authorizationRef);
          if (ownership === null || ownership.scope.agencyId !== context.agencyId) {
            // Unknown and foreign connections are indistinguishable —
            // the uniform 404, never an oracle.
            throw new NotFoundError('integration connection', authorizationRef);
          }
          if (ownership.connection.status !== 'connected') {
            throw new ConflictError(
              `integration connection ${authorizationRef} is ${ownership.connection.status}; authorized source reads require a connected authorization`,
            );
          }
          const readOutcome = await integrations.executeRead(
            {
              connectionId: authorizationRef,
              operation: PRODUCT_INTELLIGENCE_INSPECTION_READ_OPERATION,
              parameters: {
                inputKind: declaredInput.inputKind,
                reference: declaredInput.reference,
              },
            },
            provenance,
          );
          if (!readOutcome.ok) {
            throw new InvalidRequestError('The authorized source could not be read', [
              `inputs[${declaredInput.inputId}]: ${declaredInput.reference} → ${readOutcome.error ?? 'read failed'} (the inspection is all-or-nothing: nothing persisted)`,
            ]);
          }
          for (const record of readOutcome.records) {
            const { observation, contentHash } = integrationRecordObservation(record);
            facts.push({
              productContextId: input.productContextId,
              productContextVersionId: currentVersion.productContextVersionId,
              inputId: declaredInput.inputId,
              sourceUrl: declaredInput.reference,
              fetchedAt: clock.nowIso(),
              extractor: INTEGRATION_RECORD_EXTRACTOR_ID,
              contentHash,
              extractionNotes: integrationRecordExtractionNotes(
                record.providerRecordId,
                record.etag,
                record.sourceVersion,
              ),
              observation: observation as Record<string, unknown>,
              provenance,
            });
          }
        }
      }

      // THE CAS APPEND PHASE: re-lock the context under the write
      // transaction, re-verify the version (the caller's expected current
      // version is what was inspected), then append every fact. The
      // unchanged-source fence rejects identical re-inspection honestly.
      await deps.db.transaction(async (tx) => {
        const current = await lockContextOrThrow(store, tx, input.productContextId);
        if (current.version !== input.expectedVersion) {
          throw new ConflictError(
            `product context version mismatch: the inspected version is no longer current (current version is ${current.version})`,
          );
        }
        for (const fact of facts) {
          await store.appendFact(tx, fact);
        }
        return input.productContextId;
      });

      return await getDetailOrThrow(store, input.productContextId);
    },

    async getSourceFacts(productContextId) {
      const context = await store.getContext(productContextId);
      if (context === null) return null;
      return store.listFacts(productContextId);
    },

    async getDerivedModels(productContextId) {
      const context = await store.getContext(productContextId);
      if (context === null) return null;
      return store.listDerivedModels(productContextId);
    },

    async getRiskFlags(productContextId) {
      const context = await store.getContext(productContextId);
      if (context === null) return null;
      return store.listRiskFlags(productContextId);
    },

    async recordDerivedModel(input, provenance) {
      assertValidProductIntelligenceProvenance(provenance);
      assertValidDerivedModelInput(input);

      const { context, currentVersion } = await resolveCurrentVersionOrThrow(
        store,
        input.productContextId,
      );
      // New use: an ACTIVE agency is required.
      await assertAgencyActive(agencies, context.agencyId, context.productContextId);
      // The backing source facts must belong to the SAME context
      // (unknown/foreign → the uniform 404 — a foreign fact identifier is
      // not a traversal/existence oracle).
      await assertSourceFactsInContext(store, input.sourceFactIds, context.productContextId);
      // Canonical /evidence citations validate through the evidence port
      // (unknown/cross-agency → the uniform 404).
      await assertEvidenceCitationsInAgency(evidence, input.evidenceCitations, context.agencyId);
      // The ai-assistance disclosure cross-checks through the ai-runtime
      // port (the referenced selection must resolve, belong to the same
      // agency, and have CHOSEN the disclosed model identity).
      await assertAiAssistanceHonest(aiRuntime, input.aiAssistance, context.agencyId);
      // The verification state is SERVER-DERIVED from the backing — never
      // caller-asserted; the hypothesis flag is FROZEN to the kind.
      const verificationState = deriveVerificationState(input);
      const hypothesis = isHypothesisDerivationKind(input.derivationKind);
      // REPETITION NEVER PROMOTES: an identical (context, kind, statement)
      // record is an honest conflict (the DB fence is the backstop).
      const existing = await store.findDerivedModelByStatement(
        input.productContextId,
        input.derivationKind,
        input.statement,
      );
      if (existing !== null) {
        throw new ConflictError(
          `an identical ${input.derivationKind} record already exists on this product context — hypotheses never become facts by repetition`,
        );
      }

      return await deps.db.transaction(async (tx) => {
        return store.insertDerivedModel(tx, {
          productContextId: context.productContextId,
          productContextVersionId: currentVersion.productContextVersionId,
          derivationKind: input.derivationKind,
          statement: input.statement,
          detail: input.detail,
          sourceFactIds: input.sourceFactIds,
          evidenceCitations: input.evidenceCitations,
          aiAssistance: input.aiAssistance,
          verificationState,
          hypothesis,
          provenance,
        });
      });
    },

    async recordRiskFlag(input, provenance) {
      assertValidProductIntelligenceProvenance(provenance);
      assertValidRiskFlagInput(input);

      const { context, currentVersion } = await resolveCurrentVersionOrThrow(
        store,
        input.productContextId,
      );
      await assertAgencyActive(agencies, context.agencyId, context.productContextId);
      await assertSourceFactsInContext(store, input.sourceFactIds, context.productContextId);
      await assertEvidenceCitationsInAgency(evidence, input.evidenceCitations, context.agencyId);
      await assertAiAssistanceHonest(aiRuntime, input.aiAssistance, context.agencyId);
      // The repetition fence (the derived-record discipline).
      const existingRisks = await store.listRiskFlags(context.productContextId);
      if (
        existingRisks.some(
          (flag) => flag.riskKind === input.riskKind && flag.statement === input.statement,
        )
      ) {
        throw new ConflictError(
          `an identical ${input.riskKind} risk flag already exists on this product context`,
        );
      }

      return await deps.db.transaction(async (tx) => {
        return store.insertRiskFlag(tx, {
          productContextId: context.productContextId,
          productContextVersionId: currentVersion.productContextVersionId,
          riskKind: input.riskKind,
          severity: input.severity,
          statement: input.statement,
          sourceFactIds: input.sourceFactIds,
          evidenceCitations: input.evidenceCitations,
          aiAssistance: input.aiAssistance,
          provenance,
        });
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface AppendFactPlan {
  readonly productContextId: string;
  readonly productContextVersionId: string;
  readonly inputId: string;
  readonly sourceUrl: string;
  readonly fetchedAt: string;
  readonly extractor: string;
  readonly contentHash: string;
  readonly extractionNotes: string;
  readonly observation: Readonly<Record<string, unknown>>;
  readonly provenance: ProductIntelligenceProvenance;
}

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

/** Boundary policy shared by the new-use commands: the agency must be live and ACTIVE. */
async function assertAgencyActive(
  agencies: ProductIntelligenceModuleDeps['agencies'],
  agencyId: string,
  productContextId: string,
): Promise<void> {
  const agency = await agencies.getAgency(agencyId);
  if (agency === null) {
    // The context's agency vanished (impossible via the public surface —
    // agencies have no tombstone); fail closed as the uniform 404.
    throw new NotFoundError('product context', productContextId);
  }
  if (agency.status !== 'active') {
    throw new ConflictError(
      `agency ${agencyId} is ${agency.status}; product context ${productContextId} cannot be used for new work`,
    );
  }
}

/**
 * The authorized-input validation: every explicitly-authorized input's
 * authorization reference must resolve through the /integrations port to
 * a connection of the SAME agency (unknown/foreign → the uniform 404).
 * The connection's live state is re-checked at INSPECTION time (the
 * connected gate); here existence + scope are enough to declare.
 */
async function assertInputsAuthorized(
  integrations: ProductIntelligenceModuleDeps['integrations'],
  declaration: ProductContextDeclaration,
  agencyId: string,
): Promise<void> {
  for (const declared of declaration.inputs) {
    if (declared.authorizationState !== 'explicitly_authorized') continue;
    const ref = declared.authorizationRef;
    if (ref === null) continue; // structurally impossible post-guard
    const ownership = await integrations.resolveConnectionOwnership(ref);
    if (ownership === null || ownership.scope.agencyId !== agencyId) {
      throw new NotFoundError('integration connection', ref);
    }
  }
}

/** Resolves the context + its CURRENT declared version (the honest anchor). */
async function resolveCurrentVersionOrThrow(
  store: ProductIntelligenceStore,
  productContextId: string,
): Promise<{
  readonly context: ProductContextRecord;
  readonly currentVersion: ProductContextVersionRecord;
}> {
  const context = await store.getContext(productContextId);
  if (context === null) {
    throw new NotFoundError('product context', productContextId);
  }
  const versions = await store.listVersions(productContextId);
  const currentVersion = versions.find(
    (version) => version.versionSeq === context.currentVersionSeq,
  );
  if (currentVersion === undefined) {
    throw new Error(
      `product context ${productContextId} has no declared version ${context.currentVersionSeq}`,
    );
  }
  return { context, currentVersion };
}

/** The backing source facts must exist and belong to the SAME context. */
async function assertSourceFactsInContext(
  store: ProductIntelligenceStore,
  sourceFactIds: readonly string[],
  productContextId: string,
): Promise<void> {
  for (const sourceFactId of sourceFactIds) {
    const fact = await store.getFact(sourceFactId);
    if (fact === null || fact.productContextId !== productContextId) {
      throw new NotFoundError('source fact', sourceFactId);
    }
  }
}

/** Canonical /evidence citations must resolve within the context's agency. */
async function assertEvidenceCitationsInAgency(
  evidence: ProductIntelligenceModuleDeps['evidence'],
  evidenceCitations: readonly string[],
  agencyId: string,
): Promise<void> {
  for (const evidenceId of evidenceCitations) {
    const ownership = await evidence.resolveEvidenceOwnership(evidenceId);
    if (ownership === null || ownership.scope.agencyId !== agencyId) {
      throw new NotFoundError('evidence', evidenceId);
    }
  }
}

/**
 * The ai-assistance disclosure cross-check: the referenced /ai-runtime
 * selection decision must resolve, belong to the same agency, and have
 * CHOSEN exactly the disclosed model identity — the disclosure is
 * cross-checked against the routing authority, never self-attested.
 */
async function assertAiAssistanceHonest(
  aiRuntime: ProductIntelligenceModuleDeps['aiRuntime'],
  aiAssistance: ProductIntelligenceAiAssistance | null,
  agencyId: string,
): Promise<void> {
  if (aiAssistance === null) return;
  const selection = await aiRuntime.getSelectionDecision(aiAssistance.callReference);
  if (selection === null || selection.agencyId !== agencyId) {
    throw new NotFoundError('ai-runtime selection decision', aiAssistance.callReference);
  }
  if (selection.chosenModelRegistryId !== aiAssistance.modelIdentity) {
    throw new ConflictError(
      `ai-assistance disclosure mismatch: selection ${aiAssistance.callReference} chose model ${selection.chosenModelRegistryId}, not ${aiAssistance.modelIdentity}`,
    );
  }
}

/** Composes the honest read-back after a committed mutation. */
async function getDetailOrThrow(
  store: ProductIntelligenceStore,
  productContextId: string,
): Promise<ProductContextDetail> {
  const detail = await composeDetailById(store, productContextId);
  if (detail === null) {
    throw new Error(`product context ${productContextId} could not be read back`);
  }
  return detail;
}

async function composeDetailById(
  store: ProductIntelligenceStore,
  productContextId: string,
): Promise<ProductContextDetail | null> {
  const context = await store.getContext(productContextId);
  if (context === null) return null;
  return composeDetail(store, context);
}

/**
 * Composes the product-context read model: the record, the CURRENT
 * declared version with its inputs, and the complete append-only ledgers
 * (facts, derived models, risk flags) — the AC-7 honest read-back and
 * the AC-6 mission-attachment seam, with the vocabulary + read-only
 * inspection disclosures on every view.
 */
async function composeDetail(
  store: ProductIntelligenceStore,
  context: ProductContextRecord,
): Promise<ProductContextDetail> {
  const [versions, sourceFacts, derivedModels, riskFlags] = await Promise.all([
    store.listVersions(context.productContextId),
    store.listFacts(context.productContextId),
    store.listDerivedModels(context.productContextId),
    store.listRiskFlags(context.productContextId),
  ]);
  const currentVersion =
    versions.find((version) => version.versionSeq === context.currentVersionSeq) ?? versions[0];
  if (currentVersion === undefined) {
    throw new Error(`product context ${context.productContextId} has no declared version`);
  }
  const inputs: readonly ProductContextInputRecord[] = await store.listInputsForVersion(
    currentVersion.productContextVersionId,
  );
  return {
    context,
    currentVersion,
    inputs,
    sourceFacts,
    derivedModels,
    riskFlags,
    vocabularyVersion: PRODUCT_INTELLIGENCE_VOCABULARY_VERSION,
    inspectionCapability: PRODUCT_INTELLIGENCE_INSPECTION_CAPABILITY,
  };
}