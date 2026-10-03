/**
 * MKT-072 static tests — the /commerce-discovery domain is structurally
 * correct in the ACTUAL migration, module contract and route surface
 * (pure static analysis, no DB; the product-marketing-boundary precedent).
 *
 * Proofs (spec/effective-backlog-v1.6.md MKT-072; the frozen v1.6 matrix
 * row, VERBATIM: /commerce-discovery → /growth-missions,
 * /product-intelligence, /content-intelligence, /experiment-analysis,
 * /integrations, /platform-health):
 *   1. migration 062 creates exactly the TWENTY own tables — OWN tables
 *      ONLY, NO mission/goal/product-context/content/experiment/metric/
 *      commerce-event/connection/policy/account/tenant table, and NO
 *      catalog/order/listing/price/inventory table ANYWHERE (lock rules
 *      32/33 — the composed authorities stay sole);
 *   2. the frozen vocabularies are versioned + CHECK-fenced (cd-plan-v1 on
 *      every version row; the bounded jsonb blocks; the bounded-spend
 *      declarations);
 *   3. THE APPEND-ONLY + SCOPE BATTERY: the append-only UPDATE/DELETE
 *      rejection triggers on the version/events/candidates/outcomes/
 *      evaluations tails and EVERY citation link table; the demand tests
 *      admit EXACTLY the single guarded launched→concluded advance; the
 *      program HEADER is the one mutable row family (the state + the
 *      version-tail pointer + the CAS token, exactly the growth_missions
 *      discipline); every cross-module FK citation is scope-fenced
 *      (product-model citations same-context; content/health/analysis/
 *      metric citations same-Client; commerce-event citations same-Client
 *      AND same-declared-store-connection; policy citations on the scope
 *      chain, network dimension, active versions only; the demand tests'
 *      experiments same-Client — all read CHECK-ONLY);
 *   4. THE NO-SECOND-ENGINE BATTERY: NO scheduler/timer/loop of any kind
 *      exists in the module, NO workflow/execution verb, NO listing/
 *      store-mutation verb (no executeMutation — never an auto-listing),
 *      NO experiment-lifecycle ownership (the demand tests are created
 *      THROUGH the /experiments authority via the disclosed port);
 *   5. THE IMPORT BATTERY: the module imports EXACTLY the six frozen-row
 *      allowances through their public contracts + the platform ports +
 *      its own files; the /experiments, /metrics and /policies
 *      dependencies are STRUCTURAL PORTS (no import of their public
 *      contracts — the MKT-070 /research precedent);
 *   6. THE ROUTE SURFACE BATTERY: exactly the sixteen GET/POST record
 *      routes — no PUT/PATCH/DELETE, no authority field, the composition
 *      root + application + routes wiring registered;
 *   7. THE SPEC REGISTRATION: spec/architecture.md §6 carries the
 *      /commerce-discovery line; the live matrix carries the row VERBATIM;
 *      the enforced set includes the module with exactly its frozen-row
 *      directions; the real codebase enforces ZERO violations; migration
 *      062 sits between 061 and 063 (the TL pre-assigned slot);
 *   8. THE PURE-CORE DETERMINISM DISCLOSURE (no clock, no randomness, no
 *      network, no I/O).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkArchitecture, parseFrozenMatrix, parseFrozenModules } from '../../tools/arch-check/checker.ts';
import {
  COMMERCE_DISCOVERY_STRATEGY_VERSION,
  COMMERCE_DISCOVERY_VOCABULARY_VERSION,
  COMMERCE_DISCOVERY_MISSION_FAMILY,
  COMMERCE_DISCOVERY_STATUSES,
  COMMERCE_DISCOVERY_EVENT_KINDS,
  COMMERCE_DISCOVERY_GUARDRAIL_VERDICTS,
  COMMERCE_DISCOVERY_BREACH_REASONS,
  COMMERCE_DISCOVERY_VIABILITY_VERDICTS,
  COMMERCE_DISCOVERY_RECOMMENDATIONS,
  COMMERCE_DISCOVERY_METRIC_NAMES,
  COMMERCE_DISCOVERY_ORDER_TRUTH_DISCLOSURE,
  COMMERCE_DISCOVERY_RECOMMENDATION_DISCLOSURE,
  COMMERCE_DISCOVERY_ATTRIBUTION_DISCLOSURE,
  COMMERCE_DISCOVERY_GUARDRAIL_DISCLOSURE,
  COMMERCE_DISCOVERY_EXPERIMENT_DISCLOSURE,
} from '../../src/modules/commerce-discovery/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
const read = (path: string): string => readFileSync(path, 'utf8');

const migration062 = read(join(repoRoot, 'src', 'platform', 'db', 'migrations', '062_commerce_discovery.sql'));
const cdPublic = read(src('modules', 'commerce-discovery', 'public.ts'));
const cdModule = read(src('modules', 'commerce-discovery', 'internal', 'commerce-discovery-module.ts'));
const cdStore = read(src('modules', 'commerce-discovery', 'internal', 'commerce-discovery-store.ts'));
const cdPlanning = read(src('modules', 'commerce-discovery', 'internal', 'planning.ts'));
const cdRoutes = read(src('api', 'commerce-discovery-routes.ts'));
const compositionRoot = read(src('composition-root.ts'));
const routesTs = read(src('api', 'routes.ts'));
const applicationTs = read(src('api', 'application.ts'));
const architectureSpec = read(join(repoRoot, 'spec', 'architecture.md'));
const matrixSpec = read(join(repoRoot, 'spec', 'module-dependency-matrix.md'));

const moduleFiles = [
  src('modules', 'commerce-discovery', 'public.ts'),
  src('modules', 'commerce-discovery', 'internal', 'commerce-discovery-module.ts'),
  src('modules', 'commerce-discovery', 'internal', 'commerce-discovery-store.ts'),
  src('modules', 'commerce-discovery', 'internal', 'planning.ts'),
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
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

// ---------------------------------------------------------------------------
// 1. Migration 062: OWN TABLES ONLY, no authority table, no order table
// ---------------------------------------------------------------------------

test('MKT-072: migration 062 creates exactly the TWENTY own tables — OWN tables ONLY (no authority table, no order/inventory table anywhere)', () => {
  const created = [...migration062.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \(/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(created, [
    'commerce_discovery_missions',
    'commerce_discovery_mission_versions',
    'commerce_discovery_events',
    'commerce_discovery_candidates',
    'commerce_discovery_demand_tests',
    'commerce_discovery_outcomes',
    'commerce_discovery_guardrail_evaluations',
    'commerce_discovery_version_cited_product_models',
    'commerce_discovery_version_cited_content_candidates',
    'commerce_discovery_version_cited_content_hypotheses',
    'commerce_discovery_version_cited_platform_health_evaluations',
    'commerce_discovery_version_cited_experiment_analyses',
    'commerce_discovery_candidate_cited_product_models',
    'commerce_discovery_candidate_cited_content_candidates',
    'commerce_discovery_candidate_cited_content_hypotheses',
    'commerce_discovery_outcome_cited_commerce_events',
    'commerce_discovery_outcome_cited_metric_observations',
    'commerce_discovery_evaluation_cited_commerce_events',
    'commerce_discovery_evaluation_cited_metric_observations',
    'commerce_discovery_evaluation_cited_policy_versions',
  ]);
  // No catalog/order/listing/price/inventory table exists anywhere in the
  // migration (lock rules 32/33).
  for (const forbidden of ['catalog', 'listing', 'inventory', 'price']) {
    assert.ok(
      !created.some((table) => table.includes(forbidden)),
      `no ${forbidden} table exists in the migration`,
    );
  }
  // No other table is mutated anywhere in the migration (the anchored
  // authority tables appear only inside CHECK-ONLY scope fences; the
  // prose disclosures are stripped before the DDL scan).
  const dmlScan = stripSqlComments(migration062).replace(
    /CREATE OR REPLACE FUNCTION[\s\S]*?LANGUAGE plpgsql;/g,
    '',
  );
  for (const statement of dmlScan.matchAll(/(?:INSERT INTO|DELETE FROM)\s+([a-z_]+)/g)) {
    assert.ok(
      statement[1]!.startsWith('commerce_discovery_'),
      `the migration writes only the module's own tables (found '${statement[1]}')`,
    );
  }
  // The two sanctioned mutable row families: the program HEADER (state +
  // version-tail pointer + CAS) and the demand tests' single guarded
  // advance (asserted by the trigger below — the store owns the only
  // UPDATEs).
  const headerUpdates = [...dmlScan.matchAll(/UPDATE\s+([a-z_]+)/g)].map((match) => match[1]!);
  assert.ok(
    headerUpdates.every(
      (table) => table === 'commerce_discovery_missions' || table === 'commerce_discovery_demand_tests',
    ),
  );
  // The anchored authority tables are read CHECK-ONLY (scope fences only).
  for (const authorityRead of [
    'FROM product_derived_models',
    'FROM content_candidates',
    'FROM content_hypotheses',
    'FROM platform_health_evaluations',
    'FROM experiment_analysis_records',
    'FROM metric_observations',
    'FROM commerce_events',
    'FROM policies',
    'FROM experiments',
  ]) {
    assert.ok(
      migration062.includes(authorityRead),
      `the anchored table is read CHECK-ONLY inside a scope fence (${authorityRead})`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. The frozen vocabularies are versioned + CHECK-fenced
// ---------------------------------------------------------------------------

test('MKT-072: the frozen vocabulary + strategy version strings are pinned and CHECK-fenced', () => {
  assert.equal(COMMERCE_DISCOVERY_STRATEGY_VERSION, 'cd-plan-v1');
  assert.equal(COMMERCE_DISCOVERY_VOCABULARY_VERSION, 'cd-vocab-v1');
  assert.equal(COMMERCE_DISCOVERY_MISSION_FAMILY, 'commerce_discovery');
  assert.deepEqual(COMMERCE_DISCOVERY_STATUSES, [
    'active',
    'guardrail_blocked',
    'concluded',
    'stopped_by_user',
  ]);
  assert.deepEqual(COMMERCE_DISCOVERY_EVENT_KINDS, [
    'discovery_created',
    'version_recorded',
    'state_transition',
    'candidate_recorded',
    'demand_test_launched',
    'demand_test_concluded',
    'outcome_recorded',
    'guardrail_evaluated',
    'guardrail_resolved',
  ]);
  assert.deepEqual(COMMERCE_DISCOVERY_GUARDRAIL_VERDICTS, ['within_bounds', 'breached']);
  assert.deepEqual(COMMERCE_DISCOVERY_BREACH_REASONS, [
    'spend_exceeds_test_budget',
    'demand_tests_exceed_limit',
  ]);
  assert.deepEqual(COMMERCE_DISCOVERY_VIABILITY_VERDICTS, [
    'viable',
    'not_viable',
    'insufficient_observations',
  ]);
  assert.deepEqual(COMMERCE_DISCOVERY_RECOMMENDATIONS, [
    'recommend_listing',
    'recommend_iteration',
    'do_not_list',
  ]);
  assert.deepEqual(COMMERCE_DISCOVERY_METRIC_NAMES, [
    'observed_order_count',
    'observed_order_value',
  ]);
  // The migration CHECK-fences the strategy version + the bounded-spend
  // declarations (the honest seams).
  assert.ok(migration062.includes("CHECK (strategy_version = 'cd-plan-v1')"));
  assert.ok(migration062.includes("CHECK (status IN ('active',"));
  assert.ok(migration062.includes("CHECK (test_budget_minor_units >= 0 AND test_budget_minor_units <= 2000000000)"));
  assert.ok(migration062.includes("CHECK (max_demand_tests >= 1 AND max_demand_tests <= 50)"));
  assert.ok(migration062.includes("CHECK (min_order_count_for_viability >= 1 AND min_order_count_for_viability <= 1000)"));
  assert.ok(migration062.includes("CHECK (verdict IN ('within_bounds', 'breached'))"));
  assert.ok(migration062.includes("CHECK (listing_recommendation IN ('recommend_listing',"));
  // The bounded jsonb blocks (the house jsonb precedent).
  assert.ok(migration062.includes('jsonb_array_length(niche_selection) <= 16'));
  assert.ok(migration062.includes('jsonb_array_length(candidate_proposals) <= 32'));
  assert.ok(migration062.includes('jsonb_array_length(decisions) <= 64'));
  // The disclosures ship on the public contract.
  assert.ok(cdPublic.includes('export const COMMERCE_DISCOVERY_ORDER_TRUTH_DISCLOSURE'));
  assert.ok(cdPublic.includes('export const COMMERCE_DISCOVERY_RECOMMENDATION_DISCLOSURE'));
  assert.ok(cdPublic.includes('export const COMMERCE_DISCOVERY_ATTRIBUTION_DISCLOSURE'));
  assert.ok(cdPublic.includes('export const COMMERCE_DISCOVERY_GUARDRAIL_DISCLOSURE'));
  assert.ok(cdPublic.includes('export const COMMERCE_DISCOVERY_EXPERIMENT_DISCLOSURE'));
  assert.ok(COMMERCE_DISCOVERY_ORDER_TRUTH_DISCLOSURE.includes('only order truth'));
  assert.ok(COMMERCE_DISCOVERY_RECOMMENDATION_DISCLOSURE.includes('never an auto-listing'));
  assert.ok(COMMERCE_DISCOVERY_ATTRIBUTION_DISCLOSURE.includes('distinct from causality'));
  assert.ok(COMMERCE_DISCOVERY_GUARDRAIL_DISCLOSURE.includes('never a silent continue'));
  assert.ok(COMMERCE_DISCOVERY_EXPERIMENT_DISCLOSURE.includes('experiments authority'));
});

// ---------------------------------------------------------------------------
// 3. The append-only + scope-fence battery
// ---------------------------------------------------------------------------

test('MKT-072: the append-only UPDATE/DELETE rejection triggers exist on the tails and EVERY citation table; the demand tests carry the single guarded advance', () => {
  assert.ok(migration062.includes('CREATE OR REPLACE FUNCTION commerce_discovery_mission_versions_append_only()'));
  assert.ok(
    migration062.includes('CREATE TRIGGER commerce_discovery_mission_versions_append_only_update_trigger'),
  );
  assert.ok(
    migration062.includes('CREATE TRIGGER commerce_discovery_mission_versions_append_only_delete_trigger'),
  );
  assert.ok(migration062.includes('CREATE OR REPLACE FUNCTION commerce_discovery_events_append_only()'));
  assert.ok(migration062.includes('CREATE OR REPLACE FUNCTION commerce_discovery_candidates_append_only()'));
  assert.ok(migration062.includes('CREATE OR REPLACE FUNCTION commerce_discovery_outcomes_append_only()'));
  assert.ok(migration062.includes('CREATE OR REPLACE FUNCTION commerce_discovery_evaluations_append_only()'));
  assert.ok(migration062.includes('CREATE OR REPLACE FUNCTION commerce_discovery_citations_append_only()'));

  const citationTables = [
    'commerce_discovery_version_cited_product_models',
    'commerce_discovery_version_cited_content_candidates',
    'commerce_discovery_version_cited_content_hypotheses',
    'commerce_discovery_version_cited_platform_health_evaluations',
    'commerce_discovery_version_cited_experiment_analyses',
    'commerce_discovery_candidate_cited_product_models',
    'commerce_discovery_candidate_cited_content_candidates',
    'commerce_discovery_candidate_cited_content_hypotheses',
    'commerce_discovery_outcome_cited_commerce_events',
    'commerce_discovery_outcome_cited_metric_observations',
    'commerce_discovery_evaluation_cited_commerce_events',
    'commerce_discovery_evaluation_cited_metric_observations',
    'commerce_discovery_evaluation_cited_policy_versions',
  ];
  for (const table of citationTables) {
    assert.ok(migration062.includes(`BEFORE UPDATE ON ${table}`), `${table} rejects UPDATE`);
    assert.ok(migration062.includes(`BEFORE DELETE ON ${table}`), `${table} rejects DELETE`);
  }
  // The demand tests: the SINGLE guarded advance + the no-delete fence.
  assert.ok(migration062.includes('CREATE OR REPLACE FUNCTION commerce_discovery_demand_tests_guarded_advance()'));
  assert.ok(migration062.includes('CREATE TRIGGER commerce_discovery_demand_tests_guarded_advance_trigger'));
  assert.ok(migration062.includes("IF OLD.state = 'launched' AND NEW.state = 'concluded'"));
  assert.ok(migration062.includes('CREATE OR REPLACE FUNCTION commerce_discovery_demand_tests_no_delete()'));
});

test('MKT-072: every cross-module FK citation is scope-fenced (product-context / client / store-connection / policy-chain / experiment-client)', () => {
  const scopeFunctions = [
    'commerce_discovery_version_cited_product_models_scope_consistent',
    'commerce_discovery_version_cited_content_candidates_scope_consistent',
    'commerce_discovery_version_cited_content_hypotheses_scope_consistent',
    'commerce_discovery_version_cited_platform_health_scope_consistent',
    'commerce_discovery_version_cited_experiment_analyses_scope_consistent',
    'commerce_discovery_candidate_cited_product_models_scope_consistent',
    'commerce_discovery_candidate_cited_content_candidates_scope_consistent',
    'commerce_discovery_candidate_cited_content_hypotheses_scope_consistent',
    'commerce_discovery_outcome_cited_commerce_events_scope_consistent',
    'commerce_discovery_outcome_cited_metric_observations_scope_consistent',
    'commerce_discovery_evaluation_cited_commerce_events_scope_consistent',
    'commerce_discovery_evaluation_cited_metric_observations_scope_consistent',
    'commerce_discovery_evaluation_cited_policy_versions_scope_consistent',
    'commerce_discovery_demand_tests_experiment_scope_consistent',
  ];
  for (const fn of scopeFunctions) {
    assert.ok(migration062.includes(`CREATE OR REPLACE FUNCTION ${fn}()`), `${fn} exists`);
    assert.ok(
      migration062.includes(`EXECUTE FUNCTION ${fn}()`),
      `${fn} is wired as a BEFORE INSERT trigger`,
    );
  }
  // The FK anchors: the mission spine, the commerce boundary, the
  // experiments authority and the cited authorities.
  assert.ok(migration062.includes('REFERENCES growth_missions(mission_id)'));
  assert.ok(migration062.includes('REFERENCES integration_connections(connection_id)'));
  assert.ok(migration062.includes('REFERENCES experiments(experiment_id)'));
  assert.ok(migration062.includes('REFERENCES commerce_events(commerce_event_id)'));
  assert.ok(migration062.includes('REFERENCES metric_observations(observation_id)'));
  assert.ok(migration062.includes('REFERENCES policies(policy_id)'));
  assert.ok(migration062.includes('REFERENCES product_derived_models(derived_model_id)'));
  assert.ok(migration062.includes('REFERENCES content_candidates(content_candidate_id)'));
  // ONE program per mission (the UNIQUE fence).
  assert.ok(
    migration062.includes('CONSTRAINT commerce_discovery_missions_mission_uniq UNIQUE (mission_id)'),
  );
  // The commerce-event citation fence checks BOTH the client AND the
  // declared store connection.
  assert.ok(migration062.includes('v_store_connection <> v_event_connection'));
});

// ---------------------------------------------------------------------------
// 4. The no-second-engine battery (lock rules 32/33; the operator owns the
//    bounded delegation; the experiments authority stays sole)
// ---------------------------------------------------------------------------

test('MKT-072: NO scheduler/timer/loop of any kind exists in the module', () => {
  for (const file of moduleFiles) {
    const code = stripComments(read(file));
    for (const forbidden of ['setInterval', 'setTimeout', 'setImmediate', 'process.nextTick', 'new Worker', 'cron']) {
      assert.ok(!code.includes(forbidden), `${file}: no scheduler/timer/loop primitive ('${forbidden}')`);
    }
  }
});

test('MKT-072: NO workflow/execution/publish/listing/experiment-lifecycle verb exists in the module (the recommendation layer + the experiment arm through the authority)', () => {
  const code = [stripComments(cdModule), stripComments(cdStore)].join('\n');
  for (const forbidden of [
    'createWorkflow',
    'createExecution',
    'transitionExecution',
    'submitPublish',
    'executeMutation',
    'executeRead',
    'setGrowthMissionStatus',
    'appendEvidence',
    'appendMetricObservation',
    'declarePolicyVersion',
    'evaluateAction',
  ]) {
    assert.ok(!code.includes(forbidden), `the module never calls '${forbidden}' (no second engine, no provider call, no store mutation, no mission/policy mutation)`);
  }
  // The demand tests are created THROUGH the authority's own command — the
  // ONLY experiment-creating call is the disclosed launch port.
  assert.ok(cdModule.includes('experimentLaunches.createExperiment('));
  assert.ok(cdModule.includes('experimentLaunches.getExperiment('));
});

test('MKT-072: the module imports NO experiments/metrics/policies/workspaces public contract (the ports are structural)', () => {
  for (const file of moduleFiles) {
    const code = stripComments(read(file));
    for (const forbidden of [
      'experiments/public.ts',
      'metrics/public.ts',
      'policies/public.ts',
      'workspaces/public.ts',
      'research/public.ts',
      'cross-platform-distribution/public.ts',
      'content-assets/public.ts',
      'social-accounts/public.ts',
      'goals/public.ts',
      'ai-runtime/public.ts',
    ]) {
      assert.ok(!code.includes(forbidden), `${file}: no '${forbidden}' import (not an allowance of the frozen row)`);
    }
  }
});

// ---------------------------------------------------------------------------
// 5. The import battery (the six frozen-row allowances)
// ---------------------------------------------------------------------------

test('MKT-072: the module imports EXACTLY the six frozen matrix allowances through their public contracts', () => {
  const frozenRow = [
    'growth-missions',
    'product-intelligence',
    'content-intelligence',
    'experiment-analysis',
    'integrations',
    'platform-health',
  ];
  const allowedImports = new Set(frozenRow.map((target) => `../${target}/public.ts`));
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
    './commerce-discovery-store.ts',
    './internal/commerce-discovery-module.ts',
    './internal/planning.ts',
    './internal/commerce-discovery-store.ts',
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
        `${file}: import '${specifier}' is a frozen-row allowance (platform imports or the module's own files)`,
      );
    }
  }
});

test('MKT-072: DML against the module\'s OWN tables only — the six contracts consumed READ-ONLY', () => {
  const storeCode = stripComments(cdStore);
  for (const statement of storeCode.matchAll(/(?:INSERT INTO|UPDATE|DELETE FROM|FROM)\s+([a-z_]+)/g)) {
    const table = statement[1]!;
    assert.ok(
      table.startsWith('commerce_discovery_'),
      `the store queries only the module's own tables (found '${table}')`,
    );
  }
  // The store's only UPDATEs: the program header (state + version-tail
  // pointer + CAS) and the demand tests' single guarded advance.
  const updates = [...storeCode.matchAll(/UPDATE\s+([a-z_]+)/g)].map((match) => match[1]!);
  assert.deepEqual([...updates].sort(), [
    'commerce_discovery_demand_tests',
    'commerce_discovery_missions',
    'commerce_discovery_missions',
    'commerce_discovery_missions',
  ]);

  // The module composes exactly the frozen-row READ surfaces + the port
  // reads (the disclosed off-matrix wirings).
  const moduleCode = stripComments(cdModule);
  const readOnlyCalls = [
    'resolveGrowthMissionOwnership',
    'getGrowthMissionDetail',
    'resolveProductContextOwnership',
    'getProductContextDetail',
    'listContentCandidatesForClient',
    'listContentHypothesesForClient',
    'listEvaluationsForClient',
    'listExperimentAnalysesForClient',
    'resolveConnectionOwnership',
    'listCommerceEventsForClient',
  ];
  for (const call of readOnlyCalls) {
    assert.ok(moduleCode.includes(`${call}(`), `the module composes ${call} (READ-ONLY)`);
  }
});

// ---------------------------------------------------------------------------
// 6. The route surface battery
// ---------------------------------------------------------------------------

test('MKT-072: the route surface is EXACTLY the sixteen GET/POST record routes — no PUT/PATCH/DELETE, no authority field', () => {
  const routeCodes = stripComments(cdRoutes);
  const registrations = [...routeCodes.matchAll(/router\.add\(\s*'([A-Z]+)',\s*'([^']+)'/g)];
  assert.deepEqual(
    registrations.map((match) => `${match[1]} ${match[2]}`),
    [
      'POST /api/growth-missions/:missionId/commerce-discovery/plan',
      'GET /api/growth-missions/:missionId/commerce-discovery/plan',
      'GET /api/growth-missions/:missionId/commerce-discovery/plan/versions',
      'POST /api/growth-missions/:missionId/commerce-discovery/candidates',
      'GET /api/growth-missions/:missionId/commerce-discovery/candidates',
      'POST /api/growth-missions/:missionId/commerce-discovery/demand-tests',
      'GET /api/growth-missions/:missionId/commerce-discovery/demand-tests',
      'POST /api/growth-missions/:missionId/commerce-discovery/demand-tests/:demandTestId/conclusion',
      'POST /api/growth-missions/:missionId/commerce-discovery/outcomes',
      'GET /api/growth-missions/:missionId/commerce-discovery/outcomes',
      'POST /api/growth-missions/:missionId/commerce-discovery/guardrail-evaluations',
      'GET /api/growth-missions/:missionId/commerce-discovery/guardrail-evaluations',
      'POST /api/growth-missions/:missionId/commerce-discovery/guardrail-blocked/resolve',
      'POST /api/growth-missions/:missionId/commerce-discovery/conclude',
      'POST /api/growth-missions/:missionId/commerce-discovery/stop',
      'GET /api/growth-missions/:missionId/commerce-discovery',
    ],
  );
  for (const forbidden of ["'PUT'", "'PATCH'", "'DELETE'"]) {
    assert.ok(!routeCodes.includes(forbidden), `no ${forbidden} route exists (corrections are NEW records)`);
  }
  // The authority-field denylist rejects every plan/observation-shaped field.
  for (const authorityField of [
    'nicheSelection',
    'candidateProposals',
    'demandTestPlan',
    'economicGates',
    'decisions',
    'citations',
    'inputDigest',
    'provenance',
    'observedOrderCount',
    'viabilityVerdict',
    'listingRecommendation',
    'verdict',
    'breachReasons',
    'experimentId',
  ]) {
    assert.ok(cdRoutes.includes(`'${authorityField}'`), `the authority field '${authorityField}' is denied on the mutation surfaces`);
  }
  // The composition root + application + routes wiring is registered.
  assert.ok(compositionRoot.includes('createCommerceDiscoveryModule'));
  assert.ok(applicationTs.includes('commerceDiscovery: CommerceDiscoveryModuleApi'));
  assert.ok(routesTs.includes('registerCommerceDiscoveryRoutes(router, services, modules)'));
});

// ---------------------------------------------------------------------------
// 7. The spec registration (the frozen v1.6 row registered VERBATIM in the
//    live spec files — the MKT-070 promoted-spec precedent)
// ---------------------------------------------------------------------------

test('MKT-072: the spec registration is COMPLETE (the §6 line + the live-matrix row, the MKT-070 precedent)', () => {
  assert.ok(/\/commerce-discovery/.test(architectureSpec), 'spec/architecture.md §6 carries the /commerce-discovery line');
  assert.ok(
    /commerce-discovery\s*──→\s*\/growth-missions, \/product-intelligence, \/content-intelligence, \/experiment-analysis, \/integrations, \/platform-health/.test(matrixSpec),
    'spec/module-dependency-matrix.md carries the commerce-discovery row VERBATIM',
  );
  // The spec-parsed module count grew by exactly one (52 → 53 through this
  // registration; the LAB-001/LAB-002/LAB-011/MKT-070 promotions carried
  // it to 52 before).
  const specModules = parseFrozenModules(join(repoRoot, 'spec', 'architecture.md'));
  assert.equal(specModules.length, 56);
  assert.ok(specModules.includes('commerce-discovery'));
});

test('MKT-072: the spec-parsed registration enforces the module with EXACTLY its frozen-row directions', () => {
  const specDir = join(repoRoot, 'spec');
  const modules = parseFrozenModules(join(specDir, 'architecture.md'));
  const promotedMatrix = parseFrozenMatrix(
    join(specDir, 'module-dependency-matrix.md'),
    join(specDir, 'module-dependency-v1.3.md'),
    [...modules, 'apps'],
  );
  assert.ok('commerce-discovery' in promotedMatrix, 'the live matrix carries the registered row');
  const result = checkArchitecture({
    codeRoot: repoRoot,
    specDir,
    skip: ['tests/architecture/fixtures', 'console'],
  });
  assert.ok(result.frozenModules.includes('commerce-discovery'));
  assert.deepEqual(result.frozenMatrix['commerce-discovery'], [
    'growth-missions',
    'product-intelligence',
    'content-intelligence',
    'experiment-analysis',
    'integrations',
    'platform-health',
  ]);
  // 54 enforced modules (53 spec-parsed + the single /apps provision).
  assert.equal(result.frozenModules.length, 57);
});

test('MKT-072: the real codebase enforces the frozen boundaries with ZERO violations; migration 062 sits in its pre-assigned slot', () => {
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
    readFileSync(join(repoRoot, 'src', 'platform', 'db', 'migrations', '062_commerce_discovery.sql'), 'utf8').length > 0,
  );
  // The migration sits in the TL pre-assigned slot: between 061 (lab-corpus)
  // and 063 (lab-agent-body) — the reserved 062 disclosed by the LAB-011
  // worker's worklog.
  const numbered = readdirSync(join(repoRoot, 'src', 'platform', 'db', 'migrations'))
    .filter((name) => /^\d+_/.test(name))
    .sort();
  assert.equal(numbered[numbered.length - 7], '061_lab_corpus.sql');
  assert.equal(numbered[numbered.length - 6], '062_commerce_discovery.sql');
  assert.equal(numbered[numbered.length - 5], '063_lab_agent_body.sql');
});

// ---------------------------------------------------------------------------
// 8. The pure-core determinism disclosure (the strategy-space posture)
// ---------------------------------------------------------------------------

test('MKT-072: the discovery core is PURE — no clock, no randomness, no network, no I/O', () => {
  const code = stripComments(cdPlanning);
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
  assert.ok(cdPlanning.includes('export function composeCommerceDiscoveryPlanCore'));
  assert.ok(cdPlanning.includes('export function computeDiscoveryInputDigest'));
  assert.ok(cdPlanning.includes('export function evaluateGuardrailsCore'));
  assert.ok(cdPlanning.includes('export function deriveOutcomeCore'));
  assert.ok(cdPlanning.includes('export function deriveDemandTestDesign'));
  // The fabrication-resistance fence exists in the store.
  assert.ok(cdStore.includes('function assertCitationsResolve'));
});
