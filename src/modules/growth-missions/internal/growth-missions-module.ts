/**
 * /growth-missions module implementation (MKT-053).
 *
 * Owns the migration 045 tables: the agency-scoped mission records, the
 * append-only version tail (the IMMUTABLE declared objective — corrections
 * are NEW version records), the append-only history tail (every lifecycle
 * transition with actor + provenance + reason) and the goal mapping rows
 * (canonical goal references through the /goals public contract,
 * READ-ONLY). The owning agency resolves through the /agencies structural
 * port BEFORE any write; a mapped goal resolves through the /goals
 * canonical ownership resolution BEFORE any mapping row persists.
 *
 * Concurrency: every mutation is a row-locked CAS transaction (SELECT ...
 * FOR UPDATE + explicit version check), deterministic under concurrent
 * lifecycle operations. Authorization derives from durable state on every
 * call — no process-local cache authority.
 *
 * NO controller/scheduler/loop logic lives here (architecture-lock-v1.6.md
 * rule 17 — the Growth Operator is MKT-054): this module exposes exactly
 * the durable record commands the record contract needs.
 */

import { ConflictError, NotFoundError } from '../../../platform/errors/errors.ts';
import type { DbTransaction } from '../../../platform/db/contract.ts';
import type { GrowthMissionsModuleApi, GrowthMissionsModuleDeps } from '../public.ts';
import {
  GROWTH_MISSION_TERMINAL_DECISION_BASIS,
  isLegalGrowthMissionTransition,
  isTerminalGrowthMissionStatus,
} from '../public.ts';
import {
  assertValidGrowthMissionDeclaration,
  assertValidGrowthMissionProvenance,
  assertValidGrowthMissionReason,
  composeGrowthMissionOwnerContext,
  GrowthMissionsStore,
} from './growth-missions-store.ts';
import type {
  GrowthMissionDetail,
  GrowthMissionEventDetail,
  GrowthMissionGoalView,
  GrowthMissionOwnerContext,
  GrowthMissionRecord,
} from '../public.ts';

