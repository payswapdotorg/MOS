/**
 * Composition root (spec/module-dependency-matrix.md: "Provider SDKs,
 * concrete queue/storage clients, sandbox drivers, browser drivers and
 * external integration adapters are wired at the composition root").
 *
 * This is the ONLY place in src/ where concrete adapters are imported.
 * API routes, workers and domain modules depend on the contracts in
 * src/platform/<concern>/contract.ts exclusively — enforced by the static
 * architecture checker (tools/arch-check).
 *
 * MKT-002 additions:
 *   - the /users, /auth and /agencies modules are constructed here with
 *     platform ports + the allowed module-to-module dependencies
 *     (/auth → /users; /agencies → /users);
 *   - the HTTP authenticator becomes a composite: user sessions (auth module)
 *     first, then the MKT-001 internal service token — both fail closed;
 *   - optional idempotent platform-administrator bootstrap from explicit
 *     configuration (never raw-material persistence: only the scrypt
 *     verifier lands in the auth-owned credential store).
 *
 * MKT-003 additions:
 *   - the /clients module is constructed here (dependency matrix:
 *     /clients ──→ /agencies, /auth) owning Client identity, Agency→Client
 *     ownership and canonical owner resolution.
 *
 * MKT-004 additions:
 *   - the /workspaces module is constructed here (dependency matrix:
 *     /workspaces ──→ /clients) owning Workspace identity, Client→Workspace
 *     ownership and canonical owner resolution THROUGH /clients.
 *
 * MKT-005 additions (issue #13 — extend existing authorities, never
 * duplicate them):
 *   - the object-store port gains the production S3-compatible adapter
 *     (SigV4 over fetch — no SDK) next to the existing memory/fs adapters;
 *     the MKT-001 ObjectStore contract is untouched;
 *   - the advisory cache/lock capabilities are wired: a real Redis adapter
 *     when MOS_REDIS_URL is configured, or the documented degenerate
 *     adapters otherwise (NoCache + fail-closed UnavailableLock). The
 *     durable queue authority REMAINS the PostgreSQL queue — Redis is never
 *     wired as a queue or workflow authority;
 *   - the secret backend (file-based SecretStore) is wired once and handed
 *     to the /credentials module — the only consumer of material;
 *   - the /credentials (CRED-001) and /audit (AUD-001) modules are
 *     constructed here with platform ports only.
 *
 * MKT-006 additions:
 *   - the /goals module is constructed here (dependency matrix:
 *     /goals ──→ /clients, /workspaces) owning Goal identity, measurable
 *     content, lifecycle and canonical owner resolution THROUGH /clients
 *     (and /workspaces for the optional scope).
 *
 * MKT-007 additions:
 *   - the /playbooks module is constructed here (dependency matrix:
 *     /playbooks ──→ /agencies, /clients, /goals) owning Playbook
 *     identity, the Agency-or-Client ownership relation, the optional
 *     Goal link, the versioned strategy artifact with its declarative
 *     deployment metadata and the frozen version lifecycle. NO
 *     workflow/deployment/execution engine is wired (architecture.md §8:
 *     Deployment references immutable Playbook Versions and does not
 *     mutate them — /deployments is a later Work Item).
 *
 * MKT-008 additions:
 *   - the /workflows module is constructed here (dependency matrix subset:
 *     /workflows ──→ /workspaces, /playbooks) owning the Workflow
 *     DEFINITION sub-authority (WF-001): Workspace-scoped Workflow
 *     identity with server-derived Client/Agency ownership, the versioned
 *     typed graph definitions with their schemas and declarative policy
 *     blocks, the exhaustive graph validation and the
 *     immutable-after-activation lifecycle. NO workflow-instance state
 *     machine, NO runtime, NO execution or deployment authority is wired
 *     (architecture.md §10/§11 — the instance machine is MKT-009,
 *     Executions are /executions MKT-010, deployment binding is
 *     /deployments MKT-040).
 *
 * MKT-009 additions:
 *   - the /workflows module's INSTANCE sub-authority
 *     (implementation-contract §5): the Workflow instance state machine —
 *     identity pinning one immutable ACTIVE definition version, the frozen
 *     DRAFT → READY → RUNNING lifecycle with CAS, idempotency-fenced
 *     transitions and append-only history.
 *
 * MKT-010 additions:
 *   - the /executions module is constructed here (dependency matrix:
 *     /executions ──→ /workspaces) owning the NORMALIZED EXECUTION MODEL
 *     (EXEC-001): one Execution identity and lifecycle for deterministic,
 *     AI, human and extension execution — the actual runtime attempt with
 *     its task linkage (reference data), the frozen
 *     CREATED → QUEUED → STARTING → RUNNING machine with UNKNOWN/
 *     RECONCILING reconciliation semantics, the §8 DB-fenced logical
 *     idempotency key, the §24 retry classification with the explicit
 *     retry gate, and the durable sandbox LEASE relationship. NO execution
 *     ENGINE is wired: no dispatch, no queue consumption, no workers, no
 *     sandbox lifecycle (MKT-011/MKT-012); /workflows does not call
 *     /executions yet (that arrives with the runtime engine).
 *
 * MKT-013 additions:
 *   - the /evidence module is constructed here (dependency matrix subset:
 *     /evidence ──→ /clients, /workspaces) owning the append-only,
 *     server-owned EVIDENCE LEDGER (EVID-001): the 8 frozen evidence
 *     classes with their two authority tiers (claims are never
 *     auto-promoted to authoritative classes — EVID-AC-03), the A..F
 *     quality taxonomy, server-derived provenance as a separate dimension
 *     from confidence, immutable rows with DB-backstopped append-only
 *     triggers, and the single-correction supersession graph.
 *
 * MKT-014 additions:
 *   - the /metrics module is constructed here (dependency matrix: /metrics
 *     ──→ /evidence, /integrations — /evidence is the merged authority
 *     consumed for evidence_ref validation; /integrations is MKT-023/024,
 *     and /metrics owns NO provider state either way) owning the
 *     append-only METRIC OBSERVATION LEDGER (METRIC-001): normalized
 *     source-tagged observations with source/timestamp/reference mapping
 *     (observed_at vs server-stamped retrieved_at), the closed 5-value
 *     data-quality posture set, server-derived provenance, DB-backstopped
 *     append-only triggers, optional workspace scope INSIDE the owning
 *     Client and optional same-Client /evidence linkage. The REQUIRED
 *     /clients + /workspaces canonical owner resolution arrives through
 *     /metrics' declared STRUCTURAL PORTS (the public-contract instances
 *     satisfy them structurally — no forbidden module import; the frozen
 *     matrix stays intact while ownership resolution stays server-side).

 * MKT-017 additions (AI task profile and model registry, AI-001):
 *   - the /ai-runtime module is constructed here with platform ports plus
 *     EXACTLY the frozen-matrix dependency /ai-runtime ──→ /executions (the
 *     /executions public API validates telemetry execution references);
 *     it owns the REGISTRY LAYER ONLY — provider-neutral TaskProfiles, the
 *     normalized model registry with append-only observations, and usage
 *     telemetry records. NO routing/cascade engine (MKT-018), NO
 *     evaluation framework (MKT-019), NO provider adapters/SDKs and NO
 *     model invocation are wired (the pooled runtime stays untouched).

 * MKT-020 additions (logical Agent/Capability contracts, AGENT-001):
 *   - the /agents module is constructed here with PLATFORM PORTS ONLY
 *     (db/clock/ids): the frozen matrix allows /agents ──→ /executions,
 *     /ai-runtime, /policies, but the logical capability contract needs
 *     NONE of them — the logical Agent owns no tenant data, no workflow
 *     state, no deployment state and no infrastructure (architecture.md
 *     §12). It owns the provider-neutral reusable capability declaration
 *     registry (platform/agency scope, register/list/read/retire, §8-style
 *     registration fences, append-only lifecycle history). NO execution
 *     engine, NO dispatch, NO invocation, NO human/field agents (MKT-025)
 *     and NO provider adapters are wired.
 *
 * MKT-025 additions (Human Agent foundation, FIELD-001 + HUMAN-001):
 *   - the /field-agents module is constructed here as the GENERIC Human
 *     Agent authority (module-dependency-v1.3: /human-agents is represented
 *     by the existing /field-agents authority generalized — a second
 *     human-execution module is FORBIDDEN). It owns the human_agents
 *     profile table (platform identity link, specializations as capability
 *     metadata, availability/territories, relationship-continuity and the
 *     authorization/contract state) with platform ports + the allowed
 *     /users dependency only; eligibility composition happens at the route
 *     layer (the frozen matrix does not allow /field-agents → /agencies).
 *     NO job/execution engine is wired (HUMAN-AC-02: the Job authority is
 *     /jobs, MKT-026).

 * MKT-026 additions (Job marketplace boundary, JOB-001):
 *   - the /jobs module is constructed here (frozen matrix: /jobs ──→
 *     /workflows, /executions, /field-agents, /clients, /evidence,
 *     /policies; this Work Item consumes exactly /workflows READ-ONLY +
 *     /field-agents + /evidence) owning governed Task projections,
 *     candidate-specific Offers with the exactly-one-winner acceptance
 *     claim and provenance-preserving outcome submission. Workflow
 *     authority is PRESERVED: /jobs consumes /workflows' public contract
 *     read-only and never mutates instance state. Agency membership/role
 *     authorization stays at the route layer (the matrix gives /jobs no
 *     /agencies module dependency). No dispatch/execution engine is wired
 *     (HUMAN-AC-02: /jobs is not a second workflow engine — no graph, no
 *     node/edge semantics, no downstream scheduling).
 *
 * MKT-021 additions (Execution policy engine, POL-001):
 *   - the /policies module is constructed here (frozen matrix:
 *     /policies ──→ /clients, /agencies — both consumed DIRECTLY for
 *     canonical scope resolution: agency/client ownership validation on
 *     administration writes and scope re-validation before every policy
 *     read) owning the append-oriented policy VERSION records, the
 *     FAIL-CLOSED decision engine and the append-only decision records.
 *     The CRED-001 reference lookup arrives through the module's declared
 *     REFERENCE-ONLY STRUCTURAL PORT: the concrete /credentials
 *     public-contract instance satisfies the port structurally (the
 *     /metrics ownership-port precedent — the frozen matrix allows
 *     /credentials ──→ /policies, not the reverse, so no /credentials
 *     import exists inside src/modules/policies); the engine evaluates
 *     access PROPOSALS and never sees secret material or handles. NO
 *     enforcement hooks are wired: consuming modules wire enforcement in
 *     later Work Items (this engine decides and records only).

 * MKT-027 additions (Field execution and evidence, JOB-001 field subset +
 * EVID-001 field subset):
 *   - NO new module and NO new dependency is wired: the field-execution
 *     surface (visit lifecycle, structured outcomes, evidence capture,
 *     follow-up, continuity) is composed INSIDE the same /jobs module
 *     from the SAME deps (db/clock/ids/workflows/fieldAgents/evidence) —
 *     the frozen matrix is untouched. The continuity policy checkpoint
 *     consumes the merged /field-agents profile relationship-continuity
 *     block through the existing /field-agents public contract (the
 *     declared swap point for the future /policies authority, MKT-021).
 *     The /api registration adds jobs-visits-routes.ts under the same
 *     /api/jobs prefix. Migration 024_field_execution.sql is reserved for
 *     this Work Item (019/022 belong to sibling workers).
 */
