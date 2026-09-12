/**
 * /deployments persistence (deployments + deployment_events tables,
 * migration 034) — with database backstops:
 *
 *   - DEPLOYMENTS: the frozen identity record with CAS transitions. The
 *     scope chain is IMMUTABLE (trigger); the version-selection columns
 *     move ONLY on the redeploy/rollback completion edges (trigger —
 *     DEPLOY-AC-06); the policy reference moves only on the validation/
 *     gate edges (trigger); the lifecycle is enforced by the frozen
 *     DEPLOYMENT_TRANSITIONS table at the storage layer (trigger).
 *   - EVENTS: append-only — UPDATE and DELETE are rejected by triggers
 *     (the migration 015/018/025 pattern), so this store can only INSERT
 *     and SELECT them. The (deployment_id, idempotency_key) fence makes
 *     duplicate delivery of the same logical command converge to a
 *     constraint violation (ConflictError), never a second history row.
 *
 * The §21 secret-leak guard runs on every payload BEFORE insert —
 * nothing secret can enter any deployment record (deployments reference
 * capabilities and versions, never credentials).
 */

import { ConflictError, NotFoundError } from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  DeploymentEventType,
  DeploymentRecord,
  DeploymentRecordedProvenance,
  DeploymentSelection,
  DeploymentStatus,
  DeploymentValidationReport,
  DeploymentsOwnerContext,
  DeploymentsWorkspaceOwnershipSnapshot,
} from '../public.ts';
import { DEPLOYMENT_STATUSES, DEPLOYMENT_TRANSITIONS } from '../public.ts';
import { containsMaterialShapedKey } from './resolution.ts';

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface DeploymentRow extends DbRow {
  deployment_id: string;
  agency_id: string;
  client_id: string;
  workspace_id: string;
  playbook_version_id: string;
  workflow_definition_ids: unknown;
  required_domain_packs: unknown;
  required_capabilities: unknown;
  policy_reference_id: string | null;
  runtime_requirements: unknown;
  trigger_config: unknown;
  status: string;
  created_by: string | null;
  version: string | number;
  created_at: Date;
  updated_at: Date;
}

interface EventRow extends DbRow {
  event_id: string;
  deployment_id: string;
  idempotency_key: string;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  selection: unknown;
  validation_report: unknown;
  reason: string | null;
  execution_ref: string | null;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
}

const DEPLOYMENT_SELECT = `
  SELECT d.deployment_id, d.agency_id, d.client_id, d.workspace_id,
         d.playbook_version_id, d.workflow_definition_ids, d.required_domain_packs,
         d.required_capabilities, d.policy_reference_id, d.runtime_requirements,
         d.trigger_config, d.status, d.created_by, d.version, d.created_at, d.updated_at
  FROM deployments d
`;

const EVENT_SELECT = `
  SELECT e.event_id, e.deployment_id, e.idempotency_key, e.event_type,
         e.from_status, e.to_status, e.selection, e.validation_report,
         e.reason, e.execution_ref, e.recorded_actor, e.recorded_via,
         e.correlation_id, e.causation_id, e.recorded_at
  FROM deployment_events e
`;

// ---------------------------------------------------------------------------
// Serialization (record <-> row)
// ---------------------------------------------------------------------------

