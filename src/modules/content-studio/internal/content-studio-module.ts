/**
 * /content-studio module implementation (STUDIO-001 — the Content
 * Studio Runtime).
 *
 * THE ORCHESTRATION ONLY: this factory composes the ContentStudioStore
 * (the migration-064 tables) with the PURE contract guards of
 * validation.ts — every command passes the frozen contract semantics
 * BEFORE touching the store, and the migration-064 guard triggers
 * backstop every rule (defense in depth; the DB fences are the
 * authority, the module guards are the honest error surface).
 * Multi-statement advances (the processing-plan derivation, the final-
 * stage output recording, the treatment split) run inside single
 * database transactions over transaction-scoped store instances (the
 * /field-agents + /goals transaction precedent).
 *
 * THE SESSION DISCIPLINE (§5): a session is a versioned production
 * session. openSession validates the request version, the format
 * (through the §2 seam registry) and the submitted organization
 * (through the §4 structural port — every incompatibility listed
 * explicitly, NEVER a silent replacement), then inserts revision 1
 * born 'created' with the 'session_opened' + 'organization_loaded'
 * events. Every state advance goes through the ONE guarded path
 * (advanceSessionInternal): the pure §5 legal-edge table + the runtime
 * special guards (advancing to 'processing' derives + persists the
 * durable step plan from the format's declared stages; processing →
 * review requires ALL durable steps succeeded AND a recorded output
 * version; review → completed requires the output; → expired requires
 * the request deadline to have passed; treatment_requested is
 * reachable ONLY through requestTreatment) + the append-only audit
 * event. Terminal revisions are frozen (the DB trigger is the
 * backstop).
 *
 * THE DURABILITY DISCIPLINE (§9): advancing to 'processing' persists
 * one step row per declared stage. NOTHING processing-related lives
 * in module memory: claimProcessingSteps is the CAS batch claim
 * (FOR UPDATE SKIP LOCKED), completeProcessingStep records the
 * guarded outcome — and when the FINAL declared stage completes with
 * the plan fully succeeded, the output version is recorded (validated
 * against the request's output contract) and the session advances
 * processing → review through the SAME guarded path, in the SAME
 * transaction. A restart re-reads the same rows and continues (the
 * integration durability proof).
 *
 * THE TREATMENT DISCIPLINE (§5/§13): requestTreatment validates the
 * structured specification, resolves the session in review with the
 * target output, records the treatment request, closes the reviewed
 * revision (review → treatment_requested, terminal) and opens the
 * successor revision linked to the prior output. An alternate
 * organization REQUIRES a revised request version binding it
 * VERBATIM (the versioned explicit selection — lock v1.7 #39).
 *
 * THE SCOPE DISCIPLINE (§29): every read resolves foreign/unknown
 * scope to the uniform NotFound (no existence oracle) — the /lab and
 * /lab-agent-body house pattern.
 *
 * THE CAPTURE DISCIPLINE (§9 — STUDIO-007): capture happens inside the
 * 'recording' state. openCaptureSession opens the RECORDING CONTEXT
 * (a graph_walk capture session pins the walked declared question-graph
 * version bound to the session's request version — the STUDIO-003
 * adaptive-interviewer graph drives the capture steps; a session_direct
 * capture session records against the session itself), immutable after
 * creation. recordCaptureTake lands EVERY take's bytes through the
 * platform ObjectStore port (content-addressed platform-anchored
 * references — the durable artifact recorded on the append-only take
 * row with the full participant/source provenance: the participant
 * identity, the §7 grant when the format declares explicit grants, the
 * REQUIRED consent references, the device/input metadata, the
 * interviewer representation) and is BORN 'processing' — the ingest
 * performs the durable landing and RETURNS (§9 "Long-running processing
 * is asynchronous/durable rather than a synchronous web request"; the
 * born-processing DB fence is the structural backstop); the
 * post-landing analysis completes separately through the guarded
 * processing→stored|failed advances. Retakes are NEW takes citing the
 * take they alternate (never overwrites). No /content-assets
 * registration ever happens here — a raw take is an INTERMEDIATE
 * production artifact (lock v1.7 #36).
 */

import { InvalidRequestError, NotFoundError } from '../../../platform/errors/errors.ts';
import type {
  AdvanceContentStudioSessionInput,
  AppendContentStudioProductionRequestInput,
  AppendContentStudioSuppliedQuestionGraphVersionInput,
  AppendContentStudioSuppliedScriptVersionInput,
  ClaimContentStudioProcessingStepsInput,
  CompleteContentStudioCaptureTakeIngestInput,
  CompleteContentStudioProcessingStepInput,
  ContentStudioAgentBodyResolution,
  ContentStudioCaptureSessionRecord,
  ContentStudioCaptureTakeRecord,
  ContentStudioConversationStepRecord,
  ContentStudioDeclaredQuestionGraph,
  ContentStudioFormatDeclaration,
  ContentStudioFormatRecord,
  ContentStudioIntentRecord,
  ContentStudioModuleApi,
  ContentStudioModuleDeps,
  ContentStudioOrganizationDeclaration,
  ContentStudioOrganizationValidation,
  ContentStudioOutputVersionRecord,
  ContentStudioProductionRequestContent,
  ContentStudioProductionRequestRecord,
  ContentStudioQuestionGraphRecord,
  ContentStudioQuestionGraphReviewResult,
  ContentStudioReviewState,
  ContentStudioScope,
  ContentStudioScriptRecord,
  ContentStudioScriptReviewResult,
  ContentStudioSessionEventKind,
  ContentStudioSessionRecord,
  ContentStudioSessionState,
  ContentStudioStepCompletionResult,
  ContentStudioTerminalReason,
  ContentStudioTreatmentResult,
  CreateContentStudioProductionRequestInput,
  FailContentStudioCaptureTakeIngestInput,
  FailContentStudioProcessingStepInput,
  ListContentStudioCaptureTakesInput,
  OpenContentStudioCaptureSessionInput,
  OpenContentStudioSessionInput,
  RecordContentStudioCaptureTakeInput,
  RecordContentStudioConversationStepInput,
  RecordContentStudioGeneratedQuestionGraphInput,
  RecordContentStudioGeneratedScriptInput,
  RecordContentStudioIntentInput,
  RecordContentStudioSuppliedQuestionGraphInput,
  RecordContentStudioSuppliedScriptInput,
  RegisterContentStudioFormatInput,
  RequeueContentStudioProcessingStepInput,
  RequestContentStudioTreatmentInput,
  ReviewContentStudioQuestionGraphInput,
  ReviewContentStudioScriptInput,
} from '../public.ts';
import {
  assertLegalContentStudioSessionTransition,
  assertTerminalReasonForAdvance,
  assertValidContentStudioCaptureIngestCompletion,
  assertValidContentStudioCaptureIngestFailure,
  assertValidContentStudioCaptureSessionInput,
  assertValidContentStudioCaptureTakeInput,
  assertValidContentStudioCaptureTakesQuery,
  assertValidContentStudioDeclaredQuestionGraph,
  assertValidContentStudioGeneratorProvenance,
  assertValidContentStudioConversationChoice,
  assertValidContentStudioFormatDeclaration,
  assertValidContentStudioProductionRequestContent,
  assertValidContentStudioReviewDecision,
  assertValidContentStudioScope,
  assertValidContentStudioTreatmentSpecification,
  deriveLinearQuestionGraph,
  isTerminalContentStudioSessionState,
} from './validation.ts';
import { mintContentStudioTakeReference } from '../public.ts';
import {
  ContentStudioStore,
  mapCaptureSessionRow,
  mapCaptureTakeRow,
  mapConversationEdgeRow,
  mapEventRow,
  mapFormatRow,
  mapIntentRow,
  mapOutputRow,
  mapQuestionGraphReviewRow,
  mapQuestionGraphRow,
  mapRequestRow,
  mapScriptReviewRow,
  mapScriptRow,
  mapSessionRow,
  mapStepRow,
  mapTreatmentRow,
  type FormatRow,
  type QuestionGraphRow,
} from './content-studio-store.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuidShape(resource: string, id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new NotFoundError(resource, id);
  }
}

function assertBoundedJsonPayload(value: unknown, label: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidRequestError(`${label} must be an object`);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new InvalidRequestError(`${label} is not JSON-serializable`);
  }
  if (serialized.length > 65_536) {
    throw new InvalidRequestError(`${label} exceeds the 65536-byte declared-data bound`);
  }
}

