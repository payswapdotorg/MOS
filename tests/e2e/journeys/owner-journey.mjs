/**
 * JOURNEY: owner (+ operator variant) — the agency owner's day surface.
 *
 * Handoff §8 checklist items:
 *   - Owner/operator journey
 *   - Command Center next-action hierarchy (attention + goals + profit)
 *   - Client Operating Workspace (all nine tabs render real data)
 *
 * UI steps drive the live console (agent-browser); API steps verify the same
 * surfaces through the console bridge (fetch). No mocks, no demo-data
 * mutation: the owner persona performs READ-ONLY operations.
 */

import { createRunner, outcome } from '../lib/journey.mjs';
import { firstAgencyId } from '../lib/http.mjs';
import { uiSignIn, uiSignOut, uiHealth, waitForSnapshot } from '../lib/ui.mjs';
import { browserSession, parseEvalResult } from '../lib/browser.mjs';

export const name = 'owner';
export const checklist = ['Owner/operator journey', 'Command Center next-action hierarchy', 'Client Operating Workspace'];
export const requires = ['MOS_E2E_OWNER_*', 'agent-browser', 'MOS_E2E_OPERATOR_* (optional operator variant)'];

const WORKSPACE_TABS = ['Overview', 'Goals', 'Strategy', 'Deployments', 'Workflows', 'Evidence', 'Decisions', 'Learning', 'Memory'];

/**
 * Patch window.fetch inside the console to record every /api/ request's
 * method, URL and HEADER KEY NAMES (never values) — proving the SPA sends
 * only Bearer authorization and no authority fields.
 */
const FETCH_PATCH = `(() => {
  if (window.__mosE2eFetchPatched) return 'already';
  window.__mosE2eRequests = [];
  const original = window.fetch;
  window.fetch = function patchedFetch(input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.includes('/api/')) {
        const headers = new Headers((init && init.headers) || (input && input.headers) || undefined);
        window.__mosE2eRequests.push({
          url: String(url),
          method: (init && init.method) || 'GET',
          headerKeys: Array.from(headers.keys()).sort(),
        });
      }
    } catch (error) { /* recording must never break the app */ }
    return original.apply(this, arguments);
  };
  window.__mosE2eFetchPatched = true;
  return 'patched';
})()`;

async function apiChecks(steps, api, evidence, token, agencyId, label) {
  const commandCenter = await api.get(`reporting/command-center/${agencyId}`, { token });
  evidence.response(`${label}-command-center`, commandCenter);
  await steps.checkFn(
    `${label}: command-center reports the seeded portfolio`,
    '≥ 2 per-client rows, ≥ 2 active goals',
    async () => {
      const perClient = commandCenter.body?.workflowState?.perClient ?? [];
      const active = commandCenter.body?.portfolioGoals?.goalStatusCounts?.active ?? 0;
      const pass = perClient.length >= 2 && active >= 2;
      return { actual: `perClient=${perClient.length} activeGoals=${active}`, pass };
    },
  );

  const attention = await api.get(`ai-operator/${agencyId}/attention-queue`, { token });
  evidence.response(`${label}-attention-queue`, attention);
  await steps.checkFn(
    `${label}: attention queue has ranked items`,
    '≥ 1 item with ranking metadata',
    async () => {
      const items = attention.body?.items ?? [];
      const hasRanking = attention.body?.ranking !== undefined;
      const pass = items.length >= 1 && hasRanking;
      return { actual: `items=${items.length} ranking=${hasRanking}`, pass };
    },
  );

  const profit = await api.get(`profit-intelligence/${agencyId}`, { token });
  evidence.response(`${label}-profit-intelligence`, profit);
  await steps.checkFn(
    `${label}: profit intelligence is derived and readable`,
    'revenue + assumptions present, UI-consumable shape',
    async () => {
      const revenue = profit.body?.revenue ?? null;
      const calc = profit.body?.calculation ?? null;
      const pass = revenue !== null && calc !== null;
      return { actual: `revenue=${JSON.stringify(revenue)?.slice(0, 80)} calculation=${calc === null ? 'null' : 'present'}`, pass };
    },
  );

  const clients = await api.get(`agencies/${agencyId}/clients`, { token });
  const firstClient = clients.body?.clients?.[0];
  await steps.checkFn(
    `${label}: clients list resolves live client records`,
    '≥ 2 clients with ids',
    async () => {
      const count = clients.body?.clients?.length ?? 0;
      const pass = count >= 2 && typeof firstClient?.clientId === 'string';
      return { actual: `clients=${count}`, pass };
    },
  );
  return { firstClient };
}

