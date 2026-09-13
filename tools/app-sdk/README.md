# MOS App SDK (MKT-049)

The outbound developer kit for the MOS App Ecosystem (MarketingOS v1.5):
TypeScript types, runtime vocabularies, the canonical manifest
fingerprint/signing helpers, an OFFLINE validator, a project scaffolder,
a documentation generator and a typed HTTP client — all derived from the
FROZEN /apps registry public contract
(spec/mos-app-ecosystem-v1.5.md "Manifest" / "UI and developer model":
"Community developers receive SDKs generated from stable capability
contracts").

**This package is STANDALONE**: nothing under `tools/app-sdk` imports the
MOS repository source (proven by
`tests/architecture/developer-portal-boundary.test.ts`), and no MOS core
module imports the SDK (the SDK is an outbound artifact, never a runtime
dependency). It is a HAND-FROZEN MIRROR of the authority contract, kept
honest by DRIFT TESTS (`tests/unit/app-sdk-drift.test.ts`):

- **type-level pins** — the mirror types are asserted EQUAL to the
  authority types (`npm run typecheck` fails on contract drift);
- **runtime pins** — the vocabulary arrays, the manifest fingerprint and
  the validator verdicts/problem strings are asserted IDENTICAL to the
  authority exports over a mutation corpus.

When the /apps public contract changes, regenerate this mirror in the
same change or the drift tests fail.

## The developer workflow

```text
node tools/app-sdk/cli.ts scaffold ./my-app --app-key my-app
node tools/app-sdk/cli.ts validate ./my-app          # offline: manifest + capability contracts + UI surfaces + tests + signature
node --test './my-app/tests/*.test.ts'
node tools/app-sdk/cli.ts sign ./my-app              # writes signature.json (manifest-sha256-fingerprint)
node tools/app-sdk/cli.ts publish ./my-app --base-url http://127.0.0.1:3000 --token <token> --idempotency-key <key>
node tools/app-sdk/cli.ts docs                       # offline developer reference (Markdown)
```

The canonical documentation surface is the served route
`GET /api/developer-portal/docs` (derived read-only from the frozen
contracts — no runtime mutation); the CLI `docs` command is the
offline mirror.

## Programmatic use

```ts
import {
  MosDeveloperPortalClient,
  scaffoldAppProject,
  validateAppProjectFiles,
  signManifest,
} from './src/index.ts';

// Scaffold a project
const { files, manifest } = scaffoldAppProject({ appKey: 'agency-analytics' });

// Validate offline (the drift-pinned mirror of the registry guard)
const verdict = validateAppProjectFiles(fileMap);
if (!verdict.valid) console.error(verdict.problems);

// Sign + publish online (platform_developer token)
const signature = signManifest(manifest);
const client = new MosDeveloperPortalClient({ baseUrl: 'http://127.0.0.1:3000', token });
const result = await client.publishAppVersion(manifest, 'publish-1', signature);
```

## Signing (the optional hash attestation)

`signManifest(manifest)` computes the CANONICAL manifest fingerprint —
sha256 over the canonical JSON (object keys sorted at every level) +
the `|mkt-047-app-manifest` domain suffix — the identical value the /apps
registry computes server-side and persists on the immutable published row
(`createFingerprint`). At publish the registry verifies the
caller-supplied digest against its own computation; a mismatch is
rejected 422 with zero rows (fail-closed). Because published versions
are immutable, the attested digest stays verifiable forever: recompute
it from the published manifest and compare against the row's
`createFingerprint`.

## Layout

- `src/types.ts` — the frozen-mirror types (/apps + /app-installs read model)
- `src/vocabularies.ts` — the frozen runtime vocabulary copies + meanings
- `src/semver.ts` — the REAL semver comparator (the registry mirror)
- `src/fingerprint.ts` — the canonical manifest fingerprint + signature helpers
- `src/validate.ts` — the OFFLINE validator (manifest mirror + project checks)
- `src/scaffold.ts` — the App project scaffolder (deterministic)
- `src/docs.ts` — the offline documentation generator
- `src/client.ts` — the typed HTTP client (Developer Portal + registry routes)
- `cli.ts` — the CLI (scaffold | validate | sign | docs | publish)
