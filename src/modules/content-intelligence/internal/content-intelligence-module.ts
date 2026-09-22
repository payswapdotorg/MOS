/**
 * /content-intelligence module implementation (MKT-062).
 *
 * Owns the migration 057 tables (through the store): the client-scoped
 * append-only CANDIDATE records (the §6 observed-feature set as data),
 * the append-only HYPOTHESIS records with their evidence/candidate/
 * research links, and the append-only observation-ingestion run records.
 *
 * THE EVIDENCE AUTHORITY STAYS SOLE: the observation-ingestion pipeline
 * appends every normalized platform observation as ONE canonical
 * /evidence 'observation' record through the /evidence public contract
 * (appendEvidence); candidates and hypotheses only FK-anchor the appended
 * evidence ids (the same-Client DB triggers are the backstops).
 *
 * READ-ONLY GUARANTEE (§6): this module expresses NO mutation toward any
 * platform — the integrations structural port exposes getConnection +
 * executeRead ONLY (executeMutation is structurally absent).
 *
 * HONEST FRAMING (§6): observed competitor/platform performance generates
 * hypotheses; it does NOT by itself establish causality for the user's
 * account. Hypotheses are INPUTS to /experiments — the experiment
 * reference is validated READ-ONLY through the /experiments public
 * contract and NO experiment is created or transitioned here.
 *
 * The /research direction: hypotheses may cite research insight references
 * (same-agency, validated through the /research public contract
 * READ-ONLY). The AI-discipline disclosures ride the cited research
 * records themselves (this module's frozen row lists NO /ai-runtime
 * dependency and none is used).
 */

import {
  ConflictError,
  NotFoundError,
  PolicyDeniedError,
} from '../../../platform/errors/errors.ts';
import type {
  ContentCandidateDetail,
  ContentCandidateOwnerContext,
  ContentHypothesisDetail,
  ContentHypothesisOwnerContext,
  ContentIntelligenceModuleApi,
  ContentIntelligenceModuleDeps,
  ContentObservationIngestionRunRecord,
} from '../public.ts';
import {
  CONTENT_INTELLIGENCE_HYPOTHESIS_FRAMING,
  CONTENT_INTELLIGENCE_OBSERVATION_READ_OPERATIONS,
  CONTENT_INTELLIGENCE_VOCABULARY_VERSION,
} from '../public.ts';
import {
  assertValidContentCandidateFeatures,
  assertValidContentHypothesisInput,
  assertValidContentIntelligenceProvenance,
  ContentIntelligenceStore,
} from './content-intelligence-store.ts';

import type { EvidenceRecord } from '../../evidence/public.ts';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The bounded ingestion envelope. */
const MAX_RECORDS_PER_INGESTION = 25;

/** The evidence grade of a normalized platform observation (the observed-export grade). */
const OBSERVATION_EVIDENCE_QUALITY = 'C' as const;

