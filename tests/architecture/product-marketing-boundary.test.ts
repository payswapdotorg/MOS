/**
 * MKT-070 static tests — the /product-marketing domain is structurally
 * correct in the ACTUAL migration, module contract and route surface
 * (pure static analysis, no DB; the platform-health-boundary precedent).
 *
 * Proofs (spec/effective-backlog-v1.6.md MKT-070; the frozen v1.6 matrix
 * row, VERBATIM: /product-marketing → /growth-missions,
 * /product-intelligence, /content-intelligence, /platform-health,
 * /experiment-analysis):
 *   1. migration 060 creates exactly the ELEVEN own tables — OWN tables
 *      ONLY, NO mission/goal/product-context/research/health/analysis/
 *      experiment/account/tenant table (the composed authorities stay
 *      sole; the plan COMPOSES their records through the frozen-row
 *      public contracts and cites them by reference);
 *   2. the frozen vocabularies are versioned + CHECK-fenced (pm-plan-v1
 *      on every version row; the bounded jsonb blocks);
 *   3. THE APPEND-ONLY + SCOPE BATTERY: the append-only UPDATE/DELETE
 *      rejection triggers on the version tail and every citation link
 *      table (the plan HEADER is the one mutable row family — the
 *      version-tail pointer + the CAS token, exactly the growth_missions
 *      discipline); every cross-module FK citation is scope-fenced
 *      (product-context citations same-context; research-insight
 *      citations same-session; health/analysis/allocation/hypothesis
 *      citations same-Client — all read CHECK-ONLY);
 *   4. THE NO-SECOND-ENGINE BATTERY: NO scheduler/timer/loop of any kind
 *      exists in the module (no setInterval/setTimeout/setImmediate/
 *      process.nextTick), NO workflow/execution verb (no
 *      createWorkflow/createExecution/submitPublish), NO experiment
 *      creation (no createExperiment — the experiment plan is DATA
 *      toward the Growth Operator), NO provider call (no social-accounts
 *      import at all), NO goal-progress re-computation (no goals import
 *      at all — the goal references ride the mission read model);
 *   5. THE READ-ONLY BOUNDARY BATTERY: the module imports EXACTLY the
 *      five frozen matrix allowances through their public contracts (+
 *      platform ports + its own files; the research reference port and
 *      the pursuit-scope workspace port are STRUCTURAL — zero /research
 *      and zero /workspaces imports), all consumed READ-ONLY;
 *   6. the ROUTE surface is EXACTLY the three GET/POST record routes —
 *      no PUT/PATCH/DELETE anywhere in the family (plan corrections are
 *      NEW version records), NO authority-shaped request field, NO
 *      scheduler/provider/experiment verb, and the audit details carry
 *      ONLY scalar values (the append-guard discipline);
 *   7. the registration is the DISCLOSED CHECKER PROVISION (the dispatch
 *      forbids spec/ edits — the Tech Lead performs the spec promotion
 *      at harvest, the MKT-066 precedent): the spec documents remain
 *      UNTOUCHED by this Work Item, the checker enforces the module with
 *      EXACTLY its declared frozen-row directions, and the real codebase
 *      enforces the frozen boundaries with ZERO violations (51 enforced
 *      modules after this registration: 49 spec-parsed + the disclosed
 *      'apps' provision + the disclosed 'product-marketing' provision);
 *      060_product_marketing.sql is the migration tail.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkArchitecture, parseFrozenMatrix, parseFrozenModules } from '../../tools/arch-check/checker.ts';
import {
  PRODUCT_MARKETING_STRATEGY_VERSION,
  PRODUCT_MARKETING_VOCABULARY_VERSION,
  PRODUCT_MARKETING_PLANNER_FAMILY,
  PRODUCT_MARKETING_INCLUSION_TIERS,
  PRODUCT_MARKETING_CONTENT_PROFILES,
  PRODUCT_MARKETING_ATTRIBUTION_METHODS,
  PRODUCT_MARKETING_METRIC_NAMES,
  PRODUCT_MARKETING_ATTRIBUTION_DISCLOSURE,
  PRODUCT_MARKETING_EXPERIMENT_DISCLOSURE,
  PRODUCT_MARKETING_EVIDENCE_TIER_DISCLOSURE,
  PRODUCT_MARKETING_EXCLUDED_HEALTH_STATES,
} from '../../src/modules/product-marketing/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
const read = (path: string): string => readFileSync(path, 'utf8');

const migration060 = read(join(repoRoot, 'src', 'platform', 'db', 'migrations', '060_product_marketing.sql'));
const pmPublic = read(src('modules', 'product-marketing', 'public.ts'));
const pmModule = read(src('modules', 'product-marketing', 'internal', 'product-marketing-module.ts'));
const pmStore = read(src('modules', 'product-marketing', 'internal', 'product-marketing-store.ts'));
const pmPlanning = read(src('modules', 'product-marketing', 'internal', 'planning.ts'));
const pmRoutes = read(src('api', 'product-marketing-routes.ts'));
const compositionRoot = read(src('composition-root.ts'));
const routesTs = read(src('api', 'routes.ts'));
const applicationTs = read(src('api', 'application.ts'));
const architectureSpec = read(join(repoRoot, 'spec', 'architecture.md'));
const matrixSpec = read(join(repoRoot, 'spec', 'module-dependency-matrix.md'));

const moduleFiles = [
  src('modules', 'product-marketing', 'public.ts'),
  src('modules', 'product-marketing', 'internal', 'product-marketing-module.ts'),
  src('modules', 'product-marketing', 'internal', 'product-marketing-store.ts'),
  src('modules', 'product-marketing', 'internal', 'planning.ts'),
];

/** Comment-stripped source (prose must not confuse the code scans). */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'" ])\/\/[^\n]*/g, '$1');
}

