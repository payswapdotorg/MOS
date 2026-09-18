import { NextRequest, NextResponse } from "next/server";
import { callMosApi, mosErrorCode } from "@/lib/mos-transport";

/**
 * POST /api/mos-signup — REAL account creation with ZERO simulation (DEP-006).
 *
 * This route is a server-side ORCHESTRATOR over MOS's own admin contracts —
 * it invents no endpoints, no data and no state. Every step goes through the
 * dual-mode transport (src/lib/mos-transport.ts — same mode selection as the
 * /api/mos bridge):
 *
 *   1. platform-admin login (env credentials, NEVER sent to the browser,
 *      never logged) — failure ⇒ honest 503 "temporarily unavailable";
 *   2. POST /api/users {email, displayName} — duplicate email ⇒ honest 409;
 *   3. POST /api/users/:userId/credential {password} — ONLY for the user
 *      created in step 2 of THIS request (never an existing user: no
 *      credential resets, no account hijack);
 *   4. POST /api/agencies {name, ownerUserId} — MOS auto-creates the owner
 *      membership;
 *   5. 201 {ok, email, agencyName, userId} — NOTHING else. No client, no
 *      goal, no demo datum: the account starts genuinely empty.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// --- validation (mirrors the platform's own rules; honest 400s) --------------

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DISPLAY_NAME_MAX = 100;
const AGENCY_NAME_MAX = 100;
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 256;

type SignupBody = {
  displayName: string;
  email: string;
  agencyName: string;
  password: string;
};

/**
 * Best-effort, per-instance, in-memory rate limit per client IP. On a
 * multi-instance host (e.g. Vercel serverless) each instance keeps its own
 * bucket, so the effective limit is approximate — deliberately simple, no
 * external state (MOS stays the only authority).
 */
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const rateBuckets = new Map<string, number[]>();

function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded !== null && forwarded !== "") {
    return forwarded.split(",")[0]!.trim();
  }
  return request.headers.get("x-real-ip") ?? "unknown";
}

function takeRateLimitSlot(ip: string): boolean {
  const now = Date.now();
  const bucket = (rateBuckets.get(ip) ?? []).filter((at) => now - at < RATE_LIMIT_WINDOW_MS);
  if (bucket.length >= RATE_LIMIT_MAX) {
    rateBuckets.set(ip, bucket);
    return false;
  }
  bucket.push(now);
  rateBuckets.set(ip, bucket);
  return true;
}

// --- honest error envelopes (the platform's §23 error shape) ------------------

function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: ReadonlyArray<string>,
): NextResponse {
  return NextResponse.json(
    {
      error: {
        code,
        message,
        retryable: false,
        retrySafe: true,
        ...(details === undefined || details.length === 0 ? {} : { details: [...details] }),
      },
    },
    { status, headers: { "cache-control": "no-store" } },
  );
}

// --- the route -----------------------------------------------------------------

