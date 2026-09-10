/**
 * MarketingOS module: /field-agents
 * Authority: Field-agent identity/availability — the GENERIC HUMAN AGENT
 * authority (spec/implementation-contract.md §1; spec/module-dependency-v1.3.md:
 * "/human-agents is represented by the existing /field-agents authority
 * generalized according to spec/human-agent-v1.3.md; a second human-execution
 * module is forbidden").
 *
 * MKT-025 implements this authority (FIELD-001 + HUMAN-001, v1.3 work-item
 * matrix override). This module owns:
 *
 *   - the HUMAN AGENT PROFILE (human_agents table): the ONE generic human
 *     capability model of spec/human-agent-v1.3.md §1 — a stable PLATFORM
 *     identity link (exactly one user, DB-fenced unique and immutable),
 *     capabilities/skills, availability, optional geography (current
 *     location + service territories), server-derived reliability/quality
 *     signals, relationship-continuity preferences and the frozen
 *     authorization/contract state (active/suspended/contract_ended;
 *     contract_ended is TERMINAL);
 *   - SPECIALIZATIONS as capability metadata (v1.3 §2): Field Agent,
 *     Chatter, Creator Manager, Content Manager, Growth Manager, Account
 *     Manager, Reviewer, Sales Agent. A specialization is a TAG + capability
 *     overlay on the SAME profile — Field Agent additionally requires
 *     declared geography (location or ≥1 territory; DB-backstopped);
 *   - JOB ELIGIBILITY data (FIELD-AC-02): a pure, profile-only matcher and
 *     a lookup the future /jobs authority (MKT-026) consumes. Eligibility is
 *     computed from profile data ONLY — no Client data is read, joined or
 *     exposed by this module.
 *
 * What this module deliberately does NOT do (frozen boundaries):
 *   - it is NOT a tenant: the profile carries NO agency/client/workspace
 *     columns. A Human Agent is not a tenant and owns no Client data merely
 *     by being eligible for a Job (human-agent-v1.3 §1). Agency linkage is
 *     EXACTLY the existing /agencies membership authority (role
 *     'human_agent', MKT-002) — composed by ROUTES, never duplicated here;
 *   - it implements NO Job/Task/Execution engine (HUMAN-AC-02, AGENTS.md
 *     "Human Agents use the existing Job/Task/Execution authorities"): no
 *     job/offer/acceptance/dispatch state, no assignment, no queue. /jobs
 *     (MKT-026) owns the DRAFT → OPEN → OFFERED → ACCEPTED machine;
 *   - it exposes NO Client-data routes and NO client-scoped lookups
 *     (HUMAN-AC-03, fail-closed): client-scoped visibility requires the
 *     authorized Job/Execution context which does NOT exist yet;
 *   - it introduces no second authorization authority: route-level access
 *     composes /users identity state and the /agencies membership authority
 *     exactly like MKT-003/004/005.
 *
 * Cross-module access may only target this public entry (public.ts) —
 * dependency matrix: /field-agents ──→ /users, /clients, /policies (this
 * Work Item consumes /users only; /clients//policies allowances remain for
 * the Work Items that own them).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import type { UsersModuleApi } from '../users/public.ts';

// ---------------------------------------------------------------------------
// Specializations (spec/human-agent-v1.3.md §2 — capability metadata)
// ---------------------------------------------------------------------------

/**
 * The frozen Human Agent specialization registry (human-agent-v1.3.md §2 +
 * HUMAN-AC-02 enumeration + the Sales Agent listed in v1.3 §2). A
 * specialization is CAPABILITY METADATA on the generic Human Agent profile
 * — never a second execution model: every specialization executes through
 * the SAME Job/Task/Execution authorities (/jobs, /executions).
 */
export const HUMAN_SPECIALIZATIONS = [
  'field_agent',
  'chatter',
  'creator_manager',
  'content_manager',
  'growth_manager',
  'account_manager',
  'reviewer',
  'sales_agent',
] as const;

