# STUDIO-007 — Audio/Video Capture (implementation runbook)

**Work Item:** STUDIO-007 (spec/effective-backlog-v1.7.md — the
audio/video capture layer: **"Implement approved audio/video capture
and durable artifact persistence through platform storage/access
ports. Acceptance: raw takes, alternates and participant/source
provenance are preserved; no long-running synchronous HTTP
processing."**; dependencies: STUDIO-001 — merged PR #73 (the runtime
whose 'recording' state this capture layer owns); STUDIO-002 — merged
PR #78 (the format capture-requirements declarations that fence which
modalities a format approves); STUDIO-003 — merged PR #81 (the
declared question/branch graph whose walked version + nodes the
graph-driven takes pin))
**Delivery:** worker delivery on branch `studio/007` from frozen main
`2921320` (the post-STUDIO-003 head; battery base 1403/773/1298; 59
enforced modules — /content-studio is already registered, NO checker
provision, NO new registration — one sanctioned registration-paragraph
extension SENTENCE, disclosed below).
**Migration:** `073_studio_av_capture.sql` (the TL pre-assigned tail
number: the ordered tail on frozen main 2921320 is …067 → 068 → 070 →
071; **072 is HELD by the in-flight parallel LAB-006 worker and 073
appends as the new tail** — the TL resolves any stacked shift at
merge, the 062/070 precedent).
**Primary contract:** spec/content-studio-contract-v1.0.md §9 "Capture"
(THE frozen rule this delivery implements, verbatim: "Capture is
modality-specific but format-neutral. The runtime may capture: audio;
video; screen/source material; multiple participant streams; alternate
takes. Raw captures are production artifacts and are not assumed to be
final content. Capture implementations must use approved storage/access
ports and preserve provenance. Long-running processing is
asynchronous/durable rather than a synchronous web request."), §5 (the
session lifecycle — capture happens inside the 'recording' state), §6
(the per-take interviewer-representation + recording provenance), §7
(the participant identity/grant/consent provenance), §12 (the artifact
package vocabulary — 'raw captures' + 'alternate takes' are the take
records STUDIO-010's package will cite), §16/§17/§18;
spec/architecture-v1.7-marketing-lab.md §27.7 ("A Studio session
produces a versioned Artifact Package that may contain: raw captures;
… alternate takes; … provenance/consent records; …"), §29 (the
standalone flow's "interview/capture → review/retake" steps), §30 (the
authority boundary); architecture-lock-v1.7 #36 ("Human-generated media
is an intermediate production artifact.") + #43;
src/modules/content-studio/public.ts (the frozen public surface this
delivery extends inside the SAME module).

---

## 1. What shipped

The audio/video capture layer — the §9 record surfaces over the
STUDIO-001 runtime + the STUDIO-002 format framework + the STUDIO-003
question/branch graph, inside the SAME module
(`src/modules/content-studio/**`):

| Surface | What shipped |
| --- | --- |
| The capture sessions | Migration 073's `studio_capture_sessions`: the RECORDING CONTEXT opened against one studio session revision while it is in the 'recording' state. Two capture modes: **'graph_walk'** — ADAPTIVE-INTERVIEWER-AWARE capture (the STUDIO-003 declared question/branch graph drives the capture steps; the capture session PINS the walked graph version bound to the session's exact request version — the conversation-walk binding, mirrored; a mid-capture graph correction never re-aims a running capture session, a NEW capture session walks the corrected version) and **'session_direct'** — the reaction / supplied-script shapes recording against the session itself. The interviewer representation of the recording context (the §6 seven-member closed vocabulary; module-guarded against the format's declared interviewer requirements: REQUIRED for interviewer formats, NULL for 'none' formats such as reaction). Immutable after creation (INSERT-only) — a changed recording context opens a NEW capture session |
| The raw takes | `studio_capture_takes`: EVERY take is an append-only durable row. The take lands its bytes through the platform ObjectStore port (see disclosure 1) and records the DURABLE ARTIFACT REFERENCE: the content-addressed object key (sha256) + digest + exact size + declared content type — platform-anchored references, NEVER a bytea column, NEVER module-local blob storage. Identity/provenance/artifact-reference immutable after insert |
| The walked-graph node pin | A graph_walk take carries its node pin: the walked graph id + version + the DECLARED question id this take answers (module-guarded against the pinned graph's declared nodes; the DB scope trigger re-reads the declared jsonb — the 070 conversation discipline). A session_direct take carries NO pin (the shape fences forbid both the half pin and the misdirected pin). The conversation steps (STUDIO-003, UNTOUCHED) cite takes by their opaque `studio-take:` references through the frozen `answerReference` seam — steps → take refs → takes reconstructs the full recording (the integration proof) |
| The alternates | §9 "alternate takes" as structure: a retake is a NEW take citing the take it alternates (`alternate_of_take_id`) — NEVER an overwrite (the append-only house discipline; the DB no-update/no-delete triggers + the module + the alternate-scope trigger fence it: an alternate shares the capture session, the node pin and the modality — a retake of the SAME capture moment). Both the original and every alternate are preserved and queryable (`listCaptureTakes` with the alternate filter) |
| The structural provenance | Every take carries, as NOT NULL columns (structural, never optional metadata): the PARTICIPANT IDENTITY reference (`participant_reference`), the optional-but-format-required §7 PARTICIPATION-GRANT reference (REQUIRED exactly when the session's format declares `explicit_grant_per_participant` — the podcasts; optional data for `single_scope` — reaction), the REQUIRED CONSENT references (1-16 opaque references via the IMMUTABLE `studio_capture_refs_all_bounded` helper — never empty), the SOURCE DEVICE/INPUT METADATA (the closed five-member input-kind vocabulary — the browser-capture surfaces the console contract reports, declared data only — + the bounded device label + the bounded declared metadata object), the INTERVIEWER REPRESENTATION of the recording context (recorded per-take so every take carries its recording context) and the session/capture-session lineage |
| The approved-capture fence | Capture is format-scoped (§2/§9): a take's modality must be one the session's format DECLARED in its `captureRequirements.modalities` (audio-podcast refuses video/screen takes; reaction records audio/video/screen; the three frozen STUDIO-002 declarations UNCHANGED — the zero-drift delivery). The take modality vocabulary is the closed §9 media-capture subset `['audio','video','screen']` ('participant_streams' and 'alternate_takes' are STRUCTURAL requirements a format declares, not the modality of one take — multiple streams are multiple takes, alternates are the alternate chain) |
| The async ingest contract | §9 "Long-running processing is asynchronous/durable rather than a synchronous web request" as STRUCTURE: every take is BORN `'processing'` (the DB born-processing trigger rejects any other birth state; the store insert pins the literal) — `recordCaptureTake` performs ONLY the validation + the storage-port landing + the row insert, then RETURNS. The post-landing analysis is the separate guarded completion: `completeCaptureTakeIngest` (processing → stored, with the bounded analysis payload + the honest §17 duration) and `failCaptureTakeIngest` (processing → failed, with the §17 closed-vocabulary reason + bounded detail). 'stored'/'failed' are terminal (the guarded UPDATE trigger freezes the ingest record; the honest retry is a NEW take row, optionally the alternate of the failed one). NO media-processing vocabulary exists anywhere in the module (the architecture proof) |
| The take-reference grammar | Every take mints the OPAQUE reference `'studio-take:' + uuid` (the `ca:` precedent; `mintContentStudioTakeReference`/`parseContentStudioTakeReference` + the CHECK-fenced grammar) — the reference the STUDIO-003 conversation steps' `answerReference` and the processing steps' outputs cite; resolution is the module's `getCaptureTakeByReference` |
| Tenant isolation | Every row CLIENT-scoped (the optional workspace anchor); every read resolves foreign scope to the uniform NotFound (no existence oracle — tested across all six read surfaces); the scope-consistency triggers reject cross-tenant capture sessions AND takes at the DB |

## 2. Module layout

```
src/modules/content-studio/
  public.ts                       — the frozen contracts + the §9 capture vocabularies + the take-reference grammar + the 9 new record/input types + the 9 new API methods (STUDIO-007 extension)
  internal/validation.ts          — the pure §9 capture guards (the session input, the raw-take input with the STRUCTURAL provenance fence, the ingest completion/failure, the bounded take query)
  internal/content-studio-store.ts — the migration-064/068/070 persistence + the migration-073 two-table persistence (the row mappers, the CAS ingest-state advance)
  internal/content-studio-module.ts — the orchestration + the capture flow (the recording-state gate, the format-driven fences, the walked-graph pin resolution, the alternate fence, the storage-port landing, the guarded ingest completions)
```

The structure is unchanged (public.ts + internal/ only — the frozen
boundary shape, re-proven by the boundary suite). ONE new structural
port: the platform **ObjectStore** (`readonly objects: ObjectStore` on
`ContentStudioModuleDeps` — the platform
`src/platform/objects/contract.ts` import, the same platform storage
access port /content-assets itself consumes; see disclosure 1). Zero
cross-module imports (the /lab family discipline; the boundary suite
re-proves the import scan + the real checker). NO second Studio
runtime — the nine capture methods ride the ONE `ContentStudioModuleApi`.

## 3. Migration 073 — the fences

- Two own tables ONLY: `studio_capture_sessions` +
  `studio_capture_takes` — no v1.6 authority table, no
  /content-assets or /content-rights table (the durable object
  references are platform-anchored opaque strings, NEVER FKs), no
  other module's table. **ZERO cross-table DDL** (stricter than 070:
  not even an additive CHECK on `studio_formats` — the capture surface
  needs no foreign declaration field). The FK anchors are EXACTLY the
  tenant tables (agencies, clients, workspaces) + the same-module rows
  (the session revision, the declared question-graph version, the
  capture session, the alternate take).
- CHECK-fenced closed vocabularies: the capture modes, the take
  modalities, the ingest states, the input kinds, the §17 failure
  reasons, the §6 interviewer representations (both tables), the
  take-reference grammar (`^studio-take:<uuid>$`), the content-addressed
  object key/digest (`^[0-9a-f]{64}$`), the MIME-shaped content type
  and the pinned `'content-studio-capture-v1'` contract identity (the
  FOURTH sub-contract identity inside the one module — the 064/068/070
  identities stay pinned on their tables, untouched).
- THE SHAPE FENCES: the mode-graph pairing (a graph_walk capture
  session carries its walked-graph pin; a session_direct one carries
  none), the node-pin completeness (all three pin columns or none),
  the ingest-completion pairing (processing ↔ no completion timestamp;
  terminal ↔ completed), the failure pairing (failed ↔ reason; non-
  failed ↔ neither reason nor detail) and the analysis pairing (the
  completion payload exists only on stored takes).
- ONE IMMUTABLE SQL helper (the 068 discipline):
  `studio_capture_refs_all_bounded(jsonb)` — the consent-reference
  array is non-empty (1-16), all strings, all bounded.
- THE BORN-PROCESSING FENCE: a BEFORE INSERT trigger rejects any take
  born outside 'processing' — the async-ingest contract is structural.
- THE GUARDED INGEST STATE MACHINE: the identity/scope/linkage/
  provenance/artifact-reference columns are immutable after insert
  (only the ingest columns + updated_at advance); the legal edges are
  exactly processing → stored | failed; terminal takes frozen outright;
  the ingest payload rides the state advance only (a processing take
  cannot carry its completion ahead of the advance; a terminal take's
  payload is frozen).
- THE APPEND-ONLY DISCIPLINE: capture sessions INSERT-only (no
  update, no delete — a changed recording context is a NEW capture
  session); takes never deleted (the raw-capture history is append-only
  evidence — §12 'raw captures' preserved as data).
- THE SCOPE TRIGGERS (the 070 conversation-scope pattern): the capture
  session must bind an existing session revision of the SAME client IN
  THE 'recording' STATE, and a graph_walk capture session must pin the
  declared graph bound to the session's OWN request version; a take
  must bind its capture session's session revision, record only while
  the session is STILL 'recording', pin its capture session's OWN
  walked graph (graph_walk) or carry no pin (session_direct) with a
  DECLARED node of that graph, and cite an alternate of the SAME
  capture session + node pin + modality.
- Pure DDL (no INSERT anywhere); no secret-capable column; NO binary
  column (CRED-001 — the media bytes live in the platform object store
  behind the recorded content-addressed references).

## 4. Operating the capture layer

- **Adaptive-interviewer podcast capture:** create the request
  (input mode 'question_list') → `recordSuppliedQuestionGraph` (or the
  generated path through `recordIntent` → `recordGeneratedQuestionGraph`
  → review/approve) → `openSession` → advance `preparing` →
  `recording` → `openCaptureSession({ captureMode: 'graph_walk',
  interviewerRepresentation: 'voice' })` — the capture session pins the
  walked graph version → `recordCaptureTake` per answered node
  (`questionId: 'qN'` — the node pin) → alternates via
  `alternateOfTakeId` → `recordConversationStep` citing the chosen
  take's `takeReference` as the answer → advance `recording` →
  `processing` (the durable step plan is born) → claim/complete the
  steps (the capture_ingestion stage's output cites the take
  references) → review → completed.
- **Reaction capture:** create the request (format 'reaction') →
  `openSession` → `preparing` → `recording` → `openCaptureSession({
  captureMode: 'session_direct' })` (NO interviewer representation —
  the format declares 'none') → `recordCaptureTake` (audio/video/screen;
  no node pin) → the ingest completions → the processing plan.
- **The async ingest:** `recordCaptureTake` returns as soon as the
  bytes are durably landed (born 'processing'); a worker later calls
  `completeCaptureTakeIngest` (with the probe/analysis payload + the
  duration) or `failCaptureTakeIngest` (the §17 reason). A failed
  ingest's honest retry is a NEW take row citing the failed one as its
  alternate.
- **Reads:** `getCaptureSession`/`listCaptureSessions`;
  `getCaptureTake`/`getCaptureTakeByReference` (the answer-reference
  resolution seam)/`listCaptureTakes` (the bounded query: per session,
  per capture session, per walked-graph node, per modality, per
  alternate chain — the raw-capture + alternates + provenance
  retrieval surface STUDIO-010's artifact package will cite).

## 5. Honest disclosures

1. **THE STORAGE-PORT CHOICE (the disclosed judgment call):** the raw
   take bytes land through the PLATFORM ObjectStore port —
   `objects: ObjectStore` on the module deps, wired at the composition
   root with the SAME platform objects instance /content-assets uses
   (the existing /content-assets storage discipline: content-addressed
   platform-anchored references — key = sha256, idempotent put, the
   same store, the same adapters). This delivery does NOT route takes
   through `/content-assets` `registerAssetVersion` +
   `materializeAssetVersion`: that path is the ACQUIRED-SOURCE surface
   (every source version REQUIRES an /evidence-anchored
   `sourceEvidenceRef` — the FK + same-client DB backstop), built for
   material acquired from providers/research; an in-session raw
   recording is ORIGINAL production material, not acquired evidence —
   forcing every take through an /evidence record would be a
   cross-authority write (evidence is a singular v1.6 authority) and
   would place INTERMEDIATE captures into the reusable content-asset
   registry that Rights/Distribution consume — before any
   rights/consent determination, against §16 ("The Studio MUST NOT …
   turn a participant contribution into an unrestricted reusable asset
   without the necessary rights/consent") and lock v1.7 #36
   ("Human-generated media is an intermediate production artifact").
   The take rows therefore record the platform-anchored content
   address directly; the STUDIO-010/011 finalization path is where
   material becomes content assets through the existing authorities.
   The brief's "content-addressed or platform-anchored references" is
   satisfied by BOTH properties of the one chosen port.
2. **The per-take async ingest state machine is the module's own
   born-running completion pattern** (the brief's sanctioned shape):
   takes are born 'processing' and complete/fail through guarded
   terminal advances — a small state machine whose driver today is the
   step driver/worker (nothing in THIS delivery performs analysis: the
   module contains zero media-processing vocabulary, proven
   structurally). The session-level durable step plan (STUDIO-001)
   remains the production-processing surface; the two are deliberately
   NOT coupled (the review guard stays the step+output guard — a take
   still 'processing' does not block the session advance; the
   capture_ingestion step's driver owns completing its takes before
   completing the step). Disclosed as the minimal §9-verbatim shape.
3. **The take-modality vocabulary is the closed §9 media-capture
   subset** `['audio','video','screen']` — the three single-media
   capture kinds of "The runtime may capture: audio; video;
   screen/source material". 'participant_streams' and
   'alternate_takes' (§9/§2 vocabulary members) are STRUCTURAL
   requirements a format declares, not the modality of one take:
   multiple participant streams are multiple takes (each carrying its
   own participant provenance); alternates are the alternate chain.
   The full multi-account session surface itself is STUDIO-006.
4. **The interviewer representation is recorded per-take but NOT
   per-take-declared:** every take inherits its CAPTURE SESSION's
   representation (the recording context — one source of truth); a
   mid-capture representation change (voice → avatar) opens a NEW
   capture session (the re-take/re-conversation discipline). The
   input deliberately carries no representation override.
5. **The take↔conversation binding is one-directional from the frozen
   STUDIO-003 side:** the conversation step's `answerReference` cites
   the take's `studio-take:` reference; the take carries its node pin
   (graph version + declared question). This delivery did NOT touch
   the frozen STUDIO-003 surfaces (no answerReference grammar
   enforcement was added to `recordConversationStep` — its
   answerReference stays opaque by contract). The reconstruction join
   (steps → take refs → takes) is provided by
   `getCaptureTakeByReference` and proven in the integration battery.
6. **The initial format declarations are UNCHANGED (the zero-drift
   delivery):** the reaction format's `capture_ingestion` stage keeps
   its honest `awaiting_execution_module` availability (the
   STUDIO-003 precedent — the stage-availability layer describes the
   FORMAT-EXECUTION integration, which is STUDIO-011/012/013's; this
   delivery provides the record surfaces the execution will drive).
   The three captureRequirements declarations stay verbatim.
7. **The registration-paragraph extension is ONE additive sentence**
   (the brief's sanctioned surface): spec/architecture.md §6's
   /content-studio paragraph now carries a closing sentence
   disclosing the STUDIO-007 capture surface + the platform ObjectStore
   port + the never-a-/content-assets-registration boundary. The
   existing paragraph text (the STUDIO-001-era "consumes platform
   ports only (db, clock, ids)" sentence, already one step stale from
   the STUDIO-001 agentBodies/format seams) is untouched — the TL may
   canonicalize the whole paragraph at harvest (the STUDIO-002/003
   precedent was ZERO spec writes; this delivery's single sanctioned
   sentence is disclosed in the worklog + here).
8. **No route/console surface ships in this delivery** (the Work Item
   is the module + the records + the fences + the proof battery), per
   the frozen plan (UX-009 and successors carry the console); the
   browser-capture APIs (getUserMedia & co.) surface through the
   console contract at that point — this module records DECLARED input
   data only, zero provider SDK, zero browser API surface.