async function workspaceTabSweep(steps, browser, evidence) {
  // The workspace tablist is UNNAMED in the deployed build's a11y tree
  // (agent-browser 0.38.x renders `- tablist [ref=…]` with no accessible
  // name), so the stable contract-shaped signal is the individual tab roles
  // themselves: `tab "Overview"` … `tab "Memory"`.
  // Each tab is checked SOFT (recorded, non-aborting): a render failure on
  // one tab must not hide the render results of the remaining tabs.
  const tabsList = await browser.snapshot({});
  await steps.checkFn(
    'workspace renders all nine tabs',
    `tabs: ${WORKSPACE_TABS.join('/')}`,
    async () => {
      const missing = WORKSPACE_TABS.filter((tab) => !new RegExp(`tab "${tab}"`).test(tabsList));
      return { actual: missing.length === 0 ? 'all nine tabs' : `missing: ${missing.join(', ')}`, pass: missing.length === 0 };
    },
  );
  for (const tab of WORKSPACE_TABS) {
    await browser.findByRole('tab', 'click', { name: tab });
    await browser.wait(600);
    const panel = await browser.snapshot({});
    const panelError = /An error occurred|Application error|Unhandled Runtime Error/i.test(panel);
    const shotPath = evidence.screenshotPath(`workspace-tab-${tab.toLowerCase()}`);
    await browser.screenshot(shotPath);
    await steps.checkSoft(
      `workspace tab ${tab} renders real content`,
      'tab panel renders without an error boundary',
      async () => ({
        actual: panelError ? 'error boundary detected' : `panel length=${panel.length} chars`,
        pass: !panelError && panel.length > 200,
        evidence: [shotPath],
      }),
    );
  }
}

