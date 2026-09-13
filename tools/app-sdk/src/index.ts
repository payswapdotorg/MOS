/**
 * MOS App SDK — the public entry (MKT-049, spec/mos-app-ecosystem-v1.5.md
 * "UI and developer model": "Community developers receive SDKs generated
 * from stable capability contracts").
 *
 * The outbound artifact: TypeScript types + runtime vocabularies + the
 * canonical manifest fingerprint/signing helpers + the OFFLINE
 * validator (the drift-pinned mirror of the /apps registry guard) + the
 * project scaffolder + the documentation generator + the typed HTTP
 * client over the Developer Portal routes. Standalone — NOTHING here
 * imports the MOS repository source (proven by
 * tests/architecture/developer-portal-boundary.test.ts).
 */

export * from './types.ts';
export * from './vocabularies.ts';
export { compareSemver, appVersionInRange } from './semver.ts';
export {
  appManifestFingerprint,
  appManifestSignatureProblems,
  canonicalize,
  manifestSignatureValid,
  normalizePort,
  newestVersionLabel,
  signManifest,
} from './fingerprint.ts';
export {
  APP_PROJECT_FILES,
  appPublisherIdentityString,
  capabilityContractFileName,
  isLegalAppStateNamespace,
  payloadHasNoAppsMaterialKeys,
  validateAppManifest,
  validateAppProjectFiles,
} from './validate.ts';
export { scaffoldAppProject, scaffoldManifest, scaffoldOptionProblems } from './scaffold.ts';
export type { AppUiSurfaceKindOption, GeneratedFile, ScaffoldOptions, ScaffoldResult } from './scaffold.ts';
export {
  developerDocsModel,
  generateDeveloperDocsMarkdown,
  DEVELOPER_PORTAL_ENDPOINT_DOCS,
  MANIFEST_FIELD_DOCS,
} from './docs.ts';
export type { ManifestFieldDoc } from './docs.ts';
export { MosDeveloperPortalClient, MosApiError } from './client.ts';
export type {
  AppCatalogEntryDto,
  AppVersionDto,
  AppVersionValidationStatusDto,
  AppVersionViewDto,
  CompatibilityReportDto,
  DeveloperPortalDocsDto,
  ManifestValidationDto,
  MosDeveloperPortalClientOptions,
  PublishResultDto,
} from './client.ts';
