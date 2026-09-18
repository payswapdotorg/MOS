/**
 * DEP-005b production verification — app lifecycle (install → upgrade →
 * rollback) on a FRESH workspace, through the deployed public API.
 * Usage: MOS_BASE=<url> MOS_OWNER_EMAIL=.. MOS_OWNER_PASSWORD=.. bun mos-build/verify-app-lifecycle.ts
 */
const BASE = (process.env.MOS_BASE ?? "").replace(/\/$/, "");
const CLIENT_A = process.env.MOS_CLIENT_A!;

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

function check(label: string, status: number, expected: number[]): boolean {
  const ok = expected.includes(status);
  console.log(`[${ok ? "OK" : "FAIL"}] ${label}: HTTP ${status}${ok ? "" : " " + JSON.stringify(expected)}`);
  return ok;
}

async function main(): Promise<void> {
  const login = await api("/auth/login", undefined, {
    email: process.env.MOS_OWNER_EMAIL!, password: process.env.MOS_OWNER_PASSWORD!,
  });
  if (login.status !== 200) throw new Error(`owner login failed: ${login.status}`);
  const token = login.body.token;
  console.log("[OK] owner login (Northwind)");

  // 1. fresh workspace on Helio Robotics (through the real API)
  const ws = await api(`/clients/${CLIENT_A}/workspaces`, token, { name: `Production Verify Workspace ${new Date().toISOString().slice(11, 19)}` });
  if (!check("create fresh workspace", ws.status, [201])) throw new Error(JSON.stringify(ws.body).slice(0, 300));
  const workspaceId: string = ws.body.workspace?.workspaceId ?? ws.body.workspaceId;
  console.log(`     workspaceId ${workspaceId}`);

  // 2. install mos-portal @ 1.0.0
  const install = await api(`/workspaces/${workspaceId}/app-installs`, token, {
    appKey: "mos-portal", version: "1.0.0", idempotencyKey: `dep005b-install:${workspaceId}:${Date.now()}`,
  });
  if (!check("install mos-portal@1.0.0", install.status, [201, 200])) throw new Error(JSON.stringify(install.body).slice(0, 300));
  const installId: string = install.body.install?.installId ?? install.body.installId;
  console.log(`     installId ${installId} @ ${install.body.install?.version}`);

  // 3. upgrade to 1.1.0 (appends a NEW current selection row)
  const upgrade = await api(`/workspaces/${workspaceId}/app-installs/${installId}/upgrade`, token, {
    version: "1.1.0", idempotencyKey: `dep005b-upgrade:${installId}:${Date.now()}`,
  });
  if (!check("upgrade mos-portal→1.1.0", upgrade.status, [201, 200])) throw new Error(JSON.stringify(upgrade.body).slice(0, 300));
  const headInstallId: string = upgrade.body.install?.installId ?? installId;
  console.log(`     now @ ${upgrade.body.install?.version} (row ${headInstallId})`);

  // 4. rollback to the PRIOR selection row (the 1.0.0 install) — the current
  //    row is the path id; the previously-installed row is the target.
  const rollback = await api(`/workspaces/${workspaceId}/app-installs/${headInstallId}/rollback`, token, {
    targetInstallId: installId, idempotencyKey: `dep005b-rollback:${headInstallId}:${installId}:${Date.now()}`,
  });
  if (!check("rollback mos-portal→1.0.0", rollback.status, [201, 200])) throw new Error(JSON.stringify(rollback.body).slice(0, 300));
  console.log(`     now @ ${rollback.body.install?.version}`);

  // 5. the ledger: history rows + current selection
  const ledger = await api(`/workspaces/${workspaceId}/app-installs`, token);
  check("read install ledger", ledger.status, [200]);
  const rows = (ledger.body.installs ?? []) as any[];
  console.log(`     ledger rows: ${rows.length}`);
  for (const row of rows.slice(0, 6)) {
    console.log(
      `       seq ${row.sequence ?? row.seq ?? "?"} · ${row.appKey}@${row.version} · ${row.state ?? row.status} · supersededBy=${row.supersededByInstallId ?? "—"}`,
    );
  }
  const current = (ledger.body.currentSelections ?? []) as any[];
  const currentRow = rows.find((r) => current.includes(r.installId));
  console.log(`     CURRENT selection: ${currentRow ? `${currentRow.appKey}@${currentRow.version}` : JSON.stringify(current)}`);
  console.log("[DONE] app lifecycle verified on production");
}

main().catch((e) => { console.error("[FAILED]", String(e)); process.exit(1); });
