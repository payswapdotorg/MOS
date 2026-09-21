/**
 * Provider-neutral SOCIAL PLATFORM ADAPTER contract (MKT-056 — the
 * internal/adapters/adapter-contract.ts re-export surface of
 * /social-accounts; the /integrations internal/adapters/adapter-contract.ts
 * precedent).
 *
 * THE SANCTIONED ADAPTER SUBTREE: this directory is the declared home of
 * the CONCRETE PLATFORM ADAPTERS of MKT-057..061 (one subdirectory per
 * platform — internal/adapters/&lt;platform&gt;/). Platform-specific
 * knowledge (provider endpoints, request/response shapes, scope names,
 * restriction-signal labels, SDK-free HTTP mapping) lives EXCLUSIVELY in
 * those subtrees; the module core (public.ts + internal/* outside
 * adapters/) stays provider-neutral — the platform identity is the
 * integration connection's adapter key carried as data (lock rule 18),
 * and the static boundary tests prove no platform identifier exists
 * outside the adapter subtrees, the composition root and tests.
 *
 * Adapter files under this path are CONCRETE ADAPTERS in the
 * tools/arch-check sense (CONCRETE_ADAPTER_ACCESS): they may be imported
 * ONLY by the composition root (where they become module DATA through
 * AppOptions.socialPlatformAdapters) and inspected by tests. One adapter
 * may never import another adapter (ADAPTER_COUPLING) — shared semantics
 * arrive through the module PUBLIC entry or this re-export shim.
 *
 * This file intentionally re-exports the adapter port types from the
 * internal contract module (whose vocabulary is itself re-exported
 * through the module public entry so the normalized semantics are part
 * of the TESTED module contract). There are NO first-party platform
 * adapters in MKT-056 — the reference in-memory test double proving the
 * conformance suite executes lives in the test tree
 * (tests/integration/helpers/reference-social-adapter.ts); the five MVP
 * platform implementations arrive with MKT-057..061.
 */

export type {
  RegisteredSocialAdapterInfo,
  SocialAccountIdentityResult,
  SocialAccountProfile,
  SocialAccountProfileResult,
  SocialAdapterCallContext,
  SocialAdapterDescriptor,
  SocialAdapterFailureCode,
  SocialAnalyticsObservation,
  SocialAnalyticsResult,
  SocialAnalyticsWindow,
  SocialCapability,
  SocialCapabilityFamily,
  SocialCapabilityScopeSatisfaction,
  SocialContentAnalyticsInput,
  SocialContentDiscoveryQuery,
  SocialContentListQuery,
  SocialContentPage,
  SocialContentPageResult,
  SocialContentReadInput,
  SocialContentRecord,
  SocialContentResult,
  SocialEngagementObservation,
  SocialOperationFailure,
  SocialOperationKey,
  SocialPlatformAdapter,
  SocialPublishMediaAsset,
  SocialPublishRequest,
  SocialPublishState,
  SocialPublishStatus,
  SocialPublishStatusInput,
  SocialPublishStatusResult,
  SocialPublishSubmission,
  SocialPublishSubmitInput,
  SocialPublishSubmitResult,
  SocialRateLimitObservation,
  SocialRestrictionSignal,
  SocialRestrictionSignalsResult,
} from '../adapter-contract.ts';
export {
  SOCIAL_ACCOUNT_OPERATIONS,
  SOCIAL_ADAPTER_FAILURE_CODES,
  SOCIAL_ANALYTICS_READ_OPERATIONS,
  SOCIAL_CAPABILITY_FAMILIES,
  SOCIAL_CONTENT_READ_OPERATIONS,
  SOCIAL_FAMILY_OPERATIONS,
  SOCIAL_OPERATION_KEYS,
  SOCIAL_PUBLISH_OPERATIONS,
  SOCIAL_PUBLISH_STATES,
  SOCIAL_RESTRICTION_SIGNAL_OPERATIONS,
  adapterCapabilityForOperation,
  buildSocialAdapterRegistry,
  isKnownSocialFailureCode,
  isLegalSocialPublishFill,
  isRetryableSocialFailure,
  socialAdapterRegistrationProblems,
  socialCapabilityOf,
  socialCapabilityScopeSatisfaction,
  socialOperationFamilyOf,
  socialScopeProblem,
} from '../adapter-contract.ts';
