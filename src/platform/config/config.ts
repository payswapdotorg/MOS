/**
 * Explicit, validated configuration (platform runtime conventions).
 *
 * Every process (api, worker) starts from an explicit config object derived
 * from the environment. Configuration is validated once at startup and the
 * process fails fast on invalid values — no silent defaults for security-
 * relevant settings (the internal API token defaults to unset, which makes
 * authenticated routes fail closed).
 *
 * MKT-002 additions: user-session TTL and the optional (both-or-neither)
 * bootstrap platform administrator. The bootstrap credential is start-time
 * configuration only — it is never persisted as raw material; only the
 * scrypt verifier lands in the auth-owned credential store.
 *
 * MKT-005 additions: production infrastructure adapters — the S3-compatible
 * object store (behind the MKT-001 ObjectStore port), the Redis cache/lock
 * backend (advisory capabilities only; an empty MOS_REDIS_URL wires the
 * documented degenerate adapters) and the secret backend directory (the
 * file-backed SecretStore). S3 configuration is complete-or-absent: choosing
 * 's3' without every required setting aborts startup (fail fast, never a
 * half-configured production adapter).
 *
 * MKT-033 additions (DEPLOY-001): the AI Runtime provider-adapter wiring
 * (MOS_AI_PROVIDER — complete-or-absent exactly like S3: choosing
 * 'openrouter' without endpoint + API key aborts startup; the documented
 * default 'none' wires no provider adapter) and describeConfig() — the
 * REDACTED, auditable effective-configuration report every entrypoint logs
 * once at startup (DEPLOY-AC-01: one auditable configuration surface, no
 * secret material ever echoed).
 */

import { ConfigError } from '../errors/errors.ts';

export type LogLevelName = 'debug' | 'info' | 'warn' | 'error';
export type EnvironmentName = 'dev' | 'test' | 'prod';
export type ObjectStoreKind = 'memory' | 'fs' | 's3';
export type AiProviderKind = 'none' | 'openrouter';

/** Parsed Redis endpoint (advisory cache/lock backend). */
export interface RedisEndpoint {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly secure: boolean;
}

