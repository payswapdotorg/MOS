# STUDIO-002 — Pluggable Format Framework (implementation runbook)

**Work Item:** STUDIO-002 (spec/effective-backlog-v1.7.md — the format
contract and registry: **"Build the format contract and registry.
Acceptance: formats declare input, participant, capture, interviewer,
organization, output, provenance and evaluation contracts; new formats
do not require another Studio runtime."**; dependencies: STUDIO-001 —
merged PR #73 on frozen main eec1eee)
**Delivery:** worker delivery on branch `studio/002-worker-delivery`
from frozen main `eec1eee` (56 enforced modules at base: 55 spec-parsed
+ the single `/apps` provision).
**Migration:** `068_studio_format_framework.sql` (068 PRE-ASSIGNED by
the Tech Lead: the migration tail on frozen main is 065; 066 is held
by the in-flight parallel LAB-004 worker and 067 by the LAB-013
worker — the TL reconciles numbering at merge, the 062/063/064/065
precedent).
**Primary contract:** spec/content-studio-contract-v1.0.md §2 (THE
format declaration surface — the nine declared fields + "The format
registry MUST be pluggable" + "Adding a future format MUST NOT
require a second Studio runtime or a second Lab authority"), §3 (the
production request carries the selected format), §6 (the single-person
podcast interviewer models), §7 (the multi-person participation
grants), §12 (the output artifact package vocabulary),
spec/architecture-v1.7-marketing-lab.md §27.5/§27.6/§27.7,
spec/architecture-lock-v1.7.md rules #38–#44,
src/modules/content-studio/public.ts (the frozen public surface).

---

## 1. What shipped

The Pluggable Format Framework — the FULL format contract and registry
over the STUDIO-001 Content Studio Runtime, inside the SAME module
(`src/modules/content-studio/**`), extending the SAME §2 seam:

| Surface | What shipped |
| --- | --- |
| The nine §2 declaration surfaces | Every declared field is a validated, closed-vocabulary-backed declared-data surface: (1) format identity/version (the registry's natural key; identity immutable across the chain); (2) input requirements (§8 input-mode subset + the source-artifact mode); (3) participant model (the §7 {min,max} participant range + human-capture mode + the §7 participation grant model — `single_scope` ⟺ max=1, `explicit_grant_per_participant` ⟺ max>1, the pairing fenced); (4) capture requirements (§9 modality subset); (5) interviewer requirements (the §6 + §27.6 representation subset incl. `multimodal_declared` + the §6 follow-up discipline `adaptive`/`fixed`); (6) organization compatibility (minAgentBodies + the CLOSED §14 action-kind permission subset + opaque requiredCapabilities); (7) output artifact contract (the CLOSED §12 16-kind artifact vocabulary); (8) provenance/consent requirements (the closed 4-kind consent + 10-element provenance vocabularies); (9) evaluation hooks (hookId + the closed firing surface `stage_completion`/`output_recorded` + the stageId cross-reference fence). All one-level declared data (the LAB-011 contract discipline) — never runtime logic the format cannot inspect |
| The honest availability layer | Every processing stage declares its availability: `runtime_driven` (the current runtime executes the stage's contract surface end-to-end through the durable claim/complete machinery) or `awaiting_execution_module` (+ the required `awaitingModule` citation, e.g. `STUDIO-007`) — the STUDIO-002 gap disclosure AS DATA. The runtime does NOT gate execution on it (a disclosure, never a silent overstatement) |
| The three initial formats | `reaction`, `audio-podcast`, `video-podcast` promoted from the STUDIO-001 minimal DATA to the FULL nine-surface declarations (the podcasts declare all seven §6/§27.6 interviewer construction options + `adaptive` follow-ups + the §7 multi-person participant range 1..16 with explicit per-participant grants; the reaction is single-scope with no interviewer) with honest per-stage availability (the reaction's capture/treatment stages await STUDIO-007/STUDIO-008; the podcasts' script/interviewer/treatment stages await STUDIO-003/STUDIO-004/STUDIO-008; every `output_assembly` stage is runtime-driven today) |
| The versioned format registry | Migration 068's `studio_formats`: one row per (client, format_id, format_version) carrying the FULL §2 declaration as CHECK-fenced declared jsonb + the `draft → active → retired` lifecycle (the /lab-agent-body versioned-registry precedent: append-only version corrections, identity immutable, opaque `format_version_id` uuid, no resurrection) + the born-draft fence + the activation capability-consistency fence + the version-chain scope fence + no delete |
| The format-capability link records | Migration 068's `studio_format_capabilities`: the append-only normalization of a format version's declared `requiredCapabilities` (OPAQUE capability-reference strings — the capability ENGINE is /lab-capabilities (LAB-013), never this module; no capability table is created or referenced). INSERT-only, UNIQUE per (format_version_id, capability_reference), scope-consistent with the parent registry row |
| The registry semantics | `registerFormat` (validates the full declaration, inserts DRAFT + links transactionally; duplicates and broken version chains rejected), `activateFormat` (draft → active), `retireFormat` (active → retired), `getFormat`/`listFormats` (the per-tenant read surface). The compatibility resolution at session open resolves the request's selected format through the registry — ACTIVE versions only (draft/retired refuse with the honest lifecycle state; foreign/unknown scope resolves to the uniform NotFound — no existence oracle) |
| The retirement discipline | Retirement NEVER breaks running sessions: the session carries the bound format identity/version as its own recorded data; the running session's declaration reads resolve under ANY lifecycle status (the registry never deletes); the session's treatment revisions continue under the same any-status read; only NEW sessions (and revised requests selecting a DIFFERENT format) resolve through the active-only path |
| The materialization seam | The composition-root wired initial formats (the STUDIO-001 seam, unchanged wiring) materialize per CLIENT scope — materialize-if-absent, born draft + links + the guarded activation in ONE transaction (born active through the same lifecycle every format takes). Idempotent, race-safe (transaction-scoped re-check), and a tenant's own registry state (a retirement, a corrected version, a tenant-registered row of the same identity) is never resurrected or overwritten |
| The pluggability proof | THE core acceptance: a test-only custom format registered through the PUBLIC seam (`registerFormat` → `activateFormat`) drives a FULL session end-to-end — request → open (the compatibility resolution) → processing (the plan derived from the DECLARED stages) → claim/complete → output version → review → completed — through the SAME runtime with ZERO runtime changes (the integration proof + the structural boundary proof: no per-format identity branch exists anywhere in the implementation code) |

## 2. Module layout

```
src/modules/content-studio/
  public.ts                      — the frozen contracts + the CLOSED §2 vocabularies + the registry API (STUDIO-002 extension)
  internal/validation.ts          — the pure nine-surface declaration guards + the availability/hook/participant fences
  internal/content-studio-store.ts — the migration-064 persistence + the migration-068 registry persistence
  internal/content-studio-module.ts — the orchestration + the registry semantics + the DB-backed compatibility resolution + the lazy materialization
```

The structure is unchanged (public.ts + internal/ only — the frozen
boundary shape); the framework extends the existing three internal
files. Zero cross-module imports (the /lab family discipline; the
/labs-agent-body consumption stays the composition-root-wired
READ-ONLY structural port).

## 3. Migration 068 — the fences

- Two own tables ONLY: `studio_formats`, `studio_format_capabilities`
  — no v1.6 authority table, no /lab-agent-body table, NO
  /lab-capabilities table (the capability references are OPAQUE
  strings; the engine is Worker-B's LAB-013).
- The FK anchors are EXACTLY the tenant tables (agencies, clients,
  workspaces) + the same-module `studio_formats` row.
- CHECK-fenced closed vocabularies over the declared jsonb through
  three IMMUTABLE SQL helpers (`studio_format_jsonb_strings_all_in`,
  `studio_format_hook_fireson_in`,
  `studio_format_stages_available`): the §8 input modes, the §7
  participation grant models, the §9 capture modalities, the §6/§27.6
  interviewer representations, the follow-up discipline, the §14
  action-kind permissions, the §12 artifact kinds (16), the consent
  kinds (4), the provenance elements (10), the hook firing surfaces,
  the availability states + the required awaitingModule citation, the
  natural-key shape fences and the pinned
  `'content-studio-format-v1'` contract identity.
- THE GUARDED LIFECYCLE: born DRAFT (the BEFORE INSERT fence — a
  stronger fence than the 063 precedent, disclosed); identity/scope/
  declaration immutable after insert (only status + updated_at
  advance); the legal edges draft → active | retired, active →
  retired (no resurrection, no downgrade); ACTIVATION requires the
  capability link records to match the declared requiredCapabilities
  EXACTLY; no delete ever.
- THE VERSION-CHAIN SCOPE FENCE: registering version n > 1 requires
  version n-1 in the same client scope AND the chain's
  agency/client/workspace kept — cross-tenant/cross-workspace chain
  poisoning rejected at the DB.
- THE LINK DISCIPLINE: INSERT-only (no UPDATE, no DELETE), UNIQUE per
  (format_version_id, capability_reference), the closed
  `capability_kind` vocabulary (`'required'`), the scope-consistency
  trigger against the parent registry row.
- The initial registry CONTENT is NOT seeded (the house pure-DDL
  discipline — no INSERT anywhere): the three initial formats are the
  composition-root wired declarations the module materializes per
  scope (the disclosed design).

## 4. Operating the registry

- **Register a format:** `registerFormat({ scope, declaration })` →
  the DRAFT row + its capability links. Version n > 1 requires
  version n-1 in scope (the append-only correction chain).
- **Activate:** `activateFormat(scope, formatId, formatVersion)` —
  draft → active (the DB trigger verifies the capability links match
  the declaration). Only ACTIVE versions open sessions.
- **Retire:** `retireFormat(scope, formatId, formatVersion)` — new
  session resolutions refuse with the honest lifecycle state; running
  sessions and their treatment loops continue unaffected.
- **Read:** `getFormat` / `listFormats(scope)` — the per-tenant
  registry view (any status); the wired initial formats
  materialize-if-absent on read.
- **Tenant isolation:** every registry/link record is CLIENT-scoped
  (the optional workspace anchor); foreign scope resolves to the
  uniform NotFound (no existence oracle); the DB scope-consistency
  triggers reject cross-tenant injection.

## 5. Honest disclosures

1. **The lazy materialization design (the disclosed judgment call):**
   the frozen contract requires the three initial formats be supported
   out of the box in every tenant, while every registry record is
   CLIENT-scoped and migrations seed nothing. The resolved design: the
   composition-root wired declarations materialize per CLIENT scope
   on first read (materialize-if-absent → born draft + links + the
   guarded activation, transactionally). Alternatives rejected: a
   global seed (violates the per-client scoping), a per-client
   provisioning verb (breaks the out-of-the-box availability), an
   in-memory fallback resolution (two sources of truth). A tenant's
   own registry state is never resurrected or overwritten — a tenant
   may pre-register or retire an initial format identity in their own
   scope and the materialization respects it.
2. **The born-draft fence is stronger than the 063 precedent** (which
   allows any status at insert): migration 068 rejects an INSERT
   carrying a non-draft status outright, so every active format passed
   the activation-consistency gate. Disclosed as a deliberate
   tightening of the /lab-agent-body discipline.
3. **The availability layer is a disclosure, not an execution gate:**
   the runtime does not block a session because a stage declares
   `awaiting_execution_module` — the declaration is the format's
   honest statement of what is shipped (the future modules'
   §18 proof obligations); a driver completing such a stage today is
   executing the stage's contract surface (e.g. a test driver), which
   the runtime permits and records.
4. **The vocabularies the frozen contract leaves unnamed** (the
   consent kinds, the provenance elements, the hook firing surfaces,
   the participation grant models, the §27.6 "another declared
   multimodal interviewer representation" → `multimodal_declared`)
   are grounded member-by-member in contract phrases (§6/§7/§11/§12/
   §16/§27.6) and pinned in both the module guards and the
   migration-068 CHECK fences; extending a vocabulary is a guarded
   migration + a module release, never a silent drift.
5. **No route/console surface ships in this delivery** (the Work
   Item is the module + the registry + the proof battery); the
   `listFormats` read became scope-based + async with the registry —
   the console's format surface arrives with the later UX Work Items
   (UX-009 and successors), per the frozen plan.