export function createGrowthMissionsModule(deps: GrowthMissionsModuleDeps): GrowthMissionsModuleApi {
  const store = new GrowthMissionsStore(deps.db, deps.clock, deps.ids);
  const { agencies, goals, clock } = deps;

  return {
    async createGrowthMission(input, provenance) {
      assertValidGrowthMissionProvenance(provenance);
      assertValidGrowthMissionDeclaration(input.declaration);

      // CANONICAL agency resolution from durable state BEFORE any write
      // (implementation-contract §2): unknown agency → the uniform 404; a
      // disabled agency blocks new use (409) without rewriting history.
      const agency = await agencies.getAgency(input.agencyId);
      if (agency === null) {
        throw new NotFoundError('agency', input.agencyId);
      }
      if (agency.status !== 'active') {
        throw new ConflictError(
          `agency ${input.agencyId} is ${agency.status}; growth missions cannot be created`,
        );
      }

      const missionId = deps.ids.newId();
      const now = clock.nowIso();
      await deps.db.transaction(async (tx) => {
        // The durable mission record (born 'draft', CAS version 1).
        await store.insertMission({
          missionId,
          agencyId: input.agencyId,
          createdActor: provenance.actor,
          now,
        });
        // Version 1 of the declared content — the immutable objective tail.
        await store.appendVersion(tx, {
          missionId,
          versionSeq: 1,
          declaration: input.declaration,
          provenance,
        });
        // The first history event: the creation, honestly recorded.
        await store.appendEvent(tx, {
          missionId,
          eventKind: 'mission_created',
          fromStatus: null,
          toStatus: 'draft',
          terminalDecisionFamily: null,
          reason: 'growth mission declared',
          detail: null,
          provenance,
        });
      });

      return await getDetailOrThrow(store, goals, missionId);
    },

    async getGrowthMission(missionId) {
      return store.getMission(missionId);
    },

    async resolveGrowthMissionOwnership(missionId) {
      const mission = await store.getMission(missionId);
      if (mission === null) return null;
      const agency = await agencies.getAgency(mission.agencyId);
      if (agency === null) return null;
      return composeGrowthMissionOwnerContext(mission, agency, clock.nowIso()) as GrowthMissionOwnerContext;
    },

    async listGrowthMissionsForAgency(agencyId) {
      // Canonical owner resolution before dependent traversal (§2).
      const agency = await agencies.getAgency(agencyId);
      if (agency === null) {
        throw new NotFoundError('agency', agencyId);
      }
      return store.listMissionsForAgency(agencyId);
    },

    async getGrowthMissionDetail(missionId) {
      const mission = await store.getMission(missionId);
      if (mission === null) return null;
      return composeDetail(store, goals, mission);
    },

    async getGrowthMissionVersions(missionId) {
      const mission = await store.getMission(missionId);
      if (mission === null) return null;
      return store.listVersions(missionId);
    },

    async getGrowthMissionHistory(missionId) {
      const mission = await store.getMission(missionId);
      if (mission === null) return null;
      return store.listEvents(missionId);
    },

    async recordGrowthMissionVersion(input, provenance) {
      assertValidGrowthMissionProvenance(provenance);
      assertValidGrowthMissionDeclaration(input.declaration);

      await deps.db.transaction(async (tx) => {
        // CAS-serialized: row lock + explicit version check.
        const current = await lockMissionOrThrow(store, tx, input.missionId);
        if (current.version !== input.expectedVersion) {
          throw new ConflictError(
            `mission version mismatch: current version is ${current.version}`,
          );
        }
        // Terminal history is frozen — the declared content of a terminal
        // mission can never be rewritten (the DB triggers are the backstops).
        if (isTerminalGrowthMissionStatus(current.status)) {
          throw new ConflictError(
            `mission ${input.missionId} is ${current.status} and frozen; a new declared version cannot be recorded`,
          );
        }
        // New use: an ACTIVE agency is required (a disabled agency blocks
        // new use without rewriting history).
        await assertAgencyAllowsNewUse(agencies, current);

        // The correction path: append the NEW immutable version record,
        // advance the pointer (only ever forward), append the history event.
        const nextVersionSeq = (await store.countVersions(tx, input.missionId)) + 1;
        await store.appendVersion(tx, {
          missionId: input.missionId,
          versionSeq: nextVersionSeq,
          declaration: input.declaration,
          provenance,
        });
        const outcome = await store.advanceMissionVersionRow(tx, {
          missionId: input.missionId,
          versionSeq: nextVersionSeq,
          expectedVersion: input.expectedVersion,
        });
        if (outcome !== 'ok') {
          throw new ConflictError('mission version update lost the version race');
        }
        const detail: GrowthMissionEventDetail = { kind: 'version', versionSeq: nextVersionSeq };
        await store.appendEvent(tx, {
          missionId: input.missionId,
          eventKind: 'version_recorded',
          fromStatus: null,
          toStatus: null,
          terminalDecisionFamily: null,
          reason: 'declared objective correction recorded as a new version',
          detail,
          provenance,
        });
        return input.missionId;
      });
      // The honest read-back composes AFTER the commit — the post-commit
      // state is the committed truth (reads inside the open transaction
      // could observe the pre-commit snapshot on the pool connections).
      return await getDetailOrThrow(store, goals, input.missionId);
    },

    async setGrowthMissionStatus(input, provenance) {
      assertValidGrowthMissionProvenance(provenance);
      assertValidGrowthMissionReason(input.reason);

      await deps.db.transaction(async (tx) => {
        // CAS-serialized: row lock + explicit version check + the frozen
        // transition table — deterministic conflict behavior under
        // concurrent lifecycle operations.
        const current = await lockMissionOrThrow(store, tx, input.missionId);
        if (current.version !== input.expectedVersion) {
          throw new ConflictError(
            `mission version mismatch: current version is ${current.version}`,
          );
        }
        if (!isLegalGrowthMissionTransition(current.status, input.status)) {
          throw new ConflictError(
            `illegal growth mission transition ${current.status} → ${input.status}`,
          );
        }
        // Activation/resumption is NEW use: an ACTIVE agency and at least
        // ONE mapped goal are required (a mission pursues through the Goal
        // authority — the measurable anchor; a mission with no goal mapping
        // has nothing to pursue). Terminal transitions record history and
        // are never blocked by boundary state (the goals precedent).
        if (input.status === 'active') {
          await assertAgencyAllowsNewUse(agencies, current);
          const mappedGoals = await store.countActiveGoalMappings(tx, input.missionId);
          if (mappedGoals === 0) {
            throw new ConflictError(
              `mission ${input.missionId} cannot be activated: at least one existing goal must be mapped (the Goal authority is the measurable anchor)`,
            );
          }
        }
        // The §3 terminal-decision basis made durable: a TERMINAL transition
        // cites the mission's CURRENT declared objective family — never an
        // intermediate metric.
        let terminalFamily = null;
        if (isTerminalGrowthMissionStatus(input.status)) {
          const currentVersion = await store.getVersionBySeq(
            tx,
            input.missionId,
            current.currentVersionSeq,
          );
          if (currentVersion === null) {
            throw new Error(
              `mission ${input.missionId} has no declared version ${current.currentVersionSeq} to cite as the terminal decision basis`,
            );
          }
          terminalFamily = currentVersion.objectiveFamily;
        }

        // Append the history event BEFORE the record mutation (the DB pair
        // trigger re-verifies from_status against the mission's CURRENT
        // state — the honest ordering under the row lock).
        await store.appendEvent(tx, {
          missionId: input.missionId,
          eventKind: 'state_transition',
          fromStatus: current.status,
          toStatus: input.status,
          terminalDecisionFamily: terminalFamily,
          reason: input.reason,
          detail: null,
          provenance,
        });
        const outcome = await store.updateMissionStatusRow(tx, {
          missionId: input.missionId,
          status: input.status,
          expectedVersion: input.expectedVersion,
        });
        if (outcome !== 'ok') {
          throw new ConflictError('mission status update lost the version race');
        }
        return input.missionId;
      });
      // The honest read-back composes AFTER the commit.
      return await getDetailOrThrow(store, goals, input.missionId);
    },

    async addGrowthMissionGoalMapping(input, provenance) {
      assertValidGrowthMissionProvenance(provenance);

      // CANONICAL goal ownership resolution through the /goals public
      // contract BEFORE any mapping row: unknown goal, tombstoned Client
      // → the uniform 404 (a dangling reference never persists); the goal's
      // owning Client must belong to the mission's Agency (a foreign goal
      // identifier is not a traversal/existence oracle).
      const goalOwnership = await goals.resolveGoalOwnership(input.goalId);
      if (goalOwnership === null) {
        throw new NotFoundError('goal', input.goalId);
      }

      await deps.db.transaction(async (tx) => {
        const current = await lockMissionOrThrow(store, tx, input.missionId);
        if (goalOwnership.scope.agencyId !== current.agencyId) {
          // The cross-agency goal reference is indistinguishable from an
          // unknown one — the uniform 404, never an oracle.
          throw new NotFoundError('goal', input.goalId);
        }
        // Terminal history is frozen: mapping changes are plan edits.
        if (isTerminalGrowthMissionStatus(current.status)) {
          throw new ConflictError(
            `mission ${input.missionId} is ${current.status} and frozen; its goal mapping cannot change`,
          );
        }
        // New use: an ACTIVE agency is required.
        await assertAgencyAllowsNewUse(agencies, current);
        // The active (mission, goal) fence: an already-active mapping is an
        // honest conflict (the DB partial-unique fence is the backstop).
        const existing = await store.findActiveGoalMapping(tx, input.missionId, input.goalId);
        if (existing !== null) {
          throw new ConflictError(
            `goal ${input.goalId} is already mapped to mission ${input.missionId}`,
          );
        }

        await store.insertGoalMapping(tx, {
          missionId: input.missionId,
          goalId: input.goalId,
          addedBy: provenance.actor,
        });
        const detail: GrowthMissionEventDetail = { kind: 'goal', goalId: input.goalId };
        await store.appendEvent(tx, {
          missionId: input.missionId,
          eventKind: 'goal_mapped',
          fromStatus: null,
          toStatus: null,
          terminalDecisionFamily: null,
          reason: 'goal mapped onto the mission',
          detail,
          provenance,
        });
        return input.missionId;
      });
      // The honest read-back composes AFTER the commit.
      return await getDetailOrThrow(store, goals, input.missionId);
    },

    async removeGrowthMissionGoalMapping(input, provenance) {
      assertValidGrowthMissionProvenance(provenance);
      assertValidGrowthMissionReason(input.reason);

      await deps.db.transaction(async (tx) => {
        const current = await lockMissionOrThrow(store, tx, input.missionId);
        // Terminal history is frozen.
        if (isTerminalGrowthMissionStatus(current.status)) {
          throw new ConflictError(
            `mission ${input.missionId} is ${current.status} and frozen; its goal mapping cannot change`,
          );
        }
        // New use: an ACTIVE agency is required.
        await assertAgencyAllowsNewUse(agencies, current);
        // Only an ACTIVE mapping can be removed (goal removal surfaces
        // HONESTLY — the row keeps its history and gains the removal triple).
        const mapping = await store.findActiveGoalMapping(tx, input.missionId, input.goalId);
        if (mapping === null) {
          throw new ConflictError(
            `goal ${input.goalId} has no active mapping on mission ${input.missionId}`,
          );
        }

        await store.markGoalMappingRemoved(tx, {
          mappingId: mapping.mappingId,
          removedBy: provenance.actor,
          reason: input.reason,
        });
        const detail: GrowthMissionEventDetail = { kind: 'goal', goalId: input.goalId };
        await store.appendEvent(tx, {
          missionId: input.missionId,
          eventKind: 'goal_unmapped',
          fromStatus: null,
          toStatus: null,
          terminalDecisionFamily: null,
          reason: input.reason,
          detail,
          provenance,
        });
        return input.missionId;
      });
      // The honest read-back composes AFTER the commit.
      return await getDetailOrThrow(store, goals, input.missionId);
    },
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function lockMissionOrThrow(
  store: GrowthMissionsStore,
  tx: DbTransaction,
  missionId: string,
): Promise<GrowthMissionRecord> {
  const current = await store.lockMission(tx, missionId);
  if (current === null) {
    throw new NotFoundError('mission', missionId);
  }
  return current;
}

/**
 * Boundary policy shared by the new-use commands (version recording,
 * activation/resumption, mapping changes): the owning agency must be live
 * and ACTIVE — a disabled agency blocks new use (409) without rewriting
 * history. Resolved FRESH inside the caller's transaction — never cached.
 */
async function assertAgencyAllowsNewUse(
  agencies: GrowthMissionsModuleDeps['agencies'],
  mission: GrowthMissionRecord,
): Promise<void> {
  const agency = await agencies.getAgency(mission.agencyId);
  if (agency === null) {
    // The mission's agency vanished (impossible via the public surface —
    // agencies have no tombstone); fail closed as the uniform 404.
    throw new NotFoundError('mission', mission.missionId);
  }
  if (agency.status !== 'active') {
    throw new ConflictError(
      `agency ${mission.agencyId} is ${agency.status}; mission ${mission.missionId} cannot be used for new work`,
    );
  }
}

/** Composes the honest read-back after a committed mutation. */
async function getDetailOrThrow(
  store: GrowthMissionsStore,
  goals: GrowthMissionsModuleDeps['goals'],
  missionId: string,
): Promise<GrowthMissionDetail> {
  const mission = await store.getMission(missionId);
  if (mission === null) {
    throw new Error(`mission ${missionId} could not be read back`);
  }
  return composeDetail(store, goals, mission);
}

/**
 * Composes the mission read model: the record, the CURRENT declared
 * version, EVERY goal mapping with the goal's live status resolved through
 * the /goals public contract (READ-ONLY), the complete history, and the
 * terminal-decision-basis disclosure (the §3 rule, explicit on every view).
 */
async function composeDetail(
  store: GrowthMissionsStore,
  goals: GrowthMissionsModuleDeps['goals'],
  mission: GrowthMissionRecord,
): Promise<GrowthMissionDetail> {
  const [versions, mappings, history] = await Promise.all([
    store.listVersions(mission.missionId),
    store.listGoalMappings(mission.missionId),
    store.listEvents(mission.missionId),
  ]);
  const currentVersion =
    versions.find((version) => version.versionSeq === mission.currentVersionSeq) ?? versions[0];
  if (currentVersion === undefined) {
    throw new Error(`mission ${mission.missionId} has no declared version`);
  }
  // The LIVE goal status resolution (READ-ONLY): each mapping carries the
  // goal's current status; a goal that no longer resolves through the raw
  // goal row surfaces as null — the deletion is HONEST, never silently
  // hidden.
  const goalViews: GrowthMissionGoalView[] = [];
  for (const mapping of mappings) {
    const goal = await goals.getGoal(mapping.goalId);
    goalViews.push({
      ...mapping,
      goalStatus: goal === null ? null : goal.status,
      goalClientId: goal === null ? null : goal.clientId,
    });
  }
  return {
    mission,
    currentVersion,
    goalMappings: goalViews,
    history,
    terminalDecisionBasis: GROWTH_MISSION_TERMINAL_DECISION_BASIS,
  };
}
