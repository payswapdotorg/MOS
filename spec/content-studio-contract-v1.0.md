# MOS Content Studio Contract v1.0

Status: FROZEN
Layer: v1.7 Marketing Engineering Lab
Parent architecture: `spec/architecture-v1.7-marketing-lab.md`

This is the normative Studio sub-contract. It is subordinate to the parent v1.7 architecture and existing v1.6 authorities. It is not a second workflow, experiment, evidence, rights, policy, distribution, credential, model-router or marketplace authority.

## 1. Purpose

Content Studio is the MOS-owned runtime for producing AI+Human content.

It has two entry modes:

1. Standalone Studio: a user directly creates content such as a reaction, audio podcast or video podcast.
2. Lab-initiated Studio: the Marketing Engineering Lab submits a versioned production request discovered during strategy search.

Both modes use the same production/session/artifact contracts.

## 2. Supported initial formats

The format registry MUST be pluggable.

Initial formats:
- reaction;
- audio podcast;
- video podcast.

A format declares:
- format identity/version;
- input requirements;
- participant model;
- capture requirements;
- interviewer requirements;
- organization compatibility requirements;
- output artifact contract;
- provenance/consent requirements;
- evaluation hooks.

Adding a future format MUST NOT require a second Studio runtime or a second Lab authority.

## 3. Production request

A Production Request is immutable/versioned and contains:
- request identity/version;
- client/workspace scope;
- optional mission/scenario binding;
- declared objective;
- source/reference artifacts;
- explicit script/question list if supplied;
- intent if script is not supplied;
- selected format;
- selected organization version;
- selected transform graph where applicable;
- model/capability references;
- human task references;
- output contract;
- acceptance criteria;
- budget;
- deadline;
- delay/stopping policy;
- rights/provenance context.

A standalone request may omit Lab fields but must still define format, scope, input and output contracts.

## 4. Organization loading

The Studio MUST load any Organization that satisfies the declared Studio compatibility contract.

Organizations may be:
- Lab-discovered;
- user-supplied;
- previously saved/versioned.

The Studio MUST validate:
- organization version;
- required Agent Bodies;
- required capabilities;
- input/output compatibility;
- permissions;
- budget/latency limits;
- safety constraints.

The Studio MUST NOT silently replace a requested organization with a different organization. A compatibility failure is explicit and auditable.

## 5. Session lifecycle

A Studio Session is a versioned production session.

Minimum lifecycle vocabulary:
- created;
- preparing;
- awaiting_participant;
- recording;
- processing;
- review;
- treatment_requested;
- completed;
- cancelled;
- failed;
- expired.

State transitions are guarded and append-audited.

A completed session remains immutable. A retry/treatment creates a new session revision or child production run linked to the prior output.

## 6. Single-person podcast

A single-person podcast may use an interviewer representation selected by the Studio organization.

Supported interviewer forms include:
- voice;
- voice + text;
- avatar;
- prerecorded interviewer content;
- generated interviewer content;
- hybrid representation.

The interviewer may adapt questions using previous answers.

The Studio MUST preserve:
- question/answer sequence;
- interviewer representation provenance;
- generated versus human-authored distinction;
- recording provenance;
- participant consent.

Synthetic or prerecorded interviewer material MUST NOT be represented as a live human recording when it is not.

## 7. Multi-person podcast

A multi-person session may span multiple authorized MOS accounts and devices.

Each participant joins through an explicit participation grant. Participant identity, account authorization, consent and contribution provenance are kept separately.

The Studio MUST support:
- participant invitations;
- participant presence/status;
- recording readiness;
- synchronized or separately timestamped contributions;
- participant withdrawal/cancellation handling;
- output rights metadata.

A shared production scope does not merge participant credentials or grant cross-account access outside the session contract.

## 8. Intent-to-script

The Studio may accept:
- a complete script;
- a podcast question list;
- an intent/objective;
- an intent plus supplied source material.

When only intent is supplied, the selected organization may generate a production script/question graph.

The generated script is versioned and reviewable before recording when the format requires explicit user confirmation.

An adaptive interviewer may choose a follow-up from the declared question/branch graph based on the preceding answer while preserving the resulting conversation graph.

## 9. Capture

Capture is modality-specific but format-neutral.

The runtime may capture:
- audio;
- video;
- screen/source material;
- multiple participant streams;
- alternate takes.

Raw captures are production artifacts and are not assumed to be final content.