export interface AppConfig {
  /** Environment label. */
  readonly env: EnvironmentName;
  /** PostgreSQL connection string (system of record). */
  readonly databaseUrl: string;
  /** HTTP listener host. */
  readonly httpHost: string;
  /** HTTP listener port. */
  readonly httpPort: number;
  /** Maximum accepted request body size in bytes. */
  readonly httpMaxBodyBytes: number;
  /** Minimum structured log level. */
  readonly logLevel: LogLevelName;
  /** Object store abstraction implementation kind. */
  readonly objectStore: ObjectStoreKind;
  /** Filesystem root for the fs object store. */
  readonly objectStoreDir: string;
  /** S3-compatible object-storage settings (required together when objectStore === 's3'). */
  readonly s3: {
    readonly endpoint: string;
    readonly region: string;
    readonly bucket: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly pathStyle: boolean;
    readonly requestTimeoutMs: number;
  } | null;
  /** Redis endpoint for the ADVISORY cache/lock adapters; null = degenerate adapters. */
  readonly redis: RedisEndpoint | null;
  /** Per-command Redis timeout in milliseconds. */
  readonly redisTimeoutMs: number;
  /** Root directory of the file-backed secret store (mounted secrets). */
  readonly secretsDir: string;
  /** Bearer token for the platform HTTP authenticator; empty = fail closed. */
  readonly internalApiToken: string;
  /** User session lifetime in milliseconds (MKT-002 /auth sessions). */
  readonly authSessionTtlMs: number;
  /** Bootstrap platform administrator email; empty = no bootstrap. */
  readonly bootstrapAdminEmail: string;
  /** Bootstrap platform administrator initial password; empty = no bootstrap. */
  readonly bootstrapAdminPassword: string;
  /** Worker identity label; empty = generated at startup. */
  readonly workerId: string;
  /** Worker poll interval in milliseconds. */
  readonly workerPollIntervalMs: number;
  /** Maximum jobs claimed per poll batch. */
  readonly workerBatchSize: number;
  /** Default maximum attempts per job. */
  readonly jobMaxAttempts: number;
  /** Base delay for exponential retry backoff. */
  readonly jobRetryBackoffBaseMs: number;
  /**
   * Stale-claim recovery window (MKT-011): a job left 'running' by a dead
   * worker (claimed_at older than this many milliseconds) becomes
   * reclaimable — re-queued when attempts remain, dead otherwise. 0
   * disables reclaim (MKT-001 behavior).
   */
  readonly queueStaleClaimMs: number;
  /**
   * AI Runtime provider-adapter wiring (MKT-033, DEPLOY-001). null when
   * MOS_AI_PROVIDER is 'none' (the documented default — no provider
   * adapter wired). 'openrouter' requires endpoint + API key together.
   * The key is STARTUP configuration for the platform-level adapter (the
   * MOS_S3_SECRET_ACCESS_KEY precedent); tenant-scoped credential
   * references remain the /credentials authority's concern and the key
   * never reaches TaskProfiles or AdapterRequests (AI-AC-01 posture).
   */
  readonly aiRuntime: {
    readonly provider: AiProviderKind;
    readonly endpoint: string;
    readonly apiKey: string;
    readonly timeoutMs: number;
  } | null;
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): AppConfig {
  const problems: string[] = [];

  const envName = readEnum(env, 'MOS_ENV', ['dev', 'test', 'prod'], 'dev', problems);
  const logLevel = readEnum(env, 'MOS_LOG_LEVEL', ['debug', 'info', 'warn', 'error'], 'info', problems);

  const databaseUrl = env['MOS_DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    problems.push('MOS_DATABASE_URL is required (PostgreSQL is the system of record)');
  } else if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    problems.push('MOS_DATABASE_URL must be a postgres:// or postgresql:// URL');
  }

  const httpHost = env['MOS_HTTP_HOST'] ?? '127.0.0.1';
  // Port 0 is allowed: listen on an ephemeral port (used by tests and
  // sidecar processes that report their actual port in api.startup logs).
  const httpPort = readInt(env, 'MOS_HTTP_PORT', 8080, 0, 65535, problems);
  const httpMaxBodyBytes = readInt(env, 'MOS_HTTP_MAX_BODY_BYTES', 1_048_576, 1, 67_108_864, problems);

  const objectStore = readEnum(env, 'MOS_OBJECT_STORE', ['memory', 'fs', 's3'], 'memory', problems);
  const objectStoreDir = env['MOS_OBJECT_STORE_DIR'] ?? './var/objects';

  const s3 = parseS3Config(env, objectStore, problems);
  const redis = parseRedisEndpoint(env['MOS_REDIS_URL'] ?? '', problems);
  const redisTimeoutMs = readInt(env, 'MOS_REDIS_TIMEOUT_MS', 2_000, 100, 60_000, problems);
  const secretsDir = (env['MOS_SECRETS_DIR'] ?? './var/secrets').trim();
  if (secretsDir === '') {
    problems.push('MOS_SECRETS_DIR must not be blank when set');
  }

  const internalApiToken = env['MOS_INTERNAL_API_TOKEN'] ?? '';

  const authSessionTtlMs = readInt(env, 'MOS_AUTH_SESSION_TTL_MS', 12 * 60 * 60 * 1000, 60_000, 2_592_000_000, problems);

  const bootstrapAdminEmail = (env['MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL'] ?? '').trim().toLowerCase();
  const bootstrapAdminPassword = env['MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD'] ?? '';
  if ((bootstrapAdminEmail === '') !== (bootstrapAdminPassword === '')) {
    problems.push(
      'MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL and MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD must be set together (both or neither)',
    );
  } else if (bootstrapAdminPassword !== '' && bootstrapAdminPassword.length < 12) {
    problems.push('MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD must be at least 12 characters when set');
  }

  const workerId = env['MOS_WORKER_ID'] ?? '';
  const workerPollIntervalMs = readInt(env, 'MOS_WORKER_POLL_INTERVAL_MS', 500, 1, 60_000, problems);
  const workerBatchSize = readInt(env, 'MOS_WORKER_BATCH_SIZE', 5, 1, 100, problems);
  const jobMaxAttempts = readInt(env, 'MOS_JOB_MAX_ATTEMPTS', 5, 1, 100, problems);
  const jobRetryBackoffBaseMs = readInt(env, 'MOS_JOB_RETRY_BACKOFF_BASE_MS', 1_000, 1, 3_600_000, problems);
  const queueStaleClaimMs = readInt(env, 'MOS_QUEUE_STALE_CLAIM_MS', 300_000, 0, 86_400_000, problems);
  const aiRuntime = parseAiRuntimeConfig(env, problems);

  if (problems.length > 0) {
    throw new ConfigError('Invalid platform configuration', problems);
  }

  return {
    env: envName,
    databaseUrl: databaseUrl!,
    httpHost,
    httpPort,
    httpMaxBodyBytes,
    logLevel,
    objectStore,
    objectStoreDir,
    s3,
    redis,
    redisTimeoutMs,
    secretsDir,
    internalApiToken,
    authSessionTtlMs,
    bootstrapAdminEmail,
    bootstrapAdminPassword,
    workerId,
    workerPollIntervalMs,
    workerBatchSize,
    jobMaxAttempts,
    jobRetryBackoffBaseMs,
    queueStaleClaimMs,
    aiRuntime,
  };
}

