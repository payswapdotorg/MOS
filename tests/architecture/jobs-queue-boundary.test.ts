/**
 * MKT-031 static tests — the Field Agent work-queue boundary is
 * structurally correct in the ACTUAL route file and shared registration
 * files (pure static analysis, no DB). Proves the frozen architecture
 * boundaries (spec/work-items.md MKT-031; requirements UI-002 + UI-AC-01..02;
 * spec/human-agent-v1.3.md §3; spec/module-dependency-matrix.md):
 *
 *   1. the queue registers EXACTLY the four work-queue surfaces (MY QUEUE,
 *      discovery, accept-by-offer-id, decline-by-offer-id) — no new
 *      authority surface beyond the four faces of the work queue;
 *   2. the literal 'queue' segment is registered BEFORE the
 *      :jobId-parameterized /jobs routes (first-match-wins routing: the
 *      queue paths must never be captured by /api/jobs/:jobId patterns);
 *   3. the queue file's imports are whitelisted: platform + the /jobs and
 *      /field-agents PUBLIC contracts + the shared jobs-routes posture
 *      helpers ONLY — no /workflows, /evidence, /clients, /agencies or
 *      /policies import (the queue composes existing authorities, it
 *      never reaches around them);
 *   4. §23 authority-field rejection: the queue claim surfaces reject
 *      every candidate-identity, status and provenance-shaped key;
 *   5. the shared composition: the posture helpers + serializers are
 *      IMPORTED from jobs-routes.ts (one /jobs surface — never a second
 *      permission engine or a drifting response shape), and jobs-routes.ts
 *      exports them;
 *   6. the queue consumes the /jobs module through the THIN delegation
 *      surface only: offer reads + the SAME accept/decline claims +
 *      marketplace + visit/outcome/evidence READS — it NEVER opens,
 *      transitions, completes or captures (execution mutations stay on the
 *      MKT-027 visits surface; UI-AC-02: a frontend surface cannot change
 *      authorization or workflow outcomes);
 *   7. the shared registration files wire the surface (routes.ts
 *      registers it; composition-root documents the MKT-031 additions).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
const read = (path: string): string => readFileSync(path, 'utf8');

const queueRoutes = read(src('api', 'jobs-queue-routes.ts'));
const jobsRoutesFile = read(src('api', 'jobs-routes.ts'));
const routesFile = read(src('api', 'routes.ts'));
const compositionRoot = read(src('composition-root.ts'));

/** Imports of `file` as raw specifier strings. */
function importsOf(file: string): string[] {
  const text = read(file);
  const specifiers: string[] = [];
  for (const match of text.matchAll(/from\s+'([^']+)'/g)) specifiers.push(match[1]!);
  for (const match of text.matchAll(/import\s+'([^']+)'/g)) specifiers.push(match[1]!);
  return specifiers;
}

// ---------------------------------------------------------------------------
// 1. Exactly the four work-queue surfaces
// ---------------------------------------------------------------------------

test('the queue routes register ONLY the four work-queue surfaces', () => {
  const registered = [...queueRoutes.matchAll(/'(?:GET|POST|PUT|PATCH|DELETE)',\s*'(\/[^']+)'/g)]
    .map((match) => match[1]!)
    .sort();
  assert.deepEqual(registered, [
    '/api/jobs/queue',
    '/api/jobs/queue/discovery',
    '/api/jobs/queue/offers/:offerId/accept',
    '/api/jobs/queue/offers/:offerId/decline',
  ].sort());
});

// ---------------------------------------------------------------------------
// 2. Literal-first registration (first-match-wins routing)
// ---------------------------------------------------------------------------