Capture implementations must use approved storage/access ports and preserve provenance. Long-running processing is asynchronous/durable rather than a synchronous web request.

## 10. Production organization execution

The selected organization may execute against:
- source/reference artifacts;
- generated scripts/questions;
- raw human captures;
- intermediate transformations;
- external capabilities supplied through governed integrations.

Organizations may contain specialized Transform Pawn Agents.

Examples:
- clip selector;
- reaction composer;
- interviewer;
- editor;
- layout/composition agent;
- caption agent;
- dubbing agent;
- quality critic.

The organization owns the production transformation sequence, subject to the request's output contract and MOS policy/security boundaries.

## 11. Human raw-output treatment

Human-generated artifacts are treated as intermediate production inputs.

For example, reaction content may compose:
- source + picture-in-picture reaction;
- source first, reaction second;
- alternating source/reaction;
- source clips followed by response;
- another learned layout/timing.

The selected organization determines the composition through its versioned graph and agent contracts.

The Studio MUST preserve the lineage:
source/reference → human capture → transformation → assembled output.

## 12. Output artifact package

A completed Studio Session returns an Artifact Package containing, where available:
- raw captures;
- final media;
- alternate takes;
- transcript;
- question/answer graph;
- timestamps;
- participant contributions;
- edit graph;
- transform graph;
- composition/layout data;
- captions/subtitles;
- derived clips;
- provenance;
- consent records;
- quality/evaluation metadata;
- costs and processing durations.

Artifact versions are immutable. New treatment produces a new version linked to its predecessor.

## 13. Lab evaluation and treatment

The Lab can evaluate a Studio output.

The Lab may return:
- accepted;
- rejected_quality;
- rejected_strategy;
- rejected_missing_artifact;
- treatment_required;
- human_action_required;
- alternate_organization_required;
- alternate_transform_required;
- abandon_branch.

A rejection is a Lab decision and is distinct from a Rights/Policy rejection.

A treatment request is structured and may specify:
- defect;
- desired change;
- target quality;
- affected artifact(s);
- alternate organization;
- alternate transform;
- human action;
- retry limit;
- deadline;
- acceptance test.

## 14. Standalone user control

Standalone users can:
- select format;
- provide script/questions or intent;
- choose/configure an organization when exposed;
- record/re-record;
- review outputs;
- request treatment;
- accept a final result;
- cancel.

Standalone creation does not require a Marketing Mission.

The Studio may expose internal progress in user-friendly terms rather than raw Lab/agent/simulator internals.

## 15. Lab invocation

A Lab-invoked request may specify:
- discovered strategy;
- selected source/idea;
- transform graph;
- Studio format;
- organization version;
- model/capability choices;
- human contribution requests;
- acceptance criteria;
- budget;
- delay economics;
- stopping policy.

The Studio MUST execute the supplied contracts and return the full artifact/evaluation package. It MUST NOT reinterpret the business objective or independently create a new strategy authority.

## 16. Rights, policy and publication boundaries

The Studio may collect and transform artifacts only through permitted acquisition/access and declared rights/consent context.

The Studio MUST NOT:
- infer rights from public accessibility;
- bypass Rights/Policy gates;
- directly publish to social providers outside v1.6 Distribution/Integration;
- turn a participant contribution into an unrestricted reusable asset without the necessary rights/consent.

Real publication follows the existing MOS authorities.

## 17. Failure and bottleneck handling

The Studio records:
- blocked dependency;
- capability failure;
- participant delay;
- processing delay;
- provider failure;
- budget exhaustion;
- rights/consent issue;
- quality failure.

The Lab, not the Studio, owns the economic choice to wait, substitute, retry or abandon a production branch.

The Studio must expose enough deterministic cost/delay/status information for that decision.

## 18. Verification

Every implemented format and major production path must prove:
- contract validation;
- tenant isolation;
- immutable/versioned artifacts;
- provenance;
- participant authorization where relevant;
- failure/blocked states;
- treatment/retry;
- output contract validation;
- no second authority;
- real APIs/auth for user-facing paths;
- responsive browser evidence at 390x844 and 1280x800 for presentation changes.

The first end-to-end proof must cover:
- standalone reaction;
- standalone audio podcast;
- standalone video podcast;
- Lab-generated podcast request;
- one-person adaptive interviewer flow;
- multi-account podcast;
- raw human reaction entering an organization and becoming composed output;
- Lab rejection → treatment → new immutable output;
- organization substitution;
- no-op/repost production path where permitted.