function readEnum<T extends string>(
  env: Env,
  name: string,
  allowed: ReadonlyArray<T>,
  fallback: T,
  problems: string[],
): T {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  for (const candidate of allowed) {
    if (raw === candidate) return candidate;
  }
  problems.push(`${name} must be one of: ${allowed.join(', ')}`);
  return fallback;
}

function readInt(
  env: Env,
  name: string,
  fallback: number,
  min: number,
  max: number,
  problems: string[],
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || `${parsed}` !== raw.trim() || parsed < min || parsed > max) {
    problems.push(`${name} must be an integer between ${min} and ${max}`);
    return fallback;
  }
  return parsed;
}

/**
 * Parses and validates the AI Runtime provider-adapter settings (MKT-033,
 * DEPLOY-001). Complete-or-absent exactly like S3: MOS_AI_PROVIDER
 * 'openrouter' requires MOS_AI_OPENROUTER_ENDPOINT (an http(s) URL) and
 * MOS_AI_OPENROUTER_API_KEY together; the documented default 'none' wires
 * no provider adapter (settings for other providers are ignored, exactly
 * like S3 settings on a memory/fs store).
 */
function parseAiRuntimeConfig(env: Env, problems: string[]): AppConfig['aiRuntime'] {
  const provider = readEnum(env, 'MOS_AI_PROVIDER', ['none', 'openrouter'] as const, 'none', problems);
  if (provider !== 'openrouter') return null;

  const raw = {
    endpoint: env['MOS_AI_OPENROUTER_ENDPOINT'] ?? '',
    apiKey: env['MOS_AI_OPENROUTER_API_KEY'] ?? '',
  };
  const timeoutMs = readInt(env, 'MOS_AI_OPENROUTER_TIMEOUT_MS', 30_000, 100, 600_000, problems);

  const missing: string[] = [];
  if (raw.endpoint === '') missing.push('MOS_AI_OPENROUTER_ENDPOINT');
  if (raw.apiKey === '') missing.push('MOS_AI_OPENROUTER_API_KEY');
  if (missing.length > 0) {
    problems.push(`MOS_AI_PROVIDER=openrouter requires ${missing.join(', ')} to be set`);
    return null;
  }
  if (!/^https?:\/\//.test(raw.endpoint)) {
    problems.push('MOS_AI_OPENROUTER_ENDPOINT must be an http:// or https:// URL');
  }
  return {
    provider,
    endpoint: raw.endpoint,
    apiKey: raw.apiKey,
    timeoutMs,
  };
}

/**
 * The REDACTED, auditable effective-configuration report (MKT-033,
 * DEPLOY-AC-01: "one auditable configuration surface"). Both entrypoints
 * (control plane and workers) log this once at startup so the exact
 * effective configuration — every capability and its documented default —
 * is on record without EVER echoing secret material: secret-bearing
 * settings are reduced to BOOLEAN presence flags, and the flag names are
 * deliberately chosen to survive the observability layer's own
 * secret-shaped-key scrubbing (logger.ts redactSecrets), so the auditable
 * record still answers "was it configured?" for every capability.
 */
export function describeConfig(config: AppConfig): Record<string, unknown> {
  const present = (value: string): boolean => value !== '';
  return {
    env: config.env,
    logLevel: config.logLevel,
    http: {
      host: config.httpHost,
      port: config.httpPort,
      maxBodyBytes: config.httpMaxBodyBytes,
    },
    database: {
      systemOfRecord: 'postgresql',
      connectionConfigured: present(config.databaseUrl),
    },
    objectStore: {
      kind: config.objectStore,
      ...(config.objectStore === 'fs' ? { dir: config.objectStoreDir } : {}),
      ...(config.s3 === null
        ? {}
        : {
            endpoint: config.s3.endpoint,
            region: config.s3.region,
            bucket: config.s3.bucket,
            pathStyle: config.s3.pathStyle,
            requestTimeoutMs: config.s3.requestTimeoutMs,
            accessKeyConfigured: present(config.s3.accessKeyId),
            signingKeyConfigured: present(config.s3.secretAccessKey),
          }),
    },
    redis: {
      role: 'advisory-only (cache/locks — never authority)',
      configured: config.redis !== null,
      ...(config.redis === null
        ? {}
        : {
            host: config.redis.host,
            port: config.redis.port,
            secure: config.redis.secure,
            timeoutMs: config.redisTimeoutMs,
          }),
    },
    secrets: {
      backend: 'file',
      dir: config.secretsDir,
    },
    auth: {
      internalApiAuthConfigured: present(config.internalApiToken),
      sessionTtlMs: config.authSessionTtlMs,
      bootstrapAdminConfigured: present(config.bootstrapAdminPassword),
    },
    worker: {
      id: config.workerId,
      pollIntervalMs: config.workerPollIntervalMs,
      batchSize: config.workerBatchSize,
    },
    queue: {
      authority: 'postgresql',
      maxAttempts: config.jobMaxAttempts,
      retryBackoffBaseMs: config.jobRetryBackoffBaseMs,
      staleClaimMs: config.queueStaleClaimMs,
    },
    aiRuntime: {
      ...(config.aiRuntime === null
        ? { provider: 'none' as const }
        : {
            provider: config.aiRuntime.provider,
            endpoint: config.aiRuntime.endpoint,
            timeoutMs: config.aiRuntime.timeoutMs,
            providerKeyConfigured: present(config.aiRuntime.apiKey),
          }),
    },
  };
}

