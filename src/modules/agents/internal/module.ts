/**
 * /agents module implementation (MKT-020, AGENT-001).
 *
 * Thin composition over the fenced registry store, exactly the registry
 * posture the /ai-runtime module established (MKT-017/018):
 *
 *   - REGISTER: the declaration is validated by the module input guard
 *     (provider-neutrality + authority-field rejection at the top level
 *     AND inside every capability descriptor), the §8-style fingerprint
 *     of the logical register command is computed server-side, and the
 *     insert is fenced by the migration-022 unique indexes. A fence hit
 *     is disambiguated by reading durable state INSIDE the transaction:
 *     the same command key + the same fingerprint converges (replay — no
 *     second row); the same command key + a different fingerprint is an
 *     IdempotencyConflictError; a fresh command key whose (scope,
 *     agent_key) already has an ACTIVE declaration is a ConflictError
 *     (retirement frees the key for the new version identity);
 *   - the 'registered' lifecycle event is appended in the SAME
 *     transaction as the insert (the append-only history starts with the
 *     creation itself);
 *   - RETIRE: the single lifecycle edge (active → retired, terminal),
 *     CAS-serialized on the row lock + the presented version; the
 *     'retired' event is appended in the SAME transaction, with the
 *     bounded reason. A second retirement is a ConflictError (the module
 *     check, the row trigger and the once-per-transition event fence are
 *     the three backstops);
 *   - LIST/READ: raw registry reads (tombstones stay visible — retired
 *     history is never erased);
 *   - the module owns NO tenant data, NO workflow state, NO deployment
 *     state, NO infrastructure: it composes platform ports only (the
 *     frozen matrix allows /executions, /ai-runtime and /policies, but
 *     the logical capability contract needs none of them — see the public
 *     entry header).
 */

import { createHash } from 'node:crypto';
import { ConflictError, IdempotencyConflictError, NotFoundError } from '../../../platform/errors/errors.ts';
import type { AgentsModuleApi, AgentsModuleDeps } from '../public.ts';
import type { LogicalAgentRegistrationInput } from '../public.ts';
import {
  AGENT_SCOPE_ID_PATTERN,
  assertValidIdempotencyKey,
  assertValidLogicalAgentRegistrationInput,
  assertValidLogicalAgentRetireReason,
  LogicalAgentStore,
} from './store.ts';

/**
 * The §8-style fingerprint of one logical register command: a
 * deterministic digest of WHAT the command registers (the scope + the
 * full provider-neutral declaration). A replayed key must present the
 * SAME fingerprint — one key identifies one logical command, so a key
 * reused for a different command is a conflict while duplicate delivery
 * of the same command converges. The actor is deliberately EXCLUDED — it
 * is ambient/server-derived per request (a retry after a network failure
 * legitimately carries a fresh actor and must still converge on the SAME
 * logical command).
 */
function fingerprintLogicalAgentRegistration(
  agencyId: string | null,
  agent: LogicalAgentRegistrationInput,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        shape: 'agents.logical-agent.register',
        agencyId,
        agentKey: agent.agentKey,
        displayName: agent.displayName,
        versionLabel: agent.versionLabel,
        description: agent.description,
        capabilities: agent.capabilities,
      }),
    )
    .digest('hex');
}