export async function run(ctx) {
  const { env, api, evidence, shared } = ctx;
  const steps = createRunner(name);
  let error = null;

  let browser = null;
  try {
    // --- 1. API ground truth through the console bridge (owner persona) ------
    const owner = await api.login(env.owner.email, env.owner.password);
    const context = await api.get('auth/authorization-context', { token: owner.token });
    const agencyId = firstAgencyId(context.body);
    evidence.response('00-owner-authorization-context', context);
    await steps.checkFn(
      'owner signs in through the real credential contract',
      '200 with a Bearer session',
      async () => ({ actual: 'Bearer session opened', pass: typeof owner.token === 'string' }),
    );
    shared.demoAgencyId = agencyId;
    const { firstClient } = await apiChecks(steps, api, evidence, owner.token, agencyId, 'owner');
    shared.demoClientId = firstClient.clientId;

    // --- 2. UI: sign in (real form), command center renders the hierarchy ----
    browser = browserSession(name, env.browserTimeoutMs);
    await uiSignIn(browser, env.baseUrl, { email: env.owner.email, password: env.owner.password });

    // Demo/real presentation separation: Casey (.demo) carries the badge.
    const demoBadgeRaw = await browser.eval(
      'document.body.innerText.includes("Demo — pre-seeded data")',
    );
    await steps.checkFn(
      'owner (.demo persona) renders the demo badge (presentation-only hint)',
      'document body contains "Demo — pre-seeded data"',
      async () => ({
        actual: `demoBadge=${demoBadgeRaw.trim()}`,
        pass: demoBadgeRaw.trim() === 'true',
      }),
    );

    const commandCenterSnapshot = await browser.snapshot({});
    const ccPath = evidence.screenshotPath('01-owner-command-center');
    await browser.screenshot(ccPath);
    evidence.text('01-owner-command-center-tree', commandCenterSnapshot);
    await steps.checkFn(
      'Today/command center renders attention + goals + profit entry',
      'attention items, portfolio goals and a profit surface are present',
      async () => {
        const has = (needle) => commandCenterSnapshot.includes(needle);
        const pass = has('Top attention items') && has('Portfolio goals') && /Profit Intelligence/.test(commandCenterSnapshot);
        return {
          actual: `attention=${has('Top attention items')} goals=${has('Portfolio goals')} profit=${/Profit Intelligence/.test(commandCenterSnapshot)}`,
          pass,
          evidence: [ccPath],
        };
      },
    );

    // --- 3. transport proof: the console sends only Bearer, no authority -----
    await browser.eval(FETCH_PATCH);
    // Navigate to surfaces Today has NOT already mounted. The Today/command
    // center view itself mounts useCommandCenter + useAttentionQueue +
    // useProfitAgency (verified in console/src/components/mos/command-center.tsx),
    // so re-visiting Attention/Profit serves the react-query cache and records
    // nothing. Clients + Apps guarantee fresh /api/ traffic on every run.
    await browser.findByRole('button', 'click', { name: 'Clients' });
    await browser.waitForLoad();
    await browser.findByRole('button', 'click', { name: 'Apps' });
    await browser.waitForLoad();
    const requestsJson = await browser.eval('JSON.stringify(window.__mosE2eRequests || [])');
    const apiRequests = parseEvalResult(requestsJson);
    const transportPath = evidence.json('02-console-transport-requests', apiRequests, 'header KEY NAMES only — values never recorded');
    await steps.checkFn(
      'console transport carries only Bearer (no client-side authority fields)',
      'every /api/ request: header keys ⊆ {authorization, content-type}',
      async () => {
        const offenders = apiRequests.filter(
          (request) => request.headerKeys.some((key) => !['authorization', 'content-type', 'accept'].includes(key.toLowerCase())),
        );
        const hasBearer = apiRequests.every((request) => request.headerKeys.includes('authorization'));
        const pass = offenders.length === 0 && hasBearer && apiRequests.length >= 2;
        return {
          actual: `requests=${apiRequests.length} offenders=${offenders.length} allBearer=${hasBearer}`,
          pass,
          evidence: [transportPath],
        };
      },
    );

    // --- 4. UI: open a client workspace, sweep all nine tabs ------------------
    await browser.findByRole('button', 'click', { name: 'Clients' });
    await browser.waitForLoad();
    const clientsSnapshot = await browser.snapshot({});
    const clientsShot = evidence.screenshotPath('03-owner-clients');
    await browser.screenshot(clientsShot);
    await steps.checkFn(
      'Clients list shows the live portfolio',
      'seeded client names render with an Open workspace affordance',
      async () => {
        const pass =
          clientsSnapshot.includes('Helio Robotics') &&
          clientsSnapshot.includes('Atlas Freight Systems') &&
          clientsSnapshot.includes('Open workspace');
        return { actual: `helio=${clientsSnapshot.includes('Helio Robotics')} atlas=${clientsSnapshot.includes('Atlas Freight Systems')}`, pass, evidence: [clientsShot] };
      },
    );
    // Click the first "Open workspace" button (Helio Robotics is first in the list).
    await browser.findByRole('button', 'click', { name: 'Open workspace' });
    await browser.waitForLoad();
    // Bounded poll for the workspace signal (view-transition race guard); the
    // final tree is recorded as evidence either way (load-stall diagnosis).
    const ws = await waitForSnapshot(
      browser,
      (text) => /tab "Overview"/.test(text) && text.includes('Helio Robotics'),
      { evidence, name: '04-workspace-final-tree' },
    );
    const wsShot = evidence.screenshotPath('04-owner-workspace-open');
    await browser.screenshot(wsShot);
    await steps.checkFn(
      'client workspace opens',
      'heading = client name, tab strip present',
      async () => {
        const hasName = ws.includes('Helio Robotics');
        const hasOverviewTab = /tab "Overview"/.test(ws);
        const pass = hasName && hasOverviewTab;
        return {
          actual: pass ? 'workspace open' : `clientName=${hasName} overviewTab=${hasOverviewTab}; snapshot head: ${ws.slice(0, 120)}`,
          pass,
          evidence: [wsShot],
        };
      },
    );
    await workspaceTabSweep(steps, browser, evidence);

    // --- 5. zero page errors through the whole session ------------------------
    const health = await uiHealth(browser);
    const healthPath = evidence.json('05-owner-browser-health', health);
    await steps.checkFn(
      'owner UI session has zero page errors',
      'pageErrors = 0',
      async () => ({
        actual: `pageErrors=${health.pageErrors.length} consoleLines=${health.console ? health.console.split('\n').length : 0}`,
        pass: health.pageErrors.length === 0,
        note: health.console || null,
        evidence: [healthPath],
      }),
    );

    // --- 6. sign out -----------------------------------------------------------
    await uiSignOut(browser);
    await steps.info('owner signed out through the account menu (session revoked)');

    // --- 7. operator variant (Jordan) — same agency data through the UI -------
    if (env.operator !== undefined) {
      const operator = await api.login(env.operator.email, env.operator.password);
      await apiChecks(steps, api, evidence, operator.token, agencyId, 'operator');
      await uiSignIn(browser, env.baseUrl, { email: env.operator.email, password: env.operator.password });
      const operatorSnapshot = await browser.snapshot({});
      const operatorShot = evidence.screenshotPath('06-operator-command-center');
      await browser.screenshot(operatorShot);
      await steps.checkFn(
        'operator (Jordan) sees the same agency command center',
        'attention + goals render for the operator membership',
        async () => ({
          actual: `attention=${operatorSnapshot.includes('Top attention items')} goals=${operatorSnapshot.includes('Portfolio goals')}`,
          pass: operatorSnapshot.includes('Top attention items') && operatorSnapshot.includes('Portfolio goals'),
          evidence: [operatorShot],
        }),
      );
      const operatorHealth = await uiHealth(browser);
      await steps.checkFn(
        'operator UI session has zero page errors',
        'pageErrors = 0',
        async () => ({
          actual: `pageErrors=${operatorHealth.pageErrors.length}`,
          pass: operatorHealth.pageErrors.length === 0,
        }),
      );
      await uiSignOut(browser);
    } else {
      await steps.info('operator variant skipped (MOS_E2E_OPERATOR_* not set)');
    }
  } catch (caught) {
    error = caught;
  } finally {
    if (browser !== null) browser.close();
  }

  return outcome(name, steps.steps, error);
}
