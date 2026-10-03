# STUDIO-003 — Intent → Script / Question Graph (implementation runbook)

**Work Item:** STUDIO-003 (spec/effective-backlog-v1.7.md — the
intent-to-script pipeline: **"Support user-provided scripts/questions
and intent-driven generation. Acceptance: versioned scripts/question
graphs, explicit human-review option, adaptive branching hooks,
provenance of generated material."**; dependencies: STUDIO-001 —
merged PR #73; LAB-011 — merged PR #70)
**Delivery:** worker delivery on branch `studio/003-worker-delivery`
from frozen main `3d5de78` (59 enforced modules: 58 spec-parsed + the
single `/apps` provision; /content-studio is already registered — NO
spec append, NO checker provision, NO matrix row).
**Migration:** `070_studio_script_question_graph.sql` (070
PRE-ASSIGNED by the Tech Lead: the ordered tail on frozen main
3d5de78 is …065 → 066 → 067 → 068 → 071; 069 is held by the in-flight
parallel MKT-073 worker and 071 is taken by the merged LAB-005
delivery — **070 slots into the 068→071 gap**; the TL resolves any
stacked shifts at merge, the 062/063/064/065/068 precedent).
**Primary contract:** spec/content-studio-contract-v1.0.md §3 (the
production request carries "explicit script/question list if
supplied; intent if script is not supplied"), §8 "Intent-to-script"
(THE frozen flow implemented), §6 (the interviewer adaptation +
provenance preservation), §12 (the question/answer graph artifact
kind), §17/§18; spec/architecture-v1.7-marketing-lab.md §27.5 (the
production request shapes), §27.6 (the interviewer question/branch
graph usage), §28 (the Lab invocation boundary — the module composes,
never becomes a second authority);
src/modules/content-studio/public.ts (the frozen public surface this
delivery extends inside the SAME module).

---

## 1. What shipped

The Intent → Script / Question Graph pipeline — the §8 record
surfaces over the STUDIO-001 runtime + the STUDIO-002 format
framework, inside the SAME module (`src/modules/content-studio/**`):

| Surface | What shipped |
| --- | --- |
| The four request paths | (1) **supplied script** — `recordSuppliedScript` materializes the request's declared script as the VERSIONED SCRIPT chain v1 (origin 'supplied': NO generation, NO review state; `appendSuppliedScriptVersion` appends the append-only corrections); (2) **supplied question list** — `recordSuppliedQuestionGraph` materializes the request's question list as the DECLARED question/branch graph (the deterministic LINEAR derivation: questions in the supplied order, each followed by the next under 'always', the first question as the entry; `appendSuppliedQuestionGraphVersion` appends corrected REAL branch graphs); (3) **intent-only** — `recordIntent` materializes the request's declared objective (sourceReferences empty) as the immutable INTENT record; (4) **intent + source** — the same intent record carrying the supplied source/reference material citations (OPAQUE strings). The generation paths 3/4 continue through `recordGeneratedScript` / `recordGeneratedQuestionGraph` |
| The intent records | Migration 070's `studio_intents`: one immutable row per (request, request version) — the §3 request linkage is the natural key; the declared objective + the OPAQUE source citations; the intent-mode fence at the DB (a script/question_list request never materializes an intent) |
| The versioned script/question-graph records | `studio_scripts` + `studio_question_graphs`: one version CHAIN per (request, request version) — the one-materialization fence (a request version materializes EITHER a script chain OR a graph chain, never both; enforced by the module + the DB scope triggers); origin 'supplied' (no provenance, no review) or 'generated' (the FULL provenance + the review lifecycle, BORN 'pending'); append-only version corrections under the same chain id with the chain-scope fence; regenerations supersede the prior version transactionally (the autonomous supersession decision rides the append-only review tail) |
| The generation provenance | EVERY generated record carries the generator identity (the organization declaration recorded VERBATIM — identity, version, the agent-body references, the capabilities) + the participating model/capability references (OPAQUE strings) + the intent lineage (FK → `studio_intents`, whose row carries the source citations that produced it). The origin-shape CHECK fence makes provenance-less generated rows structurally inexpressible; the record views expose the provenance as non-nullable on generated records |
| The explicit human-review option | The guarded review lifecycle on generated rows: born 'pending'; the closed vocabulary pending → approved \| rejected \| superseded, approved \| rejected → superseded (no resurrection, no downgrade — the /lab-agent-body + format-registry status-guard precedent); every advance is backed by a matching append-only DECISION record (`studio_script_reviews` / `studio_question_graph_reviews`: the verdict, the reviewer actor + the HONEST autonomous/human split, the bounded note); the decision-then-advance ordering is DB-enforced (a state advance with no matching decision record is rejected). Supplied material carries NO review state — user-authored material is its own authority |
| The format-requires-confirmation gate | §8 "reviewable before recording when the format requires explicit user confirmation" honored STRUCTURALLY: the OPTIONAL format inputRequirements field `generatedInputReview: 'required' \| 'not_required'` (ABSENT = not required — every STUDIO-002 declaration and every materialized tenant registry row is unaffected; the closed vocabulary is CHECK-fenced by the additive same-module constraint on `studio_formats`). When 'required' + the request's input mode is 'intent': a session OPEN refuses when the request version's materialized chain exists but its latest version is not approved (a request cites only APPROVED generated material), and the RECORDING advance requires the chain to EXIST and its latest version to be approved (the interview needs the approved material). A 'not_required' format never blocks (the autonomous path) |
| The adaptive-branching hooks | Migration 070's `studio_conversation_edges`: the CHOSEN-EDGE append surface. Every conversation step records: the question asked (a DECLARED node), the recorded answer (the OPAQUE answer reference + the closed answer kind audio/video/text), the CHOSEN declared edge (the target question + the declared condition — validated against the declared graph version this conversation walks, by the module AND by the DB trigger re-reading the declared jsonb) and the honest chooser split (interviewer = the autonomous adaptive interviewer vs human). The conversation is a CONNECTED walk (step n+1 asks step n's chosen target; seq 1 asks the declared entry; a follow-up-less conversation cannot grow); each conversation pins the walked graph version at its first step (a mid-conversation graph correction never re-aims a running conversation — a NEW conversation walks the corrected version). The interviewer CHOICE MECHANICS are STUDIO-004 — this surface is where the choices land as preserved data (§8 "preserving the resulting conversation graph") |
| The deterministic adjacency | The declared question/branch graph shape: 1-128 question nodes (unique bounded ids + trimmed texts + optional closed modality hints from the SAME 7-member interviewer-representation vocabulary the formats use), 0-256 declared edges (endpoints ARE declared nodes, no self-loops, the condition from the closed 6-member vocabulary: always + on_answer_positive/negative/neutral/elaborate/abbreviated), at most ONE edge per (from-question, condition) — a follow-up chosen by condition resolves to exactly one next question. CHECK-fenced by the IMMUTABLE SQL helpers (the 068 discipline) + the module's pure guards |
| Tenant isolation | Every row CLIENT-scoped (the optional workspace anchor); every read resolves foreign scope to the uniform NotFound (no existence oracle — the request-version resolvers are fenced by the request's own tenant fence); the scope-consistency triggers reject cross-tenant injection on all six tables; the chain-scope fences reject cross-tenant/cross-request version corrections |

## 2. Module layout

```
src/modules/content-studio/
  public.ts                       — the frozen contracts + the §8 vocabularies + the 21 new record/input types + the 21 new API methods (STUDIO-003 extension)
  internal/validation.ts          — the pure §8 guards (the declared-graph discipline, the linear derivation, the provenance, the review decision, the conversation choice) + the generatedInputReview format field
  internal/content-studio-store.ts — the migration-064/068 persistence + the migration-070 six-table persistence (the row mappers, the guarded review-state CAS advances)
  internal/content-studio-module.ts — the orchestration + the intent-to-script flow + the generated-input review gates (session open, the recording advance, the treatment successor) + the conversation walk
```

The structure is unchanged (public.ts + internal/ only — the frozen
boundary shape); the pipeline extends the existing three internal
files. Zero cross-module imports (the /lab family discipline; the
/labs-agent-body consumption stays the composition-root-wired
READ-ONLY structural port). ZERO new structural ports: the module
deps stay db + clock + ids + agentBodies + formats (the STUDIO-002
wiring precedent — the composition root is comment-only).

## 3. Migration 070 — the fences

- Six own tables ONLY: `studio_intents`, `studio_scripts`,
  `studio_script_reviews`, `studio_question_graphs`,
  `studio_question_graph_reviews`, `studio_conversation_edges` — no
  v1.6 authority table, no /lab-agent-body table, no
  /lab-capabilities table, no other module's table. The FK anchors
  are EXACTLY the tenant tables (agencies, clients, workspaces) + the
  same-module rows (the exact request version, the intent, the
  script/graph chain, the session revision).
- The ONE additive cross-table DDL: the CHECK constraint on the
  SAME-MODULE `studio_formats` table fencing the closed vocabulary of
  the new OPTIONAL `inputRequirements.generatedInputReview` field
  (every existing declaration and materialized registry row carries
  no such field — NULL passes; disclosed as the smallest
  architecture-consistent extension of the §8 "when the format
  requires explicit user confirmation" declaration).
- CHECK-fenced closed vocabularies: the origins, the review states,
  the review verdicts, the reviewer kinds, the answer kinds, the
  chooser kinds, the branch conditions, the question modality hints
  (the same 7-member interviewer-representation set) and the pinned
  `'content-studio-script-v1'` contract identity (the THIRD
  sub-contract identity inside the one module — the runtime-v1 and
  format-v1 stay pinned on their tables).
- THE ORIGIN-SHAPE FENCE: a supplied row carries no generation
  provenance and no review state; a generated row REQUIRES the intent
  lineage + the generator organization + the model references + the
  review state (provenance-less generated rows are inexpressible).
- THE GUARDED REVIEW LIFECYCLE: generated rows are BORN 'pending'
  (the born-pending fence); identity/scope/linkage/provenance
  immutable after insert (only review_state + updated_at advance);
  the legal edges pending → approved | rejected | superseded,
  approved | rejected → superseded; every advance backed by a
  matching append-only decision record (the decision-then-advance
  trigger ordering — the review INSERT fires first, the state UPDATE
  verifies the decision exists).
- THE VERSION-CHAIN + ONE-MATERIALIZATION FENCES: version n>1 requires
  n-1 under the same chain id with the chain's scope + request
  linkage; ONE script chain or ONE graph chain per (request, request
  version) — never both; the request's input mode matches the origin
  (script/question_list ⟺ supplied; intent ⟺ generated).
- THE CONVERSATION-GRAPH FENCE: every step binds the session revision
  + the walked declared graph version (which must be bound to the
  session's OWN request version); the asked question is a declared
  node; seq 1 asks the declared entry; a present chosen edge IS a
  declared edge; the per-conversation seq is UNIQUE.
- BEFORE INSERT trigger firing order note (disclosed): the triggers
  fire alphabetically — chain-scope, scope, THEN born-pending — so
  the scope fences reject a row before the born-pending fence when
  both would fire.
- Pure DDL (no INSERT anywhere); no secret-capable column; no binary
  column.

## 4. Operating the pipeline

- **Supplied script:** create the request (input mode 'script') →
  `recordSuppliedScript({ scope, requestId })` → chain v1 (the body
  IS the request's declared script — single source of truth);
  corrections via `appendSuppliedScriptVersion`.
- **Supplied question list:** create the request (mode
  'question_list') → `recordSuppliedQuestionGraph` → the derived
  linear graph v1; corrected branch graphs via
  `appendSuppliedQuestionGraphVersion`.
- **Intent (± source):** create the request (mode 'intent', the
  optional `sourceArtifactReferences`) → `recordIntent` (the lineage
  anchor) → the selected organization generates OUTSIDE this module
  (the step driver / the Lab) → `recordGeneratedScript` /
  `recordGeneratedQuestionGraph` citing the intentId + the FULL
  generator provenance → born 'pending' → `reviewScript` /
  `reviewQuestionGraph` (the human or autonomous decision) →
  `openSession` (the confirmation gate applies when the format
  requires) → `advanceSession(recording)` (the recording gate) →
  `recordConversationStep` per interview step (the adaptive
  interviewer — STUDIO-004's runtime — records its choices here).
- **Regeneration:** call `recordGeneratedScript`/`Graph` again for
  the same request version — the new version lands born 'pending'
  and the prior version is superseded transactionally (the autonomous
  decision rides the review tail).
- **Reads:** `getIntent`/`getIntentForRequest`, `getScript`/
  `listScriptVersions`/`getScriptForRequest`/`listScriptReviews`
  (same set for graphs), `listConversationSteps` (the resulting
  conversation graph as data).

## 5. Honest disclosures

1. **The generatedInputReview field is an OPTIONAL extension of the
   STUDIO-002 declaration shape** (the §8 "when the format requires
   explicit user confirmation" needs a per-format declaration the
   nine-surface shape did not carry). ABSENT means 'not_required':
   the three frozen initial format declarations are UNCHANGED (the
   zero-drift delivery — an already-materialized tenant registry row
   never differs from the wired content; a future format version
   declares the requirement explicitly). The closed vocabulary is
   CHECK-fenced by the additive same-module constraint on
   studio_formats.
2. **The gate is the RECORDING gate (§8 verbatim: "reviewable before
   recording") + the session-open citation gate** (the TL's "a
   production request against a format that requires confirmation can
   cite ONLY an approved generated script/graph"): an open session
   passes with NO materialized chain (the in-session generation path
   — the organization may generate during the session; the recording
   gate then catches it), but refuses when a chain exists unapproved;
   the recording advance requires the chain to exist AND be approved.
   A confirmation-requiring format whose sessions skip the recording
   state entirely (direct preparing → processing) does not pass the
   recording gate — such a format should declare its flow through
   recording (the runtime supports preparing → recording →
   processing). This is the smallest §8-verbatim-consistent
   interpretation.
3. **The branch-condition vocabulary is the DISCLOSED mapping** of §8
   "choose a follow-up ... based on the preceding answer" to a closed
   deterministic set: 'always' + the five answer-shaped conditions
   (on_answer_positive/negative/neutral/elaborate/abbreviated). The
   answer kinds (audio/video/text) are grounded in §9 capture + the
   voice+text interviewer surface; the chooser kinds
   (interviewer/human) are the §6 generated-versus-human-authored
   distinction applied to the branch choice. Extending either
   vocabulary is a guarded migration + a module release, never a
   silent drift.
4. **The supplied question list derives as the deterministic LINEAR
   graph** (questions in order, 'always' edges, the first question as
   the entry) — the smallest architecture-consistent materialization
   of a flat list as a declared graph; a corrected graph (v2+) may
   declare the real branch structure.
5. **The conversation walk pins its walked graph version at the first
   step** (a mid-conversation graph correction never re-aims a
   running conversation; a NEW conversation walks the corrected
   version) — the honest reproducibility choice, disclosed.
6. **The interviewer CHOICE MECHANICS are STUDIO-004's** (the
   adaptive interviewer runtime): this delivery provides the declared
   graph + the chosen-edge/conversation-graph append surface (the
   acceptance's "adaptive branching hooks") so the choice mechanics
   have a structural home; `chooserKind` honestly records who chose.
7. **The intent records are explicit driver steps** (recordIntent is
   a required first step for the generation path — the generated
   records carry the intent FK; the driver flow is
   request → recordIntent → generate → recordGenerated…). No
   conversation event kinds were added to the frozen migration-064
   session event tail (the review decisions and conversation steps
   ARE their own append-only audit tails).
8. **No route/console surface ships in this delivery** (the Work
   Item is the module + the records + the gates + the proof battery),
   per the frozen plan (UX-009 and successors carry the console).
