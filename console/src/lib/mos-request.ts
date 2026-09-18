/**
 * Web Request → MOS router adapter (DEP-005) — the serverless twin of MOS's
 * src/platform/http/server.ts request handling. Transport only: it reproduces
 * exactly the standalone server's behavior (correlation middleware, strict
 * JSON body + size limit, typed error envelope, request logging) against the
 * in-process router, with zero authority logic of its own.
 */

import { getMosApp, type MosRequestContext } from "./mos-runtime";

const CORRELATION_HEADER = "x-correlation-id";

/**
 * Serves one MOS API request in-process. `mosPath` is the full MOS path
 * INCLUDING the query string (e.g. "/api/agencies/<id>?limit=10") — the same
 * string the standalone server would have received in `req.url`.
 */
export async function serveMosRequest(request: Request, mosPath: string): Promise<Response> {
  const app = await getMosApp();
  const logger = app.services.observability.loggerFactory.forModule("platform.http");
  const startedMs = app.services.clock.nowMs();
  const method = request.method.toUpperCase();

  // --- correlation middleware (server.ts parity) ---------------------------
  const supplied = headerValue(request.headers, CORRELATION_HEADER);
  let correlationId: string;
  if (supplied === undefined || supplied === "" || !app.bundle.isUuid(supplied)) {
    correlationId = app.services.ids.newId();
    if (supplied !== undefined && supplied !== "") {
      logger.warn(
        "http.correlation.rejected",
        "supplied x-correlation-id is not a UUID; a new correlation id was generated",
        { supplied },
      );
    }
  } else {
    correlationId = supplied;
  }

  try {
    const bodyResult = await readJsonBody(request, app);
    const headers: Record<string, string | string[] | undefined> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const requestContext: MosRequestContext = {
      method,
      path: mosPath,
      headers,
      body: bodyResult.body,
      rawBody: bodyResult.raw,
    };

    const match = app.router.resolve(method, mosPath);
    const payload = await app.bundle.withCorrelation(
      { correlationId, causationId: null, actor: null },
      () => match.handler(requestContext, match.params),
    );

    const responseHeaders: Record<string, string> = {
      "content-type": "application/json",
      [CORRELATION_HEADER]: correlationId,
      "cache-control": "no-store",
      ...(payload.headers ?? {}),
    };
    logger.info("http.request", undefined, {
      method,
      path: mosPath.split("?")[0]!,
      status: payload.status,
      duration_ms: app.services.clock.nowMs() - startedMs,
    });
    // server.ts parity: Node's http server happily res.end('') on a 204, but
    // the WHATWG Response constructor rejects a non-null body for 204/205/304
    // — those statuses must carry a null body (DEP-005b).
    const bodyText = payload.body === undefined ? null : JSON.stringify(payload.body);
    const nullBodyStatus = payload.status === 204 || payload.status === 205 || payload.status === 304;
    return new Response(nullBodyStatus ? null : bodyText, {
      status: payload.status,
      headers: responseHeaders,
    });
  } catch (error) {
    const appError = app.bundle.toAppError(error);
    const responseHeaders: Record<string, string> = {
      "content-type": "application/json",
      [CORRELATION_HEADER]: correlationId,
      "cache-control": "no-store",
    };
    const logFields: Record<string, unknown> = {
      method,
      path: mosPath.split("?")[0]!,
      status: appError.httpStatus,
      error_code: (appError.toJSON()["code"] as string | undefined) ?? "UNKNOWN",
      duration_ms: app.services.clock.nowMs() - startedMs,
    };
    if (appError.httpStatus >= 500) {
      logger.error("http.request.failed", String(error), logFields);
    } else {
      logger.warn("http.request.rejected", String(error), logFields);
    }
    return new Response(JSON.stringify({ error: appError.toJSON() }), {
      status: appError.httpStatus,
      headers: responseHeaders,
    });
  }
}

/** server.ts readJsonBody parity: strict JSON + configured size limit. */
async function readJsonBody(
  request: Request,
  app: Awaited<ReturnType<typeof getMosApp>>,
): Promise<{ body: unknown; raw?: Uint8Array }> {
  if (methodAllowsBodyless(request.method)) {
    return { body: undefined };
  }
  const maxBytes = app.services.config.httpMaxBodyBytes;
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength === 0) {
    return { body: undefined };
  }
  if (raw.byteLength > maxBytes) {
    throw new app.bundle.RequestTooLargeError(maxBytes);
  }
  const text = new TextDecoder().decode(raw);
  try {
    return { body: JSON.parse(text) as unknown, raw };
  } catch (error) {
    throw new app.bundle.InvalidRequestError("Request body is not valid JSON", [
      `body: ${text.slice(0, 200)}`,
    ], error);
  }
}

function methodAllowsBodyless(method: string): boolean {
  const upper = method.toUpperCase();
  return upper === "GET" || upper === "HEAD" || upper === "DELETE";
}

function headerValue(headers: Headers, name: string): string | undefined {
  return headers.get(name) ?? undefined;
}