export function createAgentsModule(deps: AgentsModuleDeps): AgentsModuleApi {
  const store = new LogicalAgentStore(deps.db, deps.clock, deps.ids);

  return {
    async registerAgent(input) {
      assertValidLogicalAgentRegistrationInput(input.agent);
      assertValidIdempotencyKey(input.idempotencyKey);
      // The scope is SERVER-DERIVED data resolved by the caller from
      // canonical ownership state: an agency scope must be a
      // server-generated identifier shape, and null is the platform
      // scope. The DB scope immutability + FK are the backstops.
      if (input.scope.agencyId !== null && !AGENT_SCOPE_ID_PATTERN.test(input.scope.agencyId)) {
        throw new ConflictError(
          `scope.agencyId '${input.scope.agencyId}' is not a canonical server-derived scope id`,
        );
      }

      const createFingerprint = fingerprintLogicalAgentRegistration(
        input.scope.agencyId,
        input.agent,
      );

      return deps.db.transaction(async (tx) => {
        const inserted = await store.insertAgent(tx, {
          agent: input.agent,
          agencyId: input.scope.agencyId,
          idempotencyKey: input.idempotencyKey,
          createFingerprint,
          actorId: input.actorId,
        });
        if (inserted !== 'fence') {
          // The append-only lifecycle history starts with the creation
          // itself — same transaction, so a declared agent always has its
          // 'registered' event.
          await store.insertLifecycleEvent(tx, {
            agentId: inserted.agentId,
            transition: 'registered',
            fromStatus: null,
            toStatus: 'active',
            reason: '',
            actorId: input.actorId,
          });
          return { agent: inserted, replayed: false };
        }
        // A fence fired: disambiguate from durable state inside the
        // transaction — converge on the recorded command, reject the key
        // reuse, or reject the duplicate ACTIVE declaration. Never a
        // silent overwrite.
        const existing = await store.findAgentByCommandKey(
          tx,
          input.scope.agencyId,
          input.idempotencyKey,
        );
        if (existing !== null) {
          if (existing.createFingerprint !== createFingerprint) {
            throw new IdempotencyConflictError(input.idempotencyKey);
          }
          return { agent: existing, replayed: true };
        }
        const active = await store.findActiveAgentByKey(
          tx,
          input.scope.agencyId,
          input.agent.agentKey,
        );
        if (active !== null) {
          throw new ConflictError(
            `an ACTIVE logical agent declaration already exists for agent key '${input.agent.agentKey}' in this scope — retire it before registering a new version`,
          );
        }
        throw new ConflictError(
          `logical agent registration fence fired but no record resolved (key '${input.idempotencyKey}')`,
        );
      });
    },

    async getAgent(agentId) {
      return store.getAgent(agentId);
    },

    async listAgents(input) {
      if (input.agencyId !== null && !AGENT_SCOPE_ID_PATTERN.test(input.agencyId)) {
        throw new ConflictError(
          `agencyId '${input.agencyId}' is not a canonical server-derived scope id`,
        );
      }
      return store.listAgents(input.agencyId, input.includeRetired);
    },

    async retireAgent(input) {
      assertValidLogicalAgentRetireReason(input.reason);
      if (!AGENT_SCOPE_ID_PATTERN.test(input.agentId)) {
        throw new NotFoundError('agent', input.agentId);
      }
      return deps.db.transaction(async (tx) => {
        // CAS-serialized: row lock + explicit version check + the single
        // lifecycle edge (active → retired, terminal — the DB triggers
        // are the final backstops).
        const current = await store.lockAgent(tx, input.agentId);
        if (current === null) {
          throw new NotFoundError('agent', input.agentId);
        }
        if (current.version !== input.expectedVersion) {
          throw new ConflictError(
            `logical agent version mismatch: current version is ${current.version}`,
          );
        }
        if (current.status === 'retired') {
          // Terminal tombstone: replaying stale identifiers cannot
          // resurrect — there is no second retirement.
          throw new ConflictError(
            `logical agent ${input.agentId} is retired and terminal — corrections register a NEW declaration`,
          );
        }
        const outcome = await store.updateAgentStatus(tx, {
          agentId: input.agentId,
          expectedVersion: input.expectedVersion,
        });
        if (outcome !== 'ok') {
          throw new ConflictError('logical agent retire lost the version race');
        }
        // The 'retired' lifecycle event is appended in the SAME
        // transaction (append-only history; the once-per-transition
        // fence is the no-second-retirement backstop).
        await store.insertLifecycleEvent(tx, {
          agentId: input.agentId,
          transition: 'retired',
          fromStatus: 'active',
          toStatus: 'retired',
          reason: input.reason,
          actorId: input.actorId,
        });
        const updated = await store.lockAgent(tx, input.agentId);
        if (updated === null) {
          throw new Error(`retired logical agent ${input.agentId} could not be read back`);
        }
        return updated;
      });
    },

    async listLifecycleEvents(agentId) {
      return store.listLifecycleEvents(agentId);
    },
  };
}