export function createContentStudioModule(deps: ContentStudioModuleDeps): ContentStudioModuleApi {
  const store = new ContentStudioStore(deps.db, deps.clock, deps.ids);

  // --- the §2 format registry (STUDIO-002 — the wired seam content +
  // the DB-backed resolution): the composition-root wired declarations
  // are validated ONCE at construction (a bad declaration fails
  // loudly, never silently) and held as the WIRED registry content;
  // the migration-068 registry is the SYSTEM OF RECORD — the wired
  // content MATERIALIZES per CLIENT scope (materialize-if-absent, born
  // draft then activated through the guarded lifecycle inside one
  // transaction — the activation-consistency trigger verifies the
  // capability links). A tenant's own registry state (a retirement, a
  // corrected version, a tenant-registered row of the same identity)
  // is never resurrected or overwritten: materialization is
  // INSERT-only-if-absent. ---
  const wiredFormats = new Map<string, ContentStudioFormatDeclaration>();
  for (const format of deps.formats) {
    assertValidContentStudioFormatDeclaration(format);
    const key = `${format.formatId}@v${format.formatVersion}`;
    if (wiredFormats.has(key)) {
      throw new InvalidRequestError(`the wired format registry declares '${key}' more than once`);
    }
    wiredFormats.set(key, format);
  }

  /** Assembles a format record view with its capability link references. */
  const formatRecord = (row: FormatRow, links: ReadonlyArray<string>): ContentStudioFormatRecord => mapFormatRow(row, links);

  /** The registry-row resolver (the uniform tenant fence — NotFound for foreign/unknown scope, no existence oracle). */
  const requireFormatRow = async (scope: ContentStudioScope, formatId: string, formatVersion: number): Promise<FormatRow> => {
    const row = await store.findFormatVersion(scope.clientId, formatId, formatVersion);
    if (row === null) {
      throw new NotFoundError('studio format', `${formatId}@v${formatVersion}`);
    }
    return row;
  };

  /** The registry-key shape fence (the honest error surface over the id/version the caller cited). */
  const assertFormatVersionShape = (formatId: string, formatVersion: number): void => {
    if (typeof formatId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(formatId)) {
      throw new InvalidRequestError('formatId must be 1-64 chars of [a-z0-9_-]');
    }
    if (typeof formatVersion !== 'number' || !Number.isSafeInteger(formatVersion) || formatVersion < 1 || formatVersion > 1000) {
      throw new InvalidRequestError(`format '${formatId}' formatVersion must be an integer 1-1000`);
    }
  };

  /** The links for one registry row (client-fenced). */
  const linksFor = async (clientId: string, formatVersionId: string): Promise<ReadonlyArray<string>> =>
    (await store.listFormatCapabilityLinks(clientId, formatVersionId)).map((link) => link.capability_reference);

  /**
   * THE LAZY MATERIALIZATION (the disclosed design): the wired initial
   * registry content materializes per CLIENT scope on read
   * (materialize-if-absent → born draft → links → the guarded
   * activation, transactionally). Re-running is a no-op once the row
   * exists — a retired or tenant-corrected row is never resurrected.
   */
  const ensureWiredFormat = async (scope: ContentStudioScope, formatId: string, formatVersion: number): Promise<void> => {
    const wired = wiredFormats.get(`${formatId}@v${formatVersion}`);
    if (wired === undefined) {
      return; // not a wired declaration — no materialization (custom formats register through the public seam)
    }
    const existing = await store.findFormatVersion(scope.clientId, formatId, formatVersion);
    if (existing !== null) {
      return; // materialize-if-absent: never resurrect, never overwrite
    }
    await deps.db.transaction(async (tx) => {
      const txStore = new ContentStudioStore(tx, deps.clock, deps.ids);
      const raced = await txStore.findFormatVersion(scope.clientId, formatId, formatVersion);
      if (raced !== null) {
        return; // a concurrent materialization won the race — idempotent
      }
      const row = await txStore.insertFormatVersion({
        formatVersionId: txStore.newId(),
        formatId,
        formatVersion,
        scope,
        declaration: wired,
      });
      for (const reference of wired.organizationRequirements.requiredCapabilities ?? []) {
        await txStore.insertFormatCapabilityLink({
          formatVersionId: row.format_version_id,
          scope,
          capabilityKind: 'required',
          capabilityReference: reference,
        });
      }
      // The guarded activation (draft → active): the DB trigger
      // verifies the capability links match the declaration before
      // the row can go active — the frozen initial formats are born
      // active through the SAME lifecycle every format takes.
      await txStore.advanceFormatStatus({ formatVersionId: row.format_version_id, from: 'draft', to: 'active' });
    });
  };

  /**
   * THE COMPATIBILITY RESOLUTION (§2/§3): a production request's
   * selected format resolves through the registry — ACTIVE versions
   * only. Foreign/unknown scope resolves to the uniform NotFound (no
   * existence oracle); a known-but-inactive version resolves to the
   * honest InvalidRequest citing its lifecycle state.
   */
  const requireActiveFormat = async (
    scope: ContentStudioScope,
    formatId: string,
    formatVersion: number,
  ): Promise<ContentStudioFormatDeclaration> => {
    await ensureWiredFormat(scope, formatId, formatVersion);
    const row = await store.findFormatVersion(scope.clientId, formatId, formatVersion);
    if (row === null) {
      throw new NotFoundError('studio format', `${formatId}@v${formatVersion}`);
    }
    if (row.status !== 'active') {
      throw new InvalidRequestError(
        `studio format ${formatId}@v${formatVersion} is ${row.status} — sessions open against ACTIVE format versions only (the registry lifecycle; corrections are new version rows)`,
      );
    }
    return row.declaration as ContentStudioFormatDeclaration;
  };

  /**
   * The RUNNING-SESSION declaration read (the retirement-never-breaks-
   * running-sessions discipline): the session bound its format
   * identity/version as its own recorded data at open — a later
   * retirement closes NEW resolutions only, so the running session's
   * declaration stays resolvable under ANY lifecycle status (the
   * registry never deletes). Foreign/unknown scope still resolves to
   * the uniform NotFound.
   */
  const requireSessionFormat = async (
    scope: ContentStudioScope,
    formatId: string,
    formatVersion: number,
  ): Promise<ContentStudioFormatDeclaration> => {
    const row = await store.findFormatVersion(scope.clientId, formatId, formatVersion);
    if (row === null) {
      throw new NotFoundError('studio format', `${formatId}@v${formatVersion}`);
    }
    return row.declaration as ContentStudioFormatDeclaration;
  };

  // --- the §8 INTENT-TO-SCRIPT pipeline (STUDIO-003 — the gate + the
  // record surfaces over the migration-070 tables) ---

  /**
   * THE GENERATED-INPUT REVIEW GATE (§8 "The generated script is
   * versioned and reviewable before recording when the format requires
   * explicit user confirmation" — honored STRUCTURALLY): when the
   * format's inputRequirements.generatedInputReview is 'required' and
   * the request's input mode is 'intent' (the generation path), a
   * materialized generated script/question-graph chain for the EXACT
   * request version is citable ONLY in its APPROVED latest version —
   * a pending/rejected/superseded citation is refused with the honest
   * state. When `materialMustExist` is set (the RECORDING gate — the
   * interview needs the approved material), an ABSENT chain is refused
   * too; otherwise (the session-open gate) an absent chain passes (the
   * §8 in-session generation path: the selected organization may
   * generate during the session — the recording gate then catches it).
   */
  const assertGeneratedInputReviewGate = async (
    scope: ContentStudioScope,
    request: ContentStudioProductionRequestRecord,
    format: ContentStudioFormatDeclaration,
    options: { readonly materialMustExist: boolean },
  ): Promise<void> => {
    if (format.inputRequirements.generatedInputReview !== 'required') {
      return; // the format does not require explicit user confirmation
    }
    if (request.content.input.mode !== 'intent') {
      return; // the supplied paths are user-authored — their own authority
    }
    const scriptRow = await store.findLatestScriptForRequest(scope.clientId, request.requestId, request.requestVersion);
    const graphRow = scriptRow === null ? await store.findLatestQuestionGraphForRequest(scope.clientId, request.requestId, request.requestVersion) : null;
    if (scriptRow === null && graphRow === null) {
      if (options.materialMustExist) {
        throw new InvalidRequestError(
          `studio session against format '${format.formatId}@v${format.formatVersion}' requires explicit user confirmation of the generated input — request ${request.requestId}#v${request.requestVersion} has NO generated script/question-graph yet (record + approve the generated material before recording)`,
        );
      }
      return;
    }
    const kind = scriptRow !== null ? 'script' : 'question graph';
    const origin = scriptRow !== null ? scriptRow.origin : graphRow!.origin;
    const state = scriptRow !== null ? scriptRow.review_state : graphRow!.review_state;
    if (origin !== 'generated') {
      return; // a supplied chain on an intent-mode request cannot exist (the mode fence); defensive no-op
    }
    if (state !== 'approved') {
      throw new InvalidRequestError(
        `studio session against format '${format.formatId}@v${format.formatVersion}' requires explicit user confirmation of the generated input — the latest generated ${kind} for request ${request.requestId}#v${request.requestVersion} is '${state}' (only an APPROVED generated script/question-graph may be cited)`,
      );
    }
  };

  // --- the §4 organization compatibility validation (EXPLICIT, never silent) ---
  const validateOrganizationCompatibility = async (
    scope: ContentStudioScope,
    format: ContentStudioFormatDeclaration,
    organization: ContentStudioOrganizationDeclaration,
  ): Promise<ContentStudioOrganizationValidation> => {
    const failures: string[] = [];
    const resolved: ContentStudioAgentBodyResolution[] = [];

    for (const reference of organization.agentBodyReferences) {
      const resolution = await deps.agentBodies.resolveAgentBody(scope, reference);
      if (resolution === null) {
        failures.push(`agent body version '${reference}' does not resolve in scope (the organization cannot be loaded)`);
        continue;
      }
      if (resolution.status !== 'active') {
        failures.push(`agent body version '${reference}' is ${resolution.status} (only an active body version can be loaded)`);
      }
      resolved.push(resolution);
    }

    // §4 MUST-validate: organization version + required Agent Bodies (count).
    if (resolved.length < format.organizationRequirements.minAgentBodies) {
      failures.push(
        `the organization cites ${resolved.length} resolvable agent bodies; the format '${format.formatId}' requires at least ${format.organizationRequirements.minAgentBodies}`,
      );
    }

    // §4 MUST-validate: required capabilities (collective coverage).
    const requiredCapabilities = format.organizationRequirements.requiredCapabilities ?? [];
    if (requiredCapabilities.length > 0) {
      const declared = new Set<string>([...resolved.flatMap((body) => body.capabilities), ...organization.capabilities]);
      for (const capability of requiredCapabilities) {
        if (!declared.has(capability)) {
          failures.push(`the required capability '${capability}' is not declared by any cited agent body or the organization`);
        }
      }
    }

    // §4 MUST-validate: input/output compatibility — the required
    // permissions (collective coverage over the bodies' §14 permissions).
    const grantedPermissions = new Set<string>(resolved.flatMap((body) => body.permissions));
    for (const permission of format.organizationRequirements.requiredPermissions) {
      if (!grantedPermissions.has(permission)) {
        failures.push(`the required permission '${permission}' is not granted by any cited agent body`);
      }
    }

    // §4 MUST-validate: safety constraints — every resolved body must
    // carry its declared safety posture (non-empty by the body contract).
    for (const body of resolved) {
      if (body.safetyConstraints.length < 1) {
        failures.push(`agent body version '${body.bodyVersionReference}' declares no safety constraints`);
      }
    }

    if (failures.length > 0) {
      // §4: "A compatibility failure is explicit and auditable." — the
      // requested organization is NEVER silently replaced.
      throw new InvalidRequestError(
        `organization '${organization.organizationId}@v${organization.organizationVersion}' does not satisfy the Studio compatibility contract for format '${format.formatId}@v${format.formatVersion}'`,
        failures,
      );
    }

    return {
      organizationId: organization.organizationId,
      organizationVersion: organization.organizationVersion,
      resolvedBodies: resolved,
      validatedAt: store.nowIso(),
    };
  };

  // --- the request-version resolver (the uniform tenant fence) ---
  const requireRequestVersion = async (scope: ContentStudioScope, requestId: string, requestVersion?: number) => {
    assertUuidShape('studio production request', requestId);
    const row =
      requestVersion === undefined
        ? await store.findLatestRequestVersion(scope.clientId, requestId)
        : await store.findRequestVersion(scope.clientId, requestId, requestVersion);
    if (row === null) {
      throw new NotFoundError('studio production request', requestVersion === undefined ? requestId : `${requestId}#v${requestVersion}`);
    }
    return mapRequestRow(row);
  };

  // --- the session-revision resolver (the uniform tenant fence) ---
  const requireLatestSession = async (scope: ContentStudioScope, sessionId: string) => {
    assertUuidShape('studio session', sessionId);
    const row = await store.findLatestSessionRevision(scope.clientId, sessionId);
    if (row === null) {
      throw new NotFoundError('studio session', sessionId);
    }
    return mapSessionRow(row);
  };

  /** The per-revision event-seq helper (the ordered append-only tail). */
  const appendEvent = async (
    txStore: ContentStudioStore,
    input: {
      scope: ContentStudioScope;
      sessionId: string;
      revision: number;
      eventKind: ContentStudioSessionEventKind;
      payload: Readonly<Record<string, unknown>>;
    },
  ): Promise<void> => {
    const seq = await txStore.nextEventSeq(input.scope.clientId, input.sessionId, input.revision);
    await txStore.insertSessionEvent({
      eventId: txStore.newId(),
      sessionId: input.sessionId,
      revision: input.revision,
      scope: input.scope,
      seq,
      eventKind: input.eventKind,
      payload: input.payload,
    });
  };

  // --- THE ONE guarded advance path (§5 — no implicit jumps) ---
  const advanceSessionInternal = async (
    scope: ContentStudioScope,
    session: ContentStudioSessionRecord,
    to: ContentStudioSessionState,
    terminalReason: ContentStudioTerminalReason | null,
    note?: string,
  ): Promise<ContentStudioSessionRecord> => {
    assertLegalContentStudioSessionTransition(session.state, to);

    // The runtime special guards (defense in depth over the pure table):
    if (to === 'recording') {
      // §8 (STUDIO-003): the generated-input review gate — "reviewable
      // BEFORE RECORDING when the format requires explicit user
      // confirmation". The materialized chain for the session's exact
      // request version must EXIST and its latest version be APPROVED.
      const request = await requireRequestVersion(scope, session.requestId, session.requestVersion);
      const format = await requireSessionFormat(scope, session.formatId, session.formatVersion);
      await assertGeneratedInputReviewGate(scope, request, format, { materialMustExist: true });
    }
    if (to === 'review') {
      const steps = await store.listSessionSteps(scope.clientId, session.sessionId);
      const revisionSteps = steps.filter((step) => Number(step.revision) === session.revision);
      if (revisionSteps.length < 1) {
        throw new InvalidRequestError(`studio session ${session.sessionId}#r${session.revision} has no recorded processing steps — advancing to review requires the durable plan to be recorded first`);
      }
      const incomplete = revisionSteps.filter((step) => step.status !== 'succeeded');
      if (incomplete.length > 0) {
        throw new InvalidRequestError(
          `studio session ${session.sessionId}#r${session.revision} still has ${incomplete.length} non-succeeded processing step(s) — advancing to review requires ALL durable steps to have succeeded`,
        );
      }
      const outputs = await store.listSessionOutputs(scope.clientId, session.sessionId);
      if (!outputs.some((output) => Number(output.revision) === session.revision)) {
        throw new InvalidRequestError(`studio session ${session.sessionId}#r${session.revision} has no recorded output version — advancing to review requires the output artifact package`);
      }
    }
    if (to === 'completed') {
      const outputs = await store.listSessionOutputs(scope.clientId, session.sessionId);
      if (!outputs.some((output) => Number(output.revision) === session.revision)) {
        throw new InvalidRequestError(`studio session ${session.sessionId}#r${session.revision} has no recorded output version — a review cannot complete without its artifact package`);
      }
    }
    if (to === 'expired') {
      const request = await requireRequestVersion(scope, session.requestId, session.requestVersion);
      const deadlineMs = Date.parse(request.content.deadline);
      if (deps.clock.nowMs() < deadlineMs) {
        throw new InvalidRequestError(
          `studio session ${session.sessionId}#r${session.revision} cannot expire before the request deadline (${request.content.deadline} — the honest §17 delay bound)`,
        );
      }
    }
    if (to === 'treatment_requested') {
      // reachable ONLY through requestTreatment (which records the §13
      // structured request + opens the successor revision).
      throw new InvalidRequestError(`studio session ${session.sessionId}#r${session.revision} may only enter 'treatment_requested' through requestTreatment (the §13 structured path)`);
    }

    // §9: advancing to 'processing' derives + PERSISTS the durable step
    // plan from the format's declared stages — one step row per stage,
    // transactionally with the state advance (a restart re-reads them).
    if (to === 'processing') {
      const request = await requireRequestVersion(scope, session.requestId, session.requestVersion);
      void request;
      const format = await requireSessionFormat(scope, session.formatId, session.formatVersion);
      const existing = await store.listSessionSteps(scope.clientId, session.sessionId);
      const revisionSteps = existing.filter((step) => Number(step.revision) === session.revision);
      if (revisionSteps.length > 0) {
        throw new InvalidRequestError(
          `studio session ${session.sessionId}#r${session.revision} already has a recorded processing plan (${revisionSteps.length} steps) — the durable plan is derived exactly once per revision`,
        );
      }
      return deps.db.transaction(async (tx) => {
        const txStore = new ContentStudioStore(tx, deps.clock, deps.ids);
        for (const [index, stage] of format.processingStages.entries()) {
          await txStore.insertProcessingStep({
            stepId: txStore.newId(),
            sessionId: session.sessionId,
            revision: session.revision,
            scope,
            stageId: stage.stageId,
            stageIndex: index + 1,
            runAtIso: txStore.nowIso(),
          });
        }
        await appendEvent(txStore, {
          scope,
          sessionId: session.sessionId,
          revision: session.revision,
          eventKind: 'processing_plan_recorded',
          payload: { stages: format.processingStages.map((stage) => stage.stageId) },
        });
        const advancedRow = await txStore.advanceSessionState({
          clientId: scope.clientId,
          sessionId: session.sessionId,
          revision: session.revision,
          to,
          terminalReason,
        });
        if (advancedRow === null) {
          throw new NotFoundError('studio session', session.sessionId);
        }
        await appendEvent(txStore, {
          scope,
          sessionId: session.sessionId,
          revision: session.revision,
          eventKind: 'state_advanced',
          payload: { from: session.state, to, terminalReason, ...(note === undefined ? {} : { note }) },
        });
        return mapSessionRow(advancedRow);
      });
    }

    const advancedRow = await store.advanceSessionState({
      clientId: scope.clientId,
      sessionId: session.sessionId,
      revision: session.revision,
      to,
      terminalReason,
    });
    if (advancedRow === null) {
      throw new NotFoundError('studio session', session.sessionId);
    }
    await appendEvent(store, {
      scope,
      sessionId: session.sessionId,
      revision: session.revision,
      eventKind: 'state_advanced',
      payload: { from: session.state, to, terminalReason, ...(note === undefined ? {} : { note }) },
    });
    return mapSessionRow(advancedRow);
  };

  return {
    // --- The §3 production request registry (immutable/versioned) ---

    async createProductionRequest(input: CreateContentStudioProductionRequestInput): Promise<ContentStudioProductionRequestRecord> {
      assertValidContentStudioScope(input.scope);
      assertValidContentStudioProductionRequestContent(input.content);
      const row = await store.insertRequestVersion({
        requestId: store.newId(),
        requestVersion: 1,
        scope: input.scope,
        content: input.content,
      });
      return mapRequestRow(row);
    },

    async appendProductionRequestVersion(input: AppendContentStudioProductionRequestInput): Promise<ContentStudioProductionRequestRecord> {
      assertValidContentStudioScope(input.scope);
      assertValidContentStudioProductionRequestContent(input.content);
      const latest = await requireRequestVersion(input.scope, input.requestId);
      const row = await store.insertRequestVersion({
        requestId: input.requestId,
        requestVersion: latest.requestVersion + 1,
        scope: input.scope,
        content: input.content,
      });
      return mapRequestRow(row);
    },

    async getProductionRequest(scope, requestId) {
      assertValidContentStudioScope(scope);
      return requireRequestVersion(scope, requestId);
    },

    async getProductionRequestVersion(scope, requestId, requestVersion) {
      assertValidContentStudioScope(scope);
      if (typeof requestVersion !== 'number' || !Number.isSafeInteger(requestVersion) || requestVersion < 1) {
        throw new InvalidRequestError('requestVersion must be a positive integer');
      }
      return requireRequestVersion(scope, requestId, requestVersion);
    },

    async listProductionRequests(scope) {
      assertValidContentStudioScope(scope);
      const rows = await store.listLatestRequests(scope.clientId);
      return rows.map(mapRequestRow);
    },

    // --- The §2 FORMAT REGISTRY (STUDIO-002 — registration, versioning,
    // activation, retirement, resolution) ---

    async registerFormat(input: RegisterContentStudioFormatInput): Promise<ContentStudioFormatRecord> {
      assertValidContentStudioScope(input.scope);
      assertValidContentStudioFormatDeclaration(input.declaration);
      const { formatId, formatVersion } = input.declaration;

      // The append-only registry discipline: a duplicate identity/version
      // is rejected (corrections are NEW version rows).
      const existing = await store.findFormatVersion(input.scope.clientId, formatId, formatVersion);
      if (existing !== null) {
        throw new InvalidRequestError(
          `studio format ${formatId}@v${formatVersion} is already registered in this scope (status '${existing.status}') — corrections are NEW version rows (the append-only registry discipline)`,
        );
      }
      // The version-chain continuity: registering version n > 1 requires
      // version n-1 in the same scope (the DB chain-scope fence is the
      // backstop; this is the honest error surface).
      if (formatVersion > 1) {
        const predecessor = await store.findFormatVersion(input.scope.clientId, formatId, formatVersion - 1);
        if (predecessor === null) {
          throw new InvalidRequestError(
            `studio format '${formatId}@v${formatVersion}' cannot register: version ${formatVersion - 1} is not in this scope's registry (the version chain must be continuous)`,
          );
        }
      }

      // The registration writes the draft row + its capability link
      // records (the normalized requiredCapabilities) transactionally.
      const row = await deps.db.transaction(async (tx) => {
        const txStore = new ContentStudioStore(tx, deps.clock, deps.ids);
        const inserted = await txStore.insertFormatVersion({
          formatVersionId: txStore.newId(),
          formatId,
          formatVersion,
          scope: input.scope,
          declaration: input.declaration,
        });
        for (const reference of input.declaration.organizationRequirements.requiredCapabilities ?? []) {
          await txStore.insertFormatCapabilityLink({
            formatVersionId: inserted.format_version_id,
            scope: input.scope,
            capabilityKind: 'required',
            capabilityReference: reference,
          });
        }
        return inserted;
      });
      return formatRecord(row, [...(input.declaration.organizationRequirements.requiredCapabilities ?? [])]);
    },

    async activateFormat(scope, formatId, formatVersion) {
      assertValidContentStudioScope(scope);
      assertFormatVersionShape(formatId, formatVersion);
      const row = await requireFormatRow(scope, formatId, formatVersion);
      if (row.status !== 'draft') {
        throw new InvalidRequestError(
          `studio format ${formatId}@v${formatVersion} is '${row.status}' — only a DRAFT format version can activate (no resurrection; the lifecycle is draft → active → retired)`,
        );
      }
      const advanced = await store.advanceFormatStatus({ formatVersionId: row.format_version_id, from: 'draft', to: 'active' });
      if (advanced === null) {
        throw new InvalidRequestError(`studio format ${formatId}@v${formatVersion} could not activate (it is no longer draft)`);
      }
      return formatRecord(advanced, await linksFor(scope.clientId, advanced.format_version_id));
    },

    async retireFormat(scope, formatId, formatVersion) {
      assertValidContentStudioScope(scope);
      assertFormatVersionShape(formatId, formatVersion);
      const row = await requireFormatRow(scope, formatId, formatVersion);
      if (row.status !== 'active') {
        throw new InvalidRequestError(
          `studio format ${formatId}@v${formatVersion} is '${row.status}' — only an ACTIVE format version can retire`,
        );
      }
      const retired = await store.advanceFormatStatus({ formatVersionId: row.format_version_id, from: 'active', to: 'retired' });
      if (retired === null) {
        throw new InvalidRequestError(`studio format ${formatId}@v${formatVersion} could not retire (it is no longer active)`);
      }
      return formatRecord(retired, await linksFor(scope.clientId, retired.format_version_id));
    },

    async getFormat(scope, formatId, formatVersion) {
      assertValidContentStudioScope(scope);
      assertFormatVersionShape(formatId, formatVersion);
      await ensureWiredFormat(scope, formatId, formatVersion);
      const row = await requireFormatRow(scope, formatId, formatVersion);
      return formatRecord(row, await linksFor(scope.clientId, row.format_version_id));
    },

    async listFormats(scope) {
      assertValidContentStudioScope(scope);
      // The frozen §2 out-of-the-box availability: the wired registry
      // content materializes-if-absent on listing (a tenant's own
      // registry state is never resurrected or overwritten).
      for (const format of deps.formats) {
        await ensureWiredFormat(scope, format.formatId, format.formatVersion);
      }
      const rows = await store.listFormatVersions(scope.clientId);
      const links = await store.listFormatCapabilityLinks(scope.clientId);
      const linksByFormatVersionId = new Map<string, string[]>();
      for (const link of links) {
        const list = linksByFormatVersionId.get(link.format_version_id) ?? [];
        list.push(link.capability_reference);
        linksByFormatVersionId.set(link.format_version_id, list);
      }
      return rows.map((row) => mapFormatRow(row, linksByFormatVersionId.get(row.format_version_id) ?? []));
    },

    // --- The §5 versioned production sessions ---

    async openSession(input: OpenContentStudioSessionInput): Promise<ContentStudioSessionRecord> {
      assertValidContentStudioScope(input.scope);
      if (input.requestVersion !== undefined && (typeof input.requestVersion !== 'number' || !Number.isSafeInteger(input.requestVersion) || input.requestVersion < 1)) {
        throw new InvalidRequestError('requestVersion must be a positive integer');
      }
      const request = await requireRequestVersion(input.scope, input.requestId, input.requestVersion);
      const content = request.content;

      // The §2 seam: the request's format must be registered AND ACTIVE
      // (the registry compatibility resolution — active versions only).
      const format = await requireActiveFormat(input.scope, content.formatId, content.formatVersion);

      // The §8 input-requirements fence (the deterministic part the
      // runtime owns): the input mode must be accepted and required
      // source artifacts must be cited.
      if (!format.inputRequirements.modes.includes(content.input.mode)) {
        throw new InvalidRequestError(
          `format '${format.formatId}@v${format.formatVersion}' does not accept input mode '${content.input.mode}'`,
        );
      }
      if (format.inputRequirements.sourceArtifacts === 'required') {
        const sources = content.input.sourceArtifactReferences ?? [];
        if (sources.length < 1) {
          throw new InvalidRequestError(
            `format '${format.formatId}@v${format.formatVersion}' requires source/reference artifacts — the request cites none`,
          );
        }
      }

      // The output-contract fence: the request's required outputs must
      // be a subset of the format's declared outputs.
      for (const required of content.output.requiredOutputs) {
        if (!(format.outputContract.outputs as ReadonlyArray<string>).includes(required)) {
          throw new InvalidRequestError(
            `the request requires output '${required}' which format '${format.formatId}@v${format.formatVersion}' does not declare`,
          );
        }
      }

      // §8 (STUDIO-003): the generated-input review gate at session
      // open — a request against a format that requires confirmation
      // can cite ONLY an approved generated script/graph: an
      // already-materialized chain must be approved (an absent chain
      // passes — the in-session generation path; the recording gate
      // then catches it).
      await assertGeneratedInputReviewGate(input.scope, request, format, { materialMustExist: false });

      // The §4 organization compatibility validation — explicit, auditable,
      // NEVER a silent replacement.
      const validation = await validateOrganizationCompatibility(input.scope, format, content.organization);

      const sessionId = store.newId();
      const row = await deps.db.transaction(async (tx) => {
        const txStore = new ContentStudioStore(tx, deps.clock, deps.ids);
        const inserted = await txStore.insertSessionRevision({
          sessionId,
          revision: 1,
          scope: input.scope,
          requestId: request.requestId,
          requestVersion: request.requestVersion,
          format: { formatId: format.formatId, formatVersion: format.formatVersion },
          organization: content.organization,
          organizationValidation: validation,
          priorOutputVersionId: null,
          originTreatmentId: null,
        });
        await appendEvent(txStore, {
          scope: input.scope,
          sessionId,
          revision: 1,
          eventKind: 'session_opened',
          payload: {
            requestId: request.requestId,
            requestVersion: request.requestVersion,
            entryMode: content.entryMode,
            format: `${format.formatId}@v${format.formatVersion}`,
          },
        });
        await appendEvent(txStore, {
          scope: input.scope,
          sessionId,
          revision: 1,
          eventKind: 'organization_loaded',
          payload: {
            organizationId: validation.organizationId,
            organizationVersion: validation.organizationVersion,
            resolvedBodies: validation.resolvedBodies.map((body) => body.bodyVersionReference),
            validatedAt: validation.validatedAt,
          },
        });
        return inserted;
      });
      return mapSessionRow(row);
    },

    async getSession(scope, sessionId) {
      assertValidContentStudioScope(scope);
      return requireLatestSession(scope, sessionId);
    },

    async listSessions(scope) {
      assertValidContentStudioScope(scope);
      const rows = await store.listLatestSessions(scope.clientId);
      return rows.map(mapSessionRow);
    },

    async listSessionRevisions(scope, sessionId) {
      assertValidContentStudioScope(scope);
      assertUuidShape('studio session', sessionId);
      const rows = await store.listSessionRevisions(scope.clientId, sessionId);
      if (rows.length < 1) {
        throw new NotFoundError('studio session', sessionId);
      }
      return rows.map(mapSessionRow);
    },

    async listSessionEvents(scope, sessionId) {
      assertValidContentStudioScope(scope);
      assertUuidShape('studio session', sessionId);
      const rows = await store.listSessionEvents(scope.clientId, sessionId);
      if (rows.length < 1) {
        // A session with no events does not exist (every session opens
        // with at least the session_opened event).
        await requireLatestSession(scope, sessionId);
        return [];
      }
      return rows.map(mapEventRow);
    },

    // --- The guarded lifecycle ---

    async advanceSession(input: AdvanceContentStudioSessionInput): Promise<ContentStudioSessionRecord> {
      assertValidContentStudioScope(input.scope);
      assertTerminalReasonForAdvance(input.to, input.terminalReason);
      if (input.note !== undefined && input.note !== null && (typeof input.note !== 'string' || input.note.length > 512)) {
        throw new InvalidRequestError('note must be a string of at most 512 chars');
      }
      const session = await requireLatestSession(input.scope, input.sessionId);
      return advanceSessionInternal(input.scope, session, input.to, input.terminalReason ?? null, input.note);
    },

    // --- The §9 asynchronous/durable processing surface ---

    async listProcessingSteps(scope, sessionId) {
      assertValidContentStudioScope(scope);
      assertUuidShape('studio session', sessionId);
      await requireLatestSession(scope, sessionId);
      const rows = await store.listSessionSteps(scope.clientId, sessionId);
      return rows.map(mapStepRow);
    },

    async claimProcessingSteps(input: ClaimContentStudioProcessingStepsInput) {
      assertValidContentStudioScope(input.scope);
      if (typeof input.limit !== 'number' || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 16) {
        throw new InvalidRequestError('limit must be an integer 1-16 (one driver batch)');
      }
      if (typeof input.lockedBy !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(input.lockedBy)) {
        throw new InvalidRequestError('lockedBy must be 1-128 chars of [A-Za-z0-9._-]');
      }
      if (input.sessionId !== undefined && input.sessionId !== null) {
        assertUuidShape('studio session', input.sessionId);
      }
      const rows = await store.claimDueSteps(input.scope.clientId, input.sessionId ?? null, input.limit, input.lockedBy);
      const claimed = rows.map(mapStepRow);
      for (const step of claimed) {
        await appendEvent(store, {
          scope: input.scope,
          sessionId: step.sessionId,
          revision: step.revision,
          eventKind: 'step_claimed',
          payload: { stepId: step.stepId, stageId: step.stageId, attempts: step.attempts, lockedBy: input.lockedBy },
        });
      }
      return claimed;
    },

    async completeProcessingStep(input: CompleteContentStudioProcessingStepInput): Promise<ContentStudioStepCompletionResult> {
      assertValidContentStudioScope(input.scope);
      assertUuidShape('studio processing step', input.stepId);
      assertBoundedJsonPayload(input.output, 'output');
      const costUnits = input.costUnits ?? 0;
      const durationMs = input.durationMs ?? 0;
      if (typeof costUnits !== 'number' || !Number.isFinite(costUnits) || costUnits < 0 || costUnits > 1_000_000) {
        throw new InvalidRequestError('costUnits must be a finite number 0-1000000');
      }
      if (typeof durationMs !== 'number' || !Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > 2_592_000_000) {
        throw new InvalidRequestError('durationMs must be an integer 0-2592000000');
      }

      const stepRow = await store.findStep(input.scope.clientId, input.stepId);
      if (stepRow === null) {
        throw new NotFoundError('studio processing step', input.stepId);
      }
      if (stepRow.status !== 'running') {
        throw new InvalidRequestError(`studio processing step ${input.stepId} is ${stepRow.status} — only a running (claimed) step may complete`);
      }

      const session = await requireLatestSession(input.scope, stepRow.session_id as string);
      const request = await requireRequestVersion(input.scope, session.requestId, session.requestVersion);
      const format = await requireSessionFormat(input.scope, session.formatId, session.formatVersion);

      // THE ORDER-INDEPENDENT PLAN FINALIZATION (§9): this completion
      // finalizes the plan when it leaves the WHOLE declared plan
      // succeeded — regardless of the completion ORDER the driver used
      // (stages may complete out of order; the FINAL declared stage's
      // recorded output is the artifact package). Then: record the
      // output version (validated against the request's output
      // contract) and advance processing → review through the SAME
      // guarded path — in the SAME transaction (the §5
      // no-implicit-jump rule + the §9 atomicity discipline).
      const stepsBefore = (await store.listSessionSteps(input.scope.clientId, stepRow.session_id as string))
        .filter((row) => Number(row.revision) === Number(stepRow.revision));
      const finalizesPlan =
        stepsBefore.length === format.processingStages.length &&
        stepsBefore.every((row) => row.status === 'succeeded' || row.step_id === input.stepId);

      // The output-contract validation (§18): every required output kind
      // must be present in the FINAL declared stage's package (the
      // artifact package source — validated BEFORE the completion lands
      // so a violation rolls the whole transaction back honestly).
      if (finalizesPlan) {
        const finalStageRow = Number(stepRow.stage_index) === format.processingStages.length
          ? { output: input.output as Record<string, unknown> }
          : stepsBefore.find((row) => Number(row.stage_index) === format.processingStages.length);
        const finalStageOutput = finalStageRow === undefined ? null : (finalStageRow.output as Record<string, unknown> | null);
        if (finalStageOutput === null || typeof finalStageOutput !== 'object') {
          throw new InvalidRequestError(
            `the final declared stage '${format.processingStages[format.processingStages.length - 1]!.stageId}' has no recorded output — the artifact package source is missing`,
          );
        }
        const missing = request.content.output.requiredOutputs.filter((required) => !Object.hasOwn(finalStageOutput, required));
        if (missing.length > 0) {
          throw new InvalidRequestError(
            `the output artifact package is missing the required output(s): ${missing.join(', ')}`,
          );
        }
      }

      const completed = await deps.db.transaction(async (tx) => {
        const txStore = new ContentStudioStore(tx, deps.clock, deps.ids);
        const completedRow = await txStore.completeStep({
          stepId: input.stepId,
          output: input.output,
          costUnits,
          durationMs,
        });
        if (completedRow === null) {
          throw new InvalidRequestError(`studio processing step ${input.stepId} could not complete (it is no longer running)`);
        }
        const step = mapStepRow(completedRow);
        await appendEvent(txStore, {
          scope: input.scope,
          sessionId: step.sessionId,
          revision: step.revision,
          eventKind: 'step_completed',
          payload: { stepId: step.stepId, stageId: step.stageId, costUnits: step.costUnits, durationMs: step.durationMs },
        });

        if (!finalizesPlan) {
          return { step, outputVersion: null as ContentStudioOutputVersionRecord | null, session: null as ContentStudioSessionRecord | null };
        }

        const stepsAfter = (await txStore.listSessionSteps(input.scope.clientId, step.sessionId))
          .filter((row) => Number(row.revision) === step.revision);
        const aggregateCostUnits = stepsAfter.reduce((sum, row) => sum + Number(row.cost_units), 0);
        const aggregateDurationMs = stepsAfter.reduce((sum, row) => sum + Number(row.duration_ms), 0);
        const priorOutputs = await txStore.listSessionOutputs(input.scope.clientId, step.sessionId);
        const priorForSession = priorOutputs.length > 0 ? priorOutputs[priorOutputs.length - 1]! : null;
        // The artifact package source: the FINAL declared stage's
        // recorded output (order-independent finalization).
        const finalStageRowAfter = stepsAfter.find((row) => Number(row.stage_index) === format.processingStages.length)!;
        const artifactPackage = finalStageRowAfter.output as Record<string, unknown>;
        const outputRow = await txStore.insertOutputVersion({
          outputVersionId: txStore.newId(),
          sessionId: step.sessionId,
          revision: step.revision,
          scope: input.scope,
          artifactPackage,
          parentOutputVersionId: priorForSession === null ? null : priorForSession.output_version_id,
          aggregateCostUnits,
          aggregateDurationMs,
        });
        const outputVersion = mapOutputRow(outputRow);
        await appendEvent(txStore, {
          scope: input.scope,
          sessionId: step.sessionId,
          revision: step.revision,
          eventKind: 'output_version_recorded',
          payload: {
            outputVersionId: outputVersion.outputVersionId,
            parentOutputVersionId: outputVersion.parentOutputVersionId,
            aggregateCostUnits: outputVersion.aggregateCostUnits,
            aggregateDurationMs: outputVersion.aggregateDurationMs,
            requiredOutputs: request.content.output.requiredOutputs,
          },
        });

        // The guarded processing → review advance (the pure table edge +
        // the runtime guards — satisfied by construction here).
        assertLegalContentStudioSessionTransition(session.state, 'review');
        const advancedRow = await txStore.advanceSessionState({
          clientId: input.scope.clientId,
          sessionId: session.sessionId,
          revision: session.revision,
          to: 'review',
          terminalReason: null,
        });
        if (advancedRow === null) {
          throw new NotFoundError('studio session', session.sessionId);
        }
        await appendEvent(txStore, {
          scope: input.scope,
          sessionId: session.sessionId,
          revision: session.revision,
          eventKind: 'state_advanced',
          payload: { from: session.state, to: 'review', terminalReason: null },
        });
        return { step, outputVersion, session: mapSessionRow(advancedRow) };
      });
      return completed;
    },

    async failProcessingStep(input: FailContentStudioProcessingStepInput) {
      assertValidContentStudioScope(input.scope);
      assertUuidShape('studio processing step', input.stepId);
      if (input.failureDetail !== undefined && input.failureDetail !== null && (typeof input.failureDetail !== 'string' || input.failureDetail.length > 512)) {
        throw new InvalidRequestError('failureDetail must be a string of at most 512 chars');
      }
      const stepRow = await store.findStep(input.scope.clientId, input.stepId);
      if (stepRow === null) {
        throw new NotFoundError('studio processing step', input.stepId);
      }
      if (stepRow.status !== 'running') {
        throw new InvalidRequestError(`studio processing step ${input.stepId} is ${stepRow.status} — only a running (claimed) step may fail`);
      }
      const failedRow = await store.failStep(input.stepId, input.failureReason, input.failureDetail ?? null);
      if (failedRow === null) {
        throw new InvalidRequestError(`studio processing step ${input.stepId} could not fail (it is no longer running)`);
      }
      const step = mapStepRow(failedRow);
      await appendEvent(store, {
        scope: input.scope,
        sessionId: step.sessionId,
        revision: step.revision,
        eventKind: 'step_failed',
        payload: { stepId: step.stepId, stageId: step.stageId, failureReason: step.failureReason, failureDetail: step.failureDetail },
      });
      return step;
    },

    async requeueProcessingStep(input: RequeueContentStudioProcessingStepInput) {
      assertValidContentStudioScope(input.scope);
      assertUuidShape('studio processing step', input.stepId);
      const stepRow = await store.findStep(input.scope.clientId, input.stepId);
      if (stepRow === null) {
        throw new NotFoundError('studio processing step', input.stepId);
      }
      if (stepRow.status !== 'failed') {
        throw new InvalidRequestError(`studio processing step ${input.stepId} is ${stepRow.status} — only a failed step may be requeued (the explicit caller retry)`);
      }
      // §17: the economic choice to retry is the CALLER's; the runtime
      // enforces the declared stopping policy bound (the honest limit).
      const session = await requireLatestSession(input.scope, stepRow.session_id as string);
      const request = await requireRequestVersion(input.scope, session.requestId, session.requestVersion);
      const retryLimit = request.content.delayStoppingPolicy.retryLimit;
      if (Number(stepRow.attempts) > retryLimit) {
        throw new InvalidRequestError(
          `studio processing step ${input.stepId} has been claimed ${Number(stepRow.attempts)} times — the request's stopping policy allows at most ${retryLimit} retries`,
        );
      }
      const requeuedRow = await store.requeueStep(input.stepId);
      if (requeuedRow === null) {
        throw new InvalidRequestError(`studio processing step ${input.stepId} could not be requeued (it is no longer failed)`);
      }
      const step = mapStepRow(requeuedRow);
      await appendEvent(store, {
        scope: input.scope,
        sessionId: step.sessionId,
        revision: step.revision,
        eventKind: 'step_requeued',
        payload: { stepId: step.stepId, stageId: step.stageId, attempts: step.attempts },
      });
      return step;
    },

    // --- The §12 output versions (immutable) ---

    async getSessionOutputs(scope, sessionId) {
      assertValidContentStudioScope(scope);
      assertUuidShape('studio session', sessionId);
      await requireLatestSession(scope, sessionId);
      const rows = await store.listSessionOutputs(scope.clientId, sessionId);
      return rows.map(mapOutputRow);
    },

    async getOutputVersion(scope, outputVersionId) {
      assertValidContentStudioScope(scope);
      assertUuidShape('studio output version', outputVersionId);
      const row = await store.findOutputVersion(scope.clientId, outputVersionId);
      if (row === null) {
        throw new NotFoundError('studio output version', outputVersionId);
      }
      return mapOutputRow(row);
    },

    // --- The §13 structured treatment loop ---

    async requestTreatment(input: RequestContentStudioTreatmentInput): Promise<ContentStudioTreatmentResult> {
      assertValidContentStudioScope(input.scope);
      assertUuidShape('studio session', input.sessionId);
      assertUuidShape('studio output version', input.targetOutputVersionId);
      assertValidContentStudioTreatmentSpecification(input.treatment);

      const session = await requireLatestSession(input.scope, input.sessionId);
      if (session.state !== 'review') {
        throw new InvalidRequestError(
          `studio session ${input.sessionId}#r${session.revision} is ${session.state} — a treatment request targets a revision in review`,
        );
      }

      // The target output must belong to THIS revision.
      const outputRow = await store.findOutputVersion(input.scope.clientId, input.targetOutputVersionId);
      if (outputRow === null) {
        throw new NotFoundError('studio output version', input.targetOutputVersionId);
      }
      if (outputRow.session_id !== session.sessionId || Number(outputRow.revision) !== session.revision) {
        throw new InvalidRequestError(
          `studio output version ${input.targetOutputVersionId} does not belong to session ${input.sessionId}#r${session.revision}`,
        );
      }

      // The §4 no-silent-replacement fence: an alternate organization
      // REQUIRES a revised request version binding it VERBATIM (the
      // versioned explicit selection — lock v1.7 #39).
      if (input.revisedRequest !== undefined && input.revisedRequest !== null) {
        assertValidContentStudioProductionRequestContent(input.revisedRequest);
      }
      if (input.treatment.alternateOrganization !== undefined && input.treatment.alternateOrganization !== null) {
        if (input.revisedRequest === undefined || input.revisedRequest === null) {
          throw new InvalidRequestError(
            'the treatment declares an alternate organization — a revisedRequest binding it VERBATIM is required (the §4 no-silent-replacement fence)',
          );
        }
        // VERBATIM means the FULL declaration — identity, version, the
        // cited body references AND the capabilities — never a
        // same-id-different-bodies substitution.
        const declared = JSON.stringify(input.treatment.alternateOrganization);
        const bound = JSON.stringify(input.revisedRequest.organization);
        if (declared !== bound) {
          throw new InvalidRequestError(
            `the revised request must bind the treatment's alternate organization VERBATIM (found '${input.revisedRequest.organization.organizationId}@v${input.revisedRequest.organization.organizationVersion}' citing different bodies/capabilities than the treatment declares)`,
          );
        }
      }

      // The successor's request version + validated organization (the
      // §4 compatibility validation runs BEFORE the transactional split
      // so the port resolution never rides inside the row locks).
      let successorRequestVersion = session.requestVersion;
      if (input.revisedRequest !== undefined && input.revisedRequest !== null) {
        const latestRequest = await requireRequestVersion(input.scope, session.requestId);
        successorRequestVersion = latestRequest.requestVersion + 1;
      }
      const successorRequestRow =
        input.revisedRequest === undefined || input.revisedRequest === null
          ? await store.findRequestVersion(input.scope.clientId, session.requestId, session.requestVersion)
          : null;
      let successorContent: ContentStudioProductionRequestContent;
      if (input.revisedRequest !== undefined && input.revisedRequest !== null) {
        successorContent = input.revisedRequest;
      } else if (successorRequestRow !== null) {
        successorContent = successorRequestRow.content as ContentStudioProductionRequestContent;
      } else {
        throw new NotFoundError('studio production request', `${session.requestId}#v${session.requestVersion}`);
      }
      // The successor's format resolution: the SAME format identity as
      // the running session resolves under ANY lifecycle status (the
      // retirement-never-breaks-running-sessions discipline covers the
      // session's own treatment revisions); a REVISED request selecting a
      // DIFFERENT format resolves through the ACTIVE-only path (a new
      // selection is a new compatibility resolution).
      const successorFormat =
        successorContent.formatId === session.formatId && successorContent.formatVersion === session.formatVersion
          ? await requireSessionFormat(input.scope, session.formatId, session.formatVersion)
          : await requireActiveFormat(input.scope, successorContent.formatId, successorContent.formatVersion);
      const successorValidation = await validateOrganizationCompatibility(
        input.scope,
        successorFormat,
        successorContent.organization,
      );

      // §8 (STUDIO-003): the generated-input review gate on the successor
      // revision's request binding (a revised request selecting a
      // confirmation-requiring format with intent-mode input cites only
      // approved material; a fresh request version carries no chain yet —
      // the recording gate catches it later).
      const successorRequestBinding: ContentStudioProductionRequestRecord = {
        requestId: session.requestId,
        requestVersion: successorRequestVersion,
        // The successor record view the gate reads (the binding fields only).
        content: successorContent,
      } as ContentStudioProductionRequestRecord;
      await assertGeneratedInputReviewGate(input.scope, successorRequestBinding, successorFormat, { materialMustExist: false });

      const successorRevision = session.revision + 1;
      const result = await deps.db.transaction(async (tx) => {
        const txStore = new ContentStudioStore(tx, deps.clock, deps.ids);
        if (input.revisedRequest !== undefined && input.revisedRequest !== null) {
          await txStore.insertRequestVersion({
            requestId: session.requestId,
            requestVersion: successorRequestVersion,
            scope: input.scope,
            content: input.revisedRequest,
          });
        }

        const treatmentRow = await txStore.insertTreatmentRequest({
          treatmentId: txStore.newId(),
          sessionId: session.sessionId,
          revision: session.revision,
          targetOutputVersionId: input.targetOutputVersionId,
          scope: input.scope,
          specification: input.treatment,
          successorRevision,
        });
        const treatment = mapTreatmentRow(treatmentRow);

        // Close the reviewed revision (the ONLY sanctioned route into
        // treatment_requested).
        const closedRow = await txStore.advanceSessionState({
          clientId: input.scope.clientId,
          sessionId: session.sessionId,
          revision: session.revision,
          to: 'treatment_requested',
          terminalReason: null,
        });
        if (closedRow === null) {
          throw new NotFoundError('studio session', session.sessionId);
        }
        await appendEvent(txStore, {
          scope: input.scope,
          sessionId: session.sessionId,
          revision: session.revision,
          eventKind: 'treatment_requested',
          payload: {
            treatmentId: treatment.treatmentId,
            targetOutputVersionId: treatment.targetOutputVersionId,
            successorRevision,
            defect: input.treatment.defect,
          },
        });

        // Open the linked successor revision.
        const successorRow = await txStore.insertSessionRevision({
          sessionId: session.sessionId,
          revision: successorRevision,
          scope: input.scope,
          requestId: session.requestId,
          requestVersion: successorRequestVersion,
          format: { formatId: successorFormat.formatId, formatVersion: successorFormat.formatVersion },
          organization: successorContent.organization,
          organizationValidation: successorValidation,
          priorOutputVersionId: input.targetOutputVersionId,
          originTreatmentId: treatment.treatmentId,
        });
        await appendEvent(txStore, {
          scope: input.scope,
          sessionId: session.sessionId,
          revision: successorRevision,
          eventKind: 'session_opened',
          payload: {
            requestId: session.requestId,
            requestVersion: successorRequestVersion,
            entryMode: successorContent.entryMode,
            format: `${successorFormat.formatId}@v${successorFormat.formatVersion}`,
            priorOutputVersionId: input.targetOutputVersionId,
            originTreatmentId: treatment.treatmentId,
          },
        });

        return { treatment, closedRevision: mapSessionRow(closedRow), successorRevision: mapSessionRow(successorRow) };
      });
      return result;
    },

    async listTreatmentRequests(scope, sessionId) {
      assertValidContentStudioScope(scope);
      assertUuidShape('studio session', sessionId);
      await requireLatestSession(scope, sessionId);
      const rows = await store.listSessionTreatments(scope.clientId, sessionId);
      return rows.map(mapTreatmentRow);
    },

    // --- The §8 INTENT-TO-SCRIPT pipeline (STUDIO-003 — the intent
    // records, the versioned scripts/question graphs, the human review,
    // the conversation-graph hooks) ---

    async recordIntent(input: RecordContentStudioIntentInput): Promise<ContentStudioIntentRecord> {
      assertValidContentStudioScope(input.scope);
      if (input.requestVersion !== undefined && (typeof input.requestVersion !== 'number' || !Number.isSafeInteger(input.requestVersion) || input.requestVersion < 1)) {
        throw new InvalidRequestError('requestVersion must be a positive integer');
      }
      const request = await requireRequestVersion(input.scope, input.requestId, input.requestVersion);
      if (request.content.input.mode !== 'intent') {
        throw new InvalidRequestError(
          `studio intent records materialize the INTENT path only — request ${request.requestId}#v${request.requestVersion} carries input mode '${request.content.input.mode}' (the generation path requires mode 'intent')`,
        );
      }
      const existing = await store.findIntentForRequest(input.scope.clientId, request.requestId, request.requestVersion);
      if (existing !== null) {
        throw new InvalidRequestError(
          `request ${request.requestId}#v${request.requestVersion} already carries its intent record (${existing.intent_id}) — intents are immutable; resolve it through getIntentForRequest`,
        );
      }
      const row = await store.insertIntent({
        intentId: store.newId(),
        scope: input.scope,
        requestId: request.requestId,
        requestVersion: request.requestVersion,
        objective: request.content.input.intent as string,
        sourceReferences: request.content.input.sourceArtifactReferences ?? [],
      });
      return mapIntentRow(row);
    },

    async getIntent(scope, intentId) {
      assertValidContentStudioScope(scope);
      assertUuidShape('studio intent', intentId);
      const row = await store.findIntent(scope.clientId, intentId);
      if (row === null) {
        throw new NotFoundError('studio intent', intentId);
      }
      return mapIntentRow(row);
    },

    async getIntentForRequest(scope, requestId, requestVersion) {
      assertValidContentStudioScope(scope);
      if (requestVersion !== undefined && (typeof requestVersion !== 'number' || !Number.isSafeInteger(requestVersion) || requestVersion < 1)) {
        throw new InvalidRequestError('requestVersion must be a positive integer');
      }
      const request = await requireRequestVersion(scope, requestId, requestVersion);
      const row = await store.findIntentForRequest(scope.clientId, request.requestId, request.requestVersion);
      return row === null ? null : mapIntentRow(row);
    },

    async recordSuppliedScript(input: RecordContentStudioSuppliedScriptInput): Promise<ContentStudioScriptRecord> {
      assertValidContentStudioScope(input.scope);
      if (input.requestVersion !== undefined && (typeof input.requestVersion !== 'number' || !Number.isSafeInteger(input.requestVersion) || input.requestVersion < 1)) {
        throw new InvalidRequestError('requestVersion must be a positive integer');
      }
      const request = await requireRequestVersion(input.scope, input.requestId, input.requestVersion);
      if (request.content.input.mode !== 'script') {
        throw new InvalidRequestError(
          `studio supplied scripts materialize the SCRIPT path only — request ${request.requestId}#v${request.requestVersion} carries input mode '${request.content.input.mode}' (the supplied path requires mode 'script')`,
        );
      }
      const body = request.content.input.script as Readonly<Record<string, unknown>>;
      assertBoundedJsonPayload(body, 'the request\'s declared script');
      const existing = await store.findLatestScriptForRequest(input.scope.clientId, request.requestId, request.requestVersion);
      if (existing !== null) {
        throw new InvalidRequestError(
          `request ${request.requestId}#v${request.requestVersion} already carries its script chain (${existing.script_id}) — corrections append under the SAME chain id (appendSuppliedScriptVersion)`,
        );
      }
      const row = await store.insertScriptVersion({
        scriptId: store.newId(),
        scriptVersion: 1,
        scope: input.scope,
        requestId: request.requestId,
        requestVersion: request.requestVersion,
        origin: 'supplied',
        body,
      });
      return mapScriptRow(row);
    },

    async appendSuppliedScriptVersion(input: AppendContentStudioSuppliedScriptVersionInput): Promise<ContentStudioScriptRecord> {
      assertValidContentStudioScope(input.scope);
      assertUuidShape('studio script chain', input.scriptId);
      assertBoundedJsonPayload(input.body, 'body');
      const latest = await store.findLatestScriptVersion(input.scope.clientId, input.scriptId);
      if (latest === null) {
        throw new NotFoundError('studio script chain', input.scriptId);
      }
      if (latest.origin !== 'supplied') {
        throw new InvalidRequestError(
          `studio script chain ${input.scriptId} is '${latest.origin}' — generated chains regenerate through recordGeneratedScript (the generation path)`,
        );
      }
      const row = await store.insertScriptVersion({
        scriptId: input.scriptId,
        scriptVersion: Number(latest.script_version) + 1,
        scope: input.scope,
        requestId: latest.request_id,
        requestVersion: Number(latest.request_version),
        origin: 'supplied',
        body: input.body,
      });
      return mapScriptRow(row);
    },

    async recordGeneratedScript(input: RecordContentStudioGeneratedScriptInput): Promise<ContentStudioScriptRecord> {
      assertValidContentStudioScope(input.scope);
      if (input.requestVersion !== undefined && (typeof input.requestVersion !== 'number' || !Number.isSafeInteger(input.requestVersion) || input.requestVersion < 1)) {
        throw new InvalidRequestError('requestVersion must be a positive integer');
      }
      assertValidContentStudioGeneratorProvenance(input.generator);
      assertBoundedJsonPayload(input.body, 'body');
      const request = await requireRequestVersion(input.scope, input.requestId, input.requestVersion);
      if (request.content.input.mode !== 'intent') {
        throw new InvalidRequestError(
          `studio generated scripts materialize the INTENT path only — request ${request.requestId}#v${request.requestVersion} carries input mode '${request.content.input.mode}' (the generation path requires mode 'intent')`,
        );
      }
      assertUuidShape('studio intent', input.intentId);
      const intentRow = await store.findIntent(input.scope.clientId, input.intentId);
      if (intentRow === null) {
        throw new NotFoundError('studio intent', input.intentId);
      }
      if (intentRow.request_id !== request.requestId || Number(intentRow.request_version) !== request.requestVersion) {
        throw new InvalidRequestError(
          `studio intent ${input.intentId} does not belong to request ${request.requestId}#v${request.requestVersion} (found ${intentRow.request_id}#v${Number(intentRow.request_version)}) — the generation lineage must bind the SAME request version`,
        );
      }
      const latest = await store.findLatestScriptForRequest(input.scope.clientId, request.requestId, request.requestVersion);
      if (latest === null) {
        // The one-materialization fence (module-side honest error; the DB
        // trigger backstops): the intent path materializes EITHER a
        // script chain OR a question-graph chain.
        const graphExisting = await store.findLatestQuestionGraphForRequest(input.scope.clientId, request.requestId, request.requestVersion);
        if (graphExisting !== null) {
          throw new InvalidRequestError(
            `request ${request.requestId}#v${request.requestVersion} already carries its question-graph chain (${graphExisting.graph_id}) — the production input materializes as EITHER a script chain OR a question-graph chain (the §8 exactly-one input fence)`,
          );
        }
      }
      const row = await deps.db.transaction(async (tx) => {
        const txStore = new ContentStudioStore(tx, deps.clock, deps.ids);
        let scriptId = txStore.newId();
        let scriptVersion = 1;
        if (latest !== null) {
          scriptId = latest.script_id;
          scriptVersion = Number(latest.script_version) + 1;
          // The autonomous supersession of the prior version (the
          // decision rides the append-only review tail — the
          // decision-then-advance ordering the DB guard enforces).
          const priorState = latest.review_state;
          if (priorState !== null && priorState !== 'superseded') {
            await txStore.insertScriptReview({
              reviewId: txStore.newId(),
              scriptId,
              scriptVersion: Number(latest.script_version),
              scope: input.scope,
              verdict: 'superseded',
              reviewerKind: 'autonomous',
              reviewerActor: 'content-studio.generation',
              note: 'superseded by the regeneration recorded for the same request version',
            });
            const advanced = await txStore.advanceScriptReviewState({
              clientId: input.scope.clientId,
              scriptId,
              scriptVersion: Number(latest.script_version),
              from: priorState as ContentStudioReviewState,
              to: 'superseded',
            });
            if (advanced === null) {
              throw new InvalidRequestError(`studio script ${scriptId}#v${Number(latest.script_version)} could not be superseded (it moved on) — re-read the chain`);
            }
          }
        }
        return txStore.insertScriptVersion({
          scriptId,
          scriptVersion,
          scope: input.scope,
          requestId: request.requestId,
          requestVersion: request.requestVersion,
          origin: 'generated',
          body: input.body,
          intentId: input.intentId,
          generator: input.generator,
        });
      });
      return mapScriptRow(row);
    },

    async reviewScript(input: ReviewContentStudioScriptInput): Promise<ContentStudioScriptReviewResult> {
      assertValidContentStudioScope(input.scope);
      assertUuidShape('studio script chain', input.scriptId);
      if (typeof input.scriptVersion !== 'number' || !Number.isSafeInteger(input.scriptVersion) || input.scriptVersion < 1 || input.scriptVersion > 1000) {
        throw new InvalidRequestError('scriptVersion must be an integer 1-1000');
      }
      assertValidContentStudioReviewDecision(input);
      const scriptRow = await store.findScriptVersion(input.scope.clientId, input.scriptId, input.scriptVersion);
      if (scriptRow === null) {
        throw new NotFoundError('studio script version', `${input.scriptId}#v${input.scriptVersion}`);
      }
      if (scriptRow.origin !== 'generated') {
        throw new InvalidRequestError(
          `studio script ${input.scriptId}#v${input.scriptVersion} is '${scriptRow.origin}' — reviews target GENERATED script versions only (supplied scripts are user-authored: their own authority)`,
        );
      }
      const currentState = scriptRow.review_state as ContentStudioReviewState;
      const legal =
        (currentState === 'pending' && ['approved', 'rejected', 'superseded'].includes(input.verdict)) ||
        (['approved', 'rejected'].includes(currentState) && input.verdict === 'superseded');
      if (!legal) {
        throw new InvalidRequestError(
          `studio script ${input.scriptId}#v${input.scriptVersion} review verdict '${input.verdict}' is not legal from its current state '${currentState}' (born pending; pending → approved | rejected | superseded; approved | rejected → superseded; no resurrection)`,
        );
      }
      return deps.db.transaction(async (tx) => {
        const txStore = new ContentStudioStore(tx, deps.clock, deps.ids);
        const decisionRow = await txStore.insertScriptReview({
          reviewId: txStore.newId(),
          scriptId: input.scriptId,
          scriptVersion: input.scriptVersion,
          scope: input.scope,
          verdict: input.verdict,
          reviewerKind: input.reviewerKind,
          reviewerActor: input.reviewerActor,
          note: input.note ?? null,
        });
        const advancedRow = await txStore.advanceScriptReviewState({
          clientId: input.scope.clientId,
          scriptId: input.scriptId,
          scriptVersion: input.scriptVersion,
          from: currentState,
          to: input.verdict,
        });
        if (advancedRow === null) {
          throw new InvalidRequestError(`studio script ${input.scriptId}#v${input.scriptVersion} moved on — re-read its review state`);
        }
        return { decision: mapScriptReviewRow(decisionRow), script: mapScriptRow(advancedRow) };
      });
    },

    async getScript(scope, scriptId, scriptVersion) {
      assertValidContentStudioScope(scope);
      assertUuidShape('studio script chain', scriptId);
      if (scriptVersion !== undefined && (typeof scriptVersion !== 'number' || !Number.isSafeInteger(scriptVersion) || scriptVersion < 1)) {
        throw new InvalidRequestError('scriptVersion must be a positive integer');
      }
      const row =
        scriptVersion === undefined
          ? await store.findLatestScriptVersion(scope.clientId, scriptId)
          : await store.findScriptVersion(scope.clientId, scriptId, scriptVersion);
      if (row === null) {
        throw new NotFoundError('studio script version', scriptVersion === undefined ? scriptId : `${scriptId}#v${scriptVersion}`);
      }
      return mapScriptRow(row);
    },

    async listScriptVersions(scope, scriptId) {
      assertValidContentStudioScope(scope);
      assertUuidShape('studio script chain', scriptId);
      const rows = await store.listScriptVersions(scope.clientId, scriptId);
      if (rows.length < 1) {
        throw new NotFoundError('studio script chain', scriptId);
      }
      return rows.map(mapScriptRow);
    },

    async getScriptForRequest(scope, requestId, requestVersion) {
      assertValidContentStudioScope(scope);
      if (requestVersion !== undefined && (typeof requestVersion !== 'number' || !Number.isSafeInteger(requestVersion) || requestVersion < 1)) {
        throw new InvalidRequestError('requestVersion must be a positive integer');
      }
      const request = await requireRequestVersion(scope, requestId, requestVersion);
      const row = await store.findLatestScriptForRequest(scope.clientId, request.requestId, request.requestVersion);
      return row === null ? null : mapScriptRow(row);
    },

    async listScriptReviews(scope, scriptId) {
      assertValidContentStudioScope(scope);
      assertUuidShape('studio script chain', scriptId);
      await store.findLatestScriptVersion(scope.clientId, scriptId).then((row) => {
        if (row === null) {
          throw new NotFoundError('studio script chain', scriptId);
        }
      });
      const rows = await store.listScriptReviews(scope.clientId, scriptId);
      return rows.map(mapScriptReviewRow);
    },

    async recordSuppliedQuestionGraph(input: RecordContentStudioSuppliedQuestionGraphInput): Promise<ContentStudioQuestionGraphRecord> {
      assertValidContentStudioScope(input.scope);
      if (input.requestVersion !== undefined && (typeof input.requestVersion !== 'number' || !Number.isSafeInteger(input.requestVersion) || input.requestVersion < 1)) {
        throw new InvalidRequestError('requestVersion must be a positive integer');
      }
      const request = await requireRequestVersion(input.scope, input.requestId, input.requestVersion);
      if (request.content.input.mode !== 'question_list') {
        throw new InvalidRequestError(
          `studio supplied question graphs materialize the QUESTION-LIST path only — request ${request.requestId}#v${request.requestVersion} carries input mode '${request.content.input.mode}' (the supplied path requires mode 'question_list')`,
        );
      }
      const questions = request.content.input.questions as ReadonlyArray<string>;
      const declaredGraph = deriveLinearQuestionGraph(questions);
      const existing = await store.findLatestQuestionGraphForRequest(input.scope.clientId, request.requestId, request.requestVersion);
      if (existing !== null) {
        throw new InvalidRequestError(
          `request ${request.requestId}#v${request.requestVersion} already carries its question-graph chain (${existing.graph_id}) — corrections append under the SAME chain id (appendSuppliedQuestionGraphVersion)`,
        );
      }
      const row = await store.insertQuestionGraphVersion({
        graphId: store.newId(),
        graphVersion: 1,
        scope: input.scope,
        requestId: request.requestId,
        requestVersion: request.requestVersion,
        origin: 'supplied',
        declaredGraph,
      });
      return mapQuestionGraphRow(row);
    },

    async appendSuppliedQuestionGraphVersion(input: AppendContentStudioSuppliedQuestionGraphVersionInput): Promise<ContentStudioQuestionGraphRecord> {
      assertValidContentStudioScope(input.scope);
      assertUuidShape('studio question graph chain', input.graphId);
      assertValidContentStudioDeclaredQuestionGraph(input.declaredGraph);
      const latest = await store.findLatestQuestionGraphVersion(input.scope.clientId, input.graphId);
      if (latest === null) {
        throw new NotFoundError('studio question graph chain', input.graphId);
      }
      if (latest.origin !== 'supplied') {
        throw new InvalidRequestError(
          `studio question graph chain ${input.graphId} is '${latest.origin}' — generated chains regenerate through recordGeneratedQuestionGraph (the generation path)`,
        );
      }
      const row = await store.insertQuestionGraphVersion({
        graphId: input.graphId,
        graphVersion: Number(latest.graph_version) + 1,
        scope: input.scope,
        requestId: latest.request_id,
        requestVersion: Number(latest.request_version),
        origin: 'supplied',
        declaredGraph: input.declaredGraph,
      });
      return mapQuestionGraphRow(row);
    },

    async recordGeneratedQuestionGraph(input: RecordContentStudioGeneratedQuestionGraphInput): Promise<ContentStudioQuestionGraphRecord> {
      assertValidContentStudioScope(input.scope);
      if (input.requestVersion !== undefined && (typeof input.requestVersion !== 'number' || !Number.isSafeInteger(input.requestVersion) || input.requestVersion < 1)) {
        throw new InvalidRequestError('requestVersion must be a positive integer');
      }
      assertValidContentStudioGeneratorProvenance(input.generator);
      assertValidContentStudioDeclaredQuestionGraph(input.declaredGraph);
      const request = await requireRequestVersion(input.scope, input.requestId, input.requestVersion);
      if (request.content.input.mode !== 'intent') {
        throw new InvalidRequestError(
          `studio generated question graphs materialize the INTENT path only — request ${request.requestId}#v${request.requestVersion} carries input mode '${request.content.input.mode}' (the generation path requires mode 'intent')`,
        );
      }
      assertUuidShape('studio intent', input.intentId);
      const intentRow = await store.findIntent(input.scope.clientId, input.intentId);
      if (intentRow === null) {
        throw new NotFoundError('studio intent', input.intentId);
      }
      if (intentRow.request_id !== request.requestId || Number(intentRow.request_version) !== request.requestVersion) {
        throw new InvalidRequestError(
          `studio intent ${input.intentId} does not belong to request ${request.requestId}#v${request.requestVersion} (found ${intentRow.request_id}#v${Number(intentRow.request_version)}) — the generation lineage must bind the SAME request version`,
        );
      }
      const latest = await store.findLatestQuestionGraphForRequest(input.scope.clientId, request.requestId, request.requestVersion);
      if (latest === null) {
        const scriptExisting = await store.findLatestScriptForRequest(input.scope.clientId, request.requestId, request.requestVersion);
        if (scriptExisting !== null) {
          throw new InvalidRequestError(
            `request ${request.requestId}#v${request.requestVersion} already carries its script chain (${scriptExisting.script_id}) — the production input materializes as EITHER a script chain OR a question-graph chain (the §8 exactly-one input fence)`,
          );
        }
      }
      const row = await deps.db.transaction(async (tx) => {
        const txStore = new ContentStudioStore(tx, deps.clock, deps.ids);
        let graphId = txStore.newId();
        let graphVersion = 1;
        if (latest !== null) {
          graphId = latest.graph_id;
          graphVersion = Number(latest.graph_version) + 1;
          const priorState = latest.review_state;
          if (priorState !== null && priorState !== 'superseded') {
            await txStore.insertQuestionGraphReview({
              reviewId: txStore.newId(),
              graphId,
              graphVersion: Number(latest.graph_version),
              scope: input.scope,
              verdict: 'superseded',
              reviewerKind: 'autonomous',
              reviewerActor: 'content-studio.generation',
              note: 'superseded by the regeneration recorded for the same request version',
            });
            const advanced = await txStore.advanceQuestionGraphReviewState({
              clientId: input.scope.clientId,
              graphId,
              graphVersion: Number(latest.graph_version),
              from: priorState as ContentStudioReviewState,
              to: 'superseded',
            });
            if (advanced === null) {
              throw new InvalidRequestError(`studio question graph ${graphId}#v${Number(latest.graph_version)} could not be superseded (it moved on) — re-read the chain`);
            }
          }
        }
        return txStore.insertQuestionGraphVersion({
          graphId,
          graphVersion,
          scope: input.scope,
          requestId: request.requestId,
          requestVersion: request.requestVersion,
          origin: 'generated',
          declaredGraph: input.declaredGraph,
          intentId: input.intentId,
          generator: input.generator,
        });
      });
      return mapQuestionGraphRow(row);
    },

    async reviewQuestionGraph(input: ReviewContentStudioQuestionGraphInput): Promise<ContentStudioQuestionGraphReviewResult> {
      assertValidContentStudioScope(input.scope);
      assertUuidShape('studio question graph chain', input.graphId);
      if (typeof input.graphVersion !== 'number' || !Number.isSafeInteger(input.graphVersion) || input.graphVersion < 1 || input.graphVersion > 1000) {
        throw new InvalidRequestError('graphVersion must be an integer 1-1000');
      }
      assertValidContentStudioReviewDecision(input);
      const graphRow = await store.findQuestionGraphVersion(input.scope.clientId, input.graphId, input.graphVersion);
      if (graphRow === null) {
        throw new NotFoundError('studio question graph version', `${input.graphId}#v${input.graphVersion}`);
      }
      if (graphRow.origin !== 'generated') {
        throw new InvalidRequestError(
          `studio question graph ${input.graphId}#v${input.graphVersion} is '${graphRow.origin}' — reviews target GENERATED graph versions only (supplied graphs are user-authored: their own authority)`,
        );
      }
      const currentState = graphRow.review_state as ContentStudioReviewState;
      const legal =
        (currentState === 'pending' && ['approved', 'rejected', 'superseded'].includes(input.verdict)) ||
        (['approved', 'rejected'].includes(currentState) && input.verdict === 'superseded');
      if (!legal) {
        throw new InvalidRequestError(
          `studio question graph ${input.graphId}#v${input.graphVersion} review verdict '${input.verdict}' is not legal from its current state '${currentState}' (born pending; pending → approved | rejected | superseded; approved | rejected → superseded; no resurrection)`,
        );
      }
      return deps.db.transaction(async (tx) => {
        const txStore = new ContentStudioStore(tx, deps.clock, deps.ids);
        const decisionRow = await txStore.insertQuestionGraphReview({
          reviewId: txStore.newId(),
          graphId: input.graphId,
          graphVersion: input.graphVersion,
          scope: input.scope,
          verdict: input.verdict,
          reviewerKind: input.reviewerKind,
          reviewerActor: input.reviewerActor,
          note: input.note ?? null,
        });
        const advancedRow = await txStore.advanceQuestionGraphReviewState({
          clientId: input.scope.clientId,
          graphId: input.graphId,
          graphVersion: input.graphVersion,
          from: currentState,
          to: input.verdict,
        });
        if (advancedRow === null) {
          throw new InvalidRequestError(`studio question graph ${input.graphId}#v${input.graphVersion} moved on — re-read its review state`);
        }
        return { decision: mapQuestionGraphReviewRow(decisionRow), graph: mapQuestionGraphRow(advancedRow) };
      });
    },

    async getQuestionGraph(scope, graphId, graphVersion) {
      assertValidContentStudioScope(scope);
      assertUuidShape('studio question graph chain', graphId);
      if (graphVersion !== undefined && (typeof graphVersion !== 'number' || !Number.isSafeInteger(graphVersion) || graphVersion < 1)) {
        throw new InvalidRequestError('graphVersion must be a positive integer');
      }
      const row =
        graphVersion === undefined
          ? await store.findLatestQuestionGraphVersion(scope.clientId, graphId)
          : await store.findQuestionGraphVersion(scope.clientId, graphId, graphVersion);
      if (row === null) {
        throw new NotFoundError('studio question graph version', graphVersion === undefined ? graphId : `${graphId}#v${graphVersion}`);
      }
      return mapQuestionGraphRow(row);
    },

    async listQuestionGraphVersions(scope, graphId) {
      assertValidContentStudioScope(scope);
      assertUuidShape('studio question graph chain', graphId);
      const rows = await store.listQuestionGraphVersions(scope.clientId, graphId);
      if (rows.length < 1) {
        throw new NotFoundError('studio question graph chain', graphId);
      }
      return rows.map(mapQuestionGraphRow);
    },

    async getQuestionGraphForRequest(scope, requestId, requestVersion) {
      assertValidContentStudioScope(scope);
      if (requestVersion !== undefined && (typeof requestVersion !== 'number' || !Number.isSafeInteger(requestVersion) || requestVersion < 1)) {
        throw new InvalidRequestError('requestVersion must be a positive integer');
      }
      const request = await requireRequestVersion(scope, requestId, requestVersion);
      const row = await store.findLatestQuestionGraphForRequest(scope.clientId, request.requestId, request.requestVersion);
      return row === null ? null : mapQuestionGraphRow(row);
    },

    async listQuestionGraphReviews(scope, graphId) {
      assertValidContentStudioScope(scope);
      assertUuidShape('studio question graph chain', graphId);
      const latest = await store.findLatestQuestionGraphVersion(scope.clientId, graphId);
      if (latest === null) {
        throw new NotFoundError('studio question graph chain', graphId);
      }
      const rows = await store.listQuestionGraphReviews(scope.clientId, graphId);
      return rows.map(mapQuestionGraphReviewRow);
    },

    async recordConversationStep(input: RecordContentStudioConversationStepInput): Promise<ContentStudioConversationStepRecord> {
      assertValidContentStudioScope(input.scope);
      assertValidContentStudioConversationChoice(input);
      assertUuidShape('studio session', input.sessionId);
      const session = await requireLatestSession(input.scope, input.sessionId);
      if (isTerminalContentStudioSessionState(session.state)) {
        throw new InvalidRequestError(
          `studio session ${input.sessionId}#r${session.revision} is ${session.state} — a terminal revision cannot grow a conversation (the resulting conversation graph is preserved as data)`,
        );
      }

      // The declared graph this conversation walks: the question-graph
      // chain bound to the session's EXACT request version (supplied or
      // generated — both walk).
      const graphRow = await store.findLatestQuestionGraphForRequest(input.scope.clientId, session.requestId, session.requestVersion);
      if (graphRow === null) {
        throw new InvalidRequestError(
          `studio session ${input.sessionId}#r${session.revision} has no declared question graph for request ${session.requestId}#v${session.requestVersion} — the conversation walks a declared question/branch graph`,
        );
      }

      let conversationId: string;
      let seq: number;
      let walkedGraphRow: QuestionGraphRow = graphRow;
      if (input.conversationId !== undefined && input.conversationId !== null) {
        assertUuidShape('studio conversation', input.conversationId);
        const convSteps = await store.listConversationEdges(input.scope.clientId, input.conversationId);
        if (convSteps.length < 1) {
          throw new NotFoundError('studio conversation', input.conversationId);
        }
        const first = convSteps[0]!;
        if (first.session_id !== session.sessionId || Number(first.revision) !== session.revision) {
          throw new InvalidRequestError(
            `studio conversation ${input.conversationId} belongs to session ${first.session_id}#r${Number(first.revision)} — a conversation is bound to one session revision (open a NEW conversation)`,
          );
        }
        // The conversation's walked graph version is pinned at its first
        // step (a mid-conversation graph correction never re-aims a
        // running conversation — a NEW conversation walks the corrected
        // version).
        walkedGraphRow =
          (await store.findQuestionGraphVersion(input.scope.clientId, first.graph_id, Number(first.graph_version))) ?? graphRow;
        const prior = convSteps[convSteps.length - 1]!;
        if (prior.chosen_to_question_id === null) {
          throw new InvalidRequestError(
            `studio conversation ${input.conversationId} ended at seq ${Number(prior.seq)} (no follow-up was chosen) — a follow-up-less conversation cannot grow (open a NEW conversation)`,
          );
        }
        if (prior.chosen_to_question_id !== input.questionId) {
          throw new InvalidRequestError(
            `studio conversation ${input.conversationId} step ${Number(prior.seq) + 1} must ask the prior step's chosen follow-up '${prior.chosen_to_question_id}' (found '${input.questionId}') — the conversation is a connected walk`,
          );
        }
        conversationId = input.conversationId;
        seq = Number(prior.seq) + 1;
      } else {
        conversationId = store.newId();
        seq = 1;
        if (graphRow.declared_graph && (graphRow.declared_graph as ContentStudioDeclaredQuestionGraph).entryQuestionId !== input.questionId) {
          throw new InvalidRequestError(
            `studio conversation step 1 must ask the declared entry question '${(graphRow.declared_graph as ContentStudioDeclaredQuestionGraph).entryQuestionId}' (found '${input.questionId}')`,
          );
        }
      }
      if (seq > 1024) {
        throw new InvalidRequestError('studio conversation steps are bounded at 1024 per conversation — open a NEW conversation');
      }

      // The deterministic-adjacency validation against the WALKED
      // declared graph (the module-side mirror of the DB trigger).
      const declaredGraph = walkedGraphRow.declared_graph as ContentStudioDeclaredQuestionGraph;
      if (!declaredGraph.nodes.some((node) => node.questionId === input.questionId)) {
        throw new InvalidRequestError(
          `studio conversation question '${input.questionId}' is not a declared node of the walked graph ${walkedGraphRow.graph_id}#v${Number(walkedGraphRow.graph_version)}`,
        );
      }
      if (input.chosenToQuestionId !== undefined && input.chosenToQuestionId !== null) {
        const declared = declaredGraph.edges.some(
          (edge) =>
            edge.fromQuestionId === input.questionId &&
            edge.toQuestionId === input.chosenToQuestionId &&
            edge.condition === input.chosenCondition,
        );
        if (!declared) {
          throw new InvalidRequestError(
            `studio conversation chosen follow-up ('${input.questionId}' → '${input.chosenToQuestionId}' under '${String(input.chosenCondition)}') is not a DECLARED edge of the walked graph ${walkedGraphRow.graph_id}#v${Number(walkedGraphRow.graph_version)} — the choice lands only inside the declared question/branch graph`,
          );
        }
      }

      const row = await store.insertConversationEdge({
        conversationId,
        sessionId: session.sessionId,
        revision: session.revision,
        scope: input.scope,
        seq,
        graphId: walkedGraphRow.graph_id,
        graphVersion: Number(walkedGraphRow.graph_version),
        questionId: input.questionId,
        answerReference: input.answerReference,
        answerKind: input.answerKind,
        chosenToQuestionId: input.chosenToQuestionId ?? null,
        chosenCondition: input.chosenCondition ?? null,
        chooserKind: input.chooserKind,
      });
      return mapConversationEdgeRow(row);
    },

    async listConversationSteps(scope, sessionId) {
      assertValidContentStudioScope(scope);
      assertUuidShape('studio session', sessionId);
      await requireLatestSession(scope, sessionId);
      const rows = await store.listSessionConversationEdges(scope.clientId, sessionId);
      return rows.map(mapConversationEdgeRow);
    },

    // --- The §9 CAPTURE RECORDS (STUDIO-007 — the audio/video capture layer) ---

    async openCaptureSession(input: OpenContentStudioCaptureSessionInput): Promise<ContentStudioCaptureSessionRecord> {
      assertValidContentStudioScope(input.scope);
      assertValidContentStudioCaptureSessionInput(input);
      assertUuidShape('studio session', input.sessionId);
      const session = await requireLatestSession(input.scope, input.sessionId);
      if (session.state !== 'recording') {
        throw new InvalidRequestError(
          `studio session ${input.sessionId}#r${session.revision} is ${session.state} — a capture session opens only inside the 'recording' state (§5: the capture state)`,
        );
      }
      const format = await requireSessionFormat(input.scope, session.formatId, session.formatVersion);

      // The interviewer representation of the recording context: the
      // format's declared interviewer requirements decide (§6 — the
      // reaction shape has none; the podcast shapes declare their
      // representation set).
      const representation = input.interviewerRepresentation ?? null;
      if (format.interviewerRequirements.interviewer === 'none') {
        if (representation !== null) {
          throw new InvalidRequestError(
            `studio session ${input.sessionId}#r${session.revision} runs format '${format.formatId}@v${format.formatVersion}' which declares interviewer 'none' — the recording context carries no interviewer representation`,
          );
        }
      } else {
        const declaredRepresentations = format.interviewerRequirements.representations ?? [];
        if (representation === null) {
          throw new InvalidRequestError(
            `studio session ${input.sessionId}#r${session.revision} runs format '${format.formatId}@v${format.formatVersion}' which requires an interviewer representation — the recording context declares one of: ${declaredRepresentations.join(', ')}`,
          );
        }
        if (!declaredRepresentations.includes(representation)) {
          throw new InvalidRequestError(
            `interviewer representation '${representation}' is not declared by format '${format.formatId}@v${format.formatVersion}' (declared: ${declaredRepresentations.join(', ')}) — the recording context stays inside the format's declaration`,
          );
        }
      }

      // The walked-graph pin: a graph_walk capture session pins the
      // declared question-graph version bound to the session's EXACT
      // request version (the conversation-walk binding — the STUDIO-003
      // adaptive-interviewer graph drives the capture steps).
      let graphId: string | null = null;
      let graphVersion: number | null = null;
      if (input.captureMode === 'graph_walk') {
        const graphRow = await store.findLatestQuestionGraphForRequest(input.scope.clientId, session.requestId, session.requestVersion);
        if (graphRow === null) {
          throw new InvalidRequestError(
            `studio session ${input.sessionId}#r${session.revision} has no declared question graph for request ${session.requestId}#v${session.requestVersion} — a graph_walk capture session pins the walked question/branch graph`,
          );
        }
        graphId = graphRow.graph_id;
        graphVersion = Number(graphRow.graph_version);
      }

      const row = await store.insertCaptureSession({
        captureSessionId: store.newId(),
        sessionId: session.sessionId,
        revision: session.revision,
        scope: input.scope,
        captureMode: input.captureMode,
        graphId,
        graphVersion,
        interviewerRepresentation: representation,
      });
      return mapCaptureSessionRow(row);
    },

    async getCaptureSession(scope, sessionId, captureSessionId) {
      assertValidContentStudioScope(scope);
      assertUuidShape('studio session', sessionId);
      await requireLatestSession(scope, sessionId);
      assertUuidShape('studio capture session', captureSessionId);
      const row = await store.findCaptureSession(scope.clientId, captureSessionId);
      if (row === null || row.session_id !== sessionId) {
        throw new NotFoundError('studio capture session', captureSessionId);
      }
      return mapCaptureSessionRow(row);
    },

    async listCaptureSessions(scope, sessionId) {
      assertValidContentStudioScope(scope);
      assertUuidShape('studio session', sessionId);
      await requireLatestSession(scope, sessionId);
      const rows = await store.listCaptureSessions(scope.clientId, sessionId);
      return rows.map(mapCaptureSessionRow);
    },

    async recordCaptureTake(input: RecordContentStudioCaptureTakeInput): Promise<ContentStudioCaptureTakeRecord> {
      assertValidContentStudioScope(input.scope);
      assertValidContentStudioCaptureTakeInput(input);
      assertUuidShape('studio capture session', input.captureSessionId);
      const captureRow = await store.findCaptureSession(input.scope.clientId, input.captureSessionId);
      if (captureRow === null) {
        throw new NotFoundError('studio capture session', input.captureSessionId);
      }
      const session = await requireLatestSession(input.scope, captureRow.session_id);
      if (Number(captureRow.revision) !== session.revision) {
        throw new InvalidRequestError(
          `studio capture session ${input.captureSessionId} belongs to revision ${Number(captureRow.revision)} of session ${captureRow.session_id} (the current revision is ${session.revision}) — takes are recorded against the CURRENT revision's capture sessions (open a NEW capture session)`,
        );
      }
      if (session.state !== 'recording') {
        throw new InvalidRequestError(
          `studio session ${session.sessionId}#r${session.revision} is ${session.state} — raw takes are recorded only inside the 'recording' state (§5: the capture state)`,
        );
      }
      const format = await requireSessionFormat(input.scope, session.formatId, session.formatVersion);

      // THE APPROVED-CAPTURE FENCE (§2): the take's modality must be one
      // the session's format DECLARED in its capture requirements.
      if (!format.captureRequirements.modalities.includes(input.modality)) {
        throw new InvalidRequestError(
          `take modality '${input.modality}' is not declared by format '${format.formatId}@v${format.formatVersion}' (declared: ${format.captureRequirements.modalities.join(', ')}) — capture lands only inside the format's approved modalities`,
        );
      }

      // THE PARTICIPANT-GRANT FENCE (§7): a format declaring explicit
      // per-participant grants requires every take to carry its grant
      // reference (the single-scope formats carry the session scope
      // instead — the grant stays optional data).
      const grantReference =
        input.participantGrantReference !== undefined && input.participantGrantReference !== null ? input.participantGrantReference : null;
      if (format.participantModel.participationGrants === 'explicit_grant_per_participant' && grantReference === null) {
        throw new InvalidRequestError(
          `studio session ${session.sessionId}#r${session.revision} runs format '${format.formatId}@v${format.formatVersion}' which declares explicit per-participant grants — every take carries its §7 participation-grant reference`,
        );
      }

      // The walked-graph NODE PIN: a graph_walk take pins a declared
      // node of its capture session's walked graph version (§9 capture
      // is adaptive-interviewer-aware — the STUDIO-003 graph drives the
      // capture steps); a session_direct take carries no pin.
      let questionId: string | null = null;
      let graphId: string | null = null;
      let graphVersion: number | null = null;
      if (captureRow.capture_mode === 'graph_walk') {
        if (input.questionId === undefined || input.questionId === null) {
          throw new InvalidRequestError(
            `studio capture session ${input.captureSessionId} walks a declared question graph — every take carries its walked-graph node pin (questionId)`,
          );
        }
        const graphRow = await store.findQuestionGraphVersion(input.scope.clientId, captureRow.graph_id!, Number(captureRow.graph_version));
        if (graphRow === null) {
          throw new NotFoundError('studio question graph', captureRow.graph_id!);
        }
        const declaredGraph = graphRow.declared_graph as ContentStudioDeclaredQuestionGraph;
        if (!declaredGraph.nodes.some((node) => node.questionId === input.questionId)) {
          throw new InvalidRequestError(
            `studio capture take question '${input.questionId}' is not a declared node of the walked graph ${graphRow.graph_id}#v${Number(graphRow.graph_version)}`,
          );
        }
        questionId = input.questionId;
        graphId = graphRow.graph_id;
        graphVersion = Number(graphRow.graph_version);
      } else if (input.questionId !== undefined && input.questionId !== null) {
        throw new InvalidRequestError(
          `studio capture session ${input.captureSessionId} is session_direct — its takes carry no walked-graph node pin (found questionId '${input.questionId}')`,
        );
      }

      // The ALTERNATE fence: an alternate cites a take of the SAME
      // capture session, node pin and modality (a retake of the same
      // capture moment — never a repurposed citation, never an
      // overwrite).
      if (input.alternateOfTakeId !== undefined && input.alternateOfTakeId !== null) {
        const alternateRow = await store.findCaptureTake(input.scope.clientId, input.alternateOfTakeId);
        if (alternateRow === null) {
          throw new NotFoundError('studio capture take', input.alternateOfTakeId);
        }
        if (
          alternateRow.capture_session_id !== input.captureSessionId ||
          alternateRow.graph_id !== graphId ||
          (alternateRow.graph_version === null ? null : Number(alternateRow.graph_version)) !== graphVersion ||
          alternateRow.question_id !== questionId ||
          alternateRow.modality !== input.modality
        ) {
          throw new InvalidRequestError(
            `studio capture take alternate ${input.alternateOfTakeId} must share the capture session, the node pin and the modality — alternates are retakes of the SAME capture moment (a NEW take, never an overwrite)`,
          );
        }
      }

      // THE DURABLE LANDING (§9 "approved storage/access ports"): the
      // bytes go through the platform ObjectStore port — content-
      // addressed, idempotent, the SAME platform store /content-assets
      // lands its objects into. This is the ONLY synchronous work of
      // the ingest (§9 "Long-running processing is asynchronous/durable
      // rather than a synchronous web request"): the take row is born
      // 'processing' and the post-landing analysis completes separately.
      const stored = await deps.objects.put(input.bytes, { contentType: input.contentType });

      const row = await store.insertCaptureTake({
        takeId: store.newId(),
        takeReference: mintContentStudioTakeReference(store.newId()),
        captureSessionId: input.captureSessionId,
        sessionId: session.sessionId,
        revision: session.revision,
        scope: input.scope,
        graphId,
        graphVersion,
        questionId,
        modality: input.modality,
        alternateOfTakeId: input.alternateOfTakeId ?? null,
        inputKind: input.inputKind,
        deviceLabel: input.deviceLabel,
        sourceMetadata: input.sourceMetadata,
        participantReference: input.participantReference,
        participantGrantReference: grantReference,
        consentReferences: input.consentReferences,
        interviewerRepresentation: captureRow.interviewer_representation,
        objectKey: stored.key,
        objectDigest: stored.digest,
        objectSize: stored.size,
        contentType: input.contentType,
      });
      return mapCaptureTakeRow(row);
    },

    async completeCaptureTakeIngest(input: CompleteContentStudioCaptureTakeIngestInput): Promise<ContentStudioCaptureTakeRecord> {
      assertValidContentStudioScope(input.scope);
      assertValidContentStudioCaptureIngestCompletion({
        ...(input.analysis === undefined ? {} : { analysis: input.analysis }),
        ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
      });
      assertUuidShape('studio session', input.sessionId);
      assertUuidShape('studio capture take', input.takeId);
      await requireLatestSession(input.scope, input.sessionId);
      const existing = await store.findCaptureTake(input.scope.clientId, input.takeId);
      if (existing === null || existing.session_id !== input.sessionId) {
        throw new NotFoundError('studio capture take', input.takeId);
      }
      if (existing.ingest_state !== 'processing') {
        throw new InvalidRequestError(
          `studio capture take ${input.takeId} ingest is already ${existing.ingest_state} — the terminal ingest states are frozen (the honest retry is a NEW take row)`,
        );
      }
      const advanced = await store.advanceCaptureTakeIngest({
        clientId: input.scope.clientId,
        takeId: input.takeId,
        to: 'stored',
        analysis: input.analysis ?? null,
        failureReason: null,
        failureDetail: null,
        durationMs: input.durationMs ?? null,
      });
      if (advanced === null) {
        throw new InvalidRequestError(
          `studio capture take ${input.takeId} ingest no longer 'processing' — the completion lost the race (re-read the take; the terminal ingest states are frozen)`,
        );
      }
      return mapCaptureTakeRow(advanced);
    },

    async failCaptureTakeIngest(input: FailContentStudioCaptureTakeIngestInput): Promise<ContentStudioCaptureTakeRecord> {
      assertValidContentStudioScope(input.scope);
      assertValidContentStudioCaptureIngestFailure({
        failureReason: input.failureReason,
        ...(input.failureDetail === undefined ? {} : { failureDetail: input.failureDetail }),
        ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
      });
      assertUuidShape('studio session', input.sessionId);
      assertUuidShape('studio capture take', input.takeId);
      await requireLatestSession(input.scope, input.sessionId);
      const existing = await store.findCaptureTake(input.scope.clientId, input.takeId);
      if (existing === null || existing.session_id !== input.sessionId) {
        throw new NotFoundError('studio capture take', input.takeId);
      }
      if (existing.ingest_state !== 'processing') {
        throw new InvalidRequestError(
          `studio capture take ${input.takeId} ingest is already ${existing.ingest_state} — the terminal ingest states are frozen (the honest retry is a NEW take row)`,
        );
      }
      const advanced = await store.advanceCaptureTakeIngest({
        clientId: input.scope.clientId,
        takeId: input.takeId,
        to: 'failed',
        analysis: null,
        failureReason: input.failureReason,
        failureDetail: input.failureDetail ?? null,
        durationMs: input.durationMs ?? null,
      });
      if (advanced === null) {
        throw new InvalidRequestError(
          `studio capture take ${input.takeId} ingest no longer 'processing' — the failure lost the race (re-read the take; the terminal ingest states are frozen)`,
        );
      }
      return mapCaptureTakeRow(advanced);
    },

    async getCaptureTake(scope, sessionId, takeId) {
      assertValidContentStudioScope(scope);
      assertUuidShape('studio session', sessionId);
      await requireLatestSession(scope, sessionId);
      assertUuidShape('studio capture take', takeId);
      const row = await store.findCaptureTake(scope.clientId, takeId);
      if (row === null || row.session_id !== sessionId) {
        throw new NotFoundError('studio capture take', takeId);
      }
      return mapCaptureTakeRow(row);
    },

    async getCaptureTakeByReference(scope, reference) {
      assertValidContentStudioScope(scope);
      if (typeof reference !== 'string' || !reference.startsWith('studio-take:') || reference.length !== 'studio-take:'.length + 36) {
        throw new NotFoundError('studio capture take reference', String(reference));
      }
      const row = await store.findCaptureTakeByReference(scope.clientId, reference);
      if (row === null) {
        throw new NotFoundError('studio capture take reference', reference);
      }
      return mapCaptureTakeRow(row);
    },

    async listCaptureTakes(input: ListContentStudioCaptureTakesInput) {
      assertValidContentStudioScope(input.scope);
      assertValidContentStudioCaptureTakesQuery({
        ...(input.captureSessionId === undefined ? {} : { captureSessionId: input.captureSessionId }),
        ...(input.questionId === undefined ? {} : { questionId: input.questionId }),
        ...(input.modality === undefined ? {} : { modality: input.modality }),
        ...(input.alternateOfTakeId === undefined ? {} : { alternateOfTakeId: input.alternateOfTakeId }),
      });
      assertUuidShape('studio session', input.sessionId);
      await requireLatestSession(input.scope, input.sessionId);
      const rows = await store.listCaptureTakes(input.scope.clientId, {
        sessionId: input.sessionId,
        captureSessionId: input.captureSessionId ?? null,
        questionId: input.questionId ?? null,
        modality: input.modality ?? null,
        alternateOfTakeId: input.alternateOfTakeId ?? null,
      });
      return rows.map(mapCaptureTakeRow);
    },
  };
}
