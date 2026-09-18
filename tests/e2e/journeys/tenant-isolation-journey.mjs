/**
 * JOURNEY: tenant-isolation (frontend-bypass security, API-level).
 *
 * Handoff §8 checklist items:
 *   - Cross-client/cross-tenant isolation (server-side, before traversal)
 *   - Frontend-bypass security tests (direct API calls with/without tokens)
 *   - Duplicate-email 409 + bad input 400 on the real sign-up route
 *
 * Live-only, never mocked: every request hits MOS_E2E_BASE_URL. The demo
 * tenant (Northwind) is addressed READ-ONLY through the demo owner persona;
 * every mutation happens inside the throwaway tenant (a REAL account created
 * through the real sign-up contract).
 */

import { createRunner, outcome } from '../lib/journey.mjs';
import { firstAgencyId } from '../lib/http.mjs';
import { uiSignIn, uiSignOut } from '../lib/ui.mjs';
import { browserSession } from '../lib/browser.mjs';
import { ensureThrowaway, loginThrowaway } from '../lib/throwaway.mjs';

export const name = 'tenant-isolation';
export const checklist = ['Cross-client isolation', 'Frontend-bypass security tests'];
export const requires = ['MOS_E2E_OWNER_* (demo tenant, read-only)', 'agent-browser (optional UI confirmation)'];