import fs from 'node:fs';
import { loadConfig, type AppConfig } from './platform/config/config.ts';
import { SystemClock } from './platform/clock/clock.ts';
import { CryptoIdGenerator } from './platform/ids/ids.ts';
import { PgDb } from './platform/db/adapters/postgres/pg-db.ts';
import { runMigrations } from './platform/db/migrate.ts';
import { PgQueue } from './platform/queue/adapters/postgres/pg-queue.ts';
import { MemoryObjectStore } from './platform/objects/adapters/memory/memory-object-store.ts';
import { FsObjectStore } from './platform/objects/adapters/fs/fs-object-store.ts';
import { S3ObjectStore } from './platform/objects/adapters/s3/s3-object-store.ts';
import { RedisCache } from './platform/cache/adapters/redis/redis-cache.ts';
import { NoCache } from './platform/cache/adapters/none/no-cache.ts';
import { RedisLock } from './platform/locking/adapters/redis/redis-lock.ts';
import { UnavailableLock } from './platform/locking/adapters/none/unavailable-lock.ts';
import { FileSecretStore } from './platform/secrets/adapters/file/file-secret-store.ts';
import { ConsoleSink } from './platform/observability/adapters/console/console-sink.ts';
import { CompositeSink } from './platform/observability/adapters/composite/composite-sink.ts';
import { createLoggerFactory } from './platform/observability/logger.ts';
import { InMemoryMetrics } from './platform/observability/metrics.ts';
import { InternalTokenAuthenticator } from './platform/http/auth/adapters/internal-token/internal-token-authenticator.ts';
import { CompositeAuthenticator } from './platform/http/auth/adapters/composite/composite-authenticator.ts';
import { FetchHttpCall } from './platform/http/outbound-fetch.ts';
import { InProcessSandboxDriver } from './platform/sandboxes/adapters/in-process/in-process-sandbox-driver.ts';
import { ConfigError } from './platform/errors/errors.ts';
import type { AppServices } from './platform/app-services.ts';
import type { ObservabilitySink } from './platform/observability/contract.ts';
import type { Logger } from './platform/observability/contract.ts';
import type { CachePort } from './platform/cache/contract.ts';
import type { LockPort } from './platform/locking/contract.ts';
import { createUsersModule } from './modules/users/public.ts';
import { createAuthModule } from './modules/auth/public.ts';
import { createAgenciesModule } from './modules/agencies/public.ts';
import { createClientsModule } from './modules/clients/public.ts';
import { createWorkspacesModule } from './modules/workspaces/public.ts';
import { createCredentialsModule } from './modules/credentials/public.ts';
import { createAuditModule } from './modules/audit/public.ts';
import { createGoalsModule } from './modules/goals/public.ts';
import { createPlaybooksModule } from './modules/playbooks/public.ts';
import { createWorkflowsModule } from './modules/workflows/public.ts';
import { createExecutionsModule } from './modules/executions/public.ts';
// MKT-013: /evidence module (EVID-001).
import { createEvidenceModule } from './modules/evidence/public.ts';
// MKT-014: /metrics module (METRIC-001).
import { createMetricsModule } from './modules/metrics/public.ts';