test("routes.ts registers the queue BEFORE the :jobId-parameterized jobs routes (the literal 'queue' must not be captured)", () => {
  assert.ok(routesFile.includes("import { registerJobsQueueRoutes } from './jobs-queue-routes.ts'"));
  assert.ok(routesFile.includes('registerJobsQueueRoutes(router, services, modules)'));
  const queueCall = routesFile.indexOf('registerJobsQueueRoutes(router, services, modules)');
  const jobsCall = routesFile.indexOf('registerJobsRoutes(router, services, modules)');
  assert.ok(queueCall >= 0 && jobsCall >= 0);
  assert.ok(
    queueCall < jobsCall,
    'the queue must be registered before the /api/jobs/:jobId routes (first-match-wins)',
  );
  // The registration site documents WHY (the literal 'queue' segment sits
  // in the :jobId position).
  assert.ok(routesFile.includes("literal 'queue' segment"));
});

// ---------------------------------------------------------------------------
// 3. Import whitelist (the queue composes existing authorities only)
// ---------------------------------------------------------------------------

test('the queue file imports ONLY platform + the /jobs + /field-agents public contracts + the shared jobs-routes posture helpers', () => {
  const allowed = [
    /^node:/,
    /^\.\.\/platform\//,
    /^\.\.\/modules\/jobs\/public\.ts$/,
    /^\.\.\/modules\/field-agents\/public\.ts$/,
    /^\.\.\/platform\/app-services\.ts$/,
    /^\.\.\/platform\/http\/router\.ts$/,
    /^\.\.\/platform\/http\/pipeline\.ts$/,
    /^\.\.\/platform\/errors\/errors\.ts$/,
    /^\.\.\/platform\/observability\/correlation\.ts$/,
    /^\.\.\/platform\/http\/validation\.ts$/,
    /^\.\.\/platform\/http\/auth\/contract\.ts$/,
    /^\.\/jobs-routes\.ts$/,
    /^\.\/authorize\.ts$/,
    /^\.\/audit-emit\.ts$/,
    /^\.\/application\.ts$/,
  ];
  for (const specifier of importsOf(src('api', 'jobs-queue-routes.ts'))) {
    assert.ok(
      allowed.some((pattern) => pattern.test(specifier)),
      `unexpected import '${specifier}' — the queue may compose only the /jobs + /field-agents public contracts and the shared posture helpers`,
    );
  }
  // Explicit negatives (the frozen matrix gives /jobs the dependencies;
  // the ROUTE layer needs none of these for the queue):
  for (const specifier of importsOf(src('api', 'jobs-queue-routes.ts'))) {
    assert.ok(!specifier.includes('workflows'), 'the queue must not import /workflows');
    assert.ok(!specifier.includes('evidence'), 'the queue must not import /evidence');
    assert.ok(!specifier.includes('clients'), 'the queue must not import /clients');
    assert.ok(!specifier.includes('agencies'), 'the queue must not import /agencies');
    assert.ok(!specifier.includes('policies'), 'the queue must not import /policies');
  }
});

// ---------------------------------------------------------------------------
// 4. §23 authority-field rejection on the claim surfaces
// ---------------------------------------------------------------------------

test('DTO authority-field rejection: both queue claim surfaces forbid candidate-identity/status/provenance fields (§23)', () => {
  const claimFields = queueRoutes.match(/const QUEUE_CLAIM_AUTHORITY_FIELDS = \[([\s\S]*?)\] as const;/);
  assert.ok(claimFields !== null, 'QUEUE_CLAIM_AUTHORITY_FIELDS is required');
  const tenantFields = queueRoutes.match(/const TENANT_AND_LINKAGE_FIELDS = \[([\s\S]*?)\] as const;/);
  assert.ok(tenantFields !== null, 'the queue mirrors the tenant/linkage authority keys');
  const body = claimFields![1]! + tenantFields![1]!;
  for (const key of [
    'offerId',
    'jobId',
    'candidateAgentId',
    'candidateUserId',
    'status',
    'version',
    'provenance',
    'recordedActor',
    'recordedVia',
    'correlationId',
    'causationId',
    'agencyId',
    'clientId',
    'workspaceId',
  ]) {
    assert.ok(body.includes(`'${key}'`), `the queue claim DTO must reject the authority key ${key}`);
  }
  // Both claim routes validate with the SAME forbidden-key set (the
  // mirrored OFFER_CLAIM_AUTHORITY_FIELDS posture).
  const claimValidations = queueRoutes.match(/forbiddenKeys: QUEUE_CLAIM_AUTHORITY_FIELDS/g) ?? [];
  assert.equal(claimValidations.length, 2, 'accept and decline both reject authority fields');
});