export async function run(ctx) {
  const { env, api, evidence, shared } = ctx;
  const steps = createRunner(name);
  let error = null;

  try {
    // --- 0. platform health -------------------------------------------------
    const health = await api.health();
    evidence.response('00-platform-health', health);
    await steps.check('platform health responds 200', 200, async () => health.status);
    await steps.checkFn(
      'platform health body reports status ok',
      'status === "ok"',
      async () => {
        const status = health.body?.status;
        return { actual: `status=${String(status)}`, pass: status === 'ok' };
      },
    );

    // --- 1. demo tenant coordinates (READ-ONLY through the owner persona) ---
    const owner = await api.login(env.owner.email, env.owner.password);
    const ownerContext = await api.get('auth/authorization-context', { token: owner.token });
    evidence.response('01-owner-authorization-context', ownerContext);
    const northwindAgencyId = firstAgencyId(ownerContext.body);
    await steps.checkFn(
      'owner persona resolves a demo agency membership',
      'one membership with agencyId',
      async () => ({
        actual: `memberships=${ownerContext.body?.memberships?.length ?? 0}`,
        pass: typeof northwindAgencyId === 'string',
      }),
    );
    const clients = await api.get(`agencies/${northwindAgencyId}/clients`, { token: owner.token });
    const northwindClientId = clients.body?.clients?.[0]?.clientId;
    await steps.checkFn(
      'demo tenant has seeded clients',
      '≥ 1 client',
      async () => ({
        actual: `clients=${clients.body?.clients?.length ?? 0}`,
        pass: typeof northwindClientId === 'string',
      }),
    );

    // --- 2. bootstrap the throwaway tenant (REAL account, at most one signup) -
    const throwaway = await ensureThrowaway(shared, api, evidence, steps);
    const session = await loginThrowaway(shared, api);
    const bearer = session.token;
    evidence.response('02-throwaway-authorization-context', session.context);
    await steps.checkFn(
      'throwaway identity resolves exactly one own-agency membership',
      '1 membership, own agency',
      async () => ({
        actual: `memberships=${session.context.body?.memberships?.length ?? 0}`,
        pass: session.context.body?.memberships?.length === 1,
      }),
    );
    await steps.checkFn(
      'throwaway has no platform roles (authority is server-derived only)',
      'platformRoles empty',
      async () => ({
        actual: `platformRoles=${JSON.stringify(session.context.body?.platformRoles ?? null)}`,
        pass: Array.isArray(session.context.body?.platformRoles) && session.context.body.platformRoles.length === 0,
      }),
    );

    // --- 3. cross-tenant denial matrix (frontend bypass) ----------------------
    const matrix = [
      {
        label: 'unauthenticated command-center',
        call: () => api.get(`reporting/command-center/${northwindAgencyId}`),
        expectStatus: 401,
        expectCode: 'UNAUTHORIZED',
      },
      {
        label: 'cross-tenant command-center (existence hidden)',
        call: () => api.get(`reporting/command-center/${northwindAgencyId}`, { token: bearer }),
        expectStatus: 404,
        expectCode: 'NOT_FOUND',
      },
      {
        label: 'cross-tenant attention-queue (existence hidden)',
        call: () => api.get(`ai-operator/${northwindAgencyId}/attention-queue`, { token: bearer }),
        expectStatus: 404,
        expectCode: 'NOT_FOUND',
      },
      {
        label: 'cross-tenant profit-intelligence (existence hidden)',
        call: () => api.get(`profit-intelligence/${northwindAgencyId}`, { token: bearer }),
        expectStatus: 404,
        expectCode: 'NOT_FOUND',
      },
      {
        label: 'cross-tenant clients list (membership required)',
        call: () => api.get(`agencies/${northwindAgencyId}/clients`, { token: bearer }),
        expectStatus: 403,
        expectCode: 'FORBIDDEN',
      },
      {
        label: 'cross-tenant client read (existence hidden)',
        call: () => api.get(`clients/${northwindClientId}`, { token: bearer }),
        expectStatus: 404,
        expectCode: 'NOT_FOUND',
      },
      {
        label: 'cross-tenant client evidence (existence hidden)',
        call: () => api.get(`clients/${northwindClientId}/evidence`, { token: bearer }),
        expectStatus: 404,
        expectCode: 'NOT_FOUND',
      },
      {
        label: 'throwaway human-work queue (no Human Agent profile)',
        call: () => api.get('jobs/queue', { token: bearer }),
        expectStatus: 403,
        expectCode: 'FORBIDDEN',
      },
      {
        label: 'unauthenticated job-offer claim',
        call: () => api.post('jobs/queue/offers/00000000-0000-0000-0000-000000000000/accept', { body: {} }),
        expectStatus: 401,
        expectCode: 'UNAUTHORIZED',
      },
      {
        label: 'foreign job-offer claim (fail-closed, no oracle)',
        call: () =>
          api.post('jobs/queue/offers/00000000-0000-0000-0000-000000000000/accept', { token: bearer, body: {} }),
        expectStatus: 404,
        expectCode: 'NOT_FOUND',
      },
    ];

    for (const entry of matrix) {
      const result = await entry.call();
      evidence.response(`03-${entry.label.replace(/[^a-z0-9]+/gi, '-')}`, result);
      await steps.checkFn(
        `${entry.label} → ${entry.expectStatus} ${entry.expectCode}`,
        `HTTP ${entry.expectStatus} code ${entry.expectCode}`,
        async () => {
          const code = result.body?.error?.code;
          const pass = result.status === entry.expectStatus && code === entry.expectCode;
          return { actual: `HTTP ${result.status} code ${String(code)}`, pass };
        },
      );
    }

    // --- 4. sign-up contract security ----------------------------------------
    const duplicate = await api.signup({
      displayName: throwaway.displayName,
      email: throwaway.email,
      agencyName: throwaway.agencyName,
      password: throwaway.password,
    });
    evidence.response('04-signup-duplicate-email', duplicate);
    await steps.checkFn(
      'sign-up duplicate email → 409 (never a credential reset)',
      'HTTP 409 EMAIL_ALREADY_REGISTERED',
      async () => {
        const code = duplicate.body?.error?.code;
        const pass = duplicate.status === 409 && code === 'EMAIL_ALREADY_REGISTERED';
        return { actual: `HTTP ${duplicate.status} code ${String(code)}`, pass };
      },
    );

    const invalid = await api.signup({ displayName: '', email: 'not-an-email', agencyName: '', password: 'short' });
    evidence.response('05-signup-invalid-body', invalid);
    await steps.checkFn(
      'sign-up invalid body → 400 with validation details',
      'HTTP 400 INVALID_REQUEST + details[]',
      async () => {
        const code = invalid.body?.error?.code;
        const details = Array.isArray(invalid.body?.error?.details) ? invalid.body.error.details.length : 0;
        const pass = invalid.status === 400 && code === 'INVALID_REQUEST' && details > 0;
        return { actual: `HTTP ${invalid.status} code ${String(code)} details=${details}`, pass };
      },
    );

    // --- 5. login-boundary security ------------------------------------------
    const badLogin = await api.post('auth/login', { body: { email: env.owner.email, password: 'Wrong-Password-123' } });
    evidence.response('06-login-bad-credentials', badLogin);
    await steps.checkFn(
      'bad credentials → uniform 401 (no account enumeration)',
      'HTTP 401 UNAUTHORIZED',
      async () => {
        const code = badLogin.body?.error?.code;
        const pass = badLogin.status === 401 && code === 'UNAUTHORIZED';
        return { actual: `HTTP ${badLogin.status} code ${String(code)}`, pass };
      },
    );

    const injection = await api.post('auth/login', {
      body: { email: env.owner.email, password: env.owner.password, roles: ['platform_administrator'] },
    });
    evidence.response('07-login-authority-injection', injection, 'roles is a forbidden authority field');
    await steps.checkFn(
      'authority-field injection in login body → 422 (server-derived only)',
      'HTTP 422 + "forbidden authority field"',
      async () => {
        const code = injection.body?.error?.code;
        const details = JSON.stringify(injection.body?.error?.details ?? []);
        const pass = injection.status === 422 && details.includes('forbidden authority field');
        return { actual: `HTTP ${injection.status} code ${String(code)}`, pass, note: details.slice(0, 220) };
      },
    );

    // --- 6. UI confirmation: the console itself never renders foreign data ----
    if (!env.skipUi) {
      const browser = browserSession(name, env.browserTimeoutMs);
      try {
        await uiSignIn(browser, env.baseUrl, { email: throwaway.email, password: throwaway.password });
        // The desktop shell renders the primary nav; on mobile the drawer
        // holds it — either way the console must not show demo tenant data.
        const snapshot = await browser.snapshot({});
        const foreign = ['Helio Robotics', 'Atlas Freight Systems', 'Northwind Growth Partners'].filter((needle) =>
          snapshot.includes(needle),
        );
        const snapshotPath = evidence.text('08-ui-throwaway-no-foreign-data', snapshot);
        const shotPath = evidence.screenshotPath('08-ui-throwaway-empty-console');
        await browser.screenshot(shotPath);
        await steps.checkFn(
          'throwaway console session shows no Northwind data',
          'no demo tenant names in the rendered tree',
          async () => ({
            actual: foreign.length === 0 ? 'no foreign names' : `foreign names: ${foreign.join(', ')}`,
            pass: foreign.length === 0,
            note: null,
            evidence: [snapshotPath, shotPath],
          }),
        );
        steps.evidenceFor('throwaway console session shows no Northwind data', [snapshotPath, shotPath]);
        await uiSignOut(browser);
      } finally {
        browser.close();
      }
    } else {
      await steps.info('UI confirmation skipped (MOS_E2E_SKIP_UI=1)');
    }

    // --- 7. revoke this journey's throwaway session (leave no live sessions) --
    const logout = await api.post('auth/logout', { token: bearer, body: {} });
    evidence.response('09-throwaway-logout', logout);
    await steps.check('throwaway session revoked on logout', 200, async () => logout.status);
  } catch (caught) {
    error = caught;
  }

  return outcome(name, steps.steps, error);
}