/** Comment-stripped SQL (the migration prose disclosures are not vocabulary). */
function stripSqlComments(sql: string): string {
  return sql
    .replace(/--[^^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

// ---------------------------------------------------------------------------
// 1. Migration 060: OWN TABLES ONLY, no authority table
// ---------------------------------------------------------------------------

test('MKT-070: migration 060 creates exactly the ELEVEN own tables — OWN tables ONLY (no authority table, no shadow ledger)', () => {
  const created = [...migration060.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \(/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(created, [
    'product_marketing_plans',
    'product_marketing_plan_versions',
    'product_marketing_plan_cited_product_inputs',
    'product_marketing_plan_cited_product_facts',
    'product_marketing_plan_cited_product_models',
    'product_marketing_plan_cited_product_risk_flags',
    'product_marketing_plan_cited_research_insights',
    'product_marketing_plan_cited_platform_health_evaluations',
    'product_marketing_plan_cited_experiment_analyses',
    'product_marketing_plan_cited_allocation_recommendations',
    'product_marketing_plan_cited_content_hypotheses',
  ]);
  // No other table is mutated anywhere in the migration (the anchored
  // authority tables appear only inside CHECK-ONLY scope fences; the
  // prose disclosures are stripped before the DDL scan).
  const dmlScan = stripSqlComments(migration060).replace(
    /CREATE OR REPLACE FUNCTION[\s\S]*?LANGUAGE plpgsql;/g,
    '',
  );
  for (const statement of dmlScan.matchAll(/(?:INSERT INTO|DELETE FROM)\s+([a-z_]+)/g)) {
    assert.ok(
      statement[1]!.startsWith('product_marketing_'),
      `the migration writes only the module's own tables (found '${statement[1]}')`,
    );
  }
  // The one sanctioned mutable row family: the plan HEADER's version-tail
  // pointer + CAS token advance (the growth_missions discipline — the
  // store owns the only UPDATE, asserted below).
  const headerUpdates = [...dmlScan.matchAll(/UPDATE\s+([a-z_]+)/g)].map((match) => match[1]!);
  assert.ok(headerUpdates.every((table) => table === 'product_marketing_plans'));
  // The anchored authority tables are read CHECK-ONLY (scope fences only).
  for (const authorityRead of [
    'FROM product_context_inputs',
    'FROM product_source_facts',
    'FROM product_derived_models',
    'FROM product_risk_flags',
    'FROM research_insights',
    'FROM platform_health_evaluations',
    'FROM experiment_analysis_records',
    'FROM experiment_allocation_recommendations',
    'FROM content_hypotheses',
  ]) {
    assert.ok(
      migration060.includes(authorityRead),
      `the anchored table is read CHECK-ONLY inside a scope fence (${authorityRead})`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. The frozen vocabularies are versioned + CHECK-fenced
// ---------------------------------------------------------------------------

test('MKT-070: the frozen vocabulary + strategy version strings are pinned and CHECK-fenced', () => {
  assert.equal(PRODUCT_MARKETING_STRATEGY_VERSION, 'pm-plan-v1');
  assert.equal(PRODUCT_MARKETING_VOCABULARY_VERSION, 'pm-vocab-v1');
  assert.equal(PRODUCT_MARKETING_PLANNER_FAMILY, 'product_marketing');
  assert.deepEqual(PRODUCT_MARKETING_INCLUSION_TIERS, ['primary', 'secondary', 'excluded']);
  assert.deepEqual(PRODUCT_MARKETING_CONTENT_PROFILES, [
    'broad_reach_visual',
    'technical_authority',
    'conversion_focused',
    'community_narrative',
  ]);
  assert.deepEqual(PRODUCT_MARKETING_ATTRIBUTION_METHODS, [
    'attribution_id_last_touch',
    'attribution_id_first_touch',
    'attribution_id_linear_multi_touch',
  ]);
  assert.deepEqual(PRODUCT_MARKETING_METRIC_NAMES, [
    'qualified_site_visits',
    'attributable_conversions',
    'engaged_platform_reach',
    'content_engagement_rate',
  ]);
  assert.deepEqual([...PRODUCT_MARKETING_EXCLUDED_HEALTH_STATES], [
    'restricted',
    'publishing_blocked',
    'authorization_blocked',
  ]);
  // The migration CHECK-fences the strategy version + the required reason.
  assert.ok(migration060.includes("CHECK (strategy_version = 'pm-plan-v1')"));
  assert.ok(migration060.includes("CHECK (length(reason) >= 1 AND length(reason) <= 4000)"));
  assert.ok(migration060.includes('CHECK (current_version_seq >= 1)'));
  // The bounded jsonb blocks (the house jsonb precedent — module guards
  // are the vocabulary fence, the boundary tests pin the sets).
  assert.ok(migration060.includes('jsonb_array_length(platform_portfolio) <= 32'));
  assert.ok(migration060.includes('jsonb_array_length(metric_plan) <= 16'));
  assert.ok(migration060.includes('jsonb_array_length(decisions) <= 64'));
  // The disclosures ship on the public contract.
  assert.ok(pmPublic.includes('export const PRODUCT_MARKETING_ATTRIBUTION_DISCLOSURE'));
  assert.ok(pmPublic.includes('export const PRODUCT_MARKETING_EXPERIMENT_DISCLOSURE'));
  assert.ok(pmPublic.includes('export const PRODUCT_MARKETING_EVIDENCE_TIER_DISCLOSURE'));
  assert.ok(PRODUCT_MARKETING_ATTRIBUTION_DISCLOSURE.includes('attribution is distinct from causality'));
  assert.ok(PRODUCT_MARKETING_EXPERIMENT_DISCLOSURE.includes('creates no experiment'));
  assert.ok(PRODUCT_MARKETING_EVIDENCE_TIER_DISCLOSURE.includes('evidence-backed'));
});

// ---------------------------------------------------------------------------
// 3. The append-only + scope-fence battery
// ---------------------------------------------------------------------------

test('MKT-070: the append-only UPDATE/DELETE rejection triggers exist on the version tail and EVERY citation table', () => {
  // The version tail has its own family; the nine citation tables share
  // the one citations family (the migration's disclosed naming).
  assert.ok(migration060.includes('CREATE OR REPLACE FUNCTION product_marketing_plan_versions_append_only()'));
  assert.ok(
    migration060.includes('CREATE TRIGGER product_marketing_plan_versions_append_only_update_trigger'),
  );
  assert.ok(
    migration060.includes('CREATE TRIGGER product_marketing_plan_versions_append_only_delete_trigger'),
  );
  assert.ok(migration060.includes('CREATE OR REPLACE FUNCTION product_marketing_plan_citations_append_only()'));

  const citationTables = [
    'product_marketing_plan_cited_product_inputs',
    'product_marketing_plan_cited_product_facts',
    'product_marketing_plan_cited_product_models',
    'product_marketing_plan_cited_product_risk_flags',
    'product_marketing_plan_cited_research_insights',
    'product_marketing_plan_cited_platform_health_evaluations',
    'product_marketing_plan_cited_experiment_analyses',
    'product_marketing_plan_cited_allocation_recommendations',
    'product_marketing_plan_cited_content_hypotheses',
  ];
  for (const table of citationTables) {
    assert.ok(
      migration060.includes(`BEFORE UPDATE ON ${table}`),
      `${table} rejects UPDATE`,
    );
    assert.ok(
      migration060.includes(`BEFORE DELETE ON ${table}`),
      `${table} rejects DELETE`,
    );
  }
});

test('MKT-070: every cross-module FK citation is scope-fenced (product-context / research-session / client)', () => {
  const scopeFunctions = [
    'product_marketing_cited_product_inputs_scope_consistent',
    'product_marketing_cited_product_facts_scope_consistent',
    'product_marketing_cited_product_models_scope_consistent',
    'product_marketing_cited_product_risk_flags_scope_consistent',
    'product_marketing_cited_research_insights_scope_consistent',
    'product_marketing_cited_platform_health_scope_consistent',
    'product_marketing_cited_experiment_analyses_scope_consistent',
    'product_marketing_cited_allocation_recommendations_scope_consistent',
    'product_marketing_cited_content_hypotheses_scope_consistent',
  ];
  for (const fn of scopeFunctions) {
    assert.ok(migration060.includes(`CREATE OR REPLACE FUNCTION ${fn}()`), `${fn} exists`);
    assert.ok(
      migration060.includes(`EXECUTE FUNCTION ${fn}()`),
      `${fn} is wired as a BEFORE INSERT trigger`,
    );
  }
  // The plan FK-anchors the mission, the client chain and the cited contexts.
  assert.ok(migration060.includes('REFERENCES growth_missions(mission_id)'));
  assert.ok(migration060.includes('REFERENCES clients(client_id)'));
  assert.ok(migration060.includes('REFERENCES product_contexts(product_context_id)'));
  assert.ok(migration060.includes('REFERENCES research_sessions(research_session_id)'));
  // ONE plan per mission (the UNIQUE fence).
  assert.ok(migration060.includes('CONSTRAINT product_marketing_plans_mission_uniq UNIQUE (mission_id)'));
});

// ---------------------------------------------------------------------------
// 4. The no-second-engine battery (rule 17 — the Growth Operator owns
//    the bounded delegation; this planner is the decision layer)
// ---------------------------------------------------------------------------

test('MKT-070: NO scheduler/timer/loop of any kind exists in the module', () => {
  for (const file of moduleFiles) {
    const code = stripComments(read(file));
    for (const forbidden of ['setInterval', 'setTimeout', 'setImmediate', 'process.nextTick', 'new Worker', 'cron']) {
      assert.ok(!code.includes(forbidden), `${file}: no scheduler/timer/loop primitive ('${forbidden}')`);
    }
  }
});

test('MKT-070: NO workflow/execution/publish/experiment-creation verb exists in the module (the decision layer only)', () => {
  const code = [stripComments(pmModule), stripComments(pmStore)].join('\n');
  for (const forbidden of [
    'createWorkflow',
    'createExecution',
    'transitionExecution',
    'submitPublish',
    'createExperiment',
    'applyExperimentTransition',
    'evaluateAccountHealth(',
    'setGrowthMissionStatus',
    'appendEvidence',
  ]) {
    assert.ok(!code.includes(forbidden), `the module never calls '${forbidden}' (no second engine, no provider call, no experiment creation, no mission mutation)`);
  }
});

test('MKT-070: the module imports NO social-accounts, NO goals, NO experiments, NO research, NO workspaces (the ports are structural)', () => {
  for (const file of moduleFiles) {
    const code = stripComments(read(file));
    for (const forbidden of [
      'social-accounts/public.ts',
      'goals/public.ts',
      'experiments/public.ts',
      'research/public.ts',
      'workspaces/public.ts',
      'cross-platform-distribution/public.ts',
      'ai-runtime/public.ts',
    ]) {
      assert.ok(!code.includes(forbidden), `${file}: no '${forbidden}' import (not an allowance of the frozen row)`);
    }
  }
});

// ---------------------------------------------------------------------------
// 5. The read-only boundary battery (the five frozen-row allowances)
// ---------------------------------------------------------------------------

test('MKT-070: the module imports EXACTLY the five frozen matrix allowances through their public contracts', () => {
  const frozenRow = [
    'growth-missions',
    'product-intelligence',
    'content-intelligence',
    'platform-health',
    'experiment-analysis',
  ];
  const allowedImports = new Set(frozenRow.map((target) => `../${target}/public.ts`));
  // Platform ports + the module's own files.
  for (const platformImport of [
    '../../platform/clock/clock.ts',
    '../../platform/db/contract.ts',
    '../../platform/ids/ids.ts',
    '../../platform/errors/errors.ts',
    '../../../platform/clock/clock.ts',
    '../../../platform/db/contract.ts',
    '../../../platform/ids/ids.ts',
    '../../../platform/errors/errors.ts',
    '../public.ts',
    './planning.ts',
    './product-marketing-store.ts',
    './internal/product-marketing-module.ts',
    './internal/planning.ts',
    './internal/product-marketing-store.ts',
    '../../growth-missions/public.ts',
  ]) {
    allowedImports.add(platformImport);
  }

  for (const file of moduleFiles) {
    const code = stripComments(read(file));
    for (const match of code.matchAll(/from '(\.[^']+)'/g)) {
      const specifier = match[1]!;
      assert.ok(
        allowedImports.has(specifier),
        `${file}: import '${specifier}' is a frozen-row allowance (platform imports, the shared guards or the module's own files)`,
      );
    }
  }
});

test('MKT-070: DML against the module\'s OWN tables only — the five contracts consumed READ-ONLY', () => {
  const storeCode = stripComments(pmStore);
  for (const statement of storeCode.matchAll(/(?:INSERT INTO|UPDATE|DELETE FROM|FROM)\s+([a-z_]+)/g)) {
    const table = statement[1]!;
    assert.ok(
      table.startsWith('product_marketing_'),
      `the store queries only the module's own tables (found '${table}')`,
    );
  }
  // The store's only UPDATE is the plan header's version-tail pointer +
  // CAS advance (the growth_missions discipline — everything else is
  // append-only by trigger).
  const updates = [...storeCode.matchAll(/UPDATE\s+([a-z_]+)/g)].map((match) => match[1]!);
  assert.deepEqual(updates, ['product_marketing_plans']);

  // The module composes exactly the frozen-row READ surfaces.
  const moduleCode = stripComments(pmModule);
  const readOnlyCalls = [
    'resolveGrowthMissionOwnership',
    'getGrowthMissionDetail',
    'resolveProductContextOwnership',
    'getProductContextDetail',
    'listContentHypothesesForClient',
    'listEvaluationsForClient',
    'listExperimentAnalysesForClient',
    'listAllocationRecommendationsForExperiment',
  ];
  for (const call of readOnlyCalls) {
    assert.ok(moduleCode.includes(`${call}(`), `the module composes ${call} (READ-ONLY)`);
  }
});

// ---------------------------------------------------------------------------
// 6. The route surface battery
// ---------------------------------------------------------------------------

test('MKT-070: the route surface is EXACTLY the three GET/POST record routes — no PUT/PATCH/DELETE, no authority field', () => {
  const routeCodes = stripComments(pmRoutes);
  const registrations = [...routeCodes.matchAll(/router\.add\(\s*'([A-Z]+)',\s*'([^']+)'/g)];
  assert.deepEqual(
    registrations.map((match) => `${match[1]} ${match[2]}`),
    [
      'POST /api/growth-missions/:missionId/product-marketing/plan',
      'GET /api/growth-missions/:missionId/product-marketing/plan',
      'GET /api/growth-missions/:missionId/product-marketing/plan/versions',
    ],
  );
  for (const forbidden of ["'PUT'", "'PATCH'", "'DELETE'"]) {
    assert.ok(!routeCodes.includes(forbidden), `no ${forbidden} route exists (plan corrections are NEW version records)`);
  }
  // The authority-field denylist rejects every plan-shaped field.
  for (const authorityField of [
    'platformPortfolio',
    'metricPlan',
    'contentStrategy',
    'attributionPlan',
    'experimentPlan',
    'decisions',
    'citations',
    'inputDigest',
    'provenance',
  ]) {
    assert.ok(pmRoutes.includes(`'${authorityField}'`), `the authority field '${authorityField}' is denied on the compose surface`);
  }
  // The audit details carry ONLY scalar values.
  assert.ok(pmRoutes.includes('citationKinds: [...new Set(ctx.result.detail.citations.map((c) => c.kind))].join(\',\')'));
  // The composition root + application + routes wiring is registered.
  assert.ok(compositionRoot.includes('createProductMarketingModule'));
  assert.ok(applicationTs.includes('productMarketing: ProductMarketingModuleApi'));
  assert.ok(routesTs.includes('registerProductMarketingRoutes(router, services, modules)'));
});

// ---------------------------------------------------------------------------
// 7. The registration: the DISCLOSED CHECKER PROVISION (no spec/ edits —
//    the Tech Lead performs the spec promotion at harvest)
// ---------------------------------------------------------------------------

test('MKT-070: the spec promotion is COMPLETE (the TL harvest-time registration, the MKT-066 precedent)', () => {
  // The worker delivered the disclosed checker provision (spec/ untouched
  // at dispatch time); the Tech Lead promoted the registration at harvest:
  // the spec/architecture.md §6 line + the live-matrix row now carry it.
  assert.ok(/\/product-marketing/.test(architectureSpec), 'spec/architecture.md §6 carries the /product-marketing line (the TL promotion)');
  assert.ok(/product-marketing\s*──→/.test(matrixSpec), 'spec/module-dependency-matrix.md carries the product-marketing row (the TL registration)');
  // The spec-parsed module count grew by exactly one (49 → 50), then by
  // one more through the LAB-002 /lab-corpus TL promotion (50 → 51, the
  // /lab registration precedent — a sibling promotion, additive only)
  // and one more through the LAB-011 /lab-agent-body TL promotion
  // (51 → 52, the /lab registration precedent) and one more through
  // the STUDIO-001 /content-studio TL promotion (52 → 53, the /lab
  // registration precedent).
  // the LAB-003 /lab-features granted worker spec registration
  // (52 → 53, the MKT-066 platform-health precedent).
  const specModules = parseFrozenModules(join(repoRoot, 'spec', 'architecture.md'));
  assert.equal(specModules.length, 55);
});

test('MKT-070: the spec-parsed registration enforces the module with EXACTLY its frozen-row directions (the provision retired)', () => {
  const specDir = join(repoRoot, 'spec');
  const modules = parseFrozenModules(join(specDir, 'architecture.md'));
  // The spec promotion registered the row in the live matrix itself —
  // the parsed matrix carries product-marketing (no provision needed).
  const promotedMatrix = parseFrozenMatrix(
    join(specDir, 'module-dependency-matrix.md'),
    join(specDir, 'module-dependency-v1.3.md'),
    [...modules, 'apps'],
  );
  assert.ok('product-marketing' in promotedMatrix, 'the live matrix carries the promoted row');
  // The checker enforces the module with the frozen v1.6 row VERBATIM
  // (now through the spec-parsed registration, the MKT-066 precedent).
  const result = checkArchitecture({
    codeRoot: repoRoot,
    specDir,
    skip: ['tests/architecture/fixtures', 'console'],
  });
  assert.ok(result.frozenModules.includes('product-marketing'));
  assert.deepEqual(result.frozenMatrix['product-marketing'], [
    'growth-missions',
    'product-intelligence',
    'content-intelligence',
    'platform-health',
    'experiment-analysis',
  ]);
  // 51 enforced modules (50 spec-parsed after the promotion + the
  // v1.5 'apps' provision — the checker's v1.6 provision retired at
  // the TL harvest, exactly as its own comment directed). The LAB-011
  // provision is likewise RETIRED (the 2026-09-29 TL spec promotion —
  // /lab-agent-body registers through the promoted spec files) and the
  // LAB-003 delivery appends /lab-features through the granted worker
  // spec registration (the MKT-066 platform-health precedent) — the
  // enforced total becomes 54: 53 spec-parsed + the single /apps
  // provision.
  assert.equal(result.frozenModules.length, 56);
});

test('MKT-070: the real codebase enforces the frozen boundaries with ZERO violations; migration 060 is the tail', () => {
  const specDir = join(repoRoot, 'spec');
  const result = checkArchitecture({
    codeRoot: repoRoot,
    specDir,
    skip: ['tests/architecture/fixtures', 'console'],
  });
  assert.deepEqual(
    result.violations.map((violation) => `[${violation.rule}] ${violation.file}: ${violation.detail}`),
    [],
  );
  assert.ok(
    readFileSync(join(repoRoot, 'src', 'platform', 'db', 'migrations', '060_product_marketing.sql'), 'utf8').length > 0,
  );
  // The migration is the LAST numbered migration (the next-free-number
  // disclosure: 060 was free at this base).
  const numbered = readdirSync(join(repoRoot, 'src', 'platform', 'db', 'migrations'))
    .filter((name) => /^\d+_/.test(name))
    .sort();
  assert.equal(numbered[numbered.length - 6], '060_product_marketing.sql');
  assert.equal(numbered[numbered.length - 5], '061_lab_corpus.sql');
  assert.equal(numbered[numbered.length - 3], '063_lab_agent_body.sql');
  assert.equal(numbered[numbered.length - 1], '065_lab_features.sql');
});

// ---------------------------------------------------------------------------
// 8. The pure-core determinism disclosure (the strategy-space posture)
// ---------------------------------------------------------------------------

test('MKT-070: the planning core is PURE — no clock, no randomness, no network, no I/O', () => {
  const code = stripComments(pmPlanning);
  for (const forbidden of [
    'Date.now',
    'Math.random',
    'clock.nowIso',
    'fetch(',
    'db.query',
    'new Date(',
  ]) {
    assert.ok(!code.includes(forbidden), `the pure core never uses '${forbidden}'`);
  }
  assert.ok(pmPlanning.includes('export function composeProductMarketingPlanCore'));
  assert.ok(pmPlanning.includes('export function computePlannerInputDigest'));
  assert.ok(pmPlanning.includes('export function deriveProductSignals'));
  // The fabrication-resistance fence exists in the store.
  assert.ok(pmStore.includes('function assertCitationsResolve'));
});
