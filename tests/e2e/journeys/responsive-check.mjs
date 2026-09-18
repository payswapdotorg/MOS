/**
 * JOURNEY: responsive/mobile check.
 *
 * Handoff §8 checklist items:
 *   - Responsive/mobile checks (login + Today render, nav usable, no
 *     horizontal overflow catastrophes)
 *
 * Compares viewport 390×844 (mobile) against 1280×800 (desktop). "Overflow
 * catastrophe" is defined OPERATIVALLY (documented in README): the document
 * scroll width exceeding the viewport by more than 32px. Measured overflow is
 * recorded as evidence either way — smaller overflow is an honest finding,
 * not a failure.
 */

import { createRunner, outcome } from '../lib/journey.mjs';
import { uiHealth, uiSignOut } from '../lib/ui.mjs';
import { browserSession, parseEvalResult } from '../lib/browser.mjs';

export const name = 'responsive';
export const checklist = ['Responsive/mobile checks'];
export const requires = ['MOS_E2E_OWNER_*', 'agent-browser'];

const OVERFLOW_TOLERANCE_PX = 32;

async function measureOverflow(browser) {
  const raw = await browser.eval(
    'JSON.stringify({sw: document.documentElement.scrollWidth, iw: window.innerWidth})',
  );
  const parsed = parseEvalResult(raw);
  if (parsed === null || typeof parsed !== 'object' || typeof parsed.sw !== 'number') {
    throw new Error(`overflow measurement failed: ${String(raw).slice(0, 120)}`);
  }
  return { ...parsed, overflow: parsed.sw - parsed.iw };
}

async function checkViewport(steps, browser, env, evidence, label) {
  await browser.setViewport(label.width, label.height);
  await browser.open(env.baseUrl);
  await browser.waitForLoad();
  const loginSnapshot = await browser.snapshot({});
  const loginShot = evidence.screenshotPath(`00-${label.name}-login`);
  await browser.screenshot(loginShot);
  await steps.checkFn(
    `${label.name}: login screen renders`,
    'heading, Sign in tab, email/password form present',
    async () => {
      const pass =
        loginSnapshot.includes('MOS — Marketing Operating System') &&
        /tab "Sign in"/.test(loginSnapshot) &&
        /textbox "Email"/.test(loginSnapshot);
      return { actual: `heading+tabs+form=${pass}`, pass, evidence: [loginShot] };
    },
  );
  const loginOverflow = await measureOverflow(browser);
  await steps.checkFn(
    `${label.name}: login screen has no horizontal overflow catastrophe`,
    `overflow ≤ ${OVERFLOW_TOLERANCE_PX}px`,
    async () => ({
      actual: `overflow=${loginOverflow.overflow}px (scrollWidth ${loginOverflow.sw} / viewport ${loginOverflow.iw})`,
      pass: loginOverflow.overflow <= OVERFLOW_TOLERANCE_PX,
    }),
  );

  await browser.findByLabel('Email', 'fill', env.owner.email);
  await browser.findByLabel('Password', 'fill', env.owner.password);
  await browser.findByRole('button', 'click', { name: 'Sign in' });
  await browser.waitForLoad();
  let signedIn = false;
  for (let attempt = 0; attempt < 10 && !signedIn; attempt += 1) {
    const snapshot = await browser.snapshot({});
    signedIn = /navigation "Primary"/.test(snapshot) || /button "Open navigation"/.test(snapshot);
    if (!signedIn) await browser.wait(1000);
  }
  await steps.check(`${label.name}: sign-in reaches the app shell`, true, async () => signedIn);

  const ccSnapshot = await browser.snapshot({});
  const ccShot = evidence.screenshotPath(`01-${label.name}-command-center`);
  await browser.screenshot(ccShot);
  await steps.checkFn(
    `${label.name}: Today/command center renders`,
    'attention + goals regions present',
    async () => {
      const pass = ccSnapshot.includes('Top attention items') && ccSnapshot.includes('Portfolio goals');
      return {
        actual: `attention=${ccSnapshot.includes('Top attention items')} goals=${ccSnapshot.includes('Portfolio goals')}`,
        pass,
        evidence: [ccShot],
      };
    },
  );
  const ccOverflow = await measureOverflow(browser);
  await steps.checkFn(
    `${label.name}: command center has no horizontal overflow catastrophe`,
    `overflow ≤ ${OVERFLOW_TOLERANCE_PX}px`,
    async () => ({
      actual: `overflow=${ccOverflow.overflow}px (scrollWidth ${ccOverflow.sw} / viewport ${ccOverflow.iw})`,
      pass: ccOverflow.overflow <= OVERFLOW_TOLERANCE_PX,
    }),
  );
  return ccSnapshot;
}

