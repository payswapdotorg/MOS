/**
 * /field-agents module implementation (MKT-025, FIELD-001 + HUMAN-001).
 *
 * Owns the generic Human Agent PROFILE authority (human_agents table): the
 * one capability model of spec/human-agent-v1.3.md. Specializations are
 * capability metadata on this single profile (Field Agent is the geography +
 * in-person specialization); there is NO second human-execution module and
 * NO job/execution engine here (HUMAN-AC-02) — the future /jobs authority
 * (MKT-026) consumes the eligibility/profile data this module exposes.
 *
 * Authorization composition follows the house boundary rules:
 *   - route-level access composes /users identity state and the /agencies
 *     membership authority exactly like MKT-003/004/005 (this module
 *     re-implements nothing);
 *   - caller-supplied identity/authority/outcome fields are never accepted:
 *     profile identity (agentId/userId), provenance, reliability signals
 *     and authorization state are server-derived;
 *   - this module reads/writes PROFILE DATA ONLY — no Client data is ever
 *     read, joined or returned (HUMAN-AC-03: fail-closed, and there is no
 *     client-scoped lookup surface at all).
 *
 * Concurrency: creation is DB-fenced (one profile per platform user);
 * profile mutations are row-locked CAS transactions; the server-derived
 * reliability fold is row-locked (serialized, no caller CAS by design).
 */

import { ConflictError, InvalidRequestError, NotFoundError } from '../../../platform/errors/errors.ts';
import type {
  FieldAgentsModuleApi,
  FieldAgentsModuleDeps,
  HumanAgentDeclaration,
  JobEligibilitySpec,
} from '../public.ts';
import {
  EMPTY_RELIABILITY_SIGNALS,
  HUMAN_SPECIALIZATION_KEYS,
  TERRITORY_KINDS,
  isAgentEligibleForJob,
  isLegalAuthorizationTransition,
  validateHumanAgentDeclaration,
  validateReliabilityObservation,
} from '../public.ts';
import { FieldAgentsStore } from './field-agents-store.ts';

const SKILL_PATTERN = /^[a-z][a-z0-9_]{1,48}$/;
const TERRITORY_VALUE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9 ,.-]{0,99}$/;

export function createFieldAgentsModule(deps: FieldAgentsModuleDeps): FieldAgentsModuleApi {
  const store = new FieldAgentsStore(deps.db, deps.clock, deps.ids);
  const { users } = deps;

  function assertValidDeclaration(declaration: HumanAgentDeclaration): void {
    const problems = validateHumanAgentDeclaration(declaration);
    if (problems.length > 0) {
      throw new InvalidRequestError('Human Agent profile declaration failed validation', problems);
    }
  }

  return {
    async createHumanAgent(input) {
      assertValidDeclaration(input.declaration);

      // The stable platform identity link must resolve against the /users
      // authority BEFORE any write: unknown user → uniform 404; a disabled
      // identity blocks new use without rewriting history (house policy).
      const user = await users.getUser(input.userId);
      if (user === null) {
        throw new NotFoundError('user', input.userId);
      }
      if (user.status !== 'active') {
        throw new ConflictError(
          `user ${input.userId} is disabled and cannot hold an active Human Agent profile`,
        );
      }

      const inserted = await store.insertHumanAgent({
        userId: input.userId,
        declaration: input.declaration,
        actorId: input.actorId,
        initialReliability: { ...EMPTY_RELIABILITY_SIGNALS },
      });
      if (inserted === 'taken') {
        throw new ConflictError(
          `user ${input.userId} already has a Human Agent profile (one profile per platform user)`,
        );
      }
      return inserted;
    },

    async getHumanAgent(agentId) {
      return store.getHumanAgent(agentId);
    },

    async getHumanAgentByUser(userId) {
      return store.getHumanAgentByUser(userId);
    },

    async updateProfileContent(input) {
      return deps.db.transaction(async (tx) => {
        // CAS-serialized: row lock + explicit version check + merged-shape
        // validation (the new specializations must satisfy the Field-Agent
        // geography rule together with the EXISTING location/territories —
        // exactly what the migration 017 CHECK enforces on the full row).
        const current = await store.lockHumanAgent(tx, input.agentId);
        if (current === null) {
          throw new NotFoundError('human-agent', input.agentId);
        }
        if (current.version !== input.expectedVersion) {
          throw new ConflictError(
            `human agent version mismatch: current version is ${current.version}`,
          );
        }
        const merged: HumanAgentDeclaration = {
          specializations: input.specializations,
          capabilities: input.capabilities,
          availability: current.availability,
          location: current.location,
          territories: current.territories,
          relationshipContinuity: input.relationshipContinuity,
        };
        assertValidDeclaration(merged);
        const outcome = await store.updateProfileContent(tx, {
          agentId: input.agentId,
          specializations: input.specializations,
          capabilities: input.capabilities,
          relationshipContinuity: input.relationshipContinuity,
          expectedVersion: input.expectedVersion,
        });
        if (outcome !== 'ok') {
          throw new ConflictError('human agent update lost the version race');
        }
        const updated = await store.lockHumanAgent(tx, input.agentId);
        if (updated === null) {
          throw new Error(`updated human agent profile ${input.agentId} could not be read back`);
        }
        return updated;
      });
    },

    async declareAvailabilityTerritory(input) {
      return deps.db.transaction(async (tx) => {
        // CAS-serialized: row lock + explicit version check + merged-shape
        // validation (the new geography must satisfy the Field-Agent rule
        // together with the EXISTING specializations).
        const current = await store.lockHumanAgent(tx, input.agentId);
        if (current === null) {
          throw new NotFoundError('human-agent', input.agentId);
        }
        if (current.version !== input.expectedVersion) {
          throw new ConflictError(
            `human agent version mismatch: current version is ${current.version}`,
          );
        }
        const merged: HumanAgentDeclaration = {
          specializations: current.specializations,
          capabilities: current.capabilities,
          availability: input.availability,
          location: input.location,
          territories: input.territories,
          relationshipContinuity: current.relationshipContinuity,
        };
        assertValidDeclaration(merged);
        const outcome = await store.updateDeclaration(tx, {
          agentId: input.agentId,
          availability: input.availability,
          location: input.location,
          territories: input.territories,
          expectedVersion: input.expectedVersion,
        });
        if (outcome !== 'ok') {
          throw new ConflictError('human agent declaration lost the version race');
        }
        const updated = await store.lockHumanAgent(tx, input.agentId);
        if (updated === null) {
          throw new Error(`updated human agent profile ${input.agentId} could not be read back`);
        }
        return updated;
      });
    },

    async setAuthorizationState(input) {
      return deps.db.transaction(async (tx) => {
        // CAS-serialized + frozen transition table; contract_ended is
        // terminal (the DB trigger is the final backstop).
        const current = await store.lockHumanAgent(tx, input.agentId);
        if (current === null) {
          throw new NotFoundError('human-agent', input.agentId);
        }
        if (current.version !== input.expectedVersion) {
          throw new ConflictError(
            `human agent version mismatch: current version is ${current.version}`,
          );
        }
        if (!isLegalAuthorizationTransition(current.authorizationState, input.authorizationState)) {
          throw new ConflictError(
            `illegal human agent authorization transition ${current.authorizationState} → ${input.authorizationState}`,
          );
        }
        const outcome = await store.updateAuthorizationState(tx, {
          agentId: input.agentId,
          authorizationState: input.authorizationState,
          expectedVersion: input.expectedVersion,
        });
        if (outcome !== 'ok') {
          throw new ConflictError('human agent update lost the version race');
        }
        const updated = await store.lockHumanAgent(tx, input.agentId);
        if (updated === null) {
          throw new Error(`updated human agent profile ${input.agentId} could not be read back`);
        }
        return updated;
      });
    },

    async findEligibleAgents(input) {
      assertValidSpec(input.spec);
      // Candidate narrowing (SQL) + the PURE matcher (single-sourced
      // semantics): profile data only — no Client data is touched anywhere
      // on this path.
      const candidates = await store.listActiveCandidates(input.candidateUserIds);
      return candidates.filter((agent) => isAgentEligibleForJob(agent, input.spec));
    },

    async recordReliabilityObservation(input) {
      const problems = validateReliabilityObservation(input.observation);
      if (problems.length > 0) {
        throw new InvalidRequestError('reliability observation failed validation', problems);
      }
      return deps.db.transaction(async (tx) => {
        const updated = await store.applyReliabilityObservation(tx, {
          agentId: input.agentId,
          observation: input.observation,
        });
        if (updated === null) {
          throw new NotFoundError('human-agent', input.agentId);
        }
        return updated;
      });
    },
  };
}

