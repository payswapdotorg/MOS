/**
 * Honest error surface for the in-process MOS bridge (DEP-005b).
 *
 * When the serverless-hosted MOS runtime fails to boot or serve, the failure
 * MUST be visible: a JSON body with the error message + stack plus a
 * deployment-environment diagnostic report (bundle candidate paths, pg
 * resolution, runtime env presence flags). NO secret material is ever
 * included — values are reduced to presence flags and credential-bearing
 * URL fragments are scrubbed.
 */

import { createRequire } from "node:module";
import { statSync } from "node:fs";
import { join } from "node:path";

export interface BridgeErrorBody {
  readonly error: {
    readonly code: "MOS_BRIDGE_BOOT_FAILURE" | "MOS_BRIDGE_FAILURE";
    readonly message: string;
    readonly stack?: string;
    readonly diagnostics: Record<string, unknown>;
  };
}

/** Scrubs credential-shaped substrings (postgres URLs, bearer tokens). */
export function sanitizeForErrorSurface(text: string): string {
  return text
    .replace(/(postgres(?:ql)?:\/\/[^:\s/@]+):([^@\s/]+)@/g, "$1:***@")
    .replace(/(rediss?:\/\/[^:\s/@]+):([^@\s/]+)@/g, "$1:***@")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1***")
    .replace(/(npg_[A-Za-z0-9_-]{4,})/g, "npg_***")
    .slice(0, 8000);
}

function describeError(error: unknown): { message: string; stack?: string; name: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: sanitizeForErrorSurface(error.message),
      stack: error.stack === undefined ? undefined : sanitizeForErrorSurface(error.stack).split("\n").slice(0, 30).join("\n"),
    };
  }
  return { name: "non-error throw", message: sanitizeForErrorSurface(String(error)) };
}

function bundleCandidates(): string[] {
  return [
    process.env["MOS_BUNDLE_PATH"],
    join(process.cwd(), "mos-bundle", "mos.mjs"),
    join(process.cwd(), "..", "mos-bundle", "mos.mjs"),
    join(process.cwd(), "..", "..", "mos-bundle", "mos.mjs"),
  ].filter((value): value is string => typeof value === "string" && value !== "");
}

function probePath(path: string): Record<string, unknown> {
  try {
    const stat = statSync(path);
    return { path, exists: true, bytes: stat.size, isFile: stat.isFile() };
  } catch (error) {
    return { path, exists: false, error: sanitizeForErrorSurface(String(error)).slice(0, 200) };
  }
}

function probePgResolution(): Record<string, unknown> {
  try {
    // createRequire anchor: any path under cwd resolves node_modules identically.
    const anchor = join(process.cwd(), "mos-bridge-probe.js");
    const require_ = createRequire(anchor);
    const resolved = require_.resolve("pg");
    return { resolvable: true, resolved: sanitizeForErrorSurface(resolved) };
  } catch (error) {
    return { resolvable: false, error: sanitizeForErrorSurface(String(error)).slice(0, 300) };
  }
}

const RUNTIME_ENV_KEYS = [
  "MOS_ENV",
  "MOS_DATABASE_URL",
  "MOS_LOG_LEVEL",
  "MOS_OBJECT_STORE",
  "MOS_S3_ENDPOINT",
  "MOS_S3_BUCKET",
  "MOS_S3_ACCESS_KEY_ID",
  "MOS_S3_SECRET_ACCESS_KEY",
  "MOS_S3_PATH_STYLE",
  "MOS_SECRETS_DIR",
  "MOS_INTERNAL_API_TOKEN",
  "MOS_AUTH_SESSION_TTL_MS",
  "MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL",
  "MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD",
] as const;

function runtimeEnvPresence(): Record<string, string> {
  const flags: Record<string, string> = {};
  for (const key of RUNTIME_ENV_KEYS) {
    const value = process.env[key];
    flags[key] = value === undefined || value === "" ? "MISSING" : `set(len=${value.length})`;
  }
  return flags;
}

/** Collects the deployment-environment facts that explain bridge failures. */
export function collectBridgeDiagnostics(): Record<string, unknown> {
  const candidates = bundleCandidates();
  const diagnostics: Record<string, unknown> = {
    node: process.version,
    cwd: process.cwd(),
    vercelEnv: process.env["VERCEL_ENV"] ?? "(unset)",
    vercelRegion: process.env["VERCEL_REGION"] ?? "(unset)",
    runtime: process.env["AWS_EXECUTION_ENV"] ?? "(unset)",
    bundleCandidates: candidates.map(probePath),
    pgResolution: probePgResolution(),
    runtimeEnv: runtimeEnvPresence(),
  };
  try {
    const importMetaDir = typeof __dirname === "string" ? __dirname : "(esm)";
    diagnostics["routeChunkDir"] = importMetaDir;
  } catch {
    diagnostics["routeChunkDir"] = "(unavailable)";
  }
  return diagnostics;
}

/** Builds the honest JSON error body for an unhandled bridge failure. */
export function bridgeErrorBody(
  stage: "boot" | "serve",
  error: unknown,
): BridgeErrorBody {
  const described = describeError(error);
  return {
    error: {
      code: stage === "boot" ? "MOS_BRIDGE_BOOT_FAILURE" : "MOS_BRIDGE_FAILURE",
      message: described.message,
      ...(described.stack === undefined ? {} : { stack: described.stack }),
      diagnostics: collectBridgeDiagnostics(),
    },
  };
}
