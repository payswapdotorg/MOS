/**
 * Server-side MOS transport for Next.js route handlers (DEP-006).
 *
 * The same DUAL-MODE selection the API bridge uses
 * (src/app/api/mos/[...path]/route.ts — read before changing this):
 *
 *   - PRODUCTION (MOS_DATABASE_URL configured — the Vercel deployment): calls
 *     are served IN-PROCESS through the real MOS platform bundled into the
 *     deployment (serveMosRequest from src/lib/mos-request.ts).
 *
 *   - DEVELOPMENT (no MOS_DATABASE_URL — the sandbox): calls are forwarded
 *     server-side to the DEP-002 staging runtime MOS API
 *     (http://127.0.0.1:3010 by default).
 *
 * Unlike the bridge (a pure byte-passthrough with no logic), this helper is
 * for server-side ORCHESTRATORS (e.g. the sign-up route) that need to make
 * several MOS calls themselves: it takes a typed JSON call and returns the
 * upstream status + parsed body. Still NO authority logic lives here.
 */

import { serveMosRequest } from "./mos-request";

/** Where the live MOS API (DEP-002 staging runtime) listens in development. */
export const MOS_UPSTREAM_ORIGIN = process.env.MOS_UPSTREAM_ORIGIN ?? "http://127.0.0.1:3010";

/** In-process mode is armed by the production MOS environment (bridge parity). */
export const MOS_IN_PROCESS =
  (process.env.MOS_DATABASE_URL ?? "").trim() !== "" &&
  process.env.MOS_BRIDGE_FORCE_PROXY !== "1";

export type MosMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface MosServerCall {
  /** MOS HTTP method. */
  method: MosMethod;
  /** Full MOS path INCLUDING any query string, e.g. "/api/auth/login". */
  path: string;
  /** JSON body (serialized when present). */
  body?: unknown;
  /** Bearer token when the call is authenticated. */
  token?: string | null;
}

export interface MosServerCallResult {
  status: number;
  /** Parsed JSON body when the response is valid JSON, else null. */
  body: unknown;
  /** The raw response text (for honest error surfacing). */
  text: string;
}

function buildHeaders(call: MosServerCall): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (call.body !== undefined) headers["content-type"] = "application/json";
  if (call.token !== null && call.token !== undefined) {
    headers.authorization = `Bearer ${call.token}`;
  }
  return headers;
}

/** One MOS API call through the dual-mode transport. Transport only. */
export async function callMosApi(call: MosServerCall): Promise<MosServerCallResult> {
  if (MOS_IN_PROCESS) {
    // In-process: a synthetic Request against MOS's own router, exactly the
    // way the bridge's forwardInProcess serves browser traffic.
    const request = new Request(`http://mos.in-process${call.path}`, {
      method: call.method,
      headers: buildHeaders(call),
      ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
    });
    const response = await serveMosRequest(request, call.path);
    const text = await response.text();
    return { status: response.status, body: parseJson(text), text };
  }

  // Development: forward to the staging runtime (same forwarding contract as
  // the bridge — method, JSON body, Authorization + Content-Type only).
  const response = await fetch(`${MOS_UPSTREAM_ORIGIN}${call.path}`, {
    method: call.method,
    headers: buildHeaders(call),
    ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
    cache: "no-store",
  });
  const text = await response.text();
  return { status: response.status, body: parseJson(text), text };
}

function parseJson(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Reads `{error:{code,message,...}}` from a MOS error body, if present. */
export function mosErrorCode(result: MosServerCallResult): string {
  const envelope = result.body as { error?: { code?: unknown } } | null;
  const code = envelope?.error?.code;
  return typeof code === "string" ? code : `HTTP_${result.status}`;
}
