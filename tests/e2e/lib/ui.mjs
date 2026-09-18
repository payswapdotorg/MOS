/**
 * E2E harness shared UI flows (VER-001) — deterministic console drives.
 *
 * These helpers use semantic locators (find role/label) rather than snapshot
 * refs wherever possible: refs are stable per page load but change on
 * navigation, while roles/labels survive re-runs.
 */

import { pageErrorsFrom } from './browser.mjs';

async function openConsole(browser, baseUrl) {
  await browser.open(baseUrl);
  await browser.waitForLoad();
}

/**
 * Sign in through the REAL credential form (email + password) — not the demo
 * quick-login panel — so the journey exercises the production auth contract.
 */
async function uiSignIn(browser, baseUrl, { email, password }) {
  await openConsole(browser, baseUrl);
  // The login screen is the default signed-out surface.
  await browser.findByLabel('Email', 'fill', email);
  await browser.findByLabel('Password', 'fill', password);
  await browser.findByRole('button', 'click', { name: 'Sign in' });
  await browser.waitForLoad();
  // Signed-in shell signal: the primary navigation renders.
  let found = false;
  for (let attempt = 0; attempt < 10 && !found; attempt += 1) {
    const snapshot = await browser.snapshot({});
    found = /navigation "Primary"/.test(snapshot) || /button "Open navigation"/.test(snapshot);
    if (!found) await browser.wait(1000);
  }
  if (!found) {
    throw new Error('sign-in did not reach the app shell (primary navigation not found)');
  }
}

/** Sign out through the account menu. */
async function uiSignOut(browser) {
  await browser.findByRole('button', 'click', { name: 'Account menu' });
  await browser.wait(500);
  await browser.findByRole('menuitem', 'click', { name: 'Sign out' });
  await browser.waitForLoad();
  // Signed-out signal: the Sign in tab is back.
  let found = false;
  for (let attempt = 0; attempt < 10 && !found; attempt += 1) {
    const snapshot = await browser.snapshot({});
    found = /tab "Sign in"/.test(snapshot);
    if (!found) await browser.wait(1000);
  }
  if (!found) {
    throw new Error('sign-out did not return to the login screen');
  }
}

/** Create a REAL account through the console's Create account tab. */
async function uiCreateAccount(browser, baseUrl, { displayName, email, agencyName, password }) {
  await openConsole(browser, baseUrl);
  await browser.findByRole('tab', 'click', { name: 'Create account' });
  await browser.findByLabel('Your name', 'fill', displayName);
  await browser.findByLabel('Work email', 'fill', email);
  await browser.findByLabel('Agency name', 'fill', agencyName);
  await browser.findByLabel('Password (≥ 12 characters)', 'fill', password);
  await browser.findByLabel('Confirm password', 'fill', password);
  await browser.findByRole('button', 'click', { name: 'Create account' });
  await browser.waitForLoad();
  let found = false;
  for (let attempt = 0; attempt < 12 && !found; attempt += 1) {
    const snapshot = await browser.snapshot({});
    found = /navigation "Primary"/.test(snapshot) || /button "Open navigation"/.test(snapshot);
    if (!found) await browser.wait(1000);
  }
  if (!found) {
    throw new Error('account creation did not reach the app shell');
  }
}

/** Capture page errors + console output (evidence + health check). */
async function uiHealth(browser) {
  const errors = pageErrorsFrom(await browser.errors());
  const consoleText = (await browser.console()).trim();
  return { pageErrors: errors, console: consoleText };
}

/**
 * Poll the FULL a11y snapshot until predicate(text) passes (bounded grace for
 * view-transition/load races: a single networkidle wait can snapshot the
 * pre-navigation DOM because client-side navigation + query fetches land
 * slightly after the click). Returns the LAST snapshot either way — callers
 * keep asserting strictly on the returned text. When `evidence` is given the
 * final snapshot is recorded as a text artifact (diagnosing load stalls).
 */
async function waitForSnapshot(
  browser,
  predicate,
  { attempts = 12, intervalMs = 1000, evidence = null, name = 'wait-final-snapshot' } = {},
) {
  let last = '';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await browser.snapshot({});
    if (predicate(last)) return last;
    await browser.wait(intervalMs);
  }
  if (evidence !== null) {
    evidence.text(name, last);
  }
  return last;
}

export { openConsole, uiSignIn, uiSignOut, uiCreateAccount, uiHealth, waitForSnapshot };