/**
 * Spec validation for the eligibility lookup (the route DTO is the strict
 * envelope; this is the module-level backstop of the same rules).
 */
function assertValidSpec(spec: JobEligibilitySpec): void {
  const problems: string[] = [];
  if (!(HUMAN_SPECIALIZATION_KEYS as readonly string[]).includes(spec.specialization)) {
    problems.push(`specialization: unknown specialization '${String(spec.specialization)}'`);
  }
  if (spec.requiredCapabilities.length > 50) {
    problems.push('requiredCapabilities: must contain at most 50 entries');
  }
  const seen = new Set<string>();
  for (const skill of spec.requiredCapabilities) {
    if (!SKILL_PATTERN.test(skill)) {
      problems.push(`requiredCapabilities: '${skill}' is not a valid normalized skill tag`);
    }
    if (seen.has(skill)) {
      problems.push(`requiredCapabilities: duplicate skill '${skill}'`);
    }
    seen.add(skill);
  }
  if (spec.territory !== null) {
    if (!(TERRITORY_KINDS as readonly string[]).includes(spec.territory.kind)) {
      problems.push(`territory: '${String(spec.territory.kind)}' is not a valid territory kind`);
    }
    if (!TERRITORY_VALUE_PATTERN.test(spec.territory.value)) {
      problems.push('territory: value must be 1..100 characters');
    }
  }
  const window = spec.availability;
  if (!Number.isSafeInteger(window.dayOfWeek) || window.dayOfWeek < 0 || window.dayOfWeek > 6) {
    problems.push('dayOfWeek: must be an integer 0..6');
  }
  if (
    !Number.isSafeInteger(window.startMinute) ||
    window.startMinute < 0 ||
    window.startMinute >= 1440
  ) {
    problems.push('startMinute: must be an integer 0..1439');
  }
  if (
    !Number.isSafeInteger(window.endMinute) ||
    window.endMinute <= 0 ||
    window.endMinute > 1440
  ) {
    problems.push('endMinute: must be an integer 1..1440');
  }
  if (
    Number.isSafeInteger(window.startMinute) &&
    Number.isSafeInteger(window.endMinute) &&
    window.startMinute >= window.endMinute
  ) {
    problems.push('startMinute must be before endMinute');
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('job eligibility spec failed validation', problems);
  }
}
