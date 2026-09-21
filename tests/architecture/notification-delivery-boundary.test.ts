/**
 * MKT-068 static tests — the Notification Delivery Plane is structurally
 * correct in the ACTUAL migration, module contract and route surface
 * (pure static analysis, no DB; the social-accounts-boundary precedent).
 *
 * Proofs (spec/effective-backlog-v1.6.md MKT-068; spec/
 * architecture-v1.6.md §14; spec/module-dependency-matrix-v1.6.md
 * boundary rule 9):
 *   1. migration 047 (the PRE-ASSIGNED number) creates exactly the four
 *      own tables — notifications, notification_delivery_fences,
 *      notification_delivery_receipts, notification_inbox_items — OWN
 *      tables ONLY: no notifications-module, policy, credential, tenant,
 *      workflow, execution, mission or job table (the authorities stay
 *      sole, consumed READ-ONLY through the public contracts; the
 *      /notifications MKT-001 boundary stays boundary-only);
 *   2. the FROZEN VOCABULARIES are CHECK-fenced: event type, urgency,
 *      source kind, delivery status, receipt outcome, the channel set
 *      (the six declared keys) — plus the RELATIVE deep-link fence, the
 *      honest receipt payload-shape CHECK, the unique occurrence fence,
 *      the 1:1 inbox fence, the single pending → dispatched fill, the
 *      single append-only read transition and the append-only
 *      UPDATE/DELETE rejection triggers on fences + receipts;
 *   3. THE SECRET SEPARATION BATTERY (AC-4): NO token, secret, material
 *      or handle column ANYWHERE in migration 047 (the email provider
 *      credential is the /credentials VAULT REFERENCE resolved at
 *      delivery time — the reference id arrives through the composition
 *      seam, never a module table); DML targets ONLY the module's own
 *      four tables;
 *   4. THE TASK/BOUNDARY RULE-9 BATTERY: NO task/action-state verb or
 *      column anywhere — no done/acknowledged/acted_on/completed_task
 *      shape; the delivery status is the adapter-plane lifecycle ONLY
 *      (pending → dispatched); the read state is the in-app
 *      projection's delivery fact;
 *   5. the route surface is EXACTLY the frozen five (one delivery POST +
 *      three reads + the read transition POST); NO update or delete
 *      routes; NO dispatch/retry route;
 *   6. the /notification-delivery public contract imports ONLY the
 *      matrix-listed module publics (/notifications, /policies) — the
 *      /credentials consumption rides the email adapter's structural
 *      port; the email adapter lives ONLY under the sanctioned
 *      internal/adapters/ subtree and is imported ONLY by the
 *      composition root (the real-codebase arch-check run with zero
 *      violations);
 *   7. the DISCLOSED spec registration exists: the §6 line + the §6
 *      registration sentence + the matrix row + the
 *      forbidden-directions bullet; 047_notification_delivery.sql holds
 *      its numeric position at the END of the expected-migration list;
 *   8. the fail-closed registration guards are encoded: an adapter
 *      under a declared-but-unimplemented channel key is refused, and
 *      duplicate channel registrations are refused.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkArchitecture, parseFrozenMatrix, parseFrozenModules } from '../../tools/arch-check/checker.ts';
import {
  NOTIFICATION_DELIVERY_CHANNELS,
  NOTIFICATION_DELIVERY_OUTCOMES,
  NOTIFICATION_DELIVERY_STATUSES,
  NOTIFICATION_DELIVERY_VOCABULARY_VERSION,
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_SOURCE_KINDS,
  NOTIFICATION_URGENCIES,
  PLUGGABLE_NOTIFICATION_CHANNEL_KEYS,
  channelPolicyKey,
} from '../../src/modules/notification-delivery/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
const read = (path: string): string => readFileSync(path, 'utf8');

const migration047 = read(src('platform', 'db', 'migrations', '047_notification_delivery.sql'));
const deliveryPublic = read(src('modules', 'notification-delivery', 'public.ts'));
const deliveryModule = read(src('modules', 'notification-delivery', 'internal', 'module.ts'));
const deliveryStore = read(src('modules', 'notification-delivery', 'internal', 'store.ts'));
const deliveryValidation = read(src('modules', 'notification-delivery', 'internal', 'validation.ts'));
const inAppChannel = read(src('modules', 'notification-delivery', 'internal', 'in-app-channel.ts'));
const emailAdapter = read(
  src('modules', 'notification-delivery', 'internal', 'adapters', 'email-adapter.ts'),
);
const deliveryRoutes = read(src('api', 'notification-delivery-routes.ts'));
const compositionRoot = read(src('composition-root.ts'));
const routesTs = read(src('api', 'routes.ts'));
const applicationTs = read(src('api', 'application.ts'));
const architectureSpec = read(join(repoRoot, 'spec', 'architecture.md'));
const matrixSpec = read(join(repoRoot, 'spec', 'module-dependency-matrix.md'));

/** Extracts the CREATE TABLE block for `table` from a migration SQL text. */
function createTableBlock(migration: string, table: string): string {
  const marker = `CREATE TABLE IF NOT EXISTS ${table} (`;
  const start = migration.indexOf(marker);
  assert.ok(start >= 0, `migration must create ${table}`);
  const end = migration.indexOf('\n);', start);
  assert.ok(end > start, `${table} block must terminate`);
  return migration.slice(start, end);
}