export type HumanSpecialization = (typeof HUMAN_SPECIALIZATIONS)[number];

export const HUMAN_SPECIALIZATION_KEYS: readonly HumanSpecialization[] = HUMAN_SPECIALIZATIONS;

/** Type guard for the frozen specialization registry. */
export function isHumanSpecialization(value: string): value is HumanSpecialization {
  return (HUMAN_SPECIALIZATION_KEYS as readonly string[]).includes(value);
}

/** The Field Agent specialization (location/territory + in-person execution). */
export const FIELD_AGENT_SPECIALIZATION: HumanSpecialization = 'field_agent';

// ---------------------------------------------------------------------------
// Profile shape (HUMAN-AC-01)
// ---------------------------------------------------------------------------

/** One capability/skill with an optional proficiency level. */
export interface HumanCapability {
  /** Normalized skill tag (e.g. 'canvassing', 'product_demo', 'community_reply'). */
  readonly skill: string;
  /** Optional proficiency level. */
  readonly level: CapabilityLevel | null;
}

export const CAPABILITY_LEVELS = ['beginner', 'intermediate', 'advanced', 'expert'] as const;
export type CapabilityLevel = (typeof CAPABILITY_LEVELS)[number];

/**
 * One recurring weekly availability window (minutes from midnight, UTC
 * neutral — the window is a recurring pattern, not an absolute timestamp).
 * `startMinute` is inclusive, `endMinute` exclusive (0..1440, start < end).
 */
export interface AvailabilityWindow {
  /** 0 = Sunday … 6 = Saturday. */
  readonly dayOfWeek: number;
  readonly startMinute: number;
  readonly endMinute: number;
}

/** Territory kinds (provider-neutral geography tags; exact-match semantics). */
export const TERRITORY_KINDS = ['country', 'region', 'city', 'postal_area'] as const;
export type TerritoryKind = (typeof TERRITORY_KINDS)[number];

/**
 * One territory declaration. Matching is EXACT on (kind, value): hierarchical
 * resolution (a country territory covering a city job territory) is a Jobs-
 * authority concern (MKT-026+) and is deliberately NOT invented here.
 */
export interface Territory {
  readonly kind: TerritoryKind;
  readonly value: string;
}

/**
 * Relationship-continuity preferences (human-agent-v1.3 §1): how the platform
 * should weigh repeated relationships when matching Jobs (consumed by the
 * future /jobs matching policy — persisted here as profile data only).
 */
export interface RelationshipContinuity {
  /** Whether the agent prefers repeat service for the same clients. */
  readonly prefersRepeatClients: boolean;
  /** How strongly continuity should weigh: 'any' (no preference) … 'required'. */
  readonly continuity: 'any' | 'preferred' | 'required';
  /** Soft cap on concurrent client relationships (null = unlimited). */
  readonly maxConcurrentClientRelationships: number | null;
}

/**
 * Server-derived reliability/quality signal aggregate (human-agent-v1.3 §1).
 * NEVER caller-supplied: it is initialized to zero counters at creation and
 * updated ONLY through the server-side `recordReliabilityObservation` module
 * API by authorized server-side callers (the future /jobs authority) — there
 * is deliberately NO route for it.
 */
export interface ReliabilitySignals {
  readonly completedJobs: number;
  readonly successfulJobs: number;
  readonly onTimeCompletions: number;
  readonly ratingSum: number;
  readonly ratingCount: number;
}

/** The frozen zero state every profile starts from. */
export const EMPTY_RELIABILITY_SIGNALS: ReliabilitySignals = {
  completedJobs: 0,
  successfulJobs: 0,
  onTimeCompletions: 0,
  ratingSum: 0,
  ratingCount: 0,
};

/** Authorization/contract state (human-agent-v1.3 §1). */
export type HumanAuthorizationState = 'active' | 'suspended' | 'contract_ended';

