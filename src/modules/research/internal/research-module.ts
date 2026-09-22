/**
 * /research module implementation (MKT-062).
 *
 * Owns the migration 056 tables (through the store): the agency-scoped
 * research-session records, the append-only version tail (the IMMUTABLE
 * declared sources — corrections are NEW version records), the
 * deterministic research pipeline (public page fetch/extract through the
 * GET-only page-reader port + authorized repository/workspace reads
 * through the READ-ONLY /integrations structural port), the append-only
 * retained source facts, and the append-only research insight records
 * with FK-anchored evidence links.
 *
 * READ-ONLY GUARANTEE (§7): this module expresses NO mutation toward any
 * research source — the page-reader port has no method field at all and
 * the integrations port exposes getConnection + executeRead ONLY
 * (executeMutation is structurally absent).
 *
 * NO content-intelligence logic lives here (the /content-intelligence
 * sibling delivered by this same Work Item owns the candidate/hypothesis
 * layer and consumes this module's read surface through its public
 * contract only).
 *
 * Concurrency: session-record mutations are row-locked CAS transactions;
 * the research pipeline performs its bounded external reads FIRST and
 * then persists under the session row lock (a concurrent correction is an
 * honest 409 — the re-run researches the new sources).
 */

import {
  ConflictError,
  NotFoundError,
  PolicyDeniedError,
} from '../../../platform/errors/errors.ts';
import type { DbTransaction } from '../../../platform/db/contract.ts';
import type {
  ResearchInsightOwnerContext,
  ResearchModuleApi,
  ResearchModuleDeps,
  ResearchProvenance,
  ResearchRunRecord,
  ResearchRunSourceOutcomeRecord,
  ResearchSessionDetail,
  ResearchSessionOwnerContext,
  ResearchSessionRecord,
  ResearchSessionVersionRecord,
} from '../public.ts';
import {
  RESEARCH_DERIVED_RECORD_TIER,
  RESEARCH_HTML_EXTRACTOR,
  RESEARCH_INTEGRATION_EXTRACTOR,
  RESEARCH_VOCABULARY_VERSION,
} from '../public.ts';
import {
  assertValidResearchInsightInput,
  assertValidResearchProvenance,
  assertValidResearchSessionDeclaration,
  composeResearchSessionOwnerContext,
  extractResearchHtmlSourceFacts,
  hashResearchContent,
  ResearchStore,
} from './research-store.ts';
import type { ExtractedResearchFactCandidate } from './research-store.ts';

/**
 * The frozen per-kind authorized-read operation labels (the /integrations
 * NORMALIZED contract operations this module requests): the repository and
 * workspace operations await their future adapters (no first-party adapter
 * declares them yet — a research run over such a source records the honest
 * capability-refused outcome, never an invented read).
 */
const AUTHORIZED_READ_OPERATIONS: Readonly<Record<string, string>> = {
  connected_repository: 'repository.read',
  connected_workspace: 'workspace.read',
};

/** The bounded research envelope (the platform HttpCallPort bounds). */
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_SIZE_CAP_BYTES = 262_144;
const MAX_RECORDS_PER_READ = 25;
const MAX_FACTS_PER_SOURCE = 32;

/** One retained fact with its content hash (of the MATERIAL it was extracted from). */
interface PlannedFact {
  readonly candidate: ExtractedResearchFactCandidate;
  readonly contentHash: string;
  readonly fetchedAt: string;
}

