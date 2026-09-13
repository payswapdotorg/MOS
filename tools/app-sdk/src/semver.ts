/**
 * MOS App SDK — the REAL semantic-version comparator (the standalone
 * mirror of the /apps registry's exported compareSemver /
 * appVersionInRange — MKT-049). Numeric component ordering (1.10.0 >
 * 1.9.0 — text ordering would get this wrong), prerelease labels sort
 * BELOW their release, dot-separated prerelease identifiers compare
 * numerically when both numeric, lexically otherwise, shorter identifier
 * lists sort lower. Non-semver labels compare 0 (guards reject them
 * before ordering matters). Mirrors the migration-037 apps_semver_cmp
 * function exactly.
 *
 * Drift-pinned by tests/unit/app-sdk-drift.test.ts (ordering corpus).
 * Imports NOTHING from the MOS repository (standalone).
 */

/** REAL semantic-version comparison for X.Y.Z(-prerelease) labels. */
export function compareSemver(a: string, b: string): number {
  if (a === b) return 0;
  const coreA = a.includes('-') ? a.slice(0, a.indexOf('-')) : a;
  const coreB = b.includes('-') ? b.slice(0, b.indexOf('-')) : b;
  const partsA = coreA.split('.').map((part) => Number.parseInt(part, 10));
  const partsB = coreB.split('.').map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < 3; index += 1) {
    const numA = partsA[index] ?? 0;
    const numB = partsB[index] ?? 0;
    if (!Number.isFinite(numA) || !Number.isFinite(numB)) return 0;
    if (numA !== numB) return numA < numB ? -1 : 1;
  }
  const preA = a.includes('-') ? a.slice(a.indexOf('-') + 1) : null;
  const preB = b.includes('-') ? b.slice(b.indexOf('-') + 1) : null;
  if (preA === null && preB === null) return 0;
  if (preA === null) return 1; // release sorts above prereleases
  if (preB === null) return -1;
  const identsA = preA.split('.');
  const identsB = preB.split('.');
  const length = Math.min(identsA.length, identsB.length);
  for (let index = 0; index < length; index += 1) {
    const identA = identsA[index]!;
    const identB = identsB[index]!;
    if (identA === identB) continue;
    const bothNumeric = /^[0-9]+$/.test(identA) && /^[0-9]+$/.test(identB);
    if (bothNumeric) {
      const numA = Number.parseInt(identA, 10);
      const numB = Number.parseInt(identB, 10);
      return numA < numB ? -1 : 1;
    }
    return identA < identB ? -1 : 1;
  }
  if (identsA.length !== identsB.length) {
    return identsA.length < identsB.length ? -1 : 1;
  }
  return 0;
}

/** Pure compatibility-range matcher: is `version` inside the INCLUSIVE [min, max] range? */
export function appVersionInRange(version: string, min: string, max: string): boolean {
  return compareSemver(version, min) >= 0 && compareSemver(version, max) <= 0;
}
