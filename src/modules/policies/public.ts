/**
 * MarketingOS module: /policies
 * Authority: Policies (spec/implementation-contract.md §1).
 *
 * MKT-021 implements this authority (POL-001 + CRED-001 evaluation posture).
 * This module owns the EXECUTION POLICY ENGINE:
 *
 *   - the DECLARED POLICY BOUNDARIES for the seven frozen dimensions
 *     (requirements.md POL-001: "AI, tools, network, secrets, deployment,
 *     field actions and extensions"): one append-oriented POLICY VERSION
 *     record per (scope, dimension) — content is immutable after
 *     declaration; a new version SUPERSEDES the prior active one in the
 *     same transaction (the old row stays queryable forever; policy
 *     history is never overwritten). `superseded` is terminal
 *     (DB-triggered);
 *   - the SCOPE MODEL of the frozen tenant tree (architecture.md §4:
 *     "Agency Policies" and "Client Policy" are distinct tree nodes):
 *     policies are declared at PLATFORM scope (platform defaults), AGENCY
 *     scope (the commercial tenant) or CLIENT scope (the hard security
 *     boundary). Scope is SERVER-DERIVED: routes resolve it from canonical
 *     durable state (the /agencies and /clients public contracts) before
 *     any write, a caller-supplied scope is rejected, and the ownership is
 *     immutable once set (DB trigger + cross-tenant fence);
 *   - the DECISION ENGINE: evaluateAction(action, scope) -> decision with
 *     outcome 'allow' | 'deny' | 'unknown' (+ reason code, human reasons
 *     and the matched policy versions). Composition across the scope
 *     chain is DENY-OVERRIDES: any matching deny rule at any scope level
 *     (client > agency > platform consulted together) denies; allows
 *     union across levels; nothing matching and/or no active policy at
 *     any level leaves the action UNDECIDED ('unknown');
 *   - FAIL-CLOSED evaluation (the POL-001 acceptance): enforcement treats
 *     ONLY outcome 'allow' as permission — 'deny', 'unknown', missing
 *     policy state, ambiguous scope, unresolved credential references and
 *     evaluation errors all deny (never allow by default). The explicit
 *     fail-closed triggers: missing policy (no-active-policy /
 *     no-matching-rule -> 'unknown'), evaluation error (-> recorded 'deny'
 *     decision, reason 'evaluation-error'), ambiguous scope (-> recorded
 *     'deny' decision, reason 'ambiguous-scope'), unknown dimension
 *     (rejected by the input guard — fail-closed by rejection);
 *   - the APPEND-ONLY DECISION RECORDS: every evaluation is recorded once
 *     in policy_decisions with SERVER-DERIVED provenance (who asked, what
 *     was evaluated, what was decided, why) and correlation/causation
 *     identities; the DB rejects UPDATE and DELETE (audit retention).
 *     Decision outcomes, reason codes and provenance are never
 *     request-suppliable (route validation rejects them; the module API
 *     takes provenance as its own server-built argument);
 *   - CRED-001 evaluation posture: the engine evaluates ACCESS PROPOSALS
 *     for secrets (credential reference + operation) and NEVER sees
 *     secret material. The credential reference is resolved through a
 *     narrow REFERENCE-ONLY view of the /credentials public contract (a
 *     structural port — kind/scope/status metadata, no handle, no
 *     material; the frozen matrix does not allow /policies →
 *     /credentials, so the port is declared here and wired at the
 *     composition root exactly like /metrics' ownership ports).
 *
 * What this module deliberately does NOT do (bounded scope, MKT-021):
 *   - NO enforcement hooks: consuming modules (/executions, /ai-runtime,
 *     /jobs, /field-agents, /extensions, /integrations, /deployments) wire
 *     enforcement in LATER Work Items — this engine decides and records;
 *   - NO credential storage/resolution: /credentials stays the only
 *     credential authority (CRED-001); this module holds references only;
 *   - NO extension manifests (MKT-022), NO deployment lifecycle (MKT-033/
 *     MKT-040), NO workflow/execution state, NO routing strategies;
 *   - NO second tenant/permission/audit authority: authorization for the
 *     administration surfaces stays exactly the /agencies membership
 *     authority composed with /clients canonical owner resolution.
 *
 * DEPENDENCY POSTURE (frozen matrix: /policies ──→ /clients, /agencies):
 * this public entry imports the /clients and / /agencies public contracts
 * DIRECTLY (the two matrix-allowed dependencies) for canonical scope
 * resolution. The /credentials reference lookup arrives through the
 * STRUCTURAL PORT declared below (the frozen matrix allows
 * /credentials ──→ /policies, not the reverse; the concrete
 * CredentialsModuleApi satisfies the port structurally at the composition
 * root — the /metrics ownership-port precedent).
 *
 * Cross-module access may only target this public entry (public.ts) —
 * internal/ is unimportable from other modules (enforced by the static
 * architecture checker, tools/arch-check).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import type { AgenciesModuleApi } from '../agencies/public.ts';
import type { ClientsModuleApi } from '../clients/public.ts';

// ---------------------------------------------------------------------------
// The seven frozen policy dimensions (POL-001)
// ---------------------------------------------------------------------------

/**
 * The closed dimension set of POL-001: "Provide policy boundaries for AI,
 * tools, network, secrets, deployment, field actions and extensions."
 * Extension is a code + DB migration change, never a caller freedom.
 */