/**
 * Parses and validates the S3 object-storage settings (MKT-005).
 */
function parseS3Config(
  env: Env,
  objectStore: ObjectStoreKind,
  problems: string[],
): AppConfig['s3'] {
  const raw = {
    endpoint: env['MOS_S3_ENDPOINT'] ?? '',
    region: env['MOS_S3_REGION'] ?? '',
    bucket: env['MOS_S3_BUCKET'] ?? '',
    accessKeyId: env['MOS_S3_ACCESS_KEY_ID'] ?? '',
    secretAccessKey: env['MOS_S3_SECRET_ACCESS_KEY'] ?? '',
    pathStyle: env['MOS_S3_PATH_STYLE'] ?? 'true',
  };
  const requestTimeoutMs = readInt(env, 'MOS_S3_TIMEOUT_MS', 10_000, 100, 300_000, problems);

  if (objectStore !== 's3') {
    // S3 settings are ignored for other stores, but half-configured S3 on an
    // S3 store must fail fast — handled below. Here: nothing to validate.
    return null;
  }

  const missing: string[] = [];
  if (raw.endpoint === '') missing.push('MOS_S3_ENDPOINT');
  if (raw.bucket === '') missing.push('MOS_S3_BUCKET');
  if (raw.accessKeyId === '') missing.push('MOS_S3_ACCESS_KEY_ID');
  if (raw.secretAccessKey === '') missing.push('MOS_S3_SECRET_ACCESS_KEY');
  if (missing.length > 0) {
    problems.push(`MOS_OBJECT_STORE=s3 requires ${missing.join(', ')} to be set`);
    return null;
  }
  if (!/^https?:\/\//.test(raw.endpoint)) {
    problems.push('MOS_S3_ENDPOINT must be an http:// or https:// URL');
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(raw.bucket)) {
    problems.push('MOS_S3_BUCKET must be a valid S3 bucket name');
  }
  if (raw.pathStyle !== 'true' && raw.pathStyle !== 'false') {
    problems.push("MOS_S3_PATH_STYLE must be 'true' or 'false'");
    return null;
  }

  return {
    endpoint: raw.endpoint,
    region: raw.region === '' ? 'us-east-1' : raw.region,
    bucket: raw.bucket,
    accessKeyId: raw.accessKeyId,
    secretAccessKey: raw.secretAccessKey,
    pathStyle: raw.pathStyle === 'true',
    requestTimeoutMs,
  };
}

/**
 * Parses MOS_REDIS_URL (redis://[:password@]host[:port][/db] or
 * rediss:// for TLS). Empty means "no Redis backend" → degenerate cache and
 * fail-closed lock adapters (documented port behavior).
 */
function parseRedisEndpoint(url: string, problems: string[]): AppConfig['redis'] {
  if (url === '') return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    problems.push('MOS_REDIS_URL must be a valid redis:// or rediss:// URL');
    return null;
  }
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    problems.push('MOS_REDIS_URL must use the redis:// or rediss:// scheme');
    return null;
  }
  const port = parsed.port === '' ? 6379 : Number.parseInt(parsed.port, 10);
  if (parsed.hostname === '' || Number.isNaN(port) || port < 1 || port > 65535) {
    problems.push('MOS_REDIS_URL must include a host and a valid port');
    return null;
  }
  // Redis URLs encode the password in the userinfo (optionally user:pass).
  const password = decodeURIComponent(parsed.password ?? '');
  const username = parsed.username === '' ? '' : decodeURIComponent(parsed.username);
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    // A logical DB index is accepted syntactically but cache/lock keys are
    // prefixed per deployment; selecting a non-default DB is unnecessary.
    const db = parsed.pathname.replace(/^\//, '');
    if (!/^\d+$/.test(db)) {
      problems.push('MOS_REDIS_URL path component must be a numeric database index');
      return null;
    }
  }
  return {
    host: parsed.hostname,
    port,
    username,
    password,
    secure: parsed.protocol === 'rediss:',
  };
}
