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
 */

import { InvalidRequestError, NotFoundError } from '../../../platform/errors/errors.ts';
import type {
  AdvanceContentStudioSessionInput,
  AppendContentStudioProductionRequestInput,
  ClaimContentStudioProcessingStepsInput,
  CompleteContentStudioProcessingStepInput,
  ContentStudioAgentBodyResolution,
  ContentStudioFormatDeclaration,
  ContentStudioFormatRecord,
  ContentStudioModuleApi,
  ContentStudioModuleDeps,
  ContentStudioOrganizationDeclaration,
  ContentStudioOrganizationValidation,
  ContentStudioOutputVersionRecord,
  ContentStudioProductionRequestContent,
  ContentStudioProductionRequestRecord,
  ContentStudioScope,
  ContentStudioSessionEventKind,
  ContentStudioSessionRecord,
  ContentStudioSessionState,
  ContentStudioStepCompletionResult,
  ContentStudioTerminalReason,
  ContentStudioTreatmentResult,
  CreateContentStudioProductionRequestInput,
  FailContentStudioProcessingStepInput,
  OpenContentStudioSessionInput,
  RegisterContentStudioFormatInput,
  RequeueContentStudioProcessingStepInput,
  RequestContentStudioTreatmentInput,
} from '../public.ts';
import {
  assertLegalContentStudioSessionTransition,
  assertTerminalReasonForAdvance,
  assertValidContentStudioFormatDeclaration,
  assertValidContentStudioProductionRequestContent,
  assertValidContentStudioScope,
  assertValidContentStudioTreatmentSpecification,
} from './validation.ts';
import {
  ContentStudioStore,
  mapEventRow,
  mapFormatRow,
  mapOutputRow,
  mapRequestRow,
  mapSessionRow,
  mapStepRow,
  mapTreatmentRow,
  type FormatRow,
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
  };
}
