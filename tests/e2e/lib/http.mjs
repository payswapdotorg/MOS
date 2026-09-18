/**
 * E2E harness HTTP client (VER-001) — the console's own transport, no mocks.
 *
 * Every MOS core route is reached through the deployed same-origin bridge
 * ("/api/<x>" → "${BASE}/api/mos/<x>") — the exact transport the console SPA
 * uses. The real sign-up route is "${BASE}/api/mos-signup". Nothing here ever
 * sends or records anything except Bearer tokens (in-memory) and request
 * bodies; evidence redaction happens in evidence.mjs.
 */

const REQUEST_TIMEOUT_MS = Number(process.env.MOS_E2E_HTTP_TIMEOUT_MS ?? 30000);

export class ApiError extends Error {
  constructor(message, { status, body }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function request(method, url, { token, body } = {}) {
  const headers = {};
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`fetch ${method} ${url} failed: ${String(error)}`);
  }
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, ok: response.ok, body: parsed, method, url };
}

/** API client bound to one base URL. */
export function apiClient(baseUrl) {
  const mos = (path) => `${baseUrl}/api/mos/${path.replace(/^\/+/, '')}`;
  return {
    baseUrl,

    /** GET/POST/… against a MOS core route through the console bridge. */
    call(method, path, options = {}) {
      return request(method, mos(path), options);
    },
    get(path, options = {}) {
      return request('GET', mos(path), options);
    },
    post(path, options = {}) {
      return request('POST', mos(path), options);
    },
    patch(path, options = {}) {
      return request('PATCH', mos(path), options);
    },

    /** The real sign-up route (creates a REAL empty account). */
    signup(body) {
      return request('POST', `${baseUrl}/api/mos-signup`, { body });
    },

    health() {
      return request('GET', `${baseUrl}/api/mos/platform/health`);
    },

    /** Login through the real credential contract; returns the Bearer token. */
    async login(email, password) {
      const result = await request('POST', mos('auth/login'), { body: { email, password } });
      if (result.status !== 200 || typeof result.body.token !== 'string') {
        throw new ApiError(`login failed for ${email.replace(/^(.).*(@.*)$/, '$1***$2')}`, result);
      }
      return { token: result.body.token, userId: result.body.userId, raw: result.body };
    },
  };
}

/** Extract the caller's first agencyId from an authorization-context body. */
export function firstAgencyId(authorizationContextBody) {
  const memberships = Array.isArray(authorizationContextBody?.memberships)
    ? authorizationContextBody.memberships
    : [];
  return memberships.length > 0 ? memberships[0].agencyId : undefined;
}