export type PolicyDimension = 'ai' | 'tools' | 'network' | 'secrets' | 'deployment' | 'field' | 'extension';

export const POLICY_DIMENSIONS: readonly PolicyDimension[] = [
  'ai',
  'tools',
  'network',
  'secrets',
  'deployment',
  'field',
  'extension',
];

/** Interpretable meaning of every dimension (traceability requirement). */
export const POLICY_DIMENSION_MEANINGS: Readonly<Record<PolicyDimension, string>> = {
  ai: 'AI model/tool usage boundaries (model invocation, tool use inside AI runtime)',
  tools: 'tool invocation boundaries (deterministic and AI-carried tools)',
  network: 'network egress boundaries (outbound hosts/protocols from execution contexts)',
  secrets: 'secret/credential access boundaries (CRED-001 reference access proposals)',
  deployment: 'marketing cloud deployment action boundaries (deploy/pause/resume/redeploy/rollback)',
  field: 'field action boundaries (Human/Field Agent job participation and field-side effects)',
  extension: 'extension boundaries (install/configure/invoke of extension versions)',
};

export function isKnownPolicyDimension(value: string): value is PolicyDimension {
  return (POLICY_DIMENSIONS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Scope (the frozen tenant tree levels where boundaries are declared)
// ---------------------------------------------------------------------------

/**
 * The declaration scope of one policy version: 'platform' (platform
 * defaults — agency_id null), 'agency' (the commercial tenant), or
 * 'client' (the hard security boundary — architecture.md §4 "Client
 * Policy"). SERVER-DERIVED on every write path; immutable once set.
 */
export type PolicyScopeKind = 'platform' | 'agency' | 'client';

/**
 * The scope input of policy administration: agencyId/clientId are
 * SERVER-DERIVED (routes resolve them from canonical durable ownership
 * state) — platform scope is {agencyId: null, clientId: null}, agency
 * scope {agencyId, null}, client scope {agencyId, clientId}.
 */
export interface PolicyDeclarationScope {
  readonly agencyId: string | null;
  readonly clientId: string | null;
}

/**
 * The scope of one evaluation: always tenant-resolved (agency-wide or
 * client-narrowed inside the agency). SERVER-SUPPLIED by the caller from
 * canonical durable state; the module re-validates it THROUGH the
 * /clients + /agencies public contracts before any policy read.
 */
export interface PolicyEvaluationScope {
  readonly agencyId: string;
  readonly clientId: string | null;
}

// ---------------------------------------------------------------------------
// Rules — the declared boundary statements
// ---------------------------------------------------------------------------

/**
 * One declared boundary rule. Matching semantics (frozen, pure, tested):
 * a rule matches an action iff
 *   1. rule.operations includes the action operation or '*'; AND
 *   2. rule.resource is null/absent/'*', or equals the action resource; AND
 *   3. EVERY rule attribute key is present on the action's effective
 *      attributes with the same value ('*' matches any present value).
 * Effect composition across the consulted scope chain is DENY-OVERRIDES
 * (any matching deny denies; otherwise any matching allow allows;
 * otherwise undecided). Attributes are scalars: string keys → string
 * values (bounded).
 */
export interface PolicyRule {
  readonly effect: 'allow' | 'deny';
  /** Non-empty list of operation labels, or ['*'] for all operations. */
  readonly operations: readonly string[];
  /** Optional primary resource selector (model id, tool name, host, extension id, credential kind...) or '*' for any. */
  readonly resource: string | null;
  /** Optional additional selector match (every key must be present and equal; '*' matches any present value). */
  readonly attributes: Readonly<Record<string, string>>;
  /** Bounded human explanation recorded on matching decisions. */
  readonly reason: string;
}

/**
 * Attribute keys the engine derives SERVER-SIDE for the secrets dimension
 * (from the resolved CRED-001 credential reference) — caller-supplied
 * values for these keys are ignored/overwritten: credential-shaped
 * authority fields are never request-suppliable (security-threat-model
 * "Caller-supplied authority fields").
 */
export const RESERVED_CREDENTIAL_ATTRIBUTE_KEYS = [
  'credentialKind',
  'credentialClientId',
  'credentialStatus',
] as const;

/**
 * Material-shaped keys that can never appear in any policy payload (the
 * §21 secret-leak backstop at the module boundary): the policy engine
 * evaluates ACCESS PROPOSALS, never material.
 */
export const POLICY_MATERIAL_SHAPED_KEYS = [
  'secret',
  'secretMaterial',
  'material',
  'password',
  'token',
  'apiKey',
  'api_key',
  'accessKey',
  'secretHandle',
] as const;

// ---------------------------------------------------------------------------
// The action descriptor evaluated by the engine
// ---------------------------------------------------------------------------

/**
 * The proposed action evaluated against the declared boundaries: the
 * dimension, the operation label (dimension-specific vocabulary owned by
 * the consuming authority — e.g. 'invoke' for tools, 'egress' for network,
 * 'read'/'write' for secrets, 'deploy'/'rollback' for deployment), an
 * optional primary resource selector and bounded additional attribute
 * selectors. For the secrets dimension the engine resolves `resource` as
 * a CREDENTIAL REFERENCE id and derives the credential-shaped effective
 * attributes SERVER-SIDE (never from the request).
 */
export interface PolicyActionDescriptor {
  readonly dimension: PolicyDimension;
  readonly operation: string;
  readonly resource: string | null;
  readonly attributes: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Decision outcomes, reason codes and records
// ---------------------------------------------------------------------------

/**
 * The frozen decision outcome vocabulary (the POL-001 acceptance matrix:
 * dimensions x allow/deny/unknown). Enforcement consumes
 * `enforcementOutcome` — everything that is not an explicit 'allow' DENIES.
 */
export type PolicyOutcome = 'allow' | 'deny' | 'unknown';

/**
 * The closed reason-code set — the machine-checkable WHY of every
 * decision (recorded on the append-only decision record):
 *   rule-allowed / rule-denied       — an explicit rule decided;
 *   no-matching-rule                 — active versions exist, none match
 *                                      (undecided → 'unknown');
 *   no-active-policy                 — no active version for the dimension
 *                                      at any scope level (missing policy
 *                                      state → 'unknown');
 *   ambiguous-scope                  — scope failed canonical resolution
 *                                      (fail-closed 'deny');
 *   credential-reference-unresolved  — the CRED-001 access proposal
 *                                      referenced an unknown/ unusable
 *                                      credential reference (fail-closed
 *                                      'deny');
 *   credential-scope-mismatch        — the reference belongs to another
 *                                      tenant scope (fail-closed 'deny');
 *   evaluation-error                 — the evaluation itself errored
 *                                      (fail-closed 'deny', recorded).
 */
export type PolicyReasonCode =
  | 'rule-allowed'
  | 'rule-denied'
  | 'no-matching-rule'
  | 'no-active-policy'
  | 'ambiguous-scope'
  | 'credential-reference-unresolved'
  | 'credential-scope-mismatch'
  | 'evaluation-error';

export const POLICY_REASON_CODES: readonly PolicyReasonCode[] = [
  'rule-allowed',
  'rule-denied',
  'no-matching-rule',
  'no-active-policy',
  'ambiguous-scope',
  'credential-reference-unresolved',
  'credential-scope-mismatch',
  'evaluation-error',
];

/** SERVER-DERIVED decision provenance (never a request field). */
export interface PolicyDecisionProvenance {
  /** Server-derived actor label: 'user:<uuid>' | 'service:<label>' | 'worker:<label>'. */
  readonly actor: string;
  /** Server-derived evaluation surface label ('api' for the HTTP surface). */
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

/** Provenance block as persisted on the append-only decision record. */
export interface PolicyRecordedProvenance extends PolicyDecisionProvenance {
  /** Server-stamped decision time (module clock; never caller input). */
  readonly recordedAt: string;
  /** Server-stamped evaluation start (kept distinct from recordedAt). */
  readonly evaluatedAt: string;
}

/** One append-only policy decision record. */
export interface PolicyDecisionRecord {
  readonly decisionId: string;
  readonly dimension: PolicyDimension;
  readonly agencyId: string;
  readonly clientId: string | null;
  readonly outcome: PolicyOutcome;
  readonly reasonCode: PolicyReasonCode;
  readonly reasons: readonly string[];
  /** The action descriptor as evaluated (sanitized — never secret material). */
  readonly action: PolicyActionDescriptor;
  /** Policy version ids consulted at evaluation time (may be empty). */
  readonly matchedPolicyVersions: readonly string[];
  readonly provenance: PolicyRecordedProvenance;
}

/**
 * The enforcement answer of a decision: ONLY an explicit 'allow' permits —
 * 'deny' AND 'unknown' both deny (the POL-001 fail-closed contract; pure).
 */
export function enforcementOutcome(decision: Pick<PolicyDecisionRecord, 'outcome'>): 'allow' | 'deny' {
  return decision.outcome === 'allow' ? 'allow' : 'deny';
}

// ---------------------------------------------------------------------------
// Policy version records (append-oriented declaration history)
// ---------------------------------------------------------------------------

/**
 * One immutable POLICY VERSION row. Content (dimension, scope, rules,
 * description, provenance) is immutable after declaration; the only
 * lifecycle edge is active → superseded (terminal) applied by the NEXT
 * version's declaration in the same transaction. versionSeq is the
 * monotonic per-(scope, dimension) sequence — the append-oriented
 * versioning history stays queryable forever.
 */
export interface PolicyVersionRecord {
  readonly policyId: string;
  readonly dimension: PolicyDimension;
  readonly scopeKind: PolicyScopeKind;
  readonly agencyId: string | null;
  readonly clientId: string | null;
  readonly status: 'active' | 'superseded';
  readonly versionSeq: number;
  readonly rules: readonly PolicyRule[];
  readonly description: string;
  readonly createdBy: string | null;
  readonly supersededAt: string | null;
  readonly supersededByPolicyId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// The CRED-001 reference-only structural port (see module header)
// ---------------------------------------------------------------------------

/**
 * The narrow REFERENCE-ONLY view of a credential reference the policy
 * engine consumes: kind/scope/status metadata — deliberately EXCLUDES the
 * backend handle and, obviously, any material (implementation-contract
 * §21: the engine evaluates access proposals, it never sees material).
 */
export interface PolicyCredentialReferenceSnapshot {
  readonly credentialId: string;
  readonly agencyId: string;
  readonly clientId: string | null;
  readonly kind: string;
  readonly status: string;
}

/**
 * The slice of the /credentials public contract the policy engine depends
 * on: raw reference lookup by id (references only — the concrete
 * CredentialsModuleApi.getCredentialReference satisfies this structurally;
 * wired at the composition root; the frozen import matrix stays intact).
 */
export interface CredentialReferenceLookupPort {
  getCredentialReference(credentialId: string): Promise<PolicyCredentialReferenceSnapshot | null>;
}

// ---------------------------------------------------------------------------
// The pure decision core (the policy matrix evaluator)
// ---------------------------------------------------------------------------

/**
 * The effective attributes of one action for rule matching: the caller's
 * bounded attributes with the SERVER-DERIVED credential metadata composed
 * on top for the secrets dimension (reserved keys are never
 * caller-suppliable).
 */
export interface PolicyEffectiveAttributes {
  readonly dimension: PolicyDimension;
  readonly operation: string;
  readonly resource: string | null;
  readonly attributes: Readonly<Record<string, string>>;
}

/** The policy versions consulted for one evaluation, in scope chain order. */
export interface ConsultedPolicyVersion {
  readonly policyId: string;
  readonly scopeKind: PolicyScopeKind;
  readonly rules: readonly PolicyRule[];
}

/** The pure evaluation result before persistence. */
export interface PolicyEvaluationCoreResult {
  readonly outcome: PolicyOutcome;
  readonly reasonCode: PolicyReasonCode;
  readonly reasons: readonly string[];
  readonly matchedPolicyVersions: readonly string[];
}

/**
 * Pure rule match (frozen semantics; see PolicyRule). Exported for the
 * matrix unit tests.
 */
export function matchesPolicyRule(
  action: PolicyEffectiveAttributes,
  rule: PolicyRule,
): boolean {
  if (!(rule.operations as readonly string[]).includes(action.operation) && !(rule.operations as readonly string[]).includes('*')) {
    return false;
  }
  if (
    rule.resource !== null &&
    rule.resource !== undefined &&
    rule.resource !== '*' &&
    rule.resource !== action.resource
  ) {
    return false;
  }
  for (const [key, value] of Object.entries(rule.attributes ?? {})) {
    const actual = action.attributes[key];
    if (actual === undefined) return false;
    if (value !== '*' && value !== actual) return false;
  }
  return true;
}

/**
 * The pure DECISION CORE: evaluates one action against the consulted
 * active policy versions (scope chain order — client, agency, platform).
 * DENY-OVERRIDES composition:
 *   - any matching deny rule at ANY level → 'deny' (reason-code
 *     'rule-denied'; reasons carry every matched deny rule reason);
 *   - else any matching allow rule → 'allow' ('rule-allowed');
 *   - else 'unknown': 'no-matching-rule' when at least one active version
 *     exists but nothing matched; 'no-active-policy' when NO active
 *     version exists at any level (missing policy state).
 * Identical inputs always produce the identical decision (pure).
 */
export function evaluatePolicyMatrix(
  action: PolicyEffectiveAttributes,
  consulted: readonly ConsultedPolicyVersion[],
): PolicyEvaluationCoreResult {
  const matchedDenyReasons: string[] = [];
  const matchedAllowIds: string[] = [];

  for (const version of consulted) {
    for (const rule of version.rules) {
      if (!matchesPolicyRule(action, rule)) continue;
      if (rule.effect === 'deny') {
        matchedDenyReasons.push(rule.reason);
      } else {
        matchedAllowIds.push(version.policyId);
      }
    }
  }

  if (matchedDenyReasons.length > 0) {
    const matchedDenyIds = consulted
      .filter((version) =>
        version.rules.some((rule) => rule.effect === 'deny' && matchesPolicyRule(action, rule)),
      )
      .map((version) => version.policyId);
    return {
      outcome: 'deny',
      reasonCode: 'rule-denied',
      reasons: matchedDenyReasons,
      matchedPolicyVersions: matchedDenyIds,
    };
  }

  if (matchedAllowIds.length > 0) {
    return {
      outcome: 'allow',
      reasonCode: 'rule-allowed',
      reasons: ['explicit allow rule matched in the resolved scope chain'],
      matchedPolicyVersions: matchedAllowIds,
    };
  }

  if (consulted.length > 0) {
    return {
      outcome: 'unknown',
      reasonCode: 'no-matching-rule',
      reasons: [
        `active policy versions exist for dimension '${action.dimension}' but no rule matches the proposed action`,
      ],
      matchedPolicyVersions: [],
    };
  }

  return {
    outcome: 'unknown',
    reasonCode: 'no-active-policy',
    reasons: [
      `no active policy version exists for dimension '${action.dimension}' in the resolved scope chain`,
    ],
    matchedPolicyVersions: [],
  };
}

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

export interface PoliciesModuleApi {
  /**
   * Declares ONE policy version (the only creation path). The scope is
   * SERVER-DERIVED input resolved by the caller from canonical ownership
   * state (platform: both null; agency; client) and re-validated THROUGH
   * the /agencies + /clients public contracts inside the module. A
   * declaration of a (scope, dimension) that has an ACTIVE version
   * SUPERSEDES it in the same transaction: the prior row becomes
   * 'superseded' (terminal, supersededAt/supersededByPolicyId set — the
   * history stays queryable forever) and the new row is born ACTIVE with
   * versionSeq = prior + 1 (monotonic; first declaration = 1). Rules are
   * validated against the frozen shape guard (§21 material-key backstop
   * included). Unknown agency/client, or a client not owned by the scope
   * agency → uniform NotFoundError; disabled agency/client →
   * ConflictError (new declarations blocked without rewriting history).
   */
  declarePolicyVersion(input: {
    readonly scope: PolicyDeclarationScope;
    readonly dimension: PolicyDimension;
    readonly rules: readonly PolicyRule[];
    readonly description: string;
    readonly actorId: string | null;
  }): Promise<PolicyVersionRecord>;
  /** Raw version by id (superseded history included — always readable). */
  getPolicyVersion(policyId: string): Promise<PolicyVersionRecord | null>;
  /**
   * The declared versions of one scope, newest (highest versionSeq) first.
   * `includeSuperseded` keeps the append-oriented history visible. The
   * platform scope (both null) lists platform versions; agency/client
   * scopes list their own. Unknown agency/client → NotFoundError.
   */
  listPolicyVersions(input: {
    readonly scope: PolicyDeclarationScope;
    readonly dimension: PolicyDimension | null;
    readonly includeSuperseded: boolean;
  }): Promise<readonly PolicyVersionRecord[]>;
  /** The ACTIVE version of one (scope, dimension) — null when undeclared. */
  getActivePolicyVersion(input: {
    readonly scope: PolicyDeclarationScope;
    readonly dimension: PolicyDimension;
  }): Promise<PolicyVersionRecord | null>;
  /**
   * FAIL-CLOSED policy evaluation. The action descriptor is guarded
   * (unknown dimension / malformed shape → InvalidRequestError — fail
   * closed by rejection); the scope is re-resolved THROUGH the /clients +
   * /agencies public contracts BEFORE any policy read (ambiguous scope →
   * recorded 'deny' decision, reason 'ambiguous-scope'); the secrets
   * dimension resolves the credential REFERENCE through the CRED-001
   * port (references only — unresolved/mismatched → recorded 'deny').
   * The decision is composed by the pure DENY-OVERRIDES core and RECORDED
   * append-only with server-derived provenance. Evaluation errors produce
   * a recorded 'deny' decision (reason 'evaluation-error'); if even the
   * decision record cannot be persisted, BackendUnavailableError is
   * thrown — never an allow. Enforcement (later Work Items) consumes
   * `enforcementOutcome`: only 'allow' permits.
   */
  evaluateAction(input: {
    readonly action: PolicyActionDescriptor;
    readonly scope: PolicyEvaluationScope;
  }, provenance: PolicyDecisionProvenance): Promise<PolicyDecisionRecord>;
  /** Raw decision by id — the append-only audit trail is always readable. */
  getPolicyDecision(decisionId: string): Promise<PolicyDecisionRecord | null>;
  /**
   * The agency's append-only decision ledger, newest first (bounded,
   * server-chosen limit); optional client narrowing. Unknown agency →
   * NotFoundError.
   */
  listPolicyDecisions(input: {
    readonly agencyId: string;
    readonly clientId: string | null;
  }): Promise<readonly PolicyDecisionRecord[]>;
}

export interface PoliciesModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * Frozen matrix (/policies ──→ /clients, /agencies): the canonical
   * agency authority — scope resolution and listing validation.
   */
  readonly agencies: AgenciesModuleApi;
  /**
   * Frozen matrix: the canonical Client ownership authority — client-scope
   * resolution before dependent traversal (the hard security boundary).
   */
  readonly clients: ClientsModuleApi;
  /**
   * The CRED-001 REFERENCE-ONLY structural port (see the module header):
   * the concrete /credentials public-contract instance is wired at the
   * composition root; the engine never sees material or handles.
   */
  readonly credentialReferences: CredentialReferenceLookupPort;
}

export { createPoliciesModule } from './internal/module.ts';
/**
 * The input guards (action/rule-set/provenance validation + the §21
 * material-key backstop + scope shape checks) and the pure decision core
 * helpers — exported for unit tests and future server-side callers (the
 * enforcement Work Items) so the guard semantics are part of the module
 * contract. Pure functions.
 */
export {
  assertValidPolicyAction,
  assertValidPolicyDeclarationInput,
  assertValidPolicyDecisionProvenance,
  composeSecretsEffectiveAttributes,
} from './internal/store.ts';