export async function POST(request: NextRequest): Promise<Response> {
  // 0. Body shape validation FIRST — honest 400s, no secrets, no partial
  //    effects, and invalid requests are too cheap to count against the
  //    rate limit (they never reach MOS at all).
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, "INVALID_REQUEST", "Request body is not valid JSON.");
  }
  const body = (raw ?? {}) as Partial<Record<keyof SignupBody, unknown>>;
  const problems: string[] = [];

  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  if (displayName.length < 1 || displayName.length > DISPLAY_NAME_MAX) {
    problems.push(`displayName: must be 1–${DISPLAY_NAME_MAX} characters`);
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (email.length < 3 || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    problems.push("email: must be a valid email address");
  }

  const agencyName = typeof body.agencyName === "string" ? body.agencyName.trim() : "";
  if (agencyName.length < 1 || agencyName.length > AGENCY_NAME_MAX) {
    problems.push(`agencyName: must be 1–${AGENCY_NAME_MAX} characters`);
  }

  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    problems.push(`password: must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters`);
  }

  if (problems.length > 0) {
    return errorResponse(400, "INVALID_REQUEST", "Sign-up request failed validation.", problems);
  }

  // 0b. Rate limit — best-effort, per-instance (see comment above). Only
  //     requests that passed validation consume a slot.
  if (!takeRateLimitSlot(clientIp(request))) {
    return errorResponse(
      429,
      "RATE_LIMITED",
      "Too many sign-up attempts from this address. Please wait a few minutes and try again.",
    );
  }

  // 1. Platform-admin login with SERVER-ONLY env credentials. The credential
  //    fallback chain covers production (MOS_BOOTSTRAP_PLATFORM_ADMIN_* on
  //    Vercel) and staging (MOS_SIGNUP_ADMIN_*). It is never returned, never
  //    logged, never shipped to the browser bundle.
  const adminEmail =
    process.env.MOS_SIGNUP_ADMIN_EMAIL ?? process.env.MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL ?? "";
  const adminPassword =
    process.env.MOS_SIGNUP_ADMIN_PASSWORD ?? process.env.MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD ?? "";
  if (adminEmail === "" || adminPassword === "") {
    return errorResponse(
      503,
      "SIGNUP_UNAVAILABLE",
      "Sign-up is temporarily unavailable. Please try again later.",
    );
  }

  const adminLogin = await callMosApi({
    method: "POST",
    path: "/api/auth/login",
    body: { email: adminEmail, password: adminPassword },
  });
  if (adminLogin.status !== 200) {
    // Honest 503 — no credential material, no upstream body echoed.
    return errorResponse(
      503,
      "SIGNUP_UNAVAILABLE",
      "Sign-up is temporarily unavailable. Please try again later.",
    );
  }
  const adminToken = (adminLogin.body as { token?: unknown } | null)?.token;
  if (typeof adminToken !== "string" || adminToken === "") {
    return errorResponse(
      503,
      "SIGNUP_UNAVAILABLE",
      "Sign-up is temporarily unavailable. Please try again later.",
    );
  }

  // 2. Create the user identity. A duplicate email is mapped HONESTLY to 409 —
  //    we never reset the credential of an existing account.
  const createUser = await callMosApi({
    method: "POST",
    path: "/api/users",
    body: { email, displayName },
    token: adminToken,
  });
  if (createUser.status === 409) {
    return errorResponse(
      409,
      "EMAIL_ALREADY_REGISTERED",
      "An account with this email already exists. Try signing in instead.",
    );
  }
  if (createUser.status !== 201) {
    return errorResponse(
      500,
      "SIGNUP_FAILED",
      `Sign-up failed while creating the user identity (step 2, upstream ${createUser.status} ${mosErrorCode(createUser)}).`,
    );
  }
  const userId = (createUser.body as { userId?: unknown } | null)?.userId;
  if (typeof userId !== "string" || userId === "") {
    return errorResponse(
      500,
      "SIGNUP_FAILED",
      "Sign-up failed while creating the user identity (step 2, malformed upstream response).",
    );
  }

  // 3. Set the credential — for the user created in step 2 of THIS request
  //    only. MOS's strict body validation accepts exactly {password}.
  const setCredential = await callMosApi({
    method: "POST",
    path: `/api/users/${encodeURIComponent(userId)}/credential`,
    body: { password },
    token: adminToken,
  });
  if (setCredential.status !== 204) {
    return errorResponse(
      500,
      "SIGNUP_FAILED",
      `Sign-up failed while setting the account credential (step 3, upstream ${setCredential.status} ${mosErrorCode(setCredential)}).`,
    );
  }

  // 4. Create the (genuinely empty) agency; MOS auto-creates the owner
  //    membership for ownerUserId.
  const createAgency = await callMosApi({
    method: "POST",
    path: "/api/agencies",
    body: { name: agencyName, ownerUserId: userId },
    token: adminToken,
  });
  if (createAgency.status !== 201) {
    return errorResponse(
      500,
      "SIGNUP_FAILED",
      `Sign-up failed while creating the agency (step 4, upstream ${createAgency.status} ${mosErrorCode(createAgency)}).`,
    );
  }

  // 5. Success — and NOTHING else is created. No client, no goal, no demo
  //    datum: every screen the new owner opens renders honest empty states.
  return NextResponse.json(
    { ok: true, email, agencyName, userId },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
}