export async function run(ctx) {
  const { env, evidence } = ctx;
  const steps = createRunner(name);
  let error = null;

  let browser = null;
  try {
    browser = browserSession(name, env.browserTimeoutMs);
    const mobile = { name: 'mobile-390x844', width: 390, height: 844 };
    const desktop = { name: 'desktop-1280x800', width: 1280, height: 800 };

    // --- 1. mobile --------------------------------------------------------------
    await checkViewport(steps, browser, env, evidence, mobile);

    // Nav usable on mobile: the drawer opens and a primary destination works.
    await browser.findByRole('button', 'click', { name: 'Open navigation' });
    await browser.wait(800);
    const drawer = await browser.snapshot({});
    const drawerShot = evidence.screenshotPath('02-mobile-nav-drawer-open');
    await browser.screenshot(drawerShot);
    await steps.checkFn(
      'mobile: navigation drawer opens with all primary destinations',
      '"MOS navigation" region with the primary buttons',
      async () => {
        const items = ['Command Center', 'Clients', 'Attention', 'Profit Intelligence', 'Human Work', 'Apps', 'Administration'];
        const missing = items.filter((item) => !drawer.includes(item));
        return {
          actual: missing.length === 0 ? 'all 7 destinations' : `missing: ${missing.join(', ')}`,
          pass: missing.length === 0,
          evidence: [drawerShot],
        };
      },
    );
    await browser.findByRole('button', 'click', { name: 'Clients' });
    await browser.waitForLoad();
    const clientsMobile = await browser.snapshot({});
    const clientsShot = evidence.screenshotPath('03-mobile-clients-navigated');
    await browser.screenshot(clientsShot);
    await steps.checkFn(
      'mobile: navigation is usable (Clients destination renders the portfolio)',
      'clients list renders on the mobile viewport',
      async () => {
        const pass = clientsMobile.includes('Clients') && /Open workspace/.test(clientsMobile);
        return { actual: `clientsRendered=${pass}`, pass, evidence: [clientsShot] };
      },
    );

    const mobileHealth = await uiHealth(browser);
    const mobileHealthPath = evidence.json('04-mobile-browser-health', mobileHealth);
    await steps.checkFn(
      'mobile: zero page errors through login + Today + nav',
      'pageErrors = 0',
      async () => ({
        actual: `pageErrors=${mobileHealth.pageErrors.length}`,
        pass: mobileHealth.pageErrors.length === 0,
        evidence: [mobileHealthPath],
      }),
    );

    // --- 2. desktop comparison (fresh signed-out state in the same session) ----
    await uiSignOut(browser);
    await checkViewport(steps, browser, env, evidence, desktop);
    const desktopHealth = await uiHealth(browser);
    await steps.checkFn(
      'desktop: zero page errors',
      'pageErrors = 0',
      async () => ({ actual: `pageErrors=${desktopHealth.pageErrors.length}`, pass: desktopHealth.pageErrors.length === 0 }),
    );

    await steps.info(
      `overflow measurements recorded for both viewports (tolerance ${OVERFLOW_TOLERANCE_PX}px — smaller overflow is an honest finding, see E2E-RESULTS)`,
    );
  } catch (caught) {
    error = caught;
  } finally {
    if (browser !== null) browser.close();
  }

  return outcome(name, steps.steps, error);
}
