import { MosApp } from "@/components/mos/mos-app";

/**
 * The single user-visible route: the MOS presentation SPA (client-side
 * navigation only — see src/components/mos/*). Every datum rendered comes
 * from the live MOS API on :3010 through the same-origin bridge at /api/mos
 * (src/app/api/mos/[...path]/route.ts).
 */
export default function Home() {
  return <MosApp />;
}