/**
 * Frozen authorization/contract lifecycle. `contract_ended` is TERMINAL —
 * contract history can never be rewritten (enforced by the DB trigger in
 * migration 017 AND this transition table). This is a PROFILE attribute of
 * the platform identity, NOT an execution state: agency-level standing is
 * the existing membership lifecycle in /agencies (no second authority).
 */
export const HUMAN_AUTHORIZATION_TRANSITIONS: Readonly<
  Record<HumanAuthorizationState, readonly HumanAuthorizationState[]>
> = {
  active: ['suspended', 'contract_ended'],
  suspended: ['active', 'contract_ended'],
  contract_ended: [],
};

export function isLegalAuthorizationTransition(
  from: HumanAuthorizationState,
  to: HumanAuthorizationState,
): boolean {
  return HUMAN_AUTHORIZATION_TRANSITIONS[from].includes(to);
}

/** The full declarable profile content (used on create and on updates). */
export interface HumanAgentDeclaration {
  readonly specializations: readonly HumanSpecialization[];
  readonly capabilities: readonly HumanCapability[];
  readonly availability: readonly AvailabilityWindow[];
  readonly location: Territory | null;
  readonly territories: readonly Territory[];
  readonly relationshipContinuity: RelationshipContinuity;
}

/**
 * Pure profile validation (single source of truth for the HUMAN-AC-01 shape;
 * the module throws InvalidRequestError with these problems, migration 017
 * backstops type/cardinality/registry fences, and unit tests pin the rules).
 * Returns the list of problems (empty = valid).
 */
export function validateHumanAgentDeclaration(
  declaration: HumanAgentDeclaration,
): ReadonlyArray<string> {
  const problems: string[] = [];

  // --- specializations: non-empty, unique, frozen registry ---
  const specializations = declaration.specializations;
  if (specializations.length < 1 || specializations.length > 8) {
    problems.push('specializations: must contain 1 to 8 entries');
  }
  const seenSpecializations = new Set<string>();
  for (const specialization of specializations) {
    if (!isHumanSpecialization(specialization)) {
      problems.push(`specializations: unknown specialization '${specialization}'`);
    }
    if (seenSpecializations.has(specialization)) {
      problems.push(`specializations: duplicate entry '${specialization}'`);
    }
    seenSpecializations.add(specialization);
  }

  // --- capabilities: non-empty, normalized skill tags, unique skills ---
  const capabilities = declaration.capabilities;
  if (capabilities.length < 1 || capabilities.length > 50) {
    problems.push('capabilities: must contain 1 to 50 entries');
  }
  const seenSkills = new Set<string>();
  for (const capability of capabilities) {
    if (!SKILL_PATTERN.test(capability.skill)) {
      problems.push(`capabilities: '${capability.skill}' is not a valid normalized skill tag`);
    }
    if (seenSkills.has(capability.skill)) {
      problems.push(`capabilities: duplicate skill '${capability.skill}'`);
    }
    seenSkills.add(capability.skill);
    if (
      capability.level !== null &&
      !(CAPABILITY_LEVELS as readonly string[]).includes(capability.level)
    ) {
      problems.push(`capabilities: '${capability.level}' is not a valid proficiency level`);
    }
  }

  // --- availability: non-empty, strict windows, unique ---
  const availability = declaration.availability;
  if (availability.length < 1 || availability.length > 100) {
    problems.push('availability: must contain 1 to 100 windows');
  }
  const seenWindows = new Set<string>();
  for (const window of availability) {
    const dayOk = Number.isSafeInteger(window.dayOfWeek) && window.dayOfWeek >= 0 && window.dayOfWeek <= 6;
    if (!dayOk) {
      problems.push('availability: dayOfWeek must be an integer 0 (Sunday) to 6 (Saturday)');
    }
    const startOk =
      Number.isSafeInteger(window.startMinute) && window.startMinute >= 0 && window.startMinute < 1440;
    const endOk =
      Number.isSafeInteger(window.endMinute) && window.endMinute > 0 && window.endMinute <= 1440;
    if (!startOk) problems.push('availability: startMinute must be an integer 0..1439');
    if (!endOk) problems.push('availability: endMinute must be an integer 1..1440');
    if (startOk && endOk && window.startMinute >= window.endMinute) {
      problems.push('availability: startMinute must be before endMinute');
    }
    const key = `${window.dayOfWeek}:${window.startMinute}:${window.endMinute}`;
    if (seenWindows.has(key)) {
      problems.push('availability: duplicate window');
    }
    seenWindows.add(key);
  }

  // --- location / territories: strict territory objects ---
  if (declaration.location !== null) {
    problems.push(...territoryProblems('location', declaration.location));
  }
  if (declaration.territories.length > 50) {
    problems.push('territories: must contain at most 50 entries');
  }
  const seenTerritories = new Set<string>();
  for (const territory of declaration.territories) {
    problems.push(...territoryProblems('territories', territory));
    const key = `${territory.kind}:${territory.value}`;
    if (seenTerritories.has(key)) {
      problems.push(`territories: duplicate entry '${territory.value}'`);
    }
    seenTerritories.add(key);
  }

  // --- relationship continuity ---
  const continuity = declaration.relationshipContinuity;
  if (typeof continuity.prefersRepeatClients !== 'boolean') {
    problems.push('relationshipContinuity: prefersRepeatClients must be a boolean');
  }
  if (!(CONTINUITY_MODES as readonly string[]).includes(continuity.continuity)) {
    problems.push(`relationshipContinuity: '${continuity.continuity}' is not a valid continuity mode`);
  }
  const cap = continuity.maxConcurrentClientRelationships;
  if (cap !== null) {
    if (!Number.isSafeInteger(cap) || cap < 1 || cap > 100) {
      problems.push('relationshipContinuity: maxConcurrentClientRelationships must be null or an integer 1..100');
    }
  }

  // --- FIELD-AC-01 backstop (mirrors the migration 017 CHECK): the Field
  // Agent specialization requires declared geography.
  if (
    specializations.includes(FIELD_AGENT_SPECIALIZATION) &&
    declaration.location === null &&
    declaration.territories.length < 1
  ) {
    problems.push(
      'specializations: the field_agent specialization requires a declared location or at least one territory',
    );
  }

  return problems;
}

