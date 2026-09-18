/**
 * JOURNEY: app lifecycle (discover → install → upgrade → rollback) on a
 * THROWAWAY tenant's own workspace.
 *
 * Handoff §8 checklist items:
 *   - App install/upgrade/rollback journey (append-oriented ledger,
 *     immutable published versions, duplicate 409, MKT-048 re-selection rule)
 *   - App Marketplace/Installed surfaces (4 MOS_CERTIFIED first-party packs)
 *
 * Every mutation happens inside the throwaway tenant (client + workspace
 * created through the real contracts). The demo agency is untouched.
 */

import { createRunner, outcome } from '../lib/journey.mjs';
import { uiSignIn, uiHealth } from '../lib/ui.mjs';
import { browserSession } from '../lib/browser.mjs';
import { ensureThrowaway, ensureThrowawayClient } from '../lib/throwaway.mjs';

export const name = 'app-lifecycle';
export const checklist = ['App install/upgrade/rollback journey', 'App Marketplace/Installed surfaces'];
export const requires = ['agent-browser (marketplace + installed render proof)'];

const WORKSPACE_NAME = 'E2E Lifecycle Workspace';

export async function run(ctx) {
  const { env, api, evidence, shared } = ctx;
  const steps = createRunner(name);
  let error = null;

  let browser = null;
  try {
    // --- 1. throwaway tenant + client + workspace (real contracts) ------------
    await ensureThrowaway(shared, api, evidence, steps);
    const { token, agencyId, clientId } = await ensureThrowawayClient(
      shared,
      api,
      evidence,
      steps,
      'E2E Lifecycle Client',
    );

    const workspace = await api.post(`clients/${clientId}/workspaces`, {
      token,
      body: { name: WORKSPACE_NAME },
    });
    evidence.response('00-create-workspace', workspace);
    const workspaceId = workspace.body?.workspaceId;
    await steps.checkFn(
      'workspace created through the real contract',
      'HTTP 201 with workspaceId',
      async () => ({
        actual: `HTTP ${workspace.status} id=${String(workspaceId).slice(0, 13)}…`,
        pass: workspace.status === 201 && typeof workspaceId === 'string',
      }),
    );
    shared.throwaway.workspaceId = workspaceId;

    // --- 2. marketplace discovery ----------------------------------------------
    const marketplace = await api.get(`app-marketplace/${agencyId}/apps`, { token });
    evidence.response('01-marketplace-listing', marketplace);
    const apps = marketplace.body?.apps ?? [];
    const certified = apps.filter((app) => app?.trustState?.trustLevel === 'MOS_CERTIFIED');
    const portal = apps.find((app) => app.appKey === 'mos-portal');
    await steps.checkFn(
      'marketplace lists the 4 first-party packs, all MOS_CERTIFIED',
      '4 apps, 4 MOS_CERTIFIED, mos-portal present with 1.0.0 + 1.1.0',
      async () => {
        const versions = (portal?.versions ?? []).map((version) => version.version).sort();
        const hasBoth = versions.includes('1.0.0') && versions.includes('1.1.0');
        const pass = apps.length === 4 && certified.length === 4 && portal !== undefined && hasBoth;
        return { actual: `apps=${apps.length} certified=${certified.length} portalVersions=${versions.join(',')}`, pass };
      },
    );

    // --- 3. install → upgrade → rollback (the real selection contracts) --------
    const install = await api.post(`workspaces/${workspaceId}/app-installs`, {
      token,
      body: { appKey: 'mos-portal', version: '1.0.0', idempotencyKey: `e2e-install-${workspaceId}` },
    });
    evidence.response('02-install-mos-portal-1.0.0', install);
    const installRow = install.body?.install;
    await steps.checkFn(
      'install mos-portal@1.0.0 → 201, ACTIVE selection, seq 1',
      '201; install ACTIVE @1.0.0; selectionSeq 1',
      async () => ({
        actual: `HTTP ${install.status} v${String(installRow?.version)} ${String(installRow?.status)} seq=${String(installRow?.selectionSeq)}`,
        pass:
          install.status === 201 &&
          installRow?.version === '1.0.0' &&
          installRow?.status === 'ACTIVE' &&
          installRow?.selectionSeq === 1,
      }),
    );

    const upgrade = await api.post(`workspaces/${workspaceId}/app-installs/${installRow.installId}/upgrade`, {
      token,
      body: { version: '1.1.0', idempotencyKey: `e2e-upgrade-${workspaceId}` },
    });
    evidence.response('03-upgrade-mos-portal-1.1.0', upgrade);
    const upgradeRow = upgrade.body?.install;
    await steps.checkFn(
      'upgrade → 201, new ACTIVE selection @1.1.0, prior superseded (append-oriented)',
      '201; seq 2 @1.1.0; prior.version 1.0.0',
      async () => ({
        actual: `HTTP ${upgrade.status} v${String(upgradeRow?.version)} seq=${String(upgradeRow?.selectionSeq)} prior=${String(upgrade.body?.prior?.version)}`,
        pass:
          upgrade.status === 201 &&
          upgradeRow?.version === '1.1.0' &&
          upgradeRow?.selectionSeq === 2 &&
          upgrade.body?.prior?.version === '1.0.0',
      }),
    );

    const rollback = await api.post(`workspaces/${workspaceId}/app-installs/${upgradeRow.installId}/rollback`, {
      token,
      body: { targetInstallId: installRow.installId, idempotencyKey: `e2e-rollback-${workspaceId}` },
    });
    evidence.response('04-rollback-to-1.0.0', rollback);
    const rollbackRow = rollback.body?.install;
    await steps.checkFn(
      'rollback reselects the previously installed version → 201, ACTIVE @1.0.0',
      '201; seq 3 @1.0.0; prior.version 1.1.0',
      async () => ({
        actual: `HTTP ${rollback.status} v${String(rollbackRow?.version)} seq=${String(rollbackRow?.selectionSeq)} prior=${String(rollback.body?.prior?.version)}`,
        pass:
          rollback.status === 201 &&
          rollbackRow?.version === '1.0.0' &&
          rollbackRow?.selectionSeq === 3 &&
          rollback.body?.prior?.version === '1.1.0',
      }),
    );

    // --- 4. negative contracts: duplicate 409 + MKT-048 re-upgrade 422 ---------
    const duplicate = await api.post(`workspaces/${workspaceId}/app-installs`, {
      token,
      body: { appKey: 'mos-portal', version: '1.0.0', idempotencyKey: `e2e-duplicate-${workspaceId}` },
    });
    evidence.response('05-duplicate-install', duplicate);
    await steps.checkFn(
      'duplicate install → 409 (one selection lineage per app per workspace)',
      'HTTP 409 CONFLICT',
      async () => ({
        actual: `HTTP ${duplicate.status} code ${String(duplicate.body?.error?.code)}`,
        pass: duplicate.status === 409 && duplicate.body?.error?.code === 'CONFLICT',
      }),
    );

    const reupgrade = await api.post(`workspaces/${workspaceId}/app-installs/${rollbackRow.installId}/upgrade`, {
      token,
      body: { version: '1.1.0', idempotencyKey: `e2e-reupgrade-${workspaceId}` },
    });
    evidence.response('06-reupgrade-rejected', reupgrade);
    await steps.checkFn(
      'upgrade to a previously installed version → 422 with the honest MKT-048 reason',
      'HTTP 422 INVALID_REQUEST; message names rollback reselection',
      async () => ({
        actual: `HTTP ${reupgrade.status} code ${String(reupgrade.body?.error?.code)}`,
        pass:
          reupgrade.status === 422 &&
          reupgrade.body?.error?.code === 'INVALID_REQUEST' &&
          /rollback/i.test(String(reupgrade.body?.error?.message)),
        note: String(reupgrade.body?.error?.message ?? '').slice(0, 200),
      }),
    );

    // --- 5. the ledger: full append-oriented history ----------------------------
    const ledger = await api.get(`workspaces/${workspaceId}/app-installs`, { token });
    evidence.response('07-install-ledger', ledger);
    await steps.checkFn(
      'ledger preserves the full selection history (seq 1/2/3, install/upgrade/rollback)',
      '3 rows: install 1.0.0 SUPERSEDED, upgrade 1.1.0 SUPERSEDED, rollback 1.0.0 ACTIVE',
      async () => {
        const rows = ledger.body?.installs ?? [];
        const ops = rows.map((row) => `${row.selectionSeq}:${row.operation}@${row.version}:${row.status}`);
        const current = ledger.body?.currentSelections ?? [];
        const expectedOps = [
          '1:install@1.0.0:SUPERSEDED',
          '2:upgrade@1.1.0:SUPERSEDED',
          '3:rollback@1.0.0:ACTIVE',
        ];
        const pass = JSON.stringify(ops) === JSON.stringify(expectedOps) && current.length === 1;
        return { actual: `${ops.join(' | ')} current=${current.length}`, pass };
      },
    );

    // --- 6. UI render proof: marketplace + installed ledger in the console ------
    if (!env.skipUi) {
      browser = browserSession(name, env.browserTimeoutMs);
      await uiSignIn(browser, env.baseUrl, shared.throwaway);
      await browser.findByRole('button', 'click', { name: 'Apps' });
      await browser.waitForLoad();
      await browser.findByRole('tab', 'click', { name: 'Marketplace' });
      await browser.waitForLoad();
      await browser.wait(700);
      const marketplaceUi = await browser.snapshot({});
      const marketShot = evidence.screenshotPath('08-ui-marketplace-4-certified');
      await browser.screenshot(marketShot);
      const certifiedCount = (marketplaceUi.match(/MOS_CERTIFIED/g) ?? []).length;
      await steps.checkFn(
        'UI: marketplace renders the 4 MOS_CERTIFIED first-party packs',
        '"MOS_CERTIFIED" appears ≥ 4 times with the app keys',
        async () => {
          const keys = ['mos-portal', 'mos-sheets', 'mos-crm', 'mos-analytics'].filter((key) =>
            marketplaceUi.includes(key),
          );
          return {
            actual: `certifiedLabels=${certifiedCount} appKeys=${keys.length}/4`,
            pass: certifiedCount >= 4 && keys.length === 4,
            evidence: [marketShot],
          };
        },
      );

      // Installed tab for the lifecycle workspace: select client (auto, single
      // client) + workspace, then assert the ledger renders.
      await browser.findByRole('tab', 'click', { name: 'Installed' });
      await browser.waitForLoad();
      await browser.findByRole('combobox', 'click', { name: 'Workspace' });
      await browser.wait(700);
      await browser.findByRole('option', 'click', { name: WORKSPACE_NAME });
      await browser.waitForLoad();
      await browser.wait(700);
      const installedUi = await browser.snapshot({});
      const installedShot = evidence.screenshotPath('09-ui-installed-ledger');
      await browser.screenshot(installedShot);
      await steps.checkFn(
        'UI: Installed tab renders the 3-row selection ledger with historical version identity',
        '"3 install rows" + historical version identity note render',
        async () => {
          const rows = /3 install rows/.test(installedUi);
          const history = /historical version identity preserved/i.test(installedUi);
          return { actual: `rows=${rows} historyNote=${history}`, pass: rows && history, evidence: [installedShot] };
        },
      );

      const health = await uiHealth(browser);
      const healthPath = evidence.json('10-app-lifecycle-browser-health', health);
      await steps.checkFn(
        'app-lifecycle UI session has zero page errors',
        'pageErrors = 0',
        async () => ({
          actual: `pageErrors=${health.pageErrors.length}`,
          pass: health.pageErrors.length === 0,
          evidence: [healthPath],
        }),
      );
    } else {
      await steps.info('UI render proof skipped (MOS_E2E_SKIP_UI=1)');
    }
  } catch (caught) {
    error = caught;
  } finally {
    if (browser !== null) browser.close();
  }

  return outcome(name, steps.steps, error);
}