// MKT-017: /ai-runtime registry layer (TaskProfiles, model registry,
// usage telemetry — AI-001).
import { createAiRuntimeModule } from './modules/ai-runtime/public.ts';
import { createFieldAgentsModule } from './modules/field-agents/public.ts';
// MKT-026: /jobs module (JOB-001).
import { createJobsModule } from './modules/jobs/public.ts';
// MKT-020: /agents — logical Agent/Capability contracts (AGENT-001).
import { createAgentsModule } from './modules/agents/public.ts';
// MKT-021: /policies — the execution policy engine (POL-001).
import { createPoliciesModule } from './modules/policies/public.ts';
// MKT-023: /integrations module (the provider integration boundary).
import { createIntegrationsModule } from './modules/integrations/public.ts';

import type { ApplicationModules } from './api/application.ts';

export interface AppOptions {
  /** Additional observability sinks (e.g., test collectors). */
  readonly extraSinks?: ReadonlyArray<ObservabilitySink> | undefined;
  /** Override the primary sink (tests capture records without console noise). */
  readonly primarySink?: ObservabilitySink | undefined;
}

interface Core {
  readonly services: AppServices;
  readonly modules: ApplicationModules;
}

function buildCore(config: AppConfig, options: AppOptions): Core {
  const clock = new SystemClock();
  const ids = new CryptoIdGenerator();

  const db = new PgDb(config.databaseUrl);
  const queue = new PgQueue(db, () => ids.newId(), config.queueStaleClaimMs);

  // Object store: the MKT-001 port, now with the production S3-compatible
  // adapter behind the SAME contract (wired here only — consumers unchanged).
  const objects =
    config.objectStore === 's3'
      ? new S3ObjectStore({
          endpoint: config.s3!.endpoint,
          region: config.s3!.region,
          bucket: config.s3!.bucket,
          accessKeyId: config.s3!.accessKeyId,
          secretAccessKey: config.s3!.secretAccessKey,
          pathStyle: config.s3!.pathStyle,
          requestTimeoutMs: config.s3!.requestTimeoutMs,
        })
      : config.objectStore === 'fs'
        ? new FsObjectStore(config.objectStoreDir)
        : new MemoryObjectStore();

  // Advisory cache/lock capabilities (MKT-005): a real Redis backend when
  // configured; otherwise the documented degenerate adapters. PostgreSQL
  // remains the authoritative system of record and durable queue authority
  // — Redis is wired ONLY for advisory cache and advisory locks.
  let cache: CachePort;
  let locks: LockPort;
  if (config.redis !== null) {
    const redis = config.redis;
    const shared = {
      host: redis.host,
      port: redis.port,
      username: redis.username === '' ? undefined : redis.username,
      password: redis.password === '' ? undefined : redis.password,
      secure: redis.secure,
      timeoutMs: config.redisTimeoutMs,
    };
    cache = new RedisCache({ ...shared, keyPrefix: 'mos:cache:' });
    locks = new RedisLock({ ...shared, keyPrefix: 'mos:lock:' });
  } else {
    cache = new NoCache();
    locks = new UnavailableLock();
  }

  // Secret backend: resolution-only file store (mounted-secret model).
  // Fail fast when the backend directory is absent: a half-configured
  // secret backend must abort startup, not silently fail at first resolve.
  if (!fs.existsSync(config.secretsDir) || !fs.statSync(config.secretsDir).isDirectory()) {
    throw new ConfigError('Secret backend directory does not exist', [
      `MOS_SECRETS_DIR=${config.secretsDir}: create the directory and mount secret files as <handle>.secret`,
    ]);
  }
  const secrets = new FileSecretStore({ dir: config.secretsDir });

  // Bounded provider-neutral outbound HTTP (MKT-011): the fetch transport
  // wired here only — task runners depend on the HttpCallPort contract.
  const httpCalls = new FetchHttpCall();

  // The sandbox environment driver (MKT-012): the default in-process
  // SIMULATED substrate wired here only — the /executions sandbox lifecycle
  // depends on the SandboxDriver contract, never on a concrete substrate
  // (real isolation substrates are later composition-root adapters).
  const sandboxDriver = new InProcessSandboxDriver();

  const primarySink = options.primarySink ?? new ConsoleSink();
  const sink =
    options.extraSinks === undefined || options.extraSinks.length === 0
      ? primarySink
      : new CompositeSink([primarySink, ...options.extraSinks]);

  const loggerFactory = createLoggerFactory({ sink, clock, minLevel: config.logLevel });
  const metrics = new InMemoryMetrics();

  // Module wiring (dependency matrix: /auth → /users; /agencies → /users;
  // /clients → /agencies, /auth; /workspaces → /clients; /credentials and
  // /audit import no other module — they take platform ports + plain data;
  // /goals → /clients, /workspaces; /playbooks → /agencies, /clients,
  // /goals; /workflows → /workspaces, /playbooks — the MKT-008 definition
  // sub-authority plus the MKT-009 instance sub-authority: the Workspace
  // ownership chain resolves server-side and the Playbook provenance link
  // pins explicit playbook version ids; /executions → /workspaces — the
  // MKT-010 normalized execution model: workspace-scoped runtime attempts
  // whose canonical owner chain resolves server-side).
  const users = createUsersModule({ db, clock, ids });
  const auth = createAuthModule({
    db,
    clock,
    ids,
    users,
    sessionTtlMs: config.authSessionTtlMs,
  });
  const agencies = createAgenciesModule({ db, clock, ids, users });
  const clients = createClientsModule({ db, clock, ids, agencies });
  const workspaces = createWorkspacesModule({ db, clock, ids, clients });
  const credentials = createCredentialsModule({ db, clock, ids, secrets });
  const audit = createAuditModule({ db, clock, ids });
  const goals = createGoalsModule({ db, clock, ids, clients, workspaces });
  const playbooks = createPlaybooksModule({ db, clock, ids, agencies, clients, goals });
  const workflows = createWorkflowsModule({ db, clock, ids, workspaces, playbooks });
  const executions = createExecutionsModule({ db, clock, ids, workspaces, sandboxDriver });
  // MKT-013: /evidence — platform ports + the allowed /clients +
  // /workspaces canonical-ownership dependencies (frozen matrix:
  // /evidence ──→ /clients, /workspaces, /executions; this Work Item uses
  // the /clients + /workspaces subset — /executions references evidence,
  // not the other way around, architecture.md §11).
  const evidence = createEvidenceModule({ db, clock, ids, clients, workspaces });
  // MKT-014: /metrics — platform ports + the allowed /evidence dependency
  // (frozen matrix: /metrics ──→ /evidence, /integrations; /integrations is
  // MKT-023/024 — provider data ARRIVES as normalized observations, so
  // /metrics owns NO provider state) + the /clients and /workspaces
  // canonical-ownership authorities injected through /metrics' declared
  // STRUCTURAL PORTS: the real public-contract instances satisfy the port
  // types structurally (TypeScript structural typing), so ownership
  // resolution still executes THROUGH the exact /clients + /workspaces
  // public-contract methods, server-side, with no forbidden module import.
  // (Named metricsModule to stay distinct from the platform observability
  // InMemoryMetrics instance also wired below.)
  const metricsModule = createMetricsModule({ db, clock, ids, evidence, clients, workspaces });

  // MKT-017: /ai-runtime — the REGISTRY LAYER of the AI Runtime authority
  // (dependency matrix: /ai-runtime ──→ /executions — used exactly for
  // telemetry execution-reference validation; nothing else is imported:
  // workspace scope arrives as server-derived data resolved by the routes
  // and DB-backstopped by the migration-016 scope-chain triggers).
  const aiRuntime = createAiRuntimeModule({ db, clock, ids, executions });

  // MKT-025 (Human Agent foundation): the generalized /field-agents authority.
  // Platform ports + the /users identity dependency only (frozen matrix:
  // /field-agents ──→ /users, /clients, /policies; the /clients and /policies
  // allowances belong to the Work Items that own them). No tenant linkage is
  // wired here — agency linkage is the existing /agencies membership
  // authority, composed at the route layer.
  const fieldAgents = createFieldAgentsModule({ db, clock, ids, users });

  // MKT-026 (Job marketplace boundary): the /jobs authority — governed Task
  // projections, candidate-specific offers, the concurrency-safe acceptance
  // claim and outcome submission with server-derived provenance. Frozen
  // matrix dependencies wired: /workflows (READ-ONLY Task-reference +
  // ownership resolution), /field-agents (candidate profiles + the pure
  // eligibility matcher), /evidence (outcome evidence-reference validation).
  // No /agencies dependency (route-layer composition, exactly like
  // /field-agents); no execution dispatch (the runtime is MKT-011+); /jobs
  // never mutates workflow state.
  const jobs = createJobsModule({ db, clock, ids, workflows, fieldAgents, evidence });

  // MKT-027: the field-execution surface (visits, structured outcomes,
  // evidence capture, follow-up, continuity) is composed inside the SAME
  // createJobsModule call — same deps, same lock ordering, same authority;
  // nothing further to wire here (see modules/jobs/internal/visit-module.ts).

  // MKT-020: /agents — the logical Agent/Capability contracts authority
  // (AGENT-001). PLATFORM PORTS ONLY: the frozen matrix allows
  // /agents ──→ /executions, /ai-runtime, /policies, but the reusable
  // capability declaration composes none of them (architecture.md §12:
  // the logical Agent owns no tenant data, workflow state, deployment
  // state or infrastructure). The ownership scope arrives as server-
  // derived data resolved by the routes from canonical agency ownership
  // state; the migration-022 fences, scope immutability and FK are the
  // backstops.
  const agents = createAgentsModule({ db, clock, ids });

  // MKT-021: /policies — the execution policy engine (POL-001). Frozen
  // matrix dependencies wired: /agencies + /clients (canonical scope
  // resolution — agency/client ownership validation on administration
  // writes; scope re-validation before every policy read). The CRED-001
  // reference lookup arrives through the module's REFERENCE-ONLY
  // structural port: the concrete /credentials public-contract instance
  // (getCredentialReference returns reference records WITHOUT material)
  // satisfies the port structurally — the engine evaluates access
  // proposals, never material. No enforcement hooks (later Work Items).
  const policies = createPoliciesModule({ db, clock, ids, agencies, clients, credentialReferences: credentials });

  // MKT-023: /integrations — the provider integration boundary (INT-001:
  // the generic integration ports + the first-party adapter mechanism).
  // Frozen matrix dependencies wired DIRECTLY: /policies (the fail-closed
  // decision engine consulted before every provider-touching action) and
  // /credentials (credential REFERENCE validation on registration;
  // MATERIAL resolution in the authorized-execution scope after a policy
  // allow — in-process only). The REQUIRED canonical Client ownership
  // resolution (implementation-contract §2) and the /evidence append flow
  // for verified webhook events arrive through the module's declared
  // STRUCTURAL PORTS: the concrete /clients and /evidence public-contract
  // instances satisfy the narrow port types structurally (TypeScript
  // structural typing — the metrics MKT-014 precedent), so ownership
  // resolution and evidence appends still execute server-side THROUGH
  // those public contracts while the frozen import matrix stays intact
  // (no /clients or /evidence import exists inside src/modules/
  // integrations — verified by tools/arch-check). The ADAPTER SET is
  // injected DATA: an empty registration in this Work Item (MKT-024 adds
  // the first-party Meta/Google/analytics/CRM/commerce/CMS adapters;
  // MKT-022 the extension-registry integrations) — the registry is
  // validated at construction and contains no provider branches.
  const integrations = createIntegrationsModule({
    db,
    clock,
    ids,
    policies,
    credentials,
    clientOwnership: clients,
    evidenceSink: evidence,
    adapters: [],
  });
  // Authentication order: user sessions first, then the internal service
  // token. Every path fails closed (CompositeAuthenticator).
  const authenticator = new CompositeAuthenticator([
    auth.requestAuthenticator,
    new InternalTokenAuthenticator(config.internalApiToken),
  ]);

  return {
    services: {
      config,
      clock,
      ids,
      db,
      queue,
      objects,
      cache,
      locks,
      secrets,
      httpCalls,
      auth: authenticator,
      observability: {
        sink,
        loggerFactory,
        metrics,
      },
    },
    modules: { users, auth, agencies, clients, workspaces, credentials, audit, goals, playbooks, workflows, executions, evidence, metrics: metricsModule, aiRuntime, fieldAgents, jobs, agents, policies, integrations },
  };
}

