/**
 * The first-party /lab-features media-fetch port (LAB-003) — the
 * HONEST PENDING STATE.
 *
 * §4 "Media access is an adapter: Reference → permitted media access
 * → decode/stream → feature extraction → feature bundle" — the
 * provider/rights-gated fetch boundary is a REPLACEABLE port, and the
 * real provider-adapter wiring arrives with the corpus backfills
 * (the provider adapters own fetching under their declared
 * acquisition constraints — the /lab-corpus ingestion seam
 * precedent). Until then, this first-party implementation ships the
 * honest pending outcome: it performs NO network access, requests NO
 * bytes and asserts NOTHING — the extraction proceeds with the
 * metadata-grade features and the media-grade features record their
 * honest encoder_unavailable states (never fabricated).
 *
 * Test doubles (and the future provider adapters) satisfy the same
 * LabMediaFetchPort contract: 'granted' rides an IN-MEMORY handle
 * through the extraction call only — no implementation may persist
 * the bytes (migration 065 has no binary column anywhere; the §4
 * structural rule).
 */

import type { LabMediaFetchOutcome, LabMediaFetchPort } from '../public.ts';

/** Creates the first-party pending media-fetch port (no provider adapter is wired). */
export function createPendingLabMediaFetchPort(): LabMediaFetchPort {
  return {
    async fetchMedia(): Promise<LabMediaFetchOutcome> {
      return {
        status: 'pending',
        detail:
          'no provider media adapter is wired in this version — the provider/rights-gated fetch path arrives with the corpus backfills',
      };
    },
  };
}
