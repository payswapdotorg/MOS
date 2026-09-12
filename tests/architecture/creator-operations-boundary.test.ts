/**
 * MKT-037 static tests — the Creator Operations Domain Pack boundary is
 * structurally correct, authority-bounded and provider-neutral in the
 * ACTUAL pack code, migration, routes and wiring (pure static analysis,
 * no DB).
 *
 * Acceptance proofs (requirements-v1.3.md CREATOR-001, acceptance
 * CREATOR-AC-01..06 static halves; spec/creator-operations-v1.3.md FROZEN;
 * spec/domain-pack-v1.3.md §3 "A Domain Pack MUST use the platform
 * authorities for: tenant/client authorization; workflow state; execution
 * identity; evidence/provenance; AI routing/evaluation; credentials;
 * audit; extension installation/invocation. A Domain Pack MUST NOT
 * introduce an alternate workflow engine, Job engine, evidence authority,
 * tenant authority, or credential store"; spec/module-dependency-v1.3.md
 * "Creator Operations is pack-owned and must not become a peer authority
 * to core modules" and "Creator Operations pack code may consume Domain
 * Pack public contracts and the existing core public contracts above. It
 * may not depend on internal repositories of another module";
 * implementation-contract §21 material-key posture):
 *
 *   1. CREATOR-AC-01 (storage): migration 031 creates EXACTLY the eight
 *      pack-owned tables (six §2 subjects + conversation messages + the
 *      CREATOR-AC-06 approval records), every row carries the EXISTING
 *      agency/client scope chain FK'd to the migration 002/003
 *      agencies/clients tables — NO second tenant authority table is
 *      created, no workflow/execution/evidence/metric/credential/job/
 *      policy/audit table is created, and the §21 material-key validator
 *      fences every jsonb payload column;
 *   2. the pack files (contract/guards/manifest/store/module) import
 *      ONLY platform ports + the intra-module /domain-packs public entry
 *      + intra-pack relatives — ZERO cross-module imports: every composed
 *      authority is reached through a STRUCTURAL PORT satisfied at the
 *      composition root by the concrete public-contract instance (the
 *      /metrics-for-/clients precedent — the MKT-036 boundary tests stay
 *      intact);
 *   3. CREATOR-AC-03 (static): pack code performs NO model invocation and
 *      NO AI routing of its own — no routeTask/adapter/provider surface
 *      anywhere in the pack (AI tasks are TaskProfile declarations
 *      registered through the /ai-runtime authority's own creation
 *      surface; routing happens ONLY through the AI Router at execution
 *      time);
 *   4. CREATOR-AC-04 (static): pack code contains NO Job/offer/outcome
 *      machinery — human work rides the generic model (workflow-template
 *      human_task nodes + the pack-owned approval records whose approver
 *      specializations draw from the frozen /field-agents registry);
 *   5. CREATOR-AC-05 (static): zero provider SDK/API/browser/scraping
 *      coupling anywhere in the pack code, the routes and the manifest —
 *      provider platforms appear ONLY as provider-neutral label data;
 *   6. CREATOR-AC-06 (static): the pack module composes the gate's
 *      approvalStatus attribute SERVER-SIDE (never caller-suppliable),
 *      evaluates through the policies port and fails closed (only an
 *      explicit 'allow' writes; PolicyDeniedError otherwise) BEFORE any
 *      write;
 *   7. the route set is exactly the thirty-three frozen MKT-037 routes,
 *      every DTO rejects identity/scope/lifecycle/provenance authority
 *      fields and material-shaped keys, and the approver identity of
 *      every human approval is SERVER-DERIVED from the authenticated
 *      principal.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...parts: string[]) => readFileSync(join(repoRoot, ...parts), 'utf8');

const packDir = join(repoRoot, 'src', 'modules', 'domain-packs', 'internal', 'packs', 'creator-operations');
const packFiles = readdirSync(packDir).filter((name) => name.endsWith('.ts')).map((name) => join(packDir, name));

const migration031 = read('src', 'platform', 'db', 'migrations', '031_creator_operations.sql');
const packModule = read('src', 'modules', 'domain-packs', 'internal', 'packs', 'creator-operations', 'module.ts');
const packContract = read('src', 'modules', 'domain-packs', 'internal', 'packs', 'creator-operations', 'contract.ts');
const creatorRoutes = read('src', 'api', 'creator-operations-routes.ts');
const compositionRoot = read('src', 'composition-root.ts');
const applicationTs = read('src', 'api', 'application.ts');
const routesTs = read('src', 'api', 'routes.ts');

function createTableBlock(migration: string, table: string): string {
  const source = migration
    .split('\n')
    .map((line) => (line.trim().startsWith('--') ? '' : line))
    .join('\n');
  const marker = `CREATE TABLE IF NOT EXISTS ${table} (`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `migration must create ${table}`);
  const end = source.indexOf(');', start);
  assert.ok(end > start, `${table} block must terminate`);
  return source.slice(start, end);
}

/** Extracts every import specifier string from a TypeScript source file. */
function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  const patterns = [
    /import\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /export\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) out.push(match[1]!);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. CREATOR-AC-01 — the storage posture (migration 031)