export async function buildAppServices(config: AppConfig, options: AppOptions = {}): Promise<AppServices> {
  return buildCore(config, options).services;
}

/**
 * Idempotent platform-administrator bootstrap. Runs only when explicitly
 * configured (both-or-neither enforced by config validation). If the email
 * is already registered, nothing changes — bootstrap never resets passwords.
 */
async function ensureBootstrapAdministrator(
  config: AppConfig,
  modules: ApplicationModules,
  logger: Logger,
): Promise<void> {
  if (config.bootstrapAdminEmail === '') return;

  const existing = await modules.users.getUserByEmail(config.bootstrapAdminEmail);
  if (existing !== null) {
    logger.info('identity.bootstrap.skipped', undefined, {
      email: config.bootstrapAdminEmail,
      reason: 'user already exists',
    });
    return;
  }

  const user = await modules.users.createUser({
    email: config.bootstrapAdminEmail,
    displayName: 'Platform Administrator',
  });
  await modules.users.grantPlatformRole({ userId: user.userId, role: 'platform_administrator' });
  await modules.auth.issueCredential({
    userId: user.userId,
    password: config.bootstrapAdminPassword,
  });
  logger.info('identity.bootstrap.created', undefined, { email: user.email });
}

/** Loads config from the environment and builds wired services. */
export async function bootstrapApp(options: AppOptions = {}): Promise<AppServices> {
  const config = loadConfig(process.env);
  const services = await buildAppServices(config, options);
  await runMigrations(services.db);
  return services;
}

/**
 * Full application bootstrap for the API process: services + identity
 * modules + migrations + (optionally) the bootstrap platform administrator.
 */
export async function bootstrapApplication(
  options: AppOptions = {},
): Promise<{ services: AppServices; modules: ApplicationModules }> {
  const config = loadConfig(process.env);
  const core = buildCore(config, options);
  await runMigrations(core.services.db);
  const logger = core.services.observability.loggerFactory.forModule('identity.bootstrap');
  await ensureBootstrapAdministrator(config, core.modules, logger);
  return core;
}

export { loadConfig };