function columnsOf(block: string): string[] {
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[a-z_]+\s+\w+/.test(line))
    .map((line) => line.split(/\s+/)[0]!);
}

/** Comment-stripped source (prose must not confuse the code scans). */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'" ])\/\/[^\n]*/g, '$1');
}

/** Comment-stripped SQL (dash-dash line comments and block comments). */
function stripSqlComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*--.*$/gm, '');
}

// ---------------------------------------------------------------------------
// 1. Migration 047: OWN TABLES ONLY
// ---------------------------------------------------------------------------

test('MKT-068: migration 047 creates exactly the four notification-delivery tables — OWN tables ONLY', () => {
  const created = [...migration047.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \(/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    created,
    ['notifications', 'notification_delivery_fences', 'notification_delivery_receipts', 'notification_inbox_items'],
    'own tables ONLY — the notification records, the dedup fence, the append-only receipt tail and the in-app read-state projection; the /notifications MKT-001 boundary, /policies (025), /credentials (005) and the tenant authorities stay sole, consumed READ-ONLY through the public contracts',
  );

  // The §14 field set on the notification record.
  const notificationColumns = columnsOf(createTableBlock(migration047, 'notifications'));
  for (const required of [
    'notification_id', 'agency_id', 'client_id', 'workspace_id', 'event_type', 'urgency',
    'explanation', 'source_kind', 'source_id', 'required_action', 'deep_link',
    'delivery_status', 'created_by_actor', 'created_via', 'correlation_id', 'causation_id',
    'created_at', 'updated_at', 'version',
  ]) {
    assert.ok(notificationColumns.includes(required), `notifications must carry '${required}'`);
  }

  // The fence + receipt + inbox shapes.
  const fenceColumns = columnsOf(createTableBlock(migration047, 'notification_delivery_fences'));
  for (const required of ['fence_id', 'source_kind', 'source_id', 'event_type', 'occurrence_key', 'notification_id', 'claimed_at']) {
    assert.ok(fenceColumns.includes(required), `notification_delivery_fences must carry '${required}'`);
  }
  const receiptColumns = columnsOf(createTableBlock(migration047, 'notification_delivery_receipts'));
  for (const required of ['receipt_id', 'notification_id', 'channel', 'outcome', 'provider_message_id', 'reason', 'policy_decision_id', 'recorded_at']) {
    assert.ok(receiptColumns.includes(required), `notification_delivery_receipts must carry '${required}'`);
  }
  const inboxColumns = columnsOf(createTableBlock(migration047, 'notification_inbox_items'));
  for (const required of ['inbox_item_id', 'notification_id', 'read_at', 'read_by_actor', 'created_at']) {
    assert.ok(inboxColumns.includes(required), `notification_inbox_items must carry '${required}'`);
  }

  // OWN TABLES ONLY: no other module's table is created or mutated.
  for (const forbidden of [
    'CREATE TABLE IF NOT EXISTS policies', 'CREATE TABLE IF NOT EXISTS policy_decisions',
    'CREATE TABLE IF NOT EXISTS credential_references', 'CREATE TABLE IF NOT EXISTS clients',
    'CREATE TABLE IF NOT EXISTS agencies', 'CREATE TABLE IF NOT EXISTS workspaces',
    'CREATE TABLE IF NOT EXISTS growth_missions', 'CREATE TABLE IF NOT EXISTS executions',
    'CREATE TABLE IF NOT EXISTS jobs', 'CREATE TABLE IF NOT EXISTS notifications_module',
    'ALTER TABLE policies', 'ALTER TABLE policy_decisions', 'ALTER TABLE credential_references',
    'ALTER TABLE clients', 'ALTER TABLE growth_missions',
  ]) {
    assert.ok(!migration047.includes(forbidden), `migration 047 must not create or mutate another authority's table (${forbidden})`);
  }
});

// ---------------------------------------------------------------------------
// 2. The frozen vocabularies + the DB fences
// ---------------------------------------------------------------------------

test('MKT-068 AC-1/AC-2: the §14/adapter vocabularies are frozen, versioned and CHECK-fenced in migration 047', () => {
  // The module vocabulary is exactly the disclosed set and carries a version.
  assert.equal(NOTIFICATION_DELIVERY_VOCABULARY_VERSION, 'nd-vocab-v1');
  assert.equal(NOTIFICATION_EVENT_TYPES.length, 9);
  assert.equal(NOTIFICATION_URGENCIES.length, 4);
  assert.equal(NOTIFICATION_SOURCE_KINDS.length, 8);
  assert.deepEqual(NOTIFICATION_DELIVERY_CHANNELS, ['in_app', 'email']);
  assert.deepEqual(PLUGGABLE_NOTIFICATION_CHANNEL_KEYS, ['whatsapp', 'telegram', 'sms', 'signal']);
  assert.deepEqual(NOTIFICATION_DELIVERY_OUTCOMES, ['delivered', 'failed', 'refused', 'duplicate_skipped']);
  assert.deepEqual(NOTIFICATION_DELIVERY_STATUSES, ['pending', 'dispatched']);

  // Every vocabulary value is CHECK-fenced in the migration (notifications +
  // fences + receipts).
  for (const eventType of NOTIFICATION_EVENT_TYPES) {
    assert.ok(migration047.includes(`'${eventType}'`), `event type '${eventType}' must be CHECK-fenced`);
  }
  for (const urgency of NOTIFICATION_URGENCIES) {
    assert.ok(migration047.includes(`'${urgency}'`), `urgency '${urgency}' must be CHECK-fenced`);
  }
  for (const sourceKind of NOTIFICATION_SOURCE_KINDS) {
    assert.ok(migration047.includes(`'${sourceKind}'`), `source kind '${sourceKind}' must be CHECK-fenced`);
  }
  for (const channel of [...NOTIFICATION_DELIVERY_CHANNELS, ...PLUGGABLE_NOTIFICATION_CHANNEL_KEYS]) {
    assert.ok(migration047.includes(`'${channel}'`), `channel '${channel}' must be CHECK-fenced`);
  }
  for (const outcome of NOTIFICATION_DELIVERY_OUTCOMES) {
    assert.ok(migration047.includes(`'${outcome}'`), `outcome '${outcome}' must be CHECK-fenced`);
  }
  for (const status of NOTIFICATION_DELIVERY_STATUSES) {
    assert.ok(migration047.includes(`'${status}'`), `delivery status '${status}' must be CHECK-fenced`);
  }

  // The unique OCCURRENCE FENCE (AC-5) + the 1:1 inbox fence.
  assert.ok(migration047.includes('notification_delivery_fences_occurrence_fence'));
  assert.ok(
    migration047.includes('ON notification_delivery_fences (source_kind, source_id, event_type, occurrence_key)'),
    'the occurrence fence is exactly (source kind, source id, event type, occurrence key)',
  );
  assert.ok(migration047.includes('notification_inbox_items_notification_unique'));

  // The RELATIVE deep-link fence (no absolute URL, no scheme, no whitespace).
  assert.ok(migration047.includes("deep_link LIKE '/%'"));
  assert.ok(migration047.includes("deep_link NOT LIKE '%://%'"));

  // The append-only UPDATE/DELETE rejection triggers.
  assert.ok(migration047.includes('notification_delivery_fence_append_only'));
  assert.ok(migration047.includes('notification_delivery_receipt_append_only'));
  assert.ok(migration047.includes('notification_no_delete'));
  assert.ok(migration047.includes('notification_inbox_item_no_delete'));

  // The single pending → dispatched fill and the single read fill.
  assert.ok(migration047.includes('illegal notification delivery-status transition'));
  assert.ok(migration047.includes('the inbox read transition'));

  // The honest receipt payload-shape CHECK.
  assert.ok(migration047.includes('notification_receipt_shape'));
});

// ---------------------------------------------------------------------------
// 3. The secret separation battery (AC-4)
// ---------------------------------------------------------------------------

test('MKT-068 AC-4: NO secret-shaped column anywhere in migration 047 — the provider credential is the vault reference resolved at delivery time', () => {
  const columns = [
    ...columnsOf(createTableBlock(migration047, 'notifications')),
    ...columnsOf(createTableBlock(migration047, 'notification_delivery_fences')),
    ...columnsOf(createTableBlock(migration047, 'notification_delivery_receipts')),
    ...columnsOf(createTableBlock(migration047, 'notification_inbox_items')),
  ];
  for (const forbidden of ['secret', 'token', 'material', 'handle', 'api_key', 'password']) {
    assert.ok(
      !columns.some((column) => column.includes(forbidden)),
      `no column may carry a '${forbidden}' shape`,
    );
  }

  // The store + module + adapter never persist material: the store SQL has
  // no material parameter; the module only carries the credential
  // REFERENCE id through the adapter construction (composition seam).
  const storeCode = stripComments(deliveryStore);
  assert.ok(!storeCode.includes('material'), 'the store never touches credential material');
  const moduleCode = stripComments(deliveryModule);
  assert.ok(!moduleCode.includes('material'), 'the module core never touches credential material');

  // The email adapter resolves through the vault port ONLY (READ-ONLY) and
  // passes the material ONLY to the transport seam.
  const adapterCode = stripComments(emailAdapter);
  assert.ok(adapterCode.includes('resolveCredentialMaterial'), 'the email adapter resolves through the vault port');
  assert.ok(!adapterCode.includes('INSERT INTO'), 'the email adapter writes no tables');
  assert.ok(!adapterCode.includes('UPDATE '), 'the email adapter mutates no tables');

  // DML targets ONLY the module's own four tables.
  const storeSqlTargets = [...storeCode.matchAll(/(?:INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/g)].map((m) => m[1]!);
  assert.deepEqual(
    [...new Set(storeSqlTargets)].sort(),
    ['notification_delivery_fences', 'notification_delivery_receipts', 'notification_inbox_items', 'notifications'],
    'DML targets ONLY the module\'s own four tables',
  );

  // The migration itself carries NO material-shaped column and no raw
  // secret anywhere (comments stripped SQL-safely).
  const migrationCode = stripSqlComments(migration047);
  for (const forbidden of ['secretMaterial', 'secret_handle', 'api_key', 'password', 'tokenSecret']) {
    assert.ok(!migrationCode.includes(forbidden), `no '${forbidden}' shape may exist in migration 047`);
  }
});

// ---------------------------------------------------------------------------
// 4. The task/action-state boundary battery (boundary rule 9)
// ---------------------------------------------------------------------------

test('MKT-068 boundary rule 9: delivery facts only — NO task/action state anywhere', () => {
  // No task/action-state verb or column anywhere in the module or the
  // migration. The delivery plane NEVER records "task done"/"action taken".
  const forbiddenTaskState = [
    'task_done', 'taskDone', 'action_taken', 'actionTaken', 'acknowledged',
    'acknowledgement', 'completed_task', 'task_resolved', 'action_state',
    'is_done', 'marked_done', 'done_at', 'acted_on',
  ];
  for (const source of [stripSqlComments(migration047), stripComments(deliveryPublic), stripComments(deliveryModule), stripComments(deliveryStore), stripComments(deliveryValidation), stripComments(inAppChannel), stripComments(emailAdapter), stripComments(deliveryRoutes)]) {
    const code = stripComments(source);
    for (const forbidden of forbiddenTaskState) {
      assert.ok(!code.includes(forbidden), `no task/action-state shape ('${forbidden}') may exist anywhere in the delivery plane`);
    }
  }

  // The delivery status is EXACTLY the adapter-plane lifecycle.
  assert.deepEqual(NOTIFICATION_DELIVERY_STATUSES, ['pending', 'dispatched']);

  // The read state is the in-app projection's DELIVERY fact — the read
  // transition records WHO read it, never any action on the subject.
  assert.ok(migration047.includes('read_at'));
  assert.ok(
    !migration047.includes('action_required_at'),
    'no action-tracking column exists — the required action is the §14 declared content',
  );
});

// ---------------------------------------------------------------------------
// 5. The route surface battery
// ---------------------------------------------------------------------------

test('MKT-068 AC-8: the route surface is EXACTLY the frozen five — no update/delete/dispatch/retry route', () => {
  const registrations = [...deliveryRoutes.matchAll(/router\.add\(\s*'([A-Z]+)',\s*'([^']+)'/g)].map(
    (match) => `${match[1]} ${match[2]}`,
  );
  assert.deepEqual(
    registrations.sort(),
    [
      'GET /api/clients/:clientId/notifications',
      'GET /api/clients/:clientId/notifications/:notificationId',
      'POST /api/clients/:clientId/notifications',
      'POST /api/clients/:clientId/notifications/:notificationId/read',
      'GET /api/workspaces/:workspaceId/notifications',
    ].sort(),
    'exactly one delivery POST, three reads and the read transition; no PUT/PATCH/DELETE and no dispatch/retry route',
  );

  // No update/delete verb on the delivery family.
  assert.ok(!/router\.add\(\s*'(PUT|PATCH|DELETE)'/i.test(deliveryRoutes));

  // The authority-field rejection contract.
  assert.ok(deliveryRoutes.includes('NOTIFICATION_AUTHORITY_FIELDS'));
  for (const authorityField of ['notificationId', 'agencyId', 'clientId', 'deliveryStatus', 'receipts', 'duplicate', 'recipients', 'secret', 'material']) {
    assert.ok(deliveryRoutes.includes(`'${authorityField}'`), `the DTOs reject the authority field '${authorityField}'`);
  }

  // The read surface + receipt tail + the uniform 404 discipline are wired.
  assert.ok(deliveryRoutes.includes('requireClientAccess'));
  assert.ok(deliveryRoutes.includes('requireWorkspaceAccess'));
  assert.ok(deliveryRoutes.includes('requireNotificationInClient'));
  assert.ok(deliveryRoutes.includes('resolveNotificationOwnership'));

  // routes.ts registers the family.
  assert.ok(routesTs.includes("import { registerNotificationDeliveryRoutes } from './notification-delivery-routes.ts'"));
  assert.ok(routesTs.includes('registerNotificationDeliveryRoutes(router, services, modules)'));
});

// ---------------------------------------------------------------------------
// 6. The dependency posture (arch-check on the REAL codebase)
// ---------------------------------------------------------------------------

test('MKT-068: the real codebase enforces the frozen boundaries — zero violations, the module public imports only the matrix-listed publics', () => {
  const result = checkArchitecture({
    codeRoot: repoRoot,
    specDir: join(repoRoot, 'spec'),
    skip: ['tests/architecture/fixtures', 'console'],
  });
  assert.deepEqual(
    result.violations.map((violation) => `[${violation.rule}] ${violation.file}: ${violation.detail}`),
    [],
  );

  // The frozen matrix row is parsed from the spec docs.
  const modules = parseFrozenModules(join(repoRoot, 'spec', 'architecture.md'));
  assert.ok(modules.includes('notification-delivery'));
  const matrix = parseFrozenMatrix(
    join(repoRoot, 'spec', 'module-dependency-matrix.md'),
    join(repoRoot, 'spec', 'module-dependency-v1.3.md'),
    [...modules, 'apps'],
  );
  assert.deepEqual(matrix['notification-delivery'], ['notifications', 'policies', 'credentials']);

  // The module public imports exactly the matrix-listed module publics
  // (notifications + policies) and platform contracts; the /credentials
  // consumption rides the email adapter's structural port.
  const publicImports = [...deliveryPublic.matchAll(/from '\.\.\/\.\.\/([a-z/-]+)\/|from '\.\.\/([a-z-]+)\/public\.ts'/g)].map((m) => m[1] ?? m[2]);
  assert.deepEqual(
    [...new Set(publicImports)].sort(),
    ['notifications', 'policies', 'platform/clock', 'platform/db', 'platform/ids'].sort(),
  );

  // The email adapter is imported ONLY by the composition root (the
  // CONCRETE_ADAPTER_ACCESS sanctioned exception) — asserted by the
  // zero-violation arch-check above; additionally pinned directly.
  assert.ok(compositionRoot.includes("from './modules/notification-delivery/internal/adapters/email-adapter.ts'"));
  const adapterImporters = [deliveryModule, deliveryStore, deliveryValidation, inAppChannel, deliveryRoutes].filter(
    (source) => source.includes('adapters/email-adapter'),
  );
  assert.deepEqual(adapterImporters, [], 'no module-internal file imports the email adapter — it arrives as composition data');

  // The application surface carries the module.
  assert.ok(applicationTs.includes('notificationDelivery: NotificationDeliveryModuleApi'));
  assert.ok(compositionRoot.includes('notificationDelivery'));
});

// ---------------------------------------------------------------------------
// 7. The disclosed spec registration
// ---------------------------------------------------------------------------

test('MKT-068: the disclosed spec registration exists (the §6 line + sentence, the matrix row + bullet, the migration position)', () => {
  // §6 module list line.
  assert.ok(/^\/notification-delivery$/m.test(architectureSpec));
  // §6 registration sentence.
  assert.ok(architectureSpec.includes('`/notification-delivery` is the v1.6 Notification Delivery Plane authority'));
  // The matrix row (the frozen v1.6 direction).
  assert.ok(matrixSpec.includes('/notification-delivery ──→ /notifications, /policies, /credentials'));
  // The forbidden-directions bullet.
  assert.ok(matrixSpec.includes('- `/notification-delivery` is the v1.6 Notification Delivery Plane authority'));

  // 047 holds its numeric position at the END of the ordered
  // expected-migration list in the infra-adapters architecture test.
  const infraAdapters = read(join(repoRoot, 'tests', 'architecture', 'infra-adapters.test.ts'));
  const expectedListMatch = infraAdapters.match(/assert\.deepEqual\(migrations, \[([\s\S]*?)\]\);/);
  assert.ok(expectedListMatch !== null, 'the expected-migration list must exist');
  const listEntries = [...expectedListMatch[1]!.matchAll(/'(\d{3}_[a-z_]+\.sql)'/g)].map((m) => m[1]!);
  assert.equal(listEntries[listEntries.length -8], '046_social_accounts.sql');
  assert.equal(listEntries[listEntries.length -7], '047_notification_delivery.sql');
  assert.equal(listEntries[listEntries.length -6], '048_product_intelligence.sql');
  assert.equal(listEntries[listEntries.length -5], '049_commerce_capabilities.sql');
  // The MKT-056 delivery appends 050, the MKT-063 delivery appends 051
  // and the MKT-054 delivery (renumbered 050→052) appends 052 (the same
  // additive precedent — this module's positions shift once more).
  assert.equal(listEntries[listEntries.length -4], '050_social_adapter_contract.sql');
  assert.equal(listEntries[listEntries.length -3], '051_content_rights.sql');
  assert.equal(listEntries[listEntries.length -2], '052_growth_operator.sql');
  assert.equal(listEntries[listEntries.length -1], '053_content_assets.sql');
  // The migration file exists.
  assert.ok(existsSync(src('platform', 'db', 'migrations', '047_notification_delivery.sql')));
});

// ---------------------------------------------------------------------------
// 8. The fail-closed registration guards
// ---------------------------------------------------------------------------

test('MKT-068 AC-2: the pluggable-channel keys are declared-but-unimplemented — registering one fails closed; duplicate channels fail loudly', () => {
  // The module core refuses unimplemented channel registrations and
  // duplicate channels at construction.
  const moduleCode = stripComments(deliveryModule);
  assert.ok(moduleCode.includes('isValidNotificationAdapterRegistration'), 'registrations are validated');
  assert.ok(moduleCode.includes('duplicate notification delivery adapter registration'), 'duplicate channels fail loudly');

  // The validation guard names the pluggable keys as REFUSED.
  assert.ok(deliveryValidation.includes('declared-but-UNIMPLEMENTED pluggable capability key'));

  // The policy key composition (AC-3).
  assert.equal(channelPolicyKey('in_app'), 'notification.channel.in_app');
  assert.equal(channelPolicyKey('email'), 'notification.channel.email');
  assert.equal(channelPolicyKey('whatsapp'), 'notification.channel.whatsapp');
  assert.equal(channelPolicyKey('signal'), 'notification.channel.signal');

  // The module core runs the gate BEFORE any adapter call and records the
  // honest refused receipt.
  assert.ok(moduleCode.includes('evaluateChannelPolicy'));
  assert.ok(moduleCode.includes("'refused'"));
  assert.ok(moduleCode.includes('refusalReason'));
  assert.ok(moduleCode.includes('enforcementOutcome'));

  // The duplicate-skipped receipt path (AC-5).
  assert.ok(moduleCode.includes("'duplicate_skipped'"));
  assert.ok(moduleCode.includes('claim.kind === \'duplicate\''), 'a replayed occurrence never dispatches');

  // The MVP email urgency subset is declared (important/urgent/critical).
  assert.ok(emailAdapter.includes("'important'"));
  assert.ok(emailAdapter.includes("'urgent'"));
  assert.ok(emailAdapter.includes("'critical'"));
  assert.ok(!emailAdapter.includes("'routine'"), 'routine notifications stay in the in-app inbox');
});

// ---------------------------------------------------------------------------
// The boundary stub stays boundary-only (the MKT-001 boundary preserved)
// ---------------------------------------------------------------------------

test('MKT-068: the /notifications MKT-001 boundary stays BOUNDARY-ONLY (name + authority, no business logic)', () => {
  const notificationsStub = read(src('modules', 'notifications', 'public.ts'));
  const code = stripComments(notificationsStub);
  // The stub keeps exactly its boundary identity export.
  assert.ok(code.includes("name: 'notifications'"));
  assert.ok(code.includes("authority: 'Notifications'"));
  // No business logic was added to the boundary.
  assert.ok(!code.includes('deliverNotification'));
  assert.ok(!code.includes('async '));
  assert.ok(!code.includes('INSERT INTO'));
  // The delivery module consumes the boundary READ-ONLY (identity only).
  assert.ok(deliveryPublic.includes("import { notificationsModule } from '../notifications/public.ts'"));
  assert.ok(deliveryPublic.includes('SERVED_NOTIFICATIONS_BOUNDARY'));
});
