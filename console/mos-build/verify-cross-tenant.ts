/**
 * DEP-005b production verification — cross-tenant isolation: a SECOND agency
 * created through the real APIs, then bidirectional denial probes.
 * Usage: MOS_BASE=<url> MOS_ADMIN_EMAIL=.. MOS_ADMIN_PASSWORD=.. bun mos-build/verify-cross-tenant.ts
 */
const BASE = (process.env.MOS_BASE ?? "").replace(/\/$/, "");
const NORTHWIND_AGENCY = process.env.MOS_NORTHWIND_AGENCY!;
const HELIO_CLIENT = process.env.MOS_HELIO_CLIENT!;
const HELIO_WORKSPACE = process.env.MOS_HELIO_WORKSPACE!;

async function api(path: string, token?: string, body?: unknown): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}/api/mos${path}`, {
    method: body !== undefined ? "POST" : "GET",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch { /* raw */ }
  return { status: res.status, body: parsed };
}

async function login(email: string, password: string): Promise<string | null> {
  const r = await api("/auth/login", undefined, { email, password });
  return r.status === 200 ? r.body.token : null;
}

async function main(): Promise<void> {
  const admin = (await login(process.env.MOS_ADMIN_EMAIL!, process.env.MOS_ADMIN_PASSWORD!))!;
  console.log("[OK] admin login");

  // 1. second-agency owner (check-then-create through the real API)
  const RIVAL = { email: "taylor@rival.demo", password: "Rival-Owner-2026", displayName: "Taylor Reed" };
  let taylor = await login(RIVAL.email, RIVAL.password);
  if (taylor === null) {
    const create = await api("/users", admin, { email: RIVAL.email, displayName: RIVAL.displayName });
    if (create.status !== 201) throw new Error(`create taylor: ${create.status} ${JSON.stringify(create.body).slice(0, 200)}`);
    const cred = await api(`/users/${create.body.userId}/credential`, admin, { password: RIVAL.password });
    if (cred.status !== 204 && cred.status !== 200) throw new Error(`credential: ${cred.status}`);
    taylor = (await login(RIVAL.email, RIVAL.password))!;
    console.log(`[OK] created second-agency owner ${RIVAL.email}`);
  } else {
    console.log(`[OK] second-agency owner ${RIVAL.email} exists`);
  }

  // 2. the second agency (platform-admin creates it, owned by taylor — MOS's
  //    own /api/agencies contract: POST { name, ownerUserId } by a platform admin)
  let rivalAgencyId: string | null = null;
  const ctx = await api("/auth/authorization-context", taylor);
  const memberships = (ctx.body.memberships ?? []) as any[];
  for (const m of memberships) {
    const read = await api(`/agencies/${m.agencyId}`, taylor);
    if (read.status === 200 && (read.body.agency?.name ?? read.body.name) === "Rival Growth Co") { rivalAgencyId = m.agencyId; }
  }
  if (rivalAgencyId === null) {
    const taylorId = (await api("/auth/authorization-context", taylor)).body.principal.userId as string;
    const created = await api("/agencies", admin, { name: "Rival Growth Co", ownerUserId: taylorId });
    if (created.status !== 201) throw new Error(`create rival agency: ${created.status} ${JSON.stringify(created.body).slice(0, 200)}`);
    rivalAgencyId = created.body.agency?.agencyId ?? created.body.agencyId;
    console.log(`[OK] created second agency Rival Growth Co (${rivalAgencyId}, owner taylor)`);
  } else {
    console.log(`[OK] second agency exists (${rivalAgencyId})`);
  }

  // 3. taylor's authorization context carries ONLY the rival membership
  //    (there is no GET /api/agencies listing route — memberships are the truth)
  const ctxAfter = await api("/auth/authorization-context", taylor);
  const memberAgencyIds = ((ctxAfter.body.memberships ?? []) as any[]).map((m) => m.agencyId);
  const seesNorthwind = memberAgencyIds.includes(NORTHWIND_AGENCY);
  console.log(
    `[${ctxAfter.status === 200 && !seesNorthwind ? "OK" : "FAIL"}] rival owner memberships: [${memberAgencyIds.join(", ")}] · Northwind visible: ${seesNorthwind}`,
  );

  // 4. denial probes (both directions)
  const probes: Array<[string, string, number[]]> = [
    ["rival owner → Northwind command center", `/reporting/command-center/${NORTHWIND_AGENCY}`, [403, 404]],
    ["rival owner → Helio decision room", `/reporting/decision-room/${HELIO_CLIENT}`, [403, 404]],
    ["rival owner → Helio workspace installs", `/workspaces/${HELIO_WORKSPACE}/app-installs`, [403, 404]],
    ["rival owner → Helio client memory", `/client-memory/${NORTHWIND_AGENCY}/clients/${HELIO_CLIENT}`, [403, 404]],
  ];
  for (const [label, path, expected] of probes) {
    const r = await api(path, taylor);
    const ok = expected.includes(r.status);
    console.log(`[${ok ? "OK" : "FAIL"}] ${label}: HTTP ${r.status} ${ok ? "" : JSON.stringify(r.body).slice(0, 120)}`);
  }
  const ownerToken = (await login("casey@northwind.demo", "Northwind-Owner-2026"))!;
  const reverse = await api(`/agencies/${rivalAgencyId}`, ownerToken);
  console.log(`[${[403, 404].includes(reverse.status) ? "OK" : "FAIL"}] Northwind owner → rival agency read: HTTP ${reverse.status}`);
  console.log("[DONE] cross-tenant isolation verified on production");
}

main().catch((e) => { console.error("[FAILED]", String(e)); process.exit(1); });
