/**
 * MOS App SDK — the canonical manifest FINGERPRINT + the signature
 * helpers (the standalone mirror of the /apps registry's
 * appCreateFingerprint / appManifestSignatureProblems — MKT-049's
 * disclosed signing step).
 *
 * The registry computes the §8-style create fingerprint of a manifest as
 * sha256(canonical JSON with object keys sorted at EVERY level +
 * '|mkt-047-app-manifest') and persists it on the immutable published
 * row (create_fingerprint). The OPTIONAL publish signature
 * ({ algorithm: 'manifest-sha256-fingerprint', digest }) must carry
 * EXACTLY that value: `sign` writes it offline, the registry re-computes
 * server-side and rejects a mismatch 422 with zero rows (fail-closed).
 *
 * Drift-pinned by tests/unit/app-sdk-drift.test.ts: the mirror's
 * fingerprint equals the authority's appCreateFingerprint over the
 * manifest corpus, and the mirror's signature problems equal the
 * authority's appManifestSignatureProblems over the signature corpus.
 * Imports NOTHING from the MOS repository (standalone).
 */

import { createHash } from 'node:crypto';

import { compareSemver } from './semver.ts';
import type { AppManifestSignature } from './types.ts';
import { APP_SIGNATURE_ALGORITHMS } from './vocabularies.ts';

type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };

/** Canonical JSON: object keys sorted at EVERY level (deterministic digest). */
export function canonicalize(value: JSONValue): JSONValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, JSONValue> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalize(value[key]!);
    }
    return sorted;
  }
  return value;
}

/**
 * The §8-style canonical-manifest fingerprint — the IDENTICAL digest the
 * /apps registry computes server-side (appCreateFingerprint) and
 * persists as the immutable row's createFingerprint. This is the value
 * the optional publish signature must attest.
 */
export function appManifestFingerprint(manifest: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(manifest as unknown as JSONValue)))
    .update('|mkt-047-app-manifest')
    .digest('hex');
}

/**
 * Sign a manifest OFFLINE: build the optional publish-envelope signature
 * (the hash attestation the /apps registry verifies at publish).
 */
export function signManifest(manifest: unknown): AppManifestSignature {
  return {
    algorithm: 'manifest-sha256-fingerprint',
    digest: appManifestFingerprint(manifest),
  };
}

// --- the mirror of the registry's signature guard ---------------------------

const SIGNATURE_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The mirror of the registry's appManifestSignatureProblems guard: when
 * a publish carries a signature, it must be EXACTLY { algorithm, digest }
 * with the algorithm in the closed one-element vocabulary and the digest
 * a 64-character lowercase hex sha256 — AND the digest must EQUAL the
 * canonical manifest fingerprint (appManifestFingerprint). Returns the
 * problem list (empty = the attestation is valid or absent).
 */
export function appManifestSignatureProblems(
  manifest: unknown,
  signature: unknown,
): string[] {
  if (signature === null || signature === undefined) return [];
  if (typeof signature !== 'object' || Array.isArray(signature)) {
    return ['signature: must be an object { algorithm, digest } or null (the optional hash attestation)'];
  }
  const problems: string[] = [];
  const declaration = signature as Partial<AppManifestSignature>;
  const keys = Object.keys(declaration);
  if (keys.length !== 2 || declaration.algorithm === undefined || declaration.digest === undefined) {
    problems.push('signature: must declare exactly { algorithm, digest }');
  }
  if (
    typeof declaration.algorithm !== 'string' ||
    !(APP_SIGNATURE_ALGORITHMS as readonly string[]).includes(declaration.algorithm)
  ) {
    problems.push(
      `signature.algorithm: '${String(declaration.algorithm)}' is not in the closed signature-algorithm vocabulary (manifest-sha256-fingerprint)`,
    );
  }
  if (typeof declaration.digest !== 'string' || !SIGNATURE_DIGEST_PATTERN.test(declaration.digest)) {
    problems.push('signature.digest: must be a 64-character lowercase hex sha256 digest of the canonical manifest');
  }
  if (
    typeof declaration.algorithm === 'string' &&
    (APP_SIGNATURE_ALGORITHMS as readonly string[]).includes(declaration.algorithm) &&
    typeof declaration.digest === 'string' &&
    SIGNATURE_DIGEST_PATTERN.test(declaration.digest) &&
    declaration.digest !== appManifestFingerprint(manifest)
  ) {
    problems.push(
      'signature.digest: attestation mismatch — the signed digest does not equal this manifest\'s canonical fingerprint (the manifest content differs from what was signed; re-sign the exact manifest you are publishing)',
    );
  }
  return problems;
}

/**
 * Convenience: does this manifest satisfy the registry's INTEGRITY
 * posture for its (optional) signature — valid when absent, verified
 * when present? (The registry answer: publishAppVersion with
 * appManifestSignatureProblems empty.)
 */
export function manifestSignatureValid(manifest: unknown, signature: unknown): boolean {
  return appManifestSignatureProblems(manifest, signature).length === 0;
}

/**
 * The SDK-side `port` DTO normalization helper shared by the CLI and the
 * client: network destination `port` values arrive as JSON numbers OR
 * strings (the registry route DTO accepts the string form); the typed
 * manifest carries numbers.
 */
export function normalizePort(port: unknown): number | null {
  if (typeof port === 'number' && Number.isSafeInteger(port)) return port;
  if (typeof port === 'string' && /^[0-9]+$/.test(port)) return Number.parseInt(port, 10);
  return null;
}

/** Ordering helper for catalog display: REAL semver ordering (never text). */
export function newestVersionLabel(versions: readonly string[]): string | null {
  let newest: string | null = null;
  for (const version of versions) {
    if (newest === null || compareSemver(version, newest) > 0) newest = version;
  }
  return newest;
}
