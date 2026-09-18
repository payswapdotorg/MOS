// DEP-005b local reproduction: boot the EXACT shipped bundle against PRODUCTION Neon + R2.
import { mkdir } from "node:fs/promises";
const t0 = Date.now();
try {
  await mkdir(process.env.MOS_SECRETS_DIR ?? "/tmp/mos-secrets", { recursive: true });
  const bundle = await import("../mos-bundle/mos.mjs");
  console.log("[boot] bundle loaded in", Date.now() - t0, "ms; exports:", Object.keys(bundle).length);
  const bt = Date.now();
  const { services, modules } = await bundle.bootstrapApplication();
  console.log("[boot] bootstrapApplication ok in", Date.now() - bt, "ms");
  const router = bundle.buildApiRouter(services, modules);
  const match = router.resolve("GET", "/api/platform/health");
  const payload = await match.handler({ method: "GET", path: "/api/platform/health", headers: {}, body: undefined, rawBody: undefined }, {});
  console.log("[boot] health:", payload.status, JSON.stringify(payload.body));
  await services.db.close();
  console.log("[boot] LOCAL PRODUCTION-SHAPE BOOT PASSED");
} catch (error) {
  console.error("[boot] FAILED:", error && error.stack ? error.stack : String(error));
  process.exit(1);
}
