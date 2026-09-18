import { NextRequest, NextResponse } from "next/server";
import { serveMosRequest } from "@/lib/mos-request";
import { getBootedMosApp } from "@/lib/mos-runtime";
import { bridgeErrorBody } from "@/lib/mos-diagnostics";

/**
 * MOS API bridge — same-origin pure transport (DEP-003b D2, DEP-005 dual-mode).
 *
 * The browser SPA calls /api/mos/<mos-subpath> with NO XTransformPort and NO
 * absolute URLs (every client fetch stays relative-path only). Two modes:
 *
 *   - PRODUCTION (MOS_DATABASE_URL configured — the Vercel deployment): the
 *     request is served IN-PROCESS through the REAL MOS platform bundled
 *     into this deployment (bootstrapApplication + buildApiRouter singleton,
 *     see src/lib/mos-runtime.ts + src/lib/mos-request.ts). Transport only —
 *     NO logic, NO state, NO data transformation here.
 *
 *   - DEVELOPMENT (no MOS_DATABASE_URL — the sandbox): the request is
 *     forwarded server-side to the DEP-002 staging runtime MOS API
 *     (http://127.0.0.1:3010), preserving method, JSON body, Authorization +
 *     Content-Type, and ONLY the query params the browser explicitly set.
 *
 * It returns the upstream status + body verbatim, plus a small
 * `x-mos-upstream-status` header for debugging.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Where the live MOS API (DEP-002 staging runtime) listens in development. */
const UPSTREAM_ORIGIN = process.env.MOS_UPSTREAM_ORIGIN ?? "http://127.0.0.1:3010";

/** In-process mode is armed by the production MOS environment. */
const IN_PROCESS =
  (process.env.MOS_DATABASE_URL ?? "").trim() !== "" &&
  process.env.MOS_BRIDGE_FORCE_PROXY !== "1";

async function forwardToStaging(request: NextRequest): Promise<Response> {
  // /api/mos/<subpath...> → /api/<subpath...>. nextUrl.pathname is decoded,
  // so re-encode each segment to keep ids with special characters intact.
  const subpath = request.nextUrl.pathname.replace(/^\/api\/mos\//, "");
  const segments = subpath.split("/").filter((segment) => segment !== "");
  const upstreamUrl = `${UPSTREAM_ORIGIN}/api/${segments.map(encodeURIComponent).join("/")}${
    request.nextUrl.search
  }`;

  const headers: Record<string, string> = {};
  const authorization = request.headers.get("authorization");
  if (authorization !== null) headers.authorization = authorization;
  const contentType = request.headers.get("content-type");
  if (contentType !== null) headers["content-type"] = contentType;

  let body: string | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    body = await request.text();
  }

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      cache: "no-store",
    });
  } catch (cause) {
    // Transport failure only — an honest 502 envelope in the platform's
    // §23 error shape so the SPA can render it verbatim.
    return NextResponse.json(
      {
        error: {
          code: "BRIDGE_UNREACHABLE",
          message: `MOS API bridge cannot reach ${UPSTREAM_ORIGIN}: ${String(cause)}`,
        },
      },
      { status: 502, headers: { "x-mos-upstream-status": "502" } },
    );
  }

  const text = await upstream.text();
  // WHATWG parity with serveMosRequest (DEP-005b): the Response constructor
  // rejects a non-null body for 204/205/304 — MOS's credential route, for
  // one, answers 204 with no body. An empty string is still a body, so those
  // statuses must carry an explicit null (DEP-006: dev-mode 204s crashed
  // with a 500 here before this rule).
  const nullBodyStatus =
    upstream.status === 204 || upstream.status === 205 || upstream.status === 304;
  return new NextResponse(nullBodyStatus ? null : text, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "x-mos-upstream-status": String(upstream.status),
      "cache-control": "no-store",
    },
  });
}

async function forwardInProcess(request: NextRequest): Promise<Response> {
  // /api/mos/<subpath...> → /api/<subpath...> (MOS's own path space), with
  // each decoded segment re-encoded exactly like the staging proxy above.
  // DEP-005b: ANY failure outside the platform's own error envelope (i.e. a
  // cold-boot crash) surfaces as an honest JSON body — message + stack + a
  // secret-free diagnostics report — instead of an empty 500.
  try {
    const subpath = request.nextUrl.pathname.replace(/^\/api\/mos\//, "");
    const segments = subpath.split("/").filter((segment) => segment !== "");
    const mosPath = `/api/${segments.map(encodeURIComponent).join("/")}${request.nextUrl.search}`;
    const response = await serveMosRequest(request, mosPath);
    return new NextResponse(response.body, {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") ?? "application/json",
        "x-mos-upstream-status": String(response.status),
      },
    });
  } catch (error) {
    const stage = getBootedMosApp() === null ? "boot" : "serve";
    return NextResponse.json(bridgeErrorBody(stage, error), {
      status: 500,
      headers: { "x-mos-upstream-status": "500", "cache-control": "no-store" },
    });
  }
}

async function forward(request: NextRequest): Promise<Response> {
  return IN_PROCESS ? forwardInProcess(request) : forwardToStaging(request);
}

export async function GET(request: NextRequest): Promise<Response> {
  return forward(request);
}

export async function POST(request: NextRequest): Promise<Response> {
  return forward(request);
}

export async function PUT(request: NextRequest): Promise<Response> {
  return forward(request);
}

export async function PATCH(request: NextRequest): Promise<Response> {
  return forward(request);
}

export async function DELETE(request: NextRequest): Promise<Response> {
  return forward(request);
}