export function createContentIntelligenceModule(
  deps: ContentIntelligenceModuleDeps,
): ContentIntelligenceModuleApi {
  const store = new ContentIntelligenceStore(deps.db, deps.clock, deps.ids);
  const { clock, evidence, metrics, experiments, integrations, research } = deps;

  /**
   * Canonical /evidence resolution of ONE evidence link: the record must
   * exist AND belong to the SAME Client — unknown and foreign are the
   * SAME uniform NotFoundError (no cross-tenant oracle; the DB same-Client
   * trigger is the backstop). Returns the record's agency id (the
   * client→agency scope chain for the research-insight same-agency rule).
   */
  async function requireEvidenceInClient(
    clientId: string,
    evidenceId: string,
  ): Promise<string> {
    if (!UUID_PATTERN.test(evidenceId)) {
      throw new NotFoundError('evidence', evidenceId);
    }
    const record = await evidence.getEvidence(evidenceId);
    if (record === null || record.clientId !== clientId) {
      throw new NotFoundError('evidence', evidenceId);
    }
    return record.clientId;
  }

  /**
   * The client's agency, resolved through the canonical /evidence owner
   * chain (the /clients module is not an allowance of this module's row):
   * every candidate/hypothesis carries ≥1 same-client evidence link, so
   * the first evidence reference resolves the agency scope the research
   * insight citations are validated against.
   */
  async function resolveClientAgencyThroughEvidence(
    clientId: string,
    evidenceId: string,
  ): Promise<string> {
    const ownership = await evidence.resolveEvidenceOwnership(evidenceId);
    if (ownership === null || ownership.scope.clientId !== clientId) {
      throw new NotFoundError('evidence', evidenceId);
    }
    return ownership.scope.agencyId;
  }

  return {
    async runObservationIngestion(input, provenance) {
      assertValidContentIntelligenceProvenance(provenance);

      // The connection must EXIST, belong to the client (uniform 404
      // foreign/unknown — never an oracle) and be 'connected' (an honest
      // 409 otherwise: observation reads require an authorized
      // integration).
      if (!UUID_PATTERN.test(input.connectionId)) {
        throw new NotFoundError('integration connection', input.connectionId);
      }
      const connection = await integrations.getConnection(input.connectionId);
      if (connection === null || connection.clientId !== input.clientId) {
        throw new NotFoundError('integration connection', input.connectionId);
      }
      if (connection.status !== 'connected') {
        throw new ConflictError(
          `integration connection ${input.connectionId} is ${connection.status}; observation ingestion requires a connected integration`,
        );
      }

      const operation = CONTENT_INTELLIGENCE_OBSERVATION_READ_OPERATIONS[input.observationKind];
      const startedAt = clock.nowIso();
      const persistRun = async (
        status: 'completed' | 'refused' | 'failed',
        recordsObserved: number,
        appendedEvidenceIds: readonly string[],
        detail: string | null,
      ): Promise<ContentObservationIngestionRunRecord> => {
        const finished = clock.nowIso();
        const ingestionRunId = deps.ids.newId();
        await deps.db.transaction(async (tx) => {
          await store.insertIngestionRun(tx, {
            ingestionRunId,
            clientId: input.clientId,
            workspaceId: input.workspaceId,
            connectionId: input.connectionId,
            observationKind: input.observationKind,
            operation,
            status,
            recordsObserved,
            evidenceAppended: appendedEvidenceIds.length,
            appendedEvidenceIds,
            startedAt,
            finishedAt: finished,
            detail,
            provenance,
          });
        });
        const runs = await store.listIngestionRuns(input.clientId);
        const run = runs.find((entry) => entry.ingestionRunId === ingestionRunId);
        if (run === undefined) {
          throw new Error(`ingestion run ${ingestionRunId} could not be read back`);
        }
        return run;
      };

      let readOutcome;
      try {
        readOutcome = await integrations.executeRead(
          {
            connectionId: input.connectionId,
            operation,
            parameters: {},
          },
          provenance,
        );
      } catch (error) {
        if (error instanceof PolicyDeniedError) {
          return {
            run: await persistRun(
              'refused',
              0,
              [],
              `policy denied the observation read: ${errorText(error)}`,
            ),
            appendedEvidence: [],
          };
        }
        return {
          run: await persistRun(
            'failed',
            0,
            [],
            `the observation read (operation '${operation}') failed: ${errorText(error)}`,
          ),
          appendedEvidence: [],
        };
      }
      const finishedAtRead = clock.nowIso();

      if (!readOutcome.ok) {
        // The 'content.list' label awaits its adapter: no first-party
        // adapter declares it yet, so the honest outcome is the recorded
        // failure — never an invented read.
        return {
          run: await persistRun(
            'failed',
            0,
            [],
            readOutcome.error ??
              `the observation read (operation '${operation}') returned no records`,
          ),
          appendedEvidence: [],
        };
      }

      // The normalized observations become CANONICAL /evidence records —
      // ONE append per provider record, through the /evidence public
      // contract (the sole evidence authority).
      const records = readOutcome.records.slice(0, MAX_RECORDS_PER_INGESTION);
      const appended: EvidenceRecord[] = [];
      for (const record of records) {
        const appendedRecord = await evidence.appendEvidence(
          {
            clientId: input.clientId,
            workspaceId: input.workspaceId,
            class: 'observation',
            source: {
              system: connection.adapterKey,
              ref: record.providerRecordId,
            },
            observedAt: record.sourceTimestamp ?? finishedAtRead,
            content: {
              summary: `platform observation ${record.providerRecordId} read through ${connection.adapterKey}`,
              providerRecordId: record.providerRecordId,
              data: record.data,
            },
            contentRef: null,
            quality: OBSERVATION_EVIDENCE_QUALITY,
            confidence: null,
            supersedesEvidenceId: null,
          },
          {
            actor: provenance.actor,
            recordedVia: `content-intelligence:${provenance.recordedVia}`,
            correlationId: provenance.correlationId,
            causationId: provenance.causationId,
          },
        );
        appended.push(appendedRecord);
      }

      const run = await persistRun(
        'completed',
        readOutcome.records.length,
        appended.map((record) => record.evidenceId),
        records.length < readOutcome.records.length
          ? `retained the first ${records.length} of ${readOutcome.records.length} normalized records (the bounded ingestion envelope)`
          : records.length === 0
            ? 'no normalized provider records were returned by the observation read'
            : null,
      );
      return { run, appendedEvidence: appended };
    },

    async listObservationIngestionRuns(clientId) {
      return store.listIngestionRuns(clientId);
    },

    async recordContentCandidate(input, provenance) {
      assertValidContentIntelligenceProvenance(provenance);
      assertValidContentCandidateFeatures(input.features);

      // Evidence/hypothesis separation: ≥1 same-client evidence link is
      // REQUIRED (the candidate cites the normalized observation its
      // features were observed from).
      if (input.evidenceIds.length === 0) {
        throw new NotFoundError('evidence', '(none — at least one evidence reference is required)');
      }
      for (const evidenceId of input.evidenceIds) {
        await requireEvidenceInClient(input.clientId, evidenceId);
      }
      // The observed-performance anchor: /metrics observation references
      // must resolve to observations of the SAME client.
      for (const observationId of input.metricObservationIds) {
        if (!UUID_PATTERN.test(observationId)) {
          throw new NotFoundError('metric observation', observationId);
        }
        const observation = await metrics.getMetricObservation(observationId);
        if (observation === null || observation.clientId !== input.clientId) {
          throw new NotFoundError('metric observation', observationId);
        }
      }

      const contentCandidateId = deps.ids.newId();
      await deps.db.transaction(async (tx) => {
        await store.insertCandidate(tx, {
          contentCandidateId,
          clientId: input.clientId,
          workspaceId: input.workspaceId,
          features: input.features,
          provenance,
        });
        await store.insertCandidateEvidence(tx, {
          contentCandidateId,
          evidenceIds: input.evidenceIds,
        });
        if (input.metricObservationIds.length > 0) {
          await store.insertCandidateMetricLinks(tx, {
            contentCandidateId,
            metricObservationIds: input.metricObservationIds,
          });
        }
      });

      const record = await store.getCandidateById(contentCandidateId);
      if (record === null) {
        throw new Error(`content candidate ${contentCandidateId} could not be read back`);
      }
      return record;
    },

    async getContentCandidate(contentCandidateId) {
      return store.getCandidateById(contentCandidateId);
    },

    async resolveContentCandidateOwnership(contentCandidateId) {
      const candidate = await store.getCandidateById(contentCandidateId);
      if (candidate === null) return null;
      // The agency rides the canonical /evidence owner chain of the
      // candidate's first evidence link (the /clients module is not an
      // allowance of this module's row — the evidence authority resolves
      // the client→agency scope chain).
      const firstEvidenceId = candidate.evidenceIds[0];
      if (firstEvidenceId === undefined) {
        throw new Error(
          `content candidate ${contentCandidateId} carries no evidence link — the agency scope is unresolvable`,
        );
      }
      const agencyId = await resolveClientAgencyThroughEvidence(
        candidate.clientId,
        firstEvidenceId,
      );
      const resolvedAt = clock.nowIso();
      return {
        scope: {
          kind: 'content-candidate' as const,
          agencyId,
          clientId: candidate.clientId,
          contentCandidateId: candidate.contentCandidateId,
        },
        candidate,
        resolvedAt,
      } satisfies ContentCandidateOwnerContext;
    },

    async getContentCandidateDetail(contentCandidateId) {
      const candidate = await store.getCandidateById(contentCandidateId);
      if (candidate === null) return null;
      return {
        candidate,
        candidateTier: 'observed_features' as const,
        vocabularyVersion: CONTENT_INTELLIGENCE_VOCABULARY_VERSION,
      } satisfies ContentCandidateDetail;
    },

    async listContentCandidatesForClient(clientId) {
      return store.listCandidatesForClient(clientId);
    },

    async recordContentHypothesis(input, provenance) {
      assertValidContentIntelligenceProvenance(provenance);
      assertValidContentHypothesisInput(input);

      // The same-client evidence battery (≥1 required — the
      // evidence/hypothesis separation) + the agency scope resolution.
      let agencyId: string | null = null;
      for (const evidenceId of input.evidenceIds) {
        await requireEvidenceInClient(input.clientId, evidenceId);
        if (agencyId === null) {
          agencyId = await resolveClientAgencyThroughEvidence(input.clientId, evidenceId);
        }
      }
      // The candidate references: same-client candidates.
      for (const candidateId of input.candidateIds) {
        if (!UUID_PATTERN.test(candidateId)) {
          throw new NotFoundError('content candidate', candidateId);
        }
        const candidate = await store.getCandidateById(candidateId);
        if (candidate === null || candidate.clientId !== input.clientId) {
          throw new NotFoundError('content candidate', candidateId);
        }
      }
      // The /research insight citations: same-AGENCY research insights,
      // resolved through the /research public contract READ-ONLY (the
      // AI-discipline disclosures ride the cited research records).
      for (const insightId of input.researchInsightIds) {
        if (!UUID_PATTERN.test(insightId)) {
          throw new NotFoundError('research insight', insightId);
        }
        const ownership = await research.resolveResearchInsightOwnership(insightId);
        if (ownership === null || ownership.scope.agencyId !== agencyId) {
          throw new NotFoundError('research insight', insightId);
        }
      }
      // The optional /experiments reference: READ-ONLY validation through
      // the experiments public contract (same client). NO experiment is
      // created or transitioned here — hypotheses are INPUTS to
      // /experiments, never conclusions.
      if (input.experimentId !== null) {
        if (!UUID_PATTERN.test(input.experimentId)) {
          throw new NotFoundError('experiment', input.experimentId);
        }
        const experiment = await experiments.getExperiment(input.experimentId);
        if (experiment === null || experiment.clientId !== input.clientId) {
          throw new NotFoundError('experiment', input.experimentId);
        }
      }

      // The correction path (the single-supersession discipline).
      if (input.supersedesContentHypothesisId !== null) {
        const prior = await store.getHypothesisById(input.supersedesContentHypothesisId);
        if (prior === null) {
          throw new NotFoundError('content hypothesis', input.supersedesContentHypothesisId);
        }
        if (prior.clientId !== input.clientId) {
          throw new NotFoundError('content hypothesis', input.supersedesContentHypothesisId);
        }
        if (prior.hypothesisKind !== input.hypothesisKind) {
          throw new ConflictError(
            `content hypothesis ${input.supersedesContentHypothesisId} is of kind ${prior.hypothesisKind}; a correction must keep the same hypothesis kind`,
          );
        }
        if (prior.supersededByContentHypothesisId !== null) {
          throw new ConflictError(
            `content hypothesis ${input.supersedesContentHypothesisId} is already superseded by ${prior.supersededByContentHypothesisId} — the single-supersession fence`,
          );
        }
      }

      const contentHypothesisId = deps.ids.newId();
      await deps.db.transaction(async (tx) => {
        await store.insertHypothesis(tx, {
          contentHypothesisId,
          clientId: input.clientId,
          workspaceId: input.workspaceId,
          hypothesisKind: input.hypothesisKind,
          statement: input.statement,
          supersedesContentHypothesisId: input.supersedesContentHypothesisId,
          experimentId: input.experimentId,
          provenance,
        });
        await store.insertHypothesisEvidence(tx, {
          contentHypothesisId,
          evidenceIds: input.evidenceIds,
        });
        if (input.candidateIds.length > 0) {
          await store.insertHypothesisCandidates(tx, {
            contentHypothesisId,
            candidateIds: input.candidateIds,
          });
        }
        if (input.researchInsightIds.length > 0) {
          await store.insertHypothesisResearchRefs(tx, {
            contentHypothesisId,
            researchInsightIds: input.researchInsightIds,
          });
        }
      });

      const record = await store.getHypothesisById(contentHypothesisId);
      if (record === null) {
        throw new Error(`content hypothesis ${contentHypothesisId} could not be read back`);
      }
      return record;
    },

    async getContentHypothesis(contentHypothesisId) {
      return store.getHypothesisById(contentHypothesisId);
    },

    async resolveContentHypothesisOwnership(contentHypothesisId) {
      const hypothesis = await store.getHypothesisById(contentHypothesisId);
      if (hypothesis === null) return null;
      const firstEvidenceId = hypothesis.evidenceIds[0];
      if (firstEvidenceId === undefined) {
        throw new Error(
          `content hypothesis ${contentHypothesisId} carries no evidence link — the agency scope is unresolvable`,
        );
      }
      const agencyId = await resolveClientAgencyThroughEvidence(
        hypothesis.clientId,
        firstEvidenceId,
      );
      const resolvedAt = clock.nowIso();
      return {
        scope: {
          kind: 'content-hypothesis' as const,
          agencyId,
          clientId: hypothesis.clientId,
          contentHypothesisId: hypothesis.contentHypothesisId,
        },
        hypothesis,
        resolvedAt,
      } satisfies ContentHypothesisOwnerContext;
    },

    async getContentHypothesisDetail(contentHypothesisId) {
      const hypothesis = await store.getHypothesisById(contentHypothesisId);
      if (hypothesis === null) return null;
      return {
        hypothesis,
        hypothesisFraming: CONTENT_INTELLIGENCE_HYPOTHESIS_FRAMING,
        vocabularyVersion: CONTENT_INTELLIGENCE_VOCABULARY_VERSION,
      } satisfies ContentHypothesisDetail;
    },

    async listContentHypothesesForClient(clientId) {
      return store.listHypothesesForClient(clientId);
    },
  };
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, 500);
  }
  return String(error).slice(0, 500);
}