function toDeploymentRecord(row: DeploymentRow): DeploymentRecord {
  return {
    deploymentId: row.deployment_id,
    agencyId: row.agency_id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    playbookVersionId: row.playbook_version_id,
    workflowDefinitionIds: (row.workflow_definition_ids as string[]) ?? [],
    requiredDomainPacks: (row.required_domain_packs as DeploymentSelection['requiredDomainPacks']) ?? [],
    requiredCapabilities: (row.required_capabilities as DeploymentSelection['requiredCapabilities']) ?? [],
    policyReferenceId: row.policy_reference_id,
    runtimeRequirements: row.runtime_requirements as DeploymentRecord['runtimeRequirements'],
    triggerConfig: (row.trigger_config as DeploymentRecord['triggerConfig']) ?? [],
    status: row.status as DeploymentStatus,
    createdBy: row.created_by,
    version: typeof row.version === 'string' ? Number.parseInt(row.version, 10) : row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toEventRecord(row: EventRow): {
  readonly eventId: string;
  readonly deploymentId: string;
  readonly idempotencyKey: string;
  readonly eventType: DeploymentEventType;
  readonly fromStatus: DeploymentStatus | null;
  readonly toStatus: DeploymentStatus | null;
  readonly selection: DeploymentSelection | null;
  readonly validationReport: DeploymentValidationReport | null;
  readonly reason: string | null;
  readonly executionRef: string | null;
  readonly provenance: DeploymentRecordedProvenance;
} {
  return {
    eventId: row.event_id,
    deploymentId: row.deployment_id,
    idempotencyKey: row.idempotency_key,
    eventType: row.event_type as DeploymentEventType,
    fromStatus: row.from_status === null ? null : (row.from_status as DeploymentStatus),
    toStatus: row.to_status === null ? null : (row.to_status as DeploymentStatus),
    selection: (row.selection as DeploymentSelection | null) ?? null,
    validationReport: (row.validation_report as DeploymentValidationReport | null) ?? null,
    reason: row.reason,
    executionRef: row.execution_ref,
    provenance: {
      actor: row.recorded_actor,
      recordedVia: row.recorded_via,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      recordedAt: row.recorded_at.toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface DeploymentInsertRow {
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string;
  readonly selection: DeploymentSelection;
  readonly policyReferenceId: string | null;
  readonly createdBy: string | null;
}

export interface EventInsertRow {
  readonly deploymentId: string;
  readonly idempotencyKey: string;
  readonly eventType: DeploymentEventType;
  readonly fromStatus: DeploymentStatus | null;
  readonly toStatus: DeploymentStatus | null;
  readonly selection: DeploymentSelection | null;
  readonly validationReport: DeploymentValidationReport | null;
  readonly reason: string | null;
  readonly executionRef: string | null;
}

export class DeploymentsStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  async getDeployment(deploymentId: string): Promise<DeploymentRecord | null> {
    const result = await this.db.query<DeploymentRow>(
      `${DEPLOYMENT_SELECT} WHERE d.deployment_id = $1`,
      [deploymentId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toDeploymentRecord(row);
  }

  async listDeploymentsForWorkspace(workspaceId: string): Promise<readonly DeploymentRecord[]> {
    const result = await this.db.query<DeploymentRow>(
      `${DEPLOYMENT_SELECT} WHERE d.workspace_id = $1 ORDER BY d.created_at DESC, d.deployment_id DESC`,
      [workspaceId],
    );
    return result.rows.map(toDeploymentRecord);
  }

  async getDeploymentEvents(deploymentId: string): Promise<readonly ReturnType<typeof toEventRecord>[]> {
    const result = await this.db.query<EventRow>(
      `${EVENT_SELECT} WHERE e.deployment_id = $1 ORDER BY e.recorded_at ASC, e.event_id ASC`,
      [deploymentId],
    );
    return result.rows.map(toEventRecord);
  }

  async getDeploymentEvent(
    deploymentId: string,
    eventId: string,
  ): Promise<ReturnType<typeof toEventRecord> | null> {
    const result = await this.db.query<EventRow>(
      `${EVENT_SELECT} WHERE e.deployment_id = $1 AND e.event_id = $2`,
      [deploymentId, eventId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toEventRecord(row);
  }

  /**
   * Finds the recorded event for a (deployment, idempotency key) pair —
   * the replay-convergence lookup (the §8-style fence: a duplicate of the
   * same logical command converges to the recorded row).
   */
  async findEventByIdempotencyKey(
    deploymentId: string,
    idempotencyKey: string,
  ): Promise<ReturnType<typeof toEventRecord> | null> {
    const result = await this.db.query<EventRow>(
      `${EVENT_SELECT} WHERE e.deployment_id = $1 AND e.idempotency_key = $2`,
      [deploymentId, idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toEventRecord(row);
  }

  /** The LATEST event of one type (the pending redeploy/rollback source). */
  async findLatestEventOfType(
    deploymentId: string,
    eventType: DeploymentEventType,
  ): Promise<ReturnType<typeof toEventRecord> | null> {
    const result = await this.db.query<EventRow>(
      `${EVENT_SELECT} WHERE e.deployment_id = $1 AND e.event_type = $2
       ORDER BY e.recorded_at DESC, e.event_id DESC LIMIT 1`,
      [deploymentId, eventType],
    );
    const row = result.rows[0];
    return row === undefined ? null : toEventRecord(row);
  }

  /** Appends one deployment row (born DRAFT) + the 'created' ledger event. */
  async insertDeployment(
    row: DeploymentInsertRow,
    provenance: {
      readonly actor: string;
      readonly recordedVia: string;
      readonly correlationId: string;
      readonly causationId: string | null;
    },
  ): Promise<DeploymentRecord> {
    const deploymentId = this.ids.newId();
    const now = this.clock.nowIso();
    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO deployments (deployment_id, agency_id, client_id, workspace_id,
                                  playbook_version_id, workflow_definition_ids,
                                  required_domain_packs, required_capabilities,
                                  policy_reference_id, runtime_requirements, trigger_config,
                                  status, created_by, version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10::jsonb,
                 $11::jsonb, 'draft', $12, 1, $13, $13)`,
        [
          deploymentId,
          row.agencyId,
          row.clientId,
          row.workspaceId,
          row.selection.playbookVersionId,
          JSON.stringify(row.selection.workflowDefinitionIds),
          JSON.stringify(row.selection.requiredDomainPacks),
          JSON.stringify(row.selection.requiredCapabilities),
          row.policyReferenceId,
          JSON.stringify(row.selection.runtimeRequirements),
          JSON.stringify(row.selection.triggerConfig),
          row.createdBy,
          now,
        ],
      );
      await appendEvent(tx, this.ids, {
        deploymentId,
        idempotencyKey: `created:${deploymentId}`,
        eventType: 'created',
        fromStatus: null,
        toStatus: 'draft',
        selection: row.selection,
        validationReport: null,
        reason: null,
        executionRef: null,
        provenance,
        recordedAt: now,
      });
    });
    const created = await this.getDeployment(deploymentId);
    if (created === null) {
      throw new Error(`created deployment ${deploymentId} could not be read back`);
    }
    return created;
  }

  /**
   * THE CAS LIFECYCLE TRANSITION — one row-locked transaction:
   *   1. lock the row, re-read the CURRENT record;
   *   2. CAS: expectedVersion must equal the current row version
   *      (ConflictError otherwise);
   *   3. GUARD: (current → to) must be a frozen edge (ConflictError
   *      otherwise — DEPLOY-AC-05; the DB trigger is the backstop);
   *   4. apply the mutation patch (status always; selection columns only
   *      on the redeploy/rollback completion edges; policy reference on
   *      validation/gate edges) + append the ledger event.
   */
  async transitionDeployment(
    input: {
      readonly deploymentId: string;
      readonly to: DeploymentStatus;
      readonly idempotencyKey: string;
      readonly expectedVersion: number;
      readonly reason: string | null;
      readonly eventType: DeploymentEventType;
      readonly eventFromStatus: DeploymentStatus | null;
      readonly newSelection: DeploymentSelection | null;
      readonly policyReferenceId: string | null;
      readonly validationReport: DeploymentValidationReport | null;
      readonly executionRef: string | null;
    },
    provenance: {
      readonly actor: string;
      readonly recordedVia: string;
      readonly correlationId: string;
      readonly causationId: string | null;
    },
  ): Promise<{ readonly deployment: DeploymentRecord; readonly eventId: string }> {
    const now = this.clock.nowIso();
    const eventId = this.ids.newId();
    const deployment = await this.db.transaction(async (tx) => {
      const locked = await tx.query<DeploymentRow>(
        `${DEPLOYMENT_SELECT} WHERE d.deployment_id = $1 FOR UPDATE`,
        [input.deploymentId],
      );
      const currentRow = locked.rows[0];
      if (currentRow === undefined) {
        throw new NotFoundError('deployment', input.deploymentId);
      }
      const current = toDeploymentRecord(currentRow);
      if (current.version !== input.expectedVersion) {
        throw new ConflictError(
          `deployment ${input.deploymentId} version ${current.version} does not match expected ${input.expectedVersion}`,
        );
      }
      if (current.status === input.to) {
        throw new ConflictError(
          `deployment ${input.deploymentId} is already '${input.to}'`,
        );
      }
      if (!DEPLOYMENT_TRANSITIONS[current.status].includes(input.to)) {
        throw new ConflictError(
          `illegal deployment transition ${current.status} -> ${input.to} on deployment ${input.deploymentId} (frozen lifecycle)`,
        );
      }

      const applySelection =
        input.newSelection !== null && (current.status === 'redeploying' || current.status === 'rolling_back') && input.to === 'active';
      await tx.query(
        `UPDATE deployments
         SET status = $1,
             playbook_version_id = CASE WHEN $2 THEN $3 ELSE playbook_version_id END,
             workflow_definition_ids = CASE WHEN $2 THEN $4::jsonb ELSE workflow_definition_ids END,
             required_domain_packs = CASE WHEN $2 THEN $5::jsonb ELSE required_domain_packs END,
             required_capabilities = CASE WHEN $2 THEN $6::jsonb ELSE required_capabilities END,
             runtime_requirements = CASE WHEN $2 THEN $7::jsonb ELSE runtime_requirements END,
             trigger_config = CASE WHEN $2 THEN $8::jsonb ELSE trigger_config END,
             policy_reference_id = CASE WHEN $9 THEN $10 ELSE policy_reference_id END,
             version = version + 1,
             updated_at = $11
         WHERE deployment_id = $12`,
        [
          input.to,
          applySelection,
          input.newSelection?.playbookVersionId ?? null,
          input.newSelection === null ? null : JSON.stringify(input.newSelection.workflowDefinitionIds),
          input.newSelection === null ? null : JSON.stringify(input.newSelection.requiredDomainPacks),
          input.newSelection === null ? null : JSON.stringify(input.newSelection.requiredCapabilities),
          input.newSelection === null ? null : JSON.stringify(input.newSelection.runtimeRequirements),
          input.newSelection === null ? null : JSON.stringify(input.newSelection.triggerConfig),
          input.policyReferenceId !== null,
          input.policyReferenceId,
          now,
          input.deploymentId,
        ],
      );

      await appendEvent(tx, this.ids, {
        deploymentId: input.deploymentId,
        idempotencyKey: input.idempotencyKey,
        eventType: input.eventType,
        fromStatus: input.eventFromStatus ?? current.status,
        toStatus: input.to,
        selection: input.newSelection,
        validationReport: input.validationReport,
        reason: input.reason,
        executionRef: input.executionRef,
        provenance,
        recordedAt: now,
        presetEventId: eventId,
      });

      const readBack = await tx.query<DeploymentRow>(
        `${DEPLOYMENT_SELECT} WHERE d.deployment_id = $1`,
        [input.deploymentId],
      );
      const updatedRow = readBack.rows[0];
      if (updatedRow === undefined) {
        throw new Error(`transitioned deployment ${input.deploymentId} could not be read back`);
      }
      return toDeploymentRecord(updatedRow);
    });
    return { deployment, eventId };
  }

  /**
   * Appends one 'execution-requested' ledger event (no row mutation —
   * requesting execution is not a lifecycle transition). A duplicate
   * delivery converges silently (the same logical command — the
   * executions module's own §8 fence already converged the execution);
   * a key recorded for a DIFFERENT command surfaces as ConflictError.
   * Returns the CURRENT deployment record.
   */
  async appendExecutionRequest(
    input: {
      readonly deploymentId: string;
      readonly idempotencyKey: string;
      readonly executionRef: string;
    },
    provenance: {
      readonly actor: string;
      readonly recordedVia: string;
      readonly correlationId: string;
      readonly causationId: string | null;
    },
  ): Promise<DeploymentRecord> {
    const now = this.clock.nowIso();
    try {
      await appendEvent(this.db, this.ids, {
        deploymentId: input.deploymentId,
        idempotencyKey: input.idempotencyKey,
        eventType: 'execution-requested',
        fromStatus: null,
        toStatus: null,
        selection: null,
        validationReport: null,
        reason: null,
        executionRef: input.executionRef,
        provenance,
        recordedAt: now,
      });
    } catch (error) {
      if (classifyDeploymentWriteConflict(error) === 'idempotency') {
        const current = await this.getDeployment(input.deploymentId);
        if (current !== null) return current;
      }
      throw error;
    }
    const current = await this.getDeployment(input.deploymentId);
    if (current === null) {
      throw new Error(`deployment ${input.deploymentId} could not be read back`);
    }
    return current;
  }

  /**
   * The compound VALIDATE leg (draft → validating → ready) in ONE
   * transaction — the validating state is the atomic in-flight edge
   * (never externally targetable; the row passes THROUGH it). The module
   * has ALREADY run the resolution contract; the report is recorded on
   * the 'validated' event.
   */
  async applyValidationSuccess(
    input: {
      readonly deploymentId: string;
      readonly idempotencyKey: string;
      readonly expectedVersion: number;
      readonly policyReferenceId: string | null;
      readonly validationReport: DeploymentValidationReport;
    },
    provenance: {
      readonly actor: string;
      readonly recordedVia: string;
      readonly correlationId: string;
      readonly causationId: string | null;
    },
  ): Promise<{ readonly deployment: DeploymentRecord; readonly eventId: string }> {
    const now = this.clock.nowIso();
    const eventId = this.ids.newId();
    const deployment = await this.db.transaction(async (tx) => {
      const locked = await tx.query<DeploymentRow>(
        `${DEPLOYMENT_SELECT} WHERE d.deployment_id = $1 FOR UPDATE`,
        [input.deploymentId],
      );
      const currentRow = locked.rows[0];
      if (currentRow === undefined) {
        throw new NotFoundError('deployment', input.deploymentId);
      }
      const current = toDeploymentRecord(currentRow);
      if (current.status !== 'draft') {
        throw new ConflictError(
          `deployment ${input.deploymentId} is '${current.status}'; validation requires draft`,
        );
      }
      if (current.version !== input.expectedVersion) {
        throw new ConflictError(
          `deployment ${input.deploymentId} version ${current.version} does not match expected ${input.expectedVersion}`,
        );
      }
      // The atomic in-flight leg: draft → validating (version+1), then
      // validating → ready (version+1) — the row passes THROUGH
      // 'validating' exactly as the frozen machine prescribes.
      await tx.query(
        `UPDATE deployments SET status = 'validating', version = version + 1, updated_at = $1
         WHERE deployment_id = $2`,
        [now, input.deploymentId],
      );
      await tx.query(
        `UPDATE deployments SET status = 'ready', version = version + 1,
             policy_reference_id = COALESCE($1, policy_reference_id), updated_at = $2
         WHERE deployment_id = $3`,
        [input.policyReferenceId, now, input.deploymentId],
      );

      await appendEvent(tx, this.ids, {
        deploymentId: input.deploymentId,
        idempotencyKey: input.idempotencyKey,
        eventType: 'validated',
        fromStatus: 'draft',
        toStatus: 'ready',
        selection: null,
        validationReport: input.validationReport,
        reason: null,
        executionRef: null,
        provenance,
        recordedAt: now,
        presetEventId: eventId,
      });

      const readBack = await tx.query<DeploymentRow>(
        `${DEPLOYMENT_SELECT} WHERE d.deployment_id = $1`,
        [input.deploymentId],
      );
      const updatedRow = readBack.rows[0];
      if (updatedRow === undefined) {
        throw new Error(`validated deployment ${input.deploymentId} could not be read back`);
      }
      return toDeploymentRecord(updatedRow);
    });
    return { deployment, eventId };
  }
}

// ---------------------------------------------------------------------------
// Event append (the shared insert with the idempotency fence)
// ---------------------------------------------------------------------------

/**
 * Appends one ledger event inside a transaction. The (deployment,
 * idempotency_key) UNIQUE fence converts duplicate delivery of the same
 * logical command into a ConflictError the module maps to a replay
 * convergence (the §8-style house pattern).
 */
async function appendEvent(
  tx: { query<T extends DbRow = DbRow>(text: string, params?: ReadonlyArray<unknown>): Promise<{ rows: ReadonlyArray<T>; rowCount: number }> },
  ids: IdGenerator,
  input: {
    readonly deploymentId: string;
    readonly idempotencyKey: string;
    readonly eventType: DeploymentEventType;
    readonly fromStatus: DeploymentStatus | null;
    readonly toStatus: DeploymentStatus | null;
    readonly selection: DeploymentSelection | null;
    readonly validationReport: DeploymentValidationReport | null;
    readonly reason: string | null;
    readonly executionRef: string | null;
    readonly provenance: {
      readonly actor: string;
      readonly recordedVia: string;
      readonly correlationId: string;
      readonly causationId: string | null;
    };
    readonly recordedAt: string;
    readonly presetEventId?: string;
  },
): Promise<void> {
  const eventId = input.presetEventId ?? ids.newId();
  const selection =
    input.selection === null ? null : containsMaterialShapedKey(input.selection) ? null : JSON.stringify(input.selection);
  const report = input.validationReport === null ? null : JSON.stringify(input.validationReport);
  await tx.query(
    `INSERT INTO deployment_events (event_id, deployment_id, idempotency_key, event_type,
                                   from_status, to_status, selection, validation_report,
                                   reason, execution_ref, recorded_actor, recorded_via,
                                   correlation_id, causation_id, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13, $14, $15)`,
    [
      eventId,
      input.deploymentId,
      input.idempotencyKey,
      input.eventType,
      input.fromStatus,
      input.toStatus,
      selection,
      report,
      input.reason,
      input.executionRef,
      input.provenance.actor,
      input.provenance.recordedVia,
      input.provenance.correlationId,
      input.provenance.causationId,
      input.recordedAt,
    ],
  );
}

// ---------------------------------------------------------------------------
// Canonical owner-context composition (pure)
// ---------------------------------------------------------------------------

/**
 * Pure composition of the canonical deployment owner context from the
 * deployment record and an ALREADY-RESOLVED /workspaces canonical owner
 * context (the compose* house pattern). Purity is asserted by unit tests.
 */
export function composeDeploymentOwnerContext(
  deployment: DeploymentRecord,
  workspaceOwnership: DeploymentsWorkspaceOwnershipSnapshot,
  resolvedAt: string,
): DeploymentsOwnerContext {
  return {
    scope: {
      kind: 'deployment',
      agencyId: deployment.agencyId,
      clientId: deployment.clientId,
      workspaceId: deployment.workspaceId,
      deploymentId: deployment.deploymentId,
    },
    deployment,
    workspaceOwnership,
    resolvedAt,
  };
}

/**
 * Classifies a store write error: a deployment_events unique-violation on
 * the (deployment, idempotency_key) fence (the §8-style convergence
 * signal) → 'idempotency'; an illegal-transition/selection/identity
 * trigger exception → 'transition'; null otherwise.
 */
export function classifyDeploymentWriteConflict(error: unknown): 'idempotency' | 'transition' | null {
  const message = error instanceof Error ? error.message : String(error);
  if (/deployment_events_idempotency_fence/.test(message)) return 'idempotency';
  if (/illegal deployment transition|version selection is immutable|scope chain is immutable|policy reference may only/.test(message)) {
    return 'transition';
  }
  return null;
}

export { DEPLOYMENT_STATUSES };