/** One source's research plan outcome (before persistence). */
interface PlannedSourceOutcome {
  readonly sourceId: string;
  readonly outcome: ResearchRunSourceOutcomeRecord['outcome'];
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

export function createResearchModule(deps: ResearchModuleDeps): ResearchModuleApi {
  const store = new ResearchStore(deps.db, deps.clock, deps.ids);
  const { clock, pageReader, integrations, aiRuntime } = deps;

  return {
    async createResearchSession(input, provenance) {
      assertValidResearchProvenance(provenance);
      assertValidResearchSessionDeclaration(input.declaration);

      // The authorized sources' connection references resolve through the
      // /integrations public contract BEFORE any write: unknown or FOREIGN
      // (cross-agency) connections are the uniform 404; a non-connected
      // connection is an honest 409 (authorized reads require an
      // authorized integration).
      await assertConnectionsUsable(
        integrations,
        input.agencyId,
        input.declaration.sources as readonly {
          authorization: string;
          integrationConnectionId: string | null;
        }[],
      );

      const researchSessionId = deps.ids.newId();
      const now = clock.nowIso();
      await deps.db.transaction(async (tx) => {
        await store.insertSession({
          researchSessionId,
          agencyId: input.agencyId,
          createdActor: provenance.actor,
          now,
        });
        await store.insertVersion(tx, {
          researchSessionVersionId: deps.ids.newId(),
          researchSessionId,
          versionSeq: 1,
          declaration: input.declaration,
          provenance,
        });
      });

      return await getDetailOrThrow(store, researchSessionId);
    },

    async getResearchSession(researchSessionId) {
      return store.getSession(researchSessionId);
    },

    async resolveResearchSessionOwnership(researchSessionId) {
      const session = await store.getSession(researchSessionId);
      if (session === null) return null;
      return composeResearchSessionOwnerContext(
        session,
        clock.nowIso(),
      ) as ResearchSessionOwnerContext;
    },

    async listResearchSessionsForAgency(agencyId) {
      return store.listSessionsForAgency(agencyId);
    },

    async getResearchSessionDetail(researchSessionId) {
      const session = await store.getSession(researchSessionId);
      if (session === null) return null;
      return composeDetail(store, session);
    },

    async getResearchSessionVersions(researchSessionId) {
      const session = await store.getSession(researchSessionId);
      if (session === null) return null;
      return store.listVersions(researchSessionId);
    },

    async getResearchSessionFacts(researchSessionId) {
      const session = await store.getSession(researchSessionId);
      if (session === null) return null;
      return store.listSourceFacts(researchSessionId);
    },

    async getResearchSessionInsights(researchSessionId) {
      const session = await store.getSession(researchSessionId);
      if (session === null) return null;
      return store.listInsights(researchSessionId);
    },

    async getResearchSessionRuns(researchSessionId) {
      const session = await store.getSession(researchSessionId);
      if (session === null) return null;
      return store.listRuns(researchSessionId);
    },

    async recordResearchSessionVersion(input, provenance) {
      assertValidResearchProvenance(provenance);
      assertValidResearchSessionDeclaration(input.declaration);

      const session = await store.getSession(input.researchSessionId);
      if (session === null) {
        throw new NotFoundError('research session', input.researchSessionId);
      }
      await assertConnectionsUsable(
        integrations,
        session.agencyId,
        input.declaration.sources as readonly {
          authorization: string;
          integrationConnectionId: string | null;
        }[],
      );

      await deps.db.transaction(async (tx) => {
        // CAS-serialized: row lock + explicit version check.
        const current = await lockSessionOrThrow(store, tx, input.researchSessionId);
        if (current.version !== input.expectedVersion) {
          throw new ConflictError(
            `research session version mismatch: current version is ${current.version}`,
          );
        }
        // The correction path: append the NEW immutable version record,
        // advance the pointer (only ever forward).
        const nextVersionSeq = (await store.countVersions(tx, input.researchSessionId)) + 1;
        await store.insertVersion(tx, {
          researchSessionVersionId: deps.ids.newId(),
          researchSessionId: input.researchSessionId,
          versionSeq: nextVersionSeq,
          declaration: input.declaration,
          provenance,
        });
        const outcome = await store.advanceSessionVersionRow(tx, {
          researchSessionId: input.researchSessionId,
          versionSeq: nextVersionSeq,
          expectedVersion: input.expectedVersion,
        });
        if (outcome !== 'ok') {
          throw new ConflictError('research session version update lost the version race');
        }
        return input.researchSessionId;
      });
      return await getDetailOrThrow(store, input.researchSessionId);
    },

    async runResearch(input, provenance) {
      assertValidResearchProvenance(provenance);

      const session = await store.getSession(input.researchSessionId);
      if (session === null) {
        throw new NotFoundError('research session', input.researchSessionId);
      }

      // The CURRENT declared version + sources (the research pass always
      // researches the current declaration).
      const versions = await store.listVersions(input.researchSessionId);
      const currentVersion =
        versions.find((version) => version.versionSeq === session.currentVersionSeq) ??
        versions[0];
      if (currentVersion === undefined) {
        throw new Error(
          `research session ${input.researchSessionId} has no declared version to research`,
        );
      }

      // The bounded deterministic research pass (external reads happen
      // BEFORE the persistence transaction; every outcome is honest data).
      const startedAt = clock.nowIso();
      const planned: PlannedSourceOutcome[] = [];
      for (const declaredSource of currentVersion.sources) {
        planned.push(
          await researchOneSource(declaredSource, session, pageReader, integrations, provenance, clock),
        );
      }
      const finishedAt = clock.nowIso();

      const factsRetained = planned.reduce((sum, outcome) => sum + outcome.facts.length, 0);
      const errorCount = planned.filter((outcome) => ERROR_OUTCOMES.has(outcome.outcome)).length;
      const status: ResearchRunRecord['status'] =
        planned.length === 0
          ? 'completed'
          : errorCount === planned.length
            ? 'failed'
            : errorCount > 0
              ? 'partial'
              : 'completed';

      const researchRunId = deps.ids.newId();
      await deps.db.transaction(async (tx) => {
        // Serialize against concurrent corrections: the version we
        // researched must STILL be the current declaration — a correction
        // that landed mid-flight is an honest 409 (the re-run researches
        // the new sources).
        const current = await lockSessionOrThrow(store, tx, input.researchSessionId);
        if (current.currentVersionSeq !== currentVersion.versionSeq) {
          throw new ConflictError(
            `research session ${input.researchSessionId} was corrected during the research pass (current version ${current.currentVersionSeq}, researched ${currentVersion.versionSeq}) — re-run the research against the new declaration`,
          );
        }

        await store.insertRun(tx, {
          researchRunId,
          researchSessionId: input.researchSessionId,
          researchSessionVersionId: currentVersion.researchSessionVersionId,
          status,
          sourcesInspected: planned.length,
          factsRetained,
          startedAt,
          finishedAt,
          provenance,
        });
        for (const outcome of planned) {
          await store.insertRunSourceOutcome(tx, {
            researchRunId,
            sourceId: outcome.sourceId,
            outcome: outcome.outcome,
            detail: outcome.detail,
            factsExtracted: outcome.facts.length,
          });
          for (const fact of outcome.facts) {
            await store.insertSourceFact(tx, {
              sourceFactId: deps.ids.newId(),
              researchSessionId: input.researchSessionId,
              researchSessionVersionId: currentVersion.researchSessionVersionId,
              sourceId: outcome.sourceId,
              researchRunId,
              factKind: fact.candidate.factKind,
              sourceRef: outcome.sourceRef,
              fetchedAt: fact.fetchedAt,
              extractor:
                fact.candidate.factKind === 'source_record'
                  ? RESEARCH_INTEGRATION_EXTRACTOR
                  : RESEARCH_HTML_EXTRACTOR,
              contentHash: fact.contentHash,
              extractionNotes: fact.candidate.extractionNotes,
              content: fact.candidate.content,
              provenance,
            });
          }
        }
      });

      const runs = await store.listRuns(input.researchSessionId);
      const run = runs.find((entry) => entry.researchRunId === researchRunId);
      if (run === undefined) {
        throw new Error(`research run ${researchRunId} could not be read back`);
      }
      return run;
    },

    async recordResearchInsight(input, provenance) {
      assertValidResearchProvenance(provenance);
      assertValidResearchInsightInput(input);

      const session = await store.getSession(input.researchSessionId);
      if (session === null) {
        throw new NotFoundError('research session', input.researchSessionId);
      }

      // Every cited evidence reference must resolve to a retained source
      // fact of the SAME session (uniform 404 — a foreign fact id is not
      // an oracle).
      for (const sourceFactId of input.evidenceSourceFactIds) {
        const fact = await store.getSourceFact(sourceFactId);
        if (fact === null || fact.researchSessionId !== input.researchSessionId) {
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
      if (input.supersedesResearchInsightId !== null) {
        const prior = await store.getInsightById(input.supersedesResearchInsightId);
        if (prior === null) {
          throw new NotFoundError('research insight', input.supersedesResearchInsightId);
        }
        if (prior.researchSessionId !== input.researchSessionId) {
          throw new NotFoundError('research insight', input.supersedesResearchInsightId);
        }
        if (prior.derivationKind !== input.derivationKind) {
          throw new ConflictError(
            `research insight ${input.supersedesResearchInsightId} is of kind ${prior.derivationKind}; a correction must keep the same derivation kind`,
          );
        }
        if (prior.supersededByResearchInsightId !== null) {
          throw new ConflictError(
            `research insight ${input.supersedesResearchInsightId} is already superseded by ${prior.supersededByResearchInsightId} — the single-supersession fence`,
          );
        }
      }

      // THE SERVER-COMPUTED VERIFICATION STATE (never caller-declared;
      // the pure rule + the migration-056 deferred backstop).
      const verificationState =
        input.evidenceSourceFactIds.length > 0 ? 'evidence_backed' : 'unverified';

      const researchInsightId = deps.ids.newId();
      await deps.db.transaction(async (tx) => {
        await store.insertInsight(tx, {
          researchInsightId,
          researchSessionId: input.researchSessionId,
          derivationKind: input.derivationKind,
          statement: input.statement,
          verificationState,
          supersedesResearchInsightId: input.supersedesResearchInsightId,
          aiModelRegistryId: aiSnapshot?.modelRegistryId ?? null,
          aiModelDisplay: aiSnapshot?.displayName ?? null,
          aiCallReference: input.aiAssistance?.callReference ?? null,
          provenance,
        });
        if (input.evidenceSourceFactIds.length > 0) {
          await store.insertInsightEvidence(tx, {
            researchInsightId,
            sourceFactIds: input.evidenceSourceFactIds,
          });
        }
      });

      const record = await store.getInsightById(researchInsightId);
      if (record === null) {
        throw new Error(`research insight ${researchInsightId} could not be read back`);
      }
      return record;
    },

    async getResearchInsight(researchInsightId) {
      return store.getInsightById(researchInsightId);
    },

    async resolveResearchInsightOwnership(researchInsightId) {
      const insight = await store.getInsightById(researchInsightId);
      if (insight === null) return null;
      const session = await store.getSession(insight.researchSessionId);
      if (session === null) return null;
      const resolvedAt = clock.nowIso();
      return {
        scope: {
          kind: 'research-insight' as const,
          agencyId: session.agencyId,
          researchSessionId: session.researchSessionId,
          researchInsightId: insight.researchInsightId,
        },
        insight,
        resolvedAt,
      } satisfies ResearchInsightOwnerContext;
    },
  };
}

// ---------------------------------------------------------------------------
// The deterministic per-source research pass
// ---------------------------------------------------------------------------

/**
 * Researches ONE declared source: public web kinds are fetched through the
 * GET-only page reader and deterministically extracted; authorized kinds
 * are read through the READ-ONLY /integrations port (the connection must
 * be connected; a policy-denied read is the honest 'read_refused'
 * outcome). The outcome is DATA — never an invented success. The CONTENT
 * HASH is the sha256 of the MATERIAL the facts were extracted from (the
 * fetched page body / the normalized provider record data).
 */
async function researchOneSource(
  declaredSource: ResearchSessionVersionRecord['sources'][number],
  session: ResearchSessionRecord,
  pageReader: ResearchModuleDeps['pageReader'],
  integrations: ResearchModuleDeps['integrations'],
  provenance: ResearchProvenance,
  clock: ResearchModuleDeps['clock'],
): Promise<PlannedSourceOutcome> {
  const now = clock.nowIso();

  // THE PUBLIC WEB SOURCES: fetch + deterministic extraction.
  if (declaredSource.authorization === 'public') {
    let fetchOutcome;
    try {
      fetchOutcome = await pageReader.fetch({
        url: declaredSource.reference,
        timeoutMs: FETCH_TIMEOUT_MS,
        sizeCapBytes: FETCH_SIZE_CAP_BYTES,
      });
    } catch (error) {
      return {
        sourceId: declaredSource.sourceId,
        outcome: 'fetch_transport_error',
        detail: `page reader threw: ${errorText(error)}`,
        facts: [],
        sourceRef: declaredSource.reference,
      };
    }
    if (!fetchOutcome.ok) {
      if (fetchOutcome.transportRefused || fetchOutcome.timedOut) {
        return {
          sourceId: declaredSource.sourceId,
          outcome: 'fetch_transport_error',
          detail:
            fetchOutcome.error ?? `transport failure (status ${fetchOutcome.status ?? 'none'})`,
          facts: [],
          sourceRef: declaredSource.reference,
        };
      }
      return {
        sourceId: declaredSource.sourceId,
        outcome: 'fetch_http_error',
        detail: fetchOutcome.error ?? `http status ${fetchOutcome.status ?? 'none'})`,
        facts: [],
        sourceRef: declaredSource.reference,
      };
    }
    const body = fetchOutcome.body ?? '';
    const bodyHash = hashResearchContent(body);
    const candidates = extractResearchHtmlSourceFacts(body).slice(0, MAX_FACTS_PER_SOURCE);
    if (candidates.length === 0) {
      return {
        sourceId: declaredSource.sourceId,
        outcome: 'no_facts_extracted',
        detail: 'the fetched page yielded no deterministic extraction candidates',
        facts: [],
        sourceRef: declaredSource.reference,
      };
    }
    return {
      sourceId: declaredSource.sourceId,
      outcome: 'facts_extracted',
      detail: null,
      facts: candidates.map((candidate) => ({
        candidate,
        contentHash: bodyHash,
        fetchedAt: now,
      })),
      sourceRef: declaredSource.reference,
    };
  }

  // THE AUTHORIZED SOURCES: read through the /integrations port, READ-ONLY.
  // (The kind-authorization fence guarantees authorization ===
  // 'authorized' here; the belt-and-braces refusal below is the honest
  // backstop for any future relaxation — §7.)
  if (declaredSource.authorization !== 'authorized') {
    return {
      sourceId: declaredSource.sourceId,
      outcome: 'unauthorized_refused',
      detail:
        '§7: repository/workspace research requires an explicitly authorized source — refused honestly',
      facts: [],
      sourceRef: declaredSource.reference,
    };
  }

  const connectionId = declaredSource.integrationConnectionId;
  if (connectionId === null) {
    return {
      sourceId: declaredSource.sourceId,
      outcome: 'unauthorized_refused',
      detail: 'the authorized source carries no integration connection reference',
      facts: [],
      sourceRef: declaredSource.reference,
    };
  }
  const connection = await integrations.getConnection(connectionId);
  if (connection === null || connection.agencyId !== session.agencyId) {
    return {
      sourceId: declaredSource.sourceId,
      outcome: 'read_refused',
      detail: 'the integration connection no longer resolves inside this agency',
      facts: [],
      sourceRef: declaredSource.reference,
    };
  }
  if (connection.status !== 'connected') {
    return {
      sourceId: declaredSource.sourceId,
      outcome: 'read_refused',
      detail: `the integration connection is ${connection.status} — authorized reads require a connected integration`,
      facts: [],
      sourceRef: declaredSource.reference,
    };
  }

  const operation = AUTHORIZED_READ_OPERATIONS[declaredSource.kind] ?? 'research.read';
  let readOutcome;
  try {
    readOutcome = await integrations.executeRead(
      {
        connectionId,
        operation,
        parameters: { reference: declaredSource.reference },
      },
      provenance,
    );
  } catch (error) {
    if (error instanceof PolicyDeniedError) {
      return {
        sourceId: declaredSource.sourceId,
        outcome: 'read_refused',
        detail: `policy denied the authorized read: ${errorText(error)}`,
        facts: [],
        sourceRef: declaredSource.reference,
      };
    }
    return {
      sourceId: declaredSource.sourceId,
      outcome: 'read_error',
      detail: `the authorized read (operation '${operation}') failed: ${errorText(error)}`,
      facts: [],
      sourceRef: declaredSource.reference,
    };
  }
  if (!readOutcome.ok) {
    return {
      sourceId: declaredSource.sourceId,
      outcome: 'read_error',
      detail: readOutcome.error ?? 'the authorized read returned no records',
      facts: [],
      sourceRef: declaredSource.reference,
    };
  }

  const records = readOutcome.records.slice(0, MAX_RECORDS_PER_READ);
  if (records.length === 0) {
    return {
      sourceId: declaredSource.sourceId,
      outcome: 'no_facts_extracted',
      detail: null,
      facts: [],
      sourceRef: declaredSource.reference,
    };
  }
  const facts: PlannedFact[] = records.slice(0, MAX_FACTS_PER_SOURCE).map((record) => ({
    candidate: {
      factKind: 'source_record' as const,
      content: {
        providerRecordId: record.providerRecordId,
        data: record.data,
      },
      extractionNotes:
        'normalized provider record observed through an authorized /integrations read, carried verbatim',
    },
    contentHash: hashResearchContent(JSON.stringify(record.data)),
    fetchedAt: now,
  }));
  return {
    sourceId: declaredSource.sourceId,
    outcome: 'facts_extracted',
    detail:
      records.length < readOutcome.records.length
        ? `retained the first ${records.length} of ${readOutcome.records.length} normalized records (the bounded research envelope)`
        : null,
    facts,
    sourceRef: declaredSource.reference,
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

async function lockSessionOrThrow(
  store: ResearchStore,
  tx: DbTransaction,
  researchSessionId: string,
): Promise<ResearchSessionRecord> {
  const current = await store.lockSession(tx, researchSessionId);
  if (current === null) {
    throw new NotFoundError('research session', researchSessionId);
  }
  return current;
}

/**
 * Validates the authorized sources' connection references BEFORE any write:
 * each connection must EXIST, belong to the session's agency (the uniform
 * 404 for a foreign/unknown connection — never an oracle) and be
 * 'connected' (an honest 409 otherwise: authorized reads require an
 * authorized integration).
 */
async function assertConnectionsUsable(
  integrations: ResearchModuleDeps['integrations'],
  agencyId: string,
  sources: readonly { authorization: string; integrationConnectionId: string | null }[],
): Promise<void> {
  const seen = new Set<string>();
  for (const source of sources) {
    if (source.authorization !== 'authorized') continue;
    const connectionId = source.integrationConnectionId;
    if (connectionId === null || seen.has(connectionId)) continue;
    seen.add(connectionId);
    const connection = await integrations.getConnection(connectionId);
    if (connection === null || connection.agencyId !== agencyId) {
      throw new NotFoundError('integration connection', connectionId ?? '(none)');
    }
    if (connection.status !== 'connected') {
      throw new ConflictError(
        `integration connection ${connectionId} is ${connection.status}; authorized research sources require a connected integration`,
      );
    }
  }
}

/** Composes the honest read-back after a committed mutation. */
async function getDetailOrThrow(
  store: ResearchStore,
  researchSessionId: string,
): Promise<ResearchSessionDetail> {
  const session = await store.getSession(researchSessionId);
  if (session === null) {
    throw new Error(`research session ${researchSessionId} could not be read back`);
  }
  return composeDetail(store, session);
}

/**
 * Composes the session read model: the record, the CURRENT declared
 * version with its sources, the complete version tail, the retained source
 * facts, the research insights, the research runs and the §7 claim-tier
 * disclosure (the /content-intelligence + /product-intelligence read
 * surface — they attach by reference).
 */
async function composeDetail(
  store: ResearchStore,
  session: ResearchSessionRecord,
): Promise<ResearchSessionDetail> {
  const [versions, sourceFacts, insights, runs] = await Promise.all([
    store.listVersions(session.researchSessionId),
    store.listSourceFacts(session.researchSessionId),
    store.listInsights(session.researchSessionId),
    store.listRuns(session.researchSessionId),
  ]);
  const currentVersion =
    versions.find((version) => version.versionSeq === session.currentVersionSeq) ?? versions[0];
  if (currentVersion === undefined) {
    throw new Error(`research session ${session.researchSessionId} has no declared version`);
  }
  return {
    session,
    currentVersion,
    versions,
    sourceFacts,
    insights,
    runs,
    derivedRecordTier: RESEARCH_DERIVED_RECORD_TIER,
    vocabularyVersion: RESEARCH_VOCABULARY_VERSION,
  };
}
