import { NextRequest, NextResponse } from "next/server";
import { drainQueue } from "@/lib/mos-drain";
import { serveMosRequest } from "@/lib/mos-request";
import { getBootedMosApp } from "@/lib/mos-runtime";
import { bridgeErrorBody } from "@/lib/mos-diagnostics";

/**
 * Admin-gated bounded queue drain (DEP-005).
 *
 * Vercel Hobby cannot host MOS's continuous worker process, so the queue is
 * drained ON DEMAND through this route (the serverless twin of
 * `src/entrypoints/worker.ts --drain`), bounded to a hard time budget that
 * stays inside the serverless function limit. A vercel.json cron invokes the
 * GET form daily with the CRON_SECRET bearer.
 *
 * Accepted principals (fail closed):
 *   - the MOS internal service token (MOS_INTERNAL_API_TOKEN);
 *   - a logged-in platform administrator (verified THROUGH the real MOS
 *     authorization-context route — no second authority here);
 *   - the Vercel cron secret (GET only — vercel.json crons issue GETs).
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DRAIN_BUDGET_MS = 45_000;

function bearer(request: NextRequest): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization === null) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match === null ? null : match[1]!.trim();
}

async function isPlatformAdministrator(token: string): Promise<boolean> {
  const probe = new Request("http://in-process/api/auth/authorization-context", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  const response = await serveMosRequest(probe, "/api/auth/authorization-context");
  if (response.status !== 200) return false;
  try {
    const context = (await response.json()) as { platformRoles?: unknown };
    return (
      Array.isArray(context["platformRoles"]) &&
      (context["platformRoles"] as unknown[]).includes("platform_administrator")
    );
  } catch {
    return false;
  }
}

async function authorize(request: NextRequest, cronAllowed: boolean): Promise<Response | null> {
  const token = bearer(request);
  if (token === null) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Bearer token required" } },
      { status: 401 },
    );
  }
  const internalApiToken = process.env.MOS_INTERNAL_API_TOKEN ?? "";
  if (internalApiToken !== "" && token === internalApiToken) return null;
  const cronSecret = process.env.CRON_SECRET ?? "";
  if (cronAllowed && cronSecret !== "" && token === cronSecret) return null;
  if (await isPlatformAdministrator(token)) return null;
  return NextResponse.json(
    { error: { code: "FORBIDDEN", message: "Drain requires the internal token or a platform administrator" } },
    { status: 403 },
  );
}

function budgetFrom(request: NextRequest): number {
  const raw = Number.parseInt(request.nextUrl.searchParams.get("budgetMs") ?? "", 10);
  if (Number.isNaN(raw)) return DRAIN_BUDGET_MS;
  return Math.min(Math.max(raw, 1_000), DRAIN_BUDGET_MS);
}

async function run(request: NextRequest): Promise<Response> {
  const denied = await authorize(request, request.method === "GET");
  if (denied !== null) return denied;
  const budgetMs = budgetFrom(request);
  try {
    const report = await drainQueue(budgetMs);
    return NextResponse.json(report, {
      status: report.ok ? 200 : 202,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    const stage = getBootedMosApp() === null ? "boot" : "serve";
    return NextResponse.json(bridgeErrorBody(stage, error), {
      status: 500,
      headers: { "cache-control": "no-store" },
    });
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  return run(request);
}

export async function GET(request: NextRequest): Promise<Response> {
  return run(request);
}