// ---------------------------------------------------------------------------

test('migration 031 exists and creates exactly the eight pack-owned tables', () => {
  for (const table of [
    'creator_profiles',
    'creator_operation_approvals',
    'creator_accounts',
    'creator_fans',
    'creator_conversations',
    'creator_conversation_messages',
    'creator_content_assets',
    'creator_offers',
  ]) {
    assert.ok(migration031.includes(`CREATE TABLE IF NOT EXISTS ${table} (`), `migration 031 must create ${table}`);
  }
  assert.equal(
    (migration031.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length,
    8,
    'migration 031 creates exactly eight tables',
  );
});

test('CREATOR-AC-01 storage: every pack-owned table carries the EXISTING agency/client scope chain — no second tenant authority', () => {
  for (const table of [
    'creator_profiles',
    'creator_operation_approvals',
    'creator_accounts',
    'creator_fans',
    'creator_conversations',
    'creator_conversation_messages',
    'creator_content_assets',
    'creator_offers',
  ]) {
    const block = createTableBlock(migration031, table);
    assert.ok(
      block.includes('agency_id') && block.includes('REFERENCES agencies(agency_id)'),
      `${table} must FK-reference the EXISTING agencies table`,
    );
    assert.ok(
      block.includes('client_id') && block.includes('REFERENCES clients(client_id)'),
      `${table} must FK-reference the EXISTING clients table`,
    );
  }
  // NO second tenant authority: no agencies/clients/workspaces table is
  // created; no permission/tenant table either.
  assert.ok(!/CREATE TABLE[^(]*(agencies|clients|workspaces|memberships|permissions|roles)/i.test(migration031));
});

test('CREATOR-AC-01 storage: NO parallel authority table is created (workflow/execution/evidence/metric/credential/job/policy/audit/tenant)', () => {
  assert.ok(!/CREATE TABLE[^(]*(workflow|execution|evidence|metric|credential|job|policy|audit)/i.test(migration031));
  assert.ok(!/(INSERT INTO|UPDATE|DELETE FROM)\s+(workflows|workflow_instances|executions|evidence|metrics|jobs|policies|audit_events)/i.test(migration031));
  for (const table of [
    'creator_profiles',
    'creator_operation_approvals',
    'creator_accounts',
    'creator_fans',
    'creator_conversations',
    'creator_conversation_messages',
    'creator_content_assets',
    'creator_offers',
  ]) {
    const block = createTableBlock(migration031, table);
    assert.ok(
      !/ REFERENCES (workflows|workflow_instances|executions|evidence|metrics|jobs|policies|audit_events)\(/.test(block),
      `${table} must not reference runtime authority rows`,
    );
  }
});

test('CREATOR-AC-02 storage posture: engagement/monetization/performance observations have NO pack-owned table — /evidence and /metrics stay the only observation authorities', () => {
  assert.ok(!/CREATE TABLE[^(]*(creator_evidence|creator_metric|creator_observation|creator_engagement|creator_monetization|creator_performance)/i.test(migration031));
  // The §2 subject tables are the record surface; observation ledgers are
  // deliberately absent.
});

test('migration 031: the §21 material-key validator fences every jsonb payload column', () => {
  assert.ok(migration031.includes('creator_operations_payload_has_no_material_keys'));
  const fenced = (migration031.match(/creator_operations_payload_has_no_material_keys\(/g) ?? []).length;
  assert.ok(fenced >= 8, 'every jsonb payload column must be fenced by the material-key validator');
});

test('migration 031: scope-chain, append-only/immutability and frozen-lifecycle triggers are database backstops on every subject table', () => {
  for (const table of [
    'creator_profiles',
    'creator_operation_approvals',
    'creator_accounts',
    'creator_fans',
    'creator_conversations',
    'creator_conversation_messages',
    'creator_content_assets',
    'creator_offers',
  ]) {
    assert.ok(migration031.includes(`${table}_scope_legal`), `${table} must have the scope-chain trigger`);
  }
  // Append-only/immutability: the fully-append-only tables reject UPDATE
  // and DELETE; the lifecycle tables reject content rewrites.
  for (const trigger of [
    'creator_profiles_append_only_update_trigger',
    'creator_profiles_append_only_delete_trigger',
    'creator_operation_approvals_append_only_update_trigger',
    'creator_operation_approvals_append_only_delete_trigger',
    'creator_conversation_messages_append_only_update_trigger',
    'creator_conversation_messages_append_only_delete_trigger',
  ]) {
    assert.ok(migration031.includes(trigger), `the append-only backstop ${trigger} must exist`);
  }
  for (const table of ['creator_accounts', 'creator_fans', 'creator_conversations', 'creator_content_assets', 'creator_offers']) {
    assert.ok(migration031.includes(`${table}_immutable_trigger`), `${table} must have the immutability trigger`);
    assert.ok(migration031.includes(`${table}_lifecycle_legal_trigger`), `${table} must have the frozen-lifecycle trigger`);
  }
});

test('migration 031: the CREATOR-AC-06 side-effect provenance is structurally required (the outbound/published shapes)', () => {
  // An outbound creator message is born 'sent' with the ALLOWING policy
  // decision id; an inbound message is born 'received' with NO gate
  // provenance. A published content asset carries the allowing decision.
  const messageScope = migration031.indexOf('creator_conversation_messages_scope_legal() RETURNS trigger');
  assert.ok(messageScope > 0);
  const body = migration031.slice(messageScope, messageScope + 4000);
  assert.ok(body.includes("NEW.direction = 'outbound' AND (NEW.status <> 'sent' OR NEW.policy_decision_id IS NULL)"));
  assert.ok(body.includes("NEW.direction = 'inbound' AND (NEW.status <> 'received' OR NEW.policy_decision_id IS NOT NULL OR NEW.approval_id IS NOT NULL)"));
  const contentLifecycle = migration031.indexOf('creator_content_assets_lifecycle_legal() RETURNS trigger');
  const contentBody = migration031.slice(contentLifecycle, contentLifecycle + 4000);
  assert.ok(contentBody.includes("NEW.status = 'published' THEN"));
  assert.ok(contentBody.includes('NEW.published_at IS NULL OR NEW.policy_decision_id IS NULL'));
});

// ---------------------------------------------------------------------------
// 2. The pack dependency posture — zero cross-module imports, structural ports
// ---------------------------------------------------------------------------

test('pack files import ONLY platform ports + the intra-module /domain-packs public entry + intra-pack relatives', () => {
  assert.ok(packFiles.length >= 5, 'the pack must exist with its five files');
  for (const file of packFiles) {
    const source = readFileSync(file, 'utf8');
    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith('.')) {
        assert.ok(
          specifier.startsWith('node:'),
          `${file}: external import '${specifier}' is forbidden (platform ports only)`,
        );
        continue;
      }
      // Platform ports are always allowed.
      if (/platform\//.test(specifier)) continue;
      // Intra-pack relatives are fine.
      if (specifier.startsWith('./')) continue;
      // The ONE intra-module allowance: the /domain-packs public entry.
      assert.ok(
        specifier === '../../../public.ts',
        `${file}: cross-module import '${specifier}' is forbidden — the pack composes authorities ONLY through structural ports (the /metrics-for-/clients precedent)`,
      );
    }
  }
});

test('pack files contain ZERO imports of runtime authorities (ports only — the framework boundary stays intact)', () => {
  for (const file of packFiles) {
    const source = readFileSync(file, 'utf8');
    for (const authority of [
      'clients/public.ts',
      'evidence/public.ts',
      'metrics/public.ts',
      'policies/public.ts',
      'ai-runtime/public.ts',
      'jobs/public.ts',
      'workflows/public.ts',
      'field-agents/public.ts',
      'executions/public.ts',
      'workspaces/public.ts',
      'agencies/public.ts',
      'extensions/public.ts',
      'integrations/public.ts',
    ]) {
      assert.ok(
        !source.includes(authority),
        `${file}: the pack must not import /${authority} — composition happens through the structural ports wired at the composition root`,
      );
    }
  }
});

test('the pack surface is re-exported through the /domain-packs public entry and wired at the composition root with the REAL module instances', () => {
  const domainPacksPublic = read('src', 'modules', 'domain-packs', 'public.ts');
  assert.ok(domainPacksPublic.includes('export { createCreatorOperationsPack }'));
  // The composition root wires the pack with platform ports + the
  // concrete public-contract instances satisfying the ports (the
  // type-level structural proof).
  assert.ok(compositionRoot.includes('createCreatorOperationsPack({'));
  for (const dep of ['domainPacks,', 'clients,', 'evidence,', 'metrics: metricsModule,', 'policies,', 'aiRuntime,']) {
    assert.ok(compositionRoot.includes(dep), `the pack wiring must pass the concrete ${dep} instance`);
  }
  // The API surface composes the pack through the application modules.
  assert.ok(applicationTs.includes('readonly creatorOperations: CreatorOperationsPackApi'));
  assert.ok(routesTs.includes("import { registerCreatorOperationsRoutes } from './creator-operations-routes.ts'"));
  assert.ok(routesTs.includes('registerCreatorOperationsRoutes(router, services, modules)'));
});

// ---------------------------------------------------------------------------
// 3. CREATOR-AC-03 (static) — no model invocation, no AI routing in the pack
// ---------------------------------------------------------------------------

test('CREATOR-AC-03 static: pack code performs NO model invocation and NO AI routing of its own', () => {
  const sources = [packModule, packContract, creatorRoutes].join('\n');
  for (const forbidden of [
    'routeTask',
    'previewRouting',
    'ProviderAdapter',
    'CascadeValidator',
    'invokeModel',
    'routeModel',
    'chat.completions',
    'openai',
    'anthropic',
    'resolveCredentialMaterial',
  ]) {
    assert.ok(!sources.includes(forbidden), `the pack must not touch '${forbidden}' (AI routing belongs only to the /ai-runtime AI Router at execution time)`);
  }
  // The AI composition surface is TaskProfile REGISTRATION through the
  // port — nothing else.
  assert.ok(packContract.includes('createTaskProfile('));
  assert.ok(packModule.includes('deps.aiRuntime.createTaskProfile('));
});

// ---------------------------------------------------------------------------
// 4. CREATOR-AC-04 (static) — no Job/offer/outcome machinery in the pack
// ---------------------------------------------------------------------------

test('CREATOR-AC-04 static: pack code contains NO Job/offer/outcome machinery — the generic model serves human work', () => {
  const sources = [packModule, packContract].join('\n');
  for (const forbidden of [
    'projectJob',
    'createOffer(',
    'acceptOffer',
    'submitOutcome',
    'JobEligibilitySpec',
    'jobId',
  ]) {
    assert.ok(!sources.includes(forbidden), `the pack must not carry Job machinery '${forbidden}' (human work rides the generic Human Agent → Job model through /jobs)`);
  }
  // The human composition surface: specializations of the GENERIC registry
  // (a local pinned mirror) + approval-record approver provenance.
  assert.ok(packContract.includes('CREATOR_HUMAN_SPECIALIZATION_MIRROR'));
  assert.ok(packModule.includes('approverSpecializations'));
});

// ---------------------------------------------------------------------------
// 5. CREATOR-AC-05 (static) — provider neutrality of the pack code + routes
// ---------------------------------------------------------------------------

test('CREATOR-AC-05 static: zero provider SDK/API/browser/scraping coupling in pack code, routes and manifest', () => {
  const packSources = packFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
  const sources = [packSources, creatorRoutes].join('\n');
  for (const forbidden of [
    "from 'pg'",
    'node-postgres',
    'onlyfans',
    'fansly',
    'patreon',
    'instagram',
    'tiktok',
    'youtube',
    'twitter',
    'x.com',
    'puppeteer',
    'playwright',
    'selenium',
    'cheerio',
    'jsdom',
    'scraping',
    'axios',
    'fetch(',
    'http.request',
    'openai',
    'anthropic',
  ]) {
    assert.ok(
      !sources.toLowerCase().includes(forbidden.toLowerCase()),
      `provider coupling '${forbidden}' is forbidden outside the /integrations + /extensions boundaries`,
    );
  }
  // Provider platforms appear ONLY as opaque label data: the platform-label
  // column is a bounded text label (migration CHECK), never a coupling.
  assert.ok(migration031.includes('platform_label'));
});

// ---------------------------------------------------------------------------
// 6. CREATOR-AC-06 (static) — the fail-closed approval gate composition
// ---------------------------------------------------------------------------

test('CREATOR-AC-06 static: the gate composes approvalStatus SERVER-SIDE and fails closed BEFORE any write', () => {
  // The attribute is derived from the approval record state, never a DTO
  // field (the DTO forbidden-key list rejects it).
  assert.ok(packModule.includes('CREATOR_GATE_APPROVAL_ATTRIBUTE'));
  assert.ok(packModule.includes("input.approval === null ? 'missing' : 'approved'"));
  // The evaluation flows through the policies port; only an explicit
  // 'allow' proceeds (PolicyDeniedError otherwise, before any write).
  assert.ok(packModule.includes('deps.policies.evaluateAction('));
  assert.ok(packModule.includes("creatorEnforcementOutcome(decision) !== 'allow'"));
  assert.ok(packModule.includes('PolicyDeniedError'));
  // The approving human is the authenticated principal; the approver's
  // specializations are resolved server-side from the /field-agents
  // profile at the route layer.
  assert.ok(creatorRoutes.includes('approverSpecializations: await approverSpecializations('));
  assert.ok(creatorRoutes.includes("modules.fieldAgents.getHumanAgentByUser("));
});

test('CREATOR-AC-06 static: the gate provenance fields are never request-suppliable', () => {
  // The DTO authority-field contract rejects the server-derived fields
  // (identity, scope, lifecycle, gate provenance, material keys).
  for (const forbidden of [
    "'policyDecisionId',",
    "'approverUserId',",
    "'approverSpecializations',",
    "'provenance',",
    "'agencyId',",
    "'clientId',",
    "'secret',",
    "'secretMaterial',",
    "'material',",
    "'password',",
    "'apiKey',",
    "'secretHandle',",
  ]) {
    assert.ok(creatorRoutes.includes(forbidden), `the route authority-field contract must reject '${forbidden}'`);
  }
});

// ---------------------------------------------------------------------------
// 7. The route set (exactly the thirty-three frozen MKT-037 routes)
// ---------------------------------------------------------------------------

test('the route set is exactly the thirty-three frozen MKT-037 routes', () => {
  const routePattern = /router\.add\(\s*'([A-Z]+)',\s*\n?\s*'([^']+)'/g;
  const routes: string[] = [];
  for (const match of creatorRoutes.matchAll(routePattern)) {
    routes.push(`${match[1]} ${match[2]}`);
  }
  // Thirty-three router.add registrations: thirty-two literal paths +
  // the shared approval-recorder helper (its path arrives as a variable,
  // asserted below).
  assert.equal((creatorRoutes.match(/router\.add\(/g) ?? []).length, 33);
  assert.ok(
    creatorRoutes.includes(
      "registerApprovalRoute(\n    '/api/creator-conversations/:conversationId/approvals',",
    ),
    'the shared approval recorder registers the conversation-approvals route',
  );
  assert.deepEqual(routes, [
    'POST /api/clients/:clientId/creator-profiles',
    'GET /api/clients/:clientId/creator-profiles',
    'GET /api/creator-profiles/:profileId',
    'POST /api/creator-profiles/:profileId/accounts',
    'GET /api/creator-profiles/:profileId/accounts',
    'GET /api/creator-accounts/:accountId',
    'POST /api/creator-accounts/:accountId/status',
    'POST /api/creator-accounts/:accountId/fans',
    'GET /api/creator-accounts/:accountId/fans',
    'GET /api/creator-fans/:fanId',
    'POST /api/creator-fans/:fanId/status',
    'POST /api/creator-accounts/:accountId/conversations',
    'GET /api/creator-accounts/:accountId/conversations',
    'GET /api/creator-conversations/:conversationId',
    'POST /api/creator-conversations/:conversationId/status',
    'POST /api/creator-conversations/:conversationId/messages/inbound',
    'POST /api/creator-conversations/:conversationId/messages/outbound',
    'GET /api/creator-conversations/:conversationId/messages',
    'POST /api/creator-profiles/:profileId/content-assets',
    'GET /api/creator-profiles/:profileId/content-assets',
    'GET /api/creator-content-assets/:assetId',
    'POST /api/creator-content-assets/:assetId/status',
    'POST /api/creator-profiles/:profileId/offers',
    'GET /api/creator-profiles/:profileId/offers',
    'GET /api/creator-offers/:offerId',
    'POST /api/creator-offers/:offerId/status',
    'POST /api/creator-content-assets/:assetId/approvals',
    'GET /api/creator-conversations/:conversationId/approvals',
    'POST /api/clients/:clientId/creator-observations',
    'POST /api/creator-operations/publish',
    'POST /api/workspaces/:workspaceId/creator-operations/task-profiles',
    'GET /api/creator-operations/manifest',
  ]);
  // Every creator surface is under the frozen prefixes; no route escapes
  // the pack's own namespace.
  for (const route of routes) {
    assert.ok(
      /\/api\/(clients\/|creator-|workspaces\/)/.test(route),
      `route '${route}' must stay in the pack's frozen namespace`,
    );
  }
});

test('every creator mutation route audits and the pack module resolves the Client chain before any write', () => {
  assert.equal((creatorRoutes.match(/recordMutationAudit\(/g) ?? []).length, 18, 'every mutation route emits an append-only audit event');
  // The module resolves the canonical Client chain through the /clients
  // port BEFORE any write (fail-closed).
  assert.ok(packModule.includes('resolveClientChain('));
  assert.ok(packModule.includes('ownership.client.status !== \'active\''));
});