// ---------------------------------------------------------------------------
// 5. Shared composition — one authorization posture, one response vocabulary
// ---------------------------------------------------------------------------

test('the queue composes the SHARED jobs-routes posture helpers and serializers (never a second authority)', () => {
  assert.ok(queueRoutes.includes("from './jobs-routes.ts'"));
  for (const shared of [
    'activeAgentIdFor',
    'actorUserId',
    'jobOwnerScope',
    'serializeDescriptor',
    'serializeJob',
    'serializeOfferForCandidate',
    'serializeOfferForCommissioning',
  ]) {
    assert.ok(
      queueRoutes.includes(shared),
      `the queue must compose the shared /jobs surface helper ${shared}`,
    );
  }
  // And jobs-routes.ts EXPORTS them (the MKT-027 shared-composition
  // precedent, extended to the queue surface).
  for (const helper of [
    'export async function requireJob',
    'export async function jobOwnerScope',
    'export async function canReadFullJob',
    'export function actorUserId',
    'export async function activeAgentIdFor',
    'export function serializeDescriptor',
    'export function serializeJob',
    'export function serializeOfferForCommissioning',
    'export function serializeOfferForCandidate',
  ]) {
    assert.ok(jobsRoutesFile.includes(helper), `jobs-routes must export ${helper}`);
  }
});

// ---------------------------------------------------------------------------
// 6. Thin delegation — reads + the SAME claims only (UI-AC-02)
// ---------------------------------------------------------------------------

test('the queue consumes /jobs through reads and the SAME accept/decline claims only (no execution mutations)', () => {
  const allowedModuleCalls = [
    'modules.jobs.listOffersForCandidate',
    'modules.jobs.getJob',
    'modules.jobs.listMarketplaceJobs',
    'modules.jobs.listVisitsForJob',
    'modules.jobs.getJobOutcome',
    'modules.jobs.listVisitEvidence',
    'modules.jobs.acceptOffer',
    'modules.jobs.declineOffer',
    'modules.fieldAgents.getHumanAgentByUser',
  ];
  for (const match of queueRoutes.matchAll(/modules\.(?:jobs|fieldAgents)\.[A-Za-z]+/g)) {
    assert.ok(
      allowedModuleCalls.includes(match[0]),
      `unexpected /jobs|/field-agents call '${match[0]}' — the queue is a thin delegation surface`,
    );
  }
  // No queue-side execution mutation: visit lifecycle + outcome submission
  // + evidence capture stay on the MKT-026/MKT-027 surfaces.
  for (const forbidden of [
    'openVisit',
    'startVisit',
    'cancelVisit',
    'completeVisit',
    'captureVisitEvidence',
    'submitOutcome',
    'projectJob',
    'createOffer',
  ]) {
    assert.ok(
      !queueRoutes.includes(`modules.jobs.${forbidden}`),
      `the queue must never call ${forbidden} (that mutation belongs to the direct /jobs surfaces — UI-AC-02)`,
    );
  }
  // No workflow mutation from the queue.
  assert.ok(!queueRoutes.includes('modules.workflows'));
});

// ---------------------------------------------------------------------------
// 7. The shared registration files wire the surface
// ---------------------------------------------------------------------------

test('routes.ts registers the queue routes; the composition root documents the MKT-031 additions', () => {
  assert.ok(routesFile.includes('MKT-031'));
  assert.ok(compositionRoot.includes('MKT-031'));
  assert.ok(compositionRoot.includes('jobs-queue-routes.ts'));
  // No new module/deps: the composition root still builds the jobs module
  // exactly once (the queue adds a route file, never a second authority).
  assert.equal(
    (compositionRoot.match(/createJobsModule\(/g) ?? []).length,
    1,
    'the queue must not wire a second jobs module',
  );
});
