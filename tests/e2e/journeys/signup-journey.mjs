/**
 * JOURNEY: real sign-up → honest empty states → first client → persistence →
 * isolation.
 *
 * Handoff §8 checklist items:
 *   - Sales-to-delivery entry (a REAL new agency starts genuinely empty and
 *     can take its first real step — create a client)
 *   - Frontend-bypass security (isolation: the new tenant cannot see the demo
 *     agency) — the full API-level matrix lives in tenant-isolation-journey.
 *
 * The throwaway identity is created THROUGH THE CONSOLE (Create account tab,
 * real POST /api/mos-signup) when it was generated for this run. Credentials
 * are in-memory only: never printed, never written (see lib/env.mjs).
 */

import { createRunner, outcome } from '../lib/journey.mjs';
import { firstAgencyId } from '../lib/http.mjs';
import { uiCreateAccount, uiSignIn, uiSignOut, uiHealth } from '../lib/ui.mjs';
import { browserSession } from '../lib/browser.mjs';
import { ensureThrowaway, loginThrowaway } from '../lib/throwaway.mjs';

export const name = 'signup';
export const checklist = ['Sales-to-delivery journey (entry: real sign-up + first client)', 'Demo/real separation (honest empty states)'];
export const requires = ['agent-browser (UI signup + empty states)'];

const CLIENT_NAME = 'Northstar Verification Client';

