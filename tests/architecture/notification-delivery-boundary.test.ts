/**
 * MKT-068 static tests — the Notification Delivery Plane is structurally
 * correct in the ACTUAL migration, module contract, adapters and route
 * surface (pure static analysis, no DB; the social-accounts-boundary
 * precedent).
 *
 * Proofs (spec/architecture-v1.6.md §14; spec/effective-backlog-v1.6.md
 * MKT-068; spec/module-dependency-matrix-v1.6.md row
 * /notification-delivery → /notifications, /policies, /credentials and
 * boundary rule 9 "Notification Delivery delivers messages only; it does
 * not become canonical task/action state"):
 *   1. migration 047 (the PRE-ASSIGNED number) creates exactly the four
 *      own tables — notification_records,
 *      notification_delivery_receipts, notification_delivery_dedup_fence,
 *      notification_inbox_states — OWN tables ONLY: NO integration,
 *      credential, policy, tenant, workflow, execution, mission, job or
 *      audit table (the authorities stay sole, consumed READ-ONLY through
 *      the public contracts);
 *   2. the FROZEN VOCABULARIES are CHECK-fenced: the urgency, event-type,
 *      outcome, channel (with the four future capability keys),
 *      source-kind, delivery-status and read-status vocabularies; the
 *      email-context payload-shape fence; the duplicate-free
 *      channel-array trigger; the GLOBAL dedup-fence unique index; the
 *      frozen adapter-plane delivery lifecycle (delivered TERMINAL) and
 *      the single sanctioned unread → read inbox transition; the
 *      append-only UPDATE/DELETE rejection triggers on the receipt tail
 *      and the fence, the no-DELETE triggers on records and inbox, and
 *      the record-immutability trigger (the §14 field set can never be
 *      rewritten);
 *   3. THE DELIVERY-NOT-TASK-STATE BATTERY (boundary rule 9 — the
 *      heart): NO task/action-state verb exists anywhere in the module,
 *      the migration or the routes — no task-done, action-taken,
 *      acknowledged, resolved, completed-work or business-state field;
 *      delivery_status is the ADAPTER-plane lifecycle ONLY;
 *   4. THE SECRET SEPARATION BATTERY (§21): NO token, secret, material,
 *      password, apiKey or ADDRESS column exists anywhere in migration
 *      047 (the email provider credential is a /credentials vault
 *      REFERENCE id; the recipient is a canonical USER id — the address
 *      resolves only through the composition-root port); no
 *      material-shaped key is accepted on any input surface; the
 *      transport seam's credentialMaterial exists ONLY in the in-process
 *      call signature, never in any persisted shape;
 *   5. THE SINGLE DML HOME: the store is the ONLY module file with SQL,
 *      and every SQL statement targets OWN tables only (the adapters are
 *      storage-free — the in-app delivery effect is the module-owned
 *      projection);
 *   6. THE ADAPTER CONTRACT: the two MVP adapters (in-app + email) live
 *      under the sanctioned internal/adapters/** subtree, are wired as
 *      DATA at the composition root ONLY (the arch-check
 *      CONCRETE_ADAPTER_ACCESS exception), declare their acceptance
 *      subsets, and the email adapter resolves the recipient address
 *      ONLY through the structural port with the /policies credential
 *      gate in front of every material resolution; the future capability
 *      keys are declared-but-unimplemented (honest refused receipts);
 *   7. the disclosed spec registration exists: the §6 module-list line,
 *      the §6 authority-notes sentence, the frozen matrix row and the
 *      authority-notes bullet; 047_notification_delivery.sql holds its
 *      numeric position (after 046, the PRE-ASSIGNED numbers);
 *   8. the HTTP surface discipline: GET/POST only (no PUT/PATCH/DELETE
 *      route exists anywhere in the family), the DTOs reject every
 *      authority/material-shaped key, and the fail-closed battery is
 *      encoded (uniform 404 for foreign/unknown; 401 anonymous).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkArchitecture } from '../../tools/arch-check/checker.ts';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_DELIVERY_STATUSES,
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_RECEIPT_OUTCOMES,
  NOTIFICATION_SOURCE_KINDS,
  NOTIFICATION_URGENCIES,
  FUTURE_NOTIFICATION_CHANNELS,
  MVP_NOTIFICATION_CHANNELS,
} from '../../src/modules/notification-delivery/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
const read = (path: string): string => readFileSync(path, 'utf8');

const migration047 = read(src('platform', 'db', 'migrations', '047_notification_delivery.sql'));
const modulePublic = read(src('modules', 'notification-delivery', 'public.ts'));
const moduleCore = read(src('modules', 'notification-delivery', 'internal', 'module.ts'));
const moduleStore = read(src('modules', 'notification-delivery', 'internal', 'store.ts'));
const moduleValidation = read(src('modules', 'notification-delivery', 'internal', 'delivery-validation.ts'));
const inAppAdapter = read(src('modules', 'notification-delivery', 'internal', 'adapters', 'in-app', 'in-app-adapter.ts'));
const emailAdapter = read(src('modules', 'notification-delivery', 'internal', 'adapters', 'email', 'email-adapter.ts'));
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
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/--.*$/gm, '');
}

// ---------------------------------------------------------------------------
// 1. Migration 047 — exactly the four own tables
// ---------------------------------------------------------------------------

test('MKT-068 AC-10 static: migration 047 creates exactly the four OWN tables (nothing else)', () => {
  const tables = [...migration047.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \(/g)].map((m) => m[1]!);
  assert.deepEqual(
    [...tables].sort(),
    [
      'notification_delivery_dedup_fence',
      'notification_delivery_receipts',
      'notification_inbox_states',
      'notification_records',
    ].sort(),
    'migration 047 creates exactly the four own tables',
  );
  // OWN TABLES ONLY: no other module's table is created or mutated.
  const forbidden = [
    'integration_connections', 'integration_events', 'credential_references',
    'policy_versions', 'policy_decisions', 'agencies', 'clients', 'workspaces',
    'users', 'growth_missions', 'executions', 'workflows', 'jobs', 'audit_events',
  ];
  for (const table of forbidden) {
    assert.ok(
      !new RegExp(`(CREATE TABLE|ALTER TABLE|INSERT INTO|UPDATE|DELETE FROM)\\s+${table}\\b`, 'i').test(stripComments(migration047)),
      `migration 047 must never create/mutate the ${table} table`,
    );
  }
  // The FK references are READ-ONLY references to the canonical tables.
  const references = [...migration047.matchAll(/REFERENCES ([a-z_]+)\(/g)].map((m) => m[1]!);
  assert.deepEqual(
    [...new Set(references)].sort(),
    ['agencies', 'clients', 'credential_references', 'notification_records', 'users', 'workspaces'].sort(),
    'the only cross-module references are canonical FK references',
  );
});

// ---------------------------------------------------------------------------
// 2. The frozen vocabularies + fences are CHECK-fenced in the migration
// ---------------------------------------------------------------------------

test('MKT-068 AC-10 static: the urgency/event-type/outcome/channel/source-kind vocabularies are CHECK-fenced verbatim', () => {
  const records = createTableBlock(migration047, 'notification_records');
  const receipts = createTableBlock(migration047, 'notification_delivery_receipts');
  const fence = createTableBlock(migration047, 'notification_delivery_dedup_fence');
  const inbox = createTableBlock(migration047, 'notification_inbox_states');

  // Urgency (AC-1: the §14 field set, frozen).
  const urgencyCheck = records.match(/urgency\s+text\s+NOT NULL\s+CHECK \(urgency IN \(([^)]*)\)\)/);
  assert.ok(urgencyCheck !== null, 'urgency is CHECK-fenced');
  assert.deepEqual(
    urgencyCheck[1]!.split(',').map((v) => v.trim().replace(/'/g, '')),
    [...NOTIFICATION_URGENCIES],
    'the migration urgency vocabulary equals the module contract vocabulary',
  );

  // Event type (both the record and the fence fence the same set).
  for (const block of [records, fence]) {
    const eventCheck = block.match(/event_type\s+text\s+NOT NULL\s+CHECK \(event_type IN \((.*?)\)\)/s);
    assert.ok(eventCheck !== null, 'event_type is CHECK-fenced');
    assert.deepEqual(
      eventCheck[1]!.split(',').map((v) => v.trim().replace(/'/g, '')),
      [...NOTIFICATION_EVENT_TYPES],
      'the migration event-type vocabulary equals the module contract vocabulary',
    );
  }

  // Source kind (both the record and the fence).
  for (const block of [records, fence]) {
    const sourceCheck = block.match(/source_kind\s+text\s+NOT NULL\s+CHECK \(source_kind IN \(([^)]*)\)\)/);
    assert.ok(sourceCheck !== null, 'source_kind is CHECK-fenced');
    assert.deepEqual(
      sourceCheck[1]!.split(',').map((v) => v.trim().replace(/'/g, '')),
      [...NOTIFICATION_SOURCE_KINDS],
      'the migration source-kind vocabulary equals the module contract vocabulary',
    );
  }

  // Channel vocabulary (receipts CHECK + the records trigger): the six
  // frozen keys INCLUDING the four future capability keys (AC-2).
  const channelCheck = receipts.match(/channel\s+text\s+NOT NULL\s+CHECK \(channel IN \(([^)]*)\)\)/);
  assert.ok(channelCheck !== null, 'receipt channel is CHECK-fenced');
  assert.deepEqual(
    channelCheck[1]!.split(',').map((v) => v.trim().replace(/'/g, '')),
    [...NOTIFICATION_CHANNELS],
    'the migration channel vocabulary equals the module contract vocabulary (six keys, future ones included)',
  );
  assert.ok(
    migration047.includes(`v_channel NOT IN (${NOTIFICATION_CHANNELS.map((c) => `'${c}'`).join(', ')})`),
    'the records channel-vocabulary trigger fences the same six keys',
  );

  // Receipt outcome vocabulary (AC-5's duplicate_skipped included).
  const outcomeCheck = receipts.match(/outcome\s+text\s+NOT NULL\s+CHECK \(outcome IN \(([^)]*)\)\)/);
  assert.ok(outcomeCheck !== null, 'receipt outcome is CHECK-fenced');
  assert.deepEqual(
    outcomeCheck[1]!.split(',').map((v) => v.trim().replace(/'/g, '')),
    [...NOTIFICATION_RECEIPT_OUTCOMES],
    'the migration outcome vocabulary equals the module contract vocabulary',
  );

  // Delivery status (the adapter-plane lifecycle — AC-1) + read status.
  const statusCheck = records.match(/delivery_status\s+text\s+NOT NULL DEFAULT 'pending'\s+CHECK \(delivery_status IN \(([^)]*)\)\)/);
  assert.ok(statusCheck !== null, 'delivery_status is CHECK-fenced');
  assert.deepEqual(
    statusCheck[1]!.split(',').map((v) => v.trim().replace(/'/g, '')),
    [...NOTIFICATION_DELIVERY_STATUSES],
    'the migration delivery-status vocabulary equals the module contract vocabulary',
  );
  const readCheck = inbox.match(/read_status\s+text\s+NOT NULL DEFAULT 'unread'\s+CHECK \(read_status IN \(([^)]*)\)\)/);
  assert.ok(readCheck !== null, 'read_status is CHECK-fenced');
  assert.deepEqual(
    readCheck[1]!.split(',').map((v) => v.trim().replace(/'/g, '')),
    ['unread', 'read'],
    'the inbox read-status vocabulary is unread | read',
  );
});

test('MKT-068 AC-10 static: the idempotency fence is the GLOBAL unique index on the four frozen key fields', () => {
  assert.ok(
    migration047.includes(
      'CREATE UNIQUE INDEX IF NOT EXISTS notification_dedup_fence_unique\n    ON notification_delivery_dedup_fence (source_kind, source_id, event_type, occurrence_key);',
    ),
    'the fence unique index covers EXACTLY (source kind, source id, event type, occurrence key)',
  );
  // The fence and the receipts are append-only/immutable (UPDATE/DELETE
  // rejected outright); the records and the inbox rows are never deleted.
  for (const trigger of [
    'notification_receipts_append_only_update_trigger',
    'notification_receipts_append_only_delete_trigger',
    'notification_dedup_fence_append_only_update_trigger',
    'notification_dedup_fence_append_only_delete_trigger',
    'notification_records_no_delete_trigger',
    'notification_inbox_states_no_delete_trigger',
  ]) {
    assert.ok(migration047.includes(trigger), `the ${trigger} exists`);
  }
  // The record immutability trigger freezes the §14 field set, the
  // channels and the email context; delivered is TERMINAL.
  const immutable = migration047.match(/CREATE OR REPLACE FUNCTION notification_records_immutable\(\) RETURNS trigger AS \$\$([\s\S]*?)\$\$/);
  assert.ok(immutable !== null, 'the record immutability function exists');
  for (const fragment of [
    'cannot rewrite its §14 field set',
    'cannot rewrite its requested channel set',
    'cannot rewrite its email channel context',
    'the adapter-plane delivery lifecycle is terminal',
  ]) {
    assert.ok(immutable[1]!.includes(fragment), `the immutability trigger guards: ${fragment}`);
  }
  // The single sanctioned inbox transition (unread → read, terminal).
  const disciplined = migration047.match(/CREATE OR REPLACE FUNCTION notification_inbox_states_disciplined\(\) RETURNS trigger AS \$\$([\s\S]*?)\$\$/);
  assert.ok(disciplined !== null, 'the inbox discipline function exists');
  assert.ok(disciplined[1]!.includes('the read transition is terminal and cannot be reversed'));
  // The email-context payload-shape fence + the receipt payload shape.
  assert.ok(migration047.includes('CONSTRAINT notification_channels_shape'));
  assert.ok(migration047.includes('CONSTRAINT notification_receipt_shape'));
  // The receipt attempt-sequence uniqueness (gapless sequences backstopped).
  assert.ok(migration047.includes('notification_receipts_attempt_unique'));
});

// ---------------------------------------------------------------------------
// 3. THE DELIVERY-NOT-TASK-STATE BATTERY (boundary rule 9)
// ---------------------------------------------------------------------------

test('MKT-068 AC-1/boundary-rule-9 static: NO task/action-state verb exists anywhere in the delivery plane', () => {
  const surfaces = [migration047, modulePublic, moduleCore, moduleStore, moduleValidation, deliveryRoutes];
  // The forbidden business/task-state vocabulary: the module NEVER
  // records "task done", "action taken" or any work-completion state.
  const forbidden = [
    'task_done', 'task complete', 'tasks_done', 'action_taken', 'action taken',
    'actions_taken', 'acknowledged_task', 'task_acknowledged', 'work_completed',
    'completed_task', 'task_completed', 'mission_completed', 'execution_completed',
    'workflow_completed', 'resolved_task', 'task_resolved', 'assignee', 'assignee_id',
    'task_status', 'todo', 'todo_list', 'checklist',
  ];
  for (const surface of stripComments(surfaces.join('\n')).toLowerCase()) {
    void surface;
  }
  const joined = stripComments(surfaces.join('\n')).toLowerCase();
  for (const verb of forbidden) {
    assert.ok(!joined.includes(verb), `the delivery plane must never carry task/action-state vocabulary ('${verb}')`);
  }
  // The delivery-status lifecycle is the ADAPTER plane ONLY: the named
  // states are exactly pending/delivered/partial/undelivered — none is a
  // business/task state.
  assert.deepEqual([...NOTIFICATION_DELIVERY_STATUSES], ['pending', 'delivered', 'partial', 'undelivered']);
  // The route surface exposes NO mutation over any other authority: the
  // only module commands wired are the record/fan-out, the retry, the
  // inbox reads and the read transition.
  const wiredCommands = [...deliveryRoutes.matchAll(/modules\.notificationDelivery\.(\w+)/g)].map((m) => m[1]!);
  assert.deepEqual(
    [...new Set(wiredCommands)].sort(),
    [
      'getInboxEntry',
      'getNotification',
      'listInbox',
      'listNotificationsForAgency',
      'listReceipts',
      'markInboxRead',
      'recordNotification',
      'redeliverChannel',
    ].sort(),
    'the HTTP surface wires exactly the delivery-plane commands (no authority mutation)',
  );
});

// ---------------------------------------------------------------------------
// 4. THE SECRET SEPARATION BATTERY (§21)
// ---------------------------------------------------------------------------

test('MKT-068 AC-4 static: NO secret/material/ADDRESS column exists anywhere in migration 047', () => {
  const tables = ['notification_records', 'notification_delivery_receipts', 'notification_delivery_dedup_fence', 'notification_inbox_states'];
  for (const table of tables) {
    const columns = columnsOf(createTableBlock(migration047, table));
    for (const forbidden of [
      'token', 'secret', 'secret_material', 'material', 'password', 'api_key',
      'apikey', 'access_key', 'secret_handle', 'address', 'email_address',
      'recipient_address', 'to_address', 'smtp_password', 'provider_secret',
    ]) {
      assert.ok(!columns.includes(forbidden), `${table} must not carry a '${forbidden}' column (§21)`);
    }
  }
  // The email context is EXACTLY a canonical user id + a vault reference id.
  const recordsColumns = columnsOf(createTableBlock(migration047, 'notification_records'));
  assert.ok(recordsColumns.includes('recipient_user_id'), 'the recipient is a canonical USER id');
  assert.ok(recordsColumns.includes('email_credential_reference_id'), 'the provider credential is a vault REFERENCE id');
});

test('MKT-068 AC-4/§21 static: the module guards carry the material-key backstop; the transport material exists ONLY in-process', () => {
  const validation = stripComments(moduleValidation);
  assert.ok(validation.includes('MATERIAL_SHAPED_VALUES'), 'the §21 material-shaped value backstop is a named rejection class');
  assert.ok(validation.includes('the delivery plane carries vault references, never secrets'), 'the backstop message names the §21 posture');
  // The route DTOs reject material-shaped keys outright.
  const routes = stripComments(deliveryRoutes);
  for (const key of ['secret', 'secretMaterial', 'material', 'password', 'token', 'apiKey', 'api_key', 'accessKey', 'secretHandle', 'recipientAddress']) {
    assert.ok(routes.includes(`'${key}',`), `the route DTOs reject the material-shaped key '${key}'`);
  }
  // The credential material appears ONLY in the in-process transport call
  // signature — never in any persisted shape (the store has no material
  // parameter anywhere).
  const store = stripComments(moduleStore);
  assert.ok(!store.toLowerCase().includes('material'), 'the store never touches credential material');
  assert.ok(!store.toLowerCase().includes('resolvecredentialmaterial'), 'the store never resolves credential material');
  // The vault resolution lives ONLY in the sanctioned email adapter
  // subtree — never in the module core.
  const core = stripComments(moduleCore);
  assert.ok(!core.includes('resolveCredentialMaterial'), 'the module core never resolves credential material (the sanctioned adapter subtree only)');
  const email = stripComments(emailAdapter);
  assert.ok(email.includes('resolveCredentialMaterial'), 'the email adapter resolves the vault material (the sanctioned home)');
});

// ---------------------------------------------------------------------------
// 5. THE SINGLE DML HOME + own-tables-only SQL
// ---------------------------------------------------------------------------

test('MKT-068 AC-11 static: the store is the SINGLE DML home; every SQL statement targets OWN tables only', () => {
  const moduleFiles = [
    src('modules', 'notification-delivery', 'internal', 'module.ts'),
    src('modules', 'notification-delivery', 'internal', 'delivery-validation.ts'),
    src('modules', 'notification-delivery', 'internal', 'adapters', 'in-app', 'in-app-adapter.ts'),
    src('modules', 'notification-delivery', 'internal', 'adapters', 'email', 'email-adapter.ts'),
  ];
  for (const file of moduleFiles) {
    const text = stripComments(read(file));
    assert.ok(!/\bSELECT\b|\bINSERT INTO\b|\bUPDATE\b|\bDELETE FROM\b/i.test(text), `${file}: no SQL (the adapters are storage-free; ALL SQL lives in the store)`);
  }
  // Every table the store touches is an OWN table.
  const storeSql = stripComments(moduleStore);
  const touched = [...storeSql.matchAll(/\b(?:FROM|INTO|UPDATE)\s+([a-z_]+)/gi)].map((m) => m[1]!);
  assert.ok(touched.length > 0, 'the store carries SQL');
  for (const table of new Set(touched)) {
    assert.ok(
      table.startsWith('notification_'),
      `the store DML targets an OWN table only (found '${table}')`,
    );
  }
});

// ---------------------------------------------------------------------------
// 6. The adapter contract (AC-2/AC-4/AC-7)
// ---------------------------------------------------------------------------

test('MKT-068 AC-2 static: the MVP adapters live under the sanctioned subtree, declare acceptance, and are wired as DATA at the composition root only', () => {
  assert.ok(existsSync(src('modules', 'notification-delivery', 'internal', 'adapters', 'in-app', 'in-app-adapter.ts')));
  assert.ok(existsSync(src('modules', 'notification-delivery', 'internal', 'adapters', 'email', 'email-adapter.ts')));
  // The arch-check clean run proves the CONCRETE_ADAPTER_ACCESS wiring
  // posture (adapters importable only by the composition root + tests).
  const result = checkArchitecture({
    codeRoot: repoRoot,
    specDir: join(repoRoot, 'spec'),
    skip: ['tests/architecture/fixtures', 'console'],
  });
  assert.deepEqual(result.violations, [], 'the static architecture check is clean (adapter wiring included)');
  // The composition root constructs BOTH adapters and passes them as DATA.
  const root = stripComments(compositionRoot);
  assert.ok(root.includes('new InAppDeliveryAdapter()'), 'the in-app adapter is constructed at the composition root');
  assert.ok(root.includes('new EmailDeliveryAdapter({'), 'the email adapter is constructed at the composition root');
  assert.ok(root.includes('adapters: ['), 'the adapters arrive as module DATA (the registry seam)');
  // The email acceptance subset is REAL (AC-2: each channel DECLARES what
  // it accepts; low urgency stays in-app only in the MVP profile).
  const email = stripComments(emailAdapter);
  assert.ok(email.includes("urgencies: ['normal', 'high', 'critical']"), 'the email adapter declares a real urgency subset');
  // The in-app adapter declares the ALWAYS-ON profile (all urgencies, all
  // event types — the inbox is the internal surface).
  const inApp = stripComments(inAppAdapter);
  assert.ok(inApp.includes('urgencies: [...NOTIFICATION_URGENCIES]'), 'the in-app adapter accepts every urgency');
  assert.ok(inApp.includes('eventTypes: [...NOTIFICATION_EVENT_TYPES]'), 'the in-app adapter accepts every event type');
  // The recipient address resolves ONLY through the structural port.
  assert.ok(email.includes('resolveRecipientAddress'), 'the email adapter resolves the address ONLY through the port');
  assert.ok(!/\baddress\s*[:=]\s*['"`]/.test(email), 'the email adapter never hard-codes or guesses an address');
  // The credential gate runs BEFORE the material resolution.
  const gateIndex = email.indexOf('emailCredentialPolicyOperation()');
  const materialIndex = email.indexOf('resolveCredentialMaterial');
  assert.ok(gateIndex >= 0 && materialIndex > gateIndex, 'the /policies credential gate precedes the vault material resolution');
  // The disclosed unwired transport is the composition default.
  assert.ok(root.includes('new UnwiredEmailTransport()'), 'the disclosed unwired transport is the composition default');
  assert.ok(compositionRoot.includes('emailTransport?: EmailTransport | undefined'), 'AppOptions.emailTransport is the disclosed seam');
  // The future capability keys are declared but unimplemented: the MVP
  // composition registers EXACTLY the two MVP adapters.
  assert.deepEqual([...MVP_NOTIFICATION_CHANNELS], ['in-app', 'email']);
  assert.deepEqual([...FUTURE_NOTIFICATION_CHANNELS], ['whatsapp', 'telegram', 'sms', 'signal']);
  assert.ok(
    !root.includes('whatsapp') && !root.includes('telegram'),
    'the production composition registers NO future-channel adapter',
  );
});

// ---------------------------------------------------------------------------
// 7. The disclosed spec registration + the migration position
// ---------------------------------------------------------------------------

test('MKT-068 AC-11 static: the disclosed spec registration exists — §6 line + §6 sentence + matrix row + authority-notes bullet; 047 in numeric position', () => {
  // The §6 module-list line.
  assert.ok(/^\/notification-delivery$/m.test(architectureSpec), 'the §6 module list carries /notification-delivery');
  // The §6 authority-notes sentence.
  assert.ok(
    architectureSpec.includes('`/notification-delivery` is the v1.6 Notification Delivery Plane authority'),
    'the §6 authority-notes sentence exists',
  );
  assert.ok(
    architectureSpec.includes('never becomes canonical task/action state (module-dependency-matrix-v1.6 boundary rule 9'),
    'the §6 sentence carries the boundary-rule-9 disclosure',
  );
  // The frozen matrix row (the v1.6-frozen dependency set).
  assert.ok(
    matrixSpec.includes('/notification-delivery ──→ /notifications, /policies, /credentials'),
    'the matrix row is the v1.6-frozen dependency set',
  );
  // The authority-notes bullet.
  assert.ok(
    matrixSpec.includes('- `/notification-delivery` is the v1.6 Notification Delivery Plane authority'),
    'the matrix authority-notes bullet exists',
  );
  // 047 holds its numeric position (after 046 — the PRE-ASSIGNED numbers;
  // 048/049 are reserved for sibling deliveries).
  const migrations = readdirSync(src('platform', 'db', 'migrations')).filter((n) => n.endsWith('.sql')).sort();
  const position = (name: string) => migrations.indexOf(name);
  assert.ok(position('046_social_accounts.sql') >= 0);
  assert.ok(
    position('046_social_accounts.sql') < position('047_notification_delivery.sql'),
    '047_notification_delivery.sql holds its numeric position after 046',
  );
  assert.ok(!migrations.includes('048_notification_delivery.sql'), '048 is NOT taken by this delivery (reserved for a sibling)');
  // The shared files register the module additively.
  assert.ok(applicationTs.includes('readonly notificationDelivery: NotificationDeliveryModuleApi'), 'ApplicationModules.notificationDelivery');
  assert.ok(applicationTs.includes("from '../modules/notification-delivery/public.ts'"), 'the module public entry import');
  assert.ok(routesTs.includes('registerNotificationDeliveryRoutes(router, services, modules)'), 'routes.ts registers the notification-delivery routes');
  assert.ok(compositionRoot.includes('const notificationDelivery = createNotificationDeliveryModule({'), 'the composition root wires the module');
});

// ---------------------------------------------------------------------------
// 8. The HTTP surface discipline (fail-closed battery encoded)
// ---------------------------------------------------------------------------

test('MKT-068 AC-9 static: the HTTP surface is GET/POST only and the DTOs reject authority fields', () => {
  const routes = stripComments(deliveryRoutes);
  const methods = [...routes.matchAll(/router\.add\(\s*'([A-Z]+)'/g)].map((m) => m[1]!);
  assert.ok(methods.length >= 7, 'the route family is registered');
  for (const method of methods) {
    assert.ok(method === 'GET' || method === 'POST', `only GET/POST routes exist (found ${method})`);
  }
  // No PUT/PATCH/DELETE route exists anywhere in the family.
  assert.ok(!/router\.add\(\s*'(PUT|PATCH|DELETE)'/i.test(routes));
  // The DTO forbidden-key battery rejects the authority fields.
  for (const key of [
    'notificationId', 'deliveryStatus', 'receiptId', 'receipts', 'attemptSeq',
    'outcome', 'providerMessageId', 'policyDecisionId', 'readStatus', 'readAt',
    'readByActor', 'version', 'createdAt', 'updatedAt', 'provenance', 'actor',
    'correlationId', 'causationId',
  ]) {
    assert.ok(routes.includes(`'${key}',`), `the route DTOs reject the authority field '${key}'`);
  }
  // The uniform-404 resolution helper exists (foreign ≡ unknown ≡ malformed).
  assert.ok(routes.includes('requireNotificationInAgency'), 'the notification-scoped routes resolve the record with the uniform 404');
  assert.ok(routes.includes('NotFoundError'), 'the uniform NotFoundError battery is wired');
  // The server-derived provenance composer exists (never a request field).
  assert.ok(routes.includes('function serverProvenance('), 'the server-derived provenance composer exists');
});