const SKILL_PATTERN = /^[a-z][a-z0-9_]{1,48}$/;
const TERRITORY_VALUE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9 ,.-]{0,99}$/;
const CONTINUITY_MODES = ['any', 'preferred', 'required'] as const;

function territoryProblems(field: string, territory: Territory): string[] {
  const problems: string[] = [];
  if (!(TERRITORY_KINDS as readonly string[]).includes(territory.kind)) {
    problems.push(`${field}: '${territory.kind}' is not a valid territory kind`);
  }
  if (!TERRITORY_VALUE_PATTERN.test(territory.value)) {
    problems.push(`${field}: territory value must be 1..100 characters (letters, digits, spaces, commas, dots, dashes)`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Durable record
// ---------------------------------------------------------------------------

/** Immutable storage shape of one persisted Human Agent profile. */
export interface HumanAgentRecord {
  readonly agentId: string;
  /** The stable platform identity link (immutable, unique). */
  readonly userId: string;
  readonly specializations: readonly HumanSpecialization[];
  readonly capabilities: readonly HumanCapability[];
  readonly availability: readonly AvailabilityWindow[];
  /** Optional current location (null when not declared). */
  readonly location: Territory | null;
  readonly territories: readonly Territory[];
  readonly reliability: ReliabilitySignals;
  readonly relationshipContinuity: RelationshipContinuity;
  readonly authorizationState: HumanAuthorizationState;
  readonly createdBy: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Job eligibility (FIELD-AC-02 — profile data only, never Client data)
// ---------------------------------------------------------------------------

/**
 * A job eligibility specification: what a (future) Job requires of a Human
 * Agent. Deliberately carries NO Client/agency identifiers — eligibility is
 * computed from PROFILE data only (FIELD-AC-02: the platform can calculate
 * job eligibility without exposing unrelated Client data).
 */
export interface JobEligibilitySpec {
  /** The specialization the job requires (e.g. 'field_agent'). */
  readonly specialization: HumanSpecialization;
  /** Required capability/skill tags (empty = no capability requirement). */
  readonly requiredCapabilities: readonly string[];
  /** Optional required territory (exact kind+value match against the profile geography). */
  readonly territory: Territory | null;
  /** The job's availability window the agent must be able to cover. */
  readonly availability: AvailabilityWindow;
}

/** Exact-match territory comparison (documented limitation: no hierarchy resolution). */
export function territoryMatches(candidate: Territory, required: Territory): boolean {
  return candidate.kind === required.kind && candidate.value === required.value;
}

/** Window overlap: same day, strictly overlapping minute ranges. */
export function availabilityCovers(
  window: AvailabilityWindow,
  required: AvailabilityWindow,
): boolean {
  return (
    window.dayOfWeek === required.dayOfWeek &&
    window.startMinute < required.endMinute &&
    required.startMinute < window.endMinute
  );
}

/**
 * PURE job-eligibility evaluation (FIELD-AC-02): does this profile match the
 * spec? Considers ONLY Human Agent profile data — authorization state,
 * specialization, required capabilities, territory and availability. It
 * never reads, receives or exposes Client data. Purity is pinned by unit
 * tests (identical inputs produce identical outputs).
 */
export function isAgentEligibleForJob(
  agent: HumanAgentRecord,
  spec: JobEligibilitySpec,
): boolean {
  if (agent.authorizationState !== 'active') return false;
  if (!agent.specializations.includes(spec.specialization)) return false;
  const skills = new Set(agent.capabilities.map((capability) => capability.skill));
  for (const required of spec.requiredCapabilities) {
    if (!skills.has(required)) return false;
  }
  if (spec.territory !== null) {
    const requiredTerritory: Territory = spec.territory;
    const geographyMatches =
      (agent.location !== null && territoryMatches(agent.location, requiredTerritory)) ||
      agent.territories.some((territory) => territoryMatches(territory, requiredTerritory));
    if (!geographyMatches) return false;
  }
  return agent.availability.some((window) => availabilityCovers(window, spec.availability));
}

// ---------------------------------------------------------------------------
// Server-side reliability observation (consumed by the future /jobs authority)
// ---------------------------------------------------------------------------

/**
 * One server-derived service observation appended to the reliability
 * aggregates (e.g. by the /jobs authority when a governed Job completes).
 * There is NO route for this input — outcome/rating are server-derived
 * values, never caller-supplied HTTP fields.
 */
export interface ReliabilityObservation {
  readonly outcome: 'succeeded' | 'failed';
  readonly onTime: boolean;
  /** Optional 1..5 quality rating (null when not rated). */
  readonly rating: number | null;
}

export function validateReliabilityObservation(
  observation: ReliabilityObservation,
): ReadonlyArray<string> {
  const problems: string[] = [];
  if (observation.outcome !== 'succeeded' && observation.outcome !== 'failed') {
    problems.push("outcome: must be 'succeeded' or 'failed'");
  }
  if (typeof observation.onTime !== 'boolean') {
    problems.push('onTime: must be a boolean');
  }
  if (observation.rating !== null) {
    if (!Number.isSafeInteger(observation.rating) || observation.rating < 1 || observation.rating > 5) {
      problems.push('rating: must be null or an integer 1..5');
    }
  }
  return problems;
}

/** Pure fold of one observation into the aggregate signals. */
export function applyReliabilityObservation(
  signals: ReliabilitySignals,
  observation: ReliabilityObservation,
): ReliabilitySignals {
  return {
    completedJobs: signals.completedJobs + 1,
    successfulJobs: signals.successfulJobs + (observation.outcome === 'succeeded' ? 1 : 0),
    onTimeCompletions: signals.onTimeCompletions + (observation.onTime ? 1 : 0),
    ratingSum: signals.ratingSum + (observation.rating ?? 0),
    ratingCount: signals.ratingCount + (observation.rating !== null ? 1 : 0),
  };
}

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

export interface FieldAgentsModuleApi {
  /**
   * Creates the Human Agent profile for a platform user (ONE profile per
   * user — DB-fenced; ConflictError on duplicate). The user must exist
   * (NotFoundError) and be ACTIVE (ConflictError — a disabled identity
   * blocks new use without rewriting history). `userId` is supplied by
   * authorized server-side callers from the authenticated principal; it is
   * NEVER a caller-supplied HTTP field. `actorId` is server-derived
   * provenance only.
   */
  createHumanAgent(input: {
    readonly userId: string;
    readonly declaration: HumanAgentDeclaration;
    readonly actorId: string | null;
  }): Promise<HumanAgentRecord>;
  /** Raw record by id (terminal contract states included). */
  getHumanAgent(agentId: string): Promise<HumanAgentRecord | null>;
  /** The profile of a platform user (null when the user has none). */
  getHumanAgentByUser(userId: string): Promise<HumanAgentRecord | null>;
  /**
   * CAS content update (ConflictError on version loss): specializations,
   * capabilities and relationship-continuity preferences. The Field-Agent
   * geography requirement is evaluated against the EXISTING location/
   * territories (the migration 017 CHECK is the final backstop).
   */
  updateProfileContent(input: {
    readonly agentId: string;
    readonly specializations: readonly HumanSpecialization[];
    readonly capabilities: readonly HumanCapability[];
    readonly relationshipContinuity: RelationshipContinuity;
    readonly expectedVersion: number;
  }): Promise<HumanAgentRecord>;
  /**
   * CAS availability/territory declaration (FIELD-AC-01): availability
   * windows, current location and service territories. The Field-Agent
   * geography requirement is evaluated against the EXISTING specializations.
   */
  declareAvailabilityTerritory(input: {
    readonly agentId: string;
    readonly availability: readonly AvailabilityWindow[];
    readonly location: Territory | null;
    readonly territories: readonly Territory[];
    readonly expectedVersion: number;
  }): Promise<HumanAgentRecord>;
  /**
   * CAS authorization/contract-state transition guarded by the frozen
   * HUMAN_AUTHORIZATION_TRANSITIONS table (row-locked transaction);
   * `contract_ended` is terminal. Platform-controlled state: agency-level
   * standing is the EXISTING /agencies membership lifecycle — never this.
   */
  setAuthorizationState(input: {
    readonly agentId: string;
    readonly authorizationState: HumanAuthorizationState;
    readonly expectedVersion: number;
  }): Promise<HumanAgentRecord>;
  /**
   * Job-eligibility lookup (FIELD-AC-02): returns the profiles matching the
   * spec, restricted to the server-supplied candidate pool (the linked
   * platform users an authorized caller resolved from durable membership
   * state — routes resolve the commissioning agency's active human_agent
   * memberships through /agencies; a null pool means "all active profiles",
   * for platform-level internal use). The result carries PROFILE DATA ONLY
   * — no Client data is read or returned by this operation.
   */
  findEligibleAgents(input: {
    readonly spec: JobEligibilitySpec;
    readonly candidateUserIds: readonly string[] | null;
  }): Promise<readonly HumanAgentRecord[]>;
  /**
   * Server-side-only reliability/quality signal update (HUMAN-AC-01
   * "reliability/quality signals"): folds one server-derived observation
   * into the aggregates under a row lock. There is NO HTTP route for this
   * — outcome/rating values are server-derived by authorized internal
   * callers (the future /jobs authority); caller-supplied outcome fields
   * are never accepted on any request surface.
   */
  recordReliabilityObservation(input: {
    readonly agentId: string;
    readonly observation: ReliabilityObservation;
  }): Promise<HumanAgentRecord>;
}

export interface FieldAgentsModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Dependency matrix: /field-agents ──→ /users (platform identity reads). */
  readonly users: UsersModuleApi;
}

export { createFieldAgentsModule } from './internal/field-agents-module.ts';