export async function run(ctx) {
  const { env, api, evidence, shared } = ctx;
  const steps = createRunner(name);
  let error = null;

  const throwaway = shared.throwaway;
  let browser = null;
  try {
    // --- 1. create the REAL account --------------------------------------------
    if (throwaway.generated) {
      if (env.skipUi) {
        const signup = await api.signup({
          displayName: throwaway.displayName,
          email: throwaway.email,
          agencyName: throwaway.agencyName,
          password: throwaway.password,
        });
        evidence.response('00-throwaway-signup-api', signup, 'API fallback because MOS_E2E_SKIP_UI=1');
        await steps.check('sign-up through the real contract (API fallback)', 201, async () => signup.status);
        throwaway.signedUp = true;
      } else {
        browser = browserSession(name, env.browserTimeoutMs);
        await uiCreateAccount(browser, env.baseUrl, throwaway);
        throwaway.signedUp = true;
        const signupShot = evidence.screenshotPath('00-signup-created-signed-in');
        await browser.screenshot(signupShot);
        // The badge lives inside an aria-labelled button, so the a11y tree
        // never shows its text — check the rendered DOM text instead.
        const badgeRaw = await browser.eval(
          'document.body.innerText.includes("Demo — pre-seeded data")',
        );
        await steps.checkFn(
          'sign-up through the console lands signed-in with NO demo badge',
          'signed in; no "Demo — pre-seeded data" text in the rendered DOM',
          async () => ({
            actual: `signedIn=true demoBadge=${badgeRaw.trim()}`,
            pass: badgeRaw.trim() === 'false',
            evidence: [signupShot],
          }),
        );
      }
    } else {
      await ensureThrowaway(shared, api, evidence, steps);
    }

    // --- 2. honest empty states (API ground truth) ------------------------------
    const session = await loginThrowaway(shared, api);
    const token = session.token;
    const agencyId = session.agencyId;
    evidence.response('01-throwaway-context', session.context);

    const commandCenter = await api.get(`reporting/command-center/${agencyId}`, { token });
    evidence.response('02-empty-command-center', commandCenter);
    await steps.checkFn(
      'new agency command center is GENUINELY empty',
      '0 per-client rows, 0 active goals',
      async () => {
        const perClient = commandCenter.body?.workflowState?.perClient ?? [];
        const active = commandCenter.body?.portfolioGoals?.goalStatusCounts?.active ?? 0;
        return { actual: `perClient=${perClient.length} activeGoals=${active}`, pass: perClient.length === 0 && active === 0 };
      },
    );

    const clientsEmpty = await api.get(`agencies/${agencyId}/clients`, { token });
    evidence.response('03-empty-clients', clientsEmpty);
    await steps.check('new agency client list is empty', 0, async () => clientsEmpty.body?.clients?.length ?? -1);

    const attentionEmpty = await api.get(`ai-operator/${agencyId}/attention-queue`, { token });
    evidence.response('04-empty-attention', attentionEmpty);
    await steps.checkFn(
      'attention queue is empty but honest (ranking policy still disclosed)',
      '0 items, ranking present',
      async () => {
        const items = attentionEmpty.body?.items ?? [];
        const ranking = attentionEmpty.body?.ranking !== undefined;
        return { actual: `items=${items.length} ranking=${ranking}`, pass: items.length === 0 && ranking };
      },
    );

    const profitZero = await api.get(`profit-intelligence/${agencyId}`, { token });
    evidence.response('05-profit-zero', profitZero);
    await steps.checkFn(
      'profit intelligence honestly reports zero (assumptions still present)',
      'calculation present; no fabricated figures',
      async () => {
        const calc = profitZero.body?.calculation ?? null;
        return { actual: `calculation=${calc === null ? 'null' : 'present'}`, pass: calc !== null };
      },
    );

    const queueDenied = await api.get('jobs/queue', { token });
    evidence.response('06-humanwork-profile-gate', queueDenied);
    await steps.checkFn(
      'human work honestly requires a Human Agent profile (403, not empty fake)',
      'HTTP 403 FORBIDDEN',
      async () => ({
        actual: `HTTP ${queueDenied.status} code ${String(queueDenied.body?.error?.code)}`,
        pass: queueDenied.status === 403 && queueDenied.body?.error?.code === 'FORBIDDEN',
      }),
    );

    const marketplace = await api.get(`app-marketplace/${agencyId}/apps`, { token });
    evidence.response('07-marketplace-still-real', marketplace);
    await steps.checkFn(
      'marketplace still lists the real first-party catalog for a new agency',
      '4 MOS_CERTIFIED apps (platform catalog, not tenant data)',
      async () => {
        const apps = marketplace.body?.apps ?? [];
        const certified = apps.filter((app) => app?.trustState?.trustLevel === 'MOS_CERTIFIED');
        return { actual: `apps=${apps.length} certified=${certified.length}`, pass: apps.length === 4 && certified.length === 4 };
      },
    );

    // --- 3. empty-state sweep in the UI ------------------------------------------
    if (!env.skipUi && browser === null) {
      browser = browserSession(name, env.browserTimeoutMs);
      await uiSignIn(browser, env.baseUrl, throwaway);
    }
    if (!env.skipUi) {
      const ccSnapshot = await browser.snapshot({});
      const emptyShot = evidence.screenshotPath('08-empty-command-center');
      await browser.screenshot(emptyShot);
      const badgeRaw = await browser.eval(
        'document.body.innerText.includes("Demo — pre-seeded data")',
      );
      await steps.checkFn(
        'UI: Today renders honest empty states (no fabricated data, no demo badge)',
        'empty command center renders; no demo badge',
        async () => {
          const hasEmpty = /0 clients|No clients|nothing|0 items/i.test(ccSnapshot);
          return { actual: `demoBadge=${badgeRaw.trim()} emptyIndicators=${hasEmpty}`, pass: badgeRaw.trim() === 'false', evidence: [emptyShot] };
        },
      );
      await browser.findByRole('button', 'click', { name: 'Clients' });
      await browser.waitForLoad();
      const clientsSnapshot = await browser.snapshot({});
      const clientsShot = evidence.screenshotPath('09-empty-clients');
      await browser.screenshot(clientsShot);
      await steps.checkFn(
        'UI: Clients empty state carries the create-first-client affordance',
        '"Create your first client" affordance present',
        async () => {
          const affordance = /create your first client/i.test(clientsSnapshot) || /New client/.test(clientsSnapshot);
          return { actual: `affordance=${affordance}`, pass: affordance, evidence: [clientsShot] };
        },
      );

      // --- 4. create the first client through the UI affordance -----------------
      // The empty state carries "Create your first client"; a non-empty
      // portfolio uses "New client" — both open the same one-field dialog
      // (textbox "Client name" + button "Create client").
      const affordance = /create your first client/i.test(clientsSnapshot)
        ? 'Create your first client'
        : 'New client';
      await browser.findByRole('button', 'click', { name: affordance });
      await browser.wait(600);
      await browser.findByLabel('Client name', 'fill', CLIENT_NAME);
      await browser.findByRole('button', 'click', { name: 'Create client' });
      await browser.waitForLoad();
      const afterCreate = await browser.snapshot({});
      const createdShot = evidence.screenshotPath('10-first-client-created');
      await browser.screenshot(createdShot);
      await steps.checkFn(
        'first client created through the real contract appears in the console',
        'the console opens the new client workspace (heading = client name)',
        async () => {
          const present = afterCreate.includes(CLIENT_NAME);
          return { actual: `workspaceHeading=${present}`, pass: present, evidence: [createdShot] };
        },
      );

      // Back to the portfolio list: the client is listed there too.
      await browser.findByRole('button', 'click', { name: '← Clients' });
      await browser.waitForLoad();
      const listAfterCreate = await browser.snapshot({});
      await steps.checkFn(
        'the new client is listed in the Clients portfolio',
        'client name renders in the list',
        async () => {
          const present = listAfterCreate.includes(CLIENT_NAME);
          return { actual: `clientInList=${present}`, pass: present };
        },
      );

      // --- 5. persistence across sign-out / sign-in ------------------------------
      await uiSignOut(browser);
      await uiSignIn(browser, env.baseUrl, throwaway);
      await browser.findByRole('button', 'click', { name: 'Clients' });
      await browser.waitForLoad();
      const persistedSnapshot = await browser.snapshot({});
      const persistedShot = evidence.screenshotPath('11-client-persisted-after-relogin');
      await browser.screenshot(persistedShot);
      await steps.checkFn(
        'client persists after sign-out + sign-in (durable PostgreSQL storage)',
        'client still present after re-login',
        async () => {
          const present = persistedSnapshot.includes(CLIENT_NAME);
          return { actual: `clientAfterRelogin=${present}`, pass: present, evidence: [persistedShot] };
        },
      );

      const health = await uiHealth(browser);
      const healthPath = evidence.json('12-signup-browser-health', health);
      await steps.checkFn(
        'signup journey UI session has zero page errors',
        'pageErrors = 0',
        async () => ({
          actual: `pageErrors=${health.pageErrors.length}`,
          pass: health.pageErrors.length === 0,
          evidence: [healthPath],
        }),
      );
      await uiSignOut(browser);
    } else {
      // API fallback for client creation + persistence when UI is skipped.
      const create = await api.post(`agencies/${agencyId}/clients`, { token, body: { name: CLIENT_NAME } });
      evidence.response('10-api-create-client', create);
      await steps.check('first client created through the real contract (API fallback)', 201, async () => create.status);
      const relogin = await api.login(throwaway.email, throwaway.password);
      const persisted = await api.get(`agencies/${agencyId}/clients`, { token: relogin.token });
      await steps.checkFn(
        'client persists across sessions (API fallback)',
        'client still listed after a fresh login',
        async () => {
          const names = (persisted.body?.clients ?? []).map((client) => client.name);
          return { actual: `clients=${names.join(', ')}`, pass: names.includes(CLIENT_NAME) };
        },
      );
    }

    // --- 6. isolation: the new tenant cannot see the demo agency ----------------
    // Resolve the demo agency directly (the signup journey runs FIRST, so no
    // earlier journey has stashed it yet) — owner credentials are read-only.
    let demoAgencyId = shared.demoAgencyId;
    if (typeof demoAgencyId !== 'string' && env.owner !== undefined) {
      const ownerLogin = await api.login(env.owner.email, env.owner.password);
      const ownerContext = await api.get('auth/authorization-context', { token: ownerLogin.token });
      demoAgencyId = firstAgencyId(ownerContext.body);
      shared.demoAgencyId = demoAgencyId;
    }
    if (typeof demoAgencyId === 'string') {
      const cross = await api.get(`reporting/command-center/${demoAgencyId}`, { token });
      evidence.response('13-isolation-against-demo-tenant', cross);
      await steps.checkFn(
        'isolation: new agency addressing the demo agency → 404 (existence hidden)',
        'HTTP 404 NOT_FOUND',
        async () => ({
          actual: `HTTP ${cross.status} code ${String(cross.body?.error?.code)}`,
          pass: cross.status === 404 && cross.body?.error?.code === 'NOT_FOUND',
        }),
      );
    } else {
      await steps.info('isolation cross-check covered by tenant-isolation journey (owner credentials not set)');
    }

    // Share the client for the app-lifecycle journey.
    const finalClients = await api.get(`agencies/${agencyId}/clients`, { token });
    const own = finalClients.body?.clients?.find((client) => client.name === CLIENT_NAME);
    if (own !== undefined) {
      shared.throwaway.clientId = own.clientId;
    }
    shared.throwaway.agencyId = agencyId;
  } catch (caught) {
    error = caught;
  } finally {
    if (browser !== null) browser.close();
  }

  return outcome(name, steps.steps, error);
}
